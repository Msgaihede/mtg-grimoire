//! Writing a merged result back — uid resolution, cycle-breaking, `needs_review`.
//!
//! Four things happen here and nothing else does:
//!
//! 1. **Ops already seen are dropped**, against `sync_peers`. Idempotence is the counter rule's
//!    other half: an op replayed after a reconnect must add its delta once.
//! 2. **A row is found by grain, then by uid, then inserted** — and where a grain match carries
//!    a different uid, both devices set the row's uid to `min(theirs, ours)`, which converges
//!    with no alias table.
//! 3. **Foreign uids become local ids.** A parent the device has never seen is a *deferral*, not
//!    an error.
//! 4. **Cycles are broken and `needs_review` is written.**
//!
//! # The row handle here is the `sync_uid`, not the rowid
//!
//! Every statement this module builds addresses a row by `WHERE sync_uid = ?`. Ten of the
//! eleven synced tables have an `INTEGER PRIMARY KEY` and `muted_tags` has none at all — it is
//! `WITHOUT ROWID` on `(namespace, tag_id)` — so a rowid would need a second spelling of every
//! statement for one table. The uid is `UNIQUE` on all eleven and every row has one, which is
//! what `schema::mint_missing_uids` and the capture trigger's mint are between them for.
//!
//! # Add-wins needs this device's own history, and `sync_ops` is where it is
//!
//! **Folding only the incoming ops answers the wrong question.** Two devices, A deletes a row
//! and B edits it concurrently; B pulls A's tombstone alone, folds a set of one, and deletes
//! the row — with B's edit gone and nothing anywhere to say so. That is precisely the silent
//! loss §7.3's add-wins rule exists to prevent, and it happens on the two-device group, which
//! is the ordinary one.
//!
//! So each group is folded **twice**: once over the incoming ops, and once over the incoming
//! ops plus this device's own ops for the same row out of `sync_ops`. The combined fold decides
//! whether the row exists and which side won each field; the incoming fold alone supplies the
//! counter deltas, because the local ones are already in the row and adding them again is the
//! doubling this whole module is arranged to prevent.
//!
//! **This is why a pushed op is kept rather than deleted.** `client` stamps `pushed_at` and
//! leaves the row: the op log is also this device's memory of what it did, and a device that
//! pruned it would lose every argument it could have made for keeping a row.
//!
//! What it does **not** cover is a third device: B has no local ops for a row C edited, so
//! A's tombstone and C's edit only meet if they arrive in one batch. The relay hands them over
//! in hybrid-logical-clock order, so the common case orders itself; the residual is a sparse
//! edit arriving after a tombstone, which is **deferred** rather than lost.
//!
//! # Why a device's stream stalls rather than skipping ahead
//!
//! `sync_peers` is a *watermark*: everything at or below it has been applied. So an op that
//! could not be applied cannot simply be counted and stepped over — advancing past it would
//! lose it for good, and not advancing would replay the ops above it and **add their counter
//! deltas a second time**. Both are silent. So the watermark is advanced only to the last op
//! before the first unappliable one from that device, that device's later ops are left for the
//! next pull, and [`ApplyReport::deferred`] is what says it happened. A stall is visible and
//! self-heals when the missing parent arrives; the two alternatives are not and do not.

use crate::sync_engine::capture::{self, Absent, Parent, Spec};
use crate::sync_engine::hlc::Hlc;
use crate::sync_engine::merge::{fold, Op, Resolved};
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension};
use std::collections::BTreeMap;

/// What a resurrected row is told to say.
///
/// [`crate::reconcile`]'s register: a sentence a reader can act on, never a code, and never a
/// reason to delete the row.
pub const RESURRECTED: &str =
    "Another device deleted this while this one was still changing it, so it was kept.";

/// What a folder that lost a cycle-break is told to say.
pub const CYCLE_BROKEN: &str = "A folder move on another device would have put this folder \
     inside itself. It was moved to the top level.";

/// What one call to [`apply`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ApplyReport {
    /// Ops written into the reader's tables.
    pub applied: usize,
    /// Rows a delete lost the race for — §7.4's first surfaced outcome.
    pub resurrected: usize,
    /// Folders returned to the root because a concurrent move made a loop.
    pub cycles_broken: usize,
    /// Ops at or below a peer's watermark, and ops this device wrote itself. Already applied,
    /// by definition.
    pub skipped: usize,
    /// Ops whose parent has not arrived, or which do not describe a row this database can
    /// build. **The device that wrote them is stalled at the first of them** — see the module
    /// doc.
    pub deferred: usize,
}

// ---------------------------------------------------------------------------------------
// What the applier has to know about a table that the capture spec does not say
// ---------------------------------------------------------------------------------------

