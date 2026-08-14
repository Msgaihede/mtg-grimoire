# src — the React frontend

**TS owns domain logic** (deck validation, import/export parsing); Rust supplies facts. Keep
that boundary. `src/lib/ipc.ts` is a **hand-written mirror** of the Rust structs and can drift
silently — nothing type-checks it against the crate.

## Before writing any UI

- **All frontend work follows the `frontend-design` skill** (invoke it before UI tasks) and the
  visual direction doc: `docs/superpowers/specs/2026-08-04-visual-design-direction.md`.
  Implementers execute that direction (palette, type, mana line, filter chips) — they do not
  invent their own.
- **Always use the `mtg-grimoire-sb-mcp` MCP tools** to access Storybook's component and
  documentation knowledge before answering or taking any action on a component.
- **CRITICAL: never hallucinate component properties.** Before using ANY property on a design
  system component — including common-sounding ones like `shadow` — check it with the MCP tools:
  `list-all-documentation` for the component list, `get-documentation` for one component's
  properties and examples. Only use properties that are explicitly documented or shown in an
  example story. A story name might not reflect a property name correctly. If a property isn't
  documented, do not assume it from naming conventions or other libraries — ask the user.
- `get-storybook-story-instructions` fetches the current story conventions; `run-story-tests`
  checks your work.
- **A green test suite and a green Storybook prove nothing about the shipped window.** Drive the
  real WebView2 over CDP — [docs/reference/live-ui-verification.md](../docs/reference/live-ui-verification.md)
  is the harness contract, and it is where every UI task in Plans 2–3 found what the suite could
  not.

## Binding rules

Every one of these has its measurement and its story in
[docs/reference/frontend-design.md](../docs/reference/frontend-design.md).

- **Card art is drawn with `components/CardImage`, never a bare `<img>`.** It keys the image on
  its own URL. A browser keeps painting an `<img>`'s last decoded frame until the new `src`
  decodes, and every card frame here belongs to a _slot_ rather than to a card — so without the
  key the picture lags the caption by the length of the fetch. **This is invisible to the DOM
  and therefore to a test in the obvious place**; assert element _identity_.
- **A card frame is `components/CardArt`** — the 5:7 box, `CardImage`, `useImageRetry`, the
  no-art fallback and the foil marking, in one place.
- **A card's marks share one chip in the art's top-right corner** — `FoilOverlay` draws the
  finish glyph and `GameChangerMark`'s gold crown side by side, because a card fact and a
  printing fact in two boxes start a row of stickers. The crown is `GameChangerBanner`'s glyph
  without its ribbon — one fact drawn three ways (the stack's banner, the other deck views' `GC`,
  this), differing only in the room each has. One gold (`text-pie-gold`) everywhere, never the
  destructive colour, which belongs to a rule break. `FoilOverlay mark={false}` turns the whole
  chip off, crown included, for a frame that names these somewhere else.
- **`pointer-events` inherits, so a `title` or an SVG `<title>` inside anything
  `pointer-events-none` is a tooltip that can never be shown — and nothing goes red.** A hit
  target is invisible to the DOM, so no test sees it either. `FoilOverlay`'s chip is
  `pointer-events-auto` against its wrapper's `none` for exactly this reason; it is inside the
  enclosing button, so a click on it still opens the card.
