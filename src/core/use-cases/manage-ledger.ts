import { DomainError } from "../domain/domain"
import { loanPaymentId, uuidV5, type SyncEntity, type TransactionCategory } from "../domain/schema"
import {
  accountColumns,
  cardColumns,
  categorizationRuleColumns,
  categoryColumns,
  loanColumns,
  loanPaymentColumns,
  NO_AUDIT,
  personalDebtColumns,
  recurringRuleColumns,
  repaymentColumns,
  savingsGoalColumns,
  settingsColumns,
  transactionColumns,
} from "../ledger/domain-to-wire"
import { RecordingStore, type TouchedKind } from "../ledger/recording-store"
import { toDomain, type LedgerRows } from "../ledger/wire-to-domain"
import type { LedgerReader } from "../ports/ledger-reader"
import type { McpTrash, TrashedRow, TrashEntry } from "../ports/mcp-trash"
import type { McpWriteCounter } from "../ports/mcp-writes"
import type { ApplySyncBatch } from "./apply-sync-batch"
import type { ReadLedger } from "./read-ledger"

/** Rows an MCP client with `manage` may write for a user in an hour: a cascade counts each row. */
export const MANAGE_ROWS_PER_HOUR = 2000
/** How long an MCP delete can be undone. */
export const TRASH_DAYS = 30
const BATCH = 150

export class ManageError extends Error {
  constructor(
    readonly code: "rate_limited" | "invalid" | "not_found" | "conflict",
    message: string
  ) {
    super(message)
  }
}

type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string; deleted_at: string | null }

interface Event {
  entity: SyncEntity
  row: Row
  operation: "update" | "delete"
}

export interface ChangeSummary {
  created: number
  updated: number
  deleted: number
  /** Events the server didn't apply (a newer version on another device, or a check failed). */
  not_applied: { entity: SyncEntity; id: string; reason: string }[]
  /** `restore_deleted` takes it back within TRASH_DAYS. */
  trash_id?: string
}

export interface ManageRequest {
  /**
   * Makes every row the operation creates get an id derived from it, so a retried call finds its rows
   * already there instead of creating them twice. The create tools pass the client's `id`.
   */
  key: string
  /** Ids the client chose itself (create_transaction's `id`): kept as they are. */
  keepIds?: readonly string[]
  /** For deletes: what is deleted, in the person's words, read from the ledger before the delete. */
  trashLabel?: (store: RecordingStore) => string
}

interface Deps {
  reader: LedgerReader
  ledger: ReadLedger
  writer: ApplySyncBatch
  counter: McpWriteCounter
  trash: McpTrash
  clock?: () => Date
}

const AUDIT = new Set(["created_at", "updated_at", "deleted_at", "source"])
const sameColumns = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((key) => !AUDIT.has(key)))
  return [...keys].every((key) => JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null))
}
const isReference = (key: string) => key === "id" || key.endsWith("_id")

/** Replaces ids by the map, in `id` and every `*_id` column (never in names or notes). */
function remapRow(row: Row, ids: Map<string, string>): Row {
  const copy: Record<string, unknown> = { ...row }
  for (const [key, value] of Object.entries(copy)) {
    if (isReference(key) && typeof value === "string" && ids.has(value)) copy[key] = ids.get(value)
  }
  return copy as Row
}

/**
 * The MCP `manage` tools (ADR 0011): run one of the apps' own domain use cases on the person's
 * ledger, then write exactly the rows it saved or deleted as sync events, so the iPhone and the web
 * see the change as if it had been made in an app. Deletes keep what they took in a trash for
 * TRASH_DAYS, since a sync tombstone is final.
 */
export class ManageLedger {
  constructor(private readonly deps: Deps) {}

  private now() {
    return this.deps.clock?.() ?? new Date()
  }

  private async guard(userId: string, clientId: string) {
    const since = new Date(this.now().getTime() - 3_600_000)
    if ((await this.deps.counter.countSince(userId, clientId, since)) >= MANAGE_ROWS_PER_HOUR) {
      throw new ManageError("rate_limited", `This assistant changed ${MANAGE_ROWS_PER_HOUR} rows in the last hour. Try later or make the change in the app.`)
    }
  }

  /** The ledger as stored (tombstones included) and as the domain sees it. */
  private async load(userId: string) {
    // Records recurring occurrences that came due first, as every read does; the rows are read again
    // only when that wrote something.
    const loaded = await this.deps.ledger.load(userId)
    const rows = loaded.fresh ? loaded.rows : await this.deps.reader.load(userId)
    const store = new RecordingStore(toDomain(rows))
    for (const row of rows.category) if (row.deleted_at !== null) store.deletedCategoryIds.add(row.id)
    // The defaults every app shows even before it stored them.
    await store.fetchCategories()
    store.touched.clear()
    return { rows, store }
  }

