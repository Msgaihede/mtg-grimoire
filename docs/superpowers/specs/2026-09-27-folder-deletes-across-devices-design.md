# Folder deletes across devices: stall nothing, lose nothing — design

**Date:** 2026-09-27 · **Status:** approved approach ("Local tombstones" + "Retry, then merge"),
spec approved. Written to land before token stacks PR 3 (Collection tokens), which would have
deleted a deck's token folder on every exit from Collection mode; **PR 3 was dropped the same day**
(the reader's decision), and this stands on its own: today a deck deleted with a copy its group
and the root both hold stops a paired device's sync for good. Builds on the delivery holds (#572,
#574). **The rung was written as user schema v53 and renumbered to v54 at the merge with `main`**,
whose per-list piles (#561) took 53 first; the rung is v54 below.

## 1. The problem

Every cite is `src-tauri/src/sync_engine/` unless it says otherwise.

### 1.1 A peer's folder delete can stop that device's sync for good

`apply` takes a page **parents first** (`apply.rs` `META[].order`): `collection_folders` is rank 6
and `collection_entries` rank 7. `collection_folders::delete_folder` re-files every copy in the
sub-tree onto the root one at a time, merging onto a copy the root already holds
(`refile_entry` → `collection::fold_entry`), and only then deletes the folder — so the deleting
device never meets a collision. The peer does: the folder's `DELETE` runs while the copy is still
filed in it, `ON DELETE SET NULL` moves the copy onto the root row's grain, and
`write_group`'s delete arm answers `UNIQUE constraint failed: index 'idx_collection_grain'`
through `?` (`apply.rs`, the `combined.deleted` arm). **The whole apply fails, and the same page
fails it again on every pull** — that device's sync stops. Reproduced 2026-09-27 by a throwaway
probe in the `apply` test harness (debug build): a binder holding one copy of a printing the root
also holds, deleted through `delete_folder` on one device and applied on the other
(`docs/reference/sync.md`, *What is still owed*).

**It is not only binders**, read off the code and unmeasured:

- **A wishlist folder**, the same shape: `wishlist_entries.folder_id` is `SET NULL` and the
  wishlist's grain carries the folder (`schema::WISHLIST_GRAIN`).
- **A deck.** `collection_folders.deck_id` is `ON DELETE CASCADE`, so deleting a deck takes its
  group folder, and the group's copies are `SET NULL`ed onto the root. `deck::delete_deck` files
  the group into `Recently removed` first (rank-7 ops); on the peer the deck's `DELETE` (rank 1)
  runs before them. A deck holding a copy the root also holds stalls its peers.
- **A copy filed into the folder on the peer itself**, concurrently. The page carries no re-filing
  for it at all, so no ordering saves it.

### 1.2 A delete applied from a peer leaves no trace, and a later child of it is lost

`gone` (`apply.rs`) answers "was this missing parent deleted?" from two places only: a `del` in
this device's **own** `sync_ops`, and a delete **in this page**. A delete a peer made is applied
inside `capture::suppressed`, and the cascade it sets off runs there too, so neither leaves a
`del` anywhere. A child naming that parent on a later page therefore reads as merely missing: it
waits out the waiting bound (3 pulls over 600 s) and is dropped, recorded.

- **The moved folder** (the second scoped re-review of #574). B moves folder X under folder P
  while A deletes P. On B, A's delete cascades X away, uncaptured. On A, B's move is moot and X
  stays where it was. Everything A files into X from then on — a deck with its cards, a copy, a
  wish, a sub-folder — reaches B naming a folder B cannot see is gone, waits out the bound and is
  dropped, for as long as X stands on A. Deleting X on A instead (round 1 of #574) converged, but
  lost what B filed into X before hearing about the delete, because B's filings then named a
  parent A could not see was gone. **Neither answer is right without a trace**, which is why #574
  shipped the first and documented the loss.
- **A third device's delete** (sync.md, *A parent deleted on a third device*). Where the key
  cascades, the child's drop is convergent but writes an `error_log` row describing no fault;
  where it is `SET NULL` (a binder, a deck folder, a label) the child's own device keeps it at the
  root and this device loses it.

### 1.3 Two SQLite facts the design stands on

- **A cascaded delete fires both `BEFORE DELETE` and `AFTER DELETE` triggers on the rows it
  takes**, with `recursive_triggers` off. Measured 2026-09-27 with `node:sqlite`: deleting a
  folder whose child folder cascades logged `before p, before x, after x, after p`, and deleting a
  deck whose folder cascades on `deck_id` logged `before g, after g`. So a trigger sees every
  delete, whatever caused it.
- **Three foreign keys cascade into the two folder tables**: `collection_folders.parent_id`,
  `collection_folders.deck_id` and `wishlist_folders.parent_id`. `wishlist_folders.managed_deck_id`
  has no foreign key (a managed folder is derived per device), so deleting a deck never cascades
  into a wishlist.

## 2. Goals and non-goals

**Goals.** A folder or deck deleted on one device never stops another device's sync. A change
that names a parent deleted anywhere — here, by a peer, or by a cascade — lands the way that
parent's foreign key says: dropped with it where the key cascades, at the root where it is
`SET NULL`. A folder moved under one deleted elsewhere goes on both devices, and what either
device filed into it lands at the root on both. A copy filed concurrently into a folder being
deleted survives on both devices, with one count and one uid.

**Non-goals.** No wire change and no relay deploy. No tombstone pruning (§5 says why it does not
need one). A delete applied from a peer **before** this build is not recovered — nothing recorded
it. Add-wins (§7.3) is unchanged: a concurrent edit still resurrects a deleted row. A v52 peer
keeps both bugs until it upgrades. The page order (parents first) is unchanged — §3.4 says why the
obvious alternative is wrong.

## 3. Design

### 3.1 Tombstones: `sync_gone`

A user-side table, not synced, one row per deleted row of a table other rows are filed under:

```sql
CREATE TABLE sync_gone (
    tbl TEXT NOT NULL,
    uid TEXT NOT NULL,
    PRIMARY KEY (tbl, uid)
) WITHOUT ROWID;
```

- **Written by a trigger and by nothing else.** `capture::install` adds, for every table a capture
  spec names as a parent (`apply::is_a_parent`'s question, read off `capture::TABLES` — today
  `deck_folders`, `decks`, `deck_categories`, `deck_labels`, `deck_notes`, `collection_folders`,
  `wishlist_folders`), an `AFTER DELETE` trigger:
  `INSERT OR IGNORE INTO sync_gone (tbl, uid) VALUES ('<t>', OLD.sync_uid)`, gated on
  `OLD.sync_uid IS NOT NULL` and **on nothing else** — not on the `applying` guard, not on the
  device being in a group. That is the point of it: an own delete, a delete applied from a peer, a
  moot delete and every cascade they set off all land here, and no command has to remember to
  record anything. Dropped and recreated at every open with the capture triggers, for their
  reason.
- **`gone` reads it** in place of `sync_ops`: the page's delete set first, then
  `SELECT 1 FROM sync_gone WHERE tbl = ?1 AND uid = ?2`. One source, so an own delete and an
  applied one are asked the same way.
- **The rung (user schema v54; written as v53) backfills it** from this device's own history:
  `INSERT OR IGNORE INTO sync_gone SELECT DISTINCT tbl, uid FROM sync_ops WHERE kind = 'del' AND
  tbl IN (<the seven, frozen in the rung>)`, so every delete `gone` could see yesterday it still
  sees. Deletes applied from peers before the upgrade left no row anywhere and are not recovered.
- **A delete of a row this device never held tombstones too** *(amended 2026-09-27, at Task D)*:
  a parent created and deleted on a third device between two of this device's pulls arrives as a
  put and a `del` folding to deleted, writes no row and so fires no trigger — `write_group`'s delete
  arm records the tombstone itself where the table is a parent and no local row was found, or a
  child of it on a later page would wait out the bound.
- **Nothing clears it.** Leaving a group keeps it, as it keeps `sync_ops`; a resurrected parent
  is found by `resolve_parent` before `gone` is ever asked, so a stale tombstone is never read.
- **A new user table owes its sites** (sync.md's list): `USER_SCHEMA_SQL` and `UNDO_V54`,
  `schema::TABLES` as `Side::User`, `mirror::watch::surface_of` (→ `None`, and its decided-about
  list), `changes::WRITTEN_BY_THE_APP` (it is `WITHOUT ROWID`, so the update hook never sees it,
  and the app writes it where no press does — `sync_peers`' footing), `src/lib/userTables.json`
  and `crossWindow.ts`' `TABLE_KEYS` (`sync_gone: []`). Not `SYNCED_TABLES`, no capture spec, no
  `sync_uid`.

### 3.2 A moot delete reaches folders again

`cascade_onto_the_row_here` drops its `is_a_parent` exclusion. It was there only because the
delete was uncaptured and so invisible to `gone`; §3.1 makes every delete visible. In the moved
folder case A now deletes X, as B's cascade did, and a tombstone for X lands on both devices — so
whatever either device files into X afterwards is written at the root (a deck, a copy, a wish:
`SET NULL`) or dropped with it (a sub-folder, a pile: `CASCADE`) on both. The placement check is
unchanged: the row goes only where the group's placement under the deleted parent is the one that
stands. The delete itself goes through §3.3.

### 3.3 A delete that would clear rows waits for the second attempt, then re-homes them

*(As approved this section waited only on a collision; the amendment in the bullet "Every delete
that would clear rows waits" below widened it to any non-empty doomed set. Steps 1–2 stand; step 3
and the first bullet are the record of the narrower rule.)*

Every `DELETE` `apply` issues — `write_group`'s delete arm and the moot delete — first asks
**whether it would clear rows out of a folder** (as approved: *whether it would drop two rows onto
one grain*):

1. **The doomed folders** of the row being deleted: a `collection_folders` or `wishlist_folders`
   row and its sub-tree (`parent_id`); a `decks` row's `collection_folders` with that `deck_id`,
   and their sub-trees. Any other table dooms none. A test reads every `ON DELETE CASCADE` key into
   the two folder tables off the live schema and fails when one is not covered here — three today.
2. **The doomed rows**: the copies and wishes filed directly in those folders.
3. **A collision**: a doomed row whose grain with its folder cleared matches a root row, or two
   doomed rows that match each other.

- **First attempt, a collision → `Outcome::Deferred(Why::Occupied)`**, and nothing is written.
  The group joins `run_groups`' `failed` list and is tried again after every other group in the
  page — so the sender's own re-filing, which is rank 7 and sealed before its delete, has landed.
  `Occupied` is never classified: only the second attempt's reason is kept.
- **Second attempt → re-home, then delete.** Each doomed row still in a doomed folder, in `id`
  order, is re-filed onto the root through the crate's own merge — `collection_folders::refile_entry`
  and `wishlist_folders::refile_wish` with no folder, which fold onto a twin (counters summed,
  provenance coalesced) or clear the folder. Where a fold happened, **the survivor takes the lower
  of the two `sync_uid`s**, set after the source is gone. Then the `DELETE`, whose `SET NULL` has
  nothing left to act on.
- **Why the lower uid.** A row re-homed here is one the page did not mention — filed here
  concurrently, or by a third device. Its own put reaches the sender with its folder gone
  (tombstoned there by the sender's own delete), so the sender writes it without the folder and
  `find_row`'s grain match lands it on the same twin, adopting `min`. Both devices hold one row,
  one count, one uid.
- **Why wait rather than merge at once.** Merging on the first attempt would fold a copy the
  sender has itself just merged onto the root, and the sender's own `+n` for the twin would then
  add it a second time.
- **Every delete that would clear rows waits, not only a colliding one** *(amended 2026-09-27, at
  Task B's review; the approved text deferred only on a collision)*. Only on a collision left two
  losses: a sender that makes a new root copy and then deletes a binder whose copy folds into it
  sends the peer a delete that does not collide yet (the root copy has not landed) — the copy is
  re-homed, the new copy's insert grain-matches it, and the counts part; and a folder deleted and
  re-made at the same grain in one page lost the re-made row where its delete waited
  (`reset::clear_collection` re-makes `Recently removed` and every deck group in one write — an
  ordinary press, not a corner). So a delete whose doomed set is non-empty waits for the retry, and
  **a grain match onto a row this page deletes adopts the incoming uid rather than `min`**
  (`find_row`): the sender retired the old uid, so the re-made row keeps the new one, and the
  retried delete finds nothing to take. **And a group whose own ops end in a delete finds its row
  by uid alone, never by grain** (amended again at the scoped re-review, and narrowed from "whose
  uid the page deletes" so that a row deleted and put back in one page — add-wins — still meets its
  twin): the sender made and discarded that row, so its delete can only take a row wearing its own
  uid — without the rule, a
  collection cleared twice between two pulls (or a deck toggled Virtual on, off, on, off) had its
  middle folder grain-match the one re-made after it and delete it, and a copy made and removed on
  the sender deleted a local twin the peer had made on its own.
- **The backstop.** Every `DELETE` `apply` issues runs inside the group's savepoint, and a refusal
  rolls it back and becomes `Why::Unbuildable(<the constraint's words>)` — dropped and recorded,
  or held where the sender is newer — never `?`. The moot delete already did this; the ordinary
  delete arm gains it. A refused delete leaves a folder on one device, which is recorded and
  visible; a stalled sync is neither.

All of it runs inside `apply`'s `capture::suppressed`: every device derives the same re-homing
from the same delete.

- **Every decision that rests on `gone` is made on a retry pass** *(amended 2026-09-27 at Task C's
  fix rounds)* — the moot arm and the `SET NULL` "written without that parent" arm alike. A
  same-page add-wins resurrection of the parent lands on the first pass, so the retry resolves the
  parent normally; decided on the first attempt, a held folder was deleted that a sparse move could
  not rebuild, and a copy was filed at the root the sender kept in its binder. The first attempt
  answers `Why::DecidedOnRetry` (the name `Occupied` had at approval), which the clearing-delete wait
  shares.
- **The retry is a bounded fixed-point loop** *(amended at the same review)*: groups still failing
  are retried in page order while the previous pass made progress (a group written or decided moot),
  capped at the group count, and only each group's last answer is classified. One pass met a folder
  moved into a new folder created under a deleted parent before the new folder was decided, held it,
  and dropped it at the bound. **A gone-based decision is taken only on a pass that follows one on
  which nothing else landed** (amended at the fourth fix round): the group that resurrects a parent
  can itself land only on a retry pass — a parent renamed and moved into a folder made later in the
  page — and a decision taken before it deleted a folder the sender keeps. Withheld decisions are
  taken on the next pass that lands nothing, and the loop continues; the cap is twice the group count
  plus one.

### 3.4 Why not "apply deletes last"

Moving every delete after every put would fix §1.1's ordering in one line, and it is wrong: a row
deleted and re-added at the same grain between two pulls — a card stepped to 0 and added again, a
pile deleted and re-made under its old name — would see the put land first, grain-match the row
the delete is about to take, and either sum the two or delete the survivor. Stamp order within a
table is what gets that right, so the order stays, and only a delete that would otherwise fail
waits.

### 3.5 What is left

- ~~A folder deleted and re-made at the same grain in one page loses the re-made row~~ — closed by
  §3.3's amendment (the incoming uid wins a grain match onto a row the page deletes).
- **A row the peer filed concurrently into a folder the sender re-made follows the rename there and
  lands at the root on the sender** (its folder is a delete on the sender, and the key is
  `SET NULL`). Counts and identity converge; placement does not. Read off the code at the scoped
  re-review, unmeasured.
- **A copy re-homed onto a twin the sender never had can leave one `error_log` row describing no
  fault**: the sender's own later move of it names the uid that lost the fold, finds no row, and is
  skipped. Counts and identity still converge (the sender adopts the twin's uid when the twin's put
  reaches it). Read off the code and unmeasured.
- **Provenance can differ after a concurrent merge.** The re-homing coalesces the survivor's price,
  date, source and notes over the source's; the sender's grain match takes each field by
  last-writer-wins. Counts and identity converge; a field both rows carried may not.
- **A sparse edit under the losing uid, on a later page, is still skipped** — `find_row`'s
  existing behaviour after any grain merge, not new here.

### 3.6 For whatever files into a folder next

PR 3 is dropped, so nothing renumbers. What it would have met is general and stays true for any
future folder the app makes and deletes: a folder deleted on a peer re-homes its leftover copies
to the **root**, as `SET NULL` does, and a sweep that files them somewhere else afterwards must be
a derived write (behind `capture::suppressed`, like `reconcile`), or both devices sweep the same
copy and the destination counts it twice.

### 3.7 Docs

`docs/reference/sync.md`: *Held while it can resolve, skipped when it cannot* (the moot row now
reaches folders; `gone` reads `sync_gone`; the two ⚠️ paragraphs about the moved folder become the
record of the fix), *A parent deleted on a third device* (closed), *What is still owed* (both
folder bullets removed, §3.5's residuals added). `src-tauri/CLAUDE.md`'s `sync_peers` bullet (the
moot delete's "no capture spec names its table as a parent" clause) and the rung history.
`data-and-sync.md`'s ladder. `apply.rs`'s module doc and `gone`'s doc. The token-stacks spec's
§5 gets a one-line note that PR 3 was dropped and its number went elsewhere (`sync_gone` took
v53, and was renumbered to v54 at the merge when the per-list piles took 53 on `main`).

## 4. Testing

Rust, in `sync_engine/apply/tests.rs` and `schema.rs`, each red against today's code where it
describes a bug:

- **The stall, three ways**: a binder holding a copy the root also holds, deleted through
  `delete_folder` on A and applied on B — B's apply succeeds, B's root row holds the sum, the
  folder is gone, one row per grain; the same for a wishlist folder; the same for a deck deleted
  through `delete_deck` whose group holds a copy the root holds.
- **A concurrent copy**: B files a copy into the binder A deletes, onto a grain B's root holds;
  after both exchanges both devices hold one row with the same count and the same `sync_uid`.
- **Two doomed copies onto each other**: a folder whose two sub-folders each hold one copy of a
  printing, deleted on A — B's apply merges them onto one root row.
- **The moved folder, both cabinets**: A deletes P; B moves X under P and then files a deck (and,
  separately, a copy) into X; A, before hearing of the move, files a second deck (a second copy)
  into X. After the exchange neither device holds P or X, and every deck and copy is at the root
  on both. These are #574's two `…survives_on_both` tests, extended: they keep asserting what
  survives, and gain that X is gone on both and where the survivors are.
- **A third device's delete**: C deletes a binder; B applies it on one pull; A's copy filed into
  that binder reaches B on a later pull and lands at the root at once, with no hold and no
  `error_log` row.
- **Tombstones**: an own delete, an applied delete and a cascaded one each write their row; a
  device with no group writes one too; `gone` answers from `sync_gone` alone.
- **The backfill**: a v53 database whose `sync_ops` holds `del`s for a deck and a binder climbs to
  v54 with both tombstoned and nothing else.
- **The backstop**: a TEMP trigger refusing a folder delete during apply — the group is dropped and
  recorded, the rest of the page applies, the next pull does not fail.
- **The cascade fence**: every `ON DELETE CASCADE` key into `collection_folders` and
  `wishlist_folders` on the live schema is one §3.3 covers.
- **Order kept**: a card stepped to 0 and re-added in one page ends at the re-added count (pins
  §3.4 against a future "deletes last").

## 5. What it costs

One user table and one rung. A trigger per parent table, one `INSERT` per deleted parent row —
a deck delete writes its deck, its piles, its notes and its group folder, a handful of rows, and
nothing else ever writes there, so the table grows with deletes of *parents* and needs no pruning.
`gone` is one primary-key read. A collision check per apply-side delete of a folder or deck: one
indexed read of the doomed rows, rare by construction. No wire change, no relay change.
