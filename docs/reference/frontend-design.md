# Frontend design

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- When working on UI components, always use the `mtg-grimoire-sb-mcp` MCP tools to access Storybook's component and documentation knowledge before answering or taking any action.
- **CRITICAL: Never hallucinate component properties!** Before using ANY property on a component from a design system (including common-sounding ones like `shadow`, etc.), you MUST use the MCP tools to check if the property is actually documented for that component.
- Query `list-all-documentation` to get a list of all components
- Query `get-documentation` for that component to see all available properties and examples
- Only use properties that are explicitly documented or shown in example stories
- If a property isn't documented, do not assume properties based on naming conventions or common patterns from other libraries. Check back with the user in these cases.
- Use the `get-storybook-story-instructions` tool to fetch the latest instructions for creating or updating stories. This will ensure you follow current conventions and recommendations.
- Check your work by running `run-story-tests`.
  Remember: A story name might not reflect the property name correctly, so always verify properties through documentation or example stories before using them.

- **All frontend work follows the `frontend-design` skill** (invoke it before UI tasks) and the
  visual direction doc: `docs/superpowers/specs/2026-08-04-visual-design-direction.md`.
  Implementers execute that direction (palette, type, mana line, filter chips) — they do not
  invent their own. Mana/set symbols come from the bundled `mana-font`/`keyrune` npm packages,
  never a CDN.
- Global actions (Refresh, sync status, future settings) live in the top ribbon, not in views.
- **The ribbon says what the app is doing, and it is a registry rather than a sync.** A long
  job registers an `Activity` (`src/lib/activity.ts`) — key, rank, label, `detail`, value —
  through `useRegisterActivity`, and the lowest rank wins the row (`RANK.sync` 0 beats
  `RANK.update` 10; ties break by insertion order, because two hooks' effects run in an order
  nobody chose). The store is created per `ActivityProvider`, at the top of `AppShell` and
  above `children`, so a job started inside a view needs no wiring — and so it never becomes a
  second `useAppStore`, the one global Storybook cannot make per-story. Registration is
  **declarative**: pass the job or `null` every render, and a job cannot outlive the component
  describing it. `put` is identity-in-identity-out when nothing moved, which is what lets the
  register-every-render form cost nothing.
- **The mana line reacts instantly and the sentence waits `ACTIVITY_DELAY_MS` (400 ms).**
  Measured in the shipped window 2026-08-11, sampling the row every 40 ms across a forced
  Refresh: **bar at 121 ms, sentence at 523 ms** — the gate, to 2 ms. The gate is on the
  _slot_, not the job, so a sync handing over to an update download swaps the sentence
  without the row blinking. `useDelayedFlag` turns **off** by adjusting state during render
  rather than in an effect: an effect would clear it one commit late, and
  `react-hooks/set-state-in-effect` rejects the synchronous call outright — the lint rule and
  the correct behaviour agree here.
  **It does not suppress a no-op Refresh, and the design note claiming it would was wrong.**
  That whole run measured **1.4 s**, so "Checking for card data updates" was up for ~1.0 s
  before "Already up to date" replaced it. 400 ms filters a _flash_, not a short run — and a
  second of the app naming what it is checking is the good case, not the one to design out.
- **The live phase sequence, measured 2026-08-11 over a real ingest** (116,695 cards, bulk
  file of 2026-08-10): `Importing cards · 94,000 cards` → `Reclaiming disk space · 66%` (the
  one true percentage, climbing) → `Updating set list` → **`Syncing card data`** →
  `116,695 cards · data from 2026-08-10`. That fourth step is the generic fallback and is
  correct rather than a bug: `done` is a terminal phase, and `busy` stays true until the
  status poll catches up, so for up to a second the row honestly says a sync is still
  finishing. The mana line has always done exactly this; nobody had seen it in words before.
  At 1024 px, with the longest realistic sentence
  (`Downloading update 0.3.0 · 12 / 40 MB`), the ribbon row measures 816 px and the body does
  not scroll sideways.
