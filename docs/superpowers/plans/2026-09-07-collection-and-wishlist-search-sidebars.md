# Collection and Wishlist Search Sidebars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the collection and the wishlist a docked, collapsible card-search column whose adds file into the folder the reader is standing in.

**Architecture:** `DeckSearchPanel`'s chrome is extracted into `features/search/CardSearchPanel.tsx` (the shell) and `CardSearchBody.tsx` (the wall and its furniture); all three surfaces draw them. The add reuses `AddToCollectionButton`, which gains an optional folder default and an optional lock on its destination list. The three panels' open/shut state becomes one `app_meta` map. A new drag mark lets a search tile be dropped on a folder card.

**Tech Stack:** Tauri 2.11 / Rust (rusqlite, serde_json), React 19 + TypeScript 6, TanStack Query, dnd-kit, Tailwind 4, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-09-07-collection-and-wishlist-search-sidebars-design.md` — read it before starting any task.

## Global Constraints

- **Read the `CLAUDE.md` for the area you are touching.** `src-tauri/CLAUDE.md` for Rust, `src/CLAUDE.md` for any UI, `src/features/decks/CLAUDE.md` for the deck panel, `.storybook/CLAUDE.md` for stories. They are binding.
- **Do not run `npm run verify` inside your task.** Tests run once, after fan-in. Your slice compiles against a tree your siblings are still changing. Report what you changed; the coordinator runs the suite.
- **Do not commit.** Parallel agents in one worktree share a git index and a commit sweeps siblings' half-finished work. Leave changes in the working tree and report.
- **Touch only the files listed in your task.** A sibling owns every other file.
- **Never install a dependency.** Never install `@types/node`.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts`** and nowhere else.
- **Dim text is `text-dim`, never `text-muted`.**
- **A hint is `useTooltip()`'s spread, never a `title` attribute.**
- **Card art is `components/CardArt` / `components/CardImage`, never a bare `<img>`.**
- **Tailwind scans source text for whole class names** — a class built by string interpolation emits no rule at all.
- **`MIN_PANEL_WIDTH_PX` is 206** and `DEFAULT_PANEL_WIDTH_PX` is 384. Both are exported from `DeckSearchPanel.tsx` today and move to `CardSearchPanel.tsx` in Task 4.
- **`LIST_FLOOR` is provisionally 192** and is re-measured in Task 9. Do not treat it as settled.

## File ownership

No two tasks in the same wave touch the same file. This table is the contract.

| Task | Owns |
| --- | --- |
| 1 | `src-tauri/src/searchopen.rs` (new), `lib.rs`, `desktop.rs`, `web/route.rs`, `deck.rs`, `app_meta.rs` |
| 2 | `src/features/search/searchCardDrag.ts` + `.test.ts` (both new) |
| 3 | `src/features/collection/AddToCollection.tsx` + `.test.tsx` + `.stories.tsx` |
| 4 | `src/features/search/CardSearchPanel.tsx`, `CardSearchBody.tsx`, `src/lib/useDockHeight.ts` (all new, + tests), `src/features/decks/DeckSearchPanel.tsx`, `src/features/decks/DeckEditor.tsx`, `src/lib/cardZoom.ts` |
| 5 | `src/features/search/useSearchOpen.ts` (new), `src/features/decks/useDeckSearchOpen.ts` (deleted), `src/lib/ipc.ts`, `src/components/AppShell.tsx`, `.storybook/fake/db.ts`, `.storybook/fake/db.test.ts` |
| 6 | `src/features/collection/CollectionSearchPanel.tsx` (new, + test + stories), `CollectionPage.tsx` + its test/stories, `collectionDrag.ts` + its test |
| 7 | `src/features/wishlist/WishlistSearchPanel.tsx` (new, + test + stories), `WishlistPage.tsx` + its test/stories, `wishDrag.ts` + its test, `WishFolderCard.tsx`, `WishlistBreadcrumb.tsx` |
| 8 | Every `.md` under `docs/reference/`, `src/CLAUDE.md`, `src/features/decks/CLAUDE.md` |

---

# Wave 1 — four tasks, dispatched together

## Task 1: The `search_open` app_meta map (Rust)

**Files:**
- Create: `src-tauri/src/searchopen.rs`
- Modify: `src-tauri/src/lib.rs` (one `pub mod` line + the four-view-state-modules doc above `pub mod flatten;`)
- Modify: `src-tauri/src/desktop.rs` (invoke_handler)
- Modify: `src-tauri/src/web/route.rs` (`COMMANDS` ×2, `match` arms ×2)
- Modify: `src-tauri/src/deck.rs` (delete the old key, default, two fns, two commands, two tests)
- Modify: `src-tauri/src/app_meta.rs` (module doc names `deck.rs`; the round-trip test uses `"deck_search_open"` as its fixture key — pick another)

**Interfaces:**
- Consumes: nothing.
- Produces: commands `search_open` (no args, answers `BTreeMap<String, bool>`) and `set_search_open { section: String, open: bool }` (answers `()`); `crate::searchopen::{K_SEARCH_OPEN, stored, store}`.

- [ ] **Step 1: Read the template.** `src-tauri/src/flatten.rs` whole. It is `listview.rs` with a `bool` where the layout word is, which is exactly this shape. Also read `src-tauri/src/deck.rs:99`–`:150` (what you are deleting) and `src-tauri/CLAUDE.md`'s sections on adding a command and on wasm gating.

- [ ] **Step 2: Write `searchopen.rs` as a copy of `flatten.rs`.** Same two rules in the module doc — *reading can never fail*, *writing validates* — and the `//! No migration: app_meta is schema v6's key/value table, and this is a key in it.` line. Public API, mirroring `flatten.rs` exactly:

