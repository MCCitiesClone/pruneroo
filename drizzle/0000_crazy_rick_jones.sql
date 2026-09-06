CREATE TABLE "api_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer,
	"duration_ms" integer,
	"retries" integer DEFAULT 0 NOT NULL,
	"rate_limit_limit" integer,
	"rate_limit_remaining" integer,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chestshop_shops" (
	"shop_id" bigint PRIMARY KEY NOT NULL,
	"world_name" text,
	"x" integer,
	"y" integer,
	"z" integer,
	"admin_shop" boolean,
	"account_type" text,
	"firm_id" bigint,
	"owner_uuid" uuid,
	"owner_name" text,
	"material" text,
	"item_key" text,
	"item_name" text,
	"buy_price" numeric(38, 4),
	"buy_price_raw" text,
	"sell_price" numeric(38, 4),
	"sell_price_raw" text,
	"batch_qty" integer,
	"current_stock" integer,
	"stock_at" timestamp with time zone,
	"last_seen" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"firm_id" bigint PRIMARY KEY NOT NULL,
	"display_name" text,
	"discord_url" text,
	"hq_region" text,
	"archived" boolean,
	"default_account_id" bigint,
	"created_at" timestamp with time zone,
	"total_balance" numeric(38, 4),
	"total_balance_raw" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_activity_window" (
	"player_uuid" uuid PRIMARY KEY NOT NULL,
	"active_playtime_30d_ms" bigint,
	"lifetime_playtime_at_fetch_ms" bigint,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "player_analytics" (
	"player_uuid" uuid PRIMARY KEY NOT NULL,
	"playtime_active_ms" bigint,
	"session_count" bigint,
	"last_seen_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	"activity_index" double precision,
	"country" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"name_lower" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "punishments" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"victim_raw" text NOT NULL,
	"victim_kind" text NOT NULL,
	"victim_uuid" uuid,
	"victim_name" text,
	"operator_uuid" uuid,
	"operator_name" text,
	"reason" text NOT NULL,
	"label" text,
	"reported_active" boolean,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"is_permanent" boolean DEFAULT false NOT NULL,
	"is_deportation" boolean GENERATED ALWAYS AS (("type" = 'MUTE' AND "reason" ILIKE '%deportation%')) STORED,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "realty_activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dedupe_hash" text NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"event_type" text NOT NULL,
	"world_uuid" uuid,
	"wg_region_id" text,
	"actor_uuid" uuid,
	"buyer_uuid" uuid,
	"tenant_uuid" uuid,
	"landlord_uuid" uuid,
	"agent_uuid" uuid,
	"authority_uuid" uuid,
	"price" numeric(38, 4),
	"duration_seconds" bigint,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "region_auctions" (
	"world_uuid" uuid NOT NULL,
	"wg_region_id" text NOT NULL,
	"auctioneer_uuid" uuid,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"min_bid" numeric(38, 4),
	"min_step" numeric(38, 4),
	"bidding_duration_seconds" bigint,
	"payment_duration_seconds" bigint,
	"highest_bidder_uuid" uuid,
	"highest_bid_amount" numeric(38, 4),
	"bidder_count" integer,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_auctions_world_uuid_wg_region_id_pk" PRIMARY KEY("world_uuid","wg_region_id")
);
--> statement-breakpoint
CREATE TABLE "region_freehold" (
	"world_uuid" uuid NOT NULL,
	"wg_region_id" text NOT NULL,
	"titleholder_uuid" uuid,
	"authority_uuid" uuid,
	"price" numeric(38, 4),
	"last_sold_price" numeric(38, 4),
	"accepting_offers" boolean,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_freehold_world_uuid_wg_region_id_pk" PRIMARY KEY("world_uuid","wg_region_id")
);
--> statement-breakpoint
CREATE TABLE "region_leasehold" (
	"world_uuid" uuid NOT NULL,
	"wg_region_id" text NOT NULL,
	"landlord_uuid" uuid,
	"tenant_uuid" uuid,
	"price" numeric(38, 4),
	"duration_seconds" bigint,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"extensions_used" integer,
	"max_extensions" integer,
	"termination_effective_at" timestamp with time zone,
	"terminated_by_role" text,
	"accepting_tenants" boolean,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_leasehold_world_uuid_wg_region_id_pk" PRIMARY KEY("world_uuid","wg_region_id")
);
--> statement-breakpoint
CREATE TABLE "region_members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"world_uuid" uuid NOT NULL,
	"wg_region_id" text NOT NULL,
	"domain" text NOT NULL,
	"entry_kind" text NOT NULL,
	"player_uuid" uuid,
	"player_name" text,
	"group_name" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"world_uuid" uuid NOT NULL,
	"wg_region_id" text NOT NULL,
	"state" text,
	"contract_type" text,
	"tags" text[],
	"dimensions" jsonb,
	"detail_fetched_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb,
	CONSTRAINT "regions_world_uuid_wg_region_id_pk" PRIMARY KEY("world_uuid","wg_region_id")
);
--> statement-breakpoint
CREATE TABLE "source_health" (
	"source" text PRIMARY KEY NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"circuit_open_until" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb,
	"priority" integer DEFAULT 100 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"requests_made" integer DEFAULT 0 NOT NULL,
	"items_upserted" integer DEFAULT 0 NOT NULL,
	"items_removed" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"note" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sync_watermarks" (
	"source" text NOT NULL,
	"key" text NOT NULL,
	"cursor_text" text,
	"cursor_int" bigint,
	"cursor_time" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_watermarks_source_key_pk" PRIMARY KEY("source","key")
);
--> statement-breakpoint
CREATE TABLE "treasury_accounts" (
	"account_id" bigint PRIMARY KEY NOT NULL,
	"player_uuid" uuid,
	"player_name" text,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_accounts_player_uuid_unique" UNIQUE("player_uuid")
);
--> statement-breakpoint
CREATE TABLE "treasury_balances" (
	"account_id" bigint PRIMARY KEY NOT NULL,
	"balance" numeric(38, 4),
	"balance_raw" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_activity_window" ADD CONSTRAINT "player_activity_window_player_uuid_players_uuid_fk" FOREIGN KEY ("player_uuid") REFERENCES "public"."players"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_analytics" ADD CONSTRAINT "player_analytics_player_uuid_players_uuid_fk" FOREIGN KEY ("player_uuid") REFERENCES "public"."players"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regions" ADD CONSTRAINT "regions_world_uuid_worlds_uuid_fk" FOREIGN KEY ("world_uuid") REFERENCES "public"."worlds"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_requests_source_at_idx" ON "api_requests" USING btree ("source","at");--> statement-breakpoint
CREATE INDEX "chestshop_owner_idx" ON "chestshop_shops" USING btree ("owner_uuid");--> statement-breakpoint
CREATE INDEX "chestshop_firm_idx" ON "chestshop_shops" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "player_activity_window_fetched_idx" ON "player_activity_window" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "player_analytics_last_seen_idx" ON "player_analytics" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "players_name_lower_idx" ON "players" USING btree ("name_lower");--> statement-breakpoint
CREATE INDEX "punishments_victim_uuid_idx" ON "punishments" USING btree ("victim_uuid");--> statement-breakpoint
CREATE INDEX "punishments_type_idx" ON "punishments" USING btree ("type");--> statement-breakpoint
CREATE INDEX "punishments_end_at_idx" ON "punishments" USING btree ("end_at");--> statement-breakpoint
CREATE UNIQUE INDEX "realty_activity_dedupe_idx" ON "realty_activity" USING btree ("dedupe_hash");--> statement-breakpoint
CREATE INDEX "realty_activity_event_time_idx" ON "realty_activity" USING btree ("event_time");--> statement-breakpoint
CREATE INDEX "realty_activity_region_idx" ON "realty_activity" USING btree ("world_uuid","wg_region_id");--> statement-breakpoint
CREATE INDEX "region_freehold_titleholder_idx" ON "region_freehold" USING btree ("titleholder_uuid");--> statement-breakpoint
CREATE INDEX "region_leasehold_landlord_idx" ON "region_leasehold" USING btree ("landlord_uuid");--> statement-breakpoint
CREATE INDEX "region_leasehold_tenant_idx" ON "region_leasehold" USING btree ("tenant_uuid");--> statement-breakpoint
CREATE INDEX "region_leasehold_end_at_idx" ON "region_leasehold" USING btree ("end_at");--> statement-breakpoint
CREATE INDEX "region_members_region_idx" ON "region_members" USING btree ("world_uuid","wg_region_id");--> statement-breakpoint
CREATE INDEX "region_members_player_idx" ON "region_members" USING btree ("player_uuid");--> statement-breakpoint
CREATE INDEX "regions_state_idx" ON "regions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "regions_detail_fetched_idx" ON "regions" USING btree ("detail_fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_jobs_live_dedupe_idx" ON "sync_jobs" USING btree ("kind","dedupe_key") WHERE status IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "sync_jobs_claim_idx" ON "sync_jobs" USING btree ("status","priority","run_after");--> statement-breakpoint
CREATE INDEX "sync_runs_kind_started_idx" ON "sync_runs" USING btree ("kind","started_at");--> statement-breakpoint
CREATE INDEX "treasury_accounts_player_idx" ON "treasury_accounts" USING btree ("player_uuid");