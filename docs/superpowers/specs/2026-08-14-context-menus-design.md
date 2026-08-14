# Right-click context menus

**Date:** 2026-08-14
**Status:** approved, not yet implemented

A custom right-click menu across the app, replacing WebView2's own, whose contents depend on
what was clicked. Four subjects: a **card** (anywhere it is drawn), a **deck** and a **folder**
in the gallery, and a **category** heading in the deck editor.

---

## 0. Where this starts from

`onContextMenu` and `contextmenu` appear **nowhere** in this repo. There is no menu primitive,
no clipboard code, no external-link code and no export feature of any kind. Four of the items
asked for have no backend behind them:

| Item | What is missing |
| --- | --- |
| Copy card name | Nothing in `src/` has ever touched the clipboard. No clipboard plugin. |
| Copy card image | The Scryfall URLs are stored (`cards.image_uris`) but sit on **no DTO**. |
| Open on … | No marketplace or Scryfall URL is built anywhere. |
| View all printings | `SearchRequest` has no exact-card filter, and `useCardSearch`'s state is component-local. |
| Export cards | Does not exist in any form. |

Two structural constraints shape everything below, and both are already written down in the
repo's own rules:

1. **`useDismissOnEscape` orders exactly two rungs.** Its doc: two `"inner"` peers "are not
   ordered by it at all: both would consume the same press and both would close." A menu opened
   over a dialog opened over the card pane is a third rung.
   `src/features/decks/CLAUDE.md` already names the fix — "a depth in `useDismissOnEscape`, not
   a second `"inner"` and a hope."
2. **No portal, no popper library.** The shipped CSP is `style-src 'self'` and every overlay
   primitive in reach injects a runtime `<style>`, which fails **silently** — `style.sheet`
   comes back null. Hand-positioned, like `FolderTree`'s `MoveToFolder`.

---

## 1. The primitive

### One instance, at the app root

`<ContextMenuProvider>` wraps the app in `App.tsx` and renders **one** menu, a sibling of
`AppShell` — the position `CardZoomIndicator` already occupies, for the reason stated at that
line: `LAYER.popup` competes only inside the root stacking context, so a menu mounted inside a
view is capped by that view's transformed or positioned ancestors. A menu opened from a
virtualised row would otherwise be capped at that row's `LAYER.raised`.

Surfaces never render a menu. They call `openMenu(items, at)` through context, and the
provider owns the rest. Three properties come free: exactly one menu at a time, a second
right-click replaces rather than stacks, and nothing clips it.

### A menu is data

```ts
type MenuItem =
  | { kind: "action";    id: string; label: string; icon?: Icon; disabled?: boolean;
      reason?: string; onSelect: () => void }
  | { kind: "radio";     id: string; label: string; icon?: Icon; checked: boolean;
      onSelect: () => void }
  | { kind: "submenu";   id: string; label: string; icon?: Icon; items: MenuItem[] }
  | { kind: "lazy";      id: string; label: string; icon?: Icon;
      Content: ComponentType<{ onDone: () => void }> }
  | { kind: "separator"; id: string }
```

**`lazy` is the load-bearing kind.** Its component mounts only when the submenu is expanded, so
`useDecks()` / `useDeckFolders()` / `deck_tag_list` never run because a menu merely *opened*.
This is the general form of the rule stated for the marketplace links: **no work happens before
the reader asks for it.** `submenu` is for items that are already in hand and cost nothing to
build; `lazy` is for anything that would reach the backend.

`reason` is drawn beside a disabled item — the commander/companion refusal, and nothing else so
far.

### Positioning

`fixed`, at the pointer, at `LAYER.popup`. Flipped when it would overflow, measured against
**`document.documentElement.clientWidth` / `clientHeight`** and never `window.innerWidth`. That
is not a preference: `innerWidth` includes the classic scrollbar and the initial containing
block a `fixed` box lays out against excludes it — measured in this app at **1280 against
1265**, which is how the zoom badge came to sit 15px off the corner it was anchored to.
**jsdom has no layout engine**, so `clientWidth` is a hard `0` on every element there; a test
must state a viewport width itself, and must not state it as `window.innerWidth`, which is the
buggy expression this repo has already pinned once as an expected answer.

Submenus open right and flip left near the edge, anchored to and growing from the corner
nearest their parent row — the anchored-popup rule in `src/CLAUDE.md`.

### Dismissal

