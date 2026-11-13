import { newID } from "../schema/id"
import type { CategorizationRule, Merchant, RecurringRule, Transaction, TransactionCategory, TransactionKind } from "../schema"
import { MAX_MERCHANT_NAME_LENGTH, MerchantDomain } from "../schema"

import { DomainError } from "./errors"
import { folded } from "./rules"
import type { LedgerStore } from "./store"

// Merchants: the business a movement was with ("Subway") and, optionally, the platform it went
// through ("via Uber Eats"). The person's own list, shared by movements, recurring rules and
// categorization rules, which point at one by id.

/** What a merchant editor or picker hands over; `id` absent for a new one. */
export interface MerchantDraft {
  id?: string
  name: string
  /** A web domain or address ("subway.com", "https://www.subway.com/en"); absent or blank for none. */
  domain?: string
  /** A brand of the app's brand table it comes from. */
  brandId?: string
  defaultCategoryId?: string
  /** Absent keeps an edited merchant's, and is `false` for a new one. */
  isPlatform?: boolean
}

/** The name as saved: trimmed, inner runs of spaces collapsed and cut to the limit. */
export function merchantName(text: string): string {
  return [...text.trim().replace(/\s+/g, " ")].slice(0, MAX_MERCHANT_NAME_LENGTH).join("").trim()
}

/**
 * A domain as saved: lowercase host name without scheme, `www.`, port, path or query
 * ("https://www.Subway.com/en" → "subway.com"). `undefined` when blank or not a domain.
 */
export function normalizedDomain(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const host = text
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "")
  if (host === "") return undefined
  return MerchantDomain.safeParse(host).success ? host : undefined
}

/** The merchants by name, platforms not apart; equal names keep a stable order by id. */
export function orderedMerchants(merchants: readonly Merchant[]): Merchant[] {
  return [...merchants].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "accent" }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The merchants whose name has the query, without case or accents: names that start with it first,
 * then the rest, each by name. An empty query lists them all.
 */
export function searchMerchants(merchants: readonly Merchant[], query: string): Merchant[] {
  const needle = folded(query.trim())
  const ordered = orderedMerchants(merchants)
  if (needle === "") return ordered
  const starting = ordered.filter((merchant) => folded(merchant.name).startsWith(needle))
  const containing = ordered.filter((merchant) => !folded(merchant.name).startsWith(needle) && folded(merchant.name).includes(needle))
  return [...starting, ...containing]
}

/** The choices for "via": platforms first, then the rest, never the business itself. */
export function viaChoices(merchants: readonly Merchant[], query: string, merchantId?: string): Merchant[] {
  const found = searchMerchants(merchants, query).filter((merchant) => merchant.id !== merchantId)
  return [...found.filter((merchant) => merchant.isPlatform), ...found.filter((merchant) => !merchant.isPlatform)]
}

/**
 * The merchant a draft names already, so picking a brand twice doesn't make two: the one from the
 * same brand, else (for a draft without a brand) the one with the same domain, else the one with the
 * same name, without case or accents.
 */
export function equivalentMerchant(merchants: readonly Merchant[], draft: Pick<MerchantDraft, "name" | "domain" | "brandId">): Merchant | undefined {
  if (draft.brandId !== undefined) {
    const byBrand = merchants.find((merchant) => merchant.brandId === draft.brandId)
    if (byBrand) return byBrand
  } else {
    const domain = normalizedDomain(draft.domain)
    const byDomain = domain === undefined ? undefined : merchants.find((merchant) => merchant.domain === domain && merchant.brandId === undefined)
    if (byDomain) return byDomain
  }
  const name = folded(merchantName(draft.name))
  return name === "" ? undefined : merchants.find((merchant) => folded(merchant.name) === name)
}

/** The category a merchant suggests for a movement of this kind: its default, if it exists with that kind. */
export function merchantCategory(merchant: Pick<Merchant, "defaultCategoryId"> | undefined, kind: TransactionKind, categories: readonly TransactionCategory[]): string | undefined {
  const id = merchant?.defaultCategoryId
  if (id === undefined || kind === "transfer") return undefined
  return categories.some((category) => category.id === id && category.kind === kind) ? id : undefined
}

async function existingMerchant(store: LedgerStore, id: string): Promise<Merchant> {
  const merchant = (await store.fetchMerchants()).find((candidate) => candidate.id === id)
  if (!merchant) throw DomainError.notFound(id)
  return merchant
}

