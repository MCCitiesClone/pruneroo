"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { evictionReportRegions } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { resolveRegionInput } from "@/lib/insights/reports";

/**
 * Manual region assignment.
 *
 * Automatic matching reads plot ids out of the thread title, which fails when a
 * report is titled unusually, and is deliberately refused when a name is
 * ambiguous — 33 pairs of plots differ only by case. Rather than guess, those
 * land on `/reports` to be assigned by hand.
 *
 * Manual links are stored with `source = 'manual'` and a sync never deletes
 * them, so an assignment survives every re-crawl.
 */

export interface AssignResult {
  ok: boolean;
  message: string;
}

export async function assignReportRegion(
  formData: FormData,
): Promise<AssignResult> {
  const threadId = String(formData.get("threadId") ?? "").trim();
  const input = String(formData.get("regionId") ?? "").trim();

  if (!threadId) return { ok: false, message: "Missing report." };
  if (!input) return { ok: false, message: "Enter a plot id." };

  const world = getEnv().FORUM_REGION_WORLD;
  const matches = await resolveRegionInput(input, world);

  if (matches.length === 0) {
    return { ok: false, message: `No plot named "${input}" in ${world}.` };
  }
  if (matches.length > 1) {
    // Only reachable for the case-colliding pairs; spell out both so the
    // operator can pick the exact one.
    return {
      ok: false,
      message: `"${input}" is ambiguous in ${world} — ${matches
        .map((m) => m.wgRegionId)
        .join(" or ")}. Type the exact casing.`,
    };
  }

  const [region] = matches;
  await db
    .insert(evictionReportRegions)
    .values({
      threadId,
      worldUuid: region.worldUuid,
      wgRegionId: region.wgRegionId,
      source: "manual",
    })
    .onConflictDoUpdate({
      target: [
        evictionReportRegions.threadId,
        evictionReportRegions.worldUuid,
        evictionReportRegions.wgRegionId,
      ],
      // Promoting a parsed link to manual pins it against future re-crawls.
      set: { source: "manual", assignedAt: new Date() },
    });

  revalidateAll();
  return { ok: true, message: `Linked to ${region.wgRegionId}.` };
}

export async function unassignReportRegion(
  threadId: string,
  worldUuid: string,
  wgRegionId: string,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM eviction_report_regions
     WHERE thread_id = ${threadId}
       AND world_uuid = ${worldUuid}::uuid
       AND wg_region_id = ${wgRegionId}
  `);
  revalidateAll();
}

function revalidateAll() {
  revalidatePath("/reports");
  revalidatePath("/at-risk");
  revalidatePath("/");
}
