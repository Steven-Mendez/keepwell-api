# 0012. Notifications: one inbox computed from the ledger, its state synced, push from the server

Status: proposed, November 2026

## Context

Until now notifications were stateless. Each app computed "what applies now" from the ledger
(`homeReminders` on the web, `HomeViewModel.inbox` and `.reminders` on iOS) and nothing was read or
unread. iOS also scheduled local notifications, but only when Home loaded, so an iPhone that wasn't
opened for days stopped getting them. The web had no native notifications at all. The two apps also
gave the same notification different ids (`payment-<account>` on the web, `payment-<account>-<due>`
for iOS' scheduled one), so there was nothing stable to attach state to.

What's wanted:

1. Native notifications on the iPhone and in the browser, even with the app or tab closed.
2. The same notifications in an in-app inbox, where each can be marked read or unread, or deleted.
3. Reading or deleting on one device does the same on every other device, including taking the
   delivered notification off the iPhone's Notification Center.

## Decision

### 1. Notifications stay derived; their ids become per occurrence and shared

A notification is still computed from the ledger: no table of notifications to keep consistent
with the movements that caused it. What changes is that the computation moves into the shared
domain (`lib/domain/notifications.ts`, copied to the API like the rest) and returns data, not text:

```ts
interface LedgerNotification {
  id: string           // stable per occurrence, the same on web, iOS and server
  kind: NotificationKind
  date: string         // when it applies (ISO), used for ordering, grouping and push timing
  args: Record<string, string | number> // what the wording needs; each client localizes
  target: NotificationTarget            // where tapping it leads
}
```

The id names the occurrence, so a deleted payment reminder stays deleted this month and the next
month's is a new one:

| Kind | Id |
| --- | --- |
| card payment | `payment:<account>:<due yyyy-mm-dd>` |
| statement closing | `cutoff:<account>:<cutoff yyyy-mm-dd>` |
| loan installment | `installment:<loan>:<number>` |
| subscription renewal | `renewal:<rule>:<occurrence yyyy-mm-dd>` |
| card expiring | `expiry:<card>:<yyyy-mm>` |
| budget near / over | `budget:<category>:<yyyy-mm>:<near\|over>` |
| price increase | `price:<transaction>` |
| draft due today | `planned:<transaction>` |
| proposal from an assistant | `proposal:<rule>` |

Dates in ids are calendar days in the person's time zone, so the same occurrence gets the same id
on every device and on the server. iOS ports the function and runs the shared `notifications.json`
fixtures, the same way it runs `entities.json`.

### 2. Read and deleted travel as a new sync entity, `notificationState`

```ts
NotificationStateWire = { id, read_at: IsoDateTime | null, dismissed_at: IsoDateTime | null, ...Audit }
```

One row per notification the person touched, keyed by the notification's id. It goes through the
existing protocol (ADR 0005) unchanged: outbox, push, pull, last writer wins on `updated_at`.
"Mark as unread" writes `read_at: null`; "delete" sets `dismissed_at`. A row is never tombstoned by
the user, so deletion can be undone ("Undo" in the toast). The inbox shows
`notifications(ledger) − dismissed`, with `read_at` deciding the dot and the bell's count.

Rows whose notification can no longer apply (an id with a date more than 90 days old) are
tombstoned by whichever client notices first; the tombstone is final, which is fine because the id
won't be computed again.

### 3. The server sends the native notifications

A scheduled job (EventBridge Scheduler, every 15 minutes) walks the users that have at least one
push device. For each user whose local time has just passed the reminder hour (09:00 in the time
zone the device reported), it loads the ledger (`read-ledger`), computes the notifications for
today, drops the ones with a `notificationState` row and the ones already sent
(`notification_deliveries`, unique on `(user_id, notification_id)`), and sends the rest:

- **iOS**: APNs over HTTP/2 with a token-based key (`.p8` in SSM). `apns-collapse-id` and the
  notification's `thread-id` carry the notification's id and kind. The server words the alert
  itself (`aps.alert.{title,body}`, see Contract): it runs the same `notificationCopy` the apps use,
  copied with the domain, in the device's language (`es*` → Spanish, otherwise English). An earlier
  draft of this record had the iPhone localize from `loc-key`/`loc-args`; one wording code shared by
  the three places was simpler than three catalogs kept in step.
- **Web**: Web Push with VAPID (keys in SSM). The payload is `{ type: "notification", id, title,
  body }`, worded by the server the same way; the service worker only calls
  `showNotification({ tag: id })`.

Budget and price-increase notifications are sent as soon as the job sees them, not only at 09:00.

New tables (user-owned, added to `USER_OWNED_TABLES`):

- `push_devices`: `id`, `user_id`, `client_id`, `platform` (`ios` | `web`), `token` (APNs token or
  the Web Push subscription JSON), `time_zone`, `locale`, `environment` (APNs `sandbox` |
  `production`, null on the web), `created_at`, `last_seen_at`; unique on `(user_id, client_id)`. Registered
  by `PUT /push/devices/:clientId`, removed by `DELETE` (the web also calls it on sign-out). A
  registration whose token another of the person's rows already has replaces that row (site data
  cleared, app reinstalled). APNs `410 Unregistered` and Web Push `404/410` delete the row, unless
  the device registered within the last hour: a just-made subscription can be refused for a moment,
  so it is only skipped that run.
