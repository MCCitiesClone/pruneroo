import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  toBool,
  toDate,
  toDecimalString,
  toInt,
  toNumber,
  toText,
} from "@/lib/db/coerce";
import { getEnv } from "@/lib/env";

/**
 * Prune candidates: dormant players still holding money.
 *
 * A player who has not logged in for `inactivityDays` and whose balance is
 * above `minBalance` is money sitting idle, reclaimable to the government.
 * Both thresholds live here rather than in `v_prune_candidates` so the UI can
 * tune them per request, matching the at-risk insight.
 *
 * Two things this module is careful about:
 *
 * **Money is never a JS number.** Balances arrive as Postgres `numeric` and
 * stay decimal strings all the way to the formatter; `Number()` on a large
 * balance silently loses precision. The totals are summed in SQL for the same
 * reason. `minBalance` is the one exception and is interpolated as a numeric
 * literal, never compared in JS.
 *
 * **A missing balance is not a zero balance.** `balance_source` is carried
 * through to the UI: `pending` means we have not asked Treasury yet, and those
 * players are excluded from the list rather than being reported as broke. With
 * the roster backfill still running this is the majority of the population, so
 * presenting the list as complete would badly understate what is reclaimable.
 */

export type BalanceSource = "measured" | "no_account" | "pending";

export type PruneSort = "balance" | "player" | "last_seen" | "registered";

export interface PruneFilters {
  /** Days since last login that make a player dormant. */
  inactivityDays?: number;
  /** Exclusive floor on the balance — the rule is "> this". */
  minBalance?: number;
  /** Show excluded players too. Off by default. */
  includeExcluded?: boolean;
  /** Substring match on player name. */
  search?: string;
  /**
   * Restrict to these players, ignoring the window.
   *
   * Used to re-read a page after its balances were refreshed: the same players,
   * re-sorted on fresh values, with any that fell below the floor dropping out.
   */
  playerUuids?: string[];
  limit?: number;
  offset?: number;
  sort?: PruneSort;
  direction?: "asc" | "desc";
}

export interface PruneRow {
  playerUuid: string;
  playerName: string | null;
  lastSeenAt: Date | null;
  registeredAt: Date | null;
  /** Whole days since last login, computed in SQL from the stored timestamp. */
  daysInactive: number | null;
  lifetimePlaytimeMs: number | null;
  sessionCount: number | null;
  treasuryAccountId: number | null;
  /** Exact decimal string — never parsed into a JS number on the way here. */
  balance: string | null;
  balanceRaw: string | null;
  balanceSyncedAt: Date | null;
  /**
   * The refresh sweep has not re-read this balance within its own target
   * window, so the figure is older than the system intends. Computed in SQL:
   * `now()` in a React render body makes the component non-idempotent.
   */
  balanceIsStale: boolean;
  balanceSource: BalanceSource;
  isExcluded: boolean;
  exclusionReason: string | null;
  isBanned: boolean;
  isDeported: boolean;
}

/**
 * How much of the eligible population we have actually priced.
 *
 * The balance backfill walks ~61k dormant players one request at a time, so for
 * a long while the list is a partial answer. Surfacing this alongside it is the
 * difference between "40 players are prunable" and "40 so far, of 61k checked
 * so far" — the first is wrong in a way that hides money.
 */
export interface PruneCoverage {
  /** Dormant players, before any balance is considered. */
  dormant: number;
  measured: number;
  noAccount: number;
  pending: number;
  /** Dormant, measured, above the floor, not excluded — i.e. the list length. */
  eligible: number;
  /** Summed in SQL; an exact decimal string. */
  totalBalance: string | null;
  /** Fraction of dormant players whose balance is known, 0..1. */
  coverageRatio: number;
  oldestBalanceSyncedAt: Date | null;
}

function resolve(filters: PruneFilters) {
  const env = getEnv();
  const inactivityDays = filters.inactivityDays ?? env.PRUNE_INACTIVITY_DAYS;
  const minBalance = filters.minBalance ?? env.PRUNE_MIN_BALANCE;
  return { inactivityDays, minBalance };
}

/**
 * Shared WHERE fragment.
 *
 * `inactivityDays` and `minBalance` are validated numbers from the env schema
 * or the query parser, and are interpolated as bound parameters. The interval
 * is built with `make_interval` rather than string concatenation so no
 * user-supplied text ever reaches the SQL text.
 */
