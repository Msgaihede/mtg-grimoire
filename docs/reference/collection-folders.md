# The collection's folders, and the eleventh term of its grain

Schema v24, [issue #215](https://github.com/Msgaihede/mtg-grimoire/issues/215). The design is
[2026-08-23-collection-folders-design.md](../superpowers/specs/2026-08-23-collection-folders-design.md);
this page is the record of what shipped, with the reason at each site. Every figure keeps the date
and the build it was taken on.

The short version: a collection row is filed in exactly one place, `NULL` is the root and is where
every row lands unless the reader says otherwise, and **the folder is part of what makes two rows
the same row**. That last clause is the load-bearing one and everything else on this page is a
consequence of it.

**This is the wishlist's cabinet one table over** — [wishlist-folders.md](wishlist-folders.md) is
the page it is a port of, and where a rule here is that page's rule, it is named rather than
re-argued. What the collection has that the wishlist does not is a folder that can belong to the
**app** rather than to the reader, and a grain that was already ten columns wide before a folder
joined it.

## The rung is split, and the split is the deviation worth knowing

Spec §3 lists **one** v24 rung doing everything: create the folder table, widen the grain, insert
the `Recently removed` folder and one folder per deck, convert every `deck_allocations` row into a
placement, then drop `deck_allocations` and `decks.is_built`. **That rung could not ship here**,
because the shipped PR keeps the allocator working and the PR after it is what removes it. A rung
that dropped `deck_allocations` at v24 would take out the app's only source of owned/missing while
nothing had yet replaced it.

| Rung | Does |
| --- | --- |
| **v24** (this page) | Creates `collection_folders` **in its full final shape**, `kind` and `deck_id` columns and both partial unique indexes included. Adds `collection_entries.folder_id`. Rebuilds `idx_collection_grain` with the eleventh term. Deletes zero-quantity rows. **Files nothing** — every existing row stays at the root, which is where it already was. |
| **v25** (the next PR) | Inserts the single `removed` folder and one `deck` folder per deck, converts every allocation into a placement, then drops `deck_allocations`, `decks.is_built` and the orphaned `app_meta` row `deck_driven_collection`. |

**Creating `kind` and `deck_id` at v24 rather than v25 is deliberate.** They are plain columns with
no rows using them yet, and adding them now means v25 needs no `ALTER TABLE` at all — it only
inserts, backfills and drops. Both partial indexes are created here for the same reason. The cost,
if that judgement is wrong, is two columns and two indexes nothing writes for one release, which
is invisible to the reader and cheap to carry.

The consequence a reader of the code has to hold: **`collection_folders.kind` is `'user'` on every
row this release can produce.** Nothing in `collection_folders.rs` creates a `deck` or a `removed`
folder. Every write in it nevertheless already refuses to touch one — see
[the three refusals](#the-three-refusals-are-sentences-not-constraint-failures) — because a fence
written after the thing it fences is a fence somebody has to remember to add.

## The table, and the three `ON DELETE` actions

```sql
CREATE TABLE IF NOT EXISTS collection_folders (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES collection_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'user'
        CHECK (kind IN ('user','deck','removed')),
    deck_id INTEGER REFERENCES decks(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'deck') = (deck_id IS NOT NULL))
);
ALTER TABLE collection_entries ADD COLUMN folder_id INTEGER
    REFERENCES collection_folders(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_folder_removed
    ON collection_folders(kind) WHERE kind = 'removed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_folder_deck
    ON collection_folders(deck_id) WHERE deck_id IS NOT NULL;
```

**Two of the actions point opposite ways, and both are chosen rather than inherited.**

- `collection_folders.parent_id` is **CASCADE**, onto its own table. A folder inside a deleted
  folder has nowhere else to be, so the whole sub-tree goes in one press. This is also why the
  cycle refusal below is not cosmetic: a cycle is a graph SQLite's recursive cascade would walk
  forever the day one of the folders in it is deleted.
- `collection_entries.folder_id` is **SET NULL**. A folder is a *filing decision*; the cards are
  the reader's **property**, and the two are not the same thing to lose. Deleting a drawer
  surfaces the copies in it at the root — where they were before anybody filed them — rather than
  throwing away what the reader owns. This is the strongest of the three SET NULLs in the schema
  for exactly that reason: a deck is work and a wish is a shopping list, but a collection row is a
  card that physically exists.

**This pair is the deck gallery's pair verbatim, and the wishlist's verbatim, and the symmetry is
the decision rather than a coincidence** — `collection_folders.parent_id` is
`deck_folders.parent_id`, and `collection_entries.folder_id` is `decks.folder_id`. "Folders nest,
and the things filed in them outlive the filing" is a rule this schema has now made **three
times**. `schema.rs`'s module doc carries the whole-schema inventory of both lists and is the copy
of record; `decks-storage.md` carries the deck slice and `wishlist-folders.md` the wishlist's. A
rung that adds one half of a new filing cabinet and forgets the other is exactly what those
inventories exist to catch, since a prose-only edit routes to neither CI job.

**The third action is this cabinet's own, and it points the other way on purpose.**
`collection_folders.deck_id` is **CASCADE**, not SET NULL — and it is the one key the other two
cabinets have no equivalent of. A folder that *stands for* a deck has no meaning once that deck is
gone, so the row goes with it. That is the opposite of what the folder's **contents** get, and the
two rules living in one table is why the contents are re-filed by hand before any cascade can
fire (see [the delete](#delete_folder-re-files-one-row-at-a-time)).

Nesting was ported rather than flattened for a cost reason, not an aspirational one: the tree
arithmetic, the cycle refusal and both cascade rules were already written and tested one table
over, so nesting was cheaper than writing a flat version would have been. `src/lib/folderTree.ts`
is reused **unchanged** — a `CollectionFolder` already answers `FolderLike` and a `CollectionRow`
already answers `Filed`. Nothing new is named `folderTree.ts`: a case-insensitive filesystem
resolves a second one against `FolderTree.tsx`, and `tsc` stays green while every test fails with
"not a function" (`src/features/decks/folders.ts:17-30`).

### The v24 step's four traps

Recorded because each is a way the migration could have been silently wrong, and none of the first
three would have raised anything:

1. **`idx_collection_grain` is rebuilt, not added to.** SQLite has no `ALTER INDEX`, and the
   `DROP` has to come first or the `CREATE` is a silent no-op on exactly the machines that already
   carry the ten-column index — the ones that matter. The `IF EXISTS` is for a fixture that took
   it away.
2. **`ADD COLUMN` has no `IF NOT EXISTS`, on either half of `ALTER TABLE`.** The step probes
   `pragma_table_info('collection_entries')` first, because the shared rewind above it *cannot* be
   complete: `UNDO_V24` drops the folder table and leaves `folder_id` standing. SQLite would in
   fact permit the `DROP COLUMN` once both indexes naming it were dropped — what a *shared* rewind
   may not do is the statement after that, since putting the ten-column index back means building
   a **narrower** unique index over rows written on the wide grain, which is a constraint failure
   the moment two of them differ only by folder, inside somebody else's fixture. So every fixture
   beneath head re-enters this step carrying the column, and a blind `ALTER` would answer
   `duplicate column name` — a failure no real upgrade can produce, which is the definition of a
   fixture lying about what it is testing. `schema_at_23`, which is the one fixture that goes on
   to *write* entries, pays the full rewind instead: the two indexes, then the column, then the
   table, then the ten-column index rebuilt as a literal.
3. **No backfill, and the absence is the design.** `folder_id` arrives NULL on every existing row,
   NULL is the root, and the root is the table the reader already sees — so an upgrade is
   invisible until they make their first folder. The unset value is not a lie a `DEFAULT` is
   telling; it is the answer. The widening is safe over existing rows for the same reason:
   `coalesce(folder_id, 0)` is the constant 0 across the whole carried-over table, so the new key
   is the old key plus a constant and is strictly *more* permissive than the one it replaces — two
   rows that clash on eleven terms clashed on ten, and the old index would already have refused
   them.
4. **`DELETE FROM collection_entries WHERE quantity = 0` is the one statement here that is not
   additive**, and it is the rung paying for a state that stops being reachable. See
   [zero quantity](#zero-quantity-deletes-the-row-and-what-that-costs).

The DDL is **spelled out literally and never interpolated from `COLLECTION_GRAIN` or
`COLLECTION_FOLDER_KINDS`**, the rule the v4, v8 and v23 steps all state: a migration step is
history, and a step that read the constant would silently rewrite what a *fresh* install creates
the next time the grain moves while every already-upgraded database kept the old shape — with the
two then disagreeing about what makes two rows the same row, and nothing anywhere going red.

## The eleventh term, and why it is load-bearing

```rust
pub const COLLECTION_GRAIN: &str = "card_id, finish, condition, lang, altered, signed, proxy, \
     misprint, coalesce(serial_number, ''), coalesce(grading, ''), coalesce(folder_id, 0)";
```

The first ten terms are unchanged and are argued where they always were — `grading` enters
identity as **raw text**, so it is only ever written through the one fixed-field struct that owns
its key order. The eleventh is v24's, and it is v23's fourth-term reasoning applied one table over.

**Without it, filing a card into a folder would not be a filing at all.** The write would land on
the row the reader already had and simply raise its quantity — so their binder copy would appear
to **move**, out of wherever it was and into the folder being pointed at, and a filing decision
made last week would be undone by an add made today. A playset would collapse into whichever
folder was pointed at last. With the term, the same printing in two folders is two rows, moving
copies between them is a separate and explicit act (`collection_set_folder`), and "Add to
&lt;binder&gt;" is always an **add**.

`coalesce(folder_id, 0)` rather than the bare column, because **NULLs in a UNIQUE index are
distinct**. An un-coalesced term would stop enforcing anything for exactly the rows that need it
most: the ones at the root, where most cards live. That is the same device the grain's ninth and
tenth terms already use, for the same reason.

**It can never collide with a real folder**, because `collection_folders.id` is `INTEGER PRIMARY
KEY` and SQLite never *auto-assigns* rowid 0. The guarantee is narrower than it looks — SQLite will
happily store an explicit 0 — so `create_folder` never supplies an id and lets the database
assign. A folder numbered 0 would be indistinguishable from the root on the grain, and every card
in it would collide with the reader's unfiled copies of the same printing. Letting the database
assign is the whole of the fence.

### Every collision probe in the crate owes the eleventh term, and the reconciler's is the easy one to miss

`reconcile::collision_target` is the one probe that is not on a folder path at all: it runs after a
Scryfall migration repoints a row onto a new printing, and it asks "what row is already there?"
It spelled **ten** terms until v24, which was exact then and is a cross-folder fold now — the sweep
would sum the reader's filed copies into a binder they were never in, delete the row that *was*
there, and leave the row that actually blocked the repoint standing. A filing decision undone by an
upstream tidy-up, with nothing red and nothing in `error_log`.

`a_repointed_entry_folds_only_onto_an_entry_in_its_own_folder` is what fails if anyone narrows it
back, and `fold_wish_into_existing`'s own probe — which has spelled `coalesce(folder_id, 0)` since
v23 — is the same argument one table over, where the stake is a shopping list rather than cards
that physically exist.

**The rule, for the next term anybody adds to either grain:** a grain is not one constant, it is a
constant *and* every hand-spelled probe that compares against it. `COLLECTION_GRAIN` is deliberately
never interpolated into any of them — a probe compares a list of expressions over one row against
that many **bound values**, which is a different statement — so widening the constant cannot widen
the probes, and nothing in either half goes red when they drift.

## The merge rule: a write that lands on a taken grain merges

`collection_set_folder` moves one row onto a grain another row may already hold — it changes the
eleventh term, and nothing else. The rule is written once, in `set_entry_folder`'s doc, and every
other caller reaches it through the same function:

> **A write that lands on a taken grain merges, it does not fail.**

The two quantities sum into the row that was already there, the source row is deleted, and the
answer names the **destination** — whose id is not the id the caller handed in. Filing three
copies into a binder that already holds two of that printing is one row of five, which is what the
reader can see on the shelf. A `UNIQUE constraint failed` reaching them would be the app telling
them off for agreeing with it.

**`update_entry` stops refusing and merges too, and that half is not optional.** It used to answer
*"You already have an entry for that printing at that finish and condition"* and give up. With a
folder in the grain, **every** edit that moves a row into an occupied folder hits that refusal, so
the message became unreachable — and it was deleted with the branch rather than left standing,
because a message for an impossible state is the half-deleted rule this repo warns about.

`refile_entry` is the write itself, with no fence and no transaction of its own. Four details are
each a decision:

- **The source row is read before anything is decided**, because "is that entry still there?" is
  answered by the same statement. An `UPDATE` that changed no rows cannot tell a missing row apart
  from a grain collision, and the two want opposite answers.
- **The collision target is spelled out in SQL rather than interpolated from
  `COLLECTION_GRAIN`**, the reason `reconcile::collision_target` gives: that constant is a list of
  expressions over **one row**, and this compares the same list against eleven bound values. All
  eleven are in the comparison — a fold that matched on ten would merge a row into a row in
  another folder, which is precisely the bug the eleventh term exists to make impossible. At most
  one row can match, because those eleven terms *are* `idx_collection_grain`.
- **A miss is a plain `UPDATE … SET folder_id = ?`, with NULL bound as a *value***, never
  `coalesce(?, column)`. That spelling means "leave it alone" everywhere else in the crate, and
  using it here would make "back to the root" unexpressible — which is half of what the command is
  for.
- **`removed` stays `false`** over a merge that really did delete a row. The field means "the
  reader no longer has this", and here the copies are emphatically still theirs; the caller
  re-reads and selects the id it was handed.

### The fold is five statements, not two, and the reason is `deck_allocations`

`merge_entry` follows **`reconcile::fold_into_existing`'s five statements** rather than the
wishlist's two, and the difference is not stylistic. `deck_allocations.collection_entry_id` is the
only enforced foreign key pointed at a collection entry, and it is `ON DELETE CASCADE` (schema v5)
so that `remove_entry` takes a deck's reservations with the row it deletes. **A merge must
therefore leave nothing for that cascade to take**: the copies still exist and the deck still
wants them, and a folder press that quietly unbuilt a built deck would be the worst kind of
silent.

So the five are: sum the entries, fold any allocation where the destination is *already* claimed by
the same deck, delete those now-duplicate claims, repoint every remaining claim at the
destination, and only then delete the source. All three allocation statements seek through
`idx_deck_allocations_entry`, and every one of them is inside the caller's transaction — an
allocation is never briefly homeless.

`deck_allocations` is deleted by the **next** rung, so these three statements are the next PR's to
remove. Until then they are load-bearing, and a "simplification" that drops them to match the
wishlist's shape strips a built deck's claims with no test in either half failing.

**What moves in the entry fold**: the quantities and the tradelist quantities add, and the five
columns the reader typed themselves — what they paid, in what currency, when, where from, and
their note — are taken by the survivor **only where it has none**. That is `add_entry`'s
`ON CONFLICT` direction verbatim: the destination is the row the reader filed and annotated, and
inverting either `coalesce` would replace a note they wrote about the row they are keeping with
one about a row that no longer exists. `tags` and `condition_original` are deliberately absent,
exactly as they are from `add_entry`'s `DO UPDATE` — merging two curated sets is not something one
statement should decide, and `condition_original` is the provenance of *this* row's condition and
cannot describe a condition it was never written beside.

## `delete_folder` re-files one row at a time

`collection_entries.folder_id` is SET NULL, and for one press that looks like the whole answer:
one `DELETE`, every card in the sub-tree back at the root. **It is not, because that cascade
rewrites a grain term** — and a write that changes an entry's grain has to say what it will land
on. Every other write in the crate does. Left to `idx_collection_grain`, the delete reaches the
reader as `UNIQUE constraint failed`, with the folder still standing and nothing moved, in two
shapes:

- a card in the sub-tree and an **unfiled** row for the same printing at the same grain — the state
  every writer that cannot name a folder produces: a quick add from the search, an import, the
  reconciler's fold;
- **two sub-tree rows colliding with each other**, needing no root row at all. `Binder/A` and
  `Binder/B` each holding the same printing land on one grain the moment both reach the root.

So the sub-tree's entries are collected and re-filed **one at a time** through `refile_entry`, with
`set_entry_folder`'s merge rule rather than a second copy of it, inside the transaction and
**before** the folder row goes. By the time the `DELETE` runs, every card beneath it is already at
the root, so the `SET NULL` has nothing left to rewrite and nothing left to collide on.

**One at a time is what answers the second shape**, and it is the reason this is a loop rather than
one statement: the first row to reach the root becomes the row the next one merges into. A batch
update would present both to the index at once.

Three smaller decisions inside it:

- The doomed sub-tree is walked **in SQLite**, by a `WITH RECURSIVE`, because the cascade this
  stands in front of is itself recursive and the two must agree about which folders are doomed —
  **including any the app owns**. Nothing filters on `kind`, because the CASCADE does not, and a
  walk that did would leave those folders' cards to `SET NULL` and the very collision this
  function exists to answer.
- `UNION` and never `UNION ALL`. A `parent_id` cycle that arrived some other way — a hand-edited
  database, a restored backup — makes the duplicate-row check converge where `UNION ALL` would
  loop.
- `ORDER BY e.id`, so the row a merge folds into is decided by the table and not by the planner.

`parent_id`'s CASCADE onto its own table is still the DDL's work and still one statement — a folder
inside a deleted folder has nowhere else to be, and no grain is involved. **It therefore still
depends on `PRAGMA foreign_keys` being ON**, which is per-connection; `db::open` sets it for every
connection the app hands out, and a test that opens its own has to say so itself.

An id that resolves to nothing is a **success**, `deck_meta::delete_folder`'s rule: the caller
wanted that folder gone, and it is gone. The one id that is not is a folder the app owns.

## Zero quantity deletes the row, and what that costs

**This reverses a documented decision, and the reversal is recorded here rather than lost.** A
collection row taken to zero is now removed: `set_quantity(id, 0)` deletes and answers
`EntryChange { removed: true }`, the v24 rung deletes every stored zero row, and the importer's
`set` mode does the same. The reason is the folder: with `folder_id` in the grain, a row holding no
copies is indistinguishable from a row somebody filed and emptied, and "the reader owns none of
these" is not a filing decision worth keeping a slot for.

**The cost is real and was accepted deliberately.** The row's `condition`, `condition_original`,
purchase price and currency, acquired-at, acquisition source, notes and tags **go with it** — which
is precisely what the previous behaviour was preserving. The rule it replaces said so in as many
words: taking a stepper to zero was "the reader saying *I have none of these today*, not *forget
everything I recorded about them*", and the story of a card that took years to accumulate survived
the day it was traded away. It no longer does. Removal used to be `remove_entry` and only ever
`remove_entry`; it is now either.

`CHECK (quantity >= 0)` stays on the column. The guard is the command, and an intermediate zero
inside a transaction is still legal.

Two things simplify with it, and both were previously ways for the app to disagree with itself:
`summarise`'s split between `total_cards` (which sums quantity) and `unique_cards`/`entries` (which
count rows) stops being able to diverge, and the search facet's `owned` dimension — with
`collection_source::owns_printing`'s `EXISTS` — stops reading a zero row as owned.

The wishlist has been the opposite since it shipped, by table CHECK (`quantity > 0`): a wish for
none of something is not a wish. The two tables now agree, where they used to be a deliberate
asymmetry.

## `folder_summary` answers direct counts, and no row at all for an empty folder

`collection_folder_summary(marketplace)` returns `{ folderId, cards, value }` per folder, and three
things about its shape are load-bearing.

**The counts are direct — this folder's own copies, never its sub-folders'.** The tree sums the
children on the TypeScript side, in `buildFolderTree`, which already does that arithmetic for the
deck gallery and the wishlist. SQL that walked the tree here would be a second implementation of a
thing that is written and tested, and two implementations of one figure disagree the first time
either changes. The consequence a caller has to know: a folder holding two full sub-folders and
nothing of its own answers `0 cards` here, so a folder card is handed the recursive total and
never the raw row.

**A folder with nothing filed directly in it produces no row at all** — the query is
`WHERE folder_id IS NOT NULL … GROUP BY folder_id`, so an empty folder simply is not in the answer,
and the root, which is not a folder, has no tile to draw either (what is at the root is what the
unfiltered table already shows). **A page therefore cannot build its folder tree from this
command.** `collection_folder_list` is the census — flat, every kind, `ORDER BY sort_order, id` —
and the summary is a lookup layered onto it. A card whose folder has no summary row falls back to
a zeroed total and draws `0 cards`, which is correct rather than an error state: an empty drawer is
where the next card goes.

**`cards` is copies and not rows** — `sum(quantity)`, which is `CollectionSummary::total_cards`'
arithmetic. **`value` is `None` rather than `0.0`** when the marketplace prices nothing in the
folder, which is where this parts company with the page header's `coalesce(…, 0.0)`: a tile is a
small number beside a name with no room for the header's "n unpriced" note, so a folder full of
cards the feed has never heard of would otherwise read as a folder worth nothing. `None` draws an
em dash, which is this app's answer for a price it does not have.

Every figure is `collection.rs`'s own arithmetic rather than a second spelling of it: the unit
price is `sorting::price_expr` over `collection::ENTRY_FINISH` — the *entry's* finish, which is why
the entries are aliased `e` and `cards` is aliased `c`, both part of that constant's contract. A
folder's subtotal and the page header's total are one piece of arithmetic and cannot disagree. The
join is `collection::from_sql`'s, and a `LEFT JOIN` for its reason: an entry whose printing has
left the corpus is exactly what the denormalised columns exist for, and an inner join would drop
those rows out of the tile that most needs them.

`folder_summary` names `collection_entries` in its own `FROM`, which `collection_source`'s module
doc lists as something only three statements in the crate do. It is now a fourth, for
`collection::from_sql`'s reason: it reads the entries as its rows rather than asking a question
about them.

## The three refusals are sentences, not constraint failures

`deck::set_folder`'s reasoning, twice over: **a constraint failure names the table and not the
mistake**, and `PRAGMA foreign_keys` is a per-connection setting in any case. `collection_entries.
folder_id` and `collection_folders.parent_id` *are* real foreign keys between user tables, so a
write naming a folder that is gone does fail on its own — with `FOREIGN KEY constraint failed`, and
only while that pragma happens to be on.

| Refusal | Sentence | Where |
| --- | --- | --- |
| The folder is gone | `That folder is not there any more.` (`deck_meta::FOLDER_GONE`) | Every write that names a folder id |
| The move writes a loop | `A folder cannot be moved inside itself.` (`deck_meta::FOLDER_CYCLE`) | `move_folder` |
| The folder is the app's | `That folder is the app's own and is not yours to change.` (`FOLDER_NOT_YOURS`) | Every write, both ends |

The first two are borrowed from `deck_meta` rather than re-spelled — a reader who has met "That
folder is not there any more." in the deck gallery and on the wishlist must meet the same sentence
here, and `deck_meta::CATEGORY_WRONG_DECK`'s doc is the standing rule that a second copy of a
refusal is a second thing to drift.

**The third is local, because it is a fact this cabinet has and the other two do not.**
`deck_folders` and `wishlist_folders` carry no `kind` column at all, so there is no sentence in
either module to reach for. And the schema could not say it anyway: the DDL CHECKs that a `deck`
folder names a deck and that the kind is one of three, but nothing in it says who may *edit* a row,
and a CHECK that could would fire as `CHECK constraint failed: collection_folders`.

Three properties of that fence are each a decision:

- **It guards both ends of a move.** `move_folder` reads the *subject* first — a folder the app
  owns is refused whether or not the parent it was aimed at exists — and the destination second.
  That is the opposite order from `wishlist_folders::move_folder`, which checks the destination
  first and lets a missing subject fall out of `changed == 0`; that shape cannot answer
  `FOLDER_NOT_YOURS`, because it never reads the row.
- **Nothing may be filed *into* a `deck` or `removed` folder by hand.** `create_folder` refuses a
  parent that is one, and `set_entry_folder` refuses a destination that is one. Those two folders
  say something the *app* is responsible for — that a deck holds these copies, that these copies
  have left the collection — and a reader dragging a card into one would be asserting it without
  any of the writes that make it true.
- **`refile_entry` carries no such fence**, and the absence is deliberate: it is what lets the next
  PR's deck-driven writes file into exactly those two folders. The fence belongs to the *command*,
  not to the write.

The cycle walk climbs `parent_id` from the **proposed** parent and is bounded at
`MAX_FOLDER_DEPTH` (64). **The budget is not about depth.** This walk is what keeps the tree
acyclic, so it cannot assume it already is — a cycle that arrived some other way would send the
`candidate == id` arm past every folder in the loop forever, because none of them is the folder
being moved. It matters more here than in a page-level check: this runs inside `spawn_blocking`
**while holding the app-wide write lock**, so an unbounded climb would not hang one command, it
would deadlock every write in the app for the life of the process. Exceeding the budget is answered
as a cycle, which is the only thing a chain that long can be.

The cycle walk cannot stand in for either kind check, either: `optional()?.flatten()` folds "no
such folder" and "that folder is at the root" into one `None`, so the climb ends on the first hop
and an id nothing answers to would sail through.

## The page, and the drag payload's own key

The collection page is the wishlist's page ported, and the pieces it reuses are named in
[wishlist-folders.md](wishlist-folders.md) rather than re-argued: folder cards in the grid, a
breadcrumb whose **segments are also drop targets** (without them a drag could only ever push cards
deeper, never back out), `DROP_RING` on every eligible folder the moment a row leaves its tile and
`DROP_OVER` on the one under the pointer, and `DROP_MARK_ROOM` on the wall's scroller so a card
flush against the content edge does not lose the outer 2 px of its ring for the whole drag.

Three things are this page's own:

**A collection drag answers under its own key**, `collectionSource`, never `dnd.ts`'s `dragSource`.
A collection row genuinely *is* both things — a card you can put in a deck, and a row you can file
— and both have to keep working from one tile. `deckDrag.ts`'s precedent is a different value under
the *same* key, which is right for decks because a deck is never a card, and wrong here: sharing
the key would force this module's mark onto the card payload, `dnd.ts`'s reader would see only
whichever mark won, and the other reader would be lied to. `wishDrag.ts` made the same call one
list over. The payload's three fields are read one by one rather than cast — this is the app's edge
with the drag library's untyped store, and "it type-checked" means nothing there — and `folderId`
is on it so a target can refuse **before** the drop: the folder a row already sits in draws no ring
at all, rather than a ring leading to a write that moves nothing and bumps `updated_at`.

**A folder move is not optimistic**, and that is a bug not repeated rather than a preference. The
wishlist shipped with `setFolder` removing the row optimistically from every cached list page and
then invalidating only the folder summary and the card search — so nothing ever put it back where
it went, the folder card read `1 wish` while the folder's own contents read "Nothing filed here
yet", and it cleared only on reload. A folder move is one deliberate press, not a held stepper, and
an optimistic insert would have to guess the destination's sort position and page. Invalidate and
re-read — and invalidate the **list itself**, not only its root: `src/lib/query.ts` caches 30 s, so
a mounted query that is merely marked stale never refetches.

**The pinned section for deck groups and `Recently removed` renders nothing in this release**,
because v25 is what creates those folders. An empty heading over an empty flat list is a promise
the page cannot keep yet.

The card menu's `buildCollectionTargetItems` mirrors `buildWishlistTargetItems` including both of
its rules, which differ from the deck picker's: **root first and never omitted**, and **a leaf
folder is a plain action while a folder with children is a submenu whose first item is itself** —
so a parent folder is always pickable. Empty folders are **kept**, the opposite of `deckLevel`,
which drops a folder with no deck under it: an empty drawer is where the next card goes. Deck
groups and `Recently removed` are filtered out (`kind === "user"`), because copies reach those only
through the next PR's two writes. `Move to → folder` for a collection row calls
`collection_set_folder`, the same command the drag writes through, so a drag and a menu press merge
on a taken grain identically — and the menu exists because a drag-only affordance is half a
feature, and it is the half a keyboard cannot use. **One command and, since the review of this
branch, one mutation**: `useSetCollectionFolder` in `src/features/collection/useCollectionFolders.ts`
owns the write and the keys it settles, and the two callers pass in nothing but what they do about a
refusal (the page's banner, the menu's `CardMenuRefusal`). They were two mutations for a day and had
already drifted — the menu's settled `["decks"]` and the drag's did not, so one gesture left a built
deck's claims stale or fresh depending on which hand made it.

## The importer's fold, and what it was

`import-export.md` described the collection importer's fold as **latent, not live**: it folded on
`(cardId, finish, condition)` while the storage grain was ten columns, and `commit_import`
hard-coded altered/signed/proxy/misprint/serial/grading to their defaults, so a re-import could
never land on the reader's altered or graded row and wrote a **second, all-defaults entry beside
it**. It was latent only because no shipped surface let a reader set any of the six.

**A folder in the grain is what would have made it live**, and it was fixed here rather than left
for the surface that would trip it. Once an import can land in a deck's group, it targets a grain
the reader's own filed row does not hold and the same second-row-beside-it failure follows without
anybody ever ticking "Altered". So the fold key became every grain term the importer can vary —
nine of the eleven — and `commit_import` carries the six flag columns rather than defaulting them.
See [import-export.md](import-export.md), where the section records the fix and its date.

**The two terms the fold key omits, it omits exactly.** `lang` is a function of `card_id`
(`add_entry` copies it off `cards` at write time and never takes it from the file), and `folder_id`
is always the root — the importer cannot name a folder, because an imported file says nothing about
this reader's filing. That is the wishlist importer's decision made again. Neither term can
separate two items the other nine fold together.

## The wipe

`reset::clear_collection` empties `collection_entries` **and then** `collection_folders`, and needs
the second statement rather than getting it by cascade: `collection_entries.folder_id` is SET NULL,
so a wipe that stopped at the entries would hand the reader an empty filing cabinet to take apart
one drawer at a time. The returned count stays the count of **cards** deleted, which is what the
reader is being told about.

## What driving the shipped window found

One CDP pass over `3036e18`, on **Windows**, `tauri dev` (**debug**), at 1920×1080, against a
worktree database carrying the full 116,700-card corpus. Every claim below was read out of the
running window or out of SQLite beside it, not derived.

**The lead finding is the one this section exists for, and the suite could not see it.** Stepping
a one-copy row to zero deleted it in SQLite and **left it on screen as a ghost** — the header read
`Cards 0` beside a list still showing the row, and pressing `+` on it answered "that row is gone".
`setQuantity`'s handler ignored `change.removed`, and `settle()` deliberately skips re-reading the
list, so nothing ever took the row away. It is the reversal of §"Zero deletes the row" biting at
the one place that did not follow it.

**The unit tests could not have caught it, and that is the part worth remembering.**
`CollectionPage.test.tsx` mocked `{ quantity: 0, removed: false }` — *a response the backend has
been unable to produce since v24*. A mock that encodes a state the system no longer has is not a
weak test, it is a test asserting the opposite of the truth, and it will stay green forever. The
fix reads `change.removed` and drops the row; `ZeroDeletesTheRow` in `CollectionPage.stories.tsx`
now pins it against the fake, where the mock cannot lie.

**Everything else measured clean, first time:**

| Checked | Read back |
| --- | --- |
| `+ New folder` → `Create folder` | `Binder A folder, 0 cards` |
| `Add to → Collection → Nonfoil → Binder A` | `collection_entries.folder_id = 1`, **not** the root — the nested add of [#215](https://github.com/Msgaihede/mtg-grimoire/issues/215) working end to end, menu → ipc → Rust → SQLite |
| The folder card after that add | `Binder A folder, 1 card, $0.32` — `folder_summary` live |
| The row's trailing cell | `Binder A` (the `Actions` → `Folder` column) |
| Stepping to zero, after the fix | row leaves the list, header `0`, folder card back to `0 cards`, no `role="alert"` |
| The delete confirmation | *"Delete "Binder A"? Its cards move back to your collection; folders inside it are deleted."* — **both halves said out loud**, which is the whole point: "and everything in it" would be wrong about the half that matters |
| After confirming | `collection_folders` empty, and the card **survives at `folder_id = NULL`** — SET NULL doing its job |

**The finish branch composes above the folder branch, as designed** — `Add to → Collection` is a
submenu of finishes, and each finish is itself a submenu of `Collection` (the root, first) then the
folders. Three levels for a two-finish card, which is the cost of not asking two questions at once.

Three harness facts, two inherited and one new. The collection page is a **div/grid table**, so
query `[role=row]` and `[role=gridcell]`, never `tbody tr` — `document.querySelectorAll('table')`
answers `0` on a page plainly showing one. `cdp.mjs` has no right-click, so a synthetic
`MouseEvent('contextmenu', { bubbles, clientX, clientY, button: 2 })` on `[data-grid-index]` opens
the card menu, and each submenu needs `pointerenter` + `mouseover` + `focus()` + `click()`
together. **New: the folder-name field is controlled, so assigning `.value` writes a character
React never sees** — go through
`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` and then dispatch
`input`, or `Create folder` stays disabled over a box that visibly contains a name.

## Deliberately out of scope

- **Deck groups and `Recently removed`.** They are the next PR's, at schema **v25** — the columns
  and both partial indexes exist here, and nothing writes them. Until then
  `collection_folders.kind` is `'user'` on every row the app can produce.
- **Folders in import and export.** The seven formats carry cards, and a folder is not one — see
  [import-export.md](import-export.md), where the same decision is recorded beside the formats.
  This is `wishlist-folders.md`'s decision made again, deliberately and for the same reason.
- **The deck builder's two search tabs and the import "add cards to collection" toggle**
  (spec §7.2 and §7.4). They belong to the PR after the groups exist, because both of them file
  into a deck's group.
- **Per-folder price summaries beyond `folder_summary`'s two numbers**, and any change to the
  wishlist's own folders. Both are spec §2's "out", and neither is a thing this cabinet needs to
  work.

## Where the code is

| Path | What is in it |
| --- | --- |
| `src-tauri/src/schema.rs` | The v24 step, `COLLECTION_GRAIN`, `COLLECTION_FOLDER_KINDS`, `UNDO_V24`, `schema_at_23`, and the whole-schema `ON DELETE` inventory |
| `src-tauri/src/collection_folders.rs` | The seven commands, `set_entry_folder`, `refile_entry`, `merge_entry`, `folder_summary`, `FOLDER_NOT_YOURS` |
| `src-tauri/src/collection.rs` | The grain's other ten terms, `set_quantity`'s zero-delete, `update_entry`'s merge, `EntryChange`, `ENTRY_FINISH` |
| `src-tauri/src/reset.rs` | `clear_collection` — entries, then folders |
| `src-tauri/src/reconcile.rs` | `fold_into_existing` — the five statements `merge_entry` follows — and `collision_target`, the crate's other eleven-term probe |
| `src/lib/folderTree.ts` | `buildFolderTree` and friends, shared with the deck gallery and the wishlist, **unchanged** |
| `src/features/collection/collectionDrag.ts` | The payload under its own key, the tile that offers it, the targets that take it |
| `src/features/collection/CollectionFolderCard.tsx` | The tile, and its stories beside it |
| `src/features/card/cardMenu.tsx` | `buildCollectionTargetItems` — `Add to → Collection`, and `Move to → folder` |
| `src/features/transfer/import/destinations/collection.ts` | `grainKey` — the importer's fold, now every grain term it can vary |
