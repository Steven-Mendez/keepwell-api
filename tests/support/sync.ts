import { randomUUID } from "node:crypto"

import { sql } from "drizzle-orm"

import type { Database } from "../../src/adapters/database/client"
import type { testAuthApp } from "./auth"

type Http = ReturnType<typeof testAuthApp>["app"]

export const LEDGER_AND_SYNC_TABLES = [
  "sessions", "accounts", "users", "audit_log", "entitlements", "clients", "applied_events", "change_log", "sync_state",
  "ledger_accounts", "cards", "categories", "transactions", "recurring_rules", "savings_goals", "loans", "loan_payments",
  "personal_debts", "personal_debt_repayments", "categorization_rules", "settings",
]

export async function wipe(admin: Database) {
  for (const table of LEDGER_AND_SYNC_TABLES) await admin.execute(sql.raw(`delete from ${table}`))
}

export function categoryRow(id: string, name: string, at: string, deleted = false) {
  return { id, name, kind: "expense", icon: null, color: null, is_renamed: false, sort_index: 0, budget_amount: null, budget_currency: null, created_at: at, updated_at: at, deleted_at: deleted ? at : null }
}

export function transactionRow(id: string, at: string, extra: Record<string, unknown> = {}) {
  return {
    id, date: at, status: "confirmed", description: "Supermercado", kind: "expense", category_id: "groceries", amount: "12.50", currency: "USD",
    account_id: "11111111-1111-4111-8111-111111111111", card_id: null, destination_account_id: null, actual_debited_principal: null,
    rate_principal: "USD", rate_second: "NIO", rate: "36.6243", is_shared: false, note: null, recurring_id: null, tags: [],
    created_at: at, updated_at: at, deleted_at: null, ...extra,
  }
}

export function event(entity: string, row: { id: string; deleted_at: string | null } & Record<string, unknown>, operation?: string) {
  return { event_id: randomUUID(), entity, entity_id: row.id, operation: operation ?? (row.deleted_at ? "delete" : "update"), payload: row, created_at: new Date().toISOString() }
}

/** One installation talking to the API as the apps do. */
export function syncClient(http: Http, cookie: string, clientId = randomUUID()) {
  const headers = { cookie, "content-type": "application/json", origin: "http://localhost:3000" }
  return {
    clientId,
    async push(events: unknown[]) {
      const res = await http.request("/sync/push", { method: "POST", headers, body: JSON.stringify({ client_id: clientId, platform: "web", events }) })
      return { status: res.status, body: (await res.json()) as { results: { event_id: string; status: string; reason?: string; server_seq?: number; updated_at?: string; current?: Record<string, unknown> }[]; partial: boolean } }
    },
    async pull(cursor: number, limit = 500) {
      const res = await http.request(`/sync/pull?client_id=${clientId}&cursor=${cursor}&limit=${limit}`, { headers })
      return { status: res.status, body: (await res.json()) as { changes: { server_seq: number; entity: string; entity_id: string; operation: string; row: Record<string, unknown> }[]; next_cursor: number; has_more: boolean } }
    },
    async snapshot(entity: string, after = "", limit = 500) {
      const res = await http.request(`/sync/snapshot?entity=${entity}&after=${encodeURIComponent(after)}&limit=${limit}`, { headers })
      return { status: res.status, body: (await res.json()) as { rows: Record<string, unknown>[]; server_seq: number; next_after: string | null } }
    },
  }
}
