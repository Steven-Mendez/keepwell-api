import { startViews, type AnyView } from "./shared/app"
import { batchView } from "./views/batch"
import { pendingView } from "./views/pending"
import { summaryView } from "./views/summary"
import { trendsView } from "./views/trends"
import { upcomingView } from "./views/upcoming"

/**
 * One document for every tool with a view: the views share the SDK and zod, most of the weight, so
 * one ui:// resource is a quarter the size of four. The tool Claude called picks the renderer.
 */
const BY_TOOL: Record<string, AnyView> = {
  get_financial_context: summaryView,
  get_monthly_summary: summaryView,
  get_trends: trendsView,
  get_upcoming_payments: upcomingView,
  create_transaction: pendingView,
  create_recurring_rule: pendingView,
  apply_changes: batchView,
}

startViews((tool) => (tool ? BY_TOOL[tool] : undefined) ?? summaryView)
