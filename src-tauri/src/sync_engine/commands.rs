//! The five commands the Settings page calls.
//!
//! **Desktop and Android only, like every other `#[tauri::command]` in the crate.** Everything
//! they orchestrate — [`super::client`], [`super::apply`], [`super::wire`] — compiles for wasm;
//! this file is the IPC surface, and the browser reaches the same functions through
//! `web::route` when it grows a panel of its own.

use crate::sync::{self, AppState};
use crate::sync_engine::client::{self, RelayOutcome};
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Arc;

/// The tables that can hold a sentence for the reader, and what to call a row of each.
///
/// **Six, and the spec named two.** `needs_review` was on `collection_entries`, `deck_cards`
/// and `wishlist_entries` before this PR; user schema v29 added it to the three folder tables,
/// because §7.4's second surfaced outcome is a broken folder cycle and no folder table had
/// anywhere to say so.
///
/// `collection_entries` is the one with no name of its own — it is a printing rather than a
/// card — so it borrows one from the corpus and falls back to what is printed on the card,
/// which is the same insurance the column list is denormalised for.
const REVIEWABLE: [(&str, &str); 6] = [
    (
        "collection_entries",
        "coalesce((SELECT name FROM cards WHERE cards.id = t.card_id),
                  t.set_code || ' ' || t.collector_number)",
    ),
    ("deck_cards", "t.name"),
    ("wishlist_entries", "t.name"),
    ("collection_folders", "t.name"),
    ("deck_folders", "t.name"),
    ("wishlist_folders", "t.name"),
];

/// What the Sync panel draws about the relay.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    /// Empty means sync is off, which is the state every existing installation is in.
    pub relay_url: String,
    pub paired: bool,
    /// Ops this device has written and not yet handed over.
    pub pending: i64,
    pub last_sync_at: Option<i64>,
    /// The most recent relay failure, as the sentence `error_log` holds. `None` once a run has
    /// succeeded is deliberately **not** the rule — the log is the record, and clearing it is
    /// the Error log panel's button rather than a side effect of a later success.
    pub last_error: Option<String>,
    /// Rows carrying a `needs_review` sentence, across all six tables that can.
    pub review_count: i64,
}

/// One row asking to be looked at.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRow {
    /// Which table it is in. The panel groups by this and the clear command needs it.
    pub table: String,
    /// The row's `sync_uid`, which is what identifies it across devices and what the clear
    /// command addresses. Never a rowid: `muted_tags` has none, and a rowid means nothing on
    /// the other machine anyway.
    pub uid: String,
    /// What to call it on screen.
    pub title: String,
    /// The sentence itself, shown verbatim. Rust wrote it; the page does not reword it.
    pub sentence: String,
}

