import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    // Same mapping as tsconfig `paths`: the copied web files import "@/lib/...".
    alias: [
      { find: /^@\/lib\/i18n$/, replacement: root("./src/core/domain-alias/i18n.ts") },
      { find: /^@\/lib\//, replacement: root("./src/core/domain/") },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/remote/**"],
    globalSetup: ["tests/support/global-setup.ts"],
    // Integration suites share one database; files run one at a time so their fixtures don't race.
    fileParallelism: false,
  },
})
