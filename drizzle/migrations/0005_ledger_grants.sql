-- The API's role: full access to the ledger projection and sync bookkeeping, but change_log is
-- insert-only. History is immutable because the database refuses, not by convention (ADR 0004).
GRANT SELECT, INSERT, UPDATE, DELETE ON ledger_accounts, cards, categories, transactions, recurring_rules, savings_goals, loans, loan_payments, personal_debts, personal_debt_repayments, categorization_rules, settings TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON change_log TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON sync_state, applied_events, clients, idempotency_keys, entitlements TO keepwell_app;
--> statement-breakpoint
-- The deletion job's role (ADR 0006): it erases an account's rows, history included, and nothing else.
CREATE ROLE keepwell_jobs WITH LOGIN;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO keepwell_jobs;
--> statement-breakpoint
GRANT SELECT, DELETE ON ledger_accounts, cards, categories, transactions, recurring_rules, savings_goals, loans, loan_payments, personal_debts, personal_debt_repayments, categorization_rules, settings, change_log, sync_state, applied_events, clients, idempotency_keys, sessions, accounts, verifications TO keepwell_jobs;
--> statement-breakpoint
GRANT SELECT, UPDATE ON entitlements TO keepwell_jobs;
--> statement-breakpoint
GRANT SELECT, DELETE ON users TO keepwell_jobs;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_log TO keepwell_jobs;
