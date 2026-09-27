//! The `app_meta` key–value store: one table, two functions.
//!
//! **Carved out of `update.rs`.** `update` is the portable updater — `zip`, `tokio`, and an
//! `.exe` swapped on disk — but it also held `app_meta`, which is neither: it is one SQLite
//! table read and written by modules across the crate that have nothing to do with updating
//! anything (`grep -rln "app_meta::" src-tauri/src` is the census; a count here is a fact about
//! one tree). `searchopen.rs` remembers which docked search columns are open in it;
//! `shelffolds.rs` remembers which shelves the reader folded on the collection and the wishlist;
//! `zoom`, `nav` and `listview` keep their view state here.
//!
//! **Both functions swallow their errors on the read side and surface them on the write
//! side**, which is the asymmetry the original carried and worth keeping visible: a missing
//! or unreadable row is a cache miss, and the right answer to a cache miss is to ask again.
//! A failed *write* is a setting the reader asked for and did not get, so it is a `Result`.

use rusqlite::{params, Connection, OptionalExtension};

/// Read `app_meta`. A missing row and an unreadable one both read as `None`: this is cache
/// metadata, and the right response to losing it is to ask again.
pub fn get_app_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_meta WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn set_app_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table this module is named for, as `schema.rs` builds it.
    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        c
    }

    #[test]
    fn a_key_that_was_never_written_reads_as_none() {
        assert_eq!(get_app_meta(&conn(), "never-written"), None);
    }

    /// **The key is deliberately one no module owns.** This test is about the table, not about
    /// any setting stored in it, and a real key here reads as a claim about that setting's
    /// spelling — which is what it was when it named `deck_search_open`, a row nothing writes
    /// any more ([`crate::searchopen`]'s map replaced it, and the old row survives only as a
    /// read-side bridge). A made-up key can never rot.
    #[test]
    fn a_value_survives_the_round_trip() {
        let c = conn();
        set_app_meta(&c, "a_key_no_module_owns", "1").unwrap();
        assert_eq!(
            get_app_meta(&c, "a_key_no_module_owns").as_deref(),
            Some("1")
        );
    }

    /// **The `ON CONFLICT` clause is the whole point of the write.** Without it the second
    /// `set` is a `UNIQUE` violation rather than an update, and every view-state setting in
    /// the app would save exactly once and then stop.
    #[test]
    fn writing_a_key_twice_replaces_rather_than_failing() {
        let c = conn();
        set_app_meta(&c, "zoom", "3").unwrap();
        set_app_meta(&c, "zoom", "5").expect("the second write must not be a conflict");
        assert_eq!(get_app_meta(&c, "zoom").as_deref(), Some("5"));
    }

    /// A read that cannot run is a `None`, not a panic — the asymmetry the module doc names.
    /// Dropping the table is the cheapest way to make the query genuinely fail.
    #[test]
    fn an_unreadable_table_reads_as_none_rather_than_panicking() {
        let c = conn();
        set_app_meta(&c, "k", "v").unwrap();
        c.execute("DROP TABLE app_meta", []).unwrap();
        assert_eq!(get_app_meta(&c, "k"), None);
    }
}
