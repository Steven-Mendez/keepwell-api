import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono } from "hono"

import type { Auth } from "../../../adapters/auth/auth"
import type { ResolveCapabilities } from "../../../core/use-cases/resolve-capabilities"
import type { ReadLedger } from "../../../core/use-cases/read-ledger"
import { createMcpServer } from "../../mcp/server"
import { ApiError } from "../errors"
import { requireCapability } from "../middlewares/capability"
import type { AppEnv } from "../types"

export interface McpDeps {
  auth: Promise<Auth>
  capabilities: Promise<ResolveCapabilities>
  readLedger: ReadLedger
  /** Public URL of the API, for the WWW-Authenticate pointer to the protected-resource metadata. */
  baseURL: string
  now?: () => Date
}

/**
 * The MCP endpoint over Streamable HTTP, stateless and JSON-only: each POST authenticates on its own
 * and gets a fresh server and transport. Without credentials: 401 with WWW-Authenticate, as the MCP
 * specification requires, never 403. Without the `mcp` capability: 403 needs_plan.
 */
export function mcpRoutes(deps: McpDeps) {
  const routes = new Hono<AppEnv>()
  const challenge = `Bearer resource_metadata="${deps.baseURL}/.well-known/oauth-protected-resource"`

  routes.use("/mcp", async (c, next) => {
    const session = await (await deps.auth).api.getSession({ headers: c.req.raw.headers })
    if (!session) throw new ApiError(401, "unauthorized", "Connect Keepwell to continue", undefined, { "WWW-Authenticate": challenge })
    c.set("user", { id: session.user.id, name: session.user.name, email: session.user.email })
    c.set("sessionId", session.session.id)
    await next()
  })
  routes.use("/mcp", requireCapability(deps.capabilities, "mcp"))

  routes.post("/mcp", async (c) => {
    const user = c.get("user")
    const server = createMcpServer({
      ledger: () => deps.readLedger.execute(user.id),
      now: deps.now ?? (() => new Date()),
      log: c.get("log"),
      clientId: "session",
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(c.req.raw)
    } finally {
      void server.close()
    }
  })
  // Stateless: no server-to-client stream and no sessions to end.
  routes.on(["GET", "DELETE"], "/mcp", (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405))
  return routes
}
