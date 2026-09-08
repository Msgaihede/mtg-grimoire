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
- **The rail collapses to 68px of icons, and that is the bullet above with its sign flipped**
  (2026-08-22, issue #177). That one says a *wider* sidebar is a change to `DeckEditor`'s
  arithmetic first; a narrower one is the same change, landing where the app is tightest. `w-17`
  is 68px and holds a **43×44** target inside the `<nav>`'s own `p-3` — **not** the round 44×44
  three comments claimed before this was measured: `box-sizing: border-box` puts the rail's own
  `border-r` inside the 68, so the entry gets 68 − 12 − 12 − 1. Nothing else about an entry moves;
  it keeps its 44px height, its `size-5` icon, its gold hairline and its drop target, and the
  label goes to `sr-only` rather than to an `aria-label`, so the accessible name is computed from
  content in both states and is the same string in both.
  **Driven in the shipped window 2026-08-22** (`npm run tauri dev`, a **debug** build, against a
  copy of the main checkout's corpus, mid-sync). At 1280×800: expanded `nav` **208**, an entry
  **183×44**, the toggle **183×44**, `main` **1072** — the same 1072 the 2026-08-14 pass recorded,
  which is what makes the two comparable; collapsed `nav` **68**, an entry and the toggle both
  **43×44**, `main` **1212**. So the rail hands `main` back **140px**, and
  `document.documentElement.scrollWidth` is **1280** in both states.
  **The deck editor's docked panel survives the collapse, which was the thing to check.** The
  width is tweened at `--duration-base` (180ms) and `DeckEditor` picks docked-panel-vs-rail out of
  a `ResizeObserver`, so the tween drives that decision through every intermediate width — but a
  collapse only ever *widens* the desk and an expand only narrows it back to the 208px value that
  is already valid, so no intermediate state is worse than the endpoint it is heading for.
  Measured at 1280×800 with the panel open: **`aria-expanded=true` and not disabled** on both
  sides of the press, `main` 1072 → 1212. **Reading a width during the tween is its own trap** —
  a measurement taken one command after the click read `nav` at **169.25px**, which is neither
  state and reads exactly like a broken class.
  **Both things that float beside the collapsed rail share one left edge, and it is 5px inside
  the rail.** The entry's tooltip and `NavNote`'s drop report both measured `left: 63` against a
  rail whose outer edge is 68, because both stand `TOOLTIP_GAP` (8px) off the **entry**, and the
  entry sits 12px of padding and a hairline inside the rail. That is `placeTooltip`'s own rule
  applied to the anchor it was given, and **the two agreeing is worth more than either clearing
  the border**: a note at 63 beside a tooltip at 76 would be two panels from one icon at two
  different edges. The note measured **192×33**, `position: absolute`, `z-index: 30`
  (`LAYER.popup`), `pointer-events: none` — that last one is why a panel hanging over the view
  for `REPORT_MS` cannot eat the drop it is reporting.
  **Reduced motion, and the contract's own trap, live.** Under `prefers-reduced-motion: reduce`
  the `<nav>` computes `transition-property: none` while `transition-duration` still reads
  **0.18s**, because `motion-reduce:transition-none` clears the property and leaves the duration
  alone. A check that read the duration would have reported a false failure on a rail that is
  correctly still — the same measurement
  [live-ui-verification.md](live-ui-verification.md) records on a sort header.
  **The keyboard activates it exactly once per press**: `press Enter` took it collapsed → expanded
  and `press Space` expanded → collapsed, one activation each, focus still on the toggle
  afterwards. The count rather than the fact, which is the only honest way to check a key that
  activates something. The choice is one `app_meta` row (`nav_collapsed`, `"1"`/`"0"`), and it was
  observed written **through a running sync** — the optimistic write's BUSY case, costing nothing
  the reader can see.
- **The rail's width is a CSS transition and its labels are a React commit, and the two used to
  run at once — which was two bugs, not one** (2026-08-22, both reported against the shipped
  window). The bullet above says "nothing else about an entry moves"; that was true *at rest* and
  false for the 180ms in between. Sampled a frame at a time in the shipped window, debug build,
  at the app's own 1920×1080 — and **both readings come from one build**, the old behaviour
  reproduced by backing each fix out through `element.style` in the running window rather than by
  rebuilding twice.
  **The icons jumped away from the left on the way down.** The row centred its content while
  collapsed, which is the same place to half a pixel at rest — the icon's left edge is **24**
  expanded and **23.5** centred in the 43px collapsed row — but the class flipped on the *press*
  while the width took 180ms to follow, so each icon was being centred in a box still 183px wide.
  Frame by frame: **24 → 93.5** on the first frame, then 93.3, 92.6, 91.2, 88.8 … 24.5, 23.7,
  settling at 23.5. A **69.5px** leap outward and a slow slide back, six icons at once. The fix is
  to left-anchor in both states — `gap-3` unconditionally, `justify-center` gone, `h-11` while the
  label is out of the flow — which reads **24 on all 40 frames** of the collapse and 24 on all 45
  of the expand. **Nothing about the target changed**, which was the thing to check: the entry and
  the toggle are still **43×44** collapsed and 183×44 expanded, `main` still gets **140px** back
  (1712 → 1852 here), `documentElement.scrollWidth` is 1920 in both states, and the collapsed
  tooltip still stands at **left: 63**, the number the pass above recorded.
  **The words arrived 180ms before the room for them on the way up.** `collapsed` flipping in one
  commit put all seven labels back in the flow at full width inside a 68px rail, painted over the
  view beside them — `<nav>` carries no `overflow-hidden` and *cannot*, because the collapsed
  rail's floating notes hang off it at `left-full`. Measured with the hold backed out: `Decks` sat
  with its right edge at **102** against a rail 68 wide, **34px** outside it, for the first ~55ms;
  `Tags` overhangs by 22, `Collapse` by 52, `Collection` by **62**. `src/lib/useNavLabels.ts` holds
  them back for the length of the tween and the label sites fade them in over
  `--duration-instant` (50ms, the tier added for this). The corrected sweep: the rail reaches 208
  at **172ms**, the word leaves `sr-only` at **195ms**, opacity climbs 0 → 17 → 47 → 70 → 85 → 94
  → 100 and is full at **242ms** — a **47ms** fade, and the word's right edge never leaves the
  rail. **Asymmetric on purpose**: closing, the words go in the same commit as the press, because
  a delay there is the same overflow with the sign flipped.
  **The reduced-motion half is proven at the class and not in that window, and the reason is the
  hook.** Under emulated `prefers-reduced-motion: reduce` the `<nav>` computes
  `transition-property: none` (68 → 208 in **one frame**) and the label computes
  `animation-name: none`, `animation-duration: 0s` against `enter`/`0.05s` normally — so the fade
  is off and the rail does not travel. But the labels still waited the full 180ms, because
  `useReducedMotion()` reads the media query **once at mount** and never updates on a live change
  (`motion.md` says so about the hook generally). A reader whose OS setting is on *before the app
  starts* gets `delayMs: 0`; emulating it mid-session cannot show that, and
  `useNavLabels.test.ts` is what covers the zero-delay path.
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
  assert; what a person can see is a screenshot. `PrintingPreview` had reached the same answer
  independently, by keying its whole `Preview` on the printing — that file was deleted with the
  docked card pane on 2026-09-03.
- **An `art` crop has no printed frame, so wherever one is shown the illustrator must be
  identifiable — and the rule has _two_ arms, only one of which this page had ever written
  down.** Corrected **2026-09-07**, against both pages fetched live that day.
  **Where it lives, first, because the obvious page is the wrong one.** The rule is on
  **`https://scryfall.com/docs/api`**, in the list introduced by *"When using images from
  Scryfall, you must adhere to the following guidelines"*. It is **not** on
  `https://scryfall.com/docs/api/images` — which is where anybody looking for an *image* rule
  goes first, and where a swept 2026-09-07 check found no file in this repo had actually sent
  them, because until then no file named a URL at all. The Card Imagery page carries no artist
  rule at all —
  the word "artist" does not appear on it — and is now a table of image variants and their
  statuses, which is precisely and only what
  [the Scryfall research](../superpowers/research/2026-08-04-scryfall-api.md) cites it for.
  (That table is also where the `art` row reads *"Replaces `art_crop`"*, so the guideline's
  `art_crop` and the variant this app actually stores are the same picture under two names —
  `art`, 626 × 457, WEBP.) Verbatim, the two lines that bind:

  > When using the art_crop, list the artist name and copyright elsewhere in the same interface
  > presenting the art crop, or use the full card image elsewhere in the same interface.
  >
  > Users should be able to identify the artist and source of the image somehow.

  **The `or` is the arm this page never carried, and it is the whole of what changed.** An
  interface complies by naming the artist **or** by showing the full card image somewhere in it,
  and the sentence under it says what both arms are for: a reader must be able to identify the
  artist *somehow*. So a permanent credit **line** under every picture was never the requirement
  — it was one way of meeting it — and taking one off a surface is a legitimate move rather than
  a violation, for exactly as long as the artist stays reachable there.
  `docs/superpowers/plans/2026-08-04-02-images-card-browsing.md:55` has quoted both arms since
  the beginning; the paraphrase on *this* page kept the first and dropped the second, and since
  this is the page four surfaces cite, a design decision has read as a fixed requirement ever
  since.
  **The neighbouring guidelines are unchanged and still binding**: never cover, crop or clip off
  the copyright or artist name; never distort, skew or stretch; never blur, sharpen, desaturate
  or colour-shift; never add watermarks; never imply the images belong to another game. The page
  ends by naming what non-compliance costs — *"Repeated mishandling or misrepresentation of data
  or images in your project may result in Scryfall restricting or blocking your API access."*
  **Wizards' Fan Content Policy requires no artist credit whatsoever**, which was checked the
  same day (`https://company.wizards.com/en/legal/fancontentpolicy`) and is worth writing down
  because the answer surprises: what it requires is the disclaimer notice, and that Wizards' own
  logos and trademarks inside artwork are not removed. **Every artist-credit rule in this app is
  Scryfall's**, so Scryfall's `docs/api` is the one page to re-read when one is questioned, and a
  reader who goes looking in the fan-content policy will find nothing and conclude the wrong
  thing.
  A `grid`/`thumb`/`display` image carries the printed credit itself and needs nothing — which is
  the second arm, met by construction — and the 626×457 `art` variant does not, which is why
  every surface drawing one owes an answer. It has been ruled on three times (2026-08-11,
  2026-08-31, 2026-09-07) and is written here because four surfaces cite it as living
  here. One consequence holds everywhere a **cover** is drawn — the gallery's deck tiles, its
  folder strips and `DeckCoverPicker`'s `CoverPreview`: **a card cover whose artist is unknown is
  not drawn at all** (`DeckRow.coverArtist` is `null` when `cards` has no row for that printing;
  the orphan heals on the next sync rather than being shown uncredited).
  **That guard survived 2026-09-07 unchanged, and reading it as a rule about the _line_ is the
  mistake to avoid.** The deck tile's and the folder card's credit lines were deleted that day
  and the illustrator moved onto the pictures as a tooltip, so the name is still shown and
  `hasCover`/`coverUrl` still mean exactly what they said: a crop is drawn only where this app
  can say who painted it. `CoverPreview` keeps a visible credit rather than a tooltip, because it
  is one large crop with nothing else on screen to compete with a line of type.
  **There were two, and the second went with the custom cover on 2026-08-31.** It read: *a
  custom cover carries no artist and needs none*, because the rule is Scryfall's and a user's own
  file is not Scryfall's — which was also why a folder strip dropped custom covers rather than
  crediting some of its tiles and not others. **Every cover is now a card's `art` crop**, so the
  rule applies to all of them without an exemption to carry, and the strip's drop-rule collapses
  into the one above: a tile is drawn when its artist is known and skipped when it is not, and
  there is no second kind of picture for that sentence to have to except.
  **The standing gap is down to two, and it closed by accident rather than by a credit line**
  (`DeckCoverPicker.tsx`'s `ChoiceTile` doc — that file, not `DeckSettingsDialog.tsx`, which
  hosts the picker and is where this pointer used to send a reader): it was four — the deck's stack rows
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
- **Which _kind_ of foil is a different column, and it renames the mark rather than adding one**
  (2026-08-21, issue #160). `cards.finishes` holds three words across all 116 712 rows —
  `nonfoil`, `foil`, `etched` — and has no way to say that this foil is a Surge Foil and that one
  a Halo Foil; a reader on the All Printings wall saw three identical `Sparkles` on Elesh Norn's
  `sld 811`, `mul 133` and `mul 133z`. `cards.promo_types` answers it, was already synced and
  stored, and had simply never crossed into TypeScript. So a **treatment is an annotation on a
  finish and never a fourth finish**: no migration, no `CHECK` change, nothing in any import
  format. `src/lib/treatment.ts` owns the naming, because naming is a judgement; Rust hands the
  column over unread on all five card-shaped DTOs, at **22.7 bytes** on the 32 174 rows that
  carry one.
  **32 names over 5 428 of 107 355 paper printings (5.1 %)**, in two kinds, and the split is what
  the data forced: **25 foil words** (Surge, Halo, Galaxy, Silver, Ripple, Double Rainbow…) name
  the *shiny* copy, and **7 traits** (Serialized, Thick Stock, Metal, Plastic, Glossy, Poster,
  Scroll) name the cardboard in any finish. A foil word is withheld from a plain copy — 1 434
  treated printings are also sold in plain nonfoil, and calling that copy a Silver Foil is the
  claim `soleFinish` above already refuses to make; a trait outlives the finish, which is what
  lets **1 718 printings that draw nothing today** carry a mark at all. `oilslick` + `raisedfoil`
  collapses to the one name a player says.
  **A treatment renames the mark and never redraws it** (2026-09-03, issue #353 — the
  correction to how this shipped). The glyph is the **finish**, always: `Sparkles` for foil,
  `Gem` for etched, and a Surge Foil is the same `Sparkles` as an ordinary one. It was
  `Aperture` for every named copy for a fortnight, and that was the bug — the glyph swap only
  reached the surfaces that pass `treatments`, so one Surge Foil was an `Aperture` on the
  printings wall and a `Sparkles` in the card pane's foil toggle, the deck card menu and the
  theory diff, which draw a finish and have never seen a promo type. One fact, two pictures,
  and no way for a reader to know they meant the same thing. Standardising on the finish is
  what makes the icon standardisable at all: there are three finishes and a treatment table
  that grows whenever Scryfall names a promo type, so only the finish can have a picture each,
  and what #160 actually asked for — tell a Halo Foil from a plain one — is the word's job on
  every surface anyway.
  **`Aperture` survives in exactly one slot**: a **nonfoil** copy with a trait, where there is
  no finish glyph to keep and the alternative is the 1 718 unusual-but-not-shiny printings
  drawing nothing at all. Iris blades because it has to be told from `Sparkles` and `Gem` at
  12px, where `Sparkle` is `Sparkles` minus two points and `Diamond` is `Gem` without its
  facets. At most one glyph either way, so the corner chip still holds at most a crown and one
  finish mark — the rule in `src/CLAUDE.md` that a third mark wanting that corner means the
  corner is full.
  Two call sites moved with it. The **collection table's** mark was gated on the copy having a
  treatment name, which was right while a treatment had its own glyph and became the same
  one-fact-two-pictures defect inside one table once it did not — it is ungated now, and
  `FinishMark`'s own `null` for a plain copy is what keeps the unmarked case unmarked. The
  **deck card menu's** finish row drew `Sparkles` even when it read `Set as etched`; it takes
  the same two glyphs the marks do, with `Sparkles` standing for the control itself on the
  regular row and the submenu head, since nonfoil has no glyph anywhere in the app.
  The **words** follow the same rule the chip already had: joined with ` · ` where
  there is room for a sentence (a tooltip, an accessible name — "Double Rainbow Foil ·
  Serialized"), and the first one alone where there is room for a column (the pane's per-finish
  price rows, which read `Halo Foil  $95.79`). The collection table keeps the mark in its
  **Name** cell rather than lengthening `Finish · condition`, which is 5.5rem and truncates
  "Nonfoil · NM" as it stands.
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
  finish somewhere else. It has one caller and that caller is now **`features/decks/DeckCardFace`**,
  which both of the deck's card-face views draw — the stack alone until 2026-09-08, and the grid
  tile with it since. A `FinishMark` in the chin beside the
  price says the word better than a fourth badge in a corner the rule break and the quantity tag
  are already competing for. What must never happen is _neither_ — a sheen with nothing naming
  it is decoration, which is the whole of why the chip existed. **It governs the crown too**, in
  the sense that turning the chip off takes whatever is in it with it — and the second clause of
  this sentence has now been rewritten twice inside one day. It read *since the chip is the only
  thing a crown can be drawn as and this face has its banner instead*, then *a crown is a glyph and
  can be drawn anywhere there is room for one — the deck's Grid tile draws it in its marks strip*.
  Both are spent. **A crown on a deck card is printed on the quantity tag**, through
  `CardMarks`' `QuantityTag` and `components/CountTag`'s `crowned` prop, so there is no crown of
  its own in that strip for the chip's absence to be about — and one surviving `mark={false}` here
  would be the *third* crown on the card, the tag under it already wearing one. The bullet below
  is where that is settled and measured.
- **One game changer, one glyph — and what differs is what it is printed _on_** (2026-09-08). It
  is a crown everywhere. On the deck's **two card-face views** it is printed inside
  `CardMarks`' `QuantityTag`, before the number, in the tag's own foreground colour. On the deck's
  **two row views** it is a gold crown in the **quantity column**, with the quantity itself tinted
  the same gold. On **every wall that draws a card as a face** — the search's tiles, the
  collection's, the wishlist's, the three docked search columns — and on `SearchPage`'s printings
  rows, it is `components/GameChangerMark`, the crown standing bare and gold; on the walls it
  shares `FoilOverlay`'s finish chip rather than taking a corner of its own, **a card fact and a
  printing fact in one box**, since a card can be either, both or neither. Nothing derives it: the
  backend flattens `cards.game_changer`'s NULL into `false` (the column is nullable; only
  `card_row.rs`'s parser struct is a `bool`).
  **What this replaced was *one fact, three drawings — a difference of room, never of meaning*, and
  the fact and the meaning are what survive.** The deck's **stacked card** stamped
  `GameChangerBanner` — a gold seal, a 9px crown, `Game Changer` in Cinzel — where a card is 295px
  tall; the deck's **table and text** views abbreviated to `GameChangerBadge`'s gold `GC` where a
  cell has a column; every other surface got the bare crown, because a 150–170px tile is somebody
  else's artwork and a ribbon across it is a sticker over the picture the reader came to look at.
  **Both components are deleted.** *Room* is the half that has gone: the deck annotates a mark it
  was already drawing rather than spending width on a mark of its own, so no surface in the app
  chooses a drawing by how much space it has.
  **Gold survives exactly where the mark is unfilled, and that is one rule rather than two
  colours.** A crown floating over artwork or standing in a line of type has nothing but
  `text-pie-gold` saying which fact it is — and never the destructive colour, because the spec is
  explicit that a game changer (a fact about a powerful card) and a rule break (a problem) must
  never be confusable. A crown printed on a filled `QuantityTag` takes that tag's `fg` instead:
  white on a blue label, dark on a gold one, `NEUTRAL_COUNT_PAINT`'s foreground unlabelled. The tag
  already carries a colour that means the card's **label**, so a fixed gold there would be a second
  colour inside one object — the one mark in the strip ignoring what it stands on, and invisible on
  a Gold-labelled card.
  **What retired the room rule is a measurement, and the arrangement it killed lasted a morning.**
  The deck's Grid tile stopped being a `CardArt` frame with a corner chip on 2026-09-08 and became
  `features/decks/DeckCardFace` — the stacked card, shared — so it draws the stack's own 27px marks
  strip; the design decision was that the tile adopts the stack's marks, and the ribbon was one of
  them. It had held the crown "since 2026-08-16" only because a `CardArt` tile has nowhere else to
  put one. **What no source and no suite could see is that the strip does not narrow with the
  card.** All three marks in it — `QuantityTag`, the game changer and `TheoryMatchMark` — are sized
  off `--mark-scale`, which is the reader's *zoom* and not the tile's width, so a 130px ribbon is
  130px on a 210px stacked card and 130px on a 150px tile.
  **Driven in the shipped window 2026-09-08** (`npm run tauri dev`, a **debug** build, 1920×1080,
  against the real corpus, on a 101-card Commander deck at `cardZoom` 1.1), on a card that is both
  a game changer and an exact plan match: a **28px** tag, a **130px** ribbon and a **28px** tick
  went into a **163px** strip on a **165px** tile — **11px of overflow**, into a face that is
  `overflow-hidden`, so the plan's tick was clipped by nearly half. Every term scales with the
  zoom, so the ratio is constant and it was clipped at *every* stop of the ladder; photographed at
  2× to confirm.
  **The first fix forked the component and the second removed the fork.** For part of that
  afternoon `DeckCardFace` took a required `gameChanger: "banner" | "crown"` — `CardStack` passing
  the first, `GridView` the second — and it measured clean in the same session: tag at **x=1**
  (28 wide), a bare crown at **x=29** (13 wide), tick at **x=136** (28 wide), **overflow 0**, with
  the stack still drawing the ribbon. That is one fact drawn two ways on two drawings of one deck,
  which is exactly what the marks rules exist to refuse, so the crown folded into the tag instead:
  an **11px** crown and a **3px** gap, both scaled by `--mark-scale`, plus one scaled pixel of `mb`
  that is optical rather than structural (`items-center` centres the glyph's box, and mono digits
  sit on a baseline above the middle of theirs). The tag was 28px, so the crowned one is about
  **42px** by arithmetic — narrower than either arm of the fork — and the prop is gone. It moves no
  padding and cannot: `COUNT_TAG_BOX`'s `pl − pr = 5px` is a derivation the content width cancels
  out of. The strip is two marks again, so the tick's `ml-auto` no longer has a third sibling a
  `justify-between` would have spaced around. **jsdom lays nothing out, so every figure above is a
  live claim**, and the ~42px has not itself been read off the window.
- **The two row views reserve the crown's gutter on _every_ row, and that is what keeps the numbers
  in one column** (2026-09-08). A conditional element makes every row a different width and the
  digits step in and out down a list of eighty — `rowMarkColor`'s own reasoning one mark over, which
  returns `transparent` rather than nothing so every row keeps the same 2px of indent. `TextView`
  reserves **10px** (`w-2.5`, `shrink-0`) at the head of the line and draws a `size-2.5` crown in
  it; `TableView` reserves **11px** in the Qty cell and draws a `size-[11px]` crown, both at
  `strokeWidth={2.75}` — an outline glyph at that size needs the weight a filled one gets from its
  body. Neither view zooms, so no `--mark-scale` reaches either and every size is a plain fixed
  number.
  **Neither of the table's two column widths had to grow for it**, which is worth the arithmetic
  because the Qty column's width is the thing any change there has to answer to. The **editable**
  arm is a `6.5rem` (104px) track: 11px of gutter plus the cell's own `gap-1` plus the 80px stepper
  is **95px**, leaving **9px** in hand, and the pair takes the centring the bare stepper had — which
  moves the stepper itself 7.5px right, 12px of slack a side becoming 4.5. The alternative was a
  left-aligned group with all 9px on one edge, and a stepper the reader aims at all day is better
  centred than a gutter that is usually empty. The **read-only** arm is a `3rem` (48px) track
  holding 11 + 4 + one `ch` of the mono face (~7px at `text-xs`) = **~22px**, so it keeps more than
  half the column spare and reads left-to-right off the column's edge as the design draws it.
  **The table is where the words live now.** `GameChangerBadge` stood beside the name with an
  `sr-only` twin, and that twin moved to the quantity cell with the crown rather than being dropped:
  a table row is not an `aria-label`-ed button, so this is the one view in the app whose cell text
  is really read, and losing the words there would have been a real regression. The name column's
  gold left stripe is unchanged, and `rowMarkColor` still gives a rule break precedence over gold —
  so the fact is drawn once in that column instead of twice. On `TextView` there is no such twin and
  there never was: the row **is** a button with an explicit `aria-label`, so the whole gutter is
  `aria-hidden` and the words are `deckCardName`'s.
- **The game-changer _spotlight_ is one CSS rule, and every drawing decision in it is about
  cost or about a collision** (2026-09-08). The ledger's `6 game changers` chip is a toggle:
  hovering it, focusing it, or clicking it to latch fades every deck card that is not a game
  changer to **25 %**. The contract — the two states, the derivation, `aria-pressed`, the chip's
  three appearances, and which box is armed — is in
  [`src/features/decks/CLAUDE.md`](../../src/features/decks/CLAUDE.md); what belongs here is how
  it is *drawn*.
  - **`[data-gc-spotlight] .deck-gc-dimmed:not([data-dnd-dragging]) { opacity: 0.25 }`**, with the
    transition on the class rather than on the rule so the fade runs in both directions: 150ms
    `ease`, which is the deck's own short transition and the same `duration-150` the row hover
    beside it uses. **The `prefers-reduced-motion` arm is not optional**: opacity is a
    non-positional property and `motion`'s `reducedMotion` only reduces positional keys, so a
    fade needs its own opt-out. Reduced, the cards still dim; they simply arrive there.
  - **0.25 is a fade and never a hide.** The dimmed cards keep their layout, their legibility and
    every hit target they had. The spotlight answers *which of these*, and a reader who could no
    longer read or press the rest of the deck would have been given a filter nobody asked for.
  - **The dimmed state is what is marked, and the selector's shape is why.** The inverse spelling
    is `[data-gc-spotlight] *:not(.deck-gc-lit)` — a `:not()` over a **broad subject**, evaluated
    against every element under the deck. The measured cost of that shape in this repo is one
    jsdom play going **3.5 s → 15 s** and a whole run 181 s → 231 s, which is why the majority of
    the cards carry the class and the selector stays one flat descendant compound.
  - **`:not([data-dnd-dragging])` is a specificity collision, not a tidy-up.** The drag rule
    directly above it puts a dragged card at `opacity: 0.75` so the reader can see the pile they
    are aiming at, and dnd-kit stamps its attribute on the source element **in place** — the card
    becomes a popover, and the top layer is a painting order rather than a change of ancestry — so
    a dimmed card dragged under a latched spotlight still matches, at **(0,2,0)** against the drag
    rule's **(0,1,0)**, and would carry the card through the gesture at a quarter. The guard
    qualifies a class rather than the broad subject above, so it costs nothing.
  - **Nothing here has been driven in the shipped window.** jsdom applies no stylesheet, so no
    suite can see any of it either; the only figures above are the ones written into the rule.
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
  2026-08-13 — in the neutral grey, because a printing count has no label to take a colour from.
  One object for both statements: a mark the eye finds before it reads the card only works if the
  two are the same shape, and a number laid on a card had been drawn two ways in one app. The
  `×` went with the chip — a banner in a corner already says "this many", and the sign was a
  second glyph in a 22px box. **A count laid _beside_ a card keeps its `×`**: `OwnedBadge` in the
  caption and the search table's `×132 printings` cell are inline text, where the sign is what
  tells a count from a set number. `CardGrid`'s `topLeft` is consequently the one corner with no
  backing under it — a chip behind a banner frames a frame — while `badge` (bottom-left) keeps
  the wall's felt, so the wall still owns the _corner_ and owns nothing about the paint.
  **`UNTAGGED_COLOR` moved with the shape**, from `features/decks/labelColors.ts` to `CountTag`'s
  own `NEUTRAL_COUNT_PAINT`: the search wall draws this over cards that have no labels at all, so
  the neutral fill is a fact about the mark rather than about that palette.
  **Driven in the shipped window 2026-08-14** (`npm run tauri dev`, a **debug** build at
  1280×800, against the real 116 703-card corpus): a tile's corner computed `background-color:
rgb(200, 196, 191)` — `--color-pie-c`, `#c8c4bf` — with `color: oklch(0.2 0.02 85)`,
  `clip-path: polygon(0px 0px, 100% 0px, calc(100% - 10px) 100%, 0px 100%)`,
  `aria-hidden="true"`, and text `2` / `4` with **no `×`**. It measures **25 × 22** inset **4px**
  top and left of a **170 × 238** tile, overflowing neither edge, and its wrapper computed
  `background-color: rgba(0, 0, 0, 0)` with `pointer-events: auto`. The deck editor's own labels
  on the same build measured **25 × 22**, the same fill and the same clip, `position: relative` and
  `z-index: 1` — the two surfaces are one box, which is the claim the whole change rests on and
  the only one a screenshot could not settle. **The name coverage did not move**: 25px plus the
  4px inset against the old chip's ~28px for `×2`, so the tile's printed name loses what it
  always lost. **One arm was not driven** — the _coloured_ label, since the deck to hand carried
  no labelled cards; `CardStack.test.tsx` and `CountTag`'s `Painted` story are what hold that path.
- **And the printing count stopped being that tag the next day — it says the word now**
  (2026-08-15). `132 printings`, in the wall's own `bg-bg/85` chip, at `text-[10px]`. The bullet
  above is the record of the shape it replaced and every figure in it was true of that shape; what
  it got wrong is the half it argued hardest for. "One object for both statements" is right about
  the _drawing_ and wrong about the _statement_: the deck stack's bare number is printed **on a
  label**, so the thing beside it says which quantity is being counted, and the search wall's bare
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
  answers it): `search`, `tags`, `collection` and `wishlist`, the page-sized list walls;
  `deckSearch`, `collectionSearch` and `wishlistSearch`, the three **docked search columns**, each
  of which is a second `CardGrid` on a page that already has one; `deck`, the editor's desk — **one
  key for both deck views**, because Stacks and Grid are two drawings of the same pile and
  switching between them must not resize the cards the reader just settled on; `deckGallery`, the
  decks page's wall of deck tiles and folder cards; and `printings`, the modal's wall, which opens
  *over* a wall the reader has already sized. `useCardZoomGesture(ref, section)` names the section
  it is stepping. **`collectionSearch` and `wishlistSearch` are 2026-09-07's**, and they are their
  own keys for `deckSearch`'s reason exactly: a sidebar's tiles and the page wall's tiles are on
  screen at once and are two different questions — *how big are the cards I am shopping through*
  against *how big is the binder I am filing*.
  **The wishlist joined the list on 2026-08-20**, when it gained a card view of its own; until then
  it was `VirtualTable` only and had no card section to zoom.
- **The decks gallery joined on 2026-08-26, and it is the one section whose tiles are not cards.**
  A deck tile is a 626×457 art crop with a name, a format line, a LIVE/THEORY badge and a credit
  under it — but the reader's question there is every other section's: how many of these at once,
  against how well I can see each one. Three things about it are worth carrying:
  - **`deckGallery`, not `decks`.** `deck` is already the editor's cards and both keys are read
    inside `features/decks/`; two keys one character apart are a typo that steps a wall the reader
    is not looking at, which reads as a gesture that does nothing rather than as a mistake.
  - **The listener is on the tiles' scroller, not on the view.** The folder tree beside the wall is
    navigation chrome at a fixed rail width with nothing to scale, so a ctrl+wheel over the rail is
    the browser's business. `DecksPage.test.tsx`'s "ignores a ctrl+wheel over the folder tree" is
    the case that pins it — every other assertion there passes just as well with the listener on
    the whole page.
  - **Rust needed nothing.** `zoom.rs` validates the multiplier and deliberately does not know the
    section vocabulary (`a_section_this_build_does_not_know_is_stored_anyway`), so an eighth wall
    is remembered across restarts by the machinery that was already there.
- **What is drawn _on_ a card scales with it, through two inherited custom properties**
  (2026-08-17). Until then the zoom sized the tile and nothing else: the finish chip, the crown, the
  owned badge, the printings count, the rarity gem, the caption, the deck's copy count and label dot,
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
    `RarityGem`, `OwnedBadge`, `FinishMark`, `LabelDot`, `CountTag` and `QuantityStepper` are each
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
    card), and the gutters `CardGrid` splits either side of a row. **A sixth entry read "the
    banner's drop shadow" and went with the banner on 2026-09-08** — `GameChangerBanner` is
    deleted, and the crown that replaced it is an 11px glyph inside `QuantityTag` that scales like
    every other term in that box.
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
    (**The banner reading is history**: `GameChangerBanner` was deleted on 2026-09-08 and the crown
    is 11px inside the quantity tag, which widens that tag's own figures by 14px at 1×. Every other
    number here is untouched.)
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
  starts at `DEFAULT_ZOOM`. Two guards keep a further section from arriving silently:
  `DEFAULT_SECTION_ZOOMS` is spelled out as a literal rather than reduced over `ZOOM_SECTIONS`, so
  `Record<ZoomSection, number>` makes a new section a compile error until somebody has said what it
  starts at; and `CardGrid`'s `zoomSection` prop is **required**, so a new wall cannot default into
  sharing another wall's number.
- **Each section's size outlives the process** (issue #175, 2026-08-22). This reverses the second
  half of the rule above — "**session-only**: no persistence, no SQLite, no IPC, … restoring 200%
  tiles on launch explains itself to nobody" — and the reversal is the same one the split above
  made, arriving late. That argument was written when there was **one** number for the whole app,
  where "the zoom" really was a momentary posture a single card could set for every wall at once.
  Split per section it is not: a reader who sizes the deck editor so a 100-card pile fits the desk
  has configured *that wall*, and the app forgetting it every launch was the reported complaint.
  What survives of the old worry is answered by the split itself — a size is restored to the wall
  it was chosen on and nowhere else, so nothing done in the printings modal is waiting on the search
  page.

  One `app_meta` row, `card_zoom`, holding a JSON object of section → multiplier
  (`src-tauri/src/zoom.rs`); `src/lib/useCardZoomPersistence.ts` is the whole of the frontend and
  `AppShell` is its only mount. Five decisions in it, each with a failure it is avoiding:

  - **The row is an object, not one key per section.** Every wall is seeded in one pass at launch,
    so a key each would be a read of that table each, to answer one question. The cost is that a
    write is a read-modify-write — one extra `SELECT` under a lock the writer already holds.
  - **A write preserves entries this build cannot use**, which is the one thing an object row has
    to get right that a bare string does not: an eighth wall, or a multiplier past this build's
    ceiling, survives a write made beside it rather than being emptied by an older build pointed at
    the same `mtg.db`. Validation applies to what *this* call writes and never to what it writes
    beside.
  - **Rust bounds the number (0.5–2) and deliberately does not know the stops.** Where the rungs sit
    is a question about how a gesture feels and stays in `cardZoom.ts`; how far a stored value may
    stray is a question about what may land in a column. So `snapZoom` puts a restored value back on
    the ladder on this side, which keeps `cardZoom` holding one of sixteen exact numbers — the
    invariant `zoom === 1` rests on — true of a *restored* session as well as a fresh one.
  - **The seed does not pulse.** `hydrateCardZoom` is a second door onto `cardZoom` and pulses
    nothing: the badge is a HUD about a gesture, and a value arriving from storage is not one.
    Pulsing here would greet every launch with a percentage floating over a wall nobody touched. It
    also drops itself entirely if `zoomPulse !== 0` — a reader who spun the wheel inside the read's
    round trip keeps what they asked for, rather than watching the wall snap back under their hand.
  - **The writes hang off `zoomPulse`, not off `cardZoom`, on a 400ms trailing timer per section.**
    Watching the value gets two cases wrong in opposite directions: it writes back everything the
    seed just applied (a round trip per wall to tell the database what it said a moment earlier), and it
    *misses* a reader holding the wheel at 200%, whose gestures `stepZoom` answers with 200% forever
    — the value never moves, so the timer never restarts and the write lands mid-gesture. The
    debounce is not an optimisation: a trackpad pinch arrives as ctrl-flagged wheel events dozens a
    second, so per-notch writes would be a run of read-modify-writes for a value obsolete before it
    committed. What 400ms costs is a zoom made in the last 400ms before the app closes. Both
    failures — a read that never answers, a write refused with `BUSY` under a first-run sync — are
    swallowed: the first leaves every wall at `DEFAULT_ZOOM`, which is a complete app, and the
    second costs only the next launch's starting size.
- **A list's grid-or-table choice is remembered too, and it is `card_zoom`'s mechanism with one
  deliberate difference** (2026-08-26). One `app_meta` row, `list_view`, holding a JSON object of
  section → `"grid"`/`"table"` (`src-tauri/src/listview.rs`); `src/lib/useListViewPersistence.ts`
  is the whole of the frontend and `AppShell` is its only mount. It copies the object row, the
  preserve-what-you-do-not-understand write, the per-entry fallback, the `hydrate…` seed with its
  `pulse !== 0` guard, and the swallow-every-failure rule. Three things differ, and each is the same
  argument reaching a different answer:

  - **The bound is a vocabulary rather than a range.** Rust knows the two words `grid` and `table`
    and refuses anything else at the write end — `card::store_group_by`'s shape — while it goes on
    knowing nothing about *which lists exist*, because that is `LIST_SECTIONS` in `store.ts`. So an
    unknown layout is dropped on the way out and an unknown section is not: the asymmetry is what
    `isListSection` on the frontend exists for.
  - **There is no debounce.** A zoom is a stream — a pinch arrives dozens of times a second — and a
    layout is one deliberate press on one of two buttons. The write goes on the press, and the row
    is touched exactly as often as the reader touches the control.
  - **The default it protects moved.** The collection opened on the *table* until this landed, on
    the argument that a collection is read for what is in it. All four lists open on art now,
    because a default that survives one press is a much weaker claim than one re-made on every
    launch — a reader who wants the table presses once, ever.
- **The zoom rescales tile _geometry_; it is never a `transform: scale()`.** A transform was the
  obvious cheap answer and is wrong three times over: it resamples art that is already a downscale
  of a 672px `display` image, it leaves the virtualiser measuring pre-transform boxes so the scrollbar
  stops matching the content, and it desynchronises the deck editor's drag-and-drop hit testing from
  what is painted. Rescaling the numbers keeps text crisp, lets the wall reflow to a new column
  count, and keeps `CardGrid`'s existing `virtualizer.measure()` effect — already keyed on
  `tileHeight` — correct for free.
- **A ladder, not a multiplier** — `src/lib/cardZoom.ts`. A wheel `deltaY` is
  not a magnitude worth trusting: a mouse notch arrives as 100 through Chromium's line mode and 120
  from a driver reporting raw ticks, while a precision trackpad's pinch reaches the page as a stream
  of ctrl-flagged wheel events in the single digits, dozens a second. The ladder makes the unit the
  **gesture**. It also keeps the value exact — `zoom * 1.1` applied and undone eight times is
  0.9999999999999998, which formats as "100%" while sizing every tile a hair off.
- **Sixteen stops, evenly spaced ten points apart from 50% to 200%** (changed 2026-08-22). This
  replaced ten uneven ones shaped like a browser's zoom menu — `0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25,
  1.5, 1.75, 2`, coarse at the ends and fine either side of 100%. The old shape's argument (the
  stops near 1× are where a reader is steering) is still true; what it got wrong is the input. A
  browser's ladder is walked by **pressing a key**, where each press is a deliberate act and a menu
  shows you the list; this one is walked by **rolling a wheel**, where the stops go past in a
  continuous run — and above 1× the old ladder moved 10, 15, 25, 25, 25 points a notch, so the same
  wrist movement moved the cards two and a half times as far at the top of the range as at the
  bottom. Even spacing costs the top some reach (200% is ten notches up from life size rather than
  five) and buys the thing a wheel gesture needs: one notch always means the same amount. It also
  makes every stop a round figure the badge can name — 50%, 60% … 200% and nothing else.
  `ZOOM_STEPS` is **spelled out as literals rather than generated**, for the reason the ladder
  exists at all: 0.1 added seven times is 0.7999999999999999. One stop is still not round in binary
  (1.1 × 100 is 110.00000000000001), which is why `formatZoom` rounds.
- **Driven in the shipped window 2026-08-22** (`npm run tauri dev`, a **debug** build at 1920×1080,
  a first-run sync of 116,700 cards, the search wall on `bolt` at 37 results), because the one
  claim this feature makes — a size surviving a **restart** — is the one thing no jsdom suite can
  reach. The wheel was dispatched synthetically on the scroller, the same carve-out the 2026-08-14
  pass recorded: the handler and everything downstream were exercised, the `preventDefault`/WebView2
  page-zoom interaction was **not** re-proved.

  - **The ladder steps ten points a notch.** The 170px base tile drew **170 → 221 → 272** over six
    notches up — `scaled(170, 1.3)` and `scaled(170, 1.6)`. On the old ladder six notches up was
    1.75; three was 1.25, which would have drawn 213 rather than 221.
  - **The gesture reaches `app_meta` and the row holds one entry per wall.** After the wheel
    stopped, `select value from app_meta where key = 'card_zoom'` read **`{"search":1.6}`** — the
    section named, and nothing invented for the six walls nobody had touched.
  - **The restart is the whole feature and it works.** The process was stopped, `tauri dev`
    relaunched, and the same search re-run: the wall drew **272px** from its first paint, and **no
    badge appeared** — the seed does not pulse, so a launch says nothing about a size it restored.
  - **The write path is live in the restored session too**, which is the half a read-only check
    would miss. Four notches down drew **204px** (`scaled(170, 1.2)`) and the row read
    **`{"search":1.2}`** — updated in place rather than accumulating a second entry.
  - **Two reads that lie, both already on the trap list.** A width read in the *same* `cdp.mjs eval`
    as the wheel dispatch answers about the frame before React re-rendered — two notches read back
    as "no change" and looked exactly like a dead handler until the dispatch and the measurement
    were split into separate evals. And `root.childElementCount` is **0** for a few seconds after
    `tauri dev` reports the process, which is the blank-window tell rather than a blank window.
- **The zoom sizes the _tile_, and the column count is what falls out of it** (changed
  2026-08-14). `CardGrid` draws a tile at `scaled(baseTileWidth, cardZoom)` exactly, fits however
  many of that size the wall holds, and splits the remainder either side of the row
  (`sideGutterFor`). **It used to scale a _floor_ and stretch the tiles to fill the row**, so the
  wall reached both edges at every window size — flush was the whole argument, and it cost the
  gesture its meaning. A stretched tile's width is a function of the **column count**, which is a
  step function of the zoom, so most stops drew exactly what the stop before them drew. Measured
  on the deck editor's docked column, whose wall is **330px** in the running window, the ten stops
  the ladder had then collapsed to **three** distinct card widths — 102, 102, 159, 159, 159, 331,
  331, 331, 331, 331. Seven gestures in a row that moved nothing, which reads as an app that has
  stopped listening rather than as a wall that is already right. **Driven in the shipped window
  2026-08-14** (`npm run tauri dev`, a debug build, 1280×800), the same column answered all
  ten, strictly increasing, and stayed centred throughout — **the stops below are the ladder as it
  was on that date**, and the even sixteen-stop ladder replaced them on 2026-08-22 without changing
  anything this measurement was about:

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
- **The decks page's folder tree is draggable from its right edge, and rails to 36px**
  (2026-09-08) — the same `ResizeHandle` as the search columns, `side="left"`, and the same
  three-state root the docked panels use. It was `w-52`/208px and fixed; 208 is now the width a
  database nobody has dragged opens at (`DEFAULT_FOLDER_TREE_WIDTH_PX`), and
  `MIN_FOLDER_TREE_WIDTH_PX` is **176**, and the way it was arrived at is the point: it shipped as
  **160**, hand-counted off the markup, and the live pass caught the count 9px optimistic. Read in
  headless Edge over the real stylesheet, the two rows' fixed costs are **89** (heading) and
  **134** (a top-level folder row), so at 160 the word `Folders` had 71 against the **76** it needs
  and the one piece of chrome naming the column rendered `FOLDE…`, while a name got 26px — `Co…`.
  176 clears the heading by 11px and gives a name 42. **The sums live once, on the constant
  itself**; repeating them here is how a figure and its markup drift apart, which this file has
  watched happen before.
  - **The lesson is the one this repo keeps relearning**: the arithmetic was reasonable, written
    down carefully, and wrong, and neither suite could see it — jsdom lays out nothing, so every
    test asserting `aria-valuemin` was green against a floor whose own heading was elided. A
    width that is only ever *computed* is a width nobody has looked at.
  - **The cap is the desk's, through `useDeskWidth`**, which grew an options bag the same day so
    one hook serves both arrangements: `{ gap, min }`, defaulting to the search rows' `gap-4`/206
    so the collection and wishlist call sites are behaviourally untouched. The decks desk passes
    `gap: 20` (its `gap-5`) and a floor of `scaled(TILE_MIN_WIDTH, zoom)` — **one deck tile at the
    reader's own zoom**, so zooming the gallery out genuinely buys the tree width back, which is
    why this page's `NO_ROOM` says *zoom the decks out or widen the window* rather than repeating
    the deck editor's remedy (there is no card pane here to close).
  - **The rail costs the tree's drop targets, and that is accepted rather than worked around.**
    Railed, no folder row is mounted, so a deck cannot be dragged *into the tree*; filing still
    goes through the wall's own folder cards and the row menu's `Move to folder…`. A
    hover-to-expand-mid-drag would be mechanism for a gesture the wall already serves.
  - **The chevron's name is read off what is _drawn_, not off the reader's stored answer**, which
    is `CardSearchPanel`'s wiring and matters in exactly one state: a tree the reader left open on
    a row that has since lost the room. Naming the press there announced *"Collapse folders,
    collapsed"* — a control contradicting the state word beside it. Naming the drawing says
    *"Expand folders, collapsed"*; that the press is then refused is what `aria-disabled` and the
    tooltip say, and they are what a reader meets first.
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
- **That column is three columns since 2026-09-07, and every number above is now
  `features/search/CardSearchPanel.tsx`'s rather than the deck editor's.** The collection page and
  the wishlist page each grew a docked, collapsible card search of their own
  ([issue #356](https://github.com/Msgaihede/mtg-grimoire/issues/356)), because both pages' empty
  states said in as many words that the way to add a card was to leave the page. The chrome is
  **extracted, not copied**: `CardSearchPanel.tsx` is the shell — the three-state `<section>`, the
  36px rail, the disclosure and its `NO_ROOM` tooltip, the vertical rail heading,
  the width `useState` and the clamp split, the `open`/`shown`/`over`/`overlaid` derivations and
  the caret hand-back — and `CardSearchBody.tsx` is the wall and its furniture in the order the
  deck panel always drew them.
  **`ResizeHandle` left that list on 2026-09-08 and is now `components/ResizeHandle.tsx`**, a
  second extraction with the same argument one level up: the decks page's folder tree needed the
  identical splitter docked the other way round, and the alternative was a fourth copy of the
  pointer capture, the ARIA and the key map. It takes `side: "left" | "right"` — the edge the
  panel is docked against — which flips exactly three things and nothing else: the strip's offset
  (`-left-1`/`-right-1`), the drag arithmetic's sign, and which arrow widens. **The proof the
  extraction was faithful is that `CardSearchPanel.test.tsx` and `DeckSearchPanel.test.tsx` both
  stayed green with no edit** — the same standard the shell's own extraction was held to. Copying it twice would have been the mistake this repo has made and
  undone twice already (`CollectionSearchTab`'s own filter row, the deck Grid view's inline card
  frame): **a resemblance is N independent decisions that happen to agree today.**
  `DeckSearchPanel` went **1595 → 778 lines on the day** and kept every deck-shaped thing — the tab
  strip, `CollectionSearchTab`, `categories`/`targetCategoryId`/`AUTO_CATEGORY`, the landed glow,
  `availableForDeck`, the format seed. **The proof of a faithful extraction is that nothing
  changed**: its whole test file and its whole story file stayed green with **no edit to either**,
  which is why they were the acceptance criterion rather than a new suite — and an edit either of
  them seemed to need was the signal that behaviour had moved. (No count of them is written here on
  purpose. A test total is a fact about a *tree*, every open branch has a different one, and this
  repo deleted its Storybook totals after they conflicted on five consecutive merges of `main`.)
  - **Three gates, not two, and they must stay three.** `open` *mounts* the body, so a page nobody
    searched from issues no `search_cards`; `shown` merely *hides* it, so a window narrowing keeps
    the reader's typed query, filters and fetched pages; `overlaid` decides position and width
    source. Folding `open` and `roomy` into one gate throws a reader's search away on a **resize**,
    and that is the single most load-bearing assertion in `DeckSearchPanel.test.tsx`. The `hidden`
    **attribute** rides beside the `hidden` class, because jsdom loads no stylesheet.
  - **`data-search-over` is reused rather than tripled.** Its own doc warns that a second element
    answering `[data-search-over]` would make the deck's probes ambiguous — but the three panels
    live on three routes and can never be on screen together, and the attribute's *value*
    (`"deck"` | `"collection"` | `"wishlist"`) already discriminates. `"deck"` keeps every meaning
    it had. The *argument* is reused word for word from `DeckEditor`'s old `PANE_OVER_ATTR`: the
    difference between the two placements is a `position` and a width, both of which jsdom reads as
    nothing, so the **choice** is stamped where a suite and a CDP pass can both ask about it and
    the geometry stays a live-window question. ⚠️ **`PANE_OVER_ATTR` itself no longer exists** — it
    went with the docked card pane on 2026-09-03, when the pane became `CardDetailModal` — so it is
    a precedent to reason from and not an attribute to grep for. `CardSearchPanel.tsx`'s own doc
    comment still describes it in the present tense.
  - **No tab strip on the two new panels.** The deck's `Collection` / `All cards` pair exists
    because a deck is built out of cards you already have; on the collection page the first tab
    would search the very list on screen, and on the wishlist it would search a list the reader is
    not filling. These panels **are** the `All cards` tab, which also gives back the **141px** the
    strip costs at the panel's 206px floor.
  - **The destination is locked and the switch is not drawn.** `AddToCollectionButton`'s
    `Collection` / `Wishlist` chip pair is right on the search page, where a reader genuinely is
    choosing; here the page has already answered. `lockMode` pins it, and that is what keeps the
    folder default unambiguous — the two folder trees are different tables, so a popup that could
    flip lists mid-form would need two defaults and a picker that swapped trees under the reader's
    hand. The override is a `Folder` row in the popup that swaps the panel body **in place** for
    `MoveToFolder` in its `inline` mode — the shape `EditWish`'s folder row and `PickCopies`
    already use, and deliberately not a nested popup, so there is **one Escape rung** rather than
    two.
  - ⚠️ **The `+`'s accessible name changed on every card surface in the app, not just here.** It
    is `Add {name} ({SET} {num}) to {destination}` — the deck panel's own rule
    (`Add Ancient Tomb to Land`) applied — where the destination is the folder's name when there is
    one and **`Collection` / `Wishlist` at the root**. That last word was lowercase (`to
    collection`) until 2026-09-07, and because the new props are all optional the *name* change
    still reaches the Search page, the Tags page and the printings modal, which pass none of them
    and go on filing at the root. **A probe matching the old lowercase form finds nothing**, which
    is the kind of break a prose-only doc cannot go red for — it is written here so a stale
    `getByRole("button", { name: /to collection/ })` has somewhere to be looked up.
  - **Each surface invents its own bookkeeping and none of it is shared.** `ZoomSection`
    (`collectionSearch` / `wishlistSearch`, added to the `DEFAULT_SECTION_ZOOMS` literal so a new
    section is a compile error until somebody says what it starts at), `selectionScope`
    (`collection-panel` / `wishlist-panel` — two walls on one screen must pass different scopes or
    picking in the sidebar puts the binder's selection down), `FilterLabels.idStem`
    (`collection-add` / `wishlist-add`, because two mounted filter rows would otherwise share
    `id`s) and the section `aria-label` (`Add cards to your collection` / `…your wishlist`, so two
    panels' probes do not answer to one name). The filter box keeps the app-wide name
    `Search cards`, which is unique on each page because the page's own box is
    `Search your collection` / `Search your wishlist`.
  - **The dock's height is imperative and now shared.** CSS cannot say *"the scroller's visible
    height, less however much of the page sits above this row"*, so `DeckEditor` had sized its dock
    in a `useLayoutEffect`. That is `src/lib/useDockHeight.ts` now, and it finds the *nearest
    scrolling ancestor* rather than assuming one — the deck editor's own page section is
    `overflow-y-auto` while these two pages scroll in `AppShell`'s `main`. All three sites call it.
  - **The row's arithmetic is `src/lib/useDeskWidth.ts`**, and it was two byte-identical copies for
    about a day before it was one. `maxPanelWidth = min(⌊viewport / 2⌋, deskWidth − DESK_GAP −
    floor)`, `roomy = deskWidth === 0 || maxPanelWidth >= MIN_PANEL_WIDTH_PX`, and an `overWidth`
    of the whole row for a desk that cannot hold both. `viewport` is
    `document.documentElement.clientWidth` and **never `innerWidth`**, which counts the page
    scrollbar and caps the panel 8px too wide (632 against 640, measured on the deck editor);
    `deskWidth === 0` reads as **roomy**, which is what keeps jsdom and the first paint out of the
    way. **`DeckEditor` is deliberately not a caller**: its `panelOverWidth` carries an extra
    `selectedCardId === null` clause, its desk mounts only once `deck_get` has answered, and it
    measures a desk holding a deck rather than a list — three differences, none cosmetic.
  - **The floor is the _view's_, not the page's, and that is a measurement rather than a
    refinement.** Driven 2026-09-07 (`npm run tauri dev`, a **debug** build, against a real
    276-copy collection and 89-wish list) at viewport widths of 1584, 1384, 1264, 1134, 1118, 1008,
    884, 784, 544, 414 and 374.
    - **The card wall really does hold at 192.** Its `scrollWidth` never exceeded its `clientWidth`
      at any width, and it went on drawing tiles down to a 192px list — four of them at 360, five
      at 192. `CARD_FLOOR` is the deck's `DECK_FLOOR` borrowed, confirmed.
    - **The table does not, and it failed at a window nobody would call narrow.**
      `CollectionTable`'s five fixed columns measure **464** and its gaps another **~101**, so its
      name column is `list − 565` — linear, checked at three widths: a 936px list gives **371**,
      736 gives **171**, and **616 gives 51**. 616 is what this page's list got at the app's own
      **1280×800** with the panel at its 384 opening width, so the shipped default put card names
      in a 51px column. Below a 486px list the name column is *gone* and the table scrolls sideways
      inside its own root — **no page-wide scrollbar, because `min-w-0` holds**, which is exactly
      why neither suite nor a screenshot of the whole window would ever have caught it.
    - **`TABLE_FLOOR` is 680 on the collection and 610 on the wishlist**, and the two differ because
      the two tables draw different columns: `WishlistTable`'s name column reads 335 / **122** / 25
      at the same three rungs where the collection's reads 371 / 51 / gone. Agreeing on one number
      would be the two pages agreeing on a figure neither measured.
    - **After the fix, at 1280×800: list 680, panel 320, name column 115.** The panel gives up 64px
      and stays comfortably docked. Switching back to the card view returns it to 384 — the clamp
      split working, since the cap clamps what is *drawn* and only a drag clamps what is *stored*.
    - **Not folded into one number for both views.** A single floor at the table's figure would push
      the panel to its overlay at 1024 on the card view, where a 360px list was measured drawing
      four tiles with no overflow at all — a working layout refused because a different view could
      not have used it. `useDeskWidth` takes `floor` as a parameter for exactly this.
  - **The overlay ships too**, and it is the half a phone needs. Below the floor the shell already
    knows how to draw itself *over* the list at the full row width, so the plumbing is one more
    number from the page. Without it a narrow window would offer a sidebar that is only ever a
    greyed chevron.
  - **The two lists open _railed_ where the deck opens open, and the overlay is why.** These pages
    have no docked card pane to suppress the overlay, so `roomy === false` always implies an
    `overWidth` — measured, the panel is `data-search-over` at **544px and below** and there is no
    rail state to fall back to. A default of open therefore meant arriving at your own wishlist to
    find a card search drawn over it. The second reason is desktop-side and independent: these
    pages already draw a `FilterBar` of their own, so opening open puts two filter rows on screen
    before the reader has asked for either. Neither argument touches a *deck*, which has no second
    filter row and no list being covered, so `DEFAULT_SEARCH_OPEN` is `{ deck: true, collection:
    false, wishlist: false }`. A rail is not an absence — 36px of chevron with `Search cards` turned
    on its side — and the press is remembered per section forever after.
  - **One overflow at 414px is _not_ this column's, and it was checked rather than assumed.** At a
    414px window the nav rail is still 208px (`PHONE_PX` is 390, so `BottomTabBar` has not taken
    over) and `main` overflows horizontally by **105px**. Collapsing the panel to its rail leaves
    **90** of that, so 90px is the wishlist's own figure-row actions and 15px is the rail. The page
    was already broken at that width; at a true phone width (374, tab bar engaged) `main` overflows
    by **0**.
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
  card backs. `CardGrid`'s caption was also **derived** rather than written down
  (`ceil(24 × CONTROL_SHRINK) + 4` = 25), because the button it was a budget for was no longer 24px
  and the two drifting apart is exactly the row overlap the constant existed to prevent.
  **That constant is gone as of 2026-08-26** — the caption became `components/CardChin` and the
  budget became `chinHeight(zoom) - CHIN_RISE`, with the quick-add moved off the foot and over the
  art where it costs the wall no height at all. See the chin's own section at the end of this page.
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
  on; and the border is transparent rather than absent, for the arithmetic above.
  **Both of those values changed on 2026-09-03, and the second half of that first clause is now
  the opposite of what it says**: the ring is `ring-1 ring-inset ring-accent/45` and the wash
  `bg-accent/15`, and an inset ring is painted *within* the border box. What stands above is what
  was measured on the day and is left as measured — the marks section below carries the change and
  the reader report behind it. `opacity-60` also
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
  - **`TableView` and `GridView` never called `splitRail`** — they drew `groups` in the order they
    were handed — so for those two the whole of this change was that the command zones come first.
    **Both call it since 2026-09-08 and no view is outside it now.** Each renders
    `[...command, ...flow, ...rail]`, the same concatenation the two column views and `deckWalk.ts`
    make, so the Sideboard, the Maybeboard and every switched-off pile come **last**. On a real
    Commander deck the old order read `Commander → Sideboard (3) → Maybeboard (19) → the deck` in
    both — roughly 900px of wall, and four bands, spent on the piles the reader has said are not in
    the deck, in front of the deck itself (measured 2026-09-08, debug build, 1920×1080).
    It is **ordering only and deliberately not a rail** in either: a group on the wall is as wide
    as the desk, so a 19-card Maybeboard in a one-tile rail column is ~4 500px of scroll against
    the same nineteen cards in a stack, which `stackHeight` makes roughly a fifth of that
    (arithmetic, not a reading); and a table has one axis, so a rail is not a shape it has. The
    piles move to the end of the list and stay full-width wrapping groups and bands.
    What that closes as a side effect is a range: a Shift-click now follows what is under the
    pointer even where it crosses the rail boundary, on every view rather than on two of four.
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
  inner dismissible layer (popup, listbox, menu, and every `Dialog`) listens on `window` in the
  **capture** phase and calls `preventDefault()`; an outer one (`KeyMap`'s shortcuts panel —
  the docked card detail pane until 2026-09-03) listens in the
  bubble phase and returns early on `e.defaultPrevented`. Capture is load-bearing: two
  `window` listeners for one event run in _registration_ order, and the outer layer was
  mounted first, so in the bubble phase it would act before the popup and read
  `defaultPrevented` as false. Every new dismissible layer follows this or it will close
  something it did not open. Pinned by `App.test.tsx`'s Escape-stack test.
- A layer that Escape dismissed hands focus back to whatever opened it, _before_ React
  flushes the close (the element is still mounted). An outside-click deliberately does not
  — the reader is already somewhere else.
  **One kind of layer breaks that parenthetical without breaking the rule, and it arrived on
  2026-09-03 with the folder wall's naming tiles.** Where a layer *replaces* its own opener —
  `New folder`'s tile becoming the field it used to raise, a folder card becoming the field its
  `⋯` used to raise — the opener is **not** still mounted, so focusing the remembered element is
  a call on a detached node: a silent no-op, with nothing on screen and nothing in the console to
  say the caret went to `<body>`. The element that should take it is the one React has just
  rendered in the opener's place, and only the host knows which that is; `useFolderFieldReturn`
  in `components/FolderNameField.tsx` refs it and restores on the close. **What keeps that from
  becoming an exception to the second sentence as well is a test on
  `document.activeElement`** — it restores only where the caret is `null` or `document.body`,
  which is exactly the state Escape, the ✕ and a committed write all leave behind, so an outside
  click that landed on something else keeps its own. **That last clause is reasoned and not
  observed**: the last section on this page measured the tiles' geometry over the built CSS, but
  where the caret actually lands after each of the four exits is one of the three things it still
  owes, and only the shipped window can answer it.
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
  _below_ the header — a row has to scroll under one. **The word _virtualised_ started doing
  real work in that sentence on 2026-09-08**, when `VirtualTable` gained an opt-in `grow` and the
  deck's table took it: those rows are `relative` with a `minHeight`, so a bare one is no stacking
  context and caps nothing. The three 100k-row walls still virtualise and the sentence is theirs
  unchanged; `LAYER.raisedWhenPopupOpen` stays unconditional either way, because under `grow` it is
  no longer *lifting a capped popup* but still *raising the row over the rows below it*, which
  paint later simply for being later in the DOM. Variant spellings
  (`has-[[aria-expanded=true]]:z-10`) are their own entries, written out: Tailwind scans
  source text for whole class names, so a class built by interpolation emits no rule at all.
- **The ladder is `raised 10 < header 20 < popup 30 < dragTray 40 < overlay 45 <
  overlayStacked 46 < tooltip 47 < gate 50 < caption 60`**, and `layers.test.ts` asserts every
  link of it. **`overlayStacked` was added on 2026-09-03 and pushed `tooltip` up one**, when the
  card detail modal grew nested overlays that open over it: two `fixed inset-0` scrims at one
  number, neither inside the other, is the document-order bug `layers.ts` opens with, and a
  tooltip has to clear the highest rung a *dialog* is drawn at rather than a particular number.
  **`caption` was added on 2026-08-22 to fix a bug that had shipped, and the bug is the reason
  to keep it.** `TitleBar` draws the window's frame because `tauri.conf.json` sets
  `decorations: false`, and it is a **flex item at `z-auto`** — while both of the app's
  full-window surfaces are `fixed inset-0`. A positioned element paints over non-positioned
  content in the same stacking context however small its number, so the bar was not losing the
  ordering contest, it was never in it. Driven in the shipped window that day: on a first
  launch the overlay measured 1920×1080 at `gate`, `document.elementFromPoint` over the Close
  button answered the **overlay**, and no caption was drawn for the whole ~90s sync — Alt+F4
  was the only way to quit. `Dialog`'s scrim is the same shape at `overlay`, so all of the
  editor's modals did it too. `AppShell`'s comment had asserted the opposite since the row
  replaced Windows' caption, which is how it went unnoticed: the claim was written down, so
  nobody checked it. **The fix is a rung and not a bound on each surface** — stopping the
  overlays at the bar's height copies `BAR_H` into each file, cannot be written as a Tailwind
  class built from a constant, and covers only the surfaces that exist today. Above `tooltip`
  costs nothing, and that is the one overlap worth checking rather than assuming: the caption
  buttons are the app's only anchors on the window's top edge, and `placeTooltip` already flips
  those downward, so their panels are drawn below the row and never inside it. **`overlay` is one rung for every full-window
  surface, deliberately, where two looks more careful**: the deck editor's **six** — Import,
  Categories, Labels, History, Theory diff, Deck settings — are held in **one** piece of
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
  `CategoriesDialog` and `LabelsDialog` — two sections of one drawer that each cost a press and a
  scroll are two dialogs one press apart, each sized for what it draws. All of them and
  `DeckSettingsDialog` are now built on **one shell, `src/components/Dialog.tsx`**, so
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

  **A clamped panel is not yet a floating one, and 5vh of glass is what makes it one**
  (2026-09-08). Once the clamp above worked, a dialog whose body outgrows the window drew to
  `max-h-full` — the scrim's padded box, which was a flat 24px (`sm:p-6`). So the panel stopped
  **24px** short of the window's top edge, hard against the title bar, and read as a page rather
  than as a panel over the app. It was reported against `AllPrintingsDialog`, whose body is a
  wall — 865 printings of Forest is not an edge case, and the ceiling binds on most of the presses
  that reach it — and it was fixed there first, in that host's own `size` string, on the same day.
  That fix lasted two days and was one dialog too narrow: Categories on a long deck, History, Pull
  from collection and Import all reach the same wall, so the rule moved to the shell.

  **It is the ceiling stated as an inset, which is this scrim's existing rule rather than a second
  one.** The scrim is `p-0 sm:px-6 sm:py-[max(1.5rem,5vh)]`: 24px across as before, and
  `max(1.5rem,5vh)` down. The panel's `max-h-full` did not change and did not need to — what moved
  is the box it is a percentage *of*, and `max(1.5rem,5vh)` a side leaves it
  `min(100% − 3rem, 90vh)` of the window. **The `max()` floor is load-bearing rather than
  decoration**: below 480px tall, 5vh is the *smaller* inset, and a bare `5vh` would draw the panel
  **351px at y 19.5** on a phone in landscape at 844×390 — 4.5px inside the 24px the scrim keeps
  across, on the one class of window that still has an inset at all. Below `sm` there is no ceiling
  at all, by the same `p-0` that takes the frame off: a phone's dialog fills the glass, and 5vh of
  scrim over a 358px-wide panel is the inset that fold exists to delete, spelled on the other axis.

  **Doing it as a `max-h` on the panel instead would have silently outranked the card modal.**
  `CardDetailModal`'s `PANEL_SIZE` carries `min-[640px]:max-h-[min(825px,80vh)]`, and Tailwind
  emits named variants (`sm:`) as a **later** group than arbitrary `min-[…]` ones — so a
  `sm:max-h-…` on the shell's panel would win at every width ≥640 and replace that host's own
  ceiling with the shell's. That is the mixed-families trap `PANEL_SIZE`'s own doc comment was
  written to record, met from the other end. As an inset it does not arise: the card modal's cap
  is tighter than 90vh at every window, so it still binds and its numbers are unmoved.

  Measured 2026-09-08 in headless Chrome over the built `dist/assets/index-*.css`, with the scrim
  and panel class strings pasted verbatim from `Dialog.tsx` and a 4000px spacer in the body
  standing in for a wall taller than any window. The before column is the same frame with
  `padding-block: 1.5rem` forced inline — the fix and the fault in one pass. The first four rows
  reproduce the host-level fix's own table to the tenth of a pixel, which is the check that the
  inset and the `max-h` say the same thing where both applied.

  | Window | Before: top, height | After: top, height |
  | --- | --- | --- |
  | 2560×1440 | 24, 1392 | **72, 1296** |
  | 1998×1088 — the reporter's own | 24, 1040 | **54.4, 979.2** |
  | 1280×800 | 24, 752 | **40, 720** |
  | 1024×700 — the window floor | 24, 652 | **35, 630** |
  | 844×390 — a phone in landscape | 24, 342 | **24, 342** |
  | 500×844 — below the 640 fold | 0, 844 | **0, 844** |

  The fifth row is the `max()` floor doing its work and the sixth is the fold: full bleed, and the
  panel *is* the window. At 1280×800 the body scrolled its own 4040px inside a 645px box, so the
  clamp is a real ceiling rather than a number in a stylesheet. The old host-level
  `max-h-[min(100%,90vh)]` came off `AllPrintingsDialog` in the same commit, and removing it was
  not merely tidying: `cn`'s `tailwind-merge` deletes the shell's `max-h-full` the moment a host
  names a `max-h-…`, so left in place it would have capped that one dialog at **759.6px at y 42.2**
  on the phone row while every other dialog filled the glass.

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
    The horizontal one was `gap-x-4` here, 16px, the same number the root spaces the rail by —
    **halved to `gap-x-2`, 8px, on 2026-08-22** at the reader's ask, the root's 16 left alone. The
    two were one number by descent rather than by argument: the root's separates the deck from the
    piles played beside it, the grid's is the deck's own rhythm. It moves no pile and no rail — the
    flowing box is `flex-1` and the leftover is what sits in front of the rail — but it does move
    `auto-fill`, which is how a line comes to hold one more pile at some desk widths. **Every
    gutter figure measured below is the 16px build's** and is left as it was read.

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

  **Driven for the halving, 2026-08-22 — in the shipped window _and_ in Storybook.** Every reading
  is a **before/after in one pass**: the shipped 8px read, then `element.style.columnGap = '16px'`
  on the same box, then read again, so the two numbers are one fixture at one width rather than two
  builds. That is what makes "it moved nothing else" a measurement instead of an argument.

  - **The shipped window** (`npm run tauri dev`, a **debug** build at 1920×1080, real corpus, a
    14-card Commander deck of five flowing piles and a rail). Flowing box **1353px**, five 224px
    tracks, computed `column-gap` **8px** and `row-gap` **normal**. The four piles after the
    command zone at x **466 / 698 / 930 / 1162** — **232 apart**, which is the column plus the
    gutter and nothing else. Backed out to 16 in the same pass: **474 / 714 / 954 / 1194**, 240
    apart, **the same five tracks and the same 1353px box**. `documentElement.scrollWidth` **1920**
    against a `clientWidth` of **1920** — no horizontal page scrollbar, which the 1024px floor
    forbids.
  - **The rail did not move and its gutter is still 16.** The root's computed `gap` read **16px**
    with the deck's own at 8, and the rail stood at x **1603** — which is the leftover, not the
    gap. This is the whole reason the two numbers were worth separating: `flex-1` swallows every
    pixel the rail leaves, so nothing a reader sees in front of the rail is this gutter's doing.
  - **It moved no line count in Storybook either**, which is the answer to the obvious worry that a
    smaller gutter buys a line an extra pile. Same before/after, three stories: `WrappedPiles` **3**
    tracks (flow 757px), `UnevenPiles` **3** (709), `CommandZone` **4** (997) — identical at 8 and
    at 16. A track is 224 wide, so eight pixels only ever decides the count within eight pixels of
    a boundary, and no fixture here sits there.
  - **`TallDesk`'s decorator comment was wrong before this change and is corrected in the same
    commit.** It was written for four boxes at 74rem (944 = 4 × 224 + 3 × 16) and the story draws
    **three** — at both gutters — because the meta's fixed 42rem forces a 15px scrollbar that comes
    out of the flow's width first, leaving **917**. `UnevenPiles`' decorator pays for that
    scrollbar in as many words; `TallDesk`'s never did, and no play asserted the count, so it went
    green while demonstrating a different number than it claimed.

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
  which a wheel was about to turn. **Three of the four views were given no height at all on
  2026-08-14, and the fourth followed on 2026-09-08** — all four grow to hold their content, the
  desk row grows with them, and the page scroller (which has been there since the stats became a
  band, and which is `AppShell`'s `main` since 2026-08-24) is the one thing in the editor that
  scrolls. The paragraph and the two readings below are the 2026-08-14 pass; read the third bullet
  for what happened to its exception.
  - **Measured on a seeded 132-card, 17-pile Commander deck at 1280×800.** Stacks: the view
    box **7 123px** with `scrollHeight - clientHeight` of **0**, in a page of **702** visible
    against **7 635** of content. Grid **4 270**, text **1 765** (which packs to a fixed
    readable target and wraps, so it is the shortest of the three), all three with **0** internal
    scroll. `page.scrollWidth - clientWidth`, `main`'s and the document's were **0** at every
    reading — the sideways rule the entries above establish is untouched.
  - **The table was the exception, and the arrangement these figures measure was removed on
    2026-09-08.** They are kept because they are the whole case for the exception and the whole
    case against it. As read on 2026-08-14: `VirtualTable` mounts the rows in view and holds a
    spacer open for the rest, so a scrollport is what it _is_; given no height it was measured at
    **2 781px** with its own scroller _and_ the page's — the two-scrollbar screen this change
    exists to remove, arriving by the opposite route. So it kept the bounded desk
    row: **384** with **2 397** of scroll inside it and **194** of page, which was exactly what it
    read before.
    **What changed is the component rather than the view.** `VirtualTable` takes an opt-in
    `grow?: boolean` (default `false`): under it the root is not a scroll container, every row is
    rendered in document order in normal flow, the rowgroup holds no spacer height, and a row is
    `relative` with a `minHeight` rather than `absolute` + `transform` + `height`. `TableView`
    passes it; the search, the collection and the wishlist do not and still virtualise 100k rows.
    So the desk row carries no height for any view, `DECK_HEIGHT_FLOOR` is unconditional on the
    view box, and the reader's own complaint — a deck table in a 384px letterbox with a scrollbar
    of its own an inch from the page's — is answered rather than excepted. **The figures above are
    now history and nothing has replaced them**: this view has not been re-measured in the shipped
    window, so no number for the grown table belongs on this page yet. What it should read is one
    tall document with the page as the only scroller, exactly as the three bullets above the
    exception read.
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
  controls is sized by the _narrowest_ surface that draws it, and in this app that is a **docked
  search panel** — never the filter bar it was designed in. That surface is a *range* rather than
  384: the panel is draggable from its left edge and its floor is `MIN_PANEL_WIDTH_PX`, **206**, so
  the narrowest content box a filter control has to survive is ~193 rather than ~371. **And since
  2026-09-07 there are three of them** — the deck editor's, the collection's and the wishlist's,
  all one `CardSearchPanel` — so a control that overflows now overflows on three pages rather than
  one. Nothing goes red when a tenth chip is
  added, so `FilterChips.test.tsx` now holds the arithmetic beside the wrap.
- **The search filter row lays out by its own width and not the window's, in four bands — and
  the mechanism is `@container`, not a media query.** The same component is the search page's bar
  across a maximised window and a docked search panel, which is draggable from 206px, so
  a viewport query would be answering a question about the wrong box. The container is named
  (`@container/fb`) rather than anonymous, because container variants bind to the nearest
  ancestor container and an unnamed one here would be claimed by any future `@container` inside a
  card tile or a panel.
  **The bands were swept a container width at a time from 206 to 1956 against the built
  stylesheet** (2026-08-24, headless Chromium over a `file://` page and `dist/assets/*.css`, the
  real component's markup rendered out of the suite — the lock-free arrangement, so no app was
  running). Four shapes, and the transitions land exactly on the thresholds:

  | container | top row | tray | Filters | mana chip |
  | --- | --- | --- | --- | --- |
  | 206–640 | stacked: search / colours + Filters / mana / sort + layout | 1 column | icon + badge | 32px |
  | 647–899 | search · colours · Filters · layout, then mana · sort | 2 columns | icon + badge | 36px |
  | 906–1501 | the same two lines | 3 columns | with its word | 36px |
  | 1508–1956 | one line: search · colours · mana · Filters · sort · layout | 3 columns | with its word | 36px |

  **`order` plus a `basis-full` break, never one `<div>` per breakpoint with `hidden` on the
  rest.** The obvious build puts two mana-value groups and two sort pickers in the tree at once,
  which is two controls with one accessible name, two tab stops for one filter, and a
  `getByLabelText` that starts throwing "found multiple". The items are written once and the
  arrangement is `order-[N]`; a `basis-full h-0` item consumes the rest of its line, so
  everything ordered after it starts a new one. The Filters button's *word* is hidden by a class
  the caller passes (`labelClass`) for the same reason — one button, one name, at every width.
  **Two overflows the sweep found and neither was visible in a screenshot.** Below 640 the sort
  pair is `flex-1` so it can fill a line; without a second break it instead shared the mana
  values' line wherever one was left over, and `flex-1` then gave it *whatever was left* — at a
  369px container that was **5px**, and the 36px direction button inside it (which cannot shrink)
  spilled **53px** out of the panel. And the price band's two 64px boxes, 48px track and two 8px
  gaps come to **192** against the one-column tray's ~174 at the panel's 206px floor, 5px over.
  The fixes are a second `basis-full` break below 640 and `flex-wrap` on the price row. Both are
  instances of the rule two entries down — *a row of fixed-width controls is sized by the
  narrowest surface that draws it* — and both would have reached a reader as a horizontal
  scrollbar across the whole deck builder, because `DeckEditor`'s section computes `overflow-x`
  to `auto`.
  **Driven in the shipped window 2026-08-24** (`npm run tauri dev`, a **debug** build, against the
  real 116 700-card corpus), which is what turns the sweep above from a model into a reading. The
  sidebar was collapsed, so the bar is the window less 108px:

  | window | bar | top row | tray | Filters |
  | --- | --- | --- | --- | --- |
  | 1920 | 1812 | one line: search · colours · mana · Filters · sort · layout | 3 col | with word |
  | 1400 / 1300 / 1100 | 1292 / 1192 / 992 | search · colours · Filters · layout, then mana · sort | 3 col | with word |
  | 1000 / 900 | 892 / 792 | the same two lines | 2 col | icon + badge |
  | deck panel, default | **371** | search / colours + Filters / mana / sort | 1 col | icon + badge |
  | deck panel, **floor** | **193** | search / colours / Filters / mana / sort | 1 col | icon + badge |

  The word drops between a bar of 992 and 892 and the tray halves with it, which is the 900
  threshold read from the outside. At both panel widths the mana chips measured **32px** and the
  rarity cell a **2-column grid**; at the floor the price row wrapped its second box onto a line of
  its own, which is the `flex-wrap` above doing exactly what it was added for. **Every one of those
  seven widths reported `scrollWidth === clientWidth` on the bar, on `main` and on the document** —
  no horizontal scrollbar anywhere, which is the failure the two fixes exist to prevent and the one
  a screenshot alone cannot rule out.

  **jsdom applies no container queries and loads no stylesheet at all**, so none of this can go
  red in the suite: every test there sees the base (narrowest) arrangement, and the numbers come
  from a browser.
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
    `CategoriesDialog`'s destructive answer is pinned **last** — it is not allowed to become the
    default by alphabet. That row reads `go with it` since schema v25; it read
    `are deleted with it` until the deck groups landed, and that had become the wrong half of a
    true sentence, because the `deck_cards` rows do go while the copies the reader physically owns
    are filed into `Recently removed`. (A seventh pinned row, the deck card's permanent `Move…`
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
    **Since 2026-09-08 it reads `Stacks · Grid · Table · Text`**, at the reader's ask: `VIEW_PICKER`
    is `DEFAULT_VIEW`'s row **pinned** above `sortOptions` over the other three. Still no
    exemption — a pinned row is the shape `Any card`, `Any format`, `Custom…`,
    `Auto (by what it does)` and `Top level` already have, everything the pin does not name still
    sorts, and the argument quoted above about the array's own order is untouched and is why the
    pin is spelled as a *filter* over `VIEWS` rather than as a reordering of it. What the pin buys
    is a position for the view every deck opens on. **The three controls are `components/Dropdown`
    rather than `<select>`s since 2026-08-26**, so the live figures below are readings of the
    selects they replaced.
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

## The theory mark, and the four things a photograph settled

Added 2026-08-20 with `TheoryMatchMark` — the mark a deck card wears on the **Live** list when the
deck's plan asks for it too. The rule and the data are in
[`src/features/decks/CLAUDE.md`](../../src/features/decks/CLAUDE.md); this is what looking at it
changed, and every one of the four was a decision the suite could not have made.

**How it was looked at.** Both locks were held by other worktrees all afternoon, so this was the
lock-free path: a `file://` page linking the **built** `dist/assets/index-*.css`, with card art
out of the image cache, the components' own class strings pasted onto the markup, and
`msedge --headless=new --screenshot`. Before and after in one frame, and candidates side by side —
which is the whole reason it can settle a question a test cannot. **The shipped-window pass was
owed and was run on 2026-08-21** — see the alignment section below, which is what it found.

**The recipe has one trap, and it is silent: over `file://` it measures the wrong font**
(found 2026-08-26, while sizing the price walls' as-of sentence). `dist`'s CSS references its faces
with **absolute** `/assets/…` URLs, so from a `file://` page they resolve to the drive root, never
load, and every width taken is a width of the generic `sans-serif`. **Serve `dist` over http
instead.** The tell is to measure one string twice, once in the app's own stack and once forced to
`sans-serif`: identical widths mean the real face never loaded. On the pass that found it that was
**265.2px for both** over `file://`, against **272.78 vs 265.2** served, with `document.fonts.check`
going `false` → `true`. It costs a comparison of glyph shapes or colours nothing; it costs any
*width* the answer. The 2026-08-24 container sweep further up this page was taken the same way and
has not been re-run: its four bands are **container** widths, which no font can move, but any
figure in it that came from a run of text is exposed and should be re-read before being relied on.

- **The fill is `--color-pie-u`, not `bg-accent`.** Gold was the obvious first choice — a chip on
  a card usually is — and in the frame it read as an *extension of the Game Changer banner*: two
  gold marks in one 27px strip meaning two unrelated things. `--color-ok`, the green the format
  check draws its clean-deck `CircleCheck` in, is legible and says the one sentence a tick must
  not ("nothing is wrong here"). **That third refusal is reversed since 2026-09-07** — green is
  the *exact* tier now, and *this is the printing you planned* **is** that sentence; the
  subsection at the foot of this section carries the reversal, and the other two refusals stand.
  The neutral count paint was no distinction at all — a grey chip
  at each end of the strip. Azure is none of those. It **is** one of the six label colours, which is
  the accepted cost: the quantity tag at the other end draws a *number*, so the two are still told
  apart by content and position.
- **The slant is mirrored** — `COUNT_TAG_SLANT_MIRRORED`. `CountTag`'s cut takes its bite out of
  the edge *away* from the corner it is pinned to, which is what makes it read as a banner tucked
  into that corner. Reused unmirrored on the right, the bite lands against the card's own edge and
  leaves a notch. The mirrored pair read as bookends of the marks strip; the unmirrored one read
  as a mistake. Same idea `GameChangerBanner` stated about its own forked tail — **that banner was
  deleted on 2026-09-08 and this pair is where the rule is drawn now**, which is the general form:
  a mark's geometry is oriented to the corner it is pinned to, and only the orientation changes.
  **What this
  pass could not see is that the polygon it settled on was a _rotation_ rather than a reflection**
  — both hide the notch, and only one keeps the taper; issue #182 two sections down.
- **The Grid tile got a second drawing, not the same one — and that `variant` was deleted on
  2026-09-08.** One `CountTag` banner for both card
  faces was the first cut: 22px on a 210px stacked card is 7.5 % of it and the same 22px on a
  150px tile is **15 %**, so a wall of tiles read as a wall of blue flags with cards behind them
  (photographed 2026-08-20). `variant="chip"` echoed the tile's own 9px copy count instead — the
  honest reading of "the same badge as the quantity" *while the two views did not draw the same
  quantity badge*, and the shape that had room to stack under `FoilOverlay`'s corner chip, which
  the tile drew and the stack did not.
  **Both halves of that premise went with the tile.** The two card-face views draw one
  `DeckCardFace` now: `FoilOverlay mark={false}` on both, so there is no corner chip to clear and
  nothing to stack under; and one `QuantityTag` banner on both, so there is no 9px chip left to
  echo. The measurement above is still true and no longer decides anything — the tile draws the
  whole 27px marks strip with a 22px tag at the other end of it, so the weight the chip refused is
  already accepted on the same card, and refusing it *here* would leave the strip's two bookends
  in different shapes. `CardMarks.tsx` carries the full reading at its own site.
- **The row views get no box.** The shape argued against was `GameChangerBadge`'s outlined box put
  around a **tick**, which is a **checkbox** — the one control every reader already knows — so a
  decklist of them reads as something to click. `GC` survived the box because it contained letters.
  So `TheoryMatchBadge` is the glyph alone, at `DeckFinishMark`'s 12px rather than `GC`'s 9px type.
  **That badge was deleted on 2026-09-08** and the row views' game changer is a bare gold crown in
  the quantity column — so the two marks in a row are a boxless glyph either end of the line, and
  the rule survives its own counter-example: nothing in a decklist wears an outlined box now.

**One thing the frame shows and nobody has decided:** at the bottom-left of a stacked card the
`RULE BREAK` mark lands **over the card's own printed set/collector/artist line**. `GridView` has
drawn it in that corner all along, so this is existing shipped behaviour rather than something the
move introduced — but the stacked card is 210px against a tile's 150 and covers proportionally
more of it. Worth a look if the illustrator-credit rule above is ever read strictly.

### And the fifth thing, which only the shipped window found (issue #158)

The `file://` frame above pasted the components' class strings onto **its own** markup, so it
photographed the mark and not the mark *in the card*. Both of the things it therefore could not
show were reported the next day, by a reader, off one screenshot: the tick read as **left-aligned
inside its own banner**, and the banner stood short of the card's right edge with a **square**
corner where the quantity tag at the other end has the card's round one.

Both were real, both were arithmetic, and neither is visible to the suite — jsdom lays nothing
out. **Driven in the shipped window 2026-08-21** (`npm run tauri dev`, a **debug** build at 1920
against the real 116 700-card corpus, five Live cards all matching the plan), with the change
backed out through `element.style` in the same session so the two states are one pass:

| | before | after |
| --- | --- | --- |
| tick's right edge, from the card's | **5px short** | **0** — flush, exactly as the quantity tag is at the left |
| glyph, from its banner's visible mid-height centre | **−5.5px** | **+0.5px** |

- **The glyph was off-centre because a slant and its paddings are one shape.** `COUNT_TAG_BOX`'s
  `pr` is larger than its `pl` because `COUNT_TAG_SLANT` bites the **right** edge; the tick wears
  `COUNT_TAG_SLANT_MIRRORED`, which bites the **left**, so it needed the pair swapped and had been
  wearing them unswapped. `COUNT_TAG_BOX_MIRRORED` is that swap, exported beside the mirrored slant
  so a caller reaching for one can see it has to take both. Re-measured at **2×** — 24/12px
  paddings, glyph **+1px** off centre, the same half-pixel doubled — so it scales rather than
  agreeing at one stop.
- **The 5px was a rule that outlived its corner.** `CARD_MARKS_STRIP` was inset
  `right-[calc(5px*var(--mark-scale,1))]` "to keep the strip off the card's own clipped corner",
  written when the strip's marks were drawn on the **right** and that corner held a `RULE BREAK`
  box with a hairline border. The marks went left on 2026-08-13 and the inset stayed. It is
  `inset-x-0` now: the face is `overflow-hidden rounded-[7px]`, so the tick gets the same clipped
  corner the quantity tag has always had at `left-0` — measured `border-radius: 7px`,
  `overflow: hidden`, and both gaps **0**. Bookends in radius as well as in slant.

### And the sixth, off the same corner and reported the next day (issue #182)

Two more things, from one reader looking at one card: the tick's banner was **widest at its
bottom** where the quantity tag at the other end of the strip is widest at its top, and at **30px
on a 208px card face** it was laid across the printed **mana cost**. Both are one line each, and
the first is the more interesting.

- **"Mirrored" had been implemented as a _rotation_.** `COUNT_TAG_SLANT` bites the bottom-right;
  `COUNT_TAG_SLANT_MIRRORED` was `polygon(10px 0, 100% 0, 100% 100%, 0 100%)`, which is that
  polygon turned 180° — the bite in the **top**-left. Reflecting it across the vertical axis gives
  `polygon(0 0, 100% 0, 100% 100%, 10px 100%)` — the bite in the **bottom**-left. Both move the
  bite off the card's right edge, which is the whole reason the wrong one survived the 2026-08-20
  photograph: the notch that pass was looking for was gone either way. What only the rotation also
  does is flip the **taper**, so the strip held two banners leaning opposite ways. The reader's
  words were "bigger towards the bottom, whereas the quantity badge is bigger towards the top".
- **The paddings went `12/6` → `6/1`, and the rule that makes both pairs legal is one line of
  arithmetic** now written on `COUNT_TAG_BOX_MIRRORED`. At mid-height the slant has eaten `10/2`
  off the left, so the visible trapezium is `[5px, W]`; equate its centre with the content's and
  the content width cancels — the glyph is centred exactly when **`pl − pr = 5px`**. `12/6` (a
  difference of 6, off Tailwind's scale) satisfied it to within the half pixel #158 measured;
  `6/1` satisfies it exactly *and* gives back 11px. The right-hand padding can be a hairline
  because lucide's `Check` is drawn `4 → 20` in a 24 viewBox and brings 2px of bearing per side;
  a **digit** has no such room to give back, which is why `COUNT_TAG_BOX` keeps its `6/12`.

**Driven in the shipped window 2026-08-21** (`npm run tauri dev`, a **debug** build at 1920,
against the real corpus, on a Live card whose printed cost is `{2}{R}{R}{G}{G}` — five pips, the
worst case this corner has), with the change backed out through `element.style` in the same
session so the two states are one pass:

| | before | after |
| --- | --- | --- |
| the cut | `polygon(10px 0, 100% 0, 100% 100%, 0 100%)` — **rotated** | `polygon(0 0, 100% 0, 100% 100%, 10px 100%)` — **reflected** |
| widest edge | its **bottom**, against the tag's top | its **top**, the same as the tag's |
| width at 1× | **30px**, 14.4 % of the 208px face | **19px**, 9.1 % |
| paddings | `12 / 6` | `6 / 1` |
| glyph off its banner's visible mid-height centre | **+0.5px** | **0** |
| of a five-pip mana cost | **3 pips** left showing | **all five** |

- **It scales at both ends of the ladder rather than agreeing at 1×.** Re-measured at **1.75×**
  (33.25px wide, paddings 10.5/1.75 — a difference of 8.75, half the 17.5px slant — glyph **0** off
  centre) and at **0.5×** (9.5px, paddings 3/0.5, the cut computing `polygon(0px 0px, 100% 0px,
  100% 100%, 5px 100%)`, glyph **0** off centre).
- **Both marks are still flush to the card's own edges** — the tag's left gap and the tick's right
  gap both **0** against a face computing `border-radius: 7px` and `overflow: hidden`, which is
  #158's other half, unchanged.
- **The tick's ink now clears the slant by 3px and stands 3px off the card's right edge** — the
  same optical gap on both sides of a glyph that is 12px in a 19px box.
- **One trap, and it cost a reading**: clearing an inline style React set does not restore what
  React set — see [live-ui-verification.md](live-ui-verification.md). The `clipPath` read `none`
  after the back-out, which looks exactly like the component having stopped setting it; switching
  the variant tabs and back forced the re-render that proved otherwise.

### And the seventh: the mark learned to count (issue #212)

Same corner, same reader, and both halves of one report: the tick wanted **more padding**, and the
blue banner wanted to be **as wide as the quantity area at the other end of the strip**. The second
is what #182 had spent — `6/1` gave back 11px of mana cost and left the mark at **19px** against
the tag's **24.61**, visibly the smaller of two things drawn as bookends. And a third ask that is
not geometry at all: where the two lists disagree about *how many* of a card, say the difference —
`+2`, `-8` — instead of a tick that only says the card is planned.

The three are one change, because the third is what makes the second unanswerable by paddings.
The box holds a 12px glyph on one card and two characters of 12px mono on the next, so any pair of
paddings tuned to the tick leaves the number's box a different width again. **So the width is
stated rather than tuned**: `min-w-[calc(1ch + 1.125rem*var(--mark-scale,1))]` — one digit's
advance in this very face, plus `COUNT_TAG_BOX`'s own two paddings — which *is* the count tag's
width holding a single digit, by construction rather than by a number that would rot the day the
mono face changed. The paddings then only have to satisfy #182's `pl − pr = 5px`, and `8/3` does.

**Measured 2026-08-26 over the built stylesheet** — `dist/assets/index-CCWFHD9i.css` linked from a
`file://` page holding the **real** markup (dumped out of a throwaway vitest render of `CardStack`,
so this is the mark *in the card* rather than its class strings pasted onto a div — the mistake
that made #158 invisible to the 2026-08-20 pass), driven by headless Edge, at `--mark-scale` 1.
Before and after in one pass, backing the change out through `element.style`:

| | before (`6/1`, no floor) | after (`8/3`, floor, `justify-center`) |
| --- | --- | --- |
| the quantity tag, one digit | **24.61px** | **24.61px** — untouched |
| the tick's box | **19px** | **24.59px** |
| `-2`'s box | **20.20px** | **24.59px** |
| `-12`'s box (against a `12` tag's **31.20**) | 26.80px | **30.80px** |
| the tick's ink, either side of the visible trapezium | **1px** | **3.80px** |
| `-2`'s ink, either side | 1px | **3.19 / 3.20px** |
| ink off the trapezium's mid-height centre | 0 | **0** (−0.01 on the counts) |

- **0.02px is the whole of what separates the two bookends now** — 24.59 against 24.61 — and the
  gap is `1ch` being the advance of `0` while the box's own floor is computed to 24.5977. Both
  marks are still flush to the card's right and left edges respectively, which is #158's other
  half, unchanged.
- **`justify-center` is worth 0.8px here and is kept anyway.** With the floor and without it, the
  tick sat **−0.8px** off the trapezium's centre — the surplus a `min-width` adds lands entirely to
  the right of the content under a flex container's default `flex-start`. It is small because
  `8/3` was picked with the floor in mind; what the class buys is that #182's arithmetic stays a
  *derivation* (the surplus grows with the zoom and moves with either padding) rather than a
  coincidence of today's numbers.
- **The count is drawn in place of the tick, never beside it.** A tick and a `-8` in one 25px box
  are two clauses of one sentence at the end of a strip whose other mark is already a number. The
  tick is the card that matches; a number is the card that does not.
- **ASCII `+` and `-`, never `−`.** The box is `tabular-nums` mono and the typographic minus is
  outside that fixed-advance run, so `-8` and `+2` would be different widths in the one box whose
  job is to be the same width as the tag opposite it.
- **What is unmeasured**: this pass is the built stylesheet and not the shipped WebView2 window,
  and it was run at `--mark-scale` 1 only. The two ends of the zoom ladder were re-driven for #182
  and nothing here changes how any of these terms scale — `1ch` follows the font size, which is
  already scaled — but that is an argument rather than a reading.

### The tiers, and the green this section had ruled out (2026-09-07)

**This one is not a photograph, which is why it is not numbered with the seven above it.** It is
a colour decision reversed by a change in what the mark *means*, and the pass that would settle it
is owed — the foot of this subsection says what is unmeasured.

The mark answers two questions now instead of one — **green** where a Live row is the exact
printing the plan named, **blue** where it is that same card in a printing the plan did not name.
The rule, the per-deck switches and the arithmetic are in
[`src/features/decks/CLAUDE.md`](../../src/features/decks/CLAUDE.md). What belongs here is the
**colour**, because the first bullet of this section ruled green out and that finding is now
reversed. **It is left standing above rather than deleted**: it was right about what it was
looking at, and knowing why it stopped applying is the whole of the argument.

**Two of the three refusals stand, and one of them lost its example rather than its argument.**
Gold still puts two gold marks in one 27px strip meaning two unrelated things — a Gold-labelled
`QuantityTag` at one end and a gold tick at the other — and gold already means *picked* on every
wall in this app. What it no longer does is *read as an extension of the Game Changer banner*:
that banner was deleted on 2026-09-08 and the game changer is a crown drawn **inside** the
quantity tag, in the tag's own foreground rather than in gold, so the strip's second gold object
is gone and the refusal now rests on the label and on `SELECTED_CARD`. The neutral count paint is
still no distinction at all — a grey chip at one end of the strip and a grey chip at the other.

**The third was a finding about a different mark.** `--color-ok` was ruled out in these words:
*it is this app's "nothing is wrong here" colour, which is the one reading a tick must not have.*
That was true of a mark meaning **this card is in the plan** — a *fact*, not a verdict — and it
held for exactly as long as the mark said only that. Green is now the **exact** tier, and *this is
the printing you planned* **is** a "nothing is wrong here" verdict: it is the reading the mark
should have rather than the one it must not. Azure keeps the looser tier, where the original
argument still applies unchanged, because *this is that card in another printing* is a fact again
rather than a verdict. One pass, one sentence, two marks — and the sentence went to the mark it
was true of.

**The default green is `#56bd78`, and it is `--color-ok` itself rather than a colour picked to
look like it.** `src/index.css` defines `--color-ok: oklch(0.72 0.14 152)`; converted to sRGB that
is `#56bd78`, and the conversion is **in gamut** — the linear components come out at
`0.0931 / 0.5103 / 0.1870`, all inside `[0, 1]` — so the hex is the exact colour rather than one
clamped to the nearest displayable point. Blue is `#0e68ab`, today's azure, unchanged. Both are
**literal hexes** in the stylesheet rather than `var(--color-ok)` / `var(--color-pie-u)`, for
`LABEL_COLORS`' reason: these are the values a colour picker opens on and a reader's own choice
replaces, so they cannot be a reference to something the palette decides later.

⚠️ **The duplication has no fence, and that is worth knowing precisely because the six labels
do have one.** `labelColors.test.ts` reads `src/index.css` through Vite's `?raw` and holds
`LABEL_COLORS` to the declarations it finds; nothing does that for these two. `MARK_COLOR_DEFAULTS`
in `src/lib/useMarkColors.ts` spells `#56bd78` and `#0e68ab` a second time — an
`<input type="color">` cannot take a `var()`, so the picker needs a literal to open on — and
`useMarkColors.test.ts` asserts those same two literals, which pins the constant to itself. A
palette edit that moved `--color-theory-exact` and left the constant alone would ship a picker
opening on a colour the mark is not drawn in, with nothing red anywhere. One test in
`labelColors.test.ts`' shape closes it; it is **owed rather than done** (2026-09-07), and this
paragraph said the fence existed before it was checked.

**Azure is one of the six label colours and the green is not**, which means the split's one
accepted cost stayed on the tier that was already paying it. A card wearing an Azure label draws
an azure `QuantityTag` at the *other* end of this strip; the two are still told apart by content
and position, because one of them is a number. The exact tier pays nothing there at all.

**The four separations still hold, and the colour is the one of them a reader can now defeat.**
Place (this corner against the rule break's, which moved to the opposite one on 2026-08-20
precisely so), colour, shape (a filled banner against a hairline box) and the card's own edge.
Since 2026-09-07 both colours are the reader's — Settings → Appearance writes
`--color-theory-exact` and `--color-theory-name` onto the app root — so nothing stops somebody
choosing the destructive red for one of them. That is theirs to do and not this app's to prevent;
the other three separations are structural and hold whatever is picked, which is exactly why there
are four of them rather than one.

**What has not been done is a photograph, and this section is the reason that matters.** Every
sentence above is an argument. The tiers have been driven in jsdom and in Storybook and in neither
of the two frames that have ever settled anything here: no `file://` page over the built
stylesheet, no shipped WebView2 pass. Unmeasured, and each of them is the kind of thing this
section was written by: green over real card art beside the gold banner; green and blue on one
wall of tiles, where the question is whether two filled marks read as two statements or as noise;
either colour at `--mark-scale` 0.5 and 1.75; and a custom colour a reader has picked against the
`-fg` the luminance formula chose for it. #158 and #182 were both reported by a reader off one
screenshot after a green suite; that is the standing record of what a green suite is worth here.

### The sign is the action (issue #400, 2026-09-08)

**Nothing in this section's geometry moved — only which way the sign points.**
[Issue #400](https://github.com/Msgaihede/mtg-grimoire/issues/400) is the same reader who asked for
the number at all, back with what the number could not do: *"the displayed number indicates what is
missing as a minus and what is over the required quantity as a plus. This does not directly tell
the user what action to take."* So the delta is **`planned − live`** now, at whichever grain the
tier already used — **positive is copies to add, negative is copies to remove**, `0` is still the
tick — where it was `live − planned` from 2026-08-26 (issue #212) until this. The reader's own
eight-Forests case reads **green +6** on the planned printing rather than green −6; the rule, both
tiers and the floor are unchanged and live in
[`src/features/decks/CLAUDE.md`](../../src/features/decks/CLAUDE.md).

**Every measurement above still stands, and that is the point of recording it here.** The box is
the same box: `COUNT_TAG_BOX_MIRRORED`'s `8/3` over the `1ch + 1.125rem` floor, the 24.59-against-24.61
agreement between the strip's two bookends, the count drawn *in place of* the tick and never beside
it. **ASCII `+` and `-` are untouched too** — a typographic minus is still outside the
`tabular-nums` run, and inverting a sign changes nothing about which glyph draws it. What did move
is the **words**: `theoryMatchLabel` says `In the theory list · 2 to add` and
`In the theory list · 3 to remove`, so the tooltip, the badge and the `sr-only` twin no longer
carry *"more than planned"* / *"fewer than planned"*. A one-character swing in the box's content is
the only thing a photograph could catch here, which is why this subsection adds no pass to the one
the section above still owes.

### The third tier, and the red it is not (2026-09-08)

**A Live row the plan does not ask for at all now wears a mark of its own, and it is the first
one in this section that is neither a tick nor a number.** `unplanned` draws lucide's **`X`** —
never a digit, because there is no arithmetic to print: the plan wants none of this card, so a
signed count would be a subtraction against nothing. The words are **"Not in the theory list"** in
the tooltip, in the table's `sr-only` twin and in the card's accessible name, and the attribute is
`data-theory-match="unplanned"`. The resolver rule, the third per-deck switch and the reason a
*planned* row never falls through to this tier are in
[`src/features/decks/CLAUDE.md`](../../src/features/decks/CLAUDE.md); what belongs here is the
**red**, because this app already had two of them and neither would do.

**It is not the destructive token.** `--destructive` is Tailwind red-400,
`oklch(0.704 0.191 22.216)`, which is **outside sRGB** and renders as `#ff6467` — so the paint a
reader actually sees from that token is a clamped colour rather than the one the stylesheet names.
That is the app's *there is a problem here* red: the rule break's edge, the shortage figure, the
delete confirmations. A mark meaning *not in your plan* is a note about the reader's own list and
not a verdict on the card, so wearing the problem colour would say the wrong sentence in the
loudest register the palette has — the same argument that ruled `--color-ok` out for a tick until
the tick's meaning changed on 2026-09-07, arriving from the other side.

**It is not `--color-pie-r` either.** `#d3202a` is the Ember label colour, and a card wearing an
Ember label draws that hue in a `QuantityTag` at the *other* end of this same 27px strip. That
collision is exactly what azure costs the name tier — accepted there, once, because azure was the
right blue and the two are told apart by content and position — and there was no reason at all to
pay it a second time on a tier that could simply pick a different red.

**So `#e2484f` is its own colour: red-400's hue with the chroma pulled into gamut and taken a step
deeper.** In gamut, so the hex is the paint rather than a clamp of it; deeper than `#ff6467`, so
it does not read as the destructive token drawn small; and clear of `#d3202a` at the other end of
the strip. Its luma is **under `labelFgCss`' 0.55 threshold**, so `--color-theory-unplanned-fg`
resolves to `--color-text` at the default, and `useMarkColorVars` recomputes it by the same rule
for whatever the reader picks in Settings → Appearance — **which is the filled banner's contract
and not the badge's**: `TableView` and `TextView` draw the X bare, in the fill colour on the row's
own background, exactly as they already draw the tick and the number, so those two views read the
`-fg` half not at all.

⚠️ **The unfenced duplication above is now three hexes rather than two, and the gap is still
owed.** `MARK_COLOR_DEFAULTS` in `src/lib/useMarkColors.ts` spells `#e2484f` a second time — an
`<input type="color">` cannot take a `var()`, so the picker needs a literal to open on — and
`useMarkColors.test.ts` asserts that same literal, which pins the constant to itself. The one test
in `labelColors.test.ts`' shape that would close it was owed on 2026-09-07 and is owed still; the
third tier bought it a third way to go wrong rather than a reason to write it.

**Nothing about the box moved.** `COUNT_TAG_BOX_MIRRORED`'s `8/3` over the `1ch + 1.125rem` floor
is unchanged, the glyph is drawn *in place of* the tick and never beside it, and the corner, the
stacking under `FoilOverlay`'s chip and the `--mark-scale` arithmetic are all the same. **The four
separations from the `RULE BREAK` mark still hold** — place (top-right filled banner against the
rule break's bottom-left hairline box), shape, words and the card's own edge — and colour was
never one of the three that are structural: since 2026-09-07 a reader has been able to paint the
exact tier the destructive red if they want to, and a third pickable colour changes nothing about
that.

**Unmeasured in the shipped window**, and it inherits the whole of the pass the two subsections
above still owe. Nothing here has been driven in WebView2 or over a `file://` page against the
built stylesheet: red beside the gold banner on real card art, three filled marks on one wall of
tiles, the X at `--mark-scale` 0.5 and 1.75, and a custom red against the `-fg` the luminance
formula chose for it are each the kind of thing this section was written by. The fixture deck's
**Dismember (`nph 57`)** is the card that wears it in every view story, which is where a
screenshot would start.

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
element**: Stacks **1**, Grid **1**, Text **1**, Table **2**. The table's second was
`VirtualTable`'s and was the documented exception — a virtualiser is a scrollport by construction.
**That exception went on 2026-09-08** (`VirtualTable.grow`, the section above), so the table's
count is **expected to be 1** and is **unverified** — this line has not been re-driven, and the
figure stays as read until it is. Do not quote the 1 as a measurement.
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

**The first row stopped being true on 2026-09-03**, and the table is left as it was because it is
the record of the defect rather than a description of today. `DROP_RING` is `ring-1 ring-inset
ring-accent/45` now, and an inset ring is painted *within* the border box — so it joins
`DROP_OVER` in the "untouched" column and cannot be clipped by a scroller at all. **`DROP_MARK_ROOM`
did not change and must not**: the middle row is the one that always asked for the larger number,
a clipped focus indicator is a WCAG 2.4.7 failure rather than a cosmetic one, and 6px is still
`FOCUS`'s 4 plus two to spare.

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
above. The other way out is `ring-inset`, which is what `TableView` reached first — recorded here
as *its rows being absolutely positioned inside a virtualiser*, which was that view's reason on
2026-08-17 and stopped being it on 2026-09-08, when the view took `VirtualTable`'s `grow` and its
rows went into normal flow with a `minHeight`. **The conclusion survives on the half that never
depended on the virtualiser**: table rows are stacked flush against each other, so an outset ring
paints over a neighbour whether or not a scroller clips it as well. That view's root also carries
no `overflow` at all now, so there is no padding box left for it to be clipped at.

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

## The drop marks, made quiet and made to agree (2026-09-03)

**The report.** Three sentences from the reader, and they turned out to be one defect and two
consequences of it: the highlights are "huge bulky outlines", they "often overlap with other
content", and they "don't align with the dotted outline and faint highlight appearing when
actually hovering over a dropzone in most cases". A fourth, separate: a dragged card "occludes a
lot of content".

**The cause of the first three.** `DROP_RING` was `ring-2 ring-accent`, and a Tailwind ring is a
box shadow painted **outside** the border box. It went up on *every* eligible target for the whole
length of a drag, so a wall of drawers became a dozen hard 2px rectangles each intruding 2px into
its neighbour's gap — bulk and overlap from one property. The misalignment was the same fact seen
from the third side: on all four folder cards the ring was on the wrapping `<li>` and the card's
dashed border and `DROP_OVER` wash were on the `<button>` inside, so the gold stood 2px proud of a
dash it never touched. `features/decks/FolderCard.tsx` was the worst case — a ring on the `<li>`
for the deck drag, a second on an inner `<div>` for the folder drag, and the button's dash inside
both: **three concentric outlines for one landing**.

**The fix, in three parts.**

| | before | after |
| --- | --- | --- |
| `DROP_RING` — borderless targets | `ring-2 ring-accent` | `ring-1 ring-inset ring-accent/45` |
| `DROP_EDGE` — targets with an edge | *(did not exist)* | `border-accent/45 transition-none` |
| `DROP_OVER` | `bg-accent/10` | `bg-accent/15 ring-accent transition-none` |

`ring-inset` is the load-bearing word: an inset ring is painted *within* the border box, so the
overlap is impossible by construction rather than tuned away. `DROP_EDGE` is the alignment fix and
it works by removing the second line rather than by lining two up — a card that already owns a
dashed outline turns *that* outline gold, so there is no pair of edges left to disagree. And the
over state escalates by **colour, never by width**: both tokens land in one `cn()`, so a `ring-2`
here would sit in the same `tailwind-merge` width group as the other's `ring-1` and the mark's
thickness would depend on argument order. Width lives in one token; this one raises
`ring-accent/45` to `ring-accent` in the ring-*colour* group, where overriding is the point.

**The `transition-none` on two of them is not tidiness.** Those buttons already tween their
colours over 150ms for hover, and moving the mark onto the button would have put a drop affordance
behind that tween — the rule `DROP_RING` gets for free by being a box shadow. It costs nothing,
since the class is only applied during a drag and `:hover` does not update while the pointer is
holding something. It also keeps the two marks arriving *together*, which matters now that they
share an element: a border that snapped while its wash faded would be a second misalignment, in
time rather than in space, introduced by the fix for the first.

**The occlusion is a separate, one-line change.** There was no `opacity` anywhere on
`[data-dnd-dragging]` — the preview is a clone of the source drawn at full size and full opacity,
and on a deck that is ~293px of card art laid over the heading the reader is aiming at.
`src/index.css` now carries `[data-dnd-dragging] { opacity: 0.75 }` as an **app-owned rule kept
separate from the copied library block**, which is a verbatim copy the fence in
`lib/dndManager.test.ts` checks the library against; that fence runs one way (library ⊆ ours), so
an extra rule of the app's own is legal and does not read as drift in a copy the app does not own.

**Verified against the built stylesheet, not the source** — `dist/assets/index-BDP3Px9q.css`,
2026-09-03, because a mistyped Tailwind utility emits **nothing** and source still reads correctly.
All five present: `.border-accent\/45`, `.bg-accent\/15`, `.ring-accent\/45`,
`.ring-inset{--tw-ring-inset:inset}` and `[data-dnd-dragging]{opacity:.75}`. Then photographed
lock-free — a `file://` page against that sheet, headless Edge at `--force-device-scale-factor=2`,
with the **old** `ring-2 ring-accent` drawn in the same frame for comparison. The old ring reads
visibly wider than the element it is on; the new hairline hugs the inside of the rounded rect; the
folder card's three states are one dash going grey → warm → solid-gold-with-wash; and a
`data-dnd-dragging` tile is plainly faded beside an identically-classed one. The app lock was held
by another worktree, which is what the dist-CSS route is for.

**What did not change, and must not.** `DROP_MARK_ROOM` stays `p-1.5`. The ring no longer needs it
— it cannot be clipped — but `FOCUS` still stands 4px proud, and half a focus indicator is a WCAG
2.4.7 failure rather than a cosmetic one. The 6px was always sized for `FOCUS` rather than for the
ring, so the number is unchanged and only its justification narrowed. `TableView` had reached the
inset answer on its own long before — recorded here as *for rows absolutely positioned inside a
virtualiser*, which was true of that view until 2026-09-08 and is true of the app's other three
tables still; what holds for the deck's own now that its rows are in normal flow is the plainer
half, that rows stacked flush against each other cannot afford an outset mark. Either way its
local `ring-inset` is a duplicate of what the token says and was removed.

**Three test holes the change opened, all of which would have gone green.** Worth recording
because each is the same shape: an assertion written against a literal that no longer exists
anywhere passes for *every* state. `CollectionPage`/`WishlistPage` had eight
`classList.contains("ring-2")` refusal checks — the ones proving a target that lights up never
then refuses the drop — replaced by a `wearsDropMark` subtree helper. `DecksPage`'s `ringed`/
`washed` helpers hardcoded `ring-2`/`bg-accent/10` against **`FolderTree`** rows, and now ask for
the ring's *width*, since the two tokens deliberately share the colour group and an all-classes
test would call a correctly marked row unringed at exactly the moment it is most marked. And
`AppShell` had four `not.toHaveClass("ring-accent")` absence checks: `toHaveClass` matches whole
tokens, so an entry wrongly armed with `ring-accent/45` would have sailed through.

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
wrong width. Both are one `AllPrintingsDialog` now, on the `Dialog` shell.

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

> **The deck's own walk changed on 2026-08-21**
> ([#178](https://github.com/Msgaihede/mtg-grimoire/issues/178)) and everything below this line
> describes it as it was on the day it was measured. `StackView`'s left and right now step **one
> card** through the whole deck, crossing pile boundaries, and up and down reach no branch at all;
> the two-axis walk both sections below drive — up/down inside a pile, left/right to the
> neighbouring pile's top card — is gone. Nothing else in either section moved: the caret note,
> the card's `<li>`, the wall's absolute index and the modal's own two keys are all still the
> current answer, which is why the pass is kept whole rather than edited into agreement with a
> later decision. `src/features/decks/CLAUDE.md` states the rule that is live.

### One cause, three surfaces: the walk was exactly one press long

`CardDetailPane` rendered `<Body key={cardId}>` and that body's mount effect focused the pane —
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
read by the pane's mount effect. The pane still recorded the opener — during a walk the active
element **is** the right thing for Escape to hand back to — and skipped only the focus.

**The first spelling of that note was wrong in a way only a debug build could show.** It cleared
itself on read, the way `handover` does one screen up in the same file; `main.tsx` wraps the app in
`React.StrictMode`, which invokes a mount effect **twice** in development, so the first invocation
consumed the note and the second took the caret anyway. The walk was still one card long and the
fix looked like a fix. It is idempotent now — the same card answers the same way however many times
it is asked, and any *other* card discards the note. Worth carrying because the asymmetry runs the
wrong way: **a release build would have passed a test this could not**, StrictMode's double
invocation being development-only.

> **The reader went away on 2026-09-03 and the note is now dormant — the defect above is *not*
> back.** `CardDetailPane.tsx` was deleted when the card became `CardDetailModal`, and the mount
> effect that asked `consumeCaretNote(cardId)` went with it, so `consumeCaretNote` has no caller
> outside the suite while `keepCaretForCard` is still written by all three walkers.
>
> This paragraph first said the walk was "one press long again". **That was wrong, and it is worth
> saying why, because the mistake is the kind that gets a guard re-added against a defect that
> cannot happen.** Two things have to be true for the pane's failure to recur, and neither is:
> the surface must take the caret *per card* — `Dialog`'s panel-focus effect has `[]` deps, so it
> fires once when the modal opens, and the body it re-keys focuses nothing — and the walk must be
> able to run at all, which it cannot, because the panel is `aria-modal` with `trapTab` and the
> wall behind the scrim never receives the press. Card-to-card movement is the modal's own `‹ ›`
> flanks now, and they keep the caret on the chevron.
>
> So nothing goes red for it and nothing should: the tests assert the note is *written*, which is
> still true and still correct. A future surface that draws a card **without covering the list**
> would need the reader back.

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
| Panel | x 128 → 1152 (**1024** wide) | x 80 → 944 (**864**) |
| Chevrons | 85–121 and 1159–1195 | 37–73 and 951–987 |
| `documentElement.scrollWidth` | 1280 = `clientWidth` | 1024 = `clientWidth` |

The 1280 column is the width that shipped on 2026-08-21 — the section under this one. Before it,
while the panel asked for the whole reserved column, that column read x 80 → 1200, **1120** wide,
with chevrons at 37–73 and 1207–1243. **The 1024 one has never moved**, through three different
widths, which is the argument for reserving the room in the shell rather than off the panel.

Both are 36px discs on the panel's vertical centre (`cy` 400 against the panel's own 400 at
1280×800), and `elementFromPoint` at each centre hits the chevron rather than the scrim — the check
this repo's drag pass learnt to make before concluding anything about a control.

**No width the panel has asked for has needed anything of the chevrons, and that is the point of
where the room is bought.** It asked for `w-[72rem]` when the 1024 row was taken and `max-w-full`
clamped it to the column at both sizes, so 864 was already the *column's* number rather than the
request's; on 2026-08-20 it became `w-full` and the request **was** the column; since 2026-08-21 it
is a proportion of the window with that column as its ceiling. The chevrons sit in `FLANK_COLUMNS`
plus the scrim's own padding and travel with whatever the panel turns out to be — where a
`calc(100vw - 10rem)` would have had to restate both constants and would have parted company with
them the first time either moved.

### Three quarters of the window, and why the panel stopped being one

`AllPrintingsDialog` asks for `w-[min(100%,max(64rem,75vw))]` since 2026-08-21 — issue #157,
*Reduce the width of the View all printings popup*, reported against a 2560 display with a
screenshot of a **two-printing** card: two tiles packed against the left edge of a scrim-to-scrim
panel, and the rest of the window dim behind glass it could not be seen past.

The two widths before it were each right about the case they were built on and wrong about the
other one. `w-[72rem]` — 1152px — drew six 170px tiles in the middle of a 2400px column on that
same display. `w-full` (2026-08-20) fixed the wide-display end by asking for the whole column,
13 tiles across, and in doing so made *every* open the window. A wall is the only body in the
builder that can use arbitrary width, but only a wall with something in it: the modal is opened
from twelve surfaces, and the card under most of those presses has fewer than ten printings.

So the request is a proportion between a floor and a ceiling, and both guards are load-bearing:

- **`100%` is the ceiling**, which is `w-full`'s old meaning kept as a limit rather than a
  request. The panel never asks for more than the grid area the shell worked out — `p-0 sm:px-6`
  off the scrim plus `FLANK_COLUMNS`' 3.5rem either side whenever a walk asks for chevrons — so
  the flanks keep their room by construction. A `calc(100vw - 10rem)` would have had to restate
  both constants and would have parted company with them the first time either moved.
- **`64rem` is the floor**, the app's own 1024px window floor spelled as a panel width. At that
  window the reserved column is 864 and 75vw would ask for 768, less than the filter bar wants;
  the ceiling wins there and the panel is what it always was.

Measured in the shipped window 2026-08-21 (debug build, `tauri dev`), on `"Lifetime" Pass Holder`
— a two-printing card, the reporter's own case:

| Window | Panel | Wall | Tiles across at 100% zoom |
| --- | --- | --- | --- |
| 1920×1080 | x 240 → 1680 (**1440**), was 1760 | 1372 | 7, was 9 |
| 1280×800 | x 128 → 1152 (**1024**), was 1120 | 956 | 5 |
| 1024×768 | x 80 → 944 (**864**), unchanged | 796 | 4 |

`documentElement.scrollWidth` equals `clientWidth` at all three, both chevrons stay inside the
window, and the panel's own `scrollWidth` overhang is exactly **44px** — the 36px next chevron
plus its 8px gap, sitting outside a panel that deliberately does not clip. The filter bar wraps
its treatments onto a second line at 1280 and reports `scrollWidth === clientWidth`, so nothing
is cut off; at 1024 nothing moved at all.

Storybook's `Card/All printings` stories answer for the size the report came from, 2560×900:
panel **1920**, centred, wall 1852, **10** tiles across, and the flanked story's chevrons at
277–313 and 2247–2283 with `scrollWidth` still 2560. Forcing the panel back to `100%` in the same
frame is what the before column of the table above is — the fix and the fault photographed in one
pass rather than in two builds.

### But no height — the ceiling this dialog reported belongs to the shell

For two days, 2026-09-08 to 2026-09-08, this host named a height beside the width above:
`max-h-[min(100%,90vh)]`, the **one** height any host on this shell had ever spelled. It was the
right fix aimed one dialog too narrowly. The wall this modal draws is what makes the ceiling bind
on nearly every open — 865 printings of Forest is not an edge case — but Categories on a long
deck, History, Pull from collection and Import all reach it too, and every one of them drew to
24px of the window's top edge. So the rule moved into `Dialog`'s scrim as a vertical inset
(`sm:py-[max(1.5rem,5vh)]`) and every dialog in the app floats. The argument, the mixed-variant
trap it avoids, and the measured table are with the shell's own clamp — search this file for
*A clamped panel is not yet a floating one*.

`size` here is therefore a width and nothing else again. **Re-adding a height would be wrong
rather than redundant**, and in one direction: `cn`'s `tailwind-merge` deletes the shell's
`max-h-full` the moment a host names a `max-h-…`, so below `sm` — where the scrim is `p-0` and
every other dialog fills the phone's glass — this one alone would keep a 90vh cap and float on a
358px-wide screen. Measured at 500×844: 844px tall with the shell's rule, **759.6 at y 42.2** with
the old host string forced back on. Above `sm` the two agree exactly, which is why nothing else
about this modal moved.

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

Escape out of the modal drops the caret to `<body>`. That is `Dialog`'s behaviour for **every**
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

## The app draws its own tooltips, and the sweep off `title` is done

Full design: `docs/superpowers/specs/2026-08-20-tooltip-component-design.md`. `useTooltip()`
(`src/components/tooltip/useTooltip.ts`) is the one door: `{...tip(words, options)}` on the
element that already carries the hint. **A hint is that spread, never a `title` attribute and
never an SVG `<title>` element.** Every real tooltip in the app is `useTooltip()`'s now; one
native `title` survives on purpose (below), and everything else `title=` still matches in the
tree is a component prop — a heading or a prop a component turns into a `useTooltip()` binding
itself — never a native attribute a call site wrote. `title` and an SVG `<title>` still *work* in
the sense the browser still honours either if one is ever written back in, which is exactly why
this rule has to be stated rather than left to a linter: neither would go red.

**One panel, `fixed`, mounted at the app root — because a virtualised row is both
`position: absolute` and transformed, which caps every `z-index` inside it *and* makes that row
the containing block for a `position: fixed` descendant.** A panel anchored inside a row inherits
both traps at once. (**Three of the app's four tables virtualise; the deck's stopped on
2026-09-08**, when it took `VirtualTable`'s `grow` and its rows went into normal flow, `relative`
with a `minHeight` — neither transformed nor a containing block for anything `fixed`. One
virtualised wall is enough to settle where the panel mounts, and root-mounting is correct on a row
that traps nothing as well as on one that traps both, so nothing here moves. What it is not is a
licence to anchor a hint inside a deck table row: the placement is the hook's, not the caller's.)
A panel whose DOM node lives outside the whole tree, at `LAYER.tooltip`
(`z-47` since 2026-09-03, above every dialog rung because a hint can be shown over the deck
editor's dialogs — and over a nested overlay, which is what moved it off 46 — below
`gate`'s 50 because `SyncProgress` covers the window and a hint floating over it would describe
something the reader cannot see), needs neither raised further nor clipped by an
`overflow-hidden` scroller. `PrintingPreview` was what paying the alternative cost: it
placed its own preview with `frame.scrollTop`/`clientLeft` arithmetic instead of `fixed`, because
it had to stay inside its scroller's transform. That file was deleted with the docked card pane on
2026-09-03 and **nothing in the app does that arithmetic now**, so the comparison is a record
rather than a live example. `TooltipProvider` mounts in `src/App.tsx` and
`.storybook/preview.tsx`, both above `ContextMenuProvider`, for that provider's own reason — its
panel is a sibling of `children`, so a context nested inside it would wrap every view and none of
the menu's own rows.

**Each site is classified by what its words *are*, not run through a regex** — a regex cannot
tell an icon-only button's only name from a description of an already-named one, and the sweep
had to read every site rather than pattern-match it:

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

**One second-row site was left native on purpose, and it is the only one left at all:
`AppShell.tsx`'s drag-inert sidebar entry.** `DeckSearchPanel.tsx`'s "no room to search" hint and
`DeckStats.tsx`'s "already on your wishlist" hint were both later converted like every other
conditional description in the app — plain `useTooltip()` swaps, nothing left to say about
either. `AppShell.tsx`'s is a sharper case than a missing `aria-label` would have been, which is
why it stayed `title`: its own comment records that the sentence is never actually *shown* as a
native tooltip at all, because Chromium freezes `:hover` at a drag's origin for the whole gesture,
so mid-drag a reader gets the words only through the accname spec's description fallback rather
than through the tooltip mechanism either API offers. `useTooltip()` opens on a hover the reader
is equally not producing during that same gesture, so converting it would trade one hint that is
never *seen* mid-drag (but is still read, through the fallback) for one that is never seen and
never read either — a native `title` is strictly the better of the two here, not merely the one
nobody got round to.

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

**The sweep off `title` is done, and this file will still not carry a running count of it.** It
went in waves — a first proof slice (a truncated table cell, an interactive band, an icon-only
button, `SortableHeader`'s shared description so the change reached every sortable table at once,
one drawn inside a `DeckDialog` to prove `z-46` actually clears a real `z-45` scrim), then the
rest of the app's surfaces, then a final whole-branch review's own fix wave (dropping four
wrongly-`whenClipped` sites, unwrapping a `<span>` that had cost a control its keyboard path, and
fixing the binder those wrapped sites still need). **The shape that survives all of that, rather
than a count of it**: one native `title` left on purpose (`AppShell.tsx`'s drag-inert sidebar
entry, stated above), and every other `title=` in the tree a component prop rather than a native
attribute. A count here was wrong four separate times across this section and the design doc's
own — a scan that sliced source at the wrong `>`, a stale figure days out from a moving chrome, a
five-sites number that stopped being current the moment the next wave landed — and each wrongness
looked exactly like every other line in this file until someone re-ran the scan. Grep `title=` for
the actual number on the tree in front of you; do not write it down here a fifth time.

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
that question rather than assumed safe because the surrounding markup "looks like" a block. (The
`block truncate` span survives this call site's own final-review fix, which found a second,
unrelated defect there and dropped `whenClipped` from it entirely — the words shown are the set's
*name* while the span's own text is its *code*, so gating the panel on the code's clip was gating
it on the wrong string, not merely on an unmeasurable one. `block` still earns its keep: `truncate`
needs the layout box regardless of what decides whether the panel opens.)

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

## Turning a card that is printed sideways, driven in the shipped window (issue #156)

Four of Scryfall's layouts are not stored the way up they are printed, and until 2026-08-22 the
card detail pane drew all four exactly as stored — which for **722 live printings** meant a card
the reader could look at and not read. `split` (347, of which 96 are Aftermath), `planar` (330) and
`flip` (45); `meld` (72) is the fourth case and is a different problem, below.

**The direction each one turns is a fact about the cardboard, and it was settled against the
printed images rather than reasoned about** (2026-08-21, Scryfall's own `normal` JPEGs):

| Layout | Where the title reads from | Turn |
| --- | --- | --- |
| `split`, classic (`Assault // Battery`, `Fire // Ice`) | top-to-bottom down the **left** edge | 90° clockwise |
| `split`, Aftermath (`Dusk // Dawn`) | bottom-to-top up the **right** edge | 90° **counter**-clockwise |
| `planar` (`Llanowar`, `Naar Isle`) | bottom-to-top up the left edge | 90° clockwise |
| `flip` (`Akki Lavarunner // Tok-Tok`) | the second half is printed inverted | 180° |

One rule for both kinds of split would leave 96 printings upside down, which is why
`features/card/orientation.ts` is a function and not a constant.

**Aftermath is told by a rules-text prefix, and that needs saying out loud because it looks like a
shortcut.** Scryfall retired the `aftermath` *layout* — all 347 live split printings are
`layout: "split"` — and moved the word into a `keywords` array this app has no column for. The test
is `faces[1].oracleText.startsWith("Aftermath")`, and it agreed with that array on **347 of 347**
printings, 0 disagreements (measured 2026-08-21 against the local corpus). A `keywords` column
would be the stronger answer; it is not worth a migration for one boolean, and this is the note
that says so.

### The frame turns with the card, and the alternative was worse

A quarter-turned card is a **landscape** rectangle, so the pane's layout has to know: the frame
carries the proportions (`aspect-ratio`, `CARD_ASPECT` reversed) and the card inside it carries the
rotation. Everything under the art moves up to meet a turned card rather than leaving a hand's
width of nothing under it — measured in the shipped window at 900px, a **335×469** frame becoming
**335×239**.

`aspect-ratio` is *transitioned* rather than snapped, which is not obvious: it interpolates in
Chromium. Sampled over a 600ms transition on a standalone page in Chromium 151, a 200px-wide box
went 280.0px → 208.3px → 142.8px across 79 frames (2026-08-22). The alternative — `height: 0` with
a transitioning `padding-bottom` percentage — animates in every engine but spells the proportions
of a Magic card out twice more, which is the drift `src/CLAUDE.md` already records the deck Grid
view paying for.

**The card's size is what makes it fill the frame exactly.** Quarter-turned it is `CARD_ASPECT` of
the frame's *width* and the reciprocal of its *height*; upright it is `100%` of both. At rest in
either state the card's bounding rect **is** the frame's — confirmed live at 335×469 and 335×239,
same origin — so the foil sheen laid over it needs no arithmetic of its own, and only the 260ms
between the two states is a card slightly larger than its box. That is why the frame carries **no
`overflow-hidden`**: clipping it chops the corners off a card that is mid-turn.

### The half-pixel the pass found, which no test could

Centring the card with `left-1/2 top-1/2 translate(-50%, -50%)` is the obvious way and it was
wrong. The pane's art column is **335px** in the shipped window — an odd number, because the pane's
own scrollbar takes 17 of its 352 — so the resting transform came back as
`matrix(1, 0, 0, 1, -167.5, -234.5)`: a **half-pixel composited offset on every card the app draws
in this frame**, turnable or not, resampling art that used to be laid out on the pixel grid.

`absolute inset-0 m-auto` with an explicit width *and* height centres the same box by **layout**
instead, which lands on the grid; and the resting `transform` is omitted rather than written as
`rotate(0deg)`, so the common case has no compositing layer at all. Measured before and after over
CDP on the same window: `matrix(1, 0, 0, 1, -167.5, -234.5)` → `none`, and turned,
`matrix(0, 1, -1, 0, -119.641, -167.492)` → `matrix(0, 1, -1, 0, 0, 0)`. A transition *from* `none`
still interpolates from the identity, so nothing was lost.

**jsdom has no layout engine and no opinion about a `transform`**, so none of this is assertable in
the suite. What the suite pins is the decision — `data-card-turn` on the card, carrying the angle —
and the pixels are the live pass's business. That split is the same one `FoilOverlay`'s
`data-foil-sheen` draws.

### Meld: two verbs, because they are two acts

A meld half offers **Meld — <the melded card>**, which puts that card's picture in this frame while
the pane stays about the card the reader opened, and **Open melded card**, which makes it the open
card. Collapsing them into one would take away the comparison the first is for. From the melded
card the two halves are `Meld part — <name>` and they only *open*: the picture in the frame already
is the meld, so there is nothing for a view to do. The round trip was driven live —
Gisela → melded picture → Brisela → `Meld part — Gisela` → back.

Two things fall out of a picture swap that a flip does not have, and both are corrections rather
than polish:

- **The illustrator credit follows the picture.** Scryfall's image policy wants the artist of what
  is on screen, and the two halves of a meld need not share one — so `MeldRelation` carries an
  `artist` and `artistOf` prefers it outright rather than falling back to the open card's, which
  would print a name that is *wrong* rather than missing.
- **The foil control stands down while a meld view is up**, both the button and the mark. The sheen
  is a statement about *this printing's* cardboard and the picture is another card's. Hiding only
  the button would not have been enough: `soleFinish` draws the sheen for a foil-only printing
  without any toggle being on, so the mark had to go too or it would outlive the control that
  explains it.

### What the pass confirmed, and what it cost

Driven over CDP against the real 116,700-row database (debug build, 2026-08-22): all four turns,
both meld directions, `scrollWidth === innerWidth` at 900px (below the app's own 1024 floor), a
clean console across a full turn cycle and a full meld cycle (13 lines, none of them a warning),
and `transition-property: none` on both the frame and the card under
`prefers-reduced-motion: reduce`.

**The control is the card pane's and only the card pane's.** A wall of tiles is for finding a card,
not reading one, and a turned tile in a grid of upright ones would be a hole in the rhythm.

## The app's own mark, and the 24px floor it is drawn against

**2026-08-22.** The artwork lives in `logos/`, which is the source of truth for it:
`logos/svg/mtg-grimoire-mark.svg` is the master and the thing to edit, and everything beside it
is an **export of that file** — `logos/svg/mtg-grimoire-tile.svg` (the mark on the dark rounded
tile), `logos/png/mark-*.png` from 16 to 1024, `logos/icon.ico` (six sizes in one file) and
`logos/tauri/`, a drop-in replacement for `src-tauri/icons/`. A change that only reaches a PNG is
a change the next export undoes.

**The colours in that package are this app's own tokens resolved to hex**, which is the whole
reason the mark can be drawn inline rather than loaded: gold `#D1A84B` is `--color-accent`, the
panel `#16181E` is `--color-surface`, and the field `#0C0D12` is `--color-bg`.
`src/components/GrimoireMark.tsx` binds them back the other way — every stroke is `currentColor`
and every fill is `var(--color-surface)` — so the mark takes its gold from whatever the caller
sets `text-*` to, and a token that moves takes the mark with it instead of stranding a hex in a
binary. The `#0C0D12` field is a fact about the exported **tile**, and about nothing that ships:
the inline mark is drawn on whatever surface it lands on, and since 2026-08-22 so is the desktop
icon.

**The desktop and taskbar icon is the transparent mark, and the tile it replaced was only ever
invisible against a dark background.** `#0C0D12` is `--color-bg`, so on the app's own surfaces and
on a dark taskbar the plate reads as no plate at all — and that is exactly why it survived as long
as it did. Everywhere else it is a black rounded square: the Explorer file list, a light-theme
taskbar, a pale wallpaper, the Alt-Tab strip. The measurement is the whole argument — the tile
exports were **3–5% non-opaque** (the rounded corners, nothing else) against **45–60%** for the
mark, across all sixteen files of `src-tauri/icons/`.

Two consequences, both worth knowing before somebody reads them as damage. **The book grew 5.7%**,
because `mtg-grimoire-mark.svg` draws at `scale(0.92)` where `mtg-grimoire-tile.svg` draws at
`0.87` and spends the difference on its own edge — so dropping the plate did *not* shrink the icon,
which is the thing one would expect it to do. And **the `.ico` ladder is 16/24/32/48/64/256 now**,
where it was 16/32/48/64/128/256: `npx tauri icon` picks that set, and it is the better one for
this platform — Windows asks for 24 (small taskbar, Alt-Tab) and interpolates 128 from 256 — but it
was the generator's choice rather than a tuned one, which is the honest way to record it.

**Nothing in either suite can see any of this.** The icons are binaries referenced by
`tauri.conf.json`'s `bundle.icon` list and by nothing in `src/` or `src-tauri/src/`, so a tile
could come back through a re-export with `npm run verify` fully green. `logos/README.md` carries
the regenerate command and the warning next to the artwork, which is the only place that fence can
live.

**How it was checked instead, and the check is worth repeating rather than rediscovering.** A
screenshot of the running window proves nothing here — the taskbar icon is a **Win32 resource in
the exe**, not anything the webview draws, and Windows caches shell icons hard enough that a stale
one survives a rebuild and reads as a failed change. Three steps, none of which needs the app lock:

1. **Read the `.ico`'s own entries**, not a re-downscale of `icon.png`. Windows picks an entry;
   walking the directory at offset 6 (16 bytes each) and writing out each embedded PNG is what
   shows the bytes it will actually paint. Composite them over a light ground — over a dark one
   the old tile and the new mark are nearly the same picture, which is the whole reason this
   shipped.
2. **Read `src-tauri/target/debug/build/mtg-grimoire-*/out/resource.rc`.** `tauri-build` writes it,
   and the `32512 ICON "…"` line names the absolute path it embedded — `32512` is
   `IDI_APPLICATION`, the icon the shell reads off the exe.
3. **Search the sibling `resource.lib` for the literal PNG bytes** of a new entry and of the one it
   replaced. `Buffer.indexOf` over the file is enough: found-new plus absent-old is the whole
   chain, config to linked resource, with no launch and no icon cache in the way. Verified that
   way on 2026-08-22 (debug build) for the 16, 48 and 256 px entries.

**The floor is a rendered size, not a design intent, and that is why the component takes a pixel
size rather than a variant flag.** The artwork is on a 64-unit grid, so a rendered pixel costs
`size / 64` units. At 20px the book's heaviest stroke — the boards' 1.7 — is **0.53px**, and
every hairline under it is thinner still: the casting circle's dashed ring (0.85) is **0.27px**
and the diamond's facet lines (0.75) are **0.23px**. That is the logo package's own warning
arriving as arithmetic (`logos/README.md`: "below about 24 px the casting circle and the clasp
rivets fill in"), and `DETAIL_FLOOR` is its number. A caller passes `size` and
`GrimoireMark` picks; a variant flag would make "which drawing does a 34px title bar want" a
question every call site answers again, and the wrong answer is invisible in jsdom and easy to
miss in the window.

**The small variant is a rendering of the master, not a second drawing.** Same grid, same
coordinates, same order; what it drops is exactly what the package predicted would fill in — the
dashed casting circle and its inner ring, the seven radial runes, the page block and its four
corner cuts, the diamond's facet lines, the clasp's two rivets and its gem, and the gradient. It
then thickens **every kept stroke by 1.4×** (`SMALL_STROKE`), which puts that 0.53px board
outline at **0.74px**: a hairline on purpose rather than by accident, and deliberately delicate
because the wordmark it stands beside is 13px Cinzel at 0.2em and a heavy mark next to fine type
is a lockup with two voices. One constant because it is one decision — tuning it moves every kept
stroke together, which is what keeps the small variant from drifting into a separate drawing.

**The gradient goes with them, and `FinishMark` wrote the reason down first**: a gradient "is not
perceivable [at that size] and costs an SVG `<defs>` whose id has to be unique per instance". At
20px the diamond is about four pixels across, which is no room for three stops, so the small
variant fills it flat and ships no `<defs>` at all. The full variant keeps it and
scopes the id with `useId`. **Replacing that with a constant id is silently wrong** — duplicate
ids are legal-looking, the second mark on screen paints from the first one's `<defs>`, and
nothing shows it until the day two marks are drawn at different sizes.

**Where it is drawn, and at which side of the floor.** The window's own caption draws it in the
34px row measured under "The window's own title bar" above, at 20px — the one size in the app
below the floor, so the simplified variant, and it gets there without being asked. The first-run
overlay draws it at 64px, where the full artwork has the area the gradient and the casting circle
were designed for. The Settings version panel draws it beside the version it names, clear of the
floor and so also in full. All three are lockups — the mark stands next to the product name
already set in type — which is why it is `aria-hidden` unless a caller passes `label`.

**Every one of those three draws it in the accent, and that is not a hole in the gold-vs-dim
rule.** `SyncProgress.tsx` states the rule at its own site — "Dim rather than gold — gold means
'you can act on this', and a name is not an action" — and it governs **type and controls**, where
gold is what tells a reader something is pressable. A mark is a picture rather than a word: it
makes no offer, so it makes no false one. Extending the rule to the app's own logo would say the app may
never draw its logo in its own colour, which is a conclusion about branding drawn from a rule
about affordance.

## The dropdown's panel, and the containing block that only a browser could refute

**2026-08-26, `npm run build-storybook` — which is `storybook build`, a _production_ Vite bundle
rather than a debug one — served on a throwaway port and
driven in headless Edge 151 at 1280×800 — `documentElement.clientWidth` 1256 px and `clientHeight`
708 px, identical to `innerWidth`/`innerHeight`, so no scrollbar separates the two in this
document.** Every figure below is a reading from that window.

**This pass exists because the suite cannot reach any of it.** jsdom implements no layout — every
rectangle it measures is `0` — so `usePopupPlacement` is executed by the whole `Dropdown` suite
without a single one of its numbers being *tested*. `place.test.ts` covers the arithmetic; whether
that arithmetic is fed the right rectangles, and whether its result lands where a reader can see
it, is a question only a browser answers. `src/components/Dropdown/PlacementProbe.stories.tsx` is
the three containers the placement has to survive, and it carries no `play` — a play would be a
second jsdom reading of the same zeros.

- **Inside an `overflow-y-auto` scroller the panel escapes its container, which is the whole
  point.** Scroller `top 16 bottom 176` (160 px tall); trigger `left 29 top 78 bottom 114`; panel
  `left 29 top 118 bottom 392` — **216 px past the scroller's own bottom**, and still 316 px clear
  of the viewport floor. A native `<select>`'s list escaped this; an absolutely-positioned panel
  would have been cut off at 176. `panel.left − trigger.left` = **0 px**, gap below the trigger =
  **4 px**.
- **Inside a settled `Dialog`'s box the frame correction does real, non-zero work, and this is the
  reading the whole approach stood on.** The probe's box carries `scale: 1` — what motion leaves on
  a `Dialog` panel at rest, and **not** `none` — so it is a containing block for a `fixed`
  descendant. The zero-size `fixed` frame the shell renders at `left: 0; top: 0` measured its own
  rect at **`left 113 top 113`** instead of the viewport origin. Against a trigger at viewport
  `left 137 top 137 bottom 173`, the panel drew at `left 137 top 177` — `panel.left −
  trigger.left` = **0 px**, gap = **4 px**. **Uncorrected the panel would have sat at viewport
  `left 250`, 113 px to the right of the control that opened it** — a styling bug to look at, and a
  coordinate bug in fact.

  **Those two measurements are the whole proof, and it is worth being exact about which two.** They
  are `frameOrigin ≠ (0,0)` — the containing block exists at all — and `deltaLeft == 0` — the
  correction cancelled it exactly. **Adding the panel's inline offsets to the frame origin proves
  nothing**: the panel is `absolute` inside the frame, so rendered-left is *identically*
  frame-origin + inline-left, under any offset, with correct code or broken code. That sum cannot
  fail, so it cannot be evidence. An earlier draft of this section rested on it; this paragraph is
  the correction.

  **Three independent checks say the `113` is the transform's doing and not the margin's.** First,
  the counterfactual: with the same `ml-24 mt-24` margin but **no** transform, `fixed left-0 top-0`
  is viewport-relative and the frame reads `(0,0)` *regardless of the margin* — so `113` is not the
  margin, it is the margin **made visible by** the transform. Second, `InAScroller` is a real
  control rather than an unpositioned story: same padded preview root, its own non-zero local
  offsets, and it still reads `(0,0)` — which rules out both a transform on the preview root and
  the frame being accidentally `absolute` against some positioned wrapper. Third, `113 = 16 + 96 +
  1` is the containing block's padding-box origin exactly (preview-root padding + margin + border).
- **At the bottom of the viewport it flips, and it flips from the right corner.** Trigger
  `top 660 bottom 696` against a 708 px viewport; panel `top 382 bottom 656` — **above** the
  trigger, `trigger.top − panel.bottom` = **4 px**, both edges inside the viewport. The class came
  back `origin-bottom-left` rather than `origin-top-left`, so the panel grows from the corner it is
  pinned by — this app's standing rule for an anchored popup, confirmed in the DOM and not only in
  the arithmetic.

**Two mechanics worth keeping, because each is a way to misread this surface.** The panel measured
`offsetWidth` **143** against a rect width of **143.234375** — sub-pixel layout rounding, *not* the
entry tween, and the pass proved the difference by re-reading each rect 200 ms apart until two
agreed and `getComputedStyle(panel).transform` had settled at `none`. A rect taken on the mount
frame instead is 4% short in both axes, which is why sizes come from `offsetWidth`/`offsetHeight`
and positions from `getBoundingClientRect()`. And the panel's `min-width` came back **126 px** in
all three — the trigger's own `offsetWidth` — so a picker never opens narrower than the control
that produced it.

**What this pass did not measure, stated rather than implied.** Two residuals, and neither is
dismissed on the grounds that its failure would be obvious — because neither would be.

**The horizontal flip was never forced.** All three stories came back `origin-*-left` with `flipX`
false, because a 143 px panel at `left 29`, `137` and `12` cannot run past the far gutter of a
1256 px viewport. The `align: "end"` path and the `VIEWPORT_GUTTER` clamp are therefore still
arithmetic-only — covered in `place.test.ts`, unproven in a browser. **This is not a hypothetical
path**: `place.ts` names two shipping set pickers that pass `"end"`. And its failure is *silent*
rather than visible — `VIEWPORT_GUTTER`'s own comment is the reason, since nothing in this app clips
a popup, so an overflowing panel gets no scrollbar and instead "scrolls the whole app sideways the
moment anything calls `scrollIntoView` on it". Deferred as a known residual, not as a safe one.

**Nothing here combines a transformed containing block with an intervening scroller — and that
union is exactly what all eight in-dialog call sites are.** `InAScroller` escapes its scroller only
because nothing transforms in that story, and `InATransformedBox` has no scroller between the
trigger and the box. Tracing it resolves in favour: the `fixed` frame's containing block is the
dialog panel, the scroller is not in that chain, and `Dialog.tsx` records that the panel
deliberately does not clip its content. But that is **two subtle facts holding it up, neither
measured**. The first in-dialog migration should take the reading rather than inherit this one.

### The panel's own list is not an ancestor — issue #335

**A dropdown closed when the reader scrolled it.** `usePopupPlacement` closes rather than follows,
which needs a `scroll` listener on `window` in the **capture** phase — `scroll` does not bubble, so
a view's own scrollport is invisible any other way. Capture from `window` then delivers *every*
scroll in the document, and the options are drawn in a `max-h-64 overflow-auto` list, so the panel
closed itself the instant its own list moved. The close exists for a **trigger that scrolls out
from under a panel placed once**; the panel is a descendant of the trigger's root and can never be
that, so the guard is `panelRef.contains(e.target)` — a carve-out, not a heuristic. It is written
against the panel rather than the list so a footer or a search box that grows a scroller later
cannot bring it back.

**It cost more than the wheel, which is the part the report could not see.** `Dropdown`'s
cursor-reveal effect calls `scrollIntoView({ block: "nearest" })` on the active row, and that is a
scroll of the same list — so arrow-walking past the fold, and opening a picker whose *picked* row
sits below the fold, closed the panel too. Measured in headless Edge 152 at 1280×900 against the
worktree's Storybook (`search-setcombobox--open`, 36 rows, `scrollHeight` **1152** in a
`clientHeight` of **256**): `scrollIntoView` on the last row took the list to **896** and the panel
stayed up, where every one of those scrolls had reached a `window` capture listener with
`target` = the listbox.

**Both gestures in the report were driven as real input, because neither suite can express them.**
jsdom has no layout, so nothing there can scroll a box — `Dropdown.test.tsx` dispatches the
`scroll` event the gestures end in, which is the part a suite without layout can still pin. The
gestures themselves went through `Input.dispatchMouseEvent` over raw CDP, since the panel's
scrollbar is not an element any tool can be handed: a press-drag-release on the list's own **15 px**
scrollbar took `scrollTop` **0 → 838** with the panel still open and `aria-expanded` still `true`.

**That drag also settles a question the `focusout` closes all depend on.** The press moved focus —
`focusout` from the trigger to the `<ul>` — so a scrollbar drag *is* a blur, and a panel that
closes on one survives only because the new focus is inside it. Chromium walks focus to the
**nearest focusable ancestor**, measured on a probe of `MoveToFolder`'s exact shape (a plain
scroller inside a `tabIndex={-1}` panel): focus landed on the panel, not on `<body>`, so
`relatedTarget` is non-null and contained. `MoveToFolder`, `DeckBracket` and `ValidationPanel` are
each that shape and none of them registers a scroll listener at all, so the bug was `Dropdown`'s
alone.

## The card's chin, and the one foot under every card in the app

`src/components/CardChin.tsx`, 2026-08-26. Three surfaces drew a foot under a card and each held
its own numbers, which is how a shared look stops being shared:

| Surface | Foot at 1× | Type at 1× | The bar |
| --- | --- | --- | --- |
| `CardStack` — the deck's stacks | **28px** | **10px** | `bg-surface`, `border-x`, the face's own 7px bottom corners, riding 4px up into it |
| `CardGrid` — every wall of tiles | **25px** | **12px** | none — a bare caption, with a 4px gap between it and the art |
| `GridView` — the deck's grid | **20px** | **9px** | none |

Only the first read as *part of* the card; the other two read as a label under a picture. There is
one component now, and `chinHeight(zoom)` in `src/lib/cardZoom.ts` is the height every surface
budgets from. `CardStack` keeps `STACK_DATA_HEIGHT`, `STACK_DATA_RISE` and `stackDataHeight` as its
names for `CHIN_HEIGHT`, `CHIN_RISE` and `chinHeight`, so its geometry sums — and every assertion
written against them — keep the names they were written under.

**The type belongs to the component and no caller passes one.** It is the stack's
`text-[calc(0.625rem*var(--mark-scale,1))]`, written once inside `CardChin`, which is why
`GridView` no longer has a `CAPTION_TEXT` constant and `CardGrid` no longer has `CAPTION_HEIGHT` or
`CAPTION_GAP`. There is deliberately **no `chinText` function** to go beside `chinHeight`: a height
is a number the *host* has to budget for, and a type size is not.

**The table above is the state on 2026-08-26 and the deck's grid row is history twice over.** That
surface drew its own 20px/9px foot until this component landed, and from 2026-09-08 it is not
drawing its own card at all — the tile is `DeckCardFace` in a `rounded-lg border` wrapper with
`CardChin seam="card"` under it, which is the stacked card's arrangement rather than a third one.
So the row's two numbers record what the drift *was*; what the wall pays today is the stack's,
because it is the stack's.

**What each host actually pays, because the spec's arithmetic was out.** The bar is 28px at 1× on
every surface; what a host *adds to its tile* is `chinHeight(zoom) - CHIN_RISE`, **24px at 1×**,
since the bar rides up into the face. So a `CardGrid` tile's foot went 25 → **24, one pixel
_less_** — not the "+3px at 1×" the design doc claimed off `28 − 25`, because the old 25 was
`ceil(24 × CONTROL_SHRINK) + CAPTION_GAP` with a 4px gap already inside it and the chin has no gap
at all. The deck's grid used to add a 20px bar and now adds 24 of a 28px one; it **budgets
nothing**, being a plain scroller rather than a virtualiser. **The rest of that sentence named a
`footHeight` local that positioned the controls strip on the chin's top edge, and there is no such
local since 2026-09-08**: the tile draws the stack's controls column instead, `DeckCardControls
layout="card-column"` at `absolute top-9 right-1.5`, which needs no computed offset at all —
`top-9` clears the 27px printed title bar the quantity tag and the plan's tick sit in (the game
changer is *inside* that tag since the same day, so the strip is two marks on both card-face views
— see the game-changer bullet near the top of this page for the width that decided it), and the
column
runs down the card's right margin from there. An absolutely positioned column takes no height, so
the tile is still exactly as tall as its face plus its chin. The stacks did not move at all: 28
is where the number came from, and `stackCardHeight` has always subtracted the rise.

**`CHIN_RISE` is 4px at every zoom, and that is a derivation rather than an oversight.** The chin
rides up so the face's clipped corners cover its square ones; butted flush, two hairlines of
background show through the gap. The radius it hides under is a Tailwind class and does not scale,
so neither does the overlap. Everything *inside* the bar does — the gem, the gutters, the glyph and
the words are all `calc(… * var(--mark-scale, 1))`, so the bar and its contents are one proportion.
That is also why the floor those two feet used to take went with them: a floored bar is 28px of
empty felt under a 105px card once the type inside it has learnt to shrink.

**`seam` is required, has no default, and that is the point.** It says whose outline the chin
joins, and the two hosts own their outline differently: `"card"` sits under a bordered card and
takes `border-x` only, ridden `-mx-px` onto the card's own border so the two are one line;
`"art"` sits under a `CardArt` frame, whose own edge stops where the bar begins rather than
enclosing it, and supplies all three edges itself — flush rather than ridden onto, since both boxes
are the tile's full width and are already collinear. **A `border-b` on the `"card"` seam is the defect the prop exists to prevent** — the card's
border already *is* the bottom edge, so a second one sits 1px above it and draws a card with a 2px
foot and a 1px everything-else. A defaulted prop would have served whichever host is in the
minority, and a call site that simply forgot it would compile, pass, and ship that foot: jsdom
cannot see it and a screenshot barely can. `CardChin.test.tsx` pins both seams, through
**`classList.contains("border-b")`** and never
`className.toContain` — because the string `"border-border"` *contains* the substring `border-b`,
so the obvious spelling passes on both seams and asserts nothing. That is this repo's recurring
vacuous-assertion shape, and it is what makes the difference between a pinned prop and a pinned
nothing.

**The sentence above named `views.test.tsx` as pinning "the deck grid's own bottom edge", and
there is no bottom edge there to pin since 2026-09-08.** That tile passes `seam="card"`, where it
passed `"art"`: the face inside its button clips its own corners at `rounded-[7px]` and the tile
itself carries the `rounded-lg border`, so the chin draws `border-x` only and rides onto the card's
own border exactly as a stacked card's does. `"art"` is what a bare `CardArt` frame needs and there
is no longer one on that wall. The lesson the sentence was carrying is untouched and is why it is
corrected rather than cut: `classList.contains` over `className.toContain` is the difference
between a pinned prop and a pinned nothing, and it matters *more* on the `"card"` seam, where the
assertion is about a class that must be **absent**.

**`CardArt` gained an edge of its own on 2026-08-26, and it costs the wall no height** (headless
Chromium over the shipped `dist/` stylesheet, a 238px tile, the app's dark theme). The `"art"` seam
had the chin drawing all three of its edges under a frame that drew none, so on every wall in the
app the picture simply *stopped* and a bordered bar *started* — reported by a reader as a cut-off
that looks rough, and visibly worse than the deck stack's card, which has been one bordered object
all along. The frame is `border border-border` now, the chin's own colour, so the outline runs from
the top of the picture through the bar's rounded foot.

The measurement that mattered is the box: Tailwind's preflight makes every element `border-box`, and
an aspect ratio on a `border-box` element is a ratio of the **border** box — so the frame's outer
box is **238 × 333** with the edge and **238 × 333** without it, and the tile 354 either way.
`CardGrid`'s row pitch is `Math.round(tileWidth * 7 / 5) + chinHeight(zoom) - CHIN_RISE`, which is
`333 + 25 - 4` at 1× — unchanged, so the virtualiser needed nothing. What moves is the picture
inside: `clientWidth`/`clientHeight` go 238 × 333 → **236 × 331**, one hairline each side, which is
exactly what the stack's card has always done to its own face. **Both rings survive it**, because a
ring here is a spread-only outset `box-shadow` (`ring-2 ring-accent` measures
`oklch(0.75 0.12 85) 0 0 0 2px`) and an outset shadow paints outside the border box: the gold hugs
the new edge rather than replacing it, and the deck grid's `ring-2 ring-destructive` — which sat on
the wrapper one level out — was unchanged in both colour and geometry. (**That ring is gone since
2026-09-08**: a rule break on a deck tile is `border-destructive` on the wrapper, with
`CardChin`'s `tone` carrying the colour through the foot — see the paragraph two below, which is
where this reverses. Nothing about `CardArt`'s own edge or about `SELECTED_CARD` moved; that gold
is still a ring on the `<li>`, still painted outside the border box, so a picked card that also
breaks a rule still wears gold around red.) The one artifact is at the
seam itself and is about a pixel: the frame's `rounded-lg` corner curves inward over the 4px the
chin rides up, so the outline pinches ~1px before the bar's straight edge resumes. `CHIN_RISE` was
derived from the stack's 7px face radius, where the same excursion is 0.68px; at the art's 10px it
is 2px, of which the bar covers all but the top hairline.

**`tone` is the other half of the same join, and the deck stack was its one caller until the deck's
grid became the same card on 2026-09-08 — two now, and they are two drawings of one object rather
than two decisions.** The bar is
`relative` and later in the document than the face, so its border paints *over* the card's along its
whole height. A rule-breaking *stacked* card is outlined in destructive, and a chin that kept the
default border would put the wrong colour back through the card's left and right edges — the one
thing that outline exists to say. That sentence is now true of the tile word for word.

**The deck's grid tile was the same argument run backwards and passed no `tone` at all** (the
same day, once the frame above had an edge). That tile's outline was `CardArt`'s new
`border border-border`, which is *neutral* whatever the card is doing, because a rule break there was
the `ring-2 ring-destructive` on the face — an outset shadow, painted outside the border box, which
is why the two did not compete. So a reddened chin under a grey frame ran the card's outline grey
down the art and red across its foot: the tile stopped reading as one object at exactly the join the
frame was given an edge to close. Reddening `CardArt` instead was refused — it draws the same fact
twice beside the ring, and that component's two callers mark a rule break differently, so the colour
is not its decision to take.

**Every clause of that was about a tile whose edge belonged to the picture, and the argument
expired with its premise on 2026-09-08.** The tile is `rounded-lg border` around a
`DeckCardFace` — the stacked card's arrangement — so the **wrapper** is the card's edge and it is
what a rule break reddens (`border-destructive`, where it was `ring-2 ring-destructive` on the
face). A neutral chin under that would put 28px of `border-border` back through the left and right
edges of the very outline the reddening exists to draw, which is the failure the paragraph above
names, arriving from the other side. So the tile passes `tone` now, exactly as `CardStack` does,
and for the same reason. What did **not** change is the refusal at the end: reddening `CardArt`
is still not that component's decision, and it is not asked to — the deck's two card views reach
it for `FoilOverlay` alone.

**The printing line is a union, not four loose optionals.** A caller either supplies `setCode` and
`collectorNumber` — the default `SET · number` — or supplies a `printing` node of its own *and* the
`printingTitle` that goes with it. Independent optionals would let a chin with neither compile and
then draw a bare `" · "` on a wall of forty cards; and making `printingTitle` required on the
caller's arm stops the wishlist's "Any printing" from inheriting a hover that names the very
cardboard the line refuses to name.

**The chin is a sibling of the card's button, never a child of it.** Everything in it is a *fact*
about the printing rather than a mark on the picture, so unlike the overlays on the art it is
announced instead of being swallowed into the button's accessible name. The price and the printing
had no reader at all while they were inside it.

**Two dated readings earlier on this page are superseded rather than wrong.** The 2026-08-17
mark-scale pass records a search-wall `caption type 6 / 12 / 24px` and a deck-grid `foot 10 / 40`;
both are readings of feet that no longer exist, taken correctly at the time. The same pass's
`data line 14 / 28 / 56 at 5 / 10 / 20px` on the deck stack is the chin, and still stands — it is
the one of the three that did not move.

**The geometry has not been driven in the shipped window yet.** The seam at 0.5×, 1× and 2× on all
three hosts is exactly the half no suite can see, and it is Task 14 of
[the plan](../superpowers/plans/2026-08-26-card-chin-and-exact-prices.md). The class assertions
above pin a string rather than a pixel and do not retire it.

## The selection ring goes round the whole card, not round the picture (2026-09-08)

`CardGrid` drew `selected` straight through to `CardArt`, which paints `ring-2 ring-accent` on the
5:7 frame. So the gold ring stopped where the picture stopped and the chin hung outside it — an
outlined photograph glued to an unoutlined bar, on a tile whose whole geometry exists to say the
opposite. `CHIN_RISE` is 4px precisely so the foot rides up over the face's clipped corners and the
two read as one piece of cardboard; a ring that ended at the seam contradicted the one thing that
rise is for.

It is on the **tile root** now, and `CardArt` is passed no `selected` from this wall:

```
"group flex shrink-0 scroll-m-1.5 flex-col rounded-lg", selected && "ring-2 ring-accent"
```

Three things are worth writing down.

**`rounded-lg` is the right radius and is not a guess.** `src/index.css` sets `--radius: 0.625rem`
and `--radius-lg: var(--radius)`, so it is **10px** here rather than Tailwind's stock 8 — the same
utility `CardArt`'s frame already uses on its top corners and `CardChin`'s `rounded-b-lg` uses on
its bottom ones. The ring therefore traces exactly the outline the two components already draw
between them, at every zoom, with nothing to keep in step.

**It costs no layout, so nothing the virtualiser measures moved.** A Tailwind `ring` is a
spread-only outset `box-shadow`, painted outside the border box; the tile's width, its `tileHeight`
and the row pitch are what they were with no ring at all. `scroll-m-1.5` was already 6px of scroll
margin sized for `FOCUS`'s 4px-proud outline, which is more than this needs.

**`CardArt` keeps its `selected` prop and must.** The deck's grid and stack views and
`AllPrintingsDialog`'s tiles draw that component directly, and there the art genuinely *is* the
whole object — the wall is the one caller for which "the card" is bigger than "the picture".

**What it reaches.** `CardGrid` is one component and seven surfaces draw it, so the ring changed on
all of them at once: the search wall, the collection, the tags results, the wishlist, and the three
docked search columns. That is the intended blast radius rather than a side effect — a reader who
has learnt one of this app's walls has learnt all of them, and a wishlist that ringed differently
from the collection beside it would be the drift this component exists to prevent.

**Seven tests catch it moving back**, proved by mutation on the day: putting `selected` back on
`CardArt` and taking the root's class off reddens three in `CardGrid.test.tsx`, three in
`AllPrintingsDialog.test.tsx` and one in `CollectionSearchTab.test.tsx`. The assertions that used
to reach for the `<img>`'s parent climb to `[data-grid-index]` instead, and
`CollectionSearchTab`'s `ringed` helper asserts the class is on the tile **and** on nothing inside
it — so a ring that crept back onto a descendant is red rather than silently equivalent.

**Not driven in the shipped window as of this writing.** jsdom loads no stylesheet, so everything
above is a class assertion; how the ring reads against the chin's own border at 0.5× and 2× is a
live question.

## Drag and drop: what `@dnd-kit/dom` 0.5.0 actually requires

Measured 2026-08-27 against **0.5.0** (pinned exactly, no caret — it is pre-1.0 and its API can
break between releases), by building the smallest real thing and reading what happened rather than
reading the docs.

**The section is titled for `@dnd-kit/dom` and was titled for `@dnd-kit/react` until 2026-08-28,
which was wrong the day it was written**: nothing in `src/` ever imported the React package, every
answer below is about the DOM one, and §1 and §2 are the record of deciding not to use the hooks.

**As of 3c (2026-08-28) the manifest declares exactly what the code imports and nothing else:**
`@dnd-kit/abstract`, `@dnd-kit/collision` and `@dnd-kit/dom`, all three pinned at `0.5.0` with no
caret. That is the end of a defect this repo hit once and should not hit twice — 3a declared
`@dnd-kit/react` and wrote `dndManager.ts` against `@dnd-kit/dom`, so the module every drag in the
app went through was an **undeclared transitive** of the wrapper, one `npm update` from resolving
to something nothing pinned. 3b declared the two the code imports; 3c removed the wrapper, which
was never imported at all.

**Removing it gives up one signal, and this line is where that signal now lives.**
`@dnd-kit/react` was the only package in this tree that declared a React peer dependency
(`react` and `react-dom`, both `^18.0.0 || ^19.0.0`); `@dnd-kit/dom`, `@dnd-kit/abstract` and
`@dnd-kit/collision` declare no peers at all. **Which React this drag stack has been proved
against is therefore this repo's to record rather than the dependency graph's: React 19, on
Windows, as of 2026-08-28.**

**`@atlaskit/pragmatic-drag-and-drop` and its auto-scroller were uninstalled in 3c**, taking
`bind-event-listener` and `raf-schd` with them — four packages, `npm`'s own count. 3b had already
removed the last import; 3c removed the last call sites in the test harness and then the
dependency. `src/lib/dndManager.test.ts` is the fence that keeps them out, and **it matches an
import statement rather than a name**, on purpose: many files in this app still mention
pragmatic-dnd in a doc comment as the record of why something is the way it is, and a sweep
that matched the name would turn this project's memory of its own reasons into a red build.

**The coexistence rule this section used to open with is history, and one sentence of it was
wrong about the library that replaced it.** While the two libraries overlapped they were kept on
**different elements**, and what actually refused both on one element was not either registry but
`PointerSensor.handlePointerDown`, which binds a capture-phase `dragstart` listener that
`preventDefault()`s the native drag whenever the press landed on something that is not itself a
native draggable — nearly every press in this app, because a card's name is a button and a tile's
art is a button.

**What is *not* true of dnd-kit is that a second registration on one element replaces the first.**
That was pragmatic-dnd's rule: it kept one `draggable()` per element in a `WeakMap`, and a second
silently took the first's place. **dnd-kit keys its registry by entity id**, so two `Droppable`s
on one element both register and both compete, and what separates them is `accepts()` —
`computeCollisions` skips a droppable that refuses the source before it measures anything. Two
folder cards and every deck pile in the app depend on that, and `TableView`'s rows depend on the
draggable half of it: one row element carries a `Draggable` *and* a `Droppable` and both stand.
Where two accepting targets do overlap, `collisionPriority` is what decides them; without one they
are separated by distance, which is why an element with no measured rectangle in jsdom wins a drop
the pointer never went near.

The question the spike existed to answer: **`@dnd-kit/react` is provider-and-hooks shaped, and
`lib/folderDrag.ts` is imperative** (`folderDraggable({ element, folder })` registers on a DOM
element and returns a cleanup; `useFolderDropTarget({ ref, … })` takes a ref). Whether dnd-kit can
be driven that way decides whether the folder drag's call sites change at all — fifteen of them,
counted the same day.

**The headline: it can. `folderDrag.ts` keeps the exported shape it has today, and only its
internals change.** Every answer below is what makes that true.

### 1. Does `DragDropProvider` have to wrap the tree?

**No, and the way it does not is a trap.** `@dnd-kit/react`'s context is created with a
module-level `var defaultManager = new DragDropManager()` as its **default value**, so a
`useDraggable` rendered with no provider anywhere above it does not throw and does not hand back a
null manager — it silently joins a process-wide singleton shared with every other unparented
draggable in the window. A missing provider is therefore not a loud failure but a shared-state
one.

More usefully: the provider is **not the only way to get a manager**. `@dnd-kit/dom` exports the
`DragDropManager` class itself, and a manager constructed by hand is a complete drag system —
sensors, plugins, collision detection and all. `new DragDropManager()` resolves the default preset
(`ScrollListener`, `Scroller`, `StyleInjector`, `Accessibility`, `AutoScroller`, `Cursor`,
`Feedback`, `PreventSelection`, with `PointerSensor` and `KeyboardSensor`), so the imperative path
is not a reduced one.

### 2. Are the hooks the only entry point?

**No. `@dnd-kit/dom` is a non-hook registration API, and it is the whole of what the migration
needs.** `new Draggable({ id, element, data }, manager)` and
`new Droppable({ id, element, data }, manager)` register a plain DOM element with a manager, and
`entity.destroy()` unregisters it — which is exactly `folderDraggable`'s
`(args) => () => void` contract and exactly `useFolderDropTarget`'s effect-cleanup contract. The
hooks in `@dnd-kit/react` are a thin wrapper over these same classes; `useDraggable().draggable`
hands back the very instance.

Two mechanics that are not obvious and cost a probe each:

- **Registration is queued on a microtask, not done in the constructor.** `Entity`'s constructor
  ends with `if (manager && register) queueMicrotask(this.register)`, so a registry read on the
  line after `new Draggable(…)` reports **zero** entities. That reads exactly like "imperative
  registration does not work", and is not.
- **`data` is a settable accessor, not constructor-only.** Assigning `entity.data = {…}` after
  construction is supported, and the new record is what a drop handler receives — which is how
  `folderDrag.ts`'s "read the folder at drag start, not at registration" survives the move. It is
  the guarantee `composedDraggable`'s `data: () => …` callback gives today, reached a different
  way.

**dnd-kit also ships its own version of the capture-phase `mousedown` guard.** `PointerSensor`'s
default `preventActivation` refuses to start a drag when the press lands on an
`input, select, textarea, button, a[href]` or `[contenteditable]` that is not the draggable's own
element or handle — `getInteractiveElement` is a single `closest()` over that selector list. That
is the same failure `features/decks/dnd.ts`'s guard was written for: the `⋯` menu on a folder
card, the rename field in a tree row, answered by the library rather than by us. It is a
*default*, overridable per source, so it is a thing to verify rather than a thing to assume.

### 3. Can the `ref` a hook returns be handed to an element the component does not own?

**Yes.** `useDraggable` returns
`{ draggable, isDragging, isDropping, isDragSource, handleRef, ref }`, and `ref` is a plain
`(element: Element | null) => void` callback — calling it with a pre-existing, unrelated element
puts the draggable on that element (`api.draggable.element === thatElement`, measured).
`useDraggable`'s **input** also takes `element` directly, as a value or a ref. So even the hook
path never requires the component to own the element. This is what makes the question academic:
the imperative path in §2 is better, but the hook path would not have forced the call sites to
change either.

### 4. What does a drop handler receive — ids, or arbitrary data?

**Arbitrary data, on both ends, and it survives the round trip.** A `dragend` event is
`{ nativeEvent, operation, canceled, suspend }`, and `operation` is
`{ source, target, activatorEvent, transform, shape, position, status, canceled }`. `source` and
`target` are the `Draggable` and `Droppable` **entities**, so `operation.source.data` and
`operation.target.data` are the records registered — or later assigned — at each end. Measured: a
source registered with `{folderId: 7, …}` and reassigned to `{folderId: 9, name: "Renamed"}`
before the gesture arrived at the handler as `{folderId: 9, name: "Renamed"}`, alongside the
target's own record.

**So `folderDragData` and `readFolderDrag` survive unchanged.** They are a mark under a key and a
field-by-field read of an untyped record, and dnd-kit's `data` is the same untyped record
pragmatic-dnd's store was. `canceled` is a first-class field on the same event, which is what
`armed` needs in order to stand down on Escape as well as on drop.

### What jsdom cannot do on its own, and the six things that fix it

Worth as much as the four answers above, because the test harness rests on it. `src/test-drag.ts`
opens by explaining that a native HTML5 drag is testable *because* pragmatic-dnd hit-tests with
`event.target` and `Element.closest`. **dnd-kit hit-tests by coordinate against measured
rectangles**, and jsdom measures every rectangle as zero — so a pointer drag driven in the suite
fails in five distinct places, each of which reads like the library being broken. In the order
they are hit:

1. **`IntersectionObserver` is not defined.** dnd-kit's `PositionObserver` constructs one per
   tracked element. It is thrown outside every test's stack, so it fails the run without failing
   an assertion.
2. **`document.elementFromPoint` is missing.** `test-setup.ts` already shims the *plural*
   `elementsFromPoint` for pragmatic-dnd's auto-scroller; dnd-kit's `Scroller` asks the singular.
3. **`document.getAnimations` and `Element.prototype.animate` are missing.** `DOMRectangle`
   force-finishes running animations before it measures, and the `Feedback` plugin animates the
   drag preview.
4. **`window.matchMedia` is missing.** `Feedback` asks it about `prefers-reduced-motion`.
5. **Every ancestor clamps the visible rectangle, and in jsdom that clamp is to nothing.**
   `getVisibleBoundingRectangle` walks up from the element intersecting with any ancestor whose
   `isOverflowVisible` is false — and that predicate is
   `overflow === "visible" && overflowX === "visible" && overflowY === "visible"`, while jsdom's
   computed `overflow` on `<body>` is the **empty string**. So `<body>` counts as a clipping
   ancestor, its `getBoundingClientRect()` is `0×0`, and the visible rect of a target stubbed at
   `y 200–240` comes back `{top: 200, right: 0, bottom: 0, width: 0, height: 0}`. A zero-area
   element is invisible, an invisible droppable never gets a `shape`, and a droppable with no
   shape can never be collided with. **This is the one that reads as "the drop target simply does
   not work"**: registration is correct, `accepts()` answers true, the element is right, and the
   target is `null` on every frame.

   **What shipped is not what this paragraph said until 2026-08-28.** It described the fix as
   giving `document.body` a viewport-sized `getBoundingClientRect`, "and every ancestor between
   the target and the body needs one too" — the spike's finding, written down and never
   reconciled with the code. `src/test-setup.ts` gives `<body>` no rect at all: it wraps
   `window.getComputedStyle` and answers `visible` for `overflow`, `overflowX` and `overflowY`
   wherever jsdom answers the empty string, so **no** ancestor counts as clipping and no ancestor
   needs a rectangle. That is a better fix and a different one — it is one shim rather than one
   per scrolling box, and a test that adds a scroller between a target and the body inherits it
   for free.
6. **Collisions are recomputed by a reactive effect the `Feedback` plugin drives, and jsdom
   cannot drive it.** With the five shims above in place a full gesture runs —
   `beforedragstart`, `dragstart`, `dragmove` per move, `dragend` with `canceled: false` — the
   droppable has a correct shape, and
   `droppable.shape.containsPoint(operation.position.current)` is **true** at the release point,
   while `operation.target` stays `null` and `collision` fires exactly twice, at the start and at
   the end. One call to `manager.collisionObserver.forceUpdate()` before the release resolves it
   immediately: the target is found and the `dragend` handler receives both records. A jsdom
   pointer-drag helper must therefore force that update; the alternative is a green test that
   proves the gesture and not the drop.

Two smaller measurements from the same pass, both of which change how a helper has to be written:

- **`dragOperation.position.current` lags one `pointermove` behind.** The sensor batches through
  its own scheduler, so a drag that stops the instant it arrives has never been over the target as
  far as dnd-kit is concerned. A helper ends with a repeated move at the destination and a frame
  before `pointerup`.
- **The default activation constraints are `Delay(200ms, 10px tolerance)` *or* `Distance(5px)`**
  for a mouse press that is not on a declared handle, and no constraint at all for a press
  *inside* a handle. Synthetic `pointermove`s cross the 5px distance with no waiting, which is why
  the gesture activates in a test that runs no timers. **The handle case is a behaviour change
  nobody asked for and the app puts it back**: a plain click on a category's grip would otherwise
  be a zero-pixel reorder, so `useCategoryDragSource` declares its own `Distance(5)` — see 3b.

Four more, measured on 2026-08-28 while every remaining drag moved across, and each of which a
helper or a call site has to know:

- **A `Droppable`'s shape is measured once, by a `PositionObserver` jsdom never calls again.** The
  observer is created the moment a drag starts *and* that element accepts the payload, and it
  measures on construction. For a target boxed before the gesture that one measurement is right;
  for one drawn **during** it — the quick-zone bar, the remove tray, both of which appear on
  `dragstart` — the only measurement ever taken is of a rectangle that is still four zeroes.
  `src/test-drag.ts` calls `refreshShape()` on every registered droppable before each forced
  collision pass for exactly this.
- **The operation's *target* follows the collisions one hop behind.** The observer's reaction
  disables the observer, calls `setDropTarget`, and re-enables it when that promise resolves — so
  the pass that changes which droppable sorts first is not the pass that moves the target onto it.
  Measured on a quick zone overlapping a pile: after one forced pass the collisions read
  `[zone, pile]` while `operation.target` was still the pile. The harness forces two.
- **A droppable with no rectangle is not inert — it is a degenerate box at the origin.** An
  unboxed element's centre is `(0, 0)` and its zero-area rect still contains that point, so a
  helper whose pointer has not been moved "lands" on it by accident. Two unboxed targets both
  contain the pointer and document order picks the winner. Measured twice on 2026-08-28, in the
  sidebar's two entries and in the wishlist's folder cards: stripping every box out left whole
  files green while a drop aimed at one entry wrote to the other. **An unboxed target does not
  fail, it stops discriminating.**
- **`PointerHeld.started` is a live reading of the manager's operation, not a remembered
  boolean.** Asserted after a `cancel()` or a `drop()` it is false for every drag there has ever
  been, which reads as a gesture that never started.

### What a drag is to a keyboard and a screen reader, measured

Measured 2026-08-28 in jsdom, against the real components, by reading
`dndManager.registry.draggables` back off each rendered surface. `src/lib/dndAccessibility.test.tsx`
is the measurement as assertions; this is the same reading in prose. **Nothing in this subsection
is a decision** — it is what is true, so that whatever is decided next is decided against
something.

**The instrument.** `draggable.handle ?? draggable.element` is the exact expression
`Accessibility.registerEffect` uses to pick the element it would stamp and `KeyboardSensor.bind`
uses to pick the element it would listen on. Reading the registry answers the question those two
ask; a `grep` for registration helpers answers a different one, and would have missed two of the
rows below.

#### Every draggable in the app, and what a caret can reach

| Surface | Activator | `role` | `tabindex` | Tab reaches it? |
| --- | --- | --- | --- | --- |
| Collection folder wall (`CollectionFolderCard`) | `<li>` | none | none | **no** |
| Wishlist folder wall (`WishFolderCard`) | `<li>` | none | none | **no** |
| Deck sidebar folder tree (`FolderTree`) | `<div>` | none | none | **no** |
| Deck editor, Stack / Grid / Text views (a card) | `<li>` | none | `-1` | **no** |
| Deck editor, a pile's heading (`useCategoryDragSource`) | **handle** = the grip `<button>` | none | none | **yes** |
| **Deck editor, Table view (a card)** | `<div>` | `row` | **`0`** | **yes** |
| **Collection table (a row)** | `<div>` | `row` | **`0`** | **yes** |
| Wishlist table (a row) | `<div>` | `row` | none | **no** |
| Decks wall (a deck tile, `DeckTile`) | `<li>` | none | none | **no** |
| Any card wall (`CardGrid`: search, collection, wishlist, tags, the deck panel) | `<div>` | none | `-1` | **no** |

**The two bolded rows are the correction; four of the others were not on the plan's list at all.**
The 3c plan tabulated four surfaces and concluded that the category grip is the only tab-reachable
draggable in the app. It is not, and the ones it missed are the most numerous:
`VirtualTable` gives its rows `tabIndex: onActivate ? 0 : undefined` so that
Enter and Space open the card, and both the deck editor's table view and the collection table
register a drag on **that same row element** — one `<div>` carrying `role="row"`, `tabindex="0"`,
a `Draggable` and a `Droppable` at once. The wishlist's table is the control that proves the
mechanism: it deliberately passes no `onActivate`, so its rows have no tab stop and no keyboard
drag could ever reach them either.

**A deck card's `tabIndex={-1}` arrives with its *menu*, not with its drag.** `deckCardMenuProps`
is what writes it, so a view mounted without `actions.menu` — a story, a read-only mount — has cards
carrying no `tabindex` at all. Both are out of the tab order; only one of them is the shipped
editor.

#### What a keyboard can actually do

**Nothing, on every surface.** There is no `KeyboardSensor` in the manager since 3b, so Space and
Enter start no drag anywhere — measured on the grip and on a deck table row, which are the only two
activators a caret can be put on at all. Both keep their own behaviour: the grip's
`ArrowLeft`/`ArrowRight` write a real reorder (`ArrowUp`/`ArrowDown` in `CategoriesDialog`), and a
table row's Enter and Space open the card.

**The sentence 3a wrote — "`KeyboardSensor` is a *sensor* and stays: dragging a folder from the
keyboard is unaffected" — was never true of this app's markup**, and that is now measured rather than
argued. That sensor binds its `keydown` to `source.handle ?? source.element` and its default
`preventActivation` is `event.target !== (source.handle ?? source.element)`, so a keyboard drag
needs the draggable element **itself** to be focused. Most of the surfaces in the table above could
never be focused at all, and the folder tree — the surface that sentence was about — is one of them. The comment in `dndManager.ts` is already correct for a different reason (3b
removed the sensor because it took Enter away from every card); this is the reason it names and the
one the plan expected.

**Two things that would change that answer, and both are latent today.**

- **A per-source `sensors` list replaces the manager's rather than extending it**
  (`Draggable`'s effect reads `this.sensors ?? [...manager.sensors]`). Measured by mutation on
  2026-08-28: putting `KeyboardSensor` back into `dndManager`'s `sensors` array changes **nothing**
  on the grip, because `useCategoryDragSource` passes a list of its own — and starts a real drag on
  a **deck table row**, which passes none and therefore inherits the window's. So the surface most
  people would test is fenced by accident and the surface nobody would test is the one that moves.
- **`composedDraggable` already names `KeyboardSensor` in a branch nothing reaches.**
  `features/decks/dnd.ts` builds a per-source `sensors: [PointerSensor…, KeyboardSensor]` whenever
  a caller narrows `notFrom`, and **no caller anywhere passes `notFrom`** — its own comment says
  "nothing today". The first surface that narrows its press guard would acquire a keyboard drag it
  did not ask for, on whatever element it registered.

#### A per-source `sensors` list did not merely replace the manager's — it erased it (issue #331)

**The first bullet above was true and stopped one step short of the defect it was describing**, and
that step took every drag in the app with it. Reported 2026-09-01 as "drag-and-drop is broken when
dragging on a deck image", then as "images in general, not just deck images"; driven the same day
in a `tauri dev` window at 1920×1080.

`Draggable`'s registration effect resolves a source's sensors as
`this.sensors?.map(descriptor) ?? [...manager.sensors]`, and **the two halves are not
symmetrical**. The manager's list arrives as *instances*, so the effect calls
`bind(source, undefined)` and `bind(source, options = this.options)`'s default parameter hands the
source whatever that instance was configured with. A per-source list arrives as *descriptors*, and
for one of those the effect calls `manager.registry.register(entry.plugin)` — **the constructor
alone, the entry's own options dropped**. `PluginRegistry.register` then reads an omitted `options`
as an instruction to write them:

```js
const existingInstance = this.instances.get(plugin);
if (existingInstance) {
  if (existingInstance.options !== options) existingInstance.options = options;   // ← undefined
  return existingInstance;
}
```

So the first source in the window to declare a `sensors` list sets the manager's one
`PointerSensor` instance's `options` to `undefined` and nothing ever writes them back. Every source
that registers **afterwards** binds with `options = this.options` — now nothing — and falls back to
`PointerSensor.defaults.preventActivation`, which is the rule `dndManager.ts` exists to replace:

```js
const interactiveElement = getInteractiveElement(target);   // input, select, textarea, button, a[href], [contenteditable]
if (interactiveElement === source.element) return false;
return Boolean(interactiveElement);
```

**In this app a card's art is a `<button>` and the drag source is the tile around it**, so
`interactiveElement !== source.element` and the press was refused. What the reader saw is a tile
that could still be dragged by its caption and its padding and **not by its picture** — on the
search wall, the collection, the wishlist and the deck gallery at once, until a reload.

**The trigger is the category grip and nothing else.** `useCategoryDragSource` is the one source
here that has to carry a list of its own (a declared handle switches dnd-kit's activation
constraints off, so the 5px distance is put back by hand), so **opening a deck editor once** was
the whole reproduction. Measured with `registry.sensors.register` wrapped in the running window:
zero calls on the Search page, zero on the deck gallery, and **nine on opening a deck**, every one
of them with `options === undefined`. The sensor's `options` read `["preventActivation"]` before
and `undefined` after.

**Four things about the failure are worth keeping, because each one is why it shipped.**

- **Nothing throws and nothing logs.** A `window.onerror`/`unhandledrejection`/`console.error`
  capture over the whole gesture came back empty. `handlePointerDown` returns early and the press
  is simply not a drag.
- **The manager looks healthy from every angle a reader would check.**
  `dragOperation.status.idle` is `true`, the registry holds the right 24 draggables and 6
  droppables, the one sensor's `disabled` is `false`, and `handlePointerDown` is reached with
  every guard passing (`isPrimary`, `button === 0`, not captured, source not disabled). The tell is
  two hops in: `handlePointerMove` is **never called**, because `preventActivation` returns before
  the sensor binds its document listeners — 15 `pointermove` events reach `document` in both
  phases and the sensor sees none of them.
- **The deck editor's own card drags went on working**, which is what made it look like an image
  bug rather than a global one: a deck card's draggable element **is** the button, so
  `interactiveElement === source.element` and the library's default excuses it. Only the surfaces
  whose source is a wrapper *around* a button broke.
- **jsdom reproduces it exactly**, once the two sources are registered in the shipped order — which
  is what `dndManager.test.ts`'s "keeps its own press rule when a source registers sensors of its
  own" does. Nothing in the suite could see it before, because no test registered a
  handle-bearing source and a tile-shaped one against the same singleton manager.

**The fix is a fence at `dndManager.registry.sensors.register`**: an omitted `options` keeps what
the instance has instead of clearing it, which is what the library's own doc comment on that method
already says it does ("its options will be updated"). A caller that passes options still replaces
them, and the per-source list goes on binding with its own, because the effect passes those to
`bind` directly and never through the registry. It is patched there rather than at the call site
because the call site is using the documented API correctly — and a rule saying "never declare
sensors" would be a landmine with no fence.

#### What a screen reader is told: nothing

There is no live region, no instructions element and no `aria-*` on a drag source at rest. The app
says nothing when a drag begins, nothing about what it is over, and nothing about where it landed.
`@atlaskit/pragmatic-drag-and-drop` shipped no announcements either, so this is a ceiling rather
than a regression — but it is worth stating as a ceiling rather than leaving as an absence.

**What the `Accessibility` plugin would supply, and what it would cost, measured by putting it
back.** With the plugin unfiltered and one animation frame allowed to pass, a collection folder
card comes back as

```html
<li role="button" tabindex="0" aria-roledescription="draggable"
    aria-describedby="dnd-kit-description-0" aria-grabbed="false" aria-pressed="false"
    aria-disabled="false" class="relative rounded-xl">
```

`getAllByRole("listitem")` then finds **nothing** on the wall — `role="button"` takes the `listitem`
role away, which is how a screen reader says how many drawers there are — and the tree row's `<div>`
comes back `role="button" tabindex="0"` for the same reason. Appended to `<body>`:
`<div role="status" aria-live="polite" id="dnd-kit-announcement-0">` and a hidden
`dnd-kit-description-0`. That reproduces 3a's live reading of 2026-08-27 exactly, on markup rather
than from the plugin's source.

**The app could pre-empt two of those attributes and no more.** The plugin skips an element that
already carries a `tabindex` or a `role`, so stamping our own would head off exactly those two;
`aria-roledescription`, `aria-describedby`, `aria-grabbed` (deprecated since ARIA 1.1),
`aria-pressed` and `aria-disabled` have no opt-out of any kind. Its `announcements` option, by contrast, is fully
overridable — and its defaults say `Picked up draggable item ${source.id}`, where `source.id` here
is `dndId()`'s counter (`folder-source-3`), which `dndManager.ts` calls "a registry key and nothing
else". **So the half worth having is the half that would have to be written anyway, and the half
that comes for free is the half that cannot be turned off.**

#### The same four questions in the shipped window

Driven 2026-08-28 in a **`tauri dev` debug build**, over `scripts/cdp.mjs`, against a copy of the
real database. The window was left at whatever size it opened at and **the viewport was not
recorded**, which matters for none of the readings below — every one of them is an attribute, a
registry entry or a focus target rather than a measurement in pixels.

**The plugin list and the sensor list, read off the live manager.** `import('/src/lib/dndManager.ts')`
resolves under Vite's dev server, so the manager can be asked directly rather than deduced from the
DOM: `dndManager.sensors` is **`[PointerSensor]`** and nothing else, and `dndManager.plugins` is the
eight `CollisionNotifier, ScrollListener, Scroller, StyleInjector, AutoScroller, Cursor, Feedback,
PreventSelection` — **`Accessibility` is absent**. That is 3a's filter taking effect in a running
tree rather than in an array literal.

**Nothing in the document says anything about a drag, at rest or during one.** Zero
`[id^=dnd-kit-]` elements, zero `[aria-live]` elements, zero `aria-roledescription`, zero
`aria-grabbed`. Five `role="status"` regions were in the document; only the ribbon's carried text
(`117,606 cards · data from 2026-08-28`) and none of them is written to by a drag.

> ⚠️ **"Zero `[aria-live]`" is a fact about the document that was measured, not about the app, and
> the difference matters — corrected 2026-08-29.** It was a `querySelectorAll` on one page of a
> running window, so it counted what was **mounted**. The source has **four** `aria-live="polite"`
> elements — `DeckHistoryDialog.tsx:284`, `TheoryDiffDialog.tsx:620`,
> `transfer/import/shared/CommitBar.tsx:88`, `web/BuildCorpus.tsx:62` — each inside a dialog or a
> page that was not open, and **93** `role="status"`/`role="alert"` sites against the five that
> were on screen.
>
> **None of the four is about a drag, so the finding this section rests on is unchanged.** What
> changes is the cost of doing something about it: the app already has a live-region vocabulary to
> reuse rather than one to invent. A reading like this one answers "what does a screen reader meet
> on this page"; it cannot answer "what does this app contain", and the two were being conflated by
> one sentence.

**During a real in-flight drag**, a deck card's source `<li>` reads
`tabindex="-1" data-deck-card-body data-dnd-source data-dnd-dragging popover` — no `role`, no
`aria-*` of any kind; the only additions are the library's own `data-dnd-dragging` and the
`popover` attribute `Feedback` uses for the preview. A deck **folder tree row** mid-drag is a
`<div>` carrying only `data-dnd-dragging` and `popover`, and its `<li>` ancestor is untouched.
Compare 3a's plugin-on reading of the same kind of element:
`role="button" tabindex="0" aria-roledescription="draggable" aria-grabbed="false"`.

**A collection table row is a tab stop and a drag source at once, confirmed on the shipped table.**
26 of 27 `[role=row]` elements carried `tabindex="0"` **and** `data-dnd-source` (the 27th is the
header). Reaching one the way a reader does — click a row, press Escape to close the card pane it
opens, and the pane hands the caret back to the row — leaves the caret on
`<div role="row" tabindex="0" data-dnd-source>`. **Space there opens the card and starts no drag**:
`data-dragging` absent, no `[data-dnd-dragging]`, the pane open.

**The category grip, driven the way a reader drives it.** Nine grips in the deck, each a
`<button aria-label="Move <name>, n of 9">` with no `tabindex` — real stops in the tab order. A
click puts the caret on one; `ArrowRight` moves the pile from *1 of 9* to *2 of 9*, rewrites every
sibling's label, keeps the caret on the grip and starts no drag; **`Space` does nothing at all** —
no drag, no move, caret unchanged.

##### Two traps this pass cost, both worth writing down

**`cdp.mjs pull` did not start a dnd-kit drag in this window, and a page-dispatched `PointerEvent`
did.** `Input.dispatchMouseEvent` delivered a well-formed `pointerdown` to the source element
(`isPrimary: true, button: 0, buttons: 1, pointerType: "mouse"`, not `defaultPrevented`, not inside
`NOT_A_DRAG`) and eleven `pointermove`s to `document` — and `dndManager.monitor`'s `dragstart` never
fired, on a folder row *and* on a deck tile, with the operation idle and the source in the registry.
`event.sensor` was still `undefined` in a bubble listener on the source element, so
`PointerSensor.handlePointerDown` either never ran or returned before its first assignment. Building
the same gesture out of `new PointerEvent(...)` inside the page starts the drag immediately
(`data-dragging` on `<html>`, one `[data-dnd-dragging]`). **The cause was not identified.** Note
that the successful `cdp.mjs pull` drag recorded above was taken against a
`tauri build --debug --no-bundle` binary, not `tauri dev`, so the difference may be the build rather
than the harness. Until somebody settles it: **a `pull` that produces no drag is not evidence the
drag is broken.**

**A `data-probe` attribute does not survive a re-render.** React replaces the folder tree's nodes
on a query settle, so a probe tagged in one `cdp.mjs` invocation can be gone by the next and the
selector then reads as "the element does not exist". Re-tag inside the same invocation that uses it.

#### The trap in measuring any of this

**The plugin's DOM mutations land one animation frame after the render**, not during it:
`registerEffect` collects them into a set and hands them to `@dnd-kit/dom/utilities`'s `scheduler`,
whose backing call is `requestAnimationFrame`. Read synchronously, **every absence asserted about
the plugin is vacuous** — measured 2026-08-28, when putting the plugin back left **every**
assertion in `dndAccessibility.test.tsx` green. Awaiting a frame is what turns that same mutation
red on five of them, and it is the only thing that makes the file worth anything.

**Not measured, and it would take a screen reader to measure it.** Everything above is the DOM.
**What a real screen reader actually says during a drag has not been checked** — not with Narrator,
not with NVDA, in `tauri dev` or in a packaged build — and no test and no CDP pass can substitute
for it: jsdom asserts the attributes, a browser asserts the elements exist, and only a screen
reader asserts that something is spoken. The DOM readings make "nothing is announced" the expected
answer, since there is no live region for anything to be announced *through*, but what a reader
hears while dragging — the source's own name repeated, the pointer's target read out by the
virtual cursor, silence — is a different question and an unmeasured one. Doing it needs Narrator
(`Ctrl+Win+Enter`, and it is already on the machine) against a `tauri build --debug --no-bundle`
binary, and the answer written down verbatim including anything spoken twice.

### The decision: adopt dnd-kit's `Accessibility` plugin

**Taken by Markus on 2026-08-29**, against the measurements above and against two alternatives —
"stay pointer-only and stop implying otherwise", and an app-owned keyboard flow scoped to the two
surfaces that already have a caret. **No direction was recommended**: the evidence did not favour
one, and which reader the app is for is not a question a measurement answers.

**What it settles.** 3c's Tasks 4–6 are unblocked and get planned against this. The plugin brings
its own instructions element, its own live region and its own keyboard drag, maintained upstream
rather than hand-rolled — which is the whole of the case for it, given that the app's drop half is
**pointer-only on every surface** and an app-owned flow would have had to invent a
target-picking UI that does not exist.

**What it costs, and none of this is a surprise — it is why 3a removed the plugin in the first
place.** The plan that adopts it has to answer each of these at its own site:

- **It stamps `role="button"` on the element it picks** — `draggable.handle ?? draggable.element`,
  the same expression `dndAccessibility.test.tsx` reads the registry with. That takes the
  `listitem` role off every folder card and every card-wall row, so **`getAllByRole("listitem")`
  stops working on every wall in the app**. Two measurements in `dndAccessibility.test.tsx` pin
  exactly that role today — `keeps every folder card a listitem, on both walls` and the wishlist
  twin. **Those two are the specification changing, not tests to delete quietly:** they were
  written as measurements, and the file's own header says a failure there is *news*.
- **It adds a tab stop per row.** On a virtualised card wall that is a caret walk through the
  whole result set, and it is the second reason 3a filtered the plugin out.
- **`KeyboardSensor` answers Enter and Space with `preventDefault()` *and*
  `stopImmediatePropagation()`.** From the moment every card became a drag source, that was Enter
  no longer opening a card — the reason 3b removed the sensor, fenced by `dndManager.test.ts`.
  Adopting the plugin without re-adding that sensor is coherent; re-adding both is not, unless the
  activation key changes.

**Three traps for whoever writes it, each already paid for once.**

1. **`Accessibility.registerEffect` defers through `requestAnimationFrame`.** A synchronous
   assertion that dnd-kit added nothing **passes whether the plugin is installed or not** — await a
   frame, or the whole file is vacuous. `dndAccessibility.test.tsx` already does this and says why.
2. **A per-source `sensors` list *replaces* the manager's rather than merging** —
   `this.sensors ?? [...manager.sensors]`, `??` and not a merge. `useCategoryDragSource` passes its
   own, so **the category grip is fenced by accident** and says nothing about what the manager is
   configured with. Assert on a table row, which inherits.
3. **A latent one, still true and still unfired**: `src/features/decks/dnd.ts`'s
   `composedDraggable` builds a per-source sensor list *including* `KeyboardSensor` whenever a
   caller narrows `notFrom` — and **no caller does** (confirmed 2026-08-29: every `notFrom`
   occurrence in the tree is inside `dnd.ts` itself). The first surface that narrows its press
   guard silently acquires a keyboard drag. Adopting the plugin is the moment to make that
   deliberate rather than incidental.

**The audit this does not remove.** The plugin answers the *drag*. It does not answer the app's
other pointer-only affordances, which the phone census enumerated: `menuClick` — a plain-click door
to a context menu — exists at exactly **two** surfaces in the whole app (the collection's and the
wishlist's folder cards), and the ctrl+wheel card zoom has exactly one caller and no other door.
Those stay open and belong to the mobile work rather than to this decision.

### The shipped CSP blocks a plugin dnd-kit cannot be told not to load — and the rules moved into `index.css`

Found 2026-08-27, reading the library rather than the app. **`@dnd-kit/dom` positions its drag
preview from a runtime-injected `<style>` element, and this app's shipped `style-src 'self'`
blocks exactly that** — the failure mode `motion.md` already documents for
`AnimatePresence mode="popLayout"` and `animateView()`, arriving from a second direction.

The mechanism, precisely. `StyleInjector` is in the manager's plugin list, and it is a
**`CorePlugin`** — `DragDropManager`'s constructor prepends `[ScrollListener, Scroller,
StyleInjector, …]` ahead of whatever a caller passes, and `PluginRegistry`'s setter explicitly
`continue`s past anything whose prototype is a `CorePlugin` rather than unregistering it. So it
cannot be removed through the `plugins` customizable. Its `injectStyleElement` does
`root.createElement("style")`, sets `textContent`, and prepends the element to `<head>` — an
inline stylesheet, which `style-src 'self'` refuses and which `style-src-attr 'unsafe-inline'`
does **not** cover, because that directive governs `style=` attributes and nothing else.

Three plugins register rules through it, and they are not equally cosmetic:

- **`Feedback`** — the drag preview. Its rules are what give the overlay
  `position: fixed`, `pointer-events: none`, `z-index: calc(infinity)` and, critically, its
  `top`/`left`/`width` read from `--dnd-*` custom properties — **`--dnd-`, not `--dnd-kit-`**,
  which this paragraph said until the rules were read off a running drag. The plugin sets those
  custom properties inline (allowed by `style-src-attr`); the **rules that read them** are what is
  blocked. Without the rules the preview is a clone left at the window's top-left corner rather
  than under the pointer. **It is a visual defect and not a broken drop**, which this paragraph
  also had wrong: driven in a built debug app on 2026-08-27 the folder still landed where it was
  dropped and the move survived a reload, with every injected sheet reporting a null
  `styleSheet`.
- **`Cursor`** — `* { cursor: grabbing !important; }`. Cosmetic.
- **`PreventSelection`** — `* { user-select: none !important; }`. A drag that selects text as it
  travels.

**Every environment this repo can test in is on the permissive side of the difference.**
`tauri.conf.json`'s `devCsp` is `style-src 'self' 'unsafe-inline'`, Storybook and Vite serve no
CSP at all, and jsdom enforces none — so `tauri dev`, the workbench and the whole suite are green
on this, and only the packaged exe breaks. **A live CDP pass under `tauri dev` cannot see it
either**, which is worth stating plainly because that is the pass this app reaches for when a
suite cannot answer: the only witness is a `tauri build` portable copy.

`StyleInjector` takes a `nonce` option, which is the documented escape and needs a CSP nonce this
app does not have — Tauri's `csp` is a static string in `tauri.conf.json`, and a nonce has to be
per-response. That left three ways out: widen the shipped `style-src` (a real regression, and the
reason the two CSPs differ at all), thread a nonce (a Tauri-side change), or copy the rules into a
stylesheet the policy already trusts.

**The third is what shipped, and it costs the CSP nothing.** The rules are static CSS; served from
the app's own bundle they are `'self'`, which `style-src` already allows. The library goes on
publishing `--dnd-top`, `--dnd-left`, `--dnd-translate` and the rest as inline style *attributes*,
which `style-src-attr 'unsafe-inline'` permits and which were never the blocked half — so the
values still arrive and now something reads them. `StyleInjector` is left to go on injecting
sheets nobody parses. Nothing about the manager, the plugin list or the policy changed.

Three things about the copy are worth knowing before touching it.

- **The cascade layer has to be *named* before Tailwind's.** `CSS_RULES` puts its popover resets
  in `@layer dnd-kit`, and the library gets away with it because its sheet is **prepended** to
  `<head>`, so that layer sorts first and therefore loses to everything. A layer takes its
  priority from where it is first named, and the block itself sits at the foot of `index.css` —
  after the `@import` that names `theme`, `base`, `components` and `utilities`. Built both ways
  against tailwindcss 4.3.x on 2026-08-28: with a bare `@layer dnd-kit;` statement above the
  import, `dist/assets/index-*.css` orders the layers `properties, dnd-kit, theme, base,
  components, utilities`; without it, `dnd-kit` lands **last**, the highest priority in the sheet,
  and its `background: unset` / `border: unset` then beat the utility classes the dragged clone is
  drawn with. That is the preview broken a second way by the fix for the first.
- **Two rules are fenced and the rest are verbatim.** `Cursor` and `PreventSelection` register
  bare `*` rules, which is only safe because the library adds and removes them around one
  gesture. Copied as-is into a stylesheet that is always loaded they would put a closed hand and
  an unselectable page over the whole app forever, so both hang off `html[data-dragging]`, a mark
  `lib/dndManager.ts` sets between the library's own `dragstart` and `dragend`. Their
  declarations are untouched. The mark comes off when the reader lets go rather than when the
  drop animation ends, because the status signal the library itself reads lives in
  `@dnd-kit/state`, a transitive dependency this app does not declare.
- **That fence was `:root:has([data-dnd-dragging])` for one commit, and it broke a story play in
  a feature that does not drag.** It is correct CSS and free in a browser, which is what made it
  the obvious first spelling. jsdom resolves style by matching every loaded rule against every
  element, and a rule whose **subject** is broad and whose ancestor part holds `:has()` turns
  each of those matches into a scan of the whole document — O(n²) over the page. Measured
  2026-08-28 over a 400-element tree with a DOM mutation between reads, which is what a
  `userEvent` gesture produces: **4.1s with the attribute ancestor, 18.6s with the `:has()`**.
  What it surfaced as was `DeckEditor.stories.tsx > SwapFolds` going from **3.5s to 15.0–16.0s**
  against the 15s `testTimeout`, and the whole `vitest` run going from **181s to 231s**. **It is
  the broad subject that is expensive, not the pseudo-class**: an unrelated `.thing:has(.other)`
  measured 436ms against a 447ms baseline, because its subject fails before the `:has()` is
  evaluated. `dndManager.test.ts` refuses that one selector shape in `index.css`, with the
  predicate self-tested against both spellings so it cannot quietly stop detecting anything.
- **The near-miss is the part worth remembering.** The regression shipped through a green
  `npm run verify` — the story plays ran, and SwapFolds came in at **15049ms in the full
  parallel run against a 15000ms wall**, a margin of about fifty milliseconds on a play that had
  been taking three and a half seconds. A four-fold slowdown reached the branch as a coin flip on
  one timeout, and the default reporter prints no duration for a test that passes, so nothing in
  the log said so. The check is the story plays and they already run in `verify`; what they
  cannot do is report a regression that is still, barely, under the wall.
- **`src/lib/dndManager.test.ts` is the fence, and it compares against the library rather than
  against a string.** It starts a real drag through the app's own manager in jsdom (where nothing
  is blocked), captures the `<style>` elements `StyleInjector` actually injected, parses both them
  and `index.css` into selector-to-declaration maps, and fails unless every one of the library's
  is also ours. Verified by mutation on 2026-08-28 in both directions: dropping
  `will-change: translate` from `index.css`, deleting the `@layer` block and un-fencing the `*`
  rule each turn it red, and so does editing `node_modules/@dnd-kit/dom/index.js` to add a
  declaration or a rule the copy has never seen.

**Driven in a built debug app, 2026-08-28** — `tauri build --debug --no-bundle`, the shipped
`csp`, 1280×800. The policy was confirmed live first, because everything below is void without
it: a `<style>` created at runtime came back with `sheet === null`. Then a folder card was dragged
243px with `cdp.mjs pull` over a per-frame sampler (53 frames). The dragged element computed
`position: fixed`, `top: 344px`, `left: 456px` — the `--dnd-top`/`--dnd-left` the library had
written inline — `z-index: 2147483647` (`calc(infinity)`, clamped), `pointer-events: none`, and a
`translate` walking 0 → 122px → 239.328px as the pointer travelled, with the box itself at
x = 456 → 578 → 695. `<body>` read `cursor: grabbing` and `user-select: none` throughout, and
`auto` for both at rest.

**Driven again after the fence changed**, same build recipe and same window, because the `<body>`
readings above were taken while it was still the `:has()` spelling. `data-dragging` is absent at
rest with `<body>` at `cursor: auto`; through the drag the mark is on `<html>` and the preview
reads `position: fixed`, `top: 344px`, `left: 456px`, `z-index: 2147483647`, `translate` walking
0 → 142px → 239.357px, with `<body>` at `grabbing` and `user-select: none`; and it is absent again
afterwards. The last sampled frame catches the documented difference in the act — `data-dragging`
already off and the cursor back to `auto` while `data-dnd-dragging` is still on the element for
the drop animation, which is the mark ending at `dragend` rather than at the end of the flight
home.

**The control, in the same session and the same window**: the ten copied rules were deleted out of
`document.styleSheets[0]` and the drag repeated — which is the state the shipped build was in
before this change. `position: absolute`, `top: 0px`, `left: 0px`, `z-index: auto`, `<body>` at
`cursor: auto` and `user-select: auto`, while `--dnd-top: 344px` and `--dnd-left: 456px` sat on the
element with nothing reading them. A reload restored all ten. Two traps cost time on the way:
**`cdp.mjs drag` cannot drive this** — it waits on `Input.dragIntercepted`, which only fires for a
native HTML5 drag, so `pull` (a real press/move/release, and absent from that script's own usage
string) is the one to reach for; and **`tauri dev` cannot see any of this**, because Vite's dev
server sends no CSP header at all and the HTML carries no meta, which makes `devCsp` irrelevant
there rather than merely permissive.

---

## Three floors, and only one of them is the app's

**`1024` is `src-tauri/tauri.conf.json`'s `minWidth`, so it is a promise the *desktop window*
makes and nothing else in this repo makes** (2026-08-29, read out of the config in the
`mobile-layout` worktree at `56e94c2`). Tauri hands it to the OS window manager, which refuses to
drag the frame narrower; a browser tab honours nothing of the sort and neither does an Android
webview, where the window is whatever the device is. Every measurement in this document that ends
"which the 1024px floor forbids" is still true — a horizontal page scrollbar at 1024 is still the
failure those passes were checking for — but it is true *about desktop*, and the phrasing that
makes it sound universal is the thing being corrected here.

**The three widths are now stated in one place, `src/lib/viewports.ts`**, and the reason it is a
module rather than four numbers typed into four story files is that two options compared at two
widths are not compared:

| | | Why that number |
| --- | --- | --- |
| `DESKTOP_FLOOR_PX` / `DESKTOP_FLOOR_HEIGHT_PX` | 1024 × 700 | Quoted from `tauri.conf.json`'s `minWidth`/`minHeight`. Rust owns it; TypeScript only repeats it |
| `PHONE_PX` / `PHONE_HEIGHT_PX` | 390 × 844 | A hard case rather than a device. `CardGrid.columnsFor(350, 170)` floors at **one** column at this width, which is the failure the wall's design round exists to answer |
| `TABLET_PX` | 768 | Portrait tablet — the width at which the deck editor's two columns become possible again (`roomForPanel`'s threshold is 414) |

**These are widths to look at, not breakpoints to branch on**, and the module's own doc comment
says so at the top rather than leaving it to be inferred. Where a control row folds is a question
about *that row's own box* — `FilterBar` answers it with `@container/fb` and `DeckEditor` with a
`ResizeObserver` over its desk — because the same component is drawn in a 1500px bar and in a
206px docked panel, and a viewport query answers about the wrong box. Nothing here may grow a
`sm:`/`md:`/`lg:` layout branch off these constants without saying, at its own site, why the
*window* is the thing it is asking about.

**`src/lib/viewports.test.ts` is the fence, and it is the only thing in the build that compares
the two files.** It reads `src-tauri/tauri.conf.json` through Vite's `?raw` — the same trick
`tokens.test.ts` uses on `index.css`, because this project has no `@types/node` and cannot reach
`node:fs` — parses it, and asserts the constants against `app.windows[0]`. Without it a floor
raised in Rust and not in TypeScript would leave every story in the design round drawn at a width
the app can no longer be, silently and forever. The second test only orders the three targets, and
that is not decoration either: a phone width at or above the tablet width would make the design
round's two frames one frame, and every option would be looked at once.

**Proved by mutation, 2026-08-29, three of them, each reverted:** `DESKTOP_FLOOR_PX` → 1025 went
red with `expected 1025 to be 1024` — and the *expected* side is the number that came out of the
config, which is what proves the `?raw` import reached the real file rather than an empty string;
`DESKTOP_FLOOR_HEIGHT_PX` → 701 went red the same way, because the first mutation alone leaves the
height assertion unexercised; and `PHONE_PX` → 800 went red with `expected 800 to be less than
768`. Two tests, 2 passed at rest.

**No site was cross-linked to this section, and the grep is why.** `1024px floor|app's own
floor|narrowest window this app` matches **43 lines across 22 files** — 38 lines across 20 once
this plan's own text and `viewports.ts`'s doc comment are taken out. The possessive spelling
alone, the one that actually misleads, is **13 sites**: `Dialog.tsx`, `Dialog.test.tsx`,
`Dialog.stories.tsx`, `DeckSearchPanel.test.tsx`, `StackView.stories.tsx` (×3), `CardGrid.tsx`,
`CardGrid.test.tsx`, `WishlistPage.stories.tsx`, `decks-live-findings.md`, `import-export.md`, and
one site in this file. A prose-only edit routes to neither CI job, so touching twenty files would
be twenty new chances for a document to rot with nothing going red; one paragraph that the next
reader finds by searching the same phrase is the cheaper fence. **A note for whoever re-runs that
grep:** it undercounts. `DeckSearchPanel.test.tsx:1413` wraps "the app's 1024px / floor" across a
line break and the pattern misses it, so the real figure is a floor and not a count.

**What web and Android have instead is nothing** — no enforced minimum at either target, which is
precisely why the phone frame above had to be chosen rather than read off a config. `PHONE_PX` is
a width the design round agrees to look through; it is not a width anything refuses to go below.

---

## The shell is as tall as the *visible* viewport, and the safe area is opted into

Shipped 2026-08-29 (mobile-layout 9a, Task 2), measured against a production `npm run build` —
`tsc && tsc -p .storybook && tsc -p tsconfig.sw.json && tsc -p tsconfig.relay.json && vite build`
— in the `mobile-layout` worktree. Nothing here changes a layout. It changes what the shell's
height *means* on a target this app does not yet ship to, and it makes four properties available
for the one that will.

**`h-screen` is `100vh`, and `100vh` on a mobile browser is the *large* viewport** — the height
the page would have if the URL bar were hidden. An `h-screen` shell therefore reaches past the
bottom of what the reader can see and puts its own last row under browser chrome. `h-dvh` is
`100dvh`, the visible height, and it tracks the bar as it hides and returns. On desktop and in
WebView2 there is no bar and the two are the same number, which is why this costs the shipped
window nothing — **and that clause was then measured rather than believed.** Driven in the shipped
WebView2 (`npm run tauri dev`, debug build, 2026-08-29), in **one** `eval` because a rect and a
viewport height taken minutes apart can be at two different sizes:

```
{ href: "http://localhost:1420/",
  cls: "flex h-dvh flex-col overflow-hidden bg-bg text-text",
  h: 1080, top: 0, inner: 1080, client: 1080,
  padTop: "0px", padLeft: "0px", padRight: "0px" }
```

The shell's height is `documentElement.clientHeight` exactly, which is what it was under
`h-screen`: **desktop did not move.** `href` is in the payload deliberately — `cdp.mjs` takes the
first `type: page` target and DevTools, if open, is one, so a probe can silently answer about the
wrong DOM.

**The three inset paddings resolving to `0px` is the second half of that reading**, and it is the
one that could not be got from a test: it shows `env(safe-area-inset-*)` parsing and falling back
rather than invalidating the declaration, on a desktop window where all four are zero. The block
costs the shipped app nothing, measured.

**`viewport-fit=cover` and the four `--safe-*` properties are one change, because either half
alone is worse than neither.** `env(safe-area-inset-*)` resolves to `0px` in every context until
`index.html`'s viewport meta carries `viewport-fit=cover`; without the meta the properties are
dead code — green in the suite, zero in the window, findable only on hardware with a notch. With
the meta and without the padding, the page is moved *under* the notch and the gesture bar. So
`index.html` gained the attribute and `src/index.css` gained the block in the same commit.

The insets reach the shell as an **inline style**, not as arbitrary-value classes. Tailwind scans
source text for whole class names, and a mistyped arbitrary value emits *nothing* — silently, with
`tsc` and the whole suite green. An inline style is what a computed length is already spelled as
here, exactly as a column template is.

**`--safe-b` is published and deliberately unapplied.** Nothing in this build is anchored to the
window's bottom edge, and padding the shell there would inset a scroller against an indicator that
is not over it. It exists for whatever 9b puts down there — a bottom tab bar, a sheet — and the
absence is the decision rather than an oversight.

The four properties sit in a `:root` block **of their own**, immediately after `.dark`, rather
than in the palette's. That block and `.dark` carry identical values on purpose and the insets
have no `.dark` twin to carry: they are not a colour, and a second theme would not move them.

### The build proved the classes emit, which is not a formality here

`h-dvh` is a core utility rather than an arbitrary value, so it *should* survive — but this repo
has shipped a class that compiled to nothing, and the check is two greps against the built sheet
(`dist/assets/index-*.css`, 159.09 kB / 28.95 kB gzipped):

```
$ grep -o "\.h-dvh{[^}]*}" dist/assets/*.css
.h-dvh{height:100dvh}

$ grep -o -- "--safe-t:[^;]*" dist/assets/*.css
--safe-t:env(safe-area-inset-top,0px)
```

All four insets are in the sheet — `--safe-t`, `--safe-r`, `--safe-b`, `--safe-l` — and
`dist/index.html` carries
`content="width=device-width, initial-scale=1.0, viewport-fit=cover"`.

`.h-screen{height:100vh}` is **still emitted**, and that is correct rather than leftover: three
`src/web/` boot screens use `min-h-screen` and `PlacementProbe.stories.tsx` uses `h-screen`
deliberately. What is no longer true is the *shell* being one.

### The assertion that was green over its own regression

Worth writing down, because it cost a mutation round and it is this repo's own trap read backwards.

`AppShell.test.tsx` asserts `viewport-fit=cover` against `index.html` read through `?raw`, which is
the only observable — no render reaches that file. Written as the obvious whole-file
`expect(html).toMatch(/viewport-fit=cover/)`, **it passed with the attribute deleted from the
tag**: the HTML comment written directly above the meta explains why the attribute and the four
properties ship together, and that explanation names the attribute. The regex matched the prose.

This is `tokens.test.ts`'s rule — Tailwind reads prose as eagerly as code — arriving from the other
side: here the *test* read prose as eagerly as markup. The fence is anchored on the tag now:

```ts
const VIEWPORT_META = /<meta\s+name="viewport"[^>]*\scontent="([^"]*)"/;
```

and the assertion reads the captured `content`, with `expect(content).toBeDefined()` as its own
assertion — a meta that has been renamed or removed makes `content` `undefined`, and
`expect(undefined).toContain(…)` would report a missing *attribute* rather than a missing *tag*,
which are two different repairs. Re-mutated after the repair it fails with
`expected 'width=device-width, initial-scale=1.0' to contain 'viewport-fit=cover'`.

**The general rule this earns:** a `?raw` assertion over a whole file is only a fence if the file
cannot describe the thing it is being searched for. In a codebase whose comments are as long as
this one's, most files can.

### Two prose sites now stale, not repaired here

Both name the shell as `h-screen` and neither is in this task's file set:

- `src/components/AppShell.stories.tsx:291` — "The shell is `h-screen`, and in a docs page that is
  the *docs* page's screen." The argument still holds; the class name in it no longer does.
- `src/features/decks/DeckEditor.tsx:3141` — "…while `body.scrollHeight` and the `h-screen` shell
  root both read 800…". This one is a **record of a 2026-08-15 measurement** and arguably should
  keep the class the shell had on the day, but it reads as a present-tense claim.

A prose-only edit routes to neither CI job, so nothing goes red for either.

### The dialog against a real URL bar — deferred, with the recipe

**This measurement was not taken, and the reading it needs cannot be emulated.** It is recorded
here in full so the next person pays for it once.

The question. `Dialog`'s scrim is `fixed inset-0 grid grid-rows-[minmax(0,1fr)]`
(`src/components/Dialog.tsx:333`) and the panel's clamp is `max-h-full`
(`src/components/Dialog.tsx:421`), a percentage of that grid area. If a `fixed` box's `bottom: 0`
resolves against the **large** viewport on a mobile browser, the grid area is taller than the
screen, `max-h-full` clamps to something bigger than the window, and the panel's footer buttons
land under the URL bar — which is the 2963px failure this document already records, arriving by a
different route and just as invisible to jsdom.

This is genuinely two-way and must not be guessed. It needs a real device, because
`scripts/cdp.mjs size` hardcodes `mobile: false` and emulates a narrow *desktop* — no URL bar, no
`visualViewport` behaviour, no coarse pointer.

**The recipe.**

1. Take the Storybook lock (`.claude/skills/running-the-app/lock.ps1`), `npm run storybook`, then
   `adb reverse tcp:6006 tcp:6006`. Storybook runs entirely on the fake, so this needs nothing
   from the web or Android targets.
2. On the phone, open the story **without the manager chrome**, which otherwise supplies its own
   scroller and makes the reading about the wrong box:
   `http://localhost:6006/iframe.html?id=decks-dialog-shell--long-body&viewMode=story`
   (`Decks/Dialog shell → Long body`, whose 24-paragraph body is already the "more content than
   fits" case). Repeat on
   `http://localhost:6006/iframe.html?id=decks-categoriesdialog--default&viewMode=story` for a
   panel that carries real footer controls — the `Dialog` shell itself renders header + body and
   its hosts supply the footer, so the shell's own story has no footer to read.
3. Evaluate, in one expression:

```js
(() => {
  const panel = document.querySelector('[role="dialog"]');
  const scrim = panel.parentElement;
  const last = panel.lastElementChild;
  return {
    scrimHeight: scrim.getBoundingClientRect().height,
    panelBottom: panel.getBoundingClientRect().bottom,
    lastChildBottom: last.getBoundingClientRect().bottom,
    visual: visualViewport.height,
    inner: innerHeight,
    client: document.documentElement.clientHeight,
  };
})();
```

`scrim` is `panel.parentElement` because that is exactly how `Dialog.test.tsx:226` reaches it;
using the same expression keeps the live reading and the pinned assertion talking about one
element.

4. **If `panelBottom > visualViewport.height`** (equivalently, if `scrimHeight` exceeds it): add
   `h-dvh` to the scrim's class string beside `inset-0` — a specified height wins over `bottom` on
   a fixed box — and pin it in `Dialog.test.tsx` next to the existing
   `expect(scrim).toHaveClass("grid-rows-[minmax(0,1fr)]")` at line 230, with a comment naming the
   device, the browser and the three numbers, because jsdom can never see the failure.
5. **If it does not:** change nothing, and **record the three numbers, the device and the browser
   here.** "We looked and it was already right" is a result. Without it the next person pays for
   the same measurement, and there is no cheaper way to take it.

Until one branch or the other is written down, `Dialog.tsx` is unchanged and this question is
open.

---

## One spelling of the coarse-pointer question, and a target-size floor

Shipped 2026-08-29 (mobile-layout 9a, Task 3), against tailwindcss **4.3.3** and proved by a
production `npm run build` in the `mobile-layout` worktree. Two lines of CSS and a sweep. **No
control in the app uses either of them**, and that is the point of the task rather than an
unfinished half of it.

### The variant

```css
@custom-variant coarse (@media (pointer: coarse));
```

`coarse:min-h-[var(--target-min)]` is how a control says it grows for a finger. It is the shape
`motion-reduce:` already has here — an environment preference expressed as a Tailwind variant, on
a great many sites; grep it rather than quoting a count, which is a fact about a tree — so the
vocabulary is one a reader of this codebase already has.

**`pointer`, not `any-pointer`.** A laptop with a touchscreen has a fine pointer *and* a coarse
one, so the `any-` spelling is true on that machine and would grow every control on it for a
finger nobody is using. The near miss is the thing worth fencing, which is why
`src/lib/touchTargets.test.ts` sweeps for both spellings and allows neither outside `index.css`.

**One spelling, for `layers.test.ts`'s reason.** A raw media query written in a component is a
second answer to a question the app should answer once, and the two drift the first time either
moves.

### The at-rule form is the one this Tailwind accepts, and it was proved by building

This mattered more than it looks. **A `@custom-variant` Tailwind does not understand fails
silently** — the utility simply never appears in the output, with `tsc` and the whole suite green.
The only witness is the built sheet, and the check is: add a throwaway
`coarse:min-h-[var(--target-min)]` to a component, rebuild, grep, remove.

The at-rule form above is what 4.3.3 accepted, on the first attempt. The alternative — the
selector form the neighbouring `@custom-variant dark (&:is(.dark *))` uses — was never needed. The
emitted rule, in full:

```
$ grep -o "@media(pointer:coarse){[^{]*{[^}]*}}" dist/assets/*.css
@media(pointer:coarse){.coarse\:min-h-\[var\(--target-min\)\]{min-height:var(--target-min)}}
```

> ⚠️ **That pattern only works while the block holds exactly one rule, and it stopped being true
> on 2026-08-29** when 9b's Task 7 gave the variant eleven utilities. `{[^{]*{[^}]*}}` matches one
> `.selector{…}` and then demands the closing brace, so over a multi-rule block it **exits 1 with
> no output** — which reads exactly like "the variant did not compile", the failure this check
> exists to detect. It is the same false negative the paragraph below warns about, one consumer
> later. Repeat the rule group instead:
>
> ```
> $ grep -oE "@media\(pointer:coarse\)\{(\.[^{]*\{[^}]*\})*\}" dist/assets/*.css
> ```

**The obvious grep for it finds nothing, and it is wrong twice.** Written as
`grep -o "@media (pointer:coarse){[^}]*}"` it exits 1 with no output over a sheet that plainly
contains the rule: Tailwind's minifier emits `@media(pointer:coarse)` with **no space** after
`@media`, and the rule **nests**, so a `[^}]*}` class stops at the inner brace and matches
nothing. Both halves of that are properties of the minified output rather than of the variant, and
either one alone reads exactly like "the variant did not compile" — which is the failure this
check exists to detect, so the false negative is expensive. The corrected pattern is the one
above.

### The token

```css
--target-min: 44px;
```

**WCAG 2.5.5 (AAA) asks 44×44 CSS px; 2.5.8 (AA) asks 24×24**, which this app already clears
everywhere — its control ladder is `h-9`/`size-9` (36px) for a control and `h-8`/`h-7` (32/28px)
for a small one. 44 is the number because the AA floor is a floor for a *pointer*, and the
surfaces this token is for have no pointer at all.

**A plain custom property rather than a `@theme` entry.** It is a minimum, not a step on the
spacing scale, and putting it in the spacing namespace would generate `p-target-min` and
`gap-target-min` — two utilities that mean nothing and one that means this. It sits in the
environment `:root` block beside the four `--safe-*` insets, which is the same argument: the
palette's `:root` and `.dark` carry identical values on purpose, and this is not a colour.

Published in the sheet as `--target-min:44px`.

### Nothing uses either one, and that is 9b's decision to take

**No `coarse:` variant and no `var(--target-min)` appears anywhere in `src/` outside the two
places that declare and guard them** — `index.css`'s own comment and `touchTargets.test.ts`'s.
Which control grows, and by how much, and on which surface, is a design decision: it is downstream
of the four option rounds, and writing it now would be answering a question nobody has been asked.
What is settled here is only that there is **one** way to ask the question, and a number to ask it
with that comes from a standard rather than from taste.

The consequence worth stating plainly: **the built sheet contains `--target-min` and no
`(pointer: coarse)` rule at all.** A media query with no utility inside it is not emitted, so the
variant costs the bundle nothing until something uses it.

### A measured correction to the "prose is a class source" rule

`src/index.css`'s comment for the variant names `coarse:min-h-[var(--target-min)]` verbatim, as a
whole class name, to show the intended spelling. This repo's rule — stated in `src/CLAUDE.md`, in
`tokens.test.ts` and in this plan's own constraints — is that **Tailwind scans source text for
whole class names, so a class named in a doc comment emits a rule**. That rule is why `@source` was
narrowed away from `docs/` in the first place.

**It does not apply to the stylesheet's own comments, measured today.** With the throwaway class
removed and that comment left in place verbatim, a full rebuild emits **no `coarse` rule and no
occurrence of the string `coarse` anywhere in `dist/assets/index-*.css`** — `grep -o "coarse"`
exits with nothing. So `src/index.css` can name a class in prose without shipping it, even though
`@source "../src"` covers the directory it lives in.

Do not generalise this to `.tsx`: those were not re-measured, the narrowing of `@source` was done
because prose in `docs/` *was* emitting rules, and the safe habit is unchanged. What is now known
is one specific exemption, and it is the one that lets the variant document itself at its own
declaration site.

---

## What touch takes away

**Read out of the source on 2026-08-29**, in the `mobile-layout` worktree at `56e94c2` with Tasks
1–3's then-uncommitted edits in the tree. Nothing below was driven on a device, and nothing below
is a proposal — the last paragraph of this section is the point of it.

Line numbers are a fact about a tree, so every row names the symbol or the string beside the line
and the line is the convenience rather than the identifier.

**Two of the files named below have since been deleted, recorded 2026-09-03 rather than edited
out.** `features/card/CardDetailPane.tsx` and `features/card/PrintingPreview.tsx` went when the
docked card surface became `CardDetailModal`. What that costs the census is stated at each row:
the hover-only `+` is one site fewer, and the printings dwell preview is **gone with no
equivalent** — the printings wall is a `CardGrid` of art tiles now, where the art is the tile and
there is nothing to preview. So the "four dwell timers" below are three.

### The sweeps, and what each one costs

The plan's own three greps, run first:

```
grep -rn "group-hover:\|hover:opacity\|opacity-0" src --include=*.tsx | grep -v "\.test\." | grep -v "\.stories\."
```

**13 lines. Two of them are prose** — `features/decks/cardControl.tsx:942`, a doc comment
explaining that `group-hover:` is the *wrong* question in a stack, and
`features/decks/CardStack.tsx:1224`, a JSX comment saying the same thing. Tailwind scans prose as
eagerly as code and emits a rule for a class named in either, which is why both are real hits for
a token sweep and neither is an affordance. A census that counted them would be reporting a
hover behaviour at two sites that deliberately do not have one.

**The same sweep undercounts in the other direction, by eleven.** `REVEAL_ON_HOVER`
(`features/collection/AddToCollection.tsx:36`) and `REVEALED_ON_CARD`
(`features/decks/cardControl.tsx:933`) are shared constants, so the grep finds each definition
once and none of its call sites. `REVEAL_ON_HOVER` alone is spread at **11 sites in 9 files**.
Grepping the constants is what finds them; grepping the classes cannot.

Widened to every `hover:` variant:

```
grep -rn "hover:" src --include=*.tsx --include=*.ts --include=*.css | grep -v "\.test\." | grep -v "\.stories\."
```

**190 lines in 83 files**, with **19 test and story files excluded**. At least six of the 190 are
prose; the true figure is higher, because the filter that finds a prose line (`*` or `//` at the
start) cannot see a JSX comment's continuation lines, which is exactly how `CardStack.tsx:1224`
escapes it. Do not write a prose/markup split down as a number — classify at the site.

Tooltips: **53 shipped files** bind `useTooltip()` (54 matches less the hook's own module),
holding **81 `const tip = useTooltip()` bindings** and **98 `{...tip(…)}` spreads**; **26 test and
story files excluded**. Of the 98, **11** pass `whenClipped: true`, and about 57 code lines pass
`describes: false`.

Right-click: `grep -rn "onContextMenu"` returns **37 shipped lines** — **14 JSX attachments**,
**9 handler factories** (`onContextMenu: menu(build)` and its two inline twins), **5 type
declarations**, and the balance prose — over one document-level suppressor at
`components/menu/ContextMenuProvider.tsx:67`.

**Six things the sweep found none of, each checked rather than assumed:** `onDoubleClick` and
`dblclick`, **0**. `onWheel` as a React prop, **0** — the app's only `wheel` listener is
`lib/useCardZoomGesture.ts:88`. `pointerType` in shipped code, **0** (five matches, all in stories
and `src/test-drag.ts`, all synthesising `"mouse"`). `touchstart`/`touchend`/`TouchEvent`, **0**.
Any long-press, **0**. `matchMedia` in shipped code, **0** — the two matches are the jsdom stub at
`src/test-setup.ts:147`.

**`title=` is 59 shipped lines and exactly one of them is a native attribute**, `components/AppShell.tsx:596`.
Every other match is a component prop — a heading (`Dialog`, `Notice`, `SettingsSection`) or a
prop the component turns into a `useTooltip()` binding itself (`Marker` at
`features/decks/views/GroupHeader.tsx:143`, `ToggleChip` at `features/decks/DeckEditor.tsx:3752`).
The shape `src/CLAUDE.md` describes is the shape the tree is in.

**One correction worth recording before it is repeated: `touch-action` is not absent from this
tree.** Two sites carry it — `src/index.css:434`, inside the block mirroring the rules
`@dnd-kit/dom` injects at runtime, applying `touch-action: none` to whatever is mid-drag; and
`features/search/CardSearchPanel.tsx:747`, where the panel's resize strip carries Tailwind's
`touch-none` with a comment saying why. (That was `features/decks/DeckSearchPanel.tsx:1072` until
2026-09-07, when the shell was extracted and three panels started drawing it.) Neither is a designed touch affordance and neither
changes what follows, but a later sweep for "does anything here think about touch" will find them
and should know what they are. `(pointer: coarse)` really is nowhere: every `coarse` in the tree
is prose about something else.

### Hover-only affordances

| Site | What only a hover gives | Reached another way today |
| --- | --- | --- |
| `components/AppShell.tsx:614` — `{...tip(narrow && label, { side: "right", describes: false })}` | The nav entry's word while the rail is collapsed to `w-17`/68px. The label is `sr-only` there, so the button's accessible name is unchanged and a screen reader still has it; the eye has the icon and nothing else. | The expanded rail — `useNavCollapsed` persists the state in `app_meta`. At 390px the expanded rail is 208px of the window. |
| `components/AppShell.tsx:822` — the same spread over a pinned deck or folder's name | Which deck or folder each pinned art crop is. | The same, and nothing else. |
| `components/Ribbon.tsx:96` (`dataDir`) and `:97–98` (`imageStoreFailures`), bound at `:176` on the `role="status"` line | Which data folder is live, and how many card images could not be written to the cache. | **Nothing.** Each field reaches the UI at exactly one place, and it is this tooltip: `imageStoreFailures` is drawn in no other string and `dataDir` in no other expression. Settings names neither — `features/settings/SettingsPage.tsx:154` reads "Data folder and import. Coming in a later plan.", and `features/settings/DangerZonePanel.tsx:117` records that the folder is named nowhere on Settings. |
| `features/collection/AddToCollection.tsx:41` — `REVEAL_ON_HOVER`. **No count is written here; `grep -rn REVEAL_ON_HOVER src` is the census** — this row said *11 sites* with line numbers and every one of them had moved by 2026-09-07. The files, which drift far more slowly: `collection/CollectionTable.tsx`, `collection/CollectionSearchPanel.tsx` **(new 2026-09-07)**, `decks/DeckTile.tsx`, `decks/FolderTree.tsx`, `search/CardGrid.tsx` (×2), `search/SearchPage.tsx` (×2), `tags/TagResults.tsx`, `wishlist/WishlistGrid.tsx`, `wishlist/WishlistSearchPanel.tsx` **(new 2026-09-07)**, `wishlist/WishlistTable.tsx` (×2). `card/CardDetailPane.tsx` was on this list until **that file was deleted 2026-09-03; the modal that replaced it draws no quick-add** | Where the quick-add `+` is, on every card surface in the app — **including the two docked search sidebars since 2026-09-07**, whose tiles are the newest place this `+` appears. | **The control is not gone; it is unaimable.** `opacity-0`, never `hidden` — deliberately, so it keeps its tab stop — and `CardGrid.tsx` states in as many words that an `opacity-0` element is still a hit target. A finger that lands on it presses it. Nothing on screen says it is there. |
| `features/decks/cardControl.tsx` — `REVEALED_ON_CARD`. **Two call sites, `views/GridView.tsx` and `views/TextView.tsx`** — grep the constant rather than trusting a count; both this row and the constant's own doc have said *three views that draw a card as a picture*, which is wrong twice over, since `TextView` draws no picture and `CardStack` uses the other door | The deck card's controls, on the views that reveal them by the pointer. | The same `opacity-0` answer. The stack has a second door: `revealedWhenOpen` drives the same controls off **which card is open** rather than off the pointer — see the flip-through row. **Since 2026-09-08 the grid tile draws the stack's own control _column_** (`DeckCardControls layout="card-column"`), still revealed by `REVEALED_ON_CARD`: nothing overlaps a tile on that wall, so the pointer is the honest question there where it is not in a pile. |
| `components/CardArt.tsx:210–213` — `group-hover:scale-[1.02]`, given `hoverZoom` by `features/search/CardGrid.tsx`; `features/decks/DeckTile.tsx:531–534` for a deck tile. **`features/decks/views/GridView.tsx` was a third call site until 2026-09-08** and is not one now: that tile draws `DeckCardFace` rather than `CardArt` and has no lift at all — grep `hoverZoom` for the census rather than trusting these line numbers | Which tile the pointer is over. | Nothing equivalent, and nothing is missing: the lift answers a question a finger does not ask. The caret's answer is `FOCUS`, which is a different thing. **On a deck tile it is now missing for a mouse too**, deliberately: the deck's two card views are one card, and the stacked card has never lifted on hover. |
| `features/search/CardSearchPanel.tsx:747` (`cursor-col-resize`) and `:755–762` (an `opacity-0 … group-hover:opacity-100` grip) — `DeckSearchPanel.tsx:1072`/`:1082–1086` until the shell was extracted on 2026-09-07, and **three** docked panels draw it now rather than one | That a docked search panel's left edge can be dragged at all. Both signals belong to a pointer: a cursor a touchscreen does not have, and a grip revealed by `group-hover`. | The drag itself is pointer-based and the strip already carries `touch-none` (`:747`); the keyboard reaches the same resize through arrows, Home and End (`:724–736`). Nothing **visible** reaches it without a pointer. |
| `features/decks/CardStack.tsx:851` — `onPointerEnter={() => onArm(index)}`, `STACK_OPEN_DWELL_MS` 80 (`:271`); released at `:703` after `STACK_CLOSE_DELAY_MS` 180 (`:287`) | The deck builder's signature interaction: running a pointer down a pile to fan it. | **Yes, and by design.** The open card resolves to `openIndex ?? selectedIndex` (`CardStack.tsx:653–655`), so a card that was *pressed* stays lifted after the pointer has gone. A tap therefore fans one card. What a tap cannot do is fan the pile. |
| ~~`features/card/PrintingPreview.tsx:182–183`~~ — `onMouseEnter`/`onMouseLeave`, `PREVIEW_DWELL_MS` 250 (`:25`). **Deleted 2026-09-03 with the docked card pane.** | One printing's art without swapping to that printing. | `onFocus` armed the same dwell when focus arrived in the row (`:185–187`), which was the keyboard's door. On touch, `onPointerDown: cancel` (`:201`) took down whatever the tap's compatibility `mouseenter` armed. **Nothing replaces it**, and nothing needs to: the printings list is `AllPrintingsDialog`'s wall of art tiles now, so the art is the tile and looking at one costs no hover. |
| `components/menu/ContextMenu.tsx:730` — `onPointerOver`, `SUBMENU_HOVER_MS` 120 (`:48`) | Opening a submenu by resting on its row. | **Yes, at the site**: the submenu row's own `onClick` toggles it (`components/menu/Submenu.tsx:163`). Opening the parent menu is the gestures table's problem, not this one's. |
| The other **98** `{...tip(…)}` spreads, across 53 shipped files | Everything this app says only in a hint. Two kinds, unequally lost: **11** pass `whenClipped: true`, where the words are the anchor's own truncated text — complete in the DOM and therefore in the accessibility tree, so only the *paint* is cut off; the rest are descriptions, and the ~57 lines passing `describes: false` are the ones whose words are the element's own name or already-visible text, drawn `aria-hidden`. | Nothing generic. Each of the 98 is its own question, and the two kinds have to be told apart before any of them is counted as lost. |
| The marks on a card face — `components/CardArt.tsx`, `components/FinishMark.tsx`, `components/GameChangerMark.tsx`, `components/CountTag.tsx`, `components/OwnedBadge.tsx`, `components/RarityGem.tsx` and every mark in `features/decks/CardMarks.tsx` (grep `useTooltip` there for the census — the line numbers this row carried moved twice on 2026-09-08 alone, and a stale line number reads as a claim about a site nobody can find) | What a glyph means. Each binds `describes: false` because the panel carries the mark's *name* and the mark itself is `aria-hidden`. | Nothing on the card. The same facts are set in type in the card pane and in the three tables — a different surface, not the same one reached twice. |
| `components/AppShell.tsx:596` — the app's one native `title` | Nothing at all, and it is in this table so it is not mistaken for a lead. | **The phone answer is never "put the `title` back."** `src/CLAUDE.md` requires a hint to be `useTooltip()`'s spread, and the reason holds twice over here: a native tooltip does not appear on touch either, so restoring one would trade a hint nobody sees for a hint nobody sees. This site survives precisely *because* its sentence is never shown to anybody — Chromium freezes `:hover` at a drag's origin for the whole drag — and is read through the accname spec's description fallback instead. |

### Gestures with no touch equivalent

| Gesture | What it is, and what it does | Reached another way today |
| --- | --- | --- |
| **Ctrl+wheel — the card zoom** | `lib/useCardZoomGesture.ts:82–88`: one native `wheel` listener at `{ passive: false }` that returns unless `e.ctrlKey`, then `preventDefault()`s and calls `zoomCards(section, e.deltaY < 0 ? 1 : -1)`. It steps the sixteen-stop ladder in `lib/cardZoom.ts:79–81` for one of the eight sections at `:125–134`. | **Nothing. The grep is below, and it is the finding this round rests on.** |
| **Ctrl/⌘-click** | `readModifiers` (`lib/multiSelect.ts:70–79`) sets `toggle` from `ctrlKey \|\| metaKey`; `applySelect` (`:80` onward) toggles that one key in or out of the set. It reaches a surface through `useCardSelection`'s `pick` (`lib/useCardSelection.ts:79`, `:125`), which returns whether the press was a selection. | **Nothing.** There is no "Select all", no checkbox column and no selection mode anywhere in the tree — `grep -rni "select all\|selectAll\|selectRange"` outside tests and stories returns no lines. `CardGrid`'s arrow walk returns early on **any** modifier (`features/search/CardGrid.tsx:969`), so the wall's keyboard path offers no chord either. |
| **Shift-click** | The same `readModifiers`, setting `range` from `shiftKey`; `applySelect` replaces the set with the run from the anchor, and Ctrl+Shift adds that run instead. Four cases and no others, Shift outranking Ctrl (`lib/multiSelect.ts:80–110`). | As above. |
| **Right-click** | `useContextMenu`'s `menu(build)` (`components/menu/useContextMenu.ts:151`), spread as `onContextMenu` at 14 shipped attachments over 9 handler factories, above a document-level suppressor at `components/menu/ContextMenuProvider.tsx:67`. It is how a card, a table row, a folder, a deck tile, a pile heading and the card pane are acted on. | **Two doors, and neither belongs to touch.** `menuKey` answers Shift+F10 and the ContextMenu key (`useContextMenu.ts:153–162`) — a keyboard. `menuClick` opens the same menu from a plain click on a `⋯` trigger (`:182–185`) — and it exists at exactly **two** surfaces, the collection's and the wishlist's folder cards (`features/collection/CollectionPage.tsx:1322` and `features/wishlist/WishlistPage.tsx:862`, drawn at `CollectionFolderCard.tsx:244` and `WishFolderCard.tsx:229`). Every other menu in the app has no plain-click door. |
| **Resting a pointer** | Four dwell timers, each keyed on a pointer that arrives and does not leave: `TOOLTIP_OPEN_MS` 400 (`components/tooltip/TooltipProvider.tsx:17`), `SUBMENU_HOVER_MS` 120 (`components/menu/ContextMenu.tsx:48`), ~~`PREVIEW_DWELL_MS` 250 (`features/card/PrintingPreview.tsx:25`)~~ — **deleted 2026-09-03, so three** — and `STACK_OPEN_DWELL_MS` 80 (`features/decks/CardStack.tsx:271`). | Per site, in the table above. **The tooltip's own mechanics deserve stating precisely, and they were not measured on hardware for this census.** The binding is `onPointerEnter`, not `onMouseEnter` (`components/tooltip/useTooltip.ts:113`), and a touch tap *does* dispatch `pointerenter` — so the 400ms timer is armed. What happens next has three parts: the provider's document-level `pointerdown` handler calls `hideNow` (`TooltipProvider.tsx:190–195`), which clears the *close* timer and hides what is open but does **not** clear the open timer; `pointerleave` at lift-off calls `leave`, which does clear it (`:155–160`); and the `focus` door is fenced on `anchor.matches(":focus-visible")` (`:141`), which a pointer press makes false. Whether a deliberate press-and-hold past 400ms puts a panel up is therefore a **reading somebody owes on a device**, and not a conclusion this census may draw from source. |

### The zoom is the one with no other door

`useCardZoomGesture(ref, section)` (`lib/useCardZoomGesture.ts:78–95`) attaches a single native
`wheel` listener with `{ passive: false }` to the element it is handed — `CardGrid`'s scroller,
`StackView`'s root, `GridView`'s root and `DecksPage`'s tile wall, four call sites. The handler
returns unless `e.ctrlKey`, then `preventDefault()`s (which is what stops WebView2 zooming the
whole window on top of the app, and the entire reason this is not React's passive `onWheel`) and
calls `useAppStore.getState().zoomCards(section, e.deltaY < 0 ? 1 : -1)`.

**A trackpad pinch works and a touchscreen pinch does not, and the difference is a kind rather
than a degree.** A precision trackpad's pinch is delivered to the page as a stream of `wheel`
events with `ctrlKey` set and no key held — that file says so at `:51–55` — so one branch serves
two input devices, and the `preventDefault` is load-bearing on hardware where nobody is touching
Ctrl. A touchscreen pinch produces **no wheel event at all**. It is a two-pointer gesture, and
nothing in this app listens for one: no `touchstart`, no `TouchEvent`, no `pointerType` branch, no
gesture library, nowhere in `src/`.

**So on a phone `cardZoom` is frozen at whatever the last session left.** `ZOOM_STEPS` is
**sixteen** stops from 0.5 to 2, ten points apart, written out as literals
(`lib/cardZoom.ts:79–81`), walked independently per section (`ZOOM_SECTIONS`, `:129–140` — the
constant is the census and no total is written here; it was **eight** when this paragraph was
written and `collectionSearch` and `wishlistSearch` joined on 2026-09-07, which is the drift a
written-down count buys).
The value a phone opens on comes from `hydrateCardZoom` (`lib/store.ts:1029–1037`), called once
from `lib/useCardZoomPersistence.ts:80` with whatever `ipc.cardZoom()` answered: it snaps each
value to the ladder through `snapZoom`, **drops any key this build does not draw** (`isZoomSection`),
bumps no pulse — a restored size is not a gesture — and returns unchanged if the reader zoomed
during the round trip. A database that has never been zoomed and a read that fails both land at
`DEFAULT_ZOOM` = 1 (`cardZoom.ts:88`, `:153–175`). The write half never runs either: the
persistence effect subscribes on `zoomPulse`, and only `zoomCards` bumps it
(`lib/store.ts:1020–1024`).

**And the grep, because the claim above is the one thing the wall's design round argues from.**
Asked on 2026-08-29:

```
grep -rn "zoomCards" src .storybook
```

**39 lines. Six sit outside test and story files**, and of those six, three are doc comments, one
is the store's interface declaration (`lib/store.ts:400`) and one is the store's definition
(`:1020`). **Exactly one is a call: `lib/useCardZoomGesture.ts:86`.** The pair of `−`/`+` buttons
at `components/CardZoomIndicator.stories.tsx:69` and `:72` are the workbench's, in no build a
reader sees. `stepZoom` tells the same story — 34 lines, one definition (`cardZoom.ts:234`), one
import and one call, both in `store.ts`, the rest prose and tests. **Nothing anywhere in this app
steps `cardZoom` but the wheel.**

### This is a census and not a proposal

What replaces any of the rows above belongs to the four design rounds and to 9b, and is
deliberately absent from here. A census that quietly proposes a fix is a design decision taken
without being asked for — it arrives dressed as a measurement, it is argued from nowhere, and by
the time anybody notices it is a constraint rather than a finding. The rows are what a reader with
no hover and no wheel loses, and the third column is what the tree offers **today**, not what it
ought to offer.

---

## The phone frame, driven: the rail decides whether the wall can ever be two columns

**Measured 2026-08-29 in the shipped WebView2** (`npm run tauri dev`, debug build, `mobile-layout`
worktree), at `cdp.mjs size 390 844`. This is the reading the wall's design round argues from, and
it found a coupling between two rounds that the 9a plan does not have.

> ⚠️ **`cdp.mjs size` hardcodes `mobile: false`**, so this is a narrow *desktop* — no URL bar, no
> `visualViewport` behaviour, no coarse pointer. It measures **width arithmetic**, which is
> exactly what is wanted here, and it measures nothing about touch. WebView2 also **ignores
> `clearDeviceMetricsOverride`**, so the window was put back with an explicit `size 1280 800`.

### The three widths a 390px window actually leaves

`main` is `p-5`, so it takes 40px off whatever the rail leaves. The rail's own width is
`useNavCollapsed`'s persisted state, and **nothing collapses it automatically at any width** — a
390px window opens with the full 208px rail unless the reader has collapsed it before.

⚠️ **`main`'s content box is not the wall, and the 26px between them is worth a column.** The
`ResizeObserver` is on `rowsRef` (`CardGrid.tsx:646–648`), which sits **inside** the scroller's
`border` and `p-3` (`:1020`) — 1px + 12px each side. `rowsRef`'s own comment says it, having no
padding of its own, "is the honest answer to how wide a row of tiles may be." So the wall is
`main` content **− 26**, and any arithmetic done on `main`'s width overstates the columns.

| Rail | `nav` | `main` content | **wall** (`rowsRef`) | `columnsFor` @170 | @160 | @144 |
| --- | --- | --- | --- | --- | --- | --- |
| Expanded — **today's default** | 208 | **142** | **116** | 1 | 1 | 1 |
| Collapsed (`useNavCollapsed`) | 68 | **282** | **256** | 1 | 1 | **1** |
| Gone entirely | — | 350 | **324** | 1 | **1** | **2** |

The first two `nav`/`main` rows were driven in the window; the wall column is those figures less
the 26px inset read from the class string, and the column counts are `columnsFor` — `max(1,
floor((width + 12) / (tile + 12)))` (`CardGrid.tsx:180`) — over them. A desktop scrollbar takes
another ~15px off the wall; a phone's overlay scrollbar takes none.

**At 142px the tile is narrower than one whole tile**, so `tileWidthFor`'s cap — its only
arithmetic, and it covers exactly this case — draws the card at 142 rather than 170, and
`sideGutterFor` returns 0. That is the state a phone opens in today.

### The coupling, which is the finding

**Two columns need the rail gone *and* a tile well under 160.** Against the wall rather than
against `main`: `columnsFor(324, 160)` is **1**, so 160 — the width the 9a plan suggests for a
phone tile — draws a **single** column on a phone, which is the failure it was meant to fix. The
largest round width that gives two columns at 324 is **144**; at 144 the leftover is 24 and the
gutter is exactly `GAP`, so the margins and the inter-card gap become one measurement.

And 144 only holds if the rail has gone. With the collapsed 68px rail the wall is 256, where
`columnsFor(256, 144)` is **1** again and the tile would have to fall to about 122.

So the wall's round and the chrome's round are **not independent**, and the option matrix is
smaller than it looks: **a phone tile width delivers two columns only if the rail is gone** — a
bottom bar or a drawer — **not if the collapsed rail is kept.** That is one finding across two
rounds, and either round decided on its own gets it wrong.

**What a narrower tile does *not* do is shrink the chin's type.** `--mark-scale` and
`--control-scale` come from `cardScaleVars(zoom)` and know nothing about `baseTileWidth`, so the
chin stays 28px with 10px type at any base — a narrower tile makes the chin proportionally
**taller** (10.7 % of tile height at 170, 12.4 % at 144), which is a cost in the other direction
from the one "a 6 % shrink on the type" suggests.

### The vertical, on the same pass

At 390×844 in WebView2: `TitleBar` **34**, ribbon + `ManaLine` **58** (56 + the 2px line, exactly
as the plan states), `main` **752** of which **712** is content after `p-5`'s 20 top and bottom.

**On web and Android the 34 comes back and roughly 144 goes away** — parity §5 says the browser and
the OS own the frame, so `TitleBar` is absent, while a mobile browser's chrome takes the visible
viewport to roughly 700. That leaves about **602px** of `main` content before the filter bar
spends anything, and the bar's two or three lines at 36–40 take it to roughly **500** — one 170px
tile plus its chin, and a sliver of the next row. The plan's vertical budget holds as written.

### What this pass could not measure, and why

**The wall was empty.** A worktree is a fresh install and its `corpus.db` has never synced, so
`main li` returned zero tiles and no drawn tile width could be read. Every figure above is a
measurement of *boxes* — `nav`, `main`, their padding — plus `columnsFor` evaluated against the
measured content width in the same `eval`. That is the honest scope of it: the geometry is
measured, the tile counts are arithmetic over a measured width, and **no card was on screen**. To
read real tiles here, copy the main checkout's whole `data` folder into the worktree first.

---

## The phone layout on an actual phone — and the vertical does not work

**Driven 2026-08-29 on the OnePlus (`adb` device `21755151`), Android, Chrome 152.0.7977.64, dpr 3,
portrait**, against the production web build of 9b (`npm run build:wasm && npm run web:build`,
served by `vite preview` on 4173, reached from the device through `adb reverse tcp:4173 tcp:4173`
and driven over `adb forward tcp:9333 localabstract:chrome_devtools_remote`). Corpus built on the
device: **117 606 cards**.

**This is the measurement 9a could not take and 9b's plan is answerable to**, and it falsifies the
budget the plan was written against. Two independent things went wrong, and neither is visible
from a desktop.

### The device is 360 CSS px wide, not 390 — and that alone costs the second column

`src/lib/viewports.ts`'s `PHONE_PX` is **390**, chosen in 9a as "a hard case… the iPhone 12/13/14,
within a pixel or two of the common Android flagship in CSS pixels". **This flagship is 360.**

| | 390 (the design frame) | **360 (this device)** |
| --- | --- | --- |
| `main` content | 350 | **320** |
| wall (`rowsRef`, less the scroller's `border` + `p-3`) | 324 | **294** |
| `columnsFor(wall, 144)` | **2** | **1** |
| largest tile giving two columns | 156 | **141** |

Measured on the device rather than computed: the wall's rows are **226 px tall × 294 px wide and
carry exactly one tile each**. **G1's 144 misses two columns by three pixels here.**

`matchMedia('(max-width: 390px)')` still answers **true** at 360, so `useNarrowWindow` and the tab
bar are correct — it is only the *tile* that was sized against a frame this hardware is narrower
than.

### The shut filter bar is 381 px, not 273 — and 108 px of that is the touch floor

| | px |
| --- | --- |
| Visible viewport with the URL bar (`innerHeight` = `visualViewport.height`) | **696** |
| Ribbon block (`h-14` + the 2px `ManaLine`) | 58 |
| Tab bar | **53** — exactly as designed |
| `main`'s `p-5`, top and bottom | 40 |
| `main` content | **545** |
| **Shut filter bar** | **381** |
| **What is left for the wall** | **99** |

58 + 585 + 53 = 696 exactly, so nothing is unaccounted for. **A tile row is 226 px and the wall is
99**, which is 44 % of one row — the plan's own failure condition was "one tile row", and this is
less than half of it.

**The cause was isolated on the device rather than guessed**, by setting `--target-min: 0px` on the
root and re-reading, then restoring:

| | shut bar | wall |
| --- | --- | --- |
| With the 44 px floor (shipped) | **381** | **99** |
| `--target-min: 0px` | **273** | **207** |
| Restored | 381 | 99 |

**The floor costs exactly 108 px of vertical and the wall gains exactly the same 108 back.**
Note what the middle row is: **273 is precisely the figure the 9a plan predicted for the shut
bar** — that measurement was taken before `coarse:` had a consumer, so the plan was right for its
time and Task 7 added 108 px to it.

**So 9b's two decisions are in direct conflict, and now the size of it is known.** F1 buys a
reachable control on the axis that had room; it spends 108 px on the axis that had none. This is
not an argument against the floor — every chip measured **44 × 44** on hardware where they were 32,
and `(pointer: coarse)` really is `true` — it is the measured price of it, and the thing to spend
next.

### What works, measured on the device

- **`(pointer: coarse)` is `true`** and `--target-min` resolves to `44px`. Every control checked is
  at or above the floor: the mana-value and colour chips **44 × 44** (they are 32 on a desktop),
  `Show filters` and `Reset all` 44 tall, a tab **60 × 52**. Task 7 does what it claimed.
- **The tab bar is 53 px**, the figure it was designed to.
- **No horizontal overflow** — `documentElement.scrollWidth` equals `innerWidth`.
- **`h-dvh` is right**: `100dvh` reads **696**, the visible viewport, against `100lvh`'s **752**.

### The dialog against a real URL bar — owed since PR #274, and the answer is that it was already right

`Dialog`'s scrim is `fixed inset-0`, and the open question was whether that resolves against the
**large** viewport on a mobile browser — which would make the grid area taller than the screen,
`max-h-full` clamp to more than the window, and the panel's footer land under the URL bar.

Measured directly, with a probe rather than through one dialog's markup, so the answer is about
the browser rather than about one component:

| | px |
| --- | --- |
| `position: fixed; inset: 0` box | **696** |
| `visualViewport.height` | **696** |
| `100dvh` / `100svh` | **696** |
| `100lvh` | **752** |

**A `fixed inset-0` box resolves against the *visible* viewport, not the large one.** `Dialog`
needs no change, and this is recorded so the next person does not pay for the same measurement.

### `--safe-b` is `0px` on this device, and that is not a bug

The gesture bar reserves no inset here, so the tab bar's `paddingBottom: var(--safe-b)` costs
nothing on this hardware. It is still correct to carry: the value is a property of the device, the
`env()` fallback is what makes the declaration parse, and a phone with a reserved gesture area
would put the bar's targets under it without this.

### What this does not settle

- **The drag from the search overlay into a hidden pile** (9b Task 8's recorded limitation) was not
  driven. With a 99 px wall there is no honest gesture to make, and the question should be re-asked
  once the vertical is fixed — a reader who cannot see a tile cannot drag one.
- **One device, one browser.** Every figure here is this OnePlus in Chrome 152. A 390 px phone
  would get the second column; the point is that this one does not, and `PHONE_PX` is the app's
  own stated frame.

---

## 9c on the phone: the wall shows cards

**Driven 2026-08-29 on the OnePlus, Chrome 152, portrait, `innerWidth` 360**, against the
production web build of `main` at the merge of PR #300, with the 117 606-card corpus already in
OPFS. Same instrument as 9b's pass — the recipe is in *"The phone layout on an actual phone"*
above.

**The prediction was 436px of wall and it came back at exactly 436.** The one figure that was off
was the row height, and it was off in the app's favour.

| | 9b (measured) | 9c predicted | **9c measured** |
| --- | --- | --- | --- |
| shut bar / strip | 381 | 44 | **44** |
| wall | 99 | 436 | **436** |
| tile row | 226 | 237 | **221** |
| complete rows | **0** | 1.84 | **1.97** |
| tiles per row | **1** | 2 | **2** |

**0.44 of a row to 1.97.** A reader sees two whole cards and 97 % of the next two — **two whole
rows are 442 and the wall is 436, short by six pixels.** Nothing else changed: the ribbon block is
still 58, the tab bar still 53, `main`'s content still 545, and `documentElement.scrollWidth`
still equals `innerWidth`.

**The row is 221 rather than the projected 237** because the projection added `GAP` to the row
box; the virtualiser's row *is* the tile and the gap sits between rows in the total. A 16px error
that made the estimate pessimistic — worth naming so the next projection uses the measured shape.

### Filtered, which is where the strip's second line appears

| | px |
| --- | --- |
| strip, no filters | **44** |
| strip, one filter on | **96** — 44 + 8 + 44 |
| wall, filtered | **384** — 1.74 rows |

The chip is on the strip and it is the real one: `Remove filter — Colour: Red`, with its own ✕.
`Reset all` is beside it at **44px**, and `resetInScroller` reads **false** — it is outside the
horizontal scroller, so it cannot scroll away from the chips it undoes. Both were designed that
way and both are confirmed on hardware rather than in jsdom, which can see neither.

**The second line is 44 and not 26**, because `ResetAll` sets it at the coarse floor. That is the
figure this plan quoted as 34 when the decision was taken — see the plan's Task 3 for the
correction and why the decision survives it.

### What the whole screen is now

One frame, top to bottom: the ribbon shed to a card count and Refresh; the strip's search box and
`Filters · 1`; the stated `Colour: Red ×` beside `Reset all · 1`; four cards in two columns; the
bottom tab bar with **Search** marked. Every decision from 9a's four rounds and 9c's two is
visible at once, and the horizontal overflow is zero.

### What is still owed, and it is the same question as before

**9b's Step 3b — whether a drag from the deck editor's search overlay can land in a pile hidden
behind it — was still not driven.** dnd-kit hit-tests by **rect**, so the piles stay droppable
while invisible. The blocker is no longer a 99px wall: it is that the question needs a deck with
categories on the device and a synthesised pointer drag, which is its own pass rather than a step
in this one. **It is now answerable for the first time** — record that, because the reason it was
deferred has changed.

### One operational note for the next pass

**The one-tab guard is a real obstacle to repeat measurement.** A tab left open from an earlier
pass makes the next one render *"MTG Grimoire is already open"* and nothing else — correct
behaviour, and indistinguishable from a broken build if you are not expecting it. Close the stale
tab through `http://localhost:9333/json/close/<id>` before reloading, and take the ids from
`/json/list` so the reader's own tabs are left alone.

**And `vite preview` needs `--host`.** Without it the PC gets 200 and the phone gets `000` through
`adb reverse` — the server binds too narrowly for the tunnel to reach, and the failure looks like
a broken tunnel rather than a bound socket.

---

## Settings became a rail and a pane, and the two flex numbers are lopsided on purpose

**Written 2026-09-03 as arithmetic off the class strings, and driven the same day.** The section
was drafted before any of it had been in front of a window, and the subsection at its foot said so
in those words. It has since been driven over CDP under `tauri dev` (debug build, Windows,
2026-09-03) and **every calculated figure came back exact** — including the tight one. The figures
below are now measurements; where a number is still only arithmetic it says so at its own site,
and the foot of this section records what the pass could not settle.

### The shape: a rail of entries over a page of panels

The page was one scroll of twelve panels, ordered by what a press costs. That ordering is a real
rule and is still the rule *inside* a group, but an ordering only helps a reader who already knows
what they are scrolling towards. It is now a left rail of **seven** entries and a pane drawing only
the selected entry's panels, with a search box above the rail that filters panels across every
group. (Twelve was the panel count on 2026-09-03 and is not one now; `Object.keys(PANELS)` is the
answer, and this page deliberately stops writing that number down — `nav.ts`' own module comment
makes the same refusal for the same reason. The rail's own count is written in the build, on
`GroupId`, so it is repeated here and nowhere else.)

**`src/features/settings/nav.ts` is the whole of the decision and neither component that draws it
decides anything.** `SettingsNav` draws the rail, `SettingsPage` draws the pane, and both of the
things worth getting wrong here — which panels a group holds, and which panels a query matches —
are decidable with no DOM in front of them.

| Rail entry | Panels under it, in drawing order |
| --- | --- |
| Updates | `updates` |
| Card data | `prices`, `combos` |
| Sync — badge: the `Needs review` queue | `sync`, `review` |
| Tags | `hidden-tags` |
| Appearance | `theory-marks`, `labels` |
| Storage and data | `data-folder`, `backup`, `cache`, `web-storage` (web build only), `danger` |
| Errors — badge: the error count | `errors` |

**Where two panels answer one question they share an entry**, and where a panel is the only answer
to its own question it gets one to itself. `Prices` and `Combos` are both optional bulk feeds of
card facts; `Needs review` is what sync asks *of* a reader; `Theory marks` and `Labels` are both
"what a mark on a card looks like", which is why **Appearance** is one entry and not two (added
2026-09-07). A rail as long as the page it indexes would be a second scroll rather than a way
through the first, and that is the whole argument — a new entry has to earn itself against it.

**Labels sits under Appearance and emphatically not under Tags.** A *tag* in this app is one of
Scryfall's two tagger datasets; a *label* is the deckbuilder's coloured per-card mark. The two
words must never trade places, and a rail is the one surface where a reader would take a shared
heading as a claim that they are the same thing.

**`Clear data` has no entry of its own and sits at the foot of `Storage and data`.** The three
clears empty the part of the app the data folder holds, so that is the question they answer — and
`DangerZonePanel`'s distance from everything else is kept *inside* the pane, where it has always
been, rather than turned into a rail row that would put "delete my collection" one press from
every visit to Settings.

**The panel ids are the panels' own `SettingsSection` stems, character for character, and that
claim now has a fence.** The stem is a `string` prop, so a `PanelId` no heading answers to
type-checks perfectly and costs the reader a rail entry that scrolls to nothing.
`src/features/settings/nav.test.ts` sweeps `/src/**/*.{ts,tsx}` through Vite's `?raw` — the
`layers.test.ts` trick, for its reason: no `@types/node`, so no `node:fs` — and asserts the set of
drawn stems against `Object.keys(PANELS)`. Two things the sweep has to get right and a naive one
would not: it **strips comments first**, because this repo keeps its reasoning in prose and the
prose quotes markup freely, so a doc comment containing `<SettingsSection id="…">` would otherwise
read as a panel that nothing draws (proved by mutation — with the stripper
disarmed, a tag quoted in one of `nav.ts`'s own comments turns the sweep red); and it **reports a tag carrying
no literal `id` by name** rather than skipping it, so a dynamic id makes the sweep fail loudly
instead of quietly under-reporting. `BackupPanel` draws `id="backup"` at two sites — the folder
variant and the archive variant — and those are one panel, which is why the sweep collects a set.

### The row, and why 999 against 1

The page root is `mx-auto flex max-w-4xl flex-wrap items-start gap-8 py-2`. The rail is
`flex-[1_1_232px]` and the pane `flex-[999_1_480px]`, so with the 32px gap **the row holds both
only while the content box is at least 744px** (232 + 32 + 480) and wraps below that. There is no
`sm:`/`md:`/`lg:` anywhere in it: `src/lib/viewports.ts` forbids a viewport branch outside
`AppShell`, and none is needed, because plain flex already puts the rail above the pane when there
is no room beside it.

**The grow ratio is what makes the wrap legible to the rail itself.** Free space is
`C − 744`, split by grow factor, so at any content box `C`:

| `C` | Where it comes from | Rail | Pane |
| --- | --- | --- | --- |
| 744 | The wrap point exactly | 232.0 | 480.0 |
| 761 | 1024px window, sidebar expanded, `main` scrolling | 232.0 | 497.0 |
| 776 | The same, with no scrollbar | 232.0 | 512.0 |
| 896 | `max-w-4xl`'s ceiling | 232.2 | 631.8 |
| 1024 | The imported design's 64rem, for comparison | 232.3 | 759.7 |

The rail sits at its 232px basis at every width the page can reach, to within a third of a pixel.
That is the point: **the rail decides whether it is beside the pane or wrapped above it by running
a container query off its own inline size**, and it can only do that if "beside" is one width and
"wrapped" — where the rail is the full width of the page — is always a much larger one. The
threshold is `@min-[260px]/rail`, and 260 rather than 233 because a threshold sitting a pixel off a
computed value flips the moment a scrollbar appears; there is nothing between 232 and the narrowest
page this app supports for it to catch by mistake.

**The imported design file's 1-against-3 would have broken that, and not only at the extremes.**
With a 3:1 split the rail is `232 + (C − 744)/4`, which reaches the 260px threshold at
**`C` = 856** — a content box the page has at roughly a **1119px** window with the sidebar
expanded, and at the **1024px** desktop floor itself with the sidebar collapsed (`w-17`, 68px,
leaves 901 and the `max-w-4xl` cap takes it to 896, where the rail would be **270px**). So on any
ordinary window the rail would have drawn as the *wrapped* chip strip while standing beside the
pane: not a state the query answers wrongly at one width, but a state it cannot tell from the
other one at all. At the design's own 64rem the rail would be **302px**.

**This is the first thing a reviewer will want to change back**, which is why the arithmetic is
written out here rather than left as a magic number.

### Why the container query is on the `<nav>` and never on the settings root

`container-type: inline-size` — what every `@container` in this app compiles to — applies **layout
containment**, and a layout-contained box is the containing block for every `position: fixed`
descendant under it, exactly as a `transform` is. This document already records that trap from the
other end: `FilterBar.tsx:1286` explains why that component's root is a **fragment**, so the
phone's filter sheet is the container box's sibling rather than its child.

Settings meets it from the inside. **Its panels mount their dialogs inline, and there is no
`createPortal` anywhere in `src/`** — verified 2026-09-03: `grep -rn createPortal src/` matches
nothing, and neither does `from "react-dom"`. The chain is `ConfirmDialog` → `Dialog` →
**`Dialog.tsx:333`**, which is a bare `fixed inset-0` scrim that corrects for nothing. No settings
file writes `fixed inset-0` itself, so grepping for that class in `src/features/settings/` finds
zero and is the wrong grep; **`ConfirmDialog` is the census**, and today it names four sites in
three panels — `CachePanel.tsx:54`, `DangerZonePanel.tsx:169`, `SyncPanel.tsx:1527` and
`SyncPanel.tsx:1552`. `SettingsNav.tsx`'s own comment names two of the four and the plan this
change came from named three, which is the usual reason not to write a list down: **the grep is
the fact, and a fifth panel that grows a confirm step joins it without anybody editing a
sentence.**

So a container box wrapped around the settings root would size every one of those scrims to the
**page box** instead of the window — a scrim covering the panel it came out of, and a confirm
dialog clamped to a column. The container therefore goes on the `<nav>`, which no panel is a
descendant of. **jsdom applies no stylesheet and computes no containment**, so nothing in the suite
can go red for the failure; what a test can pin is the structure — the container is that element,
and the panels are outside it.

The container is **named** (`@container/rail`) for `FilterBar`'s reason: `@container` variants bind
to the nearest ancestor container, so an unnamed one here would be what any future `@container`
inside a panel resolved against.

### Why not `useNarrowWindow()`

`src/lib/viewports.ts` demands a reason at the site of any viewport branch, and `useNarrowWindow`'s
own doc comment states the test to apply: **name the box the question is about, and if it is not
the window, this is not the mechanism.** `AppShell` passes that test because the shell *is* the
window. The rail does not — its question is whether the pane is beside it, which is a fact about
the rail's own box and about the page's flex bases, and a window-width branch would be a different
question that happens to agree today and stops agreeing the moment those bases move.

There is a second, blunter reason: `useNarrowWindow` is `(max-width: 390px)`, built from `PHONE_PX`.
It is a phone question and could not have answered this one at any width.

### `max-w-4xl`, and not the imported design's 64rem

The pane's measure is what decided it. At **64rem** the pane draws **760px** and these panels'
prose runs to about **106 characters** a line; at **`max-w-4xl`** (56rem, 896px) it draws about
**632px**, within **40px** of the `max-w-2xl` (42rem, 672px) column every one of these panels was
written for and drawn in until this change. The rail took width from the row, so the pane must not
also grow into it. The character figure is a typographic estimate from average character width at
the panels' body size — like everything else in this section, computed rather than measured.

### Driven in the shipped window, 2026-09-03 (debug build, `tauri dev`, Windows)

**The desktop floor clears the wrap point, and by half as much as the obvious sum suggests.** This
was the section's flagged risk and it is now read off the window. At a 1024px window with the
sidebar expanded (`w-52`, 208px): `main` is **816px**, its scrollbar **15px**, `clientWidth`
**801px**, and the content box **761px** after `main`'s `p-5`. The wrap point is 744, so the
clearance is **17px** and `wrapped` is false. The naive 776px sum — the one that ignores the
scrollbar — would have promised 32px. **17px is the true margin on the narrowest window this app
allows**, so anything that widens the sidebar, `main`'s padding or the rail's basis wraps the rail
on a desktop at the floor. It is the first number to re-measure after any of those.

| Measured | At | Result |
| --- | --- | --- |
| Rail width | 1920px window, `max-w-4xl` reached | **232.16px** (calculated 232.2) |
| Rail width | 1024px floor, content box 761px | **232.02px** (calculated 232.0) |
| Pane width | 1920px window | **632px** (calculated 631.8) |
| Wrap | 1024px floor | **not wrapped**, 17px to spare |
| Strip | 390×844 viewport | rail **335px**, `flex-direction: row`, `overflow-x: auto` |
| Strip scrolls | the same | `scrollWidth` **492** against `clientWidth` **335** |

**The container-query placement is confirmed by the failure it was chosen to avoid.** With the
Storage group open, `Clear cache`'s `ConfirmDialog` — mounted *inside* `main`, inside the settings
tree, with no portal — measured its scrim at **1280×800 at (0, 0)** against a 1280×800 window. It
covers the window exactly. Had the container gone on the settings root instead, layout containment
would have clamped that scrim to the 896px page box. This is the one claim in the section that
could only ever have been settled live, and it is the reason the `<nav>` carries the query.

**The strip costs 167px above the pane on a phone, which is more than the sketch promised.** At
390×844 the rail is **127px** tall — a 34px search box, a 53px strip, and the `Import.` footnote —
and `gap-8` adds 32 before the pane, so the first panel starts **167px** below the top of the page.
The wrapped full-width column this replaced would have been roughly **280px**. The strip is the
right call and it is not the ~90px a sketch suggested; the footnote and the gap are what the sketch
left out.

**Also driven, and correct — but this pass is 2026-09-03's, and the rail had six entries that
day.** **Appearance and its two panels landed on 2026-09-07 and have not been driven in the window
at all**, so nothing below was measured about them. What the pass confirmed: the six entries and
their panel sets, `web-storage` absent on desktop, `aria-current` on exactly one entry at rest and on **none** while the box has words in it,
the query cleared and `main.scrollTop` back to 0 on a group press, `Escape` clearing the field, a
cross-group search (`dropbox` typed while standing on Updates draws `backup-heading` and nothing
else — a word that appears nowhere in that panel's own text, so it is the keyword registry
answering), the `Nothing in Settings matches that.` line on a query that matches none, and both
badges with the written accessible name (`Sync (1)`, `Errors (2)`, forced through the live query
cache since this database has neither).

**Still not driven:** the sticky rail's behaviour under a long pane's scroll was not stepped
frame by frame, and nothing here was read on Android or in the browser build.

## The folder wall names its own folders (2026-09-03) — measured over the built CSS, not in the window

The Collection and Wishlist walls were rearranged from a Claude Design mock, and **the geometry it
promised was measured the same day**: 2026-09-03, in **headless Edge** (`msedge --headless=new`)
over the **built stylesheet** — `dist/assets/*.css` from an `npx vite build` — on a `file://` page
reproducing the wall's real markup. That is this repo's lock-free method, and it is what was
available: the app lock was held by another worktree for the whole session.

**So say the honest half first. This is not the shipped WebView2 window.** Nobody has driven the
change in the real app. What headless Edge over the real CSS *can* settle is what the boxes do,
and it settled it; what it cannot touch is anything with a reader's hand in it. A live pass still
owes this section three things, and only three:

- **Where the caret actually is** after each of the four ways out of the field — Escape, the ✕, a
  committed write, and an outside click that lands on something else. `useFolderFieldReturn`'s
  `document.body` test is reasoned, not observed.
- **The blur discard against a real pointer**, rather than against a synthesised `relatedTarget`.
- **A name long enough to need the truncation**, and how the field behaves under one.

### The wall does not reflow, and that is the central claim

The scroller was set at a **1032px content column** with `p-1.5` and the wall's own
`grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2` — five columns of ~197.6px — with one row
holding all four states side by side: the resting `New folder` tile, that tile naming, a resting
folder card, and a folder card renaming.

| Read back | Figure |
| --- | --- |
| Height, all four tiles | **62px** |
| `top`, all four | **30** |
| Width, all four | **197.59** (the resting folder card reads 197.61 — sub-pixel rounding of its own content) |
| The single-row scroller | **74px** — 62 plus `p-1.5` either side |

A tile becoming a field, and a card becoming a field, each keep the track and the row height
**exactly**. The 74px agrees with the rule `WishlistPage.tsx` already states about the band around
the wall — `max-h-44` is a **ceiling and not a height**, which is what lets a wall holding one row
be one row tall.

### The corner pair lands where the `⋯` lands

The folder card's `⋯` and both `✓ / ✕` pairs sit at **y = 34** — 4px down from the tile's own top,
which is `right-1 top-1` resolving against the `<li>` and not against the form. The pair is
**58px** wide (28 + a 2px gap + 28) against the `⋯`'s 28.

**And a name stops short of the tick rather than running under it**, on both shapes and by the
same margin: on the naming tile the input's right edge reads **366.19** against the tick's left
edge at **371.19**, and on the renaming card **777.39** against **782.39** — **5px** clear each
time. That is what `pr-[4.125rem]` buys: 66px = `right-1`'s 4 + 28 + 2 + 28 + 4. It is the figure
that would go wrong first if anyone rewrote that literal as arithmetic, which Tailwind would
answer by emitting no rule at all.

### The vocabulary rule holds in computed style, not only in source

`border-style` computes **`solid`** on the resting `New folder` tile *and* on the naming tile, and
**`dashed`** on the resting folder card *and* on the renaming card. The dashed-means-provisional
rule is therefore a fact about the built CSS rather than about the classes somebody wrote.

Two utilities were confirmed to **emit**, by grepping the built CSS: `caret-accent` resolves to
the gold `oklch(0.75 0.12 85)`, and `pr-[4.125rem]` emits `padding-right:4.125rem`. Worth
recording only because a Tailwind utility that emits nothing fails completely silently — which is
this page's standing reason for checking `dist/` rather than source.

### What it replaced, and why the old arrangement was wrong

Both pages used to answer `New folder` and `⋯ → Rename…` in a **bordered strip under the
breadcrumb**: a box with its own edge and its own background, an input, `Create folder` and
`Cancel` spelled out in words, and — on a create — a line reading *in Collection* (or
*in Wishlist*) to say which level the strip was about.

Every one of those pieces re-established a context the reader could already see. The level is the
wall they are looking at; the thing being named is going to appear in it; the thing being renamed
is a tile with its name printed on it. So the strip spent a second panel's worth of screen saying
what the wall says by being on screen — and it said it **somewhere else**, one navigation band
away from the tile the press came from. It could also outlive its own subject: a create panel
opened at one level survived a walk into another, and both pages already carried a
`flatten ? null : panel` clause precisely because the same staleness had been found once before.

### The tile says it by being the tile

`components/FolderNameField.tsx` is the one field, drawn **as** the tile. The name is typed on the
line the folder's name will occupy; `⋯`'s corner takes ✓ and ✕, which is the one place on a card a
reader has been taught to find its controls; nothing above the wall opens and nothing in the wall
moves. Neither shape draws a heading, a hint or a word on its buttons — an input on a folder tile
with a tick beside it is not a sentence that needs writing out — and the *in …* line is gone
because the wall the field is drawn in **is** that sentence.

**Two shapes, and the border is the whole of what tells them apart.** The app's
dashed-means-provisional rule decides which: `create` stays **solid**, because the tile is still a
control and holds no folder yet; `rename` stays **dashed**, because the thing being renamed is
already a container. Both wear `border-accent` while open, and that colour is the whole of what
says *this tile is live*. A rename also keeps its **figures line** under the field, which is why a
rename is not simply the create tile with a different label: a reader renaming *Trade binder* is
looking at the drawer holding 240 cards, and a box that dropped the count would make them check
they had the right one.

### The footprint is inherited, and the row above is what re-proved it

`FOLDER_CARD_HEIGHT` — `min-h-[calc(3.75rem+2px)]` — **moved out of `NewFolderCard.tsx` into
`FolderNameField.tsx`**, because the naming tile needs it too: a tile that shrank the moment it
became a field would reflow the wall on every press, which is the one thing the whole arrangement
promises not to do. Its derivation is the older measurement and is unchanged — a folder card's
button computes **62px** in headless Chromium over Tailwind's compiled utilities at the wall's
real track, and `calc(3.75rem + 2px)` rather than a flat `3.875rem` because the two 1px borders
are the one term in that sum that does not scale. The four-state row above is that number read
back a second time, in a second browser, with the field open — which is the reading the move
needed. The constant travels **to** the field rather than from it because the tile renders the
field, so the other direction would be a cycle.

Two geometry decisions ride on it and the same pass settled both. The ✓ / ✕ pair is absolute
against the **`<li>`** rather than against the form, since a `<form>` with no positioning
establishes no containing block — and the pair lands at the same `y = 34` on a naming tile as on a
renaming card, whose boxes are different heights, which is the thing that would have failed had it
resolved against the form. And `h-full` is on the **create** shape alone: the `<li>` is the grid
item and stretches to the tallest card in its row, so a naming tile sized only by its own floor
would shrink beside a card with a long wrapped name, while a rename must *not* stretch, because
the folder card it replaces is content-height. The row's four equal heights are that arrangement
holding at one row's worth of content; a **wrapped** name in the row is one of the things the
pass did not put in front of it.

### What it costs

**A layer whose opener does not survive it**, which is the focus-return entry earlier on this page
and the one genuinely new mechanism here.

**A level clause on both pages' `openPanel`.** `flatten ? null : panel` became
`flatten || (panel?.kind === "newFolder" && panel.parentId !== folderId) ? null : panel`. Without
it, walking into another folder with the field open leaves a layer with no field on screen at all
— invisible, and still swallowing the Escape that should have walked the reader back out. Where
the strip was merely *confusing* about which level it meant, nothing is worse.

**A drag source that has to stop being one while it is a field.** The renaming card's `<li>` is a
folder drag source, so the field's `<form>` carries `data-no-drag` on its root — `NOT_A_DRAG` is
matched with `closest()`, so one mark covers the input, the tick and the cross. Without it,
pressing into the name and moving five pixels files the folder somewhere instead of placing the
caret, and the press that was meant is never delivered. The card's **drop** targets are left
registered on purpose: a copy dropped onto a folder whose name is being edited files perfectly
well, and tearing the targets down would make the wall answer a drag differently depending on a
state the dragger cannot see.

**And the strip does not go away.** It survives for `Move to folder…` and `Delete…`, which is the
right residue rather than a leftover: the answer to "into which folder" is a list of the *other*
folders, and the answer to "delete this?" is a sentence about what happens to the cards inside.
Neither is a name typed on a line, neither has a tile of its own, and neither fits on a 62px card.

## One quantity control on a card face, on all three surfaces (2026-09-03, issue #348)

The report was that the wishlist's stepper "does not match the style or location of the
corresponding control in the deck builder", and that the collection had none at all. **The second
half had been fixed the day before the issue was filed** — the walls grew steppers on 2026-09-01
(issue #284) and shipped in **v0.19.0**, so the reporter was on v0.18.0 or earlier. The first half
was still true on `main`, and this is what it was.

### What actually differed

Driven in Storybook (2026-09-03, 1400×900, dark) across `decks-editor--four-views`,
`wishlist-page--copies-from-a-tile` and `collection-page--stepping-from-the-wall`. All four
surfaces already drew the same `QuantityStepper`; what differed was the arrangement.

| Surface | Size | Orientation | Where |
| --- | --- | --- | --- |
| Deck — Stacks (the default view) | `card`, 36px | vertical, `+ / n / −` | the card's right margin, `top-9` |
| Deck — Grid | `xs`, 20px | horizontal | a centred bar directly above the chin |
| Wishlist wall | `xs`, 20px | horizontal | right-aligned in the bottom strip, beside the pencil |
| Collection wall | `xs`, 20px | horizontal | right-aligned in the bottom strip |
| Wishlist / collection **tables** | `sm`, 28px | horizontal | the Copies cell |
| Deck table | `xs`, 20px | horizontal | the Qty cell |

**One thing this survey corrected in a claim made mid-task**: the walls were described as drawing
their stepper *always*, against the deck grid's hover reveal. They do not — `CardGrid`'s action
strip has carried `REVEAL_ON_HOVER` since it was built, so every wall stepper was already revealed
on hover and on `:focus-within`. Measured on an unhovered tile: `opacity` **0**, and **1** on the
focused one. The reveal was never a difference and nothing about it changed.

### What was done

The two walls took the deck stack's arrangement: `size="card"`, `orientation="vertical"`, over art,
standing in the tile's right margin. `CardGrid` grew a **`column`** slot for it — its own slot
rather than a second thing hung in `action`, because the strip is a `justify-end` *row* at the foot
(the wishlist still has its pencil in it) and a column up the right-hand side is different geometry
with a different collision list. Both tables moved `sm` → `xs`, which is the app's size for a
stepper in a dense row and what the deck's own table and text views draw; both tables are 44px rows
(`TABLE_ROW_HEIGHT`) and the stepper is 80px in a 112px cell, against the deck table's 80 in 104.

### The geometry, measured

Read off the live boxes rather than computed:

- **The column rests at 30.6 × 98.6px** on a 170px tile whose art box is 238px (5:7) — three 36px
  boxes and two 4px gutters, times `CONTROL_SHRINK`'s 0.85. That is **18 % of the tile's width and
  41.4 % of its height**, starting **24px** down with a **4px** right gutter and **115.4px** of
  clearance above the chin. On the deck's own 210×293 card the same column is 15 % and 34 %.
- **Both percentages are constants across the whole ladder, not readings at 1×.** At 0.5× / 1× / 2×
  the art box is 85×119 / 170×238 / 340×476 and the column 15.3×49.3 / 30.6×98.6 / 61.2×197.2 —
  18 % and 41.4 % at every stop, because the tile, the art and the column are each linear in the
  same zoom. At `PHONE_TILE_WIDTH`'s 141 it is 22 % of the width, which is the first figure to check
  if the column is ever made bigger.
- **It clears the finish chip at every stop, and that is why the offset is on `--mark-scale` rather
  than flat.** The chip is 8 / 16 / 32px tall at those three stops and the column starts at
  12 / 24 / 48, so the gap is **1 / 3 / 7px** — narrowest at the bottom of the ladder and incapable
  of inverting. The deck stack's own offset is a flat `top-9`, which is right *there* because that
  card's title bar does not scale either.
- **It never reaches the pencil.** 45.5 / 91 / 182px of clear air between the column's foot and the
  wishlist's `EditWishButton` at the three stops.

### `pointer-events` follow the reveal, and here that is load-bearing

The action strip's arrangement is `pointer-events-none` on the box with `[&>*]:pointer-events-auto`
on what it holds — so the *control* stays pressable while invisible, which that file's own comment
records as a known cost and an open question on a touch screen. That trade is affordable across a
20px strip and is **not** across this column: at ~99px tall on a 238px face it would put an
invisible stepper under the right-hand third of every card, and a finger has no hover to reveal it
with. So the column gates the whole box instead —
`pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto`. A
mouse loses nothing, because the pointer that reaches the column has already revealed it by being on
the tile; a touch screen gets back the press that opens the card, which is the only gesture it had
there. `pointer-events` is inherited, so gating the box gates the column inside it and no `[&>*]`
arm is needed — its **absence** is asserted in `CardGrid.test.tsx`, so a later tidy-up cannot
restore the strip's recipe by resemblance.

**jsdom does no hit testing and applies no `:hover`**, so nothing in the suite can go red for any of
this; the classes are pinned and the numbers come from a browser.

### What was left alone, and why

- **The deck's Grid view drew `tone="panel"` over art**, so its two buttons were a 1px outline
  with the illustration showing through — the exact failure `BUTTON_OVER_ART` exists for. It was a
  real defect and it was in the deck builder, which is the *reference* this issue asked the walls to
  be measured against, so fixing it belonged to its own change rather than to one about the walls.
  **It was closed on 2026-09-08 as a side effect of that change rather than by anyone aiming at
  it**, which is the shape worth noticing: the tile draws the stacked card's controls now
  (`DeckCardControls layout="card-column"`), and `card-column` is the layout that passes
  `tone="art"` — so the buttons carry `BUTTON_OVER_ART`'s `bg-bg/88` backing because they are the
  stack's buttons, not because a second decision agreed with the first. The entry stays as the
  record of a defect that stood for a fortnight and of what it took to remove it. **Nothing has
  been driven in the shipped window to confirm the backing paints**; the class comes from the
  layout by construction, and the pixels are still owed.
- **Issue #348's other three asks** — add/remove cards on the collection, changing a printing, and
  locking a folder that a deck's live list is linked to — are separate features. Stepping to zero
  already deletes a collection entry, so "remove" exists there without a named route on the wall.


## The focus outline that appeared on any keystroke (2026-09-03)

Reported as: *"whenever we click a button, the app seems to highlight / focus random elements on
the page — this is almost no matter the button (wasd, space, other letters etc.)"*, with five
screenshots — the card detail modal ringed in gold, the printings modal, the sidebar's `Search`
row, and the deck editor outlined right down past the fold.

### `:focus-visible` is modality-based, not navigation-based

The name promises "focused, and the reader got here by keyboard". It does not mean that. Chromium
arms the pseudo-class on **any** `keydown` and from that moment whatever *already* holds focus
matches — the focus never has to move. Measured in Chromium 2026-09-03 against a two-element page,
one `<button>` and one `tabIndex={-1}` `<div>`, reading `activeElement.matches(":focus-visible")`:

| step | action | matches |
| --- | --- | --- |
| A | mouse click on the button | `false` |
| B | programmatic `.focus()` on the `tabIndex={-1}` div | `false` |
| C | **press `w`** — focus never moved | **`true`** |
| D | mouse click again | `false` |

Step C is the entire bug, and it explains every screenshot: a reader clicks a card, the dialog
opens and focuses its own `tabIndex={-1}` panel (step B), then presses any key at all (step C).
Nothing in `src/` was at fault — the app had **no** `focus:` variants anywhere, only
`focus-visible:`, which is the correct spelling and was already the fix for the mouse case.

### The rule that replaced it

**Focus is keyboard-driven when it *moved* and the reader's most recent input was a key.**
`src/lib/keyboardModality.ts` decides that at one moment — `focusin` — rather than continuously
off a flag any keystroke can flip, and publishes `data-kbd` on `<html>`.

Two things fall out of it that a key allowlist does not give:

- **No list to maintain.** `Shift+F10` onto a context menu's first row and `F1` onto the key map's
  button both move focus, so both are covered without an entry; so is any shortcut added later.
  The first key forgotten from an allowlist would be a reader arrow-keying a menu with no visible
  caret — a WCAG 2.4.7 failure, which is the direction worth engineering against.
- **No timer.** An earlier draft opened a "steering window" on `keydown` and closed it a frame
  later so a focus React committed after its passive effects still counted. That is a number that
  has to be right; the modality simply persisting until the reader's next input is not.

### One line gates every outline in the app

`src/index.css` redefines Tailwind's own `focus-visible` variant rather than introducing a new
name at the call sites. Confirmed against the built stylesheet — **every** `focus-visible:` utility
the app emits is rewritten, including the composed `group-focus-visible:` form nobody edited. Grep
`dist/assets/*.css` for `data-kbd` for the current set; a count here would be a fact about one tree:

```
.focus-visible\:outline-2:is(html[data-kbd] *):focus-visible
.focus-visible\:ring-accent:is(html[data-kbd] *):focus-visible
.group-focus-visible\:opacity-100:is(:where(.group):is(html[data-kbd] *):focus-visible *)
```

Two things the variant cannot reach, both handled beside it:

- **The user agent's own `:focus-visible { outline: auto }`** runs off the browser heuristic and no
  Tailwind rewrite touches it. Without the `html:not([data-kbd])` base rule the fix would have read
  as a *recolour* — the gold outline swapped for the platform's blue one, on the same keystroke.
- **`PriceRange`'s thumb**, which spells the pseudo-class inside an arbitrary variant — a string
  the component wrote, not the variant Tailwind owns. It gets the named `focus-thumb` variant, and
  `keyboardModality.test.ts` sweeps `src/` so a second component cannot reintroduce the shape.

**A `@custom-variant` this Tailwind mis-parses emits nothing, silently, with `tsc` and the whole
suite green** — the standing warning at the head of `index.css`, and it applies double to an
*override*, where the built-in simply stays and the bug returns looking exactly like the fix. So
the suite compiles the declarations out of `index.css` against real Tailwind through its `compile`
API and reads the selectors back. Both halves were mutation-tested: writing the attribute on
`keydown` reds *"stays quiet when a key moves no focus"*, and dropping `[data-kbd]` from the
variant reds *"makes every focus-visible: utility require the keyboard attribute"*.

### Eleven landing pads lost their outline outright

The second half, and it is a different question from *when*: some elements should carry no focus
outline in **any** modality. A `tabIndex={-1}` container that exists only so focus can be *put*
somewhere — instead of dropped on `<body>`, where the next Tab restarts the tab order — is a
landing pad, not a control. A reader can neither Tab nor arrow onto one, so the ring states
nothing, and what it draws is the whole modal or the whole editor ringed in gold.

`Dialog`'s panel, `CardDetailPane`, the deck editor's root, `AnchoredPopup`, `DeckBracket`,
`ValidationPanel`, `MoveToFolder`, `PickCopies`, and the delete confirmations on `DeckTile`,
`DecksPage` and `CollectionPage`.

**Ten of them by the end of the same day**, and the heading is left at eleven because that is what
was measured: `CardDetailPane` was deleted for the card modal hours later. Nothing was undone by
that — the modal is drawn by `Dialog`, whose panel is the first name above, so the pane's entry
was absorbed rather than lost.

**The line is drawn at "can the caret move *from* here", not at `tabIndex`.** A deck pile's section
(`deckGroupProps`) and the printings dialog's rows are `tabIndex={-1}` too and keep their marks,
because the caret landing on one is a fact the *next* keypress depends on. Menu rows, table rows,
cards in a wall and grid tiles are all roving targets and all keep theirs.

### Driven in a browser, against the built stylesheet

The app lock was held by another worktree, so this was verified lock-free: a `file://` page over
the real `dist/assets/*.css` and the real module through `esbuild`, driven with real mouse and key
events. `getComputedStyle(el).outlineStyle` on four elements after each step — a real control, a
roving target, the shipped panel, and a copy of the panel still carrying the old class string:

| step | action | `data-kbd` | control | roving | panel | panel *(old class)* |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | mouse click on the control | `false` | — | — | — | — |
| 2 | **press `w`** (the report) | `false` | — | — | — | — |
| 3 | click a card → dialog focuses its panel | `false` | — | — | — | — |
| 4 | **press space** inside that modal | `false` | — | — | — | — |
| 5 | press `Tab` | `true` | **ring** | — | — | — |
| 6 | arrow onto a card | `true` | — | **ring** | — | — |
| 7 | click the control the caret was already on | `false` | — | — | — | — |

Step 4 is the reported flow and paints nothing. The pair worth reading twice is the panel columns
under a keyboard-driven caret: identical conditions, ring on the old class string and nothing on
the shipped one — which is the eleven-site half doing work the modality gate alone does not.

### What was deliberately left alone

`TooltipProvider.focus()` guards on `anchor.matches(":focus-visible")` in JS and still asks the
browser rather than the new attribute. It was checked rather than assumed: both answers key off
"was the reader's last input a key", and a `pointerdown` resets both, so they agree in every
reachable case — the divergence is only *when* the answer is applied, and that guard runs on a
`focus` event, which is the one moment they cannot differ. Rewriting it would have destabilised a
well-tested subsystem for no behaviour change.

## The deck gallery gained a colour bar and a filter row (2026-09-07, issue #387)

The wall said four things about a deck — its art, its name, what format it is, how big it is —
and one thing about its illustrator. The two facts a reader actually browses a wall of decks by,
**what colours it is** and **what bracket it is**, were reachable only by opening it. Both are on
the tile now, the credit line came off it in the same pass (the art-crop bullet above carries the
policy reading that made that legitimate), and the wall gained a way to be narrowed and ordered.

`docs/superpowers/plans/2026-09-07-deck-gallery-overview.md` is the design.
[decks-storage.md](decks-storage.md) has the two reads behind the bar and the bracket;
[commander-brackets.md](commander-brackets.md) has what the gallery's estimate can and cannot
see. This section is the drawing.

### The bar: five pixels, six tokens, and two silences

`DeckColorBar` sits **inside the tile's `<button>`**, between the crop and the name, which is the
order the tile is drawn in and the order an eye reads it — art, colours, name, caption. Being
inside the button is also what puts its accessible name into the button's own, in that same
position.

- **Height 5px at 100%, `margin-top` 4px, both written as
  `calc(<rem> * var(--mark-scale, 1))`** — the arrangement the tile's other four sizes already
  use, and `cardZoom.ts`'s reason for it: the variable is set once on the tile's root and every
  mark inside inherits it, so nothing is threaded down. 5px is between Tailwind's `h-1` and
  `h-1.5`, which is why it is spelled as a number rather than as a utility: **4px is lost against
  the rounded edge of the crop above it** and **6px starts to read as a band competing with the
  deck's name** rather than as a rule belonging to the picture. The 4px above the bar is half the
  8px below it for the same reason — the bar is a fact about the cards, drawn as part of the
  picture, so it hugs the art and leaves the name its own air.
- **The fills are `--color-pie-w/u/b/r/g/c` and nothing else.** These are the same deeps
  `DeckStats`' identity pips draw with (`PIP_COLOR` plus its `COLORLESS`), keyed over all six of
  `MANA_KEYS` rather than the five of the mana *line*. **A colour in this app is a `--color-*`
  custom property and nothing invents one**, so the bar and the same deck's identity pie are two
  drawings of one fact and could not come apart without somebody editing `index.css`. The table
  is a `Record` with `var(…)` spelled out per key, **never a class built from the key**: Tailwind
  scans source text for whole class names, so an interpolated `bg-pie-${key}` emits no rule at
  all and the bar would draw six transparent segments with nothing going red.
- **Segments are in `MANA_KEYS` order — WUBRG then colourless — and sized as a percentage of the
  deck's total pips**, so the bar is correct at every width the zoom ladder produces without
  anything measuring a box. `overflow-hidden` and `rounded-full` on the parent are what make the
  pill's ends belong to the *bar* rather than to the first and last colour.
- **A colour with no pips draws no element, not a zero-width one.** The two are the same pixels
  and they are not the same DOM: a zero-width `<span>` is something a test can find, a
  `querySelectorAll` counts and a later `:first-child` rule can style, standing for a colour that
  is not in the deck.
- **`null` and an all-zero record both draw nothing at all.** `null` is the read still out; all
  zeroes is a pile of lands, or of nothing but generic costs. An empty grey rule says "this deck
  has no colours" in the same vocabulary a full bar uses to say what they are, and a reader
  cannot tell that from a rendering fault or from a bar still loading. The tile simply sits 9px
  shorter, which is what every tile looked like before this component existed — the same argument
  the theory badge and the caption's `Any` row already make about a mark that would sit on nearly
  every deck.

**The bar is `aria-hidden`, and the colours are said in an `sr-only` span after the deck's name**
— `White, Green`, in printed order, which is how a player says a deck's colours out loud, off
`deckPips`' `deckColorsLabel`. (**Corrected 2026-09-08.** This paragraph said `role="img"` with an
`aria-label` of the colours, which is how the bar was written first and is *not* what shipped:
named here, the span joins the tile button's own accessible name ahead of the deck, so the tile
came out `"White, Red Zoo …"` and `getByRole("button", { name: /^Zoo/ })` matched nothing. The
correction is the drawing's, not the words' — the same colours, said one element down.) The
arithmetic goes in the tooltip (`White 11, Green 8`), one vocabulary at two depths rather than two
ways of saying one thing. The tooltip is bound `describes: false`, and that is a fact about where
the element sits rather than a preference: the span is not focusable and lives inside a button
whose name is computed from its contents, so an `aria-describedby` wired here would be announced
to nobody.
(Note the trap this repo has recorded — a `describes: false` tooltip carries no `role="tooltip"`,
so probing for that role finds nothing on a tooltip that is working.)

**The test handle is an attribute, `data-deck-color`, and it carries the colour key as its
value.** `FolderDropLine`'s `FOLDER_DROP_LINE_ATTR` and `DropIndicator`'s `DROP_LINE_ATTR` are
the shape it borrows, and the value is load-bearing rather than convenient: jsdom applies no
stylesheet, so a class assertion would be a check on source text, and **which** colour a segment
is drawn for is the fact under test — a segment in the wrong place is the bar telling a reader
their mono-blue deck is green.

### The caption gained a fourth segment, and it still truncates

`{format} [· {game}] [· {bracket}] · {n} cards` — `Commander · Bracket ~3 · 100 cards`. The
bracket obeys the caption's existing rule from the other end: drawn only where there *is* one,
which is a format with a command zone whose number has arrived. A `null` covers both "this deck
cannot have a bracket" and "nothing has answered yet", and the caption treats them alike, because
a placeholder for the second would be a segment appearing a beat after the wall does.

**The truncation in a narrow column is the existing behaviour and is correct.** A fourth segment
makes it likelier, and the answer is neither a shorter format name nor a wider tile: the caption
is the tile's least important line, it truncates from the end, and the deck's name above it is
what a reader is scanning.

### The filter row: five controls, and one of them is not a filter

Beneath the heading row, wrapping, reading left to right as one sentence about the wall below it:
everything that decides **which** decks are on it, then — past an `ml-auto` — the pair that
decides **what order** they are in. That is the division `FilterBar` draws with a hairline on its
own row, borrowed without the hairline, because a divider is the one item in a wrapping row that
can end up alone on a line saying nothing.

- **`flex-wrap` is not optional.** The wall's column is `flex-1` beside the 208px folder rail, so
  at the app's own 1024px floor the row has far less width than its contents. The source's
  `~548px` was arithmetic off the shipped widths when it was written; **it has since been driven
  and is the measured figure** — 2026-09-07, `npm run tauri dev`, a debug build at 1024 × 700
  against the real corpus, three decks on the wall: the row's column read **548px** exactly, the
  row itself laid out on **one** line at `y = 192` (the heading row above it at `y = 140`), the
  name box `x = 456, w = 352`, the `Sort decks` trigger `x = 823, w = 126` and the direction
  arrow `x = 953, w = 36` — a right edge of **989** inside the column's **1004**. And the thing
  the wrap exists to prevent was absent: `documentElement.scrollWidth` **1024** against a
  `clientWidth` of **1024**, so no horizontal scrollbar at the floor. A flex item cannot shrink below its own min-content,
  and the column is `overflow-y-auto`, which computes `overflow-x` to `auto` — so an unwrapped
  row would hang out of the column and turn into a horizontal scrollbar across the whole gallery.
  Wrapping makes the row's min-content one control.
- **The name box is `FILTER_FIELD` and never `FILTER_CONTROL`.** The chips dip 3% under a press
  and a box the reader types into must not, or the native ✕ of an `<input type="search">` slides
  out from under the pointer clearing it and the box bounces without emptying — issue #179, whose
  whole measurement lives on the constant. It is labelled **`Filter decks by name`** and never a
  bare `Filter`: the deck editor already owns a box called *Filter this deck*, and two controls
  with one name cannot be addressed unambiguously by a screen reader, by voice, or by a
  `getByLabelText`. Escape empties it while there is something in it and falls through when there
  is not, which is load-bearing on this view rather than a courtesy — the gallery binds Escape at
  the `"navigation"` rung to walk one folder up, so without the guard one press in a filled box
  would clear the filter *and* take the reader out of the drawer they were narrowing.
- **The format chips are faceted, and drawn only where there is more than one.** A chip for a
  format no deck on the wall is in is a control whose only possible outcome is an empty wall; a
  *lone* chip can do exactly two things, leave the wall as it is or empty it, so it is a control
  whose only effect is the bad one. The count rides `title`, which `ToggleChip` makes both the
  tooltip and the accessible name, so a chip reads *"Modern format, 3 decks"* while still
  beginning with the word printed on it (WCAG 2.5.3) — the search's Owned chip's arrangement.
  (**Corrected 2026-09-08**: this line said *"Modern, 3 decks"*, and the word `format` in the name
  is load-bearing rather than filler. Without it a chip is named `Commander, 1 deck` and so is the
  tree row for a *folder* somebody called Commander holding one deck — a name a Commander player
  is very likely to use. A story going red is what found it, and it is the third entry in the
  naming series the 2026-09-08 section below tabulates.)
- **The `Archived` chip replaces the disclosure's own button and is still a disclosure.** It
  carries `aria-expanded`, not `aria-pressed`, which is why it is built out of the chip family's
  recipes instead of being a `ToggleChip`: "this filter is on" and "the thing below is open" are
  two different sentences, and a reader told the wrong one goes looking for a wall that is not
  there. It keeps its turning chevron for the same reason — every other chip in the row narrows,
  this one *reveals*. The second wall stays exactly where it was, a `<ul aria-label="Archived
  decks">` under the first. The chip is gated on whether the drawer holds filed decks **at all**
  rather than on how many survive the filter, so it cannot vanish out from under a reader
  narrowing the wall — `features/search/facets.ts`' rule, that an option which disappears reads
  as a control that broke — while the number *on* it counts the tiles actually behind it.
- **`Sort decks`, and never shortened to `Sort`.** The deck editor's toolbar already has a
  `Sort`, and it sorts the cards *in* a deck. `FilterBar.tsx:928-944` writes that argument out in
  full about `Sort results`; this is the same call. The picker is **never gold**: accent on a
  picker means "this is not where the control opens", which is a state a *filter* can be in — a
  wall is always in some order, so a gold sort picker would claim a filter is on about the one
  control in the row that is not one. Picking a key also sets its direction from `NATURAL_DESC`
  rather than carrying the previous key's over, which would open `Name` at Z.
- **One arrow, turned half a turn — never `ArrowDown` swapped in for `ArrowUp`.**
  `SortableHeader.tsx:51-55`'s rule and `FilterBar.tsx:975`'s reason: a different element in the
  same slot is unmounted and remounted, so the indicator *teleports*, and the whole of what the
  press means is that the order reversed. `initial={false}`, so a wall that opens descending —
  which is the default — draws its arrow already turned rather than spinning on first paint.
  `rotate` is a transform prop, so `MotionConfig reducedMotion="user"` reaches it and no
  `useReducedMotion` opt-out is owed ([motion.md](motion.md) — that trap is about the
  *non*-positional properties, and this animates none). The `flex` on the animated span is
  load-bearing rather than decoration: a bare `<span>` is a non-replaced inline box, a transform
  does not apply to one at all, and the rotation would silently do nothing.

**The sort is remembered across restarts and the filter is not**, which is the one thing about
this row that is a product decision rather than a drawing one. An order is how a reader likes to
read their gallery and it is visible in the toolbar the moment they open it; a filter is a thing
they are doing *right now*, and a gallery that opened already narrowed, with no memory of having
asked for it, is a gallery that looks like it has lost decks.

## The deck gallery redrawn: a fused band, marks on the art, tile-format folders, a drawn tree (2026-09-08)

The wall the section above describes had been on screen for a day. The redesign (commit
`669de894`, from the approved design canvas, iteration 1d) redraws four of its objects and
collapses one control: the colour bar becomes the tile's foot, the theory badge and the bracket
become two marks on the art, a folder card becomes a deck tile's frame, the folder tree draws its
nesting, and three folder verbs in the heading row become one menu. `DeckColorBar.tsx`,
`DeckTile.tsx`, `FolderCard.tsx`, `FolderTree.tsx`, `DecksPage.tsx` and `panels.ts` under
`src/features/decks/`, plus a prose correction in `src/lib/dropMarks.ts`.

**Say the honest half first: everything down to the last subsection is the design _as
authored_, read off the source** — every size is what the file says rather than what a box
measured, and the one live figure quoted among them is the previous section's ~548px column,
measured 2026-09-07 in a debug build at 1024 × 700. **The last subsection is the pixels**, taken
2026-09-08 over CDP in the shipped `tauri dev` window at 1920 × 1080 against a copy of the real
database. Read it before trusting a number above it: it found one defect that every suite in this
repo was structurally blind to, and it is where the measured figures live.

### The bar became the tile's foot: the fills, a printed symbol, and a floor that scales

A 5px pill floating 4px under the crop, filled with the colour-identity deeps, is now a **20px
band fused to the crop's bottom edge**, filled with the **mana fills** and carrying each colour's
printed `mana-font` glyph.

- **The switch from `--color-pie-*` to `--color-mana-*` is the change worth carrying away, and the
  band is what forced it.** `index.css` states both families at the token: the deeps are
  "saturated enough to carry meaning at 1px", which is exactly the demand a hairline makes, and
  the fills are "the five colours, as printed symbols are filled … Glyphs sit on these in
  near-black, exactly like a real symbol". A 20px field with a black symbol printed on it makes
  the second demand rather than the first — `ms-b` in near-black on `--color-pie-b` (**#3b3a3e**)
  is a black glyph on a near-black field, invisible, on the one colour a reader is likeliest to be
  checking for. So the band is not a new arrangement: `FilterChips.tsx`'s `ManaChip` already ships
  this pair character for character, `text-black` over an inline
  `backgroundColor: var(--color-mana-…)`, and the band is the app's existing arrangement at a new
  size.
- **What the two families no longer share is `DeckStats`' `PIP_COLOR`.** The tile's band and the
  editor's identity pie now answer with different families, and that is the honest reading rather
  than drift: a pie slice is a colour with nothing printed on it, a band segment is a field with a
  symbol on it, and those are two demands the palette has two answers for. The table stays a
  `Record` with `var(…)` spelled out per key — an interpolated `bg-mana-${key}` emits no rule at
  all, which is `src/CLAUDE.md`'s standing rule and the same trap the old table was written around.
- **Four numbers, each answering a different question.** 20px of height at 100%
  (`calc(1.25rem * var(--mark-scale, 1))`), which is what a 12px glyph needs with air either side
  — the symbol sets the floor, the band is not a thickness anybody chose. **26px of minimum width
  per segment**, because a splash colour at 3% of a deck's pips is a segment a glyph cannot be
  drawn smaller for: there is no smaller version of a printed symbol. **2px between segments, as a
  `gap` and never a border**, so what shows through is the band's own `bg-surface` rather than a
  line this component picked a colour for — and a seam is what stops `--color-mana-b` (#cbc2bf)
  and `--color-mana-c` (#c8c4bf) reading as one field on an Eldrazi deck. **`rounded-b-lg` against
  the crop's `rounded-t-lg`**, one 0.5rem, and neither radius scales, which is this app's standing
  rule for a Tailwind corner.
- **The 26px floor scales with `--mark-scale` rather than being a fixed pixel, and that is what
  keeps five colours inside a tile at 0.5×.** A fixed floor is six minimums summing against a tile
  that has shrunk; a scaled one shrinks with the box it is inside. `overflow-hidden` on the band
  is the backstop for the case where they still do not fit, and clipping the last segment is the
  better failure than a band wider than the picture above it.
- **A `border-t` in `bg-bg/60` sits between the crop and the band** — the page colour at 60%, so
  the band is separated from the picture rather than washed into it. A band flush against a crop
  full of dark art loses its own top edge; the hairline is what says crop and band are one object
  rather than one bleeding into the other. There is **no margin at all** above the band, and
  `DeckTile`'s own comment fences that: an element, a margin or a gap introduced on the button
  between the two would put a hairline of page between a picture and the band it belongs to.

**The band draws on every deck, and the conditional it needed lasted one day** (corrected
2026-09-08 — see *The three sizes the reader sent back*, below). It shipped returning `null` for
both silences, with a `hasColorBar(pips)` predicate exported so that `Cover` could take it as
`fused` and draw the crop `rounded-t-lg` or `rounded-lg` — the right shape for the rule as it then
stood, and the reasoning against writing that condition twice still holds in general: the symptom
of a disagreement is a **radius**, which jsdom cannot see at all. What was wrong was the rule, not
the plumbing. The band always draws now, empty where the deck has nothing to say, so the crop is
`rounded-t-lg` unconditionally, there is no question for a call site to answer, and both the
predicate and the prop are gone.

**The band stays `aria-hidden` and the printed symbols make that more true, not less.** A
`mana-font` glyph is a `content` on an empty `<i>`'s `::before`: it reaches a screen reader as
nothing, and under jsdom the element has no text either. A band that dropped `aria-hidden` would
announce six empty elements and still name no colour. The words stay in the `sr-only` span after
the deck's name (`deckPips`' `deckColorsLabel`), and the counts stay in the tooltip. That also
leaves `data-deck-color` the only honest handle on a segment — the classes on the glyph are
assertable as *source text* and are asserted that way, but which colour a segment is **for** is
the fact under test.

**A correction to the section above, in passing:** its paragraph beginning "`role="img"`, and the
accessible name is the colours and nothing else" describes an iteration that did not ship. The bar
has been `aria-hidden` with an `sr-only` twin since it landed on 2026-09-07 — with `role="img"`
and an `aria-label` the tile's accessible name came out `"White, Red Zoo …"`, so
`getByRole("button", { name: /^Zoo/ })` matched nothing and a voice user could not say "click
Zoo". That paragraph is corrected in place; the rest of it — the tooltip's vocabulary, and
`describes: false` being a fact about where the element sits — was and is true.

### Two marks on the art, in a box that is the art

The theory badge moves from the crop's top-left to its **bottom-left**, a `BRACKET ~3` pill joins
it at the **bottom-right**, and the bracket **leaves the caption**, which is back to the three
terms that describe the *list*: `Commander · Paper · 100 cards`. The caption was the wrong home
for it — the tile's least important line, truncating from the end, in a column narrow enough that
a fourth segment is the segment that goes — and a bracket is the one number on the tile a reader
compares decks by.

**The mechanism is the part to document, because it reconciles two constraints that pull opposite
ways.**

- The marks must stay **outside** the tile's `<button>`. An accessible name is computed from a
  button's contents, so a mark inside it is announced *before* the deck, and the tile is named for
  its deck. That is the badge's own long-standing rule, unchanged; what is new is that there are
  two of them.
- But "the art's bottom" is not "the tile's bottom". Under the picture sit the colour band, the
  name and the caption, so a mark anchored to the `<li>` would land on the caption.

**An aspect-ratio box is what reconciles them.** One `pointer-events-none absolute inset-x-0
top-0` overlay, a sibling of the button, sized by `style={{ aspectRatio: ART_ASPECT }}` — the same
`626 / 457` the cover is drawn at. Its height therefore resolves to exactly the cover's height
with **no ref, no `ResizeObserver` and no frame of disagreement**, at every stop on the zoom
ladder, because both boxes are driven by the same grid track. A copied pixel height could not be
exact at every stop the ladder has; a measured one would answer a frame late.

- **The overlay is deliberately _not_ `aria-hidden`, and the design source says otherwise.** On the
  canvas both marks duplicated caption text, so hiding them was right there. It is wrong here: the
  caption has *lost* the bracket, so the pill is now the only place the bracket is said at all,
  and hiding it would take a fact off the wall for a screen reader and leave it on for everybody
  else.
- **`TILE_MARK` is one constant because the two are one mark drawn twice** — same edge, same
  picture, opposite ends — and a padding, face or radius changed on one alone is two vocabularies
  in one corner. Every size in it scales with `--mark-scale`, the inset included: 6px in from a
  200px crop is a corner, 6px in from a 400px one is a smudge against the edge. What is *not*
  shared is the dash: `border-dashed` means provisional, which a theory list is and an estimate is
  not.
- **The pill takes no tooltip, and the reason generalises.** `pointer-events` inherits, so a hint
  bound anywhere inside a `pointer-events-none` wrapper can never open — `src/CLAUDE.md`'s rule.
  The escape `FoilOverlay` uses, `pointer-events-auto` on the mark itself, works only because that
  chip is *inside* its button, where the press still opens the card. Here the marks are siblings
  of the button, so buying the hint back would buy a genuine dead spot in the picture's corner,
  for words the pill already prints in visible type.
- The string is the page's. `BRACKET ~3` is `uppercase` over `bracketLabel`'s `Bracket ~3`, never
  a second string built in the tile: the page owns the words, the tile owns the type. `null` draws
  nothing — never `Bracket ?`, never a skeleton, never a dash — which is exactly what the caption
  segment did before it.

### The 20px that three objects now share

The band's height is the number that keeps a grid track level, and it is spent three different
ways:

| Where | How it is spent | Spelled |
| --- | --- | --- |
| `DeckColorBar.tsx` | the band itself, drawn | `h-[calc(1.25rem*var(--mark-scale,1))]` |
| `FolderCard.tsx` | `BAND_PAD`, padding under the crops | `pb-[calc(1.25rem*var(--mark-scale,1))]` |
| `DecksPage.tsx` | the empty drawer's `New deck` placeholder | `paddingBottom: "calc(1.25rem * var(--mark-scale, 1))"` |

**Three spellings rather than one import, deliberately** — one object draws a band there and two
spend the space on empty box, so there is no single constant that would be honest at all three
sites. What there is instead is this table and `BAND_PAD`'s own doc comment: the three have to be
read together before any of them moves. All three scale with `--mark-scale` for the same reason;
one holding still would put the track out of true at every stop but 100%.

### Folder cards in the deck tile's format, and where the dash went

A dashed box holding a 96px strip of up to three crops, then a name with a bare figure beside it,
then the word `Folder` on a line of its own, is now **one framed box in the deck tile's own
format**: `overflow-hidden rounded-lg border border-border bg-surface` on the `<button>` itself,
an `ART_ASPECT` spacer plus `BAND_PAD` for its height, the member crops filling the whole frame
(`absolute inset-0`, 2px seams) rather than sitting in a fixed strip, and the name with
`Folder · N decks` on a `bg-bg/72` scrim over the bottom. A wall of folders and decks is one wall
now rather than two kinds of object in one grid.

- **The frame's edge is on the `<button>` and that is load-bearing rather than tidy.** 2026-09-03
  moved both drags' marks onto that element — the one that already carries the card's own edge —
  because a ring around a dashed card was the three-concentric-outlines bug a reader reported.
  Putting the new frame on a face *inside* the button would have re-made it at exactly the place
  the app has already been reported for. So the border, the radius, the clip and both drop marks
  are one element's, and `DROP_EDGE` recolours whatever edge that element owns — which is why a
  card that turned solid needed no change to the marks and got none.
- **Dashed became solid, and the dash was prose rather than decoration.** `FolderCard`'s comment
  used to name it as the screen's one visual rule, *dashed means provisional*; a folder is not
  provisional beside a deck, it is the same object with decks inside it, which is what drawing the
  two the same way claims. The vocabulary survives where it still says something:
  `ParentDeckFolderCard`, the way *out* of a drawer, takes the same silhouette with a dashed
  `border-accent/55` edge and is the only tile on the wall that is not a place.
- **The wishlist's and the collection's folder cards keep the dash and are untouched**, and the
  divergence is honest rather than drift: those walls draw a folder as a 62px line of type among
  62px lines of type (the 2026-09-03 section above measured them), where an edge is the only thing
  separating a container from a control. This one draws it as a picture the size of a deck's
  picture with the word `Folder` in the caption.
- **`src/lib/dropMarks.ts`' prose was corrected in the same commit** — it described all four folder
  cards as dashed, and one of them no longer is. Its argument was unaffected; the sentence was one
  wall behind.

**`ParentDeckFolderCard` gained a `zoom` prop, and the reason is a trap worth generalising.** It
used to be `components/ParentFolderCard` with two drop targets wrapped around it — words in a
stretched grid item, where `h-full` was the whole of its geometry and the tile kept pace with its
neighbours without knowing the zoom existed. Drawn in the new frame it prints a glyph, a
heading-face label and a caption at `calc(… * var(--mark-scale, 1))` sizes, **and a tile that never
sets that variable reads the fallback of 1**: at 2× the wall's decks and folders would double
while the way *out* of the folder stayed at its shipped size, inside a box that had grown around
it. The prop is what publishes the variable, through `cardScaleVars`, exactly as `FolderCard` and
`DeckTile` do. The *words* are still shared — `UP_ONE_LEVEL` and `upCardName` are imported rather
than respelled, so all three walls say one string and the accessible name cannot diverge; what
could not be shared any longer is the drawing.

### The tree draws its nesting: 16px steps, a gutter beside the button, an elbow at the last child

Rows go from `py-1.5` to `py-2.5` (a 32px row around a 20px line becomes 40px, which is why the
`New folder in …` control's centring moves from `top-1` to `top-2` — one arithmetic written
twice), glyphs from `size-3.5` to `size-4`, and the selected row gains a **2px accent rail** down
its leading edge, `absolute bottom-2 left-0 top-2 w-0.5`, *inside* the button so it sits within the
fill it belongs to. The fill and `aria-current` already say a row is current and neither is
findable — a fill of that weight is what a hover paints too — so in a rail of twenty rows the
reader had to read the names to find where they were.

**The nesting is drawn, and the guides live in a gutter _beside_ the button, never under it.** A
trunk under a hover fill or a focus ring is a trunk the reader cannot see, so the row is a flex of
two things: a `flex-none` gutter of absolutely positioned hairlines, then the button, whose own
padding is a constant 8px with no indent left in it at all.

The arithmetic, with `GUIDE_STEP = 16`, `GUIDE_TICK = 10`, and a 16px glyph at 8px of padding:

| Mark | Geometry |
| --- | --- |
| the gutter | width `16·depth + 10` — the last trunk plus the run the tick needs |
| a trunk at level L | `left: 16·L − 0.5`, which is where a 1px line starts if its middle is to land on `16·L` |
| an ancestor's trunk | drawn only where that ancestor still has siblings below this row |
| the tick | `top: 50%`, `left: 16·depth + 0.5`, `right: 0` |
| a last child's own trunk | `bottom: 50%` — the elbow |
| every vertical | `top: -2`, `bottom: -2` — the overhangs |
| the root's trunk | in "All decks"' own `<li>`: `left: 15.5px`, `top: calc(50% + 12px)`, `bottom: -2px` |

- **At L = 1 the trunk lands on the centre of a top-level row's 16px glyph**, which is the line
  every top-level folder hangs from. That is the whole of why the step is 16.
- **The 2px overhangs are what make a trunk read as one line.** The list is `gap-0.5`, so
  consecutive rows stand 2px apart, and a guide drawn to its own row's edges would stop and
  restart at every row — a dashed line down the tree, which says something the tree does not mean.
- **The root row draws the trunk its children descend from**, because "All decks" is the top
  rather than a row of the tree: it has no gutter of its own, so the level-1 trunk has nowhere
  else to start. It starts at `50% + 12px` — the midline plus half a glyph and 4px of air — so the
  line begins just under the glyph rather than out of the middle of it, and is drawn only when
  there is a folder under it.
- **The gutter went _inside_ the measured drop box, not in front of it.** Both drag registrations
  still span the whole row and are still the same rectangle: wrapping the pair in a flex box
  *outside* `folderRef` would have narrowed the folder drag's box to the button, so the row's
  leading 26–58px would stop being part of what a folder is let go on and picked up by. Nothing
  about `folderEdge`'s thresholds moves either way — `axis="vertical"` divides the box by
  **height**, and a gutter of absolutely positioned hairlines adds none.

**`indent()` in `src/lib/folderTree.ts` was deliberately not changed, and the two steps no longer
agree on purpose.** That function is 14, still exported, and still the wishlist tree's, the
collection cabinet's and `MoveToFolder`'s — pickers, flat lists of destinations with no guides in
them, whose step is free to be what reads well. A step that draws hairlines is not free: pulling
the tree back to 14 would put every trunk half a glyph off the row above it, and pushing the
pickers out to 16 would move a list that gets nothing for it. The deck tree's own `treeIndent()`
is module-local and answers only the tree's question — which is where the `New folder in …` field
stands, so it lines up with the rows around it.

**The row order and the two facts the guides need come from a module-local `drawOrder` walker
rather than from `flattenFolders`.** Whether a row is the `last` of its siblings, and the ancestor
`trail` of "does that level still have a branch running past this row", are facts only this
drawing uses; widening `FolderNode` or the shared flattener for them is a change four surfaces pay
for and one benefits from. The *order* is not given up — the same depth-first, parents-first walk
— which is what let the call be replaced rather than joined.

**A new exported `FOLDER_GUIDE_ATTR` (`data-folder-guide`) is the test handle**, and it carries
which piece it found as its value: six values, five of them the nesting (`gutter`, `ancestor`,
`trunk`, `tick`, `root`) and `rail` for the selected row's mark, which is the same *kind* of thing
— an `aria-hidden` mark that is nothing but a position and a colour. The reason is
`DECK_COLOR_SEGMENT_ATTR`'s, and it applies twice over here: the marks are `aria-hidden` and have
no role, name or text, their offsets are **inline styles** (computed, and Tailwind emits nothing
for an interpolated class), and jsdom applies no stylesheet — so a class assertion would be a
check on source text rather than on the drawing. A handle that could only be *counted* would be
satisfied by an ancestor's trunk standing where the row's own belongs.

**Still no twisty**, and the guides do not reopen that argument: they are disclosure's picture
without disclosure's mechanism. Nothing collapses, every folder is still always on screen, and
there is still no branch a deck can hide in with no number pointing at it.

### `Folder actions`: the fourth ruling in one running series

`Rename folder…`, `Move folder…` and `Delete folder…` — three heading-row buttons and the two
anchored panels behind them — collapse into one `Folder` control that opens `buildFolderMenu`
verbatim through `useContextMenu`'s `menuClick` (which anchors at the pointer for a press that had
one and at the button's bottom-left for one that did not — a button reached by Tab fires a `click`
carrying no coordinates, and `0, 0` would put the panel in the corner of the window).

Two things make it worth recording.

**First, the row was spending width saying one thing twice.** Six controls stood beside a heading
and a count — the three verbs, `New folder`, `Import deck`, `New deck` — in a column measured at
**548px** at the app's 1024px floor (2026-09-07, debug build; the figure is the previous section's
and was driven). Four do now. And the two spellings did not even agree: the tree's own row menu
already offered those three writes **plus** `New deck here` and `New subfolder…`, so a folder a
reader right-clicked could do more than the folder they were standing *in*. The caret glyph
replaces the ellipsis deliberately — an ellipsis means "this opens something that asks you a
question", which is true of a rename field and a delete confirmation and false of a menu.

**Second, and this is the one to carry away: the button's accessible name is `Folder actions`, not
the `Folder` it prints, and the suite is what found that.** `CreateDeckDialog`'s own folder select
is named exactly `Folder`, and that dialog opens *over* this row — so for as long as it is up, two
controls on one screen answer to one name, and `getByRole("button", { name: "Folder" })` throws
"found multiple". It is not a WCAG failure; it is a control that cannot be addressed
unambiguously, by a screen reader walking the page, by anyone driving the app by voice, or by a
query. **It is the fourth time this exact collision has been ruled on in this feature**, and each
was settled the same way — the name says what kind of thing the control is about, and the visible
word stays the first word of the name (WCAG 2.5.3, so "click Folder" still works):

| The control | Collided with | Named |
| --- | --- | --- |
| the gallery's sort picker | the deck editor's `Sort` | `Sort decks` |
| the gallery's name box | the editor's `Filter this deck` | `Filter decks by name` |
| a format chip | the tree row for a *folder* of that name (`Commander, 1 deck`) | `Commander format, 1 deck` |
| the heading row's folder menu | `CreateDeckDialog`'s `Folder` select | `Folder actions` |

**The collision only exists while a dialog is open, which is why reading the row could never have
shown it.** That is the general lesson rather than a fact about this button: a name collision is a
property of what is on screen *together*, so the surface to check is every layer that can be up at
once, and the suite is the only thing that walks them all. The trigger carries
`aria-haspopup="menu"` and **no `aria-expanded`** — `WishFolderCard`'s ruling, for its reasons: the
popup *kind* is a fact about this button and is free, the expanded *state* belongs to
`ContextMenuProvider`, and a static `aria-expanded="false"` is an assertion that is wrong for
exactly as long as the menu is up.

**`{ kind: "moveFolder" }` left `panels.ts` as dead, and must not come back.** The picker lives in
the menu's lazy `Move to` submenu now, which the menu panel draws at the app root — so there is no
layer of this view's own for the arm to be about, and it would be a flag nothing sets and nothing
reads. *A picker that lives in a menu is not a panel.* The two folder verbs that still raise a
layer of this view's own are in there: the rename field, which the tree draws in place of a row,
and the delete question, which the `Folder` button now anchors. Both routes into the delete
question make the folder in question the open one — `folderMenuDeps.askDelete` does
`setSelectedFolderId(folder.id)` on the way in — which is what puts the wall the sentence is about
behind the sentence, and what guarantees there is a button on screen to anchor the panel to.
(`CollectionPage` and `WishlistPage` each declare a `moveFolder` arm of their own; those are
different unions about different screens and are not evidence that this one needs it back.)

**An empty folder stops drawing a sentence and draws the wall.** *"Nothing is filed in X yet. Drag
a deck onto it, or use the Move control on a tile"* described a gesture instead of offering one —
and it withheld the up-one-level tile from precisely the folder with nothing else on screen to
press, while naming a control that lives on a *different* wall. So an empty drawer gets two tiles:
the way out it was already denied, and a dashed `New deck` placeholder standing at a deck tile's
height (crop box plus the band's 20px), named `New deck in {folder}` rather than `New deck`
because the heading row's primary control already owns that string. It is not an always-present
`+ New deck` tile — a wall of forty decks would end in a dashed box nobody was looking for.
**The root-level sentence stays a sentence** (at the top level the folder cards *are* the wall, and
there is no level above for a way out to point at), and **the "No decks match this filter" state is
untouched** — it is gated on `here` rather than on `shown` for the reason its own long argument
gives: a dashed `New deck` box on a wall the reader has just narrowed says the same wrong thing the
old sentence would have.

### The live pass, and the bug in it that nothing else could have found (2026-09-08)

Driven over CDP in the shipped `tauri dev` window, debug build, 1920 × 1080, against a copy of
the main checkout's real database. **It found one defect, and it is the kind this whole practice
exists for: three green suites, a correct-looking screenshot at 100%, and a rule that was never
applied.**

#### The symbol was 16px in a band that asked for 12

The glyph is drawn as `<i class="ms ms-u …">`, and the size was written on that element as
`text-[calc(0.75rem*var(--mark-scale,1))]`. Measured in the window at `--mark-scale: 1`:

| Read | Expected | Actual |
| --- | --- | --- |
| `getComputedStyle(i).fontSize` | `12px` | **`16px`** |
| the same at `--mark-scale: 0.7` | `8.4px` | **`16px`**, in a band 14px tall |

**The cause is source order, not the class.** `mana-font`'s own `.ms` rule declares
`font: normal normal normal 14px Mana` and then `font-size: inherit` — a **class** selector,
exactly as specific as a Tailwind utility — and `src/main.tsx` imports `mana-font/css/mana.css`
after `index.css`. On a specificity tie the later sheet wins, so the utility was in the markup,
in the stylesheet, and inert; the symbol simply took its parent's 16px.

**Every fence this repo owns was blind to it, and each for a different reason.** `classList`
assertions passed because the class really was there. jsdom applies no stylesheet, so a
computed-style assertion could not have been written. `tailwind-merge` was checked and cleared —
it keeps both classes, which was the hypothesis tried first and refuted by running `twMerge`
directly. And at 100% zoom a 16px symbol in a 20px band merely reads as a slightly bold band. It
only becomes a *visible* fault at the bottom of the zoom ladder, where the band shrinks and the
symbol does not.

**The fix is to set the size on the field rather than on the `<i>`**, which is not a workaround
but the arrangement the font asks for: `font-size: inherit` is `.ms`'s own declaration, so the
glyph follows its parent by design, and the parent is the one element that already knows how big
the band is. Re-measured after the fix, the whole ladder is proportional:

| `--mark-scale` | band | symbol | segment floor | tile |
| --- | --- | --- | --- | --- |
| 0.7 | 14px | 8.4px | 18.2px | 146.2px |
| 1.0 | 20px | 12px | 26px | 227.3px |
| 1.3 | 26px | 15.6px | 33.8px | 272px |

**`ManaText` has the same defect and it is not fixed here.** `.ms-cost` declares
`font-size: 0.95em` by the same kind of selector, so that component's `text-[0.85em]` is inert
too and every printed cost in the app draws ~12% larger than its own source says. It is a
separate change — that component is on the search table, the card pane, both deck views and their
stories — and it wants its own pass rather than riding in on a gallery redesign.

#### What else the window settled

- **The band is fused, exactly.** `band.top − art.bottom = 0`. The crop's bottom-left radius is
  `0px` where a band follows and `10px` where none does (`rounded-lg` is 10px in this app, not
  Tailwind's stock 8px — so the band's `rounded-b-lg` foot and the crop's `rounded-t-lg` head are
  one radius). The seam is a real `1px` top border; the 2px gaps are the band's own `bg-surface`
  showing through, and the three fields on a Grixis deck read `rgb(170, 224, 250)`,
  `rgb(203, 194, 191)`, `rgb(249, 170, 143)` — `--color-mana-u`, `-b`, `-r` and not a deep among
  them.
- **The marks overlay resolves to exactly the cover's box**, which was the claim with no proof:
  `227.3 × 166` against a crop of `227.3 × 166`, `top` and `bottom` deltas both `0`. No ref, no
  measurement, one aspect ratio.
- **The two marks do not collide at the narrowest tile.** At 0.7× the tile is 146.2px and the gap
  between the badge's right edge and the pill's left is **12.1px**; at 1× it is 37.3px. Both marks
  scale with the tile, so the clearance is proportional rather than lucky.
- **The guides draw what the arithmetic promised**, read off a tree built live to have all four
  shapes in it. A non-last folder's trunk runs `top: -2px → bottom: -2px`; a last one stops at
  `bottom: 50%`. A row nested under a **non-last** parent draws an `ancestor` hairline at
  `left: 15.5px` running the full height *and* its own trunk at `31.5px` stopping at the elbow; a
  row nested under the **last** parent draws no ancestor at all. Gutters measured 26px at depth 1
  and 42px at depth 2, rows 40px tall with `padding-left: 8px`, and the selected row's rail 2 × 24px.
- **The empty folder draws the wall**, up-tile and dashed placeholder, both standing at a deck
  tile's height. Folder cards and deck tiles measured **232px** each in one track.
- **The `Folder` menu opens on a plain click** and carries `New deck here · New subfolder… ·
  Rename… · Move to · Delete…` — the tree row's list, not a second one.

#### Still owed

- **`ms-b` and `ms-c` side by side** against real cover art, which is the seam the 2px gap was
  chosen for. The database driven had no deck with both.
- **The heading row at the 1024px floor.** The pass ran at 1920 and the collapse's whole argument
  is about a ~548px column.
- **Where the caret lands** after each `Folder` menu row that raises a layer, and that `menuClick`
  anchors a keyboard press at the button rather than at the pointer's last position.
- **The tree at depth 3+ in a 208px rail.** At depth 2 a 20-character folder name already
  truncates to about eight (`Nested U…`), which is the 16px step and the 10px tick gutter spending
  width the 14px step did not. It is the design as approved and names have always truncated, but
  nobody has yet looked at a genuinely deep cabinet in it.

### The three sizes the reader sent back — 2026-09-08, same build

Two defects, reported with screenshots the same evening the redesign landed, and **both are one
mistake seen twice: an object on the wall that is not the height of the objects beside it.** The
grid stretches its cells, so nothing moves down to meet a short tile — what a reader sees is not a
tile that is 20px short, it is a row whose type has come out of line.

**The way out was as tall as the tallest thing in its row.** `ParentDeckFolderCard`'s button
carried `h-full`, which was the whole of its geometry while it was words in a stretched grid item
and became wrong the moment it grew a frame: beside a 186px folder card it stood at **232px**, a
deck tile's height, because a deck tile is a crop plus a band plus two lines of type *under* both.
Removing `h-full` gives it the height every other framed box on the wall gets from the same two
things — the `ART_ASPECT` box and `BAND_PAD`. Measured after: the up-tile and the `New deck`
placeholder both **186.5 × 227.3**, identical to the folder card's frame in the same row, and to a
deck tile's crop-plus-band.

**A deck with no coloured costs drew no band, and its caption sat 20px high.** The band's own
`null` return — argued at length above, and about the band rather than about the wall. It now
draws **empty**: the full 20px course of the tile's own `bg-surface`, no fields and no symbols.
Measured after: every deck tile in the wall **232px**, the 0-card deck included, with its name and
caption level with its neighbours'.

**What the empty band may not be is a colourless one.** A full-width `--color-mana-c` field would
be the band saying the deck *is* colourless, which is false for a deck whose pip read has not
landed — `pips === null` and an all-zero record are indistinguishable from the tile, and the honest
drawing of both is a course that says nothing. It carries no tooltip either, and that falls out
rather than being arranged: `useTooltip` refuses falsy content and an empty list joins to `""`.

**Neither defect was visible to a suite, and the reason is worth keeping.** jsdom has no layout
engine, so a stretched cell, a short tile and a caption 20px out of line are all the same DOM; and
each tile was individually *correct* — the fault only exists in the relation between them. A wall
is the unit to look at when checking a wall.
