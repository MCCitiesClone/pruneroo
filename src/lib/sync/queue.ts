import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { syncJobs, syncRuns, syncWatermarks } from "@/lib/db/schema";

export type JobStatus = "pending" | "running" | "done" | "failed" | "dead";

export interface EnqueueOptions {
  source: string;
  kind: string;
  /** Stable key; re-enqueueing the same live job is a no-op. */
  dedupeKey?: string;
  payload?: unknown;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: number;
  source: string;
  kind: string;
  dedupeKey: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/**
 * Enqueue a job. The partial unique index on (kind, dedupe_key) for live rows
 * makes this idempotent: asking twice for the same work while it is still
 * pending or running does nothing.
 */
export async function enqueue(options: EnqueueOptions): Promise<void> {
  await db
    .insert(syncJobs)
    .values({
      source: options.source,
      kind: options.kind,
      dedupeKey: options.dedupeKey ?? options.kind,
      payload: options.payload ?? null,
      priority: options.priority ?? 100,
      runAfter: options.runAfter ?? new Date(),
      maxAttempts: options.maxAttempts ?? 5,
    })
    .onConflictDoNothing();
}

/** Bulk enqueue, used when an activity poll fans out to many regions. */
export async function enqueueMany(jobs: EnqueueOptions[]): Promise<void> {
  if (jobs.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    await db
      .insert(syncJobs)
      .values(
        jobs.slice(i, i + CHUNK).map((job) => ({
          source: job.source,
          kind: job.kind,
          dedupeKey: job.dedupeKey ?? job.kind,
          payload: job.payload ?? null,
          priority: job.priority ?? 100,
          runAfter: job.runAfter ?? new Date(),
          maxAttempts: job.maxAttempts ?? 5,
        })),
      )
      .onConflictDoNothing();
  }
}

/**
 * Claim the next runnable job for one source.
 *
 * Claiming is per-source because each source has an independent rate budget:
 * a 600-page punishments crawl must not stall Realty, whose quota is sitting
 * idle. The worker keeps one job in flight per source.
 *
 * `FOR UPDATE SKIP LOCKED` means several workers could safely share the queue,
 * though the advisory lock in boot.ts means only one runs in practice.
 */
export async function claimNextForSource(
  workerId: string,
  source: string,
): Promise<ClaimedJob | null> {
  const result = await db.execute<{
    id: number;
    source: string;
    kind: string;
    dedupe_key: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
  }>(sql`
    UPDATE sync_jobs SET
      status = 'running',
      locked_by = ${workerId},
      locked_at = now(),
      attempts = attempts + 1,
      updated_at = now()
    WHERE id = (
      SELECT id FROM sync_jobs
      WHERE status = 'pending' AND run_after <= now() AND source = ${source}
      ORDER BY priority ASC, run_after ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, source, kind, dedupe_key, payload, attempts, max_attempts
  `);

  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

export async function completeJob(id: number): Promise<void> {
  await db
    .update(syncJobs)
    .set({ status: "done", lockedBy: null, lockedAt: null, updatedAt: new Date() })
    .where(eq(syncJobs.id, id));
}

/**
 * Return a job to the queue without consuming an attempt. Used for 429s and
 * open circuits — the upstream asked us to wait, which is not a job failure.
 */
export async function deferJob(id: number, runAfter: Date): Promise<void> {
  await db
    .update(syncJobs)
    .set({
      status: "pending",
      attempts: sql`GREATEST(${syncJobs.attempts} - 1, 0)`,
      runAfter,
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(syncJobs.id, id));
}

export async function failJob(
  job: ClaimedJob,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  await db
    .update(syncJobs)
    .set({
      status: exhausted ? "dead" : "pending",
      lastError: message.slice(0, 2000),
      // Back off geometrically between attempts.
      runAfter: new Date(Date.now() + Math.min(30, 2 ** job.attempts) * 60_000),
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(syncJobs.id, job.id));
}

/** Recover jobs abandoned by a worker that died mid-run. */
/**
 * Free everything a previous worker left locked, and close out its run rows.
 *
 * Called once at startup, where it is unconditionally safe: the caller holds
 * the exclusive advisory lock, so no other worker exists and any job still
 * marked `running` was abandoned by a process that is gone.
 *
 * Without this a restart silently stalls a queue. The dedupe index covers
 * `status IN ('pending','running')`, so an orphaned `running` row blocks its
 * kind from ever being enqueued again, and the periodic `reclaimStale` only
 * frees it after 15 minutes — observed in practice as `treasury.prune.sweep`
 * held for 13 minutes by a dead PID while the 58,000-player backfill made no
 * progress at all.
 *
 * Run rows are closed out too, rather than left at `running` forever: they are
 * what `/sync` and the backfill panel read to answer "is anything happening",
 * and this database still holds rows claiming to be running from a day ago.
 */
export async function reclaimAbandoned(): Promise<{
  jobs: number;
  runs: number;
}> {
  const jobs = await reclaimStale(0);

  const runs = await db
    .update(syncRuns)
    .set({
      status: "error",
      finishedAt: new Date(),
      error: "Abandoned: the worker process exited before this run finished",
    })
    .where(and(eq(syncRuns.status, "running"), isNull(syncRuns.finishedAt)))
    .returning({ id: syncRuns.id });

  return { jobs, runs: runs.length };
}

export async function reclaimStale(olderThanMs = 15 * 60_000): Promise<number> {
  const result = await db
    .update(syncJobs)
    .set({ status: "pending", lockedBy: null, lockedAt: null })
    .where(
      and(
        eq(syncJobs.status, "running"),
        lte(syncJobs.lockedAt, new Date(Date.now() - olderThanMs)),
      ),
    )
    .returning({ id: syncJobs.id });
  return result.length;
}

// ---------------------------------------------------------------------------
// Watermarks
// ---------------------------------------------------------------------------

export interface Watermark {
  cursorText: string | null;
  cursorInt: number | null;
  cursorTime: Date | null;
}

export async function getWatermark(
  source: string,
  key: string,
): Promise<Watermark | null> {
  const [row] = await db
    .select()
    .from(syncWatermarks)
    .where(and(eq(syncWatermarks.source, source), eq(syncWatermarks.key, key)))
    .limit(1);
  if (!row) return null;
  return {
    cursorText: row.cursorText,
    cursorInt: row.cursorInt,
    cursorTime: row.cursorTime,
  };
}

export async function setWatermark(
  source: string,
  key: string,
  value: Partial<Watermark>,
): Promise<void> {
  await db
    .insert(syncWatermarks)
    .values({
      source,
      key,
      cursorText: value.cursorText ?? null,
      cursorInt: value.cursorInt ?? null,
      cursorTime: value.cursorTime ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [syncWatermarks.source, syncWatermarks.key],
      set: {
        cursorText: value.cursorText ?? null,
        cursorInt: value.cursorInt ?? null,
        cursorTime: value.cursorTime ?? null,
        updatedAt: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// Run auditing
// ---------------------------------------------------------------------------

export interface RunHandle {
  id: number;
  /**
   * Report progress without ending the run.
   *
   * A run row is otherwise written only at `finish`, so a job that takes
   * minutes shows as `running` with zeroes throughout and there is no way to
   * tell a working job from a wedged one. Long jobs call this periodically;
   * short ones never need to.
   */
  progress: (update: {
    requestsMade?: number;
    itemsUpserted?: number;
    note?: string;
  }) => Promise<void>;
  finish: (result: {
    status: "ok" | "error" | "skipped";
    requestsMade?: number;
    itemsUpserted?: number;
    itemsRemoved?: number;
    note?: string;
    error?: string;
  }) => Promise<void>;
}

export async function startRun(
  source: string,
  kind: string,
): Promise<RunHandle> {
  const [row] = await db
    .insert(syncRuns)
    .values({ source, kind })
    .returning({ id: syncRuns.id });

  return {
    id: row.id,
    async progress(update) {
      await db
        .update(syncRuns)
        .set({
          requestsMade: update.requestsMade ?? 0,
          itemsUpserted: update.itemsUpserted ?? 0,
          note: update.note ?? null,
        })
        .where(eq(syncRuns.id, row.id));
    },
    async finish(result) {
      await db
        .update(syncRuns)
        .set({
          finishedAt: new Date(),
          status: result.status,
          requestsMade: result.requestsMade ?? 0,
          itemsUpserted: result.itemsUpserted ?? 0,
          itemsRemoved: result.itemsRemoved ?? 0,
          note: result.note ?? null,
          error: result.error?.slice(0, 2000) ?? null,
        })
        .where(eq(syncRuns.id, row.id));
    },
  };
}

/** Queue depth by status, for the sync-health page. */
export async function queueDepth(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: syncJobs.status, count: sql<number>`count(*)::int` })
    .from(syncJobs)
    .groupBy(syncJobs.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

export { or };
