import { z } from "zod"

/**
 * Exact decimal text ("36.6243"): no exponent, grouping or locale. Amounts and rates never become a
 * JS `number`, which would round them through a binary double — the same reason iOS keeps `Decimal`.
 */
export const DECIMAL_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/

export const DecimalString = z.string().regex(DECIMAL_PATTERN, "Not an exact decimal")
export type DecimalString = z.infer<typeof DecimalString>

/** `> 0` on the text itself, so no float conversion is needed. */
export function isPositiveDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value) && !value.startsWith("-") && /[1-9]/.test(value)
}

export const PositiveDecimalString = DecimalString.refine(isPositiveDecimal, "Must be greater than zero")

/** ISO 4217 codes the runtime knows; iOS reads the same table from Foundation. */
const isoCurrencies: ReadonlySet<string> = new Set(
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : [],
)

export function isISOCurrency(code: string): boolean {
  return isoCurrencies.size > 0 ? isoCurrencies.has(code) : /^[A-Z]{3}$/.test(code)
}

/** Uppercases and validates a user- or file-provided code, like iOS `Money.normalizedCurrency`. */
export const CurrencyCode = z
  .string()
  .transform((code) => code.trim().toUpperCase())
  .refine(isISOCurrency, "Unknown ISO 4217 currency")
export type CurrencyCode = z.infer<typeof CurrencyCode>

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Lowercase, as `crypto.randomUUID()` writes them; iOS exports them lowercased too. */
export const Id = z
  .string()
  .regex(UUID_PATTERN, "Invalid id")
  .transform((id) => id.toLowerCase())
export type Id = z.infer<typeof Id>

/**
 * An instant as ISO 8601 text, normalized to `toISOString()` (UTC, milliseconds) so stored dates sort
 * as strings. Accepts the forms iOS writes, with or without milliseconds.
 */
export const IsoDateTime = z.iso
  .datetime({ offset: true })
  .transform((text) => new Date(text).toISOString())
export type IsoDateTime = z.infer<typeof IsoDateTime>

export function nowIso(): IsoDateTime {
  return new Date().toISOString()
}

export const TransactionKind = z.enum(["expense", "income", "transfer"])
export type TransactionKind = z.infer<typeof TransactionKind>

/** `planned` movements (drafts) don't count toward balances or summaries until confirmed. */
export const TransactionStatus = z.enum(["confirmed", "planned"])
export type TransactionStatus = z.infer<typeof TransactionStatus>

/** Fields the store stamps on every record, mirroring iOS `RecordMetadata`. */
export const RecordMetadata = z.object({
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: IsoDateTime.nullable(),
})
export type RecordMetadata = z.infer<typeof RecordMetadata>
