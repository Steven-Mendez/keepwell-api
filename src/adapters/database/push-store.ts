import { randomUUID } from "node:crypto"

import { and, eq, lt, ne } from "drizzle-orm"

import type { DeliveryStore, NewPushDevice, PushDevice, PushDeviceStore } from "../../core/ports/push"
import type { Logger } from "../observability/logger"
import type { Database } from "./client"
import { scopedDb } from "./scoped-db"
import { notificationDeliveries, pushDevices } from "./sync-tables"
import { withTransaction } from "./with-transaction"

type Stored = typeof pushDevices.$inferSelect

function device(row: Stored): PushDevice {
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    platform: row.platform as PushDevice["platform"],
    token: row.token,
    timeZone: row.time_zone,
    locale: row.locale,
    environment: row.environment === "sandbox" || row.environment === "production" ? row.environment : null,
    lastSeenAt: row.last_seen_at,
  }
}

/**
 * Push devices and deliveries (ADR 0012). A person's rows go through their ScopedDb; the two
 * cross-person operations the job needs (who has devices, pruning old deliveries) are the only raw
 * queries, and neither reads or returns another person's content.
 */
export class DrizzlePushStore implements PushDeviceStore, DeliveryStore {
  constructor(
    private readonly db: Database,
    private readonly log: Logger
  ) {}

  async upsert(userId: string, input: NewPushDevice, at: Date): Promise<void> {
    await withTransaction(this.db, this.log, async (tx) => {
      const scoped = scopedDb(tx, userId)
      const values = { platform: input.platform, token: input.token, time_zone: input.timeZone, locale: input.locale, environment: input.environment, last_seen_at: at }
      const updated = await scoped.update(pushDevices, values, eq(pushDevices.client_id, input.clientId))
      if (updated === 0) await scoped.insert(pushDevices, [{ id: randomUUID(), client_id: input.clientId, created_at: at, ...values }])
      // The same subscription or APNs token under another installation id (site data cleared, app
      // reinstalled): one device, so the old row goes rather than receiving every push twice.
      await scoped.delete(pushDevices, and(eq(pushDevices.token, input.token), ne(pushDevices.client_id, input.clientId))!)
    })
  }

  async remove(userId: string, clientId: string): Promise<void> {
    await scopedDb(this.db, userId).delete(pushDevices, eq(pushDevices.client_id, clientId))
  }

  async removeWithToken(userId: string, clientId: string, token: string): Promise<void> {
    await scopedDb(this.db, userId).delete(pushDevices, and(eq(pushDevices.client_id, clientId), eq(pushDevices.token, token))!)
  }

  async list(userId: string): Promise<PushDevice[]> {
    return ((await scopedDb(this.db, userId).select(pushDevices)) as Stored[]).map(device)
  }

  async usersWithDevices(): Promise<string[]> {
    const rows = await this.db.selectDistinct({ userId: pushDevices.user_id }).from(pushDevices)
    return rows.map((row) => row.userId)
  }

  async claim(userId: string, notificationId: string, at: Date): Promise<boolean> {
    // Two runs inserting the same row at once: under repeatable read (DSQL, and local Postgres) the
    // loser fails with a serialization error rather than meeting the conflict. Retried, it sees the
    // winner's row and claims nothing.
    const inserted = await withTransaction(this.db, this.log, (tx) =>
      tx
        .insert(notificationDeliveries)
        .values({ user_id: userId, notification_id: notificationId, sent_at: at })
        .onConflictDoNothing()
        .returning({ id: notificationDeliveries.notification_id })
    )
    return inserted.length > 0
  }

  async release(userId: string, notificationId: string): Promise<void> {
    await scopedDb(this.db, userId).delete(notificationDeliveries, eq(notificationDeliveries.notification_id, notificationId))
  }

  async prune(before: Date): Promise<number> {
    const result = await this.db.delete(notificationDeliveries).where(lt(notificationDeliveries.sent_at, before))
    return result.rowCount ?? 0
  }
}
