import { newID, occurrenceId } from "../schema/id"
import type { CurrencySettings, RecurringFrequency, RecurringRule, Transaction } from "../schema"
import { MAX_RECURRING_INTERVAL } from "../schema"

import { addDays, dayKey, daysInMonth, startOfDay, zonedDate, zonedParts, type TimeZone } from "./calendar"
import { Decimal, ZERO, dec, decimalText } from "./decimal"
import { DomainError } from "./errors"
import { convert, settingsRate, type Money } from "./money"
import { accountIdFor, getTransactionContext, saveTransaction, validatedTransaction, type PaymentSource, type SavedTransaction, type TransactionContext, type TransactionDraft } from "./movements"
import { SUBSCRIPTIONS_CATEGORY_ID, checkAmounts } from "./rules"
import type { LedgerStore } from "./store"
import { tagsField } from "./tags"

// Recurring movements and subscriptions: the shared iOS/web contract (RecurringRule, its schedule,
// materializing what's due, and the totals the Recurring screen shows).

/** No flood after months away: a run creates at most this many movements per rule, the latest ones. */
export const MAX_MATERIALIZED_PER_RULE = 12

type Schedule = Pick<RecurringRule, "frequency" | "interval" | "startDate">

/** Foundation `Calendar.date(byAdding: .month)`: the day clamps to the target month's last day, time kept. */
function addCalendarMonths(date: Date, months: number, zone: TimeZone): Date {
  const parts = zonedParts(date, zone)
  const index = parts.year * 12 + (parts.month - 1) + months
  const year = Math.floor(index / 12)
  const month = index - year * 12 + 1
  const day = Math.min(parts.day, daysInMonth({ year, month }))
  return zonedDate(zone, year, month, day, parts.hour, parts.minute, parts.second, parts.millisecond)
}

/**
 * The `n`-th occurrence (0 is `startDate`), always computed from the anchor: Jan 31 + 1 month is
 * Feb 28/29 and + 2 months is Mar 31, never chained from a clamped date. Weekly is 7 calendar days.
 */
export function occurrence(rule: Schedule, n: number, zone: TimeZone): Date {
  const start = new Date(rule.startDate)
  const steps = n * rule.interval
  switch (rule.frequency) {
    case "weekly":
      return addDays(start, 7 * steps, zone)
    case "monthly":
      return addCalendarMonths(start, steps, zone)
    case "yearly":
      return addCalendarMonths(start, 12 * steps, zone)
  }
}

function checkInterval(interval: number): void {
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_RECURRING_INTERVAL) throw DomainError.invalidInterval(interval)
}

const isBeforeDay = (a: Date, b: Date, zone: TimeZone) => dayKey(a, zone) < dayKey(b, zone)
const isAfterDay = (a: Date, b: Date, zone: TimeZone) => dayKey(a, zone) > dayKey(b, zone)

/** The index of the smallest occurrence whose calendar day is on or after `day`'s. */
function firstIndexOnOrAfter(rule: Schedule, day: Date, zone: TimeZone): number {
  checkInterval(rule.interval)
  const start = new Date(rule.startDate)
  if (Number.isNaN(start.getTime()) || Number.isNaN(day.getTime())) throw DomainError.corruptedData("date")
  // A guess known to fall before `day`, so only a few steps are left to walk.
  let n: number
  if (rule.frequency === "weekly") {
    const days = Math.round((startOfDay(day, zone).getTime() - startOfDay(start, zone).getTime()) / 86_400_000)
    n = Math.floor(days / (7 * rule.interval)) - 1
  } else {
    const [to, from] = [zonedParts(day, zone), zonedParts(start, zone)]
    const months = to.year * 12 + to.month - (from.year * 12 + from.month)
    n = Math.floor(months / (rule.interval * (rule.frequency === "yearly" ? 12 : 1))) - 1
  }
  n = Math.max(0, n)
  while (isBeforeDay(occurrence(rule, n, zone), day, zone)) n++
  return n
}

