import { loanPaymentId, newID } from "../schema/id"
import {
  MAX_DEBT_NAME_LENGTH,
  MAX_LOAN_INSTALLMENTS,
  MAX_LOAN_NAME_LENGTH,
  OTHER_INCOME_ID,
  type DebtDirection,
  type DebtRepayment,
  type Loan,
  type LoanFrequency,
  type LoanPayment,
  type PersonalDebt,
  type TransactionCategory,
} from "../schema"

import { dayKey, startOfDay, type TimeZone } from "./calendar"
import { Decimal, ZERO, dec, decimalText } from "./decimal"
import { DomainError } from "./errors"
import type { Money } from "./money"
import { saveTransaction, type PaymentSource } from "./movements"
import { occurrence } from "./recurring"
import type { LedgerStore } from "./store"

// Port of iOS Debts.swift and DebtRules.swift (loans, their schedule, personal debts, totals and
// bill splitting) and the Debts feature use cases.

// MARK: Loans

export interface LoanInstallment {
  number: number
  dueDate: Date
  /** Absent while unpaid. */
  payment?: LoanPayment
}

export interface LoanProgress {
  loan: Loan
  installments: LoanInstallment[]
  /** Unpaid installments times the installment amount. */
  remaining: Decimal
  /** Every installment together, interest included. */
  totalToPay: Decimal
  /** The lowest unpaid installment; absent once paid off. */
  next?: LoanInstallment
  /** The next installment's day is before today. */
  isNextOverdue: boolean
  isPaidOff: boolean
  /** Paid installments over all of them, for the bar. */
  fraction: number
}

/** Always counted from the first due date, so the 31st stays the 31st in months that have one. */
export function loanDueDate(
  loan: Pick<Loan, "firstDueDate" | "frequency">,
  number: number,
  zone: TimeZone
): Date {
  return occurrence(
    { startDate: loan.firstDueDate, frequency: loan.frequency, interval: 1 },
    number - 1,
    zone
  )
}

/** The lowest installment not paid yet. */
export function loanNextNumber(loan: Loan): number | undefined {
  const paid = new Set(loan.payments.map((payment) => payment.number))
  for (let number = 1; number <= loan.installmentCount; number++)
    if (!paid.has(number)) return number
  return undefined
}

export function loanProgress(loan: Loan, today: Date, zone: TimeZone): LoanProgress {
  const paid = new Map(
    loan.payments.map((payment) => [payment.number, payment])
  )
  const installments = Array.from(
    { length: Math.max(loan.installmentCount, 1) },
    (_, index): LoanInstallment => {
      const payment = paid.get(index + 1)
      return {
        number: index + 1,
        dueDate: loanDueDate(loan, index + 1, zone),
        ...(payment ? { payment } : {}),
      }
    }
  )
  const unpaid = Math.max(loan.installmentCount - loan.payments.length, 0)
  const installment = dec(loan.installmentAmount)
  const next = installments.find((row) => !row.payment)
  return {
    loan,
    installments,
    remaining: installment.times(unpaid),
    totalToPay: installment.times(loan.installmentCount),
    ...(next ? { next } : {}),
    isNextOverdue: next ? startOfDay(next.dueDate, zone) < startOfDay(today, zone) : false,
    isPaidOff: next === undefined,
    fraction:
      loan.installmentCount > 0
        ? Math.min(loan.payments.length / loan.installmentCount, 1)
        : 0,
  }
}

/** Then by name, and by id so the order never flickers between equal names. */
function byName(
  aName: string,
  aId: string,
  bName: string,
  bId: string
): number {
  return (
    aName.localeCompare(bName, undefined, { sensitivity: "base" }) ||
    (aId < bId ? -1 : aId > bId ? 1 : 0)
  )
}

