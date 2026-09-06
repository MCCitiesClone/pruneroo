import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getEnv } from "../src/lib/env";
import { withThrottle } from "../src/lib/http/throttles";
import type { SourceName } from "../src/lib/http/budgets";

/**
 * Probes each upstream API once and writes what came back to docs/probes/.
 *
 * The OpenAPI specs leave real gaps — Analytics declares most of its useful
 * responses as untyped `{}`, and Realty's region listing is documented as
 * identity-only. Rather than guess, this script captures live payloads so the
 * zod schemas are written against observed data.
 *
 * Two answers here change the design:
 *   1. Does live GET /v1/regions carry owner/contract fields? If so, the
 *      per-region N+1 detail fetch is unnecessary.
 *   2. What is the exact shape and unit of
 *      online_activity.active_playtime_30d?
 *
 * Every request goes through the same per-source throttle the sync worker uses.
 * A diagnostic must never be the one thing that hammers an upstream.
 */

const OUT_DIR = join(process.cwd(), "docs/probes");

interface ProbeResult {
  name: string;
  url: string;
  status: number | null;
  ok: boolean;
  note?: string;
  error?: string;
  body?: unknown;
}

const results: ProbeResult[] = [];

async function probe(
  name: string,
  url: string,
  init?: RequestInit,
): Promise<unknown | null> {
  process.stdout.write(`  ${name} ... `);
  // Diagnostics count against the same budgets as the sync worker — a probe run
  // must not be the one thing that hammers an upstream.
  const source = name.split(".")[0] as SourceName;
  try {
    const response = await withThrottle(source, "default", () =>
      fetch(url, {
        ...init,
        headers: { accept: "application/json", ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(30_000),
      }),
    );
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }
    results.push({
      name,
      url,
      status: response.status,
      ok: response.ok,
      body,
    });
    console.log(response.ok ? `${response.status} ok` : `${response.status}`);
    return response.ok ? body : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, url, status: null, ok: false, error: message });
    console.log(`FAILED (${message})`);
    return null;
  }
}

/** Keeps captured payloads small: arrays are truncated to a few samples. */
function sample(value: unknown, limit = 3): unknown {
  if (Array.isArray(value)) {
    return {
      __arrayLength: value.length,
      __sample: value.slice(0, limit).map((v) => sample(v, limit)),
    };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sample(v, limit);
    return out;
  }
  return value;
}

