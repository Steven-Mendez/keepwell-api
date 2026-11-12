import type { Account, Card, CardColor, CardKind, CardNetwork, Transaction, TransactionCategory, TransactionKind } from "@/lib/schema"
import { LOAN_PAYMENTS_ID, OTHER_EXPENSE_ID, OTHER_INCOME_ID } from "@/lib/schema"
import { accountDisplayName, amountIn, isConfirmed, rateHasSecondCurrency, translatesById } from "@/lib/domain"
import { formatAmount } from "@/lib/domain/format"
import type { Translator } from "@/lib/i18n"

// Ports of SharedPresentation (CategoryDisplay, CardDisplay, TransactionDisplay): how categories,
// cards and movements read, shared by every screen so a movement never reads differently.

const DEFAULT_SYMBOLS: Record<string, string> = {
  groceries: "cart",
  restaurants: "fork.knife",
  transport: "bus",
  housing: "house",
  utilities: "bolt",
  health: "cross.case",
  education: "graduationcap",
  leisure: "theatermasks",
  shopping: "bag",
  subscriptions: "arrow.triangle.2.circlepath",
  "personal-care": "scissors",
  family: "figure.2.and.child.holdinghands",
  travel: "airplane",
  fees: "building.columns",
  tools: "wrench.and.screwdriver",
  pets: "pawprint",
  gifts: "gift",
  insurance: "umbrella",
  taxes: "doc.text",
  savings: "banknote",
  donations: "heart.circle",
  [LOAN_PAYMENTS_ID]: "calendar.badge.clock",
  [OTHER_EXPENSE_ID]: "square.grid.2x2",
  salary: "briefcase",
  freelance: "laptopcomputer",
  extra: "star",
  interest: "percent",
  investments: "chart.line.uptrend.xyaxis",
  rental: "key",
  "gifts-received": "giftcard",
  refunds: "arrow.uturn.backward",
  [OTHER_INCOME_ID]: "tray.and.arrow.down",
}

export const FALLBACK_SYMBOL = "square.grid.2x2"

export function categorySymbol(category: TransactionCategory | undefined): string {
  if (!category) return FALLBACK_SYMBOL
  return category.icon ?? DEFAULT_SYMBOLS[category.id] ?? FALLBACK_SYMBOL
}

/** Palette keys people pick from, in the editor's order (`KWColor.categoryPalette`). */
export const CATEGORY_COLOR_KEYS = ["blue", "purple", "pink", "orange", "amber", "yellow", "lime", "green", "cyan", "gray"] as const

/** Default categories with a color of their own (`KWColor.category`); the rest are faint. */
const ID_COLORS = new Set(["tools", "restaurants", "fees", "transport", "utilities", "leisure", "shopping", "subscriptions", "education", LOAN_PAYMENTS_ID, OTHER_EXPENSE_ID])

/** A CSS color for the category: the picked palette key, the id's own token, or faint. */
export function categoryColor(category: Pick<TransactionCategory, "id" | "color"> | undefined): string {
  if (category?.color && (CATEGORY_COLOR_KEYS as readonly string[]).includes(category.color)) return `var(--category-${category.color})`
  const id = category?.id ?? OTHER_EXPENSE_ID
  return ID_COLORS.has(id) ? `var(--category-id-${id})` : "var(--text-faint)"
}

export function colorName(t: Translator, key: string): string {
  const names: Record<string, string> = { blue: "Blue", purple: "Purple", pink: "Pink", orange: "Orange", amber: "Amber", yellow: "Yellow", lime: "Lime", green: "Green", cyan: "Cyan" }
  return t.in("sharedpresentation", names[key] ?? "Gray")
}

/** Defaults translate by id until renamed; created and renamed ones show what was typed. */
export function categoryName(t: Translator, category: TransactionCategory): string {
  return translatesById(category) ? t.in("sharedpresentation", category.name) : category.name
}

