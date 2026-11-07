CREATE TABLE "applied_events" (
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"result" text NOT NULL,
	"reason" text,
	"server_seq" bigint,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applied_events_user_id_event_id_pk" PRIMARY KEY("user_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" text NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"network" text,
	"last_four" text,
	"color" text,
	"product_name" text,
	"expiry_month" integer,
	"expiry_year" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "cards_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"icon" text,
	"color" text,
	"is_renamed" boolean NOT NULL,
	"sort_index" integer NOT NULL,
	"budget_amount" text,
	"budget_currency" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "categories_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "categorization_rules" (
	"id" text NOT NULL,
	"match" text NOT NULL,
	"category_id" text NOT NULL,
	"kind" text NOT NULL,
	"tags" text NOT NULL,
	"sort_index" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "categorization_rules_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"user_id" text NOT NULL,
	"server_seq" bigint NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"operation" text NOT NULL,
	"payload" text NOT NULL,
	"status" text NOT NULL,
	"client_id" text NOT NULL,
	"event_id" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_log_user_id_server_seq_pk" PRIMARY KEY("user_id","server_seq")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_user_id_client_id_pk" PRIMARY KEY("user_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"plan" text NOT NULL,
	"source" text NOT NULL,
	"reference" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"bank" text,
	"kind" text NOT NULL,
	"opening_balances" text NOT NULL,
	"opening_date" text NOT NULL,
	"debt_mode" text,
	"limit_amount" text,
	"limit_currency" text,
	"cutoff_day" integer,
	"due_day" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "ledger_accounts_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "loan_payments" (
	"id" text NOT NULL,
	"loan_id" text NOT NULL,
	"number" integer NOT NULL,
	"paid_at" text NOT NULL,
	"transaction_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "loan_payments_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"lender" text,
	"borrowed_amount" text NOT NULL,
	"borrowed_currency" text NOT NULL,
	"installment_amount" text NOT NULL,
	"installment_count" integer NOT NULL,
	"frequency" text NOT NULL,
	"first_due_date" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "loans_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "personal_debt_repayments" (
	"id" text NOT NULL,
	"debt_id" text NOT NULL,
	"amount" text NOT NULL,
	"date" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "personal_debt_repayments_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "personal_debts" (
	"id" text NOT NULL,
	"person" text NOT NULL,
	"direction" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"date" text NOT NULL,
	"note" text,
	"settled_at" text,
	"transaction_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "personal_debts_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "recurring_rules" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"category_id" text,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"account_id" text NOT NULL,
	"card_id" text,
	"destination_account_id" text,
	"frequency" text NOT NULL,
	"interval" integer NOT NULL,
	"start_date" text NOT NULL,
	"next_date" text NOT NULL,
	"end_date" text,
	"is_subscription" boolean NOT NULL,
	"auto_confirm" boolean NOT NULL,
	"is_paused" boolean NOT NULL,
	"note" text,
	"tags" text NOT NULL,
	"source" text DEFAULT 'app' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "recurring_rules_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "savings_goals" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"target_amount" text NOT NULL,
	"target_currency" text NOT NULL,
	"saved" text NOT NULL,
	"target_month" integer,
	"target_year" integer,
	"icon" text,
	"color" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "savings_goals_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text NOT NULL,
	"principal" text NOT NULL,
	"second" text,
	"rate" text NOT NULL,
	"payment_reminder_days_before" integer NOT NULL,
	"has_completed_onboarding" boolean NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "settings_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text NOT NULL,
	"date" text NOT NULL,
	"status" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"category_id" text,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"account_id" text NOT NULL,
	"card_id" text,
	"destination_account_id" text,
	"actual_debited_principal" text,
	"rate_principal" text NOT NULL,
	"rate_second" text NOT NULL,
	"rate" text NOT NULL,
	"is_shared" boolean NOT NULL,
	"note" text,
	"recurring_id" text,
	"tags" text NOT NULL,
	"source" text DEFAULT 'app' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"user_id" text NOT NULL,
	CONSTRAINT "transactions_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE INDEX ASYNC "entitlements_user_idx" ON "entitlements"("user_id");