/** The smallest occurrence whose calendar day is on or after `day`'s. */
export function firstOccurrence(rule: Schedule, onOrAfter: Date, zone: TimeZone): Date {
  return occurrence(rule, firstIndexOnOrAfter(rule, onOrAfter, zone), zone)
}

/** Whether `date` falls after the rule's last day. */
function isPastEnd(rule: Pick<RecurringRule, "endDate">, date: Date, zone: TimeZone): boolean {
  return rule.endDate !== undefined && isAfterDay(date, new Date(rule.endDate), zone)
}

/** A rule whose next occurrence is past its end: it will never produce anything again. */
export function isFinished(rule: RecurringRule, zone: TimeZone): boolean {
  return isPastEnd(rule, new Date(rule.nextDate), zone)
}

/** Producing movements: not paused and not past its end. */
export function isActive(rule: RecurringRule, zone: TimeZone): boolean {
  return !rule.isPaused && !isFinished(rule, zone)
}

interface Occurrence {
  index: number
  date: Date
}

function dueOccurrences(rule: RecurringRule, today: Date, zone: TimeZone): Occurrence[] {
  if (rule.isPaused) return []
  const due: Occurrence[] = []
  for (let index = firstIndexOnOrAfter(rule, new Date(rule.nextDate), zone); ; index++) {
    const date = occurrence(rule, index, zone)
    if (isAfterDay(date, today, zone) || isPastEnd(rule, date, zone)) break
    due.push({ index, date })
  }
  return due
}

/** Occurrences from `nextDate` on whose day is today or earlier, not after `endDate`. Empty when paused. */
export function due(rule: RecurringRule, today: Date, zone: TimeZone): Date[] {
  return dueOccurrences(rule, today, zone).map((entry) => entry.date)
}

/** The movement an occurrence produces, through the same validation as a movement typed by hand. */
export function sourceOf(rule: Pick<RecurringRule, "cardId" | "accountId">): PaymentSource {
  return rule.cardId ? { type: "card", id: rule.cardId } : { type: "account", id: rule.accountId }
}

function occurrenceDraft(rule: RecurringRule, date: Date, id: string = newID()): TransactionDraft {
  return {
    id,
    kind: rule.kind,
    amount: dec(rule.amount),
    currency: rule.currency,
    ...(rule.categoryId === undefined ? {} : { categoryId: rule.categoryId }),
    source: sourceOf(rule),
    ...(rule.destinationAccountId === undefined ? {} : { destinationAccountId: rule.destinationAccountId }),
    description: rule.name,
    date,
    note: rule.note ?? "",
    isDraft: !rule.autoConfirm,
    ...(rule.tags ? { tags: [...rule.tags] } : {}),
  }
}

/**
 * The movement for one occurrence: today's settings rate, not shared, confirmed or a draft. Its id is
 * derived from the rule, its schedule and the occurrence index, so two devices (or the server)
 * producing the same occurrence produce the same row.
 */
export function occurrenceTransaction(rule: RecurringRule, date: Date, context: TransactionContext, index?: number): Transaction {
  const id = index === undefined ? newID() : occurrenceId(rule, index)
  return {
    ...validatedTransaction(occurrenceDraft(rule, date, id), context),
    recurringId: rule.id,
  }
}

const occurrenceKey = (ruleId: string, date: Date, zone: TimeZone) => `${ruleId} ${dayKey(date, zone)}`

/**
 * Saves the movements every active rule owes up to today (at most the latest 12 per rule), skipping
 * an occurrence that already has a movement from the rule that day, and moves each rule's `nextDate`
 * past what it produced. One atomic save; reads happen inside it so two runs (two tabs, load and
 * focus) can't both create the same movement. A rule that no longer validates (its category or
 * currency is gone) is left as it was. Returns the movements created.
 */
