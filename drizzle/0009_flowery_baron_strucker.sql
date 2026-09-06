ALTER TABLE "regions" ADD COLUMN "category" text;--> statement-breakpoint
CREATE INDEX "regions_category_idx" ON "regions" USING btree ("category");