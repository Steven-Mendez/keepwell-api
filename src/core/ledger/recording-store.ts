import { InMemoryStore, type LedgerStore } from "../domain/domain"
import type { Account, Card, CategorizationRule, Loan, Merchant, PersonalDebt, RecurringRule, SavingsGoal, Settings, Transaction, TransactionCategory } from "../domain/schema"

/** The entities a domain use case writes through `LedgerStore` (children travel with their parent). */
export type TouchedKind = "account" | "card" | "transaction" | "recurringRule" | "savingsGoal" | "loan" | "personalDebt" | "categorizationRule" | "category" | "settings" | "merchant"

/**
 * An in-memory ledger that remembers which records a use case saved, deleted or reordered, so only
 * those become sync events: the server runs the apps' own domain functions (`deleteAccount` with its
 * cascade, `deleteCategory` moving movements to "Other"…) and writes exactly what they changed.
 */
export class RecordingStore extends InMemoryStore implements LedgerStore {
  readonly touched = new Map<TouchedKind, Set<string>>()

  private touch(kind: TouchedKind, id: string) {
    const ids = this.touched.get(kind) ?? new Set<string>()
    ids.add(id)
    this.touched.set(kind, ids)
  }

  override async saveAccount(account: Account) {
    await super.saveAccount(account)
    this.touch("account", account.id)
  }
  override async deleteAccount(id: string) {
    await super.deleteAccount(id)
    this.touch("account", id)
  }
  override async saveCard(card: Card) {
    await super.saveCard(card)
    this.touch("card", card.id)
  }
  override async deleteCard(id: string) {
    await super.deleteCard(id)
    this.touch("card", id)
  }
  override async saveTransaction(transaction: Transaction) {
    await super.saveTransaction(transaction)
    this.touch("transaction", transaction.id)
  }
  override async deleteTransaction(id: string) {
    await super.deleteTransaction(id)
    this.touch("transaction", id)
  }
  override async saveRecurringRule(rule: RecurringRule) {
    await super.saveRecurringRule(rule)
    this.touch("recurringRule", rule.id)
  }
  override async deleteRecurringRule(id: string) {
    await super.deleteRecurringRule(id)
    this.touch("recurringRule", id)
  }
  override async saveSavingsGoal(goal: SavingsGoal) {
    await super.saveSavingsGoal(goal)
    this.touch("savingsGoal", goal.id)
  }
  override async deleteSavingsGoal(id: string) {
    await super.deleteSavingsGoal(id)
    this.touch("savingsGoal", id)
  }
  override async saveLoan(loan: Loan) {
    await super.saveLoan(loan)
    this.touch("loan", loan.id)
  }
  override async deleteLoan(id: string) {
    await super.deleteLoan(id)
    this.touch("loan", id)
  }
  override async savePersonalDebt(debt: PersonalDebt) {
    await super.savePersonalDebt(debt)
    this.touch("personalDebt", debt.id)
  }
  override async deletePersonalDebt(id: string) {
    await super.deletePersonalDebt(id)
    this.touch("personalDebt", id)
  }
  override async saveCategorizationRule(rule: CategorizationRule) {
    await super.saveCategorizationRule(rule)
    this.touch("categorizationRule", rule.id)
  }
  override async deleteCategorizationRule(id: string) {
    await super.deleteCategorizationRule(id)
    this.touch("categorizationRule", id)
  }
  override async reorderCategorizationRules(ids: readonly string[]) {
    await super.reorderCategorizationRules(ids)
    for (const rule of this.categorizationRules) this.touch("categorizationRule", rule.id)
  }
  override async saveCategory(category: TransactionCategory) {
    await super.saveCategory(category)
    this.touch("category", category.id)
  }
  override async deleteCategory(id: string) {
    await super.deleteCategory(id)
    this.touch("category", id)
  }
  override async reorderCategories(ids: readonly string[]) {
    await super.reorderCategories(ids)
    for (const category of this.categories) this.touch("category", category.id)
  }
  override async restoreDefaultCategories() {
    const before = new Set([...this.deletedCategoryIds])
    await super.restoreDefaultCategories()
    for (const category of this.categories) this.touch("category", category.id)
    for (const id of before) this.touch("category", id)
  }
  override async saveMerchant(merchant: Merchant) {
    await super.saveMerchant(merchant)
    this.touch("merchant", merchant.id)
  }
  override async deleteMerchant(id: string) {
    await super.deleteMerchant(id)
    this.touch("merchant", id)
  }
  /**
   * Gives a record the use case just created the id the client chose (`create_account`'s `id`), and
   * repoints every reference to it, so later steps of a batch can use that id. Ids are only ever
   * replaced in `id` and `…Id` fields, never in names or notes.
   */
  renameId(from: string, to: string) {
    if (from === to) return
    const swap = <T>(value: T): T => {
      if (Array.isArray(value)) return value.map(swap) as T
      if (value && typeof value === "object") {
        const copy: Record<string, unknown> = {}
        for (const [key, inner] of Object.entries(value)) copy[key] = (key === "id" || key.endsWith("Id")) && inner === from ? to : swap(inner)
        return copy as T
      }
      return value
    }
    this.accounts = swap(this.accounts)
    this.cards = swap(this.cards)
    this.transactions = swap(this.transactions)
    this.recurringRules = swap(this.recurringRules)
    this.savingsGoals = swap(this.savingsGoals)
    this.loans = swap(this.loans)
    this.personalDebts = swap(this.personalDebts)
    this.categorizationRules = swap(this.categorizationRules)
    this.categories = swap(this.categories)
    this.merchants = swap(this.merchants)
    for (const ids of this.touched.values()) {
      if (ids.has(from)) {
        ids.delete(from)
        ids.add(to)
      }
    }
  }

  private readonly merchantAliases = new Map<string, string>()

  /**
   * Makes `alias`, an id a client chose for a merchant that turned out to exist already, name that
   * merchant for the rest of the run, so later steps of a batch can still use it.
   */
  aliasMerchant(alias: string, id: string) {
    if (alias !== id) this.merchantAliases.set(alias, id)
  }

  /** The merchant id `id` stands for in this run (itself unless it is an alias). */
  merchantId(id: string): string {
    return this.merchantAliases.get(id) ?? id
  }

  override async saveSettings(settings: Settings) {
    await super.saveSettings(settings)
    this.touch("settings", "settings")
  }
}
