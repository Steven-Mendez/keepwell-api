import type { Ledger, LedgerNotification } from "@/lib/domain"
import { formatAmount, formatMoney } from "@/lib/domain/format"
import type { Translator } from "@/lib/i18n/translate"

import { accountName, cardShortName, categoryNameById } from "./display"

/** What hidden balances show instead of an amount (`use-hidden-balances`, iOS' mask). */
const MASK = "••••"

/** Icons the inbox uses, a subset of the design's (`KWIconName`). */
export type NotificationIcon = "clock" | "creditCard" | "cash" | "subscription" | "chartBars" | "bolt"

// No React or components here: the API copies this file with the domain and words push
// notifications with it (ADR 0012), so the inbox, the banner and the iPhone read the same.

export interface NotificationCopy {
  icon: NotificationIcon
  tone: "pending" | "accent" | "negative"
  title: string
  body: string
}

/**
 * How a notification reads, with the iOS catalog's wording (the "home" table), so a notification
 * says the same in the inbox, in the browser's banner and on the iPhone.
 *
 * With balances hidden every amount is masked; the notification itself stays, since knowing that
 * something is due isn't the sensitive part.
 */
export function notificationCopy(t: Translator, ledger: Ledger, notification: LedgerNotification, hidden: boolean): NotificationCopy {
  const amount = (value: Parameters<typeof formatAmount>[0], currency: string) => (hidden ? MASK : formatAmount(value, currency))
  const money = (value: Parameters<typeof formatMoney>[0]) => (hidden ? MASK : formatMoney(value))
  const cards = (id: string | undefined) => (id ? ledger.cards.find((card) => card.id === id) : undefined)
  const account = (id: string) => ledger.accounts.find((candidate) => candidate.id === id)
  /** A credit account reads as its holder card ("Visa ··1234") when it has one, as on iOS. */
  const creditName = (id: string) => {
    const holder = ledger.cards.find((card) => card.accountId === id && card.kind === "creditHolder")
    const found = account(id)
    return holder ? cardShortName(t, holder) : found ? accountName(found) : ""
  }
  const method = (accountId: string, cardId: string | undefined) => {
    const card = cards(cardId)
    if (card && card.kind !== "transfer") return cardShortName(t, card)
    const found = account(accountId)
    return found ? accountName(found) : ""
  }

  switch (notification.kind) {
    case "planned": {
      const { description, amount: value, accountId, cardId } = notification.params
      return {
        icon: "clock",
        tone: "pending",
        title: t.in("home", "Draft for today"),
        body: t.in("home", "%@ · %@ from %@. Has it been paid?", description, money(value), method(accountId, cardId)),
      }
    }
    case "payment": {
      const { accountId, daysLeft, dueDay } = notification.params
      return {
        icon: "creditCard",
        tone: "negative",
        // "Payment in 0 days" reads like a glitch on the last day to pay.
        title:
          daysLeft === 0
            ? t.in("home", "%@: due today", creditName(accountId))
            : t.in("home", "%@: payment in %lld days", creditName(accountId), daysLeft),
        body: t.in("home", "Pay before day %lld so it doesn't generate interest.", dueDay),
      }
    }
    case "cutoff":
      return {
        icon: "clock",
        tone: "accent",
        title: t.in("home", "%@: statement closes today", creditName(notification.params.accountId)),
        body: t.in("home", "From tomorrow, purchases go to next month's statement."),
      }
    case "installment": {
      const { name, daysLeft, number, count, amount: value } = notification.params
      return {
        icon: "cash",
        tone: "pending",
        title: t.in("home", "%@: installment in %lld days", name, daysLeft),
        body: t.in("home", "Installment %lld of %lld · %@", number, count, money(value)),
      }
    }
    case "renewal": {
      const { name, amount: value, accountId, cardId } = notification.params
      return {
        icon: "subscription",
        tone: "accent",
        title: t.in("home", "%@ renews tomorrow", name),
        body: t.in("home", "%@ on %@", money(value), method(accountId, cardId)),
      }
    }
    case "bill": {
      const { name, amount: value, accountId, cardId } = notification.params
      return {
        icon: "cash",
        tone: "pending",
        title: t.in("home", "%@ is due tomorrow", name),
        body: t.in("home", "%@ on %@", money(value), method(accountId, cardId)),
      }
    }
    case "expiry": {
      const card = cards(notification.params.cardId)
      const { services } = notification.params
      return {
        icon: "creditCard",
        tone: "pending",
        title: t.in("home", "%@ expires this month", card ? cardShortName(t, card) : ""),
        body:
          services.length === 0
            ? t.in("home", "Update it wherever it's saved before it stops working.")
            : t.in("home", "Update it in %@ before it stops working.", new Intl.ListFormat(t.locale, { type: "conjunction" }).format(services)),
      }
    }
    case "budget": {
      const { categoryId, level, spent, budget, currency } = notification.params
      const name = categoryNameById(t, ledger.categories.find((category) => category.id === categoryId), categoryId)
      const exceeded = level === "exceeded"
      return {
        icon: "chartBars",
        tone: exceeded ? "negative" : "pending",
        title: exceeded ? t.in("home", "%@ went over its budget", name) : t.in("home", "%@ is close to its budget", name),
        body: t.in("home", "%@ spent of %@ this month.", amount(spent, currency), amount(budget, currency)),
      }
    }
    case "price": {
      const { name, current, previous } = notification.params
      return {
        icon: "subscription",
        tone: "pending",
        title: t.in("home", "%@ went up in price", name),
        body: t.in("home", "Now %@, before %@.", money(current), money(previous)),
      }
    }
    case "proposal": {
      const { name, amount: value } = notification.params
      return {
        icon: "bolt",
        tone: "accent",
        title: t.in("home", "Proposed by Claude"),
        body: `${name} · ${money(value)}`,
      }
    }
  }
}
