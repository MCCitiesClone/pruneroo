CREATE TABLE "plot_merge_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"owner_uuid" uuid,
	"member_count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plot_merge_members" (
	"group_id" bigint NOT NULL,
	"world_uuid" uuid NOT NULL,
	"wg_region_id" text NOT NULL,
	CONSTRAINT "plot_merge_members_group_id_world_uuid_wg_region_id_pk" PRIMARY KEY("group_id","world_uuid","wg_region_id")
);
--> statement-breakpoint
ALTER TABLE "plot_merge_members" ADD CONSTRAINT "plot_merge_members_group_id_plot_merge_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."plot_merge_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plot_merge_groups_thread_idx" ON "plot_merge_groups" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "plot_merge_groups_status_idx" ON "plot_merge_groups" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plot_merge_members_region_idx" ON "plot_merge_members" USING btree ("world_uuid","wg_region_id");