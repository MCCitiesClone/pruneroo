import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { toBool, toInt, toText } from "@/lib/db/coerce";
import {
  AREA_LABELS,
  categoryDefinition,
  REALTOR_BONUS,
  type PlotArea,
  type PlotCategory,
} from "@/lib/plots/categories";
import { plotLimitCte } from "@/lib/plots/limits-sql";

/**
 * Plot-limit enforcement, for the Evictions Policy's plot-limit reports.
 *
 * Since the 2026-09-04 policy the breach splits by tenure when it is *filed*:
 * "Exceeding legal plot limits for freehold plots" is **Plot Fairness** (3-day
 * resolve), while the same breach on a leasehold is **Rental Limitations**,
 * which evicts on the date filed. Which one applies is a property of the plot,
 * not of the holder, so it is decided in `report-kit.ts` per plot rather than
 * here — one holder can be over a single limit and owe a report of each kind.
 *
 * The counting is deliberately *not* split. §17(5) and §17(7) cap what a player
 * holds "owned or rented", so a freehold and a leasehold plot in the same
 * category still count against one limit; only the filing differs.
 *
 * The counting itself lives in `plots/limits-sql.ts`, shared with the at-risk
 * property table so the summary and the rows it summarises cannot disagree.
 * This module is the presentation layer over it.
 *
 * Counting follows PSA §18(1): merged plots count as their **individual
 * sub-plots** for ownership limits, not as one property. That falls out of
 * counting regions directly.
 *
 * Limits are counted **across every world**, deliberately ignoring the at-risk
 * page's world filter: §17 caps what a player holds in total, so narrowing the
 * view must not make a holder look compliant.
 */

export interface CategoryHolding {
  category: PlotCategory;
  label: string;
  /** Plots that count towards the limit. */
  count: number;
  /** Plots excluded by an area exemption, shown as context. */
  exemptCount: number;
  exemptAreas: PlotArea[];
  limit: number | null;
  /** Ceiling once §17(9)'s realtor allowance is applied, when it can apply. */
  realtorLimit: number | null;
  /** Over the ceiling that applies to this holder, given what we know. */
  overLimit: boolean;
  /** Over the plain limit and beyond any realtor allowance. */
  isViolation: boolean;
  /** Over the plain limit but within an unconfirmed realtor allowance. */
  needsRealtorCheck: boolean;
  note: string;
}

export interface HolderLimits {
  playerUuid: string;
  playerName: string | null;
  isBanned: boolean;
  isDeported: boolean;
  isExcluded: boolean;
  /** Confirmed in game with `/about` and marked on the player page. */
  isRealtor: boolean;
  totalPlots: number;
  categories: CategoryHolding[];
  violations: number;
  checks: number;
}

interface BreachRow extends Record<string, unknown> {
  player_uuid: string;
  player_name: string | null;
  category: string;
  counted_plots: number;
  exempt_plots: number;
  exempt_areas: string[] | null;
  plot_limit: number | null;
  realtor_limit: number | null;
  is_realtor: boolean;
  over_limit: boolean;
  is_violation: boolean;
  needs_realtor_check: boolean;
  is_banned: boolean;
  is_deported: boolean;
  is_excluded: boolean;
}

async function loadBreaches(playerUuid?: string): Promise<BreachRow[]> {
  const playerFilter = playerUuid
    ? sql`WHERE b.player_uuid = ${playerUuid}::uuid`
    : sql``;

  const result = await db.execute<BreachRow>(sql`
    WITH ${plotLimitCte()}
    SELECT b.player_uuid, p.name AS player_name, b.category,
           b.counted_plots, b.exempt_plots, b.exempt_areas,
           b.plot_limit, b.realtor_limit, b.is_realtor,
           b.over_limit, b.is_violation, b.needs_realtor_check,
           COALESCE(f.is_banned, false)   AS is_banned,
           COALESCE(f.is_deported, false) AS is_deported,
           (ex.player_uuid IS NOT NULL)   AS is_excluded
      FROM plot_limit_breaches b
      LEFT JOIN players p            ON p.uuid = b.player_uuid
      LEFT JOIN v_player_flags f     ON f.player_uuid = b.player_uuid
      LEFT JOIN player_exclusions ex ON ex.player_uuid = b.player_uuid
      ${playerFilter}
  `);
  return result.rows;
}

