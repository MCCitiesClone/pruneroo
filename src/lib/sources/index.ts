import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { apiRequests, sourceHealth } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import type { SourceName, TreasuryScope } from "@/lib/http/budgets";
import {
  createApiClient,
  type ApiClient,
  type CircuitState,
  type RequestRecord,
} from "@/lib/http/client";
import { getThrottle, setTreasuryScope } from "@/lib/http/throttles";

import { createAnalyticsClient } from "./analytics/client";
import { analyticsHeaders } from "./analytics/session";
import { createPunishmentsClient } from "./punishments/client";
import { createRealtyClient } from "./realty/client";
import { createTreasuryClient } from "./treasury/client";

/** Fire-and-forget request logging; observability must never fail a sync. */
async function logRequest(record: RequestRecord): Promise<void> {
  await db.insert(apiRequests).values({
    source: record.source,
    method: record.method,
    path: record.path,
    status: record.status,
    durationMs: record.durationMs,
    at: new Date(record.startedAt),
    retries: record.retries,
    rateLimitLimit: record.rateLimitLimit,
    rateLimitRemaining: record.rateLimitRemaining,
    error: record.error,
  });
}

function circuitStore(source: SourceName) {
  return {
    async load(): Promise<CircuitState | null> {
      const [row] = await db
        .select()
        .from(sourceHealth)
        .where(eq(sourceHealth.source, source))
        .limit(1);
      if (!row) return null;
      return {
        consecutiveFailures: row.consecutiveFailures,
        openUntil: row.circuitOpenUntil
          ? row.circuitOpenUntil.getTime()
          : null,
      };
    },
    async save(state: CircuitState): Promise<void> {
      await db
        .insert(sourceHealth)
        .values({
          source,
          consecutiveFailures: state.consecutiveFailures,
          circuitOpenUntil: state.openUntil ? new Date(state.openUntil) : null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: sourceHealth.source,
          set: {
            consecutiveFailures: state.consecutiveFailures,
            circuitOpenUntil: state.openUntil
              ? new Date(state.openUntil)
              : null,
            updatedAt: new Date(),
          },
        });
    },
  };
}

function buildHttp(
  source: SourceName,
  baseUrl: string,
  headers?: ApiClientOptionsHeaders,
): ApiClient {
  return createApiClient({
    source,
    baseUrl,
    // Shared per-source throttle: two clients for one host must never each
    // hold their own bucket and quietly double the real request rate.
    throttle: getThrottle(source),
    headers,
    onRequest: logRequest,
    circuit: circuitStore(source),
  });
}

type ApiClientOptionsHeaders = () =>
  | Record<string, string>
  | Promise<Record<string, string>>;

/**
 * Clients are process-wide singletons because their throttles hold the rate
 * budget. Building a second client for the same source would double the
 * effective request rate, so they are cached on globalThis to survive HMR.
 */
const globalForSources = globalThis as unknown as {
  __prunerooSources?: Sources;
};

export interface Sources {
  realty: ReturnType<typeof createRealtyClient>;
  punishments: ReturnType<typeof createPunishmentsClient>;
  analytics: ReturnType<typeof createAnalyticsClient>;
  /** Null when no Treasury token is configured. */
  treasury: ReturnType<typeof createTreasuryClient> | null;
  http: Record<string, ApiClient>;
}

/**
 * Treasury's budget depends on the token scope, which is only knowable by
 * calling `/auth/me`. Until that resolves, assume PERSONAL — the stricter of
 * the two — so we never over-request while finding out.
 */
let treasuryScope: TreasuryScope = "PERSONAL";

export function getSources(): Sources {
  if (globalForSources.__prunerooSources) {
    return globalForSources.__prunerooSources;
  }
  const env = getEnv();

  const realtyHttp = buildHttp("realty", env.REALTY_BASE_URL);
  const punishmentsHttp = buildHttp("punishments", env.PUNISHMENTS_BASE_URL);
  const analyticsHttp = buildHttp(
    "analytics",
    env.ANALYTICS_BASE_URL,
    analyticsHeaders,
  );

  const treasuryHttp = env.TREASURY_TOKEN
    ? buildHttp("treasury", env.TREASURY_BASE_URL, () => ({
        authorization: `Bearer ${env.TREASURY_TOKEN}`,
      }))
    : null;

  const sources: Sources = {
    realty: createRealtyClient(realtyHttp),
    punishments: createPunishmentsClient(punishmentsHttp),
    analytics: createAnalyticsClient(analyticsHttp),
    treasury: treasuryHttp ? createTreasuryClient(treasuryHttp) : null,
    http: {
      realty: realtyHttp,
      punishments: punishmentsHttp,
      analytics: analyticsHttp,
      ...(treasuryHttp ? { treasury: treasuryHttp } : {}),
    },
  };

  globalForSources.__prunerooSources = sources;
  return sources;
}

/**
 * Called once at worker boot. A BUSINESS key gets 5x the quota, so discovering
 * the scope is worth one request — but the client is rebuilt rather than
 * mutated, since the throttle is constructed from the budget.
 */
export async function resolveTreasuryScope(): Promise<TreasuryScope | null> {
  const sources = getSources();
  if (!sources.treasury) return null;

  const me = await sources.treasury.me();
  const scope: TreasuryScope = me?.keyType === "BUSINESS" ? "BUSINESS" : "PERSONAL";
  if (scope !== treasuryScope) {
    treasuryScope = scope;
    setTreasuryScope(scope);
    globalForSources.__prunerooSources = undefined; // rebuild with the real budget
  }
  return scope;
}