/** Whether a merchant's default category is one that exists, and isn't for transfers. */
export function isLiveDefaultCategory(id: string | undefined, categories: readonly TransactionCategory[]): id is string {
  return id !== undefined && categories.some((category) => category.id === id && category.kind !== "transfer")
}

/**
 * The merchant as saving stores it; throws for a blank name, a domain that isn't one or a newly chosen
 * category that doesn't exist. A default category that no longer exists (deleted, or not pulled yet)
 * but is the one `current` already had is dropped instead, so the merchant can still be saved.
 */
export function validatedMerchant(draft: MerchantDraft & { id: string }, categories: readonly TransactionCategory[], current?: Merchant): Merchant {
  const name = merchantName(draft.name)
  if (name === "") throw DomainError.missingName()
  const domain = normalizedDomain(draft.domain)
  if (domain === undefined && (draft.domain ?? "").trim() !== "") throw DomainError.corruptedData("domain")
  const brandId = draft.brandId?.trim() || undefined
  let defaultCategoryId = draft.defaultCategoryId
  if (defaultCategoryId !== undefined) {
    const category = categories.find((candidate) => candidate.id === defaultCategoryId)
    if (!category) {
      if (defaultCategoryId !== current?.defaultCategoryId) throw DomainError.notFound(defaultCategoryId)
      defaultCategoryId = undefined
    } else if (category.kind === "transfer") throw DomainError.unsupportedTransactionKind("transfer")
  }
  return {
    id: draft.id,
    name,
    ...(domain === undefined ? {} : { domain }),
    ...(brandId === undefined ? {} : { brandId: [...brandId].slice(0, 64).join("") }),
    ...(defaultCategoryId === undefined ? {} : { defaultCategoryId }),
    isPlatform: draft.isPlatform ?? current?.isPlatform ?? false,
  }
}

export async function fetchMerchants(store: LedgerStore): Promise<Merchant[]> {
  return orderedMerchants(await store.fetchMerchants())
}

/**
 * Saves a new merchant or edits one (rename, domain, brand, default category, platform). Every field
 * but `isPlatform` is replaced as given: one left out is removed.
 */
export async function saveMerchant(store: LedgerStore, draft: MerchantDraft): Promise<Merchant> {
  const current = draft.id === undefined ? undefined : await existingMerchant(store, draft.id)
  const merchant = validatedMerchant({ ...draft, id: current?.id ?? newID() }, await store.fetchCategories(), current)
  await store.saveMerchant(merchant)
  return merchant
}

/**
 * The merchant a picker chose: the existing one it names (`equivalentMerchant`), or a new one. Picking
 * "Subway" from the brand table twice gives the same merchant.
 */
export async function createMerchant(store: LedgerStore, draft: Omit<MerchantDraft, "id">): Promise<Merchant> {
  const existing = equivalentMerchant(await store.fetchMerchants(), draft)
  if (existing) return existing
  return saveMerchant(store, draft)
}

type MerchantLinks = Pick<Transaction, "merchantId" | "viaMerchantId">

/**
 * `item` with every link to `from` moved to `to` (or removed without one), and "via" dropped when it
 * ends up naming the business itself. `undefined` when nothing changes.
 */
export function relinked<T extends MerchantLinks>(item: T, from: string, to?: string): T | undefined {
  if (item.merchantId !== from && item.viaMerchantId !== from) return undefined
  const { merchantId, viaMerchantId, ...rest } = item
  const business = merchantId === from ? to : merchantId
  const via = viaMerchantId === from ? to : viaMerchantId
  return {
    ...rest,
    ...(business === undefined ? {} : { merchantId: business }),
    ...(via === undefined || via === business ? {} : { viaMerchantId: via }),
  } as T
}

function relinkedRule(rule: CategorizationRule, from: string, to?: string): CategorizationRule | undefined {
  if (rule.merchantId !== from) return undefined
  const { merchantId: _old, ...rest } = rule
  return to === undefined ? rest : { ...rest, merchantId: to }
}

