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
  so a `size 1024 768` earlier in the run had the _next_ check reading a railed panel at what
  looked like 1280 — a regression that was not one. Read `innerWidth` in the same expression as
  anything width-dependent; the harness contract says to end a run by restoring the
  `innerWidth`/`innerHeight` you read before the first override — the window's own size, which
  since 2026-08-20 depends on the monitor — and this is the failure that rule is about.
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
  card is 295px tall; the deck's table and text views abbreviate to `GameChangerBadge`'s gold `GC`
  where a cell has a column; and **anything that draws a card as a face** — the search wall, the
  collection, the deck editor's docked search column and, since 2026-08-16, the deck's own Grid
  view — gets `components/GameChangerMark`, **the banner's
  crown and nothing else**, because a 170px tile is somebody else's artwork and a ribbon across it
  is a sticker over the picture the reader came to look at. `text-pie-gold` in all three: the spec
  is explicit that a game changer (a fact about a powerful card) and a rule break (a problem)
  must never be confusable, and the destructive colour belongs to the second. It shares the finish
  chip rather than taking a corner of its own — **a card fact and a printing fact in one box**,
  since a card can be either, both or neither. Nothing derives it: the backend flattens
  `cards.game_changer`'s NULL into `false` (the column is nullable; only `card_row.rs`'s parser
  struct is a `bool`).
- **The rule break's edge is the fourth separation, and on the stacked card it is drawn by _two_
  elements** (fixed 2026-08-14). `CardStack`'s data line is a sibling of the face, not a band
  inside it: `-mx-px` puts its own border exactly where the card's is, and being `relative` and
  later in the document it paints **over** it. So the card's `border-destructive` was interrupted
  by 28px of `border-border` down both edges, starting exactly at the seam where the foot joins
  the face — the one place a reader looks to decide whether they are seeing one object or two,
  which is the whole job of a mark that changes the card's own edge. The fix is that both elements
  read the same `ruleBreakText` expression, and the bar draws `border-x` only: its bottom border
  sat 1px _above_ the card's rather than on top of it, so leaving it would have given a red card a
  2px foot under a 1px everything-else. Verified in Storybook over CDP
  (`Decks/CardStack` → `RuleBreakAndGameChanger`, headless Edge, the card focused open): the face
  computes 1px `oklch(0.704 0.191 22.216)` on all four sides and the bar the same colour at
  `0px | 1px | 0px | 1px`. **The general rule this is an instance of**: anything positioned over a
  card's border is part of that border, and a new bordered sibling under the face has to carry the
  card's colour or it re-opens this.
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
- **The printing count is the deck editor's quantity tag now, and it dropped its `×`**
  (2026-08-14). It was `×N` in the wall's own `bg-bg/85` chip; it is `components/CountTag` — the
  filled banner cut off at a slant that the deck stack has drawn copies-in-a-pile with since
  2026-08-13 — in the neutral grey, because a printing count has no tag to take a colour from.
  One object for both statements: a mark the eye finds before it reads the card only works if the
  two are the same shape, and a number laid on a card had been drawn two ways in one app. The
  `×` went with the chip — a banner in a corner already says "this many", and the sign was a
  second glyph in a 22px box. **A count laid _beside_ a card keeps its `×`**: `OwnedBadge` in the
  caption and the search table's `×132 printings` cell are inline text, where the sign is what
  tells a count from a set number. `CardGrid`'s `topLeft` is consequently the one corner with no
  backing under it — a chip behind a banner frames a frame — while `badge` (bottom-left) keeps
  the wall's felt, so the wall still owns the _corner_ and owns nothing about the paint.
  **`UNTAGGED_COLOR` moved with the shape**, from `features/decks/tagColors.ts` to `CountTag`'s
  own `NEUTRAL_COUNT_PAINT`: the search wall draws this over cards that have no tags at all, so
  the neutral fill is a fact about the mark rather than about that palette.
  **Driven in the shipped window 2026-08-14** (`npm run tauri dev`, a **debug** build at
  1280×800, against the real 116 703-card corpus): a tile's corner computed `background-color:
rgb(200, 196, 191)` — `--color-pie-c`, `#c8c4bf` — with `color: oklch(0.2 0.02 85)`,
  `clip-path: polygon(0px 0px, 100% 0px, calc(100% - 10px) 100%, 0px 100%)`,
  `aria-hidden="true"`, and text `2` / `4` with **no `×`**. It measures **25 × 22** inset **4px**
  top and left of a **170 × 238** tile, overflowing neither edge, and its wrapper computed
  `background-color: rgba(0, 0, 0, 0)` with `pointer-events: auto`. The deck editor's own tags on
  the same build measured **25 × 22**, the same fill and the same clip, `position: relative` and
  `z-index: 1` — the two surfaces are one box, which is the claim the whole change rests on and
  the only one a screenshot could not settle. **The name coverage did not move**: 25px plus the
  4px inset against the old chip's ~28px for `×2`, so the tile's printed name loses what it
  always lost. **One arm was not driven** — the _coloured_ tag, since the deck to hand carried no
  tagged cards; `CardStack.test.tsx` and `CountTag`'s `Painted` story are what hold that path.
- **And the printing count stopped being that tag the next day — it says the word now**
  (2026-08-15). `132 printings`, in the wall's own `bg-bg/85` chip, at `text-[10px]`. The bullet
  above is the record of the shape it replaced and every figure in it was true of that shape; what
  it got wrong is the half it argued hardest for. "One object for both statements" is right about
  the _drawing_ and wrong about the _statement_: the deck stack's bare number is printed **on a
  tag**, so the thing beside it says which quantity is being counted, and the search wall's bare
  number had nothing beside it at all. Both earlier shapes put the meaning somewhere the eye is
  not — `×132` in a tooltip, `132` in a silhouette shared with "copies in this pile" and told
  apart only by which surface you were looking at. A search tile has room for the word, so it
  spends it, and the corner reads with no hover and no legend.
  Three things follow, and the third is the one to check before touching this again:
  **(1)** `CardGrid`'s `topLeft` carries the same backing as `badge` — the no-backing exception
  existed only because a `CountTag` brings its own paint, so all three of a tile's corners are the
  felt-at-85 % chip again;
  **(2)** the mark is **plain visible text**, not `aria-hidden` with an `sr-only` twin, which is
  only legitimate because the corner is a _sibling_ of the tile's button and outside its
  accessible name — the `title` survives for the one word the corner has no room for, **matched**,
  since the number counts the printings that got past the filters rather than the card's whole
  print run;
  **(3)** **it cannot be drawn clear of the printed card name at the default zoom, and that is
  geometry rather than a placement to fix.** A card's black border is ~3.4 % of its height, so on
  a 170 × 238 tile the strip above the nameplate is **~8px** and the nameplate itself runs to
  ~22px. The chip is ~14px tall and `CardGrid` insets every corner by 4px (a box at 0,0 hangs off
  the art's `rounded-lg`, which does not clip a sibling), so it occupies **4–18px**: clear of the
  card's top border, over the left end of the name. The mark does not scale with the zoom and the
  card does, so the overlap shrinks with every step and by ~2× the chip sits in the border strip
  outright. Making it clear at 1× means shrinking the type below the app's smallest, or moving the
  mark out of the art — both were weighed and neither was taken.
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
  is a `Record<ZoomSection, number>` keyed by `ZOOM_SECTIONS` (`src/lib/cardZoom.ts`, which is the
  list — no count is written here, because a count is a fact about a tree and the constant already
  answers it): `search`, `collection` and `wishlist`, the three list walls; `deckSearch`, the deck
  editor's docked search column, which is a fourth `CardGrid`; `deck`, the editor's desk — **one key
  for both deck views**, because Stacks and Grid are two drawings of the same pile and switching
  between them must not resize the cards the reader just settled on; and `printings`, the modal's
  wall, which opens *over* a wall the reader has already sized. `useCardZoomGesture(ref, section)`
  names the section it is stepping. **The wishlist joined the list on 2026-08-20**, when it gained a
  card view of its own; until then it was `VirtualTable` only and had no card section to zoom.
- **What is drawn _on_ a card scales with it, through two inherited custom properties**
  (2026-08-17). Until then the zoom sized the tile and nothing else: the finish chip, the crown, the
  owned badge, the printings count, the rarity gem, the caption, the deck's copy count and tag dot,
  the quantity tag, the Game Changer banner, the rule break, the printed no-picture frame and the
  quick-add and stepper controls were all fixed Tailwind literals, so a doubled card carried
  hundred-percent chrome. `SearchPage`'s own comment had already recorded the consequence — its
  printings chip is inset 4px so it lands on the card's printed nameplate, and held at 4px it had
  climbed into the border strip above the name by ~2×.
  - **`--mark-scale` is the reader's zoom; `--control-scale` is that times `CONTROL_SHRINK` (0.85)**
    — a control drawn on somebody's artwork, revealed on hover, does not need the presence a
    table's stepper has. Both live in `src/lib/cardZoom.ts` and are published by `cardScaleVars()`.
  - **Three elements set them and nothing else has to be touched**: `CardGrid`'s tile, `GridView`'s
    tile and `CardStack`'s card. **A variable rather than a prop because the marks are shared.**
    `RarityGem`, `OwnedBadge`, `FinishMark`, `TagDot`, `CountTag` and `QuantityStepper` are each
    drawn on a card face _and_ in one of the three tables or the card pane, so a prop would have to
    be threaded to every one and defaulted at the ones that must hold still — "does this scale?"
    answered fifteen times by whoever adds the newest call site. Every mark reads
    `var(--mark-scale, 1)` instead, and the fallback is what a table gets for knowing nothing.
  - **Real geometry, never `transform: scale()`** — the standing rule, and here the caption strip is
    what enforces it: it is _in flow_, and a transform changes no layout, so scaled text would grow
    straight out of the strip the virtualiser sized its rows from.
  - **What does not scale, and why**: hairline borders (1px is a hairline at every size),
    `CardArt`'s `rounded-lg` and the stack's 7px corner (Tailwind classes that do not scale — which
    is also why `STACK_DATA_RISE` stays 4px, since it hides the seam under that corner), the
    stack's `STACK_LIFTED_MARGIN` (a gap saying "this card is out of the pile", not part of the
    card), the banner's drop shadow, and the gutters `CardGrid` splits either side of a row.
  - **Driven in the shipped window 2026-08-17** (`npm run tauri dev`, a **debug** build at
    1280×800, against a real 116 712-card corpus, ctrl+wheel dispatched synthetically). Search
    wall, 0.5× / 1× / 2×: tile **85 / 170 / 340**, caption type **6 / 12 / 24px**, rarity gem
    **3 / 6 / 12**, quick-add **10.2 / 20.4 / 40.8**, the finish-and-crown chip **10×8 / 20×16 /
    40×32** with its glyph **6 / 12 / 24** and its inset, padding and radius **2 / 4 / 8px**, the
    printings chip **5 / 10 / 20px** type. That chip sat **1.7 % down the art at both 1× and 2×** —
    the same place on the picture, which is the defect closed. Deck stack: card **105×158 /
    210×319 / 420×639**, reveal **17 / 34 / 68**, quantity tag **12.6×11 / 25.2×22 / 50.4×44** at
    **6 / 12 / 24px**, data line **14 / 28 / 56** at **5 / 10 / 20px**, `RULE BREAK` **9 / 18px**,
    the Game Changer banner **117.8×12 / 235.5×24** with a **9 / 18px** crown, the stepper column
    **20.4 / 40.8 / 81.6**. **The tag fits inside the reveal at 0.5× (11 ≤ 17)**, which is the one
    property `stackAdvance`'s floor existed to protect and is now held by the tag scaling instead.
    Deck grid: tile **75 / 300**, copy count **4.5 / 18px**, foot **10 / 40**, stepper **8.5 / 34**.
    **The control case**: with the desk at 2× the deck's _table_ row still read a **6px** gem and a
    **20px** stepper with `--mark-scale` **unset**, and with the search wall at 2× beside an open
    card pane the pane's finish glyph still read **12px**. The `85 → 340` tile at
    `mark-scale 0.5 → 2` and `control-scale 0.425 → 1.7` was read off the tile's own computed style
    at every stop.
- **The rule this reversed, and why it was wrong.** It read: there is one `cardZoom` behind all of
  them, "because it is a statement about how the reader is reading cards rather than about how one
  list is configured: zoom the search wall, switch to Decks, and the cards there are already the
  size that was asked for." That argument is about a **navigation** — one section leaving the screen
  as another arrives — and it never covered the case the deck editor creates, where two card
  sections are on screen **at the same time**. A reader zooming the docked search column was
  resizing the deck laid out beside it, and those are two different questions asked in the same
  second: _how big are the cards I am browsing_ against _how big is my deck laid out_. The
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
- **The zoom sizes the _tile_, and the column count is what falls out of it** (changed
  2026-08-14). `CardGrid` draws a tile at `scaled(baseTileWidth, cardZoom)` exactly, fits however
  many of that size the wall holds, and splits the remainder either side of the row
  (`sideGutterFor`). **It used to scale a _floor_ and stretch the tiles to fill the row**, so the
  wall reached both edges at every window size — flush was the whole argument, and it cost the
  gesture its meaning. A stretched tile's width is a function of the **column count**, which is a
  step function of the zoom, so most stops drew exactly what the stop before them drew. Measured
  on the deck editor's docked column, whose wall is **330px** in the running window, the ten stops
  of `ZOOM_STEPS` collapsed to **three** distinct card widths — 102, 102, 159, 159, 159, 331, 331,
  331, 331, 331. Seven gestures in a row that moved nothing, which reads as an app that has
  stopped listening rather than as a wall that is already right. **Driven in the shipped window
  2026-08-14** (`npm run tauri dev`, a debug build, 1280×800), the same column now answers all
  ten, strictly increasing, and stays centred throughout:

  | zoom    | 0.5 | 0.67 | 0.75 | 0.9 | 1   | 1.1 | 1.25 | 1.5 | 1.75 | 2   |
  | ------- | --- | ---- | ---- | --- | --- | --- | ---- | --- | ---- | --- |
  | tile    | 75  | 101  | 113  | 135 | 150 | 165 | 188  | 225 | 263  | 300 |
  | columns | 3   | 3    | 2    | 2   | 2   | 1   | 1    | 1   | 1    | 1   |
  | gutter  | 41  | 2    | 46   | 24  | 9   | 83  | 71   | 53  | 34   | 15  |

  The page-width search wall behaves the same way — 991px of wall gave 170/187/213/255/298/340
  across the first six stops, at 5/5/4/3/3/2 columns and 47/4/52/101/37/150px of gutter. **The
  wheel was dispatched synthetically on both** (`dispatchEvent(new WheelEvent(…, {ctrlKey: true}))`
  on the scroller), which is the same carve-out the 2026-08-14 zoom pass recorded: the handler and
  the arithmetic downstream of it were exercised, the `preventDefault`/WebView2 page-zoom
  suppression was not re-proved.

