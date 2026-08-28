//! The error log: what failed, when, how often — and nothing else.
//!
//! It exists because failure in this app was very nearly invisible. `sync_meta.last_error`
//! is one string the next run overwrites, and everything else was an `eprintln!` — the
//! id-migration poll, the orphan sweep, the page reclaim, the compaction, an image the
//! filesystem refused. A release build has no console to print to, so those messages went
//! nowhere at all: the user could not see that anything had gone wrong, and neither could
//! anyone trying to debug it.
//!
//! Three rules shape the table:
//!
//! * **Repeats fold.** The grain is `(source, operation, kind, message)` and a second
//!   occurrence bumps `count` and `last_at` rather than writing a row. One bad afternoon can
//!   otherwise write a row per failed image — the path-MTU black hole this repo has already
//!   met produced ~600 in a single pass — and "one fault, 600 times" is both smaller and
//!   truer than six hundred faults. `detail` is deliberately *outside* the grain: it is the
//!   URL or card id, which is exactly the per-occurrence string that would defeat the
//!   folding, so the newest one overwrites rather than splitting the row.
//! * **Recording can never fail the thing it describes.** [`record`] returns `()`. Every
//!   caller is already on a path that tolerates failure, and a log write that could break a
//!   sync would be a strictly worse app than one with no log.
//! * **It is written inside the caller's transaction**, where one is open — the rule
//!   [`crate::deck_audit`] follows. A rolled-back write leaves no history of having happened.

use rusqlite::{params, Connection};
use serde::Serialize;

/// How many rows the log keeps. Oldest by `last_at` are evicted on insert.
///
/// A log nobody prunes is a table that grows for the life of the installation, and the
/// hundredth copy of last March's timeout helps no one. Two hundred is far more than a
/// person will read and small enough to answer instantly.
pub const MAX_ROWS: i64 = 200;

/// The longest `message` and `detail` this table will store.
///
/// A bound rather than a budget. Some of these strings come from other people's servers —
/// an HTML error page decoded as a parse failure, say — and a log entry is a sentence, not
/// a transcript.
const MAX_TEXT: usize = 500;

/// Which of the app's dealings with the outside world a failure belongs to.
///
/// CHECK-constrained in SQL as well, and narrowed in TypeScript as `ErrorSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `api.scryfall.com` — the bulk listing, `/sets`, `/migrations`.
    ScryfallApi,
    /// `cards.scryfall.io` — one card image.
    ScryfallImage,
    /// `api.github.com` — the update check and its asset download.
    GithubUpdate,
    /// The app's own SQLite: a reconcile, a sweep, a reclaim, a compaction.
    Database,
    /// The filesystem refused to store an image that was fetched successfully. Its own
    /// source rather than `Database`, because the fix is a disk and not a query.
    ImageStore,
}

impl Source {
    pub fn key(self) -> &'static str {
        match self {
            Source::ScryfallApi => "scryfall_api",
            Source::ScryfallImage => "scryfall_image",
            Source::GithubUpdate => "github_update",
            Source::Database => "database",
            Source::ImageStore => "image_store",
        }
    }
}

/// The shape of a failure — what a reader filters on, and what decides whether it is worth
/// acting on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A 429. The one kind that is the app's own fault to fix.
    RateLimited,
    Timeout,
    /// An HTTP status that is not a rate limit.
    Http,
    /// A filesystem or database error.
    Io,
    /// A body that could not be read as what it claimed to be.
    Parse,
    Other,
}

impl Kind {
    pub fn key(self) -> &'static str {
        match self {
            Kind::RateLimited => "rate_limited",
            Kind::Timeout => "timeout",
            Kind::Http => "http",
            Kind::Io => "io",
            Kind::Parse => "parse",
            Kind::Other => "other",
        }
    }
}

