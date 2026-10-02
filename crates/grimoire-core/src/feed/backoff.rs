//! A day's rest for a feed whose last file arrived whole and could not be used.
//!
//! **Why it exists** (issue #551). The combos, both tag files and both price feeds leave their
//! watermark untouched when a refresh fails, which is right — a watermark is a claim about rows
//! that are there — but it means the next launch finds the feed exactly as due as before and
//! fetches it again. When the fault is upstream's (a file this build cannot parse, a manifest
//! whose size is wrong), that is the whole download and the whole parse on every launch until
//! upstream is fixed: 27.5 MB and a 639 MB JSON walk for the combos, 63.7 MiB for Card Kingdom.
//!
//! **What earns the rest is a file that arrived and was unusable, not a failure to arrive.** A
//! check that could not reach Scryfall, a connection that dropped mid-body, a 5xx before the
//! first byte: those are this machine's network, cost little or nothing to retry, and are
//! retried at the next launch exactly as before. What stamps is an ingest that refused or
//! failed over a complete download, and a download whose size disagreed with its manifest —
//! the two outcomes that repeat identically for as long as the upstream fault stands.
//!
//! **Only the launch's own refresh rests.** `refresh_if_due` and its price-feed sibling read
//! [`resting`]; a refresh the reader asks for does not, because pressing Refresh is exactly how
//! a reader says "try again now". A success clears the stamp.
//!
//! The stamp is a `sync_meta` row, `failed_at:<feed>`, which puts it on the corpus side beside
//! the watermarks it qualifies: a corpus that is deleted and rebuilt forgets it, and a fresh
//! corpus should try every feed at once.

use rusqlite::Connection;

/// How long a feed rests after a file that arrived and could not be used. A day: long enough
/// that a broken upstream costs one download a day rather than one a launch, short enough that
/// a fix upstream reaches the reader the next day without them looking for a Refresh button.
pub const FAILURE_BACKOFF_SECS: i64 = 86_400;

fn key(feed: &str) -> String {
    format!("failed_at:{feed}")
}

/// Record that `feed`'s file arrived at `now` and could not be used.
pub fn note_unusable(conn: &Connection, feed: &str, now: i64) -> rusqlite::Result<()> {
    crate::sync_meta::set_meta(conn, &key(feed), &now.to_string())
}

/// Forget `feed`'s last failure — its file has since been used.
pub fn clear(conn: &Connection, feed: &str) -> rusqlite::Result<()> {
    crate::sync_meta::set_meta_opt(conn, &key(feed), None)
}

/// When `feed`'s last unusable file arrived, if one did since its last success.
pub fn failed_at(conn: &Connection, feed: &str) -> Option<i64> {
    crate::sync_meta::get_meta(conn, &key(feed)).and_then(|v| v.parse().ok())
}

/// Is `feed` resting at `now`?
///
/// A stamp in the future — a clock that moved backwards — reads as not resting, the same
/// answer every staleness check in this crate gives a future stamp: the cost of being wrong
/// that way is one download, and the cost of the other is a feed that never refreshes again
/// until the clock catches up.
pub fn resting(conn: &Connection, feed: &str, now: i64) -> bool {
    match failed_at(conn, feed) {
        Some(at) => at <= now && now - at < FAILURE_BACKOFF_SECS,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_feed_rests_a_day_after_an_unusable_file_and_not_after_a_success() {
        let conn = crate::schema::memory_pair();
        let now = 1_800_000_000;
        assert!(!resting(&conn, "combos", now), "a feed that never failed");

        note_unusable(&conn, "combos", now).unwrap();
        assert!(resting(&conn, "combos", now));
        assert!(resting(&conn, "combos", now + FAILURE_BACKOFF_SECS - 1));
        assert!(!resting(&conn, "combos", now + FAILURE_BACKOFF_SECS));
        assert!(
            !resting(&conn, "oracle_tags", now),
            "one feed's failure is not another's"
        );
        assert!(
            !resting(&conn, "combos", now - 60),
            "a stamp from the future must not park the feed until the clock catches up"
        );

        clear(&conn, "combos").unwrap();
        assert!(!resting(&conn, "combos", now));
        assert_eq!(failed_at(&conn, "combos"), None);
    }
}
