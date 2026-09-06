/**
 * Plan reports durations either as a raw millisecond number or as a
 * pre-formatted human string, depending on the endpoint and the server's
 * display settings. Neither is documented, so both are handled and the raw
 * payload is always stored alongside the parsed value.
 */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  // Calendar-approximate; only ever used for display-string fallbacks.
  mo: 2_592_000_000,
  month: 2_592_000_000,
  months: 2_592_000_000,
  y: 31_536_000_000,
  year: 31_536_000_000,
  years: 31_536_000_000,
};

/**
 * Parse a Plan duration into milliseconds.
 *
 * Returns null rather than 0 when the value cannot be interpreted — the
 * difference between "no playtime" and "we don't know" is load-bearing for the
 * inactivity insight and must never be silently collapsed.
 */
export function parseDurationMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  // A bare numeric string is already milliseconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  // "1 month, 2 days, 3 hours" / "5h 12m" / "3d4h"
  const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g)];
  if (matches.length === 0) return null;

  let total = 0;
  let matched = false;
  for (const [, amount, rawUnit] of matches) {
    const unit = UNIT_MS[rawUnit.toLowerCase()];
    if (unit === undefined) continue;
    total += Number(amount) * unit;
    matched = true;
  }
  return matched ? total : null;
}

export const HOUR_MS = 3_600_000;

export function msToHours(ms: number): number {
  return ms / HOUR_MS;
}