- `notification_deliveries`: `user_id`, `notification_id`, `sent_at`. Idempotency for the job: a
  retried run doesn't notify twice. Rows older than 120 days are pruned by the same job.

The capability is `cloud_sync` (the server only knows the ledger of people who sync).

### 4. Keeping native notifications in step with the inbox

- **Read or deleted elsewhere**: after each pull that brings `notificationState` rows, iOS removes
  the delivered notification (`removeDeliveredNotifications(withIdentifiers:)`) and the web's
  service worker closes it (`getNotifications({ tag })`). The server also sends a silent push
  (`content-available: 1` on iOS; a `{ type: "sync" }` message on the web) when a push brings
  `notificationState` changes, so the other devices pull and clear without being opened.
- **Opened from the notification**: tapping it marks it read and opens its target.
- **iOS without an account**: no server, so iOS keeps scheduling local notifications from the
  shared function, as today. With an account and a push token, local scheduling stops so nothing
  arrives twice; drafts keep their "Confirm" and "Postpone" actions through the `planned` category.

### 5. The inbox

Same on both apps, after Revolut, Cleo, N26 and folk in Mobbin:

- Grouped by day ("Today", "Yesterday", date), newest first; unread ones carry a dot and a bolder
  title. The bell counts unread only.
- iOS: swipe left to delete, swipe right to toggle read; a "…" menu with "Mark all as read" and
  "Delete read".
- Web: the same actions on hover and in a "…" menu per row; "Mark all as read" in the header.
- Deleting shows a toast with "Undo". Opening a row marks it read.
- Proposals from an assistant stay on top, with their "Confirm" / "Discard".
- Later, not in this record: a switch per kind and a chosen reminder hour in Settings. They would
  travel in `SettingsWire` so the server honours them; until then the hour is 09:00.

## Contract (what the three repos must agree on)

