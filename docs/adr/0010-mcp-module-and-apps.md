# 0010. The MCP as a separable module, with MCP Apps views

Status: accepted, November 2026

## Context

The MCP server shares almost everything with the rest of the API: Better Auth's OAuth (tokens bound
to `https://api.<domain>/mcp`, ADR 0007), capabilities (ADR 0008), the switches, and the ledger.
Running it as a service of its own today would mean a second deploy, a second Terraform stack and
validating tokens across services, for no gain to anyone using it.

Claude can also draw interactive views for a tool's result (MCP Apps: a `ui://` HTML resource the
tool names in `_meta.ui.resourceUri`). A month's spending, a trend or what an assistant is about to
record reads far better as a chart or a card than as JSON. But `PLAN_API.md` ("Prompt injection")
says tools never return HTML or Markdown, as a defence against text the person typed being read as
an instruction.

## Decision

- **The MCP stays in the API**, on the same Lambda and URL, as a module that can leave:
  - `src/entrypoints/mcp/index.ts` is its only entry: `buildMcpServer(services, caller)`. Services are
    core use cases (`ReadLedger`, `CreatePending`) plus the connector URL; the caller is already
    authenticated, allowed the `mcp` capability and told whether writes are off.
  - `routes/mcp.ts` keeps everything HTTP: OAuth, the session fallback, the capability and switches,
    the transport.
  - ESLint enforces it: `entrypoints/mcp` imports no HTTP, auth or Hono, and `entrypoints/http`
    reaches it only through its index.
- **Views are a static `ui://keepwell/views` resource** (MIME `text/html;profile=mcp-app`), built
  from the `mcp-ui/` workspace package (Vite, vanilla TypeScript, one inlined file) into
  `src/entrypoints/mcp/ui/views.generated.ts`, which is committed. One document serves every tool
  with a view and picks its renderer from the tool Claude called: the views share the MCP Apps SDK
  and zod, most of the weight (about 425 KiB), so one document is a quarter of four.
- **Tools still return only JSON.** The HTML holds no user data. The view gets the tool's
  `structuredContent` and writes it as text nodes, never `innerHTML`, so the injection defence holds:
  a description stays a string, in the model's context and on screen.
- Views load nothing from outside (`csp.resourceDomains` is only `https://assets.claude.ai`, for the
  host's fonts). `_meta.ui.domain` is derived from the exact connector URL, as Claude requires, and
  left out for a local one.
- Tools with a view: `get_financial_context`, `get_monthly_summary`, `get_trends`,
  `get_upcoming_payments`, and the two write tools, whose card shows the movement as pending.
  Confirming stays in the apps: the view has no button that writes.

## Alternatives

- **A separate MCP service now.** Cleaner on a diagram; costs a deploy pipeline, cross-service token
  validation and a second URL (which would also change `ui.domain`) before anything needs them.
- **One resource per view.** Four copies of the SDK: about 1.8 MB in the Lambda and four reads
  instead of one.
- **React for the views.** Easier if they grow into an app; heavier, and four small views don't need it.
- **Views fetching data themselves.** They would need the API's origin in their CSP and a token in
  the browser; through `callServerTool` they reuse the connector's own authorization.

## Consequences

- When to split the module out: a different scaling or deploy cadence than the API, another runtime
  (for example Workers), or another team owning it. Then: copy `entrypoints/mcp`, `core/mcp` and
  `mcp-ui` to the new service, implement `McpServices` against the database or the API, validate
  tokens with Better Auth's published JWKS, and keep `https://api.<domain>/mcp` routed to it so
  neither connectors nor `ui.domain` change.
- Changing a view means `pnpm build:ui` and committing the regenerated file. CI rebuilds it during
  `pnpm build` and fails if it differs from the committed one.
- Updating `@modelcontextprotocol/ext-apps` or the MCP SDK re-runs `tests/mcp` (ADR 0007).
- `pnpm --filter @keepwell/mcp-ui dev` opens a host page that plays Claude's part with sample results,
  for checking themes, display modes and phone widths without a tunnel.
