# Decks: storage, commands, allocator, audit

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- **Enforced foreign keys exist only _between user tables_, never against `cards.id`** — a
  declared `REFERENCES cards(id)` aborts every sync, because `swap_staging` drops the table.
  The `ON DELETE` action is chosen per delete-site, not fixed once. **CASCADE** on
  `deck_cards.deck_id`, `deck_cards.category_id`, `deck_allocations.deck_id`,
  `deck_allocations.collection_entry_id`, `deck_categories.deck_id`, `deck_tags.deck_id`,
  `deck_audit.deck_id` and `deck_folders.parent_id`: a deleted deck's cards and reservations,
  a deleted category's cards and a deleted folder's sub-folders have nowhere else to be.
  **SET NULL** on exactly two — `decks.folder_id` (a folder is a filing decision; the decks in
  it are the user's work, not the folder's to take down) and `deck_cards.tag_id` (deleting a
  tag must never delete a card). `schema.rs`'s module doc carries this list; check it against
  the DDL rather than trusting either copy. CASCADE is also right at the app's one **non-user**
  delete: `reconcile::fold_into_existing` repoints every allocation onto the surviving entry
  _before_ the DELETE, so that cascade fires over nothing.
- **Schema v8 replaced the zone with a category the user owns.** `deck_cards.category_id`
  points at a `deck_categories` row they name, reorder, switch off and delete; the fixed word
  survives only as that row's **`kind`** — `main | side | commander | companion | maybe`,
  `schema::CATEGORY_KINDS`, CHECK-constrained in SQL and narrowed in TS as `CategoryKind`.
  **The name is the user's; the kind is what the rules read.** Four kinds get one predefined
  category per deck (`schema::PREDEFINED_CATEGORIES` — Commander, Sideboard, Companion,
  Maybeboard, seeded by `deck_meta::ensure_predefined_categories` and by the v8 backfill);
  there is deliberately **no predefined `main`**, because a deck may own any number and the
  pile a plain add lands in is found-or-created by name (`deck_meta::category_for_name`).
  **Deck cards side with the wishlist: `CHECK (quantity > 0)`, so zero removes the row.**
- **The grain is `deck_id, variant, category_id, card_id`** (`schema::DECK_CARD_GRAIN`) — the
  same printing in two categories is two rows, added twice in one is one row with the sum, and
  `variant` widens it again: `live` is what is sleeved up, `theory` is what the deck is being
  built toward (`schema::DECK_VARIANTS`), so a change tried out in Theory can never silently
  overwrite the deck as it stands. Every card command takes both.
- **`is_active = 0` is the whole of what `maybe` used to mean.** An inactive category counts
  toward nothing — not size, not copies, not legality — and `allocate_deck` claims no copy for
  it. The Maybeboard is not a special case in five files any more; it is one seeded row with
  the flag off, and a category of the user's own that they switch off behaves identically.
  **Nothing anywhere may branch on the kind being `maybe`** — that was measured: the old shape
  looked correct and was wrong the first time a user deactivated a pile of their own.
