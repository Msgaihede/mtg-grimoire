//! **The publish round, and the loop that runs it** (plan §4): after a successful sync trip,
//! debounced, refresh every live share of the group whose snapshot moved, and — when the group's
//! integrations store exists — send it each projection table whose digest differs from the
//! store's.
//!
//! **After a trip and never inside one.** The loop reads the stamp `sync_engine::client`'s
//! round trip already writes at the end of every successful trip (`sync_state.last_sync_at`), one
//! local read every [`POLL`], so nothing under `sync_engine/` or `sync_pair/` knows this exists.
//! When to act is [`due`], a pure function of what the loop has seen and a monotonic clock, tested
//! with explicit clocks; one poll is [`step`], which a test drives; what a round does is
//! [`round`], which holds no clock at all.
//!
//! **Every host's, and a host starts it** — [`run`] is the loop as a future, which the desktop,
//! the Android host and the web host each spawn beside `sync_engine::live::run`. It names no
//! window and says nothing to a page: what the panel draws is the cache `settings` keeps, which a
//! round writes.
//!
//! **Only what this device can read whole is published** (the review of issue #1396,
//! [`super::readable`]). A device with no card data yet publishes nothing at all — the round waits
//! for its corpus. Otherwise it passes over a share or a table holding a card newer than its card
//! data, one holding a card that has left Scryfall unless its card data is current, and one that
//! reads Card Kingdom's or Mana Pool's prices unless its feed for that marketplace is current:
//! published, each would be ids for names, no pictures or no prices over a good document another
//! device sent — and that device, whose own digest still matches, would never put it right.
//!
//! **In the group's marketplace, never this device's**: a share in the one it was published under
//! (`share::publish::refresh_live`), the projection in the one the store holds
//! ([`store::StoreSettings`]). The marketplace is a device's setting, and two devices set to two
//! would otherwise flip every price, and every digest, on every round.
//!
//! **A round holds the sync lane** (plan §2), as the desktop's share timer did, and every request
//! in it is bounded: trips queue behind it and nothing is refused. The projection is read on the
//! read connection where the host has one ([`Store::reading`]), so the second or so a large
//! collection takes holds neither the writer nor a reader's edit; and the round gives a host with
//! one thread a turn between shares and between tables ([`timer::yield_to_host`]).

use super::projection;
use super::readable;
use super::settings::{self, ROUND_FAILED};
use super::store::{self, Put};
use crate::errors::{self, Kind, Source};
use crate::platform::{clock, spawn, timer};
use crate::sorting::Marketplace;
use crate::state::{State, Store};
use crate::sync_engine::client;
use std::sync::Arc;
use std::time::Duration;

/// How often the loop reads the trip stamp and the publish request: one `SELECT` of a few rows on
/// the read connection, and the whole of its cost on a device that has nothing to publish.
pub const POLL: Duration = Duration::from_secs(15);

/// A trip the loop has not acted on makes a round due once **no newer trip has landed for this
/// long** — a burst of edits, each pushed three seconds after the last
/// (`sync_engine::schedule::WRITE_DEBOUNCE_MS`), is one round at its end.
pub const QUIET_MS: u64 = 20_000;

/// …or **this long after the first trip not acted on**, if trips keep landing — a long editing
/// session publishes every five minutes rather than not at all until it stops.
pub const LONGEST_MS: u64 = 5 * 60 * 1000;

/// How long a device that last heard "off" leaves its group's store unasked (plan §2). One that
/// last heard "on" asks on every round; one that has never asked, asks.
pub const OFF_RECHECK_SECS: i64 = 6 * 60 * 60;

// ---------------------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------------------

/// What the loop has seen of the trip stamp — everything [`due`] decides on but the request and
/// the clock. In memory and never stored, so **the first trip after a launch is always acted on**:
/// a fresh loop has acted on nothing, and whatever stamp it reads first is a trip it has not.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Seen {
    /// The newest `last_sync_at` read (unix seconds, the trip's own stamp), and when the loop
    /// first read it (milliseconds on the loop's monotonic clock).
    pub latest: Option<(i64, u64)>,
    /// The stamp the last trip-triggered round acted on.
    pub acted: Option<i64>,
    /// When the first trip not yet acted on was read.
    pub waiting_since: Option<u64>,
}

impl Seen {
    /// One read of the stamp at `now`. **Any other value is a new trip** — a larger one is the
    /// ordinary case, and a smaller one is a clock that moved, which is still a trip that ended.
    /// No stamp at all (a device that has never synced) is nothing seen.
    pub fn saw(&mut self, stamp: Option<i64>, now: u64) {
        let Some(stamp) = stamp else {
            return;
        };
        if self.latest.map(|(seen, _)| seen) == Some(stamp) {
            return;
        }
        self.latest = Some((stamp, now));
        if self.acted != Some(stamp) && self.waiting_since.is_none() {
            self.waiting_since = Some(now);
        }
    }

    /// A round has run for a trip, over a database that held every trip up to `stamp` — the
    /// latest the loop had seen when it started. **A trip that landed during the round is still
    /// owed one**: it is waiting from when it was seen.
    pub fn acted_on(&mut self, stamp: Option<i64>) {
        if stamp.is_some() {
            self.acted = stamp;
        }
        self.waiting_since = match self.latest {
            Some((latest, seen)) if Some(latest) != self.acted => Some(seen),
            _ => None,
        };
    }
}

/// Whether a round is due at `now`: **at once when one was asked for** (a switch turned on, its
/// columns changed); otherwise when a trip has gone unacted [`QUIET_MS`] with no newer trip, or
/// [`LONGEST_MS`] after the first unacted trip however many have landed since. Never with no
/// trip unacted.
pub fn due(seen: &Seen, requested: bool, now: u64) -> bool {
    if requested {
        return true;
    }
    let Some((latest, seen_at)) = seen.latest else {
        return false;
    };
    if seen.acted == Some(latest) {
        return false;
    }
    let quiet = now.saturating_sub(seen_at) >= QUIET_MS;
    let long = seen
        .waiting_since
        .is_some_and(|since| now.saturating_sub(since) >= LONGEST_MS);
    quiet || long
}

// ---------------------------------------------------------------------------------------
// What
// ---------------------------------------------------------------------------------------

