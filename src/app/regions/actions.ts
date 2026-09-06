"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { evictionReportRegions, evictionReports } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { getRegion } from "@/lib/insights/player";
import {
  createForumClient,
  ForumAuthError,
  ForumNotFoundError,
  forumCredentialsConfigured,
} from "@/lib/sources/forum/client";
import {
  extractEvictionDate,
  isReportActive,
} from "@/lib/sources/forum/parse";
import { parseThreadUrl } from "@/lib/sources/forum/thread";

/**
 * Linking a filed eviction report back to its plot.
 *
 * The crawl finds reports by walking the forum listings, which is the right way
 * round for the 6,000 reports already filed and the wrong way round for the one
 * an inspector filed thirty seconds ago: the listing sync is gated behind a
 * change probe and runs on its own schedule, so a freshly filed report is
 * invisible here for as long as that takes. Pasting the link closes that gap.
 *
 * Doing so has real consequences — an active report **suppresses its plot from
 * the at-risk list** — so this verifies the thread before believing in it, and
 * records how it learned about it either way (`eviction_reports.source`).
 */

export interface LinkResult {
  ok: boolean;
  message: string;
}

/**
 * The forum's own origin, taken from the listing URL rather than hardcoded, so
 * a pasted link is checked against the forum this deployment actually reads.
 */
function forumOrigin(): string {
  return new URL(getEnv().FORUM_EVICTION_LISTING_URL).origin;
}

export async function linkEvictionReport(
  formData: FormData,
): Promise<LinkResult> {
  const worldUuid = String(formData.get("worldUuid") ?? "").trim();
  const wgRegionId = String(formData.get("wgRegionId") ?? "").trim();
  const input = String(formData.get("url") ?? "").trim();

  if (!worldUuid || !wgRegionId) return { ok: false, message: "Missing plot." };
  if (!input) return { ok: false, message: "Paste the report link." };

  const origin = forumOrigin();
  const ref = parseThreadUrl(input, origin);
  if (!ref) {
    return {
      ok: false,
      message: `Not a thread link on ${new URL(origin).host}. Paste the report's URL.`,
    };
  }

  // The merge group is re-read here rather than taken from the form: a merged
  // plot is filed as one report (PSA §18(2)), so every sub-plot has to be
  // linked, and which plots those are is not the client's to assert.
  const region = await getRegion(worldUuid, wgRegionId);
  if (!region) return { ok: false, message: `No plot ${wgRegionId} here.` };
  const plots = [
    { worldUuid: region.worldUuid, wgRegionId: region.wgRegionId },
    ...region.mergedWith.map((m) => ({
      worldUuid: m.worldUuid,
      wgRegionId: m.wgRegionId,
    })),
  ];

  const env = getEnv();
  let title: string | null = null;
  let prefix: string | null = null;
  let isActive = true;
  let url = ref.url;
  let verified = false;
  let warning = "";

  if (forumCredentialsConfigured()) {
    try {
      const thread = await createForumClient().fetchThread(ref.url);
      if (!thread) {
        return {
          ok: false,
          message:
            "That URL did not return a forum thread. Check the link and try again.",
        };
      }
      if (thread.threadId !== ref.threadId) {
        // A redirect landed somewhere else; storing it under the pasted id
        // would attach this plot to the wrong report.
        return {
          ok: false,
          message: `That link resolves to thread ${thread.threadId}, not ${ref.threadId}.`,
        };
      }
      title = thread.title;
      prefix = thread.prefix;
      isActive = isReportActive(thread.prefix, env.EVICTION_RESOLVED_PREFIXES);
      url = thread.url;
      verified = true;
    } catch (error) {
      if (error instanceof ForumNotFoundError) {
        return {
          ok: false,
          message: `No thread ${ref.threadId} on the forum — check the link.`,
        };
      }
      // An unusable cookie is a configuration problem, not a reason to refuse
      // the link: the operator is looking at the thread and we are not. Record
      // it provisionally and say so.
      if (!(error instanceof ForumAuthError)) throw error;
      warning = " Could not read the thread (forum login expired), so its title will fill in on the next sync.";
    }
  } else {
    warning =
      " FORUM_COOKIE is not set, so the title will stay provisional until it is.";
  }

  await db
    .insert(evictionReports)
    .values({
      threadId: ref.threadId,
      feed: "reports",
      // The URL slug is XenForo's own slugification of the title, so it is the
      // best stand-in available when the thread could not be read.
      title: title ?? slugTitle(ref.url) ?? `Thread ${ref.threadId}`,
      prefix,
      isActive,
      source: verified ? "forum" : "manual",
      url,
      evictionDate: title ? extractEvictionDate(title) : null,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: evictionReports.threadId,
      set: verified
        ? {
            title: sql`EXCLUDED.title`,
            prefix: sql`EXCLUDED.prefix`,
            isActive: sql`EXCLUDED.is_active`,
            source: sql`EXCLUDED.source`,
            url: sql`EXCLUDED.url`,
            evictionDate: sql`EXCLUDED.eviction_date`,
            lastSeenAt: new Date(),
          }
        : // Unverified: never overwrite what a crawl already established.
          { lastSeenAt: new Date() },
    });

  await db
    .insert(evictionReportRegions)
    .values(
      plots.map((plot) => ({
        threadId: ref.threadId,
        worldUuid: plot.worldUuid,
        wgRegionId: plot.wgRegionId,
        source: "manual",
      })),
    )
    .onConflictDoUpdate({
      target: [
        evictionReportRegions.threadId,
        evictionReportRegions.worldUuid,
        evictionReportRegions.wgRegionId,
      ],
      // Pins the link against future re-crawls, which delete parsed links.
      set: { source: "manual", assignedAt: new Date() },
    });

  revalidateFor(worldUuid, wgRegionId);

  const covered =
    plots.length > 1 ? ` and ${plots.length - 1} merged plot(s)` : "";
  return {
    ok: true,
    message: `Linked report ${ref.threadId} to ${wgRegionId}${covered}.${warning}`,
  };
}

/** Undo a link, for a URL pasted onto the wrong plot. */
export async function unlinkEvictionReport(
  threadId: string,
  worldUuid: string,
  wgRegionId: string,
): Promise<void> {
  // Only the manual link is removed. A parsed one is the crawl's own reading of
  // the thread title and would simply come back on the next sync, so deleting
  // it here would be a lie about what happened.
  await db.execute(sql`
    DELETE FROM eviction_report_regions
     WHERE thread_id = ${threadId}
       AND world_uuid = ${worldUuid}::uuid
       AND wg_region_id = ${wgRegionId}
       AND source = 'manual'
  `);
  revalidateFor(worldUuid, wgRegionId);
}

/** `/threads/c176-sep-10-2026.26813/` -> `c176 sep 10 2026`. */
function slugTitle(url: string): string | null {
  const slug = /\/threads\/(.+)\.\d+\//.exec(url)?.[1];
  return slug ? slug.replace(/-/g, " ") : null;
}

function revalidateFor(worldUuid: string, wgRegionId: string) {
  revalidatePath(`/regions/${worldUuid}/${encodeURIComponent(wgRegionId)}`);
  revalidatePath("/reports");
  revalidatePath("/at-risk");
  revalidatePath("/");
}
