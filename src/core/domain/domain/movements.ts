import type { Account, Card, CurrencySettings, ExchangeRate, Transaction, TransactionCategory, TransactionKind } from "../schema"

import { Decimal, ZERO, decimalText } from "./decimal"
import { yearMonthContaining, type TimeZone } from "./calendar"
import { DomainError } from "./errors"
import { INITIAL_CURRENCIES, settingsRate, type Money } from "./money"
import { balanceOf, checkAmounts, isConfirmed, isOpen, monthlySummary } from "./rules"
import type { LedgerStore } from "./store"
import { tagsField } from "./tags"

// Ports of the CreateTransaction feature domain (MovementType, TransactionDraft, MovementPreview,
// CreateTransactionUseCases) and TransactionActions.swift.

/** What the person is recording. The three transfer shapes are all `transfer`; they differ in who may send and receive. */
export type MovementType = "expense" | "income" | "transfer" | "withdrawal" | "cardPayment"
export const MOVEMENT_TYPES: readonly MovementType[] = ["expense", "income", "transfer", "withdrawal", "cardPayment"]

export function movementKind(type: MovementType): TransactionKind {
  return type === "expense" || type === "income" ? type : "transfer"
}

export function allowsSource(type: MovementType, account: Account): boolean {
  switch (type) {
    case "expense":
    case "income":
      return true
    case "transfer":
    case "cardPayment":
      return account.kind !== "credit"
    case "withdrawal":
      return account.kind === "deposit"
  }
}

export function allowsDestination(type: MovementType, account: Account, source: string | undefined): boolean {
  if (account.id === source) return false
  switch (type) {
    case "expense":
    case "income":
      return false
    case "transfer":
      return account.kind !== "credit"
    case "withdrawal":
      return account.kind === "cash"
    case "cardPayment":
      return account.kind === "credit"
  }
}

/** The types these accounts can actually record. */
export function availableMovementTypes(accounts: readonly Account[]): MovementType[] {
  if (accounts.length === 0) return []
  return MOVEMENT_TYPES.filter((type) => {
    if (movementKind(type) !== "transfer") return true
    return accounts.some((source) => allowsSource(type, source) && accounts.some((destination) => allowsDestination(type, destination, source.id)))
  })
}

/** The shape a saved transfer reads as, so editing it opens on the right type. */
export function movementTypeOf(transaction: Pick<Transaction, "kind" | "accountId" | "destinationAccountId">, accounts: readonly Account[]): MovementType {
  if (transaction.kind !== "transfer") return transaction.kind
  const source = accounts.find((account) => account.id === transaction.accountId)
  const destination = accounts.find((account) => account.id === transaction.destinationAccountId)
  if (destination?.kind === "credit") return "cardPayment"
  if (source?.kind === "deposit" && destination?.kind === "cash") return "withdrawal"
  return "transfer"
}

/** Where the money comes from: a payment method, or an account without one (cash). */
export type PaymentSource = { type: "card"; id: string } | { type: "account"; id: string }

export const sourceKey = (source: PaymentSource) => `${source.type}:${source.id}`

export interface TransactionDraft {
  /** Chosen when the flow starts; an existing id edits that movement. */
  id: string
  kind: TransactionKind
  amount: Decimal
  currency: string
  categoryId?: string
  source?: PaymentSource
  destinationAccountId?: string
  description: string
  date: Date
  /** "USD charged by the bank". */
  actualDebitedPrincipal?: Decimal
  note: string
  /** Saved without counting toward balances until confirmed. */
  isDraft: boolean
  /** The recurring rule it belongs to; an edit keeps the one it had. */
  recurringId?: string
  /** Normalized when saved; absent or empty means none. */
  tags?: string[]
}

export interface TransactionContext {
  currencies: CurrencySettings
  categories: TransactionCategory[]
  accounts: Account[]
  cards: Card[]
  balances: Map<string, Money[]>
  /** When each payment source was last used, by `sourceKey`. */
  lastUsed: Map<string, Date>
  categoryUsage: Map<string, number>
  transactions: Transaction[]
  /** The store's zone, for the days and months its rules read. */
  zone: TimeZone
}

export function accountIdFor(context: Pick<TransactionContext, "cards">, source: PaymentSource): string | undefined {
  return source.type === "card" ? context.cards.find((card) => card.id === source.id)?.accountId : source.id
}

export function lastUsedSource(context: TransactionContext): PaymentSource | undefined {
  let best: [string, Date] | undefined
  for (const entry of context.lastUsed) if (!best || entry[1] > best[1]) best = entry
  if (!best) return undefined
  const [type, id] = best[0].split(":") as ["card" | "account", string]
  return { type, id }
}

