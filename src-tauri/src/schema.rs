//! Database schema: `cards`, `sets`, `sync_meta`, the `cards_fts` search index, the user's
//! own tables — `collection_entries`, `wishlist_entries`, `card_migrations`, `decks`,
//! `deck_cards`, `deck_allocations` — and `format_specs`, which is seeded *data*: the
//! format rules the validation engine reads instead of embodying.
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
//! CASCADE is the common case — `deck_cards.deck_id`, `deck_cards.category_id`,
//! `deck_allocations.deck_id`, `deck_allocations.collection_entry_id`,
//! `deck_categories.deck_id`, `deck_tags.deck_id`, `deck_audit.deck_id` and
//! `deck_folders.parent_id` all take it, because a deleted deck's cards and reservations, a
//! deleted category's cards, and a deleted folder's sub-folders have nowhere else to be. It
//! is right, too, at the app's one *non-user* delete: [`crate::reconcile`]'s fold repoints
//! allocations onto the surviving entry *before* the delete runs, so the cascade fires over
//! nothing, and `collection::remove_entry` relies on the same action to free reservations on
//! copies that no longer exist. SET NULL is the other two — `decks.folder_id` (a folder is a
//! filing decision, and the decks inside it are the user's work, not the folder's to take
//! down with it) and `deck_cards.tag_id` (deleting a tag must never delete a card) — named
//! here so this list can be checked against the DDL rather than trusted on its own.

use rusqlite::Connection;

/// The `cards` columns **as version 1 created them. FROZEN.**
///
/// This is the body of one historical migration step, not a description of the current
/// table. Editing it would rewrite history: a fresh install would create the new column
/// in its v1 `CREATE TABLE`, and the v2 step that is supposed to `ALTER TABLE cards ADD
/// COLUMN` it would then fail with "duplicate column name" on every new machine while
/// working perfectly on every upgraded one. Schema changes go in a **new** migration
/// step in [`migrate`], never here.
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
/// put them all back. When these statements were written out twice — once in [`migrate`],
/// once in the swap — an index added to one of them silently disappeared at the next sync
/// on every machine that had already migrated. `IF NOT EXISTS` so `migrate` can rerun.
///
/// **This list describes the table at HEAD, so only the NEWEST migration step may replay
/// it.** It names `legal_mask`, which the v9 step is what adds — so the v1 block that used
/// to replay it would now fail on every fresh install with "no such column", the list
/// describing a table eight versions ahead of the one in front of it. The steps below v9
/// therefore create no index at all: v9's replay is where every database walking the ladder
/// gets them, and every statement being `IF NOT EXISTS` is what makes that a bring-up-to-date
/// rather than a rebuild. A step that *changes* a definition — as v9 changes this one —
/// drops the old one first, or `IF NOT EXISTS` silently keeps what is already there.
///
/// The rule is a *moving* one: a v10 that touches `cards` must take the replay from v9, and
/// `every_version_ends_with_the_same_schema_as_a_fresh_install` is what fails if it does not.
/// A step that leaves `cards` alone entirely — v8, which is deck tables only — neither needs
/// the list nor may replay it, and does not take the title of newest creator from v9.
const CARDS_INDEXES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_cards_oracle ON cards(oracle_id)",
    "CREATE INDEX IF NOT EXISTS idx_cards_set_cn ON cards(set_code, collector_number)",
    "CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name)",
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
    // 22–47 ms with them, measured 2026-08-11 over the live corpus. They cost +0.89 MB
    // (13.45 → 14.34 MB) and 4 ms on the *unfiltered* browse, which is the trade.
    //
    // `legal_mask` and not `legalities`: a JSON path is not indexable, which is the whole
    // reason [`crate::legalities`] exists.
    "CREATE INDEX IF NOT EXISTS idx_cards_collapse \
     ON cards(oracle_id, is_paper, released_at, id, name, price_usd, \
              legal_mask, cmc, color_identity)",
];