/// One `?` in a grain predicate, and where its value comes from.
enum Source {
    Field(&'static str),
    Parent(&'static str),
}

/// A table's logical grain: its own UNIQUE index with every foreign local id replaced by that
/// parent's `sync_uid`.
///
/// **A minted uid alone cannot be a row's identity**, and the counter rule is what proves it:
/// two devices each adding one copy of the same printing mint two uids, and inserting both is
/// two rows at +1 rather than one row at +2 — plus a violation of `idx_collection_grain`.
/// **A grain alone cannot either**: `decks`, the three folder tables and `deck_audit` have no
/// unique index, so two devices' folders named "Binder" are two folders and must stay two.
struct Grain {
    /// The `WHERE` clause, one `?` per source, matching the table's own UNIQUE index verbatim.
    predicate: &'static str,
    sources: &'static [Source],
}

/// What a counter's own `CHECK` means when a delta takes it to or below zero.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Floor {
    /// `CHECK (quantity >= 0)` — `collection_entries`. A stepper taken to zero is a real state
    /// there: the row keeps its condition, its price, its tags and its acquisition story while
    /// the reader owns none of that printing today.
    Clamp,
    /// `CHECK (quantity > 0)` — `deck_cards` and `wishlist_entries`, where zero copies is not
    /// a row. The schema's two spellings differ on purpose and an applier using one rule for
    /// both would either raise a constraint failure on a deck card taken to zero or leave a
    /// collection row it should have kept.
    DeleteAtZero,
}

struct Meta {
    table: &'static str,
    /// **Parents before children**, so a folder is in the database before the row filed in it.
    /// Causality plus the hybrid logical clock already order a parent before its child *within*
    /// one device's stream — a device cannot reference a folder it has not seen — so this
    /// matters for a batch that mixes two devices' streams, and for the first pull a new device
    /// makes.
    order: u8,
    grain: Option<Grain>,
    counters: &'static [(&'static str, Floor)],
    /// `created_at` / `updated_at`. `deck_audit` and `muted_tags` carry their own stamp
    /// (`at`, `muted_at`) as an ordinary field and have neither column.
    timestamps: bool,
    /// Whether the table can hold a sentence for the reader at all. Five of the eleven cannot:
    /// `decks`, `deck_categories`, `deck_tags`, `deck_audit` and `muted_tags`.
    needs_review: bool,
    /// The self-referencing column a cycle can form on, for the three folder tables.
    tree: Option<&'static str>,
}

const META: [Meta; 11] = [
    Meta {
        table: "deck_folders",
        order: 0,
        grain: None,
        counters: &[],
        timestamps: true,
        needs_review: true,
        tree: Some("parent_id"),
    },
    Meta {
        table: "decks",
        order: 1,
        grain: None,
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_categories",
        order: 2,
        grain: Some(Grain {
            predicate: "deck_id = ? AND name = ?",
            sources: &[Source::Parent("deck"), Source::Field("name")],
        }),
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_tags",
        order: 3,
        grain: Some(Grain {
            predicate: "name_key = ?",
            sources: &[Source::Field("name_key")],
        }),
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_cards",
        order: 4,
        grain: Some(Grain {
            predicate: "deck_id = ? AND variant = ? AND category_id = ? AND card_id = ? \
                        AND coalesce(finish, '') = coalesce(?, '')",
            sources: &[
                Source::Parent("deck"),
                Source::Field("variant"),
                Source::Parent("category"),
                Source::Field("card_id"),
                Source::Field("finish"),
            ],
        }),
        counters: &[("quantity", Floor::DeleteAtZero)],
        timestamps: true,
        needs_review: true,
        tree: None,
    },
    Meta {
        table: "deck_audit",
        order: 5,
        grain: None,
        counters: &[],
        timestamps: false,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "collection_folders",
        order: 6,
        grain: None,
        counters: &[],
        timestamps: true,
        needs_review: true,
        tree: Some("parent_id"),
    },
    Meta {
        table: "collection_entries",
        order: 7,
        grain: Some(Grain {
            predicate: "card_id = ? AND finish = ? AND condition = ? AND lang = ? \
                        AND altered = ? AND signed = ? AND proxy = ? AND misprint = ? \
                        AND coalesce(serial_number, '') = coalesce(?, '') \
                        AND coalesce(grading, '') = coalesce(?, '') \
                        AND coalesce(folder_id, 0) = coalesce(?, 0)",
            sources: &[
                Source::Field("card_id"),
                Source::Field("finish"),
                Source::Field("condition"),
                Source::Field("lang"),
                Source::Field("altered"),
                Source::Field("signed"),
                Source::Field("proxy"),
                Source::Field("misprint"),
                Source::Field("serial_number"),
                Source::Field("grading"),
                Source::Parent("folder"),
            ],
        }),
        counters: &[
            ("quantity", Floor::Clamp),
            ("tradelist_quantity", Floor::Clamp),
        ],
        timestamps: true,
        needs_review: true,
        tree: None,
    },
    Meta {
        table: "wishlist_folders",
        order: 8,
        grain: None,
        counters: &[],
        timestamps: true,
        needs_review: true,
        tree: Some("parent_id"),
    },
    Meta {
        table: "wishlist_entries",
        order: 9,
        grain: Some(Grain {
            predicate: "coalesce(oracle_id, '') = coalesce(?, '') \
                        AND coalesce(card_id, '') = coalesce(?, '') \
                        AND coalesce(preferred_finish, '') = coalesce(?, '') \
                        AND coalesce(folder_id, 0) = coalesce(?, 0)",
            sources: &[
                Source::Field("oracle_id"),
                Source::Field("card_id"),
                Source::Field("preferred_finish"),
                Source::Parent("folder"),
            ],
        }),
        counters: &[("quantity", Floor::DeleteAtZero)],
        timestamps: true,
        needs_review: true,
        tree: None,
    },
    Meta {
        table: "muted_tags",
        order: 10,
        grain: Some(Grain {
            predicate: "namespace = ? AND tag_id = ?",
            sources: &[Source::Field("namespace"), Source::Field("tag_id")],
        }),
        counters: &[],
        timestamps: false,
        needs_review: false,
        tree: None,
    },
];

