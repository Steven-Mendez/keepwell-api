import { InMemoryStore, isTimeZone, loadLedger, materializeRecurring, resolveTimeZone, type Ledger, type TimeZone } from "../domain/domain"
import { uuidV5 } from "../domain/schema"
import { recurringRuleToWire, toDomain, transactionToWire, type LedgerRows } from "../ledger/wire-to-domain"
import type { LedgerReader } from "../ports/ledger-reader"
import type { ApplySyncBatch } from "./apply-sync-batch"

/**
 * The zone for people who have none at all: `KEEPWELL_TIME_ZONE`, or Managua, where Keepwell started.
 * An unknown name falls back to UTC.
 */
export function defaultTimeZone(env: Record<string, string | undefined>): TimeZone {
  return resolveTimeZone(env.KEEPWELL_TIME_ZONE ?? "America/Managua")
}

/** The client id the server writes under when it changes data itself. */
export const SERVER_CLIENT_ID = "00000000-0000-5000-8000-000000000000"

/**
 * The ledger as the MCP tools see it. Before answering, recurring occurrences that came due are
 * recorded, so "how much did I spend" includes the rent of the 1st even if no app opened since.
 * Occurrence ids are name-based (ADR 0005), so the server, the iPhone and the web recording the same
 * one produce one row; the events are name-based too, so reading twice writes nothing twice.
 *
 * Advancing a rule is not an edit: the rule goes up with the `updated_at` it already had, so it
 * applies on the tie (ADR 0005) and an edit a device made earlier but sends later still wins. If that
 * edit carries an old `nextDate`, the next read advances the rule again (the occurrences are already
 * there, so only the rule is written).
 */
export class ReadLedger {
  /** `defaultTimeZone`: the deployment's (`KEEPWELL_TIME_ZONE`), for people with no zone at all. */
  constructor(
    private readonly reader: LedgerReader,
    private readonly writer: ApplySyncBatch,
    private readonly defaultTimeZone: TimeZone,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /**
   * The zone the server reads this person's days and months in: the home zone in their settings;
   * without one (an account no app has set it for yet), the zone of their most recently seen device,
   * the one their own app computes in, as notifications always did; without a device either, the
   * deployment's default. Never the process's.
   */
  async timeZone(userId: string, rows: LedgerRows): Promise<TimeZone> {
    const home = rows.settings.find((row) => row.deleted_at === null)?.time_zone
    if (isTimeZone(home)) return home
    return resolveTimeZone(await this.reader.latestDeviceTimeZone(userId), this.defaultTimeZone)
  }

  async execute(userId: string): Promise<Ledger> {
    return (await this.load(userId)).ledger
  }

  /**
   * The ledger and the rows it came from. `fresh` is false when recording due occurrences changed
   * the rows, so a caller that needs the stored rows reads them again.
   */
  async load(userId: string): Promise<{ ledger: Ledger; rows: Awaited<ReturnType<LedgerReader["load"]>>; fresh: boolean }> {
    const now = this.clock()
    const rows = await this.reader.load(userId)
    const store = new InMemoryStore(await this.timeZone(userId, rows), toDomain(rows))
    const before = new Map((await store.fetchRecurringRules()).map((rule) => [rule.id, rule.nextDate]))
    const created = await materializeRecurring(store, now)
    const advanced = (await store.fetchRecurringRules()).filter((rule) => before.get(rule.id) !== rule.nextDate)
    if (created.length > 0 || advanced.length > 0) {
      const at = now.toISOString()
      const stored = new Map(rows.recurringRule.map((row) => [row.id, row]))
      const events = [
        ...created.map((transaction) => ({
          event_id: uuidV5(`materialize|${transaction.id}`),
          entity: "transaction",
          entity_id: transaction.id,
          operation: "create",
          payload: transactionToWire(transaction, { created_at: at, updated_at: at }),
          created_at: at,
        })),
        ...advanced.map((rule) => {
          // The stamp it had, so an edit stamped before this read still wins; it is in the event id
          // too, so advancing again after such an edit is a new event, not the replay of this one.
          const updatedAt = stored.get(rule.id)?.updated_at ?? at
          return {
            event_id: uuidV5(`advance|${rule.id}|${rule.nextDate}|${updatedAt}`),
            entity: "recurringRule",
            entity_id: rule.id,
            operation: "update",
            payload: recurringRuleToWire(rule, { created_at: stored.get(rule.id)?.created_at ?? at, updated_at: updatedAt }),
            created_at: at,
          }
        }),
      ]
      await this.writer.execute({ userId, clientId: SERVER_CLIENT_ID, platform: "other", events, deadline: Date.now() + 10_000 })
    }
    return { ledger: await loadLedger(store), rows, fresh: created.length === 0 && advanced.length === 0 }
  }
}