- **The remainder is split either side rather than left at the right edge, and that is the half
  of the old argument that survived.** A one-sided gutter of up to a whole tile really does read
  as a column that failed to draw — the original reason for stretching. Centred, the same pixels
  read as a margin: the wall is symmetrical at every zoom, and what the reader traded for bigger
  cards is visible on both sides. It is padding on **every row** rather than `justify-center` on
  them, because a part-full last row has to line its tiles up under the full rows above it — three
  tiles centred under six is a wall that has lost its grid — and it is not on the box around the
  rows because that box is what the `ResizeObserver` measures, so padding there would feed back
  into the width it is computed from.
- **`tileWidthFor` caps at the wall, and the cap covers exactly one case.** `columnsFor` floors at
  one column whatever the arithmetic says, so a reader zooming a narrow column past its own width
  would otherwise be handed a tile wider than its box — and the deck editor is `overflow-y-auto`,
  which computes `overflow-x` to `auto`, so a 300px card in a 206px column is a horizontal
  scrollbar across the whole deck builder. That is the one thing the 1024px floor forbids, and it
  arrives with nothing on screen naming the culprit. At two columns or more the cap cannot bind,
  by construction.
- **The deck editor's search column is draggable from its left edge** (2026-08-14) —
  `DeckSearchPanel`'s `ResizeHandle`, an ARIA window splitter: `role="separator"`,
  `aria-orientation="vertical"`, a `tabIndex`, and `aria-valuenow`/`min`/`max` in **px**, the unit
  the reader is actually choosing. It is the other half of the same complaint the zoom fixes —
  bigger cards need somewhere to go, and the answers are zoom out, or widen the column.
  - **Two bounds, and each is wrong on its own.** `min(half the window, what the desk can spare
over DECK_FLOOR)`. Measured in the shipped window at 1280×800: with the card pane open the
    desk is **602**, so the deck's floor gives **394** while half the window is 632 and says
    nothing; with the pane closed the desk is **1002**, the floor would allow 794, and the
    half-window cap holds the column to **632**. Both were driven to their stops and held.
    **632 rather than 640 because the viewport is `document.documentElement.clientWidth`**, which
    is 1265 with the editor's page scrollbar out — `innerWidth` would have read 1280 and given
    640, which is this file's `innerWidth`-vs-`clientWidth` rule turning up in a second place.
  - **The minimum is one card, 206px** (`MIN_PANEL_WIDTH_PX`) — a 150px tile plus the panel's
    border and padding (13), the wall's (26) and the wall's scrollbar (**15**, measured; an older
    note here guessed 17). Driven at that width the wall measured **152px**: one tile with a pixel
    either side.
  - **That minimum is also the rail's threshold now, and it moved the threshold 592 → 414.** The
    editor used to ask whether `DECK_FLOOR` plus the panel's one fixed 384 fitted; a panel with a
    range is asked whether its narrowest useful width does. Across the 178px between the two the
    panel draws squeezed instead of railing — driven at a desk of **450**, it took **242** and left
    the deck exactly its **192**, with a whole card still on the wall and no horizontal overflow.
    Below it nothing changed: at 1024 with the card pane docked the desk is **346**, and the panel
    is 36px of rail, `aria-disabled`, with "Not enough room — close the card details or widen the
    window" on it.
  - **The width is the reader's and is never written by the environment.** It is `useState` in the
    panel's root — per editor-open like `open`, not remembered past the deck — and the caps clamp
    what is _drawn_ rather than what was asked for, so a window narrowed and widened again gives
    the column back. It outlives a collapse and a railing because it lives in the root rather than
    in `OpenPanel`.
  - **Driven with a real pointer, which needed a new harness command.** `cdp.mjs` had `drag` (the
    HTML5 drag controller) and `hover`, and neither presses a button and moves. `pull <css> <dx>
[dy]` does — `mousePressed` → stepped `mouseMoved` with the button held → `mouseReleased` —
    and the reason it had to be real is `setPointerCapture`: a `dispatchEvent(new PointerEvent(…))`
    out of an `eval` names a pointer id that was never active, so the capture throws
    `NotFoundError` _inside_ the handler and the pass fails on the harness rather than on the page.
    A 200px pull took the panel 384 → **584** and the wall from two columns to **three** at the
    same zoom, which is the feature in one measurement. `ArrowLeft`/`ArrowRight`/`Home`/`End` were
    added to `KEYS` for the keyboard half and drove it 206 → 278 → 632 → 206 with focus staying on
    the handle and the editor not scrolling under the presses.
  - **The grip is drawn on hover and focus only.** At rest the edge is the hairline the panel
    already had — a permanent handle down it would be a second line saying one thing. Measured:
    `cursor: col-resize`, `touch-action: none`, and `transition-property: opacity` unemulated
    against **`none`** under `prefers-reduced-motion: reduce` (with `transition-duration` still
    reading `0.15s`, which is the false failure this file's harness rule warns about, reproduced
    again).
- **A scaled budget floors rather than scales only while the chrome inside it is unscaled — and
  since 2026-08-17 almost none of it is.** The rule was `max(base, scaled(base, zoom))` and three
  surfaces landed on it independently: `CardGrid`'s 28px caption was set by the 24px quick-add
  button inside it, so a plain 0.5× gave a 14px strip under a 28px caption and the virtualised rows
  overlapped by the difference; `CardStack`'s 34px reveal was a legibility floor for the 22px chip
  laid over it; `GridView`'s caption was 4.5px type at half size. Every one of those arguments was
  about chrome the zoom could not reach. **The marks read the card's own scale now** (below), so
  each budget and its contents are one proportion and `atLeast` has one consumer left —
  `GridView`'s **gutter**, which measures the space _between_ two cards rather than anything drawn
  on one, contains nothing, and would otherwise halve into a wall that reads as a single sheet of
  card backs. `CardGrid`'s caption is also **derived** rather than written down now
  (`ceil(24 × CONTROL_SHRINK) + 4` = 25), because the button it is a budget for is no longer 24px
  and the two drifting apart is exactly the row overlap the constant exists to prevent.
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
  and is no longer what this deck draws**: its empty Companion is not drawn at all now, its
  Maybeboard rides the rail rather than the pack, and whether its empty `Enchantment` pile draws is
  a question about who made it — `drawsWhenEmpty` reads the pile's `deck_categories.origin`, and
  the v15 backfill marks a `main` pile of that name `auto`, so on that database it is out again.
  See `grouping.ts`'s `drawsWhenEmpty` and `columns.ts`'s `splitRail`. Nothing measured
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
  the DOM at all and a probe reports _absent_ rather than 0.6. The Maybeboard read exactly that way
  on the first pass and the figure above needed a card moved into it first. The wash and
  `GroupHeader`'s `INACTIVE` marker are the two signals an empty pile does still carry — which is
  the argument for having three.
- **The sideboard, the maybeboard and every switched-off pile are a rail, not part of the flow —
  and the rail is a plain
  flex child.** Both column views split `kind === "side"` and `kind === "maybe"` out of `groups`
  before the flowing half is built (`splitRail`, `views/columns.ts`) and draw them in one box after
  it, at the same inline width and `flex` basis. (**`splitRail` answers three runs since
  2026-08-20** — `{ command, flow, rail }` — and this entry is about the last two, which are
  exactly what they were. The third is the active command zones, taken out in _front_ of the flow;
  the entry two below is theirs.) **The box is pinned to the desk's right edge and nothing else
  positions it** — `ml-auto`, which went on 2026-08-17 and came back on **2026-08-18** with the cap
  on the flowing half removed (`flowMaxWidth` is deleted). The day between is the whole argument:
  capping the flow at whole columns did put the rail one gutter from the deck's last pile, and it
  did so by letting the rail drift left with the deck's own width — which is the thing the reader
  wanted fixed in place. The leftover is the price, up to very nearly a whole column and a
  different number at every zoom stop, and it is dead desk between the deck and the rail. **What
  the margin actually does is the wrapped line**: beside the flow it resolves to zero, because
  `flex-1` has already taken every free pixel of the line and the rail is at the right edge for
  want of anything to its right. The failure it
  prevents is a drag with no destination on screen: both piles sort last, so packed they were the
  far end of the run, and a card dragged out of the main deck had nowhere to be let go of. The
  Maybeboard earns the rail on the same three counts as the Sideboard — played beside the deck
  rather than in it, routinely big because it is where the cuts and the candidates accumulate, and
  looked for by _position_ rather than by reading down the deck. **Nothing sorts the rail**: the
  Sideboard sits above the Maybeboard because that is the reader's own `sortOrder` (the seed's
  order), and a reader who reorders their categories gets the order they chose. It carries
  `RAIL_ATTR` (`data-deck-rail`) and nothing else — `STACK_ATTR` (`data-deck-stack`) means "a pile
  drawn in the flow", and the rail's piles are by construction the ones that never reach it, so a
  sweep that counts the deck's own piles must not find them; the name is unprefixed because
  `TextView` draws the same rail, and it
  is spelled for the _rail_ rather than for the Sideboard because the Sideboard is no longer the
  only thing in it. It is rendered only when a `side` group, a `maybe` group **or a switched-off
  pile** exists, which is a real
  condition for a story or a test and **not** one for the app: `schema::PREDEFINED_CATEGORIES`
  seeds both into every deck, an empty category group is drawn for each (neither of them is one of
  the two conditional zones, and the seed writes both `origin: 'user'` — see `grouping.ts`'s
  `drawsWhenEmpty`), and a predefined pile cannot be deleted — so in `category` mode the rail is
  there from the moment a deck is created. **The cost
  is `stackColumnWidth(zoom)` beside the flow** — 224px at 1× and 434px at 2×, both derived from
  that one function — which at 2× is a third of a 1280px window standing beside two piles that on a
  new deck hold nothing at all; below one column plus the rail it takes its own line instead, which
  is the wrap in the entry further down. **Those widths are unchanged by the Maybeboard joining**:
  the two piles share one rail one column wide, so the second costs height and nothing else, and
  the height is the one thing here that has not been driven in the window.
- **The switch is `splitRail`'s second test, and the kind is tested first** (added 2026-08-17).
  Every pile the reader has switched off joins the rail underneath the two played beside the deck;
  switching one back on returns it to the flow at its own `sortOrder`, because the split is derived
  on every render and nothing records where a pile was drawn last. `is_active = 0` means the pile
  counts toward nothing — not size, not copy limits, not legality — so it is not part of the deck
  being laid out, and a column of desk spent on it was a column spent on cards the reader had said
  were out. **Testing the kind first is what keeps the rail's head still**: the Maybeboard is seeded
  switched off, so a switch-first split would sink it under whatever the reader turned off last.
  **It cost neither view a line of drawing code and it draws no divider** — a switched-off pile
  already carries the section wash, the dimmed heading, the `INACTIVE` chip and the stack's
  `opacity-60`, and the pile heading the rail is switched off too, so a rule under it would mark a
  boundary that is not the one it looks like. The width is unchanged for the Maybeboard's reason:
  the rail is one column wide however many piles are in it, and each one costs height.
- **The command zones are a third box, at the head of the flow, and the two of them stack inside
  it** (2026-08-20). A commander is not a card in the curve; it is the card the curve was built
  _around_, played from a zone of its own before the deck is drawn from, and a companion is that
  same claim made from outside the deck. So `buildGroups` stopped bucketing either under
  `Group by mana value` and `Group by type` — each pile is drawn whole — and in **all three**
  grouping modes it puts the active ones **first**, commander then companion, whatever `sortOrder`
  says. That much is a domain rule and it is written out in
  [`features/decks/CLAUDE.md`](../../src/features/decks/CLAUDE.md); what belongs here is the box
  they are drawn in and the five things that fall out of it.
  - **They are still not railed, and the old reason is intact.** One card each, by construction, so
    a column's width spent on either is spent permanently, in every deck, on a pile that is read at
    a glance. What changed is the other end of that sentence: these two are what the rest of the
    deck is read _against_, so they sit in front of it rather than among the piles that make it up.
  - **One grid item for the two of them, because the flow is a masonry.** Drawn as two items they
    are two one-card piles, and a masonry fills across the line before it walks down the page — so
    commander and companion would sit **side by side** at the top of the desk and read as two more
    of the deck's columns, which is exactly the thing the head run exists to stop them looking
    like. The reader's call is that they stack, companion under commander, the way the rail stacks
    its piles. So they share a single flow item: a `flex-col` box marked `COMMAND_ATTR`
    (`data-deck-command`).
  - **Inside that box the arrangement is the rail's** — the same `flex flex-col gap-5`, the box
    carrying the width, each pile a plain block with **no `flowWidth`**. What differs is only how
    the box itself is placed: a grid item with a `grid-row` span here against an `ml-auto` flex
    child with a `flex` basis there. Three consequences come with that missing prop rather than
    being decided again. The piles carry no `STACK_ATTR`, so every sweep
    that counts the deck's own piles goes on counting the deck's. They take no `grid-row` span,
    because the box is the grid item and the box is what the masonry measures and spans. And they
    draw no category-reorder grip, which is now right rather than incidental: the zone's position
    is the rule's and not the reader's, so there is nothing there to drag. **The drop target is
    untouched** — what is fixed is the zone's _place_, not the pile, and a card can still be
    dragged into either.
  - **`TextView` gets the same picture with no third box at all.** `packColumns` is greedy and in
    the reader's order, which _is_ a stack, so packing `[...command, ...flow]` puts the commander at
    the top of the first column with the companion directly under it and the deck beginning below
    them. A box there would be a second mechanism for an arrangement the pack already produces, and
    the two would part company the first time one of them was adjusted.
  - **`TableView` and `GridView` never called `splitRail`** — they draw `groups` in the order they
    are handed — so for those two the whole of this change is that the command zones come first.
  - **The stats band did not change, and it is the thing a reader will assume did.** `DeckStats`
    derives the curve, the average mana value and the type bars from the deck's rows itself and has
    never called `buildGroups`, so a four-drop commander still stands in the `4` bar beside a desk
    that has stopped filing it there. The reasoning, and why that is not the two-surfaces-disagree
    failure the `Split X` entries name, is in
    [`features/decks/CLAUDE.md`](../../src/features/decks/CLAUDE.md).
  - **None of this has been driven in the window, and nothing in this entry is a measurement.** The
    box is one grid item, so it takes one track of the `auto-fill` grid the way any pile does, and
    the rail widths and gutters quoted above are untouched by it — but what a head box costs a
    small deck's first line, and how the masonry closes up around it, are live questions nobody has
    asked yet.
