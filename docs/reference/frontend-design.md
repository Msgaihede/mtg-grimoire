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
- **The shell's scale is one step above the content's, and the sidebar's _width_ is not part of
  it** (2026-08-14). The ribbon is **56px** (was 48), a nav entry **44px** (was 36), the view
  title and app mark **20px** Cinzel (was 18), nav labels and both ribbon buttons **16px** (was
  14), the status line **14px** (was 12), and every icon in the chrome **20px** (was 16). Two
  things deliberately did not move. **The mana line stays 2px** — it is the signature, and a
  signature that grows with its frame is a border. **The sidebar stays `w-52` (208px)**, because
  `main` is what a wider column takes the width out of and `DeckEditor` is measured against
  `main` to the pixel: at 1280×800 with a card pane docked the desk row is 602px, the docked
  search panel plus its `gap-4` want 400, and `DECK_FLOOR` (192) leaves **10px** of headroom —
  so anything past 208 rails that panel at the app's own default window, the exact failure
  `DECK_FLOOR`'s 224 → 208 → 192 drops exist to prevent. Widening the sidebar is a change to the
  deck editor's arithmetic first. The 8px the ribbon gained comes off the editor's height
  instead, which only costs it 8px more of a scroll it already had.
  **Driven in the shipped window 2026-08-14** (`npm run tauri dev`, a **debug** build, against
  the real 116,703-card corpus). At 1280×800: nav **208×800**, an entry **183×44** at 16px with
  a 20×20 icon, the ribbon row **1072×56** at `top: 0`, the title and mark **20px** Cinzel, the
  status line **14px** reading `116,703 cards · data from 2026-08-13`, Refresh **151×42** with a
  20×20 icon, the mana line **1072×2**, and `main` **1072×742** at `top: 58` — so the editor
  column is **702px**, which is the 710 figure less the ribbon's 8. `documentElement.scrollWidth`
  **1280**: nothing scrolls sideways.
  **The 1024px floor holds with everything on the row at once.** At 1024×768 the row is
  **816×56** — the same 816 as before, because the sidebar did not move — and probing the worst
  case by cloning a real button into it (an `Update to 0.3.0` at **171px**) beside the longest
  sentence (`Downloading update 0.3.0 · 12 / 40 MB`, **248px**) left `row.scrollWidth` at 816,
  `body.scrollWidth` at 1024, and **neither the title nor the status line clipped**. Refresh's
  right edge is 1004, which is the row's own 20px padding.
  **The deck editor's docked panel survives, which was the thing to check.** At 1280×800 with a
  card pane docked (384px) the search panel stayed **`aria-expanded=true` and not disabled**, and
  `body.scrollWidth` was **1265** — the same figure the 2026-08-13 pass recorded. At 1024 with the
  pane open it rails, which is what `DECK_FLOOR`'s table has always said it does.
  **A trap this pass walked into**: `setDeviceMetricsOverride` survives the socket that set it,
  so a `size 1024 768` earlier in the run had the *next* check reading a railed panel at what
  looked like 1280 — a regression that was not one. Read `innerWidth` in the same expression as
  anything width-dependent; the harness contract says to end a run with an explicit `size 1280 800`
  and this is the failure that rule is about.
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
- **Ctrl+wheel resizes the cards and nothing else, and since 2026-08-14 each card section holds its
  own zoom.** The gesture was already attached per _card section_ — `CardGrid`'s scroller and the
  deck editor's own `StackView` and `GridView` roots — so the sidebar, the ribbon, the tables and
  the card pane never move. What changed is what those listeners write. `useAppStore`'s `cardZoom`
  is a `Record<ZoomSection, number>` over **four** sections (`ZOOM_SECTIONS`, `src/lib/cardZoom.ts`):
  `search` and `collection`, the two walls; `deckSearch`, the deck editor's docked search column,
  which is a third `CardGrid`; and `deck`, the editor's desk — **one key for both deck views**,
  because Stacks and Grid are two drawings of the same pile and switching between them must not
  resize the cards the reader just settled on. `useCardZoomGesture(ref, section)` names the section
  it is stepping. **The wishlist has no zoom because it has no card section** — it is `VirtualTable`
  only.
