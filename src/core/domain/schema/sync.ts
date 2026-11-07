import { z } from "zod"

import { CardColor, CardKind, CardNetwork, DebtDirection, DebtMode, LoanFrequency, RecurringFrequency, AccountKind } from "./entities"
import { CurrencyCode, DecimalString, Id, IsoDateTime, PositiveDecimalString, RecordSource, TransactionKind, TransactionStatus } from "./primitives"

// The sync wire format (ADR 0005): each event carries one row as stored, in snake_case, the same
// shape on the web (Dexie), on iOS (SwiftData records) and on the server (DSQL). keepwell-api copies
// this file and validates every pushed event with it; an event that fails is rejected on its own
// and never blocks the rest of the batch.
//
// Columns only the server writes (`user_id`, `server_seq`, `applied_at`) are not here: `z.object`
// drops unknown keys, so a client can't set them whatever it sends.

export const SYNC_ENTITIES = [
  "account",
  "card",
  "category",
  "transaction",
  "recurringRule",
  "savingsGoal",
  "loan",
  "loanPayment",
  "personalDebt",
  "personalDebtRepayment",
  "categorizationRule",
  "settings",
] as const
export const SyncEntity = z.enum(SYNC_ENTITIES)
export type SyncEntity = z.infer<typeof SyncEntity>

export const SyncOperation = z.enum(["create", "update", "delete"])
export type SyncOperation = z.infer<typeof SyncOperation>


const Audit = {
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  deleted_at: IsoDateTime.nullable(),
}
const MoneyColumn = z.object({ amount: DecimalString, currency: CurrencyCode })
const Day = z.number().int().min(1).max(31)
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable()

export const AccountWire = z.object({
  id: Id,
  name: z.string(),
  bank: z.string().nullable(),
  kind: AccountKind,
  opening_balances: z.array(MoneyColumn),
  opening_date: IsoDateTime,
  debt_mode: nullable(DebtMode),
  limit_amount: DecimalString.nullable(),
  limit_currency: CurrencyCode.nullable(),
  cutoff_day: Day.nullable(),
  due_day: Day.nullable(),
  ...Audit,
})

export const CardWire = z.object({
  id: Id,
  account_id: Id,
  kind: CardKind,
  network: nullable(CardNetwork),
  last_four: z.string().regex(/^[0-9]{4}$/).nullable(),
  color: nullable(CardColor),
  product_name: z.string().nullable(),
  expiry_month: z.number().int().min(1).max(12).nullable(),
  expiry_year: z.number().int().min(2000).max(2199).nullable(),
  ...Audit,
})

export const CategoryWire = z.object({
  id: z.string().min(1).max(64),
  name: z.string(),
  kind: TransactionKind,
  icon: z.string().nullable(),
  color: z.string().nullable(),
  is_renamed: z.boolean(),
  sort_index: z.number().int(),
  budget_amount: PositiveDecimalString.nullable(),
  budget_currency: CurrencyCode.nullable(),
  ...Audit,
})

export const TransactionWire = z.object({
  id: Id,
  date: IsoDateTime,
  status: TransactionStatus,
  description: z.string(),
  kind: TransactionKind,
  category_id: z.string().nullable(),
  amount: PositiveDecimalString,
  currency: CurrencyCode,
  account_id: Id,
  card_id: Id.nullable(),
  destination_account_id: Id.nullable(),
  actual_debited_principal: PositiveDecimalString.nullable(),
  rate_principal: CurrencyCode,
  rate_second: CurrencyCode,
  rate: PositiveDecimalString,
  is_shared: z.boolean(),
  note: z.string().nullable(),
  recurring_id: Id.nullable(),
  tags: z.array(z.string()),
  /** Optional for apps older than the field; the server keeps what it has. */
  source: RecordSource.optional(),
  ...Audit,
})

export const RecurringRuleWire = z.object({
  id: Id,
  name: z.string(),
  kind: TransactionKind,
  category_id: z.string().nullable(),
  amount: PositiveDecimalString,
  currency: CurrencyCode,
  account_id: Id,
  card_id: Id.nullable(),
  destination_account_id: Id.nullable(),
  frequency: RecurringFrequency,
  interval: z.number().int().min(1).max(99),
  start_date: IsoDateTime,
  next_date: IsoDateTime,
  end_date: IsoDateTime.nullable(),
  is_subscription: z.boolean(),
  auto_confirm: z.boolean(),
  is_paused: z.boolean(),
  note: z.string().nullable(),
  tags: z.array(z.string()),
  source: RecordSource.optional(),
  ...Audit,
})

export const SavingsGoalWire = z.object({
  id: Id,
  name: z.string(),
  target_amount: PositiveDecimalString,
  target_currency: CurrencyCode,
  saved: DecimalString.refine((value) => !value.startsWith("-"), "Can't be negative"),
  target_month: z.number().int().min(1).max(12).nullable(),
  target_year: z.number().int().min(2000).max(2199).nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  ...Audit,
})

