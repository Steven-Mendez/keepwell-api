import DecimalJS from "decimal.js"
import { z } from "zod"

import {
  CurrencyCode,
  DecimalString,
  Id,
  IsoDateTime,
  PositiveDecimalString,
  RecordSource,
  TimeZoneId,
  TransactionKind,
  TransactionStatus,
  isPositiveDecimal,
} from "./primitives"

// Domain entities, mirroring keepwell-ios Packages/Domain/Sources/Domain/Entities. Field names and
// enum values match iOS exactly so the backup file and a future sync map one to one.

/** An amount with its currency. Never summed across currencies without an exchange rate. */
export const Money = z.object({
  amount: DecimalString,
  currency: CurrencyCode,
})
export type Money = z.infer<typeof Money>

/** "1 principal = rate second". Each movement keeps the rate it was recorded with. */
export const ExchangeRate = z.object({
  principal: CurrencyCode,
  second: CurrencyCode,
  rate: PositiveDecimalString,
})
export type ExchangeRate = z.infer<typeof ExchangeRate>

export const AccountKind = z.enum(["deposit", "cash", "credit"])
export type AccountKind = z.infer<typeof AccountKind>

/** How a credit card bills: separate debts per currency, all in principal, or all in second. */
export const DebtMode = z.enum(["dual", "principal", "second"])
export type DebtMode = z.infer<typeof DebtMode>

/** Day of month 1–31; short months clamp to their last day. */
const DayOfMonth = z.number().int().min(1).max(31)

export const CreditTerms = z.object({
  debtMode: DebtMode,
  limit: Money.optional(),
  cutoffDay: DayOfMonth.optional(),
  dueDay: DayOfMonth.optional(),
})
export type CreditTerms = z.infer<typeof CreditTerms>

export const Account = z.object({
  id: Id,
  name: z.string(),
  bank: z.string().optional(),
  kind: AccountKind,
  /** Balances on `openingDate`, one per currency the account holds. Signed: credit debts are negative. */
  openingBalances: z.array(Money),
  /** Movements dated before this day are already part of `openingBalances`. */
  openingDate: IsoDateTime,
  creditTerms: CreditTerms.optional(),
  /**
   * When it was closed (`closeAccount`); absent while open. A closed account keeps its movements and
   * still counts in totals, but leaves lists and pickers until it is reopened.
   */
  closedAt: IsoDateTime.optional(),
})
export type Account = z.infer<typeof Account>

export const CardKind = z.enum(["debit", "creditHolder", "transfer"])
export type CardKind = z.infer<typeof CardKind>

export const CardNetwork = z.enum(["visa", "mastercard", "amex", "other"])
export type CardNetwork = z.infer<typeof CardNetwork>

/** Card art palette by name. `violeta`, `coral` and `lima` are no longer offered but still stored. */
export const CardColor = z.enum([
  "azul",
  "grafito",
  "platino",
  "verde",
  "violeta",
  "coral",
  "rojo",
  "oro",
  "lima",
])
export type CardColor = z.infer<typeof CardColor>

/** The "valid thru" printed on a plastic: month and year only. */
export const CardExpiry = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2199),
})
export type CardExpiry = z.infer<typeof CardExpiry>

export const Card = z.object({
  id: Id,
  accountId: Id,
  kind: CardKind,
  network: CardNetwork.optional(),
  lastFour: z
    .string()
    .regex(/^[0-9]{4}$/, "Last four must be four digits")
    .optional(),
  color: CardColor.optional(),
  /** The bank's name for the plastic ("Premia"). The card repository trims it and drops a blank one, as iOS does. */
  productName: z.string().optional(),
  expiry: CardExpiry.optional(),
})
export type Card = z.infer<typeof Card>

/** A statement line's id: the bank's (FITID, reference) or `kw1:` and a hash (`importedLineIds`). */
export const MAX_IMPORTED_ID_LENGTH = 128
export const ImportedId = z.string().min(1).max(MAX_IMPORTED_ID_LENGTH)