- **The rule this reversed, and why it was wrong.** It read: there is one `cardZoom` behind all of
  them, "because it is a statement about how the reader is reading cards rather than about how one
  list is configured: zoom the search wall, switch to Decks, and the cards there are already the
  size that was asked for." That argument is about a **navigation** — one section leaving the screen
  as another arrives — and it never covered the case the deck editor creates, where two card
  sections are on screen **at the same time**. A reader zooming the docked search column was
  resizing the deck laid out beside it, and those are two different questions asked in the same
  second: *how big are the cards I am browsing* against *how big is my deck laid out*. The
  cross-surface convenience is what the split costs, and it is the smaller loss — a reader who zooms
  the search wall and then opens a deck now finds the deck at whatever they last left it at, which
  is the same promise ("the size I asked for") read per section instead of per app. Each section
  starts at `DEFAULT_ZOOM` and every one is still **session-only**: no persistence, no SQLite, no
  IPC, for the reason that has not changed — zoom is a posture a reader takes for a minute of
  comparing art, and restoring 200% tiles on launch explains itself to nobody. Two guards keep a
  fifth section from arriving silently: `DEFAULT_SECTION_ZOOMS` is spelled out as a literal rather
  than reduced over `ZOOM_SECTIONS`, so `Record<ZoomSection, number>` makes a new section a compile
  error until somebody has said what it starts at; and `CardGrid`'s `zoomSection` prop is
  **required**, so a new wall cannot default into sharing another wall's number.
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
  not part of a card, and `stackColumnWidth` derives the column _from_ the card for that reason
  (210 + 12 + 2 = 224 at 1×, which is the `14rem` it replaced, exactly). **That border term is the
  group `<section>`'s own hairline and it has been `border-transparent` since 2026-08-14**: a
  border box that paints nothing still occupies its 1px either side, so the sum did not move when
  the outline went. The term now names a length nobody can see, which is worth stating plainly —
  it is a _box_ rather than a decoration, clearing the colour is free, and deleting the class would
  paint every card 2px wider than `stackCardWidth()` says it is. The card's **own** hairline is a
  different edge and still paints; `STACK_CARD_BORDER` is one length with two owners.
- **The deck's piles are drawn with no edge at all, and the switched-off one says so three ways
  instead** (changed 2026-08-14). `StackGroup`'s `<section>` was `border-border` while the pile was
  active and `border-dashed border-border bg-surface/40` while it was not; it is
  `border border-transparent` in both states now, with the inactive wash deepened to
  `bg-surface/60`. A stack of card faces is already a rectangle with a hard edge, so an outline
  around it framed a frame — and this is a desk of nothing but card faces, which is where the
  direction's rule about chrome never being the loudest thing on the screen bites hardest. What
  the line was actually carrying was the active/inactive distinction, so that
  moves onto three signals that were mostly there already: the wash, `GroupHeader`'s dimmed name
  beside its `INACTIVE` marker, and the pile's own `CardStack` at `opacity-60`. An active pile is
  drawn with no chrome whatever. Two things did **not** have to change and each is a rule worth
  keeping: `DROP_RING`/`DROP_OVER` are `ring-2 ring-accent` and `bg-accent/10`, and a ring is a box
  shadow **outside** the border box, so the drag highlight never read the border it appears to sit
  on; and the border is transparent rather than absent, for the arithmetic above. `opacity-60` also
  makes that `<ul>` a stacking context, and the `<ul>` is what takes `LAYER.raised` when a card
  opens — the first thing to check if the lift ever regresses in inactive piles alone.
  **All of it is now measured in the shipped window — 2026-08-14, `npm run tauri dev`, a debug
  build at 1280×800**, driven over `scripts/cdp.mjs` against the deck "test (copy)" (Commander, 11
  cards, 9 categories, 6 stack columns). **That column count is the fixture as it stood on the day
  and is no longer what this deck draws**: its empty Companion is not drawn at all now and its
  Maybeboard rides the rail rather than the pack, while its empty `Enchantment` pile has started
  drawing — see `grouping.ts`'s `drawsWhenEmpty` and `columns.ts`'s `splitRail`. Nothing measured
  below depends on it; every reading here is per-`<section>` and holds wherever the section is
  drawn. Every `StackGroup` `<section>` computed
  `border-width: 1px` with `border-color: rgba(0, 0, 0, 0)`: the box survives and the line does
  not, so `border-transparent` is measured rather than argued, and the 2px `stackColumnWidth`
  spends on it is still being spent. The inactive Maybeboard computed
  `background-color: oklab(0.21 1.43099e-10 -0.012 / 0.6)` with its `<ul>` at `opacity: 0.6`; an
  active pile computed `rgba(0, 0, 0, 0)` and `opacity: 1`. The drag marks came through the same
  pass and cost the borders nothing: during a drag **every** eligible pile computed a ring — the
  Sideboard included — the pile under the pointer additionally computed `DROP_OVER`'s gold
  `oklab(0.75 0.0104587 0.119543 / 0.1)`, and the drag source's own pile computed neither. That is
  now measured rather than reasoned from "a ring is a box shadow outside the border box". **The
  harness caveat stands**: `cdp.mjs drag` intercepts, so a green pass proves nothing about a real
  hand on a real mouse — [live-ui-verification.md](live-ui-verification.md) says why.
  **The trap in checking any of this: `opacity-60` is unobservable on an _empty_ pile.**
  `CardStack` returns null for a group with no cards, so a switched-off empty pile has no `<ul>` in
  the DOM at all and a probe reports *absent* rather than 0.6. The Maybeboard read exactly that way
  on the first pass and the figure above needed a card moved into it first. The wash and
  `GroupHeader`'s `INACTIVE` marker are the two signals an empty pile does still carry — which is
  the argument for having three.
