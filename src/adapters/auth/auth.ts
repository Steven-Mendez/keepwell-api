import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError } from "better-auth/api"

import type { AuditLog } from "../../core/ports/audit-log"
import type { AppConfig } from "../config/config"
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

/**
 * Better Auth with Sign in with Apple only. The web signs in through the redirect flow (audience:
 * the Services ID); the iPhone sends the ID token from the native sheet (audience: the bundle ID).
 * Registration is closed to an allowlist of Apple identifiers.
 */
export function createAuth(options: AuthOptions) {
  const { config, audit } = options
  const allowed = new Set(config.allowed_apple_subs)

  return betterAuth({
    appName: "Keepwell",
    baseURL: options.baseURL,
    basePath: "/api/auth",
    secret: config.auth_secret,
    trustedOrigins: [options.webOrigin, "https://appleid.apple.com"],
    database: drizzleAdapter(options.db, { provider: "pg", usePlural: true, schema }),
    socialProviders: {
      apple: {
        clientId: config.apple_services_id,
        clientSecret: options.appleClientSecret,
        appBundleIdentifier: config.apple_bundle_id,
        audience: [config.apple_services_id, config.apple_bundle_id],
        ...(options.verifyAppleIdToken ? { verifyIdToken: options.verifyAppleIdToken } : {}),
        // Runs on every Apple sign-in, new or returning, before any row is written.
        mapProfileToUser: async (profile: { sub?: string }) => {
          const sub = profile.sub ?? ""
          if (!allowed.has(sub)) {
            await audit.record({ action: "signin.rejected", details: { provider: "apple", reason: "not_allowed", apple_sub: sub } })
            throw new APIError("FORBIDDEN", { code: "NOT_INVITED", message: "Keepwell accounts are invite-only for now." })
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
    databaseHooks: {
      session: {
        create: {
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
