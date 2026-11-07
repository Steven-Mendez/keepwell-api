import { createHash, randomBytes, randomUUID } from "node:crypto"

import type { AuditLog } from "../ports/audit-log"
import type { InvitationStore } from "../ports/invitations"

export class NotInvited extends Error {
  constructor(readonly reason: "not_allowed" | "invalid_invitation") {
    super("Keepwell accounts are invite-only for now.")
  }
}

// Crockford base32 without I, L, O, U: nothing to misread when a code is dictated or typed.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** Uppercase, without separators or spaces, so "abcd-efgh" and "ABCD EFGH" are the same code. */
export const normalizeInvitation = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "")
export const hashInvitation = (code: string) => createHash("sha256").update(normalizeInvitation(code)).digest("hex")

/** 20 symbols, 100 bits: guessing one is not a threat worth a rate limit of its own. */
export function newInvitationCode(): string {
  const bytes = randomBytes(20)
  const symbols = [...bytes].map((b) => ALPHABET[b % 32]).join("")
  return symbols.match(/.{5}/g)!.join("-")
}

/**
 * Who may get a Keepwell account. The allowlist (the author) always; anyone who already has an
 * account; and a new person bringing an open invitation, which this consumes. Runs on every Apple
 * sign-in before any row is written.
 */
export class AdmitSignIn {
  constructor(
    private readonly allowed: ReadonlySet<string>,
    private readonly invitations: InvitationStore,
    private readonly audit: AuditLog,
    private readonly now: () => Date = () => new Date()
  ) {}

  async execute(appleSub: string, invitation: string | null): Promise<"allowlist" | "returning" | "invited"> {
    if (this.allowed.has(appleSub)) return "allowlist"
    if (await this.invitations.hasAppleAccount(appleSub)) return "returning"
    if (invitation && normalizeInvitation(invitation).length > 0) {
      if (await this.invitations.redeem(hashInvitation(invitation), appleSub, this.now())) {
        await this.audit.record({ action: "invitation.redeemed", details: { apple_sub: appleSub } })
        return "invited"
      }
      await this.audit.record({ action: "signin.rejected", details: { provider: "apple", reason: "invalid_invitation", apple_sub: appleSub } })
      throw new NotInvited("invalid_invitation")
    }
    await this.audit.record({ action: "signin.rejected", details: { provider: "apple", reason: "not_allowed", apple_sub: appleSub } })
    throw new NotInvited("not_allowed")
  }
}

/** Creates an invitation and returns the code, which is shown once and never stored. */
export async function createInvitation(store: InvitationStore, audit: AuditLog, options: { days: number; note: string | null; now?: Date }) {
  const code = newInvitationCode()
  const id = randomUUID()
  const expiresAt = new Date((options.now ?? new Date()).getTime() + options.days * 86_400_000)
  await store.create({ id, codeHash: hashInvitation(code), expiresAt, note: options.note })
  await audit.record({ action: "invitation.created", actor: "system", target: id, details: { days: options.days, note: options.note } })
  return { id, code, expiresAt }
}
