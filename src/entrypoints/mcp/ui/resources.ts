import { createHash } from "node:crypto"

import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { VIEWS_HTML } from "./views.generated"

/**
 * The MCP Apps views (ADR 0009): one static document built from mcp-ui/ at build time, with no user
 * data in it. It picks what to draw from the tool Claude called; the data reaches it only as that
 * tool's JSON result, which it renders as text. One document rather than one per tool, because the
 * views share the MCP Apps SDK, which is most of the weight.
 */
export const VIEWS_URI = "ui://keepwell/views"

/**
 * Claude serves each connector's views from a sandbox origin derived from the exact connector URL:
 * the first 32 hex characters of its SHA-256, under claudemcpcontent.com. A local URL has no such
 * origin, so the field is left out and the host picks one.
 */
export function viewDomain(mcpUrl: string): string | undefined {
  const host = new URL(mcpUrl).hostname
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return undefined
  return `${createHash("sha256").update(mcpUrl).digest("hex").slice(0, 32)}.claudemcpcontent.com`
}

export function registerUiResources(server: McpServer, mcpUrl: string): void {
  const domain = viewDomain(mcpUrl)
  // The views load nothing from outside; only the host's own fonts.
  const ui = { csp: { resourceDomains: ["https://assets.claude.ai"] }, ...(domain ? { domain } : {}) }
  registerAppResource(server, "Keepwell views", VIEWS_URI, { mimeType: RESOURCE_MIME_TYPE, _meta: { ui } }, async () => ({
    contents: [{ uri: VIEWS_URI, mimeType: RESOURCE_MIME_TYPE, text: VIEWS_HTML, _meta: { ui } }],
  }))
}
