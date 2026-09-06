import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { treasuryAccountMisses, treasuryAccounts } from "@/lib/db/schema";
import { normalizeUuid } from "@/lib/identity";
import { getEnv } from "@/lib/env";
import { CircuitOpenError } from "@/lib/http/errors";
import { getSources } from "@/lib/sources";

import { writeBalance } from "../balances";
import { runPooled } from "../pool";
import { enqueueMany, startRun } from "../queue";

const SOURCE = "treasury";
const MAX_ACCOUNT_JOBS_PER_PASS = 300;

/**
 * How long a "Treasury has no account for this player" answer is trusted.
 *
 * An account can be created later, so a miss ages out rather than writing the
 * player off permanently. Long, because the players this applies to are by
 * definition dormant and are not opening accounts.
 */
const MISS_RECHECK_DAYS = 90;

/** Players between progress reports inside a long sweep batch. */
const PROGRESS_EVERY = 10;

/**
 * Queue account resolution for property stakeholders we have no accountId for.
 *
 * `accountId` never changes, so each player costs exactly one request, ever.
 * There is no batch endpoint — this is the largest N+1 in the system and is
 * capped per pass to stay well inside the documented quota.
 */
export async function handleTreasuryResolveSweep(): Promise<void> {
  const run = await startRun(SOURCE, "treasury.resolve.sweep");
  const { treasury } = getSources();

  if (!treasury) {
    await run.finish({ status: "skipped", note: "TREASURY_TOKEN not set" });
    return;
  }

  const result = await db.execute<{ uuid: string }>(sql`
    SELECT DISTINCT s.player_uuid AS uuid
      FROM v_region_stakeholders s
      LEFT JOIN treasury_accounts t ON t.player_uuid = s.player_uuid
      LEFT JOIN treasury_account_misses m ON m.player_uuid = s.player_uuid
     WHERE t.account_id IS NULL
       -- Without this the handful of stakeholders Treasury has no account for
       -- (5 of 1,515) are re-queued on every pass, forever.
       AND (m.player_uuid IS NULL
            OR m.checked_at < now() - make_interval(days => ${MISS_RECHECK_DAYS}))
     LIMIT ${MAX_ACCOUNT_JOBS_PER_PASS}
  `);

  await enqueueMany(
    result.rows.map((row) => ({
      source: SOURCE,
      kind: "treasury.account.resolve",
      dedupeKey: row.uuid,
      payload: { playerUuid: row.uuid },
      priority: 160,
    })),
  );

  await run.finish({
    status: "ok",
    note: `Queued ${result.rows.length} account resolutions`,
  });
}

export async function handleTreasuryAccountResolve(payload: {
  playerUuid: string;
}): Promise<void> {
  const { treasury } = getSources();
  if (!treasury) return;

  const account = await treasury.accountByPlayer(payload.playerUuid);
  if (!account) {
    // A 404 is a real answer, and the only place it can be recorded — the
    // player never used the economy, so there is provably nothing to reclaim.
    await recordAccountMiss(payload.playerUuid);
    return;
  }

  await db
    .insert(treasuryAccounts)
    .values({
      accountId: account.accountId,
      playerUuid: normalizeUuid(account.playerUuid) ?? payload.playerUuid,
      playerName: account.playerName ?? null,
      resolvedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: treasuryAccounts.accountId,
      set: {
        playerUuid: sql`EXCLUDED.player_uuid`,
        playerName: sql`COALESCE(EXCLUDED.player_name, ${treasuryAccounts.playerName})`,
        resolvedAt: new Date(),
      },
    });

  await enqueueMany([
    {
      source: SOURCE,
      kind: "treasury.balance",
      dedupeKey: String(account.accountId),
      payload: { accountId: account.accountId },
      priority: 170,
    },
  ]);
}

export async function handleTreasuryBalance(payload: {
  accountId: number;
}): Promise<void> {
  const { treasury } = getSources();
  if (!treasury) return;

  const result = await treasury.balance(payload.accountId);
  if (!result) return;

  await writeBalance(payload.accountId, result.balance);
}

/**
 * Refresh balances for stakeholder accounts, newest-stale first.
 *
 * Scoped to stakeholders deliberately. Every resolved account was a stakeholder
 * until the prune sweep began walking the whole roster; left unscoped this
 * sweep would inherit ~61k dormant accounts and try to hold all of them at
 * 6-hour freshness, which its 300-per-pass cap cannot do — it would churn the
 * oldest 300 forever while starving the accounts this insight actually needs
 * fresh. Prune candidates get their own, slower sweep below.
 */
