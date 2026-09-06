/**
 * Coercion helpers for the raw-SQL boundary.
 *
 * `db.execute()` returns driver rows without Drizzle's column mapping, so its
 * generic type parameter is a claim, not a guarantee. In particular Postgres
 * `timestamptz` arrives as a **string**, and `numeric`/`bigint` arrive as
 * strings too (deliberately — they can exceed JS number precision).
 *
 * Every raw query result goes through these rather than being cast, so a
 * mistyped column surfaces as a null instead of a runtime
 * "toISOString is not a function".
 */

export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** For counts and durations, which are safe as JS numbers. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toInt(value: unknown, fallback = 0): number {
  return toNumber(value) ?? fallback;
}

/**
 * Money and other exact decimals stay strings all the way to the formatter —
 * converting to a JS number would silently lose precision on large balances.
 */
export function toDecimalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export function toBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}
