import { el, type Lang, type View, type ViewContext } from "../shared/app"
import { money } from "../shared/format"

/** What apply_changes returns: one result per step, in order, and how many rows changed. */
interface Batch {
  results: (Record<string, unknown> & { tool: string })[]
  changes: { created: number; updated: number; deleted: number }
}

const text = {
  en: {
    title: (n: number) => (n === 1 ? "1 change saved" : `${n} changes saved`),
    badge: "Saved",
    note: "Saved in Keepwell together.",
    more: (n: number) => `and ${n} more`,
    already: "already there",
    steps: {
      create_account: "New account",
      create_credit_card: "New credit card",
      update_account: "Account edited",
      update_card: "Card edited",
      create_category: "New category",
      update_category: "Category edited",
      reorder_categories: "Categories reordered",
      restore_default_categories: "Default categories restored",
      create_transaction: "Movement",
      update_transaction: "Movement edited",
      confirm_transaction: "Movement confirmed",
      create_recurring_rule: "New recurring payment",
      update_recurring_rule: "Recurring payment edited",
      set_recurring_rule_paused: "Recurring payment paused or resumed",
      create_savings_goal: "New savings goal",
      update_savings_goal: "Savings goal edited",
      move_savings_goal_money: "Savings goal updated",
      create_loan: "New loan",
      update_loan: "Loan edited",
      pay_loan_installment: "Installment paid",
      create_personal_debt: "New personal debt",
      update_personal_debt: "Personal debt edited",
      update_personal_debt_status: "Personal debt updated",
      create_categorization_rule: "New categorization rule",
      update_categorization_rule: "Categorization rule edited",
      update_settings: "Settings changed",
    } as Record<string, string>,
  },
  es: {
    title: (n: number) => (n === 1 ? "1 cambio guardado" : `${n} cambios guardados`),
    badge: "Guardado",
    note: "Guardados en Keepwell, todos juntos.",
    more: (n: number) => `y ${n} más`,
    already: "ya existía",
    steps: {
      create_account: "Cuenta nueva",
      create_credit_card: "Tarjeta de crédito nueva",
      update_account: "Cuenta editada",
      update_card: "Tarjeta editada",
      create_category: "Categoría nueva",
      update_category: "Categoría editada",
      reorder_categories: "Categorías reordenadas",
      restore_default_categories: "Categorías de fábrica restauradas",
      create_transaction: "Movimiento",
      update_transaction: "Movimiento editado",
      confirm_transaction: "Movimiento confirmado",
      create_recurring_rule: "Pago recurrente nuevo",
      update_recurring_rule: "Pago recurrente editado",
      set_recurring_rule_paused: "Pago recurrente pausado o reanudado",
      create_savings_goal: "Meta de ahorro nueva",
      update_savings_goal: "Meta de ahorro editada",
      move_savings_goal_money: "Meta de ahorro actualizada",
      create_loan: "Préstamo nuevo",
      update_loan: "Préstamo editado",
      pay_loan_installment: "Cuota pagada",
      create_personal_debt: "Deuda personal nueva",
      update_personal_debt: "Deuda personal editada",
      update_personal_debt_status: "Deuda personal actualizada",
      create_categorization_rule: "Regla de categorización nueva",
      update_categorization_rule: "Regla de categorización editada",
      update_settings: "Ajustes cambiados",
    } as Record<string, string>,
  },
} satisfies Record<Lang, unknown>

const SHOWN = 8

/** The step's own words: what was created and, for a movement, its amount. */
function describe(step: Batch["results"][number], lang: Lang): { label: string; detail: string | null } {
  const t = text[lang]
  const kind = t.steps[step.tool] ?? step.tool
  const name = [step.name, step.description, step.person].find((value) => typeof value === "string" && value) as string | undefined
  const amount = step.amount as { amount?: string; currency?: string } | undefined
  const detail = step.already_existed ? t.already : amount?.amount && amount.currency ? money(amount.amount, amount.currency, lang) : null
  return { label: name ? `${kind} · ${name}` : kind, detail }
}

function render(data: Batch, ctx: ViewContext) {
  const t = text[ctx.lang]
  const steps = data.results ?? []
  const shown = steps.slice(0, SHOWN)
  ctx.root.replaceChildren(
    el(
      "article",
      { class: "card" },
      el("div", { class: "header" }, el("h1", {}, t.title(steps.length)), el("span", { class: "badge saved" }, t.badge)),
      el(
        "ul",
        { class: "list" },
        ...shown.map((step) => {
          const { label, detail } = describe(step, ctx.lang)
          return el("li", { class: "row" }, el("span", { class: "name" }, label), detail ? el("span", { class: "num" }, detail) : el("span", {}, ""))
        })
      ),
      steps.length > SHOWN ? el("p", { class: "caption" }, t.more(steps.length - SHOWN)) : "",
      el("p", { class: "caption" }, t.note)
    )
  )
}

export const batchView: View<Batch> = { name: "batch", render }
