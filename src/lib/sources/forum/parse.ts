/**
 * Turning an eviction-report thread title into structured state.
 *
 * Both functions here are pure and heavily tested, because they are the part of
 * this feature that decides whether a property disappears from review. Getting
 * them wrong silently hides work.
 */

/** `[Pending] Foo`, `Pending: Foo`, `Pending - Foo`, or plain `Pending Foo`. */
const BRACKETED = /^\s*[[(]\s*([^\])]{1,32}?)\s*[\])]\s*([\s\S]*)$/;
const DELIMITED = /^\s*([A-Za-z][A-Za-z /-]{0,31}?)\s*[:—–|]\s*([\s\S]*)$/;

export interface TitleParts {
  /** Lower-cased prefix, or null when the title carries none. */
  prefix: string | null;
  /** The title with any prefix removed. */
  rest: string;
}

/**
 * Split a leading thread prefix off a title.
 *
 * XenForo renders prefixes into the RSS title with no machine-readable marker,
 * so the shape has to be recognised from the text. Only bracketed and
 * explicitly delimited forms are treated as prefixes: a bare leading word is
 * far more likely to be part of the subject ("Eviction Report c176") than a
 * status, and misreading it would drop a real report.
 */
export function splitTitlePrefix(title: string): TitleParts {
  const bracketed = BRACKETED.exec(title);
  if (bracketed) {
    return { prefix: bracketed[1].trim().toLowerCase(), rest: bracketed[2].trim() };
  }
  const delimited = DELIMITED.exec(title);
  if (delimited) {
    return { prefix: delimited[1].trim().toLowerCase(), rest: delimited[2].trim() };
  }
  return { prefix: null, rest: title.trim() };
}

/**
 * A report is active unless its prefix says otherwise.
 *
 * Defaulting an *unrecognised* prefix to active is deliberate: an unknown word
 * is more likely a new "in progress" state than a new "finished" one, and
 * treating it as finished would put a property back into review while it is
 * still being handled. The opposite error is visible — the region simply shows
 * as suppressed, with the report linked — so it is the safer direction.
 */
export function isReportActive(
  prefix: string | null,
  resolvedPrefixes: readonly string[],
): boolean {
  if (!prefix) return true;
  const normalized = prefix.trim().toLowerCase();
  return !resolvedPrefixes.some(
    (resolved) =>
      normalized === resolved ||
      // Tolerates "resolved - accepted" and similar compound prefixes.
      normalized.split(/[\s/-]+/).includes(resolved),
  );
}

/**
 * Characters that separate region ids from surrounding text. Hyphens are
 * absent on purpose — plenty of real ids contain them (`av-c031`,
 * `432office-1`).
 */
const TOKEN_SPLIT = /[^A-Za-z0-9_-]+/;

/** Bare integers are never matched — see `extractRegionIds`. */
const PURE_DIGITS = /^\d+$/;

/** Leading letters of an id like `av-c031` → `av-c`, used for slash shorthand. */
const ALPHA_PREFIX = /^(.*?[A-Za-z-]+)(\d+)$/;

export interface RegionMatch {
  /** Lower-cased match key; resolve to a stored id before writing it. */
  wgRegionId: string;
  /** How the id was recovered, for auditing a surprising match. */
  via: "exact" | "slash-shorthand";
}

/**
 * Find every known region id named in a title.
 *
 * Matching is done against the **set of ids that actually exist**, rather than
 * by guessing a format. Region ids come in at least four shapes (`c176`, `1a`,
 * `av-c031`, `432office-1`) and are globally unique across worlds, so a
 * successful match is unambiguous and a malformed guess simply fails to match.
 *
 * Two behaviours worth knowing:
 *
 *  - **Bare integers are ignored.** Only two regions are named `1` and `3`,
 *    while titles are full of years, counts and thread numbers. Matching them
 *    would produce far more noise than signal.
 *  - **Slash shorthand is expanded.** `c176/c177` matches directly, and
 *    `c176/177` also resolves, because the alphabetic prefix of the preceding
 *    id is borrowed. That can only ever produce an id that already exists, so
 *    it cannot invent a region.
 */
export function extractRegionIds(
  title: string,
  knownRegionIds: ReadonlySet<string>,
): RegionMatch[] {
  const found = new Map<string, RegionMatch>();
  const tokens = title.split(TOKEN_SPLIT).filter(Boolean);

  let lastAlphaPrefix: string | null = null;

  for (const rawToken of tokens) {
    const token = rawToken.toLowerCase();

    if (knownRegionIds.has(token) && !PURE_DIGITS.test(token)) {
      if (!found.has(token)) found.set(token, { wgRegionId: token, via: "exact" });
      lastAlphaPrefix = ALPHA_PREFIX.exec(token)?.[1] ?? null;
      continue;
    }

    // `c176/177`: reuse the previous id's alphabetic prefix.
    if (PURE_DIGITS.test(token) && lastAlphaPrefix) {
      const candidate = `${lastAlphaPrefix}${token}`;
      if (knownRegionIds.has(candidate) && !found.has(candidate)) {
        found.set(candidate, {
          wgRegionId: candidate,
          via: "slash-shorthand",
        });
      }
    }
  }

  return [...found.values()];
}

/**
 * The eviction date carried in every real report title.
 *
 * Live titles are uniformly `<regions> | <Mon DD, YYYY>` — for example
 * `c176/c177 | Sep 10, 2026`. Not one of the 100 reports in the feed carries a
 * thread prefix, so this date is the only per-report state the feed actually
 * exposes, and it is what tells a scheduled eviction apart from one whose day
 * has already passed.
 */
const EVICTION_DATE =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parsed as UTC midnight; the forum states a day, not an instant. */
export function extractEvictionDate(title: string): Date | null {
  const match = EVICTION_DATE.exec(title);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month, day));
  return Number.isNaN(date.getTime()) ? null : date;
}
