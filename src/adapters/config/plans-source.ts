import { readFile } from "node:fs/promises"

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"

import { CLOSED_PLANS, PlansConfig } from "../../core/capabilities"
import type { PlansSource } from "../../core/ports/entitlements"
import type { Logger } from "../observability/logger"

/**
 * The plan table from SSM (`<prefix>/capabilities`, versioned in Terraform), cached for a minute so
 * changing it and applying takes effect within a minute, with no deploy. If it can't be read or
 * parsed, the last good value stays; with none, nothing paid is given away (`CLOSED_PLANS`).
 */
export class CachedPlansSource implements PlansSource {
  private cached?: { value: PlansConfig; at: number }

  constructor(
    private readonly load: () => Promise<string>,
    private readonly log: Logger,
    private readonly ttlMs = 60_000,
    private readonly now = () => Date.now()
  ) {}

  async current(): Promise<PlansConfig> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.value
    try {
      const value = PlansConfig.parse(JSON.parse(await this.load()))
      this.cached = { value, at: this.now() }
      return value
    } catch (error) {
      this.log.error({ err: error }, "plans configuration unreadable, keeping the last good value")
      const fallback = this.cached?.value ?? CLOSED_PLANS
      this.cached = { value: fallback, at: this.now() }
      return fallback
    }
  }
}

export function ssmPlansLoader(name: string, client = new SSMClient({})) {
  return async () => {
    const result = await client.send(new GetParameterCommand({ Name: name }))
    return result.Parameter?.Value ?? ""
  }
}

/** Development: `capabilities` in the local config file, the same JSON as the SSM parameter. */
export function filePlansLoader(path: string) {
  return async () => JSON.stringify((JSON.parse(await readFile(path, "utf8")) as { capabilities?: unknown }).capabilities)
}