export async function materializeRecurring(store: LedgerStore, today: Date = new Date()): Promise<Transaction[]> {
  return store.atomically(async () => {
    const zone = store.timeZone
    const rules = await store.fetchRecurringRules()
    if (!rules.some((rule) => dueOccurrences(rule, today, zone).length > 0)) return []
    const context = await getTransactionContext(store)
    const existing = new Set(context.transactions.flatMap((transaction) => (transaction.recurringId ? [occurrenceKey(transaction.recurringId, new Date(transaction.date), zone)] : [])))
    const knownIds = new Set(context.transactions.map((transaction) => transaction.id))
    const created: Transaction[] = []
    const advanced: RecurringRule[] = []
    for (const rule of rules) {
      const owed = dueOccurrences(rule, today, zone)
      const last = owed.at(-1)
      if (!last) continue
      try {
        const movements = owed
          .slice(-MAX_MATERIALIZED_PER_RULE)
          .filter((entry) => !existing.has(occurrenceKey(rule.id, entry.date, zone)) && !knownIds.has(occurrenceId(rule, entry.index)))
          .map((entry) => occurrenceTransaction(rule, entry.date, context, entry.index))
        for (const movement of movements) existing.add(occurrenceKey(rule.id, new Date(movement.date), zone))
        created.push(...movements)
      } catch {
        continue
      }
      advanced.push({ ...rule, nextDate: occurrence(rule, last.index + 1, zone).toISOString() })
    }
    for (const movement of created) await store.saveTransaction(movement)
    for (const rule of advanced) await store.saveRecurringRule(rule)
    return created
  })
}

// Creating, editing, pausing and deleting rules.

/** What the rule editor saves; `id` edits that rule. */
export interface RecurringRuleDraft {
  id?: string
  name: string
  kind: RecurringRule["kind"]
  amount: Decimal
  currency: string
  categoryId?: string
  source?: PaymentSource
  destinationAccountId?: string
  frequency: RecurringFrequency
  interval: number
  startDate: Date
  endDate?: Date
  isSubscription: boolean
  autoConfirm: boolean
  note: string
  /** Left out keeps an edited rule's tags as they were. */
  tags?: string[]
}

/**
 * Checks a rule like a movement typed by hand (amount, currency, method, category or destination)
 * plus its own fields: a name, an interval of 1…99 and an end no earlier than the start.
 */
export function checkRecurringRule(rule: RecurringRule, context: TransactionContext): void {
  if (rule.name.trim() === "") throw DomainError.missingName()
  checkAmounts(dec(rule.amount))
  checkInterval(rule.interval)
  if (rule.endDate !== undefined && isBeforeDay(new Date(rule.endDate), new Date(rule.startDate), context.zone)) throw DomainError.invalidEndDate()
  validatedTransaction(occurrenceDraft(rule, new Date(rule.startDate)), context)
}

const sameSchedule = (a: Schedule, b: Schedule) => a.startDate === b.startDate && a.frequency === b.frequency && a.interval === b.interval

const laterOf = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b)

/**
 * Saves a new rule or edits one. A new rule, or one whose start, frequency or interval changed, next
 * falls on the first occurrence on or after the later of today and its start; movements already
 * produced stay as they are. Then whatever is due is produced.
 */
export async function saveRecurringRule(store: LedgerStore, draft: RecurringRuleDraft, today: Date = new Date()): Promise<RecurringRule> {
  checkInterval(draft.interval)
  const context = await getTransactionContext(store)
  const existing = draft.id ? (await store.fetchRecurringRules()).find((rule) => rule.id === draft.id) : undefined
  if (draft.id && !existing) throw DomainError.notFound(draft.id)
  const accountId = draft.source ? accountIdFor(context, draft.source) : undefined
  if (!draft.source || !accountId) throw DomainError.notFound("source")
  const note = draft.note.trim()
  const schedule: Schedule = { frequency: draft.frequency, interval: draft.interval, startDate: draft.startDate.toISOString() }
  const nextDate = existing && sameSchedule(existing, schedule) ? existing.nextDate : firstNextDate(schedule, context.zone, today).toISOString()
  const rule: RecurringRule = {
    id: existing?.id ?? newID(),
    name: draft.name.trim(),
    kind: draft.kind,
    ...(draft.kind === "transfer" || draft.categoryId === undefined ? {} : { categoryId: draft.categoryId }),
    amount: decimalText(draft.amount),
    currency: draft.currency,
    accountId,
    ...(draft.source.type === "card" ? { cardId: draft.source.id } : {}),
    ...(draft.kind === "transfer" && draft.destinationAccountId ? { destinationAccountId: draft.destinationAccountId } : {}),
    ...schedule,
    nextDate,
    ...(draft.endDate ? { endDate: draft.endDate.toISOString() } : {}),
    // Only an expense can be a subscription (iOS).
    isSubscription: draft.kind === "expense" && draft.isSubscription,
    autoConfirm: draft.autoConfirm,
    isPaused: existing?.isPaused ?? false,
    ...(note === "" ? {} : { note }),
    ...tagsField(draft.tags ?? existing?.tags),
    ...(existing?.source ? { source: existing.source } : {}),
  }
  checkRecurringRule(rule, context)
  await store.saveRecurringRule(rule)
  await materializeRecurring(store, today)
  return rule
}