/** Moves (or removes) every link to `from`, in movements, recurring rules and categorization rules. */
async function relinkAll(store: LedgerStore, from: string, to?: string): Promise<number> {
  let changed = 0
  for (const movement of await store.fetchTransactions()) {
    const next = relinked(movement, from, to)
    if (next) {
      await store.saveTransaction(next)
      changed++
    }
  }
  for (const rule of await store.fetchRecurringRules()) {
    const next = relinked<RecurringRule>(rule, from, to)
    if (next) {
      await store.saveRecurringRule(next)
      changed++
    }
  }
  for (const rule of await store.fetchCategorizationRules()) {
    const next = relinkedRule(rule, from, to)
    if (next) {
      await store.saveCategorizationRule(next)
      changed++
    }
  }
  return changed
}

/**
 * Deletes a merchant, all or nothing. Movements and rules that named it keep everything else and
 * simply name no business (or no platform) any more, as a category's deletion moves them to "Other".
 */
export async function deleteMerchant(store: LedgerStore, id: string): Promise<void> {
  await existingMerchant(store, id)
  await store.atomically(async () => {
    await relinkAll(store, id)
    await store.deleteMerchant(id)
  })
}

/**
 * Merges `fromId` into `intoId`, all or nothing: whatever named the first (as business or as
 * platform) names the second, which takes the first's domain, brand and default category where it
 * has none (a default category only when it still exists, and also over one of the second's that no
 * longer does), and is a platform if either was. The first is deleted. Returns the merged merchant.
 */
export async function mergeMerchants(store: LedgerStore, fromId: string, intoId: string): Promise<Merchant> {
  const from = await existingMerchant(store, fromId)
  const into = await existingMerchant(store, intoId)
  if (from.id === into.id) return into
  const categories = await store.fetchCategories()
  // Only a default category that still exists is carried over, and it fills one the target lacks or
  // whose own no longer exists.
  const takesCategory = !isLiveDefaultCategory(into.defaultCategoryId, categories) && isLiveDefaultCategory(from.defaultCategoryId, categories)
  const merged: Merchant = {
    ...into,
    ...(into.domain === undefined && from.domain !== undefined ? { domain: from.domain } : {}),
    ...(into.brandId === undefined && from.brandId !== undefined ? { brandId: from.brandId } : {}),
    ...(takesCategory ? { defaultCategoryId: from.defaultCategoryId } : {}),
    isPlatform: into.isPlatform || from.isPlatform,
  }
  await store.atomically(async () => {
    await relinkAll(store, from.id, into.id)
    if (JSON.stringify(merged) !== JSON.stringify(into)) await store.saveMerchant(merged)
    await store.deleteMerchant(from.id)
  })
  return merged
}

/**
 * Runs after every pull, like `reassignDeletedCategories`: a device that linked a movement (or rule)
 * to a merchant before it heard of the merchant's deletion brings the deleted id back. Whatever still
 * names one of `deletedMerchantIds` (the tombstones) names no merchant now, as `deleteMerchant` did;
 * with nothing to repair nothing is written. Returns how many records changed.
 *
 * Known limitation: a tombstone doesn't say whether the merchant was deleted or merged into another,
 * so a link made offline to a merchant that was merged elsewhere is removed here, not moved to the
 * merge target. Carrying the target would need a wire field (a redirect on the tombstone).
 */
export async function unlinkDeletedMerchants(store: LedgerStore, deletedMerchantIds: ReadonlySet<string>): Promise<number> {
  if (deletedMerchantIds.size === 0) return 0
  const names = (item: MerchantLinks) =>
    (item.merchantId !== undefined && deletedMerchantIds.has(item.merchantId)) || (item.viaMerchantId !== undefined && deletedMerchantIds.has(item.viaMerchantId))
  const movements = (await store.fetchTransactions()).filter(names)
  const recurring = (await store.fetchRecurringRules()).filter(names)
  const rules = (await store.fetchCategorizationRules()).filter((rule) => rule.merchantId !== undefined && deletedMerchantIds.has(rule.merchantId))
  if (movements.length + recurring.length + rules.length === 0) return 0
  // Each record once, with every deleted id removed (a movement may name two deleted merchants).
  const clean = <T extends MerchantLinks>(item: T): T => {
    let current = item
    for (const id of deletedMerchantIds) current = relinked(current, id) ?? current
    return current
  }
  await store.atomically(async () => {
    for (const movement of movements) await store.saveTransaction(clean(movement))
    for (const rule of recurring) await store.saveRecurringRule(clean(rule))
    for (const rule of rules) {
      const { merchantId: _gone, ...rest } = rule
      await store.saveCategorizationRule(rest)
    }
  })
  return movements.length + recurring.length + rules.length
}