fn meta_of(table: &str) -> Option<&'static Meta> {
    META.iter().find(|m| m.table == table)
}

fn spec_of(table: &str) -> Option<&'static Spec> {
    capture::TABLES.iter().find(|s| s.table == table)
}

/// A JSON value as SQLite sees it.
///
/// A bool becomes an integer, because every boolean column in this schema is `INTEGER NOT NULL
/// DEFAULT 0` and SQLite has no boolean type. An array or an object would be a column holding
/// JSON as **text** — `tags`, `grading`, `payload` — and the capture trigger already ships those
/// as strings, so this arm is a fence rather than a case.
fn sql_value(v: &serde_json::Value) -> Sql {
    match v {
        serde_json::Value::Null => Sql::Null,
        serde_json::Value::Bool(b) => Sql::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => n
            .as_i64()
            .map(Sql::Integer)
            .or_else(|| n.as_f64().map(Sql::Real))
            .unwrap_or(Sql::Null),
        serde_json::Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

/// What happened to one row's worth of ops.
enum Outcome {
    Written,
    /// A parent has not arrived, or the ops do not describe a row this database can build.
    Deferred,
}

/// One row's worth of incoming ops, folded, with the ops kept for the watermark.
struct Group<'a> {
    table: &'a str,
    ops: Vec<&'a Op>,
    /// The fold of the incoming ops alone. Counters come from here.
    resolved: Resolved,
}

/// Apply a batch of ops from other devices.
///
/// The whole batch is one transaction wrapped in [`capture::suppressed`], so nothing written
/// here is captured back into `sync_ops` — without that guard two devices ping-pong an op
/// forever.
pub fn apply(conn: &Connection, ops: &[Op]) -> Result<ApplyReport, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let report = capture::suppressed(&tx, || apply_in(&tx, ops))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(report)
}

