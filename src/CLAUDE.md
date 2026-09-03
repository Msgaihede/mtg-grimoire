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
  **It also refuses to be dragged itself**, and that is the component's guarantee rather than a
  call site's: an `<img>` is draggable by default and the browser starts a drag from the
  *nearest* draggable ancestor, so a frame inside a draggable tile steals the gesture and the
  tile's own drag never begins. Two frames passed the prop by hand and two did not — the deck
  gallery's cover and the card pane's printing rows — so a deck tile dragged by its name and not
  by its picture, which is what a reader reports as "drag and drop is broken". It is written
  before the spread, so a frame that really is the drag source can still say so.
  **The same sentence has had a second, unrelated cause since the library changed, so check the
  other one before touching this attribute** (issue #331): dnd-kit's `Draggable` re-registers a
  per-source sensor **without its options**, and `PluginRegistry.register` reads that as an
  instruction to *clear* the shared instance's — so one source declaring `sensors` of its own
  erased `dndManager`'s app-wide `preventActivation`, every later source fell back to the
  library's, and that one refuses any press landing inside a button. A card's art **is** a button,
  so the symptom was identical and the attribute was innocent. `dndManager.ts` carries the fence
  and [frontend-design.md](../docs/reference/frontend-design.md) the whole reading.
  **It also asks again for a picture that never answers, and that is a third failure neither the
  hook nor any call site can see** (2026-09-01). `useImageRetry` heals a picture the protocol
  *refused* — a 502 or a 503 arrives as an `error` event and the frame comes back on a backoff.
  Nothing heals a request answered by **nothing at all**: no `load`, no `error`, no console line,
  and a frame that stays empty for the rest of the session, which is what a reader reports as
  "some cards never load until I move the mouse over them". It is reachable on Windows — every
  `mtgimg:` response is handed to the UI thread with `PostMessageW` (`wry`'s
  `webview2::dispatch_handler`), and a post that does not arrive leaves the request's deferral
  uncompleted forever. So a visible frame that has heard nothing for **5 s** asks again with a
  `?stall=N` mark, twice, and then dispatches `error` on the element so the hook's ordinary
  failure path takes it. **In `CardImage` rather than in `useImageRetry`, because two frames that
  draw a card use no hook at all** — `CardDetailPane`'s printing rows and `TheoryDiffDialog`'s —
  which is the `draggable` paragraph above happening a second time. **It is gated on the frame
  having a layout box**, which is both the right semantics (nothing to heal where nobody is
  looking) and what keeps it out of the suite's way: jsdom reports `width: 0` and
  `complete: false` for every image forever, so without the gate every mounted card in every test
  would arm a timer against a picture that can never arrive. Nothing in jsdom can go red for the
  behaviour itself; the deadline is sized from the shipped window and the figures are in
  [image-cache.md](../docs/reference/image-cache.md).
- **A card frame is `components/CardArt`** — the 5:7 box, `CardImage`, `useImageRetry`, the
  no-art fallback and the foil marking, in one place. **Every wall of card faces draws it**: the
  search's, the collection's, the deck editor's docked search column and — since 2026-08-16 —
  the deck's own Grid view, which had kept an inline copy and drifted from it in four ways at
  once (`rounded-md`, `aspect-[488/680]` rather than `CARD_ASPECT`, a smaller no-picture
  fallback, no hover lift), so the deck and the wall docked beside it drew one card two ways on
  one screen. A surface that draws its own frame instead says why at its own site, and each
  reason is that it is not a 5:7 box with an aspect-driven height — the stack's card (a computed
  pixel height its whole geometry rests on), the pane's main art (a flip fade, and since
  2026-08-22 a **turn**: a quarter-turned card is a landscape box, so that frame is the one
  `CARD_ASPECT` is not always true of), `PrintingPreview` (672×936), the two cover pickers
  (`ART_ASPECT`).
- **Four layouts are not printed the way up they are stored, and turning one to read it is not
  "distorting a card image"** — it is the card at its own proportions, which is what a reader
  does with the cardboard and what Scryfall's own card pages offer. `split` (347 live printings,
  96 of them Aftermath and turned the *other* way), `planar` (330), `flip` (45). The rule lives
  in `features/card/orientation.ts`; the control is the card detail pane's, and **only** that
  pane's — a wall of tiles is for finding a card, not reading one. What must not follow from
  this is a crop, a filter or a recolour, which the image policy still forbids outright. The
  directions were read off the printed images and the frame's geometry was measured in the
  shipped window — including the half-pixel a `translate(-50%, -50%)` centring put under **every**
  card in that frame: [frontend-design.md](../docs/reference/frontend-design.md).
- **One foil icon, everywhere, and the glyph is the _finish_** — `Sparkles` for foil, `Gem` for
  etched, `Aperture` only for a **nonfoil** copy that is unusual cardboard anyway (Serialized,
  Poster), which is the one case with no finish glyph to draw. A treatment renames the mark and
  must never redraw it: a Surge Foil is foil, so it is that same `Sparkles` with a longer word
  behind it. Anything that says "this copy is foil" takes its glyph from `FinishMark`'s table —
  a card face's chip, a table cell, a menu row, the card pane's foil toggle — because half of
  those surfaces never see a promo type, and a glyph that only some of them can draw is one fact
  in two pictures. That was issue #353; `docs/reference/frontend-design.md` has the record.
- **A card's marks share one chip in the art's top-right corner** — `FoilOverlay` draws the
  finish glyph and `GameChangerMark`'s gold crown side by side, because a card fact and a
  printing fact in two boxes start a row of stickers. The crown is `GameChangerBanner`'s glyph
  without its ribbon — one fact drawn three ways (the stack's banner, the deck's table and text
  views' `GC`, this), differing only in the room each has. One gold (`text-pie-gold`) everywhere,
  never the destructive colour, which belongs to a rule break. `FoilOverlay mark={false}` turns
  the whole chip off, crown included, for a frame that names these somewhere else.
  **Top-right is that chip's**, on every surface that draws a card as a face, and a surface's own
  marks go in the corners it leaves: top-left, bottom-left. The deck's Grid view put its copy count
  there too, in a full-width strip, and the two overlapped on any foil card in a deck — invisible
  to jsdom, invisible to a fixture set with no foil in it.
  **One mark shares that corner rather than avoiding it, and the exception is worth the rule it
  bends** (2026-08-20): `TheoryMatchMark`, the tick a deck card wears when the deck's *plan* also
  asks for it (`features/decks/theoryMatch.ts`). It has to be one corner across both card-face
  views, and on the stack that corner is free — `CardStack` draws `FoilOverlay mark={false}` and
  says the finish in its foot — so honouring the rule on the Grid tile would have put one fact in
  two different corners of one deck. The chip still wins the corner: on Grid the tick **stacks
  under it**, offset by the chip's own measured box (`1.5rem × --mark-scale`) on the cards that
  draw one. A *third* mark wanting this corner is a sign the corner is full, not a precedent.
  What moved to make room is the `RULE BREAK` mark, which held the stack's top-right until then
  and is now bottom-left on both views — a tick and a red box adjacent in one corner is exactly
  the confusion `CardMarks.tsx`'s four separations exist to prevent.
- **A bare number laid _on_ a card is `components/CountTag`, and it draws that number with no
  `×`** — filled and cut off at a slant, since a square chip on art reads as something to press;
  **grey unless something colours it**, so gold stays a thing a deck _tag_ means. It is
  `aria-hidden` for `FoilOverlay`'s reason, so its `title` is the whole of what a pointer gets and
  the words belong to whatever names the card. **A count laid _beside_ a card keeps its `×`** —
  `OwnedBadge` in a caption, the search table's `×132 printings` — where the sign is what tells a
  count from a set number.
- **A bare number is only honest where something beside it says what is being counted, and that
  is why the search wall stopped drawing one** (2026-08-15). `CountTag` had two callers for a
  day: the deck stack's copies in a pile, and the search wall's printings a collapsed tile stands
  for — one object, on the argument that a mark the eye finds before it reads the card has to be
  the same shape on both. The stack earns the bare number, because the tag it is printed on is
  what says which quantity. The wall did not: `132` on a search tile is a quantity of nothing in
  particular, and the only thing naming it was a tooltip and the surface you happened to be on.
  It says **`132 printings`** now, in the wall's own chip, so a tile has one corner that reads
  without a hover. Two consequences: **`CardGrid`'s `topLeft` carries the same `bg-bg/85` backing
  as `badge`** — the exception it was for a day is gone, and all three of a tile's corners are one
  box now — and **the mark is plain visible text rather than `aria-hidden` with an `sr-only`
  twin**, which is legitimate here only because the corner is a _sibling_ of the tile's button and
  not inside its accessible name.
- **`pointer-events` inherits, so a `title` or an SVG `<title>` inside anything
  `pointer-events-none` is a tooltip that can never be shown — and nothing goes red.** A hit
  target is invisible to the DOM, so no test sees it either. `FoilOverlay`'s chip is
  `pointer-events-auto` against its wrapper's `none` for exactly this reason; it is inside the
  enclosing button, so a click on it still opens the card.
- **A hint is `useTooltip()`'s spread, never a `title` attribute or an SVG `<title>`.** One
  `fixed` panel mounts at the app root (`LAYER.tooltip`) because a virtualised row is both
  `position: absolute` and transformed, which caps a nested `z-index` *and* makes the row the
  containing block for a `fixed` descendant — root-mounting is what escapes both at once. **The
  sweep is done**: every real tooltip in the app binds through `useTooltip()`. **Two native
  `title`s survive on purpose, and they are the same one drawn twice** — the drag-inert entry in
  `AppShell.tsx`'s rail and its twin in `BottomTabBar.tsx` (added 2026-08-29 with the phone's tab
  bar; the *row* is duplicated on purpose while the drop wiring is shared through
  `useSidebarDropTarget`) — because Chromium
  freezes `:hover` at a drag's origin for the whole drag, so the attribute's sentence is never
  seen mid-drag and is read instead through the accname spec's description fallback. Everything
  else `title=` still finds in the tree is a component **prop** — drawn as a heading
  (`DeckDialog`, `Notice`, `SettingsSection`) or turned into a `useTooltip()` binding internally
  by the component it names (`Figure`, `CountTag`, `ToggleChip`, `Marker`, `SortableHeader`) —
  never a native attribute a call site wrote itself. Grep `title=` to see the shape rather than
  trusting a count written here. Full rule, the three ways a site is classified, and the
  `pointer-events`/Escape/no-op-provider traps carried into the new API:
  [frontend-design.md](../docs/reference/frontend-design.md).
