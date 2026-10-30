//! **Entry tags** — the reader's own free-text tags on one stack: one row of the binder
//! (`collection_entries.tags`) or one wish (`wishlist_entries.tags`, user schema v67,
//! [issue #1398](https://github.com/Msgaihede/mtg-grimoire/issues/1398)).
//!
//! **A namespace of its own.** Not a deck tag (`decks.tags`, which describes a whole deck and is
//! offered from `deck_list`), not a deck label (`deck_labels`, one coloured mark on a card inside
//! a deck) and not a Scryfall Tagger tag — `docs/agent/DOMAIN_VOCABULARY.md` keeps the words
//! apart. The suggestions an entry-tag field offers are [`entry_tags_in_use`], read off both
//! entry tables and nothing else, so a deck tag never shows up there and an entry tag never shows
//! up in Deck settings.
//!
//! **The deck tag's rules for a tidy list, by calling them**: [`crate::deck::clean_tags`] is the
//! one definition of what a list is stored as, so `cube` and `Cube` cannot be two tags on one row
//! here when they cannot be on one deck. A tag is no grain term on either table, so writing one
//! never folds two rows into one, and the write is a plain `write` rather than an `owned` one —
//! what the reader owns is not moved by what they call it.

use rusqlite::{params, Connection};
use serde::Serialize;

/// The refusal for a collection row that is no longer there — deleted on this device or by a
/// sync between the read the page drew and the press. A sentence before nothing is written,
/// never a silent no-op the reader would take for a saved list.
pub const COPY_GONE: &str = "That copy is no longer in your collection.";

/// [`COPY_GONE`] for a wish.
pub const WISH_GONE: &str = "That wish is no longer on your wishlist.";

/// One spelling of an entry tag and how many stacks wear it — rows across both entry tables,
/// each row counted once however often it repeats the tag.
///
/// **Exact spelling, not folded.** `Cube` and `cube` on two rows are two answers here; folding
/// them into the suggestion a reader sees is the page's to decide (TypeScript draws conclusions),
/// and it can only do that if this keeps both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryTagUse {
    pub tag: String,
    pub count: i64,
}

/// Replace the entry tags on collection row `id` with `tags`, tidied by
/// [`crate::deck::clean_tags`], and answer the list as stored.
///
/// The whole list, not a delta: the page holds the row's tags and sends what they should be, so
/// two presses in a row are idempotent. `updated_at` moves, as it does for every edit of the row.
pub fn set_collection_tags(
    conn: &Connection,
    id: i64,
    tags: &[String],
) -> Result<Vec<String>, String> {
    write_tags(conn, "collection_entries", id, tags, COPY_GONE)
}

/// [`set_collection_tags`] for wish `id`.
pub fn set_wish_tags(conn: &Connection, id: i64, tags: &[String]) -> Result<Vec<String>, String> {
    write_tags(conn, "wishlist_entries", id, tags, WISH_GONE)
}

/// The one statement both setters are. `table` is one of two literals above, never a caller's.
fn write_tags(
    conn: &Connection,
    table: &str,
    id: i64,
    tags: &[String],
    gone: &str,
) -> Result<Vec<String>, String> {
    let cleaned = crate::deck::clean_tags(tags);
    let stored = serde_json::to_string(&cleaned).map_err(|e| e.to_string())?;
    let changed = conn
        .execute(
            &format!("UPDATE {table} SET tags = ?2, updated_at = unixepoch() WHERE id = ?1"),
            params![id, stored],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(gone.to_owned());
    }
    Ok(cleaned)
}

