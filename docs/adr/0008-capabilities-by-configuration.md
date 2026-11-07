# 0008. Capabilities by configuration, not plans in code

Status: accepted, November 2026

## Context

At launch sync is free (early access) and the MCP opens with a one-time purchase, the "coffee"
(`PLAN_MONETIZACION.md`). Later sync moves to a Pro subscription and coffee buyers get a year of
Pro. Each of those steps should be a configuration change, not a deploy, and no route should know
plan names.

## Decision

- Routes ask for a **capability** (`cloud_sync`, `mcp`) through `requireCapability`, always after
  authentication: `401` (who are you) before `403 needs_plan` (what you'd need).
- Which **plan** grants which capability, plus early-access flags, is one JSON parameter in SSM,
  versioned in Terraform (`infra/modules/parameters`). The API rereads it within a minute; an
  unreadable value keeps the last good one, and with none nothing paid is given away.
- Plans are rows in `entitlements` (plan, source, reference, granted, expires, revoked). The current
  plan is the highest-ranked active row; capabilities are the union of active plans and early
  access. No rows means `free`. Grants come from the App Store (increment 23) or by hand
  (`pnpm grant`), each with an audit entry.
- `GET /me` returns plan, capabilities and which of them come only from early access, so the apps can
  say "included during early access". Apps never infer capabilities themselves; on `needs_plan` they
  stop retrying until `/me` changes.

## Alternatives

- **`if (user.plan === "pro")` in routes.** Every pricing change becomes a code change across sync,
  MCP and both apps.
- **A feature-flag service.** One JSON parameter does the job for two capabilities.

## Consequences

- Ending early access is `early_access.cloud_sync = false` and an apply. Clients already handle
  `needs_plan` from their first sync version, so old apps don't loop.
- Turning coffee buyers into Pro is a one-off script that adds `grandfathered` rows with a twelve-month
  expiry.