/// Classify a Scryfall failure, so the several call sites that report one agree on what it
/// was rather than each deciding for themselves.
pub fn kind_of(err: &crate::scryfall::ScryfallError) -> Kind {
    use crate::scryfall::ScryfallError as E;
    match err {
        E::RateLimited { .. } => Kind::RateLimited,
        E::Timeout(_) => Kind::Timeout,
        E::Io(_) => Kind::Io,
        E::SizeMismatch { .. } => Kind::Parse,
        E::NotFound => Kind::Http,
        E::Unexpected(m) if m.contains("not JSON") => Kind::Parse,
        E::Unexpected(_) => Kind::Http,
        E::Http(e) if e.is_timeout() => Kind::Timeout,
        E::Http(_) => Kind::Http,
    }
}

/// One row, as the UI reads it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEntry {
    pub id: i64,
    /// Unix seconds. The first and most recent time this exact failure happened — a pair,
    /// because "started an hour ago and is still going" is a different story from "happened
    /// once, an hour ago", and one stamp cannot tell them apart.
    pub first_at: i64,
    pub last_at: i64,
    pub source: String,
    pub operation: String,
    pub kind: String,
    pub message: String,
    pub detail: Option<String>,
    pub count: i64,
}

/// Cut a string to [`MAX_TEXT`] on a character boundary.
fn clip(text: &str) -> String {
    match text.char_indices().nth(MAX_TEXT) {
        None => text.to_owned(),
        Some((end, _)) => format!("{}…", &text[..end]),
    }
}

/// Write a failure to the log, folding it into an identical one if there is one.
///
/// **Best-effort and infallible by signature.** Every caller is on a path that already
/// tolerates failure — a sweep that did not run, an image that will be fetched again — and
/// a log write that could break one of them would make the app worse, not better. A failure
/// here is printed and dropped, which is exactly where the app was before this table
/// existed.
pub fn record(
    conn: &Connection,
    source: Source,
    operation: &str,
    kind: Kind,
    message: &str,
    detail: Option<&str>,
) {
    if let Err(e) = try_record(conn, source, operation, kind, message, detail) {
        eprintln!("could not write to the error log: {e}");
    }
}

/// [`record`]'s body, with its `Result` intact so the tests can see it.
fn try_record(
    conn: &Connection,
    source: Source,
    operation: &str,
    kind: Kind,
    message: &str,
    detail: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO error_log
            (first_at, last_at, source, operation, kind, message, detail, count)
         VALUES (unixepoch(), unixepoch(), ?1, ?2, ?3, ?4, ?5, 1)
         ON CONFLICT(source, operation, kind, message) DO UPDATE SET
            last_at = excluded.last_at,
            -- The newest detail wins. `first_at` is deliberately left alone: it is the only
            -- record of when this started, and excluded.first_at would overwrite it with now.
            detail = excluded.detail,
            count = count + 1",
        params![
            source.key(),
            operation,
            kind.key(),
            clip(message),
            detail.map(clip),
        ],
    )?;
    // Evict oldest-last-seen beyond the cap, in the same statement order every time so the
    // table cannot drift above it. `id DESC` breaks a tie within one second, which is the
    // resolution of `unixepoch()` and therefore common on a burst.
    conn.execute(
        "DELETE FROM error_log WHERE id NOT IN
            (SELECT id FROM error_log ORDER BY last_at DESC, id DESC LIMIT ?1)",
        params![MAX_ROWS],
    )?;
    Ok(())
}

/// The log, newest first.
///
/// `limit` is clamped to `1..=MAX_ROWS`. **The low end is load-bearing**: SQLite reads a
/// negative `LIMIT` as no limit at all, so a caller that passed `-1` would get the whole
/// table — the same trap `deck_audit_list` documents.
pub fn list(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<ErrorEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, first_at, last_at, source, operation, kind, message, detail, count
           FROM error_log
          ORDER BY last_at DESC, id DESC
          LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit.clamp(1, MAX_ROWS)], |r| {
        Ok(ErrorEntry {
            id: r.get(0)?,
            first_at: r.get(1)?,
            last_at: r.get(2)?,
            source: r.get(3)?,
            operation: r.get(4)?,
            kind: r.get(5)?,
            message: r.get(6)?,
            detail: r.get(7)?,
            count: r.get(8)?,
        })
    })?;
    rows.collect()
}

