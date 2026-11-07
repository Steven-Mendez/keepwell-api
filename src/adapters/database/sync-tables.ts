import { bigint, boolean, index, integer, pgTable, primaryKey, text, timestamp, type PgColumnBuilderBase } from "drizzle-orm/pg-core"
import type { z } from "zod"

import { SYNC_WIRE, type SyncEntity } from "../../core/domain/schema"

// The ledger tables are derived from the sync wire schemas (core/domain/schema/sync.ts), the same
// ones that validate every pushed event, so a column and its validation can't drift apart. Each
// table is the wire row plus `user_id`; the primary key is (user_id, id) because ids are chosen by
// clients (category slugs such as "groceries" repeat across users by design).
//
// Storage rules (ADR 0003, ADR 0004): money, rates and instants are `text` exactly as they travel,
// so a row reads back byte for byte; arrays are JSON text; nothing is summed in SQL.

type Column = { kind: "text" | "integer" | "boolean" | "json"; nullable: boolean }

function describe(schema: z.ZodType, nullable = false): Column {
  const def = (schema as unknown as { def: { type: string; innerType?: z.ZodType; in?: z.ZodType } }).def
  switch (def.type) {
    case "nullable":
    case "optional":
    case "default":
      return describe(def.innerType!, true)
    case "pipe":
      return describe(def.in!, nullable)
    case "number":
      return { kind: "integer", nullable }
    case "boolean":
      return { kind: "boolean", nullable }
    case "array":
    case "object":
      return { kind: "json", nullable }
    default:
      return { kind: "text", nullable }
  }
}

/** The columns of an entity's wire row, as Drizzle builders keyed by column name. */
export function wireColumns(wire: z.ZodObject) {
  const columns: Record<string, PgColumnBuilderBase> = {}
  for (const [name, schema] of Object.entries(wire.shape)) {
    const column = describe(schema as z.ZodType)
    const builder = column.kind === "integer" ? integer(name) : column.kind === "boolean" ? boolean(name) : text(name)
    columns[name] = column.nullable ? builder : builder.notNull()
  }
  return columns
}

/** Which wire columns hold JSON text. */
export function jsonColumns(wire: z.ZodObject): string[] {
  return Object.entries(wire.shape)
    .filter(([, schema]) => describe(schema as z.ZodType).kind === "json")
    .map(([name]) => name)
}

function ledgerTable<E extends SyncEntity>(name: string, entity: E, extra: Record<string, PgColumnBuilderBase> = {}) {
  return pgTable(
    name,
    {
      ...wireColumns(SYNC_WIRE[entity]),
      ...extra,
      user_id: text("user_id").notNull(),
      id: text("id").notNull(),
      updated_at: text("updated_at").notNull(),
      deleted_at: text("deleted_at"),
    },
    (table) => [primaryKey({ columns: [table.user_id, table.id] })]
  )
}

/** Set by the server when the row is created and never changed by a client (ADR 0005). */
const source = { source: text("source").notNull().default("app") }

export const ledgerAccounts = ledgerTable("ledger_accounts", "account")
export const cards = ledgerTable("cards", "card")
export const categories = ledgerTable("categories", "category")
export const transactions = ledgerTable("transactions", "transaction", source)
export const recurringRules = ledgerTable("recurring_rules", "recurringRule", source)
export const savingsGoals = ledgerTable("savings_goals", "savingsGoal")
export const loans = ledgerTable("loans", "loan")
export const loanPayments = ledgerTable("loan_payments", "loanPayment")
export const personalDebts = ledgerTable("personal_debts", "personalDebt")
export const personalDebtRepayments = ledgerTable("personal_debt_repayments", "personalDebtRepayment")
export const categorizationRules = ledgerTable("categorization_rules", "categorizationRule")
export const settings = ledgerTable("settings", "settings")

