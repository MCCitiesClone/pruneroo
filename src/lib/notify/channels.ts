import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { toBool, toDate, toDecimalString, toNumber, toText } from "@/lib/db/coerce";
import { getEnv } from "@/lib/env";
import { atRiskFlaggedSql, atRiskRowsCte } from "@/lib/insights/at-risk";
import { categoryDefinition } from "@/lib/plots/categories";
import { HOUR_MS } from "@/lib/sources/analytics/duration";

import { formatDecimal, type DiscordEmbed } from "./discord";
import type { NotifyBatch, NotifyChannel } from "./dispatch";

/**
 * The three alert channels.
 *
 * Each is just "which rows qualify" plus "how they read"; the sending, seeding
 * and de-duplication all live in `dispatch.ts`.
 *
 * The queries deliberately reuse the same views and predicates the pages use —
 * `v_active_punishments`, `v_prune_candidates`, `atRiskRowsCte` — rather than
 * restating the rules. An alert that disagrees with the page it links to is
 * worse than no alert, because there is no way to tell it from a real change.
 */

/**
 * The channel roster, in one place.
 *
 * The handlers, the `/sync` panel and the test button all enumerate the same
 * three channels, and a fourth copy of the list is how one of them ends up
 * quietly missing a channel that was added later.
 */
export type NotifyChannelName = "punishments" | "prune" | "at-risk";

export interface NotifyChannelInfo {
  name: NotifyChannelName;
  label: string;
  /** The env var that switches it on, named so the panel can say what to set. */
  envVar: string;
  jobKind: string;
  description: string;
}

export const NOTIFY_CHANNELS: NotifyChannelInfo[] = [
  {
    name: "punishments",
    label: "Bans & deportations",
    envVar: "DISCORD_WEBHOOK_PUNISHMENTS",
    jobKind: "notify.punishments",
    description: "A ban or deportation we have not announced before",
  },
  {
    name: "prune",
    label: "Prune candidates",
    envVar: "DISCORD_WEBHOOK_PRUNE",
    jobKind: "notify.prune",
    description: "A dormant player priced above the alert floor",
  },
  {
    name: "at-risk",
    label: "At-risk properties",
    envVar: "DISCORD_WEBHOOK_AT_RISK",
    jobKind: "notify.atRisk",
    description: "A property joining the at-risk list, batched per holder",
  },
];

export function isNotifyChannelName(value: string): value is NotifyChannelName {
  return NOTIFY_CHANNELS.some((c) => c.name === value);
}

/**
 * Build a channel by name.
 *
 * The name is the only thing a caller needs to pass, which matters for the test
 * button: it means the webhook URL is chosen *here*, from the environment, and
 * never travels from the browser.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function notifyChannelByName(name: NotifyChannelName): NotifyChannel<any> {
  switch (name) {
    case "punishments":
      return punishmentsChannel();
    case "prune":
      return pruneChannel();
    case "at-risk":
      return atRiskChannel();
  }
}

const COLOURS = {
  ban: 0xe0_4f_5f,
  deportation: 0xe0_8c_4f,
  money: 0x3b_a5_5d,
  atRisk: 0xe0_b8_4f,
} as const;

/** Links back to the page that explains an alert, when the app's URL is known. */
function link(path: string): string | undefined {
  const base = getEnv().APP_BASE_URL;
  return base ? `${base}${path}` : undefined;
}

function playerLink(uuid: string): string | undefined {
  return link(`/players/${uuid}`);
}

/** Chunk into messages of at most `size` embeds, keeping each item's keys. */
function chunk<T>(
  items: T[],
  size: number,
  toEmbed: (item: T) => DiscordEmbed,
  toKeys: (item: T) => string[],
): NotifyBatch[] {
  const batches: NotifyBatch[] = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    batches.push({
      message: { embeds: slice.map(toEmbed) },
      keys: slice.flatMap(toKeys),
    });
  }
  return batches;
}

function itemsPerMessage(): number {
  return getEnv().DISCORD_ITEMS_PER_MESSAGE;
}

/** `3d` / `4mo` — compact enough for an embed field. */
function sinceLabel(at: Date | null): string {
  if (!at) return "unknown";
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 60) return `${days}d ago`;
  if (days < 730) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ---------------------------------------------------------------------------
// 1. New bans and deportations
// ---------------------------------------------------------------------------

interface PunishmentItem {
  id: string;
  type: string;
  victimUuid: string;
  victimName: string | null;
  reason: string;
  startAt: Date | null;
  endAt: Date | null;
  isDeportation: boolean;
  deportationKind: string | null;
  deportationEndsAt: Date | null;
}

