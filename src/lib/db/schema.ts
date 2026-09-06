import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Every player UUID in this schema is normalised to lowercase dashed form on
 * ingest (see `normalizeUuid`). The Minecraft UUID is the only key shared by all
 * four upstream APIs, so it is the join column for the entire application.
 *
 * Money and prices use **unconstrained** `numeric`. A fixed numeric(38,4) threw
 * "numeric field overflow" on real data: this economy has hyperinflated values,
 * and Realty's own /v1/stats reports an average price around 2.8e58.
 */

const now = () => timestamp("", { withTimezone: true }).defaultNow().notNull();
void now; // documentation aid; per-column definitions below spell it out.

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const players = pgTable(
  "players",
  {
    uuid: uuid("uuid").primaryKey(),
    name: text("name"),
    /** Lower-cased name for lookups. WorldGuard legacy entries are lower-cased
     *  by the server, and Floodgate/Bedrock names may contain spaces. */
    nameLower: text("name_lower"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("players_name_lower_idx").on(t.nameLower)],
);

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** One row per player from the bulk `GET /v1/playersTable` call. */
export const playerAnalytics = pgTable(
  "player_analytics",
  {
    playerUuid: uuid("player_uuid")
      .primaryKey()
      .references(() => players.uuid, { onDelete: "cascade" }),
    /** Lifetime active playtime in milliseconds (Plan subtracts AFK time). */
    playtimeActiveMs: bigint("playtime_active_ms", { mode: "number" }),
    sessionCount: bigint("session_count", { mode: "number" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    registeredAt: timestamp("registered_at", { withTimezone: true }),
    activityIndex: doublePrecision("activity_index"),
    country: text("country"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("player_analytics_last_seen_idx").on(t.lastSeenAt)],
);

/**
 * Per-player windowed playtime from `GET /v1/player?player=<uuid>`, read out of
 * `online_activity.active_playtime_30d`. This is the N+1 call, so
 * `lifetimePlaytimeAtFetchMs` records the lifetime total observed at fetch time:
 * if the lifetime total has not moved since, no new play has occurred and the
 * 30-day figure can only have decreased, so a refetch can be skipped.
 */
export const playerActivityWindow = pgTable(
  "player_activity_window",
  {
    playerUuid: uuid("player_uuid")
      .primaryKey()
      .references(() => players.uuid, { onDelete: "cascade" }),
    activePlaytime30dMs: bigint("active_playtime_30d_ms", { mode: "number" }),
    lifetimePlaytimeAtFetchMs: bigint("lifetime_playtime_at_fetch_ms", {
      mode: "number",
    }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Full upstream payload — the endpoint is untyped in the OpenAPI spec. */
    raw: jsonb("raw"),
  },
  (t) => [index("player_activity_window_fetched_idx").on(t.fetchedAt)],
);

// ---------------------------------------------------------------------------
// Punishments
// ---------------------------------------------------------------------------

/**
 * Live-API notes — the deployed service differs materially from its OpenAPI
 * spec, so these columns follow observed behaviour (see docs/probes/):
 *
 *   - Records carry **no id**. `id` here is a synthetic content hash.
 *   - Fields are `victimUuid`/`victimUsername`, not `victim`/`victimName`.
 *   - Timestamps are epoch **seconds**, not milliseconds.
 *   - Permanent is `end == 0`, not `-1`.
 *   - There is no `type` or `scope` field; type comes from the endpoint used.
 *   - The `active` boolean is **always false** upstream and is not trustworthy.
 *     `label` ("Permanent" | "Active" | "Expired") is the real status, and it
 *     agrees with comparing `end` to the current time.
 */
export const punishments = pgTable(
  "punishments",
  {
    /** Synthetic: sha1 of type + victim + start + reason. Upstream has no id. */
    id: text("id").primaryKey(),
    type: text("type").notNull(), // BAN | MUTE — derived from the endpoint
    /** Raw victim value: a UUID *or* an IP address (LibertyBans supports both). */
    victimRaw: text("victim_raw").notNull(),
    victimKind: text("victim_kind").notNull(), // uuid | ip
    /** Null when the punishment targets an IP rather than a player. */
    victimUuid: uuid("victim_uuid"),
    victimName: text("victim_name"),
    operatorUuid: uuid("operator_uuid"),
    operatorName: text("operator_name"),
    reason: text("reason").notNull(),
    /** Upstream status word: Permanent | Active | Expired. */
    label: text("label"),
    /** Upstream `active` flag, recorded verbatim. Observed always false. */
    reportedActive: boolean("reported_active"),
    startAt: timestamp("start_at", { withTimezone: true }),
    /** Null when upstream `end` is 0, which means permanent. */
    endAt: timestamp("end_at", { withTimezone: true }),
    isPermanent: boolean("is_permanent").notNull().default(false),
    /**
     * "Deported" players carry "Deportation" in the free-text reason — there is
     * no dedicated field upstream.
     *
     * Not restricted to MUTE: deportations are issued as WARNs at least as
     * often (verified against in-game punishment history), and the WARN records
     * are the ones carrying a real duration and an "Expired" label.
     */
    isDeportation: boolean("is_deportation").generatedAlwaysAs(
      sql`("reason" ILIKE '%deportation%')`,
    ),
    /**
     * Parsed out of the reason text (see sources/punishments/deportation.ts).
     * The underlying WARN is often INFINITE, so these — not `end_at` — decide
     * whether a deportation is still in force.
     */
    deportationCompletedAt: timestamp("deportation_completed_at", {
      withTimezone: true,
    }),
    deportationExpiresAt: timestamp("deportation_expires_at", {
      withTimezone: true,
    }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Stamped by every crawl that observes this row. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Set when a completed crawl did not observe a row that was present before.
     * The API exposes no revoked/undone flag, so disappearance is the best
     * available proxy for a lifted punishment.
     */
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => [
    index("punishments_victim_uuid_idx").on(t.victimUuid),
    index("punishments_type_idx").on(t.type),
    index("punishments_end_at_idx").on(t.endAt),
  ],
);

/**
 * Players whose properties are deliberately kept out of the at-risk list.
 *
 * Some flagged holders are legitimate — server staff, government accounts,
 * agreed exceptions — and re-triaging them on every review wastes time. This is
 * curation state owned by the operator, so it is never touched by a sync and
 * survives every re-crawl.
 */
export const playerExclusions = pgTable("player_exclusions", {
  playerUuid: uuid("player_uuid")
    .primaryKey()
    .references(() => players.uuid, { onDelete: "cascade" }),
  /** Why this player is exempt — shown on the exclusions page. */
  reason: text("reason"),
  excludedAt: timestamp("excluded_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Players confirmed to hold the realtor job.
 *
 * PSA §17(9) lets a realtor exceed most plot limits by 5, and **no API exposes
 * the job** — the inspector guide's `/about <player>` is the only source. So
 * this is operator state, like `player_exclusions`: someone checks in game and
 * records it. Without a row a holder over the limit is reported as "check
 * realtor status" rather than as a violation, which is the honest answer.
 */
export const playerRealtors = pgTable("player_realtors", {
  playerUuid: uuid("player_uuid")
    .primaryKey()
    .references(() => players.uuid, { onDelete: "cascade" }),
  /** How it was confirmed — free text, shown next to the badge. */
  note: text("note"),
  markedAt: timestamp("marked_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ---------------------------------------------------------------------------
// Realty
// ---------------------------------------------------------------------------

export const worlds = pgTable("worlds", {
  uuid: uuid("uuid").primaryKey(),
  name: text("name"),
  syncedAt: timestamp("synced_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const regions = pgTable(
  "regions",
  {
    worldUuid: uuid("world_uuid")
      .notNull()
      .references(() => worlds.uuid, { onDelete: "cascade" }),
    wgRegionId: text("wg_region_id").notNull(),
    /** Null for a registered region carrying no contract at all. */
    state: text("state"),
    contractType: text("contract_type"), // freehold | leasehold
    /**
     * Zoning taken from the plot's Realty tags — the server's own
     * classification — falling back to the id prefix only for the few
     * categories with no tag equivalent. See lib/plots/categories.ts, where the
     * rules are unit tested. Purely a function of stored data, so
     * `npm run reclassify` re-derives it locally without touching an API.
     */
    category: text("category"),
    /**
     * Area the plot sits in. Oakridge and Aventura are exempt from the
     * standard limits under PSA §17(10); Willow is treated the same way.
     */
    area: text("area"),
    /** Where `category` came from: tag | prefix | none. */
    categorySource: text("category_source"),
    tags: text("tags").array(),
    dimensions: jsonb("dimensions"),
    /** Null until full state has been fetched from `/v1/region`. */
    detailFetchedAt: timestamp("detail_fetched_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    raw: jsonb("raw"),
  },
  (t) => [
    primaryKey({ columns: [t.worldUuid, t.wgRegionId] }),
    index("regions_state_idx").on(t.state),
    index("regions_detail_fetched_idx").on(t.detailFetchedAt),
    index("regions_category_idx").on(t.category),
  ],
);

export const regionFreehold = pgTable(
  "region_freehold",
  {
    worldUuid: uuid("world_uuid").notNull(),
    wgRegionId: text("wg_region_id").notNull(),
    /** The owner. */
    titleholderUuid: uuid("titleholder_uuid"),
    /** Granting/oversight party — required upstream, distinct from the owner. */
    authorityUuid: uuid("authority_uuid"),
    /** Null means the region is not currently for sale. */
    price: numeric("price"),
    lastSoldPrice: numeric("last_sold_price"),
    acceptingOffers: boolean("accepting_offers"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldUuid, t.wgRegionId] }),
    index("region_freehold_titleholder_idx").on(t.titleholderUuid),
  ],
);

export const regionLeasehold = pgTable(
  "region_leasehold",
  {
    worldUuid: uuid("world_uuid").notNull(),
    wgRegionId: text("wg_region_id").notNull(),
    landlordUuid: uuid("landlord_uuid"),
    tenantUuid: uuid("tenant_uuid"),
    price: numeric("price"),
    durationSeconds: bigint("duration_seconds", { mode: "number" }),
    startAt: timestamp("start_at", { withTimezone: true }),
    /** Lease expiry. Derived locally — never polled for. */
    endAt: timestamp("end_at", { withTimezone: true }),
    extensionsUsed: integer("extensions_used"),
    /** Null means unlimited. */
    maxExtensions: integer("max_extensions"),
    /** Read as "ending", not "ended". */
    terminationEffectiveAt: timestamp("termination_effective_at", {
      withTimezone: true,
    }),
    terminatedByRole: text("terminated_by_role"),
    acceptingTenants: boolean("accepting_tenants"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldUuid, t.wgRegionId] }),
    index("region_leasehold_landlord_idx").on(t.landlordUuid),
    index("region_leasehold_tenant_idx").on(t.tenantUuid),
    index("region_leasehold_end_at_idx").on(t.endAt),
  ],
);

export const regionAuctions = pgTable(
  "region_auctions",
  {
    worldUuid: uuid("world_uuid").notNull(),
    wgRegionId: text("wg_region_id").notNull(),
    auctioneerUuid: uuid("auctioneer_uuid"),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    minBid: numeric("min_bid"),
    minStep: numeric("min_step"),
    biddingDurationSeconds: bigint("bidding_duration_seconds", {
      mode: "number",
    }),
    paymentDurationSeconds: bigint("payment_duration_seconds", {
      mode: "number",
    }),
    highestBidderUuid: uuid("highest_bidder_uuid"),
    highestBidAmount: numeric("highest_bid_amount"),
    bidderCount: integer("bidder_count"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldUuid, t.wgRegionId] })],
);

/**
 * WorldGuard owners/members — a co-owner surface entirely separate from
 * Realty's titleholder/tenant concept. Legacy entries carry a lower-cased name
 * with no UUID; group entries carry neither.
 */
export const regionMembers = pgTable(
  "region_members",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    worldUuid: uuid("world_uuid").notNull(),
    wgRegionId: text("wg_region_id").notNull(),
    domain: text("domain").notNull(), // owner | member
    entryKind: text("entry_kind").notNull(), // player | legacy_name | group
    playerUuid: uuid("player_uuid"),
    playerName: text("player_name"),
    groupName: text("group_name"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("region_members_region_idx").on(t.worldUuid, t.wgRegionId),
    index("region_members_player_idx").on(t.playerUuid),
  ],
);

/**
 * The `/v1/activity` event feed. Events carry no upstream id, so `dedupeHash`
 * is a content hash used to make ingestion idempotent.
 */
export const realtyActivity = pgTable(
  "realty_activity",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    dedupeHash: text("dedupe_hash").notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(), // freehold | leasehold | agent
    eventType: text("event_type").notNull(),
    worldUuid: uuid("world_uuid"),
    wgRegionId: text("wg_region_id"),
    actorUuid: uuid("actor_uuid"),
    buyerUuid: uuid("buyer_uuid"),
    tenantUuid: uuid("tenant_uuid"),
    landlordUuid: uuid("landlord_uuid"),
    agentUuid: uuid("agent_uuid"),
    authorityUuid: uuid("authority_uuid"),
    price: numeric("price"),
    durationSeconds: bigint("duration_seconds", { mode: "number" }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    raw: jsonb("raw"),
  },
  (t) => [
    uniqueIndex("realty_activity_dedupe_idx").on(t.dedupeHash),
    index("realty_activity_event_time_idx").on(t.eventTime),
    index("realty_activity_region_idx").on(t.worldUuid, t.wgRegionId),
  ],
);

// ---------------------------------------------------------------------------
// Treasury
// ---------------------------------------------------------------------------

/**
 * `accountId` is stable, so this mapping is resolved once per player and never
 * re-resolved. It is the single largest N+1 in the system.
 */
export const treasuryAccounts = pgTable(
  "treasury_accounts",
  {
    accountId: bigint("account_id", { mode: "number" }).primaryKey(),
    playerUuid: uuid("player_uuid").unique(),
    playerName: text("player_name"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("treasury_accounts_player_idx").on(t.playerUuid)],
);

/**
 * Players Treasury has no account for.
 *
 * `/accounts/by-player` 404s for anyone who never touched the economy, and that
 * answer is not stored anywhere else — without recording it the resolve sweep
 * re-asks the same players on every pass and the backfill never converges past
 * them. Stakeholders miss rarely (5 of 1,515), but the prune sweep walks the
 * whole roster, where one-session visitors are the norm.
 *
 * `checkedAt` lets a miss age out: an account can be created later, so the
 * sweep re-checks after `MISS_RECHECK_DAYS` rather than writing a player off
 * forever.
 */
export const treasuryAccountMisses = pgTable(
  "treasury_account_misses",
  {
    playerUuid: uuid("player_uuid")
      .primaryKey()
      .references(() => players.uuid, { onDelete: "cascade" }),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("treasury_account_misses_checked_idx").on(t.checkedAt)],
);

/**
 * Money is a decimal string upstream and must never round-trip through a JS
 * number. `balanceRaw` preserves the exact upstream string; `balance` is the
 * Postgres numeric for querying.
 */
export const treasuryBalances = pgTable("treasury_balances", {
  accountId: bigint("account_id", { mode: "number" }).primaryKey(),
  balance: numeric("balance"),
  balanceRaw: text("balance_raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const firms = pgTable("firms", {
  firmId: bigint("firm_id", { mode: "number" }).primaryKey(),
  displayName: text("display_name"),
  discordUrl: text("discord_url"),
  /** Looks like a WorldGuard region id, but carries no world — join is ambiguous. */
  hqRegion: text("hq_region"),
  archived: boolean("archived"),
  defaultAccountId: bigint("default_account_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }),
  totalBalance: numeric("total_balance"),
  totalBalanceRaw: text("total_balance_raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * What has already been announced to Discord.
 *
 * One row per (channel, thing), inserted when a notification is *successfully*
 * delivered — so a webhook that fails is retried rather than silently skipped,
 * and a thing that has been announced is never announced twice.
 *
 * `disposition` separates the two ways a row gets here:
 *
 *   sent    a message went out for it
 *   seeded  it already qualified when the channel was first configured, and was
 *           recorded *without* sending to establish a baseline
 *
 * The seed pass is what makes enabling a webhook safe. Without it, the first
 * run of the punishments notifier would announce every ban in the database.
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    /** Which alert channel: `punishments`, `prune`, `at-risk`. */
    channel: text("channel").notNull(),
    /**
     * Identifies the announced thing *within* its channel: a punishment's
     * content hash, a player uuid, or `world:region`.
     */
    entityKey: text("entity_key").notNull(),
    disposition: text("disposition").notNull().default("sent"),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channel, t.entityKey] }),
    index("notification_deliveries_channel_idx").on(t.channel, t.sentAt),
  ],
);

export const evictionReports = pgTable(
  "eviction_reports",
  {
    /** XenForo thread id, from the RSS <guid>. */
    threadId: text("thread_id").primaryKey(),
    /**
     * Which forum the thread was last seen in: `reports` (open) or `archive`
     * (dealt with). Threads move from one to the other, and since both feeds
     * key on the same thread id, the archive pass simply reclassifies them.
     */
    feed: text("feed").notNull().default("reports"),
    title: text("title").notNull(),
    /** Leading thread prefix, if the title carries one. */
    prefix: text("prefix"),
    /** False once the prefix marks the report finished. */
    isActive: boolean("is_active").notNull().default(true),
    /**
     * How this row got here: `forum` for anything a listing crawl produced,
     * `manual` for a report an inspector pasted into the region page before any
     * crawl had seen it.
     *
     * A manual row is provisional — its title is whatever the report kit
     * suggested, and it carries no author or posted date until the forum
     * confirms it. That matters because an active report *suppresses its plot
     * from the at-risk list*, so "we were told this exists" must stay
     * distinguishable from "we have seen it on the forum". The listing upsert
     * sets this back to `forum` the moment the crawl catches up.
     */
    source: text("source").notNull().default("forum"),
    url: text("url").notNull(),
    author: text("author"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    /**
     * The eviction date stated in the title (`c176/c177 | Sep 10, 2026`).
     * Every real report carries one, and none carries a thread prefix, so this
     * is the only per-report state the feed exposes.
     */
    evictionDate: timestamp("eviction_date", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("eviction_reports_active_idx").on(t.isActive),
    index("eviction_reports_posted_idx").on(t.postedAt),
    index("eviction_reports_eviction_date_idx").on(t.evictionDate),
    index("eviction_reports_feed_idx").on(t.feed),
  ],
);

/**
 * Regions named by a report. A single thread often covers several plots — the
 * title "c176/c177" is two regions — so this is a join table, resolved by
 * matching title tokens against known region ids.
 */
export const evictionReportRegions = pgTable(
  "eviction_report_regions",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => evictionReports.threadId, { onDelete: "cascade" }),
    worldUuid: uuid("world_uuid").notNull(),
    wgRegionId: text("wg_region_id").notNull(),
    /**
     * `parsed` links are re-derived on every crawl; `manual` ones are an
     * operator decision and are never touched by a sync. Without this a
     * hand-assigned region would be wiped the next time the thread's page was
     * re-read.
     */
    source: text("source").notNull().default("parsed"),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.worldUuid, t.wgRegionId] }),
    index("eviction_report_regions_region_idx").on(t.worldUuid, t.wgRegionId),
  ],
);

/**
 * Merged plots — several sub-plots forming one property.
 *
 * Derived locally from eviction reports that name more than one plot, then
 * validated against ownership and adjacency (see lib/plots/merge.ts). Rejected
 * candidates are kept with their reason rather than discarded: a report naming
 * plots with different owners usually means something is wrong and is worth
 * seeing.
 */
export const plotMergeGroups = pgTable(
  "plot_merge_groups",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** The report that named these plots together. */
    threadId: text("thread_id").notNull(),
    /** merged | rejected */
    status: text("status").notNull(),
    /** Why a candidate was rejected; null when merged. */
    reason: text("reason"),
    /** Shared owner, when the group has one. */
    ownerUuid: uuid("owner_uuid"),
    memberCount: integer("member_count").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("plot_merge_groups_thread_idx").on(t.threadId),
    index("plot_merge_groups_status_idx").on(t.status),
  ],
);

export const plotMergeMembers = pgTable(
  "plot_merge_members",
  {
    groupId: bigint("group_id", { mode: "number" })
      .notNull()
      .references(() => plotMergeGroups.id, { onDelete: "cascade" }),
    worldUuid: uuid("world_uuid").notNull(),
    wgRegionId: text("wg_region_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.worldUuid, t.wgRegionId] }),
    index("plot_merge_members_region_idx").on(t.worldUuid, t.wgRegionId),
  ],
);

// ---------------------------------------------------------------------------
// Sync infrastructure
// ---------------------------------------------------------------------------

export const syncJobs = pgTable(
  "sync_jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    /** Stable key making re-enqueues of the same work idempotent. */
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload"),
    /** Lower runs sooner. */
    priority: integer("priority").notNull().default(100),
    runAfter: timestamp("run_after", { withTimezone: true })
      .defaultNow()
      .notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    status: text("status").notNull().default("pending"), // pending|running|done|failed|dead
    lastError: text("last_error"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Only one live job per (kind, dedupeKey); completed rows may repeat.
    uniqueIndex("sync_jobs_live_dedupe_idx")
      .on(t.kind, t.dedupeKey)
      .where(sql`status IN ('pending', 'running')`),
    index("sync_jobs_claim_idx").on(t.status, t.priority, t.runAfter),
  ],
);

export const syncWatermarks = pgTable(
  "sync_watermarks",
  {
    source: text("source").notNull(),
    key: text("key").notNull(),
    cursorText: text("cursor_text"),
    cursorInt: bigint("cursor_int", { mode: "number" }),
    cursorTime: timestamp("cursor_time", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.key] })],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    requestsMade: integer("requests_made").notNull().default(0),
    itemsUpserted: integer("items_upserted").notNull().default(0),
    itemsRemoved: integer("items_removed").notNull().default(0),
    status: text("status").notNull().default("running"), // running|ok|error|skipped
    note: text("note"),
    error: text("error"),
  },
  (t) => [index("sync_runs_kind_started_idx").on(t.kind, t.startedAt)],
);

/** Rolling request log powering the sync-health page. Pruned to 7 days. */
export const apiRequests = pgTable(
  "api_requests",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    source: text("source").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status"),
    durationMs: integer("duration_ms"),
    retries: integer("retries").notNull().default(0),
    rateLimitLimit: integer("rate_limit_limit"),
    rateLimitRemaining: integer("rate_limit_remaining"),
    error: text("error"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("api_requests_source_at_idx").on(t.source, t.at)],
);

/** Persisted circuit-breaker state, so a restart doesn't stampede a sick upstream. */
export const sourceHealth = pgTable("source_health", {
  source: text("source").primaryKey(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  circuitOpenUntil: timestamp("circuit_open_until", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
