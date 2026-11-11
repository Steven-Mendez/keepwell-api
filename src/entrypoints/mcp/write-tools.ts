import { registerAppTool } from "@modelcontextprotocol/ext-apps/server"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import type { Logger } from "../../adapters/observability/logger"
import { CreatePending, McpWriteError } from "../../core/use-cases/create-pending"
import { VIEWS_URI } from "./ui/resources"

const decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/, "a positive exact decimal such as 12.50")
const instant = z.string().refine((text) => !Number.isNaN(Date.parse(text)), "an ISO 8601 date or date-time")

const common = {
  id: z.string().uuid().describe("A new UUID you generate once and reuse if you retry, so the call is never recorded twice"),
  kind: z.enum(["expense", "income", "transfer"]),
  amount: decimal.describe("Always positive; kind gives the direction"),
  currency: z.string().length(3).describe("ISO 4217, the principal or second currency in get_financial_context"),
  account_id: z.string().describe("From list_accounts"),
  card_id: z.string().optional().describe("A card of that account, when it was paid by card"),
  destination_account_id: z.string().optional().describe("Transfers only"),
  category_id: z.string().optional().describe("From get_monthly_summary; left out for transfers"),
  note: z.string().max(500).optional(),
}

/**
 * The two write tools (ADR 0007, increment 18), registered only for tokens with the `write` scope.
 * Both create something that waits for the person to confirm it in an app.
 */
export function registerWriteTools(server: McpServer, options: { create: CreatePending; userId: string; clientId: string; log: Logger }) {
  const run = async (name: string, work: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      const result = await work()
      options.log.info({ mcp_tool: name, client_id: options.clientId, ok: true }, "mcp write")
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> }
    } catch (error) {
      const code = error instanceof McpWriteError ? error.code : "failed"
      options.log.warn({ mcp_tool: name, client_id: options.clientId, ok: false, code }, "mcp write refused")
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message: error instanceof Error ? error.message : "Not saved" }) }] }
    }
  }

  // Both show the pending card: what was prepared, waiting for the person in Keepwell.
  const pendingView = { ui: { resourceUri: VIEWS_URI } }

  registerAppTool(
    server,
    "create_transaction",
    {
      title: "Record a movement",
      _meta: pendingView,
      description:
        "Record a movement. It is saved as pending: it doesn't count toward balances until the person confirms it in Keepwell, and it shows as recorded by you.",
      inputSchema: { ...common, description: z.string().min(1).max(200), date: instant.describe("When it happened") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => run("create_transaction", () => options.create.transaction(options.userId, options.clientId, args))
  )

  registerAppTool(
    server,
    "create_recurring_rule",
    {
      title: "Set up a recurring movement",
      _meta: pendingView,
      description: "Set up a recurring movement or subscription. It stays paused, recording nothing, until the person confirms it in Keepwell.",
      inputSchema: {
        ...common,
        name: z.string().min(1).max(100),
        frequency: z.enum(["weekly", "monthly", "yearly"]),
        interval: z.number().int().min(1).max(99).default(1),
        start_date: instant.describe("The first occurrence"),
        end_date: instant.optional(),
        is_subscription: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => run("create_recurring_rule", () => options.create.recurringRule(options.userId, options.clientId, args))
  )
}
