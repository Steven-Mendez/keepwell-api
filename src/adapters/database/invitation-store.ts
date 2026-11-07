import { and, eq, gt, isNull, or, sql } from "drizzle-orm"

import type { InvitationStore } from "../../core/ports/invitations"
import type { Database } from "./client"
import { accounts } from "./schema"
import { invitations } from "./sync-tables"

export class DrizzleInvitationStore implements InvitationStore {
  constructor(private readonly db: Database) {}

  async hasAppleAccount(appleSub: string) {
    const rows = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.providerId, "apple"), eq(accounts.accountId, appleSub)))
      .limit(1)
    return rows.length > 0
  }

  // One statement: two people racing for the same code cannot both win (under DSQL the loser gets
  // an optimistic-concurrency error, which fails that sign-in; trying again finds it used).
  async redeem(codeHash: string, appleSub: string, now: Date) {
    const rows = await this.db
      .update(invitations)
      .set({ redeemed_at: sql`coalesce(${invitations.redeemed_at}, ${now})`, redeemed_by: appleSub })
      .where(
        and(
          eq(invitations.code_hash, codeHash),
          gt(invitations.expires_at, now),
          or(isNull(invitations.redeemed_by), eq(invitations.redeemed_by, appleSub))
        )
      )
      .returning({ id: invitations.id })
    return rows.length > 0
  }

  async isOpen(codeHash: string, now: Date) {
    const rows = await this.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(eq(invitations.code_hash, codeHash), gt(invitations.expires_at, now), isNull(invitations.redeemed_by)))
    return rows.length > 0
  }

  async create(invitation: { id: string; codeHash: string; expiresAt: Date; note: string | null }) {
    await this.db.insert(invitations).values({ id: invitation.id, code_hash: invitation.codeHash, expires_at: invitation.expiresAt, note: invitation.note })
  }
}
