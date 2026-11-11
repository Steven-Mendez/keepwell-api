import { serve, type ServerType } from "@hono/node-server"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { adminDatabase, appDatabase } from "../support/database"
import { CLAUDE_CALLBACK, connectClient, mcpCall, refresh } from "../support/oauth"
import { signIn, testAuthApp } from "../support/auth"
import { wipe } from "../support/sync"

// OAuth 2.1 for MCP end to end over a real port: requireMcpAuth fetches the JWKS over HTTP.
describe("MCP over OAuth 2.1", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  const port = 39873
  const base = `http://localhost:${port}`
  let server: ServerType
  let harness: ReturnType<typeof testAuthApp>

  beforeAll(() => {
    harness = testAuthApp(app.db, {}, { baseURL: base })
    server = serve({ fetch: harness.app.fetch, port })
  })
  afterAll(async () => {
    server.close()
    await Promise.all([app.close(), admin.close()])
  })
  beforeEach(async () => {
    await wipe(admin.db)
    for (const table of ["oauth_consents", "oauth_refresh_tokens", "oauth_access_tokens", "oauth_clients", "oauth_client_resources"]) await admin.db.execute(sql.raw(`delete from ${table}`))
  })

  async function supporter() {
    const { cookie } = await signIn(harness.app, "000001.author")
    const userId = ((await (await harness.app.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    await harness.entitlements.grant(userId, { plan: "supporter", source: "manual" })
    return { cookie, userId }
  }

  it("publishes discovery documents at the root, with CIMD and PKCE", async () => {
    const resource = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>
    expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [`${base}/api/auth`], scopes_supported: ["read", "write", "manage"] })
    const server = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>
    expect(server).toMatchObject({ client_id_metadata_document_supported: true, code_challenge_methods_supported: ["S256"] })
    expect(server.token_endpoint_auth_methods_supported).toContain("none")
    expect(server.grant_types_supported).not.toContain("password")
    expect(server.grant_types_supported).not.toContain("implicit")
  })

  it("connects Claude: consent, a 15-minute token bound to /mcp, and the tools answer", async () => {
    const { cookie } = await supporter()
    const { token, consentPage } = await connectClient(base, cookie)
    expect(consentPage!.origin).toBe("http://localhost:3000")
    expect(consentPage!.pathname).toBe("/connect/consent")
    expect(token!.expires_in).toBe(900)
    const claims = JSON.parse(Buffer.from(token!.access_token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>
    expect(claims).toMatchObject({ aud: `${base}/mcp`, scope: "read offline_access" })
    const list = await mcpCall(base, token!.access_token, "tools/list")
    expect(list.status).toBe(200)
    expect(((await list.json()) as { result: { tools: unknown[] } }).result.tools.length).toBe(13)
  })

  it("refuses a redirect URI the client didn't register", async () => {
    const { cookie } = await supporter()
    const attempt = await connectClient(base, cookie, { redirectUri: "https://evil.example/callback" })
    expect(attempt.token).toBeUndefined()
    // Sent to the authorization server's own error page, never to the unregistered address.
    expect(attempt.next).toContain("error=invalid_redirect")
    expect(attempt.next).not.toContain("evil.example")
  })

  it("refuses a missing or forged token with 401 and the discovery pointer", async () => {
    for (const token of ["", "not-a-jwt", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0."]) {
      const res = await mcpCall(base, token, "tools/list")
      expect(res.status).toBe(401)
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata=")
    }
  })

  it("answers 403 needs_plan to a valid token whose account lacks the coffee", async () => {
    const { cookie } = await signIn(harness.app, "000001.author")
    const { token } = await connectClient(base, cookie)
    const res = await mcpCall(base, token!.access_token, "tools/list")
    expect(res.status).toBe(403)
    expect(await res.text()).toContain("needs_plan")
  })

  it("lists the connected client, revokes it, and its refresh token stops working", async () => {
    const { cookie } = await supporter()
    const { token, clientId } = await connectClient(base, cookie)
    const list = (await (await harness.app.request("/mcp/clients", { headers: { cookie } })).json()) as { clients: { client_id: string; name: string; scopes: string[] }[] }
    expect(list.clients).toMatchObject([{ client_id: clientId, name: "Claude" }])
    expect((await harness.app.request(`/mcp/clients/${clientId}`, { method: "DELETE", headers: { cookie, origin: "http://localhost:3000" } })).status).toBe(204)
    expect((await refresh(base, clientId, token!.refresh_token!)).status).toBeGreaterThanOrEqual(400)
    const audit = (await admin.db.execute<{ action: string }>(sql`select action from audit_log where action like 'mcp.%' order by at`)).rows
    expect(audit.map((row) => row.action)).toEqual(["mcp.client_authorized", "mcp.client_revoked"])
  })

  it("disconnects everything at once: even unexpired access tokens stop working", async () => {
    const { cookie } = await supporter()
    const { token } = await connectClient(base, cookie)
    expect((await mcpCall(base, token!.access_token, "tools/list")).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect((await harness.app.request("/mcp/disconnect-all", { method: "POST", headers: { cookie, origin: "http://localhost:3000" } })).status).toBe(204)
    const after = await mcpCall(base, token!.access_token, "tools/list")
    expect(after.status).toBe(401)
    expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"')
    expect(CLAUDE_CALLBACK).toContain("claude.ai")
  })
})
