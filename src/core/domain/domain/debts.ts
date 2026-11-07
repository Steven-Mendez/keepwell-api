import { newID } from "../schema/id"
import {
  MAX_DEBT_NAME_LENGTH,
  MAX_LOAN_INSTALLMENTS,
  MAX_LOAN_NAME_LENGTH,
  type DebtDirection,
  type Loan,
  type LoanFrequency,
  type LoanPayment,
  type PersonalDebt,
} from "../schema"

import { startOfDay } from "./calendar"
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
  number: number
): Date {
  return occurrence(
    { startDate: loan.firstDueDate, frequency: loan.frequency, interval: 1 },
    number - 1
  )
}

/** The lowest installment not paid yet. */
export function loanNextNumber(loan: Loan): number | undefined {
  const paid = new Set(loan.payments.map((payment) => payment.number))
  for (let number = 1; number <= loan.installmentCount; number++)
    if (!paid.has(number)) return number
  return undefined
}

export function loanProgress(loan: Loan, today: Date): LoanProgress {
  const paid = new Map(
    loan.payments.map((payment) => [payment.number, payment])
  )
  const installments = Array.from(
    { length: Math.max(loan.installmentCount, 1) },
    (_, index): LoanInstallment => {
      const payment = paid.get(index + 1)
      return {
        number: index + 1,
        dueDate: loanDueDate(loan, index + 1),
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
    isNextOverdue: next ? startOfDay(next.dueDate) < startOfDay(today) : false,
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
  today: Date
): LoanProgress[] {
  return loans
    .map((loan) => loanProgress(loan, today))
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

/** Open debts first, newest first; settled ones after them, also newest first. */
export function orderedPersonalDebts(
  debts: readonly PersonalDebt[]
): PersonalDebt[] {
  return [...debts].sort((a, b) => {
    if (isSettled(a) !== isSettled(b)) return isSettled(a) ? 1 : -1
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
  }
  if (debtRepaid(debt).gt(amount)) throw DomainError.invalidAmount()
  await store.savePersonalDebt(debt)
  return debt
}

/** "Record repayment": a positive amount no larger than what is left. Paying the rest settles it. */
export async function repayPersonalDebt(
  store: LedgerStore,
  id: string,
  amountText: string,
  day: Date
): Promise<PersonalDebt> {
  const debt = await existingDebt(store, id)
  const amount = positive(amountText)
  const remaining = debtRemaining(debt)
  if (isSettled(debt) || amount.gt(remaining)) throw DomainError.invalidAmount()
  const updated: PersonalDebt = {
    ...debt,
    repayments: [
      ...debt.repayments,
      { amount: decimalText(amount), date: day.toISOString() },
    ],
    ...(amount.eq(remaining) ? { settledAt: day.toISOString() } : {}),
  }
  await store.savePersonalDebt(updated)
  return updated
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