- **The sideboard and the maybeboard are a rail, not packed columns — and the rail is a plain flex
  child.** Both column views split `kind === "side"` and `kind === "maybe"` out of `groups` before
  `packColumns` sees them (`splitRail`, `views/columns.ts`) and draw them in one box after the
  packed ones, at the same inline width and `flex` basis, held right by `ml-auto`. The failure it
  prevents is a drag with no destination on screen: both piles sort last, so packed they were the
  far end of the run, and a card dragged out of the main deck had nowhere to be let go of. The
  Maybeboard earns the rail on the same three counts as the Sideboard — played beside the deck
  rather than in it, routinely big because it is where the cuts and the candidates accumulate, and
  looked for by _position_ rather than by reading down the deck. **Nothing sorts the rail**: the
  Sideboard sits above the Maybeboard because that is the reader's own `sortOrder` (the seed's
  order), and a reader who reorders their categories gets the order they chose. It carries
  `RAIL_ATTR` (`data-deck-rail`) and nothing else — `STACK_COLUMN_ATTR` means "a box `packColumns`
  produced", and the rail is by construction the one box it never saw, so a sweep that counts
  columns must not find it; the name is unprefixed because `TextView` draws the same rail, and it
  is spelled for the *rail* rather than for the Sideboard because the Sideboard is no longer the
  only thing in it. It is rendered only when a `side` **or** `maybe` group exists, which is a real
  condition for a story or a test and **not** one for the app: `schema::PREDEFINED_CATEGORIES`
  seeds both into every deck, an empty category group is drawn (neither of them is one of the two
  conditional zones — see `grouping.ts`'s `drawsWhenEmpty`), and a predefined pile cannot be
  deleted — so in `category` mode the rail is there from the moment a deck is created. **The cost
  is `stackColumnWidth(zoom)` beside the flow** — 224px at 1× and 434px at 2×, both derived from
  that one function — which at 2× is a third of a 1280px window standing beside two piles that on a
  new deck hold nothing at all; below one column plus the rail it takes its own line instead, which
  is the wrap in the entry further down. **Those widths are unchanged by the Maybeboard joining**:
  the two piles share one rail one column wide, so the second costs height and nothing else, and
  the height is the one thing here that has not been driven in the window.
- **Which piles are drawn, driven 2026-08-14 — in Storybook over CDP (headless Edge), _not_ the
  shipped window.** Against `.storybook/fake`, reading each group's accessible name off
  `section[aria-labelledby]`: the Modern deck drew `Main deck, Sideboard, Maybeboard` with **no
  Commander and no Companion**, and the rail held `["Sideboard", "Maybeboard"]` in that order. A
  freshly created **Commander**-format deck drew `Commander, Sideboard, Maybeboard` — the command
  zone empty, the companion slot still absent in a format that allows one. Creating a category
  through the Categories drawer put an empty `Ramp` on the desk immediately, in `sortOrder` between
  `Main deck` and the rail, which is the reversal itself: under the old rule it was invisible from
  the moment it was made. Typing `bolt` into the filter removed `Ramp` and left `Main deck,
  Sideboard, Maybeboard` — the narrowed arm, cut to the fixed zones. **No number here is a
  measurement**: a headless browser at a story's viewport says nothing about the app's geometry,
  and nothing above was measured in pixels.
- **A rail this view used to hold sticky is the one thing not to reinstate.** For one commit
  (`cf13568`, 2026-08-14) the sideboard column was `sticky right-0`, opaque `bg-bg`, `LAYER.raised`
  and a `-8px 0 16px -4px` seam shadow, and every one of those four existed to keep it in view
  **while the packed columns scrolled sideways underneath it** — measured in the window that day at
  1280×800: `position: sticky`, `right: 0px`, `z-index: 10`, `width: 224px`, a viewport `left` held
  at 325px across a full scroll of a 1424px desk in a 632px scrollport, and
  `document.elementFromPoint` over a scrolled-under card returning the Sideboard's own text rather
  than the card. **Those figures describe a layout that no longer exists**: the columns wrap
  downward now, so nothing passes under the rail — an opaque backdrop occludes nothing, and the
  seam shadow would draw a permanent divider across a layout in which nothing moves. Two
  consequences went with it, and both were real while it lasted: a card scrolled under the column
  was genuinely not hittable there (correct for an opaque overlay, and the reason the first
  `cdp.mjs drag` of that pass failed with "the browser never started a drag"), and the rail shared
  `LAYER.raised` with an open card's list, ordered only by document order. Neither applies to a
  rail that asks for no z-index and covers nothing. `views.test.tsx` asserts the four absences, not
  merely the classes that replaced them.
- **The zoom badge is driven by a pulse counter, not by the zoom value** (`CardZoomIndicator`,
  `zoomPulse`). At either end of the ladder a gesture changes no number, and that is exactly when a
  reader needs an answer — they are still rolling the wheel and nothing is happening. Keyed off the
  value, the badge would fade out under their hand at the one moment it is load-bearing. It is
  `aria-hidden` on purpose: a live region here would announce a percentage per wheel notch.
  **`zoomPulse` stayed a single counter when the zoom went per-section**, and that is the right
  shape: it is the badge's clock, there is still exactly one badge, and a counter per section would
  be four clocks racing to describe one gesture. `zoomSection` — the section the last gesture landed
  on, `null` before any — is what tells that one badge which number it is showing and where.
- **The badge moved from the window's bottom centre to the zoomed section's top-right**
  (2026-08-14, with the per-section zoom). A figure floating at the bottom of the window was
  unambiguous while there was one zoom and is a riddle once there are four: in the deck editor, with
  the search column beside the desk, it named a percentage without saying whose. It is still **one
  instance mounted at the app root**, a sibling of `AppShell` in `App.tsx` — `LAYER.popup` only
  competes in the root stacking context, so mounting it inside a view would cap it at that view's,
  which is the bug `lib/layers.ts` exists about, and nothing between the root and it transforms.
  What changed is where it draws. `useCardZoomGesture` registers each section's element in a
  module-level `Map<ZoomSection, HTMLElement>` as part of the same effect that attaches the
  listener, and cleanup deletes the entry **only if the map still holds this element** — React may
  mount a replacement before unmounting the old one, and an unconditional delete would then drop a
  live registration. `anchorFor(section)` reads that element and answers viewport offsets from its
  `getBoundingClientRect()` — `rect.top` and `documentElement.clientWidth - rect.right` (**not**
  `window.innerWidth`; see the scrollbar entry below), each inset by
  `ZOOM_BADGE_INSET`. With no element (no gesture yet, or a section that is not mounted, which is
  what a story driving the store directly looks like) it falls back to the **window's** top-right
  corner, so the badge is always somewhere sensible rather than conditional on a rect. The pill is
  `fixed` at those offsets with `origin-top-right`, so `popup`'s 0.96 scale grows it **into** its
  corner instead of sliding it across the screen; the old `inset-x-0 bottom-10 flex justify-center`
  row went with the reason it was written for, which was that a centred pill in a full-width row
  scales about its own middle.
- **The rect is measured during the render that detects the pulse, not in an effect, and that is
  correct rather than a shortcut.** A section's *box* does not move when the zoom steps — only its
  contents resize — so the pre-commit rect is already the right answer, and the badge's first
  painted frame is in the right corner. An effect would cost a frame with the badge somewhere else,
  on a surface that is only up for `ZOOM_QUIET_MS` in the first place. The anchor is set beside
  `shownFor` in the same during-render adjustment the indicator already used for its pulse, which is
  React's own answer for state derived from something that changed and this project's — see
  `lib/useDelayedFlag.ts`.
- **The anchor and the split are measured in the shipped window — 2026-08-14,
  `npm run tauri build -- --debug --no-bundle`, a debug build at 1280×800**, driven over
  `scripts/cdp.mjs` against the real corpus. (Two things in this group were *not* driven; the last
  bullet of the four says which.) **The badge lands on the zoomed section's corner exactly.** On the search wall the scroller's rect read `top 190 / right 1260` and the badge painted
  at `top 198 / right 1252` — both edges inset by `ZOOM_BADGE_INSET` and neither off by a pixel. The
  pill computed `position: fixed`, `z-index: 30` (`LAYER.popup`), `pointer-events: none` and a
  `transform-origin` of `59.6px 0px` on a 59.6px-wide pill, which is `origin-top-right` measured
  rather than argued: the scale grows it into its own corner.
- **The sections are independent, driven in both directions with the deck editor's panel open.**
  Desk at `top 263 / right 830`, the docked panel's wall at `top 551 / right 1230`. Ctrl+wheel over a
  deck card took that card **208 → 229px** while the panel's tile held at **159px**; ctrl+wheel over
  the panel took its tile **159 → 330px** — its 371px column dropping from two tiles to one — while
  the deck card held at **229px**. Three sections held their own value at the same moment: `search`
  at **150%**, `deck` at **110%**, `deckSearch` at **110%** (the last two coincide; they were
  arrived at separately and neither followed the other). That is the defect this change was made
  about, measured gone.
- **`window.innerWidth` is the wrong viewport width to position a `fixed` element from, and this
  branch shipped the bug for a day.** `anchorFor` computed its `right` offset from
  `window.innerWidth`, which **includes** the classic vertical scrollbar, while a `position: fixed`
  element is positioned against the initial containing block, which **excludes** it. Measured in the
  same pass: `innerWidth` **1280** against `documentElement.clientWidth` **1265**, so the badge sat
  **15px left** of the corner it was aiming at — painting its right edge at 807 where 822 was wanted
  on the desk, and at 1207 where 1222 was wanted on the panel. Fixed by reading
  `documentElement.clientWidth`. **It hid twice over, and the second hiding place is the one worth
  reading**, which is why this is its own rule rather than a footnote to the anchor. It was
  invisible on the search wall, which has no page scrollbar and so reads correct at every zoom. And
  it was invisible to the suite — but **not** because jsdom reported the two widths as equal, which
  is the plausible wrong answer and was believed for a day. **jsdom has no layout engine at all**:
  `Element-impl.js` is a hard `get clientWidth() { return 0; }` for every element, with no special
  case for the document element. Probed in this repo: `window.innerWidth` **1024**,
  `document.documentElement.clientWidth` **0**. So a jsdom test cannot read a viewport width — it
  has to **state** one — and the test helper stated `window.innerWidth`, which is precisely the
  expression the bug was made of. **That is worse than blindness: the suite pinned the defect as
  the expected answer and certified it.** The assertion looks like it is checking where the badge
  is anchored and is checking nothing, and it would have gone red against the *fix*. The general
  trap, for whoever writes the next one: **a stated-viewport test proves only that the code agrees
  with the number the test stated**, so state a width that is not the expression under test, or
  accept that the question is a live one. Anything else positioned `fixed` from a measured rect
  owes the same distinction.
- **What was *not* driven here, stated plainly.** The gesture was dispatched as a **synthetic**
  `WheelEvent` with `ctrlKey` on a card and left to bubble to the section root. That exercises the
  listener, the store and the whole render path — `dispatchEvent` returned `false`, so something did
  call `preventDefault` — but a synthetic event is not a trusted input event, so **the
  `preventDefault`/WebView2 page-zoom suppression below was not re-driven on this branch**; it is
  unchanged from before it and rests on its own earlier evidence. Storybook was never started for
  this branch either, so no story here has been previewed.
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
  `layers.test.ts` asserts every link of it. **`overlay` is one rung for every full-window
  surface, deliberately, where two looks more careful**: the deck editor's **six** — Import,
  Categories, Tags, History, Theory diff, Deck settings — are held in **one** piece of
  state (`DeckEditor`'s `Layer` union) because `useDismissOnEscape` orders exactly two rungs, and
  two `"inner"` peers open at once are not ordered at all. At most one of the six is ever
  mounted,
  so there is no pair for a second number to order and inventing one would be a claim about a
  stack that cannot occur. They used to borrow `gate` and `dragTray` two apiece — each right in
  effect and wrong in name. Measured 2026-08-11 in the shipped window: the scrim computes to
  `z-45`, one Escape closes the overlay and leaves the card pane open, a second closes the pane,
  and each hands focus back to the control that opened it. (That was five surfaces, two of them
  right-hand drawers, when the reading was taken; the entry below is what changed and what did
  not.)
- **A surface opened from a view is a centred modal, not a docked column, unless the reader works
  out of it while editing beside it** (2026-08-14). The deck editor's two right-hand drawers
  became dialogs: `AuditDrawer` → `DeckHistoryDialog`, and `CategoriesPanel` split into
  `CategoriesDialog` and `TagsDialog` — two sections of one drawer that each cost a press and a
  scroll are two dialogs one press apart, each sized for what it draws. All of them and
  `DeckSettingsDialog` are now built on **one shell, `src/features/decks/DeckDialog.tsx`**, so
  "the style of Deck settings" is a component rather than a resemblance: `LAYER.overlay`, the
  `scrim` preset, `aria-modal`, `trapTab`, the `"inner"` Escape rung registered on the open flag
  (the panel outlives that flag by the length of its fade), and **nothing mounted while closed**,
  which is what lets each body start its queries and its state clean on every open. The shell
  does not own the body's scroller — the history body has a sticky roll-up inside its own — so
  each body renders its own `min-h-0 flex-1 overflow-y-auto`.
  **The argument is width, and it is the desk row's own number.** At the app's own 1280×800 with
  the card pane docked that row measures **602px** (`DeckEditor`'s `DECK_FLOOR`), so the 384px
  search panel plus its 16px gap leave the deck **202px** — one stack column. A drawer that is
  merely *consulted* took its width out of the deck for as long as it was up and gave the deck
  nothing back; centred over a scrim, the deck keeps the whole desk underneath it.
  **The card search column stays docked, and that is the other half of the rule.** It is the one
  surface here that is worked *out of*: its tiles are drag sources into the deck's own category
  columns beside it, so a scrim would end the drag path and cover the card pane a reader flips
  printings in. What changed for it is its default — `DeckSearchPanel` opens **collapsed** now,
  because the same 602/384/202 arithmetic says an open-by-default panel charged every reader one
  stack column on every deck they opened whether or not they were adding cards. Collapsed, the
  deck starts with the whole desk and one press on the rail gets the wall back. The choice is the
  component's own `useState` and deliberately not a `useAppStore` field: it is per editor-open and
  not remembered, on the same line `searchView`/`collectionView` sit the other side of
  — those are session-wide answers about the *app*. (`cardZoom` was named in that group until
  2026-08-14 and is a third thing now: session-scoped like those two, but one number per card
  **section**, so this panel's own wall zooms apart from the desk beside it — see the zoom entry
  above.)
  `src/lib/motion.ts`'s `drawerRight` lost its last consumer to this change and was deleted; see
  [motion.md](motion.md). **None of this has been driven in the shipped window yet** — the layer,
  focus and Escape figures above were taken on the drawers this replaced, and the collapsed
  default's effect on the desk is arithmetic from `DECK_FLOOR`'s measurement rather than a new
  reading.
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
- **A fixed-width column layout that opens the next column to the right is a horizontal
  scrollbar with extra steps.** The deck editor's two column views pack a deck's groups into
  columns of a fixed width — `stackColumnWidth(zoom)`, 224px at 1×, and `TextView`'s
  `COLUMN_WIDTH`, a flat 300px that does not zoom — and both used to lay those columns in one
  non-wrapping row inside an `overflow-auto` box. That is not a decision at 1280px and five
  columns; it is a decision at the app's floor. **The floor is a 1024px window**, where the
  editor's desk row — the view and the docked search panel, with a stats block between them at
  the time these were taken, since moved to a band under the deck — measures
  **376px** with the card pane docked (361 once the page's own scrollbar is out), and **the view
  itself — the box the columns are actually in — gets 313 of it**, from `DeckEditor.tsx`'s own
  measured table: `| 1024 | open | 361 | 313 | rail |`. Only 376 is pinned to the pixel, as
  `DeckEditor.test.tsx`'s `desk(376)`; 361 and 313 live there in prose. **313 is the column
  budget**, and against it one 224px stack column leaves 89px and one 300px text column 13 — one
  column, either way. `packColumns` fills a column before opening the next, so a deck is always
  fewer columns than it has categories; it is nonetheless **more columns than the desk is wide**
  the moment it has two, and every column after the first opened to the right, off the edge, with
  an X scrollbar across the whole desk. Same failure as the popup above, from the other
  direction — and it is the one route `DECK_FLOOR` never measured: **192
  is the width the deck side is _guaranteed_, and it does not hold even one column**, because
  that floor was written for how the desk row is *divided* and never for what the pack does
  inside the view's share of it. It has only ever moved away from holding one: 224 → 208 → 192,
  each drop a scrollbar the row's arithmetic had not counted. The fix is `flex-wrap` on the packed row: the column that will not fit goes below the line
  and the reader scrolls **down**, which every deck view already does. `packColumns` is
  untouched by it — the wrap is a property of the box the columns are laid in, not of how they
  were filled — and `overflow-auto` stays rather than narrowing to `overflow-y-auto`, since one
  column zoomed past the desk's own width genuinely is wider than its box and clipping a card is
  worse than a scrollbar the reader asked for. Wrapping is what makes that the rare case.
- **A pinned rail wraps below the flow rather than pushing it sideways, and CSS is what decides
  — never a `ResizeObserver`.** The Sideboard and the Maybeboard were the pack's worst case.
  `packColumns` is greedy and in the reader's own order (never reordering, never splitting a
  group), so a category like any other lands wherever the run puts it, and the two piles a reader
  most often wants beside the deck sat at the far end of a long sideways run, off screen.
  `splitRail` takes the `side` and `maybe` groups out before the pack runs and draws them as one
  column pinned right; the pack keeps its whole contract and is handed fewer groups. Whether there
  is room for that rail is decided by
  the flowing area's `minWidth` of one column plus the outer container's own `flex-wrap`: while
  the desk holds two columns and the gap between them the rail sits beside the flow, and below
  that width it wraps onto its own line, where `ml-auto` keeps it on the right. **`content-start`
  belongs on the view's root and nowhere else**, and it is what keeps a wrapped rail immediately
  under the flow: that root is a `flex-1` item of a `min-h-0 flex-col` parent, so it is as tall as
  the scroller rather than as tall as its content, and `align-content`'s initial `normal` behaves
  as _stretch_ — two lines in a box with slack means the slack is dealt out between them, hanging
  the rail in mid-desk under a small deck. `items-start` cannot say it (it aligns an item within
  its line), and the flowing box inside cannot carry it (that box is never stretched, so it has no
  free cross-space to align). **That threshold
  is arithmetic rather than a measurement** — 224 + 16 + 224 = **464px** in the stack view at 1×,
  whose gap is `gap-4` (884 at 2×, where a column is 434), and 300 + 24 + 300 = **624px** in the
  text view, whose gap is `gap-6` and whose 300px column has no zoom to move it. `min-w-0` and
  `flex-1` cannot express it, because a flex item that may shrink to nothing never wraps at all.
  An observer could, and is refused: **a view has no business observing its own box** —
  `DEFAULT_COLUMN_HEIGHT`'s doc is explicit that the editor measures the scroller and passes the
  height — and a second reading of the same box answers a frame behind the layout it is reacting
  to, which at exactly this threshold is one frame of the scrollbar the whole change exists to
  remove. **Driven in the shipped window 2026-08-14** (`npm run tauri dev`, a **debug** build,
  a seeded 16-category deck — twelve named piles plus the four predefined), and the two
  derived thresholds came back exact:
  - **No horizontal scrollbar at any width tested.** `document.body.scrollWidth ===
    clientWidth` at 1024, 1280 and 1920, and the deck view's own scroller matched itself at
    every one — 602 = 602 at 1280, 1257 at 1920, 331 at 1024. It scrolls **down** instead:
    **5888px** at 1280 against a 384px box.
  - **The rail's wrap threshold is the arithmetic, to the pixel.** The text view's rail wrapped
    below the flow at 1280 — its view is **602**, under the derived **624** — while the stack
    view's, needing only 464, stayed beside it. At 2× the stack column is 434 and the threshold
    884, and the rail wrapped there too, still with no sideways scroll.
  - **`ml-auto` is what puts a wrapped rail back on the right**, and it does: at 1024 the rail
    took its own line with its right edge on the flow's, 15px of scrollbar in from the
    scroller's own edge.
  - **The sticky machinery really is gone** — the rail computes `position: static`,
    `box-shadow: none`, `z-index: auto` and a transparent background — and **`content-start`
    is on the box that has a height**: the view root computes `align-content: flex-start`.
  - **The one case that can still scroll sideways behaves better than this entry claimed.**
    At 2× in a 1024px window a single 434px column does not fit the 331px view, and the
    overflow is **103px inside the deck view** — `document.body` never moved. The app does not
    slide under the reader; one panel scrolls, which is the failure the popup rule above
    forbids only for the *page*.
  - **What the live pass found that no test could**: at the app's own 1280×800 with the search
    panel docked the view is 602px, and the rail's 224 plus the gap leave **362 — one column**.
    A 13-column deck is therefore thirteen lines and fifteen screens of scrolling, where the
    old sideways layout showed about 2.7 columns at once. The horizontal scrollbar is gone and
    the density went with it; that is the trade this change makes, and it is worth knowing
    before widening the rail or narrowing the columns.
  - **That pass predates the Maybeboard joining the rail, and nothing above has been
    re-measured.** Every width and every threshold here is untouched by it — the rail is one
    column wide whether it holds one pile or two, so 224, 434, 464, 624, 884 and the 362 that
    leaves one column all still say exactly what they said. What the second pile changes is the
    rail's *height* and, by one group, what is left to flow: the **5888px** scroll and the
    **13-column** deck were read with the Maybeboard still packed among the twelve named piles.
    Read those two as facts about that run rather than about today's layout.
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
    `Custom…` a table-header sort leaves behind, `Auto (by what it does)`, `Top level`.
    `CategoriesDialog`'s `are deleted with it` is pinned **last** — the destructive answer is
    not allowed to become the default by alphabet. (A sixth, the deck card's permanent `Move…`
    verb, went with that select on 2026-08-14.)
  - **Two exemptions, and they are the whole list.** A **grade scale** — card condition runs
    Near Mint → Damaged, and alphabetised it would open on "Damaged". And an order **the
    reader arranged themselves** — a deck's categories are drag-sorted in `CategoriesDialog`
    and rendered in that order by all four deck views, so an alphabetical dropdown would
    disagree with the columns beside it. Both carry a comment at the site saying so, because
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