export const LoanWire = z.object({
  id: Id,
  name: z.string(),
  lender: z.string().nullable(),
  borrowed_amount: PositiveDecimalString,
  borrowed_currency: CurrencyCode,
  installment_amount: PositiveDecimalString,
  installment_count: z.number().int().min(1).max(600),
  frequency: LoanFrequency,
  first_due_date: IsoDateTime,
  ...Audit,
})

/** One paid installment, its own row so two devices can record different payments. */
export const LoanPaymentWire = z.object({
  /** `loanPaymentId(loan_id, number)`: the same installment is the same row everywhere. */
  id: Id,
  loan_id: Id,
  number: z.number().int().min(1).max(600),
  paid_at: IsoDateTime,
  transaction_id: Id.nullable(),
  ...Audit,
})

export const PersonalDebtWire = z.object({
  id: Id,
  person: z.string(),
  direction: DebtDirection,
  amount: PositiveDecimalString,
  currency: CurrencyCode,
  date: IsoDateTime,
  note: z.string().nullable(),
  settled_at: IsoDateTime.nullable(),
  transaction_id: Id.nullable(),
  ...Audit,
})

export const PersonalDebtRepaymentWire = z.object({
  id: Id,
  debt_id: Id,
  amount: PositiveDecimalString,
  date: IsoDateTime,
  ...Audit,
})

export const CategorizationRuleWire = z.object({
  id: Id,
  match: z.string().refine((text) => text.trim() !== "", "Can't be empty"),
  category_id: z.string(),
  kind: z.enum(["expense", "income"]),
  tags: z.array(z.string()),
  sort_index: z.number().int(),
  ...Audit,
})

/**
 * Only what is the same on every device. Unlock method, relock delay, hiding amounts and the iCloud
 * switch belong to each device and never travel.
 */
export const SettingsWire = z.object({
  id: z.literal("settings"),
  principal: CurrencyCode,
  second: CurrencyCode.nullable(),
  rate: PositiveDecimalString,
  payment_reminder_days_before: z.number().int().min(0).max(60),
  has_completed_onboarding: z.boolean(),
  ...Audit,
})

export const SYNC_WIRE = {
  account: AccountWire,
  card: CardWire,
  category: CategoryWire,
  transaction: TransactionWire,
  recurringRule: RecurringRuleWire,
  savingsGoal: SavingsGoalWire,
  loan: LoanWire,
  loanPayment: LoanPaymentWire,
  personalDebt: PersonalDebtWire,
  personalDebtRepayment: PersonalDebtRepaymentWire,
  categorizationRule: CategorizationRuleWire,
  settings: SettingsWire,
} as const satisfies Record<SyncEntity, z.ZodType>

export type SyncRow<E extends SyncEntity = SyncEntity> = z.infer<(typeof SYNC_WIRE)[E]>

/** One outbox entry as pushed. `payload` is validated against `SYNC_WIRE[entity]` separately, per event. */
export const SyncEvent = z.object({
  event_id: Id,
  entity: SyncEntity,
  entity_id: z.string().min(1).max(64),
  operation: SyncOperation,
  payload: z.unknown(),
  created_at: IsoDateTime,
})
export type SyncEvent = z.infer<typeof SyncEvent>

/** Validates one event's row. The id inside must be the event's `entity_id`. */
export function parseSyncPayload(event: Pick<SyncEvent, "entity" | "entity_id" | "operation" | "payload">) {
  const parsed = SYNC_WIRE[event.entity].safeParse(event.payload)
  if (!parsed.success) return parsed
  if (parsed.data.id !== event.entity_id) {
    return { success: false as const, error: new z.ZodError([{ code: "custom", path: ["id"], message: "payload id differs from entity_id", input: parsed.data.id }]) }
  }
  if ((event.operation === "delete") !== (parsed.data.deleted_at !== null)) {
    return { success: false as const, error: new z.ZodError([{ code: "custom", path: ["deleted_at"], message: "delete events carry deleted_at, others don't", input: parsed.data.deleted_at }]) }
  }
  return parsed
}

export type ValidatedSyncEvent =
  | { ok: true; event: SyncEvent; row: SyncRow }
  | { ok: false; reason: string }

/**
 * The whole check for one pushed event: its envelope, then its row against the entity's wire schema.
 * The reason names the field, never its value (it may be a description or an amount).
 */
export function validateSyncEvent(raw: unknown): ValidatedSyncEvent {
  const envelope = SyncEvent.safeParse(raw)
  if (!envelope.success) return { ok: false, reason: describe(envelope.error) }
  const row = parseSyncPayload(envelope.data)
  if (!row.success) return { ok: false, reason: describe(row.error) }
  return { ok: true, event: envelope.data, row: row.data as SyncRow }
}

function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "event"}: ${issue.message}`).join("; ")
}