/// [`CARDS_INDEXES`] as one executable batch.
fn cards_indexes_sql() -> String {
    CARDS_INDEXES.join(";\n") + ";"
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

/// The head schema version — what [`migrate`] walks a database up to, and what
/// `migrate_is_idempotent_and_creates_tables` pins. Named because three tests all have to
/// mean the same number.
///
/// **No migration step writes this constant.** Each step ends with the literal version it
/// produces (`PRAGMA user_version = 3;` in the v3 step, and so on), because a step that
/// wrote *head* would commit "fully migrated" before the steps after it had run — and
/// would keep the version assertion passing while doing it. This constant is the thing
/// tests compare against, not the thing steps write.
pub const SCHEMA_VERSION: i64 = 9;

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
pub const COLLECTION_GRAIN: &str = "card_id, finish, condition, lang, altered, signed, proxy, \
     misprint, coalesce(serial_number, ''), coalesce(grading, '')";

/// The wishlist's grain: an oracle card, optionally pinned to one printing and one finish.
/// `card_id IS NULL` means "any printing" (spec §6), which is a different wish from a
/// specific one rather than a looser version of it.
pub const WISHLIST_GRAIN: &str =
    "coalesce(oracle_id, ''), coalesce(card_id, ''), coalesce(preferred_finish, '')";

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
/// runtime error at the first quick-add rather than a compile error. No `coalesce` is
/// needed here: every column is `NOT NULL`, so none of them can go distinct-by-NULL.
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
pub const DECK_CARD_GRAIN: &str = "deck_id, variant, category_id, card_id";

/// What makes two category rows the same row: one name per deck. This is a different
/// uniqueness question from [`PREDEFINED_CATEGORIES`]'s "at most one predefined row per
/// kind per deck" (`idx_deck_categories_kind`, a *partial* index over `kind <> 'main'`) — a
/// user is free to name a category of their own "Sideboard" too, and that collides with
/// nothing on this grain, because the predefined Sideboard was never named by the user.
///
/// Read by no SQL at all — see [`DECK_CARD_GRAIN`] for why the v8 DDL spells its index out,
/// and for the test that keeps this constant honest about what that index holds.
pub const DECK_CATEGORY_GRAIN: &str = "deck_id, name";

/// What makes two tag rows the same row: one name per deck, [`DECK_CATEGORY_GRAIN`]'s shape
/// for the same reason. A tag is picked by name from the app's fixed colour palette, and a
/// deck cannot hold two tags called the same thing.
///
/// Read by no SQL at all, like [`DECK_CATEGORY_GRAIN`].
pub const DECK_TAG_GRAIN: &str = "deck_id, name";

/// The two decks every deck secretly is: `live`, what is actually sleeved up and playable,
/// and `theory`, what it is being built toward. CHECK-constrained on `deck_cards.variant`
/// and `deck_audit.variant`, and part of [`DECK_CARD_GRAIN`] — the reason a change tried out
/// in Theory is a different row from the Live one it is being tried against, never a draft
/// that could silently overwrite it. `deck::allocate_deck` reserves collection copies for
/// `live` only: a theory list is a plan, and a plan claims nothing.
pub const DECK_VARIANTS: [&str; 2] = ["live", "theory"];

/// What a `deck_audit` row can record, CHECK-constrained on `deck_audit.kind`. Rust records
/// which of these happened and the facts a sentence needs (`payload`, `delta`); TypeScript
/// owns turning that into the sentence a person reads on the history drawer, because a
/// sentence is domain logic and this table has to survive the day the wording changes.
pub const AUDIT_KINDS: [&str; 9] = [
    "add", "remove", "quantity", "move", "swap", "tag", "category", "folder", "deck",
];

/// One deck's claim on one collection entry. Both columns are `NOT NULL` enforced foreign
/// keys, so the grain is the pair and nothing else: a deck reserves copies *of a collection
/// row*, and a second claim on the same row by the same deck is the same claim.
///
/// Read by no SQL at all, like [`DECK_CATEGORY_GRAIN`].
pub const ALLOCATION_GRAIN: &str = "deck_id, collection_entry_id";

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
const FORMAT_SPECS_SEED: &str = "INSERT OR REPLACE INTO format_specs
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

/// Bring `conn` up to the current schema version. Idempotent: tracked by
/// `PRAGMA user_version`, so a rerun on an up-to-date database is a no-op.
///
/// **Adding a column later:** leave [`CARDS_COLUMNS`] alone and add a new `if v < N`
/// block with an `ALTER TABLE cards ADD COLUMN`, the way `v < 2` and `v < 3` below do.
/// The v1 `CREATE` describes what version 1 built; a fresh install replays the whole
/// history, so a column added to v1 would make the later `ALTER` fail on new machines
/// only.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 {
        // One transaction for the whole migration, `user_version` bumped last: if any
        // step fails the database stays at version 0 and the next run retries cleanly.
        // Bumping it before the FTS table exists would mark the database migrated with
        // no search index and no path back.
        //
        // The indexes are deliberately not here. [`CARDS_INDEXES`] describes the table at
        // head and names columns later steps add, so the newest step replays it and no
        // older one may — see the constant. A fresh install gets its indexes at v8, in the
        // same `migrate` call as this.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS cards ({CARDS_COLUMNS});
             CREATE TABLE IF NOT EXISTS sets (
                code TEXT PRIMARY KEY, name TEXT NOT NULL, arena_code TEXT, mtgo_code TEXT,
                set_type TEXT, released_at TEXT, icon_svg_uri TEXT);
             CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
        ))?;
        create_fts(&tx)?;
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

        // Literal `3`, not `SCHEMA_VERSION`: this step is what makes a database version 3,
        // and head is 5. Writing head here would commit "migrated" before the steps after
        // it had run, so a v4 or v5 that then failed would leave a database claiming a
        // schema it does not have — with no way back, because `migrate` only ever walks
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
        // `SCHEMA_VERSION` would commit "migrated" before that step had run — and it would
        // also quietly defang `migrate_is_idempotent_and_creates_tables`, which pins
        // `user_version == SCHEMA_VERSION` and would keep passing while the last step was
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
        // either way, and `migrate` runs before there is a window to say anything in.
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

        tx.execute_batch(FORMAT_SPECS_SEED)?;
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
        // statements of its own any more. It used to replay [`CARDS_INDEXES`] here; v9 puts
        // a column in that list which no step before v9 has added, so the replay moved down
        // to v9 and this step's index is created there, in its widened form, for every
        // database that walks past here. What is left is the version this step stands for,
        // kept rather than deleted because the ladder is the record of what each version
        // was — and because creating the narrow index only for v9 to drop it would be a
        // 0.7 s index build over the live corpus, spent on nothing.
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
        // called 'Main deck'. Splitting those by card type is the app's `autoCategoryFor`
        // rule, which lives in TypeScript because it is domain logic; running a second copy of
        // it here would be two rules to keep in step. The categories panel offers
        // 'Auto-categorise from card types', which is that one rule, pressed once.
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
             -- that pragma is a documented no-op *inside a transaction*, and `migrate` always
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
             -- built until v5 was frozen. A v9 that widens the grain again would make this
             -- step build an index over a column that does not exist at v8: a hard failure on
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
        // One nullable column, and the index it goes into. `CARDS_COLUMNS` stays frozen —
        // a fresh install replays v1 and arrives here to do the same work an upgrade does.
        //
        // **The DROP is load-bearing.** Every statement in [`CARDS_INDEXES`] is
        // `IF NOT EXISTS`, so replaying the batch over a database that already carries
        // `idx_cards_collapse` in its narrow v7 form would keep that definition and skip
        // the widening — silently, on exactly the machines that have the problem. v7 could
        // replay the batch bare because its index was new; this one is not. Dropping it
        // first is what makes the replay build the new one, and
        // `the_v9_step_replaces_the_narrow_collapse_index_rather_than_skipping_it` is the
        // fence: it fails without this line.
        //
        // The replay is this step's because [`CARDS_INDEXES`] describes the table at head
        // and only the newest step may create from it (see the constant) — so these four
        // statements are also where a fresh install, and every database that arrives here
        // missing an index, gets them. Hence the whole batch rather than the one name.
        // v8 sits between this step and v7 and touches only the deck tables, so it neither
        // needs the list nor may replay it; that this step is still the newest is what keeps
        // the constant's rule true, and `every_version_ends_with_the_same_schema_as_a_fresh_install`
        // is what would fail if a v10 landed without moving the replay up.
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
        // but the column permitted one and v9 is still unshipped, so it costs nothing to
        // close. `DEFAULT` is also what makes the `ALTER` legal at all: SQLite refuses to add
        // a `NOT NULL` column without one. [`cards_column_defs`] reproduces both, so staging
        // carries them and the swap survives.
        tx.execute_batch("ALTER TABLE cards ADD COLUMN legal_mask INTEGER NOT NULL DEFAULT 0;")?;
        tx.execute_batch(&format!(
            "UPDATE cards SET legal_mask = {mask};",
            mask = crate::legalities::mask_sql("legalities")
        ))?;
        tx.execute_batch("DROP INDEX IF EXISTS idx_cards_collapse;")?;
        tx.execute_batch(&cards_indexes_sql())?;
        // Literal `9`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 9;")?;
        tx.commit()?;
    }
    Ok(())
}

