import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  toBool,
  toDate,
  toDecimalString,
  toInt,
  toNumber,
  toText,
} from "@/lib/db/coerce";
import {
  plotCountsTowardLimitSql,
  plotLimitCte,
} from "@/lib/plots/limits-sql";
import { HOUR_MS } from "@/lib/sources/analytics/duration";

import { ALL_REASONS, type FlagReason } from "./reasons";

/**
 * The flagship insight: properties held by players who have gone inactive,
 * been banned, or been deported.
 *
 * The thresholds live here rather than in the SQL views so the UI can tune them
 * per request. `playtime_30d_source` is carried all the way through to the
 * response: a player we have simply never measured must never be presented as
 * a measured zero.
 */

export { ALL_REASONS, type FlagReason } from "./reasons";
export type StakeholderRole =
  | "titleholder"
  | "authority"
  | "landlord"
  | "tenant"
  | "wg_owner"
  | "wg_member";

/** Roles that represent holding a property, as opposed to merely occupying it. */
export const OWNERSHIP_ROLES: StakeholderRole[] = ["titleholder", "landlord"];

export interface AtRiskFilters {
  /** Inactivity threshold in hours over the trailing 30 days. */
  thresholdHours?: number;
  reasons?: FlagReason[];
  roles?: StakeholderRole[];
  worldUuid?: string;
  contractType?: "freehold" | "leasehold";
  /** Include rows whose 30-day playtime has never been measured. */
  includeUnknownPlaytime?: boolean;
  /** Show properties of excluded players too. Off by default. */
  includeExcluded?: boolean;
  /** Show plots that already have an open eviction report. Off by default. */
  includeReported?: boolean;
  /** Restrict to plots whose *authority* matches this name or UUID. */
  authority?: string;
  limit?: number;
  offset?: number;
  sort?: "player" | "authority" | "world" | "price" | "playtime" | "lease_end";
  direction?: "asc" | "desc";
}

export interface AtRiskRow {
  worldUuid: string;
  worldName: string | null;
  wgRegionId: string;
  state: string | null;
  contractType: string | null;
  /** Zoning and area, for the plot-limit context an inspector needs. */
  category: string | null;
  area: string | null;
  /** Set when this plot is merged with others, which are filed as one report. */
  mergeGroupId: number | null;
  mergeMemberCount: number | null;
  role: StakeholderRole;
  playerUuid: string;
  playerName: string | null;
  isBanned: boolean;
  isDeported: boolean;
  /**
   * Deported indefinitely or for four months and up — the only deportations
   * that are grounds to evict. A limited deportation is served out and the
   * player comes back to their property.
   */
  isLongDeported: boolean;
  /** indefinite | long | limited, or null when not deported. */
  deportationKind: string | null;
  deportationEndsAt: Date | null;
  /** The holder is over a §17 limit and this plot counts towards it. */
  isOverLimit: boolean;
  /** Their counted holdings in this plot's category, and the cap. */
  limitCount: number | null;
  limitValue: number | null;
  limitIsViolation: boolean;
  limitNeedsRealtorCheck: boolean;
  /** Realtor job confirmed in game and recorded on the player page. */
  isRealtor: boolean;
  playtime30dMs: number | null;
  playtime30dSource: "analytics_detail" | "inferred_zero" | "unknown";
  lastSeenAt: Date | null;
  price: string | null;
  balance: string | null;
  leaseEndAt: Date | null;
  flagReasons: FlagReason[];
  authorityUuid: string | null;
  authorityName: string | null;
  isExcluded: boolean;
  exclusionReason: string | null;
  hasActiveReport: boolean;
  reportTitle: string | null;
  reportUrl: string | null;
}

/**
 * The at-risk row set: every stakeholder row, with the §17 limit verdict for
 * the holder's category attached.
 *
 * The limit join is part of the source rather than a separate query because
 * being over a plot limit is a reason a property is at risk — a Plot Fairness
 * report on a freehold, or Rental Limitations on a leasehold — and the point of
 * merging it in is that one table answers "what should I file on".
 *
 * A plot is flagged only when it *counts* towards the breached limit. A holder
 * can be over the commercial limit while this particular plot of theirs sits in
 * Oakridge and is exempt; that plot is not the one to file against.
 */
