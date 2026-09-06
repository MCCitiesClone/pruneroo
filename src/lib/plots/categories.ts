/**
 * Plot zoning, towns, and the ownership limits attached to them.
 *
 * **Zoning comes from the plot's tags**, which Realty publishes per region —
 * not from the id prefix. Tags are the server's own classification and are more
 * accurate in two ways the prefix cannot express:
 *
 *  - `wl-f*` plots are tagged `farmland`, and PSA §12 confirms `Wl-F` is
 *    farmland — which carries a limit of 1. Reading `wl` as its own zoning
 *    missed that limit on 113 plots.
 *  - A plot tagged `farmland` **and** `residential` is a ranch, not farmland,
 *    and counts against §17(6)'s separate limit of 1. Tags have to be read as a
 *    set, not one at a time.
 *  - Town and zoning are **orthogonal**. 90 Oakridge plots are tagged
 *    `commercial`; the id prefix `or-` says only where the plot is, not what it
 *    is zoned for.
 *
 * Limits come from the Property Standards Act §17 (docs/policy/):
 *
 *   §17(1) C  — no more than 20 commercial
 *   §17(2) R  — no more than 2 residential
 *   §17(3) I  — no more than 2 industrial
 *   §17(4) S  — no more than 6 skyscraper
 *   §17(5) BM — no more than 1 black market (owned or rented)
 *   §17(6) FR — no more than 1 ranch
 *   §17(7) Farmland — no more than 1 (owned or rented)
 *   §17(8) Government Subsidised Commercial Spaces — 2 of *each* type,
 *          counting cbd, nbd and wbd separately
 *   §17(9) Realtors may exceed by 5 each, excluding BM, ranch and Government
 *          Subsidised spaces, for plots resold within 30 days
 *   §17(10) Plots inside a town are exempt; each town sets its own limits
 */

export type PlotCategory =
  | "commercial"
  | "residential"
  | "industrial"
  | "skyscraper"
  | "cbd"
  | "nbd"
  | "wbd"
  | "farmland"
  | "ranch"
  | "black-market"
  | "other";

/**
 * Areas that change how the ownership limits apply.
 *
 * Oakridge and Aventura are towns: PSA §17(10) exempts *every* plot inside a
 * town, because each town sets its own limits in a thread this app does not
 * read. Willow is **not** a town — only its commercial plots are excluded from
 * the commercial limit, while Willow farmland still counts against the farmland
 * limit of 1.
 */
export type PlotArea = "oakridge" | "aventura" | "willow" | null;

export interface CategoryDefinition {
  category: PlotCategory;
  label: string;
  /** Maximum a citizen may hold, or null when this app cannot say. */
  limit: number | null;
  /** Whether §17(9)'s realtor allowance of +5 applies. */
  realtorBonus: boolean;
  note: string;
}

export const DEFINITIONS: Record<PlotCategory, CategoryDefinition> = {
  commercial: {
    category: "commercial",
    label: "Commercial",
    limit: 20,
    realtorBonus: true,
    note: "PSA §17(1): 20 commercial, +5 for realtors reselling within 30 days.",
  },
  residential: {
    category: "residential",
    label: "Residential",
    limit: 2,
    realtorBonus: true,
    note: "PSA §17(2): 2 residential, +5 for realtors reselling within 30 days.",
  },
  industrial: {
    category: "industrial",
    label: "Industrial",
    limit: 2,
    realtorBonus: true,
    note: "PSA §17(3): 2 industrial, +5 for realtors reselling within 30 days.",
  },
  skyscraper: {
    category: "skyscraper",
    label: "Skyscraper",
    limit: 6,
    realtorBonus: true,
    note: "PSA §17(4): 6 skyscraper, +5 for realtors reselling within 30 days.",
  },
  cbd: {
    category: "cbd",
    label: "Central Business District",
    limit: 2,
    realtorBonus: false,
    note: "PSA §17(8): 2 of each Government Subsidised Commercial Space; no realtor allowance.",
  },
  nbd: {
    category: "nbd",
    label: "North Business District",
    limit: 2,
    realtorBonus: false,
    note: "PSA §17(8): 2 of each Government Subsidised Commercial Space; no realtor allowance.",
  },
  wbd: {
    category: "wbd",
    label: "Willow Business District",
    limit: 2,
    realtorBonus: false,
    note: "PSA §17(8): 2 of each Government Subsidised Commercial Space; no realtor allowance.",
  },
  farmland: {
    category: "farmland",
    label: "Farmland",
    limit: 1,
    realtorBonus: false,
    note: "PSA §17(7): 1 farmland property, owned or rented; no realtor allowance.",
  },
  ranch: {
    category: "ranch",
    label: "Ranch",
    limit: 1,
    realtorBonus: false,
    note: "PSA §17(6): 1 ranch property; no realtor allowance.",
  },
  "black-market": {
    category: "black-market",
    label: "Black Market",
    limit: 1,
    realtorBonus: false,
    note: "PSA §17(5): 1 black market property, owned or rented; no realtor allowance.",
  },
  other: {
    category: "other",
    label: "Other",
    limit: null,
    realtorBonus: false,
    note: "No zoning tag. Mostly apartments, shops and other sub-regions, which the PSA does not limit by count.",
  },
};

