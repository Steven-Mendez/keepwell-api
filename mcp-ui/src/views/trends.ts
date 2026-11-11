import { el, fullscreenButton, segmented, type Lang, type View, type ViewContext } from "../shared/app"
import { columns } from "../shared/chart"
import { money, monthName } from "../shared/format"

/** get_trends' result, oldest month first. */
interface Trends {
  currency: string
  months: { month: string; income: string; expense: string; net: string }[]
}

const text = {
  en: { title: "Income and spending", income: "Income", spent: "Spent", net: "Net", month: "Month", range: "Months shown", months: (n: number) => `${n} months`, summary: (n: number) => `Income and spending for the last ${n} months` },
  es: { title: "Ingresos y gastos", income: "Ingresos", spent: "Gastos", net: "Neto", month: "Mes", range: "Meses a mostrar", months: (n: number) => `${n} meses`, summary: (n: number) => `Ingresos y gastos de los últimos ${n} meses` },
} satisfies Record<Lang, Record<string, unknown>>

function render(data: Trends, ctx: ViewContext) {
  const t = text[ctx.lang]
  const fmt = (amount: string) => money(amount, data.currency, ctx.lang)
  const count = data.months.length

  const range = segmented(
    t.range,
    [3, 6, 12].map((n) => ({ value: n, label: t.months(n) })),
    count,
    (months) => void ctx.reload("get_trends", { months })
  )

  const chart = columns(
    data.months.map((m) => monthName(m.month, ctx.lang, true)),
    [
      { label: t.income, values: data.months.map((m) => Number(m.income)), className: "bar-income" },
      { label: t.spent, values: data.months.map((m) => Number(m.expense)), className: "bar-expense" },
    ],
    t.summary(count)
  )

  // The exact figures, for reading and for screen readers; inline only the totals of the last month.
  const rows = ctx.isFullscreen ? data.months : data.months.slice(-1)
  const table = el(
    "table",
    {},
    el("thead", {}, el("tr", {}, el("th", { scope: "col" }, t.month), el("th", { scope: "col" }, t.income), el("th", { scope: "col" }, t.spent), el("th", { scope: "col" }, t.net))),
    el(
      "tbody",
      {},
      ...rows.map((m) =>
        el(
          "tr",
          {},
          el("th", { scope: "row" }, monthName(m.month, ctx.lang)),
          el("td", { class: "num income" }, fmt(m.income)),
          el("td", { class: "num expense" }, fmt(m.expense)),
          el("td", { class: "num" }, fmt(m.net))
        )
      )
    )
  )

  ctx.root.replaceChildren(
    el("div", { class: "header" }, el("h1", {}, t.title), fullscreenButton(ctx)),
    chart,
    el("div", { class: "legend", "aria-hidden": "true" }, el("span", { class: "income" }, t.income), el("span", { class: "expense" }, t.spent)),
    table,
    el("div", { class: "actions" }, range)
  )
}

export const trendsView: View<Trends> = { name: "trends", render }
