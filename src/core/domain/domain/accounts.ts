import { newID } from "../schema/id"
import type {
  Account,
  AccountKind,
  Card,
  CardColor,
  CardNetwork,
  CreditTerms,
  DebtMode,
  Transaction,
} from "../schema"

import type { Decimal } from "./decimal"
import { DomainError } from "./errors"
import { INITIAL_CURRENCIES, toStored, type Money } from "./money"
import { checkDayOfMonth, checkLastFour, scopeIncludes } from "./rules"
import type { LedgerStore } from "./store"

// Ports of BankAccounts.swift, CardActions.swift, AddCardUseCases.swift and CreditCardUseCases.swift.

const newId = () => newID()

/** Builds a card, trimming the product name and refusing bad digits (iOS `Card.init`). */
export function makeCard(input: Omit<Card, "id"> & { id?: string }): Card {
  checkLastFour(input.lastFour)
  const productName = input.productName?.trim()
  const card: Card = {
    id: input.id ?? newId(),
    accountId: input.accountId,
    kind: input.kind,
    ...(input.network === undefined ? {} : { network: input.network }),
    ...(input.lastFour === undefined ? {} : { lastFour: input.lastFour }),
    ...(input.color === undefined ? {} : { color: input.color }),
    ...(productName ? { productName } : {}),
    ...(input.expiry === undefined ? {} : { expiry: input.expiry }),
  }
  return card
}

export function makeCreditTerms(
  debtMode: DebtMode,
  limit?: Money,
  cutoffDay?: number,
  dueDay?: number
): CreditTerms {
  checkDayOfMonth(cutoffDay)
  checkDayOfMonth(dueDay)
  return {
    debtMode,
    ...(limit === undefined ? {} : { limit: toStored(limit) }),
    ...(cutoffDay === undefined ? {} : { cutoffDay }),
    ...(dueDay === undefined ? {} : { dueDay }),
  }
}

/** The debit card a bank account is created with; without digits it still exists. */
export function debitCardFor(
  accountId: string,
  lastFour?: string,
  network?: CardNetwork,
  color: CardColor = "verde"
): Card {
  const digits = lastFour?.trim()
  return makeCard({
    accountId,
    kind: "debit",
    ...(network === undefined ? {} : { network }),
    ...(digits ? { lastFour: digits } : {}),
    color,
  })
}

export interface DebitCardDraft {
  lastFour?: string
  network?: CardNetwork
  color?: CardColor
}

/** "Debit card" (a bank account with its card) and "Other wallet" from the add menu. */
export async function addAccount(
  store: LedgerStore,
  input: {
    kind: AccountKind
    name: string
    bank?: string
    balance: Money
    debitCard?: DebitCardDraft
  },
  now: Date = new Date()
): Promise<Account> {
  if (input.kind === "credit")
    throw DomainError.unsupportedTransactionKind("transfer")
  if (input.balance.amount.lt(0)) throw DomainError.invalidAmount()
  const name = input.name.trim()
  if (name === "") throw DomainError.missingName()
  const bank = input.bank?.trim()
  const account: Account = {
    id: newId(),
    name,
    ...(bank ? { bank } : {}),
    kind: input.kind,
    openingBalances: [toStored(input.balance)],
    openingDate: now.toISOString(),
  }
  // Built before saving anything, so bad digits leave no account without its card.
  const methods =
    input.kind === "deposit"
      ? [
          debitCardFor(
            account.id,
            input.debitCard?.lastFour,
            input.debitCard?.network,
            input.debitCard?.color ?? "verde"
          ),
          makeCard({ accountId: account.id, kind: "transfer" }),
        ]
      : []
  await store.atomically(async () => {
    await store.saveAccount(account)
    for (const method of methods) await store.saveCard(method)
  })
  return account
}

export interface CreditCardDraft {
  bank: string
  lastFour: string
  network: CardNetwork
  color: CardColor
  debtMode: DebtMode
  /** What is owed today, positive, in the principal currency (or the card's only currency). */
  principalDebt: Decimal
  /** Dual cards: what is owed in the second currency. */
  secondDebt: Decimal
  limit?: Decimal
  cutoffDay?: number
  dueDay?: number
}