function buildHolding(row: BreachRow): CategoryHolding {
  const definition = categoryDefinition(row.category);
  return {
    category: definition.category,
    label: definition.label,
    count: toInt(row.counted_plots),
    exemptCount: toInt(row.exempt_plots),
    exemptAreas: (row.exempt_areas ?? []) as PlotArea[],
    limit: row.plot_limit === null ? null : toInt(row.plot_limit),
    realtorLimit:
      definition.realtorBonus && row.realtor_limit !== null
        ? toInt(row.realtor_limit)
        : null,
    overLimit: toBool(row.over_limit),
    isViolation: toBool(row.is_violation),
    needsRealtorCheck: toBool(row.needs_realtor_check),
    note: definition.note,
  };
}

function buildHolder(rows: BreachRow[]): HolderLimits {
  const first = rows[0];
  const categories = rows.map(buildHolding);
  categories.sort((a, b) => b.count + b.exemptCount - (a.count + a.exemptCount));

  return {
    playerUuid: String(first.player_uuid),
    playerName: toText(first.player_name),
    isBanned: toBool(first.is_banned),
    isDeported: toBool(first.is_deported),
    isExcluded: toBool(first.is_excluded),
    isRealtor: toBool(first.is_realtor),
    totalPlots: categories.reduce((sum, c) => sum + c.count + c.exemptCount, 0),
    categories,
    violations: categories.filter((c) => c.isViolation).length,
    checks: categories.filter((c) => c.needsRealtorCheck).length,
  };
}

function groupByPlayer(rows: BreachRow[]): HolderLimits[] {
  const byPlayer = new Map<string, BreachRow[]>();
  for (const row of rows) {
    const key = String(row.player_uuid);
    byPlayer.set(key, [...(byPlayer.get(key) ?? []), row]);
  }
  return [...byPlayer.values()].map(buildHolder);
}

export interface LimitsQuery {
  /** Only holders over a limit. Defaults to true. */
  breachesOnly?: boolean;
  includeExcluded?: boolean;
  limit?: number;
}

export async function findLimitBreaches(
  query: LimitsQuery = {},
): Promise<HolderLimits[]> {
  let holders = groupByPlayer(await loadBreaches());

  if (!query.includeExcluded) {
    holders = holders.filter((h) => !h.isExcluded);
  }
  if (query.breachesOnly !== false) {
    holders = holders.filter((h) => h.violations > 0 || h.checks > 0);
  }

  holders.sort(
    (a, b) =>
      b.violations - a.violations ||
      b.checks - a.checks ||
      b.totalPlots - a.totalPlots,
  );

  return holders.slice(0, query.limit ?? 200);
}

/** One holder's category counts, for their player page. */
export async function getHolderLimits(
  playerUuid: string,
): Promise<HolderLimits | null> {
  const rows = await loadBreaches(playerUuid);
  if (rows.length === 0) return null;
  return buildHolder(rows);
}

export interface LimitsSummary {
  holdersOverLimit: number;
  holdersNeedingRealtorCheck: number;
  confirmedRealtors: number;
  byCategory: Array<{ category: string; label: string; breaches: number }>;
  realtorBonus: number;
}

export async function getLimitsSummary(): Promise<LimitsSummary> {
  const holders = await findLimitBreaches({ limit: 100_000 });

  const byCategory = new Map<string, number>();
  for (const holder of holders) {
    for (const category of holder.categories) {
      if (category.isViolation) {
        byCategory.set(
          category.category,
          (byCategory.get(category.category) ?? 0) + 1,
        );
      }
    }
  }

  return {
    holdersOverLimit: holders.filter((h) => h.violations > 0).length,
    holdersNeedingRealtorCheck: holders.filter(
      (h) => h.violations === 0 && h.checks > 0,
    ).length,
    confirmedRealtors: holders.filter((h) => h.isRealtor).length,
    byCategory: [...byCategory]
      .map(([category, breaches]) => ({
        category,
        label: categoryDefinition(category).label,
        breaches,
      }))
      .sort((a, b) => b.breaches - a.breaches),
    realtorBonus: REALTOR_BONUS,
  };
}

/** `2 in Oakridge, 1 in Willow` — the exempt-plot footnote. */
export function describeExempt(holding: CategoryHolding): string | null {
  if (holding.exemptCount === 0) return null;
  const areas = holding.exemptAreas
    .filter((a): a is NonNullable<PlotArea> => a !== null)
    .map((a) => AREA_LABELS[a])
    .join(", ");
  return areas
    ? `${holding.exemptCount} exempt in ${areas}`
    : `${holding.exemptCount} exempt`;
}
