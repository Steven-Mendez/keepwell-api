-- The API stores each notification's state and the devices to push to; the notifications job (which
-- connects as keepwell_app too, with its own IAM role) records deliveries and prunes them (ADR 0012).
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_states, push_devices, notification_deliveries TO keepwell_app;
--> statement-breakpoint
-- The deletion job erases them with the account, like every other table with a user_id.
GRANT SELECT, DELETE ON notification_states, push_devices, notification_deliveries TO keepwell_jobs;