```rust
pub const K_SEARCH_OPEN: &str = "search_open";
const NO_SECTION: &str = "A search section cannot be blank.";
fn stored_object(conn: &Connection) -> Map<String, Value>;
pub fn stored(conn: &Connection) -> BTreeMap<String, bool>;
pub fn store(conn: &Connection, section: &str, open: bool) -> Result<(), String>;

#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn search_open(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, bool>;

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_search_open(
    state: tauri::State<'_, Arc<AppState>>,
    section: String,
    open: bool,
) -> Result<(), String>;
```

Gate the `use crate::sync::AppState;` and `use std::sync::Arc;` lines with `#[cfg(not(target_family = "wasm"))]` — `-D warnings` on the wasm clippy job makes a stranded import a red build.

- [ ] **Step 3: Add the legacy bridge inside `stored`.** After building the map, if it has no `"deck"` entry, read `app_meta`'s `deck_search_open` row and insert `true` for `"1"` / `false` for `"0"`. Anything else — a missing row, junk — inserts nothing and lets the frontend's default stand. Document it as a bridge that decays: nothing writes the legacy row again, so the first press stores the map and this is only ever consulted for a reader who has not pressed since upgrading.

- [ ] **Step 4: Write the tests.** `flatten.rs`'s house set of eight, ported: both values round-trip; a missing row remembers nothing; each section stands on its own; an unknown section survives a write beside it; an unreadable row remembers nothing; one junk entry costs one section; a blank section is refused; a write over a junk row takes effect. Plus two the bridge owes:
  - `a_database_with_only_the_old_row_answers_for_the_deck_section` — write `deck_search_open = "0"`, assert `stored()` gives `{"deck": false}`.
  - `a_map_with_a_deck_entry_ignores_the_old_row` — write `deck_search_open = "0"` **and** `store(conn, "deck", true)`, assert `stored()["deck"] == true`.

- [ ] **Step 5: Run just this module.** `cd src-tauri && cargo test searchopen`. Expected: all pass. **A filter that matches nothing exits 0** — confirm the run reports the number of tests you wrote, not `0 passed`.

- [ ] **Step 6: Delete the old pair from `deck.rs`.** `K_DECK_SEARCH_OPEN`, `DEFAULT_DECK_SEARCH_OPEN`, `stored_deck_search_open`, `store_deck_search_open`, the `deck_search_open` and `set_deck_search_open` commands, and the two tests `the_search_column_state_survives_a_round_trip_and_falls_back_otherwise` and `the_search_column_write_leaves_the_other_app_meta_rows_standing`. The doc above them calls it "the fourth key of its kind" — fix the census sentence rather than leaving it counting a key that is gone.

- [ ] **Step 7: Register.** `lib.rs` gets `pub mod searchopen;` in the *Every target* block (alphabetically between `search` and `slug`), and the shared doc above `pub mod flatten;` that names "the four view-state modules" becomes five. `desktop.rs` loses `deck::deck_search_open` / `deck::set_deck_search_open` and gains `searchopen::search_open` / `searchopen::set_search_open` beside the `listview::` pair.

- [ ] **Step 8: Route it for the web target.** `web/route.rs`: rename the two `COMMANDS` entries and move them from the deck section to the settings section beside `flatten_state`; rewrite the two `match` arms on `list_view` / `set_list_view`'s template:

```rust
        "search_open" => {
            let conn = crate::sync::lock_db_read(state);
            encode(command, crate::searchopen::stored(&conn))
        }

        "set_search_open" => {
            let section: String = field(command, args, "section")?;
            let open: bool = field(command, args, "open")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::searchopen::store(c, &section, open))
                    .map_err(RouteError::Failed)?,
            )
        }
```

`COMMANDS.len()` is a 1:1 swap and should not move. **If it does, take the number from the failure, never from arithmetic** — that file's own comment demands it.

- [ ] **Step 9: Fix `app_meta.rs`.** Its module doc names `deck.rs` as a caller; its round-trip test uses `"deck_search_open"` as a fixture key. Point the doc at `searchopen.rs` and give the test a key that is not a real one.

- [ ] **Step 10: Prove the whole crate.** `cd src-tauri && cargo test` then `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check`. **`npm run verify` runs neither clippy nor fmt** — CI does, and they are the only reds you can get with a fully green local run.

- [ ] **Step 11: Mutate one test to prove it bites.** Break `store`'s blank-section refusal (accept a blank section) and confirm the refusal test fails; put it back.

- [ ] **Step 12: Report.** List the files changed, the command names, and the exact `BTreeMap<String, bool>` shape. Do not commit.

---

## Task 2: The search-card drag mark

**Files:**
- Create: `src/features/search/searchCardDrag.ts`
- Create: `src/features/search/searchCardDrag.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface SearchCardDrag {
  cardId: string;
  name: string;
  /** The finish a drop writes. The printing's first available finish, never a guess. */
  finish: Finish;
  /** For a wish for "any printing". `null` mirrors the column's nullability. */
  oracleId: string | null;
}
export function searchCardDragData(drag: SearchCardDrag): Record<string, unknown>;
export function readSearchCardDrag(data: Record<string, unknown>): SearchCardDrag | null;
```

- [ ] **Step 1: Read the two templates.** `src/features/collection/collectionDrag.ts` (lines 58–200 — the mark, the interfaces, the `*DragData` writer, the field-by-field reader, and `readCollectionDrop`) and `src/features/wishlist/wishDrag.ts` whole. Copy their *shape*, including the doc-comment habit of saying why each field travels.

- [ ] **Step 2: Write the failing test file.** Cover exactly these cases, and no ceremony tests:

