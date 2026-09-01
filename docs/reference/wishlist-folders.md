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

## The way back up is a tile on the wall, not only a word in the trail

Issue #283 is one sentence — *"there is no easy way to remove them from that folder and move them
back to the main wishlist"* — and the interesting part is that the gesture already worked. A
breadcrumb segment has taken a wish drop since the cabinet shipped, and the paragraph above says
why: without it a drag could only ever push wishes deeper. What it did not have was **size**. A
segment is one word of `text-sm` in a `nav` above the wall — a target roughly 20px tall, sitting in
a bar the pointer left on its way down to the list — while every place a wish can be pushed *into*
is a 62px tile in the row directly above the wishes. So the way in was drawer-sized and the way out
was a link, and readers did what the issue describes: they gave up on the drag and reached for the
row menu's `Move to folder…`.

**The fix is a folder card for the level above**, first in the wall, drawn only when the reader is
inside a folder. It is `src/components/ParentFolderCard.tsx`, shared by all three cabinets, with a
thin per-page wrapper beside each page's own folder card (`WishParentFolderCard` here) holding the
two drop targets. Four decisions:

- **The name is the destination.** The tile prints the parent folder's name — or `Wishlist` at the
  root, which is `ROOT_LABEL`, the same word the breadcrumb's own first segment uses — with
  `Up one level` on the second line, where a folder card prints `6 wishes · $312.00`. A reader
  mid-drag has to read *where this goes* before they let go, and "Up one level" alone does not say
  it. The accessible name is built from both (`Up one level to Ordered`) rather than replacing
  either.
- **The destination is read off the trail, never off the open folder's `parentId`.** `trailOf`
  stops at a folder this list does not carry, so a drawer whose parent another surface deleted has
  a one-segment trail and climbs to the root — which is exactly where `buildFolderTree` has drawn
  it. The tile and the trail therefore agree by construction rather than by two rules that happen
  to say the same thing today.
- **It takes a folder as well as a wish**, which is the half the breadcrumb refuses and still
  refuses. That refusal's reasoning is unchanged and is quoted in `canPlaceFolder`:
  `wishlist_folder_reorder` takes a destination **and that level's whole order**, and a segment is
  one word with no order to point into, so the only thing a drop on it could say is "last, in a
  level that is not on screen". What answers it here is that the tile is **one landing wide**:
  every part of it means *up there*, which is the `inside` landing a reader already gets from the
  middle of a folder card — "which drawer, and nothing about where in it" — and `reorderedLevel`
  already appends. So the arriving drawer goes last in the level above, and there is no second
  position in the gesture for the reader to have meant.
- **A drawer already in the level above draws no ring.** Not reachable on this page — the wall
  draws one level, so every card on it is a child of the folder the reader is standing in — but it
  is `folderPlacement`'s own "already there" clause, kept local for the reason all four of its
  refusals are: the collection's cabinet *does* reach it, inside `Recently removed`.

**The trail is untouched.** It still takes a wish drop on every segment, still says where the
reader is standing, and is still the only way out of a level whose wall is not drawn. What changed
is that the ordinary case has a target the size of the things around it.

## What a wish costs, and which printing it is drawn as

Two changes, both 2026-08-26, both in `src-tauri/src/wishlist.rs`, and the second one dragged
`wishlist_folders.rs` with it. The design is
[2026-08-26-card-chin-and-exact-prices-design.md](../superpowers/specs/2026-08-26-card-chin-and-exact-prices-design.md).

**What was measured first**, against the dev database at `src-tauri/target/debug/data/mtg.db` on
2026-08-26 — 116 843 live `cards` rows and 88 wishes, with `marketplace_prices` empty because no
price feed had ever been refreshed, so every figure here is TCGplayer's (the default, and this
database's setting):

