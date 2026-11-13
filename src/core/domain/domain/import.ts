import type { Transaction, TransactionKind } from "../schema"
import { MAX_IMPORTED_ID_LENGTH, uuidV5 } from "../schema"

import { dayKey, parseDayKey, type TimeZone } from "./calendar"
import { otherCategoryId } from "./categories"
import { Decimal, decimalText } from "./decimal"
import { DomainError } from "./errors"
import { getTransactionContext, validatedTransaction, type PaymentSource, type TransactionDraft } from "./movements"
import type { LedgerStore } from "./store"

// Importing a bank statement into one account without duplicating what is already recorded (T28).
// `matchIncoming` is pure: it only says which lines are new, which are already in Keepwell and which
// to skip. `importTransactions` saves the new ones and marks the matched ones with the line's id;
// what the person wrote on a movement (description, category, note, tags, date, amount) always wins
// over the file.

/** One line of a statement, as the reader of the file (Claude) understood it. */
export interface IncomingLine {
  /** YYYY-MM-DD, the day the bank shows. */
  day: string
  /** `out` leaves the account (an expense, or a transfer from it); `in` enters it. */
  direction: "out" | "in"
  /** Positive exact decimal. */
  amount: string
  currency: string
  description: string
  /** The bank's id for the line (FITID, reference), when the statement has one. */
  importedId?: string
}

/** What a line is, by its position in the call (`line`, from 0). */
export type LineMatch =
  | { line: number; result: "new"; importedId: string }
  | { line: number; result: "existing"; transactionId: string; by: "imported_id" | "amount_date" }
  | { line: number; result: "skipped"; reason: "transfer_leg" | "repeated_in_file"; transactionId?: string }

/** How far apart, in calendar days of the person's zone, a line and a movement may be and still match. */
export const IMPORT_WINDOW_DAYS = 7
/** The most lines one call takes. */
export const MAX_IMPORT_LINES = 200

const DAY = /^\d{4}-\d{2}-\d{2}$/

function checkedDay(day: string, zone: TimeZone): Date {
  const date = DAY.test(day) ? parseDayKey(day, zone) : undefined
  // A day that doesn't exist ("2026-02-30") rolls over in `parseDayKey`; it isn't the day written.
  if (!date || dayKey(date, zone) !== day) throw DomainError.corruptedData(`line day ${day}`)
  return date
}

/**
 * Each line's id: the bank's when it brings one; otherwise `kw1:` and a hash of the account, day,
 * direction, amount, currency and the line's ordinal among the lines of that day and amount in the
 * call. Two equal coffees on one day get different ids, and the same file imported twice the same.
 */
export function importedLineIds(accountId: string, lines: readonly IncomingLine[]): string[] {
  const ordinals = new Map<string, number>()
  return lines.map((line) => {
    const own = line.importedId?.trim()
    const amount = decimalText(new Decimal(line.amount))
    const group = `${line.day}|${amount}`
    const ordinal = ordinals.get(group) ?? 0
    ordinals.set(group, ordinal + 1)
    if (own) return own.slice(0, MAX_IMPORTED_ID_LENGTH)
    return `kw1:${uuidV5(`import-line|${accountId.toLowerCase()}|${line.day}|${line.direction}|${amount}|${line.currency.toUpperCase()}|${ordinal}`)}`
  })
}

/** The id the movement imported from a line gets, so a retried import finds it instead of creating it again. */
export function importedTransactionId(accountId: string, importedId: string): string {
  return uuidV5(`import|${accountId.toLowerCase()}|${importedId}`)
}

/** Calendar days from `a` to `b` ("YYYY-MM-DD"), the same in every zone once the days are known. */
function daysBetween(a: string, b: string): number {
  const utc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
  return Math.round((utc(b) - utc(a)) / 86_400_000)
}

