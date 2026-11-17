CREATE TABLE "merchants" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"brand_id" text,
	"default_category_id" text,
	"is_platform" boolean NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "merchants_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD COLUMN "merchant_id" text;
--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD COLUMN "merchant_id" text;
--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD COLUMN "via_merchant_id" text;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "merchant_id" text;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "via_merchant_id" text;
