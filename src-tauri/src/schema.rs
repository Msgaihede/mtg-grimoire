//! Database schema: `cards`, `sets`, `sync_meta`, the `cards_fts` search index, and the
//! user's own tables — `collection_entries`, `wishlist_entries`, `card_migrations`.
//!
//! Nullability here is load-bearing. Scryfall omits `oracle_id`, `cmc` and `type_line`
//! on some printings (reversible cards, art series), `collector_number` is TEXT (values
//! like `"161★"` exist), and `legalities` is stored as a JSON blob because the format
//! list grows over time.
//!
//! The line that runs through the whole file: the first four tables are *sync data* and
//! `cards` is dropped and recreated wholesale on every sync (see [`swap_staging`]); the
//! last three are the user's, are never dropped, and therefore reference `cards.id`
//! **softly** — no `REFERENCES` clause anywhere, with the printing denormalised beside
//! the id so a row stays identifiable after the id it points at stops resolving.

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
const CARDS_INDEXES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_cards_oracle ON cards(oracle_id)",
    "CREATE INDEX IF NOT EXISTS idx_cards_set_cn ON cards(set_code, collector_number)",
    "CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name)",
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
/// `migrate_is_idempotent_and_creates_tables` pins. Named because three tests and the
/// final `PRAGMA user_version` write all have to mean the same number.
pub const SCHEMA_VERSION: i64 = 4;

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
pub const COLLECTION_GRAIN: &str = "card_id, finish, condition, lang, altered, signed, proxy, \
     misprint, coalesce(serial_number, ''), coalesce(grading, '')";

/// The wishlist's grain: an oracle card, optionally pinned to one printing and one finish.
/// `card_id IS NULL` means "any printing" (spec §6), which is a different wish from a
/// specific one rather than a looser version of it.
pub const WISHLIST_GRAIN: &str =
    "coalesce(oracle_id, ''), coalesce(card_id, ''), coalesce(preferred_finish, '')";

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
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS cards ({CARDS_COLUMNS});
             {indexes}
             CREATE TABLE IF NOT EXISTS sets (
                code TEXT PRIMARY KEY, name TEXT NOT NULL, arena_code TEXT, mtgo_code TEXT,
                set_type TEXT, released_at TEXT, icon_svg_uri TEXT);
             CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            indexes = cards_indexes_sql()
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
        // and head is 4. Writing head here would commit "migrated" before the v4 step had
        // run, so a v4 that then failed would leave a database claiming a schema it does
        // not have — with no way back, because `migrate` only ever walks upwards.
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
        tx.execute_batch(&format!(
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
                -- {{company, grade, cert}}. JSON because the shape differs per grader
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
                ON collection_entries ({grain});
             CREATE INDEX IF NOT EXISTS idx_collection_card
                ON collection_entries (card_id);
             CREATE INDEX IF NOT EXISTS idx_collection_review
                ON collection_entries (needs_review) WHERE needs_review IS NOT NULL;

             CREATE TABLE IF NOT EXISTS wishlist_entries (
                id INTEGER PRIMARY KEY,
                -- The oracle card. NULLABLE, because reversible cards genuinely have no
                -- oracle_id and a wish for one can only be a wish for its printing.
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
                ON wishlist_entries ({wish});
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
            grain = COLLECTION_GRAIN,
            wish = WISHLIST_GRAIN
        ))?;
        tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
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
/// **It is also the one step here that is not allowed to stop a launch.** Every other
/// failure in this function means the database cannot be used at all; a rebuild that fails
/// means search is wrong, which is bad and is not the same thing. Making it fatal would turn
/// a full disk into an app that refuses to start and tells the user to move a perfectly
/// good `mtg.db` aside. So it is logged, the debt is left recorded, and the next launch —
/// or the next sync, through `compact_once` — tries again.
///
/// The drop is not tidiness. The ingest commits its staging load a batch at a time, so a
/// sync that is killed partway — a closed lid, a pulled stick, a crash — leaves a
/// *committed* staging table holding most of a card database: measured against the ~880 MB
/// `mtg.db`, that is several hundred megabytes. Nothing reclaims it on its own, because the
/// only other `DROP` is inside [`create_staging`], and the next launch's sync short-circuits
/// on its stored ETag until Scryfall rotates the bulk file — so the residue can sit there
/// for days while every launch adds nothing but reads around it.
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
    conn.execute_batch("DROP TABLE IF EXISTS cards_staging")
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

#[cfg(test)]
mod tests {
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
                  'collection_entries','wishlist_entries','card_migrations')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 7);

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

    /// A killed sync leaves a *committed* staging table now that the ingest chunks its
    /// load — several hundred megabytes of it, on the database of an app that ships on a
    /// USB stick. Nothing else would drop it for days: `create_staging` is the only other
    /// `DROP`, and it does not run until the sync stops short-circuiting on its stored
    /// ETag, which waits on Scryfall rotating the bulk file.
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
                 AND name IN ('idx_cards_oracle','idx_cards_set_cn','idx_cards_name')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            idx, 3,
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
        // whatever the new `cards` row says. That is the point of storing it.
        let (set, cn): (String, String) = conn
            .query_row(
                "SELECT set_code, collector_number FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((set.as_str(), cn.as_str()), ("lea", "161"));
    }

    /// Two copies are one row when they agree on the grain, and two rows when they do not.
    /// The `coalesce`s are load-bearing: SQLite treats NULLs in a UNIQUE index as distinct,
    /// so without them a second unserialised copy would insert instead of conflicting, and
    /// the upsert every quick-add depends on would silently create duplicates.
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

        let n: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 5);
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
        // with each other on the grain — `nonfoil`/`NM` is both the third finish and the
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
    /// `migrate` now runs straight through to 2 and there is no way back.
    fn v1_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE cards ({CARDS_COLUMNS});
             {indexes}
             CREATE TABLE sets (
                code TEXT PRIMARY KEY, name TEXT NOT NULL, arena_code TEXT, mtgo_code TEXT,
                set_type TEXT, released_at TEXT, icon_svg_uri TEXT);
             CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = 1;",
            indexes = cards_indexes_sql()
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
    #[test]
    fn the_v3_backfill_steps_over_a_row_whose_raw_is_not_json() {
        let conn = v1_database();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES ('gz','Compressed','tst','1','en','normal', ?1)",
            [crate::card_row::gzip_raw(
                r#"{"object":"card","artist":"Rebecca Guay"}"#,
            )],
        )
        .unwrap();

        migrate(&conn).expect("a non-JSON `raw` must not fail the migration");

        let artist: Option<String> = conn
            .query_row("SELECT artist FROM cards WHERE id='gz'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(artist, None, "skipped, not guessed at");
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
}
