import DecimalJS from "decimal.js"

/**
 * Exact decimal arithmetic for money and rates, like iOS `Decimal` (38 significant digits). Ties go
 * to the even neighbor by default (`Decimal.rounded(scale:)`, banker's rounding), so rounding many
 * converted amounts doesn't drift upward. Nothing here ever passes through a binary `number`.
 */
export const Decimal = DecimalJS.clone({ precision: 38, rounding: DecimalJS.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 })
export type Decimal = InstanceType<typeof Decimal>
export type DecimalValue = DecimalJS.Value

export const ZERO = new Decimal(0)
export const ONE = new Decimal(1)

export function dec(value: DecimalValue): Decimal {
  return new Decimal(value)
}

/** Banker's rounding to `scale` fraction digits (iOS `rounded(scale:)`). */
export function rounded(value: Decimal, scale: number): Decimal {
  return value.toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN)
}

/** Half away from zero, as receipts round (iOS `roundedHalfUp`, `.plain`). */
export function roundedHalfUp(value: Decimal, scale: number): Decimal {
  return value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
}

/** Exact decimal text for storage ("36.6243"), never exponent notation. */
export function decimalText(value: Decimal): string {
  const text = value.toFixed()
  return text === "-0" ? "0" : text
}

export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), ZERO)
}
