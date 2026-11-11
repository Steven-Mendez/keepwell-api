import type {
  Account,
  Card,
  Transaction,
  TransactionCategory,
} from "../schema"

import { dayKey } from "./calendar"
import { Decimal, decimalText } from "./decimal"
import { rateHasSecondCurrency } from "./money"
import { accountDisplayName } from "./rules"
import type { LedgerStore } from "./store"
import { tagsCsvField } from "./tags"

// Port of ExportTransactionsUseCase.swift (export only: neither platform imports CSV). Columns and values are
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

export async function exportCsvFrom(store: LedgerStore): Promise<string> {
  const [accounts, cards, transactions, categories] = await Promise.all([
    store.fetchAccounts(),
    store.fetchCards(),
    store.fetchTransactions(),
    store.fetchCategories(),
  ])
  return exportCsv(transactions, accounts, cards, categories)
}
