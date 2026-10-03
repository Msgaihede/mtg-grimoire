# A claim carries its own idempotence: emissions and generations — design

**Date:** 2026-10-03 · **Status:** approved approach ("Emission id + generation", held rows exact in
every generation), spec for review — **revision 2**, after the narrow fix dropped its op path
**Builds on** [the pairing baseline design](2026-08-29-sync-baseline-design.md) §8–§11 and on the
narrow fix on `fix/sync-baseline-claim-skipped-as-seen` as it is being rewritten (§13).
**Lands after** that fix and after [issue #761](https://github.com/Msgaihede/mtg-grimoire/issues/761)
step 6b, which moves the sync client into `crates/grimoire-core`.

**Goal:** a baseline op — a *claim* — changes a row on a device only where the row is missing
something no log will bring, changes it exactly once, and never lands ahead of a put it already
contains; and a device that already holds everything a claim says does no work for it.

---

## 1. The problem, measured

`sync_peers` is a watermark over a device's **ordinary** op stream, which reaches every peer in
stamp order. A claim is stamped from its row's `updated_at` — whole wall-clock seconds, with a
running index as the counter (`baseline::build`) — and emitted in table order, and it is both
**judged** by that watermark (`seen` in `apply_in`) and allowed to **raise** it
(`advance_watermarks`). So a claim can be skipped as "seen" by a device that has never held its
row. The same comparison is the baseline design's cheap exit (§10.2, §11), and it fails on its own
account, because a wall-clock second says nothing reliable about a hybrid-clock stream.

**And a claim is a floor** — §8.2's `max(local + Σ deltas, claim)` — so on a row the receiver already
holds it can neither carry a decrement nor sit beside a concurrent delta. The narrow fix's round two
measured that, and closed it with an **op path** for a covered put on a row held here; its third
review then traced a **double count, 6 for 3**: a receiver's client holds one sender back (its clock,
or behind a newer build) while a third device's claim for the row lands first — and that claim
already *contains* the held put, which its emitter took in through another device's claim. Released,
the put took the op path into a row that held it. The op path was dropped (Markus, 2026-10-03), and
with it the fix for the held-row shapes, which come to this design.

Measured — the first block on `623f0ccc` over `main` at `dfce2194`, debug, Windows, as throwaway
probes; the second by the narrow fix's rounds (sync.md, *A covered put is dropped only where its
claim is what brings it*, on its branch). Every row becomes one of §14's tests:

| Probe | Emitter / peer after it | Wanted |
| --- | --- | --- |
| **A baseline pulled in two halves** — the doorbell rings on the first chunk | 3 / **1** row | 3 / 3 |
| **A sparse op pulled ahead of its baseline** — a row held before pairing has no insert on the log | 5 / **0** | 5 / 5 |
| A re-broadcast, the peer having removed a copy meanwhile — the emitter's row touched by applying the peer's earlier op, which writes `updated_at = now` | 1 / **2** | 1 / 1 |
| A re-broadcast built before a third device's **delete** the peer had applied | 0 / **1 row** | 0 / 0 |
| A re-broadcast built before a third device's **note** the peer had applied | `c` / **`-`** | `c` / `c` |
| Leave, edit while unpaired, re-pair | 4 / 4 | ✓ |
| …the leaver's clock an hour fast | 4 / **2** | 4 / 4 |
| **The tombstone face** — the claim's wall-clock stamp `(…000, 1)` loses to the peer's own delete `(…400, 3)`, where the edit it carries `(…3600400, 1)` wins add-wins | 3 / **0** | 3 / 3 |
| `-1` sent with a re-baseline to a device that holds the row — same second, or a fresh claim with no timing condition at all | 2 / **3** | 2 / 2 |
| `+1` there and `+1` here | 4 / **3** | 4 / 4 |
| A note written there after it had heard this device's, the clock fast | `theirs` / **`mine`** | `theirs` |
| An edit whose claim is in a later chunk, pulled alone | the edit **lost** | ✓ |
| A held put released after a claim that contains it (the third review) | 3 / **6** under the op path | 3 / 3 |

