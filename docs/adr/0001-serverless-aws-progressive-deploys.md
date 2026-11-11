# 0001. Serverless on AWS, Terraform, progressive deploys

Status: accepted, November 2026

## Context

Keepwell has one user today (its author) and should be able to take more without a rewrite. It needs
an HTTPS API for sync and MCP, a relational database, configuration and secrets, and a way to change
all of it safely. The author operates it alone, so every hour spent on servers is an hour not spent
on the product. AWS is a requirement.

## Decision

- **Serverless only**: one Lambda (Node 22, arm64) behind an API Gateway HTTP API, Aurora DSQL as the
  database (ADR 0003), SSM Parameter Store for configuration. Nothing to patch, scale or keep awake,
  and it costs under 2 USD a month at this size.
- **Terraform for everything** after a small, documented bootstrap (`BOOTSTRAP.md`): the state bucket
  and two GitHub OIDC roles. State in S3 with native locking (`use_lockfile`, Terraform 1.11+), no
  DynamoDB table.
- **Progressive deploys.** There is no "big first deploy". Every commit on `main` reaches production
  with exactly the infrastructure it needs: a resource enters in the commit whose code uses it, and a
  module folder is created with its first resource. What isn't finished isn't exposed: routes are
  not registered, or sit behind a switch.
- **The pipeline is the only path to production.** Pull requests run checks and show the
  `terraform plan` as a comment (read-only role). `main` runs migrations, `apply` and a smoke test
  (deploy role). OIDC, no stored keys. A plan that destroys a resource holding data blocks the merge.
- **`dev` before `prod`** from the moment a database exists: same definition, different variables.
  Tests that need a real DSQL cluster run against `dev`, never against the author's data.

## Alternatives

- **Containers (ECS/Fargate, App Runner).** Always-on cost and more moving parts for a workload that
  is idle most of the day.
- **CDK or SAM.** Fine tools; Terraform was chosen for its plan output in pull requests, its state
  model and because the same skill transfers outside AWS.
- **Writing the full infrastructure first and "turning it on" later.** Leaves resources without a
  consumer, costs money for nothing and hides mistakes until the day they matter.

## Consequences

- A cold start is part of the first request after idle. Kept short with a single esbuild bundle,
  arm64 and no VPC; measured in the logs (`cold start` line with `init_ms`). The API keeps one
  provisioned instance on `live` (about 4.4 USD a month at 512 MB) and warms the database,
  configuration, Better Auth and Apple's keys during init.
- Rollback is re-applying the previous commit, which reverts code and infrastructure together.
  Lambda publishes versions, so an alias can point back in seconds once there are external users.
- Two hours a month of upkeep (dependencies, provider upgrades, logs) is the real cost, larger than
  the AWS bill.