function whereClause(filters: PruneFilters) {
  const { inactivityDays, minBalance } = resolve(filters);

  const conditions = [
    sql`c.last_seen_at IS NOT NULL`,
    sql`c.last_seen_at < now() - make_interval(days => ${inactivityDays})`,
  ];

  if (!filters.includeExcluded) conditions.push(sql`NOT c.is_excluded`);

  const search = filters.search?.trim();
  if (search) {
    conditions.push(sql`c.player_name ILIKE ${"%" + search + "%"}`);
  }

  if (filters.playerUuids) {
    conditions.push(
      filters.playerUuids.length === 0
        ? sql`false`
        : sql`c.player_uuid IN (${sql.join(
            filters.playerUuids.map((uuid) => sql`${uuid}::uuid`),
            sql`, `,
          )})`,
    );
  }

  return {
    dormant: sql.join(conditions, sql` AND `),
    /** Dormant *and* actually holding money we have measured. */
    eligible: sql.join(
      [
        ...conditions,
        sql`c.balance_source = 'measured'`,
        sql`c.balance IS NOT NULL`,
        sql`c.balance > ${String(minBalance)}::numeric`,
      ],
      sql` AND `,
    ),
  };
}

/**
 * Whitelist of sortable columns.
 *
 * These are interpolated with `sql.raw`, so the lookup must never fall through
 * to an attacker-supplied string. `parsePruneFilters` already validates `sort`,
 * but this is the injection point, so it does not rely on the caller having
 * gone through the parser.
 */
const SORT_COLUMNS: Record<PruneSort, string> = {
  balance: "c.balance",
  player: "lower(c.player_name)",
  last_seen: "c.last_seen_at",
  registered: "c.registered_at",
};

function sortColumn(sort: PruneSort | undefined): string {
  return (sort && SORT_COLUMNS[sort]) || SORT_COLUMNS.balance;
}

export async function findPruneCandidates(
  filters: PruneFilters = {},
): Promise<PruneRow[]> {
  const where = whereClause(filters).eligible;
  const staleAfterHours = getEnv().PRUNE_BALANCE_MAX_AGE_HOURS;
  const sort = sortColumn(filters.sort);
  // Largest balances first by default: that is the order an operator works in.
  const direction = filters.direction === "asc" ? sql.raw("ASC") : sql.raw("DESC");
  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const result = await db.execute(sql`
    SELECT c.player_uuid,
           c.player_name,
           c.last_seen_at,
           c.registered_at,
           c.lifetime_playtime_ms,
           c.session_count,
           c.treasury_account_id,
           c.balance,
           c.balance_raw,
           c.balance_synced_at,
           (c.balance_synced_at IS NOT NULL
            AND c.balance_synced_at
                < now() - make_interval(hours => ${staleAfterHours}))
             AS balance_is_stale,
           c.balance_source,
           c.is_excluded,
           c.exclusion_reason,
           c.is_banned,
           c.is_deported,
           floor(extract(epoch FROM now() - c.last_seen_at) / 86400)::int
             AS days_inactive
      FROM v_prune_candidates c
     WHERE ${where}
     ORDER BY ${sql.raw(sort)} ${direction} NULLS LAST, c.player_uuid
     LIMIT ${limit} OFFSET ${offset}
  `);

  // db.execute bypasses Drizzle's column mapping: numeric and timestamptz both
  // arrive as strings here, so every column goes through the coercers.
  return result.rows.map((row) => ({
    playerUuid: String(row.player_uuid),
    playerName: toText(row.player_name),
    lastSeenAt: toDate(row.last_seen_at),
    registeredAt: toDate(row.registered_at),
    daysInactive: toNumber(row.days_inactive),
    lifetimePlaytimeMs: toNumber(row.lifetime_playtime_ms),
    sessionCount: toNumber(row.session_count),
    treasuryAccountId: toNumber(row.treasury_account_id),
    balance: toDecimalString(row.balance),
    balanceRaw: toText(row.balance_raw),
    balanceSyncedAt: toDate(row.balance_synced_at),
    balanceIsStale: toBool(row.balance_is_stale),
    balanceSource: (toText(row.balance_source) ?? "pending") as BalanceSource,
    isExcluded: toBool(row.is_excluded),
    exclusionReason: toText(row.exclusion_reason),
    isBanned: toBool(row.is_banned),
    isDeported: toBool(row.is_deported),
  }));
}