export function networkAccountName(network: CardNetwork): string {
  return {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "Amex",
    other: "Card",
  }[network]
}

/** Creates the credit account (debts negative, rule 5) and its holder plastic. */
export async function addCreditCard(
  store: LedgerStore,
  draft: CreditCardDraft,
  now: Date = new Date()
): Promise<{ account: Account; holder: Card }> {
  if (
    draft.principalDebt.lt(0) ||
    draft.secondDebt.lt(0) ||
    (draft.limit !== undefined && draft.limit.lte(0))
  )
    throw DomainError.invalidAmount()
  const currencies =
    (await store.loadSettings())?.currencies ?? INITIAL_CURRENCIES
  const second = currencies.second ?? currencies.principal
  const mode: DebtMode =
    currencies.second === undefined ? "principal" : draft.debtMode
  const openingBalances: Money[] =
    mode === "dual"
      ? [
          { amount: draft.principalDebt.neg(), currency: currencies.principal },
          { amount: draft.secondDebt.neg(), currency: second },
        ]
      : [
          {
            amount: draft.principalDebt.neg(),
            currency: mode === "second" ? second : currencies.principal,
          },
        ]
  const limitCurrency = mode === "second" ? second : currencies.principal
  const terms = makeCreditTerms(
    mode,
    draft.limit === undefined
      ? undefined
      : { amount: draft.limit, currency: limitCurrency },
    draft.cutoffDay,
    draft.dueDay
  )
  const bank = draft.bank.trim()
  const account: Account = {
    id: newId(),
    name: networkAccountName(draft.network),
    ...(bank ? { bank } : {}),
    kind: "credit",
    openingBalances: openingBalances.map(toStored),
    openingDate: now.toISOString(),
    creditTerms: terms,
  }
  const holder = makeCard({
    accountId: account.id,
    kind: "creditHolder",
    network: draft.network,
    lastFour: draft.lastFour,
    color: draft.color,
  })
  await store.atomically(async () => {
    await store.saveAccount(account)
    await store.saveCard(holder)
  })
  return { account, holder }
}

/**
 * "Delete account": the account, its cards and every movement that touches it, transfers with other
 * accounts included, since a movement can't point at an account that no longer exists. Recurring
 * rules from or to it go too.
 */
export async function deleteAccount(
  store: LedgerStore,
  accountId: string
): Promise<void> {
  if (
    !(await store.fetchAccounts()).some((account) => account.id === accountId)
  )
    throw DomainError.notFound(accountId)
  await store.atomically(async () => {
    const scope = { kind: "account", id: accountId } as const
    for (const movement of await store.fetchTransactions()) {
      if (scopeIncludes(scope, movement))
        await store.deleteTransaction(movement.id)
    }
    for (const rule of await store.fetchRecurringRules()) {
      if (rule.accountId === accountId || rule.destinationAccountId === accountId)
        await store.deleteRecurringRule(rule.id)
    }
    for (const card of await store.fetchCards()) {
      if (card.accountId === accountId) await store.deleteCard(card.id)
    }
    await store.deleteAccount(accountId)
  })
}

export async function renameAccount(
  store: LedgerStore,
  accountId: string,
  name: string
): Promise<void> {
  const trimmed = name.trim()
  if (trimmed === "") throw DomainError.missingName()
  const account = (await store.fetchAccounts()).find(
    (candidate) => candidate.id === accountId
  )
  if (!account) throw DomainError.notFound(accountId)
  await store.saveAccount({ ...account, name: trimmed })
}

async function plastic(store: LedgerStore, cardId: string): Promise<Card> {
  const card = (await store.fetchCards()).find(
    (candidate) => candidate.id === cardId && candidate.kind !== "transfer"
  )
  if (!card) throw DomainError.notFound(cardId)
  return card
}

/** Repaints a plastic's art; transfer channels have none. */
export async function setCardColor(
  store: LedgerStore,
  cardId: string,
  color: CardColor
): Promise<void> {
  const card = await plastic(store, cardId)
  await store.saveCard({ ...card, color })
}

