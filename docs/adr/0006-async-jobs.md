# 0006. Asynchronous jobs: SQS with a dead-letter queue, for account deletion only

Status: accepted, November 2026

## Context

Deleting an account must erase every row the person owns. DSQL caps a transaction at 3,000
modified rows and 10 MiB, and a person with years of movements, their change log and applied sync
events can exceed that many times over. A request also has to answer within API Gateway's 29
seconds. App Store guideline 5.1.1 requires deletion from inside the app.

## Decision

- The request (`DELETE /me`) does what must be instant, in one transaction: mark the account
  (`users.deletion_requested_at`) and delete its sessions. No session can be created for a marked
  account afterwards, not even through Apple. Then, outside the transaction, it audits the request
  and sends one message to SQS. If sending fails the person retries; marking is idempotent.
- A second Lambda consumes the queue and erases the account in batches of 1,000 rows, one
  transaction per batch, table by table (`USER_OWNED_TABLES`), with the user row last. It refuses
  accounts that were never marked and is idempotent, so a redelivery finishes the job or does
  nothing. It writes `account.deleted` to the audit log at the end.
- Five attempts, then the dead-letter queue, whose alarm emails the author. Partial batch responses
  so one failure doesn't redeliver other messages.
- A test fails when a table with a `user_id` column is neither in `USER_OWNED_TABLES` nor
  deliberately kept (`KEPT_AFTER_DELETION`), so a new table can't be forgotten by deletion.

**Not on the queue: App Store notifications.** Apple retries a notification for days until it gets
a 200, so processing it inside the request is already reliable and keeps the refund path simple.
A queue enters only when a job needs it.

## What is kept

- `audit_log` rows of the deleted account (security events: IP, user agent, action). The app role
  can't delete them by design. Stated in the privacy policy.
- AWS Backup copies, up to 35 days. The deletion screen in both apps says so.
- Later, `entitlements` and `app_store_transactions` keep the `originalTransactionId` without
  `user_id` for the accounting period.

## Alternatives

- **Delete everything in the request.** Breaks the row limit and the time limit for real accounts.
- **EventBridge Scheduler or Step Functions.** More moving parts for one job type.
- **A generic job framework.** One job doesn't need one.

## Consequences

- Locally and in tests the job runs in-process right after the request (`InlineJobQueue`).
- The consumer has its own role: `dsql:DbConnect`, receive and delete on its queue, its own logs.
  The API role can only send to the queue.
