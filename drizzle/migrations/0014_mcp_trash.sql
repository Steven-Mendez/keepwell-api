CREATE TABLE "mcp_trash" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"client_id" text NOT NULL,
	"label" text NOT NULL,
	"rows" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_at" timestamp with time zone,
	CONSTRAINT "mcp_trash_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE INDEX ASYNC "mcp_trash_user_created" ON "mcp_trash"("user_id", "created_at");
