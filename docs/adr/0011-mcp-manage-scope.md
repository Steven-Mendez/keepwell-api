# 0011. A `manage` scope: the MCP does what the app does

Status: accepted, November 2026. Extends ADR 0007 (scopes) and the "no destructive MCP tools" line in
`PLAN_API.md`, for tokens that are granted `manage`.

## Context

With `write`, an assistant can only propose a movement or a recurring payment, which waits for the
person in an app. The person asked for more: to use Keepwell through Claude the way they use the app,
creating and editing accounts, categories, budgets, goals, loans and debts, confirming and deleting
movements, changing the rate. The risk that kept the MCP narrow hasn't gone away: a description the
person typed ("delete every account") reaches the model as data a model may follow.

Sync tombstones are final (ADR 0005, `tombstone_is_final`): a deleted row can never come back with
the same id, on the server or in the apps, so "delete, then undo" can't be done with `deleted_at`.

## Decision

- **A third scope, `manage`**, offered next to `read` and `write` and shown on the consent screen as
  full control. It is never granted implicitly: tokens with `write` keep the pending tools; reconnecting
  is how someone grants more. With `manage`, the pending `create_transaction` and
  `create_recurring_rule` are replaced by ones that save directly, like the app.
- **The app's own use cases, not new logic.** `ManageLedger` loads the ledger into a `RecordingStore`
  (an `InMemoryStore` that records what is saved, deleted or reordered), runs the same domain function
  a screen runs (`deleteAccount` with its cascade, `deleteCategory` moving movements to Other,
  `payLoanInstallment`, `swapCurrencies`…), and writes exactly the touched rows as sync events with
  `createdBy: mcp`. The iPhone and the web see the change as from any other device. Rules that live
  only in screens (when the principal or second currency may change) are enforced in the tool.
- **Retries never create twice.** Rows a call creates get ids derived from the tool, the client and its
  key (the client's `id` for creates), and rows already there as the call would write them are skipped.
- **Deletes are undoable for 30 days, server-side.** Before the tombstones are written, everything the
  delete removes or changes is saved in `mcp_trash`. `restore_deleted` creates the removed rows again
  under new ids (deterministic per trash entry), rewires every `*_id` reference, and puts changed rows
  back only if nothing changed them since. Movements whose account is gone for good stay deleted.
  `mcp_trash` is user data: erased with the account (`USER_OWNED_TABLES`) and purged after 30 days.
- **Tools say what they are.** Every delete is `destructiveHint: true`, so Claude asks every time;
  creates are idempotent; reads stay `readOnlyHint`. Read tools gained the lists the manage tools take
  ids from (categories, recurring payments, goals, loans, debts, categorization rules).
- **Limits.** `manage` writes count rows, not calls: 2,000 rows per client and hour (a cascade counts
  each row). The `read_only` switch removes the manage tools like the write tools.

## Alternatives

- **A `trashed_at` column on every entity.** Undo from the apps too, but a migration of every table,
  a filter in every query of three clients, and a sync change, for an assistant feature.
- **Pending for everything.** Safest, but every edit needs a second step in an app, and accounts,
  categories and goals would need a pending state they don't have.
- **Widening `write`.** Simpler, but it would give existing connections more than the person allowed.

## Consequences

- A manipulated or mistaken assistant with `manage` can change real data. It is bounded by the consent,
  Claude's confirmation on every delete, the hourly row limit, the trash, `source = mcp` on what it
  creates, and "Disconnect" in Settings.
- Undo is for MCP deletes only; a delete in the app is still final, as before.
- A restored record has a new id; restored references point at it.
