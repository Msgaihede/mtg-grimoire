//! What a device remembers about baseline emissions — the baseline claim design of 2026-10-03
//! (`docs/superpowers/specs/2026-10-03-baseline-claim-emissions-design.md`), §4–§8.
//!
//! **Every mark is a `sync_state` key, and none of them is `sync_peers`.** A claim is a statement
//! about a row, not a place in its emitter's stream, so what remembers that it was consumed is a
//! ledger of its own: per emitter, the emissions in flight and the indices consumed from each,
//! beside the completed one whose record [`take`] keeps for a page handed back after it, and any
//! of its generation that the completed one superseded while their claims had written rows here;
//! the generation it has wholly taken; and what complete emissions carried into this device's rows.
//! A gap — the watermark or the cursor passing an op this device never applied — clears every
//! taken mark and what each record says its claims *passed*, keeps what they *wrote*, and marks
//! each record as from before the gap ([`open_gap`]), so the next emission from every emitter is
//! read whole and only one recorded after the gap can be taken.
//!
//! **One mark is about rows, not about any log, and no gap touches it**: a uid `apply` merged into
//! another row ([`retire`]), so that a claim naming it is never built again beside the row that
//! holds its copies (§6).
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
/// `retired@<table>/<uid>` = the survivor's uid: a row merged here into another ([`retire`]).
const RETIRED: &str = "retired@";
/// How many emissions are remembered per emitter — those in flight, the completed one whose record
/// [`take`] keeps, and the superseded ones it keeps for containment, each taking a slot; any of
/// them may be marked as from before a gap ([`Record::before_gap`]). **Past the bound a record
/// whose claims wrote nothing goes first** ([`bound`]): `wrote` is the only evidence that a put a
/// claim carried is inside a row here, so the records that hold some are the last to go.
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
///
/// **A watermark says so too.** A device that left or was removed under an older build never had
/// [`keep_logging_mark`] write its `0:0`, so `logging_since` alone would call its return a first
/// generation, and the edits it made while in no group would be passed on its peers rather than
/// floored. A `sync_peers` row is a peer whose ops this device applied, which only a device that
/// held a group can have, and leaving keeps every one of them (§7) — so any row is a generation
/// held before. A fresh install has none, and its first generation still does not resume.
pub fn start_logging(conn: &Connection) -> rusqlite::Result<()> {
    let resumed = get(conn, LOGGING_SINCE)?.is_some()
        || conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_peers)", [], |r| {
            r.get::<_, bool>(0)
        })?;
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

/// One emission as this device has consumed it (§5): in flight; completed, the one record [`take`]
/// keeps for a page handed back after it; or superseded by that one while its claims had written
/// rows here, kept for containment alone — and any of them perhaps from before a gap.
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
    /// Recorded before a gap [`open_gap`] opened: its `wrote` set still stands and still serves
    /// containment, its `passed` set was cleared so those claims are decided again, and it is
    /// **never taken**, so only an emission recorded after the gap can close it (§7).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub before_gap: bool,
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
            before_gap: false,
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

/// The emissions of `emitter` this device remembers, newest first: those in flight, the completed
/// one [`take`] kept and the superseded ones it kept beside it, and any marked as from before a gap.
pub fn records(conn: &Connection, emitter: &str) -> rusqlite::Result<Vec<Record>> {
    Ok(get(conn, &format!("{RECORDS}{emitter}"))?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default())
}

/// Store `record`, replacing one of the same `id`, within the bound ([`bound`]).
pub fn keep(conn: &Connection, emitter: &str, record: Record) -> rusqlite::Result<()> {
    let mut all = records(conn, emitter)?;
    all.retain(|r| r.id != record.id);
    let stored = record.id;
    all.push(record);
    put(
        conn,
        &format!("{RECORDS}{emitter}"),
        &json(&bound(all, stored))?,
    )
}