- **The status line is one permanently mounted `role="status"`, and the number inside it is
  `aria-hidden`.** Mounted because a live region that first appears with its sentence already
  inside announces nothing (the sidebar drop report's lesson). The number is hidden because a
  live region announces its accessible text and skips `aria-hidden` subtrees: the label
  changes ~4 times a sync, the ingest's count ~58 times, and the mana line's `aria-valuenow`
  is where a fraction belongs. **`getByText` matches an element's own text nodes**, so a test
  asserting the whole sentence reads `toHaveTextContent` off the line, never a combined
  string matcher.
- **Card art is drawn with `components/CardImage`, never a bare `<img>`.** It keys the image
  on its own URL, and that key is the whole component. A browser keeps painting an `<img>`'s
  last decoded frame until the new `src` decodes, and every card frame here belongs to a
  _slot_ rather than to a card — grid tiles are keyed by position on purpose, a deck cover is
  handed a new id, the pane reuses its art across a flip — so React hands one element a
  different card and the picture lags the caption by the length of the fetch. Measured over
  CDP on the commit before: a search change kept **all 20** tile elements, captions reading
  "Black Lotus" over Shivan Dragon art for ~2.4 s. After: **0** kept.
  **This is invisible to the DOM and therefore to the test suite in the obvious place** —
  setting `src` resets `complete` and `naturalWidth` while the old frame stays painted, so
  `naturalWidth === 0` is true in both the healthy and the broken case. What a test can see
  is _element identity_, which is what `CardImage.test.tsx` and the two integration tests
  assert; what a person can see is a screenshot. `PrintingPreview` reached the same answer
  independently by keying its whole `Preview` on the printing.
- **An `art` crop has no printed frame, so wherever one is shown the illustrator must be
  credited.** Scryfall's image policy, quoted in full at
  `docs/superpowers/plans/2026-08-04-02-images-card-browsing.md:55`: use the art crop and the
  artist's name must appear elsewhere in the same interface. A `grid`/`thumb`/`display` image
  carries the printed credit itself and needs nothing; the 626×457 `art` variant does not.
  This has been ruled on twice and is written here because four surfaces cite it as living
  here. Two consequences hold everywhere a **cover** is drawn — the gallery's deck tiles, its
  folder strips and `DeckSettingsDialog`'s `CoverPreview`, all three of which print the
  artist: **a card cover whose artist is unknown is not drawn at all** (`DeckRow.coverArtist`
  is `null` when `cards` has no row for that printing; the orphan heals on the next sync rather
  than being shown uncredited), and **a custom cover carries no artist and needs none**,
  because the rule is Scryfall's and a user's own file is not Scryfall's — which is also why a
  folder strip drops custom covers rather than crediting some of its tiles and not others.
  **The standing gap is down to two, and it closed by accident rather than by a credit line**
  (`DeckSettingsDialog.tsx`'s `ChoiceTile` doc): it was four — the deck's stack rows
  (`CardStack`), its grid tiles (`views/GridView`), the theory diff's rows and the cover picker's
  own tiles — and the first two now draw the **whole card**, which carries its printed credit. So
  the remaining two are the theory diff and the picker, both still uncredited because
  `DeckCardRow` carries no per-row `artist`, and both sitting inside a control that names the
  card while the pane credits the illustrator ("Illustrated by …"). **The picker being stricter
  than the views it picks from is a real inconsistency now that those views are compliant** —
  which is an argument for the one column on `DeckCardRow`, not against it. Never distort, blur,
  recolour or watermark a card image, and never crop off a printed credit.
- **A quantity is `−` button, free-typed field, `+` button — and the field's own native spin
  buttons are suppressed.** `type="number"` is kept for the numeric keyboard and the `min`/`max`
  it reports to assistive tech, and WebView2 charges for that by drawing ▲▼ _inside_ the box: at
  the deck's `xs` size the field is 32×20px, so two native steps crowd the digits out of a box
  that has to hold "10" — three pixels from two controls that already do the job.
  `appearance: none` is **not enough on Chromium**; the spinner is a pseudo-element and needs
  `::-webkit-inner-spin-button`/`::-webkit-outer-spin-button` addressed as one. It lives on
  `QuantityStepper` so it lands on every surface that draws one. The field stays free-typed
  because typing `12` is one action and pressing `+` eleven times is eleven.
- **A card frame is `components/CardArt`** — the 5:7 box, `CardImage`, `useImageRetry`, the
  no-art fallback and the foil marking, in one place. Five surfaces draw a card and each had
  rebuilt part of it. The card pane's main art is the deliberate exception: it keeps a flip
  fade, a bespoke "no image yet" panel and no retry hook, so it borrows only `FoilOverlay`.
- **The foil marking states what the object _is_, never what it could have been.**
  `soleFinish` marks a printing that leaves no choice — 12 366 foil-only and 892 etched-only
  paper printings — and never the 53 224 that merely _have_ a foil version, which would put a
  sheen on 61 % of every wall. A collection row passes its entry's own stored finish instead;
  a deck row gets the glyph rather than the sheen, because its picture is a 48×36 art crop
  where a gradient is a smudge.
- **`mix-blend-mode: overlay` is invisible over card art, and only a screenshot says so.**
  The first foil sheen was a rainbow gradient at 12 % in `overlay`; magnifying one foil tile
  over CDP and shooting it with the sheen shown and hidden produced **indistinguishable
  images** — `overlay` preserves luminance and only nudges hue, which on saturated art is no
  signal at all. 30 % changed nothing worth seeing and `color-dodge` blew the highlights out.
  What works is **`screen` with a specular band**: low-alpha rainbow stops (0.10–0.13) either
  side of one white stop at 0.34, 41 % along a 115° sweep — the streak is what the eye reads
  as "shiny", and being narrow it obscures almost nothing.
- **A mark drawn _inside_ the tile's button joins that button's accessible name.** The foil
  chip did, and a wall of foils became buttons called "Consecrated Sphinx Foil" — measured in
  the shipped window, where a tile button's name came back as bare "Foil". The whole
  `FoilOverlay` is `aria-hidden` now and the finish is stated in text where each surface has
  room (the wall's caption `sr-only`, the search table's Name cell, the pane's per-finish
  prices, and — since 2026-08-13 — the deck stack's data line, which sits _outside_ the card's
  button and so is genuinely announced). This is the same rule the owned badge follows by being
  a _sibling_ of the button.
- **`FoilOverlay mark={false}` draws the sheen without the chip**, for a frame that names the
  finish somewhere else. The stack is its one caller: a `FinishMark` on the data line beside the
  price says the word better than a fourth badge in a corner the rule break and the quantity tag
  are already competing for. What must never happen is _neither_ — a sheen with nothing naming
  it is decoration, which is the whole of why the chip existed. **It governs the crown too**,
  since the chip is the only thing a crown can be drawn as and the stack has its banner instead.
- **One game changer, three drawings, and the difference is room rather than meaning.** The deck
  stack stamps `GameChangerBanner` — a gold seal, a 9px crown, `Game Changer` in Cinzel — where a
  card is 295px tall; the other three deck views abbreviate to `GameChangerBadge`'s gold `GC`
  where a cell has a column; and a search card gets `components/GameChangerMark`, **the banner's
  crown and nothing else**, because a 170px tile is somebody else's artwork and a ribbon across it
  is a sticker over the picture the reader came to look at. `text-pie-gold` in all three: the spec
  is explicit that a game changer (a fact about a powerful card) and a rule break (a problem)
  must never be confusable, and the destructive colour belongs to the second. It shares the finish
  chip rather than taking a corner of its own — **a card fact and a printing fact in one box**,
  since a card can be either, both or neither. Nothing derives it: the backend flattens
  `cards.game_changer`'s NULL into `false` (the column is nullable; only `card_row.rs`'s parser
  struct is a `bool`).
- **`pointer-events` inherits, so a `<title>` inside anything `pointer-events-none` is a
  tooltip nobody can ever see — and it fails silently.** `FoilOverlay`'s chip sat under the
  overlay's `none` from the day it was written, so `FinishMark`'s `<title>` had never once
  been shown over card art: a tooltip is drawn by the element the pointer _hits_, and nothing
  in that subtree was hittable. The chip now takes `pointer-events-auto` on its own while the
  full-bleed sheen keeps `none`; it sits _inside_ the enclosing button on all three surfaces
  that have one, so a click on it bubbles and opens the card exactly as a click on the art
  does. `data-card-marks` is the handle a test finds it by — a hit target is otherwise
  invisible to the DOM, which is why this went unnoticed through a green suite.
- **`CardGrid`'s two corner marks take their own clicks now, and that is the price of their
  tooltips.** The owned badge (bottom-left) and the printing count (top-left) are _siblings_
  of the tile's button, so `pointer-events-none` was what let a press fall through to the art
  and kept the tile one click target. But they are abbreviations — `×3`, a filled heart —
  whose plain-words tooltip is the whole point of hovering them, so each takes its own events
  and calls `onSelect` itself: same behaviour, now hoverable. The drag is unaffected,
  `cardDraggable` being registered on the tile's outer wrapper. No keyboard handler is owed —
  a corner duplicates what the caption already states and opens what the button opens, and a
  second tab stop per tile would be forty extra presses across a wall to reach nothing new.
- **`loading="lazy"` belongs on a plain scroller, not on a virtualised one.** `CardGrid` had
  it against "117 k results is 117 k requests", which the virtualiser had already made false
  — the wall mounts the rows on screen plus two, about two dozen images — so the browser's
  gate only delayed the pictures about to be looked at. **The deck feature's plain scrollers
  keep it**: the stack and grid views (`CardStack.tsx`, `views/GridView.tsx`), the gallery's
  deck tiles and folder strips (`DecksPage.tsx`), the theory diff (`TheoryDiffDialog.tsx`) and
  the cover art picker (`DeckSettingsDialog.tsx`) — where a 100-card list really is 100 mounted
  rows. (It used to say "the deck zone columns", a component the rebuild deleted.)
- **Ctrl+wheel resizes the cards and nothing else.** The gesture is attached per _card section_ —
  `CardGrid`'s scroller (which is the search wall, the collection wall and the deck editor's docked
  search panel at once) and the deck editor's own `StackView` and `GridView` roots — so the sidebar,
  the ribbon, the tables and the card pane never move. There is one `cardZoom` behind all of them
  (`useAppStore`), because it is a statement about how the reader is reading cards rather than about
  how one list is configured: zoom the search wall, switch to Decks, and the cards there are already
  the size that was asked for. **The wishlist has no zoom because it has no card section** — it is
  `VirtualTable` only.
