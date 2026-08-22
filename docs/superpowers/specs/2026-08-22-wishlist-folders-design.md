# Wishlist folders, and the printing a wish is for

Design for [issue #165](https://github.com/Msgaihede/mtg-grimoire/issues/165), 2026-08-22.

The issue asks for two things and they are separable, so this document keeps them apart:

1. **Setting cards aside without removing them** — expensive cards to buy later, cards already
   ordered but not yet in hand, cards the reader is unsure about. The chosen answer is **folders
   in the wishlist**, the deck gallery's filing cabinet ported to a shopping list, with a
   **Flatten** switch that ignores the filing and shows the whole list at once.
2. **Changing which printing a wish is for**, including changing it back to _any printing_.
   `wishlist_entries.card_id` is already nullable and already means exactly that; there has never
   been a way to write it from the wishlist.

## What a folder is, and what it is not

A folder is a **filing decision the reader makes about a wish**. It is not a tag, not a status
and not a second list: a wish is in exactly one place, the same way a deck is in exactly one
folder. `NULL` is the root wishlist and is where every wish lands unless somebody says otherwise
— nothing has to be filed for the list to work, and a reader who never makes a folder sees the
list they see today.

Folders **nest**, for the reason `deck_folders` does: the tree arithmetic, the cycle refusal and
the two cascade rules are already written and tested, so nesting costs less than writing a flat
version would.

## 1. Schema — v23

`SCHEMA_VERSION` goes to 23. One step, one transaction, `PRAGMA user_version = 23;` last.

```sql
CREATE TABLE IF NOT EXISTS wishlist_folders (
    id INTEGER PRIMARY KEY,
    -- User<->user, CASCADE: deleting a folder deletes the folders inside it. The WISHES
    -- inside it are NOT deleted -- see wishlist_entries.folder_id below, which is SET NULL.
    -- A folder is a filing decision; a wish is the reader's shopping list.
    parent_id INTEGER REFERENCES wishlist_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wishlist_folders_parent ON wishlist_folders (parent_id);

ALTER TABLE wishlist_entries ADD COLUMN folder_id INTEGER
    REFERENCES wishlist_folders(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS idx_wishlist_grain;
CREATE UNIQUE INDEX idx_wishlist_grain
    ON wishlist_entries (coalesce(oracle_id, ''), coalesce(card_id, ''),
                         coalesce(preferred_finish, ''), coalesce(folder_id, 0));
CREATE INDEX IF NOT EXISTS idx_wishlist_folder ON wishlist_entries (folder_id);
```

The DDL is **spelled out literally, never interpolated from `WISHLIST_GRAIN`** — the rule the v4
and v8 steps state: a migration step is history, and a step that read the constant would silently
rewrite what a *fresh* install creates while every upgraded database kept the old shape.

`coalesce(folder_id, 0)` is safe because `wishlist_folders.id` is `INTEGER PRIMARY KEY` and
therefore never 0.

### The grain changes, and that is the load-bearing decision

`WISHLIST_GRAIN` — the constant, not the migration — becomes:

```rust
pub const WISHLIST_GRAIN: &str = "coalesce(oracle_id, ''), coalesce(card_id, ''), \
     coalesce(preferred_finish, ''), coalesce(folder_id, 0)";
```

That one line is what makes **"Add to" always add a new wish**. A card already on the list at the
root and added again to `Ordered` becomes a second row in `Ordered` rather than the root row
moving; moving between folders is a separate, explicit act (§2, `wishlist_set_folder`).

`reconcile.rs` reads the grain in the same way it did and needs no change beyond compiling
against the new constant. `schema.rs`'s own v4-era `ON CONFLICT ({WISHLIST_GRAIN})` inside a
*test helper* (schema.rs:2839) interpolates the constant and so follows it automatically.

### The consequence, written down rather than discovered later

Three writers add wishes **at the root** and cannot name a folder: `deck_missing_to_wishlist`,
`deck_theory_missing_to_wishlist` and `wishlist_import_commit`. With `folder_id` in the grain,
a deck sweep run over a card the reader has filed in `Ordered` produces a **second root row** —
which is the double-order the issue's motivation is trying to prevent.

This is the accepted price of "Add to always adds a new". The mitigation changes no add
semantics: `wishlist_list` also answers **`elsewhere`** per row — how many *other* wishes exist
for the same oracle card — and a row carrying a non-zero one draws a small "also on your list"
mark. Drawn in §4.

### `reset.rs`

`clear_wishlist` empties `wishlist_folders` as well as `wishlist_entries`, in that order or by
cascade, and its returned count stays the count of **wishes** deleted. The existing test
`clearing_the_wishlist_touches_nothing_else` gets a sibling asserting the folders go too and the
decks' folders do not.

## 2. Rust — the commands

### New module: `src-tauri/src/wishlist_folders.rs`

`deck_meta.rs`'s folder half ported, same shapes, same words, same refusals.

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistFolder {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub sort_order: i64,
}
```

| Command | Contract |
| --- | --- |
| `wishlist_folder_list() -> Vec<WishlistFolder>` | Flat, `ORDER BY sort_order, id`. The tree is the reader's to build. |
| `wishlist_folder_create(parentId: Option<i64>, name: String) -> WishlistFolder` | `sort_order` = `max+1` among siblings. Blank name refused. |
| `wishlist_folder_rename(id, name) -> WishlistFolder` | Blank name refused. |
| `wishlist_folder_move(id, parentId: Option<i64>) -> WishlistFolder` | **Refuses a cycle**, including a move into itself: `parent_id` cascades onto itself, so a cycle is a graph the delete would walk forever. Walks the parent chain with a visited set so a cycle it did not write terminates. `None` moves to the root. |
| `wishlist_folder_delete(id)` | Sub-folders cascade; the **wishes inside surface at the root** (`SET NULL`). An id that resolves to nothing is a success. |

Two more that are this list's own:

**`wishlist_set_folder(id: i64, folderId: Option<i64>) -> EntryChange`** — the "move to". `None`
is the root and is a real destination, not an omission.

> **It must merge, not fail.** Moving a wish into a folder that already holds the same
> `(oracle_id, card_id, preferred_finish)` violates `idx_wishlist_grain`. The write sums the two
> quantities into the destination row, deletes the source, and answers the **destination's** id
> and quantity. A `UNIQUE constraint failed` reaching the reader would be the app telling them
> off for filing a card twice. This needs its own test.

**`wishlist_folder_summary(marketplace) -> Vec<WishlistFolderSummary>`** — what a folder card is
drawn from.

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistFolderSummary {
    pub folder_id: i64,
    /// Wishes filed **directly** in this folder. The tree sums it; SQL does not.
    pub wishes: i64,
    /// Copies still to find here -- sum of max(0, quantity - owned), the page's `missingOf`.
    pub missing: i64,
    /// What those copies cost at the named marketplace. Unpriced rows are left out, never
    /// quoted at another marketplace's rate.
    pub cost: f64,
    /// How many wishes here the marketplace could not price. The page header's own note.
    pub unpriced: i64,
}
```

Direct per folder, never recursive: the tree builder on the TypeScript side already sums a
node's children for the deck gallery and does it here for the same reason — SQL that walked the
tree would be a second implementation of the arithmetic already written in `folderTree.ts`.

Reuses `wishlist.rs`'s existing `OWNED_SQL` and `crate::sorting::price_expr` over `WISH_FINISH`,
so a folder's subtotal and the page header's total are the same arithmetic and cannot disagree.

### Changes in `src-tauri/src/wishlist.rs`

- `WishInput` gains `folder_id: Option<i64>` — where a menu add files it. Absent is the root.
  It is written into the INSERT and is part of the conflict target, so no `DO UPDATE` clause
  touches it.
- `WishlistQuery` gains:
  - `folder_id: Option<i64>` — which folder the list is being read at. `None` is the root.
  - `flatten: bool` — `true` ignores `folder_id` entirely and returns every wish. Default
    `false`. This is what tells "the root" apart from "no folder filter"; a nullable field
    alone cannot.
- `WishRow` gains `folder_id: Option<i64>` and `elsewhere: i64`.
  - `elsewhere` is a correlated count of other rows with the same `oracle_id` and a different
    id — `0` on an orphan with no oracle id. A wishlist is tens of rows, so this is cheap; it is
    computed in SQL rather than in TypeScript because the list is paged and a page cannot see
    the wishes it did not fetch.
- **`wishlist_set_printing(id: i64, cardId: Option<String>) -> EntryChange`**.
  - `Some(card_id)` pins the wish to that printing and refreshes the denormalised
    `set_code`/`collector_number`/`lang` from `cards`; refuses an id the card database does not
    have, in `add_wish`'s words.
  - `None` is the way back to **any printing**: `card_id`, `set_code`, `collector_number` and
    `lang` all go NULL. The wish must still name an oracle card — the table's
    `CHECK (oracle_id IS NOT NULL OR card_id IS NOT NULL)` — so a wish whose `oracle_id` is NULL
    is refused with a sentence saying that its printing is all it has.
  - **Merges on collision**, `wishlist_set_folder`'s rule verbatim and for the same reason:
    un-pinning a wish for the Alpha Bolt when an any-printing Bolt wish already sits in the same
    folder is the reader saying they are one wish.
  - Clears `needs_review`: repointing a wish at a printing the reader chose is the review.

### `lib.rs`

Seven new handlers registered: the five folder commands, `wishlist_set_folder`,
`wishlist_folder_summary`, and `wishlist_set_printing`. `pub mod wishlist_folders;` beside
`pub mod wishlist;`.

## 3. TypeScript — shared code first

### `src/lib/folderTree.ts` (new)

`buildFolderTree`, `flattenFolders`, `folderDescendants` and `indent` move here from
`src/features/decks/folders.ts`, with their types widened from `DeckFolder` to a structural
shape:

```ts
export interface FolderLike { id: number; parentId: number | null; name: string; sortOrder: number; }
export interface Filed { folderId: number | null; archived?: boolean; }
```

`DeckFolder` and `WishlistFolder` both satisfy `FolderLike` already. `archived` becomes optional
because a wish cannot be archived; `buildFolderTree` skips a member when `member.archived ===
true`, so an absent flag counts.

`FolderNode.deckCount` is renamed **`count`** — it counts decks on one surface and wishes on the
other, and a field called `deckCount` holding a number of wishes is a lie in the type. Every
reader of it updates in the same commit.

`src/features/decks/folders.ts` keeps its whole doc comment and becomes a re-export of the four,
so **nothing that imports `./folders` or `./FolderTree` changes**. `src/lib/` holds no
`FolderTree.*`, so the case-collision trap that named `folders.ts` in the first place does not
apply here — but the plan states it, because it is the kind of thing that is only checked once.

### `src/lib/ipc.ts`

`WishlistFolder`, `WishlistFolderSummary`, the eight bindings, and the new fields on `WishInput`,
`WishlistQuery` and `WishRow`.

### `src/features/wishlist/useWishlistFolders.ts` (new)

`useDeckFolders`'s twin: one query at `["wishlist", "folders"]` — under the `["wishlist"]` root
every wish write in the app already invalidates, which is what keeps a folder card's count
honest when a wish is added two views away — plus `create` / `rename` / `move` / `remove`, each
invalidating `["wishlist"]` whole on success **and on error**. A folder delete un-files the
wishes inside it, so a hook that refreshed only the folder list would leave the wall drawing
wishes in a folder that is gone.

A second query at `["wishlist", "folderSummary", marketplaceId]` for the counts and subtotals.

## 4. The wishlist page

```
Wishes 24                     Still to buy (USD) $412
[search...] [Still missing] [Flatten] [+ New folder] [sort] [grid|table]
Wishlist > Expensive                        <- breadcrumb, only inside a folder
+---------+ +---------+
: Ordered : : Someday :   dashed, "3 wishes - $88"        ... -> Rename / Move / Delete
+---------+ +---------+
[card] [card] [card] [card]                 <- the wishes filed at this level
```

### Navigation state

`useWishlist` gains `folderId: number | null` and `flatten: boolean`, both part of the query key
and both sent to `wishlist_list`. They are **not filters**: `resetAll` leaves them alone, exactly
as it leaves the sort alone, because where you are standing is not something you are filtering
by. `activeFilterCount` does not count them.

### Flatten

A `ToggleChip` beside "Still missing", pressed state on. While it is on:

- no folder cards and no drill-down; the breadcrumb reads `Wishlist - all folders` and is inert;
- every wish in the list regardless of filing;
- **each wish is captioned with the folder it is in** — joined in TypeScript from `row.folderId`
  against the folder list, since a page has both. Without that, flattened is just the old list.
- "+ New folder" is hidden: there is no current folder to create inside.

### The two figures

They describe **what is on screen** — the current folder, or everything when flattened. Root plus
Flatten is the whole-list number, which is one press from anywhere. A header that always totalled
the whole list would contradict the tiles beneath it.

### Folder cards

`WishFolderCard.tsx`, drawn from `FolderCard.tsx`'s **dashed** treatment — the screen's existing
rule that dashed means provisional — but not its strip of member art: a wishlist folder's useful
face is `6 wishes - $312`, which is what a shopping list is read for. Direct children of the
current folder only.

Drawn **above both views**, the wall and the table alike, so the two navigate the same way.

Each carries a `...` trigger opening Rename / Move to folder... / Delete, plus a right-click and
Shift+F10 route to the same menu, `FolderCard`'s contract. Move uses `MoveToFolder` with
`forbidden` = the folder and its descendants, `folderDescendants`' existing job.

Delete confirms, and the sentence says what happens: **its wishes move back to your wishlist;
folders inside it are deleted.**

### The `elsewhere` mark

A wish whose `elsewhere` is non-zero draws a small mark — `Copy` glyph, `text-dim`, tooltip
"Also on your wishlist in 2 other places" — beside the printing caption in both views. It is the
one thing on screen that catches the duplicate §1 describes, and it costs a reader nothing when
they have no duplicates, because most rows answer 0 and draw nothing.

It counts wishes for the same **oracle card**, not the same printing: two wishes for two different
printings of one card are still two chances to buy it twice, which is the mistake being guarded
against.

### Empty states

- A folder with nothing in it: "Nothing filed here yet." — not the root's sentence, which tells
  the reader how to put something on the wishlist in the first place.
- The root with folders but no loose wishes: the folder cards are the content; the status line
  stays empty.

## 5. The wish's own controls — `EditWish.tsx`

The panel becomes the one place a wish is edited, and it has to be, because it is the **only**
control an any-printing wish has: `WishlistPage.tsx:263` withholds the card context menu from
every wish with no `card_id`, deliberately, and both new writes have to reach those rows.

```
Copies wanted   [-  2  +]
Printing        SLD - 123 - Foil
                [Change printing...]  [Any printing]
Folder          Expensive
                [Move to folder...]
[Remove from wishlist]
```

- **`[Any printing]`** is drawn only on a pinned wish, and calls `wishlistSetPrinting(id, null)`.
  It is a plain button rather than a row in the printings modal because a wall of printings is
  the wrong place to offer the absence of one.
- **`[Change printing...]`** opens the existing All printings modal (§6). Disabled with a reason
  on a wish whose `oracleId` is null — there are no printings to list.
- **`[Move to folder...]`** swaps the panel's own content to `MoveToFolder`'s destination list
  **in place**, with a back affordance. Not a nested layer: `AnchoredPopup` inside `AnchoredPopup`
  is two Escape rungs and two focus traps for one decision.
- The panel widens from `w-56`.

`WishlistTable`'s Printing cell becomes a button opening the same panel, so the table reaches
both writes without growing two columns. The grid keeps the pencil trigger it has.

## 6. All printings, as a way to repoint a wish

`PrintingsRequest` gains `wish: { id: number } | null` beside its existing `deck` slot — the same
mechanism, one field wider:

- `AllPrintingsDialog`'s press handler branches on it before the `deck` branch and before the
  fall-through that opens the card pane, and calls `wishlistSetPrinting(request.wish.id, cardId)`.
- On success the modal closes, exactly as a deck swap does.
- A refusal draws beside the wall in the same place `swap.isError` does.
- **`CardWalkStop` does not gain the field.** Stepping the walk to another card calls
  `openAllPrintings(stop)` with no `wish`, so the target clears — which is right: the reader
  asked about wish A, and arrowing to card B must not repoint A.

## 7. Add to -> Wishlist

`useCardMenuDeps` subscribes to `useWishlistFolders()`. That is **one small shared query per page
mount**, not one per right-click, so the deck picker's `lazy` machinery is not needed and the
menu stays synchronous. `CardMenuDeps` gains `wishlistFolders: readonly WishlistFolder[]` and
`addToWishlist` gains a second argument, `folderId: number | null`.

- **No folders** -> `Wishlist` stays exactly what it is today: one row, one press, adds to the
  root. This is the case for every reader who has never made a folder, and it must not regress.
- **Folders exist** -> a submenu:

```
Add to > Wishlist >
    Wishlist                 <- the root, Heart icon
    ------------
    Expensive                <- Folder icon
    Ordered
    Maybe later >
        Maybe later          <- the folder itself, first
        ------------
        Someday
```

`buildWishlistTargetItems(folders, choose)` mirrors `buildDeckTargetItems`' recursion, with two
differences: a folder row is **always offered** even when empty (a folder is a destination, not a
container of destinations — `deckLevel` drops an empty folder because a folder with no decks
under it offers nothing to press), and a folder with children draws its own row first inside its
submenu.

## 8. Storybook

`.storybook/fake/db.ts` gains `wishlistFolders: FakeWishlistFolder[]`, `folderId` on `FakeWish`,
and handlers for the eight new commands honouring the same merge-on-collision and cycle rules —
a fake that accepted a cycle would let a story draw a tree the app refuses to make.

Seeds: a wishlist with three folders, one nested, one empty, and loose wishes at the root, so the
folder card, the breadcrumb, the empty-folder sentence, the drag and Flatten all have a story.
At least one **any-printing** wish at the root, since it is the one a card drag cannot pick up
and the wish drag must.

## 9. Dragging a wish into a folder

### The problem the payload has to solve

A wish tile is **already** draggable and that drag already means something else: it hands out
`dnd.ts`'s `{ kind: "card" }` payload, whose targets are the deck editor's category columns and
the sidebar's Decks entry. Filing a wish is a second meaning for the same gesture, and two facts
make it more than a matter of adding a drop target:

1. **A pinned wish genuinely is both things.** It is a card you can put in a deck *and* a wish you
   can file, and both must keep working from the same tile.
2. **An any-printing wish is only the second.** `WishlistGrid.tsx:87` registers **no drag at all**
   on a wish with no `card_id`, deliberately — there is no printing to carry, and `dnd.ts` refuses
   an empty id because it "addresses every row and no row". But "set aside the cards I am unsure
   about" applies to those wishes exactly as much, so the gesture has to reach them.

### Two marks on one payload

`deckDrag.ts`'s precedent is a *different value* under the **same** key (`dragSource`), so a deck
and a card each refuse the other. That is right for decks — a deck is never a card — and wrong
here. A wish drag therefore gets its **own key**, and the reason goes in the file:

```ts
// src/features/wishlist/wishDrag.ts
const WISH_MARK = "mtg-grimoire/wish-file-drag";
const MARK_KEY = "wishSource";          // NOT dnd.ts's `dragSource` -- see below

export interface WishDrag {
  wishId: number;
  name: string;
  /** Where it is filed now, so a folder can refuse a drop onto itself. */
  folderId: number | null;
}
```

A wish tile's payload then carries **both** sets of keys where it can:

| Wish | `dragSource` (card) | `wishSource` (wish) | Can be dropped on |
| --- | --- | --- | --- |
| Pinned | yes, with its `cardId` | yes | deck columns, the Decks entry, **and folders** |
| Any printing | **absent** | yes | **folders only** |

`readDragData` refuses anything with no card mark, unchanged and untouched, so an any-printing
wish dragged over a deck column lights nothing up and writes nothing — which is precisely what it
does today, when it cannot be picked up at all. Nothing in `dnd.ts` or the deck editor changes.

`readWishDrag` reads its three fields one by one rather than casting, `dnd.ts`'s boundary rule.

### Where a wish can be dropped

- **A folder card**, moving the wish into it. `DROP_RING` while a wish is in the air, `DROP_OVER`
  on the one under the pointer — the app's existing vocabulary, from `lib/dropMarks.ts`.
- **The breadcrumb's segments**, which is how a wish gets back *out*: dropping on `Wishlist`
  un-files it to the root, dropping on an ancestor moves it up. Without this, a drag can only ever
  push wishes deeper.
- **The folder card the wish is already in refuses**, drawing no ring at all rather than a ring
  that does nothing: `payload.folderId` is what lets the target answer that before the drop.
  Same rule as a deck card dropped back in its own column.

The wall's scroller carries `DROP_MARK_ROOM`, or a folder card flush against its content edge
loses the outer 2px of its ring for the whole length of the drag — the bug `dropMarks.ts` records
against the deck builder's grow-views, and one jsdom cannot see.

The write is **`wishlist_set_folder`**, the same command the panel calls, so a drag and a
`Move to folder...` merge on a taken grain identically. There is no second write and no second
rule.

### It is the second route, not the only one

`Move to folder...` in the wish's panel (§5) stays, and stays complete on its own: a drag-only
affordance is half a feature, and it is the half a keyboard cannot use. Both routes reach one
command.

## 10. Out of scope, deliberately

- **Folders in import and export.** The seven formats carry cards, and a folder is not one.
- **Issue #164.** Named in #165 as related and separate; it stays separate.

## 11. Tests

**Rust** — the migration reaches 23 and both objects exist; the grain index carries four terms;
an upgrade from a v22 database with wishes keeps every row and files them all at the root; the
cycle refusal (direct, indirect, and one it did not write); delete keeps its wishes and cascades
its sub-folders; `wishlist_set_folder` **merges** rather than failing on a taken grain;
`wishlist_set_printing` pins, un-pins, merges, and refuses an unknown card id and an
oracle-less wish; `wishlist_add` with a folder id makes a **second** row beside a root wish for
the same card; `wishlist_list` honours `folderId` and `flatten`; `elsewhere` counts the other
folders' copies; `clear_wishlist` takes the folders.

**TypeScript** — `folderTree.ts`'s four functions keep the decks' existing test file green
unchanged (that is the proof the extraction was behaviour-preserving); `buildWishlistTargetItems`
offers an empty folder and nests; `WishlistPage` drills in, flattens, captions a flattened row
with its folder, and creates/renames/deletes a folder; `EditWish` reaches both new writes on a
pinned wish and on an any-printing one; `AllPrintingsDialog` repoints a wish and closes, and
does not repoint after a walk step.

**The drag** -- `readWishDrag` accepts a well-formed payload and refuses a malformed one field
by field; a **pinned** wish's payload carries both marks and `readDragData` still reads it as a
card, which is the proof the deck drop targets did not regress; an **any-printing** wish's
payload carries only the wish mark and `readDragData` returns `null` for it; a folder card
refuses the wish already filed in it; a drop calls `wishlistSetFolder` with the folder's id, and
a drop on the breadcrumb root calls it with `null`.

## 12. Docs to update

- `docs/reference/decks-storage.md` — the wishlist tables section, if it names the grain.
- A new `docs/reference/wishlist.md`, or a section wherever the wishlist's storage is currently
  written down, carrying: the folder tables, the four-term grain and **why** it has four terms,
  the merge rule shared by the two new writes, and the root-add duplicate consequence in §1.
- `src/features/wishlist/` gets no `CLAUDE.md` of its own unless the rules there outgrow this
  document.
