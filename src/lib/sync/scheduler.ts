import { enqueue } from "./queue";

/**
 * Recurring jobs.
 *
 * Every entry here is an O(1) change probe or a single bulk call — nothing
 * expensive runs on a timer. Crawls are enqueued by probes that observed an
 * actual change, so a quiet server costs a handful of requests per hour.
 */
export interface ScheduleEntry {
  kind: string;
  source: string;
  everyMs: number;
  priority: number;
  description: string;
}

const MINUTE = 60_000;

export const SCHEDULE: ScheduleEntry[] = [
  {
    kind: "punishments.stats",
    source: "punishments",
    everyMs: 5 * MINUTE,
    priority: 10,
    description: "2 requests; enqueues a crawl only when a count changes",
  },
  {
    kind: "realty.activity",
    source: "realty",
    everyMs: 5 * MINUTE,
    priority: 10,
    description: "Delta feed; fans out detail refreshes for touched regions",
  },
  {
    kind: "realty.stats",
    source: "realty",
    everyMs: 15 * MINUTE,
    priority: 15,
    description: "1 request; enqueues a region re-index only when the count moves",
  },
  {
    kind: "analytics.playersTable",
    source: "analytics",
    everyMs: 60 * MINUTE,
    priority: 20,
    description: "1 request for the whole roster; computes the 30-day refresh set",
  },
  {
    kind: "forum.evictionReports",
    source: "forum",
    everyMs: 15 * MINUTE,
    priority: 18,
    description:
      "0 requests; queues page-1 checks, which walk deeper only when a page changed",
  },
  {
    kind: "plots.merges.rebuild",
    source: "plots",
    everyMs: 30 * MINUTE,
    priority: 70,
    description:
      "0 requests; re-derives merged plots from stored reports, owners and boundaries",
  },
  {
    kind: "notify.punishments",
    source: "notify",
    everyMs: 5 * MINUTE,
    priority: 40,
    description:
      "0 upstream requests; announces newly discovered bans and deportations",
  },
  {
    kind: "notify.atRisk",
    source: "notify",
    everyMs: 10 * MINUTE,
    priority: 45,
    description:
      "0 upstream requests; announces newly at-risk plots, batched per holder",
  },
  {
    kind: "notify.prune",
    source: "notify",
    // Slower than the others on purpose: the balance backfill qualifies players
    // in bulk, and this is the channel most able to flood a Discord room.
    everyMs: 15 * MINUTE,
    priority: 50,
    description:
      "0 upstream requests; announces newly prunable balances over the alert floor",
  },
  {
    kind: "treasury.resolve.sweep",
    source: "treasury",
    everyMs: 30 * MINUTE,
    priority: 30,
    description: "Queues uuid -> accountId resolution for new stakeholders",
  },
  {
    kind: "treasury.balance.sweep",
    source: "treasury",
    everyMs: 30 * MINUTE,
    priority: 30,
    description: "Queues balance refreshes for stale stakeholder accounts",
  },
  {
    kind: "treasury.prune.sweep",
    source: "treasury",
    // Deliberately far shorter than a batch takes (~70s).
    //
    // This interval is not a rate — dedupe means only one sweep is ever live,
    // so a tick that lands mid-batch does nothing. What it sets is how long the
    // sweep sits idle *after* one finishes. At a one-minute cadence a 70s batch
    // missed the tick that fell inside it and waited for the next, measured as
    // 60.8s of idle per 70s of work: a 54% duty cycle on a job with 55,000
    // players to get through. Fifteen seconds bounds that wait instead.
    //
    // A handler cannot requeue itself to close this: `enqueue` is
    // `onConflictDoNothing` and the dedupe index covers running rows, so an
    // enqueue from inside the sweep collides with the sweep's own live job row
    // and is silently dropped.
    everyMs: 15_000,
    priority: 60,
    description:
      "Prices a batch of dormant players; drains a finite backlog, not a re-crawl",
  },
  {
    kind: "treasury.prune.balance.sweep",
    source: "treasury",
    everyMs: 15 * MINUTE,
    priority: 65,
    description: "Re-reads dormant balances that have gone stale",
  },
];

const lastRun = new Map<string, number>();

/**
 * Enqueue any scheduled job that is due. Called on the worker's tick.
 *
 * Enqueue is idempotent on (kind, dedupeKey) for live rows, so a probe that is
 * still queued from the previous tick is never duplicated.
 */
export async function enqueueDueJobs(now = Date.now()): Promise<string[]> {
  const enqueued: string[] = [];

  for (const entry of SCHEDULE) {
    const previous = lastRun.get(entry.kind) ?? 0;
    if (now - previous < entry.everyMs) continue;

    await enqueue({
      source: entry.source,
      kind: entry.kind,
      dedupeKey: entry.kind,
      priority: entry.priority,
    });
    lastRun.set(entry.kind, now);
    enqueued.push(entry.kind);
  }

  return enqueued;
}

/** Run every probe immediately — used on first boot and by "Sync now". */
export async function enqueueAllProbes(): Promise<string[]> {
  const enqueued: string[] = [];
  for (const entry of SCHEDULE) {
    await enqueue({
      source: entry.source,
      kind: entry.kind,
      dedupeKey: entry.kind,
      priority: entry.priority,
    });
    lastRun.set(entry.kind, Date.now());
    enqueued.push(entry.kind);
  }
  return enqueued;
}
