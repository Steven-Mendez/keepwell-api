-- The API checks and consumes invitations; creating them is an operator task (pnpm invite, admin).
-- The deletion job forgets which Apple identity used one.
GRANT SELECT, UPDATE ON invitations TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON invitations TO keepwell_jobs;
