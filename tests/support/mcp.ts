import type { testAuthApp } from "./auth"

type Http = ReturnType<typeof testAuthApp>["app"]

/** A minimal MCP client over Streamable HTTP (JSON responses), as Claude Code would speak it. */
export function mcpClient(http: Http, headers: Record<string, string>) {
  let id = 0
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await http.request("/mcp", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    })
    return { status: res.status, headers: res.headers, body: res.status === 200 ? ((await res.json()) as { result?: Record<string, unknown>; error?: unknown }) : await res.text() }
  }
  return {
    call,
    async initialize() {
      return call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })
    },
    async tool(name: string, args: Record<string, unknown> = {}) {
      const res = await call("tools/call", { name, arguments: args })
      const result = (res.body as { result: { structuredContent?: unknown; isError?: boolean; content: { text: string }[] } }).result
      return { result, data: result.structuredContent as Record<string, unknown> }
    },
  }
}
