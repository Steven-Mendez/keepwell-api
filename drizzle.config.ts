import { defineConfig } from "drizzle-kit"

// Generate with `pnpm db:generate`, which runs drizzle-kit and then rewrites every statement for
// DSQL (CREATE INDEX ASYNC, one statement per breakpoint). Review and commit the result.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/db/schema.ts",
  out: "./drizzle",
  breakpoints: true,
})
