import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { toBool, toDate, toInt, toText } from "@/lib/db/coerce";

/** Data for the sync-health page: is every source behaving, and is it fresh? */

export interface SourceHealthRow {
  source: string;
  consecutiveFailures: number;
  circuitOpenUntil: Date | null;
  /** Computed in SQL: reading the clock during render is impure. */
  circuitOpen: boolean;
  lastError: string | null;
  requestsLastHour: number;
  errorsLastHour: number;
  /** Peak observed requests in any single minute of the last hour. */
  peakRequestsPerMinute: number;
  lastRequestAt: Date | null;
}

export async function getSourceHealth(): Promise<SourceHealthRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH sources AS (
      SELECT DISTINCT source FROM api_requests
      UNION SELECT source FROM source_health
      UNION SELECT unnest(ARRAY['realty','punishments','analytics','treasury','forum'])
    ),
    recent AS (
      SELECT source,
             count(*)::int                                     AS requests_last_hour,
             count(*) FILTER (WHERE error IS NOT NULL)::int     AS errors_last_hour,
             max(at)                                           AS last_request_at
        FROM api_requests
       WHERE at > now() - interval '1 hour'
       GROUP BY source
    ),
    per_minute AS (
      SELECT source, date_trunc('minute', at) AS minute, count(*)::int AS n
        FROM api_requests
       WHERE at > now() - interval '1 hour'
       GROUP BY source, minute
    ),
    peaks AS (
      SELECT source, max(n)::int AS peak_rpm FROM per_minute GROUP BY source
    )
    SELECT s.source,
           h.consecutive_failures,
           h.circuit_open_until,
           COALESCE(h.circuit_open_until > now(), false) AS circuit_open,
           h.last_error,
           COALESCE(r.requests_last_hour, 0) AS requests_last_hour,
           COALESCE(r.errors_last_hour, 0)   AS errors_last_hour,
           COALESCE(p.peak_rpm, 0)           AS peak_rpm,
           r.last_request_at
      FROM sources s
      LEFT JOIN source_health h ON h.source = s.source
      LEFT JOIN recent r        ON r.source = s.source
      LEFT JOIN peaks p         ON p.source = s.source
     ORDER BY s.source
  `);

  return result.rows.map((row) => ({
    source: String(row.source),
    consecutiveFailures: toInt(row.consecutive_failures),
    circuitOpenUntil: toDate(row.circuit_open_until),
    circuitOpen: toBool(row.circuit_open),
    lastError: toText(row.last_error),
    requestsLastHour: toInt(row.requests_last_hour),
    errorsLastHour: toInt(row.errors_last_hour),
    peakRequestsPerMinute: toInt(row.peak_rpm),
    lastRequestAt: toDate(row.last_request_at),
  }));
}

export interface RecentRun {
  id: number;
  source: string;
  kind: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  requestsMade: number;
  itemsUpserted: number;
  itemsRemoved: number;
  note: string | null;
  error: string | null;
}

export async function getRecentRuns(limit = 30): Promise<RecentRun[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT id, source, kind, started_at, finished_at, status,
           requests_made, items_upserted, items_removed, note, error
      FROM sync_runs
     ORDER BY id DESC
     LIMIT ${limit}
  `);
  return result.rows.map((r) => ({
    id: toInt(r.id),
    source: String(r.source),
    kind: String(r.kind),
    startedAt: toDate(r.started_at) ?? new Date(0),
    finishedAt: toDate(r.finished_at),
    status: String(r.status),
    requestsMade: toInt(r.requests_made),
    itemsUpserted: toInt(r.items_upserted),
    itemsRemoved: toInt(r.items_removed),
    note: toText(r.note),
    error: toText(r.error),
  }));
}

export interface QueueRow {
  source: string;
  kind: string;
  status: string;
  count: number;
  oldestRunAfter: Date | null;
}

export async function getQueue(): Promise<QueueRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT source, kind, status, count(*)::int AS count, min(run_after) AS oldest_run_after
      FROM sync_jobs
     WHERE status IN ('pending','running','dead')
     GROUP BY source, kind, status
     ORDER BY status, source, kind
  `);
  return result.rows.map((r) => ({
    source: String(r.source),
    kind: String(r.kind),
    status: String(r.status),
    count: toInt(r.count),
    oldestRunAfter: toDate(r.oldest_run_after),
  }));
}

/** Backfill progress: how much of the region set has full detail yet. */
export async function getBackfillProgress(): Promise<{
  total: number;
  withDetail: number;
}> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE detail_fetched_at IS NOT NULL)::int AS with_detail
      FROM regions
  `);
  const row = result.rows[0];
  return { total: toInt(row?.total), withDetail: toInt(row?.with_detail) };
}

export interface EvictionFeedHealth {
  totalReports: number;
  activeReports: number;
  archivedReports: number;
  linkedRegions: number;
  /** Every prefix seen, so EVICTION_RESOLVED_PREFIXES can be corrected. */
  prefixes: Array<{ prefix: string | null; count: number; active: number }>;
  /** Reports naming no known region — usually a title format we don't parse. */
  unmatched: Array<{ title: string; url: string }>;
}

export async function getEvictionFeedHealth(): Promise<EvictionFeedHealth> {
  const totals = await db.execute<Record<string, unknown>>(sql`
    SELECT (SELECT count(*) FROM eviction_reports)                        AS total,
           (SELECT count(*) FROM eviction_reports WHERE is_active)        AS active,
           (SELECT count(*) FROM eviction_reports WHERE feed = 'archive') AS archived,
           (SELECT count(*) FROM eviction_report_regions)                 AS linked
  `);
  const prefixes = await db.execute<Record<string, unknown>>(sql`
    SELECT prefix, count(*)::int AS n, count(*) FILTER (WHERE is_active)::int AS active
      FROM eviction_reports GROUP BY prefix ORDER BY n DESC
  `);
  const unmatched = await db.execute<Record<string, unknown>>(sql`
    SELECT r.title, r.url
      FROM eviction_reports r
      LEFT JOIN eviction_report_regions rr ON rr.thread_id = r.thread_id
     WHERE rr.thread_id IS NULL
     ORDER BY r.posted_at DESC NULLS LAST
     LIMIT 20
  `);

  const row = totals.rows[0] ?? {};
  return {
    totalReports: toInt(row.total),
    activeReports: toInt(row.active),
    archivedReports: toInt(row.archived),
    linkedRegions: toInt(row.linked),
    prefixes: prefixes.rows.map((p) => ({
      prefix: toText(p.prefix),
      count: toInt(p.n),
      active: toInt(p.active),
    })),
    unmatched: unmatched.rows.map((u) => ({
      title: String(u.title),
      url: String(u.url),
    })),
  };
}
