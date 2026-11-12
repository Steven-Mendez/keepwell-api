CREATE TABLE "notification_deliveries" (
	"user_id" text NOT NULL,
	"notification_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_user_id_notification_id_pk" PRIMARY KEY("user_id","notification_id")
);
--> statement-breakpoint
CREATE TABLE "notification_states" (
	"id" text NOT NULL,
	"read_at" text,
	"dismissed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "notification_states_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"time_zone" text NOT NULL,
	"locale" text NOT NULL,
	"environment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX ASYNC "notification_deliveries_sent_at" ON "notification_deliveries"("sent_at");
--> statement-breakpoint
CREATE UNIQUE INDEX ASYNC "push_devices_user_client" ON "push_devices"("user_id", "client_id");