```ts
it("round-trips a card through the mark", …)                       // write then read gives the same fields
it("refuses a record carrying no mark", …)                         // {} → null
it("refuses another feature's mark", …)                            // collectionSource-marked record → null
it("refuses a record whose cardId is not a string", …)             // field-by-field, not a cast
it("refuses a record whose finish is not a finish this build knows", …)
it("reads a null oracleId as a card with no oracle row", …)
it("keeps a foreign key beside its own", …)                        // composed record: both marks readable
```

The last one is the load-bearing one: build `{ ...dragData({kind:"search-card", …}), ...searchCardDragData({…}) }` and assert both `readDragData` and `readSearchCardDrag` answer.

- [ ] **Step 3: Run it and watch it fail.** `npx vitest run src/features/search/searchCardDrag.test.ts`. Expected: fail on the missing module.

- [ ] **Step 4: Write the module.** A `SEARCH_CARD_MARK = "mtg-grimoire/search-card-drag"` and a key `searchCardSource` — it must be none of the five taken (`dragSource`, `collectionSource`, `collectionTileSource`, `wishSource`, `folderSource`). Read field by field, never a cast; an unreadable field is `null` for the whole record, not a partial one.

- [ ] **Step 5: Run it and watch it pass.**

- [ ] **Step 6: Mutate to prove the tests bite.** Change the reader to `return data as unknown as SearchCardDrag` and confirm the four refusal tests fail. Put it back.

- [ ] **Step 7: Report** the exported names and the mark/key strings verbatim — Tasks 6 and 7 both import them.

---

## Task 3: `AddToCollectionButton` learns about folders

**Files:**
- Modify: `src/features/collection/AddToCollection.tsx`
- Modify: `src/features/collection/AddToCollection.test.tsx`
- Modify: `src/features/collection/AddToCollection.stories.tsx`

**Interfaces:**
- Consumes: `MoveToFolder` from `@/features/decks/MoveToFolder` (props `label`, `nodes`, `currentId`, `rootLabel`, `inline`, `onPick`, `onClose`), `FolderNode` from `@/lib/folderTree`.
- Produces: three new optional props on `AddToCollectionButton`:

```ts
folderId?: number | null;          // default destination; absent keeps today's root behaviour
folderNodes?: readonly FolderNode[]; // the tree the override offers; absent draws no picker
folderName?: (id: number | null) => string;  // for the button's name and the Folder row
lockMode?: "collection" | "wishlist"; // pins the destination and hides the switch
```

- [ ] **Step 1: Read the file and its two neighbours.** `AddToCollection.tsx` whole, `src/features/wishlist/EditWish.tsx:280`–`:363` (the `Folder` row and the in-place `MoveToFolder` swap — copy that shape, deliberately not a nested popup, so there is one Escape rung), and `src/features/collection/PickCopies.tsx` (the other `inline` caller).

- [ ] **Step 2: Write the failing tests.** Add to `AddToCollection.test.tsx`:

```ts
it("files at the root when it is given no folder", …)        // no folderId prop → payload has no folderId
it("files into the folder it is given", …)                    // folderId: 7 → collectionAdd called with folderId: 7
it("names the folder in the button's accessible name", …)     // /Add Lightning Bolt \(LEA 161\) to Rares/
it("names the list at the root", …)                           // /to Collection$/
it("sends a wish into the folder it is given", …)             // lockMode wishlist → wishlistAdd with folderId
it("lets the reader send it somewhere else", …)               // open Folder row, pick, assert the new id on the wire
it("draws no folder row without a tree", …)                   // folderNodes absent → queryBy… is null
it("hides the destination switch when it is locked", …)       // lockMode set → the Collection/Wishlist group is absent
it("keeps the switch when it is not", …)                      // the existing behaviour, pinned so the lock cannot leak
```

- [ ] **Step 3: Run them and watch them fail.** `npx vitest run src/features/collection/AddToCollection.test.tsx`.

- [ ] **Step 4: Implement.** Four changes, in this order:
  1. Thread `folderId` into both `mutationFn` payloads (`ipc.collectionAdd` and `ipc.wishlistAdd`). Both `EntryInput` and `WishInput` already carry `folderId?: number | null`.
  2. **Correct the stale comment** in the `onSuccess` invalidation note. It says *"`collection_add` takes no folder, so the copy lands unfiled at the root"* — that is wrong about the command and was only ever true of this call site. Rewrite it to say what is actually true now.
  3. `lockMode` — when set, `mode` is that value, the `role="group" aria-label="Add to"` chip pair is not rendered, and `setMode` is never called.
  4. The `Folder` row — `EditWish`'s shape: a `SectionLine` reading the current destination's name, and a `Move to folder…`-style control that swaps the panel body **in place** for `MoveToFolder` with `inline`, `currentId={folderId}`, and `rootLabel` of `"Collection"` or `"Wishlist"`. Drawn only when `folderNodes` is given.

  The button's accessible name currently ends `to ${mode}`. It becomes the folder's name when there is one — `Add Lightning Bolt (LEA 161) to Rares` — and `to Collection` / `to Wishlist` at the root. That is `DeckSearchPanel`'s rule (`Add Ancient Tomb to Land`) applied.

- [ ] **Step 5: Run the tests and watch them pass.**

- [ ] **Step 6: Prove the existing call sites are untouched.** `npx vitest run src/features/search/SearchPage.test.tsx src/features/tags/TagsPage.test.tsx src/features/card/AllPrintingsDialog.test.tsx`. All three must stay green with no edits — every new prop is optional and those pages pass none of them.

- [ ] **Step 7: Add two stories.** `WithFolder` (a tree, a current folder, the picker opened in its `play`) and `Locked` (`lockMode: "wishlist"`, asserting the switch is absent). Follow `.storybook/CLAUDE.md`; do not write a story count into any document.

- [ ] **Step 8: Mutate to prove the tests bite.** Make the folder default always `null` and confirm "files into the folder it is given" fails. Put it back.

