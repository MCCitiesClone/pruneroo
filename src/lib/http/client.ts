import type { ZodType } from "zod";

import {
  CircuitOpenError,
  HttpError,
  RateLimitError,
  ResponseShapeError,
} from "./errors";
import { systemClock, type Clock, type Throttle } from "./rate-limiter";

export interface RequestRecord {
  source: string;
  method: string;
  path: string;
  /** When the request was issued, not when it completed — see forum/client.ts. */
  startedAt: number;
  status: number | null;
  durationMs: number;
  retries: number;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  error: string | null;
}

export interface CircuitState {
  consecutiveFailures: number;
  openUntil: number | null;
}

export interface ApiClientOptions {
  source: string;
  baseUrl: string;
  throttle: Throttle;
  /** Extra headers per request — a function so tokens can be refreshed. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Persisted observability. Failures here must never break a request. */
  onRequest?: (record: RequestRecord) => void | Promise<void>;
  /** Circuit breaker persistence, so a restart doesn't stampede a sick upstream. */
  circuit?: {
    load: () => Promise<CircuitState | null>;
    save: (state: CircuitState) => Promise<void>;
  };
  clock?: Clock;
  maxRetries?: number;
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long the circuit stays open, in ms. */
  circuitCooldownMs?: number;
  timeoutMs?: number;
}

export interface GetOptions<T> {
  /** Rate-limit bucket to charge this call against. */
  group?: string;
  query?: Record<string, string | number | boolean | string[] | undefined | null>;
  schema?: ZodType<T>;
  /** Return null instead of throwing on these statuses (e.g. 404 = end of pages). */
  tolerate?: number[];
  /** Skip runtime validation and hand back the parsed JSON as-is. */
  raw?: boolean;
}

