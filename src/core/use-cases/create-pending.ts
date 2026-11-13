import { categorizedTransaction, checkRecurringRule, dec, DomainError, firstNextDate, getTransactionContext, InMemoryStore, type Ledger } from "../domain/domain"
import { uuidV5, type CategorizationRule, type RecurringFrequency, type RecurringRule, type Transaction } from "../domain/schema"
import { recurringRuleToWire, transactionToWire } from "../ledger/wire-to-domain"
import { actualDebitedOf, checkedActualDebited } from "../mcp/actual-debited"
import { categoryOutcome } from "../mcp/category-outcome"
import { instantIn } from "../mcp/dates"
import type { McpWriteCounter } from "../ports/mcp-writes"
import type { ApplySyncBatch } from "./apply-sync-batch"
import type { ReadLedger } from "./read-ledger"
import { domainRefusal } from "./domain-refusal"

/** Writes per MCP client and user in any hour (ADR 0007): a runaway or manipulated assistant stops here. */

/** Why the domain refused a write. */
function refusal(error: unknown, fallback: string): string {
  return error instanceof DomainError ? domainRefusal(error) : fallback
}

export const MCP_WRITES_PER_HOUR = 50

export class McpWriteError extends Error {
  constructor(
    readonly code: "rate_limited" | "not_editable" | "invalid",
    message: string
  ) {
    super(message)
  }
}

export interface PendingTransactionInput {
  /** A UUID the client generates once and reuses on retries: the idempotency key. */
  id: string
  kind: "expense" | "income" | "transfer"
  amount: string
  currency: string
  account_id: string
  card_id?: string
  destination_account_id?: string
  category_id?: string
  description: string
  date: string
  note?: string
  /** What the bank charged in the principal currency, for a movement in the second one. */
  actual_debited?: string
}

export interface PendingRuleInput {
  id: string
  name: string
  kind: "expense" | "income" | "transfer"
  amount: string
  currency: string
  account_id: string
  card_id?: string
  destination_account_id?: string
  category_id?: string
  frequency: RecurringFrequency
  interval: number
  start_date: string
  end_date?: string
  is_subscription: boolean
  note?: string
}

interface Deps {
  ledger: ReadLedger
  writer: ApplySyncBatch
  counter: McpWriteCounter
  clock?: () => Date
}

/**
 * What an MCP client may write: a movement that waits as `planned` and a recurring rule that waits
 * paused, both `source = mcp`, until the person confirms them in an app. Nothing else: no edits of
 * history, no deletions, no transfers between the person's money that skip confirmation. The rows are
 * validated by the same domain rules as a movement typed by hand. A retry with the same `id` and the
 * same content is answered from the first write; the same `id` may only rewrite a row this client
 * made that is still pending.
 */
export class CreatePending {
  constructor(private readonly deps: Deps) {}

  private now() {
    return this.deps.clock?.() ?? new Date()
  }

  private async guard(userId: string, clientId: string) {
    const since = new Date(this.now().getTime() - 3_600_000)
    if ((await this.deps.counter.countSince(userId, clientId, since)) >= MCP_WRITES_PER_HOUR) {
      throw new McpWriteError("rate_limited", `This assistant reached ${MCP_WRITES_PER_HOUR} writes in the last hour. Try later or record it in the app.`)
    }
  }

  private async write(userId: string, clientId: string, entity: "transaction" | "recurringRule", row: unknown, id: string, fingerprint: string) {
    const outcome = await this.deps.writer.execute({
      userId,
      clientId,
      platform: "other",
      createdBy: "mcp",
      deadline: Date.now() + 10_000,
      events: [{ event_id: uuidV5(`mcp|${clientId}|${id}|${fingerprint}`), entity, entity_id: id, operation: "update", payload: row, created_at: this.now().toISOString() }],
    })
    const result = outcome.results[0]
    if (!result || result.status === "rejected") throw new McpWriteError("invalid", result?.reason ?? "Not saved")
    if (result.status === "stale") throw new McpWriteError("not_editable", "That id belongs to a movement that can't be changed from here.")
  }

