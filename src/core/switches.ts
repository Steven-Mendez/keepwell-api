import { z } from "zod"

/**
 * Emergency switches (incident runbook): flipped in SSM, read on every request through a short cache,
 * effective within half a minute and without a deploy.
 */
export const Switches = z.object({
  /** false: every MCP request is refused; sync and the apps keep working. */
  mcp_enabled: z.boolean(),
  /** true: every write (sync push, MCP writes) is refused while an incident is investigated. */
  read_only: z.boolean(),
})
export type Switches = z.infer<typeof Switches>

export const NORMAL_SWITCHES: Switches = { mcp_enabled: true, read_only: false }

export interface SwitchesSource {
  current(): Promise<Switches>
}
