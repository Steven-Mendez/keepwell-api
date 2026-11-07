# Security

The threat model of the Keepwell API: what is protected, from whom, how, and where in the code. It
follows section 5 of `PLAN_API.md` and is kept current with every increment that changes it.

## Assets and threats

| Asset | Main threat |
| --- | --- |
| Each person's financial data | Another user, a foreign MCP client or someone with a stolen token reading or changing it |
| Accounts and sessions | Session theft, unauthorized sign-up, Sign in with Apple spoofing |
| The MCP OAuth server | Malicious clients, leaked tokens, misleading consent |
| MCP write tools | Instructions injected through the data, mass or unwanted writes |
| App Store purchases | Forged or reused receipts granting a plan |
| Infrastructure and secrets | Leaked credentials, a compromised pipeline, malicious dependencies |
| Availability and the bill | Abuse that takes the API down or runs up the cost |

## Isolation between users

- Repositories only get a `ScopedDb` bound to one user (`src/adapters/database/scoped-db.ts`); ESLint
  keeps the raw client out of `repositories/`. Reads are filtered, writes are stamped and limited,
  and a `user_id` in the data is ignored.
- Primary keys are `(user_id, id)`: ids are chosen by clients and repeat across users by design.
- Tests try to cross users on the same id, through `scopedDb`, through every sync route, and against
  the dev cluster (`tests/isolation`, `tests/sync`, `tests/remote`).
- The sync cursor is per user (`change_log` is keyed by `(user_id, server_seq)`).

## Authentication and sessions

- Sign in with Apple only. ID tokens are verified by Better Auth against Apple's keys: signature,
  issuer, audience (the web's Services ID or the app's bundle ID), expiry and nonce. An email sent by
  an app is never trusted.
- Web: `HttpOnly`, `Secure`, `SameSite=Lax` cookie on the registrable domain shared by `app.` and
  `api.`. iOS: the same cookie in the Keychain (after first unlock, this device only).
- Registration is closed to an allowlist of Apple identifiers; a rejected attempt is audited with
  its Apple `sub` and nothing else is written.
- Sign-ins, account creation, deletion requests and deletions write `audit_log` (IP, user agent,
  request id; no amounts, texts, emails or tokens). The app role can only insert there.
- Account deletion ends every session in the same transaction that marks the account; no session can
  be created for it afterwards; a queue job erases the data (ADR 0006).

## API and input

- Zod on every input. A push is validated event by event: an invalid event is rejected with the
  field that failed, never its value, and doesn't block the batch.
- Limits: 1 MB body (checked in the Lambda), 200 events per push, 500 items per page.
- API Gateway throttling per stage (50 req/s, burst 100). CORS admits only the web origin.
- `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Cache-Control: no-store`.
- Errors carry a code, a message and the request id; never a stack or SQL.
- Server-only columns (`user_id`, `server_seq`, `applied_at`, `source`) are never taken from a
  client. `updated_at` from the future is capped at the server's clock.

## Data integrity

- `change_log` is insert-only for the API role; `pnpm reconcile` replays it against the tables
  (ADR 0004). Balances are derived, never stored.
- Writes run in optimistic-concurrency transactions with only SQL inside; a user's writes are
  serialized through `sync_state` (ADR 0003, ADR 0005).
- A property-based test checks that devices converge without losing payments or reviving deletions
  (`tests/convergence`), locally and against DSQL.

## Secrets, IAM and pipeline

- No database secret: DSQL connections use IAM tokens. Two database roles (`keepwell_app`,
  `keepwell_jobs`) mapped to the two Lambda roles.
- Secrets live in SSM SecureString, created by Terraform with a write-only placeholder so values never
  reach the state; the API refuses to serve with a placeholder.
- Lambda roles: their log group, `dsql:DbConnect` to their cluster, their SSM prefix, their queue.
- GitHub Actions use OIDC: a read-only role for pull requests, a deploy role for `main`. Actions are
  pinned by SHA. `pnpm audit` blocks on high severity. Renovate keeps Better Auth and the MCP SDK out
  of the weekly batch.

## Availability and cost

- CloudWatch alarms: 5xx rate, Lambda errors, p95 duration, messages in the dead-letter queue; a 10 USD
  monthly budget alarm.

## Still to come (by increment)

- OAuth for MCP with CIMD, PKCE, consent and revocation (17); MCP write limits and pending state (18).
- Emergency switches `mcp_enabled` and `read_only` (21); passkeys (22).
- App Store purchase and notification verification (23, 24); alarm on 401/403 spikes (24).
