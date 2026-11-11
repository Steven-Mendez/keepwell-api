import { requireMcpAuth } from "@better-auth/mcp"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono, type Context } from "hono"

import type { Auth } from "../../../adapters/auth/auth"
import type { McpConnections } from "../../../adapters/auth/mcp-connections"
import type { ResolveCapabilities } from "../../../core/use-cases/resolve-capabilities"
import type { ReadLedger } from "../../../core/use-cases/read-ledger"
import { buildMcpServer } from "../../mcp"
import type { CreatePending } from "../../../core/use-cases/create-pending"
import { ApiError, errorBody } from "../errors"
import { requireSession } from "../middlewares/session"
import type { AppEnv } from "../types"
import type { SwitchesSource } from "../../../core/switches"
import { refuseWhenMcpDisabled } from "../middlewares/switches"

export interface McpDeps {
  auth: Promise<Auth>
  capabilities: Promise<ResolveCapabilities>
  readLedger: ReadLedger
  connections?: McpConnections
  /** The write tools; without it, /mcp is read-only for everyone. */
  createPending?: CreatePending
  switches?: SwitchesSource
  /** Public URL of the API: the resource is `${baseURL}/mcp`. */
  baseURL: string
  now?: () => Date
}

interface Caller {
  userId: string
  clientId: string
  scopes: string[]
}

/**
 * The MCP endpoint (ADR 0007) over Streamable HTTP, stateless and JSON-only: each POST authenticates
 * on its own and gets a fresh server and transport.
 *
 * - A Bearer token is verified against the authorization server's keys: signature, issuer, expiry,
 *   and an audience equal to this resource, so a token for anything else is refused. A token issued
 *   before "disconnect everything" is refused too.
 * - Without a token, the author's session cookie works (Claude Code against `pnpm dev`, increment 16).
 * - No credentials: 401 with WWW-Authenticate (RFC 9728), never 403. No `mcp` capability: 403 needs_plan.
 */
export function mcpRoutes(deps: McpDeps) {
  const routes = new Hono<AppEnv>()
  const resource = `${deps.baseURL}/mcp`
  const challenge = `Bearer resource_metadata="${deps.baseURL}/.well-known/oauth-protected-resource"`

  async function serve(c: Context<AppEnv>, request: Request, caller: Caller): Promise<Response> {
    if (!(await (await deps.capabilities).has(caller.userId, "mcp"))) {
      return c.json(errorBody(c, "needs_plan", "The MCP connector comes with Keepwell's coffee, bought in the iPhone app.", { capability: "mcp" }), 403)
    }
    const server = buildMcpServer(
      { readLedger: deps.readLedger, createPending: deps.createPending, mcpUrl: resource, now: deps.now ?? (() => new Date()) },
      {
        ...caller,
        log: c.get("log"),
        // Write tools exist only for a token granted `write`, and vanish while the read_only switch is on.
        readOnly: deps.switches ? (await deps.switches.current()).read_only : false,
      }
    )
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(request)
    } finally {
      void server.close()
    }
  }

  if (deps.switches) routes.use("/mcp", refuseWhenMcpDisabled(deps.switches))
  routes.post("/mcp", async (c) => {
    const request = c.req.raw
    if (request.headers.get("authorization")?.toLowerCase().startsWith("bearer ")) {
      const auth = await deps.auth
      const protectedHandler = requireMcpAuth(
        auth,
        async (verified, claims) => {
          const userId = String(claims.sub ?? "")
          const issuedAt = typeof claims.iat === "number" ? claims.iat : undefined
          if (!userId || (deps.connections && (await deps.connections.isCutOff(userId, issuedAt)))) {
            return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Token revoked" }, id: null }), {
              status: 401,
              headers: { "content-type": "application/json", "www-authenticate": `${challenge}, error="invalid_token"` },
            })
          }
          const scopes = String(claims.scope ?? "").split(" ").filter(Boolean)
          const clientId = String(claims.azp ?? claims.client_id ?? "unknown")
          return serve(c, verified, { userId, clientId, scopes })
        },
        { resource, jwksUrl: `${deps.baseURL}/api/auth/jwks`, issuer: `${deps.baseURL}/api/auth` }
      )
      return protectedHandler(request)
    }
    const session = await (await deps.auth).api.getSession({ headers: request.headers })
    if (!session) throw new ApiError(401, "unauthorized", "Connect Keepwell to continue", undefined, { "WWW-Authenticate": challenge })
    return serve(c, request, { userId: session.user.id, clientId: "session", scopes: ["read"] })
  })

  // Stateless: no server-to-client stream and no sessions to end.
  routes.on(["GET", "DELETE"], "/mcp", (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405))

  if (deps.connections) {
    const connections = deps.connections
    routes.get("/mcp/clients", requireSession(deps.auth), async (c) => {
      const list = await connections.list(c.get("user").id)
      return c.json({ clients: list.map((client) => ({ client_id: client.clientId, name: client.name, uri: client.uri, scopes: client.scopes, connected_at: client.connectedAt.toISOString() })) })
    })
    routes.delete("/mcp/clients/:clientId", requireSession(deps.auth), async (c) => {
      const revoked = await connections.revoke(c.get("user").id, c.req.param("clientId"))
      return revoked ? c.body(null, 204) : c.json(errorBody(c, "not_found", "No such connected client"), 404)
    })
    routes.post("/mcp/disconnect-all", requireSession(deps.auth), async (c) => {
      await connections.disconnectAll(c.get("user").id)
      return c.body(null, 204)
    })
  }
  return routes
}

/**
 * MCP clients discover the authorization server at the origin's root (RFC 8414, RFC 9728), while
 * Better Auth answers under /api/auth. These routes forward the well-known documents.
 */
export function wellKnownRoutes(auth: Promise<Auth>, baseURL: string) {
  return new Hono<AppEnv>().get("/.well-known/*", async (c) => {
    const handler = (await auth).handler
    const path = new URL(c.req.url).pathname
    // The MCP plugin answers the protected-resource document at the root path itself.
    const direct = await handler(new Request(`${baseURL}${path}`, { headers: c.req.raw.headers }))
    if (direct.status !== 404) return direct
    const prefixed = await handler(new Request(`${baseURL}/api/auth${path}`, { headers: c.req.raw.headers }))
    if (prefixed.status !== 404) return prefixed
    // The path-inserted form of the authorization-server document (`…/oauth-authorization-server/api/auth`).
    const base = path.replace(/\/api\/auth$/, "")
    return base === path ? prefixed : handler(new Request(`${baseURL}/api/auth${base}`, { headers: c.req.raw.headers }))
  })
}