- [ ] **Step 9: Report** the final prop signatures verbatim — Tasks 6 and 7 both call this component.

---

## Task 4: Extract the shared panel

**Files:**
- Create: `src/features/search/CardSearchPanel.tsx` + `CardSearchPanel.test.tsx`
- Create: `src/features/search/CardSearchBody.tsx`
- Create: `src/lib/useDockHeight.ts` + `useDockHeight.test.ts`
- Modify: `src/features/decks/DeckSearchPanel.tsx`
- Modify: `src/features/decks/DeckEditor.tsx` (the dock effect only)
- Modify: `src/lib/cardZoom.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// CardSearchPanel.tsx
export const DEFAULT_PANEL_WIDTH_PX = 384;
export const MIN_PANEL_WIDTH_PX = 206;
export const SEARCH_OVER_ATTR = "data-search-over";
export type SearchSurface = "deck" | "collection" | "wishlist";

export function CardSearchPanel(props: {
  surface: SearchSurface;      // the data-search-over value
  title: string;               // the heading, e.g. "Search cards"
  sectionLabel: string;        // the <section> aria-label, e.g. "Add cards"
  toggleLabel: string;         // stem for "Collapse …" / "Expand …", e.g. "card search"
  open: boolean;
  setOpen: (open: boolean) => void;
  roomy?: boolean;             // default true
  overWidth?: number;
  maxWidth?: number;           // default Number.POSITIVE_INFINITY
  tabs?: ReactNode;            // drawn under the title row when shown
  children: ReactNode;         // mounted on `open`, hidden (not unmounted) on `!shown`
}): ReactElement;

// CardSearchBody.tsx
export function CardSearchBody<T>(props: {
  search: CardSearch;          // the caller's own useCardSearch(...) result
  labels?: FilterLabels;
  zoomSection: ZoomSection;
  selectionScope: string;
  baseTileWidth?: number;      // default TILE_BASE = 150
  addFailure?: string | null;
  tileRef?: CardGridProps["tileRef"];
  dragRecord?: CardGridProps["dragRecord"];
  badge?: (card: CardSummary) => ReactNode;
  action?: (card: CardSummary) => ReactNode;
  cardMenu?: …; cardMenuKey?: …;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): ReactElement;

// useDockHeight.ts
export function useDockHeight(
  dock: RefObject<HTMLElement | null>,
  anchor: RefObject<HTMLElement | null>,
): void;
```

- [ ] **Step 1: Read the whole of `DeckSearchPanel.tsx`** and `src/features/decks/CLAUDE.md`'s sections on the docked panel (search for "The docked panel"). Every rule in there survives this refactor; you are moving code, not deciding anything.

- [ ] **Step 2: Add the two zoom sections first.** `src/lib/cardZoom.ts`: `ZOOM_SECTIONS` gains `"collectionSearch"` and `"wishlistSearch"`, and `DEFAULT_SECTION_ZOOMS` gains both at `DEFAULT_ZOOM` with a one-line comment each saying why they are their own key rather than the page wall's. **`DEFAULT_SECTION_ZOOMS` is spelled as a literal on purpose** so a new section is a compile error until somebody says what it starts at — do not reduce it over `ZOOM_SECTIONS`. Run `npx vitest run src/lib/cardZoom.test.ts`.

- [ ] **Step 3: Write `useDockHeight` and its test.** It finds the nearest scrolling ancestor of `dock`, and on scroll and on resize sets `dock.style.height` to `scroller.clientHeight - (anchor.top - scroller.top)`, floored at 0, `requestAnimationFrame`-coalesced, with the listener passive and a `ResizeObserver` on both boxes. Copy the body of `DeckEditor.tsx:1852`–`:1893` and generalise the scroller from "the editor's page section" to "whatever scrolls". jsdom has no layout, so the test asserts the wiring — that a scroll fires one frame, that cleanup removes the listener and disconnects the observer — not the number.

- [ ] **Step 4: Point `DeckEditor` at the hook.** Replace its `useLayoutEffect` with `useDockHeight(dockRef, deskRef)`. Run `npx vitest run src/features/decks/DeckEditor.test.tsx` — it must stay green with no edits to the test file.

- [ ] **Step 5: Create `CardSearchPanel.tsx` by moving code, not rewriting it.** Move, verbatim: the three-state `<section>` and its `cn(...)` recipe, the `w-9 shrink-0` flow-holder, the disclosure button (one `ChevronLeft` rotated 180°, `aria-expanded`, `aria-disabled` never `disabled`, the `NO_ROOM` tooltip), the title row with its centred heading, its `size-7` centring shim and its `writingMode: "vertical-rl"` rail heading, `ResizeHandle` whole, the width `useState` and its two clamps, the `open`/`shown`/`over`/`overlaid` derivations, the `display: contents` vs `hidden` mount-vs-hide wrapper, and the caret hand-back effect. Parameterise only the four strings and the `surface` value.

  **Three things that must not drift while you move them:**
  - `aria-disabled={!drawable || undefined}` with `onClick={() => drawable && setOpen(!open)}` — never the `disabled` attribute, because the refusal has to stay in the tab order.
  - The `hidden` **attribute** rides beside the `hidden` class, because jsdom loads no stylesheet.
  - **The clamp split**: the environment clamps what is *drawn* (`drawnWidth`), a drag clamps what is *stored* (`resize`). Folding them makes every momentary squeeze permanent.

- [ ] **Step 6: Create `CardSearchBody.tsx`.** The fragment `OpenPanel` returns today, in the same order: the add-failure `AnimatePresence` banner, `FilterBar`, the one `role="status"` line through `summaryOf`, the refresh/next-page failure with its `Try again`, `CardGrid`, and the `pricesAsOf` line. `layoutToggle={false}` stays. Pass exactly one of `tileRef` / `dragRecord` through to `CardGrid` — they do not compose and `CardGrid` enforces it.

