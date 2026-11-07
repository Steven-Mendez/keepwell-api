import { randomUUID } from "node:crypto"

import type { Entitlement, PlanName } from "../../core/capabilities"
import type { EntitlementRepository } from "../../core/ports/entitlements"
import type { Database } from "./client"
import { scopedDb } from "./scoped-db"
import { entitlements } from "./sync-tables"

export class DrizzleEntitlementRepository implements EntitlementRepository {
  constructor(private readonly db: Database) {}

  async forUser(userId: string): Promise<Entitlement[]> {
    const rows = await scopedDb(this.db, userId).select(entitlements)
    return rows.map((row) => ({
      plan: row.plan as PlanName,
      grantedAt: row.granted_at as Date,
      expiresAt: (row.expires_at as Date | null) ?? null,
      revokedAt: (row.revoked_at as Date | null) ?? null,
    }))
  }

  async grant(userId: string, grant: { plan: PlanName; source: "manual" | "app_store"; reference?: string; expiresAt?: Date | null }): Promise<string> {
    const id = randomUUID()
    await scopedDb(this.db, userId).insert(entitlements, [
      { id, plan: grant.plan, source: grant.source, reference: grant.reference ?? null, expires_at: grant.expiresAt ?? null },
    ])
    return id
  }
}
