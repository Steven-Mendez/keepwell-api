-- Purchases and notifications are written by the API; the deletion job detaches purchases from the person.
GRANT SELECT, INSERT, UPDATE ON app_store_transactions, app_store_notifications TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON app_store_transactions TO keepwell_jobs;