- [ ] **Step 7: Rewrite `DeckSearchPanel` on top of both.** It keeps: `TABS`, `useDeckSearchTab`, `TabStrip`, `CollectionSearchTab`, `categories`, `targetCategoryId`, `AUTO_CATEGORY`/`autoCategoryFor`, `add`, `onAdded`, `availableForDeck`, `defaultFormat`, its `cardDraggable` `tileRef`, and its Add button. **`CollectionSearchTab` is not touched** — it runs on `useCollectionSearch` over a different row type and is not a `CardSearchBody` caller. Re-export `MIN_PANEL_WIDTH_PX` and `SEARCH_OVER_ATTR` from `DeckSearchPanel` so `DeckEditor.tsx` and `DeckEditor.test.tsx` keep their imports.

- [ ] **Step 8: Hoist `open`/`setOpen` into `DeckEditor`.** `DeckSearchPanel` stops calling `useDeckSearchOpen`; `DeckEditor` calls it and passes the pair down. This is what lets Task 5 swap the hook without touching the panel.

- [ ] **Step 9: Run the deck suites.** `npx vitest run src/features/decks/DeckSearchPanel.test.tsx src/features/decks/DeckEditor.test.tsx src/features/decks/CollectionSearchTab.test.tsx`. **All must pass with zero edits to any test file.** An edit you feel tempted to make is the signal that behaviour moved — stop and report it instead.

- [ ] **Step 10: Write `CardSearchPanel.test.tsx`** for the shell on its own, with a trivial body: the three drawn states; `aria-expanded` flipping; `aria-disabled` with the `NO_ROOM` sentence while still `toBeEnabled()`; the splitter's `role="separator"` with `aria-valuenow`/`min`/`max`, its arrows and Home/End; the clamp split (narrow `maxWidth` under a live panel, then widen it, and assert the reader's chosen width comes back); and the mount-vs-hide rule (type in the body, rail it, un-rail it, assert the text survived; then collapse and re-open and assert it did not).

- [ ] **Step 11: Run the storybook stories for the deck panel.** `npx vitest run src/stories.test.tsx -t "Decks/SearchPanel"`. Green with no story edits.

- [ ] **Step 12: Mutate to prove the shell's tests bite.** Fold `open` and `roomy` into one gate (`{open && roomy && …}`) and confirm the mount-vs-hide test fails. Put it back.

- [ ] **Step 13: Report** the two components' final prop signatures verbatim, and confirm which files you changed. Tasks 6 and 7 both build on this.

---

# Wave 2 — one task, after Wave 1

## Task 5: `useSearchOpen`, the TypeScript half

**Files:**
- Create: `src/features/search/useSearchOpen.ts` + `useSearchOpen.test.ts`
- Delete: `src/features/decks/useDeckSearchOpen.ts` (and its test, if one exists)
- Modify: `src/lib/ipc.ts`
- Modify: `src/components/AppShell.tsx`
- Modify: `.storybook/fake/db.ts`, `.storybook/fake/db.test.ts`

**Interfaces:**
- Consumes: Task 1's `search_open` / `set_search_open` commands; Task 4's hoisting of `open`/`setOpen` into `DeckEditor`.
- Produces:

```ts
export const SEARCH_OPEN_KEY = ["searchOpen"];
export type SearchSection = "deck" | "collection" | "wishlist";
export const DEFAULT_SEARCH_OPEN: Readonly<Record<SearchSection, boolean>>;
export function useSearchOpen(section: SearchSection): { open: boolean; setOpen: (open: boolean) => void };
export function usePrefetchSearchOpen(): void;
```

- [ ] **Step 1: Read `useDeckSearchOpen.ts` whole.** Every paragraph in it is a decision that survives; you are widening it by one argument, not rewriting it.

- [ ] **Step 2: Add the ipc wrappers.** `src/lib/ipc.ts`: replace `deckSearchOpen` / `setDeckSearchOpen` with

```ts
searchOpen: () => invoke<Record<string, boolean>>("search_open"),
setSearchOpen: (section: string, open: boolean) =>
  invoke<void>("set_search_open", { section, open }),
```

Raw `Record<string, boolean>` rather than `Record<SearchSection, boolean>`, for `listView`'s stated reason: a row a newer build wrote must reach this side as what it is, and the narrowing belongs to the module that owns the vocabulary. **Also fix the header census** at the top of the file — *"Eight settings carry no struct at all … three as a bare map … two as a bare `boolean`"* becomes four maps and one boolean, and the `deckSearchOpen` line becomes `searchOpen`. That prose routes to neither CI job, so it is only right if you make it right.