- **The zoom rescales tile _geometry_; it is never a `transform: scale()`.** A transform was the
  obvious cheap answer and is wrong three times over: it resamples art that is already a downscale
  of a 488px `grid` image, it leaves the virtualiser measuring pre-transform boxes so the scrollbar
  stops matching the content, and it desynchronises the deck editor's drag-and-drop hit testing from
  what is painted. Rescaling the numbers keeps text crisp, lets the wall reflow to a new column
  count, and keeps `CardGrid`'s existing `virtualizer.measure()` effect — already keyed on
  `tileHeight` — correct for free.
- **A ladder of ten stops (0.5×–2×), not a multiplier** — `src/lib/cardZoom.ts`. A wheel `deltaY` is
  not a magnitude worth trusting: a mouse notch arrives as 100 through Chromium's line mode and 120
  from a driver reporting raw ticks, while a precision trackpad's pinch reaches the page as a stream
  of ctrl-flagged wheel events in the single digits, dozens a second. The ladder makes the unit the
  **gesture**. It also keeps the value exact — `zoom * 1.1` applied and undone eight times is
  0.9999999999999998, which formats as "100%" while sizing every tile a hair off.
- **Anywhere a scaled budget contains unscaled chrome, the budget floors rather than scales:**
  `max(base, scaled(base, zoom))`. Three surfaces landed on this independently. `CardGrid`'s 28px
  caption is set by the 24px quick-add button inside it, so a plain 0.5× gives a 14px strip under a
  28px caption and the virtualised rows overlap by the difference. `CardStack`'s 34px reveal is a
  legibility floor for the chip laid over it, not a fraction of the card. `GridView`'s caption and
  gutter are the same case (4.5px type at half size; tiles touching into one sheet of card backs).
  The stack's padding and border are the mirror rule — **added, never multiplied**, since chrome is
  not part of a card, and `stackColumnWidth` derives the column _from_ the card for that reason.
