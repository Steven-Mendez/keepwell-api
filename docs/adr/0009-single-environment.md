# 0009. One environment: production

Date: 2026-11-08. Status: accepted. Amends 0001.

## Context

ADR 0001 planned `dev` then `prod`, each deploy reaching `dev` first. Keepwell has one person using
it, no team and no QA stage of its own; a second environment doubled the Apple setup (Services ID
return URLs, webhook URLs), the secrets and the console surface for little gain. The person who owns
it asked for production only.

## Decision

A single environment, `prod` (`infra/envs/prod`). Pull requests run checks and a Terraform plan
against it; merging to `main` applies, migrates, deploys and smoke-tests it. Integration tests
against real DSQL run locally with `pnpm test:remote` against a throwaway cluster when needed.

Without a custom domain, the web app (`https://keepwell-web.vercel.app`) forwards the API's paths
to API Gateway, so the browser and the iPhone see one origin.

## Consequences

- A migration or infrastructure change is first exercised in production. The safeguards that carry
  that weight: expand/contract migrations, the immutable-migrations check, `prevent_destroy` on the
  cluster, the plan step that fails on destroying a data resource, AWS Backup (35 days), and the
  `live` alias for instant code rollback (docs/runbooks/rollback.md).
- App Store Sandbox purchases are accepted in production: TestFlight and App Review buy in Sandbox
  against the production server.
- Adding a second environment later is a copy of `infra/envs/prod` with its own backend key.
