# 0004. Financial data model: derived balances, immutable history, reconciliation

Status: accepted, November 2026

## Context

Keepwell records money that already moved in banks and cards; it doesn't move money. Still, the
repository should hold up to someone who builds financial backends, and the data has the usual
failure modes: a write that bypasses history, a balance that drifts from its movements, a query that
forgets whose data it reads.

## Decision

- **Balances are derived, never stored.** `balanceOf` (shared domain) adds an account's opening
  balances to its confirmed movements. There is no `balance` column and no `UPDATE … SET balance`.
- **The ledger tables are a projection of an immutable log.** Every applied change is a row in
  `change_log` (who, when, from which client, the row as applied). The API's database role can
  `SELECT` and `INSERT` there and nothing else; the database refuses the rest
  (`tests/isolation`, `tests/remote`). Ledger tables are updated because people correct their own
  records; immutability lives in the log. Rows are never removed by the API: `deleted_at`.
- **Reconciliation.** `Reconcile` replays `change_log` per user and compares the result with the
  tables, column by column. A difference means a write bypassed the log or the log lost one. It runs
  as `pnpm reconcile` (exit code 1 on any difference) and logs a metric line for the alarm. It names
  keys and columns, never values.
- **Isolation by construction.** Every user table has `user_id`, with (user_id, id) as primary key
  since clients choose ids (category slugs repeat across users by design). Repositories get a
  `ScopedDb` bound to one user and can't import the raw client (ESLint). DSQL has no row-level
  security, so tests try to read, change and delete across users, and to smuggle `user_id` in data.
- **Columns follow the sync wire schemas.** The ledger tables are generated from `schema/sync.ts`,
  the same Zod objects that validate pushed events, so a column and its validation can't drift.
  Money, rates and instants are `text` exactly as they travel; arrays are JSON text.
- **Two database roles.** `keepwell_app` (the API) and `keepwell_jobs` (account deletion, which must
  erase history the API role can't touch). Migrations run as `admin` from the pipeline.

### Double entry: what is adopted and what isn't

A transfer is already a two-legged entry: it leaves the source account and arrives in the destination
at the movement's rate, and it sums to zero in one currency (`rules.ts`). Income and expenses are
one-legged entries against the outside world, which is right for a personal record.

Not modelled: a counterpart account per category and N-legged journal entries. That would rewrite the
domain on web and iOS for a benefit a personal tracker doesn't have. If real bookkeeping ever enters
(a business ledger, invoices), the change is: categories become nominal accounts, each movement
becomes a journal entry with balanced legs, and balances stay derived; `change_log` and
reconciliation carry over as they are.

## Consequences

- No periodic balance snapshots until someone has tens of thousands of movements.
- The log grows with every change; it is per user and deleted with the account.
- A new user table must be added to account deletion in the same commit (a test enforces it).
