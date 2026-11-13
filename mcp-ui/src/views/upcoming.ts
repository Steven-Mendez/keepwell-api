import { el, fullscreenButton, segmented, type Lang, type View, type ViewContext } from "../shared/app"
import { dayName, money } from "../shared/format"

type Amount = { amount: string; currency: string }
type Status = "overdue" | "today" | "upcoming"
interface Common {
  date: string
  name: string
  /** Absent from servers older than the unified list: read as upcoming. */
  status?: Status
  days_from_today?: number
  amount?: Amount
}

type Payment = Common &
  (
    | { type: "recurring"; kind: "expense" | "income" | "transfer"; amount: Amount; is_subscription: boolean }
    | { type: "card_due"; due_day: number }
    | { type: "draft"; kind: "expense" | "income" | "transfer"; amount: Amount }
    | { type: "loan_installment"; number: number; count: number; amount: Amount }
    | { type: "personal_debt"; direction: "theyOweMe" | "iOwe"; amount: Amount }
    // A type this view doesn't know yet still shows, as its name and day.
    | { type: string }
  )

/** get_upcoming_payments' result: overdue first, then by date. */
interface Upcoming {
  from: string
  days: number
  payments: Payment[]
}

const text = {
  en: {
    title: (n: number) => `Next ${n} days`,
    empty: "Nothing due in these days.",
    subscription: "Subscription",
    cardDue: "Card payment due",
    draft: "To confirm",
    installment: (n: number, count: number) => `Installment ${n} of ${count}`,
    debt: "Debt",
    overdue: "Overdue",
    daysLate: (n: number) => (n === 1 ? "1 day late" : `${n} days late`),
    range: "Days shown",
    days: (n: number) => `${n} days`,
    more: (n: number) => `${n} more`,
  },
  es: {
    title: (n: number) => `Próximos ${n} días`,
    empty: "Nada por pagar en estos días.",
    subscription: "Suscripción",
    cardDue: "Vence el pago de la tarjeta",
    draft: "Por confirmar",
    installment: (n: number, count: number) => `Cuota ${n} de ${count}`,
    debt: "Deuda",
    overdue: "Atrasado",
    daysLate: (n: number) => (n === 1 ? "1 día de atraso" : `${n} días de atraso`),
    range: "Días a mostrar",
    days: (n: number) => `${n} días`,
    more: (n: number) => `${n} más`,
  },
} satisfies Record<Lang, Record<string, unknown>>

const INLINE_LIMIT = 6

/** What a row says under its name: its kind, and how late when it's overdue. */
function captions(p: Payment, lang: Lang): string[] {
  const t = text[lang]
  const kind = (() => {
    switch (p.type) {
      case "recurring":
        return "is_subscription" in p && p.is_subscription ? t.subscription : undefined
      case "card_due":
        return t.cardDue
      case "draft":
        return t.draft
      case "loan_installment":
        return "number" in p && "count" in p ? t.installment(p.number, p.count) : undefined
      case "personal_debt":
        return t.debt
      default:
        return undefined
    }
  })()
  return kind ? [kind] : []
}

function row(p: Payment, lang: Lang) {
  const income = ("kind" in p && p.kind === "income") || ("direction" in p && p.direction === "theyOweMe")
  const late = p.status === "overdue" && typeof p.days_from_today === "number" ? el("span", { class: "badge" }, text[lang].daysLate(-p.days_from_today)) : null
  return el(
    "li",
    { class: "row" },
    el("span", { class: "name" }, p.name),
    p.amount ? el("span", { class: `num ${income ? "income" : ""}` }, money(p.amount.amount, p.amount.currency, lang)) : null,
    ...captions(p, lang).map((caption) => el("span", { class: "caption" }, caption)),
    late
  )
}

function render(data: Upcoming, ctx: ViewContext) {
  const t = text[ctx.lang]
  const shown = ctx.isFullscreen ? data.payments : data.payments.slice(0, INLINE_LIMIT)
  const hidden = data.payments.length - shown.length

  // Overdue together on top, then grouped by day, in the order the API sorted them.
  const groups = new Map<string, { title: string; payments: Payment[] }>()
  for (const payment of shown) {
    const key = payment.status === "overdue" ? "overdue" : payment.date
    const group = groups.get(key) ?? { title: key === "overdue" ? t.overdue : dayName(payment.date, ctx.lang), payments: [] }
    group.payments.push(payment)
    groups.set(key, group)
  }

  const list =
    shown.length === 0
      ? el("p", { class: "muted" }, t.empty)
      : el(
          "div",
          { class: "list" },
          ...[...groups.values()].map(({ title, payments }) =>
            el("section", {}, el("h2", {}, title), el("ul", { class: "list" }, ...payments.map((p) => row(p, ctx.lang))))
          )
        )

  const more = hidden > 0 ? el("p", { class: "caption" }, t.more(hidden)) : null
  const range = segmented(
    t.range,
    [7, 30, 90].map((n) => ({ value: n, label: t.days(n) })),
    data.days,
    (days) => void ctx.reload("get_upcoming_payments", { days })
  )

  ctx.root.replaceChildren(el("div", { class: "header" }, el("h1", {}, t.title(data.days)), fullscreenButton(ctx)), list, more ?? "", el("div", { class: "actions" }, range))
}

export const upcomingView: View<Upcoming> = { name: "upcoming", render }
