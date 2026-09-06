import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { toBool, toDate, toInt, toText } from "@/lib/db/coerce";

/**
 * Eviction reports and the regions they name.
 *
 * A report whose title names no recognisable plot is the interesting case: it
 * suppresses nothing and links nowhere, so without somewhere to see it the work
 * simply disappears. `/reports` surfaces those, and they can be assigned by
 * hand.
 */

export interface ReportRow {
  threadId: string;
  feed: string;
  title: string;
  prefix: string | null;
  isActive: boolean;
  url: string;
  author: string | null;
  postedAt: Date | null;
  evictionDate: Date | null;
  regions: Array<{ worldUuid: string; wgRegionId: string; source: string }>;
}

export type ReportFilter = "all" | "unmatched" | "open" | "archived";

/**
 * A report older than a year that still names no known plot is not actionable:
 * the plot has almost always been renamed or removed since. Those are kept in
 * the database but left out of the "needs a plot" queue, which otherwise fills
 * with 2024 threads for regions that no longer exist.
 */
const STALE_UNMATCHED = sql`r.posted_at > now() - interval '365 days'`;

export async function listReports(
  filter: ReportFilter = "unmatched",
  limit = 200,
): Promise<ReportRow[]> {
  const where =
    filter === "unmatched"
      ? sql`NOT EXISTS (SELECT 1 FROM eviction_report_regions rr WHERE rr.thread_id = r.thread_id)
            AND ${STALE_UNMATCHED}`
      : filter === "open"
        ? sql`r.is_active`
        : filter === "archived"
          ? sql`r.feed = 'archive'`
          : sql`true`;

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT r.thread_id, r.feed, r.title, r.prefix, r.is_active, r.url,
           r.author, r.posted_at, r.eviction_date,
           COALESCE(
             json_agg(
               json_build_object(
                 'worldUuid', rr.world_uuid,
                 'wgRegionId', rr.wg_region_id,
                 'source', rr.source
               ) ORDER BY rr.wg_region_id
             ) FILTER (WHERE rr.thread_id IS NOT NULL),
             '[]'
           ) AS regions
      FROM eviction_reports r
      LEFT JOIN eviction_report_regions rr ON rr.thread_id = r.thread_id
     WHERE ${where}
     GROUP BY r.thread_id
     ORDER BY r.is_active DESC, r.posted_at DESC NULLS LAST
     LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    threadId: String(row.thread_id),
    feed: String(row.feed),
    title: String(row.title),
    prefix: toText(row.prefix),
    isActive: toBool(row.is_active),
    url: String(row.url),
    author: toText(row.author),
    postedAt: toDate(row.posted_at),
    evictionDate: toDate(row.eviction_date),
    regions: Array.isArray(row.regions)
      ? (row.regions as ReportRow["regions"])
      : [],
  }));
}

export interface ReportCounts {
  total: number;
  open: number;
  archived: number;
  unmatched: number;
  /** Unmatched but over a year old — ignored rather than queued for triage. */
  staleUnmatched: number;
  manualLinks: number;
}

export async function getReportCounts(): Promise<ReportCounts> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT (SELECT count(*) FROM eviction_reports)                        AS total,
           (SELECT count(*) FROM eviction_reports WHERE is_active)        AS open,
           (SELECT count(*) FROM eviction_reports WHERE feed = 'archive') AS archived,
           (SELECT count(*) FROM eviction_reports r
             WHERE NOT EXISTS (SELECT 1 FROM eviction_report_regions rr
                                WHERE rr.thread_id = r.thread_id)
               AND ${STALE_UNMATCHED})                                    AS unmatched,
           (SELECT count(*) FROM eviction_reports r
             WHERE NOT EXISTS (SELECT 1 FROM eviction_report_regions rr
                                WHERE rr.thread_id = r.thread_id)
               AND NOT (${STALE_UNMATCHED}))                              AS stale_unmatched,
           (SELECT count(*) FROM eviction_report_regions
             WHERE source = 'manual')                                     AS manual_links
  `);
  const row = result.rows[0] ?? {};
  return {
    total: toInt(row.total),
    open: toInt(row.open),
    archived: toInt(row.archived),
    unmatched: toInt(row.unmatched),
    staleUnmatched: toInt(row.stale_unmatched),
    manualLinks: toInt(row.manual_links),
  };
}

/**
 * Resolve a region id typed by a person.
 *
 * Case-insensitive, because a report may write `C999` for plot `c999`. Returns
 * every match so the caller can refuse to guess: 33 pairs of Reveille plots
 * differ only by case (`A1` vs `a1`), and picking one silently would attach the
 * report to the wrong property.
 */
export async function resolveRegionInput(
  input: string,
  worldName: string,
): Promise<Array<{ worldUuid: string; wgRegionId: string }>> {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT r.world_uuid, r.wg_region_id
      FROM regions r
      JOIN worlds w ON w.uuid = r.world_uuid
     WHERE w.name = ${worldName}
       AND lower(r.wg_region_id) = lower(${trimmed})
     ORDER BY r.wg_region_id
  `);

  return result.rows.map((row) => ({
    worldUuid: String(row.world_uuid),
    wgRegionId: String(row.wg_region_id),
  }));
}
