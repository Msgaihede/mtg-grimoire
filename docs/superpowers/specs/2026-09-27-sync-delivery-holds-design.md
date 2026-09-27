# Sync delivery: hold what can still apply, skip what never will — design

**Date:** 2026-09-27 · **Status:** approved approach ("Hold by reason"), spec for review
**Must ship in the same release as user schema v52** (token stacks PR 2, #562), and before token
stacks PR 3 (v53), whose new `collection_folders.kind` word a v52 device must hold rather than drop.

## 1. The problem, measured

Found by PR 2's final review and mapped on 2026-09-27 (every cite is `src-tauri/src/sync_engine/`
unless it says otherwise):

- **`client::pull` advances `PULL_CURSOR` to the page head after `apply`, whatever `apply`
  deferred** (`client.rs:1020-1022`). The relay answers only rows with `seq > since`
  (`relay/src/log.ts:65`, `group.ts:189-207`, one unpaged body), and `apply` keeps no copy of a
  deferred op. So a deferred op is **dropped**, and so is every later op from the same device in
  that page — `blocks_of` holds them as collateral (`apply.rs:687-754`) and the cursor then moves
  past them. Nothing brings them back: once a later op from that device applies, the earlier ones
  sit below its watermark for ever.
- **Re-delivery is already safe.** With the cursor held, `apply` skips what it applied
  (`stamp <= watermark`, `apply.rs:607-609`) and applies the ops after a block exactly once when it
  clears (`apply/tests.rs` 808-868, 1614-1656). The epoch hold (`behind`) already re-delivers this
  way. What was missing is the client holding.
- **`apply` defers for four reasons and records none of them** (`Outcome` is a unit enum,
  `apply.rs:546-550`; the constraint error is discarded at 1134):

  | Reason | Where | Can it resolve? |
  | --- | --- | --- |
  | Unknown table | 1017-1021 | By upgrading this build, when the sender is newer. Never, when the sender is older (a renamed table). |
  | Unknown parent | 1035 | By a later page — first contact, where `round_trip` pushes before it emits baselines (`client.rs:1242-1254`). Never, when the parent was deleted. |
  | Unbuildable row (NOT NULL / CHECK / UNIQUE) | 1134-1141 | By upgrading, for a newer build's CHECK word. Otherwise never. |
  | Held collateral | 687-701 | When its device's block clears. |

- **Holding for ever costs the relay.** A row is compacted only when its `seq` is at or below every
  device's ack and it is older than 30 days (`log.ts:92-103`), and the ack follows `PULL_CURSOR`. A
  cursor held on something that never resolves pins that group's log for good, and every pull
  re-downloads everything above it.
- **Two neighbours break outright.** `find_row` renames a local row to the lower uid without
  checking the uid is free (`apply.rs:903-915`), before the per-row savepoint opens, so a
  `UNIQUE` failure aborts the whole `apply` on every pull. And at the round cap
  (`round == min(groups, 8)`) the committed pass used different blocks from the ones the
  watermarks are then advanced by (655-671), so a re-delivery could re-add counter deltas.
- **The panel says something false.** `SyncPanel.tsx:519-524` tells the reader deferred changes
  "land on a later sync"; `ipc.ts:6488-6490` says the same.

## 2. Goals and non-goals

**Goals.** A change from a device running a **newer** schema waits until this device upgrades,
and nothing of that device's stream is lost meanwhile. A change that can **never** apply is skipped
at once, logged, and does not take the rest of its device's changes with it. The one transient
case — a parent arriving on its sender's next trip — waits briefly and then gives up. The
cursor, and so the relay's floor, is never held by something that cannot resolve.

