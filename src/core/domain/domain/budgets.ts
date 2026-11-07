import type { TransactionCategory } from "../schema"

import { Decimal, ZERO, dec } from "./decimal"
import type { MonthlySummary } from "./rules"

// Port of the iOS budget rules: one status per budgeted expense category for a month's summary.

/** Where "close to the budget" starts; at or past 1 the budget is spent. */
export const BUDGET_WARNING_RATIO = dec("0.8")

export type BudgetLevel = "onTrack" | "nearLimit" | "exceeded"

export interface BudgetStatus {
  categoryId: string
  /** Confirmed spending in the month, in the summary's (principal) currency. */
  spent: Decimal
  budget: Decimal
  /** `spent / budget`; past 1 when over. */
  ratio: Decimal
  level: BudgetLevel
}

export function budgetLevel(ratio: Decimal): BudgetLevel {
  if (ratio.gte(1)) return "exceeded"
  if (ratio.gte(BUDGET_WARNING_RATIO)) return "nearLimit"
  return "onTrack"
}

/**
 * Each expense category with a budget in the summary's currency, fullest first. A budget set in
 * another currency (the principal changed since) is skipped rather than converted at today's rate.
 */
export function budgetStatuses(
  summary: Pick<MonthlySummary, "currency" | "categories">,
  categories: readonly TransactionCategory[],
): BudgetStatus[] {
  const spentById = new Map(summary.categories.map((total) => [total.categoryId, total.amount]))
  const statuses: BudgetStatus[] = []
  for (const category of categories) {
    const budget = category.monthlyBudget
    if (category.kind !== "expense" || !budget || budget.currency !== summary.currency) continue
    const amount = dec(budget.amount)
    if (amount.lte(0)) continue
    const spent = spentById.get(category.id) ?? ZERO
    const ratio = spent.div(amount)
    statuses.push({ categoryId: category.id, spent, budget: amount, ratio, level: budgetLevel(ratio) })
  }
  return statuses.sort((a, b) =>
    a.ratio.eq(b.ratio) ? (a.categoryId < b.categoryId ? -1 : 1) : b.ratio.cmp(a.ratio),
  )
}
