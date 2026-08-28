//! Database schema: `cards`, `sets`, `sync_meta`, the `cards_fts` search index, the user's
//! own tables — `collection_entries`, `collection_folders`, `wishlist_entries`,
//! `card_migrations`, `decks`, `deck_cards` — and `format_specs`, which is seeded *data*: the
//! format rules the validation engine reads instead of embodying. (`deck_allocations` was on
//! that list until schema v25 replaced a deck's *claim* on copies with the copies being filed
//! in that deck's group.)
//!
//! Nullability here is load-bearing. Scryfall omits `oracle_id`, `cmc` and `type_line` at
//! the top level on some printings (reversible cards, art series), `collector_number` is
//! TEXT (values like `"161★"` exist), and `legalities` is stored as a JSON blob because the
//! format list grows over time. *Omitted at the top level* is not the same as absent:
//! [`crate::card_row`] falls back to `card_faces[0]` for all three, so live data fills
//! `oracle_id` on every one of its 116 590 rows (2026-08-05). The columns stay NULLABLE
//! because the JSON permits it, not because a population needs them to.
//!
//! The line that runs through the whole file: the first four tables are *sync data* and
//! `cards` is dropped and recreated wholesale on every sync (see [`swap_staging`]); the
//! rest are the user's, are never dropped, and therefore reference `cards.id` **softly** —
//! no `REFERENCES` clause anywhere near a card id, with the printing denormalised beside
//! the id so a row stays identifiable after the id it points at stops resolving.
//!
//! Enforced foreign keys exist only *between user tables* — never against `cards.id`, where
//! a declared `REFERENCES` would abort every sync (see [`swap_staging`]) — and the `ON
//! DELETE` action is chosen per delete-site rather than fixed once for the whole schema:
//! CASCADE where the parent's deletion genuinely means the child should go too, SET NULL
//! where the child has to outlive it.
//!
//! CASCADE is the common case, and there are **eleven** of them — `deck_cards.deck_id`,
//! `deck_cards.category_id`, `deck_categories.deck_id`, `deck_audit.deck_id`,
//! `deck_undo.audit_id`, `deck_undo.deck_id`, `deck_folders.parent_id`,
//! `wishlist_folders.parent_id`, `collection_folders.parent_id`,
//! `collection_folders.deck_id` and `combo_cards.combo_id` — because a deleted deck's cards, a
//! deleted category's cards, a reversal for a history row that is gone, a deleted folder's
//! sub-folders and the cards of a combo that no longer exists have nowhere else to be.
//!
//! **`combo_cards.combo_id` (schema v26) is the eleventh and the odd one, because it is the
//! only enforced key in this schema that joins two tables that are neither the user's nor
//! Scryfall's.** Both sides are the Commander Spellbook feed's, both are rebuilt wholesale by
//! the same ingest, and the key is legal here for the plainest reason in the paragraph above
//! it: it points at `combos.id`, not at `cards.id`, so no sync can abort on it. What it buys
//! is the one thing the tag tables' soft keys do not — a `combo_cards` row that has outlived
//! its combo is not a thing the match query can ever see, because a half-written parent cannot
//! leave orphaned children behind it. Its price is written down at [`swap_combo_staging`]: the
//! child is dropped **before** the parent, since a `DROP TABLE` with foreign keys on is an
//! implicit `DELETE` and doing it the other way round drags every child row through a cascade
//! on the way to dropping that table too.
//!
//! **`deck_allocations.deck_id` and `deck_allocations.collection_entry_id` left this list at
//! schema v25, with their table**, and they are worth a line rather than a silent deletion
//! because what replaced them is on both lists above and below. A deck no longer *claims*
//! copies somebody else's row holds; the copies sit in that deck's group. So deleting a deck
//! takes the group with it (`collection_folders.deck_id`, CASCADE) while the cards themselves
//! surface at the root (`collection_entries.folder_id`, SET NULL) — which is the whole
//! difference between a claim and custody, written as two `ON DELETE` actions pointing
//! opposite ways at the same press. It also retires the two delete-sites this paragraph used
//! to name: [`crate::reconcile`]'s fold no longer has allocations to repoint before it runs,
//! and `collection::remove_entry` has no reservations left to free.
//!
//! SET NULL is the other four — `decks.folder_id` (a folder is
//! a filing decision, and the decks inside it are the user's work, not the folder's to take
//! down with it), `deck_cards.tag_id` (deleting a tag must never delete a card),
//! `wishlist_entries.folder_id` (`decks.folder_id`'s argument one list over: a wish is the
//! reader's shopping list, so deleting the cabinet surfaces it at the root rather than
//! throwing it away) and `collection_entries.folder_id` (the same argument again, and the
//! strongest of the three: the cards are the reader's *property*, so deleting a folder
//! surfaces them at the root and can never delete them) — named here so this list can be
//! checked against the DDL rather than trusted on its own.
//!
//! **The wishlist's pair (schema v23) is the deck gallery's pair verbatim, and the
//! collection's (schema v24) is the wishlist's**, and the symmetry is the decision rather
//! than a coincidence: `wishlist_folders.parent_id` and `collection_folders.parent_id` are
//! `deck_folders.parent_id`, and `wishlist_entries.folder_id` and
//! `collection_entries.folder_id` are `decks.folder_id`, because "folders nest, and the
//! things filed in them outlive the filing" is a rule this schema has now made three times.
//! `collection_folders.deck_id` is the one thing the other two cabinets have no equivalent
//! of, and it is CASCADE rather than SET NULL because a folder that *stands for* a deck has
//! no meaning once that deck is gone — which is the opposite of what the folder's contents
//! get. Both halves of a new filing cabinet belong on both lists above, one on
//! each — a rung that adds one and forgets the other is what these two paragraphs exist to
//! catch, since a prose-only edit routes to neither CI job and nothing here can go red.
//!
//! **`deck_tags` left the CASCADE list at v21** and has no key of its own at all: a tag belongs
//! to no deck, so deleting the deck a label was first typed in must not take it off the others
//! wearing it. [`crate::reset::clear_decks`] sweeps that table by hand, which is the one case —
//! every deck at once — where clearing it is right.

use crate::db::CORPUS;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

/// The `cards` columns **as version 1 created them. FROZEN.**
///
/// This is the body of one historical migration step, not a description of the current
/// table. Editing it would rewrite history: a fresh install would create the new column
/// in its v1 `CREATE TABLE`, and the v2 step that is supposed to `ALTER TABLE cards ADD
/// COLUMN` it would then fail with "duplicate column name" on every new machine while
/// working perfectly on every upgraded one. Schema changes go in a **new** migration
/// step in [`migrate_single_file`], never here.
///
/// The staging clone does *not* read this — it derives its layout from the live table at
/// runtime (see [`create_staging`]), so it stays correct no matter how many `ALTER`s
/// later versions add.
const CARDS_COLUMNS: &str = "
    id TEXT PRIMARY KEY,
    oracle_id TEXT,
    name TEXT NOT NULL,
    lang TEXT NOT NULL,
    released_at TEXT,
    set_code TEXT NOT NULL,
    set_name TEXT,
    collector_number TEXT NOT NULL,
    rarity TEXT,
    layout TEXT NOT NULL,
    mana_cost TEXT,
    cmc REAL,
    type_line TEXT,
    oracle_text TEXT,
    colors TEXT,
    color_identity TEXT,
    legalities TEXT,
    games TEXT,
    finishes TEXT,
    prices TEXT,
    price_usd REAL,
    price_eur REAL,
    faces TEXT,
    illustration_id TEXT,
    frame_effects TEXT,
    border_color TEXT,
    full_art INTEGER NOT NULL DEFAULT 0,
    promo INTEGER NOT NULL DEFAULT 0,
    promo_types TEXT,
    digital INTEGER NOT NULL DEFAULT 0,
    is_paper INTEGER NOT NULL DEFAULT 1,
    edhrec_rank INTEGER,
    game_changer INTEGER,
    image_status TEXT,
    image_updated_at TEXT,
    search_text TEXT,
    raw TEXT NOT NULL";

/// Every index on `cards`, in one place.
///
/// Load-bearing: [`swap_staging`] drops `cards` and its indexes on every sync and has to
/// put them all back. When these statements were written out twice — once in [`migrate_single_file`],
/// once in the swap — an index added to one of them silently disappeared at the next sync
/// on every machine that had already migrated. `IF NOT EXISTS` so `migrate_single_file` can rerun.
///
/// **This list describes the table at HEAD, so only the NEWEST migration step may replay
/// it.** It names `legal_mask`, which the v10 step is what adds — so the v1 block that used
/// to replay it would now fail on every fresh install with "no such column", the list
/// describing a table nine versions ahead of the one in front of it. Every step below the
/// replay therefore creates no index at all: the replay is where every database walking the
/// ladder gets them, and every statement being `IF NOT EXISTS` is what makes that a
/// bring-up-to-date rather than a rebuild. A step that *changes* a definition — as v10 changes
/// `idx_cards_collapse` — drops the old one first, or `IF NOT EXISTS` silently keeps what is
/// already there.
///
/// The rule is a *moving* one, and **it has moved: the replay lives in the v20 step, not in
/// v10's any more.** v20 adds `idx_cards_illustration` to this list, and a database entering
/// the ladder above v10 — every machine that has synced since — would never have run v10's
/// block, so an index left there is an index those machines never get.
/// `every_version_ends_with_the_same_schema_as_a_fresh_install` is what fails if a step that
/// touches `cards` lands without taking the replay over; v10 keeps only its own
/// `DROP INDEX`, which is history and describes what that step corrected. A step that leaves
/// `cards` alone entirely — v8, the deck tables, v9, the error log, v11, the marketplace price
/// tables, and v14, the oracle-tag tables — neither needs the list nor may replay it, and none
/// of them takes the title of newest creator.
const CARDS_INDEXES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS {schema}.idx_cards_oracle ON cards(oracle_id)",
    "CREATE INDEX IF NOT EXISTS {schema}.idx_cards_set_cn ON cards(set_code, collector_number)",
    "CREATE INDEX IF NOT EXISTS {schema}.idx_cards_name ON cards(name)",
    // The collapsed search's whole cost model. Its group step reads `oracle_id` in group
    // order and finds every other column it needs inside the index, so the scan is
    // *covering*: 108 ms for the default collapsed browse against 767 ms without it,
    // measured 2026-08-11 over the live 107 337-row paper corpus. 14 MB, and 0.7 s added to
    // a 92–99 s sync.
    //
    // The column order is load-bearing and the trailing four are not decoration — drop one
    // and the scan stops covering. Widening it further with `rarity`/`set_code`/`type_line`
    // was built and measured, and is a straight loss: it made the name sort 38 → 61 ms and
    // left the sorts it was meant to help unchanged, because those cost row lookups rather
    // than index reads.
    //
    // **The trailing three are the filter columns, and they are why a *filtered* browse is
    // cheap.** Without them every filter the search offers — format, colours, mana value —
    // knocks the group scan off this index and into row lookups: 455–505 ms against
    // 22–47 ms with them. They cost +0.89 MB (13.45 → 14.34 MB) and 4 ms on the *unfiltered*
    // browse, which is the trade. **Measured 2026-08-11 through `node:sqlite`, against a
    // page-for-page online backup of the live database** — the build behind a figure like
    // this is SQLite's own C, identical under a debug or a release crate, so the fixture is
    // what needs naming rather than a cargo profile.
    //
    // `legal_mask` and not `legalities`: a JSON path is not indexable, which is the whole
    // reason [`crate::legalities`] exists.
    "CREATE INDEX IF NOT EXISTS {schema}.idx_cards_collapse \
     ON cards(oracle_id, is_paper, released_at, id, name, price_usd, \
              legal_mask, cmc, color_identity)",
    // Art tags key on `illustration_id` — an art tag is a fact about a *picture*, so the
    // printings it belongs to are the ones carrying that picture — and the column had no index
    // until v20. A loop of 50 k point lookups on it against the 609 MB dev database did not
    // finish in five minutes (measured 2026-08-20, debug). 111 735 of 116 712 printings carry
    // one, so this is close to a full second copy of the column rather than a sparse index.
    //
    // In this list rather than in the v20 step, for the reason the list exists: `swap_staging`
    // drops and recreates `cards` on every sync, so an index declared only in a migration is
    // an index the app has until the next morning — and the failure is silent, because nothing
    // becomes wrong, only slow.
    "CREATE INDEX IF NOT EXISTS {schema}.idx_cards_illustration ON cards(illustration_id)",
];

/// [`CARDS_INDEXES`] as one executable batch, over one schema.
///
/// **A bare `CREATE INDEX` lands in `main`, whatever file the table is in.** The ladder is
/// the one caller that means `main` — it builds a single pre-split file and nothing else —
/// and [`swap_staging`] means [`CORPUS`], which is where `cards` has lived since schema 27.
fn cards_indexes_sql(schema: &str) -> String {
    on_schema(schema, &(CARDS_INDEXES.join(";\n") + ";"))
}

/// Resolve a DDL literal written against `{schema}` onto one file.
///
/// **Only DDL and pragmas need this.** An unqualified `SELECT`/`INSERT`/`UPDATE`/`DELETE`
/// resolves into whichever attached database holds the table — measured — which is why none
/// of the ~136 commands changed when the corpus moved out. A bare `CREATE`, `DROP`, `ALTER`
/// or `PRAGMA` does not: every one of them means `main` and says nothing about it.
fn on_schema(schema: &str, sql: &str) -> String {
    sql.replace("{schema}", schema)
}

/// The image variants stored as real columns, WEBP only.
///
/// Scryfall's `image_uris` carries eleven keys; seven of them are the legacy JPG/PNG
/// family the docs mark as *replaced*, and `png` alone would be 161 GB across the
/// library. Storing four of eleven keeps the column at roughly 400 bytes a row (~47 MB
/// over 116 k printings) instead of 1.3 KB, and `raw` still holds every key that was
/// dropped, so nothing is unrecoverable.
pub const IMAGE_VARIANTS: [&str; 4] = ["thumb", "grid", "display", "art"];

/// `json_object('thumb', json_extract(<src>, '$.image_uris.thumb'), …)` for the four
/// variants. Built rather than written out so the list has one definition.
fn webp_json_object(src: &str) -> String {
    let pairs: Vec<String> = IMAGE_VARIANTS
        .iter()
        .map(|k| format!("'{k}', json_extract({src}, '$.image_uris.{k}')"))
        .collect();
    format!("json_object({})", pairs.join(", "))
}

/// `raw` as JSON text, or NULL when it is not JSON at all. **Every migration step that
/// reads `raw` reads it through this.**
///
/// From the first post-v3 sync `raw` is a gzip BLOB (see [`crate::card_row::gzip_raw`]),
/// and SQLite reads a BLOB argument to `json_extract`/`json_type`/`json_each` as JSONB —
/// a gzip member is not valid JSONB, so the call is a hard `malformed JSON` **error** that
/// fails the whole migration, not the NULL one might expect.
///
/// Three things about the shape, each of them the reason for the next:
/// * The guard is a `CASE`, because only `CASE` promises to evaluate one branch.
/// * The `CASE` wraps the **argument**, not the call, so the same expression serves
///   `json_each` in a `FROM` clause, where there is no call to wrap. Every JSON function
///   answers NULL — or no rows — to a NULL argument, which is what makes that work.
/// * It is not a `WHERE` term. `WHERE json_valid(raw) AND json_extract(raw, …)` looks
///   equivalent and is not: the planner orders `WHERE` terms as it likes, so evaluating
///   the unguarded one *is* the error.
///
/// No database can be in that state when these steps run — one with gzip rows is already
/// past v3 — but the guard is what makes that a fact rather than an argument.
/// `the_v3_backfill_steps_over_a_row_whose_raw_is_not_json` walks the whole ladder over
/// such a row, which is why v2 is guarded too and not only the step that introduced gzip.
fn json_raw(col: &str) -> String {
    format!("CASE WHEN json_valid(CAST({col} AS TEXT)) = 1 THEN CAST({col} AS TEXT) END")
}

/// The last shape of the database that was one file.
///
/// [`migrate_single_file`] climbs to exactly this and stops, and what
/// `migrate_is_idempotent_and_creates_tables` pins. Named because a great many tests all
/// have to mean the same number.
///
/// **No migration step writes this constant.** Each step ends with the literal version it
/// produces (`PRAGMA user_version = 3;` in the v3 step, and so on), because a step that
/// wrote *head* would commit "fully migrated" before the steps after it had run — and
/// would keep the version assertion passing while doing it. This constant is the thing
/// tests compare against, not the thing steps write.
///
/// It is frozen: no rung of that ladder is ever edited again, for [`CARDS_COLUMNS`]'s
/// reason — a migration step is history, and a step edited today changes what a *fresh*
/// install created yesterday.
pub const LEGACY_SINGLE_FILE_VERSION: i64 = 26;

/// `user.db`'s version, continuing the number line the single file was on.
///
/// 27 is the rung that *is* the split: a database carrying it has had its corpus taken out.
/// The user's ladder can never restart, because its rungs describe rows nothing else can
/// produce.
pub const USER_SCHEMA_VERSION: i64 = 27;

/// `corpus.db`'s version, on a number line of its own.
///
/// Deliberately incomparable with [`USER_SCHEMA_VERSION`]: the two answer different questions.
/// A user version is "what has been done to rows that exist nowhere else". A corpus version is
/// "is this file's shape what this build expects", and a corpus rung is *allowed* to give up
/// and rebuild, because what is behind it is a download. Sharing a scale would invite somebody
/// to subtract them.
pub const CORPUS_SCHEMA_VERSION: i64 = 1;

/// Which of the two files a table lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// The reader authored it. Nothing outside this app can produce it again, and losing it
    /// is losing it.
    User,
    /// A feed or this app's own migration ladder can produce it again with no user input, for
    /// the price of a download.
    Corpus,
}

/// Every table in the schema and the file it belongs in.
///
/// **The question is "can this be produced again with no user input?", and it is not the same
/// question as "does this sync"** — `deck_undo` does not sync and is unquestionably the
/// reader's; `app_meta` splits per key for sync and does not split at all for storage.
///
/// Written as a list rather than a rule so that a table added by a later rung is a red test
/// with an obvious remedy, rather than a table that quietly lands in whichever file its DDL
/// was unqualified in. `every_table_is_on_exactly_one_side` is what keeps it honest.
pub const TABLES: &[(&str, Side)] = &[
    // ---- the reader's ----
    ("app_meta", Side::User),
    // Scryfall's rows, but the table's *job* is "which of these have I applied to my own
    // collection". A corpus rebuild that emptied it would re-apply every fold and double
    // quantities — `crate::reconcile::apply` says so at its `SELECT 1 FROM card_migrations`.
    ("card_migrations", Side::User),
    ("collection_entries", Side::User),
    ("collection_folders", Side::User),
    ("deck_audit", Side::User),
    ("deck_cards", Side::User),
    ("deck_categories", Side::User),
    ("deck_folders", Side::User),
    // One app-wide list keyed on `name_key` since v21 — no `deck_id`.
    ("deck_tags", Side::User),
    ("deck_undo", Side::User),
    ("decks", Side::User),
    // Per-device and never synced, but nothing rebuilds it either — and it is the record of
    // *why* somebody might be about to throw the corpus away.
    ("error_log", Side::User),
    // A decision a person made about a tag. `WITHOUT ROWID`, so the update hook cannot see it
    // — see `crate::mirror::watch::install_hook`.
    ("muted_tags", Side::User),
    ("wishlist_entries", Side::User),
    ("wishlist_folders", Side::User),
    // ---- rebuildable ----
    ("art_tag_illustrations", Side::Corpus),
    ("art_tag_meta", Side::Corpus),
    ("art_tag_parents", Side::Corpus),
    ("art_taggings", Side::Corpus),
    ("art_tags", Side::Corpus),
    ("cards", Side::Corpus),
    // FTS5's own four shadow tables plus the virtual table. They must sit beside `cards`:
    // an external-content index resolves `content='cards'` in *its own schema*.
    ("cards_fts", Side::Corpus),
    ("cards_fts_config", Side::Corpus),
    ("cards_fts_data", Side::Corpus),
    ("cards_fts_docsize", Side::Corpus),
    ("cards_fts_idx", Side::Corpus),
    ("combo_cards", Side::Corpus),
    ("combo_meta", Side::Corpus),
    ("combos", Side::Corpus),
    // Seeded by the ladder rather than by a feed, which is a cheaper rebuild still. No user
    // table declares a key to it — `decks.format_key` is a soft reference.
    ("format_specs", Side::Corpus),
    ("image_cache", Side::Corpus),
    ("marketplace_feed_meta", Side::Corpus),
    ("marketplace_prices", Side::Corpus),
    ("oracle_tag_cards", Side::Corpus),
    ("oracle_tag_meta", Side::Corpus),
    ("oracle_tag_parents", Side::Corpus),
    ("oracle_taggings", Side::Corpus),
    ("oracle_tags", Side::Corpus),
    ("sets", Side::Corpus),
    ("sync_meta", Side::Corpus),
];

/// Which file `table` belongs in, or `None` for a name the schema does not create — a staging
/// table, or a typo.
pub fn side_of(table: &str) -> Option<Side> {
    TABLES.iter().find(|(n, _)| *n == table).map(|(_, s)| *s)
}

/// What makes two collection rows the *same* row, as one SQL fragment.
///
/// Written once because it is used twice and the two uses must agree exactly: the UNIQUE
/// index that enforces the grain, and the `ON CONFLICT(…)` target of every quick-add. A
/// conflict target that does not match an index verbatim is not a compile error, it is a
/// runtime "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
///
/// The `coalesce`s are the reason this is not just a column list. SQLite treats NULLs in a
/// UNIQUE index as *distinct*, so a nullable column in the grain is a column that stops
/// enforcing anything the moment it is empty — which for `serial_number` (NULL on every
/// card that is not serialized, i.e. nearly all of them) would mean no grain at all.
///
/// # `grading` enters identity as **raw text**
///
/// It is compared byte for byte, not as JSON, so `{"company":"PSA","grade":10}` and
/// `{"grade":10,"company":"PSA"}` are two different graded copies of the same card. Anything
/// that writes this column therefore serializes through the one fixed-field struct that owns
/// the shape — never a hand-built string, never a map with non-deterministic key order.
/// Get that wrong and the same physical card forks into a new row on every edit, silently,
/// with no constraint anywhere to catch it. (`json_valid` is enforced by the table's CHECK;
/// *canonical* is enforced by nothing but this rule.)
///
/// # The eleventh term is what makes "Add to" an *add*
///
/// `folder_id` joined the grain at schema v24, for the reason it joined [`WISHLIST_GRAIN`] at
/// v23 and with the same words: without it, adding a printing the reader already owns into a
/// folder would land on the row they already had and simply raise its quantity — the copies
/// would appear to *move*, out of wherever they were filed and into the folder being pointed
/// at, and a filing decision made last week would be undone by an add made today. With it, the
/// same printing in two folders is two rows, and moving copies between folders is a separate
/// and explicit act rather than a side effect of adding.
///
/// `coalesce(folder_id, 0)` can never collide with a real folder, because
/// `collection_folders.id` is `INTEGER PRIMARY KEY` and SQLite never auto-assigns rowid 0. It
/// is a `coalesce` for the two terms above it's reason: NULL is the root, the root is where
/// most cards live, and NULLs in a UNIQUE index are *distinct* — so an un-coalesced term would
/// stop enforcing anything for exactly the rows that need it most.
pub const COLLECTION_GRAIN: &str = "card_id, finish, condition, lang, altered, signed, proxy, \
     misprint, coalesce(serial_number, ''), coalesce(grading, ''), coalesce(folder_id, 0)";

/// What a collection folder can *be*, CHECK-constrained on `collection_folders.kind`.
///
/// `user` is a folder the reader made and named. `deck` is the one folder that stands for a
/// deck, and carries `deck_id`; `removed` is the single folder cards go to when they leave the
/// collection without leaving the database. Both of the latter are at most one row each — the
/// two partial unique indexes v24 creates are what say so — and both are named here so nothing
/// has to spell the words a second time.
///
/// The v24 DDL spells the three words out rather than interpolating this constant, for the
/// reason [`CARDS_COLUMNS`] is frozen and [`CATEGORY_KINDS`] repeats: a migration step is
/// history, and a fourth kind is a new migration step rather than an edit here.
pub const COLLECTION_FOLDER_KINDS: [&str; 3] = ["user", "deck", "removed"];

/// The wishlist's grain: an oracle card, optionally pinned to one printing and one finish,
/// **in one folder**. `card_id IS NULL` means "any printing" (spec §6), which is a different
/// wish from a specific one rather than a looser version of it.
///
/// # The fourth term is what makes "Add to" an *add*
///
/// `folder_id` joined the grain at schema v23. Without it, adding a card the reader already
/// wishes for into a folder would land on the row they already had and simply raise its
/// quantity — the wish would appear to *move*, from wherever it was filed into the folder
/// they were pointing at, and a filing decision they made last week would be undone by an
/// add they made today. With it, the same card in two places is two wishes, and moving one
/// between folders is a separate and explicit act (`wishlist_set_folder`) rather than a side
/// effect of shopping.
///
/// `coalesce(folder_id, 0)` is safe — it can never collide with a real folder — because
/// `wishlist_folders.id` is `INTEGER PRIMARY KEY`, which SQLite never assigns 0. It is a
/// `coalesce` for [`COLLECTION_GRAIN`]'s reason: NULL is the root, the root is where most
/// wishes live, and NULLs in a UNIQUE index are *distinct*, so an un-coalesced term would
/// stop enforcing anything for exactly the rows that need it most.
pub const WISHLIST_GRAIN: &str = "coalesce(oracle_id, ''), coalesce(card_id, ''), \
     coalesce(preferred_finish, ''), coalesce(folder_id, 0)";

/// The five rules roles a deck category can carry, spec §6 verbatim — the same five words
/// `deck_cards.zone` held before schema v8 replaced the zone with a category the user owns.
/// CHECK-constrained on `deck_categories.kind` and mirrored in TS.
///
/// The v8 DDL spells the five words out rather than interpolating this constant, for the
/// reason [`CARDS_COLUMNS`] is frozen: a migration step is history. Editing this list would
/// silently rewrite the CHECK a *fresh* install creates while every upgraded database kept
/// the old one, and the two would then disagree about what a category's kind can be. A
/// sixth kind is a new migration step. What this constant is for is everything that is not
/// history — the TypeScript mirror, and
/// `a_category_kind_is_one_of_the_five_and_predefined_names_round_trip`, which walks it
/// against the live CHECK so the copies cannot drift apart unnoticed, exactly as
/// `DECK_ZONES` and its CHECK never did.
pub const CATEGORY_KINDS: [&str; 5] = ["main", "side", "commander", "companion", "maybe"];

/// The one predefined category per non-`main` kind, seeded once per deck as `(kind, name,
/// is_active)`. `main` has no row here: a user-made category is always kind `main`, and a
/// deck can own any number of them, so there is nothing singular about `main` to
/// predefine — it is the four *fixed* rules roles that get one guaranteed category each.
///
/// `is_active` is where "counts toward nothing" is decided: `maybe` is seeded `false` and
/// the other three `true`, which is the whole of what used to make the scratchpad a special
/// case scattered across five files — it is now one seeded row like any other, and every
/// reader that used to ask "is this the maybe zone?" asks "is this category active?" instead.
///
/// Nothing in the v8 migration reads this constant: the backfill below is history, frozen
/// like [`CATEGORY_KINDS`]'s DDL, and points at its own literal strings rather than at
/// something later code could change out from under it. This constant is for
/// `deck_meta::ensure_predefined_categories`, which creates these four rows for every deck
/// from here on.
pub const PREDEFINED_CATEGORIES: [(&str, &str, bool); 4] = [
    ("commander", "Commander", true),
    ("side", "Sideboard", true),
    ("companion", "Companion", true),
    ("maybe", "Maybeboard", false),
];

/// What makes two deck-card rows the same row: one printing, in one category, in one
/// variant, of one deck.
///
/// Written once for [`COLLECTION_GRAIN`]'s reason — the UNIQUE index and every
/// `ON CONFLICT(…)` target must match verbatim, and a target that matches no index is a
/// runtime error at the first quick-add rather than a compile error.
///
/// **`coalesce(finish, '')` is [`COLLECTION_GRAIN`]'s device, for its reason** (v19).
/// `deck_cards.finish` is nullable — NULL is the regular copy, and `'nonfoil'` is never
/// stored — and SQLite treats NULLs in a UNIQUE index as *distinct*, so the bare column
/// would enforce nothing at all: every regular add would insert a new row rather than
/// folding into the one already there. It is the third widening of this grain, for
/// `category_id`'s and `variant`'s reason — a foil copy and a regular copy of one printing
/// are two intentions, not one row that changed.
///
/// `category_id` is *in* the grain for exactly `zone`'s old reason: the same printing filed
/// under the main deck and under the Maybeboard is two intentions, not one row that moved —
/// only now that is read off a category the user can rename rather than off a fixed word.
/// `variant` is new in v8 and widens the grain again: the same printing can sit in the
/// `live` deck and the `theory` one at once, and an edit made while trying out a change must
/// never fold into the row the deck is actually sleeved as.
///
/// **No migration step reads this, or any other grain constant.** Every grain index in the
/// DDL is spelled out as a literal, because a step is history the day it ships and must keep
/// building the index it built then — this constant has already changed once (v8 is the
/// change) and, until v5 was frozen, that rewrote what v5 had built. What holds the constant
/// and the head schema's index together is
/// `every_plain_grain_constant_names_the_index_the_head_schema_carries`, plus every
/// `ON CONFLICT ({DECK_CARD_GRAIN})` target in [`crate::deck`], [`crate::deck_meta`] and
/// [`crate::deck_theory`] — a target matching no index is a runtime error at the first write.
pub const DECK_CARD_GRAIN: &str = "deck_id, variant, category_id, card_id, coalesce(finish, '')";

/// What makes two category rows the same row: one name per deck. This is a different
/// uniqueness question from [`PREDEFINED_CATEGORIES`]'s "at most one predefined row per
/// kind per deck" (`idx_deck_categories_kind`, a *partial* index over `kind <> 'main'`) — a
/// user is free to name a category of their own "Sideboard" too, and that collides with
/// nothing on this grain, because the predefined Sideboard was never named by the user.
///
/// Read by no SQL at all — see [`DECK_CARD_GRAIN`] for why the v8 DDL spells its index out,
/// and for the test that keeps this constant honest about what that index holds.
pub const DECK_CATEGORY_GRAIN: &str = "deck_id, name";

/// What makes two tag rows the same row: **one name, app-wide** — no deck in it at all.
///
/// It was `deck_id, name` until schema v21, which is the shape [`DECK_CATEGORY_GRAIN`] still
/// has and the reason the two used to read alike. A category says *where in a deck* a card
/// lives, so it is a thing the deck owns; a tag says what the reader thinks of a card, and a
/// reader who has decided what "Cut candidate" means did not decide it per deck. So a tag is
/// one row shared by every deck that uses it, and recolouring it recolours it everywhere.
///
/// **`name_key` rather than `name`**, because the answer this grain has to give is "is that the
/// same label", and two spellings of one word are. The key is [`tag_name_key`]'s: NFC, Unicode
/// lowercase, NFC again. It is computed in Rust and stored because SQLite cannot answer it —
/// `COLLATE NOCASE` folds ASCII and nothing else, and the bundled build carries no Unicode
/// normalisation at all.
///
/// Read by no SQL at all, like [`DECK_CATEGORY_GRAIN`].
pub const DECK_TAG_GRAIN: &str = "name_key";

/// What makes two tag names the same name — [`DECK_TAG_GRAIN`]'s value, computed.
///
/// Three passes, and each one answers a way two labels a reader cannot tell apart would
/// otherwise be two rows:
///
/// * **NFC** folds a combining accent onto the letter before it, so `Cafe` + U+0301 and the
///   precomposed `Café` are one string. Both are typeable; which one arrives depends on the
///   reader's keyboard and operating system, not on what they meant.
/// * **`to_lowercase`** is the case-insensitive half the issue asks for, and it is the full
///   Unicode mapping rather than `to_ascii_lowercase` — `RAMPE` and `rampe` fold, and so do
///   `İ` and the Greek sigma's two lowercase forms.
/// * **NFC again**, because lowercasing can un-normalise: a handful of codepoints map to
///   sequences that are not in composed form. Without the second pass those names would key to
///   something no re-normalised lookup ever matches again.
///
/// Trimmed first, for the reason `valid_name` trims: a name is what a reader typed minus the
/// whitespace they did not mean.
///
/// **Not a colour and not a display name.** The key is never shown and never written back to
/// `deck_tags.name`, which keeps whatever capitals the reader chose — this answers only
/// "is that the same label", which is a question about identity rather than about spelling.
pub fn tag_name_key(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.trim()
        .nfc()
        .collect::<String>()
        .to_lowercase()
        .nfc()
        .collect()
}

/// The two decks every deck secretly is: `live`, what is actually sleeved up and playable,
/// and `theory`, what it is being built toward. CHECK-constrained on `deck_cards.variant`
/// and `deck_audit.variant`, and part of [`DECK_CARD_GRAIN`] — the reason a change tried out
/// in Theory is a different row from the Live one it is being tried against, never a draft
/// that could silently overwrite it.
///
/// **A theory list is a plan, and a plan holds no cards.** That sentence used to read
/// *"`deck::allocate_deck` reserves collection copies for `live` only"*, naming a function
/// schema v25 deleted along with the ledger it wrote. Nothing reserves anything now: a deck
/// holds a card because a `collection_entries` row sits in that deck's group, and the two
/// places that draw the conclusion for `theory` say so themselves — `deck::attribute_owned`
/// zeroes every theory row explicitly, and
/// [`crate::collection_alloc::THEORY_HOLDS_NOTHING`] refuses to move copies for one.
pub const DECK_VARIANTS: [&str; 2] = ["live", "theory"];

/// Where a card can be played, as Scryfall spells it — the vocabulary of `cards.games` and,
/// from schema v18, of a `format_specs.games` cell.
///
/// **Three words and not four**, because these are Scryfall's own and the corpus already uses
/// them: a format's answer and a printing's answer are then the same string, which is what
/// would let a future filter compare them without a translation table in between. A fourth
/// platform is a word no card in this database carries.
///
/// Stored as a **comma-joined list in one cell** rather than as a `format_games` table. The
/// list is read whole, by TypeScript, for every row at once — `format_specs` is handed to the
/// engine entire and has been since spec §6 — so a join would answer the same fact in two
/// queries and split one format's rules across two places. `a_format_spec_games_cell_holds_
/// only_scryfall_game_words` is what keeps the cells inside this vocabulary, since no CHECK
/// can (the column arrives by `ALTER TABLE … ADD COLUMN`).
pub const GAMES: [&str; 3] = ["paper", "arena", "mtgo"];

/// What `decks.game_key` may hold: [`GAMES`], plus the word for a deck that has not been
/// pinned to a platform.
///
/// **`any` is a stored sentinel rather than a NULL**, and for [`crate::deck::AUTO_CATEGORY`]'s
/// reason exactly: [`crate::deck::DeckPatch`] writes `coalesce(?n, column)`, so a bound NULL
/// means *leave it* and a nullable column could never have said "back to Any" without a
/// command of its own — the price `decks.folder_id` pays through `deck::set_folder`. It is
/// first in the list because it is the column's DDL default and what every deck is born as.
///
/// The three after it are [`GAMES`] in order, which
/// `the_deck_game_vocabulary_is_any_plus_the_scryfall_games` pins — two arrays that must not
/// drift, written out rather than concatenated because a `const` cannot concatenate.
pub const DECK_GAMES: [&str; 4] = ["any", "paper", "arena", "mtgo"];

/// Scryfall's finish enum. Never a boolean — `etched` is a third thing, and collapsing it
/// into `foil: true` is the single most common way an importer loses data.
///
/// CHECK-constrained on `collection_entries.finish`, `wishlist_entries.preferred_finish`
/// (which is additionally nullable, meaning "any") and `marketplace_prices.finish`. All
/// three spell the list out in their own DDL for [`CATEGORY_KINDS`]' reason — a step is
/// history — and `a_finish_is_one_of_the_three_on_every_table_that_checks_it` is what keeps
/// the copies honest. A fourth finish is a new migration step, never an edit here.
///
/// **The order is load-bearing**: it is `nonfoil → foil → etched`, cheapest first, which is
/// the order [`crate::sorting::finish_literals`] builds a price chain in and the field order
/// of the card pane's `FinishPrices`. Here rather than in [`crate::collection`], where it
/// began, because `sorting`, `card` and `marketplace_feed` all need it and none of them owns
/// a collection — it is a schema vocabulary like the four above it.
pub const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];

/// What a `deck_audit` row can record, CHECK-constrained on `deck_audit.kind`. Rust records
/// which of these happened and the facts a sentence needs (`payload`, `delta`); TypeScript
/// owns turning that into the sentence a person reads on the history drawer, because a
/// sentence is domain logic and this table has to survive the day the wording changes.
pub const AUDIT_KINDS: [&str; 9] = [
    "add", "remove", "quantity", "move", "swap", "tag", "category", "folder", "deck",
];

// `ALLOCATION_GRAIN` — `deck_id, collection_entry_id`, one deck's claim on one collection
// row — stood here until schema v25 dropped `deck_allocations` with the whole idea of a
// claim. A deck no longer reserves copies it does not hold: the copies sit in that deck's
// group, so "which deck holds this card" is a `collection_entries.folder_id` and the grain
// that answers it is [`COLLECTION_GRAIN`]'s eleventh term. Nothing replaces this constant,
// which is why the space it left is a comment rather than a rename.

/// The format rules as DATA (spec §6), so a rules change is an UPDATE and not a release,
/// and the validation engine reads rules rather than embodying them.
///
/// Source of every cell: `docs/superpowers/research/2026-08-04-mtg-domain-rules.md` — its
/// format table, TRAP A, and the CR citations there. Columns, in the order below:
/// (key, display_name, picker, deck_min, deck_max, copies, sb, singleton, cmdr,
///  cmdr_rule, life, restricted, has_legality, max_mv, companion_ok, sort)
///
/// The 23 keys are Scryfall's legality keys **in the order it emits them**, then the two
/// pseudo-formats. `INSERT OR REPLACE`, so a future correction is a new migration step
/// re-running this same constant over the rows a user already has.
///
/// # What the numbers mean
///
/// * `deck_min`/`deck_max` count the **`main` + `commander` zones together** — "exactly 100
///   incl cmdr", "exactly 60 incl OB + signature spell" (Oathbreaker's planeswalker and its
///   signature spell both live in the `commander` zone). `deck_max` NULL is CR 100.5: a
///   60-card format has a minimum and no maximum.
/// * The **companion never counts toward deck size**: EDH's is "effectively a 101st card".
///   Whether it costs a *sideboard* slot is read from `sideboard_max` and never from the
///   key: where the format has a sideboard (Modern's 15, Tiny Leaders' 10) the companion
///   occupies one of its slots and is counted against that cap, and where `sideboard_max`
///   is 0 — Commander, all three Brawls, Oathbreaker, Pauper Commander, Duel, PreDH and
///   Gladiator — it is simply an extra card, EDH-style. (Gladiator is the row where
///   `allows_companion` is 0 as well: no sideboard, so no companion at all — the research
///   doc's own note. The other eight allow one.) Standard Brawl is the row that makes the
///   distinction visible: a 60-card format with no sideboard at all, so "in a 60-card format
///   it takes a sideboard slot" would be the wrong rule. `validation/engine.ts` reads the
///   cells this way.
/// * `sideboard_max` 0 means *no sideboard*; NULL means *uncapped* (Limited plays the rest
///   of its pool). `max_copies` NULL means unlimited — the two pseudo-formats only.
/// * `restricted_semantic` is TRAP A and is never inferred from the key: `restricted` means
///   max one copy in vintage/timeless/oldschool and **banned as commander** in the two
///   singleton formats that use it, duel and tlr.
/// * `predh` carries `'edh'` as its commander rule on purpose. The 2026 Vehicle/Spacecraft
///   clause is harmless there because the `predh` legality key already excludes everything
///   after 2011 — the pool check does the narrowing. That is not deriving one format from
///   another (this seed never copies a *legality*); it is two formats genuinely sharing one
///   eligibility rule.
/// # This constant is **history**, and [`FORMAT_SPECS_SEED`] is the one to edit
///
/// It is what the v5 step wrote, frozen there for [`CARDS_COLUMNS`]'s reason: a fresh install
/// replays the whole ladder, so v5 runs before v18's `games` column exists and a statement here
/// naming that column would fail on new machines only. The head seed carries every cell this
/// one does plus `games`, and v18 re-runs it over these rows.
const FORMAT_SPECS_SEED_V5: &str = "INSERT OR REPLACE INTO format_specs
    (key, display_name, enabled_in_picker, deck_min, deck_max, max_copies, sideboard_max,
     singleton, requires_commander, commander_rule, life, restricted_semantic,
     has_legality_data, max_mana_value, allows_companion, sort_order) VALUES
    ('standard',        'Standard',             1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 1),
    ('future',          'Future Standard',      0, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 2),
    ('historic',        'Historic',             1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 3),
    ('timeless',        'Timeless',             1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 4),
    ('gladiator',       'Gladiator',            1, 100, NULL, 1,    0,    1, 0, NULL,          20, 'max_one',             1, NULL, 0, 5),
    ('pioneer',         'Pioneer',              1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 6),
    ('modern',          'Modern',               1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 7),
    ('legacy',          'Legacy',               1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 8),
    ('pauper',          'Pauper',               1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 9),
    ('vintage',         'Vintage',              1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 10),
    ('penny',           'Penny Dreadful',       1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 11),
    ('commander',       'Commander',            1, 100, 100,  1,    0,    1, 1, 'edh',         40, 'max_one',             1, NULL, 1, 12),
    ('oathbreaker',     'Oathbreaker',          1, 60,  60,   1,    0,    1, 1, 'oathbreaker', 20, 'max_one',             1, NULL, 1, 13),
    ('standardbrawl',   'Standard Brawl',       1, 60,  60,   1,    0,    1, 1, 'brawl',       25, 'max_one',             1, NULL, 1, 14),
    ('brawl',           'Brawl',                1, 100, 100,  1,    0,    1, 1, 'brawl',       25, 'max_one',             1, NULL, 1, 15),
    ('competitivebrawl','Competitive Brawl',    1, 100, 100,  1,    0,    1, 1, 'brawl',       25, 'max_one',             1, NULL, 1, 16),
    ('alchemy',         'Alchemy',              1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 17),
    ('paupercommander', 'Pauper Commander',     1, 100, 100,  1,    0,    1, 1, 'pdh',         30, 'max_one',             1, NULL, 1, 18),
    ('duel',            'Duel Commander',       1, 100, 100,  1,    0,    1, 1, 'duel',        20, 'banned_as_commander', 1, NULL, 1, 19),
    ('oldschool',       'Old School',           1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 20),
    ('premodern',       'Premodern',            1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 21),
    ('predh',           'PreDH',                1, 100, 100,  1,    0,    1, 1, 'edh',         40, 'max_one',             1, NULL, 1, 22),
    ('tlr',             'Tiny Leaders: Reborn', 1, 50,  50,   1,    10,   1, 1, 'tlr',         20, 'banned_as_commander', 1, 3,    1, 23),
    ('casual',          'Casual',               1, 0,   NULL, NULL, NULL, 0, 0, NULL,          20, 'max_one',             0, NULL, 1, 24),
    ('limited',         'Limited',              1, 40,  NULL, NULL, NULL, 0, 0, NULL,          20, 'max_one',             0, NULL, 1, 25);";

/// The format rules **at head** — [`FORMAT_SPECS_SEED_V5`] plus the `games` cell v18 added,
/// and the constant a future correction re-runs.
///
/// Every other cell is byte-identical to the frozen copy above, deliberately: this is that
/// statement with one column, not a second opinion about the other fifteen. What the two must
/// never do is disagree, and `the_head_format_seed_agrees_with_v5_on_every_shared_cell` is what
/// says so — it walks both into two databases and compares them column by column.
///
/// # What `games` means
///
/// Which platforms a person can actually play the format on, as a comma-joined list of
/// [`GAMES`] words. A **fact about the format**, which is why it is a seeded cell rather than a
/// map in TypeScript: the crate's rule is that `format_specs` is data and a new format is a
/// row. The deck picker filters on it and draws no conclusion Rust has not been told.
///
/// The four groups, and the reasoning behind the ones that are not obvious:
///
/// * **All three** — Standard, Future Standard, and the two pseudo-formats. `casual` and
///   `limited` are judged against no card pool at all (`has_legality_data = 0`), so pinning
///   either to a platform would be inventing a rule; the widest answer is the honest one and
///   is also the DDL default, so a row that somehow escapes this seed is never hidden by the
///   filter. **Failing open is the rule here**, exactly as it is for the Oracle tags.
/// * **Arena only** — Historic, Timeless, Gladiator, Alchemy and all three Brawls. These are
///   Arena's own formats; the digital-only cards in them (`alchemy` rebalances) exist in no
///   paper printing.
/// * **Paper and MTGO** — Pioneer, Modern, Legacy, Pauper, Vintage. Arena's nearest thing to
///   Pioneer is Explorer, which is a **different card pool** and a format of its own; treating
///   Pioneer as an Arena format would offer a reader cards Arena has never had.
/// * **MTGO only** — Penny Dreadful, whose legality is defined by MTGO ticket prices.
/// * **Paper only** — the eight singleton and eternal formats: Commander, Oathbreaker, Pauper
///   Commander, Duel Commander, Old School, Premodern, PreDH, Tiny Leaders. **Three of those
///   are judgement calls and are named so that changing one is a decision rather than a
///   discovery**: Commander, Pauper Commander and Premodern all get played on MTGO, in casual
///   rooms and unsanctioned leagues, and this seed reads "sanctioned format" rather than "has
///   ever been cast there". Correcting one is a new migration step re-running this constant,
///   which is the whole reason the cells live here.
const FORMAT_SPECS_SEED: &str = "INSERT OR REPLACE INTO format_specs
    (key, display_name, enabled_in_picker, deck_min, deck_max, max_copies, sideboard_max,
     singleton, requires_commander, commander_rule, life, restricted_semantic,
     has_legality_data, max_mana_value, allows_companion, sort_order, games) VALUES
    ('standard',        'Standard',             1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 1,  'paper,arena,mtgo'),
    ('future',          'Future Standard',      0, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 2,  'paper,arena,mtgo'),
    ('historic',        'Historic',             1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 3,  'arena'),
    ('timeless',        'Timeless',             1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 4,  'arena'),
    ('gladiator',       'Gladiator',            1, 100, NULL, 1,    0,    1, 0, NULL,          20, 'max_one',             1, NULL, 0, 5,  'arena'),
    ('pioneer',         'Pioneer',              1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 6,  'paper,mtgo'),
    ('modern',          'Modern',               1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 7,  'paper,mtgo'),
    ('legacy',          'Legacy',               1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 8,  'paper,mtgo'),
    ('pauper',          'Pauper',               1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 9,  'paper,mtgo'),
    ('vintage',         'Vintage',              1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 10, 'paper,mtgo'),
    ('penny',           'Penny Dreadful',       1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 11, 'mtgo'),
    ('commander',       'Commander',            1, 100, 100,  1,    0,    1, 1, 'edh',         40, 'max_one',             1, NULL, 1, 12, 'paper'),
    ('oathbreaker',     'Oathbreaker',          1, 60,  60,   1,    0,    1, 1, 'oathbreaker', 20, 'max_one',             1, NULL, 1, 13, 'paper'),
    ('standardbrawl',   'Standard Brawl',       1, 60,  60,   1,    0,    1, 1, 'brawl',       25, 'max_one',             1, NULL, 1, 14, 'arena'),
    ('brawl',           'Brawl',                1, 100, 100,  1,    0,    1, 1, 'brawl',       25, 'max_one',             1, NULL, 1, 15, 'arena'),
    ('competitivebrawl','Competitive Brawl',    1, 100, 100,  1,    0,    1, 1, 'brawl',       25, 'max_one',             1, NULL, 1, 16, 'arena'),
    ('alchemy',         'Alchemy',              1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 17, 'arena'),
    ('paupercommander', 'Pauper Commander',     1, 100, 100,  1,    0,    1, 1, 'pdh',         30, 'max_one',             1, NULL, 1, 18, 'paper'),
    ('duel',            'Duel Commander',       1, 100, 100,  1,    0,    1, 1, 'duel',        20, 'banned_as_commander', 1, NULL, 1, 19, 'paper'),
    ('oldschool',       'Old School',           1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 20, 'paper'),
    ('premodern',       'Premodern',            1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 21, 'paper'),
    ('predh',           'PreDH',                1, 100, 100,  1,    0,    1, 1, 'edh',         40, 'max_one',             1, NULL, 1, 22, 'paper'),
    ('tlr',             'Tiny Leaders: Reborn', 1, 50,  50,   1,    10,   1, 1, 'tlr',         20, 'banned_as_commander', 1, 3,    1, 23, 'paper'),
    ('casual',          'Casual',               1, 0,   NULL, NULL, NULL, 0, 0, NULL,          20, 'max_one',             0, NULL, 1, 24, 'paper,arena,mtgo'),
    ('limited',         'Limited',              1, 40,  NULL, NULL, NULL, 0, 0, NULL,          20, 'max_one',             0, NULL, 1, 25, 'paper,arena,mtgo');";

/// Bring `conn` up to the current schema version. Idempotent: tracked by
/// `PRAGMA user_version`, so a rerun on an up-to-date database changes nothing.
///
/// **A rerun is not quite a no-op, and that is deliberate**: the tail of this function replays
/// [`TAG_INDEXES_SQL`] unconditionally, outside the ladder. The comment there says why, and it
/// is a hang rather than a slow page that it prevents.
///
/// **Adding a column later:** leave [`CARDS_COLUMNS`] alone and add a new `if v < N`
/// block with an `ALTER TABLE cards ADD COLUMN`, the way `v < 2` and `v < 3` below do.
/// The v1 `CREATE` describes what version 1 built; a fresh install replays the whole
/// history, so a column added to v1 would make the later `ALTER` fail on new machines
/// only.
/// Schema v21's whole body: fold every deck's private tag list into one app-wide one.
///
/// ## What comes out
///
/// `deck_tags` loses `deck_id` and gains `name_key`, and its grain becomes [`DECK_TAG_GRAIN`]
/// — one row per name, app-wide. Two decks that both wrote "Removal" had two rows and have one
/// now, so every card that wore either wears the survivor.
///
/// ## Which row survives a merge, and why the loudest one wins
///
/// Most *copies* first (`sum(quantity)` over the cards wearing it, both variants and every
/// deck), then most recently touched, then lowest id. So the spelling and the colour that come
/// out are the ones the reader has seen most — a label on sixty cards keeps its red where a
/// two-card namesake in a deck opened once was blue. Ties fall to `updated_at` because the
/// later edit is the later decision, and to `id` last so the answer is deterministic on a
/// database where nothing else separates the two.
///
/// It is a real loss and worth naming at its least flattering: the losing colour is gone, and a
/// reader who genuinely wanted "Removal" red here and blue there cannot have that any more.
/// That is the feature rather than a side effect — one label, one colour, everywhere.
///
/// ## The rebuild, and the trap in it
///
/// `deck_cards.tag_id` is `REFERENCES deck_tags(id) ON DELETE SET NULL`, and under
/// `PRAGMA foreign_keys=ON` **`DROP TABLE` on a parent runs an implicit `DELETE FROM` that
/// fires exactly that action** — so the obvious build-swap-rename would untag every card in
/// every deck and leave a perfectly-shaped empty answer behind it. The pragma cannot be turned
/// off to dodge that: toggling `foreign_keys` is a documented no-op inside a transaction and
/// `migrate_single_file` is always inside one. (The v8 step says the same sentence from the other side,
/// where the table being dropped was the *child* and there was nothing to dodge.)
///
/// So the labels are carried across the drop by hand — `deck_tags_carry` holds
/// `(deck_cards.id, tag_id)` over the swap and is read back after it. It and `deck_tags_merge`
/// are both dropped before this returns: a migration that left its scaffolding behind would be
/// a table in a reader's database that nothing ever cleans up.
///
/// ## Every undo step is discarded, and that is not collateral
///
/// `deck_undo` rows name tag ids — `Op::Tags` directly, and every *card* step through
/// `CardRow::tag_id`, which is how undoing a move puts a card's label back. This rung deletes
/// the ids of merged-away rows, so such a step would restore a card's label as a foreign key
/// resolving to nothing. Worse, and reachable even where nothing merged at all: a step that
/// *restores* a deleted tag re-inserts a name another deck now holds, which the new grain
/// refuses — so the step fails at the moment the reader presses Ctrl+Z, having already applied
/// the ops recorded before it.
///
/// `deck_audit` is deliberately untouched, which is the half a reader can see: the history
/// still reads in full, and it is only the arrows that lose their charge, once, on the upgrade.
fn globalise_tags(tx: &Connection) -> rusqlite::Result<()> {
    // Everything the survivor pick needs, in one read: the row, and how many copies wear it.
    let rows: Vec<(i64, String, String, i64, i64, i64)> = tx
        .prepare(
            "SELECT t.id, t.name, t.color, t.created_at, t.updated_at,
                    coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                               WHERE dc.tag_id = t.id), 0)
               FROM deck_tags t
              ORDER BY t.id",
        )?
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // key -> the winning row so far. A `HashMap` rather than SQL because the key is
    // `tag_name_key`'s, which no SQLite build in this app can compute.
    let mut winner: HashMap<String, (i64, String, String, i64, i64, i64)> = HashMap::new();
    for row in rows.iter().cloned() {
        let key = tag_name_key(&row.1);
        match winner.get(&key) {
            // Copies, then `updated_at`, then the *lowest* id — hence the negation, so that one
            // comparison spells all three and they cannot drift apart.
            Some(held) if (held.5, held.4, -held.0) >= (row.5, row.4, -row.0) => {}
            _ => {
                winner.insert(key, row);
            }
        }
    }

    tx.execute_batch(
        "CREATE TABLE deck_tags_merge (old_id INTEGER PRIMARY KEY, new_id INTEGER NOT NULL);
         CREATE TABLE deck_tags_v21 (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            -- The uniqueness grain, and never shown to anyone: see `tag_name_key`.
            name_key TEXT NOT NULL,
            color TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );",
    )?;

    for (key, row) in &winner {
        // The survivor keeps its own id, so every `deck_cards.tag_id` and every audit row that
        // already named it still does.
        tx.execute(
            "INSERT INTO deck_tags_v21 (id, name, name_key, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![row.0, row.1, key, row.2, row.3, row.4],
        )?;
    }
    for row in &rows {
        tx.execute(
            "INSERT INTO deck_tags_merge (old_id, new_id) VALUES (?1, ?2)",
            params![row.0, winner[&tag_name_key(&row.1)].0],
        )?;
    }

    tx.execute_batch(
        "-- Every card onto its survivor, before anything is dropped.
         UPDATE deck_cards
            SET tag_id = (SELECT new_id FROM deck_tags_merge WHERE old_id = deck_cards.tag_id)
          WHERE tag_id IS NOT NULL;

         -- The labels, held by hand across the drop. See this function's doc: the drop below
         -- fires `ON DELETE SET NULL` on every one of them, and there is no pragma that can
         -- stop it from inside a transaction.
         CREATE TABLE deck_tags_carry AS
            SELECT id, tag_id FROM deck_cards WHERE tag_id IS NOT NULL;

         DROP TABLE deck_tags;
         ALTER TABLE deck_tags_v21 RENAME TO deck_tags;

         UPDATE deck_cards
            SET tag_id = (SELECT c.tag_id FROM deck_tags_carry c WHERE c.id = deck_cards.id)
          WHERE id IN (SELECT id FROM deck_tags_carry);

         DROP TABLE deck_tags_carry;
         DROP TABLE deck_tags_merge;

         -- The old grain index went down with the table it was on. Frozen as a literal, exactly
         -- as every grain index in every step before it: a migration step is history the day it
         -- ships, and must keep building the index it built that day.
         CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_tags_grain ON deck_tags (name_key);

         -- Every recorded reversal, discarded. The paragraph in this function's doc is the whole
         -- of the argument; `deck_audit` is left alone on purpose.
         DELETE FROM deck_undo;",
    )
}

/// Give every carried-over `oracle_tags` row the normalised slug the search matches on.
/// The v22 step; issue #180, and that step's comment holds the argument.
///
/// **In Rust and through [`crate::slug::normalize`], for the reason that function's own doc
/// states: there is one copy of this rule, deliberately.** The ingest writes `slug_norm` with
/// it and `tags::query` compares a typed needle against the column it wrote, so a second
/// normalisation spelled here in SQL would leave both halves perfectly self-consistent, the
/// search matching nothing, and no test in either half failing. It is also not expressible
/// without one: the rule strips every non-alphanumeric character, and SQLite's `lower()` and
/// `replace()` cannot walk a string.
///
/// **`WHERE slug_norm = ''` rather than every row**, so this touches exactly the rows v20's
/// `DEFAULT ''` left behind and skips a taxonomy a refresh has already rewritten. A tag whose
/// slug is entirely punctuation normalises to `''` and so is rewritten with itself, which costs
/// one no-op `UPDATE` on a row Scryfall has never published.
///
/// Read-then-write rather than one statement because of the same missing SQL function, and
/// there is nothing to stream: the oracle taxonomy is a few thousand rows (927 roots measured
/// 2026-08-20) and the whole of it is already being carried in the migration's transaction.
fn backfill_oracle_slug_norm(tx: &Connection) -> rusqlite::Result<()> {
    let slugs: Vec<String> = tx
        .prepare("SELECT slug FROM oracle_tags WHERE slug_norm = ''")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = tx.prepare("UPDATE oracle_tags SET slug_norm = ?2 WHERE slug = ?1")?;
    for slug in &slugs {
        stmt.execute(params![slug, crate::slug::normalize(slug)])?;
    }
    Ok(())
}

/// The single-file ladder, frozen at [`LEGACY_SINGLE_FILE_VERSION`].
///
/// **Nothing calls this to prepare a running database any more.** It is reached from exactly
/// two places: `crate::split::convert` brings a pre-split `mtg.db` up to 26 before taking it
/// apart, and this file's own tests build old databases by hand to climb it. Its rungs are
/// history.
pub fn migrate_single_file(conn: &Connection) -> rusqlite::Result<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 {
        // One transaction for the whole migration, `user_version` bumped last: if any
        // step fails the database stays at version 0 and the next run retries cleanly.
        // Bumping it before the FTS table exists would mark the database migrated with
        // no search index and no path back.
        //
        // The indexes are deliberately not here. [`CARDS_INDEXES`] describes the table at
        // head and names columns later steps add, so the newest step replays it and no
        // older one may — see the constant. A fresh install gets its indexes at v20, in the
        // same `migrate_single_file` call as this.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS cards ({CARDS_COLUMNS});
             CREATE TABLE IF NOT EXISTS sets (
                code TEXT PRIMARY KEY, name TEXT NOT NULL, arena_code TEXT, mtgo_code TEXT,
                set_type TEXT, released_at TEXT, icon_svg_uri TEXT);
             CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
        ))?;
        create_fts_in(&tx, "main")?;
        tx.execute_batch("PRAGMA user_version = 1;")?;
        tx.commit()?;
    }
    if v < 2 {
        let tx = conn.unchecked_transaction()?;
        // Two nullable columns and a table that is not `cards`, so: no entry in
        // `CARDS_INDEXES` (nothing here is indexed), no edit to `CARDS_COLUMNS` (frozen —
        // a fresh install replays v1 and then this step, exactly as an upgrade does), and
        // no FTS rebuild (the index covers name/type_line/search_text, none of which this
        // touches, and an UPDATE renumbers no rowid — `the_v2_backfill_leaves_the_search_
        // index_answering` is the evidence).
        tx.execute_batch(
            "ALTER TABLE cards ADD COLUMN image_uris TEXT;
             ALTER TABLE cards ADD COLUMN face_image_uris TEXT;
             CREATE TABLE IF NOT EXISTS image_cache (
                card_id TEXT NOT NULL,
                face INTEGER NOT NULL,
                variant TEXT NOT NULL,
                -- The exact URI the bytes on disk came from, cache-buster and all.
                -- Scryfall's `?<epoch>` equals `image_updated_at`, so a URI that no
                -- longer matches *is* the invalidation signal, with no clock to trust.
                source_uri TEXT NOT NULL,
                bytes INTEGER NOT NULL,
                fetched_at INTEGER NOT NULL,
                PRIMARY KEY (card_id, face, variant)
             ) WITHOUT ROWID;",
        )?;

        // Backfill from `raw`, which every row already carries verbatim — through
        // [`json_raw`], so a `raw` that is not JSON text is skipped rather than fatal.
        // Restricted to rows that have something to give so the UPDATE does not rewrite
        // 116 k pages to store `{"thumb":null,…}` four times over.
        let raw = json_raw("raw");
        tx.execute_batch(&format!(
            "UPDATE cards SET image_uris = {top}
             WHERE json_extract({raw}, '$.image_uris') IS NOT NULL;",
            top = webp_json_object(&raw)
        ))?;
        tx.execute_batch(&format!(
            "UPDATE cards SET face_image_uris = (
                SELECT json_group_array(json(
                    CASE WHEN json_extract(f.value, '$.image_uris') IS NULL
                         THEN 'null' ELSE {face} END))
                FROM json_each({qualified}, '$.card_faces') f)
             WHERE json_type({raw}, '$.card_faces') = 'array'
               AND EXISTS (SELECT 1 FROM json_each({qualified}, '$.card_faces') g
                           WHERE json_extract(g.value, '$.image_uris') IS NOT NULL);",
            face = webp_json_object("f.value"),
            qualified = json_raw("cards.raw")
        ))?;

        tx.execute_batch("PRAGMA user_version = 2;")?;
        tx.commit()?;
    }
    if v < 3 {
        let tx = conn.unchecked_transaction()?;
        // One nullable, unindexed column. No entry in `CARDS_INDEXES` (nothing here is
        // indexed), no edit to `CARDS_COLUMNS` (frozen), and no FTS rebuild — the index
        // covers name/type_line/search_text, none of which this touches, and an UPDATE
        // renumbers no rowid. `the_v3_backfill_leaves_the_search_index_answering` is the
        // evidence, exactly as v2's twin was.
        tx.execute_batch("ALTER TABLE cards ADD COLUMN artist TEXT;")?;

        // Read out of the JSON already on disk rather than re-downloading 77 MB. Two
        // sources because Scryfall has two: a reversible card carries no top-level artist,
        // only `card_faces[0].artist`.
        //
        // [`json_raw`] is the guard, and this is the step that makes it necessary: from
        // the first post-v3 sync `raw` is a gzip BLOB, which `json_extract` answers with a
        // hard error rather than a NULL. `faces` needs none — it is written as compact
        // JSON or not at all, and `json_extract` over a NULL is a NULL.
        tx.execute_batch(&format!(
            "UPDATE cards
                SET artist = coalesce(json_extract({raw}, '$.artist'),
                                      json_extract(faces, '$[0].artist'))
              WHERE artist IS NULL;",
            raw = json_raw("raw")
        ))?;

        // Literal `3`, not `LEGACY_SINGLE_FILE_VERSION`: this step is what makes a database version 3,
        // and head is 5. Writing head here would commit "migrated" before the steps after
        // it had run, so a v4 or v5 that then failed would leave a database claiming a
        // schema it does not have — with no way back, because `migrate_single_file` only ever walks
        // upwards.
        tx.execute_batch("PRAGMA user_version = 3;")?;
        tx.commit()?;
    }
    if v < 4 {
        let tx = conn.unchecked_transaction()?;
        // Spec §6, and every column here answers to the same invariant: `cards` is
        // dropped and recreated on every sync, so `card_id` carries **no** `REFERENCES`
        // clause and the printing is denormalised beside it. A declared foreign key would
        // abort every sync; `ON DELETE CASCADE` would delete the user's collection on the
        // next refresh. Orphans are flagged (`needs_review`), never deleted.
        //
        // None of these tables is `cards`, so `CARDS_INDEXES` is not involved: their
        // indexes are created here and nothing drops them. Nothing here reads `raw`
        // either, so [`json_raw`] has no part to play — these tables are not sync data.
        //
        // **Both grains below are spelled out rather than interpolated from
        // [`COLLECTION_GRAIN`]/[`WISHLIST_GRAIN`]**, for the reason the v5 and v8 steps give
        // in full: a migration step is history the day it ships, and a step that reads a live
        // constant builds a *different* index on a fresh install than it built on every
        // database that already ran it. The constants stay the single source for everything
        // that is not history — every `ON CONFLICT` target below, and the head schema a fresh
        // v1 install never sees.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS collection_entries (
                id INTEGER PRIMARY KEY,
                -- Soft reference. No REFERENCES clause, deliberately and permanently.
                card_id TEXT NOT NULL,
                -- Migration insurance: what the user actually owns, in the terms printed
                -- on the card, still readable when the id stops resolving.
                set_code TEXT NOT NULL,
                collector_number TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'en',
                -- Enum, never a boolean: `etched` is a third thing, and collapsing it is
                -- the most common importer data-loss bug there is.
                finish TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')),
                condition TEXT NOT NULL DEFAULT 'NM'
                    CHECK (condition IN ('NM','LP','MP','HP','DMG')),
                -- What the import said before it was normalised. Kept because the
                -- normalisation is lossy (EU 'GD' and NA 'MP' arrive as one grade) and the
                -- user's own file is the only place the difference still exists.
                condition_original TEXT,
                -- `>= 0`, not `> 0`, and the wishlist's `> 0` differs on purpose. A
                -- stepper taken down to zero is a real state here: the row keeps its
                -- condition, its price, its tags and its acquisition story while the user
                -- owns none of that printing today. So every aggregate that reads this has
                -- to decide *deliberately* whether a zero row counts as owned — and a
                -- 'cards owned' figure that counts rows rather than quantity will be
                -- wrong the first time somebody trades a playset away.
                quantity INTEGER NOT NULL CHECK (quantity >= 0),
                tradelist_quantity INTEGER NOT NULL DEFAULT 0
                    CHECK (tradelist_quantity >= 0),
                purchase_price REAL,
                purchase_currency TEXT,
                acquired_at TEXT,
                -- No competitor stores this. It is one TEXT column and it is the answer to
                -- 'where did I get this?', which is the question a collection is actually
                -- asked years later.
                acquisition_source TEXT,
                -- 042/500. Not in Scryfall's data at all — user-supplied, and part of the
                -- grain, because two serialized copies are two different objects.
                serial_number TEXT,
                altered INTEGER NOT NULL DEFAULT 0,
                signed INTEGER NOT NULL DEFAULT 0,
                proxy INTEGER NOT NULL DEFAULT 0,
                misprint INTEGER NOT NULL DEFAULT 0,
                -- {company, grade, cert}. JSON because the shape differs per grader
                -- (CGC has two grades numbered 10; PSA has no 9.5) and a column per
                -- grader is a migration per grader.
                grading TEXT CHECK (grading IS NULL OR json_valid(grading)),
                tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
                notes TEXT,
                -- NULL is the normal state. A sentence here means the row needs the user's
                -- attention — the printing vanished from Scryfall, or a merge landed it
                -- somewhere this database cannot see. Never a reason to delete the row.
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_grain
                ON collection_entries (card_id, finish, condition, lang, altered, signed,
                                       proxy, misprint, coalesce(serial_number, ''),
                                       coalesce(grading, ''));
             CREATE INDEX IF NOT EXISTS idx_collection_card
                ON collection_entries (card_id);
             CREATE INDEX IF NOT EXISTS idx_collection_review
                ON collection_entries (needs_review) WHERE needs_review IS NOT NULL;

             CREATE TABLE IF NOT EXISTS wishlist_entries (
                id INTEGER PRIMARY KEY,
                -- The oracle card. NULLABLE because `cards.oracle_id` is: a wish for a
                -- printing whose oracle card is unknown can only be a wish for that
                -- printing. (No live row is null — the reversible-card story that used to
                -- be told here is wrong, see `card_row` — so this is a fence, not a case.)
                oracle_id TEXT,
                -- NULL = any printing (spec §6). Set = that printing and no other.
                card_id TEXT,
                set_code TEXT,
                collector_number TEXT,
                lang TEXT,
                -- Denormalised here but not in the collection, on purpose: an any-printing
                -- wish has no card row to join for a name, and a shopping list that cannot
                -- say what it is shopping for is not a list.
                name TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
                preferred_finish TEXT
                    CHECK (preferred_finish IS NULL
                           OR preferred_finish IN ('nonfoil','foil','etched')),
                notes TEXT,
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                -- A wish that names neither an oracle card nor a printing is a wish for
                -- nothing, and would collide with every other such row on the grain.
                CHECK (oracle_id IS NOT NULL OR card_id IS NOT NULL)
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_grain
                ON wishlist_entries (coalesce(oracle_id, ''), coalesce(card_id, ''),
                                     coalesce(preferred_finish, ''));
             CREATE INDEX IF NOT EXISTS idx_wishlist_card ON wishlist_entries (card_id);
             CREATE INDEX IF NOT EXISTS idx_wishlist_oracle ON wishlist_entries (oracle_id);

             -- Every Scryfall id migration this database has already applied, so a re-poll
             -- is a no-op instead of a second repoint. Scryfall's own id is the key.
             CREATE TABLE IF NOT EXISTS card_migrations (
                id TEXT PRIMARY KEY,
                performed_at TEXT,
                strategy TEXT NOT NULL CHECK (strategy IN ('merge','delete')),
                old_card_id TEXT NOT NULL,
                new_card_id TEXT,
                note TEXT,
                applied_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_card_migrations_old
                ON card_migrations (old_card_id);",
        )?;
        // Literal `4`, for the same reason v3 writes a literal `3`: this step is what makes
        // a database version 4, and the step after it makes head 5. Writing
        // `LEGACY_SINGLE_FILE_VERSION` would commit "migrated" before that step had run — and it would
        // also quietly defang `migrate_is_idempotent_and_creates_tables`, which pins
        // `user_version == LEGACY_SINGLE_FILE_VERSION` and would keep passing while the last step was
        // never reached. **Every future step ends with its own literal.**
        tx.execute_batch("PRAGMA user_version = 4;")?;
        tx.commit()?;
    }
    if v < 5 {
        let tx = conn.unchecked_transaction()?;
        // Plan 4 (spec §6). Two invariants meet here and the DDL is their treaty:
        //
        // * Everything that names a CARD is a soft reference — `deck_cards.card_id` and
        //   `decks.cover_card_id` carry no REFERENCES clause, and the printing (plus the
        //   name: a deck list that cannot name an orphaned card is not a list) is
        //   denormalised beside `card_id`, exactly as the collection and wishlist do.
        // * Everything that names USER DATA is an enforced reference — `deck_cards.deck_id`,
        //   `deck_allocations.deck_id` and `deck_allocations.collection_entry_id`, all ON
        //   DELETE CASCADE here. (v8 adds several more elsewhere, two of them SET NULL —
        //   see the module doc at the top of this file for the current, checkable list;
        //   this step is history and only ever spoke for what it itself created.) CASCADE
        //   is chosen per delete-site: right for the two user-initiated deletes (deck
        //   delete, `remove_entry`), and made safe for the one non-user delete (the
        //   reconciler's fold) by `reconcile::fold_into_existing` repointing allocations
        //   BEFORE it deletes.
        //
        // Every index below is a literal, `idx_deck_allocations_grain` included — see the
        // note on `idx_deck_cards_grain` further down, which is the one that learned it.
        tx.execute_batch(
            "ALTER TABLE cards ADD COLUMN power TEXT;
             ALTER TABLE cards ADD COLUMN toughness TEXT;

             CREATE TABLE IF NOT EXISTS decks (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                format_key TEXT NOT NULL DEFAULT 'casual',
                description TEXT,
                -- Spec §6: card_art today; 'custom' + cover_image_path are Plan 6's
                -- (a user file copied into data/covers/), reserved here so the column
                -- story is stable.
                cover_kind TEXT NOT NULL DEFAULT 'card_art'
                    CHECK (cover_kind IN ('card_art','custom')),
                -- Soft reference, like every other card id in a user table.
                cover_card_id TEXT,
                cover_image_path TEXT,
                -- Reserves availability, never decrements the collection (spec §6).
                is_built INTEGER NOT NULL DEFAULT 0,
                -- Spec §7 'duplicate/archive decks'. A flag, not a delete.
                archived INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );

             CREATE TABLE IF NOT EXISTS deck_cards (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                card_id TEXT NOT NULL,
                set_code TEXT NOT NULL,
                collector_number TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'en',
                name TEXT NOT NULL,
                zone TEXT NOT NULL
                    CHECK (zone IN ('main','side','commander','companion','maybe')),
                -- Zero removes, like the wishlist and unlike the collection: a zone slot
                -- at zero holds no condition, no price and no acquisition story.
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             -- Frozen as a literal, not `{{deck_grain}}`: schema v8 changes what
             -- `DECK_CARD_GRAIN` *means* (category and variant replace the zone), and this
             -- step is history — it must keep building the v5-era index over the v5-era
             -- table it actually created above, not whatever the constant says today. The
             -- same reason `CARDS_COLUMNS` and the v5 zone CHECK are spelled out rather than
             -- interpolated.
             CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_cards_grain
                ON deck_cards (deck_id, card_id, zone);
             CREATE INDEX IF NOT EXISTS idx_deck_cards_card ON deck_cards (card_id);

             CREATE TABLE IF NOT EXISTS deck_allocations (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                collection_entry_id INTEGER NOT NULL
                    REFERENCES collection_entries(id) ON DELETE CASCADE,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_allocations_grain
                ON deck_allocations (deck_id, collection_entry_id);
             -- The child index a CASCADE scans: without it every `remove_entry` is a
             -- full table scan of the allocations, and the reconciler's fold repoints
             -- through the same column.
             CREATE INDEX IF NOT EXISTS idx_deck_allocations_entry
                ON deck_allocations (collection_entry_id);

             CREATE TABLE IF NOT EXISTS format_specs (
                key TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                enabled_in_picker INTEGER NOT NULL DEFAULT 1,
                deck_min INTEGER NOT NULL,
                deck_max INTEGER,             -- NULL = no maximum
                max_copies INTEGER,           -- NULL = unlimited (casual, limited)
                sideboard_max INTEGER,        -- 0 = no sideboard; NULL = uncapped (casual, limited)
                singleton INTEGER NOT NULL DEFAULT 0,
                requires_commander INTEGER NOT NULL DEFAULT 0,
                -- Which eligibility rule the TS engine applies. Data, not code:
                -- NULL | 'edh' | 'brawl' | 'oathbreaker' | 'pdh' | 'duel' | 'tlr'.
                commander_rule TEXT,
                life INTEGER NOT NULL,
                -- TRAP A: what `restricted` MEANS here. Never inferred from the key.
                restricted_semantic TEXT NOT NULL DEFAULT 'max_one'
                    CHECK (restricted_semantic IN ('max_one','banned_as_commander')),
                -- 0 for the two pseudo-formats: casual and limited check no legality
                -- and no pool (spec §6).
                has_legality_data INTEGER NOT NULL DEFAULT 1,
                -- Tiny Leaders: every card AND every face, MV <= this.
                max_mana_value INTEGER,
                -- Gladiator: no sideboard → no companions. EDH has sideboard_max 0 and
                -- DOES allow one ('effectively a 101st card'), so this cannot be derived
                -- from sideboard_max — it is its own fact.
                allows_companion INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL
             );",
        )?;

        // The backfill, THROUGH [`json_raw`] — `raw` is a gzip BLOB on every database that
        // has synced since v3, and an unguarded `json_extract` there is a hard error that
        // fails this whole migration in the field while passing every fixture test
        // (CLAUDE.md). `faces` needs no guard: compact JSON or NULL, and `json_extract`
        // over a NULL is a NULL.
        //
        // Two nullable, unindexed columns on `cards`, so — as in v2 and v3 — no entry in
        // `CARDS_INDEXES`, no edit to `CARDS_COLUMNS` (frozen), and no FTS rebuild: the
        // index covers name/type_line/search_text, none of which this touches, and an
        // UPDATE renumbers no rowid. `the_v5_backfill_leaves_the_search_index_answering`
        // is the evidence, exactly as v2's and v3's twins were.
        //
        // Restricted to rows that have something to give, which is v2's reasoning and here
        // it is nearly the whole cost. On a database that has synced since v3 the guard
        // answers NULL for every `raw`, so all this step can recover is what the
        // double-faced cards keep in `faces`: **1 510 of 116 590 rows**. Without the extra
        // term the UPDATE rewrites all 116 590 — each carrying its ~2 KB `raw` blob — to
        // store NULL over NULL. Measured through `prepare_database` on a copy of the live
        // 547 MB database: **725 ms with it, 5.40 s without**, the same 1 510 rows filled
        // either way, and `migrate_single_file` runs before there is a window to say anything in.
        // The remaining P/T arrive with the next sync, exactly as v3's `artist` did — the
        // ingest writes both columns from here on.
        tx.execute_batch(&format!(
            "UPDATE cards
                SET power     = coalesce(json_extract({raw}, '$.power'),
                                         json_extract(faces, '$[0].power')),
                    toughness = coalesce(json_extract({raw}, '$.toughness'),
                                         json_extract(faces, '$[0].toughness'))
              WHERE power IS NULL AND toughness IS NULL
                AND (json_extract(faces, '$[0].power') IS NOT NULL
                     OR json_extract(faces, '$[0].toughness') IS NOT NULL
                     OR json_extract({raw}, '$.power') IS NOT NULL
                     OR json_extract({raw}, '$.toughness') IS NOT NULL);",
            raw = json_raw("raw")
        ))?;

        // The **frozen** copy, not the head constant: this statement is what v5 wrote, and a
        // fresh install replays it long before v18 adds the `games` column the head seed names.
        tx.execute_batch(FORMAT_SPECS_SEED_V5)?;
        // Literal `5`, for the reason v3 writes a literal `3` and v4 a literal `4`.
        tx.execute_batch("PRAGMA user_version = 5;")?;
        tx.commit()?;
    }
    if v < 6 {
        let tx = conn.unchecked_transaction()?;
        // One key/value table for state that belongs to the *application* rather than to
        // the sync — today, when the updater last asked GitHub and which version it saw.
        //
        // Deliberately not `sync_meta`, which would have needed no migration at all:
        // that table belongs to the sync, and a row in it that the sync did not write
        // makes every later timing and "what the app did on its own" claim a fiction.
        // The separation is worth one CREATE TABLE.
        //
        // Nothing here touches `cards`, so no entry in `CARDS_INDEXES`; nothing here is
        // indexed by FTS and no rowid is renumbered, so no `cards_fts` rebuild is owed —
        // the same reasoning `the_v2_backfill_leaves_the_search_index_answering` pins.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        // Literal `6`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 6;")?;
        tx.commit()?;
    }
    if v < 7 {
        // v7 is `idx_cards_collapse`, the collapsed search's covering index — and it has no
        // statements of its own any more. It used to replay [`CARDS_INDEXES`] here; that
        // list describes `cards` at head, so only the newest step to touch the table may
        // create from it — and the replay has moved twice since: down to v10, which put
        // `legal_mask` in the list, and on to **v20**, which put `illustration_id` there.
        // This step's index is created wherever the replay lives now, in its widened form,
        // for every database that walks past here. What is left is the version this step
        // stands for, kept rather than deleted because the ladder is the record of what each
        // version was — and because creating the narrow index only for v10 to drop it would
        // be a 0.7 s index build over the live corpus, spent on nothing.
        //
        // Nothing here reads `raw`, so [`json_raw`] has no part to play. Nothing here
        // touches an FTS-indexed column (`name`/`type_line`/`search_text`) and no rowid is
        // renumbered, so no `cards_fts` rebuild is owed — the reasoning
        // `the_v2_backfill_leaves_the_search_index_answering` pins.
        //
        // Literal `7`, for the reason every step before it writes its own.
        conn.execute_batch("PRAGMA user_version = 7;")?;
    }
    if v < 8 {
        let tx = conn.unchecked_transaction()?;
        // Plan 8. The deck's grouping stops being a fixed five-word enum and becomes rows the
        // user owns — so `deck_cards.zone` is replaced by `deck_cards.category_id`, and the
        // category carries the `kind` the rules used to read off the zone. Nothing about the
        // rules changed: `kind` takes exactly the five values `zone` took, and the validation
        // engine and the allocator read it in the same places. What is new is that a category
        // also has a NAME, an ORDER and an ACTIVE flag — and `is_active = 0` means "counts
        // toward nothing", which is precisely what `maybe` used to mean. So the scratchpad
        // stops being a special case in five files and becomes one seeded row.
        //
        // `zone` cannot be dropped in place: it is inside a CHECK and inside the unique index,
        // and SQLite refuses `DROP COLUMN` for either. The table is rebuilt, which is also how
        // `category_id` gets to be `NOT NULL` rather than nullable-with-a-promise.
        //
        // Every grain below is a literal — see `idx_deck_cards_grain` in the rebuild further
        // down, and the note the v5 step carries above it.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS deck_folders (
                id INTEGER PRIMARY KEY,
                -- User↔user, CASCADE: deleting a folder deletes the folders inside it. The
                -- DECKS inside it are NOT deleted — see `decks.folder_id` below, which is
                -- SET NULL. A folder is a filing decision; a deck is the user's work.
                parent_id INTEGER REFERENCES deck_folders(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_deck_folders_parent ON deck_folders (parent_id);

             CREATE TABLE IF NOT EXISTS deck_categories (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                -- The rules role, and the same five words `deck_cards.zone` held. A category
                -- the user makes is always 'main'; the other four are predefined, one per deck.
                kind TEXT NOT NULL
                    CHECK (kind IN ('main','side','commander','companion','maybe')),
                -- 'Only active groups are treated as being included in the deck.' Seeded 0 for
                -- the Maybeboard and 1 for everything else.
                is_active INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_categories_grain
                ON deck_categories (deck_id, name);
             -- At most one predefined category per kind per deck. Partial, because 'main' is
             -- the kind every user category has and there may be forty of them.
             CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_categories_kind
                ON deck_categories (deck_id, kind) WHERE kind <> 'main';

             CREATE TABLE IF NOT EXISTS deck_tags (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                -- A token name from the app's fixed tag palette, not a hex string: the webview
                -- owns what a colour looks like, and a stored hex would outlive the theme.
                color TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_tags_grain
                ON deck_tags (deck_id, name);

             CREATE TABLE IF NOT EXISTS deck_audit (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                at INTEGER NOT NULL,
                variant TEXT NOT NULL DEFAULT 'live'
                    CHECK (variant IN ('live','theory')),
                kind TEXT NOT NULL CHECK (kind IN
                    ('add','remove','quantity','move','swap','tag','category','folder','deck')),
                -- Soft, like every card id in a user table, and nullable: a category rename
                -- is about no card at all.
                card_id TEXT,
                card_name TEXT,
                -- The facts the sentence is built from. Rust records WHAT happened; the
                -- webview writes the sentence, because a sentence is domain logic and this
                -- table has to survive the day the wording changes.
                payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
                -- Signed copies, for the day header's '+7 / -6' roll-up.
                delta INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_deck_audit_deck ON deck_audit (deck_id, at DESC);

             ALTER TABLE decks ADD COLUMN folder_id INTEGER
                REFERENCES deck_folders(id) ON DELETE SET NULL;
             ALTER TABLE decks ADD COLUMN notes TEXT;
             ALTER TABLE decks ADD COLUMN theory_enabled INTEGER NOT NULL DEFAULT 0;",
        )?;

        // One category per (deck, zone) that actually holds cards, named and flagged from
        // PREDEFINED_CATEGORIES — except 'main', whose legacy rows all land in one category
        // called 'Main deck'. Splitting those is the app's `autoCategoryFor` rule, which lives
        // in TypeScript because it is domain logic; running a second copy of it here would be
        // two rules to keep in step. The categories panel offers 'File cards by what they do',
        // which is that one rule, pressed once.
        //
        // That rule reads a card's Oracle tags now, not its type line (v12) — which is a second
        // reason this migration must not copy it: the taxonomy those tags come from is a
        // separate download that a database being migrated may not have yet.
        tx.execute_batch(
            "INSERT INTO deck_categories (deck_id, name, kind, is_active, sort_order,
                                          created_at, updated_at)
             SELECT DISTINCT dc.deck_id,
                    CASE dc.zone WHEN 'main' THEN 'Main deck'
                                 WHEN 'side' THEN 'Sideboard'
                                 WHEN 'commander' THEN 'Commander'
                                 WHEN 'companion' THEN 'Companion'
                                 ELSE 'Maybeboard' END,
                    dc.zone,
                    CASE dc.zone WHEN 'maybe' THEN 0 ELSE 1 END,
                    CASE dc.zone WHEN 'commander' THEN 0 WHEN 'main' THEN 1
                                 WHEN 'side' THEN 2 WHEN 'companion' THEN 3 ELSE 4 END,
                    unixepoch(), unixepoch()
               FROM deck_cards dc;",
        )?;

        // The insert above is driven off `deck_cards`, so a deck with an empty list — no
        // rows in any zone — comes out of it owning no categories at all. That is every
        // deck that predates this migration and has nothing in it yet, which is not a rare
        // shape: a deck is created empty and filled in over several sessions. This second
        // pass closes that gap once, here, rather than leaving it for
        // `deck_meta::ensure_predefined_categories` to discover on whatever future read
        // happens to ask first — the whole point of migrating the schema is that a database
        // brought to head needs nothing more done to it.
        //
        // `WHERE NOT EXISTS` is what lets this run unconditionally over every deck without
        // colliding with the insert just above: a deck that already has a `commander`
        // category (because it already had a commander card) is skipped for that kind and
        // topped up for whichever of the other three it is still missing. `main` has no row
        // here — the four kinds and their `(name, is_active, sort_order)` are
        // `PREDEFINED_CATEGORIES` spelled out as literals rather than interpolated, for
        // `CARDS_COLUMNS`'s reason: this step is history the moment it ships, and a later
        // change to that constant must not silently rewrite what a past migration did.
        tx.execute_batch(
            "INSERT INTO deck_categories (deck_id, name, kind, is_active, sort_order,
                                          created_at, updated_at)
             SELECT d.id, p.name, p.kind, p.is_active, p.sort_order, unixepoch(), unixepoch()
               FROM decks d
               JOIN (SELECT 'commander' AS kind, 'Commander' AS name, 1 AS is_active,
                            0 AS sort_order
                     UNION ALL
                     SELECT 'side', 'Sideboard', 1, 2
                     UNION ALL
                     SELECT 'companion', 'Companion', 1, 3
                     UNION ALL
                     SELECT 'maybe', 'Maybeboard', 0, 4) AS p
              WHERE NOT EXISTS (
                    SELECT 1 FROM deck_categories cat
                     WHERE cat.deck_id = d.id AND cat.kind = p.kind);",
        )?;

        // The rebuild. `category_id` is NOT NULL from the first row, which is only possible
        // because the categories above already exist.
        tx.execute_batch(
            "CREATE TABLE deck_cards_v8 (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                -- CASCADE: deleting a category deletes the cards filed under it, which is
                -- what the confirm dialog says it will do. Moving them out first is the
                -- caller's job and `deck_category_delete` does exactly that when asked.
                category_id INTEGER NOT NULL
                    REFERENCES deck_categories(id) ON DELETE CASCADE,
                variant TEXT NOT NULL DEFAULT 'live'
                    CHECK (variant IN ('live','theory')),
                card_id TEXT NOT NULL,
                set_code TEXT NOT NULL,
                collector_number TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'en',
                name TEXT NOT NULL,
                -- SET NULL, not CASCADE: deleting a tag must never delete a card.
                tag_id INTEGER REFERENCES deck_tags(id) ON DELETE SET NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );

             INSERT INTO deck_cards_v8
                (id, deck_id, category_id, variant, card_id, set_code, collector_number,
                 lang, name, tag_id, quantity, needs_review, created_at, updated_at)
             SELECT dc.id, dc.deck_id, cat.id, 'live', dc.card_id, dc.set_code,
                    dc.collector_number, dc.lang, dc.name, NULL, dc.quantity,
                    dc.needs_review, dc.created_at, dc.updated_at
               FROM deck_cards dc
               JOIN deck_categories cat
                 ON cat.deck_id = dc.deck_id AND cat.kind = dc.zone;

             -- `DROP TABLE deck_cards` fires `deck_cards`' own OUTBOUND foreign keys (there
             -- are none) under `PRAGMA foreign_keys=ON`, same as any other statement — but
             -- that pragma is a documented no-op *inside a transaction*, and `migrate_single_file` always
             -- runs inside one. It must be left exactly as it already was; there is nothing
             -- to toggle here. The rename is what keeps `deck_cards_v8`'s row ids — copied
             -- verbatim above — as `deck_cards.id`, which is what lets `deck_allocations` and
             -- anything else holding one stay correct without a repoint of its own.
             DROP TABLE deck_cards;
             ALTER TABLE deck_cards_v8 RENAME TO deck_cards;

             -- Frozen as a literal, exactly as the v5 step froze the index this one replaces,
             -- and for the same reason turned one step forward: **this step is history the
             -- day it ships.** `DECK_CARD_GRAIN` has already been changed once on this
             -- branch — v8 is what changed it — and the change silently rewrote what v5 had
             -- built until v5 was frozen. A later step that widens the grain again would make
             -- this step build an index over a column that does not exist at v8: a hard failure on
             -- a **new** install and invisible on every upgraded one, because an upgraded
             -- database ran this step before the column was named. The constant is for
             -- everything that is not history — the `ON CONFLICT` targets in `deck.rs` and
             -- `deck_theory.rs`, which must match whatever index the *head* schema carries.
             CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_cards_grain
                ON deck_cards (deck_id, variant, category_id, card_id);
             CREATE INDEX IF NOT EXISTS idx_deck_cards_card ON deck_cards (card_id);
             CREATE INDEX IF NOT EXISTS idx_deck_cards_category ON deck_cards (category_id);",
        )?;

        // Literal `8`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 8;")?;
        tx.commit()?;
    }
    if v < 9 {
        let tx = conn.unchecked_transaction()?;
        // The error log: what failed, when, how often, and nothing else.
        //
        // It exists because failure in this app was very nearly invisible. `sync_meta
        // .last_error` is one string the next run overwrites, and everything else — the
        // id-migration poll, the orphan sweep, the page reclaim, the compaction, an image the
        // filesystem refused — was an `eprintln!`, which in a release build has no console to
        // print to. The user could not see that anything had gone wrong, and neither could
        // anyone trying to debug it.
        //
        // **The unique index is the whole design.** Without it, one bad afternoon writes a row
        // per failed image: the path-MTU black hole this repo has already met produced ~600 of
        // them in a single pass. Folding on (source, operation, kind, message) turns that into
        // one row reading "x600", which is both smaller and truer — it is one fault, not six
        // hundred. `detail` is deliberately OUTSIDE the key: it carries the URL or the card id,
        // which is exactly the per-occurrence string that would defeat the folding, so it is
        // overwritten with the most recent value instead of splitting the row.
        //
        // Nothing here touches `cards`, so no entry in `CARDS_INDEXES`; nothing is FTS-indexed
        // and no rowid is renumbered, so no `cards_fts` rebuild is owed — the same reasoning
        // `the_v2_backfill_leaves_the_search_index_answering` pins.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS error_log (
                id INTEGER PRIMARY KEY,
                -- Unix seconds, like every stamp in this schema.
                first_at INTEGER NOT NULL,
                last_at INTEGER NOT NULL,
                -- Which of the app's dealings with the outside world this was.
                source TEXT NOT NULL CHECK (source IN
                    ('scryfall_api','scryfall_image','github_update','database','image_store')),
                -- The specific call: 'bulk_check', 'sets', 'migrations', 'image_fetch', …
                -- Free text rather than a CHECK: a new call site must not need a migration
                -- before it is allowed to report that it failed.
                operation TEXT NOT NULL,
                -- The shape of the failure, which is what a reader filters on.
                kind TEXT NOT NULL CHECK (kind IN
                    ('rate_limited','timeout','http','io','parse','other')),
                message TEXT NOT NULL,
                -- The URL, card id or path. Nullable, outside the grain, most recent wins.
                detail TEXT,
                count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0)
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_error_log_grain
                ON error_log (source, operation, kind, message);
             -- The read is always 'newest first, capped', and so is the eviction.
             CREATE INDEX IF NOT EXISTS idx_error_log_recent ON error_log (last_at DESC);",
        )?;
        // Literal `9`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 9;")?;
        tx.commit()?;
    }
    if v < 10 {
        let tx = conn.unchecked_transaction()?;
        // One `NOT NULL DEFAULT 0` column, and the index it goes into — the NOT NULL is the
        // format filter's requirement and the paragraph below it says why. `CARDS_COLUMNS`
        // stays frozen — a fresh install replays v1 and arrives here to do the same work an
        // upgrade does.
        //
        // **The DROP is load-bearing.** Every statement in [`CARDS_INDEXES`] is
        // `IF NOT EXISTS`, so replaying the batch over a database that already carries
        // `idx_cards_collapse` in its narrow v7 form would keep that definition and skip
        // the widening — silently, on exactly the machines that have the problem. v7 could
        // replay the batch bare because its index was new; this one is not. Dropping it
        // first is what makes the replay build the new one, and
        // `the_v10_step_replaces_the_narrow_collapse_index_rather_than_skipping_it` is the
        // fence: it fails without this line.
        //
        // **The `DROP INDEX` below is all that is left of this step's index work, and the
        // drop is the half that had to stay.** The replay was this step's while it was the
        // newest step to touch `cards`; v20 adds `idx_cards_illustration` to
        // [`CARDS_INDEXES`] and takes the replay with it, because that list describes the
        // table at head and only the newest step may create from it (see the constant). A
        // database sitting above v10 — every machine that has synced since — never runs this
        // block at all, so an index left here is an index it would never get.
        //
        // What cannot move is the drop: `idx_cards_collapse` is *widened* by the column this
        // step adds, and every statement in the list is `IF NOT EXISTS`, so without the drop
        // the widening is a silent no-op on exactly the machines that need it. The drop
        // describes what v10 corrected and is history; the creation describes head and is not.
        // `the_v10_step_replaces_the_narrow_collapse_index_rather_than_skipping_it` walks a v9
        // database to head and is what would fail if the drop went with the replay.
        //
        // The backfill reads `legalities`, which is a plain JSON TEXT column and not `raw`,
        // so [`json_raw`] has no part to play — [`crate::legalities::mask_sql`] says why
        // `raw` could not be the argument even where it holds the same object. Nothing here
        // touches an FTS-indexed column (`name`/`type_line`/`search_text`) and no rowid is
        // renumbered, so no `cards_fts` rebuild is owed — the reasoning
        // `the_v2_backfill_leaves_the_search_index_answering` pins.
        //
        // It is paid exactly once: [`crate::card_row`] computes the mask natively from the
        // next sync on, so this UPDATE is the only time it is ever derived in SQL. Unlike
        // v2's and v5's backfills it cannot be narrowed to the rows that have something to
        // give — every row needs a mask, and a row with no `legalities` needs the 0 that
        // says "legal nowhere" rather than the NULL that would sit in the index meaning
        // nothing. **The whole step is 3–5 s of launch, before there is a window to say so
        // in**: measured 2026-08-11 over three runs against a *synthetic* 116 590-row,
        // 469 MB stand-in for the corpus (release build), backfill 2.9–5.0 s and index build
        // 0.46–0.63 s. About 2.2 s of the backfill is the full-table row rewrite that any
        // UPDATE of every row pays — the 23 `json_extract`s are the rest, and are the reason
        // the app will not be doing this at query time.
        //
        // **`NOT NULL DEFAULT 0`, and that is the filter's requirement rather than tidiness.**
        // [`crate::filters::push_card_filters`] tests format with `legal_mask & ? != 0`, and
        // `NULL & ?` is NULL — a row with a NULL mask would vanish from every format-filtered
        // search instead of reading as "legal nowhere". No NULL can reach production today
        // (this UPDATE fills every row, [`crate::legalities::mask_sql`] answers 0 for a NULL
        // `legalities`, and `STAGING_INSERT` names the column so the ingest always binds it),
        // but the column permitted one and v10 is still unshipped, so it costs nothing to
        // close. `DEFAULT` is also what makes the `ALTER` legal at all: SQLite refuses to add
        // a `NOT NULL` column without one. [`cards_column_defs`] reproduces both, so staging
        // carries them and the swap survives.
        tx.execute_batch("ALTER TABLE cards ADD COLUMN legal_mask INTEGER NOT NULL DEFAULT 0;")?;
        tx.execute_batch(&format!(
            "UPDATE cards SET legal_mask = {mask};",
            mask = crate::legalities::mask_sql("legalities")
        ))?;
        tx.execute_batch("DROP INDEX IF EXISTS idx_cards_collapse;")?;
        // Literal `10`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 10;")?;
        tx.commit()?;
    }
    if v < 11 {
        let tx = conn.unchecked_transaction()?;
        // Card Kingdom's and Mana Pool's price feeds, in tables of their own.
        //
        // **They cannot be columns on `cards`, and that is the whole reason this step
        // exists.** [`swap_staging`] drops and recreates `cards` on every sync, so a price
        // column would be destroyed by the next refresh — and re-downloading 112 MiB of feed
        // to restore it is not a recovery plan. Keyed on `scryfall_id` instead, in a table the
        // swap never touches.
        //
        // **No foreign key against `cards.id`, deliberately**, which is the rule the whole
        // crate follows: enforced foreign keys exist only *between user tables*. A declared
        // `REFERENCES cards(id)` aborts every sync. It would also be a lie about the data — a
        // feed and the card corpus are collected on different days and from different people,
        // so a price for a printing this database has never heard of (and a printing no
        // marketplace stocks) is the expected case rather than an error. 149 989 Card Kingdom
        // rows against 116 590 `cards` rows, measured 2026-08-12.
        //
        // `WITHOUT ROWID`: the table *is* its primary key plus one number, so the rowid
        // b-tree an ordinary table carries would be a second copy of it. Every read is a
        // point lookup on the full key — `LEFT JOIN marketplace_prices USING (marketplace,
        // card_id, finish)` — which the primary key answers on its own, so no secondary index
        // is created here and none is owed.
        //
        // `finish` is CHECK-constrained to the same three values [`crate::schema::FINISHES`]
        // holds, as every other finish column in this schema is: etched is a third finish and
        // not `foil: true`, and a feed that starts spelling it differently must fail loudly
        // rather than file a foil price under a nonfoil key.
        //
        // Nothing here touches `cards`, so no entry in [`CARDS_INDEXES`] and no claim on its
        // replay — v20 holds the title of newest creator, exactly as v8 (the deck tables) and
        // v9 (the error log) left it. Nothing here is FTS-indexed and no rowid is renumbered,
        // so no `cards_fts` rebuild is owed: the reasoning
        // `the_v2_backfill_leaves_the_search_index_answering` pins.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS marketplace_prices (
                -- One of `crate::marketplace::MARKETPLACE_IDS`, and always a feed-backed one:
                -- TCGplayer and Cardmarket are read out of `cards.prices` and are never here.
                marketplace TEXT NOT NULL,
                -- A Scryfall id. Soft: no FK, for the reason above.
                card_id TEXT NOT NULL,
                finish TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')),
                -- Near Mint, in the marketplace's own currency. One price per finish; a
                -- finish the feed does not quote has no row at all, never a zero — `$0.00`
                -- is a price nobody offered, and the app renders absence as an em dash.
                price REAL NOT NULL,
                PRIMARY KEY (marketplace, card_id, finish)
             ) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS marketplace_feed_meta (
                marketplace TEXT PRIMARY KEY,
                -- Unix seconds, like every stamp in this schema: when *we* pulled it.
                fetched_at INTEGER NOT NULL,
                -- The feed's own stamp, verbatim (Card Kingdom's `meta.created_at`). NULL
                -- for a feed that publishes none, which Mana Pool does not — the two answer
                -- different questions and a missing one must not be faked from `fetched_at`.
                feed_built_at TEXT,
                row_count INTEGER NOT NULL
             );",
        )?;
        // Literal `11`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 11;")?;
        tx.commit()?;
    }
    if v < 12 {
        let tx = conn.unchecked_transaction()?;
        // Where the reader was last looking, per deck: which variant, and how the editor was
        // grouping and sorting it. Three columns on `decks` and nothing else — an editor that
        // opens on the Live tab sorted alphabetically however the reader left it is an editor
        // that forgets, and forgetting is a thing the app does *to* the reader once per deck
        // per session.
        //
        // Nothing here touches `cards`, so no entry in [`CARDS_INDEXES`] and no claim on its
        // replay — v20 holds the title of newest creator, exactly as v8 (the deck tables), v9
        // (the error log) and v11 (the price tables) left it. Nothing here is FTS-indexed and
        // no rowid is renumbered, so no `cards_fts` rebuild is owed either: the reasoning
        // `the_v2_backfill_leaves_the_search_index_answering` pins.
        //
        // **`last_variant` carries no CHECK, and it is not an oversight — `ALTER TABLE ADD
        // COLUMN` cannot add one.** SQLite accepts a `DEFAULT` on an added column and refuses a
        // `CHECK`, so the fence [`DECK_VARIANTS`] would have been in the DDL lives in Rust
        // instead: `crate::deck::set_view_state` refuses anything else **by name**, through the
        // one `deck_meta::valid_variant` every deck write already opens with. A reader who
        // comes here looking for the missing CHECK is looking in the right place, and this
        // paragraph is what they should find.
        //
        // **`last_group_by` and `last_sort_by` hold a TypeScript vocabulary this crate
        // deliberately does not know.** `category | manaValue | type` and `alphabetical |
        // manaCost | price | type` are the deck editor's words; how a deck is grouped and
        // sorted is domain logic, and domain logic is TypeScript's (CLAUDE.md's boundary —
        // Rust supplies facts, TS draws conclusions). So Rust stores the reader's answer
        // verbatim, as the fact it is, and TypeScript narrows it on read with a fallback. A
        // mode the editor renames or drops then costs one reader one remembered choice instead
        // of costing everybody a migration, and a mode it *adds* needs nothing here at all.
        // What Rust does refuse is a blank: an empty string is not an answer, and
        // `set_view_state` says so.
        //
        // The three defaults are what the editor opens on with nothing stored, which is also
        // exactly what every deck that predates this step gets: `live` is the deck the user
        // actually has, and `category`/`alphabetical` are the editor's own opening pair.
        tx.execute_batch(
            "ALTER TABLE decks ADD COLUMN last_variant TEXT NOT NULL DEFAULT 'live';
             ALTER TABLE decks ADD COLUMN last_group_by TEXT NOT NULL DEFAULT 'category';
             ALTER TABLE decks ADD COLUMN last_sort_by TEXT NOT NULL DEFAULT 'alphabetical';",
        )?;
        // Literal `12`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 12;")?;
        tx.commit()?;
    }
    if v < 13 {
        let tx = conn.unchecked_transaction()?;
        // Whether this deck files its variable-cost cards under a heading of their own.
        //
        // **A per-deck column and not a preference**, for [`crate::deck::DeckRow`]'s
        // `theory_enabled` reason: it is a statement about how *this* list is read, so a copy
        // of the deck must read the same way and a second deck must be free to disagree. A
        // global setting would have made opening one deck change the shape of every other.
        //
        // **Its own rung rather than a fourth column on v12, and that was not a choice.** This
        // step and the one above it were written the same day on two branches, each numbered 12
        // against a ladder whose head was 11 — a collision `git` cannot see, because two
        // `ALTER TABLE decks ADD COLUMN`s in two files conflict in neither. The one that landed
        // first keeps the number. Folding this column into v12 after that would have been the
        // real damage: every machine that had already run v12 would skip the step, and the
        // column would exist on new installs and on nobody else's disk. **A version that has
        // shipped is spent** — the ladder only ever grows.
        //
        // `NOT NULL DEFAULT 0`, so every deck that predates this reads exactly as it did — X
        // cards stay in whatever pile their mana value put them in until somebody asks
        // otherwise. The default is where the whole "no upgrade changes what a user sees" claim
        // lives; there is no backfill because there is nothing to compute.
        //
        // Nothing here touches `cards`, so no entry in [`CARDS_INDEXES`] and no claim on its
        // replay — v20 holds the title of newest creator. Nothing is FTS-indexed and no rowid
        // is renumbered, so no `cards_fts` rebuild is owed either.
        tx.execute_batch(
            "ALTER TABLE decks ADD COLUMN separate_x_group INTEGER NOT NULL DEFAULT 0;",
        )?;
        // Literal `13`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 13;")?;
        tx.commit()?;
    }
    if v < 14 {
        let tx = conn.unchecked_transaction()?;
        // Scryfall's Oracle Tags, in four tables plus a watermark.
        //
        // **The key is the `slug`, not Scryfall's tag uuid.** The uuid is what
        // `parent_ids`/`child_ids` reference *inside the file*, and it is resolved to a slug
        // during the ingest and then thrown away: a slug is stable, readable, and the thing
        // TypeScript matches on, while a uuid is a join key this database would carry for no
        // reader. `oracle_id` is likewise a **soft** reference to `cards.oracle_id` with no
        // foreign key — `swap_staging` drops `cards` on every sync, and this file names
        // 35 969 oracle ids that were collected on a different day from the corpus.
        //
        // **`oracle_tag_cards` is the closure, and it is the only table the app reads at
        // query time.** It holds one row per (card, tag) *including inherited tags*: if a
        // card is tagged `tutor-battle` and `tutor-battle`'s parents are `tutor` and
        // `battle-matters`, all three are rows. That is what lets the frontend answer "which
        // of these categories does this card belong to" with one indexed prefix scan per
        // card, instead of a recursive walk per lookup. The other three tables are the facts
        // it was computed from, kept because a closure with no source is unauditable —
        // `oracle_taggings` is what a card was *directly* tagged with, and
        // `oracle_tag_parents` is the hierarchy that was walked.
        //
        // `WITHOUT ROWID` on all four data tables: each *is* its primary key plus at most two
        // free-text columns, so an ordinary table's rowid b-tree would be a second copy of
        // the key. It also makes the primary key the physical order, which is the whole read
        // path — `WHERE oracle_id IN (…)` on `oracle_tag_cards` is a run of prefix scans over
        // the table itself. No secondary index is created here and none is owed.
        //
        // **684 of the 4 521 tags have more than one parent**, which is why
        // `oracle_tag_parents` is a table of edges with a composite key rather than a
        // `parent_slug` column on `oracle_tags`. Measured live 2026-08-14 over the day's
        // file: 926 roots, max depth 5, no cycles and no dangling parent ids — none of which
        // the ingest assumes, because none of it is promised.
        //
        // `weight` is stored and nothing branches on it: 99.74 % of taggings are `median`, so
        // it carries no signal today. It is kept because it is the file's own word about the
        // tagging and inventing it back later would need a re-download.
        //
        // Nothing here touches `cards`, so no entry in [`CARDS_INDEXES`] and no claim on its
        // replay — v20 holds the title of newest creator, exactly as v8 (the deck tables),
        // v9 (the error log) and v11 (the price tables) left it. Nothing here is FTS-indexed
        // and no rowid is renumbered, so no `cards_fts` rebuild is owed: the reasoning
        // `the_v2_backfill_leaves_the_search_index_answering` pins.
        tx.execute_batch(ORACLE_TAG_TABLES_SQL)?;
        // Literal `14`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 14;")?;
        tx.commit()?;
    }
    if v < 15 {
        let tx = conn.unchecked_transaction()?;
        // **Who made the pile.** `'auto'` is the app, filing a card it had to invent a column
        // for; `'user'` is the reader, pressing "New category" — and the four the schema seeds
        // count as the reader's, because a deck's rules zones are piles nobody has to earn.
        //
        // It is a *stored fact* rather than a name comparison, and that is the whole design.
        // TypeScript hides an **empty** auto pile (a Ramp column with no ramp in it is a
        // heading about nothing) and always draws a user one. Deciding that from the name
        // instead would misfire on exactly the case this is for: "Ramp", "Draw", "Removal" and
        // "Land" are what a person calls their own piles, and
        // [`DECK_CATEGORY_GRAIN`] is `(deck_id, name)` — one pile per name per deck — so
        // `deck_meta::category_for_name` *finds* a reader's "Ramp" rather than making a second
        // one, and their pile would silently start hiding itself the first ramp spell they
        // added. Provenance is a fact, so Rust records it and TypeScript concludes from it.
        //
        // **No CHECK, and no Rust fence either.** `ALTER TABLE … ADD COLUMN` cannot add a
        // CHECK — `decks.last_variant`'s constraint, one rung down at v12 — and unlike that
        // column this one needs no Rust `valid_…` in its place: `origin` is never supplied by
        // a caller. It is written by four INSERTs inside this crate (`category_for_name`,
        // `create_category`, `ensure_predefined_categories`, and `deck::duplicate_deck`, which
        // copies the source pile's answer) and by no command parameter, so there is no
        // untrusted value to refuse.
        //
        // `DEFAULT 'user'` fills every row that predates the column, which is the safe half of
        // the guess below: a pile this step cannot identify keeps drawing, exactly as it did
        // before the upgrade.
        //
        // Nothing here touches `cards`, so no entry in [`CARDS_INDEXES`] and no claim on its
        // replay — v20 holds the title of newest creator, exactly as v8 (the deck tables), v9
        // (the error log), v11 (the price tables), v12/v13 (the two `decks` rungs) and v14
        // (the oracle-tag tables) left it. Nothing here is FTS-indexed and no rowid is
        // renumbered, so no `cards_fts` rebuild is owed either: the reasoning
        // `the_v2_backfill_leaves_the_search_index_answering` pins.
        tx.execute_batch(
            "ALTER TABLE deck_categories ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';",
        )?;
        // The backfill: a **one-time historical guess**, because rows that predate the column
        // carry no evidence of who made them and none can be recovered. The best available
        // signal is the name — a `main` pile called one of the words `autoCategoryFor` can
        // answer with was, on the balance of probability, made by the add path.
        //
        // **Frozen, and deliberately not kept in step with TypeScript's list.** These 22 names
        // are a snapshot of what that rule answered on the day this step shipped, spelled out
        // as literals for [`CARDS_COLUMNS`]'s reason and [`PREDEFINED_CATEGORIES`]'s: a
        // migration is history the moment it ships. A fourteenth functional bucket added to
        // `src/features/decks/autoCategory.ts` next month does **not** belong here — it would
        // rewrite what a past migration did on new installs only, while every machine that has
        // already run this step keeps the old answer.
        //
        // **Both ways of being wrong are mild and self-correcting.** A reader's own "Ramp"
        // marked `auto` hides only while it is empty, and the next ramp card they file brings
        // it back for good. An app-made pile left `user` simply keeps drawing empty, which is
        // what every one of them did before this change; deleting it is one press. Neither
        // loses a card, a name or an order, which is why a guess is allowed here at all.
        //
        // **"Main deck" is deliberately not on the list.** It is the v8 migration's own pile —
        // the one every legacy `main` row was filed into — so it is a real column holding real
        // cards on every database old enough to have one, and marking it `auto` would hide the
        // reader's whole deck the moment a filter emptied it. It is also a name no rule can
        // produce, so it is not an omission from the snapshot: it was never in it.
        tx.execute_batch(
            "UPDATE deck_categories SET origin = 'auto'
              WHERE kind = 'main'
                AND name IN ('Removal', 'Ramp', 'Recursion', 'Draw', 'Tutor', 'Protection',
                             'Anthem', 'Stax', 'Tokens', 'Sacrifice', 'Lifegain', 'Mill',
                             'Burn',
                             'Land', 'Creature', 'Artifact', 'Enchantment', 'Planeswalker',
                             'Battle', 'Instant', 'Sorcery',
                             'Uncategorised');",
        )?;
        // Literal `15`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 15;")?;
        tx.commit()?;
    }
    if v < 16 {
        let tx = conn.unchecked_transaction()?;
        // **Which pile an add with no pile named lands in** — the deck editor's "Add to" answer,
        // which was a `useState` in `DeckEditor` until this rung and is a fact about the deck
        // from here on. It moved because it is asked in the deck's settings now, and a setting
        // that a reader sets in a settings dialog and loses when they close the deck is not one.
        //
        // **`0` is `Auto` and is a real value rather than a missing one**, which is the whole
        // reason this column is `NOT NULL` with no foreign key. Three things follow from it and
        // each is load-bearing:
        //
        // 1. `deck_categories.id` is an `INTEGER PRIMARY KEY`, so no category can ever *be* 0 —
        //    the same guarantee `src/features/decks/autoCategory.ts`'s `AUTO_CATEGORY` already
        //    rests on. One word for "the card's own text decides" on both sides of the IPC.
        // 2. [`crate::deck::DeckPatch`] writes `coalesce(?n, column)`, where a bound NULL means
        //    *leave it*. A nullable column would therefore need a command of its own to say
        //    "back to Auto" — `decks.folder_id`'s exact problem, and `deck::set_folder` is the
        //    price it pays. A sentinel inside the value space costs nothing and needs no second
        //    command.
        // 3. **The price is that `ON DELETE SET NULL` cannot do the clean-up**, so a deleted
        //    pile is put back to 0 by hand, in the transaction that deletes it
        //    (`deck_meta::delete_category`), and a duplicated deck's answer is **remapped** onto
        //    the copy's own categories in `deck::duplicate_deck` rather than copied. Those two
        //    sites are what an enforced FK would have bought, and they are named here because
        //    nothing in the DDL points at them.
        //
        // `DEFAULT 0` fills every deck that predates the column, which is exactly the behaviour
        // those decks already had: the editor opened on Auto every time and nothing remembered
        // otherwise. There is no backfill because there is nothing to recover — the value it
        // would recover was never stored anywhere.
        //
        // Nothing here touches `cards`, so no entry in [`CARDS_INDEXES`] and no claim on its
        // replay — v20 holds the title of newest creator, exactly as v8 (the deck tables), v9
        // (the error log), v11 (the price tables), v12/v13 (the two earlier `decks` rungs), v14
        // (the oracle-tag tables) and v15 (`deck_categories.origin`) left it. Nothing here is
        // FTS-indexed and no rowid is renumbered, so no `cards_fts` rebuild is owed either: the
        // reasoning `the_v2_backfill_leaves_the_search_index_answering` pins.
        tx.execute_batch(
            "ALTER TABLE decks ADD COLUMN default_category_id INTEGER NOT NULL DEFAULT 0;",
        )?;
        // Literal `16`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 16;")?;
        tx.commit()?;
    }
    if v < 17 {
        let tx = conn.unchecked_transaction()?;
        // **Undo's own journal, and deliberately not a column on `deck_audit`.**
        //
        // That table is append-only, never pruned, and read whole every time the history
        // drawer opens. A step for a category delete carries the rows the CASCADE took — a
        // whole pile of a deck — which is orders of magnitude larger than the sentence it
        // would have sat beside, and `deck_audit_list` selects its columns by name, so the
        // blob would have ridden along on every read of a feature that never wants it.
        // `src/features/decks/auditText.ts` is the only reader of `payload` and stays so.
        //
        // **`audit_id` is the primary key**, so the journal is 1:1 with a history row by
        // construction and one change cannot grow two steps. `deck_id` is denormalized from
        // `deck_audit` because it is what the cursor's index needs, and the cursor is the
        // hottest query in the feature; the join it saves is on every keystroke of a Ctrl+Z.
        //
        // **Both CASCADEs are load-bearing, and they are load-bearing for different reasons.**
        // `deck_id` is what keeps `deleting_a_deck_takes_its_history_with_it` true of this
        // table for free. `audit_id` is the sharper one: a step describing a change no history
        // row can be found for is a step undo would apply into nothing, silently, and the row
        // it named is not there to disagree with it — `deck_audit::record`'s own argument for
        // writing inside the caller's transaction, one table along.
        //
        // **`undone_at` NULL means "still applied", and it persists on purpose.** Undo
        // therefore survives a restart and carries on below where it stopped, which is what
        // "as far back as the history allows" means. Redo does not: it is a list of ids in
        // the webview's memory and dies with the window, which is the one asymmetry this
        // feature was asked for.
        //
        // Nothing here touches `cards`, so no entry in [`CARDS_INDEXES`] and no claim on its
        // replay — v20 holds the title of newest creator. Nothing is FTS-indexed and no rowid
        // is renumbered, so no `cards_fts` rebuild is owed either.
        //
        // **`AUDIT_KINDS` is untouched and stays at nine.** An undo records `kind = 'deck'`
        // with a `{"field":"undo","of":<id>}` payload rather than a tenth word, because
        // `deck_audit.kind`'s CHECK cannot be altered — SQLite has no `ALTER … CHECK` — and a
        // tenth word would mean rebuilding every reader's whole deck history for a spelling.
        // `import::commit_import` met this first and reused `add`/`remove` for it.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS deck_undo (
                audit_id INTEGER PRIMARY KEY
                    REFERENCES deck_audit(id) ON DELETE CASCADE,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                -- The reversal, both ways: {\"undo\":[Op,…],\"redo\":[Op,…]}. JSON for
                -- `deck_audit.payload`'s reason one table over: the shapes are Rust's, they
                -- grow with the write sites, and a step written by a newer build must not
                -- fail an older build's read of the rows beside it.
                step TEXT NOT NULL CHECK (json_valid(step)),
                -- NULL while the change is still applied. Stamped by an undo, cleared by a
                -- redo; the cursor is the newest row of this deck that is still NULL.
                undone_at INTEGER
             );
             CREATE INDEX IF NOT EXISTS idx_deck_undo_deck
                ON deck_undo (deck_id, audit_id DESC);",
        )?;
        // Literal `17`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 17;")?;
        tx.commit()?;
    }
    if v < 18 {
        let tx = conn.unchecked_transaction()?;
        // **Which platform a deck is for, and which platforms a format is playable on** — two
        // columns for one question, because the question has two halves and only one of them is
        // the reader's. `format_specs.games` is a *fact about the format*, seeded; `decks.
        // game_key` is the reader's answer, and the only thing it does is narrow the format
        // picker to the rows whose cell carries it.
        //
        // **`'any'` is a real value and not a missing one**, [`crate::deck::AUTO_CATEGORY`]'s
        // argument one column over: [`crate::deck::DeckPatch`] writes `coalesce(?n, column)`, so
        // a bound NULL is *leave it* and a nullable column could not have said "back to Any"
        // without a command of its own. `DEFAULT 'any'` also fills every deck that predates the
        // column with what those decks already were — no platform was ever asked about, so no
        // platform is what they answer.
        //
        // **`games` defaults to all three, which is the fail-open answer and is deliberate.**
        // The seed below writes every one of the 25 rows, so the default is reached only by a
        // row that escaped it; a format the filter *hides* because nobody gave it a platform is
        // a format the reader cannot build for, while one it wrongly offers is a format they can
        // simply not pick. The floor rather than an error, which is the rule the Oracle tags are
        // already read under.
        //
        // **No CHECK on either.** `decks.game_key` gets the Rust fence `last_variant` has
        // ([`crate::deck::valid_game`], over [`DECK_GAMES`]), because a command parameter
        // reaches it. `format_specs.games` gets none and needs none: no caller can write it, it
        // is this constant's alone, and a test walks the cells against [`GAMES`]. (The reason
        // written here until v19 was that `ADD COLUMN` cannot carry a CHECK — see the step
        // below, which adds one.)
        //
        // Nothing here touches `cards`, so no entry in [`CARDS_INDEXES`] and no claim on its
        // replay — v20 holds the title of newest creator. Nothing is FTS-indexed and no rowid is
        // renumbered, so no `cards_fts` rebuild is owed either.
        tx.execute_batch(
            "ALTER TABLE format_specs
                ADD COLUMN games TEXT NOT NULL DEFAULT 'paper,arena,mtgo';
             ALTER TABLE decks ADD COLUMN game_key TEXT NOT NULL DEFAULT 'any';",
        )?;
        // The head seed over the rows v5 wrote — `INSERT OR REPLACE`, which is the shape this
        // table's corrections have always taken. It is what fills `games` with something other
        // than the DDL default, and re-running it here rather than writing 25 `UPDATE`s is what
        // keeps one statement the single description of what a `format_specs` row holds.
        tx.execute_batch(FORMAT_SPECS_SEED)?;
        // Literal `18`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 18;")?;
        tx.commit()?;
    }
    if v < 19 {
        let tx = conn.unchecked_transaction()?;
        // **A deck card names a finish**, which reverses "a deck names a printing and never a
        // finish". Scryfall models foil as a finish *of* a printing rather than as a printing
        // — 53 224 of 107 337 paper printings carry one under the same id — so wanting the
        // foil copy was a thing the model had no way to say.
        //
        // **This step was written as v18 and landed as v19**, which is the collision this
        // ladder's own doc predicts: v18 (the game columns) was written on another branch
        // against the same head of 17 and merged first. Renumbering on the way in is the whole
        // of the rule — a version that has shipped is spent.
        //
        // **Nullable, and NULL is the regular copy, so there is no backfill**: every row that
        // predates this step already means what it now says. `'nonfoil'` is deliberately not
        // in the vocabulary — two spellings of "regular" would be two rows on the grain below
        // that draw identically on screen and sum apart, which is the worst shape a bug in
        // this table can have. `deck::normalise_finish` maps an incoming `nonfoil` to NULL at
        // the one command boundary; this CHECK is what makes any other path a hard error
        // rather than a quiet second row.
        //
        // **`ALTER TABLE … ADD COLUMN … CHECK (…)` is accepted and enforced**, which contradicts
        // what `src-tauri/CLAUDE.md` said twice (`deck_categories.origin` and
        // `decks.last_variant` both went unfenced on the belief that it could not be done, and
        // `last_variant` grew a Rust fence instead). Verified rather than assumed: an inserted
        // `'nonfoil'` raises `CHECK constraint failed` — see
        // `the_deck_card_finish_column_refuses_nonfoil`. SQLite's documented ADD COLUMN
        // restrictions are PRIMARY KEY, UNIQUE, a non-constant DEFAULT, NOT NULL without a
        // default, REFERENCES without a NULL default, and GENERATED STORED. A CHECK is not
        // among them.
        //
        // **The grain widens a third time** (v5 created it, v8 added `variant`), and the index
        // is a literal rather than `{DECK_CARD_GRAIN}` for the reason every step above writes
        // its own: a step is history the day it ships, and this one must keep building the
        // index it built today however the constant reads later. `coalesce(finish, '')` is
        // `COLLECTION_GRAIN`'s device — SQLite treats NULLs in a UNIQUE index as distinct, so
        // the bare column would stop every regular add from folding into the row already there.
        //
        // Nothing here touches `cards`, so no entry in [`CARDS_INDEXES`] and no claim on its
        // replay; nothing is FTS-indexed and no rowid is renumbered, so no `cards_fts` rebuild
        // is owed either.
        tx.execute_batch(
            "ALTER TABLE deck_cards ADD COLUMN finish TEXT
                CHECK (finish IS NULL OR finish IN ('foil','etched'));
             DROP INDEX IF EXISTS idx_deck_cards_grain;
             CREATE UNIQUE INDEX idx_deck_cards_grain
                ON deck_cards (deck_id, variant, category_id, card_id, coalesce(finish, ''));",
        )?;
        // Literal `19`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 19;")?;
        tx.commit()?;
    }
    if v < 20 {
        let tx = conn.unchecked_transaction()?;
        // **Scryfall Tagger's art tags, in a parallel set of tables rather than a `kind`
        // column on the oracle ones, because the join column differs.** An art tag is a fact
        // about an *illustration*: it belongs to the printings carrying that picture and to no
        // others, so a card with five arts has five illustrations and the dog is in one of
        // them. Folding both taxonomies into one table would mean a key that is an
        // `oracle_id` on some rows and an `illustration_id` on others, which is a column no
        // index can serve and no join can trust. See the 2026-08-20 research.
        tx.execute_batch(ART_TAG_TABLES_SQL)?;
        // The mute list. **A user table** — it is the reader's answer about which tags they
        // never want offered — so it is deliberately outside [`ART_TAG_TABLES`] and
        // [`ORACLE_TAG_TABLES`], the two lists a refresh drops and rebuilds wholesale. Both
        // taxonomies key into it, which is why it carries the namespace rather than being two
        // tables.
        tx.execute_batch(MUTED_TAGS_SQL)?;
        // `oracle_tags` gains the two columns [`ART_TAG_TABLES_SQL`] declares on its own
        // table, so that one mute list and one search can serve both namespaces.
        //
        // **Unconditional, because the `if` above already guarantees it runs once**: the
        // version bump is written in this same transaction, so a database that has run this
        // block never reaches it again. Backfilled as `''` rather than left NULL — the next
        // refresh rewrites every row, since the taxonomy is dropped and rebuilt wholesale, so
        // neither value is ever read. What the backfill buys is `NOT NULL` on both columns,
        // which is what lets the live table and its staging twin share one shape; and
        // `DEFAULT` is what makes the `ALTER` legal at all, since SQLite refuses to add a
        // `NOT NULL` column without one.
        tx.execute_batch(
            "ALTER TABLE oracle_tags ADD COLUMN id TEXT NOT NULL DEFAULT '';
             ALTER TABLE oracle_tags ADD COLUMN slug_norm TEXT NOT NULL DEFAULT '';",
        )?;
        // The indexes over the two taxonomies. Beside the tables rather than in them because
        // both live tables are renamed over by a swap, which is the same reason
        // [`CARDS_INDEXES`] is a list — see [`TAG_INDEXES_SQL`].
        tx.execute_batch(&on_schema("main", TAG_INDEXES_SQL))?;
        // **This step takes the [`CARDS_INDEXES`] replay over from v10**, which is the rule
        // that constant states: it describes `cards` at head, this is the newest step to touch
        // it, and a database sitting anywhere above v10 would otherwise never be handed
        // `idx_cards_illustration`. `IF NOT EXISTS` on every entry makes it a no-op for the
        // four that are already there.
        tx.execute_batch(&cards_indexes_sql("main"))?;
        // Nothing here is FTS-indexed and no rowid is renumbered, so no `cards_fts` rebuild is
        // owed — the reasoning `the_v2_backfill_leaves_the_search_index_answering` pins.
        //
        // Literal `20`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 20;")?;
        tx.commit()?;
    }
    if v < 21 {
        let tx = conn.unchecked_transaction()?;
        // **`deck_tags` stops being a deck's and becomes the app's.** [`DECK_TAG_GRAIN`] holds
        // the argument; [`globalise_tags`] is what it costs to carry out on a database that has
        // been filing labels per deck since v8.
        globalise_tags(&tx)?;
        // Nothing here is FTS-indexed and no `cards` rowid moves, so no rebuild is owed.
        //
        // Literal `21`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 21;")?;
        tx.commit()?;
    }
    if v < 22 {
        let tx = conn.unchecked_transaction()?;
        // **The oracle tag search comes back on. Issue #180.**
        //
        // v20 added `slug_norm` with `ALTER TABLE … ADD COLUMN`, which cannot add a `NOT NULL`
        // column without a default, so every `oracle_tags` row an existing database carried
        // over reads `''`. That step's comment argued the value was never read, because the
        // taxonomy is dropped and rebuilt wholesale on every refresh — and it is wrong by up
        // to a week, which is `tags::oracle::REFRESH_INTERVAL_SECS`. `tags::query` matches a
        // typed needle against exactly this column, so between the upgrade and the next
        // refresh **every oracle tag search answered nothing**, with no error, nothing in
        // `error_log`, and the art taxonomy — created empty by the same step, so ingested in
        // full at the first launch — working perfectly beside it. Which is how it was
        // reported.
        //
        // Recomputed here rather than waited for, because a refresh is not something this
        // app can promise: a machine that cannot reach Scryfall is a supported state, and one
        // that never refreshes would never have got the column back.
        //
        // **`id` is deliberately not backfilled and cannot be.** It is Scryfall's uuid and
        // nothing in the database derives it, so the blank stays until a refresh rewrites the
        // row. That state is already handled in words: `tags::query::not_muted` fences it with
        // `id <> ''` so one blank-id mute cannot hide the whole taxonomy, and `tag_mute`
        // refuses a blank id where the reader asked. A tag nobody can hide for a few days is
        // visible and reportable; a search that answers nothing is neither.
        backfill_oracle_slug_norm(&tx)?;
        // Data only — no table, no column and no index moves, so nothing is FTS-indexed, no
        // `cards` rowid is renumbered and no rebuild is owed.
        //
        // Literal `22`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 22;")?;
        tx.commit()?;
    }
    if v < 23 {
        let tx = conn.unchecked_transaction()?;
        // **The wishlist gets the deck gallery's filing cabinet.** Issue #165: a reader wants
        // to set cards aside without taking them off the list — expensive ones to buy later,
        // ones already ordered but not yet in hand, ones they are unsure about — and the
        // answer is folders over the shopping list rather than a status column, because a
        // status is a word the app would have to choose and a folder is a name the reader
        // chooses.
        //
        // It nests for [`deck_folders`]' reason and not for its own: the tree arithmetic, the
        // cycle refusal and the two cascade rules are already written and already tested one
        // table over, so nesting costs less here than writing a flat version would.
        //
        // **The two `ON DELETE` actions say what a folder is.** `parent_id` is CASCADE — a
        // folder inside a deleted folder has nowhere else to be, and it cascades onto its own
        // table so the whole sub-tree goes in one press. `wishlist_entries.folder_id` is SET
        // NULL — a folder is a *filing decision* and a wish is the reader's shopping list, so
        // deleting the cabinet must not throw away what was in it. The wishes surface at the
        // root, which is where they were before anybody filed them. That is `decks.folder_id`
        // exactly, and it is the second of the only two SET NULLs the deck side has.
        //
        // **`idx_wishlist_grain` is rebuilt rather than added to, because SQLite has no
        // `ALTER INDEX`.** An index is its definition; widening one is `DROP` then `CREATE`,
        // and the `DROP` has to come first or the `CREATE` is a silent no-op on exactly the
        // machines that already have the narrow index — the rule [`CARDS_INDEXES`]' own note
        // states. The `IF EXISTS` is for the one database that has neither: a v4-era install
        // built the index with `IF NOT EXISTS`, so it is there on every real machine, but a
        // rewind fixture may have taken it away and a step that died on its absence would be
        // a step no fixture could re-enter.
        //
        // The DDL below is **spelled out literally and never interpolated from
        // [`WISHLIST_GRAIN`]**, for the reason [`CARDS_COLUMNS`] is frozen and the v4 and v8
        // steps repeat: a migration step is history. A step that read the constant would
        // silently rewrite what a *fresh* install creates the next time the grain moves, while
        // every already-upgraded database kept the old shape — and the two would then disagree
        // about what makes two wishes the same wish, with no error anywhere.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS wishlist_folders (
                id INTEGER PRIMARY KEY,
                -- User↔user, CASCADE: deleting a folder deletes the folders inside it. The
                -- WISHES inside it are NOT deleted — see `wishlist_entries.folder_id` below,
                -- which is SET NULL. A folder is a filing decision; a wish is the reader's
                -- shopping list.
                parent_id INTEGER REFERENCES wishlist_folders(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_wishlist_folders_parent
                ON wishlist_folders (parent_id);",
        )?;
        // **The column is probed for rather than guarded, because `ADD COLUMN` has no
        // `IF NOT EXISTS`.** SQLite offers that clause on `CREATE TABLE` and `CREATE INDEX`
        // and on neither half of `ALTER TABLE`, so the only way to make this statement
        // re-enterable is to ask the catalog first — `pragma_table_info` answers one row per
        // column and none for a column that is not there.
        //
        // It has to be re-enterable because [`UNDO_V23`] leaves `folder_id` standing, and that
        // is a **choice** rather than something SQLite forbids: it is true that `DROP COLUMN`
        // refuses a column any index names, and two name this one, but dropping
        // `idx_wishlist_grain` and `idx_wishlist_folder` first makes the `DROP COLUMN` succeed
        // (measured 2026-08-22). What the rewind will not do is the statement after that —
        // putting the three-term index back means building a *narrow* unique index over rows
        // written on the wide grain, which is a constraint failure on exactly the fixture that
        // has something interesting in the table. So every rewound fixture beneath head
        // re-enters this step carrying the column, and a blind `ALTER` would answer `duplicate
        // column name` — a failure no real upgrade can produce, which is the definition of a
        // fixture lying about what it is testing.
        // [`migrating_a_v22_wishlist_files_every_existing_wish_at_the_root`] pays the full
        // rewind by hand instead, because the probe skipping the `ALTER` is not the upgrade.
        let has_folder: bool = tx.query_row(
            "SELECT count(*) FROM pragma_table_info('wishlist_entries') WHERE name = 'folder_id'",
            [],
            |r| r.get::<_, i64>(0),
        )? > 0;
        if !has_folder {
            tx.execute_batch(
                "ALTER TABLE wishlist_entries ADD COLUMN folder_id INTEGER
                    REFERENCES wishlist_folders(id) ON DELETE SET NULL;",
            )?;
        }
        tx.execute_batch(
            "DROP INDEX IF EXISTS idx_wishlist_grain;
             CREATE UNIQUE INDEX idx_wishlist_grain
                ON wishlist_entries (coalesce(oracle_id, ''), coalesce(card_id, ''),
                                     coalesce(preferred_finish, ''), coalesce(folder_id, 0));
             CREATE INDEX IF NOT EXISTS idx_wishlist_folder ON wishlist_entries (folder_id);",
        )?;
        // **No backfill, and the absence is the design.** `folder_id` arrives NULL on every
        // existing row, NULL is the root, and the root is the list the reader already sees,
        // so an upgrade is invisible until they make their first folder. This is the one
        // shape of `ALTER TABLE … ADD COLUMN` that owes no fence and no backfill under the
        // rule v22 was paid for: the unset value is not a lie a `DEFAULT` is telling, it is
        // the answer.
        //
        // Nothing here is FTS-indexed and no `cards` rowid moves, so no rebuild is owed — the
        // reasoning `the_v2_backfill_leaves_the_search_index_answering` pins.
        //
        // Literal `23`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 23;")?;
        tx.commit()?;
    }
    if v < 24 {
        let tx = conn.unchecked_transaction()?;
        // **The collection gets the wishlist's filing cabinet.** It is the v23 rung one table
        // over, with two columns v23 did not need: `kind` and `deck_id`, because two of these
        // folders are not the reader's to name. A `deck` folder stands for a deck and there is
        // at most one per deck; the `removed` folder is the single place copies go when they
        // leave the collection without leaving the database. Both are enforced by a partial
        // unique index rather than by the code that writes them — [`COLLECTION_FOLDER_KINDS`]
        // names the three words, and the CHECK below spells them out.
        //
        // **Nothing is filed by this step, and the absence is the design.** Every existing row
        // keeps `folder_id` NULL, NULL is the root, and the root is the list the reader already
        // sees — so an upgrade is invisible until they make their first folder. This is the
        // shape of `ALTER TABLE … ADD COLUMN` that owes no fence and no backfill: the unset
        // value is not a lie a `DEFAULT` is telling, it is the answer.
        //
        // **The two `ON DELETE` actions say what a folder is**, exactly as v23's pair does.
        // `parent_id` is CASCADE — a folder inside a deleted folder has nowhere else to be, and
        // it cascades onto its own table so the whole sub-tree goes in one press.
        // `collection_entries.folder_id` is SET NULL — a folder is a *filing decision* and the
        // cards are the reader's property, so deleting the cabinet must never delete what was
        // in it. The copies surface at the root, which is where they were before anybody filed
        // them. `deck_id` is CASCADE for `parent_id`'s reason and not for the entries': a
        // folder that stands for a deck has no meaning once that deck is gone.
        //
        // The DDL is **spelled out literally and never interpolated from
        // [`COLLECTION_GRAIN`]/[`COLLECTION_FOLDER_KINDS`]**, for the reason [`CARDS_COLUMNS`]
        // is frozen and the v4, v8 and v23 steps repeat: a migration step is history. A step
        // that read the constant would silently rewrite what a *fresh* install creates the next
        // time the grain moves, while every already-upgraded database kept the old shape — and
        // the two would then disagree about what makes two rows the same row, with nothing
        // going red.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS collection_folders (
                 id INTEGER PRIMARY KEY,
                 parent_id INTEGER REFERENCES collection_folders(id) ON DELETE CASCADE,
                 name TEXT NOT NULL,
                 kind TEXT NOT NULL DEFAULT 'user'
                     CHECK (kind IN ('user','deck','removed')),
                 deck_id INTEGER REFERENCES decks(id) ON DELETE CASCADE,
                 sort_order INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 CHECK ((kind = 'deck') = (deck_id IS NOT NULL))
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_folder_removed
                 ON collection_folders(kind) WHERE kind = 'removed';
             CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_folder_deck
                 ON collection_folders(deck_id) WHERE deck_id IS NOT NULL;",
        )?;
        // **The column is probed for rather than guarded, because `ADD COLUMN` has no
        // `IF NOT EXISTS`.** SQLite offers that clause on `CREATE TABLE` and `CREATE INDEX` and
        // on neither half of `ALTER TABLE`, so the only way to make this statement re-enterable
        // is to ask the catalog first — `pragma_table_info` answers one row per column and none
        // for a column that is not there.
        //
        // It has to be re-enterable because the test module's `UNDO_V24` leaves `folder_id`
        // standing. SQLite refuses `DROP COLUMN` on a column an index names, and two name this
        // one — the grain's eleventh term is `coalesce(folder_id, 0)` — so a rewind would have
        // to drop both indexes first; what stops it is the statement after that, since putting
        // the ten-column index back means building a *narrower* unique index over rows written
        // on the wide grain. So every rewound fixture beneath head re-enters this step carrying
        // the column, and a blind `ALTER` would answer `duplicate column name` — a failure no
        // real upgrade can produce, which is the definition of a fixture lying about what it is
        // testing.
        let has_folder: bool = tx.query_row(
            "SELECT count(*) FROM pragma_table_info('collection_entries')
              WHERE name = 'folder_id'",
            [],
            |r| r.get::<_, i64>(0),
        )? > 0;
        if !has_folder {
            tx.execute_batch(
                "ALTER TABLE collection_entries ADD COLUMN folder_id INTEGER
                     REFERENCES collection_folders(id) ON DELETE SET NULL;",
            )?;
        }
        // **`DROP` comes first: SQLite has no `ALTER INDEX`**, and `CREATE … IF NOT EXISTS` is
        // a silent no-op on exactly the machines that already carry the ten-column index — the
        // ones that matter. The `IF EXISTS` is for the one database that has neither: a v3-era
        // install built the index with `IF NOT EXISTS`, so it is there on every real machine,
        // but a fixture may have taken it away and a step that died on its absence would be a
        // step no fixture could re-enter.
        //
        // **The widening is safe over existing rows for the reason v23's is**: `ADD COLUMN`
        // supplies no default, so `folder_id` is NULL on every carried-over row and
        // `coalesce(folder_id, 0)` is the constant 0 across the whole table. The new key is the
        // old key plus a constant, which makes the widened index strictly more permissive than
        // the one it replaces — two rows that clash on eleven terms clashed on ten, and the
        // ten-column index would already have refused them.
        //
        // The `DELETE` is the one thing here that is not additive, and it is the rung paying
        // for a state that stops being reachable: a row holding no copies was a placeholder for
        // a printing the reader owns none of, and with folders it is indistinguishable from a
        // row somebody filed and emptied. `quantity >= 0` stays — a stepper still passes
        // through zero within a session — but a *stored* zero is not a row the reader owns.
        tx.execute_batch(
            "DROP INDEX IF EXISTS idx_collection_grain;
             CREATE UNIQUE INDEX idx_collection_grain ON collection_entries (
                 card_id, finish, condition, lang, altered, signed, proxy, misprint,
                 coalesce(serial_number, ''), coalesce(grading, ''), coalesce(folder_id, 0)
             );
             CREATE INDEX IF NOT EXISTS idx_collection_folder
                 ON collection_entries (folder_id);
             DELETE FROM collection_entries WHERE quantity = 0;",
        )?;
        // Nothing here is FTS-indexed and no `cards` rowid moves, so no rebuild is owed — the
        // reasoning `the_v2_backfill_leaves_the_search_index_answering` pins.
        //
        // Literal `24`, for the reason every step before it writes its own: this step is what
        // *makes* a database version 24, and [`LEGACY_SINGLE_FILE_VERSION`] moves again at v25.
        tx.execute_batch("PRAGMA user_version = 24;")?;
        tx.commit()?;
    }
    if v < 25 {
        let tx = conn.unchecked_transaction()?;
        // **The folders stop being empty, and a deck stops *claiming* copies it does not
        // hold.** v24 built the cabinet — [`COLLECTION_FOLDER_KINDS`]' three words, both
        // partial unique indexes, `folder_id` as the grain's eleventh term — and filed nothing
        // into it. This is the rung that files. After it, "which deck holds this card" is
        // answered by where the collection row *sits* rather than by a claim ledger an
        // allocator recomputed, and `deck_allocations` has nothing left to say.
        //
        // **Order is the whole of this step's correctness: insert the folders, convert, then
        // drop.** Dropping the ledger before reading it destroys the very thing being
        // converted, and there is no second copy of it anywhere.
        //
        // The DDL and the conflict target below are **spelled out literally and never
        // interpolated from [`COLLECTION_GRAIN`]/[`COLLECTION_FOLDER_KINDS`]**, for the reason
        // [`CARDS_COLUMNS`] is frozen and the v4, v8, v23 and v24 steps repeat: a migration
        // step is history, and a step that read a constant would silently rewrite what a
        // *fresh* install creates the next time that constant moves.

        // One holding area for the whole database — where copies go when they leave the
        // collection without leaving the database. The partial unique index v24 created makes
        // a second one impossible, so this insert is also the assertion that there is one.
        tx.execute_batch(
            "INSERT INTO collection_folders
                 (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
             VALUES (NULL, 'Recently removed', 'removed', NULL, 0, unixepoch(), unixepoch());",
        )?;
        // One group per deck, named after it. **Archived decks included**: archiving is a flag
        // and not a delete, and an archived deck still holds its cards — leaving it out would
        // make the upgrade lose exactly the copies nobody is looking at.
        tx.execute_batch(
            "INSERT INTO collection_folders
                 (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
             SELECT NULL, name, 'deck', id, 0, unixepoch(), unixepoch() FROM decks;",
        )?;

        // **The conversion is in Rust rather than in SQL, because it splits rows.** One
        // statement cannot both create the placement and reduce the row it came from, and the
        // clamp below is not expressible over a table that same statement is writing to.
        //
        // **Ascending by `id`, which is first-claim-first-served**, and the order matters
        // wherever two decks claimed the same row and the copies do not stretch to both: a
        // claim was a *reservation* and could overlap, a placement is *custody* and cannot, so
        // one of them has to lose and the older claim is the one with the better story.
        let claims: Vec<(i64, i64, i64)> = {
            let mut stmt = tx.prepare(
                "SELECT deck_id, collection_entry_id, quantity FROM deck_allocations ORDER BY id",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (deck_id, entry_id, claimed) in claims {
            // The source can already be gone: an earlier claim on the same row may have taken
            // every copy, and a row holding nothing is deleted rather than left at zero (v24's
            // rule). `.optional()` rather than an unwrap, because that is a normal outcome.
            //
            // `tradelist_quantity` is read here with the quantity because the split has to
            // divide it — see the two clamps below.
            let source: Option<(i64, i64)> = tx
                .query_row(
                    "SELECT quantity, tradelist_quantity FROM collection_entries WHERE id = ?1",
                    params![entry_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let held = source.map(|(q, _)| q);
            let offered = source.map_or(0, |(_, t)| t);
            // **The clamp, and it is not optional.** The old ledger could out-claim a row that
            // was later stepped down — nothing refused it, because `deck::owned_by_oracle`
            // applied `min(a.quantity, e.quantity)` at *read* time and the stored overclaim
            // never showed. Reading the claim literally here would invent copies the reader
            // does not own, permanently and with nothing to compare against afterwards.
            let take = held.unwrap_or(0).min(claimed);
            if take == 0 {
                continue;
            }
            // **The trade list is split, never copied**, and this is the second clamp the rung
            // owes. `tradelist_quantity` says how many of *these* copies are offered for trade;
            // carrying the number verbatim onto the placement and leaving the source's alone
            // would make a row of 4 offered 2, split in half, into two rows of 2 **each**
            // offering 2 — the reader promising four copies they do not have, with both halves
            // holding `tradelist > quantity`. Nothing in the database refuses that: there is no
            // CHECK tying the two columns, so it would commit in silence, and a rung is
            // one-shot. Every writer that runs afterwards clamps against exactly this invariant
            // — [`crate::collection::add_entry`], `set_quantity`, `update_entry` and
            // [`crate::collection_folders::take_copies`], whose doc says it in one line:
            // *"Duplicating it would put a card on the trade list twice by moving it."*
            //
            // The arithmetic is `take_copies`' own: the copies that travel take
            // `min(offered, take)` and the remainder keeps what is left. **Each half is then
            // clamped to its own quantity a second time**, which matters only for a database
            // that already held `tradelist > quantity` — nothing this crate writes can, but a
            // hand-edited row can, and a conversion that carried such a row forward would
            // manufacture the very state it is here to avoid. Both clamps can only leave the
            // total where it was or take it down; neither can grow it.
            let moved_trade = offered.min(take);
            let kept_trade = (offered - moved_trade).min(held.unwrap_or(0) - take);
            let folder: i64 = tx.query_row(
                "SELECT id FROM collection_folders WHERE deck_id = ?1",
                params![deck_id],
                |r| r.get(0),
            )?;
            // **The placement carries every grain column and every column that is the row's
            // story**, because the copies in the deck are the same physical cards: bought on
            // the same day, for the same money, in the same condition, with the same note on
            // the sleeve. A bare row here would be the upgrade quietly deleting a history that
            // took years to accumulate — the same cost v24 accepted for a stepper taken to
            // zero, and there is no reason to pay it twice.
            //
            // `ON CONFLICT` rather than a plain insert because two claims on one entry from
            // **one** deck are one placement (two decks are two placements, which the folder
            // term keeps apart). It is the eleven-term grain v24 built, verbatim.
            //
            // **The `DO UPDATE` sums the trade list beside the quantity**, for the same reason
            // [`crate::collection::fold_entry`] does: two rows that merge are one pile, and
            // what each was offering is still offered. Leaving that column at the survivor's
            // value would quietly *drop* the arriving row's promise, which is the safe
            // direction but not the true one — and the sum cannot break the invariant either
            // way, since each side arrives already clamped to its own quantity and the
            // quantities sum in the same statement.
            tx.execute(
                "INSERT INTO collection_entries
                     (card_id, set_code, collector_number, lang, finish, condition,
                      condition_original, quantity, tradelist_quantity, purchase_price,
                      purchase_currency, acquired_at, acquisition_source, serial_number,
                      altered, signed, proxy, misprint, grading, tags, notes, needs_review,
                      folder_id, created_at, updated_at)
                 SELECT card_id, set_code, collector_number, lang, finish, condition,
                        condition_original, ?2, ?4, purchase_price,
                        purchase_currency, acquired_at, acquisition_source, serial_number,
                        altered, signed, proxy, misprint, grading, tags, notes, needs_review,
                        ?3, created_at, unixepoch()
                   FROM collection_entries WHERE id = ?1
                 ON CONFLICT (card_id, finish, condition, lang, altered, signed, proxy,
                              misprint, coalesce(serial_number, ''), coalesce(grading, ''),
                              coalesce(folder_id, 0))
                 DO UPDATE SET quantity = quantity + excluded.quantity,
                               tradelist_quantity = tradelist_quantity
                                                    + excluded.tradelist_quantity,
                               updated_at = unixepoch()",
                params![entry_id, take, folder, moved_trade],
            )?;
            // And the source loses exactly what left it — never more, never less — including
            // the share of its trade list that travelled. It is deleted at zero rather than
            // left standing empty, for v24's reason: with the folder in the grain, a row
            // holding no copies is indistinguishable from a row somebody filed and emptied.
            // (The `DELETE` below takes the trade list with it, so a row emptied of copies
            // cannot leave a promise standing.)
            tx.execute(
                "UPDATE collection_entries
                    SET quantity = quantity - ?2, tradelist_quantity = ?3,
                        updated_at = unixepoch()
                  WHERE id = ?1",
                params![entry_id, take, kept_trade],
            )?;
            tx.execute(
                "DELETE FROM collection_entries WHERE id = ?1 AND quantity = 0",
                params![entry_id],
            )?;
        }

        // **Last, and only now.** `DROP TABLE` takes `idx_deck_allocations_grain` and
        // `idx_deck_allocations_entry` with it, which is why neither is named here.
        //
        // **`is_built` is dropped rather than kept, and SQLite would refuse if any index named
        // it** — `DROP COLUMN` fails on an indexed column, and it would fail at a real reader's
        // first upgrade rather than in any test that starts from a fresh database. Nothing
        // indexes it: the column exists only in v8's `CREATE TABLE` body and in the reads
        // `deck.rs` makes of it (verified 2026-08-23, and every fixture on this ladder walks
        // this statement over a `decks` table built by a different route).
        //
        // The `app_meta` row is the deck-driven collection switch, whose whole question this
        // rung answers: the decks *are* where the cards are now, so there is nothing left to
        // turn on. A key nothing writes any more is a key that would sit in that table forever.
        tx.execute_batch(
            "DROP TABLE deck_allocations;
             ALTER TABLE decks DROP COLUMN is_built;
             DELETE FROM app_meta WHERE key = 'deck_driven_collection';",
        )?;
        // Nothing here is FTS-indexed and no `cards` rowid moves, so no rebuild is owed — the
        // reasoning `the_v2_backfill_leaves_the_search_index_answering` pins.
        //
        // Literal `25`, for the reason every step before it writes its own: this step is what
        // *makes* a database version 25, and [`LEGACY_SINGLE_FILE_VERSION`] moves again at v26.
        tx.execute_batch("PRAGMA user_version = 25;")?;
        tx.commit()?;
    }
    if v < 26 {
        let tx = conn.unchecked_transaction()?;
        // **A deck can be told which Commander bracket it is, and the app gains somewhere to
        // keep the combos it needs to guess.** Two unrelated-looking halves in one rung because
        // they answer one question: the bracket readout on a deck's header was an estimate the
        // reader could not correct and could not see the working of, and the two things it was
        // missing are a stored answer and a combo list.
        //
        // **`bracket` is `NOT NULL DEFAULT 0` with `0` meaning *Auto*, deliberately mirroring
        // `decks.default_category_id`'s sentinel rather than being nullable** —
        // [`crate::deck::AUTO_BRACKET`] is the name, and [`crate::deck::AUTO_CATEGORY`] is the
        // column it is copying. [`crate::deck::DeckPatch`]'s convention is that an absent field
        // means "leave it", written as `coalesce(?n, column)`, which reads a bound NULL the
        // same way — so a nullable column could not express "put it back to Auto" without a
        // command of its own or a double-`Option` across the whole struct. `1`–`5` are the
        // reader's own answer; `0` says the estimate stands.
        //
        // **The range fence is Rust's, because `ALTER TABLE … ADD COLUMN` cannot carry a
        // CHECK**, and that restriction is real where two other comments in this file have had
        // to be corrected: SQLite's documented ADD COLUMN restrictions are PRIMARY KEY, UNIQUE,
        // a non-constant DEFAULT, NOT NULL without a default, REFERENCES without a NULL default
        // and GENERATED STORED — a plain `CHECK (bracket BETWEEN 0 AND 5)` is **not** on that
        // list and v19's `deck_cards.finish` adds an enforced one exactly this way. What is on
        // the list is the thing this column needs: it is `NOT NULL DEFAULT 0`, and a CHECK
        // added by `ALTER` is evaluated against every existing row, which is fine here and
        // still leaves the fence in the wrong place. A command parameter reaches this column,
        // and a refusal in Rust can say *which* number was wrong and what the legal ones are
        // where a `CHECK constraint failed` names the constraint — `deck::valid_game`'s
        // argument over `decks.game_key`, one column along. [`crate::deck::valid_bracket`] is
        // that fence.
        //
        // **Every existing deck reads `0`, and that is the answer rather than a lie a DEFAULT
        // is telling** — v24's `folder_id` shape, and the distinction its comment draws: a
        // reader who has never been asked which bracket their deck is has not answered "1", they
        // have left it on Auto, which is what the app did for them before this rung existed.
        tx.execute_batch("ALTER TABLE decks ADD COLUMN bracket INTEGER NOT NULL DEFAULT 0;")?;
        // The combo feed's three tables. **A fourth optional bulk download**, ingested the way
        // the price feeds and the two tagger datasets are: nothing is fetched until a reader
        // asks, a failure keeps the previous rows, and a database that has never ingested is a
        // supported state whose bracket estimate simply reads three signals instead of four.
        //
        // Spelled out **literally**, [`CARDS_COLUMNS`]' rule and the one every rung from v4 on
        // repeats: a migration step is history, and a step that interpolated a constant would
        // silently rewrite what a *fresh* install creates the next time that constant moved.
        // [`COMBO_STAGING_SQL`] is a second literal for [`ORACLE_TAG_STAGING_SQL`]'s reason.
        //
        // The rows are the feed's own facts and nothing here concludes anything from them:
        // `bracket_tag` is Commander Spellbook's editorial letter carried through verbatim, and
        // what a letter *means* for a deck's bracket floor is TypeScript's, which is the
        // crate's boundary applied to a fourth data source.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS combos (
                 -- Commander Spellbook's variant id, e.g. `1957-4050-7918--204`. TEXT because
                 -- it is theirs: nothing here mints one, and a row is only ever replaced
                 -- wholesale by the next ingest.
                 id             TEXT PRIMARY KEY,
                 -- One of R|S|P|O|C|E|B — Ruthless, Spicy, Powerful, Oddball, Core, Exhibition,
                 -- Banned. No CHECK: the vocabulary is the *feed's* and may grow the day they
                 -- add a letter, and a CHECK here would turn that into an ingest that fails
                 -- rather than a letter this app does not raise a floor for.
                 bracket_tag    TEXT NOT NULL,
                 -- DISTINCT oracle ids in `combo_cards` for this combo, stored rather than
                 -- counted: the match query compares it against what a deck holds, and a
                 -- correlated count per candidate combo is the shape that turns a deck check
                 -- into a scan.
                 card_count     INTEGER NOT NULL,
                 -- The feed's `requires[]` — *templates* like `a creature with flying`, which
                 -- resolve to no card id. `> 0` means this app cannot fully check the combo, so
                 -- it is shown as possible and kept out of the arithmetic.
                 template_count INTEGER NOT NULL,
                 -- Colour identity of the combo, the feed's own spelling.
                 identity       TEXT NOT NULL,
                 -- What it does: feature names, newline-joined. One column rather than a fourth
                 -- table because nothing queries it — it is read whole, for one combo, to be
                 -- printed.
                 produces       TEXT NOT NULL,
                 -- How many decks Spellbook has seen it in. NULL where the feed carries none,
                 -- which is not the same as zero and must not be faked into it.
                 popularity     INTEGER
             );
             CREATE TABLE IF NOT EXISTS combo_cards (
                 -- **The one enforced foreign key in this rung**, and the module doc says why
                 -- it is legal where a key on `cards.id` never is. ON DELETE CASCADE so a combo
                 -- cannot leave its own card list behind it.
                 combo_id          TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
                 -- `cards.oracle_id`, **softly** — the corpus is dropped and recreated on every
                 -- sync, so a declared reference here would abort one. A combo naming a card
                 -- this database has never synced is a row that simply never matches.
                 oracle_id         TEXT NOT NULL,
                 -- Denormalised for the same reason every user table denormalises a printing:
                 -- the list has to stay readable when the id stops resolving.
                 name              TEXT NOT NULL,
                 quantity          INTEGER NOT NULL,
                 must_be_commander INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS combo_meta (
                 -- One row, ever — `oracle_tag_meta`'s shape and its reason: this watermark and
                 -- the card sync's describe different files on different schedules, and a
                 -- failed combo refresh must not read as a failed sync.
                 id          INTEGER PRIMARY KEY CHECK (id = 1),
                 -- Replayed as `If-None-Match`, so a re-run of an unchanged file costs zero
                 -- bytes. NULL when the response carried none.
                 etag        TEXT,
                 -- The file's own `timestamp`, verbatim. The second half of the short-circuit:
                 -- a 200 with no ETag still names the file it is offering.
                 stamp       TEXT,
                 -- Unix seconds: when rows last **changed**. NULL means never ingested, which
                 -- is a supported state the panel and the estimator both have to be able to
                 -- read — it is why this one is nullable where `checked_at` is not.
                 fetched_at  INTEGER,
                 -- Unix seconds: when we last **asked**. A 304 moves this and leaves
                 -- `fetched_at` alone, `sync_meta.last_check_at`'s reason — without the split a
                 -- feed that is simply up to date reads as due on every launch.
                 checked_at  INTEGER NOT NULL,
                 combo_count INTEGER NOT NULL DEFAULT 0,
                 -- Variants dropped on the way in: not `OK`, or not Commander-legal. Counted
                 -- rather than discarded silently, because `1 of 40 000 kept` and
                 -- `39 999 of 40 000 kept` are the same empty-looking result otherwise.
                 skipped     INTEGER NOT NULL DEFAULT 0
             );",
        )?;
        // **The two indexes the match query turns on**, replayed here from the same constant
        // [`swap_combo_staging`] replays — one copy, so an ingest cannot leave the live tables
        // indexed differently from the way this rung built them. `oracle_id` is the one that
        // matters: the query starts from the deck's oracle ids and joins *into* `combo_cards`,
        // so without it every deck check is a full scan of the whole combo card list.
        tx.execute_batch(&on_schema("main", COMBO_INDEXES_SQL))?;
        // Nothing here is FTS-indexed and no `cards` rowid moves, so no rebuild is owed — the
        // reasoning `the_v2_backfill_leaves_the_search_index_answering` pins.
        //
        // Literal `26`, for the reason every step before it writes its own: this step is what
        // *makes* a database version 26.
        tx.execute_batch("PRAGMA user_version = 26;")?;
        tx.commit()?;
    }

    // **Outside the ladder, on purpose: the tag indexes are replayed on every launch, from
    // every version.** Not belt and braces — the thing this prevents is a hung window, and the
    // number was measured rather than guessed.
    //
    // [`crate::tags::query`] counts a tag's reach with a correlated `count(*)` over the
    // closure, which is 49 ms with `idx_art_tag_illustrations_slug` and **531 seconds**
    // without it: 11 531 candidate tags x a 951 499-row scan each, measured 2026-08-20 on a
    // release build at that day's file size. So a database missing these indexes does not get
    // a slow Tags page, it gets an app that stops responding when the reader types in the
    // search box — and nothing about that symptom points here.
    //
    // **Self-healing, where a rung is one-shot — and the coupling above is what makes the
    // difference matter.** A v21 rung would in fact reach every database in the state this was
    // written for: the v20 step ran on real databases *before* the two closure indexes joined
    // [`TAG_INDEXES_SQL`], so those have `20` recorded and `v < 20` is false for them forever.
    // The argument for a replay is not that a rung cannot reach them. It is that a rung fires
    // once, in one direction, and this index set has to be right on *every* launch: an
    // interrupted swap, a restore of an older data folder, a hand-edited database, a future
    // rung that renames a table. Any of those loses an index a rung already spent, and the
    // failure is nine minutes of frozen window rather than a slower page. Every statement is
    // `CREATE INDEX IF NOT EXISTS`, so on the overwhelming majority of launches this is four
    // catalog lookups and a few microseconds.
    //
    // The copy inside the v20 rung is **not** a duplicate to delete: that one belongs to the
    // step's transaction, where it lands with the tables it indexes. This one is the only
    // thing that reaches a database the ladder is already done with.
    //
    // **Fatal, where [`prepare_database`] deliberately degrades**, and the coupling is what
    // inverts the usual argument. Its two post-ladder repair steps `eprintln!` and carry on,
    // because a stale FTS index costs accuracy and a leftover `cards_staging` costs disk — the
    // app is still an app. Continuing here would instead hand the reader a launched window that
    // locks up for nine minutes on the first keystroke in the tag box, which is strictly worse
    // than a launch that says what is wrong. And a `CREATE INDEX IF NOT EXISTS` that fails at
    // all means the database is not accepting DDL, so nothing after this point would have
    // worked either.
    conn.execute_batch(&on_schema("main", TAG_INDEXES_SQL))?;
    Ok(())
}

/// The four oracle-tag tables and their watermark, as the v14 step creates them.
///
/// **A literal, and history from the day it shipped** — [`CARDS_COLUMNS`]'s rule. The
/// staging copies in [`ORACLE_TAG_STAGING_SQL`] are a *second* literal rather than this one
/// with the names rewritten, because a `_staging` table is renamed over the live one and the
/// two must agree exactly; `the_oracle_tag_staging_tables_match_the_live_ones` is the fence
/// that keeps them from drifting, and it compares columns, types, nullability and primary
/// keys rather than trusting a string substitution.
const ORACLE_TAG_TABLES_SQL: &str = "
    CREATE TABLE IF NOT EXISTS oracle_tags (
        -- Scryfall's `slug`. Stable, readable, and what TypeScript matches on.
        slug TEXT PRIMARY KEY,
        -- The file's `label`. Falls back to the slug when a line carries none, so this is
        -- always something a person can be shown.
        label TEXT NOT NULL,
        description TEXT
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS oracle_tag_parents (
        -- Child first: every read of this table asks 'what is above this tag'.
        child_slug TEXT NOT NULL,
        parent_slug TEXT NOT NULL,
        PRIMARY KEY (child_slug, parent_slug)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS oracle_taggings (
        -- A Scryfall oracle id. Soft: no FK, for the reason above.
        oracle_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        -- The file's own word about the tagging (`median` on 99.74 % of them). Stored
        -- because it is data we were given; read by nothing, and nothing may branch on it.
        weight TEXT,
        annotation TEXT,
        PRIMARY KEY (oracle_id, slug)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS oracle_tag_cards (
        oracle_id TEXT NOT NULL,
        -- Every tag the card holds *and* every ancestor of those tags.
        slug TEXT NOT NULL,
        PRIMARY KEY (oracle_id, slug)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS oracle_tag_meta (
        -- One row, ever. A key/value pair would have been `sync_meta`, and this is
        -- deliberately not that: the card sync's watermark and this one describe different
        -- files on different schedules, and a failed tag refresh must not read as a failed
        -- card sync.
        id INTEGER PRIMARY KEY CHECK (id = 1),
        -- Replayed as `If-None-Match`, so a re-run costs zero bytes. NULL when the response
        -- carried none.
        etag TEXT,
        -- Scryfall's `updated_at` for the file these rows came from, verbatim. The second
        -- half of the short-circuit: a 200 with no ETag still names the file it is offering.
        updated_at TEXT,
        -- Unix seconds: when *we* built these rows.
        ingested_at INTEGER NOT NULL,
        -- Unix seconds: when we last **asked** whether the file had changed, which a 304
        -- moves and an ingest does not. Separate from `ingested_at` for `sync_meta`'s
        -- `last_check_at` reason — without it a taxonomy that is simply up to date reads as
        -- due on every launch, and the throttle buys nothing but one API call per start.
        checked_at INTEGER NOT NULL,
        tag_count INTEGER NOT NULL,
        tagging_count INTEGER NOT NULL
    );";

/// The four art-tag tables and their watermark, as the v20 step creates them.
///
/// **A parallel set rather than a `kind` column on the oracle tables, because the join column
/// differs**: an art tag is a fact about an *illustration*, so it belongs to the printings
/// carrying that art and to no others. A card with five arts has five illustrations and the
/// dog is in one of them.
///
/// A literal and history from the day it shipped, [`CARDS_COLUMNS`]' rule, with
/// [`ART_TAG_STAGING_SQL`] as a *second* literal for [`ORACLE_TAG_TABLES_SQL`]'s reason.
const ART_TAG_TABLES_SQL: &str = "
    CREATE TABLE IF NOT EXISTS art_tags (
        slug TEXT PRIMARY KEY,
        -- Scryfall's stable uuid. `slug` stays the key — storage is rebuilt wholesale on every
        -- ingest, so a rename is harmless there — but anything that *persists* a tag across
        -- ingests has to be able to notice one, and `muted_tags` is exactly that. Their docs:
        -- 'Do not treat tag slugs or labels as permanent identifiers […] Use the id field.'
        id TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        -- The slug reduced to `[a-z0-9]`, computed at ingest. SQLite has no `regexp_replace`,
        -- so the alternative is normalising every row on every keystroke of the tag search.
        slug_norm TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS art_tag_parents (
        -- Child first: every read of this table asks 'what is above this tag'.
        child_slug TEXT NOT NULL,
        parent_slug TEXT NOT NULL,
        PRIMARY KEY (child_slug, parent_slug)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS art_taggings (
        illustration_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        -- Stored because it is data we were given. **Unlike the oracle side this one is
        -- read**: art tags use the full scale (median 462 008, strong 5 980, weak 4 495,
        -- very_strong 2 680, measured 2026-08-20), where oracle taggings are 99.7 % median
        -- and `strong` occurs exactly once in the whole file.
        weight TEXT,
        -- OMITTED rather than null on ~99 % of taggings, which is a different absence from
        -- `description`'s null and needs a different parse.
        annotation TEXT,
        PRIMARY KEY (illustration_id, slug)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS art_tag_illustrations (
        illustration_id TEXT NOT NULL,
        -- Every tag the illustration holds *and* every ancestor of those tags.
        slug TEXT NOT NULL,
        -- The STRONGEST weight among the direct taggings this row descends from
        -- ('very_strong' > 'strong' > 'median' > 'weak'). Resolved once here because a closure
        -- row can be reached from several taggings that disagree: a printing whose `dog`
        -- tagging is weak but whose `hound` tagging is strong is not a weak match, and
        -- deciding that per row at read time would be work on every keystroke.
        weight TEXT NOT NULL,
        PRIMARY KEY (illustration_id, slug)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS art_tag_meta (
        -- One row, ever — `oracle_tag_meta`'s shape and its reasons, for a second file on a
        -- schedule of its own. A failed art refresh must not read as a failed oracle one.
        id INTEGER PRIMARY KEY CHECK (id = 1),
        etag TEXT,
        updated_at TEXT,
        ingested_at INTEGER NOT NULL,
        checked_at INTEGER NOT NULL,
        tag_count INTEGER NOT NULL,
        tagging_count INTEGER NOT NULL
    );";

/// The tags a reader never wants offered, as the v20 step creates it.
///
/// **A user table.** Everything around it is rebuilt on a schedule — the card corpus daily,
/// both taxonomies weekly — and this is the one row in the neighbourhood that is the reader's
/// answer rather than Scryfall's. It is therefore deliberately absent from [`ART_TAG_TABLES`]
/// and [`ORACLE_TAG_TABLES`], the two lists a refresh drops and rebuilds wholesale, and it has
/// no staging twin: a `muted_tags_staging` would be a table the next swap emptied.
///
/// One table with a namespace column rather than two tables, because the two taxonomies have
/// separate id spaces and every reader of this list wants both at once.
const MUTED_TAGS_SQL: &str = "
    CREATE TABLE IF NOT EXISTS muted_tags (
        -- 'art' | 'oracle'
        namespace TEXT NOT NULL,
        -- Scryfall's STABLE uuid, not the slug. Their docs: 'Do not treat tag slugs or
        -- labels as permanent identifiers.' A mute keyed on a slug silently un-mutes
        -- itself the week Tagger renames the tag -- which is exactly the week it mattered.
        tag_id TEXT NOT NULL,
        -- The slug as it read when muted, so Settings can name the tag without a join
        -- against a taxonomy that may have been rebuilt since.
        slug TEXT NOT NULL,
        muted_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, tag_id)
    ) WITHOUT ROWID;";

/// The indexes over the two live tag taxonomies.
///
/// **Here rather than in the `CREATE TABLE`s, for [`CARDS_INDEXES`]' reason one family over.**
/// A tag refresh renames a staging table *over* the live one, and a rename carries the staging
/// table's indexes rather than the live table's — so an index declared once at migration time
/// is an index that vanishes at the first weekly refresh, with the app staying correct and
/// merely becoming slow. **Every table indexed here is renamed over by a swap** — the
/// taxonomies and both closures are all on [`ART_TAG_TABLES`] / [`ORACLE_TAG_TABLES`], and the
/// staging twins carry no indexes at all — so [`swap_tag_staging`] replays this after its
/// renames, and `IF NOT EXISTS` is what makes that a no-op the rest of the time.
///
/// Four indexes: each family has one on its taxonomy and one on its closure. The taggings
/// tables need none — nothing reads them but the ingest that wrote them, and their primary
/// key is the only order anyone asks for. Both
/// families are in one constant and every swap replays all of it — the statements for the
/// family that was not swapped are `IF NOT EXISTS` no-ops, and one list is one place to look.
///
/// `slug_norm` is what the tag search matches a normalised needle against.
///
/// **The closure indexes are what make the tag search's card counts affordable**, and the
/// numbers are worth writing down because the shape looks harmless without them. A closure is
/// `WITHOUT ROWID` on `(subject_id, slug)`, so counting *by slug* — which is the only count the
/// Tags page wants, since a tag's reach is the whole point of showing it — has no path but a
/// full scan of 951 499 rows.
///
/// Measured 2026-08-20 at that day's file size, release build, in memory: the grouped count
/// these replace was **271 ms per `tag_search` call and flat** (a needle answering 11 tags cost
/// the same as one answering 11 531, because SQLite materialises the subquery before the
/// `WHERE` narrows anything), and `tag_children` over the 3 219 roots was **281 ms**. With
/// these indexes and the correlated count they permit, the same two are **49 ms** and
/// **26 ms**, and a narrow needle is **7.7 ms**. That is a type-ahead firing on every
/// keystroke, so the difference is the feature working or not.
///
/// **Deleting one of these is not a slowdown, it is a hang.** `tags::query` counts
/// per row now, so without the index a wide needle is 11 531 candidates x a 951 499-row scan
/// each: **531 seconds**, measured. The two `the_tag_indexes_survive_a_*_tag_swap` tests are
/// what stand between that and a weekly refresh.
///
/// The cost is one slug-ordered copy of each closure — ~380 ms to build at swap time, on a
/// weekly background refresh.
const TAG_INDEXES_SQL: &str = "
    CREATE INDEX IF NOT EXISTS {schema}.idx_art_tags_norm ON art_tags(slug_norm);
    CREATE INDEX IF NOT EXISTS {schema}.idx_oracle_tags_norm ON oracle_tags(slug_norm);
    CREATE INDEX IF NOT EXISTS {schema}.idx_art_tag_illustrations_slug
        ON art_tag_illustrations(slug);
    CREATE INDEX IF NOT EXISTS {schema}.idx_oracle_tag_cards_slug ON oracle_tag_cards(slug);";

/// The two indexes on `combo_cards`, written once because they are created twice: by the v26
/// rung that makes the table, and by [`swap_combo_staging`] after every ingest.
///
/// **The replay is not optional and [`swap_combo_staging`] says why**: a rename carries the
/// *staging* table's indexes rather than the live table's, and no staging DDL creates one. One
/// constant, so the two sites cannot come to disagree about what `combo_cards` is indexed by.
///
/// `idx_combo_cards_oracle` is the one the feature turns on. The match query starts from the
/// deck — a hundred distinct oracle ids — and joins *into* `combo_cards`, so without it every
/// bracket check is a full scan of a table with one row per card per combo. `..._combo` serves
/// the `GROUP BY cc.combo_id` on the other side of the same statement and the cascade behind
/// `combo_cards.combo_id`.
///
/// **Deliberately not replayed outside the ladder the way [`TAG_INDEXES_SQL`] is.** That one
/// earns its per-launch replay with a measured number — 49 ms against 531 seconds, a window
/// that stops responding rather than a slow page. Nothing here has been measured, the combos
/// query is a press rather than a keystroke, and a replay nobody can justify is a line the next
/// reader has to guess the reason for. If a missing index here is ever found to cost more than
/// a slow panel, this constant is already in the right shape to be added to that replay.
const COMBO_INDEXES_SQL: &str = "
    CREATE INDEX IF NOT EXISTS {schema}.idx_combo_cards_combo  ON combo_cards(combo_id);
    CREATE INDEX IF NOT EXISTS {schema}.idx_combo_cards_oracle ON combo_cards(oracle_id);";

/// (Re)create the external-content FTS5 index over `cards` and populate it.
///
/// `search_text` is the haystack column: ingest concatenates oracle text plus every
/// face's name and text into it.
///
/// Public because `VACUUM` needs it. Anything that renumbers `cards`' rowids leaves this
/// index pointing at the wrong rows, and the failure is silent — see
/// [`crate::maintenance::convert_to_incremental`], which calls this unconditionally.
/// The fifteen user tables and their twenty-three indexes, at [`USER_SCHEMA_VERSION`]'s
/// shape, with `{schema}` where the file goes.
///
/// **Copied verbatim out of a migrated database's own `sqlite_master`, not retyped from the
/// rungs**, which is why it reads oddly in places: `decks` carries its later columns as one
/// long `ALTER TABLE` tail, and `deck_cards` and `deck_tags` wear the quotes a
/// `RENAME TO` left on their names. Every one of those artefacts is load-bearing here —
/// `the_user_schema_is_byte_identical_to_what_the_ladder_builds` compares this against the
/// ladder's answer string for string, and a tidied-up transcription would be a shape that
/// merely looks the same.
///
/// **A `{schema}.` prefix does not survive into `sqlite_master`** — measured: SQLite
/// re-renders the name token and stores the rest of the statement verbatim, so
/// `CREATE TABLE part.decks (…)` is stored as `CREATE TABLE decks (…)`. That is what
/// makes the comparison possible at all.
///
/// Substituted rather than `format!`ed, and that is not a style choice: the DDL carries a
/// `DEFAULT` of an empty JSON object and a JSON shape inside a comment, and `format!` would
/// need every brace in both of them doubled — a hand transcription over a literal whose
/// whole point is that nobody transcribed it.
const USER_SCHEMA_SQL: &str = r#"
CREATE TABLE {schema}.collection_entries (
                id INTEGER PRIMARY KEY,
                -- Soft reference. No REFERENCES clause, deliberately and permanently.
                card_id TEXT NOT NULL,
                -- Migration insurance: what the user actually owns, in the terms printed
                -- on the card, still readable when the id stops resolving.
                set_code TEXT NOT NULL,
                collector_number TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'en',
                -- Enum, never a boolean: `etched` is a third thing, and collapsing it is
                -- the most common importer data-loss bug there is.
                finish TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')),
                condition TEXT NOT NULL DEFAULT 'NM'
                    CHECK (condition IN ('NM','LP','MP','HP','DMG')),
                -- What the import said before it was normalised. Kept because the
                -- normalisation is lossy (EU 'GD' and NA 'MP' arrive as one grade) and the
                -- user's own file is the only place the difference still exists.
                condition_original TEXT,
                -- `>= 0`, not `> 0`, and the wishlist's `> 0` differs on purpose. A
                -- stepper taken down to zero is a real state here: the row keeps its
                -- condition, its price, its tags and its acquisition story while the user
                -- owns none of that printing today. So every aggregate that reads this has
                -- to decide *deliberately* whether a zero row counts as owned — and a
                -- 'cards owned' figure that counts rows rather than quantity will be
                -- wrong the first time somebody trades a playset away.
                quantity INTEGER NOT NULL CHECK (quantity >= 0),
                tradelist_quantity INTEGER NOT NULL DEFAULT 0
                    CHECK (tradelist_quantity >= 0),
                purchase_price REAL,
                purchase_currency TEXT,
                acquired_at TEXT,
                -- No competitor stores this. It is one TEXT column and it is the answer to
                -- 'where did I get this?', which is the question a collection is actually
                -- asked years later.
                acquisition_source TEXT,
                -- 042/500. Not in Scryfall's data at all — user-supplied, and part of the
                -- grain, because two serialized copies are two different objects.
                serial_number TEXT,
                altered INTEGER NOT NULL DEFAULT 0,
                signed INTEGER NOT NULL DEFAULT 0,
                proxy INTEGER NOT NULL DEFAULT 0,
                misprint INTEGER NOT NULL DEFAULT 0,
                -- {company, grade, cert}. JSON because the shape differs per grader
                -- (CGC has two grades numbered 10; PSA has no 9.5) and a column per
                -- grader is a migration per grader.
                grading TEXT CHECK (grading IS NULL OR json_valid(grading)),
                tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
                notes TEXT,
                -- NULL is the normal state. A sentence here means the row needs the user's
                -- attention — the printing vanished from Scryfall, or a merge landed it
                -- somewhere this database cannot see. Never a reason to delete the row.
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             , folder_id INTEGER
                     REFERENCES collection_folders(id) ON DELETE SET NULL);

CREATE TABLE {schema}.wishlist_entries (
                id INTEGER PRIMARY KEY,
                -- The oracle card. NULLABLE because `cards.oracle_id` is: a wish for a
                -- printing whose oracle card is unknown can only be a wish for that
                -- printing. (No live row is null — the reversible-card story that used to
                -- be told here is wrong, see `card_row` — so this is a fence, not a case.)
                oracle_id TEXT,
                -- NULL = any printing (spec §6). Set = that printing and no other.
                card_id TEXT,
                set_code TEXT,
                collector_number TEXT,
                lang TEXT,
                -- Denormalised here but not in the collection, on purpose: an any-printing
                -- wish has no card row to join for a name, and a shopping list that cannot
                -- say what it is shopping for is not a list.
                name TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
                preferred_finish TEXT
                    CHECK (preferred_finish IS NULL
                           OR preferred_finish IN ('nonfoil','foil','etched')),
                notes TEXT,
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, folder_id INTEGER
                    REFERENCES wishlist_folders(id) ON DELETE SET NULL,
                -- A wish that names neither an oracle card nor a printing is a wish for
                -- nothing, and would collide with every other such row on the grain.
                CHECK (oracle_id IS NOT NULL OR card_id IS NOT NULL)
             );

CREATE TABLE {schema}.card_migrations (
                id TEXT PRIMARY KEY,
                performed_at TEXT,
                strategy TEXT NOT NULL CHECK (strategy IN ('merge','delete')),
                old_card_id TEXT NOT NULL,
                new_card_id TEXT,
                note TEXT,
                applied_at INTEGER NOT NULL
             );

CREATE TABLE {schema}.decks (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                format_key TEXT NOT NULL DEFAULT 'casual',
                description TEXT,
                -- Spec §6: card_art today; 'custom' + cover_image_path are Plan 6's
                -- (a user file copied into data/covers/), reserved here so the column
                -- story is stable.
                cover_kind TEXT NOT NULL DEFAULT 'card_art'
                    CHECK (cover_kind IN ('card_art','custom')),
                -- Soft reference, like every other card id in a user table.
                cover_card_id TEXT,
                cover_image_path TEXT,
                -- Reserves availability, never decrements the collection (spec §6).
                archived INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             , folder_id INTEGER
                REFERENCES deck_folders(id) ON DELETE SET NULL, notes TEXT, theory_enabled INTEGER NOT NULL DEFAULT 0, last_variant TEXT NOT NULL DEFAULT 'live', last_group_by TEXT NOT NULL DEFAULT 'category', last_sort_by TEXT NOT NULL DEFAULT 'alphabetical', separate_x_group INTEGER NOT NULL DEFAULT 0, default_category_id INTEGER NOT NULL DEFAULT 0, game_key TEXT NOT NULL DEFAULT 'any', bracket INTEGER NOT NULL DEFAULT 0);

CREATE TABLE {schema}.app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE {schema}.deck_folders (
                id INTEGER PRIMARY KEY,
                -- User↔user, CASCADE: deleting a folder deletes the folders inside it. The
                -- DECKS inside it are NOT deleted — see `decks.folder_id` below, which is
                -- SET NULL. A folder is a filing decision; a deck is the user's work.
                parent_id INTEGER REFERENCES deck_folders(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );

CREATE TABLE {schema}.deck_categories (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                -- The rules role, and the same five words `deck_cards.zone` held. A category
                -- the user makes is always 'main'; the other four are predefined, one per deck.
                kind TEXT NOT NULL
                    CHECK (kind IN ('main','side','commander','companion','maybe')),
                -- 'Only active groups are treated as being included in the deck.' Seeded 0 for
                -- the Maybeboard and 1 for everything else.
                is_active INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             , origin TEXT NOT NULL DEFAULT 'user');

CREATE TABLE {schema}.deck_audit (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                at INTEGER NOT NULL,
                variant TEXT NOT NULL DEFAULT 'live'
                    CHECK (variant IN ('live','theory')),
                kind TEXT NOT NULL CHECK (kind IN
                    ('add','remove','quantity','move','swap','tag','category','folder','deck')),
                -- Soft, like every card id in a user table, and nullable: a category rename
                -- is about no card at all.
                card_id TEXT,
                card_name TEXT,
                -- The facts the sentence is built from. Rust records WHAT happened; the
                -- webview writes the sentence, because a sentence is domain logic and this
                -- table has to survive the day the wording changes.
                payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
                -- Signed copies, for the day header's '+7 / -6' roll-up.
                delta INTEGER NOT NULL DEFAULT 0
             );

CREATE TABLE {schema}."deck_cards" (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                -- CASCADE: deleting a category deletes the cards filed under it, which is
                -- what the confirm dialog says it will do. Moving them out first is the
                -- caller's job and `deck_category_delete` does exactly that when asked.
                category_id INTEGER NOT NULL
                    REFERENCES deck_categories(id) ON DELETE CASCADE,
                variant TEXT NOT NULL DEFAULT 'live'
                    CHECK (variant IN ('live','theory')),
                card_id TEXT NOT NULL,
                set_code TEXT NOT NULL,
                collector_number TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'en',
                name TEXT NOT NULL,
                -- SET NULL, not CASCADE: deleting a tag must never delete a card.
                tag_id INTEGER REFERENCES deck_tags(id) ON DELETE SET NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             , finish TEXT
                CHECK (finish IS NULL OR finish IN ('foil','etched')));

CREATE TABLE {schema}.error_log (
                id INTEGER PRIMARY KEY,
                -- Unix seconds, like every stamp in this schema.
                first_at INTEGER NOT NULL,
                last_at INTEGER NOT NULL,
                -- Which of the app's dealings with the outside world this was.
                source TEXT NOT NULL CHECK (source IN
                    ('scryfall_api','scryfall_image','github_update','database','image_store')),
                -- The specific call: 'bulk_check', 'sets', 'migrations', 'image_fetch', …
                -- Free text rather than a CHECK: a new call site must not need a migration
                -- before it is allowed to report that it failed.
                operation TEXT NOT NULL,
                -- The shape of the failure, which is what a reader filters on.
                kind TEXT NOT NULL CHECK (kind IN
                    ('rate_limited','timeout','http','io','parse','other')),
                message TEXT NOT NULL,
                -- The URL, card id or path. Nullable, outside the grain, most recent wins.
                detail TEXT,
                count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0)
             );

CREATE TABLE {schema}.deck_undo (
                audit_id INTEGER PRIMARY KEY
                    REFERENCES deck_audit(id) ON DELETE CASCADE,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                -- The reversal, both ways: {"undo":[Op,…],"redo":[Op,…]}. JSON for
                -- `deck_audit.payload`'s reason one table over: the shapes are Rust's, they
                -- grow with the write sites, and a step written by a newer build must not
                -- fail an older build's read of the rows beside it.
                step TEXT NOT NULL CHECK (json_valid(step)),
                -- NULL while the change is still applied. Stamped by an undo, cleared by a
                -- redo; the cursor is the newest row of this deck that is still NULL.
                undone_at INTEGER
             );

CREATE TABLE {schema}.muted_tags (
        -- 'art' | 'oracle'
        namespace TEXT NOT NULL,
        -- Scryfall's STABLE uuid, not the slug. Their docs: 'Do not treat tag slugs or
        -- labels as permanent identifiers.' A mute keyed on a slug silently un-mutes
        -- itself the week Tagger renames the tag -- which is exactly the week it mattered.
        tag_id TEXT NOT NULL,
        -- The slug as it read when muted, so Settings can name the tag without a join
        -- against a taxonomy that may have been rebuilt since.
        slug TEXT NOT NULL,
        muted_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, tag_id)
    ) WITHOUT ROWID;

CREATE TABLE {schema}.wishlist_folders (
                id INTEGER PRIMARY KEY,
                -- User↔user, CASCADE: deleting a folder deletes the folders inside it. The
                -- WISHES inside it are NOT deleted — see `wishlist_entries.folder_id` below,
                -- which is SET NULL. A folder is a filing decision; a wish is the reader's
                -- shopping list.
                parent_id INTEGER REFERENCES wishlist_folders(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );

CREATE TABLE {schema}."deck_tags" (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            -- The uniqueness grain, and never shown to anyone: see `tag_name_key`.
            name_key TEXT NOT NULL,
            color TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );

CREATE TABLE {schema}.collection_folders (
                 id INTEGER PRIMARY KEY,
                 parent_id INTEGER REFERENCES collection_folders(id) ON DELETE CASCADE,
                 name TEXT NOT NULL,
                 kind TEXT NOT NULL DEFAULT 'user'
                     CHECK (kind IN ('user','deck','removed')),
                 deck_id INTEGER REFERENCES decks(id) ON DELETE CASCADE,
                 sort_order INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 CHECK ((kind = 'deck') = (deck_id IS NOT NULL))
             );

CREATE UNIQUE INDEX {schema}.idx_collection_grain ON collection_entries (
                 card_id, finish, condition, lang, altered, signed, proxy, misprint,
                 coalesce(serial_number, ''), coalesce(grading, ''), coalesce(folder_id, 0)
             );

CREATE INDEX {schema}.idx_collection_card
                ON collection_entries (card_id);

CREATE INDEX {schema}.idx_collection_review
                ON collection_entries (needs_review) WHERE needs_review IS NOT NULL;

CREATE UNIQUE INDEX {schema}.idx_wishlist_grain
                ON wishlist_entries (coalesce(oracle_id, ''), coalesce(card_id, ''),
                                     coalesce(preferred_finish, ''), coalesce(folder_id, 0));

CREATE INDEX {schema}.idx_wishlist_card ON wishlist_entries (card_id);

CREATE INDEX {schema}.idx_wishlist_oracle ON wishlist_entries (oracle_id);

CREATE INDEX {schema}.idx_card_migrations_old
                ON card_migrations (old_card_id);

CREATE UNIQUE INDEX {schema}.idx_deck_cards_grain
                ON deck_cards (deck_id, variant, category_id, card_id, coalesce(finish, ''));

CREATE INDEX {schema}.idx_deck_cards_card ON deck_cards (card_id);

CREATE INDEX {schema}.idx_deck_cards_category ON deck_cards (category_id);

CREATE INDEX {schema}.idx_deck_folders_parent ON deck_folders (parent_id);

CREATE UNIQUE INDEX {schema}.idx_deck_categories_grain
                ON deck_categories (deck_id, name);

CREATE UNIQUE INDEX {schema}.idx_deck_categories_kind
                ON deck_categories (deck_id, kind) WHERE kind <> 'main';

CREATE UNIQUE INDEX {schema}.idx_deck_tags_grain ON deck_tags (name_key);

CREATE INDEX {schema}.idx_wishlist_folder ON wishlist_entries (folder_id);

CREATE INDEX {schema}.idx_deck_audit_deck ON deck_audit (deck_id, at DESC);

CREATE UNIQUE INDEX {schema}.idx_error_log_grain
                ON error_log (source, operation, kind, message);

CREATE INDEX {schema}.idx_error_log_recent ON error_log (last_at DESC);

CREATE INDEX {schema}.idx_deck_undo_deck
                ON deck_undo (deck_id, audit_id DESC);

CREATE INDEX {schema}.idx_wishlist_folders_parent
                ON wishlist_folders (parent_id);

CREATE UNIQUE INDEX {schema}.idx_collection_folder_removed
                 ON collection_folders(kind) WHERE kind = 'removed';

CREATE UNIQUE INDEX {schema}.idx_collection_folder_deck
                 ON collection_folders(deck_id) WHERE deck_id IS NOT NULL;

CREATE INDEX {schema}.idx_collection_folder
                 ON collection_entries (folder_id);
"#;

/// Create the fifteen user tables and their indexes in `schema`, at
/// [`USER_SCHEMA_VERSION`]'s shape.
///
/// **One function, two callers, and that is deliberate**: [`crate::split::extract_user_file`]
/// builds them in an attached scratch file, and `memory_pair` builds them for a test — a
/// fresh install goes through the same conversion as an upgrade, so nothing else ever builds
/// them at all. A second literal here would be two shapes that must agree, which is the
/// failure [`ORACLE_TAG_STAGING_SQL`] describes from the other side.
///
/// `schema` is interpolated rather than bound: SQLite has no parameter for a schema name. It
/// is only ever `"main"`, [`crate::db::CORPUS`] or `split`'s own scratch name, none of which
/// comes from anywhere near a reader.
pub fn create_user_schema(conn: &Connection, schema: &str) -> rusqlite::Result<()> {
    conn.execute_batch(&USER_SCHEMA_SQL.replace("{schema}", schema))
}

/// The twenty corpus tables the DDL builds and their eleven indexes, at
/// [`CORPUS_SCHEMA_VERSION`]'s shape, with `{schema}` where the file goes.
///
/// [`USER_SCHEMA_SQL`]'s twin and every one of its rules: copied out of a migrated
/// database's own `sqlite_master` rather than retyped, `ALTER TABLE` tails and all, and held
/// to that by `the_corpus_schema_is_byte_identical_to_what_the_ladder_builds`.
///
/// `cards_fts` is not here and the four `cards_fts_*` shadow tables cannot be: the virtual
/// table is created by [`create_fts_in`] once `cards` exists, and FTS5 makes its own shadows.
const CORPUS_SCHEMA_SQL: &str = r#"
CREATE TABLE {schema}.cards (
    id TEXT PRIMARY KEY,
    oracle_id TEXT,
    name TEXT NOT NULL,
    lang TEXT NOT NULL,
    released_at TEXT,
    set_code TEXT NOT NULL,
    set_name TEXT,
    collector_number TEXT NOT NULL,
    rarity TEXT,
    layout TEXT NOT NULL,
    mana_cost TEXT,
    cmc REAL,
    type_line TEXT,
    oracle_text TEXT,
    colors TEXT,
    color_identity TEXT,
    legalities TEXT,
    games TEXT,
    finishes TEXT,
    prices TEXT,
    price_usd REAL,
    price_eur REAL,
    faces TEXT,
    illustration_id TEXT,
    frame_effects TEXT,
    border_color TEXT,
    full_art INTEGER NOT NULL DEFAULT 0,
    promo INTEGER NOT NULL DEFAULT 0,
    promo_types TEXT,
    digital INTEGER NOT NULL DEFAULT 0,
    is_paper INTEGER NOT NULL DEFAULT 1,
    edhrec_rank INTEGER,
    game_changer INTEGER,
    image_status TEXT,
    image_updated_at TEXT,
    search_text TEXT,
    raw TEXT NOT NULL, image_uris TEXT, face_image_uris TEXT, artist TEXT, power TEXT, toughness TEXT, legal_mask INTEGER NOT NULL DEFAULT 0);

CREATE TABLE {schema}.sets (
                code TEXT PRIMARY KEY, name TEXT NOT NULL, arena_code TEXT, mtgo_code TEXT,
                set_type TEXT, released_at TEXT, icon_svg_uri TEXT);

CREATE TABLE {schema}.sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE {schema}.image_cache (
                card_id TEXT NOT NULL,
                face INTEGER NOT NULL,
                variant TEXT NOT NULL,
                -- The exact URI the bytes on disk came from, cache-buster and all.
                -- Scryfall's `?<epoch>` equals `image_updated_at`, so a URI that no
                -- longer matches *is* the invalidation signal, with no clock to trust.
                source_uri TEXT NOT NULL,
                bytes INTEGER NOT NULL,
                fetched_at INTEGER NOT NULL,
                PRIMARY KEY (card_id, face, variant)
             ) WITHOUT ROWID;

CREATE TABLE {schema}.combos (
                 -- Commander Spellbook's variant id, e.g. `1957-4050-7918--204`. TEXT because
                 -- it is theirs: nothing here mints one, and a row is only ever replaced
                 -- wholesale by the next ingest.
                 id             TEXT PRIMARY KEY,
                 -- One of R|S|P|O|C|E|B — Ruthless, Spicy, Powerful, Oddball, Core, Exhibition,
                 -- Banned. No CHECK: the vocabulary is the *feed's* and may grow the day they
                 -- add a letter, and a CHECK here would turn that into an ingest that fails
                 -- rather than a letter this app does not raise a floor for.
                 bracket_tag    TEXT NOT NULL,
                 -- DISTINCT oracle ids in `combo_cards` for this combo, stored rather than
                 -- counted: the match query compares it against what a deck holds, and a
                 -- correlated count per candidate combo is the shape that turns a deck check
                 -- into a scan.
                 card_count     INTEGER NOT NULL,
                 -- The feed's `requires[]` — *templates* like `a creature with flying`, which
                 -- resolve to no card id. `> 0` means this app cannot fully check the combo, so
                 -- it is shown as possible and kept out of the arithmetic.
                 template_count INTEGER NOT NULL,
                 -- Colour identity of the combo, the feed's own spelling.
                 identity       TEXT NOT NULL,
                 -- What it does: feature names, newline-joined. One column rather than a fourth
                 -- table because nothing queries it — it is read whole, for one combo, to be
                 -- printed.
                 produces       TEXT NOT NULL,
                 -- How many decks Spellbook has seen it in. NULL where the feed carries none,
                 -- which is not the same as zero and must not be faked into it.
                 popularity     INTEGER
             );

CREATE TABLE {schema}.combo_cards (
                 -- **The one enforced foreign key in this rung**, and the module doc says why
                 -- it is legal where a key on `cards.id` never is. ON DELETE CASCADE so a combo
                 -- cannot leave its own card list behind it.
                 combo_id          TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
                 -- `cards.oracle_id`, **softly** — the corpus is dropped and recreated on every
                 -- sync, so a declared reference here would abort one. A combo naming a card
                 -- this database has never synced is a row that simply never matches.
                 oracle_id         TEXT NOT NULL,
                 -- Denormalised for the same reason every user table denormalises a printing:
                 -- the list has to stay readable when the id stops resolving.
                 name              TEXT NOT NULL,
                 quantity          INTEGER NOT NULL,
                 must_be_commander INTEGER NOT NULL
             );

CREATE TABLE {schema}.format_specs (
                key TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                enabled_in_picker INTEGER NOT NULL DEFAULT 1,
                deck_min INTEGER NOT NULL,
                deck_max INTEGER,             -- NULL = no maximum
                max_copies INTEGER,           -- NULL = unlimited (casual, limited)
                sideboard_max INTEGER,        -- 0 = no sideboard; NULL = uncapped (casual, limited)
                singleton INTEGER NOT NULL DEFAULT 0,
                requires_commander INTEGER NOT NULL DEFAULT 0,
                -- Which eligibility rule the TS engine applies. Data, not code:
                -- NULL | 'edh' | 'brawl' | 'oathbreaker' | 'pdh' | 'duel' | 'tlr'.
                commander_rule TEXT,
                life INTEGER NOT NULL,
                -- TRAP A: what `restricted` MEANS here. Never inferred from the key.
                restricted_semantic TEXT NOT NULL DEFAULT 'max_one'
                    CHECK (restricted_semantic IN ('max_one','banned_as_commander')),
                -- 0 for the two pseudo-formats: casual and limited check no legality
                -- and no pool (spec §6).
                has_legality_data INTEGER NOT NULL DEFAULT 1,
                -- Tiny Leaders: every card AND every face, MV <= this.
                max_mana_value INTEGER,
                -- Gladiator: no sideboard → no companions. EDH has sideboard_max 0 and
                -- DOES allow one ('effectively a 101st card'), so this cannot be derived
                -- from sideboard_max — it is its own fact.
                allows_companion INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL
             , games TEXT NOT NULL DEFAULT 'paper,arena,mtgo');

CREATE TABLE {schema}.marketplace_prices (
                -- One of `crate::marketplace::MARKETPLACE_IDS`, and always a feed-backed one:
                -- TCGplayer and Cardmarket are read out of `cards.prices` and are never here.
                marketplace TEXT NOT NULL,
                -- A Scryfall id. Soft: no FK, for the reason above.
                card_id TEXT NOT NULL,
                finish TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')),
                -- Near Mint, in the marketplace's own currency. One price per finish; a
                -- finish the feed does not quote has no row at all, never a zero — `$0.00`
                -- is a price nobody offered, and the app renders absence as an em dash.
                price REAL NOT NULL,
                PRIMARY KEY (marketplace, card_id, finish)
             ) WITHOUT ROWID;

CREATE TABLE {schema}.marketplace_feed_meta (
                marketplace TEXT PRIMARY KEY,
                -- Unix seconds, like every stamp in this schema: when *we* pulled it.
                fetched_at INTEGER NOT NULL,
                -- The feed's own stamp, verbatim (Card Kingdom's `meta.created_at`). NULL
                -- for a feed that publishes none, which Mana Pool does not — the two answer
                -- different questions and a missing one must not be faked from `fetched_at`.
                feed_built_at TEXT,
                row_count INTEGER NOT NULL
             );

CREATE TABLE {schema}.oracle_tags (
        -- Scryfall's `slug`. Stable, readable, and what TypeScript matches on.
        slug TEXT PRIMARY KEY,
        -- The file's `label`. Falls back to the slug when a line carries none, so this is
        -- always something a person can be shown.
        label TEXT NOT NULL,
        description TEXT
    , id TEXT NOT NULL DEFAULT '', slug_norm TEXT NOT NULL DEFAULT '') WITHOUT ROWID;

CREATE TABLE {schema}.oracle_tag_parents (
        -- Child first: every read of this table asks 'what is above this tag'.
        child_slug TEXT NOT NULL,
        parent_slug TEXT NOT NULL,
        PRIMARY KEY (child_slug, parent_slug)
    ) WITHOUT ROWID;

CREATE TABLE {schema}.oracle_taggings (
        -- A Scryfall oracle id. Soft: no FK, for the reason above.
        oracle_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        -- The file's own word about the tagging (`median` on 99.74 % of them). Stored
        -- because it is data we were given; read by nothing, and nothing may branch on it.
        weight TEXT,
        annotation TEXT,
        PRIMARY KEY (oracle_id, slug)
    ) WITHOUT ROWID;

CREATE TABLE {schema}.oracle_tag_cards (
        oracle_id TEXT NOT NULL,
        -- Every tag the card holds *and* every ancestor of those tags.
        slug TEXT NOT NULL,
        PRIMARY KEY (oracle_id, slug)
    ) WITHOUT ROWID;

CREATE TABLE {schema}.oracle_tag_meta (
        -- One row, ever. A key/value pair would have been `sync_meta`, and this is
        -- deliberately not that: the card sync's watermark and this one describe different
        -- files on different schedules, and a failed tag refresh must not read as a failed
        -- card sync.
        id INTEGER PRIMARY KEY CHECK (id = 1),
        -- Replayed as `If-None-Match`, so a re-run costs zero bytes. NULL when the response
        -- carried none.
        etag TEXT,
        -- Scryfall's `updated_at` for the file these rows came from, verbatim. The second
        -- half of the short-circuit: a 200 with no ETag still names the file it is offering.
        updated_at TEXT,
        -- Unix seconds: when *we* built these rows.
        ingested_at INTEGER NOT NULL,
        -- Unix seconds: when we last **asked** whether the file had changed, which a 304
        -- moves and an ingest does not. Separate from `ingested_at` for `sync_meta`'s
        -- `last_check_at` reason — without it a taxonomy that is simply up to date reads as
        -- due on every launch, and the throttle buys nothing but one API call per start.
        checked_at INTEGER NOT NULL,
        tag_count INTEGER NOT NULL,
        tagging_count INTEGER NOT NULL
    );

CREATE TABLE {schema}.art_tags (
        slug TEXT PRIMARY KEY,
        -- Scryfall's stable uuid. `slug` stays the key — storage is rebuilt wholesale on every
        -- ingest, so a rename is harmless there — but anything that *persists* a tag across
        -- ingests has to be able to notice one, and `muted_tags` is exactly that. Their docs:
        -- 'Do not treat tag slugs or labels as permanent identifiers […] Use the id field.'
        id TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        -- The slug reduced to `[a-z0-9]`, computed at ingest. SQLite has no `regexp_replace`,
        -- so the alternative is normalising every row on every keystroke of the tag search.
        slug_norm TEXT NOT NULL
    ) WITHOUT ROWID;

CREATE TABLE {schema}.art_tag_parents (
        -- Child first: every read of this table asks 'what is above this tag'.
        child_slug TEXT NOT NULL,
        parent_slug TEXT NOT NULL,
        PRIMARY KEY (child_slug, parent_slug)
    ) WITHOUT ROWID;

CREATE TABLE {schema}.art_taggings (
        illustration_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        -- Stored because it is data we were given. **Unlike the oracle side this one is
        -- read**: art tags use the full scale (median 462 008, strong 5 980, weak 4 495,
        -- very_strong 2 680, measured 2026-08-20), where oracle taggings are 99.7 % median
        -- and `strong` occurs exactly once in the whole file.
        weight TEXT,
        -- OMITTED rather than null on ~99 % of taggings, which is a different absence from
        -- `description`'s null and needs a different parse.
        annotation TEXT,
        PRIMARY KEY (illustration_id, slug)
    ) WITHOUT ROWID;

CREATE TABLE {schema}.art_tag_illustrations (
        illustration_id TEXT NOT NULL,
        -- Every tag the illustration holds *and* every ancestor of those tags.
        slug TEXT NOT NULL,
        -- The STRONGEST weight among the direct taggings this row descends from
        -- ('very_strong' > 'strong' > 'median' > 'weak'). Resolved once here because a closure
        -- row can be reached from several taggings that disagree: a printing whose `dog`
        -- tagging is weak but whose `hound` tagging is strong is not a weak match, and
        -- deciding that per row at read time would be work on every keystroke.
        weight TEXT NOT NULL,
        PRIMARY KEY (illustration_id, slug)
    ) WITHOUT ROWID;

CREATE TABLE {schema}.art_tag_meta (
        -- One row, ever — `oracle_tag_meta`'s shape and its reasons, for a second file on a
        -- schedule of its own. A failed art refresh must not read as a failed oracle one.
        id INTEGER PRIMARY KEY CHECK (id = 1),
        etag TEXT,
        updated_at TEXT,
        ingested_at INTEGER NOT NULL,
        checked_at INTEGER NOT NULL,
        tag_count INTEGER NOT NULL,
        tagging_count INTEGER NOT NULL
    );

CREATE TABLE {schema}.combo_meta (
                 -- One row, ever — `oracle_tag_meta`'s shape and its reason: this watermark and
                 -- the card sync's describe different files on different schedules, and a
                 -- failed combo refresh must not read as a failed sync.
                 id          INTEGER PRIMARY KEY CHECK (id = 1),
                 -- Replayed as `If-None-Match`, so a re-run of an unchanged file costs zero
                 -- bytes. NULL when the response carried none.
                 etag        TEXT,
                 -- The file's own `timestamp`, verbatim. The second half of the short-circuit:
                 -- a 200 with no ETag still names the file it is offering.
                 stamp       TEXT,
                 -- Unix seconds: when rows last **changed**. NULL means never ingested, which
                 -- is a supported state the panel and the estimator both have to be able to
                 -- read — it is why this one is nullable where `checked_at` is not.
                 fetched_at  INTEGER,
                 -- Unix seconds: when we last **asked**. A 304 moves this and leaves
                 -- `fetched_at` alone, `sync_meta.last_check_at`'s reason — without the split a
                 -- feed that is simply up to date reads as due on every launch.
                 checked_at  INTEGER NOT NULL,
                 combo_count INTEGER NOT NULL DEFAULT 0,
                 -- Variants dropped on the way in: not `OK`, or not Commander-legal. Counted
                 -- rather than discarded silently, because `1 of 40 000 kept` and
                 -- `39 999 of 40 000 kept` are the same empty-looking result otherwise.
                 skipped     INTEGER NOT NULL DEFAULT 0
             );

CREATE INDEX {schema}.idx_art_tags_norm ON art_tags(slug_norm);

CREATE INDEX {schema}.idx_oracle_tags_norm ON oracle_tags(slug_norm);

CREATE INDEX {schema}.idx_art_tag_illustrations_slug
        ON art_tag_illustrations(slug);

CREATE INDEX {schema}.idx_oracle_tag_cards_slug ON oracle_tag_cards(slug);

CREATE INDEX {schema}.idx_cards_oracle ON cards(oracle_id);

CREATE INDEX {schema}.idx_cards_set_cn ON cards(set_code, collector_number);

CREATE INDEX {schema}.idx_cards_name ON cards(name);

CREATE INDEX {schema}.idx_cards_collapse ON cards(oracle_id, is_paper, released_at, id, name, price_usd, legal_mask, cmc, color_identity);

CREATE INDEX {schema}.idx_cards_illustration ON cards(illustration_id);

CREATE INDEX {schema}.idx_combo_cards_combo  ON combo_cards(combo_id);

CREATE INDEX {schema}.idx_combo_cards_oracle ON combo_cards(oracle_id);
"#;

/// Create the corpus in `schema` — its tables, its indexes, the search index and the format
/// rules the ladder seeds.
///
/// **This is what "a corpus is rebuildable" means in code.** A file that will not open is
/// deleted at startup and this rebuilds its shape; everything in it then comes back from a
/// feed, except `format_specs`, which no feed produces and this seeds directly — which is why
/// that table can afford to be on this side at all.
///
/// Only ever called on an *empty* schema, which is what lets the DDL be byte-identical to the
/// ladder's rather than carrying `IF NOT EXISTS`: [`migrate_corpus`] guards it on the version.
pub fn create_corpus_schema(conn: &Connection, schema: &str) -> rusqlite::Result<()> {
    conn.execute_batch(&on_schema(schema, CORPUS_SCHEMA_SQL))?;
    create_fts_in(conn, schema)?;
    // Unqualified, and correct unqualified: `format_specs` exists in exactly one attached
    // database and DML resolves into it — the same reason no command changed. It is also
    // the literal the v20 rung runs, so a rebuilt corpus and a migrated one seed identically.
    conn.execute_batch(FORMAT_SPECS_SEED)
}

pub fn create_fts(conn: &Connection) -> rusqlite::Result<()> {
    create_fts_in(conn, CORPUS)
}

/// [`create_fts`] over a named schema.
///
/// **An external-content FTS5 index resolves `content='cards'` in its own schema**, measured:
/// a `main.cards_fts` beside a `corpus.cards` creates cleanly and fails on its first rebuild
/// with `no such table: main.cards`. So the index is not free to sit anywhere, and this
/// argument is the reason the five `cards_fts*` rows are on the corpus side of [`TABLES`].
///
/// Two callers, and they mean different files: [`migrate_single_file`]'s v1 rung builds one
/// pre-split file, and everything since schema 27 means [`CORPUS`]. The `INSERT` is left
/// unqualified because DML resolves on its own — see [`on_schema`].
fn create_fts_in(conn: &Connection, schema: &str) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS {schema}.cards_fts;
         CREATE VIRTUAL TABLE {schema}.cards_fts USING fts5(
            name, type_line, search_text,
            content='cards', tokenize='unicode61 remove_diacritics 2');
         INSERT INTO {schema}.cards_fts(cards_fts) VALUES('rebuild');"
    ))
}

/// Everything a freshly opened database needs before the app touches it: the schema is
/// brought to head, a search index an interrupted compaction owes is rebuilt, and any
/// `cards_staging` an interrupted ingest left behind is dropped.
///
/// The rebuild is second because it is the one that cannot wait for a sync. A compaction
/// killed between its `VACUUM` and its `create_fts` leaves a database whose header says it
/// is converted and whose index answers with the wrong cards; nothing else would notice,
/// because the sync that rebuilds the index is the one that ingests and most syncs get a
/// 304. See [`crate::maintenance::K_FTS_REBUILD_PENDING`]. It costs one `sync_meta` lookup
/// on every launch that does not need it.
///
/// **[`migrate_single_file`] is the only step here allowed to stop a launch.** A schema that cannot be
/// brought to head means the database cannot be used at all. The other two mean something is
/// *worse* rather than unusable — a rebuild that fails means search is wrong, a drop that
/// fails means a few hundred megabytes stay parked — and both failures have the same likely
/// cause: a disk that is full, read-only, or held open by something else. Making either
/// fatal would turn that into an app which refuses to start and tells the user to move a
/// perfectly good `mtg.db` aside, which is the one remedy a full disk is deaf to. So both
/// are logged, their debt is left exactly where it was, and the next launch — or the next
/// sync, through `compact_once` and `create_staging` — tries again.
///
/// The drop is not tidiness. The ingest commits its staging load a batch at a time, so a
/// sync that is killed partway — a closed lid, a pulled stick, a crash — leaves a
/// *committed* staging table holding most of a card database: measured against the ~2 GB
/// `mtg.db`, that is several hundred megabytes.
///
/// **What bounds that residue's life is the throttle, not Scryfall's rotation.** The only
/// other `DROP` is inside [`create_staging`], and the metadata that lets a check
/// short-circuit (`bulk_etag`, `bulk_updated_at`) is written *after* a successful ingest —
/// so a killed run stores nothing, and the next run that is actually due sees the same
/// changed bulk file it died downloading and re-enters `create_staging`. The residue
/// therefore survives the rest of the 24 h check window, and survives indefinitely only
/// while the app stays offline or unlaunched. That is still a day of a USB stick carrying
/// hundreds of megabytes of nothing, and a launch is the moment it is free to hand back.
///
/// This returns those pages to SQLite's freelist, so the next ingest reuses them instead of
/// growing the file past them — and on an incremental-auto-vacuum database, which is every
/// database this app creates (see [`crate::db::open`]), the freelist is exactly what
/// [`crate::maintenance::reclaim_freed_pages`] hands back to the filesystem after the next
/// swap. Reuse is the part that matters for a USB stick either way: without it a killed
/// sync's residue and the next sync's staging table both want room at once.
///
/// What startup deliberately does *not* do is `VACUUM`. It rewrites the whole file — minutes
/// on the measured 2.02 GB database, before there is a window to say so in — and it renumbers
/// rowids, which owes the external-content FTS index a full rebuild. The one conversion that
/// does need a `VACUUM` runs after a sync instead, once per database: see
/// [`crate::maintenance::convert_to_incremental`].
pub fn prepare_database(conn: &Connection) -> rusqlite::Result<()> {
    migrate_user(conn)?;
    migrate_corpus(conn)?;
    if let Err(e) = crate::maintenance::rebuild_fts_if_pending(conn) {
        eprintln!(
            "the search index still owes a rebuild from an interrupted compaction, and it \
             could not be done now: {e}\nSearch results may be wrong until the next sync."
        );
    }
    if let Err(e) = conn.execute_batch(&format!("DROP TABLE IF EXISTS {CORPUS}.cards_staging")) {
        eprintln!(
            "an interrupted sync left a `cards_staging` table behind and it could not be \
             dropped now: {e}\nThe data folder is using more space than it needs to until \
             the next sync reuses it."
        );
    }
    Ok(())
}

/// Bring `main` — the reader's own file — to [`USER_SCHEMA_VERSION`].
///
/// **There is nothing to do yet and that is the honest state of it.** Every user file reaches
/// this already at 27, because [`crate::split::convert`] is what makes one and it stamps that
/// version; the first rung above 27 goes here, and it may never restart or give up, because
/// its rows exist nowhere else.
///
/// What it does do is refuse a file from the future. `PRAGMA user_version` unqualified means
/// `main`, which is one of the three smaller reasons the *user* file is the one
/// `Connection::open` names: the version that gates compatibility is the one an unqualified
/// read returns.
fn migrate_user(conn: &Connection) -> rusqlite::Result<()> {
    let v: i64 = conn.query_row("PRAGMA main.user_version", [], |r| r.get(0))?;
    if v > USER_SCHEMA_VERSION {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(format!(
                "this collection is at schema version {v} and this build knows \
                 {USER_SCHEMA_VERSION}. It is from a newer version of MTG Grimoire."
            )),
        ));
    }
    Ok(())
}

/// Bring the attached corpus to [`CORPUS_SCHEMA_VERSION`], **building it from nothing if that
/// is what it takes**.
///
/// This is the half of the split that is allowed to give up and rebuild, and the empty-file
/// case is not an edge: [`prepare_data_dir`] deletes a corpus that will not open, and
/// `ATTACH` then silently creates a new empty one in its place. A version below head here
/// means "this file has no shape yet", which is exactly what an empty database reads as.
///
/// It ends with the tag indexes, unconditionally and fatally, for the reason
/// [`migrate_single_file`] ends with them: without `idx_art_tag_illustrations_slug` the Tags
/// page is 531 seconds rather than 49 ms, which is a window that stops responding rather
/// than a page that is slow. That replay moved here with the tables it indexes — the
/// ladder's copy now only ever reaches a pre-split file.
fn migrate_corpus(conn: &Connection) -> rusqlite::Result<()> {
    let v: i64 = conn.query_row(&format!("PRAGMA {CORPUS}.user_version"), [], |r| r.get(0))?;
    if v < CORPUS_SCHEMA_VERSION {
        create_corpus_schema(conn, CORPUS)?;
        conn.execute_batch(&format!(
            "PRAGMA {CORPUS}.user_version = {CORPUS_SCHEMA_VERSION};"
        ))?;
    }
    conn.execute_batch(&on_schema(CORPUS, TAG_INDEXES_SQL))
}

/// Bring `data_dir` to a state the app can open: convert if a single file is there, and
/// replace a corpus that will not open at all.
///
/// `Ok(true)` means something was rebuilt or converted. **A corpus that fails to open is a
/// file to replace, not a failure to report**: that is what having two files buys, and it is
/// checked here — before any connection the app keeps — because the check is "can this be
/// opened", and the honest way to ask is to try.
///
/// Deleting it is enough. `ATTACH` on a path that does not exist creates the file, and
/// [`migrate_corpus`] finds a version of 0 there and builds the shape back; the rows come
/// from the next sync. Nothing in the collection, the decks or the wishlist is touched,
/// which is the whole point of the split stated as code.
pub fn prepare_data_dir(data_dir: &std::path::Path) -> Result<bool, String> {
    let converted = crate::split::convert(data_dir)?;
    if corpus_is_readable(data_dir) {
        return Ok(converted);
    }
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(data_dir.join(format!("{}{suffix}", crate::db::CORPUS_DB)));
    }
    eprintln!(
        "the card database could not be opened and has been replaced; the next sync \
         will rebuild it. Nothing in your collection, decks or wishlist was touched."
    );
    Ok(true)
}

/// Whether `corpus.db` opens and passes a one-error `quick_check`.
///
/// Asked by opening it rather than by reading its header, because "can this be opened" has
/// no cheaper honest answer — and asked *before* the app's own connections exist, so a
/// corpus that has to be replaced is replaced while nothing is holding it.
fn corpus_is_readable(data_dir: &std::path::Path) -> bool {
    let path = data_dir.join(crate::db::CORPUS_DB);
    if !path.is_file() {
        return false;
    }
    let Ok(conn) = crate::db::open(&path) else {
        return false;
    };
    conn.query_row("PRAGMA quick_check(1)", [], |r| r.get::<_, String>(0))
        .map(|answer| answer == "ok")
        .unwrap_or(false)
}

/// The one row [`migrate_single_file`]'s v25 rung seeds into a *user* table.
///
/// Not part of [`USER_SCHEMA_SQL`], and that is load-bearing: the split copies the reader's
/// rows in, so a seed there would land beside the one already copied and fail
/// `idx_collection_folder_removed`. It is here for `memory_pair`, which builds a pair from
/// the DDL rather than from the ladder and would otherwise hand every test a database with
/// no holding area — a state no converted database is ever in.
#[cfg(test)]
const USER_SEED_SQL: &str = "
    INSERT INTO {schema}.collection_folders
         (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
     VALUES (NULL, 'Recently removed', 'removed', NULL, 0, unixepoch(), unixepoch());";

/// An in-memory pair shaped exactly like the app's: `main` is the user file and a second,
/// private in-memory database is attached as [`CORPUS`].
///
/// Two `ATTACH ':memory:'` calls give two *distinct* databases, measured — so this is one
/// connection over two schemas with no files involved.
///
/// **This is what a test should reach for**, not `Connection::open_in_memory` plus
/// [`migrate_single_file`]: a test on a single file cannot see a statement that landed in the
/// wrong one, which is the whole class of bug the split introduces. The ~100 setups still on
/// the ladder are the exception that proves it — they build *pre-split* databases on
/// purpose, which is what those tests are about.
#[cfg(test)]
pub fn memory_pair() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&format!("ATTACH DATABASE ':memory:' AS {CORPUS}"))
        .unwrap();
    create_user_schema(&conn, "main").unwrap();
    create_corpus_schema(&conn, CORPUS).unwrap();
    conn.execute_batch(&on_schema("main", USER_SEED_SQL))
        .unwrap();
    conn.execute_batch(&format!(
        "PRAGMA main.user_version = {USER_SCHEMA_VERSION};
         PRAGMA {CORPUS}.user_version = {CORPUS_SCHEMA_VERSION};"
    ))
    .unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn
}

/// Create a fresh, empty `cards_staging` table with the exact `cards` layout.
/// A bulk sync fills this, then calls [`swap_staging`], so `cards` is never
/// left half-written if the download fails.
///
/// The layout is read back from the live table with `PRAGMA table_info(cards)` rather
/// than written from a constant. Staging is renamed *over* `cards`, so the two must
/// agree exactly — and a constant shared with the v1 `CREATE` cannot express that once a
/// later migration adds a column: either the constant is edited (breaking fresh installs,
/// see [`CARDS_COLUMNS`]) or staging quietly loses the column and the next sync drops it
/// from the database. Deriving it means staging *cannot* drift, whatever migrations come.
pub fn create_staging(conn: &Connection) -> rusqlite::Result<()> {
    let columns = cards_column_defs(conn)?;
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS {CORPUS}.cards_staging;
         CREATE TABLE {CORPUS}.cards_staging ({columns});",
    ))
}

/// The column definitions of the live `cards` table, rebuilt from `PRAGMA table_info`.
///
/// Reproduces name, declared type, `NOT NULL`, `DEFAULT` and single-column `PRIMARY KEY`
/// — everything `cards` is declared with. A `CREATE TABLE … AS SELECT` clone would be one
/// line instead, and would silently drop all four.
fn cards_column_defs(conn: &Connection) -> rusqlite::Result<String> {
    let mut stmt = conn.prepare(&format!("PRAGMA {CORPUS}.table_info(cards)"))?;
    let defs: Vec<String> = stmt
        .query_map([], |row| {
            let name: String = row.get("name")?;
            let ty: String = row.get("type")?;
            let notnull: i64 = row.get("notnull")?;
            let default: Option<String> = row.get("dflt_value")?;
            let pk: i64 = row.get("pk")?;
            let mut def = format!("\"{name}\" {ty}");
            if pk > 0 {
                def.push_str(" PRIMARY KEY");
            }
            if notnull != 0 {
                def.push_str(" NOT NULL");
            }
            if let Some(d) = default {
                def.push_str(&format!(" DEFAULT {d}"));
            }
            Ok(def)
        })?
        .collect::<rusqlite::Result<_>>()?;

    // `PRAGMA table_info` on a table that does not exist is not an error, it is an empty
    // result — which would go on to create a syntactically invalid `CREATE TABLE ()`.
    if defs.is_empty() {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some("cannot stage a sync: table `cards` does not exist".to_owned()),
        ));
    }
    Ok(defs.join(", "))
}

/// Promote `cards_staging` to `cards`, recreating the indexes and rebuilding the
/// FTS index from scratch.
///
/// # Invariant: `cards` is **dropped and recreated on every sync**
///
/// This function runs `DROP TABLE cards` with `foreign_keys = ON`. Two consequences bind
/// every table added later:
///
/// * **No user table may declare an enforced foreign key to `cards.id`.** A plain
///   `REFERENCES cards(id)` makes the drop an FK violation that aborts every sync; with
///   `ON DELETE CASCADE` the sync succeeds and takes the user's collection with it. User
///   tables reference `cards.id` as a *soft* reference — no `REFERENCES` clause — with
///   `set_code`/`collector_number`/`lang` denormalised alongside as migration insurance
///   (spec §6). The migrations reconciler flags orphans; it never deletes them.
/// * **Every index on `cards` must live in [`CARDS_INDEXES`].** Indexes are dropped with
///   the table, and only that list is replayed here.
///
/// The FTS table is dropped and rebuilt rather than migrated: external-content FTS5
/// tracks rows by rowid, and a swapped-in table has entirely new rowids. A full
/// rebuild is deterministic and cannot leave stale index entries behind.
///
/// The whole swap — index drop, table swap, index rebuild — is one transaction, so it
/// either happens or it doesn't. Anything less can leave the database with no search
/// index, which `migrate_single_file()` will not repair once `user_version` is set. On failure the
/// [`Transaction`] rolls back as it drops, leaving the connection ready for a retry.
///
/// [`Transaction`]: rusqlite::Transaction
pub fn swap_staging(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    // The new name is unqualified on purpose: `RENAME TO corpus.cards` is a syntax error,
    // and a rename cannot move a table between schemas at all.
    tx.execute_batch(&format!(
        "DROP TABLE IF EXISTS {CORPUS}.cards_fts;
         DROP TABLE {CORPUS}.cards;
         ALTER TABLE {CORPUS}.cards_staging RENAME TO cards;
         {indexes}",
        indexes = cards_indexes_sql(CORPUS)
    ))?;
    create_fts(&tx)?;
    // A rebuild an interrupted compaction was still owed has just been paid off, by this.
    // Clearing it inside the same transaction is what keeps the two honest: the debt and
    // the work that discharges it commit together or not at all.
    crate::sync::set_meta_opt(&tx, crate::maintenance::K_FTS_REBUILD_PENDING, None)?;
    tx.commit()
}

/// The four oracle-tag tables again, `_staging` and empty.
///
/// A second literal rather than [`ORACLE_TAG_TABLES_SQL`] with its names rewritten, for
/// [`CARDS_COLUMNS`]'s reason: the live DDL is *history* the day it ships, while this one
/// describes head and moves with it. `the_oracle_tag_staging_tables_match_the_live_ones` is
/// what stops the two coming apart — it compares them column by column through
/// `PRAGMA table_info`, so a type, a `NOT NULL` or a primary key that changes on one side
/// and not the other fails there rather than at the rename.
///
/// No `oracle_tag_meta_staging`: the watermark is one row written *with* the swap, not a
/// table that is rebuilt.
const ORACLE_TAG_STAGING_SQL: &str = "
    DROP TABLE IF EXISTS {schema}.oracle_tags_staging;
    DROP TABLE IF EXISTS {schema}.oracle_tag_parents_staging;
    DROP TABLE IF EXISTS {schema}.oracle_taggings_staging;
    DROP TABLE IF EXISTS {schema}.oracle_tag_cards_staging;
    CREATE TABLE {schema}.oracle_tags_staging (
        slug TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT,
        -- **Last two, and the order is not a preference.** v20 adds both to the live table
        -- with `ALTER TABLE … ADD COLUMN`, which can only append — so a fresh install's
        -- `oracle_tags` reads `slug, label, description, id, slug_norm` and this twin has to
        -- read the same, or the fence test fails at the rename rather than here.
        --
        -- **NOT NULL with no default, which `art_tags_staging` has been from the start.**
        -- Both carried `DEFAULT ''` for exactly one commit: v20 added them while the ingest
        -- still wrote three columns, and without the bridge a schema step would have taken a
        -- working tag refresh down mid-flight. `tags::ingest_gz` fills both on every insert
        -- now, so the bridge came off with it.
        --
        -- What a default costs once nothing needs it is the silent failure the comments
        -- around here exist to prevent: every `oracle_tags.slug_norm` empty,
        -- `idx_oracle_tags_norm` indexing one value, and the tag search matching nothing in
        -- this namespace with no error anywhere. Without one, a forgotten column is a
        -- `NOT NULL constraint failed` at the refresh's first insert.
        -- See [`ART_TAG_TABLES_SQL`] for what each column holds.
        id TEXT NOT NULL,
        slug_norm TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE {schema}.oracle_tag_parents_staging (
        child_slug TEXT NOT NULL,
        parent_slug TEXT NOT NULL,
        PRIMARY KEY (child_slug, parent_slug)
    ) WITHOUT ROWID;
    CREATE TABLE {schema}.oracle_taggings_staging (
        oracle_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        weight TEXT,
        annotation TEXT,
        PRIMARY KEY (oracle_id, slug)
    ) WITHOUT ROWID;
    CREATE TABLE {schema}.oracle_tag_cards_staging (
        oracle_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        PRIMARY KEY (oracle_id, slug)
    ) WITHOUT ROWID;";

/// The four live oracle-tag tables and their staging twins, paired. One list, because the
/// swap, the cleanup and the test that compares the two shapes must all name the same four.
///
/// `muted_tags` is deliberately not here and is not a fifth entry waiting to be added: it is
/// the reader's, and everything on this list is emptied by the next refresh.
pub const ORACLE_TAG_TABLES: [(&str, &str); 4] = [
    ("oracle_tags", "oracle_tags_staging"),
    ("oracle_tag_parents", "oracle_tag_parents_staging"),
    ("oracle_taggings", "oracle_taggings_staging"),
    ("oracle_tag_cards", "oracle_tag_cards_staging"),
];

/// The four art-tag tables again, `_staging` and empty.
///
/// [`ORACLE_TAG_STAGING_SQL`]'s shape and every one of its reasons — a second literal rather
/// than [`ART_TAG_TABLES_SQL`] with its names rewritten, because the live DDL is *history* the
/// day it ships while this one describes head and moves with it.
/// `the_art_tag_staging_tables_match_the_live_ones` is what stops the two coming apart.
///
/// No `art_tag_meta_staging`: the watermark is one row written *with* the swap, not a table
/// that is rebuilt.
const ART_TAG_STAGING_SQL: &str = "
    DROP TABLE IF EXISTS {schema}.art_tags_staging;
    DROP TABLE IF EXISTS {schema}.art_tag_parents_staging;
    DROP TABLE IF EXISTS {schema}.art_taggings_staging;
    DROP TABLE IF EXISTS {schema}.art_tag_illustrations_staging;
    CREATE TABLE {schema}.art_tags_staging (
        slug TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        slug_norm TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE {schema}.art_tag_parents_staging (
        child_slug TEXT NOT NULL,
        parent_slug TEXT NOT NULL,
        PRIMARY KEY (child_slug, parent_slug)
    ) WITHOUT ROWID;
    CREATE TABLE {schema}.art_taggings_staging (
        illustration_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        weight TEXT,
        annotation TEXT,
        PRIMARY KEY (illustration_id, slug)
    ) WITHOUT ROWID;
    CREATE TABLE {schema}.art_tag_illustrations_staging (
        illustration_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        weight TEXT NOT NULL,
        PRIMARY KEY (illustration_id, slug)
    ) WITHOUT ROWID;";

/// The four live art-tag tables and their staging twins, paired — [`ORACLE_TAG_TABLES`]'s
/// rule: the swap, the cleanup and the shape-comparison test all name the same four.
pub const ART_TAG_TABLES: [(&str, &str); 4] = [
    ("art_tags", "art_tags_staging"),
    ("art_tag_parents", "art_tag_parents_staging"),
    ("art_taggings", "art_taggings_staging"),
    ("art_tag_illustrations", "art_tag_illustrations_staging"),
];

/// Create the four empty `art_tag_*_staging` tables, dropping any an interrupted run left
/// behind. [`create_oracle_tag_staging`]'s shape and its reason.
pub fn create_art_tag_staging(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&on_schema(CORPUS, ART_TAG_STAGING_SQL))
}

/// Drop the four `art_tag_*_staging` tables. What a refused or failed run leaves owing.
pub fn drop_art_tag_staging(conn: &Connection) -> rusqlite::Result<()> {
    let batch: String = ART_TAG_TABLES
        .iter()
        .map(|(_, staging)| format!("DROP TABLE IF EXISTS {CORPUS}.{staging};"))
        .collect();
    conn.execute_batch(&batch)
}

/// Create the four empty `oracle_tag_*_staging` tables, dropping any an interrupted run
/// left behind.
///
/// [`create_staging`]'s shape and its reason: the refresh writes here for the length of the
/// ingest, so no reader ever sees a half-built closure — a card whose ancestors have been
/// inserted and whose siblings have not is exactly the state a category list must never be
/// drawn from.
///
/// Unlike `cards_staging` this layout is a literal rather than a read-back of the live
/// table: these tables carry composite primary keys, which `PRAGMA table_info` describes but
/// [`cards_column_defs`] does not reproduce.
pub fn create_oracle_tag_staging(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&on_schema(CORPUS, ORACLE_TAG_STAGING_SQL))
}

/// Drop the four `oracle_tag_*_staging` tables. What a refused or failed run leaves owing.
pub fn drop_oracle_tag_staging(conn: &Connection) -> rusqlite::Result<()> {
    let batch: String = ORACLE_TAG_TABLES
        .iter()
        .map(|(_, staging)| format!("DROP TABLE IF EXISTS {CORPUS}.{staging};"))
        .collect();
    conn.execute_batch(&batch)
}

/// Promote one tag family's four staging tables over its live ones.
///
/// **The index replay below is this function's own, borrowed from [`swap_staging`] one family
/// over, and it is why both taxonomies come through one function rather than two hand-written
/// swaps.** Two of the four tables carry no index but their own primary key, which the rename
/// brings with it. The other two do: the taxonomy has `idx_{family}_tags_norm` and the closure
/// has `idx_{family}_..._slug` — and a rename carries the *staging* table's indexes rather than
/// the live table's, while no staging DDL creates an index at all.
///
/// **So without [`TAG_INDEXES_SQL`] here, the first weekly refresh silently un-indexes the
/// closure, and that is a hang rather than a slow page.** [`crate::tags::query`] counts a tag's
/// reach with a correlated `count(*)`, which is 49 ms with the closure index and **531 seconds**
/// without it (measured 2026-08-20, release build, at that day's file size). The reader's
/// window stops responding on the first keystroke in the tag box, a week after a refresh nobody
/// noticed, with nothing anywhere pointing here. A second hand-written swap is exactly where
/// this would be forgotten, and `the_tag_indexes_survive_a_*_tag_swap` are the fences.
fn swap_tag_staging(conn: &Connection, tables: &[(&str, &str)]) -> rusqlite::Result<()> {
    let batch: String = tables
        .iter()
        .map(|(live, staging)| {
            // The new name stays unqualified: `RENAME TO corpus.cards` is a syntax
            // error, and a rename cannot move a table between schemas at all.
            format!(
                "DROP TABLE IF EXISTS {CORPUS}.{live}; \
                 ALTER TABLE {CORPUS}.{staging} RENAME TO {live};"
            )
        })
        .collect();
    conn.execute_batch(&batch)?;
    conn.execute_batch(&on_schema(CORPUS, TAG_INDEXES_SQL))
}

/// Promote the four `oracle_tag_*_staging` tables over the live ones.
///
/// **The caller supplies the transaction**, which is the difference between this and
/// [`swap_staging`]: the watermark row that says which file these rows came from has to
/// commit with them, and a swap that landed without its `oracle_tag_meta` update would make
/// the next run re-download and re-ingest a file it already holds — or, worse the other way
/// round, a meta row that landed without its rows would make it 304 past an empty closure
/// forever.
pub fn swap_oracle_tag_staging(conn: &Connection) -> rusqlite::Result<()> {
    swap_tag_staging(conn, &ORACLE_TAG_TABLES)
}

/// Promote the four `art_tag_*_staging` tables over the live ones.
/// [`swap_oracle_tag_staging`]'s contract, one taxonomy over.
pub fn swap_art_tag_staging(conn: &Connection) -> rusqlite::Result<()> {
    swap_tag_staging(conn, &ART_TAG_TABLES)
}

/// The combo feed's two data tables again, `_staging` and empty.
///
/// [`ORACLE_TAG_STAGING_SQL`]'s shape and every one of its reasons — a second literal rather
/// than the v26 rung's DDL with its names rewritten, because the live DDL is *history* the day
/// it ships while this one describes head and moves with it.
/// `the_combo_staging_tables_match_the_live_ones` is what stops the two coming apart.
///
/// No `combo_meta_staging`: the watermark is one row written *with* the swap, not a table that
/// is rebuilt.
///
/// **The one difference from the tag family, and it is the foreign key.** `combo_cards_staging`
/// references **`combos_staging`** and not `combos`, which is the only spelling that works: a
/// staging child pointed at the live parent would be checked against the *previous* ingest's
/// ids on every insert, so the first variant the feed had not published last week would fail
/// the whole run. SQLite rewrites a `REFERENCES` clause in any other table when the table it
/// names is renamed — foreign keys are on for every connection in this crate — so
/// [`swap_combo_staging`]'s `combos_staging → combos` is also what turns this clause into the
/// live one, and `the_swapped_combo_cards_still_reference_combos` is the fence that says it
/// really happened rather than that somebody believed it would.
///
/// The two `DROP`s are child-first for [`swap_combo_staging`]'s reason, which is the same
/// reason read one table over.
const COMBO_STAGING_SQL: &str = "
    DROP TABLE IF EXISTS {schema}.combo_cards_staging;
    DROP TABLE IF EXISTS {schema}.combos_staging;
    CREATE TABLE {schema}.combos_staging (
        id             TEXT PRIMARY KEY,
        bracket_tag    TEXT NOT NULL,
        card_count     INTEGER NOT NULL,
        template_count INTEGER NOT NULL,
        identity       TEXT NOT NULL,
        produces       TEXT NOT NULL,
        popularity     INTEGER
    );
    CREATE TABLE {schema}.combo_cards_staging (
        combo_id          TEXT NOT NULL REFERENCES combos_staging(id) ON DELETE CASCADE,
        oracle_id         TEXT NOT NULL,
        name              TEXT NOT NULL,
        quantity          INTEGER NOT NULL,
        must_be_commander INTEGER NOT NULL
    );";

/// The combo feed's two live tables and their staging twins, paired — [`ORACLE_TAG_TABLES`]'s
/// rule: the swap, the cleanup and the shape-comparison test all name the same tables.
///
/// **Parent first, and the order is read backwards by one of the three.** [`drop_combo_staging`]
/// and the shape test do not care; [`swap_combo_staging`] drops the *child* first and so walks
/// this list in reverse for that half, which is why it is written out rather than folded into
/// [`swap_tag_staging`]'s loop.
///
/// `combo_meta` is deliberately not here and is not a third entry waiting to be added: it is the
/// watermark, and everything on this list is emptied by the next refresh.
pub const COMBO_TABLES: [(&str, &str); 2] = [
    ("combos", "combos_staging"),
    ("combo_cards", "combo_cards_staging"),
];

/// Create the two empty `combo*_staging` tables, dropping any an interrupted run left behind.
///
/// [`create_oracle_tag_staging`]'s shape and its reason: the refresh writes here for the length
/// of the ingest, so no reader ever sees a half-built combo list — a deck matched against a
/// table holding the first eight thousand variants of forty thousand would be told it has no
/// combos, confidently and wrongly.
pub fn create_combo_staging(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&on_schema(CORPUS, COMBO_STAGING_SQL))
}

/// Drop the two `combo*_staging` tables. What a refused or failed run leaves owing.
///
/// **Child first**, [`swap_combo_staging`]'s rule and for its reason: with foreign keys on, a
/// `DROP TABLE` is an implicit `DELETE`, so dropping the parent first drags every staged child
/// row through a cascade on the way to dropping that table too. The list is walked in reverse
/// rather than spelled out, so a third table added to [`COMBO_TABLES`] is covered without
/// anybody remembering this line.
pub fn drop_combo_staging(conn: &Connection) -> rusqlite::Result<()> {
    let batch: String = COMBO_TABLES
        .iter()
        .rev()
        .map(|(_, staging)| format!("DROP TABLE IF EXISTS {CORPUS}.{staging};"))
        .collect();
    conn.execute_batch(&batch)
}

/// Promote the two `combo*_staging` tables over the live ones.
///
/// **The caller supplies the transaction**, [`swap_oracle_tag_staging`]'s contract and its
/// reason: the `combo_meta` row that says which file these rows came from has to commit with
/// them. A swap that landed without its watermark would make the next run re-download and
/// re-ingest a file it already holds — or, worse the other way round, a meta row that landed
/// without its rows would make it 304 past an empty table forever.
///
/// **The index replay is [`swap_tag_staging`]'s and it is not optional.** A rename carries the
/// *staging* table's indexes rather than the live table's, and [`COMBO_STAGING_SQL`] creates
/// none at all — so without [`COMBO_INDEXES_SQL`] here the first refresh silently un-indexes
/// `combo_cards` and every bracket check after it scans the whole table. That failure is a
/// panel that got slower a week after a refresh nobody noticed, with nothing anywhere pointing
/// at this function; `the_combo_indexes_survive_a_swap` is the fence.
///
/// **The order of the four statements is the rest of it.** The child is dropped before the
/// parent because a `DROP TABLE` with foreign keys on is an implicit `DELETE` — the other way
/// round takes every live `combo_cards` row through the cascade behind `combo_cards.combo_id`
/// first, which is work done to rows that are about to be dropped anyway. The parent is
/// *renamed* before the child, and that half is load-bearing rather than tidy: SQLite rewrites
/// `REFERENCES` clauses that name a renamed table, so `combos_staging → combos` is exactly what
/// turns `combo_cards_staging`'s key into the live one this schema declares.
pub fn swap_combo_staging(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS {CORPUS}.combo_cards;
         DROP TABLE IF EXISTS {CORPUS}.combos;
         ALTER TABLE {CORPUS}.combos_staging RENAME TO combos;
         ALTER TABLE {CORPUS}.combo_cards_staging RENAME TO combo_cards;"
    ))?;
    conn.execute_batch(&on_schema(CORPUS, COMBO_INDEXES_SQL))
}

/// `pub(crate)` for the deck seed helpers at the bottom of the module: Task 3's
/// reconciler tests need the same deck-shaped fixture, and a second hand-rolled copy of
/// it is a second thing to keep true. `#[cfg(test)]` still bounds all of it to test builds.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// `sqlite_master` over **every** database attached to `conn`, as a subquery.
    ///
    /// A test that spells `sqlite_master` unqualified stops covering the corpus the moment
    /// one is attached, and says nothing about it — which is the failure
    /// `crate::mirror::watch`'s own schema guard had. This reads `PRAGMA database_list`
    /// instead, so one helper serves a pre-split single file and a pair without either test
    /// having to know which it was handed.
    fn master(conn: &Connection) -> String {
        let mut stmt = conn.prepare("PRAGMA database_list").unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let parts: Vec<String> = names
            .iter()
            .map(|n| format!("SELECT * FROM {n}.sqlite_master"))
            .collect();
        format!("({})", parts.join(" UNION ALL "))
    }

    /// The assertion the whole of the wiring exists to make, and the only cheap way to catch
    /// forty unqualified statements: after a pair has been built **and put through a full
    /// sync of all four feeds**, every table is in the file [`TABLES`] names.
    ///
    /// A staging table created unqualified lands in `main`, is renamed over a `cards` that is
    /// not there, and the failure surfaces days later as a user file that has grown to
    /// 800 MB. This is where it surfaces instead.
    #[test]
    fn a_full_sync_leaves_every_table_on_its_own_side() {
        let conn = memory_pair();

        // The four staging paths, in the order a sync runs them.
        create_staging(&conn).unwrap();
        swap_staging(&conn).unwrap();
        create_oracle_tag_staging(&conn).unwrap();
        swap_oracle_tag_staging(&conn).unwrap();
        create_art_tag_staging(&conn).unwrap();
        swap_art_tag_staging(&conn).unwrap();
        create_combo_staging(&conn).unwrap();
        swap_combo_staging(&conn).unwrap();

        for (table, side) in TABLES {
            let here = |schema: &str| -> i64 {
                conn.query_row(
                    &format!(
                        "SELECT count(*) FROM {schema}.sqlite_master
                         WHERE type='table' AND name=?1"
                    ),
                    [table],
                    |r| r.get(0),
                )
                .unwrap()
            };
            let (want_user, want_corpus) = match side {
                Side::User => (1, 0),
                Side::Corpus => (0, 1),
            };
            assert_eq!(
                here("main"),
                want_user,
                "{table} should be in the user file"
            );
            assert_eq!(here(CORPUS), want_corpus, "{table} should be in the corpus");
        }

        // And nothing else in either — a staging table left behind is a table too.
        let leftovers: i64 = conn
            .query_row(
                "SELECT count(*) FROM main.sqlite_master
                 WHERE type='table' AND name LIKE '%\\_staging' ESCAPE '\\'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftovers, 0, "a staging table was created in the user file");
        let stray: i64 = conn
            .query_row(
                "SELECT count(*) FROM main.sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            stray, 15,
            "the user file holds the fifteen and nothing else"
        );
    }

    /// FTS5 resolves `content='cards'` in **its own schema**, so an index built in the wrong
    /// file creates cleanly and fails on its first rebuild with `no such table: main.cards`.
    #[test]
    fn the_search_index_is_built_beside_the_cards_it_indexes() {
        let conn = memory_pair();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES ('x','Lightning Bolt','lea','161','en','normal','{}')",
            [],
        )
        .unwrap();
        create_fts(&conn).unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH 'lightning'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }

    /// [`CORPUS_SCHEMA_SQL`]'s half of [`USER_SCHEMA_SQL`]'s guarantee, and it matters more
    /// here rather than less: this is the shape a *rebuilt* corpus gets, so a column dropped
    /// in transcription would be a difference between the reader who has resynced and the
    /// reader who has not.
    #[test]
    fn the_corpus_schema_is_byte_identical_to_what_the_ladder_builds() {
        let dump = |conn: &Connection, schema: &str| -> Vec<(String, String, String)> {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT type, name, tbl_name, coalesce(sql, '') FROM {schema}.sqlite_master
                     ORDER BY type, name"
                ))
                .unwrap();
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .filter(|(_, _, tbl, _)| side_of(tbl) == Some(Side::Corpus))
                .map(|(ty, name, _, sql)| (ty, name, sql))
                .collect();
            rows
        };

        let ladder = Connection::open_in_memory().unwrap();
        migrate_single_file(&ladder).unwrap();
        let want = dump(&ladder, "main");

        let pair = memory_pair();
        let got = dump(&pair, CORPUS);

        for (w, g) in want.iter().zip(got.iter()) {
            assert_eq!(w, g, "{} {} differs from the ladder's", g.0, g.1);
        }
        assert_eq!(want, got);

        // And the one table on this side that no feed produces has its rows.
        let formats: i64 = pair
            .query_row("SELECT count(*) FROM format_specs", [], |r| r.get(0))
            .unwrap();
        let seeded: i64 = ladder
            .query_row("SELECT count(*) FROM format_specs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            formats, seeded,
            "a rebuilt corpus owes the format rules too"
        );
    }

    /// The one row the ladder puts in a user table reaches a test pair as well, because a
    /// database with no `Recently removed` folder is a state no converted database is in.
    #[test]
    fn a_test_pair_has_the_holding_area_a_converted_database_has() {
        let pair = memory_pair();
        let n: i64 = pair
            .query_row(
                "SELECT count(*) FROM collection_folders WHERE kind = 'removed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }

    /// [`USER_SCHEMA_SQL`] was copied out of a migrated database rather than retyped, and
    /// this is what makes "copied" a fact instead of a claim.
    ///
    /// Byte-for-byte, because the split *renames a file into place*: the user file has to be
    /// the shape the ladder would have left, not a shape that reads the same. A `DEFAULT`
    /// dropped in transcription, a `CHECK` reflowed, an `ALTER TABLE` tail tidied into the
    /// column list — none of those would fail a query, and every one of them is a
    /// database that quietly disagrees with the one every other install has.
    #[test]
    fn the_user_schema_is_byte_identical_to_what_the_ladder_builds() {
        let dump = |conn: &Connection| -> Vec<(String, String, String)> {
            let mut stmt = conn
                .prepare(
                    "SELECT type, name, tbl_name, coalesce(sql, '') FROM sqlite_master
                     ORDER BY type, name",
                )
                .unwrap();
            stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .filter(|(_, _, tbl, _)| side_of(tbl) == Some(Side::User))
            .map(|(ty, name, _, sql)| (ty, name, sql))
            .collect()
        };

        let ladder = Connection::open_in_memory().unwrap();
        migrate_single_file(&ladder).unwrap();
        let want = dump(&ladder);

        let head = Connection::open_in_memory().unwrap();
        create_user_schema(&head, "main").unwrap();
        let got = dump(&head);

        assert_eq!(
            want.len(),
            40,
            "fifteen tables, twenty-three indexes, and the two `sqlite_autoindex` rows a \
             TEXT PRIMARY KEY brings with it"
        );
        for (w, g) in want.iter().zip(got.iter()) {
            assert_eq!(w, g, "{} {} differs from the ladder's", g.0, g.1);
        }
        assert_eq!(want, got);
    }

    /// The same DDL built into an *attached* file is the same DDL. SQLite re-renders the
    /// name token of a `CREATE` and stores the rest verbatim, so the `{schema}.` prefix does
    /// not reach `sqlite_master` — which is the whole reason one literal can serve both
    /// `main` and the scratch file `crate::split` builds.
    #[test]
    fn the_schema_prefix_does_not_reach_sqlite_master() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("ATTACH DATABASE ':memory:' AS part")
            .unwrap();
        create_user_schema(&conn, "part").unwrap();
        let sql: String = conn
            .query_row(
                "SELECT sql FROM part.sqlite_master WHERE name = 'app_meta'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            sql,
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        );
    }

    /// Every table a migrated database creates is on exactly one side, named here on purpose.
    ///
    /// The point is the *next* table: one added by a later rung without a line in [`TABLES`]
    /// turns this red rather than landing in whichever file the DDL happened to be unqualified
    /// in. `mirror::watch::every_table_in_the_schema_has_been_decided_about` is the same shape
    /// for the same reason, and this is its storage twin.
    #[test]
    fn every_table_is_on_exactly_one_side() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        let live: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        let named: Vec<&str> = TABLES.iter().map(|(n, _)| *n).collect();
        let mut sorted = named.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            named.len(),
            "a table is named twice in TABLES"
        );

        let live_refs: Vec<&str> = live.iter().map(String::as_str).collect();
        assert_eq!(
            live_refs, sorted,
            "TABLES and the migrated schema disagree; add the new table to TABLES on purpose"
        );
    }

    /// The user side, spelled out. A table moving between the two files is a data migration,
    /// never a diff nobody noticed.
    #[test]
    fn the_user_side_is_the_fifteen_tables_no_feed_can_rebuild() {
        let mut user: Vec<&str> = TABLES
            .iter()
            .filter(|(_, s)| *s == Side::User)
            .map(|(n, _)| *n)
            .collect();
        user.sort_unstable();
        assert_eq!(
            user,
            [
                "app_meta",
                "card_migrations",
                "collection_entries",
                "collection_folders",
                "deck_audit",
                "deck_cards",
                "deck_categories",
                "deck_folders",
                "deck_tags",
                "deck_undo",
                "decks",
                "error_log",
                "muted_tags",
                "wishlist_entries",
                "wishlist_folders",
            ]
        );
    }

    /// No foreign key may cross the split. SQLite accepts the `CREATE TABLE` and fails only on
    /// the first `INSERT`, with `no such table: main.cards` — a trap that would ship.
    #[test]
    fn no_foreign_key_crosses_the_two_sides() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();

        for (table, side) in TABLES {
            let mut stmt = conn
                .prepare(&format!("PRAGMA foreign_key_list({table})"))
                .unwrap();
            let targets: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(2))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            for target in targets {
                let other = side_of(&target)
                    .unwrap_or_else(|| panic!("{table} references unknown table {target}"));
                assert_eq!(
                    other, *side,
                    "{table} ({side:?}) declares a foreign key to {target} ({other:?}); \
                     SQLite cannot enforce one across attached databases"
                );
            }
        }
    }

    #[test]
    fn migrate_is_idempotent_and_creates_tables() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        migrate_single_file(&conn).unwrap(); // no error on rerun
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name IN
                 ('cards','sets','sync_meta','cards_fts',
                  'collection_entries','collection_folders','wishlist_entries',
                  'card_migrations','decks','deck_cards','format_specs',
                  'combos','combo_cards','combo_meta')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 14);
        // v26's column, on the same fresh database: a rerun of `migrate_single_file` must not answer
        // `duplicate column name`, which is the one way an `ALTER TABLE … ADD COLUMN` rung can
        // break the idempotence this test is named for.
        assert_eq!(has_column(&conn, "decks", "bracket"), 1);

        // Without this the test would still pass while `migrate_single_file` re-ran its whole batch
        // every call (the CREATEs are all `IF NOT EXISTS`), silently rebuilding FTS each
        // time. The version bump is what makes the rerun a genuine no-op — so this tracks
        // the *current* head version, not the version that first created these tables.
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
    }

    /// The grain constants exist to be pasted into an `ON CONFLICT(…)` target verbatim,
    /// and SQLite matches a conflict target against an index by *parsed expression*, not
    /// by string — but a target that matches nothing is not a compile error, it is a
    /// runtime "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"
    /// raised at the first quick-add. Proven here, once, so the upsert Task 5 builds on
    /// cannot fail for a reason that had nothing to do with Task 5.
    #[test]
    fn each_grain_constant_works_as_an_upsert_conflict_target() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();

        let add = |qty: i64| {
            conn.execute(
                &format!(
                    "INSERT INTO collection_entries
                        (card_id,set_code,collector_number,lang,finish,condition,quantity,
                         created_at,updated_at)
                     VALUES ('bolt','lea','161','en','foil','NM',?1,unixepoch(),unixepoch())
                     ON CONFLICT ({COLLECTION_GRAIN}) DO UPDATE
                        SET quantity = quantity + excluded.quantity"
                ),
                [qty],
            )
        };
        add(2).unwrap();
        add(3).expect("the second add must fold into the first, not raise");
        let (rows, qty): (i64, i64) = conn
            .query_row(
                "SELECT count(*), sum(quantity) FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, qty), (1, 5), "one row, quantities folded");

        let wish = |qty: i64| {
            conn.execute(
                &format!(
                    "INSERT INTO wishlist_entries
                        (oracle_id,card_id,name,quantity,created_at,updated_at)
                     VALUES ('o1',NULL,'Lightning Bolt',?1,unixepoch(),unixepoch())
                     ON CONFLICT ({WISHLIST_GRAIN}) DO UPDATE
                        SET quantity = quantity + excluded.quantity"
                ),
                [qty],
            )
        };
        wish(1).unwrap();
        wish(1).expect("an any-printing wish folds into the one already there");
        let (rows, qty): (i64, i64) = conn
            .query_row(
                "SELECT count(*), sum(quantity) FROM wishlist_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, qty), (1, 2));
    }

    /// The fence the frozen migration steps need, and the one thing freezing them costs.
    ///
    /// Every grain index in the DDL is now a **literal**, because a migration step is history
    /// and must keep building the index it built the day it shipped. The price is that two
    /// of the five grain constants — [`DECK_CATEGORY_GRAIN`] and
    /// [`DECK_TAG_GRAIN`] — are read by no SQL at all any more, and a constant nothing reads
    /// is a constant that can drift from the index it claims to describe without anything
    /// saying so. [`COLLECTION_GRAIN`], [`WISHLIST_GRAIN`] and [`DECK_CARD_GRAIN`] are held
    /// to their indexes by their `ON CONFLICT` targets (the test above, and every deck-card
    /// upsert); these three are held here.
    ///
    /// Read through `PRAGMA index_info` rather than by comparing DDL text, which is the whole
    /// point: it answers the *parsed* column list, so the literal in the migration is free to
    /// be wrapped and indented however it reads best. The three grains with `coalesce(…)` in
    /// them cannot be checked this way — an expression column comes back with a NULL name —
    /// and do not need to be, since a mismatched conflict target is a hard error at the first
    /// write. **[`DECK_CARD_GRAIN`] became the third of those in v19**, when `finish` joined
    /// it; it left this list rather than losing its fence, since every
    /// `ON CONFLICT ({DECK_CARD_GRAIN})` in [`crate::deck`], [`crate::deck_meta`] and
    /// [`crate::deck_theory`] still fails loudly at the first write if it drifts.
    #[test]
    fn every_plain_grain_constant_names_the_index_the_head_schema_carries() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();

        for (index, grain) in [
            ("idx_deck_categories_grain", DECK_CATEGORY_GRAIN),
            ("idx_deck_tags_grain", DECK_TAG_GRAIN),
        ] {
            let mut stmt = conn
                .prepare(&format!("PRAGMA index_info({index})"))
                .unwrap_or_else(|e| panic!("`{index}` must exist at head: {e}"));
            let columns: Vec<String> = stmt
                .query_map([], |r| r.get::<_, Option<String>>(2))
                .unwrap()
                .map(|c| c.unwrap().expect("a plain grain has no expression column"))
                .collect();
            let want: Vec<String> = grain.split(", ").map(str::to_owned).collect();
            assert!(!columns.is_empty(), "`{index}` must exist at head");
            assert_eq!(
                columns, want,
                "`{index}` and its grain constant have drifted apart"
            );
        }
    }

    /// A killed sync leaves a *committed* staging table now that the ingest chunks its
    /// load — several hundred megabytes of it, on the database of an app that ships on a
    /// USB stick. Nothing else would drop it before the next run that is actually due:
    /// `create_staging` holds the only other `DROP`, and `bulk_etag`/`bulk_updated_at` are
    /// written only after a *successful* ingest — so the killed run stored nothing, and the
    /// rest of the 24 h check window (longer, offline) stands between the residue and the
    /// `create_staging` that would clear it.
    ///
    /// A real file rather than `:memory:`, because the residue this is about is disk.
    #[test]
    fn startup_drops_the_staging_table_a_killed_ingest_left_behind() {
        let dir = std::env::temp_dir().join("mtgtest-schema-residue");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::split::convert(&dir).unwrap();

        // The state a killed ingest leaves: a migrated database, a swap that never ran,
        // and committed rows in staging.
        {
            let conn = crate::db::open_write(&dir).unwrap();
            prepare_database(&conn).unwrap();
            create_staging(&conn).unwrap();
            conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('half','Half Ingested','x','1','en','normal','{}')", []).unwrap();
            crate::db::checkpoint_truncate(&conn).unwrap();
        }

        // The next launch, which is `init_state`'s one act of database preparation.
        let conn = crate::db::open_write(&dir).unwrap();
        prepare_database(&conn).unwrap();

        let staging: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {CORPUS}.sqlite_master WHERE name='cards_staging'"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(staging, 0, "crash residue must not survive a launch");
        // And the launch is still a launch: the schema it was there to prepare is intact.
        let tables: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM {CORPUS}.sqlite_master
                     WHERE name IN ('cards','sets','sync_meta','cards_fts')"
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 4);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The twin of `maintenance::a_launch_survives_a_repair_it_cannot_carry_out`, for the
    /// other non-fatal step. `init_state` turns a `prepare_database` error into "this file
    /// may be from a newer version of the app, or damaged — move it aside", which is a
    /// misleading thing to say about a database whose only problem is that the *disk* is
    /// full or read-only, and a useless thing to suggest to somebody who has no room to
    /// move it to. Space this drop would have reclaimed is not worth a launch.
    ///
    /// The failure is arranged with a view, because "the disk is full" is not something a
    /// test can stage hermetically: `DROP TABLE` refuses to delete a view by name, so the
    /// statement fails for a reason of its own while everything around it stays healthy.
    #[test]
    fn a_launch_survives_a_staging_drop_it_cannot_carry_out() {
        let conn = memory_pair();
        conn.execute_batch(&format!(
            "CREATE VIEW {CORPUS}.cards_staging AS SELECT 1 AS x;"
        ))
        .unwrap();

        prepare_database(&conn).expect("a launch must not die on a drop it cannot do");

        // The residue is still there, and still recorded where the next attempt looks —
        // `create_staging` at the next sync, `prepare_database` at the next launch.
        let still: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {CORPUS}.sqlite_master WHERE name='cards_staging'"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(still, 1, "the debt stays where a later run will find it");
    }

    /// The collapsed search reads this index and nothing else; without it the default
    /// browse costs 767 ms instead of 108 ms. It lives in [`CARDS_INDEXES`] because
    /// [`swap_staging`] drops `cards` with its indexes on every sync and replays only that
    /// list — an index created anywhere else is gone at the next sync, on every machine
    /// that has already migrated.
    #[test]
    fn the_collapse_index_exists_after_migrate_and_survives_a_swap() {
        let conn = memory_pair();

        let sql: String = conn
            .query_row(
                &format!(
                    "SELECT sql FROM {m} WHERE type='index' AND name='idx_cards_collapse'",
                    m = master(&conn)
                ),
                [],
                |r| r.get(0),
            )
            .expect("migrate must create idx_cards_collapse");
        // The column order is the whole point: `oracle_id` leads so the GROUP BY reads it
        // in group order, and the rest are there so the scan is covering.
        assert!(
            sql.contains("oracle_id, is_paper, released_at, id, name, price_usd"),
            "index column order decides whether the scan is covering: {sql}"
        );

        create_staging(&conn).unwrap();
        swap_staging(&conn).unwrap();
        let after: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM {m}
                      WHERE type='index' AND tbl_name='cards' AND name='idx_cards_collapse'",
                    m = master(&conn)
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, 1, "the swap must replay the collapse index");
    }

    /// A database that migrated before the collapse index existed must gain it, and running
    /// `migrate_single_file` twice must be a no-op — every statement in [`CARDS_INDEXES`] is
    /// `IF NOT EXISTS`, which is what lets the newest step replay the whole list rather than
    /// naming the one index it changed.
    ///
    /// **Which step that is has moved twice, and moves again with every merge: the index
    /// arrives at v20 now — not v7, and no longer v10 either.** v7 used to replay
    /// [`CARDS_INDEXES`] itself; the list named `legal_mask`, which v10 is what adds, so the
    /// replay moved to v10 — and then to v20, which adds `illustration_id` to the same list.
    /// Every step below the replay creates no index at all. What this test asserts is
    /// unchanged and is deliberately written in terms of the *outcome* — a pre-collapse-index
    /// database ends up with the index, whichever step hands it over. That is why neither the
    /// renumber from v9 to v10 nor the move to v20 touched this test's body.
    ///
    /// The fixture is [`v6_deck_database`] — a database genuinely *at* version 6, with
    /// `cards` in its v1 shape and the three indexes v1 created — rather than a head
    /// database with `DROP INDEX` and `PRAGMA user_version = 6` behind it. Rewinding the
    /// pragma stopped being a stand-in for a v6 database the moment the v8 step joined the
    /// ladder *below* this one: `migrate_single_file` reads `user_version` once and walks every step
    /// above it, so a rewind to 6 tells v8 to rebuild `decks` and `deck_cards` while they
    /// are already in their v8 shape, and the run dies on a duplicate `folder_id` column —
    /// a failure no real upgrade could produce. It is the same trap [`v6_deck_database`]'s
    /// own doc names, arriving at a second test.
    #[test]
    fn a_database_from_before_the_collapse_index_gains_it_and_a_rerun_is_a_no_op() {
        let conn = v6_deck_database();
        let before: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='idx_cards_collapse'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            before, 0,
            "a v6 database has not got the collapse index yet"
        );

        migrate_single_file(&conn).unwrap();
        migrate_single_file(&conn).unwrap();

        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='idx_cards_collapse'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
    }

    #[test]
    fn staging_swap_replaces_cards_and_fts_finds_new_rows() {
        let conn = memory_pair();
        conn.execute("INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw) VALUES ('old','Old Card','abc','1','en','normal','{}')", []).unwrap();
        create_staging(&conn).unwrap();
        conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('new','Lightning Bolt','lea','161','en','normal','{}')", []).unwrap();
        swap_staging(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);

        // The swapped-in table must carry the same index names as the one it replaced,
        // or every query planned against `cards` silently loses its index.
        let idx: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM {m} WHERE type='index' AND tbl_name='cards'
                     AND name IN ('idx_cards_oracle','idx_cards_set_cn','idx_cards_name',
                                  'idx_cards_collapse')",
                    m = master(&conn)
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            idx, 4,
            "indexes must be recreated under their original names"
        );

        let staging: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM {m} WHERE name='cards_staging'",
                    m = master(&conn)
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(staging, 0, "staging table is consumed by the rename");
    }

    /// The invariant this whole plan is shaped by, now with the real tables: a sync drops
    /// `cards` outright, and the user's collection has to be sitting there afterwards.
    /// `foreign_keys` is ON here (as it is in `db::open`) so the failure this guards
    /// against — a `REFERENCES cards(id)` that aborts every sync — could actually happen.
    ///
    /// This is `a_soft_card_reference_survives_the_swap_that_drops_cards` grown up: that
    /// test built a stand-in `collection_entries` by hand because the real one did not
    /// exist yet. It does now, so the guard runs against the table the app actually uses
    /// — and a hand-built stand-in would no longer even create (the name is taken).
    #[test]
    fn user_rows_survive_the_swap_that_drops_cards() {
        let conn = memory_pair();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('bolt','Lightning Bolt','lea','161','en','normal','{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('bolt','lea','161','en','foil','LP',4,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o1',NULL,'Lightning Bolt',2,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO card_migrations (id,performed_at,strategy,old_card_id,new_card_id,applied_at)
             VALUES ('m1','2026-01-01T00:00:00Z','merge','old','bolt',unixepoch())",
            [],
        )
        .unwrap();

        create_staging(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards_staging (id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('bolt','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        swap_staging(&conn).expect("a sync must not be blocked by the user's own tables");

        for table in ["collection_entries", "wishlist_entries", "card_migrations"] {
            let n: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "`{table}` is not sync data");
        }
        // And the denormalised printing is still the printing the user recorded, not
        // whatever the new `cards` row says. That is the point of storing it. The soft
        // reference and the quantity come back too: surviving the swap as an emptied or
        // repointed row would satisfy the count above and be no use to anyone.
        let (card_id, set, cn, qty): (String, String, String, i64) = conn
            .query_row(
                "SELECT card_id, set_code, collector_number, quantity FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (card_id.as_str(), set.as_str(), cn.as_str(), qty),
            ("bolt", "lea", "161", 4),
            "user rows are not sync data"
        );
    }

    /// Two copies are one row when they agree on the grain, and two rows when they do not.
    /// The `coalesce`s are load-bearing: SQLite treats NULLs in a UNIQUE index as distinct,
    /// so without them a second unserialised copy would insert instead of conflicting, and
    /// the upsert every quick-add depends on would silently create duplicates.
    ///
    /// **Every** term of [`COLLECTION_GRAIN`] is exercised, one at a time, because this is
    /// the constant all of Plan 3 upserts against and a term silently dropped from it is a
    /// term that stops distinguishing anything. Deleting any of `card_id`, `finish`,
    /// `condition`, `lang`, `serial_number`, the four flags or `grading` from the constant
    /// fails a line below — and turning `coalesce(serial_number, '')` back into a bare
    /// `serial_number` fails the very first assertion, because two NULLs would stop
    /// conflicting.
    ///
    /// `card_id` and `lang` are the two that took a deliberate row each. Every other term
    /// varies naturally across the cases above them; those two were held constant by the
    /// fixture, so until this test grew a German copy and a second card, "every term" was a
    /// sentence about the constant rather than about anything being checked.
    #[test]
    fn the_collection_grain_is_unique_including_the_nullable_parts() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let add = |finish: &str, condition: &str, serial: Option<&str>| {
            conn.execute(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     serial_number,created_at,updated_at)
                 VALUES ('bolt','lea','161','en',?1,?2,1,?3,unixepoch(),unixepoch())",
                rusqlite::params![finish, condition, serial],
            )
        };
        add("foil", "NM", None).unwrap();
        assert!(add("foil", "NM", None).is_err(), "same grain, same row");
        add("nonfoil", "NM", None).unwrap();
        add("foil", "LP", None).unwrap();
        add("foil", "NM", Some("042/500")).unwrap();
        add("foil", "NM", Some("043/500")).unwrap();

        // `lang` and `card_id`, each differing in exactly one term from the very first row
        // — a German Alpha Bolt is a different object from an English one (spec §1 keeps
        // `lang` per entry for precisely this), and two cards are two cards. Neither varies
        // anywhere else in this test, so without these two rows both terms could be deleted
        // from the constant with every assertion still passing.
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES ('bolt','lea','161','de','foil','NM',1,unixepoch(),unixepoch())",
            [],
        )
        .expect("`lang` must be part of the grain: a German copy is not the English one");
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES ('shock','m21','159','en','foil','NM',1,unixepoch(),unixepoch())",
            [],
        )
        .expect("`card_id` must be part of the grain");

        // The four flags. Each is in the grain because an altered — or signed, or proxy,
        // or misprinted — copy is a *different object* from a clean one, not a note about
        // the same one; a playset of four is not four of whatever the first one is. Each
        // is toggled on its own against the clean row the first `add` already stored, so a
        // flag dropped from the constant collides with that row and fails here by name.
        let flagged = |flag: &str| {
            conn.execute(
                &format!(
                    "INSERT INTO collection_entries
                        (card_id,set_code,collector_number,lang,finish,condition,quantity,
                         {flag},created_at,updated_at)
                     VALUES ('bolt','lea','161','en','foil','NM',1,1,unixepoch(),unixepoch())"
                ),
                [],
            )
        };
        for flag in ["altered", "signed", "proxy", "misprint"] {
            flagged(flag)
                .unwrap_or_else(|e| panic!("`{flag}` must be part of the grain, but: {e}"));
            assert!(
                flagged(flag).is_err(),
                "the same `{flag}` copy twice is one row"
            );
        }

        // `grading` likewise, and as raw text (see `COLLECTION_GRAIN`): a slabbed copy is
        // not the ungraded one, and a PSA 10 is not a CGC 9.5. Identical grading is the
        // same slab and must conflict — which is exactly why the text has to be written
        // canonically, since only the bytes are compared.
        let graded = |grading: &str| {
            conn.execute(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     grading,created_at,updated_at)
                 VALUES ('bolt','lea','161','en','foil','NM',1,?1,unixepoch(),unixepoch())",
                [grading],
            )
        };
        let psa10 = r#"{"company":"PSA","grade":10}"#;
        graded(psa10).expect("a graded copy is not the ungraded one");
        graded(r#"{"company":"CGC","grade":9.5}"#).expect("and one grader's 10 is not another's");
        assert!(graded(psa10).is_err(), "the same slab twice is one row");

        let n: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 13);
    }

    /// The enums, enforced where they cannot be argued with. `finishes` is a strict enum
    /// upstream and the research doc names a boolean `foil` column as the single most
    /// common importer data-loss bug; a CHECK is what stops "Foil" or `1` ever landing.
    #[test]
    fn the_finish_and_condition_enums_are_enforced_by_the_database() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        // A different card every time, so that the *only* thing that can reject a row is
        // the value under test. Held on one `card_id` the accepted values would collide
        // with each other on the grain — `nonfoil`/`NM` is the first finish *and* the
        // first condition — and a UNIQUE failure would read exactly like a CHECK failure.
        let nth = std::cell::Cell::new(0);
        let add = |finish: &str, condition: &str, qty: i64| {
            nth.set(nth.get() + 1);
            conn.execute(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
                 VALUES (?1,'lea','161','en',?2,?3,?4,unixepoch(),unixepoch())",
                rusqlite::params![format!("card{}", nth.get()), finish, condition, qty],
            )
        };
        for (finish, condition, qty) in [
            ("Foil", "NM", 1),
            ("foil", "Near Mint", 1),
            ("foil", "NM", -1),
            ("", "NM", 1),
        ] {
            let err = add(finish, condition, qty).expect_err(&format!(
                "({finish}, {condition}, {qty}) must not be storable"
            ));
            // And rejected by the CHECK that is the subject here, not by some other
            // constraint that happens to fire first.
            assert!(
                matches!(&err, rusqlite::Error::SqliteFailure(e, _)
                         if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_CHECK),
                "({finish}, {condition}, {qty}) was rejected, but not by a CHECK: {err}"
            );
        }
        for finish in ["nonfoil", "foil", "etched"] {
            add(finish, "NM", 1).unwrap();
        }
        for condition in ["NM", "LP", "MP", "HP", "DMG"] {
            add("nonfoil", condition, 1).unwrap();
        }
    }

    /// A wish is for an *oracle card*, optionally pinned to a printing — and "any
    /// printing" (`card_id IS NULL`) is a different wish from "this printing", not a
    /// duplicate of it.
    #[test]
    fn a_wish_for_any_printing_and_one_for_a_printing_are_two_rows() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let wish = |card_id: Option<&str>, finish: Option<&str>| {
            conn.execute(
                "INSERT INTO wishlist_entries
                    (oracle_id,card_id,name,quantity,preferred_finish,created_at,updated_at)
                 VALUES ('o1',?1,'Lightning Bolt',1,?2,unixepoch(),unixepoch())",
                rusqlite::params![card_id, finish],
            )
        };
        wish(None, None).unwrap();
        assert!(wish(None, None).is_err(), "the same wish twice is one wish");
        wish(Some("bolt-lea"), None).unwrap();
        wish(None, Some("foil")).unwrap();

        let n: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3);
    }

    /// Staging is renamed *over* `cards`, so its layout has to be whatever `cards` is
    /// today — not whatever the frozen v1 `CREATE` said. Simulated here as a future
    /// migration's `ALTER TABLE cards ADD COLUMN`: a `create_staging` built from a shared
    /// constant would omit the new column, and the next sync would drop it silently.
    #[test]
    fn staging_takes_its_columns_from_the_live_table_not_from_the_v1_constant() {
        let conn = memory_pair();
        conn.execute_batch("ALTER TABLE cards ADD COLUMN scryfall_uri TEXT;")
            .unwrap();

        create_staging(&conn).unwrap();

        assert_eq!(
            table_info(&conn, "cards_staging"),
            table_info(&conn, "cards"),
            "staging must be an exact clone of the live table"
        );
        // …and after the swap the new column is still there, with its data.
        conn.execute(
            "INSERT INTO cards_staging (id,name,set_code,collector_number,lang,layout,raw,scryfall_uri)
             VALUES ('new','Lightning Bolt','lea','161','en','normal','{}','https://scryfall.com/x')",
            [],
        )
        .unwrap();
        swap_staging(&conn).unwrap();
        let uri: String = conn
            .query_row("SELECT scryfall_uri FROM cards WHERE id='new'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(uri, "https://scryfall.com/x");
    }

    /// Every index on `cards` is dropped with the table on every sync, and only
    /// `CARDS_INDEXES` is replayed. Comparing the stored SQL — not just the names — is
    /// what catches an index that comes back over the wrong columns.
    #[test]
    fn the_indexes_on_cards_are_identical_before_and_after_a_swap() {
        let conn = memory_pair();
        // The list also carries SQLite's implicit `sqlite_autoindex_cards_1` (`sql` NULL),
        // which is the PRIMARY KEY — so comparing the whole list across the swap proves
        // the derived staging clone kept the key too.
        let before = indexes_on_cards(&conn);
        assert_eq!(
            before.iter().filter(|(_, sql)| sql.is_some()).count(),
            CARDS_INDEXES.len(),
            "migrate must create every index in the shared list"
        );

        create_staging(&conn).unwrap();
        conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('new','Lightning Bolt','lea','161','en','normal','{}')", []).unwrap();
        swap_staging(&conn).unwrap();

        assert_eq!(indexes_on_cards(&conn), before);
    }

    /// `(name, type, notnull, default, pk)` per column, in declaration order.
    fn table_info(
        conn: &Connection,
        table: &str,
    ) -> Vec<(String, String, i64, Option<String>, i64)> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get("name")?,
                    r.get("type")?,
                    r.get("notnull")?,
                    r.get("dflt_value")?,
                    r.get("pk")?,
                ))
            })
            .unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    fn indexes_on_cards(conn: &Connection) -> Vec<(String, Option<String>)> {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT name, sql FROM {m}
                 WHERE type='index' AND tbl_name='cards' ORDER BY name",
                m = master(conn)
            ))
            .unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    /// A swap that fails partway must leave the database exactly as it found it —
    /// `cards` intact, the search index intact, and no transaction left dangling on
    /// the connection. Here the failure is a missing `cards_staging`, which trips the
    /// swap *after* it has already dropped `cards` and `cards_fts`.
    #[test]
    fn failed_swap_rolls_back_and_leaves_connection_usable() {
        let conn = memory_pair();
        conn.execute("INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw) VALUES ('old','Old Card','abc','1','en','normal','{}')", []).unwrap();

        assert!(
            swap_staging(&conn).is_err(),
            "swap without a staging table must fail"
        );

        let n: i64 = conn
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "`cards` and its rows must survive a failed swap");
        let fts: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM {m} WHERE name='cards_fts'",
                    m = master(&conn)
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fts, 1, "the search index must survive a failed swap");

        // No stuck transaction: a real swap on this same connection must still work.
        create_staging(&conn).unwrap();
        conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('new','Lightning Bolt','lea','161','en','normal','{}')", []).unwrap();
        swap_staging(&conn).unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }

    /// A database that stopped at version 1 — what every machine that ran Plan 1 has on
    /// disk. Built from the frozen v1 constant rather than by calling `migrate_single_file`, because
    /// `migrate_single_file` now runs straight through to head and there is no way back.
    ///
    /// No indexes, for the reason the v1 step creates none: [`CARDS_INDEXES`] describes the
    /// table at head and names columns a v1 table does not have. The v20 step replays the
    /// list, so a database built here has its indexes by the time `migrate_single_file` returns —
    /// `every_version_ends_with_the_same_schema_as_a_fresh_install` is what asserts it.
    fn v1_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE cards ({CARDS_COLUMNS});
             CREATE TABLE sets (
                code TEXT PRIMARY KEY, name TEXT NOT NULL, arena_code TEXT, mtgo_code TEXT,
                set_type TEXT, released_at TEXT, icon_svg_uri TEXT);
             CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = 1;"
        ))
        .unwrap();
        create_fts_in(&conn, "main").unwrap();
        conn
    }

    fn insert_raw(conn: &Connection, id: &str, name: &str, raw: &str) {
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, search_text, raw)
             VALUES (?1, ?2, 'tst', '1', 'en', 'normal', ?2, ?3)",
            rusqlite::params![id, name, raw],
        )
        .unwrap();
    }

    #[test]
    fn migrate_reaches_the_head_version_and_adds_the_image_columns() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        migrate_single_file(&conn).unwrap(); // still idempotent

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);

        let columns: Vec<String> = table_info(&conn, "cards")
            .into_iter()
            .map(|(name, ..)| name)
            .collect();
        assert!(columns.contains(&"image_uris".to_owned()), "{columns:?}");
        assert!(
            columns.contains(&"face_image_uris".to_owned()),
            "{columns:?}"
        );

        let cache: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='image_cache'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cache, 1);
    }

    /// The whole point of the step: 112 324 printings already on disk carry their image
    /// URIs only inside `raw`, and re-downloading 77 MB to recover something already
    /// stored would be absurd. The backfill reads them back out with `json_extract`.
    #[test]
    fn the_v2_step_backfills_image_uris_out_of_raw() {
        let conn = v1_database();
        insert_raw(
            &conn,
            "top",
            "Lightning Bolt",
            r#"{"object":"card","image_uris":{"small":"s.jpg","normal":"n.jpg","thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp","png":"p.png"}}"#,
        );
        insert_raw(
            &conn,
            "dfc",
            "Delver of Secrets",
            r#"{"object":"card","card_faces":[{"name":"Delver","image_uris":{"thumb":"f0t.webp","grid":"f0g.webp","display":"f0d.webp","art":"f0a.webp"}},{"name":"Aberration","image_uris":{"thumb":"f1t.webp","grid":"f1g.webp","display":"f1d.webp","art":"f1a.webp"}}]}"#,
        );
        insert_raw(&conn, "none", "No Art At All", r#"{"object":"card"}"#);

        migrate_single_file(&conn).unwrap();

        let top: String = conn
            .query_row("SELECT image_uris FROM cards WHERE id='top'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let top: serde_json::Value = serde_json::from_str(&top).unwrap();
        assert_eq!(top["grid"], "g.webp");
        assert_eq!(top["art"], "a.webp");
        // WEBP only: the deprecated JPG/PNG family is never stored.
        assert!(top.get("normal").is_none(), "{top}");
        assert!(top.get("png").is_none(), "{top}");

        let face: String = conn
            .query_row(
                "SELECT face_image_uris FROM cards WHERE id='dfc'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let face: serde_json::Value = serde_json::from_str(&face).unwrap();
        assert_eq!(face[0]["display"], "f0d.webp");
        assert_eq!(face[1]["display"], "f1d.webp");
        let top_of_dfc: Option<String> = conn
            .query_row("SELECT image_uris FROM cards WHERE id='dfc'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            top_of_dfc, None,
            "a transform has no top-level image object"
        );

        // The 162 printings with no images anywhere: both columns stay NULL, which is what
        // the placeholder path keys on.
        let (u, f): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT image_uris, face_image_uris FROM cards WHERE id='none'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((u, f), (None, None));
    }

    /// One rule, two implementations: `json_object`/`json_each` here in the v2 step, and
    /// `card_row::webp_uris` on the ingest path. Every row crosses from the first to the
    /// second the moment the user syncs, so a disagreement over so much as a null key
    /// would change a card's image object under a UI that had already read it. Same raw
    /// JSON through both, compared column by column.
    #[test]
    fn the_backfill_and_the_ingest_agree_on_every_image_shape() {
        // Field order is irrelevant to both readers, so these are trimmed to the keys
        // `CardRow` insists on plus whatever the case is about.
        let card = |id: &str, rest: &str| {
            format!(
                r#"{{"object":"card","id":"{id}","name":"{id}","lang":"en","layout":"normal","set":"tst","collector_number":"1"{rest}}}"#
            )
        };
        let all11 = r#"{"small":"s.jpg","normal":"n.jpg","large":"l.jpg","png":"p.png","art_crop":"ac.jpg","border_crop":"bc.jpg","thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp","crop":"c.webp"}"#;

        let cases: Vec<(&str, String)> = vec![
            // Top level only: eleven keys in, four out.
            ("top", card("top", &format!(r#","image_uris":{all11}"#))),
            // Per face only, front then back.
            (
                "dfc",
                card(
                    "dfc",
                    r#","card_faces":[{"name":"F0","image_uris":{"thumb":"0t.webp","grid":"0g.webp","display":"0d.webp","art":"0a.webp"}},{"name":"F1","image_uris":{"thumb":"1t.webp","grid":"1g.webp","display":"1d.webp","art":"1a.webp"}}]"#,
                ),
            ),
            // Two faces, one physical side: images at the top, none on the faces.
            (
                "split",
                card(
                    "split",
                    &format!(
                        r#","image_uris":{all11},"card_faces":[{{"name":"F0"}},{{"name":"F1"}}]"#
                    ),
                ),
            ),
            // One face imaged, one not — the null has to land at its own index.
            (
                "half",
                card(
                    "half",
                    r#","card_faces":[{"name":"F0"},{"name":"F1","image_uris":{"grid":"1g.webp"}}]"#,
                ),
            ),
            // Nothing anywhere: both columns NULL, which the placeholder path keys on.
            ("none", card("none", "")),
            // A faces array with nothing in it at all.
            ("empty", card("empty", r#","card_faces":[]"#)),
            // An image object carrying only the legacy family: four null keys, not NULL.
            (
                "legacy",
                card("legacy", r#","image_uris":{"small":"s.jpg","png":"p.png"}"#),
            ),
        ];

        let conn = v1_database();
        for (id, raw) in &cases {
            insert_raw(&conn, id, id, raw);
        }
        migrate_single_file(&conn).unwrap();

        // Compared as parsed JSON, not as bytes: SQLite emits the four keys in
        // `IMAGE_VARIANTS` order (`{"thumb":…,"grid":…,"display":…,"art":…}`) and
        // serde_json's map sorts them (`{"art":…,"display":…,"grid":…,"thumb":…}`), so
        // the two strings differ by key order while the objects — which is all a reader
        // of `json_extract` or `JSON.parse` ever sees — do not.
        let parse =
            |s: Option<String>| s.map(|s| serde_json::from_str::<serde_json::Value>(&s).unwrap());
        for (id, raw) in &cases {
            let row = crate::card_row::CardRow::from_json(&serde_json::from_str(raw).unwrap())
                .unwrap_or_else(|| panic!("{id} did not parse as a card"));
            let (top, face): (Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT image_uris, face_image_uris FROM cards WHERE id = ?1",
                    [*id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                parse(top),
                parse(row.image_uris),
                "image_uris disagree for `{id}`"
            );
            assert_eq!(
                parse(face),
                parse(row.face_image_uris),
                "face_image_uris disagree for `{id}`"
            );
        }
    }

    /// The same trap as the image columns, one version later. The v3 backfill coalesces
    /// `raw`'s `$.artist` with the `faces` *column*'s `$[0].artist`; `CardRow`'s `pick`
    /// does top level then front face at parse time. A database holds backfilled rows
    /// until its next sync and ingested rows after it, so a disagreement would change a
    /// card's credit line under a reader that had already seen it — and that credit line
    /// is what Scryfall's image policy requires wherever art is shown.
    #[test]
    fn the_artist_backfill_and_the_ingest_agree() {
        let card = |id: &str, rest: &str| {
            format!(
                r#"{{"object":"card","id":"{id}","name":"{id}","lang":"en","layout":"normal","set":"tst","collector_number":"1"{rest}}}"#
            )
        };
        let cases: Vec<(&str, String)> = vec![
            ("top", card("top", r#","artist":"Christopher Rush""#)),
            // What the fallback is for: a reversible card has no top-level artist at all.
            (
                "faces",
                card(
                    "faces",
                    r#","card_faces":[{"name":"F0","artist":"Nils Hamm"},{"name":"F1","artist":"Someone Else"}]"#,
                ),
            ),
            // Both present and deliberately different, so a fallback that fires anyway shows.
            (
                "both",
                card(
                    "both",
                    r#","artist":"Top Artist","card_faces":[{"name":"F0","artist":"Face Artist"}]"#,
                ),
            ),
            // Faces, but the front one is uncredited: the answer is absent, not face 1's.
            (
                "gap",
                card(
                    "gap",
                    r#","card_faces":[{"name":"F0"},{"name":"F1","artist":"Back Artist"}]"#,
                ),
            ),
            ("none", card("none", "")),
        ];

        let parse = |raw: &str| {
            crate::card_row::CardRow::from_json(&serde_json::from_str(raw).unwrap()).unwrap()
        };
        let conn = v1_database();
        for (id, raw) in &cases {
            // Exactly the columns a v1 ingest left behind — the verbatim line *and* the
            // faces blob, because the backfill reads `$[0].artist` out of that column and
            // not out of `raw`. A row inserted without it would pass while testing nothing.
            conn.execute(
                "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, faces, raw)
                 VALUES (?1, ?1, 'tst', '1', 'en', 'normal', ?2, ?3)",
                rusqlite::params![id, parse(raw).faces, raw],
            )
            .unwrap();
        }
        migrate_single_file(&conn).unwrap();

        for (id, raw) in &cases {
            let backfilled: Option<String> = conn
                .query_row("SELECT artist FROM cards WHERE id = ?1", [*id], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(backfilled, parse(raw).artist, "artist disagrees for `{id}`");
        }

        // Agreement on five NULLs would also pass, so pin the two branches that carry the
        // rule: the top level wins where both exist, and a face credit is found where it
        // is the only one.
        let artist = |id: &str| -> Option<String> {
            conn.query_row("SELECT artist FROM cards WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(artist("faces").as_deref(), Some("Nils Hamm"));
        assert_eq!(artist("both").as_deref(), Some("Top Artist"));
        assert_eq!(artist("gap"), None, "the front face is uncredited");
    }

    /// `cards_fts` is external-content with no triggers, so CLAUDE.md requires a rebuild
    /// after writes to `cards` outside the ingest. The v2 backfill writes only new,
    /// unindexed columns and renumbers no rowid, so it deliberately does not rebuild —
    /// and this is the evidence that the index is still intact afterwards.
    #[test]
    fn the_v2_backfill_leaves_the_search_index_answering() {
        let conn = v1_database();
        insert_raw(
            &conn,
            "bolt",
            "Lightning Bolt",
            r#"{"object":"card","image_uris":{"grid":"g.webp"}}"#,
        );
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        migrate_single_file(&conn).unwrap();

        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "the FTS index must survive the v2 backfill");
    }

    /// Staging derives its layout from the live table, so the columns a later migration
    /// adds have to survive a sync without anyone editing `create_staging`. This is that
    /// promise, checked against the columns this plan actually adds.
    #[test]
    fn the_image_columns_survive_a_staging_swap() {
        let conn = memory_pair();
        create_staging(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards_staging
                (id, name, set_code, collector_number, lang, layout, raw, image_uris)
             VALUES ('new','Lightning Bolt','lea','161','en','normal','{}','{\"grid\":\"g.webp\"}')",
            [],
        )
        .unwrap();
        swap_staging(&conn).unwrap();

        let uris: String = conn
            .query_row("SELECT image_uris FROM cards WHERE id='new'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(uris, "{\"grid\":\"g.webp\"}");
    }

    /// Carryover 2a: the artist gets a column of its own, backfilled out of the JSON that
    /// is already on disk. The face fallback is not decoration — a reversible card has no
    /// top-level artist at all, and the credit line Scryfall's image policy requires is
    /// rendered from this.
    #[test]
    fn the_v3_step_backfills_artist_out_of_raw_and_faces() {
        let conn = v1_database();
        insert_raw(
            &conn,
            "top",
            "Lightning Bolt",
            r#"{"object":"card","artist":"Christopher Rush"}"#,
        );
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, faces, raw)
             VALUES ('rev','Reversible','sld','1','en','reversible_card',
                json_array(json_object('name','Front','artist','Nils Hamm')), '{\"object\":\"card\"}')",
            [],
        )
        .unwrap();
        insert_raw(&conn, "none", "No Credit", r#"{"object":"card"}"#);

        migrate_single_file(&conn).unwrap();

        let artist = |id: &str| -> Option<String> {
            conn.query_row("SELECT artist FROM cards WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(artist("top").as_deref(), Some("Christopher Rush"));
        assert_eq!(
            artist("rev").as_deref(),
            Some("Nils Hamm"),
            "a reversible card's credit is on its front face"
        );
        assert_eq!(artist("none"), None, "absent is absent, not empty");

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
    }

    /// Same rule as v2: the step writes one new, unindexed column and renumbers no rowid,
    /// so it deliberately does not rebuild the FTS index — and this is the evidence that
    /// search still answers afterwards.
    #[test]
    fn the_v3_backfill_leaves_the_search_index_answering() {
        let conn = v1_database();
        insert_raw(
            &conn,
            "bolt",
            "Lightning Bolt",
            r#"{"object":"card","artist":"Christopher Rush"}"#,
        );
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        migrate_single_file(&conn).unwrap();

        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "the FTS index must survive the v3 backfill");
    }

    /// The backfill reads `raw` as JSON, and from the first post-v3 sync `raw` is a gzip
    /// BLOB that `json_extract` answers with a hard `malformed JSON` error rather than a
    /// NULL. No database can be in that state when this step runs (a database with gzip
    /// rows is already past 3), but the guard is what makes that a fact rather than an
    /// argument — and it costs one `json_valid`.
    ///
    /// The whole ladder is walked, not just v3: every later step that reads `raw` is on
    /// the same hook, and this is the only test that puts a real gzip member in the column
    /// — fixture databases hold text `raw`, so an unguarded read passes everything else and
    /// breaks only in the field. Reaching `LEGACY_SINGLE_FILE_VERSION` is therefore half the assertion.
    #[test]
    fn the_v3_backfill_steps_over_a_row_whose_raw_is_not_json() {
        let conn = v1_database();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES ('gz','Compressed','tst','1','en','normal', ?1)",
            [crate::card_row::gzip_raw(
                r#"{"object":"card","artist":"Rebecca Guay","power":"3","toughness":"3"}"#,
            )],
        )
        .unwrap();

        migrate_single_file(&conn).expect("a non-JSON `raw` must not fail the migration");

        let (artist, power, toughness): (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT artist, power, toughness FROM cards WHERE id='gz'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(artist, None, "skipped, not guessed at");
        assert_eq!((power, toughness), (None, None), "v5 reads `raw` too");

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            version, LEGACY_SINGLE_FILE_VERSION,
            "an unguarded read anywhere on the ladder stops the migration here"
        );
    }

    /// A column added by a migration has to survive the sync that drops and recreates the
    /// table it is on — which it does only because `create_staging` derives its layout from
    /// the live table *and* the ingest writes the column. The second half is the one that
    /// fails silently: staging would clone the column and every row would come back NULL.
    #[test]
    fn the_artist_column_survives_a_staging_swap() {
        let conn = memory_pair();
        create_staging(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards_staging
                (id, name, set_code, collector_number, lang, layout, raw, artist)
             VALUES ('new','Lightning Bolt','lea','161','en','normal','{}','Christopher Rush')",
            [],
        )
        .unwrap();
        swap_staging(&conn).unwrap();

        let artist: String = conn
            .query_row("SELECT artist FROM cards WHERE id='new'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(artist, "Christopher Rush");
    }

    /// A swap rebuilds the search index from scratch, so a rebuild an interrupted compaction
    /// was still owed has just been paid off by something else. Leaving the marker set would
    /// cost the next launch a silent rebuild of 116 k rows for work already done.
    #[test]
    fn a_swap_settles_a_rebuild_an_interrupted_compaction_owed() {
        let conn = memory_pair();
        crate::sync::set_meta(&conn, crate::maintenance::K_FTS_REBUILD_PENDING, "1").unwrap();
        create_staging(&conn).unwrap();
        conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('new','Lightning Bolt','lea','161','en','normal','{}')", []).unwrap();

        swap_staging(&conn).unwrap();

        assert!(
            !crate::maintenance::fts_rebuild_is_pending(&conn),
            "the swap rebuilt the index, so nothing is owed"
        );
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "and it is the swap's own index that answers");
    }

    /// `image_cache` is not sync data and must outlive the table that is dropped on every
    /// refresh — which is exactly why it carries no foreign key to `cards.id`.
    #[test]
    fn image_cache_rows_survive_the_swap_that_drops_cards() {
        let conn = memory_pair();
        conn.execute(
            "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
             VALUES ('bolt', 0, 'grid', 'https://cards.scryfall.io/grid/front/b/o/bolt.webp?17', 62000, 1800000000)",
            [],
        )
        .unwrap();

        create_staging(&conn).unwrap();
        conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('bolt','Lightning Bolt','2ed','162','en','normal','{}')", []).unwrap();
        swap_staging(&conn).expect("a sync must not be blocked by the image cache");

        let n: i64 = conn
            .query_row("SELECT count(*) FROM image_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    // ---- v5: the deck tables -------------------------------------------------------
    //
    // Five seed helpers, written once here because Task 3's reconciler tests need the
    // same fixture — a deck that owns cards and holds a claim on the collection — and a
    // second hand-rolled copy of it is a second thing to keep true. Plain INSERTs
    // returning ids: nothing clever, so a test that fails fails about its own subject.

    /// A `cards` row good enough to be pointed at. Not a foreign key anywhere — that is
    /// the point of most of the tests below — but the printing has to exist for the
    /// soft reference to be *resolving* before a swap drops it.
    pub(crate) fn seed_card(conn: &Connection, id: &str, set: &str, cn: &str) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout, raw)
             VALUES (?1, 'o-' || ?1, 'Lightning Bolt', ?2, ?3, 'en', 'normal', '{}')",
            rusqlite::params![id, set, cn],
        )
        .unwrap();
    }

    /// A deck, taking every default the table offers (`casual`, `card_art`, not built,
    /// not archived) so a change to one of them shows up somewhere.
    pub(crate) fn deck(conn: &Connection, name: &str) -> i64 {
        conn.query_row(
            "INSERT INTO decks (name, created_at, updated_at)
             VALUES (?1, unixepoch(), unixepoch()) RETURNING id",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One category of one deck — the v8 stand-in for what `deck_meta::
    /// ensure_predefined_categories` will create once Task 2 lands. `is_active` follows
    /// [`PREDEFINED_CATEGORIES`]'s own rule (`maybe` inactive, everything else active)
    /// rather than taking a parameter, because no test below has a reason to want otherwise
    /// yet — a caller that does can `UPDATE` the row it gets back the id of.
    pub(crate) fn category(conn: &Connection, deck_id: i64, kind: &str, name: &str) -> i64 {
        let is_active = i64::from(kind != "maybe");
        conn.query_row(
            "INSERT INTO deck_categories
                (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 0, unixepoch(), unixepoch()) RETURNING id",
            rusqlite::params![deck_id, name, kind, is_active],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One collection row, nonfoil NM, at the one grain these tests need.
    pub(crate) fn entry(conn: &Connection, card_id: &str, quantity: i64) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES (?1,'lea','161','en','nonfoil','NM',?2,unixepoch(),unixepoch())
             RETURNING id",
            rusqlite::params![card_id, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One printing in one category of one deck (the `live` variant, the only one these
    /// tests need), with the printing denormalised beside the soft `card_id` exactly as
    /// `deck.rs` will write it.
    pub(crate) fn deck_card(
        conn: &Connection,
        deck_id: i64,
        card_id: &str,
        category_id: i64,
        quantity: i64,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO deck_cards
                (deck_id,category_id,card_id,set_code,collector_number,lang,name,quantity,
                 created_at,updated_at)
             VALUES (?1,?2,?3,'lea','161','en','Lightning Bolt',?4,unixepoch(),unixepoch())
             RETURNING id",
            rusqlite::params![deck_id, category_id, card_id, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The enforced FKs a deck delete reaches, exercised at that delete site.
    /// `foreign_keys=ON`, as `db::open` sets it — these tests fail without the pragma, which
    /// is the point.
    ///
    /// **The two actions point opposite ways and that is the whole of what schema v25
    /// changed.** `deck_cards.deck_id` and `collection_folders.deck_id` CASCADE, because
    /// neither a deck's card list nor the folder that *stands for* it means anything once the
    /// deck is gone; `collection_entries.folder_id` SET NULLs, because the cards in that
    /// folder are the reader's property and surface at the root. Before v25 the second half of
    /// this test read `deck_allocations` and asserted that the collection row was untouched —
    /// a deck was a claim, never custody. It is custody now, so what has to survive is the
    /// *card* rather than the row's folder.
    #[test]
    fn deleting_a_deck_cascades_its_cards_and_its_group_but_never_the_cards_in_it() {
        let conn = memory_pair();
        seed_card(&conn, "bolt", "lea", "161");
        let deck = deck(&conn, "Burn");
        let main = category(&conn, deck, "main", "Main deck");
        deck_card(&conn, deck, "bolt", main, 4);
        // The four copies sit *in* the deck's group, which is what an allocation used to say
        // from outside.
        let group: i64 = conn
            .query_row(
                "INSERT INTO collection_folders
                     (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
                 VALUES (NULL, 'Burn', 'deck', ?1, 0, unixepoch(), unixepoch()) RETURNING id",
                [deck],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
                 created_at,updated_at)
             VALUES ('bolt','lea','161','en','nonfoil','NM',4,?1,unixepoch(),unixepoch())",
            [group],
        )
        .unwrap();

        conn.execute("DELETE FROM decks WHERE id = ?1", [deck])
            .unwrap();

        for (table, scope) in [
            ("deck_cards", "1"),
            // Scoped, because `migrate_single_file` has already made the one `removed` folder and that one
            // belongs to no deck — which is the point of the partial index it is under.
            ("collection_folders", "deck_id IS NOT NULL"),
        ] {
            let n: i64 = conn
                .query_row(
                    &format!("SELECT count(*) FROM {table} WHERE {scope}"),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 0, "{table} rows die with their deck");
        }
        // …and the cards themselves are untouched, at the root: deleting a deck may never
        // delete a card the reader physically owns.
        let (q, filed): (i64, Option<i64>) = conn
            .query_row(
                "SELECT quantity, folder_id FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((q, filed), (4, None));
    }

    /// `collection::remove_entry`'s site, which is a *user-initiated* delete and the one the
    /// SET NULL above is not for. The row goes; the deck card stays, because the deck still
    /// wants the card and is simply missing it now, which is availability's conclusion rather
    /// than something the schema decides.
    ///
    /// **It read `deck_allocations` until v25** — a claim on copies that are gone was a lie,
    /// and the CASCADE swept it. There is no claim any more, so what this pins is the absence
    /// of any reach from the collection into the decks at all.
    #[test]
    fn removing_a_collection_entry_leaves_the_deck_wanting_the_card() {
        let conn = memory_pair();
        seed_card(&conn, "bolt", "lea", "161");
        let deck = deck(&conn, "Burn");
        let entry = entry(&conn, "bolt", 4);
        let main = category(&conn, deck, "main", "Main deck");
        deck_card(&conn, deck, "bolt", main, 4);

        conn.execute("DELETE FROM collection_entries WHERE id = ?1", [entry])
            .unwrap();

        let (cards, wanted): (i64, i64) = conn
            .query_row(
                "SELECT count(*), coalesce(sum(quantity), 0) FROM deck_cards",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (cards, wanted),
            (1, 4),
            "the deck still wants the card — it is missing it, which is not the same thing"
        );
        // The deck itself is nobody's child here: only its own delete takes it.
        let decks: i64 = conn
            .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(decks, 1);
    }

    /// `user_rows_survive_the_swap_that_drops_cards`, grown to the deck tables. Both
    /// references to a card here — `deck_cards.card_id` and `decks.cover_card_id` — are
    /// soft, and a declared `REFERENCES cards(id)` on either would abort this swap (or,
    /// with CASCADE, quietly delete the user's decks on the next refresh).
    #[test]
    fn deck_rows_survive_the_swap_that_drops_cards() {
        let conn = memory_pair();
        seed_card(&conn, "bolt", "lea", "161");
        let deck = deck(&conn, "Burn");
        // The cover art is a printing too, and it is the other soft reference.
        conn.execute(
            "UPDATE decks SET cover_card_id = 'bolt' WHERE id = ?1",
            [deck],
        )
        .unwrap();
        entry(&conn, "bolt", 4);
        let main = category(&conn, deck, "main", "Main deck");
        deck_card(&conn, deck, "bolt", main, 4);

        create_staging(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards_staging (id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('bolt','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        swap_staging(&conn).expect("a sync must not be blocked by the user's decks");

        for table in ["decks", "deck_cards", "collection_entries"] {
            let n: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "`{table}` is not sync data");
        }
        let cover: Option<String> = conn
            .query_row("SELECT cover_card_id FROM decks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cover.as_deref(), Some("bolt"), "the cover keeps its card");
        // The denormalised printing is the one the user put in the deck, not whatever the
        // new `cards` row says — that is the whole reason it is stored beside the id.
        let (card_id, set, cn, name, qty): (String, String, String, String, i64) = conn
            .query_row(
                "SELECT card_id, set_code, collector_number, name, quantity FROM deck_cards",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(
            (
                card_id.as_str(),
                set.as_str(),
                cn.as_str(),
                name.as_str(),
                qty
            ),
            ("bolt", "lea", "161", "Lightning Bolt", 4),
            "a deck list that cannot name its own cards is not a list"
        );
    }

    /// The grain is what a category or variant write upserts against, so it has to fold —
    /// and the quantity CHECK is enforced where it cannot be argued with. `category_id` is
    /// in the grain for exactly `zone`'s old reason: the same printing filed under Main and
    /// under the Maybeboard is two different intentions, not one row with two homes.
    /// `variant` is new in v8 and in the grain again for the same shape of reason — the
    /// same printing can sit in the Live deck and the Theory one at once, and an edit tried
    /// out in Theory must never fold into the Live row it is being tried against.
    ///
    /// The enum-walking half of this test's predecessor —
    /// `the_deck_card_grain_folds_and_the_zone_and_quantity_checks_hold`, which proved
    /// `DECK_ZONES` against the live CHECK — moved to
    /// `a_category_kind_is_one_of_the_five_and_predefined_names_round_trip` below: the CHECK
    /// it walks now lives on `deck_categories.kind`, not on `deck_cards` at all.
    #[test]
    fn the_deck_card_grain_folds_and_the_quantity_check_holds() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        seed_card(&conn, "bolt", "lea", "161");
        let d = deck(&conn, "Burn");
        let main = category(&conn, d, "main", "Main deck");
        let maybe = category(&conn, d, "maybe", "Maybeboard");

        let add = |category_id: i64, variant: &str, qty: i64| {
            conn.execute(
                &format!(
                    "INSERT INTO deck_cards
                        (deck_id,category_id,variant,card_id,set_code,collector_number,lang,
                         name,quantity,created_at,updated_at)
                     VALUES (?1,?2,?3,'bolt','lea','161','en','Lightning Bolt',?4,
                             unixepoch(),unixepoch())
                     ON CONFLICT ({DECK_CARD_GRAIN}) DO UPDATE
                        SET quantity = quantity + excluded.quantity"
                ),
                rusqlite::params![d, category_id, variant, qty],
            )
        };
        add(main, "live", 2).unwrap();
        add(main, "live", 3).expect("a second add must fold into the first, not raise");
        add(maybe, "live", 1)
            .expect("`category_id` is in the grain: the Maybeboard is a different row");
        add(main, "theory", 1)
            .expect("`variant` is in the grain: Theory is a different row from Live");

        let (rows, main_qty): (i64, i64) = conn
            .query_row(
                "SELECT count(*), (SELECT quantity FROM deck_cards
                                    WHERE category_id = ?1 AND variant = 'live')
                 FROM deck_cards",
                [main],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, main_qty), (3, 5));

        // Zero and negative are refused by the same shape of CHECK the collection and
        // wishlist share: a deck slot at zero holds nothing worth keeping, so it never
        // reaches the database as a stored row — `deck.rs` owns that translation into a
        // delete, and a non-positive quantity that reaches SQL anyway is a bug.
        for qty in [0, -1] {
            let err =
                add(main, "live", qty).expect_err(&format!("quantity {qty} must not be storable"));
            assert!(
                matches!(&err, rusqlite::Error::SqliteFailure(e, _)
                         if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_CHECK),
                "quantity {qty} was rejected, but not by a CHECK: {err}"
            );
        }
    }

    // ---- v8: categories replace the zone --------------------------------------------

    /// `zone` is gone from `deck_cards` entirely, `category_id` is `NOT NULL`, and the two
    /// columns the wider grain needs (`variant`, `tag_id`) exist. This is the shape check;
    /// `the_v8_step_carries_a_v6_deck_across_into_categories` is the behaviour it enables.
    #[test]
    fn the_v8_step_replaces_the_zone_with_a_category() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        migrate_single_file(&conn).unwrap();

        // `zone` is gone from the table entirely, and `category_id` is NOT NULL.
        let cols: Vec<(String, i64)> = conn
            .prepare("SELECT name, \"notnull\" FROM pragma_table_info('deck_cards')")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            !cols.iter().any(|(n, _)| n == "zone"),
            "zone survived the rebuild"
        );
        assert_eq!(cols.iter().find(|(n, _)| n == "category_id").unwrap().1, 1);
        assert!(cols.iter().any(|(n, _)| n == "variant"));
        assert!(cols.iter().any(|(n, _)| n == "tag_id"));
    }

    /// The gap the second `deck_categories` insert in the v8 step closes: a deck that
    /// predates categories and has never held a card — no `deck_cards` row in any zone —
    /// is invisible to the first insert, which is driven entirely off `deck_cards`.
    /// Without the second pass this deck would come out of `migrate_single_file` owning zero
    /// categories, exactly as every deck made between v8 shipping and
    /// `deck_meta::ensure_predefined_categories` landing would have, not only the ones a
    /// human would call "legacy". Built on [`v6_deck_database`] the way
    /// [`the_v8_step_carries_a_v6_deck_across_into_categories`] is, minus every
    /// `deck_cards` row.
    #[test]
    fn the_v8_step_seeds_predefined_categories_for_a_deck_with_no_cards() {
        let conn = v6_deck_database();
        conn.execute(
            "INSERT INTO decks (name, created_at, updated_at)
             VALUES ('Empty', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let deck_id = conn.last_insert_rowid();

        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_single_file(&conn).unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT kind, name, is_active FROM deck_categories
                  WHERE deck_id = ?1 ORDER BY kind",
            )
            .unwrap();
        let rows: Vec<(String, String, bool)> = stmt
            .query_map([deck_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("commander".to_owned(), "Commander".to_owned(), true),
                ("companion".to_owned(), "Companion".to_owned(), true),
                ("maybe".to_owned(), "Maybeboard".to_owned(), false),
                ("side".to_owned(), "Sideboard".to_owned(), true),
            ],
            "an empty legacy deck must come out of the migration owning its four \
             predefined categories, `main` excluded — nothing named it, so nothing seeds it"
        );
    }

    /// A database that stopped at version 6 — decks and their cards in the pre-category
    /// shape, which is what every machine that has synced since Plan 4 has on disk today.
    /// Built by hand rather than by calling [`migrate_single_file`] and rewinding `PRAGMA user_version`
    /// backward: rewinding the pragma would still leave `deck_cards` in its *v8* shape,
    /// which is exactly the state this fixture must not be in — `migrate_single_file` never runs a step
    /// twice, so a v8-shaped table with `user_version` forced back to 6 would hit the `if
    /// v < 8` block over a table it does not match and fail in a way no real upgrade ever
    /// could.
    ///
    /// The two tables the v8 step actually reads or writes are built in the v5 shape,
    /// unchanged through v6 (the only thing v6 added was `app_meta`, which this step never
    /// touches): `decks` and `deck_cards`. Alongside them, in reduced but real shape:
    /// `collection_entries` and `deck_allocations`.
    ///
    /// **Neither is touched by the v8 step, and neither proves anything about the
    /// `DROP TABLE deck_cards` / rebuild sequence itself** — `deck_allocations` references
    /// `decks(id)` and `collection_entries(id)`, and the v8 step only does an additive
    /// `ALTER TABLE decks ADD COLUMN` (renumbers nothing) and never touches
    /// `collection_entries` at all, so that chain is causally disconnected from the rebuild
    /// by construction. What they *are* here for: proving the whole migration still
    /// completes under `foreign_keys=ON` — the pragma `db::open` always runs with, and which
    /// no test with real deck rows had exercised before this one — and proving a user's
    /// pre-existing allocation is still there and still resolves once the migration is over,
    /// rather than quietly cleared. What proves the rebuild leaves no dangling reference is
    /// `foreign_keys=ON` itself — every FK here is checked immediately, so a bad
    /// `category_id` fails the migration outright rather than committing (measured in the
    /// test below) — with `PRAGMA foreign_key_check` afterwards as a whole-database sweep
    /// for whatever that immediate check cannot see: a dangling reference this transaction's
    /// own writes never touch.
    ///
    /// **`cards` is here for the v10 step, which also runs.** [`migrate_single_file`] reads
    /// `user_version` once and then walks *every* step above it, so a database that says 6
    /// runs v7, the v8 rebuild, v9's error log and v10 alike — and v10's body is
    /// `ALTER TABLE cards … / UPDATE cards … / DROP INDEX idx_cards_collapse`, a hard error
    /// against a database with no `cards` table. **v20 needs it for the same reason**: it is
    /// where the [`CARDS_INDEXES`] replay lives now, so it is the step that puts the widened
    /// collapse index back and creates every other index over `cards`. (v7 used to be the
    /// step that needed it; it has no statements of its own any more, because the replay
    /// moved up to v10 and then on to v20 — always to the newest step that touches `cards`,
    /// which is the only version at which every column the list names exists. The requirement
    /// moved with it, it did not go away.)
    ///
    /// It is built from [`CARDS_COLUMNS`], which is frozen to exactly the v1 shape and so is
    /// exactly what a v6 database has, and it carries the three indexes v1 created and *not*
    /// the fourth: not having `idx_cards_collapse` yet is precisely what makes this a pre-v7
    /// database, which is what
    /// [`a_database_from_before_the_collapse_index_gains_it_and_a_rerun_is_a_no_op`] reads it
    /// as. Those three are spelled out as literals rather than interpolated from
    /// [`CARDS_INDEXES`] for that constant's own reason — this fixture is a description of
    /// history, and a later addition to the list must not silently rewrite what a v6
    /// database had. That the *finished* database carries all four, widened, is
    /// `every_version_ends_with_the_same_schema_as_a_fresh_install`'s to assert.
    ///
    /// `migrate_single_file`'s `if v < 7`, `if v < 8`, `if v < 9` and `if v < 10` branches are the only
    /// four that can run once `user_version` already says 6, so nothing earlier is needed —
    /// the same reasoning `v1_database` uses further down the ladder.
    fn v6_deck_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE cards ({CARDS_COLUMNS});
             -- The five columns v2, v3 and v5 added to `cards`, replayed as literals
             -- because `migrate_single_file` will not: it reads `user_version` once, sees 6, and skips
             -- every step below v7 — so a fixture that stopped at the frozen v1 shape would
             -- be a v1 `cards` wearing a v6 label, and would reach head missing five
             -- columns a real v6 database has had since long before it. That is precisely
             -- what `every_version_ends_with_the_same_schema_as_a_fresh_install` catches,
             -- and it caught this. Literals for the same reason the three indexes below
             -- are: this fixture describes history, and history does not change when a
             -- later step adds a sixth.
             ALTER TABLE cards ADD COLUMN image_uris TEXT;
             ALTER TABLE cards ADD COLUMN face_image_uris TEXT;
             ALTER TABLE cards ADD COLUMN artist TEXT;
             ALTER TABLE cards ADD COLUMN power TEXT;
             ALTER TABLE cards ADD COLUMN toughness TEXT;
             CREATE INDEX idx_cards_oracle ON cards(oracle_id);
             CREATE INDEX idx_cards_set_cn ON cards(set_code, collector_number);
             CREATE INDEX idx_cards_name ON cards(name);"
        ))
        .unwrap();
        conn.execute_batch(
            "CREATE TABLE decks (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                format_key TEXT NOT NULL DEFAULT 'casual',
                description TEXT,
                cover_kind TEXT NOT NULL DEFAULT 'card_art'
                    CHECK (cover_kind IN ('card_art','custom')),
                cover_card_id TEXT,
                cover_image_path TEXT,
                is_built INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE TABLE deck_cards (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                card_id TEXT NOT NULL,
                set_code TEXT NOT NULL,
                collector_number TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'en',
                name TEXT NOT NULL,
                zone TEXT NOT NULL
                    CHECK (zone IN ('main','side','commander','companion','maybe')),
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX idx_deck_cards_grain ON deck_cards (deck_id, card_id, zone);
             CREATE INDEX idx_deck_cards_card ON deck_cards (card_id);

             -- **No longer reduced at all, and the third telling of one lesson.** It began as
             -- the columns an allocation and its target need; the six grain columns were added
             -- when v24 widened `idx_collection_grain` over them; and **v25's conversion reads
             -- the row in full** — it carries every provenance column onto the placement it
             -- splits off, so a fixture missing one reaches head with
             -- `no such column: condition_original`, which no real upgrade can produce. The
             -- shape below is therefore v1's `CREATE TABLE` verbatim, which is exactly what a
             -- real v6 database has. The FK and its CASCADE are the real v4/v5 DDL verbatim,
             -- because those are what this fixture exists to put under load.
             --
             -- Literals, because this fixture describes history: these are v1's columns, the
             -- eleventh grain term is v24's to add, and nothing here may be interpolated from
             -- `COLLECTION_GRAIN`.
             CREATE TABLE collection_entries (
                id INTEGER PRIMARY KEY,
                card_id TEXT NOT NULL,
                set_code TEXT NOT NULL,
                collector_number TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'en',
                finish TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')),
                condition TEXT NOT NULL DEFAULT 'NM'
                    CHECK (condition IN ('NM','LP','MP','HP','DMG')),
                condition_original TEXT,
                quantity INTEGER NOT NULL CHECK (quantity >= 0),
                tradelist_quantity INTEGER NOT NULL DEFAULT 0
                    CHECK (tradelist_quantity >= 0),
                purchase_price REAL,
                purchase_currency TEXT,
                acquired_at TEXT,
                acquisition_source TEXT,
                serial_number TEXT,
                altered INTEGER NOT NULL DEFAULT 0,
                signed INTEGER NOT NULL DEFAULT 0,
                proxy INTEGER NOT NULL DEFAULT 0,
                misprint INTEGER NOT NULL DEFAULT 0,
                grading TEXT CHECK (grading IS NULL OR json_valid(grading)),
                tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
                notes TEXT,
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE TABLE deck_allocations (
                id INTEGER PRIMARY KEY,
                deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                collection_entry_id INTEGER NOT NULL
                    REFERENCES collection_entries(id) ON DELETE CASCADE,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );

             -- v6's own table, and the same lesson one version up: **v25 deletes the
             -- `deck_driven_collection` row from it**, so a fixture without it reaches head
             -- with `no such table: app_meta`. v6 is the step that *creates* it, which is
             -- exactly why a database labelled 6 has to have it already.
             CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

             -- v5's own table, and it is here for the reason the five `cards` columns above
             -- are: a real v6 database went through v5 and has it, `migrate_single_file` reads
             -- `user_version` once and skips every step below v7, and **a step above this
             -- rung now writes to it** — v18 alters `format_specs` and re-seeds it. Without
             -- this the fixture is a pre-v5 database wearing a v6 label, and it reaches head
             -- with `no such table: format_specs`, which no real upgrade can produce. The DDL
             -- is a literal because this fixture describes history.
             CREATE TABLE format_specs (
                key TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                enabled_in_picker INTEGER NOT NULL DEFAULT 1,
                deck_min INTEGER NOT NULL,
                deck_max INTEGER,
                max_copies INTEGER,
                sideboard_max INTEGER,
                singleton INTEGER NOT NULL DEFAULT 0,
                requires_commander INTEGER NOT NULL DEFAULT 0,
                commander_rule TEXT,
                life INTEGER NOT NULL,
                restricted_semantic TEXT NOT NULL DEFAULT 'max_one'
                    CHECK (restricted_semantic IN ('max_one','banned_as_commander')),
                has_legality_data INTEGER NOT NULL DEFAULT 1,
                max_mana_value INTEGER,
                allows_companion INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL
             );

             -- v4's own table, here for exactly the reason `format_specs` above is, and it
             -- cost the same lesson: a real v6 database went through v4 and has a wishlist,
             -- `migrate_single_file` reads `user_version` once and skips every step below v7, and **a
             -- step above this rung now writes to it** — v23 adds `folder_id` and rebuilds
             -- the grain index. Without this the fixture is a pre-v4 database wearing a v6
             -- label, and it reaches head with `no such table: wishlist_entries`, which no
             -- real upgrade can produce. The DDL and the three indexes are literals because
             -- this fixture describes history: the grain here is v4's three terms, and the
             -- fourth is v23's to add.
             CREATE TABLE wishlist_entries (
                id INTEGER PRIMARY KEY,
                oracle_id TEXT,
                card_id TEXT,
                set_code TEXT,
                collector_number TEXT,
                lang TEXT,
                name TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
                preferred_finish TEXT
                    CHECK (preferred_finish IS NULL
                           OR preferred_finish IN ('nonfoil','foil','etched')),
                notes TEXT,
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                CHECK (oracle_id IS NOT NULL OR card_id IS NOT NULL)
             );
             CREATE UNIQUE INDEX idx_wishlist_grain
                ON wishlist_entries (coalesce(oracle_id, ''), coalesce(card_id, ''),
                                     coalesce(preferred_finish, ''));
             CREATE INDEX idx_wishlist_card ON wishlist_entries (card_id);
             CREATE INDEX idx_wishlist_oracle ON wishlist_entries (oracle_id);

             PRAGMA user_version = 6;",
        )
        .unwrap();
        // The rows v5 wrote, through the frozen constant rather than a copy of it — that one
        // *is* the v5 statement and cannot change, which is the whole point of the split.
        conn.execute_batch(FORMAT_SPECS_SEED_V5).unwrap();
        conn
    }

    /// The test that fails in the field and nowhere else if the backfill is wrong: a real
    /// v6 deck, one card in each of the five legacy zones, migrated forward under
    /// `foreign_keys=ON` — as every real launch runs it, `db::open` always sets it. This is
    /// what the test actually demonstrates: the migration completes with foreign keys
    /// enforced (which, measured by temporarily breaking the rebuild's `SELECT`, is already
    /// what would refuse a dangling `category_id` — `migrate_single_file` itself fails outright rather
    /// than committing one, before `PRAGMA foreign_key_check` below ever runs); every card
    /// keeps its quantity and its own `deck_cards.id` (which `deck_allocations` may
    /// separately be holding) and lands in a category whose `kind` is the zone it came from —
    /// which is the assertion that would catch the backfill's JOIN resolving to a *valid but
    /// wrong* category, the one failure mode neither FK enforcement nor `foreign_key_check`
    /// can see, since the reference still resolves; with the Maybeboard alone coming out
    /// `is_active = 0`; no reference anywhere in the whole database is left dangling, on any
    /// table, including ones this test does not otherwise touch (`foreign_key_check`'s own
    /// job once `migrate_single_file` has returned); and a pre-existing `deck_allocations` reservation is
    /// still there and still resolves afterwards — proving the migration does not quietly
    /// clear a user's claims, not that the rebuild "cannot" disturb them, since that FK chain
    /// does not run through `deck_cards` at all.
    ///
    /// **Two decks, because the backfill's JOIN has two terms.** It is
    /// `ON cat.deck_id = dc.deck_id AND cat.kind = dc.zone`, and a one-deck fixture exercises
    /// only the second: with a single deck there is exactly one category of each kind, so
    /// dropping `cat.deck_id` changes nothing and the deck-scoping half of the JOIN goes
    /// unchecked entirely. Measured with two decks: dropping that term matches each card
    /// against *both* decks' category of its kind, and since the rebuild copies `dc.id`
    /// verbatim, `migrate_single_file` dies at "UNIQUE constraint failed: deck_cards_v8.id" — a hard
    /// failure where there had been none at all. The per-card `cat.deck_id` assertion below is
    /// the direct statement of the same rule, and is what would catch a future backfill that
    /// picked one wrong category rather than two.
    #[test]
    fn the_v8_step_carries_a_v6_deck_across_into_categories() {
        let conn = v6_deck_database();
        let deck = |name: &str| {
            conn.execute(
                "INSERT INTO decks (name, created_at, updated_at)
                 VALUES (?1, unixepoch(), unixepoch())",
                rusqlite::params![name],
            )
            .unwrap();
            conn.last_insert_rowid()
        };
        let deck_id = deck("Burn");
        let other_id = deck("Angels");

        let zones = ["main", "side", "commander", "companion", "maybe"];
        let mut ids = Vec::new();
        for zone in zones {
            // The same five zones in both decks, with different printings so each row can be
            // found on its own afterwards.
            for (owner, prefix) in [(deck_id, "bolt"), (other_id, "serra")] {
                conn.execute(
                    "INSERT INTO deck_cards
                        (deck_id,card_id,set_code,collector_number,lang,name,zone,quantity,
                         created_at,updated_at)
                     VALUES (?1,?2,'lea','161','en','Lightning Bolt',?3,3,unixepoch(),unixepoch())",
                    rusqlite::params![owner, format!("{prefix}-{zone}"), zone],
                )
                .unwrap();
                ids.push((
                    owner,
                    zone,
                    format!("{prefix}-{zone}"),
                    conn.last_insert_rowid(),
                ));
            }
        }

        // A live reservation the migration must not quietly clear: four copies owned, all
        // four claimed by this deck. Its own FK chain (`deck_allocations` → `decks` and
        // `collection_entries`) does not run through `deck_cards`, so this proves the
        // migration leaves a user's existing claims alone — not that the rebuild "cannot"
        // touch them, which `PRAGMA foreign_key_check` below is what actually shows.
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,tags,
                 created_at,updated_at)
             VALUES ('bolt-main','lea','161','en','nonfoil','NM',4,'[]',
                     unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        let entry_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO deck_allocations
                (deck_id, collection_entry_id, quantity, created_at, updated_at)
             VALUES (?1, ?2, 4, unixepoch(), unixepoch())",
            rusqlite::params![deck_id, entry_id],
        )
        .unwrap();

        // The pragma every real launch runs under (`db::open`). Set before `migrate_single_file`, not
        // inside it: `PRAGMA foreign_keys` is a no-op mid-transaction, and `migrate_single_file` opens
        // its own.
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_single_file(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);

        // A whole-database dangling-reference sweep, for less than it first looks like it
        // buys. Measured directly (temporarily changing the v8 rebuild's `SELECT`
        // to `cat.id + 100000` and running this test): a *dangling* `category_id` never
        // reaches this line at all — `migrate_single_file(&conn).unwrap()` above already panics on
        // "FOREIGN KEY constraint failed", because every FK here is checked immediately
        // under `foreign_keys=ON`, and `INSERT INTO deck_cards_v8 … SELECT` fails outright
        // rather than committing a bad row. So this assertion is not what would catch that
        // bug; the pragma being on before `migrate_single_file` runs already is. What this line still
        // covers, and `migrate_single_file(&conn).unwrap()` does not: a dangling reference on a row this
        // transaction's own DML never touches — pre-existing corruption, or a future step
        // that writes through a path this one does not — on any FK, on any table, not only
        // the five cards this test names. (A *valid but wrong* reference — the backfill's
        // JOIN landing a row in the right kind of category but the wrong deck — is a
        // different failure mode again, one no dangling-reference check can see; that is
        // what the per-card `kind` assertion below is for.)
        let violations: Vec<String> = conn
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            violations.is_empty(),
            "the rebuild must leave no dangling foreign key anywhere in the database: {violations:?}"
        );

        // **The claim seeded above arrives at head as a placement, and this is the longest
        // route on the ladder to that conversion** — nineteen rungs, over a `decks` table and
        // a `collection_entries` table built by hand rather than by [`migrate_single_file`]. It read the
        // allocation back off `deck_allocations` until v25 dropped that table; what it asks
        // now is the same question one level up: the user's four claimed copies are still four
        // copies, and they are in this deck's group.
        let (placed, group_deck): (i64, i64) = conn
            .query_row(
                "SELECT ce.quantity, f.deck_id
                   FROM collection_entries ce
                   JOIN collection_folders f ON f.id = ce.folder_id
                   JOIN decks d ON d.id = f.deck_id
                  WHERE f.deck_id = ?1",
                [deck_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or_else(|e| {
                panic!("the pre-existing allocation must arrive as a placement: {e}")
            });
        assert_eq!(
            (placed, group_deck),
            (4, deck_id),
            "the migration must not quietly clear a user's existing claim"
        );
        let loose: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE folder_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            loose, 0,
            "every copy was claimed, so nothing stays at the root"
        );

        for (owner, zone, card_id, id) in ids {
            let (owning_deck, kind, is_active, quantity, row_id): (i64, String, i64, i64, i64) =
                conn.query_row(
                    "SELECT cat.deck_id, cat.kind, cat.is_active, dc.quantity, dc.id
                       FROM deck_cards dc JOIN deck_categories cat ON cat.id = dc.category_id
                      WHERE dc.card_id = ?1",
                    [&card_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap_or_else(|e| panic!("no migrated row for `{card_id}`: {e}"));
            assert_eq!(
                owning_deck, owner,
                "`{card_id}` must land in a category of **its own** deck"
            );
            assert_eq!(
                kind, zone,
                "the `{zone}` card must land in a category of the matching kind"
            );
            assert_eq!(quantity, 3, "`{zone}`'s quantity must survive the rebuild");
            assert_eq!(
                row_id, id,
                "`{zone}`'s `deck_cards.id` must survive the rebuild"
            );
            let want_active = i64::from(zone != "maybe");
            assert_eq!(
                is_active, want_active,
                "`{zone}`'s category `is_active` must be {want_active}"
            );
        }
    }

    /// The twin of `the_v2_backfill_leaves_the_search_index_answering` and its v3/v5
    /// siblings, one step further down the ladder: v8 touches only the deck tables, never
    /// `cards`, so it owes `cards_fts` no rebuild — and this is what proves that claim
    /// rather than assuming it. Run from `v1_database` so the whole ladder is walked, v8
    /// included, exactly as the v3 gzip-guard test does one step up.
    #[test]
    fn the_v8_step_leaves_the_search_index_answering() {
        let conn = v1_database();
        insert_raw(&conn, "bolt", "Lightning Bolt", r#"{"object":"card"}"#);
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        migrate_single_file(&conn).unwrap();

        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "the FTS index must survive the v8 step");
    }

    /// Walks [`CATEGORY_KINDS`] against the live CHECK on `deck_categories.kind`, the way
    /// `the_deck_card_grain_folds_and_the_zone_and_quantity_checks_hold` used to walk
    /// `DECK_ZONES` against `deck_cards`' own — so the constant and the CHECK cannot drift
    /// apart unnoticed. [`PREDEFINED_CATEGORIES`]'s `(kind, name, is_active)` triples are
    /// what `deck_meta::ensure_predefined_categories` will insert verbatim, so round-tripping
    /// them here is the proof that every one is a legal row before any Rust code depends on
    /// that being true.
    #[test]
    fn a_category_kind_is_one_of_the_five_and_predefined_names_round_trip() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let d = deck(&conn, "Burn");

        let insert_kind = |kind: &str| {
            conn.execute(
                "INSERT INTO deck_categories
                    (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?2, 1, 0, unixepoch(), unixepoch())",
                rusqlite::params![d, kind],
            )
        };
        for kind in CATEGORY_KINDS {
            insert_kind(kind).unwrap_or_else(|e| panic!("`{kind}` must be a legal kind, but: {e}"));
        }
        let err = insert_kind("sideboard").expect_err("`sideboard` is not a kind the CHECK knows");
        assert!(
            matches!(&err, rusqlite::Error::SqliteFailure(e, _)
                     if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_CHECK),
            "`sideboard` was rejected, but not by a CHECK: {err}"
        );

        // `PREDEFINED_CATEGORIES` round-trips: every non-`main` kind, inserted the way
        // `deck_meta::ensure_predefined_categories` will insert it, reads back with the
        // same name and active flag it was seeded with — on a fresh deck, so the rows
        // above (all `is_active = 1`, all named after their own kind) cannot be mistaken
        // for these.
        let d2 = deck(&conn, "Predefined");
        for (kind, name, active) in PREDEFINED_CATEGORIES {
            conn.execute(
                "INSERT INTO deck_categories
                    (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, unixepoch(), unixepoch())",
                rusqlite::params![d2, name, kind, i64::from(active)],
            )
            .unwrap_or_else(|e| panic!("PREDEFINED_CATEGORIES `{kind}` must insert, but: {e}"));
            let (read_name, read_active): (String, i64) = conn
                .query_row(
                    "SELECT name, is_active FROM deck_categories
                      WHERE deck_id = ?1 AND kind = ?2",
                    rusqlite::params![d2, kind],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(read_name, name, "`{kind}` must round-trip its name");
            assert_eq!(
                read_active,
                i64::from(active),
                "`{kind}` must round-trip its active flag"
            );
        }
        assert_eq!(
            PREDEFINED_CATEGORIES.len(),
            CATEGORY_KINDS.len() - 1,
            "every kind except `main` is predefined"
        );
    }

    /// Every table that CHECKs a finish accepts exactly [`FINISHES`] and nothing else.
    ///
    /// Three tables spell the list out in their own DDL — frozen, like every migration step —
    /// so this is what holds the constant and the three literals together. It is
    /// `a_category_kind_is_one_of_the_five_and_predefined_names_round_trip`'s shape, over the
    /// one vocabulary that had no such test until 2026-08-16.
    #[test]
    fn a_finish_is_one_of_the_three_on_every_table_that_checks_it() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();

        let is_check_failure = |err: &rusqlite::Error| {
            matches!(err, rusqlite::Error::SqliteFailure(e, _)
                     if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_CHECK)
        };

        // `collection_entries.finish` — NOT NULL, so all three and nothing else.
        let owned = |finish: &str| {
            conn.execute(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     created_at,updated_at)
                 VALUES (?1,'lea','161','en',?2,'NM',1,unixepoch(),unixepoch())",
                rusqlite::params![format!("owned-{finish}"), finish],
            )
        };
        for finish in FINISHES {
            owned(finish).unwrap_or_else(|e| panic!("`{finish}` must be a legal finish, but: {e}"));
        }
        let err = owned("gilded").expect_err("`gilded` is not a finish the CHECK knows");
        assert!(
            is_check_failure(&err),
            "`gilded` was refused, but not by a CHECK: {err}"
        );

        // `wishlist_entries.preferred_finish` — nullable, so all three *plus* NULL.
        let wished = |finish: Option<&str>| {
            conn.execute(
                "INSERT INTO wishlist_entries
                    (oracle_id,name,quantity,preferred_finish,created_at,updated_at)
                 VALUES (?1,'Black Lotus',1,?2,unixepoch(),unixepoch())",
                rusqlite::params![format!("wish-{}", finish.unwrap_or("any")), finish],
            )
        };
        for finish in FINISHES {
            wished(Some(finish)).unwrap_or_else(|e| {
                panic!("`{finish}` must be a legal preferred finish, but: {e}")
            });
        }
        wished(None).expect("a wish naming no finish is legal — it is filled by any");
        let err = wished(Some("gilded")).expect_err("`gilded` is not a finish the CHECK knows");
        assert!(
            is_check_failure(&err),
            "`gilded` was refused, but not by a CHECK: {err}"
        );

        // `marketplace_prices.finish` — NOT NULL, one row per (marketplace, card, finish).
        let priced = |finish: &str| {
            conn.execute(
                "INSERT INTO marketplace_prices (marketplace,card_id,finish,price)
                 VALUES ('cardkingdom','bolt',?1,1.0)",
                rusqlite::params![finish],
            )
        };
        for finish in FINISHES {
            priced(finish)
                .unwrap_or_else(|e| panic!("`{finish}` must be a priceable finish, but: {e}"));
        }
        let err = priced("gilded").expect_err("`gilded` is not a finish the CHECK knows");
        assert!(
            is_check_failure(&err),
            "`gilded` was refused, but not by a CHECK: {err}"
        );
    }

    /// The seed is the research doc's format table as data, and the engine reads rules
    /// from it rather than embodying them — so a wrong cell here is a wrong rule
    /// everywhere, with nothing else in the app to contradict it.
    #[test]
    fn format_specs_is_seeded_with_all_25_formats_and_the_load_bearing_cells() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM format_specs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 25, "23 legality keys + casual + limited");

        // Scryfall's 23 legality keys in the order it emits them (research doc), then the
        // two pseudo-formats. `sort_order` is what the format picker reads, so the list
        // and its order are one assertion.
        let mut stmt = conn
            .prepare("SELECT key FROM format_specs ORDER BY sort_order")
            .unwrap();
        let keys: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            keys,
            [
                "standard",
                "future",
                "historic",
                "timeless",
                "gladiator",
                "pioneer",
                "modern",
                "legacy",
                "pauper",
                "vintage",
                "penny",
                "commander",
                "oathbreaker",
                "standardbrawl",
                "brawl",
                "competitivebrawl",
                "alchemy",
                "paupercommander",
                "duel",
                "oldschool",
                "premodern",
                "predh",
                "tlr",
                "casual",
                "limited",
            ]
        );

        // The twelve cells the engine actually branches on, read as text so that NULL
        // stays visible: NULL is a *rule* here (no maximum, unlimited copies, an uncapped
        // sideboard), never a missing value, and a 0 that should be a NULL is a different
        // format. Order: deck_min, deck_max, max_copies, sideboard_max, singleton,
        // requires_commander, commander_rule, life, restricted_semantic, has_legality_data,
        // max_mana_value, allows_companion.
        const CELLS: &str = "CAST(deck_min AS TEXT), CAST(deck_max AS TEXT),
             CAST(max_copies AS TEXT), CAST(sideboard_max AS TEXT), CAST(singleton AS TEXT),
             CAST(requires_commander AS TEXT), commander_rule, CAST(life AS TEXT),
             restricted_semantic, CAST(has_legality_data AS TEXT),
             CAST(max_mana_value AS TEXT), CAST(allows_companion AS TEXT)";
        let cells = |key: &str| -> Vec<Option<String>> {
            conn.query_row(
                &format!("SELECT {CELLS} FROM format_specs WHERE key = ?1"),
                [key],
                |r| (0..12).map(|i| r.get(i)).collect(),
            )
            .unwrap_or_else(|e| panic!("no format_specs row for `{key}`: {e}"))
        };
        let want = |v: [&str; 12]| -> Vec<Option<String>> {
            v.iter()
                .map(|s| (*s != "NULL").then(|| (*s).to_owned()))
                .collect()
        };

        // Exactly 100 including the commander, singleton, no sideboard — and a companion
        // all the same, "effectively a 101st card", which is why `allows_companion` is its
        // own fact and not `sideboard_max > 0`.
        assert_eq!(
            cells("commander"),
            want(["100", "100", "1", "0", "1", "1", "edh", "40", "max_one", "1", "NULL", "1"])
        );
        // 60 *minimum* (deck_max NULL, CR 100.5 — no maximum), four copies, 15 sideboard.
        assert_eq!(
            cells("vintage"),
            want(["60", "NULL", "4", "15", "0", "0", "NULL", "20", "max_one", "1", "NULL", "1"])
        );
        // TRAP A, the other half: `restricted` in a singleton format cannot mean "max 1".
        assert_eq!(
            cells("duel")[8].as_deref(),
            Some("banned_as_commander"),
            "TRAP A: what `restricted` means is per format, never inferred from the key"
        );
        // Exactly 50, a 10-card sideboard, every card *and every face* at MV <= 3.
        assert_eq!(
            cells("tlr"),
            want([
                "50",
                "50",
                "1",
                "10",
                "1",
                "1",
                "tlr",
                "20",
                "banned_as_commander",
                "1",
                "3",
                "1"
            ])
        );
        // 99 commons plus an uncommon commander, at 30 life. TRAP C's rule is `pdh`.
        assert_eq!(cells("paupercommander")[7].as_deref(), Some("30"));
        assert_eq!(cells("paupercommander")[6].as_deref(), Some("pdh"));
        // No sideboard at all, so no companion — the one format where the two coincide.
        assert_eq!(
            cells("gladiator")[11].as_deref(),
            Some("0"),
            "no sideboard means no companion"
        );
        // The two pseudo-formats: no legality data, no pool, no copy limit.
        assert_eq!(
            cells("limited"),
            want([
                "40", "NULL", "NULL", "NULL", "0", "0", "NULL", "20", "max_one", "0", "NULL", "1"
            ])
        );
        assert_eq!(
            cells("casual")[9].as_deref(),
            Some("0"),
            "checks no legality"
        );
        assert_eq!(cells("casual")[0].as_deref(), Some("0"), "and no size");

        // Future Standard is a real legality key and not a format anyone plays.
        let hidden: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT key FROM format_specs WHERE enabled_in_picker = 0")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(hidden, ["future"]);

        // NEVER derive one format from another: two Brawls that differ only in deck size,
        // and a third at 100 like the first. Each is seeded, none is computed.
        for (key, size) in [
            ("brawl", "100"),
            ("standardbrawl", "60"),
            ("competitivebrawl", "100"),
        ] {
            let row = cells(key);
            assert_eq!(
                (row[0].as_deref(), row[1].as_deref(), row[7].as_deref()),
                (Some(size), Some(size), Some("25")),
                "{key} is its own row"
            );
        }
    }

    /// Carryover of the v3 `artist` playbook, one version on: CR 903.3 asks whether a
    /// Vehicle or Spacecraft has a P/T *box*, and nothing else in the database can answer
    /// it — `faces` is NULL on every single-faced card, and `raw` is a gzip BLOB nothing
    /// reads at runtime. So the two columns are filled out of the JSON already on disk,
    /// with the same top-level-then-front-face fallback the artist uses.
    #[test]
    fn the_v5_backfill_fills_power_and_toughness_from_raw_and_faces() {
        let conn = v1_database();
        insert_raw(
            &conn,
            "creature",
            "Grizzly Bears",
            r#"{"object":"card","power":"3","toughness":"3"}"#,
        );
        // A transform carries no top-level P/T at all: the front face has them, and the
        // `faces` column is where a v1 ingest put that array verbatim.
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, faces, raw)
             VALUES ('dfc','Delver of Secrets','isd','51','en','transform',
                json_array(json_object('name','Delver of Secrets','power','1','toughness','1'),
                           json_object('name','Insectile Aberration','power','3','toughness','2')),
                '{\"object\":\"card\"}')",
            [],
        )
        .unwrap();
        insert_raw(&conn, "land", "Forest", r#"{"object":"card"}"#);

        migrate_single_file(&conn).unwrap();

        let pt = |id: &str| -> (Option<String>, Option<String>) {
            conn.query_row(
                "SELECT power, toughness FROM cards WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(pt("creature"), (Some("3".into()), Some("3".into())));
        assert_eq!(
            pt("dfc"),
            (Some("1".into()), Some("1".into())),
            "a transform's P/T live on its front face, not at the top level"
        );
        assert_eq!(pt("land"), (None, None), "no box is not a zero");
    }

    /// Same rule as v2 and v3: the step writes two new, unindexed columns and renumbers no
    /// rowid, so it deliberately does not rebuild the FTS index — and this is the evidence
    /// that search still answers afterwards.
    #[test]
    fn the_v5_backfill_leaves_the_search_index_answering() {
        let conn = v1_database();
        insert_raw(
            &conn,
            "bolt",
            "Lightning Bolt",
            r#"{"object":"card","power":"3","toughness":"3"}"#,
        );
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        migrate_single_file(&conn).unwrap();

        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "the FTS index must survive the v5 backfill");
    }

    // ---- v10: `legal_mask` and the widened collapse index ---------------------------

    /// Undo schema v12 over a head database: the three `decks` columns, and nothing else.
    ///
    /// **Every rewound fixture below head owes this, not just the one testing v12.** `migrate_single_file`
    /// reads `user_version` once and then walks *every* step above it, so a database that says
    /// 9 runs v10, v11 **and** v12 — and v12's `ALTER TABLE decks ADD COLUMN` over a table that
    /// already carries the column is a `duplicate column name` error no real upgrade could
    /// ever produce. A fixture that claims a version has to look like that version all the way
    /// up, which is the same rule [`v9_database`]'s own doc states for v10's two statements.
    ///
    /// Three `DROP COLUMN`s are the whole of it because three `ADD COLUMN`s were the whole of
    /// the step: no index names them, no constraint references them, and SQLite refuses a drop
    /// only where one does. That is what makes the rewind honest here, where a rewind through
    /// v8's table rebuild would not be.
    const UNDO_V12: &str = "ALTER TABLE decks DROP COLUMN last_variant;
         ALTER TABLE decks DROP COLUMN last_group_by;
         ALTER TABLE decks DROP COLUMN last_sort_by;";

    /// The same, for v13's one column — and the reason it is a *second* constant rather than
    /// three more lines in [`UNDO_V12`] is the reason v13 is a second rung: the two steps were
    /// written the same day on two branches and only one of them may be undone by a fixture
    /// claiming version 12. A single `UNDO` covering both would make [`v12_database`] drop
    /// columns its own version created.
    ///
    /// **Every fixture below head owes this one too**, exactly as they owe [`UNDO_V12`]. The
    /// rule is worth stating in the general form, because the next step to join the ladder did
    /// owe a third ([`UNDO_V14`]): a step whose DDL is **not idempotent** — `ALTER TABLE … ADD
    /// COLUMN`, which answers `duplicate column name`, unlike v11's and v14's `CREATE TABLE IF
    /// NOT EXISTS` — must come back out of every rewound fixture beneath it, because `migrate_single_file`
    /// reads `user_version` once and then replays *every* step above what it read. An
    /// **idempotent** step owes it for the quieter reason [`UNDO_V14`] states: not to keep the
    /// fixture migrating, but to keep it honest about which version it is.
    const UNDO_V13: &str = "ALTER TABLE decks DROP COLUMN separate_x_group;";

    /// And the third rung of the same day: v14's five oracle-tag tables, dropped.
    ///
    /// **This one is owed for a different reason than the two above it, and the difference is
    /// worth knowing.** v12's and v13's DDL is `ALTER TABLE … ADD COLUMN`, which answers
    /// `duplicate column name` — a fixture that forgot them could not migrate at all. v14's is
    /// `CREATE TABLE IF NOT EXISTS`, so a fixture that forgot this one would migrate perfectly
    /// happily and simply not be the version it claims: a "v11 database" carrying five tables
    /// that did not exist until v14, quietly answering questions about a schema nobody has.
    /// That is why the fixtures below assert the absence rather than trusting the rewind, and
    /// why the five names are written out here once instead of at each call site.
    ///
    /// All five, because [`ORACLE_TAG_TABLES_SQL`] creates all five: four data tables and the
    /// watermark. No index names them and no foreign key references them — the whole schema is
    /// deliberately soft-keyed — so nothing has to come down first.
    const UNDO_V14: &str = "DROP TABLE oracle_tags;
         DROP TABLE oracle_tag_parents;
         DROP TABLE oracle_taggings;
         DROP TABLE oracle_tag_cards;
         DROP TABLE oracle_tag_meta;";

    /// And v15's one column on `deck_categories`: who made the pile.
    ///
    /// Owed for [`UNDO_V12`]'s and [`UNDO_V13`]'s reason rather than [`UNDO_V14`]'s — the DDL
    /// is `ALTER TABLE … ADD COLUMN`, so a fixture that forgot this one could not migrate at
    /// all: the step would answer `duplicate column name` over a table already carrying the
    /// column, a failure no real upgrade can produce.
    ///
    /// One `DROP COLUMN` is the whole of it. No index names `deck_categories.origin` — the two
    /// on that table are the `(deck_id, name)` grain and the partial `(deck_id, kind)` — and no
    /// constraint references it, which is what SQLite refuses a drop over and what makes this
    /// rewind honest. **The backfill needs no undoing**: it only ever wrote to this column, and
    /// the column is what goes.
    const UNDO_V15: &str = "ALTER TABLE deck_categories DROP COLUMN origin;";

    /// And v16's one column on `decks`: which pile an unfiled add lands in.
    ///
    /// Owed for [`UNDO_V13`]'s reason — `ALTER TABLE … ADD COLUMN` again, so a fixture that
    /// forgot it could not migrate at all — and undone the same way. No index names
    /// `decks.default_category_id` and **no foreign key does either**, which is the one thing
    /// worth noting here: the column holds a sentinel (`0` is Auto) rather than a nullable
    /// reference, precisely so that [`crate::deck::DeckPatch`]'s `coalesce` convention can
    /// express "back to Auto", and a rewind therefore has nothing to take down first.
    const UNDO_V16: &str = "ALTER TABLE decks DROP COLUMN default_category_id;";

    /// And v17's undo journal.
    ///
    /// Owed for [`UNDO_V14`]'s **quieter** reason rather than [`UNDO_V13`]'s: the DDL is
    /// `CREATE TABLE IF NOT EXISTS`, so a fixture that forgot this one would still migrate
    /// cleanly — it would simply be a database claiming to be v16 while carrying v17's table,
    /// which is a fixture that has stopped describing the version it is named for. That is why
    /// the fixtures below assert the absence rather than trusting the rewind.
    ///
    /// One `DROP TABLE` takes the index with it. Nothing has to come down first: `deck_undo`'s
    /// two foreign keys point *outward*, at `deck_audit` and `decks`, and nothing anywhere
    /// references `deck_undo`.
    const UNDO_V17: &str = "DROP TABLE deck_undo;";

    /// And v18's two columns: which platforms a format is playable on, and which one a deck is
    /// for.
    ///
    /// Owed for [`UNDO_V13`]'s reason — `ALTER TABLE … ADD COLUMN` twice, so a fixture that
    /// forgot this one could not migrate at all — and undone the same way. No index names
    /// either column and no constraint references one, which is what SQLite refuses a drop
    /// over.
    ///
    /// **The re-seed needs no undoing, and that is a fact about the two seeds rather than
    /// luck.** v18 re-runs [`FORMAT_SPECS_SEED`], which is [`FORMAT_SPECS_SEED_V5`] plus the
    /// column being dropped here — every other cell is byte-identical, so once `games` is gone
    /// the rows are indistinguishable from the ones v5 wrote.
    /// `the_head_format_seed_agrees_with_v5_on_every_shared_cell` is what keeps that true.
    const UNDO_V18: &str = "ALTER TABLE format_specs DROP COLUMN games;
         ALTER TABLE decks DROP COLUMN game_key;";

    /// And v19's finish column on `deck_cards` — **three statements, because the column is in
    /// an index**.
    ///
    /// Owed for [`UNDO_V13`]'s reason: the DDL is `ALTER TABLE … ADD COLUMN`, so a fixture
    /// that forgot it could not migrate at all — v19 would answer `duplicate column name` over
    /// a table already carrying the column, a failure no real upgrade can produce.
    ///
    /// **This is the first rewind on this ladder that has to take an index down first, and it
    /// is exactly the trap [`UNDO_V12`]'s doc names as the reason a rewind through v8 would be
    /// dishonest.** SQLite refuses `DROP COLUMN` on a column any index references, and
    /// `finish` is the fifth term of `idx_deck_cards_grain`. So: drop the index, drop the
    /// column, and **put the v18-era index back** — the four-column one, spelled out as a
    /// literal rather than built from [`DECK_CARD_GRAIN`], because what this restores is what
    /// v8 built and the constant now describes head.
    const UNDO_V19: &str = "DROP INDEX idx_deck_cards_grain;
         ALTER TABLE deck_cards DROP COLUMN finish;
         CREATE UNIQUE INDEX idx_deck_cards_grain
            ON deck_cards (deck_id, variant, category_id, card_id);";

    /// And v20's art tags, mute list, two columns on `oracle_tags`, and the illustration
    /// index.
    ///
    /// Owed for [`UNDO_V13`]'s reason — two `ALTER TABLE … ADD COLUMN`s, so a fixture that
    /// forgot this one could not migrate at all — and for [`UNDO_V14`]'s quieter one as well,
    /// since the six `CREATE TABLE IF NOT EXISTS`es beside them would leave a fixture claiming
    /// a version it is not.
    ///
    /// **This is the first undo that has to run *before* the ones numbered below it**, and it
    /// is why every fixture spells it first rather than last. [`UNDO_V14`] drops `oracle_tags`
    /// outright; a v20 undo that ran after it would `ALTER` a table that is no longer there.
    /// Newest-first is the order every rewind always meant — the ascending lists below worked
    /// only because no rung had ever touched a table a lower rung deletes.
    ///
    /// Three indexes come down by hand and two ride along. `idx_oracle_tags_norm` names
    /// `slug_norm`, and SQLite refuses `DROP COLUMN` on a column an index references — the trap
    /// [`UNDO_V19`] documents one table over. `idx_cards_illustration` and
    /// `idx_oracle_tag_cards_slug` are dropped for [`UNDO_V14`]'s quieter reason: `IF NOT
    /// EXISTS` means a fixture that kept one would migrate perfectly happily while claiming a
    /// version that never had it. **Which index needs a line is decided by whether this fixture
    /// drops its table**, not by which rung created it — the two art indexes need none because
    /// `DROP TABLE art_tags` and `DROP TABLE art_tag_illustrations` take their own indexes with
    /// them, while `oracle_tag_cards` survives to be dropped by [`UNDO_V14`] and so leaves its
    /// index standing.
    const UNDO_V20: &str = "DROP INDEX idx_oracle_tags_norm;
         ALTER TABLE oracle_tags DROP COLUMN slug_norm;
         ALTER TABLE oracle_tags DROP COLUMN id;
         DROP INDEX idx_cards_illustration;
         DROP INDEX idx_oracle_tag_cards_slug;
         DROP TABLE art_tags;
         DROP TABLE art_tag_parents;
         DROP TABLE art_taggings;
         DROP TABLE art_tag_illustrations;
         DROP TABLE art_tag_meta;
         DROP TABLE muted_tags;";

    /// And v21's app-wide tag list, back to the per-deck one v8 built.
    ///
    /// **The rewind is a rebuild rather than a column swap**, because the shape changed both
    /// ways: `deck_id` came off and `name_key` went on, and `ALTER TABLE … DROP COLUMN` refuses
    /// a column named by an index in any case. Dropping the table takes
    /// `idx_deck_tags_grain` with it — [`UNDO_V20`]'s rule about which index needs a line of
    /// its own, applied here.
    ///
    /// **It restores the shape and not the rows, and nothing needs it to.** Every fixture is
    /// `migrate_single_file`d into an empty in-memory database and rewound before anything is seeded, so
    /// there has never been a tag in one at this moment. A rewind that tried to invent a
    /// `deck_id` for a row that has none would be inventing the very fact v21 deleted.
    ///
    /// **It runs first, with [`UNDO_V20`]**, for that constant's stated reason: newest-first is
    /// the order every rewind always meant.
    const UNDO_V21: &str = "DROP TABLE deck_tags;
         CREATE TABLE deck_tags (
            id INTEGER PRIMARY KEY,
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE UNIQUE INDEX idx_deck_tags_grain ON deck_tags (deck_id, name);";

    /// And v23's wishlist folders. **There is no `UNDO_V22`** — see [`v21_database`] for why
    /// that rung is the one on this ladder that owes no rewind — so this one lands beside
    /// [`UNDO_V21`] and every chain below spells the two of them together.
    ///
    /// Owed for [`UNDO_V14`]'s **quieter** reason rather than [`UNDO_V13`]'s. Every statement
    /// v23 writes is idempotent by construction — `CREATE TABLE IF NOT EXISTS`, a
    /// `DROP INDEX IF EXISTS` before its `CREATE`, and an `ALTER TABLE … ADD COLUMN` the step
    /// probes `pragma_table_info` for rather than issuing blind — so a fixture that forgot
    /// this one would migrate perfectly happily and simply not be the version it claims: a
    /// "v11 database" carrying a table and a column that did not exist until v23.
    ///
    /// **It is deliberately not a full rewind, and "deliberately" is the word that matters
    /// here.** `wishlist_entries.folder_id` stays, and not because SQLite will not take it
    /// back: it does refuse `DROP COLUMN` on a column an index names, and two name this one,
    /// but dropping `idx_wishlist_grain` and `idx_wishlist_folder` first makes the
    /// `DROP COLUMN` succeed — measured 2026-08-22, and
    /// [`migrating_a_v22_wishlist_files_every_existing_wish_at_the_root`] now runs exactly that
    /// sequence. The reason is the statement after it: putting the three-term index back means
    /// rebuilding a *unique* index over a narrower grain than the rows beneath it were written
    /// on, which the moment two of them differ only by folder is a constraint failure inside
    /// somebody else's fixture. A rewind is a helper for the fixtures below it and may not
    /// carry that. So they carry the column instead, and the v23 step's probe finds it and
    /// skips the `ALTER`.
    ///
    /// `idx_wishlist_grain` needs no line of its own: v23's own `DROP INDEX IF EXISTS` is what
    /// widens it, and it runs again over whatever the rewind left. `idx_wishlist_folder` does,
    /// for [`UNDO_V20`]'s rule about which index needs one — `wishlist_entries` survives this
    /// rewind, so an index over it that nothing drops would outlive the version that made it.
    const UNDO_V23: &str = "DROP TABLE IF EXISTS wishlist_folders;
         DROP INDEX IF EXISTS idx_wishlist_folder;";

    /// And v24's collection folders — [`UNDO_V23`] one table over, and owed for the same
    /// **quieter** reason: every statement v24 writes is idempotent by construction, so a
    /// fixture that forgot this one would migrate perfectly happily and simply not be the
    /// version it claims — a "v11 database" carrying a table and a column that did not exist
    /// until v24.
    ///
    /// **It stops short of `collection_entries.folder_id` for [`UNDO_V23`]'s reason**, and not
    /// because SQLite forbids it: dropping `idx_collection_grain` and `idx_collection_folder`
    /// first would make the `DROP COLUMN` succeed. What a shared rewind may not do is the
    /// statement after that — putting the ten-column index back means building a *narrower*
    /// unique index over rows written on the wide grain, which is a constraint failure the
    /// moment two of them differ only by folder, inside somebody else's fixture. So every
    /// fixture beneath head re-enters the v24 step carrying the column, and the step's
    /// `pragma_table_info` probe is what makes that survivable.
    ///
    /// `idx_collection_grain` needs no line of its own: v24's own `DROP INDEX IF EXISTS` is
    /// what widens it, and it runs again over whatever the rewind left. `idx_collection_folder`
    /// does, for [`UNDO_V20`]'s rule about which index needs one — `collection_entries`
    /// survives this rewind, so an index over it that nothing drops would outlive the version
    /// that made it.
    ///
    /// **A fixture that goes on to *write* to `collection_entries` before migrating needs the
    /// full rewind [`schema_at_23`] pays, not this.** Foreign keys are ON for every connection
    /// in this crate — `libsqlite3-sys` builds the amalgamation with
    /// `SQLITE_DEFAULT_FOREIGN_KEYS=1` — so a surviving column whose `REFERENCES` names a table
    /// this took away answers `no such table: main.collection_folders` at the next insert. No
    /// fixture sharing this constant writes there today; the one that does is the one that
    /// drops the column first.
    ///
    /// **It runs first, before [`UNDO_V23`]**, for that constant's stated reason: newest-first.
    const UNDO_V24: &str = "DROP TABLE IF EXISTS collection_folders;
         DROP INDEX IF EXISTS idx_collection_folder;";

    /// And v25's deck groups. **The first rewind on this ladder that has to put a table
    /// *back***, because v25 is the first rung that takes one away.
    ///
    /// Owed for [`UNDO_V13`]'s **loud** reason rather than [`UNDO_V14`]'s quiet one, and that
    /// is what makes it unskippable: `DROP TABLE deck_allocations` and
    /// `ALTER TABLE decks DROP COLUMN is_built` are not idempotent in either direction, so a
    /// fixture that walked to head and then forgot this line does not merely mislabel itself —
    /// it dies at `no such table: main.deck_allocations` on the way back up.
    ///
    /// The DDL is the v8 table verbatim, because that is what a v24 database has and this is a
    /// description of history. `IF NOT EXISTS` throughout for the reason every rewind carries
    /// it: a chain is spelled once per fixture, but the fixture below it may have got there by
    /// another route.
    ///
    /// **The `ALTER` is the one statement that cannot be guarded**, and it is why this constant
    /// is only ever spelled after a full [`migrate_single_file`]: `ADD COLUMN` has no `IF NOT EXISTS` and
    /// always appends, so `is_built` comes back at the *end* of `decks`. v25 drops it again on
    /// the way up, which is what keeps
    /// [`every_version_ends_with_the_same_schema_as_a_fresh_install`] comparing two tables that
    /// have both lost it — a rewind that left the column standing would fail that test on
    /// ordinals.
    ///
    /// **The `app_meta` row is restored rather than merely tolerated**, and it is the only
    /// place in the crate that writes it: the deck-driven switch that owned it is gone, so
    /// without this line the rung's `DELETE` would run over an empty table in every test and
    /// the assertion that it goes would be decoration.
    ///
    /// The two folder rows are *deleted* rather than created, this being the only half of a
    /// rewind that looks the usual way round. `collection_entries.folder_id` is
    /// `ON DELETE SET NULL`, so any copies the conversion filed surface at the root again —
    /// which is a rewind for a fixture with no rows and nothing more; a fixture that wants the
    /// *quantities* back as well would have to un-split them, and none does.
    ///
    /// **It runs first, before [`UNDO_V24`]**, for that constant's stated reason: newest-first.
    /// Here the order is load-bearing rather than tidy — the `DELETE` names a table
    /// [`UNDO_V24`] drops.
    const UNDO_V25: &str = "DELETE FROM collection_folders WHERE kind IN ('deck', 'removed');
         CREATE TABLE IF NOT EXISTS deck_allocations (
            id INTEGER PRIMARY KEY,
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            collection_entry_id INTEGER NOT NULL
                REFERENCES collection_entries(id) ON DELETE CASCADE,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_allocations_grain
            ON deck_allocations (deck_id, collection_entry_id);
         CREATE INDEX IF NOT EXISTS idx_deck_allocations_entry
            ON deck_allocations (collection_entry_id);
         ALTER TABLE decks ADD COLUMN is_built INTEGER NOT NULL DEFAULT 0;
         INSERT OR REPLACE INTO app_meta (key, value)
            VALUES ('deck_driven_collection', '1');";

    /// And v26's bracket column and its three combo tables.
    ///
    /// Owed for [`UNDO_V13`]'s **loud** reason: `ALTER TABLE decks ADD COLUMN bracket` is not
    /// idempotent, so a fixture that forgot this line does not merely mislabel itself — it dies
    /// at `duplicate column name` on the way back up, a failure no real upgrade can produce.
    /// The three `DROP TABLE`s are owed for [`UNDO_V14`]'s quieter one as well, the rung's own
    /// DDL being `CREATE TABLE IF NOT EXISTS` throughout: a fixture that kept them would migrate
    /// perfectly happily while claiming a version that never had them.
    ///
    /// **One `DROP COLUMN` is the whole of the deck half.** No index names `decks.bracket` and
    /// no constraint references it — it is a sentinel in a `NOT NULL` column rather than a
    /// nullable foreign key, [`UNDO_V16`]'s situation exactly — so this rewind has nothing to
    /// take down first, where [`UNDO_V19`]'s and [`UNDO_V24`]'s do.
    ///
    /// **The two indexes need no line of their own**, [`UNDO_V20`]'s rule about which one does:
    /// `DROP TABLE combo_cards` takes `idx_combo_cards_combo` and `idx_combo_cards_oracle` with
    /// it, because the table they are on is the table that goes.
    ///
    /// **Child before parent**, `swap_combo_staging`'s reason: with foreign keys on a
    /// `DROP TABLE` is an implicit `DELETE`, and dropping `combos` while `combo_cards` still
    /// references it walks every row through the cascade first. No fixture on this ladder has
    /// a row in either, so this is a rule stated where it can be read rather than a cost being
    /// avoided.
    ///
    /// **It runs first, before [`UNDO_V25`]**, for that constant's stated reason: newest-first
    /// is the order every rewind always meant.
    const UNDO_V26: &str = "ALTER TABLE decks DROP COLUMN bracket;
         DROP TABLE IF EXISTS combo_cards;
         DROP TABLE IF EXISTS combos;
         DROP TABLE IF EXISTS combo_meta;";

    /// A database that stopped at version 9 — the version below the step that *widens*
    /// `idx_cards_collapse`, which is the property this fixture exists for.
    ///
    /// **It was the last version below the [`CARDS_INDEXES`] replay until v20 took that
    /// replay over**, and it kept its number rather than following it: what only a pre-v10
    /// database can show is a *narrow* collapse index being replaced, and that is a fact about
    /// version 9 and no other. [`v19_database`] is the last version below the replay now.
    ///
    /// **The version it names is not this branch's to choose.** It was `v8_database` while the
    /// `legal_mask` step was v9; main's own v9 (the error log) pushed that step to v10 and this
    /// fixture to 9. It is no longer head minus one — v11 (the marketplace price tables) sits
    /// above v10 — and it is deliberately *not* renumbered with the ladder, because what it is
    /// for is the one thing only a pre-v10 database can prove: that a machine entering the
    /// ladder *below* the `CARDS_INDEXES` replay ends up with every index a fresh install has.
    /// [`v10_database`] is what carries the "one step below head" claim now.
    ///
    /// [`v1_database`]'s trick cannot reach v9: only version 1's DDL is frozen, and every
    /// version after it is an `ALTER` (or, at v8, a whole table rebuild) inside a step there
    /// is no way back through. So this walks to head and undoes exactly what the v10 step
    /// did — nothing more. `error_log`, which v9 creates, is therefore still standing, which
    /// is exactly right: this is a v9 database, and a v9 database has it.
    ///
    /// **It rewinds to 9 and not one step further, and that is the trap
    /// [`v6_deck_database`] exists for.** `migrate_single_file` reads `user_version` once and then walks
    /// *every* step above it, so a rewind to 7 over a head-shaped database would re-run v8's
    /// deck rebuild against tables already in their v8 shape and die on a duplicate column —
    /// a failure no real upgrade can produce. Undoing v10's two statements is the whole of
    /// what this fixture may claim, which is why it is named for the version it leaves
    /// behind rather than for the one step it is testing.
    ///
    /// The index goes **before** the column: SQLite refuses to drop a column that an index
    /// names, and the widened `idx_cards_collapse` names this one. The narrow definition
    /// that goes back is a literal, not [`CARDS_INDEXES`]'s entry — this is a description of
    /// history, and history does not change when the list does.
    ///
    /// [`UNDO_V12`], [`UNDO_V13`] and [`UNDO_V14`] ride along for their own reason: a v9
    /// database runs every step above 9, and those three added columns and tables this head
    /// database already has.
    fn v9_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "DROP INDEX idx_cards_collapse;
             ALTER TABLE cards DROP COLUMN legal_mask;
             CREATE INDEX idx_cards_collapse
                 ON cards(oracle_id, is_paper, released_at, id, name, price_usd);
             {UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20}
             {UNDO_V12}
             {UNDO_V13}
             {UNDO_V14}
             {UNDO_V15}
             {UNDO_V16}
             {UNDO_V17}
             {UNDO_V18}
             {UNDO_V19}
             PRAGMA user_version = 9;",
        ))
        .unwrap();
        conn
    }

    /// [`v9_database`] must really be **at** version 9, and the renumber is what makes this
    /// worth asserting rather than assuming.
    ///
    /// The fixture is a head database with the v10 step undone, so every way it can be wrong
    /// leaves it looking like head — and a head-shaped "v9" would sail through
    /// [`every_version_ends_with_the_same_schema_as_a_fresh_install`] **vacuously**, because
    /// `migrate_single_file` would have nothing to do and the comparison would be a fresh install against
    /// itself. The literal `9` is the point: this fixture is pinned to the version below the
    /// [`CARDS_INDEXES`] replay, not to head minus one, and the two came apart when v11 landed.
    ///
    /// Its three claims are the three things the v10 step goes on to change: the version, the
    /// column, and the *narrow* index definition.
    #[test]
    fn the_pre_index_replay_fixture_really_sits_at_version_nine() {
        let conn = v9_database();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 9, "below the step that replays `CARDS_INDEXES`");

        assert!(
            !card_columns(&conn).contains(&"legal_mask".to_owned()),
            "the v10 column must not be there yet"
        );

        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='idx_cards_collapse'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            !sql.contains("legal_mask"),
            "the collapse index must still be narrow: {sql}"
        );

        // And v9's own table is standing, because this *is* a v9 database — the rewind undoes
        // our step and nothing main landed below it.
        let has_error_log: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='error_log'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_error_log, 1, "a v9 database has `error_log`");

        // And v14's five are not, which no other assertion here would catch: their DDL is
        // `CREATE TABLE IF NOT EXISTS`, so a fixture that kept them would migrate to head
        // without complaint and simply not be a v9 database.
        assert_eq!(
            oracle_tag_table_count(&conn),
            0,
            "the oracle-tag tables are five rungs above this one"
        );
    }

    /// The mask every row on disk gets without waiting for a sync. `legalities` is a plain
    /// TEXT column, so this backfill needs no [`json_raw`] guard — and the row is seeded
    /// with a **gzip `raw`** anyway, because a step that reached for `raw` by mistake would
    /// then fail here rather than in the field, where `json_extract` over a gzip member is a
    /// hard `malformed JSON` error and not the NULL one might expect.
    #[test]
    fn the_v10_backfill_fills_legal_mask_and_leaves_gzip_raw_alone() {
        let conn = v9_database();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,legalities,is_paper,raw)
             VALUES ('1','Black Lotus','lea','232','en','normal',
                     '{\"vintage\":\"restricted\",\"modern\":\"not_legal\"}',1,?1)",
            [crate::card_row::gzip_raw("{}")],
        )
        .unwrap();

        migrate_single_file(&conn).expect("a gzip `raw` must not fail the v10 step");

        let mask: i64 = conn
            .query_row("SELECT legal_mask FROM cards WHERE id='1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let vintage = crate::legalities::bit("vintage").unwrap() as i64;
        let modern = crate::legalities::bit("modern").unwrap() as i64;
        assert_ne!(mask & vintage, 0, "restricted is playable");
        assert_eq!(mask & modern, 0);

        // And the column the step must not have touched is still the bytes it was handed.
        let stored: Vec<u8> = conn
            .query_row(
                "SELECT CAST(raw AS BLOB) FROM cards WHERE id='1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(crate::card_row::raw_json(&stored).as_deref(), Some("{}"));
    }

    /// The mask can never be NULL, and that is the format filter's requirement rather than
    /// tidiness: [`crate::filters::push_card_filters`] asks `legal_mask & ? != 0`, and
    /// `NULL & ?` is NULL — a printing with a NULL mask would drop out of every
    /// format-filtered search **silently**, where a 0 reads as the true statement "legal
    /// nowhere". Both halves are asserted through behaviour: the `DEFAULT` is what an
    /// `INSERT` that does not name the column lands on (which is every fixture in this crate
    /// and every hand-written row), and the `NOT NULL` is what refuses one that names it and
    /// passes NULL.
    #[test]
    fn a_card_can_never_carry_a_null_legal_mask() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();

        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('1','Black Lotus','lea','232','en','normal','{}')",
            [],
        )
        .unwrap();
        let mask: Option<i64> = conn
            .query_row("SELECT legal_mask FROM cards WHERE id='1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(mask, Some(0), "legal nowhere, not unknown");

        let refused = conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,raw,legal_mask)
             VALUES ('2','Mox Pearl','lea','264','en','normal','{}',NULL)",
            [],
        );
        // On the message, not on `is_err`: a typo'd column name or a missing NOT NULL
        // elsewhere in this INSERT would fail just as loudly and the test would still pass,
        // pinning nothing about `legal_mask`.
        let refused = refused.expect_err("a NULL mask must not be storable");
        assert!(
            refused
                .to_string()
                .contains("NOT NULL constraint failed: cards.legal_mask"),
            "refused for the constraint, not for a broken statement: {refused}"
        );
    }

    /// The widened index is what makes a *filtered* browse cheap — 505 ms to 41 ms, measured
    /// 2026-08-11 over the live corpus. A v9 database already carries the narrow definition
    /// (it has done since v7 built it), and every statement in [`CARDS_INDEXES`] is
    /// `IF NOT EXISTS`, so the step has to DROP first or the widening is a silent no-op on
    /// exactly the machines that need it.
    #[test]
    fn the_v10_step_replaces_the_narrow_collapse_index_rather_than_skipping_it() {
        let conn = v9_database();

        migrate_single_file(&conn).unwrap();

        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='idx_cards_collapse'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(sql.contains("legal_mask"), "widened: {sql}");
        assert!(sql.contains("cmc"), "widened: {sql}");
        assert!(sql.contains("color_identity"), "widened: {sql}");
    }

    // ---- v11: the marketplace price tables ------------------------------------------

    /// A database that stopped at version 10: everything v10 left behind, and none of v11,
    /// v12, v13 or v14.
    ///
    /// [`v9_database`]'s trick again — walk to head, undo every step above the one this claims,
    /// renumber — and for its reason: only version 1's DDL is frozen, so there is no way to
    /// *build* a v10 database forwards. Two `DROP TABLE`s undo v11, [`UNDO_V12`] and
    /// [`UNDO_V13`] undo the two `decks` rungs and [`UNDO_V14`] undoes the oracle-tag tables,
    /// which is the whole of what those four steps did; that is what makes the rewind honest
    /// here where a rewind through v8's table rebuild would not be.
    ///
    /// **It was head minus one once, and sits three rungs below it now** — and, exactly like
    /// [`v9_database`] before it, it keeps its number rather than following the ladder: what it
    /// is for is proving the v11 step, and that claim is about version 10 and no other.
    /// [`v13_database`] carries the "one step below head" claim now.
    fn v10_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "DROP TABLE marketplace_prices;
             DROP TABLE marketplace_feed_meta;
             {UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20}
             {UNDO_V12}
             {UNDO_V13}
             {UNDO_V14}
             {UNDO_V15}
             {UNDO_V16}
             {UNDO_V17}
             {UNDO_V18}
             {UNDO_V19}
             PRAGMA user_version = 10;",
        ))
        .unwrap();
        conn
    }

    /// A database at version 11: everything v11 left behind, and none of v12, v13 or v14.
    ///
    /// The same rewind as [`v10_database`], one rung shorter — walk to head, undo every step
    /// above the version claimed, renumber. **It briefly held the "one step below head" title
    /// and no longer does**: v13 arrived the same day v12 did, from a branch that had numbered
    /// its own step 12 against the same head of 11, and v14 (the oracle-tag tables) came up the
    /// same road from a third branch. [`v13_database`] carries that title now. This fixture is
    /// kept, rather than renumbered away, because it is the only database the **v12** step can
    /// genuinely be watched running over.
    fn v11_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20} {UNDO_V12} {UNDO_V13} {UNDO_V14} {UNDO_V15} {UNDO_V16} {UNDO_V17} {UNDO_V18} \
             {UNDO_V19} PRAGMA user_version = 11;"
        ))
        .unwrap();
        conn
    }

    /// [`v11_database`] must really be **at** version 11, or the v12 step below is being tested
    /// against a database that already carries its columns — which is a fresh install compared
    /// against itself.
    #[test]
    fn the_v11_fixture_really_sits_where_the_v12_step_can_run_over_it() {
        let conn = v11_database();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 11);

        for column in ["last_variant", "last_group_by", "last_sort_by"] {
            assert!(
                !deck_columns(&conn).contains(&column.to_owned()),
                "the v12 column `{column}` must not be there yet"
            );
        }
        assert!(
            !deck_columns(&conn).contains(&"separate_x_group".to_owned()),
            "and nor may v13's, which a rewind to 11 also has to undo"
        );
        // Nor v14's five tables. Their DDL is `CREATE TABLE IF NOT EXISTS`, so leaving them
        // standing would cost `migrate_single_file` nothing and this fixture its name — which is the whole
        // reason [`UNDO_V14`] exists and is asserted here rather than assumed.
        assert_eq!(
            oracle_tag_table_count(&conn),
            0,
            "and nor may v14's, which a rewind to 11 also has to undo"
        );

        // v11's own tables are standing, because this *is* a v11 database — the fixture undoes
        // the steps above it and not the one it is named for.
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'
                   AND name IN ('marketplace_prices','marketplace_feed_meta')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2, "and v11's tables are");
    }

    // ---- v13: the deck's X group ------------------------------------------------------

    /// A database at version 12: everything v12 left behind, and none of v13 or v14.
    ///
    /// [`v9_database`]'s, [`v10_database`]'s and [`v11_database`]'s trick a fourth time — walk
    /// to head, undo exactly the steps above the version claimed, renumber — and for their
    /// reason: only version 1's DDL is frozen, so there is no way to *build* a v12 database
    /// forwards. One `ADD COLUMN` is the whole of what v13 did, and `ALTER TABLE … DROP COLUMN`
    /// undoes it exactly; no index names `decks.separate_x_group`, so nothing has to come down
    /// before it (which is the trap [`v9_database`] documents on `legal_mask`). [`UNDO_V14`]
    /// takes the oracle-tag tables back off for the reason its own doc gives.
    ///
    /// **This fixture was written as `v11_database` and is not any more.** It was built against
    /// a ladder whose head was 11, on a branch whose step was numbered 12; main's own v12 landed
    /// first, so this step became v13 and this fixture moved up a rung with it. The rename is
    /// the whole of what that cost — which is the argument for keeping every rung's undo in its
    /// own named constant rather than inline. **And it is no longer head minus one either**: v14
    /// arrived from a third branch that had also numbered its step 12, and
    /// [`v13_database`] carries that title now.
    fn v12_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20} {UNDO_V13} {UNDO_V14} {UNDO_V15} {UNDO_V16} {UNDO_V17} {UNDO_V18} \
             {UNDO_V19} PRAGMA user_version = 12;"
        ))
        .unwrap();
        conn
    }

    /// [`v12_database`] must really be **at** version 12, or the v13 step below is being tested
    /// against a database that already carries its column — which is a fresh install compared
    /// against itself. A literal, not `LEGACY_SINGLE_FILE_VERSION - 1`: this fixture is pinned to the
    /// version below the X group, and it stopped following the ladder when v14 landed.
    #[test]
    fn the_v12_fixture_really_sits_where_the_v13_step_can_run_over_it() {
        let conn = v12_database();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 12, "below the step that adds the X group");
        assert!(
            !deck_columns(&conn).contains(&"separate_x_group".to_owned()),
            "the v13 column must not be there yet"
        );
        assert_eq!(
            oracle_tag_table_count(&conn),
            0,
            "and nor may v14's five tables"
        );
        // **v12's three columns _are_ standing**, which is the half that says this fixture
        // undoes the rungs above 12 and not the one it is named for — the failure a copy of
        // `v11_database` would have.
        for column in ["last_variant", "last_group_by", "last_sort_by"] {
            assert!(
                deck_columns(&conn).contains(&column.to_owned()),
                "v12's `{column}` belongs to this version and must survive the rewind"
            );
        }
        // v11's own tables are standing too, because this is a database above v11.
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'
                   AND name IN ('marketplace_prices','marketplace_feed_meta')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2);
    }

    /// The step itself, from the version below it: the column arrives, it defaults to off for
    /// every deck that predates it, and a rerun is a no-op.
    ///
    /// **The default is the upgrade's whole promise.** `ALTER TABLE … ADD COLUMN` with
    /// `NOT NULL DEFAULT 0` fills every existing row, so a user who has never heard of the X
    /// group opens their decks and finds them grouped exactly as they left them. A nullable
    /// column would have meant three states for a two-state switch and a `coalesce` at every
    /// read site.
    #[test]
    fn the_v13_step_adds_the_decks_x_group_flag_defaulted_off() {
        let conn = v12_database();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('Old Deck', 'modern', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();

        migrate_single_file(&conn).unwrap();
        migrate_single_file(&conn).unwrap(); // idempotent

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);

        let (notnull, default): (i64, Option<String>) = conn
            .query_row(
                "SELECT \"notnull\", dflt_value FROM pragma_table_info('decks')
                  WHERE name = 'separate_x_group'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("the v13 column");
        assert_eq!(notnull, 1);
        assert_eq!(default.as_deref(), Some("0"));

        let on: i64 = conn
            .query_row(
                "SELECT separate_x_group FROM decks WHERE name = 'Old Deck'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            on, 0,
            "a deck that predates the switch reads as it always did"
        );
    }

    /// `decks`' column names in ordinal order, [`card_columns`]' counterpart — the deck tables
    /// have their own ladder of `ALTER`s and the same "did every route arrive here" question.
    fn deck_columns(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("PRAGMA table_info(decks)").unwrap();
        let cols = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        cols
    }

    /// The step itself, from the version below it: both tables arrive, keyed the way every
    /// price lookup joins them, and a rerun is a no-op.
    #[test]
    fn the_v11_step_creates_the_marketplace_price_tables() {
        let conn = v10_database();

        // The premise, asserted rather than assumed: a fixture that had quietly stayed at head
        // would make everything below it pass against a database the step never ran on.
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 10);
        let before: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'
                   AND name IN ('marketplace_prices','marketplace_feed_meta')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, 0, "the v11 tables must not be there yet");
        assert_eq!(
            oracle_tag_table_count(&conn),
            0,
            "and nor may v14's, which a rewind to 10 also has to undo"
        );
        // And v10's own column is standing, because this *is* a v10 database.
        assert!(card_columns(&conn).contains(&"legal_mask".to_owned()));

        migrate_single_file(&conn).unwrap();
        migrate_single_file(&conn).unwrap(); // idempotent

        conn.execute(
            "INSERT INTO marketplace_prices (marketplace, card_id, finish, price)
             VALUES ('cardkingdom','bolt','nonfoil',0.35)",
            [],
        )
        .unwrap();
        // The primary key is the join key, so a second row under it is a conflict rather
        // than a duplicate price nothing would ever notice.
        let dup = conn.execute(
            "INSERT INTO marketplace_prices (marketplace, card_id, finish, price)
             VALUES ('cardkingdom','bolt','nonfoil',9.99)",
            [],
        );
        assert!(dup.is_err(), "(marketplace, card_id, finish) is unique");

        // A finish spelled any other way is refused, as it is on every other finish column
        // in this schema: etched is a third finish, never `foil: true`.
        let bad = conn.execute(
            "INSERT INTO marketplace_prices (marketplace, card_id, finish, price)
             VALUES ('cardkingdom','bolt','Foil',1.0)",
            [],
        );
        assert!(bad.is_err(), "the finish CHECK must hold");

        // `feed_built_at` is the nullable one — Mana Pool publishes no stamp at all — and
        // the other three are not.
        conn.execute(
            "INSERT INTO marketplace_feed_meta (marketplace, fetched_at, feed_built_at, row_count)
             VALUES ('manapool', 1800000000, NULL, 102321)",
            [],
        )
        .unwrap();
    }

    /// **The reason these tables exist at all.** `cards` is dropped and recreated on every
    /// sync, so a price column on it would be destroyed by the next refresh — and there is no
    /// cheap way back, the feeds being 112 MiB between them. This walks a real swap over a
    /// seeded price and asserts it is still there afterwards.
    #[test]
    fn marketplace_prices_survive_the_staging_swap() {
        let conn = memory_pair();
        conn.execute_batch(
            "INSERT INTO marketplace_prices (marketplace, card_id, finish, price)
                VALUES ('cardkingdom','bolt','nonfoil',0.35);
             INSERT INTO marketplace_feed_meta (marketplace, fetched_at, feed_built_at, row_count)
                VALUES ('cardkingdom', 1800000000, '2026-08-11 21:07:02', 1);",
        )
        .unwrap();

        create_staging(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards_staging (id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('bolt','Lightning Bolt','lea','161','en','normal','{}')",
            [],
        )
        .unwrap();
        swap_staging(&conn).unwrap();

        let (price, rows): (f64, i64) = conn
            .query_row(
                "SELECT (SELECT price FROM marketplace_prices
                          WHERE marketplace='cardkingdom' AND card_id='bolt' AND finish='nonfoil'),
                        (SELECT row_count FROM marketplace_feed_meta WHERE marketplace='cardkingdom')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((price, rows), (0.35, 1), "a sync must not cost the prices");
    }

    /// **No foreign key against `cards.id`, and that is a promise about the data.** A feed and
    /// the corpus are collected on different days, so a price for a printing this database has
    /// never seen has to store — and a declared `REFERENCES cards(id)` would also abort every
    /// sync, since `swap_staging` drops the table the reference names.
    #[test]
    fn a_price_for_a_card_the_corpus_does_not_have_is_storable() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        conn.execute(
            "INSERT INTO marketplace_prices (marketplace, card_id, finish, price)
             VALUES ('manapool','a-card-scryfall-has-not-shipped-us','foil',2.18)",
            [],
        )
        .expect("a price for an unknown card is expected, not an error");

        // `PRAGMA foreign_key_check` yields one row per violation, so an empty answer is a
        // clean database — counted rather than matched on `QueryReturnedNoRows`, which is the
        // same result spelled as an error and reads backwards.
        let violations = conn
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query_map([], |_| Ok(()))
            .unwrap()
            .count();
        assert_eq!(violations, 0, "and no foreign key is violated by it");
    }

    // ---- v12: where the reader was last looking ---------------------------------------

    /// The step itself, from the version below it: three columns arrive on `decks`, a deck that
    /// predates them reads the editor's own opening choices rather than a NULL, and a rerun is
    /// a no-op.
    ///
    /// **The deck row is inserted before `migrate_single_file` runs**, which is the only way to test what
    /// this step is actually for: `DEFAULT` on an added column fills the rows that are already
    /// there, and a row written afterwards would be answering the DDL rather than the
    /// migration. A step that added the columns nullable, with the defaults living only in
    /// `create_deck`'s INSERT, would pass every other test in this file and hand every
    /// pre-existing deck a NULL variant.
    #[test]
    fn the_v12_step_remembers_where_the_reader_was_with_the_editors_own_defaults() {
        let conn = v11_database();
        conn.execute_batch(
            "INSERT INTO decks (id, name, created_at, updated_at)
             VALUES (1, 'Burn', unixepoch(), unixepoch());",
        )
        .unwrap();

        migrate_single_file(&conn).unwrap();
        migrate_single_file(&conn).unwrap(); // idempotent

        let (variant, group_by, sort_by): (String, String, String) = conn
            .query_row(
                "SELECT last_variant, last_group_by, last_sort_by FROM decks WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (variant.as_str(), group_by.as_str(), sort_by.as_str()),
            ("live", "category", "alphabetical"),
            "a deck that predates the step opens where the editor opens"
        );

        // **No CHECK on `last_variant`, and the step's own doc says why**: `ALTER TABLE ADD
        // COLUMN` cannot add one. The fence is `deck::set_view_state`'s, in Rust — pinned
        // there by `set_view_state_refuses_a_variant_the_schema_does_not_know`. This asserts
        // the *absence*, so that a later step which rebuilds the table and adds the CHECK
        // fails here and takes the Rust fence's doc with it rather than leaving two stories.
        conn.execute(
            "UPDATE decks SET last_variant = 'sideways', last_group_by = 'phase of the moon'
              WHERE id = 1",
            [],
        )
        .expect("SQL accepts anything here; Rust is the fence");
    }

    // ---- v14: the oracle-tag tables --------------------------------------------------

    /// A database at version 13: everything v13 left behind, and none of v14 or v15.
    ///
    /// [`v10_database`]'s trick three rungs up, and honest for the same reason: five
    /// `CREATE TABLE`s are the whole of what v14 did, so [`UNDO_V14`] leaves a database no
    /// different from one that stopped at v13. [`UNDO_V15`] rides along because a v13 database
    /// runs *every* step above 13, and v15's `ADD COLUMN` over a table already carrying the
    /// column would not migrate at all.
    ///
    /// **The number this fixture is named for was not this branch's to choose.** The oracle-tag
    /// step was written as v12 against a ladder whose head was 11; main's v12 (the editor's view
    /// state) and v13 (the X group) landed first, so it became v14 and this fixture moved two
    /// rungs with it. A version that has shipped is spent — the ladder only ever grows, and the
    /// fixtures follow it. **It briefly held the "one step below head" title and no longer
    /// does** — v15 (the category's origin) took it, then v16 (the deck's default category), and
    /// [`v15_database`] carries it now.
    fn v13_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20} {UNDO_V14} {UNDO_V15} {UNDO_V16} {UNDO_V17} {UNDO_V18} {UNDO_V19} PRAGMA user_version = 13;"
        ))
        .unwrap();
        conn
    }

    /// [`v13_database`] must really be **at** version 13, or the v14 step below is being tested
    /// against a database that already carries its tables — which is a fresh install compared
    /// against itself. A literal, not `LEGACY_SINGLE_FILE_VERSION - 1`: this fixture is pinned to the
    /// version below the oracle-tag tables, and it stopped following the ladder when v15 landed.
    #[test]
    fn the_v13_fixture_really_sits_where_the_v14_step_can_run_over_it() {
        let conn = v13_database();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            version, 13,
            "below the step that adds the oracle-tag tables"
        );

        assert_eq!(
            oracle_tag_table_count(&conn),
            0,
            "the v14 tables must not be there yet"
        );
        assert!(
            !category_columns(&conn).contains(&"origin".to_owned()),
            "and nor may v15's column"
        );
        assert!(
            !deck_columns(&conn).contains(&"default_category_id".to_owned()),
            "and nor may v16's"
        );

        // v13's own column and v11's own tables are standing, because this fixture undoes the
        // rungs above 13 rather than the one it is named for — the failure a copy of
        // [`v11_database`] would have.
        assert!(
            deck_columns(&conn).contains(&"separate_x_group".to_owned()),
            "v13's column belongs to this version and must survive the rewind"
        );
        let prices: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'
                   AND name IN ('marketplace_prices','marketplace_feed_meta')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(prices, 2);
    }

    /// The five oracle-tag tables, counted by name — v14's whole footprint, and what a fixture
    /// claiming any version below 14 must not be carrying. By name rather than
    /// `LIKE 'oracle_tag%'`, because that pattern also matches the staging copies and a fixture
    /// is not entitled to be vague about which tables it is asserting the absence of.
    fn oracle_tag_table_count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table'
               AND name IN ('oracle_tags','oracle_tag_parents','oracle_taggings',
                            'oracle_tag_cards','oracle_tag_meta')",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The step itself, from the version below it: five tables arrive, keyed the way the read
    /// path scans them, and a rerun is a no-op.
    #[test]
    fn the_v14_step_creates_the_oracle_tag_tables() {
        let conn = v13_database();

        migrate_single_file(&conn).unwrap();
        migrate_single_file(&conn).unwrap(); // idempotent

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
        assert_eq!(oracle_tag_table_count(&conn), 5, "all five arrive");

        conn.execute_batch(
            "INSERT INTO oracle_tags (slug, label, description)
                VALUES ('tutor-battle','tutor-battle','Cards that tutor battle cards.');
             INSERT INTO oracle_tag_parents (child_slug, parent_slug)
                VALUES ('tutor-battle','tutor'),('tutor-battle','battle-matters');
             INSERT INTO oracle_taggings (oracle_id, slug, weight, annotation)
                VALUES ('oid-1','tutor-battle','median',NULL);
             INSERT INTO oracle_tag_cards (oracle_id, slug)
                VALUES ('oid-1','tutor-battle'),('oid-1','tutor');",
        )
        .unwrap();

        // Two parents under one child is the *expected* shape — 684 of 4 521 tags have
        // several — so the key has to admit it while still refusing the same edge twice.
        let dup_edge = conn.execute(
            "INSERT INTO oracle_tag_parents (child_slug, parent_slug)
             VALUES ('tutor-battle','tutor')",
            [],
        );
        assert!(dup_edge.is_err(), "(child_slug, parent_slug) is unique");

        let dup_closure = conn.execute(
            "INSERT INTO oracle_tag_cards (oracle_id, slug) VALUES ('oid-1','tutor')",
            [],
        );
        assert!(dup_closure.is_err(), "(oracle_id, slug) is unique");

        // One watermark row, ever: a second is refused by the CHECK rather than quietly
        // giving the next run two answers about which file it holds.
        conn.execute(
            "INSERT INTO oracle_tag_meta (id, etag, updated_at, ingested_at, checked_at,
                                          tag_count, tagging_count)
             VALUES (1, 'W/\"abc\"', '2026-08-14T21:00:00Z', 1800000000, 1800000000,
                     4521, 229633)",
            [],
        )
        .unwrap();
        let second = conn.execute(
            "INSERT INTO oracle_tag_meta (id, etag, updated_at, ingested_at, checked_at,
                                          tag_count, tagging_count)
             VALUES (2, NULL, NULL, 1800000001, 1800000001, 1, 1)",
            [],
        );
        assert!(second.is_err(), "the watermark is one row");
    }

    /// **No foreign key against `cards`, and that is a promise about the data.** The tag file
    /// names 35 969 oracle ids and the corpus is collected on a different day; a tagging for a
    /// card this database has never seen has to store. A declared reference would also abort
    /// every sync, `swap_staging` dropping the table it names.
    #[test]
    fn a_tagging_for_a_card_the_corpus_does_not_have_is_storable() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        conn.execute(
            "INSERT INTO oracle_tag_cards (oracle_id, slug) VALUES ('not-in-the-corpus','ramp')",
            [],
        )
        .expect("a tag for an unknown card is expected, not an error");

        let violations = conn
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query_map([], |_| Ok(()))
            .unwrap()
            .count();
        assert_eq!(violations, 0);
    }

    /// The tags outlive a sync, which is the reason they are tables rather than anything
    /// hanging off `cards`: `swap_staging` drops and recreates that table on every refresh.
    #[test]
    fn oracle_tags_survive_the_staging_swap() {
        let conn = memory_pair();
        conn.execute_batch(
            "INSERT INTO oracle_tags (slug,label,description) VALUES ('ramp','ramp',NULL);
             INSERT INTO oracle_tag_cards (oracle_id, slug) VALUES ('oid-1','ramp');
             INSERT INTO oracle_tag_meta (id, etag, updated_at, ingested_at, checked_at,
                                          tag_count, tagging_count)
                VALUES (1, NULL, '2026-08-14T21:00:00Z', 1800000000, 1800000000, 1, 1);",
        )
        .unwrap();

        create_staging(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards_staging (id,oracle_id,name,set_code,collector_number,lang,
                                        layout,raw)
             VALUES ('bolt','oid-1','Lightning Bolt','lea','161','en','normal','{}')",
            [],
        )
        .unwrap();
        swap_staging(&conn).unwrap();

        let (slugs, tags): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT count(*) FROM oracle_tag_cards WHERE oracle_id='oid-1'),
                        (SELECT tag_count FROM oracle_tag_meta WHERE id=1)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((slugs, tags), (1, 1), "a sync must not cost the tags");
    }

    /// **The staging tables are renamed *over* the live ones, so the two layouts must agree
    /// exactly** — and they are two separate literals, one of them frozen history. This is the
    /// fence: name, declared type, `NOT NULL` and primary-key position, column by column. A
    /// `CREATE TABLE … AS SELECT` clone would drop all four, and a string substitution over
    /// the live DDL would pass this test by construction while breaking the rule that a
    /// migration step is history.
    #[test]
    fn the_oracle_tag_staging_tables_match_the_live_ones() {
        let conn = memory_pair();
        create_oracle_tag_staging(&conn).unwrap();

        for (live, staging) in ORACLE_TAG_TABLES {
            let want = table_shape(&conn, live);
            assert!(!want.is_empty(), "{live} must exist at head");
            assert_eq!(
                table_shape(&conn, staging),
                want,
                "`{staging}` must match `{live}`"
            );
        }
    }

    /// The swap is a rename, so what the ingest filled has to *become* the live table —
    /// rows, keys and all — and the previous contents have to be gone rather than merged
    /// with. A refresh that appended would leave every tag a card has ever held, including
    /// the ones Scryfall has since retired.
    #[test]
    fn the_oracle_tag_swap_replaces_rather_than_merges() {
        let conn = memory_pair();
        conn.execute_batch(
            "INSERT INTO oracle_tags (slug,label,description) VALUES ('retired','retired',NULL);
             INSERT INTO oracle_tag_cards (oracle_id,slug) VALUES ('oid-1','retired');",
        )
        .unwrap();

        create_oracle_tag_staging(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO oracle_tags_staging (slug,id,label,description,slug_norm)
                VALUES ('ramp','uuid-ramp','ramp','Cards that ramp.','ramp');
             INSERT INTO oracle_tag_cards_staging (oracle_id,slug) VALUES ('oid-1','ramp');",
        )
        .unwrap();
        swap_oracle_tag_staging(&conn).unwrap();

        let slugs: Vec<String> = conn
            .prepare("SELECT slug FROM oracle_tag_cards WHERE oracle_id='oid-1' ORDER BY slug")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(slugs, vec!["ramp".to_owned()], "the retired tag is gone");

        // The renamed table keeps its primary key, which is the whole read path: a second
        // copy of a row must still be refused after the swap.
        let dup = conn.execute(
            "INSERT INTO oracle_tag_cards (oracle_id, slug) VALUES ('oid-1','ramp')",
            [],
        );
        assert!(dup.is_err(), "the rename must carry the primary key over");

        // And the staging tables are gone rather than left behind under their old names.
        let leftovers: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name LIKE '%_staging'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftovers, 0);
    }

    // ---- v15: who made the category --------------------------------------------------

    /// `deck_categories`' column names in ordinal order — [`deck_columns`]' counterpart, and
    /// owed for its reason: that table has an `ALTER` ladder of its own now (v8 built it, v15
    /// added `origin`), and "did every route arrive here" is the same question about it.
    fn category_columns(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("PRAGMA table_info(deck_categories)").unwrap();
        let cols = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        cols
    }

    /// A database at version 14: everything v14 left behind, and none of v15 or v16.
    ///
    /// [`v13_database`]'s trick one rung up, and honest for the same reason: one `ADD COLUMN`
    /// is the whole of what v15's DDL did, and `ALTER TABLE … DROP COLUMN` undoes it exactly —
    /// no index names `deck_categories.origin`, so nothing has to come down before it (the trap
    /// [`v9_database`] documents on `legal_mask`). [`UNDO_V16`] rides along for [`UNDO_V15`]'s
    /// own reason one rung down: a v14 database runs *every* step above 14, and v16's
    /// `ADD COLUMN` over a `decks` table already carrying the column would not migrate at all.
    ///
    /// **The backfill is not rewound, and does not need to be**: it wrote to that column and to
    /// nothing else, so dropping the column takes it with it.
    ///
    /// **It held the "one step below head" title and no longer does** — v16 (the deck's default
    /// category) took it, and [`v15_database`] carries it now.
    fn v14_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20} {UNDO_V15} {UNDO_V16} {UNDO_V17} {UNDO_V18} {UNDO_V19} PRAGMA user_version = 14;"
        ))
        .unwrap();
        conn
    }

    /// [`v14_database`] must really be **at** version 14, or the v15 step below is being tested
    /// against a database that already carries its column. A literal, not `LEGACY_SINGLE_FILE_VERSION - 1`:
    /// this fixture is pinned to the version below `deck_categories.origin`, and it stopped
    /// following the ladder when v16 landed.
    #[test]
    fn the_v14_fixture_really_sits_where_the_v15_step_can_run_over_it() {
        let conn = v14_database();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            version, 14,
            "below the step that adds the category's origin"
        );
        assert!(
            !category_columns(&conn).contains(&"origin".to_owned()),
            "the v15 column must not be there yet"
        );
        assert!(
            !deck_columns(&conn).contains(&"default_category_id".to_owned()),
            "and nor may v16's column"
        );

        // v14's own tables are standing, because this fixture undoes the rungs above 14 rather
        // than the one it is named for.
        assert_eq!(
            oracle_tag_table_count(&conn),
            5,
            "v14's tables belong to this version and must survive the rewind"
        );
    }

    /// The step itself, from the version below it: the column arrives defaulted to `user`, the
    /// backfill marks the piles the add path is likely to have made, and a rerun is a no-op.
    ///
    /// **`DEFAULT 'user'` is the upgrade's promise and the backfill is a guess on top of it.**
    /// Every row that predates the column reads `user`, which draws exactly as it always did;
    /// the `UPDATE` then re-marks the names `autoCategoryFor` can answer with, which is the only
    /// evidence a database carries about who made a pile. Both halves are asserted here because
    /// the guess is the part that can be wrong: a reader's own `My pile` and the four the schema
    /// seeds have to come out the other side untouched.
    ///
    /// **`Main deck` is on this list of what must stay `user`, and that is the case worth
    /// pinning.** It is the v8 migration's own pile, holding every legacy `main` row on any
    /// database old enough to have one — a real column of real cards, and the one name a
    /// careless "these all look automatic" list would sweep up.
    #[test]
    fn the_v15_step_marks_the_auto_made_piles_and_leaves_the_rest_user_made() {
        let conn = v14_database();
        let deck_id = deck(&conn, "Old Deck");
        // Two the rule can answer with, one the reader typed, the v8 migration's pile, and the
        // four the schema seeds — every class this backfill has to tell apart, in one deck,
        // because `DECK_CATEGORY_GRAIN` is `(deck_id, name)` and each of these names is distinct.
        for (kind, name) in [
            ("main", "Ramp"),
            ("main", "Uncategorised"),
            ("main", "My pile"),
            ("main", "Main deck"),
            ("commander", "Commander"),
            ("side", "Sideboard"),
            ("companion", "Companion"),
            ("maybe", "Maybeboard"),
        ] {
            category(&conn, deck_id, kind, name);
        }
        // And one on a *second* deck whose name is on the list but whose kind is not `main`:
        // the `kind = 'main'` half of the rule, which no row above can prove on its own.
        let other = deck(&conn, "Other Deck");
        category(&conn, other, "side", "Removal");

        migrate_single_file(&conn).unwrap();
        migrate_single_file(&conn).unwrap(); // idempotent

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);

        let (notnull, default): (i64, Option<String>) = conn
            .query_row(
                "SELECT \"notnull\", dflt_value FROM pragma_table_info('deck_categories')
                  WHERE name = 'origin'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("the v15 column");
        assert_eq!(notnull, 1);
        assert_eq!(default.as_deref(), Some("'user'"));

        let origin = |name: &str| -> String {
            conn.query_row(
                "SELECT origin FROM deck_categories WHERE deck_id = ?1 AND name = ?2",
                rusqlite::params![deck_id, name],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            origin("Ramp"),
            "auto",
            "a functional bucket the rule answers with"
        );
        assert_eq!(origin("Uncategorised"), "auto", "and the fallback bucket");
        assert_eq!(
            origin("My pile"),
            "user",
            "a name only a reader can have typed"
        );
        assert_eq!(
            origin("Main deck"),
            "user",
            "the v8 migration's pile holds real cards and is never hidden"
        );
        for seeded in ["Commander", "Sideboard", "Companion", "Maybeboard"] {
            assert_eq!(
                origin(seeded),
                "user",
                "the four seeded zones are the reader's"
            );
        }

        let other_removal: String = conn
            .query_row(
                "SELECT origin FROM deck_categories WHERE deck_id = ?1 AND name = 'Removal'",
                rusqlite::params![other],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            other_removal, "user",
            "the backfill reads `kind` as well as the name: a `side` pile is not an auto pile"
        );
    }

    /// **No CHECK on `origin`, and the step's own doc says why**: `ALTER TABLE ADD COLUMN`
    /// cannot add one — `decks.last_variant`'s constraint at v12.
    ///
    /// Unlike that column there is no Rust fence in its place either, and this asserts the
    /// absence so that a later step which rebuilds the table and adds a CHECK fails here and
    /// takes the step's paragraph with it rather than leaving two stories. What makes the
    /// absence safe is that `origin` is never a caller's value: four INSERTs inside this crate
    /// write it and no command parameter reaches it.
    #[test]
    fn origin_carries_no_check_because_no_caller_supplies_it() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Ramp");

        conn.execute(
            "UPDATE deck_categories SET origin = 'sideways' WHERE id = ?1",
            rusqlite::params![cat],
        )
        .expect("SQL accepts anything here; the four write sites are the fence");
    }

    // ---- v16: the deck's default category ---------------------------------------------

    /// A database one step below head: everything v15 left behind, and none of v16.
    ///
    /// [`v14_database`]'s trick one rung up, and honest for the same reason: one `ADD COLUMN`
    /// is the whole of what v16's DDL did, and `ALTER TABLE … DROP COLUMN` undoes it exactly —
    /// no index and **no foreign key** names `decks.default_category_id`, so nothing has to come
    /// down before it.
    fn v15_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20} {UNDO_V16} {UNDO_V17} {UNDO_V18} {UNDO_V19} PRAGMA user_version = 15;"
        ))
        .unwrap();
        conn
    }

    // ---- v17: the undo journal -------------------------------------------------------

    /// A database at version 16: everything v16 left behind, and none of v17.
    ///
    /// [`v13_database`]'s trick four rungs up, and honest for [`UNDO_V17`]'s reason: one
    /// `CREATE TABLE` and its index are the whole of what v17's DDL did, and one `DROP TABLE`
    /// takes both back off. Nothing references `deck_undo`, so nothing has to come down first
    /// — the trap [`v9_database`] documents on `legal_mask`, which this rung does not have.
    ///
    /// **It held the "one step below head" title and has handed it on** — to
    /// [`v17_database`], as [`v15_database`] handed it to this one, and v19 has since moved it
    /// on again to [`v18_database`]. That line has moved with every rung and is left here as
    /// the record of which fixture the title belonged to.
    fn v16_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20} {UNDO_V17} {UNDO_V18} {UNDO_V19} PRAGMA user_version = 16;"
        ))
        .unwrap();
        conn
    }

    /// The undo journal is 1:1 with a history row, and dies with it.
    ///
    /// Both CASCADEs are asserted here rather than read off the DDL, because a foreign key
    /// declared without `PRAGMA foreign_keys=ON` is a comment — and `seeded()`-style fixtures
    /// elsewhere in this crate deliberately do not set it, while `db::open` always does.
    /// `Connection::open_in_memory` plus [`migrate_single_file`] is the pairing that has it on.
    #[test]
    fn the_undo_journal_cascades_from_its_history_row_and_its_deck() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(
            r#"INSERT INTO decks (id, name, created_at, updated_at)
                   VALUES (1, 'Burn', unixepoch(), unixepoch());
               INSERT INTO deck_audit (id, deck_id, at, variant, kind, payload, delta)
                   VALUES (7, 1, unixepoch(), 'live', 'add', '{}', 1);
               INSERT INTO deck_undo (audit_id, deck_id, step)
                   VALUES (7, 1, '{"undo":[],"redo":[]}');"#,
        )
        .unwrap();
        let left = |conn: &Connection| -> i64 {
            conn.query_row("SELECT count(*) FROM deck_undo", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(left(&conn), 1);

        conn.execute("DELETE FROM deck_audit WHERE id = 7", [])
            .unwrap();
        assert_eq!(
            left(&conn),
            0,
            "a deleted history row must take its step with it — a step whose change nobody \
             can see is a step undo would apply into nothing"
        );
    }

    /// The rewind is honest: a database claiming 16 must not be carrying v17's table.
    ///
    /// [`UNDO_V17`]'s DDL is `CREATE TABLE IF NOT EXISTS`, so a forgotten rewind costs
    /// `migrate_single_file` nothing and this fixture its name — which is exactly why the absence is
    /// asserted rather than assumed. Reaching [`LEGACY_SINGLE_FILE_VERSION`] afterwards is the other half.
    #[test]
    fn the_v17_step_creates_the_undo_journal_over_a_v16_database() {
        let conn = v16_database();
        assert_eq!(
            table_count(&conn, "deck_undo"),
            0,
            "a v16 database may not already carry v17's table"
        );

        migrate_single_file(&conn).unwrap();

        assert_eq!(table_count(&conn, "deck_undo"), 1);
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
    }

    /// `sqlite_master` rows with this name — 0 or 1. A helper rather than an inline query
    /// because two tests above ask the same question about the same table.
    fn table_count(conn: &Connection, name: &str) -> i64 {
        conn.query_row(
            &format!(
                "SELECT count(*) FROM {m} WHERE type = 'table' AND name = ?1",
                m = master(conn)
            ),
            rusqlite::params![name],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// `(name, type, notnull, pk-position)` per column, in ordinal order — the four things a
    /// staging table renamed over a live one has to agree with it about.
    ///
    /// One helper rather than one closure per family, because the whole value of the fence is
    /// that both families are compared the *same* four ways: a twin that checked three of them
    /// would pass while the fourth drifted.
    fn table_shape(conn: &Connection, table: &str) -> Vec<(String, String, i64, i64)> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(5)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        rows
    }

    // ---- v20: the art tags, the normalised slug and the mute list --------------------

    /// A database at version 19: everything v19 left behind, and none of v20.
    ///
    /// Honest for [`UNDO_V13`]'s reason — two of v20's statements are
    /// `ALTER TABLE … ADD COLUMN`, so a fixture that forgot the rewind could not migrate at
    /// all. It is the "one step below head" fixture now, the title [`v18_database`] held.
    fn v19_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20} PRAGMA user_version = 19;"
        ))
        .unwrap();
        conn
    }

    // ---- v21: one tag list, app-wide ------------------------------------------------

    /// A database at version 20: everything v20 left behind, and none of v21.
    ///
    /// It held the "one step below head" title for exactly one rung, as [`v19_database`] did
    /// before it; [`v21_database`] has it now. Rewinding v21 alone is enough because v21
    /// touches one table and the only rung above it writes no shape at all.
    fn v20_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} PRAGMA user_version = 20;"
        ))
        .unwrap();
        conn
    }

    /// A deck, a category and a card in it, in a fixture that is below the version the deck
    /// commands were written against — so every insert here is by hand.
    fn v20_deck(conn: &Connection, name: &str) -> i64 {
        conn.execute(
            "INSERT INTO decks (name, created_at, updated_at) VALUES (?1, 0, 0)",
            params![name],
        )
        .unwrap();
        let deck_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO deck_categories (deck_id, name, kind, sort_order, created_at, updated_at)
             VALUES (?1, 'Main deck', 'main', 0, 0, 0)",
            params![deck_id],
        )
        .unwrap();
        deck_id
    }

    /// One tag of one deck, the way v8 through v20 stored one.
    fn v20_tag(conn: &Connection, deck_id: i64, name: &str, color: &str, updated: i64) -> i64 {
        conn.execute(
            "INSERT INTO deck_tags (deck_id, name, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, ?4)",
            params![deck_id, name, color, updated],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// One card wearing one tag.
    fn v20_card(conn: &Connection, deck_id: i64, card: &str, tag: i64, qty: i64) {
        let cat: i64 = conn
            .query_row(
                "SELECT id FROM deck_categories WHERE deck_id = ?1",
                params![deck_id],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, tag_id, quantity, created_at, updated_at)
             VALUES (?1, ?2, 'live', ?3, 'lea', '1', 'en', ?3, ?4, ?5, 0, 0)",
            params![deck_id, cat, card, tag, qty],
        )
        .unwrap();
    }

    /// The whole of v21, on the shape it was written for: two decks that each wrote the same
    /// word become one row, and every card that wore either wears it.
    ///
    /// **The colour assertion is the one that would have failed silently.** `DROP TABLE` on a
    /// parent under `PRAGMA foreign_keys=ON` runs an implicit `DELETE FROM` that fires
    /// `ON DELETE SET NULL` — so a rebuild that did not carry the labels by hand would leave
    /// every card untagged and every count zero, which reads exactly like a deck nobody had
    /// tagged. The pragma is ON here for that reason: `Connection::open_in_memory` leaves it
    /// off, so a test that did not set it would prove nothing about the app, where `db::open`
    /// always sets it.
    #[test]
    fn the_v21_step_folds_every_decks_tags_into_one_list_and_keeps_the_cards_wearing_them() {
        let conn = v20_database();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let burn = v20_deck(&conn, "Burn");
        let control = v20_deck(&conn, "Control");

        // The same word in two decks, in two colours, with the smaller one edited later — so
        // "most copies" and "most recently touched" disagree and the first has to win.
        let big = v20_tag(&conn, burn, "Removal", "#d3202a", 10);
        let small = v20_tag(&conn, control, "removal", "#0e68ab", 99);
        // And a word only one deck ever wrote.
        let ramp = v20_tag(&conn, burn, "Ramp", "#00733e", 0);

        v20_card(&conn, burn, "bolt", big, 4);
        v20_card(&conn, control, "swords", small, 1);
        v20_card(&conn, burn, "llanowar", ramp, 2);

        migrate_single_file(&conn).unwrap();

        let rows: Vec<(i64, String, String, String)> = conn
            .prepare("SELECT id, name, name_key, color FROM deck_tags ORDER BY name")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            rows,
            vec![
                (ramp, "Ramp".to_owned(), "ramp".to_owned(), "#00733e".to_owned()),
                (
                    big,
                    "Removal".to_owned(),
                    "removal".to_owned(),
                    "#d3202a".to_owned()
                ),
            ],
            "one row per name; the four-copy spelling and colour survive, the one-copy              namesake does not, and the survivor keeps its own id"
        );

        // Every card still wears something, and the two that wore either spelling of `Removal`
        // now wear the one row.
        let wearing: Vec<(String, i64)> = conn
            .prepare("SELECT card_id, tag_id FROM deck_cards ORDER BY card_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            wearing,
            vec![
                ("bolt".to_owned(), big),
                ("llanowar".to_owned(), ramp),
                ("swords".to_owned(), big),
            ],
            "no card was untagged by the swap"
        );

        // The grain refuses the second row from here on.
        let taken = conn.execute(
            "INSERT INTO deck_tags (name, name_key, color, created_at, updated_at)
             VALUES ('REMOVAL', 'removal', '#000000', 0, 0)",
            [],
        );
        assert!(
            taken.is_err(),
            "the app-wide grain is enforced by the index"
        );

        // And the scaffolding is gone.
        for table in ["deck_tags_v21", "deck_tags_merge", "deck_tags_carry"] {
            assert_eq!(table_count(&conn, table), 0, "{table} must not survive");
        }
    }

    /// The other half of the merge rule: when two rows are worn by the same number of copies,
    /// the one edited most recently wins.
    #[test]
    fn the_v21_step_breaks_a_copy_count_tie_on_the_later_edit() {
        let conn = v20_database();
        let burn = v20_deck(&conn, "Burn");
        let control = v20_deck(&conn, "Control");
        let older = v20_tag(&conn, burn, "Cut", "#d3202a", 10);
        let newer = v20_tag(&conn, control, "cut", "#0e68ab", 20);
        v20_card(&conn, burn, "bolt", older, 3);
        v20_card(&conn, control, "swords", newer, 3);

        migrate_single_file(&conn).unwrap();

        let (id, name): (i64, String) = conn
            .query_row("SELECT id, name FROM deck_tags", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((id, name.as_str()), (newer, "cut"));
    }

    /// A tag no card wears has nothing to weigh it, and survives anyway: it is still a label
    /// the reader made, and after v21 it is one the whole app can reach.
    #[test]
    fn the_v21_step_keeps_a_tag_no_card_is_wearing() {
        let conn = v20_database();
        let burn = v20_deck(&conn, "Burn");
        v20_tag(&conn, burn, "Someday", "#d9b95c", 0);

        migrate_single_file(&conn).unwrap();

        let names: Vec<String> = conn
            .prepare("SELECT name FROM deck_tags")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(names, vec!["Someday"]);
    }

    /// The undo stack goes and the history stays — [`globalise_tags`]'s last paragraph, as an
    /// assertion, because the two halves are easy to conflate and only one of them is a loss
    /// the reader can see.
    #[test]
    fn the_v21_step_discards_every_undo_step_and_keeps_the_history() {
        let conn = v20_database();
        let burn = v20_deck(&conn, "Burn");
        conn.execute(
            "INSERT INTO deck_audit (id, deck_id, at, kind, payload) VALUES (1, ?1, 0, 'add', '{}')",
            params![burn],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_undo (audit_id, deck_id, step) VALUES (1, ?1, '{\"undo\":[]}')",
            params![burn],
        )
        .unwrap();

        migrate_single_file(&conn).unwrap();

        let undo: i64 = conn
            .query_row("SELECT count(*) FROM deck_undo", [], |r| r.get(0))
            .unwrap();
        let audit: i64 = conn
            .query_row("SELECT count(*) FROM deck_audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(undo, 0, "the arrows lose their charge");
        assert_eq!(audit, 1, "the history does not");
    }

    /// The step's own tables, and the index that is not one of them.
    ///
    /// An art tag is a fact about an *illustration*, so the four tables key on
    /// `illustration_id` rather than on `oracle_id` and are a parallel set instead of a `kind`
    /// column on the oracle ones. The index is asserted separately because it lives in
    /// [`CARDS_INDEXES`] rather than in the step, which is the only place it can survive a
    /// sync.
    #[test]
    fn v20_creates_the_art_tag_tables_and_the_illustration_index() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, LEGACY_SINGLE_FILE_VERSION);
        for (live, _) in ART_TAG_TABLES {
            conn.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                [live],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or_else(|_| panic!("{live} is missing"));
        }
        assert_eq!(table_count(&conn, "art_tag_meta"), 1, "the watermark too");
        conn.query_row(
            &format!(
                "SELECT 1 FROM {m} WHERE type='index' AND name='idx_cards_illustration'",
                m = master(&conn)
            ),
            [],
            |r| r.get::<_, i64>(0),
        )
        .expect("idx_cards_illustration is missing");
    }

    /// The closure carries a weight; the oracle one does not. This is the column the
    /// "Strong matches only" control reads, and its absence is silent — the filter would
    /// simply match everything — so it is asserted rather than assumed.
    #[test]
    fn the_art_closure_carries_a_weight_column() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        assert_eq!(has_column(&conn, "art_tag_illustrations", "weight"), 1);
    }

    /// [`swap_staging`] drops and recreates `cards` on every sync. An index declared anywhere
    /// but [`CARDS_INDEXES`] silently disappears the next morning — the failure that costs a
    /// session, because the app stays correct and merely becomes slow.
    #[test]
    fn the_illustration_index_survives_a_cards_swap() {
        let conn = memory_pair();
        create_staging(&conn).unwrap();
        swap_staging(&conn).unwrap();
        conn.query_row(
            &format!(
                "SELECT 1 FROM {m} WHERE type='index' AND name='idx_cards_illustration'",
                m = master(&conn)
            ),
            [],
            |r| r.get::<_, i64>(0),
        )
        .expect("the index did not survive swap_staging");
    }

    /// [`the_oracle_tag_staging_tables_match_the_live_ones`]' twin, and owed for the same
    /// reason: the staging tables are renamed *over* the live ones, so name, declared type,
    /// `NOT NULL` and primary-key position must agree column for column. Two literals rather
    /// than one with the names rewritten, which is what makes this a fence and not a tautology.
    #[test]
    fn the_art_tag_staging_tables_match_the_live_ones() {
        let conn = memory_pair();
        create_art_tag_staging(&conn).unwrap();

        for (live, staging) in ART_TAG_TABLES {
            let want = table_shape(&conn, live);
            assert!(!want.is_empty(), "{live} must exist at head");
            assert_eq!(
                table_shape(&conn, staging),
                want,
                "`{staging}` must match `{live}`"
            );
        }
    }

    /// What a refused or failed run leaves owing: the four staging tables go and the four
    /// live ones stay.
    ///
    /// The pairing is what makes this worth driving — `drop_art_tag_staging` walks
    /// [`ART_TAG_TABLES`], where each entry holds *both* names, and taking the live one
    /// instead would empty the taxonomy the reader is searching rather than tidying up after
    /// a download that never finished.
    #[test]
    fn dropping_the_art_staging_tables_leaves_the_live_ones_standing() {
        let conn = memory_pair();
        create_art_tag_staging(&conn).unwrap();
        drop_art_tag_staging(&conn).unwrap();

        for (live, staging) in ART_TAG_TABLES {
            assert_eq!(table_count(&conn, staging), 0, "{staging} must be gone");
            assert_eq!(table_count(&conn, live), 1, "{live} must be standing");
        }
    }

    /// Both taxonomies carry the slug reduced to `[a-z0-9]`, indexed.
    ///
    /// The search matches on it because SQLite has no `regexp_replace`, so the alternative is
    /// normalising every row on every keystroke. Its absence is silent in the worst direction
    /// — the needle is normalised in Rust either way, so a missing column is a search that
    /// matches nothing rather than one that errors.
    #[test]
    fn both_taxonomies_carry_a_normalised_slug_with_an_index_on_it() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        for table in ["art_tags", "oracle_tags"] {
            assert_eq!(has_column(&conn, table, "slug_norm"), 1, "{table}");
        }
        for index in ["idx_art_tags_norm", "idx_oracle_tags_norm"] {
            conn.query_row(
                &format!(
                    "SELECT 1 FROM {m} WHERE type='index' AND name=?1",
                    m = master(&conn)
                ),
                [index],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or_else(|_| panic!("{index} is missing"));
        }
    }

    /// Both closures are indexed by `slug`, which is the column the Tags page counts by.
    ///
    /// **Its own test rather than a line in the one above, because the failure is a different
    /// kind.** A missing `slug_norm` index is a slower search; a missing closure index is a
    /// hang. A closure is `WITHOUT ROWID` on `(subject_id, slug)`, so counting by slug has no
    /// path but a full scan, and [`crate::tags::query`] counts per row: 49 ms with the index,
    /// **531 seconds** without it, measured 2026-08-20 on a release build at that day's file
    /// size. Whoever deletes one of these will be reading this test's name, not that one's.
    #[test]
    fn both_tag_closures_are_indexed_by_slug() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        for index in [
            "idx_art_tag_illustrations_slug",
            "idx_oracle_tag_cards_slug",
        ] {
            conn.query_row(
                &format!(
                    "SELECT 1 FROM {m} WHERE type='index' AND name=?1",
                    m = master(&conn)
                ),
                [index],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or_else(|_| panic!("{index} is missing"));
        }
    }

    /// [`swap_oracle_tag_staging`] renames a staging table over `oracle_tags`, and a rename
    /// carries the *staging* table's indexes rather than the live one's. So the tag swap owes
    /// the replay [`swap_staging`] owes [`CARDS_INDEXES`], and without it the index is gone
    /// after the first weekly refresh with nothing anywhere saying so.
    ///
    /// **Both of the family's indexes, because both tables are renamed over.** The closure's
    /// is the one that would hurt, and it would not hurt gently: `tags::query` counts a tag's
    /// reach per row, so losing `idx_oracle_tag_cards_slug` takes a wide `tag_search` from
    /// 49 ms to **531 seconds** (measured 2026-08-20) — a frozen window one weekly refresh
    /// after this test stopped being true.
    #[test]
    fn the_tag_indexes_survive_an_oracle_tag_swap() {
        let conn = memory_pair();
        create_oracle_tag_staging(&conn).unwrap();
        swap_oracle_tag_staging(&conn).unwrap();
        for index in ["idx_oracle_tags_norm", "idx_oracle_tag_cards_slug"] {
            conn.query_row(
                &format!(
                    "SELECT 1 FROM {m} WHERE type='index' AND name=?1",
                    m = master(&conn)
                ),
                [index],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or_else(|_| panic!("{index} did not survive the tag swap"));
        }
    }

    /// A database that is **already at v20** and lacks the closure indexes gains them on the
    /// next `migrate_single_file`.
    ///
    /// **This is the one reachable state no other test covers**, and it is not hypothetical:
    /// every database that ran the v20 rung before `idx_art_tag_illustrations_slug` and
    /// `idx_oracle_tag_cards_slug` joined [`TAG_INDEXES_SQL`] is in it right now. `user_version`
    /// reads 20, so the rung never fires again; the two `..._survive_a_*_tag_swap` tests around
    /// this one prove the *refresh* path, which is up to a week away and only runs at all if the
    /// reader has ever fetched a tag file. The
    /// unconditional replay at the tail of [`migrate_single_file`] is the only thing that reaches these,
    /// and without it [`crate::tags::query`]'s correlated count is 531 seconds rather than
    /// 49 ms - a frozen window, measured 2026-08-20.
    ///
    /// Dropping the indexes by hand is exactly what that history looks like from here: there is
    /// no way to build a real pre-change database in a test, and the state is defined by which
    /// indexes exist, not by how they came to be missing.
    #[test]
    fn a_v20_database_missing_the_closure_indexes_gains_them_on_the_next_migrate() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(
            "DROP INDEX idx_art_tag_illustrations_slug;
             DROP INDEX idx_oracle_tag_cards_slug;",
        )
        .unwrap();

        // The ladder is spent: `v < 20` is false, so nothing inside `migrate_single_file`'s blocks can run
        // and only the unconditional tail is left to do this.
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            version, LEGACY_SINGLE_FILE_VERSION,
            "the rung must already be spent"
        );

        migrate_single_file(&conn).unwrap();

        for index in [
            "idx_art_tag_illustrations_slug",
            "idx_oracle_tag_cards_slug",
        ] {
            conn.query_row(
                &format!(
                    "SELECT 1 FROM {m} WHERE type='index' AND name=?1",
                    m = master(&conn)
                ),
                [index],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or_else(|_| panic!("{index} must be restored by a plain re-migrate"));
        }
    }

    /// [`swap_art_tag_staging`] goes through the same replay [`swap_oracle_tag_staging`]
    /// does, and a shared helper is only as good as its least-tested caller. Without this the
    /// art indexes would vanish at the first refresh of the art taxonomy alone, which is the
    /// half of the failure the oracle test cannot see.
    #[test]
    fn the_tag_indexes_survive_an_art_tag_swap() {
        let conn = memory_pair();
        create_art_tag_staging(&conn).unwrap();
        swap_art_tag_staging(&conn).unwrap();
        for index in ["idx_art_tags_norm", "idx_art_tag_illustrations_slug"] {
            conn.query_row(
                &format!(
                    "SELECT 1 FROM {m} WHERE type='index' AND name=?1",
                    m = master(&conn)
                ),
                [index],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or_else(|_| panic!("{index} did not survive the art tag swap"));
        }
    }

    /// The step over the version below it: both columns arrive on `oracle_tags`, and a row that
    /// predates them keeps a blank `id` while its `slug_norm` is filled in by v22.
    ///
    /// **The two are asserted apart because only one of them can be recovered without the
    /// file.** v20 adds both with `DEFAULT ''` — the default is what makes an `ALTER TABLE …
    /// ADD COLUMN` of a `NOT NULL` column legal at all, and `NOT NULL` on both is what lets the
    /// live table and its staging twin share one shape. What that step then *argued* was that
    /// neither value is ever read, because the taxonomy is dropped and rebuilt wholesale on
    /// every refresh. That was wrong by up to a week for `slug_norm`, which `tags::query`
    /// matches every typed needle against, and it shipped as issue #180: an oracle tag search
    /// that answered nothing at all. v22 recomputes it here — see
    /// [`the_oracle_tag_search_answers_over_a_database_that_predates_the_normalised_slug`],
    /// which is the assertion that actually matters.
    ///
    /// `id` stays `''` and that is not the same bug. It is Scryfall's uuid, nothing derives it,
    /// and every reader of it says so in words: `tags::query::not_muted` fences it with
    /// `id <> ''` so one blank-id mute cannot hide a whole taxonomy, and `tag_mute` refuses it
    /// where the reader pressed. The next refresh writes the real one.
    #[test]
    fn the_v20_step_adds_the_uuid_and_the_normalised_slug_over_a_v19_database() {
        let conn = v19_database();
        conn.execute_batch(
            "INSERT INTO oracle_tags (slug, label, description) VALUES ('ramp', 'Ramp', NULL);",
        )
        .unwrap();
        assert_eq!(
            has_column(&conn, "oracle_tags", "id"),
            0,
            "a v19 database may not already carry v20's column"
        );

        migrate_single_file(&conn).unwrap();

        let row: (String, String) = conn
            .query_row(
                "SELECT id, slug_norm FROM oracle_tags WHERE slug = 'ramp'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, (String::new(), "ramp".to_owned()));

        // **And on an upgraded database, not only a fresh one.** The two sibling tests that
        // check these four indexes run over a fresh install, where they could have come from
        // anywhere in the step; here they have to arrive on a database that already carried
        // `oracle_tags`. That is this rung's own thesis turned on itself — an index declared
        // where only a fresh install reaches it is an index every existing reader lacks. For
        // the two `slug_norm` indexes that is a slower search; for the two closure indexes it
        // is a nine-minute freeze, because `tags::query` counts a tag's reach per row.
        for index in [
            "idx_art_tags_norm",
            "idx_oracle_tags_norm",
            "idx_art_tag_illustrations_slug",
            "idx_oracle_tag_cards_slug",
        ] {
            conn.query_row(
                &format!(
                    "SELECT 1 FROM {m} WHERE type='index' AND name=?1",
                    m = master(&conn)
                ),
                [index],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or_else(|_| panic!("{index} must arrive on an upgraded database"));
        }

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
    }

    // ---- v22: the normalised slug, recomputed rather than waited for ------------------
    /// A database at version 21: everything v21 left behind, and none of v22.
    ///
    /// **The rung above it is the one on this ladder with no rewind to perform, and there is
    /// no `UNDO_V22` for the same reason.** Every undo exists because its rung wrote *shape*
    /// — a column a fixture would hit `duplicate column name` on, a table whose
    /// `IF NOT EXISTS` would leave a fixture claiming a version it is not. v22 writes none: it
    /// repairs the contents of one column, so a v21 database and a v22 one are the same
    /// schema and differ only in what `oracle_tags.slug_norm` holds. Renumbering is therefore
    /// the honest whole of *that* step's rewind — which is what [`v22_database`] is — and what
    /// a test seeds afterwards is the rung's real input.
    ///
    /// [`UNDO_V23`] is here because v23 sits above both of them and does write shape. It was
    /// the arrival of that rung which turned this from a fixture with no rewind at all into
    /// one with a rewind that skips exactly one number.
    ///
    /// This is also why it is not on
    /// [`every_version_ends_with_the_same_schema_as_a_fresh_install`]'s list: that test
    /// compares `cards`, `decks` and `deck_categories`, and neither the rung this fixture sits
    /// under nor the one above it touches any of the three.
    fn v21_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} PRAGMA user_version = 21;"
        ))
        .unwrap();
        conn
    }

    /// **Issue #180, and the test the reporter's bug is.** A database that held oracle tags
    /// before v20 can search them the moment it has been migrated — no refresh, no network.
    ///
    /// The failure this pins had every property that makes one expensive: silent, total,
    /// self-healing after up to a week, and sitting beside an art taxonomy that worked
    /// perfectly. v20 added `slug_norm` with `DEFAULT ''`, `tags::query` matches every typed
    /// needle against that column and nothing else, and the taxonomy is only rewritten by a
    /// refresh — which `tags::oracle::REFRESH_INTERVAL_SECS` puts up to seven days away. So the
    /// search answered `[]` to everything, with nothing in `error_log` to say why, while the
    /// rail — which reads `slug` and never `slug_norm` — went on listing the very tags the box
    /// could not find.
    ///
    /// **The fixture is the real upgrade path rather than a hand-built row**: a v19 database
    /// with a tag in it, walked up the whole ladder. A test that inserted `slug_norm = ''`
    /// into a head-version database would prove the backfill runs, not that the ladder ever
    /// reaches it.
    ///
    /// **The needle is spelled three ways and the slug is spelled in neither.** `Spot-Removal`
    /// is how the live file writes it — verified 2026-08-20, and `tags::oracle`'s own ingest
    /// test uses that exact slug — so a backfill that lower-cased without stripping, or
    /// stripped without lower-casing, would still answer one of these and fail the others.
    /// That is the whole hazard `tags::normalize`'s "one copy, deliberately" note describes:
    /// two normalisations that disagree leave both halves self-consistent and the search wrong.
    #[test]
    fn the_oracle_tag_search_answers_over_a_database_that_predates_the_normalised_slug() {
        let conn = v19_database();
        conn.execute_batch(
            "INSERT INTO oracle_tags (slug, label, description)
             VALUES ('Spot-Removal', 'Spot Removal', NULL);",
        )
        .unwrap();

        migrate_single_file(&conn).unwrap();

        // Exact, prefix and substring — the three bands `tags::query` ranks by, so a backfill
        // that satisfied `LIKE '%…%'` by accident could not also answer the exact one.
        for needle in ["Spot Removal", "spot-rem", "removal"] {
            let hits = crate::tags::query::run_tag_search(&conn, needle, "oracle", 50).unwrap();
            assert_eq!(
                hits.iter().map(|h| h.slug.as_str()).collect::<Vec<_>>(),
                ["Spot-Removal"],
                "`{needle}` found no oracle tag",
            );
        }

        // And it is `normalize`'s answer rather than merely *an* answer that matched. The
        // ingest writes this column with that function; a rung that agreed with it on
        // `Spot-Removal` and nowhere else would pass every assertion above.
        let norm: String = conn
            .query_row(
                "SELECT slug_norm FROM oracle_tags WHERE slug = 'Spot-Removal'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(norm, crate::tags::normalize("Spot-Removal"));
    }

    /// The rung leaves a taxonomy a refresh has already written exactly as it found it.
    ///
    /// `WHERE slug_norm = ''` is what makes the backfill a repair rather than a rewrite, and
    /// the row it must not touch is the one a *fresh* install has: v20 creates `art_tags` empty
    /// and `oracle_tags` is rebuilt wholesale by every refresh, so on most databases this step
    /// has nothing to do. Asserted rather than assumed, because a backfill that recomputed
    /// every row would be indistinguishable here until the day `normalize` changed — at which
    /// point it would half-rewrite a taxonomy the ingest had written the other way.
    #[test]
    fn the_v22_step_leaves_an_already_normalised_oracle_tag_alone() {
        let conn = v19_database();
        // A `slug_norm` that is not what `normalize` would answer, standing in for any row the
        // backfill has no business touching.
        conn.execute_batch(
            "INSERT INTO oracle_tags (slug, label, description)
             VALUES ('Spot-Removal', 'Spot Removal', NULL);",
        )
        .unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch("UPDATE oracle_tags SET slug_norm = 'written-by-the-ingest';")
            .unwrap();

        // The ladder is at head, so this is the idempotence pass rather than a second upgrade —
        // which is the case a reader actually gets, once per launch.
        migrate_single_file(&conn).unwrap();

        let norm: String = conn
            .query_row(
                "SELECT slug_norm FROM oracle_tags WHERE slug = 'Spot-Removal'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(norm, "written-by-the-ingest");
    }

    /// A mute is the reader's, and everything around it is rebuilt on a schedule: the card
    /// corpus daily, both taxonomies weekly. Losing one would read as the app forgetting what
    /// the reader hid, so all three rebuilds are driven over it here.
    ///
    /// The assertion at the end is the same rule in its general form — **everything named on
    /// either swap list is dropped by that swap** — which is exactly why `muted_tags` is on
    /// neither and must stay off both.
    #[test]
    fn a_mute_survives_a_card_sync_and_a_taxonomy_rebuild() {
        let conn = memory_pair();
        conn.execute(
            "INSERT INTO muted_tags (namespace, tag_id, slug, muted_at)
             VALUES ('art', 'uuid-1', 'dog', 1)",
            [],
        )
        .unwrap();

        create_oracle_tag_staging(&conn).unwrap();
        swap_oracle_tag_staging(&conn).unwrap();
        create_art_tag_staging(&conn).unwrap();
        swap_art_tag_staging(&conn).unwrap();
        create_staging(&conn).unwrap();
        swap_staging(&conn).unwrap();

        let slug: String = conn
            .query_row("SELECT slug FROM muted_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(slug, "dog");

        assert!(
            !ART_TAG_TABLES
                .iter()
                .chain(ORACLE_TAG_TABLES.iter())
                .any(|(live, _)| *live == "muted_tags"),
            "a swap list is a list of tables the next refresh destroys"
        );
    }

    /// A mute is keyed on Scryfall's stable uuid and on the namespace it was made in, which
    /// is two decisions this drives rather than reads off the DDL.
    ///
    /// The **namespace** is in the key because the two taxonomies are separate files with
    /// separate id spaces, and one id appearing in both must be two mutes. The **id** is in
    /// the key instead of the slug because Tagger renames tags — a mute keyed on a slug would
    /// silently un-mute itself the week the rename landed, which is exactly the week it
    /// mattered. Re-muting the same tag under its new slug is therefore the *same* row.
    #[test]
    fn a_mute_is_one_row_per_namespace_and_tag_id() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let mute = |namespace: &str, tag_id: &str, slug: &str| {
            conn.execute(
                "INSERT INTO muted_tags (namespace, tag_id, slug, muted_at)
                 VALUES (?1, ?2, ?3, 1)",
                rusqlite::params![namespace, tag_id, slug],
            )
        };
        mute("art", "uuid-1", "dog").unwrap();
        mute("oracle", "uuid-1", "dog")
            .expect("the same id in the other namespace is a second mute");

        let again = mute("art", "uuid-1", "hound").expect_err("a renamed tag is the same mute");
        assert!(
            again.to_string().contains("UNIQUE constraint failed"),
            "refused for the key, not for a broken statement: {again}"
        );
    }

    // ---- v23: the wishlist's folders --------------------------------------------------

    /// A database at version 22: everything v22 left behind, and none of v23.
    ///
    /// **It is [`v21_database`] wearing the next number, and that is the honest construction
    /// rather than a shortcut** — the argument that fixture's own doc makes. v22 writes no
    /// shape at all; it recomputes `oracle_tags.slug_norm`, and an in-memory database that has
    /// never ingested a taxonomy has no row for it to recompute. So the two versions are the
    /// same database here, and renumbering is the whole of the difference. The v23 rewind
    /// [`v21_database`] already applies is what makes both of them lack this rung.
    fn v22_database() -> Connection {
        let conn = v21_database();
        conn.execute_batch("PRAGMA user_version = 22;").unwrap();
        conn
    }

    /// [`v22_database`] held the "one step below head" title until v24 arrived and
    /// [`v23_database`] took it — the move [`the_head_minus_one_fixture_really_sits_one_step_below_head`]
    /// records — and it keeps the half of the assertion that is about *this* rung: a database
    /// renumbered to 22 still lacks `wishlist_folders`, and still gets them.
    #[test]
    fn the_v22_fixture_carries_none_of_v23() {
        let conn = v22_database();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 22);
        let folders: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'wishlist_folders'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(folders, 0, "the v23 table must not be there yet");

        migrate_single_file(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
        let folders: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'wishlist_folders'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(folders, 1, "and the v23 step must not have been skipped");
    }

    /// The rung's own shape, in one pass: the table exists, it nests, and a wish written the
    /// way every writer in the crate writes one lands at the **root**.
    ///
    /// `folder_id` is nullable with no default on purpose — the root is the absence of a
    /// filing decision rather than a folder called "root", so nothing has to be created before
    /// the list works and a reader who never makes a folder sees the list they see today.
    #[test]
    fn migrate_creates_the_wishlist_folders_and_files_wishes_at_the_root() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
        // The table exists and nests.
        conn.execute_batch(
            "INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
             VALUES (1, NULL, 'Expensive', 0, 0, 0), (2, 1, 'Someday', 0, 0, 0);",
        )
        .unwrap();
        // A wish lands at the root with no folder named.
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id, name, quantity, created_at, updated_at)
             VALUES ('o1', 'Bolt', 1, 0, 0)",
            [],
        )
        .unwrap();
        let filed: Option<i64> = conn
            .query_row("SELECT folder_id FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(filed, None, "a wish with no folder named is at the root");
    }

    /// **The fourth term of [`WISHLIST_GRAIN`], which is the load-bearing decision of this
    /// rung.** The same oracle card, in two places, is two wishes — which is what makes
    /// "Add to <folder>" always *add* rather than silently move the row the reader already had.
    ///
    /// Both halves are asserted, because only the pair says what the grain is: widening it has
    /// to separate the folders **and** keep biting inside one. A grain that had simply lost
    /// its teeth would pass the first assertion on its own.
    #[test]
    fn the_wishlist_grain_separates_two_folders() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
             VALUES (1, NULL, 'Ordered', 0, 0, 0);",
        )
        .unwrap();
        // The same oracle card, same (absent) printing, same (absent) finish -- twice, in two
        // places. This is what makes "Add to" always add a new wish.
        for folder in [None, Some(1i64)] {
            conn.execute(
                "INSERT INTO wishlist_entries
                    (oracle_id, name, quantity, folder_id, created_at, updated_at)
                 VALUES ('o1', 'Bolt', 1, ?1, 0, 0)",
                rusqlite::params![folder],
            )
            .unwrap();
        }
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2);
        // And the grain still bites *within* one folder.
        let again = conn.execute(
            "INSERT INTO wishlist_entries
                (oracle_id, name, quantity, folder_id, created_at, updated_at)
             VALUES ('o1', 'Bolt', 1, 1, 0, 0)",
            [],
        );
        assert!(
            again.is_err(),
            "two identical wishes in one folder are one wish"
        );
    }

    /// The two `ON DELETE` actions, driven rather than read off the DDL: `parent_id` CASCADEs
    /// and `folder_id` SET NULLs, in the one press where both fire at once.
    ///
    /// `PRAGMA foreign_keys = ON` is set explicitly because SQLite defaults it **off** and the
    /// actions are inert without it — this test would pass vacuously, asserting nothing about
    /// either. [`crate::db::open`] always sets it, so the pragma here is the real launch's
    /// behaviour rather than a test convenience.
    #[test]
    fn deleting_a_wishlist_folder_keeps_its_wishes_and_cascades_its_subfolders() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
             VALUES (1, NULL, 'Expensive', 0, 0, 0), (2, 1, 'Someday', 0, 0, 0);
             INSERT INTO wishlist_entries
                (oracle_id, name, quantity, folder_id, created_at, updated_at)
             VALUES ('o1', 'Bolt', 1, 2, 0, 0);",
        )
        .unwrap();
        conn.execute("DELETE FROM wishlist_folders WHERE id = 1", [])
            .unwrap();
        let folders: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_folders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(folders, 0, "the sub-folder cascades with its parent");
        let filed: Option<i64> = conn
            .query_row("SELECT folder_id FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(filed, None, "the wish survives, un-filed");
    }

    /// The upgrade itself: a database that already has a shopping list gets folders without
    /// losing a wish, and every wish it was carrying surfaces at the root.
    ///
    /// **The rewind here is a full one, spelled out on top of [`UNDO_V23`], and that is the
    /// point of the test rather than housekeeping.** That constant stops short of the column
    /// for the fixtures that share it (see its doc); leaning on it here would re-enter the v23
    /// step with the *four-term* index already in place and the column already there, so the
    /// probe would skip the `ALTER`, the `DROP INDEX`/`CREATE UNIQUE INDEX` pair would rebuild
    /// an index identical to the one it replaced, and nothing in the suite would ever watch the
    /// widening run over a genuinely three-term index with rows underneath it — which is the
    /// only shape a real v22 database has.
    ///
    /// So both indexes that name `folder_id` go, then the column, then the three-term index
    /// comes back: `DROP COLUMN`'s restriction is about indexes and nothing else here, and with
    /// them gone SQLite takes it (measured 2026-08-22). What re-enters `migrate_single_file` is then a
    /// database that has never heard of folders, holding a wish.
    ///
    /// The re-entry this used to be is not lost with it: **every fixture beneath head runs the
    /// step over a column that is already there**, because they all spell [`UNDO_V23`] and then
    /// walk to head, so a blind `ALTER TABLE … ADD COLUMN` would answer `duplicate column name`
    /// in a dozen tests at once. The probe is the one half of this rung that cannot go
    /// unwatched.
    ///
    /// **The upgrade is safe for a reason worth writing down, because a widening unique index
    /// over existing rows is exactly the sort of step that fails in the field and nowhere
    /// else**: `ADD COLUMN` supplies no default, so `folder_id` is NULL on every row and
    /// `coalesce(folder_id, 0)` is the constant 0 across the whole table. The new key is the
    /// old key plus a constant, which makes the widened index strictly more permissive than the
    /// one it replaces — two rows that clash on four terms clashed on three, and the three-term
    /// index would already have refused them.
    #[test]
    fn migrating_a_v22_wishlist_files_every_existing_wish_at_the_root() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id, name, quantity, created_at, updated_at)
             VALUES ('o1', 'Bolt', 3, 0, 0)",
            [],
        )
        .unwrap();
        // Rewind to 22, in full. `UNDO_V23` takes the folder table and `idx_wishlist_folder`;
        // the grain index has to go before the column it names, and the three-term definition
        // that replaces it is a literal for `v9_database`'s reason -- this is a description of
        // history, and history does not change when `WISHLIST_GRAIN` does.
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23}
             DROP INDEX IF EXISTS idx_wishlist_grain;
             ALTER TABLE wishlist_entries DROP COLUMN folder_id;
             CREATE UNIQUE INDEX idx_wishlist_grain
                ON wishlist_entries (coalesce(oracle_id, ''), coalesce(card_id, ''),
                                     coalesce(preferred_finish, ''));
             PRAGMA user_version = 22;"
        ))
        .unwrap();
        assert_eq!(
            has_column(&conn, "wishlist_entries", "folder_id"),
            0,
            "the fixture is a real v22 database, not head wearing a v22 label"
        );

        migrate_single_file(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
        let (qty, filed): (i64, Option<i64>) = conn
            .query_row(
                "SELECT quantity, folder_id FROM wishlist_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (qty, filed),
            (3, None),
            "the wish survives the rung, at the root"
        );
    }

    // ---- v24: the collection's folders -------------------------------------------------

    /// Rewind a head-shaped database to version 23: everything v23 left behind, and none of
    /// v24.
    ///
    /// **The rewind here is a full one, spelled out on top of [`UNDO_V24`], and that is the
    /// point of the helper rather than housekeeping** —
    /// [`migrating_a_v22_wishlist_files_every_existing_wish_at_the_root`]'s argument one table
    /// over. That constant stops short of the column for the fixtures that share it (see its
    /// doc); leaning on it here would re-enter the v24 step with the column already there and
    /// the *eleven*-column index already in place, so the probe would skip the `ALTER`, the
    /// `DROP INDEX`/`CREATE UNIQUE INDEX` pair would rebuild an index identical to the one it
    /// replaced, and nothing would ever watch the widening run over a genuinely ten-column
    /// index — which is the only shape a real v23 database has.
    ///
    /// **And a partial rewind here is not merely weak, it does not work.** `libsqlite3-sys`
    /// builds the bundled amalgamation with `SQLITE_DEFAULT_FOREIGN_KEYS=1`, so foreign keys
    /// are ON for every connection in this crate — dropping `collection_folders` while
    /// `collection_entries.folder_id` still declares `REFERENCES collection_folders(id)` makes
    /// the *next write to `collection_entries`* fail with
    /// `no such table: main.collection_folders`. So the column goes before the table does, and
    /// the two indexes that name it go before that: `DROP COLUMN`'s restriction is about
    /// indexes and nothing else here.
    ///
    /// The re-entry this is not is covered elsewhere: **every fixture beneath head spells
    /// [`UNDO_V24`] and then walks to head**, so a dozen tests run the step over a column that
    /// is already there and a blind `ALTER` would answer `duplicate column name` in all of them
    /// at once.
    ///
    /// The ten-column definition is a literal for [`v9_database`]'s reason — this is a
    /// description of history, and history does not change when [`COLLECTION_GRAIN`] does.
    fn schema_at_23(conn: &Connection) {
        migrate_single_file(conn).unwrap();
        conn.execute_batch(&format!(
            "DROP INDEX IF EXISTS idx_collection_folder;
             DROP INDEX IF EXISTS idx_collection_grain;
             ALTER TABLE collection_entries DROP COLUMN folder_id;
             {UNDO_V26} {UNDO_V25} {UNDO_V24}
             CREATE UNIQUE INDEX idx_collection_grain ON collection_entries (
                 card_id, finish, condition, lang, altered, signed, proxy, misprint,
                 coalesce(serial_number, ''), coalesce(grading, '')
             );
             PRAGMA user_version = 23;"
        ))
        .unwrap();
    }

    /// A database at version 23, as a fixture. [`schema_at_23`] with the connection made for
    /// it — the shape every other `vNN_database` on this ladder has.
    fn v23_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema_at_23(&conn);
        conn
    }

    /// [`v25_database`] must really sit one step below head, or the tests below it are a fresh
    /// install compared against itself. The next step added to the ladder renumbers this
    /// fixture, and `LEGACY_SINGLE_FILE_VERSION - 1` is the line that says so.
    ///
    /// **The fixture named here has changed twelve times** — v14's, then v15's, v16's, v17's,
    /// v18's, v19's, v20's, v21's, v22's, v23's, v24's, now v25's — and each move was this
    /// assertion going red, which is the whole reason it is written against `LEGACY_SINGLE_FILE_VERSION - 1`
    /// rather than a number.
    ///
    /// **v26 puts this test the usual way round again.** v25 was the one rung that took things
    /// away, so head-minus-one had to be asked what it still *had*; v26 only adds, so a real v25
    /// database is one that lacks `decks.bracket` and the three combo tables and gains all four.
    /// [`the_v24_fixture_carries_none_of_v25`] keeps the inverted half, which is about v25's own
    /// rung and is still worth driving.
    #[test]
    fn the_head_minus_one_fixture_really_sits_one_step_below_head() {
        let conn = v25_database();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            version,
            LEGACY_SINGLE_FILE_VERSION - 1,
            "one step below head"
        );
        assert_eq!(
            has_column(&conn, "decks", "bracket"),
            0,
            "the fixture is a real v25 database, not head wearing a v25 label"
        );
        assert_eq!(
            combo_table_count(&conn),
            0,
            "and none of v26's three tables may be standing yet"
        );

        migrate_single_file(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
        assert_eq!(
            has_column(&conn, "decks", "bracket"),
            1,
            "and the v26 step must not have been skipped"
        );
        assert_eq!(combo_table_count(&conn), 3);
    }

    /// How many of v26's three tables `sqlite_master` carries — the shape
    /// [`oracle_tag_table_count`] has one feed over, so a fixture assertion is one number rather
    /// than three `EXISTS` queries that can each be forgotten.
    fn combo_table_count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM sqlite_master
              WHERE type = 'table' AND name IN ('combos','combo_cards','combo_meta')",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// [`v24_database`] kept the "one step below head" title until v26 arrived and
    /// [`v25_database`] took it, and it keeps the half of the assertion that is about *v25's*
    /// rung — the inverted half, because v25 is the one rung on this ladder that takes something
    /// away. A real v24 database still carries `deck_allocations`, `decks.is_built` and the
    /// `app_meta` flag, [`schema_at_24`] pays the full rewind that puts all three back, and this
    /// is the one fixture that can be asked about any of them.
    #[test]
    fn the_v24_fixture_carries_none_of_v25() {
        let conn = v24_database();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 24);
        assert_eq!(
            has_column(&conn, "decks", "is_built"),
            1,
            "the fixture is a real v24 database, not head wearing a v24 label"
        );
        let ledger: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'deck_allocations'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ledger, 1, "the table v25 takes must still be there");
        let flag: i64 = conn
            .query_row(
                "SELECT count(*) FROM app_meta WHERE key = 'deck_driven_collection'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, 1, "and so must the row v25 deletes");

        migrate_single_file(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
        let ledger: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'deck_allocations'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ledger, 0, "and the v25 step must not have been skipped");
        assert_eq!(has_column(&conn, "decks", "is_built"), 0);
        let flag: i64 = conn
            .query_row(
                "SELECT count(*) FROM app_meta WHERE key = 'deck_driven_collection'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, 0, "the flag the rung deletes is really deleted");
    }

    /// [`v23_database`] kept the "one step below head" title until v25 arrived and
    /// [`v24_database`] took it, and it keeps the half of the assertion that is about *v24's*
    /// rung: a database at 23 lacks `collection_folders` and the eleventh grain term, and gets
    /// both.
    #[test]
    fn the_v23_fixture_carries_none_of_v24() {
        let conn = v23_database();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 23);
        assert_eq!(
            has_column(&conn, "collection_entries", "folder_id"),
            0,
            "the fixture is a real v23 database, not head wearing a v23 label"
        );
        let folders: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'collection_folders'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(folders, 0, "the v24 table must not be there yet");

        migrate_single_file(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
        let folders: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'collection_folders'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(folders, 1, "and the v24 step must not have been skipped");
    }

    /// The rung's own shape, in one pass: the table is there, and the grain index names the
    /// folder.
    #[test]
    fn v24_adds_collection_folders_and_the_folder_term() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            version, LEGACY_SINGLE_FILE_VERSION,
            "the rung must reach the constant"
        );

        // The table exists with both partial indexes.
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('collection_folders')")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for want in ["id", "parent_id", "name", "kind", "deck_id", "sort_order"] {
            assert!(cols.iter().any(|c| c == want), "missing column {want}");
        }

        // `folder_id` is the grain's eleventh term, and the index says so.
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = 'idx_collection_grain'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            sql.contains("coalesce(folder_id, 0)"),
            "the grain index was not rebuilt with the folder term: {sql}"
        );
    }

    /// The second pass has to be a no-op rather than `duplicate column name`, which is the
    /// whole reason the step probes `pragma_table_info` instead of issuing a blind `ALTER`.
    #[test]
    fn the_v24_rung_is_idempotent_over_an_already_upgraded_database() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        migrate_single_file(&conn).unwrap(); // the second pass must be a no-op, not `duplicate column name`
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
    }

    /// The eleventh term, exercised the way [`COLLECTION_GRAIN`]'s doc argues for it: the same
    /// printing in a folder is a **different row** from the same printing at the root, and two
    /// root rows for one printing still collide.
    ///
    /// Without the term the middle insert would fold into the first and the copies would appear
    /// to *move* into the folder — which is a filing decision being undone by an add.
    #[test]
    fn the_folder_is_part_of_what_makes_two_collection_rows_the_same_row() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute(
            "INSERT INTO collection_folders (name, kind, sort_order, created_at, updated_at)
             VALUES ('Binder', 'user', 0, 0, 0)",
            [],
        )
        .unwrap();
        let folder = conn.last_insert_rowid();
        let row = |folder: Option<i64>| {
            conn.execute(
                "INSERT INTO collection_entries
                     (card_id, set_code, collector_number, finish, condition, quantity,
                      folder_id, created_at, updated_at)
                 VALUES ('c1', 'lea', '1', 'nonfoil', 'NM', 1, ?1, 0, 0)",
                params![folder],
            )
        };
        row(None).expect("the root row inserts");
        row(Some(folder))
            .expect("the SAME printing in a folder is a DIFFERENT row — this is the whole point");
        row(None).expect_err("but two root rows for one printing still collide");
    }

    /// The one statement in this rung that is not additive, over a database that really is at
    /// 23 — [`schema_at_23`], so the ten-column index is what the row is written under and the
    /// widening is watched running over it rather than over an index identical to itself.
    #[test]
    fn the_v24_rung_deletes_rows_that_hold_no_copies() {
        let conn = Connection::open_in_memory().unwrap();
        schema_at_23(&conn); // fixture helper: migrate, then rewind user_version to 23
        conn.execute(
            "INSERT INTO collection_entries
                 (card_id, set_code, collector_number, finish, condition, quantity,
                  created_at, updated_at)
             VALUES ('gone', 'lea', '1', 'nonfoil', 'NM', 0, 0, 0)",
            [],
        )
        .unwrap();
        migrate_single_file(&conn).unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE card_id = 'gone'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            left, 0,
            "a row holding no copies is not a row the reader owns"
        );
    }

    // ---- v25: the deck groups, and the ledger they replace ------------------------------

    /// Rewind a head-shaped database to version 24: everything v24 left behind, and none of
    /// v25.
    ///
    /// **This is the awkward rewind on the ladder, because v25 is the first rung that takes a
    /// table and a column *away*.** Every undo above it puts back something a step added; this
    /// one has to put back `deck_allocations`, `decks.is_built` and the `app_meta` flag, and
    /// then take away the folder rows the rung inserted. [`UNDO_V25`] is that batch, and it is
    /// shared with every fixture beneath head for the reason each of them spells [`UNDO_V24`]:
    /// they all walk to head first, so every statement v25 writes has already run over them.
    ///
    /// **Re-adding a dropped column is not symmetrical with dropping it**, and the asymmetry is
    /// the trap [`schema_at_23`] warns about one rung down. `ALTER TABLE … ADD COLUMN` has no
    /// `IF NOT EXISTS` and always appends, so `decks.is_built` comes back at the *end* of the
    /// table rather than where v8 put it. That is survivable here and only here: v25 drops the
    /// column again on the way back up, so
    /// [`every_version_ends_with_the_same_schema_as_a_fresh_install`] compares two `decks`
    /// tables that have both lost it, in the same order. A rewind that left the column standing
    /// would fail that test on ordinals, which is the failure it exists to catch.
    fn schema_at_24(conn: &Connection) {
        migrate_single_file(conn).unwrap();
        conn.execute_batch(&format!("{UNDO_V26} {UNDO_V25} PRAGMA user_version = 24;"))
            .unwrap();
    }

    /// A database at version 24, as a fixture. [`schema_at_24`] with the connection made for
    /// it — the shape every other `vNN_database` on this ladder has.
    fn v24_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema_at_24(&conn);
        conn
    }

    /// Rewind a head-shaped database to version 25 — **head minus one since v26**, and the
    /// shortest rewind on the ladder: v26 adds and takes nothing away, so [`UNDO_V26`] alone is
    /// the whole of it.
    ///
    /// The `ALTER TABLE decks DROP COLUMN bracket` inside it is what makes this a real v25
    /// database rather than head wearing a label: the v26 rung's `ADD COLUMN` has no
    /// `IF NOT EXISTS`, so a fixture that skipped it would die on the way back up rather than
    /// quietly mislabel itself. [`UNDO_V14`]'s quieter failure is the one the three
    /// `DROP TABLE`s prevent.
    fn schema_at_25(conn: &Connection) {
        migrate_single_file(conn).unwrap();
        conn.execute_batch(&format!("{UNDO_V26} PRAGMA user_version = 25;"))
            .unwrap();
    }

    /// A database at version 25, as a fixture. [`schema_at_25`] with the connection made for
    /// it — the shape every other `vNN_database` on this ladder has.
    fn v25_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema_at_25(&conn);
        conn
    }

    /// A deck, by the name the v25 tests read it under. [`deck`] under a `seed_` prefix so the
    /// six conversion tests below name their three seeds the same way.
    fn seed_deck(conn: &Connection, name: &str) -> i64 {
        deck(conn, name)
    }

    /// One collection row, nonfoil NM, optionally already filed. [`entry`] plus the folder,
    /// because the conversion has to work over a reader who had already made themselves a
    /// binder on v24 — the copies a deck claims move out of *wherever* they were.
    fn seed_entry(conn: &Connection, card_id: &str, quantity: i64, folder: Option<i64>) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
                 created_at,updated_at)
             VALUES (?1,'lea','161','en','nonfoil','NM',?2,?3,unixepoch(),unixepoch())
             RETURNING id",
            rusqlite::params![card_id, quantity, folder],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The same row with copies **on the trade list** — [`seed_entry`] plus the one column a
    /// split can silently duplicate, since no `CHECK` ties `tradelist_quantity` to `quantity`
    /// and nothing would go red if it did.
    fn seed_entry_traded(conn: &Connection, card_id: &str, quantity: i64, tradelist: i64) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 tradelist_quantity,created_at,updated_at)
             VALUES (?1,'lea','161','en','nonfoil','NM',?2,?3,unixepoch(),unixepoch())
             RETURNING id",
            rusqlite::params![card_id, quantity, tradelist],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The same row with a story on it — the columns a split must carry onto the placement
    /// rather than handing the deck a bare row.
    fn seed_entry_full(
        conn: &Connection,
        card_id: &str,
        quantity: i64,
        condition: &str,
        purchase_price: Option<f64>,
        acquisition_source: Option<&str>,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,condition_original,
                 quantity,tradelist_quantity,purchase_price,purchase_currency,acquired_at,
                 acquisition_source,notes,tags,created_at,updated_at)
             VALUES (?1,'lea','161','en','nonfoil',?3,'GD',?2,0,?4,'USD','2021-04-01',?5,
                     'shelf 3','[\"pet\"]',unixepoch(),unixepoch())
             RETURNING id",
            rusqlite::params![
                card_id,
                quantity,
                condition,
                purchase_price,
                acquisition_source
            ],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One deck's claim on one collection entry, on a database that still has a ledger to
    /// write it in. A reservation, never a transfer — which is the whole of what v25 changes.
    fn seed_allocation(conn: &Connection, deck_id: i64, entry_id: i64, quantity: i64) -> i64 {
        conn.query_row(
            "INSERT INTO deck_allocations
                (deck_id, collection_entry_id, quantity, created_at, updated_at)
             VALUES (?1,?2,?3,unixepoch(),unixepoch()) RETURNING id",
            rusqlite::params![deck_id, entry_id, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The conversion, at the grain that decides whether the upgrade feels like a regression:
    /// a claim on *some* of a row's copies splits that row in two.
    #[test]
    fn v25_converts_a_claim_into_a_placement_and_splits_the_row() {
        let conn = Connection::open_in_memory().unwrap();
        schema_at_24(&conn);
        let deck = seed_deck(&conn, "Mono-Red");
        // Four copies, two of them claimed by the deck.
        let entry = seed_entry(&conn, "bolt", 4, None);
        seed_allocation(&conn, deck, entry, 2);

        migrate_single_file(&conn).unwrap();

        let folder: i64 = conn
            .query_row(
                "SELECT id FROM collection_folders WHERE deck_id = ?1",
                params![deck],
                |r| r.get(0),
            )
            .expect("the deck got its group");
        let filed: i64 = conn
            .query_row(
                "SELECT quantity FROM collection_entries WHERE folder_id = ?1",
                params![folder],
                |r| r.get(0),
            )
            .unwrap();
        let loose: i64 = conn
            .query_row(
                "SELECT quantity FROM collection_entries WHERE folder_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            (filed, loose),
            (2, 2),
            "the row splits; no copy is invented or lost"
        );
    }

    /// The other half of the split: when the claim was for everything, there is no remainder
    /// and the source row goes rather than staying behind holding nothing.
    #[test]
    fn v25_moves_the_whole_row_when_every_copy_was_claimed() {
        let conn = Connection::open_in_memory().unwrap();
        schema_at_24(&conn);
        let deck = seed_deck(&conn, "Mono-Red");
        let entry = seed_entry(&conn, "bolt", 2, None);
        seed_allocation(&conn, deck, entry, 2);
        migrate_single_file(&conn).unwrap();
        let loose: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE folder_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            loose, 0,
            "a fully claimed row leaves nothing behind at the root"
        );
    }

    /// The clamp, which is the one line of the conversion that is not obvious and the one the
    /// old ledger's own laxity requires.
    #[test]
    fn v25_clamps_a_claim_that_out_counts_the_row_it_claims() {
        // The old ledger could out-claim a row later stepped down; `owned_by_oracle`'s
        // `min(a.quantity, e.quantity)` papered over it. The conversion must not invent copies.
        let conn = Connection::open_in_memory().unwrap();
        schema_at_24(&conn);
        let deck = seed_deck(&conn, "Mono-Red");
        let entry = seed_entry(&conn, "bolt", 1, None);
        seed_allocation(&conn, deck, entry, 3);
        migrate_single_file(&conn).unwrap();
        let total: i64 = conn
            .query_row("SELECT sum(quantity) FROM collection_entries", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(total, 1, "one copy in, one copy out");
    }

    /// The trade list is a **promise about copies**, so a split divides it and can never copy
    /// it — [`crate::collection_folders::take_copies`]' rule, which the rung has to spell for
    /// itself because it splits rows before that function's table shape exists to be called.
    ///
    /// **Nothing in the database would catch the other answer.** There is no CHECK tying
    /// `tradelist_quantity` to `quantity`, so a placement and a remainder that each claim the
    /// whole trade list is a state the rung can commit silently — and every writer that comes
    /// afterwards (`add_entry`, `set_quantity`, `update_entry`, `take_copies`) clamps against
    /// exactly that invariant, so the upgrade would be the one thing in the crate that breaks
    /// it. **A rung is one-shot**: it would be wrong on every database that ever upgrades.
    #[test]
    fn v25_splits_the_tradelist_rather_than_duplicating_it() {
        let conn = Connection::open_in_memory().unwrap();
        schema_at_24(&conn);
        let deck = seed_deck(&conn, "Mono-Red");
        // Four copies, three of them offered for trade; the deck claims two of the four.
        let entry = seed_entry_traded(&conn, "bolt", 4, 3);
        seed_allocation(&conn, deck, entry, 2);

        migrate_single_file(&conn).unwrap();

        let rows: Vec<(i64, i64)> = {
            let mut stmt = conn
                .prepare("SELECT quantity, tradelist_quantity FROM collection_entries ORDER BY id")
                .unwrap();
            let read = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            read
        };
        assert_eq!(rows.len(), 2, "the row splits: a placement and a remainder");
        for (quantity, tradelist) in &rows {
            assert!(
                tradelist <= quantity,
                "a trade list bigger than the pile it is drawn from is not a promise: \
                 {tradelist} of {quantity}"
            );
        }
        let offered: i64 = rows.iter().map(|(_, t)| t).sum();
        assert_eq!(
            offered, 3,
            "the promise is divided between the halves, never handed to both"
        );
    }

    /// A split must not hand the deck a bare row.
    #[test]
    fn v25_carries_the_provenance_onto_the_placement() {
        // A split must not hand the deck a bare row: the copies in the deck are the same physical
        // cards, bought on the same day for the same money.
        let conn = Connection::open_in_memory().unwrap();
        schema_at_24(&conn);
        let deck = seed_deck(&conn, "Mono-Red");
        let entry = seed_entry_full(&conn, "bolt", 4, "LP", Some(450.0), Some("Card Kingdom"));
        seed_allocation(&conn, deck, entry, 1);
        migrate_single_file(&conn).unwrap();
        let (cond, price, source): (String, Option<f64>, Option<String>) = conn
            .query_row(
                "SELECT e.condition, e.purchase_price, e.acquisition_source
                   FROM collection_entries e JOIN collection_folders f ON f.id = e.folder_id
                  WHERE f.deck_id = ?1",
                params![deck],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(cond, "LP");
        assert_eq!(price, Some(450.0));
        assert_eq!(source.as_deref(), Some("Card Kingdom"));
    }

    /// The cabinet the rung files into: one holding area for the whole database, and one group
    /// per deck — archived decks included, because an archived deck still holds its cards.
    #[test]
    fn v25_leaves_exactly_one_removed_folder_and_one_group_per_deck() {
        let conn = Connection::open_in_memory().unwrap();
        schema_at_24(&conn);
        seed_deck(&conn, "A");
        seed_deck(&conn, "B");
        migrate_single_file(&conn).unwrap();
        let removed: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_folders WHERE kind = 'removed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let groups: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_folders WHERE kind = 'deck'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((removed, groups), (1, 2));
    }

    /// And what the rung takes away, over a *fresh* install — the population that never had a
    /// claim to convert and must still end up without the ledger, the flag or the column.
    #[test]
    fn v25_drops_the_ledger_the_flag_and_the_built_column() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        // One name rather than a loop over one name — `clippy::single_element_loop`, and the
        // loop was only ever a place for the next table this rung takes to be added.
        let gone = "deck_allocations";
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                params![gone],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "{gone} is still here");
        let built: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('decks') WHERE name = 'is_built'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(built, 0);
        let flag: i64 = conn
            .query_row(
                "SELECT count(*) FROM app_meta WHERE key = 'deck_driven_collection'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, 0);
    }

    /// A database with no allocations at all — a fresh install, or one that had deck-driven
    /// on — must be completely unaffected: every deck still gets its empty group, and every
    /// card stays exactly where the reader filed it.
    #[test]
    fn v25_leaves_a_database_with_no_claims_exactly_where_it_was() {
        let conn = Connection::open_in_memory().unwrap();
        schema_at_24(&conn);
        let deck = seed_deck(&conn, "Mono-Red");
        let binder: i64 = conn
            .query_row(
                "INSERT INTO collection_folders (name, kind, sort_order, created_at, updated_at)
                 VALUES ('Binder', 'user', 0, unixepoch(), unixepoch()) RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        seed_entry(&conn, "bolt", 4, Some(binder));
        seed_entry(&conn, "shock", 2, None);

        migrate_single_file(&conn).unwrap();

        let group: i64 = conn
            .query_row(
                "SELECT id FROM collection_folders WHERE deck_id = ?1",
                params![deck],
                |r| r.get(0),
            )
            .expect("the deck still gets its group");
        let filed: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE folder_id = ?1",
                params![group],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(filed, 0, "an empty group, and nothing swept into it");
        let (in_binder, at_root): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT quantity FROM collection_entries WHERE folder_id = ?1),
                        (SELECT quantity FROM collection_entries WHERE folder_id IS NULL)",
                params![binder],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (in_binder, at_root),
            (4, 2),
            "every card stays where it was"
        );
    }

    // ---- v26: the bracket column, and the combo feed's tables ---------------------------

    /// The rung over the version below it: a deck that already existed gains `bracket` reading
    /// **0**, which is Auto, and the three combo tables arrive.
    ///
    /// **The deck is seeded into the v25 fixture before the migration and not after**, which is
    /// the whole of what this test is for. A fresh install has no decks, so every deck in it is
    /// born with the column's DEFAULT and the question "what does an *existing* deck read" is
    /// one only an upgrade fixture can answer — the trap `src-tauri/CLAUDE.md` states as *a
    /// fresh worktree is a fresh install and is the one population that cannot show it*.
    #[test]
    fn v26_gives_an_existing_deck_the_auto_bracket_and_creates_the_combo_tables() {
        let conn = v25_database();
        let deck_id = deck(&conn, "Atraxa");
        assert_eq!(has_column(&conn, "decks", "bracket"), 0);

        migrate_single_file(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
        let bracket: i64 = conn
            .query_row("SELECT bracket FROM decks WHERE id = ?1", [deck_id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            bracket,
            crate::deck::AUTO_BRACKET,
            "a deck that predates the column has not answered the question — it is on Auto"
        );
        assert_eq!(combo_table_count(&conn), 3);
    }

    /// The column is `NOT NULL`, so no deck can ever read "no answer" — the sentinel is the
    /// answer, and the difference matters to every reader of it.
    ///
    /// Driven rather than trusted, because `NOT NULL DEFAULT 0` on an `ALTER TABLE … ADD COLUMN`
    /// is exactly the pair `src-tauri/CLAUDE.md` warns about: a default is a promise to a
    /// population, and the only way to know which population it is lying to is to try to write
    /// the value it is supposed to make impossible.
    #[test]
    fn a_deck_can_never_carry_a_null_bracket() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let id = deck(&conn, "Atraxa");
        let err = conn
            .execute("UPDATE decks SET bracket = NULL WHERE id = ?1", [id])
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("NOT NULL"),
            "a NULL bracket must be refused by the column: {err}"
        );
    }

    /// **The range is not the database's**, and this is the assertion that says so out loud
    /// rather than leaving the next reader to discover it from a bug report.
    ///
    /// `ALTER TABLE … ADD COLUMN` *can* carry a CHECK — v19's `deck_cards.finish` does, and
    /// `the_deck_card_finish_column_refuses_nonfoil` proves it — so the absence of one here is
    /// a choice: a command parameter reaches this column, and `deck::valid_bracket` can say
    /// which number was wrong and what the legal ones are where `CHECK constraint failed` names
    /// only the constraint. `decks.game_key`'s arrangement, one column along.
    #[test]
    fn the_bracket_column_carries_no_check_because_rust_is_the_fence() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let id = deck(&conn, "Atraxa");
        conn.execute("UPDATE decks SET bracket = 9 WHERE id = ?1", [id])
            .expect("the column itself takes any integer — the fence is deck::valid_bracket");
        assert_eq!(
            crate::deck::update_deck(
                &conn,
                id,
                &crate::deck::DeckPatch {
                    bracket: Some(9),
                    ..Default::default()
                },
            )
            .unwrap_err(),
            crate::deck::BAD_BRACKET,
            "and the command is where 9 is refused"
        );
    }

    /// The watermark holds one row, and **the two stamps are nullable in opposite directions**
    /// — which is the whole of how "never ingested" is spelled.
    ///
    /// `fetched_at` NULL means the feed has never been ingested here, a supported state the
    /// settings panel and the bracket estimator both have to be able to read; `checked_at` is
    /// `NOT NULL` because a row exists only once something has asked. Getting that pair the
    /// wrong way round would make a database that has never downloaded anything
    /// indistinguishable from one whose last check found nothing new, and the panel would say
    /// "up to date" about a table with no rows in it.
    ///
    /// The `CHECK (id = 1)` is the "one row, ever" that `oracle_tag_meta` has, driven the same
    /// way: a second row is what a refresh that forgot its `INSERT OR REPLACE` would leave.
    #[test]
    fn the_combo_watermark_is_one_row_and_says_when_it_has_never_ingested() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();

        conn.execute_batch(
            "INSERT INTO combo_meta (id, etag, stamp, fetched_at, checked_at)
                VALUES (1, NULL, NULL, NULL, 1800000000);",
        )
        .expect("a database that has asked and never ingested is a row with a NULL fetched_at");
        let never: Option<i64> = conn
            .query_row("SELECT fetched_at FROM combo_meta WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(never, None);

        // **The other stamp, probed on `id = 1` in a database of its own.** Reaching for a
        // second id here would have been the trap this test caught in its own first draft: an
        // `INSERT … VALUES (2, NULL)` is refused by `CHECK (id = 1)` before nullability is ever
        // consulted, so the assertion passed whether `checked_at` was `NOT NULL` or not — a
        // green test measuring the wrong constraint. The mutation that survived it was
        // `checked_at INTEGER`, and this is the shape that kills it.
        let fresh = Connection::open_in_memory().unwrap();
        migrate_single_file(&fresh).unwrap();
        let no_stamp = fresh
            .execute_batch("INSERT INTO combo_meta (id, checked_at) VALUES (1, NULL);")
            .unwrap_err()
            .to_string();
        assert!(
            no_stamp.contains("NOT NULL"),
            "a row exists only once something has asked: {no_stamp}"
        );

        let second = conn
            .execute_batch("INSERT INTO combo_meta (id, checked_at) VALUES (2, 1);")
            .unwrap_err()
            .to_string();
        assert!(second.contains("CHECK"), "one row, ever: {second}");
    }

    /// The staging twins have to match the live tables column for column, because the swap is a
    /// rename and what the ingest filled *becomes* the live table.
    /// [`the_oracle_tag_staging_tables_match_the_live_ones`]'s fence, one feed over.
    #[test]
    fn the_combo_staging_tables_match_the_live_ones() {
        let conn = memory_pair();
        create_combo_staging(&conn).unwrap();

        for (live, staging) in COMBO_TABLES {
            let want = table_shape(&conn, live);
            assert!(!want.is_empty(), "{live} must exist at head");
            assert_eq!(
                table_shape(&conn, staging),
                want,
                "`{staging}` must match `{live}`"
            );
        }
    }

    /// **The trap the swap exists to avoid.** A rename carries the *staging* table's indexes
    /// rather than the live table's, and [`COMBO_STAGING_SQL`] creates none — so a swap that
    /// forgot [`COMBO_INDEXES_SQL`] would leave `combo_cards` unindexed after the very first
    /// refresh, with nothing going red and nothing in the log. `the_tag_indexes_survive_a_*`
    /// are the two fences this one is copied from, and they were written after the same trap
    /// was measured at 531 seconds one feed over.
    #[test]
    fn the_combo_indexes_survive_a_swap() {
        let conn = memory_pair();
        create_combo_staging(&conn).unwrap();
        swap_combo_staging(&conn).unwrap();
        for index in ["idx_combo_cards_combo", "idx_combo_cards_oracle"] {
            conn.query_row(
                &format!(
                    "SELECT 1 FROM {m} WHERE type='index' AND name=?1",
                    m = master(&conn)
                ),
                [index],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or_else(|_| panic!("{index} did not survive the combo swap"));
        }
    }

    /// And the key survives it too. `combo_cards_staging` is declared against
    /// **`combos_staging`**, because a staging child pointed at the live parent would be
    /// checked against the previous ingest's ids on every insert; what turns that clause into
    /// the live one is SQLite rewriting a `REFERENCES` when the table it names is renamed.
    ///
    /// **Asserted rather than believed**, because it is a behaviour of the engine rather than
    /// of this code, it is conditional on foreign keys being on, and its failure is silent: the
    /// swap would succeed, the rows would be there, and `combo_cards` would simply have stopped
    /// being able to lose its orphans.
    #[test]
    fn the_swapped_combo_cards_still_reference_combos() {
        let conn = memory_pair();
        create_combo_staging(&conn).unwrap();
        swap_combo_staging(&conn).unwrap();

        let (table, on_delete): (String, String) = conn
            .query_row(
                "SELECT \"table\", on_delete FROM pragma_foreign_key_list('combo_cards')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("combo_cards must still declare a foreign key after the swap");
        assert_eq!(table, "combos");
        assert_eq!(on_delete, "CASCADE");

        // And it is enforced, which is the thing the clause is for: a combo that goes takes its
        // card list with it rather than leaving rows the match query would count.
        conn.execute_batch(
            "INSERT INTO combos (id,bracket_tag,card_count,template_count,identity,produces)
                VALUES ('c-1','R',2,0,'ub','Infinite mill');
             INSERT INTO combo_cards (combo_id,oracle_id,name,quantity,must_be_commander)
                VALUES ('c-1','oid-thoracle','Thassa''s Oracle',1,0);
             DELETE FROM combos WHERE id = 'c-1';",
        )
        .unwrap();
        let left: i64 = conn
            .query_row("SELECT count(*) FROM combo_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "the cascade must take the combo's cards with it");
    }

    /// The swap is a rename, so the previous ingest's rows have to be **gone** rather than
    /// merged with — a refresh that appended would leave every combo Spellbook has ever
    /// published, including the ones its editors have since retracted.
    /// [`the_oracle_tag_swap_replaces_rather_than_merges`]'s assertion, one feed over.
    #[test]
    fn the_combo_swap_replaces_rather_than_merges() {
        let conn = memory_pair();
        conn.execute_batch(
            "INSERT INTO combos (id,bracket_tag,card_count,template_count,identity,produces)
                VALUES ('retired','C',2,0,'w','Nothing much');
             INSERT INTO combo_cards (combo_id,oracle_id,name,quantity,must_be_commander)
                VALUES ('retired','oid-1','Old Card',1,0);",
        )
        .unwrap();

        create_combo_staging(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO combos_staging
                (id,bracket_tag,card_count,template_count,identity,produces,popularity)
                VALUES ('fresh','R',2,0,'ub','Infinite mill',9001);
             INSERT INTO combo_cards_staging
                (combo_id,oracle_id,name,quantity,must_be_commander)
                VALUES ('fresh','oid-thoracle','Thassa''s Oracle',1,0);",
        )
        .unwrap();
        // **Inside a transaction, which is the contract and not decoration.** The watermark
        // commits with the rows, so this is the only way the swap is ever actually called — and
        // it is where the two `ALTER TABLE … RENAME`s and the `REFERENCES` rewrite they trigger
        // have to work. Driven here because a swap that only ever ran in autocommit in tests
        // would be a swap nobody had tried the way Task B uses it.
        let tx = conn.unchecked_transaction().unwrap();
        swap_combo_staging(&tx).unwrap();
        tx.execute_batch(
            "INSERT OR REPLACE INTO combo_meta (id, etag, stamp, fetched_at, checked_at,
                                                combo_count, skipped)
                VALUES (1, NULL, '2026-08-27T03:12:44Z', 1800000000, 1800000000, 1, 0);",
        )
        .unwrap();
        tx.commit().unwrap();

        let ids: Vec<String> = conn
            .prepare("SELECT id FROM combos ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            ids,
            vec!["fresh".to_owned()],
            "the retired combo must be gone"
        );
        let cards: i64 = conn
            .query_row("SELECT count(*) FROM combo_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cards, 1);
        for (_, staging) in COMBO_TABLES {
            assert_eq!(
                table_count(&conn, staging),
                0,
                "{staging} must be renamed away"
            );
        }
    }

    /// A refused or failed run leaves the staging tables owing, and dropping them may not touch
    /// the rows the last successful ingest left standing.
    /// [`dropping_the_art_staging_tables_leaves_the_live_ones_standing`]'s assertion.
    #[test]
    fn dropping_the_combo_staging_tables_leaves_the_live_ones_standing() {
        let conn = memory_pair();
        create_combo_staging(&conn).unwrap();
        // A staged child row, so the drop is walked over a table the cascade could reach —
        // which is the ordering `drop_combo_staging`'s doc is about.
        conn.execute_batch(
            "INSERT INTO combos_staging
                (id,bracket_tag,card_count,template_count,identity,produces)
                VALUES ('c-1','R',1,0,'u','Infinite mill');
             INSERT INTO combo_cards_staging
                (combo_id,oracle_id,name,quantity,must_be_commander)
                VALUES ('c-1','oid-1','Some Card',1,0);",
        )
        .unwrap();
        drop_combo_staging(&conn).unwrap();

        for (live, staging) in COMBO_TABLES {
            assert_eq!(table_count(&conn, staging), 0, "{staging} must be gone");
            assert_eq!(table_count(&conn, live), 1, "{live} must be standing");
        }
        assert_eq!(table_count(&conn, "combo_meta"), 1);
    }

    /// `create_combo_staging` has to survive an interrupted run that committed its staging
    /// tables — the `DROP TABLE IF EXISTS` pair at the top of [`COMBO_STAGING_SQL`] — and the
    /// second call must leave them empty rather than carrying half of yesterday's file.
    #[test]
    fn creating_the_combo_staging_twice_starts_from_empty() {
        let conn = memory_pair();
        create_combo_staging(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO combos_staging
                (id,bracket_tag,card_count,template_count,identity,produces)
                VALUES ('c-1','R',1,0,'u','Infinite mill');
             INSERT INTO combo_cards_staging
                (combo_id,oracle_id,name,quantity,must_be_commander)
                VALUES ('c-1','oid-1','Some Card',1,0);",
        )
        .unwrap();
        create_combo_staging(&conn).unwrap();

        let staged: i64 = conn
            .query_row("SELECT count(*) FROM combos_staging", [], |r| r.get(0))
            .unwrap();
        assert_eq!(staged, 0);
        let staged_cards: i64 = conn
            .query_row("SELECT count(*) FROM combo_cards_staging", [], |r| r.get(0))
            .unwrap();
        assert_eq!(staged_cards, 0);
    }

    // ---- v19: a deck card names a finish ---------------------------------------------

    /// A database at version 18: everything v18 left behind, and none of v19.
    ///
    /// Honest for [`UNDO_V13`]'s reason rather than [`UNDO_V17`]'s — v19's DDL is
    /// `ALTER TABLE … ADD COLUMN`, so a fixture that forgot the rewind could not migrate at
    /// all. **It held the "one step below head" title, taking it from [`v17_database`], and
    /// v20 has moved it on to [`v19_database`]** — that line has moved with every rung and is
    /// left here as the record of which fixture the title belonged to.
    fn v18_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20} {UNDO_V19} PRAGMA user_version = 18;"
        ))
        .unwrap();
        conn
    }

    /// Columns of `table` with this name — 0 or 1. Parameterised by table and read that way:
    /// callers ask it about `deck_cards`, `oracle_tags`, `art_tags` and
    /// `art_tag_illustrations`.
    fn has_column(conn: &Connection, table: &str, column: &str) -> i64 {
        conn.query_row(
            &format!("SELECT count(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
            rusqlite::params![column],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The v19 step over a v18 database: the column arrives, every existing row reads regular,
    /// and the grain index comes back carrying the expression.
    ///
    /// **The index half is the one worth driving.** The step drops and recreates
    /// `idx_deck_cards_grain`, and a widening that is a silent no-op on exactly the machines
    /// that need it is what `src-tauri/CLAUDE.md` warns a changed index definition costs. Read
    /// off `sqlite_master` rather than `PRAGMA index_info`, which answers a NULL name for an
    /// expression column and so cannot see the thing that changed.
    #[test]
    fn the_v19_step_adds_the_finish_column_over_a_v18_database() {
        let conn = v18_database();
        assert_eq!(
            has_column(&conn, "deck_cards", "finish"),
            0,
            "a v18 database may not already carry v19's column"
        );
        let deck_id = deck(&conn, "Old");
        let cat = category(&conn, deck_id, "main", "Main deck");
        deck_card(&conn, deck_id, "c1", cat, 2);

        migrate_single_file(&conn).unwrap();

        assert_eq!(has_column(&conn, "deck_cards", "finish"), 1);
        let finish: Option<String> = conn
            .query_row("SELECT finish FROM deck_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            finish, None,
            "a row that predates the step is the regular copy"
        );

        let ddl: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = 'idx_deck_cards_grain'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            ddl.contains("coalesce(finish, '')"),
            "the grain index has to be rebuilt, not left at its v8 shape: {ddl}"
        );

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
    }

    /// [`v21_database`] carried this assertion while v22 was head, and it keeps the half of it
    /// that is about *that* rung: a database renumbered to 21 still gets the `slug_norm`
    /// repair, so the fixture's input survives the renumbering and its output does not. A
    /// fixture that had somehow already been backfilled would prove nothing at all.
    #[test]
    fn the_v21_fixture_still_receives_the_v22_backfill() {
        let conn = v21_database();
        // v20's `DEFAULT ''`, which is what every carried-over row of a real upgrade holds.
        conn.execute_batch(
            "INSERT INTO oracle_tags (slug, id, label, description, slug_norm)
             VALUES ('Spot-Removal', '', 'Spot Removal', NULL, '');",
        )
        .unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 21);

        migrate_single_file(&conn).unwrap();

        let norm: String = conn
            .query_row(
                "SELECT slug_norm FROM oracle_tags WHERE slug = 'Spot-Removal'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            norm, "spotremoval",
            "the v22 step must not have been skipped"
        );
    }

    /// [`v19_database`] is one below *that*, and the assertions it used to carry as the
    /// head-minus-one fixture are still worth making about it.
    #[test]
    fn the_v19_fixture_carries_none_of_v20() {
        let conn = v19_database();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 19);
        assert_eq!(
            has_column(&conn, "oracle_tags", "slug_norm"),
            0,
            "the v20 column must not be there yet"
        );
        assert_eq!(
            table_count(&conn, "art_tags"),
            0,
            "nor v20's tables: their DDL is `IF NOT EXISTS`, so keeping them is the quiet way \
             a fixture stops being the version it claims"
        );

        // v19's own column is standing, because this fixture undoes one rung rather than
        // two — and v18's and v17's below it with it.
        assert_eq!(has_column(&conn, "deck_cards", "finish"), 1);
        assert!(
            deck_columns(&conn).contains(&"game_key".to_owned()),
            "v18's column belongs to this version and must survive the rewind"
        );
        assert_eq!(
            table_count(&conn, "deck_undo"),
            1,
            "v17's journal belongs to this version and must survive the rewind"
        );
    }

    // ---- v18: the deck's game, and the platforms a format is playable on ----------------

    /// A database at version 17: everything v17 left behind, and none of v18.
    ///
    /// [`v15_database`]'s trick three rungs up, and honest for [`UNDO_V18`]'s reason: two
    /// `ADD COLUMN`s are the whole of what v18's DDL did, and two `DROP COLUMN`s undo them
    /// exactly — no index and no constraint names either one. The re-seed needs no undoing;
    /// [`UNDO_V18`] says why.
    ///
    /// **It is the "one step below head" fixture now**, the title [`v16_database`] held.
    fn v17_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V26} {UNDO_V25} {UNDO_V24} {UNDO_V23} {UNDO_V21} {UNDO_V20} {UNDO_V18} {UNDO_V19} PRAGMA user_version = 17;"
        ))
        .unwrap();
        conn
    }

    /// The step itself, from the version below it: both columns arrive, every deck that
    /// predates them reads `any`, and the 25 format rows come back carrying their platforms.
    ///
    /// **`DEFAULT 'any'` is the whole of the upgrade's promise.** There is nothing to back-fill
    /// — no deck was ever asked which platform it was for — so an existing deck answers exactly
    /// what it always meant, and the format picker it opens is the unfiltered one it always was.
    #[test]
    fn the_v18_step_adds_the_game_columns_over_a_v17_database() {
        let conn = v17_database();
        conn.execute_batch(
            "INSERT INTO decks (id, name, format_key, created_at, updated_at)
                 VALUES (1, 'Burn', 'modern', unixepoch(), unixepoch());",
        )
        .unwrap();
        assert!(
            !deck_columns(&conn).contains(&"game_key".to_owned()),
            "a v17 database may not already carry v18's column"
        );

        migrate_single_file(&conn).unwrap();

        let game: String = conn
            .query_row("SELECT game_key FROM decks WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            game, "any",
            "a deck that predates the column was never asked, and `any` is what that means"
        );
        assert_eq!(
            format_games(&conn, "modern"),
            "paper,mtgo",
            "the re-seed is what fills the cell — the DDL default would have said all three"
        );
        assert_eq!(format_games(&conn, "historic"), "arena");
        assert_eq!(format_games(&conn, "casual"), "paper,arena,mtgo");

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
    }

    /// One format's `games` cell.
    fn format_games(conn: &Connection, key: &str) -> String {
        conn.query_row(
            "SELECT games FROM format_specs WHERE key = ?1",
            rusqlite::params![key],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Every cell of every row holds [`GAMES`] words, and nothing else.
    ///
    /// **The whole of the fence**, because there is none in SQL: the column arrives by
    /// `ALTER TABLE … ADD COLUMN`, which cannot carry a CHECK — v12's `last_variant` met this
    /// first. Unlike that column there is no Rust fence either, and there is nothing for one to
    /// guard: no command parameter reaches this cell, so [`FORMAT_SPECS_SEED`] is the only
    /// writer and this test is what holds it to the vocabulary.
    ///
    /// A blank cell fails too. `''` would split to one empty word, match no game, and take the
    /// format silently out of every filtered picker — a format nobody can build for, with
    /// nothing on screen saying why.
    #[test]
    fn a_format_spec_games_cell_holds_only_scryfall_game_words() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();

        let mut stmt = conn
            .prepare("SELECT key, games FROM format_specs ORDER BY sort_order")
            .unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rows.len(), 25, "every seeded format answers this question");

        for (key, games) in rows {
            assert!(!games.is_empty(), "`{key}` names no platform at all");
            for game in games.split(',') {
                assert!(
                    GAMES.contains(&game),
                    "`{key}` names `{game}`, which is not one of {}",
                    GAMES.join(", ")
                );
            }
        }
    }

    /// [`DECK_GAMES`] is [`GAMES`] with the sentinel in front, and the two may not drift.
    ///
    /// Written out rather than concatenated because a `const` cannot concatenate, which is
    /// exactly the situation that lets two lists part company with nothing going red.
    #[test]
    fn the_deck_game_vocabulary_is_any_plus_the_scryfall_games() {
        assert_eq!(
            DECK_GAMES[0], "any",
            "the sentinel, and the column's default"
        );
        assert_eq!(&DECK_GAMES[1..], &GAMES[..]);
    }

    /// The two seeds describe the same 25 formats and differ by exactly one column.
    ///
    /// **This is what makes [`UNDO_V18`] honest**, and it is the cost of the split:
    /// [`FORMAT_SPECS_SEED_V5`] is frozen history that a fresh install replays, and
    /// [`FORMAT_SPECS_SEED`] is the one anybody edits, so a correction made to the head seed
    /// alone is correct and a cell *accidentally* changed there is a v5 database and a v18
    /// database disagreeing about a rule. Column by column rather than row counts, because a
    /// typo in one `deck_min` is exactly the shape of drift a count cannot see.
    #[test]
    fn the_head_format_seed_agrees_with_v5_on_every_shared_cell() {
        let shared = "key, display_name, enabled_in_picker, deck_min, deck_max, max_copies, \
                      sideboard_max, singleton, requires_commander, commander_rule, life, \
                      restricted_semantic, has_legality_data, max_mana_value, allows_companion, \
                      sort_order";
        // Head, through the ladder: v5 writes the frozen copy and v18 replaces it.
        let head = Connection::open_in_memory().unwrap();
        migrate_single_file(&head).unwrap();
        // And v5's statement on its own, into a table of the same shape.
        let old = Connection::open_in_memory().unwrap();
        migrate_single_file(&old).unwrap();
        old.execute_batch("DELETE FROM format_specs;").unwrap();
        old.execute_batch(FORMAT_SPECS_SEED_V5).unwrap();

        let read = |conn: &Connection| -> Vec<String> {
            let sql = format!("SELECT {shared} FROM format_specs ORDER BY sort_order");
            let mut stmt = conn.prepare(&sql).unwrap();
            let count = stmt.column_count();
            let rows = stmt
                .query_map([], |r| {
                    let mut cells = Vec::with_capacity(count);
                    for i in 0..count {
                        cells.push(format!("{:?}", r.get_ref(i)?));
                    }
                    Ok(cells.join(" | "))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect::<Vec<_>>();
            rows
        };

        assert_eq!(
            read(&head),
            read(&old),
            "the head seed may add `games` and may not restate any other cell differently"
        );
    }

    /// The step itself, from the version below it: the column arrives, every existing deck reads
    /// `0`, and a rerun is a no-op.
    ///
    /// **`DEFAULT 0` is the whole of the upgrade's promise, and `0` is `Auto`.** There is nothing
    /// to back-fill — the value this column now holds lived in a `useState` in the editor and was
    /// thrown away every time a deck was closed — so every deck that predates the step reads
    /// exactly what the editor used to open on.
    ///
    /// The `NOT NULL` is asserted beside it because it is what makes the sentinel a sentinel: a
    /// nullable column would give "Auto" two spellings, and [`crate::deck::DeckPatch`]'s
    /// `coalesce(?n, column)` reads one of them as "leave it alone".
    #[test]
    fn the_v16_step_gives_every_deck_the_auto_sentinel() {
        let conn = v15_database();
        let old = deck(&conn, "Old Deck");

        migrate_single_file(&conn).unwrap();
        migrate_single_file(&conn).unwrap(); // idempotent

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);

        let (notnull, default): (i64, Option<String>) = conn
            .query_row(
                "SELECT \"notnull\", dflt_value FROM pragma_table_info('decks')
                  WHERE name = 'default_category_id'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(notnull, 1, "there is no second spelling of Auto");
        assert_eq!(default.as_deref(), Some("0"));

        let stored: i64 = conn
            .query_row(
                "SELECT default_category_id FROM decks WHERE id = ?1",
                rusqlite::params![old],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, 0, "a deck that predates the column files by Auto");
    }

    /// **No foreign key on `default_category_id`, and that is the decision rather than an
    /// omission** — so the two sites that stand in for `ON DELETE SET NULL` are named at the
    /// step and asserted here. SQLite will not add a `REFERENCES` clause in an `ADD COLUMN`
    /// whose default is anything but NULL, and a nullable column is exactly what the sentinel
    /// exists to avoid; `deck_meta::delete_category` and `deck::duplicate_deck` are what pay
    /// for it.
    ///
    /// This asserts the absence so that a later step which rebuilds `decks` and adds the key
    /// fails here and takes the step's paragraph with it, rather than leaving two stories.
    #[test]
    fn the_default_category_is_a_sentinel_rather_than_a_foreign_key() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let deck_id = deck(&conn, "Burn");

        conn.execute(
            "UPDATE decks SET default_category_id = 4040404 WHERE id = ?1",
            rusqlite::params![deck_id],
        )
        .expect("SQL accepts anything here; the two clean-up sites are the fence");
    }

    /// The ladder ends where the constant says it does. Written as a literal so that
    /// bumping [`LEGACY_SINGLE_FILE_VERSION`] without adding the step that produces it — or adding a
    /// step and forgetting the constant — fails here rather than in the field.
    ///
    /// **This literal is also what catches two branches numbering the same rung.** v12, v13 and
    /// v14 were all three written as "12" against a head of 11; each branch that landed after
    /// the first found this assertion already reading a higher number and had to choose the next
    /// rung rather than discover the clash in the field.
    #[test]
    fn the_schema_version_is_twenty_six() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, LEGACY_SINGLE_FILE_VERSION);
        assert_eq!(LEGACY_SINGLE_FILE_VERSION, 26);
    }

    /// The v19 grain widens rather than the row changing meaning: a foil copy and a regular
    /// copy of one printing, in one pile of one list, are **two rows** — and each folds on
    /// its own.
    ///
    /// The second half is what `coalesce(finish, '')` buys. SQLite treats NULLs in a UNIQUE
    /// index as *distinct*, so the bare nullable column would enforce nothing: every regular
    /// add would insert a new row instead of adding to the one already there, and a deck
    /// would fill up with `1 × Sol Ring` rows. Driven through the real `ON CONFLICT
    /// ({DECK_CARD_GRAIN})` an upsert uses, because a conflict target that matches no index
    /// is a runtime error rather than a compile one.
    #[test]
    fn a_foil_row_and_a_regular_row_of_one_printing_are_two_rows_that_fold_apart() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let deck_id = deck(&conn, "Foils");
        let cat = category(&conn, deck_id, "main", "Main deck");

        let sql = format!(
            "INSERT INTO deck_cards
                (deck_id,category_id,variant,card_id,set_code,collector_number,lang,name,
                 finish,quantity,created_at,updated_at)
             VALUES (?1,?2,'live','c1','lea','161','en','Sol Ring',?3,1,
                     unixepoch(),unixepoch())
             ON CONFLICT({grain}) DO UPDATE SET
                quantity = deck_cards.quantity + excluded.quantity",
            grain = DECK_CARD_GRAIN
        );
        for finish in [None, None, None, Some("foil")] {
            conn.execute(&sql, rusqlite::params![deck_id, cat, finish])
                .unwrap();
        }

        let mut stmt = conn
            .prepare("SELECT finish, quantity FROM deck_cards ORDER BY coalesce(finish, '')")
            .unwrap();
        let rows: Vec<(Option<String>, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![(None, 3), (Some("foil".to_owned()), 1)],
            "three regular adds fold into one row of three; the foil add is its own row"
        );
    }

    /// `'nonfoil'` is **never stored** — NULL is the only spelling of the regular copy.
    ///
    /// Two spellings would be two rows on [`DECK_CARD_GRAIN`] that draw identically on screen
    /// and sum apart, which is the worst shape a bug in this table can have.
    /// `deck::normalise_finish` is the enforcement at the command boundary; this CHECK is what
    /// makes any *other* path a hard error rather than a quiet second row.
    ///
    /// **It also settles a claim `src-tauri/CLAUDE.md` made twice** — that `ALTER TABLE ADD
    /// COLUMN` cannot carry a CHECK, which is why `deck_categories.origin` has none and
    /// `decks.last_variant` grew a Rust fence instead. It can. SQLite's documented ADD COLUMN
    /// restrictions are PRIMARY KEY, UNIQUE, a non-constant DEFAULT, NOT NULL without a
    /// default, REFERENCES without a NULL default, and GENERATED STORED; a CHECK is not among
    /// them. This test is the proof, and it fails loudly the day that stops being true.
    #[test]
    fn the_deck_card_finish_column_refuses_nonfoil() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let deck_id = deck(&conn, "Foils");
        let cat = category(&conn, deck_id, "main", "Main deck");

        let insert = "INSERT INTO deck_cards
                (deck_id,category_id,variant,card_id,set_code,collector_number,lang,name,
                 finish,quantity,created_at,updated_at)
             VALUES (?1,?2,'live','c1','lea','161','en','Sol Ring',?3,1,
                     unixepoch(),unixepoch())";

        let err = conn
            .execute(insert, rusqlite::params![deck_id, cat, "nonfoil"])
            .unwrap_err();
        assert!(
            err.to_string().contains("CHECK constraint failed"),
            "the column's vocabulary is the database's, not a convention: {err}"
        );

        for good in [None, Some("foil"), Some("etched")] {
            conn.execute("DELETE FROM deck_cards", []).unwrap();
            conn.execute(insert, rusqlite::params![deck_id, cat, good])
                .expect("NULL, foil and etched are the three the column takes");
        }
    }

    /// Every deck that predates v19 reads regular, which is what it already meant — so the
    /// step carries **no backfill** and no deck's totals move on the upgrade.
    ///
    /// Driven through the `deck_card` helper, which writes no `finish` at all, exactly as
    /// every row written before this version did.
    #[test]
    fn a_deck_row_that_names_no_finish_is_the_regular_copy() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let deck_id = deck(&conn, "Old");
        let cat = category(&conn, deck_id, "main", "Main deck");
        deck_card(&conn, deck_id, "c1", cat, 2);

        let finish: Option<String> = conn
            .query_row("SELECT finish FROM deck_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(finish, None, "a row that says nothing is the regular copy");
    }

    /// **Every route to head must arrive at the same schema.** A fresh install runs the whole
    /// ladder in one `migrate_single_file`; an upgrade enters it partway and runs only the steps above
    /// where it stopped. Those two are the same claim only while every step's DDL is
    /// reachable from below it — and a merge that slides a step in *underneath* the one
    /// replaying [`CARDS_INDEXES`] is exactly the event that can break it, because the list
    /// is replayed by *one* step and a database entering above that step never sees it.
    /// **This has now happened twice**: v8 landed between v7 and our step, and then main's
    /// v9 did, each time pushing ours up the ladder. This test is what makes that
    /// renumbering safe rather than merely careful.
    ///
    /// So this walks every fixture the ladder has a genuine starting point for and compares
    /// the finished article against a fresh install: `cards`' columns **and** its indexes,
    /// the latter by stored SQL rather than by name, because a narrow `idx_cards_collapse`
    /// and a widened one share a name and differ in the only way that matters.
    ///
    /// **`decks`' columns are compared too, since v12/v13** (and `deck_categories`' since v15),
    /// because `cards` stopped being the only
    /// table a step adds columns to at v8 and the claim was never about `cards` — it is about
    /// every route arriving at one schema. The trap it closes is specific: `decks` is created
    /// by the v5 step and later columns arrive as `ALTER TABLE`s, so "mirror the new columns
    /// into the CREATE so a fresh install has them" is the plausible wrong fix, and it breaks
    /// **only** fresh installs (the `ALTER` then hits a duplicate column) — the one population
    /// no upgrade fixture can stand in for. Here that failure is a fresh install that cannot
    /// migrate at all, which is as loud as it deserves to be.
    ///
    /// The rewound fixtures are the honest ones available — [`v1_database`] is built from the
    /// frozen v1 DDL, [`v6_deck_database`] is a hand-built v6, [`v9_database`] undoes the steps
    /// above 9 over a head database, and the rest each undo every rung above the version they
    /// claim: [`v11_database`] undoes v12 to v20, [`v12_database`] v13 to v20,
    /// [`v13_database`] v14 to v20, [`v14_database`] v15 to v20, [`v15_database`] v16 to v20
    /// and [`v19_database`] v20 alone. **The ranges are named rather than counted, and this
    /// line read "to v15" through five later rungs** — a prose-only edit routes to neither CI
    /// job, so nothing here can go red on its own. The v9 one is
    /// the case an earlier merge added: a database sitting at main's v9, above every step that
    /// could hand it an index and below the one that does. A rewind that skipped a step's own
    /// table rebuild would fail here for a reason no upgrade could produce, which is why the
    /// fixtures are what they are and not a `PRAGMA user_version` away from each other.
    #[test]
    fn every_version_ends_with_the_same_schema_as_a_fresh_install() {
        let fresh = Connection::open_in_memory().unwrap();
        migrate_single_file(&fresh).unwrap();
        let want_cols = card_columns(&fresh);
        let want_indexes = indexes_on_cards(&fresh);
        // `decks` has an `ALTER` ladder of its own now (v8's three columns, v12's three, v13's
        // one), and it is compared in **ordinal** order for the reason that matters at the Rust
        // end: every read of a deck row is positional, so a route that arrives at head with the
        // same column *set* in a different order is a `DeckRow` reading the wrong fields with no
        // error anywhere. That is not hypothetical — v12 and v13 were written against the same
        // head by two branches, and the merge had to decide which three columns come first.
        let want_deck_cols = deck_columns(&fresh);
        // **And `deck_categories`' columns since v15**, which put that table on an `ALTER`
        // ladder of its own for the first time — v8 created it and nothing had touched it
        // since. The trap is the one the paragraph above names, one table over: mirroring
        // `origin` into v8's `CREATE TABLE` so a fresh install "has it" breaks **only** fresh
        // installs, because the v15 `ALTER` then hits a duplicate column and no upgrade fixture
        // can stand in for that population.
        let want_category_cols = category_columns(&fresh);

        // Every index the list names, and no declared index it does not. `sqlite_master`
        // also carries `sqlite_autoindex_cards_1` — the implicit index behind `id`'s PRIMARY
        // KEY, which is not ours to declare and is deliberately left in `want_indexes` so the
        // per-version comparison below proves the primary key survived each route too.
        let declared: Vec<&str> = want_indexes
            .iter()
            .map(|(n, _)| n.as_str())
            .filter(|n| !n.starts_with("sqlite_autoindex"))
            .collect();
        assert_eq!(
            declared.len(),
            CARDS_INDEXES.len(),
            "a fresh install must carry every index in the list: {want_indexes:?}"
        );
        for stmt in CARDS_INDEXES {
            // `CREATE INDEX IF NOT EXISTS {schema}.<name> …` since the split: the hole is
            // filled by `cards_indexes_sql`, so the constant itself still carries it here.
            let name = stmt
                .split_whitespace()
                .nth(5)
                .and_then(|q| q.split_once('.'))
                .map(|(_, name)| name)
                .expect("`CREATE INDEX IF NOT EXISTS {schema}.<name> …`");
            assert!(declared.contains(&name), "{name} missing: {declared:?}");
        }

        for (name, conn) in [
            ("v1", v1_database()),
            ("v6", v6_deck_database()),
            ("v9", v9_database()),
            ("v11", v11_database()),
            // The rungs the same-day v12/v13/v14 collision created. A machine that ran v12
            // before v13 existed — or v13 before v14 did — is the commonest database in the
            // world the day after a release, and those are the arrivals this list would
            // otherwise not cover.
            ("v12", v12_database()),
            ("v13", v13_database()),
            ("v14", v14_database()),
            ("v15", v15_database()),
            // `v19` is head minus one, and it is the arrival that matters most to v20: the
            // `CARDS_INDEXES` replay moved from v10 to v20 with that step, so a database
            // entering the ladder *above* v10 gets every index from the new step or from
            // nowhere. This row is what says which.
            ("v19", v19_database()),
            ("v20", v20_database()),
            // Head minus one since v26, and the arrival that matters most to it: `bracket`
            // arrives by `ALTER TABLE … ADD COLUMN`, which always **appends**, so a database
            // entering the ladder here has to end with `decks`' columns in the same *order* a
            // fresh install builds them — which is the one thing `deck_columns` is compared
            // ordinally for, and the one thing a column added by an `ALTER` can get wrong.
            ("v25", v25_database()),
        ] {
            migrate_single_file(&conn)
                .unwrap_or_else(|e| panic!("{name} must migrate to head: {e}"));

            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                version, LEGACY_SINGLE_FILE_VERSION,
                "{name} must reach head"
            );
            assert_eq!(
                card_columns(&conn),
                want_cols,
                "{name} must end with a fresh install's `cards` columns"
            );
            assert_eq!(
                deck_columns(&conn),
                want_deck_cols,
                "{name} must end with a fresh install's `decks` columns"
            );
            assert_eq!(
                indexes_on_cards(&conn),
                want_indexes,
                "{name} must end with a fresh install's `cards` indexes, definitions included"
            );
            assert_eq!(
                deck_columns(&conn),
                want_deck_cols,
                "{name} must end with a fresh install's `decks` columns, in the same order"
            );
            assert_eq!(
                category_columns(&conn),
                want_category_cols,
                "{name} must end with a fresh install's `deck_categories` columns"
            );
        }
    }

    /// `cards`' column names in ordinal order, which is what `PRAGMA table_info` gives and
    /// what a fresh install and an upgrade have to agree on.
    fn card_columns(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("PRAGMA table_info(cards)").unwrap();
        let cols = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        cols
    }
}
