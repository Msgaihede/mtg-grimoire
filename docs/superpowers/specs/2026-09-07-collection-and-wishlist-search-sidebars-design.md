# Search sidebars for the collection and the wishlist

**Date:** 2026-09-07
**Status:** approved, not implemented
**Issue:** [#356](https://github.com/Msgaihede/mtg-grimoire/issues/356)

## 1. What this is for

There is no way to add a card to the collection or to the wishlist from the page that shows it.
Both pages say so themselves, in their own empty states:

* `CollectionPage.tsx` — *"Nothing here yet. Add cards from search, or import a collection file."*
* `WishlistPage.tsx` — *"Nothing on your wishlist yet. Add cards from search with the + on any row
  or tile."*

A reader filing a binder therefore leaves the binder, searches, files at the root, comes back, and
moves what they just filed into the folder they were standing in. The deck editor solved this for
decks in August with a docked search column; this spec gives the same column to the two lists that
still send the reader away.

**Scope: the collection page and the wishlist page.** The deck editor's panel changes only by
being refactored out from under itself (§3), and its behaviour does not move at all.

### 1.1 The rule the sidebar has to earn

`src/CLAUDE.md`: *"A surface opened from a view is a centred modal over a scrim, not a docked
column — unless the reader works **out of** it while editing beside it."* A search whose tiles are
drag sources into the folder wall beside them is worked out of, which is the deck search column's
own justification word for word. A sidebar that could only be consulted would have to be a
`Dialog`, and this one is not.

## 2. What a reader gets

A collapsible column on the right of the collection and of the wishlist, structurally the deck
editor's:

* A chevron and a heading. Collapsed it is a 36px rail with the heading turned on its side.
* One card search over every printing Scryfall has published — `FilterBar` and a wall of art, the
  same two components every other card list in this app draws.
* A `+` on each tile that files that card **into the folder the reader is standing in**, and a
  folder row in the popup to send it somewhere else.
* Each tile is a drag source; dropping one on a folder card or a breadcrumb segment files it
  there instead.
* Draggable from its left edge, remembered open or shut across restarts.

### 2.1 No tab strip

The deck panel has two tabs — `Collection` searches the reader's own rows, `All cards` searches
everything — because a deck is built out of cards you already have. Neither tab makes sense here:
on the collection page the first would search the very list already on screen, and on the wishlist
it would search a list the reader is not filling. **These panels are the `All cards` tab and
nothing else**, which also gives back the 141px the strip costs at the panel's 206px floor.

### 2.2 The destination is the page, not a choice

`AddToCollectionButton`'s popup carries a `Collection` / `Wishlist` switch today, because on the
search page a reader genuinely is choosing between two lists. In these sidebars the page has
already answered: the collection's sidebar adds to the collection, the wishlist's to the wishlist.
The switch is therefore **locked**, which is what keeps the folder default unambiguous — the two
folder trees are different tables, so a popup that could flip lists mid-form would need two
defaults and a picker that swapped trees under the reader's hand.

## 3. One panel, three surfaces

`DeckSearchPanel.tsx` is 1595 lines and roughly two thirds of it is chrome that has nothing to do
with decks. Copying that twice would be the mistake this repo has already made and undone twice —
`CollectionSearchTab`'s own filter row, and the deck Grid view's inline card frame, both deleted
because *a resemblance is N independent decisions that happen to agree today*. So the chrome is
extracted and all three surfaces draw it.

### 3.1 `features/search/CardSearchPanel.tsx` — the shell

Everything the deck panel does that is not about a deck:

| Piece | Today at |
| --- | --- |
| The three-state `<section>` (railed / docked / drawn-over) and its class recipe | `DeckSearchPanel.tsx:753`–`:785` |
| The `w-9` flow-holder that keeps the rail's width while the panel is an overlay | `:735` |
| The disclosure — one `ChevronLeft` rotated, `aria-expanded`, `aria-disabled`, the `NO_ROOM` tooltip | `:635`–`:716` |
| The title row: centred heading, the centring shim, the vertical rail heading | `:812`–`:881` |
| `ResizeHandle` — `role="separator"`, arrows, Home/End, pointer capture | `:1110`–`:1207` |
| Width `useState` and the clamp split (the environment clamps what is *drawn*, a drag clamps what is *stored*) | `:551`–`:570` |
| `open` / `shown` / `over` / `overlaid` and the mount-vs-hide gate | `:515`–`:525`, `:910`–`:911` |
| The caret hand-back when a card closes over a railed panel | `:598`–`:617` |

Props: `title`, `sectionLabel`, `surface` (the `data-search-over` value), `open`/`setOpen` hoisted
so each surface persists its own, `roomy`, `overWidth`, `maxWidth`, an optional `tabs` slot, and
`children` for the body.

**`data-search-over` is reused rather than tripled.** Its doc warns that a second element
answering `[data-search-over]` would make the deck's probes ambiguous — but the three panels live
on three routes and can never be on screen together, and the attribute's *value* already
discriminates. `"deck"` keeps its meaning; `"collection"` and `"wishlist"` join it.

**Three gates, not two, and they must stay three.** `open` mounts the body — a page nobody
searched from issues no `search_cards`. `shown` merely hides it, so a window narrowing keeps the
reader's typed query, filters and fetched pages. `overlaid` decides position and width source.
Folding `open` and `roomy` into one gate throws a reader's search away on a *resize*, which is the
single most load-bearing assertion in `DeckSearchPanel.test.tsx`.

### 3.2 `features/search/CardSearchBody.tsx` — the body

The wall and its furniture, in the order the deck panel draws them: the add-failure banner
(`AnimatePresence` + `statusLine`), `FilterBar`, the one `role="status"` line through `summaryOf`,
the refresh/next-page failure with its `Try again`, `CardGrid`, and the `pricesAsOf` line. Slots
for what differs: `action` (the tile's button), `badge`, `tileRef` (the drag registration),
`selectionScope`, `zoomSection`, `labels`, and the `useCardSearch` options (`defaultFormat`,
`availableForDeck`).

`layoutToggle={false}` stays on all three: a panel has no table, so the grid-or-table pair would
move a stored preference and change nothing visible.

### 3.3 What stays deck-shaped

`DeckSearchPanel` keeps its tab strip, `CollectionSearchTab`, `categories`/`targetCategoryId`/
`AUTO_CATEGORY`/`autoCategoryFor`, `deck_add_card`, the landed glow, `availableForDeck`, and
`defaultFormat` seeding from the open deck's format. None of it moves and none of its 50 tests
change — they are the proof the extraction was faithful.

## 4. Layout

Both pages are `flex-col` from their root down; there is no row to hang a column off. Both have
the *identical* work column, and it is the only thing that has to move:

* `CollectionPage.tsx:2449`–`:3045`
* `WishlistPage.tsx:1330`–`:1639`

both `<div className="flex min-h-0 flex-1 flex-col gap-2">`. Each becomes:

```tsx
<div ref={deskRef} className="flex min-h-0 flex-1 gap-4">
  <div className="flex min-w-0 flex-1 flex-col gap-2"> …everything that is there today… </div>
  <div ref={dockRef} className={cn("sticky top-0 flex shrink-0 self-start", over && LAYER.popup)}>
    <CollectionSearchPanel … />
  </div>
</div>
```

`min-w-0` on the content side is not optional — a flex item cannot shrink below its own
min-content, and an overhang inside `AppShell`'s `overflow-auto` `main` becomes a horizontal
scrollbar across the whole page. That is the 1024px-floor failure `ManaValueChips` already shipped
once.

**The figures band and the page's own `FilterBar` stay full width above the row.** `FilterBar`
lays itself out in four `@container/fb` bands at 640/900/1500, so taking width off it rearranges
the bar rather than merely shortening it.

### 4.1 The dock's height

The panel's wall is `min-h-0 flex-1` and draws at nothing in an unsized host. `DeckEditor` sizes
its dock imperatively (`DeckEditor.tsx:1852`–`:1893`) because CSS cannot say "the scroller's
visible height, less however much of the page sits above this row".

The same problem with a different scroller: the deck editor's own page section is
`overflow-y-auto`, while these two pages scroll in `AppShell`'s `main`. So that effect becomes a
shared `useDockHeight(dockRef, anchorRef)` hook that finds the nearest scrolling ancestor —
`CardGrid` already has `nearestScroller` for this — and all three sites call it.

### 4.2 `roomy`, and the overlay

Each page measures its row with a `ResizeObserver` and hands the panel one number, exactly as
`DeckEditor` does:

```
maxWidth = min(⌊viewport / 2⌋, deskWidth − DESK_GAP − LIST_FLOOR)
roomy    = deskWidth === 0 || maxWidth >= MIN_PANEL_WIDTH_PX
```

`viewport` is `document.documentElement.clientWidth`, never `innerWidth` — the latter counts the
page scrollbar and caps the panel 8px too wide (632 vs 640, measured on the deck editor).
`deskWidth === 0` reads as roomy, which is what keeps jsdom and the first paint out of the way.

`LIST_FLOOR` is the width the card list must keep. The deck's is `DECK_FLOOR = 192`, one stack
column. These pages need one card column plus the folder wall's `minmax(180px,1fr)` cell; the
opening figure is **192** and it is to be re-measured in the shipped window before it is written
down as anything else.

**The overlay ships too.** Below the floor the shell already knows how to draw itself *over* the
list at the full row width, and the plumbing is one more number from the page. On a phone that is
the difference between a sidebar that exists and one that is only ever a refused chevron.

## 5. The add

### 5.1 The wire is already there

`EntryInput.folderId` and `WishInput.folderId` both exist and are both documented as part of the
row's **storage grain** — filing the same printing into two folders is two rows, never one row
that moves. `useCardMenuDeps` already passes them. `AddToCollectionButton` simply never has, which
is why every `+` in the app files at the root today.

`AddToCollection.tsx:172`'s comment says *"`collection_add` takes no folder"*. That is wrong about
the command and true only of that call site; it is corrected in the same commit.

### 5.2 `AddToCollectionButton` grows three optional props

| Prop | Meaning |
| --- | --- |
| `folderId?: number \| null` | Where a press files. Absent keeps today's behaviour — the root. |
| `folders?: readonly CollectionFolder[] \| readonly WishlistFolder[]` | The tree the override picker offers. Absent draws no picker. |
| `lockMode?: Mode` | Pins the destination list and hides the switch. |

Every one optional, so `SearchPage` and `TagResults` are untouched and keep filing at the root.

The override is a `Folder` row in the popup that swaps the panel body in place for `MoveToFolder`
in its `inline` mode — the shape `EditWish`'s own folder row and `PickCopies` already use, and
deliberately not a nested popup, so there is one Escape rung rather than two.

The button's accessible name states the destination, which is the deck panel's rule
(`Add Ancient Tomb to Land`): **`Add Lightning Bolt (LEA 161) to Rares`**, and `to Collection` /
`to Wishlist` at the root.

### 5.3 What "the folder the reader is standing in" means

`folderId` is a `useState` inside `useCollection` / `useWishlist` — `number | null`, where `null`
is *the root: the copies filed nowhere*, a real destination rather than "nothing chosen".
Deliberately not persisted, because a folder restored at launch opens the app somewhere the reader
did not navigate to.

**When the page is flattened the default is the root.** Flatten means "show me everything"; the
breadcrumb reads `Collection · all folders` and there is no folder on screen to be standing in.
The collection ships flattened, so out of the box this behaves exactly as it does today and the
folder default starts working the moment a reader opens a folder.

**Only `user` folders are offered.** Deck groups and `Recently removed` are folder *kinds* the
cabinet draws but nothing may be filed into by hand; `buildFolderTree(userFolders(folders), [])`
is the existing filter and the picker uses it.

## 6. Bookkeeping each surface invents for itself

| Thing | Collection | Wishlist | Why not shared |
| --- | --- | --- | --- |
| `ZoomSection` | `collectionSearch` | `wishlistSearch` | `ZOOM_SECTIONS` is a census and `DEFAULT_SECTION_ZOOMS` is spelled as a literal precisely so a new section is a compile error until somebody says what it starts at. |
| `selectionScope` | `collection-panel` | `wishlist-panel` | Two walls on one screen must pass different scopes, or picking in the sidebar puts the binder's selection down. |
| `FilterLabels.idStem` | `collection-add` | `wishlist-add` | Two mounted filter rows would otherwise share `id`s. The box keeps the app-wide name `Search cards`, which is unique on each page because the page's own box is `Search your collection` / `Search your wishlist`. |
| `data-search-over` | `collection` | `wishlist` | One attribute, three values (§3.1). |
| Section `aria-label` | `Add cards to your collection` | `Add cards to your wishlist` | Distinct names for the probes. |

## 7. Remembering which way the panel was left

`deck_search_open` is an `app_meta` row holding `"1"`/`"0"`, with a command pair of its own. Two
more surfaces asking the same question would be three rows, six commands, three query keys and
three prefetches for one fact. It becomes **one keyed map**, which is the shape this crate already
uses three times — `zoom.rs`, `listview.rs` and `flatten.rs`.

`src-tauri/src/searchopen.rs` is `flatten.rs` copied: the same `bool` map, the same two rules.
**Reading can never fail** — a missing row, a row that is not JSON, an entry holding a number, all
read as "nothing stored for that section", and a section with nothing stored opens on the
frontend's own default. **Writing validates** — a blank section is refused, so the row cannot
accumulate entries every later read discards. A write preserves entries this build does not
understand, so an older build pointed at the same database does not empty the row.

Commands `search_open` / `set_search_open(section, open)`, registered in `desktop.rs` beside
`listview::` and mirrored in `web/route.rs` — `COMMANDS` plus a `match` arm each, because a name
in that list with no arm is a silent `undefined` on the far side rather than a compile error. The
`COMMANDS.len()` assertion is a 1:1 swap and should not move; if it does, **take the number from
the failure, never from arithmetic**, which is what its own comment demands.

`useDeckSearchOpen` becomes `useSearchOpen(section)` and `usePrefetchDeckSearchOpen` becomes one
`usePrefetchSearchOpen`, still mounted from `AppShell` and nowhere else. That mount is a
measurement rather than tidiness: asked by the panel instead, the read queues behind the page's
own query and lands ~700ms after the column has already been drawn the other way round, which is
how a reader who had shut it watched it thrown open and yanked closed on every deck they opened.
The write stays optimistic and deliberately un-rolled-back — a refused write costs the memory, not
the column snapping shut under the reader's hand.

### 7.1 No schema rung

`app_meta` has been schema v6's key/value table since v6, and this crate's rule for it is stated in
four places: *"no migration, because a key in a table that has existed since v6 is a preference
that cannot fail a launch."* `SCHEMA_VERSION` does not move.

**The old row is carried across by the read, not by a rung.** `stored()` falls back to
`deck_search_open` when the map has no `deck` entry — about five lines, and the bridge decays on
its own: nothing writes the legacy row again, so the first press stores the map and the fallback is
only ever consulted for a reader who has not pressed since upgrading. The alternative was a whole
schema version spent carrying one boolean, against a cost this crate has already priced at *"one
press of a disclosure that is on screen either way"*.

The dead `deck_search_open` row is left where it is. The one precedent for deleting an orphaned
`app_meta` key (v25's `deck_driven_collection`) was a passenger on a rung already doing structural
work; a standalone `DELETE FROM app_meta` rung has no precedent here.

### 7.2 The rest of the swap

`.storybook/fake/db.ts`'s field and its two handlers, modelled on `flatten_state` /
`set_flatten_state`; `db.test.ts`'s handler-count sweep; `ipc.ts`'s two wrappers and its census
paragraph, which counts these settings in prose and routes to neither CI job.

## 8. The drag

### 8.1 Its own mark, composed into one record

Six independent drag marks exist, each under its own key, each read field by field. The house
style for a new one is a new module — `collectionDrag.ts` and `wishDrag.ts` are the template:
`features/search/searchCardDrag.ts`, with a mark string, a key that is none of the five taken, a
`SearchCardDrag` interface, a `searchCardDragData()` and a field-by-field `readSearchCardDrag()`.

**Not a fourth arm on `dnd.ts`'s `DragPayload`.** Adding one there would make a not-yet-owned card
droppable on every deck category, every quick zone and the sidebar's Decks entry — every target
that reads `readCards` — which is a lot of new behaviour bought by accident.

The tile registers through `CardGrid`'s `dragRecord` seam, composing both marks into one flat
record exactly as the collection wall's `tileDrag` already does:

```ts
{ ...dragData({ kind: "search-card", … }), ...searchCardDragData({ … }) }
```

Keeping the `dragData` half is what lets the tile still reach a deck category, and what makes the
multi-select group ride. **Exactly one of `tileRef` / `dragPayload` / `dragRecord`** — they do not
compose, and `CardGrid` enforces it.

### 8.2 Widening the two readers

`CollectionDrop` is already a discriminated union, so the collection is one edit: a third arm on
the type and on `readCollectionDrop`. That reaches the folder cards, the parent-folder card and
the breadcrumb segments with no component edits at all.

`WishDrag` has no discriminator, so the wishlist gets one — a `WishDrop` union mirroring
`CollectionDrop`. It is prop-type churn across six sites and no new mechanism, and it is worth
preferring to a second droppable per folder card: one reader per element keeps the drop marks as
they are.

**A second registration on one element would now be legal** — that trap belonged to
pragmatic-dnd, which kept one `draggable()` per element in a `WeakMap`; dnd-kit keys its registry
by entity id and two registrations both stand, separated by `accepts()`. `src/features/decks/CLAUDE.md`
still carries the old sentence and is corrected in the same commit.

### 8.3 The objection this has to answer

`useSidebarDrops.ts` refuses to make the sidebar's Collection entry a drop target, in as many
words:

> *"`collection_add` carries a finish, a condition and a language that a drop cannot answer, and a
> drop that invented "NM nonfoil" would write facts the reader never said."*

That objection is sound and it is already answered elsewhere: the card menu's own add writes
`condition: MENU_CONDITION`, which is `CONDITION_NOT_SET` — **an add that names no grade records
that nobody named one, which is a fact, where `NM` would be a guess dressed as one.** A drop here
writes the same: `MENU_CONDITION`, `quantity: 1`, and the finish the printing actually exists in.
Nothing is invented, and the `+` popup beside it is where a reader who wants to say more says it.

The sidebar entry stays as it is. This is a drop onto a *named folder the reader pointed at*, not
onto a list-shaped entry that would have to guess a destination as well as a grade.

### 8.4 What the page decides

`canFile` gains an arm for a card with no `folderId` to compare — a not-yet-owned card may land
anywhere `readersOwnLevel(to)` allows — and the drop branches to an **add** rather than to
`collectionSetFolder`. The write is the one `useCardMenuDeps` already makes.

## 9. Testing

**The refactor's proof is that nothing changes.** `DeckSearchPanel.test.tsx`'s 50 cases and
`DeckSearchPanel.stories.tsx`'s 10 stories are not rewritten; if the extraction is faithful they
stay green untouched, and any edit to one of them is a signal that behaviour moved.

New coverage, per surface:

* **The shell, once**, in `CardSearchPanel.test.tsx` — the three drawn states, the disclosure's
  `aria-expanded`/`aria-disabled` pair, the `NO_ROOM` sentence, the splitter's arrows and
  Home/End, the clamp split (a window narrowing must not overwrite the reader's chosen width),
  and the mount-vs-hide rule.
* **The add**, in `AddToCollection.test.tsx` — a press with `folderId` set puts it on the wire; a
  press with none still files at the root; the override picker changes the destination; the
  accessible name names the folder; `lockMode` removes the switch.
* **Each page**, in `CollectionPage.test.tsx` / `WishlistPage.test.tsx` — the panel is there, an
  add from it lands in the open folder, an add from the root lands at the root, a flattened page
  files at the root, and the two `FilterBar`s on screen are separately addressable by name.
* **The drag**, at the unit level — `searchCardDrag.test.ts` over the mark's round trip and its
  field-by-field read, and the widened `readCollectionDrop` / `readWishDrop`, plus the pages'
  `canFile` arms. The drop itself is not driven: Storybook has no WRY OLE drop target and the
  shipped window runs with `"dragDropEnabled": false`, so a green drag there would prove nothing —
  that is the deck panel's standing decision and it applies here unchanged.
* **The Rust map**, as the house set of eight `flatten.rs` already has: both values round-trip, a
  missing row remembers nothing, each section stands on its own, an unknown section survives a
  write beside it, an unreadable row remembers nothing, one junk entry costs one section, a blank
  section is refused, a write over a junk row takes effect. Plus a ninth this module has and
  `flatten.rs` does not: **the legacy `deck_search_open` row is read when the map has no `deck`
  entry, and ignored once it has one** (§7.1).
* **The fake**, mirroring `flatten_state` / `set_flatten_state`. `db.test.ts`'s handler-count
  sweep is a 1:1 swap and should not move.

**A live pass is required before this is called done.** Every UI task in Plans 2–3 found something
the suite could not, and this one has two numbers only a browser can settle: `LIST_FLOOR`, and
whether `FilterBar` overflows the panel at its 206px floor on these two pages the way
`ManaValueChips` did on the deck's. `docs/reference/live-ui-verification.md` is the harness
contract.

## 10. Out of scope

* **No second `Collection` tab** (§2.1), and no `collection_to_deck` equivalent — nothing here
  moves an existing copy; every press is an add.
* **The deck editor's behaviour does not move.** Its panel is refactored under itself and nothing
  else.
* **`SearchPage` and `TagResults` keep filing at the root.** The new props are optional, and
  giving those two pages a folder default is a separate question about surfaces that are not
  standing in a folder at all.
* **No new keyboard chord.** The deck panel has none — `shortcuts.ts` carries `search: []` — and
  a chord for a sidebar is a decision for the chord catalogue, not for this spec.
* **The `["cards","search"]` invalidation is left as it is.** `AddToCollection.tsx:182` already
  names its cost (a deep infinite search refetches every page it holds) and names the fix
  (patch `ownedQuantity`/`wishlisted` into the cached pages the way `WishlistPage`'s `patchWish`
  does). Doing it here would be a second change riding an unrelated one.

## 11. Documentation

* `docs/reference/collection-folders.md` and `docs/reference/wishlist-folders.md` — the add path
  now has a folder default, and the grain argument (an add into a second folder is a second row)
  is what makes that safe. One paragraph each.
* `docs/reference/frontend-design.md` — the shared panel, `LIST_FLOOR` as measured, and whatever
  the live pass finds.
* `docs/reference/data-and-sync.md` — the `app_meta` key list loses `deck_search_open` and gains
  `search_open`.
* `docs/reference/web-target.md` — the routed-command table. `scripts/routed-census.mjs --check`
  regenerates its counts; do not hand-edit a number a script answers.
* `src/CLAUDE.md` — the docked-column rule already covers this; it gains the two surfaces to its
  list of what is worked out of.
* `src/features/decks/CLAUDE.md` — the panel's rules move to the shared component and are
  cross-referenced rather than copied. **And one correction that is owed anyway**: this file still
  says *"one drop target per element"*, which was pragmatic-dnd's rule. `frontend-design.md` and
  three code sites already record that dnd-kit keys its registry by entity id and two registrations
  both stand; this page is the last place carrying the old sentence.
* `src/lib/ipc.ts`'s header census counts these settings in prose (*"Eight settings carry no
  struct at all… three as a bare map… two as a bare `boolean`"*). It becomes four maps and one
  boolean. **A prose-only edit routes to neither CI job**, so this is re-counted in the same commit
  that changes it.
