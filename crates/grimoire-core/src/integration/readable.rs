//! **What this device can publish whole** — the publish round's three questions about its own
//! data, asked of a share (`share::publish::refresh_live`) and of a projection table
//! (`super::publish`) alike (issue #1396's review).
//!
//! A published document overwrites the one another device sent, and the device that sent the good
//! one never puts it right: its own digest still matches. So a device publishes only what it can
//! read as well as the group's other devices can:
//!
//! 1. **Every printing it names is in this device's `cards`** — or is a printing that has left
//!    Scryfall: a row whose printing is missing ([`Printing`]) and whose own row was written
//!    **after** this device's bulk file ([`Printing::Unseen`]) is a card the file is too old to
//!    know — a preview card, a new set — and is never published from here; one written **before**
//!    it ([`Printing::Orphaned`]) is a genuine orphan, published only from a device whose card data
//!    is current ([`corpus_current`]), so that it is known to be gone rather than not yet arrived.
//! 2. **Its prices are this device's to read**: a document priced at Card Kingdom or Mana Pool reads
//!    a downloaded feed (`marketplace_feed`), which a device fetches only for its own selected
//!    marketplace — so it is published from here only while this device's feed for that
//!    marketplace is current ([`feed_current`]). TCGplayer's and Cardmarket's prices come with the
//!    card data and need no check.

use crate::sorting::Marketplace;
use rusqlite::Connection;

/// **How recent this device's card data must be for it to publish a row its `cards` cannot name**:
/// Scryfall's bulk file, as this device last downloaded it (`sync_meta`'s `bulk_updated_at`), no
/// older than this.
///
/// Scryfall writes that file once a day and an app that is running checks for a new one once a
/// day, so a device in ordinary use holds a file at most a day or two old; seventy-two hours is
/// that and a day's margin. A device that has been closed for longer — or that has not finished its
/// first download, or holds a download a metered link put off — may well be missing a set the
/// group's other devices have. A row newer than the file is held however recent the file is
/// ([`Printing::Unseen`]); this window is for the rows older than it.
pub const CORPUS_CURRENT_SECS: i64 = 72 * 60 * 60;

/// **How recent this device's download of a marketplace's price feed must be for it to publish a
/// document priced at that marketplace**: `marketplace_feed_meta.fetched_at`, no older than this.
///
/// A feed is fetched only for the marketplace a device has selected, once a day at launch
/// (`marketplace_feed::REFRESH_INTERVAL_SECS`), so a device that uses that marketplace holds a feed
/// at most a day or so old — seventy-two hours is that and the corpus's margin. **Present is not
/// enough**: a device that once chose Card Kingdom and has since switched keeps those rows for ever,
/// and they grow older every day; one that never chose it has none, and every price it read would
/// be absent. Either would republish the group's document with prices the device that chose it
/// does not see.
pub const FEED_CURRENT_SECS: i64 = 72 * 60 * 60;

/// Whether this device's card data is current enough to publish a [`Printing::Orphaned`] row —
/// see [`CORPUS_CURRENT_SECS`]. **No bulk file on record, or one SQLite cannot read the date of,
/// is not current.**
pub fn corpus_current(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT unixepoch() - unixepoch(value) FROM sync_meta WHERE key = ?1",
        [crate::sync::K_BULK_UPDATED_AT],
        |r| r.get::<_, Option<i64>>(0),
    )
    .ok()
    .flatten()
    .is_some_and(|age| age <= CORPUS_CURRENT_SECS)
}

/// Whether this device can read `market`'s prices as the group's other devices do: always for a
/// marketplace whose prices come with the card data, and for a feed-priced one only while this
/// device's feed for it is current ([`FEED_CURRENT_SECS`]). A stamp in the future — a clock that
/// moved — is not current, `marketplace_feed::is_stale`'s rule.
pub fn feed_current(conn: &Connection, market: Marketplace) -> bool {
    let id = crate::share::snapshot::marketplace_id(market);
    if !crate::marketplace_feed::is_feed_backed(id) {
        return true;
    }
    conn.query_row(
        "SELECT unixepoch() - fetched_at FROM marketplace_feed_meta WHERE marketplace = ?1",
        [id],
        |r| r.get::<_, Option<i64>>(0),
    )
    .ok()
    .flatten()
    .is_some_and(|age| (0..=FEED_CURRENT_SECS).contains(&age))
}

/// Whether a row's printing is in this device's `cards`, and when it is not, which side of this
/// device's bulk file the row was written on. **Never on the wire.**
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Printing {
    /// In `cards`: named, pictured, priced.
    #[default]
    Known,
    /// Missing, on a row written no later than this device's bulk file — a printing that has left
    /// Scryfall, or one the file has not caught up with; published only from a current corpus.
    Orphaned,
    /// Missing, on a row written after this device's bulk file (or with no bulk file at all) — a
    /// card newer than this device's card data. Never published from here.
    Unseen,
}

