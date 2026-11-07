import { createHash, randomBytes } from "node:crypto"

export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback"

/** An MCP client going through OAuth 2.1 as Claude.ai does: register, authorize with PKCE, consent, exchange. */
export async function connectClient(base: string, cookie: string, options: { scope?: string; redirectUri?: string } = {}) {
  const registration = (await (
    await fetch(`${base}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none", client_name: "Claude", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "read write offline_access" }),
    })
  ).json()) as { client_id: string }
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: options.redirectUri ?? CLAUDE_CALLBACK,
    scope: options.scope ?? "read offline_access",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${base}/mcp`,
  })
  const authorize = await fetch(`${base}/api/auth/oauth2/authorize?${query}`, { headers: { cookie }, redirect: "manual" })
  const authorizeBody = await authorize.text()
  const next = authorize.status < 400 ? (JSON.parse(authorizeBody) as { url?: string }).url : undefined
  if (!next?.includes("/connect/consent")) return { clientId: registration.client_id, authorizeStatus: authorize.status, authorizeBody, next }
  const consentPage = new URL(next)
  const consent = (await (
    await fetch(`${base}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
    })
  ).json()) as { url: string }
  const code = new URL(consent.url).searchParams.get("code")!
  const token = (await (
    await fetch(`${base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_CALLBACK, client_id: registration.client_id, code_verifier: verifier, resource: `${base}/mcp` }),
    })
  ).json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string }
  return { clientId: registration.client_id, consentPage, token, authorizeStatus: authorize.status }
}

export async function refresh(base: string, clientId: string, refreshToken: string) {
  return fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: `${base}/mcp` }),
  })
}

export async function mcpCall(base: string, token: string, method: string, params: Record<string, unknown> = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
}
