import { Client } from "pg";

import { getEnv } from "@/lib/env";

/**
 * A process-wide exclusive lock, so only one sync worker ever runs.
 *
 * Two workers would each hold their own in-memory rate-limit buckets and
 * between them double the request rate against upstream — the exact thing this
 * application is supposed to avoid. Correctness is already safe (job claiming
 * uses FOR UPDATE SKIP LOCKED); this is about being a well-behaved client.
 *
 * The lock deliberately uses a DEDICATED connection rather than one from the
 * pool. `pg_try_advisory_lock` is session-scoped, and pooled connections are
 * closed after `idleTimeoutMillis` — which would silently drop the lock and let
 * a second worker start.
 */

/** Arbitrary but fixed: identifies this application's worker lock. */
const ADVISORY_LOCK_KEY = 8_314_207;

let holder: Client | null = null;

export async function acquireWorkerLock(): Promise<boolean> {
  if (holder) return true;

  const client = new Client({ connectionString: getEnv().DATABASE_URL });
  await client.connect();

  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [ADVISORY_LOCK_KEY],
    );
    if (result.rows[0]?.locked) {
      holder = client;
      // If the connection drops, the lock is gone with it — make that loud
      // rather than leaving a worker running that believes it is exclusive.
      client.on("error", (error) => {
        console.error("[sync] worker lock connection lost:", error.message);
        holder = null;
      });
      return true;
    }
    await client.end();
    return false;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

export async function releaseWorkerLock(): Promise<void> {
  if (!holder) return;
  const client = holder;
  holder = null;
  await client
    .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
    .catch(() => undefined);
  await client.end().catch(() => undefined);
}

export function holdsWorkerLock(): boolean {
  return holder !== null;
}