export async function getTransactionContext(store: LedgerStore): Promise<TransactionContext> {
  const currencies = (await store.loadSettings())?.currencies ?? INITIAL_CURRENCIES
  const [accounts, cards, transactions, categories] = await Promise.all([store.fetchAccounts(), store.fetchCards(), store.fetchTransactions(), store.fetchCategories()])
  const zone = store.timeZone
  const balances = new Map(accounts.map((account) => [account.id, balanceOf(account, transactions, zone)]))
  const lastUsed = new Map<string, Date>()
  const categoryUsage = new Map<string, number>()
  for (const movement of transactions) {
    const key = sourceKey(movement.cardId ? { type: "card", id: movement.cardId } : { type: "account", id: movement.accountId })
    const date = new Date(movement.date)
    const previous = lastUsed.get(key)
    if (!previous || date > previous) lastUsed.set(key, date)
    if (movement.categoryId) categoryUsage.set(movement.categoryId, (categoryUsage.get(movement.categoryId) ?? 0) + 1)
  }
  return { currencies, categories, accounts, cards, balances, lastUsed, categoryUsage, transactions, zone }
}

/**
 * The context editors pick from: open accounts and their methods, plus the closed ones in `keep` (the
 * accounts of the movement or rule being edited, which still show, labelled closed).
 */
export function pickerContext(context: TransactionContext, keep: readonly (string | undefined)[] = []): TransactionContext {
  const shown = context.accounts.filter((account) => isOpen(account) || keep.includes(account.id))
  if (shown.length === context.accounts.length) return context
  const ids = new Set(shown.map((account) => account.id))
  return { ...context, accounts: shown, cards: context.cards.filter((card) => ids.has(card.accountId)) }
}

/** Checks a draft against the iOS rules and builds the movement to store. */
export function validatedTransaction(draft: TransactionDraft, context: TransactionContext, existing?: Transaction): Transaction {
  checkAmounts(draft.amount, draft.actualDebitedPrincipal)
  // An edit keeps the rate it was recorded with (rule 2), so its currencies are the allowed ones.
  const rate: ExchangeRate = existing?.exchangeRate ?? settingsRate(context.currencies)
  if (draft.currency !== rate.principal && draft.currency !== rate.second) throw DomainError.invalidCurrency(draft.currency)
  const accountId = draft.source ? accountIdFor(context, draft.source) : undefined
  if (!draft.source || !accountId) throw DomainError.notFound("source")
  let category: TransactionCategory | undefined
  if (draft.kind === "transfer") {
    const destination = draft.destinationAccountId
    if (!destination || destination === accountId || !context.accounts.some((account) => account.id === destination)) {
      throw DomainError.invalidTransferDestination()
    }
  } else {
    category = context.categories.find((candidate) => candidate.id === draft.categoryId)
    if (!category) throw DomainError.notFound(draft.categoryId ?? "category")
    if (category.kind !== draft.kind) throw DomainError.categoryKindMismatch(draft.kind, category.kind)
  }
  const description = draft.description.trim()
  const note = draft.note.trim()
  const debited = draft.currency === rate.principal ? undefined : draft.actualDebitedPrincipal
  const recurringId = draft.recurringId ?? existing?.recurringId
  const transaction: Transaction = {
    id: draft.id,
    date: draft.date.toISOString(),
    status: draft.isDraft ? "planned" : "confirmed",
    // Safety net only: the flow fills a localized description before saving.
    description: description === "" ? (category?.name ?? "Transfer") : description,
    kind: draft.kind,
    ...(draft.kind === "transfer" || draft.categoryId === undefined ? {} : { categoryId: draft.categoryId }),
    amount: decimalText(draft.amount),
    currency: draft.currency,
    accountId,
    ...(draft.source.type === "card" ? { cardId: draft.source.id } : {}),
    ...(draft.kind === "transfer" && draft.destinationAccountId ? { destinationAccountId: draft.destinationAccountId } : {}),
    ...(debited === undefined ? {} : { actualDebitedPrincipal: decimalText(debited) }),
    exchangeRate: rate,
    isShared: existing?.isShared ?? false,
    ...(note === "" ? {} : { note }),
    ...(recurringId === undefined ? {} : { recurringId }),
    ...tagsField(draft.tags),
  }
  checkClosedAccounts(transaction, context.accounts, existing)
  return transaction
}

