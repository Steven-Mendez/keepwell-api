import {
  addMonths,
  balanceOf,
  budgetStatuses,
  dayKey,
  daysInMonth,
  debtDueStatus,
  inSecondCurrency,
  lastMonths,
  monthlySummary,
  netWorth,
  savings,
  trendReport,
  upcoming,
  yearMonth,
  yearMonthContaining,
  zonedDate,
  zonedParts,
  type Ledger,
  type Money,
  type YearMonth,
} from "../domain/domain"
import type { Transaction } from "../domain/schema"

// The MCP read tools as pure functions over the domain's Ledger (ADR 0007 covers the transport).
// Everything is typed JSON: amounts are decimal text rounded to cents with their ISO 4217 code, never prose that
// could read as an instruction, never HTML or Markdown (the MCP Apps views of ADR 0010 are a static
// resource that draws this JSON as text). Cards show their last four digits only.

export interface MoneyJSON {
  amount: string
  currency: string
}

// Amounts come out rounded to cents. Converting between currencies at the settings rate leaves
// long tails (452.2835628530784…) that are noise to a reader; the domain keeps the exact values.
const amountText = (value: Money["amount"]) => value.toDecimalPlaces(2).toString()
const money = (value: Money): MoneyJSON => ({ amount: amountText(value.amount), currency: value.currency })
const monthText = (value: YearMonth) => `${value.year}-${String(value.month).padStart(2, "0")}`
// Days are the person's calendar day in their home zone (`ledger.timeZone`), the same one the
// monthly summary groups by, never the UTC day of `toISOString`.

export function parseMonth(text: string | undefined, now: Date, zone: string): YearMonth {
  if (!text) return yearMonthContaining(now, zone)
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
    balances: balanceOf(account, ledger.transactions, ledger.timeZone).map(money),
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
    const balances = balanceOf(account, ledger.transactions, ledger.timeZone)
    return { account_id: account.id, name: account.name, kind: account.kind, total: money(netWorth(balances, currencies)) }
  })
  const total = netWorth(ledger.accounts.flatMap((account) => balanceOf(account, ledger.transactions, ledger.timeZone)), currencies)
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
  const summary = monthlySummary(month, ledger.transactions, currency, ledger.timeZone)
  return {
    month: monthText(month),
    currency,
    income: amountText(summary.income),
    expense: amountText(summary.expense),
    net: amountText(savings(summary)),
    spending_by_category: summary.categories.map((total) => ({
      category_id: total.categoryId,
      category: categoryName(ledger, total.categoryId),
      amount: amountText(total.amount),
      share: total.share.toDecimalPlaces(4).toString(),
    })),
    income_by_category: summary.incomeCategories.map((total) => ({ category_id: total.categoryId, category: categoryName(ledger, total.categoryId), amount: amountText(total.amount) })),
    budgets: budgetStatuses(summary, ledger.categories).map((status) => ({
      category_id: status.categoryId,
      category: categoryName(ledger, status.categoryId),
      budget: amountText(status.budget),
      spent: amountText(status.spent),
      level: status.level,
    })),
  }
}

export function getTrends(ledger: Ledger, months: number, now: Date) {
  const currency = ledger.settings.currencies.principal
  const report = trendReport(ledger.transactions, currency, lastMonths(months, now, ledger.timeZone), ledger.timeZone, now)
  return {
    currency,
    months: report.months.map((month) => ({
      month: monthText(month.month),
      income: amountText(month.income),
      expense: amountText(month.expense),
      net: amountText(savings(month)),
    })),
  }
}

export function getUpcomingPayments(ledger: Ledger, days: number, now: Date) {
  const zone = ledger.timeZone
  const day = (date: Date) => dayKey(date, zone)
  const recurring = upcoming(ledger.recurringRules, now, days, zone).map((entry) => ({
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
    const due = nextDay(now, terms.dueDay, zone)
    if (due > until) return []
    return [{ type: "card_due" as const, date: day(due), name: account.name, account_id: account.id, cutoff_day: terms.cutoffDay ?? null, due_day: terms.dueDay }]
  })
  return { from: day(now), days, payments: [...recurring, ...cards].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) }
}