- **An `art` crop has no printed frame, so wherever one is shown the illustrator must be
  credited** (Scryfall's image policy). A `grid`/`thumb`/`display` image carries the printed
  credit itself and needs nothing. Never distort, blur, recolour or watermark a card image, and
  never crop off a printed credit.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts`** and nowhere else; `src/lib/layers.test.ts`
  sweeps `src/` to keep it that way. The ladder is
  `raised 10 < header 20 < popup 30 < dragTray 40 < overlay 45 < tooltip 46 < gate 50 <
  caption 60`. Equal z-indexes are resolved by document order, and a popup inside a virtualised
  row is capped by that row's layer whatever it asks for.
  **`caption` is the top rung and the only one that is not about the app** (2026-08-22): with
  `decorations: false` the title bar *is* the window frame, so a surface that covers it takes
  the window away rather than hiding a control. It shipped covered by both full-window surfaces
  — `SyncProgress`'s gate for the length of a first sync and `Dialog`'s scrim for every modal —
  because a `fixed inset-0` element paints over a flex item at `z-auto` whatever the numbers
  say, so the bar never entered the contest. **Bounding each overlay at the bar's height is the
  fix that does not scale**: it copies `BAR_H` into every such file and cannot be spelled as a
  Tailwind class built from a constant. A new full-window surface needs no thought about this;
  a new rung above `caption` needs a very good reason.
- **Escape closes one layer per press, and the protocol is a handshake, not a z-index.** An
  inner dismissible layer listens on `window` in the **capture** phase and calls
  `preventDefault()`; an outer one listens in the bubble phase and returns early on
  `e.defaultPrevented`. Capture is load-bearing — two `window` listeners for one event run in
  _registration_ order. Every new dismissible layer follows this or it will close something it
  did not open. A layer that Escape dismissed hands focus back to whatever opened it; an
  outside-click deliberately does not.
- **Two `"inner"` peers are ordered, by a stack — this is newer than most of the prose about it,
  and the old claim is still quoted in places.** `useDismissOnEscape` keeps a module-level stack:
  every capture-phase layer pushes a token on mount and pops it on cleanup, and **only the token
  on top acts**, so a context menu over a dialog over the card pane gives one press to each. A
  lone `"inner"` layer is a stack of one and behaves as it always did. What this replaced was
  **not** "both close on one press" — the capture rung checks `defaultPrevented` too, so the
  _first-registered_ peer took the press and the newer one, the thing on top, was **starved**
  (measured `{ first: 1, second: 0 }`, 2026-08-14). Two consequences worth carrying: `onDismiss`
  is **latched in a ref and is not a dependency**, because a re-registration used to move a layer
  to the top of the stack and close the wrong window — so an unstable callback is a re-render and
  no longer a bug; and **a design that keeps two layers exclusive needs a reason of its own now**
  (they overlap on screen, they are one piece of state, one would draw over the other), because
  "Escape cannot order them" has stopped being one.
- **The bottom rung is `"navigation"`, and it is the view itself rather than a layer over it.**
  Escape closes the open deck, or walks one folder up — in decks, the collection and the wishlist
  alike. It is bubble-phase like `"outer"` and **ranked below it**, which is the half worth
  remembering: a view is mounted long before the card pane that docks beside it, so in
  registration order the floor acted first and walked a reader out of a folder with their card
  still open. That is the capture stack's 2026-08-14 bug read backwards, and `bubbleStack` is the
  same cure on the other side of the event. A view with nowhere to go passes `enabled: false` and
  does not `preventDefault`, so a root folder never swallows a press it has no use for.
- **A filter box owns one Escape while it has text in it — and that is load-bearing, not a
  courtesy.** Every filter box in the app is an `<input type="search">`, and Chromium clears one
  on Escape by itself **without setting `defaultPrevented`**; the moment Escape also means "close
  the deck", one press in a box with text does both. `clearFieldOnEscape` is the fix, and the
  guard is `value !== ""` — an empty box has nothing to undo, so the press falls through to the
  view. It is `DeckNameField`'s rule (revert a draft, and only while there _is_ a draft) stated
  once for the boxes that share it. **jsdom does not implement the native clear**, so the suite
  can never see the half this exists to prevent; the shipped window is the only witness. Not for
  a field inside a dialog or a popup — an `"inner"` layer consumes the press in the capture phase
  before the field's own handler runs, so a call there is a line that cannot execute.
- **A surface opened from a view is a centred modal over a scrim, not a docked column — unless
  the reader works _out of_ it while editing beside it.** Width is the scarce thing in this app:
  the deck editor's desk row measures **602px** at the app's own 1280×800 with the card pane
  docked, so a 384px docked column leaves the deck **202px** — one stack column — and it is
  subtracted from the work whether or not it is being used. A surface that is _consulted_
  (history, categories, tags, deck settings) is therefore a
  **`src/components/Dialog.tsx`**: `LAYER.overlay`, a scrim, `aria-modal`, `trapTab`, and
  the `"inner"` Escape rung registered **on the open flag** rather than on the panel's mount,
  because the panel outlives the flag by the length of its fade. **A new modal in the deck
  surface is built _on_ that file rather than beside it, and since 2026-08-16 it is the only
  definition of one** — `ImportDialog`, `TheoryDiffDialog` and `CreateDeckDialog` were the
  last three carrying their own copy of that chrome and are on the shell now. A change to
  modality here — a focus restore, a different `trapTab`, a change to when the rung is enabled —
  is one edit to one file. **What the copies cost while they lasted is the argument for keeping
  it that way**: between them one editor drew two scrim darknesses, the ✕ at two geometries and
  two speeds, and the panel at three `max-h` values, none of which anybody had decided — a
  resemblance is N independent decisions that happen to agree today. Each of those is settled
  once in `Dialog.tsx` with the reason at its own site, and the shell's three optional
  header props (`title: ReactNode`, `ariaLabel`, `subtitle`) exist because folding the last
  three in needed exactly that much and no more. **Clamping the panel to the window takes two
  classes and they only work together** (2026-08-18): the panel's `max-h-full` is a percentage
  against its *grid area*, so the scrim needs `grid-rows-[minmax(0,1fr)]` to bound that area — an
  implicit grid row is `auto`, an `auto` row sizes to its own content, and the clamp was therefore
  circular and clamped **nothing**. Measured headless at a 708px viewport with a 140-line export,
  the panel drew **2963px**, every body's `overflow-y-auto` was inert because it had every pixel it
  asked for, and the dialog's buttons sat at y≈2930 — off the window, reachable by neither pointer
  nor wheel. `minmax(0,` is load-bearing: a bare `1fr` is `minmax(auto, 1fr)`, whose `auto` floor
  is the content again. **jsdom has no layout engine, so nothing in the suite can see any of it** —
  `Dialog.test.tsx` pins the two classes and the numbers come from a browser. `DeckEditor.test.tsx`'s Tab sweep is still
  driven per surface rather than pointed at the shell, and it is what would go red if a modality
  fix reached one dialog and stopped there. Only a
  surface that is _worked out of_ earns a place in the layout — the deck editor's card search
  column, whose tiles are drag sources into the deck's own category columns, and the card detail
  pane, which is how a reader flips through a card's printings — and both of those are
  collapsible or dismissible.
  **Both of those halves moved on 2026-08-22 (issue #183), in opposite directions, and they moved
  together.** The card pane stopped taking a place in the deck editor's layout at all: there it is
  an **overlay** over one of the desk's two columns — over the search column for a card opened
  from the deck, over the deck for a card opened from the search column, so that either way it
  covers what the reader was _not_ looking at — and `App` draws the docked one for every other
  view. With the 384px gone from the desk, the search column **opens by default** again and
  remembers which way the reader last left it (`app_meta.deck_search_open`). The rule above is
  unchanged and it is what decided both: a consulted surface is a modal, a worked-out-of surface
  earns its place — and a surface worked out of _beside_ another one may not take the other's
  width to do it.
- **A modal is clamped to the window and scrolls inside itself — its content never decides its
  height.** Every panel here has something in it that can grow without a ceiling: a decklist, a
  validation list, a category list, an error carrying a Scryfall message. Unclamped, the panel
  grows past the viewport and takes its footer buttons off the bottom of the window, where
  neither pointer nor wheel reaches them — which makes the dialog unusable rather than merely
  ugly, because the way out of a modal is a control it has just scrolled away. A body carries
  `min-h-0 flex-1 overflow-y-auto`, and **that is inert on its own**: it scrolls nothing until
  the panel above it is bounded, which takes the two classes and the reason given in the
  `Dialog` paragraph above. **jsdom has no layout engine, so nothing in the suite can go red
  for this** — build a modal on `Dialog` rather than beside it, and check a new one in the
  running window at a short viewport with more content than fits.
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
- **A row of fixed-width controls is sized by the _narrowest_ surface that draws it, which in
  this app is the docked search panel — never the filter bar it was designed in.** Give
  it `flex-wrap`. **That surface is a range now, not 384**: the panel is draggable from its left
  edge and its floor is `MIN_PANEL_WIDTH_PX`, **206**, so the narrowest content box a filter
  control has to survive is ~193 rather than ~371. Wrapping is what makes that free — a wrapped
  group's min-content is one chip — and it is why the drag needed no change to `FilterBar`. A flex item cannot shrink below its own min-content, so an unwrapped row just
  hangs out of the panel, and `DeckEditor`'s page section is `overflow-y-auto` — which computes
  `overflow-x` to **`auto`** — so the overhang becomes a horizontal scrollbar across the whole
  deck builder. (That section is the *only* scroller in the editor since 2026-08-14: the deck's
  three wall views were given a height of their own and now grow instead — see
  [`features/decks/CLAUDE.md`](features/decks/CLAUDE.md). Nothing here moves; the section itself
  is unchanged and an overhang still reaches it.)
  That is the one thing the 1024px floor forbids, and it arrives with **no test
  going red and nothing on screen naming the culprit**. It shipped: `ManaValueChips` was nine
  `size-9` chips at `9 × 36 + 8 × 4` = 356 and fitted, the **X chip** made it ten at 396 against
  a ~371 content box, and the editor overflowed by **25px at every window width** — 1042 vs 1017
  at 1280×800 and 2322 vs 2297 at 2560×1400 — because the panel's width does not move with the
  window. Only a live pass finds this one; the figures and the fix are in
  [frontend-design.md](../docs/reference/frontend-design.md).
- **`FilterBar` is the one filter row for every list of cards in this app**, and since 2026-08-26
  that is all five surfaces: the Search page, the Tags page, both tabs of the deck editor's docked
  panel, the Collection and the Wishlist. The last two had bespoke rows of their own until then
  and the argument for deleting them is the one `CollectionSearchTab` already made — they were the
  same arrangement of the same controls written a third and fourth time, and the four drifted the
  first time any one of them moved. Its prop is a **structural `FilterSurface`**, never one hook's
  `ReturnType`, which is what lets four different hooks over four different backends satisfy it.
  Three things a new surface has to get right:
  - **Everything below the line in `FilterSurface` is optional, and a control is drawn only where
    its own setter is wired.** A `tray` naming a cell the surface cannot answer draws *nothing*
    rather than a dead control. That is what lets the wishlist skip the price band — `WishlistQuery`
    carries no `priceMin`/`priceMax`, so the numbers would reach nothing.
  - **`anyCard` is a capability, not a state.** `Any card` is the row that puts back the printings
    *no* format allows, and it only means something where the corpus is narrowed to begin with —
    the card search pairs `playableOnly` with every other row of that picker. Drawn on a
    collection, it sets `format` to a sentinel the backend reads as a legalities key nothing
    matches, and the wall goes empty. Only `useCardSearch` sets it.
  - **`labels` keeps each surface's box its own name.** `Search cards` over the reader's own
    binder is the control lying about which list it narrows, and a `getByLabelText` cannot tell
    two boxes with one name apart. The `idStem` is what stops two mounted rows sharing an `id`.
- **It lays out by its own width, in four bands, through `@container/fb` — never a media query.**
  The same component is the search page's bar and the deck editor's docked
  panel, which is draggable from **206px**, so a viewport query answers about the wrong box. Four
  controls never fold away — the search box, the colours, the mana values and the sort — and
  everything else (set, format, owned, rarity, price, printings, finish, condition, fulfilled,
  needs review) is behind one `Filters`
  disclosure, with the filters that are **on** stated as 26px chips under a rule. Thresholds are
  640 / 900 / 1500 and each is where a *line's own contents* stop fitting, not a device.
  **The right-hand end of that row's first line belongs to the grid-or-table pair**, on every
  surface that has two layouts — which is where a reader now looks for it on all four card views,
  and why the collection's and the wishlist's Import/Export pair moved up into the figures band
  rather than staying beside the filters.
  **No folder control sits among the filters, and the fence is "not among the filters" rather
  than "not on the bar"** — a distinction the first draft of this rule collapsed. Where the reader
  is *standing* is navigation, so the breadcrumb and the drill-down stay off the row entirely:
  either one among the filters would be the one thing in it Reset all could not undo. The other two
  moved, and each moved to the place that already says what it is. **`+ New folder` is a tile of
  the folder wall** (`NewFolderCard`), shaped to a folder card's footprint and
  solid-bordered where the folders are dashed — the dash means *container, not a thing you own*,
  and a button wearing it would spend that vocabulary. It is drawn wherever the wall is, which is
  why the wall now renders at zero folders: gated on the folder count, a reader with an empty
  cabinet had no way to make their first one. **Pressed, it *becomes* the field — changed
  2026-09-03.** The tile used to raise a bordered strip under the breadcrumb (an input,
  `Create folder` and `Cancel` spelled out in words, and a line reading *in Collection* saying
  which level the strip was about), and every piece of that re-established a context the wall on
  screen already carried. The name is typed on the line the folder's name will occupy, at the same
  track and the same footprint, so nothing above the wall opens and nothing in the wall reflows;
  a folder card's `⋯ → Rename…` does the same on the card, keeping its figures line under the
  field so a reader can still see which drawer they are renaming. `components/FolderNameField.tsx`
  is both, and **the border is the whole of what tells them apart**, on the dashed rule above: the
  create tile stays **solid** because it is still a control, the renaming card stays **dashed**
  because it is already a container, and both go `border-accent` while open. The strip survives
  for `Move to folder…` and `Delete…` alone — neither is a name typed on a line, and neither has a
  tile of its own. **The caret's return is the part a new naming tile must not reinvent**: the
  page's `dismiss` focuses the element it remembered as the opener, and here that element is
  exactly what the field replaced, so by then it is a detached node whose `focus()` is a silent
  no-op. `useFolderFieldReturn(open)` is the fix — the host refs the control React renders in the
  field's place and restores the caret **only** when `document.activeElement` is null or
  `document.body`, which is the state Escape, the ✕ and a committed write all leave behind and
  which keeps the outside-click rule above intact. **The geometry is measured and the caret is
  not**: headless Edge over the built stylesheet, 2026-09-03, put all four states in one row and
  read 62px and one `top` for every tile, `y = 34` for the `⋯` and both ✓ / ✕ pairs, and 5px of
  clear air between a name and the tick on both shapes — but the app lock was held elsewhere all
  session, so nothing here has been driven in the shipped window, and where the caret lands after
  each of the four exits is still owed
  ([frontend-design.md](../docs/reference/frontend-design.md)). **The first tile is the way *out* wherever there is
  one** — `ParentFolderCard`, drawn only inside a folder, dashed like the drawers because it *is*
  one (the level above), naming that level and taking a card or a folder dropped on it. At the root
  it is absent and `New folder` is first again; the breadcrumb above is untouched. Issue #283, and
  [wishlist-folders.md](../docs/reference/wishlist-folders.md) carries the argument. **`Flatten` rides the bar past the hairline
  divider**, beside the grid-or-table pair. That end of the row is already the home for controls
  about how the list is *drawn* rather than which rows are in it, and it is already untouched by
  Reset all — so Flatten satisfies the fence on the far side of the rule rather than breaking it.
  Both card views with a cabinet pass it the same way, as one `flatten={{ pressed, onToggle }}`
  prop that cannot be handed over half.
  Two rules carry it and both have a measured failure behind them
  ([frontend-design.md](../docs/reference/frontend-design.md)): the arrangement is **`order` plus
  a `basis-full` break**, never one `<div>` per breakpoint with `hidden` on the rest — that build
  puts two mana groups and two sort pickers in the tree at once, which is two tab stops and one
  accessible name per filter; and a `flex-1` item that shares a line with something that cannot
  shrink is given *whatever is left*, which at a 369px container was 5px and spilled the 36px
  sort-direction button 53px out of the panel. **jsdom applies no container query and loads no
  stylesheet**, so every test sees the base arrangement and nothing here can go red in the suite.
- **A chord is written down in `src/lib/shortcuts.ts` and nowhere else** — the catalogue is both
  the keyboard map's content and what the handlers match against, so the panel cannot advertise a
  keyboard chord nothing binds. `matchesChord` is **exact in both directions** (a modifier the
  chord does not name must be absent), which is what lets `Ctrl+Z` and `Ctrl+Shift+Z` be two
  entries rather than one loose comparison — and it narrowed `Ctrl+Shift+Y` and `Shift+Delete`
  away, both of which only ever worked because the old guards never tested `shiftKey`. The
  `isTextField` yield stays at each **call site**: the deck editor's undo must yield to the
  browser's own and `Ctrl+1…6` must not. Four rows stand outside the fence and
  [keyboard-shortcuts.md](../docs/reference/keyboard-shortcuts.md) names each — `Escape` and
  `Shift+F10` are bound by `useDismissOnEscape` and `menu/useContextMenu`, which do not read the
  catalogue, and the two pointer rows can never be matched by construction.
- **Ctrl/⌘-click adds a card to a picked set and Shift-click takes a range, and the whole of what
  a modified click means is `src/lib/multiSelect.ts`** (issue #214). Four cases and no others —
  plain collapses to one and anchors there, Ctrl toggles, Shift replaces with the run from the
  anchor, Ctrl+Shift adds that run; **Shift outranks Ctrl**, which is Explorer's rule and the one
  a reader already has. It is pure over an ordered key list, so it is checkable as a truth table
  with no DOM, no store and no query behind it, and **no surface may branch on modifiers itself** —
  `useCardSelection`'s `pick` returns *whether the press was a selection*, and a view that gets
  `true` does nothing else.
  - **One selection app-wide, scoped by a string the surface owns** (`deck:12`, `search`,
    `collection`, `wishlist`, `tags`, `deck-panel`). A write naming a different scope replaces the
    whole thing, so leaving a surface discards the set **structurally** rather than by each
    component remembering to clear it — and that is also what makes clicking a tile in the deck
    editor's docked panel put the deck's own selection down. Two walls that can be on screen at
    once must therefore pass different scopes.
  - **A set outlives the list it was made in** — a refetch, a filter, a sibling surface's delete —
    so every consumer prunes against the order it is currently drawing. `pruneSelection` returns
    its argument unchanged when nothing went missing, so a wall with nothing picked pays nothing.
  - **One gold ring for the whole set, and the pane still shows the last card opened.** Gold
    already means *picked* on every wall here; a fifth kind of gold would be a vocabulary lesson
    in exchange for a distinction nobody asked for. `deckCardMarked` is the deck's spelling of it.
  - **A drag from a card *outside* the set carries that card alone and throws the set away.** Every
    file manager's rule, and the one thing about multi-drag a reader will get wrong if it is not
    true: a stray drag would otherwise rearrange cards they had forgotten were picked.
  - **`CardGrid` takes `selectionScope` opt-in, exactly as `arrowNav` is opt-in**, and
    `AllPrintingsDialog` passes none — a press there is a swap or a look, and a set of printings is
    not a thing anything downstream can act on.
  - **A `userEvent` test must hold the chord in one `setup()` session.** The direct
    `userEvent.click`/`userEvent.keyboard` helpers each open a session of their own, so a modifier
    held by one is released before the next runs and the press lands as a plain click — the test
    then passes while asserting about a gesture it never made. It did, for one run of this suite.
- **A surface that walks its selection with the arrow keys says so, or the card pane takes the
  caret on the first press.** `CardDetailPane` renders its body keyed on the open card and that
  body focuses the pane as it mounts — the right contract for a card a reader *pressed*, and the
  wrong one for one they arrowed onto, because the caret has to stay on the thing being walked for
  the second press to have anywhere to come from. `src/lib/caretWalk.ts` is the note that tells the
  two apart: `keepCaretForCard(id)` immediately **before** the store write, since the write is what
  re-keys the pane. Three surfaces call it — the search and collection walls, the deck's piles, the
  printings modal — and it shipped broken on all three at once, the modal's press putting the caret
  *outside an `aria-modal` dialog* where `trapTab` could not get it back.
  **The note goes where every selection the surface makes passes through it — a press as well as
  an arrow — and never on the arrow handler alone.** Written on the arrows only (2026-08-18) the
  walk worked and *a click did not*: a reader clicks a card to start, a click is a deliberate
  open, so the pane took the caret and their first arrow moved nothing. Every test and every live
  check had driven the walk from a **programmatically** focused card, which is the one caret a
  reader cannot produce — so nothing caught it and it was reported the next day. A third way to
  select a card must go through the same wrapper, because the failure is silent: the selection is
  right, the mark is right, and only the *next* keypress is wrong.
  **The note is idempotent and must stay idempotent**: `main.tsx` wraps the app in
  `React.StrictMode`, which runs a mount effect **twice** in development, so a note that cleared
  itself on read was consumed by the first invocation and the second took the caret anyway — a
  fix that looked like a fix, and one a **release build would have passed** while `tauri dev`
  failed. Every measurement:
  [frontend-design.md](../docs/reference/frontend-design.md).
- **`scrollIntoView({ block: "nearest" })` parks an element flush against the scrollport, and a
  scrollport is the padding box — so a scroller's own padding buys a focus ring nothing.** The
  ring `FOCUS` draws stands 4px proud of the border box and is clipped there, which is
  `DROP_MARK_ROOM`'s rule (`src/lib/dropMarks.ts`) reached from the other end: that constant is
  padding for a mark drawn *at rest*, and this is a **scroll margin** for the same mark at the
  moment something scrolls to it. `CardGrid`'s tile carries `scroll-m-1.5` — 6px, the same number,
  written once in each place so they cannot drift. Two more things the live pass settled: scroll
  **the tile**, not the button inside it that takes the caret, or the caption under the button
  hangs past the edge; and jsdom leaves `scrollIntoView` undefined, so none of this can go red in
  the suite.
- **`aria-disabled`, never the `disabled` attribute**, on anything that greys as the reader
  types — a `disabled` button leaves the tab order. The one exception is a native `<option>`.
- **`loading="lazy"` belongs on a plain scroller, not on a virtualised one** — the virtualiser
  has already made the request count small, so the browser's gate only delays the pictures about
  to be looked at.
- **Ctrl+wheel zooms the card sections and nothing else, and every section zooms on its own.**
  `useAppStore`'s `cardZoom` is a `Record<ZoomSection, number>` over the card sections named in
  `src/lib/cardZoom.ts` — `ZOOM_SECTIONS` is the census, and it has grown twice since this
  paragraph first said “four”. `deck` is one key for **both** deck views, because Stacks and Grid
  are two drawings of the same pile and switching view must not resize the cards. Each starts at
  `DEFAULT_ZOOM`, each is stepped along the same ladder, and each is handed back when the reader
  returns to that section.
  **This reverses the single shared `cardZoom` that was here until 2026-08-14**, whose argument was
  that zoom is a statement about how a reader reads cards rather than about one list: it holds
  across a navigation and breaks in the deck editor, where two card sections are on screen at once
  and zooming the docked search column also resized the deck laid out beside it — "how big are the
  cards I am browsing" and "how big is my deck laid out" answered together when only one was asked.
  **Each section's size now outlives the process** (issue #175, 2026-08-22), which reverses the
  “session-only, no persistence, no SQLite, no IPC” rule that stood here: one `app_meta` row of
  section → multiplier, read once at launch and written on a trailing timer after a gesture stops.
  `src/lib/useCardZoomPersistence.ts` is the whole mechanism and `AppShell` is its **only** mount;
  the store still reaches nothing itself. Two things carry it — the seed goes through
  `hydrateCardZoom`, which snaps to the ladder, drops a key this build does not draw and **does not
  pulse** (a restored size is not a gesture and must not raise the badge); and the writes hang off
  `zoomPulse`, not off `cardZoom`, so the seed is not written straight back and a reader holding the
  wheel at the ladder's end still gets one write when they stop.
  **The ladder is sixteen even stops, 50%–200% ten points apart** (2026-08-22). It replaced ten
  uneven ones shaped like a browser's zoom menu: a browser's is walked by *pressing a key*, this one
  by *rolling a wheel*, and above 1× the old ladder moved 10, 15, 25, 25, 25 points a notch — the
  same wrist movement moving the cards two and a half times as far at the top as at the bottom.
  `ZOOM_STEPS` is spelled out as literals rather than generated, for the reason `stepZoom` exists:
  0.1 added seven times is 0.7999999999999999.
  The gesture is attached through `useCardZoomGesture(ref, section)`
  on `CardGrid`'s scroller, `StackView`'s root and `GridView`'s root; `CardGrid`'s `zoomSection` prop
  is **required**, because a wall that has not thought about which section it is must not silently
  share another wall's number. The shell, the tables and the card pane never scale. Three rules
  carry it, each with a live failure behind it in
  [frontend-design.md](../docs/reference/frontend-design.md): the gesture needs a **native**
  `addEventListener` with `{ passive: false }` (React's `onWheel` is passive, so `preventDefault`
  does nothing and WebView2 zooms the whole window on top of you); the zoom rescales **geometry**
  and is never a `transform: scale()`; and **everything drawn _on_ a card scales with it, through
  two inherited custom properties** — `--mark-scale` and `--control-scale`, published by
  `cardScaleVars(zoom)` in `src/lib/cardZoom.ts` and set on exactly three elements (`CardGrid`'s
  tile, `GridView`'s tile, `CardStack`'s card). **A variable rather than a prop, because the marks
  are shared**: `RarityGem`, `OwnedBadge`, `FinishMark`, `TagDot`, `CountTag` and `QuantityStepper`
  are each drawn on a card face _and_ in one of the three tables or the card pane, so a prop would
  be threaded to every one and defaulted at the ones that must hold still — "does this scale?"
  answered fifteen times by whoever adds the newest call site. A mark reads `var(--mark-scale, 1)`
  and the fallback is what a table gets for knowing nothing. Controls take the second variable
  because they are drawn at `CONTROL_SHRINK` (85%) on a card and at full size in a row.
  **This retired the third rule that used to sit here** — "a scaled budget holding unscaled chrome
  floors rather than scales", `max(base, scaled(base, zoom))` — which is worth knowing because it
  was true and its premise is gone: `CardGrid`'s caption, `CardStack`'s `stackAdvance` and
  `stackDataHeight` and `GridView`'s foot each floored because the chrome inside them could not
  shrink, and a floored budget around chrome that now does is 28px of strip around 6px of type.
  `atLeast` survives for **`GridView`'s gutter alone**, which measures space *between* cards rather
  than anything drawn on one. Hairlines, the Tailwind corner radii and `STACK_DATA_RISE` still do
  not scale, each because the class it is derived from does not.
  **The badge is still one instance mounted at the app root** (`CardZoomIndicator`, a sibling of
  `AppShell`) — `LAYER.popup` only competes in the root stacking context, so mounting it inside a
  view would cap it at that view's — but it is now drawn at the **top-right of the section the
  gesture landed in**, anchored by measuring that section's box (`useCardZoomGesture` registers the
  element; `anchorFor` reads its rect). One badge because a reader makes one gesture at a time, not
  because there is one zoom: `zoomPulse` stays a single counter and `zoomSection` says which section
  the badge is about. All of that is driven in the shipped window (2026-08-14, debug build,
  1280×800) — the figures are in
  [frontend-design.md](../docs/reference/frontend-design.md) — with one carve-out that matters to
  the rules above and is stated there: the wheel was dispatched **synthetically**, so the
  `preventDefault`/WebView2 rule was exercised but **not** re-proved on that pass.
- **The zoom sizes the tile; the column count is what falls out of it, and the remainder is split
  either side** (changed 2026-08-14). `CardGrid` draws `scaled(baseTileWidth, cardZoom)` exactly,
  fits however many of those the wall holds, and centres the row with `sideGutterFor`. It used to
  scale a **floor** and stretch the tiles to fill the row, which kept the wall flush to both edges
  and made the drawn size a function of the *column count* — a step function of the zoom. On the
  deck panel's 330px wall the ladder of the day — ten uneven stops — collapsed to **three** distinct
  widths, so seven gestures in a row moved nothing on screen. `minTileWidth` is `baseTileWidth` now and
  `TILE_MIN_WIDTH` is `TILE_BASE_WIDTH`: it is a **width**, not a floor. Two things follow.
  **`tileWidthFor` caps at the wall** — `columnsFor` floors at one column whatever the arithmetic
  says, so without the cap a 300px tile in a 206px column is a horizontal scrollbar across the
  whole deck builder, which the 1024px floor forbids. And the **gutter is padding on every row**,
  never `justify-center`, or a part-full last row stops lining up with the full ones above it —
  and never on the box around the rows, which is what the `ResizeObserver` measures, so padding
  there feeds back into the width it is computed from. Driven in the shipped window; every figure
  is in [frontend-design.md](../docs/reference/frontend-design.md).
- **`@container` makes a box the containing block for every `fixed` descendant under it, so a
  modal may never be mounted inside one.** `container-type: inline-size` — which is what
  `@container/fb` and every other container in this app compiles to — applies **layout
  containment**, and a layout-contained box is the containing block for `position: fixed` just as
  a `transform` is. `Dialog`'s scrim is a bare `fixed inset-0` and corrects for nothing, so a
  dialog opened from inside a container box stretches to **that box** rather than to the window:
  the scrim covers the row it came out of and the panel is clamped to a filter bar. Found
  2026-08-29 building the phone's filter sheet, where `FilterBar`'s root became a **fragment** so
  the sheet is the container box's *sibling*. **jsdom applies no stylesheet and computes no
  containment**, so nothing in the suite can see the failure — pin the *structure* instead (the
  dialog is not a descendant of the container), which is what `FilterBar.test.tsx` does. The
  dropdowns escape this a different way and their own comment says so: `usePopupPlacement`
  measures a zero-size frame precisely to subtract whatever containing block it landed in.
  **Settings met the same rule from the inside on 2026-09-03, and the lesson is where a container
  may not go rather than where a dialog may not.** That page's panels mount their dialogs inline —
  grep `ConfirmDialog` under `src/features/settings/` for the census, since none of them writes
  the `fixed inset-0` itself and the class is `Dialog.tsx:333`'s — so the rail's container query
  had to go on the `<nav>` and never on the settings root, which would have reparented every one
  of those scrims. What made that possible is that the rail's own inline size answers the
  question being asked; the arithmetic is in
  [frontend-design.md](../docs/reference/frontend-design.md).
- **A scroll container is `relative`, because a scroll container has to be the containing block
  for its own absolutely positioned content.** `overflow` clips a descendant only when the
  scroller lies between it and that descendant's **containing block** — and Tailwind's `.sr-only`
  is `position: absolute`, so a screen-reader label with no positioned ancestor takes the
  *initial* containing block, is laid out at its static position inside the scrolled content, and
  is clipped by nothing. It then stretches the **document**. That shipped: the deck editor drew a
  window scrollbar beside its own, and the `h-screen` shell slid up off its own window when you
  used it — `documentElement.scrollHeight` **1704** against a `clientHeight` of 800 while
  `body.scrollHeight`, the shell root and every box in the tree read 800 and the shell's
  `overflow-hidden` said nothing was overflowing. **Nothing in the box tree names the culprit and
  jsdom cannot see any of it**, which is what makes this worth a rule rather than a bug report.
  The class goes on **whichever box carries the `overflow`** and one level up is not the same
  fix — `relative` on `main` instead moved the phantom scroll into `main` (`scrollHeight`
  742 → 1646) rather than removing it. Both figures, and the four-view scrollbar count after:
  [frontend-design.md](../docs/reference/frontend-design.md).
  **Since 2026-08-24 that box is `AppShell`'s `main`, and it is the only one.** `f02b284`
  ("fix scroll") took `overflow-y-auto` off the deck editor's `<section>`, which had made it a
  scroller nested inside `main` — so the example above is the history of the rule rather than
  where it currently applies. Nothing about the rule changed; what changed is that there is one
  scroller to apply it to. `AppShell.test.tsx` pins `relative` and `overflow-auto` **together** on
  `main` (either alone is a bug: `overflow` without `relative` is the phantom scroll, `relative`
  without `overflow` is inert), and `DeckEditor.test.tsx` asserts the editor does not re-add one.
- **A scroller has to leave room for the marks its own targets draw _outside_ their border box,
  because `overflow` clips at the scroller's padding box.** A ring is a box shadow and a focus
  outline is painted outside the border box, so neither is part of the box that laid the target
  out — a target flush against the scroller's content edge simply loses that side of its mark, and
  nothing in the box tree is wrong. It shipped in the deck builder: the three grow-views are
  `overflow-x-auto` with no padding, so the leftmost pile lost the left 2px of its `DROP_RING` for
  the whole length of a drag and the rail lost its right. `DROP_MARK_ROOM` in
  `src/lib/dropMarks.ts` is the padding, and it is **6px rather than 2** because the same boxes
  carry `FOCUS` — `outline-2 outline-offset-2`, 4px proud — and half a focus indicator is a WCAG
  2.4.7 failure. It goes on the box carrying the `overflow`; one level in is not the same fix,
  since the ring is then drawn outside _that_ child and lands back on the clip. The alternative is
  `ring-inset`, which is what `TableView` draws for rows absolutely positioned inside a
  virtualiser. **jsdom has no layout engine and therefore no clip**, so nothing here is visible to
  the suite — `views.test.tsx` sweeps the class instead.
  **Since 2026-09-03 that alternative is the default and this rule survives for `FOCUS` alone.**
  `DROP_RING` is `ring-1 ring-inset ring-accent/45`, so the drop ring is painted *within* the
  border box and can no longer be clipped by anything — the failure above is a history rather than
  a live hazard for that mark. `DROP_MARK_ROOM` does not change and must not: `FOCUS` still stands
  4px proud, and the 6px was always sized for it rather than for the ring. The same pass moved
  both drop marks onto **the element carrying the target's own edge** — a folder card's `<button>`,
  never the `<li>` around it — because a ring on a wrapper stood 2px outside a dashed border it was
  meant to agree with, which is what a reader reported as highlights that do not line up. A card
  that already has a border wears `DROP_EDGE` (its dash goes gold) instead of growing a second
  outline. `src/lib/dropMarks.ts` carries all of it.
- **Anything `fixed` positioned from a measured rect takes its viewport width from
  `document.documentElement.clientWidth`, never `window.innerWidth`.** `innerWidth` includes the
  classic vertical scrollbar; the initial containing block a `fixed` box is laid out against
  excludes it, so the two differ by the scrollbar on every surface that has one — **1280 against
  1265**, measured 2026-08-14, which is how the zoom badge came to sit 15px left of the corner it
  was anchored to. **Two things hide it, and the second does worse than hide it**: a surface with
  no page scrollbar reads correct at every size; and **jsdom has no layout engine, so
  `clientWidth` is a hard `0` on every element, the document element included** (probed in this
  repo: `innerWidth` **1024**, `documentElement.clientWidth` **0**). A jsdom test therefore has to
  **state a viewport width itself** — and the helper stated `window.innerWidth`, which is the
  buggy expression. The suite did not merely miss the defect, it **pinned the defect as the
  expected answer**: the assertion reads as a check on the anchor and checks nothing. Only a live
  pass finds this one.
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
  is not the bug when a picker reads wrong. Pinned rows (`Any card`, `Any format`, `Custom…`,
  `Auto (by what it does)`, `Top level`) stay outside the sort, and `CategoriesDialog`'s
  destructive answer — `go with it` since schema v25, because the `deck_cards` rows go but the
  copies the reader owns are filed into `Recently removed` rather than destroyed — stays pinned
  **last**, so the alphabet can never make it the row the select opens on. **The search's format
  select pins two of them, as
  a ladder rather than an alphabet** — `Any card`, `Any format`, then the formats — because
  `Any card` is what the `Unplayable` chip became on 2026-08-14: that chip and this select were
  moving one axis in opposite directions, and only the pair could reach "Modern **and** the art
  cards". `useCardSearch.ts`'s `formatParams` is the only place the row → (`format`,
  `playableOnly`) branch is written; the row is counted and cleared by Reset all, and deliberately
  not counted by `unfiltered`. See
  [frontend-design.md](../docs/reference/frontend-design.md). **The exemptions are a test, not a
  list — and the list is deliberately not written down here**, because it said "exactly two" for
  months and was wrong within a day of the context menus landing. A list is exempt when **its
  order _is_ the information** (a grade scale, Near Mint → Damaged; a printing's finishes, plain
  before the premium treatments; a two-row ladder like `Open on`'s Scryfall and the marketplace,
  where sorting would move the row a reader has learnt the position of whenever they changed
  marketplace) or when **the reader arranged it themselves** (deck categories, the folder tree).
  Everything else sorts. Every exemption carries a comment at its own site saying which of the two
  it is — that comment is the record, and grepping `sortOptions` is how you count them.
- **The card search box reads Scryfall's tagger syntax, and the parse is TypeScript's while the
  slug is Rust's.** `o:ramp`, `otag:"spot removal"`, `-a:dragon` — `features/search/tagQuery.ts`
  splits the box into tag terms and the free text left for FTS, `tag_resolve` turns each name into
  a canonical slug, and `useCardSearch` merges the result with whatever chips its caller passed.
  One wiring reaches both surfaces: the search page and the deck editor's docked panel are the
  same `FilterBar` over the same hook. Three rules that are not obvious, each with its failure
  written at its own site and all of it in
  [tag-search-syntax.md](../docs/reference/tag-search-syntax.md): **`a:` and `o:` mean the two
  taxonomies here and `artist:`/`oracle:` on Scryfall**, so those two keywords are spent and an
  artist filter cannot have them; **resolution is exact where the Tags page's type-ahead is a
  substring**, because a substring resolves one typed name to many tags that would have to be
  ORed while every tag filter in this app intersects; and **this is the one search in the app that
  fails closed** — an unresolved name empties the wall in the hook rather than at each call site,
  because `keepPreviousData` would otherwise leave the *previous* search's cards on screen under a
  query that asked something else.
- **Global actions (Refresh, sync status, settings) live in the top ribbon, not in views**, and a
  long job registers an `Activity` (`src/lib/activity.ts`) rather than wiring itself in.
  Registration is declarative: pass the job or `null` every render.
- **The chrome is set one step above the content, and the sidebar's width is not part of that
  step.** Ribbon 56px, nav entry 44px, view title and app mark 20px Cinzel, nav labels and both
  ribbon buttons 16px, status line 14px, chrome icons 20px. The **mana line stays 2px** (a
  signature that grows with its frame is a border) and the **sidebar stays `w-52`/208px** —
  `main` is what a wider column takes width from, and the docked search panel is what runs out of
  it — the panel is draggable now, so the headroom is no longer the 10px a fixed 384 left at the
  app's own 1280px window, but the rail still arrives at a desk of **414** (`DECK_FLOOR` plus
  `MIN_PANEL_WIDTH_PX` plus the gap) and every pixel the sidebar takes is a pixel off that.
  Widening the sidebar is a change to `DECK_FLOOR`'s arithmetic first. Both, with every figure:
  [frontend-design.md](../docs/reference/frontend-design.md).
- **The app's own mark is `components/GrimoireMark`, never a bare `<img>` and never a re-pasted
  SVG.** It takes a pixel `size` and picks its own variant at the **24px** detail floor: the
  master is drawn on a 64-unit grid, so below that its hairlines land under a third of a pixel and
  a caption drawn from the full artwork is a smudge of gold rather than a book. Strokes are
  `currentColor` and fills are `var(--color-surface)`, so the caller sets the colour and the
  tokens stay in charge; `logos/` is the artwork's source of truth. It is `aria-hidden` unless
  given a `label` — the inverse of `GameChangerMark`'s "the mark names itself", because this mark
  is always a duplicate of a name already set in type beside it.
- **An icon lucide does not draw is copied into `components/icons.ts`, never installed.**
  `createLucideIcon(name, nodes)` returns exactly the `LucideIcon` that `import { Heart }` does,
  so a call site keeps its type and `className="size-5"`, `aria-hidden` and an inherited
  `strokeWidth` all still land where they land on the rest. One glyph does not justify a whole
  icon set or a second icon runtime as a dependency. **Copy the licence notice with the paths** —
  the two there today are Tabler (MIT) and Lucide Lab (ISC), and both permit the copy on exactly
  that condition. This is not the place for artwork that _is_ this app: `GrimoireMark`,
  `FinishMark` and `GameChangerMark` take a size and pick a variant rather than being one glyph
  at any size.
- **The window's caption is the app's, not Windows'** — `tauri.conf.json` sets
  `decorations: false` and `components/TitleBar.tsx` draws a 34px row above the sidebar and the
  ribbon (2026-08-20). Four rules it does not share with the rest of the chrome, each because the
  window's edge is not the page's: **the caption buttons are square and flush** (a radius or a
  margin puts window between the button and the corner, and a corner button's whole value is that
  a throw of the mouse cannot overshoot it), **they do not take `PRESS`** (a target that shrinks
  away at the moment of the press reads as a misclick, and at the screen's edge there is nowhere
  to correct to), their focus ring is **`ring-inset`** (an outset ring on a flush element is drawn
  outside the window), and the wordmark is the one **Cinzel below 18px** in the app — 13px with
  `tracking-[0.2em]`, which the display face's own floor forbids and a 34px row cannot honour. It
  is paid for by being a *wordmark* rather than interface text. **`Ribbon` gave up its `MTG` mark
  to it**: that mark's comment justified the abbreviation on the grounds that "the window title
  bar already says that in full", so the two would have been the name twice.
- **`data-tauri-drag-region` does not inherit, so every element that should move the window
  carries its own** — Tauri reads the attribute off the element under the pointer and nothing
  else. A child without it is a hole in the grab area; an element *with* it that also handles a
  click is a button that drags the window instead of pressing. The row, the lockup wrapper and
  the wordmark have it; the three buttons deliberately do not. **The mark inside the lockup is
  the fourth case and takes neither answer**: an `<svg>` cannot usefully carry the attribute, so
  it is `pointer-events-none` and the pointer resolves to the wrapper above it — which is free
  only because the mark binds no tooltip, `pointer-events` being inherited.
- **The maximize button's hover is state, never `:hover`, and the reason is native.**
  `tauri-plugin-snap-layout` parks a transparent Win32 child window over that button's rectangle
  so Windows 11 can answer `HTMAXBUTTON` to its own `WM_NCHITTEST` and raise the Snap Layouts
  flyout — which means the pointer is over a native child and never over the webview. Its CSS
  `:hover` cannot fire, and its `onClick` never runs either (the overlay sends `SC_MAXIMIZE`
  itself). The plugin emits `tauri-snap://snap/mouseenter`/`mouseleave` instead, and
  `src/lib/window.ts`'s `onSnapHover` subscribes to both as one thing — a caller that took only
  `enter` would leave the button lit for the rest of the session. **The button's `id` is the whole
  contract with Rust and fails silently at both ends**: a typo creates no overlay, raises no
  error and logs nothing, so `SNAP_BUTTON_ID` is shared and `TitleBar.test.tsx` pins it. The
  `onClick` still stands, because everywhere but Windows 11 the plugin is a documented no-op.
- **Every window verb goes through `src/lib/window.ts`, for `lib/ipc.ts`'s reason.** One module
  names them, so a story and a test have one thing to fake — and its four exports match the four
  `core:window:allow-*` permissions in `capabilities/desktop.json` exactly, in both directions: a
  fifth verb needs its permission, and a granted permission nothing here calls is a widening
  nobody asked for. `TitleBar` importing `@tauri-apps/api/event` directly is what made every
  existing `AppShell` and `App` test reach the real module and print **336** unhandled rejections
  while still passing green, which is the shape of a mock boundary in the wrong place.
- **The ribbon's status line is one permanently mounted `role="status"`** — a live region that
  first appears with its sentence already inside announces nothing — and the number inside it is
  `aria-hidden`.
- Mana/set symbols come from the bundled `mana-font`/`keyrune` npm packages, **never a CDN**.
- shadcn components: always `npx shadcn@latest add <x>` with Radix base (components.json). The
  app palette maps `accent` to a **text** colour (gold), so rewrite a vendored component's
  `bg-accent` surfaces to `bg-surface`. `bg-muted` needs no rewrite.
- Card images arrive over `mtgimg://`; `mtgimg:` is an `img-src` and nothing else — **read images
  with `<img>`, never with `fetch`** (a `fetch()` at it fails CORS by design).
- **`src/lib/platform.ts` is the only place the page asks what platform it is on**, and it asks
  the **user agent** — `src/lib/images.ts`'s `imageOrigin()` is the shipped precedent, and both
  readers need the answer synchronously during their first render. It answers `false` for
  anything it does not recognise, which is what keeps jsdom and Storybook on the desktop shape
  without either of them having to say so; the token is `Android` and not `Linux` or `Mobile`,
  because an Android agent is a Linux one with one extra word. Two readers: `AppShell` (no
  caption — three of `TitleBar`'s four verbs are `#[cfg(desktop)]` in tauri and
  `capabilities/mobile.json` grants none of them) and `SettingsPage` (no Backup panel — the
  mirror is desktop-only by decision). **A third reader is a reason to re-open whether this
  belongs behind the core boundary instead**, where `ipc.ts` already knows which core it is
  talking to. `UpdatePanel` is deliberately *not* one: it branches on the backend's own
  `installKind`, because two independent answers to one question are free to disagree. See
  [android-target.md](../docs/reference/android-target.md).

## The context menu

A right-click anywhere in the app is one component's problem. `src/components/menu/` owns the
primitive; a surface builds a `MenuItem[]` and hands it over through `useContextMenu`, and owns no
markup of its own. Every rule below has a failure behind it that shipped or nearly did.

- **One menu, mounted at the app root.** `ContextMenuProvider` wraps the app in `App.tsx` and
  renders the panel as a **sibling of `AppShell`** — the position `CardZoomIndicator` already
  holds, for the same reason. A menu takes `LAYER.popup`, a z-index competes only inside its own
  stacking context, and every card surface here draws rows that are positioned or transformed — so
  a menu mounted where it was opened is capped at that row's `LAYER.raised` and paints under the
  table header above it. Three properties come free from there being exactly one: one menu at a
  time, a second right-click **replaces** rather than stacks, and nothing clips it.
- **Anything a menu's _rows_ need is provided above `ContextMenuProvider`, never inside
  `AppShell`.** The provider draws its panel as a sibling of `children`, so "inside the shell" and
  "inside the menu" are two different places. `CardToDeckProvider` shipped inside the shell for one
  commit, and every deck add made from a menu threw — on every card surface at once — because
  the picker that consumes it is drawn in the panel and not in a view.
- **A menu opened from inside a `LAYER.overlay` dialog paints behind that dialog's scrim.** `popup`
  is `z-30` and `overlay` is `z-45`: the panel is invisible and unreachable, and **nothing goes
  red**, because jsdom has no opinion about a z-index. That is why the deck editor's category menu
  is wired onto **the view's own group element and never onto `GroupHeader`** — `CategoriesDialog`
  draws that same header inside a `Dialog`. `layers.ts` names this overlap as the one that must
  not exist; keeping it non-existent is a placement decision at each call site, not something the
  primitive can enforce. Do not tidy a menu handler onto a shared row component.
- **A menu opener has to be able to take focus, and `focus()` on a node with no `tabIndex` is a
  no-op.** `menu()`/`menuKey()` hand the panel the element their handler is attached to, and the
  panel focuses it back when Escape closes and before every row it runs — so a bare `<li>` opener
  leaves the caret on the panel, drops it on `<body>` when the panel unmounts, and the next Tab
  restarts from the top of the app. It bit the branch that introduced menus more than once — the
  deck card views and the card pane's printings rows each shipped with it, and the deck tile and
  the folder row escaped it only because their handlers sit on a `<button>`. Two fixes and both
  are right: put the handlers on the `<button>` the row already has, or give the row
  `tabIndex={-1}` — never `0`, which would add a tab stop per card.
- **The native menu survives in text fields and nowhere else.** One document-level `contextmenu`
  listener in the provider calls `preventDefault()` unless the target is inside a field: cut, copy,
  paste, undo and spellcheck are things we cannot rebuild, and a WebView2 menu offering "Reload"
  and "View source" does not belong in a shipped desktop window. **The carve-out has two ends and
  needs both** — a surface's own handler stops the event before the document listener ever sees it,
  so `useContextMenu`'s `menu()` applies the same test at its end. Rows contain fields —
  `QuantityStepper` sits inside table rows and deck cards, `FolderTree` puts one inside a node —
  and either end alone loses them the browser's menu.
- **`isTextField` and `isTextEntry` are two predicates and must stay two.** `isTextField`
  (`useContextMenu.ts`) governs the carve-out above and matches **every** `<input>`, checkboxes
  and radios included — whether a right-click on a checkbox gets the browser's menu is its
  question. `isTextEntry` (`menu/panel.ts`) governs which keys an **open panel** yields to a caret,
  and is a deny-list of the input types whose value is not typed text, because a checkbox that took
  the arrow keys would strand the caret on a control they do nothing to. Widening one to serve both
  decides the other question by accident.
- **Escape means "back"; Tab means "forward".** Escape closes one level and hands the caret to the
  opener — one press per rung, through `useDismissOnEscape`'s two stacks, and **the last rung is
  the view**: with nothing left to dismiss, Escape closes the open deck or climbs one folder.
  "Back" is therefore the whole way back, not as far as the last popup. Tab focuses the
  opener, closes the menu and **lets the press through**, so the browser carries on from the opener
  to whatever follows it. The menu is deliberately **not** a focus trap: rows are `tabIndex={-1}`,
  so a panel's only tab stop is a field a lazy body drew, and a trap with one stop cycles it to
  itself and reads as a stuck key. Left alone Tab was a bug in its own right — focus went to the
  page behind while the panel stayed up.
- **`lazy` is a promise about _mounting_, not about _rendering_.** A `lazy` row's `Content` mounts
  when the row is expanded, so its queries fire once and a menu with six of them reaches the
  backend **zero** times on open — that is the entire reason the kind exists, and it is the general
  form of "no work happens before the reader asks for it". But the component re-renders freely for
  as long as the menu is up (any re-render of the menu reaches it; nothing between is memoised), so
  a body's work belongs in its **hooks** and never in its body.
- **Positioning is hand-rolled, and that is the CSP's doing.** No portal and no popper library: the
  shipped CSP is `style-src 'self'` and every overlay primitive in reach injects a runtime
  `<style>` that fails **silently**. The panel is `fixed`, at the pointer, flipped against
  `document.documentElement.clientWidth`/`clientHeight` — the `innerWidth` rule above, which this
  is the second instance of. A keyboard open (Shift+F10, the `ContextMenu` key) anchors at the
  opener's **bottom-left**, because a keypress has no coordinates and `0, 0` would put every one of
  these in the top-left corner of the window.

## Motion (`motion@13.1.0`)

Full detail and every measurement: [docs/reference/motion.md](../docs/reference/motion.md).

- **Timings live in `src/lib/motion.ts` and nowhere else.** Import a **preset** (`scrim`,
  `dialog`, `popup`, `statusLine`, `press`, `stackCard`) rather than a number. There is no drawer
  preset: `drawerRight` was deleted on 2026-08-14 when the deck editor's two right-hand drawers
  became centred modals and it lost its last consumer.
  `src/index.css` carries the same scale so CSS-only sites agree. There is no `duration-base`
  utility — `--duration-*` is not a Tailwind v4 namespace, so it is read as
  `duration-[var(--duration-fast)]`; `--ease-*` **is** one, so `ease-standard` is real.
  **A fourth tier, `instant` (50ms), was added on 2026-08-22** for content appearing where the
  reader is already looking — the sidebar's labels, which fade in only once the rail has finished
  widening for them. It is deliberately below the glitch floor `fast` names, because it is not a
  transition anybody watches, and it is not a licence to write short numbers: a surface that
  *travels* belongs on one of the three above.
- **Two public APIs are forbidden: `AnimatePresence mode="popLayout"` and `animateView()`.**
  Both append a `<style>` element to `document.head`, which `style-src 'self'` blocks — and
  **the failure is silent**: `style.sheet` comes back null, popLayout simply does nothing and
  siblings jump. `MotionConfig nonce` is not an escape. `mode="sync"` and `"wait"` are fine.
  **There is no CSP in `tauri dev` at all — `devCsp` is not what makes dev permissive.**
  Measured 2026-08-28: Vite's dev server sends no `Content-Security-Policy` header and the
  HTML carries no CSP `meta`, because with a `devUrl` the webview loads straight from Vite
  and Tauri is never in the response path. Setting `devCsp` to the shipped `style-src 'self'`
  and rebuilding changes nothing: a runtime `<style>` still resolves with a live `sheet`.
  **So editing `devCsp` is not a way to test the shipped policy** — only `tauri build` is; a
  `--debug --no-bundle` binary serves from `tauri.localhost` and does enforce it. The
  practical conclusion is the one this file already drew, and only the mechanism differs: dev,
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
  names `scale` explicitly; verify it in the built CSS, not in source. **That recipe is `PRESS`
  in `src/lib/motion.ts`** (and `PRESS_SOFT`, the settings rows' 0.99), where it joined the
  timings on 2026-08-16 — until then it was hand-copied onto every pressable control in the
  app, with the paragraph explaining why pasted beside almost all of them (`b0a49aa`). Both are
  built from one `PRESS_STILL`, because they differ by a single utility and the property
  list must be written once. **Both are template literals now, which is a second reason the
  check belongs in `dist/`**: a join that breaks a class name in half emits no rule at all and
  source still reads correctly. **What a control does when it is out of reach is not in the
  recipe** — some sites add `disabled:active:scale-100`, some the `aria-disabled:` spelling, and
  the rest never grey; that is three facts about three kinds of control rather than drift, and
  `grep active:scale-100` is the census. The settings panels' button box is
  `src/features/settings/controls.ts`.
- **Nothing that a reader types into takes the dip** — `PRESS_STILL` is the recipe without it,
  and `FilterChips`' `FILTER_FIELD` is `FILTER_CONTROL` built on it. On an
  `<input type="search">` this is not cosmetic: Chromium draws the ✕ inside the field's own
  shadow tree, a `scale` pivots on the field's centre, and `click` goes to the common ancestor
  of the press and the release — so the button slides out from under the pointer and the box
  dips **without clearing** (issue #179). It is a width bug, which is why it read as one box
  working: swept a pixel at a time against a 10px button, a 176px field still cleared over 8 of
  them, a 256px field over 7, a 700px field over none, and the filter row's boxes are `flex-1`.
  **jsdom has no layout engine and no user-agent shadow tree, so nothing can go red for the
  behaviour** — `motion.test.ts` sweeps `src/` for the class instead, and the numbers come from
  a browser.
- **Under jsdom the animations are real and timing-dependent**, which is why
  `MotionGlobalConfig.skipAnimations = true` is set in `src/test-setup.ts`. **The flag alone was
  not enough and the gap it left was a CI flake** (fixed 2026-08-20): `skipAnimations` applies
  the final keyframe inside `frame.update(...)`, which is scheduled on `requestAnimationFrame`,
  so a `motion` element's first painted frame carried its `initial` — `opacity: 0` for every
  preset here — and `toBeVisible` was false for everything inside an animated surface until the
  next frame. `findBy*` resolves on the render *before* that frame, so
  `expect(await findBy…).toBeVisible()` was a race it lost on a loaded runner. The setup file now
  runs motion's non-`keepAlive` batch inline, and `motion.test.ts` asserts the *behaviour* — a
  `dialog` preset at `opacity: 1` on its first render — rather than that the patch is installed,
  so a `motion` upgrade that reschedules the keyframe fails there rather than on CI.
  **Two things made it unreadable and both are worth keeping**: `byRole` and `toBeVisible`
  disagree about **opacity and nothing else** (the accessibility tree tests `hidden`,
  `aria-hidden` and `display: none`), so the query finds an element the assertion then refuses;
  and jest-dom prints `element.cloneNode(false)`, a **shallow** clone, so the failure shows an
  empty `<button />` and reads exactly like content that never arrived. An empty element in a
  `toBeVisible` message is the printer, never evidence about the content.
- **The old `\btransition-(?!none)` sweep is blind to JS motion** — a file animated entirely
  through `motion` matches nothing and passes trivially.

## Layout

| Path | What lives there |
| --- | --- |
| `components/` | Shared UI — `CardImage`, `CardArt`, `table/VirtualTable`, `menu/` (the one context menu) |
| `features/` | One directory per surface — **`ls src/features` is the census.** This row named six while the tree held eight; a prose-only edit routes to neither CI job |
| `lib/` | `ipc.ts` (the Rust mirror), `layers.ts`, `activity.ts`, `sort.ts`, `tokens.test.ts` |
| `features/decks/` | Has its own `CLAUDE.md` — the deck domain rules live there |
| `features/tags/` | Browse by what a card **is of**. Storied under `Tags/*`; the wall is `features/search`'s, reused with collapse off |
