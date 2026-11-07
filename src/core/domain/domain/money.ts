import type { CurrencySettings, ExchangeRate, Money as StoredMoney } from "../schema"
import { isISOCurrency } from "../schema"

import { type DecimalValue, Decimal, ONE, ZERO, dec, decimalText, rounded } from "./decimal"
import { DomainError } from "./errors"

/**
 * An amount with its ISO 4217 currency, computed (iOS `Money`). Arithmetic refuses to mix
 * currencies: converting needs an exchange rate.
 */
export interface Money {
  readonly amount: Decimal
  readonly currency: string
}

export function money(amount: DecimalValue, currency: string): Money {
  return { amount: dec(amount), currency }
}

export const zeroMoney = (currency: string): Money => ({ amount: ZERO, currency })

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw DomainError.currencyMismatch(a.currency, b.currency)
  return { amount: a.amount.plus(b.amount), currency: a.currency }
}

export function subtractMoney(a: Money, b: Money): Money {
  return addMoney(a, { amount: b.amount.neg(), currency: b.currency })
}

export function negated(value: Money): Money {
  return { amount: value.amount.neg(), currency: value.currency }
}

export function moneyEquals(a: Money | undefined | null, b: Money | undefined | null): boolean {
  if (!a || !b) return a === b
  return a.currency === b.currency && a.amount.eq(b.amount)
}

export function fromStored(value: StoredMoney): Money {
  return { amount: dec(value.amount), currency: value.currency }
}

export function toStored(value: Money): StoredMoney {
  return { amount: decimalText(value.amount), currency: value.currency }
}

/** Uppercases and validates a user- or file-provided code (iOS `Money.normalizedCurrency`). */
export function normalizedCurrency(code: string): string {
  const normalized = code.trim().toUpperCase()
  if (!isISOCurrency(normalized)) throw DomainError.invalidCurrency(code)
  return normalized
}

// Exchange rates: "1 principal = rate second". Each transaction stores the rate in force.

export function exchangeRate(principal: string, second: string, rate: DecimalValue): ExchangeRate {
  const value = dec(rate)
  if (value.lte(0)) throw DomainError.invalidExchangeRate()
  return { principal, second, rate: decimalText(value) }
}

/** Single-currency mode: the second currency is the principal and the rate is 1. */
export function singleRate(principal: string): ExchangeRate {
  return { principal, second: principal, rate: "1" }
}

export function rateHasSecondCurrency(rate: ExchangeRate): boolean {
  return rate.second !== rate.principal
}

/** Converts between the two currencies of `rate`; same currency is identity, anything else throws. */
export function convert(value: Money, rate: ExchangeRate, to: string): Money {
  if (value.currency === to) return value
  const r = dec(rate.rate)
  if (value.currency === rate.principal && to === rate.second) return { amount: value.amount.times(r), currency: rate.second }
  if (value.currency === rate.second && to === rate.principal) return { amount: value.amount.div(r), currency: rate.principal }
  throw DomainError.currencyMismatch(value.currency, to)
}

// Currency settings (iOS `CurrencySettings`).

/** A second equal to the principal means single-currency mode, where the rate is always 1. */
export function currencySettings(principal = "USD", second?: string, rate: DecimalValue = 1): CurrencySettings {
  const value = dec(rate)
  if (value.lte(0)) throw DomainError.invalidExchangeRate()
  const effective = second === principal ? undefined : second
  return effective === undefined ? { principal, rate: "1" } : { principal, second: effective, rate: decimalText(value) }
}

export const INITIAL_CURRENCIES: CurrencySettings = { principal: "USD", rate: "1" }

/** The rate new transactions store. */
export function settingsRate(settings: CurrencySettings): ExchangeRate {
  return settings.second === undefined ? singleRate(settings.principal) : exchangeRate(settings.principal, settings.second, settings.rate)
}

/**
 * The second currency as the principal, with the rate turned around (12 decimals, so swapping back
 * lands on the original). Past transactions keep the rate they stored. `undefined` with one currency.
 */
export function swappedCurrencies(settings: CurrencySettings): CurrencySettings | undefined {
  if (settings.second === undefined) return undefined
  return currencySettings(settings.second, settings.principal, rounded(ONE.div(dec(settings.rate)), 12))
}

/** Replaces the manual rate, keeping both currencies. */
export function withRate(settings: CurrencySettings, rate: DecimalValue): CurrencySettings {
  return currencySettings(settings.principal, settings.second, rate)
}
