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
- **An add that names no category is filed by what the card _does_; an add that names one is
  untouched** — so every _drag_ overrides the rule by construction. The rule is `autoCategoryFor`,
  applied on **`useDeck.addCard`'s single definition**. Three steps, in this order: a front-face
  type line saying `Land` is **pinned to `Land` before tags are consulted**; else the first of
  **thirteen** Oracle-tag buckets whose anchor slugs the card's tags reach (Removal, Ramp,
  Recursion, Draw, Tutor, Protection, Anthem, Stax, Tokens, Sacrifice, Lifegain, Mill, Burn — the
  order _is_ the rule); else the old card-type answer. `null` (an orphan, or a layout with no
  bucket word) is `Uncategorised`; **absent** is `DEFAULT_CATEGORY_NAME`.
- **The empty slug list is the floor, not an error**, and every path preserves it: a database that
  has never downloaded the taxonomy, a card Tagger has never tagged, an unknown printing and a
  refused tag read all file by type line. **Nothing about categorising a card may fail an add** —
  `useDeck`'s `oracleTagsFor` catches and answers `[]`, and its doc comment says not to turn that
  into a rethrow. The one place that refuses instead is the Categories panel's bulk action, whose
  blast radius is every loose card in the deck rather than one.
- **The tags are read at the rule, and that is a deliberate reversal.** This used to say the fact
  travels from the call site so no add pays a round trip — true while the fact was a type line the
  drag payload already carried. **No list DTO carries a slug list**: `CardSummary`, `CollectionRow`
  and `WishRow` say what a card _is_, and `CardSummary` has no `oracleId` either, so the four drag
  sources have nothing to carry. `ipc.oracleTagsForPrintings` is called in the one arm that needs
  it — a named `categoryId` and an absent `typeLine` both make **no** call — and it costs one
  local-SQLite round trip on a deliberate user act. **Match its answers by `cardId`, never by
  position**: blank and duplicate ids are dropped, so the array can be shorter than the request,
  and a deck holding one card in two categories sends that id twice.
- **The Land pin exists because there is no `land` tag.** Lands are a card type, not a function, and
  **618 of 1 196 land cards (51.7%) carry a functional tag** — Prismatic Vista is `tutor`, Savai
  Triome `card-advantage` — so without the pin a deck's mana base scatters across a dozen piles.
  The pin lives **inside `autoCategoryFor`** and no call site may short-circuit it; a caller that
  checked the type line first would be a second copy of the rule.
- **Recursion outranks Draw on purpose**, and it looks wrong: `regrowth` has _two_ parents,
  `recursion` and `card-advantage`, so Eternal Witness and Regrowth match both. **Burn is last and
  tiny for the same kind of reason** — `burn-creature`'s parents are `removal-burn` and
  `removal-creature`, so Removal claims Lightning Bolt first. Neither is a defect to tidy.
- **The "Add to" select's default is `AUTO_CATEGORY`, which is `0`, and that zero fixed a real
  bug** — a deck's seeded categories are in `PREDEFINED_CATEGORIES` order, so a clamp to
  `categories[0]` put every quick add on a fresh deck into **Commander**. Zero now _means_ auto,
  nothing overwrites it, and an explicit pick **stays** picked.

## Writes

- **A write to what is _in_ a deck goes through a `useDeck` mutation**, and `DeckEditor`'s
  `newest([...])` counts **six** of them: update (rename, cover, Built toggle), add-card,
  set-quantity, move, missing-to-wishlist, swap-printing.
- **There is no remove mutation.** The tray's drop and the stepper's zero are both
  `setQuantity(…, 0)`, because zero removes a deck row.
- **The refusal rule lives on the single definition in `useDeck.ts`, never on a call site** — two
  definitions would be two places to keep one rule. The two surfaces outside the editor
  (`useSwapFromPane`, `useSidebarDrops`) borrow a mutation whole and own only their own reporting.
- The deck _row_ is a different hook: the gallery's `useDecks` owns create, update, remove and
  duplicate.
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

`import/` is `parse.ts` (text → lines), `plan.ts` (lines + the printings Rust resolved + **their
Oracle tag slugs** → piles, a commander, tallies), `useDeckImport.ts` (the writes) and
`ImportDeckDialog.tsx` (two steps, one panel, nothing written until Import).

- **`plan.ts` stays pure and takes the slugs as an argument.** The tag read is chained inside
  `useDeckImport`'s `resolve` mutation, after `deck_import_resolve` and in the **same**
  `mutationFn` — **one** `oracleTagsForPrintings` over the deduped matched ids for the whole list,
  never one per line. Putting it there rather than in the planner is what closes the tally-flicker
  hole *by construction*: the dialog crosses to step two in that mutation's `onSuccess`, so the
  preview is never reached holding only the printings and there is no window in which a type-line
  tally is on screen waiting to be redrawn. A refused tag read files the whole list by type line
  and never costs the reader their paste. The Rust half and every measurement:
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
price | type`). An **inactive category stays its own group in all three grouping modes** — as long
  as it holds cards.
- **An empty category draws no heading**, and the exception is the four seeded
  `PREDEFINED_CATEGORIES` (Commander, Sideboard, Companion, Maybeboard), which draw empty because
  they are the fixed zones and an empty command zone is itself a fact about the deck. The rule is
  `grouping.ts`'s **`drawsWhenEmpty`**, in one place so it can be narrowed to Commander alone
  later, and it takes a `Pick<CardGroup, "isPredefined">` so it **structurally cannot read the
  name** — a pile a user called "Sideboard" is theirs and hides like any other. Derived groups
  (`manaValue`, `type`) are built _from_ cards, so an empty one never existed to hide.
- **Empty and inactive are independent, and conflating them is the mistake to avoid**: an inactive
  category _holding cards_ still draws, and the empty seeded Maybeboard draws too.
- **Filtering therefore also decides which headings exist.** The filter runs before the grouping,
  so a category the filter empties is an empty category and stops drawing. That is deliberate — a
  filter matching three cards should not answer with twenty headings — but the shape of the deck
  changes as the reader types, and **a hidden category is not a drop target**. The per-card
  "Move…" select and the panel's "Add to" select both build from the category list rather than
  from the drawn groups, so every empty category stays reachable by name.
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
- **`CardStack` is arithmetic, not taste.** The card's height is _derived_ — a Magic card's aspect
  applied to the fixed column width, plus the data line less its rise, **319px** — and the
  collapsed **−285px** margin leaves a **34px** reveal, a legibility floor for the overlaid tag
  rather than a fraction. The list gets a fixed `stackHeight(n) = 34(n−1) + 319 + 8`, and the open
  card's margin turns −285 into +8: a **293px** push-down of every later card, out of a box whose
  height does not change.
- **The stack's controls are revealed by the card being _open_, never by `group-hover:`**
  (`revealedWhenOpen`). A collapsed card's only hittable part is its 34px strip, so hovering it
  used to reveal a control bar hundreds of pixels below, behind three other cards. They are a
  vertical column in the card's right margin now — `DeckCardControls layout="card-column"`, which
  is also the only layout whose buttons carry a backing, because it is the only one drawn on art.
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
  rungs and two `"inner"` peers open at once are not ordered at all.

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