/// What one round did — for a test, and for nothing else: the panel reads the cache, and every
/// failure here is already an `error_log` row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    /// Whether the round ran: `false` on a device that is not entitled or in no group, which
    /// asks nobody anything and writes nothing — and on one with no card data yet.
    pub ran: bool,
    /// The round waited for this device's card data: there is none yet. A publish asked for is
    /// still owed.
    pub deferred: bool,
    /// The shares republished, by id.
    pub shares: Vec<String>,
    /// The share half's failure.
    pub shares_error: Option<String>,
    /// What the store said of itself — `Some(true)` there, `Some(false)` gone — or `None` when it
    /// was not asked: a build with no address, or a device that heard "off" lately.
    pub store: Option<bool>,
    /// The tables the store took.
    pub sent: Vec<&'static str>,
    /// The tables a device that had seen more had already published.
    pub stale: Vec<&'static str>,
    /// The tables that moved but hold a row this device's card data cannot name, while that data
    /// is not current — left for a device that can read them whole.
    pub held: Vec<&'static str>,
    /// The projection half's failure.
    pub error: Option<String>,
}

/// One round. **Skipped silently — no request, no row — unless this device is entitled and in a
/// group**, which is every device that has connected nothing, **and deferred until it has card
/// data at all**; otherwise two halves, and **one failing does not stop the other**:
///
/// 1. **Shares** — `share::publish::refresh_live`: any live share of the group whose snapshot no
///    longer reads as this device's last upload of it goes up again, in its own marketplace, if
///    this device can read it whole. Its errors are its own rows.
/// 2. **The projection** — when the cache says the store is on, or says off and was last checked
///    [`OFF_RECHECK_SECS`] ago or never: ask the store for its digests, read the six tables under
///    *its* fields and marketplace, and send each one whose digest differs and that this device
///    can read whole. `Stale` is fine; other settings update the cache and end this half; no
///    store says off. The panel's cache is written either way: on or off, the settings, the send
///    stamp on any table stored, and the failure.
///
/// `db` is the lane.
pub async fn round(db: &impl Store) -> Report {
    let mut report = Report::default();
    let Ok((entitled, cards, current)) = db.reading(|conn| {
        Ok((
            store::entitled(conn),
            crate::sync::has_cards(conn),
            readable::corpus_current(conn),
        ))
    }) else {
        // A look that could not be taken is a round owed, not one run: the request it may be
        // answering stays for the next poll.
        report.deferred = true;
        return report;
    };
    if !entitled {
        return report;
    }
    if !cards {
        report.deferred = true;
        return report;
    }
    report.ran = true;
    match crate::share::publish::refresh_live(db, current).await {
        Ok(rows) => report.shares = rows.into_iter().map(|row| row.id).collect(),
        Err(e) => report.shares_error = Some(e),
    }
    project(db, current, &mut report).await;
    report
}

/// Whether the projection half asks the store at all — local and free.
fn worth_asking(conn: &rusqlite::Connection) -> Result<bool, String> {
    if store::endpoint(conn).is_err() {
        return Ok(false);
    }
    let cache = settings::read_cache(conn);
    let now = settings::now(conn)?;
    Ok(cache.enabled
        || cache
            .checked_at
            .is_none_or(|at| now - at >= OFF_RECHECK_SECS))
}

/// The projection half — see [`round`]. `corpus_current` is `readable::corpus_current`'s answer.
async fn project(db: &impl Store, corpus_current: bool, report: &mut Report) {
    if db.reading(worth_asking) != Ok(true) {
        return;
    }
    let door = match store::door(db, "integrations_publish").await {
        Ok(door) => door,
        // A membership that ended between the round's look and the token: nothing to do, and
        // nothing that went wrong.
        Err(e) if e == store::NOT_CONNECTED || e == store::NOT_DEPLOYED => return,
        Err(e) => return failed(db, report, e),
    };
    let digests = match store::digests(db, &door).await {
        Ok(Some(digests)) => digests,
        Ok(None) => {
            report.store = Some(false);
            let _ = db.with(|conn| {
                let now = settings::now(conn)?;
                let mut cache = settings::read_cache(conn);
                cache.heard_off(now);
                settings::write_cache(conn, &cache)
            });
            return;
        }
        Err(e) => return failed(db, report, e),
    };
    report.store = Some(true);

    // **The read connection**, where the host has one: the six documents and the watermark they
    // go up under, **in one read transaction**, so the tables agree with each other and with the
    // watermark whatever a reader writes meanwhile. One stretch, and no turn for the host inside
    // it — a turn there would be a transaction held across a wait, which on a host with one
    // connection is a reader's write landing inside it.
    let held_settings = digests.settings.clone();
    let read = db.reading(|conn| {
        // A store that names no marketplace is TCGplayer on every device — never each device's
        // own, which would be the flip the store's marketplace exists to stop.
        let market = held_settings
            .marketplace
            .as_deref()
            .map_or(Marketplace::Tcgplayer, Marketplace::from_id);
        let snapshot = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let docs = projection::project_all(conn, held_settings.fields, market)?;
        let watermark = store::watermark(conn)?;
        let prices_readable = readable::feed_current(conn, market);
        // A read: nothing to commit.
        snapshot.rollback().map_err(|e| e.to_string())?;
        Ok((docs, watermark, prices_readable))
    });
    let (docs, watermark, prices_readable) = match read {
        Ok(read) => read,
        Err(e) => {
            let _ = db.with(|conn| {
                errors::record(
                    conn,
                    Source::Database,
                    "integrations_publish",
                    Kind::Io,
                    &e,
                    None,
                );
                Ok(())
            });
            return failed(db, report, e);
        }
    };

    let mut heard = digests.settings.clone();
    let mut on = true;
    let mut sent_any = false;
    let mut error: Option<String> = None;
    for doc in &docs {
        // A turn for the host between two tables: a digest and a gzip each are a large table's
        // serialisation, and a host with one thread answers its page between them.
        timer::yield_to_host().await;
        let digest = match projection::digest(doc) {
            Ok(digest) => digest,
            Err(e) => {
                let _ = db.with(|conn| {
                    errors::record(
                        conn,
                        Source::Database,
                        "integrations_publish",
                        Kind::Io,
                        &e,
                        None,
                    );
                    Ok(())
                });
                error.get_or_insert(e);
                break;
            }
        };
        if digests
            .tables
            .get(doc.table)
            .is_some_and(|held| held.digest == digest)
        {
            continue;
        }
        // Readable whole here, or left for a device that can read it so: no card newer than this
        // device's card data, a gone one only from a current corpus, and its prices — if it reads
        // any — from a current feed ([`super::readable`]).
        if !doc.rows.unknown().publishable(corpus_current) || (doc.priced() && !prices_readable) {
            report.held.push(doc.table);
            continue;
        }
        match store::put_table(db, &door, doc, &digest, watermark).await {
            Ok(Put::Stored) => {
                sent_any = true;
                report.sent.push(doc.table);
            }
            Ok(Put::Stale) => report.stale.push(doc.table),
            Ok(Put::SettingsMismatch(theirs)) => {
                heard = theirs;
                break;
            }
            Ok(Put::NoStore) => {
                on = false;
                report.store = Some(false);
                break;
            }
            // Refused for this table — too large, or not a document the Worker takes: the next
            // table may still go.
            Ok(Put::Refused(e)) => {
                error.get_or_insert(e);
            }
            // A request that did not come back: the next would very likely not either, and the
            // lane is held until this round ends.
            Err(e) => {
                error.get_or_insert(e);
                break;
            }
        }
    }
    report.error.clone_from(&error);
    let _ = db.with(|conn| {
        let now = settings::now(conn)?;
        let mut cache = settings::read_cache(conn);
        if on {
            cache.heard_on(&heard, now);
            if sent_any {
                cache.published_at = Some(now);
            }
            cache.error = error.as_ref().map(|_| ROUND_FAILED.to_owned());
        } else {
            cache.heard_off(now);
        }
        settings::write_cache(conn, &cache)
    });
}

