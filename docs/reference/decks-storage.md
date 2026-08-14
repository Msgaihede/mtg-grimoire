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
- **Switching the theory list on _moves_ the live deck into it. It does not copy it.** The deck
  the reader has built **is the plan**, so it becomes the theory list — and `live`, what is
  actually sleeved up, **starts empty** and fills as they acquire the cards. The guard is the one
  it always was: only on the false→true _transition_, and only when the theory list is empty,
  because a plan the reader has already started is not something a re-press of the switch may
  pour the live deck over. Two things ride along in the same transaction. The deck's
  `last_variant` becomes `theory`, so the reader lands where their deck now is rather than on a
  blank page they did not empty. And the move **reallocates**: `deck_allocations` claims
  collection copies for `live` only, so cards that have just left the live list must release the
  copies they were holding — otherwise a deck with nothing sleeved up goes on reserving a binder
  it no longer plays from, and every other deck reads the shortage. **The rule this inverts was a
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
  which tab was open is not one; and it **reallocates nothing**. An unknown deck id is refused by
  name (`GONE`) rather than passed over silently — the editor is exactly where a deck deleted in
  another window is discovered.
- **`last_variant` is validated in Rust and the other two are not, which is the boundary rather
  than an omission.** `ALTER TABLE … ADD COLUMN` cannot add a CHECK, so none of the three carries
  one in SQL and the fence has to sit somewhere. `last_variant` is checked against
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
- **A deck card's unit price is that printing's nonfoil price at the marketplace the read was
  given** — a deck names a printing, not a finish, so nonfoil is the cheapest way to satisfy it.
  Built by `sorting::price_expr`, never by hand: for TCGplayer and Cardmarket that is the `usd`
  or `eur` key of the printing's `prices` blob, and for Card Kingdom and Mana Pool a lookup in
  `marketplace_prices`. `cards.price_usd` is a fallback chain and is never summed, here least of
  all. A deck-write readback with no marketplace of its own quotes `marketplace::stored(conn)`,
  so renaming a category does not answer a Cardmarket reader in dollars.
- **Owned is an allocation, never a decrement.** `deck::allocate_deck` deletes and rebuilds a
  deck's rows inside the caller's transaction, greedily and deterministically: `KIND_PRIORITY`
  (`commander, main, side, companion, maybe` — a tie-break preference only, since `is_active`
  decides what is allocated for) then row id, and within a card, exact printing, then real
  copies, then oldest entry. It runs on **a card write, the Built toggle, `missing_to_wishlist`,
  `set_category_active`, `delete_category`, `commit_import` or the theory list being switched
  on** — those seven and nothing else,
  which is worth knowing while debugging, because pressing "Send missing to wishlist" or
  switching a pile off rebuilds a deck's allocations as a side effect. The theory move is the
  seventh and the least obvious of them: it empties `live`, and a claim held for a card that is
  no longer sleeved up is a copy no other deck can see. The import is the one
  that runs it for **many** cards at once and still only once, which is the whole reason
  `deck_import_commit` is a command rather than a loop over `deck_add_card`. A **built** deck's claims are subtracted from
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
  **25** cases, each carrying the number of rows it owes (count the list in `deck_audit.rs`,
  never a remembered number — it has been written down wrong twice). "Exactly one" is per
  _change_, not per call, and **two** commands make more than one change in a call:
  **`deck_update` records one row per changed field**
  (`record_deck_edit`, pinned by `a_patch_that_changes_two_fields_records_both`), and it
  satisfies that test only because every one of its cases changes exactly one field; and
  **`deck_import_commit` in `replace` mode records two** — a `remove` for what it cleared and
  an `add` for what it imported, which one signed `delta` cannot be both of. Its `merge` mode
  records one. Both use the existing `add`/`remove` kinds with an `import`-keyed payload, so
  there is no tenth `AUDIT_KINDS` value and no migration. The only
  command is the read, `deck_audit_list(deckId, limit)`, and its limit is `clamp(1, 500)` —
  **the low end is load-bearing, because SQLite reads a negative `LIMIT` as no limit at all.**
  It is append-only, never pruned and **not undoable**; `AuditDrawer.tsx` has no mutation in it.
  **Seven writes record nothing on purpose**: `delete_deck` (CASCADE takes the history with the
  deck, so a row would be orphaned by its own event); **both** `missing_to_wishlist` commands,
  `deck`'s and `deck_theory`'s (they write the wishlist, not the deck); `deck_set_view_state`
  (which tab the reader had open is not a change to the deck, and a history that filled up with
  them would bury the ones that are); and **three of the four
  folder writes** — create, rename and move — because a folder belongs to no deck and
  `deck_audit.deck_id` is `NOT NULL`. `deck_folder_delete` is the fourth and is **not** exempt:
  `decks.folder_id` is `ON DELETE SET NULL`, so it re-files N decks and writes one `folder` row
  per deck it un-filed.
