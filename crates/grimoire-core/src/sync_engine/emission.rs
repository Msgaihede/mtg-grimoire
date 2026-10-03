//! What a device remembers about baseline emissions — the baseline claim design of 2026-10-03
//! (`docs/superpowers/specs/2026-10-03-baseline-claim-emissions-design.md`), §4, §5, §7, §8.
//!
//! **Every mark is a `sync_state` key, and none of them is `sync_peers`.** A claim is a statement
//! about a row, not a place in its emitter's stream, so what remembers that it was consumed is a
//! ledger of its own: per emitter, the emissions in flight and the indices consumed from each;
//! the generation it has wholly taken; and what complete emissions carried into this device's
//! rows. A gap — the watermark or the cursor passing an op this device never applied — clears
//! the ledger, so the next emission from every emitter is read whole.
//!
//! **A value that does not parse reads as absent.** Absent makes an emission active, which is
//! more work and never less correctness, so a hand-edited or truncated mark costs a re-read,
//! never a failed apply.

use super::merge::Horizon;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// `(ms, ctr)` on one device's clock.
pub type Stamp = (i64, i64);

/// The stamp at which this device's capture last turned on — its generation (§4).
pub const LOGGING_SINCE: &str = "logging_since";
/// `"1"` when that generation was minted over an earlier one (§4).
pub const LOGGING_RESUMED: &str = "logging_resumed";
/// Present while this device has a gap (§7).
pub const GAP: &str = "gap";
/// The upgrade boundary (§10): an emission named at or below it is judged as an older build
/// judged it.
pub const CUT: &str = "emissions_since";
const TAKEN: &str = "taken@";
const RECORDS: &str = "emission@";
const CARRIED: &str = "carried@";
/// How many in-flight emissions are remembered per emitter. An emission older than these is
/// one a newer emission of the same emitter has superseded or will.
pub const RECORDS_PER_EMITTER: usize = 4;

fn get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .optional()
}

fn put(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map(|_| ())
}

fn parse(v: &str) -> Option<Stamp> {
    let (ms, ctr) = v.split_once(':')?;
    Some((ms.parse().ok()?, ctr.parse().ok()?))
}

fn show(s: Stamp) -> String {
    format!("{}:{}", s.0, s.1)
}

