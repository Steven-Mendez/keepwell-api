import { newID } from "../schema/id"
import type {
  Account,
  Card,
  CategorizationRule,
  CurrencySettings,
  ExchangeRate,
  Transaction,
  TransactionCategory,
  TransactionKind,
  TransactionStatus,
} from "../schema"
import { OTHER_EXPENSE_ID, OTHER_INCOME_ID } from "../schema"

import { dayKey, parseDayKey } from "./calendar"
import { Decimal, decimalText } from "./decimal"
import {
  exchangeRate,
  normalizedCurrency,
  rateHasSecondCurrency,
  settingsRate,
} from "./money"
import { accountDisplayName, checkAmounts, folded } from "./rules"
import type { LedgerStore } from "./store"
import { firstMatchingRule } from "./categorization"
import { mergeTags, parsedCsvTags, tagsCsvField, tagsField } from "./tags"

// Port of ExportTransactionsUseCase.swift and ImportTransactionsUseCase.swift. Columns and values are
// a data format, not UI text: English, ISO dates and dot decimals whatever the language.

export const CSV_HEADER = [
  "date",
  "status",
  "type",
  "description",
  "category",
  "amount",
  "currency",
  "account",
  "card_last_four",
  "destination_account",
  "debited_principal",
  "rate",
  "shared",
  "note",
  "tags",
] as const

