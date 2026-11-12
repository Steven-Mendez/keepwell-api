# Architecture decisions

Each record states the context, the decision, the alternatives that lost and what it costs. A
decision that changes gets a new record that supersedes the old one; records are never rewritten.

| ADR                                             | Decision                                                      |
| ----------------------------------------------- | ------------------------------------------------------------- |
| [0001](0001-serverless-aws-progressive-deploys.md) | Serverless on AWS, Terraform, progressive deploys            |
| [0002](0002-hono.md)                            | Hono for HTTP, over Fastify and NestJS                        |
| [0003](0003-aurora-dsql.md)                     | Aurora DSQL and what it makes the code do                     |
| [0004](0004-financial-data-model.md)           | Derived balances, immutable history, reconciliation, isolation |
| [0005](0005-sync-protocol.md)                  | Sync protocol: outbox, sync_state, delete wins, per-event rejection |
| [0006](0006-async-jobs.md)                      | SQS with a dead-letter queue, for account deletion only       |
| [0007](0007-oauth-for-mcp.md)                  | OAuth 2.1 for MCP with Better Auth: CIMD first, PKCE, revocation |
| [0008](0008-capabilities-by-configuration.md)    | Capabilities by configuration, not plans in code              |
| [0009](0009-single-environment.md)               | One environment, production                                   |
| [0010](0010-mcp-module-and-apps.md)             | The MCP as a separable module, with MCP Apps views            |
| [0011](0011-mcp-manage-scope.md)               | A `manage` scope: the MCP does what the app does, with undoable deletes |
| [0012](0012-notifications.md)                   | Notifications: one inbox computed from the ledger, its state synced, push from the server |
