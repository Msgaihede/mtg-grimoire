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
- **The X pile is a _heading_, not a category, and its key says so.** `X_GROUP_KEY` is `"mv-x"`
  and shares the `mv-…` namespace deliberately: it is one more mana-value heading, so no
  `deck_cards.category_id` points at it, nothing can be dropped into it, and it is gone the moment
  the reader groups by something else. Exported beside `X_GROUP_NAME` (`"Mana value X"`) so that
  no chart, story or test re-spells either one.

## Deck settings, and the two surfaces that draw them

Everything a deck carries that is not a card in it — name, format, description, notes, cover,
folder, theory — is **one component, `DeckSettingsForm`, drawn by two hosts** (2026-08-14). The
"New deck" dialog used to ask two questions and leave the reader to configure the deck they had
just made; it now asks all of them.

- **The form owns no mutation and imports no hook that reaches the backend** — not `useDeck`,
  not `useDeckFolders`, not `useFormatSpecs`. Every value and every write arrives as a prop, and
  that is precisely what lets `CreateDeckDialog` render it **before the deck exists**. The rule is
  checkable rather than aspirational: `DeckSettingsForm.test.tsx` renders it with no
  `QueryClientProvider` at all, so a stray query fails the suite rather than the review.
- **Two callbacks, because the two hosts commit differently.** `onChange` fires for every change
  including each keystroke; `onCommit` fires only for the three text fields, when the reader is
  finished with one. `DeckSettingsDialog` writes on `onChange` for the controls that settle in a
  single act (format, theory, folder, cover) and on `onCommit` for name/description/notes — which
  is exactly its old behaviour, **no Save button and not meant to have one**.
  `CreateDeckDialog` merges `onChange` into a draft and **does not pass `onCommit` at all**:
  there is nothing to write until Create.
- **`useDeckField` is the edit host's hook, not the form's** (`useDeckField.ts`, moved out
  whole). It holds the draft, commits on blur, and commits again on the dialog's *close* rather
  than its unmount — the panel outlives the flag by the length of its fade, and a write waiting
  on an animation races the editor's teardown. The form is controlled and knows none of this.
- **`deck_create` takes a whole deck now**, so the create dialog is one command and one
  transaction. Four of its rules are *not* `deck_update`'s — no `coalesce`, so an absent
  `folderId` really is the top level; `coverKind` is not settable; theory **moves** nothing (the
  patch route's `move_live_into_theory` has no live list to act on at birth); and a
  birth is **one** audit row however many fields it was born with. All four, and the reasons:
  [decks-storage.md](../../../docs/reference/decks-storage.md).
- **The cover picker searches every printing, not just the deck's own cards**
  (`DeckCoverPicker`). One grid, two modes: an empty search box offers the deck's cards, a query
  offers results. It exists because a deck being *created* has no cards to take art from, and it
  improves the settings dialog for free. `collapse: false` because different printings are
  different art and collapsing hides the choice being made; `playableOnly: false` because art
  series and tokens are some of the best crops and a cover is not a card you cast.
- **The tiles do not credit the illustrator, and that is the documented exception, not an
  oversight.** `CardSummary` carries no `artist`; `CardStack`, `GridView`, `TheoryDiffDialog` and
  the original `ChoiceTile` all draw the same crop uncredited, justified by every crop sitting
  inside a control that names its card. The **preview** is strict at both surfaces: no artist, no
  picture. At create there is no `DeckRow` to read one from, so the host fetches it with
  `card_detail` — the credit arrives with the picture and never before it.
- **The upload arm is the one thing a create cannot do in one call**, because
  `deck_set_cover_image` takes a path *and a deck id*. It runs after the create; if it is
  refused, the dialog holds the deck it made, says so, and turns its button into **Open deck** —
  a created deck is never lost, and pressing again never makes a second one.
- **`CAPTION` and `FIELD` live in `formFields.ts`**, not in `cardControl.tsx`: that module's
  subject is a deck card drawn as a control and it pulls in the drag machinery, which a dialog
  asking for a deck's name has no business importing.

## Writes

- **A write to what is _in_ a deck goes through a `useDeck` mutation**, and `DeckEditor`'s
  `newestWrite([...])` counts **six** of the hook's eight: update (rename, cover, Built toggle,
  the `Split X` chip), add-card, set-quantity, move, missing-to-wishlist, swap-printing. The X
  chip is a **deck-row** write riding the same `update` as the other three, so it is not a seventh
  mutation and it touches not one `deck_cards` row. The two outside the six are `setTag` and
  `rememberView`, each for its own reason stated on its definition.
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
- **The audit field for the X split is `"xGroup"`, the one multi-word field name in that switch,
  and the drift is silent.** Every other arm is a single lowercase word, so this is the first place
  `deck.rs`'s spelling and `auditText.ts`'s can part company with nothing going red: the `default`
  arm answers an unrecognised field with "Changed the deck", which is true of every deck edit and
  therefore never fails. **Deriving it from the column gives `separateX`, which is wrong** — the
  Storybook fake guessed exactly that before it was corrected — so `auditText.test.ts` pins the
  right word _and_ the wrong-but-plausible one. Copy the word from `deck.rs`; never re-derive it.
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
  `kind: null`. So anything that keys on a kind — `GroupHeader`'s `RULE` marker, the two column
  views' Sideboard rail — still sees a sideboard in the two modes that otherwise have no categories
  in them, which is the right answer in both cases and is a special case in neither.