fn json<T: Serialize>(value: &T) -> rusqlite::Result<String> {
    serde_json::to_string(value).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

/// One tick of `sync_clock`, which is what names an emission (§3) and stamps a generation (§4).
///
/// The capture trigger's own arithmetic, so the tick sits above every op this device has
/// captured and below every op it captures next.
pub fn tick(conn: &Connection) -> rusqlite::Result<Stamp> {
    conn.query_row(
        "UPDATE sync_clock SET
             ms  = max(ms, cast(unixepoch('subsec') * 1000 AS INTEGER)),
             ctr = CASE WHEN cast(unixepoch('subsec') * 1000 AS INTEGER) > ms THEN 0
                        ELSE ctr + 1 END
           WHERE id = 1
         RETURNING ms, ctr",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// What an emission is named and stamped with, minted in the stretch that reads its rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Begun {
    pub id: Stamp,
    pub since: Stamp,
    pub resumed: bool,
}

/// Name an emission and read the generation it goes out under. A device that has never minted a
/// generation emits `since: 0` — "the logging that began before this build" (§4).
pub fn begin(conn: &Connection) -> rusqlite::Result<Begun> {
    let id = tick(conn)?;
    let since = get(conn, LOGGING_SINCE)?
        .as_deref()
        .and_then(parse)
        .unwrap_or((0, 0));
    let resumed = get(conn, LOGGING_RESUMED)?.as_deref() == Some("1");
    Ok(Begun { id, since, resumed })
}

/// Capture has just turned on: mint a generation (§4). It resumes when one was held before —
/// `identity::leave_group` keeps it for exactly this.
pub fn start_logging(conn: &Connection) -> rusqlite::Result<()> {
    let resumed = get(conn, LOGGING_SINCE)?.is_some();
    let since = tick(conn)?;
    put(conn, LOGGING_SINCE, &show(since))?;
    put(conn, LOGGING_RESUMED, if resumed { "1" } else { "0" })
}

/// Leaving a group: keep the generation so the next one resumes, writing `0:0` for a device that
/// logged before this build and has none (§4).
pub fn keep_logging_mark(conn: &Connection) -> rusqlite::Result<()> {
    if get(conn, LOGGING_SINCE)?.is_none() {
        put(conn, LOGGING_SINCE, "0:0")?;
    }
    Ok(())
}

/// Sorted, disjoint, inclusive index ranges — an emission's consumed indices, compactly.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Ranges(Vec<(u32, u32)>);

impl Ranges {
    pub fn contains(&self, i: u32) -> bool {
        self.0.iter().any(|&(a, b)| a <= i && i <= b)
    }

    pub fn insert(&mut self, i: u32) {
        if self.contains(i) {
            return;
        }
        self.0.push((i, i));
        self.0.sort_unstable();
        let mut out: Vec<(u32, u32)> = Vec::with_capacity(self.0.len());
        for (a, b) in self.0.drain(..) {
            match out.last_mut() {
                Some(last) if a <= last.1.saturating_add(1) => last.1 = last.1.max(b),
                _ => out.push((a, b)),
            }
        }
        self.0 = out;
    }

    pub fn len(&self) -> u64 {
        self.0.iter().map(|&(a, b)| u64::from(b - a) + 1).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// One emission in flight, as this device has consumed it (§5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub id: Stamp,
    pub n: u32,
    pub since: Stamp,
    #[serde(default)]
    pub resumed: bool,
    /// Claims that built, merged or floored their row.
    #[serde(default)]
    pub wrote: Ranges,
    /// Claims consumed without writing: a held row's claim, a moot one, one dropped and recorded.
    #[serde(default)]
    pub passed: Ranges,
}

impl Record {
    pub fn new(id: Stamp, n: u32, since: Stamp, resumed: bool) -> Record {
        Record {
            id,
            n,
            since,
            resumed,
            wrote: Ranges::default(),
            passed: Ranges::default(),
        }
    }

    pub fn consumed(&self, i: u32) -> bool {
        self.wrote.contains(i) || self.passed.contains(i)
    }

    /// Every index below `n` consumed. An emission that says it sends nothing is never complete,
    /// so a malformed head cannot mark a generation taken.
    pub fn complete(&self) -> bool {
        self.n > 0 && (0..self.n).all(|i| self.consumed(i))
    }
}

/// The generation of `emitter` this device has wholly taken, if any.
pub fn taken(conn: &Connection, emitter: &str) -> rusqlite::Result<Option<Stamp>> {
    Ok(get(conn, &format!("{TAKEN}{emitter}"))?
        .as_deref()
        .and_then(parse))
}

/// The emissions of `emitter` in flight here, newest first.
pub fn records(conn: &Connection, emitter: &str) -> rusqlite::Result<Vec<Record>> {
    Ok(get(conn, &format!("{RECORDS}{emitter}"))?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default())
}

/// Store `record`, replacing one of the same `id`, keeping the newest [`RECORDS_PER_EMITTER`].
pub fn keep(conn: &Connection, emitter: &str, record: Record) -> rusqlite::Result<()> {
    let mut all = records(conn, emitter)?;
    all.retain(|r| r.id != record.id);
    all.push(record);
    all.sort_by_key(|r| std::cmp::Reverse(r.id));
    all.truncate(RECORDS_PER_EMITTER);
    put(conn, &format!("{RECORDS}{emitter}"), &json(&all)?)
}

/// The upgrade boundary (§10), minted on the first call and never moved after: a day past this
/// device's clock where it holds any watermark — an older build may have applied an emission in a
/// page held across the upgrade — and zero where it holds none. A value that does not parse is
/// minted again, later, which only widens the old path.
pub fn cut(conn: &Connection) -> rusqlite::Result<Stamp> {
    if let Some(held) = get(conn, CUT)?.as_deref().and_then(parse) {
        return Ok(held);
    }
    let peers: i64 = conn.query_row("SELECT count(*) FROM sync_peers", [], |r| r.get(0))?;
    let cut = if peers == 0 {
        (0, 0)
    } else {
        let now: i64 = conn.query_row(
            "SELECT max(ms, cast(unixepoch('subsec') * 1000 AS INTEGER)) FROM sync_clock WHERE id = 1",
            [],
            |r| r.get(0),
        )?;
        (now.saturating_add(super::hlc::MAX_AHEAD_MS), i64::MAX)
    };
    put(conn, CUT, &show(cut))?;
    Ok(cut)
}

/// An emission wholly consumed (§5, §8): its generation is taken, every record of the emitter at
/// or below that generation goes, and — only where `carry`, every claim having written its row —
/// what its horizon names is carried here: each device's `carried@` raised to the horizon's entry,
/// this device's own excepted.
pub fn take(
    conn: &Connection,
    emitter: &str,
    record: &Record,
    horizon: &Horizon,
    carry: bool,
    me: Option<&str>,
) -> rusqlite::Result<()> {
    let key = format!("{TAKEN}{emitter}");
    if get(conn, &key)?
        .as_deref()
        .and_then(parse)
        .is_none_or(|held| record.since > held)
    {
        put(conn, &key, &show(record.since))?;
    }
    let mut all = records(conn, emitter)?;
    all.retain(|r| r.since > record.since);
    put(conn, &format!("{RECORDS}{emitter}"), &json(&all)?)?;
    if !carry {
        return Ok(());
    }
    for (device, at) in &horizon.seen {
        if Some(device.as_str()) == me {
            continue;
        }
        let key = format!("{CARRIED}{device}");
        if get(conn, &key)?
            .as_deref()
            .and_then(parse)
            .is_none_or(|held| (at.ms, at.ctr) > held)
        {
            put(conn, &key, &show((at.ms, at.ctr)))?;
        }
    }
    Ok(())
}

/// Every `carried@` mark, by device — what `baseline::horizon` adds to `sync_peers` (§8).
pub fn carried(conn: &Connection) -> rusqlite::Result<BTreeMap<String, Stamp>> {
    let mut stmt = conn.prepare("SELECT key, value FROM sync_state WHERE key GLOB ?1")?;
    let rows = stmt.query_map([format!("{CARRIED}*")], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (key, value) = row?;
        if let Some(stamp) = parse(&value) {
            out.insert(key[CARRIED.len()..].to_owned(), stamp);
        }
    }
    Ok(out)
}

/// A gap (§7): every `taken@` and `emission@` mark goes, and the floor opens.
pub fn open_gap(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE key GLOB ?1 OR key GLOB ?2",
        params![format!("{TAKEN}*"), format!("{RECORDS}*")],
    )?;
    put(conn, GAP, "1")
}

pub fn gap_open(conn: &Connection) -> rusqlite::Result<bool> {
    Ok(get(conn, GAP)?.is_some())
}

/// Close the gap once every device on this group's roster that this one holds a watermark for
/// has a `taken@` mark again (§7). The roster and not `sync_peers` alone: a watermark outlives
/// its group, and a peer of an old group never emits here again.
pub fn close_gap_if_whole(conn: &Connection) -> rusqlite::Result<()> {
    if !gap_open(conn)? {
        return Ok(());
    }
    let missing: i64 = conn.query_row(
        "SELECT count(*) FROM sync_peers p
           JOIN sync_devices d ON d.device_id = p.device_id AND d.revoked_at IS NULL
          WHERE NOT EXISTS (SELECT 1 FROM sync_state s WHERE s.key = ?1 || p.device_id)",
        [TAKEN],
        |r| r.get(0),
    )?;
    if missing == 0 {
        conn.execute("DELETE FROM sync_state WHERE key = ?1", [GAP])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::hlc::Hlc;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        crate::sync_engine::capture::install(&conn).unwrap();
        conn
    }

    fn value(conn: &Connection, key: &str) -> Option<String> {
        get(conn, key).unwrap()
    }

    #[test]
    fn ranges_coalesce_and_count() {
        let mut r = Ranges::default();
        for i in [3, 1, 2, 7, 5, 6, 2] {
            r.insert(i);
        }
        assert_eq!(r.0, vec![(1, 3), (5, 7)]);
        assert_eq!(r.len(), 6);
        assert!(r.contains(6) && !r.contains(4) && !r.contains(0));
    }

    #[test]
    fn begin_ticks_and_reads_the_generation() {
        let conn = db();
        let one = begin(&conn).unwrap();
        let two = begin(&conn).unwrap();
        assert!(two.id > one.id, "{one:?} then {two:?}");
        assert_eq!(
            (one.since, one.resumed),
            ((0, 0), false),
            "no generation is `0`"
        );

        start_logging(&conn).unwrap();
        let first = begin(&conn).unwrap();
        assert!(first.since > (0, 0));
        assert!(!first.resumed, "a first generation does not resume");

        start_logging(&conn).unwrap();
        let again = begin(&conn).unwrap();
        assert!(again.since > first.since);
        assert!(again.resumed, "a generation minted over one resumes");
    }

    #[test]
    fn a_device_that_logged_before_this_build_resumes_after_leaving() {
        let conn = db();
        keep_logging_mark(&conn).unwrap();
        assert_eq!(value(&conn, LOGGING_SINCE).as_deref(), Some("0:0"));
        start_logging(&conn).unwrap();
        assert!(begin(&conn).unwrap().resumed);

        // ...and the mark never overwrites a generation it finds.
        let held = value(&conn, LOGGING_SINCE);
        keep_logging_mark(&conn).unwrap();
        assert_eq!(value(&conn, LOGGING_SINCE), held);
    }

    #[test]
    fn a_record_completes_only_when_every_index_below_n_is_consumed() {
        let mut r = Record::new((9, 0), 3, (1, 0), false);
        r.wrote.insert(0);
        r.passed.insert(1);
        assert!(!r.complete());
        r.wrote.insert(2);
        assert!(r.complete());
        let mut empty = Record::new((9, 0), 0, (1, 0), false);
        empty.wrote.insert(0);
        assert!(
            !empty.complete(),
            "an emission that says it sends nothing is never taken"
        );
    }

    #[test]
    fn the_ledger_keeps_the_newest_emissions() {
        let conn = db();
        for ms in 1..=5 {
            keep(&conn, "dev-a", Record::new((ms, 0), 1, (1, 0), false)).unwrap();
        }
        let ids: Vec<Stamp> = records(&conn, "dev-a")
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec![(5, 0), (4, 0), (3, 0), (2, 0)]);
    }

    #[test]
    fn taking_an_emission_marks_it_drops_what_it_supersedes_and_carries_its_horizon() {
        let conn = db();
        keep(&conn, "dev-a", Record::new((2, 0), 1, (1, 0), false)).unwrap();
        keep(&conn, "dev-a", Record::new((6, 0), 1, (5, 0), true)).unwrap();
        let mut horizon = Horizon::default();
        for (device, ms) in [("dev-c", 900), ("dev-b", 50), ("dev-a", 70)] {
            horizon.seen.insert(
                device.to_owned(),
                Hlc {
                    ms,
                    ctr: 0,
                    device: device.to_owned(),
                },
            );
        }
        let done = Record::new((2, 0), 1, (1, 0), false);
        take(&conn, "dev-a", &done, &horizon, true, Some("dev-b")).unwrap();

        assert_eq!(taken(&conn, "dev-a").unwrap(), Some((1, 0)));
        let left: Vec<Stamp> = records(&conn, "dev-a")
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(
            left,
            vec![(6, 0)],
            "only the newer generation's record stays"
        );
        let c = carried(&conn).unwrap();
        assert_eq!(c.get("dev-c"), Some(&(900, 0)));
        assert_eq!(c.get("dev-a"), Some(&(70, 0)));
        assert_eq!(
            c.get("dev-b"),
            None,
            "this device carries nothing of its own"
        );
    }

    /// Spec §8: an emission with any claim passed is taken but carries nothing — a held row's
    /// claim wrote nothing, so that row does not hold what the horizon names.
    #[test]
    fn an_emission_with_a_passed_claim_is_taken_and_carries_nothing() {
        let conn = db();
        let mut horizon = Horizon::default();
        horizon.seen.insert(
            "dev-c".to_owned(),
            Hlc {
                ms: 900,
                ctr: 0,
                device: "dev-c".to_owned(),
            },
        );
        let done = Record::new((2, 0), 1, (1, 0), false);
        take(&conn, "dev-a", &done, &horizon, false, None).unwrap();
        assert_eq!(taken(&conn, "dev-a").unwrap(), Some((1, 0)));
        assert!(carried(&conn).unwrap().is_empty());
    }

    /// Spec §10: the cut is minted once — a day past this device's clock where it has synced
    /// before, zero where it never has — and never moves after.
    #[test]
    fn the_upgrade_cut_is_minted_once() {
        let fresh = db();
        assert_eq!(
            cut(&fresh).unwrap(),
            (0, 0),
            "nothing older could have synced here"
        );

        let synced = db();
        synced
            .execute(
                "INSERT INTO sync_peers (device_id, last_ms, last_ctr) VALUES ('dev-a', 1, 0)",
                [],
            )
            .unwrap();
        synced
            .execute("UPDATE sync_clock SET ms = 5000000000000", [])
            .unwrap();
        let first = cut(&synced).unwrap();
        assert_eq!(
            first,
            (
                5_000_000_000_000 + crate::sync_engine::hlc::MAX_AHEAD_MS,
                i64::MAX
            )
        );
        synced
            .execute("UPDATE sync_clock SET ms = 9000000000000", [])
            .unwrap();
        assert_eq!(cut(&synced).unwrap(), first, "the cut does not move");
    }

    #[test]
    fn a_gap_clears_the_marks_and_closes_once_the_roster_is_taken_again() {
        let conn = db();
        let done = Record::new((2, 0), 1, (1, 0), false);
        take(&conn, "dev-a", &done, &Horizon::default(), true, None).unwrap();
        keep(&conn, "dev-a", Record::new((6, 0), 1, (5, 0), false)).unwrap();
        put(&conn, "absorbed@dev-a", "4:0").unwrap();
        put(&conn, LOGGING_SINCE, "3:0").unwrap();

        open_gap(&conn).unwrap();
        assert!(gap_open(&conn).unwrap());
        assert_eq!(taken(&conn, "dev-a").unwrap(), None);
        assert!(records(&conn, "dev-a").unwrap().is_empty());
        assert_eq!(
            value(&conn, "absorbed@dev-a").as_deref(),
            Some("4:0"),
            "not ours to clear"
        );
        assert_eq!(value(&conn, LOGGING_SINCE).as_deref(), Some("3:0"));

        // dev-a is on the roster and has a watermark; dev-z has a watermark from an old group.
        conn.execute_batch(
            "INSERT INTO sync_peers (device_id, last_ms, last_ctr) VALUES ('dev-a', 1, 0), ('dev-z', 1, 0);
             INSERT INTO sync_devices (device_id, public_key, name, added_at) VALUES ('dev-a', x'00', 'dev-a', 0);",
        )
        .unwrap();
        close_gap_if_whole(&conn).unwrap();
        assert!(gap_open(&conn).unwrap(), "dev-a has not been taken again");
        take(&conn, "dev-a", &done, &Horizon::default(), true, None).unwrap();
        close_gap_if_whole(&conn).unwrap();
        assert!(
            !gap_open(&conn).unwrap(),
            "dev-z is on no roster and holds nothing open"
        );
    }

    #[test]
    fn unparseable_marks_read_as_absent() {
        let conn = db();
        put(&conn, "taken@dev-a", "garbage").unwrap();
        put(&conn, "emission@dev-a", "{").unwrap();
        put(&conn, "carried@dev-c", "x:y").unwrap();
        put(&conn, LOGGING_SINCE, "nope").unwrap();
        assert_eq!(taken(&conn, "dev-a").unwrap(), None);
        assert!(records(&conn, "dev-a").unwrap().is_empty());
        assert!(carried(&conn).unwrap().is_empty());
        assert_eq!(begin(&conn).unwrap().since, (0, 0));
    }
}