/** The table that stores each sync entity. */
export const LEDGER_TABLES = {
  account: ledgerAccounts,
  card: cards,
  category: categories,
  transaction: transactions,
  recurringRule: recurringRules,
  savingsGoal: savingsGoals,
  loan: loans,
  loanPayment: loanPayments,
  personalDebt: personalDebts,
  personalDebtRepayment: personalDebtRepayments,
  categorizationRule: categorizationRules,
  settings,
} as const satisfies Record<SyncEntity, unknown>

export type LedgerTable = (typeof LEDGER_TABLES)[SyncEntity]

// --- Sync bookkeeping --------------------------------------------------------------------------

/**
 * Every applied (or stale) change, insert-only for the app role. What `pull` serves, what
 * reconciliation replays, and the audit of what each client wrote and when.
 */
export const changeLog = pgTable(
  "change_log",
  {
    user_id: text("user_id").notNull(),
    server_seq: bigint("server_seq", { mode: "number" }).notNull(),
    entity: text("entity").notNull(),
    entity_id: text("entity_id").notNull(),
    operation: text("operation").notNull(),
    /** The row as applied (JSON text). For a `stale` event, the row that was sent and lost. */
    payload: text("payload").notNull(),
    status: text("status").notNull(),
    client_id: text("client_id").notNull(),
    event_id: text("event_id").notNull(),
    applied_at: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.server_seq] })]
)

/**
 * One row per user. Every write bumps `last_seq` in the same transaction, so two writers of the
 * same user conflict here and one retries: a user's writes are serialized and `server_seq` values
 * become visible in order (ADR 0005).
 */
export const syncState = pgTable("sync_state", {
  user_id: text("user_id").primaryKey(),
  last_seq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
})

/** Outbox events already processed and their result, so a resend gets the same answer. */
export const appliedEvents = pgTable(
  "applied_events",
  {
    user_id: text("user_id").notNull(),
    event_id: text("event_id").notNull(),
    result: text("result").notNull(),
    reason: text("reason"),
    server_seq: bigint("server_seq", { mode: "number" }),
    applied_at: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.event_id] })]
)

/** One row per installation that has synced. */
export const clients = pgTable(
  "clients",
  {
    user_id: text("user_id").notNull(),
    client_id: text("client_id").notNull(),
    platform: text("platform").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.client_id] })]
)

/** For routes without a natural key (today only POST /entitlements/app-store). */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    user_id: text("user_id").notNull(),
    key: text("key").notNull(),
    request_hash: text("request_hash").notNull(),
    status_code: integer("status_code"),
    response: text("response"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.key] })]
)

/** Each grant of a plan. The current plan is the highest-ranked one not expired or revoked. */
export const entitlements = pgTable(
  "entitlements",
  {
    id: text("id").primaryKey(),
    /** Null once the account is deleted; the row stays for the accounting period. */
    user_id: text("user_id"),
    plan: text("plan").notNull(),
    source: text("source").notNull(),
    reference: text("reference"),
    granted_at: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("entitlements_user_idx").on(table.user_id)]
)


/**
 * Every App Store purchase verified for an account. One original transaction belongs to one account:
 * a second account presenting the same receipt is refused. Kept without user_id after deletion.
 */
export const appStoreTransactions = pgTable(
  "app_store_transactions",
  {
    original_transaction_id: text("original_transaction_id").primaryKey(),
    user_id: text("user_id"),
    product_id: text("product_id").notNull(),
    environment: text("environment").notNull(),
    purchased_at: timestamp("purchased_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    last_notification_at: timestamp("last_notification_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("app_store_transactions_user_idx").on(table.user_id)]
)

/** Each App Store Server Notification received, so a resent one is applied once. */
export const appStoreNotifications = pgTable("app_store_notifications", {
  notification_uuid: text("notification_uuid").primaryKey(),
  type: text("type").notNull(),
  subtype: text("subtype"),
  original_transaction_id: text("original_transaction_id"),
  received_at: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
})