  async run<T>(userId: string, clientId: string, request: ManageRequest, operation: (store: RecordingStore, now: Date) => Promise<T>): Promise<{ result: T; changes: ChangeSummary }> {
    await this.guard(userId, clientId)
    const now = this.now()
    const { rows, store } = await this.load(userId)
    const before = {
      categories: [...store.categories] as TransactionCategory[],
      categorizationRules: [...store.categorizationRules],
    }
    let result: T
    let label: string | undefined
    try {
      label = request.trashLabel?.(store)
      result = await operation(store, now)
    } catch (error) {
      if (error instanceof DomainError) throw new ManageError(error.code === "notFound" ? "not_found" : "invalid", error.message)
      throw error
    }
    const at = now.toISOString()
    const { events, created } = this.diff(rows, store, before, at)
    // Rows this call created get ids derived from the request, so a retry finds them instead of
    // creating them again (the domain draws random ids).
    const ids = new Map(created.filter(({ id }) => !request.keepIds?.includes(id)).map(({ entity, id }, index) => [id, uuidV5(`manage|${clientId}|${request.key}|${entity}|${index}`)]))
    const remapped = events.map((event) => ({ ...event, row: remapRow(event.row, ids) }))
    const already = new Map(Object.entries(rows).flatMap(([entity, list]) => (list as Row[]).map((row) => [`${entity}|${row.id}`, row] as const)))
    const pending = remapped.filter((event) => {
      const existing = already.get(`${event.entity}|${event.row.id}`)
      // A retry: the row is already there as this call would write it.
      return !(existing && existing.deleted_at === null && event.operation === "update" && sameColumns(existing, event.row))
    })
    let trashId: string | undefined
    if (label && pending.some((event) => event.operation === "delete")) {
      trashId = uuidV5(`trash|${clientId}|${request.key}|${at}`)
      const trashed: TrashedRow[] = pending.flatMap((event): TrashedRow[] => {
        const old = already.get(`${event.entity}|${event.row.id}`)
        if (event.operation === "delete") return [{ entity: event.entity, before: (old ?? { ...event.row, deleted_at: null }) as Record<string, unknown>, deleted: true }]
        return old ? [{ entity: event.entity, before: old as Record<string, unknown>, deleted: false, afterUpdatedAt: at }] : []
      })
      await this.deps.trash.purge(userId, new Date(now.getTime() - TRASH_DAYS * 86_400_000))
      await this.deps.trash.save(userId, { id: trashId, clientId, label, rows: trashed }, now)
    }
    const changes = await this.write(userId, clientId, pending, already)
    const renamed = JSON.parse([...ids].reduce((text, [from, to]) => text.split(from).join(to), JSON.stringify(result ?? null))) as T
    return { result: renamed, changes: { ...changes, ...(trashId ? { trash_id: trashId } : {}) } }
  }

