# Database migrations

Code-first and versioned: the schema lives in `src/adapters/database/schema.ts`, migrations are
generated SQL files in `drizzle/migrations` (with `meta/`, all committed), and the pipeline applies
them before `terraform apply` publishes code that needs them.

## Making one

```bash
pnpm db:generate --name=add_sync_tables          # from a schema change
pnpm db:generate --custom --name=grant_sync_roles # data, grants, anything drizzle-kit can't infer
```

`strict` and `verbose` are on: drizzle-kit prints every statement and asks before a rename or drop.
The script then rewrites the file for DSQL. Read the `.sql` before committing; a `DROP` or an
unintended `RENAME` stops there.

## Applying

- **Pipeline:** `scripts/migrate.ts` with one connection, the DSQL adapter's migrator: one DDL per
  transaction, each statement recorded in `drizzle.__drizzle_migrations`, asynchronous index jobs
  awaited before the statement counts as applied. Dev first, then prod.
- **Local:** `pnpm db:migrate` against docker-compose's Postgres. Same files, same per-statement
  tracking, with `ASYNC` removed.
- **Never** `drizzle-kit migrate` (the stock migrator wraps each file in one transaction, which DSQL
  rejects) and **never** `drizzle-kit push` against any environment.

## Rules

- **Immutable once merged.** A migration on `main` may be applied somewhere: it is not edited,
  renamed or deleted. CI fails a pull request that touches an existing file
  (`scripts/check-migrations-immutable.sh`). Fix forward with a new migration.
- **Additive.** New tables, new nullable columns or columns with defaults, new indexes. The Lambda
  that is live during the deploy keeps working against the new schema.
- **Expand and contract** for anything else, across separate deploys: add the new column, write
  both, backfill with a custom migration; later read only the new one; later still drop the old.
- **Parallel branches.** If two branches each add a migration, the one merged second deletes its
  generated file, rebases on `main` and runs `pnpm db:generate` again, so the journal and snapshot
  stay linear.
