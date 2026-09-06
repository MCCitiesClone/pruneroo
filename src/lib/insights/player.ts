import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  plotCountsTowardLimitSql,
  plotLimitCte,
} from "@/lib/plots/limits-sql";
import {
  toBool,
  toDate,
  toDecimalString,
  toInt,
  toNumber,
  toText,
} from "@/lib/db/coerce";

export interface PlayerProfile {
  playerUuid: string;
  playerName: string | null;
  lastSeenAt: Date | null;
  registeredAt: Date | null;
  lifetimePlaytimeMs: number | null;
  sessionCount: number | null;
  isBanned: boolean;
  isDeported: boolean;
  /** Deported indefinitely or for 4+ months: grounds to evict. */
  isLongDeported: boolean;
  deportationKind: string | null;
  deportationEndsAt: Date | null;
  banReason: string | null;
  deportationReason: string | null;
  playtime30dMs: number | null;
  playtime30dSource: "analytics_detail" | "inferred_zero" | "unknown";
  playtime30dFetchedAt: Date | null;
  treasuryAccountId: number | null;
  balance: string | null;
}

export async function getPlayerProfile(
  uuid: string,
): Promise<PlayerProfile | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT * FROM v_player_flags WHERE player_uuid = ${uuid}::uuid LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;

  return {
    playerUuid: String(row.player_uuid),
    playerName: toText(row.player_name),
    lastSeenAt: toDate(row.last_seen_at),
    registeredAt: toDate(row.registered_at),
    lifetimePlaytimeMs: toNumber(row.lifetime_playtime_ms),
    sessionCount: toNumber(row.session_count),
    isBanned: toBool(row.is_banned),
    isDeported: toBool(row.is_deported),
    isLongDeported: toBool(row.is_long_deported),
    deportationKind: toText(row.deportation_kind),
    deportationEndsAt: toDate(row.deportation_ends_at),
    banReason: toText(row.ban_reason),
    deportationReason: toText(row.deportation_reason),
    playtime30dMs: toNumber(row.playtime_30d_ms),
    playtime30dSource: row.playtime_30d_source as PlayerProfile["playtime30dSource"],
    playtime30dFetchedAt: toDate(row.playtime_30d_fetched_at),
    treasuryAccountId: toNumber(row.treasury_account_id),
    balance: toDecimalString(row.balance),
  };
}

export interface PlayerHolding {
  worldUuid: string;
  worldName: string | null;
  wgRegionId: string;
  role: string;
  state: string | null;
  category: string | null;
  price: string | null;
  leaseEndAt: Date | null;
}

export interface PlayerHoldings {
  holdings: PlayerHolding[];
  /** Sub-regions left out — reported so the list is not silently short. */
  hidden: number;
}

/**
 * A player's plots, **excluding sub-regions of a plot rather than plots**.
 *
 * Two kinds are left out:
 *
 *  - **No tags at all** — billboards, yacht berths, individual shop units. A
 *    large holder can have dozens of them burying the plots that matter.
 *  - **Tagged only `apartment`** — 407 regions, each a unit inside someone
 *    else's building rather than a property in its own right. The tag has to be
 *    the *only* one: `apartment, shop` and `apartment, commercial` are real
 *    plots and stay.
 *
 * Neither kind carries zoning, so hiding them cannot change a plot-limit count.
 */
