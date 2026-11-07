import { and, eq, isNull, sql } from "drizzle-orm"

import { IdempotencyKeyReuse, type PurchaseStore, type PurchaseUnitOfWork, type VerifiedNotification } from "../../core/ports/app-store"
import type { Logger } from "../observability/logger"
import type { Database } from "./client"
import { scopedDb } from "./scoped-db"
import { appStoreNotifications, appStoreTransactions, entitlements, idempotencyKeys } from "./sync-tables"
import { withTransaction, type Transaction } from "./with-transaction"

const KEY_LIFETIME_MS = 24 * 3600 * 1000

/**
 * Purchases and their notifications. The account's own rows go through ScopedDb; the purchase table
 * is global on purpose, since one original transaction may belong to one account only and the check
 * must see every account.
 */
export class DrizzlePurchaseStore implements PurchaseStore {
  constructor(
    private readonly db: Database,
    private readonly log: Logger
  ) {}

  transaction<T>(userId: string, work: (unit: PurchaseUnitOfWork) => Promise<T>): Promise<T> {
    return withTransaction(this.db, this.log, (tx) => work(this.unit(tx, userId)))
  }

  private unit(tx: Transaction, userId: string): PurchaseUnitOfWork {
    const mine = scopedDb(tx, userId)
    return {
      async reserveKey(key, requestHash) {
        const [existing] = await mine.select(idempotencyKeys, eq(idempotencyKeys.key, key))
        if (existing) {
          if (existing.request_hash !== requestHash) throw new IdempotencyKeyReuse()
          if (existing.status_code !== null) return { status: Number(existing.status_code), body: JSON.parse(String(existing.response)) }
          return undefined
        }
        await mine.insert(idempotencyKeys, [{ key, request_hash: requestHash, expires_at: new Date(Date.now() + KEY_LIFETIME_MS) }])
        return undefined
      },
      async saveAnswer(key, status, body) {
        await mine.update(idempotencyKeys, { status_code: status, response: JSON.stringify(body) }, eq(idempotencyKeys.key, key))
      },
      async owner(originalTransactionId) {
        const [row] = await tx.select().from(appStoreTransactions).where(eq(appStoreTransactions.original_transaction_id, originalTransactionId))
        return row ? { userId: row.user_id, revokedAt: row.revoked_at } : undefined
      },
      async recordPurchase(transaction) {
        await tx.insert(appStoreTransactions).values({
          original_transaction_id: transaction.originalTransactionId,
          user_id: userId,
          product_id: transaction.productId,
          environment: transaction.environment,
          purchased_at: transaction.purchasedAt,
        })
      },
      async grantOnce(plan, reference, expiresAt) {
        const active = await mine.select(entitlements, and(eq(entitlements.reference, reference), isNull(entitlements.revoked_at)))
        if (active.length > 0) return
        await mine.insert(entitlements, [{ id: crypto.randomUUID(), plan, source: "app_store", reference, expires_at: expiresAt }])
      },
    }
  }

  async applyNotification(notification: VerifiedNotification) {
    return withTransaction(this.db, this.log, async (tx) => {
      const inserted = await tx
        .insert(appStoreNotifications)
        .values({
          notification_uuid: notification.notificationUUID,
          type: notification.type,
          subtype: notification.subtype,
          original_transaction_id: notification.transaction?.originalTransactionId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: appStoreNotifications.notification_uuid })
      if (inserted.length === 0) return { applied: false, userId: null }
      const original = notification.transaction?.originalTransactionId
      if (!original) return { applied: true, userId: null }
      const [purchase] = await tx.select().from(appStoreTransactions).where(eq(appStoreTransactions.original_transaction_id, original))
      await tx.update(appStoreTransactions).set({ last_notification_at: sql`now()` }).where(eq(appStoreTransactions.original_transaction_id, original))
      if (notification.type === "REFUND" || notification.type === "REVOKE") {
        const at = notification.transaction?.revokedAt ?? new Date()
        await tx.update(appStoreTransactions).set({ revoked_at: at }).where(eq(appStoreTransactions.original_transaction_id, original))
        await tx.update(entitlements).set({ revoked_at: at }).where(and(eq(entitlements.reference, original), isNull(entitlements.revoked_at)))
      }
      return { applied: true, userId: purchase?.user_id ?? null }
    })
  }
}
