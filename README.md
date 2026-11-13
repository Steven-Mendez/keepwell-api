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
    domain/             entities, money rules, Zod schemas, notification wording: literal copy of keepwell-web (below)
    notifications/      what is due now, in which zone, in which words (ADR 0012)
    use-cases/          ApplySyncBatch, PullChanges, CreatePendingMovement...
    ports/              interfaces the adapters implement (AuditLog, SyncRepository...)
  adapters/             infrastructure implementations
    database/           Drizzle schema, scopedDb, withTransaction, repositories, migrator
    auth/               Better Auth: sessions, OAuth for MCP, allowlist
    external/           third parties: Apple (Sign in with Apple, App Store)
    push/               APNs and Web Push senders (ADR 0012)
    config/             SSM Parameter Store, or the local JSON in development
    observability/      structured logs and the per-request context
  entrypoints/          network and serverless handlers
    http/               Hono app, routes, middlewares (session, capabilities, errors)
    jobs/               SQS consumers (account deletion), from increment 7
    notifications.ts    the scheduled Lambda that sends push notifications (ADR 0012)
    lambda.ts           the HTTP handler; dev.ts runs the same app locally
infra/                  Terraform: bootstrap (once, by hand), modules, envs/prod (the only environment)
docs/adr/               architecture decisions
```

There is no `adapters/cache` on purpose: no Redis or KV. Idempotency keys live in the database, in
the same transaction as the effect they protect (see PLAN_API.md, "Principios de backend
financiero"); a cache would be infrastructure without a problem that asks for it.

Dependencies point inward: `entrypoints` → `adapters` → `core`. ESLint enforces it
(`eslint.config.mjs`); a forbidden import fails `pnpm check`.

## The shared domain

`src/core/domain/{domain,schema,fixtures,i18n,presentation}` are literal copies of files of
`keepwell-web/src/lib`: the same money rules (`Decimal` and ISO 4217), schemas and use cases the web
runs, plus what the server needs to word push notifications with the apps' own text (the translator
and its catalogs in `i18n/`, `display.ts` and `notification-copy.ts` in `presentation/`). To update
it, from this folder:

```bash
rm -rf src/core/domain/{domain,schema,fixtures,i18n,presentation}
cp -R ../keepwell-web/src/lib/{domain,schema,fixtures} src/core/domain/
mkdir -p src/core/domain/{i18n,presentation}
cp ../keepwell-web/src/lib/i18n/{translate.ts,strings.json,web-strings*.ts} src/core/domain/i18n/
cp ../keepwell-web/src/lib/presentation/{display.ts,notification-copy.ts} src/core/domain/presentation/
pnpm check
```

`i18n/index.ts` and `provider.tsx` (React) and the other presentation files are not copied. The
copied files import `@/lib/...` as they do in the web: `tsconfig.json` `paths` maps `@/lib/*` to
`src/core/domain/*` (esbuild reads it when `pnpm build` bundles, `vitest.config.ts` repeats it for
the tests), and `@/lib/i18n`, the web's React barrel, to `src/core/domain-alias/i18n.ts`, which
re-exports the `Translator` type from the copied `translate.ts`. That alias file is ours, it's the
only thing that lives next to the copy, and it is why the copied files never need an edit.

The copy is never edited here. If the server needs something from the domain, it changes in the
web first and is copied again; reviewers reject a pull request that touches `src/core/domain`
without being a full copy. The shared fixtures (`fixtures/entities.json`) run in all three suites
(web, API, iOS), so copies that drift apart fail a test instead of diverging in silence.

## Deploying

There are three branches: `develop`, `staging` and `main`. Pull requests go to `develop`; `develop`
is then promoted to `staging`, and `staging` to `main`. Only `main` deploys, and there is no staging
environment: `staging` is a branch, not a place where the API runs.

Every commit on `main` goes through the pipeline in `.github/workflows/pipeline.yml`: checks, build,
`terraform apply` and a smoke test. Pull requests get a `terraform plan` as a comment. There are no
manual applies after the one-time bootstrap in [`BOOTSTRAP.md`](BOOTSTRAP.md).