impl Printing {
    /// The code [`printing_of`]'s SQL answers.
    pub(crate) fn from_code(code: i64) -> Printing {
        match code {
            0 => Printing::Known,
            1 => Printing::Orphaned,
            _ => Printing::Unseen,
        }
    }
}

/// The SQL that reads a row's [`Printing`] as a code — `0` known, `1` orphaned, `2` unseen — where
/// `card` is the joined `cards` alias and `row` the row's own, which carries `updated_at`.
/// `known_also` is a further condition under which the row counts as known (a deck with no cover
/// names no printing), or `"0"` for none.
pub(crate) fn printing_of(card: &str, row: &str, known_also: &str) -> String {
    format!(
        "CASE WHEN {card}.id IS NOT NULL OR ({known_also}) THEN 0
              WHEN {row}.updated_at <= coalesce(
                  (SELECT unixepoch(value) FROM sync_meta WHERE key = '{key}'), -1) THEN 1
              ELSE 2 END",
        key = crate::sync::K_BULK_UPDATED_AT
    )
}

/// How many rows of a document — or cards of a share — name a printing this device's `cards`
/// lacks, by [`Printing`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Unknown {
    pub orphaned: usize,
    pub unseen: usize,
}

impl Unknown {
    /// Count one row.
    pub fn add(&mut self, printing: Printing) {
        match printing {
            Printing::Known => {}
            Printing::Orphaned => self.orphaned += 1,
            Printing::Unseen => self.unseen += 1,
        }
    }

    /// Whether a document holding these rows is this device's to publish: no unseen row ever, and
    /// an orphaned one only from a current corpus.
    pub fn publishable(self, corpus_current: bool) -> bool {
        self.unseen == 0 && (self.orphaned == 0 || corpus_current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_db() -> Connection {
        crate::schema::memory_pair()
    }

    /// The decision, every branch: unseen never, orphaned only from a current corpus.
    #[test]
    fn unseen_rows_never_publish_and_orphans_only_from_a_current_corpus() {
        let none = Unknown::default();
        assert!(none.publishable(false));
        let orphan = Unknown {
            orphaned: 1,
            unseen: 0,
        };
        assert!(!orphan.publishable(false));
        assert!(orphan.publishable(true));
        let unseen = Unknown {
            orphaned: 0,
            unseen: 1,
        };
        assert!(!unseen.publishable(true));
    }

    /// **TCGplayer and Cardmarket need no feed; Card Kingdom and Mana Pool need a current one** —
    /// none at all, one days old, and one from the future are each not current.
    #[test]
    fn a_feed_priced_marketplace_is_readable_only_with_a_current_feed() {
        let conn = open_db();
        assert!(feed_current(&conn, Marketplace::Tcgplayer));
        assert!(feed_current(&conn, Marketplace::Cardmarket));
        assert!(!feed_current(&conn, Marketplace::Manapool), "never fetched");
        let fetched = |age: i64| {
            conn.execute(
                "INSERT OR REPLACE INTO marketplace_feed_meta
                   (marketplace, fetched_at, feed_built_at, row_count)
                 VALUES ('manapool', unixepoch() - ?1, NULL, 1)",
                [age],
            )
            .unwrap();
        };
        fetched(3600);
        assert!(feed_current(&conn, Marketplace::Manapool));
        assert!(
            !feed_current(&conn, Marketplace::Cardkingdom),
            "another feed's rows"
        );
        fetched(FEED_CURRENT_SECS + 1);
        assert!(
            !feed_current(&conn, Marketplace::Manapool),
            "a feed this device left behind"
        );
        fetched(-3600);
        assert!(
            !feed_current(&conn, Marketplace::Manapool),
            "a clock that moved"
        );
    }

    /// The bulk file's date is read as SQLite reads Scryfall's stamp; none on record is not
    /// current.
    #[test]
    fn the_corpus_is_current_for_seventy_two_hours_after_its_bulk_file() {
        let conn = open_db();
        assert!(!corpus_current(&conn));
        let aged = |hours: i64| {
            conn.execute(
                "INSERT OR REPLACE INTO sync_meta (key, value)
                 VALUES (?1, strftime('%Y-%m-%dT%H:%M:%S.000+00:00', 'now', ?2))",
                rusqlite::params![crate::sync::K_BULK_UPDATED_AT, format!("-{hours} hours")],
            )
            .unwrap();
        };
        aged(1);
        assert!(corpus_current(&conn));
        aged(CORPUS_CURRENT_SECS / 3600 + 1);
        assert!(!corpus_current(&conn));
    }
}