/** Whether the movement moved this amount: what it records, or what the bank charged in the principal currency. */
function sameAmount(transaction: Transaction, amount: Decimal, currency: string): boolean {
  if (transaction.currency === currency && new Decimal(transaction.amount).eq(amount)) return true
  return transaction.actualDebitedPrincipal !== undefined && transaction.exchangeRate.principal === currency && new Decimal(transaction.actualDebitedPrincipal).eq(amount)
}

/**
 * Sorts a statement's lines into new, existing and skipped against the account's movements, in this
 * order: the line's id repeated in the call (skipped); a movement with the same `importedId`
 * (existing); a movement of the account without `importedId`, same direction, amount and currency, at
 * most `windowDays` calendar days away in `timeZone` (existing); a transfer's leg on this account
 * (skipped); anything else is new. Each movement matches one line at most: the lines go by day and
 * order and each takes the closest candidate, then the oldest, then the lowest id. Drafts match too
 * (and stay drafts); deleted movements aren't in `existing`.
 */
export function matchIncoming(
  accountId: string,
  lines: readonly IncomingLine[],
  existing: readonly Transaction[],
  options: { timeZone: TimeZone; windowDays?: number },
): LineMatch[] {
  const zone = options.timeZone
  const window = options.windowDays ?? IMPORT_WINDOW_DAYS
  for (const line of lines) checkedDay(line.day, zone)
  const ids = importedLineIds(accountId, lines)
  const results: (LineMatch | undefined)[] = lines.map(() => undefined)
  const used = new Set<string>()
  const ofAccount = existing.filter((transaction) => transaction.accountId === accountId || transaction.destinationAccountId === accountId)

  // 1 and 2: repeated ids, then exact matches.
  const seen = new Set<string>()
  lines.forEach((_, index) => {
    const id = ids[index]!
    if (seen.has(id)) {
      results[index] = { line: index, result: "skipped", reason: "repeated_in_file" }
      return
    }
    seen.add(id)
    const exact = ofAccount.find((transaction) => transaction.importedId === id)
    if (exact) {
      used.add(exact.id)
      results[index] = { line: index, result: "existing", transactionId: exact.id, by: "imported_id" }
    }
  })

  const days = new Map(ofAccount.map((transaction) => [transaction.id, dayKey(new Date(transaction.date), zone)]))
  const closest = (line: IncomingLine, candidates: readonly Transaction[]): Transaction | undefined => {
    let best: { transaction: Transaction; distance: number } | undefined
    for (const transaction of candidates) {
      const distance = Math.abs(daysBetween(line.day, days.get(transaction.id)!))
      if (distance > window) continue
      if (
        !best ||
        distance < best.distance ||
        (distance === best.distance && (transaction.date < best.transaction.date || (transaction.date === best.transaction.date && transaction.id < best.transaction.id)))
      ) {
        best = { transaction, distance }
      }
    }
    return best?.transaction
  }

  // 3 and 4: the rest by day and order.
  const pending = lines.map((line, index) => ({ line, index })).filter(({ index }) => results[index] === undefined)
  pending.sort((a, b) => (a.line.day === b.line.day ? a.index - b.index : a.line.day < b.line.day ? -1 : 1))
  for (const { line, index } of pending) {
    const amount = new Decimal(line.amount)
    const currency = line.currency.toUpperCase()
    const kind: TransactionKind = line.direction === "out" ? "expense" : "income"
    const movement = closest(
      line,
      ofAccount.filter((transaction) => !used.has(transaction.id) && transaction.importedId === undefined && transaction.kind === kind && transaction.accountId === accountId && sameAmount(transaction, amount, currency)),
    )
    if (movement) {
      used.add(movement.id)
      results[index] = { line: index, result: "existing", transactionId: movement.id, by: "amount_date" }
      continue
    }
    // A transfer is one row with one `importedId`, which can't serve both banks: its legs are skipped, never marked.
    const leg = closest(
      line,
      ofAccount.filter(
        (transaction) =>
          !used.has(transaction.id) &&
          transaction.kind === "transfer" &&
          (line.direction === "out"
            ? transaction.accountId === accountId && sameAmount(transaction, amount, currency)
            : // SUPUESTO (T28): the arriving leg of a transfer between currencies isn't stored as such, so only the same currency matches.
              transaction.destinationAccountId === accountId && transaction.currency === currency && new Decimal(transaction.amount).eq(amount)),
      ),
    )
    if (leg) {
      used.add(leg.id)
      results[index] = { line: index, result: "skipped", reason: "transfer_leg", transactionId: leg.id }
      continue
    }
    results[index] = { line: index, result: "new", importedId: ids[index]! }
  }
  return results as LineMatch[]
}

