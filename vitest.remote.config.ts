import { defineConfig } from "vitest/config"

// Suites that need a real Aurora DSQL cluster. The pipeline runs them against dev after migrating
// and applying it; they create their own users and never assume an empty database.
export default defineConfig({
  test: {
    include: ["tests/remote/**/*.remote.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
