import { z } from "zod"

// Plans and capabilities (ADR 0008). The API never asks "which plan?" in a route; it asks "may this
// user do X?". Which plan grants what is configuration (an SSM parameter), not code, so opening or
// closing a capability is a parameter change, not a deploy.

export const CAPABILITIES = ["cloud_sync", "mcp"] as const
export const Capability = z.enum(CAPABILITIES)
export type Capability = z.infer<typeof Capability>

/** Ordered by rank: the current plan is the highest-ranked active grant. */
export const PLANS = ["free", "supporter", "pro", "grandfathered"] as const
export const PlanName = z.enum(PLANS)
export type PlanName = z.infer<typeof PlanName>

export const PlansConfig = z.object({
  /** Capabilities every signed-in account has while early access lasts. */
  early_access: z.partialRecord(Capability, z.boolean()),
  plans: z.record(PlanName, z.array(Capability)),
})
export type PlansConfig = z.infer<typeof PlansConfig>

/** What the API ships with when the parameter is unreadable: nothing paid is given away. */
export const CLOSED_PLANS: PlansConfig = {
  early_access: {},
  plans: { free: [], supporter: ["mcp"], pro: ["cloud_sync", "mcp"], grandfathered: ["cloud_sync", "mcp"] },
}

export interface Entitlement {
  plan: PlanName
  grantedAt: Date
  expiresAt: Date | null
  revokedAt: Date | null
}

export interface ResolvedPlan {
  plan: PlanName
  capabilities: Capability[]
  /** Capabilities that come only from early access, so the apps can say "included during early access". */
  earlyAccess: Capability[]
}

export function isActive(entitlement: Entitlement, now: Date): boolean {
  return entitlement.revokedAt === null && entitlement.grantedAt <= now && (entitlement.expiresAt === null || entitlement.expiresAt > now)
}

/** No rows means `free`. Capabilities are the union of every active plan and early access. */
export function resolvePlan(entitlements: Entitlement[], config: PlansConfig, now: Date): ResolvedPlan {
  const active = entitlements.filter((entitlement) => isActive(entitlement, now)).map((entitlement) => entitlement.plan)
  const plan = active.reduce<PlanName>((best, candidate) => (PLANS.indexOf(candidate) > PLANS.indexOf(best) ? candidate : best), "free")
  const fromPlans = new Set<Capability>(["free", ...active].flatMap((name) => config.plans[name as PlanName] ?? []))
  const earlyAccess = CAPABILITIES.filter((capability) => config.early_access[capability] === true && !fromPlans.has(capability))
  const capabilities = CAPABILITIES.filter((capability) => fromPlans.has(capability) || earlyAccess.includes(capability))
  return { plan, capabilities, earlyAccess }
}