/// The projection half failed before it sent anything — already a row: the panel is told, and
/// the cache otherwise stays as it was heard.
fn failed(db: &impl Store, report: &mut Report, error: String) {
    report.error = Some(error);
    let _ = db.with(|conn| {
        let mut cache = settings::read_cache(conn);
        cache.error = Some(ROUND_FAILED.to_owned());
        settings::write_cache(conn, &cache)
    });
}

// ---------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------

/// What one poll of the loop did — [`step`]'s answer, for a test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stepped {
    /// Nothing was due — or this device has no card data yet, and nothing is acted on or cleared
    /// until it has.
    Idle,
    /// A round ran: for a trip (`by_trip`, which marks the trip acted on), or only because a
    /// publish was asked for (which marks no trip — see [`step`]).
    Round { by_trip: bool, report: Report },
}

/// One poll: read the trip stamp, the publish request and whether there is card data ([`look`]);
/// feed [`Seen`]; and when a trip is [`due`] or a publish is asked for, run [`round`] **on a worker
/// and under the lane, waited for** — a trip or a press in flight is one the round queues behind.
///
/// **The request is cleared under the same lane, after the round** — unless the round waited for
/// card data, when it is still owed — so a press that asks again during the round waits for the
/// lane and writes its request after this clears the old one.
///
/// **Only a round a trip made due marks that trip acted on.** `last_sync_at` is whole seconds, so a
/// trip that ends in the second a requested round started reads as the stamp that round saw:
/// marked acted on, it would never be published. Left unmarked, it costs at worst one more round.
///
/// **No card data, no round, and nothing marked or cleared**: the device that has not finished
/// its first download, or whose download a metered link holds, publishes the moment it has one.
///
/// `now` is the loop's monotonic clock, in milliseconds.
pub async fn step(state: &Arc<State>, seen: &mut Seen, now: u64) -> Stepped {
    let looked = look(state).await;
    seen.saw(looked.stamp, now);
    if !looked.cards {
        return Stepped::Idle;
    }
    let by_trip = due(seen, false, now);
    if !by_trip && !looked.requested {
        return Stepped::Idle;
    }
    let acting_on = seen.latest.map(|(stamp, _)| stamp);
    let owned = Arc::clone(state);
    let report = spawn::on_a_worker(move || async move {
        let lane = owned.lane().await;
        let report = round(&lane).await;
        if !report.deferred {
            let _ = lane.with(settings::clear_publish_request);
        }
        report
    })
    .await
    .unwrap_or_default();
    if by_trip {
        seen.acted_on(acting_on);
    }
    Stepped::Round { by_trip, report }
}

/// The publisher: runs for the life of the process, and is the host's to spawn — beside
/// `sync_engine::live::run`, after its launch has settled, as a detached task. It never ends:
/// one [`step`] every [`POLL`].
///
/// **On a device with nothing to publish it costs one local read a poll.** A round on a device
/// that is not entitled asks nobody, so a request written there is cleared at no cost.
pub async fn run(state: Arc<State>) {
    let mut seen = Seen::default();
    loop {
        let _ = step(&state, &mut seen, now_ms()).await;
        timer::sleep(POLL).await;
    }
}

/// **The fence, and it is the compiler's** — `live.rs`'s for the same reason: the desktop and the
/// Android host spawn [`run`] on a runtime that moves a task between threads, so on a native build
/// the loop may hold nothing across an `.await` that cannot go with it. In a browser the question
/// is not asked ([`crate::platform::Sendable`]). Never called.
#[allow(dead_code)]
fn the_loop_can_be_handed_to_a_hosts_runtime(state: Arc<State>) {
    fn sendable<T: crate::platform::Sendable>(_: T) {}
    sendable(run(state));
}

/// What one poll reads.
struct Look {
    /// `last_sync_at`, the last successful trip's stamp.
    stamp: Option<i64>,
    /// Whether a publish is asked for.
    requested: bool,
    /// Whether this device has any card data at all (`sync::has_cards`).
    cards: bool,
}

/// The trip stamp, the publish request and whether there is card data — **the read connection**,
/// on the blocking pool, `live.rs`'s `in_a_group`'s idiom: a poll answers from the last committed
/// snapshot without queueing behind an ingest. Nothing seen, asked or held when the read fails.
async fn look(state: &Arc<State>) -> Look {
    let owned = Arc::clone(state);
    spawn::blocking(move || {
        let conn = owned.lock_db_read();
        Look {
            stamp: client::get_state(&conn, client::LAST_SYNC_AT).and_then(|v| v.parse().ok()),
            requested: settings::publish_requested(&conn),
            cards: crate::sync::has_cards(&conn),
        }
    })
    .await
    .unwrap_or(Look {
        stamp: None,
        requested: false,
        cards: false,
    })
}

