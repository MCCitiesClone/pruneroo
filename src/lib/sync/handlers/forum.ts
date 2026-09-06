import { inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { dedupeBy } from "@/lib/db/dedupe";
import { evictionReportRegions, evictionReports } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import {
  createForumClient,
  ForumAuthError,
  forumCredentialsConfigured,
} from "@/lib/sources/forum/client";
import { listingPageUrl } from "@/lib/sources/forum/listing";
import {
  extractEvictionDate,
  extractRegionIds,
  isReportActive,
} from "@/lib/sources/forum/parse";

import { enqueue, getWatermark, setWatermark, startRun } from "../queue";

const SOURCE = "forum";

/**
 * Which listing a thread came from, and what that implies.
 *
 * Reports move to the archive once dealt with, so an archived thread is
 * finished by definition — history for its region, never a reason to suppress
 * the plot from review. Both listings key on the same XenForo thread id, so a
 * thread that moves is simply reclassified.
 */
export type ForumFeed = "reports" | "archive";

function feedUrl(feed: ForumFeed): string {
  const env = getEnv();
  return feed === "archive"
    ? env.FORUM_ARCHIVE_LISTING_URL
    : env.FORUM_EVICTION_LISTING_URL;
}

/**
 * Backstop against a malformed pager link, not a coverage limit — the archive
 * is 83 pages today.
 */
const MAX_PAGES = 400;

interface RegionLookup {
  knownIds: Set<string>;
  /**
   * Lower-cased id -> every region spelled that way. Usually one, but 33 pairs
   * differ **only** by case (`A1` vs `a1`, `Ap4` vs `ap4`) and are genuinely
   * distinct plots in the same world.
   */
  canonical: Map<string, Array<{ worldUuid: string; regionId: string }>>;
}

async function loadRegionLookup(): Promise<RegionLookup> {
  // Matching is case-insensitive — a report titled `C999` means plot `c999` —
  // but the stored id must keep the database's own casing, since 1,338 of
  // 7,874 ids are mixed-case and the lowercased token would join to nothing.
  //
  // Scoped to one world: forum plot names always refer to it, and without the
  // scope a title can match a same-named plot elsewhere.
  const world = getEnv().FORUM_REGION_WORLD;
  const known = await db.execute<{ wg_region_id: string; world_uuid: string }>(
    sql`SELECT r.wg_region_id, r.world_uuid
          FROM regions r
          JOIN worlds w ON w.uuid = r.world_uuid
         WHERE w.name = ${world}`,
  );
  const canonical = new Map<
    string,
    Array<{ worldUuid: string; regionId: string }>
  >();
  for (const row of known.rows) {
    const regionId = String(row.wg_region_id);
    const key = regionId.toLowerCase();
    const bucket = canonical.get(key) ?? [];
    bucket.push({ worldUuid: String(row.world_uuid), regionId });
    canonical.set(key, bucket);
  }
  return { knownIds: new Set(canonical.keys()), canonical };
}

/**
 * Coordinator. Makes **no** requests of its own — it only decides what to
 * enqueue, so a scheduled tick costs nothing when everything is current.
 *
 * The first run walks every page of both listings; afterwards only page 1 is
 * checked, and deeper pages are visited solely when page 1 turns out to have
 * changed.
 */
export async function handleForumEvictionReports(): Promise<void> {
  const run = await startRun(SOURCE, "forum.evictionReports");

  if (!forumCredentialsConfigured()) {
    await run.finish({
      status: "skipped",
      note:
        "FORUM_COOKIE not set. Both eviction forums return 403 to guests, so " +
        "reports cannot be read without a logged-in session cookie.",
    });
    return;
  }

  const notes: string[] = [];
  for (const feed of ["reports", "archive"] as ForumFeed[]) {
    const done = (await getWatermark(SOURCE, `backfill.${feed}`))?.cursorText;
    const mode = done === "complete" ? "incremental" : "backfill";
    await enqueue({
      source: SOURCE,
      kind: "forum.listing.page",
      dedupeKey: `${feed}:1`,
      payload: { feed, page: 1, mode },
      // Backfill yields to incremental work so a long archive walk never
      // delays noticing a newly filed report.
      priority: mode === "backfill" ? 60 : 18,
    });
    notes.push(`${feed}: ${mode} from page 1`);
  }

  await run.finish({ status: "ok", requestsMade: 0, note: notes.join("; ") });
}

/**
 * Fetch and ingest a single listing page, then decide whether the next one is
 * worth visiting.
 *
 * One page per job is what keeps this polite: the shared token bucket paces
 * every request, an interrupted backfill resumes from the queue instead of
 * starting over, and a failure retries one page rather than re-crawling 83.
 */
export async function handleForumListingPage(payload: {
  feed: ForumFeed;
  page: number;
  mode: "backfill" | "incremental";
}): Promise<void> {
  const { feed, page, mode } = payload;
  const run = await startRun(SOURCE, `forum.listing.${feed}`);
  const env = getEnv();
  const client = createForumClient();

  try {
    const url = listingPageUrl(feedUrl(feed), page);
    const listing = await client.fetchListingPage(url);

    // Each page doubles as its own change probe: an identical set of threads
    // means nothing was posted, moved or retitled here, and because threads
    // only ever shift downwards, nothing older can have moved either.
    const digestKey = `digest.${feed}.${page}`;
    const unchanged =
      listing.digest === (await getWatermark(SOURCE, digestKey))?.cursorText;

    if (unchanged && mode === "incremental") {
      await run.finish({
        status: "ok",
        requestsMade: 1,
        note: `${feed} page ${page}/${listing.lastPage} unchanged; stopping here`,
      });
      return;
    }

    // Which of these threads we have already stored. Incremental mode stops as
    // soon as a known one appears, so a steady state costs one page per
    // listing — there is no reason to keep walking an archive already ingested.
    const seenBefore = await db
      .select({ threadId: evictionReports.threadId })
      .from(evictionReports)
      .where(
        inArray(
          evictionReports.threadId,
          listing.threads.map((t) => t.threadId),
        ),
      );
    const known = new Set(seenBefore.map((r) => r.threadId));

    const lookup = await loadRegionLookup();
    const archived = feed === "archive";

    const reports = dedupeBy(listing.threads, (t) => t.threadId).map((thread) => ({
      thread,
      // An archived thread is finished whatever its prefix says; only the open
      // listing consults the prefix.
      isActive: archived
        ? false
        : isReportActive(thread.prefix, env.EVICTION_RESOLVED_PREFIXES),
      evictionDate: extractEvictionDate(thread.title),
      regions: extractRegionIds(thread.title, lookup.knownIds),
    }));

    await db
      .insert(evictionReports)
      .values(
        reports.map((r) => ({
          threadId: r.thread.threadId,
          feed,
          title: r.thread.title,
          prefix: r.thread.prefix,
          isActive: r.isActive,
          source: "forum",
          url: r.thread.url,
          author: r.thread.author,
          postedAt: r.thread.postedAt,
          evictionDate: r.evictionDate,
          lastSeenAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: evictionReports.threadId,
        set: {
          // Reclassifies a thread that has moved between the two listings.
          feed: sql`EXCLUDED.feed`,
          title: sql`EXCLUDED.title`,
          prefix: sql`EXCLUDED.prefix`,
          isActive: sql`EXCLUDED.is_active`,
          // A report pasted in by hand stops being provisional the moment the
          // crawl sees it, and its title/prefix are overwritten with the real
          // ones above.
          source: sql`EXCLUDED.source`,
          url: sql`EXCLUDED.url`,
          author: sql`COALESCE(EXCLUDED.author, ${evictionReports.author})`,
          postedAt: sql`COALESCE(EXCLUDED.posted_at, ${evictionReports.postedAt})`,
          evictionDate: sql`EXCLUDED.eviction_date`,
          lastSeenAt: new Date(),
        },
      });

    // Re-derive region links for every thread seen: a retitled thread can gain
    // or lose plots, so stale links must not survive.
    let linked = 0;
    let unmatched = 0;
    let ambiguous = 0;
    for (const report of reports) {
      // Manual assignments are operator decisions and must outlive a re-crawl.
      await db.execute(sql`
        DELETE FROM eviction_report_regions
         WHERE thread_id = ${report.thread.threadId} AND source = 'parsed'
      `);

      const links = report.regions.flatMap((match) => {
        const candidates = lookup.canonical.get(match.wgRegionId) ?? [];
        // Exactly one spelling: unambiguous, link it. More than one means the
        // title cannot tell `A1` from `a1`, and guessing would attach the
        // report to the wrong plot — leave it for manual assignment instead.
        if (candidates.length !== 1) {
          if (candidates.length > 1) ambiguous += 1;
          return [];
        }
        return [
          {
            threadId: report.thread.threadId,
            worldUuid: candidates[0].worldUuid,
            // Canonical casing, not the lowercased match token.
            wgRegionId: candidates[0].regionId,
            source: "parsed",
          },
        ];
      });

      if (links.length === 0) {
        unmatched += 1;
        continue;
      }
      await db.insert(evictionReportRegions).values(links).onConflictDoNothing();
      linked += links.length;
    }

    await setWatermark(SOURCE, digestKey, { cursorText: listing.digest });

    const lastPage = Math.min(listing.lastPage, MAX_PAGES);
    const newThreads = reports.filter((r) => !known.has(r.thread.threadId)).length;

    /**
     * Backfill walks to the end once. After that, page 1 is the only page
     * worth fetching: threads are newest-first, so the first already-known
     * thread means everything below it is known too. Only a page that is
     * *entirely* new implies more than a page of arrivals since the last check
     * and justifies looking deeper.
     */
    const hasNextPage =
      page < lastPage &&
      (mode === "backfill" || newThreads === reports.length);

    if (hasNextPage) {
      await enqueue({
        source: SOURCE,
        kind: "forum.listing.page",
        dedupeKey: `${feed}:${page + 1}`,
        payload: { feed, page: page + 1, mode },
        priority: mode === "backfill" ? 60 : 18,
      });
    } else if (mode === "backfill") {
      // Only now is the listing fully ingested.
      await setWatermark(SOURCE, `backfill.${feed}`, { cursorText: "complete" });
    }

    await run.finish({
      status: "ok",
      requestsMade: 1,
      itemsUpserted: reports.length,
      note:
        `${feed} page ${page}/${listing.lastPage} (${mode}): ` +
        `${reports.length} threads (${newThreads} new), ${linked} region links` +
        (unmatched > 0 ? `, ${unmatched} named no known region` : "") +
        (ambiguous > 0 ? `, ${ambiguous} ambiguous by case` : "") +
        (hasNextPage
          ? `; queued page ${page + 1}`
          : mode === "incremental"
            ? "; reached known threads, stopping"
            : "; listing complete"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await run.finish({ status: "error", requestsMade: 1, error: message });
    // An expired cookie is a configuration problem, not a transient fault;
    // failing the job beats retrying into a guaranteed 403.
    if (error instanceof ForumAuthError) return;
    throw error;
  }
}