| Event | Result |
| --- | --- |
| Escape | closes one level: submenu, then menu |
| outside `pointerdown` | closes, focus not moved |
| any ancestor scroll | closes — the panel is `fixed` from a point that has moved |
| window resize | closes |
| another right-click | replaces |
| item selected | closes, focus returns to the element that was right-clicked |

### The Escape depth

`useDismissOnEscape` keeps its capture/bubble phase split exactly as it is. Added: a
module-level stack of the **capture-phase** layers. A capture listener acts only when it is at
the top of that stack; registration order is mount order, and the menu always mounts last
because it opens over everything.

A lone `"inner"` layer is a stack of one and behaves identically. **`App.test.tsx`'s
Escape-stack test and `useDismissOnEscape.test.ts`'s phase test must stay green with no edit**
— that is the acceptance criterion for this change, not a hope about it.

The result is one press per layer: submenu → menu → dialog → card pane.

### Keyboard

Chosen: **open by keyboard, arrows and Escape, no type-ahead.**

- `Shift+F10` and the `ContextMenu` key open the menu on the focused element, positioned at
  that element's bottom-left rather than at a pointer that was never there.
- `ArrowDown`/`ArrowUp` move, wrapping; `Home`/`End` jump.
- `ArrowRight` / `Enter` opens a submenu and moves into it; `ArrowLeft` / `Escape` leaves it.
- No type-ahead, no `Home`/`End` inside submenus beyond the above.
- The menu takes focus on open and hands it back to the right-clicked element on close, which
  is the app's existing rule for a layer Escape dismissed. An outside click deliberately does
  not move focus.

`role="menu"` / `menuitem` / `menuitemradio`, `aria-haspopup` and `aria-expanded` on submenu
rows, `aria-disabled` and never the `disabled` attribute — a `disabled` button leaves the tab
order, and the greyed commander item has to stay reachable to be readable.

---

## 2. Native menu policy

| Where | What happens |
| --- | --- |
| `<input>`, `<textarea>`, `contenteditable` | **native menu survives** — cut/copy/paste/undo and spellcheck suggestions, none of which we can rebuild |
| card / deck / folder / category | ours |
| everything else — background, ribbon, sidebar, art | suppressed, nothing shown |

Suppression is one document-level `contextmenu` listener that calls `preventDefault()` unless
the target is inside a text field. A WebView2 menu offering "Reload" and "View source" does not
belong in a shipped desktop app.

---

## 3. The card menu

### The target type

```ts
interface CardMenuTarget {
  cardId: string;              // the printing
  name: string;
  setCode: string;
  collectorNumber: string;
  oracleId: string | null;
  finishes: string | null;     // the printing's finish list, as stored JSON
  finish?: Finish;             // only where the surface names one
  faceCount?: number;
}
```

Every card surface builds one, from the row it already holds: search grid and table, collection
grid and table, wishlist, the deck editor's Stacks/Table/Text/Grid, the docked deck-search
panel, the card detail pane, the printings list. **Out of scope:** the deck cover picker, the
import preview and the theory-diff dialog — a right-click during a modal task is more likely a
misfire than an intent.

`finish` is present on collection rows (which carry one) and on a wishlist row with a
`preferredFinish`. It is absent on search tiles, deck cards and printings rows — **a deck names
a printing, not a finish**, and `DeckCard` has no finish field by design.

**The printings list is the one adapter that reads two objects.** A `Printing` row carries
`setCode`, `collectorNumber` and `finishes` but **no `name` and no `oracleId`** — it is a
printing *of the card the pane is open on*, so those two come from that `CardDetail`. Getting
this wrong is invisible: the menu would still draw, and "Copy card name" would copy `undefined`.

### Items

```
Copy card name
Copy card image
Open on              ▸  Scryfall
                        <the marketplace named in Settings>
View all printings
─────────────────────
Add to               ▸  Collection      (submenu when the finish is ambiguous)
                        Wishlist
                        Deck            ▸ folders ▸ decks ▸ Live / Theory
```

**Copy card name** — the printed name, verbatim.

**Copy card image** — the `display` variant's Scryfall CDN URL: the full card at the largest
WEBP size stored. It is a `.webp` carrying Scryfall's `?<epoch>` cache-buster, not the `.png`
people may expect: the ingest keeps four of Scryfall's eleven image keys and drops the seven
legacy JPG/PNG ones its own docs mark as replaced (`png` alone would be 161 GB across the
library). A double-faced card copies the front.

