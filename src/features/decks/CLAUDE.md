# src/features/decks — the deck builder

**Validation is TypeScript** (spec §3). Rust supplies **facts** (`DeckCardRow`: per-printing
`legalities`, `color_identity`, P/T, `ever_uncommon`, `game_changer`); TS draws **every**
conclusion. The storage side — tables, the seven card commands, the allocator, the audit log —
is [docs/reference/decks-storage.md](../../../docs/reference/decks-storage.md) and
[src-tauri/CLAUDE.md](../../../src-tauri/CLAUDE.md).

## The validation layer

`validation/` is the whole of it:

| File            | Owns                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| `engine.ts`     | Size, copy limits, restricted semantics, legality                              |
| `singleton.ts`  | Exact-phrase exceptions, **re-derived from oracle text and never a card list** |
| `commanders.ts` | Eligibility, partners, colour identity                                         |
| `companions.ts` | Companion rules                                                                |
| `bracket.ts`    | **Advisory only — `engine.ts` does not import it**                             |

- `oldschool` is the one printing-sensitive legality key, and it comes out right with no special
  case because each row carries its own printing's answer.
- `format_specs` is data seeded in a migration, never an engine branch. `restricted_semantic`
  (`max_one` | `banned_as_commander`) is **never inferred from the key**.

## The category model

- **The name is the user's; the kind is what the rules read.** `deck_cards.category_id` points at
  a row the user names, reorders, switches off and deletes; the fixed word survives only as that
  row's `kind` — `main | side | commander | companion | maybe`, narrowed in TS as `CategoryKind`.
- **`is_active = 0` is the whole of what `maybe` used to mean**, and **nothing anywhere may
  branch on the kind being `maybe`.** An inactive category counts toward nothing — not size, not
  copies, not legality — and the allocator claims no copy for it. That was measured: the old
  shape looked correct and was wrong the first time a user deactivated a pile of their own.