/** Open loans first, the soonest next installment first; paid-off ones last. */
export function orderedLoans(
  loans: readonly Loan[],
  today: Date,
  zone: TimeZone
): LoanProgress[] {
  return loans
    .map((loan) => loanProgress(loan, today, zone))
    .sort((a, b) => {
      if (
        a.next &&
        b.next &&
        a.next.dueDate.getTime() !== b.next.dueDate.getTime()
      ) {
        return a.next.dueDate.getTime() - b.next.dueDate.getTime()
      }
      if (a.next && !b.next) return -1
      if (!a.next && b.next) return 1
      return byName(a.loan.name, a.loan.id, b.loan.name, b.loan.id)
    })
}

/** "Motorbike · 3/12": the movement's description, the same on both apps. */
export function installmentDescription(loan: Loan, number: number): string {
  return `${loan.name} · ${number}/${loan.installmentCount}`
}

// MARK: Personal debts

export function debtRepaid(debt: PersonalDebt): Decimal {
  return debt.repayments.reduce(
    (sum, repayment) => sum.plus(repayment.amount),
    ZERO
  )
}

/** What is still owed, never below zero. */
export function debtRemaining(debt: PersonalDebt): Decimal {
  return Decimal.max(dec(debt.amount.amount).minus(debtRepaid(debt)), ZERO)
}

export const isSettled = (debt: PersonalDebt) => debt.settledAt !== undefined

/** Where an open debt with a due date stands on a day. */
export type DebtDue =
  | { state: "upcoming"; daysLeft: number }
  | { state: "today" }
  | { state: "overdue"; daysLate: number }

const DAY_MS = 86_400_000

/** Calendar days from `from` to `to` in `zone`, negative when `to` is earlier. */
function daysFrom(from: Date, to: Date, zone: TimeZone): number {
  return Math.round(
    (startOfDay(to, zone).getTime() - startOfDay(from, zone).getTime()) / DAY_MS
  )
}

/**
 * How far the due date is from `today`, by calendar days in `zone`. `undefined` for a debt without
 * a due date, settled, or with nothing left to pay: none of those is due anymore.
 */
export function debtDueStatus(
  debt: PersonalDebt,
  today: Date,
  zone: TimeZone
): DebtDue | undefined {
  if (debt.dueDate === undefined || isSettled(debt)) return undefined
  if (debtRemaining(debt).isZero()) return undefined
  const days = daysFrom(today, new Date(debt.dueDate), zone)
  if (days > 0) return { state: "upcoming", daysLeft: days }
  if (days === 0) return { state: "today" }
  return { state: "overdue", daysLate: -days }
}

/**
 * Open debts with a due date first, the soonest first (so overdue ones lead); then open debts
 * without one, newest first; settled ones last, also newest first.
 */
export function orderedPersonalDebts(
  debts: readonly PersonalDebt[]
): PersonalDebt[] {
  const group = (debt: PersonalDebt) =>
    isSettled(debt) ? 2 : debt.dueDate === undefined ? 1 : 0
  return [...debts].sort((a, b) => {
    if (group(a) !== group(b)) return group(a) - group(b)
    if (group(a) === 0) {
      const byDue =
        new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime()
      if (byDue !== 0) return byDue
    }
    const byDate = new Date(b.date).getTime() - new Date(a.date).getTime()
    return byDate || byName(a.person, a.id, b.person, b.id)
  })
}

// MARK: Totals

export interface DebtTotals {
  /** Open loans and open debts the person owes, one amount per currency, by code. */
  youOwe: Money[]
  /** Open debts people owe the person, one amount per currency, by code. */
  owedToYou: Money[]
}

