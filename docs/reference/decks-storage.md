# Decks: storage, commands, owned/missing, audit

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- **Enforced foreign keys exist only _between user tables_, never against `cards.id`** — a
  declared `REFERENCES cards(id)` aborts every sync, because `swap_staging` drops the table.
  The `ON DELETE` action is chosen per delete-site, not fixed once. **CASCADE** on
  `deck_cards.deck_id`, `deck_cards.category_id`, `deck_categories.deck_id`, `deck_audit.deck_id`,
  `deck_undo.audit_id`, `deck_undo.deck_id` and `deck_folders.parent_id`: a deleted deck's
  cards, a deleted category's cards, a reversal for a history row that is
  gone, and a deleted folder's sub-folders have nowhere else to be.
  **`deck_allocations.deck_id` and `deck_allocations.collection_entry_id` left that list at
  schema v25, with their table**, and the replacement is on both lists rather than on this one: a
  deck no longer *claims* copies somebody else's row holds, the copies sit in that deck's group.
  So deleting a deck takes the group with it (`collection_folders.deck_id`, CASCADE) while the
  cards surface elsewhere (`collection_entries.folder_id`, SET NULL) — the whole difference
  between a claim and custody, written as two `ON DELETE` actions pointing opposite ways at one
  press. `delete_deck` re-files those cards into `Recently removed` **by hand and before the
  `DELETE`**, so the SET NULL is a backstop rather than the mechanism; see
  [collection-folders.md](collection-folders.md).
  **`deck_labels.deck_id` was on that list until schema v21 and no longer exists**: a label belongs
  to no deck, so deleting the deck where a label was first typed must not take it off the nine
  other decks wearing it. The one place that still clears the table is `reset::clear_decks`,
  by hand, because every deck at once is the case where clearing them is right.
  **SET NULL** on exactly two of the deck side's — `decks.folder_id` (a folder is a filing
  decision; the decks in it are the user's work, not the folder's to take down) and
  `deck_cards.label_id` (deleting a label must never delete a card). **The schema's own total is
  four since v24**, and neither of the other two is a deck's: `wishlist_entries.folder_id` (v23)
  and `collection_entries.folder_id` (v24) each repeat `decks.folder_id` exactly, one list over,
  because both of those got the same filing cabinet — and `wishlist_folders.parent_id` and
  `collection_folders.parent_id` joined the CASCADE list in the same two rungs.
  `schema.rs`'s module doc carries the whole-schema list and is the copy of record; this
  bullet is the deck slice of it, and both want checking against the DDL rather than trusting
  either copy. **The app's one non-user delete no longer has anything to repoint**:
  `reconcile::fold_into_existing` calls `collection::fold_entry`, which since v25 is a sum and a
  delete with no clean-up owed to anybody, because no enforced foreign key points at
  `collection_entries` any more.
