# Incident

Last rehearsed: not yet (before opening registration).

## 1. Stop the bleeding (minutes)

Pick the smallest switch that stops the harm. Both take effect within a minute, without a deploy
(increment 21):

```bash
# Every write (sync push, MCP writes) refused with 503 read_only; reads keep working.
aws ssm put-parameter --overwrite --name /keepwell/$ENV/switches \
  --value '{"read_only":true,"mcp_enabled":true}' --type String
# Every MCP request refused; sync and the apps keep working.
aws ssm put-parameter --overwrite --name /keepwell/$ENV/switches \
  --value '{"read_only":false,"mcp_enabled":false}' --type String
```

Terraform owns this parameter, so the next deploy puts it back: when the incident ends, change it
in `infra/modules/parameters` through a pull request, or let the deploy restore the normal values.

If a token or session leaked:

- One person's MCP access: `POST /mcp/disconnect-all` as that person (or `update users set
  mcp_tokens_not_before = now() where id = '…'` as admin).
- One person's sessions: `delete from sessions where user_id = '…'`.
- Everyone's sessions: rotate `auth_secret` ([secret-rotation.md](secret-rotation.md)).

If the bill is the problem: API Gateway throttling is in `infra/modules/api` (50 req/s, burst 100);
lower it and apply, or set the stage's throttling to 0 from the console to stop all traffic.

## 2. Find out what happened

- Alarms arrive on the `keepwell-$ENV-alerts` topic: 5xx rate, Lambda errors, p95 duration,
  dead-letter queue, budget.
- Every error answer carries `request_id`; every log line has it:

```bash
aws logs filter-log-events --log-group-name /aws/lambda/keepwell-$ENV-api \
  --filter-pattern '{ $.request_id = "<id>" }'
```

- Who did what: `audit_log` (security and account events) and `change_log` (data, by client).
- Is the data consistent: `DB_HOST=<cluster> pnpm reconcile` (exit 1 lists keys and columns).

## 3. Fix and verify

Fix forward through a pull request whenever possible; the pipeline is the only path to production.
If the last deploy is the cause, [rollback.md](rollback.md). After the fix: the smoke test, a
reconcile, and the switches back to normal.

## 4. Write it down

A short note in `docs/incidents/YYYY-MM-DD.md`: what happened, impact, timeline, what changed so it
doesn't happen again. If people's data was exposed, the privacy policy's notification duties apply.