/// Every entry tag in use, by exact spelling, with how many stacks wear it — ordered by tag.
///
/// **Lenient, [`crate::deck::read_tags`]' rule in SQL**: the column's `CHECK` asks only for
/// valid JSON and the column syncs, so a row a newer peer wrote may hold an object, a number in
/// the list or a list that is not one. Such a row adds nothing and fails nothing — anything but
/// a valid array is walked as `[]` (inside the `json_each` call, so no plan order can walk it
/// first), and only `text` items count: a bare JSON string would otherwise be one.
///
/// **A row repeating a tag counts once** (`count(DISTINCT …)` over the row), so the figure is
/// stacks, which is what "used on 3 cards" means to a reader.
///
/// **The collection's `Recently removed` folder is left out**: it is the app's holding area for
/// copies that left a deck with nowhere to go, not a place the reader filed anything, and a tag
/// that lives only on rows waiting to be cleared is not one the reader is using. The folder is
/// found by its kind ([`crate::schema::COLLECTION_FOLDER_KINDS`]`[2]`), one per database.
pub fn entry_tags_in_use(conn: &Connection) -> Result<Vec<EntryTagUse>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT tag, count(DISTINCT stack) FROM (
                 SELECT j.value AS tag, 'c' || e.id AS stack
                   FROM collection_entries e,
                        json_each(CASE WHEN json_valid(e.tags)
                                        AND json_type(e.tags) = 'array'
                                       THEN e.tags ELSE '[]' END) j
                  WHERE j.type = 'text'
                    AND NOT EXISTS (SELECT 1 FROM collection_folders f
                                     WHERE f.id = e.folder_id AND f.kind = ?1)
                 UNION ALL
                 SELECT j.value, 'w' || w.id
                   FROM wishlist_entries w,
                        json_each(CASE WHEN json_valid(w.tags)
                                        AND json_type(w.tags) = 'array'
                                       THEN w.tags ELSE '[]' END) j
                  WHERE j.type = 'text'
             )
             GROUP BY tag
             ORDER BY tag",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![crate::schema::COLLECTION_FOLDER_KINDS[2]], |r| {
            Ok(EntryTagUse {
                tag: r.get(0)?,
                count: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    fn words(w: &[&str]) -> Vec<String> {
        w.iter().map(|s| (*s).to_owned()).collect()
    }

    fn add_copy(conn: &Connection, id: i64, folder_id: Option<i64>) {
        conn.execute(
            "INSERT INTO collection_entries
                 (id, card_id, set_code, collector_number, lang, finish, quantity, folder_id,
                  created_at, updated_at)
             VALUES (?1, 'bolt-' || ?1, 'lea', ?1, 'en', 'nonfoil', 1, ?2, 0, 0)",
            params![id, folder_id],
        )
        .unwrap();
    }

    fn add_wish(conn: &Connection, id: i64) {
        conn.execute(
            "INSERT INTO wishlist_entries (id, oracle_id, name, quantity, created_at, updated_at)
             VALUES (?1, 'o' || ?1, 'Wish ' || ?1, 1, 0, 0)",
            params![id],
        )
        .unwrap();
    }

    fn stored(conn: &Connection, table: &str, id: i64) -> (String, i64) {
        conn.query_row(
            &format!("SELECT tags, updated_at FROM {table} WHERE id = ?1"),
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    /// Both tables: the list is tidied by `deck::clean_tags` (whitespace closed, empties and
    /// case-insensitive repeats dropped, first spelling kept), stored as JSON, answered as
    /// stored, and `updated_at` moves off the seeded `0`. An empty list clears.
    #[test]
    fn each_setter_tidies_stores_and_answers_the_list() {
        let conn = db();
        add_copy(&conn, 1, None);
        add_wish(&conn, 1);
        let messy = words(&["  Trade   bait ", "cube", "", "Cube", "binder"]);
        let want = words(&["Trade bait", "cube", "binder"]);

        assert_eq!(set_collection_tags(&conn, 1, &messy).unwrap(), want);
        assert_eq!(set_wish_tags(&conn, 1, &messy).unwrap(), want);
        for table in ["collection_entries", "wishlist_entries"] {
            let (tags, updated_at) = stored(&conn, table, 1);
            assert_eq!(tags, r#"["Trade bait","cube","binder"]"#, "{table}");
            assert!(updated_at > 0, "{table}'s updated_at moved");
        }

        assert_eq!(set_wish_tags(&conn, 1, &[]).unwrap(), Vec::<String>::new());
        assert_eq!(stored(&conn, "wishlist_entries", 1).0, "[]");
        assert_eq!(
            stored(&conn, "collection_entries", 1).0,
            r#"["Trade bait","cube","binder"]"#,
            "the wish's list is its own: the copy's is untouched"
        );
    }

    /// A row that is not there is a sentence, and nothing is written anywhere.
    #[test]
    fn a_missing_row_is_refused_in_words() {
        let conn = db();
        add_copy(&conn, 1, None);
        add_wish(&conn, 1);
        assert_eq!(
            set_collection_tags(&conn, 99, &words(&["cube"])).unwrap_err(),
            COPY_GONE
        );
        assert_eq!(
            set_wish_tags(&conn, 99, &words(&["cube"])).unwrap_err(),
            WISH_GONE
        );
        assert_eq!(stored(&conn, "collection_entries", 1).0, "[]");
        assert_eq!(stored(&conn, "wishlist_entries", 1).0, "[]");
    }

    /// Counted per stack across both tables, by exact spelling, ordered by tag; a row repeating
    /// a tag counts once; a row whose column is valid JSON of another shape — or a list holding a
    /// number — adds what it can and fails nothing; and `Recently removed` is left out.
    #[test]
    fn in_use_counts_stacks_across_both_tables_and_survives_junk() {
        let conn = db();
        let removed: i64 = conn
            .query_row(
                "SELECT id FROM collection_folders WHERE kind = 'removed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        for id in 1..=5 {
            add_copy(&conn, id, None);
            add_wish(&conn, id);
        }
        add_copy(&conn, 6, Some(removed));
        let raw = |table: &str, id: i64, tags: &str| {
            conn.execute(
                &format!("UPDATE {table} SET tags = ?2 WHERE id = ?1"),
                params![id, tags],
            )
            .unwrap();
        };
        raw("collection_entries", 1, r#"["cube","Trade bait"]"#);
        raw("collection_entries", 2, r#"["cube","cube"]"#);
        raw("collection_entries", 3, r#"{"v":2,"tags":["cube"]}"#);
        raw("collection_entries", 4, r#"[7,"binder",null]"#);
        raw("collection_entries", 5, r#""cube""#);
        raw("collection_entries", 6, r#"["only removed","cube"]"#);
        raw("wishlist_entries", 1, r#"["cube"]"#);
        raw("wishlist_entries", 2, r#"["Cube"]"#);
        raw("wishlist_entries", 3, "42");

        let used = entry_tags_in_use(&conn).unwrap();
        let used: Vec<(&str, i64)> = used.iter().map(|u| (u.tag.as_str(), u.count)).collect();
        assert_eq!(
            used,
            vec![("Cube", 1), ("Trade bait", 1), ("binder", 1), ("cube", 3)],
        );
    }

    /// The JSON the page reads.
    #[test]
    fn a_tag_use_serialises_as_the_page_expects() {
        let value = serde_json::to_value(EntryTagUse {
            tag: "cube".into(),
            count: 2,
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({ "tag": "cube", "count": 2 }));
    }

    /// **v67 over wishes that existed when it ran** — a real v66 file, head rewound by
    /// `UNDO_V67` alone and seeded before the climb (a row inserted at head would take its
    /// default from the frozen schema and pass whatever the rung did). Every wish reads `[]`,
    /// the stored `CREATE TABLE` climbs back to head's text, a second run is a no-op, and the
    /// column's `CHECK` refuses text that is not JSON on the climbed file.
    #[test]
    fn v67_gives_every_existing_wish_an_empty_tag_list() {
        use crate::schema::fixtures::{UNDO_V67, UNDO_V68};
        let sql = |conn: &Connection| -> String {
            conn.query_row(
                "SELECT sql FROM main.sqlite_master WHERE name = 'wishlist_entries'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        let head = Connection::open_in_memory().unwrap();
        crate::schema::create_user_schema(&head, "main").unwrap();
        let column = ", tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags))";

        let conn = Connection::open_in_memory().unwrap();
        crate::schema::create_user_schema(&conn, "main").unwrap();
        conn.execute_batch(&format!(
            "{UNDO_V68} {UNDO_V67} PRAGMA main.user_version = 66;"
        ))
        .unwrap();
        assert_eq!(
            sql(&conn),
            sql(&head).replacen(column, "", 1),
            "v66's wishlist_entries, byte for byte"
        );
        conn.execute_batch(
            "INSERT INTO wishlist_entries (id, oracle_id, name, quantity, notes, created_at,
                                           updated_at)
             VALUES (1, 'o1', 'Lightning Bolt', 4, 'for burn', 0, 0),
                    (2, 'o2', 'Counterspell', 1, NULL, 0, 0);",
        )
        .unwrap();

        crate::schema::migrate_user(&conn).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA main.user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 68);
        assert_eq!(sql(&conn), sql(&head), "climbed back to head's text");
        let rows: Vec<(String, i64, Option<String>)> = {
            let mut stmt = conn
                .prepare("SELECT tags, quantity, notes FROM wishlist_entries ORDER BY id")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(
            rows,
            vec![
                ("[]".to_owned(), 4, Some("for burn".to_owned())),
                ("[]".to_owned(), 1, None),
            ]
        );
        crate::schema::migrate_user(&conn).unwrap();

        let err = conn
            .execute("UPDATE wishlist_entries SET tags = 'cube' WHERE id = 1", [])
            .unwrap_err()
            .to_string();
        assert!(err.contains("CHECK constraint failed"), "{err}");
    }

    /// The column is on the `wishlist_entries` capture spec: once `capture::install` has run on
    /// a paired device, a tag written to a wish is one op on the wire.
    #[test]
    fn a_wish_tag_write_is_captured_for_sync() {
        let conn = db();
        crate::sync_engine::capture::install(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'dev-a', x'00', x'01', 'A', 0);
             INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g', 0, x'02', 0);",
        )
        .unwrap();
        add_wish(&conn, 1);
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        set_wish_tags(&conn, 1, &words(&["cube"])).unwrap();
        let ops: i64 = conn
            .query_row(
                "SELECT count(*) FROM sync_ops WHERE tbl = 'wishlist_entries'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ops, 1);
    }
}