/// An emitter's records cut to [`RECORDS_PER_EMITTER`], newest first. **A record whose claims
/// wrote nothing goes first**, oldest first, and only then a record that wrote — `wrote` is the
/// only evidence that a put a claim carried is inside a row here, and a page handed back with that
/// put and no record to prove it counts it again (the final review's C1). A record from before a
/// gap keeps its `wrote` set, so it is kept over an empty one as well.
///
/// **`stored`, the record just written, ranks with the ones that wrote** whatever it holds. It is
/// an emission's progress: one whose claims all passed so far would otherwise be cut the moment
/// it was stored, and an emission pulled over several pages would never be whole.
fn bound(mut all: Vec<Record>, stored: Stamp) -> Vec<Record> {
    all.sort_by_key(|r| std::cmp::Reverse((r.id == stored || !r.wrote.is_empty(), r.id)));
    all.truncate(RECORDS_PER_EMITTER);
    all.sort_by_key(|r| std::cmp::Reverse(r.id));
    all
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

/// An emission wholly consumed (§5, §8): its generation is taken, every OTHER record of the
/// emitter at or below that generation goes — but one of the same generation whose claims wrote a
/// row here — and, only where `carry`, every claim having written its row, what its horizon names
/// is carried here: each device's `carried@` raised to the horizon's entry, this device's own
/// excepted.
///
/// **Its own record is kept.** A page handed back after the emission completed still carries the
/// covered puts its claims carried; the first delivery dropped them and no watermark rose, so that
/// record's `wrote` set is the only evidence they are inside rows here (§5, §6's inert row).
///
/// **So is a record it supersedes in its own generation whose claims wrote a row** (amended
/// 2026-10-03, after the final review). A half-sent emission whose claim built a row dropped the
/// puts it carried exactly as a whole one does, and a page handed back with one of them after the
/// newer emission completed — whose own claim for the row passed, the row being held here by then
/// — found nothing to prove the put inside the row: 4 where 2 is right. Kept for containment
/// alone: its generation is taken, so it is inert and never taken itself, and a gap that clears the
/// mark marks it as from before the gap, which is never taken either. A record of an older
/// generation still goes.
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
    all.retain(|r| {
        r.id != record.id
            && (r.since > record.since || (r.since == record.since && !r.wrote.is_empty()))
    });
    all.push(record.clone());
    put(
        conn,
        &format!("{RECORDS}{emitter}"),
        &json(&bound(all, record.id))?,
    )?;
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

/// A gap (§7): every `taken@` mark goes and the floor opens — **and what claims wrote stays.**
///
/// Each record of every emitter keeps its `wrote` set and loses its `passed` set, and is marked
/// [`Record::before_gap`]. A written claim stays consumed: flooring it again could only take back
/// what this device did to its row since, and the record is the only evidence that the covered
/// puts the first delivery dropped as carried are inside that row — no watermark rose for them,
/// so a page handed back across the gap with the record gone floored the row and sent those puts
/// down the op path beside it, §8.1's 5 read as 10. A passed claim wrote nothing, so it is decided
/// again, and on a row held here it now floors. A before-gap record is never taken, so the gap
/// closes only on emissions recorded after it.
pub fn open_gap(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE key GLOB ?1",
        [format!("{TAKEN}*")],
    )?;
    let emitters: Vec<String> = conn
        .prepare("SELECT key FROM sync_state WHERE key GLOB ?1")?
        .query_map([format!("{RECORDS}*")], |r| r.get::<_, String>(0))?
        .map(|key| key.map(|k| k[RECORDS.len()..].to_owned()))
        .collect::<rusqlite::Result<_>>()?;
    for emitter in emitters {
        let mut all = records(conn, &emitter)?;
        for record in &mut all {
            record.passed = Ranges::default();
            record.before_gap = true;
        }
        put(conn, &format!("{RECORDS}{emitter}"), &json(&all)?)?;
    }
    put(conn, GAP, "1")
}

/// Whether this device has a gap open (§7) — while it does, an active claim floors a row held
/// here. Open from [`open_gap`] until [`close_gap_if_whole`] finds every roster peer it holds a
/// watermark for taken again.
pub fn gap_open(conn: &Connection) -> rusqlite::Result<bool> {
    Ok(get(conn, GAP)?.is_some())
}

