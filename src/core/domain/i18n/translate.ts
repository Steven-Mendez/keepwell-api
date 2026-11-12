import catalog from "./strings.json"
import { WEB_STRINGS } from "./web-strings"

/**
 * The texts of the iOS string catalogs, copied by hand and keyed by the English source text exactly
 * as iOS writes it. English is the source language; Spanish is the first translation. `%@` and `%lld` take
 * arguments in order; a plural entry picks its form from the first number.
 */
export type Locale = "en" | "es"
export const LOCALES: readonly Locale[] = ["en", "es"]

type Unit = string | Record<string, string>
type Entry = { en?: Unit; es?: Unit }
type Catalog = Record<string, Record<string, Entry>>
export type Namespace = keyof typeof catalog | "web"

const strings: Catalog = { ...(catalog as Catalog), web: WEB_STRINGS }

/** Lookup order when no namespace is given: shared text first, like iOS SharedPresentation. */
const SEARCH_ORDER: readonly string[] = [
  "sharedpresentation",
  "createtransaction",
  "home",
  "transactions",
  "accounts",
  "creditcard",
  "addcard",
  "summary",
  "settings",
  "onboarding",
  "app",
  "designsystem",
  "lock",
  "widgets",
  "plan",
  "web",
]

export type Arg = string | number

function entryFor(key: string, ns?: string): Entry | undefined {
  if (ns) return strings[ns]?.[key]
  for (const name of SEARCH_ORDER) {
    const entry = strings[name]?.[key]
    if (entry) return entry
  }
  return undefined
}

const pluralRules: Record<Locale, Intl.PluralRules> = {
  en: new Intl.PluralRules("en"),
  es: new Intl.PluralRules("es"),
}

function fill(template: string, args: readonly Arg[]): string {
  let index = 0
  // "%@" takes the next argument; "%2$@" names one, as translations reorder them ("%1$@ y %2$@").
  return template.replace(
    /%(?:(\d+)\$)?(%|@|lld|d)/g,
    (match, position: string | undefined, spec: string) => {
      if (spec === "%") return "%"
      const value =
        position === undefined ? args[index++] : args[Number(position) - 1]
      return value === undefined ? match : String(value)
    }
  )
}

export function translate(
  locale: Locale,
  key: string,
  args: readonly Arg[] = [],
  ns?: string
): string {
  const entry = entryFor(key, ns)
  const unit = entry?.[locale] ?? entry?.en ?? key
  if (typeof unit === "string") return fill(unit, args)
  const count = args.find((arg): arg is number => typeof arg === "number") ?? 0
  const form = pluralRules[locale].select(count)
  return fill(unit[form] ?? unit.other ?? Object.values(unit)[0] ?? key, args)
}

/** Whether the catalog has `key` (for tests and for picking between iOS keys). */
export function hasString(key: string, ns?: string): boolean {
  return entryFor(key, ns) !== undefined
}

export interface Translator {
  (key: string, ...args: Arg[]): string
  /** The same key from one catalog, for the few keys iOS translates differently per screen. */
  in(ns: Namespace, key: string, ...args: Arg[]): string
  locale: Locale
}

export function makeTranslator(locale: Locale): Translator {
  const t = ((key: string, ...args: Arg[]) =>
    translate(locale, key, args)) as Translator
  t.in = (ns, key, ...args) => translate(locale, key, args, ns)
  t.locale = locale
  return t
}
