# Token stacks — design

**Date:** 2026-09-26 · **Status:** approved in conversation, awaiting spec review
**Builds on:** issue #388 (the Tokens & Emblems band), issue #507 (the token pile in the four
views), issue #508 (the rail's piles reorder). The reader's words are quoted where they settle a
question.

## 1. What the reader asked for

> We should refactor the token stack in the deckbuilder, it should look and function like the
> other stack.

Theory match indicators, the matching corner badge, the stack drawn like the others, and the stack
reorderable in the right-hand rail — "use our regular deck components". Mid-conversation, two
changes to **every** pile's header: the count pill the token pile wears replaces the `N cards`
line, and the price moves up beside it, so a stacked heading is one row.

Then the harder half, settled after the reader checked with their users:

> Tokens should not act as "real" cards, but rather the important thing is that they can add
> tokens with different printings, and that we have collection and theory tracking working.

Three token modes per deck, as a button group instead of today's show/hide switch:

| Mode | Who owns the tokens | Compared to the collection | Stack in the views |
| --- | --- | --- | --- |
| **Managed tokens** | The deck — "a living collection of cards that lives only in the deck". Touches the collection **never**. | No | Shown |
| **Collection tokens** | The collection — pulled from a new **Tokens** folder that holds all of a reader's tokens, and returned there when removed | Yes | Shown |
| **Hide tokens** | The deck, as Managed | No | Hidden — the tokens live only in the band under the editor |

**In all three the quantity of every token is controllable.** A token can hold several printings
at once, each with its own quantity; a new printing is added at 1 without replacing the others,
either from the deck's search column or from an **Add printing** button on the band that searches
only the printings of tokens the deck already has. A click on a token — in the stack or the band —
still opens the printing picker, for **that** printing.

And a bug: *"I can't select Any card in the deck editor's card search."* Root cause below (§3.6).

## 2. Vocabulary

These words are used exactly, here and in the code.

- **Token** — one `oracle_id` of layout `token`, `double_faced_token` or `emblem` that the deck
  makes or the reader added. What the band and the pile call *Tokens & Emblems*. Never a deck card:
  never a `deck_cards` row, never counted toward size, validation, stats, the ledger or a pile total.
- **Entry** — one printing **in one finish** of one token in one **list** (`live` or `theory`),
  with a quantity. A token has zero or more entries per list; a foil and a nonfoil copy of one
  printing are two entries.