/**
 * A movement. `amount` is always positive and `kind` carries the direction, so a mis-signed value
 * can't flip an expense into income (iOS `Transaction.checkAmounts`).
 */
export const Transaction = z.object({
  id: Id,
  date: IsoDateTime,
  status: TransactionStatus,
  description: z.string(),
  kind: TransactionKind,
  /** Absent for transfers, which have no category. */
  categoryId: z.string().optional(),
  amount: PositiveDecimalString,
  currency: CurrencyCode,
  /** Source account, derived from the payment method when there is one. */
  accountId: Id,
  cardId: Id.optional(),
  /** Transfers only. */
  destinationAccountId: Id.optional(),
  /** What the bank actually charged in the principal currency, when it used its own rate. */
  actualDebitedPrincipal: DecimalString.refine(
    isPositiveDecimal,
    "Must be greater than zero"
  ).optional(),
  exchangeRate: ExchangeRate,
  isShared: z.boolean(),
  note: z.string().optional(),
  /** The recurring rule that produced it; may point at a deleted rule. */
  recurringId: Id.optional(),
  /** Normalized tags (`normalizedTag`), each once; left out when there are none. */
  tags: z.array(z.string()).optional(),
  /** `mcp` when Claude (or another MCP client) recorded it; absent means `app`. Kept on confirm. */
  source: RecordSource.optional(),
  /**
   * The bank's id for the statement line it came from (or one `matchIncoming` derived), so importing
   * the same statement again finds it instead of duplicating it. Set by an import, never typed; an
   * edit keeps it.
   */
  importedId: ImportedId.optional(),
})
export type Transaction = z.infer<typeof Transaction>

/** How often a recurring rule repeats; `interval` says every how many of these. */
export const RecurringFrequency = z.enum(["weekly", "monthly", "yearly"])
export type RecurringFrequency = z.infer<typeof RecurringFrequency>

export const MAX_RECURRING_INTERVAL = 99

/**
 * A template that produces a movement on a schedule (shared contract with iOS `RecurringRule`).
 * Occurrences are computed from `startDate`, the anchor, never chained from a clamped date.
 */
export const RecurringRule = z.object({
  id: Id,
  /** Becomes each movement's description. */
  name: z.string(),
  kind: TransactionKind,
  /** Absent for transfers, as on a movement. */
  categoryId: z.string().optional(),
  amount: PositiveDecimalString,
  currency: CurrencyCode,
  /** Source account, derived from the card when there is one. */
  accountId: Id,
  cardId: Id.optional(),
  /** Transfers only. */
  destinationAccountId: Id.optional(),
  frequency: RecurringFrequency,
  interval: z.number().int().min(1).max(MAX_RECURRING_INTERVAL),
  /** The first occurrence; its time of day is kept on every occurrence. */
  startDate: IsoDateTime,
  /** The next occurrence not yet turned into a movement. */
  nextDate: IsoDateTime,
  /** The last day an occurrence may fall on, inclusive by calendar day. */
  endDate: IsoDateTime.optional(),
  isSubscription: z.boolean(),
  /** Occurrences are saved confirmed; otherwise as drafts (`planned`). */
  autoConfirm: z.boolean(),
  /** Paused rules produce nothing and keep `nextDate` frozen. */
  isPaused: z.boolean(),
  note: z.string().optional(),
  /** Copied to each movement it records; left out when there are none. */
  tags: z.array(z.string()).optional(),
  source: RecordSource.optional(),
})
export type RecurringRule = z.infer<typeof RecurringRule>

export const MAX_RULE_MATCH_LENGTH = 60

/**
 * "If it says Uber → Transport" (iOS `CategorizationRule`): a new movement whose description or note
 * contains `match` gets `categoryId` (and `tags`) when the person hasn't picked a category. Rules are
 * ordered by the repository; the first that matches wins.
 */