export function atRiskRowsCte() {
  return sql`
    ${plotLimitCte()},
    at_risk_rows AS (
      SELECT v.*,
             (COALESCE(b.over_limit, false)
              AND ${plotCountsTowardLimitSql(sql`v.category`, sql`v.area`)})
                                                    AS is_over_limit,
             b.counted_plots                        AS limit_count,
             b.plot_limit                           AS limit_value,
             COALESCE(b.is_violation, false)        AS limit_is_violation,
             COALESCE(b.needs_realtor_check, false) AS limit_needs_realtor_check,
             COALESCE(b.is_realtor, false)          AS is_realtor
        FROM v_property_stakeholder_flags v
        LEFT JOIN plot_limit_breaches b
               ON b.player_uuid = v.player_uuid
              AND b.category = COALESCE(v.category, 'other')
    )
  `;
}

/**
 * What makes a property at risk, as one SQL predicate.
 *
 * Exported because three callers need it and they must agree exactly: the table
 * on `/at-risk`, the headline counts on `/`, and the Discord notifier. A fourth
 * copy of "banned OR long-deported OR over a limit OR under the playtime
 * threshold" is a drift bug waiting to happen — the notifier announcing plots
 * the page does not list would be indistinguishable from a real change.
 *
 * Expects `at_risk_rows` (from `atRiskRowsCte`) to be in scope.
 */