/// `uid` of `table` was merged here into another row, whose uid is `survivor` (§6's merged-away
/// row), in either direction. `apply` does it in two places. A grain match (`adopt_uid`) renames
/// the row it finds to the lower uid, or to the incoming one over a row the page deletes, and the
/// row's own uid goes; or the row keeps its own, lower uid and absorbs the incoming one, which
/// goes. A folder delete's re-homing (`rehome`) folds a row onto its root twin, and one of the two
/// uids goes.
///
/// **The retired uid's copies live in the survivor now**, and nothing else here can tell that
/// apart from a row never held: no row wears the uid and this device's own log never named it.
/// So without the mark a later active claim for it — a later emission, or a page handed back across
/// the gap its dropped edits opened — built it again, and counted those copies twice: 6 on a
/// device whose emitter held 4. That is the direction §8.2 forbids.
///
/// **No gap clears it**, and nor does leaving a group or forgetting a log position: it is a fact
/// about this device's rows, not about a log. Keyed by the op's table name, which is `apply`'s
/// `Meta::table` for every synced table.
pub fn retire(conn: &Connection, table: &str, uid: &str, survivor: &str) -> rusqlite::Result<()> {
    put(conn, &format!("{RETIRED}{table}/{uid}"), survivor)
}

/// Take [`retire`]'s mark back off `uid`: the row it was merged into has given its copies back
/// and `uid` is a row of its own again, or is about to be. One caller, `apply`'s ledger of
/// orphans: a row folded onto a twin because its parent was gone is un-folded when the parent
/// comes back, and a claim naming it must build it then as any other.
pub fn unretire(conn: &Connection, table: &str, uid: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE key = ?1",
        [format!("{RETIRED}{table}/{uid}")],
    )
    .map(|_| ())
}

