import { defineConfig } from "drizzle-kit"

// Code-first, versioned migrations. `pnpm db:generate --name=<what_it_does>` runs drizzle-kit and
// rewrites every statement for DSQL (CREATE INDEX ASYNC, one statement per breakpoint); review the
// .sql and commit it with meta/. Migrations are applied by scripts/migrate.ts in the pipeline, never
// with `drizzle-kit migrate` or `push` (see docs/migrations.md).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/database/schema.ts",
  out: "./drizzle/migrations",
  breakpoints: true,
  // Print every statement, and ask before anything that could lose data (renames, drops).
  verbose: true,
  strict: true,
})
