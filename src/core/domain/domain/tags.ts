import type { Transaction } from "../schema"

// Port of iOS `Tags` (Packages/Domain/Sources/Domain/Entities/Tags.swift): labels a movement carries
// besides its category ("#viaje-mexico", "#boda"), stored normalized so both apps keep the same tag.

/** Counted in code points (`[...text]`), which iOS counts as Unicode scalars, so both cut alike. */
export const MAX_TAG_LENGTH = 32

/**
 * The stored form of a tag: trimmed, without the leading "#", lowercased, spaces turned into "-", at
 * most `MAX_TAG_LENGTH` long. Accents stay ("méxico"). `undefined` when nothing is left.
 */
export function normalizedTag(raw: string): string | undefined {
  let text = raw.trim()
  while (text.startsWith("#")) text = text.slice(1).trim()
  text = text.toLowerCase().normalize("NFC")
  text = text.split(/\s+/u).filter((part) => part !== "").join("-")
  text = [...text].slice(0, MAX_TAG_LENGTH).join("")
  text = text.replace(/^-+|-+$/g, "")
  return text === "" ? undefined : text
}

/** Each tag normalized once, in the order first given; blanks and repeats dropped. */
export function normalizedTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const tag = normalizedTag(raw)
    if (tag === undefined || seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }
  return result
}

/** How a CSV row writes them: "#viaje-mexico #boda", or "" without any. */
export function tagsCsvField(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(" ")
}

/** The tags a CSV cell lists, split on spaces or commas ("#boda, #viaje-mexico"), normalized. */
export function parsedCsvTags(text: string): string[] {
  return normalizedTags(text.split(/[\s,]+/u))
}

/** `tags` with `added` after them, each once. */
export function mergeTags(tags: readonly string[], added: readonly string[]): string[] {
  return normalizedTags([...tags, ...added])
}

/** `{ tags }` when there are any, `{}` otherwise: the key is left out when empty, as in the backup. */
export function tagsField(tags: readonly string[] | undefined): { tags?: string[] } {
  const normalized = normalizedTags(tags ?? [])
  return normalized.length === 0 ? {} : { tags: normalized }
}

/** Every tag used, most used first, then alphabetically: the editor's suggestions. */
export function tagUsage(transactions: readonly Pick<Transaction, "tags">[]): string[] {
  const counts = new Map<string, number>()
  for (const transaction of transactions) {
    for (const tag of transaction.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a, countA], [b, countB]) => (countA === countB ? (a < b ? -1 : a > b ? 1 : 0) : countB - countA))
    .map(([tag]) => tag)
}

/** Up to `limit` used tags containing what's typed, the ones already chosen left out. */
export function tagSuggestions(usage: readonly string[], typing: string, excluding: readonly string[], limit = 8): string[] {
  const needle = normalizedTag(typing) ?? ""
  return usage.filter((tag) => !excluding.includes(tag) && (needle === "" || tag.includes(needle))).slice(0, limit)
}

/** The tag a search asks for: "#boda" narrows the list to that tag; any other search, `undefined`. */
export function searchedTag(query: string): string | undefined {
  const text = query.trim()
  if (!text.startsWith("#")) return undefined
  return normalizedTag(text)
}
