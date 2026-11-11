import {
  balanceOf,
  budgetStatuses,
  inSecondCurrency,
  lastMonths,
  monthlySummary,
  netWorth,
  savings,
  trendReport,
  upcoming,
  yearMonth,
  yearMonthContaining,
  type Ledger,
  type Money,
  type YearMonth,
} from "../domain/domain"
import type { Transaction } from "../domain/schema"

// The MCP read tools as pure functions over the domain's Ledger (ADR 0007 covers the transport).
// Everything is typed JSON: amounts are exact decimal text with their ISO 4217 code, never prose that
// could read as an instruction, never HTML or Markdown (the MCP Apps views of ADR 0010 are a static
// resource that draws this JSON as text). Cards show their last four digits only.

export interface MoneyJSON {
  amount: string
  currency: string
}

const money = (value: Money): MoneyJSON => ({ amount: value.amount.toString(), currency: value.currency })
const monthText = (value: YearMonth) => `${value.year}-${String(value.month).padStart(2, "0")}`
const day = (date: Date) => date.toISOString().slice(0, 10)

export function parseMonth(text: string | undefined, now: Date): YearMonth {
  if (!text) return yearMonthContaining(now)
  const match = /^(\d{4})-(\d{2})$/.exec(text)
  const parsed = match ? yearMonth(Number(match[1]), Number(match[2])) : undefined
  if (!parsed) throw new Error("month must be YYYY-MM")
  return parsed
}

function categoryName(ledger: Ledger, id: string) {
  return ledger.categories.find((category) => category.id === id)?.name ?? id
}

export function listAccounts(ledger: Ledger) {
  return ledger.accounts.map((account) => ({
    id: account.id,
    name: account.name,
    bank: account.bank ?? null,
    kind: account.kind,
    balances: balanceOf(account, ledger.transactions).map(money),
    credit: account.creditTerms
      ? { limit: account.creditTerms.limit ?? null, cutoff_day: account.creditTerms.cutoffDay ?? null, due_day: account.creditTerms.dueDay ?? null }
      : null,
    cards: ledger.cards
      .filter((card) => card.accountId === account.id && card.kind !== "transfer")
      .map((card) => ({ id: card.id, kind: card.kind, network: card.network ?? null, last_four: card.lastFour ?? null })),
  }))
}

export function getNetWorth(ledger: Ledger) {
  const currencies = ledger.settings.currencies
  const perAccount = ledger.accounts.map((account) => {
    const balances = balanceOf(account, ledger.transactions)
    return { account_id: account.id, name: account.name, kind: account.kind, total: money(netWorth(balances, currencies)) }
  })
  const total = netWorth(ledger.accounts.flatMap((account) => balanceOf(account, ledger.transactions)), currencies)
  const second = inSecondCurrency(total, currencies)
  return {
    currency: currencies.principal,
    net_worth: money(total),
    net_worth_in_second_currency: second ? money(second) : null,
    rate: currencies.second ? { principal: currencies.principal, second: currencies.second, rate: currencies.rate } : null,
    by_account: perAccount,
  }
}

export function getMonthlySummary(ledger: Ledger, month: YearMonth) {
  const currency = ledger.settings.currencies.principal
  const summary = monthlySummary(month, ledger.transactions, currency)
  return {
    month: monthText(month),
    currency,
    income: summary.income.toString(),
    expense: summary.expense.toString(),
    net: savings(summary).toString(),
    spending_by_category: summary.categories.map((total) => ({
      category_id: total.categoryId,
      category: categoryName(ledger, total.categoryId),
      amount: total.amount.toString(),
      share: total.share.toDecimalPlaces(4).toString(),
    })),
    income_by_category: summary.incomeCategories.map((total) => ({ category_id: total.categoryId, category: categoryName(ledger, total.categoryId), amount: total.amount.toString() })),
    budgets: budgetStatuses(summary, ledger.categories).map((status) => ({
      category_id: status.categoryId,
      category: categoryName(ledger, status.categoryId),
      budget: status.budget.toString(),
      spent: status.spent.toString(),
      level: status.level,
    })),
  }
}

export function getTrends(ledger: Ledger, months: number, now: Date) {
  const currency = ledger.settings.currencies.principal
  const report = trendReport(ledger.transactions, currency, lastMonths(months, now), now)
  return {
    currency,
    months: report.months.map((month) => ({
      month: monthText(month.month),
      income: month.income.toString(),
      expense: month.expense.toString(),
      net: savings(month).toString(),
    })),
  }
}

