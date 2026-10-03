# The light app, phase 3 — the phone face's pages

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking. Each step is **one
> pull request**, opened with auto-merge armed and driven to merged before the next one starts
> on the same branch. Tick a step here and on [issue #761](https://github.com/Msgaihede/mtg-grimoire/issues/761)
> when its PR merges.

**Goal:** every destination of the light edition has a real page below 1024px — Search with its
filters, the card sheet, the two cabinets, the deck gallery and a deck editor close to the full
one, writes, import and export, and a light Settings on both faces — and phase 1's leftovers are
closed or handed on by name.

**Spec:** [the light-app design](../specs/2026-10-01-light-app-android-and-web-design.md) §3 and
§4. **Rules:** [`mobile/CLAUDE.md`](../../../mobile/CLAUDE.md). **Record:**
[light-app.md](../../reference/light-app.md) §5 (what phase 1 left open) and §7 (what this phase
measured, one subsection per step).

## Decided before starting (Markus, 2026-10-03)

- **One PR per step**, in the order below, each with auto-merge and auto-fix.
- **The first slice is Search and the card sheet**: the card sheet is what every later page opens.
- **No built-options round for this phase's pages**: the implementer builds its best pick, ships
  it, and the owner redirects in review. The spec's "built options first" is waived for phase 3
  by the owner, not forgotten.
- **The deck editor at 360px is a single column**: the stacks one above another, **the commander
  first and the side rail last**. Nothing is laid side by side below 1024px.

## Global constraints

- **The phone face reaches nothing welded to the desktop.** `mobile/phone/fence.test.ts` is the
  fence. A component it wants that reads the store is changed in `src/` to take props, or its pure
  half is split into a store-free module — never copied. A refusal prints the trail; fix the edge
  it names, never the fence.
- **Nothing under `mobile/` asks where it is running**, comments included.
- **No new dependency, no new IPC command, no Rust.** Every read and write a page needs is already
  in `ipc.ts`; phase 3 never waits on phase 2, and the command table grows only when a host does.
- **The desktop is unchanged by construction.** A `src/` file split for the phone face keeps
  every desktop caller and test as it was, re-exporting from the old path where that is cheaper
  than editing callers.
- **Every page is checked at 360 and at 800 wide** in Chromium over the Storybook fake
  (`npm run mobile:dev`), and nothing scrolls sideways. A real phone is phase 4's.
- **Tests run once per step, after fan-in**: `npm run build`, `npm run lint`, `npm run test:run`.
  No step touches Rust, so the `rust` and `core` jobs are the CI router's to skip.

## Steps

- [x] **3.1 — Search and the card sheet** (#785, merged 2026-10-03). The sticky line (the box and one `Filters` button with
  the active count), the stated filters under it, and the filters sheet over the desktop's own
  `useCardSearch`: sort, format, colours and `Exact`, mana value, rarity, type, border, finish,
  owned, set, price, printings — faceted by `facets.ts` exactly as the desktop's tray is. The card
  sheet grows printings (a step to another printing is a *replace*, §5's constraint), legality,
  tags (oracle and art, with "never fetched" its own sentence) and the combos row's four states.
  Phase 1's leftovers closed here: a wall's refused next page says so and offers `Try again`;
  `facesOf` lives once. The `Open on …` rows wait for the host seams (phases 4 and 5).
- [x] **3.2 — Collection** (#791, merged 2026-10-03). The cabinet: folders and shelves as headed groups, every shelf
  openable (deck groups and `Recently removed` included), the collection's figures, filters
  through the same sheet over `useCollection`. Two rows of one printing get two names.
- [x] **3.3 — Wishlist.** The cabinet and its folders, the managed wishlist as a read, the
  `elsewhere` mark; a wish with no card to open is not a button that does nothing.
- [x] **3.4 — Decks, read** (#787, merged 2026-10-03). The gallery with covers and folders; the deck page as one column —
  the commander first, then each stack (category) one above another with its count and its cards,
  the side rail last (validation, the bracket estimate, notes and to-do lists, tokens). Actual and
  Theory both readable; the deck query shared with the desktop's.
- [ ] **3.5 — Writes.** *3.5a, the deck writes, merged as #790 (2026-10-03); 3.5b — the collection's and the wishlist's — follows.* Quantities, categories, labels, printings and finishes in a deck; entry
  edits in the collection and the wishlist; add to a deck, the collection or the wishlist from the
  card sheet; deck notes and to-do lists edited. Each through the command the desktop already
  calls, with the desktop's undo where it has one.
- [ ] **3.6 — Import and export on the phone face.** The collection's and a deck's, through the
  existing parsers and writers; a file arrives through `<input type=file>` and leaves as a
  download, which the host seams answer on each install.
- [x] **3.7 — Light Settings, on both faces** (#788, merged 2026-10-03). The edition grows its Settings entries (spec §3.1:
  `SettingsPage`'s entry list is the edition's second reader): sync and pairing, the supporter
  block, card data and the optional feeds, the image cache, marketplace, the danger zone.
- [x] **3.8 — What phase 1 left, and the measurements** (#789, merged 2026-10-03). Stories for phone UI (Storybook's globs
  reach `mobile/`); `src/lib/tokens.test.ts` reads `mobile/`; the desktop face below its 700px
  height floor measured in a browser; the tablet rail decided; the shared binder and
  `Ctrl+Shift+N` in the light edition; the two history warts across the floor; a crossing that
  discards half-typed text; the bars beside a landscape cutout.