/** Pausing freezes `nextDate`; resuming starts again today, without back-filling the skipped period. */
export async function setRecurringRulePaused(store: LedgerStore, id: string, paused: boolean, today: Date = new Date()): Promise<void> {
  const rule = (await store.fetchRecurringRules()).find((candidate) => candidate.id === id)
  if (!rule) throw DomainError.notFound(id)
  if (rule.isPaused === paused) return
  await store.saveRecurringRule(paused ? { ...rule, isPaused: true } : { ...rule, isPaused: false, nextDate: firstOccurrence(rule, today, store.timeZone).toISOString() })
  if (!paused) await materializeRecurring(store, today)
}

/** Deletes the rule and the drafts it left waiting; confirmed movements stay. */
export async function deleteRecurringRule(store: LedgerStore, id: string): Promise<void> {
  if (!(await store.fetchRecurringRules()).some((rule) => rule.id === id)) throw DomainError.notFound(id)
  await store.atomically(async () => {
    for (const movement of await store.fetchTransactions()) {
      if (movement.recurringId === id && movement.status === "planned") await store.deleteTransaction(movement.id)
    }
    await store.deleteRecurringRule(id)
  })
}

/**
 * "Repeat" on a new movement: the rule it starts, anchored on its date, its next occurrence the one
 * after it. A subscription when its category is Subscriptions; occurrences wait as drafts.
 */
export function ruleRepeating(transaction: Transaction, frequency: RecurringFrequency, zone: TimeZone, id: string = newID()): RecurringRule {
  const schedule: Schedule = { frequency, interval: 1, startDate: transaction.date }
  return {
    id,
    name: transaction.description,
    kind: transaction.kind,
    ...(transaction.categoryId === undefined ? {} : { categoryId: transaction.categoryId }),
    amount: transaction.amount,
    currency: transaction.currency,
    accountId: transaction.accountId,
    ...(transaction.cardId === undefined ? {} : { cardId: transaction.cardId }),
    ...(transaction.destinationAccountId === undefined ? {} : { destinationAccountId: transaction.destinationAccountId }),
    ...schedule,
    nextDate: occurrence(schedule, 1, zone).toISOString(),
    isSubscription: transaction.categoryId === SUBSCRIPTIONS_CATEGORY_ID,
    autoConfirm: false,
    isPaused: false,
    ...(transaction.note === undefined ? {} : { note: transaction.note }),
    ...tagsField(transaction.tags),
  }
}

/** Saves a new movement with "Repeat" on: the movement, linked to the rule it starts, and the rule. */
export async function saveRepeatingTransaction(store: LedgerStore, draft: TransactionDraft, frequency: RecurringFrequency, today: Date = new Date()): Promise<SavedTransaction> {
  const ruleId = newID()
  const saved = await store.atomically(async () => {
    const result = await saveTransaction(store, { ...draft, recurringId: ruleId })
    await store.saveRecurringRule(ruleRepeating(result.transaction, frequency, store.timeZone, ruleId))
    return result
  })
  await materializeRecurring(store, today)
  return saved
}

// Totals and what's coming.