  async transaction(userId: string, clientId: string, input: PendingTransactionInput) {
    await this.guard(userId, clientId)
    const ledger = await this.deps.ledger.execute(userId)
    const existing = ledger.transactions.find((transaction) => transaction.id === input.id)
    if (existing && !(existing.source === "mcp" && existing.status === "planned")) {
      throw new McpWriteError("not_editable", "That id belongs to a movement that is already confirmed or was made in the app.")
    }
    checkReferences(ledger, input)
    const debited = checkedActualDebited(input.actual_debited, input.currency, ledger.settings.currencies.principal, (message) => new McpWriteError("invalid", message))
    const context = await getTransactionContext(new InMemoryStore(ledger.timeZone, ledgerSeed(ledger)))
    let transaction: Transaction
    let rule: CategorizationRule | undefined
    try {
      ;({ transaction, rule } = categorizedTransaction(
        {
          id: input.id,
          kind: input.kind,
          amount: dec(input.amount),
          currency: input.currency.toUpperCase(),
          ...(input.category_id ? { categoryId: input.category_id } : {}),
          source: input.card_id ? { type: "card", id: input.card_id } : { type: "account", id: input.account_id },
          ...(input.destination_account_id ? { destinationAccountId: input.destination_account_id } : {}),
          description: input.description,
          date: instantIn(input.date, ledger.timeZone),
          note: input.note ?? "",
          isDraft: true,
          ...(debited ? { actualDebitedPrincipal: debited } : {}),
        },
        context
      ))
    } catch (error) {
      throw new McpWriteError("invalid", refusal(error, "Invalid movement"))
    }
    const at = this.now().toISOString()
    const row = transactionToWire({ ...transaction, status: "planned" }, { created_at: at, updated_at: at })
    await this.write(userId, clientId, "transaction", row, input.id, JSON.stringify(input))
    return {
      id: input.id,
      status: "pending_confirmation",
      amount: { amount: transaction.amount, currency: transaction.currency },
      ...(transaction.actualDebitedPrincipal === undefined ? {} : { actual_debited: actualDebitedOf(transaction) }),
      date: transaction.date,
      description: transaction.description,
      ...categoryOutcome(ledger, transaction, rule),
    }
  }

  async recurringRule(userId: string, clientId: string, input: PendingRuleInput) {
    await this.guard(userId, clientId)
    const ledger = await this.deps.ledger.execute(userId)
    const existing = ledger.recurringRules.find((rule) => rule.id === input.id)
    if (existing && !(existing.source === "mcp" && existing.isPaused)) {
      throw new McpWriteError("not_editable", "That id belongs to a recurring payment that is already active or was made in the app.")
    }
    checkReferences(ledger, input)
    const schedule = { frequency: input.frequency, interval: input.interval, startDate: instantIn(input.start_date, ledger.timeZone).toISOString() }
    const rule: RecurringRule = {
      id: input.id,
      name: input.name.trim(),
      kind: input.kind,
      ...(input.kind !== "transfer" && input.category_id ? { categoryId: input.category_id } : {}),
      amount: dec(input.amount).toString(),
      currency: input.currency.toUpperCase(),
      accountId: input.account_id,
      ...(input.card_id ? { cardId: input.card_id } : {}),
      ...(input.kind === "transfer" && input.destination_account_id ? { destinationAccountId: input.destination_account_id } : {}),
      ...schedule,
      nextDate: firstNextDate(schedule, ledger.timeZone, this.now()).toISOString(),
      ...(input.end_date ? { endDate: instantIn(input.end_date, ledger.timeZone).toISOString() } : {}),
      isSubscription: input.is_subscription,
      autoConfirm: false,
      // Pending: a paused rule records nothing until the person confirms it in an app.
      isPaused: true,
      ...(input.note ? { note: input.note } : {}),
      source: "mcp",
    }
    try {
      checkRecurringRule(rule, await getTransactionContext(new InMemoryStore(ledger.timeZone, ledgerSeed(ledger))))
    } catch (error) {
      throw new McpWriteError("invalid", refusal(error, "Invalid recurring payment"))
    }
    const at = this.now().toISOString()
    await this.write(userId, clientId, "recurringRule", recurringRuleToWire(rule, { created_at: at, updated_at: at }), input.id, JSON.stringify(input))
    return { id: input.id, status: "pending_confirmation", next_date: rule.nextDate.slice(0, 10) }
  }
}

/**
 * The apps only offer existing accounts, cards and categories; an MCP client sends ids, so they are
 * checked here: each must exist in this person's ledger, and a card must belong to the account.
 */
function checkReferences(ledger: Ledger, input: { account_id: string; card_id?: string; destination_account_id?: string; category_id?: string; kind: string }) {
  const account = ledger.accounts.find((candidate) => candidate.id === input.account_id)
  if (!account) throw new McpWriteError("invalid", "account_id isn't one of this person's accounts (see list_accounts)")
  if (input.card_id && !ledger.cards.some((card) => card.id === input.card_id && card.accountId === account.id)) {
    throw new McpWriteError("invalid", "card_id isn't a card of that account")
  }
  if (input.destination_account_id && !ledger.accounts.some((candidate) => candidate.id === input.destination_account_id)) {
    throw new McpWriteError("invalid", "destination_account_id isn't one of this person's accounts")
  }
  if (input.category_id && !ledger.categories.some((category) => category.id === input.category_id && category.kind === input.kind)) {
    throw new McpWriteError("invalid", "category_id isn't a category of that kind")
  }
}

function ledgerSeed(ledger: Ledger) {
  return { ...ledger, deletedRepaymentDepositIds: ledger.repaymentDepositIds ?? [] }
}
