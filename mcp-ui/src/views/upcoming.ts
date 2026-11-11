import { el, fullscreenButton, segmented, type Lang, type View, type ViewContext } from "../shared/app"
import { dayName, money } from "../shared/format"

type Payment =
  | { type: "recurring"; date: string; name: string; kind: "expense" | "income" | "transfer"; amount: { amount: string; currency: string }; is_subscription: boolean }
  | { type: "card_due"; date: string; name: string; due_day: number }

/** get_upcoming_payments' result, sorted by date. */
interface Upcoming {
  from: string
  days: number
  payments: Payment[]
}

const text = {
  en: { title: (n: number) => `Next ${n} days`, empty: "Nothing due in these days.", subscription: "Subscription", cardDue: "Card payment due", range: "Days shown", days: (n: number) => `${n} days`, more: (n: number) => `${n} more` },
  es: { title: (n: number) => `Próximos ${n} días`, empty: "Nada por pagar en estos días.", subscription: "Suscripción", cardDue: "Vence el pago de la tarjeta", range: "Días a mostrar", days: (n: number) => `${n} días`, more: (n: number) => `${n} más` },
} satisfies Record<Lang, Record<string, unknown>>

const INLINE_LIMIT = 6

function render(data: Upcoming, ctx: ViewContext) {
  const t = text[ctx.lang]
  const shown = ctx.isFullscreen ? data.payments : data.payments.slice(0, INLINE_LIMIT)
  const hidden = data.payments.length - shown.length

  // Grouped by day, in the order the API sorted them.
  const days = new Map<string, Payment[]>()
  for (const payment of shown) days.set(payment.date, [...(days.get(payment.date) ?? []), payment])

  const list =
    shown.length === 0
      ? el("p", { class: "muted" }, t.empty)
      : el(
          "div",
          { class: "list" },
          ...[...days].map(([date, payments]) =>
            el(
              "section",
              {},
              el("h2", {}, dayName(date, ctx.lang)),
              el(
                "ul",
                { class: "list" },
                ...payments.map((p) =>
                  p.type === "recurring"
                    ? el(
                        "li",
                        { class: "row" },
                        el("span", { class: "name" }, p.name),
                        el("span", { class: `num ${p.kind === "income" ? "income" : ""}` }, money(p.amount.amount, p.amount.currency, ctx.lang)),
                        p.is_subscription ? el("span", { class: "caption" }, t.subscription) : null
                      )
                    : el("li", { class: "row" }, el("span", { class: "name" }, p.name), el("span", { class: "caption" }, t.cardDue))
                )
              )
            )
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
