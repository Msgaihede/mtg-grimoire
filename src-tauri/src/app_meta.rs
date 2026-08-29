//! The `app_meta` key–value store: one table, two functions, every target.
//!
//! **Carved out of `update.rs` for the reason [`crate::image_uri`] was carved out of
//! `images.rs`.** `update` is the portable updater — `zip`, `tokio`, and an `.exe` swapped
//! on disk — so it is `#[cfg(not(target_family = "wasm"))]` in `lib.rs`. But it also held
//! `app_meta`, which is neither: it is one SQLite table read and written by eleven modules
//! that have nothing to do with updating anything. `deck.rs` remembers whether the search
//! column is open in it; `zoom`, `nav`, `listview` and `flatten` keep their view state here.
//!
//! So the *storage* moved to a module both builds compile, and the *updater* stayed behind.
//! All sixty call sites moved with it — `crate::update::get_app_meta` is now
//! `crate::app_meta::get_app_meta` everywhere, in eleven files. A re-export from `update`
//! was tried first and does not work: `update` is itself gated, so a name re-exported from
//! it is invisible on wasm exactly when it is needed. Renaming is what actually compiles.
//!
//! **No `#[cfg]` on this module, deliberately** — the same rule `image_uri` states. A module
//! gated to `wasm32-unknown-unknown` is invisible to `cargo test`, and this one is too small
//! and too widely called to be covered on one target only.
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

    #[test]
    fn a_value_survives_the_round_trip() {
        let c = conn();
        set_app_meta(&c, "deck_search_open", "1").unwrap();
        assert_eq!(get_app_meta(&c, "deck_search_open").as_deref(), Some("1"));
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
