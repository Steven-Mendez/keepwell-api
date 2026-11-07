-- The role the API connects as. Its IAM mapping (AWS IAM GRANT) is per environment and is applied
-- by scripts/migrate.ts on DSQL; table privileges are granted table by table as tables arrive, so
-- the log tables can be insert-only.
CREATE ROLE keepwell_app WITH LOGIN;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO keepwell_app;
