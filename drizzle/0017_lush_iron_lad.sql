CREATE TABLE "notification_deliveries" (
	"channel" text NOT NULL,
	"entity_key" text NOT NULL,
	"disposition" text DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_channel_entity_key_pk" PRIMARY KEY("channel","entity_key")
);
--> statement-breakpoint
CREATE INDEX "notification_deliveries_channel_idx" ON "notification_deliveries" USING btree ("channel","sent_at");