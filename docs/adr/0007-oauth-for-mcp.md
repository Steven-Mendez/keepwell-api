# 0007. OAuth 2.1 for MCP with Better Auth

Status: accepted, November 2026

## Context

Claude.ai (and other MCP clients) must reach `/mcp` on the person's behalf without a password or a
long-lived key pasted anywhere. The MCP specification (2026-07-28) requires OAuth 2.1 with PKCE,
protected-resource metadata (RFC 9728), and recommends Client ID Metadata Documents (CIMD) over
dynamic registration. Claude.ai's default connector option is "published identity", i.e. CIMD.

## Decision

The API is its own authorization server, with Better Auth 1.7: `jwt` (signing keys, `/api/auth/jwks`),
`@better-auth/mcp` over `@better-auth/oauth-provider`, and `@better-auth/cimd` with the
`mcp-2026-07-28` profile. Versions before 1.7 of the old `mcp` plugin had CVE-2026-53512 and are never
installed.

- **Discovery** at the origin's root: `/.well-known/oauth-protected-resource` (and its `/mcp` form)
  and `/.well-known/oauth-authorization-server`, forwarded to Better Auth.
- **Clients**: CIMD first (`client_id_metadata_document_supported: true`, public clients with `none`
  at the token endpoint). Dynamic registration stays available for clients without CIMD, limited to
  10 an hour. Redirect URIs match exactly and must be `https` or a loopback address.
- **Flow**: authorization code with PKCE S256 only. No implicit, password or client-credentials grants.
  The login and consent pages are the web app's (`/connect`, `/connect/consent`), which shares the
  session cookie; the consent page shows the client's name, URI and scopes and asks explicitly.
- **Tokens**: access tokens are JWTs of 15 minutes, audience-bound to `https://api.<domain>/mcp`, so
  they are useless against any other route. Refresh tokens rotate, are stored hashed, and are
  revocable; reusing an old one revokes the chain.
- **Scopes**: `read` and `write` (increment 18), plus `offline_access` for refresh tokens. A
  read-only client never gets write tools.
- **Revocation**: per client from the web's settings (consent and refresh tokens deleted, audited),
  and "disconnect everything", which also stamps `users.mcp_tokens_not_before` so access tokens
  issued before it are refused at once. JWTs can't be revoked one by one; this is how revocation is
  immediate anyway.
- **`/mcp`** verifies the token (signature against the JWKS, issuer, audience, expiry), then the
  cutoff, then the `mcp` capability. Missing or invalid: 401 with `WWW-Authenticate` pointing at the
  metadata, never 403. Valid but without the plan: 403 `needs_plan`.

### Storage on DSQL

The provider's tables use `text[]` and `jsonb`, which Aurora DSQL doesn't have as column types. The
columns are `text`, and the Drizzle adapter is patched (`patches/@better-auth__drizzle-adapter*`) to
accept `supportsJSON: false` and `supportsArrays: false`, which makes Better Auth's core store them as
JSON text, as it already does for SQLite. The patch is two lines; Renovate updates must re-check it.

## Alternatives

- **Cognito.** Its Sign in with Apple goes through Managed Login in a web sheet, not the iPhone's
  native sheet, and it has no passkeys of its own. (Dynamic registration was not the reason: Claude.ai
  doesn't require it.)
- **Clerk.** Covers the same ground and is the best managed option, but moves sign-in out of AWS,
  mirrors users by webhook and has a price step past 10,000 monthly active users. Plan B if running
  an authorization server stops being worth it.
- **A hand-written authorization server.** No.

## Consequences

- Running an authorization server is part of the monthly upkeep: Better Auth and the MCP SDK are
  updated outside the weekly batch, and every update re-runs `tests/mcp/oauth.test.ts`.
- A client with a bad redirect URI is sent to the authorization server's error page, never to the
  unregistered address (tested).
