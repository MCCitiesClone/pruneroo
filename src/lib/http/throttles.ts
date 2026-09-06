import {
  ANALYTICS_BUDGET,
  DISCORD_BUDGET,
  FORUM_BUDGET,
  PUNISHMENTS_BUDGET,
  REALTY_BUDGET,
  treasuryBudget,
  type SourceBudget,
  type SourceName,
  type TreasuryScope,
} from "./budgets";
import { Throttle } from "./rate-limiter";

/**
 * The single place outbound rate limiting is held.
 *
 * Every client that talks to a third party must take a token from here — the
 * typed API clients, the Analytics login POST, the forum listing scraper and
 * the probe script alike. Rate limiting is a correctness requirement in this
 * project, not a nicety: three of the five upstreams publish no limits at all
 * and we are a guest on someone else's servers.
 *
 * A registry rather than per-client throttles because the budget belongs to the
 * *host*, not to whichever module happens to call it. Two clients for one
 * source with their own buckets would quietly double the real request rate,
 * which is exactly the bug this replaced: the Analytics session login used a
 * bare `fetch`, outside the throttle its own API client respected.
 */

const DEFAULT_BUDGETS: Record<SourceName, SourceBudget> = {
  realty: REALTY_BUDGET,
  analytics: ANALYTICS_BUDGET,
  punishments: PUNISHMENTS_BUDGET,
  forum: FORUM_BUDGET,
  discord: DISCORD_BUDGET,
  // Replaced once `/auth/me` reveals the token scope; PERSONAL is the stricter
  // of the two, so assuming it cannot over-request while we find out.
  treasury: treasuryBudget("PERSONAL"),
};

const globalForThrottles = globalThis as unknown as {
  __prunerooThrottles?: Map<SourceName, Throttle>;
};

function registry(): Map<SourceName, Throttle> {
  globalForThrottles.__prunerooThrottles ??= new Map();
  return globalForThrottles.__prunerooThrottles;
}

export function getThrottle(source: SourceName): Throttle {
  const throttles = registry();
  let throttle = throttles.get(source);
  if (!throttle) {
    const budget = DEFAULT_BUDGETS[source];
    throttle = new Throttle(budget.groups, budget.concurrency);
    throttles.set(source, throttle);
  }
  return throttle;
}

/**
 * Swap in the real Treasury budget once the token scope is known. A BUSINESS
 * key gets five times the quota, but the throttle is built from the budget, so
 * it has to be rebuilt rather than adjusted.
 */
export function setTreasuryScope(scope: TreasuryScope): void {
  DEFAULT_BUDGETS.treasury = treasuryBudget(scope);
  registry().delete("treasury");
}

/**
 * Run `work` holding a token for `source`. For clients that cannot use the
 * standard API client — different auth, HTML instead of JSON — but must still
 * respect the budget.
 */
export async function withThrottle<T>(
  source: SourceName,
  group: string,
  work: () => Promise<T>,
): Promise<T> {
  const release = await getThrottle(source).acquire(group);
  try {
    return await work();
  } finally {
    release();
  }
}
