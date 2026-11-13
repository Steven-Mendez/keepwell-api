import { registerAppTool } from "@modelcontextprotocol/ext-apps/server"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import type { Logger } from "../../adapters/observability/logger"
import {
  addAccount,
  addCreditCard,
  addToSavingsGoal,
  applyRuleToPast,
  closeAccount,
  confirmPlannedTransaction,
  createMerchant,
  currencySettings,
  dec,
  isTimeZone,
  deleteAccount,
  deleteCategorizationRule,
  deleteCategory,
  deleteLoan,
  deleteMerchant,
  deletePersonalDebt,
  deleteRecurringRule,
  deleteSavingsGoal,
  dayKey,
  INITIAL_CURRENCIES,
  deleteTransaction,
  DomainError,
  draftFrom,
  importedLineIds,
  importedTransactionId,
  importTransactions,
  MAX_IMPORT_LINES,
  mergeMerchants,
  payLoanInstallment,
  renameAccount,
  reopenAccount,
  reopenPersonalDebt,
  reorderCategories,
  repayPersonalDebt,
  restoreDefaultCategories,
  saveCategorizationRule,
  saveCategory,
  saveLoan,
  saveMerchant,
  savePersonalDebt,
  saveRecurringRule,
  saveSavingsGoal,
  saveTransaction,
  setCardColor,
  setCardDetails,
  setCardNumber,
  setRecurringRulePaused,
  settlePersonalDebt,
  unpayLoanInstallment,
  updateCreditTerms,
  withRate,
  withdrawFromSavingsGoal,
  type IncomingLine,
  type PaymentSource,
  type RecurringRuleDraft,
  type TransactionDraft,
} from "../../core/domain/domain"
import { swapCurrencies, updateSettings } from "../../core/domain/domain/onboarding"
import { CardColor, CardNetwork, DebtDirection, DebtMode, LoanFrequency, RecurringFrequency } from "../../core/domain/schema"
import { actualDebitedOf, checkedActualDebited } from "../../core/mcp/actual-debited"
import { categoryOutcome } from "../../core/mcp/category-outcome"
import { instantIn } from "../../core/mcp/dates"
import { ManageError, type ManageLedger } from "../../core/use-cases/manage-ledger"
import type { RecordingStore } from "../../core/ledger/recording-store"
import { actualDebited, decimal } from "./inputs"
import { VIEWS_URI } from "./ui/resources"

// The `manage` tools (ADR 0011): everything the apps' screens do, through the apps' own domain use
// cases, applied directly. Deletes always ask in Claude (destructiveHint) and land in a trash that
// `restore_deleted` takes back for 30 days. Ids come from the read tools (list_accounts,
// list_categories…), never guessed.

const instant = z.string().refine((text) => !Number.isNaN(Date.parse(text)), "an ISO 8601 date or date-time").describe("YYYY-MM-DD is that day in the person's time zone (get_financial_context); a date-time is that instant")
const currency = z.string().length(3).describe("ISO 4217, one of the currencies in get_financial_context")
const newId = z.string().uuid().describe("A new UUID you generate once and reuse if you retry, so the call never creates twice")
const ref = (what: string) => z.string().min(1).max(64).describe(what)
const kind = z.enum(["expense", "income", "transfer"])
const categoryKind = z.enum(["expense", "income"])
const tags = z.array(z.string().max(40)).max(10)
/** The conversation's language, so a view reads in it (Claude's interface may be in another). */
const lang = z.enum(["en", "es"]).optional().describe("The language of the conversation, for the view")

const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const CREATE: ToolAnnotations = { ...WRITE, idempotentHint: true }
const DELETE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

function source(input: { account_id: string; card_id?: string | undefined }): PaymentSource {
  return input.card_id ? { type: "card", id: input.card_id } : { type: "account", id: input.account_id }
}


/** A statement line as the domain reads it (`matchIncoming`). */
function incomingLine(line: { day: string; direction: "out" | "in"; amount: string; currency: string; description: string; imported_id?: string | undefined }): IncomingLine {
  return { day: line.day, direction: line.direction, amount: line.amount, currency: line.currency.toUpperCase(), description: line.description, ...(line.imported_id ? { importedId: line.imported_id } : {}) }
}

function find<T extends { id: string }>(list: readonly T[], id: string, what: string): T {
  const found = list.find((item) => item.id === id)
  if (!found) throw new ManageError("not_found", `${what} ${id} isn't one of this person's (see the list tools)`)
  return found
}

/**
 * One of the person's merchants by id, or by the id an earlier `create_merchant` of the same batch
 * chose for a merchant that already existed.
 */
function findMerchant(store: RecordingStore, id: string) {
  return find(store.merchants, store.merchantId(id), "Merchant")
}

/** A merchant link as given (`null` removes it), once the merchant is known to be the person's. */
function merchantLink<T extends string | null | undefined>(store: RecordingStore, id: T): T {
  return (typeof id === "string" ? findMerchant(store, id).id : id) as T
}

/** `args` with its merchant links checked and pointing at the merchants they name. */
function withMerchantLinks<T extends { merchant_id?: string | null | undefined; via_merchant_id?: string | null | undefined }>(store: RecordingStore, args: T): T {
  return {
    ...args,
    ...(args.merchant_id === undefined ? {} : { merchant_id: merchantLink(store, args.merchant_id) }),
    ...(args.via_merchant_id === undefined ? {} : { via_merchant_id: merchantLink(store, args.via_merchant_id) }),
  }
}

/** The draft fields for the links a tool was given; left out, they stay as they are. */
function merchantDraft(store: RecordingStore, args: { merchant_id?: string | null | undefined; via_merchant_id?: string | null | undefined }) {
  const links = withMerchantLinks(store, args)
  return {
    ...(links.merchant_id === undefined ? {} : { merchantId: links.merchant_id }),
    ...(links.via_merchant_id === undefined ? {} : { viaMerchantId: links.via_merchant_id }),
  }
}

/**
 * A create step that already ran (same `id`) answers with what is there instead of creating it again,
 * so a retried call, or a batch sent twice, never duplicates.
 */
function existing(list: readonly { id: string }[], id: string) {
  return list.some((item) => item.id === id)
}