fn read_status(conn: &Connection) -> Result<RelayStatus, String> {
    let pending: i64 = conn
        .query_row(
            "SELECT count(*) FROM sync_ops WHERE pushed_at IS NULL",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let paired = crate::sync_pair::identity::group(conn)
        .map_err(|e| e.to_string())?
        .is_some();
    let last_error: Option<String> = conn
        .query_row(
            "SELECT message FROM error_log WHERE source = 'relay'
              ORDER BY last_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(RelayStatus {
        relay_url: client::relay_url(conn).unwrap_or_default(),
        paired,
        pending,
        last_sync_at: client::get_state(conn, client::LAST_SYNC_AT).and_then(|v| v.parse().ok()),
        last_error,
        review_count: review_count(conn)?,
    })
}

fn review_count(conn: &Connection) -> Result<i64, String> {
    let mut total = 0;
    for (table, _) in REVIEWABLE {
        let n: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {table} WHERE needs_review IS NOT NULL"),
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        total += n;
    }
    Ok(total)
}

fn read_review(conn: &Connection) -> Result<Vec<ReviewRow>, String> {
    let mut out = Vec::new();
    for (table, title) in REVIEWABLE {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT t.sync_uid, {title}, t.needs_review FROM {table} t
                  WHERE t.needs_review IS NOT NULL
                  ORDER BY t.rowid"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ReviewRow {
                    table: table.to_owned(),
                    uid: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    sentence: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

/// What the reader may set the relay URL to.
///
/// **`http` or `https` and nothing else**, refused with a sentence rather than a constraint
/// failure. An empty string is the way to switch sync off and is always accepted.
fn valid_relay_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err(
            "A relay address has to start with https:// (or http:// for one on this machine)."
                .to_owned(),
        );
    }
    Ok(trimmed.to_owned())
}

/// What Settings draws: the relay, what is waiting, and what wants looking at.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_relay_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<RelayStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::with_write(&state, read_status))
        .await
        .map_err(|e| e.to_string())?
}

/// Point this device at a relay, or at none.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_relay_set_url(
    state: tauri::State<'_, Arc<AppState>>,
    url: String,
) -> Result<RelayStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let url = valid_relay_url(&url)?;
        sync::with_write(&state, |conn| {
            client::set_state(conn, client::RELAY_URL, &url).map_err(|e| e.to_string())?;
            read_status(conn)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One round trip now.
///
/// **On the blocking pool with a runtime of its own**, and that is not ceremony. The write
/// connection is behind a `Mutex`, so a guard on it cannot cross an `await` on a multi-threaded
/// runtime; `spawn_blocking` moves the whole trip to a thread where a `block_on` is legal and
/// the guard never has to be `Send`.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_now(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<RelayOutcome>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        sync::with_write(&state, |conn| runtime.block_on(client::run_once(conn)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every row carrying a sentence, from all six tables that can hold one.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_review_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ReviewRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::with_write(&state, read_review))
        .await
        .map_err(|e| e.to_string())?
}

/// "Looks fine": clear one row's sentence.
///
/// **A fifth command the plan does not list, and the panel it describes cannot work without
/// it.** Clearing is a write like any other, so it is captured and travels: a row one device
/// has looked at stops asking on the others too, which is the whole point of the sentence
/// being on the row rather than in a notification.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_review_clear(
    state: tauri::State<'_, Arc<AppState>>,
    table: String,
    uid: String,
) -> Result<Vec<ReviewRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **The table name is checked against the census and never interpolated raw.** It
        // arrives from the webview, and every other statement in this file builds its SQL by
        // `format!`.
        if !REVIEWABLE.iter().any(|(t, _)| *t == table) {
            return Err("That is not a table with anything to review.".to_owned());
        }
        sync::with_write(&state, |conn| {
            conn.execute(
                &format!("UPDATE {table} SET needs_review = NULL WHERE sync_uid = ?1"),
                [&uid],
            )
            .map_err(|e| e.to_string())?;
            read_review(conn)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::capture;

    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        capture::install(&conn).unwrap();
        conn
    }

    #[test]
    fn every_reviewable_table_really_has_the_column() {
        let conn = db();
        for (table, _) in REVIEWABLE {
            let n: i64 = conn
                .query_row(
                    &format!(
                        "SELECT count(*) FROM pragma_table_info('{table}')
                          WHERE name = 'needs_review'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table} cannot hold a sentence");
        }
    }

    /// ...and no table that *can* hold one is left off the list, which is the direction that
    /// loses a sentence rather than raising an error.
    #[test]
    fn no_table_with_the_column_is_missing_from_the_list() {
        let conn = db();
        let mut stmt = conn
            .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for table in tables {
            let has: i64 = conn
                .query_row(
                    &format!(
                        "SELECT count(*) FROM pragma_table_info('{table}')
                          WHERE name = 'needs_review'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if has == 1 {
                assert!(
                    REVIEWABLE.iter().any(|(t, _)| *t == table),
                    "{table} holds sentences nobody will ever be shown"
                );
            }
        }
    }

    #[test]
    fn a_relay_url_must_name_a_scheme() {
        assert_eq!(valid_relay_url("  ").unwrap(), "");
        assert_eq!(
            valid_relay_url("https://relay.example.workers.dev/").unwrap(),
            "https://relay.example.workers.dev"
        );
        assert_eq!(
            valid_relay_url("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert!(valid_relay_url("relay.example.workers.dev").is_err());
        assert!(valid_relay_url("ftp://relay").is_err());
    }

    #[test]
    fn a_fresh_database_has_nothing_to_say_about_the_relay() {
        let conn = db();
        let status = read_status(&conn).unwrap();
        assert_eq!(
            status,
            RelayStatus {
                relay_url: String::new(),
                paired: false,
                pending: 0,
                last_sync_at: None,
                last_error: None,
                review_count: 0,
            }
        );
    }

    #[test]
    fn a_flagged_row_is_listed_with_its_sentence_and_can_be_cleared() {
        let conn = db();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,needs_review,
                 sync_uid,created_at,updated_at)
             VALUES ('c1','lea','1','en','nonfoil','NM',1,?1,'u1',0,0)",
            [crate::sync_engine::apply::RESURRECTED],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_folders (name, sort_order, needs_review, sync_uid,
                                       created_at, updated_at)
             VALUES ('Binder', 0, ?1, 'u2', 0, 0)",
            [crate::sync_engine::apply::CYCLE_BROKEN],
        )
        .unwrap();

        let rows = read_review(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(read_status(&conn).unwrap().review_count, 2);
        // The collection row has no name of its own and falls back to what is on the card.
        assert_eq!(rows[0].title, "lea 1");
        assert_eq!(rows[0].sentence, crate::sync_engine::apply::RESURRECTED);
        assert_eq!(rows[1].table, "deck_folders");
        assert_eq!(rows[1].title, "Binder");

        conn.execute(
            "UPDATE collection_entries SET needs_review = NULL WHERE sync_uid = 'u1'",
            [],
        )
        .unwrap();
        assert_eq!(read_review(&conn).unwrap().len(), 1);
    }
}