/** A category id's name when the category may be missing: the built-in "Other" ones read as such, anything else as its id. */
export function categoryNameById(t: Translator, category: TransactionCategory | undefined, id: string): string {
  if (category) return categoryName(t, category)
  if (id === OTHER_EXPENSE_ID) return fallbackCategoryName(t, "expense")
  if (id === OTHER_INCOME_ID) return fallbackCategoryName(t, "income")
  return id
}

export function fallbackCategoryName(t: Translator, kind: TransactionKind): string {
  return t.in("sharedpresentation", kind === "income" ? "Other income" : "Other")
}

// Cards.

/** Colors offered for a card; one no longer offered stays at the end so the picker doesn't change it. */
export const SELECTABLE_CARD_COLORS: readonly CardColor[] = ["grafito", "platino", "oro", "azul", "verde", "rojo"]

export function selectableCardColors(current?: CardColor): CardColor[] {
  return current && !SELECTABLE_CARD_COLORS.includes(current) ? [...SELECTABLE_CARD_COLORS, current] : [...SELECTABLE_CARD_COLORS]
}

export function cardColorName(t: Translator, color: CardColor): string {
  const names: Record<CardColor, string> = { azul: "Blue", grafito: "Black", platino: "Platinum", verde: "Green", violeta: "Violet", coral: "Coral", rojo: "Red", oro: "Gold", lima: "Lime" }
  return t.in("designsystem", names[color])
}

/** Light plastics print dark text. */
export function cardArtIsLight(color: CardColor | undefined): boolean {
  return color === "platino" || color === "oro" || color === "lima"
}

export function networkName(t: Translator, network: CardNetwork | undefined): string {
  switch (network) {
    case "visa":
      return "Visa"
    case "mastercard":
      return "Mastercard"
    case "amex":
      return "Amex"
    default:
      return t.in("sharedpresentation", "network.other")
  }
}

export function cardKindLabel(t: Translator, kind: CardKind): string {
  return t.in("sharedpresentation", kind === "creditHolder" ? "Credit" : "Debit")
}

export const accountName = (account: Pick<Account, "bank" | "name">) => accountDisplayName(account)

/** "Premia ··0633" when the plastic has a product name, else "Mastercard ··4321". */
export function cardShortName(t: Translator, card: Card): string {
  return [card.productName ?? networkName(t, card.network), card.lastFour ? `··${card.lastFour}` : undefined].filter(Boolean).join(" ")
}

/** "09/28", as the plastic prints it. */
export function expiryText(expiry: { month: number; year: number }): string {
  return `${String(expiry.month).padStart(2, "0")}/${String(expiry.year % 100).padStart(2, "0")}`
}

export function debitTitle(t: Translator, card: Card): string {
  return card.lastFour ? t.in("sharedpresentation", "Debit •••• %@", card.lastFour) : t.in("sharedpresentation", "Debit card")
}

export function cardNumber(t: Translator, card: Card): string {
  return [networkName(t, card.network), card.lastFour ? `•••• ${card.lastFour}` : undefined].filter(Boolean).join(" ")
}

export function bankTransferTitle(t: Translator, account: Account | undefined): string {
  const method = t.in("sharedpresentation", "Bank transfer")
  const owner = (account?.bank ?? account?.name)?.trim() ?? ""
  return owner === "" ? method : `${owner} · ${method}`
}

/** How a movement names what paid it: "Debit •••• 3922", "Bank One · Bank transfer", "Visa •••• 3141". */
export function methodTitle(t: Translator, card: Card, account: Account | undefined): string {
  switch (card.kind) {
    case "debit":
      return debitTitle(t, card)
    case "transfer":
      return bankTransferTitle(t, account)
    case "creditHolder":
      return cardNumber(t, card)
  }
}

// Movements.

export type TransactionStyle = "expense" | "income" | "transfer" | "planned"

export interface LedgerLookup {
  accounts: readonly Account[]
  cards: readonly Card[]
  categories: readonly TransactionCategory[]
}

export class TransactionDisplay {
  private readonly accounts: Map<string, Account>
  private readonly cards: Map<string, Card>
  private readonly categories: Map<string, TransactionCategory>

