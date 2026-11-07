import { resolvePlan, type Capability, type ResolvedPlan } from "../capabilities"
import type { EntitlementRepository, PlansSource } from "../ports/entitlements"

export class ResolveCapabilities {
  constructor(
    private readonly entitlements: EntitlementRepository,
    private readonly plans: PlansSource,
    private readonly now: () => Date = () => new Date()
  ) {}

  async execute(userId: string): Promise<ResolvedPlan> {
    const [entitlements, config] = await Promise.all([this.entitlements.forUser(userId), this.plans.current()])
    return resolvePlan(entitlements, config, this.now())
  }

  async has(userId: string, capability: Capability): Promise<boolean> {
    return (await this.execute(userId)).capabilities.includes(capability)
  }
}
