import { newID } from "../schema/id"
import { MAX_GOAL_NAME_LENGTH, type SavingsGoal, type TargetMonth } from "../schema"

import { compareMonths, yearMonthContaining, type YearMonth } from "./calendar"
import { Decimal, ZERO, dec, decimalText } from "./decimal"
import { DomainError } from "./errors"
import type { LedgerStore } from "./store"

// Port of iOS SavingsGoals.swift: progress and the monthly amount, and the goal use cases.

export interface SavingsGoalProgress {
  saved: Decimal
  target: Decimal
  /** Never negative: a goal saved past its target has nothing left. */
  remaining: Decimal
  /** `saved / target`, past 1 when over; screens clamp it. */
  fraction: Decimal
  isReached: boolean
  /** The target month already passed with money still to go. */
  isOverdue: boolean
  /** Months from this one to the target month, both counted; absent without a date or once passed. */
  monthsLeft?: number
  /** What to set aside each month to arrive on time, rounded up to the cent. */
  monthlyAmount?: Decimal
}

function monthsBetween(from: YearMonth, to: YearMonth): number {
  return (to.year - from.year) * 12 + (to.month - from.month)
}

export function savingsGoalProgress(goal: SavingsGoal, now: Date): SavingsGoalProgress {
  const saved = dec(goal.saved)
  const target = dec(goal.target.amount)
  const remaining = Decimal.max(target.minus(saved), ZERO)
  const isReached = saved.gte(target)
  const base = { saved, target, remaining, fraction: target.gt(0) ? saved.div(target) : ZERO, isReached }
  if (!goal.targetMonth || isReached) return { ...base, isOverdue: false }
  const current = yearMonthContaining(now)
  if (compareMonths(goal.targetMonth, current) < 0) return { ...base, isOverdue: true }
  const monthsLeft = monthsBetween(current, goal.targetMonth) + 1
  const monthlyAmount = remaining.div(monthsLeft).toDecimalPlaces(2, Decimal.ROUND_CEIL)
  return { ...base, isOverdue: false, monthsLeft, monthlyAmount }
}

/** Goals still open first, the soonest deadline first and undated after; reached ones last. */
export function orderedGoals(goals: readonly SavingsGoal[], now: Date): SavingsGoal[] {
  const reached = (goal: SavingsGoal) => savingsGoalProgress(goal, now).isReached
  return [...goals].sort((a, b) => {
    const byReached = Number(reached(a)) - Number(reached(b))
    if (byReached !== 0) return byReached
    if (reached(a)) return byName(a, b)
    if (a.targetMonth && b.targetMonth) {
      const byMonth = compareMonths(a.targetMonth, b.targetMonth)
      if (byMonth !== 0) return byMonth
    } else if (a.targetMonth || b.targetMonth) {
      return a.targetMonth ? -1 : 1
    }
    return byName(a, b)
  })
}

/** Then by name, and by id so the order never flickers between equal names. */
function byName(a: SavingsGoal, b: SavingsGoal): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export interface SavingsGoalDraft {
  /** `undefined` for a new goal. */
  id?: string
  name: string
  /** Exact decimal text, > 0. */
  targetAmount: string
  /** Ignored when editing: a goal keeps the currency it was saved in. */
  currency: string
  targetMonth?: TargetMonth
  icon?: string
  color?: string
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

async function existingGoal(store: LedgerStore, id: string): Promise<SavingsGoal> {
  const goal = (await store.fetchSavingsGoals()).find((candidate) => candidate.id === id)
  if (!goal) throw DomainError.notFound(id)
  return goal
}

export async function saveSavingsGoal(store: LedgerStore, draft: SavingsGoalDraft): Promise<SavingsGoal> {
  const name = [...draft.name.trim()].slice(0, MAX_GOAL_NAME_LENGTH).join("")
  if (name === "") throw DomainError.missingName()
  const amount = positive(draft.targetAmount)
  const current = draft.id === undefined ? undefined : await existingGoal(store, draft.id)
  const currency = current?.target.currency ?? draft.currency
  if (!current) {
    const settings = await store.loadSettings()
    const allowed = [settings?.currencies.principal, settings?.currencies.second]
    if (!allowed.includes(currency)) throw DomainError.invalidCurrency(currency)
  }
  const goal: SavingsGoal = {
    id: current?.id ?? newID(),
    name,
    target: { amount: decimalText(amount), currency },
    saved: current?.saved ?? "0",
    ...(draft.targetMonth ? { targetMonth: draft.targetMonth } : {}),
    ...(draft.icon === undefined ? {} : { icon: draft.icon }),
    ...(draft.color === undefined ? {} : { color: draft.color }),
  }
  await store.saveSavingsGoal(goal)
  return goal
}

/** Sets money aside in the goal; nothing moves between accounts. */
export async function addToSavingsGoal(store: LedgerStore, id: string, amountText: string): Promise<SavingsGoal> {
  const goal = await existingGoal(store, id)
  const saved = dec(goal.saved).plus(positive(amountText))
  const updated = { ...goal, saved: decimalText(saved) }
  await store.saveSavingsGoal(updated)
  return updated
}

/** Takes money back out; never more than what's set aside. */
export async function withdrawFromSavingsGoal(store: LedgerStore, id: string, amountText: string): Promise<SavingsGoal> {
  const goal = await existingGoal(store, id)
  const amount = positive(amountText)
  const saved = dec(goal.saved)
  if (amount.gt(saved)) throw DomainError.invalidAmount()
  const updated = { ...goal, saved: decimalText(saved.minus(amount)) }
  await store.saveSavingsGoal(updated)
  return updated
}

export async function deleteSavingsGoal(store: LedgerStore, id: string): Promise<void> {
  await store.deleteSavingsGoal(id)
}
