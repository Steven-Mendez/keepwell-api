import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { VIEWS_URI, viewDomain } from "../../src/entrypoints/mcp/ui/resources"
import { signIn, testAuthApp } from "../support/auth"
import { adminDatabase, appDatabase } from "../support/database"
import { mcpClient } from "../support/mcp"
import { wipe } from "../support/sync"

interface ListedTool {
  name: string
  title?: string
  _meta?: { ui?: { resourceUri?: string }; "ui/resourceUri"?: string }
}

const WITH_VIEW = ["get_financial_context", "get_monthly_summary", "get_trends", "get_upcoming_payments", "create_transaction", "create_recurring_rule"]

describe("MCP Apps (ADR 0009)", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function connected() {
    const { app: http, entitlements } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    const userId = ((await (await http.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    await entitlements.grant(userId, { plan: "supporter", source: "manual" })
    return mcpClient(http, { cookie })
  }

  it("serves the views as one ui:// resource of the MCP Apps type, loading nothing from outside", async () => {
    const mcp = await connected()
    const listed = await mcp.call("resources/list")
    const resources = (listed.body as { result: { resources: { uri: string; mimeType: string }[] } }).result.resources
    expect(resources).toEqual([expect.objectContaining({ uri: VIEWS_URI, mimeType: "text/html;profile=mcp-app" })])

    const read = await mcp.call("resources/read", { uri: VIEWS_URI })
    const [content] = (read.body as { result: { contents: { uri: string; mimeType: string; text: string; _meta?: { ui?: { csp?: { resourceDomains?: string[] }; domain?: string } } }[] } }).result.contents
    expect(content?.mimeType).toBe("text/html;profile=mcp-app")
    expect(content?.text).toMatch(/^<!doctype html>/i)
    expect(content?._meta?.ui?.csp?.resourceDomains).toEqual(["https://assets.claude.ai"])
    // A local connector URL has no claudemcpcontent.com origin.
    expect(content?._meta?.ui?.domain).toBeUndefined()
  })

  it("links each tool that has a view to it, and gives every tool a title", async () => {
    const mcp = await connected()
    const listed = await mcp.call("tools/list")
    const tools = (listed.body as { result: { tools: ListedTool[] } }).result.tools
    // The session cookie has the read scope only; write-tools.test.ts checks the write tools' view.
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy()
      const uri = tool._meta?.ui?.resourceUri
      if (WITH_VIEW.includes(tool.name)) expect(uri, tool.name).toBe(VIEWS_URI)
      else expect(uri, tool.name).toBeUndefined()
    }
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_monthly_summary", "get_trends", "get_upcoming_payments", "search_transactions"]))
  })

  it("keeps returning plain JSON from the tools: the view reads structuredContent, other hosts the text", async () => {
    const mcp = await connected()
    const { result, data } = await mcp.tool("get_trends", { months: 3 })
    expect(JSON.parse(result.content[0]!.text)).toEqual(data)
    expect((data.months as unknown[]).length).toBe(3)
  })

  it("derives the sandbox origin Claude expects from the exact connector URL", () => {
    // The example Claude's documentation gives for this URL.
    expect(viewDomain("https://example.com/mcp")).toBe("c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com")
    // A trailing slash is a different connector URL, so a different origin.
    expect(viewDomain("https://example.com/mcp/")).not.toBe(viewDomain("https://example.com/mcp"))
    expect(viewDomain("http://localhost:3001/mcp")).toBeUndefined()
  })
})