export const CategorizationRule = z.object({
  id: Id,
  /** Compared without case or accents, anywhere in the description or note. */
  match: z.string().refine((text) => text.trim() !== "", "Can't be empty"),
  categoryId: z.string(),
  kind: z.enum(["expense", "income"]),
  /** Added to the movement; left out when there are none. */
  tags: z.array(z.string()).optional(),
})
export type CategorizationRule = z.infer<typeof CategorizationRule>

/** A goal's deadline: a month, not a day, so it reads the same in every time zone. */
export const TargetMonth = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2199),
})
export type TargetMonth = z.infer<typeof TargetMonth>

export const MAX_GOAL_NAME_LENGTH = 60

/**
 * Money set aside for something ("Trip: C$15,000 by December"), shared contract with iOS
 * `SavingsGoal`. What is saved is only tracked here: it never moves money between accounts.
 */
export const SavingsGoal = z.object({
  id: Id,
  name: z.string(),
  target: Money.refine(
    (target) => isPositiveDecimal(target.amount),
    "Must be greater than zero"
  ),
  /** In the target's currency; never negative. */
  saved: DecimalString.refine(
    (value) => !value.trim().startsWith("-"),
    "Can't be negative"
  ),
  targetMonth: TargetMonth.optional(),
  /** A symbol from the category symbol choices. */
  icon: z.string().optional(),
  /** A key into the category palette. */
  color: z.string().optional(),
})
export type SavingsGoal = z.infer<typeof SavingsGoal>

export const LoanFrequency = z.enum(["weekly", "monthly"])
export type LoanFrequency = z.infer<typeof LoanFrequency>

export const MAX_LOAN_NAME_LENGTH = 60
export const MAX_DEBT_NAME_LENGTH = 60
/** Fifty years of monthly installments (iOS `Loan.installmentCountRange`). */
export const MAX_LOAN_INSTALLMENTS = 600

/** One paid installment and the movement that paid it. */
export const LoanPayment = z.object({
  /** `loanPaymentId(loan, number)`; older backups lack it and get it when read. */
  id: Id.optional(),
  number: z.number().int().min(1),
  paidAt: IsoDateTime,
  transactionId: Id.optional(),
})
export type LoanPayment = z.infer<typeof LoanPayment>

/**
 * A bank or personal loan paid off in equal installments, shared contract with iOS `Loan`. Paying an
 * installment records a real expense; the loan only keeps the schedule and which installments are paid.
 */
export const LoanShape = z.object({
  id: Id,
  name: z.string(),
  lender: z.string().optional(),
  borrowed: Money.refine(
    (value) => isPositiveDecimal(value.amount),
    "Must be greater than zero"
  ),
  /** In `borrowed`'s currency. */
  installmentAmount: PositiveDecimalString,
  installmentCount: z.number().int().min(1).max(MAX_LOAN_INSTALLMENTS),
  frequency: LoanFrequency,
  firstDueDate: IsoDateTime,
  /** By installment number. */
  payments: z.array(LoanPayment),
})

/** Each payment names a distinct installment of the schedule (iOS `Loan.check`). */
export function loanPaymentsFit(
  loan: Pick<z.infer<typeof LoanShape>, "payments" | "installmentCount">
): boolean {
  const numbers = loan.payments.map((payment) => payment.number)
  return (
    new Set(numbers).size === numbers.length &&
    numbers.every((number) => number <= loan.installmentCount)
  )
}

export const Loan = LoanShape.refine(
  loanPaymentsFit,
  "Payments must name distinct installments of the schedule"
)
export type Loan = z.infer<typeof Loan>

export const DebtDirection = z.enum(["theyOweMe", "iOwe"])
export type DebtDirection = z.infer<typeof DebtDirection>