export async function handleTreasuryBalanceSweep(): Promise<void> {
  const run = await startRun(SOURCE, "treasury.balance.sweep");
  const { treasury } = getSources();

  if (!treasury) {
    await run.finish({ status: "skipped", note: "TREASURY_TOKEN not set" });
    return;
  }

  const result = await db.execute<{ account_id: number }>(sql`
    SELECT t.account_id
      FROM treasury_accounts t
      LEFT JOIN treasury_balances b ON b.account_id = t.account_id
     WHERE t.player_uuid IN (SELECT player_uuid FROM v_region_stakeholders)
       AND (b.account_id IS NULL
            OR b.synced_at < now() - interval '6 hours')
     ORDER BY b.synced_at ASC NULLS FIRST
     LIMIT ${MAX_ACCOUNT_JOBS_PER_PASS}
  `);

  await enqueueMany(
    result.rows.map((row) => ({
      source: SOURCE,
      kind: "treasury.balance",
      dedupeKey: String(row.account_id),
      payload: { accountId: row.account_id },
      priority: 170,
    })),
  );

  await run.finish({
    status: "ok",
    note: `Queued ${result.rows.length} balance refreshes`,
  });
}

/** Remember that Treasury has no account for a player. */
async function recordAccountMiss(playerUuid: string): Promise<void> {
  const uuid = normalizeUuid(playerUuid);
  if (!uuid) return;

  await db
    .insert(treasuryAccountMisses)
    .values({ playerUuid: uuid, checkedAt: new Date() })
    .onConflictDoUpdate({
      target: treasuryAccountMisses.playerUuid,
      set: { checkedAt: new Date() },
    });
}

/** Store one account and its balance. Returns the balance if there was one. */
async function storeAccountAndBalance(
  treasury: NonNullable<ReturnType<typeof getSources>["treasury"]>,
  playerUuid: string,
): Promise<{ requests: number; resolved: boolean }> {
  const account = await treasury.accountByPlayer(playerUuid);
  if (!account) {
    await recordAccountMiss(playerUuid);
    return { requests: 1, resolved: false };
  }

  await db
    .insert(treasuryAccounts)
    .values({
      accountId: account.accountId,
      playerUuid: normalizeUuid(account.playerUuid) ?? playerUuid,
      playerName: account.playerName ?? null,
      resolvedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: treasuryAccounts.accountId,
      set: {
        playerUuid: sql`EXCLUDED.player_uuid`,
        playerName: sql`COALESCE(EXCLUDED.player_name, ${treasuryAccounts.playerName})`,
        resolvedAt: new Date(),
      },
    });

  // Priced in the same pass rather than via a queued job: a player then moves
  // from 'pending' straight to 'measured', so the coverage figure on /prune
  // only ever counts players whose answer is complete. The two calls are in
  // different rate groups (byPlayer 240/min, balance 480/min), so the balance
  // costs effectively nothing against the resolve pacing.
  const result = await treasury.balance(account.accountId);
  if (result) await writeBalance(account.accountId, result.balance);

  return { requests: 2, resolved: true };
}

/**
 * Price the dormant roster, a batch at a time.
 *
 * The prune insight needs a balance for every player past the inactivity
 * threshold — ~61k of them — and Treasury exposes no bulk balance endpoint, so
 * this is one `by-player` call per player, ever, plus one balance call for each
 * that resolves.
 *
 * Batched inside a single job rather than fanned out as one job per player,
 * because the worker runs exactly one job per source at a time: 61k queued jobs
 * would each pay a claim/complete round trip through `sync_jobs` on that one
 * serial slot, and would block the chest-shop probe behind them for the whole
 * backfill. A bounded batch releases the slot roughly once a minute while the
 * shared throttle paces the requests inside it.
 *
 * This is not a re-crawl on a timer: the *candidate set* is derived locally from
 * stored `last_seen_at`, and a player is only ever asked about once. What the
 * timer drives is draining a finite backlog, which shrinks to a trickle of
 * newly-dormant players once the backfill completes.
 */
