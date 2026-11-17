import { dec, type Decimal } from "../domain/domain"
import type { Transaction } from "../domain/schema"

/**
 * Why `actual_debited` (what the bank charged in the principal currency) can't go on a movement, or
 * `undefined` when it can. The domain keeps it only on a movement in another currency and needs it
 * positive (`categorizedTransaction`, `checkAmounts`); it drops it silently on a movement already in
 * the principal currency, so an assistant is told here instead of losing it without knowing.
 */
export function actualDebitedRefusal(value: string, currency: string, principal: string): string | undefined {
  if (dec(value).lte(0)) return "actual_debited must be greater than zero."
  if (currency.toUpperCase() === principal) {
    return `actual_debited is what the bank charged in ${principal} for a movement in another currency; this movement is already in ${principal}, so leave actual_debited out.`
  }
  return undefined
}

/** The checked value as the domain draft takes it; throws `refuse(message)` when it can't go on the movement. */
export function checkedActualDebited(value: string | undefined, currency: string, principal: string, refuse: (message: string) => Error): Decimal | undefined {
  if (value === undefined) return undefined
  const refusal = actualDebitedRefusal(value, currency, principal)
  if (refusal) throw refuse(refusal)
  return dec(value)
}

/** What the bank charged, with the principal currency it is in, as the read and write tools show it. */
export function actualDebitedOf(transaction: Transaction): { amount: string; currency: string } | null {
  return transaction.actualDebitedPrincipal === undefined ? null : { amount: transaction.actualDebitedPrincipal, currency: transaction.exchangeRate.principal }
}
