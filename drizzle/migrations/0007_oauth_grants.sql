-- The OAuth server lives in the API: full access for keepwell_app. The deletion job erases a
-- person's clients, tokens and consents with the rest of the account.
GRANT SELECT, INSERT, UPDATE, DELETE ON jwkss, oauth_clients, oauth_resources, oauth_client_resources, oauth_refresh_tokens, oauth_access_tokens, oauth_consents, oauth_client_assertions TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON oauth_clients, oauth_refresh_tokens, oauth_access_tokens, oauth_consents TO keepwell_jobs;
