import { createHash } from "node:crypto"

import type { AuditLog } from "../ports/audit-log"
import type { AppStoreVerifier, PurchaseStore, RedeemResult } from "../ports/app-store"

export class PurchaseError extends Error {
  constructor(
    readonly code: "invalid_purchase" | "unknown_product" | "wrong_environment" | "revoked" | "already_redeemed_elsewhere",
    message: string
  ) {
    super(message)
  }
}

/**
 * POST /entitlements/app-store: the iPhone sends the JWS StoreKit 2 gave it after the coffee. The
 * signature is checked against Apple's root (outside the transaction: it may fetch nothing, but it
 * isn't SQL), then in one transaction: the Idempotency-Key is reserved, the purchase is recorded
 * for this account (one account per original transaction), the plan is granted once, and the answer
 * is stored under the key so a retry gets the same one. Restoring purchases sends the same JWS again
 * and gets the same answer.
 */
export class RedeemPurchase {
  constructor(
    private readonly verifier: AppStoreVerifier,
    private readonly store: PurchaseStore,
    private readonly audit: AuditLog,
    /** productId → plan, e.g. { "app.keepwell.coffee": "supporter" }. */
    private readonly products: Record<string, string>,
    /** Sandbox purchases are accepted only where this says so (dev). */
    private readonly acceptSandbox: boolean
  ) {}

  async execute(input: { userId: string; signedTransaction: string; idempotencyKey: string }): Promise<{ status: number; body: unknown }> {
    let verified
    try {
      verified = await this.verifier.transaction(input.signedTransaction)
    } catch {
      throw new PurchaseError("invalid_purchase", "Apple's signature on this purchase doesn't check out.")
    }
    const plan = this.products[verified.productId]
    if (!plan) throw new PurchaseError("unknown_product", "This product doesn't unlock anything in Keepwell.")
    const sandbox = verified.environment !== "Production"
    if (sandbox && !this.acceptSandbox) throw new PurchaseError("wrong_environment", "Sandbox purchases aren't accepted here.")
    if (verified.revokedAt) throw new PurchaseError("revoked", "Apple refunded or revoked this purchase.")

    const requestHash = createHash("sha256").update(input.signedTransaction).digest("hex")
    const answer = await this.store.transaction(input.userId, async (unit) => {
      const stored = await unit.reserveKey(input.idempotencyKey, requestHash)
      if (stored) return stored
      const owner = await unit.owner(verified.originalTransactionId)
      let result: RedeemResult
      if (owner && owner.userId !== null && owner.userId !== input.userId) {
        result = { status: "already_redeemed_elsewhere" }
      } else {
        if (!owner) await unit.recordPurchase(verified)
        await unit.grantOnce(plan, verified.originalTransactionId, verified.expiresAt)
        result = { status: "granted", plan, originalTransactionId: verified.originalTransactionId }
      }
      const status = result.status === "granted" ? 200 : 409
      const body = result.status === "granted" ? { plan: result.plan } : { error: { code: "already_redeemed_elsewhere", message: "This purchase belongs to another Keepwell account." } }
      await unit.saveAnswer(input.idempotencyKey, status, body)
      return { status, body }
    })
    await this.audit.record({
      action: answer.status === 200 ? "entitlement.granted" : "purchase.refused",
      userId: input.userId,
      target: verified.originalTransactionId,
      details: { plan, source: "app_store", environment: verified.environment, reason: answer.status === 200 ? null : "already_redeemed_elsewhere" },
    })
    return answer
  }
}

/**
 * POST /webhooks/app-store: App Store Server Notifications V2. Verified like a purchase, applied once
 * per notificationUUID, and REFUND or REVOKE revoke the plan in the same request (Apple retries for
 * days until it gets a 200, so no queue is needed; ADR 0006).
 */
export class HandleAppStoreNotification {
  constructor(
    private readonly verifier: AppStoreVerifier,
    private readonly store: PurchaseStore,
    private readonly audit: AuditLog
  ) {}

  async execute(signedPayload: string): Promise<{ applied: boolean }> {
    let notification
    try {
      notification = await this.verifier.notification(signedPayload)
    } catch {
      throw new PurchaseError("invalid_purchase", "Apple's signature on this notification doesn't check out.")
    }
    const outcome = await this.store.applyNotification(notification)
    if (outcome.applied && (notification.type === "REFUND" || notification.type === "REVOKE")) {
      await this.audit.record({
        action: "entitlement.revoked",
        actor: "system",
        userId: outcome.userId,
        target: notification.transaction?.originalTransactionId ?? null,
        details: { source: "app_store", notification: notification.type },
      })
    }
    return { applied: outcome.applied }
  }
}
