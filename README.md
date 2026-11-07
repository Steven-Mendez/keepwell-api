# Keepwell API

The backend of Keepwell: it syncs the iOS and web apps and exposes an MCP server so Claude (or any
MCP client) can act as a financial assistant over the person's real data. Serverless on AWS,
deployed with Terraform, one commit at a time.

The design, its trade-offs and the order of work are in [`PLAN_API.md`](PLAN_API.md). Decisions
are recorded as ADRs in [`docs/adr`](docs/adr).

## Run it

```bash
pnpm install
pnpm db:up          # Postgres in Docker, configured like DSQL (collation C, repeatable read)
DATABASE_URL=postgres://postgres:postgres@localhost:54329/keepwell pnpm db:migrate
pnpm dev            # http://localhost:3001
pnpm check          # typecheck, lint (including the layer rule) and tests, against local Postgres
pnpm build          # dist/lambda-*.zip, what Terraform deploys
```

## Layout

```
src/
  core/                 pure business logic: no HTTP, Lambda, SQL, AWS or auth libraries
    domain/             entities, money rules, Zod schemas: literal copy of keepwell-web (below)
    use-cases/          ApplySyncBatch, PullChanges, CreatePendingMovement...
    ports/              interfaces the adapters implement (AuditLog, SyncRepository...)
  adapters/             infrastructure implementations
    database/           Drizzle schema, scopedDb, withTransaction, repositories, migrator
    auth/               Better Auth: sessions, OAuth for MCP, allowlist
    external/           third parties: Apple (Sign in with Apple, App Store)
    config/             SSM Parameter Store, or the local JSON in development
    observability/      structured logs and the per-request context
  entrypoints/          network and serverless handlers
    http/               Hono app, routes, middlewares (session, capabilities, errors)
    jobs/               SQS consumers (account deletion), from increment 7
    lambda.ts           the HTTP handler; dev.ts runs the same app locally
infra/                  Terraform: bootstrap (once, by hand), modules, envs/dev and envs/prod
docs/adr/               architecture decisions
```

There is no `adapters/cache` on purpose: no Redis or KV. Idempotency keys live in the database, in
the same transaction as the effect they protect (see PLAN_API.md, "Principios de backend
financiero"); a cache would be infrastructure without a problem that asks for it.

Dependencies point inward: `entrypoints` → `adapters` → `core`. ESLint enforces it
(`eslint.config.mjs`); a forbidden import fails `pnpm check`.

## The shared domain

`src/core/domain/{domain,schema,fixtures}` is a literal copy of `keepwell-web/src/lib/{domain,schema,fixtures}`:
the same money rules (`Decimal` and ISO 4217), schemas and use cases the web runs. To update it, from
this folder:

```bash
rm -rf src/core/domain/{domain,schema,fixtures}
cp -R ../keepwell-web/src/lib/{domain,schema,fixtures} src/core/domain/
pnpm check
```

The copy is never edited here. If the server needs something from the domain, it changes in the
web first and is copied again; reviewers reject a pull request that touches `src/core/domain`
without being a full copy. The shared fixtures (`fixtures/entities.json`) run in all three suites
(web, API, iOS), so copies that drift apart fail a test instead of diverging in silence.

## Deploying

Every commit on `main` goes through the pipeline in `.github/workflows/pipeline.yml`: checks, build,
`terraform apply` and a smoke test. Pull requests get a `terraform plan` as a comment. There are no
manual applies after the one-time bootstrap in [`BOOTSTRAP.md`](BOOTSTRAP.md).
