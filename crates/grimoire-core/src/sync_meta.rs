//! The `sync_meta` key–value store: what the corpus knows about its own feeds.
//!
//! One table on the corpus side and three functions. Watermarks, ETags, a feed's last failure
//! and the two maintenance flags all live in it, and a corpus that is deleted and rebuilt
//! forgets every one of them — which is right, because each is a claim about rows that went
//! with it.
//!
//! **Carved out of `src-tauri`'s `sync` on 2026-10-02**, as [`crate::app_meta`] was out of
//! `update`: `sync` is the card sync and its state, and [`crate::schema::swap_staging`] and
//! [`crate::feed::backoff`] need the table without needing any of that. `sync` re-exports all
//! three at the names they had.

use rusqlite::{params, Connection, OptionalExtension};

/// `sync_meta` key: the search index is owed a rebuild, and nothing may assume otherwise.
///
/// This exists because **the conversion's completion marker is not ours to write.**
/// `auto_vacuum` flips in the file header the instant the `VACUUM` commits, which is one
/// statement *before* `maintenance::convert_to_incremental` is finished — and the rebuild that
/// follows is itself three commits (drop, create, and a populate that walks every card). A
/// process killed anywhere in that window leaves a database that reports itself converted and
/// carries an index pointing at the wrong rows, with no error and nothing to notice it: the
/// swap that would rebuild the index only happens on a sync that actually ingests, and the
/// common answer is a 304.
///
/// So the flag is written and committed *before* the `VACUUM` and cleared only once
/// `create_fts` has returned. Whoever finds it set owes the rebuild: the launch, `sync`'s
/// `compact_once` at every sync, and [`crate::schema::swap_staging`], which settles the debt
/// simply by doing the work.
///
/// It is cleared on the *failure* path too, when the failure was the `VACUUM` itself — that
/// rolls back, so nothing was desynced and a rebuild would repair damage never done.
///
/// **Here rather than in `maintenance`, which owns the flag and re-exports it**, because
/// `swap_staging` clears it and `maintenance` has not moved to this crate yet.
pub const K_FTS_REBUILD_PENDING: &str = "fts_rebuild_pending";

/// Read `sync_meta`. A missing row and an unreadable one both read as `None`: this is
/// cache metadata, and the correct response to losing it is to check again.
pub fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM sync_meta WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Write-or-delete. `sync_meta.value` is `NOT NULL`, so an absent value is stored as
/// the absence of the row — never as NULL, and never as `""`, which for an ETag would
/// mean replaying an `If-None-Match` header that can only fail to match.
pub fn set_meta_opt(conn: &Connection, key: &str, value: Option<&str>) -> rusqlite::Result<()> {
    match value.filter(|v| !v.is_empty()) {
        Some(v) => set_meta(conn, key, v),
        None => {
            conn.execute("DELETE FROM sync_meta WHERE key = ?1", params![key])?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three states a key can be in, and the one a blank is never stored as.
    #[test]
    fn a_blank_or_absent_value_is_the_absence_of_the_row() {
        let conn = crate::schema::memory_pair();
        assert_eq!(get_meta(&conn, "bulk_etag"), None);

        set_meta(&conn, "bulk_etag", "\"abc\"").unwrap();
        assert_eq!(get_meta(&conn, "bulk_etag").as_deref(), Some("\"abc\""));
        set_meta(&conn, "bulk_etag", "\"def\"").unwrap();
        assert_eq!(get_meta(&conn, "bulk_etag").as_deref(), Some("\"def\""));

        set_meta_opt(&conn, "bulk_etag", Some("")).unwrap();
        assert_eq!(get_meta(&conn, "bulk_etag"), None, "a blank is a delete");
        set_meta_opt(&conn, "bulk_etag", Some("\"ghi\"")).unwrap();
        set_meta_opt(&conn, "bulk_etag", None).unwrap();
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM sync_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "an absent value leaves no row behind");
    }
}
