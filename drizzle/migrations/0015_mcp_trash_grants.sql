-- The API keeps and restores MCP deletes and purges them after 30 days (ADR 0011). The deletion job
-- erases them with the account, like every other copy of finance data.
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_trash TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON mcp_trash TO keepwell_jobs;