export const DebtRepayment = z.object({
  /** Older backups lack it and get `legacyRepaymentId` when read. */
  id: Id.optional(),
  /** In the debt's currency. */
  amount: PositiveDecimalString,
  date: IsoDateTime,
})
export type DebtRepayment = z.infer<typeof DebtRepayment>

/**
 * Money lent to or borrowed from a person, shared contract with iOS `PersonalDebt`. Only tracked:
 * it never records a movement or changes a balance.
 */
export const PersonalDebtShape = z.object({
  id: Id,
  person: z.string(),
  direction: DebtDirection,
  amount: Money.refine(
    (value) => isPositiveDecimal(value.amount),
    "Must be greater than zero"
  ),
  date: IsoDateTime,
  note: z.string().optional(),
  /** Oldest first. */
  repayments: z.array(DebtRepayment),
  /** By the last repayment or by hand; absent while open. */
  settledAt: IsoDateTime.optional(),
  /** The expense it was split from. */
  transactionId: Id.optional(),
  /**
   * When it should be paid back, the start of that day; absent for a debt without one. Never
   * before `date` (`savePersonalDebt`).
   */
  dueDate: IsoDateTime.optional(),
})

/** Repayments never add up past the amount (iOS `PersonalDebt.checkAmounts`). */
export function debtRepaymentsFit(
  debt: Pick<z.infer<typeof PersonalDebtShape>, "repayments" | "amount">
): boolean {
  return debt.repayments
    .reduce((sum, repayment) => sum.plus(repayment.amount), new DecimalJS(0))
    .lte(debt.amount.amount)
}

export const PersonalDebt = PersonalDebtShape.refine(
  debtRepaymentsFit,
  "Repayments can't add up past the amount"
)
export type PersonalDebt = z.infer<typeof PersonalDebt>

export const UnlockMethod = z.enum(["biometrics", "passcode", "disabled"])
export type UnlockMethod = z.infer<typeof UnlockMethod>

/**
 * Principal currency, optional second and the manual rate. A second equal to the principal means
 * single-currency mode, where the rate is always 1 (iOS `CurrencySettings.init`).
 */
export const CurrencySettings = z
  .object({
    principal: CurrencyCode,
    second: CurrencyCode.optional(),
    rate: PositiveDecimalString,
  })
  .transform(({ principal, second, rate }) => {
    const effectiveSecond = second === principal ? undefined : second
    return effectiveSecond === undefined
      ? { principal, rate: "1" }
      : { principal, second: effectiveSecond, rate }
  })
export type CurrencySettings = z.infer<typeof CurrencySettings>

export const Settings = z.object({
  currencies: CurrencySettings,
  unlockMethod: UnlockMethod,
  /** Seconds in the background before the lock is asked again. */
  relockAfterSeconds: z.number().nonnegative(),
  hidesAmountsInAppSwitcher: z.boolean(),
  isICloudBackupEnabled: z.boolean(),
  paymentReminderDaysBefore: z.number().int().nonnegative(),
  hasCompletedOnboarding: z.boolean(),
  /**
   * The person's home time zone: the one the server uses for "today", month boundaries and recurring
   * occurrences. Set once from the device when missing and changed by hand in Settings, never
   * updated on its own, so two devices in different zones don't keep flipping it. The apps still
   * show days in the device's zone.
   */
  timeZone: TimeZoneId.optional(),
})
export type Settings = z.infer<typeof Settings>

/** iOS `Settings.init` defaults, before onboarding saves real ones. */
export const DEFAULT_SETTINGS: Settings = {
  currencies: { principal: "USD", rate: "1" },
  unlockMethod: "biometrics",
  relockAfterSeconds: 60,
  hidesAmountsInAppSwitcher: true,
  isICloudBackupEnabled: true,
  paymentReminderDaysBefore: 3,
  hasCompletedOnboarding: false,
}

/** Single-currency mode stores the principal as both currencies at rate 1. */
export function hasSecondCurrency(rate: ExchangeRate): boolean {
  return rate.second !== rate.principal
}