export async function getPlayerHoldings(
  uuid: string,
): Promise<PlayerHoldings> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT world_uuid, world_name, wg_region_id, role, state, category,
           price, lease_end_at,
           (tags IS NULL OR cardinality(tags) = 0
            OR (cardinality(tags) = 1 AND lower(tags[1]) = 'apartment')) AS hidden
      FROM v_property_stakeholder_flags
     WHERE player_uuid = ${uuid}::uuid
     ORDER BY role, world_name NULLS LAST, wg_region_id
  `);

  const visible = result.rows.filter((r) => !toBool(r.hidden));

  return {
    hidden: result.rows.length - visible.length,
    holdings: visible.map((r) => ({
      worldUuid: String(r.world_uuid),
      worldName: toText(r.world_name),
      wgRegionId: String(r.wg_region_id),
      role: String(r.role),
      state: toText(r.state),
      category: toText(r.category),
      price: toDecimalString(r.price),
      leaseEndAt: toDate(r.lease_end_at),
    })),
  };
}

export interface PlayerPunishment {
  id: string;
  type: string;
  reason: string;
  label: string | null;
  startAt: Date | null;
  endAt: Date | null;
  isPermanent: boolean;
  isDeportation: boolean;
  withdrawnAt: Date | null;
  /** Computed in SQL, since it depends on the current time. */
  isActive: boolean;
  operatorName: string | null;
}

export async function getPlayerPunishments(
  uuid: string,
): Promise<PlayerPunishment[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT id, type, reason, label, start_at, end_at, is_permanent,
           is_deportation, withdrawn_at, operator_name,
           (withdrawn_at IS NULL AND (end_at IS NULL OR end_at > now())) AS is_active
      FROM punishments
     WHERE victim_uuid = ${uuid}::uuid
     ORDER BY start_at DESC NULLS LAST
     LIMIT 100
  `);
  return result.rows.map((r) => ({
    id: String(r.id),
    type: String(r.type),
    reason: String(r.reason),
    label: toText(r.label),
    startAt: toDate(r.start_at),
    endAt: toDate(r.end_at),
    isPermanent: toBool(r.is_permanent),
    isDeportation: toBool(r.is_deportation),
    withdrawnAt: toDate(r.withdrawn_at),
    isActive: toBool(r.is_active),
    operatorName: toText(r.operator_name),
  }));
}

export interface PlayerSearchRow {
  playerUuid: string;
  playerName: string | null;
  lastSeenAt: Date | null;
  isBanned: boolean;
  isDeported: boolean;
  playtime30dMs: number | null;
  playtime30dSource: string;
  holdings: number;
}

export async function searchPlayers(
  query: string,
  limit = 100,
): Promise<PlayerSearchRow[]> {
  const pattern = `%${query.toLowerCase()}%`;
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT f.player_uuid, f.player_name, f.last_seen_at, f.is_banned,
           f.is_deported, f.playtime_30d_ms, f.playtime_30d_source,
           COALESCE(h.holdings, 0)::int AS holdings
      FROM v_player_flags f
      LEFT JOIN (
        SELECT player_uuid, count(*)::int AS holdings
          FROM v_region_stakeholders
         WHERE role IN ('titleholder','landlord','tenant')
         GROUP BY player_uuid
      ) h ON h.player_uuid = f.player_uuid
     WHERE ${
       query
         ? sql`lower(f.player_name) LIKE ${pattern}`
         : sql`(f.is_banned OR f.is_deported OR h.holdings > 0)`
     }
     ORDER BY h.holdings DESC NULLS LAST, f.last_seen_at DESC NULLS LAST
     LIMIT ${limit}
  `);

  return result.rows.map((r) => ({
    playerUuid: String(r.player_uuid),
    playerName: toText(r.player_name),
    lastSeenAt: toDate(r.last_seen_at),
    isBanned: toBool(r.is_banned),
    isDeported: toBool(r.is_deported),
    playtime30dMs: toNumber(r.playtime_30d_ms),
    playtime30dSource: String(r.playtime_30d_source),
    holdings: toInt(r.holdings),
  }));
}

export interface RegionDetailView {
  worldUuid: string;
  worldName: string | null;
  wgRegionId: string;
  state: string | null;
  contractType: string | null;
  tags: string[] | null;
  detailFetchedAt: Date | null;
  stakeholders: Array<{
    role: string;
    playerUuid: string;
    playerName: string | null;
    isBanned: boolean;
    isDeported: boolean;
    playtime30dMs: number | null;
  }>;
  price: string | null;
  leaseEndAt: Date | null;
  reports: RegionReport[];
  category: string | null;
  area: string | null;
  categorySource: string | null;
  /** Plots merged with this one: same owner, adjacent, named in one report. */
  mergedWith: Array<{ worldUuid: string; wgRegionId: string }>;
  /** The owner an inspector would file against: titleholder, else tenant. */
  ownerUuid: string | null;
  ownerName: string | null;
  /** The owner's standing, which decides what a report should be filed for. */
  owner: {
    isBanned: boolean;
    isDeported: boolean;
    /** Only an indefinite or 4+ month deportation is grounds to evict. */
    isLongDeported: boolean;
    deportationKind: string | null;
    deportationEndsAt: Date | null;
    playtime30dMs: number | null;
    playtime30dSource: string | null;
  } | null;
  /** This plot's category measured against §17, for the owner. */
  limit: {
    /** Their counted holdings in this category, and the cap. */
    count: number;
    limitValue: number | null;
    realtorLimit: number | null;
    isRealtor: boolean;
    overLimit: boolean;
    isViolation: boolean;
    needsRealtorCheck: boolean;
    /** False when this plot is exempt, so the breach is not about this plot. */
    countsTowardLimit: boolean;
  } | null;
}

export interface RegionReport {
  threadId: string;
  title: string;
  prefix: string | null;
  url: string;
  author: string | null;
  postedAt: Date | null;
  evictionDate: Date | null;
  isActive: boolean;
  /** "reports" (open forum) or "archive" (a previous, concluded report). */
  feed: string;
  /**
   * `forum` once a crawl has seen the thread, `manual` for one pasted in by
   * hand and not yet confirmed — its title and dates are provisional.
   */
  source: string;
  /** How this report came to name this plot: `parsed` or `manual`. */
  linkSource: string;
}

/** Every eviction report naming this region, open or resolved. */
export async function getRegionReports(
  worldUuid: string,
  wgRegionId: string,
): Promise<RegionReport[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT r.thread_id, r.title, r.prefix, r.url, r.author, r.posted_at,
           r.eviction_date, r.is_active, r.feed, r.source,
           rr.source AS link_source
      FROM eviction_report_regions rr
      JOIN eviction_reports r ON r.thread_id = rr.thread_id
     WHERE rr.world_uuid = ${worldUuid}::uuid AND rr.wg_region_id = ${wgRegionId}
     ORDER BY r.is_active DESC, r.eviction_date DESC NULLS LAST,
              r.posted_at DESC NULLS LAST
  `);
  return result.rows.map((row) => ({
    threadId: String(row.thread_id),
    title: String(row.title),
    prefix: toText(row.prefix),
    url: String(row.url),
    author: toText(row.author),
    postedAt: toDate(row.posted_at),
    evictionDate: toDate(row.eviction_date),
    isActive: toBool(row.is_active),
    feed: String(row.feed ?? "reports"),
    source: String(row.source ?? "forum"),
    linkSource: String(row.link_source ?? "parsed"),
  }));
}

