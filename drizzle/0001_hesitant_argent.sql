-- The generated column is referenced by the insight views, so they must be
-- dropped before it can be replaced. scripts/migrate.ts re-applies views.sql
-- immediately after migrations, which recreates them.
DROP VIEW IF EXISTS "v_property_stakeholder_flags" CASCADE;--> statement-breakpoint
DROP VIEW IF EXISTS "v_player_flags" CASCADE;--> statement-breakpoint
DROP VIEW IF EXISTS "v_active_punishments" CASCADE;--> statement-breakpoint
ALTER TABLE "punishments" drop column "is_deportation";--> statement-breakpoint
ALTER TABLE "punishments" ADD COLUMN "is_deportation" boolean GENERATED ALWAYS AS (("reason" ILIKE '%deportation%')) STORED;
