# Architecture decisions

Each record states the context, the decision, the alternatives that lost and what it costs. A
decision that changes gets a new record that supersedes the old one; records are never rewritten.

| ADR                                             | Decision                                                      |
| ----------------------------------------------- | ------------------------------------------------------------- |
| [0001](0001-serverless-aws-progressive-deploys.md) | Serverless on AWS, Terraform, progressive deploys            |
| [0002](0002-hono.md)                            | Hono for HTTP, over Fastify and NestJS                        |
| [0003](0003-aurora-dsql.md)                     | Aurora DSQL and what it makes the code do                     |
| [0005](0005-sync-protocol.md)                  | Sync protocol: outbox, sync_state, delete wins, per-event rejection |
| [0006](0006-async-jobs.md)                      | SQS with a dead-letter queue, for account deletion only       |