export async function getRegion(
  worldUuid: string,
  wgRegionId: string,
): Promise<RegionDetailView | null> {
  const base = await db.execute<Record<string, unknown>>(sql`
    SELECT r.world_uuid, w.name AS world_name, r.wg_region_id, r.state,
           r.contract_type, r.tags, r.detail_fetched_at,
           r.category, r.area, r.category_source,
           COALESCE(fh.titleholder_uuid, lh.tenant_uuid) AS owner_uuid,
           op.name AS owner_name,
           of.is_banned            AS owner_is_banned,
           of.is_deported          AS owner_is_deported,
           of.is_long_deported     AS owner_is_long_deported,
           of.deportation_kind     AS owner_deportation_kind,
           of.deportation_ends_at  AS owner_deportation_ends_at,
           of.playtime_30d_ms      AS owner_playtime_30d_ms,
           of.playtime_30d_source  AS owner_playtime_30d_source
      FROM regions r
      LEFT JOIN worlds w ON w.uuid = r.world_uuid
      LEFT JOIN region_freehold  fh ON fh.world_uuid = r.world_uuid AND fh.wg_region_id = r.wg_region_id
      LEFT JOIN region_leasehold lh ON lh.world_uuid = r.world_uuid AND lh.wg_region_id = r.wg_region_id
      LEFT JOIN players op ON op.uuid = COALESCE(fh.titleholder_uuid, lh.tenant_uuid)
      LEFT JOIN v_player_flags of ON of.player_uuid = COALESCE(fh.titleholder_uuid, lh.tenant_uuid)
     WHERE r.world_uuid = ${worldUuid}::uuid AND r.wg_region_id = ${wgRegionId}
     LIMIT 1
  `);
  const row = base.rows[0];
  if (!row) return null;

  const reports = await getRegionReports(worldUuid, wgRegionId);

  // Only validated merges: same owner, adjacent, named together in a report.
  const merged = await db.execute<Record<string, unknown>>(sql`
    SELECT DISTINCT other.world_uuid, other.wg_region_id
      FROM plot_merge_members mine
      JOIN plot_merge_groups g ON g.id = mine.group_id AND g.status = 'merged'
      JOIN plot_merge_members other ON other.group_id = g.id
     WHERE mine.world_uuid = ${worldUuid}::uuid
       AND mine.wg_region_id = ${wgRegionId}
       AND other.wg_region_id <> ${wgRegionId}
     ORDER BY other.wg_region_id
  `);

  const stakeholders = await db.execute<Record<string, unknown>>(sql`
    SELECT role, player_uuid, player_name, is_banned, is_deported,
           playtime_30d_ms, price, lease_end_at
      FROM v_property_stakeholder_flags
     WHERE world_uuid = ${worldUuid}::uuid AND wg_region_id = ${wgRegionId}
     ORDER BY role
  `);

  // The owner's §17 position in *this plot's* category. Read here rather than
  // on the at-risk table's terms because the report kit below needs to know
  // whether a plot-limit report is the right filing for this plot — and, with
  // the plot's tenure, which of Plot Fairness and Rental Limitations it is.
  const ownerUuid = toText(row.owner_uuid);
  const limit = ownerUuid
    ? (
        await db.execute<Record<string, unknown>>(sql`
          WITH ${plotLimitCte()}
          SELECT b.counted_plots, b.plot_limit, b.realtor_limit, b.is_realtor,
                 b.over_limit, b.is_violation, b.needs_realtor_check,
                 ${plotCountsTowardLimitSql(sql`${toText(row.category)}`, sql`${toText(row.area)}`)}
                   AS counts_toward_limit
            FROM plot_limit_breaches b
           WHERE b.player_uuid = ${ownerUuid}::uuid
             AND b.category = ${row.category ?? "other"}
           LIMIT 1
        `)
      ).rows[0]
    : undefined;

  return {
    worldUuid: String(row.world_uuid),
    worldName: toText(row.world_name),
    wgRegionId: String(row.wg_region_id),
    state: toText(row.state),
    contractType: toText(row.contract_type),
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : null,
    detailFetchedAt: toDate(row.detail_fetched_at),
    price: toDecimalString(stakeholders.rows[0]?.price),
    leaseEndAt: toDate(stakeholders.rows[0]?.lease_end_at),
    reports,
    category: toText(row.category),
    area: toText(row.area),
    categorySource: toText(row.category_source),
    ownerUuid,
    ownerName: toText(row.owner_name),
    owner: ownerUuid
      ? {
          isBanned: toBool(row.owner_is_banned),
          isDeported: toBool(row.owner_is_deported),
          isLongDeported: toBool(row.owner_is_long_deported),
          deportationKind: toText(row.owner_deportation_kind),
          deportationEndsAt: toDate(row.owner_deportation_ends_at),
          playtime30dMs: toNumber(row.owner_playtime_30d_ms),
          playtime30dSource: toText(row.owner_playtime_30d_source),
        }
      : null,
    limit: limit
      ? {
          count: toInt(limit.counted_plots),
          limitValue: limit.plot_limit === null ? null : toInt(limit.plot_limit),
          realtorLimit:
            limit.realtor_limit === null ? null : toInt(limit.realtor_limit),
          isRealtor: toBool(limit.is_realtor),
          overLimit: toBool(limit.over_limit),
          isViolation: toBool(limit.is_violation),
          needsRealtorCheck: toBool(limit.needs_realtor_check),
          countsTowardLimit: toBool(limit.counts_toward_limit),
        }
      : null,
    mergedWith: merged.rows.map((m) => ({
      worldUuid: String(m.world_uuid),
      wgRegionId: String(m.wg_region_id),
    })),
    stakeholders: stakeholders.rows.map((s) => ({
      role: String(s.role),
      playerUuid: String(s.player_uuid),
      playerName: toText(s.player_name),
      isBanned: toBool(s.is_banned),
      isDeported: toBool(s.is_deported),
      playtime30dMs: toNumber(s.playtime_30d_ms),
    })),
  };
}
