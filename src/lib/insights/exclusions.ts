import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { toDate, toInt, toText } from "@/lib/db/coerce";
import { plotCountsTowardLimitSql, plotLimitCte } from "@/lib/plots/limits-sql";

/**
 * Operator curation: players whose properties are kept out of the at-risk list.
 *
 * This is the one table a sync never writes. Exclusions survive every re-crawl,
 * so a decision made once stays made.
 */

export interface ExcludedPlayer {
  playerUuid: string;
  playerName: string | null;
  reason: string | null;
  excludedAt: Date | null;
  /** How many flagged properties this exclusion is currently hiding. */
  hiddenProperties: number;
}

export async function listExclusions(
  thresholdMs: number,
): Promise<ExcludedPlayer[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH ${plotLimitCte()}
    SELECT e.player_uuid, p.name AS player_name, e.reason, e.excluded_at,
           COALESCE(h.hidden, 0)::int AS hidden
      FROM player_exclusions e
      LEFT JOIN players p ON p.uuid = e.player_uuid
      LEFT JOIN (
        SELECT v.player_uuid, count(*)::int AS hidden
          FROM v_property_stakeholder_flags v
          LEFT JOIN plot_limit_breaches b
                 ON b.player_uuid = v.player_uuid
                AND b.category = COALESCE(v.category, 'other')
         WHERE v.role IN ('titleholder','landlord')
           AND (v.is_banned OR v.is_long_deported
                OR (v.playtime_30d_ms IS NOT NULL
                    AND v.playtime_30d_ms < ${thresholdMs}
                    AND NOT v.is_limited_deported)
                OR (COALESCE(b.over_limit, false)
                    AND ${plotCountsTowardLimitSql(sql`v.category`, sql`v.area`)}))
         GROUP BY v.player_uuid
      ) h ON h.player_uuid = e.player_uuid
     ORDER BY e.excluded_at DESC
  `);

  return result.rows.map((row) => ({
    playerUuid: String(row.player_uuid),
    playerName: toText(row.player_name),
    reason: toText(row.reason),
    excludedAt: toDate(row.excluded_at),
    hiddenProperties: toInt(row.hidden),
  }));
}

export async function isExcluded(playerUuid: string): Promise<boolean> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT 1 FROM player_exclusions WHERE player_uuid = ${playerUuid}::uuid LIMIT 1
  `);
  return result.rows.length > 0;
}