/// Whether `uid` of `table` was merged here into another row ([`retire`]). Asked of every active
/// claim a page carries, so the statement is cached.
pub fn retired(conn: &Connection, table: &str, uid: &str) -> rusqlite::Result<bool> {
    conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM sync_state WHERE key = ?1)")?
        .query_row([format!("{RETIRED}{table}/{uid}")], |r| r.get(0))
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

    /// Spec §5: the taken emission's own record stays, for a page handed back after it
    /// completed; every other record of its generation or an older one goes.
    #[test]
    fn taking_an_emission_keeps_its_record_drops_the_older_records_it_supersedes_and_carries_its_horizon(
    ) {
        let conn = db();
        keep(&conn, "dev-a", Record::new((2, 0), 1, (1, 0), false)).unwrap();
        keep(&conn, "dev-a", Record::new((3, 0), 2, (1, 0), false)).unwrap();
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
            vec![(6, 0), (2, 0)],
            "the newer generation's record and the taken one's stay; the half-sent (3, 0) goes"
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

    /// The final review's C1 ruling: a record of the taken emission's own generation whose claims
    /// wrote a row is kept beside it, for containment alone — it is the only evidence that a put
    /// its claim carried is inside that row. One that wrote nothing still goes, and so does one of
    /// an older generation.
    #[test]
    fn taking_an_emission_keeps_a_record_of_its_generation_whose_claims_wrote() {
        let conn = db();
        let mut older_generation = Record::new((1, 0), 2, (0, 0), false);
        older_generation.wrote.insert(0);
        keep(&conn, "dev-a", older_generation).unwrap();
        let mut half_sent = Record::new((2, 0), 2, (1, 0), false);
        half_sent.wrote.insert(0);
        keep(&conn, "dev-a", half_sent.clone()).unwrap();
        let mut passed_only = Record::new((3, 0), 2, (1, 0), false);
        passed_only.passed.insert(0);
        keep(&conn, "dev-a", passed_only).unwrap();

        let mut done = Record::new((4, 0), 1, (1, 0), false);
        done.passed.insert(0);
        take(&conn, "dev-a", &done, &Horizon::default(), false, None).unwrap();
        assert_eq!(taken(&conn, "dev-a").unwrap(), Some((1, 0)));
        assert_eq!(
            records(&conn, "dev-a").unwrap(),
            vec![done, half_sent],
            "the half-sent record that wrote stays, untouched; the rest go"
        );
    }

    /// The final review's ruling on the bound: past [`RECORDS_PER_EMITTER`] a record whose claims
    /// wrote nothing goes first, and only then the oldest that wrote — and the record just stored
    /// is never the first to go, or an emission pulled over several pages would never be whole.
    #[test]
    fn the_ledger_evicts_a_record_that_wrote_nothing_first() {
        let conn = db();
        let ids = || -> Vec<i64> {
            records(&conn, "dev-a")
                .unwrap()
                .iter()
                .map(|r| r.id.0)
                .collect()
        };
        let record = |ms: i64, wrote: bool| {
            let mut r = Record::new((ms, 0), 2, (1, 0), false);
            if wrote {
                r.wrote.insert(0);
            } else {
                r.passed.insert(0);
            }
            r
        };
        for ms in 1..=4 {
            keep(&conn, "dev-a", record(ms, ms != 3)).unwrap();
        }
        keep(&conn, "dev-a", record(5, false)).unwrap();
        assert_eq!(
            ids(),
            vec![5, 4, 2, 1],
            "3 wrote nothing, and went before 1"
        );
        keep(&conn, "dev-a", record(6, false)).unwrap();
        assert_eq!(
            ids(),
            vec![6, 4, 2, 1],
            "the one stored stays; 5 wrote nothing"
        );
        keep(&conn, "dev-a", record(7, true)).unwrap();
        assert_eq!(ids(), vec![7, 4, 2, 1]);
        keep(&conn, "dev-a", record(8, true)).unwrap();
        assert_eq!(ids(), vec![8, 7, 4, 2], "every one wrote: the oldest goes");

        // A record from before a gap keeps its `wrote` set, so it is kept as one that wrote.
        open_gap(&conn).unwrap();
        keep(&conn, "dev-a", record(9, false)).unwrap();
        keep(&conn, "dev-a", record(10, false)).unwrap();
        assert_eq!(ids(), vec![10, 8, 7, 4]);
        assert!(records(&conn, "dev-a").unwrap()[1..]
            .iter()
            .all(|r| r.before_gap));
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

    /// Spec §7 as amended: a gap clears every taken mark and every record's `passed` set, and keeps
    /// every record with its `wrote` set, marked as from before the gap.
    #[test]
    fn a_gap_clears_the_taken_marks_keeps_what_claims_wrote_and_closes_once_the_roster_is_taken_again(
    ) {
        let conn = db();
        let mut done = Record::new((2, 0), 2, (1, 0), false);
        done.wrote.insert(0);
        done.passed.insert(1);
        take(&conn, "dev-a", &done, &Horizon::default(), true, None).unwrap();
        let mut flight = Record::new((6, 0), 3, (5, 0), false);
        flight.passed.insert(0);
        flight.wrote.insert(2);
        keep(&conn, "dev-a", flight).unwrap();
        put(&conn, "absorbed@dev-a", "4:0").unwrap();
        put(&conn, LOGGING_SINCE, "3:0").unwrap();

        open_gap(&conn).unwrap();
        assert!(gap_open(&conn).unwrap());
        assert_eq!(taken(&conn, "dev-a").unwrap(), None);
        let kept: Vec<(Stamp, Ranges, Ranges, bool)> = records(&conn, "dev-a")
            .unwrap()
            .into_iter()
            .map(|r| (r.id, r.wrote, r.passed, r.before_gap))
            .collect();
        assert_eq!(
            kept,
            vec![
                ((6, 0), Ranges(vec![(2, 2)]), Ranges::default(), true),
                ((2, 0), Ranges(vec![(0, 0)]), Ranges::default(), true),
            ]
        );
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

    /// Task 8b: a uid merged here into another row reads back by its table and its uid, and no
    /// gap clears it — it is a fact about this device's rows, not about a log.
    #[test]
    fn a_retired_uid_reads_back_and_survives_a_gap() {
        let conn = db();
        assert!(
            !retired(&conn, "collection_entries", "u1").unwrap(),
            "a uid never merged here reads as retired"
        );
        retire(&conn, "collection_entries", "u1", "u0").unwrap();
        assert!(retired(&conn, "collection_entries", "u1").unwrap());
        assert_eq!(
            value(&conn, "retired@collection_entries/u1").as_deref(),
            Some("u0"),
            "the mark names its survivor"
        );
        assert!(
            !retired(&conn, "wishlist_entries", "u1").unwrap(),
            "another table's row of the same uid"
        );
        assert!(
            !retired(&conn, "collection_entries", "u0").unwrap(),
            "the survivor"
        );
        open_gap(&conn).unwrap();
        assert!(
            retired(&conn, "collection_entries", "u1").unwrap(),
            "a gap cleared the mark"
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