- **`deck_create` makes a whole deck in one INSERT, not a name to be configured afterwards**
  (changed 2026-08-14). `DeckInput` carries `name`, `formatKey`, `description`, `notes`,
  `coverCardId`, `folderId` and `theoryEnabled`, because the "New deck" dialog now hosts the same
  settings form the settings dialog does and would otherwise be create-then-patch-then-setFolder:
  three transactions, and a half-made deck to roll back by hand the way
  `useDeckImport.importIntoNewDeck` has to. Four things about it that are **not** `deck_update`'s
  rules, each of which a reader who knows the patch will get wrong:
  **(1)** nothing here is written with `coalesce(?n, column)` — this is an INSERT, so an absent
  `folderId` genuinely is the top level and means it, where `DeckPatch.folderId` cannot un-file a
  deck at all (`deck_set_folder` is still the only command that reaches the root of an existing
  deck's tree). **(2)** `cover_kind` is not settable and keeps its DDL default `card_art`; a
  custom picture is `deck_set_cover_image`, which takes a **path** and a **deck id**, so it can
  only ever be a follow-up call. **(3)** `theoryEnabled` at create sets the column and **moves**
  nothing, there being no live cards to move — `update_deck`'s route runs
  `deck_theory::move_live_into_theory`, making the deck the reader already has into the plan and
  leaving live empty, and it does so only on the off → on _transition_. So a deck **born** with
  theory on has made that transition at birth, no later patch will ever move anything for it, and
  the reader's route is `deck_theory_copy_from_live`, which is unchanged. The two routes differ in
  what they *do* and agree exactly on what a new deck ends up with. **(4)** a deck's birth stays
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
  and **`duplicate_deck` carries it across** while `is_built` and `archived` still reset — what
  describes the deck comes over, what state the deck is _in_ does not, and a copy that read
  differently from its original would be a surprise nobody asked for. Rust stores it and does
  nothing else with it: which cards fall in the group, what it is called and where it sorts are
  `grouping.ts`'s, which is the crate's facts/conclusions boundary rather than an accident of
  where it was easier to write. **Two positional traps, both silent when got wrong.** The column
  goes **last** in `DECK_SELECT` and `deck_row` reads it at the **last** index, because a column
  added anywhere else shifts every later index into a field of the same SQLite type and nothing
  errors. **That index is not a constant and this document will not name it**: it was 15 when the
  column was written, and merging the view-state step's three columns underneath moved it — which
  is the trap itself, not a footnote to it. Read it off `deck_row`.
  And `update_deck` binds it as **`?12`, not `?11`** — that hole is `COVER_CARD_ART`, bound rather
  than spelled in the `SET` list, so a new column takes the next number at the **end** of the list
  and never the next one that merely _reads_ free.
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
- **The six single-card commands, and what each takes** (the seventh, `deck_import_commit`, is
  the bulk one and has its own bullet below).\
  `deck_get(id, variant)`;
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
- **`deck_import_commit(deckId, variant, mode, items)` is the seventh card command, and it
  exists for the allocator.** Looping `deck_add_card` from the frontend would be correct in
  every other respect and would run `allocate_deck` **once per line** — a hundred rebuilds of a
  deck's claims for one import. It runs it once, at the end, over the finished deck. "Once" is
  invisible in the result (the allocator is delete-and-rebuild, so N runs and one run leave
  identical rows), so `the_allocator_runs_once_for_the_whole_import` counts row changes through
  SQLite's `total_changes` instead: **43** for one run over 20 owned cards against **423** for
  one run per item, both measured 2026-08-12. Everything else is `add_card`'s shape held to
  deliberately — the same variant and `touch_deck` fences, the same `DECK_CARD_GRAIN`
  `ON CONFLICT` fold (so a list naming a card twice is one row with the sum), the same
  `category_for_name` find-or-create (so a `Sideboard` section lands on the seeded `side` row
  and makes nothing). `mode` is `merge` or `replace` (`deck_import::IMPORT_MODES`), and
  **`replace` clears the cards of the one variant it was given and leaves every category
  standing** — a category is the reader's filing, not the list's. An empty item list is refused
  in words (`NOTHING_TO_IMPORT`), which matters most in `replace`, where doing nothing and
  clearing the deck to put nothing back are the same call.
- **`deck_import_resolve` is the import's read half, and it answers the one question TypeScript
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
- **`deck_import_read_file` takes a path, not bytes**, which is the same contract
  `deck_set_cover_image` uses and the whole reason `dialog:allow-open` is sufficient and **no
  `fs:` permission is granted anywhere**: a webview that can only _name_ a file needs none. The
  1 MB cap (`MAX_IMPORT_BYTES`, shared with the paste path so the two cannot disagree) is read off
  the **metadata**, so a 200 MB file pointed at by mistake is refused without ever being pulled
  into memory. Decoding is `from_utf8_lossy` **deliberately**: a Windows-1252 apostrophe in one
  card name should cost that one name, not the other hundred lines — the `U+FFFD` it leaves bears
  no card's name, so the damaged line comes back quoted in the preview while everything else
  resolves. A `from_utf8` would answer `Err` for the whole file and name no line.
- **The TypeScript half decides everything a _deck_ decision is** (`src/features/decks/import/`,
  and its own [CLAUDE.md](../../src/features/decks/CLAUDE.md) carries the binding rules): one
  parser with per-line rules only, the pile from `autoCategoryFor`, the commander from
  `commanderIneligibility`. The one type that crosses for it is **`CardIdentity`, the card-level
  half of `CardFacts`** — everything true of a printing and nothing true only of a row in a deck —
  so eligibility can be asked about a card that is in no deck yet. **`CardFacts` was deliberately
  not narrowed to it**: the engine really does read `categoryKind`, `categoryActive` and
  `quantity`, so a card in a deck is more than a card, and every existing caller passes a whole
  `DeckCard`, which satisfies a `Pick` of itself.
- **Unverified, and not by choice: the file picker's own half.** `dialog:allow-open` opens a
  native window CDP cannot reach, so `deck_import_read_file` was exercised by invoking the command
  with a path — exactly as `deck_set_cover_image` was. The path → text → preview half is measured;
  the **click → path half is not**.
- **Driven in the shipped window 2026-08-12**, `npm run tauri dev` — so a **debug** build with
  Vite serving the frontend (`/src/main.tsx` in the page's script list, which is the cheap proof
  that no stale embedded `dist/` is being measured), the live 116 695-card corpus, 1280×800.
  The gallery path end to end: `Import deck` → paste `REFERENCE_LIST` → the box counts
  **105 lines · 117 cards** → name it and pick Commander → Preview → **117 cards · 6 categories**
  and **no problem list at all** → pick a commander → Import → the editor opens on the new deck.
  **That `6 categories` is the tally bug being measured, not the shipped behaviour**: the pile
  count was computed before the commander was chosen and never recomputed, so the same press
  today reads **7 categories** with a `Commander` row — see
  [the frontend's own rules](../../src/features/decks/CLAUDE.md) for the fix and the numbers.
  Read back through `deck_get`: **105 of 105 lines resolved** against the live corpus — 0
  unmatched, 0 hint misses, 0 parse issues — **105 rows carrying 117 copies**, and ten categories:
  the four `PREDEFINED_CATEGORIES` plus the six the import made (`Creature` 55, `Land` 38,
  `Artifact` 7, `Instant` 7, `Enchantment` 5, `Sorcery` 4) and `Commander` 1.
- **The two timings, both through `invoke` from the webview on that debug build**, medians with
  the first two runs dropped: `deck_import_resolve` over the 105-line reference list **120.4 ms**
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
  preferred an English printing you have not got would claim nothing from the binder; ahead of
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
  `newestWrite([...])` counts six of the hook's eight** — update (the rename, the cover, the
  Built toggle and the `Split X` chip, all four of which are the same deck-row write and
  therefore not four mutations), add-card, set-quantity, move, missing-to-wishlist,
  swap-printing. The other two are `setTag` and `rememberView`, and neither is a write to what
  is _in_ the deck.
  **There is no remove
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
    chip is a *deck* answer is unchanged and is now the reason both are: each says how _this_
    list is read.
  - **The audit sentence is right end to end**, which is the check that could only fail
    silently: the history drew *"Split the X spells into their own group"* and *"Folded the X
    spells back into their mana values"*. A `"xGroup"` that disagreed with `deck.rs` would have
    rendered `auditText`'s default arm — a plain "Changed the deck" — and gone unnoticed.
  - **The curve is the arithmetic, not an estimate.** Ten `<li>`s, the tenth reading *"1 card
    with X in their cost"*, the list **216px** wide at **18px** cells, and `scrollWidth ===
    clientWidth` — so the tenth bar fitted the 250px content box with no overflow, as derived.
    **Those two numbers are history rather than the current build**: the pass was driven against
    the 280px stats aside, and `main` moved the stats to a full-width band below the deck hours
    later. The cells are 20px again — see the bullet on the curve's width below. What the pass
    actually proved outlives the geometry: the derivation and the paint agreed to the pixel, and
    `scrollWidth === clientWidth` is the assertion that says a bar *fits* rather than merely
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
  `QuantityTag` is the card's **tag, in the tag's colour, with the copy count printed on it**, cut
  to a banner rather than a box, and down a fifteen-card stack that column of colour _is_ the
  structure of the pile. `TagDot` is gone from this surface and unchanged on the other three.
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
  this decides and `Uncategorised` is already the answer for not knowing. The pane's rows carry
  the **card's** type line, not the printing's — a `Printing` has none, and which pile a card
  belongs in is a fact about the card. A category column treats `"card"` exactly as the panel's
  `"search-card"`: add one copy. The remove tray narrows to `"deck-card"`, so a card from another wall never draws
  it. **The sidebar's Decks and Wishlist entries are drop targets**; Decks is inert with no
  deck open, which — because `setActiveView` clears `openDeckId` — is _every_ drag started
  from Search, Collection or Wishlist. So the sidebar's Decks target is reachable only from
  inside the Decks view (the docked panel, a deck card, the card pane).