- **The deck stats are a band at the foot of the editor, and there is no control that hides
  them** (changed 2026-08-14). They were a 280px aside on the desk row with a `Stats` toggle in
  the toolbar, and the aside's width was subtracted from `DECK_FLOOR` before the docked search
  panel was asked whether it fit — so opening Stats at 1280 with a card pane docked cost the
  reader their search, and the toggle existed to give that width back. Full width under the deck
  the four charts sit on one line and nothing on the desk is traded for them. Three consequences,
  each measured in the shipped window and none of them visible to a test:
  **(1)** the band sits **below the price strip**, because that strip is where the remove tray is
  drawn for the length of a drag (`-top-3` over the gap under the deck) and a band between them
  would put four charts between a card and the one drop that takes it out;
  **(2)** the editor is an `overflow-y-auto` **page** now — the deck, the strip and the band come
  to **847px** in the **710px** a 1280×800 window leaves, so the deck holds a `min-h-96` floor
  (**384px** = one whole stack card and its group heading) and the band's last ~137px is one
  scroll away, while at 1920×1080 nothing scrolls at all and the deck takes the surplus (**612px**);
  **(3)** `DECK_FLOOR` dropped **208 → 192**, because that page scroller is a second scrollbar the
  row's arithmetic did not count — the same 16px correction, for the same reason, as the drop from
  224 to 208. Without it the panel railed at 1280 with a card pane open (**602 − 400 = 202**), and
  `scrollbar-width: thin` is not an answer: it costs 10px instead of 15 and lands on **207**, one
  pixel short.
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
- **`Split X` is a _modifier_ of the mana-value grouping and not a fourth mode.** The chip is
  drawn only under `groupBy === "manaValue"`, and it lives inside that select's own `gap-1.5`
  cluster rather than out in the toolbar's `gap-x-4`, because a control that persists across a
  grouping it has no effect on is a control the reader has to remember the scope of. The
  inertness is **structural, not a branch to keep in step**: `separateX` is passed to
  `manaValueBucket`, which only the one `manaValue` arm of `buildGroups` calls.
- **In a deck the X rule is _exclusive_; in search the same idea is _additive_, and the opposition
  is deliberate on both sides.** Here a card printing `{X}` is in the X group **and nowhere
  else** — a heading counts copies and sums prices, so a card in two groups makes the headings add
  up to more than the deck and nothing on screen says which one lied. In search the chips are an
  OR over rows, where finding a card twice is not a thing that can happen, so `{X}{B}{B}{B}`
  answers the mana-value-3 chip **and** the X chip. **Do not "fix" either one into agreeing with
  the other**; they are answering different questions about the same card.
- **X sorts at 9, and `mv-unknown` moved 9 → 10 to let it.** Like `8 or more`, X is open-ended
  rather than a number, so it belongs at the tail and not at the head where a reader counts their
  cheapest spells; `unknown` stays behind it because it is the absence of an answer rather than an
  answer. **The X test runs _before_ the `cmc === null` check**, which is the second half of the
  same rule: an `{X}` in the printed cost is knowledge, so a row with a null `cmc` and an X in its
  cost is X, never unknown.
- **`{X}` only, never `{Y}` or `{Z}`** — `hasVariableCost` in `src/lib/mana.ts`, going through
  that file's one `SYMBOL` regex rather than a second, looser spelling of what a symbol is.
  `validation/engine.ts`'s `symbolValue` scores all three as 0 and is right to: it answers _what
  is this cost worth_. A heading answers _what is this pile called_, and a `{Y}` un-card filed
  under X is a heading telling the reader a lie about the cardboard in front of them.
- **The switch is the _deck's_, not the editor's**: `decks.separate_x_group` (schema v13), read off
  the loaded row as `separateXGroup` and written through `useDeck.update` — **never `useState`**,
  and never `rememberView` either. Both halves of that matter. `groupBy` and `sortBy` are also
  remembered per deck now (`lastGroupBy`/`lastSortBy`), but they are remembered as _where the
  reader had got to_, which is why the command that stores them moves no `updated_at` and writes
  no history. Splitting the X spells out is a **change to the deck**, rides the same `deck_update`
  as the rename and the cover, and is audited as one. This one is an answer about a particular
  curve: a storm list where half the spells are `{X}` reads quite differently from an aggro deck
  with one Fireball in it. It reaches no rule — not size, not copies, not legality, not the
  allocator — and nothing in `validation/` has heard of it or should.
