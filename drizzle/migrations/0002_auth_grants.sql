-- Privileges of the app role, table by table. audit_log is insert-only: the database, not a
-- convention, keeps it immutable.
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON verifications TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_log TO keepwell_app;
