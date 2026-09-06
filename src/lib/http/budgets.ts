import type { BucketOptions } from "./rate-limiter";

/**
 * Rate-limit budgets per source.
 *
 * Realty, Analytics and Punishments document no limits whatsoever, so these are
 * self-imposed and deliberately conservative — we are a guest on someone else's
 * game servers. Treasury publishes exact per-endpoint quotas, reproduced below.
 */

export type SourceName =
  | "realty"
  | "analytics"
  | "treasury"
  | "punishments"
  | "forum"
  | "discord";

export interface SourceBudget {
  groups: Record<string, BucketOptions>;
  concurrency: number;
}

/** Leaves headroom for the token owner's own in-game API usage. */
const SAFETY_FACTOR = 0.8;

const scale = (perMinute: number): BucketOptions => ({
  requestsPerMinute: Math.max(1, Math.floor(perMinute * SAFETY_FACTOR)),
});

export const REALTY_BUDGET: SourceBudget = {
  groups: { default: { requestsPerMinute: 60 } },
  concurrency: 2,
};

export const ANALYTICS_BUDGET: SourceBudget = {
  // Payloads here are whole-server dumps with no pagination, so one at a time.
  groups: { default: { requestsPerMinute: 30 } },
  concurrency: 1,
};

export const PUNISHMENTS_BUDGET: SourceBudget = {
  groups: { default: { requestsPerMinute: 60 } },
  concurrency: 2,
};

/**
 * The forum is a public-facing website rather than an API, so it gets the
 * gentlest budget of all. One request every 15 minutes is the entire steady
 * state; the limit exists only to bound a retry storm.
 */
export const FORUM_BUDGET: SourceBudget = {
  groups: { default: { requestsPerMinute: 6 } },
  concurrency: 1,
};

/**
 * Discord webhooks.
 *
 * Discord's documented per-webhook limit is 5 requests per 2 seconds, and it
 * answers a breach with a 429 carrying `retry_after`. This budget sits well
 * under that: a message carries up to 10 embeds, so 30 a minute is 300 items a
 * minute — far more than any realistic burst of new bans — and staying slow
 * means the 429 path is a backstop rather than routine.
 *
 * The 429 handler still honours `retry_after` by penalising this bucket, so a
 * shared webhook being hammered by something else does not turn into a retry
 * storm from here.
 */
export const DISCORD_BUDGET: SourceBudget = {
  groups: { default: { requestsPerMinute: 30 } },
  concurrency: 1,
};

/**
 * Treasury quotas differ by endpoint *and* by token scope. Scope is discovered
 * at boot from `GET /auth/me` -> `keyType`.
 */
export type TreasuryScope = "PERSONAL" | "BUSINESS";

export const TREASURY_GROUPS = {
  balance: { PERSONAL: 120, BUSINESS: 600 },
  feed: { PERSONAL: 120, BUSINESS: 600 },
  transactions: { PERSONAL: 60, BUSINESS: 300 },
  byPlayer: { PERSONAL: 60, BUSINESS: 300 },
  firms: { PERSONAL: 60, BUSINESS: 300 },
  auth: { PERSONAL: 30, BUSINESS: 30 },
  default: { PERSONAL: 60, BUSINESS: 300 },
} as const satisfies Record<string, Record<TreasuryScope, number>>;

export type TreasuryGroup = keyof typeof TREASURY_GROUPS;

export function treasuryBudget(scope: TreasuryScope): SourceBudget {
  const groups: Record<string, BucketOptions> = {};
  for (const [name, limits] of Object.entries(TREASURY_GROUPS)) {
    groups[name] = scale(limits[scope]);
  }
  return { groups, concurrency: 2 };
}