- **`DeckStats` honours the flag under _every_ grouping while the chip that sets it is drawn under
  one, and that is a decision with a known cost rather than an oversight.** `DeckEditor` reads the
  flag once and hands the same value to `buildGroups` and to `DeckStats`, because a curve counting
  `{X}{B}{B}{B}` as 3 beside a column headed `Mana value X` is two surfaces answering one question
  about one deck two ways — the failure this folder's rules keep naming. The deck's answer does
  not stop being true because the reader went back to their categories. So a reader grouped by
  `category` or `type` can see a split curve with **no control on screen to unsplit it**; the
  pairing is what must hold, and this is what it costs.
  **`lastGroupBy` narrows that cost to a session, and knowing which kind of gap it is decides
  whether it is worth repairing.** The grouping is stored on the deck too, so a deck left under
  `manaValue` reopens under `manaValue` and the chip comes back beside it — nobody _returns_ to a
  split curve with no control for it, which was the version of this worth worrying about. What is
  left takes a deliberate press in the same sitting: group by something else and the chip goes
  with the mode it belongs to, while the curve keeps answering for the deck. One press back
  brings it, and that press is now remembered.
- **The average mana value does not move when the flag flips**, and it is the one number the
  split deliberately does not reach. An `{X}` spell costs what it costs with X at zero
  (CR 202.3b) — `{X}{B}{B}{B}` is 3 — and the toggle is a display choice about which bar a card is
  drawn in, not a claim that the card stopped costing three. `DeckStatsSummary.variableCost` is
  `null` rather than `0` when the deck is not splitting, for the reason `averageManaValue` is
  `null` rather than `0` for a deck of nothing but lands: "there is no X bar" and "the X bar is
  empty" are different sentences, and the second is worth drawing. The bars still sum —
  `sum(curve) + (variableCost ?? 0) + unknownManaValue` is `nonlands` in both modes. The tenth
  bar's width arithmetic, and why the 280px panel did not grow to hold it, are in
  [decks-storage.md](../../../docs/reference/decks-storage.md).
- Only `Stacks` and `Grid` fetch a picture, and it is the **whole card** —
  `cardImageUrl(…, DECK_CARD_VARIANT)`, which is `grid`, and which must stay paired with
  `images::prewarm_keys`' `DECK_PREWARM` arm in Rust. **Getting that pairing wrong is invisible**:
  the pre-warm reports success and every tile then fetches cold anyway.
- **`Stacks` and `Text` wrap their columns downward — neither view grows sideways any more**
  (changed 2026-08-14). Both pack a deck's groups into fixed-width columns —
  `stackColumnWidth(zoom)`, 224px at 1×, and the text view's 300px — and both used to open the
  next column _to the right_, so a fifteen-category deck ran off the edge and put an X scrollbar
  across the whole desk. That is the one thing the 1024px floor forbids, reached by the one route
  `DECK_FLOOR` never measured: **192** is the width the deck side is _guaranteed_, and it does not
  hold even one column — nor did the 208 it dropped from, nor the 224 before that. That floor
  governs how the desk row is *divided*; it has never said anything about what the pack does inside
  the view's share of it. The packed row is a `flex-wrap` container now, so a column that will not fit goes
  **below** the line and the reader scrolls down, which the desk already did. `overflow-auto` stays
  rather than becoming `overflow-y-auto` — one column zoomed past the desk's own width really is
  wider than its box, and clipping a card is worse than a scrollbar the reader asked for. Wrapping
  is what makes that the rare case instead of the ordinary one. **Driven 2026-08-14** on a seeded
  16-category deck: no X scrollbar at 1024, 1280 or 1920, the two wrap thresholds exact, and the
  rare case contained to the view rather than the page — every figure in
  [frontend-design.md](../../../docs/reference/frontend-design.md).
- **The rail costs a column of flow, and at the app's own window that is the column.** Measured
  live: at 1280×800 with the search panel docked the view is **602px**, so the rail's 224 and the
  16px gap leave **362 — room for exactly one**. The same deck that used to show ~2.7 columns
  across a sideways scroll is thirteen stacked lines now. That is the trade and it was made
  deliberately: the reader asked for the Sideboard to be somewhere fixed, and a pile they can
  always find is worth more than a column they have to scroll to. **It is also the number to
  check first** if the rail is ever widened or the columns narrowed.