  /** The rows the operation touched, as upserts or tombstones, children with their parent. */
  private diff(rows: LedgerRows, store: RecordingStore, before: { categories: TransactionCategory[]; categorizationRules: RecordingStore["categorizationRules"] }, at: string) {
    const events: Event[] = []
    const created: { entity: SyncEntity; id: string }[] = []
    const stored = (entity: SyncEntity, id: string) => (rows[entity] as Row[]).find((row) => row.id === id)
    const upsert = (entity: SyncEntity, columns: Record<string, unknown>) => {
      const old = stored(entity, columns.id as string)
      if (old && old.deleted_at !== null) return
      if (old && sameColumns(old, columns)) return
      if (!old) created.push({ entity, id: columns.id as string })
      events.push({ entity, operation: "update", row: { ...columns, created_at: old?.created_at ?? at, updated_at: at, deleted_at: null } as Row })
    }
    const tombstone = (entity: SyncEntity, id: string, fallback?: Record<string, unknown>) => {
      const old = stored(entity, id)
      if (old?.deleted_at) return
      const base = old ?? (fallback ? { ...fallback, created_at: at } : undefined)
      if (!base) return
      events.push({ entity, operation: "delete", row: { ...base, updated_at: at, deleted_at: at } as Row })
    }
    const children = (entity: "loanPayment" | "personalDebtRepayment", parentKey: "loan_id" | "debt_id", parentId: string, now: Record<string, unknown>[]) => {
      const keep = new Set(now.map((row) => row.id as string))
      for (const row of now) upsert(entity, row)
      for (const old of rows[entity] as Row[]) if (old[parentKey] === parentId && old.deleted_at === null && !keep.has(old.id)) tombstone(entity, old.id)
    }
    const touched = (kind: TouchedKind) => [...(store.touched.get(kind) ?? [])]
    const maxSort = (entity: "category" | "categorizationRule") => Math.max(-1, ...(rows[entity] as Row[]).map((row) => Number(row.sort_index ?? -1)))

    for (const id of touched("account")) {
      const account = store.accounts.find((candidate) => candidate.id === id)
      if (account) upsert("account", accountColumns(account))
      else tombstone("account", id)
    }
    for (const id of touched("card")) {
      const card = store.cards.find((candidate) => candidate.id === id)
      if (card) upsert("card", cardColumns(card))
      else tombstone("card", id)
    }
    for (const id of touched("transaction")) {
      const transaction = store.transactions.find((candidate) => candidate.id === id)
      if (transaction) upsert("transaction", transactionColumns(transaction, NO_AUDIT))
      else tombstone("transaction", id)
    }
    for (const id of touched("recurringRule")) {
      const rule = store.recurringRules.find((candidate) => candidate.id === id)
      if (rule) upsert("recurringRule", recurringRuleColumns(rule, NO_AUDIT))
      else tombstone("recurringRule", id)
    }
    for (const id of touched("savingsGoal")) {
      const goal = store.savingsGoals.find((candidate) => candidate.id === id)
      if (goal) upsert("savingsGoal", savingsGoalColumns(goal))
      else tombstone("savingsGoal", id)
    }
    for (const id of touched("loan")) {
      const loan = store.loans.find((candidate) => candidate.id === id)
      if (loan) {
        upsert("loan", loanColumns(loan))
        children("loanPayment", "loan_id", id, loanPaymentColumns(loan))
      } else {
        children("loanPayment", "loan_id", id, [])
        tombstone("loan", id)
      }
    }
    for (const id of touched("personalDebt")) {
      const debt = store.personalDebts.find((candidate) => candidate.id === id)
      if (debt) {
        upsert("personalDebt", personalDebtColumns(debt))
        children("personalDebtRepayment", "debt_id", id, repaymentColumns(debt))
      } else {
        children("personalDebtRepayment", "debt_id", id, [])
        tombstone("personalDebt", id)
      }
    }
    // Order: a reorder touches every one and numbers them by position; a single save keeps its place
    // and a new one goes after the rest.
    const ordered = (entity: "category" | "categorizationRule", list: { id: string }[], all: number, write: (item: never, index: number) => Record<string, unknown>) => {
      let next = maxSort(entity) + 1
      const reordered = (store.touched.get(entity === "category" ? "category" : "categorizationRule")?.size ?? 0) >= all && all > 1
      for (const id of touched(entity === "category" ? "category" : "categorizationRule")) {
        const index = list.findIndex((item) => item.id === id)
        const old = stored(entity, id)
        if (index >= 0) {
          const sort = reordered ? index : old && old.deleted_at === null ? Number(old.sort_index) : next++
          upsert(entity, write(list[index] as never, sort))
        }
      }
    }
    const aliveCategories = store.categories.filter((category) => !store.deletedCategoryIds.has(category.id))
    ordered("category", aliveCategories, aliveCategories.length, (category: TransactionCategory, sort: number) => categoryColumns(category, sort))
    for (const id of touched("category")) {
      if (aliveCategories.some((category) => category.id === id)) continue
      const index = before.categories.findIndex((category) => category.id === id)
      tombstone("category", id, index >= 0 ? categoryColumns(before.categories[index]!, index) : undefined)
    }
    ordered("categorizationRule", store.categorizationRules, store.categorizationRules.length, (rule: RecordingStore["categorizationRules"][number], sort: number) => categorizationRuleColumns(rule, sort))
    for (const id of touched("categorizationRule")) {
      if (store.categorizationRules.some((rule) => rule.id === id)) continue
      tombstone("categorizationRule", id)
    }
    if (store.touched.has("settings") && store.settings) upsert("settings", settingsColumns(store.settings))
    return { events, created }
  }

