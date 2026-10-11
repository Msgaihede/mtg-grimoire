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
  The core's `schema.rs` module doc carries the whole-schema list and is the copy of record; this
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
  **That step went on 2026-08-31 with the custom deck cover**, so this command is rows again: no
  `covers` parameter, no `sweep_dir`, and `DecksCleared` carries `decks` and
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
  one group per surviving deck are rebuilt in the same transaction**, archived decks included and
  **virtual ones deliberately not** (`WHERE virtual_only = 0`, schema v40): an archived deck is a
  deck about cardboard the reader has put away, where a virtual one is a deck there is no
  cardboard for and `deck::create_deck` gives it no group in the first place — this button
  restores what a deck is *supposed* to have, and handing one to a deck that never had one would
  be it inventing a drawer nothing may write to. For the rest:
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
  `(deck_id, variant, name)`, so a reader's own "Ramp" is found rather than re-made and keeps `'user'`
  even once ramp spells are filed into it — and "Ramp", "Draw", "Removal" and "Land" are exactly
  what a person names their own piles. The one-time backfill and why it is frozen:
  [data-and-sync.md](data-and-sync.md).
- **A pile belongs to one list** — `deck_categories.variant`, user schema v53, issue
  [#561](https://github.com/Msgaihede/mtg-grimoire/issues/561). Until then a deck's Theory and
  Actual lists shared one pile set, because `deck_cards` carried the variant and
  `deck_categories` did not: a pile made on one tab drew on the other (empty, since `user` piles
  always draw), and one Sideboard switch answered for both lists. Now:
  - **Each list has its own four zones** — `ensure_predefined_categories(conn, deck, variant)`,
    run for `theory` by `create_deck` on a deck born with a plan and by `update_deck` on every
    switch-on — and its own names, order and switches; `CATEGORY_NAME_TAKEN` reads *This list
    already has a category with that name.*
  - **Every write that files a card checks the pile's list**: `deck::category_of_deck` takes the
    variant and answers `CATEGORY_WRONG_LIST` (*That category belongs to the other list.*) for the
    other list's pile, and `add_card`, `set_card_quantity`, `clear_category`, `move_card`,
    `swap_printing`, `set_card_finish`, the import commit and `collection_to_deck` all go through
    it or through the variant-scoped `category_for_name` — and `add_card_to_other_list` through
    `counterpart_in`, which only ever answers a pile of the list it is asked for, while
    `SAME_LIST` refuses a source pile that is already in that list. `reorder_categories` refuses
    a list that mixes the two (`CATEGORY_MIXED_LISTS`); a delete's move target must be in the
    same list; `decks.default_category_id` must name a **live** pile.
  - **Two presses carry a card across, and one rule finds its pile in the other list:
    `deck_meta::counterpart_in`**, by kind for a zone (any non-`main` kind) whatever it is called
    and by name otherwise. A pile the other list lacks is **made there as a copy of the source** —
    name, kind, `is_active`, `sort_order`, `origin` — so a card out of a switched-off pile never
    arrives in one that counts. The theory switch moves the live cards into the plan through it,
    leaving the live piles standing, empty; `deck_add_card_to_other_list` (2026-09-28, issue
    [#592](https://github.com/Msgaihede/mtg-grimoire/issues/592), in the card commands below)
    carries one card. Each records the piles it made in its undo step
    (`deck_undo::push_made_categories`), so an undo takes them away again.
  - **`DeckCategoryRow.card_count_all_variants` is gone** — a pile's copies are all in one list, so
    it always equalled `card_count`, and every confirmation quotes `card_count` now.
  - **A pile's history rows stay at `DECK_LEVEL`**: the history drawer does not filter by list, and
    no category sentence names one.
  - **The comparison is the only standing link between the lists**, and it matches cards, never
    piles (`deck_theory::theory_diff`); the two presses above match a pile at the press and keep
    nothing linked afterwards. The rung, the derived clone uids and the net for a group that
    climbed unevenly: `apps/desktop/src-tauri/CLAUDE.md`'s v53 entry.
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
  - **One thing did not change and one did, and the second looked as though it never would.**
    `engine.ts` still counts copies by card **name** and sums across rows, so a foil row and a
    plain row are two copies of one card. Owned/missing is the one that moved: through
    2026-09-06 it matched on **oracle id** and ignored finish (and condition and language)
    entirely, so a foil deck row was answered by whatever copies of that card the deck's group
    held, foil or not — this page used to call making a foil row want a foil copy specifically
    "a different feature with its own answer". `owned_by_printing` is that answer: it matches
    `(card_id, finish)` since 2026-09-07, so a foil row now reads missing against a group
    holding only the regular copy. Condition and language are still ignored — that much really
    is unchanged.
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
  `SIZE_KINDS` is `main`, `commander` **and `maybe`** — written in **four** places that must stay
  one rule: `engine.ts`'s constant, `deck.rs`'s `DECK_SELECT` subquery behind
  `DeckRow.card_count`, the Storybook fake's copy, and — since 2026-09-07 — `deck.rs`'s
  `PIP_COSTS_SQL`, the deck tile's colour bar, which was copied off `DECK_SELECT` rather than
  re-derived precisely because a bar counting a different pile than the number printed beside it
  is a tile disagreeing with itself.
  `the_colour_bar_reads_the_same_pile_the_gallery_count_does` is the fence on that fourth copy.
  Leaving `maybe` out is the incoherent
  version, not the smaller one: an _active_ Maybeboard was then inside the format's card pool
  and inside the binder's reservations but outside the size, so a second Sol Ring in it raised
  a singleton error under a figure that still read 100.
- **A plan holds no _cardboard_, and since 2026-09-09 that is the whole of what it means.**
  Nothing is filed into a theory list and nothing can be moved out of one: no
  `collection_entries` row ever sits behind a theory row, `collection_alloc::deck_to_collection`
  refuses one outright (`THEORY_HOLDS_NOTHING`) instead of moving zero copies and reporting
  success, and the theory list's write presses are refused or absent. What a plan's rows may now
  do is **count** — the copies the reader could put behind them, out of a pool of their own. The
  *Owned is where the copies sit* bullet below carries the two pools and the measurement;
  `deck::get_deck` is the one line that picks between them, and `attribute_owned` no longer
  mentions the variant at all.
  - **Through 2026-09-08 `attribute_owned` zeroed every `theory` row**, and the test
    `variant != LIVE` was true *by construction* rather than because a table lacked a column.
    It began as a fence around `deck_allocations` carrying no variant: a `theory` read walked the
    *live* deck's stored claims, and without the filter a plan was handed the copies the sleeved
    deck had reserved. Schema v25 deleted the ledger and the fence outlived it, because a **group
    is not scoped to a variant either** — `owned_by_printing` answers the whole deck's copies
    whichever list is open, so a plan would have read as covered by the cardboard it is not the
    plan for. That reason was real and is answered rather than dropped: the plan gets a
    *different map*, not the live one. `the_allocator_claims_nothing_for_the_theory_variant` was
    the test that pinned the old rule.
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
  **The explicit copy-from-live command that outlived that rule was removed on 2026-09-27** — it
  never had a caller in the app, so nothing copies one list into the other now.
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
  (2026-08-22), into an optional folder (2026-09-09). `only` is a list of `group_key` strings —
  the spelling `deck_theory_slots` still answers **in the `key` half of** its rows, so nothing new
  crosses the boundary — and an absent one still means the whole difference. It is an **include**
  list although the gesture it serves is exclusion ("drop three of
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
    `(oracle_id, card_id, preferred_finish, coalesce(folder_id, 0))`. `foil` and `etched` pass
    straight through. **That grain has had four terms since schema v23 and this line named three
    until 2026-09-09** — harmless only while this command wrote to one folder, and the wrong
    description of exactly the term the bullet below turns on.
  - **A pinned wish and an any-printing one are different rows on that grain**, so a reader who
    pressed this before the change keeps their old line and gains a pinned one. Nothing is lost or
    double-counted — the upsert folds each into its own row — but it is the one visible wart of the
    change and it is worth recognising before treating it as a duplicate bug.
  - **A token line is sent like a card line, with one difference** (user schema v55, the
    token-improvements spec §3.7). Since then `theory_diff` answers a row per token printing and
    finish the plan counts more of than the live list — `token_diff`, both lists read through
    `deck_token_rows` so an untouched token (at 0) asks for nothing, flagged `is_token` and
    captioned `Tokens & Emblems` — and this command files each as one wish pinned to the token's
    printing. The difference is `wish_finish`: **a token row's finish is spelled out, `nonfoil`
    included**, because `deck_token_printings.finish` is `NOT NULL` and the plan asked for that
    finish. ⚠️ **So the wart above has a token twin**: a Treasure wish made by hand, naming no finish
    (`NULL`), and the one Compare sends (`nonfoil`) are two rows on the wishlist grain — both a
    wish for that printing, neither folding into the other. Accepted rather than missed, like the
    card case. A token entry whose printing has left the corpus is an orphan and files no wish.
  - **`folderId` says which wishlist folder they land in, and absent — or `null` — is the root**
    (2026-09-09, [issue #437](https://github.com/Msgaihede/mtg-grimoire/issues/437)). The root is
    where every wish this command has ever written landed, so a caller that sends nothing means
    what it always meant; what changed is that the Compare dialog now has a reader who picked it.
    The id goes straight into `WishInput.folder_id`, a field on the wire since v23, so this is one
    argument passed and not a second way into the table. **It is an add and never a move**: the
    grain's fourth term makes a card the reader already wants in `Ordered` a *second* wish here,
    with the first left at its own quantity — `wishlist_set_folder` stays the deliberate move.
    **A folder that is gone is refused by name up front**, `FOLDER_GONE`, inside the transaction
    and before the diff is walked: `add_wish` fences the column too, but per row, and a plan short
    of nothing reaches `add_wish` not once — so a later check would answer `0 wishes` for a drawer
    another window had just deleted. `deck::missing_to_wishlist` took the same argument on the same
    day. Whole reasoning:
    [wishlist-folders.md](wishlist-folders.md#the-two-deck-sweeps-take-a-folder-now-and-the-same-term-is-the-licence).
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
- **Three of the label commands take an _optional_ deck since 2026-09-07, and what a deckless
  write skips is the whole of the change.** `deck_label_create`, `deck_label_update` and
  `deck_label_delete` each take `deck_id: Option<i64>`; `deck_label_all` never had one. **Tauri
  fills a missing `Option` argument with `None`**, so the deck editor's existing calls, which send
  a `deckId`, are unchanged and did not have to be found. The label itself was never a deck's —
  `deck_labels` has had no `deck_id` since schema v21 — so the id was only ever there for the
  *side effects*, and with no deck to name they are all three simply not written: **no
  `deck::touch_deck`, no `deck_audit` row and no `deck_undo` step.** The write to
  `deck_labels`, and the `deck_cards.label_id` clearing a delete does, are identical either way.
  **The reason is that the alternative would be a false entry, not that it was cheaper.** A rename
  made from Settings → Appearance → Labels reaches every deck wearing the label, so attributing
  it to one deck would put an event in a history that did not happen there; naming all of them is
  a feature nobody asked for, and a deck's history is per deck by construction. So the entry is
  not written at all. **What that costs is the undo**, and it is real: such an edit is in no
  deck's undo stack, so the editor's Ctrl+Z finds nothing to put back — which is why the panel's
  delete confirmation says so in its own paragraph rather than leaving a reader to discover it by
  pressing that chord in a deck. `deck_meta.rs`'s
  `a_deckless_label_write_records_no_audit_and_no_undo` is the fence.
  **A deck id that _is_ sent still means "where the reader was standing"** and never "what is
  being changed": the change is app-wide in both cases, and the history is honest rather than
  arbitrary because the *act* happened somewhere.
- **`format_specs` is data, not code.** All 23 Scryfall legality keys plus `casual`/`limited`,
  seeded by `INSERT OR REPLACE` in the migration, with `restricted_semantic`
  (`max_one` | `banned_as_commander` — TRAP A, never inferred from the key), `commander_rule`,
  `sideboard_max`, `allows_companion`, `max_mana_value` and `enabled_in_picker` as columns. A
  rules change is a **new migration step re-running the seed constant**, never an engine
  branch, and a new format is a row. Never derive one format from another.
- **Validation is TypeScript** (spec §3), in `packages/ui/features/decks/validation/`: `engine.ts`
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
  deleted. What replaced them at v25 was one statement grouped by oracle id:

  ```sql
  SELECT c.oracle_id, sum(e.quantity)
    FROM collection_entries e
    JOIN collection_folders f ON f.id = e.folder_id
    JOIN cards c ON c.id = e.card_id
   WHERE f.deck_id = ?1 AND c.oracle_id IS NOT NULL
   GROUP BY c.oracle_id
  ```

  **That statement narrowed to the printing on 2026-09-07**, because the count it answered and
  [the pull](#the-pull-filling-a-hole-the-list-already-has) that fills it were asking at
  different grains: the count could read *N missing* while the pull, matching exactly, honestly
  had nothing to offer for any of it — the disagreement [issue
  #351](https://github.com/Msgaihede/mtg-grimoire/issues/351) actually reported. The fix narrowed
  the count to meet the pull rather than widening the pull to meet the count:

  ```sql
  SELECT e.card_id, e.finish, sum(e.quantity)
    FROM collection_entries e
    JOIN collection_folders f ON f.id = e.folder_id
   WHERE f.deck_id = ?1
   GROUP BY e.card_id, e.finish
  ```

  `deck::owned_by_printing` (`owned_by_oracle` before that day) — **`sum(quantity)` over the
  deck's own group, keyed by `(card_id, finish)`** — and `attribute_owned` hands that map out
  along `read_deck_cards`' `ORDER BY`, which is the read's order and never a caller's, so the
  number a row shows cannot depend on how a view chose to display the list. **Matched by printing
  and finish, not by oracle id, so a Bolt is no longer just a Bolt**: an Alpha copy in the group
  no longer answers an M10 row in the list, which reverses what this page said until 2026-09-07 —
  a reader who wants that substitution still has it, one press at a time, through the Collection
  Search tab. **`JOIN cards` is gone with the rename**, and that is a behaviour change worth
  stating on its own rather than filing as an optimisation: an orphaned `collection_entries`
  row — one whose `card_id` is no longer in `cards` — used to have no oracle id to group by and
  read owned `0`; at the printing grain there is nothing to look up, the deck row and the
  collection row name the same `card_id`, and the copy counts. **One kind of row is passed over
  rather than served last** — a row in an **inactive** category, because a switched-off pile
  counts toward nothing anywhere and letting it take from the pool would move copies onto a
  scratchpad. There were two until 2026-09-09; the second was the whole theory list, and the next
  paragraph is what replaced it.

  **Since 2026-09-09 there are two pools, and `variant` picks between them**
  ([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)). The reporter's deck was a
  theory-and-actual one with a 100-card plan and 62 of that plan's cards sitting in the deck's own
  box; the Theory tab read **100 of 100 missing**. It now reads **38 of 100 missing**. The old
  answer was not a rounding error — the plan was told the reader owned *nothing*, on a deck most
  of which was already bought and filed.

  - **A `live` row is attributed from `deck::owned_by_printing`** — the statement above, the
    deck's own group and nothing else. Unchanged. What is sleeved up is answered by the cardboard
    in the box with the deck's name on it, and a copy in the binder is not in the deck.
  - **A `theory` row is attributed from `deck::available_by_printing`** — every copy the reader
    owns that this deck *could* use: `e.folder_id IS NULL` (the root), **or** filed in this deck's
    own group, **or** anywhere else that is neither another deck's group (`kind <> 'deck'`) nor
    effectively locked (`collection_folders::LOCKED_FOLDER_IDS`). `Recently removed` is a `kind`
    of its own and therefore still counts, exactly as it does in `Allocation::Unallocated`.

  That second pool is not a new statement. It is
  `collection_source::Availability::ForDeck(deck_id)` — the scope the deck builder's card search
  has counted by since [issue #349](https://github.com/Msgaihede/mtg-grimoire/issues/349) — spelled
  once and given a second reader, through a new whole-statement builder
  `collection_source::copies_by_printing_and_finish` grouped by `(card_id, finish)`. **Reused
  rather than restated on purpose**: a plan's owned figure and the `×N` badge in the search panel
  beside it are two numbers about one card, and a second copy of the arms is how they would come
  to disagree.

  **Both maps are keyed `(card_id, finish)` and `attribute_owned` hands either one out the same
  way** — the read's order, `min(remaining, quantity)`, a scarce pool. The function no longer
  mentions the variant at all; `get_deck` chose the map before it was called.

  **The ruling, 2026-09-09:** a plan counts from **available copies AND the deck's own cards**; an
  actual deck goes on counting only its own box. The asymmetry is the point rather than an
  inconsistency — *what am I still short of* and *what is in this box* are two questions, and the
  Theory tab is only ever asking the first.

  **Since 2026-09-27 the finish half of that key is the finish each row _plays_, on both
  tables** — the follow-up to [issue #563](https://github.com/Msgaihede/mtg-grimoire/issues/563),
  whose fix taught the theory comparison the same rule a day earlier. `deck_cards.finish` is NULL
  wherever a write named no finish, and nearly every write names none: the search's Add, the quick
  add, every drag, the card menu, a decklist line without a `*F*`. The collection's own add offers
  a printing only in the finishes it is sold in, so a foil-only printing's copy is `foil`. Keyed on
  the raw column, the deck row wanted `nonfoil` — a copy nobody sells — and every owned/missing
  read that translated NULL to `nonfoil` answered it wrongly:

  - `attribute_owned` read the row as **missing beside its own foil copy** in the deck's group;
  - `release_unclaimed_copies` read that copy as **unclaimed**, so the next *Use this printing* or
    finish change anywhere in the deck filed it into `Recently removed`;
  - `release_group_copies` found nothing behind the row, so a cut or a clear **stranded** the foil
    copy in a group that no longer listed the card;
  - `deck_pull_plan` offered **no candidate**, and `deck_missing_to_collection` and
    `deck_quick_add_to_collection` **recorded `nonfoil` copies** of a card sold only in foil;
  - `collection_to_deck` taking the foil copy out of another deck's group left that deck's unsaid
    row **standing with nothing behind it**;
  - the home page's deck completion followed `attribute_owned`, by its own contract.

  **The decision is yes: owned attribution matches on the played finish**, and the rule is one
  function rather than a re-spelling per site. `deck::played_finish` — moved out of `deck_theory`,
  where #563 wrote it, to sit beside `normalise_finish` — is the deck row's stored finish, else the
  printing's `deck::sole_finish` (`packages/ui/lib/finish.ts`' `playedFinish`, line for line), and
  `deck::entry_finish` is the same answer in the collection's spelling. **It reads a collection
  row's `nonfoil` exactly as it reads a deck row's NULL**, because both are the regular copy's
  spelling on their table and a printing sold only in foil has no regular copy. That half is what
  keeps the change from taking copies away: the quick add, *Add missing to collection*, a
  collection import that named no finish and the scanner's default finish all wrote `nonfoil` for
  such a card, every one of those rows answered an unsaid deck row while both sides translated to
  `nonfoil`, and keyed on the deck side alone they would stop counting — and be swept into
  `Recently removed` as unclaimed. `deck::entry_spellings` is the other direction, the words a
  copy of a played finish may carry, and is what the SQL matches (`finish IN (?, ?)`).

  **Measured on 2026-09-27 against the real dev database** (read-only): 13 548 foil-only and 892
  etched-only printings in the corpus; 22 collection rows (58 copies) of sole-finish printings, all
  stored in their sole finish — **45 of those copies in `Recently removed`** — no `nonfoil` row of
  one; and one live deck row of a sole-finish printing that named no finish. So the bug was live
  on real data and the legacy half guards a population this database happens not to have.

  **What moved**: both pools (`owned_by_printing`, `available_by_printing`) fold a collection row
  onto its entry finish; `attribute_owned`, `release_group_copies`, `release_unclaimed_copies`,
  `collection_alloc`'s `take_from_deck_list`, `deck_pull`'s candidates, `deck_theory`'s
  `OWNED_SPARE_SQL` and `deck_completion` key both sides on it; `live_shortfall` folds on the
  played finish and **reports** it, so `DeckPullRow.finish` and `DeckMissingRow.finish` say `foil`
  for an unsaid foil-only row, and an unsaid row and a `foil` row of one such printing are one
  shortfall row and share one pool; `deck_missing_to_collection`, `deck_quick_add_to_collection`
  and `deck_quick_add_wishes` resolve the finish they were handed through the printing, so the
  deck card's own NULL records — and clears a wish for — the foil. The page keys a `DeckCard`
  against the plan with `pullPlan.ts`' `deckCardPullKey`, the played finish, where it used
  `pullKey` on the stored one.

  **What did not move, deliberately**: a printing sold in two or more finishes, where an unsaid row
  is the regular copy and a foil copy does not answer it (`sole_finish` answers only when there is
  no choice); the `deck_cards` column itself, so a foil-only printing may still sit in one pile as
  an unsaid row beside a `foil` row that `collection_to_deck` wrote — two rows on the grain that
  every read above folds into one object; `wishlist::OWNED_SQL`, which decides whether a *wish* is
  filled and is its own finish rule; and the two collection writers that are not deck writes — the
  collection importer's `finish ?? "nonfoil"` and the scanner's default finish — which still
  *write* `nonfoil` for an unsaid foil-only card. Those rows are now read correctly and still
  written wrongly, and fixing the writers is a separate change.

  ⚠️ **`deck_theory::OWNED_SPARE_SQL` deliberately did not follow, and "fixing" it to match is
  the trap this paragraph exists for.** The shopping list is a *different* question and already
  nets the live list out: `theory_diff` computes `short = wanted − held`, where `held` is what the
  live list holds. Fold this deck's own group into `owned_spare` on top of that and the live list
  is counted twice — the exact double count `deck_theory.rs`'s module header and
  `missing_to_wishlist`'s doc both warn about at length, and the reason `missing_to_wishlist`
  subtracts nothing. Two surfaces, two questions: **the diff compares the plan against the _list_
  that is sleeved; the owned figure compares it against the _cardboard_ the reader can reach.** A
  reader looking at both sees a row that is short 2 on the shopping list and owned 2 of 4 in the
  editor, and neither number is wrong.

  **Nothing on the write side moved with it**, and each absence is deliberate:
  `deck_pull`, `deck_missing` and `deck::missing_to_wishlist` all still read `live` only;
  `collection_alloc::THEORY_HOLDS_NOTHING` still refuses to give a plan's copies back, because
  there are none to give; every write press that would file cardboard against a theory row is
  still refused or absent. Counting changed; writing did not. On the near side, `deckCardShort` still excludes `theory`,
  so a plan draws **no** per-card red `N/M` mark — which since 2026-09-09 is a decision of the
  repo owner's rather than a consequence of the zeroing it used to be
  ([issue #354](https://github.com/Msgaihede/mtg-grimoire/issues/354) is that history).

  **The cost is honest and worth stating: a `live` list's owned/missing is now exactly as
  accurate as the reader's filing.** The allocator guessed for them — it swept every collection
  row a deck's oracle ids matched and reserved greedily, so a card in the binder counted as "in
  the deck" whether or not the reader had ever sleeved it up. Now a copy counts for a deck when it
  is *in that deck's group*, and a reader who has not filed their cards sees a deck full of red.
  That is the trade the release makes: a number that is wrong in a way nobody can see, exchanged
  for a number that is exactly the reader's own filing and can be corrected by dragging. **And
  since 2026-09-07 "the reader's own filing" is read down to the exact printing and finish
  too**: a deck listing the Alpha Bolt with only an M10 copy on the shelf reads as missing until
  the reader drags the right printing in or presses *Use this printing*. **The theory list pays
  that cost and its filing consequence is different, which is the pool split's whole point**: a
  plan is not something the reader has filed anywhere, so demanding they file it before it could
  count was demanding a thing the app never asked them to do. Its rows are still read down to the
  exact printing and finish, so an M10 copy still does not answer an Alpha line there either.

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

  **The group is kept honest at the new grain by a sweep, not by the read.**
  `deck::release_unclaimed_copies(tx, deck_id, variant)` — 2026-09-07 — walks this deck's group
  and moves every copy no **live** `deck_cards` row claims at `(card_id, finish)` into
  `Recently removed`, through the same `collection_folders::take_copies` split every other
  release in this crate uses: a partial take on a row the eleven-term grain would otherwise
  collide on, never a bare `UPDATE`. "Claimed" means every **live** row, switched-off piles
  included — `attribute_owned` hands an inactive pile no copies, but the switch decides what is
  *counted*, not what is *claimed*, and reading it the other way would turn flipping a category
  off into a press that evicts that pile's cards from the deck. `swap_printing` and
  `set_card_finish` are the two callers, each running it **after** its own rewrite and inside the
  same transaction — the only two commands that change a live row's identity while touching no
  collection table, so before this sweep existed the group still held the *old* printing's
  copies once the reader swapped away from it (`release_group_copies`'s own doc already recorded
  the consequence: "after *Use this printing* the group still holds the *old* printing's row").
  A sweep after the rewrite rather than a targeted release before it, because a swap can *fold*
  into a line the deck already has — reading the finished list against the group answers both
  the plain case and the folded one with one query, where a targeted release on the old identity
  would have to reason about the fold to get the quantity right. A deck with no group holds
  nothing rather than refusing, and a missing `Recently removed` folder is resolved only when
  there is something to file — both `release_group_copies`' existing asymmetries, carried over so
  the two functions behave alike.

  **`release_group_copies` lost the oracle-grain fallback its `ORDER BY CASE` used to fall
  through to, and keeping it would now be a bug rather than a fix.** That fallback matched the
  exact `(card_id, finish)` first, then the same `card_id` at another finish, then any row in the
  group sharing an `oracle_id` — the third arm existing to cure exactly the stranding
  `release_unclaimed_copies` now prevents at the source. Under the exact grain it would raid a
  sibling line instead: a deck may legitimately list both LEA Bolt and M10 Bolt, with the group
  holding both, and cutting the LEA line short would give back M10 copies the M10 line still
  claims — the second arm is the same bug in the finish dimension. So the query narrows to the
  exact `(card_id, finish)` match and the `ORDER BY` reduces to `e.id`, and `swap_printing` and
  `set_card_finish` are the ones that now keep the promise the fallback used to.

  **Schema v36 runs the same sweep once, over every file that predates it.** The v25 conversion
  "replaced matched candidates by oracle id, so the conversion routinely files a printing the
  deck does not list" (`release_group_copies`'s own doc) — the `if v < 36` rung inlines
  `release_unclaimed_copies`'s logic in its own SQL and arithmetic rather than calling the app
  function (a migration step is history the day it ships, and app code it called would silently
  change what an old file is converted into), and applies it to every `collection_folders` row
  with `kind = 'deck'`. Where the copies land is load-bearing: `Recently removed` is ranked
  **second** in [`deck_pull::CANDIDATE_SQL`](#the-pull-filling-a-hole-the-list-already-has)'s
  `ORDER BY CASE`, after the root and before the reader's own folders, so the first press of
  `Import missing cards from collection…` offers those very copies straight back for every line
  that genuinely matches them, and the lines that do not match are honestly missing. A missing
  `Recently removed` folder skips the rung's move rather than failing it, for `NO_REMOVED_FOLDER`'s
  reason one level up: a hand-edited file without that folder must still open.

  **The residual is named rather than mechanised.** A device running an older build can still
  sync a `collection_entries.folder_id` that mismatches what its own live list claims —
  `release_unclaimed_copies` is idempotent and cheap to re-run, so the state is curable, but
  nothing in this design runs it on a sync. That is a known gap, written down here rather than
  built around.

  **`collection_to_deck` refuses a card the deck's live list does not already play** since
  2026-09-03 — `collection_alloc::NOT_IN_DECK`, issue #358. Filing assigns copies to a list rather
  than joining a card to a deck, so the one write that could create a placement is no longer
  allowed to satisfy the invariant by writing the other half itself. **The match is
  `deck::PLAYED_KEY`, `coalesce(c.oracle_id, dc.card_id)`** — oracle-first with the printing as
  the fallback, so an Alpha Bolt fills a deck listing the M10 one and a `deck_cards` row whose
  printing has left the corpus is still matched by its own id. **This is a different question
  from attribution and answers it on purpose**: PLAYED_KEY asks *does the deck play this card at
  all*, never which copies count toward it, and until 2026-09-07 it was `release_group_copies`'s
  own oracle-grain fallback rule reused rather than re-spelled. That rule left
  `release_group_copies` the day the exact-grain change made it a bug there (above), so
  PLAYED_KEY is the rule's only home now. **Live only**: a plan holds no *cardboard* — nothing is
  filed into it and nothing can come out of it — so a theory-only listing refuses. That much is
  untouched by 2026-09-09's pool split, which changed what a plan may **count** and not what it
  may hold. **And a *virtual* deck is refused ahead of the card question entirely**
  (`deck::VIRTUAL_HOLDS_NOTHING`, schema v40) — there is no binder these copies could come out of
  and no shelf for them to go on to, so every fence below would be answering a question that
  cannot arise. See [the deck-kind section](#the-third-deck-kind-a-deck-with-no-cardboard-behind-it).
  Two thin reads over the same expression serve the surfaces that say it early —
  **`deck_played_keys(deckId)`**, every key a deck's live list plays, and
  **`deck_ids_playing(keys)`**, every deck that plays *every* key given (`GROUP BY … HAVING
  count(DISTINCT …)`, an empty list answering nothing rather than everything). Neither takes a
  marketplace or a variant, because the answer is priced by nothing
  and scoped to one list by definition. `collection-folders.md` carries the placement argument and
  what the two greyed surfaces do with it.

  **The run list is not replaced by a shorter run list; it is replaced by nothing.** There is no
  derived table to keep in step, so no write "runs the allocator" and none can forget to. What
  moves a row *across* the deck boundary is the pair in `collection_alloc.rs` —
  `collection_to_deck` and `deck_to_collection` — **and, since 2026-09-03, three more that are not
  members of that pair**: `deck_pull.rs`'s `deck_pull_from_collection`, the third (see
  [the pull](#the-pull-filling-a-hole-the-list-already-has)), `deck_quick_add.rs`'s
  `deck_quick_add_to_collection`, the fourth (see
  [the quick add](#the-quick-add-recording-cardboard-nobody-had-written-down)), and
  `deck_missing.rs`'s `deck_missing_to_collection`, the fifth and the deck-wide form of the
  fourth (2026-09-08; see
  [adding the missing](#adding-the-missing-the-deck-wide-form-of-the-quick-add)). **The last two
  are the ones that put a row in a group without taking it out of anywhere** — that used to read
  "the fourth and the only one", and it stopped being true the day the batch landed — plus the six bulk presses that empty a group
  the reader is throwing away, every one of them into `Recently removed`: `delete_deck`,
  `deck_meta::delete_category`'s cascade arm, `deck::clear_category`, `deck::clear_variant`,
  `import::commit_import`'s `replace` arm, and Settings' `reset::clear_decks`. The five that
  release *one card at a time* share `deck::release_group_copies`, the crate's one walk over a
  group's rows, which matches the exact `(card_id, finish)` and nothing looser since 2026-09-07
  (it fell back to the oracle card before that day; see above) — the four bulk ones reach it
  through `release_live_copies`, which asks the `live` question for all of them;
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
  not** ([issue #349](https://github.com/Msgaihede/mtg-grimoire/issues/349)). `owned_by_printing`
  (`owned_by_oracle` before 2026-09-07) has scoped to the deck's own group since v25, so the
  row's `2/4` was already right — but the `×N` a
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
    and they disagree about one arm because they are asked from different chairs: the shopping
    list has already netted the sleeved deck out (`short = wanted − held`) and would count it
    twice if it counted the group as spare on top, while the deck builder's search has netted
    nothing out and those copies are that deck's. Folding the two into one helper would take a
    flag saying which — the same two functions with the difference hidden.
  - **`Availability::ForDeck` grew a second reader on 2026-09-09 and the wire field did not**
    ([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)). `available_for_deck` is
    still `DeckSearchPanel`'s alone; the scope it resolves to is now also what a `theory` row's
    owned figure is attributed from, through
    `collection_source::copies_by_printing_and_finish` and `deck::available_by_printing`. Two
    surfaces, one pool, deliberately — the `2/4` in the row and the `×2` on the tile beside it
    are two numbers about one card, and a second copy of the three arms is how they would drift.
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
  `packages/ui/features/decks/auditText.ts` is the only thing that reads that payload, and it is the only
  thing that words it — because a sentence is domain logic and this table has to survive the day
  the wording changes. Verified live 2026-08-11: a category move stored
  `{"from":"Main deck","to":"Ramp"}` with `card_name` `"Vampiric Tutor"` and `delta` 0, and the
  drawer read back "Moved Vampiric Tutor / Main deck → Ramp".
- **Writing history is not a command.** There is no IPC write — `deck_audit::record(tx, …)` is
  called _inside the caller's already-open transaction_, which is what makes
  `a_recorded_change_that_rolls_back_leaves_no_history` and `a_refused_write_leaves_no_history_
behind` true rather than hoped for; `every_deck_write_leaves_exactly_one_audit_row` drives
  **33** cases, each carrying the number of rows it owes (count the list in `deck_audit.rs`,
  never a remembered number — it has been written down wrong three times now; re-counted
  2026-09-26 off the case names, 27 at `50a02da9` and 33 after). **User schema v52 added six**:
  the five token writes — `deck_token_set_quantity`, `_swap`, `_add_printing`, `_state` and
  `_reset` — and `collection_to_deck (a token)`, the Collection tab's reroute, which records the
  token history row rather than a card move; the sweep also asserts that every token row is kind
  `deck` and that `AUDIT_KINDS` is still nine. It reached 28 on
  2026-08-23 by taking in `collection_alloc`'s two commands, which had been writing history under
  it for two PRs while the list stayed at 25: a sweep that exists to catch "a new deck write
  records nothing" cannot skip the writes that move cards. It fell back to 27 on 2026-08-31, when
  custom deck covers took `deck_set_cover_image`'s case out with them and this sentence was the
  half of that deletion nobody re-counted. **Five writes that do record history are not in the
  list** (re-counted 2026-09-08, still 27): `deck_category_clear` never was and `deck_clear` was
  not added beside it, and none of the three deck-boundary crossings went in either —
  `deck_pull_from_collection` and `deck_quick_add_to_collection` on 2026-09-03, and
  `deck_missing_to_collection` on 2026-09-08, which knew about the omission and matched it rather
  than fixing it for one command. So the test's name is wider than what it drives, and each of the
  five pins its history row in a test of its own: the two clears in `deck.rs`, the three crossings
  in their own modules (the batch's is inside
  `a_partial_pick_records_what_it_named_and_leaves_the_rest_short`, which asserts one `move` row
  naming no card at `delta` 0). "Exactly one" is per _change_, not per call, and
  **three** commands make more than one change in a call:
  **`deck_update` records one row per changed field**
  (`record_deck_edit`, pinned by `a_patch_that_changes_two_fields_records_both`), and it
  satisfies that test only because every one of its cases changes exactly one field —
  **which since schema v40 is a narrower escape than it sounds**, because a patch that moves the
  deck's *kind* changes two by construction: `deck_kind` writes `virtual_only` and
  `theory_enabled` as a pair, so a deck going from theory to virtual leaves a `theory` row and a
  `virtualOnly` row for one press. Two rather than one *"changed the deck's kind"* row, because
  "turned the plan off" and "made this a virtual deck" are two things a reader would want to find
  separately months later, and a single row would have to invent a vocabulary for a value that is
  stored nowhere. The sweep's `deck_update` case is a rename, so it is untouched;
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
    thrown away with the window and cleared by any other write *that window* makes. A
    database-backed redo would offer to resurrect a fortnight-old branch of edits the reader had
    forgotten making.
  - **The journal keeps each deck's newest 200 steps and the history keeps everything** (issue
    #553, 2026-09-27). Until then nothing deleted a `deck_undo` row but deleting the deck or a
    retired undo, and a step is rows on both sides: a settings Save carries all of `DECK_FIELDS`
    twice, an import or a theory switch the whole list twice. `record_step` now deletes the deck's
    rows below the newest `deck_undo::UNDO_STEPS_PER_DECK` by `audit_id`, in the caller's
    transaction, right after its insert — the one statement that files a step, so the one place
    the cap lives. `deck_audit` is not touched: it is the drawer's record and it **syncs**, where
    `deck_undo` does not, so a prune here is a local decision no peer sees. **It cannot take
    either button's target**: the row just inserted is the deck's highest id and applied, so it is
    the cursor, and no undone row sits above it for `next_redo` to find — what goes is the oldest
    applied steps and dead branches. Undoing down past the oldest kept step answers
    `NOTHING_TO_UNDO`, and a history row whose step is gone reads as a pre-v17 row does: worded,
    with nothing offering to reverse it (an undo's `{"of":…}` names a `deck_audit` id, so its
    sentence survives). **A dead branch counts toward the 200 until it ages out**, because deleting
    it would turn a stale redo's `MOVED_ON` into `NOTHING_TO_UNDO`. A database already over the cap
    sheds the excess at that deck's next step rather than at a schema rung.
  - **Three commands**: `deck_undo_state(deckId, redoId)` — the two `DeckAuditEntry`s the buttons
    name themselves from, the redo half answered only for the id the caller hands in, and only when
    it is `next_redo` —
    and `deck_undo_apply` / `deck_redo_apply`, which check the id against a cursor rather than
    trusting it: `next_undo` for an undo, and for a redo `next_redo`, the undone step above the
    undo cursor with the newest `undone_at`. **An undo stamps `max(now, newest + 1)` rather than
    the wall clock**, because a change undone before a later edit is a dead branch and has to carry
    an older stamp than anything undone after it — two presses in one second would otherwise tie,
    and a tie broken by id picks the dead one. **They ended with one `allocate_deck` run until
    schema v25 and now end with nothing**: what a deck owns is where its collection rows sit, and
    putting a `deck_cards` row back does not move a card.
  - **Then the deck itself is checked, because the cursor cannot see every write.** The cut and
    the Collection tab's filing (`collection_alloc`), a copy another deck's filing takes, a sync
    pull (`deck_cards` syncs, `deck_undo` does not) and Scryfall's reconcile all change
    `deck_cards` **without** filing a step. Applied blindly, a step deletes its scope and inserts
    its rows over them: Ctrl+Z after a cut brought the cut card back reading 0 owned, and undoing a
    move or an import after a filing left copies in the deck's group that no row claimed. So an
    undo needs the deck to hold the step's **redo** side and a redo its **undo** side, compared by
    content (row ids and timestamps ignored): the rows in an `Op::Cards` scope or a whole
    `Op::Variant` as a multiset; every `restore`/`patch` row of `categories`, `labels` and `notes`
    with its recorded columns, a note's whole attachment set, and each carrier cell still wearing
    its label; the `Op::Deck` columns the step moved. **`delete` lists are not checked there** —
    every id is a rowid alias somebody else's insert may hold, and every restore already remaps a
    taken id — and **the three view-state columns are never a reason to refuse** (a tab switch
    files no step and is not an edit).
  - **A delete on the side being *applied* is asked what it would take.** A pile delete CASCADEs
    every card under it and a label delete SET-NULLs it in every deck, so undoing "New category",
    or a quick add that invented its pile, took a card the Collection tab filed there since, and
    undoing "New label" stripped it off a card another deck labelled since. Such a delete may take
    only rows the same side's `cards`/`variant` ops rewrite anyway, or — for a label — cells the
    other side records as its carriers. A labelling carrier being applied may only land on a bare
    cell (or one already wearing it), which is the one check a label delete's undo gets: its redo
    side records no carriers.
  - **A refused undo retires its step; a refused redo writes nothing.** A redo refusal is
    `MOVED_ON`, and the webview drops that id. A refused undo deletes its own `deck_undo` row (the
    history row stays) and says **`RETIRED`** — "That change can no longer be undone…" — because a
    cursor that refuses refuses at every press and nothing older could ever be undone again, and
    because `MOVED_ON`'s "not the most recent change" would be false there: a reader believing it
    presses again and undoes the older change. **A write that fails is a refusal too**: the undo
    runs in a savepoint, and any error — a restored card naming a label deleted since, a restored
    pile whose name was taken since — rolls back to it and retires the step rather than failing the
    same way at every press.
  - **`undone_at` is an ordinal, not a time**, and a schema rung that rewrites `deck_cards`,
    `decks` or category, label or note contents without clearing `deck_undo` retires every step it
    touched at the first Ctrl+Z.
  - **`Op::Deck` writes only the columns whose two sides differ, and so does the category op's
    `default_category_id`.** Every `deck_update` step records all of `DECK_FIELDS`
    (`read_deck_row`), so a rename carries the folder, the archive flag and the view state on both
    sides; writing them all back reverted a folder delete's SET NULL, a tab switch and columns
    another device synced — and put a deleted folder's id into a real foreign key, which failed
    and left the cursor on a step that could never succeed. The rule reads the step, so every step
    already on disk keeps working. A `folder_id` the reversal *would* write that names a deleted
    folder is refused (and retired, like any refused undo) rather than skipped: a skipped column
    would report an undo that left the deck where it was.
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
  (changed 2026-08-14). `DeckInput` carries `name`, `formatKey`, `gameKey`, `description`,
  `coverCardId`, `folderId`, `theoryEnabled` and — since schema v40 — `virtualOnly`,
  (**`notes` was on this list until user schema v43**, which replaced the one column with a table
  — see *Notes* at the foot of this page; a deck is still born with none, and now that is a fact
  about a list rather than a `NULL`),
  because the "New deck" dialog now hosts the same
  settings form the settings dialog does and would otherwise be create-then-patch-then-setFolder:
  three transactions, and a half-made deck to roll back by hand the way
  `useImport.importIntoNewDeck` has to. Five things about it that are **not** `deck_update`'s
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
  its plan fills through the ordinary card writes aimed at `theory` — the copy-from-live command
  once named as this route never had a caller and was removed on 2026-09-27. The two routes
  differ in what they _do_ and agree exactly on what a new deck ends up with. **(4)** `virtualOnly` at create
  is **not cross-checked against `theoryEnabled`**, where the patch route's `deck_kind` clears
  whichever half a press did not name: there is nothing to clear on a row that does not exist
  yet, and a create that silently rewrote one of the two fields it was handed would be answering
  a question the caller did not ask. What it *does* change is the one statement in this function
  that is not part of the INSERT — **a deck born virtual is given no `collection_folders`
  group**, `create_deck_group` sitting behind an `if`, because a deck that owns no cardboard has
  nothing for that row to hold and its *absence* is what makes every owned readout answer 0 with
  no branch anywhere. The patch route reaches the same place destructively (it empties the group
  into `Recently removed` and deletes it); a deck being born holds none and is simply never given
  one. **(5)** a deck's birth stays
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
  never 1 or 5 — is `packages/ui/features/decks/validation/bracket.ts`'s.
  [commander-brackets.md](commander-brackets.md) is the whole record.
- **`decks.theory_mark_exact`, `decks.theory_mark_name` and `decks.theory_mark_unplanned` are
  which of the theory mark's three tiers this deck draws, and all three are on by default**
  (2026-09-07, the third 2026-09-08). `INTEGER NOT NULL DEFAULT 1` each — a Live row's mark says
  either *this is the printing you planned* (the **exact** tier, green, **schema v38**) or *this
  is that card in a printing you did not name* (the **name** tier, blue, v38) or *the plan does
  not ask for this at all* (the **unplanned** tier, a red X, **v39**), and a deck may switch any
  of them off. `DEFAULT 1` is the whole of each upgrade: every deck that already exists draws all
  three marks from the first launch on the new build, so there is no backfill because there is
  nothing for one to do, and no deck sits in a state its reader has to discover. They ride
  `DeckPatch`, `DeckRow`, `DeckBefore` and `DECK_SELECT` as the four columns above do, take the
  **last** three indexes in `deck_row` and the **last** three `?` holes at the end of
  `update_deck`'s `SET` list — read them off the code, for the reason `separate_x_group`'s bullet
  gives — and are deliberately **not on `DeckInput`**: they are a reading preference, and a deck
  being born has not been read yet, so they take their DDL default like the columns beside them.
  `DECK_SELECT` put them last of the deck's own columns, which is that positional trap read one
  grain finer: all three are `INTEGER` among the row's other `INTEGER`s, so a column inserted
  anywhere but last hands a bracket to a bool and nothing goes red.
  **Three columns rather than one enumerated one**, and the reason is expressive rather than
  tidy: `none | exact | both` cannot spell blue *without* green, and blue without green is a real
  answer — a reader who cares that a card is present and not which printing it is. The third
  settles that argument rather than extending it: *is this card in the plan at all* is a different
  question from *which printing of it*, so no ordering of a single field turns red on while
  leaving green and blue where they were. It is also why the off states are not symmetric, which
  is entirely TypeScript's business: green off **re-resolves an exact row as a name row**, blue
  with blue's number; blue off silences a name-only row and leaves green alone; red off silences
  only the rows in neither map — and a *planned* row never falls through to red, whichever of the
  other two is off. **Rust stores three booleans and concludes nothing from any of them** —
  `AUTO_CATEGORY`'s rule and `bracket`'s: which tier a row lands in, and what number or glyph it
  carries, is `theoryMatchMark`'s.
  **`duplicate_deck` carries all three across** and `archived` still resets, the same line
  `separate_x_group` and `bracket` sit on: what describes the deck comes over, what state the deck
  is *in* does not. All three are on `deck_undo::DECK_FIELDS` for `bracket`'s reason — an ordinary
  `deck_update` writes them and an ordinary history row records them — and **all three, never a
  subset**: one Save can move the whole set, so a list carrying only some of them restores half a
  press, which is worse than restoring none of it because the drawer would still name the change
  it had not undone.
  **The audit words are `"theoryMarkExact"`, `"theoryMarkName"` and `"theoryMarkUnplanned"`**,
  camelCase, the third, fourth and fifth multi-word field names `record_deck_edit` writes after
  `"xGroup"` and `"defaultCategory"` — so the same silent-drift rule applies, and **unlike
  `bracket` these three have `auditText.ts` arms**, pinned by `auditText.test.ts`; the third reads
  *"Started marking cards not in the theory list"* / *"Stopped marking cards not in the theory
  list"*. Three arms rather than one, `record_deck_edit`'s own reason: a reader who moved two
  switches in one Save made two decisions, and a single row saying "changed the theory marks"
  could be worded into neither. The payload carries the **boolean** on both sides and there is no
  `detail`, `xGroup`'s shape: a boolean's `from` is whatever its `to` is not, so "was off" under
  "turned it on" is a line of history spent saying nothing.
  **All three columns are on `capture::TABLES`' `decks` spec and travel to paired devices**,
  `bracket`'s precedent at v26: which tier a deck draws is an answer *about the deck*, and two
  devices showing one deck's marks differently with nothing on screen explaining it is the
  failure that edit prevents. That spec spells its field list out by hand and **there is no fence
  in the other direction** — nothing asserts that every column of a synced table is on its spec —
  so each name needed a deliberate edit rather than travelling for free, and v39 made that the
  second such edit in two days. **The mark's _colours_ are
  deliberately not on it, and that asymmetry is a decision**: see
  [sync.md](sync.md), which holds the synced-tables list. The `DEFAULT 1` is load-bearing for the
  sync as well as for the no-backfill argument, and [data-and-sync.md](data-and-sync.md) carries
  that half.
- **`decks.virtual_only` is the third deck kind, and the kind is a _pair_ of booleans rather than
  a column of its own** (`INTEGER NOT NULL DEFAULT 0`, **schema v40**, 2026-09-08,
  [issue #401](https://github.com/Msgaihede/mtg-grimoire/issues/401)). What the kind *does* is
  [the section below](#the-third-deck-kind-a-deck-with-no-cardboard-behind-it); this bullet is
  the storage of it. `theory_enabled`/`virtual_only` reads `0/0` regular, `1/0` theory-and-actual,
  `0/1` virtual, and `1/1` names none of the three.
  **`DEFAULT 0` is v34's choice and not v38's**, which is the same question answered opposite
  ways one column apart: v38 defaults a *mark* on because the default is what the reader gets,
  and this defaults off because a kind is what a deck **is**, so the upgrade leaves every
  existing deck exactly as it was. **The enum was the alternative and it lost on what it would
  have had to rewrite**: `theory_enabled` is already named by three commands, a sync spec, an
  undo journal and a history payload, and a rung that rewrote it would have bought a second
  spelling of a fact all four readers would then have to be taught. The price is two columns that
  *can* disagree, and `deck::update_deck` is where they are stopped — `deck_kind` resolves a
  patch's two `Option<bool>`s into the pair the UPDATE binds, so setting either flag clears the
  other in the values that are bound. **Not a `CHECK`, and this rung could not have carried
  one**: SQLite's documented `ADD COLUMN` restrictions rule out a table-level constraint and the
  column-level one that is legal cannot see `theory_enabled`, so the fence would have cost v35's
  kind of table rebuild for a rule one command holds — `valid_bracket`'s argument, that a command
  parameter reaches this column and a refusal in Rust can name the mistake.
  **The positional trap is v39's read one grain sharper, and this is the ninth time the rule has
  been owed.** The column is **last** in `DECK_SELECT`'s named list, `deck_row` reads it at the
  last index and `deck::IMAGE_COL` moved 25 → 26 with it — and the column it most reads like a
  neighbour of is `theory_enabled`, the *other half of the same pair*, so an index that landed
  there would not merely swap two switches: it would hand a deck's kind to its own opposite, with
  both fields still holding a `0` or a `1` and all three kinds still looking like answers. **The
  *move* is named here because it is a fact about the rung; the index is not, because it is a fact
  about today's column list** — `separate_x_group`'s rule above, which has already been paid once.
  Read both off `deck_row`.
  **It rides `DeckInput`, `DeckPatch`, `DeckRow`, `DeckBefore` and `deck_undo::DECK_FIELDS`, and
  the last of those is beside `theory_enabled` and never without it** — `update_deck` writes both
  columns whenever either is turned on, so a list carrying one and not the other would let Ctrl+Z
  put a deck's plan back while leaving it virtual, which is the `1/1` the pair exists to keep
  out. **What an undo restores is the column and nothing else**, and nothing claims otherwise: a
  step writes `decks` and `deck_cards` and no third table, so the copies filed into
  `Recently removed` and the group that was deleted stay where the press put them. That is
  `collection_alloc`'s two moves' own standing — they record a history row and file no step at
  all — and it is the honest answer here, because a rebuild would have to decide which copies in
  a shared holding area had come from this deck, which nothing records. The way back is a second
  press of the switch, and the cards are waiting in `Recently removed`.
  **`duplicate_deck` carries it across**, on this list twice over: it is not a way of *reading* a
  deck but what the deck **is**, and its `DEFAULT 0` runs the failure the opposite way from the
  theory marks' — a copy that came back an ordinary deck would be *more* connected to the
  collection than its original, and the app would immediately start offering to buy cards for it.
  A virtual copy is given no group either, `create_deck`'s `if` reached from the other side, and
  `virtual_only` comes back out of the INSERT's own `RETURNING` rather than being read twice.
  **The audit word is `virtualOnly`**, camelCase, the sixth multi-word key `record_deck_edit`
  writes after `xGroup`, `defaultCategory` and the three theory marks — so the same silent-drift
  rule applies, and it has an `auditText.ts` arm (*"Made the deck virtual"* / *"Made the deck
  track your collection again"*) pinned by `auditText.test.ts`. Booleans on both sides and no
  `detail`, `xGroup`'s shape. The copies the write releases and the group it takes away are
  deliberately **not** recorded here: those land on the *collection*, and a reader looking for
  where their cards went finds them in `Recently removed`, which is what that folder is for.
  **And it is on `capture::TABLES`' `decks` spec, which is the strongest case that hand-written
  list has ever had.** A deck that is virtual on the machine it was made on and an ordinary deck
  on every other one would have its collection integration back on those, offering to file, pull
  and buy cardboard for a list that exists precisely because the reader owns none of it — and
  there is still **no fence in the other direction**, so the name needed a deliberate edit rather
  than travelling for free. **Only the flag travels**: the group `update_deck` deletes is a
  `collection_folders` row and the copies it releases are `collection_entries` rows, both synced
  tables of their own, so both halves of the transition arrive as ops about *those* tables from
  the same press and nothing re-derives a side effect from a boolean. `DEFAULT 0` is what makes
  the old-peer direction safe, `theory_mark_*`'s note verbatim: a deck built from an op a device
  one rung back sent arrives as an ordinary deck, which is the only thing that device can have
  meant.
- **The single-card commands, and what each takes** (the three bulk ones,
  `deck_import_commit`, `deck_category_clear` and `deck_clear`, have their own bullets below).\
  `deck_get(id, variant)`;
  `deck_add_card(deckId, cardId, categoryId, categoryName, variant, quantity)` — **either an id
  or a name**, id wins when both arrive, neither is refused in words, and the name is
  found-or-created (the word being TypeScript's `autoCategoryFor` to compute, because which
  pile a card belongs in is domain logic); `deck_add_card_to_other_list(deckId, cardId,
  fromCategoryId, variant, finish, quantity)`, the add with a third way to name the pile — see
  its own bullet below; `deck_set_card_quantity(deckId, cardId, categoryId,
variant, quantity)`; `deck_move_card(deckId, cardId, fromCategoryId, toCategoryId,
toCategoryName, variant)`, which stays inside one variant and takes **either an id or a name
  exactly as the add does** — see the bullet below; `deck_swap_printing(deckId, fromCardId, toCardId, categoryId,
variant)`; `deck_missing_to_wishlist(deckId, folderId?)`, which reads `live` and skips inactive
  categories, and whose `folderId` is a **wishlist** folder rather than anything of the deck's —
  absent or `null` is the wishlist's root, which is where this press landed on every build before
  2026-09-09, and a folder that is not there is refused as `FOLDER_GONE` before the shortfall is
  walked. Two fences every write opens with, **neither of them enforced by the DDL**: the
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
  - **A move onto a pile that already holds the printing folds, and the fold keeps a label**
    ([issue #643](https://github.com/Msgaihede/mtg-grimoire/issues/643), 2026-09-28). The
    quantities add and `needs_review` stays the surviving row's; the label is
    `label_id = coalesce(deck_cards.label_id, excluded.label_id)` — the surviving row's own label
    stands, and an unlabelled survivor takes the moved row's. The `DO UPDATE` used to set
    `quantity` alone, so re-filing a labelled card onto an unlabelled row of the same printing
    took the reader's label off it, where the issue's rule is that a label falls off only when
    the reader removes it or the card. **Three other folds of a `deck_cards` row onto another
    follow the same rule**, each fixed in the same change: `deck_category_delete`'s move arm
    (`move_card`'s statement over a whole pile), `deck_meta::refile_stray_theory_cards` (v53's
    net for a theory card left in a live pile) and `reconcile::fold_deck_card_into_existing` (a
    Scryfall merge landing on a row the pile already holds). The import's `ON CONFLICT` already
    coalesced.
- **`deck_add_card_to_other_list` → `deck::add_card_to_other_list` copies a card into the deck's
  other list** (2026-09-28, issue [#592](https://github.com/Msgaihede/mtg-grimoire/issues/592),
  behind the card menu's `Add to actual` / `Add to theory`). `variant` is the list the card goes
  **into** and `fromCategoryId` the pile it sits in now, which the write leaves alone. It is
  `add_card` with a third way to name the pile: `add_card`'s body takes a private pile enum
  (`AddPile` — by id, by name, or the counterpart of a pile), and the third arm is
  `deck_meta::counterpart_in` — by kind for a zone and by name otherwise, **made as a copy of the
  source** when the target list lacks it (the rule in the one-list bullet above, and the owner's
  choice over a plain name match). It resolves inside the transaction and **after
  `touch_deck`**, so a deleted deck still answers `GONE` first. Two refusals of its own:
  **`NO_OTHER_LIST`** (*This deck keeps one list, so there is no other list to add to.*) for a
  deck whose `theory_enabled` is off, and **`SAME_LIST`** (*That category is already in the list
  the card is going to.*) for a source pile of the target list; a pile that is not this deck's is
  `CATEGORY_GONE`, as in `counterpart_in` itself. The page sends a quantity of 1 — one copy per
  press, every other add's rule — and the grain folds it, so a second press is a second copy.
  - **The history row is an ordinary `add` in the target list**, naming the counterpart pile, and
    the undo step is `add_card`'s: the cell, plus the pile diff that takes a pile the add made away
    again. Undo is per deck, so Ctrl+Z on either tab reverses it.
- **`deck_category_clear(deckId, categoryId, variant)` empties one pile of one list, and exists
  for `deck_import_commit`'s reason** (added 2026-08-15, behind a category heading's right-click
  `Clear stack…`). The frontend holds every row of the pile, so a `deck_set_card_quantity(…, 0)`
  per row would work — and would be a transaction and a `["decks"]`
  invalidation **per card**, plus one history line each for a press the reader made once, plus a
  refusal halfway leaving the pile half-empty with nothing able to say so. One statement, one
  transaction, one history row. (It was "one allocator run" as well until schema v25; the
  arithmetic that made this a command survives the allocator that first motivated it.)
  - **Variant-scoped, and since user schema v53 so is `deck_category_delete`.** A delete used to
    cascade through both lists, because `deck_cards.category_id` is `ON DELETE CASCADE` and a
    category was not per-variant, so the two confirmations quoted different numbers
    (`cardCountAllVariants` against `cardCount`). A pile now belongs to one list (issue #561), the
    field is gone, and both quote `cardCount`.
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
    `packages/ui/features/decks/listNames.ts`.
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
  nothing**, because a plan holds no cardboard to release; the fence is inside the helper, so the
  `replace` arm does not ask. **A _virtual_ deck's `live` list releases nothing either, and that fence is
  inside the helper too** (schema v40) — one layer further down, in `release_group_copies`, whose
  first rule is that a deck with no group holds nothing. So an import over a virtual deck's list
  walks an empty set and needs no arm here; it is the same absence that lets `deck_clear` and
  `deck_category_clear` work on one unchanged, and the reason `commit_import` grew no
  `VIRTUAL_HOLDS_NOTHING` of its own. An empty item list is refused in words (`NOTHING_TO_IMPORT`), which matters most
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
- **`import_pick_file` opens the file dialog itself and answers text — no path crosses IPC in
  either direction** (issue #545, 2026-09-28), and Rust reading the file is why **no `fs:`
  permission is granted anywhere**. It was `import_read_file(path)` until then, taking the path the
  page's `open()` answered on the argument that a webview that can only _name_ a file needs no
  filesystem permission — true, and beside the point: the command took *any* path a script in the
  page named, which made it a read of any text file up to 1 MB. `export_write_file` shared that
  shape and was fixed the same way (`export_save_file`); `deck_set_cover_image` shared it until
  custom deck covers went on 2026-08-31. The page is granted no `dialog:` permission now.
  *(The next two sentences are the 2026-08-12 design, and issue #555 replaced both: the cap is a
  bounded read rather than a metadata check, and the decode is never lossy for a Western European
  file. `import.rs`'s `read_bounded` and `decode` are the current rules.)* The
  1 MB cap (`MAX_IMPORT_BYTES`, shared with the paste path so the two cannot disagree) is read off
  the **metadata**, so a 200 MB file pointed at by mistake is refused without ever being pulled
  into memory. Decoding is `from_utf8_lossy` **deliberately**: a Windows-1252 apostrophe in one
  card name should cost that one name, not the other hundred lines — the `U+FFFD` it leaves bears
  no card's name, so the damaged line comes back quoted in the preview while everything else
  resolves. A `from_utf8` would answer `Err` for the whole file and name no line.
- **The TypeScript half decides everything a _deck_ decision is** (`packages/ui/features/transfer/import/`,
  and its own [CLAUDE.md](../../packages/ui/features/transfer/CLAUDE.md) carries the binding rules): one
  parser with per-line rules only, the pile from `autoCategoryFor`, the commander from
  `commanderIneligibility`. The one type that crosses for it is **`CardIdentity`, the card-level
  half of `CardFacts`** — everything true of a printing and nothing true only of a row in a deck —
  so eligibility can be asked about a card that is in no deck yet. **`CardFacts` was deliberately
  not narrowed to it**: the engine really does read `categoryKind`, `categoryActive` and
  `quantity`, so a card in a deck is more than a card, and every existing caller passes a whole
  `DeckCard`, which satisfies a `Pick` of itself.
- **The corpus the format work was designed against is three real exports of _one_ deck**, held
  verbatim in `packages/ui/features/transfer/import/fixtures.ts`. **Most of this table is asserted rather than
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
  [the transfer feature's own CLAUDE.md](../../packages/ui/features/transfer/CLAUDE.md): four per-line decorations
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
- **The export side is the mirror, and `packages/ui/features/transfer/decklists.test.ts` is what holds the
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
  `export_save_file` opening the save dialog and writing where it answered — `export_write_file`
  taking the path `save()` answered until issue #545 — for `import_pick_file`'s reason one shelf
  up: **no `fs:` permission is granted anywhere, and no path crosses IPC**.
- **Unverified, and not by choice: the file picker's own half.** `dialog:allow-open` opens a
  native window CDP cannot reach, so `import_read_file` was exercised by invoking the command
  with a path — exactly as `deck_set_cover_image` was, when there was one. The path → text →
  preview half is measured; the **click → path half is not**, and with the cover command deleted
  on 2026-08-31 the import is the only `dialog:allow-open` caller left for that gap to be closed
  against (`export_write_file` goes through `allow-save`, and has the same gap of its own).
  *(2026-09-28, issue #545: Rust opens both dialogs now — `import_pick_file` and
  `export_save_file` take no path, and the page is granted no `dialog:` permission — so neither
  command can be driven with a path any more. The gap is unchanged in kind: the click → chosen
  file half is the native window's, and the read and the write after it are unit-tested over real
  files.)*
- **Driven in the shipped window 2026-08-12**, `pnpm tauri dev` — so a **debug** build with
  Vite serving the frontend (`/src/main.tsx` in the page's script list, which is the cheap proof
  that no stale embedded `dist/` is being measured — still `/src/main.tsx` since 2026-10-08, now
  `apps/desktop/src/main.tsx`), the live 116 695-card corpus, 1280×800.
  The gallery path end to end: `Import deck` → paste `REFERENCE_LIST` → the box counts
  **105 lines · 117 cards** → name it and pick Commander → Preview → **117 cards · 6 categories**
  and **no problem list at all** → pick a commander → Import → the editor opens on the new deck.
  **That `6 categories` is the tally bug being measured, not the shipped behaviour**: the pile
  count was computed before the commander was chosen and never recomputed, so the same press
  today reads **7 categories** with a `Commander` row — see
  [the transfer feature's own rules](../../packages/ui/features/transfer/CLAUDE.md) for the fix and the numbers.
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
  `+` names the pile it computed. **This sentence went on to say that this "only works because
  `autoCategoryFor` reads the type line and nothing else — a rule with more inputs could not
  promise the answer before the press", and the warning in it came true**: the rule learnt to
  read Oracle tags, the button went on handing it a type line, and with the taxonomy downloaded
  it read `Add Rampant Growth to Sorcery` over a press that filed the card under Ramp (found
  2026-10-04). The button now reads the wall's tags itself (`useWallOracleTags`), names the pile
  through `autoCategoryIfKnown` — which answers `null`, and the button then names no pile, for a
  card whose tags are not in hand — and sends the press the slugs it was named from, so
  `useDeck.addCard` files by the same facts rather than reading them a second time.
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
  target row's quantity takes the sum, the moved row is deleted, and the
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
- **A swap with nothing to fold into rewrites the row in place, and that is what keeps its
  label** ([issue #643](https://github.com/Msgaihede/mtg-grimoire/issues/643), 2026-09-28). It
  was an `INSERT … ON CONFLICT` of a fresh row followed by a `DELETE` of the old one, and the
  insert named no `label_id` — so changing a card's art took the reader's label off it. An
  `UPDATE` of the printing columns (`card_id`, `set_code`, `collector_number`, `lang`, `name`,
  plus `needs_review = NULL`) keeps the row's id, label, `created_at` and `sync_uid`, and any
  column added later, with no one having to remember to copy it. It reaches a paired device as a
  field update on the same row — `deck_set_card_finish`'s shape — rather than a delete and a
  put. **The fold keeps a label too**: the surviving row's
  own label stands and an unlabelled survivor takes the moved row's
  (`label_id = coalesce(label_id, ?)`), so a label falls off only when the reader removes it or
  the card. Deck notes were never at risk: `deck_note_cards` names a card by `oracle_id`, and a
  swap never changes it.
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
  row's (`add_card`'s rule: the row that was already there is the one the reader labelled),
  except that a survivor with no label takes the moved row's (issue #643) — and
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
  **`display` (672×936)**, not `grid`; `Table` and `Text` are text and draw nothing —
  which is why the old single-row view's thumbnail, its `17rem` container query and
  `STACK_MAX_WIDTH` are gone rather than moved. **That pass predates the `Split X` toggle**
  (schema v13, 2026-08-14): the twelve stand as measured — the toggle is a modifier of one of the
  three modes and not a fourth mode.
- **The split arm was then driven live 2026-08-14** (`pnpm tauri dev`, a **debug** build,
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
  [packages/ui/features/decks/CLAUDE.md](../../packages/ui/features/decks/CLAUDE.md).
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

## The third deck kind: a deck with no cardboard behind it

`decks.virtual_only`, user schema **v40**, landed 2026-09-08 for
[issue #401](https://github.com/Msgaihede/mtg-grimoire/issues/401). A **Virtual** deck is one the
reader tracks without owning the cards for it — an MTGO or Arena list, a pile of proxies, a deck
they are reading about and have not bought. It has no integration with the collection or the
wishlist at all: nothing in it is owned, missing, pullable or shoppable, because there is no
cardboard for any of those words to be about.

The column itself, the pair it belongs to and everything it rides are in the
`decks.virtual_only` bullet above; everything here is what the kind *does*.

### It keeps one ordinary `live` list, and two SQL literals are why

This is the decision most worth reading twice, because the wrong answer is the intuitive one. A
virtual deck reads exactly like *a plan with no actual version*: the reader never meets the word
`Actual`, there is no variant switch, there is one list. So the tempting shape is to keep its rows
in `theory` and be done.

**It would report `0 cards` under an empty colour bar on every tile, for ever, with nothing going
red.** `DECK_SELECT`'s `card_count` subquery spells `dc.variant = 'live'` as a literal, and so
does `PIP_COSTS_SQL`, the gallery's colour-bar read — two separate statements, each with its own
test keeping the literal honest
(`the_gallery_count_reads_only_live_rows_in_active_categories` and
`the_colour_bar_reads_the_same_pile_the_gallery_count_does`), neither of which would have failed,
because both would have been correctly counting a list that was empty.

The near side agrees by default rather than by argument: `useDeck`, `useDeckMeta` and
`useDeckTokens` all default their `variant` parameter to `DEFAULT_VARIANT`, which is `"live"`, and
`DeckSettingsDialog` mounts `useDeck(deckId)` with no variant at all to count what its
`Empty a list` section would clear. Every one of those would have been asking the wrong list.

**So the rows stay `live` and only the vocabulary moves**, which is exactly the rule that kept
`live` as the stored word when the tab was renamed `Actual` in 2026-08-26 and again when issue
#357 swept the five surfaces still saying it a week later: the label is the reader's and the
value is the database's, and `listNames.ts`'s `listName` is the join between them. It grew one
argument for this — `listName("live", { virtual: true })` answers `deck`, not `actual list` —
and that is the whole of the change on that side.

### The isolation is a missing folder row, never a branch at each reader

A virtual deck has **no `collection_folders` row with `kind = 'deck'`**. `create_deck` skips
`create_deck_group` for one, `duplicate_deck` skips it for a virtual copy, and
`reset::clear_collection`'s rebuild skips it too (`WHERE virtual_only = 0`).

That absence is the mechanism. `deck::owned_by_printing` joins `collection_entries` to
`collection_folders` on `f.deck_id = ?1`, so with no such row the join finds nothing and **every
owned figure is `0` with no new arm anywhere** — not in `attribute_owned`, not in
`live_shortfall`, not in any of the four views. The alternative was an empty group nothing may
write to, and it lost for the reason a sentinel row always loses: it is a thing every future
reader has to be told is special, where an absence is a thing they cannot use by accident.

**2026-09-09's pool split does not reach a virtual deck, and the reason is the kinds being a
pair rather than an enum.** `deck::available_by_printing` — the wider pool a `theory` row is now
attributed from — does not join the deck's group at all, so it would answer a real number for a
deck that has none. It never gets the chance: `1/1` names no kind, so a virtual deck's
`theory_enabled` is `0`, and `deck_kind` clears it in the same patch that sets `virtual_only`.
Rows already in `theory` survive that patch and `last_variant` may still say `theory`, but the
editor asks for `live` on a deck that keeps no plan, so `deck_get(id, "theory")` is never sent
for one. **A virtual deck's rows are `live` rows** — the same sentence that keeps `card_count`
and the colour bar honest — and `live` rows are attributed from the group that is not there.

**The same absence is what makes the bulk removals work unchanged.**
`deck::release_group_copies`' first rule is that a deck with no group holds nothing and answers
`moved: 0` rather than refusing — so `deck_clear`, `deck_category_clear`, the category cascade and
`import::commit_import`'s `replace` arm all walk an empty set on a virtual deck and clear a list
that never held a copy. None of them grew a fence, and none needed one.

### The two transitions, and why only one of them touches cardboard

`update_deck` carries them, both inside the patch's own transaction:

- **Becoming virtual releases the deck's copies and drops the group.**
  `release_unclaimed_copies` first, then `release_live_copies`, and **the order is the rule
  rather than a preference**: the first releases what the group holds *over* what the live list
  claims, the second releases the claim itself, and running them the other way round computes the
  surplus against a group the second call has already emptied — leaving a group holding more
  copies than its list names, exactly where it was. Between them they are total, which is what
  the `DELETE FROM collection_folders` below them needs: `collection_entries.folder_id` is
  `ON DELETE SET NULL`, so a row left behind is scattered to the **root** rather than to
  `Recently removed` — the wrong destination, a rewrite of `COLLECTION_GRAIN`'s eleventh term,
  and a `UNIQUE constraint failed` the moment the root already holds that grain. `delete_deck`
  reaches the same place from the other side and re-files by hand because it is taking a whole
  sub-tree; a deck's group has no children and this deck is not going anywhere, so the two shared
  helpers are the whole of it.
- **Ceasing to be virtual makes the group again, empty — and fetches nothing back.** The copies
  are in `Recently removed` where the reader can see them, and a re-fetch would have to decide
  which rows in a shared holding area had come from this deck, which nothing records. The group
  is named with the name the deck is called *after* this patch, the rename above having already
  run in the same transaction: a group made with the old name would be a drawer labelled with a
  name the gallery stopped using one statement earlier.

The two arms are exclusive by construction, and neither can share a press with the theory move
above them: `deck_kind` forces the resolved theory half to `Some(false)` on the way in to virtual,
and `before.virtual_only` is true on the way out, so `will_move`'s `!before.theory_enabled` is the
only other thing that could have been true — and a virtual deck's theory switch is already off.

### Nine refusals, in words rather than in zeroes

Every entry point that touches the collection or the wishlist on a deck's behalf refuses a virtual
deck by name. One sentence, `deck::VIRTUAL_HOLDS_NOTHING` — *"A virtual deck keeps no cardboard,
so it has nothing to compare with your collection."* — named on the crate rather than per call
site, because a sentence spelled six times is a sentence that will be spelled six ways.

| Module | Where |
| --- | --- |
| `collection_alloc` | `collection_to_deck`, `deck_to_collection` |
| `deck_missing` | `plan`, `to_collection` |
| `deck_pull` | `plan`, `from_collection` |
| `deck_quick_add` | `quick_add` |
| `deck_theory` | `missing_to_wishlist` |
| `deck` | `missing_to_wishlist` |

**In words rather than by answering zero, and that was the tempting one.**
`owned_by_printing` already answers 0 for a deck with no group, so a *"0 owned, all missing"*
readout is what a virtual deck would silently produce — and that is precisely the wrong answer,
because it tells the reader they are short of a hundred cards they never meant to buy. The
refusal is what turns that into a sentence.

Two of the nine are **reads**, and the argument for refusing there is one step further along.
`deck_missing::plan` and `deck_pull::plan` both answer an empty vector in the ordinary course —
a deck short of nothing is zero rows and is not a failure — so a virtual deck could have been
handed that same emptiness. It is the *dishonest* one here, because those zero rows already
**mean** something: `deck_missing::plan`'s doc words its dialog's reading of them as a cheerful
*All owned.*, and `deck_pull::plan`'s as *there is nothing in your collection this deck needs* —
over a deck that owns nothing by definition, which is a reader being told they have finished
collecting a deck that was never about collecting. The two reads refuse together or the two
dialogs disagree about what a deck is.

`deck::missing_to_wishlist` is the press that would otherwise have succeeded *loudly* and wrongly:
`live_shortfall` reads what the deck plays against what its group holds, a virtual deck has no
group, so every card comes back missing and one button would put the entire decklist on the
reader's shopping list.

**One of the nine was reachable from a press the near side had not been taught about, and the
near side is where it was fixed** (found 2026-09-08 by reading, not by driving; fixed the same
day). `deck_to_collection` is not only the Collection tab's cut — it is the command
`useDeck.setQuantity` sends for **any** decrease on a `live` list, which is every removal in the
editor: the stepper's zero, the card menu's `Remove card` and the remove tray all reach it through
`DeckEditor`'s one `setQuantityAt`. A virtual deck's rows are `live` rows, so all three of that
route's conditions held, and the refusal landed where a card should have been removed.

**The fix is a fourth condition on that route and nothing here**, which is the half worth carrying
back to this side: the absolute write, `deck_set_card_quantity`, is the right command for a deck
with no group and is already what the same hook falls back to for a theory row, so the refusal
below stays exactly as strict. What it says about these nine fences is that a refusal is a
*backstop* rather than a design — a command that can only ever answer in words is one the near
side should not be calling — and this is the one of the nine whose caller was a write rather than
a readout, which is why a sweep for owned figures could not have found it. Full note:
[`packages/ui/features/decks/CLAUDE.md`](../../packages/ui/features/decks/CLAUDE.md)'s **Known open bugs**, which
keeps the account rather than the entry.

### Where each fence sits, and why the order is the rule

- **A write puts it behind `touch_deck`.** "That deck is gone" and "that deck holds no cardboard"
  are different things to be told, and a stale editor's dead deck id must still hear
  `deck::GONE`. The stamp the fence then lets through rolls back with the transaction, so nothing
  is paid for it. `collection_to_deck`, `deck_missing::to_collection`, `deck_pull::from_collection`
  and `deck_quick_add::quick_add` are all this shape, and each of the last three calls the fence a
  *rider* on the stamp rather than a numbered step of its own: the numbered steps are the press,
  and this asks whether the press applies to this deck at all.
- **Ahead of the group, the pile and the re-plan.** In all four the refusal names the *deck*
  rather than the folder it does not have, and in `deck_quick_add` it is specifically ahead of
  `plays_card`, which **cannot stand in for it**: a virtual deck's live list plays its cards
  perfectly well, and what it has none of is copies.
- **A read puts it first**, ahead of the shortfall walk — and `deck::is_virtual` answering
  `false` for a deck that is not there is what makes that safe. A dead id falls straight through
  to `live_shortfall` and hears `GONE` from it, so the two sentences stay distinct with no
  existence check of the read's own.
- **`deck_to_collection` asks the deck's kind before the row's variant**, which is the same order
  `collection_to_deck` asks them in, and it is the whole reason the two refusals cannot be heard
  the wrong way round. This command is pointed at a `deck_cards` row rather than at a deck, so the
  deck id comes off the row and this is the first statement at which the question can be asked at
  all; `DECK_CARD_GONE` still answers a stale editor first.
- **`deck::missing_to_wishlist` puts it before the transaction opens**, `update_deck`'s rule for
  its validations: there is nothing to roll back and no reason to have taken a write lock to find
  out. **The folder fence both commands took on 2026-09-09 goes inside the transaction instead,
  and that is not the same rule broken**: `is_virtual` reads a fact about the deck this press is
  about and has nothing to roll back, where `require_folder` reads a `wishlist_folders` row the
  loop below is about to write against and has to see what that write will see. It still runs
  before the shortfall is walked — a check that rode along with the write would answer `0 wishes`
  for a deleted drawer on a deck that is short of nothing. In `deck_theory::missing_to_wishlist`,
  where all three fences sit inside one transaction, it goes **third**: "that deck is gone", "that
  deck keeps no cardboard" and "that folder is not there any more" are three different mistakes,
  and the folder must not be able to answer for either of the other two.

**`is_virtual` answers the fact and never the conclusion**, which is this crate's own boundary and
the reason it is a `bool` rather than a `Result<(), String>` that refuses on the caller's behalf.
Every one of the nine is a *different* refusal, and a helper that raised could not then be asked
the question for any other purpose. `deck_group` is the neighbour that makes the same choice for
the same reason.

### What has no fence, and each absence is argued

- **`deck_quick_add_wishes` takes no deck id at all.** It is a pure read of `wishlist_entries`
  for a printing and a finish, so a fence would mean inventing a parameter for the sole purpose
  of refusing on it. What keeps it off a virtual deck is the caller — the menu row leading there
  is not offered on one — and the write it leads *to* refuses on its own account. The comment
  where the fence would be is deliberate: this is where a reader looks for the missing one.
- **`deck_theory::theory_slots` and `theory_diff` get none.** They are the plan-versus-live
  comparison, and a virtual deck's `theory_enabled` is `0` by construction, so they are already
  unreachable for one; a fence there would be a rule kept in step for a case that cannot arise.
  `missing_to_wishlist` is that module's one write that leaves it, which is what makes it that
  module's one refusal.
- **`import::commit_import` gets none**, and importing a decklist into a virtual deck is a
  perfectly good act: it writes `deck_cards` and nothing else. Its `replace` arm's release walks
  an empty set, as above.
- **The three bulk clears get none**, for the same reason.

### The near side, in one paragraph

`packages/ui/features/decks/deckKind.ts` is the one place the pair is folded into a word — `DeckKind`,
`deckKind`, `deckKindPatch`, `tracksCollection` — and `packages/ui/features/decks/CLAUDE.md` carries the
rules that bind it, including the trap this whole feature turns on: **`variant === "live"` no
longer answers whether a deck reads the collection.** Ten or so surfaces used to ask it that way,
and a virtual deck's rows are `live` rows on purpose, so every one of them needed a second fact
about the *deck*.

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
- **The exact printing and the exact finish — and since 2026-09-07 that is also the grain
  owned/missing counts at, not a narrower one.** Through 2026-09-06, owned/missing was attributed
  at the **oracle** grain — `owned_by_oracle`, "a Bolt is a Bolt" — so an Alpha Bolt filed in the
  group made an M10 line read as owned while the pull, matching exactly, could offer nothing for
  it: a deck could read *N missing* with a dialog that honestly had no candidates for any of it.
  `owned_by_printing` closed that by narrowing the **count** to `(card_id, finish)` — the same
  pair `CANDIDATE_SQL` matches on — rather than by widening the
  pull, so the two no longer disagree about what "owned" means. What survives unchanged is the one
  sentence that was never about the grain: nothing is ever moved that is not the exact piece of
  cardboard the list names, so an Alpha Bolt in the binder is never handed to an M10 line instead.
  **A reader who wants the substitution still has it**: the Collection Search tab files any copy
  into any deck, one press at a time. The exactness itself is a decision (2026-09-03, the reader's
  own call) and not an oversight — it is pinned on both sides so that changing it later is
  deliberate.

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

## The quick add: recording cardboard nobody had written down

`deck_quick_add.rs`, [issue #350](https://github.com/Msgaihede/mtg-grimoire/issues/350), landed
2026-09-03. **The fourth crossing of the deck boundary, and the first that _creates_ copies rather
than moving them.** The deck lists four Bolts, its group holds none, and the reader has come home
from the shop with four. The pull above cannot help — there is nothing in any folder to move — and
the long way round is an add on the collection page followed by a file into the deck's group,
which is two surfaces and a folder picker for a number the deck card is already wearing.

```text
         collection_to_deck                 deck_to_collection
binder / another deck ─────────▶ deck group ─────────────────▶ Recently removed
                                     ▲   ▲
        deck_pull_from_collection ───┘   └─── deck_quick_add_to_collection
        (moves cardboard that exists)         (records cardboard that did not)
```

### Creating rather than moving is the whole of what is new, and three things follow

**The invalidation is the wide one.** The other three arrows only move a row between folders, so
the total the reader owns cannot have changed, and `useDeck`'s `invalidateCollection` — the
`["collection"]` root alone — is as precise as their answers allow. This one moves a
`CardSummary.ownedQuantity` from 0 to 4 on the very tile the press was made on, so it fires
`query.ts`'s `OWNED_WRITE_KEYS` instead: the collection, the wishlist's owned progress,
`["cards", "search"]` and `["decks"]`. `useDeck.ts` had exactly one write of this class before —
the `own` add deleted on 2026-08-25 — and the comment left standing where its invalidation used to
be says why the narrow root is not enough. This is that case coming back, and the constant was
kept shared with the import's owned half for exactly this.

**It takes `collection_source::with_write_owned`, not `sync::lock_db_read`,** for the reason one
level down: a `collection_entries` row is created, and the facet index's `owned` dimension counts
rows.

**And `NOT_IN_DECK` is doing real work here rather than being copied across.** Issue #358's
invariant is *every copy in a deck's group is backed by a row in that deck's list*, and a write
that can conjure a placement out of nothing is precisely the write that could break it. The fence
is the one `collection_to_deck` grew — `deck::plays_card`, `PLAYED_KEY`'s
`coalesce(c.oracle_id, dc.card_id)`, the **live** list only — reused rather than respelled.

### Two commands, and the read is the smaller half this time

`deck_quick_add_wishes` answers every wishlist line for this printing's card (since
[issue #511](https://github.com/Msgaihede/mtg-grimoire/issues/511) — see the next section);
`deck_quick_add_to_collection` records the copies and, when the reader named one, takes them off
that line. The split is the pull's and for the pull's reason — a prompt needs its options named
before anything is written — but it is a narrower read: there is no plan to compute, because how
many copies to record is a fact the row the reader right-clicked is already showing.

The read is one statement over `wishlist_entries LEFT JOIN wishlist_folders`, ordered root first,
then the reader's own folders in their `sort_order`, oldest row first inside a tie. That is
`deck_pull::PullCandidate`'s order borrowed rather than re-decided, and it is borrowed with its
argument: rank by how little of the reader's own filing the write disturbs. The per-card read puts
two terms in front of it — the pressed printing first, then a finish the copies satisfy — so the
pre-pick is the line the narrow read would have chosen. It is a pre-pick and nothing more: every
match reaches the picker.

**Nothing is fetched on a right-click.** The wishes are read imperatively at the press, so the
menu costs no round trip on a surface a reader opens constantly, and the key —
`["wishlist", "forPrinting", cardId, finish ?? ""]` — is spelled once in `useDeck.ts` so that
fetch and any observer of it cannot disagree about what they are sharing. **It names no deck**,
because a wish does not: which deck the press came from decides where the *copies* are filed and
says nothing about which shopping lines could be cleared.

### Two wish predicates: the card for the picker, the printing for the batch

**The per-card press reads every wish for the card and always asks** (2026-09-24,
[issue #511](https://github.com/Msgaihede/mtg-grimoire/issues/511)). `deck_quick_add::card_wishes`
matches `w.card_id = ?1` or the wish's `oracle_id` equal to the pressed printing's, so another
printing, another finish and an any-printing wish are all offered; `chooseWish` opens
`QuickUnwishDialog` for **one or more** of them, and each row shows its picture, printing, finish
and folder. The write's re-check (`take_wish`) was widened to match: a named wish must be for the
same *card* and nothing else. The reason is the reader's report: the narrow read hid the line they
meant — a wish for another art, or one filed in a folder — and a lone match was cleared without
their seeing which line it was. Whether M10 copies settle a wish for the Alpha printing is the
reader's call, so the picker offers it and they make it.

**The deck-wide batch keeps the narrow predicate below**, through `deck_quick_add::wishes`,
because `deck_missing` clears a lone match *without asking*, and a guess is only safe where the
wish names exactly the cardboard recorded. Everything in the rest of this section is about that
narrow read.

```sql
w.card_id = ?1 AND (w.preferred_finish IS NULL OR w.preferred_finish = ?2)
```

"Which wishes could these copies take down" has two arms: a printing-exact one, and an
any-printing one that would match `w.card_id IS NULL` through `cards.oracle_id`. The narrow read
takes the first and drops the second. Two consequences, both decisions taken on 2026-09-03 and
neither an oversight:

**It was written as `wishlist::OWNED_SQL`'s first arm and that constant is gone** (2026-09-08).
`OWNED_SQL` summed how much of a wish the collection already held, which is a question the wishlist
stopped asking when it stopped comparing itself to the collection at all; the predicate below is
now this module's own and is the only place the shape is written.

- **The narrowing is on the printing, and it is the pull's narrowing exactly.** A wish for *any*
  printing of the card is left standing after a quick add, the same way the pull leaves an Alpha
  Bolt out of an M10 line — and for the same trade: nothing is ever struck off a shopping list
  that is not the piece of cardboard the reader has just written down. Such a wish is simply left
  on the list for the reader to cross off, which is what a wishlist is since 2026-09-08 — there is
  no owned-progress figure on it any more for the second arm to have moved.
- **A NULL `preferred_finish` matches, and excluding it was never available.** The list itself
  says a wish that names no finish takes any of them, and that is the commonest wish there is.

The finish that goes in is the **deck row's**, through `deck::normalise_finish`, so `NULL` and
`"nonfoil"` are one regular copy on both sides of the boundary: `deck_cards` stores `NULL` for
regular and `collection_entries` stores the word, which is why the collection half is
`normalise_finish(..)?.unwrap_or("nonfoil")` and not the deck value passed through.

### The order of the write is the rule

`collection_to_deck`'s discipline, one transaction, and every step is *placed* rather than merely
present:

1. **Zero copies are refused** — `collection::ZERO_ADD`, widened rather than respelled. Adding
   zero is a no-op dressed as a write, and would conjure a row on a card nobody said they had.
2. **`touch_deck` first**, so a stale editor holding a deleted deck's id hears `deck::GONE`.
   *That deck is gone* and *that deck does not play this card* are different things to tell a
   reader, and the order is the only thing that decides which one arrives.
3. **`plays_card`, else `collection_alloc::NOT_IN_DECK`.** It reads the live list only, so a card
   the deck merely *plans* is refused here with no theory fence of its own. The sentence is
   `NOT_IN_DECK` rather than `THEORY_HOLDS_NOTHING`, which is narrower than the whole truth and
   still the true answer to what was asked: this deck's live list does not play this card.
4. **`deck_group`, else `collection_alloc::NO_DECK_GROUP`.**
5. **`collection::add_entry_filed(&tx, &input, collection::DECK_WRITE_FOLDERS)`.** The grain fold
   is that function's, so a second quick add on the same line raises the row already in the group
   instead of making a second one — schema v24's folder term is what makes that a fold rather than
   a move. **Every `EntryInput` field but the five this press knows is at its empty value**
   (`..Default::default()`, so a column added later needs no line here): a menu row records
   *copies*, and a purchase price or an acquisition source it invented would be provenance nobody
   entered. The condition is `MENU_CONDITION` — TypeScript's, `"NM"`, the same constant every
   other menu add records at, imported rather than respelled so the two cannot drift.
6. **The wish, re-read inside the transaction.** The dialog's answer is a round trip old, which is
   the pull's discipline: gone → `WISH_GONE`, a wish for another card → `WISH_WRONG_CARD`. Since
   issue #511 printing and finish are not re-checked — the picker offered every line for the card
   and the reader chose one. Then `take = min(copies, wish.quantity)`, deleting the row at zero and
   decrementing it otherwise.

**A refusal at step 6 rolls the copies back with it**, and that is the answer the press deserves
rather than a partial success: the reader asked for both halves, so they get both or neither. It
is the same shape as `Cancel` on the picker, which likewise does not quietly perform the add on
its own.

Two new sentences, each a sentence and never a constraint failure — `deck::set_folder`'s rule:

| Constant | Sentence |
| --- | --- |
| `WISH_GONE` | That wishlist line is not there any more. |
| `WISH_WRONG_CARD` | That wishlist line is not for this card. |

### The history row is the fourth reuse of `move`, and `AUDIT_KINDS` still stays at nine

One row per press: `kind = 'move'`, no `card_id`, `delta = 0`, payload
`{"quickAdd": {"copies": N, "wishes": M}}`, read by `auditText.ts` **before** the per-card
branches and beside the pull's — because the `move` arm would otherwise render it as "Moved a
card", a sentence about a card the row has not got. **`M` is copies off the wish and not a count
of wish rows**, of which there is at most one: `quick_add` takes a single `wish_id`, because a
press that cleared three shopping-list lines at once is a write nobody could review before making
it.

**Which is why the drawer reads `Recorded 4 copies for this deck` over `4 copies off your
wishlist`, and says `copies` twice on purpose.** `auditText.ts` rendered that detail as
`4 wishes cleared` for the length of one fan-out — a sentence sending the reader to look for three
shopping lines that were never there, because a wish for four copies is one line. The two numbers
are genuinely different facts and can differ (a four-copy press against a wish for one records
`{"copies": 4, "wishes": 1}`), so the repetition is what tells them apart rather than clumsiness.
`counts wishlist copies rather than wishlist lines` is the pin, and it asserts the **absence** of
the word `wishes` — the count alone reads correctly under either spelling, and only the noun was
ever wrong.

**A tenth `AUDIT_KINDS` word was no more available here than it was to the pull**, and for
`schema.rs`'s reason: SQLite has no `ALTER … CHECK`, so widening `deck_audit.kind` means
rebuilding every reader's whole deck history for a spelling. `commit_import` met it first,
`deck_undo` second, `deck_pull` third; this is the fourth time and the fourth reuse.

**`delta` is 0 and honest.** The deck asked for four copies before the press and asks for four
after it; the list gained nothing and what backs it did.

### And there is no undo step, for a sharper reason than the pull's

The pull files none because `take_copies` moves copies *through the merge* and a source row may
no longer exist to restore. This one files none because there is nothing an undo step could
express: `deck_undo` restores rows of `deck_cards` and touches no collection table at all, and
this write changes **no** `deck_cards` row. A step carrying nothing is not a step. The way back is
the collection editor, where the copies are a row the reader can see in a folder named after the
deck.

### The count is the row's, and one card in two piles costs two presses

The number the menu names is `max(0, quantity − ownedQuantity)` for the row that was
right-clicked — exactly the `3/4` `CardStack.tsx` is drawing on that card, so the menu never
quotes a number the card is not already wearing. **That is deliberately not the fold the pull
uses.** `deck_pull_plan` folds a shortfall to `(card_id, finish)` and never to the pile, because
what a reader is short of is cardboard and custody is a fact about the deck rather than about a
column. A menu row cannot do that: it is a label on the card a reader is pointing at, and a number
gathered from a second pile they cannot see would offer to record copies for a row that is not on
screen.

So a deck listing two Bolts in `Removal` and two more in `Burn`, owning none, offers `Quick add 2
copies` on each — two presses, where the second folds into the row the first created because
`add_entry_filed` folds on the grain. Whether that is worth a folded variant of the row is a
question for a live pass and not for this page.

**Nothing in this section has been measured in the shipped window.** The pull's own live pass is
the model for the one this owes: the two-press case above, a wish picker with several folders, and
what the editor's banner says when the wish read fails.

## Adding the missing: the deck-wide form of the quick add

`deck_missing.rs`, landed 2026-09-08 from a conversation rather than an issue, and the third
answer the stats band gives to one number. The press reads **`Add missing to collection`** and
sits between `Pull from collection` and `Send missing to wishlist`, which is the row read as own
it loose → just bought it → still have to buy it.

**What it is for is the case the other two cannot answer**: the reader has the cardboard in their
hand. The pull moves copies that are already in the database somewhere; the wishlist writes down
what to go and buy. This creates rows for copies that exist on the desk and have never been
recorded, filed straight into the deck that wanted them — which is exactly
[the quick add](#the-quick-add-recording-cardboard-nobody-had-written-down)'s job, done for the
whole list at once and with the preview a menu row has no room for.

### One shortfall walk, three callers

`deck::live_shortfall` is the walk `deck_pull::plan` and `deck::missing_to_wishlist` each spelled
separately until this feature would have spelled it a third time. It reads the **live** list
through `get_deck`, skips an inactive pile, computes `quantity − owned_quantity` and folds at
`(card_id, finish)` in the deck's own read order. Each caller folds its own answer on top: the
pull hangs candidates off the pair, this one hangs wishes off it, and the wishlist folds on again
to `oracle_id` and drops the rows that have none.

**Folding twice gives the same answer as folding once**, which is what makes the wishlist's second
fold safe: `oracle_id` is a property of the `cards` row, so every `(card_id, finish)` bucket of one
printing carries the same one, and summing per pair then per oracle id is the same sum. The
`BTreeMap` there sorts by key whatever order rows arrive in, so `add_wish` is still called in
oracle-id order and the count it answers is unchanged. The extraction was required to be
behaviour-preserving, and both modules' existing tests were the fence.

### The plan drops an orphan, and that is the write's own precondition

`deck_missing::plan` leaves out a printing whose `card_id` has no `cards` row — not as a policy,
but because `collection::add_entry_filed` reads `set_code`, `collector_number` and `lang` off that
row through `printing_of` and refuses without it. A row the write must refuse is a row the dialog
could only draw as an apology, so it never reaches the dialog. That is
[the pull](#the-pull-filling-a-hole-the-list-already-has)'s rule about an empty candidate list,
applied to a different reason for the same emptiness.

**It is a narrower test than `missing_to_wishlist`'s, and the two are not each other's typo.** That
command skips `oracle_id.is_none()`, because a wish needs an oracle id; a `cards` row can exist
with a NULL `oracle_id`, and a collection entry records it perfectly well.
`a_printing_with_no_oracle_id_is_kept` is the test that holds the two apart.

### The pick is addressed by `(card_id, finish)`, because the row does not exist yet

That is the structural difference from `deck_pull::Pick`, which names a `collection_entries.id`.
Everything else about the write is the pull's discipline: it re-plans **inside** the transaction,
checks every pick against that re-plan before writing anything, and refuses the whole batch on any
disagreement. Duplicate picks for one key are **summed and then checked**, so two picks of 3
against a shortfall of 4 are one refusal rather than two accepted writes.

Five sentences, two of them borrowed from `deck_pull` rather than respelled:

| Refusal | When |
| --- | --- |
| `NOTHING_PICKED` | an empty batch, refused before the transaction opens |
| `collection::ZERO_ADD` | a pick of zero or fewer |
| `deck_pull::NOT_SHORT_OF_THAT` | the card is in `cards`, and the deck is not short of that pair |
| `deck_pull::MORE_THAN_MISSING` | the picks for one row sum past its shortfall |
| `LEFT_THE_DATABASE` | the printing left `cards` between the read and the press |

The last two are told apart on purpose: "the deck does not want them" and "the card is gone" are
different things for a stale dialog to hear, and one sentence covering both tells it nothing it
can act on.

**All-or-nothing, and no undo step**, for the quick add's reason sharpened: this write changes no
`deck_cards` row at all, so the only half of it `deck_undo` could express is the half that does not
exist. The way back is the collection editor — the copies are a row the reader can see, in a folder
named after the deck.

### The wish half acts only on an unambiguous match

`quick_add` takes one `wish_id` and can therefore be stale about it, which is what `WISH_GONE` and
`WISH_WRONG_CARD` are for. A batch over thirty rows cannot ask thirty questions, so this one
**chooses inside the transaction** instead: `take_lone_wish` re-runs `deck_quick_add::wishes` — the
same predicate the per-card menu offers by, not a second opinion — and acts only when exactly one
line matches. None, or two or more, is left standing.

Two consequences worth stating:

- **No wish id rides on the wire**, so `MissingPick` carries only a printing, a finish and a count.
- **There is no stale-wish refusal.** A line that vanished under an open dialog is simply not among
  the matches, and the press carries on. The reader is told what happened by `wishCopies` in the
  outcome rather than by an error — and the dialog said beside each row, before the press, which
  rows would clear a wish and which had two matches and would be left alone.

The reader can switch the whole half off with the footer's `Also take these off my wishlist`, which
is on by default.

### One history row for the press, and `AUDIT_KINDS` still stays at nine

The fifth reuse of `move` with a payload key nothing else writes:
`{"quickAdd": {"copies": N, "wishes": M}}`, `card` NULL, `delta` 0 — byte for byte the quick add's
shape with the batch's totals, so `auditText.ts`'s `quickAddLine` renders it as *"Recorded N copies
for this deck"* with *"M copies off your wishlist"* under it and **needed no change at all**.

**One row, not one per printing**, because the reader did one thing. `delta` is 0 and honest: the
*list* gained nothing, since a 4-copy line the reader was 3 short of is still a 4-copy line.

`deck_missing_to_collection` is **not** in `every_deck_write_leaves_exactly_one_audit_row`'s case
list, which matches the two crossings that landed before it; see the note on that sweep above for
why that omission is a known one rather than a fresh miss. Its own row is pinned by
`a_partial_pick_records_what_it_named_and_leaves_the_rest_short`.

### What TypeScript decides

`addMissingPlan.ts` holds the reader's **departures** from a full record and nothing else — rows
switched off, and counts lowered — which is `pullPlan.ts`'s discipline with one difference worth
naming: the pull's departure is a *source*, because the copies exist and sit somewhere; this one's
is a *count*, because they do not exist yet and the reader may have bought two of the four.

**The clamp is the part that earns the file.** A stored count is clamped against the row's current
`short` on every derivation, so a re-read that lowered a shortfall cannot leave the footer
previewing a press the backend would refuse with `MORE_THAN_MISSING`.

`AddMissingToCollectionDialog` holds no query and no mutation — rows and a narrowed write arrive as
props, so every one of its tests mounts it with no provider of any kind. `useDeck`'s mutation fires
`query.ts`'s `OWNED_WRITE_KEYS` rather than the `["collection"]` root the movers share, for the
quick add's reason: this write **creates** rows, so `ownedQuantity` moves from 0 to N and a 30 s
`staleTime` would otherwise keep saying the old number for half a minute. `["wishlist"]` in that
set is load-bearing here rather than incidental, because the write can delete a wish outright.

### The live pass, 2026-09-08 (debug build, Windows, 1920×1080)

Driven over CDP against a copy of the real database. The scenario was built on an empty scratch
deck so nothing real was written: **Chimil, the Inner Sun** short 4 with one wish for 2 at the
root, **Firemane Commando** short 3 with two wishes (root and `Backordered`), **The One Ring**
foil short 2 with none. The band read `9 of 9 missing`.

**The band.** All three presses on one row at 1920 wide — identical `top`, and their class lists
byte-identical as a set. At the app's **1024** floor they still fit on one row, rightmost edge at
**796** of a 1024 client width, and `scrollWidth` never exceeded `clientWidth`. The `flex-wrap` is
therefore insurance rather than something the third button spends.

**The dialog opened** with every row ticked and steppers at `4 / 3 / 2`, each `min=1` and
`max=short`. The three wish shapes drew as designed: `Clears 2 copies off a wish in Wishlist` on
Chimil (the wish holds 2, so `min(4, 2)`), `2 wishlist lines match — left alone` on Firemane, and
nothing at all on The One Ring.

**The arithmetic tracks the controls.** Footer `9 copies across 3 cards · 2 copies off your
wishlist`; untick The One Ring → `7 copies across 2 cards` and the press relabels to
`Add 7 copies to collection`; step Chimil 4 → 1 → `4 copies across 2 cards · 1 copy off your
wishlist`, and its row line becomes `Clears 1 copy off a wish in Wishlist` — the clamp and the
singular both, on one gesture.

**The press was deliberately partial** — 1 of Chimil's 4 and all 3 of Firemane's, with The One
Ring switched off — because that is the shape that can go wrong silently. It answered
*"Recorded 4 copies of 2 cards into Test Deck. 1 copy off your wishlist."* and the database agreed
with every clause of it:

| Claim | After |
| --- | --- |
| Chimil recorded 1 | `ownedQuantity` 0 → 1, plan `short` 4 → 3 |
| Firemane recorded 3 | `ownedQuantity` 0 → 3, row gone from the plan |
| The One Ring untouched | `ownedQuantity` 0, `short` still 2 |
| the lone wish decremented | Chimil's wish 2 → 1 |
| **the ambiguous pair left standing** | both Firemane wishes still 1, after a 3-copy press |
| one history row for the press | `move`, `card` NULL, `{"quickAdd":{"copies":4,"wishes":1}}`, `delta` 0 |

`ownedQuantity` is the proof the copies landed in the deck's **own** group rather than at the
root, because `owned_by_printing` counts only rows filed there. The band re-read `5 of 9 missing`
— down by exactly the four recorded — and the drawer worded the row *"Recorded 4 copies for this
deck / 1 copy off your wishlist"* with **no change to `auditText.ts`**, which is the reuse of
`move` paying off rather than merely being asserted in a test.

Escape closed the dialog and returned the caret to the button that opened it.

**One behaviour worth writing down because it surprises on first sight and is correct**: a
successful press leaves the dialog **open**, and it re-plans. The reader's departures survive that
refetch — a row they had unticked stays unticked, a count they lowered stays lowered — so the
footer immediately after the press above read `1 copy across 1 card`, which is Chimil's *new*
shortfall of 3 still carrying the reader's stepper of 1, with The One Ring still switched off.
That is `MissingChoice` holding only departures working exactly as designed, and it is the pull's
behaviour too. Nothing about it is a bug; it is only unintuitive if you expect the dialog to reset.

**No defects found.** That is worth stating plainly rather than leaving as silence, because every
other UI task in this repo's plans found something the suite could not.

## The gallery's two second reads, and the order it opens in (2026-09-07, issue #387)

The deck wall wanted two facts `deck_list` has never answered — **what colours a deck is** and
**what bracket it reads as** — and the only card-shaped read in the feature was `deck_get`, which
is the heaviest read here and is per deck. Forty tiles is forty of those. So two reads were added
that answer the *whole gallery* in one round trip each, plus one `app_meta` row for the order.
The plan is `docs/superpowers/plans/2026-09-07-deck-gallery-overview.md`; what the bar and the
caption *look* like is [frontend-design.md](frontend-design.md), and what the estimate is allowed
to conclude is [commander-brackets.md](commander-brackets.md).

**All three figures below were taken on the dev database under `tauri dev` (a _debug_ build),
2026-09-07: 4 decks, 611 `deck_cards` rows.** They are shape figures rather than timings — what
crosses the wire for a gallery — and a reader's own database will differ by however much bigger
it is.

### `deck_pip_costs` — the colour bar's facts, and no parameters at all

```
PipCost      { cost: string; copies: number }
DeckPipCosts { deckId: number; costs: PipCost[] }
```

**Every deck at once, and the read takes no arguments on purpose.** The gallery draws every deck
it has, an archived one included behind the disclosure, and an archived deck's bar is the same
fact as any other's — so there is nothing to narrow by and a per-deck read would be one query per
tile on a page that is already one query. Measured: **90 rows** for the whole gallery, against
611 `deck_cards` rows. That ratio is the entire argument for the read's existence, and it is what
folding by cost string buys — a deck plays a handful of distinct costs and forty-odd cards at
them.

**`PIP_COSTS_SQL`'s `WHERE` clause is `DeckRow.card_count`'s, copied from `DECK_SELECT`'s
correlated subquery rather than re-derived**: `variant = 'live'`, `cat.is_active = 1`, and
`cat.kind IN ('main','commander','maybe')` — `SIZE_KINDS`, the three-place rule this page states
further up. The bar is drawn under a caption that already says how many cards the deck has, so a
bar counting a different pile than that number counts is **a tile disagreeing with itself**.
`the_colour_bar_reads_the_same_pile_the_gallery_count_does` is what keeps the two literals
honest, and it is written as a theory row, a switched-off category, a `side` pile and a
`companion` pile each colouring nothing in turn.

Three narrowings are worth naming because each is a decision rather than a filter:

- **The `cards` join is _inner_, and it is the only inner join among this file's reads apart from
  `deck_categories`.** Everywhere else a `LEFT JOIN cards` is discipline — an orphaned row is a
  card the reader still owns and must still see. Here it would buy a NULL cost, which the next
  two predicates drop anyway: `deck_cards` denormalizes the printing and the name, **never the
  mana cost**, so a row whose printing has left `cards` has no *printed* cost to contribute and
  nothing this read could invent for it.
- **A NULL or empty cost is dropped rather than shipped.** Every land is one and a Commander deck
  is a third lands, so shipping them would be ~35 rows per deck carrying no pip, for a bar that
  would draw exactly the same.
- **A deck with nothing to say is _absent_ from the answer rather than present and empty.** A
  pile of basics, a deck whose every row has been orphaned, and a deck with no cards at all all
  answer no entry — which is what a `GROUP BY` gives, and what the reading side is written for:
  a deck it cannot find is a deck with no pips, and draws no bar.

**Rust ships the cost strings and TypeScript counts the pips**, which is this crate's
facts/conclusions boundary applied to a colour bar. What a `{W/U}` is worth to a bar is a display
decision — it counts as one pip of *each* half, because the bar answers *what does this deck
want* rather than what will be spent — and it is decided in `packages/ui/lib/mana.ts`'s `addPips`, over
the one `{…}` `SYMBOL` tokeniser this app already has. `cost` is `cards.mana_cost` verbatim,
including the one-string form a split or double-faced card carries (`"{3}{U} // {3}{R}"`), and
`copies` is `sum(quantity)` and not a row count, so four Lightning Bolts across two printings are
one entry reading four.

The statement's `ORDER BY dc.deck_id, c.mana_cost` is the grouping's and not a contract about
presentation: rows arrive deck by deck so the fold in `pip_costs` is a single pass with no
`HashMap`, and by cost within a deck so two runs over one database cannot answer in two different
orders. What order the *segments* are drawn in is `MANA_KEYS`', on the other side of the wire.

### `deck_bracket_reads` — the estimate's facts, over a different pile on purpose

```
BracketCardRow  { name; gameChanger; oracleText; faces; categoryActive }
DeckBracketRead { deckId: number; cards: BracketCardRow[]; combos: DeckCombo[] }
```

Measured: **397 distinct cards across 4 decks, 59 KB of oracle text**, for one gallery.

**The pile is `variant = 'live'` and `cat.is_active = 1` in _every_ kind, and that is deliberately
not the pip read's three.** A Commander deck has no sideboard, so a reader who has filed cards
there has filed them somewhere the estimate still has to see — and this is the pile
`DeckBracket.tsx` hands the estimator today. Two reads of one deck answering two different piles
is the disagreement worth avoiding: the gallery and the editor have to reach the same bracket for
the same deck.

- **`SELECT DISTINCT`, because the estimator dedupes by name anyway.** A card in two piles, or a
  foil row beside a regular one, is two `deck_cards` rows saying one thing about a bracket — and
  this read ships oracle text for every deck on the page at once. The `ORDER BY` names all four
  selected columns rather than the name alone, so two runs over one database cannot answer in two
  different orders even where one name is carried by rows that differ.
- **`dc.name`, not `c.name`** — the denormalized column `deck_card_select` reads at the same
  position. The estimator dedupes on this string and so does the editor's panel, so a gallery
  reading the live `cards` row would fold a renamed or re-worded printing differently from the
  editor looking at the same deck. It is also the only name an orphaned row has at all.
- **`LEFT JOIN cards`, this file's discipline unchanged** — the opposite call from the pip read
  one section up, and for the reason that read gives: an orphan keeps its denormalized name and
  contributes no text, which is the honest reading, because nothing is known about a card that is
  not there. `game_changer` is read as `Option<bool>` and coalesced to **false**: the column is a
  list membership, so "not on the list" and "no row to ask" are one answer, which is
  `ImportMatch::game_changer`'s rule.
- **`categoryActive` is always `true` on every row this read emits, and is carried anyway** — a
  literal, since the `WHERE` has already pinned it. `estimateBracket` opens with
  `cards.filter(c => c.categoryActive)` and takes the same shape the editor hands it out of a
  fully loaded deck, where the flag really does vary. A row that omitted it would be a second
  type for one function, and the day the filter changed the two callers would part company
  silently.

**`BRACKET_IDS_SQL` builds the combo matcher's id list over the _same_ pile**, which is
`DeckBracket.tsx:117-121` written in SQL — and it has to be, because `estimateBracket` does not
re-check the combos it is handed. A caller that matched over a switched-off pile's cards gets
back a combo the deck does not really play, and nothing downstream can tell.

Two contract details the caller depends on:

- **The caller passes the deck ids, and that is a boundary rather than a convenience.** Which
  formats have a command zone is a `format_specs.commander_rule` question TypeScript already
  answers (`useFormatSpecs`), so a `WHERE fs.commander_rule …` here would be this crate drawing a
  conclusion — and drawing it again, differently, the day a second format grew brackets. **An
  empty request touches no database at all**, so a gallery with no Commander deck on it costs no
  query.
- **One entry per requested id, in request order** — `tags`' contract for its two per-card reads,
  and for its reason: the caller holds a list and wants a lookup, so **a deck deleted since the
  list was taken answers empty lists rather than going missing from a positional answer**.
- **A deck listing more than `combos::MAX_CARD_IDS` distinct printings fails the whole call**,
  with `combos::TOO_MANY_CARDS` — `match_combos`' own refusal, propagated rather than caught.
  That is `combos_for_cards`' behaviour unchanged, and the alternative, a silently truncated id
  list, would answer a *wrong* combo set that reads exactly like a right one. The bound is 1 000
  distinct printings against a Commander deck's hundred.

### `deck_sort` / `set_deck_sort` — one `app_meta` row, and a vocabulary Rust does not have

`crates/grimoire-core/src/decksort.rs`, ported from `listview.rs` whole: one key, `deck_sort`, holding a
single string like `"updated:desc"`, with `DEFAULT = "updated:desc"` — today's order exactly, so
the release that added a sort control does not quietly re-sort a reader's wall. **No migration**:
`app_meta` is schema v6's key/value table — the *application's*, deliberately not `sync_meta`,
where a row the sync did not write makes every later timing claim a fiction — and this is a key
in it.

**The one place it narrows `listview.rs` is the whole of what is worth writing down.** That
module checks the word it is given against `LAYOUTS`, because a wall is drawn one of two ways and
this build knows both. **This one checks nothing but emptiness**, because the words are
`packages/ui/features/decks/deckSort.ts`' — six keys and two directions today, three of which are
computed on the TypeScript side and have no SQL counterpart to check against — and *a database
outlives the app*. A key a later build stops offering, or one an earlier build has never heard
of, has to degrade to the default **on the reading side**; refused at the write end it would be a
reader whose sort silently would not save, on a build that had every reason to think it had. So
the row is **stored and answered verbatim** and TypeScript's `parseDeckSort` is what degrades it.

- **Reading can never fail.** A missing row, an unreadable one, and a row somebody emptied by
  hand all answer `DEFAULT`, and `deck_sort` is therefore **infallible by signature** —
  `card_zoom`'s contract, for its reason: a preference that cannot be read is not worth refusing
  to draw a gallery over. It is `#[tauri::command(async)]` rather than a bare sync command,
  `listview`'s call again, because a sync body runs inline on the IPC thread and this one takes
  `db_read`'s mutex, which a search may hold for tens of milliseconds.
- **Writing validates exactly one thing**: `store` refuses an empty string, which is
  `listview::store`'s blank-section refusal and its reason — a blank is a bug in the caller
  rather than an order, and stored it would be a row that reads back as "nothing stored" forever
  while the write that made it reported success. Everything else is written as given, and
  `BUSY` is the only other answer, which a first-run sync can spend whole minutes returning.
- **A default here, not — as `listview::stored` has it — an absence.** That module answers a map
  and lets a missing entry mean "the frontend's own default"; there is one setting here and one
  string to answer with, so an `Option` would be an emptiness every caller had to spell the same
  fallback for.
- **Only the sort is remembered.** A filter is a thing a reader is doing right now, and a gallery
  that opened already narrowed, with no memory of having asked for it, is a gallery that looks
  like it has lost decks.

All four commands are registered in `desktop.rs`.

## Tokens and emblems: derived on every open, deviations stored

`deck_tokens.rs` and user schema **v37**,
[issue #388](https://github.com/Msgaihede/mtg-grimoire/issues/388), landed 2026-09-07. Every
figure below was measured that day against the debug corpus at
`src-tauri/target/debug/data/corpus.db` (117 621 rows), in Node unless it says otherwise; the
design's own record is
[the spec](../superpowers/specs/2026-09-07-deck-token-management-design.md).

A deck that plays `Smothering Tithe` needs a Treasure; one that plays `Elspeth, Sun's Champion`
needs Soldiers **and** an emblem. Neither fact is in a column — Scryfall publishes it inside each
printing's `all_parts` array, which this crate stores gzipped in `cards.raw` — so this module is
`card::meld_parts`' sibling: the same inflate, the same parse, the same walk over `all_parts`, the
same *every failure is an empty vec*, pointed at a different `component`. **Nothing is
downloaded**: 2 988 `token`, 137 `emblem` and 120 `double_faced_token` rows are already local, and
**2 520 of the 2 523 distinct token printings some card's `all_parts` names resolve to a local
`cards` row — 99.9 %**.

**User schema v52 (2026-09-26, [the token-stacks spec](../superpowers/specs/2026-09-26-token-stacks-design.md)
§4) split what the reader stores in two**, and the subsections below are written against that
shape unless they say otherwise. `deck_tokens` keeps what is the **token's** and shared by both
lists — its state, `auto` / `hidden` / `manual` — and its `card_id` and `quantity` became
**legacy**: read for an implicit entry's count, and written again only by the launch conversion
that clears them (*The launch conversion*, below). What the reader keeps of a
token moved to **`deck_token_printings`**: *entries*, one printing in one finish in one list with a
quantity, so a deck can bring a Treasure in two arts, or a foil one, and the plan can ask for a
different Treasure from the live list. The six commands replaced the four; every token write
became a journalled deck write; a token dropped anywhere in the editor became a token entry rather
than a deck card; and a token nothing makes any more is reconciled away after card writes. Every
figure added for v52 was measured 2026-09-26 on the debug corpus (`cargo test` in the worktree, a
debug build, or `node:sqlite` read-only where it says so).

**User schema v55 (2026-09-27, [the token-improvements spec](../superpowers/specs/2026-09-27-token-improvements-design.md))
made the managed mode the only one, and quieter**, in place of token stacks' PR 3 (Collection
tokens), which the reader dropped the same day. **An untouched token reads 0**, not 1
(`implicit_quantity`, *The default*, below). **Dismiss and Reset printings are gone** —
`deck_token_state` and `deck_token_reset` left the IPC surface — and **`deck_token_remove`** takes
one entry away instead, while a launch pass, `retire_hidden`, turns every old dismissal back into
an ordinary token at zero. **A token added by hand is drawn only in a list that holds an entry of
it.** **`token_printings`** lists every token in the game, and the game helpers, for the picker's
`All tokens`. The
Compare read and the managed wishlist each gained a token arm (the wishlist's Tokens subfolder is
the one rung: `wishlist_folders.managed_tokens`, [wishlist-folders.md](wishlist-folders.md)).
`decks.token_mode` stays in the schema with nothing reading it. The subsections below say which
of their sentences v55 changed.

### The filter rule is a union, and getting it wrong is the way to ship something that looks right

> Keep an `all_parts` entry when its **`component` is `"token"`**, **or** when the `cards` row it
> **resolves to** has **`layout = 'emblem'`**.

`deck_tokens::TOKEN_COMPONENTS` and `EXTRA_LAYOUTS` are the two halves, and **each one alone is
measurably wrong**:

- **`component == "token"` alone misses every emblem.** A full-corpus scan found exactly four
  component values — `combo_piece` 148 216, `token` 16 377, `meld_part` 164, `meld_result` 81 —
  and an emblem is not in the `token` half: `Elspeth, Sun's Champion` names hers as a
  `combo_piece` carrying `type_line: "Emblem — Elspeth"`.
- **A layout allow-list alone drops 78 real token relationships.** The layouts a
  `component: "token"` entry resolves to are `token` 16 216, `double_faced_token` 79, **`flip`
  75** and `reversible_card` 3, so gating the component half on layout is a silent subtraction of
  those 78.

The emblem half is tested against the row the entry **resolves to** and never against the entry
itself, which is why the walk resolves first and decides second rather than filtering in one pass.
An entry resolving to no local row is dropped rather than drawn as a hole — 3 printings in the
whole corpus, and a token nobody can draw or pick art for is not a row worth having.

### ⚠️ There is no self-exclusion rule, and that is where this parts company with `meld_parts`

`card::meld_parts` **must** drop an entry whose `name` equals the producing card's own
(`card.rs:635`), and this module deliberately does not. It is the single most likely thing in the
feature for a future reader to "simplify" back into a bug.

**The keep rule already excludes a card's own printing without being asked.** A card's self-entry
arrives as `component: "combo_piece"` resolving to a row with the card's own layout — `normal`,
never `token` or `emblem` — so it fails the union before any name is compared.

What a name test would subtract instead is measured. Restricted to the **108 372** rows a deck can
hold (`legal_mask != 0`, non-token layouts), counting the `all_parts` entries that pass the keep
rule **and** carry the producing card's own name:

| what was counted | answer |
| --- | --- |
| same-name entries passing the keep rule | **154** |
| distinct producer names | **55** |
| their target layouts | `token` 154, and nothing else |
| their producer layouts | `normal` 154, and nothing else |
| target `id` == producer `id` | **0** |
| target `oracle_id` == producer `oracle_id` | **0** |

**The last zero is the one that carries the argument.** A different *printing id* could still have
been the same card under another printing — that is exactly the trap `meld_parts` documents at
`card.rs:635`, and it is why the rule there is a name test and not an id test. A different *oracle
id* cannot be. So not one of the 154 is the card itself; every one is a genuinely different oracle
card wearing the producer's name, which is what an Embalm or Eternalize token is. They are
`Timeless Dragon`, `Sacred Cat`, `Adorned Pouncer`, `Champion of Wits`, `Earthshaker Khenra`,
`Temmet, Vizier of Naktamun`, `Manifold Mouse` and forty-eight more names, where the token *is* a
copy of the card and wears its name by rule.

**The two cases are opposites and one word hides it.** In `meld_parts` a same-named entry **is the
same card**; here it is a token **of** that card, which is a different oracle card that happens to
wear the card's name. So the rule that is correct one file over subtracts exactly those 55 cards'
tokens here and subtracts nothing else. `an_embalm_token_sharing_its_makers_name_is_kept` and
`a_cards_own_printing_never_reaches_the_wall` are the pair that hold both halves.

**And the obvious objection, answered so nobody adds a fence for it.** Corpus-wide and
*unrestricted*, there **are** 2 929 same-name kept entries that do share the producer's oracle id
— but every one of them has a producer layout of `token` (2 780), `emblem` (136),
`double_faced_token` (7), `flip` (5) or `reversible_card` (1), and the six non-obvious `flip` and
`reversible_card` ones were checked by hand: all are double-sided *token* cards on a flip frame,
all `legal_mask = 0`. So the only rows that can name themselves through the keep rule are tokens
naming their own printing, and **those are never `deck_cards` rows**, because the search wall
fences tokens behind `legal_mask != 0`. A deck that somehow listed a Spirit token and drew a
Spirit on its token wall would be right rather than wrong. No extra fence is needed.

### Game markers: a second arm read off the maker's text (issue #670)

The keep rule never sees a **game helper**. The Monarch, Undercity // The Initiative, City's
Blessing, Day // Night and the dungeons are filed under `token` / `double_faced_token`, not
`emblem`, and a real card names one as a `combo_piece` when it names it at all. So a deck that
plays `Palace Jailer` derived no Monarch, although *All tokens* could already add one by hand.
Widening the keep rule to every `combo_piece` helper would also derive Morph for 402 cards and
every Plot, Foretell and Adventure reminder, so the fix is narrower than that.

> For each maker, read its rules text (top-level `oracle_text` and every face's, off the `raw`
> blob, lower-cased, `’` folded to `'`). When it holds one of a **marker's** phrases, credit that
> marker's helper cards exactly as an `all_parts` token would be credited.

`deck_tokens::MARKERS` is the table:

| Phrase in the maker's text | Helper card names looked up |
| --- | --- |
| `become the monarch`, `becomes the monarch` | The Monarch |
| `the ring tempts you` | The Ring, The Ring Tempts You, The Ring // The Ring Tempts You |
| `the initiative` | Undercity // The Initiative, The Initiative // Undercity |
| `venture into the dungeon` | Lost Mine of Phandelver, Dungeon of the Mad Mage, Tomb of Annihilation |
| `city's blessing` | City's Blessing |
| `daybound`, `nightbound`, `it becomes day`, `it becomes night` | Day // Night |
| `start your engines!` | Start Your Engines! // Max Speed |

- **Names, not a face-name match.** `name IN (…)` uses `idx_cards_name`. Matching ` // X` inside
  the name would scan the whole corpus on every open of such a deck. `marker_printings` keeps
  one printing per oracle id: the newest **paper** printing with a token layout, outside a
  `memorabilia` or `minigame` set. That is the helper arm of `is_listed_token`, so a World
  Championships deck's copy is never the default art.
- **A name the corpus does not hold resolves to nothing, never an error.** The Monarch, Day //
  Night, City's Blessing and Start Your Engines! // Max Speed are spelled the way the debug corpus
  and the Storybook corpus hold them. Undercity // The Initiative matches the helper tests'
  `Dungeon — Undercity // Card` row. **The Ring's spellings and the three dungeon names were not
  measured**: the change was written without corpus access. So The Ring lists every spelling its
  reminder card goes by. Confirm them against a live corpus and remove the misses.
- **One maker is one source**, however many ways it names a helper (an `all_parts` entry and a
  phrase both count). The markers are read before the `all_parts` early return, so a card with no
  `all_parts` can still make its controller the monarch. Inactive piles contribute nothing, as for
  every token.
- **Reconcile follows for free.** `reconcile_in` asks `derive`, so a helper whose last marker maker
  is cut loses its `auto` entries like any token. A marker lookup never sets `unreadable`: a
  helper missing from the corpus has no entries anybody could hold.
- **Dungeons are listed too.** `is_listed_token`'s helper arm, and its SQL and TypeScript twins,
  also keep a face beginning `Dungeon`, so a dungeon can be picked from *All tokens* like
  The Initiative. A dungeon's line is never exactly `Card`.
- The Storybook fake mirrors the table in `packages/fake/db.ts` (`TOKEN_MARKERS`).

### The grain is `(deck_id, oracle_id)`, and only deviations are written down

```sql
CREATE TABLE deck_tokens (
    id INTEGER PRIMARY KEY,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    oracle_id TEXT NOT NULL,
    card_id TEXT,          -- the printing the reader picked; NULL is the resolver's
    quantity INTEGER,      -- NULL is the default: 0 since v55, 1 before it
    state TEXT NOT NULL DEFAULT 'auto'
        CHECK (state IN ('auto','hidden','manual')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , sync_uid TEXT);
CREATE UNIQUE INDEX idx_deck_tokens_grain ON deck_tokens (deck_id, oracle_id);
CREATE UNIQUE INDEX idx_deck_tokens_uid ON deck_tokens (sync_uid);
```

- **`schema::DECK_TOKEN_GRAIN` is `"deck_id, oracle_id"`** and every `ON CONFLICT` interpolates
  it: a conflict target that does not match the index verbatim is a runtime error at the first
  write and not a compile error. It carries no `coalesce`, so unlike `COLLECTION_GRAIN`,
  `WISHLIST_GRAIN` and `DECK_CARD_GRAIN` it can be read back through `PRAGMA index_info` —
  `every_plain_grain_constant_names_the_index_the_head_schema_carries` is the second fence, and
  the only one there was until the first `ON CONFLICT` interpolated the constant.
- **`oracle_id` and not `card_id`**, because the row has to survive the reader changing which
  printing they want: the art choice *is* one of the things it stores. Every token, emblem and
  double-faced-token row in the corpus carries an `oracle_id` (**0 missing of 3 245**), which is
  what makes the column safe as a grain in a way `card_id` would not be.
- **Deliberately not grained on `variant`.** The derived list is per-variant because deck cards
  are; the override is not. Choosing the Treasure art for a deck and finding it reverted in the
  theory build would be a surprise with nothing to recommend it. **v52 kept that answer for the
  state and reversed it for the art**: a dismissal is still "not in this deck" whichever list the
  reader is looking at, while the printings moved to per-list entries (below), because the plan
  asking for a different Treasure than the live list holds is exactly what theory tracking is for.
- **The three states.** `auto` — the row exists only to carry a legacy quantity (before v52, a
  printing and/or a quantity) for a token the deck derives anyway. `hidden` — the reader dismissed
  it, **on a build before v55**: still derived, and drawn until then by nothing. **Nothing writes it
  since v55** — the dismiss went with the eye button — and nothing reads it as hidden: a `hidden`
  row draws like any other token, and `retire_hidden` (below) turns every one back at the next
  launch. It stays in the `CHECK` because a peer on an older build can still write it and an old
  undo step can still restore it. `manual` — drawn whether or not anything derives it, which is
  both a token the reader added by hand and what a derived token becomes when they want it kept
  after cutting the card that made it — and, since v52, the one state the reconcile never touches;
  **since v55 a token nothing derives is drawn only in a list that holds an entry of it** (the
  hand-added tail, below). The vocabulary is spelled twice on purpose: the `CHECK` is the shape,
  and `deck_tokens::TOKEN_STATES` names the words this module writes, held to the `CHECK` by
  `every_state_word_is_one_the_table_accepts`. **It also turned an unknown word into a sentence
  (`BAD_STATE`) while `deck_token_state` let a command parameter reach this column** —
  `deck::set_folder`'s rule — and v55 retired that command, the sentence with it: no parameter
  reaches the column now.
- **The empty row is not representable.** `state = 'auto'` with no `card_id` and no `quantity`
  carries no information, so the state write (`set_token_override` until v52, `write_state` since)
  **deletes** instead of writing it. That keeps *the reader has not deviated* one state rather than
  two that have to be kept in agreement. **A quantity of zero was not that case**: it was a token
  the reader deliberately zeroed, and the row went on carrying the art they picked. Since v52 a
  zero lives on an entry (rule 3, below), and a legacy `0` left on a pre-v52 row still reads as the
  implicit entry's count — `implicit_quantity` is `legacy.unwrap_or(0)` (`unwrap_or(1)` until
  v55), a `??` and never a truthiness test, so it stays zeroed.
  **v52's launch conversion leaves one row the old write path never made**: `state = 'auto'` with
  both legacy columns cleared, where the override's art moved out. It is harmless — the resolver
  reads it as
  *no deviation* — and the next `auto` written to that token deletes it, as an empty `auto` row
  always was.

### Entries: `deck_token_printings`, per list, since user schema v52

```sql
CREATE TABLE deck_token_printings (
    id INTEGER PRIMARY KEY,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    variant TEXT NOT NULL CHECK (variant IN ('live','theory')),
    oracle_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    finish TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')),
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , sync_uid TEXT);
CREATE UNIQUE INDEX idx_deck_token_printings_grain
    ON deck_token_printings (deck_id, variant, card_id, finish);
CREATE UNIQUE INDEX idx_deck_token_printings_uid ON deck_token_printings (sync_uid);
```

(The rung's own SQL comments are left out here; `schema.rs` carries them.)

- **`schema::DECK_TOKEN_PRINTING_GRAIN` is `"deck_id, variant, card_id, finish"`**, interpolated
  into every `ON CONFLICT` for `DECK_TOKEN_GRAIN`'s reason and fenced by
  `every_plain_grain_constant_names_the_index_the_head_schema_carries` — it carries no `coalesce`.
  **`finish` is NOT NULL on purpose**: SQLite's unique index treats every NULL as distinct, so a
  nullable finish would let one list hold the same regular printing twice. It is the collection's
  own three words, **not** `deck_cards.finish`'s NULL-for-regular — a token entry always names its
  finish, and the page spells it the deck card's way only where it is fed to a deck card's
  functions (`tokenDeckFinish`). `oracle_id` is a stored fact for grouping (and for an entry whose
  printing has left the corpus) and not a grain term, because a printing has one oracle.
- **An entry is always a concrete printing**, so `card_id` is NOT NULL — and a token with **no**
  entries in a list is drawn as one **implicit entry** instead, which is the *absence* of a row
  rather than a NULL: the resolver's printing (below), in its `default_finish` — `nonfoil` where
  the printing is sold that way, else its first sold finish (its **sole** finish, for the 13 515
  foil-only and 892 etched-only printings), and `nonfoil` where `finishes` says nothing — at
  `deck_tokens.quantity ?? 0`. `default_finish` is one function because four readers must agree:
  the implicit entry, rule 2's materialisation, an add naming no finish, and the launch repair.
  **Only a token the list derives has an implicit entry** since v55: a token added by hand has no
  default printing *for this deck* — nothing in it makes the token — so a list holding none of its
  entries draws nothing for it (`deck_token_rows`' hand-added tail), and a Soldier added to the
  live list is not on the plan's wall.
- **The default is 0 since v55, and 1 until then** (the token-improvements spec §3.1) —
  `implicit_quantity` is `legacy.unwrap_or(0)`. A token is something the reader starts to use: a
  Treasure the deck *can* make is not a Treasure on the table, so an untouched one counts nothing,
  stays out of the stacks, and the first `+` materialises it at one. **Nothing stored changes**: an
  untouched token was never written, so it simply reads 0 from this build on — no rung, no pass —
  and a peer still on v52 to v54 draws the same untouched token at 1, a difference in what two
  builds *draw*, never in what they store. A legacy count set before v52 is still the reader's,
  `0` included. TypeScript's `DEFAULT_TOKEN_QUANTITY` is `0` with it, read only by the Storybook
  fake's mirror of the resolver.
- **The seven rules** (spec §4.2), all in `deck_tokens.rs`:
  1. A token with entries in a list draws exactly those; with none, its implicit entry — if the
     list derives it (a hand-added token draws nothing in a list with none of its entries, v55).
  2. **The first write to an implicit entry materialises it in that list only** — a step, a swap,
     an added printing. The write resolves the default at write time with the resolver's own code
     for that one oracle (`implicit_entry` → `derived_printing` → `implicit_of`), so it inserts
     the entry the reader was looking at. `a_materialised_entry_starts_at_the_legacy_quantity`.
  3. **Stepping an entry to 0 deletes it unless it is the token's last entry in that list**, which
     stays at 0 — `stepping_one_of_two_entries_to_zero_deletes_it_and_the_last_one_stays_at_zero`
     and `zeroing_the_only_printing_keeps_it_at_zero_rather_than_the_default`. **Remove printing
     is the one write that takes the last entry** (v55, below).
  4. **A swap** replaces an entry's printing and/or finish, and landing on a grain the list holds
     **folds** (quantities summed, one row). `to` must be a printing **of this token**
     (`NOT_THIS_TOKEN`) in a finish it is sold in (`deck::FINISH_NOT_SOLD`); a swap onto the
     entry's own grain writes and records nothing.
  5. **Adding a printing** materialises the implicit entry first, then inserts the printing at
     `quantity` or steps the held entry up by it; a token the list derives nothing for becomes
     `manual`, and a `hidden` one it does derive comes back to `auto` (an add is *put this on the
     wall*, and filing a printing that stays hidden would be a press nobody can see — since v55 a
     `hidden` reaches a write only where the launch pass has not retired it yet, and every token
     write settles it the same way, `settle_hidden`). **It also
     deletes the token's zero-quantity entries in that list**, never the one it adds to: rule 3
     held one at zero because it was the last, and beside the new entry it is a `0` tile no
     stepper can send to zero again. The deletes are the write's own, inside `journal_in`, so one
     Undo restores them —
     `adding_a_printing_clears_the_tokens_zero_entries_in_that_list_and_undo_restores_them`.
  6. **Theory and live never share an entry**; every entry write names its list.
  7. **A token nothing makes any more is removed** — *Rule 7*, below.

  **Remove printing** (v55, the token-improvements spec §3.4) is `remove_entry`: it deletes one
  stored entry **unconditionally** — the one write that can take a token's last entry, which rule
  3's stepper holds at 0 — and answers `ENTRY_GONE` for one that is not there. Nothing more is
  written in the common case, because rule 1 already says what the list draws next: **a derived
  token** whose last entry goes falls back to its implicit entry at 0, which is what the retired
  Reset printings did, one printing at a time. **A hand-added token** leaves this list's band, and
  when it holds no entry in **either** list its state goes back to `auto` through `write_state`,
  which deletes the row: a `manual` row with no entry anywhere would be a token on no wall that no
  cut could ever reconcile away, and a later add makes it `manual` again. Journalled like every
  token write (`action: "remove"`), its step carries the state when it moved, so one Undo puts the
  entry and the reader's `manual` back together.

  `null` for an entry on the wire means the implicit one. **A `null` sent to a list that already
  holds entries is a stale page** — a second press computed before the first one's answer came
  back — and it is answered by the stored entry at the implicit grain where there is one, and
  refused (`ENTRY_GONE`) where there is not, because a write to a printing the reader was not
  looking at would be worse than a sentence. A write naming the implicit entry of a token that is
  not on the wall at all is `TOKEN_GONE`.
- **Synced**, the seventeenth table, with `quantity` a **field** for the reason the next section
  gives — NOT NULL this time, so a counter would be *possible*, and still wrong: two devices each
  setting a count of 4 mean 4. Its `apply::Meta` grain is `(deck_uid, variant, card_id, finish)`,
  its rank 16. **The rung converts nothing**: the v51 picks become entries in
  `deck_tokens::convert_legacy_picks`, a **captured** pass after `capture::install` — at launch on
  a device in no group, behind a pull on one in a group — whose entries take derived uids
  (`<pick uid>-<list>`) and announce themselves as puts. Why the rung-time conversion, derived
  uids and uncaptured writes both, was retired is in [sync.md](sync.md) and
  [data-and-sync.md](data-and-sync.md).

### `quantity` is a synced **field** and not a counter, on two grounds

`deck_tokens` is the **thirteenth** synced table (`schema::SYNCED_TABLES`, user schema v37), and
it is where this distinction is written out. Mechanically a counter carries `NEW - OLD` and this
column is nullable, so there is no arithmetic to carry — `deck_cards.quantity` can be a counter
precisely because it is `NOT NULL`. Semantically last-write-wins is what is wanted:
`deck_cards.quantity` sums because two devices each sleeving a copy means two copies, but *how
many Treasures I want to bring* is a **setting**, and two devices each setting it to 4 must mean 4
rather than 8. No counter also means no `Floor` in `apply::META`.

**A new synced table owes TEN registrations, not nine.** That list said nine until this rung was
actually built. The tenth is `sync_engine/apply/tests.rs`'
`every_unique_index_on_a_synced_table_has_been_decided_about`, which reads every UNIQUE index off
a live `SYNCED_TABLES` and compares it against a written-down list, so it goes red on any new
synced table that has a grain. It is easy to miss because it sits in a `tests.rs` rather than
beside the other nine, and because nothing at a registration site points at it. The other nine:
the `if v < N` rung at the **bottom** of `migrate_user` ending in its own **literal** number; the
matching lines in `USER_SCHEMA_SQL`; an `UNDO_V<N>` for the rewind fixtures; `schema::TABLES` with
`Side::User`; an arm in `mirror::watch::surface_of`; the `sync_uid` column and its unique index in
**both** the rung and `USER_SCHEMA_SQL`; `schema::SYNCED_TABLES`; a `capture::Spec`; and an
`apply::Meta`. The three array lengths (`SYNCED_TABLES`, `capture::TABLES`, `apply::META`) move
together, and they are the one part of the list a compile error catches. **It is twelve since
v52's `deck_token_printings` counted them while landing**: the ten, plus `packages/ui/lib/userTables.json`
(held to `schema::TABLES` by `changes.rs`) and `packages/ui/lib/crossWindow.ts`' `TABLE_KEYS` (held to that
file by `crossWindow.test.ts`), which any new *user* table owes, synced or not —
[sync.md](sync.md) has the list.

Three notes on the sync half that are this table's own:

- **`oracle_id` is on the `capture::Spec`'s field list even though it is half the grain**, which
  is `muted_tags`' and `device_names`' reason: the far device has to be able to *build* the row,
  and the grain `apply::META` restates is a way of recognising one that is already there.

- **`apply::META`'s `order` is 12, appended rather than slotted in behind `decks`.** The rank is
  only ever *sorted* by, through `baseline::build`'s `order_of`, so what it has to say is "after
  the deck this row hangs off" — which any number above `decks`' 1 says. Renumbering the tail to
  put it at 2 would move ten ranks to change nothing an emission can observe, and `baseline`'s
  hard failure is on a *missing* rank rather than on a gap.
- **The `Grain` takes `deck_id` from `Source::Parent` and `oracle_id` from `Source::Field`.** A
  local deck id means nothing on the far device; an oracle id is Scryfall's and means the same
  thing everywhere. Without the grain, two devices that each picked an art for the same token in
  the same deck hold one row under two uids, and the far op is not a row to update but a row to
  insert — which hits the unique index, rolls the group's savepoint back, and leaves a row this
  database cannot build: skipped and recorded since 2026-09-27, lost with its sender's later ops
  in the page before that. `deck_labels`' reason, one table over.

### The list is derived on every deck open, and that is cheaper than storing it

`deck_tokens::deck_token_rows(conn, deck_id, variant)` inflates the `raw` blob of each **distinct**
card in the deck's **active** categories and walks `all_parts`. Measured over a 100-card pool (the
top 100 by `edhrec_rank`, denser than a real deck): 71 `all_parts` entries scanned, 10 kept, 9
distinct tokens needed, **4.9 / 4.9 / 5.3 ms in Node** — and Rust beats that, because only the
cards in the open deck are ever inflated.

A *stored* list would need a reconciliation pass on every deck edit and would go stale the next
time a Scryfall sync changed a card's `all_parts`, with nothing to notice. What is written down is
only the reader's deviation. **v52 is the one place that argument had to be paid anyway**: *which*
tokens a list needs is still derived, but the entries the reader keeps are stored, and an entry of
a token nothing makes any more is exactly the stale row this paragraph warns about — so rule 7's
reconcile (below) runs after card writes, against this same derivation.

- **Active categories only** — `deck_categories.is_active = 1`. `is_active = 0` means *counts
  toward nothing*, which is the whole of what the old `maybe` zone meant, so the **Maybeboard
  makes no tokens**. The Sideboard and the Companion are active and do contribute, which is right:
  you sleeve those.
- **`CAST(raw AS BLOB)` is required, and this can never be done in SQL at all.** rusqlite will not
  hand a TEXT-declared value out as `Vec<u8>`, and `json_extract` over a gzip member is a hard
  `malformed JSON` error rather than a NULL.
- **Nothing is gated on `layout` before the blob is touched**, which is the one place this parts
  from `meld_parts`. That function gates on `layout = 'meld'` and turns a decompression on every
  card the reader opens into one on 72 rows of 117 621. There is no such column here — token
  references sit on 15 161 printings and nothing predicts them — and **the corpus-wide token index
  is the thing that must not be built**: a cold full scan costs 6.5 s and it would have to be a new
  ingest-filled column. The question is never asked corpus-wide, only of the deck in front of the
  reader.
- **Every failure is `Ok(vec![])` and never an `Err`**: an unknown deck, an unknown printing, a
  `raw` that will not inflate or parse, a missing `all_parts`, an `all_parts` that is not an
  array. A deck must not fail to open over an area most decks use lightly. **Since v52 the walk
  also says that it happened** — `derive` answers a `Derivation { tokens, unreadable }`, where
  `unreadable` is set by a maker that has left the corpus, a `raw` that will not inflate or parse,
  an `all_parts` that is not an array, or an entry naming a printing this corpus does not hold.
  The resolver ignores it (a wall short of one token beats a deck that will not open); **the
  reconcile does not**, because the reconcile *deletes* (*Rule 7*, below).

### The default printing, and why the tie-break is the common path

`defaultCardId` is the referenced printing the **most** of the deck's cards point at, ties broken
by `released_at DESC, set_code ASC, collector_number ASC, id ASC` — the tail
`card::list_printings` already orders by, so the art the resolver names is the art at the top of
the picker the reader opens next. **Deterministic, or the same deck draws different art on two
opens.**

**The tie-break is not the rare fallback it looks like.** Different maker cards name different
printings of the same token: across **40 Treasure makers, 12 distinct Treasure printings** were
referenced, so a deck with two Treasure makers usually gives both a reference count of 1 and the
tail is what actually chooses. `the_default_printing_is_stable_across_calls` and
`the_most_referenced_printing_wins_before_the_tie_break` are the pair — the second asserts with
the *older* printing referenced twice, so a rule that read only the tail would answer the newer
one.

`newest_printing` is that same tail written as SQL, for the hand-added tail of the answer, so a
`manual` row and a derived one cannot disagree about which art is the default.

**Since v52 this printing is the implicit entry's**, and a write materialises exactly it — which is
why "which printing is the default" had to stay a Rust answer rather than a TypeScript one: the
page draws the implicit entry and the write inserts it, and two halves computing it could
disagree. A stored entry may be any printing of the token; `defaultCardId` still travels on every
row, and is simply not the entry's own `cardId` once the reader has picked.

### A token's name does not identify it

**104 token and emblem names are carried by more than one `oracle_id`** — `Elemental` by 31,
`Spirit` by 22, `Bird` and `Soldier` by 13 each, `Insect` 12, `Golem` 11 — and one card can make
two of them: **`Wurmcoil Engine` makes two tokens both called `Wurm`**, both 3/3, both colourless
artifacts, separated only by Deathtouch against Lifelink. So **grouping is by `oracle_id` and
never by name**, and `DeckTokenRow` carries four fields no resolver needs — `power`, `toughness`,
`colors`, `oracleText` — for the page to build a subtitle out of.

All three of colours, size and text are needed, because each alone is insufficient: the corpus
holds a colourless 1/1 Soldier with no text beside a white 1/1 Soldier with no text, which p/t and
text together cannot separate. **`power` and `toughness` are strings and must never be parsed to
numbers** — Scryfall writes `*`, `1+*` and `∞`, and there is a real `*`-over-`*` Elemental.
`colors` is the concatenated-letter string `cards.colors` stores (`""`, `"W"`, `"BGRUW"`) and
never a JSON array, which is what `DeckCard.colors` already is.

Two tiles announcing one accessible name is a bug that has already shipped here once, on the
collection wall, where a 2X2 and an LEA Lightning Bolt both announced *"Copies of Lightning
Bolt"* — neither suite caught it, because both names were **correct** and merely not unique.

### The commands (four until user schema v52; two swapped at v55)

| command | what it does |
| --- | --- |
| `deck_tokens(deckId, variant, marketplace)` | **one row per entry** since v52 — every stored entry of each token in that list, or its one implicit entry (`implicit: true`) — with the token's derivation, sources and effective state on every row of it, and each row's chin facts and price for **its entry's printing at its entry's finish** (*The chin and the price*, below). Read-only connection on the blocking pool, `card_meld_parts`' shape. **`marketplace` is `Option<String>` through `Marketplace::from_opt`**, `card_printings`' shape, so an id this build does not know lands on TCGplayer. It had no `marketplace` until 2026-09-26's PR 1, when nothing in the answer was priced |
| `deck_token_set_quantity(deckId, variant, oracleId, entry, quantity)` | rules 2 and 3: `entry` is `{ cardId, finish }`, or `null` for the implicit entry, which is materialised in that list; `0` deletes the entry unless it is the token's last in the list. A negative number is the collection's sentence for one |
| `deck_token_swap(deckId, variant, oracleId, from, to)` | rule 4: `from` as above, `to` always a printing and a finish; folds onto a held grain (the history row says `folded`) |
| `deck_token_add_printing(deckId, variant, cardId, finish)` | rule 5, one copy, through `add_printing_in`: the token is read off the printing, which must be a token or an emblem (`NOT_A_TOKEN`); a `null` finish is the printing's default |
| `deck_token_remove(deckId, variant, oracleId, entry)` | **v55** — Remove printing: `entry` is `{ cardId, finish }`, always a stored entry and never `null`; deletes it unconditionally (above), `ENTRY_GONE` where it is not there |
| `token_printings(marketplace)` | **v55** — every paper token, emblem and game-helper printing in the corpus, for the picker's `All tokens` (*`token_printings`*, below). A read, on the read connection |

**Retired at v52: `deck_token_set`, `deck_token_clear` and `deck_token_add`** — the last had no
caller at all (measured 2026-09-26). **Retired at v55: `deck_token_state`** (dismiss, restore,
keep — shared by both lists, so it named no variant) **and `deck_token_reset`** (every entry of a
token in one list, back to the implicit one): the dismiss went with the eye button, and one Remove
per printing covers what Reset did. `desktop.rs`' handler list dropped all five. The rule the first
one needed — *the page sends the whole triple, because the row is defined by what it carries* —
went with it: no write is a triple now.

- **The wire key for the state word was `state`, and the Tauri wrapper named its managed
  `AppState` `app` instead** — Tauri injects a `tauri::State` by its type and never by its name,
  which freed the name for the argument the page sent. Until v52 it was the other way round
  (`tokenState` on the wire, `token_state` in Rust, and `packages/ui/lib/ipc.ts` the one place that knew
  the rename); since v55 no command sends a state at all. `ipc.test.ts` pins every argument set
  against the crate's own parameter lists — it is the only fence that boundary has.
- **Plain `sync::with_write` and never `with_write_owned`**, for all four writes. That one is for
  the commands that move copies across the collection/deck boundary; no token write changes what
  the reader owns, and the facet index's `owned` bitset has nothing to rebuild.
- **Every refusal is a sentence.** `deck::GONE` for
  a deck that is not there — every write's journal opens with a read of the deck, and
  `deck_tokens.deck_id` and
  `deck_token_printings.deck_id` have enforced foreign keys while `PRAGMA foreign_keys` is
  per-connection, so a deck deleted in another window is `FOREIGN KEY constraint failed` on the
  app's connections and a silent orphan on one without the pragma, and a sentence in Rust answers
  both; `NO_SUCH_PRINTING` for a printing that has left the corpus, because that id arrives from a
  printings grid the reader was just looking at and a press that reported success and stored
  nothing would be worse than a refusal; and v52's `NOT_A_TOKEN`, `NOT_THIS_TOKEN`, `ENTRY_GONE`,
  `TOKEN_GONE` and `deck::FINISH_NOT_SOLD` as the rules above describe.
- **The art picker adds no Rust.** `card_printings`' predicate is `oracle_id = ?1 AND is_paper = 1`
  (`card.rs:96`) with no `legal_mask` term at all, and every token row satisfies both. It needs no
  `playableOnly: false` either — **that flag belongs to `search_cards`**, which is what
  `DeckCoverPicker.tsx:148` passes it to, and reading the two as one command is how this picker
  would come back empty for every token in the game. **It still adds none at v52**, where the
  picker's grain became the printing *and* the finish: `card_printings` already answers each
  printing's `finishes` and `finishPrices`, and the page expands one printing into one tile per
  finish (`packages/ui/features/decks/CLAUDE.md`). **`All tokens` added the one command it needed at v55**,
  because no command listed tokens across the corpus: `card_printings` answers one oracle id, and
  `search_cards` has no layout predicate and hides tokens behind `playable_only`.

### `token_printings`: every token in the game, for `All tokens` (v55)

`deck_tokens::list_token_printings(conn, market)` answers **every paper printing
`is_listed_token` says yes to** — every token and emblem, and the game helpers a deck brings to
the table (*What All tokens lists*, below) — as `TokenPrinting`: the picker's own `card::Printing`,
`#[serde(flatten)]`ed so its tile code draws one with no branch, with the token's `oracle_id`,
`name`, `type_line`, `colors`, `power`, `toughness` and `oracle_text` beside it for grouping and
`tokenSubtitle`. **No `layout` of its own**: the flattened printing already carries one, and a
second field would write the key twice. Ordered by name, then `oracle_id` (two tokens share a
name), then newest printing first by `list_printings`' tail; a row with no `oracle_id` is skipped.

- **One statement with the predicate in SQL, both arms**, every word interpolated from the
  module's constants rather than retyped, and
  `token_printings_answers_every_token_and_nothing_else` and
  `token_printings_keeps_the_game_helpers_and_leaves_out_other_games` holding the SQL to the Rust
  function over a fixture of every shape. `LIKE` is ASCII-case-insensitive where `starts_with` is
  not; on the debug corpus that changes nothing (measured with `node:sqlite`, 2026-09-27). The
  helper arm is `instr`, case-sensitive like its Rust.
- **What All tokens lists** (the reader's rule, 2026-09-28): **a token or an emblem** — a token
  or two-sided layout with a type line or any ` // ` face beginning `Token` or `Emblem` — **or a
  game helper**: a `token` / `double_faced_token` printing outside a `memorabilia` or `minigame`
  set (a subquery on `sets`, so a set `sets` does not list is kept) that has a face whose
  type line is exactly `Card` and no checklist's `this card to represent `, has a face beginning
  `Dungeon` (since #670), or says `face-down` in its text. So The Monarch, The Initiative, Day // Night, City's Blessing, Energy Reserve,
  Radiation, Plot, Foretell, On an Adventure, Start Your Engines, the OTC Bounties, Punchcard and
  the face-down Manifest, Morph and Cyberman cards are listed, and the World Championship decks'
  ads, bios and decklists, the set checklists, the booster minigames, the Theros challenge decks
  and the TMNT arena's bosses and events are not. Anything in doubt is kept: one card too many
  costs a scroll, one hidden costs a card the reader cannot add. Measured over a copy of the debug
  corpus that day: **3 303 printings over 1 096 tokens** while the layout decided alone, **3 023
  over 911** for the day the list took only `Token` and `Emblem` faces (after the live pass found
  the wall opening on two deck ads), and **3 110 over 940** with the helpers back — 87 printings
  of 29 helpers returned, 193 still left out, and no token or emblem lost at either step. The
  function's doc says why no name list is needed and what `all_parts` would have said.
- **No index is added, and `NOT INDEXED` is deliberate**: it runs on a press, never per keystroke,
  and SQLite's own plan walked `idx_cards_name` to skip the sort at a table lookup per corpus row,
  which a plain scan with a sort of the matches beat in both paired runs that day. The figures are
  in the function's doc, on a machine busy enough that only their order is worth quoting.
- **A read on the read connection** (`lock_db_read`, `spawn_blocking`), registered in
  `desktop.rs`' handler list and answered by the Storybook fake.

### Every token write is a deck write: one history row, one undo step (v52)

This reverses what the module said from #388 to v52 — *token writes record nothing* — because the
reader asked for undo, and a token write is a deck write in every sense the editor draws.
**`deck_tokens::journal_in` is the one place the four writes record** (five until v55 retired the
state write and the reset and added the remove), inside the caller's
transaction, so they cannot differ in how: a **read** of the deck, answering `deck::GONE` for a
stale editor's dead id before any other sentence a dead deck could hear (`TOKEN_GONE`,
`ENTRY_GONE`); a read of every entry of the token in the list and of its state; the write; the
same read again; then, **only if something changed**, `touch_deck` (the gallery's *recently
touched*), one `deck_audit` row and one `deck_undo` step keyed on it. **The fence is a read and the
touch comes last** — `touch_deck` split in two — because its `UPDATE` stamps as it checks, and a
swap onto the entry's own art would otherwise move the deck to the top of the gallery for a press
that changed nothing. `write_tokens` wraps it in a transaction of its own for four of the
commands; `add_printing_in` calls it inside whatever transaction it was handed, which is what lets
`deck::add_card` and `collection_to_deck` reroute a token in theirs.

- **History is kind `deck` with `field: "token"`, and `AUDIT_KINDS` stays at nine** — asserted by
  `every_token_write_is_one_deck_row_and_one_step`. The deck notes' `{ field: "note" }` precedent,
  for a sharper reason than the rebuild a tenth word costs: `deck_audit` is synced and
  append-only, so a word a paired device's `CHECK` does not know would be refused there, and its
  applier defers the op. **On a v51 peer that loses it, and the sender's later ops in that page, for
  good**: a v51 client advances its pull cursor past a deferral, so upgrading brings nothing back.
  On v52 or later it **stalls that device's whole stream until it upgrades** — the delivery holds
  keep the cursor on a newer sender's deferral, and the relay's log with it — which is what this
  read before 2026-09-26 and is true again from v52 on, and is still a cost worth a sharper reason
  than a rebuild ([sync.md](sync.md) *Held while it can resolve, skipped when it cannot*). `deck` is
  already the deck-level kind, so no reader takes a token for a deck card. `delta` is 0 — the day
  header's `+7 / −6` adds up cards — and the row names no card (`card_name` is `NULL`: a token is
  never a `deck_cards` row).
- **The payload** is `{ field: "token", action, name, subtitle, card_id, finish, list, from, to }`
  plus one extra per action, snake_case throughout. `action` is `quantity`, `swap`, `add` or, since
  v55, `remove` — and `state` or `reset` on rows written before v55, which `auditText.ts` still
  words; `card_id` / `finish` are the entry the row is about (the one a swap *landed* on) and
  `null` for `state` and `reset`; `list` is `null` for `state`, shared by both lists. **`remove`
  carries `oracle_id`, `set_code` and `collector_number`** — the printing as the drawer names it,
  *Removed Treasure's TMOM #12 printing*, read at the write because a history is read after the
  corpus has moved — with `from` the copies the entry held and `to` null. `add` records
  the entry's count before and after **and `quantity`, the copies added** — a second press on a
  held printing steps it by one, so `to` is not the number to word; `swap`'s `from` / `to` are
  `entry_facts` objects `{ card_id, finish, set_code, collector_number }`, read off the corpus at
  the write so the drawer can say which art without it, and the extra `folded` says it landed on a
  held entry; `reset` carries `entries`, how many went. **`name` and `subtitle` are written down
  at the write**, off `newest_printing`, because a history is read after the corpus has moved — and
  the subtitle is `deckTokens.ts`' `tokenSubtitle` **ported into Rust term for term**
  (`subtitle_of`), a second copy of that logic taken on so the drawer can tell two `Wurm`s apart;
  it is pinned against the TypeScript doc's own Treasure line and a Wurm.
  `auditText.ts`' `tokenLine` is the only thing that words it.
- **Undo is `Op::Tokens { restore, delete, states }`**, `deck_undo`'s sixth op, all three lists
  `#[serde(default)]`. Applying it deletes `delete` by grain, upserts `restore` on
  `DECK_TOKEN_PRINTING_GRAIN` to the recorded quantity, then puts `states` back (a `None` state
  deletes the row). A write records **every entry of the token in its list on both sides**, so
  the undo deletes what the write left and restores what it found — a swap's fold comes back as two
  rows — and `states` rides only when the state moved, because a quantity step that recorded the
  state it did not change would be refused later by a dismissal it never touched. `holds` checks
  each restore row is at its grain with the recorded quantity and each state row matches (a
  recorded absence has to be an absence). Rows are addressed by grain and never by id:
  nothing points at `deck_token_printings.id`, so a restored entry is a new row.
  `every_token_write_undoes_and_redoes_exactly`, `undoing_any_token_write_restores_the_deck_exactly`
  (twelve cases through `drive_cases_on`, with `snapshot` reading both token tables) and
  `undoing_a_token_write_the_deck_has_moved_past_is_retired`.
- **A mode change was `Op::Deck { token_mode }`** — `token_mode` is on `deck_undo::DECK_FIELDS`, an
  arrangement the reader chose, on the rail index's footing. The page writes no mode since v55, and
  the column stays on that list so that the steps already filed still apply (*`decks.token_mode`*,
  below).

### Rule 7: a token nothing makes any more is removed at zero and kept with copies, in two layers (v52, #671)

The reader: *"if you cut all cards that create a token, so a token is no longer needed in the deck,
simply remove all tokens of that type"*. `deck_tokens::reconcile_in(tx, deck, variants)` settles
every entry, in each list asked about, of a token that list no longer derives and **whose state is
`auto`**, and **answers a `Reconciled`** — the rows it deleted, and the states of the tokens it
kept, before and after — so the caller's step can put both back.

**Since [issue #671](https://github.com/Msgaihede/mtg-grimoire/issues/671) (2026-09-29) only an
entry at zero is deleted.** A token with copies — any entry above zero, in any list the pass walks —
is **kept, and becomes `manual`**, which is what the band's **Add printing** makes a token nothing
derives. The wall then draws it through `deck_token_rows`' hand-added tail with `derived: false`:
the red outline and the `NOT MADE BY DECK` badge. The issue's reason is the physical deck —
deleting the Treasures lost the one fact a reader needs after cutting Smothering Tithe, that three
Treasures are still sleeved beside it and should come out. **`manual`, and not a new rule for
`auto`**, because the state word is what every build reads: a peer on an older build leaves a
`manual` token alone, where an `auto` one with entries and no maker is exactly what its own reconcile
deletes and pushes to the group. The flip is written after every list has been walked, so a token
kept in one list still loses its zero entries in another list that does not make it either
(`a_kept_token_still_loses_its_zero_entries_in_the_other_list`), and the states ride the card
write's step through `push_removed_tokens`: one Ctrl+Z on the cut puts the card back **and** the
token back to `auto`. Adding the maker back by hand makes the token `derived` again — the outline
goes, the copies stay — but leaves it `manual`, so a later cut keeps its zero entries in a list
nothing makes it, where they draw as a `0` tile the trash button removes. Pinned by
`a_reconcile_keeps_a_token_with_copies_as_the_readers_own`. A `manual`
token is never taken — no card made it, so no cut can unmake it — **and since the final review of
v55 nor is a `hidden` one**: `deck_token_rows`' hand-added tail draws any state but `auto`, so a
pre-v55 dismissal of a token nothing makes is on the wall like a `manual` one until `retire_hidden`
settles it at the next launch, and a reconcile that took its entries would delete what the wall is
drawing, capture the deletes for the group and, from the backstop, file them on no undo step. (Until
then this read *a `hidden` token is taken like any other: a dismissal is still a token the deck
makes, and once it is not, it has nothing left to be dismissed from* — true while a dismissal hid
the token.) `a_reconcile_keeps_a_dismissed_token_nothing_makes`. Cutting the card and adding it back
brings an `auto` token the reader never used back as its implicit entry. **A reconcile after every card write and never a
read-time rule** — reading
around a stale entry would leave it in the table, and in PR 3's Collection mode (dropped on
2026-09-27, before it was built) its copies in the
deck's folder, which is the stranding the rule exists to prevent.

**Where it runs was settled by a census of 18 writers (2026-09-26), in two layers:**

- **Inside the write's own transaction, for every writer that files a step**, so the deletions ride
  that step and one Ctrl+Z puts back the card **and** the reader's printings: at the two shared
  choke points `deck_undo::record_cells` (over `variants_of(cells)`) and `record_variant` —
  adding, a quantity, clearing a pile or a list, a move, a printing swap, copying live into
  theory, importing — which append the rows through `push_removed_tokens` after the card ops;
  and by hand at the three steps built without them: `deck_meta::set_category_active`,
  `deck_meta::delete_category` (both lists each), and the theory switch (below).
  `cutting_the_maker_settles_its_tokens_entries_inside_the_cut`,
  `an_import_replacing_the_maker_removes_the_entries_and_undo_restores_them`,
  `switching_the_makers_pile_off_or_deleting_it_removes_the_entries_and_undo_restores_them` and
  `a_cut_that_reconciles_tokens_carries_them_on_its_own_step`.
- **After every write, as a backstop**, for the writers that file no step —
  `collection_alloc::collection_to_deck` and `deck_to_collection`, a sync apply, and **undo and
  redo themselves**. **Scryfall's `reconcile::apply` is covered one write late**: it takes the
  write connection through `sync::lock_db` rather than `with_write`, so no backstop runs after it,
  and the marks its `deck_cards` writes leave are reconciled at the next write that does come
  through `with_write`, on any deck. `sync::with_write` calls
  `reconcile_dirty_logged` after the write commits, which reads the managed wishlist's TEMP
  `managed_wishlist_dirty` table (filled by that module's triggers on `deck_cards`,
  `deck_categories` and `decks`) and reconciles both lists of each dirty deck, one transaction per
  deck, logging rather than failing — the reader's own write has already committed. ⚠️ **It runs
  _before_ `managed_wishlist::settle_logged`, not after**, because the settle empties the dirty
  table it reads; neither pass writes anything the other reads. **Its deletions sit in no step, so
  a redo does not bring back entries a post-undo reconcile removed** — the one cost of the
  arrangement, accepted rather than missed. `the_backstop_reconciles_a_cut_that_files_no_step`.
  **v55's token triggers mark a table of their own, and this pass does not read it.** The managed
  wishlist's Tokens subfolder has to re-settle after a token step, so `arm` gained triggers on
  `deck_token_printings` and `deck_tokens` — and they write `managed_wishlist_token_dirty`, which
  only `managed_wishlist::settle` reads and empties, never the card table above. A token write
  gives rule 7 nothing to do (it changes no card, so no list's derivation moves), and marked in the
  card table every stepper press on any deck would run a derivation over both of its lists for
  nothing.

**Three things keep it cheap and one keeps it safe.** A list with no entries of an `auto` token at all
is one indexed read and no derivation; a list is only derived when there is something it could
delete; and the deletes are **ordinary captured writes** — every device derives the same answer, a
delete that finds nothing is a no-op on the far device, and a captured delete keeps an undo's
captured restore meaningful there. ⚠️ **A list whose makers cannot all be read deletes nothing**
(`Derivation::unreadable`, above): it cannot prove a token unneeded, and **the one population where
every maker is unreadable is the one that would lose everything** — a device paired before its
first corpus download derives nothing from anything, and a reconcile there would delete every
token printing the reader has and push the deletes to the whole group.
`a_reconcile_over_a_list_it_cannot_read_deletes_nothing` is the pin, and a mutation removing the
guard turned it red. The cost is small and permanent: a deck whose maker names a printing absent
from the corpus — 3 or 4 printings corpus-wide — never reconciles that list.

**The theory switch moves the live list's entries rather than reconciling them away.**
`deck::update_deck`'s false → true switch pours the live deck into the plan, and the live list then
derives nothing — so a bare reconcile would have deleted the Treasure arts the reader chose instead
of letting them follow the deck that became the plan. The switch runs in this order:

1. **Both lists are reconciled first, and only then is the step's before-image read.** Every deck
   that never had a plan holds a theory copy of each old pick (the launch conversion makes one per
   list), and
   a plan with no cards makes no token, so rule 7 owes those entries' settling whatever the press
   does. Read into the before-image unsettled, an undo would put back an entry the `with_write`
   backstop would delete the moment the undo committed, and the redo — which checks that the
   deck still holds what the undo restored — would be refused for ever, with nothing on screen
   saying why. So those deletions ride no step, like every backstop deletion, and **one Ctrl+Z
   restores the live arts and the plan's copies, but not its entries at zero** — since #671 a
   plan's stale copy above zero is kept as `manual` by this first reconcile, so it is in the
   before-image and the undo puts it back.
2. `deck_theory::move_live_into_theory` moves the cards.
3. `move_live_tokens_into_theory` **deletes the plan's surviving entries** — after the reconcile
   those can only be `manual` tokens' — because `theory_is_empty` asks about `deck_cards` alone and
   moving a live entry onto a theory one at the same grain would fail
   `idx_deck_token_printings_grain` and the whole press; then it moves every live entry to
   `theory`. Replacing rather than folding is the switch's meaning: the deck the reader built *is*
   the plan.
4. Both lists are reconciled again, and the entries read again.

**The step records the net change** — `token_step(before, after)`, one `Op::Tokens` a side, after
the cards' `Op::Variant` pair — because a reconcile can remove a row the move has only just made,
and a separate "restore what the reconcile removed" op would put back a theory row that never
existed and make every redo fail `holds`; diffing rather than restoring everything also keeps
untouched rows from being reinserted under new sync uids.
`the_theory_switch_moves_token_entries_into_the_plan_and_undo_moves_them_back` and
`the_theory_switch_replaces_the_plans_stale_token_entries_and_undo_puts_them_back`, the second of
which runs the backstop's reconcile by hand between the undo and the redo, since a direct
`apply_reversal` bypasses `with_write`.

### A token is never a deck card: the reroute at `add_card` and `collection_to_deck` (v52)

**Adding or dropping a token, a double-faced token or an emblem anywhere a card can be added files
it as a token entry** (rule 5) and writes no `deck_cards` row. The routing is in Rust, **at the two
writes every add path ends in**: `deck::add_card` (the Add button, a drop on any pile, quick add,
the card menu's `Add to`, a drop on the sidebar's deck entry) and
`collection_alloc::collection_to_deck` (the Collection tab). Measured 2026-09-26: no drag payload
and no add call carries the card's `layout`, so a TypeScript router would have to thread it through
six call sites and would miss the seventh, while here the card's own row is at hand and the rule is
structural.

- **The question is `deck_tokens::printing_is_token(conn, card_id)`** — `is_token_printing(layout,
  type_line)` over the row: `token`, `double_faced_token` and `emblem` by themselves, **or** a
  `flip` / `reversible_card` printing whose type line, or any ` // ` face of it, begins `Token` or
  `Emblem`. A layout-only first cut let six real tokens become deck cards through `add_card`.
  Measured read-only with `node:sqlite` over all 118 610 rows of the debug corpus, gunzipping each
  `raw`: the keep rule's 78 `flip` / `reversible_card` token entries resolve to **six** printings
  (five `flip` Role tokens and the `reversible_card` Mechtitan); the same two layouts hold **127**
  rows, of which **7** are tokens, all 7 with a top-level `type_line` beginning `Token` and every
  face saying so too, and **0** rows saying `Token` on a face and not at the top — so the stored
  line is as good as the faces and costs no JSON parse. `legal_mask = 0` was rejected: it catches
  all 7 and one non-token `flip` besides, and "legal nowhere" is not "a token".
  `is_token_layout` survives as the first half only; `deckTokens.ts`' `isTokenPrinting` is the
  TypeScript twin, which the Storybook fake routes on.
- **A rerouted `add_card` answers `EntryChange { id: 0, quantity, removed: false }`** — `quantity`
  the entry's, and **`id: 0` a contract**: no deck card was made, so there is no row to mark as
  landed, and SQLite never numbers a row 0. The reroute sits right after the printing lookup,
  ahead of `add_card`'s own `touch_deck` and its category resolution (`journal_in` touches the
  deck itself), so no pile is invented for a token.
  `a_token_card_added_to_a_pile_becomes_a_token_entry` (with a `reversible_card` Role case).
- **A rerouted `collection_to_deck` moves no copy** and answers `MoveOutcome { entry_id: None,
  from_deck: None, deck_card_id: None, quantity: 0 }`. It sits after the deck's `GONE` and virtual
  fences and **before** `NOT_IN_DECK` — a deck never "plays" a token, so that fence would refuse
  every one. The entry is the row's printing in the row's finish, in the live list. The managed
  mode — the only one since v55 — touches the collection never; PR 3's Collection mode, which was
  to pull a token's copies from the pool, was dropped on 2026-09-27. **Unlike a card filed through
  that command, the token half files an undo step**, since
  `add_printing_in` journals like every token add and there is no custody half it could fail to
  restore. `filing_a_token_adds_a_token_entry_and_moves_no_copy` and
  `filing_a_reversible_token_is_rerouted_too`.
- **`deck_token_add_printing` refuses what the reroutes would never send** (`NOT_A_TOKEN`), so
  Lightning Bolt handed to the band's Add printing is a sentence rather than a hand-added "token"
  drawn on the wall. `adding_a_card_that_is_not_a_token_is_refused_and_writes_nothing` and
  `a_reversible_token_is_added_and_a_reversible_card_is_refused`.

### The launch conversion: v51's picks become entries, captured (v52)

**The v52 rung creates the table and converts nothing.** Every v51 art pick — a `deck_tokens` row
whose legacy `card_id` is set, one art shared by both lists — becomes entries in
`deck_tokens::convert_legacy_picks`, reached through a gate of two halves:
`convert_legacy_picks_at_launch`, which `schema::prepare_database` runs at **every** launch after
`capture::install` and before the finish repair below, **logged and left owing** on failure; and
`convert_legacy_picks_after_pull`, which `sync_engine::client::pull` runs behind every pull that
read everything. A device in no sync group converts at launch; a device in one converts behind its
pulls, and at launch only once one has landed (*A paired device waits for a pull*, below). Its
writes are **captured**, and that is the whole reason it is not in the rung.

⚠️ **Until 2026-09-26 the rung did the converting, uncaptured**, naming each entry
`<override uid>-<list>` on the argument that every device climbs over the same synced picks and so
derives the same rows under the same names. **A group with a device still on v51 broke that both
ways, and each break stalled a sync stream for good.** A pick made on the v51 device *after* another
device climbed was converted by the picker alone, when it climbed, under a name the first device had
never heard — so the picker's next count step reached it as a sparse `{quantity}` update for a row it
could not find: deferred, and the picker's whole stream held behind it. A throwaway two-device test
reproduced exactly that before the move (`deferred = 1`, the one op a `{quantity}` update for
`u-pick-live`). And a pick the v51 device *reset* left the converter the only holder of an entry,
whose own later steps stalled its stream the other way —
`an_art_reset_on_a_v51_device_after_the_conversion_leaves_nothing_deferred` went red with
`deferred = 1` against the rung-time conversion.
**An entry that announces itself with a captured insert cannot be unknown to a peer**: a peer that
derived it too merges on the uid, and one that did not builds the row from the put.

**A paired device waits for a pull**, and until the fifth review round of the day it converted at
launch like any other. A launch conversion is a conversion **before the device has heard its
group**, and a laggard's then silently reverted what an earlier climber had done since. A climbs,
converts a pick at 3 and steps the live entry to 5. B, still on v51, pulls A's batch and defers it —
a table it does not know, with A's clear of the pick held behind the entries — but its clock
observes every stamp in the batch, deferred ones included (`apply`'s `observe`). B climbs, converts
at launch, and inserts `<uid>-live` at the legacy 3 under a stamp later than anything A wrote; that
insert won every field last-writer-wins decides, so A's step — or a finish change, a theory-switch
move, a delete — was reverted on **both** devices.
`a_laggards_conversion_never_reverts_an_edit_made_since` is that scenario, and it went red (3 on
both devices, not 5) with the gate switched off. Behind a pull, B has applied A's entries and A's
clear first — ⚠️ **provided B did not pull at v51 during the window**: a v51 client steps past a
deferred op rather than holding it, so a B that did still holds the pick after it climbs and
reverts A the same way. The delivery holds that ship with v52 cannot reach back for that page; what
they do is make the proviso hold for every laggard on v52 or later, whose held page comes back and
applies before any advancing pull converts ([sync.md](sync.md) *Held while it can resolve, skipped
when it cannot*).
Otherwise the clear leaves no pick to convert, and a pick B re-made after it reaches case 3 below
as a **move** of the entry A named — a sparse update — never as an insert over it. The key is the
`sync_state` row `token_picks_ready` (`deck_tokens::PICKS_READY`), set by the pull half and never
cleared; a pull held behind a key rotation neither sets it nor converts, because its unreadable
envelopes may be exactly the entries and clears the gate waits for — and since 2026-09-27 neither
does any other held pull, on a newer device's page or on a parent a later page may still bring,
for the same reason: only a pull that advanced its cursor has heard everything.
The pull half runs behind **every** such pull, so a v51 peer's pick is converted on the pull that brings it rather than at the
next launch. `a_paired_device_converts_nothing_at_launch_before_its_first_pull`,
`an_unpaired_device_converts_at_launch`, and in `client`'s suite
`a_pull_that_lands_converts_the_legacy_picks_and_one_held_at_an_epoch_does_not`. **The cost**: a
paired device draws each unconverted token at its resolver's printing, not the art picked on v51,
until its first pull at v52 lands — seconds after launch where the relay answers, and indefinitely on
a paired device that completes no pull (a group with no membership, a relay it cannot reach).

Per pick, per list, in `(deck_id, oracle_id)` order:

1. **The list already holds the token at the picked printing, in any finish** — it keeps what it
   holds. The finish repair may have moved an earlier conversion to `foil`, or a reader on v52 added
   the printing; a second row would be a second entry for one art.
   `a_list_already_holding_the_picked_printing_in_any_finish_keeps_it`.
2. **Another token's entry holds the grain** — skipped. `deck_tokens`' grain is `(deck_id,
   oracle_id)`, so two tokens of one deck can have picked one printing (a double-faced token carries
   two), and the pick first in **`oracle_id` order, never rowid** has it. Every device sorts one
   synced row set alike, so each keeps the same winner under the same name. The loser keeps its
   count as its token's implicit one and loses only the art.
3. **The entry this pick named at an earlier conversion is still there** — it is **moved**: a v51
   device re-picked after the conversion — this device's, or a peer's it has applied — `apply`
   wrote the new `card_id` onto the legacy column, and the pass behind that pull rewrites the
   entry's printing — and its finish, to the new
   printing's default — in place: same row, same count, same name, so the captured update lands on
   every peer holding it.
   `a_pick_that_arrives_after_the_conversion_moves_the_entry_it_named`.
4. **Otherwise it is inserted**, named `<pick uid>-<list>`, at `max(coalesce(quantity, 1), 0)` —
   floored because `deck_tokens.quantity` is a synced field with no `CHECK`.

**A pick with no uid of its own is named before any of that** — only a write behind
`capture::suppressed` leaves one, and the insert trigger's own mint is written onto it
(`sync_uid` is on no capture spec, so that is no op). Its clear is then written **uncaptured**, and
that is deliberate: a pick never announced under any name has no peer that could find a sparse
`{card_id, quantity}` update for it — the op carries no grain term — so a captured clear would defer
on every peer and hold this device's stream there for good. Its entries are announced whole like any
other's. Until the fifth review round such a pick's entries took a random uid each and its captured
clear put the NULL uid into `sync_ops.uid NOT NULL`, failing the whole pass on a paired device;
`a_nameless_pick_on_a_paired_device_is_named_and_stalls_no_peer` holds it on the capture-live
fixture, peer included.

**Every case files the printing's own `default_finish`**, read from the corpus — the resolver's
function, so a converted Treasure lands in the finish an implicit entry was already drawn in: a
foil-only printing converts straight to `foil`. The retired rung wrote `nonfoil` for every art and
left the repair to correct it, only because no rung reads the corpus; the launch pass runs after
`migrate_corpus` and can. What that buys is sync, not just a first draw: every device whose corpus
holds the printing announces **identical content** under one name, so no conversion hands a peer a
`nonfoil` put that lands after that peer's repair and writes the guess back, or that misses a
repaired entry on the grain and lands beside it as a second row. **Only where this device's corpus
cannot say** — the printing absent, its `finishes` unreadable, or no `cards` table to ask — does it
fall back to `nonfoil`, `default_finish`'s own answer for "no opinion", and the repair below is the
net for exactly those entries. `a_foil_only_pick_converts_straight_to_foil_and_the_repair_then_changes_nothing`
(on the capture-live fixture: the announced puts carry `finish: "foil"`, and the repair then moves
nothing) and `a_pick_whose_printing_the_corpus_lacks_converts_at_nonfoil`; the first went red, both
entries `nonfoil`, before the pass read the corpus.

Then every pick's `card_id` is cleared, and its `quantity` wherever an entry of its token now
exists — **all the entries first and the clears after**, so each clear rides behind an entry op in
the device's stream. A v51 peer defers the first op for a table it does not know and leaves the
sender's later ops in that page unapplied, so it never applies a clear ahead of its entry and goes
on drawing its art. This read "until it upgrades — the accepted new-table stall"; ⚠️ it is a loss,
not a stall: a v51 client advances its cursor past the deferral, so the entries and clears are
dropped and the art stays after the upgrade too. The delivery holds that make a new table a stall
again ship in v52 and run on the receiver, so they cannot help a v51 one ([sync.md](sync.md) *Held
while it can resolve, skipped when it cannot*).
(In a group of three or more it can lose that art early, cosmetically: a conversion finding every
list already holding the pick — a third device's announced entries — writes no entry op, and with
no other pick's entry ahead of it the clear reaches the v51 peer first.)
**One savepoint per pick, never one transaction for the file**: a pick whose entries or clear fail
is rolled back alone, written to stderr with its deck and token, and left set for the next pass,
while every other pick converts — before the fifth review round one failure (a case-3 move colliding
on the grain in the other list, say) rolled back the whole file at every launch.
`a_pick_that_fails_is_skipped_and_every_other_pick_converts` refuses one pick with a temporary
trigger. **Idempotent and cheap**: a cleared pick is never read again, so every later pass scans a
table of one row per deviated token and writes nothing, no op included
(`a_second_conversion_writes_nothing_and_announces_nothing`). The capture itself is
`the_conversion_announces_every_entry_it_derives_and_the_cleared_pick_behind_them`: two puts named
`u-pick-live` / `u-pick-theory` carrying the whole row, then the `deck_tokens` op clearing both
legacy columns. The two stalls are pinned end to end through `sync_engine::apply` by
`a_pick_made_on_a_v51_device_after_the_climb_converges_with_nothing_deferred` and
`an_art_reset_on_a_v51_device_after_the_conversion_leaves_nothing_deferred`.
**Two losses are accepted**, both confined to a v51 device's last days: a reset made there after
another device converted (argued as "the other device's entry reaches it after the upgrade, and
the reset has nothing left to clear" — a v51 client drops a deferral rather than holding it, so
the entry never reaches it),
and a count stepped there on a pick another device had already cleared,
which lands on the legacy column a converted token no longer reads.

### `repair_entry_finishes`, the net under the conversion

The conversion files each art in its printing's own finish and falls back to **`nonfoil`** only
where this device's corpus cannot say; a printing whose sold finishes change after its entry was
filed is the other case nothing could decide at write time. (While the rung converted, the repair
was the other half of *every* conversion: no migration rung reads the corpus, because
`migrate_user` runs before `migrate_corpus`, so the rung wrote `nonfoil` for every art.)
`deck_tokens::repair_entry_finishes` is that net, run from `schema::prepare_database` straight
after the conversion and, like it, **logged and left owing** on failure. It moves every entry whose
finish its printing is not sold in to the printing's
`default_finish` — its sole finish, for a foil-only or etched-only printing — and **folds** into an
entry the list already holds at that grain rather than failing the launch on the unique index. A
printing gone from the corpus, or whose `finishes` says nothing, is left alone. It can touch
nothing the reader chose, because the picker only offers a finish a printing is sold in.
**Idempotent**, so every later launch costs one read that finds nothing; and **behind
`capture::suppressed`**, `apps/desktop/src-tauri/CLAUDE.md`'s rule for a write every device derives for itself —
whether a printing is foil-only is a fact of *this* device's corpus, and a captured fold would
arrive on the other device as a second sum.
⚠️ **The entry keeps its row, and so its `sync_uid`.** The finish is rewritten **in place**
(`UPDATE … WHERE id`), and a fold is an `UPDATE` of the held row plus a `DELETE` of this one —
never a delete and a re-insert. The capture triggers' uid mint sits inside the guard `suppressed`
switches off, so a re-inserted row would come back nameless, and the next captured write to it —
a stepper, whose update trigger has no uid guard — would put a NULL into `sync_ops.uid NOT NULL`
and fail on every press from then on. Every device runs the same repair over the same rows, so the
name the conversion gave the entry stays the one every peer knows it by.
⚠️ **The walk is in `sync_uid` order, so a fold keeps the lower uid** — `sync_engine::apply`'s `min`
rule. Where one list holds two wrong finishes of one printing, both move to the one right finish:
the first moved keeps its row and the second folds into it. Walked in each device's own row order,
two devices could keep the entry under two names, each then holding a row the other's edits cannot
find. `the_finish_repair_folds_two_wrong_finishes_into_the_lower_uid` inserts the higher uid first
and went red (`u-b` kept) before the `ORDER BY`.
**Its one cost lives only on the fallback now**: a peer whose corpus lacked the printing announced
`nonfoil`, and that put landing after this device's repair, with a later stamp than this device's
own announcement, writes the guess back; the entry draws in the wrong finish until the next launch
repairs it again. A conversion on a device whose corpus holds the printing announces the right
finish, and the repair then has nothing to move.
`the_finish_repair_moves_an_unsold_finish_to_the_sole_one_and_is_idempotent` and
`the_finish_repair_keeps_the_entrys_uid_and_a_later_step_is_captured`.

### `retire_hidden`: every dismissal comes back at zero, at launch (v55)

**The dismiss went with the token-improvements spec §3.3, and a launch pass settles every
dismissal already on disk.** The reader's rule is the whole of it: *a dismissed token comes back as
an ordinary token at 0, its printings kept.* `deck_tokens::retire_hidden`, per token still `hidden`:

1. **Its entries go to 0 in both lists**, at the printings they name — rewritten **in place**, each
   keeping its row and `sync_uid`, `repair_entry_finishes`' reason: the next captured step on it
   names the row every peer holds.
2. **So does its legacy count**: `deck_tokens.quantity` becomes `NULL` where the row carries no pick
   and `0` where a v51 pick still waits for conversion. `write_state` alone keeps a legacy count, so
   a dismissed Treasure counted at 3 before v52 would come back at 3 in every list with no entries;
   and a paired device climbing from v51 runs this pass *before* the pull that converts its picks,
   so the `0` is what makes those entries arrive at zero rather than at the old `?? 1`.
3. **Its state becomes `auto` where the deck still makes the token** — in either list, since the
   state is shared — **or where it holds nothing**, and `manual` where it holds an entry (or a pick)
   nothing makes, through `write_state`. A dismissed Treasure the deck makes is then no row at all;
   a dismissed token nothing makes stays on the wall as the reader's own, at 0, in the lists that
   hold it; one nothing makes or holds is gone. That is the choice the retired `restore` made, by
   the same derivation.

- **A pass and not a rung**, because *does the deck still make it* is `derive`'s answer over
  `cards.raw`, and no rung reads the corpus — `migrate_user` runs before `migrate_corpus`.
  `schema::prepare_database` runs it after `repair_entry_finishes` (and, since the fan-in with
  `main`, after `deck_meta::refile_stray_theory_cards_at_launch`), through `retire_hidden_logged`:
  logged and left owing, because a dismissal not yet retired draws as an ordinary token anyway.
  **And then drains the marks every launch pass left**, the way `sync::with_write` drains a
  write's — `reconcile_dirty_logged`, then `managed_wishlist::settle_logged`. `settle_all` runs
  earlier in the launch and arms the connection, so the passes after it mark the decks they write
  and nothing read the marks until the first write of the session; on the first v55 launch that
  meant a theory deck following `all` or `tokens` built its Tokens subfolder from a dismissed
  token's counts, which the pass then zeroed under it (the final review's M2,
  `the_launch_files_no_managed_token_wish_for_a_dismissal_it_retires`).
- **Behind `capture::suppressed`**, `apps/desktop/src-tauri/CLAUDE.md`'s rule for a write every device derives
  for itself: each device retires the same synced rows over the same corpus to the same answer, and
  an announced zero would reach a peer still on v54 as a count nobody set there.
- **Idempotent, which is what an older peer's dismissal rests on.** A `hidden` that arrives by sync
  after the pass has run draws as an ordinary token — no reader treats the word as hidden — and is
  retired at the next launch; **every token write settles it sooner** (`settle_hidden`, inside the
  write's own `journal_in`, so it rides the write's undo step), because a step, a swap or a remove
  is the reader using the token — **clearing the legacy count as this pass does**
  (`clear_legacy_count`, step 2's statement), so the other list's implicit entry comes back at 0
  rather than at the dismissal's old count; an added printing clears it **before** the implicit
  entry would be materialised, so none is (the final review's deferred 1,
  `a_write_that_settles_a_dismissal_clears_its_legacy_count` and
  `an_add_that_settles_a_dismissal_clears_its_legacy_count_first`). A database with nothing
  dismissed costs one read.
- ⚠️ **A token the pass cannot prove unmade waits.** Where no list derives it and a list has a maker
  this corpus cannot read (`Derivation::unreadable` — a device synced before its corpus arrived),
  `manual` would be a guess, and a wrong one keeps the entries from every reconcile after the maker
  is cut. So that token is left as it is, for a launch whose corpus can answer: retired whole or not
  at all. One the deck provably still makes is retired whatever else in the deck is unreadable.
- **One savepoint per token**, `convert_legacy_picks`' shape: a token whose derivation or write fails
  is rolled back to its own savepoint, written to stderr and left `hidden` for the next launch.
- **One edge case says something not literally true, and was accepted.** A token dismissed while
  the deck still made it, whose maker is then cut before the next launch, is kept by the reconcile
  (a `hidden` token is not the deck's to take) and retired as `manual` at 0, so it wears the
  `NOT MADE BY DECK` badge — whose tooltip, *It was added by hand.*, the reader never did. Its
  count and printings are right; only that sentence is loose.

### The chin and the price, since 2026-09-26

The token-stacks work ([the spec](../superpowers/specs/2026-09-26-token-stacks-design.md) §3.3)
draws a token in a deck view's pile with the deck card's own `DeckCardFace` and `CardChin`, so a
row has to say what a deck card's chin says. `DeckTokenRow` gained six fields, **every one of them
about the effective printing** — `card_id` where the reader picked art, `default_card_id`
otherwise, the precedence the row's picture already followed. **Since v52 that is simply the entry's
printing**: a row is one entry, `card_id` is always its printing (the resolver's default for an
implicit entry), and the row also carries the entry's `finish`, its effective `quantity`, its
`implicit` flag and the token's effective `state` (`auto` where `deck_tokens` holds no row). The
six:

| field | what it is |
| --- | --- |
| `setCode` | the printing's set code |
| `collectorNumber` | its collector number |
| `setName` | the set's name — the chin's hover, since the code is what fits |
| `rarity` | Scryfall's word (`common`, `rare`, …) |
| `finishes` | the JSON **text** `cards.finishes` holds (`["nonfoil","foil"]`) — `packages/ui/lib/finish.ts`' `parseFinishes` input, not a second shape |
| `unitPrice` | what one copy costs in the asked marketplace, or `null` |

- **All six are `null` together when an entry's printing has left the corpus**, which is the
  picture's own answer for that case: a stored `card_id` whose `cards` row is gone draws no art
  and no chin rather than borrowing the resolver's. Where the entry *is* the resolver's printing,
  the row's own columns answer and only the price is an extra read.
- **Since v52 the price is the entry's, at the entry's finish, with no chain** — reversing PR 1's
  bullet that stood here. It goes through `sorting::price_expr(market, ?2)` with the finish bound
  as a parameter, which is how a `deck_cards` row that **names** a finish is priced: a foil
  Treasure is not priced as the nonfoil one, and a foil entry the marketplace does not quote reads
  `None` rather than borrowing the nonfoil rate. PR 1 (2026-09-26, before a token had a finish of
  its own) priced through `sorting::printing_price_by_finish_expr` — `nonfoil → foil → etched`,
  first priced link wins — exactly as a deck row that names **no** finish is priced, because a
  first cut at one *default finish* had read `—` on a printing whose nonfoil was unpriced while
  the same printing in the deck read its foil rate. The chain was right while the token named no
  finish, and the reason it was right is the reason it is gone: an entry always names one now.
  **The one case that moves** is an implicit entry on a printing listed nonfoil + foil with only a
  foil price — its default finish is `nonfoil`, so it reads unpriced where PR 1 read the foil
  rate; `an_entry_is_priced_at_its_own_finish_and_never_down_a_chain` pins the new rule and PR 1's
  test was rewritten. The foil-only case the chain existed for is unaffected, because such a
  printing's default finish *is* its foil (**13 515 foil-only and 892 etched-only printings have no
  nonfoil price at any marketplace**, `printing_price_by_finish_expr`'s own record, measured
  2026-08-15) — `a_foil_only_token_is_priced_at_its_foil_price`. **Which finish the chin _marks_**
  is the entry's own since v52, passed to `playedFinish` by the page; nothing in Rust answers it.
- **`None` where the marketplace has no figure — never `0`**, which the pile heading's sum would
  count as a free card, and never another marketplace's. Cardmarket's etched hole is
  `price_expr`'s and survives here unchanged.
- **Token prices never reach a deck total.** The one reader that sums `unitPrice` is the pile's
  own heading (`tokenPileHeading` in `views/TokenPile.tsx`); `deck_values`, the ledger and every
  other pile's heading read `deck_cards` and cannot see a token.
- **`DeckTokenRow` is `PartialEq` and no longer `Eq`**, because `unit_price` is an `f64`.
- **`packages/ui/lib/ipc.ts` mirrors all six and `ipc.test.ts`'s struct table holds `DeckTokenRow`**, so
  the two sides cannot drift field for field, and its `deck_tokens` case pins the three argument
  names.
- **The page puts the marketplace in the query key** (`["decks", "tokens", deckId, variant,
  marketplace]`), which reverses the *no marketplace in the key, nothing this answers is priced*
  that `features/decks/CLAUDE.md` carried — that file has the argument.

### `decks.tokens_open`, and the one thing it does not do

v37's second half is `decks.tokens_open INTEGER NOT NULL DEFAULT 0` — whether the editor's
**Tokens & emblems** area is expanded, per deck, beside `last_variant`, `last_group_by`,
`last_sort_by` and `separate_x_group`. It is on the `decks` capture `Spec` with those three, so it
travels the same way and for the same reason.

It rides `DeckPatch` / `DeckRow` / `DECK_SELECT` and reaches `useDeck`'s `update` with no per-field
arm anywhere, exactly as `separateXGroup` and `bracket` did. **`d.tokens_open` is the last
*named* column of `DECK_SELECT` and `r.get(21)` the last positional read in `deck_row`**, which is
not a style preference: that read is positional, and a column added anywhere but the end shifts
every later index into a field of the same SQLite type, silently — which is how `finish` (TEXT)
once landed in `needs_review` (TEXT).

**It writes no `deck_audit` row and no undo step, and it is not on `deck_undo::DECK_FIELDS`.**
`record_deck_edit` names the fields a history row is worth writing for and this is not one of
them — a disclosure triangle is not an edit to the deck — and with no history row `update_deck`
files no step either. What it *does* do, unlike `deck_set_view_state`'s three columns, is **move
`updated_at`**, because `update_deck` stamps that unconditionally: opening the token area lifts a
deck to the top of a gallery sorted by most-recently-touched. Worth writing down rather than
rediscovering, and cheap to change if it ever reads wrong.

### `decks.stats_open`, and the one number in it that is not `tokens_open`'s

User schema **v42** (2026-09-10, [issue #389](https://github.com/Msgaihede/mtg-grimoire/issues/389))
is `decks.stats_open INTEGER NOT NULL DEFAULT 1` — whether the editor's **Deck stats** band is
expanded. Everything in the section above applies to it unchanged and by construction: it is on the
`decks` capture `Spec`, it rides `DeckPatch` / `DeckRow` / `DECK_SELECT` with no per-field arm, it
was appended after `virtual_only` as the last *named* column of that select and the last
positional read in `deck_row` when it landed, it writes no `deck_audit` row and no undo step, and it
moves `updated_at` like every other `update_deck` write. **It has not been last since user schema
v43**, which appended `notes_open` directly after it, and later rungs have appended more columns
behind that — so read its position off `DECK_SELECT` and `deck_row`, never off this page. (This
paragraph said "the last named column … the last positional read" until 2026-09-28.)

**The default is the whole of the difference, and it is a decision rather than a copy that drifted.**
`tokens_open` is `DEFAULT 0`: that band was new when its column landed, so a collapsed default cost
no reader anything they already had. The stats band has been drawn under every deck since
2026-08-14 with **no control that hides it**, so `DEFAULT 0` here would not be a default at all —
it would be a feature silently removed from every deck in the database at the moment of upgrade,
which is the one thing a migration must never do quietly. `1` is today's behaviour exactly and the
disclosure is purely additive.

**Two places the number is written and they are not the same statement.** The `ALTER TABLE` in the
v42 rung is what every *existing* database gets; the column on `USER_SCHEMA_SQL`'s `decks` tail is
what a *fresh or converted* file is created with. They agree, and a reader changing one owes the
other — the ladder and the head constant are checked against each other by
`the_user_schema_is_byte_identical_to_what_the_ladder_builds`, which catches a shape mismatch but
not a default that disagrees with itself. The Storybook fake is a third: `toDeckRow`'s
`statsOpen: d.statsOpen ?? true` sits directly under `tokensOpen: d.tokensOpen ?? false`, and
copying the line above it is the bug.

### `decks.token_stack`, the setting that sat among the disclosures — dropped at v52

**User schema v52 dropped this column for `decks.token_mode`** (next section); what follows is its
record as it stood from v47 to v51, kept because the rung that dropped it, the capture spec's
history and `deck_undo.rs`' comments still name it.

User schema **v47** (2026-09-24, [issue #507](https://github.com/Msgaihede/mtg-grimoire/issues/507))
was `decks.token_stack INTEGER NOT NULL DEFAULT 0` — whether the deck views draw the deck's tokens
and emblems as a **Tokens & Emblems** pile (a trailing one until v51, below, made its place the
reader's), read as `DeckRow.tokenStack` and written as
`DeckPatch.tokenStack` on the ordinary `deck_update`. It is on the `decks` capture `Spec`, appended
after `notes_open` as the last named column of `DECK_SELECT` (read off `deck_row`, not off this
page), with `update_deck`'s next `?` hole. Like the three disclosures it writes **no `deck_audit`
row and no undo step** and is not on `deck_undo::DECK_FIELDS`; `DEFAULT 0` because the pile is new
and off is what every deck already showed.

**Where it parts company with them: `duplicate_deck` carries it.** Whether a band is open is where
the reader left a deck; whether the views draw a token pile is a setting chosen in Deck settings
about how the list is read — `separate_x_group`'s footing — so a copy reads the way its original
did. Rust stores the bit and nothing more: the pile is drawn in the view layer from the same
`deck_tokens` answer the band draws and never enters `deck.cards`, so it counts toward nothing.
Not on `DeckInput` — a deck is born with it off.

### `decks.token_mode`, which replaced it — retired from the page at v55, and kept in the schema

**Since user schema v55 nothing reads this column and the page draws no control for it**
([the token-improvements spec](../superpowers/specs/2026-09-27-token-improvements-design.md) §3.9).
PR 3, which was to give `collection` its custody, was dropped, and with every token at 0 until the
reader counts it there was nothing left for `Managed | Hide` to decide: `TokenModeControl.tsx` was
deleted, and the pile draws on every deck, the ones set to `hidden` included — which after the
default's move is the tokens their reader has counted and nothing else. **The column stays** — in
the schema, on the `decks` capture spec and on `deck_undo::DECK_FIELDS` — and the last of those is
the binding reason: **`apply` refuses any undo step naming a field that list does not carry**
(`deck_undo.rs`' `cover_image_path` note), so taking it off would break Ctrl+Z for every deck edit
made since v52. A peer on an older build still writes it, and `auditText.ts` keeps the `tokenMode`
wording for rows already on disk. What follows is its record from v52 to v54.

User schema **v52** (2026-09-26, [the token-stacks spec](../superpowers/specs/2026-09-26-token-stacks-design.md)
§4.1, §4.5) is `decks.token_mode TEXT NOT NULL DEFAULT 'managed' CHECK (token_mode IN
('managed','collection','hidden'))` — how the deck keeps its tokens. `managed` and `collection`
draw the Tokens & Emblems pile in the four views; `hidden` takes it out of all four and leaves the
band. It rides `DeckPatch.tokenMode` / `DeckRow.tokenMode` on the ordinary `deck_update` with no
per-field arm, and is refused in words for any other word (`deck::BAD_TOKEN_MODE`, *"A deck's
tokens are Managed, Collection or Hidden."*, checked by `valid_token_mode` before the transaction
opens).

- **The same rung dropped `token_stack` and added this, so the two were never two answers.**
  **Every deck starts on `managed`**, the ones whose stack was off included — the reader's answer,
  so after the upgrade every deck that makes tokens shows a pile — and `token_stack` is dropped
  rather than read, because neither of its values names a mode to keep. The drop is v43's move:
  `sync_upd_decks` reads `NEW.token_stack`, SQLite refuses `DROP COLUMN` on a column a trigger
  reads, so the rung drops the `decks` capture triggers first and `capture::install` puts them back.
- **`collection` is in the `CHECK` a PR before anything means it.** PR 3 gives it custody (the
  collection's Tokens pool), and carrying the word now means PR 3 adds a behaviour and a button and
  no rung. The page draws **Managed and Hide only**; a synced `collection` from a newer build
  presses neither button, and this build draws the pile for it as it does for Managed. A `CHECK` on
  a synced column is what `sticky_notes.color` refuses one for, and the difference is the same one
  `deck_tokens.state` stands on: these words are this app's model, and a fourth would be a rung,
  which moves every device together.
- **Positional reads did not move**: `deck_row` reads it in `token_stack`'s slot at **27** —
  a TEXT beside `managed_wishlist_mode`'s TEXT at 28, the trap `deck_row`'s comment records — so
  `IMAGE_COL` stays **30**; `DeckBefore` reads it at **18**, and `update_deck` binds it as
  **`?21`**, the hole `token_stack` used, so nothing renumbered.
- **Where it parts company with `token_stack`: a history row and an undo step.** `record_deck_edit`
  writes a `deck_audit` row with field **`tokenMode`** and the two words, which `auditText.ts`
  reads as *"Hid Tokens & Emblems"* / *"Set Tokens & Emblems to Managed"*; `token_mode` is on
  `deck_undo::DECK_FIELDS`, so a change files one `Op::Deck { token_mode }` step and Ctrl+Z puts
  the mode back. A mode is an arrangement the reader chose, the rail index's footing rather than a
  disclosure's. Re-sending the same word writes no row. `duplicate_deck` carries it, as it carried
  `token_stack`; not on `DeckInput` — a deck is born `managed` by the `DEFAULT`.
  `token_mode_round_trips_audits_and_undoes` pins the default, the patch beside `notes_open` (to
  catch a crossed `?21` or read at 27), the audit payload, the no-op re-send, the refusal, the
  duplicate and the undo.
- **On the `decks` capture spec under the new name**, v49's precedent: a v51 peer skips a field it
  does not know, where a word landing in its INTEGER `token_stack` would have failed its deck read.
  `a_decks_token_mode_is_captured` also asserts `token_stack` is off the wire.

### `decks.token_rail_index`, the pile's place in the rail — and the one of these that is undoable

User schema **v51** (2026-09-26, [the token-stacks spec](../superpowers/specs/2026-09-26-token-stacks-design.md)
§3.4) is `decks.token_rail_index INTEGER NOT NULL DEFAULT -1` — where the Tokens & Emblems pile
sits among the right-hand rail's piles, stored as **the number of rail piles drawn above it**, and
**`-1` for last**, which is where every deck's pile was before the column existed. v47's shape,
one `ALTER TABLE … ADD COLUMN`, on the `decks` capture `Spec` after `token_stack`, and owed its
`USER_SCHEMA_SQL` line and an `UNDO_V51` (prepended to every rewind chain; `main`'s `UNDO_V50`
sits between it and `UNDO_V49` once merged). **Written as v50 and renumbered before merging**,
because `main` shipped its own v50 first — `price_snapshots.copies`. It rides
`DeckPatch.tokenRailIndex` / `DeckRow.tokenRailIndex` and reaches `useDeck`'s
`update` with no per-field arm.

- **An index and never an anchor.** An anchor — "under the Sideboard" — would be a category id on
  a synced row, which needs the sync's `sync_uid` translation, and switching that pile on would
  take it out of the rail and send the tokens to the bottom for a reason the reader cannot see. A
  count needs neither. **What a count costs is a rail that shrank**, and the page answers that
  the only way that never loses the pile: anything not a whole number in `[0, rail length]` draws
  last (`tokenRailSlot` in `views/tokenRail.tsx`). Rust stores the number it is handed and clamps
  nothing, so a rail that shrinks and grows back puts the pile where it was.
- **`NOT NULL DEFAULT -1`, where the spec said nullable with `NULL` for last.** `update_deck`
  writes every field through `coalesce(?n, col)`, which reads a bound `NULL` as *leave it* — so a
  nullable "last" could never be written back once the reader had moved the pile. `-1` is a value
  and `coalesce` passes it through; the page stores last as `-1` and never as the rail's length,
  so a pile put at the bottom stays there when a pile is switched on or off later.
- **It was the one column of this family with a history row and an undo step when it landed**
  (v52's `token_mode`, above, is the second), and that is where it parts company with
  `token_stack`. A disclosure is where the reader left a deck and
  `token_stack` was a setting; this is an **arrangement the reader drags**, the footing a category
  reorder is on. So it is on `deck_undo::DECK_FIELDS` — a move files one `Op::Deck
  { token_rail_index }` step, the shape every other deck field's undo takes, and Ctrl+Z puts the
  pile back — and `record_deck_edit` writes a `deck_audit` row with the field **`tokenRail`**
  (`from` and `to` the stored numbers, `-1` meaning last), which `auditText.ts` reads as
  *"Moved Tokens & Emblems"*. A re-send of the same index writes no row. `duplicate_deck` carries
  it, as it carried `token_stack` and carries `token_mode`.
- **Positional reads moved, again.** `DECK_SELECT` appends `d.token_rail_index` after
  `d.managed_wishlist_mode`; `deck_row` reads it at **29**, and `IMAGE_COL` moved **29 → 30**.
  `DeckBefore` — the before-image `update_deck` audits against — reads it at **17**, and
  `update_deck` binds it as `?23`. `token_rail_index_round_trips_audits_and_undoes` pins the
  default, the read beside its neighbour, the exact audit payload, the no-op re-send,
  the duplicate and the undo; a mutation that took the column off `DECK_FIELDS` failed it at the
  Ctrl+Z assertion.
- **How the page spends it** — Stacks' drag and grip, Grid and Text inserting the pile at that
  place, Table not spending it at all, and the optimistic move — is
  [`packages/ui/features/decks/CLAUDE.md`](../../packages/ui/features/decks/CLAUDE.md)'s *Tokens & Emblems*.

### `decks.curve_creatures`, the Mana curve's creature split

User schema **v56** (2026-09-28, [the deck-stats band plan](../superpowers/plans/2026-09-28-deck-stats-band-redesign.md)
§3) is `decks.curve_creatures INTEGER NOT NULL DEFAULT 0` — whether the Deck stats band's **Mana
curve** draws each bar as creatures and noncreatures, the `Creatures` toggle in that card's header.
It is `stats_open`'s rules one control further in, and each of them is the reason for something:

- **Storage only on this side.** What a creature *is* (`deckBuckets.isCreature`, the front face's
  `typeBucket`) and how a split bar draws are TypeScript's; Rust keeps a boolean and never reads it.
- **On `DeckPatch`, not `deck_set_view_state`**, because a toggle a reader sets once and leaves is
  worth an `updated_at`, and it rides `DeckPatch.curveCreatures` / `DeckRow.curveCreatures` to
  `useDeck`'s `update` with no per-field arm, beside `statsOpen`.
- **No `deck_audit` row, no undo step, not on `deck_undo::DECK_FIELDS`** — how a chart is drawn is
  not an edit anybody reads a history drawer for. `the_curve_split_round_trips_and_is_not_recorded`
  pins the absence after a real edit in the same call, so the drawer is known to be reachable.
- **On the `decks` capture `Spec`, after `stats_open`**, so a split curve on one device does not draw
  whole on the next. `DEFAULT 0` is what keeps the old-peer direction safe: a v55 peer names no
  such field and the curve arrives unsplit, which is all it can have drawn.
- **`DEFAULT 0`, `notes_open`'s answer rather than `stats_open`'s** — the split is new, so off is
  exactly the chart every deck already drew and the upgrade changes nothing on screen.
- **`duplicate_deck` does not carry it**, the disclosures' note, so a copy's curve is unsplit.
- **Positional reads, at the end as always.** `DECK_SELECT` appends `d.curve_creatures` after
  `d.token_rail_index`; `deck_row` reads it at **30**, and `update_deck` binds it as `?24`. It is a
  `bool` over an `INTEGER` like the three disclosures, so a crossed index would hand the split to a
  band's open state with both fields still holding a `0` or a `1` — which is why the round-trip test
  moves it against `stats_open`, the neighbour that defaults the other way.
- **`UNDO_V56` drops the three `decks` capture triggers before the column** — v43's move in the
  rewind direction; [data-and-sync.md](data-and-sync.md)'s v56 paragraph has why.

### `decks.managed_wishlist_tokens`, the managed wishlist's tokens switch

User schema **v57** (2026-09-28, [issue #617](https://github.com/Msgaihede/mtg-grimoire/issues/617))
is `decks.managed_wishlist_tokens INTEGER NOT NULL DEFAULT 0` — whether a theory deck's managed
wishlist also files the token printings its plan is short of, in the **Tokens** subfolder. Until
v57 that was a fact about `managed_wishlist_mode`: `all` filed tokens, `missing` and `other` did not,
and a fifth word `tokens` filed them alone. So a reader who wanted their missing cards *and* their
tokens had no word for it. The mode is four words again (`off`, `all`, `missing`, `other`) and the
switch sits beside it in Deck settings, drawn only when the mode is not `Off`.

- **Stored whatever the mode says, acted on only when it is not `off`.** `managed_wishlist::eligible`
  answers `None` for `off` before it reads the switch, so a mode switched off and on again brings
  the tokens back with it.
- **`deck_theory::wanted(view, tokens)`** — the view is card rows only now (`DiffView` lost its
  `Tokens` variant), and `tokens` adds `token_diff`'s rows under any of the three. **Since
  2026-09-29 the view decides how a token is compared**
  ([issue #675](https://github.com/Msgaihede/mtg-grimoire/issues/675)): `Missing` reads
  `token_diff` at `TokenPool::Name`, so a token row's `held_as_other_printing` is paid out of the
  deck's copies of any token **of that name** and the row wants `quantity −
  held_as_other_printing`; `All` and `Other` read it at `TokenPool::Oracle` and want the whole
  exact printing-and-finish shortfall. `Grouped::pool` is the pool key, separate from the wish's
  oracle id for exactly this. The Compare dialog's own **Tokens** tab is unchanged — it reads
  `TokenPool::Oracle`.
- **The mode's rules otherwise, each for the mode's reason**: on the `decks` capture spec after
  `managed_wishlist_mode`; a history row, `managedWishlistTokens`, booleans on both sides; on
  `deck_undo::DECK_FIELDS` beside the mode, so one Ctrl+Z puts a Save that moved both back whole;
  carried by `duplicate_deck` with the mode.
- **Positional reads, at the end as always.** `DECK_SELECT` appends `d.managed_wishlist_tokens` after
  `d.curve_creatures`; `deck_row` reads it at **31**, `update_deck`'s before-read at **19**, and the
  UPDATE binds it as `?25`. The neighbour at 30 is `curve_creatures`, another `bool` over an
  `INTEGER`, which is why `managed_wishlist_tokens_round_trips_audits_and_undoes` sets the two the
  opposite way in one patch.
- **The rung converts, uncaptured** — [data-and-sync.md](data-and-sync.md)'s v57 paragraph.

### Owed: known, parked, and not fixed

- **A pre-reroute deck-card row naming a token printing collides with a token entry in
  Compare** (found by the final review of user schema v55, 2026-09-27; parked). Before
  `deck::add_card` rerouted tokens (v52), a token added to a pile was an ordinary `deck_cards`
  row. Such a row still on disk, and a token entry at the same printing and finish, share one
  `deck_theory::group_key` — `grouped_diff` answers the card row and `token_diff` the token row,
  each correctly from its own tally (a card and a token never share a pool) — so the Compare
  dialog draws **two rows under one React key** (`rowKey` is the same `group_key`), and one
  **Send** of that key files **two wishes**, because `missing_to_wishlist` walks both arms and
  matches each against the one key in `only`. It needs pre-reroute data *and* an entry on the same
  grain, so it is rare; no code is owed until a reader has it. The fix, when one is, is to keep
  the two arms' keys apart (a token key the card arm cannot spell) rather than to fold the rows.
- **A write that settles a dismissal leaves the *other* list's stored entries at their old
  counts** (found by the re-review of v55's final fix wave, 2026-09-28; parked). `settle_hidden`
  and `add_printing_in`'s hidden → auto clear the legacy count (`clear_legacy_count`), but the
  entries the token holds in the list the write does not name keep the counts they had when it was
  dismissed — which `retire_hidden`'s step 1 would have zeroed, and now never will, because the
  state is no longer `hidden` for the pass to find. Example: the plan holds a dismissed Treasure at
  3, and in the gap before the next launch the reader steps the live one to 1 — Compare then wants
  2, and a deck whose managed wishlist follows All or Tokens files them as wishes. **Not fixed
  because** zeroing them inside the write needs an undo step covering both lists, where every token
  write's step today covers the one it names; and it happens only in the gap between a pre-v55
  dismissal arriving and the launch that retires it.

### A stale comment found on the way, and deliberately not fixed here

`search.rs:1252` claims token-only and memorabilia sets have no rows in `cards` at all, "because
`default_cards` holds nothing for them". **Measured false on 2026-09-07**: `set_type = 'token'`
joins **2 950** card rows and `memorabilia` **5 847**. It is not this feature's to fix and nothing
here depends on it being right; it is recorded so the next reader does not trust it.

---

## Notes: many to a deck, each naming any number of cards

User schema **v43**, 2026-09-10, [issue #447](https://github.com/Msgaihede/mtg-grimoire/issues/447),
reported through Discord. The design is
[the deck-notes spec](../superpowers/specs/2026-09-10-deck-notes-design.md).

**`decks.notes` is gone.** It was one `TEXT` column added at v8, drawn as a single `<textarea>` in
Deck settings, and it is replaced by `deck_notes` — many rows to a deck, each with a title, a
CommonMark body and a sort order — plus `deck_note_cards`, one row per card a note names.

### A card reference is a pointer the note holds, never a place the note lives

That is the issue's own sentence — *"the card should only serve as a reference"* — and it is what
decides the schema. Attachments hang off the **note**, so the notes list is the complete list by
construction and a note cannot become invisible by acquiring a card. The alternative shape, a note
filed under a card, makes the issue's requirement an extra rule to remember rather than a property
of the tables.

### A note names a card by `oracle_id`, never by `card_id`

`deck_tokens`' argument verbatim: a printing id means nothing on the far device's shelf while an
oracle id is Scryfall's and is the same everywhere. Three things follow, and each is a feature
rather than a consequence — a note survives the reader swapping printings; a note written against
the Theory list shows on the Live list and the other way round, because both hold the same oracle
id; and one note naming Lightning Bolt names it once, however many copies or finishes the deck
holds.

### …and *draws* one by `card_id`, which is a read-time convenience and nothing else

Added 2026-09-20 with the band's redesign, so that a note card can draw a **44×32 `art` crop** of
each card it names. `attachments_by_note` resolves a **representative printing** per attachment —
the printing **this deck holds** where it holds one, and any printing the corpus has otherwise —
and `DeckNoteCard` carries its `cardId` beside the oracle id and the name. (It carried `imageUris`
too until 2026-09-27; the crop is drawn through `mtgimg://` off `cardId` alone.)

**It is an answer and never a key.** Never matched on, never written, never synced, and
**honestly different between two reads of one row**: which printing wins moves with the deck's own
list, so swapping a printing changes the picture a note draws without changing anything the note
stores. `cardId: null` is the **orphan** — an oracle id the corpus knows no printing of at all —
and it draws the empty frame rather than a broken image. A card merely **cut from the deck** is
not that case and keeps its printing, because the fallback arm searches the whole corpus.

**No migration, and that is the point.** `deck_note_cards` is unchanged — the same columns, the
same `idx_deck_note_cards_grain` on `(note_id, oracle_id)` — so the synced-table census, its
`apply::Meta` rank of 14 and `deck_undo`'s `attachments` snapshot are all untouched. The redesign
that asked for the pictures added columns to a **read**, which is why it spent no schema rung.

### ⚠️ The printing is picked as a *row*, and the design's `min()` aggregates are not what shipped

The statement chooses one `cards` row with a correlated subquery and takes every column off
**that** row:

```sql
LEFT JOIN cards p ON p.id = (
     SELECT c.id
       FROM cards c
       LEFT JOIN deck_cards dc ON dc.card_id = c.id AND dc.deck_id = n.deck_id
      WHERE c.oracle_id = nc.oracle_id
      ORDER BY (dc.card_id IS NULL), c.id
      LIMIT 1
)
```

**The aggregate form is what the design document drew, and it had a real defect.** The spec's §5
keeps the `GROUP BY nc.note_id, nc.oracle_id` the statement already had and picks each column with
an aggregate of its own — `coalesce(min(c.name), nc.oracle_id)` beside
`coalesce(min(CASE WHEN dc.card_id IS NOT NULL THEN c.id END), min(c.id))`. **Those two agree by
luck rather than by construction**: every printing of one oracle card shares its name, so the name
aggregate cannot disagree with anything, and the spec is right that the `GROUP BY` costs no rows.
The picture was where the luck ran out, on the **third** column: `min(json_extract(c.image_uris,
'$.art'))` was a `min()` over a *different* column of the same joined group, free to answer **one
printing's id beside another printing's art**, with nothing in either build able to see it. The
picture columns left the read on 2026-09-27 with `DeckNoteCard.imageUris`, so what it selects now
is only the pair the aggregates would have agreed on — and the subquery stays, because a single `id`
makes that mismatch unrepresentable for whatever column is next taken off `p`, and the `GROUP BY`
goes away with it.

Four more things about it:

- **`ORDER BY (dc.card_id IS NULL), c.id` inside the subquery is the whole of the preference.**
  SQLite sorts `0` before `1`, so a printing the deck holds comes first and `c.id` breaks the tie
  — which is the deck's own printing where it has one and a plain `min(c.id)` where it has none.
  That is the spec's `coalesce(min(CASE WHEN dc.card_id IS NOT NULL THEN c.id END), min(c.id))`
  said as a **sort** instead of as two nested aggregates: same preference, same fallback, one
  expression, and a *row* at the end of it rather than an id.
- **The `GROUP BY` is gone and no row count moved.** The grain gives one `deck_note_cards` row per
  attachment to begin with, and `p.id = (scalar)` matches at most one, so the printing
  multiplication the aggregate was collapsing cannot occur. `min(c.name)` went with it and lost
  nothing: every printing of an oracle card shares its name, which is why `card_name` is still
  spelled as a `min()` one function over.
- **`LEFT JOIN`, so a card the corpus has never heard of is still an attachment**, named by its
  own oracle id. The reference is soft like every other card reference in a user table, and a note
  that refused to load because a printing has not been synced yet would be a note the reader
  cannot reach.
- **`cards(oracle_id)` is indexed** (`idx_cards_oracle`), which is what keeps the subquery from
  being a scan per attachment.

**The rows come back in card-name order** — the statement ends
`ORDER BY nc.note_id, coalesce(p.name, nc.oracle_id), nc.oracle_id` — and that is load-bearing on
the near side rather than cosmetic: `NoteCard` draws the **first three** crops and counts the rest
as `+N more`, so the order decides which three a reader sees. An orphan sorts by its own oracle id,
which is the same string it is named by.

### The two tables, and why only one has a grain

`deck_notes` is **uid-only**, joining `decks`, the three folder tables and `deck_audit`. Two
devices each typing a note about the mana base must stay two notes, and there is no column pair
that could tell an accidental duplicate from a deliberate one — a title grain would silently fold
two readers' separate thoughts into whichever arrived second.

`deck_note_cards` carries `idx_deck_note_cards_grain` on `(note_id, oracle_id)` for the opposite
reason: two devices attaching Lightning Bolt to the same note describe **one** fact, and without
the grain both rows land and the card modal reads two notes where there is one. Its parent on the
wire is the **note**, not the deck, which is why its `apply::Meta` rank is 14 and sorts after the
note's 13.

### `decks.notes_open`, and why its default is v37's answer and not v42's

`DEFAULT 0` — the band opens shut. The two rungs asked the same question and answered it opposite
ways, and which one applies turns on whether the upgrade changes what is on screen. v42 gave
`stats_open` a `DEFAULT 1` because the stats band was already on screen for every deck on every
disk, so a `0` would have closed a band the reader had been reading for months. The Notes band is
new: no deck has ever shown one, so a collapsed default takes nothing from anybody, and
`tokens_open` at v37 is the precedent character for character.

### ⚠️ The rung has to drop three triggers before it drops the column

Capture triggers are **persistent** objects — the sync engine writes real `CREATE TRIGGER`s, not
temp ones — and `sync_upd_decks` reads `NEW.notes`. SQLite refuses `DROP COLUMN` on a column a
trigger **reads** — measured on the bundled 3.53.2 on 2026-09-26, a column named only in an
`AFTER UPDATE OF` list drops cleanly, which is what this paragraph wrongly gave as the reason
before — so the rung drops `sync_ins_decks`,
`sync_upd_decks` and `sync_del_decks` first and `prepare_database` reinstalls them on the very
next line. That is **v33's** move rather than a new one, and it is invisible in any test that
starts from a fresh database: a fresh file has no triggers yet, so only a real upgraded file
fails.

### ⚠️ `IMAGE_COL` stays at 27, and every read between 12 and 26 moved

`DECK_SELECT` maps by position. Removing `notes` at column 12 shifts fourteen reads in `deck_row`
and nine in the before-image mapper down by one, and moves `update_deck`'s `?9`–`?20` — including
`cover_kind`'s `ELSE ?10`. But appending `notes_open` puts the last column back where it was, so
`IMAGE_COL` reads **27** before and after. The one constant a reader would check to decide whether
the read had moved is the one number that did not.

**`deck.rs`'s `IMAGE_COL` is gone since 2026-09-27**, with the image tail it pointed at and every
list DTO's `imageUris`, so each `IMAGE_COL` figure this page records for `DECK_SELECT` is a rung's
history rather than a constant to read. The statements that still append
`image_uri::front_face_selects` declare their own, and `grep -rn "const IMAGE_COL" apps/desktop/src-tauri/src/`
is the census.

### The eight commands

| Command | Answers |
| --- | --- |
| `deck_notes(deckId)` | every note on the deck in `sort_order`, each with the oracle ids it names and — per id — a card name and a representative printing |
| `deck_note_create(deckId, title, body, oracleIds)` | the new row |
| `deck_note_update(deckId, id, title?, body?)` | the updated row |
| `deck_note_delete(deckId, id)` | — |
| `deck_note_attach(deckId, noteId, oracleId)` | the updated row |
| `deck_note_detach(deckId, noteId, oracleId)` | the updated row |
| `deck_note_reorder(deckId, ids)` | — |
| `card_notes(oracleId)` | every note in **every** deck naming this card, each carrying its deck's id and name |

⚠️ **`deck_note_reorder` has no caller, and that is a stated gap rather than an oversight**
(2026-09-10). The command is complete on every layer the rest of them reach — the Rust write, its
history row, its undo step, its registration in `desktop.rs`, the `ipc.ts` wrapper and the
Storybook fake — and **no surface presses it**: the band draws its notes in `sort_order` and offers
no way to change that order. The issue asked for notes that can be added, managed and deleted
independently, and reordering was this plan's own addition rather than a request. It is left in
because deleting a working capability across six layers to remove one unpressed button is the
worse trade, and it is written down here because an unwired command is exactly the kind of thing a
green build never mentions. **What wiring it would take moved with the band's redesign**: this
said *two `RowAction`s in `DeckNotesPanel`, on `CategoryRow`'s up/down arrangement*, which was an
answer about a list of rows. The band is a masonry of cards now, where the next card is to the
right on one line and at the foot of the shortest column on the next — so a pair of up/down
arrows would name a direction the layout does not have, and the gesture a grid of cards wants is a
drag. The command is unchanged either way; only the size of the surface that would press it moved.

`card_notes` is the one read that is not deck-scoped, and it is what the card modal's `Notes` row
asks. A card opened from the collection, from search or from another deck still answers *what have
I written about this card*, which is the question that modal exists to answer completely.

**No command answers "which cards in this deck have notes".** The band already holds every note
and every note holds its oracle ids, so the marks are a `Set` built in TypeScript from a read the
page has already made. A second command would be a second source of truth for a fact in hand —
`Empty a list`'s rule for its two counts, one screen over.

**`deck_notes` reads in two statements, never N+1**: one over `deck_notes`, one `LEFT JOIN` from
`deck_note_cards` to `cards` across the deck's note ids, zipped in Rust. Where a `cards` row is
missing — an oracle id the corpus has never seen — the name answers as the oracle id rather than
failing the read. **It is still two statements now that each attachment also answers a printing**
— the preference is a correlated subquery *inside* the second one, not a third query and not a
round trip per card; *…and draws one by `card_id`* above has the whole of it.

### History rides the `deck` kind, and `AUDIT_KINDS` stays at nine

The payload is `{"field": "note", "action": …, "note": <title>, "card": <name or null>}` with
`action` one of `create | edit | delete | attach | detach | reorder`. **Six, and the sixth was not
in the design** — a reorder is a deck write and `deck_audit`'s rule is that every deck write
records a row, so `deck_note_reorder` records one with `note` and `card` both `null`. Its sentence
is `Reordered the notes`, which is `categoryLine`'s `reorder` arm word for word: the two lists
behave alike, so they read alike, and both name nothing because a reorder is about the list rather
than about any one row. **A tenth audit kind was refused**, and
not on taste: the vocabulary is inside a `CHECK`, SQLite has no `ALTER … CHECK`, so a new word
costs a full `deck_audit` rebuild — which under `foreign_keys=ON` fires `deck_undo`'s
`ON DELETE CASCADE` and silently empties the undo stack on every real launch while leaving it
intact in every test. v33 paid that price for a rename that had no alternative. A note does not
need to.

**⚠️ `auditText.ts`'s `case "notes"` stays in the file for good**, beside the new `case "note"`.
Audit rows are durable: every history row written before v43 still carries `field: "notes"`, and
deleting the arm would silently demote years of a reader's history to the default
`Changed the deck`. Neither arm ever prints the body — a note is a paragraph nobody wants in a
one-line history, which is what the old field's arm already said.

### Undo is a fifth `Op`

`deck_undo::Op::Notes { restore, patch, delete, attachments }`, mirroring `Op::Labels` field for
field. `restore` and `patch` are two lists for `Categories`' reason, and it transfers with full
force: `deck_notes.id` is a rowid alias, so deleting the highest-numbered note and writing a new
one reuses the number, and one list deciding by *is there a row at this id* would overwrite the
reader's newest note with the one they deleted. `attachments` rebuilds the whole set for the notes
in the step rather than a diff — the rows cascade away with the note, so an undo has to rebuild
them — and lands through `INSERT OR IGNORE` so a replay is idempotent. **No `#[serde(alias)]`**:
the aliases on `Op::Labels` exist only because v33 renamed something already written to disk, and
`Notes` has never had another spelling.

### The old paragraph is discarded, and that is a decision rather than an oversight

Nothing migrates `decks.notes` into a first `deck_notes` row. Decided by the repository owner on
2026-09-10 with the alternative on the table. What it costs is stated rather than hidden: a reader
who used the old field loses it, with no undo, at the upgrade.

### Dropping a synced column costs nothing on the wire

This is the first rung on either ladder to take a column off a capture spec, and the direction had
no rule written down. It turns out to need none. `apply::updates()` iterates the **local** spec's
field list and looks each name up in the incoming op, so a field a v42 peer goes on sending and a
v43 build no longer has is never visited — not an error, not a failed row, not a rolled-back
savepoint. Unlike an unknown *table*, a dropped *column* cannot stall that peer's stream.
`a_field_this_build_no_longer_syncs_is_skipped_rather_than_stalling` is that paragraph made
checkable, and it splices the field into a **real captured op** rather than hand-writing one,
because a v43 build emits no `notes` and a test that merely hoped the field was present would pass
while proving nothing. [sync.md](sync.md) carries the rest.

## Deck to-dos: titled lists, many to a deck, in `deck_todo_lists`

User schema **v59**, 2026-09-29, [issue #688](https://github.com/Msgaihede/mtg-grimoire/issues/688),
reported through Discord — which amends user schema **v58**,
[issue #672](https://github.com/Msgaihede/mtg-grimoire/issues/672), shipped the same day. The
design is [the titled to-do lists spec](../superpowers/specs/2026-09-29-titled-todo-lists-design.md),
and [the deck to-dos spec](../superpowers/specs/2026-09-29-deck-todos-design.md) still holds
wherever the newer one does not contradict it. The module is `deck_todos.rs`, `sticky_notes.rs`'
file shape: pure functions over a `Connection` first, the five command wrappers at the foot.

⚠️ **A to-do list is not a note, and since v59 it is shaped exactly like one.** A list has a title,
a body and a card in the band, which is a deck note's shape to the letter, and it shares the
notes' editor (`NoteEditor`'s checklist mode), their inline dialect and their card *look*. It has
no card attachments, no masonry drag, no Save button, no history row and no row in `deck_notes`. A
**deck note** is a row of `deck_notes`; a **deck to-do list** is a row of `deck_todo_lists`, many to
a deck; a **to-do** is one checkbox line of a list's body, with no id, no date and no sync uid of
its own; and **text** in a list — a heading or a paragraph of that body — is not a to-do at all.

### What v58 was, and the two decisions v59 reversed

#672 stored one checklist per deck as a column, `decks.todos TEXT NOT NULL DEFAULT ''`, with `''`
meaning the deck had no list, and argued that **one list to a deck is a column's shape**: a table
would have owed the synced-table census, a `sync_uid`, a uid index and perhaps a grain, while a
column inherited everything `decks` already had — the delete cascade, the change mask and the
capture trigger. The argument was sound for its premise, and #688 removed the premise. The owner
reversed two of #672's settled decisions on 2026-09-29:

- **One checklist per deck → several titled lists per deck**, drawn as cards the way deck notes
  are. Several to a deck is a table's shape, so the column became one.
- **Every line a to-do → a to-do document.** A body holds headings and paragraphs beside any number
  of task lists. Under v58 a line that was not an item read as an open to-do — the nothing-dropped
  rule's answer, for a body from elsewhere — and under v59 it reads as text.

`decks.todos_open` came through untouched. It is the band's disclosure, not a list, and it still
rides `DeckRow` and `DeckPatch` (below).

### The table

```sql
CREATE TABLE deck_todo_lists (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, sync_uid TEXT);
CREATE INDEX idx_deck_todo_lists_deck ON deck_todo_lists (deck_id, sort_order);
CREATE UNIQUE INDEX idx_deck_todo_lists_uid ON deck_todo_lists (sync_uid);
```

The shape is `deck_notes`' (v43), column for column where the two mean the same thing, so the
`sync_uid` on a line of its own and `sort_order` are that table's spellings rather than new ones.

- **`body` is in the dialect `todoMarkdown.ts` reads**: headings, paragraphs and task lists,
  blocks separated by one blank line. **An empty body is still a list.** v58's `todosText` stored
  an emptied checklist as `''` so the deck left the home widget; it is gone, because a list that
  holds only text, or only a title, is a list. What leaves the widget is a list with no *to-do*
  left to draw, which is TypeScript's conclusion.
- **`sort_order` is written and never rewritten.** A new list lands at the end,
  `max(sort_order) + 1`, and nothing reorders lists yet; the column is there so a later drag is a
  command rather than a rung.
- **No grain** — uid-only, as `deck_notes`. Two devices each creating a list on one deck while
  apart make two lists, which is what two presses of *New to-do list* mean.
- **A deck delete cascades**, and a deck undo restores no list, which is what the column did too:
  `deck_undo.rs` never carried `todos`.
- **`duplicate_deck` copies no list**, #672's reason kept: a copy would draw every open to-do in
  the home widget twice, and ticking one would leave its twin open. `todos_open` is not copied
  either, for the other disclosures' reason, so the copy starts with no list and a shut band.

### The rung converts in place, and names each row by derivation

The conversion runs **inside the rung, with capture off** — v53's `theory_pile_uid` move, not
v52's captured launch pass:

1. Every deck whose `todos <> ''` gets one row: title **`To-do`**, body the column byte for byte,
   `sort_order 0`, and both stamps the deck's own `updated_at`. A deck with an empty column gets
   none.
2. Its `sync_uid` is `schema::todo_list_uid(deck uid)` — lowercase hex of the first 16 bytes of
   SHA-256 over `deck_todo_lists/legacy/<deck uid>`. Every device in a group converts its own copy
   of the same deck's list and names the row the same way, so the next edit on any of them lands
   on the same row everywhere with nothing announced. **A deck with no uid gives a row with none**,
   and the rung does not fail on it; the mint names the row later, like any other.
3. `decks.todos` is **dropped** — after the three `decks` capture triggers, v43's move, because
   SQLite refuses a `DROP COLUMN` on a column a trigger reads. `capture::install` puts them back,
   reading no `todos`.

`UNDO_V59` sits at the front of every rewind chain — directly behind v60's `UNDO_V60` since
2026-10-07, which drops `sync_orphans` ([data-and-sync.md](data-and-sync.md)) and leads them now —
and lands on v58's exact shape: it drops the
table and both indexes, drops the `decks` triggers, and adds `todos` back as v58's `ALTER TABLE`
wrote it.

### It syncs as the eighteenth table

`deck_todo_lists` is on `schema::SYNCED_TABLES`, with a `capture::Spec` whose fields are `title`,
`body` and `sort_order` (parent `deck` → `decks`, `Absent::Null`, not soft) and an `apply::Meta`
with no grain; `todos` left the `decks` spec at the same rung. It owed the whole synced-table
census, `userTables.json`, `syncedTables.json` and `TABLE_KEYS` included — [sync.md](sync.md) has
the list, and `deck_tokens`' *A new synced table owes TEN registrations* says why it is longer than
it looks.

Last-writer-wins is **per field**, so a title edit on one device and a tick on another both
survive. What it cannot do is merge *inside* a body: **two devices editing one list's body while
apart keep the later write whole** — the cost v58 accepted for one document per deck, and the one a
deck note's body pays too. What v59 changes is the reach of it: two devices editing **two
different lists** of one deck no longer touch the same field at all.

⚠️ **The mixed-version cost.** A v58 peer's edits to `decks.todos` are ignored by a v59 device —
the field is off its spec, and *Dropping a synced column costs nothing on the wire* (above) is why
that is a skip rather than a stall. A v58 peer holds a v59 sender's stream on the unknown table
until it upgrades. The groups this app has are one reader's devices, and the cost ends at the
update.

### `todos_open`, and where the twins part

`decks.todos_open INTEGER NOT NULL DEFAULT 0` is v58's and is unchanged by v59.

- **It rides `DeckRow` and `DeckPatch`, as `notes_open` does.** `DECK_SELECT` appends
  `d.todos_open` last, `deck_row` reads it at **32**, and `update_deck` binds it at **`?26`**. The
  trap is its twin: `notes_open` at 26 is the other `bool` over an `INTEGER` for a band beside it,
  so a crossed index would open the Notes band where the reader pressed To-do. Read the numbers off
  `deck_row`, never off this page.
- **`DEFAULT 0`, `notes_open`'s reason**, and **no history row**: `record_deck_edit` has no arm for
  it, and `the_todos_disclosure_round_trips_and_is_not_recorded` pins that. Opening the band is
  still a `deck_update`, so it moves the deck's `updated_at` like every patch does.
- **`todos_open` syncs and `notes_open` does not.** The two are twins everywhere else, and this is
  the one place they differ. `todos_open` travels on `tokens_open`'s argument, which `stats_open`
  and `curve_creatures` already follow: a reader who opened the band on one device meant it about
  the deck. `notes_open` is on no capture spec.

### The five commands

| Command | Args | Answers |
| --- | --- | --- |
| `deck_todo_lists` | `deckId` | the deck's `DeckTodoList[]` in `sort_order, id`; `[]` for a deck that is not there |
| `deck_todo_list_create` | `deckId, title, body` | the new `DeckTodoList`, at the end; `DECK_GONE` for a deck that is not there |
| `deck_todo_list_update` | `deckId, id, title?, body?, expected?` | `()`, or a refusal (below); a `null` title or body is left as it is |
| `deck_todo_list_delete` | `deckId, id` | `()`, and `()` again for a list already gone |
| `every_deck_todo_list` | — | `DeckTodoListEntry[]` — every list whose body is not empty, with its deck's name, `archived` and `todosOpen`; `updated_at DESC, id` |

`DeckTodoList` is `{ id, deckId, title, body, sortOrder, createdAt, updatedAt }`, and
`DeckTodoListEntry` is `{ id, deckId, deckName, archived, todosOpen, title, body, updatedAt }`.

⚠️ **v58's three are gone, and one of their names came back meaning something else.** v58 had
`deck_todos(deckId)` (the band's body), `deck_todos_set(deckId, body, expected?)` (every write) and
a `deck_todo_lists()` that took **no** argument and answered one row per deck for the widget. v59's
`deck_todo_lists(deckId)` is the band's per-deck read, and the widget's gather is
`every_deck_todo_list`. A search of the history for `deck_todo_lists` finds both generations.

- **The read answers `[]` for an unknown deck**, v58's standing and `deck_notes::list_notes`': the
  read about the *deck* is what reports a deck gone, and a band drawn for one has nothing to show
  either way. The create is where a missing deck is refused.
- **Both reads are fallible**, where `sticky_notes`' read is not. A failed read that answered `[]`
  would draw *No to-do lists yet* over a reader who has some, and a card or the widget ticks
  against the body it read.
- **`every_deck_todo_list` answers archived decks too**, and leaves out lists with an empty body;
  whether an archived deck is drawn is the widget's *Include archived decks* switch, which
  TypeScript applies. `id` breaks the `updated_at` tie, because the stamp is whole seconds and two
  lists touched in one second are an ordinary state.
- **Registration is `lib.rs`' module map and `desktop.rs`' `generate_handler!`**, and a miss is
  `unknown command` at runtime with nothing red. No capability entry, because an app's own commands
  take none. The reads are `#[tauri::command(async)]` on a sync `fn`, `sticky_notes`' reason; the
  writes are `async` with `spawn_blocking` and `sync::with_write`, so they answer `db::BUSY` while a
  sync holds the connection. `ipc.test.ts` pins all five names and their arguments, and both
  structs are on its `plainMirrors` table.

### The compare-and-set, and why a tick needs it

`update_list` reads the stored row and writes in **one transaction**, so nothing can land between
the comparison and the `UPDATE`. It checks in this order:

1. **A list that is not there is `TODO_LIST_GONE`** — *"That to-do list is not there any more."*
2. **A list on another deck is `TODO_LIST_WRONG_DECK`** — *"That to-do list belongs to a different
   deck."*
3. **With `expected`, a stored body that is not exactly `expected` is `TODOS_CHANGED`** — v58's
   sentence kept, *"That to-do list changed since it was read. Try again."* — and a refusal writes
   nothing.
4. **A title and body both equal to the stored ones write nothing at all**: no `updated_at` on
   either row, no capture op, no mirror pass. The dialog flushes on blur and on close, so a write
   can carry exactly what is already stored, and one that changed nothing must not move the deck up
   the widget's *Last edited* order.
5. Otherwise it writes both columns and the list's `updated_at`, and moves the deck's `updated_at`
   in the same transaction.

All three sentences are `pub const`, `deck_notes`' convention, and TypeScript reads them verbatim.
v58 checked a missing **deck** first (`deck::GONE`), so a stale tick against a deleted deck said the
deck went; under v59 a deleted deck's lists cascade away with it, so the same tick finds the list
gone and says that instead.

**The dialog sends no `expected`.** It is the author's surface, and its autosave is the truth of
what the reader typed. **A tick always sends the body it parsed** — from a card in the band, which
ticks in place since v59, and from the home widget alike — because a tick is "flip the marker on
line *n* of *this* text", and the text can move under it: the dialog autosaving in another window,
the other surface's tick, or a sync apply. A line number against a moved body would flip the wrong
to-do, so a stale tick is refused and the surface reads the list again rather than guessing.

**Rust stores the text and draws no conclusion from it.** Which lines are headings or text, which
to-dos are open, how deep one is nested and which line a tick flips are all `todoMarkdown.ts`', the
crate root's boundary. A parser here would be a second implementation of that one.

### A write records nothing but the list and the deck's stamp

Create, update and delete each move the deck's `updated_at`, as a deck note does, so a deck the
reader just worked through reads as recently edited. **None writes a `deck_audit` row, a
`deck_undo` step or an `activity` row.** The dialog autosaves on every pause in typing, so one
history line per pause would bury every real edit in the drawer. The editor's own Ctrl+Z is the
undo, the call `sticky_notes.rs` made for the same reason. Three consequences follow:

- **A deck undo never touches a list.** No `deck_undo` op names the table, so Ctrl+Z on a rename
  does not take back the to-dos typed since, and a deck-level restore brings back no deleted list.
- **A tick is not undoable from the deck**, from a card or from the widget. Nothing in the deck's
  history says it happened.
- **A deleted list has no undo at all**, which is why both *Delete* on a card and *Delete list* in
  the dialog confirm first.

### The mirror renders identical bytes for it

`deck_todo_lists` maps to `DECKS_ONLY` in `mirror::watch::surface_of`, `deck_notes`' argument: no
mirrored file, export format or share names a list. Every write also moves the deck's `updated_at`,
and `decks` maps to `DECKS_AND_COLLECTION` because a deck's name titles its group folder in the
cabinet — so a list write still marks both surfaces and costs one mirror pass that renders identical
bytes, v58's cost unchanged. Step 4 above is why a flush that carries the stored text costs no pass
at all.

### A second window

v58 needed no entry, because the list was a column of `decks`. A table does: `deck_todo_lists` is on
`userTables.json` and `syncedTables.json`, and `crossWindow.ts`' `TABLE_KEYS` maps it to `DECKS`,
`["decks"]`. The band's key `["decks", "todos", deckId]` and the widget's
`["decks", "todos", "lists"]` both sit under it, so a write in one window reaches both in the other.