- **`reset::decks_clear` is the one delete-site that clears `deck_folders` too, and it needs a
  second statement to do it** (added 2026-08-20 with the Settings page's danger zone).
  `DELETE FROM decks` takes `deck_cards`, `deck_categories`, `deck_audit`,
  `deck_undo` and every deck's `collection_folders` group by cascade — but `decks.folder_id` is SET NULL for the
  reason above, so a wipe that stopped there hands the reader an empty folder tree to delete by
  hand, and **`deck_labels` needs a statement of its own since schema v21** for the reason one
  bullet up: nothing cascades onto it any more, and a reader who has just deleted every deck they
  own would otherwise open the Labels dialog onto forty labels attached to nothing, with no deck
  left to reach them from. **There was a third step and it was not a `DELETE` at all**: the
  covers were swept **whole** rather than removed one id at a time, which `deck::delete_deck`
  must not do, because after this command there are no decks left and every `<id>.webp` in
  `data/covers/` is an orphan by construction — including one left by the seam `set_cover_image`
  documented, a commit that failed after the bytes landed. The sweep ran **after the commit**,
  because the other order costs a deck whose cover vanished for a transaction that rolled back.
  **That step went on 2026-08-31 with the custom deck cover**, so this command is rows again on
  every target: no `covers` parameter, no `sweep_dir`, and `DecksCleared` carries `decks` and
  `folders` and no longer a `covers` file count. `data/covers/` is left standing on an install
  that has one and nothing ever opens it again — see [image-cache.md](image-cache.md) for why
  that is a decision rather than an omission. It is also why the argument for the post-commit
  ordering is preserved above rather than deleted: the next command that has to destroy bytes and
  rows in one press owes the same answer, and this is where it was worked out.
  **Since v25 this is also the one place this command reaches the collection**, and it reaches it
  by cascade alone: each deck's `collection_folders` group goes with its deck, and every copy that
  was in one surfaces at the **root** — not in `Recently removed`, which is `delete_deck`'s
  destination and deliberately not this one's, because after this press there are no decks for a
  card to have "recently left". A press about decks may not destroy a card the reader owns, and
  `clearing_the_decks_leaves_the_collection_owning_its_cards` is that promise pinned.
- **`reset::collection_clear` is four statements, and the last two are what stop it being
  unrecoverable.** Entries, then folders — the second needed by hand because
  `collection_entries.folder_id` is SET NULL and a wipe that stopped at the entries hands the
  reader an empty filing cabinet to take apart one drawer at a time. **Then `Recently removed` and
  one group per surviving deck are rebuilt in the same transaction**, archived decks included:
  since v25 those rows are not the reader's filing but *where the app puts cards*, both
  `collection_alloc` writes look their destination up by `deck_id` and by `kind` and refuse in
  words when it is not there — so a database swept bare is one where **no deck can ever hold a
  card again and nothing can be put aside**, permanently, because those rows are made by a
  migration and a machine at head never runs one again. Nothing self-repairs and nothing goes red.
  It goes through `collection_source::with_write_owned` — the only caller of that helper outside
  `collection.rs` — because the facet index's `owned` bitset is built from `collection_entries`.
  **`CollectionCleared` no longer carries `allocations`**: that field was the number nobody could
  predict, because `deck_allocations.collection_entry_id` cascaded from the entries and every
  deck's reservation went with the collection. There is no such field and no such cascade — a
  deck's cards are `deck_cards` rows and they stay, because a deck is a list of cards and not a
  list of *your* cards. The number answered is still the count of **cards**, never a folder, and
  the rebuilt rows are not in it either: they are the cabinet, not what was in it.
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
- **Schema v15 added `origin` beside the kind: who _made_ the pile.** `'auto'` is the app,
  filing a card it had to invent a column for (`category_for_name`); `'user'` is the reader
  pressing "New category" (`create_category`), and the four seeded zones count as the reader's
  (`ensure_predefined_categories`). `duplicate_deck` **copies** it — a duplicate has its
  original's shape. TypeScript hides an **empty** `auto` pile and always draws a `user` one, so
  a Ramp column appears with its first ramp spell while a pile the reader made stays until they
  delete it; Rust records the fact and draws no conclusion from it. **It is stored rather than
  derived from the name because `category_for_name` finds before it creates**: the grain is
  `(deck_id, name)`, so a reader's own "Ramp" is found rather than re-made and keeps `'user'`
  even once ramp spells are filed into it — and "Ramp", "Draw", "Removal" and "Land" are exactly
  what a person names their own piles. The one-time backfill and why it is frozen:
  [data-and-sync.md](data-and-sync.md).
- **The grain is `deck_id, variant, category_id, card_id, coalesce(finish, '')`**
  (`schema::DECK_CARD_GRAIN`) — the
  same printing in two categories is two rows, added twice in one is one row with the sum, and
  `variant` widens it again: `live` is what is sleeved up, `theory` is what the deck is being
  built toward (`schema::DECK_VARIANTS`), so a change tried out in Theory can never silently
  overwrite the deck as it stands. Every card command takes all of them.
- **`finish` is the fifth part, and it is v19's** (2026-08-17). `deck_cards.finish` is
  `NULL | 'foil' | 'etched'`, so a pile holds `1 × Sol Ring (foil)` beside `3 × Sol Ring` as two
  rows — which is what a reader means by picking the foil printing, since Scryfall models foil as
  a _finish of a printing_ rather than as a printing and 53 224 of 107 337 paper printings carry
  one under the same id. Four things about it:
  - **NULL is the regular copy and `'nonfoil'` is never stored.** `deck::normalise_finish` is the
    one place the word becomes NULL and the column's CHECK makes any other path a hard error:
    two spellings of "regular" would be two rows on this grain that draw identically on screen
    and sum apart, which is the worst shape a bug in this table can have. It is the shape
    `soleFinish` already answers in on the TypeScript side, and `wishlist_entries.
preferred_finish`'s nullability one table over.
  - **The `coalesce` is load-bearing**, `COLLECTION_GRAIN`'s device for its reason: SQLite treats
    NULLs in a UNIQUE index as _distinct_, so the bare column would enforce nothing and every
    regular add would insert a new row instead of folding into the one already there. That makes
    `DECK_CARD_GRAIN` the third grain that cannot be checked through `PRAGMA index_info` — it
    left `every_plain_grain_constant_names_the_index_the_head_schema_carries` and is held to its
    index by every `ON CONFLICT` target instead, where a mismatch is a hard error at the first
    write.
  - **`move` and `swap` carry it across; they never write it.** Moving the foil copy to another
    pile leaves it the foil copy, and swapping to another printing of the same card leaves it
    foil — the reader moved a card, or chose a printing, not an object. `deck_set_card_finish` is
    the one command whose subject it is, and the only one that checks the target against
    `cards.finishes`.
  - **Two things did not change and both look as though they should have.** `engine.ts` counts
    copies by card **name** and sums across rows, so a foil row and a plain row are two copies of
    one card; and owned/missing matches on **oracle id** and has always ignored finish, condition
    and language, so a foil row is answered by whatever copies of that card the deck's group
    holds. Making a foil deck row want a foil copy specifically is a different feature with its
    own answer to "what happens when you own three regular and play one foil".
- **`is_active = 0` is the whole of what `maybe` used to mean.** An inactive category counts
  toward nothing — not size, not copies, not legality — and `attribute_owned` hands it no copies
  from the group. The Maybeboard is not a special case in five files any more; it is one seeded row with
  the flag off, and a category of the user's own that they switch off behaves identically.
  **Nothing anywhere may branch on the kind being `maybe`** — that was measured: the old shape
  looked correct and was wrong the first time a user deactivated a pile of their own. **There is no
  hide column beside it and none is wanted**: `is_active` is not one — it deliberately keeps
  drawing the pile, because the affordance for switching it back on is seeing what is in it — and
  `delete_category` is the removal. The only pile that stops being drawn without a write is an
  `origin = 'auto'` one that has gone empty, which is `drawsWhenEmpty` reading a row that is still
  there.
- **Which totals a pile lands in: the switch decides whether it counts at all; the kind
  decides only whether it is played _beside_ the deck or _in_ it, and only `side` and
  `companion` are beside it** (CR 100.4a; EDH's companion is "effectively a 101st card"). So
  `SIZE_KINDS` is `main`, `commander` **and `maybe`** — written in three places that must stay
  one rule: `engine.ts`'s constant, `deck.rs`'s `DECK_SELECT` subquery behind
  `DeckRow.card_count`, and the Storybook fake's copy. Leaving `maybe` out is the incoherent
  version, not the smaller one: an _active_ Maybeboard was then inside the format's card pool
  and inside the binder's reservations but outside the size, so a second Sol Ring in it raised
  a singleton error under a figure that still read 100.
- **A plan holds nothing, so `attribute_owned` zeroes every `theory` row** — and the test
  `variant != LIVE` is now true *by construction* rather than because a table lacked a column,
  which is worth saying plainly because it reads like a leftover. It used to be a fence around
  `deck_allocations` carrying no variant: a `theory` read walked the *live* deck's stored claims,
  and without the filter a plan was handed the copies the sleeved deck had reserved. A **group is
  not scoped to a variant either**, so `owned_by_oracle` still answers the whole deck's copies;
  what changed is that the map is a fact about where cards *are* rather than a ledger of what was
  reserved. The conclusion is the same one, still drawn explicitly here rather than left to a
  table's shape, and still pinned by `the_allocator_claims_nothing_for_the_theory_variant`. The
  same fact is why `collection_alloc::deck_to_collection` refuses a theory row outright
  (`THEORY_HOLDS_NOTHING`) instead of moving zero copies and reporting success.
- **Switching the theory list on _moves_ the live deck into it. It does not copy it.** The deck
  the reader has built **is the plan**, so it becomes the theory list — and `live`, what is
  actually sleeved up, **starts empty** and fills as they acquire the cards. The guard is the one
  it always was: only on the false→true _transition_, and only when the theory list is empty,
  because a plan the reader has already started is not something a re-press of the switch may
  pour the live deck over. Two things ride along in the same transaction. The deck's
  `last_variant` becomes `theory`, so the reader lands where their deck now is rather than on a
  blank page they did not empty. **And the move reallocates nothing, where until schema v25 it
  had to.** Claims were held for `live` only, so cards that had just left the live list had to
  release the copies they were holding, or a deck with nothing sleeved up went on reserving a
  binder it no longer played from and every other deck read the shortage. There is no ledger and
  no release: the copies are in the deck's group and **the move does not touch a
  `collection_entries` row at all**, which is the honest reading of what happened — the reader
  reclassified their list, they did not take the cards out of the sleeves. `deck_to_collection`
  is the press that does that, one card at a time and out loud. **The rule this inverts was a
  seeding copy** — live was left alone and theory filled from it, on the reasoning that an empty
  theory list beside a full live one is not a blank page but reads as data loss. That got the
  right danger and the wrong half: nothing is ever deleted here, both lists being the same table,
  and what the copy actually produced was two identical lists with no way to tell which one was
  being edited. A reader who switches the theory list on is saying _what I have is the plan_.
  **`deck_theory_copy_from_live` is unchanged** and still means "copy what is sleeved up into the
  plan" — it is simply no longer what the switch does.
- **The empty-theory guard is now load-bearing twice, and the second reason is the one to know.**
  `variant` is _in_ `DECK_CARD_GRAIN`, and the move is a bare `UPDATE … SET variant` with no
  `ON CONFLICT` clause — so re-labelling a live row over a theory row of the same deck, category
  and printing is a `UNIQUE constraint failed` that fails the caller's whole write. Adding an
  `ON CONFLICT` here would be the wrong repair twice over: it would hide the guard's removal, and
  either arm of it, skip or fold, silently rewrites a plan the reader started. The copy that used
  to sit here could carry `DO NOTHING` precisely because it was a copy; a move cannot.
- **The difference has two readings, and `held_as_other_printing` is the second one** (2026-08-22).
  `deck_theory_diff` compares the **exact card** — printing and finish, `deck_theory::group_key` —
  so a plan naming one Sol Ring against a deck sleeving another is a full row and reads as a card
  the deck has not got. That is right for _buying_ and wrong for _playing_: the deck runs. So the
  row also carries how many of its `quantity` the live list already covers with a **different
  printing or finish of the same oracle card**, which is what the Compare dialog's `Missing` and
  `Different printing` views are computed from — the frontend re-derives none of it, exactly as it
  re-derives none of the subtraction. The pool is sized per oracle card as _live copies minus the
  copies an exact line already matched_ and spent down the surviving rows in the editor's own
  reading order, which is the whole of why it is deterministic: one live copy can excuse one row's
  copy and never two. A row whose printing has left `cards` reads zero, having no oracle card to be
  matched by. A row can be **partly both** — two copies wanted with one already on the table — and
  shows under both views **at its full quantity**, because the count on screen is what a press
  writes. That is the discipline `owned_spare` is held to one field over, stated on the other axis.
- **`deck_theory_missing_to_wishlist` takes an include list and writes a _pinned_ wish**
  (2026-08-22). `only` is a list of `group_key` strings — the spelling `deck_theory_slots` still
  answers **in the `key` half of** its rows, so nothing new crosses the boundary — and an absent
  one still means the whole
  difference. It is an **include** list although the gesture it serves is exclusion ("drop three of
  these and send the rest"): the two differ only for rows that appeared between the read and the
  press, and those are rows the reader never saw. The diff is re-read inside the write, so a key
  naming no current row writes nothing rather than refusing — a row ticked and then acquired in
  another window is simply not short any more.
  - **The wish is pinned to the printing the plan names**, carrying its `foil`/`etched` finish. This
    is the comparison's own 2026-08-20 rule finally read from the buying end: a plan naming a
    printing is a plan for _that_ cardboard, and answering it with an any-printing wish hands the
    reader back the very substitution the two lists exist to track. The sentence that stood here
    before — a wish is oracle-grained because a shopping list is not a printing preference — is the
    argument that lost.
  - **The regular copy pins no finish.** `deck_cards.finish` is NULL for it, and writing `nonfoil`
    would split this wish from every other one the app makes for that card on the wishlist grain
    `(oracle_id, card_id, preferred_finish)`. `foil` and `etched` pass straight through.
  - **A pinned wish and an any-printing one are different rows on that grain**, so a reader who
    pressed this before the change keeps their old line and gains a pinned one. Nothing is lost or
    double-counted — the upsert folds each into its own row — but it is the one visible wart of the
    change and it is worth recognising before treating it as a duplicate bug.
  - **The orphan skip is now load-bearing twice.** `add_wish` **refuses** a `card_id` that is not in
    `cards` ("no card with that id is in the card database"), and that refusal would abort the whole
    transaction — so the `oracle_id.is_none()` guard that was there to keep a wish from having no
    oracle card is now also what keeps a pinned write from taking the rest of the list down with it.
- **The editor's last view is stored on the deck, because reading a deck is not editing it.**
  Schema v12 adds `decks.last_variant`, `last_group_by` and `last_sort_by` — three `TEXT NOT NULL`
  columns defaulting to `live`, `category` and `alphabetical` — carried on `DeckRow` as
  `lastVariant`/`lastGroupBy`/`lastSortBy` and written by one command,
  `deck_set_view_state(deckId, viewState)`, whose `{ variant?, groupBy?, sortBy? }` reads an
  absent field as "leave it" — `DeckPatch`'s own `coalesce(?n, column)` convention. Three things
  it deliberately does **not** do, each of which the obvious implementation would have done: it
  does not move `updated_at`, because pushing a deck to the top of a gallery sorted by "most
  recently touched" for the crime of somebody looking at its Theory tab is a lie about what
  happened; it writes **no `deck_audit` row**, because the history holds changes to the deck and
  which tab was open is not one; and it **moves no card and no copy**. An unknown deck id is refused by
  name (`GONE`) rather than passed over silently — the editor is exactly where a deck deleted in
  another window is discovered.
- **`last_variant` is validated in Rust and the other two are not, which is the boundary rather
  than an omission.** None of the three carries a CHECK in SQL, and the fence has to
  sit somewhere. **Not because `ALTER TABLE … ADD COLUMN` cannot add one** — that is what this
  said until 2026-08-17 and it is false, as v19's `deck_cards.finish` demonstrates. `last_variant` is checked against
  `schema::DECK_VARIANTS`, because that is a word the crate owns — the same word
  `deck_cards.variant` holds. `last_group_by` and `last_sort_by` hold a **TypeScript**
  vocabulary (`category|manaValue|type` and `alphabetical|manaCost|price|type`) the crate
  deliberately does not know: Rust stores the reader's answer verbatim as a fact, and TypeScript
  narrows it on read with a fallback to the default. Teaching `schema.rs` those seven words would
  put the deck editor's grouping and sorting modes in two places, and the copy that could not be
  changed without a migration is the wrong one to have. **The one thing Rust does check about
  those two is that neither is blank** (`NO_MODE`): an empty string is not a word in anybody's
  vocabulary, it is a bug in the caller, and storing it hands the editor back a remembered choice
  of nothing.
- **`deck_get(id, variant)` scopes the cards, and every number counted over them, and nothing
  else.** All categories and all labels come back whatever the variant — the empty ones included,
  because **which of them draw a column is TypeScript's answer and not this read's**
  (`grouping.ts`'s `drawsWhenEmpty`, which files the empty ones by `kind` and `origin`: a pile the
  reader made draws, one the app made does not). A read that pre-filtered would be a second copy of
  that rule, and the two would part company silently. A category's _and a label's_ `card_count` do
  read the variant asked for; threading it into `list_categories` and not `list_labels` is exactly
  how they came to disagree once.
- Category and label writes live in **`deck_meta.rs`**, and **none of them reallocates any more —
  two of them used to.** `is_active` decided whether a card was allocated *for*, so
  `set_category_active` and `delete_category` each rebuilt the deck's claims inside their own
  transaction, the way every card write in `deck.rs` did. Schema v25 dropped `deck_allocations`:
  what a deck holds is where its collection rows physically sit, and switching a pile off changes
  what the deck **counts** without moving a single card. The rule the old note was making — that
  a rename and a reorder change what a pile is _called_ and nothing about what is in it — now
  covers every write in the module.
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
- **A deck card's unit price is what that printing costs at the marketplace the read was given,
  in whichever finish it is _sold_ in** — `nonfoil → foil → etched`, first link that answers.
  Built by `sorting::printing_price_by_finish_expr`, which is `price_expr` once per finish and a
  `coalesce`, so each marketplace's own holes travel with it: on Cardmarket the etched link is
  `NULL` by construction (there is no `eur_etched` key), and on either feed a link is a row
  `marketplace_prices` may simply not have.
  **It was the flat `'nonfoil'` literal until 2026-08-15, and that was the bug this rule
  replaced.** A deck names a printing rather than a finish, and "no finish" was read as
  "nonfoil" — but **13 515 foil-only and 892 etched-only printings have no nonfoil price at any
  marketplace** (measured on a synced corpus that day: every one of the 13 515 has a null
  `$.usd`, and 11 860 a real `$.usd_foil`). So a Secret Lair, an Invocation or a set promo in a
  deck drew an em dash on its card foot, was skipped by its pile's heading total and by
  `DeckStats`' figure, and did all of that beside a docked search panel quoting the same
  printing off `printing_price_expr`. On the machine it was reported from, **8 of 49 deck rows**
  were unpriced; the chain recovers 7, and the eighth (`hoc 204` Elvish Archdruid) is quoted in
  euros and in no dollar finish at all — an em dash that is now the truth rather than an
  artefact.
  **The two chains agree and are still not interchangeable**: `cards.price_usd` is this same
  order precomputed by `card_row` for the search's `ORDER BY`, it is in `idx_cards_collapse`, and
  it stays the column nothing in the crate sums — a deck total is a `sum()`, which is why the
  deck reads the expression instead. Only **36** paper printings in that corpus are sold nonfoil
  yet quoted in a premium finish only, so the chain answers the same number as the old literal
  on everything but the foil-only case it was written for.
  A deck-write readback with no marketplace of its own quotes `marketplace::stored(conn)`,
  so renaming a category does not answer a Cardmarket reader in dollars.
- **Owned is where the copies sit, and there is no allocator** (schema v25). `deck_allocations`,
  `allocate_deck`, `allocate_every_deck`, `kind_rank`, `Candidate` and `decks.is_built` are all
  deleted. What replaced them is one statement:

  ```sql
  SELECT c.oracle_id, sum(e.quantity)
    FROM collection_entries e
    JOIN collection_folders f ON f.id = e.folder_id
    JOIN cards c ON c.id = e.card_id
   WHERE f.deck_id = ?1 AND c.oracle_id IS NOT NULL
   GROUP BY c.oracle_id
  ```

  `deck::owned_by_oracle` — **`sum(quantity)` over the deck's own group, keyed by oracle id** —
  and `attribute_owned` hands that map out along `read_deck_cards`' `ORDER BY`, which is the
  read's order and never a caller's, so the number a row shows cannot depend on how a view chose
  to display the list. **Matched by oracle id, not by printing**, so a Bolt is still a Bolt: an
  Alpha copy in the group answers an M10 row in the list, which is what a reader means by "I have
  that card". Two kinds of row are passed over rather than served last, and the shape is
  unchanged from the allocator's day even though the reason for each has moved — a row in an
  **inactive** category (a switched-off pile counts toward nothing anywhere, so letting it take
  from the pool would move copies onto a scratchpad) and a row in the **theory** list (a plan
  reserves nothing).

  **The cost is honest and worth stating: owned/missing is now exactly as accurate as the
  reader's filing.** The allocator guessed for them — it swept every collection row a deck's
  oracle ids matched and reserved greedily, so a card in the binder counted as "in the deck"
  whether or not the reader had ever sleeved it up. Now a copy counts for a deck when it is
  *in that deck's group*, and a reader who has not filed their cards sees a deck full of red.
  That is the trade the release makes: a number that is wrong in a way nobody can see, exchanged
  for a number that is exactly the reader's own filing and can be corrected by dragging.

  Three failure modes went with the allocator, and each was real:

  - **Two decks could both count the same copy**, because a claim was a reservation and drafts
    all planned against the same shared binder. A placement is custody, one row sits in one
    folder, and `collection_to_deck` decrements the *other* deck's live list when it takes a copy
    out of its group.
  - **The stored claim could out-count the row it claimed.** Nothing refused it: the read clamped
    with `min(allocation, entry.quantity)`, so a collection row stepped down under a claim was
    honest on screen while the ledger kept a number that was not. v25's conversion clamps that
    overclaim away for good.
  - **Growing the collection did not re-run the allocator**, so a deck read new copies only after
    its next allocator run — a bug this page carried as "known, named, and Plan 6's to close",
    which is now closed by there being nothing to re-run. A `sum()` over the group is current at
    every read.

  **`collection_to_deck` refuses a card the deck's live list does not already play** since
  2026-09-03 — `collection_alloc::NOT_IN_DECK`, issue #358. Filing assigns copies to a list rather
  than joining a card to a deck, so the one write that could create a placement is no longer
  allowed to satisfy the invariant by writing the other half itself. **The match is
  `deck::PLAYED_KEY`, `coalesce(c.oracle_id, dc.card_id)`** — the same oracle-first rule with the
  same printing fallback that `release_group_copies` holds one function away, so an Alpha Bolt fills
  a deck listing the M10 one and a `deck_cards` row whose printing has left the corpus is still
  matched by its own id. **Live only**: a plan holds no cards, so a theory-only listing refuses.
  Two thin reads over the same expression serve the surfaces that say it early —
  **`deck_played_keys(deckId)`**, every key a deck's live list plays, and
  **`deck_ids_playing(keys)`**, every deck that plays *every* key given (`GROUP BY … HAVING
  count(DISTINCT …)`, an empty list answering nothing rather than everything). Both are routed to
  the web target; neither takes a marketplace or a variant, because the answer is priced by nothing
  and scoped to one list by definition. `collection-folders.md` carries the placement argument and
  what the two greyed surfaces do with it.

  **The run list is not replaced by a shorter run list; it is replaced by nothing.** There is no
  derived table to keep in step, so no write "runs the allocator" and none can forget to. What
  moves a row *across* the deck boundary is the pair in `collection_alloc.rs` —
  `collection_to_deck` and `deck_to_collection` — **and, since 2026-09-03, `deck_pull.rs`'s
  `deck_pull_from_collection`, which is the third and is not a member of that pair** (see
  [the pull](#the-pull-filling-a-hole-the-list-already-has)) — plus the six bulk presses that empty a group
  the reader is throwing away, every one of them into `Recently removed`: `delete_deck`,
  `deck_meta::delete_category`'s cascade arm, `deck::clear_category`, `deck::clear_variant`,
  `import::commit_import`'s `replace` arm, and Settings' `reset::clear_decks`. The five that
  release *one card at a time* share `deck::release_group_copies`, the crate's one walk over a
  group's rows, which matches on the oracle card with the exact printing first — the four bulk
  ones reach it through `release_live_copies`, which asks the `live` question for all of them;
  the two that empty a whole folder — `delete_deck` and `clear_decks` — walk the sub-tree and
  re-file every row through `refile_entry`, the `delete_folder` rule reused. Everything else that
  changes the number is an ordinary
  collection write landing on a row that happens to be filed in a group (an edit, the importer's
  `set` mode, the reconciler's fold), and it is answered at the next read because the next read is
  a `sum()`. **A stepper is no longer one of them, and the change is in the app rather than in the
  crate** (2026-09-01, [issue #284](https://github.com/Msgaihede/mtg-grimoire/issues/284)): the
  collection page draws no copies control on a row filed in a group, in either view, so the reader
  cannot change what a deck holds from a screen that does not mention the deck.
  `collection::set_quantity` still permits it and still must — it is the one write the importer,
  the reconciler and `take_copies`' split all go through. The fence and why it is not in the
  command are in
  [collection-folders.md](collection-folders.md#the-copies-control-belongs-to-a-normal-folder-in-both-views).
  **No deck write changes what a deck owns as a side effect any more**, which is the debugging
  property the old run list was trying to give and could not.

  **The card search tab beside the deck answers the same question, and until 2026-09-03 it did
  not** ([issue #349](https://github.com/Msgaihede/mtg-grimoire/issues/349)). `owned_by_oracle`
  has been the deck's own group since v25, so the row's `2/4` was already right — but the `×N` a
  tile in the search column wears came from `collection_source::copies_of_oracle` with no scope at
  all, so a card whose whole playset was sleeved into other decks read `×4` in the one place the
  reader was deciding what to add. The **Collection** tab two components over had answered the
  narrower question since folders landed (`Allocation::Unallocated`), which is what made it a
  disagreement between two tabs of one panel rather than a missing feature.

  What rides now is `SearchRequest::available_for_deck` — `availableForDeck` on the wire, the open
  deck's id, sent by `DeckSearchPanel` and by nothing else. It is **not a filter**: it narrows no
  rows and reorders nothing, it chooses which of the reader's copies count as theirs, through
  `collection_source::Availability`. Three arms, and each lets a row through on its own: the root;
  **the asking deck's own group**; and anywhere else that is neither another deck's group nor an
  effectively locked drawer. `Recently removed` therefore still counts, exactly as it does in
  `Allocation::Unallocated`.

  - **The asking deck's own group is the whole difference from `deck_theory::OWNED_SPARE_SQL`**,
    which drops every deck group including its own. Both statements mean *what can be counted on*
    and they disagree about one arm because they are asked from different chairs: a plan cannot
    count on the sleeved deck's cards, and the deck builder's search can, because they are that
    deck's. Folding the two into one helper would take a flag saying which — the same two
    functions with the difference hidden.
  - **The `owned` filter takes the same scope, and had to.** Narrowing the count while leaving the
    Owned/Missing chip alone would put a card under Owned wearing `×0`, which is the one refusal a
    reader cannot act on. `the_owned_filter_follows_the_same_scope_as_the_badge` is the pin.
  - **The facets deliberately do not follow.** `CardIndex` has one global `owned` bitset and no
    deck-relative dimension, so those two counts in the deck builder's filter row are taken as if
    every copy were reachable and read **high**. They reach a `title` and never a greying, and
    over-reading only ever leaves a control live — the direction that whole row is built to fail
    in. The fix is a per-deck bitset rebuilt on every folder lock, move and deck-group write, and
    what it buys is a tooltip. `useCardFacets` carries the argument from the frontend side, and
    `FacetRequest` omits the field so no builder can send it by accident.
  - **`Availability::Everything` emits no SQL**, so `import::match_columns`' `MATCH_ORDER` and
    every unscoped wall run byte-for-byte the statements they ran before, and the `owned: true`
    plan table in `search.rs` still describes what it was measured on.
  - **Driven in the shipped window on 2026-09-03**, debug build, against the real database
    (117,621 cards; a collection filed entirely into three deck groups and nothing at the root).
    The reader owns **three** Sol Rings, one in each of Bruna's, Serah's and Azula's group. With
    Azula open, `search_cards` answered `Sol Ring = 3` unscoped and `= 1` at
    `availableForDeck: 3`, and the tile on the wall drew **×1**. Aerith Gainsborough — four
    copies, all in Serah's group — answered `4` unscoped, `0` for Azula and `4` for Serah, and
    the tile drew **no badge at all**, which is `OwnedBadge`'s own "nothing to say" rule rather
    than a `×0`. The Owned chip agreed on the same three requests: it returned the card unscoped
    and for Serah, and did not return it for Azula.
  - **The scoped shape is unmeasured, and is written down as unmeasured.** It adds two correlated
    probes of `collection_folders` per surviving entry — both by indexed key, `id` being the
    primary key and `deck_id` carrying a partial unique index — plus `LOCKED_FOLDER_IDS`' walk
    over a table holding a handful of rows. It runs in one 384px column where the reader has
    almost always typed something, which is the state the `owned` filter costs 0.1 ms in. Nobody
    has taken the numbers against the real 116 k-row database; `search.rs`'s existing plan table
    is where they belong if it ever bites.
- Deck cards ride **`images::prewarm_keys`' UNION** (one arm, `grid` only, like the collection
  and wishlist arms) and the reconciler's **three-table sweep**
  (`collection_entries`, `wishlist_entries`, `deck_cards`).
- **The audit log records facts; TypeScript writes the sentence.** `deck_audit` has no `summary`
  column and never will — it holds `kind` (one of `add|remove|quantity|move|swap|label|category|
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
  **27** cases, each carrying the number of rows it owes (count the list in `deck_audit.rs`,
  never a remembered number — it has been written down wrong three times now). It reached 28 on
  2026-08-23 by taking in `collection_alloc`'s two commands, which had been writing history under
  it for two PRs while the list stayed at 25: a sweep that exists to catch "a new deck write
  records nothing" cannot skip the writes that move cards. It fell back to 27 on 2026-08-31, when
  custom deck covers took `deck_set_cover_image`'s case out with them and this sentence was the
  half of that deletion nobody re-counted. **Neither clear is in the list** —
  `deck_category_clear` never was, and `deck_clear` was not added beside it — so the test's name
  is wider than what it drives, and each clear's history row is pinned by a test of its own in
  `deck.rs` instead. "Exactly one" is per _change_, not per call, and
  **three** commands make more than one change in a call:
  **`deck_update` records one row per changed field**
  (`record_deck_edit`, pinned by `a_patch_that_changes_two_fields_records_both`), and it
  satisfies that test only because every one of its cases changes exactly one field;
  **`deck_import_commit` in `replace` mode records two** — a `remove` for what it cleared and
  an `add` for what it imported, which one signed `delta` cannot be both of, while its `merge`
  mode records one; and **`collection_to_deck` records two when the copies come out of another
  deck** — its own `add`, plus one `remove`/`quantity` row per `deck_cards` row it decremented in
  the deck that lost them (`take_from_deck_list`). Those two land in two _different_ decks'
  histories, because a log is per deck and nothing in the donor's drawer can reach the target's.
  All of them use the existing `add`/`remove`/`quantity` kinds, so
  there is no tenth `AUDIT_KINDS` value and no migration. The only
  command is the read, `deck_audit_list(deckId, limit)`, and its limit is `clamp(1, 500)` —
  **the low end is load-bearing, because SQLite reads a negative `LIMIT` as no limit at all.**
  It is append-only and never pruned. `DeckHistoryDialog.tsx` has no mutation in it, and the
  table still holds no reversal: **undo is a sibling table, `deck_undo`** (schema v17) — see
  its own section below.
  **Seven writes record nothing on purpose**: `delete_deck` (CASCADE takes the history with the
  deck, so a row would be orphaned by its own event); **both** `missing_to_wishlist` commands,
  `deck`'s and `deck_theory`'s (they write the wishlist, not the deck); `deck_set_view_state`
  (which tab the reader had open is not a change to the deck, and a history that filled up with
  them would bury the ones that are); and **three of the four
  folder writes** — create, rename and move — because a folder belongs to no deck and
  `deck_audit.deck_id` is `NOT NULL`. `deck_folder_delete` is the fourth and is **not** exempt:
  `decks.folder_id` is `ON DELETE SET NULL`, so it re-files N decks and writes one `folder` row
  per deck it un-filed.
- **Undo is `deck_undo`, a journal beside the history and not a column on it** (schema v17).
  `audit_id INTEGER PRIMARY KEY REFERENCES deck_audit(id) ON DELETE CASCADE`, a `deck_id`, a JSON
  `step` and a nullable `undone_at`. **A sibling table because `deck_audit` is append-only and
  read whole every time the drawer opens**: a category delete's step carries the rows the CASCADE
  took, which is orders of magnitude larger than the sentence it would sit beside, and
  `deck_audit_list`'s SELECT does not change. Both CASCADEs are load-bearing and for different
  reasons — `deck_id` keeps `deleting_a_deck_takes_its_history_with_it` true of the new table for
  free, `audit_id` stops a step outliving the change it describes.
  - **The audit log could not have been replayed backwards, which is why this exists.** Five kinds
    are lossy in exactly the direction undo needs: `swap` records `fromSet`/`toSet` and **not the
    from-printing id** (`card_id` is the printing the deck plays _now_); a `category` delete
    records `cards: 7`, a count of what the CASCADE took; a `reorder` records `{"action":
"reorder"}` and no order either side; a clear and an import `replace` record counts; and the
    theory toggle records `{field:"theory",from:false,to:true}` while having **moved the whole
    live list**. Two softer ones: every payload names categories and labels by **name**, and
    `folder` records the destination with no `from`.
  - **A step restores rows; it does not run a command backwards.** Four primitives — `cards`
    (an exact set of `deck_cards` rows over an explicit scope of `(variant, categoryId, cardId)`
    cells), `categories`, `labels`, `deck` — and `cards` alone covers add, remove, quantity, move,
    swap **including the fold**, both clears, both import modes and the theory move. There is no
    `unswap_printing` and no un-import, and there could not be: `replace` cleared rows nothing
    recorded.
  - **`restore` and `patch` are two lists on the category and label ops, because they are two
    intents.** A patch is a rename, a switch or a reorder — the row is there and its columns go
    back. A restore is a delete being undone, and whatever holds that id now is **somebody else's
    pile**: `deck_categories.id` is a rowid alias, so deleting the highest-numbered pile and
    making a new one reuses the number, and that new pile belongs to the same deck. A single list
    deciding by "is there a row at this id" therefore renames the reader's newest pile into the
    one they deleted and hands it the old cards. `apply` threads an id **remap** through the ops
    so the cards follow the pile to whatever id it comes back under.
  - **One press is one step, keyed to the last history row it wrote.** Three commands write more
    than one — `deck_update` (one row per changed field), `deck_import_commit` in `replace` mode,
    `deck_folder_delete` — and a cursor that could land mid-press would put half a settings form
    back.
  - **`AUDIT_KINDS` stays at nine.** An undo records `kind = 'deck'` with
    `{"field":"undo"|"redo","of":<audit_id>}`, because `deck_audit.kind` carries a CHECK, SQLite
    cannot alter one, and a tenth word would rebuild every reader's whole deck history for a
    spelling — `deck_import_commit`'s own argument, one shelf over. `delta` is negated on an undo
    and carried straight on a redo, so the day header's roll-up still adds up. **The reversal's
    own row records no step**, which is what keeps the stack linear: Ctrl+Z twice goes back two
    changes rather than toggling one.
  - **`undone_at` persists and the redo queue does not.** Undo therefore survives a restart and
    carries on below where it stopped; redo is a list of ids in the webview (`useDeckUndo`),
    thrown away with the window and cleared by any other write to the deck. A database-backed
    redo would offer to resurrect a fortnight-old branch of edits the reader had forgotten making.
  - **Three commands**: `deck_undo_state(deckId, redoId)` — the two `DeckAuditEntry`s the buttons
    name themselves from, the redo half answered only for the id the caller hands in —
    and `deck_undo_apply` / `deck_redo_apply`, which check the id against the cursor rather than
    trusting it. **They ended with one `allocate_deck` run until schema v25 and now end with
    nothing**: what a deck owns is where its collection rows sit, and putting a `deck_cards` row
    back does not move a card.
  - **Three things are deliberately out of reach, and each has a reason rather than a gap** (it
    was four until 2026-08-31; the fourth is the last paragraph here).
    `deck_create`/`deck_duplicate`/`deck_delete` are gallery writes with no editor open, and
    undoing "this deck was born" means deleting the deck the reader is standing in.
    `deck_folder_delete` records history and **no step**: the cursor is per deck, that press
    changes N of them, and `decks.folder_id` is a real foreign key — so restoring one deck's id
    without resurrecting the shared subtree is an FK failure rather than a partial success. Rows
    written before v17 carry no step and none can be invented, which is the honest floor of "as
    far back as the history allows". And `deck_set_cover_image` restored its three columns but
    **not the file**: `images::cover_file` was one path per deck, so a second upload overwrote the
    first and only the row came back.
    **That fourth absence closed by deletion on 2026-08-31.** Custom deck covers went, and with
    them the only deck write whose undo could restore a row and not the thing the row pointed at
    — a cover is `cover_card_id` now, which the ordinary `deck` step carries whole. So the count
    in the sentence above dropped from four to three. **`cover_image_path` stays in
    `deck_undo.rs`'s `DECK_FIELDS` and must not be tidied out of it**, which was measured rather
    than assumed. `read_deck_row` records **all** of `DECK_FIELDS` into every step, so every step
    already on a reader's disk names that column, and `apply` refuses a step naming a field the
    list does not carry. Handed an `Op::Deck` naming only `cover_image_path`, `apply` answers
    `Ok(())` with the entry present and *"`cover_image_path` is not a deck column an undo step
    may write"* without it — so taking it off breaks Ctrl+Z for every deck edit made before the
    upgrade, on every existing database, while a fresh worktree (whose steps were all written
    after) stays green.
- **`deck_create` makes a whole deck in one INSERT, not a name to be configured afterwards**
  (changed 2026-08-14). `DeckInput` carries `name`, `formatKey`, `description`, `notes`,
  `coverCardId`, `folderId` and `theoryEnabled`, because the "New deck" dialog now hosts the same
  settings form the settings dialog does and would otherwise be create-then-patch-then-setFolder:
  three transactions, and a half-made deck to roll back by hand the way
  `useImport.importIntoNewDeck` has to. Four things about it that are **not** `deck_update`'s
  rules, each of which a reader who knows the patch will get wrong:
  **(1)** nothing here is written with `coalesce(?n, column)` — this is an INSERT, so an absent
  `folderId` genuinely is the top level and means it, where `DeckPatch.folderId` cannot un-file a
  deck at all (`deck_set_folder` is still the only command that reaches the root of an existing
  deck's tree). **(2)** `cover_kind` is not settable and keeps its DDL default `card_art` — which
  since 2026-08-31 is the only word this app writes at all, so the rule now costs nothing where
  it used to cost a round trip. Until then the *other* word was reached by
  `deck_set_cover_image`, which took a **path** and a **deck id** and could therefore only ever
  be a follow-up call; custom deck covers went and that command with them, so a deck's cover is
  `coverCardId` and is born in the same INSERT as everything else. **`cover_kind` is still a
  column, still spells `'custom'` in its `CHECK`, and still syncs** — nothing *produces* the word
  any more, and a row arriving from a device on an older rung that carries it is tolerated, read
  as card art, and repaired the next time the reader picks a cover. **(3)** `theoryEnabled` at create sets the column and **moves**
  nothing, there being no live cards to move — `update_deck`'s route runs
  `deck_theory::move_live_into_theory`, making the deck the reader already has into the plan and
  leaving live empty, and it does so only on the off → on _transition_. So a deck **born** with
  theory on has made that transition at birth, no later patch will ever move anything for it, and
  the reader's route is `deck_theory_copy_from_live`, which is unchanged. The two routes differ in
  what they _do_ and agree exactly on what a new deck ends up with. **(4)** a deck's birth stays
  **one** audit row, `{field:"name", from:null, to:name}`, however many fields it was born with:
  `deck_update` records one row per changed field because each of those is an event, and being
  born is one event. `folderId` is fenced by the real foreign key rather than by Rust — which is
  invisible to a test whose fixture forgets `PRAGMA foreign_keys=ON`, since `db::open` always
  sets it and `seeded()` does not. The Storybook fake's `deck_create` was **missing that audit
  row entirely** until this change and now writes it. **`separate_x_group` (the bullet below) is
  deliberately not on `DeckInput`**: it is a reading preference, and a deck being born has not
  been read yet, so it takes its DDL default like the three view-state columns beside it.
- **`decks.separate_x_group` is a stored _reading_ preference, and `deck_update` is the whole of
  how it is written.** `INTEGER NOT NULL DEFAULT 0`, **schema v13** — whether this deck gathers
  the cards printing `{X}` under a heading of their own. Per deck rather than per user for
  `theory_enabled`'s reason: it is a statement about how _this_ list is read, so two decks may
  disagree and a copy must not. It rides `DeckPatch`, `DeckRow`, `DeckBefore` and `DECK_SELECT`,
  and **`duplicate_deck` carries it across** while `archived` still resets — what
  describes the deck comes over, what state the deck is _in_ does not, and a copy that read
  differently from its original would be a surprise nobody asked for. (`is_built` was the other
  half of that sentence until schema v25 deleted the column; a copy also gets an **empty
  group** — its own `collection_folders` row, holding nothing — because the original's copies are
  physical cards and a duplicate is a draft, not a second set of them.) Rust stores it and does
  nothing else with it: which cards fall in the group, what it is called and where it sorts are
  `grouping.ts`'s, which is the crate's facts/conclusions boundary rather than an accident of
  where it was easier to write. **Two positional traps, both silent when got wrong.** The column
  goes **last** in `DECK_SELECT` and `deck_row` reads it at the **last** index, because a column
  added anywhere else shifts every later index into a field of the same SQLite type and nothing
  errors. **That index is not a constant and this document will not name it**: it was 15 when the
  column was written, and merging the view-state step's three columns underneath moved it — which
  is the trap itself, not a footnote to it. Read it off `deck_row`.
  And `update_deck` binds it as **`?11`, not `?10`** — that hole is `COVER_CARD_ART`, bound rather
  than spelled in the `SET` list, so a new column takes the next number at the **end** of the list
  and never the next one that merely _reads_ free. **A _dropped_ column renumbers every binding
  after it**, which is what v25 taking `is_built` out did to the holes quoted in these bullets:
  each moved down by one, and this page still said `?12` here on 2026-08-27, because a prose-only
  edit routes to neither CI job and nothing went red for two rungs. Read them off `update_deck`
  rather than off this page.
- **The audit word is `"xGroup"`, and it is the only multi-word field name `record_deck_edit`
  writes.** Every other arm of that switch — and of `auditText.ts`'s, which is the only thing that
  reads the payload — is a single lowercase word, so this is the first place the two spellings can
  drift with nothing going red: `auditText`'s `default` arm answers a field it does not recognise
  with "Changed the deck", a sentence true of every deck edit, so a typo here reads as a bland
  history line rather than as a failure. **Deriving the word from the column gives `separateX`,
  which is wrong** — and is exactly what the Storybook fake guessed before it was corrected
  against `deck.rs`. `auditText.test.ts` pins the right word _and_ that wrong-but-plausible one,
  which is the only fence either side has. Neither sentence claims a card moved ("Split the X
  spells into their own group" / "Folded the X spells back into their mana values"), because
  nothing was added, removed or refiled: it changes how the deck is read and not what is in it.
- **`decks.default_category_id` is where an unfiled add lands, and `0` is `Auto`.**
  `INTEGER NOT NULL DEFAULT 0`, **schema v16** — the deck editor's old "Add to" answer, which was a
  `useState` in `DeckEditor` with a select on the docked search panel until 2026-08-15 and is now
  asked in the deck settings dialog. It rides `DeckPatch`, `DeckRow`, `DeckBefore` and
  `DECK_SELECT` exactly as `separate_x_group` does, takes the **last** index in `deck_row` and the
  **next** `?` hole at the end of `update_deck`'s `SET` list (`?12`), and is deliberately **not on
  `DeckInput`**: a deck being born has no categories to point at — `create_deck` seeds the four
  zones in the same transaction — so it takes its DDL default like the columns beside it.
  **It is a sentinel in a `NOT NULL` column rather than a nullable foreign key, and that is the
  decision worth knowing.** `deck_categories.id` is an `INTEGER PRIMARY KEY`, so rowids start at 1
  and nothing can collide with `0`; the frontend already rested on that as `AUTO_CATEGORY` and Rust
  spells the same number `deck::AUTO_CATEGORY`. The alternative — nullable, with
  `REFERENCES deck_categories(id) ON DELETE SET NULL` — is what SQLite would even allow in an
  `ADD COLUMN` (a `REFERENCES` clause needs a NULL default), and it fails on `DeckPatch`'s
  convention: `coalesce(?n, column)` reads a bound NULL as _leave it_, so "back to Auto" would have
  needed a command of its own, which is the price `decks.folder_id` pays through `set_folder`.
  **What the sentinel costs is the clean-up that key would have done, and it is two sites**:
  `deck_meta::delete_category` puts a deck filing by the deleted pile back to `0` **before** the
  DELETE and inside the same transaction — left undone, the deck files every unnamed add at an id
  with no pile behind it, and `deck_cards.category_id`'s real foreign key then refuses the reader's
  next quick add on a deck whose settings still read the deleted name — and `deck::duplicate_deck`
  **remaps** it through the `category_map` it already builds for the cards, because the copy's piles
  are new rows; carried across verbatim it would point the duplicate at a pile of the _original_,
  which breaks nothing and quietly files every add into a deck the reader is not looking at. That
  is why the copy's `INSERT … SELECT` does not name the column at all: it is written after the map
  exists. `schema.rs`'s `the_default_category_is_a_sentinel_rather_than_a_foreign_key` asserts the
  key's **absence**, so a later step that rebuilds `decks` and adds one fails there and takes the
  paragraph with it rather than leaving two stories.
  **Rust owns one fence and no more**: a non-zero id must name a category _of this deck_
  (`category_of_deck`, the same two sentences every card write answers), because nothing in the DDL
  says so. What Auto _does_ — Removal, Ramp, Draw, off a card's Oracle tags — is `autoCategoryFor`'s
  and stays in TypeScript.
- **The audit word is `"defaultCategory"` and its payload carries the pile's _name_.** The second
  multi-word field name `record_deck_edit` writes, so the `"xGroup"` paragraph above applies to it
  verbatim; what is new is the value. A bare category id in a `to` is a number no reader can resolve
  once the pile has been renamed or deleted, and this drawer is read months later — so the name is
  resolved at the moment it is true, which is `record_filed`'s reasoning for a folder path applied
  to the only other column pointing at a row with a name of its own. `null` on either side is
  `AUTO_CATEGORY`, and `auditText.ts` words it as the rule rather than as a pile ("New cards now go
  by what the card does"), because under Auto there is no one pile: it is decided per card. The
  `from` side is looked up at the write rather than carried on `DeckBefore`, so a rename or a cover
  change pays no join for a question nobody asked.
- **`decks.game_key` is which platform the deck is for, and `format_specs.games` is which
  platforms each format is playable on.** Both **schema v18**, both `TEXT NOT NULL` with a
  default (`'any'`; `'paper,arena,mtgo'`). `game_key` rides `DeckInput`, `DeckPatch`, `DeckRow`,
  `DeckBefore` and `DECK_SELECT` exactly as `default_category_id` does, takes the **last** index in
  `deck_row` and the **next** `?` hole at the end of `update_deck`'s `SET` list (`?13`) — and that
  positional discipline is sharper here than it was for the column before it, because `game_key`
  is `TEXT` and so are four of the columns above it: inserted beside the format, where it _reads_
  like it belongs, it would have swapped a deck's variant for its platform with both fields still
  holding a plausible-looking string.
  **`'any'` is a sentinel for `default_category_id`'s reason**, spelled out one bullet up: a
  nullable column could not have said "back to Any" under `DeckPatch`'s `coalesce(?n, column)`.
  **Neither column carries a CHECK** — `ADD COLUMN` cannot add one, `last_variant`'s situation at
  v12 — so `deck::valid_game` is the fence on `game_key`, which is the one of the two a command
  parameter reaches; `format_specs.games` is written only by the seed and gets a test
  (`a_format_spec_games_cell_holds_only_scryfall_game_words`) instead of a fence.
  **`games` is stored comma-joined and answered split**, which is the one cell whose storage shape
  and wire shape differ: `list_format_specs` splits it, so no consumer writes `split(',')` and
  none can reach for `includes()` on the raw string and conclude that `arena` is playable in
  `standardbrawl`.
  **Nothing in the crate compares the two columns**, and that is the design rather than an
  omission: a Modern deck may say Arena. The game narrows a _picker_, `pickerFormats`' `keep`
  folds the deck's own format back into it, and a create or a patch that refused the combination
  would be refusing a deck over a filter.
  **The audit word is `"game"`** — a single word, unlike `"xGroup"` and `"defaultCategory"`, but
  under the same silent-drift rule: `auditText.ts`'s `default` arm answers an unrecognised field
  with "Changed the deck", which is true of every deck edit and so never fails. The payload
  carries the stored **key** on both sides (`{"field":"game","from":"any","to":"arena"}`), because
  `auditText.ts` is the only thing that knows Paper from `paper`, and a key that list has never
  heard of is drawn as itself rather than as "Any".
  **`create_deck` writes no `last_deck_game` beside `last_deck_format`.** The format a reader last
  built in is a preference; the game is a filter set to find a format, and remembering it would
  open the next New deck dialog with most of the list already hidden.
- **`decks.bracket` is which Commander bracket the reader says this deck is, and `0` is `Auto`.**
  `INTEGER NOT NULL DEFAULT 0`, **schema v26** — `1`–`5` are the Commander Format Panel's five
  brackets and the reader's own answer, `0` says the estimate stands. It rides `DeckPatch`,
  `DeckRow`, `DeckBefore` and `DECK_SELECT` as the three columns above it do, takes the **last** index in
  `deck_row` and the **next** `?` hole at the end of `update_deck`'s `SET` list (`?14`), and is
  deliberately **not on `DeckInput`**: a deck being born has not been asked, which is what Auto
  already says. It is on `deck_undo::DECK_FIELDS` for `game_key`'s reason — an ordinary
  `deck_update` writes it and an ordinary history row records it, so a Ctrl+Z that left it alone
  would put a deck's format back and leave the bracket the same press moved.
  **The sentinel is `default_category_id`'s and so is the argument for it**, two bullets up:
  `DeckPatch`'s `coalesce(?14, bracket)` reads a bound NULL as _leave it_, so a nullable column
  could not have expressed "back to Auto" without a command of its own. What is different is that
  nothing points at anything — there is no clean-up site, no remap in `duplicate_deck`, and
  `deck_categories.id`'s "rowids start at 1" argument is not needed, because the panel's own scale
  starts at 1 and a sixth number would have to be invented before `0` could collide with one.
  **The fence is `deck::valid_bracket` and the DDL carries no CHECK — but _not_ because
  `ALTER TABLE … ADD COLUMN` cannot add one.** That claim is false and v19's `deck_cards.finish`
  disproves it: SQLite's documented `ADD COLUMN` restrictions are PRIMARY KEY, UNIQUE, a
  non-constant DEFAULT, NOT NULL without a default, REFERENCES without a NULL default, and
  GENERATED STORED. A plain `CHECK (bracket BETWEEN 0 AND 5)` is on none of those lists. The
  reason is `valid_game`'s one column along: a command parameter reaches this column, and a
  refusal in Rust can say which numbers are legal (`BAD_BRACKET` spells the whole vocabulary,
  because the reader arrived through a picker offering six choices) where a
  `CHECK constraint failed` names only the constraint. **The `?14` binding is the _validated_
  value and not `patch.bracket`** — binding the raw field would make the fence decorative on
  exactly the path it exists for.
  **`duplicate_deck` carries it across** and `archived` still resets, the same line
  `separate_x_group` sits on: what describes the deck comes over, what state the deck is _in_ does
  not. A copy of a deck the reader has declared bracket 2 is a bracket 2 deck, and a duplicate that
  reverted to Auto would tell them their estimate had changed when only the row had.
  **The audit word is `"bracket"`** — a single word, under the same silent-drift rule as
  `"xGroup"` and `"defaultCategory"` — and the payload carries the **number** on both sides
  (`{"field":"bracket","from":0,"to":4}`), `format`'s rule rather than `defaultCategory`'s: there
  is no row to name and no id to go stale, so nothing has to be resolved at write time.
  **`auditText.ts` has no `bracket` arm as of 2026-08-27, so the history dialog draws that row as
  "Changed the deck"** — the `default` arm, which is true of every deck edit and therefore never
  fails. That is exactly the silent drift the `"xGroup"` paragraph above describes, arriving from
  the other direction: the word is right and nothing reads it. The row is written, `deck_undo`
  reverses it (`bracket` is on `DECK_FIELDS`), and only the sentence is missing.
  **Rust stores the number and concludes nothing from it**, `AUTO_CATEGORY`'s rule exactly. The
  four facts an estimate reads are the crate's (`cards.game_changer`, oracle text, and the `combos`
  tables the same v26 rung created); the floor they become — a floor rather than a bracket, and
  never 1 or 5 — is `src/features/decks/validation/bracket.ts`'s.
  [commander-brackets.md](commander-brackets.md) is the whole record.
- **The six single-card commands, and what each takes** (the three bulk ones,
  `deck_import_commit`, `deck_category_clear` and `deck_clear`, have their own bullets below).\
  `deck_get(id, variant)`;
  `deck_add_card(deckId, cardId, categoryId, categoryName, variant, quantity)` — **either an id
  or a name**, id wins when both arrive, neither is refused in words, and the name is
  found-or-created (the word being TypeScript's `autoCategoryFor` to compute, because which
  pile a card belongs in is domain logic); `deck_set_card_quantity(deckId, cardId, categoryId,
variant, quantity)`; `deck_move_card(deckId, cardId, fromCategoryId, toCategoryId,
toCategoryName, variant)`, which stays inside one variant and takes **either an id or a name
  exactly as the add does** — see the bullet below; `deck_swap_printing(deckId, fromCardId, toCardId, categoryId,
variant)`; `deck_missing_to_wishlist(deckId)`, which reads `live` and skips inactive
  categories. Two fences every write opens with, **neither of them enforced by the DDL**: the
  variant must be one the schema knows, and the category must belong to _this_ deck —
  `deck_cards.category_id`'s FK only asks that the category exist, not whose it is.
- **`deck_move_card` grew the add's two-arm target on 2026-08-15**, for the quick zones' `Auto`
  applied to a card the deck already holds. A **name** goes through `deck_meta::category_for_name`
  — the same find-or-create the add and import paths use — inside the move's own transaction, and
  the id wins when both arrive. Three things that arrangement buys over resolving the name in
  TypeScript (`deck_category_list` + `deck_category_create` + move, which is what the bulk
  `autoCategorise` still does for its own reasons): a pile the app invents is recorded
  **`origin: 'auto'`**, so `grouping.ts`'s `drawsWhenEmpty` stops drawing it once its last card
  leaves — `create_category` writes `'user'` and would leave a column nobody asked for standing
  for ever; the create and the move are **one transaction**, so a refused move cannot strand an
  empty pile; and it is one round trip rather than three.
  - **It answers the category the copies are now in**, which was `()` before. The name arm's
    caller has no other way to learn what was found or made, and the caret follows a moved card
    to its new pile — so that id is load-bearing rather than a convenience.
  - **`from == to` is checked _after_ the resolution, and returns without committing.** The name
    arm cannot know the target's id until it has resolved it, and a card the rule files where it
    already is has to be answered rather than moved. Dropping the transaction rolls back the
    `touch_deck` above it, because bumping `updated_at` to leave the list exactly as it was is
    precisely what the id arm's caller-side guard exists to prevent. Nothing can have been created
    on that path: `category_for_name` answers a **new** id when it makes a pile, and a new id is
    never a pile the card is already in.
- **`deck_category_clear(deckId, categoryId, variant)` empties one pile of one list, and exists
  for `deck_import_commit`'s reason** (added 2026-08-15, behind a category heading's right-click
  `Clear stack…`). The frontend holds every row of the pile, so a `deck_set_card_quantity(…, 0)`
  per row would work — and would be a transaction and a `["decks"]`
  invalidation **per card**, plus one history line each for a press the reader made once, plus a
  refusal halfway leaving the pile half-empty with nothing able to say so. One statement, one
  transaction, one history row. (It was "one allocator run" as well until schema v25; the
  arithmetic that made this a command survives the allocator that first motivated it.)
  - **Variant-scoped, which is the exact reverse of `deck_category_delete`.** That command
    cascades through both lists because `deck_cards.category_id` is `ON DELETE CASCADE` and a
    category is not per-variant; a clear leaves the pile standing, so what it empties is the list
    the reader is looking at. The two confirmations therefore quote **different numbers** —
    `cardCountAllVariants` for the delete, `cardCount` for the clear — and swapping them would
    over- or understate a destructive press.
  - **It answers the copies it removed**, counted before the `DELETE` and in copies rather than
    rows, which is what the confirmation quoted and what `delta` means in the history.
  - **An empty pile writes nothing at all**: no `touch_deck` and no audit row. The
    same choice `set_card_quantity`'s zero arm makes and states — a `remove` row of zero copies is
    a history of a change that never happened — and it keeps a menu opened on an empty column from
    moving the deck's `updated_at`. The UI greys the row in that state; the early return is the
    fence behind it, since a pile can empty under an open menu.
  - **The history row is a `remove` naming no card, carrying `{ action: "clear", category, cards }`
    and a `-cards` delta.** `action` is load-bearing: `auditText.ts` reads a bare `remove` as
    "Removed 7 × a card", which is a sentence about a card the row has not got. It is
    `deck_import_commit`'s replace row one shelf over, which carries `{ import: { cleared } }`
    instead, and the two are deliberately different shapes because they are different events.
- **`deck_clear(deckId, variant)` empties every pile of one list, and it is the bullet above's
  argument one grain wider rather than a new one** (added 2026-09-01 for issue #281, behind an
  **Empty a list** section at the foot of Deck settings). The editor holds every pile on screen,
  so a loop over `deck_category_clear` would work — and would be a transaction, a `["decks"]`
  invalidation and a **history row** per pile, which on a nine-column Commander deck is nine of
  each and nine lines under one day header for one press, plus a refusal on the fourth column
  leaving half the deck emptied with nothing able to say so. Drop `category_id` from that
  bullet's `WHERE` and the arithmetic is unchanged, so the answer is: one statement, one
  transaction, one invalidation, one line of history for one press. **The piles survive**, as
  they do a stack clear — a reader emptying a deck to build it again keeps the columns they built
  it in — and the scope is still one variant, because what a reader is pointing at when they
  empty a deck is the list in front of them.
  - **The undo step is one `Cell::pile` per pile that held cards, not one wide cell over the
    deck.** `clear_variant` runs a `SELECT DISTINCT category_id … WHERE deck_id = ?1 AND
    variant = ?2` before the `DELETE` and makes a cell out of each id, so the step's scope is
    exactly the columns that had something in them and a column that was already empty costs
    nothing. It is deliberately **not** `deck_undo::read_variant`, which would answer the same
    rows here: that reader pairs with `record_variant`'s `Op::Variant`, while `record_cells` reads
    its own "after" back through `read_cells` over these very cells, and a step whose "before" was
    read over one scope and whose "after" over another is a pair that does not reverse.
    `deck_undo.rs`'s round-trip registry carries `deck_clear` as a case of its own and says why
    the `deck_category_clear` case cannot stand in for it: the fixture puts live cards in **two**
    piles, so a `clear_variant` that recorded only the pile it happened to read first would
    satisfy every assertion the narrower case makes and lose a whole column to Ctrl+Z.
  - **It answers the copies it removed** — `sum(quantity)` over the variant, counted before the
    `DELETE` and in copies rather than rows, exactly as the stack clear counts. How many
    `deck_cards` rows the `DELETE` took is a number nobody is shown, and the two part company the
    moment a deck holds one card in two printings.
  - **An empty list writes nothing at all**: the early return sits above the cells, so no
    `touch_deck`, no audit row and no undo step. Its sibling's reason unchanged — a `remove` row
    of zero copies is a history of a change that never happened. The two buttons are greyed in
    that state; the early return is the fence behind it.
  - **The live release is the half worth arguing, and it is where two commands running the same
    `DELETE` now agree rather than part company.** Every copy the deck's group holds behind a
    `live` row is filed into `Recently removed` first — `deck::release_live_copies`, which is one
    `release_group_copies` per row, read and released inside the same transaction and before the
    rows are gone, so a clear that fails half way has moved nothing. A `deck_cards` row is an
    intention and a row in the group is cardboard the reader owns; emptying the list does not stop
    them owning it, and left undone this would put *every* copy of a cleared deck under a deck
    that has never heard of them. **`theory` releases nothing** and not as an optimisation: a plan
    holds no cards (`collection_alloc::THEORY_HOLDS_NOTHING`), so the loop never runs — and since
    2026-09-01 that `variant == LIVE` question is asked inside the helper rather than at each call
    site.\
    **`deck_import_commit` in `replace` mode executes the identical
    `DELETE FROM deck_cards WHERE deck_id = ?1 AND variant = ?2`, and since 2026-09-01 it releases
    beside it too** — issue #336, closed by the one helper the issue sketched rather than by a
    fourth copy of the loop. `release_live_copies(tx, deck_id, variant, category_id)` is
    `release_group_copies`'s bulk half: `Some(id)` for `category_id` is one pile and `None` the
    whole variant, it reads the doomed rows `ORDER BY id` before the caller's `DELETE` and inside
    the caller's transaction, and the four sites that take a set of `deck_cards` rows out at once
    all call it — this clear, the stack clear, `deck_meta::delete_category`'s cascade arm and the
    import's `replace` arm. **The failure it prevents is worth keeping written down now that the
    code cannot make it**: the same delete over the same rows left the reader's copies in two
    different places depending on which press made it — **Clear actual list…** put them back on
    their desk, while importing over the deck in replace mode left them filed under a deck that no
    longer listed them, invisible on the Collection page and unavailable to every other deck. A
    fence spelled out at three call sites is a fence the fourth forgets, which is why the `live`
    test moved into the helper along with the loop.
  - **The history row is a `remove` naming no card, carrying
    `{ action: "clear", scope: "deck", cards }` and a `-cards` delta.** `action` is the stack
    clear's field for the stack clear's reason. **`scope` is the new one**, and it is what tells
    `auditText.ts` that the row is about a whole list rather than a pile: `clearedFrom` keys on
    `scope === "deck"` and **never on `category` being absent**, because absence is also what an
    older build's payload and a truncated one look like, and reading it as "the whole deck" would
    label a stack clear as a list the reader never emptied. A row carrying no `scope` is a
    category clear and reads exactly as it always did. There is no `category` on this row because
    there was no category — it names the list instead, in the confirmation's own words, through
    `src/features/decks/listNames.ts`.
- **`deck_import_commit(deckId, variant, mode, items)` is the third bulk card command. It existed
  for the allocator and outlives it.** Looping `deck_add_card` from the frontend would have run
  `allocate_deck` **once per line** — a hundred rebuilds of a deck's claims for one import, each
  deleting and re-deriving every row the last one wrote — and this command ran it once, at the
  end, over the finished deck. That was measured, by a test called
  `the_allocator_runs_once_for_the_whole_import` that went with the allocator: it counted row
  changes through SQLite's `total_changes` at **43** for one run over 20 owned cards against
  **423** for one run per item, both on 2026-08-12. **Schema v25 dropped the allocator,
  and the reason that survives it is one transaction**: a hundred `add_card` calls are a hundred
  transactions, so a list refused on line 90 leaves 89 cards in the deck and a history of 89
  edits nobody made. Everything else is `add_card`'s shape held to
  deliberately — the same variant and `touch_deck` fences, the same `DECK_CARD_GRAIN`
  `ON CONFLICT` fold (so a list naming a card twice is one row with the sum), the same
  `category_for_name` find-or-create (so a `Sideboard` section lands on the seeded `side` row
  and makes nothing). `mode` is `merge` or `replace` (`import::IMPORT_MODES`), and
  **`replace` clears the cards of the one variant it was given and leaves every category
  standing** — a category is the reader's filing, not the list's. **On a `live` list it releases
  the copies before it clears them** (2026-09-01, issue #336): `deck::release_live_copies` runs
  between the `cleared` count and the `DELETE`, inside the commit's one transaction, so every copy
  the deck's group held behind a `live` row lands in `Recently removed` — the same act, through
  the same helper, that `deck_clear` and `deck_category_clear` perform. **What that costs the
  reader is worth stating plainly, because it is a real consequence rather than a detail**: the
  freshly imported rows own nothing until the copies are filed back by hand, exactly where
  **Clear actual list…** leaves them. The alternative is not "the copies stay attached" — a
  `collection_entries` row is filed against a *printing* in a deck's group and the list that
  replaced it may name none of them, so the choice was between copies sitting in a holding area
  the reader can see and copies filed under a deck that has no row for them, which since v25 means
  invisible on the Collection page and unavailable to every other deck. **`theory` releases
  nothing**, because a plan holds no cards; the fence is inside the helper, so the `replace` arm
  does not ask. An empty item list is refused in words (`NOTHING_TO_IMPORT`), which matters most
  in `replace`, where doing nothing and clearing the deck to put nothing back are the same call.
- **`ImportItem.inactive` is the one field this boundary grew for the format work, and it applies
  to a pile the import _creates_ and to nothing else.** Archidekt's `{noDeck}` is that site's word
  for a pile counting toward nothing, which is exactly this schema's `is_active = 0`; without it
  the reference deck's 17 maybeboard cards land in a counted pile and a 100-card commander deck
  reports 117 in every total the reader looks at. Three decisions inside it, each with its reason:
  **a name the reader already has is left exactly as they set it**, because an import must not
  reach into filing somebody did by hand — the same principle that makes `replace` clear the cards
  and leave the categories — and it is free, since the `existed` lookup `commit_import` already
  makes for `categories_created` is that same fact. **The first item naming a pile decides**: the
  name is memoised for the list, every export in scope writes the same bracket on every card of a
  category, and a list disagreeing with itself has no better answer available. And **the write goes
  straight to the column** rather than through `deck_meta::set_category_active`, which opens a
  transaction of its own and records a history row — both already `commit_import`'s, whose whole
  reason for existing is that the import is **one** transaction over the finished deck. (That
  call reallocated too, until schema v25 took the allocator; the other two reasons are what the
  rule now stands on.) `#[serde(default)]` keeps every caller written before the field
  deserialising, and absent means the ordinary counted pile an import has always made. Rust records
  the flag and concludes nothing from it: which lines carry it is `parse.ts`'s reading of the
  bracket's **first** entry, carried to the item by `plan.ts`.
- **`ImportItem.label_name`/`label_color` is the second pair this boundary grew, and it is
  `category_name`'s shape over `deck_labels`** (2026-08-24). Archidekt writes one label per card as
  `^Keeper,#4aab08^` and `deck_cards.label_id` holds exactly one, so the two line up without a
  decision. `label_for_name` finds by `schema::label_name_key` — `deck_labels.name_key`'s own
  grain — and
  creates only when nothing answers, memoised for the list so a hundred `Keeper` lines cost one
  lookup and count as **one** creation. Four decisions inside it:

  - **A label that is already there is used exactly as it stands** — not renamed to the file's
    capitals, not recoloured. `inactive`'s principle over a different table, and it bites harder
    here: `deck_labels` has had no `deck_id` since schema v21, so a pasted decklist recolouring
    `Keeper` would recolour it in every deck the reader owns. `deck_meta::create_label` is
    deliberately **not** the function used — it refuses a taken name (the ordinary case for an
    import), opens its own transaction, writes its own audit row and records its own step, and a
    hundred labelled lines must not be a hundred of each.
  - **`label_id` coalesces where `quantity` sums**, in the same `ON CONFLICT`:
    `label_id = coalesce(deck_cards.label_id, excluded.label_id)`. That asymmetry is what a `merge`
    promises — two copies of a card are three copies, but a label the reader put on a row by hand
    is a decision this import may not overturn. It is also what an *unticked* label sends: the
    item simply carries no `label_name`, and an item that says nothing about a label leaves the row
    alone.
  - **A name with no colour beside it is refused rather than defaulted.** `deck_labels.color` is
    NOT NULL and picking what a colour *is* belongs to the webview (the Rust/TS boundary), so
    inventing one here would be this module making a display decision. `toImportItems` sends the
    two together or neither, and `PlannedLabel` is where a group that carried no hex gets
    `DEFAULT_LABEL_COLOR` — on the *step*, so the swatch the reader sees is the colour the row
    would really be made with.
  - **`ImportOutcome::labels_created` counts the rows the import _made_**, and the `add` audit row
    carries the same number as `labelsCreated`. A label the reader already had costs nothing and is
    not counted. It is owed for a sharper reason than `categories_created` is: a label is app-wide,
    so three new ones is a change to a list every other deck reads from — which is why the dialog
    says it on the way out and `auditText.ts` puts it in the history row's detail.

  **The undo step sweeps them.** `record_variant` takes a third "before" — `deck_undo::label_ids`,
  the whole table, since a label belongs to no deck — and `push_made_labels` diffs it exactly as
  `push_made_categories` diffs the piles. On the **redo** side `Op::Labels` restores *before*
  `Op::Variant` inserts, and that order is not a nicety: `deck_cards.label_id` is a real foreign
  key and `insert_cards` writes each restored row's label through `remap.label`, so the cards have
  nowhere to point until the label is back. `deck_undo::tests::undoing_an_import_sweeps_only_the_
labels_it_made` is the proof that the reader's own labels are not swept with them.
- **`import_resolve` is the import's read half, and it answers the one question TypeScript
  cannot**: which printing in this app's corpus a name means. Six statements, prepared once and
  reused down the list, tried narrowest first — a set **and** a collector number; the set with the
  name; the set with the name as a **front face**; the name, exactly; the name as a front face of
  an `"A // B"` printing; and last the **folded** name (lowercase, diacritics stripped) through
  `cards_fts`. The order every arm shares is one constant, `MATCH_ORDER`: **a printing you own
  first, then the newest paper printing, then the `id`.** Owning it first is the whole point — a
  reader importing a list they already have copies of wants their copies in the deck. **The `id`
  tie-break is a requirement, not decoration**: two printings sharing a release date are ordinary
  in this corpus, and without a total order the same list pasted twice builds two different decks.
  The fold arm re-implements that order in Rust rather than being allowed to disagree with it.
  **A hint that names nothing falls through and says so** — `hint_missed` is set and the name arms
  run anyway, because a reader wanting a printing this app has not got is never a reason to lose
  the card. Failing open is the rule throughout: a name nothing bears _and_ a line whose SQL failed
  are both `matched: None`, and only a `prepare` failure — a broken schema, not a broken decklist —
  is an `Err`.
- **Every arm is one indexed lookup, and `COLLATE NOCASE` is what stopped it being one.**
  `cards.name`, `set_code` and `collector_number` are plain `TEXT`, so `idx_cards_name` and
  `idx_cards_set_cn` are BINARY and a comparison naming another collation cannot use them — nor
  can an _expression_ over a column, which is what `substr(name, 1, instr(name, ' // ') - 1)` is.
  Both plan as `SCAN c`, which is a full table scan **per line**. Timed through `resolve_lines`
  itself on a **release** build over a copy of the live 116 695-row corpus, a 105-line commander
  list, medians of nine: **11.5 ms** as it ships against **46 123 ms** for the first version's one
  `OR`/`NOCASE` arm — the same column list, the same process, the same file, swapping only the
  `WHERE` clause. A **4 000×** difference, and the difference between a feature and a hang. The
  same list lower-cased is 31.6 ms and with an upper-cased `(SET) N` on every line 51.9 ms.
  Case-insensitivity was not lost, it **moved to the fold arm**, which lowercases both sides in
  Rust over `cards_fts` candidates — so a dropped `COLLATE NOCASE` here reads like a regression
  and is not one.
- **Splitting the exact-name and front-face arms was a _correctness_ fix that happened to be
  free.** As one `OR`, `MATCH_ORDER` was left to choose between a real card and a `"N // N"` row —
  and Scryfall's art series print exactly that, the trap
  [search's relevance ranking](data-and-sync.md) already records. Measured 2026-08-12 over the live
  corpus: **51 names** have a `"N // X"` printing that outranks every real printing of `N`, and **3
  of the reference list's 105 lines** resolved to an art-series row instead of the card
  (`Dakkon, Shadow Slayer` is the mechanism — `mh2` and `amh2` share a release date and the art
  series wins the `id` tie-break). Asked in sequence the exact name always answers first. A
  `MULTI-INDEX OR` **is** indexed, measured — and still wrong.
- **`import_read_file` takes a path, not bytes**, which is the whole reason `dialog:allow-open`
  is sufficient and **no `fs:` permission is granted anywhere**: a webview that can only _name_ a
  file needs none. The contract was shared with `export_write_file` and `deck_set_cover_image`;
  since custom deck covers went on 2026-08-31 it is shared with `export_write_file` alone, and
  `dialog:allow-open` is granted for this command rather than for two. The
  1 MB cap (`MAX_IMPORT_BYTES`, shared with the paste path so the two cannot disagree) is read off
  the **metadata**, so a 200 MB file pointed at by mistake is refused without ever being pulled
  into memory. Decoding is `from_utf8_lossy` **deliberately**: a Windows-1252 apostrophe in one
  card name should cost that one name, not the other hundred lines — the `U+FFFD` it leaves bears
  no card's name, so the damaged line comes back quoted in the preview while everything else
  resolves. A `from_utf8` would answer `Err` for the whole file and name no line.
- **The TypeScript half decides everything a _deck_ decision is** (`src/features/transfer/import/`,
  and its own [CLAUDE.md](../../src/features/transfer/CLAUDE.md) carries the binding rules): one
  parser with per-line rules only, the pile from `autoCategoryFor`, the commander from
  `commanderIneligibility`. The one type that crosses for it is **`CardIdentity`, the card-level
  half of `CardFacts`** — everything true of a printing and nothing true only of a row in a deck —
  so eligibility can be asked about a card that is in no deck yet. **`CardFacts` was deliberately
  not narrowed to it**: the engine really does read `categoryKind`, `categoryActive` and
  `quantity`, so a card in a deck is more than a card, and every existing caller passes a whole
  `DeckCard`, which satisfies a `Pick` of itself.
- **The corpus the format work was designed against is three real exports of _one_ deck**, held
  verbatim in `src/features/transfer/import/fixtures.ts`. **Most of this table is asserted rather than
  remembered**: `parse.test.ts`'s `the format fixtures` block counts the rows, the card lines, the
  copies, the 17 first-entry `{noDeck}` lines and the decoration columns off the fixture **text**
  rather than off the parser's reading of it, so a tidied fixture is a failing assertion rather
  than a page that quietly stopped being true. The two columns it does not carry — the heading
  count, and `//` in the flat list — were re-counted from the same text by the same rules on
  2026-08-16.

  | Fixture               | rows | headings | card lines | copies | `()` | `^label^` | `//` names | `{noDeck}` first |
  | --------------------- | ---- | -------- | ---------- | ------ | ---- | ------- | ---------- | ---------------- |
  | `ARCHIDEKT_SECTIONED` | 132  | 14       | 105        | 117    | 0    | 44      | 7          | 17               |
  | `ARCHIDEKT_FLAT`      | 88   | 0        | 88         | 100    | 0    | 43      | 5          | 0                |
  | `EMPTY_HINT_LIST`     | 88   | 0        | 88         | 100    | 33   | 0       | 0          | 0                |

  Three cross-checks fall out of that table and are worth more than any assertion invented for the
  purpose. **105 − 17 = 88 and 117 − 17 = 100**: the two flat lists are the sectioned one minus its
  maybeboard, so mis-handling `{noDeck}` breaks the arithmetic _between two fixtures_ rather than
  one number in one test. **The sectioned list is `REFERENCE_LIST`'s deck** with printings,
  categories and labels added, so the two fixtures check each other — its 105 names and 117 copies
  are the list the import feature was designed against in the first place. And **14 headings
  against 14 distinct first-bracket names, identical sets** — re-counted 2026-08-16, along with the
  stronger form: in **all 105** lines the first bracket entry is the heading that line is printed
  under, 0 disagreements. The heading and the bracket never disagree in a real export, which is
  what makes preferring the bracket safe.

- **What the TypeScript side learnt for those exports**, each rule with the failure behind it in
  [the transfer feature's own CLAUDE.md](../../src/features/transfer/CLAUDE.md): four per-line decorations
  (an **empty** `()` hint, an Archidekt `^Label,#colour^`, the `[Category]` bracket, the existing
  `*F*`) plus one heading rule that is **the only lookahead in the parser**; a bracket's first
  entry as the pile with `{flag}`s stripped, `{noDeck}` there meaning `is_active = 0` and `{noDeck}`
  on a later entry meaning nothing at all; **a heading or a bracket naming a section word setting
  the _section_ rather than a category**, so the four seeded piles are reached by one mechanism and
  not two; and `categoryName` held `null` whenever the section is not `deck`, which is the whole of
  what keeps the precedence chain at three rungs rather than four —
  `forcedCategoryName`, then `SECTION_CATEGORY[kind]`, then `line.categoryName`, then
  `autoCategoryFor(…)`. **The one cost is stated rather than discovered**:
  `resolve_lines` sets `hint_missed` for a collector number with no set beside it without trying it
  at all, so `EMPTY_HINT_LIST` previews **33 hint misses** where it previewed 33 unresolved cards.
  That is the honest trade and the alternative was 33 cards nothing found.
- **The export side is the mirror, and `src/features/transfer/decklists.test.ts` is what holds the
  two writers and the parser to each other**: three real decklists crossed with every format
  (`plain · mtgo · arena · moxfield · archidekt · tcgplayer · csv`), driven text → planner →
  writer → parser, with **every readable format a fixed point** — export → import → export
  byte-identical. **One of them is write-only and is excluded from that table by name**, so a
  format dropped out of it by accident fails rather than shrinking the matrix quietly. `tcgplayer`
  (added 2026-08-18), because its line is addressed to a shopping cart rather than to us:
  TCGplayer Mass Entry's most specific shape is `2 Lightning Bolt [2X2] 117`, and `parse.ts`'s
  `BRACKET` is anchored to the end of the line — so a bracket with a collector number after it is
  not a bracket to that parser and the whole tail lands in the card's name. `format.test.ts`
  measures that (`Lightning Bolt [LEA] 161` comes back as one card _name_) rather than leaving the
  exclusion as a claim. It is also the one flat format that keeps a switched-off pile: Arena and
  MTGO cut theirs because a maybeboard is an illegal import at the other end, while a Mass Entry
  list is a cart and the pile a reader switched off is usually what they still have to buy.
  **`csv` carried the same write-only label through Tasks 1–9 and stopped being true in Task
  10** — `parse.ts` reads a CSV by its header row now, so `decklists.test.ts` drives it over the
  same three decklists as every other readable format. Rust's only part in any of it is
  `export_write_file` taking the path `save()` answered, for `import_read_file`'s reason one
  shelf up: **no `fs:` permission is granted anywhere**.
- **Unverified, and not by choice: the file picker's own half.** `dialog:allow-open` opens a
  native window CDP cannot reach, so `import_read_file` was exercised by invoking the command
  with a path — exactly as `deck_set_cover_image` was, when there was one. The path → text →
  preview half is measured; the **click → path half is not**, and with the cover command deleted
  on 2026-08-31 the import is the only `dialog:allow-open` caller left for that gap to be closed
  against (`export_write_file` goes through `allow-save`, and has the same gap of its own).
- **Driven in the shipped window 2026-08-12**, `npm run tauri dev` — so a **debug** build with
  Vite serving the frontend (`/src/main.tsx` in the page's script list, which is the cheap proof
  that no stale embedded `dist/` is being measured), the live 116 695-card corpus, 1280×800.
  The gallery path end to end: `Import deck` → paste `REFERENCE_LIST` → the box counts
  **105 lines · 117 cards** → name it and pick Commander → Preview → **117 cards · 6 categories**
  and **no problem list at all** → pick a commander → Import → the editor opens on the new deck.
  **That `6 categories` is the tally bug being measured, not the shipped behaviour**: the pile
  count was computed before the commander was chosen and never recomputed, so the same press
  today reads **7 categories** with a `Commander` row — see
  [the transfer feature's own rules](../../src/features/transfer/CLAUDE.md) for the fix and the numbers.
  Read back through `deck_get`: **105 of 105 lines resolved** against the live corpus — 0
  unmatched, 0 hint misses, 0 parse issues — **105 rows carrying 117 copies**, and ten categories:
  the four `PREDEFINED_CATEGORIES` plus the six the import made (`Creature` 55, `Land` 38,
  `Artifact` 7, `Instant` 7, `Enchantment` 5, `Sorcery` 4) and `Commander` 1.
- **The two timings, both through `invoke` from the webview on that debug build**, medians with
  the first two runs dropped: `import_resolve` over the 105-line reference list **120.4 ms**
  (116.9–141.3, 9 warm of 11), and `deck_import_commit` over its 105 items **7.9 ms** (7.1–8.0, 5
  warm of 7, `replace` into a deck already holding them; outcome `added 117, removed 117,
categoriesCreated 0`). **That resolve figure does not contradict `resolve_lines`' 11.5 ms
  above** — that one is a **release** build, Rust-only, over a file; this one is **debug** and
  carries the answer back across the IPC boundary, which is **152.9 KB for 105 rows** (1.49 KB
  each, because every `ImportMatch` ships oracle text and the whole `legalities` object). Quote
  either only with its build named, or the pair reads as a regression that never happened.
  **That payload was measured while `ImportMatch` still carried `unitPriceUsd`**, which the
  marketplace merge has since removed (see the struct's own doc for why it is removed rather than
  paired with a euro twin) — about 20 bytes a row of 1 490, so ~1.3 % smaller now. Stated as the
  arithmetic it is; nobody has re-driven the window to re-measure it.
- **Variant scoping holds, measured rather than reasoned.** With a deck at 117 copies in both
  lists, a `merge` of a 7-card list into `theory` left `live` at **117** and took `theory` to
  **124**; a `replace` of an 11-card list into `live` took `live` to **11** and left `theory` at
  **124**. `replace` cleared the cards and **left every category standing** — `Creature`,
  `Instant`, `Sorcery` and `Enchantment` all survived at `card_count` 0, which is the "a category
  is the reader's filing, not the list's" rule with a number against it. The audit drawer wrote
  **two** rows for the replace and one for the merge: `Cleared 117 cards before importing` beside
  `Imported 11 cards into 4 categories`, against a bare `Imported 7 cards into 3 categories`.
- **Commander eligibility is right against the live corpus, including the 2026 Spacecraft rule.**
  The reference list offered **56** candidates: its **55** legendary creatures **and `The
Seriema`**, a `Legendary Artifact — Spacecraft` with a 5/5 P/T box (CR 903.3). `Delighted
Halfling`, the one non-legendary creature among its 56 creatures, was correctly not offered.
  This is the first time the `power`/`toughness` columns schema v5 added have been shown doing the
  job they were added for, on real data rather than on a fixture.
- **A hint narrows which _printing of the named card_ to take. It never overrides which card** —
  `hint_names_the_card`, and it was a live bug before it was a rule. `BY_SET_AND_NUMBER` consults
  no name in its SQL, which is deliberate and is what lets a non-English list land on the right
  cards; nothing then checked that the printing it found _was_ the card the line named, and
  `hint_missed` could not say so because the hint had not missed. Measured 2026-08-12 in the
  shipped window (**debug**) over the live corpus: `Captain Sisay (brc 132)` imported
  **`Arcane Signet`**, `Sol Ring (ltc 285)` **`Talisman of Conviction`**, `Forest (unf 235)`
  **`Plains`**, `Path to Exile (2x2 21)` **`Monastery Mentor`** — every one `hint_missed: false`
  with no problem list drawn at all. The row's name is now folded against the line's, and a
  disagreement is treated as **exactly** a hint that named nothing: `hint_missed`, and fall
  through to the name arms, so a wrong hint costs the reader the printing and never the card.
  **The check is the most permissive of the three name tests** (`fold_rank` — the whole folded
  name or the folded front face), because both binary arms imply their folded form; so the guard
  can only discard a row no name arm could have reached either. The set-with-name arms need none:
  the name is in their `WHERE` clause. Same reasoning as `deck_swap_printing`'s different-oracle
  guard — "swap this printing" must never become "swap this card".
- **`MOXFIELD_LIST`'s hints are real pairs, verified against the corpus** — and they were
  fabricated until 2026-08-12, when five of its six lines named a different card and the repo's
  own Moxfield fixture demonstrated the trap above rather than a Moxfield export. Nothing in CI
  catches that: the parser tests assert _parsing_, and Storybook carries its own corpus, so no
  green check ever resolves a fixture against real data. Verified against the live 116 695-row
  corpus (data of 2026-08-10): `Captain Sisay (INV) 237`, `Sol Ring (LTC) 284`,
  `Arcane Signet (ELD) 331`, `Forest (UNF) 239`, `Path to Exile (2X2) 23`. `Captain Sisay` has no
  `brc` printing at all — that set code was invented whole. **A hint that cannot be verified is
  dropped from its line rather than guessed at.**
- **`MATCH_ORDER` prefers English, behind the owned printing and ahead of the date.** Without a
  language term a name-only line lands on whatever paper printing is newest, which for **5 of the
  reference list's 105 lines** was not an English one: `Akroma's Will → soa 131 [ja]`,
  `Arcane Signet → hoc 95 [dw]`, `Mox Amber → hoc 96 [dw]`,
  `Elesh Norn, Mother of Machines → one 418 [ph]`, `The Wandering Rescuer → pwcs 2026-3 [ja]` —
  100 of 105 `en`. With `(c.lang = 'en') DESC` in the order those five become `soa 1`, `sld 2816`,
  `brr 98z`, `one 419` and `pdsk 41p`, and the list is **105 of 105 English** (re-measured
  2026-08-12 through `node:sqlite` against the live corpus, driving the shipped statements' own
  `WHERE`/`ORDER BY` text; the collection was empty, so `owned_quantity` was 0 on every row and
  the language term was the only key that could move). **Position is the whole decision**: behind
  `owned_quantity`, because a Japanese copy you own is still a copy you own and a deck that
  preferred an English printing you have not got would match nothing in the binder; ahead of
  the date, because "newest" is a tie-break for which printing looks current and is exactly the
  key that produced those five. `cards.lang` is `TEXT NOT NULL` holding Scryfall's codes (`en`,
  `es`, `ja`, … 19 in the corpus, 0 NULL), so the predicate is a plain equality and never a
  three-valued one — and the `id` tie-break still ends the order, so an import stays
  deterministic. The fold arm sorts in Rust and carries the same term in the same position,
  because that arm may never disagree with the SQL one.
- **Card images decoded in the shipped window for the first time.** The 2026-08-11 deck-builder
  pass could not render one because `cards.scryfall.io` was in a path-MTU black hole; on
  2026-08-12 that host was reachable and the pass left **401 files / 20.17 MB** under
  `data/images`, with a live `mtgimg://art/…` probe returning **626×457**. The black hole is a
  property of the network on the day, not of this app — which is exactly what the earlier entry
  claimed and nobody had been able to confirm.
- **An add that names no category is filed by the card's type line; an add that names one is
  untouched.** So every _drag_ overrides the rule by construction — pointing at a column is
  naming a category — and nothing in the write path has to tell a gesture from a press. The rule
  is `autoCategoryFor` and it is applied on **`useDeck.addCard`'s single definition**, which takes
  an optional `typeLine`; the _fact_ travels from the call site, because that is where a type line
  already exists. That arrangement is the whole point: the rule stays one TypeScript function
  (CLAUDE.md's boundary — Rust supplies facts, TS draws conclusions) and **no add pays a round
  trip to discover what it is adding**. `null` (an orphan, or a layout with no bucket word) is
  `Uncategorized`; **absent** — a caller with nothing to say — is `DEFAULT_CATEGORY_NAME`, a
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
  `newestWrite([...])` takes every one of them but `rememberView`** — update (the rename, the
  cover, the format and the `Split X` chip, all of which are the same deck-row write
  and therefore not four mutations), add-card, set-quantity, move, set-label,
  missing-to-wishlist, swap-printing — **and the `useDeckMeta` writes a right-click can now
  reach**, which are the label create and a category's rename, switch and delete. Read the array
  rather than a count: this sentence carried one and it went stale on 2026-08-14, when the card
  and category menus gave `setLabel` and the `useDeckMeta` writes a control in this view for the
  first time. `rememberView` is the one that stays out, because looking at a deck is not
  editing it.
  **There is no remove
  mutation**: the tray's drop and the stepper's zero are both `setQuantity(…, 0)`, because zero
  removes a deck row. The deck _row_ is a different hook — the gallery's `useDecks` owns create,
  update, remove and duplicate, and `useDeck.update` is that same `deck_update` narrowed to the
  open deck, which is how a header chip is one of them. A refused write re-reads the deck
  through whichever of them answered last, so a sibling's GONE is what turns the columns
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
  become "swap this card". Since v19 it also carries the row's **finish** across, and
  deliberately does _not_ check it against the target printing's `finishes`: a swap onto a
  printing sold in no foil would then be refused outright, where what a reader wants is the
  printing they picked.
- **Two surfaces press it now, through one hook.** The card pane's printings rows were the only
  presser until 2026-08-18; `AllPrintingsDialog` is the second, and it reaches the same
  `useSwapFromPane(context, variant)` rather than mounting its own mutation — which is the point
  of that hook rather than a convenience. `useDeck` is a live `deck_get`, so a second mount would
  be a second read of one deck, and TanStack shares a query's cache between observers but a
  mutation's state with **nobody**: two `useMutation` calls on this definition are two error
  states, which is why the refusal path invalidates `["decks"]` where no other write here does.
  Both surfaces address the row by the same five-part `PaneDeckContext`, and the modal's comes
  from the deck editor's own `deckSlotOf` — one definition shared with `openCard`, because a
  context naming four of five parts has twice rewritten the wrong row in this codebase.
- **`deck_set_card_finish` is `deck_swap_printing` one axis over**, and shares its shape for the
  reason it shares its `SwapResult`: the deck plays a different physical object of the same
  card. It **folds** the same way — setting a row to a finish the pile already holds adds the
  quantities and deletes the row that moved, with `label_id` and `needs_review` the surviving
  row's (`add_card`'s rule: the row that was already there is the one the reader labelled) — and
  it records the same **`swap` audit kind** rather than a tenth word, because `AUDIT_KINDS` is
  CHECK-constrained and a new word would mean rebuilding every reader's whole deck history for a
  spelling. Three refusals, each its own sentence: `SAME_FINISH` (and `nonfoil` compares equal to
  absent, because they are normalised first), `FINISH_NOT_SOLD` read off `cards.finishes`, and
  `GONE` for a row that is not in that pile. **Only the target finish is checked** — the finish
  being _left_ may well be one the corpus no longer lists, and refusing to move off it would
  strand the copies on exactly the value the reader is correcting.
- **Undo's `Cell` is deliberately finish-blind, and `CardRow` is what grew the column.**
  `Op::Cards` is "delete exactly `scope` and insert exactly `rows`", and a cell naming a
  `card_id` and no finish covers **both** rows of that printing — which is the correct scope
  rather than an oversight, because a finish change moves quantity _between_ those two rows and
  a scope naming one would delete half of what the write touched and restore half of what it
  read. Without `CardRow.finish`, though, a restored foil row comes back regular: the row is
  there, the count is right, and the only things wrong are what the deck says it plays and what
  it is worth. The undo sweep's own `snapshot` did not read the column when the two finish cases
  were added, so both would have passed vacuously — a column on `deck_cards` that a reader can
  see is owed a place in that snapshot in the same commit.
- **The deck has four views** — `Stacks | Table | Text | Grid`, `DeckEditor`'s `VIEWS`, crossed
  with three `Group by` modes (`category | manaValue | type`) and four sorts (`alphabetical |
manaCost | price | type`). All twelve combinations were driven live 2026-08-11; grouping and
  sorting were correct in every one, and an **inactive category stays its own group in all three
  grouping modes** rather than being folded in by mana value or type. Only `Stacks` and `Grid`
  fetch a picture, and it is the **whole card** — `cardImageUrl(…, DECK_CARD_VARIANT)`, which is
  `grid`; `Table` and `Text` are text and draw nothing —
  which is why the old single-row view's thumbnail, its `17rem` container query and
  `STACK_MAX_WIDTH` are gone rather than moved. **That pass predates the `Split X` toggle**
  (schema v13, 2026-08-14): the twelve stand as measured — the toggle is a modifier of one of the
  three modes and not a fourth mode.
- **The split arm was then driven live 2026-08-14** (`npm run tauri dev`, a **debug** build,
  1280×800, against the real 116,703-card corpus), and every claim above about it held:
  - **Exclusive, measured rather than argued.** A deck holding one `{X}{R}` (Fireball, mana
    value 1) read `Mana value 1 :: 2 rows` with the switch off, and `Mana value 1 :: 1 row` plus
    `Mana value X :: 1 row` with it on — **six rows either way**. The card has one home in both
    modes, which is the whole of the exclusive rule.
  - **The heading sorts where it says.** `Mana value 1 … 5`, then `Mana value X`, then the
    inactive `Maybeboard` — so the derived pile really does land ahead of the switched-off
    categories rather than among them.
  - **An empty X pile does not exist.** Removing the one `{X}` card took the heading with it
    while the switch stayed on, which is the derived-group rule and not a special case.
  - **It survives a reload, which is the whole point of the column.** `location.reload()`, back
    to the gallery, reopen: the chip read `aria-pressed="true"` and `Mana value X` was drawn
    again. `groupBy` itself came back at its default in that pass, which was the state of the
    tree it was measured on — **v12's `last_group_by` landed the same day** and a reopened deck
    now returns to the grouping it was left in, so the pair comes back together. The reason the
    chip is a _deck_ answer is unchanged and is now the reason both are: each says how _this_
    list is read.
  - **The audit sentence is right end to end**, which is the check that could only fail
    silently: the history drew _"Split the X spells into their own group"_ and _"Folded the X
    spells back into their mana values"_. A `"xGroup"` that disagreed with `deck.rs` would have
    rendered `auditText`'s default arm — a plain "Changed the deck" — and gone unnoticed.
  - **The curve is the arithmetic, not an estimate.** Ten `<li>`s, the tenth reading _"1 card
    with X in their cost"_, the list **216px** wide at **18px** cells, and `scrollWidth ===
clientWidth` — so the tenth bar fitted the 250px content box with no overflow, as derived.
    **Those two numbers are history rather than the current build**: the pass was driven against
    the 280px stats aside, and `main` moved the stats to a full-width band below the deck hours
    later. The cells are 20px again — see the bullet on the curve's width below. What the pass
    actually proved outlives the geometry: the derivation and the paint agreed to the pixel, and
    `scrollWidth === clientWidth` is the assertion that says a bar _fits_ rather than merely
    computes.
  - **`Avg. mana value 2.67` with the switch on and off.** The one number the split does not
    reach, confirmed against a live deck rather than a fixture.
- **`Split X` is a modifier of the mana-value grouping, and in a deck the rule for X is the
  _exclusive_ one.** A card printing `{X}` lands in `X_GROUP_KEY` — `"mv-x"`, headed
  `Mana value X` — **and in no other group**, because every surface drawing these headings counts
  copies and sums prices: a card in two piles makes the columns add up to more than the deck, and nothing on
  screen says which heading lied. **The search chips are the same idea shaped the opposite way,
  deliberately** — there X is an overlay ORed with the numerals, because a search cannot find one
  row twice ([search-faceting.md](search-faceting.md)). Neither is a bug in the other. The pile
  sorts at 9, after `8 or more` and ahead of `unknown`, which moved to 10; the reasons, the
  `{Y}`/`{Z}` exclusion and the `useState`-versus-`deck.update` rule are the frontend's, in
  [src/features/decks/CLAUDE.md](../../src/features/decks/CLAUDE.md).
- **The curve's cells are 20px in both arms, and for one afternoon they were not.** The tenth bar
  arrived while the stats block was a **280px** aside beside the deck (`STATS_WIDTH_PX`, `w-70`)
  that drew its own scrollbar. 280 less `p-3.5` on both sides and a 1px border is **250px** of
  content; nine 20px cells at `gap-1` are **212**, ten would be **236**, and 14px is not enough
  for a scrollbar the platform draws at roughly **15**. Widening the panel was the wrong half to
  give: that constant is what the `DECK_FLOOR` table measures the deck column against, so 24px of
  panel is 24px off the deck at every window size in that table — and a bar is cheaper than a
  deck. So the ten-bar arm narrowed to **18px** (`10 × 18 + 9 × 4 = 216`) and was measured in the
  window at exactly that.
  **Then `main` moved the stats into a full-width band below the deck and the constraint stopped
  existing** — there is no 250px budget, and the block no longer scrolls (`DeckEditor`'s section
  does), so there is no scrollbar to leave room for either. A tenth bar now costs nothing anybody
  was spending, and the chart is back to one cell width in both arms. **The compromise was
  correct and is gone**, which is worth having in writing: a number carried forward after its
  reason has been deleted is indistinguishable from a number nobody understood.
  **The 4px gap is what stayed put throughout** — it is the whole of what makes two `bg-surface`
  tracks read as two bars, and closing it to buy width turns the chart into one block. The width
  is written out whole (`w-5`) because Tailwind scans source text and one assembled from a number
  emits no rule at all.
- **A deck card is the whole card, and the app's marks are overlays on it.** Both picture views
  drew the 626×457 `art` crop inside three app-built bands until 2026-08-12, which showed the one
  part of a card that does not say what it is: no printed frame, no type line, no rules text, no
  P/T. Now the picture _is_ the card and the frame is gone — with it went `identityTint` (a
  printed frame is already that colour) and the app-drawn name and mana cost, which is why
  `deckCardName` on the button is the **only** name a screen reader gets and the frame under the
  picture writes the name in text.
- **The marks go left, and they used to go right** (changed 2026-08-13, off the `CardStack.dc.html`
  canvas). The old rule was right about a grey chip: a rectangle of app furniture over the first
  four characters of a printed name buys nothing. What sits there now is not a chip —
  `QuantityTag` is the card's **label, in the label's colour, with the copy count printed on it**,
  cut to a banner rather than a box, and down a fifteen-card stack that column of colour _is_ the
  structure of the pile. `LabelDot` is gone from this surface and unchanged on the other three.
  The cost is ~34px of printed name, paid knowingly; the app-drawn frame insets its own name band
  by exactly that width, so the one case where the app writes the name never hides a character.
- **The data line left the picture and became the card's foot** (same change). It was an overlay
  across the bottom of the art, which cost the reader the card's printed text box to say five
  things that fit underneath it. It is now a 28px bar below the face, pulled **4px** up so the
  face's clipped corners cover its square ones and the two read as one object. It is also a
  **sibling of the button** rather than a child, so unlike every mark over the art its text —
  rarity, printing, finish, price — is genuinely announced instead of being swallowed by the
  button's `aria-label`.
- **`CardStack` is the signature interaction, and it is arithmetic, not taste — and the card's
  height is now _derived_ rather than chosen.** It is a Magic card's aspect (the `grid` image's own
  488×680) applied to the 210px that `StackView`'s **fixed** `14rem` column leaves after its
  padding and the card's border, plus the data line less its 4px rise: **319px**. Collapsed it
  carries a **−285px** bottom margin, so each card advances by **34px** — a legibility floor for
  the overlaid tag rather than a fraction, and unchanged from when 34 was the app's own title bar.
  The list is given a **fixed** `stackHeight(n) = 34(n−1) + 319 + 8`, and the open card's margin
  turns −285 into +8: **a 293px push-down of every card after it, out of the box and over what is
  below, without the box changing size.** The column is never measured, which is what keeps
  `stackHeight` a function of the count alone.
- **Exactly one card moves per step, and that is the whole reason the interaction works.** With
  card _N_ open, card _k_'s top is `k·34` for `k ≤ N` and `N·34 + 327 + (k−N−1)·34` for `k > N`;
  open card _N+1_ instead and every top is unchanged **except card N+1's**, which travels 293px
  up from `N·34 + 327` to `N·34 + 34`. So the reflow is one card sliding out of the stack, not a
  list resettling — and the pointer that armed it stays inside it for every frame, because the
  card is 319px tall and slides up _underneath_ a stationary pointer.
- **The lift used to be pure CSS and is now state, because pure CSS could not be given hover
  intent** (changed 2026-08-12). The same arithmetic that makes one card move is what broke
  selection: after the first step the _next_ card's strip sits only ~34px below the pointer, so
  one continuous downward sweep crossed four or five strips in ~60ms, armed every one, and left
  the reader several cards below the one they aimed at. `CardStack` now holds `openIndex`, armed
  by `pointerenter` on the `<li>` after an **80ms dwell** (`STACK_OPEN_DWELL_MS`, 70ms until
  2026-08-14) and closed after **180ms** (`STACK_CLOSE_DELAY_MS`), where arming another card
  cancels the pending close so
  switching never shows a closed frame. **No new hit target was needed**: a closed card is
  overlapped 285px by its successor, which is later in DOM order and therefore paints over it,
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
  while the cards after it are still 293px from where they are going, so the card appears to
  jump in front of the stack and then have the stack catch up around it. Letting them uncover it
  is the whole fix, and once they settle nothing is over it anyway: an open card's bottom is
  `N·34 + 319` and its successor's top is `N·34 + 327`, 8px clear.
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
  this decides and `Uncategorized` is already the answer for not knowing. The pane's rows carry
  the **card's** type line, not the printing's — a `Printing` has none, and which pile a card
  belongs in is a fact about the card. A category column treats `"card"` exactly as the panel's
  `"search-card"`: add one copy. The remove tray narrows to `"deck-card"`, so a card from another wall never draws
  it. **The sidebar's Decks and Wishlist entries are drop targets**; Decks is inert with no
  deck open, which — because `setActiveView` clears `openDeckId` — is _every_ drag started
  from Search, Collection or Wishlist. So the sidebar's Decks target is reachable only from
  inside the Decks view (the docked panel, a deck card, the card pane). **A deck the reader
  left open is _parked_ rather than forgotten since 2026-08-27** (issue #162), and that does
  not soften this: the park is a field of its own and the deck is not handed back until Decks
  is on screen again, so on those three views the entry is inert exactly as it was.

## The pull: filling a hole the list already has

`deck_pull.rs`, [issue #351](https://github.com/Msgaihede/mtg-grimoire/issues/351), landed
2026-09-03. **The third crossing of the deck boundary, and the first that changes only custody.**
A deck lists four Bolts and its group holds one, so the editor reads `3 missing`; the reader owns
three more in a binder. One press moves them.

**It writes no `deck_cards` row, and that is the whole of what separates it from
`collection_to_deck`.** That command is *"add this card to the deck"*, so it folds the quantity
into the list — `ON CONFLICT … DO UPDATE SET quantity = deck_cards.quantity + excluded.quantity` —
as well as moving the cardboard. Pointing it at a four-copy line the reader is three short of
would make the line seven. A shortfall is a fact about *where copies sit* and about nothing else,
so the write that fills one touches one table.

**Two commands, and the read is the interesting half.** `deck_pull_plan` answers what the live
list is short of **that the reader already owns**; `deck_pull_from_collection` moves what the
reader picked. Splitting them is what makes the dialog possible at all: the issue asks for a
prompt when redundant options exist in different folders, and a prompt needs the options named
before anything moves.

### What counts as a candidate, and the two narrowings

- **Not in a deck folder** — `collection::Allocation::Unallocated`'s clause reused verbatim
  rather than respelled, so the root, a folder the reader made and `Recently removed` are all
  cards on their desk. `unallocated_excludes_only_deck_folders` is the test that already pins
  that reading. **This deck's own group is excluded by the same clause and has to be**: those
  copies are already counted in `owned_quantity`, so offering them would be offering to fill a
  hole with the thing already in it.
- **The exact printing and the exact finish, which is narrower than the number it is filling.**
  Owned/missing is attributed at the **oracle** grain — `owned_by_oracle`, "a Bolt is a Bolt" —
  so an Alpha Bolt filed in the group makes an M10 line read as owned. The pull deliberately does
  not do that. It fills strictly fewer holes than the app itself would count as fillable, and
  what the trade buys is that nothing is ever moved that is not the exact piece of cardboard the
  list names. **A reader who wants the substitution still has it**: the Collection Search tab
  files any copy into any deck, one press at a time. The narrowing is a decision (2026-09-03,
  the reader's own call) and not an oversight — it is pinned on both sides so that changing it
  later is deliberate.

**The shortfall folds to `(card_id, finish)` and never to the pile.** The same card short in two
categories is one row for the sum, because what a reader is short of is cardboard and custody is
a fact about the deck rather than about a column. `missing_to_wishlist` makes the same fold one
grain wider. The piles are named on the row for the reader to read and are never a term in the
arithmetic.

**A row with no candidate is dropped from the plan entirely**, so an empty plan is the ordinary
answer rather than an error — the issue says in as many words that not every card in a deck will
have a collection option.

### The candidate order is a decision

The root first, then `Recently removed`, then the reader's own folders by `sort_order`; ties
broken oldest-row-first, which is `take_copies`' own rule. It ranks by **how little of the
reader's filing a pull disturbs**: the root is a decision nobody has made and the holding area is
the app's own transient bin, where a folder somebody named is a decision they made on purpose. It
is only a pre-pick — every candidate stays in the dialog's picker, which is the issue's *"prompt
the user to choose which option to pull from"*.

### All-or-nothing, and no undo step

One transaction, and every pick is re-validated against a plan re-read **inside** it: an entry
that has since moved into a deck, been folded away by a merge, or a hole another window has
already filled. One disagreement refuses the whole batch in words and moves nothing.

That strictness is bought by the absence below rather than by taste. **The write files no
`deck_undo` step**, for `collection_to_deck`'s reason exactly: `take_copies` files the copies
*through the merge*, so a source row may have been folded into whatever the group already held
and no longer exists to restore — and putting them back is a quantity moved between two folders,
which is a command run backwards and the one design that journal rejects. So a half-applied pull
would leave copies in neither place the reader was looking at, with no press that takes it back.
The way back is the Collection Search tab, a card at a time.

### The history row reuses `move`, and `AUDIT_KINDS` stays at nine

One row per press: `kind = 'move'`, no `card_id`, `delta = 0`, payload
`{"pull": {"copies": N, "cards": M}}`. `auditText.ts` reads it **before** the per-card branches,
exactly where an import's row is read, because those branches would render it as "Moved a card" —
a sentence about a card the row has not got.

**A tenth `AUDIT_KINDS` word was never an option**, and the reason is `schema.rs`'s own: SQLite
has no `ALTER … CHECK`, so widening `deck_audit.kind`'s constraint means rebuilding every
reader's whole deck history for a spelling. `commit_import` met this first and reused
`add`/`remove`; `deck_undo` met it second and reused `deck` with a `field` payload. This is the
third time and the third reuse.

**`delta` is 0 and that is honest.** `delta` is what the drawer's day header adds up, and the
deck's *list* gained nothing — only its custody did.