**Non-goals.** A v51 peer runs its own client and cannot be helped by any change here. The relay
Worker is untouched: no deploy is part of this work. (Its `acks` table is not pruned when a device
is removed, so a removed device's last ack pins the floor today — recorded as a follow-up.) No
schema rung: two `sync_state` keys and an optional wire field are the whole of the storage.
No tombstone table for deletes applied from peers — the bounded wait covers that case.

## 3. Design

### 3.1 Every op says which schema wrote it

`merge::Op` gains `schema: Option<i64>`, `#[serde(default, skip_serializing_if = "Option::is_none")]`
— `horizon`'s precedent, one field over. **`wire::seal_batch` stamps `schema::USER_SCHEMA_VERSION`
on every op it seals** — at sealing and never at capture, so an outbox written by an older build is
stamped by the build that sends it, and every path that sends ops (the push and the baselines) goes
through the one function. An older receiver ignores the
field (no `deny_unknown_fields` anywhere on the wire). A receiver reads `op.schema >
USER_SCHEMA_VERSION` as **newer**; an absent field is "not newer", which is what every op sent
before this build is.

### 3.2 `apply` says why it deferred

`Outcome::Deferred` carries a reason — `UnknownTable`, `UnknownParent { table, uid }`,
`Unbuildable(String)` (the constraint error, kept) — and each deferred group is classified:

| The group | Class | Blocks its device? | Recorded? |
| --- | --- | --- | --- |
| Any reason, and an op in it is from a **newer** schema | **held · newer** | yes | no — the panel says it |
| Unknown parent, and this device **deleted** that parent (a `del` for its uid in this device's own `sync_ops`, via `idx_sync_ops_row`) or the parent's delete is **in this batch** (below its sender's watermark included, so a re-delivered page still counts), and the parent's foreign key **cascades** | **moot** | no | no — the convergent outcome *(amended 2026-09-27, at the final review: a row this device already holds under the group's uid is deleted, as the sender's cascade takes it, where the fold over this device's own history says the group's placement under that parent stands — and never for a table a capture spec names as a parent, whose uncaptured delete would leave a peer's later children waiting on a parent nothing says is gone)* |
| The same, but the foreign key is **`SET NULL`** (`collection_entries.folder_id`, `wishlist_entries.folder_id`, `decks.folder_id`, `deck_cards.label_id`) | **written without that parent** | no | no — what the deleting device's own cascade did *(amended 2026-09-27: consuming these lost a copy measured at `(0,0)` against `(1,1)`, and would lose a whole deck for `decks.folder_id`)* |
| Unknown parent, otherwise (same/older sender) | **held · waiting** | yes | only when released |
| Unknown table, or unbuildable, from a same/older sender | **skipped** | no | yes |
| Collateral behind a held block | follows its block | — | — |

**Skipped and moot are consumed**: they do not block their device, so the ops after them apply,
and the device's watermark may pass them. **Held** is today's blocking behaviour, kept only where
something can still change.

`apply(conn, ops, release_waiting)` gains the flag. With it set, **held · waiting** groups are
treated as **skipped** (recorded), so their collateral applies. `ApplyReport` gains `held_newer`,
`held_waiting`, `moot` and `skipped_permanent` beside today's counts, and `applied` counts only
ops written by *this* call.

A skip is recorded through `errors::record` (`Source::Relay`, operation `apply`), naming the table,
the row's uid and the reason, folding on the existing grain so a bad afternoon is one row.

### 3.3 The client holds the cursor for a reason, and for no longer than the reason lasts

After `apply` in `client::pull` (the epoch `behind` rule is unchanged and still wins):

1. **`held_newer > 0`, or an envelope that opened under the key but did not parse** → do not
   advance `PULL_CURSOR`. Write `sync_state.pull_hold = {"kind":"newer","since":<unix>}`. No bound:
   it lasts until this device upgrades. *(The second arm is `wire::open_batch`'s
   `WireError::Malformed`: the AEAD passed, so a member of the group wrote it, and a batch this
   build cannot parse — an op `Kind` it does not know — can only come from a newer one. Today it is
   counted unreadable and stepped past, which drops it; an AEAD failure at the same epoch is still
   stepped past, as today.)* *(Amended 2026-09-27, at the final review: that "can only" was not
   true — a same-version batch that does not parse would pin the relay's floor for good and ask
   the reader to update a build they already run. The arm holds only when some op in the opened
   plaintext, read as bare JSON, carries a `schema` above this build's — `WireError::Newer` — and
   a `Malformed` batch is stepped past and recorded once. A held page's unreadable envelopes are
   noted once per hold rather than on every pull.)*
2. **Else `held_waiting > 0`** → hold, recording `{"kind":"waiting","since":…,"pulls":n}`. Once the
   hold has been seen on **3 pulls spanning at least 10 minutes**, re-run `apply` on the same ops
   with `release_waiting = true`, then advance. (A baseline its sender owed arrives on that sender's
   next trip, seconds later; a parent deleted on a third device never arrives.) *(Amended
   2026-09-27, at the final review: the count is of the same **blocks**, not the same kind. The
   hold stores each held device at the stamp of its first held op, and a block not in the stored
   set starts `since` and `pulls` over — counted by kind, a new wait inherited an old one's span
   and was released with it. A row without `blocks`, written before the field, starts over.)*
3. **Else** advance, and delete `pull_hold`.

The ack follows `PULL_CURSOR` exactly as today, so the relay keeps the held rows. **The legacy
token-pick conversion behind a pull runs only when the cursor advanced** — a held pull has not
heard everything, which is the gate's own reason. `RelayOutcome.pulled` counts newly applied ops
only, so a held cursor does not fire `sync:applied` and refresh every screen on every trip.

### 3.4 The two neighbours

- **`find_row`'s rename** moves inside the per-row savepoint and first checks the target uid is
  free; if another local row holds it, the group is **unbuildable** (skipped, recorded) instead of
  aborting the apply.
- **At the round cap** the watermarks are advanced from the blocks the committed pass used.

### 3.5 What the reader sees

`RelayStatus` gains `pullHeld: "newer" | "waiting" | null`, read from `sync_state.pull_hold`, on
the `ipc.test.ts` struct fence. The Sync panel draws, while held · newer: **"A device in your
group runs a newer version of MTG Grimoire. Update this device to receive its changes."** Waiting
is transient and draws nothing. The false "They land on a later sync." becomes true sentences: a
held count says it will apply after an update; a skipped count says it could not be applied and
points at the error log. `ipc.ts:6488-6490` is corrected with it.

### 3.6 Docs

`docs/reference/sync.md`'s "Deferred ops are dropped, not held (open)" becomes the record of this
design — the classification table, the two bounds, the relay cost of a hold and why each hold is
bounded — and every sentence PR 2 corrected to "dropped" is revisited. `apply.rs`'s module doc,
`src-tauri/CLAUDE.md`'s watermark bullet, the ipc doc and `SyncPanel`'s comments follow. **A future
relay `LIMIT`** (sync.md plans one) must page to the end before a hold is evaluated, or a held
cursor could never reach the page that resolves it — written down where the plan is.

## 4. Testing

- **`apply` units**, one per class: newer-held blocks and the device's later ops wait;
  moot-by-own-tombstone and moot-by-batch-delete consume silently; waiting holds, and with
  `release_waiting` becomes skipped with its collateral applied exactly once; unknown-table and
  unbuildable from a same-version sender skip, record, and let the later ops apply; the round-cap
  watermarks; `find_row`'s collision skipped rather than failing the whole apply.
- **Client, over `httpmock`**: a held · newer page leaves `PULL_CURSOR` and the ack where they were
  on every pull and writes `pull_hold`; a waiting hold releases on the third pull past 10 minutes
  (time injected through `sync_state`) with the collateral applied once; an ordinary page advances
  and clears `pull_hold`; `pulled` excludes re-delivered ops; the token conversion does not run
  behind a held pull.
- **Wire**: an op with `schema` round-trips; a batch sealed by this build opens under a struct
  without the field (the older-receiver case), and an op without it reads as not newer.
- **UI**: the panel's newer sentence is drawn from `pullHeld`, and the old false sentence is gone.

## 5. What it costs

A held · newer cursor re-downloads everything above it on every pull and pins the group's relay
floor until this device updates — bounded by the reader updating, and the panel asks them to. A
waiting hold costs the same for at most three pulls. A same-version change that can never apply is
dropped exactly as today, but it no longer takes its device's later changes with it, and it is in
the error log instead of nowhere.