export function debtTotals(
  loans: readonly Loan[],
  debts: readonly PersonalDebt[]
): DebtTotals {
  const owe = new Map<string, Decimal>()
  const owed = new Map<string, Decimal>()
  const add = (
    totals: Map<string, Decimal>,
    currency: string,
    amount: Decimal
  ) => totals.set(currency, (totals.get(currency) ?? ZERO).plus(amount))
  for (const loan of loans) {
    const unpaid = loan.installmentCount - loan.payments.length
    if (unpaid > 0)
      add(
        owe,
        loan.borrowed.currency,
        dec(loan.installmentAmount).times(unpaid)
      )
  }
  for (const debt of debts) {
    const remaining = debtRemaining(debt)
    if (isSettled(debt) || remaining.isZero()) continue
    add(debt.direction === "iOwe" ? owe : owed, debt.amount.currency, remaining)
  }
  const lines = (totals: Map<string, Decimal>): Money[] =>
    [...totals]
      .filter(([, amount]) => amount.gt(0))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, amount]) => ({ amount, currency }))
  return { youOwe: lines(owe), owedToYou: lines(owed) }
}

// MARK: Splitting a bill

/** Each share when `total` is split equally between the person and `people` others, rounded down to the cent. */
export function equalShare(total: Decimal, people: number): Decimal {
  if (people <= 0 || total.lte(0)) return ZERO
  return total.div(people + 1).toDecimalPlaces(2, Decimal.ROUND_DOWN)
}

/** Every share positive and all of them together no more than the bill. */
export function checkSplit(shares: readonly Decimal[], total: Decimal): void {
  const sum = shares.reduce((acc, share) => acc.plus(share), ZERO)
  if (
    shares.length === 0 ||
    shares.some((share) => share.lte(0)) ||
    sum.gt(total)
  )
    throw DomainError.invalidAmount()
}

// MARK: Use cases

function cleaned(text: string, limit: number): string {
  return [...text.trim()].slice(0, limit).join("").trim()
}

function positive(text: string): Decimal {
  let amount: Decimal
  try {
    amount = dec(text)
  } catch {
    throw DomainError.invalidAmount()
  }
  if (!amount.isFinite() || amount.lte(0)) throw DomainError.invalidAmount()
  return amount
}

async function checkNewCurrency(
  store: LedgerStore,
  currency: string
): Promise<void> {
  const settings = await store.loadSettings()
  const allowed = [settings?.currencies.principal, settings?.currencies.second]
  if (!allowed.includes(currency)) throw DomainError.invalidCurrency(currency)
}

export interface LoanDraft {
  /** `undefined` for a new loan. */
  id?: string
  name: string
  lender: string
  /** Exact decimal text, > 0. */
  borrowedAmount: string
  /** Ignored when editing: a loan keeps the currency it was saved in. */
  currency: string
  installmentAmount: string
  installmentCount: number
  frequency: LoanFrequency
  firstDueDate: Date
}

async function existingLoan(store: LedgerStore, id: string): Promise<Loan> {
  const loan = (await store.fetchLoans()).find(
    (candidate) => candidate.id === id
  )
  if (!loan) throw DomainError.notFound(id)
  return loan
}

/** Creates or edits a loan; an edit keeps its currency and paid installments, which the count can't drop below. */
export async function saveLoan(
  store: LedgerStore,
  draft: LoanDraft
): Promise<Loan> {
  const name = cleaned(draft.name, MAX_LOAN_NAME_LENGTH)
  if (name === "") throw DomainError.missingName()
  const lender = cleaned(draft.lender, MAX_LOAN_NAME_LENGTH)
  const borrowed = positive(draft.borrowedAmount)
  const installment = positive(draft.installmentAmount)
  const current =
    draft.id === undefined ? undefined : await existingLoan(store, draft.id)
  if (!current) await checkNewCurrency(store, draft.currency)
  const payments = current?.payments ?? []
  const highestPaid = Math.max(0, ...payments.map((payment) => payment.number))
  const count = draft.installmentCount
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_LOAN_INSTALLMENTS ||
    count < highestPaid
  ) {
    throw DomainError.invalidAmount()
  }
  const loan: Loan = {
    id: current?.id ?? newID(),
    name,
    ...(lender === "" ? {} : { lender }),
    borrowed: {
      amount: decimalText(borrowed),
      currency: current?.borrowed.currency ?? draft.currency,
    },
    installmentAmount: decimalText(installment),
    installmentCount: count,
    frequency: draft.frequency,
    firstDueDate: draft.firstDueDate.toISOString(),
    payments,
  }
  await store.saveLoan(loan)
  return loan
}

