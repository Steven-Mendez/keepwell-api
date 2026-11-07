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
  core/             business rules: no HTTP, SQL, AWS or auth libraries
    domain/         literal copy of keepwell-web (see below); never edited here
    use-cases/      what the API does, written against ports
    ports/          interfaces the adapters implement
  adapters/         database, auth, App Store, configuration, logging
  entrypoints/      Hono app and routes, MCP server, Lambda handlers
infra/              Terraform: bootstrap (once, by hand), modules, envs/dev and envs/prod
docs/adr/           architecture decisions
```

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
