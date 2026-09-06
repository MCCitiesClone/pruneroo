import { sql, type SQL } from "drizzle-orm";

import {
  AREA_LABELS,
  DEFINITIONS,
  effectiveLimit,
  limitApplies,
  type PlotArea,
  type PlotCategory,
} from "./categories";

/**
 * The §17 ownership limits, as SQL.
 *
 * The at-risk table flags plots whose holder is over a limit, and `/at-risk`
 * also summarises those holders — two queries that must agree to the plot. So
 * the decision table is **generated from the TypeScript rules** rather than
 * written twice: `DEFINITIONS` supplies the limits and `limitApplies` supplies
 * the area exemptions, both enumerated into `VALUES` lists here. Hand-writing
 * the same numbers into `views.sql` would let the page and the summary drift
 * apart, which is exactly how the CSV export once ended up with a 0-hour
 * threshold.
 *
 * Two modelling points worth stating, because both were wrong at first:
 *
 *  - **The limit is per category, summed across the map.** A holder with one
 *    farmland plot in Willow and one outside holds two farmland plots and is
 *    over §17(7)'s limit of 1. Counting each area separately reported 1/1 twice
 *    and missed it.
 *  - **Exempt plots are removed from the count, not counted separately.** A
 *    town plot cannot be the plot an inspector evicts for going over a limit,
 *    so it is excluded from the total and reported alongside it as context.
 */

const CATEGORIES = Object.keys(DEFINITIONS) as PlotCategory[];
const AREAS = Object.keys(AREA_LABELS) as NonNullable<PlotArea>[];

/**
 * Every (category, area) pair the limits do **not** apply to.
 *
 * Enumerated rather than expressed as a rule in SQL because the exemption is
 * not uniform: towns exempt everything, Willow exempts only commercial. An
 * area value that is not in this list counts towards the limit, which is the
 * safe direction — a new area shows up as enforced and visible rather than
 * silently exempt.
 */
export function exemptPairs(): Array<{ category: PlotCategory; area: string }> {
  const pairs: Array<{ category: PlotCategory; area: string }> = [];
  for (const category of CATEGORIES) {
    for (const area of AREAS) {
      if (!limitApplies(area, category)) pairs.push({ category, area });
    }
  }
  return pairs;
}

function values(rows: SQL[]): SQL {
  return sql`VALUES ${sql.join(rows, sql`, `)}`;
}

/**
 * The CTE prelude. Defines four relations, of which callers use the last two:
 *
 *  - `plot_limit_exempt(category, area)` — the exemption table, also used to ask
 *    whether one particular plot counts (see `plotCountsTowardLimitSql`).
 *  - `plot_limit_breaches(player_uuid, category, …)` — one row per holder per
 *    category, with the counted total, the applicable limits, whether the
 *    holder is a confirmed realtor, and the three derived verdicts.
 *
 * "Holder" follows the inspector guide: the titleholder on a freehold and the
 * tenant on a leasehold — never the landlord, who merely rents it out.
 */
export function plotLimitCte(): SQL {
  const rules = values(
    CATEGORIES.map((category) => {
      const definition = DEFINITIONS[category];
      return sql`(${category}::text, ${definition.limit}::int, ${effectiveLimit(definition, true)}::int)`;
    }),
  );

  const exempt = values(
    exemptPairs().map((p) => sql`(${p.category}::text, ${p.area}::text)`),
  );

  return sql`
    plot_limit_rules(category, plot_limit, realtor_limit) AS (${rules}),
    plot_limit_exempt(category, area) AS (${exempt}),
    plot_limit_owned AS (
      SELECT COALESCE(fh.titleholder_uuid, lh.tenant_uuid) AS player_uuid,
             COALESCE(r.category, 'other')                 AS category,
             r.area
        FROM regions r
        LEFT JOIN region_freehold  fh ON fh.world_uuid = r.world_uuid
                                     AND fh.wg_region_id = r.wg_region_id
        LEFT JOIN region_leasehold lh ON lh.world_uuid = r.world_uuid
                                     AND lh.wg_region_id = r.wg_region_id
       WHERE COALESCE(fh.titleholder_uuid, lh.tenant_uuid) IS NOT NULL
    ),
    plot_limit_holdings AS (
      SELECT o.player_uuid,
             o.category,
             count(*) FILTER (WHERE ex.category IS NULL)::int     AS counted_plots,
             count(*) FILTER (WHERE ex.category IS NOT NULL)::int AS exempt_plots,
             count(*)::int                                        AS total_plots,
             -- Which areas the exempt plots sit in, so the exemption can be
             -- shown as "3 in Oakridge" rather than an unexplained gap.
             array_remove(
               array_agg(DISTINCT o.area) FILTER (WHERE ex.category IS NOT NULL),
               NULL
             )                                                    AS exempt_areas,
             -- Constant per category; max() only satisfies the aggregate.
             max(ru.plot_limit)                                   AS plot_limit,
             max(ru.realtor_limit)                                AS realtor_limit,
             bool_or(pr.player_uuid IS NOT NULL)                  AS is_realtor
        FROM plot_limit_owned o
        LEFT JOIN plot_limit_exempt ex ON ex.category = o.category
                                      AND ex.area = o.area
        LEFT JOIN plot_limit_rules  ru ON ru.category = o.category
        LEFT JOIN player_realtors   pr ON pr.player_uuid = o.player_uuid
       GROUP BY o.player_uuid, o.category
    ),
    plot_limit_breaches AS (
      SELECT h.*,
             -- Over the ceiling that actually applies to this holder. For a
             -- confirmed realtor that is the §17(9) allowance; for everyone
             -- else it is the plain limit, since the job is unverified.
             (h.plot_limit IS NOT NULL
              AND h.counted_plots > CASE WHEN h.is_realtor
                                         THEN h.realtor_limit
                                         ELSE h.plot_limit END)   AS over_limit,
             -- Beyond even a realtor's allowance: a violation whoever they are.
             (h.plot_limit IS NOT NULL
              AND h.counted_plots > h.realtor_limit)              AS is_violation,
             -- Over the plain limit but explainable by the realtor job, which
             -- nobody has confirmed yet. Resolve with /about <player>, then
             -- mark them on their player page.
             (h.plot_limit IS NOT NULL
              AND NOT h.is_realtor
              AND h.counted_plots > h.plot_limit
              AND h.counted_plots <= h.realtor_limit)             AS needs_realtor_check
        FROM plot_limit_holdings h
    )
  `;
}

/**
 * Whether one plot counts towards its holder's limit.
 *
 * Needed on the property table: a holder can be over the commercial limit while
 * *this* plot of theirs sits in Oakridge and is exempt, and an exempt plot is
 * not the one to file against. Requires `plotLimitCte()` in the same statement.
 */
export function plotCountsTowardLimitSql(
  categoryExpr: SQL,
  areaExpr: SQL,
): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM plot_limit_exempt e
     WHERE e.category = COALESCE(${categoryExpr}, 'other')
       AND e.area = ${areaExpr}
  )`;
}
