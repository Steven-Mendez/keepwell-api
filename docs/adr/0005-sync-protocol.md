# 0005. Sync protocol

Status: accepted, November 2026

## Context

The iPhone (SwiftData) and the web (IndexedDB) each keep the whole ledger and work offline. Both
already write an outbox in the same transaction as every change. They need to converge through the
API without losing a payment, a deletion or a recurring occurrence, and without a slow or broken
client blocking the rest. Before this record the domain had gaps that made correct sync impossible;
they are listed with their fix.

| Gap in the domain | Fix (increment 8) |
| --- | --- |
| A loan's payments and a debt's repayments lived in an array on the parent row; last-writer-wins per row loses a payment made on the other device | Each payment and repayment is a row with its own id (`loan_payments`, `personal_debt_repayments`). An installment's id is `uuidV5(loan, number)`, so the same installment paid twice is one row |
| Recurring occurrences got a random id; two offline devices materialized the same rent twice | `uuidV5(rule, start, frequency, interval, index)`: the same occurrence is the same row everywhere, including on the server |
| Settings mixed device preferences (unlock method, iCloud switch) with shared ones | Only currencies, reminder days and onboarding travel (`SettingsWire`); settings gained `created_at`/`deleted_at` |
| Applying a pulled change through the normal save path re-queued it: an echo between devices | `applyRemote` writes without touching the outbox |
| A save brought a deleted row back to life | Tombstones are final, locally and on the server |
| `source` didn't exist, so confirming Claude's movement would erase who made it | `source` (`app`, `mcp`) on movements and rules, set at creation, never changed |
| No installation identity | `client_id` per installation (IndexedDB next to the outbox; Keychain on iOS) |
| `updated_at` comes from the device clock; a clock ahead wins every conflict | The server bounds `updated_at` by its own clock |
| iOS validates in Swift, the server in TypeScript; an event one accepts and the other rejects would block the outbox | Validation per event; a rejected event is reported and removed from the outbox, never retried forever |

## Decision

**Wire format.** Each event carries one row as stored, snake_case, identical on web, iOS and server
(`schema/sync.ts`, copied to the API; `sync.json` fixtures in all three suites). Server-only columns
(`user_id`, `server_seq`, `applied_at`, `source` once set) are never taken from a client.

**Push** (`POST /sync/push`): up to 200 events in outbox order, the `client_id` and the client's
cursor. One transaction with optimistic-concurrency retry:

1. `UPDATE sync_state SET last_seq = last_seq + n WHERE user_id = …`. Two pushes of the same user
   conflict here and one retries, so a user's writes are serialized and the cursor can't skip.
2. Per event: if its `event_id` is in `applied_events`, return the stored result. Otherwise validate;
   an invalid event is `rejected` with the reason and the batch goes on. A valid one is applied by
   the rules below, written to `change_log` with its `server_seq`, and recorded in `applied_events`.
3. The answer lists every `event_id` as `applied`, `stale` or `rejected`. The client removes all
   three from its outbox and keeps rejected ones in a list visible in settings. If time runs out the
   server answers with what it committed and the client resends the rest.

**Conflict rules**, per row: a tombstone is final (no update or create after it revives the row); a
delete always applies; otherwise the later `updated_at` wins, with `updated_at` capped at the
server's clock. A losing event is `stale` and still logged.

**Pull** (`GET /sync/pull?cursor=n&limit=500`): changes with `server_seq > n`, without the caller's
own `client_id`, and `next_cursor`. Because every write goes through `sync_state`, seeing `n` means
no transaction with a lower sequence is still in flight. The client applies through `applyRemote`
with the same rules and saves the cursor only after the batch is applied.

**Snapshot** (`GET /sync/snapshot?entity=…&after=<id>&limit=500`): current rows of one table by id,
plus the `server_seq` it reflects. A new installation, or one that lost its cursor, loads the
snapshot and continues with `pull` from there.

**Client loop**: push, then pull, on launch, on reconnect and after each change with a short
debounce. No websockets or push notifications in the first version. Without the `cloud_sync`
capability the app keeps working locally and the outbox grows; the first push after gaining it
uploads everything.

## Accepted limitations

- Reordering categories writes N rows and can interleave with a reorder on another device.
- Deleting an account in the app arrives as N independent tombstones and is applied as such.
- The iPhone keeps a loan's payments embedded in its SwiftData record; it emits and applies them as
  rows with the shared ids, which is what the protocol needs. Splitting the record is not required.

## Alternatives

- **CRDTs per field.** Correct for concurrent edits of the same field, which is rare here (movements
  are appended, not co-edited) and heavy for Swift, TypeScript and SQL at once.
- **Server as the only writer (online-only apps).** Breaks the offline promise.
- **CloudKit for iOS and something else for the web.** Two sync systems; CloudKit is retired.

## Consequences

- A property-based convergence test (two or three simulated clients, random operations, network on
  and off) must end with every client equal to the server, with no payment, tombstone or occurrence
  lost (`tests/convergence`).
- The protocol changes in this order: web schema and fixtures first, then the API copy with an
  additive migration, then iOS. The server accepts both shapes meanwhile.