- **`SIZE_KINDS` is `main`, `commander` and `maybe`** — the switch decides whether a pile counts
  at all; the kind decides only whether it is played _beside_ the deck or _in_ it, and only
  `side` and `companion` are beside it (CR 100.4a; EDH's companion is "effectively a 101st
  card"). It is written in **three places that must stay one rule**: `engine.ts`'s constant,
  `deck.rs`'s `DECK_SELECT` subquery behind `DeckRow.card_count`, and the Storybook fake's copy.
- **An add that names no category is filed by the card's type line; an add that names one is
  untouched** — so every _drag_ overrides the rule by construction. The rule is `autoCategoryFor`,
  applied on **`useDeck.addCard`'s single definition**, which takes an optional `typeLine`; the
  fact travels from the call site, so no add pays a round trip to discover what it is adding.
  `null` (an orphan, or a layout with no bucket word) is `Uncategorised`; **absent** is
  `DEFAULT_CATEGORY_NAME`.
- **The "Add to" select's default is `AUTO_CATEGORY`, which is `0`, and that zero fixed a real
  bug** — a deck's seeded categories are in `PREDEFINED_CATEGORIES` order, so a clamp to
  `categories[0]` put every quick add on a fresh deck into **Commander**. Zero now _means_ auto,
  nothing overwrites it, and an explicit pick **stays** picked.

## Writes

- **A write to what is _in_ a deck goes through a `useDeck` mutation**, and `DeckEditor`'s
  `newestWrite([...])` counts **six** of the hook's eight: update (rename, cover, Built toggle),
  add-card, set-quantity, move, missing-to-wishlist, swap-printing. The two outside it are
  `setTag` and `rememberView`, each for its own reason stated on its definition.
- **There is no remove mutation.** The tray's drop and the stepper's zero are both
  `setQuantity(…, 0)`, because zero removes a deck row.
- **The refusal rule lives on the single definition in `useDeck.ts`, never on a call site** — two
  definitions would be two places to keep one rule. The two surfaces outside the editor
  (`useSwapFromPane`, `useSidebarDrops`) borrow a mutation whole and own only their own reporting.
- The deck _row_ is a different hook: the gallery's `useDecks` owns create, update, remove and
  duplicate.
- **Switching the theory list on _moves_ the live deck into it — it does not copy it.** What the
  reader has built is the plan, so it becomes the theory list and `live` starts empty and fills as
  they acquire cards; the same write sets `last_variant = 'theory'`, so the editor lands where
  the deck now is instead of on a blank page nobody emptied. Only on the false→true transition,
  and only when the theory list is empty. **The rule it replaces copied**, on the reasoning that
  an empty theory list beside a full live one reads as data loss. Right danger, wrong half:
  nothing is deleted either way — the two lists are the same table — and what the copy actually
  handed the reader was two identical lists with no way to tell which one they were editing.
  `deck_theory_copy_from_live` is unchanged and still means "copy what is sleeved up into the
  plan".
- **`src/features/decks/auditText.ts` is the only thing that reads the audit payload, and the only
  thing that words it** — a sentence is domain logic and the table has to survive the day the
  wording changes. `deck_audit` has no `summary` column and never will.
- **A deck card's unit price is that printing's nonfoil price at the selected marketplace** — a
  deck names a printing, not a finish. `cards.price_usd` is a fallback chain across finishes and
  is never summed. **One `unitPrice` per row, not a pair**: the marketplace is in `useDeck`'s
  query key, so switching re-reads the deck, and `deckStats`, `buildGroups`, `sortCards` and
  `diffTotals` take no `Currency` at all any more — a heading, the rows under it and the strip
  above them cannot be about different money, by construction.

## Import

`import/` is `parse.ts` (text → lines), `plan.ts` (lines + the printings Rust resolved → piles, a
commander, tallies), `useDeckImport.ts` (the writes) and `ImportDeckDialog.tsx` (two steps, one
panel, nothing written until Import). The Rust half and every measurement:
[docs/reference/decks-storage.md](../../../docs/reference/decks-storage.md).

- **One parser for every export, and every rule in it is a _per-line_ rule.** A format detector
  would have to choose a reader before it had read anything, and would be wrong about exactly the
  lists somebody has edited by hand. So an unfamiliar mixture is read line by line rather than
  refused whole.
- **`//` is a comment only at the _start_ of a line.** `1 Branchloft Pathway // Boulderloft
  Pathway` is one card and there are seven such names in the reference list alone, so a `//` found
  anywhere else is part of the name and must never be cut.
- **The line splitter takes CRLF, a lone LF _and a lone CR_.** `/\r?\n/` — the obvious spelling —
  treats a carriage return on its own as nothing and `.` does not cross one, so a CR-only paste
  arrived as **one** row that matched nothing and the whole list came back as a single issue.
- **Nothing is ever silently dropped.** A line the parser cannot read becomes a `ParseIssue`
  carrying its number and its raw text, and one bad line never aborts the parse. The only lines
  that leave no trace are the ones making no claim — blanks and comments.
- **`plan.ts` makes every deck decision and the dialog makes none.** The pile is `autoCategoryFor`
  (the app's one rule, never copied — a plain add, a drag with no column under it and an imported
  line have to agree) and the commander is `commanderIneligibility`, the same rule the validation
  panel judges a built deck by. A looser "looks like a commander" test here would offer a card the
  panel then refuses.
- **`row.index` is the address, never the array position.** `deck_import_resolve` carries the
  caller's own index back precisely so the two can differ; reading `rows[i]` against
  `parsed.lines[i]` works today and mis-files the whole list the day anything filters between them.
- **`CardIdentity` is the card-level half of `CardFacts`, and `CardFacts` was deliberately _not_
  narrowed to it.** It exists so the importer can ask "could this be a commander?" about a card
  that is in no deck yet and therefore has no `id`, no `categoryKind` and no honest `quantity` to
  invent — but the engine really does read `categoryKind`, `categoryActive` and `quantity`, so a
  card in a deck is more than a card. Every existing caller passes a whole `DeckCard`, which
  satisfies a `Pick` of itself, so the widening changed no call site.
- **An import is not an add path and must never become one.** Routing a list through
  `useDeck.addCard` would be one transaction and one **allocator run per line**;
  `deck_import_commit` is one of each. `useDeckImport`'s fourth mutation, `importIntoNewDeck`, is
  `deck_create` then that commit with a **hand-rolled rollback** — two commands are two
  transactions, and a refused import must not leave half a deck in the gallery. The commit's
  refusal is what the caller hears, never the clean-up delete's.
- **The file picker's own half is unverified**, for the reason `deck_set_cover_image`'s is:
  `dialog:allow-open` opens a native window CDP cannot reach. Path → text → preview is tested;
  click → path is not.
- **Driven in the shipped window 2026-08-12** (`npm run tauri dev`, a **debug** build): the
  gallery path end to end put **105 of 105** reference-list lines and all **117 copies** into a
  new deck, `deck_import_resolve` cost **120.4 ms** and `deck_import_commit` **7.9 ms** through
  `invoke` on that build, and the commander step offered **56** candidates — the list's 55
  legendary creatures plus a legendary Spacecraft with a P/T box. Every figure, the variant and
  audit checks, and the three resolver-side faults it found — all since fixed: a printing hint
  trusted over the card name, `MOXFIELD_LIST`'s fabricated hints, and `MATCH_ORDER` having no
  language term — are in
  [decks-storage.md](../../../docs/reference/decks-storage.md).
- **The preview's tally is counted over the _items_, never over the plan** — `tallyOf(items)`
  where `items` is `toImportItems(plan, commanderIds)`, so it recomputes on every press. There is
  deliberately **no `categories` field on `ImportPlan`**: the piles are a fact about what is being
  sent, and the commander choice is applied in `toImportItems` and nowhere else, so that is the
  only place a preview of it can be counted. `totalCards` stays on the plan, because the choice
  changes _which_ pile a card lands in and never _how many_ copies land. This was a live bug:
  measured 2026-08-12, the reference list previewed as **`117 cards · 6 categories`** with
  `Creature 56` and no Commander row while `deck_get` after the import read **7 categories**,
  `Creature 55`, `Commander 1`. Worst on the **`automatic`** arm, where the reader presses
  nothing — the dialog printed *"Krenko, Mob Boss goes in the command zone"* directly above a
  tally filing him under `Creature`. `fromFile` was the one arm that agreed, because there the
  card already carries the Commander category name. The split `toImportItems`' doc calls
  deliberate is still right ("the plan is what the preview draws _while_ they are still
  choosing"); what was wrong is that the tally was ever part of the plan.
- **The layer contract holds and was measured, not assumed.** The dialog's scrim computes to
  `z-index: 45` from both entry points (`LAYER.overlay`, the rung the editor's other full-window
  surfaces share); one Escape closed the dialog and **left the card pane open**, handing focus
  back to the `Import cards` button that opened it, and a second Escape closed the pane; 22 Tab
  presses from the textarea produced 22 focus landings and **every one inside the dialog**.
- **Reduced motion is honoured on both halves, and only the live pass could show it.** Under
  emulated `prefers-reduced-motion: reduce`, the panel's `transform` at 60 ms was **`none`**
  against `matrix(0.9818…)` unemulated — `MotionConfig reducedMotion="user"` reduces `scale`
  because it is a transform, unlike the deck stack's `marginBottom` — while `opacity` kept
  animating (0.137), which is the weaker rule `lib/motion.ts` documents on purpose. No
  `useReducedMotion()` opt-out is owed here. The buttons' CSS half read
  `transition-property: none` **while `transition-duration` still read `0.12s`** — the false
  failure the harness contract warns about, reproduced exactly.

## Views and interaction

- **Four views** — `Stacks | Table | Text | Grid` (`DeckEditor`'s `VIEWS`) — crossed with three
  `Group by` modes (`category | manaValue | type`) and four sorts (`alphabetical | manaCost |
price | type`). An **inactive category stays its own group in all three grouping modes**, and it
  stays that group _whole_: `buildGroups` appends it carrying its own `kind`, so a switched-off
  Sideboard is still `kind: "side"` under `manaValue` and `type`. Only the **derived** groups are
  `kind: null`. So anything that keys on a kind — `GroupHeader`'s `RULE` marker, `StackView`'s
  pinned column — still sees a sideboard in the two modes that otherwise have no categories in
  them, which is the right answer in both cases and is a special case in neither.
- **The variant tabs read `Theory | Live`, theory on the left.** That is where a deck now starts:
  switching the theory list on **moves** the live deck into the plan, so the left-hand tab is the
  one holding cards and `live` is the column that fills as the reader acquires them. Reading
  left to right is then plan → reality, which is the direction the difference readout beside it
  already counts in.
- **The editor reopens on the view the reader left, and the deck row is where that is kept.**
  `lastVariant`/`lastGroupBy`/`lastSortBy` come off `DeckRow` and go back through
  `useDeck`'s `rememberView` (`deck_set_view_state`), which touches no `updated_at`, writes no
  history and reallocates nothing — looking at a deck is not editing it. It is deliberately
  **not** `useAppStore`: `cardZoom`, `searchView` and `collectionView` are one session-wide
  answer, and which list of a _particular_ deck the reader was reading is a fact about that deck.
- **The narrowing is TypeScript's, and that is the boundary rather than a missing constraint.**
  `ALTER TABLE ADD COLUMN` cannot add a CHECK, so Rust validates only `last_variant`, whose
  vocabulary the crate owns, and stores the other two verbatim as facts. `GroupBy` and `SortBy`
  are this layer's words, so `asGroupBy` (`grouping.ts`) and `asSortBy` (`sorting.ts`) narrow
  them on read and fall back to the default — a stored word nothing offers reopens the editor on
  `category`/`alphabetical` rather than in a state no control can draw.
- **`rememberView` is the one `useDeck` mutation that does not invalidate, and that is the
  interesting part.** The editor is already showing what the reader picked; this write only makes
  it survive the deck being closed, so there is nothing to re-read. Invalidating hands the editor
  back the three fields it *restores from* a beat after the press, which is how a second press
  made inside that beat gets undone by the first one's echo. It is also outside `DeckEditor`'s
  refused-write family on purpose — **that family is writes to what is _in_ the deck**, and this
  one changes no card — so its failure is silent, the cost being a deck that reopens on its old
  tab.
- Only `Stacks` and `Grid` fetch a picture, and it is the **whole card** —
  `cardImageUrl(…, DECK_CARD_VARIANT)`, which is `grid`, and which must stay paired with
  `images::prewarm_keys`' `DECK_PREWARM` arm in Rust. **Getting that pairing wrong is invisible**:
  the pre-warm reports success and every tile then fetches cold anyway.
- **A deck card is the whole card, and the app's marks are overlays on it.** The picture _is_ the
  card, so `deckCardName` on the button is the **only** name a screen reader gets — but the app
  draws a **printed-card frame under it** (name, cost, type line) that the picture paints over,
  because a lazy-loaded category is a wall of `<img>`s and the card is known before its bytes are.
  The frame is the same thing that says "No image", "Retrying…" or "No card".
- **The marks go left, and they used to go right** (changed 2026-08-13). Over the art go facts
  about the _deck_ — the quantity tag, the Game Changer banner, `RULE BREAK`. Under it goes the
  data line with facts about the _printing_. `QuantityTag` merges the tag and the copy count into
  one mark: the count printed on the tag's own colour, grey (`UNTAGGED_COLOR`) when there is no
  tag, so gold stays something a tag says. `TagDot` is unchanged on the other three views. It
  costs ~34px of printed name, knowingly; the app-drawn frame insets its own name band by
  exactly that width so a name _this app_ wrote is never clipped.
- **The data line is a sibling of the button, not a child** — so unlike every mark over the art
  its text is genuinely announced rather than swallowed by the button's `aria-label`. It is the
  card's foot: a 28px bar under the face, ridden **4px** up so the face's clipped corners cover
  its square ones.
- **Every mark carries a `title`, and that is a second contract from the accessible name.**
  `deckCardName` is the whole of what a screen reader gets; a pointer user sees a 6px gem, a
  slanted colour tag and a crown, none of which is a word. Six sentences, pinned by
  `CardStack.test.tsx`: the tag (`"Fast mana · 2 in this pile"` — the tag and the count are one
  mark, so one title says both), `"Game changer"`, the rule break's own finding, the rarity
  (`RarityGem` grew a `title` for this; the stack draws no rarity text), the shortage, and the
  finish through `FinishMark`'s SVG `<title>`. **The seventh is missing on purpose**: the canvas
  wants the set _name_ behind the printing code, and `DeckCard` carries only `setCode` —
  `cards.set_name` exists but `deck_card_select` does not select it.
- **`CardStack` is arithmetic, not taste.** The card's height is _derived_: a Magic card's aspect
  applied to the card's own width gives **293** of image, its two hairlines make that **295**, and
  the data line less its rise makes **319px**. The
  collapsed **−285px** margin leaves a **34px** reveal, a legibility floor for the overlaid tag
  rather than a fraction. The list gets a fixed `stackHeight(n) = 34(n−1) + 319 + 8`, and the open
  card's margin turns −285 into +8: a **293px** push-down of every later card, out of a box whose
  height does not change. **Those two hairlines are the card's own and they still paint**:
  `STACK_CARD_BORDER` is a length with two owners, and the pair that stopped painting on
  2026-08-14 is the group `<section>`'s, one level up in `stackColumnWidth`.
- **The stack's controls are revealed by the card being _open_, never by `group-hover:`**
  (`revealedWhenOpen`). A collapsed card's only hittable part is its 34px strip, so hovering it
  used to reveal a control bar hundreds of pixels below, behind three other cards. They are a
  vertical column in the card's right margin now — `DeckCardControls layout="card-column"`, which
  is also the only layout whose buttons carry a backing, because it is the only one drawn on art.
- **Every number in the two bullets above is the value at zoom 1×, which is where the reader starts
  and no longer where they stay.** Ctrl+wheel over a card section steps `useAppStore`'s `cardZoom`
  along a ten-stop ladder from 0.5× to 2× (`src/lib/cardZoom.ts`), so each of those constants now
  has a function beside it — `stackCardWidth`, `stackImageHeight`, `stackDataHeight`,
  `stackCardHeight`, `stackAdvance`, `stackCollapsedMargin`, `stackHeight(n, zoom)`, and
  `stackColumnWidth(zoom)` in `StackView` — and the bare constant survives as that function's
  documented base. **Two of them are floors rather than proportions and they are the ones to know**:
  `stackAdvance` is `max(34, scaled(34, zoom))` and `stackDataHeight` is `max(28, scaled(28, zoom))`,
  so both grow going up and **hold at their base going down**. Each measures something laid over or
  inside the card — the quantity tag on the reveal strip, the type in the data line — and type does
  not shrink because a card did. Scaling either linearly is the mistake the floor exists to prevent:
  at 0.5× the reveal would be 17px under an unscaled tag, and the data bar would be 14px around 11px
  type. The same grow-only rule governs the grid view's caption and gutter and `CardGrid`'s caption
  strip: **anywhere a scaled budget has to contain unscaled chrome, the budget floors rather than
  scales.** `STACK_DATA_RISE` is the third kind — 4px at every zoom, because the 7px corner radius
  it hides the seam of is a Tailwind class that does not scale either.
- **The column is derived from the card, not the other way round** (it used to be: 14rem minus
  padding). `stackColumnWidth(zoom) = stackCardWidth(zoom) + padding + border`, with the chrome
  **added and never multiplied** — 6px of padding is 6px at every zoom, because padding is not part
  of a card. Scaling the two independently agrees at 1× and drifts at every other stop. 210 + 12 +
  2 = **224** at 1×, which is the `14rem` this replaced, exactly. **The `border` term is the
  `<section>`'s own hairline and it is `border-transparent`** (see the next bullet): a border box
  that paints nothing still occupies its 1px either side, so clearing the colour cost this sum
  nothing — while **deleting the class** would draw every card 2px wider than `stackCardWidth()`
  says it is, which is the one number the whole of `CardStack` is derived from.
- **A pile at rest has no edge, and the box that edge was drawn in is still there** (changed
  2026-08-14). `StackGroup`'s `<section>` is `border border-transparent` in **both** states, with
  a `bg-surface/60` wash under the inactive one; it used to be `border-border` active and
  `border-dashed border-border bg-surface/40` inactive. A column of card faces is already a
  rectangle with a hard edge, so an outline around it framed a frame, and fifteen of them read as a
  form rather than as a deck. **The cost is the one signal that told the two states apart**, so an
  inactive pile now says so three ways and an active pile says nothing at all: the wash, the dimmed
  name beside `GroupHeader`'s `INACTIVE` marker, and the pile's own `CardStack` at `opacity-60`.
  The drag marks needed no rework — `DROP_RING` is `ring-2`, and a ring is a box shadow **outside**
  the border box, so the highlight never read the border it appears to sit on. One thing to know if
  the lift ever regresses in switched-off piles only: **`opacity-60` makes that `<ul>` a stacking
  context**, and the `<ul>` is what takes `LAYER.raised` when a card opens.
  **Measured in the shipped window 2026-08-14** (`npm run tauri dev`, a **debug** build at
  1280×800): every `<section>` computed `border-width: 1px` with `border-color: rgba(0, 0, 0, 0)` —
  the box survives, the line does not — the inactive pile computed a `0.6`-alpha wash with its
  `<ul>` at `opacity: 0.6` against an active pile's transparent and `1`, and during a drag every
  eligible pile computed its ring while only the pile under the pointer added `DROP_OVER`'s gold
  and the drag source added neither. Full figures:
  [frontend-design.md](../../../docs/reference/frontend-design.md).
- **`opacity-60` cannot be checked on an _empty_ pile — `CardStack` returns null for a group with
  no cards**, so a switched-off empty pile has no `<ul>` in the DOM at all and a probe reports it
  absent rather than 0.6. Move a card in before reading that signal (this cost the 2026-08-14 pass
  a read on the Maybeboard). An empty pile carries the other two signals only: the wash and the
  `INACTIVE` marker.
- **The sideboard is pinned to the right of the desk, and it is a column rather than a panel.**
  `StackView` pulls every `kind === "side"` group out of what `packColumns` sees and draws them as
  one extra column after the packed ones — `sticky right-0`, `LAYER.raised`, an opaque `bg-bg` so
  the scrolling columns pass _under_ it, the same inline width and `flex` basis as every other
  column, and a soft left shadow for the seam (a shadow, not a border: the borders had just gone,
  and a hairline reinstated here would have been the only one left in the view). It carries
  `STACK_COLUMN_ATTR` **and** `STACK_PINNED_ATTR`, because "is a column" and "is the pinned one"
  are two claims and a sweep that counts columns has to go on counting this one. The failure it
  prevents is a drag with no destination on screen: the Sideboard sorts last, so on a deck wide
  enough to scroll it packs off the right edge, and a card dragged out of the main deck has nowhere
  to be let go of. **Scoped to `side` and deliberately not to the other two `RULE_KINDS`** — a
  commander is one card and a companion is one card, and pinning either would spend a column on a
  pile that is read at a glance. Two things then need no special case: a derived group is
  `kind: null`, so `manaValue` and `type` pin nothing _unless_ the reader has switched the Sideboard
  off (which appends the category itself, kind and all — the first bullet in this section); and the
  column is rendered only when a `side` group exists. **That last condition is real for a story and
  not for the app**: `PREDEFINED_CATEGORIES` seeds a Sideboard into every deck, a category group
  draws whether or not anything is in it, and a predefined pile cannot be deleted — so under
  `category` the pinned column is there from the moment a deck is created, empty or not.
  **It costs `stackColumnWidth(zoom)` permanently** — 224px at 1× (**measured** 2026-08-14) and
  434px at 2× (**derived** from the same function; the live pass ran at 1× only) — which on a
  1280px window at 2× is a third of the width parked on the sideboard before the deck has drawn a
  card. **Measured in the shipped window 2026-08-14** (debug build, 1280×800): the column computed
  `position: sticky`, `right: 0px`, `z-index: 10`, an opaque `bg-bg`, a `-8px 0 16px -4px` shadow
  and `width: 224px`; it held its `left` at 325px across a full scroll of a 1424px desk in a 632px
  scrollport, and `elementFromPoint` over a scrolled-under card returned the Sideboard's own text
  rather than the card. Figures: [frontend-design.md](../../../docs/reference/frontend-design.md).
- **A card scrolled under the pinned column is not hittable there, and that is correct** — it
  cannot be clicked, opened or dragged until it is scrolled clear, because an opaque sticky overlay
  is over it and a hidden card should not be grabbable. **Know the symptom, because it presents as
  a broken drag**: the first `cdp.mjs drag` of the 2026-08-14 pass failed with "the browser never
  started a drag" purely because the source card's centre sat under the pinned column. Scroll the
  source clear before pressing; suspect this before suspecting the harness or pdnd.
- **Exactly one card moves per step, and that is the whole reason the interaction works.**
  Opening card _N+1_ instead of _N_ leaves every other card's top unchanged. The reflow is one
  card sliding out of the stack, not a list resettling — and the pointer that armed it stays
  inside it for every frame.
- **The lift is state, not CSS, because pure CSS could not be given hover intent** (changed
  2026-08-12). The same arithmetic that makes one card move is what broke selection: after the
  first step the next card's strip sits ~34px below the pointer, so one continuous sweep armed
  four or five cards in ~60ms. `CardStack` holds `openIndex`, armed by `pointerenter` after a
  **80ms** dwell (`STACK_OPEN_DWELL_MS`) and closed after **180ms** (`STACK_CLOSE_DELAY_MS`),
  where arming another card cancels the pending close. **No new hit target was needed** — a
  closed card is overlapped 285px by its successor, so its only hittable part already _is_ its
  34px reveal strip. `LAYER.raisedOnHover`/`raisedOnFocus` are **gone**. The margin is no longer a
  Tailwind literal either — `motion` writes it inline, so the constants are the only place these
  numbers live.
- **The stack comes forward; a card in it never does.** The list takes `LAYER.raised` while
  anything is open, because the cards it pushes down leave its box on purpose. **No card carries
  a z-index at all** — they are `relative` siblings, so painting order is document order, and
  each card drawn over the one before it _is_ the stacked look. Raising the open card inverts
  that for the whole tail of the stack, on the first frame, while the cards after it are still
  293px from where they are going: it reads as the card jumping in front and the stack catching
  up around it. They uncover it instead. **jsdom paints nothing, so only the live pass can prove
  this** — see [docs/reference/decks-storage.md](../../../docs/reference/decks-storage.md).
  **`LAYER.raised` has a second occupant in this view now, and the two are ordered by the JSX
  rather than by a number**: the pinned sideboard column sits on the same rung as an open card's
  list, and equal z-indexes resolve by document order, so the pinned column winning is a fact
  about it being drawn last. That is the only reading an opaque pinned column can survive — a card
  lifted out of a column scrolling past has to go _under_ the sideboard, not over it — and moving
  the pinned column above the packed ones would invert it silently, with the suite still green.
- **`data-stack-open` exists so a test or a `cdp.mjs --probe` can _count_ open cards** — the CSS
  lift was observable from neither.
- **`onFocus`/`onBlur` sit on the `<li>`, not the button**, which is `focus-within`'s old reach
  and is load-bearing: `DeckCardControls` is a _sibling_ of the button, so a caret stepping into
  the stepper would otherwise collapse the card out from under itself. The keyboard opens with
  **no dwell** — a caret is a deliberate act.
- **React never listens for `pointerenter`.** It synthesises enter/leave from
  `pointerover`/`pointerout`, so `fireEvent.pointerEnter` fires an event the component cannot
  hear and the test passes having called nothing — drive these with `fireEvent.pointerOver`/
  `pointerOut`. And **`userEvent` cannot be driven under Vitest fake timers at all**: RTL's
  `asyncWrapper` waits on a real `setTimeout` it only knows how to advance through _Jest_, so
  such a test hangs to its timeout rather than failing.
- **The stack's lift is `motion`-driven, so it has no CSS transition to probe** and its
  reduced-motion opt-out is `useReducedMotion()` — see [the Motion rules](../../CLAUDE.md) in
  `src/CLAUDE.md`. That hook reads its value once at mount, so emulating
  `prefers-reduced-motion` _after_ mount proves nothing about it.
- **The reflow runs on `slow` (260ms), not on the interaction tier** — `stackCard` in
  `src/lib/motion.ts`, changed 2026-08-14 from `base`. 293px is drawer distance, and a reader
  running down a stack watches the travel on _every_ step rather than once, so 180ms read as
  snapping. It is the same three tiers; only which rung this preset sits on changed. The
  **180ms** `STACK_CLOSE_DELAY_MS` is deliberately no longer equal to it: that one is gesture
  intent and has never been derived from the tween.
- **Four card surfaces outside the editor are drag sources, all through the one `cardDraggable`**,
  carrying `{ kind: "card"; cardId; name; typeLine }`. The `typeLine` is **normalised rather than
  validated** — `readDragData` refuses a bad `cardId` or `name`, but turns an unusable type line
  into `null`, because the pile is all it decides and `Uncategorised` is already the answer for
  not knowing. The remove tray narrows to `"deck-card"`, so a card from another wall never draws
  it.
- **A printings row in the card pane is clickable to view that printing** — `store.viewPrinting`
  sets `selectedCardId` _without_ clearing `paneDeckContext`, so the swap offers survive browsing.
  `setSelectedCardId` there instead silently kills the affordance at its one moment of use.
- The editor's five full-window surfaces (Import, Categories & tags, History, Theory diff, Deck
  settings) are held in **one** piece of state, because `useDismissOnEscape` orders exactly two
  rungs and two `"inner"` peers open at once are not ordered at all. The format check rides in the
  same union, so at most one of its six registrations is ever enabled.

## The quick add

`QuickAdd.tsx` — the toolbar field, its dropdown and its status line, one component. `DeckEditor`
keeps only the *decision*: which pile the add lands in (`targetCategoryId`) and the write that
puts it there. `QuickAdd.test.tsx` covers the field itself; the Escape hand-off below is pinned in
`DeckEditor.test.tsx`, because that one is about the ladder rather than about this control. The
longer-form record of the two hand-rolled comboboxes and their shared panel is
[frontend-design.md](../../../docs/reference/frontend-design.md).

- **It is a shortcut over the docked panel's wall, not a second way of choosing a printing.** The
  search is `collapse: true`, so every suggestion is the newest printing of that name — the same
  one the panel offers first for the same text. A reader who cares which printing they get has the
  panel open beside them, so this field never grows a set column or a printing picker.
  `MAX_SUGGESTIONS` is **five**, and the ceiling is the reader's rather than the backend's: a list
  long enough to need a scrollbar has stopped being a shortcut and started being the wall again.
- **Three routes reach one write, and the third is the one that looks removable.** Enter on the
  highlighted suggestion, a click on a row, and — inside the debounce window, before any
  suggestion exists — a one-shot `limit: 1` search. That third route is the field's **original**
  behaviour and must not be deleted: the debounce is `DEBOUNCE_MS` (300ms, the same one the three
  list views use), and a reader who types a whole name and presses Enter inside it has no row to
  take. Losing it would make the dropdown a regression for exactly the readers who are fastest at
  this. It is also where the miss comes from — “No card found for …”, said in words and with the
  typed text kept, because the next action there is to correct it rather than to type the next
  card. Both requests are the same search differing only in `limit`, which is what keeps the
  top suggestion and the fallback's one hit the same card.
- **Enter takes a row only while the rows answer what is in the field _now_.** `fresh` is
  `debouncedText === text.trim() && !suggestions.isPlaceholderData`; when it is false Enter falls
  through to the one-shot search, which asks about the text that is actually there. The bug this
  prevents is adding the top hit for `sol r` while the field says `sol ring` — the debounce opens
  that window on every keystroke, so it is a real case rather than a theoretical one.
  `keepPreviousData` (there so the list does not blink empty between letters) is what makes the
  second clause necessary, and it is also why the rows are read off `text` rather than
  `debouncedText`: clearing the field changes the key to `""`, which the query is `enabled: false`
  for, so the last five rows would hang under an empty box for the rest of the session.
- **The Escape rung is `enabled: listOpen`, never `enabled: open`.** With the caret in a quick add
  whose list is closed, the press belongs to the card detail pane, which listens on `window` in the
  bubble phase — a capture-phase listener here would consume it and close nothing at all.
  `DeckEditor.test.tsx`'s "lets Escape through to the card pane when no layer of its own is open"
  focuses this very field and asserts the press arrives with `defaultPrevented` false. Escape here
  closes the list and hands focus to nobody: the field is not unmounting and is what the caret was
  in the whole time, so the hook's focus-hand-back clause has nothing to do.
- **The list is one more `"inner"` peer on this screen and deliberately outside the `Layer` union
  above**, kept apart by focus and click mechanics rather than by structure — the same arrangement
  as the docked panel's set filter. Every one of the editor's five surfaces is opened by pressing a
  toolbar button, pressing a button takes the focus out of this field, and the root's `onBlur`
  closes the list on the way. **That is the whole of what makes a third rung unnecessary**, so a
  future surface opened without moving the caret — a hotkey, an auto-open — breaks it, and the fix
  is a depth in `useDismissOnEscape`, not a second `"inner"` and a hope.
- **The query carries no `marketplace`, and that is a documented exception** to the app's rule that
  every price-bearing query carries it and has it in the key. A row draws a name, a mana cost and a
  set code and no price at all, so a currency switch has nothing to change about it, and putting
  the marketplace in the key would refetch five names for nothing every time one happened. The
  exception is valid only for as long as the rows stay priceless.
- **The caret never leaves the field, and two small things are what make that true**:
  `aria-activedescendant` moves the highlight instead of the focus — which is why the dropdown is
  a listbox and not a row of buttons, since a reader typing a name must not have to Tab into the
  answers to take one — and a row's `onMouseDown` refuses the focus a click would otherwise take,
  without which the click blurs the input, `onBlur` closes the list and the press lands on
  nothing. The highlight then follows **both** `onPointerMove` and `onMouseMove`, because the
  mouse and the keyboard must not disagree about which row Enter would take: React synthesises
  enter/leave from over/out and never listens for `pointerenter` at all, so a move event is the
  honest one.
- **The field is named for where the add lands, and a row is named by its own content.** The
  label is `Quick add a card to <pile>`, or bare `Quick add a card` under `AUTO_CATEGORY`, where
  there is no one answer because the pile is per card, so the name says only what it can promise
  — "Quick add a card to Auto (by card type)" would name a *setting* rather than what pressing it
  does. `DeckEditor.test.tsx` addresses the field by both names, so a reworded label is a suite
  failure. A row carries **no `aria-label`**: its name is the card's name, the cost's `sr-only`
  tokens and the set code, and a label carrying only the card's name would make the row
  indistinguishable from the docked panel's tile for the same card — an ambiguity that is real,
  because both are on screen at once.
- **Driven in the shipped window 2026-08-14** (`npm run tauri dev`, a **debug** build, 1280×800,
  against the real 116 703-card corpus): `sol` drew **5** rows with row 0 `aria-selected` and
  `aria-activedescendant` on it. The panel computes `z-index: 30` (`LAYER.popup`),
  `position: absolute` and `transform-origin: 0px 0px`; its left edge is **285** against the
  field's **285** and its top **199** against the field's bottom **195** — the `mt-1` — at 288px
  wide, with no right overflow and `documentElement.scrollLeft` **0**. Two ArrowDowns moved the
  highlight to index **2** with `document.activeElement` still the field, and Enter added *that*
  row rather than the top one, filed under `Creature` by its type line. A click on the fourth row
  added it, left the caret in the field, and drew the colour-identity rule break on the new card —
  so the click goes the same write-and-validate route the rest of the editor does. The miss read
  `No card found for “counterspellgoblin”.` with the field's text kept. **The Escape ladder holds
  one press per layer**: with the card pane open, the first press closed the list and left the
  pane, keeping the caret in the field, and the second closed the pane. At **1024** the field is
  208px and neither it nor the status line clips (`body.scrollWidth` 1024). The console recorder
  caught **5** entries and no error or warning.
- **Two things the pass did not cover.** Reduced motion on this panel was not emulated — it is the
  same `popup` preset inside the same `PopupPanel` as the set filter, whose reduction is already
  measured, so this would be re-measuring a shared component rather than this one. And the
  freshness guard is **unit-tested only**: reproducing a stale list live means winning a 300ms
  race by hand, which is what a test with a controlled clock is for.

## Known open bugs

Three, all found by driving the shipped window and **none of them fixed** — all from the
2026-08-11 builder pass: the title row collapsing the deck name at 1060–1350px, a custom deck
cover never appearing in the gallery, and Table view starving the card name. Detail:
[docs/reference/decks-live-findings.md](../../../docs/reference/decks-live-findings.md).

The 2026-08-12 import pass found four more and **all four are fixed**, each with a test that fails
against the code before it: the preview tally ignoring the commander choice (the `## Import`
section above — it is a TypeScript decision), and three resolver-side ones in
[docs/reference/decks-storage.md](../../../docs/reference/decks-storage.md) with their
reproductions — a printing hint trusted over the card name, `MOXFIELD_LIST`'s fabricated hints,
and `MATCH_ORDER` having no language term.