function buildQuery(
  query: GetOptions<unknown>["query"],
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // Realty takes repeatable params (`type=A&type=B`), not CSV.
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function parseIntHeader(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Full jitter, so a fleet of retries doesn't re-synchronise on the upstream. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(30_000, 500 * 2 ** attempt);
  return Math.random() * ceiling;
}

export interface ApiClient {
  readonly source: string;
  get<T = unknown>(path: string, options?: GetOptions<T>): Promise<T | null>;
  /** Requests issued since construction — for per-run accounting. */
  readonly requestCount: number;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const {
    source,
    baseUrl,
    throttle,
    headers,
    onRequest,
    circuit,
    clock = systemClock,
    maxRetries = 3,
    failureThreshold = 5,
    circuitCooldownMs = 5 * 60_000,
    timeoutMs = 60_000,
  } = options;

  let state: CircuitState = { consecutiveFailures: 0, openUntil: null };
  let loaded = false;
  let requestCount = 0;

  async function ensureCircuitLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    if (!circuit) return;
    try {
      const persisted = await circuit.load();
      if (persisted) state = persisted;
    } catch {
      // Observability must never block real work.
    }
  }

  async function persistCircuit(): Promise<void> {
    if (!circuit) return;
    try {
      await circuit.save(state);
    } catch {
      /* ignore */
    }
  }

  async function recordSuccess(): Promise<void> {
    if (state.consecutiveFailures === 0 && state.openUntil === null) return;
    state = { consecutiveFailures: 0, openUntil: null };
    await persistCircuit();
  }

  async function recordFailure(): Promise<void> {
    const failures = state.consecutiveFailures + 1;
    state = {
      consecutiveFailures: failures,
      openUntil:
        failures >= failureThreshold ? clock.now() + circuitCooldownMs : null,
    };
    await persistCircuit();
  }

  async function log(record: RequestRecord): Promise<void> {
    if (!onRequest) return;
    try {
      await onRequest(record);
    } catch {
      /* ignore */
    }
  }

  async function get<T>(
    path: string,
    opts: GetOptions<T> = {},
  ): Promise<T | null> {
    await ensureCircuitLoaded();

    if (state.openUntil !== null) {
      if (clock.now() < state.openUntil) {
        throw new CircuitOpenError(source, new Date(state.openUntil));
      }
      // Cooldown elapsed — allow one probe through.
      state = { ...state, openUntil: null };
    }

    const group = opts.group ?? "default";
    const url = `${baseUrl}${path}${buildQuery(opts.query)}`;
    const tolerate = new Set(opts.tolerate ?? []);

    let retries = 0;
    for (;;) {
      const release = await throttle.acquire(group);
      const startedAt = clock.now();
      let status: number | null = null;
      let rateLimitLimit: number | null = null;
      let rateLimitRemaining: number | null = null;

      try {
        const extraHeaders = headers ? await headers() : {};
        const response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json", ...extraHeaders },
          signal: AbortSignal.timeout(timeoutMs),
        });

        status = response.status;
        rateLimitLimit = parseIntHeader(response.headers.get("x-ratelimit-limit"));
        rateLimitRemaining = parseIntHeader(
          response.headers.get("x-ratelimit-remaining"),
        );

        // Treasury reports remaining quota on every call. When it runs low,
        // stretch the bucket rather than sprinting into a 429.
        if (
          rateLimitLimit !== null &&
          rateLimitRemaining !== null &&
          rateLimitLimit > 0 &&
          rateLimitRemaining / rateLimitLimit < 0.2
        ) {
          throttle.penalise(group, 5_000);
        }

        if (response.status === 429) {
          const retryAfter = Number.parseInt(
            response.headers.get("retry-after") ?? "",
            10,
          );
          const waitSeconds = Number.isFinite(retryAfter) ? retryAfter : 60;
          const body = await response.text().catch(() => "");
          throttle.penalise(group, waitSeconds * 1000);
          await log({
            source,
            method: "GET",
            path,
            status,
          startedAt,
            durationMs: clock.now() - startedAt,
            retries,
            rateLimitLimit,
            rateLimitRemaining,
            error: "rate limited",
          });
          // A 429 is the server telling us to slow down, not a fault. Surface
          // it so the job requeues without burning a retry attempt.
          throw new RateLimitError("GET", path, body, waitSeconds);
        }

        if (tolerate.has(response.status)) {
          await log({
            source,
            method: "GET",
            path,
            status,
          startedAt,
            durationMs: clock.now() - startedAt,
            retries,
            rateLimitLimit,
            rateLimitRemaining,
            error: null,
          });
          await recordSuccess();
          requestCount += 1;
          return null;
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new HttpError(response.status, "GET", path, body);
        }

        const json: unknown = await response.json();
        requestCount += 1;

        await log({
          source,
          method: "GET",
          path,
          status,
          startedAt,
          durationMs: clock.now() - startedAt,
          retries,
          rateLimitLimit,
          rateLimitRemaining,
          error: null,
        });
        await recordSuccess();

        if (opts.raw || !opts.schema) return json as T;

        const parsed = opts.schema.safeParse(json);
        if (!parsed.success) {
          throw new ResponseShapeError(
            path,
            parsed.error.issues
              .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("\n"),
          );
        }
        return parsed.data;
      } catch (error) {
        // A schema mismatch is our bug, not the upstream's — never retry it and
        // never let it trip the circuit breaker.
        if (error instanceof ResponseShapeError) throw error;
        if (error instanceof RateLimitError) throw error;

        const transient =
          error instanceof HttpError
            ? error.isTransient
            : // Network errors and timeouts arrive as plain Errors.
              true;

        if (!transient || retries >= maxRetries) {
          await log({
            source,
            method: "GET",
            path,
            status,
          startedAt,
            durationMs: clock.now() - startedAt,
            retries,
            rateLimitLimit,
            rateLimitRemaining,
            error: error instanceof Error ? error.message : String(error),
          });
          await recordFailure();
          throw error;
        }

        retries += 1;
        await clock.sleep(backoffMs(retries));
        continue;
      } finally {
        release();
      }
    }
  }

  return {
    source,
    get,
    get requestCount() {
      return requestCount;
    },
  };
}
