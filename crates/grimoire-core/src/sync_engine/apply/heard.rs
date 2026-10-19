//! What this device has heard of each row from other devices — `sync_heard`, user schema v61,
//! issue #842.
//!
//! `apply` decides last-writer-wins and add-wins by folding the page with history, and until this
//! the only history it had was this device's own op log. It kept no stamp for anything another
//! device wrote, so two ops from two *other* devices were compared only when they arrived in one
//! pull: split across two, whichever came second won, whatever its stamp, on the one device that
//! wrote neither. The relay hands rows over in the order they were pushed, so all it took was a
//! device that edited while offline — three devices, measured: an older note, an older move and an
//! older delete each beat a newer op heard on an earlier pull, and a newer edit could not rebuild
//! a row an older delete had taken.
//!
//! So every group `apply` writes is folded into a [`Memory`] of its row ([`record`]) — the stamp
//! and value that won each field and each placement, the latest stamps asserting the row alive and
//! dead, and the counters — and every fold that used to read this device's own log reads this too
//! ([`super::fold_with_history`]). **It is one row per synced row another device has written**,
//! not one per op: a fold, absorbed into. That is the storage the issue said a fix would cost:
//! each distinct stamp is stored once (`merge::Memory`'s stored shape), so a memory is about the
//! size of the row it describes — measured, 596 bytes for a copy made by one insert and 204 for a
//! binder, with a 32-character device id.
//!
//! **And a row an apply deletes is kept first** ([`keep`]): its fields, its parents by uid and its
//! counters as it stood, so that a later op from a third device that wins add-wins can build it
//! again. A row made before the group existed was never described by any op, and a sparse edit
//! cannot describe it either.
//!
//! # Where a memory is filed
//!
//! Under the uid the row wears — and a row can change uid: a grain match adopts the lower of two
//! ([`renamed`], from `adopt_uid` and the re-homing's `adopt_lower`), and a group whose uid was
//! merged into another row is remembered under the survivor's ([`record`]). An orphan's ops are
//! remembered under its own uid, whatever row the ledger has folded it into: the ledger keeps its
//! own account of a fold, and a memory of the twin's would be wrong for the orphan the day it
//! returns.
//!
//! Per-device and not synced, written by `apply` alone and inside its pass's savepoint, so a round
//! rolled back takes its memories with it.
//!
//! **Every fold and merge here is ranked** ([`Ranks`], the Discord spec's §14.2): a restricted
//! device's stamp loses to a full device's in a memory exactly as it does in a page, so a bot's
//! add heard on one pull cannot outrank a reader's edit or delete heard on another.

use super::*;
use crate::sync_engine::merge::Memory;

fn read(conn: &Connection, table: &str, uid: &str) -> Result<Option<Memory>, String> {
    let text: Option<String> = conn
        .prepare_cached("SELECT memory FROM sync_heard WHERE tbl = ?1 AND uid = ?2")
        .and_then(|mut stmt| stmt.query_row([table, uid], |r| r.get(0)).optional())
        .map_err(|e| e.to_string())?;
    match text {
        // **A memory this build cannot read is no memory**, and never a failed apply: it only
        // ever adds to what the page and the own log decide, and an apply that failed on it
        // would fail on every pull after.
        Some(text) => Ok(serde_json::from_str(&text).ok()),
        None => Ok(None),
    }
}

fn write(conn: &Connection, table: &str, uid: &str, memory: &Memory) -> Result<(), String> {
    let text = serde_json::to_string(memory).map_err(|e| e.to_string())?;
    conn.prepare_cached(
        "INSERT INTO sync_heard (tbl, uid, memory) VALUES (?1, ?2, ?3)
         ON CONFLICT (tbl, uid) DO UPDATE SET memory = excluded.memory",
    )
    .and_then(|mut stmt| stmt.execute([table, uid, text.as_str()]))
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// What this device remembers of a row that has worn `uids`, as one memory. Each name once:
/// merging one memory twice would count its counters twice.
pub(super) fn recall(
    conn: &Connection,
    table: &str,
    uids: &[String],
    ranks: &Ranks,
) -> Result<Memory, String> {
    let mut out = Memory::default();
    let names: BTreeSet<&String> = uids.iter().collect();
    for uid in names {
        if let Some(memory) = read(conn, table, uid)? {
            out.merge_ranked(memory, ranks);
        }
    }
    Ok(out)
}

/// Fold a group `apply` has written or consumed into the memory of its row.
pub(super) fn record(conn: &Connection, g: &Group) -> Result<(), String> {
    let uid = filed_under(conn, g.table, &g.ops[0].uid)?;
    let mut memory = read(conn, g.table, &uid)?.unwrap_or_default();
    let ops: Vec<Op> = g.ops.iter().map(|o| (*o).clone()).collect();
    memory.absorb_ranked(&ops, &g.ranks);
    write(conn, g.table, &uid, &memory)
}

/// The uid a group's ops are remembered under: their own, unless it was merged into another row
/// here and is no orphan's — see the module doc.
fn filed_under(conn: &Connection, table: &str, uid: &str) -> Result<String, String> {
    if orphans::of(conn, table, uid)?.is_some() {
        return Ok(uid.to_owned());
    }
    match emission::survivor(conn, table, uid).map_err(|e| e.to_string())? {
        Some(survivor) if orphans::of(conn, table, &survivor)?.is_none() => Ok(survivor),
        _ => Ok(uid.to_owned()),
    }
}

/// Keep what this device holds of `table`'s row `uid`, which an apply is about to delete: every
/// field and parent no op has described to this memory, and the counters as they stand, with this
/// device's own ops up to now inside them ([`Memory::keep`]). A row not here keeps nothing.
pub(super) fn keep(conn: &Connection, spec: &Spec, uid: &str) -> Result<(), String> {
    let Some(row) = orphans::row_of(conn, spec, uid)? else {
        return Ok(());
    };
    let through = local_history(conn, spec.table, &[uid.to_owned()])?
        .into_iter()
        .map(|op| op.at)
        .max();
    let mut memory = read(conn, spec.table, uid)?.unwrap_or_default();
    memory.keep(row.fields, row.parents, row.counters, through);
    write(conn, spec.table, uid, &memory)
}

/// `table`'s row `from` is called `to` from here on: what was heard of it under either name is
/// one memory, under `to`.
pub(super) fn renamed(conn: &Connection, table: &str, from: &str, to: &str) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    let Some(moved) = read(conn, table, from)? else {
        return Ok(());
    };
    let mut memory = read(conn, table, to)?.unwrap_or_default();
    memory.merge_ranked(moved, &ranks_of(conn)?);
    write(conn, table, to, &memory)?;
    conn.execute(
        "DELETE FROM sync_heard WHERE tbl = ?1 AND uid = ?2",
        [table, from],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Every placement under `key` another device made in `table` that this device remembers, by the
/// uid it is filed under: what the cycle-break weighs beside this device's own moves.
pub(super) fn moves(
    conn: &Connection,
    table: &str,
    key: &str,
) -> Result<Vec<(String, Hlc)>, String> {
    let mut stmt = conn
        .prepare("SELECT uid, memory FROM sync_heard WHERE tbl = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([table], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (uid, text) = row.map_err(|e| e.to_string())?;
        let Ok(memory) = serde_json::from_str::<Memory>(&text) else {
            continue;
        };
        // A placement this device kept rather than heard is no move.
        if let Some((_, at)) = memory.parents.get(key) {
            if *at != crate::sync_engine::merge::before_everything() {
                out.push((uid, at.clone()));
            }
        }
    }
    Ok(out)
}
