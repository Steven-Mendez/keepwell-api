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
  { ignores: ["dist/**", "node_modules/**", "infra/**", "src/core/domain/**", "coverage/**", "mcp-ui/dist/**", "src/entrypoints/mcp/ui/views.generated.ts"] },
  js.configs.recommended,
  { files: ["scripts/**/*.mjs", "mcp-ui/scripts/**/*.mjs"], languageOptions: { globals: { console: "readonly", process: "readonly" } } },
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
  // The MCP module (ADR 0009) can move to a service of its own: it knows nothing of HTTP or auth, and
  // the API reaches it only through its index (buildMcpServer).
  layer(
    "entrypoints/mcp",
    ["**/entrypoints/http/**", "**/adapters/auth/**", "hono", "hono/*", "better-auth", "better-auth/*", "@better-auth/*"],
    "The MCP module gets an authenticated caller and core use cases through buildMcpServer; HTTP, auth and transports stay in routes/mcp.ts."
  ),
  layer("entrypoints/http", ["**/mcp/server", "**/mcp/write-tools", "**/mcp/ui/*"], "Reach the MCP module only through its index (entrypoints/mcp)."),
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