**Open on** — exactly two entries. The second is named for the marketplace set in Settings
("Card Kingdom", "Cardmarket"), never a picker at the point of use, which is how the whole app
treats that setting. Scryfall is the derived permalink
`https://scryfall.com/card/<setCode>/<collectorNumber>` — built in TypeScript from fields every
surface already holds, so it works for a wishlist row and a deck card as well as a search
result, and costs no backend change (the canonical `scryfall_uri` is only inside the gzipped
`raw` blob). The marketplace entry is that site's **search URL for the card name**: none of the
four priced sites publishes a per-card URL derivable from what is stored.

**Nothing is fetched, resolved or opened until the item is clicked.** The menu builds a string;
`@tauri-apps/plugin-opener`'s `openUrl` is called on selection and not before.

**View all printings** — two behaviours, by where it was pressed:

- **Outside the deck editor:** navigates to Search and filters to that oracle card. Clears
  format, colours, sets, mana values and owned; sets **All printings ON** and **Unplayable ON**.
  "Show me everything that is this card" — without clearing, a Modern-filtered search hides the
  card's Vintage-only printings; without Unplayable, its art-series and token printings stay
  hidden.
- **Inside the deck editor:** opens the docked card detail pane on that card, whose printings
  list is already the answer, and the deck stays open. Navigating would close it —
  `setActiveView` clears `openDeckId` by design.

**Add to → Collection** — one copy, **exactly the printing that was clicked**, Near Mint,
English. Finish: the row's own where the surface names one; where it does not, a submenu of the
finishes that printing exists in — except where the printing has exactly one finish, which adds
silently. A collection row's identity is
`(card_id, finish, condition, lang, altered, signed, proxy, misprint, serial, grading)`, so
finish and condition have to come from somewhere; every other field takes its default.

**Add to → Wishlist** — **this exact printing**, not "any printing".

**Add to → Deck** — true nested submenus mirroring the folder tree, then the deck, then
**Live / Theory**. Four cascade levels at the deepest. The card is filed by `autoCategoryFor`,
the app's single rule that a plain add, a drag with no column under it and an imported line all
share — an add naming no category is filed by what the card *does*.

The whole subtree is `lazy`: the folders and decks are fetched when **Add to → Deck** is
expanded, never when the menu opens.

---

## 4. The deck-card menu (deck editor only)

The card menu above, plus:

```
─────────────────────
Move to              ▸  every category of the deck, active and inactive
Set as commander        (greyed with a reason when ineligible)
Set as companion        (greyed with a reason when ineligible)
Tag card             ▸  None / the deck's tags / New tag…
```

**Move to** — built from `DeckEditor`'s `categories` array (every category the deck has, in
`sortOrder`), **not** from the drawn groups. This restores a route the app deliberately lost:
the per-card `Move…` select was removed on 2026-08-14, and the repo names the two costs — there
is **no keyboard path to moving a card at all**, and a pile with no drawn heading cannot be
moved into, because a heading that is not drawn is not a drop target. This menu closes both.
It is the replacement for that control, not a duplicate of the drag.

**Set as commander / companion** — present only where `FormatSpec.requiresCommander` /
`FormatSpec.allowsCompanion`, so they never appear in Standard or Modern. Within a format that
allows one, an ineligible card shows the item **greyed with its reason** — "not a legendary
creature", "colour identity outside the commander's". The reason comes from
`validation/commanders.ts`'s `commanderIneligibility` and `validation/companions.ts`, the same
rules the validation panel judges a built deck by and the importer offers candidates by. A
looser test here would offer a card the panel then refuses.

The write is a `moveCard` into the deck's `commander` / `companion` category.

**Tag card** — a radio list, because **a deck card wears at most one tag**
(`setTag` takes `tagId: number | null`). "None" unsets. "New tag…" opens an inline field; the
new tag takes `DEFAULT_TAG_COLOR` silently — recolouring is what `TagsDialog` is for. The tag
list is `lazy`.

---

## 5. The deck menu (gallery)

```
Open deck
─────────────────────
Rename…
Move to              ▸  the folder tree, nested
Deck settings…
─────────────────────
Duplicate
Delete…
```