/**
 * Bans and deportations only.
 *
 * A deportation is not a punishment type upstream — it is a WARN or MUTE whose
 * free-text reason says "Deportation" — so it cannot be selected by type, and
 * `v_active_punishments` is the only place that reads it correctly. That view
 * also does the login cross-check that keeps a lifted ban from being reported
 * as enforced, which matters more here than anywhere: this channel exists to
 * announce enforcement, and announcing a ban that was quietly lifted is exactly
 * the failure `docs/alerts.md` warns about.
 */
const PUNISHMENT_WHERE = sql`
  (p.type = 'BAN' OR p.is_deportation)
  AND p.victim_uuid IS NOT NULL
`;

export function punishmentsChannel(): NotifyChannel<PunishmentItem> {
  return {
    channel: "punishments",
    webhookUrl: getEnv().DISCORD_WEBHOOK_PUNISHMENTS,

    seedQuery(): SQL {
      return sql`
        SELECT p.id AS entity_key
          FROM v_active_punishments p
         WHERE ${PUNISHMENT_WHERE}
      `;
    },

    async findNew(limit: number): Promise<PunishmentItem[]> {
      const result = await db.execute<Record<string, unknown>>(sql`
        SELECT p.id, p.type, p.victim_uuid, p.victim_name, p.reason,
               p.start_at, p.end_at, p.is_deportation,
               p.deportation_kind, p.deportation_ends_at
          FROM v_active_punishments p
          LEFT JOIN notification_deliveries d
                 ON d.channel = 'punishments' AND d.entity_key = p.id
         WHERE ${PUNISHMENT_WHERE}
           AND d.entity_key IS NULL
         ORDER BY p.start_at DESC NULLS LAST, p.id
         LIMIT ${limit}
      `);
      return result.rows.map((row) => ({
        id: String(row.id),
        type: String(row.type),
        victimUuid: String(row.victim_uuid),
        victimName: toText(row.victim_name),
        reason: String(row.reason ?? ""),
        startAt: toDate(row.start_at),
        endAt: toDate(row.end_at),
        isDeportation: toBool(row.is_deportation),
        deportationKind: toText(row.deportation_kind),
        deportationEndsAt: toDate(row.deportation_ends_at),
      }));
    },

    build(items) {
      return chunk(
        items,
        itemsPerMessage(),
        (p) => {
          const who = p.victimName ?? p.victimUuid.slice(0, 8);
          const fields = [
            { name: "Reason", value: p.reason || "—" },
            { name: "Issued", value: sinceLabel(p.startAt), inline: true },
          ];

          if (p.isDeportation) {
            fields.push({
              name: "Ends",
              value:
                p.deportationEndsAt === null
                  ? "indefinite"
                  : p.deportationEndsAt.toISOString().slice(0, 10),
              inline: true,
            });
            // Only an indefinite or 4-month-plus deportation is grounds to
            // evict, so the distinction goes in the alert rather than being
            // re-derived by whoever reads it.
            fields.push({
              name: "Grounds to evict",
              value:
                p.deportationKind === "limited"
                  ? "No — limited, they serve it and return"
                  : `Yes — ${p.deportationKind ?? "indefinite"}`,
              inline: true,
            });
          } else {
            fields.push({
              name: "Expires",
              value:
                p.endAt === null
                  ? "permanent"
                  : p.endAt.toISOString().slice(0, 10),
              inline: true,
            });
          }

          return {
            title: p.isDeportation
              ? `${who} deported${p.deportationKind ? ` (${p.deportationKind})` : ""}`
              : `${who} banned`,
            url: playerLink(p.victimUuid),
            color: p.isDeportation ? COLOURS.deportation : COLOURS.ban,
            fields,
            footer: { text: p.isDeportation ? "Deportation" : `${p.type}` },
          };
        },
        (p) => [p.id],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 2. New prune candidates over the alert threshold
// ---------------------------------------------------------------------------

interface PruneItem {
  playerUuid: string;
  playerName: string | null;
  balance: string | null;
  lastSeenAt: Date | null;
  daysInactive: number | null;
  isBanned: boolean;
  isDeported: boolean;
}

/**
 * Dormant, priced, and over the alert threshold.
 *
 * Two thresholds are in play and they are not the same: `PRUNE_INACTIVITY_DAYS`
 * decides dormancy (shared with /prune) while `DISCORD_PRUNE_MIN_BALANCE` is
 * the alert floor, which is much higher than the page's own — /prune lists any
 * credit at all, and alerting on every one of those would be noise.
 *
 * `balance_source = 'measured'` is not optional. A pending balance means
 * Treasury has not been asked yet, and treating that as zero — or as anything —
 * would announce players on the strength of a number nobody has read.
 */
function pruneWhere(): SQL {
  const env = getEnv();
  return sql`
    c.last_seen_at IS NOT NULL
    AND c.last_seen_at < now() - make_interval(days => ${env.PRUNE_INACTIVITY_DAYS})
    AND NOT c.is_excluded
    AND c.balance_source = 'measured'
    AND c.balance IS NOT NULL
    AND c.balance > ${String(env.DISCORD_PRUNE_MIN_BALANCE)}::numeric
  `;
}

export function pruneChannel(): NotifyChannel<PruneItem> {
  return {
    channel: "prune",
    webhookUrl: getEnv().DISCORD_WEBHOOK_PRUNE,

    seedQuery(): SQL {
      return sql`
        SELECT c.player_uuid::text AS entity_key
          FROM v_prune_candidates c
         WHERE ${pruneWhere()}
      `;
    },

    async findNew(limit: number): Promise<PruneItem[]> {
      const result = await db.execute<Record<string, unknown>>(sql`
        SELECT c.player_uuid, c.player_name, c.balance, c.last_seen_at,
               c.is_banned, c.is_deported,
               floor(extract(epoch FROM now() - c.last_seen_at) / 86400)::int
                 AS days_inactive
          FROM v_prune_candidates c
          LEFT JOIN notification_deliveries d
                 ON d.channel = 'prune'
                AND d.entity_key = c.player_uuid::text
         WHERE ${pruneWhere()}
           AND d.entity_key IS NULL
         ORDER BY c.balance DESC
         LIMIT ${limit}
      `);
      return result.rows.map((row) => ({
        playerUuid: String(row.player_uuid),
        playerName: toText(row.player_name),
        balance: toDecimalString(row.balance),
        lastSeenAt: toDate(row.last_seen_at),
        daysInactive: toNumber(row.days_inactive),
        isBanned: toBool(row.is_banned),
        isDeported: toBool(row.is_deported),
      }));
    },

    build(items) {
      return chunk(
        items,
        itemsPerMessage(),
        (p) => {
          const flags = [
            p.isBanned ? "banned" : null,
            p.isDeported ? "deported" : null,
          ].filter(Boolean);
          return {
            title: `${p.playerName ?? p.playerUuid.slice(0, 8)} — $${
              p.balance ? formatDecimal(p.balance) : "?"
            }`,
            url: playerLink(p.playerUuid),
            color: COLOURS.money,
            fields: [
              {
                name: "Dormant",
                value:
                  p.daysInactive === null
                    ? sinceLabel(p.lastSeenAt)
                    : `${p.daysInactive} days`,
                inline: true,
              },
              {
                name: "Last seen",
                value: p.lastSeenAt
                  ? p.lastSeenAt.toISOString().slice(0, 10)
                  : "unknown",
                inline: true,
              },
              ...(flags.length > 0
                ? [{ name: "Flags", value: flags.join(", "), inline: true }]
                : []),
            ],
            footer: { text: "Prune candidate" },
          };
        },
        (p) => [p.playerUuid],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 3. New at-risk properties, batched by holder
// ---------------------------------------------------------------------------

interface AtRiskItem {
  entityKey: string;
  worldUuid: string;
  worldName: string | null;
  wgRegionId: string;
  playerUuid: string;
  playerName: string | null;
  category: string | null;
  contractType: string | null;
  isBanned: boolean;
  isLongDeported: boolean;
  isOverLimit: boolean;
  playtime30dMs: number | null;
  limitCount: number | null;
  limitValue: number | null;
}

export interface AtRiskGroup {
  playerUuid: string;
  playerName: string | null;
  properties: AtRiskItem[];
}

/** `world:region` — unique per plot, and stable across renames. */
const AT_RISK_KEY = sql`v.world_uuid::text || ':' || v.wg_region_id`;

function atRiskWhere(): SQL {
  const thresholdMs = getEnv().INACTIVITY_THRESHOLD_HOURS * HOUR_MS;
  return sql`
    v.role IN ('titleholder','landlord')
    AND ${atRiskFlaggedSql(thresholdMs)}
    AND NOT v.is_excluded
    AND NOT v.has_active_report
  `;
}

/**
 * Group a holder's plots into one alert.
 *
 * Requested explicitly, and for a good reason: a banned player holding
 * fourteen plots is *one* thing that happened. Fourteen separate messages
 * would read as fourteen events and bury everything else in the channel.
 */
export function groupByPlayer(items: AtRiskItem[]): AtRiskGroup[] {
  const groups = new Map<string, AtRiskGroup>();
  for (const item of items) {
    const existing = groups.get(item.playerUuid);
    if (existing) {
      existing.properties.push(item);
    } else {
      groups.set(item.playerUuid, {
        playerUuid: item.playerUuid,
        playerName: item.playerName,
        properties: [item],
      });
    }
  }
  return [...groups.values()];
}

/** Why this plot is on the list, in the words the at-risk table uses. */
export function atRiskReasons(item: AtRiskItem, thresholdMs: number): string[] {
  const reasons: string[] = [];
  if (item.isBanned) reasons.push("banned");
  if (item.isLongDeported) reasons.push("deported");
  if (
    item.playtime30dMs !== null &&
    item.playtime30dMs < thresholdMs &&
    !item.isBanned
  ) {
    reasons.push(`${(item.playtime30dMs / HOUR_MS).toFixed(1)}h/30d`);
  }
  if (item.isOverLimit) {
    reasons.push(`over limit ${item.limitCount ?? "?"}/${item.limitValue ?? "?"}`);
  }
  return reasons;
}

export function atRiskChannel(): NotifyChannel<AtRiskGroup> {
  const thresholdMs = getEnv().INACTIVITY_THRESHOLD_HOURS * HOUR_MS;

  return {
    channel: "at-risk",
    webhookUrl: getEnv().DISCORD_WEBHOOK_AT_RISK,

    seedQuery(): SQL {
      return sql`
        WITH ${atRiskRowsCte()}
        SELECT ${AT_RISK_KEY} AS entity_key
          FROM at_risk_rows v
         WHERE ${atRiskWhere()}
      `;
    },

    /**
     * `limit` bounds *holders*, not plots, so one player's properties are never
     * split across two runs — a batch that arrived in halves would defeat the
     * grouping. A holder with many plots therefore exceeds the nominal item cap
     * by design; the message clamp keeps the payload legal.
     */
    async findNew(limit: number): Promise<AtRiskGroup[]> {
      const result = await db.execute<Record<string, unknown>>(sql`
        WITH ${atRiskRowsCte()},
        new_rows AS (
          SELECT ${AT_RISK_KEY} AS entity_key,
                 v.world_uuid, v.world_name, v.wg_region_id,
                 v.player_uuid, v.player_name, v.category, v.contract_type,
                 v.is_banned, v.is_long_deported, v.is_over_limit,
                 v.playtime_30d_ms, v.limit_count, v.limit_value
            FROM at_risk_rows v
            LEFT JOIN notification_deliveries d
                   ON d.channel = 'at-risk' AND d.entity_key = ${AT_RISK_KEY}
           WHERE ${atRiskWhere()}
             AND d.entity_key IS NULL
        ),
        holders AS (
          SELECT player_uuid
            FROM new_rows
           GROUP BY player_uuid
           ORDER BY count(*) DESC, player_uuid
           LIMIT ${limit}
        )
        SELECT n.*
          FROM new_rows n
          JOIN holders h ON h.player_uuid = n.player_uuid
         ORDER BY n.player_uuid, n.wg_region_id
      `);

      return groupByPlayer(
        result.rows.map((row) => ({
          entityKey: String(row.entity_key),
          worldUuid: String(row.world_uuid),
          worldName: toText(row.world_name),
          wgRegionId: String(row.wg_region_id),
          playerUuid: String(row.player_uuid),
          playerName: toText(row.player_name),
          category: toText(row.category),
          contractType: toText(row.contract_type),
          isBanned: toBool(row.is_banned),
          isLongDeported: toBool(row.is_long_deported),
          isOverLimit: toBool(row.is_over_limit),
          playtime30dMs: toNumber(row.playtime_30d_ms),
          limitCount: toNumber(row.limit_count),
          limitValue: toNumber(row.limit_value),
        })),
      );
    },

    build(groups) {
      return chunk(
        groups,
        itemsPerMessage(),
        (g) => {
          const who = g.playerName ?? g.playerUuid.slice(0, 8);
          // The plot list is the payload here, so it goes in the description
          // where there is room for it rather than in a 1,024-char field.
          const lines = g.properties.slice(0, 40).map((p) => {
            const zoning = categoryDefinition(p.category ?? "other").label;
            const reasons = atRiskReasons(p, thresholdMs).join(", ");
            const url = link(
              `/regions/${p.worldUuid}/${encodeURIComponent(p.wgRegionId)}`,
            );
            const name = url ? `[${p.wgRegionId}](${url})` : p.wgRegionId;
            return `• ${name} — ${zoning}${
              p.contractType ? `, ${p.contractType}` : ""
            }${reasons ? ` (${reasons})` : ""}`;
          });
          const hidden = g.properties.length - lines.length;
          if (hidden > 0) lines.push(`• …and ${hidden} more`);

          return {
            title: `${who} — ${g.properties.length} at-risk ${
              g.properties.length === 1 ? "property" : "properties"
            }`,
            url: playerLink(g.playerUuid),
            color: COLOURS.atRisk,
            description: lines.join("\n"),
            footer: { text: "At-risk property" },
          };
        },
        (g) => g.properties.map((p) => p.entityKey),
      );
    },
  };
}
