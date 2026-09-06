CREATE TABLE "player_realtors" (
	"player_uuid" uuid PRIMARY KEY NOT NULL,
	"note" text,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_realtors" ADD CONSTRAINT "player_realtors_player_uuid_players_uuid_fk" FOREIGN KEY ("player_uuid") REFERENCES "public"."players"("uuid") ON DELETE cascade ON UPDATE no action;