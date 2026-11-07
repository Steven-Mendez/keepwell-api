import type { Entitlement, PlanName, PlansConfig } from "../capabilities"

export interface EntitlementRepository {
  forUser(userId: string): Promise<Entitlement[]>
  grant(userId: string, grant: { plan: PlanName; source: "manual" | "app_store"; reference?: string; expiresAt?: Date | null }): Promise<string>
}

/** The plan → capabilities table, read from configuration and refreshed without a deploy. */
export interface PlansSource {
  current(): Promise<PlansConfig>
}