export function registerManageTools(server: McpServer, options: { manage: ManageLedger; userId: string; clientId: string; log: Logger }) {
  const { manage, userId, clientId, log } = options

  /** Every tool's input and operation, so apply_changes runs the same steps in one write. */
  type Spec = {
    input: z.ZodRawShape
    operation: (store: RecordingStore, args: never, now: Date) => Promise<unknown>
    trash?: ((store: RecordingStore, args: never) => string) | undefined
  }
  const specs = new Map<string, Spec>()

  /**
   * One tool: validates, runs `operation` on the ledger, writes what changed. `key` makes retries
   * safe; `trash` (deletes) keeps what goes so it can be restored.
   */
  const tool = <Args extends z.ZodRawShape>(
    name: string,
    meta: {
      title: string
      description: string
      annotations: ToolAnnotations
      view?: boolean
      /** Ids the operation derives itself and that must stay as they are (by default, the `id` argument). */
      keepIds?: (args: z.infer<z.ZodObject<Args>>) => string[]
    },
    input: Args,
    key: (args: z.infer<z.ZodObject<Args>>) => string,
    operation: (store: RecordingStore, args: z.infer<z.ZodObject<Args>>, now: Date) => Promise<unknown>,
    trash?: (store: RecordingStore, args: z.infer<z.ZodObject<Args>>) => string
  ) => {
    specs.set(name, { input, operation: operation as Spec["operation"], trash: trash as Spec["trash"] })
    const config = { title: meta.title, description: meta.description, inputSchema: meta.view ? { ...input, lang } : input, annotations: meta.annotations }
    const handler = (async (args: z.infer<z.ZodObject<Args>>) => {
      try {
        const { result, changes } = await manage.run(userId, clientId, { key: `${name}|${key(args)}`, keepIds: meta.keepIds ? meta.keepIds(args) : typeof (args as { id?: unknown }).id === "string" ? [(args as { id: string }).id] : [], ...(trash ? { trashLabel: (store: RecordingStore) => trash(store, args) } : {}) }, (store, now) => operation(store, args, now))
        const data = { ok: true, ...(result && typeof result === "object" ? { result } : {}), changes }
        log.info({ mcp_tool: name, client_id: clientId, ok: true, created: changes.created, updated: changes.updated, deleted: changes.deleted }, "mcp manage")
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } satisfies CallToolResult
      } catch (error) {
        const code = error instanceof ManageError ? error.code : error instanceof DomainError ? "invalid" : "failed"
        log.warn({ mcp_tool: name, client_id: clientId, ok: false, code }, "mcp manage refused")
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message: error instanceof Error ? error.message : "Not saved" }) }] } satisfies CallToolResult
      }
    }) as never
    if (meta.view) registerAppTool(server, name, { ...config, _meta: { ui: { resourceUri: VIEWS_URI } } }, handler)
    else server.registerTool(name, config, handler)
  }
  // Accounts and cards ------------------------------------------------------------------------

  tool(
    "create_account",
    { title: "Create an account", description: "A bank account (deposit, with its debit card) or a cash wallet, with its current balance.", annotations: CREATE },
    {
      id: newId,
      kind: z.enum(["deposit", "cash"]),
      name: z.string().min(1).max(100),
      bank: z.string().max(100).optional(),
      balance: decimal.describe("What it holds today"),
      currency,
      debit_card: z.object({ last_four: z.string().regex(/^\d{4}$/).optional(), network: CardNetwork.optional(), color: CardColor.optional() }).optional().describe("Deposit accounts only"),
    },
    (args) => args.id,
    async (store, args, now) => {
      if (existing(store.accounts, args.id)) return { account_id: args.id, already_existed: true }
      const account = await addAccount(
        store,
        {
          kind: args.kind,
          name: args.name,
          ...(args.bank ? { bank: args.bank } : {}),
          balance: { amount: dec(args.balance), currency: args.currency.toUpperCase() },
          ...(args.debit_card ? { debitCard: { ...(args.debit_card.last_four ? { lastFour: args.debit_card.last_four } : {}), ...(args.debit_card.network ? { network: args.debit_card.network } : {}), ...(args.debit_card.color ? { color: args.debit_card.color } : {}) } } : {}),
        },
        now
      )
      store.renameId(account.id, args.id)
      return { account_id: args.id, name: account.name }
    }
  )

  tool(
    "create_credit_card",
    { title: "Create a credit card", description: "A credit card with its own account: what is owed today (positive), its limit, cutoff and due day.", annotations: CREATE },
    {
      id: newId,
      bank: z.string().min(1).max(100),
      last_four: z.string().regex(/^\d{4}$/),
      network: CardNetwork,
      color: CardColor.default("azul"),
      debt_mode: DebtMode.default("principal").describe("dual: the card owes in both currencies"),
      owed: decimal.default("0").describe("Owed today in the principal currency"),
      owed_second: decimal.default("0").describe("Dual cards: owed in the second currency"),
      limit: decimal.optional(),
      cutoff_day: z.number().int().min(1).max(31).optional(),
      due_day: z.number().int().min(1).max(31).optional(),
    },
    (args) => args.id,
    async (store, args, now) => {
      if (existing(store.accounts, args.id)) return { account_id: args.id, already_existed: true }
      const { account, holder } = await addCreditCard(
        store,
        {
          bank: args.bank,
          lastFour: args.last_four,
          network: args.network,
          color: args.color,
          debtMode: args.debt_mode,
          principalDebt: dec(args.owed),
          secondDebt: dec(args.owed_second),
          ...(args.limit ? { limit: dec(args.limit) } : {}),
          ...(args.cutoff_day ? { cutoffDay: args.cutoff_day } : {}),
          ...(args.due_day ? { dueDay: args.due_day } : {}),
        },
        now
      )
      store.renameId(account.id, args.id)
      return { account_id: args.id, card_id: holder.id, name: account.name }
    }
  )

  tool(
    "update_account",
    { title: "Edit an account", description: "Rename an account, or set a credit card's limit, cutoff and due day (null clears one).", annotations: WRITE },
    {
      account_id: ref("From list_accounts"),
      name: z.string().min(1).max(100).optional(),
      limit: decimal.nullable().optional(),
      cutoff_day: z.number().int().min(1).max(31).nullable().optional(),
      due_day: z.number().int().min(1).max(31).nullable().optional(),
    },
    (args) => JSON.stringify(args),
    async (store, args) => {
      const account = find(store.accounts, args.account_id, "Account")
      if (args.name !== undefined) await renameAccount(store, account.id, args.name)
      if (args.limit !== undefined || args.cutoff_day !== undefined || args.due_day !== undefined) {
        const terms = account.creditTerms
        const limitCurrency = terms?.limit?.currency ?? account.openingBalances[0]?.currency ?? "USD"
        const limit = args.limit === undefined ? terms?.limit : args.limit === null ? undefined : { amount: args.limit, currency: limitCurrency }
        await updateCreditTerms(
          store,
          account.id,
          limit ? { amount: dec(limit.amount), currency: limit.currency } : undefined,
          args.cutoff_day === undefined ? terms?.cutoffDay : (args.cutoff_day ?? undefined),
          args.due_day === undefined ? terms?.dueDay : (args.due_day ?? undefined)
        )
      }
      return { account_id: account.id }
    }
  )

  tool(
    "close_account",
    {
      title: "Close an account",
      description:
        "Closes an account that is no longer used, keeping its history: its movements stay in summaries and net worth, it leaves the apps' lists and pickers, and reopen_account undoes it. Its balance must be zero, or transfer_to_account_id (an open account holding each of its currencies) receives it with one confirmed transfer per currency. Its recurring payments are paused and their drafts deleted.",
      annotations: WRITE,
    },
    { account_id: ref("From list_accounts"), transfer_to_account_id: ref("From list_accounts: where a balance left goes").optional() },
    (args) => JSON.stringify(args),
    async (store, args, now) => {
      find(store.accounts, args.account_id, "Account")
      const { account, transfers } = await closeAccount(store, args.account_id, args.transfer_to_account_id ? { transferTo: args.transfer_to_account_id } : {}, now)
      return {
        account_id: account.id,
        closed_at: account.closedAt ?? null,
        transfers: transfers.map((transfer) => ({ id: transfer.id, amount: { amount: transfer.amount, currency: transfer.currency }, from_account_id: transfer.accountId, to_account_id: transfer.destinationAccountId ?? null })),
      }
    }
  )

  tool(
    "reopen_account",
    { title: "Reopen an account", description: "Reopens a closed account. Its paused recurring payments stay paused and closing transfers stay recorded.", annotations: WRITE },
    { account_id: ref("From list_accounts") },
    (args) => args.account_id,
    async (store, args) => {
      find(store.accounts, args.account_id, "Account")
      const account = await reopenAccount(store, args.account_id)
      return { account_id: account.id, closed_at: null }
    }
  )

  tool(
    "delete_account",
    { title: "Delete an account", description: "Deletes an account with its cards, every movement that touches it (transfers included) and its recurring payments, as the app does. To keep its history instead, use close_account. Can be undone with restore_deleted for 30 days.", annotations: DELETE },
    { account_id: ref("From list_accounts") },
    (args) => args.account_id,
    async (store, args) => deleteAccount(store, args.account_id),
    (store, args) => `Account ${find(store.accounts, args.account_id, "Account").name}`
  )

  tool(
    "update_card",
    { title: "Edit a card", description: "A card's color, product name, expiry, last four digits or network.", annotations: WRITE },
    {
      card_id: ref("From list_accounts (cards)"),
      color: CardColor.optional(),
      product_name: z.string().max(60).optional(),
      expiry: z.object({ month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2199) }).optional(),
      last_four: z.string().regex(/^\d{4}$/).optional(),
      network: CardNetwork.optional(),
    },
    (args) => JSON.stringify(args),
    async (store, args) => {
      const card = find(store.cards, args.card_id, "Card")
      if (args.color) await setCardColor(store, card.id, args.color)
      if (args.product_name !== undefined || args.expiry) await setCardDetails(store, card.id, args.product_name, args.expiry)
      if (args.last_four || args.network) await setCardNumber(store, card.id, args.last_four, args.network)
      return { card_id: card.id }
    }
  )

  // Categories and budgets ---------------------------------------------------------------------

  tool(
    "create_category",
    { title: "Create a category", description: "An expense or income category, optionally with a monthly budget (expenses only).", annotations: CREATE },
    { id: newId, name: z.string().min(1).max(40), kind: categoryKind, icon: z.string().max(40).optional(), color: z.string().max(20).optional(), monthly_budget: decimal.optional(), budget_currency: currency.optional() },
    (args) => args.id,
    async (store, args) => {
      if (existing(await store.fetchCategories(), args.id)) return { category_id: args.id, already_existed: true }
      const principal = store.settings?.currencies.principal ?? "USD"
      const category = await saveCategory(store, {
        name: args.name,
        kind: args.kind,
        ...(args.icon ? { icon: args.icon } : {}),
        ...(args.color ? { color: args.color } : {}),
        ...(args.monthly_budget ? { monthlyBudget: { amount: args.monthly_budget, currency: (args.budget_currency ?? principal).toUpperCase() } } : {}),
      })
      store.renameId(category.id, args.id)
      return { category_id: args.id, name: category.name }
    }
  )

  tool(
    "update_category",
    { title: "Edit a category", description: "Rename a category, change its icon or color, or set its monthly budget (null removes it).", annotations: WRITE },
    { category_id: ref("From list_categories"), name: z.string().min(1).max(40).optional(), icon: z.string().max(40).optional(), color: z.string().max(20).optional(), monthly_budget: decimal.nullable().optional(), budget_currency: currency.optional() },
    (args) => JSON.stringify(args),
    async (store, args) => {
      const category = find(await store.fetchCategories(), args.category_id, "Category")
      const budget =
        args.monthly_budget === undefined
          ? category.monthlyBudget
          : args.monthly_budget === null
            ? undefined
            : { amount: args.monthly_budget, currency: (args.budget_currency ?? category.monthlyBudget?.currency ?? store.settings?.currencies.principal ?? "USD").toUpperCase() }
      const saved = await saveCategory(store, {
        id: category.id,
        name: args.name ?? category.name,
        kind: category.kind,
        ...((args.icon ?? category.icon) ? { icon: args.icon ?? category.icon } : {}),
        ...((args.color ?? category.color) ? { color: args.color ?? category.color } : {}),
        ...(budget ? { monthlyBudget: budget } : {}),
      })
      return { category_id: saved.id }
    }
  )

  tool(
    "delete_category",
    { title: "Delete a category", description: "Deletes a category; its movements and recurring payments move to Other, as in the app. Other can't be deleted. Can be undone with restore_deleted.", annotations: DELETE },
    { category_id: ref("From list_categories") },
    (args) => args.category_id,
    async (store, args) => deleteCategory(store, args.category_id),
    (store, args) => `Category ${store.categories.find((category) => category.id === args.category_id)?.name ?? args.category_id}`
  )

  tool(
    "reorder_categories",
    { title: "Reorder categories", description: "Puts categories in this order; ones left out keep their order after them.", annotations: WRITE },
    { category_ids: z.array(ref("From list_categories")).min(1).max(200) },
    (args) => args.category_ids.join(","),
    async (store, args) => reorderCategories(store, args.category_ids)
  )

  tool(
    "restore_default_categories",
    { title: "Restore default categories", description: "Brings back every default category as shipped, deleted ones included. The person's own categories stay.", annotations: WRITE },
    {},
    () => "restore-defaults",
    async (store) => restoreDefaultCategories(store)
  )

  // Movements ----------------------------------------------------------------------------------

  const merchantLinks = {
    merchant_id: ref("From list_merchants: the business it was with. null removes it; left out it stays").nullable().optional(),
    via_merchant_id: ref("From list_merchants: the platform it went through (Uber Eats delivering from a restaurant, Apple billing an app), never the business itself. null removes it; left out it stays").nullable().optional(),
  }
  const movementBase = {
    ...merchantLinks,
    kind,
    amount: decimal.describe("Always positive; kind gives the direction"),
    currency,
    account_id: ref("From list_accounts"),
    card_id: ref("A card of that account, when it was paid by card").optional(),
    destination_account_id: ref("Transfers only").optional(),
    category_id: ref("From list_categories; left out for transfers").optional(),
    note: z.string().max(500).optional(),
    tags: tags.optional(),
  }
  const movement = {
    ...movementBase,
    category_id: ref("From list_categories; left out for transfers. Leave it out to let the person's categorization rules choose; Other if none matches.").optional(),
    description: z.string().min(1).max(200),
    date: instant,
  }

  tool(
    "create_transaction",
    {
      title: "Record a movement",
      description:
        "Records one expense, income or transfer, saved like one typed in the app. status planned keeps it out of balances until confirmed. When a movement in the second currency was charged a known different amount in the principal currency, pass it as actual_debited instead of writing it in the note. For more than one, use apply_changes.",
      annotations: CREATE,
      view: true,
    },
    {
      id: newId,
      ...movement,
      merchant: z.string().min(1).max(60).optional().describe("Instead of merchant_id: the business by name; an existing merchant with that name (any case or accents) is used, otherwise one is created"),
      actual_debited: actualDebited.optional(),
      status: z.enum(["confirmed", "planned"]).default("confirmed"),
    },
    (args) => args.id,
    async (store, args) => {
      if (args.merchant !== undefined && args.merchant_id !== undefined) throw new ManageError("invalid", "Give merchant or merchant_id, not both")
      // A transfer names no merchant (the domain drops the links); refused before `merchant` creates one.
      if (args.kind === "transfer" && (args.merchant !== undefined || args.merchant_id != null || args.via_merchant_id != null)) throw new ManageError("invalid", "A transfer names no merchant: leave out merchant, merchant_id and via_merchant_id")
      const merchantId = args.merchant !== undefined ? (await createMerchant(store, { name: args.merchant })).id : args.merchant_id
      const principal = ((await store.loadSettings())?.currencies ?? INITIAL_CURRENCIES).principal
      const debited = checkedActualDebited(args.actual_debited, args.currency, principal, (message) => new ManageError("invalid", message))
      const draft: TransactionDraft = {
        id: args.id,
        kind: args.kind,
        amount: dec(args.amount),
        currency: args.currency.toUpperCase(),
        ...(args.category_id ? { categoryId: args.category_id } : {}),
        source: source(args),
        ...(args.destination_account_id ? { destinationAccountId: args.destination_account_id } : {}),
        description: args.description,
        date: instantIn(args.date, store.timeZone),
        note: args.note ?? "",
        isDraft: args.status === "planned",
        ...(args.tags ? { tags: args.tags } : {}),
        ...(debited ? { actualDebitedPrincipal: debited } : {}),
        ...merchantDraft(store, { merchant_id: merchantId, via_merchant_id: args.via_merchant_id }),
      }
      const saved = await saveTransaction(store, draft)
      const transaction = saved.transaction
      return {
        id: transaction.id,
        status: transaction.status === "planned" ? "planned" : "saved",
        amount: { amount: transaction.amount, currency: transaction.currency },
        ...(transaction.actualDebitedPrincipal === undefined ? {} : { actual_debited: actualDebitedOf(transaction) }),
        date: transaction.date,
        description: transaction.description,
        merchant_id: transaction.merchantId ?? null,
        via_merchant_id: transaction.viaMerchantId ?? null,
        ...categoryOutcome({ categories: await store.fetchCategories() }, transaction, saved.rule),
      }
    }
  )

  tool(
    "update_transaction",
    {
      title: "Edit a movement",
      description:
        "Changes any field of a movement; fields left out stay as they are, except actual_debited, which a new amount or currency clears unless given again (null clears it). Use actual_debited for what the bank charged in the principal currency on a movement in the second currency.",
      annotations: WRITE,
    },
    {
      transaction_id: ref("From search_transactions"),
      kind: kind.optional(),
      amount: decimal.optional(),
      currency: currency.optional(),
      account_id: ref("From list_accounts").optional(),
      card_id: ref("A card of that account").nullable().optional(),
      destination_account_id: ref("Transfers only").nullable().optional(),
      category_id: ref("From list_categories").nullable().optional(),
      description: z.string().min(1).max(200).optional(),
      date: instant.optional(),
      note: z.string().max(500).optional(),
      tags: tags.optional(),
      actual_debited: actualDebited.nullable().optional().describe("null clears it; left out it stays, unless amount or currency change"),
      ...merchantLinks,
    },
    (args) => JSON.stringify(args),
    async (store, args) => {
      const existing = find(store.transactions, args.transaction_id, "Movement")
      const draft = draftFrom(existing)
      const accountId = args.account_id ?? (draft.source?.type === "account" ? draft.source.id : store.cards.find((card) => card.id === draft.source?.id)?.accountId ?? "")
      const cardId = args.card_id === null ? undefined : (args.card_id ?? (args.account_id === undefined && draft.source?.type === "card" ? draft.source.id : undefined))
      const { categoryId: _c, destinationAccountId: _d, source: _s, actualDebitedPrincipal: _a, debitedFor: _f, ...rest } = draft
      const currency = args.currency ? args.currency.toUpperCase() : draft.currency
      // The bank's charge was for the old amount, currency and account: a change drops it unless given
      // again, as the domain's applicableDebit does for an edit in the apps.
      // The account it ends up in is the card's when it ends up paid by card.
      const finalAccountId = cardId ? (store.cards.find((card) => card.id === cardId)?.accountId ?? accountId) : accountId
      const moved = (args.amount !== undefined && !dec(args.amount).eq(draft.amount)) || currency !== draft.currency || finalAccountId !== existing.accountId
      // An edit keeps the rate it was recorded with, so its principal is the one that counts (as in the domain).
      const debited =
        args.actual_debited === null
          ? undefined
          : args.actual_debited !== undefined
            ? checkedActualDebited(args.actual_debited, currency, existing.exchangeRate.principal, (message) => new ManageError("invalid", message))
            : moved
              ? undefined
              : draft.actualDebitedPrincipal
      const categoryId = args.category_id === null ? undefined : (args.category_id ?? draft.categoryId)
      const destination = args.destination_account_id === null ? undefined : (args.destination_account_id ?? draft.destinationAccountId)
      const saved = await saveTransaction(store, {
        ...rest,
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.amount ? { amount: dec(args.amount) } : {}),
        ...(args.currency ? { currency: args.currency.toUpperCase() } : {}),
        source: cardId ? { type: "card", id: cardId } : { type: "account", id: accountId },
        ...(categoryId ? { categoryId } : {}),
        ...(destination ? { destinationAccountId: destination } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.date ? { date: instantIn(args.date, store.timeZone) } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
        ...(debited ? { actualDebitedPrincipal: debited } : {}),
        ...merchantDraft(store, args),
      })
      return { id: saved.transaction.id }
    }
  )

  tool(
    "confirm_transaction",
    { title: "Confirm a pending movement", description: "Confirms a planned movement (one an assistant recorded, or a draft) so it counts toward balances; a future date becomes today.", annotations: WRITE },
    { transaction_id: ref("From search_transactions with status planned") },
    (args) => args.transaction_id,
    async (store, args, now) => {
      find(store.transactions, args.transaction_id, "Movement")
      await confirmPlannedTransaction(store, args.transaction_id, now)
      return { id: args.transaction_id, status: "confirmed" }
    }
  )

  tool(
    "delete_transaction",
    { title: "Delete a movement", description: "Deletes a movement. Can be undone with restore_deleted for 30 days.", annotations: DELETE },
    { transaction_id: ref("From search_transactions") },
    (args) => args.transaction_id,
    async (store, args) => deleteTransaction(store, args.transaction_id),
    (store, args) => `Movement ${find(store.transactions, args.transaction_id, "Movement").description}`
  )

  const statementLine = z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").describe("The day the statement shows"),
    direction: z.enum(["out", "in"]).describe("out: money left the account (a charge); in: money entered it"),
    amount: decimal.describe("Always positive; direction gives the sign"),
    currency,
    description: z.string().min(1).max(200).describe("As the statement words it, or tidied up"),
    imported_id: z.string().min(1).max(128).optional().describe("The bank's id for the line (FITID, reference number) when the statement has one"),
    category_id: ref("From list_categories, for the movement if the line is new; left out means Other").optional(),
    note: z.string().max(500).optional(),
  })

  tool(
    "import_transactions",
    {
      title: "Import a bank statement",
      description:
        "Imports a bank statement's lines into one account without duplicating what is already recorded. Run with dry_run first, show the person the new, existing and skipped lines, and only then call it again with dry_run false. Don't split one day's lines across calls.",
      annotations: { ...WRITE, idempotentHint: true },
      keepIds: (args) => importedLineIds(args.account_id, args.lines.map(incomingLine)).map((id) => importedTransactionId(args.account_id, id)),
    },
    {
      account_id: ref("From list_accounts: the account the statement is from"),
      card_id: ref("A card of that account, for a card's statement").optional(),
      dry_run: z.boolean().default(true).describe("true (the default) only says what would happen; false saves the new lines"),
      lines: z.array(statementLine).min(1).max(MAX_IMPORT_LINES),
      lang,
    },
    (args) => JSON.stringify(args),
    async (store, args) => {
      find(store.accounts, args.account_id, "Account")
      const outcome = await importTransactions(store, {
        accountId: args.account_id,
        ...(args.card_id ? { cardId: args.card_id } : {}),
        lines: args.lines.map((line) => ({ ...incomingLine(line), ...(line.category_id ? { categoryId: line.category_id } : {}), ...(line.note ? { note: line.note } : {}) })),
        dryRun: args.dry_run,
      })
      // What each matched line matched, so Claude can show it next to the statement's line.
      const movement = (id: string | undefined) => {
        const found = id ? store.transactions.find((transaction) => transaction.id === id) : undefined
        return found ? { movement: { description: found.description, date: dayKey(new Date(found.date), store.timeZone), status: found.status } } : {}
      }
      return {
        dry_run: outcome.dryRun,
        counts: outcome.counts,
        lines: outcome.lines.map((match) =>
          match.result === "new"
            ? { line: match.line, result: match.result, imported_id: match.importedId }
            : match.result === "existing"
              ? { line: match.line, result: match.result, by: match.by, transaction_id: match.transactionId, ...movement(match.transactionId) }
              : { line: match.line, result: match.result, reason: match.reason, ...(match.transactionId ? { transaction_id: match.transactionId } : {}), ...movement(match.transactionId) }
        ),
      }
    }
  )

  // Recurring payments -------------------------------------------------------------------------

  const schedule = {
    name: z.string().min(1).max(100),
    frequency: RecurringFrequency,
    interval: z.number().int().min(1).max(99).default(1),
    start_date: instant.describe("The first occurrence"),
    end_date: instant.optional(),
    is_subscription: z.boolean().default(false),
    auto_confirm: z.boolean().default(true).describe("Record each occurrence as confirmed; false leaves them planned to confirm"),
  }

  const ruleDraft = (args: Record<string, unknown> & { kind: "expense" | "income" | "transfer"; amount: string; currency: string; account_id: string; card_id?: string | undefined; destination_account_id?: string | undefined; category_id?: string | undefined; name: string; frequency: RecurringRuleDraft["frequency"]; interval: number; start_date: string; end_date?: string | undefined; is_subscription: boolean; auto_confirm: boolean; note?: string | undefined; tags?: string[] | undefined; merchant_id?: string | null | undefined; via_merchant_id?: string | null | undefined }, zone: string, id?: string): RecurringRuleDraft => ({
    ...(id ? { id } : {}),
    name: args.name,
    kind: args.kind,
    amount: dec(args.amount),
    currency: args.currency.toUpperCase(),
    ...(args.category_id ? { categoryId: args.category_id } : {}),
    source: source(args),
    ...(args.destination_account_id ? { destinationAccountId: args.destination_account_id } : {}),
    frequency: args.frequency,
    interval: args.interval,
    startDate: instantIn(args.start_date, zone),
    ...(args.end_date ? { endDate: instantIn(args.end_date, zone) } : {}),
    isSubscription: args.is_subscription,
    autoConfirm: args.auto_confirm,
    note: args.note ?? "",
    ...(args.tags ? { tags: args.tags } : {}),
    ...(args.merchant_id === undefined ? {} : { merchantId: args.merchant_id }),
    ...(args.via_merchant_id === undefined ? {} : { viaMerchantId: args.via_merchant_id }),
  })

  tool(
    "create_recurring_rule",
    { title: "Set up a recurring payment", description: "A recurring movement or subscription, active right away like one set up in the app.", annotations: CREATE, view: true },
    { id: newId, ...movementBase, ...schedule },
    (args) => args.id,
    async (store, args, now) => {
      if (existing(store.recurringRules, args.id)) return { id: args.id, status: "saved", already_existed: true }
      const rule = await saveRecurringRule(store, ruleDraft(withMerchantLinks(store, args), store.timeZone), now)
      store.renameId(rule.id, args.id)
      return { id: args.id, status: "saved", next_date: rule.nextDate.slice(0, 10), name: rule.name }
    }
  )

  tool(
    "update_recurring_rule",
    { title: "Edit a recurring payment", description: "Changes a recurring payment; send every field (read it first with list_recurring_rules), except merchant_id and via_merchant_id, which stay when left out.", annotations: WRITE },
    { rule_id: ref("From list_recurring_rules"), ...movementBase, ...schedule },
    (args) => JSON.stringify(args),
    async (store, args, now) => {
      find(store.recurringRules, args.rule_id, "Recurring payment")
      const rule = await saveRecurringRule(store, ruleDraft(withMerchantLinks(store, args), store.timeZone, args.rule_id), now)
      return { id: rule.id, next_date: rule.nextDate.slice(0, 10) }
    }
  )

  tool(
    "set_recurring_rule_paused",
    { title: "Pause or resume a recurring payment", description: "paused true stops recording it; false resumes it from today (and accepts one an assistant proposed).", annotations: WRITE },
    { rule_id: ref("From list_recurring_rules"), paused: z.boolean() },
    (args) => `${args.rule_id}|${args.paused}`,
    async (store, args, now) => {
      find(store.recurringRules, args.rule_id, "Recurring payment")
      await setRecurringRulePaused(store, args.rule_id, args.paused, now)
      return { id: args.rule_id, paused: args.paused }
    }
  )

  tool(
    "delete_recurring_rule",
    { title: "Delete a recurring payment", description: "Deletes a recurring payment and its planned drafts; movements already confirmed stay. Can be undone with restore_deleted.", annotations: DELETE },
    { rule_id: ref("From list_recurring_rules") },
    (args) => args.rule_id,
    async (store, args) => deleteRecurringRule(store, args.rule_id),
    (store, args) => `Recurring payment ${find(store.recurringRules, args.rule_id, "Recurring payment").name}`
  )

  // Savings goals ------------------------------------------------------------------------------

  const goal = { name: z.string().min(1).max(60), target_amount: decimal, currency, target_month: z.object({ month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2199) }).optional(), icon: z.string().max(40).optional(), color: z.string().max(20).optional() }
  const goalDraft = (args: { name: string; target_amount: string; currency: string; target_month?: { month: number; year: number } | undefined; icon?: string | undefined; color?: string | undefined }, id?: string) => ({
    ...(id ? { id } : {}),
    name: args.name,
    targetAmount: args.target_amount,
    currency: args.currency.toUpperCase(),
    ...(args.target_month ? { targetMonth: args.target_month } : {}),
    ...(args.icon ? { icon: args.icon } : {}),
    ...(args.color ? { color: args.color } : {}),
  })

  tool(
    "create_savings_goal",
    { title: "Create a savings goal", description: "A goal to set money aside for, with an optional target month.", annotations: CREATE },
    { id: newId, ...goal },
    (args) => args.id,
    async (store, args) => {
      if (existing(store.savingsGoals, args.id)) return { goal_id: args.id, already_existed: true }
      const saved = await saveSavingsGoal(store, goalDraft(args))
      store.renameId(saved.id, args.id)
      return { goal_id: args.id, name: saved.name }
    }
  )

  tool(
    "update_savings_goal",
    { title: "Edit a savings goal", description: "Changes a goal; send every field (read it first with list_savings_goals).", annotations: WRITE },
    { goal_id: ref("From list_savings_goals"), ...goal },
    (args) => JSON.stringify(args),
    async (store, args) => {
      find(store.savingsGoals, args.goal_id, "Goal")
      const saved = await saveSavingsGoal(store, goalDraft(args, args.goal_id))
      return { goal_id: saved.id }
    }
  )

  tool(
    "move_savings_goal_money",
    { title: "Add to or take from a savings goal", description: "Sets money aside in a goal (add) or takes it back (withdraw, never more than saved). Nothing moves between accounts.", annotations: WRITE },
    { goal_id: ref("From list_savings_goals"), direction: z.enum(["add", "withdraw"]), amount: decimal },
    (args) => JSON.stringify(args),
    async (store, args) => {
      const saved = args.direction === "add" ? await addToSavingsGoal(store, args.goal_id, args.amount) : await withdrawFromSavingsGoal(store, args.goal_id, args.amount)
      return { goal_id: saved.id, saved: saved.saved }
    }
  )

  tool(
    "delete_savings_goal",
    { title: "Delete a savings goal", description: "Deletes a goal. Can be undone with restore_deleted.", annotations: DELETE },
    { goal_id: ref("From list_savings_goals") },
    (args) => args.goal_id,
    async (store, args) => deleteSavingsGoal(store, args.goal_id),
    (store, args) => `Goal ${find(store.savingsGoals, args.goal_id, "Goal").name}`
  )

  // Loans and personal debts -------------------------------------------------------------------

  const loan = { name: z.string().min(1).max(60), lender: z.string().max(60).default(""), borrowed_amount: decimal, currency, installment_amount: decimal, installment_count: z.number().int().min(1).max(600), frequency: LoanFrequency, first_due_date: instant }
  const loanDraft = (args: { name: string; lender: string; borrowed_amount: string; currency: string; installment_amount: string; installment_count: number; frequency: z.infer<typeof LoanFrequency>; first_due_date: string }, zone: string, id?: string) => ({
    ...(id ? { id } : {}),
    name: args.name,
    lender: args.lender,
    borrowedAmount: args.borrowed_amount,
    currency: args.currency.toUpperCase(),
    installmentAmount: args.installment_amount,
    installmentCount: args.installment_count,
    frequency: args.frequency,
    firstDueDate: instantIn(args.first_due_date, zone),
  })

  tool(
    "create_loan",
    { title: "Create a loan", description: "A loan the person pays in installments.", annotations: CREATE },
    { id: newId, ...loan },
    (args) => args.id,
    async (store, args) => {
      if (existing(store.loans, args.id)) return { loan_id: args.id, already_existed: true }
      const saved = await saveLoan(store, loanDraft(args, store.timeZone))
      store.renameId(saved.id, args.id)
      return { loan_id: args.id, name: saved.name }
    }
  )

  tool(
    "update_loan",
    { title: "Edit a loan", description: "Changes a loan; its currency and paid installments stay. Send every field (read it first with list_loans).", annotations: WRITE },
    { loan_id: ref("From list_loans"), ...loan },
    (args) => JSON.stringify(args),
    async (store, args) => {
      find(store.loans, args.loan_id, "Loan")
      const saved = await saveLoan(store, loanDraft(args, store.timeZone, args.loan_id))
      return { loan_id: saved.id }
    }
  )

  tool(
    "pay_loan_installment",
    { title: "Pay a loan installment", description: "Records the next installment as a confirmed expense from an account or card and marks it paid.", annotations: WRITE },
    { loan_id: ref("From list_loans"), account_id: ref("From list_accounts"), card_id: ref("A card of that account").optional(), category_id: ref("From list_categories (an expense category)"), date: instant },
    (args) => JSON.stringify(args),
    async (store, args) => {
      const saved = await payLoanInstallment(store, { loanId: args.loan_id, source: source(args), categoryId: args.category_id, date: instantIn(args.date, store.timeZone) })
      return { loan_id: saved.id, paid: saved.payments.length, of: saved.installmentCount }
    }
  )

  tool(
    "unpay_loan_installment",
    { title: "Undo a loan installment", description: "Marks an installment unpaid again and deletes the expense that paid it.", annotations: DELETE },
    { loan_id: ref("From list_loans"), number: z.number().int().min(1) },
    (args) => `${args.loan_id}|${args.number}`,
    async (store, args) => {
      const saved = await unpayLoanInstallment(store, args.loan_id, args.number)
      return { loan_id: saved.id, paid: saved.payments.length }
    },
    (store, args) => `Installment ${args.number} of ${find(store.loans, args.loan_id, "Loan").name}`
  )

  tool(
    "delete_loan",
    { title: "Delete a loan", description: "Deletes a loan; the expenses that paid installments stay. Can be undone with restore_deleted.", annotations: DELETE },
    { loan_id: ref("From list_loans") },
    (args) => args.loan_id,
    async (store, args) => deleteLoan(store, args.loan_id),
    (store, args) => `Loan ${find(store.loans, args.loan_id, "Loan").name}`
  )

  const debt = {
    person: z.string().min(1).max(60),
    direction: DebtDirection,
    amount: decimal,
    currency,
    date: instant,
    note: z.string().max(500).default(""),
    due_date: instant
      .nullable()
      .optional()
      .describe("When it should be paid back (YYYY-MM-DD, that day in the person's time zone; not before date). The apps remind before it. On update, null removes it and leaving it out keeps it."),
  }
  /** `kept` is the stored due date, used when an update leaves `due_date` out (`null` removes it). */
  const debtDraft = (
    args: { person: string; direction: z.infer<typeof DebtDirection>; amount: string; currency: string; date: string; note: string; due_date?: string | null | undefined },
    zone: string,
    id?: string,
    kept?: string
  ) => {
    const dueDate =
      args.due_date === undefined ? (kept === undefined ? undefined : new Date(kept)) : args.due_date === null ? undefined : instantIn(args.due_date, zone)
    return {
      ...(id ? { id } : {}),
      person: args.person,
      direction: args.direction,
      amount: args.amount,
      currency: args.currency.toUpperCase(),
      date: instantIn(args.date, zone),
      note: args.note,
      ...(dueDate === undefined ? {} : { dueDate }),
    }
  }

  tool(
    "create_personal_debt",
    { title: "Record a personal debt", description: "Money the person owes someone, or someone owes the person.", annotations: CREATE },
    { id: newId, ...debt },
    (args) => args.id,
    async (store, args) => {
      if (existing(store.personalDebts, args.id)) return { debt_id: args.id, already_existed: true }
      const saved = await savePersonalDebt(store, debtDraft(args, store.timeZone))
      store.renameId(saved.id, args.id)
      return { debt_id: args.id, person: saved.person }
    }
  )

  tool(
    "update_personal_debt",
    { title: "Edit a personal debt", description: "Changes a debt; its repayments stay. Send every field (read it first with list_personal_debts), except due_date, which is kept when left out.", annotations: WRITE },
    { debt_id: ref("From list_personal_debts"), ...debt },
    (args) => JSON.stringify(args),
    async (store, args) => {
      const current = find(store.personalDebts, args.debt_id, "Debt")
      const saved = await savePersonalDebt(store, debtDraft(args, store.timeZone, args.debt_id, current.dueDate))
      return { debt_id: saved.id }
    }
  )

  tool(
    "update_personal_debt_status",
    { title: "Repay, settle or reopen a personal debt", description: "repay records a partial repayment (never more than what remains); settle marks it settled; reopen undoes that.", annotations: WRITE },
    { debt_id: ref("From list_personal_debts"), action: z.enum(["repay", "settle", "reopen"]), amount: decimal.optional().describe("repay only"), date: instant.optional() },
    (args) => JSON.stringify(args),
    async (store, args, now) => {
      const day = args.date ? instantIn(args.date, store.timeZone) : now
      if (args.action === "repay") {
        if (!args.amount) throw new ManageError("invalid", "repay needs an amount")
        await repayPersonalDebt(store, args.debt_id, args.amount, day)
      } else if (args.action === "settle") await settlePersonalDebt(store, args.debt_id, day)
      else await reopenPersonalDebt(store, args.debt_id)
      return { debt_id: args.debt_id, action: args.action }
    }
  )

  tool(
    "delete_personal_debt",
    { title: "Delete a personal debt", description: "Deletes a debt and its repayments. Can be undone with restore_deleted.", annotations: DELETE },
    { debt_id: ref("From list_personal_debts") },
    (args) => args.debt_id,
    async (store, args) => deletePersonalDebt(store, args.debt_id),
    (store, args) => `Debt with ${find(store.personalDebts, args.debt_id, "Debt").person}`
  )

  // Categorization rules ----------------------------------------------------------------------

  tool(
    "create_categorization_rule",
    { title: "Create a categorization rule", description: "Movements whose description or note contains `match` get this category (and tags). apply_to_past also recategorizes existing ones.", annotations: CREATE },
    {
      id: newId,
      match: z.string().min(1).max(60),
      category_id: ref("From list_categories"),
      kind: categoryKind,
      tags: tags.optional(),
      merchant_id: ref("From list_merchants: the business it sets on movements that name none yet").optional(),
      apply_to_past: z.boolean().default(false),
    },
    (args) => args.id,
    async (store, args) => {
      if (existing(store.categorizationRules, args.id)) return { rule_id: args.id, already_existed: true }
      const rule = await saveCategorizationRule(store, { match: args.match, categoryId: args.category_id, kind: args.kind, ...(args.tags ? { tags: args.tags } : {}), ...(args.merchant_id ? { merchantId: merchantLink(store, args.merchant_id) } : {}) })
      store.renameId(rule.id, args.id)
      const applied = args.apply_to_past ? await applyRuleToPast(store, { ...rule, id: args.id }) : 0
      return { rule_id: args.id, applied_to_past: applied }
    }
  )

  tool(
    "update_categorization_rule",
    { title: "Edit a categorization rule", description: "Changes a rule's match, category, tags or merchant (merchant_id stays when left out; null removes it).", annotations: WRITE },
    {
      rule_id: ref("From list_categorization_rules"),
      match: z.string().min(1).max(60),
      category_id: ref("From list_categories"),
      kind: categoryKind,
      tags: tags.optional(),
      merchant_id: ref("From list_merchants").nullable().optional(),
    },
    (args) => JSON.stringify(args),
    async (store, args) => {
      const current = find(store.categorizationRules, args.rule_id, "Rule")
      // Left out, the stored merchant stays only while it exists: one deleted since is dropped, as the
      // apps do, instead of refusing to save the rule.
      const merchantId =
        args.merchant_id === undefined ? (current.merchantId !== undefined && store.merchants.some((merchant) => merchant.id === current.merchantId) ? current.merchantId : undefined) : (merchantLink(store, args.merchant_id) ?? undefined)
      const rule = await saveCategorizationRule(store, { id: args.rule_id, match: args.match, categoryId: args.category_id, kind: args.kind, ...(args.tags ? { tags: args.tags } : {}), ...(merchantId ? { merchantId } : {}) })
      return { rule_id: rule.id }
    }
  )

  tool(
    "delete_categorization_rule",
    { title: "Delete a categorization rule", description: "Deletes a rule; movements it already categorized stay as they are. Can be undone with restore_deleted.", annotations: DELETE },
    { rule_id: ref("From list_categorization_rules") },
    (args) => args.rule_id,
    async (store, args) => deleteCategorizationRule(store, args.rule_id),
    (store, args) => `Rule “${find(store.categorizationRules, args.rule_id, "Rule").match}”`
  )

  // Merchants ----------------------------------------------------------------------------------

  const merchantFields = {
    domain: z.string().max(253).describe("Its web domain (subway.com), where its logo comes from; an address is reduced to its domain"),
    default_category_id: ref("From list_categories (expense or income): the category a new movement with it takes when given none"),
    is_platform: z.boolean().describe("A platform movements go through (Uber Eats, Apple), offered first as via"),
  }

  tool(
    "create_merchant",
    { title: "Create a merchant", description: "A business (Subway) or platform (Uber Eats) movements can name. One with the same name (any case or accents) or domain is used instead of making a second.", annotations: CREATE },
    { id: newId, name: z.string().min(1).max(60), domain: merchantFields.domain.optional(), default_category_id: merchantFields.default_category_id.optional(), is_platform: merchantFields.is_platform.optional() },
    (args) => args.id,
    async (store, args) => {
      if (existing(store.merchants, store.merchantId(args.id))) return { merchant_id: store.merchantId(args.id), already_existed: true }
      const before = new Set(store.merchants.map((merchant) => merchant.id))
      const merchant = await createMerchant(store, {
        name: args.name,
        ...(args.domain ? { domain: args.domain } : {}),
        ...(args.default_category_id ? { defaultCategoryId: args.default_category_id } : {}),
        ...(args.is_platform === undefined ? {} : { isPlatform: args.is_platform }),
      })
      if (before.has(merchant.id)) {
        // The same merchant already exists: the caller's id names it for the rest of the batch, and
        // it takes the domain and default category given where it has none (what it has stays).
        store.aliasMerchant(args.id, merchant.id)
        const domain = merchant.domain ?? args.domain
        const category = merchant.defaultCategoryId ?? args.default_category_id
        const filled =
          domain === merchant.domain && category === merchant.defaultCategoryId
            ? merchant
            : await saveMerchant(store, {
                id: merchant.id,
                name: merchant.name,
                ...(domain ? { domain } : {}),
                ...(merchant.brandId ? { brandId: merchant.brandId } : {}),
                ...(category ? { defaultCategoryId: category } : {}),
                isPlatform: merchant.isPlatform,
              })
        return { merchant_id: filled.id, name: filled.name, already_existed: true, ...(filled === merchant ? {} : { domain: filled.domain ?? null, default_category_id: filled.defaultCategoryId ?? null }) }
      }
      store.renameId(merchant.id, args.id)
      return { merchant_id: args.id, name: merchant.name, domain: merchant.domain ?? null }
    }
  )

  tool(
    "update_merchant",
    { title: "Edit a merchant", description: "Renames a merchant or sets its domain, default category or whether it is a platform; fields left out stay, null removes one. Every movement naming it shows the change.", annotations: WRITE },
    {
      merchant_id: ref("From list_merchants"),
      name: z.string().min(1).max(60).optional(),
      domain: merchantFields.domain.nullable().optional(),
      default_category_id: merchantFields.default_category_id.nullable().optional(),
      is_platform: merchantFields.is_platform.optional(),
    },
    (args) => JSON.stringify(args),
    async (store, args) => {
      const current = findMerchant(store, args.merchant_id)
      const domain = args.domain === undefined ? current.domain : (args.domain ?? undefined)
      const category = args.default_category_id === undefined ? current.defaultCategoryId : (args.default_category_id ?? undefined)
      const saved = await saveMerchant(store, {
        id: current.id,
        name: args.name ?? current.name,
        ...(domain ? { domain } : {}),
        ...(current.brandId ? { brandId: current.brandId } : {}),
        ...(category ? { defaultCategoryId: category } : {}),
        ...(args.is_platform === undefined ? {} : { isPlatform: args.is_platform }),
      })
      return { merchant_id: saved.id, name: saved.name, domain: saved.domain ?? null, default_category_id: saved.defaultCategoryId ?? null, is_platform: saved.isPlatform }
    }
  )

  tool(
    "merge_merchants",
    {
      title: "Merge two merchants",
      description: "Merges a duplicate into another: whatever named from_merchant_id (movements, recurring payments, rules) names into_merchant_id, which keeps its fields and takes the duplicate's where it has none. The duplicate is deleted. Can be undone with restore_deleted.",
      annotations: DELETE,
    },
    { from_merchant_id: ref("From list_merchants: the duplicate, deleted"), into_merchant_id: ref("From list_merchants: the one that stays") },
    (args) => `${args.from_merchant_id}|${args.into_merchant_id}`,
    async (store, args) => {
      const merged = await mergeMerchants(store, store.merchantId(args.from_merchant_id), store.merchantId(args.into_merchant_id))
      return { merchant_id: merged.id, name: merged.name }
    },
    (store, args) => `Merchant ${findMerchant(store, args.from_merchant_id).name} (merged into ${findMerchant(store, args.into_merchant_id).name})`
  )

  tool(
    "delete_merchant",
    { title: "Delete a merchant", description: "Deletes a merchant; movements and rules that named it keep everything else and name no merchant, as in the app. Can be undone with restore_deleted.", annotations: DELETE },
    { merchant_id: ref("From list_merchants") },
    (args) => args.merchant_id,
    async (store, args) => deleteMerchant(store, store.merchantId(args.merchant_id)),
    (store, args) => `Merchant ${findMerchant(store, args.merchant_id).name}`
  )

  // Settings -----------------------------------------------------------------------------------

  tool(
    "update_settings",
    {
      title: "Change currencies, reminders and time zone",
      description:
        "Set the rate (affects movements recorded from now on), swap the two currencies, set or remove the second currency (only while no balance or movement uses it), change the principal currency (only with no accounts or movements yet), or the days before a payment to remind, or the person's home time zone (what \"today\" and month ends mean).",
      annotations: WRITE,
    },
    {
      rate: decimal.optional().describe("Second currency units per principal unit"),
      swap: z.boolean().optional(),
      second_currency: currency.nullable().optional(),
      principal_currency: currency.optional(),
      payment_reminder_days_before: z.number().int().min(0).max(60).optional(),
      time_zone: z.string().max(64).refine(isTimeZone, "an IANA time zone such as America/Managua").optional().describe("IANA name; only when the person asks to change it"),
    },
    (args) => JSON.stringify(args),
    async (store, args) => {
      const uses = (code: string) =>
        store.accounts.some((account) => account.openingBalances.some((balance) => balance.currency === code && !dec(balance.amount).isZero())) || store.transactions.some((transaction) => transaction.currency === code)
      const saved = await updateSettings(store, (settings) => {
        let next = settings
        if (args.principal_currency && args.principal_currency.toUpperCase() !== next.currencies.principal) {
          if (store.accounts.length > 0 || store.transactions.length > 0) throw new ManageError("invalid", "The principal currency can only change before there are accounts or movements.")
          next = { ...next, currencies: currencySettings(args.principal_currency.toUpperCase(), next.currencies.second, next.currencies.rate) }
        }
        if (args.second_currency !== undefined) {
          const wanted = args.second_currency?.toUpperCase()
          const current = next.currencies.second
          if (wanted !== current) {
            if (current && uses(current)) throw new ManageError("invalid", `${current} is in use by a balance or a movement, so it can't be changed.`)
            next = { ...next, currencies: currencySettings(next.currencies.principal, wanted, wanted ? (args.rate ?? next.currencies.rate) : 1) }
          }
        }
        if (args.swap) next = swapCurrencies(next)
        if (args.rate) next = { ...next, currencies: withRate(next.currencies, args.rate) }
        if (args.payment_reminder_days_before !== undefined) next = { ...next, paymentReminderDaysBefore: args.payment_reminder_days_before }
        if (args.time_zone) next = { ...next, timeZone: args.time_zone }
        return next
      })
      return { currencies: saved.currencies, payment_reminder_days_before: saved.paymentReminderDaysBefore, time_zone: saved.timeZone ?? store.timeZone }
    }
  )

  // Batches ------------------------------------------------------------------------------------

  // Deletes (and merges, which delete one merchant) stay one by one: each is destructive, so Claude asks about each.
  // import_transactions neither: it has its own preview (dry_run) and ids derived from each line.
  const batchable = [...specs.keys()].filter((name) => !name.startsWith("delete_") && name !== "unpay_loan_installment" && name !== "merge_merchants" && name !== "import_transactions")
  registerAppTool(
    server,
    "apply_changes",
    {
      title: "Make several changes at once",
      description:
        "Runs up to 100 of the other tools (except deletes) in order, as one change: all saved or none, one card in the chat, much faster than one call each. Use it whenever there is more than one thing to create or edit, e.g. several movements, or an account and its movements. A step may use an id a previous step created (give creates your own `id`).",
      inputSchema: {
        changes: z
          .array(z.object({ tool: z.enum(batchable as [string, ...string[]]), arguments: z.record(z.string(), z.unknown()) }))
          .min(1)
          .max(100),
        lang,
      },
      annotations: { ...CREATE, idempotentHint: true },
      _meta: { ui: { resourceUri: VIEWS_URI } },
    },
    (async (args: { changes: { tool: string; arguments: Record<string, unknown> }[] }) => {
      try {
        const steps = args.changes.map((change, index) => {
          const spec = specs.get(change.tool)!
          const parsed = z.object(spec.input).safeParse(change.arguments)
          if (!parsed.success) throw new ManageError("invalid", `changes[${index}] (${change.tool}): ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
          return { tool: change.tool, spec, args: parsed.data as Record<string, unknown> }
        })
        const keepIds = steps.flatMap((step) => (typeof step.args.id === "string" ? [step.args.id] : []))
        const { result, changes } = await manage.run(userId, clientId, { key: `apply_changes|${JSON.stringify(args.changes)}`, keepIds }, async (store, now) => {
          const results: Record<string, unknown>[] = []
          for (const [index, step] of steps.entries()) {
            try {
              const done = await step.spec.operation(store, step.args as never, now)
              results.push({ tool: step.tool, ...(done && typeof done === "object" ? (done as Record<string, unknown>) : {}) })
            } catch (error) {
              // All or nothing: nothing is written until every step passed.
              const message = error instanceof Error ? error.message : "failed"
              throw new ManageError(error instanceof ManageError ? error.code : "invalid", `changes[${index}] (${step.tool}): ${message}. Nothing was saved.`)
            }
          }
          return results
        })
        const data = { ok: true, results: result, changes }
        log.info({ mcp_tool: "apply_changes", client_id: clientId, ok: true, steps: steps.length, created: changes.created, updated: changes.updated }, "mcp manage")
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } satisfies CallToolResult
      } catch (error) {
        const code = error instanceof ManageError ? error.code : "failed"
        log.warn({ mcp_tool: "apply_changes", client_id: clientId, ok: false, code }, "mcp manage refused")
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message: error instanceof Error ? error.message : "Not saved" }) }] } satisfies CallToolResult
      }
    }) as never
  )

  // Trash --------------------------------------------------------------------------------------

  server.registerTool(
    "list_deleted",
    { title: "List what can be restored", description: "Deletes made by an assistant in the last 30 days that restore_deleted can undo, newest first.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } },
    (async () => {
      const entries = await manage.trash(userId)
      const data = { deleted: entries.map((entry) => ({ trash_id: entry.id, what: entry.label, deleted_at: entry.createdAt.toISOString() })) }
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } satisfies CallToolResult
    }) as never
  )

  server.registerTool(
    "restore_deleted",
    { title: "Undo a delete", description: "Brings back what one delete took away (from list_deleted). Restored records get new ids; movements whose account is gone stay deleted.", inputSchema: { trash_id: ref("From list_deleted") }, annotations: { ...WRITE, idempotentHint: true } },
    (async (args: { trash_id: string }) => {
      try {
        const restored = await manage.restore(userId, clientId, args.trash_id)
        const data = { ok: true, restored: restored.label, new_ids: restored.ids, changes: restored.changes, skipped: restored.skipped }
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } satisfies CallToolResult
      } catch (error) {
        const code = error instanceof ManageError ? error.code : "failed"
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message: error instanceof Error ? error.message : "Not restored" }) }] } satisfies CallToolResult
      }
    }) as never
  )
}
