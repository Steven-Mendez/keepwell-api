import type { Money as StoredMoney, TransactionCategory, TransactionKind } from "../schema"
import { OTHER_EXPENSE_ID, OTHER_INCOME_ID, isFallbackCategory, newCustomCategoryId, orderedCategories, shippedCategory } from "../schema"

import { dec, decimalText } from "./decimal"
import { DomainError } from "./errors"
import { folded } from "./rules"
import type { LedgerStore } from "./store"

// Port of CategoryActions.swift.

/** Long enough for "Kids' activities", short enough to fit a grid tile. */
export const MAX_CATEGORY_NAME_LENGTH = 24

export interface CategoryDraft {
  /** `undefined` for a new category. */
  id?: string
  name: string
  kind: TransactionKind
  icon?: string
  color?: string
  /** Expense categories only; absent means no budget. */
  monthlyBudget?: StoredMoney
}

export function otherCategoryId(kind: TransactionKind): string {
  return kind === "income" ? OTHER_INCOME_ID : OTHER_EXPENSE_ID
}

export const isDefaultCategory = (category: Pick<TransactionCategory, "id">) => shippedCategory(category.id) !== undefined

/** Shows the person's name as-is once they renamed a default; until then it translates by id. */
export const translatesById = (category: TransactionCategory) => isDefaultCategory(category) && !category.isRenamed

export async function getCategories(store: LedgerStore): Promise<TransactionCategory[]> {
  return orderedCategories(await store.fetchCategories())
}

export async function saveCategory(store: LedgerStore, draft: CategoryDraft): Promise<TransactionCategory> {
  const name = [...draft.name.trim()].slice(0, MAX_CATEGORY_NAME_LENGTH).join("")
  if (name === "") throw DomainError.missingName()
  if (draft.kind === "transfer") throw DomainError.unsupportedTransactionKind("transfer")
  const existing = await store.fetchCategories()
  let kind: TransactionKind = draft.kind
  let isRenamed = false
  if (draft.id !== undefined) {
    const current = existing.find((category) => category.id === draft.id)
    if (!current) throw DomainError.corruptedData(`Category ${draft.id}`)
    // Its movements were recorded under this kind; switching it would break them.
    kind = current.kind
    // Giving a default back its shipped name makes it translate again.
    const shipped = shippedCategory(draft.id)
    isRenamed = shipped ? shipped.name !== name : false
  }
  const wanted = folded(name)
  if (existing.some((other) => other.id !== draft.id && other.kind === kind && folded(other.name) === wanted)) {
    throw DomainError.duplicateCategoryName(name)
  }
  const monthlyBudget = kind === "expense" ? budgetOf(draft.monthlyBudget) : undefined
  const category: TransactionCategory = {
    id: draft.id ?? newCustomCategoryId(),
    name,
    kind,
    ...(draft.icon === undefined ? {} : { icon: draft.icon }),
    ...(draft.color === undefined ? {} : { color: draft.color }),
    isRenamed,
    ...(monthlyBudget === undefined ? {} : { monthlyBudget }),
  }
  await store.saveCategory(category)
  return category
}

/** Income has no budget, so one sent for it is dropped; a zero or negative one is refused. */
function budgetOf(budget: StoredMoney | undefined): StoredMoney | undefined {
  if (budget === undefined) return undefined
  const amount = dec(budget.amount)
  if (amount.lte(0)) throw DomainError.invalidAmount()
  return { amount: decimalText(amount), currency: budget.currency }
}

/** Deletes a category; its movements and recurring rules move to "Other" of the same kind. */
export async function deleteCategory(store: LedgerStore, id: string): Promise<void> {
  const category = (await store.fetchCategories()).find((candidate) => candidate.id === id)
  if (!category) return
  if (isFallbackCategory(category.id)) throw DomainError.fallbackCategoryCantBeDeleted(id)
  const otherId = otherCategoryId(category.kind)
  await store.atomically(async () => {
    for (const movement of await store.fetchTransactions()) {
      if (movement.categoryId === id) await store.saveTransaction({ ...movement, categoryId: otherId })
    }
    for (const rule of await store.fetchRecurringRules()) {
      if (rule.categoryId === id) await store.saveRecurringRule({ ...rule, categoryId: otherId })
    }
    await store.deleteCategory(id)
  })
}

export async function reorderCategories(store: LedgerStore, ids: readonly string[]): Promise<void> {
  await store.reorderCategories(ids)
}

/** Brings back deleted defaults and undoes their edits; movements already moved stay in "Other". */
export async function restoreDefaultCategories(store: LedgerStore): Promise<void> {
  await store.restoreDefaultCategories()
}