export function atRiskFlaggedSql(thresholdMs: number) {
  return sql`(is_banned OR is_long_deported OR is_over_limit
              OR (playtime_30d_ms IS NOT NULL
                  AND playtime_30d_ms < ${thresholdMs}
                  AND NOT is_limited_deported))`;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const SORT_COLUMNS: Record<NonNullable<AtRiskFilters["sort"]>, string> = {
  player: "player_name",
  authority: "authority_name",
  world: "world_name",
  price: "price",
  playtime: "playtime_30d_ms",
  lease_end: "lease_end_at",
};

function buildWhere(filters: AtRiskFilters) {
  const thresholdMs = (filters.thresholdHours ?? 6) * HOUR_MS;
  const reasons = filters.reasons ?? ALL_REASONS;
  const roles = filters.roles ?? OWNERSHIP_ROLES;

  // "Inactive" requires a *measured* value below the threshold. An unmeasured
  // player is excluded unless explicitly asked for, so the headline number is
  // never inflated by missing data.
  //
  // A player serving a limited deportation is never inactive for this purpose:
  // they cannot play, so their zero is an artefact of the punishment, not
  // evidence about them. Without this the long-deport rule would achieve
  // nothing — every deported holder reads as inactive and gets flagged anyway.
  const measured = filters.includeUnknownPlaytime
    ? sql`(playtime_30d_ms IS NULL OR playtime_30d_ms < ${thresholdMs})`
    : sql`(playtime_30d_ms IS NOT NULL AND playtime_30d_ms < ${thresholdMs})`;
  const inactiveClause = sql`(${measured} AND NOT is_limited_deported)`;

  const reasonClauses = [];
  if (reasons.includes("inactive")) reasonClauses.push(inactiveClause);
  if (reasons.includes("banned")) reasonClauses.push(sql`is_banned`);
  // A limited deportation is not grounds to evict: the player serves it and
  // returns to their plot. Only indefinite and long ones flag the property.
  if (reasons.includes("deported")) reasonClauses.push(sql`is_long_deported`);
  if (reasons.includes("over-limit")) reasonClauses.push(sql`is_over_limit`);

  const conditions = [
    sql`role IN (${sql.join(
      roles.map((r) => sql`${r}`),
      sql`, `,
    )})`,
    reasonClauses.length > 0
      ? sql`(${sql.join(reasonClauses, sql` OR `)})`
      : sql`false`,
  ];

  if (filters.worldUuid) {
    conditions.push(sql`world_uuid = ${filters.worldUuid}::uuid`);
  }
  if (filters.contractType) {
    conditions.push(sql`contract_type = ${filters.contractType}`);
  }

  // Excluded players are hidden by default. The flag is on the view so the
  // exclusion also applies when the excluded player is a landlord or tenant,
  // not only when they hold the title.
  if (!filters.includeExcluded) {
    conditions.push(sql`NOT is_excluded`);
  }

  // A plot with an open eviction report is already being handled, so it drops
  // out of review. Hidden rather than deleted: the count is reported on the
  // overview and a toggle brings them back, so the work never goes silent.
  if (!filters.includeReported) {
    conditions.push(sql`NOT has_active_report`);
  }

  // Accepts a full UUID or a case-insensitive name fragment, so a reviewer can
  // paste an id or just type part of a name.
  const authority = filters.authority?.trim();
  if (authority) {
    conditions.push(
      UUID_RE.test(authority)
        ? sql`authority_uuid = ${authority.toLowerCase()}::uuid`
        : sql`authority_name_lower LIKE ${`%${authority.toLowerCase()}%`}`,
    );
  }

  return { where: sql.join(conditions, sql` AND `), thresholdMs };
}

export async function findAtRiskProperties(
  filters: AtRiskFilters = {},
): Promise<AtRiskRow[]> {
  const { where, thresholdMs } = buildWhere(filters);
  const sortColumn = SORT_COLUMNS[filters.sort ?? "player"];
  const direction = filters.direction === "desc" ? sql`DESC` : sql`ASC`;
  const limit = Math.min(filters.limit ?? 100, 1000);

  const result = await db.execute<Record<string, unknown>>(sql`
    WITH ${atRiskRowsCte()}
    SELECT world_uuid, world_name, wg_region_id, state, contract_type,
           category, area, merge_group_id, merge_member_count, role,
           player_uuid, player_name, is_banned, is_deported,
           is_long_deported, deportation_kind, deportation_ends_at,
           is_over_limit, limit_count, limit_value, limit_is_violation,
           limit_needs_realtor_check, is_realtor,
           playtime_30d_ms, playtime_30d_source, last_seen_at,
           price, balance, lease_end_at,
           authority_uuid, authority_name, is_excluded, exclusion_reason,
           has_active_report, report_title, report_url
      FROM at_risk_rows
     WHERE ${where}
     ORDER BY ${sql.raw(sortColumn)} ${direction} NULLS LAST, wg_region_id ASC
     LIMIT ${limit} OFFSET ${filters.offset ?? 0}
  `);

  return result.rows.map((row) => {
    const playtime = toNumber(row.playtime_30d_ms);
    const isBanned = toBool(row.is_banned);
    const isDeported = toBool(row.is_deported);
    const isLongDeported = toBool(row.is_long_deported);

    const isOverLimit = toBool(row.is_over_limit);

    const flagReasons: FlagReason[] = [];
    if (isBanned) flagReasons.push("banned");
    if (isLongDeported) flagReasons.push("deported");
    if (
      playtime !== null &&
      playtime < thresholdMs &&
      !(isDeported && !isLongDeported)
    ) {
      flagReasons.push("inactive");
    }
    if (isOverLimit) flagReasons.push("over-limit");

    return {
      worldUuid: String(row.world_uuid),
      worldName: toText(row.world_name),
      wgRegionId: String(row.wg_region_id),
      state: toText(row.state),
      contractType: toText(row.contract_type),
      category: toText(row.category),
      area: toText(row.area),
      mergeGroupId: toNumber(row.merge_group_id),
      mergeMemberCount: toNumber(row.merge_member_count),
      role: row.role as StakeholderRole,
      playerUuid: String(row.player_uuid),
      playerName: toText(row.player_name),
      isBanned,
      isDeported,
      isLongDeported,
      deportationKind: toText(row.deportation_kind),
      deportationEndsAt: toDate(row.deportation_ends_at),
      isOverLimit,
      limitCount: toNumber(row.limit_count),
      limitValue: toNumber(row.limit_value),
      limitIsViolation: toBool(row.limit_is_violation),
      limitNeedsRealtorCheck: toBool(row.limit_needs_realtor_check),
      isRealtor: toBool(row.is_realtor),
      playtime30dMs: playtime,
      playtime30dSource: row.playtime_30d_source as AtRiskRow["playtime30dSource"],
      lastSeenAt: toDate(row.last_seen_at),
      price: toDecimalString(row.price),
      balance: toDecimalString(row.balance),
      leaseEndAt: toDate(row.lease_end_at),
      flagReasons,
      authorityUuid: toText(row.authority_uuid),
      authorityName: toText(row.authority_name),
      isExcluded: toBool(row.is_excluded),
      exclusionReason: toText(row.exclusion_reason),
      hasActiveReport: toBool(row.has_active_report),
      reportTitle: toText(row.report_title),
      reportUrl: toText(row.report_url),
    };
  });
}

export async function countAtRiskProperties(
  filters: AtRiskFilters = {},
): Promise<number> {
  const { where } = buildWhere(filters);
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH ${atRiskRowsCte()}
    SELECT count(*)::int AS count
      FROM at_risk_rows
     WHERE ${where}
  `);
  return toInt(result.rows[0]?.count);
}

export interface OverviewStats {
  regions: number;
  regionsWithDetail: number;
  players: number;
  activeBans: number;
  /** Indefinite or long only — the ones that are grounds to evict. */
  activeDeportations: number;
  /** Deportations short enough that the player returns to their property. */
  limitedDeportations: number;
  atRiskProperties: number;
  distinctAtRiskPlayers: number;
  /** Of those, the ones flagged for exceeding a §17 plot limit. */
  overLimitProperties: number;
  /** Properties hidden because their holder is on the exclusion list. */
  excludedProperties: number;
  excludedPlayers: number;
  /** Players marked as realtors, who get §17(9)'s +5 allowance. */
  confirmedRealtors: number;
  /** Properties hidden because an eviction report is already open on them. */
  reportedProperties: number;
  activeReports: number;
  playtimeCoverage: {
    measured: number;
    inferredZero: number;
    unknown: number;
  };
}

export async function getOverviewStats(
  thresholdHours: number,
): Promise<OverviewStats> {
  const thresholdMs = thresholdHours * HOUR_MS;

  // One predicate, used by every count below, so the headline and the table
  // can never disagree about what "at risk" means.
  const flagged = atRiskFlaggedSql(thresholdMs);
  const owners = sql`role IN ('titleholder','landlord') AND ${flagged}`;

  const result = await db.execute<Record<string, string>>(sql`
    WITH ${atRiskRowsCte()}
    SELECT
      (SELECT count(*) FROM regions)                                    AS regions,
      (SELECT count(*) FROM regions WHERE detail_fetched_at IS NOT NULL) AS regions_with_detail,
      (SELECT count(*) FROM players)                                    AS players,
      (SELECT count(*) FROM v_active_punishments WHERE type = 'BAN')    AS active_bans,
      (SELECT count(*) FROM v_active_punishments
        WHERE is_deportation AND deportation_kind IN ('indefinite','long'))
                                                                        AS active_deportations,
      (SELECT count(*) FROM v_active_punishments
        WHERE is_deportation AND deportation_kind = 'limited')          AS limited_deportations,
      -- Headline figures match the default at-risk view, which hides excluded
      -- holders; the hidden count is reported separately rather than folded in.
      (SELECT count(*) FROM at_risk_rows
        WHERE ${owners} AND NOT is_excluded AND NOT has_active_report
      )                                                                 AS at_risk_properties,
      (SELECT count(DISTINCT player_uuid) FROM at_risk_rows
        WHERE ${owners} AND NOT is_excluded AND NOT has_active_report
      )                                                                 AS distinct_at_risk_players,
      (SELECT count(*) FROM at_risk_rows
        WHERE role IN ('titleholder','landlord') AND is_over_limit
          AND NOT is_excluded AND NOT has_active_report
      )                                                                 AS over_limit_properties,
      (SELECT count(*) FROM at_risk_rows
        WHERE role IN ('titleholder','landlord') AND is_excluded AND ${flagged}
      )                                                                 AS excluded_properties,
      (SELECT count(*) FROM player_exclusions)                          AS excluded_players,
      (SELECT count(*) FROM player_realtors)                            AS confirmed_realtors,
      (SELECT count(*) FROM at_risk_rows
        WHERE role IN ('titleholder','landlord') AND has_active_report AND ${flagged}
      )                                                                 AS reported_properties,
      (SELECT count(*) FROM eviction_reports WHERE is_active)           AS active_reports,
      (SELECT count(*) FROM v_player_flags WHERE playtime_30d_source = 'analytics_detail') AS measured,
      (SELECT count(*) FROM v_player_flags WHERE playtime_30d_source = 'inferred_zero')    AS inferred_zero,
      (SELECT count(*) FROM v_player_flags WHERE playtime_30d_source = 'unknown')          AS unknown
  `);

  const row = result.rows[0] ?? {};
  const n = (key: string) => toInt(row[key]);

  return {
    regions: n("regions"),
    regionsWithDetail: n("regions_with_detail"),
    players: n("players"),
    activeBans: n("active_bans"),
    activeDeportations: n("active_deportations"),
    limitedDeportations: n("limited_deportations"),
    atRiskProperties: n("at_risk_properties"),
    distinctAtRiskPlayers: n("distinct_at_risk_players"),
    overLimitProperties: n("over_limit_properties"),
    excludedProperties: n("excluded_properties"),
    excludedPlayers: n("excluded_players"),
    confirmedRealtors: n("confirmed_realtors"),
    reportedProperties: n("reported_properties"),
    activeReports: n("active_reports"),
    playtimeCoverage: {
      measured: n("measured"),
      inferredZero: n("inferred_zero"),
      unknown: n("unknown"),
    },
  };
}

export async function listWorlds(): Promise<
  Array<{ uuid: string; name: string | null; regions: number }>
> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT w.uuid, w.name, count(r.wg_region_id)::int AS regions
      FROM worlds w
      LEFT JOIN regions r ON r.world_uuid = w.uuid
     GROUP BY w.uuid, w.name
     ORDER BY regions DESC
  `);
  return result.rows.map((r) => ({
    uuid: String(r.uuid),
    name: toText(r.name),
    regions: toInt(r.regions),
  }));
}