fn apply_in(conn: &Connection, ops: &[Op]) -> Result<ApplyReport, String> {
    let mut report = ApplyReport::default();
    let me: Option<String> = conn
        .query_row(
            "SELECT device_id FROM sync_identity WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let watermarks = read_watermarks(conn)?;

    // 1. Everything already seen, and everything this device wrote itself.
    //
    // **Our own ops are dropped rather than applied**, and the relay is not trusted to have
    // done it: a counter is not idempotent, so one of this device's own `+1`s coming back
    // would be a card appearing out of nothing.
    let mut fresh: Vec<&Op> = Vec::new();
    for op in ops {
        let mine = me.as_deref() == Some(op.at.device.as_str());
        let seen = watermarks
            .get(&op.at.device)
            .is_some_and(|w| stamp(op) <= *w);
        if mine || seen {
            report.skipped += 1;
        } else {
            fresh.push(op);
        }
    }

    // 2. One group per logical row, in an order that puts parents first.
    let mut groups = group(&fresh);
    groups.sort_by_key(|g| {
        (
            meta_of(g.table).map_or(u8::MAX, |m| m.order),
            g.ops.iter().map(|o| o.at.clone()).min(),
        )
    });

    // 3. Two passes, because a batch can carry a child before its parent even when one device's
    //    own stream cannot: the relay hands over several devices' streams interleaved.
    let mut soft: Vec<(&Group, String)> = Vec::new();
    let mut deferred: Vec<&Group> = Vec::new();
    for g in &groups {
        match write_group(conn, g, &mut report, &mut soft)? {
            Outcome::Written => {}
            Outcome::Deferred => deferred.push(g),
        }
    }
    let retry = std::mem::take(&mut deferred);
    for g in retry {
        match write_group(conn, g, &mut report, &mut soft)? {
            Outcome::Written => {}
            Outcome::Deferred => deferred.push(g),
        }
    }

    // 4. The soft parent — `decks.default_category_id` — after both passes, because `decks` and
    //    `deck_categories` name each other and no order of tables resolves both in one.
    for (g, uid) in &soft {
        settle_soft_parents(conn, g, uid)?;
    }

    // 5. §7.3 row 4's second half. LWW decided *where* each folder went; only the whole tree
    //    can say whether the result is a loop.
    for m in META.iter().filter(|m| m.tree.is_some()) {
        report.cycles_broken += break_cycles(conn, m, &groups)?;
    }

    for g in &deferred {
        report.deferred += g.ops.len();
    }
    advance_watermarks(conn, &groups, &deferred)?;
    observe(conn, fresh.iter().map(|o| &o.at).max())?;
    Ok(report)
}

/// Pull this device's clock past the latest stamp in the batch.
///
/// **This is what makes the clock causal, and without it last-writer-wins is a lottery.** A
/// device that applied a peer's op and then wrote its own would stamp the second one from a
/// clock that had never heard of the first — so an edit made *after* seeing another device's
/// could sort *before* it, and the older value would win on every machine.
///
/// It is [`super::hlc::Hlc::observe`] spelled in SQL, in the one place where the alternative is
/// worse: reading a wall clock in Rust means `SystemTime::now()`, which **panics on
/// `wasm32-unknown-unknown`**, and this module compiles for the web target.
fn observe(conn: &Connection, top: Option<&Hlc>) -> Result<(), String> {
    let Some(top) = top else {
        return Ok(());
    };
    conn.execute(
        "UPDATE sync_clock SET
             ms = max(ms, ?1, cast(unixepoch('subsec') * 1000 AS INTEGER)),
             ctr = CASE
                 WHEN cast(unixepoch('subsec') * 1000 AS INTEGER) > max(ms, ?1) THEN 0
                 WHEN ms = ?1 THEN max(ctr, ?2) + 1
                 WHEN ms > ?1 THEN ctr + 1
                 ELSE ?2 + 1
             END
           WHERE id = 1",
        rusqlite::params![top.ms, top.ctr],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn stamp(op: &Op) -> Hlc {
    op.at.clone()
}

fn read_watermarks(conn: &Connection) -> Result<BTreeMap<String, Hlc>, String> {
    let mut stmt = conn
        .prepare("SELECT device_id, last_ms, last_ctr FROM sync_peers")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let device: String = r.get(0)?;
            Ok((
                device.clone(),
                Hlc {
                    ms: r.get(1)?,
                    ctr: r.get(2)?,
                    device,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        out.insert(k, v);
    }
    Ok(out)
}

fn group<'a>(ops: &[&'a Op]) -> Vec<Group<'a>> {
    let mut by_row: BTreeMap<(&str, &str), Vec<&'a Op>> = BTreeMap::new();
    for op in ops {
        by_row
            .entry((op.table.as_str(), op.uid.as_str()))
            .or_default()
            .push(op);
    }
    by_row
        .into_iter()
        .map(|((table, _), ops)| {
            let owned: Vec<Op> = ops.iter().map(|o| (*o).clone()).collect();
            Group {
                table,
                resolved: fold(&owned),
                ops,
            }
        })
        .collect()
}

/// Resolve `key` to a local row id, or say which of the two ways it failed.
enum Resolution {
    Id(i64),
    /// The op says "nobody" — the root, or Auto.
    None,
    /// The op names a uid this database has never seen.
    Unknown,
}

fn resolve_parent(
    conn: &Connection,
    p: &Parent,
    resolved: &Resolved,
) -> Result<Resolution, String> {
    let Some((uid, _)) = resolved.parents.get(p.key) else {
        return Ok(Resolution::None);
    };
    let Some(uid) = uid else {
        return Ok(Resolution::None);
    };
    let id: Option<i64> = conn
        .query_row(
            &format!("SELECT id FROM {} WHERE sync_uid = ?1", p.table),
            [uid],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match id {
        Some(id) => Resolution::Id(id),
        None => Resolution::Unknown,
    })
}

fn absent_value(p: &Parent) -> Sql {
    match p.absent {
        Absent::Null => Sql::Null,
        Absent::Zero => Sql::Integer(0),
    }
}

/// Find the local row this group is about: by grain, then by uid.
///
/// Where a grain match carries a different uid, **both devices set the row's uid to the lower of
/// the two**. That converges with no alias table and no round trip: each side computes the same
/// `min` from the same pair, so after one exchange they agree, and the next round finds the row
/// by uid rather than by grain.
fn find_row(
    conn: &Connection,
    meta: &Meta,
    g: &Group,
    parents: &BTreeMap<&'static str, Sql>,
) -> Result<Found, String> {
    let op_uid = g.ops[0].uid.clone();
    if let Some(grain) = &meta.grain {
        if let Some(values) = grain_values(grain, g, parents) {
            let found: Option<String> = conn
                .query_row(
                    &format!(
                        "SELECT sync_uid FROM {} WHERE {}",
                        meta.table, grain.predicate
                    ),
                    rusqlite::params_from_iter(values.iter()),
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(found) = found {
                if found != op_uid {
                    let winner = found.clone().min(op_uid.clone());
                    if winner != found {
                        conn.execute(
                            &format!(
                                "UPDATE {} SET sync_uid = ?1 WHERE sync_uid = ?2",
                                meta.table
                            ),
                            [&winner, &found],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    return Ok(Found {
                        uid: Some(winner),
                        displaced: Some(found),
                    });
                }
                return Ok(Found {
                    uid: Some(found),
                    displaced: None,
                });
            }
        }
    }
    let by_uid: Option<String> = conn
        .query_row(
            &format!("SELECT sync_uid FROM {} WHERE sync_uid = ?1", meta.table),
            [&op_uid],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(Found {
        uid: by_uid,
        displaced: None,
    })
}

/// The row a group is about, and the uid it used to wear.
///
/// `displaced` matters because this device's own ops for that row are filed in `sync_ops` under
/// the **old** uid: adopting `min` renames the row and cannot rename history that has already
/// been pushed.
struct Found {
    uid: Option<String>,
    displaced: Option<String>,
}

/// This device's own ops for a row, out of `sync_ops`.
///
/// Several uids, because a row can have worn more than one: the op's, the local row's, and
/// whichever `min` displaced. Ops are only ever written for this device's own writes — an
/// apply runs inside [`capture::suppressed`] — so no filter on `device_id` is needed and one
/// would be wrong the day a peer's device id collided with a table name.
fn local_history(conn: &Connection, table: &str, uids: &[String]) -> Result<Vec<Op>, String> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let holes: Vec<String> = (2..=uids.len() + 1).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "{} WHERE tbl = ?1 AND uid IN ({})",
        capture::OPS_SELECT,
        holes.join(", ")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&table];
    for u in uids {
        params.push(u);
    }
    let rows = stmt
        .query_map(params.as_slice(), capture::op_from_row)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?.1);
    }
    Ok(out)
}

/// The bound values for a grain lookup, or `None` when the ops do not carry every term.
///
/// A sparse update op carries only what changed, so it cannot describe a grain — and does not
/// need to, because the row it edits is found by uid. An **insert** op carries every field,
/// which is what makes the grain rule work at all.
fn grain_values(
    grain: &Grain,
    g: &Group,
    parents: &BTreeMap<&'static str, Sql>,
) -> Option<Vec<Sql>> {
    let mut out = Vec::with_capacity(grain.sources.len());
    for source in grain.sources {
        match source {
            Source::Field(f) => {
                let v = g.resolved.fields.get(*f)?;
                out.push(sql_value(&v.0));
            }
            Source::Parent(key) => {
                if !g.resolved.parents.contains_key(*key) {
                    return None;
                }
                out.push(parents.get(key).cloned().unwrap_or(Sql::Null));
            }
        }
    }
    Some(out)
}

fn write_group<'a>(
    conn: &Connection,
    g: &'a Group<'a>,
    report: &mut ApplyReport,
    soft: &mut Vec<(&'a Group<'a>, String)>,
) -> Result<Outcome, String> {
    let (Some(meta), Some(spec)) = (meta_of(g.table), spec_of(g.table)) else {
        // A table this build does not sync. A newer device's op, and not an error: it is
        // deferred rather than dropped, so the count says so.
        return Ok(Outcome::Deferred);
    };

    // Parents first, because both the grain lookup and the write need them.
    let mut parents: BTreeMap<&'static str, Sql> = BTreeMap::new();
    let mut soft_pending = false;
    for p in spec.parents {
        match resolve_parent(conn, p, &g.resolved)? {
            Resolution::Id(id) => {
                parents.insert(p.key, Sql::Integer(id));
            }
            Resolution::None => {
                parents.insert(p.key, absent_value(p));
            }
            Resolution::Unknown if p.soft => soft_pending = true,
            Resolution::Unknown => return Ok(Outcome::Deferred),
        }
    }

    let existing = find_row(conn, meta, g, &parents)?;

    // **The second fold, over this device's own history as well.** See the module doc: a
    // tombstone folded on its own has nothing to lose to, so add-wins would never fire on the
    // two-device group, which is the ordinary one.
    let mut uids: Vec<String> = vec![g.ops[0].uid.clone()];
    if let Some(uid) = &existing.uid {
        uids.push(uid.clone());
    }
    if let Some(uid) = &existing.displaced {
        uids.push(uid.clone());
    }
    uids.sort();
    uids.dedup();
    let mut all: Vec<Op> = g.ops.iter().map(|o| (*o).clone()).collect();
    all.extend(local_history(conn, meta.table, &uids)?);
    let combined = fold(&all);

    if combined.deleted {
        if let Some(uid) = &existing.uid {
            conn.execute(
                &format!("DELETE FROM {} WHERE sync_uid = ?1", meta.table),
                [uid],
            )
            .map_err(|e| e.to_string())?;
        }
        report.applied += g.ops.len();
        return Ok(Outcome::Written);
    }

    let savepoint = "sync_apply_group";
    conn.execute_batch(&format!("SAVEPOINT {savepoint}"))
        .map_err(|e| e.to_string())?;
    let written = match &existing.uid {
        Some(uid) => update_row(conn, meta, spec, g, &combined, &parents, uid),
        None => {
            // **A row being created resolves its parents from the combined fold**, and the
            // difference only shows on a resurrection. A row this device deleted and add-wins
            // has just brought back is described by *this device's own* history: the incoming
            // op that saved it can be a sparse note edit that mentions no folder at all, and
            // resolving from it alone would put the row back at the root — a card that jumped
            // out of its binder because somebody else edited a note.
            //
            // An unknown uid here is `absent` rather than a deferral. Every parent in the
            // combined fold that is not also in the incoming one came from an op this device
            // wrote, so its row is local by construction; deferring on it would be a deadlock
            // against a condition that cannot arise.
            // **`g.resolved.parents` and not `parents`**, because the latter always holds
            // every key: an op that mentions no parent resolves to `Resolution::None`, which
            // is written in as the absent value. Asking the map whether it "has" the key would
            // therefore always be yes, and this whole arm would be dead code that reads as a
            // fix. The test caught it: `left: None, right: Some("Binder")`.
            let mut wide = parents.clone();
            for p in spec.parents {
                if g.resolved.parents.contains_key(p.key) {
                    continue;
                }
                wide.insert(
                    p.key,
                    match resolve_parent(conn, p, &combined)? {
                        Resolution::Id(id) => Sql::Integer(id),
                        Resolution::None | Resolution::Unknown => absent_value(p),
                    },
                );
            }
            insert_row(conn, meta, spec, g, &combined, &wide)
        }
    };
    match written {
        Ok(uid) => {
            conn.execute_batch(&format!("RELEASE {savepoint}"))
                .map_err(|e| e.to_string())?;
            if combined.resurrected {
                report.resurrected += 1;
                if meta.needs_review {
                    flag(conn, meta.table, &uid, RESURRECTED)?;
                }
            }
            if soft_pending {
                soft.push((g, uid));
            }
            report.applied += g.ops.len();
            Ok(Outcome::Written)
        }
        Err(_) => {
            // **A row this database cannot build is deferred, never fatal.** The likeliest
            // cause is a compacted log whose insert op is gone, leaving an update that names
            // no `NOT NULL` column; the batch's other rows are unaffected and the count says
            // it happened.
            conn.execute_batch(&format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}"))
                .map_err(|e| e.to_string())?;
            Ok(Outcome::Deferred)
        }
    }
}

/// The columns an **update** writes: those the incoming ops actually won.
///
/// A field the local device changed later is left alone. Without this the applier would write
/// every field the incoming ops mentioned, and a stale value from a peer would overwrite a
/// newer local edit — last-writer-wins with the comparison left out.
fn updates(
    spec: &Spec,
    g: &Group,
    combined: &Resolved,
    parents: &BTreeMap<&'static str, Sql>,
) -> Vec<(String, Sql)> {
    let mut out: Vec<(String, Sql)> = Vec::new();
    for f in spec.fields {
        let (Some((v, incoming)), Some((_, winner))) =
            (g.resolved.fields.get(*f), combined.fields.get(*f))
        else {
            continue;
        };
        if incoming == winner {
            out.push(((*f).to_owned(), sql_value(v)));
        }
    }
    for p in spec.parents {
        let (Some((_, incoming)), Some((_, winner)), Some(v)) = (
            g.resolved.parents.get(p.key),
            combined.parents.get(p.key),
            parents.get(p.key),
        ) else {
            continue;
        };
        if incoming == winner {
            out.push((p.col.to_owned(), v.clone()));
        }
    }
    out
}

/// The columns an **insert** writes: everything the combined fold knows.
///
/// Wider than [`updates`] on purpose. A row that does not exist here has no value to compare
/// against, and the row being rebuilt may be one this device deleted and add-wins has just
/// brought back — in which case the only description of it is this device's own history.
fn creations(
    spec: &Spec,
    combined: &Resolved,
    parents: &BTreeMap<&'static str, Sql>,
) -> Vec<(String, Sql)> {
    let mut out: Vec<(String, Sql)> = Vec::new();
    for f in spec.fields {
        if let Some((v, _)) = combined.fields.get(*f) {
            out.push(((*f).to_owned(), sql_value(v)));
        }
    }
    for p in spec.parents {
        if let Some(v) = parents.get(p.key) {
            out.push((p.col.to_owned(), v.clone()));
        }
    }
    out
}

fn insert_row(
    conn: &Connection,
    meta: &Meta,
    spec: &Spec,
    g: &Group,
    combined: &Resolved,
    parents: &BTreeMap<&'static str, Sql>,
) -> Result<String, String> {
    let uid = g.ops[0].uid.clone();
    let mut cols: Vec<String> = vec!["sync_uid".to_owned()];
    let mut vals: Vec<Sql> = vec![Sql::Text(uid.clone())];
    for (c, v) in creations(spec, combined, parents) {
        cols.push(c);
        vals.push(v);
    }
    // **A counter's initial value is the sum of every delta, local ones included**, because a
    // row being created here holds none of them yet. On an update it is the incoming deltas
    // alone — the local ones are already in the row.
    for (name, _) in meta.counters {
        cols.push((*name).to_owned());
        vals.push(Sql::Integer(
            combined.counters.get(*name).copied().unwrap_or(0),
        ));
    }
    if meta.timestamps {
        cols.push("created_at".to_owned());
        cols.push("updated_at".to_owned());
    }
    let mut holes: Vec<String> = (1..=vals.len()).map(|i| format!("?{i}")).collect();
    if meta.timestamps {
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
    Ok(uid)
}

fn update_row(
    conn: &Connection,
    meta: &Meta,
    spec: &Spec,
    g: &Group,
    combined: &Resolved,
    parents: &BTreeMap<&'static str, Sql>,
    uid: &str,
) -> Result<String, String> {
    let pairs = updates(spec, g, combined, parents);
    if !pairs.is_empty() || meta.timestamps {
        let mut sets: Vec<String> = pairs
            .iter()
            .enumerate()
            .map(|(i, (c, _))| format!("{c} = ?{}", i + 1))
            .collect();
        if meta.timestamps {
            sets.push("updated_at = unixepoch()".to_owned());
        }
        let mut vals: Vec<Sql> = pairs.into_iter().map(|(_, v)| v).collect();
        let hole = vals.len() + 1;
        vals.push(Sql::Text(uid.to_owned()));
        conn.execute(
            &format!(
                "UPDATE {} SET {} WHERE sync_uid = ?{hole}",
                meta.table,
                sets.join(", ")
            ),
            rusqlite::params_from_iter(vals.iter()),
        )
        .map_err(|e| e.to_string())?;
    }

    for (name, floor) in meta.counters {
        let Some(delta) = g.resolved.counters.get(*name) else {
            continue;
        };
        if *delta == 0 {
            continue;
        }
        let current: i64 = conn
            .query_row(
                &format!("SELECT {name} FROM {} WHERE sync_uid = ?1", meta.table),
                [uid],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let next = current + delta;
        match floor {
            Floor::Clamp => {
                conn.execute(
                    &format!("UPDATE {} SET {name} = ?1 WHERE sync_uid = ?2", meta.table),
                    rusqlite::params![next.max(0), uid],
                )
                .map_err(|e| e.to_string())?;
            }
            Floor::DeleteAtZero if next <= 0 => {
                conn.execute(
                    &format!("DELETE FROM {} WHERE sync_uid = ?1", meta.table),
                    [uid],
                )
                .map_err(|e| e.to_string())?;
                return Ok(uid.to_owned());
            }
            Floor::DeleteAtZero => {
                conn.execute(
                    &format!("UPDATE {} SET {name} = ?1 WHERE sync_uid = ?2", meta.table),
                    rusqlite::params![next, uid],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(uid.to_owned())
}

/// The first message wins — [`crate::reconcile`]'s stated rule for this column.
fn flag(conn: &Connection, table: &str, uid: &str, sentence: &str) -> Result<(), String> {
    conn.execute(
        &format!(
            "UPDATE {table} SET needs_review = ?1
              WHERE sync_uid = ?2 AND needs_review IS NULL"
        ),
        [sentence, uid],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn settle_soft_parents(conn: &Connection, g: &Group, uid: &str) -> Result<(), String> {
    let Some(spec) = spec_of(g.table) else {
        return Ok(());
    };
    for p in spec.parents.iter().filter(|p| p.soft) {
        let value = match resolve_parent(conn, p, &g.resolved)? {
            Resolution::Id(id) => Sql::Integer(id),
            // Still unknown after the whole batch: the category is on a device this one has not
            // heard from. `Auto` is the honest answer and the one the column defaults to.
            Resolution::None | Resolution::Unknown => absent_value(p),
        };
        conn.execute(
            &format!("UPDATE {} SET {} = ?1 WHERE sync_uid = ?2", g.table, p.col),
            rusqlite::params![value, uid],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Break every loop in one folder tree, returning the folder whose move is **later** to the
/// root.
///
/// **Later and not earlier**, which is spec §7.3's wording and is a choice about *which move
/// survives*: cutting the later-moved folder leaves the **earlier** move standing. That is the
/// arrangement more devices in the group have already seen and drawn, so undoing the other one
/// disturbs the fewest screens — and the reader whose move was undone is the one who has just
/// made it and can most easily make it again, with `needs_review` telling them so.
///
/// Convergence is a separate requirement and both directions satisfy it, which a mutation
/// established: reversing the comparison left every test green. What convergence needs is that
/// both devices consult the **same set of stamps**, which is what reading the local op log
/// below is for.
///
/// Where neither folder in the loop was moved by anything this device knows about — a loop
/// that was already on disk — the greater row id breaks the tie, which is arbitrary and
/// identical everywhere.
///
/// # The stamps come from the local op log as well, and the first draft of this did not
///
/// A loop takes **two** moves and each device only ever *receives* one of them: the other is
/// its own, and an apply sees only what arrived. Reading the incoming batch alone therefore
/// makes each device break the move the *other* one made — A cuts Inner, B cuts Outer, the
/// tree is different on the two machines and neither can tell. The test that caught it asserts
/// the two devices name the same folder, and it failed on the first run with
/// `left: "Inner", right: "Outer"`.
///
/// So the map is built from `sync_ops` first — this device's own moves, which is what
/// `json_type(parents, '$.parent')` selects — and the incoming groups on top of it.
/// `json_type` and not `json_extract`, because a move **to the root** is a JSON null and
/// `json_extract` cannot tell that from a key that is not there.
fn break_cycles(conn: &Connection, meta: &Meta, groups: &[Group]) -> Result<usize, String> {
    let col = meta.tree.expect("called only for a tree");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, {col}, sync_uid FROM {} WHERE {col} IS NOT NULL",
            meta.table
        ))
        .map_err(|e| e.to_string())?;
    let rows: Vec<(i64, i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let parent: BTreeMap<i64, (i64, String)> = rows
        .iter()
        .map(|(id, p, u)| (*id, (*p, u.clone())))
        .collect();

    // Every move this device knows about: its own out of `sync_ops`, then the batch's.
    let mut moved: BTreeMap<String, Hlc> = BTreeMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT uid, hlc_ms, hlc_ctr, device_id FROM sync_ops
                  WHERE tbl = ?1 AND json_type(parents, '$.parent') IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([meta.table], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Hlc {
                        ms: r.get(1)?,
                        ctr: r.get(2)?,
                        device: r.get(3)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (uid, at) = row.map_err(|e| e.to_string())?;
            let e = moved.entry(uid).or_insert_with(|| at.clone());
            if at > *e {
                *e = at;
            }
        }
    }
    for g in groups.iter().filter(|g| g.table == meta.table) {
        if let Some((_, at)) = g.resolved.parents.get("parent") {
            let e = moved
                .entry(g.ops[0].uid.clone())
                .or_insert_with(|| at.clone());
            if *at > *e {
                *e = at.clone();
            }
        }
    }

    let mut broken = 0;
    let mut cut: Vec<i64> = Vec::new();
    for start in parent.keys() {
        let mut seen: Vec<i64> = vec![*start];
        let mut here = *start;
        while let Some((next, _)) = parent.get(&here) {
            if cut.contains(next) {
                break;
            }
            if seen.contains(next) {
                // The loop is `seen` from the first sight of `next` onwards.
                let from = seen.iter().position(|s| s == next).unwrap_or(0);
                let loop_members = &seen[from..];
                let victim = loop_members
                    .iter()
                    .max_by(|a, b| {
                        let key =
                            |id: &i64| parent.get(id).and_then(|(_, uid)| moved.get(uid)).cloned();
                        key(a).cmp(&key(b)).then_with(|| a.cmp(b))
                    })
                    .copied()
                    .unwrap_or(*start);
                conn.execute(
                    &format!(
                        "UPDATE {} SET {col} = NULL, needs_review = coalesce(needs_review, ?1)
                          WHERE id = ?2",
                        meta.table
                    ),
                    rusqlite::params![CYCLE_BROKEN, victim],
                )
                .map_err(|e| e.to_string())?;
                cut.push(victim);
                broken += 1;
                break;
            }
            seen.push(*next);
            here = *next;
        }
    }
    Ok(broken)
}

/// Move each peer's watermark to the last op before the first one that could not be applied.
fn advance_watermarks(
    conn: &Connection,
    groups: &[Group],
    deferred: &[&Group],
) -> Result<(), String> {
    let mut blocked: BTreeMap<&str, Hlc> = BTreeMap::new();
    for g in deferred {
        for op in &g.ops {
            let e = blocked.entry(op.at.device.as_str());
            match e {
                std::collections::btree_map::Entry::Vacant(v) => {
                    v.insert(op.at.clone());
                }
                std::collections::btree_map::Entry::Occupied(mut o) => {
                    if op.at < *o.get() {
                        o.insert(op.at.clone());
                    }
                }
            }
        }
    }
    let mut high: BTreeMap<&str, Hlc> = BTreeMap::new();
    let deferred_ptrs: Vec<*const Group> = deferred.iter().map(|g| *g as *const Group).collect();
    for g in groups {
        if deferred_ptrs.contains(&(g as *const Group)) {
            continue;
        }
        for op in &g.ops {
            if blocked
                .get(op.at.device.as_str())
                .is_some_and(|b| op.at >= *b)
            {
                continue;
            }
            let e = high.entry(op.at.device.as_str());
            match e {
                std::collections::btree_map::Entry::Vacant(v) => {
                    v.insert(op.at.clone());
                }
                std::collections::btree_map::Entry::Occupied(mut o) => {
                    if op.at > *o.get() {
                        o.insert(op.at.clone());
                    }
                }
            }
        }
    }
    for (device, at) in high {
        conn.execute(
            "INSERT INTO sync_peers (device_id, last_ms, last_ctr) VALUES (?1, ?2, ?3)
             ON CONFLICT(device_id) DO UPDATE SET
                 last_ms  = excluded.last_ms,
                 last_ctr = excluded.last_ctr
               WHERE (excluded.last_ms, excluded.last_ctr) > (sync_peers.last_ms,
                                                              sync_peers.last_ctr)",
            rusqlite::params![device, at.ms, at.ctr],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