- **Which totals a pile lands in: the switch decides whether it counts at all; the kind
  decides only whether it is played _beside_ the deck or _in_ it, and only `side` and
  `companion` are beside it** (CR 100.4a; EDH's companion is "effectively a 101st card"). So
  `SIZE_KINDS` is `main`, `commander` **and `maybe`** — written in three places that must stay
  one rule: `engine.ts`'s constant, `deck.rs`'s `DECK_SELECT` subquery behind
  `DeckRow.card_count`, and the Storybook fake's copy. Leaving `maybe` out is the incoherent
  version, not the smaller one: an _active_ Maybeboard was then inside the format's card pool
  and inside the binder's reservations but outside the size, so a second Sol Ring in it raised
  a singleton error under a figure that still read 100.
- **`allocate_deck` claims for the `live` variant only** — a plan reserves nothing. And
  **`deck_allocations` carries no variant column**, which is the trap: a `theory` read walks
  the _live_ deck's stored claims, so `attribute_owned` filters `variant == LIVE` explicitly.
  Without that filter a plan is handed the copies the sleeved deck reserved, and it type-checks
  perfectly (`the_allocator_claims_nothing_for_the_theory_variant`).
- **`deck_get(id, variant)` scopes the cards, and every number counted over them, and nothing
  else.** All categories and all tags come back whatever the variant — an empty category still
  draws its column, an inactive one always draws — but a category's _and a tag's_ `card_count`
  read the variant asked for. Threading it into `list_categories` and not `list_tags` is
  exactly how they came to disagree once.
- Category and tag writes live in **`deck_meta.rs`**, and **two of them reallocate**:
  `set_category_active` (the flag is the whole of what the allocator allocates _for_) and
  `delete_category` (the cards leave, or land under a category with a different flag). A
  rename, a reorder and every tag write change what a pile is _called_ and claim exactly what
  they claimed before.
- **`format_specs` is data, not code.** All 23 Scryfall legality keys plus `casual`/`limited`,
  seeded by `INSERT OR REPLACE` in the migration, with `restricted_semantic`
  (`max_one` | `banned_as_commander` — TRAP A, never inferred from the key), `commander_rule`,
  `sideboard_max`, `allows_companion`, `max_mana_value` and `enabled_in_picker` as columns. A
  rules change is a **new migration step re-running the seed constant**, never an engine
  branch, and a new format is a row. Never derive one format from another.
- **Validation is TypeScript** (spec §3), in `src/features/decks/validation/`: `engine.ts`
  (size, copy limits, restricted semantics, legality), `singleton.ts` (exact-phrase
  exceptions, re-derived from oracle text and never a card list), `commanders.ts`
  (eligibility, partners, colour identity), `companions.ts`, `bracket.ts` (advisory only —
  the engine does not import it). Rust supplies **facts** (`DeckCardRow`: per-printing
  `legalities`, `color_identity`, P/T, `ever_uncommon`, `game_changer`); TS draws every
  conclusion. `oldschool` is the one printing-sensitive key, and it comes out right with no
  special case because each row carries its own printing's answer.
- **A deck card's unit price is the nonfoil `usd` key of that printing's `prices` blob** — a
  deck names a printing, not a finish, so nonfoil is the cheapest way to satisfy it.
  `cards.price_usd` is a fallback chain and is never summed, here least of all.
- **Owned is an allocation, never a decrement.** `deck::allocate_deck` deletes and rebuilds a
  deck's rows inside the caller's transaction, greedily and deterministically: `KIND_PRIORITY`
  (`commander, main, side, companion, maybe` — a tie-break preference only, since `is_active`
  decides what is allocated for) then row id, and within a card, exact printing, then real
  copies, then oldest entry. It runs on **a card write, the Built toggle, `missing_to_wishlist`,
  `set_category_active` or `delete_category`** — those five and nothing else, which is worth
  knowing while debugging, because pressing "Send missing to wishlist" or switching a pile off
  rebuilds a deck's allocations as a side effect. A **built** deck's claims are subtracted from
  what other decks can see. The
  read clamps with `min(allocation, entry.quantity)`, so stepping a collection row down is
  honest immediately — but **growing the collection does not re-run the allocator**, so a deck
  reads the new copies only after its next allocator run. Known, named, and Plan 6's to close.
- Deck cards ride **`images::prewarm_keys`' UNION** (one arm, `grid` only, like the collection
  and wishlist arms) and the reconciler's **three-table sweep**
  (`collection_entries`, `wishlist_entries`, `deck_cards`).
- **The audit log records facts; TypeScript writes the sentence.** `deck_audit` has no `summary`
  column and never will — it holds `kind` (one of `add|remove|quantity|move|swap|tag|category|
folder|deck`, `schema::AUDIT_KINDS`), `variant`, a soft `card_id`/`card_name`, a **JSON
  `payload`** (`CHECK (json_valid(payload))`) and a signed `delta` for the day header's roll-up.
  `src/features/decks/auditText.ts` is the only thing that reads that payload, and it is the only
  thing that words it — because a sentence is domain logic and this table has to survive the day
  the wording changes. Verified live 2026-08-11: a category move stored
  `{"from":"Main deck","to":"Ramp"}` with `card_name` `"Vampiric Tutor"` and `delta` 0, and the
  drawer read back "Moved Vampiric Tutor / Main deck → Ramp".
- **Writing history is not a command.** There is no IPC write — `deck_audit::record(tx, …)` is
  called _inside the caller's already-open transaction_, which is what makes
  `a_recorded_change_that_rolls_back_leaves_no_history` and `a_refused_write_leaves_no_history_
behind` true rather than hoped for; `every_deck_write_leaves_exactly_one_audit_row` drives
  **23** cases and asserts exactly one row each (count the list in `deck_audit.rs`, never a
  remembered number — it has been written down wrong twice). "Exactly one" is per
  _command_, not per field: **`deck_update` records one row per changed field**
  (`record_deck_edit`, pinned by `a_patch_that_changes_two_fields_records_both`), and it
  satisfies that test only because every one of its cases changes exactly one field. The only
  command is the read, `deck_audit_list(deckId, limit)`, and its limit is `clamp(1, 500)` —
  **the low end is load-bearing, because SQLite reads a negative `LIMIT` as no limit at all.**
  It is append-only, never pruned and **not undoable**; `AuditDrawer.tsx` has no mutation in it.
  **Six writes record nothing on purpose**: `delete_deck` (CASCADE takes the history with the
  deck, so a row would be orphaned by its own event); **both** `missing_to_wishlist` commands,
  `deck`'s and `deck_theory`'s (they write the wishlist, not the deck); and **three of the four
  folder writes** — create, rename and move — because a folder belongs to no deck and
  `deck_audit.deck_id` is `NOT NULL`. `deck_folder_delete` is the fourth and is **not** exempt:
  `decks.folder_id` is `ON DELETE SET NULL`, so it re-files N decks and writes one `folder` row
  per deck it un-filed.
