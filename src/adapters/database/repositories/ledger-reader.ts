import { SYNC_ENTITIES, type SyncEntity } from "../../../core/domain/schema"
import type { LedgerRows } from "../../../core/ledger/wire-to-domain"
import type { LedgerReader } from "../../../core/ports/ledger-reader"
import { fromStored } from "../ledger-rows"
import type { ScopedDb } from "../scoped-db"
import { LEDGER_TABLES } from "../sync-tables"

export class ScopedLedgerReader implements LedgerReader {
  constructor(private readonly scoped: (userId: string) => ScopedDb) {}

  async load(userId: string): Promise<LedgerRows> {
    const db = this.scoped(userId)
    const entries = await Promise.all(
      SYNC_ENTITIES.map(async (entity: SyncEntity) => [entity, (await db.select(LEDGER_TABLES[entity])).map((row) => fromStored(entity, row))] as const)
    )
    return Object.fromEntries(entries) as unknown as LedgerRows
  }
}
