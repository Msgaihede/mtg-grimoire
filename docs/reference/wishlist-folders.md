# The wishlist's folders, and the printing a wish is for

Schema v23, [issue #165](https://github.com/Msgaihede/mtg-grimoire/issues/165). The design is
[2026-08-22-wishlist-folders-design.md](../superpowers/specs/2026-08-22-wishlist-folders-design.md);
this page is the record of what shipped, with the reason at each site. Every figure keeps the date
and the build it was taken on.

The short version: a wish is filed in exactly one place, `NULL` is the root and is where every
wish lands unless the reader says otherwise, and **the folder is part of what makes two wishes the
same wish**. That last clause is the load-bearing one and everything else on this page is a
consequence of it.

## The two tables, and the two `ON DELETE` actions

```sql
CREATE TABLE IF NOT EXISTS wishlist_folders (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES wishlist_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
ALTER TABLE wishlist_entries ADD COLUMN folder_id INTEGER
    REFERENCES wishlist_folders(id) ON DELETE SET NULL;
```

**The two actions point opposite ways, and both are chosen rather than inherited.**

- `wishlist_folders.parent_id` is **CASCADE**, onto its own table. A folder inside a deleted folder
  has nowhere else to be, so the whole sub-tree goes in one press. This is also why the cycle
  refusal below is not cosmetic: a cycle is a graph SQLite's recursive cascade would walk forever
  the day one of the folders in it is deleted.
- `wishlist_entries.folder_id` is **SET NULL**. A folder is a *filing decision*; a wish is the
  reader's shopping list, and the two are not the same thing to lose. Deleting a drawer surfaces
  the wishes in it at the root — where they were before anybody filed them — rather than throwing
  away what the reader wanted to buy. The delete confirmation says both halves out loud, because a
  sentence reading "and everything in it" would be wrong about the half that matters.

**This pair is the deck gallery's pair verbatim** — `wishlist_folders.parent_id` is
`deck_folders.parent_id` and `wishlist_entries.folder_id` is `decks.folder_id` — and the symmetry
is the decision rather than a coincidence: "folders nest, and the things filed in them outlive the
filing" is a rule this schema has now made twice. `schema.rs`'s module doc carries the whole-schema
inventory of both lists and is the copy of record; `decks-storage.md` carries the deck slice of it.
A rung that adds one half of a new filing cabinet and forgets the other is exactly what those
inventories exist to catch, since a prose-only edit routes to neither CI job.

Nesting was ported rather than flattened for a cost reason, not an aspirational one: the tree
arithmetic, the cycle refusal and both cascade rules were already written and tested one table
over, so nesting was cheaper than writing a flat version would have been.

### The v23 step's own three traps

Recorded because each is a way the migration could have been silently wrong, and none of them
would have raised anything:

1. **`idx_wishlist_grain` is rebuilt, not added to.** SQLite has no `ALTER INDEX`, and the `DROP`
   has to come first or the `CREATE` is a silent no-op on exactly the machines that already carry
   the narrow index. The `IF EXISTS` is for a rewind fixture that took it away.
2. **`ADD COLUMN` has no `IF NOT EXISTS`, on either half of `ALTER TABLE`.** The step probes
   `pragma_table_info('wishlist_entries')` first, because the rewind above it *cannot* be complete:
   `UNDO_V23` drops the folder table and leaves `folder_id` standing, since SQLite refuses
   `DROP COLUMN` on a column an index names and this one is the grain's fourth term. A blind
   `ALTER` would answer `duplicate column name` — a failure no real upgrade can produce, which is
   the definition of a fixture lying about what it is testing.
3. **No backfill, and the absence is the design.** `folder_id` arrives NULL on every existing row,
   NULL is the root, and the root is the list the reader already sees — so an upgrade is invisible
   until they make their first folder. The unset value is not a lie a `DEFAULT` is telling; it is
   the answer.

The DDL is **spelled out literally and never interpolated from `WISHLIST_GRAIN`**, the rule the v4
and v8 steps state: a migration step is history, and a step that read the constant would silently
rewrite what a *fresh* install creates the next time the grain moves while every already-upgraded
database kept the old shape — with the two then disagreeing about what makes two wishes the same
wish, and nothing anywhere going red.

## The four-term grain, and why it has four terms

```rust
pub const WISHLIST_GRAIN: &str = "coalesce(oracle_id, ''), coalesce(card_id, ''), \
     coalesce(preferred_finish, ''), coalesce(folder_id, 0)";
```

Term by term, each one answering "what makes this a *different* wish":

| Term | Why it is in the grain |
| --- | --- |
| `oracle_id` | Which card is wanted. |
| `card_id` | Which *printing* — a wish for the Alpha Bolt and a wish for any Bolt are two different requests, and only one of them can be filled at the shop next door. |
| `preferred_finish` | A foil wish is not satisfied by the nonfoil in the binder; `OWNED_SQL` narrows by finish for the same reason. |
| `folder_id` | **This one is v23's, and it is what makes "Add to" always an add.** |

**Without the fourth term, "Add to → Ordered" would not be an add.** It would land on the row the
reader already had and raise its quantity — so the wish would appear to *move*, out of wherever it
was filed and into the folder being pointed at, and a filing decision made last week would be
undone by an add made today. With it, the same card in two places is two wishes, and moving one
between folders is a separate and explicit act (`wishlist_set_folder`) rather than a side effect of
shopping.

`coalesce(folder_id, 0)` can never collide with a real folder, because `wishlist_folders.id` is
`INTEGER PRIMARY KEY` and SQLite never auto-assigns rowid 0. It is a `coalesce` for
`COLLECTION_GRAIN`'s reason: NULL is the root, the root is where most wishes live, and **NULLs in a
UNIQUE index are distinct** — so an un-coalesced term would stop enforcing anything for exactly the
rows that need it most.

## The merge rule, shared by both new writes

`wishlist_set_folder` and `wishlist_set_printing` each move one wish onto a grain another row may
already hold — one changes the fourth term, the other the second. Both follow one rule, written
once in `set_wish_printing`'s doc and referred to from the other:

> **A write that lands on a taken grain merges, it does not fail.**

The two quantities sum into the row that was already there, the source row is deleted, and the
answer names the **destination** — whose id is not the id the caller handed in. Un-pinning a wish
for the Alpha Bolt while an any-printing Bolt wish already sits in the same folder is the reader
saying those are one wish, and a `UNIQUE constraint failed` reaching them would be the app telling
them off for agreeing with it. Three Alpha Bolts un-pinned onto two open Bolt wishes is one wish
for five copies.

Four details that are each a decision:

- **`removed` stays `false`** over a row that really was deleted. The field means "the wish is
  gone", which is what `wishlist_remove` and a zero quantity mean; here the wish is emphatically
  still on the list, and the caller re-reads and selects the id it was handed.
- **Notes are the survivor's, falling back to the folded row's** —
  `coalesce(notes, (SELECT notes FROM … WHERE id = source))`, `add_wish`'s own `ON CONFLICT` rule.
  The direction matters: the destination is the row the reader filed and annotated, and inverting
  the coalesce would silently replace their own note with one about a row that no longer exists.
- **`needs_review` on the survivor is left alone**, `reconcile`'s fold rule — that sentence is
  about the row that is staying, and this press was not about it. (`set_wish_printing` *clears* it
  on the ordinary, non-merging path, because choosing a printing **is** the review: the only
  sentences that column carries are the reconciler's, and both are about an id the row no longer
  holds once the write lands.)
- **One transaction**, for the reason every fold in this crate is one: mid-merge the copies are in
  both rows or in neither.

The collision target is spelled out in SQL rather than interpolated from `WISHLIST_GRAIN`, the
reason `reconcile::collision_target` gives: that constant is a list of expressions over **one row**,
and this compares the same list against four bound values. All four terms are in the comparison —
a fold that matched on three of them would merge a wish into a row in another folder, which is
precisely the bug the fourth term exists to make impossible.

Two more refusals belong to the same family and are validated **in words** rather than left to the
foreign key, `deck::set_folder`'s reasoning: a constraint failure names the table and not the
mistake, and `PRAGMA foreign_keys` is a per-connection setting in any case. So a destination folder
that is gone answers `That folder is not there any more.`, and a move that would write a loop
answers `A folder cannot be moved inside itself.` — the cycle walk climbing `parent_id` from the
*proposed* parent, bounded at `MAX_FOLDER_DEPTH` (64) so a loop it did not write terminates rather
than hanging.

## The root-add duplicate, and the mark that catches it

The fourth term is not free, and the price is written down here rather than discovered later.

**Three writers add wishes at the root and cannot name a folder**, because none of them has one to
name:

| Writer | Why it has no folder to name |
| --- | --- |
| `deck_missing_to_wishlist` | A deck sweep is about a deck, and a deck knows nothing about the reader's shopping cabinet. |
| `deck_theory_missing_to_wishlist` | The same, one variant over. |
| `wishlist_import_commit` | An imported file says nothing about this reader's filing — see [import-export.md](import-export.md). |

So a deck sweep run over a card the reader has already filed in `Ordered` produces a **second row
at the root** rather than raising the quantity of the one they filed. That is the accepted cost of
"Add to always adds a new", and it is uncomfortably close to the double-order the whole feature
exists to prevent.

**The mitigation changes no add semantics.** `wishlist_list` answers `elsewhere` per row — how many
*other* wishes exist for the same oracle card — and a row carrying a non-zero one draws a small
mark beside its printing caption in both views, `Copy` glyph, `text-dim`, "Also on your wishlist as
2 other wishes". Most rows answer `0` and draw nothing, so it costs a reader without duplicates
exactly nothing.

Five properties of that count:

- **It counts the same oracle card, not the same printing.** Two wishes for two different printings
  of one card are still two chances to buy it twice, which is the mistake being guarded against.
- **It counts wishes, and the sentence said "places" for a day.** The grain is
  `(oracle_id, card_id, preferred_finish, folder_id)`, so two of the counted rows can sit in the
  same drawer — a foil Bolt and a nonfoil Bolt both loose at the root each read "1 other place"
  while both were in the one place there is. Corrected 2026-08-22; the noun is the app's own, the
  one the header and the folder cards already use.
- **It is counted in SQL, over the whole table.** The list is paged, and a page cannot see the
  wishes it did not fetch — the same count done in TypeScript would answer `0` for exactly the pair
  that is split across two pages. A wishlist is tens of rows, so the correlated count is cheap.
- **It is narrowed by neither the folder nor the query**, deliberately: the answer this field is
  for is about a wish the reader is *not* looking at.
- **`0` on an orphan with no oracle id, and that is a fence rather than the arithmetic.** The
  subquery says `o.oracle_id IS NOT NULL` explicitly. `NULL = NULL` is *unknown* rather than true,
  so today the comparison already refuses them — but the tempting rewrite of that line is a pair of
  `coalesce(…, '')`s to match the grain's first term, and **that version would put every orphan on
  `''` and have them all count each other**. Two orphaned wishes are two unrelated cards whose
  printings have left the corpus, and "also on your list" over them says something false about the
  one thing the mark exists to say something true about.
  `elsewhere_counts_the_other_wishes_for_the_same_oracle_card` is what fails if anyone writes it,
  and `.storybook/fake/db.test.ts` pins the same fence on the fake.

## The drag payload carries two marks, under two keys

Filing a wish by dragging it is a second meaning for a gesture the wish tile already has: it hands
out `dnd.ts`'s `{ kind: "card" }` payload, whose targets are the deck editor's category columns and
the sidebar's Decks entry. Two facts make this more than adding a drop target.

1. **A pinned wish genuinely is both things** — a card you can put in a deck *and* a wish you can
   file — and both have to keep working from the same tile.
2. **An any-printing wish is only the second.** `WishlistGrid` registers no card drag at all on a
   wish with no `card_id`: there is no printing to carry, and `dnd.ts` refuses an empty id because
   it "addresses every row and no row". But "set aside the cards I am unsure about" applies to
   those wishes exactly as much.

`deckDrag.ts`'s precedent is a **different value under the same key** — `DECK_MARK` under
`dragSource`, `dnd.ts`'s own — so a deck and a card each refuse the other outright. That is right
for decks, because a deck is never a card, and **wrong here**: sharing the key would force this
module's mark onto it, `dnd.ts`'s reader would see only whichever mark won, and the other reader
would be lied to. So a wish drag answers under its **own** key.

```ts
// src/features/wishlist/wishDrag.ts
const WISH_MARK = "mtg-grimoire/wish-file-drag";
const MARK_KEY = "wishSource";          // NOT dnd.ts's `dragSource`
```

A wish tile's payload is then the union of two flat objects, each reader answering only its own key
and staying blind to the other's:

| Wish | `dragSource` (card) | `wishSource` (wish) | Can be dropped on |
| --- | --- | --- | --- |
| Pinned | yes, with its `cardId` | yes | deck columns, the Decks entry, **and folders** |
| Any printing | **absent** | yes | **folders only** |

`readDragData` is unchanged and untouched, so an any-printing wish dragged over a deck column
lights nothing up and writes nothing — precisely what it does today, when it cannot be picked up at
all. Nothing in `dnd.ts` or the deck editor had to learn that this module exists.
`readWishDrag` reads its three fields one by one rather than casting, `dnd.ts`'s boundary rule and
its reason: this is the app's edge with the drag library's untyped store, and "it type-checked"
means nothing there.

**`WishDrag.folderId` is on the payload so a target can refuse before the drop.** The folder a wish
is already filed in draws no ring at all, rather than a ring that would lead to a write that moved
nothing and bumped `updated_at` — the same rule as a deck card dropped back into its own column.
`DROP_RING` goes up on *every* eligible folder the moment the wish leaves the tile, and `DROP_OVER`
on the one under the pointer; the wall's scroller carries `DROP_MARK_ROOM`, or a folder card flush
against the content edge loses the outer 2px of its ring for the whole length of the drag.

The two destinations are the folder cards and **the breadcrumb's segments**, which is how a wish
gets back *out*: without them a drag could only ever push wishes deeper. Both write through
`wishlist_set_folder`, the same command the wish's own panel calls, so a drag and a
`Move to folder…` merge on a taken grain identically. There is no second write and no second rule —
and the panel stays complete on its own, because a drag-only affordance is half a feature and it is
the half a keyboard cannot use.

## `folder_summary` answers direct counts, and no row at all for an empty folder

`wishlist_folder_summary(marketplace)` returns `{ folderId, wishes, missing, cost, unpriced }` per
folder, and two things about its shape are load-bearing.

**The counts are direct — this folder's own wishes, never its sub-folders'.** The tree sums the
children on the TypeScript side, in `buildFolderTree`, which already does that arithmetic for the
deck gallery. SQL that walked the tree here would be a second implementation of a thing that is
written and tested, and two implementations of one figure disagree the first time either changes.
The consequence a caller has to know: a folder holding two full sub-folders and nothing of its own
answers `0 wishes` here, so `WishFolderCard` is handed the recursive total and never the raw row.

**A folder with no wishes filed directly in it produces no row at all** — the query is
`WHERE folder_id IS NOT NULL … GROUP BY folder_id`, so an empty folder simply is not in the answer,
and the root, which is not a folder, has no tile to draw either (what is at the root is what the
unfiltered list already shows). A page therefore **cannot** build its folder tree from this
command: `wishlist_folder_list` is the census, flat and `ORDER BY sort_order, id`, and the summary
is a lookup layered onto it. A card whose folder has no summary row falls back to a zeroed total
and draws `0 wishes`, which is correct rather than an error state — an empty drawer is where the
next wish goes.

Every figure is `wishlist.rs`'s own arithmetic rather than a second spelling of it: `missing` is
`max(0, quantity - OWNED_SQL)`, the unit price is `sorting::price_expr` over `WISH_FINISH`, and both
are exactly what `list_wishes` puts in its own columns — so a folder's subtotal and the page
header's total are one piece of arithmetic and cannot disagree. Both expressions are evaluated once
per row in an inner `SELECT` and aggregated by name in the outer one, because `OWNED_SQL` is a
correlated subquery and the price can be another: spelling either three times in the aggregate list
would run it three times per row for one answer.

**`unpriced` counts a row only when it has copies still to buy *and* no price** —
`unit_price IS NULL AND missing > 0`. The second half is the non-obvious one: a wish the binder
already satisfies costs nothing whether the marketplace can quote it or not, and counting it would
put a "could not price" note on a folder with nothing left to buy. A `null` price is the answer and
never a reason to reach for another marketplace's, so `cost` and `unpriced` are always the same
marketplace's and never travel across a switch.

## The wipe

`reset::clear_wishlist` empties `wishlist_entries` **and then** `wishlist_folders`, and needs the
second statement rather than getting it by cascade: `wishlist_entries.folder_id` is SET NULL, so a
wipe that stopped at the entries would hand the reader an empty filing cabinet to take apart one
drawer at a time. The returned count stays the count of **wishes** deleted, which is what the
reader is being told about.

## Deliberately out of scope

- **Folders in import and export.** The seven formats carry cards, and a folder is not one — see
  [import-export.md](import-export.md), where the same decision is recorded beside the formats.
- **Issue #164**, named in #165 as related and separate. It stays separate.

## Where the code is

| Path | What is in it |
| --- | --- |
| `src-tauri/src/schema.rs` | The v23 step, `WISHLIST_GRAIN`, and the whole-schema `ON DELETE` inventory |
| `src-tauri/src/wishlist_folders.rs` | The five folder commands, `set_wish_folder`, `folder_summary` |
| `src-tauri/src/wishlist.rs` | `set_wish_printing`, `elsewhere`, `OWNED_SQL`, `WISH_FINISH` |
| `src/lib/folderTree.ts` | `buildFolderTree` and friends, shared with the deck gallery |
| `src/features/wishlist/wishDrag.ts` | The payload, the tile that offers it, the target that takes it |
| `src/features/wishlist/WishFolderCard.tsx` | The tile, and its stories beside it |
| `src/features/card/cardMenu.tsx` | `buildWishlistTargetItems` — `Add to → Wishlist` |
