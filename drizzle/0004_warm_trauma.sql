CREATE TABLE "player_exclusions" (
	"player_uuid" uuid PRIMARY KEY NOT NULL,
	"reason" text,
	"excluded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_exclusions" ADD CONSTRAINT "player_exclusions_player_uuid_players_uuid_fk" FOREIGN KEY ("player_uuid") REFERENCES "public"."players"("uuid") ON DELETE cascade ON UPDATE no action;