async function main() {
  const env = getEnv();
  mkdirSync(OUT_DIR, { recursive: true });

  const findings: string[] = [];

  // -- Realty ---------------------------------------------------------------
  console.log("\nRealty");
  await probe("realty.health", `${env.REALTY_BASE_URL}/health`);
  await probe("realty.worlds", `${env.REALTY_BASE_URL}/worlds`);
  const stats = await probe("realty.stats", `${env.REALTY_BASE_URL}/stats`);
  const regions = await probe(
    "realty.regions",
    `${env.REALTY_BASE_URL}/regions?page=1&pageSize=3`,
  );

  // THE question: does the bulk listing carry owner data, or only identity?
  const firstRegion = (regions as { regions?: unknown[] } | null)?.regions?.[0];
  if (firstRegion && typeof firstRegion === "object") {
    const keys = Object.keys(firstRegion).sort();
    const ownerish = keys.filter((k) =>
      /title|owner|holder|landlord|tenant|price|lease/i.test(k),
    );
    findings.push(
      `Realty /regions entry keys: ${keys.join(", ")}\n` +
        (ownerish.length
          ? `  -> Owner/contract fields ARE present (${ownerish.join(", ")}). ` +
            `The per-region detail fetch can be skipped.`
          : `  -> Identity-only, as the spec says. Per-region /v1/region ` +
            `detail fetch IS required.`),
    );

    // If identity-only, confirm what /v1/region adds for one region.
    if (!ownerish.length) {
      const r = firstRegion as { worldGuardRegionId?: string; world?: { id?: string } };
      if (r.worldGuardRegionId && r.world?.id) {
        const detail = await probe(
          "realty.region.detail",
          `${env.REALTY_BASE_URL}/region?world=${encodeURIComponent(r.world.id)}&region=${encodeURIComponent(r.worldGuardRegionId)}`,
        );
        if (detail && typeof detail === "object") {
          findings.push(
            `Realty /region detail keys: ${Object.keys(detail).sort().join(", ")}`,
          );
        }
      }
    }
  }
  if (stats && typeof stats === "object" && "regions" in stats) {
    findings.push(
      `Realty /stats.regions = ${(stats as { regions: unknown }).regions} ` +
        `(the cheap change probe gating region re-indexing)`,
    );
  }

  // -- Punishments ----------------------------------------------------------
  console.log("\nPunishments");
  const muteCount = await probe(
    "punishments.stats.mute",
    `${env.PUNISHMENTS_BASE_URL}/stats/mute`,
  );
  await probe("punishments.stats.ban", `${env.PUNISHMENTS_BASE_URL}/stats/ban`);
  const mutePage = await probe(
    "punishments.mute.page1",
    `${env.PUNISHMENTS_BASE_URL}/punishments/mute/1`,
  );

  if (mutePage && typeof mutePage === "object") {
    const page = mutePage as {
      page?: number;
      totalPages?: number;
      punishments?: Array<{ id?: number; startTime?: number; reason?: string }>;
    };
    const items = page.punishments ?? [];
    const pageSize = items.length;
    const first = items[0];
    const last = items[items.length - 1];
    const newestFirst =
      first?.startTime !== undefined && last?.startTime !== undefined
        ? first.startTime > last.startTime
        : undefined;
    findings.push(
      `Punishments page size = ${pageSize}, totalPages = ${page.totalPages}, ` +
        `count = ${JSON.stringify(muteCount)}\n` +
        `  -> ordering newest-first: ${newestFirst ?? "indeterminate"}`,
    );
    const deportations = items.filter((p) =>
      /deportation/i.test(p.reason ?? ""),
    );
    findings.push(
      `Deportation-matching mutes on page 1: ${deportations.length}/${pageSize}` +
        (deportations[0] ? ` e.g. "${deportations[0].reason}"` : ""),
    );
  }

  // -- Analytics ------------------------------------------------------------
  console.log("\nAnalytics");
  const cookie = await analyticsLogin(env);
  const authHeaders: Record<string, string> = cookie ? { cookie } : {};

  await probe("analytics.whoami", `${env.ANALYTICS_BASE_URL}/whoami`, {
    headers: authHeaders,
  });
  const table = await probe(
    "analytics.playersTable",
    `${env.ANALYTICS_BASE_URL}/playersTable`,
    { headers: authHeaders },
  );

  let probeUuid: string | undefined;
  const players = (table as { players?: Array<Record<string, unknown>> } | null)
    ?.players;
  if (players?.length) {
    probeUuid = players[0].playerUUID as string | undefined;
    findings.push(
      `Analytics /playersTable: ${players.length} players; ` +
        `entry keys: ${Object.keys(players[0]).sort().join(", ")}`,
    );
  }

  if (probeUuid) {
    const player = await probe(
      "analytics.player",
      `${env.ANALYTICS_BASE_URL}/player?player=${encodeURIComponent(probeUuid)}`,
      { headers: authHeaders },
    );
    if (player && typeof player === "object") {
      const p = player as Record<string, unknown>;
      findings.push(
        `Analytics /player top-level keys: ${Object.keys(p).sort().join(", ")}`,
      );
      const oa = p.online_activity;
      if (oa && typeof oa === "object") {
        const entries = Object.entries(oa as Record<string, unknown>);
        findings.push(
          `Analytics online_activity keys: ${entries.map(([k]) => k).sort().join(", ")}`,
        );
        const target = entries.find(([k]) => k === "active_playtime_30d");
        findings.push(
          target
            ? `  -> active_playtime_30d = ${JSON.stringify(target[1])} ` +
                `(type: ${typeof target[1]}) — CONFIRM THE UNIT against a known player`
            : `  -> active_playtime_30d NOT FOUND. Available: ` +
                entries.map(([k]) => k).join(", "),
        );
      } else {
        findings.push(
          `  -> no "online_activity" key on /v1/player. Keys: ${Object.keys(p).join(", ")}`,
        );
      }
    }
  }

  // -- Treasury -------------------------------------------------------------
  console.log("\nTreasury");
  if (!env.TREASURY_TOKEN) {
    console.log("  skipped — TREASURY_TOKEN not set");
    findings.push("Treasury: skipped, no TREASURY_TOKEN configured.");
  } else {
    const treasuryHeaders = {
      authorization: `Bearer ${env.TREASURY_TOKEN}`,
    };
    const me = await probe("treasury.auth.me", `${env.TREASURY_BASE_URL}/auth/me`, {
      headers: treasuryHeaders,
    });
    if (me && typeof me === "object") {
      const keyType = (me as { keyType?: string }).keyType;
      findings.push(
        `Treasury keyType = ${keyType ?? "unknown"} ` +
          `-> ${keyType === "BUSINESS" ? "300" : "60"} rpm on /accounts/by-player`,
      );
    }
    if (probeUuid) {
      await probe(
        "treasury.accounts.byPlayer",
        `${env.TREASURY_BASE_URL}/accounts/by-player?uuid=${encodeURIComponent(probeUuid)}`,
        { headers: treasuryHeaders },
      );
    }
  }

  // -- Output ---------------------------------------------------------------
  for (const result of results) {
    const file = join(OUT_DIR, `${result.name}.json`);
    writeFileSync(
      file,
      JSON.stringify({ ...result, body: sample(result.body) }, null, 2),
    );
  }

  console.log(`\n${"=".repeat(70)}\nFINDINGS\n${"=".repeat(70)}`);
  for (const finding of findings) console.log(`\n${finding}`);
  console.log(`\nRaw captures written to ${OUT_DIR}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\n${failed.length} probe(s) failed:`);
    for (const f of failed) {
      console.log(`  ${f.name}: ${f.error ?? `HTTP ${f.status}`}`);
    }
  }
}

/** Plan's webserver uses cookie-session auth, and may have auth disabled. */
async function analyticsLogin(
  env: ReturnType<typeof getEnv>,
): Promise<string | null> {
  if (!env.ANALYTICS_USERNAME || !env.ANALYTICS_PASSWORD) {
    console.log("  (no analytics credentials set — trying unauthenticated)");
    return null;
  }
  try {
    const response = await withThrottle("analytics", "default", () =>
      fetch(`${env.ANALYTICS_BASE_URL.replace(/\/v1$/, "")}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `user=${encodeURIComponent(env.ANALYTICS_USERNAME!)}&password=${encodeURIComponent(env.ANALYTICS_PASSWORD!)}`,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      }),
    );
    const setCookie = response.headers.get("set-cookie");
    console.log(`  login ... ${response.status}${setCookie ? " (cookie set)" : ""}`);
    return setCookie ? setCookie.split(";")[0] : null;
  } catch (error) {
    console.log(
      `  login ... FAILED (${error instanceof Error ? error.message : error})`,
    );
    return null;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
