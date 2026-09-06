-- The insight views select these columns, so they block an ALTER TYPE.
-- scripts/migrate.ts re-applies views.sql immediately after migrations.
DROP VIEW IF EXISTS "v_property_stakeholder_flags" CASCADE;--> statement-breakpoint
DROP VIEW IF EXISTS "v_player_flags" CASCADE;--> statement-breakpoint
DROP VIEW IF EXISTS "v_active_punishments" CASCADE;--> statement-breakpoint
DROP VIEW IF EXISTS "v_region_stakeholders" CASCADE;--> statement-breakpoint
ALTER TABLE "chestshop_shops" ALTER COLUMN "buy_price" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "chestshop_shops" ALTER COLUMN "sell_price" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "firms" ALTER COLUMN "total_balance" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "realty_activity" ALTER COLUMN "price" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "region_auctions" ALTER COLUMN "min_bid" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "region_auctions" ALTER COLUMN "min_step" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "region_auctions" ALTER COLUMN "highest_bid_amount" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "region_freehold" ALTER COLUMN "price" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "region_freehold" ALTER COLUMN "last_sold_price" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "region_leasehold" ALTER COLUMN "price" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "treasury_balances" ALTER COLUMN "balance" SET DATA TYPE numeric;