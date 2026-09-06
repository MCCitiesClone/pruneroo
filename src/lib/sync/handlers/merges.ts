import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { plotMergeGroups, plotMergeMembers } from "@/lib/db/schema";
import { evaluateMerge, type MergeCandidate } from "@/lib/plots/merge";

import { startRun } from "../queue";

const SOURCE = "plots";

/**
 * Rebuild merged-plot groups from eviction reports.
 *
 * Makes **no upstream requests**: everything needed is already stored — which
 * reports name which plots, who owns each plot, and each plot's boundary. The
 * whole computation is a pure function of local data, so it is recomputed
 * rather than re-fetched.
 *
 * "Owner" here follows the inspector guide, which says to take the plot owner
 * from `/as info region` and explicitly *not* the landlord: that is the
 * titleholder on a freehold and the tenant on a leasehold.
 */
export async function handleRebuildMerges(): Promise<void> {
  const run = await startRun(SOURCE, "plots.merges.rebuild");

  try {
    const rows = await db.execute<{
      thread_id: string;
      world_uuid: string;
      wg_region_id: string;
      owner_uuid: string | null;
      x0: number | null;
      x1: number | null;
      z0: number | null;
      z1: number | null;
    }>(sql`
      WITH bounds AS (
        SELECT r.world_uuid, r.wg_region_id,
               min((p->>'x')::int) AS x0, max((p->>'x')::int) AS x1,
               min((p->>'z')::int) AS z0, max((p->>'z')::int) AS z1
          FROM regions r,
               LATERAL jsonb_array_elements(r.dimensions->'points') p
         WHERE r.dimensions IS NOT NULL
         GROUP BY r.world_uuid, r.wg_region_id
      ),
      multi AS (
        SELECT thread_id
          FROM eviction_report_regions
         GROUP BY thread_id
        HAVING count(*) > 1
      )
      SELECT rr.thread_id, rr.world_uuid, rr.wg_region_id,
             COALESCE(fh.titleholder_uuid, lh.tenant_uuid) AS owner_uuid,
             b.x0, b.x1, b.z0, b.z1
        FROM multi m
        JOIN eviction_report_regions rr ON rr.thread_id = m.thread_id
        LEFT JOIN region_freehold  fh ON fh.world_uuid = rr.world_uuid
                                     AND fh.wg_region_id = rr.wg_region_id
        LEFT JOIN region_leasehold lh ON lh.world_uuid = rr.world_uuid
                                     AND lh.wg_region_id = rr.wg_region_id
        LEFT JOIN bounds b ON b.world_uuid = rr.world_uuid
                          AND b.wg_region_id = rr.wg_region_id
       ORDER BY rr.thread_id, rr.wg_region_id
    `);

    const byThread = new Map<string, MergeCandidate[]>();
    for (const row of rows.rows) {
      const threadId = String(row.thread_id);
      const list = byThread.get(threadId) ?? [];
      list.push({
        worldUuid: String(row.world_uuid),
        wgRegionId: String(row.wg_region_id),
        ownerUuid: row.owner_uuid ? String(row.owner_uuid) : null,
        bounds:
          row.x0 === null
            ? null
            : {
                x0: Number(row.x0),
                x1: Number(row.x1),
                z0: Number(row.z0),
                z1: Number(row.z1),
              },
      });
      byThread.set(threadId, list);
    }

    // Rebuilt wholesale: ownership and boundaries change, so a group valid last
    // week may not be valid now, and stale merges would mislead an inspector.
    await db.execute(sql`DELETE FROM plot_merge_groups`);

    let merged = 0;
    const rejected = new Map<string, number>();

    for (const [threadId, members] of byThread) {
      const result = evaluateMerge(members);
      if (result.status === "rejected") {
        rejected.set(result.reason!, (rejected.get(result.reason!) ?? 0) + 1);
      } else {
        merged += 1;
      }

      const [group] = await db
        .insert(plotMergeGroups)
        .values({
          threadId,
          status: result.status,
          reason: result.reason,
          ownerUuid: result.ownerUuid,
          memberCount: members.length,
        })
        .returning({ id: plotMergeGroups.id });

      await db.insert(plotMergeMembers).values(
        members.map((m) => ({
          groupId: group.id,
          worldUuid: m.worldUuid,
          wgRegionId: m.wgRegionId,
        })),
      );
    }

    const rejectionNote = [...rejected]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason}: ${n}`)
      .join(", ");

    await run.finish({
      status: "ok",
      requestsMade: 0,
      itemsUpserted: byThread.size,
      note:
        `${merged} merged groups from ${byThread.size} multi-plot reports` +
        (rejectionNote ? ` — rejected ${rejectionNote}` : ""),
    });
  } catch (error) {
    await run.finish({
      status: "error",
      requestsMade: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
