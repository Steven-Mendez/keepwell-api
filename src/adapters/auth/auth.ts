import { cimd } from "@better-auth/cimd"
import { fetchClientMetadataResource } from "@better-auth/cimd/node"
import { mcp } from "@better-auth/mcp"
import { passkey } from "@better-auth/passkey"
import { betterAuth } from "better-auth"
import { jwt } from "better-auth/plugins"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { and, eq, isNotNull } from "drizzle-orm"

import type { AuditLog } from "../../core/ports/audit-log"
import { AdmitSignIn, NotInvited } from "../../core/use-cases/admit-sign-in"
import { DrizzleInvitationStore } from "../database/invitation-store"
import { currentRequest } from "../observability/request-context"
import { appleBundleIds, type AppConfig } from "../config/config"
import type { Database } from "../database/client"
import * as schema from "../database/schema"

export interface AuthOptions {
  db: Database
  config: AppConfig
  audit: AuditLog
  /** Public URL of this API, such as https://api.example.com. */
  baseURL: string
  /** The web app's origin, such as https://app.example.com. Trusted for redirects and CORS. */
  webOrigin: string
  /** Registrable domain shared by app. and api., so the session cookie reaches both. Unset locally. */
  cookieDomain?: string
  /** Apple's client secret, minted from the .p8 key at start-up (adapters/external/apple/client-secret.ts). */
  appleClientSecret: string
  /**
   * Replaces Apple's signature check. Tests only: they sign ID tokens with their own key. Production
   * uses Better Auth's verification (Apple's JWKS, issuer, audience, expiry, nonce).
   */
  verifyAppleIdToken?: (token: string, nonce?: string) => Promise<boolean>
}

export const SESSION_DAYS = 30
/** MCP access tokens live 15 minutes; refresh tokens rotate and are revocable (ADR 0007). */
export const MCP_ACCESS_TOKEN_SECONDS = 15 * 60
export const MCP_SCOPES = ["read", "write", "offline_access"] as const

/** Exact match is the provider's default; on top of it, only https or a loopback address. */
export function allowedRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri)
    if (url.protocol === "https:") return true
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  } catch {
    return false
  }
}

/**
 * Better Auth with Sign in with Apple only. The web signs in through the redirect flow (audience:
 * the Services ID); the iPhone sends the ID token from the native sheet (audience: the bundle ID).
 * Registration is closed: the allowlist, returning people, and invitations (core/use-cases/admit-sign-in).
 */
export function createAuth(options: AuthOptions) {
  const { config, audit } = options
  const admission = new AdmitSignIn(new Set(config.allowed_apple_subs), new DrizzleInvitationStore(options.db), audit)

  return betterAuth({
    appName: "Keepwell",
    baseURL: options.baseURL,
    basePath: "/api/auth",
    secret: config.auth_secret,
    trustedOrigins: [options.webOrigin, "https://appleid.apple.com"],
    // Its own error page is bare text; the web's sign-in page explains the code instead.
    onAPIError: { errorURL: `${options.webOrigin}/login` },
    // JSON and arrays as text: Aurora DSQL has no jsonb or array columns (patched adapter option).
    database: drizzleAdapter(options.db, { provider: "pg", usePlural: true, schema, supportsJSON: false, supportsArrays: false }),
    plugins: [
      // Passkeys belong to the web app's host; the iPhone shares them through its associated domain
      // (webcredentials:app.<domain>), so both sign in with the same credential.
      passkey({ rpID: new URL(options.webOrigin).hostname, rpName: "Keepwell", origin: [options.webOrigin] }),
      // Signs MCP access tokens; /api/auth/jwks publishes the keys requireMcpAuth verifies against.
      jwt(),
      mcp({
        resource: `${options.baseURL}/mcp`,
        // Both pages live in the web app, which shares the session cookie with the API.
        loginPage: `${options.webOrigin}/connect`,
        consentPage: `${options.webOrigin}/connect/consent`,
        scopes: [...MCP_SCOPES],
        clientRegistrationDefaultScopes: ["read", "offline_access"],
        clientRegistrationAllowedScopes: [...MCP_SCOPES],
        clientRegistrationRequirePKCE: true,
        accessTokenExpiresIn: MCP_ACCESS_TOKEN_SECONDS,
        grantTypes: ["authorization_code", "refresh_token"],
        // CIMD first; dynamic registration stays as a fallback for clients without it, rate limited.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        rateLimit: { register: { window: 3600, max: 10 } },
        validateRedirectUri: (uri, _registered, exactMatch) => exactMatch && allowedRedirectUri(uri),
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
    socialProviders: {
      apple: {
        clientId: config.apple_services_id,
        clientSecret: options.appleClientSecret,
        appBundleIdentifier: appleBundleIds(config)[0],
        // The web (Services ID) and every iOS build allowed: an ID token's audience is its bundle ID.
        audience: [config.apple_services_id, ...appleBundleIds(config)],
        ...(options.verifyAppleIdToken ? { verifyIdToken: options.verifyAppleIdToken } : {}),
        // Runs on every Apple sign-in, new or returning, before any row is written.
        mapProfileToUser: async (profile: { sub?: string }) => {
          try {
            await admission.execute(profile.sub ?? "", currentRequest()?.invitation ?? null)
          } catch (error) {
            if (error instanceof NotInvited) {
              const code = error.reason === "invalid_invitation" ? "INVALID_INVITATION" : "NOT_INVITED"
              throw new APIError("FORBIDDEN", { code, message: error.message })
            }
            throw error
          }
          return {}
        },
      },
    },
    account: {
      // We never call Apple on the person's behalf; whatever tokens it returns are stored encrypted.
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    session: {
      expiresIn: SESSION_DAYS * 24 * 3600,
      updateAge: 24 * 3600,
    },
    advanced: {
      useSecureCookies: options.baseURL.startsWith("https://"),
      ...(options.cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: options.cookieDomain } } : {}),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    hooks: {
      // Passkeys and connected MCP clients are security events (audit_log), like sign-ins.
      after: createAuthMiddleware(async (ctx) => {
        const userId = ctx.context.session?.user.id ?? ctx.context.newSession?.user.id
        if (ctx.path === "/passkey/verify-registration" && userId && !(ctx.context.returned instanceof Error)) {
          await audit.record({ action: "passkey.created", userId })
        }
        if (ctx.path === "/oauth2/consent" && userId && (ctx.body as { accept?: boolean } | undefined)?.accept) {
          await audit.record({ action: "mcp.client_authorized", userId, details: { scopes: String((ctx.body as { scope?: string }).scope ?? "requested") } })
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // An account waiting for deletion can't get a session back, not even through Apple.
          before: async (session) => {
            const marked = await options.db
              .select({ id: schema.users.id })
              .from(schema.users)
              .where(and(eq(schema.users.id, session.userId), isNotNull(schema.users.deletionRequestedAt)))
            if (marked.length > 0) {
              throw new APIError("FORBIDDEN", { code: "ACCOUNT_DELETED", message: "This account is being deleted." })
            }
          },
          after: async (session) => {
            await audit.record({ action: "session.created", userId: session.userId, tokenId: session.id })
          },
        },
      },
      user: {
        create: {
          after: async (user) => {
            await audit.record({ action: "account.created", userId: user.id, details: { provider: "apple" } })
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
