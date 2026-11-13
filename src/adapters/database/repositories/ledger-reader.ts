import { desc } from "drizzle-orm"

import { SYNC_ENTITIES, type SyncEntity } from "../../../core/domain/schema"
import type { LedgerRows } from "../../../core/ledger/wire-to-domain"
import type { LedgerReader } from "../../../core/ports/ledger-reader"
import { fromStored } from "../ledger-rows"
import type { ScopedDb } from "../scoped-db"
import { LEDGER_TABLES, pushDevices } from "../sync-tables"

export class ScopedLedgerReader implements LedgerReader {
  constructor(private readonly scoped: (userId: string) => ScopedDb) {}

  async load(userId: string): Promise<LedgerRows> {
    const db = this.scoped(userId)
    const entries = await Promise.all(
      SYNC_ENTITIES.map(async (entity: SyncEntity) => [entity, (await db.select(LEDGER_TABLES[entity])).map((row) => fromStored(entity, row))] as const)
    )
    return Object.fromEntries(entries) as unknown as LedgerRows
  }

  async latestDeviceTimeZone(userId: string): Promise<string | undefined> {
    const [device] = await this.scoped(userId).select(pushDevices, undefined, { orderBy: desc(pushDevices.last_seen_at), limit: 1 })
    return (device?.time_zone as string | undefined) ?? undefined
  }
}
