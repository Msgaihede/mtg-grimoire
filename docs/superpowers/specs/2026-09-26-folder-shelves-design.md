# Shelves: every card below where you stand, grouped by the folder it is in

> I want to re-design the way cards are displayed in folders in the wishlist and collection. If the
> user organizes all their cards into folders, the page remains empty, except for the folders.
> Lets come up with a design that fixes that, while still keeping folders friendly and readable.
> It should be easy to tell which folder a card belongs to. It should support multiple levels of
> nested folders (it can technically go infinite).

Brainstormed with Markus on 2026-09-26. The design was drawn on the published design system and the
artboards are the visual record: [Cards in Folders](https://claude.ai/artifact/6o7vAg5MaYMbaiwPZe3URP).
Three directions were drawn — **A · Shelves**, **B · Folder tree** (a tree rail beside a flattened
wall) and **C · Trays** (folders as card piles that open in place as nested containers). A was
chosen and B and C were deleted from the canvas; this document is A as it was refined afterwards.
The canvas's first frame is the problem as it stands today.

**Vocabulary this spec adds, so it cannot drift.** A **shelf** is one folder's section of the wall:
its **heading** and the cards filed directly in it. Shelves nest. **Not sorted** is the shelf of
cards filed in no folder, and it is the only shelf that is not a folder. "Section", "group" and
"band" are not synonyms for it — a *band* is the deck editor's `{kind:"group"}` table row, which this
design reuses as the table's drawing of a heading (§5.8), and the *folder band* is the thing being
removed (§7).

---

## 1. Why the page goes empty

**Neither page draws a card from a subfolder at the level you are standing on.** Every level is a
drill-down: the list query asks for that folder's *direct* members and nothing below.

- The collection root sends `rootOnly: true` whenever Flatten is off
  (`src/features/collection/useCollection.ts:352`), which `collection_list`'s `scope()` turns into
  `e.folder_id IS NULL` (`src-tauri/src/collection.rs:1994–1998`). Inside a folder, `folder_id = ?`.
- The wishlist root asks for wishes filed nowhere (`useWishlist.ts:274`; `w.folder_id IS ?` in
  `wishlist_scope`, `wishlist.rs:1292–1294`).
- With everything filed, both pages draw the figures band, the filter bar, the breadcrumb, a folder
  band capped at 176px (`max-h-44`) and nothing else. `statusOf` returns `""` for that state on
  purpose (`CollectionPage.tsx:4021`, `WishlistPage.tsx:2383`).
- The wishlist's header then reads **Wishes 0** and **Total cost —**, because its figures describe
  the level being drawn (`WishlistPage.tsx:1616`). A reader with thirty wishes is told they have none.
- Flatten is the only escape, and it defaults **on** for the collection and **off** for the wishlist
  (`src/lib/store.ts:1425,1429`) — so the wishlist shows the empty page by default.

## 2. Decisions

| # | Decision | Chosen over |
| --- | --- | --- |
| 1 | **Shelves**: the wall shows every card at and below the current level, one shelf per folder, in tree order | a folder-tree rail over a flattened wall (B); folders as openable piles (C) |
| 2 | **Flatten is removed.** Shelves is the only way either wall is drawn | keeping Flatten as a "no headings" mode, off by default |
| 3 | Cards in no folder come **first**, under a heading reading **Not sorted** | last, after the folders |
| 4 | While any search or filter is active, **collapse is ignored**: every shelf with a match is open, shelves with none are hidden, headings read "3 of 42" | respecting collapse and showing a match count on the shut heading |
| 5 | Collapse is remembered **on this device only**, per window | a synced column on the folder row |
| 6 | **Clicking a folder's title opens it**; there is no Open button | a separate Open button on every heading |
| 7 | **Add folder** and **Rename** are buttons on every heading of the reader's own folders; **Add folder** is also on the path row, for the level you stand on | Add folder behind a hover control, Rename in the ⋯ menu |
| 8 | **Expand all** and **Collapse all** sit on the path row | Collapse all only |
| 9 | Folders are **reordered by dragging their heading**, and every shelf folds to its heading for the length of that drag | leaving the page unchanged and auto-scrolling |
| 10 | The shelf list is **built in TypeScript** and sent to Rust as an ordered list of folder ids; Rust orders by position in it | a recursive CTE in Rust working out tree order |
| 11 | A collection tile is **per folder**: the same printing in two folders is one tile on each shelf | merging copies across folders as the flattened wall does today |

## 3. What the reader sees

### 3.1 The wall

Standing at any level — the root, or a folder the reader has opened — the wall is, top to bottom:

1. The cards filed directly at this level. At the root they are the **Not sorted** shelf, which is
   drawn only when it has cards. Inside an opened folder they sit directly under the path row with no
   heading of their own, because the path row already names the folder they are in.
2. Each subfolder as a shelf, depth-first, siblings in the reader's own order (`folderTree.ts`'s
   `order()`: `sortOrder`, then name, then id). A shelf's cards come before its subfolders' shelves.