**Ids.** Exactly as `keepwell-web/src/lib/domain/notifications.ts` builds them, separated by `:`.
UUIDs are **lowercase** (Swift's `uuidString` is uppercase: iOS must lowercase it). Days are
`yyyy-mm-dd` and months `yyyy-mm` in the local calendar. The reference implementation and its tests
are `ledgerNotifications` and `tests/notifications.test.ts` on the web.

| Kind | Id | Applies (on the day of `now`) | `date` |
| --- | --- | --- | --- |
| planned | `planned:<tx>` | planned movement dated today or before | its day |
| payment | `payment:<account>:<due day>` | credit account with `dueDay`; next due (today or later) within `payment_reminder_days_before` days | due − window |
| cutoff | `cutoff:<account>:<today>` | next cutoff is today | today |
| installment | `installment:<loan>:<number>` | next unpaid installment due in 0…window days | due − window |
| renewal | `renewal:<rule>:<occurrence day>` | subscription occurrence tomorrow | today |
| expiry | `expiry:<card>:<yyyy-mm>` | card expiring this month | 1st of month |
| budget | `budget:<category>:<yyyy-mm>:near\|over` | 80% / 100% of the month's budget | latest expense in that category |
| price | `price:<tx>` | a subscription's latest charge cost more | that charge's day |
| proposal | `proposal:<rule>` | MCP-made rule still paused | rule's start day |

The inbox leaves `planned` out (Home lists drafts); native notifications include it.

**Sync.** Entity `notificationState`, table `notification_states`, wire
`{ id (≤64 chars), read_at, dismissed_at, created_at, updated_at, deleted_at }`. Mark read keeps the
first `read_at`; delete sets `dismissed_at` (and `read_at` if unset); undo clears `dismissed_at`.
Rows whose id carries a day more than 90 days old are tombstoned (`prune`).

**HTTP** (session auth, capability `cloud_sync`):

- `GET /push/config` → `{ "vapid_public_key": "<base64url>" }`
- `PUT /push/devices/:clientId` body `{ "platform": "ios" | "web", "token": string, "time_zone": IANA, "locale": BCP 47, "environment"?: "sandbox" | "production" }` → `204`.
  iOS `token` is the APNs device token in lowercase hex; web `token` is `JSON.stringify(subscription.toJSON())`.
- `DELETE /push/devices/:clientId` → `204` (also on sign-out).

**Payloads.**

- Web Push: `{ "type": "notification", "id", "title", "body" }` or `{ "type": "clear", "ids": [...] }`.
- APNs alert: `aps.alert.{title,body}`, `aps.sound: "default"`, `aps.thread-id: <kind>`,
  `aps.badge: <unread count>`, `apns-collapse-id`: the id (SHA-256 hex, first 64 chars, when longer
  than 64 bytes), custom keys `notification_id` and `target` (`NotificationTarget` as JSON). Drafts
  add `aps.category: "keepwell.planned"` and `transactionID` (uppercase UUID, as the app already
  reads it).
- APNs silent clear: `aps.content-available: 1`, `apns-push-type: background`, priority 5,
  `clear_ids: [...]`, `aps.badge` with the new unread count.

**When.** A scheduled job every 15 minutes: notifications whose `date` is today or earlier are sent
once (`notification_deliveries`) from 09:00 in the device's time zone, budget and price ones on the
first run that sees them, and nothing for a `notificationState` row that is read or dismissed. A
push to `/sync/push` that applies `notificationState` changes sends a silent clear to the person's
*other* devices (all but the pushing `client_id`).

## Alternatives

- **Notifications as server rows.** One source of truth for state, but every client would need the
  server to see its inbox, which breaks offline use and the local-only iPhone.
- **Local notifications only.** No infrastructure, but nothing reaches a closed browser and an
  unopened iPhone goes quiet.
- **A push provider (OneSignal, Firebase).** A third party with the person's financial wording;
  APNs and Web Push directly are two small adapters.

## Consequences

- Order of work, as ADR 0005 asks: web domain and fixtures → API copy, migration, job, push adapters
  and Terraform → iOS port, push registration, inbox.
- New secrets in SSM: the APNs key (`.p8`, key id, team id) and the VAPID key pair. The author
  creates them once (`BOOTSTRAP.md`).
- The convergence test gains `notificationState`.
- Wording changes ship with each app *and* with the API's next copy of the domain: the server words
  pushes with the copied `notification-copy.ts`, `display.ts` and the translator with its catalogs,
  literal copies like the rest of the domain (README, "The shared domain").

## How the API does it

Decided while building the server side; none of it changes the contract above.

- **Time zones.** The domain computes days with the local `Date` getters, and the server is not in
  the person's zone, so the calculation runs with `process.env.TZ` switched to the person's zone and
  restored afterwards (`core/notifications/time-zone.ts`; the switch is synchronous, never held
  across an `await`). Everything the domain derives from the zone (ids' days, `date`, the hour of
  the 09:00 rule, the month of a budget) then reads exactly as on that device. An unknown zone name
  falls back to UTC. A day is 23 or 25 hours long across a DST change; the domain's day arithmetic
  is calendar based and copes.
- **One zone per person.** A person's pushes are computed once, in the zone of their most recently
  seen device, and sent to all their devices (each worded in its own language). Someone with an
  iPhone in Managua and a browser in Madrid gets notifications at 09:00 Managua, not twice.
- **Delivery.** `notification_deliveries` has `(user_id, notification_id)` as primary key. The job
  inserts the row (`on conflict do nothing`) *before* sending, so two overlapping or retried runs
  can't notify twice. If the send failed on every device the row is deleted and the next run
  (15 minutes later) tries again; a crash between the insert and the send loses that one
  notification instead of duplicating it. At most 10 notifications per person per run, so a new
  device on an old ledger isn't flooded; the rest follow on the next runs.
- **Badge** is the unread inbox count: what applies, minus read and deleted, without `planned`.
- **Read and deleted elsewhere.** After a `/sync/push` commits, the route starts the silent clear and
  waits for it at most 3 seconds before answering. Awaiting (bounded) rather than fire-and-forget
  because Lambda freezes the function once the response is out; the clear is rare (someone tapped
  "read") and its errors are logged, never thrown.
- **Configuration** is optional in SSM (`apns_private_key`, `apns_key_id`, `apns_team_id`,
  `apns_bundle_id`, `vapid_public_key`, `vapid_private_key`, `vapid_subject`): while a platform's
  keys are `unset` it is simply off, as with ADR 0008's capabilities. `GET /push/config` answers
  `503 push_unavailable` without the VAPID public key.
- **The job** is a third Lambda (`keepwell-prod-notifications`) started by EventBridge Scheduler
  with its own role. It logs in to the database as `keepwell_app` (it records due occurrences
  through `read-ledger` exactly like the API) through a second IAM mapping. Its alarms: errors, and
  no invocation in an hour.
- **Web Push** is implemented over `node:crypto` and `jose` (RFC 8291 `aes128gcm`, RFC 8292 VAPID,
  checked against the RFC's test vector) rather than the `web-push` package.
