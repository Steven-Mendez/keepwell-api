import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import type { Logger } from "../../adapters/observability/logger"
import type { CreatePending } from "../../core/use-cases/create-pending"
import type { ReadLedger } from "../../core/use-cases/read-ledger"
import { createMcpServer } from "./server"
import { registerUiResources } from "./ui/resources"
import { registerWriteTools } from "./write-tools"

/**
 * The MCP module's only entry (ADR 0009). Everything it needs from the rest of the API comes in
 * here as core use cases, so the module can move to a service of its own by implementing these
 * against the database or the API, without touching the tools or the views.
 */
export interface McpServices {
  readLedger: ReadLedger
  /** The write tools; without it, the connector is read-only for everyone. */
  createPending?: CreatePending
  /** The exact URL clients connect to (`${API_BASE_URL}/mcp`); the views' sandbox origin derives from it. */
  mcpUrl: string
  now: () => Date
}

/** Who is calling, already authenticated and allowed the `mcp` capability by the transport. */
export interface McpCaller {
  userId: string
  /** `session` for the session cookie, otherwise the OAuth client id. */
  clientId: string
  scopes: readonly string[]
  log: Logger
  /** The read_only switch: write tools vanish while it is on. */
  readOnly: boolean
}

/** A fresh server for one request: the transport is stateless, so nothing is shared between calls. */
export function buildMcpServer(services: McpServices, caller: McpCaller): McpServer {
  const writable = services.createPending !== undefined && caller.scopes.includes("write") && !caller.readOnly
  const server = createMcpServer({
    ledger: () => services.readLedger.execute(caller.userId),
    now: services.now,
    log: caller.log,
    clientId: caller.clientId,
    ...(writable
      ? { registerWrites: (server) => registerWriteTools(server, { create: services.createPending!, userId: caller.userId, clientId: caller.clientId, log: caller.log }) }
      : {}),
  })
  registerUiResources(server, services.mcpUrl)
  return server
}