  private async write(userId: string, clientId: string, events: Event[], already: Map<string, Row>): Promise<Omit<ChangeSummary, "trash_id">> {
    const summary: Omit<ChangeSummary, "trash_id"> = { created: 0, updated: 0, deleted: 0, not_applied: [] }
    for (let start = 0; start < events.length; ) {
      const slice = events.slice(start, start + BATCH)
      const wire = slice.map((event) => {
        const { created_at: _c, updated_at: _u, deleted_at: _d, ...columns } = event.row
        return {
          event_id: uuidV5(`manage-event|${clientId}|${event.entity}|${event.row.id}|${event.operation}|${JSON.stringify(columns)}|${event.row.updated_at}`),
          entity: event.entity,
          entity_id: event.row.id,
          operation: event.operation,
          payload: event.row,
          created_at: event.row.updated_at,
        }
      })
      const outcome = await this.deps.writer.execute({ userId, clientId, platform: "other", createdBy: "mcp", deadline: Date.now() + 20_000, events: wire })
      outcome.results.forEach((result, index) => {
        const event = slice[index]!
        if (result.status === "applied") {
          if (event.operation === "delete") summary.deleted++
          else if (already.has(`${event.entity}|${event.row.id}`)) summary.updated++
          else summary.created++
        } else {
          summary.not_applied.push({ entity: event.entity, id: event.row.id, reason: result.reason ?? result.status })
        }
      })
      // Time ran out mid-batch: send the rest again (each event's answer is recorded, so nothing twice).
      start += Math.max(outcome.results.length, outcome.partial ? 0 : slice.length)
      if (outcome.results.length === 0 && outcome.partial) throw new ManageError("conflict", "The server was too busy to save the change. Try again.")
    }
    return summary
  }

  /** What MCP deletes the person can still undo. */
  async trash(userId: string): Promise<Pick<TrashEntry, "id" | "label" | "createdAt">[]> {
    const since = new Date(this.now().getTime() - TRASH_DAYS * 86_400_000)
    return (await this.deps.trash.list(userId, since)).map(({ id, label, createdAt }) => ({ id, label, createdAt }))
  }

  /**
   * Undoes an MCP delete. Tombstoned rows can't come back (ADR 0005), so they are created again under
   * new ids with their references rewired; rows the delete changed go back to how they were, unless
   * something changed them since.
   */
  async restore(userId: string, clientId: string, trashId: string): Promise<{ label: string; ids: Record<string, string>; changes: ChangeSummary; skipped: number }> {
    await this.guard(userId, clientId)
    const now = this.now()
    const entry = await this.deps.trash.get(userId, trashId)
    if (!entry || entry.createdAt.getTime() < now.getTime() - TRASH_DAYS * 86_400_000) throw new ManageError("not_found", "Nothing to restore with that id (see list_deleted).")
    if (entry.restoredAt) throw new ManageError("conflict", "That delete was already undone.")
    await this.deps.ledger.execute(userId)
    const rows = await this.deps.reader.load(userId)
    const current = new Map(Object.entries(rows).flatMap(([entity, list]) => (list as Row[]).map((row) => [`${entity}|${row.id}`, row] as const)))
    const at = now.toISOString()

    const ids = new Map<string, string>()
    for (const row of entry.rows.filter((candidate) => candidate.deleted)) {
      const id = row.before.id as string
      if (row.entity !== "loanPayment") ids.set(id, uuidV5(`restore|${trashId}|${row.entity}|${id}`))
    }
    for (const row of entry.rows.filter((candidate) => candidate.deleted && candidate.entity === "loanPayment")) {
      const loanId = row.before.loan_id as string
      ids.set(row.before.id as string, loanPaymentId(ids.get(loanId) ?? loanId, Number(row.before.number)))
    }
    const alive = (entity: SyncEntity, id: string) => {
      const row = current.get(`${entity}|${id}`)
      return row !== undefined && row.deleted_at === null
    }
    const restoredAccounts = new Set(entry.rows.filter((row) => row.deleted && row.entity === "account").map((row) => ids.get(row.before.id as string)!))
    const accountExists = (id: unknown) => typeof id !== "string" || restoredAccounts.has(id) || alive("account", id)

    const events: Event[] = []
    let skipped = 0
    for (const trashed of entry.rows) {
      const row = remapRow(trashed.before as Row, ids)
      if (trashed.deleted) {
        // A movement or rule whose account is gone for good can't come back pointing at nothing.
        if ((trashed.entity === "transaction" || trashed.entity === "recurringRule" || trashed.entity === "card") && !(accountExists(row.account_id) && (row.destination_account_id == null || accountExists(row.destination_account_id)))) {
          skipped++
          continue
        }
        events.push({ entity: trashed.entity, operation: "update", row: { ...row, updated_at: at, deleted_at: null } })
      } else {
        const now = current.get(`${trashed.entity}|${row.id}`)
        if (!now || now.deleted_at !== null || now.updated_at !== trashed.afterUpdatedAt) {
          skipped++
          continue
        }
        events.push({ entity: trashed.entity, operation: "update", row: { ...row, created_at: now.created_at, updated_at: at, deleted_at: null } })
      }
    }
    const changes = await this.write(userId, clientId, events, current)
    await this.deps.trash.markRestored(userId, trashId, now)
    return { label: entry.label, ids: Object.fromEntries(ids), changes, skipped }
  }
}