- **The Sideboard is a rail pinned to the right of the flow, and is never packed.** `splitSideboard`
  in `views/columns.ts` takes it out before the pack runs, on **`kind === "side"` and nothing else**
  — the name is the user's (`DECK_CATEGORY_GRAIN` is `(deck_id, name)`, so any pile may be called
  "Sideboard"), and the kind is what the rules read. It used to be the greedy pack's worst case: a
  category like any other, so it landed wherever the run put it, which on a long sideways run was
  off the right-hand edge. **`packColumns` keeps its whole contract** — greedy, in the reader's
  order, never reordering, never splitting a group, an over-tall group taking its own column —
  and is simply handed fewer groups. The rail is drawn for an **empty** Sideboard too: an empty pile
  is where the next sideboard card goes, and a rail that appeared with the first card would move the
  layout under the reader's hand. **No group with that kind is no rail at all** — and which groups
  carry the kind is `buildGroups`' answer, never a view's. Under `Group by` mana value or type the
  derived buckets are headings with `kind: null` and they flow, but **every switched-off category
  is appended as itself**, so a reader who turns the Sideboard off and then groups by mana value
  gets a rail beside a layout made almost entirely of headings. The split reads `kind` and nothing
  else — not `isActive`, and never `groupBy`, which would push a deck concept into the one file
  here whose whole discipline is not knowing what a deck is. A group in the rail is the same
  `StackGroup`/`TextGroup` as a group in the flow, so its `aria` and its drop target come with it
  rather than being defined twice.
- **The narrow case is CSS, and has to stay CSS.** The flowing area carries a `minWidth` of one
  column, so when the desk cannot hold a column _and_ the rail side by side, the outer container's
  own `flex-wrap` drops the rail onto the next line — `ml-auto` is what keeps it on the right when
  it lands there, and a no-op at every other width. `min-w-0`/`flex-1` cannot say this, because a
  flex item that may shrink to nothing never wraps; a `ResizeObserver` could, and is refused —
  **this view has no business observing its own box** (`DEFAULT_COLUMN_HEIGHT`'s doc: the editor
  measures the scroller and passes the height), and a second reading of the same box answers a frame
  behind the layout it is reacting to. The widths, and the law behind all three of these bullets:
  [frontend-design.md](../../../docs/reference/frontend-design.md).
- **The rail is a plain flex child and nothing about it is sticky**, which is the one thing to read
  before reinstating anything. It was briefly `sticky right-0` over an opaque `bg-bg` at
  `LAYER.raised` with a leftward seam shadow, and all four existed for a single reason: to hold the
  rail in view **while the packed columns scrolled sideways underneath it**. The columns wrap
  downward now, so nothing passes under the rail — an opaque backdrop occludes nothing and a seam
  shadow draws a permanent divider across a layout in which nothing moves. `ml-auto` is the whole
  mechanism that is left. The rail therefore carries `SIDEBOARD_ATTR` **only**: `STACK_COLUMN_ATTR`
  means "a box `packColumns` produced", and the rail is by construction the one box it never saw,
  so a sweep counting columns goes on counting what the packer decided. `views.test.tsx` asserts
  those four absences alongside the classes, because reinstating a sticky rail is a two-word edit
  no other test would notice.
- **Scoped to `side` and deliberately not to the other two `RULE_KINDS`** — a commander is one card
  and a companion is one card, and railing either would spend a column's width on a pile that is
  read at a glance. What it prevents at the other end is a drag with no destination on screen: the
  Sideboard sorts last, so packed it was the far end of the run, and a card dragged out of the main
  deck had nowhere to be let go of. The rail is drawn only when a `side` group exists, and **that
  condition is real for a story and not for the app**: `PREDEFINED_CATEGORIES` seeds a Sideboard
  into every deck, a category group draws whether or not anything is in it, and a predefined pile
  cannot be deleted — so under `category` the rail is there from the moment a deck is created, empty
  or not. **It costs `stackColumnWidth(zoom)` beside the flow** — 224px at 1×, 434px at 2×, both
  derived from that one function — which at 2× on a 1280px window is a third of the width standing
  beside a pile that on a new deck holds nothing. The wrap is what makes that bearable rather than
  what removes it: below one column plus the rail, the rail takes its own line instead. **The sticky
  rail's live figures went with the sticky rail** — the `position: sticky`, `z-index: 10` and
  occlusion readings taken on 2026-08-14 measured the one-commit implementation this branch
  replaced, and nothing about the wrapping layout has been driven in the window yet.
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
  **`LAYER.raised` has one occupant in this view and that is deliberate**: the rail took the same
  rung for as long as it was an opaque sticky column, which made the two orderable only by document
  order. It is a plain flex child now and asks for no z-index at all, so an open card's list is the
  only thing raised here and there is nothing for it to be ordered against.
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
