# src-tauri — the Rust core

**Rust owns data plumbing** (SQLite/FTS5, Scryfall sync, image cache, the `mtgimg://`
protocol). **TS owns domain logic** (deck validation, import/export parsing). Rust supplies
_facts_; TypeScript draws _conclusions_. Keep that boundary.

`cargo test` and `cargo clippy -D warnings` run from here; `npm run verify` at the root runs
both plus the frontend.

## Hard rules — database

- **`cards` is dropped and recreated on every sync** (`schema::swap_staging`, with
  `foreign_keys=ON`). So: user tables reference `cards.id` **without an enforced foreign
  key** — a soft reference plus denormalized `set_code`/`collector_number`/`lang`
  (spec §6). A declared `REFERENCES cards(id)` aborts every sync; `ON DELETE CASCADE`
  deletes the user's collection on the next refresh. Orphans are _flagged_, never deleted.
- Every index on `cards` goes in `schema::CARDS_INDEXES` — the swap drops the table with
  its indexes and replays only that list.
- `CARDS_COLUMNS` is **frozen**: it is what schema v1 created, not what `cards` is now.
  Add columns in a new `if v < N` step in `migrate` with `ALTER TABLE`. (`create_staging`
  derives its layout from `PRAGMA table_info(cards)`, so staging follows automatically.)
- **`raw` is a gzip BLOB from schema v3 on, and a bare `json_extract(raw, …)` is a hard
  error, not a NULL.** SQLite reads a BLOB argument to `json_extract`/`json_type`/
  `json_each` as JSONB; a gzip member is not valid JSONB, so the call raises
  `malformed JSON` and fails the whole migration for every user who has synced since v3.
  Any migration reading `raw` goes through **`schema::json_raw`** (Rust reads use
  `card_row::raw_json` with `CAST(raw AS BLOB)`). The guard must sit **inside** the
  expression, wrapping the _argument_ — never as a `WHERE` term, because the planner
  orders `WHERE` terms as it likes and evaluating the unguarded one _is_ the error. This
  is invisible to tests: fixture databases hold text `raw`, so an unguarded `if v < 4`
  passes every test and breaks only in the field. v2 and v3 are both guarded; the ladder
  is walked over a gzip row by
  `schema::tests::the_v3_backfill_steps_over_a_row_whose_raw_is_not_json`.
- `cards_fts` is **external-content with no triggers**. Any write to `cards` outside the
  ingest path needs `INSERT INTO cards_fts(cards_fts) VALUES('rebuild');` **if it touches
  an indexed column (`name`/`type_line`/`search_text`) or renumbers rowids** — and `VACUUM`
  does the latter, so it always needs one. A migration that only adds and fills unindexed
  columns does not (schema v2; `the_v2_backfill_leaves_the_search_index_answering` is the
  proof).
- Two connections: `AppState.db` writes, `AppState.db_read` is `SQLITE_OPEN_READ_ONLY`.
  Reads go through `db_read` so a search is not stuck behind an ~80 s ingest.
- `db::open` sets `PRAGMA auto_vacuum=INCREMENTAL` **before** `journal_mode=WAL` — after WAL
  has materialised the file the pragma is a silent no-op that only a `VACUUM` can apply.
  Databases from Plans 1–2 are converted once, after a sync, by `maintenance` (`compacting`
  phase); a `VACUUM` **always** needs `schema::create_fts` after it.
- Only `schema::migrate` may stop a launch. `prepare_database`'s other two steps (an FTS
  rebuild an interrupted compaction owed; the staging table an interrupted ingest left)
  are logged and left owing — their likeliest cause is a full or read-only disk, and
  `init_state` turns any error into "move `mtg.db` aside", which that disk cannot do.