/// Empty the log. The one write the UI can make.
pub fn clear(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM error_log", [])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate_single_file(&conn).unwrap();
        conn
    }

    /// The point of the grain. Six hundred failed images are one fault that happened six
    /// hundred times, and a log that says so is the only one a person will read.
    #[test]
    fn an_identical_failure_folds_into_one_row_and_counts() {
        let conn = db();
        for i in 0..600 {
            record(
                &conn,
                Source::ScryfallImage,
                "image_fetch",
                Kind::Timeout,
                "timed out after 10s",
                // The per-occurrence string, and the reason it is outside the grain: a URL
                // in the key would give this test 600 rows.
                Some(&format!("https://cards.scryfall.io/art/{i}.webp")),
            );
        }

        let rows = list(&conn, 50).unwrap();
        assert_eq!(rows.len(), 1, "one fault, not six hundred");
        assert_eq!(rows[0].count, 600);
        assert_eq!(
            rows[0].detail.as_deref(),
            Some("https://cards.scryfall.io/art/599.webp"),
            "the newest detail wins"
        );
        assert!(
            rows[0].first_at <= rows[0].last_at,
            "first_at records when this started and must not be overwritten with now"
        );
    }

    /// A different message, operation, kind or source is a different fault.
    #[test]
    fn failures_that_differ_in_the_grain_are_separate_rows() {
        let conn = db();
        record(
            &conn,
            Source::ScryfallApi,
            "sets",
            Kind::Http,
            "status 503",
            None,
        );
        record(
            &conn,
            Source::ScryfallApi,
            "sets",
            Kind::Http,
            "status 502",
            None,
        );
        record(
            &conn,
            Source::ScryfallApi,
            "migrations",
            Kind::Http,
            "status 503",
            None,
        );
        record(
            &conn,
            Source::ScryfallApi,
            "sets",
            Kind::Timeout,
            "status 503",
            None,
        );
        record(
            &conn,
            Source::GithubUpdate,
            "sets",
            Kind::Http,
            "status 503",
            None,
        );

        assert_eq!(list(&conn, 50).unwrap().len(), 5);
    }

    /// A log nobody prunes grows for the life of the installation.
    #[test]
    fn the_log_is_capped_and_evicts_the_least_recently_seen() {
        let conn = db();
        for i in 0..(MAX_ROWS + 25) {
            record(
                &conn,
                Source::Database,
                &format!("op-{i}"),
                Kind::Io,
                "disk is full",
                None,
            );
        }

        let rows = list(&conn, MAX_ROWS).unwrap();
        assert_eq!(rows.len() as i64, MAX_ROWS);
        // The newest survive; the first 25 are gone.
        assert_eq!(rows[0].operation, format!("op-{}", MAX_ROWS + 24));
        assert!(!rows.iter().any(|r| r.operation == "op-0"));
    }

    /// SQLite reads a negative `LIMIT` as *no* limit, so the clamp's low end is what stops a
    /// stray `-1` returning the whole table.
    #[test]
    fn the_list_limit_is_clamped_at_both_ends() {
        let conn = db();
        for i in 0..10 {
            record(
                &conn,
                Source::Database,
                &format!("op-{i}"),
                Kind::Io,
                "boom",
                None,
            );
        }

        assert_eq!(
            list(&conn, -1).unwrap().len(),
            1,
            "a negative limit is one row"
        );
        assert_eq!(list(&conn, 0).unwrap().len(), 1);
        assert_eq!(list(&conn, 3).unwrap().len(), 3);
        assert_eq!(list(&conn, i64::MAX).unwrap().len(), 10);
    }

    /// Written inside the caller's transaction, so a write that rolls back leaves no record
    /// of having happened — `deck_audit`'s rule, for the same reason.
    #[test]
    fn a_recorded_failure_that_rolls_back_leaves_no_row() {
        let mut conn = db();
        {
            let tx = conn.transaction().unwrap();
            record(&tx, Source::Database, "sweep", Kind::Io, "boom", None);
            assert_eq!(list(&tx, 50).unwrap().len(), 1);
            tx.rollback().unwrap();
        }
        assert!(list(&conn, 50).unwrap().is_empty());
    }

    /// Some of these strings come from other people's servers. A log entry is a sentence.
    #[test]
    fn an_enormous_message_is_clipped_rather_than_stored_whole() {
        let conn = db();
        let huge = "x".repeat(10_000);
        record(
            &conn,
            Source::ScryfallApi,
            "bulk_check",
            Kind::Parse,
            &huge,
            Some(&huge),
        );

        let rows = list(&conn, 1).unwrap();
        assert_eq!(
            rows[0].message.chars().count(),
            MAX_TEXT + 1,
            "clipped, with an ellipsis"
        );
        assert_eq!(
            rows[0].detail.as_ref().unwrap().chars().count(),
            MAX_TEXT + 1
        );
    }

    /// A clip must never split a character in half — `clip` slices a `&str` by byte index,
    /// and a panic inside the *error* logger is the worst place for one.
    #[test]
    fn clipping_lands_on_a_character_boundary() {
        let multibyte = "é".repeat(10_000);
        assert_eq!(clip(&multibyte).chars().count(), MAX_TEXT + 1);
        assert_eq!(clip("short"), "short");
    }

    /// Every Scryfall failure has a kind, and the two that a reader acts on differently —
    /// a rate limit and a timeout — must never be flattened into "http".
    #[test]
    fn every_scryfall_failure_classifies() {
        use crate::scryfall::ScryfallError as E;
        assert_eq!(
            kind_of(&E::RateLimited {
                retry_after_secs: 30
            }),
            Kind::RateLimited
        );
        assert_eq!(
            kind_of(&E::Timeout(std::time::Duration::from_secs(10))),
            Kind::Timeout
        );
        assert_eq!(kind_of(&E::NotFound), Kind::Http);
        assert_eq!(kind_of(&E::Unexpected("status 503".into())), Kind::Http);
        assert_eq!(
            kind_of(&E::Unexpected("response was not JSON: x".into())),
            Kind::Parse
        );
        assert_eq!(
            kind_of(&E::SizeMismatch {
                expected: 2,
                actual: 1
            }),
            Kind::Parse
        );
    }

    #[test]
    fn clearing_empties_the_log() {
        let conn = db();
        record(&conn, Source::Database, "sweep", Kind::Io, "boom", None);
        assert_eq!(clear(&conn).unwrap(), 1);
        assert!(list(&conn, 50).unwrap().is_empty());
    }

    /// The wire shape the frontend mirrors by hand.
    #[test]
    fn dto_json_uses_the_camel_case_names_the_frontend_expects() {
        let json = serde_json::to_value(ErrorEntry {
            id: 1,
            first_at: 1_800_000_000,
            last_at: 1_800_000_060,
            source: "scryfall_api".into(),
            operation: "sets".into(),
            kind: "rate_limited".into(),
            message: "rate limited by Scryfall; retry after 30s".into(),
            detail: None,
            count: 3,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": 1,
                "firstAt": 1_800_000_000i64,
                "lastAt": 1_800_000_060i64,
                "source": "scryfall_api",
                "operation": "sets",
                "kind": "rate_limited",
                "message": "rate limited by Scryfall; retry after 30s",
                "detail": null,
                "count": 3
            })
        );
    }
}