- **Implicit entry** — what a token with **no** entries in a list draws: the resolver's default
  printing, in its default finish (nonfoil, or the printing's sole finish when it has one), at the
  legacy quantity (§4.2) or 1. It is what every untouched token is today.
- **Mode** — `decks.token_mode`: `managed`, `collection` or `hidden`.
- **The pool** — the collection's app-owned **Tokens** folder, one per database, and **the only
  place in the collection a token may be**, apart from a deck's token folder under it (§5.1).
- **A deck's token folder** — `Tokens ▸ <deck name>`, one per deck in Collection mode, holding the
  copies that deck has pulled. Custody, exactly as a deck's group holds its cards.
- **Pull / return** — moving copies from the pool into a deck's token folder, and back.

*Token* here is never *tag*, *label*, *keyword*, or the `Tokens` **auto-category** of cards that
**make** tokens (`autoCategory.ts`) — `src/features/decks/CLAUDE.md`'s naming rule stands.

## 3. PR 1 — stack parity

Frontend, plus one small Rust addition and one `decks` column. User schema **v50** (renumber if
`main` has moved — see the `schema-rung-collisions-with-main` memory).

### 3.1 One-row pile headers, in all four views

`GroupHeader` is drawn by all four views ("one group's heading, drawn the same way in all four
views"), so the change lands in all four rather than forking the stacked layout.

- The count is a **pill**, not `N cards`. `TokenCountPill` generalises into one `CountPill`
  (`count`, `words`): visible digits `aria-hidden`, one `sr-only` string for the phrase — the
  `Missing2` rule, one element, never two siblings assembled. A deck pile's words are
  `N card(s)`; the token pile's are `N token(s) and emblem(s)`. **Both count copies** (the reader's
  answer), which reverses `TokenCountPill`'s "distinct tokens, never copies" — the band's header
  pill follows, so the band and the pile still say one number in one shape.
- **`stacked` becomes one row**: `[grip] name [RULE][INACTIVE] ········ [pill] price`. The name
  truncates first; the figures are `shrink-0`. The row is `flex-wrap`, so at the narrowest zoom
  stops (a stack column is ~117px at 0.5×) the figures wrap under the name rather than overflow the
  column. The `·` separator between count and price goes: the pill is its own separator.
- `spread` and `tight` keep their placement and take the pill in place of the text.
- The price keeps its `pricesAsOf` tooltip.

### 3.2 The token pile drawn with the deck's own components

`TokenStackPile` stops being a parallel drawing and becomes the deck stack's parts fed a token:

- **Heading**: `GroupHeader`, given a group-shaped object — name `Tokens & Emblems`
  (`TOKENS_HEADING`), count = copies across the pile, `totalPrice` = Σ entry price × quantity,
  `isActive: true`, `kind: null` (no `RULE`, no `INACTIVE`, no wash — the pile is not a switched-off
  pile, it is not in the deck at all). `GroupHeader`'s `group` prop narrows to the five fields it
  reads so a token pile can supply one without faking a `CardGroup`.
- **Card**: `DeckCardFace` + `CardChin`, the stacked card's own pair. `DeckCardFace`'s `card`
  narrows to a `Pick<DeckCard, …>` of the fields it reads; a token adapter supplies them
  (`manaCost: null`, `needsReview: null`, no label, `gameChanger: false`). That gives the token the
  **same top-left `QuantityTag`** (grey — a token wears no label), the **same top-right
  `TheoryMatchMark`**, the printed-frame fallback and the foil sheen. The chin says set ·
  `#number` · finish · price.
- **Geometry**: the deck stack's — `stackHeight`, `stackCollapsedMargin`, `useFlipThrough`, the
  stepper column at `top-9 right-1.5` revealed by `revealedWhenOpen`. `tokenStackCardHeight` and
  `tokenStackHeight` are deleted: a token card with a chin is exactly a deck card's height.
  The `<li>`'s shared classes (border, surface, the two shadows) move to one exported constant both
  cards read, so the pile cannot drift from the deck twice.
- **What a token still is not** (unchanged from #507, and the reader confirmed "tokens should not
  act as real cards"): no drag source, no drop target, no deck card menu, no card modal, no
  selection ring, not in the arrow walk. A press on the face opens the one printing picker.

Grid gets the same face and chin through the same adapter. Table and Text keep their compact
drawings and take the new heading.

### 3.3 Chin facts and a price, from Rust

`DeckTokenRow` gains, for the **effective** printing (the override, else the default — the one
`image_uris` already describes): `set_code`, `collector_number`, `set_name`, `rarity`, `finishes`
and `unit_price`. `deck_tokens` (the command) takes a `marketplace` and prices the printing with
`sorting::price_expr`, nonfoil unless the printing only exists in another finish. The query key
gains `marketplace`, and `src/features/decks/CLAUDE.md`'s "no marketplace in the key — nothing this
answers is priced" is rewritten. `ipc.ts` mirrors the fields and `ipc.test.ts`'s struct table gains
`DeckTokenRow` if it is not already on it. **Token prices never reach the deck's own totals**:
they are summed only in the token pile's heading.

### 3.4 The token pile reorders in the rail

- **Storage**: `decks.token_rail_index INTEGER NOT NULL DEFAULT -1`, user schema v50, `ADD COLUMN`
  like `token_stack` at v47. It is **the number of rail piles drawn above the token pile**; `-1` is
  last, today's position and every existing deck's. **Not nullable**, because `deck::update_deck`
  writes every field through `coalesce(?n, col)`, which reads a bound NULL as *leave it* — a NULL
  "last" could never be written back once the reader had moved the pile. A value outside
  `[0, rail.length]` also draws last, so a rail that shrank draws the pile last rather than
  nowhere, and moving the pile to the last slot writes `-1` so piles added later stay above it. Synced with `decks` (the capture
  field list gains it). `DeckRow` and `DeckPatch` mirror it; `useDeck`'s `update` takes it with no
  new arm.
- **Why an index and not an anchor category**: an anchor is a category id on a synced row, which
  needs the sync's `sync_uid` translation, and switching the anchor pile on would move the token
  pile to the bottom for a reason the reader cannot see. A count needs neither.
- **Gesture — the pile is dragged, like every railed pile** (the reader, twice): the token pile's
  heading gets a grip (the `CategoryGrip` look) and the heading is the drag source, exactly as a
  category's is (`useCategoryDragSource`'s arrangement — the pile's name travels under the pointer,
  not a ghost of the glyph). Dropping it on any rail pile lands it at that pile's index, with the
  same `DROP_RING` / `DROP_OVER` marks and `DropIndicator` a category drag draws. ArrowLeft /
  ArrowRight on the grip step it one place, with the `preventDefault` handshake the category grip
  uses against the view's own arrows. Its accessible name is `Move Tokens & Emblems, n of N`. A
  category drag over the token pile is refused — the pile is not in either category run.
- **Undoable**: a move writes one `Op::Deck { token_rail_index }` step, the shape every other deck
  field's undo already takes, so Ctrl+Z puts the pile back and Ctrl+Shift+Z moves it again.
- **The other views** spend the index as **order**, as `splitRail` is already spent: Grid inserts
  the pile at `command + flow + index` in its `[...command, ...flow, ...rail]`; Text inserts it at
  `index` in its rail. **Table does not**: its token section is a compact list drawn *after* the
  virtualised table rather than rows inside it (a token row would be six empty cells — `TokenPile`
  says why), so there is no position among the bands for it to take, and it stays after them.

### 3.5 Theory marks on tokens

When the deck keeps a plan and the reader is on **Live**, `DeckEditor` reads the **theory** list's
tokens too (a second `useDeckTokens(deckId, "theory")` — a separate query key, no second picker,
no second write observer) and builds a token `TheoryPlan` with the existing `theoryMatchPlan`: each
theory token's effective printing is a slot keyed by `theorySlot({ cardId, finish: null })` with
its name. Each live token's mark is `theoryMatchMark(plan, { cardId: printingId, finish: null,
name })`, honouring the deck's three mark switches. **Until PR 2** art and quantity are shared by
both lists, so a token reads ✓ (the plan makes it too) or ✗ (only a substitute makes it) and never
±N — that is the data, not a limitation of the mark.

### 3.6 `Any card` on the Collection tab

**Root cause** (investigated 2026-09-26, no selection bug reproduced): the deck's search column
opens on its **Collection** tab, whose `useCollectionSearch` never sets `FilterSurface.anyCard`, so
`FilterBar` leaves the row out. That tab also seeds its format from the deck's format, so tokens —
legal nowhere — are filtered out and there is no row that brings them back by the name a reader
looks for. On **All cards**, `Any card` picks and sticks (probed in jsdom on the panel and on the
full editor, and in Storybook in a real browser).

**Fix — the same ladder on both tabs** (the reader's pick): `useCollectionSearch` sets
`anyCard: true`; the request is built by `useCardSearch`'s own `formatParams`, so the three rows
mean what they mean on All cards — `ANY_CARD` sends neither `format` nor `playableOnly`; `Any
format` sends `playableOnly: true` (legal somewhere); a named format sends the format **and**
`playableOnly`, which cannot narrow it further and keeps one expression answering all three rows. The collection query already carries `crate::filters::CardFilters`, whose
`playable_only` is `legal_mask != 0`, so the Rust side needs at most a field on the wire. The
facet read and `activeFilterCount` follow the same three arms. The collection **page**
(`useCollection`) is untouched — it does not narrow the corpus, so it offers no `Any card`.
Pinned by a `DeckSearchPanel` case on each tab: pick `Any card`, the trigger still reads it after
the debounce, and the request carries no format and no `playableOnly`.

## 4. PR 2 — printings and modes

User schema **v51**. Rust-heavy; the UI changes are the band and the mode control.

### 4.1 Storage

- **`deck_token_printings`**, a new synced table (added to `schema.rs`' synced list and the sync
  capture/apply specs beside `deck_tokens`):
  `id`, `deck_id` (→ `decks`, cascade), `variant` (`live`|`theory`), `oracle_id`, `card_id`
  (NOT NULL — an entry is always a concrete printing), `finish` (NOT NULL, `nonfoil`|`foil`|
  `etched`, the collection's own words), `quantity` (NOT NULL, ≥ 0), `created_at`, `updated_at`,
  `sync_uid`. Grain `(deck_id, variant, card_id, finish)` — a printing belongs to one oracle, so
  the oracle is a stored fact for grouping (and for orphans), not a grain term. **`finish` is NOT
  NULL on purpose**: SQLite's unique index treats every `NULL` as distinct, so a nullable finish
  would let one list hold the same regular printing twice.
- **`deck_tokens` keeps the token-level state** — `auto` / `hidden` / `manual` — shared by both
  lists, grain unchanged `(deck_id, oracle_id)`. A dismissal is "not in this deck" and a hand-added
  token is the deck's, whichever list the reader is looking at. Its `card_id` and `quantity`
  become **legacy**: read only for an implicit entry (§4.2), never written again.
- **`decks.token_mode TEXT NOT NULL DEFAULT 'managed' CHECK (token_mode IN
  ('managed','collection','hidden'))`**. `token_stack` is dropped in the same rung. **Every deck
  starts on `managed`**, including decks whose stack is off today (the reader's answer) — so after
  the upgrade every deck that makes tokens shows a token pile in its rail.

### 4.2 The entry rules

1. **A token with entries in a list draws exactly those entries.** With none, it draws one implicit
   entry: the resolver's default printing at `deck_tokens.quantity ?? 1`.
2. **The first write to an implicit entry materialises it** in that list only: Rust resolves the
   default printing at write time and inserts the entry. A step, a printing swap and an added
   printing all count. This is what makes adding art B keep art A.
3. **Stepping an entry to 0 deletes it — unless it is the token's last entry in that list**, which
   stays at 0. That is today's "kept at zero, art kept", and it stops the implicit default
   reappearing under a reader who zeroed the only printing they had.
4. **A swap** replaces the entry's `card_id` and/or `finish`; swapping onto a printing and finish
   the list already holds folds the two (quantities summed), on the grain.
5. **Adding a printing** inserts that printing and finish at quantity 1, or steps an existing entry
   of it up by 1.
6. **Theory and live never share an entry.** A write names its list.
7. **A token nothing makes any more is removed** (the reader: "if you cut all cards that create a
   token, so a token is no longer needed in the deck, simply remove all tokens of that type and
   return them to the collection tokens folder"). When a list stops deriving a token and the token
   is not hand-added (`manual`), every entry of it in that list is deleted — and in Collection mode
   its copies go back to the pool (§5.2). A hand-added token is kept: no card made it, so no cut
   can unmake it. Cutting the card and adding it back brings the token back as its implicit entry.

   **This is a reconcile after every write that changes a list's cards**, not a rule applied at
   read time: `reconcile_tokens(conn, deck_id, variant)` in Rust, called from the deck-write choke
   points — adding, cutting, moving between piles, switching a pile on or off (a switched-off pile
   makes nothing), clearing, importing over, a printing swap, and undo/redo of any of those. The
   plan's first task is the census of those call sites, fenced by a test that drives each one.
   Doing it at read time would leave the entries in the table and the copies in the deck's folder,
   which is the stranding this rule exists to prevent.

   **The reconcile's deletions ride the card write's own undo step.** `reconcile_tokens` returns the
   rows it removed and the caller appends an `Op::Tokens { restore }` to the step it files, so
   Ctrl+Z on the cut puts back the card **and** the reader's Treasure printings — and, in Collection
   mode, the reconcile after the undo pulls their copies back (§4.7). A write that files no step
   (the live cut through `deck_to_collection`, [collection-folders.md](../../reference/collection-folders.md)'s
   *the undo it deliberately does not*) files none for its token half either — the two halves are
   one press and are reversible together or not at all.

`deckTokens.ts` stays where every conclusion is drawn: effective views become one view **per
entry** (`printingId`, `finish`, `quantity`, the token's `oracleId`, `name`, `subtitle`, `state`,
`sources`), sorted emblems last, then name, subtitle, oracle id — and within one token by set,
collector number and finish (nonfoil, foil, etched), so a token's printings sit together. The
entry's `finish` is what the chin names, what `FoilOverlay` sheens and what the price is read at.

### 4.3 Migration (v51)

- Every `deck_tokens` row with a non-null `card_id` becomes one entry **per list** (`live` and
  `theory`) at `coalesce(quantity, 1)`; its `card_id` and `quantity` are then cleared. Both lists,
  because today's override is shared by both — copying it keeps what each list draws unchanged.
  Its finish is the printing's **sole** finish when the corpus says it has exactly one, else
  `nonfoil` — today's picker never chose a finish, so this is what the tile already drew. Where
  the corpus cannot be read at migration time the entry is `nonfoil`, and a foil-only printing is
  put right by one swap.
- A row with only a `quantity` is left as it is: that quantity keeps meaning "the implicit entry's
  quantity" (rule 1). No printing is resolved inside the migration — the resolver's default comes
  from the deck's cards and the corpus, and a rung that guessed it would invent a choice the reader
  never made.
- `decks.token_mode` is added at `managed`; `token_stack` is dropped.
- Proven on a copy of the real dev database (the `prove-a-migration-on-the-real-dev-db` memory).

### 4.4 Commands

The four token commands keep their names and gain a `variant` where a write targets a list:

- `deck_tokens(deck_id, variant, marketplace)` — one row per **entry**, carrying `derived`,
  `sources`, `state`, the chin facts and the price at the entry's finish.
- `deck_token_set_quantity(deck_id, variant, oracle_id, entry | null, quantity)` — an entry is
  `(card_id, finish)`; `null` is the implicit entry (materialised by rule 2).
- `deck_token_swap(deck_id, variant, oracle_id, from | null, to)` — `from`/`to` are
  `(card_id, finish)`.
- `deck_token_add_printing(deck_id, variant, card_id, finish)` — rule 5; a token nothing makes
  becomes `manual`.
- `deck_token_state(deck_id, oracle_id, state)` — dismiss / restore, shared by both lists.
- `deck_token_reset(deck_id, variant, oracle_id)` — deletes that list's entries, back to implicit.

The exact split is the plan's to settle; what is fixed is that **every write names its list** and
**no write touches the collection in Managed or Hide**. Sync capture and apply gain the new table;
the text mirror writes entries rather than one line per token.

### 4.5 The mode control

A three-way segmented control — **Managed tokens / Collection tokens / Hide tokens** — in two
places writing one column: the **Tokens & Emblems band's header** (visible in every mode, Hide
included) and **Deck settings**, replacing today's `Draw tokens as a stack` switch. `hidden` takes
the pile out of all four views; `managed` and `collection` draw it. The band is always there and
every stepper works in every mode.

### 4.6 Adding a printing

- **The picker's grain is the printing and the finish.** A printing with two finishes is two
  tiles, the foil one wearing `FoilOverlay`'s sheen and its finish in the caption — the collection
  wall's own grain ([collection-folders.md](../../reference/collection-folders.md), *the wall's
  grain is the printing **and** the finish*). Both pickers below are this one grid.
- **From the band**: an **Add printing** button opens a picker built on `TokenArtPicker`'s dialog —
  the printings of **every token the deck has** (the tokens on the wall), with a search box over
  name and set. A pick is rule 5 at quantity 1.
- **From the search column** (either tab): adding or dropping a card whose layout is `token`,
  `double_faced_token` or `emblem` files it as a **token entry** (rule 5) rather than a deck card,
  whichever pile it was dropped on — tokens never become deck cards. The finish is the tile's own
  where the tile has one (the collection tab's wall is grained on it), else the printing's default.
  A token the deck does not make becomes a hand-added token. The one predicate lives in
  `deckTokens.ts` (`isTokenLayout`), with its Rust twin in §5.1.
- **A click** on an entry — in the stack or the band — opens the printing picker for **that
  entry** (rule 4). The picker's own swap never touches the token's other entries.

### 4.7 Undo, redo and the deck's history

**Every token write is undoable** (the reader's ask) — which reverses #388's "token writes record
nothing". A token write is a deck write, so it goes where every deck write goes:

- **Undo** — a new `Op::Tokens { restore, patch, delete, states }` in `deck_undo`, the shape
  `Op::Notes` has: `restore`/`patch`/`delete` over `deck_token_printings` rows (by grain) and
  `states` over `deck_tokens` rows. A write files one `Step` whose `undo` puts the rows back and
  whose `redo` re-applies them — rows restored, never a command run backwards, the module's own
  rule. A **mode** change is `Op::Deck { token_mode }`, a **rail move** `Op::Deck
  { token_rail_index }` (§3.4).
- **History** — one `deck_audit` row per write, kind **`token`**, payload
  `{ action, name, subtitle, card_id, finish, list, from, to }`, with `auditText.ts` arms such as
  *"Added 1 × Treasure (foil)"*, *"Treasure 1 → 3"*, *"Swapped Treasure's art"*, *"Dismissed
  Soldier"*. A new kind rather than reusing `add` / `quantity`, because every existing reader of
  those kinds reads them as **deck cards**, and a Treasure in them is a card that is not in the
  deck. Widening the kind `CHECK` is part of v51's rung; whether `deck_audit` is rebuilt or needs
  anything in sync is the plan's to measure.
- **The undo button's label** is the audit row's text, as for every step, so the button reads
  *"Undo — Treasure 1 → 3"*.
- `every_deck_write_leaves_exactly_one_audit_row` gains the token commands, and the fake's
  `NO_UNDO_STEP` list does not.

**In Collection mode an undo moves cardboard, and it can, where a deck cut's cannot** (§5.2 has
why): the step restores the entry rows and then runs the deck's **custody reconcile**, which is a
pure function of the entries and the pool. That is a forward write, not a reversal — so it can land
short (the pool no longer holds the copy a step-down returned, because the reader moved or sold it)
and says so the honest way: the entry is back, and the missing copy is a want on the chin.

### 4.8 Theory tracking, complete

Each list now has its own entries, so the token `TheoryPlan` of §3.5 is fed the theory list's
**entries** — slot `theorySlot({ cardId, finish })`, the finish now real — and every tier works as
it does for cards: ✓ with a signed `planned − live` at the printing-and-finish grain, the
art-mismatch tier with the name-grain sum, ✗ for a token the plan does not make. A plan asking for
a foil Treasure is not satisfied by the nonfoil one, which is the deck card's rule. No new mark
code — only the data changed.

## 5. PR 3 — Collection tokens

User schema **v52**. Rust-heavy, and the one PR that moves the reader's cardboard.

### 5.1 The folders

- **`collection_folders.kind` gains `tokens`** — a table rebuild, because `kind` has a `CHECK` and
  so does `(kind = 'deck') = (deck_id IS NOT NULL)`. The new shape: `deck` ⇒ a deck id; `tokens`
  with no deck id is **the pool**; `tokens` with a deck id is **that deck's token folder**, whose
  parent is the pool; `user` and `removed` have no deck id. `idx_collection_folder_deck` becomes
  partial (`WHERE kind = 'deck'`) so a deck's group and its token folder do not collide; two new
  partial unique indexes pin one pool and one token folder per deck.
- **The pool** is made by the rung, named **Tokens**, app-owned like `Recently removed`: not
  renamable, not deletable, and — unlike `Recently removed` — **a normal destination**: a reader
  files tokens into it from search, by drag and by import, because it is where their tokens live.
- **A deck's token folder** is made on entering Collection mode and deleted on leaving it. It is
  locked and not a drop target, for the deck group's reason: a copy in it must be backed by an
  entry.
- **A token lives in Tokens and nowhere else** (the reader: "tokens should never go in a binder,
  only the tokens folder"). A token is a printing whose corpus `layout` is `token`,
  `double_faced_token` or `emblem` — Rust's `is_token_layout`, the twin of `deckTokens.ts`'
  `isTokenLayout`. Every door into the collection honours it, as a fence in Rust and never only a
  greyed control:
  - **Adding** one (search, the card menu, quick add, the importer) files it into the pool whatever
    folder the reader was standing in or the add named.
  - **Moving** one anywhere but the pool — a binder, the root, a deck group, `Recently removed` — is
    refused with a sentence (`TOKENS_LIVE_IN_TOKENS`), and the collection page draws no drop ring
    for a token over any other folder. The pool's own copies move freely among the decks' token
    folders only through the custody writes below.
  - **Removing** one deletes it; a token never goes to `Recently removed`.
  - **The upgrade** files every token already in the collection — in a binder, at the root, in a
    deck group or in `Recently removed` — into the pool, folding on the grain. It runs in Rust
    against the corpus, as an idempotent sweep at launch after the rung, so a database whose corpus
    was not readable at migration time is put right on the next launch that has one. An orphan
    (its printing gone from the corpus) cannot be classified and stays where it is.
  - A token arriving over sync from a device that has not upgraded is caught by the same sweep.

### 5.2 Custody

- **Owned** for a live entry is the copies of that exact printing **in that exact finish** in the
  deck's token folder. It is drawn as the chin's red `held/quantity`, and only when short — the
  deck card's rule.
- **Step up / add a printing / swap onto a printing** pulls up to the shortfall of that exact
  printing **and finish** from the pool's **own** entries (never another deck's token folder),
  oldest first, through `collection_folders::take_copies` and `refile_entry`. A foil entry is never
  filled by a nonfoil copy, nor the reverse. What is not there stays a want.
- **Step down / swap away / reset / dismiss** returns the copies above the entry's new quantity to
  the pool, folding on the grain.
- **Pull available** — a band button, shown in Collection mode while any entry is short — retries
  every shortfall against the pool.
- **Entering Collection mode** materialises every live implicit entry (so custody is keyed by a
  stable printing, not by whatever the resolver names tomorrow), creates the deck's token folder
  and pulls for every live entry.
- **Leaving Collection mode** returns every copy in the deck's token folder to the pool and
  deletes the folder — the reader's answer ("they go back to Tokens").
- **Deleting the deck does the same, before anything else is deleted** (the reader, again: "when a
  deck is removed, make sure the tokens also go back in the collection tokens folder"). The return
  runs inside `delete_deck`'s transaction **ahead of** the cards' trip to `Recently removed` and
  ahead of the `ON DELETE CASCADE` that would otherwise take the token folder — and its rows — with
  the deck. That ordering is the whole of the fix and is pinned by its own test: a deck in
  Collection mode holding tokens is deleted, and every copy is in the pool afterwards, folded on the
  grain, with none in `Recently removed` and none lost. The same test is repeated for **clearing**
  a deck and for **importing over** one, the two other writes that empty a deck's list wholesale.
  Archiving is not deleting: an archived deck keeps its tokens.
- **Undo and redo reconcile rather than reverse** (§4.7). The deck card's cut cannot be undone
  because its copies go through a merge into `Recently removed` and may no longer exist to restore;
  a token's copies go back to a pool whose contents are exactly what a pull reads, so custody is a
  pure function of the entries and the pool, and restoring the entries then reconciling is
  complete. A mode change's undo is the same reconcile against the restored mode — entering or
  leaving Collection mode again.
- **Theory holds nothing** (`THEORY_HOLDS_NOTHING`); theory entries are never pulled for.
- **No stranded copies**: when the live list stops making a token, rule 7 (§4.2) deletes its
  entries and the same reconcile returns every copy of it in the deck's token folder to the pool,
  in the same transaction as the card write that caused it. So a cut Smothering Tithe leaves no
  Treasure in `Tokens ▸ <deck>`.
- Refusals are sentences, in `collection_alloc`'s table style (`NO_TOKENS_FOLDER` for a database
  that lost its pool, and so on).

## 6. Deliberately out of scope

- **Tokens as deck cards** — considered and refused (the reader: "tokens should not act as real
  cards"): materialising derived tokens as rows would put them in the collection allocation, the
  ledger and the stats.
- **A card modal, card menu, card drag or selection for a token card.** The *pile* drags (§3.4);
  the cards in it do not.
- **Undo for PR 1's theory marks and chin** — they are reads. Every token *write* is undoable from
  PR 2 on (§4.7), and PR 1's one write, the rail move, is undoable in PR 1.

## 7. Testing and verification

- **Vitest**: `CountPill`'s accessible name; `GroupHeader` one row with the pill and price in all
  three layouts; the token pile's heading figures and theory marks; rail placement at every index
  including the clamp; the `Any card` ladder on both tabs; `deckTokens.ts`' per-entry views and
  ordering; the mode control's three states; search-column routing of token layouts.
- **cargo test**: each rung on a fresh file and on the ladder
  (`the_user_schema_is_byte_identical_to_what_the_ladder_builds`), and its undo constant; the
  v51 migration's arms, finish included; every entry rule; rule 7's reconcile from every card-write
  call site in the census, with its undo restoring the token entries; each pull and return path against the
  collection's merge rule, at the finish grain; entering, leaving, deleting, clearing and importing
  over in Collection mode; every door refusing or redirecting a token out of a binder, and the
  launch sweep; `Op::Tokens` undo and redo for each token write, and the reconcile after an undo
  in Collection mode landing short honestly; the audit sweep including the token commands; sync
  capture and apply for the new table and columns; `ipc.test.ts` for every changed struct.
- **The shipped window, per PR** (`npm run tauri dev`, debug build, a copy of the real database):
  the one-row header at 0.5×, 1× and 2× with nothing overflowing its column; a token card and a
  deck card measured **in the same frame**; the token pile dragged and arrowed through the rail;
  in PR 2 two Treasure printings side by side, a swap touching one, and Ctrl+Z / Ctrl+Shift+Z
  over each token write with the undo button's label read; in PR 3 a pull, a want, a return, a mode
  switch, an undo of each, a deck deletion, and a token dragged at a binder being refused — with the
  Tokens folder read on the collection page after each.
- `npm run verify` before every commit; `cargo fmt` and `clippy` before every push (CI runs both,
  verify does not).