/** Whether two versions of a movement move the same money: same accounts, amounts, day and status. */
function sameBalanceEffect(a: Transaction, b: Transaction): boolean {
  return (
    a.kind === b.kind &&
    a.status === b.status &&
    new Date(a.date).getTime() === new Date(b.date).getTime() &&
    a.accountId === b.accountId &&
    a.cardId === b.cardId &&
    a.destinationAccountId === b.destinationAccountId &&
    a.currency === b.currency &&
    new Decimal(a.amount).eq(b.amount) &&
    (a.actualDebitedPrincipal === undefined) === (b.actualDebitedPrincipal === undefined) &&
    (a.actualDebitedPrincipal === undefined || new Decimal(a.actualDebitedPrincipal).eq(b.actualDebitedPrincipal as string))
  )
}

/**
 * A closed account keeps the balance it was closed with: no new movement touches it, and an edit of
 * one that does (or would) may change its description, category, note and tags, never what it moves.
 */
export function checkClosedAccounts(transaction: Transaction, accounts: readonly Account[], existing?: Transaction): void {
  const touched = [transaction.accountId, transaction.destinationAccountId, existing?.accountId, existing?.destinationAccountId]
  const closed = touched.find((id) => id !== undefined && accounts.some((account) => account.id === id && !isOpen(account)))
  if (closed === undefined) return
  if (existing && sameBalanceEffect(existing, transaction)) return
  throw DomainError.accountClosed(closed)
}

export interface SavedTransaction {
  transaction: Transaction
  account: Account
  /** The source account's balances after the movement. */
  newBalances: Money[]
  /** Spending in the movement's category that month, in the principal currency. */
  categoryMonthTotal?: Money
}

/** Saves a new movement, or replaces the one with the draft's id (edit). */
export async function saveTransaction(store: LedgerStore, draft: TransactionDraft): Promise<SavedTransaction> {
  const context = await getTransactionContext(store)
  const existing = context.transactions.find((transaction) => transaction.id === draft.id)
  const transaction = validatedTransaction(draft, context, existing)
  await store.saveTransaction(transaction)
  return savedTransactionOf(transaction, context.accounts, await store.fetchTransactions(), context.currencies.principal, context.zone)
}

/**
 * What the receipt states about a stored movement: its account's balances with every movement,
 * and, for an expense, its category's spending that month. Also rebuilds a receipt from history.
 */
export function savedTransactionOf(
  transaction: Transaction,
  accounts: readonly Account[],
  movements: readonly Transaction[],
  principal: string,
  zone: TimeZone,
): SavedTransaction {
  const account = accounts.find((candidate) => candidate.id === transaction.accountId)
  if (!account) throw DomainError.notFound(transaction.accountId)
  const newBalances = balanceOf(account, movements, zone)
  let categoryMonthTotal: Money | undefined
  if (transaction.kind === "expense") {
    const summary = monthlySummary(yearMonthContaining(new Date(transaction.date), zone), movements, principal, zone)
    const total = summary.categories.find((entry) => entry.categoryId === transaction.categoryId)?.amount ?? ZERO
    categoryMonthTotal = { amount: total, currency: principal }
  }
  return { transaction, account, newBalances, ...(categoryMonthTotal ? { categoryMonthTotal } : {}) }
}

export interface MovementPreview {
  sourceBefore: Money[]
  sourceAfter: Money[]
  destinationBefore: Money[]
  destinationAfter: Money[]
  /** What leaves the source, in the currency the source books it (positive). */
  leaving?: Money
  /** What enters the destination, in the currency it books it (positive). */
  arriving?: Money
}

export function convertsCurrency(preview: MovementPreview, typed: string): boolean {
  return [preview.leaving, preview.arriving].some((side) => side !== undefined && side.currency !== typed)
}

function change(before: readonly Money[], after: readonly Money[]): Money | undefined {
  for (let index = 0; index < Math.min(before.length, after.length); index++) {
    const old = before[index] as Money
    const updated = after[index] as Money
    if (!old.amount.eq(updated.amount)) return { amount: updated.amount.minus(old.amount).abs(), currency: updated.currency }
  }
  return undefined
}

/**
 * What a draft would do to the accounts it touches, through the same balance rules a saved movement
 * goes through. `excluding` leaves out the movement being edited, so its old version doesn't count twice.
 */