/** A line to import, with what the person (or Claude for them) chose for it when it is new. */
export interface ImportLine extends IncomingLine {
  /** The category of the new movement; absent means "Other" of its kind. */
  categoryId?: string
  note?: string
}

export interface ImportRequest {
  accountId: string
  /** The card of that account the lines were paid with, for a card statement. */
  cardId?: string
  lines: readonly ImportLine[]
  /** Only says what would happen; saves nothing. */
  dryRun: boolean
}

export interface ImportOutcome {
  dryRun: boolean
  counts: { new: number; existing: number; skipped: number }
  lines: LineMatch[]
}

/**
 * Imports a statement's lines into one account: matches them (`matchIncoming`) and, unless `dryRun`,
 * saves each new line as a confirmed movement with its line's id, and gives the movements matched by
 * amount and date the line's id, changing nothing else on them. Every new line is checked first (also
 * in a dry run), so a refused line refuses the whole import before anything is saved.
 */
export async function importTransactions(store: LedgerStore, request: ImportRequest): Promise<ImportOutcome> {
  if (request.lines.length > MAX_IMPORT_LINES) throw DomainError.corruptedData(`more than ${MAX_IMPORT_LINES} lines`)
  const context = await getTransactionContext(store)
  const zone = context.zone
  if (!context.accounts.some((account) => account.id === request.accountId)) throw DomainError.notFound(request.accountId)
  if (request.cardId !== undefined && !context.cards.some((card) => card.id === request.cardId && card.accountId === request.accountId)) {
    throw DomainError.notFound(request.cardId)
  }
  const source: PaymentSource = request.cardId ? { type: "card", id: request.cardId } : { type: "account", id: request.accountId }
  const matches = matchIncoming(request.accountId, request.lines, context.transactions, { timeZone: zone })
  const ids = importedLineIds(request.accountId, request.lines)

  const created: Transaction[] = []
  const marked: Transaction[] = []
  for (const match of matches) {
    const line = request.lines[match.line]!
    if (match.result === "new") {
      const kind: TransactionKind = line.direction === "out" ? "expense" : "income"
      const id = importedTransactionId(request.accountId, match.importedId)
      const draft: TransactionDraft = {
        id,
        kind,
        amount: new Decimal(line.amount),
        currency: line.currency.toUpperCase(),
        categoryId: line.categoryId ?? otherCategoryId(kind),
        source,
        description: line.description,
        date: checkedDay(line.day, zone),
        note: line.note ?? "",
        isDraft: false,
        importedId: match.importedId,
      }
      created.push(validatedTransaction(draft, context, context.transactions.find((transaction) => transaction.id === id)))
    } else if (match.result === "existing" && match.by === "amount_date") {
      const transaction = context.transactions.find((candidate) => candidate.id === match.transactionId)!
      marked.push({ ...transaction, importedId: ids[match.line]! })
    }
  }
  if (!request.dryRun) for (const transaction of [...created, ...marked]) await store.saveTransaction(transaction)

  const count = (result: LineMatch["result"]) => matches.filter((match) => match.result === result).length
  return { dryRun: request.dryRun, counts: { new: count("new"), existing: count("existing"), skipped: count("skipped") }, lines: matches }
}
