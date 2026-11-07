import js from "@eslint/js"
import tseslint from "typescript-eslint"

// The dependency rule points inward: entrypoints → adapters → core. `core/domain` is a literal copy
// of keepwell-web and imports nothing else from the API. Enforced here so it can't erode.
const layer = (from, forbidden, message) => ({
  files: [`src/${from}/**/*.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      { patterns: [{ group: forbidden, message }] },
    ],
  },
})

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "infra/**", "src/core/domain/**", "coverage/**"] },
  js.configs.recommended,
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: { console: "readonly", process: "readonly" } } },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  layer(
    "core",
    ["**/adapters/**", "**/entrypoints/**", "hono", "hono/*", "pino", "drizzle-orm", "drizzle-orm/*", "pg", "@aws-sdk/*", "better-auth", "better-auth/*"],
    "core holds business rules only: no HTTP, SQL, AWS or auth libraries, and no adapters or entrypoints."
  ),
  layer(
    "adapters",
    ["**/entrypoints/**", "hono", "hono/*"],
    "adapters implement core ports and never import entrypoints or the HTTP framework."
  ),
  {
    // Repositories get a ScopedDb (adapters/database/scoped-db.ts), never the raw client: a query
    // without user_id can't be written there.
    files: ["src/adapters/database/repositories/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["../client", "../with-transaction", "**/database/client"], message: "Use the ScopedDb you are given; the raw client bypasses user isolation." },
          ],
        },
      ],
    },
  }
)
