# 0003. Aurora DSQL, and what it costs the code

Status: accepted, November 2026

## Context

The API needs a relational database: the MCP reasons over SQL-shaped questions ("spending by
category this month"), Better Auth needs tables, and sync needs transactions. One user today, maybe
hundreds later. A database that is billed while idle costs more than the rest of the stack together.

## Decision

Aurora DSQL, one cluster per environment, with Drizzle through the official
`@aws/aurora-dsql-drizzle` adapter. It scales to zero without a cold start, authenticates with IAM
(no database secret anywhere), and its permanent free tier (100,000 DPU and 1 GB a month per
account) covers dev and prod for one user.

What DSQL makes the code do, and where it is done:

| DSQL fact | What the code does | Where |
| --- | --- | --- |
| Optimistic concurrency at repeatable read; conflicts fail at commit with OC000/OC001 (40001); `FOR UPDATE` doesn't wait | Every write runs through `withTransaction`, which re-runs the whole closure on a conflict. Only SQL inside the closure. Each retry is logged | `src/adapters/database/with-transaction.ts`, `tests/database/with-transaction.test.ts` |
| One DDL per transaction; `CREATE INDEX` only `ASYNC`, as a job | The adapter's migrator applies statement by statement and waits for jobs. Locally the same files run with `ASYNC` removed | `src/adapters/database/migrate.ts`, `drizzle/` |
| Bare `numeric` is `numeric(18,6)` and rounds silently | Money and rates are `text` validated with the domain's `DECIMAL_PATTERN`; the server never sums in SQL | `src/adapters/database/schema.ts` |
| Up to 3,000 modified rows and 10 MiB per transaction | A push is capped at 200 events (≈600 rows). Account deletion goes through a queue in batches | sync and jobs |
| Connections close after 60 minutes; 100 new connections per second per cluster | A two-connection pool per Lambda instance, recycled at 55 minutes; each new connection signs a fresh IAM token | `src/adapters/database/client.ts` |
| No triggers, PL/pgSQL or extensions; collation `C` | Local Postgres runs with collation `C` and repeatable read (`docker-compose.yml`, CI service) | |
| Sequences have no cross-session order | The sync cursor is not a bare sequence (ADR 0005, `sync_state`) | sync |
| Permissions per table | The app role `keepwell_app` has no `UPDATE`/`DELETE` on the log tables; migrations run as `admin` | migrations |

**No foreign keys, by decision.** DSQL supports them since August 2026, but cascades count toward
the per-transaction row limit and the domain already owns referential integrity, as it does in
Dexie and SwiftData. A test fails if one appears in the schema.

## Alternatives

- **Aurora Serverless v2.** The natural exit if DSQL falls short: change the Drizzle driver and add
  RDS Proxy. Today it would cost 5–15 USD a month with ~15 s cold starts at a 0 ACU minimum, or about
  44 USD always awake, for one user.
- **DynamoDB.** Free at this volume, but it takes SQL away from the MCP and Better Auth has no
  official adapter.
- **Supabase or Neon.** Good products; the requirement is AWS.

## Consequences

- Concurrency is resolved on purpose, not by luck: two writers to one row are tested locally
  (Postgres at repeatable read fails the loser with 40001, the same path DSQL takes).
- The pipeline waits for asynchronous index jobs before publishing a Lambda that relies on them.
- Moving to Aurora Serverless v2 is a driver change plus RDS Proxy, in one commit.
