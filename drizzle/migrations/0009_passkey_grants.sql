-- Passkeys: managed by the API, erased with the account.
GRANT SELECT, INSERT, UPDATE, DELETE ON passkeys TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON passkeys TO keepwell_jobs;