- **The zoom badge is driven by a pulse counter, not by the zoom value** (`CardZoomIndicator`,
  `zoomPulse`). At either end of the ladder a gesture changes no number, and that is exactly when a
  reader needs an answer — they are still rolling the wheel and nothing is happening. Keyed off the
  value, the badge would fade out under their hand at the one moment it is load-bearing. It is
  `aria-hidden` on purpose: a live region here would announce a percentage per wheel notch.
- **The wheel listener is a native `addEventListener` with `{ passive: false }`, never React's
  `onWheel`.** React registers `wheel` as passive on the root container, and a passive listener's
  `preventDefault()` is defined to do nothing — so the zoom would step *and* WebView2 would apply
  its own ctrl+wheel page zoom on top, scaling the whole window out from under a reader who asked
  one grid of cards to get bigger. The same `preventDefault` is what suppresses trackpad pinch,
  which arrives with `ctrlKey` set and nobody touching a key.
- **Escape closes one layer per press, and the protocol is a handshake, not a z-index.** An
  inner dismissible layer (popup, listbox, menu) listens on `window` in the **capture**
  phase and calls `preventDefault()`; an outer one (the card detail pane) listens in the
  bubble phase and returns early on `e.defaultPrevented`. Capture is load-bearing: two
  `window` listeners for one event run in _registration_ order, and the outer layer was
  mounted first, so in the bubble phase it would act before the popup and read
  `defaultPrevented` as false. Every new dismissible layer follows this or it will close
  something it did not open. Pinned by `App.test.tsx`'s Escape-stack test.