function nextDay(now: Date, dayOfMonth: number, zone: string): Date {
  const today = zonedParts(now, zone)
  const startOfToday = zonedDate(zone, today.year, today.month, today.day)
  for (let offset = 0; offset < 2; offset++) {
    const month = addMonths(today, offset)
    const candidate = zonedDate(zone, month.year, month.month, Math.min(dayOfMonth, daysInMonth(month)), 12)
    if (candidate >= startOfToday) return candidate
  }
  return zonedDate(zone, today.year, today.month + 1, dayOfMonth, 12)
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
    const date = dayKey(new Date(transaction.date), ledger.timeZone)
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
  const month = getMonthlySummary(ledger, yearMonthContaining(now, ledger.timeZone))
  return {
    today: dayKey(now, ledger.timeZone),
    /** The home zone "today" and months are read in (settings, else the latest device, else the default). */
    time_zone: ledger.timeZone,
    currencies: worth.rate ?? { principal: worth.currency },
    net_worth: worth.net_worth,
    net_worth_in_second_currency: worth.net_worth_in_second_currency,
    accounts: listAccounts(ledger).map(({ id, name, kind, balances }) => ({ id, name, kind, balances })),
    this_month: { month: month.month, income: month.income, expense: month.expense, net: month.net, top_spending: month.spending_by_category.slice(0, 5), budgets: month.budgets },
    upcoming_14_days: getUpcomingPayments(ledger, 14, now).payments,
    pending_confirmation: ledger.transactions.filter((t) => t.status === "planned").length,
  }
}

// The lists the manage tools take ids from (ADR 0011). Plain fields, never prose.

export function listCategories(ledger: Ledger) {
  return {
    categories: ledger.categories.map((category) => ({
      id: category.id,
      name: category.name,
      kind: category.kind,
      monthly_budget: category.monthlyBudget ? { amount: category.monthlyBudget.amount, currency: category.monthlyBudget.currency } : null,
    })),
  }
}

export function listRecurringRules(ledger: Ledger) {
  return {
    rules: ledger.recurringRules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      kind: rule.kind,
      amount: { amount: rule.amount, currency: rule.currency },
      category_id: rule.categoryId ?? null,
      account_id: rule.accountId,
      card_id: rule.cardId ?? null,
      destination_account_id: rule.destinationAccountId ?? null,
      frequency: rule.frequency,
      interval: rule.interval,
      start_date: rule.startDate,
      next_date: rule.nextDate,
      end_date: rule.endDate ?? null,
      is_subscription: rule.isSubscription,
      auto_confirm: rule.autoConfirm,
      is_paused: rule.isPaused,
      note: rule.note ?? null,
      tags: rule.tags ?? [],
      recorded_by: rule.source === "mcp" ? "mcp" : "app",
    })),
  }
}

export function listSavingsGoals(ledger: Ledger) {
  return {
    goals: ledger.savingsGoals.map((goal) => ({
      id: goal.id,
      name: goal.name,
      target: goal.target,
      saved: goal.saved,
      target_month: goal.targetMonth ?? null,
      icon: goal.icon ?? null,
      color: goal.color ?? null,
    })),
  }
}

export function listLoans(ledger: Ledger) {
  return {
    loans: ledger.loans.map((loan) => ({
      id: loan.id,
      name: loan.name,
      lender: loan.lender ?? null,
      borrowed: loan.borrowed,
      installment_amount: loan.installmentAmount,
      installment_count: loan.installmentCount,
      frequency: loan.frequency,
      first_due_date: loan.firstDueDate,
      paid_installments: loan.payments.map((payment) => ({ number: payment.number, paid_at: payment.paidAt, transaction_id: payment.transactionId ?? null })),
    })),
  }
}

/** Where each debt's due date stands today in the person's zone: `null` without one, or once settled or paid. */
export function listPersonalDebts(ledger: Ledger, now: Date) {
  return {
    debts: ledger.personalDebts.map((debt) => {
      const due = debtDueStatus(debt, now, ledger.timeZone)
      return {
        id: debt.id,
        person: debt.person,
        direction: debt.direction,
        amount: debt.amount,
        date: debt.date,
        note: debt.note ?? null,
        repayments: debt.repayments.map((repayment) => ({ amount: repayment.amount, date: repayment.date })),
        settled_at: debt.settledAt ?? null,
        due_date: debt.dueDate ? dayKey(new Date(debt.dueDate), ledger.timeZone) : null,
        due_status: due?.state ?? null,
        ...(due?.state === "upcoming" ? { days_left: due.daysLeft } : {}),
        ...(due?.state === "overdue" ? { days_late: due.daysLate } : {}),
      }
    }),
  }
}

export function listCategorizationRules(ledger: Ledger) {
  return {
    rules: ledger.categorizationRules.map((rule) => ({ id: rule.id, match: rule.match, kind: rule.kind, category_id: rule.categoryId, category: categoryName(ledger, rule.categoryId), tags: rule.tags ?? [] })),
  }
}