/** RFC 4180: quote fields with commas, quotes or line breaks, doubling inner quotes. */
export function escapeCsvField(field: string): string {
  return /[,"\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field
}

export function exportCsv(
  transactions: readonly Transaction[],
  accounts: readonly Account[],
  cards: readonly Card[],
  categories: readonly TransactionCategory[]
): string {
  const accountNames = new Map(
    accounts.map((account) => [account.id, accountDisplayName(account)])
  )
  const lastFour = new Map(cards.map((card) => [card.id, card.lastFour ?? ""]))
  const categoryNames = new Map(
    categories.map((category) => [category.id, category.name])
  )
  const rows = [...transactions]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((t) => [
      dayKey(new Date(t.date)),
      t.status,
      t.kind,
      t.description,
      t.categoryId ? (categoryNames.get(t.categoryId) ?? t.categoryId) : "",
      decimalText(new Decimal(t.amount)),
      t.currency,
      accountNames.get(t.accountId) ?? "",
      t.cardId ? (lastFour.get(t.cardId) ?? "") : "",
      t.destinationAccountId
        ? (accountNames.get(t.destinationAccountId) ?? "")
        : "",
      t.actualDebitedPrincipal
        ? decimalText(new Decimal(t.actualDebitedPrincipal))
        : "",
      rateHasSecondCurrency(t.exchangeRate)
        ? decimalText(new Decimal(t.exchangeRate.rate))
        : "",
      t.isShared ? "yes" : "no",
      t.note ?? "",
      tagsCsvField(t.tags ?? []),
    ])
  return (
    [[...CSV_HEADER], ...rows]
      .map((row) => row.map(escapeCsvField).join(","))
      .join("\n") + "\n"
  )
}

/** RFC 4180 reading: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index] as string
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else quoted = false
      } else field += character
      continue
    }
    if (character === '"') quoted = true
    else if (character === ",") {
      row.push(field)
      field = ""
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += character
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const NUMBER = /^-?[0-9]+(\.[0-9]+)?$/
const parseNumber = (text: string | undefined) =>
  text !== undefined && NUMBER.test(text) ? new Decimal(text) : undefined

/** What makes two movements the same for de-duplication. */
function fingerprint(
  t: Pick<
    Transaction,
    "date" | "amount" | "currency" | "accountId" | "kind" | "description"
  >
): string {
  return [
    dayKey(new Date(t.date)),
    decimalText(new Decimal(t.amount)),
    t.currency,
    t.accountId,
    t.kind,
    t.description,
  ].join("|")
}

export interface ImportSummary {
  imported: number
  /** Rows with an unknown account, a bad date or amount, or already recorded. */
  skipped: number
}

interface ImportRecords {
  accounts: readonly Account[]
  cards: readonly Card[]
  transactions: readonly Transaction[]
  categories: readonly TransactionCategory[]
  /** In the person's order: a row without a known category takes the first that matches. */
  rules?: readonly CategorizationRule[]
}

/**
 * Reads the file "Export CSV" writes (columns in any order; files from before the `tags` column still
 * import, without tags); each row must name an existing account.
 */
export function parseCsvTransactions(
  csv: string,
  records: ImportRecords,
  currencies: CurrencySettings
): { transactions: Transaction[]; skipped: number } {
  const rows = parseCsvRows(csv.replace(/^﻿/, ""))
  const header = rows[0]
  if (!header) return { transactions: [], skipped: 0 }
  const columns = new Map<string, number>()
  header.forEach((name, index) => {
    const key = name.trim().toLowerCase()
    if (!columns.has(key)) columns.set(key, index)
  })
  const value = (name: string, row: readonly string[]) => {
    const index = columns.get(name)
    const text = index === undefined ? undefined : row[index]?.trim()
    return text ? text : undefined
  }
  const accountNamed = (name: string) => {
    const wanted = folded(name)
    return records.accounts.find((account) =>
      [accountDisplayName(account), account.name].some(
        (candidate) => folded(candidate) === wanted
      )
    )
  }
  /** By id or stored name; `undefined` when empty or unknown, for a rule or "Other" to fill. */
  const knownCategoryId = (text: string | undefined, kind: TransactionKind) => {
    if (!text) return undefined
    const lower = text.toLowerCase()
    return records.categories.find(
      (category) =>
        category.kind === kind &&
        (category.id === text || category.name.toLowerCase() === lower)
    )?.id
  }
  /**
   * A known category, else the first rule that matches (its tags after the file's), else "Other" of
   * the kind. The file's own tags stay either way.
   */
  const categorized = (text: string | undefined, kind: TransactionKind, description: string, note: string | undefined, tags: readonly string[]): { categoryId?: string; tags?: string[] } => {
    if (kind === "transfer") return tagsField(tags)
    const known = knownCategoryId(text, kind)
    if (known) return { categoryId: known, ...tagsField(tags) }
    const rule = firstMatchingRule(records.rules ?? [], kind, description, note)
    if (rule && records.categories.some((category) => category.id === rule.categoryId)) {
      return { categoryId: rule.categoryId, ...tagsField(mergeTags(tags, rule.tags ?? [])) }
    }
    return { categoryId: kind === "income" ? OTHER_INCOME_ID : OTHER_EXPENSE_ID, ...tagsField(tags) }
  }
  const rateFrom = (text: string | undefined): ExchangeRate => {
    const parsed = parseNumber(text)
    if (currencies.second === undefined || !parsed)
      return settingsRate(currencies)
    try {
      return exchangeRate(currencies.principal, currencies.second, parsed)
    } catch {
      return settingsRate(currencies)
    }
  }
  const seen = new Set(records.transactions.map(fingerprint))
  const imported: Transaction[] = []
  let skipped = 0
  for (const row of rows.slice(1)) {
    if (row.every((field) => field === "")) continue
    const transaction = (() => {
      const date = value("date", row)
        ? parseDayKey(value("date", row) as string)
        : undefined
      const amount = parseNumber(value("amount", row))
      const account = value("account", row)
        ? accountNamed(value("account", row) as string)
        : undefined
      if (!date || !amount || !account) return undefined
      const debited = parseNumber(value("debited_principal", row))
      try {
        checkAmounts(amount, debited)
      } catch {
        return undefined
      }
      const typeText = value("type", row)
      const kind: TransactionKind =
        typeText === "income" ||
        typeText === "transfer" ||
        typeText === "expense"
          ? typeText
          : "expense"
      const destination = value("destination_account", row)
        ? accountNamed(value("destination_account", row) as string)
        : undefined
      if (
        kind === "transfer" &&
        (!destination || destination.id === account.id)
      )
        return undefined
      let currency: string
      try {
        currency = normalizedCurrency(value("currency", row) ?? "")
      } catch {
        currency = account.openingBalances[0]?.currency ?? currencies.principal
      }
      const digits = value("card_last_four", row)
      const card = digits
        ? records.cards.find(
            (candidate) =>
              candidate.accountId === account.id &&
              candidate.lastFour === digits
          )
        : undefined
      const statusText = value("status", row)
      const status: TransactionStatus =
        statusText === "planned" ? "planned" : "confirmed"
      const note = value("note", row)
      const description = value("description", row) ?? ""
      const result: Transaction = {
        id: newID(),
        date: date.toISOString(),
        status,
        description,
        kind,
        ...categorized(value("category", row), kind, description, note, parsedCsvTags(value("tags", row) ?? "")),
        amount: decimalText(amount),
        currency,
        accountId: account.id,
        ...(card ? { cardId: card.id } : {}),
        ...(kind === "transfer" && destination
          ? { destinationAccountId: destination.id }
          : {}),
        ...(debited ? { actualDebitedPrincipal: decimalText(debited) } : {}),
        exchangeRate: rateFrom(value("rate", row)),
        isShared: value("shared", row)?.toLowerCase() === "yes",
        ...(note ? { note } : {}),
      }
      return result
    })()
    if (!transaction || seen.has(fingerprint(transaction))) {
      skipped++
      continue
    }
    seen.add(fingerprint(transaction))
    imported.push(transaction)
  }
  return { transactions: imported, skipped }
}

export async function importCsv(
  store: LedgerStore,
  csv: string
): Promise<ImportSummary> {
  const currencies = (await store.loadSettings())?.currencies ?? {
    principal: "USD",
    rate: "1",
  }
  const [accounts, cards, transactions, categories, rules] = await Promise.all([
    store.fetchAccounts(),
    store.fetchCards(),
    store.fetchTransactions(),
    store.fetchCategories(),
    store.fetchCategorizationRules(),
  ])
  const parsed = parseCsvTransactions(
    csv,
    { accounts, cards, transactions, categories, rules },
    currencies
  )
  await store.atomically(async () => {
    for (const transaction of parsed.transactions)
      await store.saveTransaction(transaction)
  })
  return { imported: parsed.transactions.length, skipped: parsed.skipped }
}

export async function exportCsvFrom(store: LedgerStore): Promise<string> {
  const [accounts, cards, transactions, categories] = await Promise.all([
    store.fetchAccounts(),
    store.fetchCards(),
    store.fetchTransactions(),
    store.fetchCategories(),
  ])
  return exportCsv(transactions, accounts, cards, categories)
}
