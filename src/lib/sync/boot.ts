import { getEnv } from "@/lib/env";
import { resolveTreasuryScope } from "@/lib/sources";

import { acquireWorkerLock, releaseWorkerLock } from "./lock";
import { reclaimAbandoned } from "./queue";
import { enqueueAllProbes } from "./scheduler";
import { startWorker, type WorkerHandle } from "./worker";

/**
 * Boots the background sync worker.
 *
 * Called from instrumentation.ts (which Next runs once per server instance) and
 * from `npm run sync -- --worker`. Both paths go through here so the exclusive
 * lock is never bypassed — running the CLI worker alongside `next dev` must not
 * double the request rate against upstream.
 *
 * Note: instrumentation.ts is the only startup hook Next documents, and it
 * documents no cron convention. Hosting a scheduler there is a deliberate
 * choice, valid because this deploys as a single long-running self-hosted
 * process, and guarded by the lock regardless.
 */

const globalForWorker = globalThis as unknown as {
  __prunerooWorker?: WorkerHandle | "starting";
};

export async function bootSyncWorker(options?: {
  /** Ignore SYNC_WORKER_ENABLED — the CLI asked for a worker explicitly. */
  force?: boolean;
}): Promise<WorkerHandle | null> {
  // Next's dev server re-evaluates modules on HMR; don't stack workers.
  if (globalForWorker.__prunerooWorker) return null;
  globalForWorker.__prunerooWorker = "starting";

  const env = getEnv();
  if (!env.SYNC_WORKER_ENABLED && !options?.force) {
    console.log("[sync] worker disabled via SYNC_WORKER_ENABLED=false");
    globalForWorker.__prunerooWorker = undefined;
    return null;
  }

  const locked = await acquireWorkerLock();
  if (!locked) {
    console.log(
      "[sync] another process holds the worker lock; not starting a second worker",
    );
    globalForWorker.__prunerooWorker = undefined;
    return null;
  }

  // A BUSINESS key gets 5x the quota, so it is worth one request to find out
  // before any bulk work begins.
  if (env.TREASURY_TOKEN) {
    try {
      const scope = await resolveTreasuryScope();
      console.log(`[sync] treasury key scope: ${scope}`);
    } catch (error) {
      console.warn("[sync] could not resolve treasury scope:", error);
    }
  }

  // Safe only because the exclusive lock is already held: nothing else can be
  // running, so anything still marked `running` belongs to a dead process.
  const abandoned = await reclaimAbandoned();
  if (abandoned.jobs > 0 || abandoned.runs > 0) {
    console.log(
      `[sync] reclaimed ${abandoned.jobs} job(s) and closed ${abandoned.runs} ` +
        `run(s) abandoned by a previous worker`,
    );
  }

  const worker = startWorker();
  globalForWorker.__prunerooWorker = worker;
  console.log(`[sync] worker ${worker.workerId} started`);

  await enqueueAllProbes();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[sync] ${signal} received; draining worker`);
    globalForWorker.__prunerooWorker = undefined;
    await worker.stop();
    await releaseWorkerLock();
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  return worker;
}