/** What a rule costs per month, for totals only (rounded only for display). */
export function monthlyEquivalent(rule: Pick<RecurringRule, "amount" | "frequency" | "interval">): Decimal {
  const amount = dec(rule.amount)
  switch (rule.frequency) {
    case "monthly":
      return amount.div(rule.interval)
    case "weekly":
      return amount.times(52).div(12).div(rule.interval)
    case "yearly":
      return amount.div(12 * rule.interval)
  }
}

/** Active expense subscriptions in one currency the settings can't convert, so no total counts them. */
export interface UnconvertedSubscriptions {
  currency: string
  count: number
}

export interface SubscriptionsTotal {
  perMonth: Money
  /** By currency code; empty when every active subscription is counted. */
  excluded: UnconvertedSubscriptions[]
}

/**
 * Active expense subscriptions per month, in the principal currency at today's settings rate. A rule
 * in a currency the settings no longer convert is left out rather than mixed in, and reported in
 * `excluded` so the screen can say the total is incomplete.
 */
export function subscriptionsTotal(rules: readonly RecurringRule[], currencies: CurrencySettings, zone: TimeZone): SubscriptionsTotal {
  const rate = settingsRate(currencies)
  let total = ZERO
  const excluded = new Map<string, number>()
  for (const rule of rules) {
    if (!rule.isSubscription || rule.kind !== "expense" || !isActive(rule, zone)) continue
    try {
      total = total.plus(convert({ amount: monthlyEquivalent(rule), currency: rule.currency }, rate, currencies.principal).amount)
    } catch {
      excluded.set(rule.currency, (excluded.get(rule.currency) ?? 0) + 1)
    }
  }
  return {
    perMonth: { amount: total, currency: currencies.principal },
    excluded: [...excluded].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, count]) => ({ currency, count })),
  }
}

/** `subscriptionsTotal` without the subscriptions it left out. */
export function subscriptionsPerMonth(rules: readonly RecurringRule[], currencies: CurrencySettings, zone: TimeZone): Money {
  return subscriptionsTotal(rules, currencies, zone).perMonth
}

export interface UpcomingOccurrence {
  rule: RecurringRule
  date: Date
}

/** Occurrences not produced yet from today through `days` days ahead, soonest first. */
export function upcoming(rules: readonly RecurringRule[], from: Date, days: number, zone: TimeZone): UpcomingOccurrence[] {
  const last = addDays(startOfDay(from, zone), days, zone)
  const found: UpcomingOccurrence[] = []
  for (const rule of rules) {
    if (rule.isPaused) continue
    const next = new Date(rule.nextDate)
    for (let index = firstIndexOnOrAfter(rule, laterOf(next, from), zone); ; index++) {
      const date = occurrence(rule, index, zone)
      if (isAfterDay(date, last, zone) || isPastEnd(rule, date, zone)) break
      found.push({ rule, date })
    }
  }
  return found.sort((a, b) => a.date.getTime() - b.date.getTime() || (a.rule.name < b.rule.name ? -1 : 1))
}

/**
 * Occurrences not recorded yet, from `nextDate` through `lastDay`'s calendar day, none after the end
 * (iOS `RecurringSchedule.pending`). Paused rules have none. The balance forecast counts these on
 * top of the drafts already recorded, so nothing is counted twice.
 */
export function pendingOccurrences(rule: RecurringRule, lastDay: Date, zone: TimeZone): Date[] {
  if (rule.isPaused) return []
  const dates: Date[] = []
  for (let index = firstIndexOnOrAfter(rule, new Date(rule.nextDate), zone); ; index++) {
    const date = occurrence(rule, index, zone)
    if (isAfterDay(date, lastDay, zone) || isPastEnd(rule, date, zone)) break
    dates.push(date)
  }
  return dates
}

/** The next occurrence a rule will produce, if it ever will. */
export function nextOccurrenceOf(rule: RecurringRule, zone: TimeZone): Date | undefined {
  return isFinished(rule, zone) ? undefined : new Date(rule.nextDate)
}

export interface PendingRuleDraft {
  /** The draft the rule left waiting, dated today or before. */
  transaction: Transaction
  /** Calendar days from its date to today: 0 when it's today's. */
  daysOverdue: number
}