export async function countPruneCandidates(
  filters: PruneFilters = {},
): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT count(*) AS count
      FROM v_prune_candidates c
     WHERE ${whereClause(filters).eligible}
  `);
  return toInt(result.rows[0]?.count);
}

export async function getPruneCoverage(
  filters: PruneFilters = {},
): Promise<PruneCoverage> {
  const { dormant } = whereClause(filters);
  const { minBalance } = resolve(filters);

  const result = await db.execute(sql`
    SELECT count(*)                                             AS dormant,
           count(*) FILTER (WHERE c.balance_source = 'measured')   AS measured,
           count(*) FILTER (WHERE c.balance_source = 'no_account') AS no_account,
           count(*) FILTER (WHERE c.balance_source = 'pending')    AS pending,
           count(*) FILTER (
             WHERE c.balance_source = 'measured'
               AND c.balance > ${String(minBalance)}::numeric
           )                                                    AS eligible,
           -- Summed in SQL so the total keeps numeric precision.
           sum(c.balance) FILTER (
             WHERE c.balance_source = 'measured'
               AND c.balance > ${String(minBalance)}::numeric
           )                                                    AS total_balance,
           min(c.balance_synced_at)                             AS oldest_synced
      FROM v_prune_candidates c
     WHERE ${dormant}
  `);

  const row = result.rows[0] ?? {};
  const dormantCount = toInt(row.dormant);
  const measured = toInt(row.measured);
  const noAccount = toInt(row.no_account);

  return {
    dormant: dormantCount,
    measured,
    noAccount,
    pending: toInt(row.pending),
    eligible: toInt(row.eligible),
    totalBalance: toDecimalString(row.total_balance),
    // A 404 is a real answer — the player has no account, so there is provably
    // nothing to reclaim. Those count as covered, not as a gap.
    coverageRatio:
      dormantCount === 0 ? 1 : (measured + noAccount) / dormantCount,
    oldestBalanceSyncedAt: toDate(row.oldest_synced),
  };
}

/**
 * Progress of the balance backfill.
 *
 * The counts are derived state, not job bookkeeping: every player the sweep
 * finishes writes either a `treasury_accounts` row or a
 * `treasury_account_misses` row, so `pending` falls continuously while a batch
 * runs rather than jumping when it commits. That makes this live without the
 * sweep having to report anything.
 *
 * The rate is measured over a trailing window instead of derived from the
 * configured batch size. The two disagree substantially — the sweep awaits each
 * player in turn, so it never uses the throttle's concurrency and runs far
 * below the nominal request budget — and an ETA built on the configured figure
 * would be optimistic by several times. Measured throughput is the only honest
 * basis for a projection.
 */
export interface PruneBackfillProgress {
  dormant: number;
  measured: number;
  noAccount: number;
  pending: number;
  /** Fraction of the dormant roster with a known answer, 0..1. */
  ratio: number;
  /** Players completed in the trailing window. */
  pricedRecently: number;
  windowMinutes: number;
  /**
   * Players per minute while a batch is executing, measured from completed
   * runs. Null until at least one run has finished.
   */
  ratePerMinute: number | null;
  /** Hours to drain `pending` at that rate, if the sweep runs continuously. */
  etaHours: number | null;
  /** A sweep batch is executing right now. */
  running: boolean;
  /**
   * No batch in flight, but one finished moments ago — the sweep is cycling
   * normally, not stopped. Without this a page loaded during the gap between
   * batches reports "Idle", which reads as broken on a job that is in fact
   * working through 55,000 players.
   */
  betweenBatches: boolean;
  runStartedAt: Date | null;
  runNote: string | null;
  lastFinishedAt: Date | null;
  lastError: string | null;
}

const RATE_WINDOW_MINUTES = 30;

/**
 * How recently a `running` row must have started to be believed.
 *
 * Comfortably longer than a batch (a minute or two once parallelised, up to
 * about twelve when it ran sequentially) and well under the worker's 45-minute
 * watchdog, so a live sweep is never called idle and an orphaned row is never
 * called live.
 */
const LIVE_RUN_MINUTES = 20;

/**
 * How recently a batch must have finished for the sweep to count as cycling
 * rather than stopped. Comfortably over the scheduler's 15s cadence plus a tick
 * of slack, and far under any interval that would hide a genuine stall.
 */
const BETWEEN_BATCHES_SECONDS = 90;

export async function getPruneBackfillProgress(
  filters: PruneFilters = {},
): Promise<PruneBackfillProgress> {
  const { inactivityDays } = resolve(filters);

  const [counts, rate, run] = await Promise.all([
    db.execute(sql`
      SELECT count(*)                                             AS dormant,
             count(*) FILTER (WHERE balance_source = 'measured')   AS measured,
             count(*) FILTER (WHERE balance_source = 'no_account') AS no_account,
             count(*) FILTER (WHERE balance_source = 'pending')    AS pending
        FROM v_prune_candidates
       WHERE last_seen_at IS NOT NULL
         AND last_seen_at < now() - make_interval(days => ${inactivityDays})
    `),
    // Two different numbers, both wanted.
    //
    // `priced` is liveness: completions in the trailing window, from either
    // outcome a player can have. It answers "is anything happening right now".
    //
    // `throughput` is the ETA basis: players per minute *while a batch is
    // actually executing*, from completed runs. Dividing completions by
    // wall-clock instead would fold in every minute the worker was stopped —
    // measured here as 4.4/min against a working rate near 50, projecting nine
    // days instead of one. An ETA is only useful if it answers "how long if it
    // keeps running", so idle time must not be in the denominator.
    db.execute(sql`
      WITH recent AS (
        SELECT items_upserted,
               extract(epoch FROM finished_at - started_at) / 60 AS minutes
          FROM sync_runs
         WHERE kind = 'treasury.prune.sweep'
           AND status = 'ok'
           AND finished_at IS NOT NULL
           AND items_upserted > 0
         ORDER BY started_at DESC
         LIMIT 10
      )
      SELECT (
        SELECT count(*) FROM treasury_accounts
         WHERE resolved_at > now() - make_interval(mins => ${RATE_WINDOW_MINUTES})
      ) + (
        SELECT count(*) FROM treasury_account_misses
         WHERE checked_at > now() - make_interval(mins => ${RATE_WINDOW_MINUTES})
      ) AS priced,
      (SELECT sum(items_upserted) FROM recent) AS run_items,
      (SELECT sum(minutes) FROM recent WHERE minutes > 0) AS run_minutes
    `),
    /*
     * "Running now" and "how the last run ended" are read separately, and the
     * running check is time-bounded on purpose.
     *
     * A run row is set to `running` at the start and only rewritten when the
     * job finishes, so a process killed mid-batch leaves the row at `running`
     * for good — there are rows in this database over a day old in that state.
     * Taking the newest row and trusting its status would report a sweep as
     * running indefinitely, which is precisely the "is anything happening"
     * question this panel exists to answer.
     */
    db.execute(sql`
      SELECT
        (SELECT started_at FROM sync_runs
          WHERE kind = 'treasury.prune.sweep' AND status = 'running'
            AND started_at > now() - make_interval(mins => ${LIVE_RUN_MINUTES})
          ORDER BY started_at DESC LIMIT 1)                       AS run_started_at,
        (SELECT note FROM sync_runs
          WHERE kind = 'treasury.prune.sweep' AND status = 'running'
            AND started_at > now() - make_interval(mins => ${LIVE_RUN_MINUTES})
          ORDER BY started_at DESC LIMIT 1)                       AS run_note,
        (SELECT finished_at FROM sync_runs
          WHERE kind = 'treasury.prune.sweep' AND finished_at IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1)                      AS last_finished_at,
        (SELECT error FROM sync_runs
          WHERE kind = 'treasury.prune.sweep' AND finished_at IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1)                      AS last_error
    `),
  ]);

  const c = counts.rows[0] ?? {};
  const dormant = toInt(c.dormant);
  const measured = toInt(c.measured);
  const noAccount = toInt(c.no_account);
  const pending = toInt(c.pending);

  const pricedRecently = toInt(rate.rows[0]?.priced);
  const runItems = toNumber(rate.rows[0]?.run_items) ?? 0;
  const runMinutes = toNumber(rate.rows[0]?.run_minutes) ?? 0;
  const ratePerMinute = runMinutes > 0 ? runItems / runMinutes : null;

  const r = run.rows[0] ?? {};
  const runStartedAt = toDate(r.run_started_at);
  const lastFinishedAt = toDate(r.last_finished_at);
  const running = runStartedAt !== null;
  const betweenBatches =
    !running &&
    lastFinishedAt !== null &&
    Date.now() - lastFinishedAt.getTime() < BETWEEN_BATCHES_SECONDS * 1000;

  return {
    dormant,
    measured,
    noAccount,
    pending,
    ratio: dormant === 0 ? 1 : (measured + noAccount) / dormant,
    pricedRecently,
    windowMinutes: RATE_WINDOW_MINUTES,
    ratePerMinute,
    etaHours:
      ratePerMinute && pending > 0 ? pending / ratePerMinute / 60 : null,
    running,
    betweenBatches,
    runStartedAt,
    runNote: toText(r.run_note),
    lastFinishedAt,
    lastError: toText(r.last_error),
  };
}
