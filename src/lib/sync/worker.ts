import { randomUUID } from "node:crypto";

import { and, gt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { sourceHealth } from "@/lib/db/schema";
import { CircuitOpenError, RateLimitError } from "@/lib/http/errors";

import { HANDLERS } from "./handlers";
import {
  claimNextForSource,
  completeJob,
  deferJob,
  failJob,
  reclaimStale,
  type ClaimedJob,
} from "./queue";
import { enqueueDueJobs } from "./scheduler";

const IDLE_POLL_MS = 2_000;

/**
 * Jobs a source may run at once.
 *
 * This is not a rate control and cannot raise the request rate: every outbound
 * call goes through that host's shared throttle, which holds the token buckets
 * and its own concurrency semaphore, so N jobs contend for the same slots
 * rather than getting N times as many. `tests/rate-limiter.test.ts` pins that.
 *
 * Treasury gets two because a single lane starved work in practice. Its jobs
 * are a mix of long and short — `treasury.prune.sweep` runs for a minute or
 * more per batch, while `treasury.balance` jobs are queued 300 at a time and
 * take milliseconds each — and with one lane the short ones simply wait out
 * every batch. Two lanes let them interleave; the throttle still sets the pace.
 *
 * Everything else stays at one: no other source has shown the same contention,
 * and the forum is deliberately serial at 6 requests a minute.
 */
const SOURCE_CONCURRENCY: Record<string, number> = { treasury: 2 };
const DEFAULT_SOURCE_CONCURRENCY = 1;

function concurrencyFor(source: string): number {
  return SOURCE_CONCURRENCY[source] ?? DEFAULT_SOURCE_CONCURRENCY;
}
const STALE_RECLAIM_EVERY_MS = 5 * 60_000;

/**
 * Watchdog deadline per job.
 *
 * Generous, because a legitimate full punishments crawl is ~1,000 pages at
 * 60 req/min. The point is not to police slow work but to guarantee that a job
 * which hangs — a wedged socket, a lost database connection — eventually
 * surfaces as a failure and is retried, instead of silently occupying its
 * source's slot forever and stalling that source for good.
 */
const JOB_TIMEOUT_MS = 45 * 60_000;

class JobTimeoutError extends Error {
  constructor(kind: string, ms: number) {
    super(`Job "${kind}" exceeded the ${Math.round(ms / 60_000)}m watchdog deadline`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Each source drains independently.
 *
 * Sources have separate rate budgets and separate throttles, so running them
 * serially would leave three budgets idle while one long crawl grinds — a
 * 626-page punishments crawl would block Realty for ten minutes for no reason.
 */
const SOURCES = [
  "realty",
  "punishments",
  "analytics",
  "treasury",
  "forum",
  // Local recomputation, but queued like any other work so it is visible on
  // /sync and cannot overlap with itself.
  "plots",
  // Discord alerts. Its own lane so a cooling-off 429 never stalls a crawl.
  "notify",
] as const;

/** Sources whose circuit breaker is currently open; their jobs are skipped. */
async function openCircuitSources(): Promise<Set<string>> {
  const rows = await db
    .select({ source: sourceHealth.source })
    .from(sourceHealth)
    .where(
      and(
        sql`${sourceHealth.circuitOpenUntil} IS NOT NULL`,
        gt(sourceHealth.circuitOpenUntil, new Date()),
      ),
    );
  return new Set(rows.map((r) => r.source));
}

export interface WorkerHandle {
  stop: () => Promise<void>;
  readonly workerId: string;
}

export function startWorker(): WorkerHandle {
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  let running = true;
  let lastReclaim = 0;

  /** In-flight jobs, per source. */
  const inFlight = new Map<string, Set<Promise<void>>>();
  const runningFor = (source: string) => inFlight.get(source)?.size ?? 0;
  const allRunning = () => [...inFlight.values()].flatMap((set) => [...set]);

  const loop = (async () => {
    while (running) {
      try {
        if (Date.now() - lastReclaim > STALE_RECLAIM_EVERY_MS) {
          lastReclaim = Date.now();
          const reclaimed = await reclaimStale();
          if (reclaimed > 0) {
            console.log(`[sync] reclaimed ${reclaimed} stale job(s)`);
          }
        }

        await enqueueDueJobs();
        const paused = await openCircuitSources();

        let started = 0;
        for (const source of SOURCES) {
          if (paused.has(source)) continue;

          while (runningFor(source) < concurrencyFor(source)) {
            const job = await claimNextForSource(workerId, source);
            if (!job) break;

            started += 1;
            let set = inFlight.get(source);
            if (!set) {
              set = new Set();
              inFlight.set(source, set);
            }
            const lane = set;
            const promise: Promise<void> = runJob(job).finally(() =>
              lane.delete(promise),
            );
            lane.add(promise);
          }
        }

        const running = allRunning();
        if (running.length === 0) {
          // Nothing to do anywhere; back off before asking again.
          await sleep(IDLE_POLL_MS);
        } else if (started === 0) {
          // Every idle source is empty — wait for a running one to finish
          // rather than spinning on the queue.
          await Promise.race([...running, sleep(IDLE_POLL_MS)]);
        }
      } catch (error) {
        console.error("[sync] worker loop error:", error);
        await sleep(IDLE_POLL_MS);
      }
    }

    // Let in-flight jobs finish so a crawl isn't abandoned mid-page.
    await Promise.allSettled([...inFlight.values()]);
  })();

  return {
    workerId,
    async stop() {
      running = false;
      await loop;
    },
  };
}

async function runJob(job: ClaimedJob): Promise<void> {
  const handler = HANDLERS[job.kind];
  if (!handler) {
    await failJob(job, new Error(`No handler registered for kind "${job.kind}"`));
    return;
  }

  let watchdog: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      handler(job.payload ?? {}),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new JobTimeoutError(job.kind, JOB_TIMEOUT_MS)),
          JOB_TIMEOUT_MS,
        );
        // Don't hold the process open just for the watchdog.
        watchdog.unref?.();
      }),
    ]);
    await completeJob(job.id);
  } catch (error) {
    // A 429 or an open circuit is the upstream asking us to wait. That is not a
    // job failure, so the attempt is refunded and the job simply comes back.
    if (error instanceof RateLimitError) {
      const runAfter = new Date(Date.now() + error.retryAfterSeconds * 1000);
      console.warn(
        `[sync] ${job.kind} rate limited; deferring to ${runAfter.toISOString()}`,
      );
      await deferJob(job.id, runAfter);
      return;
    }
    if (error instanceof CircuitOpenError) {
      await deferJob(job.id, error.openUntil);
      return;
    }
    // Postgres picks a victim to abort when two transactions deadlock. That is
    // transient and the job is safe to rerun, so it should not burn an attempt.
    if (isDeadlock(error)) {
      console.warn(`[sync] ${job.kind} hit a deadlock; requeueing`);
      await deferJob(job.id, new Date(Date.now() + 5_000));
      return;
    }

    console.error(`[sync] ${job.kind} failed:`, error);
    await failJob(job, error);
  } finally {
    clearTimeout(watchdog);
  }
}

/** Postgres SQLSTATE 40P01. */
function isDeadlock(error: unknown): boolean {
  for (let e = error; e; e = (e as { cause?: unknown }).cause) {
    if (typeof e === "object" && (e as { code?: string }).code === "40P01") {
      return true;
    }
    if (e instanceof Error && /deadlock detected/i.test(e.message)) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a single job kind once, in-process. Used by scripts/sync.ts. */
export async function runOnce(
  kind: string,
  payload: unknown = {},
): Promise<void> {
  const handler = HANDLERS[kind];
  if (!handler) {
    throw new Error(
      `Unknown job kind "${kind}". Known kinds:\n  ${Object.keys(HANDLERS).join("\n  ")}`,
    );
  }
  await handler(payload);
}