export interface InstallmentPayment {
  loanId: string
  source: PaymentSource
  categoryId: string
  date: Date
}

/**
 * "Pay installment": records the installment as a confirmed expense through the same use case as a
 * typed movement and marks it paid, in one atomic write: a failure records neither, so an
 * installment is never paid without its expense.
 */
export async function payLoanInstallment(
  store: LedgerStore,
  payment: InstallmentPayment
): Promise<Loan> {
  return store.atomically(async () => {
    const loan = await existingLoan(store, payment.loanId)
    const number = loanNextNumber(loan)
    if (number === undefined) throw DomainError.invalidAmount()
    const saved = await saveTransaction(store, {
      id: newID(),
      kind: "expense",
      amount: dec(loan.installmentAmount),
      currency: loan.borrowed.currency,
      categoryId: payment.categoryId,
      source: payment.source,
      description: installmentDescription(loan, number),
      date: payment.date,
      note: "",
      isDraft: false,
    })
    const paid: Loan = {
      ...loan,
      payments: [
        ...loan.payments,
        {
          id: loanPaymentId(loan.id, number),
          number,
          paidAt: payment.date.toISOString(),
          transactionId: saved.transaction.id,
        },
      ].sort((a, b) => a.number - b.number),
    }
    await store.saveLoan(paid)
    return paid
  })
}

/** iOS `Loan.unpaying(number:)`: the installment back to due, and the payment it had. Throws when it isn't paid. */
export function loanUnpaying(
  loan: Loan,
  number: number
): { loan: Loan; payment: LoanPayment } {
  const payment = loan.payments.find((candidate) => candidate.number === number)
  if (!payment) throw DomainError.invalidAmount()
  return {
    loan: {
      ...loan,
      payments: loan.payments.filter((candidate) => candidate.number !== number),
    },
    payment,
  }
}

/**
 * "Mark unpaid": the installment back to due and the expense that paid it deleted, in one atomic
 * write, so paying it again doesn't count the installment twice. A movement already deleted leaves
 * only the loan to save.
 */
export async function unpayLoanInstallment(
  store: LedgerStore,
  loanId: string,
  number: number
): Promise<Loan> {
  return store.atomically(async () => {
    const { loan, payment } = loanUnpaying(await existingLoan(store, loanId), number)
    const movementId = payment.transactionId
    if (
      movementId !== undefined &&
      (await store.fetchTransactions()).some((transaction) => transaction.id === movementId)
    ) {
      await store.deleteTransaction(movementId)
    }
    await store.saveLoan(loan)
    return loan
  })
}

export async function deleteLoan(
  store: LedgerStore,
  id: string
): Promise<void> {
  await store.deleteLoan(id)
}

export interface PersonalDebtDraft {
  id?: string
  person: string
  direction: DebtDirection
  amount: string
  /** Ignored when editing. */
  currency: string
  date: Date
  note: string
  /**
   * When it should be paid back, saved as the start of that day. `undefined` saves it without one,
   * also when editing: that is how a due date is removed.
   */
  dueDate?: Date | undefined
}

async function existingDebt(
  store: LedgerStore,
  id: string
): Promise<PersonalDebt> {
  const debt = (await store.fetchPersonalDebts()).find(
    (candidate) => candidate.id === id
  )
  if (!debt) throw DomainError.notFound(id)
  return debt
}