3. **At the root only**, the app-owned folders under their own labels, after the reader's folders:
   - Collection: **Decks** — one shelf per deck group, then **Recently removed**, sorted by name as
     `PinnedFolders` does today (`PinnedFolders.tsx:79–89`).
   - Wishlist: **Managed by decks** — one shelf per managed folder.

The reader's sort (name, price, set…) applies **within** each shelf. Shelves never reorder by it.

### 3.2 Headings

One row, left to right:

- a collapse chevron (`aria-expanded`, named "Collapse Binder" / "Expand Binder");
- the folder glyph — open and gold while expanded, closed and dim while collapsed; `Layers` for a deck
  group or a managed folder, `Inbox` for Recently removed, as today;
- **the path, as buttons**: ancestors dim, the folder itself in text colour. Clicking the folder's
  own name opens it (§3.7); clicking an ancestor opens that ancestor. Its accessible name is the
  folder's name, described as "Open folder";
- a lock glyph on a locked collection folder; a **Managed** pill on a managed wishlist folder;
- the figures: `42 cards · $2,490.00 · 3 unpriced` / `6 wishes · $312.00 · 1 unpriced`; under a
  filter, `3 of 42 cards`;
- when collapsed, three or four 22×31 thumbnails of the shelf's first cards, `aria-hidden`;
- a hairline to the right edge;
- **Add folder** and **Rename** (ghost buttons, reader's folders only);
- **⋯**.

The ⋯ menu keeps what the folder card's menu held, minus Rename, plus the keyboard's way to reorder:

- Collection: Move to folder… · Move up · Move down · Lock folder / Unlock folder · — · Delete…
  (with today's greyed reasons: `CollectionPage.tsx:1806–1917`).
- Wishlist: Move to folder… · Move up · Move down · — · Clear… · Delete… (`WishlistPage.tsx:1108–1186`).

App-owned shelves (deck groups, Recently removed, managed folders) draw no Add folder and no Rename,
cannot be dragged, and keep whatever menu they have today. **Not sorted** is not a folder: its title
is plain text, and it has no buttons and no menu — only its chevron.

### 3.3 Nesting, at any depth

- A subfolder's shelf sits under a 1px rail (`border-border`) that starts under its parent's chevron,
  indented 32px per level.
- **Indentation stops at three levels.** A deeper heading keeps the third level's indent and shows its
  path from the deepest indented ancestor instead: `Fetchlands › Foils › Showcase`. So the wall never
  runs out of width, whatever the depth.
- **A sticky bar** at the top of the wall names the shelf the reader is scrolled inside, as path
  buttons, with a **Top** button (§5.3).
- Opening a folder resets the indentation, which is the reader's escape from a very deep chain.

### 3.4 Collapse

- Defaults: the reader's folders and Not sorted start **expanded**; deck groups, Recently removed and
  managed wishlist folders start **collapsed** — they are built decks and derived lists, not binders.
- The reader's choice is remembered per folder, on this device, per window (§5.7).
- **Expand all** and **Collapse all** are on the path row and act on every shelf below the current
  level, app-owned ones included.
- **While any search text or filter is active, collapse is suspended** (decision 4): every shelf with
  a match is drawn open, every shelf without one is hidden, and headings read `3 of 42`. The stored
  state is untouched and comes back when Reset all or a cleared box empties the filter.

### 3.5 The path row

Left: the breadcrumb, unchanged — `Collection`, or `Collection › Binder` inside a folder, each
ancestor a button and a drop target. Right: **Add folder**, **Expand all**, **Collapse all**. The Move
/ Delete / Clear strip for picked cards keeps its place directly beneath it.

No folder control sits in the filter bar — the fence `src/CLAUDE.md` records ("not among the
filters") is unchanged.

### 3.6 Header figures

The figures band counts **everything the wall covers** — this level and every shelf below it,
collapsed ones included — or, under a filter, everything that matches. That is what turns
**Wishes 0** into the reader's real count. The wishlist's **Total cost** stops being a sum over the
rows that happen to be loaded (`WishlistPage.tsx:810–818`, and its "N of M counted" note): it is
summed from the shelf counts (§4.2), which cover the whole scope.

### 3.7 Opening a folder

Clicking a heading's title — or a path segment on a heading, the path row or the sticky bar — opens
that folder. The page then **is** that folder: the path row reads `Collection › Binder`, the figures,
the search and **Share** cover only it, its own cards come first, its subfolders become the top-level
shelves, and **Add folder** on the path row creates inside it. Escape walks one level up — the
`"navigation"` rung, unchanged. Deck groups and managed folders open exactly as a pinned entry does
today.

### 3.8 Adding and renaming

- **Add folder** on the path row adds a folder at the current level; on a heading, inside that folder.
  The new folder appears where it will live — last among its siblings — as a heading whose name is a
  `FolderNameField` with ✓ and ✕, over an empty shelf. Typed on the line the name will occupy, as
  `NewFolderCard` does today; the caret's return is `useFolderFieldReturn`, unchanged.
- **Rename** turns that heading's name into the same field, keeping the figures visible beside it.
- **The `canMakeFolder` gate is unchanged**: no Add folder inside a deck group, Recently removed or a
  managed folder.
- **An empty folder** is a heading over a dashed box: "Empty — drag cards here, or pick cards and choose
  Move to folder…". The dash is the container vocabulary the folder cards already use; the box is a
  drop target for cards (§6).

### 3.9 Reordering and moving folders

- A reader's folder is moved by **dragging its heading**, anywhere but its buttons. Released over
  another heading: the top quarter puts it **before** that folder, the bottom quarter **after** it
  (same level), the middle **inside** it as its last subfolder. `folderDrag.ts`'s edge zones
  (`EDGE_ZONE 0.25`, `folderEdge`) on the vertical axis. A gold line marks before/after — `FolderDropLine`,
  as the folder cards draw it today (`CollectionFolderCard.tsx:476`) — and the heading's edge goes
  gold (`DROP_EDGE`) for inside. A folder can never land in itself or below.
- **For the length of that drag every shelf folds to its heading**, so the whole tree is on screen and
  every target is a short move away. The fold is a render-time override that writes nothing, and the
  page stays anchored on the dragged heading as it folds and unfolds.
- **Move up / Move down** in ⋯ are the non-drag path (WCAG 2.5.7), written through the same
  `placeFolder` as a before/after drop. **Move to folder…** stays for moving anywhere.
- App-owned folders cannot be dragged.

### 3.10 Table view

The same shelves, drawn as heading rows spanning every column, followed by that shelf's card rows.
Same collapse, same rails (capped at three), same actions, same sticky bar — pinned under the column
header. The canvas's **six levels deep, table view, scrolled** frame is the reference.

## 4. Data — Rust supplies the facts

### 4.1 One new, opt-in field: `shelves`

`CollectionQuery` (`collection.rs:1619–1742`) and `WishlistQuery` (`wishlist.rs:93–129`) gain
`shelves: Option<Vec<i64>>`, serde-defaulted to `None`.

- **`Some(list)` is an ordered list of shelves to return**: folder ids, with `0` standing for the
  shelf of rows filed nowhere (`folder_id IS NULL`). The folder predicate becomes membership of
  `coalesce(folder_id, 0)` in the list, and the ORDER BY is **position in the list** first, then the
  existing sort terms, then the unique `id` tiebreak `sorting::order_by` already appends.
- When `shelves` is present, `folder_id`, `root_only` and `flatten` are ignored. A test pins the
  precedence.
- **`None` is today's behaviour, byte for byte.** That is the rule `collection-folders.md` sets for any
  new folder mode (its lines ~1865–1907): the text mirror, the export sweep, the deck editor's
  Collection Search, the importer and `wishlist_optimize` all send an unasked query and must keep
  meaning "every folder".
- Paging is unchanged: `LIMIT/OFFSET`, 100 rows a page, `total` over the same scope.

**Why TypeScript builds the list (decision 10).** The tree already lives in `buildFolderTree`
(`src/lib/folderTree.ts:127–162`) and `flattenFolders` (`:166`) is already the depth-first walk. The
folder docs say SQL that walked the tree would be a second implementation of it
(`collection.rs:1659–1661`, `collection-folders.md` ~1629–1640). It also sidesteps a live mismatch:
SQL orders siblings `sort_order, id` (`collection_folders.rs:300`) while TS orders them `sortOrder,
name, id` (`folderTree.ts:113–115`) — with the list coming from TS, only one of them ever decides.

The page sends **only the shelves it will draw expanded**; a collapsed shelf's cards are never fetched.

### 4.2 Per-shelf counts: `collection_shelf_counts`, `wishlist_shelf_counts`

Same query, same `scope()` / `wishlist_scope` — search and filters included — with `shelves` set to
**every** shelf at and below the level, collapsed ones too. Grouped by `coalesce(folder_id, 0)`, one row
per non-empty shelf:

| Field | Collection | Wishlist |
| --- | --- | --- |
| `tiles` | `count(DISTINCT card_id, finish)` — what the grid draws (§5.6) | rows |
| `copies` | `sum(quantity)` | `sum(quantity)` |
| `value` | priced sum, `NULL` when nothing is priced | cost, as `folder_summary` has it |
| `unpriced` | rows without a price at the marketplace | as today |

It is what makes four things possible: headings' `3 of 42` under a filter (the `42` is the existing,
unfiltered `folder_summary` + `subtotalsOf`, which stays); hiding shelves with no match; **placing
every heading in the virtual grid before a page of cards has arrived** (§5.2); and the header figures
(§3.6).

### 4.3 Summary

`collection_summary` already takes the list's query (`useCollection.ts:451–461`), so it takes
`shelves` with it — every shelf at and below the level — and Cards / Unique / Value / For trade then
cover the whole wall.

### 4.4 Performance to measure before merge

Ordering by a computed list position defeats any index the sort could have used. Measure the
`shelves` list and the counts on the real dev database (`src-tauri/target/debug/data/`) and on a
synthetic 100k-entry collection, **debug and release named**, against today's `collection_list` at the
same size. If the position lookup is the cost, a `json_each` join materialised into a temp b-tree is
the first thing to try.

## 5. The page — TypeScript draws the conclusions

### 5.1 The shelf list (pure)

One pure function per page builds, from the folder tree, the collapse state, the level and whether a
filter is active: the ordered list of shelves (id, path, depth, kind, collapsed, locked, managed), the
ids to send as `shelves` (expanded only) and the ids to count (all). Pure, so it is a truth table in
Vitest — depth-first order, the root-only app-owned groups, Not sorted first, filter suspends collapse.

### 5.2 `CardGrid` gains sections, opt-in

`CardGrid` is virtualised by `@tanstack/react-virtual` over rows of `columns` tiles, one fixed
`estimateSize` per row (`CardGrid.tsx:998–1006`), with `index * columns` arithmetic in four places
(`:1160–1163`, `:1218`, `:1299`, `:1382`). It gains an optional `sections` input; **without it the grid
is exactly today's**, for the search page, the Tags page and the three docked search columns.

With sections, the virtualiser runs over a layout table of rows, each either a **heading** or a run of
tiles from **one** shelf — a shelf's last row may be short and two shelves never share a row. Each row
kind has its own size estimate, and a structure key re-measures when the shelves change (as
`VirtualTable`'s `heightKey` does). Shelf sizes come from the counts (§4.2), so headings are placed
before cards arrive; a tile whose page has not landed draws as an empty frame. `needsNextPage` keeps
reading the last rendered tile. Ctrl+wheel zoom still resizes tiles only; headings are chrome and
stay put.

### 5.3 The sticky bar

CSS `sticky` cannot work on rows that are `absolute` and `translateY`'d. The bar is an overlay above
the scroller, derived from the first visible row's shelf, on `LAYER.header`: its path as buttons, and
**Top**. It is also a **permanent** drop target for cards — see §6 for why that matters.

### 5.4 Keyboard

`gridNav`'s `nextGridIndex` moves ±1 / ±columns over one continuous rectangle. It is rewritten over
the layout table: Left/Right walk the depth-first order; Up/Down move within a shelf and, past its
edge, to the nearest column of the next or previous shelf's row, skipping headings and collapsed
shelves. Headings' controls are ordinary Tab stops. Pure, so it gets a truth table.

### 5.5 Selection

Ctrl/Shift ranges (`lib/multiSelect.ts`) run over loaded tiles in shelf order. Keys must be unique,
which §5.6 makes true for the collection. A range never includes a collapsed shelf's cards, because
they were never fetched.

### 5.6 A collection tile is per folder (decision 11)

The `tiles` memo (`CollectionPage.tsx:1117–1189`) groups rows by `tileKeyOf(cardId, finish)`
(`src/lib/tileKey.ts:43`) across folders. On a shelf a tile must belong to one shelf, so the key gains
the folder: `tileKeyOf(cardId, finish, folderId)`, with the folder optional so
`collectionTiles.ts`'s `foldCopies` — the deck editor's docked collection column, a different wall —
keeps merging.

- `OwnedBadge` counts that folder's copies; `copiesByTile`, `stepperByTile` and `PickCopies` lose the
  cross-folder dimension, and the deck-group stepper fence and the "never on a mixed tile" rules get
  simpler, because no tile mixes a deck group with anything.
- The open card's ring is rebuilt from `(selectedCardId, paneFinish)` (`CollectionPage.tsx:3391`); it
  matches on card and finish and so **rings every tile of that card on screen**.
- The wishlist is unaffected: one row is one tile already (`WishlistGrid.tsx:350`).

### 5.7 Collapse memory

One `app_meta` key holding a JSON map per page of `folderId → collapsed`, **only for folders the reader
has moved off their default** (§3.4). Read and written the `useSearchOpen` way — one query at
`staleTime: Infinity`, an optimistic `setQueryData`, then the IPC write, prefetched in `AppShell`. It
joins **the per-window list** in `docs/reference/multi-window.md` (~lines 224–235) and must not sit
under a query-key root `lib/crossWindow.ts` maps to a table (~237–243). Ids of deleted folders are
ignored rather than pruned.

### 5.8 `VirtualTable` gains heading rows

Following the deck editor's `TableView` (`features/decks/views/TableView.tsx:84–99`, `:230–243`,
`:745–803`): a `{kind: "group"} | {kind: "card"}` row union, a heading drawn as one `role=cell` with
`aria-colspan`. `CollectionTable` and `WishlistTable` pass it; `aria-rowcount` counts the headings;
`onActivate`, `isSelected` and `rowClassName` never receive a heading row.

## 6. Drag and drop

Every target is `useDndDropTarget` (`lib/dndTarget.ts:37–141`), and **a target that mounts in the middle
of a drag never arms** — `armed` is set only at `dragstart`. In a virtualised wall, headings mount as
they scroll in, so every shelf target uses the callback-ref form (`useDndTargetRef`, `:160`) or re-arms
on mount, and the sticky bar is a permanent target.

| Target | Takes | Does |
| --- | --- | --- |
| a heading, expanded or collapsed | a card | files it into that folder (`useCollectionDropTarget` / `useWishDropTarget`) |
| a heading | a folder | before / inside / after by edge zone (`useFolderDropTarget`, vertical) |
| an empty shelf's dashed box | a card | files it there |
| the sticky bar | a card | files it into the shelf the reader is inside |
| a segment of the path row | a card, **and now a folder** | files / moves it there — the folder half is what `ParentFolderCard`'s "Up one level" did. A heading's lead segments and the sticky bar's segments are buttons only: the heading and the bar are each one target, for their own folder |

Headings of the reader's folders are drag sources for folders (`folderDraggable`), and dragging one
folds the wall to headings (§3.9). A card drag folds nothing.

## 7. What is removed, and what survives

**Removed from both pages:** the folder band (`CollectionFolderCard` / `WishFolderCard` tiles in a
176px scroller), the `NewFolderCard` tile, the `ParentFolderCard` "Up one level" tile, the
`PinnedFolders` and `ManagedWishFolders` strips (their folders become shelves under **Decks** and
**Managed by decks**), and Flatten: `FilterBar`'s `flatten` prop, the stores' `collectionFlattened`
and the wishlist's flag, and the `flatten_state` read. The Rust `root_only` and `flatten` fields stay —
other callers use them.

**One behaviour moves rather than survives:** standing *inside* Recently removed, the band used to show the reader's top-level folders so a card could be dragged straight back into a binder (issue #209). Shelves has no band; the same drag now happens at the root, where Recently removed is a shelf on the same wall as the binders' headings.

**Survives:** `folderFace` and the totals type in `CollectionFolderCard.tsx`, which
`features/home/widgets/FoldersWidget.tsx:70` imports; `ParentFolderCard` itself, whose words the Decks
page reuses; `FolderNameField` and `useFolderFieldReturn`, now on headings; the Move / Delete / Clear
strip; `ShareFolderMenu` in the figures band, covering the level the reader stands on.

## 8. Testing

- **Rust** — the `shelves` field: order is list position, then sort, then id; `0` is the unfiled shelf;
  precedence over `folder_id` / `root_only` / `flatten`; an absent field is unchanged for every existing
  caller (the existing mirror, export and import tests are the fence). Shelf counts honour search and
  every filter; `tiles` counts distinct `(card_id, finish)`; empty shelves return no row. Summary with
  `shelves` covers the subtree.
- **Pure TS** — the shelf list builder (§5.1); shelves → layout rows, including short last rows and
  row heights; the keyboard truth table (§5.4); collapse defaults by folder kind; the three-level
  indentation cap and the relative path it falls back to.
- **Pages** — about 90 `CollectionPage.test.tsx` tests and about 60 `WishlistPage.test.tsx` tests pin
  the folder band and Flatten today. They are rewritten against headings, not deleted: every behaviour
  they cover (folders, New folder → Add folder, renaming, locking, rearranging, Escape, sharing, managed
  folders) still exists. `lib/dndAccessibility.test.tsx` renders both folder cards and moves to headings.
- **Stories** — the Flattened story goes; `CollectionPage.stories.tsx` and `WishlistPage.stories.tsx`
  gain shelves stories: everything filed, deep nesting past three levels, a filter suspending collapse,
  a folder being added, a folder being renamed, a heading mid-drag.
- **The shipped window** — the suites cannot see any of: the sticky bar tracking its shelf, a heading
  that scrolls in mid-drag arming, the fold-on-drag anchor, arrow keys across a short row, Ctrl+wheel
  with headings, and the empty-page case this exists to fix. One CDP pass drives all of them
  (`docs/reference/live-ui-verification.md`).

## 9. Docs to update in the same branch

- `docs/reference/collection-folders.md` and `wishlist-folders.md` — shelves, the `shelves` field and
  its precedence, the counts commands, Flatten's removal, per-folder tiles.
- `docs/reference/multi-window.md` — the new per-window `app_meta` key.
- `src/CLAUDE.md` — the paragraph about `+ New folder` being a tile of the folder wall, and
  `ParentFolderCard` being the first tile, describe a wall that no longer exists.

## 10. Build order

One plan, in this order, because each step is what the next compiles against:

1. Rust: the `shelves` field on both lists and the summary; the two counts commands; the `ipc.ts` mirror
   and the `ipc.test.ts` fence rows for both new structs.
2. `CardGrid` sections, the layout table and the keyboard rewrite — behind the opt-in, so every other
   wall is untouched.
3. The wishlist page — simpler, because its tiles never merged.
4. The collection page — per-folder tiles.
5. `VirtualTable` heading rows and both tables.
6. Drag and drop onto headings, fold-on-drag, Move up / Move down.
7. Docs, then the live pass.

## 11. Open risks

- **Query cost** (§4.4) is unmeasured. It is the one thing that could force the list order back into
  SQL.
- **Scroll anchoring.** Three events move content above the reader: counts arriving after first paint,
  a filter opening collapsed shelves, and the fold / unfold of a folder drag. Each needs the reader's
  current shelf held still, and only the live pass can prove it.
- **The blast radius is the page tests.** Roughly 150 tests move from the band to headings; the risk is
  losing a behaviour silently while rewriting, so each rewritten block is checked against the one it
  replaces rather than against the new code.
