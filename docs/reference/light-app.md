# The light app

The Android and web face of MTG Grimoire — card search, decks, collection, wishlist and scanner —
as one second entry over the desktop's own components. **What is built is phase 1, the skeleton:
it runs in a browser over the Storybook fake and in a phone-sized window over the real Rust core.
There is no Android host, no WASM host, no service worker and no sync on a light install yet.**

- The design, all seven phases: [the spec](../superpowers/specs/2026-10-01-light-app-android-and-web-design.md).
- How the skeleton was built: [the plan](../superpowers/plans/2026-10-01-light-app-skeleton.md).
- The binding rules for anyone changing it: [`mobile/CLAUDE.md`](../../mobile/CLAUDE.md).

This page is the record: what was measured, on what, and what is known to be open.

## 1. What it is, in four sentences

`mobile/` is one Vite entry. At **≥ 1024px** of viewport it draws the desktop UI itself under a
light `Edition` — the same pages, a rail of six rows, no caption row. **Below 1024px** it draws a
phone face of its own in `mobile/phone/`. The Android app and the web app are the same bundle, the
face is chosen by width and by nothing else, and the URL is the navigation state both faces read —
so a browser dragged across 1024 swaps faces and stays where it was.

**Why two faces rather than one responsive one.** The first Android and PWA builds (removed on
2026-09-27, PR #602) bent the desktop's components down to 360px, and the owner's verdict was on
the design, not the engine. Here every component is drawn only at the widths it was designed for.

## 2. What was driven, and on what

**Every figure in this section: 2026-10-01, Windows 11, `npm run mobile:dev` (Vite's dev server,
not a build), the Storybook fake's `starter` seed, driven in the Claude desktop app's built-in
Chromium pane with its viewport emulated.** Nothing here was measured on a phone, in Firefox or
Safari, or against a production bundle. `?art=live` was on, so the pictures are Scryfall's.

### The phone face, 360 × 800

| What | Measured |
| --- | --- |
| Columns on the search wall | 2 |
| Tile width | 162px |
| A tab's box | 72 × 52px, all five; the lit one carries `aria-current="page"` |
| `documentElement.scrollWidth` | 360 — nothing scrolls sideways |
| The card sheet's panel | 360 wide, 752px tall, 24px of scrim above and below |

- A tile is `components/CardTile` — the desktop's own card frame and chin — and reads as one: the
  rarity gem, the set and number, the price, a foil's finish glyph beside it, and the count tag in
  the art's bottom-left for a row of more than one copy.
- The sheet for the seed's first search result, a double-faced card, draws both faces' names,
  costs as mana symbols and rules text, the printing's set line, and three prices with an em dash
  for the finish that printing does not come in.
- Scanner and Settings each draw their one placeholder sentence.
- The console carried no error and no warning from the app.

### The desktop face, 1280 × 800

- The rail's rows are **Search, Decks, Collection, Wishlist, Scanner, Settings**, and Collapse.
  No caption row is drawn (`data-tauri-drag-region` matches nothing).
- The pages are the desktop's own: the search page with its filter bar and the grid-or-table
  pair, the decks gallery with its folder tree, the deck editor with its docked search column.
- `documentElement.scrollWidth` 1280.

### The crossing

| Sequence | Result |
| --- | --- |
| Phone, a card open (`/search?card=…`) → widen to 1280 | The desktop face, the same URL, the same card open in the desktop's card modal |
| Escape on that modal | URL `/search`; `history.length` unchanged — a `replaceState` |
| Desktop: rail → Decks → a deck | `/decks`, then `/decks/2`; one history entry each |
| Desktop on `/decks/2` → narrow to 360 | The phone face on the same deck, its name in the heading and its cards on the wall |

### History on the phone face

| Step | URL | `history.length` | Sheet |
| --- | --- | --- | --- |
| On a deck | `/decks/2` | 5 | — |
| Press a tile | `/decks/2?card=…`, `history.state` `{ pushed: true }` | 6 | open |
| Escape | `/decks/2` | 6 — the router went *back*, it did not push | closed |
| Browser Back | `/decks` | — | closed; the card did not reopen |

## 3. The build

**`npm run mobile:build`, 2026-10-01, before `main` was merged in: exit 0 in 21 s including
`tsc`.** Neither `verify` nor CI runs it.

| Chunk | Raw | gzip | Loaded by |
| --- | --- | --- | --- |
| `index` (the entry) | 244.99 kB | 77.12 kB | the page, statically |
| `routes` (what both faces share) | 282.73 kB | 90.47 kB | either face |
| `PhoneApp` | 14.07 kB | 4.67 kB | the phone face |
| `DesktopFace` | 1,460.89 kB | 438.33 kB | the desktop face |
| `NoteEditor` | 473.06 kB | 148.17 kB | the desktop face, lazily, as in the desktop app |
| the stylesheet | 197.27 kB | 35.44 kB | the page |

- `dist-mobile/index.html` is at the root and there is no `dist-mobile/mobile/`.
- The page's only static script is the entry; each face is fetched when its width asks for it.
  **A phone therefore fetches about 542 kB of script (172 kB gzipped) and never the 1.46 MB
  desktop chunk** — which is the point of the two lazy faces.
- None of the five scripts contains `No fake handler`, `installWorld`, `fakeBoot` or `bootFake`:
  the fake backend is not in a production bundle.
- **Chunk names carry a hash and these sizes are one tree's.** Re-measure rather than quote.

## 4. What the first live pass found

**`npm run mobile:dev` did not stay up.** The server printed its URL and exited a few seconds
later, during "bundling dependencies", with `UNLOADABLE_DEPENDENCY: Could not load
../../../../../.storybook/fake/core.ts`; the page was blank and every dependency request was
`ERR_CONNECTION_REFUSED`. The two Tauri plugins the app imports each import
`@tauri-apps/api/core` from inside `node_modules`, the dependency optimizer applies the fake's
alias while it pre-bundles them, and a root-relative replacement is not a path it can load.

It went unseen for seven tasks because the entry was a stub when it was first served, and no
suite starts a dev server. The fix (`vite.mobile.config.ts`) is absolute alias paths, as
Storybook's are, **and both plugins left out of the optimizer in fake mode** — bundled, each
would carry its own copy of the fake with no world installed in it, so a Copy or an Open-on
would be answered by nobody. That second half is reasoned, not driven: no press in the pass
reached a plugin.

Every jsdom suite was green over this. It is the repo's standing rule — a green suite proves
nothing about the running app — arriving on schedule.

## 5. Open, and where each belongs

Nothing below blocks the skeleton. Each was found by a review or the live pass and left on
purpose; the phase that owns the surface owns the fix.

### Phase 3 — the phone pages (each comes to the owner as built options first)

- **The Collection and Wishlist walls draw open shelves only.** The desktop hooks fetch the cards
  of the shelves the reader has left open, and deck groups, `Recently removed` and a deck's
  managed wishlist folder start shut — so on the `starter` seed the collection wall draws 9 of 12
  rows. When every row is on a shut shelf the page says so; it cannot open one.
- After a refused next page a wall stops asking and says nothing. It re-arms on any refetch of
  that query (a tab away and back, a window refocus), so it is not stuck for the session.
- When the whole-wall figure itself fails to load over an empty wall, the page draws nothing —
  neither empty-state sentence is known to be true. `useWishlist` does return the query that
  could say so; `useCollection` returns only the figure.
- A tile with no card to open (a wish whose card the corpus no longer has) is a button that does
  nothing.
- Two rows of one printing get one accessible name; the desktop wall folds them into one tile.
- `DeckPage` keys its own query, so crossing 1024 with a deck open refetches it; it always reads
  the `live` list; and `facesOf` now exists twice (the desktop's lives in a module that imports
  the store).
- The wall's list semantics count rows rather than cards; no test scrolls a long wall to its end.
- In landscape the bars stop short of the screen's edge beside a cutout — the shell pads the
  root by the side insets. Whether the bars should bleed with their content inset is a device
  pass's call.
- In the light edition `Ctrl+Shift+N` still asks for a new window, and on the desktop face the
  key map has no mount (so `F1` is left to the browser).

### Phase 5 — the web host

- No error boundary around the lazy faces: a failed chunk fetch (offline, or a deploy that
  changed hashes before a resize crosses the floor) leaves a blank page.
- A refused history **push** is swallowed like a refused replace, but costs more than a stale
  URL — the entry is never made. `back()`'s latch has one release, a `popstate`; a
  `history.back()` the browser drops leaves ✕ and Escape inert until the next one.
- `public/light.webmanifest` is copied into every build's output, the desktop's and the share
  viewer's included, because `public/` is shared. It is inert there.
- The manifest's and the page's `#0e0f13` is two levels off `--color-bg`'s real sRGB value.

### The fences

- `fence.test.ts`'s import walk cannot see `import.meta.glob`, a template-literal `import()` or
  a root-absolute specifier; none exists under `mobile/` today.
- Its probe sweep is literal about spelling — a destructured `userAgent`, a bracket access or
  `@tauri-apps/plugin-os` would pass — and reads `.ts`, `.tsx`, `.css` and `.html` only.
- `src/lib/tokens.test.ts` still stops at `src/`: it counts exactly one `MotionConfig`, and the
  phone face rightly mounts its own.

### The dev window

- `window::open_sized_to_monitor` centres the phone-sized window without clamping it. On a work
  area shorter than about 954 logical px — a 1080p panel at 125% or 150% — the OS caption opens
  above the top of the screen.
