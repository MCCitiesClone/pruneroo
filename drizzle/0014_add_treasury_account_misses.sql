CREATE TABLE "treasury_account_misses" (
	"player_uuid" uuid PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "treasury_account_misses" ADD CONSTRAINT "treasury_account_misses_player_uuid_players_uuid_fk" FOREIGN KEY ("player_uuid") REFERENCES "public"."players"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treasury_account_misses_checked_idx" ON "treasury_account_misses" USING btree ("checked_at");