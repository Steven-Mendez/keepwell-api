import { newID } from "./id"
import { z } from "zod"

import { Money } from "./entities"
import { TransactionKind, isPositiveDecimal } from "./primitives"

/**
 * A category. `id` is a stable slug, not a UUID: defaults share theirs on every device
 * ("groceries"), so two devices that seed them converge on one record; created ones are
 * "custom-<uuid>", so they can never collide with a default added later.
 */
export const TransactionCategory = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: TransactionKind,
  /** The symbol the person picked; defaults leave it absent and take theirs from the id. */
  icon: z.string().optional(),
  /** A key into the category palette; absent falls back to the id's own color. */
  color: z.string().optional(),
  /** A renamed default shows its name as typed instead of translating by id. */
  isRenamed: z.boolean(),
  /**
   * Monthly spending limit, expense categories only, in the principal currency it was set in. A
   * budget in another currency is kept but not compared (never converted), iOS `monthlyBudget`.
   */
  monthlyBudget: Money.refine((budget) => isPositiveDecimal(budget.amount), "Must be greater than zero").optional(),
})
export type TransactionCategory = z.infer<typeof TransactionCategory>

export function newCustomCategoryId(): string {
  return `custom-${newID()}`
}

/** Where reconciliation adjustments and the movements of a deleted category land; never deletable. */
export const OTHER_EXPENSE_ID = "other-expense"
export const OTHER_INCOME_ID = "other-income"
/** Where a loan's "Pay installment" files the expense unless the person picks another. */
export const LOAN_PAYMENTS_ID = "loan-payments"

function defaults(
  kind: TransactionKind,
  entries: ReadonlyArray<readonly [string, string]>
): TransactionCategory[] {
  return entries.map(([id, name]) => ({ id, name, kind, isRenamed: false }))
}

/** Shipped with the app, in order. Names are the English source text, translated by id on screen. */
export const DEFAULT_EXPENSE_CATEGORIES = defaults("expense", [
  ["groceries", "Groceries"],
  ["restaurants", "Restaurants"],
  ["transport", "Transport"],
  ["housing", "Housing"],
  ["utilities", "Utilities"],
  ["health", "Health"],
  ["education", "Education"],
  ["leisure", "Leisure"],
  ["shopping", "Shopping"],
  ["subscriptions", "Subscriptions"],
  ["personal-care", "Personal care"],
  ["family", "Family"],
  ["travel", "Travel"],
  ["fees", "Fees"],
  ["tools", "Tools"],
  ["pets", "Pets"],
  ["gifts", "Gifts"],
  ["insurance", "Insurance"],
  ["taxes", "Taxes"],
  ["savings", "Savings"],
  ["donations", "Donations"],
  [LOAN_PAYMENTS_ID, "Loan payments"],
  [OTHER_EXPENSE_ID, "Other"],
])

export const DEFAULT_INCOME_CATEGORIES = defaults("income", [
  ["salary", "Salary"],
  ["freelance", "Freelance"],
  ["extra", "Extra"],
  ["interest", "Interest"],
  ["investments", "Investments"],
  ["rental", "Rental"],
  ["gifts-received", "Gifts received"],
  ["refunds", "Refunds"],
  [OTHER_INCOME_ID, "Other income"],
])

export const DEFAULT_CATEGORIES: readonly TransactionCategory[] = [
  ...DEFAULT_EXPENSE_CATEGORIES,
  ...DEFAULT_INCOME_CATEGORIES,
]

export function shippedCategory(id: string): TransactionCategory | undefined {
  return DEFAULT_CATEGORIES.find((category) => category.id === id)
}

export function isFallbackCategory(id: string): boolean {
  return id === OTHER_EXPENSE_ID || id === OTHER_INCOME_ID
}

/** Per kind, in stored order, with the catch-all "Other" last (iOS `TransactionCategory.ordered`). */
export function orderedCategories(
  categories: readonly TransactionCategory[]
): TransactionCategory[] {
  return (["expense", "income", "transfer"] as const).flatMap((kind) => {
    const ofKind = categories.filter((category) => category.kind === kind)
    return [
      ...ofKind.filter((c) => !isFallbackCategory(c.id)),
      ...ofKind.filter((c) => isFallbackCategory(c.id)),
    ]
  })
}
