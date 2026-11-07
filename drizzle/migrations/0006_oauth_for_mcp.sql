CREATE TABLE "jwkss" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text,
	"requested_user_info_claims" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"confirmation" text,
	"scopes" text NOT NULL,
	"user_id" text,
	"refresh_id" text,
	CONSTRAINT "oauth_access_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text,
	"client_credentials_scopes" text,
	"user_id" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text,
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text NOT NULL,
	"post_logout_redirect_uris" text,
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text,
	"response_types" text,
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" text,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text,
	"requested_user_info_claims" text,
	"scopes" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text,
	"requested_user_info_claims" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"confirmation" text,
	"scopes" text NOT NULL,
	"user_id" text NOT NULL,
	"rotated_at" timestamp with time zone,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	CONSTRAINT "oauth_refresh_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text,
	"custom_claims" text,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1,
	"metadata" text,
	CONSTRAINT "oauth_resources_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mcp_tokens_not_before" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX ASYNC "oauth_access_tokens_user_id_idx" ON "oauth_access_tokens"("user_id");
--> statement-breakpoint
CREATE INDEX ASYNC "oauth_access_tokens_refresh_id_idx" ON "oauth_access_tokens"("refresh_id");
--> statement-breakpoint
CREATE UNIQUE INDEX ASYNC "oauth_client_resources_client_resource_uidx" ON "oauth_client_resources"("client_id", "resource_id");
--> statement-breakpoint
CREATE INDEX ASYNC "oauth_client_resources_resource_id_idx" ON "oauth_client_resources"("resource_id");
--> statement-breakpoint
CREATE INDEX ASYNC "oauth_clients_user_id_idx" ON "oauth_clients"("user_id");
--> statement-breakpoint
CREATE INDEX ASYNC "oauth_consents_user_id_idx" ON "oauth_consents"("user_id");
--> statement-breakpoint
CREATE INDEX ASYNC "oauth_consents_client_id_idx" ON "oauth_consents"("client_id");
--> statement-breakpoint
CREATE INDEX ASYNC "oauth_refresh_tokens_user_id_idx" ON "oauth_refresh_tokens"("user_id");
--> statement-breakpoint
CREATE INDEX ASYNC "oauth_refresh_tokens_client_id_idx" ON "oauth_refresh_tokens"("client_id");
