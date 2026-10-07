//! The ledger of orphans: what a decision resting on [`gone`] did to a row, kept so that the
//! decision can be taken back if the parent it rested on ever exists again (issue #841).
//!
//! # What it is for
//!
//! `apply` answers a row whose parent is gone the way that parent's foreign key answers a delete:
//! written without it where the key is `SET NULL`, consumed where it cascades — and deleted, where
//! this device held it. That is right while the parent stays gone. **It is wrong the moment the
//! parent comes back**, and add-wins brings one back whenever its own device edited it after the
//! delete. Where the edit and the child arrive in one answer, the page's retry passes find the
//! parent before the decision is taken. Where they arrive in two — a live device pulling between
//! two pushes, or a page edge — the decision is taken first, behind `capture::suppressed`, so
//! nothing either device will ever send says it happened: the sender keeps the child under the
//! parent, and this device holds it at the root, or not at all. Measured on six shapes before
//! this module existed (`tests/cuts.rs`), and on all six the answer depended on where the log
//! was cut.
//!
//! So every such decision leaves a row in `sync_orphans` (user schema v60, unsynced), and
//! [`sweep`] — run at the end of every pass of every apply — takes back each one whose parent
//! is a row here again, through the ordinary write path where there is one. **What an apply
//! leaves is then the same wherever the log was cut**, because the entry carries across the cut
//! exactly what the page-wide fold would have known.
//!
//! # The three places an orphan can be
//!
//! | [`State`] | Where the row is while its parent is gone | What bringing it back is |
//! | --- | --- | --- |
//! | `Placed` | here, under its own uid, written without the parent | its placement, applied as the op it came from |
//! | `Folded` | inside a twin: written without the parent, it landed on the root's grain | the twin gives back what it took, and the row is built under the parent |
//! | `Absent` | nowhere: its parent's key cascades | the row, built as the entry describes it |
//!
//! An `Absent` or `Folded` entry holds the row as it **would be** ([`Row`]) rather than the ops
//! that would make it, and that is forced: `apply` remembers no stamp for anything another
//! device wrote, so a row deleted here cannot be folded back together from this device's own log
//! — it would come back with every field a peer had changed reverted. The would-be row is kept
//! current instead: an op that arrives for an orphan is laid over its entry ([`meet_absent`],
//! [`meet_folded`]) where it used to be skipped as a row this database cannot build.
//!
//! # A fold is two rows in one, and the ledger is what still tells them apart
//!
//! Only two tables can fold — a copy and a wish, whose grain carries the folder — and a fold
//! is where every hard case here lives, because the root's unique index leaves no room for two
//! rows and the sender, having folded nothing, goes on holding two.
//!
//! - **What the twin took is measured, never inferred**: each write a folded row's ops make to
//!   its twin is read on both sides, and the difference added to the entry's `share` and
//!   `changed`. Reading the twin whole when the fold is undone would count everything that
//!   happened to it in between as the orphan's.
//! - **The twin is found by a column, `twin`, that follows it**: a row is renamed whenever two
//!   meet on a grain and the lower uid wins, so [`renamed`] re-points every entry lent to it.
//! - **A twin wears the lowest uid of its own and those folded into it**, which is what the
//!   sender's re-homing calls the pair if their parents stay gone. `alias` is the twin's own
//!   uid, held by the entry of whichever orphan's the row is wearing: the sender, which folded
//!   nothing, still addresses the twin by it ([`survivor_of`]), and a delete so addressed takes
//!   the twin and nothing folded into it ([`twin_deleted`]).
//! - **A row that lands on a `Placed` orphan does not fold into it** — the orphan is the one
//!   that is there only for now, so it is the one that steps aside and is lent to the newcomer
//!   ([`in_the_way`], [`lend`]).
//! - **Where both are orphans the lower uid keeps the row**, and the other is folded into it:
//!   the ledger knows a `Placed` row by its uid, so that row is never renamed — the one that
//!   would have taken its name steps aside for it instead.
//! - **A row that leaves the root's grain leaves behind what was folded into it there**
//!   ([`leave_behind`]): those rows were lent to the place, not to the row.
//! - **What this device's reader does to a merged row goes with the name it went out under**:
//!   a fold records this device's clock, and undone, this device's own ops under the orphan's
//!   uid since then leave the twin with the orphan — where they landed on the sender.
//!
//! # What it does not do
//!
//! - **It records only decisions resting on [`gone`]**, so a folder a peer really deleted — the
//!   delete arm — and which a *third* device's later edit brings back returns empty on a device
//!   that re-homed its own copies out of it. That needs three devices and is issue #842's.
//! - **A delete addressed to the uid a merged row wears is read one way, and the other is as
//!   likely.** The sender deleting that name may mean its own row alone, or — if it has since
//!   heard of the delete and folded the pair itself — the one row both became. Nothing on the
//!   wire says which. Addressed to an orphan's uid it takes the orphan's share and leaves the
//!   twin; addressed to the twin's own, while the twin wears it, it takes the whole row, as it
//!   did before the ledger — and an orphan whose twin went so is still built if its parent
//!   returns.
//! - **Nothing clears an entry whose parent never returns.** A row of a few hundred bytes for
//!   each child that met a deleted parent, like `sync_gone`'s own.
//!
//! [sync.md](../../../../docs/reference/sync.md), *A decision resting on `gone` is taken back
//! when the parent returns*, is the record.

use super::*;
use crate::sync_engine::baseline::json_of;
use serde::{Deserialize, Serialize};

/// A row as it would be written: every field its spec lists that is known, its counters as
/// **values**, and each parent by uid — `None` for "nobody".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(super) struct Row {
    #[serde(default)]
    pub fields: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub counters: BTreeMap<String, i64>,
    #[serde(default)]
    pub parents: BTreeMap<String, Option<String>>,
}

/// What a fold changed in a field of the twin: what it read before, and what it reads since.
type Changed = BTreeMap<String, (serde_json::Value, serde_json::Value)>;

/// Where an orphan is while its parent is gone — the module doc's table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(super) enum State {
    /// Here under its own uid, with `key`'s column cleared. `at` is the stamp of the placement
    /// that named the gone parent, so replaying it loses to a later move this device made, as the
    /// op itself would have.
    Placed { key: String, at: Hlc },
    /// Not here. `row` is the row as its sender holds it.
    Absent { row: Row },
    /// Folded into the row [`Entry::twin`] names. `share` is what its ops added to each of the
    /// twin's counters, and `changed` each field they wrote there — what the twin gives back.
    /// `since` is this device's clock when the fold was made: whatever its reader has done since
    /// to a row wearing the orphan's uid went out under that uid, and is the orphan's.
    Folded {
        key: String,
        row: Row,
        #[serde(default)]
        share: BTreeMap<String, i64>,
        #[serde(default)]
        changed: Changed,
        #[serde(default)]
        since: Option<Hlc>,
    },
}

/// One `sync_orphans` row.
#[derive(Debug, Clone)]
pub(super) struct Entry {
    pub table: String,
    pub uid: String,
    pub parent_table: String,
    pub parent_uid: String,
    /// The uid of the row a `Folded` orphan is inside, as that row is called now.
    pub twin: Option<String>,
    /// The twin's own uid, held by the entry of whichever orphan's uid the twin is wearing —
    /// the lowest of its own and those folded into it. The sender still addresses the twin by
    /// it, since over there nothing was folded.
    pub alias: Option<String>,
    pub state: State,
}

/// The two descriptions of one synced table that every function here needs side by side.
#[derive(Clone, Copy)]
pub(super) struct Shape {
    pub meta: &'static Meta,
    pub spec: &'static Spec,
}

impl Shape {
    pub(super) fn of(table: &str) -> Option<Shape> {
        Some(Shape {
            meta: meta_of(table)?,
            spec: spec_of(table)?,
        })
    }

    fn parent(self, key: &str) -> Option<&'static Parent> {
        self.spec.parents.iter().find(|p| p.key == key)
    }
}

const COLUMNS: &str = "tbl, uid, parent_tbl, parent_uid, twin, alias, state";

