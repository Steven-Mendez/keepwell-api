import { readFile } from "node:fs/promises"

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"

import type { z } from "zod"

import { CLOSED_PLANS, PlansConfig } from "../../core/capabilities"
import type { PlansSource } from "../../core/ports/entitlements"
import { NORMAL_SWITCHES, Switches, type SwitchesSource } from "../../core/switches"
import type { Logger } from "../observability/logger"

/**
 * A JSON parameter read through a short cache. An unreadable or invalid value keeps the last good
 * one; with none, `fallback`.
 */
export class CachedParameter<T> {
  private cached?: { value: T; at: number }

  constructor(
    private readonly schema: z.ZodType<T>,
    private readonly fallback: T,
    private readonly load: () => Promise<string>,
    private readonly log: Logger,
    private readonly ttlMs: number,
    private readonly now = () => Date.now()
  ) {}

  async current(): Promise<T> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.value
    try {
      const value = this.schema.parse(JSON.parse(await this.load()))
      this.cached = { value, at: this.now() }
      return value
    } catch (error) {
      this.log.error({ err: error }, "parameter unreadable, keeping the last good value")
      const value = this.cached?.value ?? this.fallback
      this.cached = { value, at: this.now() }
      return value
    }
  }
}

/** Switches cached 30 seconds; unreadable means normal operation, so a broken parameter can't cause an outage. */
export class CachedSwitchesSource implements SwitchesSource {
  private readonly parameter: CachedParameter<Switches>
  constructor(load: () => Promise<string>, log: Logger, ttlMs = 30_000, now?: () => number) {
    this.parameter = new CachedParameter(Switches, NORMAL_SWITCHES, load, log, ttlMs, now)
  }

  current() {
    return this.parameter.current()
  }
}

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
export function filePlansLoader(path: string, key = "capabilities") {
  return async () => JSON.stringify((JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>)[key] ?? null)
}
