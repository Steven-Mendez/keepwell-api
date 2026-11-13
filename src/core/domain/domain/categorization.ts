import { newID } from "../schema/id"
import type { CategorizationRule, Merchant, Transaction, TransactionCategory, TransactionKind } from "../schema"
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

/**
 * The movement in the rule's category, with the rule's tags after its own and the rule's merchant
 * when it names none yet (one the person picked stays). The rule's merchant is set only when it is
 * one of `merchants` (the alive ones: a rule may still name one deleted elsewhere until the repair
 * after a pull) and `mayLinkMerchant` (`false` when the person cleared the business on purpose: a
 * draft's `merchantId: null` is never overridden by a rule).
 */
export function applyingRule(rule: CategorizationRule, transaction: Transaction, merchants: readonly Pick<Merchant, "id">[], mayLinkMerchant = true): Transaction {
  const { tags: _previous, ...rest } = transaction
  const ruleMerchant = rule.merchantId
  const links =
    mayLinkMerchant && ruleMerchant !== undefined && transaction.merchantId === undefined && merchants.some((merchant) => merchant.id === ruleMerchant)
  const merchant = links ? { merchantId: ruleMerchant } : {}
  const applied: Transaction = { ...rest, categoryId: rule.categoryId, ...merchant, ...tagsField(mergeTags(transaction.tags ?? [], rule.tags ?? [])) }
  // The platform is never the business itself.
  if (applied.viaMerchantId !== undefined && applied.viaMerchantId === applied.merchantId) delete applied.viaMerchantId
  return applied
}

/** The rule that would categorize this movement: none unless it is uncategorized, otherwise the first that matches. */
export function categorizingRule(
  transaction: Pick<Transaction, "kind" | "categoryId" | "description" | "note">,
  rules: readonly CategorizationRule[],
): CategorizationRule | undefined {
  if (!isUncategorized(transaction)) return undefined
  return firstMatchingRule(rules, transaction.kind, transaction.description, transaction.note)
}

/** A new uncategorized movement takes the first rule that matches; otherwise it stays as it is. */
export function autoCategorized(transaction: Transaction, rules: readonly CategorizationRule[], merchants: readonly Pick<Merchant, "id">[]): Transaction {
  const rule = categorizingRule(transaction, rules)
  return rule ? applyingRule(rule, transaction, merchants) : transaction
}

/** The rules saving may apply: those whose category still exists with the rule's kind, in the same order. */
export function usableRules(rules: readonly CategorizationRule[], categories: readonly TransactionCategory[]): CategorizationRule[] {
  return rules.filter((rule) => categories.some((category) => category.id === rule.categoryId && category.kind === rule.kind))
}

/** What the rule editor hands over; `id` absent for a new rule. */
export interface CategorizationRuleDraft {
  id?: string
  match: string
  categoryId: string
  kind: TransactionKind
  tags?: string[]
  /** The business the rule sets on the movements it matches; absent for none. */
  merchantId?: string
}

/** The rule as saving stores it: text trimmed and cut, expense or income only, a category of that kind that exists. */
export function validatedRule(draft: CategorizationRuleDraft & { id: string }, categories: readonly TransactionCategory[]): CategorizationRule {
  const match = [...draft.match.trim()].slice(0, MAX_RULE_MATCH_LENGTH).join("").trim()
  if (match === "") throw DomainError.missingName()
  if (draft.kind === "transfer") throw DomainError.unsupportedTransactionKind("transfer")
  const category = categories.find((candidate) => candidate.id === draft.categoryId)
  if (!category) throw DomainError.notFound(draft.categoryId)
  if (category.kind !== draft.kind) throw DomainError.categoryKindMismatch(draft.kind, category.kind)
  return { id: draft.id, match, categoryId: draft.categoryId, kind: draft.kind, ...tagsField(draft.tags), ...(draft.merchantId === undefined ? {} : { merchantId: draft.merchantId }) }
}

export async function fetchCategorizationRules(store: LedgerStore): Promise<CategorizationRule[]> {
  return store.fetchCategorizationRules()
}

export async function saveCategorizationRule(store: LedgerStore, draft: CategorizationRuleDraft): Promise<CategorizationRule> {
  if (draft.id !== undefined && !(await store.fetchCategorizationRules()).some((rule) => rule.id === draft.id)) throw DomainError.notFound(draft.id)
  const rule = validatedRule({ ...draft, id: draft.id ?? newID() }, await store.fetchCategories())
  if (rule.merchantId !== undefined && !(await store.fetchMerchants()).some((merchant) => merchant.id === rule.merchantId)) throw DomainError.notFound(rule.merchantId)
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
    const merchants = await store.fetchMerchants()
    for (const transaction of matches) await store.saveTransaction(applyingRule(rule, transaction, merchants))
    return matches.length
  })
}