- A layer that Escape dismissed hands focus back to whatever opened it, _before_ React
  flushes the close (the element is still mounted). An outside-click deliberately does not
  — the reader is already somewhere else.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts`, and `src/lib/layers.test.ts` sweeps
  `src/` to keep it the only place they are written.** The bug it closed is worth the
  paragraph: the search view's set picker (`absolute z-20`) was painted over by the results
  table's sticky header (`sticky top-0 z-20`), because nothing between them creates a
  stacking context and **equal z-indexes are resolved by document order** — where every
  table header comes after the filter bar. Measured over CDP 2026-08-09 on the shipped
  window: the popup and the header overlap by exactly 36px, and forcing the popup back to
  the header's layer moves what `elementFromPoint` finds there from `listbox` to `row`.
  The part a number cannot fix: a popup inside a virtualised row is capped by that row's
  layer whatever it asks for, because the row is `absolute` _and_ `transform`ed and is
  therefore its own stacking context. That is why the row lift exists and why it sits
  _below_ the header — a row has to scroll under one. Variant spellings
  (`has-[[aria-expanded=true]]:z-10`) are their own entries, written out: Tailwind scans
  source text for whole class names, so a class built by interpolation emits no rule at all.
- **The ladder is `raised 10 < header 20 < popup 30 < dragTray 40 < overlay 45 < gate 50`**, and
  `layers.test.ts` asserts every link of it. **`overlay` is one rung for a drawer _and_ a modal,
  deliberately, where two looks more careful**: the deck editor's five full-window surfaces —
  Import, Categories & tags, History, Theory diff, Deck settings — are held in **one** piece of
  state (`DeckEditor`'s `Layer` union) because `useDismissOnEscape` orders exactly two rungs, and
  two `"inner"` peers open at once are not ordered at all. At most one of the five is ever
  mounted,
  so there is no pair for a second number to order and inventing one would be a claim about a
  stack that cannot occur. They used to borrow `gate` and `dragTray` two apiece — each right in
  effect and wrong in name. Measured 2026-08-11 in the shipped window: the scrim computes to
  `z-45`, one Escape closes the overlay and leaves the card pane open, a second closes the pane,
  and each hands focus back to the control that opened it.
- **A popup is pinned to, and grows from, the corner nearest its trigger's own edge.**
  Nothing clips these popups — that is the point of not portalling them — so one that
  overflows the window scrolls the whole app sideways instead of being cut off. The set
  picker did: 288px of listbox opening from a trigger at the end of the filter row put it
  **174px past a 1280px window** (measured), and the page slid left, sidebar and all, the
  moment its own `scrollIntoView` ran. So `SetCombobox` is `right-0` with
  `origin-top-right`, the same decision as `AddToCollection`'s `align="end"` — and **the
  mirror of it is equally wrong**. The deck editor's quick add sits at the _left_ end of its
  toolbar row, where that pair would hang a panel wider than the field out to the left of
  the field that produced it, away from the edge it has room at; it takes `left-0` with
  `origin-top-left`. The origin follows the pin, which is the one thing `lib/motion.ts`'s
  `popup` leaves to whoever anchors it: a listbox that grows from a corner it is not
  attached to reads as unrelated to the control that opened it. Both spellings are written
  out whole, for the scanner reason above.
- **Two comboboxes here are hand-rolled, and the CSP is the reason.** The set filter
  (`features/search/SetCombobox.tsx`) and the deck editor's quick add
  (`features/decks/QuickAdd.tsx`) are plain absolutely-positioned listboxes in the same
  stacking context as their trigger, never portalled popovers: the shipped `csp` is
  `style-src 'self'`, and every portalled overlay primitive injects a runtime `<style>` the
  moment it opens — Radix's pull in `react-remove-scroll`. **`devCsp` carries
  `'unsafe-inline'` and the shipped `csp` does not**, so the failure passes `tauri dev`,
  Storybook and jsdom and breaks only in a packaged build, exactly like
  `AnimatePresence mode="popLayout"`. The ARIA wiring is the whole of what the dependency
  would have supplied: `role="combobox"` on the _field_, `aria-expanded` and
  `aria-controls`, and `aria-activedescendant` moving the highlight while the caret stays
  put — which is what lets a reader take a row without Tabbing into the list. Both files
  build option ids from a module-scope `optionId(id, i)`, so the id an option carries and
  the id `aria-activedescendant` points at are one spelling rather than two that happen to
  agree; a mismatch is invisible to the eye and total to a screen reader, which simply
  announces nothing.
- **Both draw their panel in `components/PopupListbox`'s `PopupPanel`, and what is shared is
  an inert guard.** `AnimatePresence` keeps the element it was last handed while that
  element leaves, so an exiting panel goes on rendering the props of the render in which it
  was still open — including its `className` — and a flag read upstairs can therefore never
  reach it. `PopupPanel` reads `useIsPresent` _inside_ the presence, which is the only place
  the answer changes, and turns the leaving panel `aria-hidden` and `pointer-events-none`.
  Without it every dismissal a popup has — Escape, the outside-mousedown listener, `onBlur`
  — comes down with the open flag while the panel is still painted and hit-testable for the
  length of the fade: a press landing on a listbox that can no longer close itself, and a
  second, stale copy of its list in the accessibility tree. One component rather than two
  inline `motion.div`s, so the guard cannot drift between them.
- **What the two do not share is deliberate.** `SetCombobox` opens from a disclosure button,
  focuses a search field of its own and hands the caret back on Escape; the quick add _is_
  the field, so its Escape closes the list and moves nothing. `SetCombobox` scrolls the
  active option into view because it renders up to 50 rows; the quick add caps at five,
  which are all visible at once, so it has no such effect and needs none. And the quick add
  registers its `"inner"` Escape rung on _the list being up_ rather than on its own open
  flag, because a toolbar field with no list under it owes the press to the card detail
  pane, which listens on `window` in the bubble phase. Its deck-side rules — the three
  routes to one write, the freshness guard, the missing `marketplace` — are in
  `src/features/decks/CLAUDE.md`. **Driven in the shipped window 2026-08-14** (`tauri dev`,
  debug, 1280×800): the panel computes `z-index: 30` and `transform-origin: 0px 0px`, its
  left edge sits on the field's to the pixel (285/285), nothing overflowed right and
  `scrollLeft` stayed 0 — and Escape closed the list while leaving the card pane open, then
  closed the pane on the second press. Every figure is in
  `src/features/decks/CLAUDE.md`.
- **The three tables are one component**, `src/components/table/VirtualTable.tsx`: columns
  are data, and the two things that genuinely differ stay callbacks — `renderRow` (the
  collection and wishlist wrap a row in a drag source; the wishlist also decides per row
  whether it opens a card at all, because an any-printing wish has none) and `extraHeight`
  (the reconciler's flagged band). Its column template is an **inline style**, not a
  Tailwind arbitrary value, for the scanner reason above.
- **Table headers sort, and Shift builds a multi-key sort.** A press cycles one column
  `firstDir → the opposite → gone`; the modifier decides only what happens to the _other_
  columns, so every single-column order is reachable without ever holding Shift. `firstDir`
  is descending on money and count columns. The whole interaction is one pure reducer,
  `applySort` in `src/lib/sort.ts`. `aria-sort` goes on **every** sorted column — the
  alternative is telling assistive tech that a two-key sort has one key — and the rank rides
  in the button's accessible name (`"Price, sort priority 2"`). **Name-from-content does not
  reach into a descendant's `aria-label`**, so a column's own description belongs on the
  `columnheader`, not on the button inside it: on the button the Price column read back as
  bare "Price", losing the sentence spec §5 says a price may never be shown without.
- **A header sorts by what its column shows**, which is why the collection's Value column
  orders by unit × copies and the wishlist's Cost by unit × copies _still missing_ — not by
  the unit price. The orders with no column to press ("Recently added", and the unit price
  itself) stay on the filter bar's select, which drives the **same** state: picking there
  replaces the sort with that one term, and the control reads `Custom…` once the sort starts
  somewhere it has no option for. The wishlist's Printing column is deliberately not
  sortable at all — an any-printing wish names no set.
- **Every option list is drawn through `sortOptions` in `src/lib/options.ts`: alphabetical by
  the display label, with a faceted control's greyed rows sunk below its pickable ones.** The
  label is the words on screen, never the key — `standard` and `Standard Brawl` sort by what
  the reader reads. One `Intl.Collator` pinned to `"en"`, `sensitivity: "base"` and
  `numeric: true`: case is not a sort key ("The List" used to land above "the list" under a
  bare `localeCompare`), an accent is a spelling, and "Arena League 1999" belongs above "Arena
  League 2001" rather than wherever a code-unit read of `1` against `2` puts it. It **copies**
  before sorting, because the arrays reaching it are React Query's session-cached
  `list_sets()` and `formatSpecs()` and every other reader of that key shares them.
  - **Ordering is a display decision and therefore lives in TS.** Rust answers in whatever
    order the query produced — `list_sets` newest-first, `format_specs_list` by a seeded
    `sort_order`, deck categories by the reader's own drag — and each of those is still the
    right thing for the backend to say. Do not fix a picker by changing an `ORDER BY`.
  - **A pinned row stays pinned, outside the sort**: `Any format`, `Any set`, the disabled
    `Custom…` a table-header sort leaves behind, `Auto (by card type)`, the permanent `Move…`
    verb, `Top level`. `CategoriesPanel`'s `are deleted with it` is pinned **last** — the
    destructive answer is not allowed to become the default by alphabet.
  - **Two exemptions, and they are the whole list.** A **grade scale** — card condition runs
    Near Mint → Damaged, and alphabetised it would open on "Damaged". And an order **the
    reader arranged themselves** — a deck's categories are drag-sorted in `CategoriesPanel`
    and rendered in that order by all four deck views, so an alphabetical dropdown would
    disagree with the panel beside it. Both carry a comment at the site saying so, because
    the next sweep for unsorted selects will otherwise "fix" them.

## Vendored components and tokens

- shadcn components: always `npx shadcn@latest add <x>` with Radix base (components.json).
  The app palette maps `accent` to a **text** colour (gold), so rewrite a vendored
  component's `bg-accent` surfaces to `bg-surface`. `bg-muted` needs no rewrite any more:
  the app's dim text is `--color-dim` and `--color-muted` is the surface shadcn means by it
  (it used to be the dim text, which gave a stock `TabsList` invisible labels).
  `text-muted-foreground` and `text-accent-foreground` already resolve correctly.
- **Dim text is `text-dim`, never `text-muted`** — the latter still compiles and now paints
  text in the surface colour, i.e. very nearly invisible. `src/lib/tokens.test.ts` guards it.
