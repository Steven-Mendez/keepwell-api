import { el, fullscreenButton, type Lang, type View, type ViewContext } from "../shared/app"
import { meter } from "../shared/chart"
import { money, monthName, shiftMonth } from "../shared/format"

interface Category {
  category: string
  amount: string
  share?: string
}
interface Budget {
  category: string
  budget: string
  spent: string
  level: "onTrack" | "nearLimit" | "exceeded"
}
interface Money {
  amount: string
  currency: string
}

/** get_monthly_summary's result. */
interface Summary {
  month: string
  currency: string
  income: string
  expense: string
  net: string
  spending_by_category: Category[]
  budgets: Budget[]
}

/** get_financial_context's result: this month, plus net worth and accounts. */
interface Context {
  today: string
  currencies: { principal: string }
  net_worth: Money
  accounts: { id: string; name: string; balances: Money[] }[]
  this_month: { month: string; income: string; expense: string; net: string; top_spending: Category[]; budgets: Budget[] }
}

type Data = Summary | Context

const text = {
  en: { income: "Income", spent: "Spent", net: "Net", netWorth: "Net worth", topSpending: "Where it went", budgets: "Budgets", accounts: "Accounts", previous: "Previous month", next: "Next month", nothing: "No movements this month.", of: "of", tightest: "Tightest budget" },
  es: { income: "Ingresos", spent: "Gastos", net: "Neto", netWorth: "Patrimonio", topSpending: "En qué se fue", budgets: "Presupuestos", accounts: "Cuentas", previous: "Mes anterior", next: "Mes siguiente", nothing: "Sin movimientos este mes.", of: "de", tightest: "Presupuesto más justo" },
} satisfies Record<Lang, Record<string, string>>

function normalize(data: Data): Summary & { context?: Context } {
  if ("this_month" in data) {
    const m = data.this_month
    return { month: m.month, currency: data.currencies.principal, income: m.income, expense: m.expense, net: m.net, spending_by_category: m.top_spending, budgets: m.budgets, context: data }
  }
  return data
}

function stat(label: string, value: string, className = ""): HTMLElement {
  return el("div", { class: "stat" }, el("span", { class: "caption" }, label), el("span", { class: `value num ${className}` }, value))
}

const ratio = (budget: Budget) => Number(budget.spent) / Math.max(Number(budget.budget), Number.EPSILON)
const tone = (budget: Budget) => (budget.level === "exceeded" ? "danger" : budget.level === "nearLimit" ? "warning" : "accent")

function render(data: Data, ctx: ViewContext) {
  const t = text[ctx.lang]
  const s = normalize(data)
  const full = ctx.isFullscreen
  const fmt = (amount: string) => money(amount, s.currency, ctx.lang)

  const header = el("div", { class: "header" }, el("h1", {}, monthName(s.month, ctx.lang)), fullscreenButton(ctx))

  const tightest = [...s.budgets].sort((a, b) => ratio(b) - ratio(a))[0]
  const stats = el(
    "div",
    { class: "stats" },
    stat(t.income, fmt(s.income), "income"),
    stat(t.spent, fmt(s.expense), "expense"),
    stat(t.net, fmt(s.net)),
    s.context && full ? stat(t.netWorth, money(s.context.net_worth.amount, s.context.net_worth.currency, ctx.lang)) : null,
    !full && tightest ? stat(t.tightest, `${tightest.category} · ${Math.round(ratio(tightest) * 100)}%`) : null
  )

  const categories = full ? s.spending_by_category : s.spending_by_category.slice(0, 5)
  const max = Math.max(...categories.map((c) => Number(c.amount)), 1)
  const spending =
    categories.length === 0
      ? el("p", { class: "muted" }, t.nothing)
      : el(
          "ul",
          { class: "list", "aria-label": t.topSpending },
          ...categories.map((c) => el("li", { class: "row" }, el("span", { class: "name" }, c.category), el("span", { class: "num" }, fmt(c.amount)), meter(Number(c.amount) / max)))
        )

  const budgets =
    full && s.budgets.length > 0
      ? el(
          "section",
          {},
          el("h2", {}, t.budgets),
          el(
            "ul",
            { class: "list" },
            ...s.budgets.map((b) =>
              el("li", { class: "row" }, el("span", { class: "name" }, b.category), el("span", { class: "num" }, `${fmt(b.spent)} ${t.of} ${fmt(b.budget)}`), meter(ratio(b), tone(b)))
            )
          )
        )
      : null

  const accounts =
    full && s.context
      ? el(
          "section",
          {},
          el("h2", {}, t.accounts),
          el(
            "ul",
            { class: "list" },
            ...s.context.accounts.map((a) =>
              el("li", { class: "row" }, el("span", { class: "name" }, a.name), el("span", { class: "num" }, a.balances.map((b) => money(b.amount, b.currency, ctx.lang)).join(" · ")))
            )
          )
        )
      : null

  // Another month is a new call to get_monthly_summary, from the view itself.
  const nav = full
    ? el(
        "div",
        { class: "actions" },
        navButton(`← ${t.previous}`, () => ctx.reload("get_monthly_summary", { month: shiftMonth(s.month, -1) })),
        navButton(`${t.next} →`, () => ctx.reload("get_monthly_summary", { month: shiftMonth(s.month, 1) }))
      )
    : null

  ctx.root.replaceChildren(header, stats, el("section", {}, el("h2", {}, t.topSpending), spending), budgets ?? "", accounts ?? "", nav ?? "")
}

function navButton(label: string, onClick: () => Promise<void>): HTMLElement {
  const button = el("button", { type: "button" }, label)
  button.addEventListener("click", () => void onClick())
  return button
}

export const summaryView: View<Data> = { name: "summary", render }