  constructor(
    private readonly t: Translator,
    lookup: LedgerLookup,
  ) {
    this.accounts = new Map(lookup.accounts.map((account) => [account.id, account]))
    this.cards = new Map(lookup.cards.map((card) => [card.id, card]))
    this.categories = new Map(lookup.categories.map((category) => [category.id, category]))
  }

  style(transaction: Transaction): TransactionStyle {
    return isConfirmed(transaction) ? transaction.kind : "planned"
  }

  category(transaction: Transaction): TransactionCategory | undefined {
    return transaction.categoryId ? this.categories.get(transaction.categoryId) : undefined
  }

  categoryName(transaction: Transaction): string | undefined {
    const category = this.category(transaction)
    return category ? categoryName(this.t, category) : undefined
  }

  account(id: string | undefined): Account | undefined {
    return id ? this.accounts.get(id) : undefined
  }

  card(id: string | undefined): Card | undefined {
    return id ? this.cards.get(id) : undefined
  }

  accountName(id: string | undefined): string {
    const account = this.account(id)
    return account ? accountDisplayName(account) : ""
  }

  methodName(transaction: Transaction): string {
    const account = this.account(transaction.accountId)
    const card = this.card(transaction.cardId)
    if (card) return methodTitle(this.t, card, account)
    return account ? accountDisplayName(account) : ""
  }

  /** "Groceries · Debit •••• 3922"; transfers read "Savings → Cash". */
  subtitle(transaction: Transaction): string {
    if (transaction.kind === "transfer") return `${this.accountName(transaction.accountId)} → ${this.accountName(transaction.destinationAccountId)}`
    return [this.categoryName(transaction), this.methodName(transaction)].filter((part) => part).join(" · ")
  }

  /** Signed by direction; transfers carry no sign since they aren't spending. */
  amount(transaction: Transaction): string {
    const signed = transaction.kind === "expense" ? `-${transaction.amount}` : transaction.amount
    return formatAmount(signed, transaction.currency, { sign: transaction.kind === "transfer" ? "never" : "always" })
  }

  /** The other currency: the bank's debit when reported, an estimate ("≈") when planned, else the conversion. */
  secondaryAmount(transaction: Transaction): string | undefined {
    const rate = transaction.exchangeRate
    if (!rateHasSecondCurrency(rate)) return undefined
    const other = transaction.currency === rate.principal ? rate.second : rate.principal
    if (transaction.actualDebitedPrincipal) {
      return this.t.in("sharedpresentation", "%@ debited", formatAmount(transaction.actualDebitedPrincipal, rate.principal))
    }
    const converted = formatAmount(amountIn(transaction, other), other)
    return isConfirmed(transaction) ? converted : `≈ ${converted}`
  }

  /** Text a search matches against: description, note, category (translated and stored) and method. */
  searchableText(transaction: Transaction): string {
    // Tags are searchable as text too: "boda" finds "#boda" among everything else it matches.
    const tags = (transaction.tags ?? []).map((tag) => `#${tag}`)
    return [transaction.description, transaction.note, this.categoryName(transaction), this.category(transaction)?.name, this.subtitle(transaction), ...tags].filter(Boolean).join(" ")
  }
}

// Dates.

export function dayLabel(t: Translator, date: Date, now: Date = new Date()): string {
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const short = date.toLocaleDateString(t.locale, { day: "numeric", month: "short", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })
  if (sameDay(date, now)) return t.in("createtransaction", "Today, %@", short)
  if (sameDay(date, yesterday)) return t.in("createtransaction", "Yesterday, %@", short)
  return date.toLocaleDateString(t.locale, { weekday: "short", day: "numeric", month: "short", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })
}

export function monthName(t: Translator, month: { year: number; month: number }, style: "long" | "short" = "long", withYear = false): string {
  const text = new Date(month.year, month.month - 1, 1).toLocaleDateString(t.locale, { month: style, ...(withYear ? { year: "numeric" } : {}) })
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function shortDate(t: Translator, date: Date): string {
  return date.toLocaleDateString(t.locale, { day: "numeric", month: "short", year: "numeric" })
}
