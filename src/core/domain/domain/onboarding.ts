import type { Account, Card, CardNetwork, CurrencySettings, DebtMode, Settings, UnlockMethod } from "../schema"
import { DEFAULT_SETTINGS } from "../schema"

import { debitCardFor, makeCard, makeCreditTerms } from "./accounts"
import type { Decimal, DecimalValue } from "./decimal"
import { DomainError } from "./errors"
import { swappedCurrencies, toStored, withRate, type Money } from "./money"
import type { LedgerStore, ProfileStore } from "./store"

// Ports of OnboardingDraft.swift, CompleteOnboardingUseCase.swift, Profile.swift and the settings
// changes in SettingsUseCases.swift.

/** Long enough for a first name and a surname, short enough to fit a greeting and a card. */
export const PREFERRED_NAME_MAX_LENGTH = 30

/** Trimmed and capped; blank means "no name". */
export function normalizedPreferredName(name: string | undefined): string | undefined {
  const trimmed = name?.trim() ?? ""
  return trimmed === "" ? undefined : [...trimmed].slice(0, PREFERRED_NAME_MAX_LENGTH).join("")
}

export interface OnboardingAccountDraft {
  id: string
  kind: "bank" | "credit" | "cash"
  name: string
  bank?: string
  /** Bank and cash accounts hold one currency; credit cards follow `debtMode`. */
  currency: string
  /** Today's balance; for credit cards what is owed (positive). */
  balance: Decimal
  /** Dual credit cards: what is owed in the second currency. */
  secondBalance: Decimal
  lastFour?: string
  network?: CardNetwork
  debtMode?: DebtMode
}

export function onboardingDisplayName(draft: Pick<OnboardingAccountDraft, "bank" | "name">): string {
  return [draft.bank, draft.name]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(" ")
}

export interface OnboardingDraft {
  currencies: CurrencySettings
  accounts: OnboardingAccountDraft[]
  /** The web has no Face ID: the lock stays off, as an iPhone without a passcode would have it. */
  locksWithBiometrics: boolean
  hasPasscode: boolean
  hidesAmountsInAppSwitcher: boolean
  backsUpToICloud: boolean
  preferredName?: string
}

export function onboardingUnlockMethod(draft: Pick<OnboardingDraft, "locksWithBiometrics" | "hasPasscode">): UnlockMethod {
  if (draft.locksWithBiometrics) return "biometrics"
  return draft.hasPasscode ? "passcode" : "disabled"
}

export function makeOnboardingAccount(draft: OnboardingAccountDraft, currencies: CurrencySettings, date: Date): { account: Account; cards: Card[] } {
  if (draft.balance.lt(0) || (draft.kind === "credit" && draft.secondBalance.lt(0))) throw DomainError.invalidAmount()
  const id = draft.id
  const name = draft.name.trim()
  const bank = draft.bank?.trim()
  const base = { id, name, ...(bank ? { bank } : {}), openingDate: date.toISOString() }
  switch (draft.kind) {
    case "cash":
      return { account: { id, name, kind: "cash", openingBalances: [toStored({ amount: draft.balance, currency: draft.currency })], openingDate: date.toISOString() }, cards: [] }
    case "bank":
      return {
        account: { ...base, kind: "deposit", openingBalances: [toStored({ amount: draft.balance, currency: draft.currency })] },
        // A bank account is its card, so it gets one even before the person gives its digits.
        cards: [debitCardFor(id, draft.lastFour, draft.network), makeCard({ accountId: id, kind: "transfer" })],
      }
    case "credit": {
      const mode: DebtMode = currencies.second === undefined ? "principal" : (draft.debtMode ?? "dual")
      const second = currencies.second ?? currencies.principal
      // Credit balances are debts, so they start negative (rule 5).
      const balances: Money[] =
        mode === "dual"
          ? [
              { amount: draft.balance.neg(), currency: currencies.principal },
              { amount: draft.secondBalance.neg(), currency: second },
            ]
          : [{ amount: draft.balance.neg(), currency: mode === "second" ? second : currencies.principal }]
      const lastFour = draft.lastFour?.trim()
      return {
        account: { ...base, kind: "credit", openingBalances: balances.map(toStored), creditTerms: makeCreditTerms(mode) },
        cards: [makeCard({ accountId: id, kind: "creditHolder", ...(draft.network ? { network: draft.network } : {}), ...(lastFour ? { lastFour } : {}), color: "azul" })],
      }
    }
  }
}

/** Saves the accounts and their payment methods, the settings and the name; returns the settings. */
export async function completeOnboarding(store: LedgerStore, profile: ProfileStore, draft: OnboardingDraft, now: Date = new Date()): Promise<Settings> {
  const made = draft.accounts.map((account) => makeOnboardingAccount(account, draft.currencies, now))
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    currencies: draft.currencies,
    unlockMethod: onboardingUnlockMethod(draft),
    hidesAmountsInAppSwitcher: draft.hidesAmountsInAppSwitcher,
    isICloudBackupEnabled: draft.backsUpToICloud,
    hasCompletedOnboarding: true,
  }
  await store.atomically(async () => {
    for (const { account, cards } of made) {
      await store.saveAccount(account)
      for (const card of cards) await store.saveCard(card)
    }
    await store.saveSettings(settings)
  })
  profile.setPreferredName(normalizedPreferredName(draft.preferredName))
  return settings
}

/** Saves a change to the settings; rate changes only affect movements recorded from now on. */
export async function updateSettings(store: LedgerStore, change: (settings: Settings) => Settings): Promise<Settings> {
  const updated = change((await store.loadSettings()) ?? DEFAULT_SETTINGS)
  await store.saveSettings(updated)
  return updated
}

export const setRate = (rate: DecimalValue) => (settings: Settings): Settings => ({ ...settings, currencies: withRate(settings.currencies, rate) })

/** Makes the second currency the main one. */
export function swapCurrencies(settings: Settings): Settings {
  const swapped = swappedCurrencies(settings.currencies)
  if (!swapped) throw DomainError.invalidExchangeRate()
  return { ...settings, currencies: swapped }
}

