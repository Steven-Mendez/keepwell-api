# Architecture decisions

Each record states the context, the decision, the alternatives that lost and what it costs. A
decision that changes gets a new record that supersedes the old one; records are never rewritten.

| ADR                                             | Decision                                                      |
| ----------------------------------------------- | ------------------------------------------------------------- |
| [0001](0001-serverless-aws-progressive-deploys.md) | Serverless on AWS, Terraform, progressive deploys            |
| [0002](0002-hono.md)                            | Hono for HTTP, over Fastify and NestJS                        |
