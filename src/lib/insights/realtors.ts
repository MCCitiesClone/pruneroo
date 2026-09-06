import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { toDate, toText } from "@/lib/db/coerce";

/**
 * Confirmed realtors — the second table a sync never writes.
 *
 * PSA §17(9) grants realtors +5 on most plot limits, and the job is not exposed
 * by any API here. An inspector confirms it in game with `/about <player>` and
 * records it; until then a holder over the limit is reported as needing that
 * check rather than as a violation.
 */

export interface RealtorMark {
  note: string | null;
  markedAt: Date | null;
}

export async function getRealtorMark(
  playerUuid: string,
): Promise<RealtorMark | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT note, marked_at FROM player_realtors
     WHERE player_uuid = ${playerUuid}::uuid LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return { note: toText(row.note), markedAt: toDate(row.marked_at) };
}