- **An `art` crop has no printed frame, so wherever one is shown the illustrator must be
  credited** (Scryfall's image policy). A `grid`/`thumb`/`display` image carries the printed
  credit itself and needs nothing. Never distort, blur, recolour or watermark a card image, and
  never crop off a printed credit.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts`** and nowhere else; `src/lib/layers.test.ts`
  sweeps `src/` to keep it that way. The ladder is
  `raised 10 < header 20 < popup 30 < dragTray 40 < overlay 45 < gate 50`. Equal z-indexes are
  resolved by document order, and a popup inside a virtualised row is capped by that row's layer
  whatever it asks for.
- **Escape closes one layer per press, and the protocol is a handshake, not a z-index.** An
  inner dismissible layer listens on `window` in the **capture** phase and calls
  `preventDefault()`; an outer one listens in the bubble phase and returns early on
  `e.defaultPrevented`. Capture is load-bearing — two `window` listeners for one event run in
  _registration_ order. Every new dismissible layer follows this or it will close something it
  did not open. A layer that Escape dismissed hands focus back to whatever opened it; an
  outside-click deliberately does not.
- **An anchored popup is pinned to, and grows from, the corner nearest its trigger's own edge**
  — `right-0`/`origin-top-right` at the right end of a row, `left-0`/`origin-top-left` at the
  left. Nothing clips these popups, so one that overflows scrolls the whole app sideways; and
  the corner it is pinned by has to be the corner it grows from, or the panel reads as unrelated
  to the control that produced it. Mirroring one anchor onto another popup is wrong in both
  directions — see the two comboboxes in
  [frontend-design.md](../docs/reference/frontend-design.md).
- **Money is drawn with `formatPrice(value, currency)` and the currency comes from
  `useMarketplace()`** — never a bare `Intl.NumberFormat`. **The marketplace is a query
  parameter and Rust answers one price per row**, so a cell renders the number it was given and
  nothing downstream of `src/lib/marketplace.ts` picks between fields. Every price-bearing query
  carries `marketplace` and has it **in its key**, so switching refetches — against local
  SQLite, which is what every other filter here already does. (It used to be a re-render off
  twin `*Usd`/`*Eur` fields; that shape did not survive a third source, because Card Kingdom's
  and Mana Pool's prices live in `marketplace_prices` rather than in `cards.prices`.) The one
  field anything may branch on is `Marketplace.feed`, and only to talk *about* a feed — when it
  was pulled, that a refresh is running — never to decide what a price is.
- **A `null` price is the answer, never a reason to reach for another marketplace's.** No two
  marketplaces have the same holes: `eur_etched` does not exist in Scryfall's data, so an etched
  card on Cardmarket renders an em dash, and a printing a bulk feed has never listed renders one
  there. `unpriced` counts are summed at the same marketplace as the figure they sit beside and
  never travel across a switch. The collection's stored `purchase_price` never converts and
  never moves with this setting: it is what was paid.
- **A card is a priced answer too, and `finishPrices` is the whole of what a pane draws.**
  `card_detail` and `card_printings` take a `marketplace` like every list query and answer
  `{ nonfoil, foil, etched }` per printing, each nullable, built by `sorting::price_expr`. The
  raw `prices` blob is **gone from both DTOs** on purpose: it is TCGplayer's six keys and
  Cardmarket's, and it is structurally blind to the two marketplaces whose prices live in
  `marketplace_prices` — a pane reading it could only ever draw em dashes on half the picker.
  `src/lib/finish.ts`'s `finishPrice` survives for the **workbench alone** (the fake's fixtures
  and `CollectionTable.stories.tsx` derive story figures from the generated `cards` rows); no
  surface may price with it.
- **Dim text is `text-dim`, never `text-muted`** — the latter still compiles and now paints text
  in the surface colour, i.e. very nearly invisible. `src/lib/tokens.test.ts` guards it.
- **Tailwind scans source text for whole class names**, so a class built by interpolation emits
  no rule at all. Variant spellings (`has-[[aria-expanded=true]]:z-10`) are written out;
  a column template is an inline style, not an arbitrary value.
- **`aria-disabled`, never the `disabled` attribute**, on anything that greys as the reader
  types — a `disabled` button leaves the tab order. The one exception is a native `<option>`.
- **`loading="lazy"` belongs on a plain scroller, not on a virtualised one** — the virtualiser
  has already made the request count small, so the browser's gate only delays the pictures about
  to be looked at.
- **Ctrl+wheel zooms the card sections and nothing else.** One `cardZoom` in `useAppStore`, stepped
  along the ten-stop ladder in `src/lib/cardZoom.ts` (0.5×–2×) and attached per card section through
  `useCardZoomGesture` — `CardGrid`'s scroller, `StackView`'s and `GridView`'s roots. The shell, the
  tables and the card pane never scale. Three rules carry it, each with a live failure behind it in
  [frontend-design.md](../docs/reference/frontend-design.md): the gesture needs a **native**
  `addEventListener` with `{ passive: false }` (React's `onWheel` is passive, so `preventDefault`
  does nothing and WebView2 zooms the whole window on top of you); the zoom rescales **geometry**
  and is never a `transform: scale()`; and **a scaled budget holding unscaled chrome floors rather
  than scales** — `max(base, scaled(base, zoom))`, which is why `CardGrid`'s caption, `CardStack`'s
  34px reveal and `GridView`'s gutter all grow without shrinking. Session-only by design: no
  persistence, matching `searchView`/`collectionView`.
- **The three tables are one component**, `src/components/table/VirtualTable.tsx`: columns are
  data; only `renderRow` and `extraHeight` stay callbacks. **A header sorts by what its column
  shows**, Shift builds a multi-key sort, and `aria-sort` goes on **every** sorted column. A
  column's own description belongs on the `columnheader`, not on the button inside it —
  name-from-content does not reach into a descendant's `aria-label`.
- **Every option list — `<select>` or hand-rolled listbox — is drawn through `sortOptions` in
  `src/lib/options.ts`.** Alphabetical by the **display label**, never the key, through one
  `Intl.Collator` pinned to `"en"`; a faceted control passes grouping levels so its greyed rows
  sink below its pickable ones (`SetCombobox` also floats the picked ones to the top, because
  the list is capped). **Ordering is a display decision, so it lives in TS** — Rust's `ORDER BY`
  is not the bug when a picker reads wrong. Pinned rows (`Any format`, `Custom…`,
  `Auto (by what it does)`, `Top level`) stay outside the sort, and `CategoriesPanel`'s
  `are deleted with it` stays pinned **last**. **Exactly two exemptions**: a grade scale (card
  condition, Near Mint → Damaged) and an order the reader arranged themselves (deck categories).
  Both carry a comment at the site; see
  [frontend-design.md](../docs/reference/frontend-design.md).
- **Global actions (Refresh, sync status, settings) live in the top ribbon, not in views**, and a
  long job registers an `Activity` (`src/lib/activity.ts`) rather than wiring itself in.
  Registration is declarative: pass the job or `null` every render.
- **The ribbon's status line is one permanently mounted `role="status"`** — a live region that
  first appears with its sentence already inside announces nothing — and the number inside it is
  `aria-hidden`.
- Mana/set symbols come from the bundled `mana-font`/`keyrune` npm packages, **never a CDN**.
- shadcn components: always `npx shadcn@latest add <x>` with Radix base (components.json). The
  app palette maps `accent` to a **text** colour (gold), so rewrite a vendored component's
  `bg-accent` surfaces to `bg-surface`. `bg-muted` needs no rewrite.
- Card images arrive over `mtgimg://`; `mtgimg:` is an `img-src` and nothing else — **read images
  with `<img>`, never with `fetch`** (a `fetch()` at it fails CORS by design).

## Motion (`motion@13.1.0`)

Full detail and every measurement: [docs/reference/motion.md](../docs/reference/motion.md).

- **Timings live in `src/lib/motion.ts` and nowhere else.** Import a **preset** (`scrim`,
  `drawerRight`, `dialog`, `popup`, `statusLine`, `press`, `stackCard`) rather than a number.
  `src/index.css` carries the same scale so CSS-only sites agree. There is no `duration-base`
  utility — `--duration-*` is not a Tailwind v4 namespace, so it is read as
  `duration-[var(--duration-fast)]`; `--ease-*` **is** one, so `ease-standard` is real.
- **Two public APIs are forbidden: `AnimatePresence mode="popLayout"` and `animateView()`.**
  Both append a `<style>` element to `document.head`, which `style-src 'self'` blocks — and
  **the failure is silent**: `style.sheet` comes back null, popLayout simply does nothing and
  siblings jump. `MotionConfig nonce` is not an escape. `mode="sync"` and `"wait"` are fine.
  **`devCsp` has `style-src 'self' 'unsafe-inline'` and the shipped `csp` does not**, so dev,
  Storybook and jsdom are all green on this and only the packaged exe breaks. A source sweep in
  `src/lib/tokens.test.ts` is the only thing that catches it.
- **`<MotionConfig reducedMotion="user">` is mounted once, in `App.tsx`** — not `main.tsx`,
  which nothing in the suite or Storybook loads. Motion ships `reducedMotion: "never"`, so that
  line is load-bearing rather than decorative.
- **It only reduces positional keys, which is a trap with a live example.** `marginBottom` is
  **not** among them, so the deck stack's 293px reflow would have travelled at full speed.
  **Any `motion` animation of a non-positional property needs its own `useReducedMotion()`
  opt-out.** That hook is a per-component branch: it reads its value once and **never updates
  on a live media-query change**, so it is the wrong thing to reach for as an app-wide switch.
- **Tailwind v4's `scale-*` writes the `scale` longhand, not `transform`**, so a
  `transition-[…,transform]` list does not tween it and the press snaps. The shared press recipe
  names `scale` explicitly; verify it in the built CSS, not in source.
- **Under jsdom the animations are real and timing-dependent**, which is why
  `MotionGlobalConfig.skipAnimations = true` is set in `src/test-setup.ts`. Even so, **a
  `motion` element's first painted frame carries its `initial`, so `toBeVisible` is false for
  everything inside an animated surface until the next frame** — assertions about content inside
  a newly opened overlay need `waitFor`.
- **The old `\btransition-(?!none)` sweep is blind to JS motion** — a file animated entirely
  through `motion` matches nothing and passes trivially.

## Layout

| Path | What lives there |
| --- | --- |
| `components/` | Shared UI — `CardImage`, `CardArt`, `table/VirtualTable` |
| `features/` | `card`, `collection`, `decks`, `search`, `settings`, `wishlist` |
| `lib/` | `ipc.ts` (the Rust mirror), `layers.ts`, `activity.ts`, `sort.ts`, `tokens.test.ts` |
| `features/decks/` | Has its own `CLAUDE.md` — the deck domain rules live there |
