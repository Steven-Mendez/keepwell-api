import type { TransactionKind } from "../schema"

/**
 * The closed set of failures use cases raise, mirroring iOS `DomainError`. Messages are diagnostics;
 * screens map `code` to their own localized text.
 */
export type DomainErrorCode =
  | "invalidAmount"
  | "invalidCurrency"
  | "currencyMismatch"
  | "invalidExchangeRate"
  | "invalidLastFour"
  | "missingName"
  | "invalidDayOfMonth"
  | "invalidExpiry"
  | "duplicateCategoryName"
  | "fallbackCategoryCantBeDeleted"
  | "categoryKindMismatch"
  | "unsupportedTransactionKind"
  | "invalidTransferDestination"
  | "invalidInterval"
  | "invalidEndDate"
  | "notFound"
  | "corruptedData"

export class DomainError extends Error {
  override readonly name = "DomainError"

  constructor(
    readonly code: DomainErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
  }

  static invalidAmount = () => new DomainError("invalidAmount")
  static invalidCurrency = (code: string) => new DomainError("invalidCurrency", code)
  static currencyMismatch = (a: string, b: string) => new DomainError("currencyMismatch", `${a} ${b}`)
  static invalidExchangeRate = () => new DomainError("invalidExchangeRate")
  static invalidLastFour = (value: string) => new DomainError("invalidLastFour", value)
  static missingName = () => new DomainError("missingName")
  static invalidDayOfMonth = (day: number) => new DomainError("invalidDayOfMonth", String(day))
  static invalidExpiry = () => new DomainError("invalidExpiry")
  static duplicateCategoryName = (name: string) => new DomainError("duplicateCategoryName", name)
  static fallbackCategoryCantBeDeleted = (id: string) => new DomainError("fallbackCategoryCantBeDeleted", id)
  static categoryKindMismatch = (expected: TransactionKind, actual: TransactionKind) =>
    new DomainError("categoryKindMismatch", `${expected} ${actual}`)
  static unsupportedTransactionKind = (kind: TransactionKind) => new DomainError("unsupportedTransactionKind", kind)
  static invalidTransferDestination = () => new DomainError("invalidTransferDestination")
  /** A recurring rule repeats every 1…99 units. */
  static invalidInterval = (interval: number) => new DomainError("invalidInterval", String(interval))
  /** A recurring rule can't end before the day it starts. */
  static invalidEndDate = () => new DomainError("invalidEndDate")
  static notFound = (id: string) => new DomainError("notFound", id)
  static corruptedData = (detail: string) => new DomainError("corruptedData", detail)
}

export function isDomainError(error: unknown, code?: DomainErrorCode): error is DomainError {
  return error instanceof DomainError && (code === undefined || error.code === code)
}