/**
 * The draft a rule left waiting to be confirmed (`recurringId` the rule's, still `planned`) whose
 * calendar day is today or earlier: the oldest one, since that's the one most overdue. A draft for
 * a later day isn't due yet. The Recurring row shows it in place of the next date.
 */
export function pendingDraftOf(rule: Pick<RecurringRule, "id">, transactions: readonly Transaction[], today: Date, zone: TimeZone): PendingRuleDraft | undefined {
  const todayKey = dayKey(today, zone)
  let oldest: Transaction | undefined
  for (const transaction of transactions) {
    if (transaction.recurringId !== rule.id || transaction.status !== "planned") continue
    const date = new Date(transaction.date)
    if (dayKey(date, zone) > todayKey) continue
    if (!oldest || date.getTime() < new Date(oldest.date).getTime() || (date.getTime() === new Date(oldest.date).getTime() && transaction.id < oldest.id)) oldest = transaction
  }
  if (!oldest) return undefined
  // Rounded: a day across a daylight-saving change is 23 or 25 hours long.
  const daysOverdue = Math.round((startOfDay(today, zone).getTime() - startOfDay(new Date(oldest.date), zone).getTime()) / 86_400_000)
  return { transaction: oldest, daysOverdue }
}

/** The first `count` occurrences on or after `from`, within the rule's end. */
export function occurrencesFrom(rule: Schedule & Pick<RecurringRule, "endDate">, from: Date, count: number, zone: TimeZone): Date[] {
  const dates: Date[] = []
  for (let index = firstIndexOnOrAfter(rule, from, zone); dates.length < count; index++) {
    const date = occurrence(rule, index, zone)
    if (isPastEnd(rule, date, zone)) break
    dates.push(date)
  }
  return dates
}

/** The next `count` occurrences the rule will produce, from `nextDate`. */
export function nextOccurrences(rule: RecurringRule, count: number, zone: TimeZone): Date[] {
  return occurrencesFrom(rule, new Date(rule.nextDate), count, zone)
}

/** Where a new rule (or one whose schedule changed) starts producing: the later of today and its start. */
export function firstNextDate(rule: Schedule, zone: TimeZone, today: Date = new Date()): Date {
  return firstOccurrence(rule, laterOf(today, new Date(rule.startDate)), zone)
}

export type RecurringSectionKind = "subscriptions" | "bills" | "income" | "transfers"
export const RECURRING_SECTIONS: readonly RecurringSectionKind[] = ["subscriptions", "bills", "income", "transfers"]

export function recurringSectionOf(rule: RecurringRule): RecurringSectionKind {
  if (rule.isSubscription) return "subscriptions"
  if (rule.kind === "expense") return "bills"
  return rule.kind === "income" ? "income" : "transfers"
}

export interface RecurringOverview {
  /** Expense subscriptions per month, principal currency. */
  subscriptionsPerMonth: Money
  subscriptionsPerYear: Money
  /** Active subscriptions neither total counts, because their currency can't be converted. */
  excludedSubscriptions: UnconvertedSubscriptions[]
  /** Non-empty sections in screen order; active rules by next date, then paused and finished ones. */
  sections: { kind: RecurringSectionKind; rules: RecurringRule[] }[]
}

export function recurringOverview(rules: readonly RecurringRule[], currencies: CurrencySettings, zone: TimeZone): RecurringOverview {
  const { perMonth, excluded } = subscriptionsTotal(rules, currencies, zone)
  const ordered = [...rules].sort((a, b) => Number(!isActive(a, zone)) - Number(!isActive(b, zone)) || (a.nextDate < b.nextDate ? -1 : a.nextDate > b.nextDate ? 1 : a.name.localeCompare(b.name)))
  return {
    subscriptionsPerMonth: perMonth,
    subscriptionsPerYear: { amount: perMonth.amount.times(12), currency: perMonth.currency },
    excludedSubscriptions: excluded,
    sections: RECURRING_SECTIONS.map((kind) => ({ kind, rules: ordered.filter((rule) => recurringSectionOf(rule) === kind) })).filter((section) => section.rules.length > 0),
  }
}