/// (Re)create the external-content FTS5 index over `cards` and populate it.
///
/// `search_text` is the haystack column: ingest concatenates oracle text plus every
/// face's name and text into it.
///
/// Public because `VACUUM` needs it. Anything that renumbers `cards`' rowids leaves this
/// index pointing at the wrong rows, and the failure is silent — see
/// [`crate::maintenance::convert_to_incremental`], which calls this unconditionally.
pub fn create_fts(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS cards_fts;
         CREATE VIRTUAL TABLE cards_fts USING fts5(
            name, type_line, search_text,
            content='cards', tokenize='unicode61 remove_diacritics 2');
         INSERT INTO cards_fts(cards_fts) VALUES('rebuild');",
    )
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
/// **[`migrate`] is the only step here allowed to stop a launch.** A schema that cannot be
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
    migrate(conn)?;
    if let Err(e) = crate::maintenance::rebuild_fts_if_pending(conn) {
        eprintln!(
            "the search index still owes a rebuild from an interrupted compaction, and it \
             could not be done now: {e}\nSearch results may be wrong until the next sync."
        );
    }
    if let Err(e) = conn.execute_batch("DROP TABLE IF EXISTS cards_staging") {
        eprintln!(
            "an interrupted sync left a `cards_staging` table behind and it could not be \
             dropped now: {e}\nThe data folder is using more space than it needs to until \
             the next sync reuses it."
        );
    }
    Ok(())
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
        "DROP TABLE IF EXISTS cards_staging;
         CREATE TABLE cards_staging ({columns});",
    ))
}

