//! Database schema: `cards`, `sets`, `sync_meta`, and the `cards_fts` search index.
//!
//! Nullability here is load-bearing. Scryfall omits `oracle_id`, `cmc` and `type_line`
//! on some printings (reversible cards, art series), `collector_number` is TEXT (values
//! like `"161★"` exist), and `legalities` is stored as a JSON blob because the format
//! list grows over time.

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

/// Bring `conn` up to the current schema version. Idempotent: tracked by
/// `PRAGMA user_version`, so a rerun on an up-to-date database is a no-op.
///
/// **Adding a column later:** leave [`CARDS_COLUMNS`] alone and add a `if v < 2` block
/// with an `ALTER TABLE cards ADD COLUMN`. The v1 `CREATE` describes what version 1
/// built; a fresh install replays the whole history, so a column added to v1 would make
/// the v2 `ALTER` fail on new machines only.
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
    Ok(())
}

/// (Re)create the external-content FTS5 index over `cards` and populate it.
///
/// `search_text` is the haystack column: ingest concatenates oracle text plus every
/// face's name and text into it.
fn create_fts(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS cards_fts;
         CREATE VIRTUAL TABLE cards_fts USING fts5(
            name, type_line, search_text,
            content='cards', tokenize='unicode61 remove_diacritics 2');
         INSERT INTO cards_fts(cards_fts) VALUES('rebuild');",
    )
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
                "SELECT count(*) FROM sqlite_master WHERE name IN ('cards','sets','sync_meta','cards_fts')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 4);

        // Without this the test would still pass while `migrate` re-ran its whole batch
        // every call (the CREATEs are all `IF NOT EXISTS`), silently rebuilding FTS each
        // time. The version bump is what makes the rerun a genuine no-op.
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 1);
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

    /// The one invariant `swap_staging` imposes on every table Plan 3 will add: a user
    /// table may reference `cards.id` only *softly*. The swap drops `cards` outright, so
    /// a declared `REFERENCES cards(id)` would abort every sync under
    /// `foreign_keys = ON`, and an `ON DELETE CASCADE` one would quietly delete the
    /// user's collection on the next refresh. `foreign_keys` is switched on here (it is
    /// off by default on a bare connection, on in `db::open`) so the failure this guards
    /// against could actually happen.
    #[test]
    fn a_soft_card_reference_survives_the_swap_that_drops_cards() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        conn.execute("INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw) VALUES ('bolt','Lightning Bolt','lea','161','en','normal','{}')", []).unwrap();

        // Shaped as spec §6 requires: `card_id` with no `REFERENCES` clause, and the
        // printing denormalised beside it so the row is still identifiable if the id
        // ever stops resolving.
        conn.execute_batch(
            "CREATE TABLE collection_entries (
                id INTEGER PRIMARY KEY, card_id TEXT NOT NULL,
                set_code TEXT NOT NULL, collector_number TEXT NOT NULL, lang TEXT NOT NULL,
                quantity INTEGER NOT NULL);
             INSERT INTO collection_entries (card_id, set_code, collector_number, lang, quantity)
                VALUES ('bolt','lea','161','en',4);",
        )
        .unwrap();

        create_staging(&conn).unwrap();
        conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('bolt','Lightning Bolt','2ed','162','en','normal','{}')", []).unwrap();
        swap_staging(&conn).expect("a sync must not be blocked by a user table");

        let (card_id, qty): (String, i64) = conn
            .query_row(
                "SELECT card_id, quantity FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (card_id.as_str(), qty),
            ("bolt", 4),
            "user rows are not sync data"
        );
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
}