- **The six card commands, and what each takes.** `deck_get(id, variant)`;
  `deck_add_card(deckId, cardId, categoryId, categoryName, variant, quantity)` — **either an id
  or a name**, id wins when both arrive, neither is refused in words, and the name is
  found-or-created (the word being TypeScript's `autoCategoryFor` to compute, because which
  pile a card belongs in is domain logic); `deck_set_card_quantity(deckId, cardId, categoryId,
variant, quantity)`; `deck_move_card(deckId, cardId, fromCategoryId, toCategoryId, variant)`,
  which stays inside one variant; `deck_swap_printing(deckId, fromCardId, toCardId, categoryId,
variant)`; `deck_missing_to_wishlist(deckId)`, which reads `live` and skips inactive
  categories. Two fences every write opens with, **neither of them enforced by the DDL**: the
  variant must be one the schema knows, and the category must belong to _this_ deck —
  `deck_cards.category_id`'s FK only asks that the category exist, not whose it is.
- **An add that names no category is filed by the card's type line; an add that names one is
  untouched.** So every _drag_ overrides the rule by construction — pointing at a column is
  naming a category — and nothing in the write path has to tell a gesture from a press. The rule
  is `autoCategoryFor` and it is applied on **`useDeck.addCard`'s single definition**, which takes
  an optional `typeLine`; the _fact_ travels from the call site, because that is where a type line
  already exists. That arrangement is the whole point: the rule stays one TypeScript function
  (CLAUDE.md's boundary — Rust supplies facts, TS draws conclusions) and **no add pays a round
  trip to discover what it is adding**. `null` (an orphan, or a layout with no bucket word) is
  `Uncategorised`; **absent** — a caller with nothing to say — is `DEFAULT_CATEGORY_NAME`, a
  fence no surface reaches today.
- **The "Add to" select's default is `AUTO_CATEGORY`, which is `0`, and that zero fixed a real
  bug.** `DeckEditor` already held `0` as a sentinel meaning "nothing picked yet" that its clamp
  replaced with `categories[0]` on the first render with a deck — and a deck's seeded categories
  are `PREDEFINED_CATEGORIES` in order, so **`categories[0]` is Commander**: on a fresh deck every
  quick add and every panel press landed in the Commander pile, with the field labelled "Quick add
  a card to Commander". Zero now _means_ auto, nothing overwrites it, and the clamp narrows to
  what its own first sentence always claimed — repairing an id whose category has actually left
  the deck (which now falls back to auto, not to somebody else's first column). An explicit pick
  **stays** picked, so ten cards into the Sideboard is one choice and ten presses. Each tile's
  `+` names the pile it computed ("Add Sol Ring to Artifact"), which only works because
  `autoCategoryFor` reads the type line and nothing else — a rule with more inputs could not
  promise the answer before the press.
- **A write to what is _in_ a deck goes through a `useDeck` mutation, and `DeckEditor`'s
  `newest([...])` counts six of them** — update (the rename, the cover and the Built toggle),
  add-card, set-quantity, move, missing-to-wishlist, swap-printing. **There is no remove
  mutation**: the tray's drop and the stepper's zero are both `setQuantity(…, 0)`, because zero
  removes a deck row. The deck _row_ is a different hook — the gallery's `useDecks` owns create,
  update, remove and duplicate, and `useDeck.update` is that same `deck_update` narrowed to the
  open deck, which is how the Built toggle is one of the six. A refused write re-reads the deck
  through whichever of the six answered last, so a sibling's GONE is what turns the columns
  into the gone paragraph. Two surfaces outside the editor
  borrow a mutation whole rather than defining one — `useSwapFromPane` (the card pane) and
  `useSidebarDrops` (the sidebar's Decks entry) — and **the refusal rule lives on the single
  definition in `useDeck.ts`**, never on a call site: two definitions would be two places to
  keep one rule. The borrowing site owns only its own _reporting_ (per-call `mutate`
  callbacks).
- **`deck_swap_printing` is one transaction that folds on `DECK_CARD_GRAIN`.** Swapping a
  row to a printing the same category already holds is not an error and not two rows: the
  `ON CONFLICT (deck_id, variant, category_id, card_id) DO UPDATE` sums the quantities and the
  answer carries `folded: true` with the landed total, which the pane announces ("Folded into
  one row of 2 in Main deck." — the category's own name, out of `paneDeckContext`, which
  carries a category id **and** its name because the pane is a sibling of the editor and has no
  category list to translate an id through). It refuses same-printing, a missing from-row
  (naming the category), a raced sync (the to-printing has left `cards`), and a **different
  oracle card** — the guard is inside the transaction, because "swap this printing" must never
  become "swap this card".
- **The deck has four views** — `Stacks | Table | Text | Grid`, `DeckEditor`'s `VIEWS`, crossed
  with three `Group by` modes (`category | manaValue | type`) and four sorts (`alphabetical |
manaCost | price | type`). All twelve combinations were driven live 2026-08-11; grouping and
  sorting were correct in every one, and an **inactive category stays its own group in all three
  grouping modes** rather than being folded in by mana value or type. Only `Stacks` and `Grid`
  fetch a picture, and it is the **whole card** — `cardImageUrl(…, DECK_CARD_VARIANT)`, which is
  `grid`; `Table` and `Text` are text and draw nothing —
  which is why the old single-row view's thumbnail, its `17rem` container query and
  `STACK_MAX_WIDTH` are gone rather than moved.
- **A deck card is the whole card, and the app's marks are overlays on it.** Both picture views
  drew the 626×457 `art` crop inside three app-built bands until 2026-08-12, which showed the one
  part of a card that does not say what it is: no printed frame, no type line, no rules text, no
  P/T. Now the picture _is_ the card and the frame is gone — with it went `identityTint` (a
  printed frame is already that colour) and the app-drawn name and mana cost, which is why
  `deckCardName` on the button is the **only** name a screen reader gets and the fallback writes
  the name in text. **The marks go right, never left**: a printed name is left-aligned and a
  collapsed stack is read down its reveal strip, so a quantity chip on the left would cover the
  one thing identifying the card. It covers the printed mana cost instead — the table view, the
  pane and the curve all still carry that.
- **`CardStack` is the signature interaction, and it is arithmetic, not taste — and the card's
  height is now _derived_ rather than chosen.** It is a Magic card's aspect (the `grid` image's own
  488×680) applied to the 210px that `StackView`'s **fixed** `14rem` column leaves after its
  padding and the card's border: **295px**. Collapsed it carries a **−261px** bottom margin, so
  each card advances by **34px** — a legibility floor for the overlaid chip rather than a
  fraction, and unchanged from when 34 was the app's own title bar. The list is given a **fixed**
  `stackHeight(n) = 34(n−1) + 295 + 8`, and the open card's margin turns −261 into +8:
  **a 269px push-down of every card after it, out of the box and over what is below, without the
  box changing size.** The column is never measured, which is what keeps `stackHeight` a function
  of the count alone.
- **Exactly one card moves per step, and that is the whole reason the interaction works.** With
  card _N_ open, card _k_'s top is `k·34` for `k ≤ N` and `N·34 + 303 + (k−N−1)·34` for `k > N`;
  open card _N+1_ instead and every top is unchanged **except card N+1's**, which travels 269px
  up from `N·34 + 303` to `N·34 + 34`. So the reflow is one card sliding out of the stack, not a
  list resettling — and the pointer that armed it stays inside it for every frame, because the
  card is 295px tall and slides up _underneath_ a stationary pointer.
- **The lift used to be pure CSS and is now state, because pure CSS could not be given hover
  intent** (changed 2026-08-12). The same arithmetic that makes one card move is what broke
  selection: after the first step the _next_ card's strip sits only ~34px below the pointer, so
  one continuous downward sweep crossed four or five strips in ~60ms, armed every one, and left
  the reader several cards below the one they aimed at. `CardStack` now holds `openIndex`, armed
  by `pointerenter` on the `<li>` after a **70ms dwell** (`STACK_OPEN_DWELL_MS`) and closed after
  **180ms** (`STACK_CLOSE_DELAY_MS`), where arming another card cancels the pending close so
  switching never shows a closed frame. **No new hit target was needed**: a closed card is
  overlapped 261px by its successor, which is later in DOM order and therefore paints over it,
  so the only hittable part of a closed card already _is_ its 34px reveal strip.
  `LAYER.raisedOnHover`/`raisedOnFocus` are **gone**, and `data-stack-open` exists so a test or a
  `cdp.mjs --probe` can _count_ open cards, which the CSS lift was observable from neither.
  **The margin is no longer a Tailwind literal either**: `motion` writes it as an inline style,
  so the constants are the only place these numbers live, and the note about spelling them out
  for the source scanner no longer applies.
- **The stack comes forward; a card in it never does — no card in a stack carries a z-index at
  all.** The list takes `LAYER.raised` while anything is open, because the cards it pushes down
  leave its box on purpose and the next group in the column would otherwise paint over them.
  A **card** takes nothing. They are `relative` siblings, so painting order is document order:
  every card is drawn over the one before it, and that _is_ the stacked look — the reveal strip
  a reader runs down is the top 34px of a card its successor has not covered. Raising the open
  card inverts that against the whole tail of the stack, and it does it on the **first frame**,
  while the cards after it are still 269px from where they are going, so the card appears to
  jump in front of the stack and then have the stack catch up around it. Letting them uncover it
  is the whole fix, and once they settle nothing is over it anyway: an open card's bottom is
  `N·34 + 295` and its successor's top is `N·34 + 303`, 8px clear.
  **Measured in the shipped window 2026-08-12** with `document.elementFromPoint` at a point both
  cards cover (y=541): mid-tween the painted card is **6** — the successors have not moved and
  the open card is correctly behind them — and settled it is **2**. Every card reads
  `z-index: auto` in both samples and the list reads `10`; before the fix the same probe
  answered `2` in both. **jsdom lays nothing out and paints nothing**, so a test can only hold
  the class assertion and the paint order is the live pass's to prove.
- **`onFocus`/`onBlur` sit on the `<li>`, not the button**, which is `focus-within`'s old reach
  and is load-bearing: `DeckCardControls` is a _sibling_ of the button, so a caret stepping into
  the stepper would otherwise collapse the card out from under itself. The keyboard opens with
  **no dwell** — a caret is a deliberate act and a dwell would just be lag.
- **React never listens for `pointerenter`.** It synthesises enter/leave from `pointerover`/
  `pointerout`, so `fireEvent.pointerEnter` fires an event the component cannot hear and the test
  passes having called nothing. Drive these with `fireEvent.pointerOver`/`pointerOut`. And
  `userEvent` cannot be driven under Vitest fake timers at all — RTL's `asyncWrapper` waits on a
  real `setTimeout` it only knows how to advance through _Jest_, so such a test hangs to its
  5s timeout rather than failing.
- The 2026-08-06 removal of the _old_ stacked mode is still not contradicted, and now for a
  narrower reason: that one drew full card faces **at column width with no overlaid chrome and no
  34px reveal**, so a ten-card stack was ten full cards to scroll past rather than a column of
  reveal strips.
- **A printings row in the card pane is clickable to view that printing** —
  `store.viewPrinting` sets `selectedCardId` _without_ clearing `paneDeckContext`, so the swap
  offers survive browsing; `setSelectedCardId` there instead silently kills the affordance at its
  one moment of use.
- **Four card surfaces outside the editor are drag sources, all through the one
  `cardDraggable`**, and the payload they all carry is
  `{ kind: "card"; cardId; name; typeLine }` —
  search tiles, collection _table_ rows (the collection's **card** mode is not one: only the
  search wall is handed `CardGrid`'s `dragPayload`), **pinned** wishes only (an any-printing
  wish names no printing to drag), and the card pane's printings rows. The **`typeLine`** is
  carried by the two adding kinds and never by `"deck-card"`, and it is there for the one drop
  with no column to point at — the sidebar's Decks entry, which files by `autoCategoryFor`. It is
  **normalised rather than validated**: `readDragData` refuses a bad `cardId` or `name` (they
  decide _what_ is dropped) and turns anything unusable here into `null`, because the pile is all
  this decides and `Uncategorised` is already the answer for not knowing. The pane's rows carry
  the **card's** type line, not the printing's — a `Printing` has none, and which pile a card
  belongs in is a fact about the card. A category column treats `"card"` exactly as the panel's
  `"search-card"`: add one copy. The remove tray narrows to `"deck-card"`, so a card from another wall never draws
  it. **The sidebar's Decks and Wishlist entries are drop targets**; Decks is inert with no
  deck open, which — because `setActiveView` clears `openDeckId` — is _every_ drag started
  from Search, Collection or Wishlist. So the sidebar's Decks target is reachable only from
  inside the Decks view (the docked panel, a deck card, the card pane).
