# Keepwell API: notes for agents

A summary with links. The details live in [`README.md`](README.md), [`docs/migrations.md`](docs/migrations.md)
and [`docs/adr`](docs/adr/README.md); read the relevant one before changing that area.

## Commands

```bash
pnpm install
pnpm db:up                                                                  # Postgres 17 in Docker on :54329
DATABASE_URL=postgres://postgres:postgres@localhost:54329/keepwell pnpm db:migrate
pnpm check                                                                  # typecheck + lint + tests; needs db:up
pnpm test tests/mcp/read-tools.test.ts                                      # one test file
pnpm dev                                                                    # http://localhost:3001, reads config.local.json
pnpm build                                                                  # dist/lambda-*.zip
```

The tests create and migrate their own `keepwell_test` database on that Postgres
(`tests/support/global-setup.ts`) and run one file at a time. `config.local.json` is not committed;
start from `config.local.example.json`. In a git worktree, Compose names the project after the
folder and its container clashes on port 54329 with the main checkout's: run
`COMPOSE_PROJECT_NAME=keepwell-api pnpm db:up` there to reuse the same one.

## Layers

`entrypoints` → `adapters` → `core`, never the other way. `core` holds no HTTP, SQL, AWS or auth
libraries; repositories get a `ScopedDb`, never the raw client; the HTTP routes reach the MCP module
only through `src/entrypoints/mcp/index.ts`. `eslint.config.mjs` enforces all of it, so a forbidden
import fails `pnpm check`. Layout: README, "Layout".

## The shared domain

`src/core/domain/{domain,schema,fixtures,i18n,presentation}` is a literal copy of `keepwell-web/src/lib`.
**Never edit it here.** Change the web first, then copy it again with the commands in README,
"The shared domain", and run `pnpm check`. `src/core/domain-alias` is the only file of ours beside it.

## Migrations

Full rules in [`docs/migrations.md`](docs/migrations.md). In short:

- Change `src/adapters/database/schema.ts`, then `pnpm db:generate --name=<what_it_does>` and read
  the generated `.sql` (no `DROP`, no unintended `RENAME`).
- Additive only: new tables, nullable columns or columns with defaults, new indexes. Anything else is
  expand and contract across deploys.
- A merged migration is never edited, renamed or deleted.
- Never `drizzle-kit migrate` or `drizzle-kit push`.

## Tests

Vitest, in `tests/<area>/*.test.ts` (`auth`, `database`, `domain`, `http`, `isolation`, `mcp`,
`notifications`, `push`, `sync`...), with shared helpers in `tests/support`. `tests/domain` runs the
shared fixtures copied from the web. `tests/remote` is left out of `pnpm check`: the pipeline runs it
against a real DSQL cluster.