/**
 * Tag *combinations* that mean something other than their parts.
 *
 * A plot tagged both `farmland` and `residential` is a **ranch** — a distinct
 * zoning with its own limit of 1 under §17(6), separate from farmland's 1 under
 * §17(7). Read as single tags the pair looks like farmland (or residential,
 * depending on order) and the two limits collapse into one.
 *
 * Checked before the single-tag list, and corroborated by the ids: all 18 plots
 * carrying the pair are `fr*`, the ranch prefix, while the 113 genuine farmland
 * plots are tagged `farmland` + `willow`.
 */
const COMBINATION_TAGS: Array<{ tags: string[]; category: PlotCategory }> = [
  { tags: ["farmland", "residential"], category: "ranch" },
];

/**
 * Zoning tags, most specific first.
 *
 * A plot can carry several tags (`oakridge` + `commercial`, or `shop` +
 * `commercial`); the first match here wins, so a real zoning tag beats a
 * use-type tag like `apartment`.
 */
const ZONING_TAGS: Array<[string, PlotCategory]> = [
  ["cbd", "cbd"],
  ["nbd", "nbd"],
  ["wbd", "wbd"],
  ["blackmarket", "black-market"],
  ["black-market", "black-market"],
  ["skyscraper", "skyscraper"],
  ["farmland", "farmland"],
  ["ranch", "ranch"],
  ["industrial", "industrial"],
  ["residential", "residential"],
  ["commercial", "commercial"],
];

const AREA_TAGS: Array<[string, NonNullable<PlotArea>]> = [
  ["oakridge", "oakridge"],
  ["aventura", "aventura"],
  ["willow", "willow"],
];

/** `wl-` ids are Willow even when the plot carries no `willow` tag. */
const AREA_PREFIXES: Array<[string, NonNullable<PlotArea>]> = [
  ["wl", "willow"],
  ["or", "oakridge"],
  ["av", "aventura"],
];

/**
 * Fallback prefixes, used **only** when a plot carries no zoning tag at all.
 *
 * Deliberately minimal. 5,354 untagged plots are sub-regions (`supermarket-1`,
 * `apts-3`) that the PSA does not limit by count, and guessing zoning for them
 * would invent violations. These few prefixes exist because the tag vocabulary
 * has no equivalent: black-market and WBD plots carry no tag at all, yet both
 * are limited to 1 and 2 respectively.
 */
const FALLBACK_PREFIXES: Array<[string, PlotCategory]> = [
  ["cbd", "cbd"],
  ["nbd", "nbd"],
  ["wbd", "wbd"],
  ["bm", "black-market"],
  ["fr", "ranch"],
];

export interface Classification {
  category: PlotCategory;
  area: PlotArea;
  /** Where the zoning came from — surfaced so a fallback is never mistaken for fact. */
  source: "tag" | "prefix" | "none";
}

export function classifyPlot(
  wgRegionId: string,
  tags: readonly string[] | null | undefined,
): Classification {
  const normalized = (tags ?? []).map((t) => t.trim().toLowerCase());

  const id = wgRegionId.trim().toLowerCase();
  const startsWith = (prefix: string) => {
    const next = id.charAt(prefix.length);
    return id.startsWith(prefix) && (next === "-" || (next >= "0" && next <= "9"));
  };

  const area =
    AREA_TAGS.find(([tag]) => normalized.includes(tag))?.[1] ??
    AREA_PREFIXES.find(([prefix]) => startsWith(prefix))?.[1] ??
    null;

  const combined = COMBINATION_TAGS.find((rule) =>
    rule.tags.every((tag) => normalized.includes(tag)),
  );
  if (combined) return { category: combined.category, area, source: "tag" };

  const tagged = ZONING_TAGS.find(([tag]) => normalized.includes(tag))?.[1];
  if (tagged) return { category: tagged, area, source: "tag" };

  for (const [prefix, category] of FALLBACK_PREFIXES) {
    if (startsWith(prefix)) return { category, area, source: "prefix" };
  }

  return { category: "other", area, source: "none" };
}

export function categoryDefinition(category: string): CategoryDefinition {
  return DEFINITIONS[category as PlotCategory] ?? DEFINITIONS.other;
}

/** §17(9)'s realtor allowance. */
export const REALTOR_BONUS = 5;

export function effectiveLimit(
  definition: CategoryDefinition,
  isRealtor: boolean,
): number | null {
  if (definition.limit === null) return null;
  return (
    definition.limit + (isRealtor && definition.realtorBonus ? REALTOR_BONUS : 0)
  );
}

/**
 * Whether the standard limits bite for a plot, given where it is and how it is
 * zoned.
 *
 * The exemption is not uniform, so it takes both axes:
 *
 *  - **Towns** (Oakridge, Aventura) — every plot is exempt under §17(10).
 *  - **Willow** — only *commercial* plots are excluded from the commercial
 *    limit. Willow farmland is still farmland and still counts against the
 *    limit of 1, which matters because 113 plots are tagged that way.
 */
export function limitApplies(area: PlotArea, category: PlotCategory): boolean {
  if (area === "oakridge" || area === "aventura") return false;
  if (area === "willow") return category !== "commercial";
  return true;
}

/** Areas exempt from every limit, as opposed to Willow's partial exemption. */
export const TOWNS: ReadonlyArray<NonNullable<PlotArea>> = [
  "oakridge",
  "aventura",
];

export const AREA_LABELS: Record<NonNullable<PlotArea>, string> = {
  oakridge: "Oakridge",
  aventura: "Aventura",
  willow: "Willow",
};
