import type { ExchangeRate } from "../schema"

import { type DecimalValue, Decimal, roundedHalfUp } from "./decimal"
import type { Money } from "./money"

// Ports of Core/Formatters (CurrencyFormatter, AmountInput): money is written the same in every
// language ("C$8,420.00", "−$709.58"), independent of the device region.

export type Sign = "automatic" | "always" | "never"

const MINUS = "−"

/** "$" for dollar-named currencies, "C$" for córdobas, the ISO code and a space otherwise. */
export function currencySymbol(code: string): string {
  switch (code.toUpperCase()) {
    case "USD":
    case "MXN":
    case "COP":
    case "ARS":
    case "CLP":
      return "$"
    case "NIO":
      return "C$"
    case "EUR":
      return "€"
    case "GBP":
      return "£"
    case "CRC":
      return "₡"
    case "GTQ":
      return "Q"
    case "HNL":
      return "L"
    default:
      return `${code.toUpperCase()} `
  }
}

function grouped(magnitude: Decimal, fractionDigits: number): string {
  const [whole = "0", fraction] = magnitude.toFixed(fractionDigits).split(".")
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return fraction === undefined ? withCommas : `${withCommas}.${fraction}`
}

export function formatAmount(amount: DecimalValue, currencyCode: string, options: { fractionDigits?: number; sign?: Sign } = {}): string {
  const fractionDigits = options.fractionDigits ?? 2
  const value = roundedHalfUp(new Decimal(amount), fractionDigits)
  const isNegative = value.lt(0)
  const prefix = { automatic: isNegative ? MINUS : "", always: isNegative ? MINUS : "+", never: "" }[options.sign ?? "automatic"]
  return prefix + currencySymbol(currencyCode) + grouped(value.abs(), fractionDigits)
}

export function formatMoney(value: Money, options: { fractionDigits?: number; sign?: Sign } = {}): string {
  return formatAmount(value.amount, value.currency, options)
}

export function signedAmount(amount: DecimalValue, currencyCode: string, fractionDigits = 2): string {
  return formatAmount(amount, currencyCode, { fractionDigits, sign: "always" })
}

/** A plain grouped number without symbol ("9,443.60", "36.6243"). */
export function formatNumber(amount: DecimalValue, fractionDigits = 2): string {
  const value = roundedHalfUp(new Decimal(amount), fractionDigits)
  return (value.lt(0) ? MINUS : "") + grouped(value.abs(), fractionDigits)
}

/** Several balances of one account the way cards show them ("−C$197.02 · −$16.79"). */
export function joinedMoney(balances: readonly Money[], fractionDigits = 2): string {
  return balances.map((balance) => formatMoney(balance, { fractionDigits })).join(" · ")
}

/** "1 USD = 36.6243 NIO". */
export function formatRate(rate: ExchangeRate): string {
  return `1 ${rate.principal} = ${new Decimal(rate.rate).toFixed()} ${rate.second}`
}

/**
 * Parses amounts people type or paste: "1234.5", "1234,5", "8,000", "1,234.50". Anything else is
 * `undefined` rather than a valid prefix ("12abc"). Empty is `undefined` too.
 */
export function parseAmount(text: string): Decimal | undefined {
  let value = text.trim()
  if (value === "") return undefined
  if (value.includes(".")) value = value.replaceAll(",", "")
  else if (/^\d{1,3}(,\d{3})+$/.test(value)) value = value.replaceAll(",", "")
  else if ((value.match(/,/g) ?? []).length === 1) value = value.replace(",", ".")
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(value)) return undefined
  return new Decimal(value.endsWith(".") ? value.slice(0, -1) : value)
}

/** Typed text rewritten with grouping and two decimals once the field is left ("10000" → "10,000.00"). */
export function formatAmountInput(text: string): string | undefined {
  const amount = parseAmount(text)
  return amount === undefined ? undefined : formatNumber(amount)
}