export function previewMovement(context: TransactionContext, draft: TransactionDraft, excluding?: Transaction): MovementPreview | undefined {
  if (draft.amount.lte(0) || !draft.source) return undefined
  const sourceId = accountIdFor(context, draft.source)
  const sourceAccount = context.accounts.find((account) => account.id === sourceId)
  if (!sourceId || !sourceAccount) return undefined
  const destinationAccount = draft.kind === "transfer" ? context.accounts.find((account) => account.id === draft.destinationAccountId) : undefined
  const rate = excluding?.exchangeRate ?? settingsRate(context.currencies)
  const movement: Transaction = {
    id: "preview",
    date: draft.date.toISOString(),
    status: "confirmed",
    description: "",
    kind: draft.kind,
    amount: decimalText(draft.amount),
    currency: draft.currency,
    accountId: sourceId,
    ...(destinationAccount ? { destinationAccountId: destinationAccount.id } : {}),
    ...(draft.currency !== rate.principal && draft.actualDebitedPrincipal ? { actualDebitedPrincipal: decimalText(draft.actualDebitedPrincipal) } : {}),
    exchangeRate: rate,
    isShared: false,
  }
  const balancesOf = (account: Account) =>
    excluding ? balanceOf(account, context.transactions.filter((transaction) => transaction.id !== excluding.id), context.zone) : (context.balances.get(account.id) ?? balanceOf(account, [], context.zone))
  const side = (account: Account) => {
    const before = balancesOf(account)
    // Today's balance with an opening date in the far past applies just this one movement on top.
    const current: Account = { ...account, openingBalances: before.map((m) => ({ amount: decimalText(m.amount), currency: m.currency })), openingDate: new Date(0).toISOString() }
    return { before, after: balanceOf(current, [movement], context.zone) }
  }
  const source = side(sourceAccount)
  const destination = destinationAccount ? side(destinationAccount) : undefined
  const sourceChange = change(source.before, source.after)
  const destinationChange = destination ? change(destination.before, destination.after) : undefined
  return {
    sourceBefore: source.before,
    sourceAfter: source.after,
    destinationBefore: destination?.before ?? [],
    destinationAfter: destination?.after ?? [],
    ...(draft.kind !== "income" && sourceChange ? { leaving: sourceChange } : {}),
    ...(draft.kind === "income" ? (sourceChange ? { arriving: sourceChange } : {}) : destinationChange ? { arriving: destinationChange } : {}),
  }
}

/** Turns a planned movement into a confirmed one; one due in the future is dated today. */
export async function confirmPlannedTransaction(store: LedgerStore, id: string, now: Date = new Date()): Promise<void> {
  const planned = (await store.fetchTransactions()).find((transaction) => transaction.id === id)
  if (!planned) throw DomainError.notFound(id)
  if (isConfirmed(planned)) return
  const date = new Date(planned.date) > now ? now.toISOString() : planned.date
  const confirmed: Transaction = { ...planned, status: "confirmed", date }
  checkClosedAccounts(confirmed, await store.fetchAccounts(), planned)
  await store.saveTransaction(confirmed)
}

/**
 * Undoes `confirmPlannedTransaction`: the movement is a draft again, back on the date it was planned
 * for (`plannedDate`, since confirming may have moved it to today), so it stops counting toward balances.
 */
export async function unconfirmTransaction(store: LedgerStore, id: string, plannedDate: string): Promise<void> {
  const confirmed = (await store.fetchTransactions()).find((transaction) => transaction.id === id)
  if (!confirmed) throw DomainError.notFound(id)
  if (!isConfirmed(confirmed)) return
  const planned: Transaction = { ...confirmed, status: "planned", date: plannedDate }
  checkClosedAccounts(planned, await store.fetchAccounts(), confirmed)
  await store.saveTransaction(planned)
}

export async function deleteTransaction(store: LedgerStore, id: string): Promise<void> {
  await store.deleteTransaction(id)
}

/** A draft that edits `transaction`, with every field as it was saved. */
export function draftFrom(transaction: Transaction): TransactionDraft {
  return {
    id: transaction.id,
    kind: transaction.kind,
    amount: new Decimal(transaction.amount),
    currency: transaction.currency,
    ...(transaction.categoryId ? { categoryId: transaction.categoryId } : {}),
    source: transaction.cardId ? { type: "card", id: transaction.cardId } : { type: "account", id: transaction.accountId },
    ...(transaction.destinationAccountId ? { destinationAccountId: transaction.destinationAccountId } : {}),
    description: transaction.description,
    date: new Date(transaction.date),
    ...(transaction.actualDebitedPrincipal ? { actualDebitedPrincipal: new Decimal(transaction.actualDebitedPrincipal) } : {}),
    note: transaction.note ?? "",
    isDraft: transaction.status === "planned",
    ...(transaction.tags ? { tags: [...transaction.tags] } : {}),
  }
}
