# A claim carries its own idempotence: emissions and generations — design

**Date:** 2026-10-03 · **Status:** approved approach ("Emission id + generation"), spec for review
**Builds on** [the pairing baseline design](2026-08-29-sync-baseline-design.md) §8–§11 and on the
narrow fix committed as `623f0ccc` on `fix/sync-baseline-claim-skipped-as-seen` — sync.md's *A
covered put is dropped only where its claim is what brings it*. **Lands after** that fix and after
[issue #761](https://github.com/Msgaihede/mtg-grimoire/issues/761) step 6b, which moves the sync
client into `crates/grimoire-core` (§13).

**Goal:** a baseline op — a *claim* — is applied exactly once by a device that needs it, and not
at all by a device that already holds everything it says, whatever order its chunks arrive in and
whatever the emitter's clock was doing.

---

## 1. The problem, measured

`sync_peers` is a watermark over a device's **ordinary** op stream, which reaches every peer in
stamp order. A claim is stamped from its row's `updated_at` — whole wall-clock seconds, with a
running index as the counter (`baseline::build`) — and emitted in table order, and it is both
**judged** by that watermark (`seen` in `apply_in`) and allowed to **raise** it
(`advance_watermarks`). So a claim can be skipped as "seen" by a device that has never held its
row. The same comparison is the baseline design's cheap exit (§10.2, §11): a device that is up to
date skips a re-broadcast because its watermark sits above the claims' stamps. That exit is not
merely lost by a fix — **it already fails**, because a wall-clock second says nothing reliable
about a hybrid-clock stream.

Measured on `623f0ccc` over `main` at `dfce2194`, debug, Windows — every probe a throwaway test,
not committed; the scenarios become §14's tests:

| Probe | Emitter / peer after it | Wanted |
| --- | --- | --- |
| **A baseline pulled in two halves** — the doorbell rings on the first chunk (`#[ignore]`d) | 3 / **1** row | 3 / 3 |
| **A sparse op pulled ahead of its baseline** — a row held before pairing has no insert on the log (`#[ignore]`d) | 5 / **0** | 5 / 5 |
| A re-broadcast, the peer having removed a copy meanwhile — the emitter's row touched by applying the peer's earlier op, which writes `updated_at = now` | 1 / **2** | 1 / 1 |
| A re-broadcast built before a third device's **delete** the peer had applied | 0 / **1 row** | 0 / 0 |
| A re-broadcast built before a third device's **note** the peer had applied | `c` / **`-`** | `c` / `c` |
| Leave, edit while unpaired, re-pair | 4 / 4 | ✓ |
| …the leaver's clock an hour fast | 4 / **2** | 4 / 4 |
| **The tombstone face** — the claim's wall-clock stamp `(…000, 1)` loses to the peer's own delete `(…400, 3)`, where the edit it carries `(…3600400, 1)` wins add-wins | 3 / **0** | 3 / 3 |

Every bold cell is permanent divergence with nothing in `error_log`. Two more shapes are read off
the code and covered by the same rule: a first-contact **parent** carried by a real baseline and
skipped as seen, so its child waits out the hold's bound (sync.md *What is still owed*); and the
one row the narrow fix's round two lost against HEAD — a mid-emission pull from a sender whose clock
runs ahead, where the applied edit lifts the watermark above a later chunk's claim for a row with no
op. **Re-broadcasts are not rare**: every pairing clears every device's `baselined_at`, so every
device re-emits to every peer at every pairing event.

**Six fixes were tried for the narrow bug and are not repeated here** (sync.md's two tables). The
one that closed the two halves and the sparse op — no claim judged by the watermark at all —
applied every claim again on every delivery. What it lacked is what this design adds: a claim's own
idempotence, and a rule for when a claim should not be applied at all.

## 2. What this design decides

| Decision | Where |
| --- | --- |
| A claim names its **emission** and its place in it; `sync_peers` neither judges it nor is moved by it | §3, §5 |
| Each device has a **generation** — when it last began logging — and every claim says which | §4 |
| A receiver applies an emission **once**, and marks an emitter's generation **taken** when every op of one emission is consumed | §5 |
| A taken generation's claims are **inert**: skipped with no database work. An untaken one's are **active**, under the narrow fix's rules but for §8's one change | §6 |
| Any **gap** in what this device has read clears the marks | §7 |
| A covered put on a row not here that **this device's own history names** takes the op path | §8 |
| `update_row` **stops stamping** `updated_at` when it changed nothing | §9 |

## 3. The wire: an emission reference on every claim

`merge::Op` gains one optional field, `emission`, carried by baseline ops and by nothing else:

| Key | On | Holds |
| --- | --- | --- |
| `id` | every claim | the emission's name: one tick of the emitter's `sync_clock`, minted in the stretch that reads the rows. Unique per device by construction, and it orders the device's emissions |
| `i` | every claim | the op's index in the emission, from 0 |
| `n` | `chunk[0]` of every chunk | how many ops the emission sends |
| `since` | `chunk[0]` of every chunk | the emitter's generation (§4) |

`n` and `since` ride where the horizon already rides, and for the horizon's reason: each chunk is
its own relay row and is pulled on its own, so a chunk must carry what the receiver needs to judge
it. The keys are `#[serde(default, skip_serializing_if = …)]`, so an ordinary op serialises exactly
as today and an older receiver ignores the field (nothing on the wire is `deny_unknown_fields`).
The stamp of a claim, `at`, keeps its meaning — the `updated_at` stamp — and is now used for
last-writer-wins and nothing else.

**Indices are assigned only to ops that will be sent.** `emit_baselines` leaves out a row too large
ever to send (`wire::oversized` on a chunk of one), and an index that never arrives would keep the
emission from ever being taken (§5). So the oversized test moves ahead of numbering — asked of the
op as a chunk of one, horizon and emission reference included — and `n` counts what is sent.

**What the emitter's code is:** `baseline::build` takes the emission `id` and numbers its ops; the
line in `emit_baselines` that writes `chunk[0].horizon` writes `n` and `since` beside it. The
emission `id` is minted inside the stretch that already reads the rows, the clock and the horizon,
so the three still agree. Nothing else in the emitter changes: the envelope is still stamped from
the last op's `at`, the clock hold and `rebase` still read `at`, and a pending op does not hold a
baseline back any more than it does today (§5 says why that stays safe).

**Size.** `{"id":[ms,ctr],"i":1234}` is about 30 bytes on every claim and `n`/`since` about 40 on
each `chunk[0]` — some 6 KB on a full 200-op chunk, against the 186 299 B measured for one
(sync.md *The baseline, measured*) and `wire::BATCH_BYTES` of 512 KiB. The chunk cut is measured
with the references on, and §14 re-measures a full chunk.

## 4. The generation: when a device last began logging

**A device's generation is the `sync_clock` stamp at which its capture last turned on**, kept in
`sync_state` under `logging_since`. Capture records nothing while a device is in no group
(`capture.rs`, the cross join on `sync_group`), so a device that has been out of a group holds
history no log carries — and a new generation is how it says so.

- **`identity::found_group` mints one**, and **`identity::join_group` mints one only when
  `sync_group` was empty before it**. `pairing::confirm` re-writes the initiator's own group on
  every pairing; its capture never stopped, and minting there would make every pairing look, to
  every receiver, like a device with unlogged history.
- **A device that has never minted one sends `since: 0`** — "the logging that began before this
  build". No rung and no backfill: a device already in a group at the upgrade has no unlogged
  history that its earlier baselines did not carry.
- **The generation is about the emitter only.** What a *receiver* has missed is §7's.

## 5. The receiver: a claim is consumed once, and the watermark never sees it

A claim that carries an `emission` reference is, in `apply_in`:

- **never judged by `seen`**, never counted by `advance_watermarks`, and never a device block in
  `blocks_of` or collateral in `held_by`. Its stamp is a statement about a row, not a place in a
  stream, and §1 is what comes of reading it as one. This alone closes the two halves, the sparse
  op ahead, the first-contact parent and the fast-clock chunk: nothing a stream did can make a claim
  look already applied.
- **consumed once.** `sync_state` keeps, per emitter, the emissions in flight —
  `emission@<device id>`: each one's `id`, `n`, `since` and the index ranges consumed, the newest
  four at most. A claim whose index is consumed is skipped as seen; one that is not goes on to §6.
  An index is consumed when the committed pass wrote it, found it moot, or dropped and recorded it —
  every outcome but a hold.
- **held like any group, and blocking nothing else.** A claim waiting on a parent is not consumed.
  Its group holds the cursor exactly as a held group does now — counted in the report, so
  `client::pull` holds `PULL_CURSOR` — and the page comes back; on that delivery the claim is the
  one index still unconsumed, and lands once. It holds no ordinary op of its emitter, because it was
  never in that emitter's stream. It does take part in the waiting bound's block identity (the
  delivery holds' I1), so a newly held claim restarts the bound and a released one is dropped and
  recorded like any other.
- **taken** when every index of one emission is consumed: `taken@<device id>` becomes that
  emission's `since`, and every in-flight record of that emitter whose `since` is at or below it is
  dropped. A newer emission completing supersedes an older one left half-sent.

**Why a pending op of the emitter stays safe.** The claims never raise `sync_peers`, so an op the
emitter had not pushed when it emitted — which 6a lets through when an *earlier* refusal left it
pending — is not skipped when it arrives. Under an active emission it is covered by the horizon and
already taken in through the absorbed mark the claims spent; under an inert one (§6) the horizon is
not in force and it takes the op path like any op. The two-stamps alternative raised the watermark
with every claim and would have lost it — the reason it was not chosen.

## 6. Active and inert: the cheap exit, made exact

Decided **per emission, once, at the start of `apply_in`**, from its emitter's `taken@` mark as it
stood before the page and the `since` its `chunk[0]` carries — per emission and not per emitter,
because one page can hold an emission from before an emitter's rejoin and one from after it:

| The emitter's generation, as this device holds it | The claims are | Which means |
| --- | --- | --- |
| no `taken@` mark, or `since` above it | **active** | the narrow fix's rules, with §8's one change: a covered put on a row held here takes the op path and the claim is a floor over it; on a row not here the put is dropped and the claim is the only road; landing spends the emitter's horizon into the absorbed marks |
| `since` at or below the mark | **inert** | skipped as seen, with no database work; the emission's horizon is left out of the page's union, so it drops no put; it spends no absorbed mark; its indices are not tracked |

**Why inert is exact rather than approximate.** A taken generation means this device consumed one
whole emission of it, and has read every op the emitter logged since — §7 clears the mark the
moment that stops being true. Everything such a claim says is therefore already here, through the
log: the claim adds nothing, and applying it could only take back what happened since — the three
middle rows of §1's table. This is the baseline design's cheap exit with its premise checked rather
than guessed: "this device has heard everything since", asked of the generation, never of a stamp.

**What active still costs.** The first emission of each (emitter, generation) a device reads is
active, and active is today's floor: a removal made here in the seconds between first contact and
that emission landing can be taken back, and a stale claim can meet a third device's delete or note
in the same window. After the upgrade every emitter's first emission is active once — `since: 0`
included — rather than seeded as taken, because seeding would make a first contact half-pulled at
the moment of the upgrade drop its remaining rows, which is the silent direction. §11 carries both.

## 7. A gap clears the marks

A taken generation promises that this device has read everything since. Anything that breaks the
promise clears **every** `taken@` and `emission@` mark, so the next emission from each emitter is
active:

| The gap | Where it is cleared |
| --- | --- |
| This device's place in a log is forgotten — leaving, founding, joining a different group | `identity::forget_log_position`, beside the cursor it already deletes |
| An envelope stepped over as unreadable — an altered blob, a malformed one, an epoch whose key a removal forgot | `client::pull`, where `unreadable` is counted |
| A group dropped and recorded, or released at the waiting bound | `apply_in`, after the committed pass |

Each one is a place where the watermark — or the cursor — has passed an op this device never
applied. **`apply_in` clears after it writes the pass's `taken@` marks**, so a pass that drops a
claim leaves its emitter untaken even when the drop was that emission's last index: the row it could
not build is exactly what the next active emission is for. A source that drops every time (an older peer's renamed table, say) keeps the marks clear
and so keeps every emission active: the code degrades to the narrow fix's behaviour, never below it.

## 8. The tombstone face

A covered put on a row **not here** is dropped by the narrow fix, on §8.1's ground that a claim and
the deltas inside it must never both seed a row. Where **this device's own `sync_ops` names the
row** — it held it and deleted it — that drop costs the put its stamp, and the claim's wall-clock
stamp then loses add-wins to a delete the put would have beaten (§1, `3 / 0`). So such a put takes
the op path. Nothing doubles: the row is created through `insert_row`, whose counter is
`max(Σ deltas, claim)`, so a delta inside the claim is absorbed by the `max` rather than added to
it; and existence is decided at the put's real stamp.

**§8.2's accepted under-count is untouched, on purpose.** It is the case of a row *never held* — no
local history — where the put is still dropped, and
`a_claim_and_a_later_delta_on_a_row_never_held_still_undercount` stays green as written.

## 9. `update_row` stops stamping a row nothing changed

`update_row` writes `updated_at = unixepoch()` whenever the table has timestamps, even when no
column won and no counter moved. A claim that changes nothing then stamps the row *now*, and this
device's next baseline claims that row at *now* — beating genuinely newer edits made elsewhere in
between, which is the baseline design §10.2's own argument against stamping a claim with "now". So
the stamp is written only when a column is written or a counter changes. The same holds for an
ordinary op whose every field lost last-writer-wins: nothing changed, and the row's modification
time must not say otherwise. **The bump is read today, which makes it worse rather than
harmless**: the deck gallery sorts by `decks.updated_at DESC` (`deck.rs`, `list_decks`) and the
to-do widget's *Last edited* by `deck_todo_lists.updated_at`, so a claim that changed nothing moves
a deck to the top of the gallery on the device that applied it; and the `UPDATE` is a row write the
update hook reports, so the mirror and every other window refresh for nothing.

## 10. Older builds

| Pair | What happens |
| --- | --- |
| this emitter → an older receiver | the `emission` field is ignored; claims are judged by `at` exactly as they are today, with today's losses |
| an older emitter → this receiver | no `emission` field: the narrow fix's rules unchanged — `seen` on `at`, `Owed`'s exemption, the stamp-based cheap exit. `Owed` stays for this case alone |
| both on this build | everything above |

A mixed group is therefore never worse than it is today, and the gains are between upgraded
devices. No rung: every mark is a `sync_state` key, as the absorbed marks are.

## 11. What this does not do

- **The first active emission per (emitter, generation) is the floor, as today** (§6): a removal,
  a delete or a note made here in the window between first contact and that emission — or once per
  emitter after the upgrade — can still lose to it.
- **A re-emission after a half-sent baseline** has a new `id`, so the rows the half that landed
  built are claimed again by the second; a change made here between the two attempts can be taken
  back by it. Superseding an older emission by `id` would need to know, per row, which emission
  built it.
- **A third device's delete, applied here, and a later active claim for that row** resurrect the
  row here only — `sync_gone` records parent tables alone, so nothing remembers a deleted
  `collection_entries` row. Inside an active window only.
- **Neither the two stamps nor the per-row memory** these would need are built; each residual goes
  to sync.md's *What is still owed* with its scenario.

## 12. Constraints, and how each is met

| Constraint | Met by |
| --- | --- |
| The baseline design §9.1: the horizon is a filter on one batch and never a watermark write | unchanged — the horizon still only filters, and claims now write no watermark either (§5) |
| §8.2's accepted under-count for a row never held is not fixed by accident | §8 is limited to rows this device's history names, and the under-count's test stays as written |
| The sync client moves to `crates/grimoire-core` in #761 step 6b | the emitter's change is one line beside the horizon, and the receiver's gap is one call in `pull`; both land after 6b, on the moved file (§13) |
| Decide by experiment | §1's table is measured; every row of it and of the narrow fix's matrix becomes a red test before any code moves (§14) |

## 13. Sequencing, and where the code goes

1. **The narrow fix merges** (`623f0ccc`, PR to come). This design keeps its rules for active
   claims, its absorbed mark and `absorbed_ready`, and narrows `Owed` to claims with no reference.
2. **#761 step 6b moves** `client`, `wire`, `identity` and the rest into `crates/grimoire-core`.
3. **This lands on a fresh `main`** — merged, never rebased — touching:

| File (after 6b) | Change |
| --- | --- |
| `crates/grimoire-core/src/sync_engine/merge.rs` | `Op::emission` and its struct |
| `crates/grimoire-core/src/sync_engine/baseline.rs` | mint the emission `id`, number the sendable ops |
| the moved `client.rs` | `n` and `since` beside `chunk[0].horizon`; the oversized test ahead of numbering; clear the marks where `pull` counts `unreadable` |
| the moved `identity.rs` | mint `logging_since` in `found_group` and in `join_group` from no group; clear the marks in `forget_log_position` |
| `crates/grimoire-core/src/sync_engine/apply.rs` | §5–§8: consumption, taken, active/inert, gap clearing, the tombstone face |
| `crates/grimoire-core/src/sync_engine/apply.rs` (`update_row`) | §9 |
| `docs/reference/sync.md`, the baseline design §9–§11, `src-tauri/CLAUDE.md` | the record, the amendment, the binding rule |

## 14. How it will be verified

**Every row below is a failing test before any code moves**, written over two or three real
databases as `apply/tests.rs` does, and each of §1's re-broadcast rows is written twice — once with
the emitter's generation untaken (it stays the floor; the test pins today's answer and names it as
owed) and once taken (it must converge):

1. A baseline pulled in two halves reaches a device that held nothing — 3 of 3 (un-ignored).
2. A sparse op pulled ahead of its baseline costs nothing — 5 (un-ignored).
3. A first-contact parent below the watermark lands with its child on the first delivery.
4. A later chunk, the sender's clock fast, a row with no op — lands.
5. The tombstone face — 3 on both.
6. A re-broadcast with a removal made here meanwhile — 1 on both, taken.
7. A re-broadcast and a third device's delete applied here — 0 rows anywhere, taken.
8. A re-broadcast and a third device's note applied here — `c` on both, taken.
9. Leave, edit unpaired, re-pair — 4 and the note, with and without the leaver's clock an hour
   fast; the re-pair mints a generation and the initiator's re-write does not.
10. A receiver whose log position is forgotten, or that steps over an unreadable envelope, or drops
    a group, reads the next emission as active.
11. A claim held mid-emission lands once when its page comes back, holds none of its emitter's
    ordinary ops, and the emission is taken only after it.
12. A whole active page handed back applies nothing the second time — counts, a field edited
    later, a copy removed in between.
13. A row left out as unsendable does not keep its emission from being taken.
14. An op with no `emission` is judged exactly as the narrow fix judges it — its whole matrix green.
15. An ordinary op serialises byte for byte as before; an op carrying the field round-trips; a
    hand-written op without it reads as `None`.
16. A claim that changes nothing, and an ordinary op whose every field lost, leave `updated_at`
    as it was.
17. §8.1's first pairing applied twice is 5; §8.2's never-held under-count is still 2.
18. A full 200-op chunk with references stays under `wire::BATCH_BYTES`, measured and recorded.

Then the narrow fix's committed matrix, the rest of `apply/tests.rs`, `cargo test --workspace` and
`npm run verify`; and a live two-device pass over a loopback mock relay that pairs, removes a copy
on one device while the other re-broadcasts, and reads both collections.