Every bold cell is permanent divergence with nothing in `error_log`. Two more shapes are read off
the code and covered by the same rules: a first-contact **parent** carried by a real baseline and
skipped as seen, so its child waits out the hold's bound; and a mid-emission pull from a sender whose
clock runs ahead, where an applied edit lifts the watermark above a later chunk's claim for a row with
no op. **Re-broadcasts are not rare**: every pairing clears every device's `baselined_at`, so every
device re-emits to every peer at every pairing event.

**The fixes already tried are not repeated** (sync.md's tables): no claim judged by the watermark
(applied every claim again on every delivery), stamping a claim no lower than its emitter's own last
op on the row, raising `sync_peers` to a dropped put, the walk mark, the horizon mark, and the op path
on its own. What they lacked is what this design adds — a claim's own idempotence, a rule for when a
claim should write nothing, and an order in which a claim can never land ahead of a put it contains.

## 2. What this design decides

| Decision | Where |
| --- | --- |
| A claim names its **emission** and its place in it; `sync_peers` neither judges it nor is moved by it | §3, §5 |
| Each device has a **generation** — when it last began logging — and says whether it **resumed** after time out of a group | §4 |
| A receiver consumes an emission **once**, and marks an emitter's generation **taken** when one emission is wholly consumed | §5 |
| A claim and every unconsumed put of its row **decide together**; a put the client holds back enters `apply` as a hold | §5 |
| No baseline is begun while **anything** is pending | §5 |
| A taken generation's claims are **inert**. An untaken one's are **active**, and decide per row (§6's table) | §6 |
| On a row held here, an active claim **writes nothing** unless the emission resumed or this device has a **gap** | §6, §7 |
| A covered put on a row a claim has **already written** is skipped on a re-delivery | §6 |
| An emitter's horizon names what it took in through **complete** emissions | §8 |
| The tombstone face takes the op path; `update_row` stops stamping a row nothing changed | §6, §9 |

## 3. The wire: an emission reference on every claim

`merge::Op` gains one optional field, `emission`, carried by baseline ops and by nothing else:

| Key | On | Holds |
| --- | --- | --- |
| `id` | every claim | the emission's name: one tick of the emitter's `sync_clock`, minted in the stretch that reads the rows. Unique per device by construction, and it orders the device's emissions |
| `i` | every claim | the op's index in the emission, from 0 |
| `n` | `chunk[0]` of every chunk | how many ops the emission sends |
| `since` | `chunk[0]` of every chunk | the emitter's generation (§4) |
| `resumed` | `chunk[0]` of every chunk, only when true | the generation began after this device had logged in a group before (§4) |

`n`, `since` and `resumed` ride where the horizon already rides, for the horizon's reason: each
chunk is its own relay row and is pulled on its own. The keys are `#[serde(default,
skip_serializing_if = …)]`, so an ordinary op serialises exactly as today and an older receiver
ignores the field (nothing on the wire is `deny_unknown_fields`). A claim's `at` keeps its meaning —
the `updated_at` stamp — and is now used for last-writer-wins and nothing else; the envelope, the
clock hold and `rebase` go on reading it.

**Indices are assigned only to ops that will be sent.** `emit_baselines` leaves out a row too large
ever to send (`wire::oversized` on a chunk of one), and an index that never arrives would keep the
emission from ever being taken (§5). So the oversized test moves ahead of numbering — asked of the
op as a chunk of one, horizon and emission reference included — and `n` counts what is sent.

**Size.** `{"id":[ms,ctr],"i":1234}` is about 30 bytes on every claim and the `chunk[0]` keys about
50 — some 6 KB on a full 200-op chunk, against the 186 299 B measured for one (sync.md *The
baseline, measured*) and `wire::BATCH_BYTES` of 512 KiB. The chunk cut is measured with the
references on, and §14 re-measures a full chunk.

## 4. The generation: when a device last began logging, and whether it resumed

**A device's generation is the `sync_clock` stamp at which its capture last turned on**, kept in
`sync_state` under `logging_since`. Capture records nothing while a device is in no group
(`capture.rs`, the cross join on `sync_group`), so a device that has been out of a group holds
history no log carries.

- **`identity::found_group` mints one**, and **`identity::join_group` mints one only when
  `sync_group` was empty before it**. `pairing::confirm` re-writes the initiator's own group on
  every pairing; its capture never stopped, and minting there would make every pairing look like a
  device with unlogged history.
- **`resumed` is true when a generation is minted over an earlier one** — `logging_since` already
  held a value, which `identity::leave_group` keeps for exactly this, and writes as `0` when the
  device has none, so a device that logged before this build and leaves on it still resumes when it
  comes back. A device's *first* generation
  is not resumed: its pre-pairing rows carry uids no peer holds, so they reach every peer through the
  rows-not-here arms of §6, never through a row held here.
- **A device that has never minted one sends `since: 0` and no `resumed`** — "the logging that began
  before this build". No rung and no backfill.

## 5. The receiver: a claim is consumed once, decides with its row, and the watermark never sees it

A claim that carries an `emission` reference is, in `apply_in`:

- **never judged by `seen`**, never counted by `advance_watermarks`, and never a device block in
  `blocks_of`. Its stamp is a statement about a row, not a place in a stream. This alone closes the
  two halves, the sparse op ahead, the first-contact parent and the fast-clock chunk.
- **consumed once.** `sync_state` keeps, per emitter, the emissions in flight —
  `emission@<device id>`: each one's `id`, `n`, `since`, `resumed`, and two sets of index ranges:
  **wrote** (the claim built, merged or floored its row) and **passed** (consumed and wrote nothing —
  §6's held-row arm, a moot claim, one dropped and recorded); the newest four emissions at most. A
  claim whose index is in either set is skipped as seen.
- **decided together with its row.** Groups are one per row and a group already holds as a whole
  (`held_by` asks every op in it), so a claim beside a put that is held — by a device block, a missing
  parent, a newer schema — is held with it, not consumed, and comes back with it. The claim itself
  blocks nothing: it creates no device block. **What is new is that ops the client holds back are no
  longer taken out of the page**: every batch it holds that it could open — a sender held for its
  clock, or a sender's batches behind one only a newer build can read — enters `apply` with its ops
  marked held, so they hold their rows' groups. The claim that contains such a put can no longer land
  ahead of it, which is the third review's 6-for-3 closed at its root. (A batch only a newer build can
  parse has no ops to pass; §6's containment rule and §8's horizon cover it.)
- **taken** when every index of one emission is consumed: `taken@<device id>` becomes that
  emission's `since`, and every in-flight record of that emitter whose `since` is at or below it is
  dropped. A newer emission completing supersedes an older one left half-sent.

**No baseline is begun while anything is pending.** 6a already refuses one while an op written since
the trip read its outbox is pending; this widens it to every pending op, whatever left it there. A
pending op is inside the emission's rows and its horizon but not on the relay's log, so it arrives in
a later page than the claims, with no horizon beside it to say so — and a row a claim has just built
would count it a second time. The marker stays NULL and the next trip, which pushes the op first,
emits behind it.

## 6. Active and inert, and what an active claim does to each row

**Decided per emission, once, at the start of `apply_in`**, from its emitter's `taken@` mark as it
stood before the page and the `since` its `chunk[0]` carries — per emission and not per emitter,
because one page can hold an emission from before an emitter's rejoin and one from after it:

| The emitter's generation, as this device holds it | The emission is |
| --- | --- |
| no `taken@` mark, or `since` above it | **active** |
| `since` at or below the mark | **inert**: every claim skipped as seen with no database work; its horizon left out of the page's union, so it drops no put; its indices not tracked |

**Why inert is exact.** A taken generation means this device consumed one whole emission of it and
has read every op the emitter logged since — §7 clears the mark the moment that stops being true.
Everything such a claim says is already here through the log; applying it could only take back what
happened since. This is the baseline design's cheap exit with its premise checked rather than
guessed: "this device has heard everything since", asked of the generation, never of a stamp.

**An active claim, and the covered puts beside it, by the row:**

| The claim's row on this device | A covered put of that row, not seen | The claim |
| --- | --- | --- |
| **here, under the claim's uid** | **op path**: applied as the delta it is, at its own stamp | **passed — writes nothing**, unless the emission `resumed` or this device has an open gap (§7), when it is a **floor** over the op path: `max(local + Σ deltas, claim)` |
| not here under its uid, and **this device's own `sync_ops` names it** (it held and deleted it) | **op path** — the tombstone face | **builds** the row: `insert_row`'s `max(Σ deltas, claim)`, existence decided by add-wins at the puts' own stamps |
| not here under its uid, **a grain twin under another uid** | **dropped**: the claim carries it, and the two rows are independent — §8's `max`, never a sum | **merges** by `max`, adopting `min(uid)` as today |
| **not here at all**, never held | **dropped**: the claim carries it | **builds** — §8.2's accepted under-count, unchanged |

**And one rule across every row: a covered put is skipped when the page carries a claim for its row,
from an emission whose horizon covers it, that has already *written* the row.** That is a re-delivery
of a page whose claim built, merged or floored the row the first time; the put is inside the claim,
and the row already holds it. It replaces the narrow fix's absorbed mark for claims with a reference:
the evidence is the page itself, per row, rather than a device-wide stamp.

**Why the held-row arm writes nothing.** A row held here under the claim's uid came here through
the log, and the log brings everything that happened to it — every covered put in the page takes the
op path, and every put before the page has already been applied. The claim has nothing left to say,
and a floor could only take back what happened here since (§1's first re-broadcast row) or count a
held put twice (the 6-for-3). The two exceptions are exactly the two ways a held row can be missing
history no log carries: the emitter **resumed** after time out of a group, when its unlogged edits are
in the claim and nowhere else; and this device has a **gap**, when ops it never applied are in the
claim and nowhere else. There the floor is the only road, and §8.2's direction — never invent a card,
accept an under-count — is the rule.

**Every held-row shape in §1 is exact in every generation:** a `-1` takes the op path (2); `+1` here
and `+1` there both survive (4); a note lands at its own stamp; an edit whose claim is in a later
chunk takes the op path without waiting for it; and a held put whose row's claim wrote nothing is
applied once when it is released.

## 7. A gap clears the marks and opens the floor

A taken generation promises that this device has read everything since. Anything that breaks the
promise clears **every** `taken@` and `emission@` mark and sets the **gap** — `sync_state`'s `gap`:

| The gap | Where it is opened |
| --- | --- |
| This device's place in a log is forgotten — leaving, founding, joining a different group | `identity::forget_log_position`, beside the cursor it already deletes |
| An envelope stepped over as unreadable — an altered blob, a malformed one, an epoch whose key a removal forgot | `client::pull`, where `unreadable` is counted |
| A group dropped and recorded, or released at the waiting bound | `apply_in`, after the committed pass writes its `taken@` marks — so a pass that drops a claim leaves its emitter untaken even when the drop was that emission's last index |

While the gap is open, an active emission floors the rows held here (§6). **It closes when every
device on this group's roster that this one holds a watermark for has a `taken@` mark again** —
every emitter's state has then reached this device whole since the gap. The roster and not
`sync_peers` alone, because a watermark outlives its group (sync.md *A cursor is a place in one
group's log*): a device that moved groups holds watermarks for peers that will never emit to it
again, and would keep its gap open for good. Each gap is a place where the watermark — or the cursor —
passed an op this device never applied. A source that drops every time keeps the gap open and every
emission active and flooring: the narrow fix's behaviour, never below it.

## 8. An emitter's horizon names what it took in through claims

A horizon says, per device, how far that device's ops are already inside the emitter's rows — and
the rows also hold what came in through claims, which never raised `sync_peers`. So the emitter keeps
`carried@<device id>` in `sync_state`, raised to an emission's horizon entry for every device it
names **when that emission becomes taken** — whole, so every row it carried has landed — and
`baseline::horizon` reports `max(sync_peers, carried)` for each device. A partial emission raises
nothing: its rows are not all here, and a horizon that named its puts would drop them for rows that
lack them. What this closes is a grain twin meeting a third device's put the emitter carried in
through a claim — counted on top of the twin's own value where every other device took the `max` —
and the newer-build batch §5 cannot pass to `apply`, which then finds its row's claim covered and
already written.

## 9. `update_row` stops stamping a row nothing changed

`update_row` writes `updated_at = unixepoch()` whenever the table has timestamps, even when no
column won and no counter moved. A claim that changes nothing then stamps the row *now*, and this
device's next baseline claims that row at *now* — beating genuinely newer edits made elsewhere in
between, which is the baseline design §10.2's own argument against stamping a claim with "now". So
the stamp is written only when a column is written or a counter changes. The same holds for an
ordinary op whose every field lost last-writer-wins. **The bump is read today, which makes it worse
rather than harmless**: the deck gallery sorts by `decks.updated_at DESC` (`deck.rs`, `list_decks`)
and the to-do widget's *Last edited* by `deck_todo_lists.updated_at`, so a claim that changed nothing
moves a deck to the top of the gallery on the device that applied it; and the `UPDATE` is a row write
the update hook reports, so the mirror and every other window refresh for nothing.

## 10. Older builds

| Pair | What happens |
| --- | --- |
| this emitter → an older receiver | the `emission` field is ignored; claims are judged by `at` exactly as they are today, with today's losses |
| an older emitter → this receiver | no `emission` field: the narrow fix's rules as it ships — every covered put dropped, the claim a floor let past the watermark by `Owed`, the absorbed mark and its cut. They stay for this case alone |
| both on this build | everything above |

A mixed group is never worse than it is today, and the gains are between upgraded devices. No rung:
every mark is a `sync_state` key, as the absorbed marks are.

## 11. What this does not do

- **A resumed emission, or any active emission during a gap, floors the rows held here** (§6), and a
  floor can take back a removal, or reinstate a note, made here in the window before it lands. It is
  the one window where the log cannot be trusted to be whole; §8.2 chooses the floor there on purpose.
- **A re-emission after a half-sent baseline** has a new `id`, so a row the first half built is
  written again by the second; a change made here between the two attempts can lose to it.
- **A third device's delete, applied here, and a later active claim for that row** resurrect the row
  here only — `sync_gone` records parent tables alone, so nothing remembers a deleted
  `collection_entries` row. Inside an active emission only.
- **A device that resumed before this build** sends `since: 0` and no `resumed`, so its first
  emission after the upgrade writes nothing on rows held elsewhere; edits it made while out of a group
  before the upgrade, and never re-emitted, stay where they are.
- Each goes to sync.md's *What is still owed* with its scenario.

## 12. Constraints, and how each is met

| Constraint | Met by |
| --- | --- |
| The baseline design §9.1: the horizon is a filter on one batch and never a watermark write | unchanged — the horizon still only filters, claims write no watermark, and `carried` feeds an emitter's own horizon, never `sync_peers` (§5, §8) |
| §8.2's accepted under-count for a row never held is not fixed by accident | §6's last row keeps the drop, and the under-count's test stays as written |
| The sync client moves to `crates/grimoire-core` in #761 step 6b | every client line — the `chunk[0]` keys, the pending check, the held sender's ops passed to `apply`, the unreadable gap — lands after 6b, on the moved file (§13) |
| Decide by experiment | §1's table is measured; every row of it and of the narrow fix's matrix becomes a red test before any code moves (§14) |

## 13. Sequencing, and where the code goes

1. **The narrow fix merges** as it is being rewritten — every covered put dropped, `Owed`, the
   absorbed mark spent per emitter, the cut. This design keeps all of it for claims with no reference
   (§10) and replaces it for claims with one.
2. **#761 step 6b moves** `client`, `wire`, `identity` and the rest into `crates/grimoire-core`.
3. **This lands on a fresh `main`** — merged, never rebased — touching:

| File (after 6b) | Change |
| --- | --- |
| `crates/grimoire-core/src/sync_engine/merge.rs` | `Op::emission` and its struct |
| `crates/grimoire-core/src/sync_engine/baseline.rs` | mint the emission `id`, number the sendable ops; `horizon` reads `carried` |
| the moved `client.rs` | the `chunk[0]` keys beside the horizon; the oversized test ahead of numbering; no emission while anything is pending; every batch it holds back and could open passed to `apply` as held; the gap where `pull` counts `unreadable` |
| the moved `identity.rs` | mint `logging_since` and `resumed` in `found_group` and in `join_group` from no group; keep `logging_since` in `leave_group`, writing `0` where there is none; open the gap in `forget_log_position` |
| `crates/grimoire-core/src/sync_engine/apply.rs` | §5–§7: consumption, groups holding whole, held ops from the client, taken, active and inert, the row table, containment, the gap; `carried` when an emission is taken |
| `crates/grimoire-core/src/sync_engine/apply.rs` (`update_row`) | §9 |
| `docs/reference/sync.md`, the baseline design §9–§11, `src-tauri/CLAUDE.md` | the record, the amendment, the binding rule |

## 14. How it will be verified

**Every row below is a failing test before any code moves**, written over two or three real
databases as `apply/tests.rs` does. Each row that turns on the generation is written for each state
that matters — untaken (first contact, and `since: 0` after the upgrade), taken, resumed, and
during a gap:

1. A baseline pulled in two halves reaches a device that held nothing — 3 of 3 (un-ignored).
2. A sparse op pulled ahead of its baseline costs nothing — 5 (un-ignored).
3. A first-contact parent below the watermark lands with its child on the first delivery.
4. A later chunk, the sender's clock fast, a row with no op — lands.
5. The tombstone face — 3 on both.
6. A `-1` with a re-baseline to a device that holds the row, same second and fresh — 2, untaken and
   taken.
7. `+1` there and `+1` here — 4, untaken and taken.
8. A note written there after it heard this device's, the clock fast — `theirs`.
9. An edit whose claim is in a later chunk, pulled alone — lands at once.
10. **The 6-for-3**: a sender held for its clock while a third device's claim for its row arrives —
    3, under a passed claim and under a floor (resumed); and the same with the held put from a batch
    only a newer build parses, released after the upgrade.
11. A re-broadcast with a removal made here meanwhile — 1 on both; a re-broadcast and a third
    device's delete applied here — 0 rows anywhere; and its note — `c` on both. Taken, and untaken.
12. Leave, edit unpaired, re-pair — 4 and the note, with and without the leaver's clock an hour fast;
    the re-pair mints a resumed generation and the initiator's re-write mints none.
13. A receiver whose log position is forgotten, that steps over an unreadable envelope, or that drops
    a group, floors its next active emissions, and the gap closes when every emitter is taken again.
14. A claim held mid-emission lands once when its page comes back, holds none of its emitter's
    ordinary ops, and the emission is taken only after it.
15. A whole active page handed back writes nothing the second time — counts, a field edited later,
    a copy removed in between, a row a claim built and the covered put beside it.
16. A baseline is not begun while an op an earlier refusal left pending is still pending, and is begun
    on the trip that pushes it.
17. A row left out as unsendable does not keep its emission from being taken.
18. A grain twin and a third device's put the emitter carried in through a claim: `max`, on every
    device; `carried` rises only when an emission is taken.
19. An op with no `emission` is judged exactly as the narrow fix judges it — its whole matrix green.
20. An ordinary op serialises byte for byte as before; an op carrying the field round-trips; a
    hand-written op without it reads as `None`.
21. A claim that changes nothing, and an ordinary op whose every field lost, leave `updated_at` as it
    was — and a deck's place in the gallery with it.
22. §8.1's first pairing applied twice is 5; §8.2's never-held under-count is still 2.
23. A full 200-op chunk with references stays under `wire::BATCH_BYTES`, measured and recorded.

Then the rest of `apply/tests.rs`, `cargo test --workspace` and `npm run verify`; and a live
two-device pass over a loopback mock relay that pairs, removes a copy on one device while the other
re-broadcasts, holds one device's clock a day ahead for one trip, and reads both collections.
