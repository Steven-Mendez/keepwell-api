CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp with time zone,
	"aaguid" text
);
--> statement-breakpoint
CREATE INDEX ASYNC "passkeys_user_id_idx" ON "passkeys"("user_id");
--> statement-breakpoint
CREATE INDEX ASYNC "passkeys_credential_id_idx" ON "passkeys"("credential_id");