/** Product name and "valid thru"; a blank name clears it. */
export async function setCardDetails(
  store: LedgerStore,
  cardId: string,
  productName: string | undefined,
  expiry: { month: number; year: number } | undefined
): Promise<void> {
  const card = await plastic(store, cardId)
  const { productName: _old, expiry: _oldExpiry, ...rest } = card
  await store.saveCard(
    makeCard({
      ...rest,
      ...(productName === undefined ? {} : { productName }),
      ...(expiry === undefined ? {} : { expiry }),
    })
  )
}

/** Sets the digits and network a debit card was saved without (Settings › Payment methods on iOS edits them the same way). */
export async function setCardNumber(
  store: LedgerStore,
  cardId: string,
  lastFour: string | undefined,
  network: CardNetwork | undefined
): Promise<void> {
  const card = await plastic(store, cardId)
  const { lastFour: _l, network: _n, ...rest } = card
  const digits = lastFour?.trim()
  await store.saveCard(
    makeCard({
      ...rest,
      ...(digits ? { lastFour: digits } : {}),
      ...(network === undefined ? {} : { network }),
    })
  )
}

/** "Complete card details": limit, cutoff and due day; `undefined` clears a value. */
export async function updateCreditTerms(
  store: LedgerStore,
  accountId: string,
  limit: Money | undefined,
  cutoffDay: number | undefined,
  dueDay: number | undefined
): Promise<void> {
  const account = (await store.fetchAccounts()).find(
    (candidate) => candidate.id === accountId && candidate.kind === "credit"
  )
  if (!account) throw DomainError.notFound(accountId)
  if (limit && limit.amount.lte(0)) throw DomainError.invalidAmount()
  const mode =
    account.creditTerms?.debtMode ??
    (account.openingBalances.length > 1 ? "dual" : "principal")
  await store.saveAccount({
    ...account,
    creditTerms: makeCreditTerms(mode, limit, cutoffDay, dueDay),
  })
}

/** The method with the most movements; on a tie the oldest, so every device picks the same one. */
export function keeperOf(
  methods: readonly Card[],
  movements: readonly Transaction[]
): Card | undefined {
  const usage = new Map<string, number>()
  for (const movement of movements)
    if (movement.cardId)
      usage.set(movement.cardId, (usage.get(movement.cardId) ?? 0) + 1)
  let best: Card | undefined
  let bestUsage = -1
  for (const method of methods) {
    const used = usage.get(method.id) ?? 0
    if (used > bestUsage) {
      best = method
      bestUsage = used
    }
  }
  return best
}

/**
 * Every bank account ends with exactly one debit card and one transfer channel: duplicates merge
 * into the most used one, their movements and recurring rules move with them. Safe on every launch; returns whether
 * anything changed.
 */
export async function normalizeBankCards(store: LedgerStore): Promise<boolean> {
  const deposits = (await store.fetchAccounts()).filter(
    (account) => account.kind === "deposit"
  )
  if (deposits.length === 0) return false
  const allCards = await store.fetchCards()
  let movements = await store.fetchTransactions()
  let changed = false
  await store.atomically(async () => {
    for (const account of deposits) {
      for (const kind of ["debit", "transfer"] as const) {
        const methods = allCards.filter(
          (card) => card.accountId === account.id && card.kind === kind
        )
        if (methods.length === 1) continue
        changed = true
        const keeper = keeperOf(methods, movements)
        if (!keeper) {
          await store.saveCard(
            kind === "debit"
              ? debitCardFor(account.id)
              : makeCard({ accountId: account.id, kind: "transfer" })
          )
          continue
        }
        const merged = new Set(
          methods
            .filter((method) => method.id !== keeper.id)
            .map((method) => method.id)
        )
        movements = await Promise.all(
          movements.map(async (movement) => {
            if (!movement.cardId || !merged.has(movement.cardId))
              return movement
            const moved = { ...movement, cardId: keeper.id }
            await store.saveTransaction(moved)
            return moved
          })
        )
        for (const rule of await store.fetchRecurringRules()) {
          if (rule.cardId && merged.has(rule.cardId))
            await store.saveRecurringRule({ ...rule, cardId: keeper.id })
        }
        for (const id of merged) await store.deleteCard(id)
      }
    }
  })
  return changed
}
