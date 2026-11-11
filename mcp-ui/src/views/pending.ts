import { el, type Lang, type View, type ViewContext } from "../shared/app"
import { dayName, money } from "../shared/format"

/** What create_transaction and create_recurring_rule return. */
interface Pending {
  id: string
  status: "pending_confirmation"
  amount?: { amount: string; currency: string }
  date?: string
  description?: string
  next_date?: string
}

/** The tool's arguments, which carry what the result leaves out (kind, account, frequency, name). */
interface Input {
  kind?: "expense" | "income" | "transfer"
  amount?: string
  currency?: string
  account_id?: string
  description?: string
  name?: string
  date?: string
  start_date?: string
  frequency?: "weekly" | "monthly" | "yearly"
  interval?: number
  is_subscription?: boolean
}

const text = {
  en: {
    movement: "Movement to confirm",
    rule: "Recurring movement to confirm",
    preparing: "Preparing…",
    badge: "Pending",
    note: "It doesn't count toward your balances until you confirm it in Keepwell.",
    amount: "Amount",
    account: "Account",
    date: "Date",
    next: "First on",
    every: "Repeats",
    kinds: { expense: "Expense", income: "Income", transfer: "Transfer" },
    frequency: (f: string, n: number) => (n > 1 ? `Every ${n} ${f === "weekly" ? "weeks" : f === "monthly" ? "months" : "years"}` : f === "weekly" ? "Weekly" : f === "monthly" ? "Monthly" : "Yearly"),
    subscription: "Subscription",
  },
  es: {
    movement: "Movimiento por confirmar",
    rule: "Movimiento recurrente por confirmar",
    preparing: "Preparando…",
    badge: "Pendiente",
    note: "No cuenta en tus saldos hasta que lo confirmes en Keepwell.",
    amount: "Monto",
    account: "Cuenta",
    date: "Fecha",
    next: "Primera vez",
    every: "Se repite",
    kinds: { expense: "Gasto", income: "Ingreso", transfer: "Transferencia" },
    frequency: (f: string, n: number) => (n > 1 ? `Cada ${n} ${f === "weekly" ? "semanas" : f === "monthly" ? "meses" : "años"}` : f === "weekly" ? "Semanal" : f === "monthly" ? "Mensual" : "Anual"),
    subscription: "Suscripción",
  },
} satisfies Record<Lang, Record<string, unknown>>

let input: Input = {}
/** Account names, looked up once with list_accounts so the card never shows a raw id. */
let accounts: Map<string, string> | undefined

function pair(label: string, value: string | null | undefined): HTMLElement | null {
  return value ? el("div", { class: "pair" }, el("dt", {}, label), el("dd", {}, value)) : null
}

function draw(result: Pending | undefined, ctx: ViewContext) {
  const t = text[ctx.lang]
  const isRule = input.frequency !== undefined || result?.next_date !== undefined
  const title = isRule ? t.rule : t.movement
  const label = input.name ?? result?.description ?? input.description ?? ""
  const amount = result?.amount ?? (input.amount && input.currency ? { amount: input.amount, currency: input.currency } : undefined)
  const date = result?.next_date ?? result?.date ?? input.start_date ?? input.date

  ctx.root.replaceChildren(
    el(
      "article",
      { class: "card" },
      el("div", { class: "header" }, el("h1", {}, title), el("span", { class: "badge" }, result ? t.badge : t.preparing)),
      label ? el("p", { class: "value" }, label) : "",
      el(
        "dl",
        {},
        pair(t.amount, amount ? `${input.kind ? `${t.kinds[input.kind]} · ` : ""}${money(amount.amount, amount.currency, ctx.lang)}` : null) ?? "",
        pair(t.account, input.account_id ? (accounts?.get(input.account_id) ?? null) : null) ?? "",
        pair(isRule ? t.next : t.date, date ? dayName(date, ctx.lang) : null) ?? "",
        pair(t.every, input.frequency ? `${t.frequency(input.frequency, input.interval ?? 1)}${input.is_subscription ? ` · ${t.subscription}` : ""}` : null) ?? ""
      ),
      el("p", { class: "caption" }, t.note)
    )
  )
}

let latest: Pending | undefined

export const pendingView: View<Pending> = {
  name: "pending",
  input(args, ctx) {
    input = args as Input
    draw(latest, ctx)
    if (input.account_id && !accounts) {
      void ctx.app
        .callServerTool({ name: "list_accounts", arguments: {} })
        .then((result) => {
          const list = (result.structuredContent as { accounts?: { id: string; name: string }[] } | undefined)?.accounts ?? []
          accounts = new Map(list.map((a) => [a.id, a.name]))
          draw(latest, ctx)
        })
        .catch(() => undefined)
    }
  },
  render(data, ctx) {
    latest = data
    draw(data, ctx)
  },
}
