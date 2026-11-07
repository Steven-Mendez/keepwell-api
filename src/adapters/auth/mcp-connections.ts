import { and, eq, inArray } from "drizzle-orm"

import type { AuditLog } from "../../core/ports/audit-log"
import type { Database } from "../database/client"
import { oauthClients, oauthConsents, oauthRefreshTokens, users } from "../database/schema"

export interface McpConnection {
  clientId: string
  name: string | null
  uri: string | null
  scopes: string[]
  connectedAt: Date
}

const parseList = (value: string | null) => {
  if (!value) return []
  try {
    return JSON.parse(value) as string[]
  } catch {
    return value.split(" ").filter(Boolean)
  }
}

/**
 * The MCP clients a person has connected, and how they disconnect them. Every query names the user:
 * the OAuth tables belong to Better Auth, so they don't go through ScopedDb.
 */
export class McpConnections {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLog
  ) {}

  async list(userId: string): Promise<McpConnection[]> {
    const consents = await this.db.select().from(oauthConsents).where(eq(oauthConsents.userId, userId))
    if (consents.length === 0) return []
    const clients = await this.db.select().from(oauthClients).where(inArray(oauthClients.clientId, consents.map((consent) => consent.clientId)))
    return consents.map((consent) => {
      const client = clients.find((candidate) => candidate.clientId === consent.clientId)
      return { clientId: consent.clientId, name: client?.name ?? null, uri: client?.uri ?? null, scopes: parseList(consent.scopes), connectedAt: consent.createdAt }
    })
  }

  /** Ends one client's access: its consent and refresh tokens go; its access token dies within 15 minutes. */
  async revoke(userId: string, clientId: string): Promise<boolean> {
    const removed = await this.db.delete(oauthConsents).where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId))).returning({ id: oauthConsents.id })
    await this.db.delete(oauthRefreshTokens).where(and(eq(oauthRefreshTokens.userId, userId), eq(oauthRefreshTokens.clientId, clientId)))
    if (removed.length > 0) await this.audit.record({ action: "mcp.client_revoked", userId, target: clientId })
    return removed.length > 0
  }

  /** "Disconnect everything": every consent and refresh token goes, and access tokens issued until now stop working at once. */
  async disconnectAll(userId: string, now = new Date()): Promise<void> {
    await this.db.update(users).set({ mcpTokensNotBefore: now }).where(eq(users.id, userId))
    await this.db.delete(oauthConsents).where(eq(oauthConsents.userId, userId))
    await this.db.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.userId, userId))
    await this.audit.record({ action: "mcp.disconnected_all", userId })
  }

  /** Whether a token issued at `issuedAt` (seconds) predates a "disconnect everything". */
  async isCutOff(userId: string, issuedAt: number | undefined): Promise<boolean> {
    const [user] = await this.db.select({ cutoff: users.mcpTokensNotBefore }).from(users).where(eq(users.id, userId))
    if (!user) return true
    if (!user.cutoff) return false
    return issuedAt === undefined || issuedAt * 1000 < user.cutoff.getTime()
  }
}