export async function handleTreasuryPruneSweep(): Promise<void> {
  const run = await startRun(SOURCE, "treasury.prune.sweep");
  const { treasury } = getSources();
  const env = getEnv();

  if (!treasury) {
    await run.finish({ status: "skipped", note: "TREASURY_TOKEN not set" });
    return;
  }

  const batch = await db.execute<{ uuid: string }>(sql`
    SELECT a.player_uuid AS uuid
      FROM player_analytics a
      LEFT JOIN treasury_accounts t       ON t.player_uuid = a.player_uuid
      LEFT JOIN treasury_account_misses m ON m.player_uuid = a.player_uuid
     WHERE a.last_seen_at IS NOT NULL
       AND a.last_seen_at < now() - make_interval(days => ${env.PRUNE_INACTIVITY_DAYS})
       AND t.account_id IS NULL
       AND (m.player_uuid IS NULL
            OR m.checked_at < now() - make_interval(days => ${MISS_RECHECK_DAYS}))
     -- Longest-dormant first: the most likely to be genuinely abandoned.
     ORDER BY a.last_seen_at ASC
     LIMIT ${env.PRUNE_SWEEP_BATCH}
  `);

  const rows = batch.rows;
  let requests = 0;
  let resolved = 0;
  let done = 0;
  let failed = 0;

  /**
   * Players are worked on in parallel, but the request rate is not raised by
   * doing so and cannot be: every call inside `storeAccountAndBalance` goes
   * through the shared throttle, which holds the per-endpoint token bucket and
   * a 2-slot concurrency semaphore. Whatever this pool width is, at most two
   * treasury requests are in flight and the buckets still meter them.
   *
   * The pool exists because awaiting each player in turn left that allowance
   * mostly idle — one request at a time against a budget of 240/min.
   */
  try {
    const outcome = await runPooled(
      rows,
      env.PRUNE_SWEEP_CONCURRENCY,
      async (row) => {
        const result = await storeAccountAndBalance(treasury, row.uuid);
        requests += result.requests;
        if (result.resolved) resolved += 1;
      },
      {
        // Upstream is sick; stop pulling new work and let the job be retried.
        // Anything else is counted and skipped: the player wrote neither an
        // account nor a miss, so they stay a candidate and come back next pass.
        isFatal: (error) => error instanceof CircuitOpenError,
        progressEvery: PROGRESS_EVERY,
        // A batch takes minutes; without this the run row sits at `running`
        // with zeroes and a working sweep looks identical to a wedged one.
        onProgress: (count) =>
          run.progress({
            requestsMade: requests,
            itemsUpserted: resolved,
            note: `Priced ${count}/${rows.length} in this batch (${resolved} with an account)`,
          }),
      },
    );

    done = outcome.done;
    failed = outcome.failed;
    if (outcome.aborted) throw outcome.aborted;

    const remaining = await db.execute<{ count: string }>(sql`
      SELECT count(*) AS count
        FROM v_prune_candidates
       WHERE last_seen_at IS NOT NULL
         AND last_seen_at < now() - make_interval(days => ${env.PRUNE_INACTIVITY_DAYS})
         AND balance_source = 'pending'
    `);

    const pending = Number(remaining.rows[0]?.count ?? 0);

    await run.finish({
      status: "ok",
      requestsMade: requests,
      itemsUpserted: resolved,
      note:
        rows.length === 0
          ? "Dormant roster fully priced; nothing pending"
          : `Priced ${done} (${resolved} with an account` +
            `${failed > 0 ? `, ${failed} failed and will retry` : ""}); ` +
            `${pending.toLocaleString()} still pending`,
    });
  } catch (error) {
    // Whatever the batch got through is already committed, so a mid-batch
    // failure loses nothing — the next pass picks up where this one stopped.
    await run.finish({
      status: "error",
      requestsMade: requests,
      itemsUpserted: resolved,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Keep prune candidates' balances from going stale.
 *
 * A dormant player is not spending, but their balance still moves: chest shops
 * sell while the owner is offline, and anyone can transfer money in. So the
 * figure has to be re-read — just far less often than a stakeholder's, which is
 * why this is a separate sweep from `treasury.balance.sweep` with its own
 * interval.
 */
export async function handleTreasuryPruneBalanceSweep(): Promise<void> {
  const run = await startRun(SOURCE, "treasury.prune.balance.sweep");
  const { treasury } = getSources();
  const env = getEnv();

  if (!treasury) {
    await run.finish({ status: "skipped", note: "TREASURY_TOKEN not set" });
    return;
  }

  const stale = await db.execute<{ account_id: number }>(sql`
    SELECT t.account_id
      FROM player_analytics a
      JOIN treasury_accounts t  ON t.player_uuid = a.player_uuid
      JOIN treasury_balances b  ON b.account_id  = t.account_id
     WHERE a.last_seen_at IS NOT NULL
       AND a.last_seen_at < now() - make_interval(days => ${env.PRUNE_INACTIVITY_DAYS})
       AND b.synced_at < now() - make_interval(hours => ${env.PRUNE_BALANCE_MAX_AGE_HOURS})
       -- Nothing to reclaim from an empty account, so it is not worth a request.
       AND b.balance > 0
     ORDER BY b.synced_at ASC
     LIMIT ${env.PRUNE_BALANCE_BATCH}
  `);

  let requests = 0;

  try {
    for (const row of stale.rows) {
      const result = await treasury.balance(row.account_id);
      requests += 1;
      if (!result) continue;

      await writeBalance(row.account_id, result.balance);
    }

    await run.finish({
      status: "ok",
      requestsMade: requests,
      itemsUpserted: requests,
      note: `Refreshed ${requests} dormant balance(s)`,
    });
  } catch (error) {
    await run.finish({
      status: "error",
      requestsMade: requests,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
