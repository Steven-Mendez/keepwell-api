import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/remote/**"],
    globalSetup: ["tests/support/global-setup.ts"],
    // Integration suites share one database; files run one at a time so their fixtures don't race.
    fileParallelism: false,
  },
})