/// `None` for a state this build cannot read — a newer build's, left where it is.
fn entry_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<Option<Entry>> {
    let state: String = r.get(6)?;
    let Ok(state) = serde_json::from_str(&state) else {
        return Ok(None);
    };
    Ok(Some(Entry {
        table: r.get(0)?,
        uid: r.get(1)?,
        parent_table: r.get(2)?,
        parent_uid: r.get(3)?,
        twin: r.get(4)?,
        alias: r.get(5)?,
        state,
    }))
}

fn entries(conn: &Connection, predicate: &str, values: [&str; 2]) -> Result<Vec<Entry>, String> {
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM sync_orphans WHERE {predicate}"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(values, entry_from)
        .map_err(|e| e.to_string())?;
    let mut out: Vec<Entry> = Vec::new();
    for row in rows {
        out.extend(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// The entry for `table`'s row `uid`, if it is an orphan. Asked of every group, so cached.
pub(super) fn of(conn: &Connection, table: &str, uid: &str) -> Result<Option<Entry>, String> {
    Ok(entries(conn, "tbl = ?1 AND uid = ?2", [table, uid])?.pop())
}

/// The row an op addressed to `uid` belongs to, where `uid` is the name a twin gave up when an
/// orphan was folded into it ([`Entry::alias`]).
pub(super) fn survivor_of(
    conn: &Connection,
    table: &str,
    uid: &str,
) -> Result<Option<String>, String> {
    Ok(entries(conn, "tbl = ?1 AND alias = ?2", [table, uid])?
        .pop()
        .and_then(|e| e.twin))
}

/// Every orphan folded into the row `twin` names.
fn lent_to(conn: &Connection, table: &str, twin: &str) -> Result<Vec<Entry>, String> {
    entries(conn, "tbl = ?1 AND twin = ?2", [table, twin])
}

/// `table`'s row `from` is called `to` from here on, so every orphan folded into it follows.
/// Called wherever a row's uid is written: a grain hit adopting the lower uid, a re-homing
/// doing the same, and a fold being undone.
///
/// **Read through the index and written by key.** An `UPDATE … WHERE twin = ?` cannot use an
/// index on the column it is writing, and this runs on every uid adoption — the commonest thing
/// a first sync does — against a ledger nothing prunes.
pub(super) fn renamed(conn: &Connection, table: &str, from: &str, to: &str) -> Result<(), String> {
    for e in lent_to(conn, table, from)? {
        conn.prepare_cached("UPDATE sync_orphans SET twin = ?3 WHERE tbl = ?1 AND uid = ?2")
            .and_then(|mut stmt| stmt.execute([table, e.uid.as_str(), to]))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The twin's own name, for the entry of an orphan whose uid the twin is about to wear, when
/// until now it wore `was`. That is `was` itself — unless `was` is another orphan's uid, whose
/// entry has been holding the name and hands it on.
fn own_name(conn: &Connection, table: &str, was: &str) -> Result<String, String> {
    match of(conn, table, was)? {
        Some(mut wearer) if wearer.alias.is_some() => {
            let own = wearer.alias.take().unwrap_or_default();
            save(conn, &wearer)?;
            Ok(own)
        }
        _ => Ok(was.to_owned()),
    }
}

fn save(conn: &Connection, e: &Entry) -> Result<(), String> {
    let state = serde_json::to_string(&e.state).map_err(|e| e.to_string())?;
    conn.prepare_cached(&format!(
        "INSERT OR REPLACE INTO sync_orphans ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
    ))
    .and_then(|mut stmt| {
        stmt.execute(rusqlite::params![
            e.table,
            e.uid,
            e.parent_table,
            e.parent_uid,
            e.twin,
            e.alias,
            state
        ])
    })
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub(super) fn forget(conn: &Connection, table: &str, uid: &str) -> Result<(), String> {
    conn.prepare_cached("DELETE FROM sync_orphans WHERE tbl = ?1 AND uid = ?2")
        .and_then(|mut stmt| stmt.execute([table, uid]))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Record that `table`'s row `uid` is here without `p`'s parent, which is gone.
pub(super) fn place(
    conn: &Connection,
    table: &str,
    uid: &str,
    (p, parent_uid): (&Parent, &str),
    at: Hlc,
) -> Result<(), String> {
    save(
        conn,
        &Entry {
            table: table.to_owned(),
            uid: uid.to_owned(),
            parent_table: p.table.to_owned(),
            parent_uid: parent_uid.to_owned(),
            twin: None,
            alias: None,
            state: State::Placed {
                key: p.key.to_owned(),
                at,
            },
        },
    )
}

/// What one write took a twin from and to: each counter's difference onto `share`, and each
/// field that reads differently into `changed` — keeping the first "before" a field ever had,
/// so several writes still give back what was there before the first.
fn took(before: &Row, after: &Row, share: &mut BTreeMap<String, i64>, changed: &mut Changed) {
    for (name, now) in &after.counters {
        let more = now - before.counters.get(name).copied().unwrap_or(0);
        if more != 0 {
            *share.entry(name.clone()).or_insert(0) += more;
        }
    }
    for (name, now) in &after.fields {
        let was = before.fields.get(name);
        if was == Some(now) {
            continue;
        }
        match changed.get_mut(name) {
            Some((_, made)) => *made = now.clone(),
            None => {
                let was = was.cloned().unwrap_or(serde_json::Value::Null);
                changed.insert(name.clone(), (was, now.clone()));
            }
        }
    }
}

/// Record that the row `g` describes was folded into the twin now wearing `into`, which read
/// `before` when the fold found it and wore `own`.
pub(super) fn fold_into(
    conn: &Connection,
    shape: Shape,
    g: &Group,
    (p, parent_uid): (&Parent, &str),
    (own, into, before): (&str, &str, &Row),
) -> Result<(), String> {
    let Shape { meta, spec } = shape;
    let after = row_of(conn, spec, into)?.unwrap_or_default();
    let (mut share, mut changed) = (BTreeMap::new(), Changed::new());
    took(before, &after, &mut share, &mut changed);
    save(
        conn,
        &Entry {
            table: meta.table.to_owned(),
            uid: g.ops[0].uid.clone(),
            parent_table: p.table.to_owned(),
            parent_uid: parent_uid.to_owned(),
            twin: Some(into.to_owned()),
            alias: match own != into {
                true => Some(own_name(conn, meta.table, own)?),
                false => None,
            },
            state: State::Folded {
                key: p.key.to_owned(),
                row: row_from_fold(meta, spec, g, &g.resolved),
                share,
                changed,
                since: Some(now(conn)?),
            },
        },
    )
}

/// Whether `g` is [`restore`]'s own put: a whole row under the stamp no device issues.
pub(super) fn is_a_meeting(g: &Group) -> bool {
    matches!(g.ops.as_slice(), [op] if op.at.ms == 0 && op.at.device.is_empty())
}

/// A stamp of this device's own clock, taken now: above everything it has written and below
/// everything it writes next, which is where a placement `apply` made on its own sits.
pub(super) fn now(conn: &Connection) -> Result<Hlc, String> {
    let (ms, ctr) = emission::tick(conn).map_err(|e| e.to_string())?;
    let device: Option<String> = conn
        .query_row(
            "SELECT device_id FROM sync_identity WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(Hlc {
        ms,
        ctr,
        device: device.unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------------------
// A row, read and written whole
// ---------------------------------------------------------------------------------------

/// `spec`'s row matching `predicate`, as it stands: the capture trigger's insert op without the
/// stamp, a parent by its uid.
fn row_where(
    conn: &Connection,
    spec: &Spec,
    predicate: &str,
    value: &dyn rusqlite::ToSql,
) -> Result<Option<Row>, String> {
    let mut cols: Vec<String> = Vec::new();
    for f in spec.fields {
        cols.push(format!("t.{f}"));
    }
    for c in spec.counters {
        cols.push(format!("t.{c}"));
    }
    for p in spec.parents {
        cols.push(format!(
            "(SELECT p.sync_uid FROM {} p WHERE p.id = t.{})",
            p.table, p.col
        ));
    }
    let sql = format!(
        "SELECT {} FROM {} t WHERE {predicate}",
        cols.join(", "),
        spec.table
    );
    conn.query_row(&sql, [value], |r| {
        let mut row = Row::default();
        for (i, name) in spec.fields.iter().enumerate() {
            row.fields
                .insert((*name).to_owned(), json_of(r.get_ref(i)?));
        }
        let base = spec.fields.len();
        for (i, name) in spec.counters.iter().enumerate() {
            row.counters.insert((*name).to_owned(), r.get(base + i)?);
        }
        let base = base + spec.counters.len();
        for (i, p) in spec.parents.iter().enumerate() {
            row.parents.insert(p.key.to_owned(), r.get(base + i)?);
        }
        Ok(row)
    })
    .optional()
    .map_err(|e| e.to_string())
}

pub(super) fn row_of(conn: &Connection, spec: &Spec, uid: &str) -> Result<Option<Row>, String> {
    row_where(conn, spec, "t.sync_uid = ?1", &uid)
}

/// The row a group would build where none is here — `insert_row`'s reading of the fold, with the
/// parents left as the uids the ops named.
fn row_from_fold(meta: &Meta, spec: &Spec, g: &Group, combined: &Resolved) -> Row {
    let mut row = Row::default();
    for f in spec.fields {
        if let Some((v, _)) = combined.fields.get(*f) {
            row.fields.insert((*f).to_owned(), v.clone());
        }
    }
    for p in spec.parents {
        let named = g
            .resolved
            .parents
            .get(p.key)
            .or_else(|| combined.parents.get(p.key));
        if let Some((uid, _)) = named {
            row.parents.insert(p.key.to_owned(), uid.clone());
        }
    }
    for (name, _) in meta.counters {
        let sum = combined.counters.get(*name).copied().unwrap_or(0);
        row.counters.insert(
            (*name).to_owned(),
            match combined.claims.get(*name).copied() {
                Some(claim) => sum.max(claim),
                None => sum,
            },
        );
    }
    row
}

/// Lay a group over a row as `update_row` would write it: each field and parent the incoming
/// ops won against this device's own history, each counter's delta, a claim as a floor.
fn overlay(row: &mut Row, shape: Shape, g: &Group, combined: &Resolved) {
    let Shape { meta, spec } = shape;
    for f in spec.fields {
        if let (Some((v, incoming)), Some((_, winner))) =
            (g.resolved.fields.get(*f), combined.fields.get(*f))
        {
            if incoming == winner {
                row.fields.insert((*f).to_owned(), v.clone());
            }
        }
    }
    for p in spec.parents {
        if let (Some((uid, incoming)), Some((_, winner))) =
            (g.resolved.parents.get(p.key), combined.parents.get(p.key))
        {
            if incoming == winner {
                row.parents.insert(p.key.to_owned(), uid.clone());
            }
        }
    }
    for (name, floor) in meta.counters {
        let delta = g.resolved.counters.get(*name).copied().unwrap_or(0);
        let claim = g.resolved.claims.get(*name).copied();
        if delta == 0 && claim.is_none() {
            continue;
        }
        let current = row.counters.get(*name).copied().unwrap_or(0);
        let next = match claim {
            Some(c) => (current + delta).max(c),
            None => current + delta,
        };
        row.counters.insert(
            (*name).to_owned(),
            match floor {
                Floor::Clamp => next.max(0),
                Floor::DeleteAtZero => next,
            },
        );
    }
}

/// The fold of a group with this device's own ops for the row `uid` names, and for no other —
/// what the group's ops won and lost against what this device did *to that row*.
pub(super) fn folded_with_history(
    conn: &Connection,
    table: &str,
    uid: &str,
    g: &Group,
) -> Result<Resolved, String> {
    let mut all: Vec<Op> = g.ops.iter().map(|o| (*o).clone()).collect();
    all.extend(local_history(conn, table, &[uid.to_owned()])?);
    Ok(fold(&all))
}

/// Whether a counter that is not a row at zero has reached it — the row would have gone.
fn emptied(row: &Row, meta: &Meta) -> bool {
    meta.counters.iter().any(|(name, floor)| {
        *floor == Floor::DeleteAtZero && row.counters.get(*name).is_some_and(|v| *v <= 0)
    })
}

/// A parent's local id. Every table a spec names as a parent has one.
fn id_of(conn: &Connection, table: &str, uid: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        &format!("SELECT id FROM {table} WHERE sync_uid = ?1"),
        [uid],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn uid_by_id(conn: &Connection, table: &str, id: i64) -> Result<Option<String>, String> {
    conn.query_row(
        &format!("SELECT sync_uid FROM {table} WHERE id = ?1"),
        [id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(|e| e.to_string())
}

/// Whether a row wears `uid` — `1` and not `id`, which two synced tables do not have.
fn here(conn: &Connection, table: &str, uid: &str) -> Result<bool, String> {
    conn.query_row(
        &format!("SELECT 1 FROM {table} WHERE sync_uid = ?1"),
        [uid],
        |_| Ok(()),
    )
    .optional()
    .map(|hit| hit.is_some())
    .map_err(|e| e.to_string())
}

/// The parent a row still cannot be built without: one its ops name, whose key cascades, and
/// which is not here.
fn waits_on(
    conn: &Connection,
    shape: Shape,
    row: &Row,
) -> Result<Option<(&'static str, String)>, String> {
    let Shape { meta, spec } = shape;
    for p in spec.parents.iter().filter(|p| !p.soft) {
        let Some(Some(uid)) = row.parents.get(p.key) else {
            continue;
        };
        if id_of(conn, p.table, uid)?.is_none() && cascades(conn, meta.table, p)? {
            return Ok(Some((p.table, uid.clone())));
        }
    }
    Ok(None)
}

/// Write one op as a page of its own would be written, on a pass that decides everything. A
/// group the write path does not write is this function's `Err`, in the path's own words.
fn write_one(conn: &Connection, op: &Op, deleted: &BTreeSet<(&str, &str)>) -> Result<(), String> {
    let groups = group(&[op]);
    let mut report = ApplyReport::default();
    let mut soft: Vec<(&Group, String)> = Vec::new();
    // No row is one "the page places": this op is the ledger's own, not a page's.
    let placed: BTreeSet<(&str, &str)> = BTreeSet::new();
    for g in &groups {
        if let Outcome::Deferred(why) = write_group(
            conn,
            g,
            &mut report,
            &mut soft,
            deleted,
            &placed,
            Attempt::Clear,
        )? {
            return Err(why.text());
        }
    }
    for (g, uid) in &soft {
        settle_soft_parents(conn, g, uid)?;
    }
    Ok(())
}

/// The id of the row on `grain` where `row` would land under `parents` — `find_row`'s lookup,
/// asked of a whole row rather than a group, and optionally of every row but `except`.
fn twin_on(
    conn: &Connection,
    meta: &Meta,
    grain: &Grain,
    (row, parents): (&Row, &BTreeMap<&'static str, Sql>),
    except: Option<i64>,
) -> Result<Option<i64>, String> {
    let mut values: Vec<Sql> = Vec::with_capacity(grain.sources.len() + 1);
    for source in grain.sources {
        match source {
            Source::Field(f) => match row.fields.get(*f) {
                Some(v) => values.push(sql_value(v)),
                None => return Ok(None),
            },
            Source::Parent(key) => values.push(parents.get(key).cloned().unwrap_or(Sql::Null)),
        }
    }
    let mut sql = format!("SELECT id FROM {} WHERE {}", meta.table, grain.predicate);
    if let Some(id) = except {
        sql.push_str(" AND id <> ?");
        values.push(Sql::Integer(id));
    }
    conn.query_row(&sql, rusqlite::params_from_iter(values.iter()), |r| {
        r.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

/// Build `row` under `uid`, now that [`waits_on`] finds nothing it waits on.
///
/// **Written as it stands, counters included**, where a row built from ops takes its count from
/// the fold: the entry is the only account of this row there is, and this device's own log holds
/// only its own share of the count. A `SET NULL` parent that is not here leaves its column clear
/// and a `Placed` entry of its own.
///
/// **Where a row is already on its grain**, the two are two rows meeting, and that is the write
/// path's to answer: the count is added, the lower uid kept — and where the grain is the root's
/// because the parent is still gone, the row is folded and the ledger told again. So it goes
/// there as one put carrying the whole row, its counters as deltas, under a stamp below every
/// real one — which leaves the row already there its own fields wherever this device wrote them.
fn restore(
    conn: &Connection,
    shape: Shape,
    uid: &str,
    row: &Row,
    deleted: &BTreeSet<(&str, &str)>,
) -> Result<(), String> {
    let Shape { meta, spec } = shape;
    if here(conn, meta.table, uid)? {
        return Ok(());
    }
    let mut parents: BTreeMap<&'static str, Sql> = BTreeMap::new();
    let mut unplaced: Vec<(&Parent, String)> = Vec::new();
    for p in spec.parents {
        let value = match row.parents.get(p.key).cloned().flatten() {
            None => absent_value(p),
            Some(named) => match id_of(conn, p.table, &named)? {
                Some(id) => Sql::Integer(id),
                None => {
                    if !p.soft {
                        unplaced.push((p, named));
                    }
                    absent_value(p)
                }
            },
        };
        parents.insert(p.key, value);
    }
    for grain in meta.grains {
        if twin_on(conn, meta, grain, (row, &parents), None)?.is_some() {
            let meeting = Op {
                table: meta.table.to_owned(),
                uid: uid.to_owned(),
                kind: Kind::Put,
                fields: row.fields.clone(),
                counters: row.counters.clone(),
                parents: row.parents.clone(),
                at: Hlc {
                    ms: 0,
                    ctr: 0,
                    device: String::new(),
                },
                baseline: false,
                horizon: None,
                schema: None,
                emission: None,
            };
            return write_one(conn, &meeting, deleted);
        }
    }

    let mut cols: Vec<String> = vec!["sync_uid".to_owned()];
    let mut vals: Vec<Sql> = vec![Sql::Text(uid.to_owned())];
    for f in spec.fields {
        if let Some(v) = row.fields.get(*f) {
            cols.push((*f).to_owned());
            vals.push(sql_value(v));
        }
    }
    for p in spec.parents {
        cols.push(p.col.to_owned());
        vals.push(parents.get(p.key).cloned().unwrap_or(Sql::Null));
    }
    for (name, _) in meta.counters {
        cols.push((*name).to_owned());
        vals.push(Sql::Integer(row.counters.get(*name).copied().unwrap_or(0)));
    }
    let mut holes: Vec<String> = (1..=vals.len()).map(|i| format!("?{i}")).collect();
    if meta.timestamps {
        cols.push("created_at".to_owned());
        cols.push("updated_at".to_owned());
        holes.push("unixepoch()".to_owned());
        holes.push("unixepoch()".to_owned());
    }
    conn.execute(
        &format!(
            "INSERT INTO {} ({}) VALUES ({})",
            meta.table,
            cols.join(", "),
            holes.join(", ")
        ),
        rusqlite::params_from_iter(vals.iter()),
    )
    .map_err(|e| e.to_string())?;
    for (p, named) in unplaced {
        place(conn, meta.table, uid, (p, &named), now(conn)?)?;
    }
    Ok(())
}

/// What this device's reader did to a merged row while it wore a folded orphan's uid: those
/// edits went out under that uid, and on the sender — which folded nothing — they landed on the
/// orphan's own row. So when the fold is undone they are the orphan's here too.
#[derive(Default)]
struct Readers {
    counters: BTreeMap<String, i64>,
    fields: BTreeMap<String, serde_json::Value>,
}

impl Readers {
    fn onto(self, row: &mut Row) {
        for (name, n) in self.counters {
            *row.counters.entry(name).or_insert(0) += n;
        }
        row.fields.extend(self.fields);
    }
}

/// This device's own ops under a folded orphan's uid, made since the fold.
fn readers_edits(conn: &Connection, table: &str, e: &Entry) -> Result<Readers, String> {
    let State::Folded {
        since: Some(since), ..
    } = &e.state
    else {
        return Ok(Readers::default());
    };
    let ops: Vec<Op> = local_history(conn, table, std::slice::from_ref(&e.uid))?
        .into_iter()
        .filter(|op| op.kind == Kind::Put && op.at > *since)
        .collect();
    let made = fold(&ops);
    Ok(Readers {
        counters: made.counters,
        fields: made.fields.into_iter().map(|(k, (v, _))| (k, v)).collect(),
    })
}

/// Take back out of a twin what a fold put into it: each counter's share, every field the fold
/// wrote that still reads as it left it, what this device's reader did to the row under the
/// orphan's name — answered, for the caller to lay over the orphan's row — and the name.
///
/// **The twin wears the lowest uid of its own and those still folded into it**, which is what
/// the sender's re-homing would call the pair if their parents stayed gone. So when the orphan
/// whose uid it wears leaves, it takes the next lowest: its own, or another orphan's — whose
/// entry then holds the twin's own name. An orphan that leaves while the twin wears some lower
/// uid changes no name at all.
fn unfold(conn: &Connection, shape: Shape, e: &Entry) -> Result<Readers, String> {
    let Shape { meta, spec } = shape;
    let (State::Folded { share, changed, .. }, Some(twin)) = (&e.state, &e.twin) else {
        return Ok(Readers::default());
    };
    let rusq = |e: rusqlite::Error| e.to_string();
    emission::unretire(conn, meta.table, &e.uid).map_err(rusq)?;
    let Some(now) = row_of(conn, spec, twin)? else {
        return Ok(Readers::default());
    };
    let readers = readers_edits(conn, meta.table, e)?;
    let mut sets: Vec<String> = Vec::new();
    let mut vals: Vec<Sql> = Vec::new();
    // The names are read back out of the ledger, so only one this build's spec spells is ever
    // put into a statement.
    for f in spec.fields {
        if let Some((was, made)) = changed.get(*f) {
            if now.fields.get(*f) == Some(made) {
                vals.push(sql_value(was));
                sets.push(format!("{f} = ?{}", vals.len()));
            }
        }
    }
    let mut gone = false;
    for (name, floor) in meta.counters {
        let leaves = share.get(*name).copied().unwrap_or(0)
            + readers.counters.get(*name).copied().unwrap_or(0);
        if leaves == 0 {
            continue;
        }
        let left = now.counters.get(*name).copied().unwrap_or(0) - leaves;
        gone |= *floor == Floor::DeleteAtZero && left <= 0;
        vals.push(Sql::Integer(left.max(0)));
        sets.push(format!("{name} = ?{}", vals.len()));
    }
    if gone {
        conn.execute(
            &format!("DELETE FROM {} WHERE sync_uid = ?1", meta.table),
            [twin.as_str()],
        )
        .map_err(rusq)?;
        return Ok(readers);
    }
    // The name the row goes on under, where it is this orphan's that it wears.
    let mut next: Option<String> = None;
    if *twin == e.uid {
        let others = lent_to(conn, meta.table, twin)?;
        next = others
            .iter()
            .filter(|other| other.uid != e.uid)
            .map(|other| other.uid.clone())
            .chain(e.alias.clone())
            .min();
        let Some(next) = &next else {
            return Err("a twin wearing its orphan's uid has no name of its own".into());
        };
        vals.push(Sql::Text(next.clone()));
        sets.push(format!("sync_uid = ?{}", vals.len()));
    }
    if !sets.is_empty() {
        if meta.timestamps {
            sets.push("updated_at = unixepoch()".to_owned());
        }
        vals.push(Sql::Text(twin.clone()));
        conn.execute(
            &format!(
                "UPDATE {} SET {} WHERE sync_uid = ?{}",
                meta.table,
                sets.join(", "),
                vals.len()
            ),
            rusqlite::params_from_iter(vals.iter()),
        )
        .map_err(rusq)?;
    }
    if let Some(next) = next {
        renamed(conn, meta.table, &e.uid, &next)?;
        emission::unretire(conn, meta.table, &next).map_err(rusq)?;
        // Another orphan's uid: its entry holds the twin's own name from here on.
        if e.alias.as_deref() != Some(next.as_str()) {
            if let Some(mut wearer) = of(conn, meta.table, &next)? {
                wearer.alias = e.alias.clone();
                save(conn, &wearer)?;
            }
        }
    }
    Ok(readers)
}

/// Take every orphan folded into the row `uid` names back out of it, and put each where a row
/// without its parent goes — alone at the root, or into whatever holds its grain there now.
///
/// **For a row that has just left the root's grain.** Those orphans were lent to the *place*,
/// not to the row: their own parents are still gone, and on the sender — once the deletes
/// reach it — they are at the root, where this row no longer is. A `Placed` row going back to
/// its parent leaves them so, and so does a twin its own device moved into a binder.
pub(super) fn leave_behind(
    conn: &Connection,
    shape: Shape,
    uid: &str,
    deleted: &BTreeSet<(&str, &str)>,
) -> Result<(), String> {
    for inner in lent_to(conn, shape.meta.table, uid)? {
        // Read again: undoing one fold can rename the row the next is folded into.
        let Some(inner) = of(conn, &inner.table, &inner.uid)? else {
            continue;
        };
        let State::Folded { row, .. } = &inner.state else {
            continue;
        };
        let mut row = row.clone();
        forget(conn, &inner.table, &inner.uid)?;
        unfold(conn, shape, &inner)?.onto(&mut row);
        restore(conn, shape, &inner.uid, &row, deleted)?;
    }
    Ok(())
}

/// [`leave_behind`], if the row `uid` names has anything folded into it and is under a parent
/// by `key` — asked after a write that named `key`, which is the only thing that can have moved
/// it off the root.
pub(super) fn leave_behind_if_moved(
    conn: &Connection,
    shape: Shape,
    (uid, key): (&str, &str),
    deleted: &BTreeSet<(&str, &str)>,
) -> Result<(), String> {
    if lent_to(conn, shape.meta.table, uid)?.is_empty() {
        return Ok(());
    }
    let under = row_of(conn, shape.spec, uid)?
        .is_some_and(|row| matches!(row.parents.get(key), Some(Some(_))));
    match under {
        true => leave_behind(conn, shape, uid, deleted),
        false => Ok(()),
    }
}

/// A delete addressed to the name a twin gave up to a fold. **It is not ambiguous**: the sender
/// can only delete that name while it is still a row there, which is while it has folded
/// nothing — so it deleted the twin and still holds every orphan that is folded into it here.
/// The merged row goes, and each orphan is put back as a row of its own, without its parent.
///
/// Answers whether there was such a twin. Not where this device's own later edit to the twin
/// outlives the delete: add-wins keeps the row then, as it would any other.
pub(super) fn twin_deleted(
    conn: &Connection,
    shape: Shape,
    g: &Group,
    deleted: &BTreeSet<(&str, &str)>,
) -> Result<bool, String> {
    let table = shape.meta.table;
    let uid = &g.ops[0].uid;
    let Some(twin) = survivor_of(conn, table, uid)? else {
        return Ok(false);
    };
    if !folded_with_history(conn, table, uid, g)?.deleted {
        return Ok(false);
    }
    let done = in_savepoint(conn, || {
        let mut back: Vec<(String, Row)> = Vec::new();
        for e in lent_to(conn, table, &twin)? {
            if let State::Folded { row, .. } = &e.state {
                let mut row = row.clone();
                readers_edits(conn, table, &e)?.onto(&mut row);
                back.push((e.uid.clone(), row));
            }
            forget(conn, &e.table, &e.uid)?;
            emission::unretire(conn, table, &e.uid).map_err(|e| e.to_string())?;
        }
        conn.execute(
            &format!("DELETE FROM {table} WHERE sync_uid = ?1"),
            [twin.as_str()],
        )
        .map_err(|e| e.to_string())?;
        for (uid, row) in &back {
            restore(conn, shape, uid, row, deleted)?;
        }
        Ok(())
    })?;
    Ok(done.is_ok())
}

/// Take out of `counters` — a row's own, read off the table — what other orphans folded into
/// that row put there: what is left is the row's own count.
fn without_what_was_lent(
    conn: &Connection,
    table: &str,
    uid: &str,
    counters: &mut BTreeMap<String, i64>,
) -> Result<(), String> {
    for inner in lent_to(conn, table, uid)? {
        if let State::Folded { share, .. } = &inner.state {
            for (name, n) in share {
                if let Some(held) = counters.get_mut(name) {
                    *held -= n;
                }
            }
        }
    }
    Ok(())
}

/// Fold an orphan that has no row of its own any more into the row `onto` names: its count
/// added, and the entry written. What a re-homing's merge does, for the two places a merge
/// cannot be used — the orphan's row is already gone, or `onto` must keep its name.
///
/// **The lower uid wins, as wherever two rows meet.** A `Placed` row is never renamed, because
/// the ledger knows it by its uid: every caller folds the higher of two orphans into the lower,
/// and the guard below only keeps a mistake in that from turning one entry's row into another's.
///
/// What had been folded into the orphan stays folded, into `onto` now, and is no part of the
/// share written here.
pub(super) fn lend(
    conn: &Connection,
    shape: Shape,
    (uid, mut row): (&str, Row),
    (p, parent_uid): (&Parent, &str),
    onto: &str,
) -> Result<(), String> {
    let table = shape.meta.table;
    // The whole of what the orphan's row held goes into `onto`; its own part of that is the
    // share, and its would-be row.
    let held = row.counters.clone();
    without_what_was_lent(conn, table, uid, &mut row.counters)?;
    let mut share: BTreeMap<String, i64> = BTreeMap::new();
    let mut sets: Vec<String> = Vec::new();
    let mut vals: Vec<Sql> = Vec::new();
    for (name, _) in shape.meta.counters {
        let n = held.get(*name).copied().unwrap_or(0);
        if n != 0 {
            vals.push(Sql::Integer(n));
            sets.push(format!("{name} = {name} + ?{}", vals.len()));
        }
        let own = row.counters.get(*name).copied().unwrap_or(0);
        if own != 0 {
            share.insert((*name).to_owned(), own);
        }
    }
    if !sets.is_empty() {
        if shape.meta.timestamps {
            sets.push("updated_at = unixepoch()".to_owned());
        }
        vals.push(Sql::Text(onto.to_owned()));
        conn.execute(
            &format!(
                "UPDATE {table} SET {} WHERE sync_uid = ?{}",
                sets.join(", "),
                vals.len()
            ),
            rusqlite::params_from_iter(vals.iter()),
        )
        .map_err(|e| e.to_string())?;
    }
    let rusq = |e: rusqlite::Error| e.to_string();
    let placed = matches!(
        of(conn, table, onto)?.map(|e| e.state),
        Some(State::Placed { .. })
    );
    let (twin, alias) = if uid >= onto || placed {
        emission::retire(conn, table, uid, onto).map_err(rusq)?;
        renamed(conn, table, uid, onto)?;
        (onto.to_owned(), None)
    } else {
        conn.execute(
            &format!("UPDATE {table} SET sync_uid = ?1 WHERE sync_uid = ?2"),
            [uid, onto],
        )
        .map_err(rusq)?;
        let own = own_name(conn, table, onto)?;
        renamed(conn, table, onto, uid)?;
        emission::retire(conn, table, onto, uid).map_err(rusq)?;
        (uid.to_owned(), Some(own))
    };
    save(
        conn,
        &Entry {
            table: table.to_owned(),
            uid: uid.to_owned(),
            parent_table: p.table.to_owned(),
            parent_uid: parent_uid.to_owned(),
            twin: Some(twin),
            alias,
            state: State::Folded {
                key: p.key.to_owned(),
                row,
                share,
                changed: Changed::new(),
                since: Some(now(conn)?),
            },
        },
    )
}

/// File the copy or wish `id` at the root because the parent `p` names is gone, and write down
/// what that did: `Placed` where the root's grain was free, `Folded` where a twin held it.
///
/// The merge is the crate's own, through [`rehome::rehome_one`] — except onto a twin that is
/// itself an orphan, which must keep its name ([`lend`]).
pub(super) fn settle(
    conn: &Connection,
    shape: Shape,
    id: i64,
    (p, parent_uid): (&Parent, &str),
    at: Hlc,
) -> Result<(), String> {
    let Shape { meta, spec } = shape;
    let table = meta.table;
    let (Some(uid), Some(mut row)) = (
        uid_by_id(conn, table, id)?,
        row_where(conn, spec, "t.id = ?1", &id)?,
    ) else {
        // A row with no name is one this device derived for itself: nobody can ask for it back.
        return rehome::rehome_one(conn, table, id).map(|_| ());
    };
    row.parents
        .insert(p.key.to_owned(), Some(parent_uid.to_owned()));
    let root: BTreeMap<&'static str, Sql> = BTreeMap::new();
    let mut twin: Option<i64> = None;
    for grain in meta.grains {
        twin = twin_on(conn, meta, grain, (&row, &root), Some(id))?;
        if twin.is_some() {
            break;
        }
    }
    let Some(twin) = twin else {
        rehome::rehome_one(conn, table, id)?;
        return place(conn, table, &uid, (p, parent_uid), at);
    };
    let own = uid_by_id(conn, table, twin)?;
    // **A twin that is itself `Placed` is never renamed** — the ledger knows it by its uid — so
    // the two are folded by hand, the higher uid into the lower: this row into the twin, or the
    // twin, stepping aside, into this row once it is at the root.
    if let Some(own) = &own {
        if let Some((theirs, their_row)) = placed_on_the_grain(conn, shape, own)? {
            if uid > *own {
                conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [id])
                    .map_err(|e| e.to_string())?;
                return lend(conn, shape, (&uid, row), (p, parent_uid), own);
            }
            step_aside(conn, &theirs)?;
            rehome::rehome_one(conn, table, id)?;
            place(conn, table, &uid, (p, parent_uid), at)?;
            return step_back(conn, shape, (&theirs, their_row), &uid);
        }
    }
    let before = row_where(conn, spec, "t.id = ?1", &twin)?.unwrap_or_default();
    // What other orphans had folded into the row that moves is theirs, not its own.
    let mut lent = row.counters.clone();
    without_what_was_lent(conn, table, &uid, &mut row.counters)?;
    for (name, own) in &row.counters {
        if let Some(n) = lent.get_mut(name) {
            *n -= own;
        }
    }
    let kept = rehome::rehome_one(conn, table, id)?;
    let Some(into) = uid_by_id(conn, table, kept)? else {
        return Ok(());
    };
    // Whatever was folded into the row that moved is inside the survivor now.
    if into != uid {
        renamed(conn, table, &uid, &into)?;
    }
    let after = row_of(conn, spec, &into)?.unwrap_or_default();
    let (mut share, mut changed) = (BTreeMap::new(), Changed::new());
    took(&before, &after, &mut share, &mut changed);
    for (name, n) in &lent {
        if let Some(held) = share.get_mut(name) {
            *held -= n;
        }
    }
    save(
        conn,
        &Entry {
            table: table.to_owned(),
            uid,
            parent_table: p.table.to_owned(),
            parent_uid: parent_uid.to_owned(),
            alias: match own {
                Some(own) if own != into => Some(own_name(conn, table, &own)?),
                _ => None,
            },
            twin: Some(into),
            state: State::Folded {
                key: p.key.to_owned(),
                row,
                share,
                changed,
                since: Some(now(conn)?),
            },
        },
    )
}

/// The uid of the row on the grain where `g` would land the row `uid` names — what refused the
/// write, when a unique index did. `parents` is the write's own resolution of the parents the
/// group names; the others are the row's as they stand.
pub(super) fn in_the_way(
    conn: &Connection,
    shape: Shape,
    g: &Group,
    uid: &str,
    parents: &BTreeMap<&'static str, Sql>,
) -> Result<Option<String>, String> {
    let Shape { meta, spec } = shape;
    let (Some(id), Some(mut row)) = (id_of(conn, meta.table, uid)?, row_of(conn, spec, uid)?)
    else {
        return Ok(None);
    };
    for (name, (v, _)) in &g.resolved.fields {
        row.fields.insert(name.clone(), v.clone());
    }
    let mut landing: BTreeMap<&'static str, Sql> = BTreeMap::new();
    for p in spec.parents {
        let value = if g.resolved.parents.contains_key(p.key) {
            parents.get(p.key).cloned().unwrap_or(Sql::Null)
        } else {
            match row.parents.get(p.key).cloned().flatten() {
                Some(named) => id_of(conn, p.table, &named)?.map_or(Sql::Null, Sql::Integer),
                None => absent_value(p),
            }
        };
        landing.insert(p.key, value);
    }
    for grain in meta.grains {
        if let Some(found) = twin_on(conn, meta, grain, (&row, &landing), Some(id))? {
            return uid_by_id(conn, meta.table, found);
        }
    }
    Ok(None)
}

/// The `Placed` orphan wearing `uid`, where it sits on a grain only because its parent is gone
/// — with its row as it would be under that parent. A row about to land on it has the better
/// claim to the place: the orphan is [`step_aside`]'d, and [`lend`]ed to the newcomer.
pub(super) fn placed_on_the_grain(
    conn: &Connection,
    shape: Shape,
    uid: &str,
) -> Result<Option<(Entry, Row)>, String> {
    let Some(e) = of(conn, shape.meta.table, uid)? else {
        return Ok(None);
    };
    let State::Placed { key, .. } = &e.state else {
        return Ok(None);
    };
    if !grain_carries(shape.meta, key) {
        return Ok(None);
    }
    let Some(mut row) = row_of(conn, shape.spec, uid)? else {
        return Ok(None);
    };
    row.parents.insert(key.clone(), Some(e.parent_uid.clone()));
    Ok(Some((e, row)))
}

/// Take a `Placed` orphan's row out of the table, its entry with it: [`placed_on_the_grain`]
/// has read it, and [`step_back`] folds it into whatever lands where it was.
pub(super) fn step_aside(conn: &Connection, e: &Entry) -> Result<(), String> {
    let Some(shape) = Shape::of(&e.table) else {
        return Ok(());
    };
    conn.execute(
        &format!("DELETE FROM {} WHERE sync_uid = ?1", shape.meta.table),
        [e.uid.as_str()],
    )
    .map_err(|e| e.to_string())?;
    forget(conn, &e.table, &e.uid)
}

/// A row that a group lands, without its gone parent, on the grain the row `holder` names is
/// on: take it out, lay the group over the row it would be, and fold it into `holder` —
/// `Folded`, resting on that parent. Two ways there, and one refusal: a copy both devices hold
/// that is **moved** under a parent deleted here, and a copy already `Placed` that an **edit**
/// lands on another row's grain.
///
/// The same refusal `apply`'s own merge answers for two rows that are both here to stay
/// (`fold_onto_the_holder`). An orphan cannot go through that one: it would leave nothing to
/// take the fold back by when the parent returns, and a `Placed` entry naming a row that is no
/// longer its own.
pub(super) fn fold_the_orphan(
    conn: &Connection,
    shape: Shape,
    g: &Group,
    (uid, holder): (&str, &str),
    (p, parent_uid): (&Parent, &str),
) -> Result<(), String> {
    let table = shape.meta.table;
    let Some(mut row) = row_of(conn, shape.spec, uid)? else {
        return Err("no row to fold".to_owned());
    };
    let combined = folded_with_history(conn, table, uid, g)?;
    overlay(&mut row, shape, g, &combined);
    row.parents
        .insert(p.key.to_owned(), Some(parent_uid.to_owned()));
    conn.execute(&format!("DELETE FROM {table} WHERE sync_uid = ?1"), [uid])
        .map_err(|e| e.to_string())?;
    forget(conn, table, uid)?;
    lend(conn, shape, (uid, row), (p, parent_uid), holder)
}

/// Fold an orphan that [`step_aside`] took out into the row now on its grain.
pub(super) fn step_back(
    conn: &Connection,
    shape: Shape,
    (e, row): (&Entry, Row),
    onto: &str,
) -> Result<(), String> {
    let State::Placed { key, .. } = &e.state else {
        return Ok(());
    };
    match shape.parent(key) {
        Some(p) => lend(conn, shape, (&e.uid, row), (p, &e.parent_uid), onto),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------------------
// Recording: the moot arm
// ---------------------------------------------------------------------------------------

/// The tables [`rehome`] files at the root row by row, which [`bury_under`] therefore leaves to
/// [`rehome_recording`].
const REHOMED: [&str; 2] = ["collection_entries", "wishlist_entries"];

/// Record what the moot arm is about to do to `g`'s row, and to everything the delete takes
/// with it — called inside the moot delete's savepoint, before the `DELETE`, and in place of
/// [`rehome::rehome`], whose work it does a row at a time.
///
/// - **The row itself** becomes `Absent`, resting on the gone parent `p` names: as it stands
///   here with the group laid over it, or as the group alone describes it where this device
///   never held it.
/// - **Every row the delete's cascade takes** — a folder's sub-tree — becomes `Absent` under
///   the row it hangs off, so they come back in order, each when the one above it has.
/// - **Every row the delete would clear** becomes `Placed` under its folder — or `Folded`,
///   where filing it at the root landed it on a twin.
pub(super) fn bury(
    conn: &Connection,
    shape: Shape,
    g: &Group,
    combined: &Resolved,
    (p, gone_uid): (&Parent, &str),
    doomed: &rehome::Doomed,
) -> Result<(), String> {
    let Shape { meta, spec } = shape;
    let uid = &g.ops[0].uid;
    // A row its own device deleted in the same breath — a put and its delete in one page, both
    // naming the parent — is going for good, and so is everything under it: nothing is written
    // down, and the re-homing is the delete arm's own.
    if combined.deleted {
        return rehome::rehome(conn, doomed);
    }
    let row = match row_of(conn, spec, uid)? {
        Some(mut row) => {
            overlay(&mut row, shape, g, combined);
            let mut walked: BTreeSet<(&'static str, String)> = BTreeSet::new();
            walked.insert((meta.table, uid.clone()));
            bury_under(conn, meta.table, uid, &mut walked)?;
            rehome_recording(conn, doomed)?;
            row
        }
        None => row_from_fold(meta, spec, g, combined),
    };
    if emptied(&row, meta) {
        return Ok(());
    }
    save(
        conn,
        &Entry {
            table: meta.table.to_owned(),
            uid: uid.clone(),
            parent_table: p.table.to_owned(),
            parent_uid: gone_uid.to_owned(),
            twin: None,
            alias: None,
            state: State::Absent { row },
        },
    )
}

/// Every row filed under `table`'s row `uid`, by any key any spec names: `Absent` where the key
/// cascades, and then whatever is filed under *it*; `Placed` where the key is `SET NULL`.
///
/// **`walked` is every row already met, and a row is walked once.** A loop through `parent_id`
/// is cut at the end of every pass — but a pass can *make* one first, a move this page landed a
/// moment ago closing a ring with one this device made, and a walk that trusted the tree to be
/// one ran until the stack gave out, on every pull that brought the page back.
fn bury_under(
    conn: &Connection,
    table: &'static str,
    uid: &str,
    walked: &mut BTreeSet<(&'static str, String)>,
) -> Result<(), String> {
    for spec in &capture::TABLES {
        for p in spec.parents.iter().filter(|p| p.table == table && !p.soft) {
            let cascade = cascades(conn, spec.table, p)?;
            if !cascade && REHOMED.contains(&spec.table) {
                continue;
            }
            let children: Vec<String> = {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT c.sync_uid FROM {} c JOIN {table} t ON c.{} = t.id
                          WHERE t.sync_uid = ?1 AND c.sync_uid IS NOT NULL",
                        spec.table, p.col
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([uid], |r| r.get(0))
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
            };
            for child in children {
                if !cascade {
                    place(conn, spec.table, &child, (p, uid), now(conn)?)?;
                    continue;
                }
                if !walked.insert((spec.table, child.clone())) {
                    continue;
                }
                if let Some(row) = row_of(conn, spec, &child)? {
                    save(
                        conn,
                        &Entry {
                            table: spec.table.to_owned(),
                            uid: child.clone(),
                            parent_table: table.to_owned(),
                            parent_uid: uid.to_owned(),
                            twin: None,
                            alias: None,
                            state: State::Absent { row },
                        },
                    )?;
                }
                bury_under(conn, spec.table, &child, walked)?;
            }
        }
    }
    Ok(())
}

/// [`rehome::rehome`], writing down beside each row what filing it at the root did to it.
fn rehome_recording(conn: &Connection, d: &rehome::Doomed) -> Result<(), String> {
    for (table, ids) in [
        ("collection_entries", &d.collection),
        ("wishlist_entries", &d.wishlist),
    ] {
        let Some(shape) = Shape::of(table) else {
            continue;
        };
        let Some(p) = shape.spec.parents.first() else {
            continue;
        };
        for &id in ids {
            // The folder it is in is the one it comes back to.
            let folder: Option<String> = conn
                .query_row(
                    &format!(
                        "SELECT f.sync_uid FROM {table} e JOIN {} f ON f.id = e.{}
                          WHERE e.id = ?1",
                        p.table, p.col
                    ),
                    [id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
            match folder {
                Some(folder) => settle(conn, shape, id, (p, &folder), now(conn)?)?,
                None => {
                    rehome::rehome_one(conn, table, id)?;
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Meeting an orphan: an op arrives for a row the ledger holds
// ---------------------------------------------------------------------------------------

/// A group about a row that is `Absent`: lay it over the entry, and build the row if nothing it
/// names is missing any more — a move out from under the gone parent, say.
///
/// Where it still waits on a gone parent the entry is rewritten and the group is moot, as it
/// always was — **on a deciding pass only**, like every decision resting on [`gone`]: laid over
/// the entry on each retry pass, a counter's delta would be added once a pass. Where the parent
/// is merely unknown the group waits for it like any other and the entry is left as it was.
pub(super) fn meet_absent(
    conn: &Connection,
    shape: Shape,
    g: &Group,
    e: &Entry,
    deleted: &BTreeSet<(&str, &str)>,
    attempt: Attempt,
    report: &mut ApplyReport,
) -> Result<Outcome, String> {
    let State::Absent { row: held } = &e.state else {
        return Ok(Outcome::Deferred(Why::DecidedOnRetry));
    };
    let combined = folded_with_history(conn, shape.meta.table, &e.uid, g)?;
    let mut row = held.clone();
    overlay(&mut row, shape, g, &combined);
    if combined.deleted || emptied(&row, shape.meta) {
        // Its own device deleted it, or took its last copy: there is nothing left to bring back.
        forget(conn, &e.table, &e.uid)?;
        report.applied += g.ops.len();
        return Ok(Outcome::Written);
    }
    if let Some((table, uid)) = waits_on(conn, shape, &row)? {
        if !gone(conn, table, &uid, deleted)? {
            return Ok(Outcome::Deferred(Why::UnknownParent { table, uid }));
        }
        if !attempt.decides_gone() {
            return Ok(Outcome::Deferred(Why::DecidedOnRetry));
        }
        save(
            conn,
            &Entry {
                parent_table: table.to_owned(),
                parent_uid: uid.clone(),
                state: State::Absent { row },
                ..e.clone()
            },
        )?;
        return Ok(Outcome::Deferred(Why::UnknownParent { table, uid }));
    }
    let done = in_savepoint(conn, || {
        forget(conn, &e.table, &e.uid)?;
        restore(conn, shape, &e.uid, &row, deleted)
    })?;
    Ok(match done {
        Ok(()) => {
            report.applied += g.ops.len();
            Outcome::Written
        }
        Err(why) => Outcome::Deferred(Why::Unbuildable(why)),
    })
}

/// A group about a row that is `Folded` into a twin. `None` is "written like any other, onto the
/// twin" — the caller goes on with the twin as the row it found, and calls [`refold`] when it
/// has written.
///
/// - **Its own device deleted it**: the twin gives back its share, and that is all.
/// - **It names a parent that is here** — moved out from under the gone one, or the gone one is
///   back: the twin gives back its share and the row is built there.
/// - **Anything else** is an edit of a row that is still folded.
pub(super) fn meet_folded(
    conn: &Connection,
    shape: Shape,
    g: &Group,
    e: &Entry,
    deleted: &BTreeSet<(&str, &str)>,
    report: &mut ApplyReport,
) -> Result<Option<Outcome>, String> {
    let State::Folded { key, row: held, .. } = &e.state else {
        return Ok(None);
    };
    let combined = folded_with_history(conn, shape.meta.table, &e.uid, g)?;
    let mut row = held.clone();
    overlay(&mut row, shape, g, &combined);
    let back = match (g.resolved.parents.get(key.as_str()), shape.parent(key)) {
        (Some((Some(uid), _)), Some(p)) => id_of(conn, p.table, uid)?.is_some(),
        _ => false,
    };
    let gone_for_good = combined.deleted || emptied(&row, shape.meta);
    if !gone_for_good && !back {
        return Ok(None);
    }
    let done = in_savepoint(conn, || {
        forget(conn, &e.table, &e.uid)?;
        unfold(conn, shape, e)?.onto(&mut row);
        match gone_for_good {
            true => Ok(()),
            false => restore(conn, shape, &e.uid, &row, deleted),
        }
    })?;
    Ok(Some(match done {
        Ok(()) => {
            report.applied += g.ops.len();
            Outcome::Written
        }
        Err(why) => Outcome::Deferred(Why::Unbuildable(why)),
    }))
}

/// After a group was written onto the twin a `Folded` orphan is inside — which read `before`
/// when the write began: what the write did is the orphan's too, so it goes onto the entry's
/// share, and the group over its would-be row.
///
/// **A group that names the root ends the entry**: its own device put the row where the fold
/// already has it, so the fold stands for good.
pub(super) fn refold(
    conn: &Connection,
    shape: Shape,
    g: &Group,
    e: &Entry,
    before: &Row,
) -> Result<(), String> {
    let (
        State::Folded {
            key,
            row,
            share,
            changed,
            since,
        },
        Some(twin),
    ) = (&e.state, &e.twin)
    else {
        return Ok(());
    };
    if matches!(g.resolved.parents.get(key.as_str()), Some((None, _))) {
        return forget(conn, &e.table, &e.uid);
    }
    let combined = folded_with_history(conn, shape.meta.table, &e.uid, g)?;
    let mut row = row.clone();
    overlay(&mut row, shape, g, &combined);
    let after = row_of(conn, shape.spec, twin)?.unwrap_or_default();
    let (mut share, mut changed) = (share.clone(), changed.clone());
    took(before, &after, &mut share, &mut changed);
    // A parent the group named and which is gone too is the one the orphan rests on now.
    let rests = match row.parents.get(key.as_str()) {
        Some(Some(uid)) => uid.clone(),
        _ => e.parent_uid.clone(),
    };
    save(
        conn,
        &Entry {
            parent_uid: rests,
            state: State::Folded {
                key: key.clone(),
                row,
                share,
                changed,
                since: since.clone(),
            },
            ..e.clone()
        },
    )
}

/// Run `work` inside a savepoint of its own: kept where it answers `Ok`, and rolled back —
/// its refusal handed over as the inner `Err` — where it does not. The outer `Err` is the
/// savepoint's own failure.
pub(super) fn in_savepoint(
    conn: &Connection,
    work: impl FnOnce() -> Result<(), String>,
) -> Result<Result<(), String>, String> {
    conn.execute_batch("SAVEPOINT sync_orphan")
        .map_err(|e| e.to_string())?;
    let done = work();
    let end = match done {
        Ok(()) => "RELEASE sync_orphan",
        Err(_) => "ROLLBACK TO sync_orphan; RELEASE sync_orphan",
    };
    conn.execute_batch(end).map_err(|e| e.to_string())?;
    Ok(done)
}

// ---------------------------------------------------------------------------------------
// The sweep: a parent is back
// ---------------------------------------------------------------------------------------

/// Every entry whose parent is a row here.
///
/// **Asked parent by parent, not entry by entry**: one deleted binder can have a whole import's
/// worth of copies resting on it, and this runs on every pass of every apply. The distinct
/// parents are read off `idx_sync_orphans_parent` alone, and each is one probe of its table.
fn ready(conn: &Connection) -> Result<Vec<Entry>, String> {
    let parents: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare_cached("SELECT DISTINCT parent_tbl, parent_uid FROM sync_orphans")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let known = capture::parent_tables();
    let mut out: Vec<Entry> = Vec::new();
    for (table, uid) in parents {
        // The name goes into a statement, so it is one this build's specs spell — never one
        // merely read back out of the ledger.
        let Some(table) = known.iter().find(|t| **t == table) else {
            continue;
        };
        if here(conn, table, &uid)? {
            out.extend(entries(
                conn,
                "parent_tbl = ?1 AND parent_uid = ?2",
                [table, &uid],
            )?);
        }
    }
    Ok(out)
}

/// Take back every decision whose parent is here again, to a fixed point: a folder that comes
/// back is itself the parent of what was filed in it.
///
/// Run at the end of every pass of every apply, inside the pass's savepoint, so a round that is
/// rolled back takes its replays with it. **However the parent came back** — resurrected by this
/// page, built by a claim, or put back by this sweep a moment ago — the question is only whether
/// it is a row. Each entry is tried once a sweep, parents first; one that cannot be replayed is
/// let go and recorded, because an entry that failed on every pull would be a fault with no end.
pub(super) fn sweep(conn: &Connection, deleted: &BTreeSet<(&str, &str)>) -> Result<(), String> {
    let any: bool = conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM sync_orphans)")
        .and_then(|mut stmt| stmt.query_row([], |r| r.get(0)))
        .map_err(|e| e.to_string())?;
    if !any {
        return Ok(());
    }
    let mut tried: BTreeSet<(String, String)> = BTreeSet::new();
    loop {
        let mut entries = ready(conn)?;
        entries.retain(|e| !tried.contains(&(e.table.clone(), e.uid.clone())));
        if entries.is_empty() {
            return Ok(());
        }
        entries.sort_by_key(|e| meta_of(&e.table).map_or(u8::MAX, |m| m.order));
        for e in entries {
            tried.insert((e.table.clone(), e.uid.clone()));
            // **Read again, now**: undoing one fold can rename the twin another entry of this
            // same batch is folded into, and an entry read before that names a row that has
            // since become somebody else's.
            let Some(e) = of(conn, &e.table, &e.uid)? else {
                continue;
            };
            if let Err(why) = in_savepoint(conn, || replay(conn, &e, deleted))? {
                forget(conn, &e.table, &e.uid)?;
                crate::errors::record(
                    conn,
                    crate::errors::Source::Relay,
                    "apply",
                    crate::errors::Kind::Other,
                    &format!(
                        "a change to {} could not be put back when what it belongs to returned",
                        e.table
                    ),
                    Some(&format!("uid {} · {why}", e.uid)),
                );
            }
        }
    }
}

fn replay(conn: &Connection, e: &Entry, deleted: &BTreeSet<(&str, &str)>) -> Result<(), String> {
    let Some(shape) = Shape::of(&e.table) else {
        return forget(conn, &e.table, &e.uid);
    };
    match &e.state {
        // The op that placed it, as it came — so a later move this device made still wins.
        State::Placed { key, at } => {
            forget(conn, &e.table, &e.uid)?;
            let mut parents: BTreeMap<String, Option<String>> = BTreeMap::new();
            parents.insert(key.clone(), Some(e.parent_uid.clone()));
            write_one(
                conn,
                &Op {
                    table: e.table.clone(),
                    uid: e.uid.clone(),
                    kind: Kind::Put,
                    fields: BTreeMap::new(),
                    counters: BTreeMap::new(),
                    parents,
                    at: at.clone(),
                    baseline: false,
                    horizon: None,
                    schema: None,
                    emission: None,
                },
                deleted,
            )
            // What was folded into it while it stood at the root is left there by the write
            // itself (`leave_behind`), as it is behind any row that leaves the root's grain.
        }
        State::Absent { row } => build(conn, shape, e, row, deleted),
        State::Folded { row, .. } => {
            let mut row = row.clone();
            unfold(conn, shape, e)?.onto(&mut row);
            build(conn, shape, e, &row, deleted)
        }
    }
}

/// Build an orphan's row, or leave it `Absent` under whatever else it still waits on.
fn build(
    conn: &Connection,
    shape: Shape,
    e: &Entry,
    row: &Row,
    deleted: &BTreeSet<(&str, &str)>,
) -> Result<(), String> {
    match waits_on(conn, shape, row)? {
        None => {
            forget(conn, &e.table, &e.uid)?;
            restore(conn, shape, &e.uid, row, deleted)
        }
        Some((table, uid)) => save(
            conn,
            &Entry {
                parent_table: table.to_owned(),
                parent_uid: uid,
                twin: None,
                alias: None,
                state: State::Absent { row: row.clone() },
                ..e.clone()
            },
        ),
    }
}