/** Creates or edits a debt; an edit keeps its currency, repayments and settling, and can't drop below what was repaid. */
export async function savePersonalDebt(
  store: LedgerStore,
  draft: PersonalDebtDraft
): Promise<PersonalDebt> {
  const person = cleaned(draft.person, MAX_DEBT_NAME_LENGTH)
  if (person === "") throw DomainError.missingName()
  const amount = positive(draft.amount)
  const current =
    draft.id === undefined ? undefined : await existingDebt(store, draft.id)
  if (!current) await checkNewCurrency(store, draft.currency)
  const note = draft.note.trim()
  const zone = store.timeZone
  const dueDate =
    draft.dueDate === undefined ? undefined : startOfDay(draft.dueDate, zone)
  if (dueDate !== undefined && dayKey(dueDate, zone) < dayKey(draft.date, zone))
    throw DomainError.invalidDueDate()
  const debt: PersonalDebt = {
    id: current?.id ?? newID(),
    person,
    direction: draft.direction,
    amount: {
      amount: decimalText(amount),
      currency: current?.amount.currency ?? draft.currency,
    },
    date: draft.date.toISOString(),
    ...(note === "" ? {} : { note }),
    repayments: current?.repayments ?? [],
    ...(current?.settledAt === undefined
      ? {}
      : { settledAt: current.settledAt }),
    ...(current?.transactionId === undefined
      ? {}
      : { transactionId: current.transactionId }),
    ...(dueDate === undefined ? {} : { dueDate: dueDate.toISOString() }),
  }
  if (debtRepaid(debt).gt(amount)) throw DomainError.invalidAmount()
  await store.savePersonalDebt(debt)
  return debt
}

/** Where a deposited repayment is filed as income: "Refunds", or "Other income" once it was deleted. */
export const REPAYMENT_CATEGORY_ID = "refunds"

export function repaymentCategoryId(
  categories: readonly Pick<TransactionCategory, "id" | "kind">[]
): string {
  return categories.some(
    (category) =>
      category.id === REPAYMENT_CATEGORY_ID && category.kind === "income"
  )
    ? REPAYMENT_CATEGORY_ID
    : OTHER_INCOME_ID
}

/** "Ana · Dinner": the deposit's description, the same on every app (the person, then the debt's note). */
export function repaymentDescription(
  debt: Pick<PersonalDebt, "person" | "note">
): string {
  const note = debt.note?.trim() ?? ""
  return note === "" ? debt.person : `${debt.person} · ${note}`
}

/** "Deposit into account": the repayment also enters an account as an income movement. */
export interface RepaymentDeposit {
  accountId: string
  /** Defaults to `repaymentCategoryId`. */
  categoryId?: string
}

/**
 * "Record repayment": a positive amount no larger than what is left. Paying the rest settles it.
 *
 * With `deposit` (only on a "they owe me" debt), it also records a confirmed income movement of the
 * repayment's amount and currency into that account, through the same use case as a typed movement,
 * and links it (`DebtRepayment.transactionId`), in one atomic write as `payLoanInstallment` does: a
 * failure records neither. That movement changes the balance but no total counts it as income
 * (`isReimbursement`).
 */
export async function repayPersonalDebt(
  store: LedgerStore,
  id: string,
  amountText: string,
  day: Date,
  deposit?: RepaymentDeposit
): Promise<PersonalDebt> {
  return store.atomically(async () => {
    const debt = await existingDebt(store, id)
    const amount = positive(amountText)
    const remaining = debtRemaining(debt)
    if (isSettled(debt) || amount.gt(remaining)) throw DomainError.invalidAmount()
    let transactionId: string | undefined
    if (deposit) {
      if (debt.direction !== "theyOweMe")
        throw DomainError.unsupportedTransactionKind("income")
      const saved = await saveTransaction(store, {
        id: newID(),
        kind: "income",
        amount,
        currency: debt.amount.currency,
        categoryId:
          deposit.categoryId ??
          repaymentCategoryId(await store.fetchCategories()),
        source: { type: "account", id: deposit.accountId },
        description: repaymentDescription(debt),
        date: day,
        note: "",
        isDraft: false,
      })
      transactionId = saved.transaction.id
    }
    const repayment: DebtRepayment = {
      id: newID(),
      amount: decimalText(amount),
      date: day.toISOString(),
      ...(transactionId === undefined ? {} : { transactionId }),
    }
    const updated: PersonalDebt = {
      ...debt,
      repayments: [...debt.repayments, repayment],
      ...(amount.eq(remaining) ? { settledAt: day.toISOString() } : {}),
    }
    await store.savePersonalDebt(updated)
    return updated
  })
}