/// Now, in milliseconds on a **monotonic** clock — what every [`due`] call is a pure function of.
/// A wall clock set back an hour would otherwise hold a round back an hour.
fn now_ms() -> u64 {
    clock::monotonic_ms() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integration::projection::{IntegrationFields, TABLES};
    use crate::share::publish::SHARE_URL;
    use crate::sync_engine::entitlement;
    use rusqlite::Connection;
    use std::io::Read as _;

    // -----------------------------------------------------------------------------------
    // When — explicit clocks for every branch
    // -----------------------------------------------------------------------------------

    const T0: u64 = 1_790_000_000_000;

    #[test]
    fn nothing_seen_is_never_due_and_a_request_always_is() {
        let seen = Seen::default();
        assert!(!due(&seen, false, T0));
        assert!(!due(&seen, false, T0 + LONGEST_MS * 10));
        assert!(due(&seen, true, T0), "a switch turned on publishes at once");
    }

    /// **The first trip after a launch is acted on** — whatever stamp the loop first reads, even
    /// one a previous run already published, once it has been quiet for [`QUIET_MS`].
    #[test]
    fn the_first_trip_after_a_launch_is_acted_on_once_it_is_quiet() {
        let mut seen = Seen::default();
        seen.saw(Some(100), T0);
        assert!(!due(&seen, false, T0 + QUIET_MS - 1));
        assert!(due(&seen, false, T0 + QUIET_MS));
    }

    /// A newer trip inside the quiet window starts it again — a burst is one round at its end.
    #[test]
    fn a_newer_trip_restarts_the_quiet_window() {
        let mut seen = Seen::default();
        seen.saw(Some(100), T0);
        seen.saw(Some(110), T0 + 10_000);
        assert!(
            !due(&seen, false, T0 + QUIET_MS),
            "only ten seconds since the newest"
        );
        assert!(due(&seen, false, T0 + 10_000 + QUIET_MS));
        // The same stamp read again is not a new trip.
        seen.saw(Some(110), T0 + 25_000);
        assert_eq!(seen.latest, Some((110, T0 + 10_000)));
    }

    /// **Trips that keep landing publish every five minutes** rather than never: the first
    /// unacted one sets the clock, and newer ones do not move it.
    #[test]
    fn trips_that_keep_landing_are_published_after_the_longest_wait() {
        let mut seen = Seen::default();
        let mut at = T0;
        let mut stamp = 100;
        while at < T0 + LONGEST_MS {
            seen.saw(Some(stamp), at);
            assert!(
                !due(&seen, false, at),
                "never quiet, and not yet five minutes"
            );
            at += 10_000;
            stamp += 10;
        }
        seen.saw(Some(stamp), at);
        assert!(due(&seen, false, at));
        assert_eq!(seen.waiting_since, Some(T0));
    }

    /// A trip acted on is not due again; the next one waits from when it was seen.
    #[test]
    fn a_trip_acted_on_is_done_and_the_next_waits_from_its_own_sighting() {
        let mut seen = Seen::default();
        seen.saw(Some(100), T0);
        seen.acted_on(Some(100));
        assert!(!due(&seen, false, T0 + LONGEST_MS * 2));
        assert_eq!(seen.waiting_since, None);

        seen.saw(Some(200), T0 + 60_000);
        assert_eq!(seen.waiting_since, Some(T0 + 60_000));
        assert!(!due(&seen, false, T0 + 60_000 + QUIET_MS - 1));
        assert!(due(&seen, false, T0 + 60_000 + QUIET_MS));
    }

    /// **A trip that lands during the round is still owed one** — the round acted on the stamp it
    /// started from, and the newer one waits from when it was seen.
    #[test]
    fn a_trip_that_landed_during_the_round_is_still_owed_one() {
        let mut seen = Seen::default();
        seen.saw(Some(100), T0);
        let acting_on = seen.latest.map(|(s, _)| s);
        seen.saw(Some(105), T0 + 5_000);
        seen.acted_on(acting_on);
        assert_eq!(seen.acted, Some(100));
        assert_eq!(seen.waiting_since, Some(T0 + 5_000));
        assert!(due(&seen, false, T0 + 5_000 + QUIET_MS));
    }

    /// A requested round with nothing seen acts on nothing, and leaves the stamp unacted for its
    /// own turn.
    #[test]
    fn a_requested_round_before_any_trip_leaves_the_next_trip_owed() {
        let mut seen = Seen::default();
        seen.acted_on(None);
        seen.saw(Some(100), T0);
        assert!(due(&seen, false, T0 + QUIET_MS));
    }

    /// A device that has never synced has no stamp, and a stamp that goes away is not a trip.
    #[test]
    fn no_stamp_is_nothing_seen() {
        let mut seen = Seen::default();
        seen.saw(None, T0);
        assert_eq!(seen, Seen::default());
        seen.saw(Some(100), T0);
        seen.acted_on(Some(100));
        seen.saw(None, T0 + 1);
        assert!(!due(&seen, false, T0 + LONGEST_MS));
    }

    // -----------------------------------------------------------------------------------
    // What — a round against a mock store
    // -----------------------------------------------------------------------------------

    fn open_db() -> Connection {
        crate::schema::memory_pair()
    }

    /// A device in group `g1`, covered by a membership, with a token fresh enough that nothing
    /// asks the relay — whose share Worker and store are both `base`, and whose card data holds one
    /// card and was downloaded just now.
    fn entitled(conn: &Connection, base: &str) {
        crate::schema::fixtures::seed_card(conn, "c-seed", "lea", "1");
        bulk_file_aged(conn, 0);
        client::set_state(conn, store::INTEGRATIONS_URL, base).unwrap();
        client::set_state(conn, SHARE_URL, base).unwrap();
        client::set_state(conn, entitlement::ACCESS_TOKEN, "bearer").unwrap();
        client::set_state(conn, entitlement::ACCESS_EXPIRES, &i64::MAX.to_string()).unwrap();
        client::set_state(conn, entitlement::SUPPORTER_STATUS, "active").unwrap();
        conn.execute(
            "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g1', 0, zeroblob(32), 0)",
            [],
        )
        .unwrap();
        conn.execute("UPDATE sync_clock SET ms = 1234, ctr = 5 WHERE id = 1", [])
            .unwrap();
    }

    /// This device's bulk file, as downloaded `hours` ago — the date Scryfall wrote on it.
    fn bulk_file_aged(conn: &Connection, hours: i64) {
        conn.execute(
            "INSERT OR REPLACE INTO sync_meta (key, value)
             VALUES (?1, strftime('%Y-%m-%dT%H:%M:%S.000+00:00', 'now', ?2))",
            rusqlite::params![crate::sync::K_BULK_UPDATED_AT, format!("-{hours} hours")],
        )
        .unwrap();
    }

    fn folder(conn: &Connection, name: &str) {
        conn.execute(
            "INSERT INTO collection_folders
               (parent_id, name, kind, sort_order, created_at, updated_at, sync_uid, locked)
             VALUES (NULL, ?1, 'user', 0, 0, 0, ?2, 0)",
            rusqlite::params![name, format!("uid-{name}")],
        )
        .unwrap();
    }

    fn rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM error_log", [], |r| r.get(0))
            .unwrap()
    }

    const SOME: IntegrationFields = IntegrationFields {
        condition: true,
        lang: false,
        value: false,
        tags: false,
        notes: true,
    };

    /// The six documents as this device reads them now, by table, with their digests.
    fn projected(
        conn: &Connection,
        fields: IntegrationFields,
    ) -> Vec<(projection::TableDoc, String)> {
        let marketplace = Marketplace::from_id(&crate::marketplace::stored(conn));
        projection::project_all(conn, fields, marketplace)
            .unwrap()
            .into_iter()
            .map(|doc| {
                let digest = projection::digest(&doc).unwrap();
                (doc, digest)
            })
            .collect()
    }

    /// A digests answer holding `tables` at the digests given, under `fields` and TCGplayer.
    fn digests_body(fields: IntegrationFields, tables: &[(&str, &str)]) -> String {
        digests_at(fields, "tcgplayer", tables)
    }

    /// [`digests_body`] at the marketplace given.
    fn digests_at(fields: IntegrationFields, marketplace: &str, tables: &[(&str, &str)]) -> String {
        let tables: serde_json::Map<String, serde_json::Value> = tables
            .iter()
            .map(|(table, digest)| {
                (
                    (*table).to_owned(),
                    serde_json::json!({
                        "digest": digest, "hlcMs": 1, "hlcCtr": 0, "rows": 0,
                        "publishedAt": 1_790_000_000_000_i64,
                    }),
                )
            })
            .collect();
        serde_json::json!({ "fields": fields, "marketplace": marketplace, "tables": tables })
            .to_string()
    }

    async fn no_shares(server: &httpmock::MockServer) {
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/g/g1/shares");
                then.status(200).body(r#"{"shares":[]}"#);
            })
            .await;
    }

    async fn store_holds(server: &httpmock::MockServer, body: String) -> httpmock::Mock<'_> {
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET)
                    .path("/g/g1/projection/digests")
                    .header("authorization", "Bearer bearer");
                then.status(200).body(body);
            })
            .await
    }

    /// Every projection `PUT`, of any table, answered `status` with `body`.
    async fn any_put<'a>(
        server: &'a httpmock::MockServer,
        status: u16,
        body: &str,
    ) -> httpmock::Mock<'a> {
        let body = body.to_owned();
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT)
                    .path_prefix("/g/g1/projection/");
                then.status(status).body(body);
            })
            .await
    }

    /// A body as the JSON its gzip holds, or `None` for one that is not — never a panic, which
    /// would be inside the mock server's matcher.
    fn gunzip(bytes: &[u8]) -> Option<serde_json::Value> {
        let mut json = String::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_string(&mut json)
            .ok()?;
        serde_json::from_str(&json).ok()
    }

    /// **Skipped silently**: a device that is not entitled asks nobody — its store and share
    /// Worker are an address nothing answers, so a request would be a row — and writes nothing.
    #[tokio::test]
    async fn a_round_on_a_device_that_is_not_entitled_asks_nobody() {
        let conn = open_db();
        client::set_state(&conn, store::INTEGRATIONS_URL, "http://127.0.0.1:1").unwrap();
        client::set_state(&conn, SHARE_URL, "http://127.0.0.1:1").unwrap();
        let report = round(&conn).await;
        assert_eq!(report, Report::default());
        assert_eq!(rows(&conn), 0);
        assert_eq!(settings::read_cache(&conn).checked_at, None);
    }

    /// **Every build until the deploy**: the share half runs, and the projection half asks no
    /// store — no request, no row, nothing for the panel.
    #[tokio::test]
    async fn a_build_with_no_store_address_runs_the_share_half_alone() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        client::set_state(&conn, store::INTEGRATIONS_URL, "").unwrap();
        no_shares(&server).await;
        let digests = store_holds(&server, digests_body(SOME, &[])).await;

        let report = round(&conn).await;
        assert!(report.ran);
        assert_eq!(report.store, None);
        assert_eq!(digests.calls_async().await, 0);
        assert_eq!(rows(&conn), 0);
    }

    /// A group with no store is off: the cache hears it, and nothing is sent.
    #[tokio::test]
    async fn a_store_that_is_not_there_is_off_and_nothing_is_sent() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        no_shares(&server).await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET)
                    .path("/g/g1/projection/digests");
                then.status(404)
                    .body(r#"{"error":"integrations are off for this group","code":"no_store"}"#);
            })
            .await;
        let put = any_put(&server, 200, "{}").await;

        let report = round(&conn).await;
        assert_eq!(report.store, Some(false));
        assert_eq!(put.calls_async().await, 0);
        let cache = settings::read_cache(&conn);
        assert!(!cache.enabled);
        assert!(cache.checked_at.is_some());
        assert_eq!(rows(&conn), 0, "off is a state, not a failure");
    }

    /// **Exactly the tables whose digest differs go up** — one the store holds at another digest,
    /// one it has never been sent — each with the watermark, its digest and a gzip whose JSON is
    /// the document this device projects. The other four are where the store has them.
    #[tokio::test]
    async fn the_tables_whose_digest_differs_go_up_and_no_others() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        folder(&conn, "Binder");
        no_shares(&server).await;

        let docs = projected(&conn, SOME);
        let digest_of = |table: &str| {
            docs.iter()
                .find(|(d, _)| d.table == table)
                .unwrap()
                .1
                .clone()
        };
        let held: Vec<(&str, String)> = TABLES
            .iter()
            .filter(|t| !matches!(**t, "collection_folders" | "decks"))
            .map(|t| (*t, digest_of(t)))
            .chain([("collection_folders", "0".repeat(64))])
            .collect();
        let held: Vec<(&str, &str)> = held.iter().map(|(t, d)| (*t, d.as_str())).collect();
        store_holds(&server, digests_body(SOME, &held)).await;

        let mut mocks = Vec::new();
        for table in ["collection_folders", "decks"] {
            let (doc, digest) = docs.iter().find(|(d, _)| d.table == table).unwrap();
            let want = serde_json::to_value(doc).unwrap();
            mocks.push(
                server
                    .mock_async(|when, then| {
                        when.method(httpmock::Method::PUT)
                            .path(format!("/g/g1/projection/{table}"))
                            .header("authorization", "Bearer bearer")
                            .header("content-type", "application/gzip")
                            .header(store::HLC_MS_HEADER, "1234")
                            .header(store::HLC_CTR_HEADER, "5")
                            .header(store::DIGEST_HEADER, digest.as_str())
                            .is_true(move |req| gunzip(req.body_ref()).as_ref() == Some(&want));
                        then.status(200).body("{}");
                    })
                    .await,
            );
        }
        let stray = any_put(&server, 500, "{}").await;

        let report = round(&conn).await;
        assert_eq!(report.error, None);
        assert_eq!(report.sent, ["collection_folders", "decks"]);
        for mock in &mocks {
            assert_eq!(mock.calls_async().await, 1);
        }
        assert_eq!(
            stray.calls_async().await,
            0,
            "no other table, and none malformed"
        );
        let cache = settings::read_cache(&conn);
        assert!(cache.enabled);
        assert_eq!(cache.fields, SOME);
        assert!(cache.published_at.is_some());
        assert_eq!(cache.error, None);
        // The Binder is in the document that went up.
        let folders = &docs
            .iter()
            .find(|(d, _)| d.table == "collection_folders")
            .unwrap()
            .0;
        assert!(serde_json::to_string(folders)
            .unwrap()
            .contains("uid-Binder"));
    }

    /// Nothing moved, nothing is sent — and the send stamp stays where it was.
    #[tokio::test]
    async fn equal_digests_send_nothing() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        folder(&conn, "Binder");
        no_shares(&server).await;
        let docs = projected(&conn, SOME);
        let held: Vec<(&str, &str)> = docs.iter().map(|(d, g)| (d.table, g.as_str())).collect();
        store_holds(&server, digests_body(SOME, &held)).await;
        let put = any_put(&server, 200, "{}").await;

        let report = round(&conn).await;
        assert!(report.sent.is_empty());
        assert_eq!(put.calls_async().await, 0);
        assert_eq!(settings::read_cache(&conn).published_at, None);
    }

    /// **A newer device's table is not a failure**: nothing for the panel, nothing in the log.
    #[tokio::test]
    async fn a_stale_watermark_is_no_error() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        no_shares(&server).await;
        store_holds(&server, digests_body(SOME, &[])).await;
        any_put(
            &server,
            409,
            r#"{"error":"a newer projection of that table is already stored","code":"stale_projection","hlcMs":9999,"hlcCtr":0}"#,
        )
        .await;

        let report = round(&conn).await;
        assert_eq!(report.stale.len(), TABLES.len());
        assert_eq!(report.error, None);
        assert_eq!(settings::read_cache(&conn).error, None);
        assert_eq!(rows(&conn), 0);
    }

    /// **Another device changed the settings** between the ask and the send: the cache takes the
    /// store's fields and marketplace, and this half ends — the next round sends under them.
    #[tokio::test]
    async fn other_settings_update_the_cache_and_end_the_half() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        no_shares(&server).await;
        store_holds(&server, digests_body(SOME, &[])).await;
        let theirs = IntegrationFields {
            lang: true,
            ..IntegrationFields::default()
        };
        let put = any_put(
            &server,
            409,
            &serde_json::json!({
                "error": "that projection was made under other settings than the store's",
                "code": "settings_mismatch",
                "fields": theirs,
                "marketplace": "cardkingdom",
            })
            .to_string(),
        )
        .await;

        let report = round(&conn).await;
        assert_eq!(
            put.calls_async().await,
            1,
            "the half ended at the first refusal"
        );
        assert_eq!(report.error, None);
        let cache = settings::read_cache(&conn);
        assert_eq!(cache.fields, theirs);
        assert_eq!(cache.marketplace.as_deref(), Some("cardkingdom"));
        assert_eq!(rows(&conn), 0);
    }

    /// **One half failing does not stop the other**: the share Worker falls over, and the
    /// projection still goes up.
    #[tokio::test]
    async fn a_failing_share_half_does_not_stop_the_projection() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/g/g1/shares");
                then.status(500)
                    .body(r#"{"error":"the share service fell over"}"#);
            })
            .await;
        store_holds(&server, digests_body(SOME, &[])).await;
        let put = any_put(&server, 200, "{}").await;

        let report = round(&conn).await;
        assert_eq!(
            report.shares_error.as_deref(),
            Some("the share service fell over")
        );
        assert_eq!(report.sent.len(), TABLES.len());
        assert_eq!(put.calls_async().await, TABLES.len());
    }

    /// A store that refuses one table still takes the next, and the panel is told the round
    /// failed — once, in the panel's words, with the Worker's in the log.
    #[tokio::test]
    async fn a_refused_table_is_the_panels_failure_and_the_rest_still_go() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        no_shares(&server).await;
        store_holds(&server, digests_body(SOME, &[])).await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT)
                    .path("/g/g1/projection/collection_folders");
                then.status(413).body(
                    r#"{"error":"that projection is 9 bytes gzipped and a table may be at most 8","code":"projection_limit"}"#,
                );
            })
            .await;
        let rest = any_put(&server, 200, "{}").await;

        let report = round(&conn).await;
        assert_eq!(report.sent.len(), TABLES.len() - 1);
        assert_eq!(rest.calls_async().await, TABLES.len() - 1);
        assert!(report.error.as_deref().unwrap().contains("9 bytes"));
        assert_eq!(
            settings::read_cache(&conn).error.as_deref(),
            Some(ROUND_FAILED)
        );
        assert_eq!(rows(&conn), 1);
    }

    /// **A device that heard "off" lately asks nobody** — and asks again once six hours have
    /// passed.
    #[tokio::test]
    async fn off_is_asked_again_only_after_six_hours() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        no_shares(&server).await;
        let asked = store_holds(&server, digests_body(SOME, &[])).await;
        any_put(&server, 200, "{}").await;

        let now = settings::now(&conn).unwrap();
        let mut cache = settings::read_cache(&conn);
        cache.heard_off(now - 60);
        settings::write_cache(&conn, &cache).unwrap();
        assert_eq!(round(&conn).await.store, None);
        assert_eq!(asked.calls_async().await, 0);

        cache.heard_off(now - OFF_RECHECK_SECS);
        settings::write_cache(&conn, &cache).unwrap();
        assert_eq!(round(&conn).await.store, Some(true));
        assert_eq!(asked.calls_async().await, 1);
    }

    /// A store switched off on another device mid-round is heard as off.
    #[tokio::test]
    async fn a_store_gone_mid_round_is_off() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        no_shares(&server).await;
        store_holds(&server, digests_body(SOME, &[])).await;
        let put = any_put(
            &server,
            404,
            r#"{"error":"integrations are off for this group","code":"no_store"}"#,
        )
        .await;

        let report = round(&conn).await;
        assert_eq!(put.calls_async().await, 1);
        assert_eq!(report.store, Some(false));
        assert!(!settings::read_cache(&conn).enabled);
        assert_eq!(rows(&conn), 0);
    }

    // -----------------------------------------------------------------------------------
    // The loop, on a host's state
    // -----------------------------------------------------------------------------------

    /// **A request is answered and cleared by the loop**, on a device that can ask nobody — so the
    /// round is the silent skip, and what is left to see is the request gone.
    #[tokio::test]
    async fn the_loop_answers_a_request_and_clears_it() {
        let (state, _dir) =
            crate::state::fixtures::on_files("publish-loop-request", "http://127.0.0.1:1");
        crate::schema::fixtures::seed_card(&state.lock_db(), "c-seed", "lea", "1");
        settings::request_publish(&state.lock_db()).unwrap();
        let running = tokio::spawn(run(Arc::clone(&state)));
        let mut cleared = false;
        for _ in 0..500 {
            if !settings::publish_requested(&state.lock_db_read()) {
                cleared = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!running.is_finished(), "the loop never ends");
        running.abort();
        assert!(cleared, "the request was not answered");
        assert!(
            !settings::answer(&state.lock_db_read()).pending,
            "the panel stops polling once the round has run"
        );
        assert_eq!(rows(&state.lock_db_read()), 0);
    }

    // -----------------------------------------------------------------------------------
    // Only what this device can read whole, in the group's marketplace
    // -----------------------------------------------------------------------------------

    /// One copy of a printing this device's `cards` does not hold — the reader's fallback row.
    fn file_unknown(conn: &Connection, card: &str) {
        conn.execute(
            "INSERT INTO collection_entries
               (card_id, set_code, collector_number, lang, finish, condition, quantity,
                folder_id, created_at, updated_at, sync_uid)
             VALUES (?1, 'new', '1', 'en', 'nonfoil', 'NM', 1, NULL, 0, 0, 'uid-' || ?1)",
            rusqlite::params![card],
        )
        .unwrap();
    }

    /// **A device with no card data yet publishes nothing** — not its shares, not a table — and
    /// asks nobody: a web or Android install that paired before its card download finished
    /// would publish ids for names, no pictures and no prices over the group's good documents.
    #[tokio::test]
    async fn a_device_with_no_card_data_publishes_nothing() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        conn.execute("DELETE FROM cards", []).unwrap();
        let shares = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/g/g1/shares");
                then.status(200).body(r#"{"shares":[]}"#);
            })
            .await;
        let digests = store_holds(&server, digests_body(SOME, &[])).await;

        let report = round(&conn).await;
        assert!(report.deferred && !report.ran, "{report:?}");
        assert_eq!(shares.calls_async().await, 0);
        assert_eq!(digests.calls_async().await, 0);
        assert_eq!(rows(&conn), 0);
    }

    /// **A table holding a row this device cannot name waits for a current corpus**: from a device
    /// whose bulk file is days old, `collection_entries` is held and the other five go up; from one
    /// whose file is fresh, the same row is a printing that left Scryfall and goes up too.
    #[tokio::test]
    async fn a_table_this_device_cannot_read_whole_waits_for_a_current_corpus() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        file_unknown(&conn, "c-from-a-newer-set");
        no_shares(&server).await;
        store_holds(&server, digests_body(SOME, &[])).await;
        let entries = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT)
                    .path("/g/g1/projection/collection_entries");
                then.status(200).body("{}");
            })
            .await;
        let rest = any_put(&server, 200, "{}").await;

        bulk_file_aged(&conn, readable::CORPUS_CURRENT_SECS / 3600 + 1);
        assert!(!readable::corpus_current(&conn));
        let report = round(&conn).await;
        assert_eq!(report.held, ["collection_entries"]);
        assert_eq!(report.sent.len(), TABLES.len() - 1);
        assert_eq!(
            entries.calls_async().await,
            0,
            "nothing an old corpus cannot name"
        );
        assert_eq!(rest.calls_async().await, TABLES.len() - 1);
        assert_eq!(report.error, None, "held is not a failure");

        bulk_file_aged(&conn, 1);
        assert!(readable::corpus_current(&conn));
        let report = round(&conn).await;
        assert!(report.held.is_empty());
        assert_eq!(
            entries.calls_async().await,
            1,
            "an orphan, from a current corpus"
        );
    }

    /// **The projection is read at the store's marketplace, never this device's**: the group's
    /// store holds Cardmarket, this device is set to TCGplayer, and every document goes up in
    /// euros — or two devices set to two marketplaces would flip every table on every round.
    #[tokio::test]
    async fn the_projection_is_read_at_the_stores_marketplace() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        no_shares(&server).await;
        let priced = IntegrationFields {
            value: true,
            ..IntegrationFields::default()
        };
        store_holds(&server, digests_at(priced, "cardmarket", &[])).await;
        let euros = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT)
                    .path_prefix("/g/g1/projection/")
                    .is_true(|req| {
                        gunzip(req.body_ref()).is_some_and(|doc| {
                            doc["marketplace"] == "cardmarket" && doc["currency"] == "EUR"
                        })
                    });
                then.status(200).body("{}");
            })
            .await;
        let stray = any_put(&server, 500, "{}").await;

        let report = round(&conn).await;
        assert_eq!(report.error, None);
        assert_eq!(euros.calls_async().await, TABLES.len());
        assert_eq!(stray.calls_async().await, 0);
        assert_eq!(
            settings::read_cache(&conn).marketplace.as_deref(),
            Some("cardmarket")
        );
    }

    // -----------------------------------------------------------------------------------
    // One poll — `step`, on a host's state
    // -----------------------------------------------------------------------------------

    /// A host's state holding one card, whose last trip ended at `stamp`.
    fn tripped(name: &str, stamp: &str) -> Arc<State> {
        let (state, _dir) = crate::state::fixtures::on_files(name, "http://127.0.0.1:1");
        let conn = state.lock_db();
        crate::schema::fixtures::seed_card(&conn, "c-seed", "lea", "1");
        client::set_state(&conn, client::LAST_SYNC_AT, stamp).unwrap();
        drop(conn);
        state
    }

    fn by_trip(stepped: &Stepped) -> Option<bool> {
        match stepped {
            Stepped::Idle => None,
            Stepped::Round { by_trip, .. } => Some(*by_trip),
        }
    }

    /// **A trip makes one round, and the round marks it acted on**: once quiet it runs, and the
    /// polls after it are idle until a newer trip — the loop does not run a round every poll.
    #[tokio::test]
    async fn a_trip_makes_one_round_and_it_is_not_repeated() {
        let state = tripped("publish-step-trip", "100");
        let mut seen = Seen::default();
        assert_eq!(step(&state, &mut seen, T0).await, Stepped::Idle);
        assert_eq!(
            by_trip(&step(&state, &mut seen, T0 + QUIET_MS).await),
            Some(true)
        );
        for poll in 1..=4u64 {
            let at = T0 + QUIET_MS + poll * POLL.as_millis() as u64;
            assert_eq!(
                step(&state, &mut seen, at).await,
                Stepped::Idle,
                "poll {poll}"
            );
        }
        client::set_state(&state.lock_db(), client::LAST_SYNC_AT, "200").unwrap();
        let later = T0 + 10 * QUIET_MS;
        assert_eq!(step(&state, &mut seen, later).await, Stepped::Idle);
        assert_eq!(
            by_trip(&step(&state, &mut seen, later + QUIET_MS).await),
            Some(true)
        );
    }

    /// **A requested round marks no trip**: `last_sync_at` is whole seconds, so the trip that
    /// stamp names may have ended after the round began — it gets a round of its own.
    #[tokio::test]
    async fn a_requested_round_leaves_the_trip_it_saw_owed() {
        let state = tripped("publish-step-request", "100");
        settings::request_publish(&state.lock_db()).unwrap();
        let mut seen = Seen::default();
        assert_eq!(by_trip(&step(&state, &mut seen, T0).await), Some(false));
        assert!(
            !settings::publish_requested(&state.lock_db_read()),
            "answered"
        );
        assert_eq!(
            by_trip(&step(&state, &mut seen, T0 + QUIET_MS).await),
            Some(true)
        );
        assert_eq!(
            step(&state, &mut seen, T0 + 2 * QUIET_MS).await,
            Stepped::Idle
        );
    }

    /// **No card data, no round**: a trip and a request both wait, and the request is still owed
    /// when the corpus lands.
    #[tokio::test]
    async fn no_card_data_is_idle_and_keeps_the_request() {
        let state = tripped("publish-step-no-cards", "100");
        state.lock_db().execute("DELETE FROM cards", []).unwrap();
        settings::request_publish(&state.lock_db()).unwrap();
        let mut seen = Seen::default();
        assert_eq!(step(&state, &mut seen, T0).await, Stepped::Idle);
        assert_eq!(
            step(&state, &mut seen, T0 + LONGEST_MS).await,
            Stepped::Idle
        );
        assert!(settings::publish_requested(&state.lock_db_read()));

        crate::schema::fixtures::seed_card(&state.lock_db(), "c-seed", "lea", "1");
        let stepped = step(&state, &mut seen, T0 + LONGEST_MS + 1).await;
        assert_eq!(
            by_trip(&stepped),
            Some(true),
            "the trip, and the request with it"
        );
        assert!(!settings::publish_requested(&state.lock_db_read()));
    }

    /// **A card newer than this device's card data is held however current that data is**: the
    /// collection's row was written after the bulk file was — yesterday's file, today's preview
    /// card — so the missing printing is one this device does not know yet, not one that left
    /// Scryfall. `collection_entries` waits; the other five go up.
    #[tokio::test]
    async fn a_card_newer_than_this_devices_card_data_is_held_from_a_current_corpus() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        bulk_file_aged(&conn, 1);
        conn.execute(
            "INSERT INTO collection_entries
               (card_id, set_code, collector_number, lang, finish, condition, quantity,
                folder_id, created_at, updated_at, sync_uid)
             VALUES ('c-a-preview-card', 'new', '1', 'en', 'nonfoil', 'NM', 1, NULL,
                     unixepoch(), unixepoch(), 'uid-preview')",
            [],
        )
        .unwrap();
        no_shares(&server).await;
        store_holds(&server, digests_body(SOME, &[])).await;
        let entries = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT)
                    .path("/g/g1/projection/collection_entries");
                then.status(200).body("{}");
            })
            .await;
        any_put(&server, 200, "{}").await;

        assert!(readable::corpus_current(&conn));
        let report = round(&conn).await;
        assert_eq!(report.held, ["collection_entries"]);
        assert_eq!(entries.calls_async().await, 0);
    }

    /// **A store priced at a feed this device does not hold current holds what reads prices**: at
    /// Mana Pool with `value` off, only the wishes wait — an any-printing wish is drawn by price —
    /// and with `value` on the collection's and the decks' cards wait beside them; folders and decks
    /// read no price and go up. With the feed current, everything goes up.
    #[tokio::test]
    async fn a_store_priced_at_a_feed_this_device_cannot_read_holds_what_reads_prices() {
        let mana_pool_fetched = |conn: &Connection, age: i64| {
            conn.execute(
                "INSERT OR REPLACE INTO marketplace_feed_meta
                   (marketplace, fetched_at, feed_built_at, row_count)
                 VALUES ('manapool', unixepoch() - ?1, NULL, 1)",
                [age],
            )
            .unwrap();
        };
        let priced = IntegrationFields {
            value: true,
            ..IntegrationFields::default()
        };
        for (fields, held) in [
            (IntegrationFields::default(), vec!["wishlist_entries"]),
            (
                priced,
                vec!["collection_entries", "wishlist_entries", "deck_cards"],
            ),
        ] {
            let server = httpmock::MockServer::start_async().await;
            let conn = open_db();
            entitled(&conn, &server.base_url());
            no_shares(&server).await;
            store_holds(&server, digests_at(fields, "manapool", &[])).await;
            let put = any_put(&server, 200, "{}").await;

            let report = round(&conn).await;
            assert_eq!(report.held, held, "no feed at all, {fields:?}");
            assert_eq!(put.calls_async().await, TABLES.len() - held.len());

            mana_pool_fetched(&conn, readable::FEED_CURRENT_SECS + 1);
            assert_eq!(
                round(&conn).await.held,
                held,
                "a feed left behind, {fields:?}"
            );

            mana_pool_fetched(&conn, 60);
            let report = round(&conn).await;
            assert!(report.held.is_empty(), "{fields:?}");
            assert_eq!(report.sent.len(), TABLES.len());
        }
    }

    /// A store that cannot read: its read connection is gone.
    struct NoReader<'a>(&'a Connection);

    impl Store for NoReader<'_> {
        fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R, String>) -> Result<R, String> {
            f(self.0)
        }

        fn reading<R>(
            &self,
            _f: impl FnOnce(&Connection) -> Result<R, String>,
        ) -> Result<R, String> {
            Err("the read connection is gone".to_owned())
        }
    }

    /// **A round whose first look fails is owed, not run**: deferred, so [`step`] leaves the
    /// request it may be answering for the next poll rather than clearing a press nobody served.
    #[tokio::test]
    async fn a_round_that_cannot_look_is_deferred() {
        let conn = open_db();
        entitled(&conn, "http://127.0.0.1:1");
        let report = round(&NoReader(&conn)).await;
        assert!(report.deferred, "{report:?}");
        assert!(!report.ran);
        assert_eq!(rows(&conn), 0);
    }
}