export function getUpcomingPayments(ledger: Ledger, days: number, now: Date) {
  const recurring = upcoming(ledger.recurringRules, now, days).map((entry) => ({
    type: "recurring" as const,
    date: day(entry.date),
    name: entry.rule.name,
    kind: entry.rule.kind,
    amount: { amount: entry.rule.amount, currency: entry.rule.currency },
    is_subscription: entry.rule.isSubscription,
    rule_id: entry.rule.id,
  }))
  const until = new Date(now.getTime() + days * 86_400_000)
  const cards = ledger.accounts.flatMap((account) => {
    const terms = account.creditTerms
    if (!terms?.dueDay) return []
    const due = nextDay(now, terms.dueDay)
    if (due > until) return []
    return [{ type: "card_due" as const, date: day(due), name: account.name, account_id: account.id, cutoff_day: terms.cutoffDay ?? null, due_day: terms.dueDay }]
  })
  return { from: day(now), days, payments: [...recurring, ...cards].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) }
}

function nextDay(now: Date, dayOfMonth: number): Date {
  for (let offset = 0; offset < 2; offset++) {
    const year = now.getFullYear()
    const month = now.getMonth() + offset
    const last = new Date(year, month + 1, 0).getDate()
    const candidate = new Date(year, month, Math.min(dayOfMonth, last), 12)
    if (candidate >= new Date(now.getFullYear(), now.getMonth(), now.getDate())) return candidate
  }
  return new Date(now.getFullYear(), now.getMonth() + 1, dayOfMonth, 12)
}

export interface TransactionSearch {
  from?: string
  to?: string
  account_id?: string
  category_id?: string
  kind?: "expense" | "income" | "transfer"
  currency?: string
  text?: string
  status?: "confirmed" | "planned"
  limit: number
  cursor?: number
}

export function searchTransactions(ledger: Ledger, query: TransactionSearch) {
  const text = query.text?.toLocaleLowerCase()
  const matches = ledger.transactions.filter((transaction: Transaction) => {
    const date = transaction.date.slice(0, 10)
    if (query.from && date < query.from) return false
    if (query.to && date > query.to) return false
    if (query.account_id && transaction.accountId !== query.account_id && transaction.destinationAccountId !== query.account_id) return false
    if (query.category_id && transaction.categoryId !== query.category_id) return false
    if (query.kind && transaction.kind !== query.kind) return false
    if (query.currency && transaction.currency !== query.currency.toUpperCase()) return false
    if (query.status && transaction.status !== query.status) return false
    if (text && !`${transaction.description} ${transaction.note ?? ""} ${(transaction.tags ?? []).join(" ")}`.toLocaleLowerCase().includes(text)) return false
    return true
  })
  const start = query.cursor ?? 0
  const page = matches.slice(start, start + query.limit)
  return {
    total_matches: matches.length,
    next_cursor: start + page.length < matches.length ? start + page.length : null,
    transactions: page.map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      status: transaction.status,
      kind: transaction.kind,
      description: transaction.description,
      note: transaction.note ?? null,
      amount: { amount: transaction.amount, currency: transaction.currency },
      category_id: transaction.categoryId ?? null,
      category: transaction.categoryId ? categoryName(ledger, transaction.categoryId) : null,
      account_id: transaction.accountId,
      destination_account_id: transaction.destinationAccountId ?? null,
      tags: transaction.tags ?? [],
      recorded_by: transaction.source === "mcp" ? "mcp" : "app",
    })),
  }
}

/** One call instead of five: what a model needs to start a conversation about money. */
export function getFinancialContext(ledger: Ledger, now: Date) {
  const worth = getNetWorth(ledger)
  const month = getMonthlySummary(ledger, yearMonthContaining(now))
  return {
    today: day(now),
    currencies: worth.rate ?? { principal: worth.currency },
    net_worth: worth.net_worth,
    net_worth_in_second_currency: worth.net_worth_in_second_currency,
    accounts: listAccounts(ledger).map(({ id, name, kind, balances }) => ({ id, name, kind, balances })),
    this_month: { month: month.month, income: month.income, expense: month.expense, net: month.net, top_spending: month.spending_by_category.slice(0, 5), budgets: month.budgets },
    upcoming_14_days: getUpcomingPayments(ledger, 14, now).payments,
    pending_confirmation: ledger.transactions.filter((t) => t.status === "planned").length,
  }
}
