// `@/lib/i18n` in keepwell-web is a React barrel (translate + provider). The copied presentation
// files only import the `Translator` type from it, so the alias points here instead, at the
// React-free part. See "The shared domain" in README.md.
export type { Arg, Locale, Namespace, Translator } from "../domain/i18n/translate"
