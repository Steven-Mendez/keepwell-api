import { describe, expect, it } from "vitest"

import { CLOSED_PLANS, resolvePlan, type Entitlement, type PlansConfig } from "../../src/core/capabilities"

const now = new Date("2026-11-06T12:00:00Z")
const grant = (plan: Entitlement["plan"], extra: Partial<Entitlement> = {}): Entitlement => ({ plan, grantedAt: new Date("2026-01-01"), expiresAt: null, revokedAt: null, ...extra })
const launch: PlansConfig = { ...CLOSED_PLANS, early_access: { cloud_sync: true } }

describe("plans and capabilities", () => {
  it("gives a free account sync during early access, and nothing once it ends", () => {
    expect(resolvePlan([], launch, now)).toEqual({ plan: "free", capabilities: ["cloud_sync"], earlyAccess: ["cloud_sync"] })
    expect(resolvePlan([], CLOSED_PLANS, now)).toEqual({ plan: "free", capabilities: [], earlyAccess: [] })
  })

  it("opens the MCP with the coffee (supporter)", () => {
    expect(resolvePlan([grant("supporter")], launch, now)).toEqual({ plan: "supporter", capabilities: ["cloud_sync", "mcp"], earlyAccess: ["cloud_sync"] })
  })

  it("takes the highest active plan and ignores revoked or expired grants", () => {
    const grants = [grant("supporter", { revokedAt: new Date("2026-06-01") }), grant("pro", { expiresAt: new Date("2026-10-01") }), grant("grandfathered", { expiresAt: new Date("2027-11-06") })]
    expect(resolvePlan(grants, CLOSED_PLANS, now)).toMatchObject({ plan: "grandfathered", capabilities: ["cloud_sync", "mcp"], earlyAccess: [] })
    expect(resolvePlan([grant("supporter", { revokedAt: new Date("2026-06-01") })], CLOSED_PLANS, now).plan).toBe("free")
  })

  it("doesn't count early access for what a plan already gives", () => {
    expect(resolvePlan([grant("pro")], launch, now).earlyAccess).toEqual([])
  })
})