/**
 * Deletes one repayment and the movement it deposited, in one atomic write, as "Mark unpaid" does
 * for a loan: a movement already deleted leaves only the debt to save. A debt that this repayment
 * settled (settled the moment it was paid) opens again; one settled by hand stays settled.
 */
export async function deleteDebtRepayment(
  store: LedgerStore,
  debtId: string,
  repaymentId: string
): Promise<PersonalDebt> {
  return store.atomically(async () => {
    const debt = await existingDebt(store, debtId)
    const repayment = debt.repayments.find(
      (candidate) => candidate.id === repaymentId
    )
    if (!repayment) throw DomainError.notFound(repaymentId)
    const movementId = repayment.transactionId
    if (
      movementId !== undefined &&
      (await store.fetchTransactions()).some(
        (transaction) => transaction.id === movementId
      )
    ) {
      await store.deleteTransaction(movementId)
    }
    const { settledAt, ...open } = debt
    const reopens = settledAt !== undefined && settledAt === repayment.date
    const updated: PersonalDebt = {
      ...(reopens ? open : debt),
      repayments: debt.repayments.filter(
        (candidate) => candidate.id !== repaymentId
      ),
    }
    await store.savePersonalDebt(updated)
    return updated
  })
}

/** "Mark as settled", even with something left. */
export async function settlePersonalDebt(
  store: LedgerStore,
  id: string,
  day: Date
): Promise<PersonalDebt> {
  const updated = {
    ...(await existingDebt(store, id)),
    settledAt: day.toISOString(),
  }
  await store.savePersonalDebt(updated)
  return updated
}

/** Opens a settled debt again; only one with something left can be owed again. */
export async function reopenPersonalDebt(
  store: LedgerStore,
  id: string
): Promise<PersonalDebt> {
  const debt = await existingDebt(store, id)
  if (debtRemaining(debt).isZero()) throw DomainError.invalidAmount()
  const { settledAt: _, ...open } = debt
  await store.savePersonalDebt(open)
  return open
}

export async function deletePersonalDebt(
  store: LedgerStore,
  id: string
): Promise<void> {
  await store.deletePersonalDebt(id)
}

export interface SplitShare {
  person: string
  amount: Decimal
}

/** "Split": one "they owe me" debt per person for their share of an expense, each linked to the movement. */
export async function splitTransaction(
  store: LedgerStore,
  transactionId: string,
  shares: readonly SplitShare[]
): Promise<PersonalDebt[]> {
  const expense = (await store.fetchTransactions()).find(
    (transaction) => transaction.id === transactionId
  )
  if (!expense) throw DomainError.notFound(transactionId)
  if (expense.kind !== "expense")
    throw DomainError.unsupportedTransactionKind(expense.kind)
  const people = shares.map((share) =>
    cleaned(share.person, MAX_DEBT_NAME_LENGTH)
  )
  if (people.some((person) => person === "")) throw DomainError.missingName()
  checkSplit(
    shares.map((share) => share.amount),
    dec(expense.amount)
  )
  const created = shares.map((share, index): PersonalDebt => ({
    id: newID(),
    person: people[index]!,
    direction: "theyOweMe",
    amount: { amount: decimalText(share.amount), currency: expense.currency },
    date: expense.date,
    note: expense.description,
    repayments: [],
    transactionId: expense.id,
  }))
  for (const debt of created) await store.savePersonalDebt(debt)
  return created
}
