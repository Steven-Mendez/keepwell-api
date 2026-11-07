CREATE TABLE "app_store_notifications" (
	"notification_uuid" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"subtype" text,
	"original_transaction_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_store_transactions" (
	"original_transaction_id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"product_id" text NOT NULL,
	"environment" text NOT NULL,
	"purchased_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_notification_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX ASYNC "app_store_transactions_user_idx" ON "app_store_transactions"("user_id");