- **A new migration step goes at the _bottom_ of the ladder, and takes the
  `CARDS_INDEXES` replay from the step below it.** `migrate` reads `user_version` **once**
  and then walks every block above it, so position in the file is the order of execution
  and the number is only the gate — a higher-numbered block placed above a lower one commits
  its version and then has the lower block write back over it. Only the newest step may
  create from `CARDS_INDEXES`, which describes the table _at head_; a step that _changes_ an
  index definition must `DROP` it first or the widening is a silent no-op on exactly the
  machines that need it. **A step whose DDL is not idempotent (`ADD COLUMN`, unlike
  `CREATE TABLE IF NOT EXISTS`) also owes a line in every rewind fixture in `schema.rs`'s
  tests** — those walk to head and undo the steps above the version they claim, so anything
  above them is replayed over them; that is what `UNDO_V12` and `UNDO_V13` are for, one named
  constant per rung. **And a version that has shipped is spent.** v12 and v13 were written the
  same day on two branches, each numbered 12 against a head of 11 — a collision `git` cannot
  see, because two `ALTER TABLE decks ADD COLUMN`s in two files conflict in neither. The one
  that landed first kept the number; folding the second into it would have left the column
  existing on fresh installs and on nobody else's disk, because a machine that already ran v12
  never runs it again. **It happened three times, not twice**: the oracle-tag step was a third
  branch numbering itself 12 against that same head of 11, and it is **v14**. Three collisions on
  one rung in one day is the ladder's own argument — take the next free number when you land, and
  never reuse one. Schema is at **v25** — `schema::SCHEMA_VERSION` is the answer, and
  [the ladder's history](../docs/reference/data-and-sync.md) is the story. (This line read
  **v18** for two whole rungs, then **v20** for two more, then **v23** for one and **v24** for
  one, because a prose-only edit routes to neither CI job: v19 added `deck_cards.finish`, v20 the
  art-tag tables, v21 the app-wide tag list, v22 the `slug_norm` repair, v23 the wishlist's
  folders, v24 the collection's and v25 the deck groups, and nothing went red for any of them.)
- **v24 and v25 are one spec's rung split in two, and the split is deliberate.** v24 creates
  `collection_folders` in its **final** shape — `kind` and `deck_id` columns and both partial
  unique indexes included — and files nothing into it. **v25 inserts the single `removed` folder
  and one folder per deck, converts every `deck_allocations` row into a placement, then drops
  that table, `decks.is_built` and the orphaned `app_meta` row `deck_driven_collection`.** One
  rung doing both would have taken out the app's only source of owned/missing while nothing had
  replaced it; creating the two unused columns early is what let v25 be inserts, a conversion and
  drops with no `ALTER TABLE` at all. **v25 is the first rung on this ladder that takes something
  away**, which is why the rewind fixtures have to put a table back (`UNDO_V25`) and why its
  tests start from a real v24 database rather than a fresh install — a fresh install has no
  claims to convert, so a test that starts there proves nothing about the conversion. See
  [collection-folders.md](../docs/reference/collection-folders.md).
- **The v25 conversion is in Rust and it clamps, and both are load-bearing.** It splits rows —
  one statement cannot create the placement and reduce the row it came from — and it takes
  `min(claim, row)`, because the old ledger could out-claim a row later stepped down and
  `owned_by_oracle` hid that by clamping at *read* time. Reading a claim literally would invent
  copies the reader does not own, permanently. Claims are converted **ascending by `id`**, which
  is first-claim-first-served: a claim was a reservation and could overlap, a placement is
  custody and cannot. And the placement **carries every provenance column** — condition, price,
  currency, acquired-at, source, serial, grading, tags, notes, `tradelist_quantity`,
  `created_at` — because the copies in the deck are the same physical cards, and a bare row would
  be the upgrade quietly deleting a history that took years to accumulate.
- **A step that writes to a table an older *forward-built* fixture never created fails on that
  fixture alone**, and v18 is the first one to do it. `schema.rs`'s `v1_database` and
  `v6_deck_database` are hand-written old schemas rather than rewinds, so they carry only what
  somebody thought to write down; v18 alters and re-seeds `format_specs`, which v5 creates and
  the v6 fixture had never had. Four tests failed with `no such table: format_specs` and none of
  them was about the new columns. The fix is the fixture, never the step — a "v6 database"
  missing v5's table is a pre-v5 database wearing a v6 label, which is the same argument that
  fixture's own comment makes about the five `cards` columns it replays.
- **A deck's platform is `decks.game_key` and a format's is `format_specs.games`** (schema v18),
  and neither is a rule Rust applies. `game_key` is one of `schema::DECK_GAMES`
  (`any|paper|arena|mtgo`, `'any'` a **sentinel** for `default_category_id`'s reason — `DeckPatch`'s
  `coalesce` reads a bound NULL as "leave it"), fenced by `deck::valid_game` in Rust rather
  than by a CHECK — **not because `ADD COLUMN` cannot carry one**, which is what this said until
  v19 added a checked `deck_cards.finish`, but because a command parameter reaches it and a
  refusal in Rust can say why. `games` is a comma-joined list of `schema::GAMES` written **only by
  `FORMAT_SPECS_SEED`**, so it needs no fence and gets a test instead. Rust supplies both facts;
  narrowing the format picker by them is TypeScript's, and **nothing in the crate compares the
  two** — a Modern deck may say Arena, and refusing that pair would be refusing a deck over a
  filter.
- **`FORMAT_SPECS_SEED` split in two at v18 and the halves must not disagree.**
  `FORMAT_SPECS_SEED_V5` is frozen history (`CARDS_COLUMNS`' rule — a fresh install replays v5
  long before v18's column exists); `FORMAT_SPECS_SEED` is head and carries `games`. Keeping one
  constant was not available in either direction: naming `games` in it fails at v5 on a new
  machine, and *not* naming it means the next migration that corrects any cell silently resets
  every format's platforms to the DDL default. `the_head_format_seed_agrees_with_v5_on_every_
shared_cell` walks both into two databases and compares them column by column.
- **`deck_categories.origin` says who made the pile** (schema v15) — `'auto'` the app, filing a
  card it had to invent a column for; `'user'` the reader pressing "New category", and the four
  seeded zones count as the reader's. TS hides an **empty** `auto` pile and always draws a `user`
  one; Rust records the fact and concludes nothing. **Four writers, each spelling its own answer
  rather than leaning on the DEFAULT** — and the count is of *writers*, so
  `collection_alloc::collection_to_deck`'s name arm added a fifth **caller** of the first and no
  fifth writer: `deck_meta::category_for_name` (`auto`),
  `deck_meta::create_category` (`user`), `deck_meta::ensure_predefined_categories` (`user`), and
  `deck::duplicate_deck`, which **copies** the source pile's answer — a copy has the same shape as
  its original, and defaulting there would make every auto pile in the duplicate draw empty. No
  CHECK — **not because `ADD COLUMN` cannot carry one**, which is what this line claimed until
  2026-08-17 and is false: v19's `finish` column adds one and it is enforced
  (`the_deck_card_finish_column_refuses_nonfoil` is the proof, and SQLite's documented ADD COLUMN
  restrictions are PRIMARY KEY, UNIQUE, a non-constant DEFAULT, NOT NULL without a default,
  REFERENCES without a NULL default, and GENERATED STORED). It has none because no command
  parameter reaches it — and, unlike `last_variant`, **no Rust fence either**: no command
  parameter reaches this column, so there is no untrusted value to refuse. **The reason it is a
  stored fact and not a name test**: `DECK_CATEGORY_GRAIN` is `(deck_id, name)` and
  `category_for_name` finds before it creates, so a reader's own "Ramp" keeps `'user'` forever
  even once the app files cards into it — and "Ramp"/"Draw"/"Removal"/"Land" are exactly what a
  person names their own piles. The v15 backfill is a **frozen one-time guess** (`kind = 'main'`
  plus the 22 names the rule could answer with on the day it shipped) and is deliberately not kept
  in step with TypeScript's list; **"Main deck" is not on it** — that is the v8 migration's pile
  and it holds real cards.
- **Each Tagger taxonomy lives in four tables plus a watermark, and there are two of them** —
  Oracle Tags at schema v14 (`oracle_tags`, `oracle_tag_parents`, `oracle_taggings`, the closure
  `oracle_tag_cards`, `oracle_tag_meta`) and Art Tags at **v20** (`art_tags`, `art_tag_parents`,
  `art_taggings`, the closure `art_tag_illustrations`, `art_tag_meta`). Keyed on the tag **slug**
  and on `cards.oracle_id` / `cards.illustration_id` respectively — all soft, no foreign key
  anywhere.
  **Two table sets rather than a `kind` column, because the join column differs**: an art tag is
  a fact about a *picture*, so a card with five arts has five illustrations and the dog is in one
  of them. One table would need a key that is an `oracle_id` on some rows and an
  `illustration_id` on others — a column no index can serve and no join can trust.
  `src/tags/` is the only writer, and it is **one engine with two bindings**: `mod.rs` holds the
  fetch, the parse, the graph walk, the staged write and the swap, parameterised over a
  `Dataset`; `oracle.rs` and `art.rs` are each a `const Dataset` plus that namespace's commands,
  and are the one place a taxonomy's tables, columns and weekly schedule are named. (It replaced a
  standalone `oracle_tags.rs` when the second dataset landed.) `query.rs` and `muted.rs` are
  shared and serve both. Each ingest streams its bulk file, flattens the hierarchy **once** into
  its closure (every tag a subject holds *and* every ancestor of those tags), and swaps four
  staging tables into place with the watermark in the same transaction.
  **`Dataset::carries_weight` is the one behavioural difference and `write_closure` is its only
  reader**: an art tagging's `weight` survives the fold — to the *strongest* weight the row
  descends from — because Scryfall means something by it there, and an oracle one's does not.
  **Rust stores slugs and nothing else** — no category names, no priority order,
  no whitelist; that is TS's half. Two read commands answer a whole decklist in one round
  trip: `oracle_tags_for_cards` keyed on `oracle_id`, and **`oracle_tags_for_printings` keyed
  on `cards.id`**, which is the one most call sites want — a quick add, every drag source and
  a resolved import line all hold a printing id, and `CardSummary` carries no oracle id at
  all. Both answer one entry **per requested id, in request order**, with an empty slug list
  for an unknown id, a NULL `oracle_id` and an untagged card alike: all three mean "fall back
  to the type line", and **nothing about categorising a card may fail a deck add**.
  Multiple parents are the normal case, not an edge: **684 of 4 521 oracle tags and 4 970 of
  11 531 art tags (43%) have more than one**, so `tags::ancestor_closures` follows *every*
  `parent_ids` entry and is the one place that decision is written down.
- **`oracle_tags` gained `id` and `slug_norm` at v20, and both are `NOT NULL DEFAULT ''` for a
  reason that reaches the read side.** `ALTER TABLE` cannot add a `NOT NULL` column without a
  default, so every row predating a refresh new enough to write ids carries `''` — which is why
  `tags::query`'s `not_muted` clause is `{alias}.id <> ''` and `tag_mute` refuses a blank id
  outright. Without both fences one `muted_tags` row with an empty `tag_id` would equal every
  un-refreshed row and take the **whole** oracle taxonomy off the page, with no error raised and
  nothing in `error_log`. **Neither staging twin carries the default** — both are bare `NOT NULL`,
  so an ingest that forgets a column fails at its first insert rather than writing a table of
  empty strings that indexes one value and matches nothing. The two spellings are on purpose: the
  live table needs the default to make the `ALTER` legal at all, and the staging table must not
  have one.
- **`slug_norm` had no such fence, and that shipped as
  [issue #180](https://github.com/Msgaihede/mtg-grimoire/issues/180): oracle tag search answered
  nothing at all on every database that predated v20.** `tags::query` matches a typed needle
  against that column and nothing else, and v20 argued the blank was never read because a refresh
  rebuilds the taxonomy wholesale — true only *eventually*, and
  `tags::oracle::REFRESH_INTERVAL_SECS` is a week. The **v22** rung recomputes it through
  `tags::normalize`, so the repair is offline and a machine that can never reach Scryfall gets its
  search back too. `id` is Scryfall's uuid, nothing derives it, and it stays blank until a
  refresh — which is what the fences above are for.
  **The general rule this cost us: a column added by `ALTER TABLE` whose only writer is an ingest
  is unset on every existing database until that ingest runs, so every reader of it needs either a
  fence or a backfill in the same rung.** Ask which population a `DEFAULT` is lying to — a fresh
  worktree is a fresh install and is the one population that cannot show it.
- **A tag slug reaching `filters::picked_tags` has never been typed, and `tag_resolve` is what
  keeps that true.** That function compares `slug` byte for byte and case-sensitively, on the
  stated grounds that a slug arrives from the tag search's own results rather than from a
  keyboard. The search box reads Scryfall's tagger syntax now (`o:ramp`, `-a:dragon`), so
  something had to give — either the filter SQL learns to normalise, or the typed name is
  resolved at the edge and the filter goes on receiving real slugs.
  **It is the second**, `tags::query::run_tag_resolve`: `slug` keeps one meaning throughout the
  crate, `index::facets` narrows by exactly the list the search does with no second copy of a
  normalisation to drift, and the caller learns *which* name was unknown — which SQL that quietly
  matched nothing could never tell it. It matches `slug_norm` (Scryfall's own rule: all four
  spellings of `spot removal` answer 4 907 cards, `otag:remov` 404s), it is **exact** where
  `run_tag_search` is a substring, it **ignores `muted_tags`** — the one read in that module that
  does, because muting is documented never to hide a card — and it refuses a blank needle outright,
  because `slug_norm = ''` matches a *whole taxonomy* on any database between v20 and v22. Full
  reasoning: [tag-search-syntax.md](../docs/reference/tag-search-syntax.md).
- **`muted_tags` is a user table and sits outside both `*_TAG_TABLES` lists** (schema v20) — it is
  the reader's answer about which tags they never want offered, and those two lists are what a
  refresh drops and rebuilds wholesale. It carries the namespace rather than being two tables,
  and it stores the `slug` it was given at mute time without ever joining the live taxonomy: a tag
  muted before a rename still lists, which is exactly what that column is for.
- **The tag indexes are replayed on every launch, outside the ladder, and that is not belt and
  braces.** `tags::query` counts a tag's reach with a correlated `count(*)` over the closure:
  **49 ms** with `idx_art_tag_illustrations_slug` and **531 seconds** without it — 11 531
  candidate tags against a 951 499-row scan each, measured 2026-08-20 on a release build. A
  database missing them does not get a slow Tags page, it gets a window that stops responding on
  the first keystroke in the tag box, and nothing about that symptom points at an index. So
  `migrate` ends with `TAG_INDEXES_SQL` (`CREATE INDEX IF NOT EXISTS` throughout) **from every
  version**, and it is fatal where `prepare_database`'s other repairs merely log.
- **Marketplace prices live in `marketplace_prices`, never on `cards`** (schema v11). `cards`
  is dropped on every sync, so a price column would be destroyed by the next refresh —
  and `card_id` there is a **soft** reference with no foreign key, because a feed and the
  corpus are collected on different days. `src/marketplace_feed.rs` is the only writer:
  Near Mint from both feeds, cheapest row wins a collision, and an unpriced finish gets
  **no row** rather than a zero.

- **A price filter is built where the marketplace is known, and there are two of them because the
  two lists price different objects.** `search::scope` bands
  `sorting::printing_price_expr(marketplace)` and `collection::scope` bands
  `sorting::price_expr(marketplace, ENTRY_FINISH)` — each the same expression its own list shows
  and sorts by, so a row inside the band can never be one the wall prices outside it. **That is
  exactly why the fields are not on `CardFilters`**, which is shared with the wishlist as well: a
  price field on that struct would have to carry SQL to mean anything, and the printing's
  `usd → usd_foil → usd_etched` chain prices a plain copy at its foil's rate whenever that is the
  only listing — right for a search over printings, wrong for a binder row that says which one the
  reader holds. So `SearchRequest` and `CollectionQuery` each declare their own pair, and the
  collection's is pushed in `scope` rather than in `list_entries` so the page, the full count and
  `summarise` cannot describe different rows.
  **An unpriced printing fails a bound end**, because `NULL >= ?` is NULL — a shop that does not
  quote a printing has not offered it for nothing. Two half-open bounds rather than a `BETWEEN`,
  so a reader who moved one end sends one predicate, and an inverted pair narrows to nothing
  rather than being silently reordered into a band nobody asked for.
  **It is not a facet dimension and the counts fail open under it** — see
  [search-faceting.md](../docs/reference/search-faceting.md) for why closing that is a price array
  per marketplace rather than a sixth bitset.
- **`rarities` is a field beside `rarity`, not a widening of it.** That one is single-valued and is
  what the printings modal's `<select>` sends; the search's chip row is a multi-select, and a
  control that can pick two has to be able to pick none — which for a `Vec` is `[]`, a value the
  single field cannot spell. `filters::picked_rarities` is the normalisation and it is **shared
  with `index::facets`** for `picked_sets`' reason: two copies of a normalisation that must agree
  will not, and a facet counted over a rarity the search dropped reports an option as live the
  search cannot reach. It lower-cases, because `cards.rarity` holds Scryfall's own lower-case word
  and SQLite's `=` on text is case-sensitive — a `Rare` bound as sent matches nothing and reads as
  an empty corpus.

## Hard rules — user data

- `collection_entries`/`wishlist_entries`/`card_migrations`/`deck_cards` reference `cards.id`
  **softly** and denormalize `set_code`/`collector_number`/`lang` (and `name`, on the wishlist
  and on deck cards) — as does `decks.cover_card_id`. A row whose card vanishes is **flagged**
  (`needs_review`, a sentence) and never deleted — `reconcile::sweep_orphans` runs after every
  ingest over all three user card tables and clears the flag if the card returns.
- Grain: `(card_id, finish, condition, lang, altered, signed, proxy, misprint,
  coalesce(serial_number,''), coalesce(grading,''), coalesce(folder_id, 0))` — **eleven terms
  since schema v24**, as `schema::COLLECTION_GRAIN`. One constant, because the UNIQUE index and
  every `ON CONFLICT` target must match verbatim. The `coalesce`s are load-bearing: NULLs in a
  UNIQUE index are distinct. `grading` enters identity as **raw text**, so it is only ever
  written through the one fixed-field struct that owns its key order.
- **The eleventh term is the folder, and it is what makes "Add to \<binder\>" an *add***
  (schema v24, the wishlist's fourth-term argument one table over). Without it, filing a printing
  the reader already owns would land on the row they already had and raise its quantity — the
  copies would appear to **move**, and a playset would collapse into whichever folder was pointed
  at last. `coalesce(folder_id, 0)` can never collide with a real folder because
  `collection_folders.id` is `INTEGER PRIMARY KEY`, which SQLite never *auto*-assigns 0 — so
  `create_folder` never supplies an id, and that is the whole of the fence.
  **The price of the term is the merge**: every write that lands on a taken grain sums and folds
  rather than refusing, through `collection::fold_entry` — the crate's one copy, which
  `collection_folders::merge_entry` and `reconcile::fold_into_existing` both call and neither
  re-spells. It stood at five statements while `deck_allocations.collection_entry_id` was
  `ON DELETE CASCADE`, so that a fold could not silently strip a built deck's claims; **v25 took
  the table and the three statements with it**, and no enforced foreign key points at
  `collection_entries` any more. What is left is sum into the survivor, delete the source — and
  the fold cannot move a deck's copies, because both rows share the folder that is the grain's
  eleventh term.
- **`collection_folders` is `wishlist_folders` ported, cascade rules included** (schema v24):
  `parent_id` CASCADEs onto its own table so a sub-tree goes in one press, and
  `collection_entries.folder_id` is `ON DELETE SET NULL` so deleting the cabinet surfaces the
  **cards** at the root — the strongest of the schema's SET NULLs, because a collection row is a
  card that physically exists. `collection_folders.deck_id` is a third action and CASCADEs, for
  `parent_id`'s reason and not the entries': a folder that *stands for* a deck has no meaning once
  that deck is gone. That SET NULL is a **backstop and not the mechanism** — it rewrites a grain
  term — so `delete_folder` collects the sub-tree and re-files every row **one at a time** through
  the same merge, inside the transaction and before the folder goes. **One at a time is what makes
  the collision that is actually reachable merge** instead of raising `UNIQUE constraint failed`,
  and which collision that is depends on the folder: for a *user* folder it is two rows from two
  **sub-folders** landing on one grain at the root, and for a **deck group** — `deck::delete_deck`,
  same loop — it is a printing already waiting in `Recently removed`. Two rows filed directly in
  one folder can never collide with each other, because they already differ in one of the grain's
  first ten terms, and no command can nest a folder under a group. `reset::clear_collection` sweeps
  the folders by hand for `clear_wishlist`'s reason **and rebuilds `Recently removed` and one group
  per surviving deck in the same transaction** — a swept-bare database is one where no deck can
  ever hold a card again, permanently, because those rows are a migration's and a machine at head
  never runs one. It still answers the count of *cards*.
- **A collection folder can belong to the app**, which is the one thing the other two cabinets
  have no equivalent of: `collection_folders.kind` is one of `schema::COLLECTION_FOLDER_KINDS`
  (`user|deck|removed`). Since v25 there is **one `removed` folder per database and one `deck`
  folder per deck, archived decks included** — both partial unique indexes enforce the "one",
  `create_deck` makes a group for every deck since, and every write in `collection_folders.rs`
  refuses to touch either kind: `FOLDER_NOT_YOURS`, in words, because the DDL CHECKs what a row
  *is* and can say nothing about who may edit it. `refile_entry` carries no such fence
  deliberately — that is what lets `collection_alloc`'s two writes and `delete_deck` file into
  exactly those folders, and the fence belongs to the *command*.
- **`collection_alloc.rs` holds the only pair that moves a row across the deck boundary**, and
  nothing else in the crate may grow a third. `collection_to_deck` takes copies out of a binder or
  **another deck's group** and writes the `deck_cards` row in the same transaction — **naming its
  pile by id or by name and never both** (`collection_alloc::Pile`, with `Pile::from_args` the one
  place the wire's two nullable fields become it and `BOTH_PILES` where both arrive). The name arm
  is `deck_meta::category_for_name`, inside the move's own transaction, so a pile the app has to
  invent is recorded `origin = 'auto'`; without it an owned add had to make the pile from
  TypeScript through `deck_category_create` and left the reader an empty heading marked as theirs.
  It refuses both where `deck::add_card` lets the id win, because there a drag carries both and
  here nothing does;
  `deck_to_collection` cuts a deck card and files whatever the group held into `Recently removed`.
  **Two writes in `deck.rs`/`deck_meta.rs` do the second of those in bulk and are not a third
  route**: `deck_meta::delete_category`'s cascade arm and `deck::clear_category` take a whole pile
  of `deck_cards` rows out at once, so the copies behind their `live` rows have to be released the
  same way — both go through `deck::release_group_copies`, and **so does `deck_to_collection`
  itself**: that walk is the crate's one copy, and the cut is it plus the `deck_cards` write, the
  history row and the `MoveOutcome`. Four rules it holds (absent group means "holds
  nothing", oldest row first, clamped at what the group holds, `Recently removed` resolved only
  when there is something to file), and a fifth that was a bug while it existed twice: **it
  matches on the oracle card, exact printing and finish first and any other printing of the same
  `cards.oracle_id` after**. `swap_printing` and `set_card_finish` rewrite a deck row's identity
  and touch no collection table, and the v25 conversion files printings the deck does not list,
  so an exact-only match strands copies under a deck that no longer lists them. It is
  `owned_by_oracle`'s "a Bolt is a Bolt" read from the other end. `delete_category`'s **move** arm
  releases nothing: those cards are still in this deck, one pile over. `deck::delete_deck` is the
  third such site and files the whole group.
  Six rules hold it together, each with a test:
  - **A deck group is not a drop target**, because a card reaches one only through
    `collection_to_deck`. A bare drag would go through `collection_set_folder`, which knows
    nothing about decks, and leave a placement with **no deck card behind it**.
    `set_entry_folder` refuses a `deck` or `removed` destination for exactly that.
  - **And the fence has a second end**: `set_entry_folder` refuses a row whose **source** is a
    `deck` folder (`ENTRY_IN_A_DECK`, a sibling of `FOLDER_NOT_YOURS` rather than a reuse of it —
    that one is about the destination folder, this one about the row). A copy dragged *out* of a
    group by hand leaves the deck listing a card whose copies have walked off, which is the same
    invariant broken from the other direction. `removed` is deliberately **not** fenced as a
    source — tidying the holding area into a binder is what that folder is for — and neither is
    `refile_entry`, which is the shared primitive every sanctioned way out of a group calls.
  - **Taking a copy out of another deck's group decrements that deck's live list**, oldest row
    first and clamped at what is there. The copies are custody, not a reservation, so a deck that
    loses them loses the card — reported in `MoveOutcome::from_deck` because the side effect lands
    on a deck the reader is not looking at.
  - **A deck card with no backing copies just goes away when it is cut**, and that is why no
    per-deck-card provenance flag was ever needed — the question
    [#209](https://github.com/Msgaihede/mtg-grimoire/issues/209) asked and could not answer. The
    group **is** the provenance record: a card added from search is an intention to buy, nothing
    in any folder is behind it, and cutting it puts nothing on the reader's desk.
  - **A theory row is refused** (`THEORY_HOLDS_NOTHING`). A plan holds no cards, so a press that
    reported success and moved nothing would read as a card that vanished.
  - **A cut records the history `deck_set_card_quantity` would have, and deliberately no undo
    step.** This command *replaces* that one for a decrease on the live list, so the `remove` /
    `quantity` row is copied verbatim — same payload shape, negative delta, the stored card name —
    and a deck's log reads continuously across a change of command the reader cannot see. It is
    recorded even when nothing moved, because the deck changed. The **step** is a different
    question: a cut changes a `deck_cards` row *and* a `collection_entries` row, `deck_undo`
    restores rows within a deck and touches no collection table, and a step carrying only the deck
    half would put the list back while the copies stayed in `Recently removed` — a deck claiming
    copies its group no longer holds, with the reader believing Ctrl+Z had worked. Half an undo is
    worse than none. The absence is visible because the Undo button's name **is** the change it
    would reverse, so it goes on naming the press before the cut — **which means a cut does not
    advance the undo cursor and the previous step stays the one Ctrl+Z will take**, so pressing
    it after a cut reverses the *older* change rather than the cut or nothing. The complete way
    back is `collection_to_deck`, which restores both halves at once, and **the deck builder's
    Collection Search tab is what calls it** (2026-08-23,
    `src/features/decks/useCollectionSearch.ts`): the cut copies are sitting in
    `Recently removed`, that tab lists them, and its Add button is the one press that files them
    back into the deck's group and writes the `deck_cards` row again. Until that tab landed the
    command had no caller at all and the way back was two presses done by hand — so a note here
    saying nothing calls it is now a note telling the next agent the feature does not exist.
    `deck::clear_category` reached the same conclusion for the same reason and does file a step,
    because its `deck_cards` half is a whole pile no stepper can rebuild.
  Every refusal is a **sentence** rather than a `CHECK` or a foreign-key failure —
  `deck::set_folder`'s rule, and `PRAGMA foreign_keys` is per-connection anyway. Both writes are
  one transaction: mid-move the copies are in both places or in neither.
- **"Does the reader own this?" is `collection_source`, and four fragments plus one write
  wrapper is all that module owns.** `owns_printing`/`copies_of_printing`/`copies_of_oracle`/
  `owned_rowids` are correlated SQL a caller splices into its own statement; `with_write_owned`
  is `sync::with_write` plus the facet index's `owned` rebuild, on success only. **Three
  statements name `collection_entries` themselves and are the sites to check whenever that
  table's shape moves**: `collection::from_sql`, which reads the entries as its `FROM` rather
  than asking a question about them, and `wishlist::OWNED_SQL` and
  `deck_theory::OWNED_SPARE_SQL`, which narrow by **finish** — something no fragment there does.
  Since v25 the second is a plain sum with a `kind` fence rather than a subtraction: **"spare" is
  a fact about where a row sits**, and the root, a folder the reader made and `Recently removed`
  are all spare while only a `deck` folder is not. The `folder_id IS NULL` arm comes **first**,
  because `<> 'deck'` over a NULL id is NULL rather than true and the root would otherwise drop out
  of exactly the list that is mostly root. `collection::Allocation::Unallocated` narrows the
  collection page by the same sentence, and the two are one rule read from two ends. The floor at
  zero went with the subtraction — a `sum()` over a `CHECK (quantity >= 0)` column has no
  arithmetic left that can produce a number with no reading.
- **`reset.rs` holds the only writes in the crate with no subject, and they belong there.**
  `collection_clear`, `wishlist_clear`, `decks_clear` and `cache_clear` name a *table* rather
  than a row: none takes an id and none can be scoped. Filing one beside the reads of its table
  would put it next to the deletes that each name **one row** and cannot be asked to take
  anything they were not pointed at — `remove_entry`, the unconditional one, plus the two
  conditional deletes schema v24 put beside it (`set_quantity`'s zero and `fold_entry`'s merge).
  **Nothing there writes history and nothing is undoable**:
  `deck_audit` and `deck_undo` are per-deck and cascade away with the decks they describe, so a
  wipe has nowhere to be recorded. The confirmation is the **webview's** and the commands take
  no `confirm` argument — a fence passed as a parameter is a fence a caller can forget.
- **Quantity 0 deletes the collection row, and this reverses what this file said until v24.**
  `set_quantity(id, 0)` deletes and answers `EntryChange { removed: true }`, the v24 rung deletes
  every stored zero row, and the importer's `set` mode does the same. `remove_entry` is no longer
  the only way a row goes. The reason is the folder: with `folder_id` in the grain, a row holding
  no copies is indistinguishable from a row somebody filed and emptied. **The cost is real and was
  accepted deliberately** — the row's `condition`, `condition_original`, purchase price and
  currency, acquired-at, acquisition source, notes and tags go with it, which is exactly what the
  old rule was preserving; a story that took years to accumulate no longer survives the day the
  card is traded away. `CHECK (quantity >= 0)` stays on the column: the guard is the command, and
  an intermediate zero inside a transaction is still legal. The wishlist has always been this way
  by table CHECK (`quantity > 0`) — a wish for none of something is not a wish — so the two tables
  now agree where they used to be a deliberate asymmetry. Both still refuse a negative through the
  one `collection::valid_quantity`.
- Finish is an **enum** (`nonfoil|foil|etched`), condition is one of `NM|LP|MP|HP|DMG`; both
  are CHECK-constrained in SQL _and_ validated in Rust, and the imported string is kept in
  `condition_original`.
- **`schema::FINISHES` is the one finish vocabulary and is read by index, never respelled.**
  `sorting::finish_literals` quotes it for SQL, `marketplace_feed`'s `NONFOIL`/`FOIL`/`ETCHED`
  index it, and the three DDL `CHECK`s spell it out because a migration step is history —
  `a_finish_is_one_of_the_three_on_every_table_that_checks_it` is what holds those three
  literals to the constant. A fourth finish is a new migration step.
- **A finish's price is a lookup in the `prices` blob** (`usd`/`usd_foil`/`usd_etched`;
  `eur_etched` does not exist, so etched is unpriced in EUR). `cards.price_usd` is a
  sort/display fallback chain and must never be summed. `tix` is never summed with fiat.
- **`CardFilters`' two `…Only` flags have opposite defaults, and that is deliberate.**
  `paper_only` is omitted-means-**true** — every caller wants it, and the collection and wishlist
  switch it off explicitly. `playable_only` (`legal_mask != 0`, so art series, tokens, emblems and
  memorabilia) is omitted-means-**false**, and the **search view is the only thing that sends it**:
  a collection lists what its owner owns, and an art card in a binder is still in the binder.
  Flipping that default would silently drop rows out of every other list, which is the failure
  nobody reports. The frontend's chip is inverted to match — pressed means "show them", which is
  no filter at all.
- **A list query is told which marketplace to price in and answers one number per row.**
  `SearchRequest`/`CollectionQuery`/`WishlistQuery` and the three priced deck commands carry a
  `marketplace`, and **anything that is not `cardmarket`/`cardkingdom`/`manapool` is
  `tcgplayer`** — absent, null, a number, `cardtrader` — through a hand-written `Deserialize`
  that never fails, because a future marketplace id must not fail the whole request. There are
  no `Usd`/`Eur` twin fields: they were right while both prices were keys of one blob, and a
  third source in its own table would have meant four numbers per row that four of five renders
  ignore.
- **`card_detail`/`card_printings` carry one too, and answer `FinishPrices` rather than the
  blob.** They resolve it through the same `Marketplace::from_opt`, and each returns
  `{ nonfoil, foil, etched }` per printing, every field nullable and every one built by
  `price_expr`. **`cards.prices` is not on either DTO** — the card pane is where a reader
  compares what each finish costs, and a blob carrying two of the four marketplaces could only
  ever have answered em dashes for the other two.
- **Every price in the crate is built by `sorting::price_expr` / `printing_price_expr` /
  `printing_price_by_finish_expr`**, never by hand. The third is the **deck's**, and it is the
  first two composed rather than a fourth rule: `price_expr` once per `schema::FINISHES` entry
  (through `sorting::finish_literals`), coalesced, so a printing sold only in foil is quoted at
  its foil rate instead of reading as unpriced — which is what the flat `'nonfoil'` literal a
  deck row used to pass did to **13 515 foil-only and 892 etched-only printings**. It answers
  what `printing_price_expr` answers; a deck reads it because a deck total is a `sum()` and
  `cards.price_usd` is the column that must not be summed, while the search reads the column
  because it is the one an index covers.
  Blob-backed marketplaces keep the `json_extract` text verbatim — **including the
  etched hole**, `CASE finish WHEN 'etched' THEN NULL` — and feed-backed ones emit a correlated
  scalar subquery on `(marketplace, card_id, finish)` rather than a `LEFT JOIN`, so a per-finish
  query cannot multiply its own rows by the finishes a printing is listed in.
  `sorting::sorts_for` fills one `{price}` hole (`sorting::PRICE_HOLE`) per money sort, so a
  sort cannot be wired for one marketplace and forgotten for another.
- **A deck-write readback quotes `marketplace::stored(conn)`**, not a default — renaming a
  category must not answer a Cardmarket reader with a TCGplayer total. `missing_to_wishlist` is
  the deliberate exception: it reads names and counts, and a shopping list must not depend on
  where the reader shops.
- **Wishlist fulfillment is finish-aware.** A foil wish is not filled by a nonfoil copy; a
  wish naming no finish is filled by any. `wishlist::owned_sql` sums `quantity`, so a
  collection row stepped to zero contributes nothing.
- **The wishlist's grain is four terms and the fourth is the folder** —
  `schema::WISHLIST_GRAIN`, `coalesce(oracle_id,''), coalesce(card_id,''),
  coalesce(preferred_finish,''), coalesce(folder_id, 0)` since schema v23. That last term is
  what makes "Add to <folder>" an **add**: the same card filed in two places is two wishes, so
  an add cannot silently move a row the reader filed last week, and moving one between folders
  is its own explicit act. `coalesce(folder_id, 0)` can never collide with a real folder because
  `wishlist_folders.id` is `INTEGER PRIMARY KEY`, which SQLite never assigns 0. **The price is
  written down rather than discovered**: the three writers that add at the root and cannot name
  a folder (`deck_missing_to_wishlist`, `deck_theory_missing_to_wishlist`,
  `wishlist_import_commit`) make a *second* root row for a card already filed elsewhere.
- **`wishlist_folders` is `deck_folders` ported, cascade rules included** (schema v23):
  `parent_id` CASCADEs onto its own table so a sub-tree goes in one press, and
  `wishlist_entries.folder_id` is `ON DELETE SET NULL` so deleting the cabinet surfaces the
  wishes at the root instead of throwing them away. NULL **is** the root — nothing has to be
  created for the list to work, and a reader who never makes a folder sees the list they saw
  before the upgrade. `reset::clear_wishlist` sweeps the folders by hand for `clear_decks`'
  reason, and still answers the count of *wishes*.
- **That SET NULL is a backstop and not the mechanism, because it rewrites a grain term.**
  `wishlist_folders::delete_folder` collects the sub-tree and re-files every wish in it **by
  hand, one at a time, through the same merge `set_wish_folder` uses**, inside the transaction
  and before the folder row goes. Left to the cascade it answered
  `UNIQUE constraint failed: index 'idx_wishlist_grain'` — with nothing moved and the folder
  still standing — in two shapes, and the first is the feature's own documented state: a
  sub-tree wish colliding with the second **root** row the three root-only writers above make,
  and two sub-tree wishes colliding with *each other* once both land at the root. One at a time
  is what answers the second. Every other write that can land on a taken wishlist grain already
  merged; this was the one that let the index decide.
- **All three writes that take a `folder_id` answer the same sentence.** `add_wish`,
  `wishlist_folders::set_wish_folder` and `wishlist_folders::move_folder` each look the id up
  and refuse with `deck_meta::FOLDER_GONE`. The foreign key alone is not the answer: it is
  per-connection (`PRAGMA foreign_keys`), and `FOREIGN KEY constraint failed` names the
  constraint rather than the mistake. `deck_meta::move_folder` still has the hole and is
  deliberately left with it — fixing one side of a ported pair is worse than neither.
- `needs_review` is a **sentence, not a flag** — the reconciler writes what happened, and
  the first message wins (a later sweep does not overwrite one). Non-NULL means "listed,
  counted, and asking to be looked at", never "hidden".
- Writes take `AppState.db` through the one `sync::with_write`, which is
  `db::lock_for(…, WRITE_LOCK_WAIT)` and answers `db::BUSY` if it cannot — reads go through
  `db_read` like everything else. The sentence lives beside the bound that produces it, and
  the helper beside `AppState`, which was five named copies plus six inlined until 2026-08-16.
- `cards.oracle_id` is NULLABLE and **no live row is null** — 0 of 116,590, all 81
  reversible printings included, because `card_row` falls back to `card_faces[0]`. Every
  `oracleId === null` branch in the app is a fence around the type, not a card you can find.

## Hard rules — the plain-text mirror

`mirror/` writes the decks, the collection and the wishlist to plain text files on disk, in all
seven formats, so the day the app will not start the cards are still the reader's. Full record,
with the measurements: [text-mirror.md](../docs/reference/text-mirror.md).

- **There is one `update_hook`, on the one write connection, and it is the whole of how the
  mirror learns anything.** `watch::install_hook` is installed on `AppState.db` from `setup`, and
  every user-facing write in this crate goes through `sync::with_write` on that connection — so
  no command has to remember to tell the mirror anything, and no command added next year can
  forget to. `db_read` is `SQLITE_OPEN_READ_ONLY` and can never fire it; SQLite allows exactly
  one update hook per handle, so a second `install_hook` **replaces** rather than adds. The
  callback runs on the writer's thread with the write connection's mutex held: one `fetch_or` on
  an atomic and return. Nothing there may allocate, take a lock, or call back into the database —
  SQLite forbids the last one outright.
- **A new user table must be added to `watch::surface_of`'s map, or its writes never reach the
  mirror.** The map's default arm is `_ => None`, which is the correct direction to fail (a
  surface that never catches up, which `Rebuild now` or deleting the root fixes — not a
  wrongly-pruned file and not a per-row storm), but it means **a table nobody decided about is
  silently invisible to the backup**. What stops that from being silent is
  `watch::tests::every_table_in_the_schema_has_been_decided_about`, which asserts the whole of
  `sqlite_master` against a written-down list: **a migration that adds a table goes red there
  until somebody says which side of the match it belongs on.** Add the table to both.
- **Most tables map to nothing, and that row is load-bearing rather than lazy.** A sync rewrites
  the whole `cards` table and a feed refresh rewrites `marketplace_prices` wholesale; mapping
  either to a surface would fire the hook a hundred thousand times per refresh and make every
  sync a mirror rebuild. What those two change enters through **one full pass after the refresh
  completes** — `sync::run_sync` and `marketplace_feed::refresh` each call `Mask::mark_all`.
- **`app_meta` maps to nothing on purpose, so a setting that changes what a file would say marks
  by hand.** `mirror::settings::set_root_now` and `marketplace::set_marketplace_now` each call
  `mark_all()` **on success only** — a refused value changed nothing and must not cost a full
  render. A third setting of that shape owes the same line; a live pass found the marketplace one
  missing, with every mirrored CSV quoting the previous marketplace's prices.
- **The mirror thread and `Rebuild now` each open a read-only connection of their own** — never
  `AppState.db_read`, the rule `index::lifecycle::build_now` already states. A pass reads four
  listings and writes up to ~350 files; on the shared read connection that queues every search
  and every `mirror_status` poll behind it.
- **The one write the mirror makes is its `error_log` row**, through
  `db::lock_for(&state.db, Duration::ZERO)` — a single `try_lock`, `images::flush_records`'
  precedent. A dropped row costs the log one entry; the sentence still reaches the panel through
  `mirror_status`, which is in memory. Nothing in a mirror pass may ever make a button answer
  `db::BUSY`.
- **The manifest authorises what a pass may *overwrite* as well as what it may delete.** The root
  is user-choosable and `set_root` accepts any absolute path whose parent exists, so `README.txt` —
  the one fixed name the mirror writes at the top of it — may already be the reader's. `put_readme`
  writes it only when a previous manifest named it or the bytes on disk are already ours, counts
  the refusal in `PassReport::skipped`, and **leaves a skipped README out of the manifest it then
  writes** (listing it would make the next pass claim it). A second fixed name anywhere in the
  mirror owes the same treatment.
- **Every filesystem test in `mirror/` runs against a `tempfile` root, and none may touch
  `data/`.** The default root is `data_dir/export`, so a test that forgets to set `mirror_root`
  inside its tempdir writes into the developer's own mirror.

## Hard rules — decks (storage side)

Full detail, with the measurements and the traps behind each rule, is in
[docs/reference/decks-storage.md](../docs/reference/decks-storage.md). The binding rules:

- **Enforced foreign keys exist only _between user tables_, never against `cards.id`.** The
  `ON DELETE` action is chosen per delete-site: **CASCADE** where a row has nowhere else to be
  (`deck_cards.deck_id`/`.category_id`, `deck_categories.deck_id`,
  `deck_audit.deck_id`, both `deck_undo` keys, `deck_folders.parent_id`), **SET NULL** on
  exactly two of the deck
  side's — `decks.folder_id` and `deck_cards.tag_id`, because deleting a folder must not delete
  the decks in it and deleting a tag must never delete a card. **`deck_tags` left that list at
  schema v21** and has no `deck_id` to cascade from — see the tag rule below. **Both
  `deck_allocations` keys left it at v25, with their table**, and what replaced them sits on both
  lists rather than on this one: a deck no longer claims copies another row holds, so deleting a
  deck takes the *group* (`collection_folders.deck_id`, CASCADE) while the cards go elsewhere
  (`collection_entries.folder_id`, SET NULL). **Both whole-schema
  lists have grown twice since, and none of the four additions is a deck's**: v23 added
  `wishlist_folders.parent_id` (CASCADE) and `wishlist_entries.folder_id` (SET NULL), and v24
  added `collection_folders.parent_id` **and** `collection_folders.deck_id` (both CASCADE) and
  `collection_entries.folder_id` (SET NULL) — so the CASCADE list is three longer than the deck
  side's own and the SET NULL list two. `collection_folders.deck_id` is the odd one and the one to
  read twice: the three keys that join a folder to the thing it *files* all SET NULL, and this one
  CASCADEs because it points the other way — a folder that **stands for** a deck has no meaning
  once that deck is gone, which is the opposite of what its contents get.
  `schema.rs`'s module doc is the copy of record for both lists, and a rung that adds one half of a
  filing cabinet and forgets the other is what it exists to catch.
- **A tag is one app-wide row, and `deck_tags` has no `deck_id`** (schema v21). Its grain is
  `schema::DECK_TAG_GRAIN` — `name_key`, one name for the whole app — where it was `deck_id, name`
  from v8. A category says *where in a deck* a card lives and belongs to that deck; a tag says
  what the reader thinks of a card, and a reader who has decided what "Cut candidate" means did
  not decide it per deck. So recolouring one recolours it everywhere, and no second tag can take a
  name one already holds. Six things follow, and each is somewhere the old shape's assumption is
  still the tempting one:
  - **`schema::tag_name_key` is what "the same name" means**: NFC, Unicode lowercase, NFC again,
    computed in Rust and *stored* in `name_key`, because SQLite cannot answer it — `COLLATE
    NOCASE` folds ASCII and nothing else, and the bundled build carries no normalisation at all.
    `unicode-normalization` is in the tree for this and nothing else. The display `name` keeps
    whatever capitals the reader typed; the key is never shown.
  - **`deck_tag_list` answers what a deck's list is *wearing*, most-used first** — a join over
    `deck_cards`, not a `WHERE t.deck_id`, so `variant` scopes membership as well as the counts
    and the live and theory lists are treated as separate decks where labels are concerned. It
    structurally cannot answer a tag nothing wears; `deck_tag_all` is the list that can.
  - **`deck_tag_create`, `deck_tag_update` and `deck_tag_delete` all take a `deck_id` that is not
    stored.** It is where the reader was standing — the history row and the undo step — because
    the change is global but the *act* happened somewhere, and a history that could not say where
    would be the worse record.
  - **`deck_tag_remove_from_deck` is the act the app-wide list needed.** "I am done with this
    label here" and "this label should stop existing" were one press while a tag belonged to a
    deck; conflating them now would mean a reader tidying one deck stripping a label off nine
    others. It untags one deck's cards in one variant and leaves the tag standing. Zero rows is a
    success that writes nothing.
  - **A tag outlives the deck it was made in**, because the CASCADE is gone. `reset::clear_decks`
    sweeps `deck_tags` **by hand** for exactly that reason — every deck at once is the one case
    where clearing them is right, and no cascade reaches it any more. `deck::duplicate_deck`
    copies **no** tags: the copied cards keep the very `tag_id` they had.
  - **`deck_undo::Carrier` carries its own `deck_id`.** A global delete's carriers span decks
    while the step is filed under one, so a reversal scoped to the step's deck would put the label
    back on that deck's cards and quietly leave the others bare — undo that *looks* like it
    worked, on the screen that is open.
- **The grain is `deck_id, variant, category_id, card_id, coalesce(finish, '')`**
  (`schema::DECK_CARD_GRAIN`). `variant` is `live` (sleeved up) or `theory` (being built toward)
  and `finish` is `NULL | 'foil' | 'etched'` (schema v19); every card command takes all of them.
  `deck_cards` has `CHECK (quantity > 0)`, so zero removes the row.
- **`deck_cards.finish` is NULL for the regular copy and `'nonfoil'` is never stored.**
  `deck::normalise_finish` is the one place the word becomes NULL and the column's CHECK is what
  makes any other path a hard error — two spellings of "regular" would be two rows on the grain
  that draw identically on screen and sum apart. The `coalesce` is `COLLECTION_GRAIN`'s device
  for its reason (NULLs in a UNIQUE index are distinct), which makes `DECK_CARD_GRAIN` the third
  grain that cannot be checked through `PRAGMA index_info` and is held to its index by its
  `ON CONFLICT` targets instead. **A deck's money follows it**:
  `sorting::deck_card_price_expr` is two arms told apart by the column being NULL — the
  `nonfoil → foil → etched` chain when unsaid, that finish alone when said, with no fallback
  either way. **Owned/missing needs no change**, and that is worth knowing rather than
  rediscovering: it matches on oracle id and has always ignored finish, condition and language.
- **`attribute_owned` zeroes every `theory` row, explicitly and not by luck.** It was a fence
  around `deck_allocations` carrying no variant — a theory read walked the *live* deck's claims —
  and a group is not scoped to a variant either, so the conclusion is still drawn here rather
  than left to a table's shape. A plan reserves nothing.
- **Switching the theory list on _moves_ the live deck into it and leaves `live` empty.** The
  deck the reader has built is the plan; what is sleeved up starts at nothing and fills as they
  acquire cards. Only on the false→true transition and only when the theory list is empty — a
  plan already started is not something a re-press may pour the live deck over. The move sets
  `last_variant = 'theory'` and **reallocates in the same transaction**, because claims are held
  for `live` only and cards that just left it must release them.
  `deck_theory_slots` is the third read of the pair and the only one that is not a comparison:
  every card the plan asks for, as a `TheorySlot` — the `group_key` and **how many copies it
  wants** — for the deck editor's theory mark. **It answers `group_key` itself rather than a
  pair**, which is what stops the mark and the shopping list drifting apart — "the same planned
  card" is one function in `deck_theory`, and both surfaces spell it with that code. Three
  columns, one indexed scan, inactive categories excluded on `diff_select`'s rule; deliberately
  **not** a `deck_get` of the other variant, which prices every row and rolls up allocations for
  a mark that needs neither. **The quantity joined the key on 2026-08-26 (issue #212) and the
  rows fold in the SQL with it** — `GROUP BY dc.card_id, dc.finish`, which is `group_key`'s own
  grain: two `Vec` entries spelling one key were harmless while the caller built a set out of
  them and would be a silently halved plan now.
  `deck_theory_copy_from_live` still means "copy what is sleeved up into the plan" and is no
  longer what the switch does.
- **`decks.default_category_id` says where an add that names no pile lands, and `0` is `Auto`**
  (schema v16, `deck::AUTO_CATEGORY`). **A sentinel in a `NOT NULL` column rather than a nullable
  foreign key, and the reason is [`DeckPatch`]'s convention**: `coalesce(?n, column)` reads a
  bound NULL as "leave it", so a nullable column could not express "back to Auto" without a
  command of its own — `decks.folder_id`'s exact problem, and `deck::set_folder` is the price it
  pays. `deck_categories.id` is an `INTEGER PRIMARY KEY`, so no pile can ever be `0`, and the
  frontend spells the same number `AUTO_CATEGORY`. **What it costs is the two clean-ups no
  `ON DELETE SET NULL` is doing, and they are the sites to remember**: `deck_meta::delete_category`
  puts a deck filing by the deleted pile back to `0` in the transaction that deletes it, and
  `deck::duplicate_deck` **remaps** the id onto the copy's own categories (a verbatim copy would
  point the duplicate at a pile of the original). Rust owns one fence — a non-zero id must name a
  category **of this deck**, `category_of_deck`, because nothing in the DDL says so — and knows
  nothing about what Auto *does*: `autoCategoryFor` reads Oracle tags and is a conclusion.
  The history row names the **pile**, resolved at write time, `null` for Auto.
- **The editor's last view lives on the deck, and reading a deck is not editing it.** v12's
  `decks.last_variant`/`last_group_by`/`last_sort_by`, written by `deck_set_view_state(deckId,
viewState)` — absent field means "leave it". It moves **no `updated_at`**, records **no
  `deck_audit` row**, reallocates nothing, and refuses an unknown deck by name (`GONE`).
  None of the three carries a CHECK — **not because `ALTER TABLE … ADD COLUMN` cannot add
  one**, which is what this said until 2026-08-17 and is false (v19's `deck_cards.finish` adds
  one and it is enforced); it is that the vocabulary of two of them is not the crate's to own.
  `last_variant` is fenced against
  `DECK_VARIANTS` here (through the one `deck_meta::valid_variant`) while the other two hold a
  **TypeScript** vocabulary the crate does not know: Rust stores the reader's answer verbatim and
  refuses only a blank one (`NO_MODE`); TS narrows it on read with a fallback.
- **`is_active = 0` is the whole of what `maybe` used to mean**, and **nothing anywhere may
  branch on the kind being `maybe`.** The user names, reorders, switches off and deletes their
  own categories; the fixed word survives only as `deck_categories.kind`
  (`schema::CATEGORY_KINDS`).
- **`format_specs` is data, not code.** A rules change is a new migration step re-running the
  seed constant, never an engine branch; a new format is a row. Never derive one format from
  another.
- **The format a deck was created in is remembered in one `app_meta` row** (`last_deck_format`,
  no migration — a key in schema v6's table, like `marketplace` and `printing_group_by`), and
  **`create_deck` is the only writer**. It records the key `valid_format` produced, so a blank
  input is remembered as `casual` — what the deck actually is — and a refused **create** records
  nothing, because the write is inside that create's own transaction. **That guarantee is about
  the create and no wider, and the exception is known**: `useImport`'s `importIntoNewDeck` is
  `deck_create` then `deck_import_commit` — two commands, so two transactions, with a hand-rolled
  rollback — and a refused *commit* deletes the deck while the create's `last_deck_format` stands.
  The next New deck then opens on the format of a deck that never survived. **Left that way
  deliberately**: the reader really did pick that format, and un-writing it means reading the
  previous value before the create and compensating after the delete, i.e. two more statements on
  the one path whose whole difficulty is already that it is not one transaction. Its error is
  deliberately **ignored**,
  unlike the `deck_audit::record` two lines away: a remembered preference must never cost the
  reader their deck. `duplicate_deck` has its own INSERT and does **not** update it — duplicating
  chooses no format. `deck_last_format` answers the stored string **verbatim or `None`** and
  checks it against `format_specs` not at all: which format a *dialog* starts on is a display
  decision, and TypeScript's `newDeckFormat` is where the fallback to Commander lives.
- **Owned/missing is `sum(quantity)` over the deck's own group, matched by oracle id, and there
  is no allocator** (schema v25). `deck::owned_by_oracle` joins `collection_entries` to
  `collection_folders` on `f.deck_id = ?1` and groups by `cards.oracle_id`, so an Alpha Bolt in
  the group answers an M10 row in the list; `attribute_owned` hands that map out along
  `read_deck_cards`' own `ORDER BY`, never a caller's, so the number a row shows cannot depend on
  how a view displayed the list. **There is no run list to keep**: nothing is derived, so no write
  "reallocates" and none can forget to — the previous rule named seven writes and had already gone
  stale once. What a deck owns changes only when a row moves in or out of its group, which is
  `collection_alloc`'s two writes plus `delete_deck`. **The honest cost: owned/missing is now
  exactly as accurate as the reader's filing.** The allocator guessed for them, sweeping every
  matching collection row and reserving greedily; a copy now counts for a deck when it is in that
  deck's group, and an unfiled collection reads as a deck full of red until the reader drags. In
  exchange, two decks can no longer count one copy, a stored claim can no longer out-count the row
  it claims, and **growing the collection is visible at the next read** rather than at the next
  allocator run — the bug this file carried as known and open.
- **Writing history is not a command.** `deck_audit::record(tx, …)` is called _inside the
  caller's already-open transaction_, which is what makes a rolled-back write leave no history.
  Its only IPC is the read, `deck_audit_list`, whose limit is `clamp(1, 500)` — **the low end is
  load-bearing, because SQLite reads a negative `LIMIT` as no limit at all.** The table holds
  facts; `src/features/decks/auditText.ts` is the only thing that words them. It answers the id
  of the row it wrote, which is what `deck_undo` keys on.
- **Undo is `deck_undo`, a journal beside the history and never a column on it** (schema v17,
  `deck_undo.rs`). `record_step(tx, …)` is called inside the caller's transaction beside
  `deck_audit::record`, for the same reason and a sharper one: a step that outlived its change
  would be applied into a deck that never had it done. **The audit log cannot be replayed
  backwards** — a swap keeps no from-printing id, a category delete keeps a *count* of the cards
  the CASCADE took, a reorder keeps no order — so a step carries the rows themselves. Four
  primitives (`cards` over an explicit scope of `deck_cards` cells, `categories`, `tags`,
  `deck`); `restore` and `patch` are two lists because a pile that took a freed rowid belongs to
  the same deck and an upsert would rename the reader's newest pile into the deleted one.
  **`AUDIT_KINDS` stays at nine** — an undo is a `deck` row with
  `{"field":"undo","of":<id>}`, because a CHECK cannot be altered and a tenth word would rebuild
  every reader's history. **The reversal's own row records no step**, so the stack stays linear.
  `undone_at` persists (undo survives a restart); the redo queue is the webview's and does not.
  Every deck write records one — `undoing_any_card_write_restores_the_deck_exactly` and its two
  siblings drive the list and compare the deck row for row. **Five deliberate absences**, each
  argued at its own site: `deck_create`/`duplicate`/`delete`, `deck_folder_delete` (per-deck
  cursor against an N-deck press, over a real foreign key), rows predating v17, the cover
  *file* behind `deck_set_cover_image`, and — since schema v25 —
  `collection_alloc::deck_to_collection`, whose cut moves a `collection_entries` row this journal
  cannot express, so a step would restore the list and not the custody. The history row is **not**
  in that absence: a cut records the one `deck_set_card_quantity` wrote. Full detail:
  [decks-storage.md](../docs/reference/decks-storage.md) and
  [collection-folders.md](../docs/reference/collection-folders.md).
- **Two fences every deck write opens with, neither enforced by the DDL**: the variant must be
  one the schema knows, and the category must belong to _this_ deck — `deck_cards.category_id`'s
  FK only asks that the category exist, not whose it is.
- **`import.rs`: every resolution arm is one indexed lookup, and a `COLLATE NOCASE` or an
  `OR` is what stops it being one.** `cards.name`/`set_code`/`collector_number` are plain `TEXT`,
  so their indexes are BINARY and a comparison naming another collation plans as `SCAN c` — a full
  table scan **per line**. Splitting the arms took a 105-line list from **46 123 ms to 11.5 ms**
  (release, live corpus) and separately fixed a **correctness** bug: as one `OR`, art-series
  `"N // N"` rows outranked the real card on 3 of those 105 lines. Case-insensitivity lives in the
  fold arm, in Rust, over `cards_fts`. **Do not restore the collation here** — it reads like a
  regression and is not one.
- **`import.rs`: a printing hint narrows which _printing of the named card_ to take, never
  which card** (`hint_names_the_card`). `BY_SET_AND_NUMBER` consults no name in its SQL, so the row
  it finds is folded against the line's name in Rust and a disagreement is treated as exactly a
  hint that named nothing — `hint_missed`, and fall through. Before that guard,
  `1 Captain Sisay (brc) 132` silently imported **Arcane Signet** with `hint_missed: false`. Same
  reasoning as `deck_swap_printing`'s different-oracle guard.
- **`import.rs`: `MATCH_ORDER` is owned → English → newest → id**, and the position of the
  language key is the decision: a copy you own in any language is still a copy you own, while
  "newest" is exactly the key that put 5 of the reference list's 105 lines on a `ja`/`dw`/`ph`
  printing. `fold_match` repeats the same keys in Rust and may never disagree.
- **`import.rs`: `ImportItem.inactive` switches off _only a pile this import creates_.**
  Archidekt's `{noDeck}` says a pile counts toward nothing, which is exactly `is_active = 0` here;
  without it a reference deck's 17 maybeboard cards land in a counted pile and a 100-card commander
  deck reports 117. **A name the reader already has keeps whatever they set** — an import may not
  reach into filing somebody did by hand, the same reasoning that makes `replace` clear the cards
  and leave the categories standing — and the `existed` lookup `commit_import` already makes for
  `categories_created` is that same fact, so the rule costs no second query. **The first item
  naming a pile decides**, because the name is memoised for the list: every export in scope writes
  the same bracket on every card of a category, and a list that disagreed with itself has no better
  answer available. **It writes the column directly rather than going through
  `deck_meta::set_category_active`** — that one opens a transaction of its own and writes a history
  row, both already `commit_import`'s, whose whole reason for existing is that an import is **one**
  transaction over the finished deck. (It reallocated as well, until v25 took the allocator.) `#[serde(default)]`, so every caller written before the field still
  deserialises and absent means the ordinary counted pile an import has always made. Which lines
  carry the flag is TypeScript's reading of the file, not Rust's: `parse.ts` takes it off the
  bracket's **first** entry and `plan.ts` rides it to the item — Rust supplies the write, TS draws
  the conclusion.
- **`import.rs`: `ImportItem.tag_name`/`tag_color` is Archidekt's `^Keeper,#4aab08^`, found-or-created
  by `schema::tag_name_key` — and a label that is already there is used **exactly as it stands**.**
  The same shape `category_name` has, one table over: a name rather than an id, because an
  imported list names labels this app may not have yet. `tag_for_name` is the find-or-create and
  it is deliberately **not** `deck_meta::create_tag` — that one opens its own transaction, writes
  its own history row, records its own undo step and refuses a name that is taken, which is the
  *ordinary* case here rather than an error. A hundred labelled lines must not be a hundred of
  each. The memo is keyed on `tag_name_key`'s answer, so `Keeper` and `keeper` in one list are one
  row and count as **one** creation (`ImportOutcome::tags_created`, and `tagsCreated` in the `add`
  row's payload).
  Three rules that would each be wrong the other way:
  - **The found row is never renamed and never recoloured.** `inactive`'s rule over a different
    table, and sharper: `deck_tags` has no `deck_id` since schema v21, so recolouring one from a
    pasted decklist would recolour it in every deck the reader owns.
  - **`tag_id` coalesces where `quantity` sums.** The `ON CONFLICT` is
    `tag_id = coalesce(deck_cards.tag_id, excluded.tag_id)` — two copies of a card are three
    copies, but a label the reader put on a row by hand is a decision this import may not
    overturn. An absent `tag_name` says nothing about the card at all, which is what an unticked
    label sends.
  - **A name with no colour is refused, not defaulted.** `deck_tags.color` is NOT NULL and what a
    colour *is* belongs to the webview, so `tag_for_name` bounces the pair rather than inventing
    one. `TypeScript` sends the two together or neither.

  **Undo sweeps the labels an import invented**, `push_made_tags` mirroring
  `push_made_categories` — read `tag_ids` before, diff after, `Op::Tags` on both sides. The order
  is load-bearing on the **redo** side: `Op::Tags` restores before `Op::Variant` inserts, because
  `deck_cards.tag_id` is a real foreign key and `insert_cards` writes the restored rows' labels
  through `remap.tag`.

## Scryfall and the network

The rules, and where each is enforced, are in
[docs/reference/scryfall.md](../docs/reference/scryfall.md). What binds every call site:

- **`scryfall::Client::api_send` is the only way this module issues an API request** — it
  refuses inside a lockout, waits out the endpoint's interval, adds `Accept`, and retries.
  Every `api.scryfall.com` request needs real `User-Agent` + `Accept` headers.
- **Pacing sleeps, a 429 refuses**, a 429 is remembered across a restart, and retry is for
  5xx/timeouts only — **never a 429** (the docs forbid exactly that) and never a 404.
- **Bulk data is the only card source**, gzipped **JSONL** (one object/line; old JSON-array
  endpoints 404). There is no per-card API lookup anywhere.
- **Three bulk datasets, one client.** `default_cards` (the corpus), `oracle_tags` (~5.85 MB,
  4 521 tags) and `art_tags` (~12.5 MB, 11 531 tags over 475 163 taggings, measured 2026-08-20)
  all go through `Client::check_bulk_dataset` and so share the one pacing gate
  and the one 429 lockout — a second `reqwest::Client` would be a second application as far
  as the rate limiter can tell. The price feeds are the deliberate exception: they are not
  Scryfall and must not spend its budget. **Both tag files are checked weekly while Scryfall
  regenerates them daily**, and the two cadences must not be blurred: the week is
  `tags::{oracle,art}::REFRESH_INTERVAL_SECS`, this app's own answer to how often to ask, because
  the taxonomies are hand-curated and a deck's categories should not regroup between two sessions
  on the same afternoon. Art is the larger file by 2.1× — 12 544 874 B against 5 852 962 B, both
  read on 2026-08-20, because a ratio across two runs is not a ratio — which is why
  `tags::art::refresh_if_due` is emphatic that neither the launch, the card sync nor the
  **oracle** refresh may wait on it.
- Scryfall's shapes: `cards.oracle_id`/`cmc`/`type_line` are NULLABLE, `collector_number` is
  TEXT, prices are decimal strings, `legalities` is JSON (23 keys, grows), finishes are an enum
  and never a boolean.
- Failures fold into `error_log` through `errors::record`, which returns `()` and is called
  inside the caller's transaction — it can never fail the thing it describes.

## Images and the `mtgimg://` protocol

Details and every measurement: [docs/reference/image-cache.md](../docs/reference/image-cache.md).

- Card images are served over `mtgimg://` — `<origin>/<variant>/<card_id>/<face>`, where the
  origin is `http://mtgimg.localhost` on Windows and `mtgimg://localhost` elsewhere. Variants
  are **WEBP only** (`thumb`/`grid`/`display`/`art`); the JPG/PNG family is never fetched.
  The handler reads through `db_read`, never the write connection.
- `app.security.csp` is not `null` — a new remote source needs a deliberate edit and the
  `the_shipped_csp_allows_ipc_and_images_and_nothing_wild` test updated with it.
- `cards.scryfall.io` is the **only** host images come from; an off-host URI is refused. A URI
  with no `?<epoch>` cache-buster is refused at resolution, and `is_current` compares that
  stored URI character for character — that is the whole of freshness.
- The second route is `/cover/<deckId>`, which touches Scryfall not at all. The `i64` parse is
  the whole path-traversal fence, since the id becomes a filename.

## Tauri capabilities

- **`@tauri-apps/plugin-dialog` names files and never opens them, and the capability says so.**
  `capabilities/default.json` grants **`dialog:allow-open`** (choosing a deck cover) and
  **`dialog:allow-save`** (naming an export's destination, added 2026-08-14) — never
  `dialog:default`, so message, ask and confirm stay unreachable from the webview however the
  plugin is initialised. The app's own questions are drawn in the page instead, which is
  deliberate rather than an oversight: a native message box cannot be styled, driven over CDP or
  read by the story runner.
- **A dialog verb answers a _path_, and a path is not permission to touch what is at it — which is
  why every one of them has a Rust command behind it.** `deck_set_cover_image` takes the path
  `open()` gave and Rust reads the image; `import_read_file` (`import.rs`) takes a path
  from the same picker and Rust reads the decklist; `export_write_file` (`export.rs`) takes the
  path `save()` gave and Rust writes the text. Doing any of that from the page would need an `fs:`
  permission, and **no `fs:` permission is granted anywhere**. So this is the app's **habit** now
  rather than one precedent, and it is the shape to copy: the day one of these is "simplified"
  into a `readTextFile`/`writeTextFile` from the page, the answer is another twelve-line command,
  never a wider capability. **`tauri-plugin-fs` and `rfd` entered `Cargo.lock` transitively** as
  the dialog plugin's own dependencies and are **unreachable**: `tauri_plugin_fs::init()` is never
  called — `lib.rs` registers single-instance, opener, dialog, clipboard-manager, and the MCP
  bridge in a debug build only — and the ACL would deny them even if it were. Adding a plugin
  means adding its narrowest permission, never its `:default`.
- **`tauri-plugin-clipboard-manager` is granted `clipboard-manager:allow-write-text` and
  deliberately not the read half.** Nothing in this app reads the clipboard; `:default` grants
  both, and a page that can read the clipboard can read whatever the reader last copied out of
  their password manager — a capability that would be granted here on the strength of a "Copy card
  name" row. It is the plugin rather than `navigator.clipboard` because the web API is unproven
  in this window: `http://tauri.localhost` _should_ be a secure context, nothing here has ever
  demonstrated it, and the failure mode would be in the packaged exe only.
- **`tauri-plugin-mcp-bridge` gets three of its thirteen commands, and which three is a fact
  about the plugin's own source rather than a preference.** `mcp-bridge:default` grants all
  thirteen; the webview only ever invokes **`report_ipc_event`** and
  **`request_script_injection`** (`bridge.js:145`, `:658`) and **`script_result`**, the
  callback baked into the wrapper `execute_js` evals, which is how a script hands its value
  back (`commands/execute_js.rs:249`) — drop that one and every `webview_execute_js` returns
  nothing, which is the tool an agent leans on most. The other ten are dispatched **in Rust**
  by the plugin's `websocket.rs`, never over IPC, so the ACL is not in their path and granting
  them buys nothing. `ipc_execute_command` reaching one of *this app's* commands needs no entry
  either: Tauri v2's ACL gates `core:` and `plugin:` commands, and an app's own
  `#[tauri::command]` is always callable.
- **The bridge binds `127.0.0.1`, against the plugin's own `0.0.0.0` default.** It executes
  arbitrary JavaScript and any command in the handler on request and authenticates nothing;
  the upstream default exists for driving a phone across your LAN, and keeping it here would
  offer that to whatever network the machine is on. Same reasoning as `dialog:allow-open`.
- **`withGlobalTauri: true` is what the bridge needs, and it is not debug-only.** `bridge.js`
  reaches the IPC through `window.__TAURI__`, so without it IPC monitoring, script injection
  and `execute_js`'s result callback all go dark — but `tauri.conf.json` has no debug/release
  split, so a release build carries the global too even though the plugin is `cfg`'d out of it.
  What keeps that honest is the CSP: `script-src 'self'`, no remote origin, and no
  `dangerouslySetInnerHTML` anywhere in `src/`, so no foreign script runs in the page to find
  it. Adding any one of those three back is what would make a dev-only config worth its cost.
- **The window's four verbs are granted one by one, because `core:window:default` grants none of
  them.** That default is the *getters* — `is-maximized`, the position and size reads, the monitor
  queries — so `decorations: false` and `components/TitleBar.tsx` needed
  **`core:window:allow-minimize`**, **`-toggle-maximize`**, **`-close`** and
  **`-start-dragging`** naming themselves (2026-08-20). Worth pinning rather than trusting, and
  `the_title_bar_gets_four_window_verbs_and_the_overlay_two` does: the family those four come from
  also holds `allow-set-always-on-top`, `allow-set-fullscreen`, `allow-set-position` and thirty
  more, and a window acquires an ACL nobody decided on one `allow-*` at a time. The frontend's
  half is `src/lib/window.ts`, which exports one function per permission and says so.
- **`tauri-plugin-snap-layout` gets its two commands and not its `:default`, even though today
  they are the same set.** The plugin is the whole of what an undecorated window needs to keep
  Windows 11's Snap Layouts: it creates a transparent Win32 child over the maximize button's rect
  and answers `HTMAXBUTTON` to `WM_NCHITTEST`, which is a question the OS asks its own frame and
  never asks a `<button>` in a webview. `allow-update-snap-bounds` and `allow-detach-snap-bounds`
  are named because naming them records that both were looked at — a plugin's default is a promise
  about *its* future, not about this app's. **It draws nothing**, which is why it was chosen over
  `tauri-plugin-decoration`: that one renders its own HTML controls (replacing ours) and wants a
  CSP loosened for its stylesheet. **This one needs no CSP change at all** — it injects through
  `js_init_script`, which the webview runs before the page and the page's CSP therefore does not
  govern. It is also a **plain dependency rather than a `cfg(windows)` one**, for the reason the
  mcp-bridge paragraph gives: `tauri-build` discovers a plugin's ACL through the dependency graph,
  so target-gating it would leave those two entries unresolvable on the Linux half of the CI
  matrix. The crate compiles to a dummy everywhere but Windows, and is a documented no-op on
  Windows 10.
- **The button id is the contract, and it is silent at both ends.**
  `snap_layout::init().button_id("snap-maximize-button")` in `lib.rs` must equal `SNAP_BUTTON_ID`
  in `src/lib/window.ts`. A mismatch creates no overlay, raises no error and logs nothing: the
  button keeps working and Snap Layouts simply never appear, which is a regression neither a test
  nor a launch can catch. `TitleBar.test.tsx` pins the frontend half.
- `tauri.conf.json` is embedded at **compile time** — editing it needs a Rust rebuild
  (`touch src-tauri/src/main.rs`), not just a dev-server restart. `"dragDropEnabled": false` is
  load-bearing; re-enabling it kills all in-app drag-and-drop on Windows. **So are the window's
  other two flags**: `"decorations": false` is what makes `TitleBar` the only way to move,
  maximize or close the app — turning it back on draws two title bars, turning it off without
  that component leaves a window the reader cannot put down — and `"shadow": true` is easy to
  lose because nothing breaks without it, the window simply rendering with square corners and no
  drop shadow, flat against the desktop with no border of its own on a dark wallpaper. Both are
  pinned by `the_main_window_is_undecorated_and_keeps_its_shadow`.
- **The window's opening size is decided in Rust, not by the config** (`window.rs`, first call in
  `setup`). The config's 1920×1080 is the top rung and the fallback; `open_sized_to_monitor` takes
  the largest of 1920×1080 and 1280×720 that the monitor's **work area** holds, then centres and
  shows. A 1920×1080 desk takes the lower rung — Windows leaves 1920×**1032** after its taskbar,
  and a window sized to the whole screen puts the deck editor's action row behind it. **The
  window is created hidden (`"visible": false`) and `open_sized_to_monitor` is the only thing
  that shows it**, so it runs before anything in `setup` that can fail — an early `?` above it
  would leave a running app with no window, which is exactly what the single-instance guard
  looks like. Nothing is remembered between launches: no window-state plugin is registered, so
  a size the reader chose is theirs until they close it. **`decorations: false` does not change
  that arithmetic**: `open_sized_to_monitor` sizes the *window*, and an undecorated window's
  outer rect is 16px wider and 9px taller than its client area for the invisible grab margin —
  which is inside the work-area check either way, since both rungs are chosen against the work
  area rather than against the screen.

## Further reading

| Doc | What it holds |
| --- | --- |
| [data-and-sync.md](../docs/reference/data-and-sync.md) | Data dir, sync timings, the schema ladder, every search-performance measurement |
| [scryfall.md](../docs/reference/scryfall.md) | Rate limits, the penalty, bulk data, `error_log`, pre-warm keys |
| [image-cache.md](../docs/reference/image-cache.md) | Cache layout, concurrency, placeholders, the cover route |
| [search-faceting.md](../docs/reference/search-faceting.md) | `src/index/` — why the index is in memory, and the fail-open rule |
| [in-app-updates.md](../docs/reference/in-app-updates.md) | `update.rs` — why the portable swap is hand-written |
| [decks-storage.md](../docs/reference/decks-storage.md) | The deck tables, the card commands, how owned/missing is answered, the audit log, the decklist import |
| [wishlist-folders.md](../docs/reference/wishlist-folders.md) | The wishlist's cabinet (v23) — the four-term grain, the merge rule, the root-add duplicate |
| [collection-folders.md](../docs/reference/collection-folders.md) | The collection's cabinet (v24–v25) — the eleventh grain term, the deck groups and `Recently removed`, the conversion that made them, what a zero quantity now costs |
| [text-mirror.md](../docs/reference/text-mirror.md) | `mirror/` — the layout, the dirty map, why the pruner reads a manifest instead of guessing, what a pass costs measured, and the bugs still open |
