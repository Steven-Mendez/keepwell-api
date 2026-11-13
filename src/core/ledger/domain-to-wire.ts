import { normalizedTags } from "../domain/domain/tags"
import type {
  Account,
  Card,
  CategorizationRule,
  Loan,
  Merchant,
  PersonalDebt,
  SavingsGoal,
  Settings,
  SyncEntity,
  SyncRow,
  TransactionCategory,
} from "../domain/schema"
import { legacyRepaymentId, loanPaymentId } from "../domain/schema"
import { recurringRuleToWire, transactionToWire } from "./wire-to-domain"

// Domain → wire for every entity, so the server can write what a domain use case changed (the MCP
// manage tools, ADR 0011). The same columns as keepwell-web's `*ToRow` mappers (src/lib/db/mappers.ts);
// the audit columns are the caller's, which knows when a row was created and changed.

export interface Audit {
  created_at: string
  updated_at: string
}

type Columns<E extends SyncEntity> = Omit<SyncRow<E>, "created_at" | "updated_at" | "deleted_at">

const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value)

export function accountColumns(account: Account): Columns<"account"> {
  return {
    id: account.id,
    name: account.name,
    bank: orNull(account.bank),
    kind: account.kind,
    opening_balances: account.openingBalances.map(({ amount, currency }) => ({ amount, currency })),
    opening_date: account.openingDate,
    debt_mode: orNull(account.creditTerms?.debtMode),
    limit_amount: orNull(account.creditTerms?.limit?.amount),
    limit_currency: orNull(account.creditTerms?.limit?.currency),
    cutoff_day: orNull(account.creditTerms?.cutoffDay),
    due_day: orNull(account.creditTerms?.dueDay),
    // Always written, null while open: reopening clears it on every device.
    closed_at: orNull(account.closedAt),
  }
}

export function cardColumns(card: Card): Columns<"card"> {
  const productName = card.productName?.trim()
  return {
    id: card.id,
    account_id: card.accountId,
    kind: card.kind,
    network: orNull(card.network),
    last_four: orNull(card.lastFour),
    color: orNull(card.color),
    product_name: productName ? productName : null,
    expiry_month: orNull(card.expiry?.month),
    expiry_year: orNull(card.expiry?.year),
  }
}

export function categoryColumns(category: TransactionCategory, sortIndex: number): Columns<"category"> {
  return {
    id: category.id,
    name: category.name,
    kind: category.kind,
    icon: orNull(category.icon),
    color: orNull(category.color),
    is_renamed: category.isRenamed,
    sort_index: sortIndex,
    budget_amount: orNull(category.monthlyBudget?.amount),
    budget_currency: orNull(category.monthlyBudget?.currency),
  }
}

export function categorizationRuleColumns(rule: CategorizationRule, sortIndex: number): Columns<"categorizationRule"> {
  return {
    id: rule.id,
    match: rule.match,
    category_id: rule.categoryId,
    kind: rule.kind,
    tags: normalizedTags(rule.tags ?? []),
    sort_index: sortIndex,
    // Always written, null for none, as on a movement.
    merchant_id: orNull(rule.merchantId),
  }
}

export function merchantColumns(merchant: Merchant): Columns<"merchant"> {
  return {
    id: merchant.id,
    name: merchant.name,
    domain: orNull(merchant.domain),
    brand_id: orNull(merchant.brandId),
    default_category_id: orNull(merchant.defaultCategoryId),
    is_platform: merchant.isPlatform,
  }
}

export function savingsGoalColumns(goal: SavingsGoal): Columns<"savingsGoal"> {
  return {
    id: goal.id,
    name: goal.name,
    target_amount: goal.target.amount,
    target_currency: goal.target.currency,
    saved: goal.saved,
    target_month: orNull(goal.targetMonth?.month),
    target_year: orNull(goal.targetMonth?.year),
    icon: orNull(goal.icon),
    color: orNull(goal.color),
  }
}

export function loanColumns(loan: Loan): Columns<"loan"> {
  return {
    id: loan.id,
    name: loan.name,
    lender: orNull(loan.lender),
    borrowed_amount: loan.borrowed.amount,
    borrowed_currency: loan.borrowed.currency,
    installment_amount: loan.installmentAmount,
    installment_count: loan.installmentCount,
    frequency: loan.frequency,
    first_due_date: loan.firstDueDate,
  }
}

/** A loan's paid installments; one without an id gets the installment's own (as on the web). */
export function loanPaymentColumns(loan: Loan): Columns<"loanPayment">[] {
  return loan.payments.map((payment) => ({
    id: payment.id ?? loanPaymentId(loan.id, payment.number),
    loan_id: loan.id,
    number: payment.number,
    paid_at: payment.paidAt,
    transaction_id: orNull(payment.transactionId),
  }))
}

export function personalDebtColumns(debt: PersonalDebt): Columns<"personalDebt"> {
  return {
    id: debt.id,
    person: debt.person,
    direction: debt.direction,
    amount: debt.amount.amount,
    currency: debt.amount.currency,
    date: debt.date,
    note: orNull(debt.note),
    settled_at: orNull(debt.settledAt),
    transaction_id: orNull(debt.transactionId),
    // Always written, null for none: removing the date clears it on every device.
    due_date: orNull(debt.dueDate),
  }
}

export function repaymentColumns(debt: PersonalDebt): Columns<"personalDebtRepayment">[] {
  return debt.repayments.map((repayment, index) => ({
    id: repayment.id ?? legacyRepaymentId(debt.id, index, repayment.date, repayment.amount),
    debt_id: debt.id,
    amount: repayment.amount,
    date: repayment.date,
  }))
}

/** Only what travels: the device-local fields (unlock method, relock delay…) never leave a device. */
export function settingsColumns(settings: Settings): Columns<"settings"> {
  return {
    id: "settings",
    principal: settings.currencies.principal,
    second: orNull(settings.currencies.second),
    rate: settings.currencies.rate,
    payment_reminder_days_before: settings.paymentReminderDaysBefore,
    has_completed_onboarding: settings.hasCompletedOnboarding,
    // Left out while there is none: the stored zone is kept rather than cleared (`decide`).
    ...(settings.timeZone ? { time_zone: settings.timeZone } : {}),
  }
}

/** Transactions and recurring rules already have mappers that add the audit columns themselves. */
export function transactionColumns(...args: Parameters<typeof transactionToWire>): Columns<"transaction"> {
  const { created_at: _c, updated_at: _u, deleted_at: _d, ...columns } = transactionToWire(...args)
  return columns
}

export function recurringRuleColumns(...args: Parameters<typeof recurringRuleToWire>): Columns<"recurringRule"> {
  const { created_at: _c, updated_at: _u, deleted_at: _d, ...columns } = recurringRuleToWire(...args)
  return columns
}

export const NO_AUDIT: Audit = { created_at: "", updated_at: "" }