- [ ] **Step 3: Write `useSearchOpen.ts`.** One query over `SEARCH_OPEN_KEY` with `staleTime: Infinity, gcTime: Infinity`; `setOpen` writes `queryClient.setQueryData` **before** `mutate` (the optimistic half, deliberately not rolled back — a refused write costs the memory, not the column snapping shut under the reader's hand); the read narrows through `DEFAULT_SEARCH_OPEN[section]` for a missing or non-boolean entry. `DEFAULT_SEARCH_OPEN` is a literal `Record<SearchSection, boolean>` so a fourth surface is a compile error: `deck: true`, `collection: true`, `wishlist: true`.

- [ ] **Step 4: Write the tests.** `useSearchOpen.test.ts`:

```ts
it("answers the stored value for its own section", …)
it("answers the default for a section the map does not carry", …)
it("answers the default for an entry that is not a boolean", …)
it("answers the default while the read is in flight", …)
it("writes the section it was given", …)          // setSearchOpen called with ("collection", false)
it("shows the new state before the write answers", …)   // the optimistic half
it("keeps the new state when the write is refused", …)  // deliberately not rolled back
it("does not disturb another section", …)
```

- [ ] **Step 5: Swap `AppShell`.** `usePrefetchDeckSearchOpen()` becomes `usePrefetchSearchOpen()`. Keep the comment explaining *why* the read happens here — it is a measurement (~700ms of the column drawn the wrong way round), not tidiness. Widen its wording from "the deck editor's search column" to all three.

- [ ] **Step 6: Point `DeckEditor` at the new hook.** It calls `useSearchOpen("deck")` where Task 4 left `useDeckSearchOpen()`. Delete `useDeckSearchOpen.ts`.

- [ ] **Step 7: Teach the fake.** `.storybook/fake/db.ts`: replace the `deckSearchOpen` field and its two handlers with a `searchOpen` map, modelled on `flatten_state` / `set_flatten_state` (find them in the same file and copy their shape exactly). `db.test.ts`'s handler-count sweep is a 1:1 swap and should not move; if it does, take the number from the failure.

- [ ] **Step 8: Run everything that touches this.** `npx vitest run src/features/search/useSearchOpen.test.ts src/features/decks/DeckSearchPanel.test.tsx src/features/decks/DeckEditor.test.tsx .storybook/fake/db.test.ts src/lib/ipc.test.ts`.

- [ ] **Step 9: Mutate to prove the tests bite.** Make `setOpen` roll back on failure and confirm the "keeps the new state when the write is refused" test fails. Put it back.

- [ ] **Step 10: Report** the hook's signature and the fake's new field name.

---

# Wave 3 — two tasks, dispatched together

## Task 6: The collection's sidebar

**Files:**
- Create: `src/features/collection/CollectionSearchPanel.tsx` + `.test.tsx` + `.stories.tsx`
- Modify: `src/features/collection/CollectionPage.tsx` + `.test.tsx` + `.stories.tsx`
- Modify: `src/features/collection/collectionDrag.ts` + `collectionDrag.test.ts`

**Interfaces:**
- Consumes: Task 2's `SearchCardDrag`/`searchCardDragData`/`readSearchCardDrag`; Task 3's `AddToCollectionButton` folder props; Task 4's `CardSearchPanel`/`CardSearchBody`/`useDockHeight`/`MIN_PANEL_WIDTH_PX`; Task 5's `useSearchOpen`.
- Produces: nothing another task consumes.

- [ ] **Step 1: Read.** `CollectionPage.tsx:2372`–`:3138` (the render), `:1864`–`:1994` (`canMoveCopy` / `canFile` / `fileCard` / `commitFile`), `collectionDrag.ts` whole, `src/features/card/useCardMenuDeps.ts:148`–`:183` (the add you are about to reuse verbatim), and the spec's §4, §5 and §8.

- [ ] **Step 2: Widen `CollectionDrop`.** It is already a discriminated union, so this is one arm on the type and one branch in `readCollectionDrop`:

```ts
export type CollectionDrop =
  | { kind: "entry"; entry: CollectionDrag }
  | { kind: "tile"; tile: CollectionTileDrag }
  | { kind: "new"; card: SearchCardDrag };
```

That single change reaches `useCollectionDropTarget`, `CollectionFolderCard`, `CollectionParentFolderCard` and `CollectionBreadcrumb`'s `Segment` **with no component edits at all**. Add the round-trip and precedence cases to `collectionDrag.test.ts` — in particular that a record carrying *both* an entry mark and a search mark reads as the entry (an existing copy being moved outranks a new one being added, because only one of them can be true of a real drag).

- [ ] **Step 3: Write the failing page tests.** In `CollectionPage.test.tsx`:

```ts
it("draws a card search beside the binder", …)
it("adds from the search into the folder on screen", …)   // open a folder, press +, assert folderId
it("adds at the root when no folder is open", …)          // folderId: null on the wire
it("adds at the root while the cabinet is flattened", …)  // flatten on, a folderId set underneath → still null
it("files a dropped card into the folder it was dropped on", …)  // collectionAdd, not collectionSetFolder
it("gives the two filter rows different names", …)        // "Search your collection" and "Search cards" both resolve
```

- [ ] **Step 4: Run them and watch them fail.**

- [ ] **Step 5: Write `CollectionSearchPanel.tsx`.** `CardSearchPanel` + `CardSearchBody`, with:
  - `surface="collection"`, `title="Search cards"`, `sectionLabel="Add cards to your collection"`, `toggleLabel="card search"`.
  - `useSearchOpen("collection")` for the disclosure.
  - `zoomSection="collectionSearch"`, `selectionScope="collection-panel"`, `labels={{ idStem: "collection-add", search: "Search cards" }}`.
  - `action` renders `AddToCollectionButton` with `lockMode="collection"`, `folderId`, `folderNodes` and `folderName` handed down from the page.
  - `dragRecord` composing both marks:

```ts
const tileDrag = useCallback(
  (card: CardSummary): Record<string, unknown> => ({
    ...dragData({ kind: "search-card", cardId: card.id, name: card.name, typeLine: card.typeLine }),
    ...searchCardDragData({
      cardId: card.id,
      name: card.name,
      finish: parseFinishes(card.finishes)[0] ?? "nonfoil",
      oracleId: card.oracleId,
    }),
  }),
  [],
);
```

  **Module-stable identity is a hard requirement** — the panel re-renders on every keystroke, and a fresh arrow tears down and rebuilds every tile's drag registration. `useCallback` with `[]`, exactly as `DeckSearchPanel`'s `tileRef` does.

- [ ] **Step 6: Wire the page's layout.** Turn `CollectionPage.tsx:2449`'s `<div className="flex min-h-0 flex-1 flex-col gap-2">` into the row from the spec's §4: a `deskRef` row, the existing column with `min-w-0 flex-1` added, and a `dockRef` host that is `sticky top-0 flex shrink-0 self-start` and carries `LAYER.popup` only while the panel is drawn over the list. Call `useDockHeight(dockRef, deskRef)`.

- [ ] **Step 7: Measure the row.** A `ResizeObserver` on `deskRef` giving `deskWidth`, then, exactly as `DeckEditor` does:

```ts
const LIST_FLOOR = 192;   // provisional — Task 9 measures it
const DESK_GAP = 16;
const maxPanelWidth = Math.min(
  viewport > 0 ? Math.floor(viewport / 2) : Number.POSITIVE_INFINITY,
  deskWidth > 0 ? deskWidth - DESK_GAP - LIST_FLOOR : Number.POSITIVE_INFINITY,
);
const roomForPanel = deskWidth === 0 || maxPanelWidth >= MIN_PANEL_WIDTH_PX;
const panelOverWidth = deskWidth > 0 && !roomForPanel ? deskWidth : undefined;
```

`viewport` is `document.documentElement.clientWidth`, **never `innerWidth`** — that one counts the page scrollbar and caps the panel 8px too wide. `deskWidth === 0` reads as roomy, which is what keeps jsdom and the first paint out of the way.

- [ ] **Step 8: Give the drop its add.** Extend `canFile` with a `"new"` arm — a card nobody owns has no `from` to compare, so it may land anywhere `readersOwnLevel(to)` allows — and branch `fileCard`/`commitFile` to an add rather than to `setFolder`. The write is `useCardMenuDeps`' verbatim:

```ts
ipc.collectionAdd({ cardId, finish, condition: MENU_CONDITION, quantity: 1, folderId })
```

`MENU_CONDITION` is `CONDITION_NOT_SET`, and that is the answer to the standing objection in `useSidebarDrops.ts` — an add that names no grade records that nobody named one, where `NM` would be a guess dressed as one. Invalidate the four keys `useCardMenuDeps` invalidates.

- [ ] **Step 9: Hand the panel the folder facts.** `folderId` and `flatten` come off `useCollection()`; `nodes` is already built on the page (`buildFolderTree(userFolders, [])`); `folderNameOf` already exists. **When `flatten` is on, pass `folderId: null`** — the breadcrumb reads `Collection · all folders` and there is no folder on screen to be standing in.

- [ ] **Step 10: Run the tests and watch them pass.** `npx vitest run src/features/collection/`.

- [ ] **Step 11: Add stories.** `WithSearch` (the panel open, the wall drawn), `Narrow` (`maxWidth` at `MIN_PANEL_WIDTH_PX`, asserting `row.scrollWidth === row.clientWidth` for the filter row, the panel and the strip — Storybook is a real browser, so this is the one place that arithmetic is real), and `Railed`. Model them on `DeckSearchPanel.stories.tsx`'s `Docked` / `Narrow` / `NoRoom`.

- [ ] **Step 12: Mutate to prove the tests bite.** Make the panel pass `folderId` even when flattened, and confirm the flatten test fails. Put it back.

- [ ] **Step 13: Report** what you changed and anything that surprised you.

---

## Task 7: The wishlist's sidebar

**Files:**
- Create: `src/features/wishlist/WishlistSearchPanel.tsx` + `.test.tsx` + `.stories.tsx`
- Modify: `src/features/wishlist/WishlistPage.tsx` + `.test.tsx` + `.stories.tsx`
- Modify: `src/features/wishlist/wishDrag.ts` + `wishDrag.test.ts`
- Modify: `src/features/wishlist/WishFolderCard.tsx`, `src/features/wishlist/WishlistBreadcrumb.tsx`

**Interfaces:** identical to Task 6's, and Task 6 is the model for every step. Where the two differ it is called out below.

- [ ] **Step 1: Read.** `WishlistPage.tsx:1225`–`:1702`, `:955`–`:962` (`canFile` / `fileWish`), `wishDrag.ts` whole, `useCardMenuDeps.ts:193`–`:205`, and the spec's §4, §5 and §8.

- [ ] **Step 2: Give `WishDrag` a discriminator.** This is the one place the wishlist costs more than the collection: `readWishDrag` answers a bare `WishDrag | null` today, so it becomes a union mirroring `CollectionDrop`:

```ts
export type WishDrop =
  | { kind: "wish"; wish: WishDrag }
  | { kind: "new"; card: SearchCardDrag };
export function readWishDrop(data: Record<string, unknown>): WishDrop | null;
```

That is prop-type churn across six sites and no new mechanism: `useWishDropTarget`, `WishFolderCard`'s `canDrop`/`onDropCard`, `WishParentFolderCard`'s pair, `WishlistBreadcrumb`'s `Segment`, and the page's `canFile`/`fileWish`. **Prefer it to a second droppable per folder card** — dnd-kit would allow one (it keys its registry by entity id, so two registrations on one element both stand), but it would split the drop marks that `armed`/`over` currently fold into one.

- [ ] **Step 3: Write the failing page tests.** In `WishlistPage.test.tsx`, the same six as Task 6's Step 3 with the wishlist's nouns, plus one the collection does not need:

```ts
it("wishes for the printing the tile is of", …)   // cardId on the wire, not oracleId
```

- [ ] **Step 4: Run them and watch them fail.**

- [ ] **Step 5: Write `WishlistSearchPanel.tsx`** — Task 6's Step 5 with `surface="wishlist"`, `sectionLabel="Add cards to your wishlist"`, `zoomSection="wishlistSearch"`, `selectionScope="wishlist-panel"`, `labels={{ idStem: "wishlist-add", search: "Search cards" }}`, `useSearchOpen("wishlist")`, and `AddToCollectionButton` with `lockMode="wishlist"`. The `dragRecord` is Task 6's verbatim.

- [ ] **Step 6: Wire the layout.** `WishlistPage.tsx:1330`'s work column becomes the same row as Task 6's Step 6. `useDockHeight(dockRef, deskRef)`.

- [ ] **Step 7: Measure the row.** Task 6's Step 7 verbatim, including `document.documentElement.clientWidth`.

- [ ] **Step 8: Give the drop its add.** `canFile` gains a `"new"` arm (a wish for a card has no `folderId` to compare against, so it may land anywhere), and the drop writes

```ts
ipc.wishlistAdd({ cardId, quantity: 1, preferredFinish: finish, folderId })
```

- [ ] **Step 9: Hand the panel the folder facts.** `folderId` and `flatten` off `useWishlist()`, `nodes` and `folderNameOf` already on the page. **`flatten` on means `folderId: null`.** Note the wishlist's flatten default is `false` where the collection's is `true` — do not copy the collection's default across.

- [ ] **Step 10: Run the tests.** `npx vitest run src/features/wishlist/`.

- [ ] **Step 11: Add stories.** Task 6's three, with the wishlist's fixtures.

- [ ] **Step 12: Mutate to prove the tests bite.** Make the drop write `wishlistSetFolder` instead of `wishlistAdd` and confirm the drop test fails. Put it back.

- [ ] **Step 13: Report.**

---

# Wave 4 — after the suite is green

## Task 8: The documentation

**Files:** `docs/reference/collection-folders.md`, `wishlist-folders.md`, `frontend-design.md`, `data-and-sync.md`, `web-target.md`, `src/CLAUDE.md`, `src/features/decks/CLAUDE.md`

- [ ] **Step 1: `collection-folders.md` and `wishlist-folders.md`** — one paragraph each: the add path now has a folder default, and the grain argument (an add into a second folder is a second row, never a move) is what makes that safe.
- [ ] **Step 2: `frontend-design.md`** — the shared panel, its three surfaces, and `LIST_FLOOR` as Task 9 measured it. Name the build (debug or release) and the window size in any figure.
- [ ] **Step 3: `data-and-sync.md`** — the `app_meta` key list loses `deck_search_open` and gains `search_open`.
- [ ] **Step 4: `web-target.md`** — the routed-command table. Run `node scripts/routed-census.mjs --check` and take the counts from it; **do not hand-edit a number a script answers.**
- [ ] **Step 5: `src/CLAUDE.md`** — the docked-column rule gains the two new surfaces to its list of what is *worked out of*; the `FilterBar` bullet gains the two new rows.
- [ ] **Step 6: `src/features/decks/CLAUDE.md`** — the panel's rules point at the shared component rather than repeating it. **And one correction that is owed anyway:** this file still says *"one drop target per element"*, which was pragmatic-dnd's rule. `frontend-design.md` and three code sites already record that dnd-kit keys its registry by entity id and that two registrations both stand, separated by `accepts()`. This page is the last place carrying the old sentence.
- [ ] **Step 7: Re-count every count you touched**, in the same commit. A prose-only edit routes to neither CI job, so nothing goes red when a document rots.

---

# Wave 5 — the coordinator, not a subagent

## Task 9: Verify in the shipped window

- [ ] **Step 1: `npm run verify`.** Then `cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --check` — verify runs neither.
- [ ] **Step 2: Take the app lock** and run `npm run tauri dev`. See the `running-the-app` skill: only one app runs across every worktree and the collision is silent.
- [ ] **Step 3: Measure `LIST_FLOOR`.** At 1280×800, narrow the window until the collection's card wall stops being usable. Write the number into the constant and into `frontend-design.md` with the build and the window size.
- [ ] **Step 4: Check the filter row at the panel's floor.** Drag the panel to `MIN_PANEL_WIDTH_PX` on both pages and confirm no horizontal scrollbar appears across the page. This is `ManaValueChips`' failure — it shipped once as a 25px overhang at every window width, invisible to both suites and to a screenshot.
- [ ] **Step 5: Drive an add and a drop.** Open a folder, add from the sidebar, confirm the copy lands in that folder and not at the root. Then drag a tile onto a sibling folder card and confirm the same. **CDP cannot drive a real HTML5 drop** — Chrome's own drag machinery refuses — so the drop is checked by hand.
- [ ] **Step 6: Check the phone width.** Below `LIST_FLOOR` the panel must draw *over* the list rather than refusing.
- [ ] **Step 7: Record what the pass found** in `docs/reference/frontend-design.md`, including anything that was fine.

---

## Self-review

**Spec coverage.** §1–§2 → Tasks 6, 7. §2.1 (no tab strip) → Tasks 6, 7 Step 5. §2.2 (locked destination) → Task 3 Step 4. §3 → Task 4. §4 → Tasks 4 (hook), 6, 7. §5 → Task 3, plus Tasks 6/7 Step 9. §6 → Task 4 Step 2 (zoom), Tasks 6/7 Step 5 (scopes, labels, attrs). §7 → Tasks 1, 5. §7.1 (the bridge, no rung) → Task 1 Step 3. §8 → Tasks 2, 6, 7. §9 → every task's test steps plus Task 9. §10 is out of scope by construction. §11 → Task 8.

**Type consistency.** `SearchSection` (Task 5) and `SearchSurface` (Task 4) are deliberately two names for one vocabulary: one is the storage key, one is the `data-search-over` value, and they are equal today. Task 5 owns the narrowing. `MIN_PANEL_WIDTH_PX` moves to `CardSearchPanel.tsx` in Task 4 and is re-exported from `DeckSearchPanel.tsx` so no other file's import changes.