- **Driven in the shipped window 2026-08-17** (`npm run tauri dev`, a **debug** build, 1280×800,
  against a real synced corpus — a 14-card Commander deck of nine categories). Every figure is a
  `getBoundingClientRect` off the running window. **Two of the numbers below are the capped
  build's and are no longer what this app draws** (the cap was deleted 2026-08-18): the rail's
  16px gutter and the 1184px flowing box. Everything about _which pile is where_ — the split, the
  order, the masonry closing up — is unaffected, which is what this pass was for.
  **One more thing here is the pre-2026-08-20 build's, and it is a pile rather than a number**:
  this deck's `Commander` was an ordinary flowing pile on the day, which is what let it be first in
  the flow and, switched off, third in the rail. It is drawn in the head box now, so the flow lists
  below start at `Instant` and the switching-back-on reading returns it to that box rather than to
  the head of the flow. **The switched-off readings are exactly what they were** — the head run is
  active piles only, so a command zone the reader has turned off still falls through to the rail's
  own tests, which is the one thing this pass proved that no arithmetic in the suite substitutes
  for.
  - **Before**: flow `Commander, Instant, Artifact, Creature, Test` at x **234 / 474 / 714**, the
    last two wrapping to a second line at y **699** and **767**; rail at x **954**, 224 wide, 480
    tall. The last flow column ends at 938, so the gutter is exactly **16** — `flowMaxWidth` holding.
  - **Switching `Creature` off** moved it out of the flow and into the rail as its **third** pile
    (y 795, under Sideboard at 295 and Maybeboard at 392), and **the flow closed up**: `Test` took
    the vacated masonry slot at 234,699 — it had been at 474,767. The rail grew 480 → **986**, past
    the 800px window, which the editor's page scroller takes; the rail's x did not move.
  - **The kind-before-switch order was exercised where it can actually fail.** Switching `Commander`
    off — position **1 of 9**, the lowest `sortOrder` in the deck — put it **third** in the rail:
    `Sideboard, Maybeboard, Commander, Creature`. A switch-first split would have headed the rail
    with it. This is the one reading no arithmetic in the suite substitutes for.
  - **Switching both back on returned them to the flow in their own order** —
    `Commander, Instant, Artifact, Creature, Test`, Commander back at the head — and the rail back
    to two piles with **one** `INACTIVE` chip on screen. Nothing remembers a pile was railed.
  - **The wide-desk arm came free**, because the window was resized to **2560** mid-pass: five piles
    on one line, the flowing box capped at **1184px** (= 5 × 240 − 16, `flowMaxWidth`'s deck term
    rather than the desk's), rail at 1434, and `documentElement.scrollWidth` **2560** against a
    `clientWidth` of **2560** — no horizontal page scrollbar, which is what the 1024px floor forbids.
  - **Not driven**: an entirely switched-off deck (an empty flow beside a rail holding the lot), and
    a switched-off pile under a derived grouping — that one is `views.test.tsx`'s and the
    Maybeboard's ordinary path.
- **Driven in the shipped window 2026-08-18** (`npm run tauri dev`, a **debug** build, against a
  real synced corpus — a 14-card Commander deck of five flowing piles and the two railed ones),
  for the reversal above: the cap deleted, `ml-auto` back on both rails. Every figure is a
  `getBoundingClientRect` off the running window, with `innerWidth` read in the same expression
  as the rect (the window can be resized under a pass, and a wide desk reads exactly like an
  overflow).
  - **Beside the deck, at 1280×800 and 1× zoom.** The view root spans 228 → **1193** and carries
    `DROP_MARK_ROOM`'s 6px, so its content edge is 1187 — and the rail's right edge is **1187**,
    flush. Flow 234 → 947 (**713** wide = 965 − 12 padding − 224 rail − 16 gap) with **no**
    `max-width` in the style attribute. Three columns at x **234 / 474 / 714**, 224 wide, so every
    gutter between two piles is **16** and the deck's own rhythm is untouched. The leftover shows
    up where the change puts it: the last column ends at 938 and the rail starts at 963, a
    **25px** gap where two piles are 16 apart.
  - **It moves with the zoom, which is the accepted price.** Three ctrl+wheel steps up (column
    **329**) left the rail's right edge at **1187** and the flow at 608 — one column, since
    329 + 16 + 329 = 674 does not fit — so the gap between the deck and the rail was **295**. The
    rail did not move; the deck did.
  - **The wrapped line is where `ml-auto` actually acts**, and it was reached at five steps up
    (column **434**) in a 1024px window: the rail took its own line at y **4519** under a flow at
    y 339, and its right edge was **931** — the flow's own right edge — rather than x 234 under
    the first column, which is where the day without the margin left it. `scrollWidth` **1024**
    against a `clientWidth` of 1024: no horizontal page scrollbar, which the 1024px floor forbids.
  - **`TextView` agrees**, measured on a 2560px desk: rail right edge **2467** against a root
    content edge of 2467, `ml-auto flex flex-col gap-4` on the box, and the flowing half **1909**
    wide with no `max-width` — one 300px column in it and the rest blank desk before the rail.
- **Which piles are drawn, driven 2026-08-14 — in Storybook over CDP (headless Edge), _not_ the
  shipped window.** Against `.storybook/fake`, reading each group's accessible name off
  `section[aria-labelledby]`: the Modern deck drew `Main deck, Sideboard, Maybeboard` with **no
  Commander and no Companion**, and the rail held `["Sideboard", "Maybeboard"]` in that order. A
  freshly created **Commander**-format deck drew `Commander, Sideboard, Maybeboard` — the command
  zone empty, the companion slot still absent in a format that allows one. Creating a category
  through the Categories drawer put an empty `Ramp` on the desk immediately, in `sortOrder` between
  `Main deck` and the rail, which is the reversal itself: under the rule before that one it was
  invisible from the moment it was made. **That reading has since gained a second subject and still
  holds**: the drawer writes `origin: 'user'`, so what it shows is a reader's pile drawing under a
  name the app also files by — the case a name test would have got wrong.
  **The filter reading describes a rule that no longer exists.** Typing `bolt` removed `Ramp` and
  left `Main deck, Sideboard, Maybeboard` — `EmptyGroupRules.narrowed`, cut to the fixed zones —
  and that flag has been deleted: a filter decides nothing about which headings exist, so the same
  press leaves that `Ramp` drawing today. Nothing here has been re-driven. **No number here is a
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
  correct rather than a shortcut.** A section's _box_ does not move when the zoom steps — only its
  contents resize — so the pre-commit rect is already the right answer, and the badge's first
  painted frame is in the right corner. An effect would cost a frame with the badge somewhere else,
  on a surface that is only up for `ZOOM_QUIET_MS` in the first place. The anchor is set beside
  `shownFor` in the same during-render adjustment the indicator already used for its pulse, which is
  React's own answer for state derived from something that changed and this project's — see
  `lib/useDelayedFlag.ts`.
- **The anchor and the split are measured in the shipped window — 2026-08-14,
  `npm run tauri build -- --debug --no-bundle`, a debug build at 1280×800**, driven over
  `scripts/cdp.mjs` against the real corpus. (Two things in this group were _not_ driven; the last
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
  is anchored and is checking nothing, and it would have gone red against the _fix_. The general
  trap, for whoever writes the next one: **a stated-viewport test proves only that the code agrees
  with the number the test stated**, so state a width that is not the expression under test, or
  accept that the question is a live one. Anything else positioned `fixed` from a measured rect
  owes the same distinction.
- **What was _not_ driven here, stated plainly.** The gesture was dispatched as a **synthetic**
  `WheelEvent` with `ctrlKey` on a card and left to bubble to the section root. That exercises the
  listener, the store and the whole render path — `dispatchEvent` returned `false`, so something did
  call `preventDefault` — but a synthetic event is not a trusted input event, so **the
  `preventDefault`/WebView2 page-zoom suppression below was not re-driven on this branch**; it is
  unchanged from before it and rests on its own earlier evidence. Storybook was never started for
  this branch either, so no story here has been previewed.
- **The wheel listener is a native `addEventListener` with `{ passive: false }`, never React's
  `onWheel`.** React registers `wheel` as passive on the root container, and a passive listener's
  `preventDefault()` is defined to do nothing — so the zoom would step _and_ WebView2 would apply
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
  **A body's scroller only works if the panel above it is clamped, and for two days it was not**
  (2026-08-18). The panel's `max-h-full` is a percentage against its _grid area_, and the scrim's
  `grid place-items-center` gave it an **implicit** row — which is `auto`, and an `auto` row sizes
  to its own content, so the clamp was circular and clamped nothing. Measured in a headless
  browser at a 708px viewport with a 140-line export: the panel drew **2963px**, the body's
  `overflow-y-auto` never scrolled because it had every pixel it asked for, and the dialog's
  buttons sat at y≈2930 — off the window, reachable by neither pointer nor wheel. The scrim now
  names one explicit `grid-rows-[minmax(0,1fr)]` row; the same panel draws **660px**, the preview
  scrolls its own 2754px, and the buttons are on screen. `minmax(0,` is load-bearing: a bare `1fr`
  is `minmax(auto, 1fr)`, whose `auto` floor is the content again. It reached every dialog on the
  shell and was reported against one of them, and **jsdom can see none of it** — no layout engine,
  every box 0px — so the suite pins the two classes and the numbers come from a browser.

  **A dialog's tallest block opens shut when it is not what the reader came for** (2026-08-18),
  which is `DeckSearchPanel`'s collapsed default one rung down. `ExportDialog`'s decklist preview
  is a disclosure starting closed: the presses that do the work are Copy and Save as…, and a
  whole-deck export put both of them a screenful of text away from the format that chose them.
  Shut, the dialog is the format row, whatever that format leaves out, the toggle and the
  buttons. The toggle's own label carries the line count, so "nothing is showing" is never
  mistaken for "nothing is there" — and the block is **unmounted** rather than hidden, because a
  hidden `<pre>` still holding the text is the shape that lets a test assert a line no reader can
  see.
  **The argument is width, and it is the desk row's own number.** At the app's own 1280×800 with
  the card pane docked that row measures **602px** (`DeckEditor`'s `DECK_FLOOR`), so the 384px
  search panel plus its 16px gap leave the deck **202px** — one stack column. A drawer that is
  merely _consulted_ took its width out of the deck for as long as it was up and gave the deck
  nothing back; centred over a scrim, the deck keeps the whole desk underneath it.
  **The card search column stays docked, and that is the other half of the rule.** It is the one
  surface here that is worked _out of_: its tiles are drag sources into the deck's own category
  columns beside it, so a scrim would end the drag path and cover the card pane a reader flips
  printings in. What changed for it is its default — `DeckSearchPanel` opens **collapsed** now,
  because the same 602/384/202 arithmetic says an open-by-default panel charged every reader one
  stack column on every deck they opened whether or not they were adding cards. Collapsed, the
  deck starts with the whole desk and one press on the rail gets the wall back. The choice is the
  component's own `useState` and deliberately not a `useAppStore` field: it is per editor-open and
  not remembered, on the same line `searchView`/`collectionView` sit the other side of
  — those are session-wide answers about the _app_. (`cardZoom` was named in that group until
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
  that floor was written for how the desk row is _divided_ and never for what the pack does
  inside the view's share of it. It has only ever moved away from holding one: 224 → 208 → 192,
  each drop a scrollbar the row's arithmetic had not counted. The fix is `flex-wrap` on the packed row: the column that will not fit goes below the line
  and the reader scrolls **down**, which every deck view already does. `packColumns` is
  untouched by it — the wrap is a property of the box the columns are laid in, not of how they
  were filled — and an `overflow` on that axis stays, since one column zoomed past the desk's own
  width genuinely is wider than its box and clipping a card is worse than a scrollbar the reader
  asked for. Wrapping is what makes that the rare case. (It was `overflow-auto` at the time and
  is `overflow-x-auto` since the deck-builder entry two bullets down, which took the _vertical_
  scrollbar out of these views entirely; the horizontal reasoning here is what survived.)
- **Wrapping fixed the direction and not the filling, and `StackView` gave up packing the same
  day.** The bullet above is about a run that went sideways; what it left standing is that
  `packColumns` fills to a **height** while the desk's scarce axis is **width**. The two are
  independent, so the number of columns tracked the _window's height_: at 1280×800 a six-pile
  Commander deck packed to roughly the six the desk had room for and looked correct, and on a tall
  screen the same deck packed to **three** — three full-height columns with the right half of the
  desk blank. The reader who reported it had found it by browser zoom, since zooming out is
  another way to buy CSS pixels of height, and it read as "it works if you zoom in enough". A pack
  cannot answer this: the column count would have to come from the width, at which point the
  columns _are_ the wrap. So `StackView`'s flowing half is a plain `flex flex-wrap` of one
  `stackColumnWidth(zoom)` box per pile (`gap-x-4 gap-y-5`, the two gaps the packed layout already
  used between and within columns), in `splitRail`'s order, and the desk's height reaches the
  layout nowhere — `columnHeight`, `DEFAULT_COLUMN_HEIGHT` and the view's `groupHeight` are all
  gone. **`TextView` kept the pack**, because a decklist line is 21px and a column of thirty of
  them is the point of that view, where a 300px card makes a stack column hold two piles at most.
  The cost was a **ragged foot**: a wrapped line is as tall as its tallest pile, so short piles
  beside a long one left space the pack would have used. Taken deliberately at the time — reading
  order is now left-to-right in `sortOrder`, and unspent width was the complaint — and **paid off
  the next day** by the bullet below, which keeps the reading order and stops paying for it.
- **A flex line is as tall as its tallest pile, and that was the same bug a third time** (2026-08-15).
  The pack spent the desk's height and left its width; wrapping spent the width and left a band of
  blank desk under every short pile the height of the long one beside it. A deck's piles are not
  the same size and are not meant to be — the creature pile _is_ the deck and the rest are two or
  three cards apiece — so a forty-card stack set the height of a whole line, and the reader was
  looking at the empty half of it. `StackView`'s flowing half is a **masonry** now:
  `display: grid`, `grid-template-columns: repeat(auto-fill, stackColumnWidth(zoom))`,
  `grid-auto-rows: 1px`, and each pile placed by `grid-row: span <its own measured height + 20>`
  (`flowRowSpan`). With every row a pixel, grid's ordinary row-major placement _is_ a masonry: it
  fills the first free cell at or after the cursor and never walks back up the page, so a wrapped
  pile starts at the foot of the pile above it and the reader's `sortOrder` still reads down the
  page. Four things follow, and each is the reason for a line of code.
  - **The column count is still CSS's**, `auto-fill` off a definite track width, so nothing here
    measures the desk and the rule in the bullet below survives whole.
  - **What is measured is each pile, not the box they are in** — a `useLayoutEffect` read on every
    render (before paint, so the first frame is right) plus a `ResizeObserver` per pile for the
    changes no render causes, a heading wrapping as the search panel is dragged wider being the
    one that matters. A pile's height cannot be computed from its cards: `stackHeight(n, zoom)` is
    exact for the stack, but the heading above it wraps or does not.
  - **`items-start` is what makes the measurement safe.** A grid item aligned to the start of its
    area is content-sized, so its height does not depend on the span it was given; stretch it — the
    default — and measure → span → measure oscillates.
  - **The vertical gutter cannot be a `row-gap`.** A grid gap is drawn at every row boundary an
    item crosses, so a `gap-y-5` on a grid of one-pixel rows would draw one 20px gutter per pixel
    of every pile's height. The 20 is added to each pile's own span instead, which puts it once
    under each pile; the visible cost is one trailing gutter at the foot of each column.
    `gap-x-4`, the horizontal one, is unchanged and is still what the rail is spaced by.

  **Driven in Storybook over CDP, 2026-08-15 — and _not_ in the shipped window**, which is the
  carve-out to read first: the `app` lock was held by another worktree for the whole session
  (roughly eight agents shipping deck-builder work at once), so every figure below is a headless
  Chromium at a story's own viewport rather than the app's. What that cannot answer is anything
  about the desk's real width, the docked search panel beside it, or the editor's page scroller.
  What it does answer is the mechanism, which is where the risk was.
  **A second carve-out was added on 2026-08-20 and it is about the fixture rather than the
  harness**: `UnevenPiles`' `Commander` is a `commander`-kind category, so it is drawn in the
  command box at the head of the flow now and is no longer one of the flow's own items. The item
  count and the span array below are that build's — the box is a grid item like any other and the
  placement the pass was for is a property of the grid, so what it proved is untouched, but a
  re-run of the same story will not count six.
  - **The declaration arrives intact.** The flowing box computed
    `grid-template-columns: repeat(auto-fill, 224px)`, `grid-auto-rows: 1px`, class
    `grid flex-1 items-start gap-x-4`, and its six piles carried spans
    `[404, 642, 404, 404, 404, 404]` — a one-card pile measures **384px** and an eight-card pile
    **621.5px**, each plus the 20px gutter, `Math.ceil` doing the .5.
  - **The placement is the masonry.** At a 736px desk (three tracks) the `UnevenPiles` story drew
    Commander, Creatures (eight cards) and Ramp across the first line, then **Removal directly
    under Commander and Card draw directly under Ramp** — both starting while the eight-card stack
    was still running down the middle — and Lands under Creatures.
  - **The bug reproduced, in the same page.** Backing the change out through `element.style`
    (`display: flex; flex-wrap: wrap; row-gap: 20px` on the box, spans cleared and
    `flex: 0 0 224px` restored on the piles) moved all three wrapped piles down to the foot of the
    eight-card stack, leaving the blank band under Commander and Ramp that this was reported as.
  - **An open card costs no reflow.** With a card lifted in the eight-card pile the section still
    measured **621.5px** and still spanned **642** — `stackHeight(n, zoom)` is fixed and the lift
    pushes the tail _out_ of a box whose height does not move, so nothing re-measures and nothing
    below it shifts. The tail paints over the pile beneath exactly as it did under the flex flow.
  - **The win is distribution, not height, and this fixture says so honestly.** Six piles over
    three columns is two per column either way, so both layouts came to the same **1026px** of
    flow. The height is only won where a column holds more than two; what is won at every size is
    that the space is under the _last_ pile instead of in a band across the middle of the desk.

- **A pinned rail wraps below the flow rather than pushing it sideways, and CSS is what decides
  — never a `ResizeObserver`.** The Sideboard and the Maybeboard were the pack's worst case.
  `packColumns` is greedy and in the reader's own order (never reordering, never splitting a
  group), so a category like any other lands wherever the run puts it, and the two piles a reader
  most often wants beside the deck sat at the far end of a long sideways run, off screen.
  `splitRail` takes the `side` and `maybe` groups out before the pack runs and draws them as one
  column pinned right; the pack keeps its whole contract and is handed fewer groups. (Since
  2026-08-20 the split also takes the active command zones out, and `TextView` packs
  `[...command, ...flow]` — the flowing groups it was already handed, with the command run put back
  in front of them. It keeps its contract there too, and being a greedy in-order pack is what
  makes the commander and the companion a stacked column of their own: see the command-zone entry
  above for why the stack view needs a box to get the same picture and this view does not.) Whether there
  is room for that rail is decided by
  the flowing area's `minWidth` of one column plus the outer container's own `flex-wrap`: while
  the desk holds two columns and the gap between them the rail sits beside the flow, and below
  that width it wraps onto its own line — at the **right** of that line, which is where `ml-auto`
  put it until 2026-08-17, where the day without that margin left it (the left, under the first
  column), and where it is again since 2026-08-18. **`content-start`
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
  An observer could, and is refused: **a view has no business observing its own box** — a rule that
  outlived the `DEFAULT_COLUMN_HEIGHT` whose doc used to carry it, and that `StackView` still holds
  in both axes: the masonry above observes each **pile**, and nothing in either view reads the desk
  it is drawn in — and a second reading of the same box answers a frame behind the
  layout it is reacting to, which at exactly this threshold is one frame of the scrollbar the whole
  change exists to remove. **Driven in the shipped window 2026-08-14** (`npm run tauri dev`, a **debug** build,
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
    scroller's own edge. **Superseded 2026-08-17 and restored 2026-08-18** — the margin was gone
    for a day, and a wrapped rail landed at the left under the first column in that build only.
    The reading describes what the current build does again; it has not been re-driven since.
  - **The sticky machinery really is gone** — the rail computes `position: static`,
    `box-shadow: none`, `z-index: auto` and a transparent background — and **`content-start`
    is on the box that has a height**: the view root computes `align-content: flex-start`.
  - **The one case that can still scroll sideways behaves better than this entry claimed.**
    At 2× in a 1024px window a single 434px column does not fit the 331px view, and the
    overflow is **103px inside the deck view** — `document.body` never moved. The app does not
    slide under the reader; one panel scrolls, which is the failure the popup rule above
    forbids only for the _page_.
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
    rail's _height_ and, by one group, what is left to flow: the **5888px** scroll and the
    **13-column** deck were read with the Maybeboard still packed among the twelve named piles.
    Read those two as facts about that run rather than about today's layout.
  - **It predates `deck_categories.origin` as well, and that caveat runs the same way.** Every
    empty pile drew on the day of the pass; `drawsWhenEmpty` now leaves an empty `auto` one out,
    which can only take headings off a deck and never add one — so the **5888px** and the
    **13 columns** are a ceiling for that seeded deck rather than a reading of it today. Nothing
    has been re-driven. The widths and both thresholds are untouched either way: they are
    arithmetic about one column, and a column is the same width whoever made the pile in it.
- **Wrapping down is only half an answer while the box it wraps inside has a height: the deck
  builder scrolled _inside itself_, and the fix was to stop giving the views one** (found and
  fixed 2026-08-14, driven at `npm run tauri dev`, a **debug** build, at 1280×800 and 1024×600).
  The two entries above take a run that went sideways and turn it into a run that goes down —
  which is right, and leaves the reader looking at a wall of cards in a letterbox: the view was
  a `flex-1` item of a `min-h-0` desk with `overflow-auto` on it, so the piles wrapped down
  inside a box exactly as tall as the desk, and the editor's own page scrollbar sat beside that
  box's. Two scrollbars an inch apart, moving different things, with nothing on screen saying
  which a wheel was about to turn. **Three of the four views are given no height at all now** —
  stacks, grid and text grow to hold their content, the desk row grows with them, and the page
  scroller (which has been there since the stats became a band) is the one thing in the editor
  that scrolls.
  - **Measured on a seeded 132-card, 17-pile Commander deck at 1280×800.** Stacks: the view
    box **7 123px** with `scrollHeight - clientHeight` of **0**, in a page of **702** visible
    against **7 635** of content. Grid **4 270**, text **1 765** (which packs to a fixed
    readable target and wraps, so it is the shortest of the three), all three with **0** internal
    scroll. `page.scrollWidth - clientWidth`, `main`'s and the document's were **0** at every
    reading — the sideways rule the entries above establish is untouched.
  - **The table is the exception and it is a difference in kind.** `VirtualTable` mounts the rows
    in view and holds a spacer open for the rest, so a scrollport is what it _is_; given no height
    it was measured at **2 781px** with its own scroller _and_ the page's — the two-scrollbar
    screen this change exists to remove, arriving by the opposite route. It keeps the bounded desk
    row: **384** with **2 397** of scroll inside it and **194** of page, which is exactly what it
    read before.
  - **`min-h-96` on the desk row was silently capping the whole thing, and only the live pass
    could show it.** A flex item's automatic minimum size is what stops it being squeezed below
    its content, and a `min-height` _number_ replaces that `auto`. With the class still on the
    row, the deck drew **2 783px** of piles in a desk box of **384** — the piles paint and the
    page counted them, so it looked correct, while the price strip and the stats band were laid
    out from the foot of the 384 (over the deck, not under it) and `position: sticky` clamped the
    search panel to a 384px containing block. Moved one level in, onto the view box, it floors
    without capping: the row then read **2 783** and the strip and band came back under the deck.
    **jsdom cannot referee this** — it has no layout engine, so every box is 0 and the whole
    class of defect is invisible to the suite.
  - **The search panel is pinned rather than stretched, and its height is measured because CSS
    cannot answer it.** A sibling of a 7 000px row would be drawn 7 000px tall, scrolling its own
    search field away and mounting tiles nobody can see; `100%` is the deck's height and a
    viewport unit is wrong by the app chrome above the scroller. So `sticky top-0 self-start`
    plus a height of _the scroller's visible height less however much of the desk still sits
    below its top_, recomputed on scroll behind a rAF. Read at six scroll positions on the
    7 635px page: **489px** tall at rest (the window under the header), **589** at scrollTop 100,
    **702** — the whole window — from 213 on, with the panel's bottom edge flush to the
    scrollport's (`0px`) at every one of them, and its own wall never scrolling the page.
  - **The remove tray goes `sticky bottom-0` for the length of a drag**, because the price strip
    it is drawn on is now at the foot of however tall the deck is. Probed mid-flight on a
    7 601px page with the reader at the top: the strip's bottom flush with the scrollport's
    (`0px`), the tray reading `Remove from deck` at **673px** of a **702px** window, **29px**
    tall, and `document.elementFromPoint` at its centre landing **on the tray** — so a drop aimed
    there reaches it rather than the pile painted underneath.
  - **The one horizontal case the entries above reserve still behaves, and is still contained.**
    `overflow-x-auto` replaces `overflow-auto` on all three views: it implies `overflow-y: auto`,
    which **was claimed here to have nothing it could ever scroll** — see the 2026-08-20 entry
    below, which is the day that turned out to be false in both of its clauses. At 1280×800 and
    2× zoom the rail simply wraps and nothing overflows either axis; at **1024×600** and 2×, a
    448px column in a 346px view overflowed by **88px** — inside the view, with the page, `main`
    and the document all at **0**.
- **The second scrollbar survived that pass in the one state it never measured — a card open —
  and `StackView` now reserves the room instead of scrolling it** (found and fixed 2026-08-20,
  driven at `npm run tauri dev`, a **debug** build, at 1400×1300 and 1280×800). Every reading
  above was taken with the deck at rest, and the implied rule — "a box with no height of its own
  is never taller than its own content" — is wrong twice:
  - **The box does get a height of its own.** `StackView`'s root is `h-full` off a desk row that
    is `flex-1` in the editor's column, so whenever the window is taller than the deck the row is
    sized by flex rather than by content and hands the view a **definite** height. Measured on a
    15-card pile beside three 1-card piles at 1400×1300: content **894px** in a root of
    **1081** — 187px of slack, and a definite box is one that can be overflowed.
  - **And the content does outgrow it.** A pile's list keeps a fixed height with
    `overflow-visible` (`CardStack`), so an open card pushes the cards after it `stackLiftRoom` =
    `stackCardHeight − stackAdvance` = **285px at 1×** clean out of that box, on purpose. Under
    the tallest column there is nothing to absorb it. With one card open the root read
    `clientHeight` **1081** against `scrollHeight` **1144** and painted a **15px** bar beside the
    editor's page scroller — the two-scrollbar screen this whole section exists to remove, back
    by a third route.
  - **A long pile among short ones is the shape that finds it**, which is how it was reported: the
    long pile is what sets the box's height, so it is the one with nothing underneath to land in.
  - **The other half of the case grew instead of scrolling, which is no better.** A deck _taller_
    than the window is content-sized rather than stretched (the row's automatic minimum size
    floors it), so the same open card had the desk row jump **1914 → 2318px** — 404px of page
    appearing and vanishing under the reader's pointer, at 1280×800 on a 51-card deck.
  - **The fix is one card's worth of lift reserved at the view's foot, always** — `padding-bottom`
    of `8 + stackLiftRoom(zoom)`, 293px at 1× and 322px at the next stop up, gated on the deck
    holding a pile of more than one card so a freshly created deck reserves nothing. Reserved
    rather than grown-on-hover for `stackHeight`'s own reason: a box that resizes under the
    pointer walks the page away from what the reader is pointing at. After: **1179/1179** with a
    card open at 1400×1300 and **2199/2199** at 1280×800, `0` bar in both, and the root's height
    identical at rest and open.
  - **jsdom cannot referee this either**, so the suite asserts the inline `padding-bottom` the
    view asks for rather than the scrollbar it prevents.
- **The X scrollbar that pass declared gone came back through the docked panel, and it was a
  filter row 25px too wide** (found and fixed 2026-08-14, driven on the reader's own deck at
  `npm run tauri dev`, a **debug** build). `ManaValueChips` draws its group as a plain
  `flex gap-1` of `size-9` chips: at nine numerals that is `9 × 36 + 8 × 4` = **356px** and it
  fitted; the **X chip** made it ten, `10 × 36 + 9 × 4` = **396px**, against the docked search
  panel's 384 (content box ~371). A flex item cannot shrink below its own min-content, so the
  group hung out of the panel — and `DeckEditor`'s section is `overflow-y-auto`, which computes
  `overflow-x` to **`auto`**, so it became a horizontal scrollbar across the whole deck builder.
  Measured: editor `scrollWidth` **1042** against `clientWidth` **1017** at 1280×800, and **2322**
  against **2297** at 2560×1400 — **25px at both**, because the panel's width never changes with
  the window, which is exactly why it read as permanent rather than as a narrow-window bug.
  `flex-wrap` on the group is the whole fix: its min-content becomes one chip, so it breaks onto
  a second line inside the panel and is unchanged in the two full-width filter bars, where it
  already fitted. After it, `scrollWidth === clientWidth` at both widths and the document had no
  sideways scroller at all. **The general rule this is an instance of**: a row of fixed-width
  controls is sized by the _narrowest_ surface that draws it, and in this app that is the 384px
  docked panel — never the filter bar it was designed in. Nothing goes red when a tenth chip is
  added, so `FilterChips.test.tsx` now holds the arithmetic beside the wrap.
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
  - **A pinned row stays pinned, outside the sort**: `Any card`, `Any format`, `Any set`, the
    disabled `Custom…` a table-header sort leaves behind, `Auto (by what it does)`, `Top level`.
    `CategoriesDialog`'s `are deleted with it` is pinned **last** — the destructive answer is
    not allowed to become the default by alphabet. (A seventh, the deck card's permanent `Move…`
    verb, went with that select on 2026-08-14.)
  - **The search's format select pins _two_ rows, and their order is a ladder rather than an
    alphabet** (2026-08-14): `Any card`, then `Any format`, then the sorted formats — widest to
    narrowest. `Any card` is what the `Unplayable` chip beside this select became; the bullet
    below this block says why the two controls became one.
  - **The exemptions are a test, and there is deliberately no list of them here** (changed
    2026-08-15). A list is exempt when its order **is** the information — a **grade scale**,
    card condition running Near Mint → Damaged, which alphabetised would open on "Damaged"; a
    printing's finishes, plain before the two premium treatments; a declared ladder such as the
    card menu's `Open on`, where sorting would move the row a reader has learnt the position of
    whenever they changed marketplace — or when the order is one **the reader arranged
    themselves**: a deck's categories are drag-sorted in `CategoriesDialog` and rendered in that
    order by all four deck views, so an alphabetical dropdown would disagree with the columns
    beside it, and a folder tree is the same argument. This bullet said "two, and they are the
    whole list" until the context menus landed and made it several within a day, which is why it
    states the rule instead. Every exemption carries a comment at its own site saying which of
    the two it is — that comment is the record, and it is what stops the next sweep for unsorted
    selects "fixing" them.
  - **The deck editor's `View` switch joined this block on 2026-08-15, from the other side.** It
    was a four-button segmented group (`role="group"`, `aria-label="Deck view"`, `aria-pressed`
    on the picked one) standing between two selects that ask the toolbar's other two questions,
    so the control a reader reaches for most was the one that looked unlike its neighbours. It is
    `VIEW_PICKER` now — `DeckEditor`'s `VIEWS` through `sortOptions`, reading
    `Grid · Stacks · Table · Text` — and **no exemption**: the array is written default-first,
    which is a fact about how it was typed rather than information the reader is owed.
    **Driven in the shipped window 2026-08-15** (`npm run tauri dev`, a debug build, 1280×800,
    on a 14-card Commander deck): the three selects computed `top: 182` and `height: 36` each —
    one line, no wrap — at **80px** (View), **105** (Group by) and **111** (Sort), with the
    toolbar's five clusters all on that line and `document.body.scrollWidth` **1265** against a
    `clientWidth` of **1265**, so the row that the 1024px floor forbids overflowing does not.
    The select carried `CONTROL`'s 12px type and its transition list, `filter-focus`'s gold
    outline (`oklch(0.75 0.12 85)`) on focus, and `role=group` was down to the two that are not
    this control. Each of the four rows drew its own view — `table` one `[role=table]` and 19
    rows with no card art, `text` nine lists and none, `grid` 14 pictures, `stacks` 14 pictures
    across five `[data-deck-stack]` piles — with no horizontal overflow in any of them, and the
    console recorder caught 16 entries and no error or warning. **The width the segmented group
    used was not measured before it was replaced**, so "about 100px back" is arithmetic off its
    four `px-3` buttons rather than a reading.

- **The search's `Unplayable` chip is a row of its format select now** (2026-08-14) — one control
  where there were two, `FilterBar.tsx` plus `useCardSearch.ts`'s `ANY_CARD` and `formatParams`.
  The chip sent `playableOnly: undefined` and the select sent a `legalities` key, and the two were
  moving one axis in opposite directions: `Any format` already means "legal in at least one of
  Scryfall's 23 formats", so the chip's only reachable effect was to widen _that_ row. Pressed
  with a format picked it did nothing at all — a card legal in Modern is legal somewhere — and
  the state it appeared to promise, "Modern **and** the art cards", is a filter contradicting
  itself. Three rows say the whole thing once, widest first: `Any card`, `Any format`, then one
  named format.
  - **The default did not move.** `Any format` is where the select opens and what the search has
    always sent (`playableOnly: true`), so no wall changed shape — see the search stories'
    43 → 41 → 38 → 33 arithmetic, which is unchanged.
  - **`playableOnly` rides with a named format too**, which is what makes the rows nest rather
    than overlap. It narrows nothing there, and sending it means one expression answers all three
    rows with no fourth combination to reach. `formatParams` is the only place that branch is
    written, and both the page's payload and the facet request spread it — two copies are how a
    wall of cards and the counts greying the chips beside it come to describe different corpora.
  - **Two behaviours reversed with the merge, both deliberately.** The row is now **counted by
    Reset all and cleared by it**; the chip was neither, on the argument that it said what there
    is to look _through_ rather than what to look for. That argument belonged to the chip, and a
    select the reset can only half-clear is worse than either. `allPrintings` keeps it and is
    the only control on the row that still does.
  - **`unfiltered` deliberately does _not_ count it**, which is the one place the two numbers
    disagree about the same value. That flag captions an empty wall — "waiting for the sync"
    against "your search missed" — and `Any card`'s result set is a **superset** of `Any format`'s,
    so an empty answer to it still proves the database is empty. `formatIsReaderSet` carries the
    arm.
  - **The sentinel is `"any-card"`, and the hyphen is the fence.** It shares a namespace with
    Scryfall's `legalities` keys and with `format_specs.key`, and neither has ever carried one —
    they are single lowercase words (`standardbrawl`, `paupercommander`, `oldschool`). Equality
    against the value is therefore enough, and no flag has to travel beside it.
  - **A `<select>` whose value matches no option now falls back to the _widest_ row.** React
    never assigns `select.value`; `react-dom` walks the options setting `selected` and on no match
    picks the first that is not disabled — which used to be `Any format` and is now `Any card`.
    That is the deck panel's seeded-format case (a Brawl or Oathbreaker key `FORMATS` does not
    carry), and it fails further than it did: the control would read "every card" over a filtered
    wall rather than merely the wrong filter. The hook seeding `formats` with the caller's key is
    still the whole fix.
  - **Neither pinned row carries a `title`, and the labels stay two words for a measured reason.**
    A `title` on an `<option>` is not drawn by Windows' native dropdown, so the sentence explaining
    that "any card" means art cards, tokens and emblems could only ever be read by a screen
    reader. And a `<select>` is as wide as its widest option, on a row that has to survive the
    deck editor's docked panel at its `MIN_PANEL_WIDTH_PX` floor of **206** — a self-explaining
    label would be paid for in that column at every width.

## The theory tick, and the four things a photograph settled

Added 2026-08-20 with `TheoryMatchMark` — the mark a deck card wears on the **Live** list when the
deck's plan asks for it too. The rule and the data are in
[`src/features/decks/CLAUDE.md`](../../src/features/decks/CLAUDE.md); this is what looking at it
changed, and every one of the four was a decision the suite could not have made.

**How it was looked at.** Both locks were held by other worktrees all afternoon, so this was the
lock-free path: a `file://` page linking the **built** `dist/assets/index-*.css`, with card art
out of the image cache, the components' own class strings pasted onto the markup, and
`msedge --headless=new --screenshot`. Before and after in one frame, and candidates side by side —
which is the whole reason it can settle a question a test cannot. **The shipped-window pass was
not run** and is still owed.

- **The fill is `--color-pie-u`, not `bg-accent`.** Gold was the obvious first choice — a chip on
  a card usually is — and in the frame it read as an *extension of the Game Changer banner*: two
  gold marks in one 27px strip meaning two unrelated things. `--color-ok`, the green the format
  check draws its clean-deck `CircleCheck` in, is legible and says the one sentence a tick must
  not ("nothing is wrong here"). The neutral count paint was no distinction at all — a grey chip
  at each end of the strip. Azure is none of those. It **is** one of the six tag colours, which is
  the accepted cost: the quantity tag at the other end draws a *number*, so the two are still told
  apart by content and position.
- **The slant is mirrored** — `COUNT_TAG_SLANT_MIRRORED`. `CountTag`'s cut takes its bite out of
  the edge *away* from the corner it is pinned to, which is what makes it read as a banner tucked
  into that corner. Reused unmirrored on the right, the bite lands against the card's own edge and
  leaves a notch. The mirrored pair read as bookends of the marks strip; the unmirrored one read
  as a mistake. Same idea `GameChangerBanner` already states about its forked tail.
- **The Grid tile gets a second drawing, not the same one.** One `CountTag` banner for both card
  faces was the first cut: 22px on a 210px stacked card is 7.5 % of it and the same 22px on a
  150px tile is **15 %**, so a wall of tiles read as a wall of blue flags with cards behind them.
  `variant="chip"` echoes the tile's own 9px copy count instead — which is the honest reading of
  "the same badge as the quantity" anyway, since the two views do not draw the same quantity badge.
- **The row views get no box.** `GameChangerBadge`'s outlined box around a **tick** is a
  **checkbox** — the one control every reader already knows — and a decklist of them reads as
  something to click. `GC` survives the box because it contains letters. So `TheoryMatchBadge` is
  the glyph alone, at `DeckFinishMark`'s 12px rather than `GC`'s 9px type.

**One thing the frame shows and nobody has decided:** at the bottom-left of a stacked card the
`RULE BREAK` mark lands **over the card's own printed set/collector/artist line**. `GridView` has
drawn it in that corner all along, so this is existing shipped behaviour rather than something the
move introduced — but the stacked card is 210px against a tile's 150 and covers proportionally
more of it. Worth a look if the illustrator-credit rule above is ever read strictly.

## The two marks a deck card carries: picked, and just landed

Added 2026-08-14. The rules and the routing live in
[`src/features/decks/CLAUDE.md`](../../src/features/decks/CLAUDE.md); this is the design argument
and what driving it found.

- **Picked is `ring-2 ring-accent`, which is `components/CardArt`'s `selected` recipe unchanged.**
  A deck card and a search tile answer the same question — _is the pane about this one_ — and the
  deck editor draws both walls at once, the desk and the docked search column. Two vocabularies
  eight inches apart is the failure to avoid, so there is one.
- **Landed is gold with a glow since 2026-08-15, and it was parchment before that.** The original
  argument was that gold is already spent four ways on this one surface — keyboard focus, the
  picked ring, and both halves of the drop affordance (`DROP_RING` / `DROP_OVER`) — with red the
  rule break's edge and green forbidden by the direction doc for anything that is not mana, so
  `--color-text` was what was left. It was right about the colour census and wrong about the
  outcome: parchment is the app's **text** colour, so the mark was the same value as most of what
  is already on screen, and a mark whose whole job is to be found across a deck the reader is not
  looking at was the quietest thing in front of them. The reader's report was that they could not
  see it.
- **What keeps the fourth gold apart from the other three is shape and place, not hue.** All three
  of the others are a **line around the outside** of a box — a ring on the card, a ring on the pile
  — and this is a **filled face**: washed, and lit from its own rim inward. A picked card wears a
  gold ring around an unwashed card; a card that has just landed is gold all the way through and
  wears no ring; a pile being dropped into is ringed while the cards in it are untouched. All three
  can be true of one card at one moment and still read as three facts.
- **The glow is an `inset` box-shadow, and that is a clipping fact rather than a preference.** The
  mark is drawn inside the card's face, which is `overflow-hidden` in `CardStack` — it is what
  clips the picture's corners. Anything painted outside the mark's border box (a plain
  `box-shadow`, a `drop-shadow()` filter) is clipped away in the stack view and drawn in the other
  three, which is one mark that looks like two depending on which view the reader left the deck in.
  An inset shadow is painted by the element inside its own box, survives every clip, and lands the
  light along the top edge — which is the 34px of itself a card in the middle of a pile shows.
  `inset 0 0 26px 4px`, blur far wider than the spread so the band falls off into the art instead
  of drawing a second border inside the first, in `color-mix(in oklab, var(--color-accent) 60%,
transparent)` because full-strength gold at that radius is a lamp.
- **It is drawn _inside_ the card's face, and that is the requirement rather than a detail.** The
  brief was "visible from the middle of a stack". A collapsed card shows only the 34px of its own
  printed title bar that its successor has not painted over, so a ring on the card's outer box has
  three of its four sides covered; a border on an `inset-0` overlay inside the face leaves a bright
  hairline across the top and 34px down each side, with the wash lighting the strip between them.
- **The wash is top-weighted, and both flat versions were tried and rejected in the same pass**
  (Storybook over CDP, headless Edge on 9333, 2026-08-14 — the `app` lock was held by another
  worktree). A flat `bg-text/15` was **invisible** in the reveal strip at a glance and only findable
  once the neighbouring card was moved away; a flat wash strong enough for the strip whites out an
  open card, which is 293px of it. The gradient answers both, and it is the same trade
  `CARD_MARKS_STRIP`'s own scrim makes one element away — which is the precedent for spending a
  gradient here at all, against the direction's "no gradients". **The percentages moved with the
  colour**: `from-text/35 to-text/10` became `from-accent/40 to-accent/12`, because gold sits at
  0.75 lightness against parchment's 0.93 and the same alpha puts less light on the card.
- **The border went from `border-text/70` to full `border-text` for the same reason**, and is
  `border-accent` now: at 70 % the hairline sat immediately inside the picked card's gold ring and
  the two blurred into one edge. That specific collision is gone — the two are the same gold today
  — and what tells them apart is the ring standing outside the card's edge with a washed, lit face
  inside it.
- **What that pass could not show is the mark over card art.** The Storybook fake draws no
  pictures, so every screenshot above is the app-drawn no-image frame — a flat dark card, which is
  the _worst_ case for a white wash and the best case for a white hairline. Over a real `grid`
  image the wash has more to lift and the hairline has a printed black border to sit on. **Not
  driven in the shipped window.**
- **The five seconds are in `src/index.css` (`--animate-card-landed`) and in `LANDED_MS`, and
  `cardControl.test.ts` compares them.** They are not in `src/lib/motion.ts` and must not be moved
  there: that module is a three-tier scale capped at 260ms and `motion.test.ts` fails any duration
  off it, correctly — everything in it is a _transition_, and this is a mark that decays. **It was
  ten until 2026-08-15 and was halved by the same change that made the mark gold**: ten seconds was
  buying a quiet mark the time it needed to be found, and a mark found at a glance does not need
  that time. Held at full for the first **two fifths**, then linear to nothing — the hold is the
  same **two seconds** it was at ten, because what it measures is the trip the reader's eye makes
  and not a fraction of the total, so what the halving spent is fade rather than hold (8s → 3s).

## The context menu, driven in the shipped window

**2026-08-15, `npm run tauri dev` (a debug build), 1280×800, against the real corpus — 116 710
cards, data from 2026-08-14.** Every figure below is a reading from that window, not from a test.

- **The two viewport widths differ by the scrollbar, and here is the pair.** The **Search** view
  reads `documentElement.clientWidth` **1280** and `window.innerWidth` **1280** — no page
  scrollbar, so nothing separates them and a surface measured only here would ship the bug. The
  **deck editor** reads `clientWidth` **1265** against `innerWidth` **1280**: the editor's page
  scroller takes 15px, and a `fixed` panel is laid out against the initial containing block, which
  excludes it. That is the whole of why `placeMenu` reads `clientWidth`. Both were read in the same
  `eval`, on the same window, seconds apart — **the only difference is which view was open.**
- **Nothing clips the panel, at either edge.** Search wall, pointer at (1101, 616) on the lowest
  fully visible tile: the panel drew `top 428 left 877 bottom 616 right 1101` — flipped on **both**
  axes, its bottom-right corner exactly on the pointer — `z-index: 30`, `position: fixed`, inside
  the viewport on both axes. Deck editor, pointer at (1163, 457) near the right edge: `837 → 1265`,
  its right edge flush with `clientWidth` and nothing beyond it.
- **A three-panel cascade at the right edge alternates sides, and that is the measured-width flip
  doing its job.** Root `x 837-1265`, "Add to" `x 618-842` (**left**, because the root already ends
  at the viewport edge), "Deck" `x 837-1061` (**right** again). All three inside the viewport;
  `documentElement.scrollWidth` stayed **1265** against a `clientWidth` of 1265 — **no horizontal
  scrollbar**, which is the one thing the 1024px floor forbids and a cascade is a new way to reach.
- **Escape closes exactly one layer per press, through the deepest stack driven.** With the card
  detail pane open and a submenu expanded: press 1 → `panels 2 → 1`, pane still open; press 2 →
  `panels 1 → 0`, pane still open, **caret on the deck card `<li>`**; press 3 → pane closed. Three
  presses, three layers, in order. A cascade on its own gave `3 → 2 → 1 → 0` and then handed the
  caret back to the `<li>`.
- **The caret hand-back is real in the window, not just in jsdom.** After every close measured
  above, `document.activeElement` was the opener — `LI` with `tabindex="-1"` — and never `<body>`.
  The `CardGrid` tiles carry `tabindex="-1"` on all 25, and the deck editor's 14 card `<li>`s carry
  it too.
- **A scroll closes the menu, hands the caret back, and does not undo the scroll.** Scroller set
  from `scrollTop 0` to **300**: `panels 0`, `activeElement` the `<li>` (`isBody=false`), and
  `scrollTop` still **300** afterwards. That second half is `focus({ preventScroll: true })` and
  **jsdom cannot express it at all** — jsdom 30.0.1's generated `focus()` takes no arguments and
  forwards none, so the option is dropped at runtime there and TS is the only thing that sees it.
  This is the measurement that closes it.
- **Both plugin grants work at runtime, which only a shipped window can answer.** `Copy card name`
  overwrote a sentinel with **`Abaddon the Despoiler`** (`clipboard-manager:allow-write-text`), and
  `Open on → Scryfall` raised **no** `role="alert"` (`opener`). A missing ACL entry fails here and
  nowhere else — not in a test, not in Storybook.
- **`Copy card image` answers a double-faced printing, which is the whole point of the fix.**
  Right-clicking SLD 2367 (Delver of Secrets, a `transform` card) copied
  `https://cards.scryfall.io/display/front/a/8/a808459c-…webp?1783904222`. The `/front/` segment is
  `face_image_uris[0]`; before the fix the command read only the top-level `image_uris` column, and
  **the sentinel would have survived untouched** — no error, no toast, ~4 300 printings affected.
- **Reduced motion is honoured, and the first reading was a false failure.** Emulated
  `prefers-reduced-motion: reduce`: `matchMedia(...).matches` **true**, panel `transform` **`none`**.
  Unemulated, same sampling point: `matches` **false**, `transform`
  **`matrix(0.961869, 0, 0, 0.961869, 0, 0)`**. The pair is the evidence; either alone is not.
  **The trap, which cost a reading:** an earlier attempt dispatched the right-click without first
  reading `matchMedia` in the same evaluation, and measured a scale matrix under emulation — motion
  had already begun the animation before the emulated query reached it. **Read the media query
  inside the same `eval` that opens the surface**, and report the emulated and unemulated numbers
  together.

**Two things this pass could not answer, stated rather than implied.** The submenu's
`ResizeObserver` re-placement was never forced: it needs a lazy body that grows enough to push a
downward-opening panel off the bottom, and this database has **five** decks, so the loaded panel is
170px and fits either way. And a browser process count is not proof that `openUrl` opened a tab —
Edge was already running; the honest signal is that the call raised no refusal.

## The second scrollbar nothing in the box tree accounted for

**2026-08-15, `npm run tauri dev` (a debug build), at 1280×800 and again at 1975×885, on a
24-card Standard deck.** Reported as "two scrollbars on the deck builder, and dead space at the
bottom of the app".

**What was on screen.** The deck editor drew its own page scrollbar, and the _window_ drew a
second one beside it. Scrolling that second one slid the whole application up and left the page
background under it — the "dead space", which is what an `h-screen` shell looks like in a document
that is taller than the window.

**What the numbers said, in the order they were taken.**

| read                                                      | before   | after |
| --------------------------------------------------------- | -------- | ----- |
| `documentElement.scrollHeight`                            | **1704** | 800   |
| `documentElement.clientHeight`                            | 800      | 800   |
| `window.innerWidth - documentElement.clientWidth`         | **15**   | **0** |
| `window.scrollTo(0, 5000)` → `scrollY`                    | **904**  | **0** |
| `body.scrollHeight`                                       | 800      | 800   |
| `#root > div` (`h-screen overflow-hidden`) `scrollHeight` | 800      | 800   |

**The third and fourth rows are the whole difficulty**: the document scrolled 904px while _every
box in the tree measured 800_, the shell's own `overflow-hidden` included. Hiding the shell took
`scrollHeight` to 800, so it was inside; forcing `overflow: hidden` onto the editor changed
**nothing**, so it was not the editor's content escaping the editor's clip.

**It was `.sr-only`, which is `position: absolute`.** An `overflow` clips a descendant only when
the scroller lies between that descendant and its **containing block** — and a label with no
positioned ancestor takes the _initial_ containing block, so it is laid out at its static position
(deep inside the scrolled column) and clipped by nothing at all. It then contributes that position
to the **document's** scrollable overflow. The deepest one was `DeckStats`' curve label
`"0 cards at mana value 8 or more"` at y **1703** — the 1704 above, exactly.

**The fix is one class, and it belongs on the box that carries the `overflow`.** `relative` on
`DeckEditor`'s page section: 1704 → 800, 15px → 0. `relative` on `AppShell`'s `main` **instead**
looks like the same repair and is not — the document came right (800) while `main.scrollHeight`
went **742 → 1646**, because the label is then contained by `main` but its static position is
still inside the editor's scrolled content. The phantom bar moved rather than went. The rule that
generalises: **a scroll container is the containing block for its own absolutely positioned
content.** `main` carries `relative` too, as the same rule applied to the outermost scroller —
three escapees were probed in it that day (two filter labels and a view heading, all with
`offsetParent` of `body`), harmless only because the views they sit in keep them near the top.

**Scrollbars actually drawn, after, counted by `offsetWidth - clientWidth - borders` over every
element**: Stacks **1**, Grid **1**, Text **1**, Table **2**. The table's second is
`VirtualTable`'s and is the documented exception — a virtualiser is a scrollport by construction.
Opening the card detail pane over Stacks made it 2 as well, the pane being its own scroller for the
printings preview; that was read in the editor only and not in the other views. Every other view
was re-checked in the same pass: Search 1 (the wall), Settings
1 (`main`), Collection, Wishlist and the deck gallery 0, and **no window scrollbar and zero
document overflow in any of them**.

**Why no test caught it and none can.** jsdom has no layout engine, so the 904px is invisible to
the suite — and so is the difference between the fix and the wrong fix, which are identical in
every DOM assertion. `DeckEditor.test.tsx` pins the class and states the figures instead.

## The drop ring with a side missing

**2026-08-17.** Reported from the shipped window as "when dragging a card the outline is cut off by
the edge of the container", with a screenshot of the deck builder mid-drag: the leftmost pile's gold
ring drawn on three sides.

**What it was.** `StackView`, `GridView` and `TextView` are `overflow-x-auto` — kept when the three
views were given no height in 2026-08-14, for the one case where a single column zoomed past a
narrow desk really is wider than its box. None of the three carried padding. **An `overflow` clips
at the box's padding box**, so a pile laid out flush against the scroller's content edge has
everything drawn outside its own border box painted in the clipped region:

| mark                                   | drawn at                                 | with no padding      |
| -------------------------------------- | ---------------------------------------- | -------------------- |
| `DROP_RING` (`ring-2`)                 | a box shadow, 2px outside the border box | the whole side, gone |
| `FOCUS` (`outline-2 outline-offset-2`) | 2px of outline standing 2px off the edge | the whole side, gone |
| `DROP_OVER` (`bg-accent/10`)           | inside                                   | untouched            |

Three surfaces, one defect, and the shape of it differs by view: Stacks loses the left edge of the
first pile in every line and the right edge of the rail, Text the same plus the top of its first
line, and **Grid loses the ring down both sides of every group at once** — a group there is as wide
as the desk, so both of its vertical edges are the content edge.

**The fix is `DROP_MARK_ROOM` (`p-1.5`) on all three roots**, defined beside the marks it makes room
for in `src/lib/dropMarks.ts`. **Six pixels rather than the ring's two** because the outline is the
larger of the two claims and a focus indicator clipped to half its width is a WCAG 2.4.7 failure
rather than a cosmetic loss. `StackView` keeps its `pb-2`: Tailwind emits the `padding` shorthand
before the `padding-bottom` longhand — `.p-1\.5` at byte **29 557** against `.pb-2` at **31 795** in
`dist/assets/index-*.css` — so the longhand wins the bottom edge whatever order the two classes are
written in, and the foot of a column is the one edge that was never clipped.

**It belongs on the box that carries the `overflow`, and one level in is not the same fix** —
padding on a child moves the target off the edge, but the ring is then drawn outside _that_ child
and lands back on the same clip. Same rule, and the same trap, as the `relative` in the section
above. The other way out is `ring-inset`, which is what `TableView` has always drawn, its rows
being absolutely positioned inside a virtualiser where an outset ring would paint over its
neighbours.

**Photographed rather than reasoned about**, and without either lock: a `file://` page against the
built `dist/assets/index-*.css`, the two states of the root side by side, shot by headless Edge.
Before, the ring is present on the right and bottom of the first pile and absent on its left and
top, and the focused pile's outline is missing its top edge entirely; after, both are closed on all
four sides.

**Why no test catches it and none can.** jsdom has no layout engine, so nothing is clipped, every
rect is zero, and a rendering assertion passes just as happily against a view that has lost the
padding again. `views.test.tsx` sweeps the class pair instead — `overflow-x-auto` **and**
`DROP_MARK_ROOM` on each of the three roots — because the padding is only load-bearing on account
of the `overflow`.

## The format check that changed width with the deck

**2026-08-18.** Reported from the shipped window: a deck that keeps a plan has two lists, Live and
Theory hold different cards, and the two therefore fail different rules — so pressing the variant
switch took the format check from `No issues · Modern` to `3 issues` and moved everything beside
it.

**Measured, in the old spelling and the new, in one frame.** Both blocks are the deck header's own
`flex flex-wrap items-center justify-end gap-2` at 1000px, drawn with the same six action buttons
after them:

| the check reads              | width        |
| ---------------------------- | ------------ |
| `No issues · Modern` (clean) | **144.81px** |
| `3 issues` (broken)          | **74px**     |
| the glyph, 0 findings        | **36px**     |
| the glyph, 3 findings        | **36px**     |
| the glyph, 147 findings      | **36px**     |

**70.81px** is what the switch was worth, on a block that already wraps at the app's own 1280 — so
the cost was never only that `Built` and the six buttons slid sideways, it was that a fold could
fall on the other side of them.

**The glyph is `CircleCheck` in `--color-ok` or `TriangleAlert` in `--destructive`**, computed
`oklch(0.72 0.14 152)` and `oklch(0.704 0.191 22.216)` — a new token beside the red rather than
one of the palette's two greens, both of which belong to mana (`src/index.css` says why at the
token). Nothing but the glyph is coloured: the control's surface stays what every other chip on
that row is, because this panel refuses nothing.

**The count is a 16×16 bubble, `absolute`, and it hangs off the top and never off the right.**
That asymmetry is a scrollbar rather than a preference. The block is `justify-end`, so every
folded line ends flush against the header's right edge — which is the deck editor's own edge, and
the editor is the page scroller, where `overflow-y: auto` computes `overflow-x` to `auto` as
well. Driven at the two widths where the fold lands right after the check:

| badge anchored                          | horizontal scroll in the scroller |
| --------------------------------------- | --------------------------------- |
| `-top-1 right-0` (shipped), block 240px | **0**                             |
| `-top-1 right-0` (shipped), block 260px | **0**                             |
| `-top-1` + `right: -4px`, block 240px   | **3px**, and a scrollbar drawn    |
| `-top-1` + `right: -4px`, block 260px   | **3px**, and a scrollbar drawn    |

Shipped, the bubble's right edge sits **1px inside** the button's own (an `absolute` inset resolves
against the padding box, so `right-0` is inside the border) and **3px above** its top, which the
header's `py-1.5` has six of to spare.

**Photographed rather than reasoned about, and without either lock**: a `file://` page against the
built `dist/assets/index-*.css`, every state in one frame, shot by headless Edge, with the retired
anchor spelled as an inline `style` because a class that has left the source is not in the built
sheet. **That is a real layout engine and it is not the shipped window** — WebView2 at the app's own
width, with the deck's real controls in the row, has not been driven for this change.

**Why the suite cannot hold any of it.** jsdom has no layout engine, so every rect is zero and
nothing clips. `ValidationPanel.test.tsx` asserts the two states' **class lists are identical**
instead, which is the same claim written where it can fail, plus the bubble being `absolute` and
`aria-hidden`.

## Vendored components and tokens

- shadcn components: always `npx shadcn@latest add <x>` with Radix base (components.json).
  The app palette maps `accent` to a **text** colour (gold), so rewrite a vendored
  component's `bg-accent` surfaces to `bg-surface`. `bg-muted` needs no rewrite any more:
  the app's dim text is `--color-dim` and `--color-muted` is the surface shadcn means by it
  (it used to be the dim text, which gave a stock `TabsList` invisible labels).
  `text-muted-foreground` and `text-accent-foreground` already resolve correctly.
- **Dim text is `text-dim`, never `text-muted`** — the latter still compiles and now paints
  text in the surface colour, i.e. very nearly invisible. `src/lib/tokens.test.ts` guards it.

## All printings, as a modal — driven in the shipped window

**2026-08-18, `npm run tauri dev` (a debug build), 1280×800, against the real corpus (a copy of
the 580 MB dev database).** Every figure below is a reading from that window.

`View all printings` used to answer by _moving_ the reader: `requestAllPrintings` wrote
`activeView`, `selectedCardId`, `paneDeckContext`, `openDeckId` and `returnToDeckId` in one `set`,
so a reader on the Collection lost their place and a reader in the deck editor lost the deck.
Inside the editor the row went to the 384px card pane instead, which is the right content at the
wrong width. Both are one `AllPrintingsDialog` now, on the `DeckDialog` shell.

- **It opens over the view and moves nothing.** From a Search tile: `activeView` stayed `search`,
  `openDeckId` and `selectedCardId` stayed `null`, and the search box still read `lightning bolt`
  with its wall behind the scrim. From a deck row: `openDeckId` stayed **2** and `activeView`
  stayed `decks`, so the editor is still on screen behind it.
- **The request carries the whole slot.** Right-clicking a Maybeboard row produced
  `{ deckId: 2, categoryId: 10, categoryName: "Maybeboard", cardId: …, variant: "live", finish: null }`
  — all five parts of `DECK_CARD_GRAIN`, which is what makes a press a swap rather than a guess.
- **The press is the swap.** Vampiric Tutor, 16 printings, pressed on `VIS 72`: the deck row went
  from `PLST · EMA-112` to `VIS · 72` (and Mythic to Rare, which is a different printing's rarity),
  the modal closed, the editor stayed open.
- **One Escape closes one layer.** Pressed with the modal up over the deck editor,
  `printingsRequest` went `null` and `openDeckId` stayed **2**. Pressed over Search, the wall kept
  its query and its results.
- **The zoom does not leak.** Three ctrl+wheel steps inside the modal took `cardZoom.printings`
  from 1 to 1.5 and a tile from **170px to 255px**, with `search`, `collection`, `deckSearch` and
  `deck` all still at 1. That is the whole reason `printings` is its own `ZOOM_SECTIONS` member:
  the modal opens _over_ a wall the reader has already sized.
- **The layout at 1280×800**, Lightning Bolt (62 printings): the dialog is 752px tall inside an
  800px viewport; the Sets and Languages pickers sit side by side and cap themselves at **181px**
  and **131px** (both are the checkbox-list branch past eight options, each with its own scroller),
  the treatment chips take **57px**, and the wall gets **372px** with 3587px of content under it.
  Five tile columns at 100%.
- **The filter narrows what it says it narrows.** Typing `secret lair` took the caption to
  `showing 17 of 62 printings` with 17 tiles rendered, and exactly **one** control matching
  `/Clear/` on screen — the filter bar's `Clear all`. The empty state deliberately draws no second
  one, because two controls with one job are two things to keep in step and an ambiguous match for
  anything addressing them by name.
- **A zero-count treatment is greyed, not dropped.** Lightning Bolt has no extended-art printing,
  and the chip is there, dimmed, named `Extended art — 0 printings`. The modal's own tiles read
  `View all printings, you are already looking at them` and are `aria-disabled`.

### The page size, measured

`MAX_PRINTINGS` is 400 and the modal filters client-side, so it asks for a wider page: a filter
over a truncated list draws an empty wall that reads as an answer rather than as a truncation.
**Measured against the corpus on 2026-08-18** with `node:sqlite` (best of five, warm): the
printings query for Forest costs **6.3 ms at `LIMIT 400`** (400 rows) and **7.1 ms at `LIMIT 1000`**
(865 rows) — 0.8 ms for the whole list.

The corpus's five largest paper printing lists that day: **Forest 865, Mountain 842, Swamp 834,
Island 829, Plains 821**; the largest non-land is Sol Ring at 132. `card.rs`'s own note records
862 / 840 / 832 / 827 / 818 from 2026-08-05, so these lists grow by a handful of rows a fortnight —
which is the argument for `MAX_PRINTINGS_HARD = 1000` being headroom rather than a fitted number,
and for the caption keeping its `N of M` wording for a cap nothing currently reaches.


## The arrow keys, and the caret the card pane kept taking

Driven in the shipped window **2026-08-18** (`npm run tauri dev`, a **debug** build, 1280×800 and
1024×768, against a real synced corpus). Three surfaces walk with the arrow keys — the search and
collection walls, the deck's piles, and the printings modal stepping along the open deck — and the
live pass found one defect behind all three, plus one the suite could not see.

### One cause, three surfaces: the walk was exactly one press long

`CardDetailPane` renders `<Body key={cardId}>` and that body's mount effect focuses the pane —
"focus moves in when it opens, and Escape hands it back to whatever opened it", which is the right
contract for a card a reader *pressed*. The arrow keys make the same store write for a different
reason, so **every** press re-keyed the body and pulled the caret out of whatever was being walked:

| Surface | One press left `document.activeElement` at |
| --- | --- |
| Search wall | `<aside aria-label="Card details">`, with no `[data-grid-index]` ancestor |
| Deck stacks | the same, out of the pile the reader was in |
| Printings modal | the same — **outside an `aria-modal` dialog**, past its own scrim |

The third is the worst of them and is the one the reader reported: `trapTab` cycles Tab within the
panel, so a caret that has left the panel is one it cannot get back — Tab carried on through the
page under the scrim, and the modal's own keydown never fired again.

The fix is `src/lib/caretWalk.ts`: a note saying *this selection was walked to, so the caret is
already where it belongs*, written by the three walkers immediately before their store write and
read by the pane's mount effect. The pane still records the opener — during a walk the active
element **is** the right thing for Escape to hand back to — and skips only the focus.

**The first spelling of that note was wrong in a way only a debug build could show.** It cleared
itself on read, the way `handover` does one screen up in the same file; `main.tsx` wraps the app in
`React.StrictMode`, which invokes a mount effect **twice** in development, so the first invocation
consumed the note and the second took the caret anyway. The walk was still one card long and the
fix looked like a fix. It is idempotent now — the same card answers the same way however many times
it is asked, and any *other* card discards the note. Worth carrying because the asymmetry runs the
wrong way: **a release build would have passed a test this could not**, StrictMode's double
invocation being development-only.

### The wall's tile parked 2px past its own scrollport

Arrowing down a 117k-card browse, the focused tile's foot sat **2px past the scroller's padding
box** at every step. Two things were behind it and the second is the general one:

- The effect scrolled **the art button** into view rather than the tile around it. The button is
  the art alone, so the caption strip under it hung past the scrollport.
- `scrollIntoView({ block: "nearest" })` parks an element **flush** against the scrollport, and a
  scrollport is the *padding box* — so the wall's own `p-3` buys nothing at an intermediate scroll
  offset, and the `FOCUS` ring, which paints 4px proud of the border box, lands in the clipped
  region. That is `DROP_MARK_ROOM`'s rule (`src/lib/dropMarks.ts`) arriving by a different road,
  and half a focus indicator is a WCAG 2.4.7 failure rather than a cosmetic one.

A `scroll-m-1.5` on the tile — **6px, that constant's own number, so the two cannot drift** — plus
scrolling the tile rather than the button lands it a measured **6px clear** of the scrollport at
every step. A scroll margin rather than more padding, because padding does not move where
`scrollIntoView` stops.

### The flanked modal, at both widths

The chevrons live **inside** the panel, absolutely positioned into columns the scrim reserves.
Inside, because `trapTab` cycles within the panel and a button outside its DOM would be
pointer-only; into reserved columns, because at the app's 1024px floor the panel is already
full-width and anything hung off its edge would sit off-window.

| | 1280×800 | 1024×768 |
| --- | --- | --- |
| Panel | x 80 → 1200 (**1120** wide, 32 narrower than the 1152 it drew before) | x 80 → 944 (**864**) |
| Chevrons | 37–73 and 1207–1243 | 37–73 and 951–987 |
| `documentElement.scrollWidth` | 1280 = `clientWidth` | 1024 = `clientWidth` |

Both are 36px discs on the panel's vertical centre (`cy` 400 against the panel's own 400 at
1280×800), and `elementFromPoint` at each centre hits the chevron rather than the scrim — the check
this repo's drag pass learnt to make before concluding anything about a control.

**Those two rows are unchanged by the width the panel asks for now, which is the argument for it.**
It asked for `w-[72rem]` when they were taken and `max-w-full` clamped it to the column at both
sizes, so 1120 and 864 were already the *column's* numbers rather than the request's. On 2026-08-20
it became `w-full` — the request **is** the column — and both figures come out the same. What moves
is the case the table has no row for: at 2560 maximised the reserved column is 2400 and the panel
used to draw 1152 in the middle of it, six 170px tiles with the rest of the window left to the
scrim. It draws 13 across now. Nothing about the chevrons had to change, and that is the point of
spelling the width this way rather than as a `calc(100vw - 10rem)`: the room they sit in is
`FLANK_COLUMNS` plus the scrim's own padding, and a length here would have had to restate both and
would have parted company with them the first time either moved.

### What the walk does, confirmed live

- **Wall**: 0 → 1 → 2 by ArrowRight, then ArrowDown landing on 5 — the column count having dropped
  **5 → 3** on the first press, because selecting opens the 384px pane and `columnsFor` divides
  what is left. The absolute index is what survives that re-flow; a tile's row and column do not.
- **Deck**: right, down, down, right walks pile to pile and card to card, and exactly **one**
  `[data-deck-card-selected]` is in the DOM afterwards — on the focused card. The gold ring
  follows the caret rather than trailing it.
- **Modal**: four consecutive ArrowRights step four cards with the caret inside the dialog every
  time. The chevron works as a button and steps the same way. At the first card the previous
  chevron is really `disabled` and drops the neighbour's name from its label; there is no wrapping.
  ArrowUp and ArrowDown change nothing, so the wall keeps its native scrolling.
- **One card filed in two piles is two stops**, and the walk proves it rather than merely claiming
  it: stepping off the end of the Artifact pile reached `"Lifetime" Pass Holder` a second time, as
  the Creature pile's first row. Two `deck_cards` rows, two addresses, two stops.
- **Closing the modal leaves the deck on the card walked to** — the ring and the pane both.

### One thing this pass did not fix

Escape out of the modal drops the caret to `<body>`. That is `DeckDialog`'s behaviour for **every**
dialog on the shell rather than anything this work introduced — the shell focuses its panel on
mount and restores nothing on close — so it is recorded here and left alone. It is more visible now
than it was: a reader who walks the deck from inside the modal and then closes it has to Tab back
from the top of the app to carry on walking the desk.


## The arrow keys, part two: the gesture a keyboard test cannot make

Driven in the shipped window **2026-08-19** (`npm run tauri dev`, a **debug** build, 1280×800,
against a real synced corpus), after a reader reported the deck's piles still not walking.

**The first pass proved the arrows and missed the way in.** Every live check and every test drove
the walk from a card focused *programmatically* — `act(() => top.focus())` in the suite,
`el.focus()` over CDP — which is a caret that was never anywhere else. A reader's caret gets there
by **clicking**, and a click is a deliberate open: `onSelect` writes the store, the card pane's
body mounts and focuses itself, and the reader's first arrow then moves nothing at all. The note
was written by the arrow handlers only, so the walk worked from a caret nobody could get.

Measured before the fix: a real pointer click on a deck card left `document.activeElement` as
`<aside aria-label="Card details">`, and ArrowRight and ArrowDown both moved nothing. Same on the
search wall.

The fix is to write the note where **every** selection a walkable surface makes goes through it,
press and arrow alike — `selectCard` in `StackView`, `select` in `CardGrid` — rather than at the
arrow handler. A third way to select a card would otherwise have to remember, and the failure is
silent: the selection is right, the gold ring is right, and only the *next* keypress is wrong.

`CardGrid` gates it on `arrowNav`, which is the same question asked once: a wall the arrows move
is one the reader is navigating and keeps its caret; a wall they are passing through hands it over
as before. **The printings modal needs that half** — a press there is a swap or a look and the
modal closes on it, so a caret held on a tile of a wall that no longer exists is a caret on
`<body>`.

### The card's `<li>`, which is the other thing that holds a caret

`DECK_CARD_ATTR` is stamped on a card's **button** (the art). Its outermost element is an `<li>`
carrying `CARD_BODY_ATTR`, and that takes the caret by two routes a reader really uses:
`ContextMenu` hands it back there when a row runs or Escape closes, and a click on the card's
**data line** — a sibling of the button, not a child — lands on it as the nearest focusable
ancestor. From there the button is a *descendant*, so `closest` found nothing and the arrows were
dead. Reported as the window eating the focus.

`caretCardSlot` now reads the button by `closest` **or** the body by an exact `===` match. Exact,
because the stepper's `+` and `−` sit inside that same `<li>`: reading "anything inside a card"
instead of "the card's body itself" is how the arrows would come to walk the deck out from under
a reader adjusting a quantity, and the field guard cannot catch it because those are `<button>`s.

### Two traps this pass paid for, both in the suite rather than the app

- **`focus()` on a node with no `tabindex` is a no-op**, and a card's `<li>` gets `tabIndex={-1}`
  from `deckCardMenuProps` **only when the card has a menu**. A fixture built without `actions`
  therefore has an unfocusable card body, and the test read as a broken handler until the fixture
  was given a `menu`. The app always passes one, which is why the same route worked live.
- **The caret note is module state and is deliberately not cleared on read** (StrictMode's
  double-invoked mount effect is why). So a test that leaves one behind hands it to the next, and
  the case asserting a note is *absent* is the one that goes red. Both suites clear it in a
  `beforeEach` with an id nothing uses.

Confirmed after the fix, in the window: a real click on a deck card leaves the caret on that
card's button with the pane open beside it; ArrowDown, ArrowRight, ArrowRight, ArrowUp then walk
piles and cards with exactly one `[data-deck-card-selected]` in the DOM, on the focused card. From
a caret placed on a card's `<li>`, ArrowDown moves to the next card's button. On the search wall a
clicked tile keeps the caret and ArrowRight then ArrowDown step 2 → 3 → 6 at three columns.

**Two apparent failures during the pass were the clamps working**: ArrowDown on the Commander
pile's only card, and ArrowDown on the last card of a pile. Both are `null` from
`nextStackPosition` and therefore a press left alone — worth writing down, because "nothing
happened" looks identical to a dead handler and cost this pass two wrong diagnoses.

## The window's own title bar, and the two questions only a live pass could answer

**2026-08-20, `npm run tauri dev`, a debug build, at 1280×800.** `tauri.conf.json` sets
`decorations: false` and `src/components/TitleBar.tsx` draws the caption instead.

Two things research could not settle, and both are settled here by measurement rather than by
reading an issue tracker. Tauri's tracker has "cannot resize an undecorated window on Windows"
reported, closed, and reported again (#8519, #11975, #12207), and whether a plugin's injected
script clears this app's `script-src 'self'` was a guess either way.

**Edge-resize survives `decorations: false`.** The window keeps `WS_THICKFRAME` — its style
reads `0x14CF0000`, and `WS_CAPTION` is still set too — and every border answers the hit-test
that makes it draggable. Sent `WM_NCHITTEST` at each edge of the window rect:

| Point | Answer |
| --- | --- |
| left / right edge | `HTLEFT` (10) / `HTRIGHT` (11) |
| top / bottom edge | `HTTOP` (12) / `HTBOTTOM` (15) |
| top-left / bottom-left nub | `HTTOPLEFT` (13) / `HTBOTTOMLEFT` (16) |
| bottom-right nub | `HTBOTTOMRIGHT` (17) |
| the drag region, and all three buttons | `HTCLIENT` (1) |

The mechanism is a child window of its own: `EnumChildWindows` shows a
**`TAURI_DRAG_RESIZE_BORDERS`** at 1280×800, which **collapses to 0×0 when the window is
maximized** — correct, since a maximized window has no borders to drag. The window rect is
**1296×809** for a **1280×800** client, so there is an 8px invisible grab margin on each side.

**The buttons all read `HTCLIENT` from the parent, and that is not the whole answer** — the snap
overlay is a *child* HWND, so asking the parent about that point is asking the wrong window. The
overlay is a **`Static` child, 46×33, at the maximize button's exact screen rect**, and it answers
**`HTMAXBUTTON` (9)** — which is what raises the Windows 11 Snap Layouts flyout. It tracked a
maximize precisely: the button moved to DOM `2468,0` and the overlay to screen `2468,0`, same
46×33, still answering 9.

**The injected script is not governed by the page's CSP.** `tauri-plugin-snap-layout` injects
through `js_init_script`, which the webview runs before the page exists, so `script-src 'self'`
never applies — all five `__SNAP_LAYOUT_*` globals are present and `__SNAP_LAYOUT_IS_ATTACHED__()`
answers `true`. **No CSP change was needed**, which was the deciding argument against
`tauri-plugin-decoration`: that one renders its own HTML controls and wants a stylesheet source
added. The console over a full session held 13 lines and one error, a `502` on an uncached card
image (this worktree has no copied `data/`) — nothing about the caption.

**Geometry, and what the 34px comes out of.**

| | Before (2026-08-14) | After |
| --- | --- | --- |
| title bar | — | **1280×34** at `y: 0` |
| `nav` | 208×800 at `y: 0` | **208×766** at `y: 34` |
| `main` | 1072×742 at `y: 58` | **1072×708** at `y: 92` |

**It comes off height, not width**, which is the one thing that made it affordable: the deck
editor is measured against `main`'s *width* to the pixel (`DECK_FLOOR`, the docked panel, the
602px desk row), and none of that arithmetic moves. The editor loses 34px of a scroll it already
had — the same trade the ribbon's 48 → 56 made, four times over. `documentElement.scrollWidth`
**1280** and `scrollHeight` **800** against a `clientHeight` of 800: nothing scrolls in either
axis, so the column swap did not reintroduce the phantom scroll that section further up is about.

A caption button is **46×33** — 46 is Windows' own caption-button width, and the 33 is 34 less the
row's 1px `border-b`, since the button is `h-full` inside it. The close button's right edge is
**exactly 1280**: flush, which is the whole reason these three have no radius and no margin.
The wordmark computes to **Cinzel, 13px, `letter-spacing: 2.6px`** (0.2em) in
`oklch(0.65 0.01 90)`, which is `--color-dim`.

**All three buttons drive the window**, checked one at a time. Maximize took it 1280×800 →
**2560×1392** and flipped the label to `Restore Down` and the glyph from `Square` (one child) to
`Copy` (two); a second press restored both. Minimize left `IsIconic` **true**. Close ended the
process. **What a CDP click cannot check is the path a real pointer takes**: CDP delivers input
straight to the renderer, so it exercises the React `onClick` — a real cursor lands on the native
overlay instead, which swallows the click and sends `SC_MAXIMIZE` itself. Both paths exist on
purpose, and only the fallback one is drivable from here.

## The app draws its own tooltips, and the sweep off `title` is in progress

Full design: `docs/superpowers/specs/2026-08-20-tooltip-component-design.md`. `useTooltip()`
(`src/components/tooltip/useTooltip.ts`) is the one door: `{...tip(words, options)}` on the
element that already carries the hint. **A hint is that spread, never a `title` attribute and
never an SVG `<title>` element** — both still work today (see below), which is exactly the
problem: neither goes red when new or changed code reaches for the old one instead.

**One panel, `fixed`, mounted at the app root — because a virtualised row is both
`position: absolute` and transformed, which caps every `z-index` inside it *and* makes that row
the containing block for a `position: fixed` descendant.** A panel anchored inside a row inherits
both traps at once; a panel whose DOM node lives outside the whole tree, at `LAYER.tooltip`
(`z-46`, above `overlay`'s 45 because a hint can be shown over the deck editor's dialogs, below
`gate`'s 50 because `SyncProgress` covers the window and a hint floating over it would describe
something the reader cannot see), needs neither raised further nor clipped by an
`overflow-hidden` scroller. `PrintingPreview` is what paying the alternative costs today: it
places its own preview with `frame.scrollTop`/`clientLeft` arithmetic instead of `fixed`, because
it has to stay inside its scroller's transform. `TooltipProvider` mounts in `src/App.tsx` and
`.storybook/preview.tsx`, both above `ContextMenuProvider`, for that provider's own reason — its
panel is a sibling of `children`, so a context nested inside it would wrap every view and none of
the menu's own rows.

**Each site is classified by what its words *are*, not run through a regex** — a regex cannot
tell an icon-only button's only name from a description of an already-named one, and the sweep
that will retire the rest of `title` has to read every site rather than pattern-match it:

| The words are… | What the site does |
| --- | --- |
| the element's **only** name | add `aria-label`, bind with `describes: false` — otherwise a reader hears "Duplicate, Duplicate" |
| a **description** of something already named | the default: `aria-describedby` while the panel is open |
| **redundant** — `whenClipped`, or a mark whose words are already visible text | `describes: false`; the panel is `aria-hidden` |

**No shipped site is an example of the first row yet** — every converted site that carried an
`aria-label` already had one before this task touched it. `CollectionTable.tsx`'s remove button
is the shipped example of the *third* row instead: `title="Remove from your collection"` sat
beside `aria-label="Remove {name} ({finish}, {condition}) from your collection"` from the day the
file was written (`3a66119`, 2026-08-05, confirmed by `git show`) — never the button's only name,
always redundant with a longer one it already had. It now binds
`{...tip("Remove from your collection", { describes: false })}` and keeps the `aria-label`
untouched. (This corrects an earlier version of this paragraph, which claimed the button had no
`aria-label` before this task and would have lost its name outright — checked against source
history and found false; the design doc's own §4 carried the same error and is corrected there.)

**What the remaining sites *do* have three of, all in the second row, is a title that is only
ever a conditional description of a control already named some other way** —
`AppShell.tsx:378`, `DeckSearchPanel.tsx:412` and `DeckStats.tsx:779`, each a `<button>` with its
own visible text (a nav label, "Search cards", "Send missing to wishlist") whose `title` appears
in exactly one state: a card in the air over a nav entry that cannot take it, a docked panel with
no room, a shortfall already on the wishlist. None is icon-only, so none risks losing its name —
but `AppShell.tsx`'s is a sharper trap than a missing `aria-label` would have been: its own
comment records that the sentence is never actually *shown* as a native tooltip at all, because
Chromium freezes `:hover` at a drag's origin for the whole gesture, so mid-drag a reader gets the
words only through the accname spec's description fallback. `useTooltip()` opens on a hover the
reader is equally not producing during that same gesture, so this site is not the mechanical
`title` → `tip()` swap the other four proof sites were, and converting it is deliberately left
for whoever does that one rather than folded into this task.

**`whenClipped` never describes, on principle rather than as a default that happens to be set.**
The text a `whenClipped` tooltip repeats is already complete in the DOM, and therefore in the
accessibility tree — only the *paint* is cut off by `truncate` — so wiring `aria-describedby` for
it would make a screen reader announce the same words twice.

**Escape closes the open tooltip without calling `preventDefault()`, and it deliberately does not
join `useDismissOnEscape`'s capture-phase ladder** — the handshake `src/CLAUDE.md`'s "Escape
closes one layer per press" rule describes for every other dismissible layer in the app. That
stack is for a layer the reader navigated *into*; its top rung consumes the press. A tooltip that
opened because a pointer drifted over a control is not such a layer, and if it consumed Escape it
would swallow the press meant for whatever dialog is open underneath it.

**`pointer-events` inherits, so a tooltip bound to anything inside a `pointer-events-none`
subtree can never be shown — and nothing goes red for it.** Unchanged from the `title`/SVG-
`<title>` era this replaces (`FoilOverlay`'s chip needed `pointer-events-auto` against its
wrapper's `none` for exactly this reason, above); a hit target invisible to the DOM is invisible
to a test too, which is why it is worth restating at the new API rather than assuming the old
lesson carries over on its own.

**`useTooltip()` returns a no-op when no `TooltipProvider` is above it, and a dropped provider is
silent** — every hint in the app, or every hint in Storybook, simply stops appearing, with no
error and no red test at the call site that lost it. `src/lib/tokens.test.ts` pins both mounts
(`App.tsx`, `.storybook/preview.tsx`) **and their ordering above `ContextMenuProvider`**, which is
the one thing a source sweep can catch here — the same no-op trade `NO_MENU` makes in
`menu/useContextMenu.ts`, for the same reason: after the sweep, most surfaces in the app bind a
tooltip and each is also a story rendered on its own, so throwing on a missing provider would fail
every one of them rather than the one call site that forgot.

**The sweep off `title` is in progress, not finished, and this file will not carry its running
count.** Five call sites were converted as proof — a truncated table cell, an interactive band, an
icon-only button, a shared header's description (`SortableHeader`, so the change reached every
sortable table at once), and one drawn inside a `DeckDialog` to prove `z-46` actually clears a
real `z-45` scrim rather than only a Storybook decorator — and the rest of the app's hints are
still native `title` attributes and SVG `<title>` elements, left for a later PR.

Measured at `e4fcf59` with a scan that tracks string/bracket depth rather than one that slices an
element's source at its first `>` — the bug that produced this section's first, wrong draft (see
above) — **108** `title=` occurrences across **53** files, **28** of those on a `<button>` and
**3** with no `aria-label` on the same element (all three named above, none icon-only), and **2**
real SVG `<title>` elements (not 8 — the other six matches are prose in doc comments quoting
`` `<title>` `` in backticks, which a plain-text grep cannot tell from a rendered element). The
`title=` figure is still *more* `title=` sites than the design doc's own count at `06572dc` (102
across 48), despite five having been converted away, because the two commits are days and several
unrelated merges apart and this app's chrome keeps growing — that half of this paragraph was
re-checked and holds. The button/aria-label and SVG-`<title>` figures did not: both were wrong in
the first commit of this section, for two different reasons, and both are corrected here and in
`docs/superpowers/specs/2026-08-20-tooltip-component-design.md` §4/§7, which carried the same two
bugs first. A count is a fact about a tree — and, this time, also a fact about the script that
produced it; re-measure before repeating any of these four numbers.

**`whenClipped` only works on an element with a real layout box.** It measures `scrollWidth`
against `clientWidth` on `event.currentTarget` — the element `tip()` is spread onto — and a
`display: inline` span reports both as `0`, so the comparison is always `0 > 0`, the hint never
opens, and **nothing goes red**: not jsdom, which has no layout engine and could not have caught it
either way; not CI; not a story. The five-way sweep found this latent in the search table's set
column (`SearchPage.tsx`): `truncate` sat on the cell wrapper, which is a grid item and blockifies
for free, while the span carrying `{...tip(card.setName, { whenClipped: true })}` was a bare
inline element with nothing of its own to clip. The fix is `block` on the bound span itself, not on
an ancestor — the measurement happens on the anchor, so the box has to belong to the anchor. A
`<p>`, a flex item and a grid item all have a layout box already; a bare `<span>` inside a
non-flex, non-grid parent does not, and every `whenClipped` call site is worth checking against
that question rather than assumed safe because the surrounding markup "looks like" a block.

**A tooltip bound `describes: false` — including every `whenClipped` one — carries no
`role="tooltip"` and is `aria-hidden`.** `TooltipPanel.tsx` sets `role={open.describes ? "tooltip"
: undefined}` and `aria-hidden` the other way, and `whenClipped` forces `describes: false` for the
reason two paragraphs up — the text it repeats is already in the accessibility tree, so describing
it too would be a screen reader saying the set name twice. A play or a test that reaches for
`findByRole("tooltip")` on one of these sites does not fail fast: `findBy*` retries until its
timeout, so the wrong query burns the full wait and then reports "unable to find", which reads like
a hang rather than a wrong query — `SearchPage.stories.tsx`'s `GameChangerRow` reported a clean
5000ms timeout for exactly this reason before it was traced back to `GameChangerMark.tsx`'s own
`{...tip(GAME_CHANGER_HINT, { describes: false })}`. The correct query for a `describes: false` or
`whenClipped` panel is by id — `TOOLTIP_PANEL_ID`, exported from `TooltipPanel.tsx` (the element is
`#app-tooltip`) — the way `CardStack.test.tsx`'s `openTooltip` helper and `CountTag.stories.tsx`
already do. `findByRole("tooltip")` stays correct, and is the faster failure, for a *describing*
site (the default `describes: true`), because there the panel really does carry that role once
open.
