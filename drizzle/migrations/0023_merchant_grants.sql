-- Merchants are a ledger table like the rest: the API reads and writes them through sync (ADR 0004).
GRANT SELECT, INSERT, UPDATE, DELETE ON merchants TO keepwell_app;
--> statement-breakpoint
-- The deletion job erases them with the account, like every other table with a user_id.
GRANT SELECT, DELETE ON merchants TO keepwell_jobs;