/// The column definitions of the live `cards` table, rebuilt from `PRAGMA table_info`.
///
/// Reproduces name, declared type, `NOT NULL`, `DEFAULT` and single-column `PRIMARY KEY`
/// — everything `cards` is declared with. A `CREATE TABLE … AS SELECT` clone would be one
/// line instead, and would silently drop all four.
fn cards_column_defs(conn: &Connection) -> rusqlite::Result<String> {
    let mut stmt = conn.prepare("PRAGMA table_info(cards)")?;
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
/// index, which `migrate()` will not repair once `user_version` is set. On failure the
/// [`Transaction`] rolls back as it drops, leaving the connection ready for a retry.
///
/// [`Transaction`]: rusqlite::Transaction
pub fn swap_staging(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(&format!(
        "DROP TABLE IF EXISTS cards_fts;
         DROP TABLE cards;
         ALTER TABLE cards_staging RENAME TO cards;
         {indexes}",
        indexes = cards_indexes_sql()
    ))?;
    create_fts(&tx)?;
    // A rebuild an interrupted compaction was still owed has just been paid off, by this.
    // Clearing it inside the same transaction is what keeps the two honest: the debt and
    // the work that discharges it commit together or not at all.
    crate::sync::set_meta_opt(&tx, crate::maintenance::K_FTS_REBUILD_PENDING, None)?;
    tx.commit()
}

/// `pub(crate)` for the deck seed helpers at the bottom of the module: Task 3's
/// reconciler tests need the same deck-shaped fixture, and a second hand-rolled copy of
/// it is a second thing to keep true. `#[cfg(test)]` still bounds all of it to test builds.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent_and_creates_tables() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // no error on rerun
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name IN
                 ('cards','sets','sync_meta','cards_fts',
                  'collection_entries','wishlist_entries','card_migrations',
                  'decks','deck_cards','deck_allocations','format_specs')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 11);

        // Without this the test would still pass while `migrate` re-ran its whole batch
        // every call (the CREATEs are all `IF NOT EXISTS`), silently rebuilding FTS each
        // time. The version bump is what makes the rerun a genuine no-op — so this tracks
        // the *current* head version, not the version that first created these tables.
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
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
        migrate(&conn).unwrap();

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
    /// and must keep building the index it built the day it shipped. The price is that three
    /// of the six grain constants — [`ALLOCATION_GRAIN`], [`DECK_CATEGORY_GRAIN`] and
    /// [`DECK_TAG_GRAIN`] — are read by no SQL at all any more, and a constant nothing reads
    /// is a constant that can drift from the index it claims to describe without anything
    /// saying so. [`COLLECTION_GRAIN`], [`WISHLIST_GRAIN`] and [`DECK_CARD_GRAIN`] are held
    /// to their indexes by their `ON CONFLICT` targets (the test above, and every deck-card
    /// upsert); these four are held here.
    ///
    /// Read through `PRAGMA index_info` rather than by comparing DDL text, which is the whole
    /// point: it answers the *parsed* column list, so the literal in the migration is free to
    /// be wrapped and indented however it reads best. The two grains with `coalesce(…)` in
    /// them cannot be checked this way — an expression column comes back with a NULL name —
    /// and do not need to be, since a mismatched conflict target is a hard error at the first
    /// write.
    #[test]
    fn every_plain_grain_constant_names_the_index_the_head_schema_carries() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        for (index, grain) in [
            ("idx_deck_cards_grain", DECK_CARD_GRAIN),
            ("idx_deck_categories_grain", DECK_CATEGORY_GRAIN),
            ("idx_deck_tags_grain", DECK_TAG_GRAIN),
            ("idx_deck_allocations_grain", ALLOCATION_GRAIN),
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
        let path = dir.join("mtg.db");

        // The state a killed ingest leaves: a migrated database, a swap that never ran,
        // and committed rows in staging.
        {
            let conn = crate::db::open(&path).unwrap();
            prepare_database(&conn).unwrap();
            create_staging(&conn).unwrap();
            conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('half','Half Ingested','x','1','en','normal','{}')", []).unwrap();
        }

        // The next launch, which is `init_state`'s one act of database preparation.
        let conn = crate::db::open(&path).unwrap();
        prepare_database(&conn).unwrap();

        let staging: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='cards_staging'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(staging, 0, "crash residue must not survive a launch");
        // And the launch is still a launch: the schema it was there to prepare is intact.
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE name IN ('cards','sets','sync_meta','cards_fts')",
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
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute_batch("CREATE VIEW cards_staging AS SELECT 1 AS x;")
            .unwrap();

        prepare_database(&conn).expect("a launch must not die on a drop it cannot do");

        // The residue is still there, and still recorded where the next attempt looks —
        // `create_staging` at the next sync, `prepare_database` at the next launch.
        let still: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='cards_staging'",
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
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_cards_collapse'",
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
                "SELECT count(*) FROM sqlite_master
                  WHERE type='index' AND tbl_name='cards' AND name='idx_cards_collapse'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, 1, "the swap must replay the collapse index");
    }

    /// A database that migrated before the collapse index existed must gain it, and running
    /// `migrate` twice must be a no-op — every statement in [`CARDS_INDEXES`] is
    /// `IF NOT EXISTS`, which is what lets the newest step replay the whole list rather than
    /// naming the one index it changed.
    ///
    /// **Which step that is has moved: the index arrives at v9 now, not v7.** v7 used to
    /// replay [`CARDS_INDEXES`] itself; the list names `legal_mask`, which v9 is what adds,
    /// so the replay moved to v9 and every step below it creates no index at all. What this
    /// test asserts is unchanged and is deliberately written in terms of the *outcome* — a
    /// pre-collapse-index database ends up with the index, whichever step hands it over.
    ///
    /// The fixture is [`v6_deck_database`] — a database genuinely *at* version 6, with
    /// `cards` in its v1 shape and the three indexes v1 created — rather than a head
    /// database with `DROP INDEX` and `PRAGMA user_version = 6` behind it. Rewinding the
    /// pragma stopped being a stand-in for a v6 database the moment the v8 step joined the
    /// ladder *below* this one: `migrate` reads `user_version` once and walks every step
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

        migrate(&conn).unwrap();
        migrate(&conn).unwrap();

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
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn staging_swap_replaces_cards_and_fts_finds_new_rows() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
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
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND tbl_name='cards'
                 AND name IN ('idx_cards_oracle','idx_cards_set_cn','idx_cards_name',
                              'idx_cards_collapse')",
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
                "SELECT count(*) FROM sqlite_master WHERE name='cards_staging'",
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
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
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
        migrate(&conn).unwrap();
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
        migrate(&conn).unwrap();
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
        migrate(&conn).unwrap();
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
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
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
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
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
            .prepare(
                "SELECT name, sql FROM sqlite_master
                 WHERE type='index' AND tbl_name='cards' ORDER BY name",
            )
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
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
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
                "SELECT count(*) FROM sqlite_master WHERE name='cards_fts'",
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
    /// disk. Built from the frozen v1 constant rather than by calling `migrate`, because
    /// `migrate` now runs straight through to head and there is no way back.
    ///
    /// No indexes, for the reason the v1 step creates none: [`CARDS_INDEXES`] describes the
    /// table at head and names columns a v1 table does not have. The v9 step replays the
    /// list, so a database built here has its indexes by the time `migrate` returns —
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
        create_fts(&conn).unwrap();
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
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // still idempotent

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

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

        migrate(&conn).unwrap();

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
        migrate(&conn).unwrap();

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
        migrate(&conn).unwrap();

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

        migrate(&conn).unwrap();

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
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
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

        migrate(&conn).unwrap();

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
        assert_eq!(version, SCHEMA_VERSION);
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

        migrate(&conn).unwrap();

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
    /// breaks only in the field. Reaching `SCHEMA_VERSION` is therefore half the assertion.
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

        migrate(&conn).expect("a non-JSON `raw` must not fail the migration");

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
            version, SCHEMA_VERSION,
            "an unguarded read anywhere on the ladder stops the migration here"
        );
    }

    /// A column added by a migration has to survive the sync that drops and recreates the
    /// table it is on — which it does only because `create_staging` derives its layout from
    /// the live table *and* the ingest writes the column. The second half is the one that
    /// fails silently: staging would clone the column and every row would come back NULL.
    #[test]
    fn the_artist_column_survives_a_staging_swap() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
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
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
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
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
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

    /// One deck's claim on one collection entry. A reservation, never a transfer: the
    /// collection row it points at keeps every copy it had.
    pub(crate) fn allocate(conn: &Connection, deck_id: i64, entry_id: i64, quantity: i64) -> i64 {
        conn.query_row(
            "INSERT INTO deck_allocations
                (deck_id, collection_entry_id, quantity, created_at, updated_at)
             VALUES (?1,?2,?3,unixepoch(),unixepoch()) RETURNING id",
            rusqlite::params![deck_id, entry_id, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The three enforced FKs, exercised at their delete sites. `foreign_keys=ON`, as
    /// `db::open` sets it — these tests fail without the pragma, which is the point.
    #[test]
    fn deleting_a_deck_cascades_its_cards_and_allocations() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        seed_card(&conn, "bolt", "lea", "161");
        let deck = deck(&conn, "Burn");
        let entry = entry(&conn, "bolt", 4);
        let main = category(&conn, deck, "main", "Main deck");
        deck_card(&conn, deck, "bolt", main, 4);
        allocate(&conn, deck, entry, 4);

        conn.execute("DELETE FROM decks WHERE id = ?1", [deck])
            .unwrap();

        for table in ["deck_cards", "deck_allocations"] {
            let n: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} rows die with their deck");
        }
        // …and the collection entry is untouched: a deck is a claim, never custody.
        let q: i64 = conn
            .query_row("SELECT quantity FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(q, 4);
    }

    /// `collection::remove_entry`'s CASCADE site — the second of the two *user-initiated*
    /// deletes the action was chosen for. The allocation goes (a reservation on copies
    /// that no longer exist is a lie); the deck card stays, because the deck still wants
    /// the card and is simply missing it now, which is what Task 5's availability
    /// computes rather than something the schema decides.
    #[test]
    fn removing_a_collection_entry_frees_its_allocations_and_nothing_else() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        seed_card(&conn, "bolt", "lea", "161");
        let deck = deck(&conn, "Burn");
        let entry = entry(&conn, "bolt", 4);
        let main = category(&conn, deck, "main", "Main deck");
        deck_card(&conn, deck, "bolt", main, 4);
        allocate(&conn, deck, entry, 4);

        conn.execute("DELETE FROM collection_entries WHERE id = ?1", [entry])
            .unwrap();

        let allocations: i64 = conn
            .query_row("SELECT count(*) FROM deck_allocations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(allocations, 0, "a claim on copies that are gone is a lie");
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
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        seed_card(&conn, "bolt", "lea", "161");
        let deck = deck(&conn, "Burn");
        // The cover art is a printing too, and it is the other soft reference.
        conn.execute(
            "UPDATE decks SET cover_card_id = 'bolt' WHERE id = ?1",
            [deck],
        )
        .unwrap();
        let entry = entry(&conn, "bolt", 4);
        let main = category(&conn, deck, "main", "Main deck");
        deck_card(&conn, deck, "bolt", main, 4);
        allocate(&conn, deck, entry, 4);

        create_staging(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards_staging (id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('bolt','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        swap_staging(&conn).expect("a sync must not be blocked by the user's decks");

        for table in ["decks", "deck_cards", "deck_allocations"] {
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
        migrate(&conn).unwrap();
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
        migrate(&conn).unwrap();

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
    /// Without the second pass this deck would come out of `migrate` owning zero
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
        migrate(&conn).unwrap();

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
    /// Built by hand rather than by calling [`migrate`] and rewinding `PRAGMA user_version`
    /// backward: rewinding the pragma would still leave `deck_cards` in its *v8* shape,
    /// which is exactly the state this fixture must not be in — `migrate` never runs a step
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
    /// **`cards` is here for the v9 step, which also runs.** [`migrate`] reads
    /// `user_version` once and then walks *every* step above it, so a database that says 6
    /// runs v7, the v8 rebuild and v9 alike — and v9's body is
    /// `ALTER TABLE cards … / UPDATE cards … / CREATE INDEX … ON cards(…)`, a hard error
    /// against a database with no `cards` table. (v7 used to be the step that needed it; it
    /// has no statements of its own any more, because the [`CARDS_INDEXES`] replay moved up
    /// to v9 where the list's newest column exists. The requirement moved with it, it did
    /// not go away.)
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
    /// `migrate`'s `if v < 7`, `if v < 8` and `if v < 9` branches are the only three that can
    /// run once `user_version` already says 6, so nothing earlier is needed — the same
    /// reasoning `v1_database` uses further down the ladder.
    fn v6_deck_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE cards ({CARDS_COLUMNS});
             -- The five columns v2, v3 and v5 added to `cards`, replayed as literals
             -- because `migrate` will not: it reads `user_version` once, sees 6, and skips
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

             -- Reduced to the columns an allocation and its target need — nothing
             -- decorative — but the FK and its CASCADE are the real v4/v5 DDL verbatim,
             -- because those are exactly what this fixture exists to put under load.
             CREATE TABLE collection_entries (
                id INTEGER PRIMARY KEY,
                card_id TEXT NOT NULL,
                set_code TEXT NOT NULL,
                collector_number TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'en',
                finish TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')),
                condition TEXT NOT NULL DEFAULT 'NM'
                    CHECK (condition IN ('NM','LP','MP','HP','DMG')),
                quantity INTEGER NOT NULL CHECK (quantity >= 0),
                tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
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

             PRAGMA user_version = 6;",
        )
        .unwrap();
        conn
    }

    /// The test that fails in the field and nowhere else if the backfill is wrong: a real
    /// v6 deck, one card in each of the five legacy zones, migrated forward under
    /// `foreign_keys=ON` — as every real launch runs it, `db::open` always sets it. This is
    /// what the test actually demonstrates: the migration completes with foreign keys
    /// enforced (which, measured by temporarily breaking the rebuild's `SELECT`, is already
    /// what would refuse a dangling `category_id` — `migrate` itself fails outright rather
    /// than committing one, before `PRAGMA foreign_key_check` below ever runs); every card
    /// keeps its quantity and its own `deck_cards.id` (which `deck_allocations` may
    /// separately be holding) and lands in a category whose `kind` is the zone it came from —
    /// which is the assertion that would catch the backfill's JOIN resolving to a *valid but
    /// wrong* category, the one failure mode neither FK enforcement nor `foreign_key_check`
    /// can see, since the reference still resolves; with the Maybeboard alone coming out
    /// `is_active = 0`; no reference anywhere in the whole database is left dangling, on any
    /// table, including ones this test does not otherwise touch (`foreign_key_check`'s own
    /// job once `migrate` has returned); and a pre-existing `deck_allocations` reservation is
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
    /// verbatim, `migrate` dies at "UNIQUE constraint failed: deck_cards_v8.id" — a hard
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

        // The pragma every real launch runs under (`db::open`). Set before `migrate`, not
        // inside it: `PRAGMA foreign_keys` is a no-op mid-transaction, and `migrate` opens
        // its own.
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // A whole-database dangling-reference sweep, for less than it first looks like it
        // buys. Measured directly (temporarily changing the v8 rebuild's `SELECT`
        // to `cat.id + 100000` and running this test): a *dangling* `category_id` never
        // reaches this line at all — `migrate(&conn).unwrap()` above already panics on
        // "FOREIGN KEY constraint failed", because every FK here is checked immediately
        // under `foreign_keys=ON`, and `INSERT INTO deck_cards_v8 … SELECT` fails outright
        // rather than committing a bad row. So this assertion is not what would catch that
        // bug; the pragma being on before `migrate` runs already is. What this line still
        // covers, and `migrate(&conn).unwrap()` does not: a dangling reference on a row this
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

        let allocated: i64 = conn
            .query_row(
                "SELECT da.quantity FROM deck_allocations da
                   JOIN collection_entries ce ON ce.id = da.collection_entry_id
                   JOIN decks d ON d.id = da.deck_id
                  WHERE da.deck_id = ?1",
                [deck_id],
                |r| r.get(0),
            )
            .unwrap_or_else(|e| {
                panic!("the pre-existing allocation must still resolve after the migration: {e}")
            });
        assert_eq!(
            allocated, 4,
            "the migration must not quietly clear a user's existing allocation"
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

        migrate(&conn).unwrap();

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
        migrate(&conn).unwrap();
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

    /// The seed is the research doc's format table as data, and the engine reads rules
    /// from it rather than embodying them — so a wrong cell here is a wrong rule
    /// everywhere, with nothing else in the app to contradict it.
    #[test]
    fn format_specs_is_seeded_with_all_25_formats_and_the_load_bearing_cells() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
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

        migrate(&conn).unwrap();

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

        migrate(&conn).unwrap();

        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "the FTS index must survive the v5 backfill");
    }

    // ---- v9: `legal_mask` and the widened collapse index ----------------------------

    /// A database that stopped at version 8 — the shape a machine that has run this app
    /// before is in, one version below head.
    ///
    /// [`v1_database`]'s trick cannot reach v8: only version 1's DDL is frozen, and every
    /// version after it is an `ALTER` (or, at v8, a whole table rebuild) inside a step there
    /// is no way back through. So this walks to head and undoes exactly what the v9 step
    /// did — nothing more.
    ///
    /// **It rewinds to 8 and not one step further, and that is the trap
    /// [`v6_deck_database`] exists for.** `migrate` reads `user_version` once and then walks
    /// *every* step above it, so a rewind to 7 over a head-shaped database would re-run v8's
    /// deck rebuild against tables already in their v8 shape and die on a duplicate column —
    /// a failure no real upgrade can produce. Undoing v9's two statements is the whole of
    /// what this fixture may claim, which is why it is named for the version it leaves
    /// behind rather than for the one step it is testing.
    ///
    /// The index goes **before** the column: SQLite refuses to drop a column that an index
    /// names, and the widened `idx_cards_collapse` names this one. The narrow definition
    /// that goes back is a literal, not [`CARDS_INDEXES`]'s entry — this is a description of
    /// history, and history does not change when the list does.
    fn v8_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute_batch(
            "DROP INDEX idx_cards_collapse;
             ALTER TABLE cards DROP COLUMN legal_mask;
             CREATE INDEX idx_cards_collapse
                 ON cards(oracle_id, is_paper, released_at, id, name, price_usd);
             PRAGMA user_version = 8;",
        )
        .unwrap();
        conn
    }

    /// The mask every row on disk gets without waiting for a sync. `legalities` is a plain
    /// TEXT column, so this backfill needs no [`json_raw`] guard — and the row is seeded
    /// with a **gzip `raw`** anyway, because a step that reached for `raw` by mistake would
    /// then fail here rather than in the field, where `json_extract` over a gzip member is a
    /// hard `malformed JSON` error and not the NULL one might expect.
    #[test]
    fn the_v9_backfill_fills_legal_mask_and_leaves_gzip_raw_alone() {
        let conn = v8_database();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,legalities,is_paper,raw)
             VALUES ('1','Black Lotus','lea','232','en','normal',
                     '{\"vintage\":\"restricted\",\"modern\":\"not_legal\"}',1,?1)",
            [crate::card_row::gzip_raw("{}")],
        )
        .unwrap();

        migrate(&conn).expect("a gzip `raw` must not fail the v9 step");

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
        migrate(&conn).unwrap();

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
        assert!(refused.is_err(), "a NULL mask must not be storable");
    }

    /// The widened index is what makes a *filtered* browse cheap — 505 ms to 41 ms, measured
    /// 2026-08-11 over the live corpus. A v8 database already carries the narrow definition
    /// (it has done since v7 built it), and every statement in [`CARDS_INDEXES`] is
    /// `IF NOT EXISTS`, so the step has to DROP first or the widening is a silent no-op on
    /// exactly the machines that need it.
    #[test]
    fn the_v9_step_replaces_the_narrow_collapse_index_rather_than_skipping_it() {
        let conn = v8_database();

        migrate(&conn).unwrap();

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

    /// The ladder ends where the constant says it does. Written as a literal so that
    /// bumping [`SCHEMA_VERSION`] without adding the step that produces it — or adding a
    /// step and forgetting the constant — fails here rather than in the field.
    #[test]
    fn the_schema_version_is_nine() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        assert_eq!(SCHEMA_VERSION, 9);
    }

    /// **Every route to head must arrive at the same schema.** A fresh install runs the whole
    /// ladder in one `migrate`; an upgrade enters it partway and runs only the steps above
    /// where it stopped. Those two are the same claim only while every step's DDL is
    /// reachable from below it — and the merge that put v8 between v7 and v9 is exactly the
    /// event that can break it, because [`CARDS_INDEXES`] is replayed by *one* step and a
    /// database entering above that step never sees the list.
    ///
    /// So this walks every fixture the ladder has a genuine starting point for and compares
    /// the finished article against a fresh install: `cards`' columns **and** its indexes,
    /// the latter by stored SQL rather than by name, because a narrow `idx_cards_collapse`
    /// and a widened one share a name and differ in the only way that matters.
    ///
    /// The rewound fixtures are the honest ones available — [`v1_database`] is built from the
    /// frozen v1 DDL, [`v6_deck_database`] is a hand-built v6, and [`v8_database`] undoes v9
    /// over a head database. A rewind that skipped a step's own table rebuild would fail here
    /// for a reason no upgrade could produce, which is why the fixtures are what they are and
    /// not a `PRAGMA user_version` away from each other.
    #[test]
    fn every_version_ends_with_the_same_schema_as_a_fresh_install() {
        let fresh = Connection::open_in_memory().unwrap();
        migrate(&fresh).unwrap();
        let want_cols = card_columns(&fresh);
        let want_indexes = indexes_on_cards(&fresh);

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
            let name = stmt
                .split_whitespace()
                .nth(5)
                .expect("`CREATE INDEX IF NOT EXISTS <name> …`");
            assert!(declared.contains(&name), "{name} missing: {declared:?}");
        }

        for (name, conn) in [
            ("v1", v1_database()),
            ("v6", v6_deck_database()),
            ("v8", v8_database()),
        ] {
            migrate(&conn).unwrap_or_else(|e| panic!("{name} must migrate to head: {e}"));

            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(version, SCHEMA_VERSION, "{name} must reach head");
            assert_eq!(
                card_columns(&conn),
                want_cols,
                "{name} must end with a fresh install's `cards` columns"
            );
            assert_eq!(
                indexes_on_cards(&conn),
                want_indexes,
                "{name} must end with a fresh install's `cards` indexes, definitions included"
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