| Question | Answer |
| --- | --- |
| Wishes with no price | **1 of 88** |
| Which one | **Wakka, Devoted Guardian** (FIC #477): `finishes: ["foil"]`, `usd: null`, `usd_foil: 31.18` |
| Wishes naming a finish | **0 of 88** — every one is `preferred_finish IS NULL` |
| Any-printing wishes | **0 of 88** — every one is pinned |
| Printings priced only in foil or etched | **12 849 of 116 843** (11.0 %) |

The first row is the whole of the first change: **the price for Wakka existed all along and the
query asked for the wrong finish.** A wishlist drawing an em dash beside a search wall quoting that
same printing at $31.18 is not missing data.

### A wish that names no finish is priced at the chain, not at nonfoil

`WISH_FINISH` was `coalesce(w.preferred_finish, 'nonfoil')`, and the `coalesce` was the bug: "no
preference" is a wish for the *card*, not a wish for a plain copy, and 12 849 printings have no
nonfoil price at any marketplace to give it. It is `WISH_PREFERRED_FINISH` now — the bare column,
handed over **unwrapped**, so the expression below can tell "the reader has not said" from "the
reader said nonfoil", which on a foil-only printing are two different answers.

**The rule it is handed to is not a new one.** `sorting::row_price_expr(market, finish_col)` is two
arms told apart by whether the row has said:

- **NULL** — `printing_price_by_finish_expr`'s `nonfoil → foil → etched` chain, quoted rather than
  respelled, so each marketplace's own holes travel with it.
- **named** — `price_expr` at that finish and **no fallback of any kind**. The reader has said which
  object is in the sleeve; an em dash means "this marketplace does not quote this printing in this
  finish", never "look somewhere else".

That is the shape the **deck** adopted at schema v18 and the wishlist never did. Rather than a
third copy of it, `deck_card_price_expr` was generalized off its `dc.` alias — it is
`row_price_expr(market, "dc.finish")` now, the wishlist passes `w.preferred_finish`, and one
function serves both. Cardmarket's missing `eur_etched` survives into both arms for free, because
that hole lives in `price_expr` rather than in either wrapper: an etched row is unpriced in euros
and priced at every marketplace that does quote it.

**No sort template moved.** `WISHLIST_PRICE_SORTS` already orders by the `unit_price` *output
alias*, so the money sorts follow the cell by construction.

### An any-printing wish is drawn as, and priced at, the cheapest printing

The join that picks the printing a wish is *about* used to order by `released_at DESC, id ASC` —
the newest — and orders by the price first now:

```sql
LEFT JOIN cards c
  ON c.id = coalesce(w.card_id,
      (SELECT c.id FROM cards c
        WHERE c.oracle_id = w.oracle_id
        ORDER BY ({price}) ASC NULLS LAST, c.released_at DESC, c.id ASC
        LIMIT 1))
```

`{price}` is the very expression from the section above, **built once and used twice** — to choose
the printing and to price whichever printing that turns out to be. One expression rather than two,
so the picture and the figure under it can never come from two different rules.

**The picture moves with the price, and that is the feature rather than a side effect.**
`art_card_id` comes off this same join, so the tile's art, its rarity gem and its chin's set and
number all move together. What does *not* move is the caption: it still reads `Any printing`,
because `printingOf` is unchanged and the wish is for the **card** — a caption reading `DSK · 123`
under that art would say the reader had asked for that piece of cardboard. `elsewhere` does not
move either; it counts wishes by `oracle_id` and never touches this join at all.

**`ASC NULLS LAST` with the old clause as the tiebreak is what makes it safe for the wishes it
cannot answer.** An oracle card no marketplace quotes keeps the newest printing it has always had,
so a wish never loses its art or its set code to a hole in a pricelist — and the change is a
straight no-op for the unpriced.

**The inner alias is `c` and it shadows the outer one deliberately.** `sorting::price_expr`
hard-codes `c` for the printing being priced, which is what keeps the join key and the price from
being spelled apart across six call sites, so the candidate printing inside the subquery has to
wear that name. The `w.` references stay correlated to the outer wish, which is the whole reason
this is a subquery rather than a join.

**`coalesce` short-circuits, so the subquery runs only for an *unpinned* wish** — at most `MAX_LIMIT`
rows a page, and 0 of 88 wishes in this database. The cost is bounded by how many wishes name no
printing, not by the size of the corpus. The measured figure belongs in
[data-and-sync.md](data-and-sync.md) beside the other search-performance numbers and has not been
taken yet; it has to come off the shipped window.

**`folder_summary` had to take the same join, and that is not tidiness.** A folder tile that
totalled the *newest* printing over a list quoting the *cheapest* would be a subtotal that does not
add up to the rows under it, with nothing on screen saying which of the two figures to believe.

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
`max(0, quantity - OWNED_SQL)`, the unit price is `sorting::row_price_expr` over
`WISH_PREFERRED_FINISH`, and the `LEFT JOIN` that picks the printing is `list_wishes`' join
verbatim in shape — all three exactly what `list_wishes` puts in its own columns, so a folder's
subtotal and the page header's total are one piece of arithmetic and cannot disagree. Both
expressions are evaluated once
per row in an inner `SELECT` and aggregated by name in the outer one, because `OWNED_SQL` is a
correlated subquery and the price can be another: spelling either three times in the aggregate list
would run it three times per row for one answer.

**`unpriced` counts a row only when it has copies still to buy *and* no price** —
`unit_price IS NULL AND missing > 0`. The second half is the non-obvious one: a wish the binder
already satisfies costs nothing whether the marketplace can quote it or not, and counting it would
put a "could not price" note on a folder with nothing left to buy. A `null` price is the answer and
never a reason to reach for another marketplace's, so `cost` and `unpriced` are always the same
marketplace's and never travel across a switch.

## The copies control, and the floor that stopped being 1

**2026-09-01, [issue #284](https://github.com/Msgaihede/mtg-grimoire/issues/284), and it reverses a
rule this app argued for in three separate places.** The wishlist's **wall** had no copies control
at all: the table edited a wish in place, and on a tile the number could only be reached by opening
the pencil's panel. A wall that is the view opening by default and cannot do what its own list view
does is the gap the issue named, so the wall now carries a `QuantityStepper` beside the pencil, in
`CardGrid`'s action strip over the art — the strip is absolutely positioned, so the wall's
`tileHeight` is unchanged by it.

**And every one of the three floors moved from `1` to `0`.** The rule they held said, in as many
words, that "a wish for none of something is not a wish" and that "a stepper that deleted the row
when held down would be a one-way door with no undo, so removal is the separate press below". That
is no longer the rule. What replaced it is consistency across the two walls a reader reads one after
the other: the collection's tile stepper floors at `0` and zero deletes there, and a wishlist tile
that refused the same press would be one wall of art behaving unlike the other for a reason visible
only in this file.

The backend never disagreed. `wishlist::set_wish_quantity` has returned `remove_wish(conn, id)` at
zero since it shipped, because `wishlist_entries.quantity` carries `CHECK (quantity > 0)` — the
floor of `1` was always a guard drawn on the glass, never on the table.

**Two things had to move with it, and the second was a live bug the floor was hiding.**

- **`Remove from wishlist` stays** in the pencil's panel. It is now reachable two ways, which is the
  arrangement the collection's table has had all along (a stepper that deletes at zero, plus a
  control that says so) — and the named press is the one a keyboard reader finds without holding a
  button down.
- **`setQuantity`'s success handler ignored `EntryChange.removed`.** It patched `change.quantity`
  and nothing else, which at a floor of `1` was unreachable and at `0` is one press away: a wish
  stepped to zero stayed on screen at `0` for the length of the round trip, and the `+` a reader
  pressed on it in that window answered `GONE`. It is the same defect the page's own `remove`
  handler was written against — *"the row goes at once, a crossed-off wish must not sit there for
  the length of a round trip"* — reached by the other gesture. The fix is that handler's two lines:
  `patchWish(change.id, change.removed ? null : …)`. A removal and a stepper taken to zero are one
  write with two gestures, so the two are now spelled the same way.

  **The collection's version of this bug is worse and the difference is worth not confusing**, since
  its comment is the one that was ported: `CollectionPage`'s `settle()` invalidates
  `["collection","summary"]` and `["collection","folderSummary"]` and pointedly *not* `["collection"]`,
  so its ghost persisted until something else re-read the list. `settleWhole()` invalidates
  `["wishlist"]` whole, and this list's key is `["wishlist","list", …]` — broad on purpose, so a
  collection write two views away refreshes an `ownedQuantity` computed from `collection_entries`
  (`useWishlist.ts:221`). So the wishlist's ghost clears itself. It is a flicker rather than a
  standing lie, and it is still not what a delete should look like.

The collection's half of this — including the fence that keeps a stepper out of a deck's group and
`Recently removed`, which the wishlist has no equivalent of because none of its folders belong to
the app — is in
[collection-folders.md](collection-folders.md#the-copies-control-belongs-to-a-normal-folder-in-both-views).

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

## What driving the shipped window found

Three CDP passes over `a534bf7`, on Windows, `tauri dev` (debug), at 1920×1080 and 1280×800. Every
figure below was measured, not derived. The suite could not see any of them: jsdom has no layout
engine, and its default `staleTime` is 0 where the app's is 30 s (`src/lib/query.ts`).

**A wish filed into a folder used to vanish until reload, and that is the one worth remembering.**
`setFolder` removed the row optimistically from every cached list page and then invalidated only the
folder summary and the card search — so nothing ever put it back where it went. The folder card read
`1 wish · $2.74` while the folder's own contents read `Nothing filed here yet.`, with the wish in the
database the whole time. It reproduced on all three routes (drag into a folder, drag out onto the
breadcrumb, the panel's `Move to folder…`), persisted at +8 s, and cleared only on a reload. The
**merge** path already invalidated; a plain move never did. Fixed by dropping the optimism: a folder
move is one deliberate press, not a held stepper, and an optimistic insert would have to guess the
destination's sort position and page.

**A held stepper costs four ipc calls per press** — `setQuantity`, then `folderList`,
`folderSummary` and `list` — about 20 ms round trip. `QuantityStepper` has no hold-repeat, so the
realistic case is Enter at Windows' ~33 ms key repeat, where the number is perfectly monotonic.
Below ~25 ms it can flicker back by one for a single frame (~7 ms) and self-corrects; the committed
value was always right. **Measured on 13 wishes only** — the re-read is the part that grows with the
list.

**A popup's entry animation can eat the scroll that reveals it.** `AnchoredPopup` focused its panel
while the motion preset still held it at `scale: 0.96` with a top origin, so the browser computed
scroll-into-view for a box 4 % shorter and the scroller clipped the panel's bottom — 8.5 px on a
212 px panel, then 10.5 px once the panel grew to 272 px. Four per cent both times.

**A scroll margin cannot fix that, and settling it took an experiment rather than an argument.**
Forcing `scroll-margin-bottom` from 16 px to 400 px changed the landing `scrollTop` and the loss
*not at all*: scaling the open panel drops the scroller's `scrollTop` maximum from 257 to 246, and
246 is exactly where the auto-scroll landed. A margin only asks the browser to scroll further, and
the browser clamps at a maximum the scaled panel itself caps. The fix is
`focus({ preventScroll: true })` plus a `scrollIntoView` once the entry animation completes at
`scale: 1`, after which the bottom lands 0.5 px **inside** the clip at both sizes and the maximum
reads 257.

**Two harness facts, for the next pass.** `window.__TAURI_INTERNALS__.invoke` is non-writable and
non-configurable, so patching it to count ipc calls fails silently and reports zero — which reads
exactly like an app that made no calls. Wrap the methods on `src/lib/ipc.ts`'s `ipc` object instead.
And this app's confirmations carry **no** `dialog` or `alertdialog` role, so probing for one finds
nothing on a confirmation plainly on screen; find it by its text.

**Confirmed and unchanged across all three passes**: the drop ring clears its scroller by exactly
6.0 px on the first and last folder card mid-drag, 8 of 8 ringed; and the `⋯` menu opens at
dx 0.0 / dy 0.0 from its trigger on keyboard activation, which is what `menuClick` exists for.

## Where the code is

| Path | What is in it |
| --- | --- |
| `src-tauri/src/schema.rs` | The v23 step, `WISHLIST_GRAIN`, and the whole-schema `ON DELETE` inventory |
| `src-tauri/src/wishlist_folders.rs` | The five folder commands, `set_wish_folder`, `folder_summary` |
| `src-tauri/src/wishlist.rs` | `set_wish_printing`, `elsewhere`, `OWNED_SQL`, `WISH_PREFERRED_FINISH`, the cheapest-printing join |
| `src-tauri/src/sorting.rs` | `row_price_expr`'s two arms, and `deck_card_price_expr` as one caller of it |
| `src/lib/folderTree.ts` | `buildFolderTree` and friends, shared with the deck gallery |
| `src/features/wishlist/wishDrag.ts` | The payload, the tile that offers it, the target that takes it |
| `src/features/wishlist/WishFolderCard.tsx` | The tile, and its stories beside it |
| `src/components/ParentFolderCard.tsx` | The up-one-level tile all three cabinets draw, and its stories |
| `src/features/card/cardMenu.tsx` | `buildWishlistTargetItems` — `Add to → Wishlist` |
