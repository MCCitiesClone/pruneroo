CREATE TABLE "eviction_report_regions" (
	"thread_id" text NOT NULL,
	"world_uuid" uuid NOT NULL,
	"wg_region_id" text NOT NULL,
	CONSTRAINT "eviction_report_regions_thread_id_world_uuid_wg_region_id_pk" PRIMARY KEY("thread_id","world_uuid","wg_region_id")
);
--> statement-breakpoint
CREATE TABLE "eviction_reports" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"prefix" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"url" text NOT NULL,
	"author" text,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eviction_report_regions" ADD CONSTRAINT "eviction_report_regions_thread_id_eviction_reports_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."eviction_reports"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eviction_report_regions_region_idx" ON "eviction_report_regions" USING btree ("world_uuid","wg_region_id");--> statement-breakpoint
CREATE INDEX "eviction_reports_active_idx" ON "eviction_reports" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "eviction_reports_posted_idx" ON "eviction_reports" USING btree ("posted_at");