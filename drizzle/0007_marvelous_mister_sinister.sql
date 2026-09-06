ALTER TABLE "eviction_reports" ADD COLUMN "feed" text DEFAULT 'reports' NOT NULL;--> statement-breakpoint
CREATE INDEX "eviction_reports_feed_idx" ON "eviction_reports" USING btree ("feed");