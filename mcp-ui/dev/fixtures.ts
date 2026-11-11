import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

/** Sample results in the shapes keepwell-api/src/core/mcp/read-tools.ts returns, for the dev host only. */
type Fixture = { input?: Record<string, unknown>; result: (args: Record<string, unknown>) => CallToolResult }

const ok = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data })

const categories = [
  { category_id: "housing", category: "Housing", amount: "450.00", share: "0.3814" },
  { category_id: "groceries", category: "Groceries", amount: "312.40", share: "0.2647" },
  { category_id: "restaurants", category: "Restaurants", amount: "168.75", share: "0.1430" },
  { category_id: "transport", category: "Transport", amount: "121.00", share: "0.1025" },
  { category_id: "subscriptions", category: "Subscriptions", amount: "64.97", share: "0.0551" },
  { category_id: "health", category: "Health", amount: "62.90", share: "0.0533" },
]
const budgets = [
  { category_id: "groceries", category: "Groceries", budget: "400", spent: "312.40", level: "nearLimit" },
  { category_id: "restaurants", category: "Restaurants", budget: "150", spent: "168.75", level: "exceeded" },
  { category_id: "transport", category: "Transport", budget: "200", spent: "121.00", level: "onTrack" },
]

function summary(month = "2026-11") {
  return ok({ month, currency: "USD", income: "2450.00", expense: "1180.02", net: "1269.98", spending_by_category: categories, income_by_category: [], budgets })
}

function trends(months: number) {
  const list = Array.from({ length: months }, (_, i) => {
    const date = new Date(2026, 10 - (months - 1 - i), 15)
    const income = 2300 + ((i * 137) % 400)
    const expense = 1100 + ((i * 211) % 600)
    return { month: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`, income: income.toFixed(2), expense: expense.toFixed(2), net: (income - expense).toFixed(2) }
  })
  return ok({ currency: "USD", months: list })
}

function upcoming(days: number) {
  const all = [
    { type: "recurring", date: "2026-11-12", name: "Netflix", kind: "expense", amount: { amount: "15.49", currency: "USD" }, is_subscription: true, rule_id: "r1" },
    { type: "card_due", date: "2026-11-14", name: "BAC Visa", account_id: "a2", cutoff_day: 28, due_day: 14 },
    { type: "recurring", date: "2026-11-15", name: "Salario", kind: "income", amount: { amount: "2000", currency: "USD" }, is_subscription: false, rule_id: "r2" },
    { type: "recurring", date: "2026-11-15", name: "Internet Claro", kind: "expense", amount: { amount: "1200", currency: "NIO" }, is_subscription: false, rule_id: "r3" },
    { type: "recurring", date: "2026-12-01", name: "Alquiler", kind: "expense", amount: { amount: "450", currency: "USD" }, is_subscription: false, rule_id: "r4" },
    { type: "recurring", date: "2026-12-03", name: "Spotify", kind: "expense", amount: { amount: "5.99", currency: "USD" }, is_subscription: true, rule_id: "r5" },
    { type: "recurring", date: "2026-12-05", name: "Gimnasio", kind: "expense", amount: { amount: "35", currency: "USD" }, is_subscription: true, rule_id: "r6" },
  ]
  const until = new Date(2026, 10, 10 + days).toISOString().slice(0, 10)
  return ok({ from: "2026-11-10", days, payments: all.filter((p) => p.date <= until) })
}

const lunch = { id: "4b0f…", kind: "expense", amount: "18.50", currency: "USD", account_id: "a1", category_id: "restaurants", description: "Almuerzo con el equipo", date: "2026-11-10T18:00:00.000Z" }

export const FIXTURES: Record<string, Fixture> = {
  get_monthly_summary: { result: (args) => summary(typeof args.month === "string" ? args.month : undefined) },
  get_financial_context: {
    result: () =>
      ok({
        today: "2026-11-10",
        currencies: { principal: "USD", second: "NIO", rate: "36.6243" },
        net_worth: { amount: "8420.55", currency: "USD" },
        net_worth_in_second_currency: { amount: "308396.40", currency: "NIO" },
        accounts: [
          { id: "a1", name: "Ahorro BAC", kind: "deposit", balances: [{ amount: "6120.55", currency: "USD" }] },
          { id: "a2", name: "BAC Visa", kind: "credit", balances: [{ amount: "-312.00", currency: "USD" }, { amount: "-850", currency: "NIO" }] },
          { id: "a3", name: "Efectivo", kind: "cash", balances: [{ amount: "2612.00", currency: "USD" }] },
        ],
        this_month: { month: "2026-11", income: "2450.00", expense: "1180.02", net: "1269.98", top_spending: categories.slice(0, 5), budgets },
        upcoming_14_days: [],
        pending_confirmation: 0,
      }),
  },
  get_trends: { result: (args) => trends(typeof args.months === "number" ? args.months : 6) },
  get_upcoming_payments: { result: (args) => upcoming(typeof args.days === "number" ? args.days : 30) },
  create_transaction: {
    input: lunch,
    result: () => ok({ id: lunch.id, status: "pending_confirmation", amount: { amount: "18.50", currency: "USD" }, date: lunch.date, description: lunch.description }),
  },
  create_recurring_rule: {
    input: { ...lunch, name: "Gimnasio", frequency: "monthly", interval: 1, start_date: "2026-12-05T12:00:00.000Z", is_subscription: true, amount: "35" },
    result: () => ok({ id: "rule", status: "pending_confirmation", next_date: "2026-12-05" }),
  },
  apply_changes: {
    input: { lang: "es", changes: [] },
    result: () =>
      ok({
        ok: true,
        results: [
          { tool: "create_account", account_id: "a9", name: "Efectivo" },
          ...[["Súper", "150"], ["Gasolina", "40"], ["Farmacia", "12.50"], ["Almuerzo", "8"], ["Uber", "6.20"], ["Netflix", "15.49"], ["Gimnasio", "35"], ["Café", "3.50"], ["Libros", "22"]].map(([description, amount]) => ({ tool: "create_transaction", id: description, status: "saved", description, amount: { amount, currency: "USD" } })),
        ],
        changes: { created: 10, updated: 0, deleted: 0, not_applied: [] },
      }),
  },
  list_accounts: { result: () => ok({ accounts: [{ id: "a1", name: "Ahorro BAC" }, { id: "a2", name: "BAC Visa" }] }) },
}
