/** A purchase as Apple signed it, after the signature and certificate chain checked out. */
export interface VerifiedTransaction {
  originalTransactionId: string
  transactionId: string
  productId: string
  bundleId: string
  environment: "Production" | "Sandbox" | "Xcode" | "LocalTesting"
  purchasedAt: Date
  revokedAt: Date | null
  expiresAt: Date | null
}

export interface VerifiedNotification {
  notificationUUID: string
  type: string
  subtype: string | null
  transaction: VerifiedTransaction | null
}

/** Verifies App Store JWS against Apple's root, bundle id and environment. Throws when they don't check out. */
export interface AppStoreVerifier {
  transaction(signed: string): Promise<VerifiedTransaction>
  notification(signed: string): Promise<VerifiedNotification>
}

export type RedeemResult =
  | { status: "granted"; plan: string; originalTransactionId: string }
  | { status: "already_redeemed_elsewhere" }

/** One redemption inside one database transaction (the idempotency key is reserved in it too). */
export interface PurchaseUnitOfWork {
  /** The stored answer for this key, or undefined after reserving it. Throws `KeyReuse` for another request. */
  reserveKey(key: string, requestHash: string): Promise<{ status: number; body: unknown } | undefined>
  saveAnswer(key: string, status: number, body: unknown): Promise<void>
  /** Who holds this purchase, if anyone. */
  owner(originalTransactionId: string): Promise<{ userId: string | null; revokedAt: Date | null } | undefined>
  recordPurchase(transaction: VerifiedTransaction): Promise<void>
  /** Grants the plan for this purchase unless an active grant with this reference exists. */
  grantOnce(plan: string, reference: string, expiresAt: Date | null): Promise<void>
}

export interface PurchaseStore {
  transaction<T>(userId: string, work: (unit: PurchaseUnitOfWork) => Promise<T>): Promise<T>
  /** Notification side (no user session): applies a refund or revocation by original transaction. */
  applyNotification(notification: VerifiedNotification): Promise<{ applied: boolean; userId: string | null }>
}

export class IdempotencyKeyReuse extends Error {
  constructor() {
    super("This Idempotency-Key was used for a different request")
  }
}
