import { newID } from "../schema/id"
import type { CategorizationRule, Transaction, TransactionCategory, TransactionKind } from "../schema"
import { MAX_RULE_MATCH_LENGTH, OTHER_EXPENSE_ID, OTHER_INCOME_ID } from "../schema"

import { DomainError } from "./errors"
import { folded } from "./rules"
import type { LedgerStore } from "./store"
import { mergeTags, tagsField } from "./tags"

// Port of iOS `CategorizationRule`, `CategorizationRules` and `ManageCategorizationRulesUseCase`
// ("if it says Uber → Transport"). Rules are ordered and the first that matches wins.

/** Whether a movement of this kind with this description and note falls under the rule. */
export function ruleMatches(rule: Pick<CategorizationRule, "match" | "kind">, kind: TransactionKind, description: string, note: string | undefined): boolean {
  const needle = folded(rule.match.trim())
  if (kind !== rule.kind || needle === "") return false
  return [description, note ?? ""].some((text) => folded(text).includes(needle))
}

/** The first rule, in the person's order, that a movement with this text falls under. */
export function firstMatchingRule(rules: readonly CategorizationRule[], kind: TransactionKind, description: string, note: string | undefined): CategorizationRule | undefined {
  return rules.find((rule) => ruleMatches(rule, kind, description, note))
}

/** No category, or the catch-all "Other" of its kind. Only those are filled by a rule after the fact. */
export function isUncategorized(transaction: Pick<Transaction, "kind" | "categoryId">): boolean {
  if (transaction.kind === "transfer") return false
  const other = transaction.kind === "income" ? OTHER_INCOME_ID : OTHER_EXPENSE_ID
  return transaction.categoryId === undefined || transaction.categoryId === other
}

/** The movements "Apply to past movements" changes: uncategorized ones the rule matches, not already in its category. */
export function pastMatches(rule: CategorizationRule, transactions: readonly Transaction[]): Transaction[] {
  return transactions.filter(
    (transaction) => isUncategorized(transaction) && transaction.categoryId !== rule.categoryId && ruleMatches(rule, transaction.kind, transaction.description, transaction.note),
  )
}

/** The movement in the rule's category, with the rule's tags after its own. */
export function applyingRule(rule: CategorizationRule, transaction: Transaction): Transaction {
  const { tags: _previous, ...rest } = transaction
  return { ...rest, categoryId: rule.categoryId, ...tagsField(mergeTags(transaction.tags ?? [], rule.tags ?? [])) }
}

/** What the rule editor hands over; `id` absent for a new rule. */
export interface CategorizationRuleDraft {
  id?: string
  match: string
  categoryId: string
  kind: TransactionKind
  tags?: string[]
}

/** The rule as saving stores it: text trimmed and cut, expense or income only, a category of that kind that exists. */
export function validatedRule(draft: CategorizationRuleDraft & { id: string }, categories: readonly TransactionCategory[]): CategorizationRule {
  const match = [...draft.match.trim()].slice(0, MAX_RULE_MATCH_LENGTH).join("").trim()
  if (match === "") throw DomainError.missingName()
  if (draft.kind === "transfer") throw DomainError.unsupportedTransactionKind("transfer")
  const category = categories.find((candidate) => candidate.id === draft.categoryId)
  if (!category) throw DomainError.notFound(draft.categoryId)
  if (category.kind !== draft.kind) throw DomainError.categoryKindMismatch(draft.kind, category.kind)
  return { id: draft.id, match, categoryId: draft.categoryId, kind: draft.kind, ...tagsField(draft.tags) }
}

export async function fetchCategorizationRules(store: LedgerStore): Promise<CategorizationRule[]> {
  return store.fetchCategorizationRules()
}

export async function saveCategorizationRule(store: LedgerStore, draft: CategorizationRuleDraft): Promise<CategorizationRule> {
  if (draft.id !== undefined && !(await store.fetchCategorizationRules()).some((rule) => rule.id === draft.id)) throw DomainError.notFound(draft.id)
  const rule = validatedRule({ ...draft, id: draft.id ?? newID() }, await store.fetchCategories())
  await store.saveCategorizationRule(rule)
  return rule
}

export async function deleteCategorizationRule(store: LedgerStore, id: string): Promise<void> {
  await store.deleteCategorizationRule(id)
}

export async function reorderCategorizationRules(store: LedgerStore, ids: readonly string[]): Promise<void> {
  await store.reorderCategorizationRules(ids)
}

/** How many existing movements "Apply to past movements" would change, for its confirmation. */
export async function pastMatchCount(store: LedgerStore, rule: CategorizationRule): Promise<number> {
  return pastMatches(rule, await store.fetchTransactions()).length
}

/** Recategorizes the uncategorized movements the rule matches, all or none. Returns how many changed. */
export async function applyRuleToPast(store: LedgerStore, rule: CategorizationRule): Promise<number> {
  return store.atomically(async () => {
    const matches = pastMatches(rule, await store.fetchTransactions())
    for (const transaction of matches) await store.saveTransaction(applyingRule(rule, transaction))
    return matches.length
  })
}
