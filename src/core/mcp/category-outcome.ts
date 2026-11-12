import type { Ledger } from "../domain/domain"
import type { CategorizationRule, Transaction } from "../domain/schema"

/**
 * The category a new movement ended in, and the categorization rule that chose it when one did, so
 * the assistant can tell the person.
 */
export function categoryOutcome(ledger: Pick<Ledger, "categories">, transaction: Transaction, rule: CategorizationRule | undefined) {
  if (transaction.categoryId === undefined) return {}
  return {
    category_id: transaction.categoryId,
    category: ledger.categories.find((category) => category.id === transaction.categoryId)?.name ?? null,
    ...(rule ? { categorized_by_rule: { id: rule.id, match: rule.match } } : {}),
  }
}