**Rename** has no inline affordance today — renaming a deck currently means opening the editor
and typing into its settings dialog. This adds an inline field on the tile, modelled on the
folder rename that already exists (`metaRows.tsx`'s `RenameField`).

**Deck settings** opens `DeckSettingsDialog` **over the gallery**, on the deck that was
right-clicked, without opening the editor. `DeckSettingsForm` owns no mutation and imports no
backend hook by design — it is drawn by two hosts today, so a third is the shape it was built
for. `DecksPage` becomes that third host.

**Duplicate** and **Delete** are already corner buttons on the tile; `useDecks` owns both.
Delete keeps the same confirmation step it has there — a menu that opens by accident must not
be one press from an irreversible write.

## 5b. The folder menu (gallery)

```
New deck here
New subfolder…
─────────────────────
Rename…
Move to              ▸  the folder tree, itself and its descendants inert
─────────────────────
Delete…
```

Pure reuse: every action already exists as a button in `FolderTree`, every write is already
written, and `folderDescendants` already computes what a folder may not be moved into.

---

## 6. The category menu (deck editor)

```
Rename…
─────────────────────
Import cards…
Export cards…
─────────────────────
Deactivate / Activate
Delete…
```

**Deactivate** is `set_category_active` — an inactive category counts toward nothing: not size,
not copy limits, not legality, and the allocator claims no copy for it.

**Delete** is refused for the four predefined zones (Commander, Sideboard, Companion,
Maybeboard), so both destructive entries are simply **absent** on those rather than greyed.

**Import cards** opens `ImportDeckDialog` and files the **whole pasted list into the category
that was right-clicked**, overriding `autoCategoryFor`. That is consistent with the rule the
importer already follows — an add that names a category is left untouched — and it is what
right-clicking a specific pile means. This is a new argument on the import path, not a new
import path.

**Export cards** — see §8.

---

## 7. Backend

Three additions. Everything else is frontend.

### `card_image_uri(cardId, variant) -> Option<String>`

The Scryfall URLs live in `cards.image_uris` (four WEBP keys) and are on no DTO. This is a
**command called on selection**, not a field added to `CardSummary` / `DeckCard` /
`CollectionRow` / `WishRow` / `Printing`: one indexed lookup on a deliberate user act, no
~100-byte string on every row of every list, and it obeys the same "not before the click" rule
as the marketplace links. Reads through `db_read` like every other read.

### `oracleId` on `SearchRequest` and `CardFilters`

There is no exact-card filter today; `text` is FTS **prefix** matching, so a name search
answers other cards. `cards.oracle_id = ?1`, and **`idx_cards_oracle ON cards(oracle_id)`
already exists** in `CARDS_INDEXES`, so this is indexed for free.

Absent means unset, like every other filter. It ANDs with the rest.

### `export_write_file(path, contents) -> Result<()>`

**`dialog:allow-save` alone is not enough**, and this is the one place the approved design was
refined. `save()` returns a **path**; writing bytes at it from the webview would need an `fs:`
permission, and this app grants none anywhere — deliberately, per `src-tauri/CLAUDE.md`:
`tauri-plugin-fs` is in `Cargo.lock` transitively and is **unreachable** because no `fs:`
permission exists.

The app already has the right pattern. `deck_set_cover_image` takes a path and Rust opens the
file, "so no filesystem permission of any kind is needed". Same shape here: the dialog asks for
a name, Rust writes the text.

### Capabilities and dependencies

`capabilities/default.json` gains exactly two lines, both narrow, neither a `:default`:

```
"dialog:allow-save"                  // the Save as… picker
"clipboard-manager:allow-write-text" // and not allow-read-text
```

`tauri-plugin-clipboard-manager` is added to `Cargo.toml` and
`@tauri-apps/plugin-clipboard-manager` to `package.json`. Chosen over `navigator.clipboard`
deliberately: the web API *should* work (`http://tauri.localhost` is a localhost subdomain and
therefore a secure context) but nothing in this app has ever proved it, and the failure mode is
in the packaged exe only.

---

## 8. Export

`src/features/decks/export/`, beside the existing `import/` — the repo's boundary puts
import/export parsing in TypeScript, and Rust supplies only the file write.

| File | Owns |
| --- | --- |
| `format.ts` | pure: `(cards, format) => string`. No React, no hook, no IPC. |
| `ExportDialog.tsx` | the surface: format picker, live preview, Copy, Save as… |

Formats: **Plain** (`1 Lightning Bolt`), **MTGO**, **Moxfield**, **CSV**. The dialog is built on
`DeckDialog`, the shared modal shell — a new modal in the deck surface is built *on* that file
rather than beside it.

Category-level in this branch. The same `format.ts` is what a later deck-level export uses; the
dialog is written so that the set of cards is an argument rather than something it fetches.

---

## 9. Cross-view search intent

`useCardSearch` holds its filters in component-local `useState` inside `SearchPage`, so nothing
outside can set them. `src/lib/store.ts` gains:

```ts
pendingCardSearch: { oracleId: string; name: string } | null;
requestAllPrintings: (t: { oracleId: string; name: string }) => void;  // + setActiveView("search")
consumePendingCardSearch: () => { oracleId: string; name: string } | null;
```

`useCardSearch` consumes it **once** — consumed on read, so a second visit to Search does not
re-apply a filter the reader has since cleared. Applying it clears every filter and sets
`allPrintings` and `unplayable` on.

Not a router and not a query: this is UI state that outlives a component tree, which is exactly
what the store is for.

---

## 10. Files

**New**

```
src/components/menu/types.ts
src/components/menu/ContextMenuProvider.tsx
src/components/menu/ContextMenu.tsx
src/components/menu/Submenu.tsx
src/components/menu/useContextMenu.ts
src/features/card/cardMenu.tsx
src/features/decks/deckMenu.tsx
src/features/decks/folderMenu.tsx
src/features/decks/categoryMenu.tsx
src/features/decks/export/format.ts
src/features/decks/export/ExportDialog.tsx
src/lib/externalLinks.ts
src/lib/clipboard.ts
src-tauri/src/export.rs
```

**Changed**

```
src/lib/useDismissOnEscape.ts      the capture-layer stack
src/lib/store.ts                   pendingCardSearch
src/lib/ipc.ts                     three commands
src/features/search/useCardSearch.ts  oracleId + intent consumption
src/App.tsx                        the provider
src-tauri/src/search.rs            card_image_uri, oracleId
src-tauri/src/filters.rs           oracleId
src-tauri/src/lib.rs               command registration
src-tauri/capabilities/default.json
src-tauri/Cargo.toml  ·  package.json
.storybook/fake/db.ts              the three new commands
```

Plus one `onContextMenu` line on each card surface listed in §3, the deck tile, the folder row
and the category heading.

---

## 11. Testing

**Unit (Vitest)** — `format.ts` per format including a split card and a double-faced name;
`externalLinks.ts` per marketplace and for a collector number needing escaping; the menu model's
keyboard traversal; `useDismissOnEscape`'s new depth, with the two existing tests unedited;
`useCardSearch` consuming an intent exactly once.

**Rust (`cargo test`)** — `card_image_uri` for a card with no `image_uris` and for an unknown
id; the `oracleId` filter's `EXPLAIN QUERY PLAN` using `idx_cards_oracle`; `export_write_file`
refusing nothing it should accept and writing what it was given.

**Storybook** — the menu open on each subject, a submenu expanded, a greyed commander item with
its reason, and the export dialog per format. Story **plays** are controller work after fan-in
(`stories.test.tsx` collects the whole tree), not each subagent's.

**Live, over CDP** — the part the suite cannot answer, and where every UI task in this repo's
plans has found something:

1. The menu is not clipped by a virtualised row, by the deck editor's `overflow-y-auto` page,
   or by a docked panel — right-click a card in the last row of the search wall and in the
   deck editor's rail.
2. The flip at the right and bottom edges is measured against `documentElement.clientWidth`,
   at 1280×800 with and without a page scrollbar.
3. Escape closes exactly one layer per press through the deepest stack the app can build:
   submenu → menu → dialog → card pane.
4. **No horizontal scrollbar on the deck editor at 1024, 1280 and 1920** — the one thing the
   1024px floor forbids, and a four-level cascade near the right edge is a new way to reach it.
5. The clipboard actually receives text in the packaged window, not only in dev.
6. Reduced motion: the menu's open animation is a scale/opacity pair, so `MotionConfig
   reducedMotion="user"` reduces the transform and leaves opacity animating — assert that,
   not that everything stops.

---

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| The Escape depth change breaks a layer nothing tests | Both existing Escape tests must pass **unedited**; the live pass drives the deepest real stack. |
| A four-level cascade overflows the window | Flip logic measured live at three widths; the 1024px floor is the acceptance test. |
| The clipboard plugin behaves differently in the packaged exe | It is the plugin *because* the web API was unproven; still verified in a real window. |
| Import-into-a-named-category changes shared importer behaviour | The argument is optional and defaults to today's behaviour; the toolbar's Import passes nothing. |
| The card surfaces drift in what they put in a `CardMenuTarget` | One builder function per surface, one shared type, and the menu is built in **one** place from that type. |
