import { getEnv } from "@/lib/env";
import { withThrottle } from "@/lib/http/throttles";

/**
 * Plan's webserver uses cookie-session auth rather than a bearer token, so the
 * client has to log in once and replay the cookie. `/v1/whoami` reports whether
 * auth is enabled at all, and on this deployment it is
 * (`{"authRequired":true,"loggedIn":false}` when anonymous).
 *
 * Without a valid session the API answers 200 with an HTML login page instead
 * of JSON, so a missing cookie shows up as a schema failure rather than a 401.
 * That makes the explicit check in `analyticsHeaders` worth having.
 */

interface Session {
  cookie: string;
  obtainedAt: number;
}

let session: Session | null = null;
let inFlight: Promise<Session | null> | null = null;

/** Re-login well before a typical servlet session times out. */
const SESSION_TTL_MS = 30 * 60_000;

export class AnalyticsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsAuthError";
  }
}

async function login(): Promise<Session | null> {
  const env = getEnv();
  if (!env.ANALYTICS_USERNAME || !env.ANALYTICS_PASSWORD) return null;

  // The login route sits beside /v1, not under it.
  const origin = env.ANALYTICS_BASE_URL.replace(/\/v1$/, "");
  // Counts against the Analytics budget like any other request. Plan also
  // rate-limits logins itself, answering 403 "too many attempts".
  const response = await withThrottle("analytics", "default", () =>
    fetch(`${origin}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:
        `user=${encodeURIComponent(env.ANALYTICS_USERNAME!)}` +
        `&password=${encodeURIComponent(env.ANALYTICS_PASSWORD!)}`,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    }),
  );

  if (response.status === 403) {
    throw new AnalyticsAuthError(
      "Analytics login rejected: too many attempts, back off before retrying",
    );
  }

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new AnalyticsAuthError(
      `Analytics login returned ${response.status} with no Set-Cookie; check ANALYTICS_USERNAME / ANALYTICS_PASSWORD`,
    );
  }

  return { cookie: setCookie.split(";")[0], obtainedAt: Date.now() };
}

/** Drop the cached session so the next request logs in again. */
export function invalidateAnalyticsSession(): void {
  session = null;
}

/**
 * Header provider for the Analytics API client. Concurrent callers share a
 * single login attempt rather than each racing to authenticate.
 */
export async function analyticsHeaders(): Promise<Record<string, string>> {
  if (session && Date.now() - session.obtainedAt < SESSION_TTL_MS) {
    return { cookie: session.cookie };
  }

  if (!inFlight) {
    inFlight = login().finally(() => {
      inFlight = null;
    });
  }
  session = await inFlight;

  return session ? { cookie: session.cookie } : {};
}

/** True when credentials are configured; the sync worker skips the source otherwise. */
export function analyticsCredentialsConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.ANALYTICS_USERNAME && env.ANALYTICS_PASSWORD);
}
