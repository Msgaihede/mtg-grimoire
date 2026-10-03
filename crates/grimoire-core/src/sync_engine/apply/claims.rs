//! Claims that name their emission — the baseline claim design of 2026-10-03,
//! `docs/superpowers/specs/2026-10-03-baseline-claim-emissions-design.md` §5–§7.
//!
//! **Two calls from [`super::apply_in`] and nothing else**: [`decide`] before the page is
//! grouped — which claims and covered puts go to the fold, which are consumed as they stand —
//! and [`settle`] after the committed pass, which records what each claim did and marks an
//! emission taken once it is whole. Nothing here reads or writes `sync_peers`: a claim is a
//! statement about a row, never a place in its emitter's stream.
//!
//! **A claim is a baseline op that names its emission, and nothing else is.** Only claims carry a
//! reference (§3), so one on an ordinary op is malformed: it is stripped at the door with the
//! rest, and the op is judged exactly as `main` judges it — never as a claim, and never as the
//! head of an emission.

use super::{Class, Deferral};
use crate::sync_engine::emission::{self, Record, Stamp};
use crate::sync_engine::merge::{Emission, Horizon, Op};
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};

/// An emission's name: its emitter and its `id`.
type Key = (String, Stamp);

/// One emission as a page carries it.
struct InPage {
    n: u32,
    since: Stamp,
    resumed: bool,
    horizon: Horizon,
    /// `Some` while the emission is active: the ledger's record of it, or a fresh one.
    record: Option<Record>,
}

/// What [`decide`] settled before any group is formed.
#[derive(Default)]
pub(super) struct Decided {
    /// Page indices whose reference is stripped at the door, so they are judged as an op with none:
    /// an emission named at or below the upgrade cut (§10), a claim whose head is not in the page,
    /// this device's own emission handed back, and a reference on an op that is no claim at all.
    pub strip: BTreeSet<usize>,
    /// Page indices consumed without being applied.
    pub skip: BTreeSet<usize>,
    /// Page indices that go to the fold whatever `seen` and the older horizon rules say.
    pub keep: BTreeSet<usize>,
    emissions: BTreeMap<Key, InPage>,
    /// Claims this page consumed without writing.
    passed: Vec<(Key, u32)>,
    /// Claims this page sent to the fold, with their row.
    kept: Vec<(Key, u32, String, String)>,
}

fn sql(e: rusqlite::Error) -> String {
    e.to_string()
}

/// The reference `op` carries as a claim: a baseline op's, and never another op's (§3).
fn claim(op: &Op) -> Option<&Emission> {
    op.emission.as_ref().filter(|_| op.baseline)
}

/// Decide a page's claims (spec §5, §6, §10).
///
/// An emission named at or below the upgrade cut, and a claim whose chunk head is not in the page
/// — `n` and `since` absent on every op of its emission — are marked to be stripped: the caller
/// takes their reference off and `main`'s rules judge them as ops with none. So is this device's
/// own emission when the relay hands it back, which `main` drops as its own, and a reference an
/// ordinary op carries, which no well-formed peer sends.
pub(super) fn decide(
    conn: &Connection,
    ops: &[Op],
    me: Option<&str>,
    seen: &dyn Fn(&Op) -> bool,
) -> Result<Decided, String> {
    let _ = seen; // read by Task 5's covered-put arm
    let mut out = Decided::default();
    let cut = emission::cut(conn).map_err(sql)?;
    for op in ops {
        let (Some(em), Some(h)) = (claim(op), &op.horizon) else {
            continue;
        };
        let (Some(n), Some(since)) = (em.n, em.since) else {
            continue;
        };
        if em.id <= cut || me == Some(op.at.device.as_str()) {
            continue;
        }
        out.emissions
            .entry((op.at.device.clone(), em.id))
            .or_insert(InPage {
                n,
                since,
                resumed: em.resumed,
                horizon: h.clone(),
                record: None,
            });
    }
    for (i, op) in ops.iter().enumerate() {
        let Some(em) = &op.emission else {
            continue;
        };
        if !op.baseline || !out.emissions.contains_key(&(op.at.device.clone(), em.id)) {
            out.strip.insert(i);
        }
    }
    // Active or inert, against the marks as they stood before the page (§6).
    for ((emitter, id), page) in out.emissions.iter_mut() {
        let taken = emission::taken(conn, emitter).map_err(sql)?;
        if taken.is_none_or(|t| page.since > t) {
            let held = emission::records(conn, emitter)
                .map_err(sql)?
                .into_iter()
                .find(|r| r.id == *id);
            page.record =
                Some(held.unwrap_or_else(|| Record::new(*id, page.n, page.since, page.resumed)));
        }
    }
    for (i, op) in ops.iter().enumerate() {
        let Some(em) = claim(op) else {
            continue;
        };
        let key = (op.at.device.clone(), em.id);
        let Some(page) = out.emissions.get(&key) else {
            continue;
        };
        let Some(record) = &page.record else {
            out.skip.insert(i); // inert
            continue;
        };
        if record.consumed(em.i) {
            out.skip.insert(i);
            continue;
        }
        out.keep.insert(i);
        out.kept.push((key, em.i, op.table.clone(), op.uid.clone()));
    }
    Ok(out)
}

/// Record what the committed pass did with each claim the page sent to the fold, and mark an
/// emission taken once every index is consumed (§5).
pub(super) fn settle(
    conn: &Connection,
    d: &Decided,
    committed: &[Deferral],
    me: Option<&str>,
) -> Result<(), String> {
    let classes: BTreeMap<(&str, &str), Class> = committed
        .iter()
        .map(|x| ((x.group.table, x.group.ops[0].uid.as_str()), x.class))
        .collect();
    let mut records: BTreeMap<&Key, Record> = d
        .emissions
        .iter()
        .filter_map(|(k, p)| p.record.clone().map(|r| (k, r)))
        .collect();
    for (key, i) in &d.passed {
        if let Some(r) = records.get_mut(key) {
            r.passed.insert(*i);
        }
    }
    for (key, i, table, uid) in &d.kept {
        let Some(r) = records.get_mut(key) else {
            continue;
        };
        match classes.get(&(table.as_str(), uid.as_str())) {
            Some(class) if class.holds() => {}
            Some(_) => r.passed.insert(*i),
            None => r.wrote.insert(*i),
        }
    }
    for (key, record) in records {
        if record.complete() {
            // §8: carried only where every claim wrote its row.
            let carry = record.passed.is_empty();
            emission::take(conn, &key.0, &record, &d.emissions[key].horizon, carry, me)
                .map_err(sql)?;
        } else {
            emission::keep(conn, &key.0, record).map_err(sql)?;
        }
    }
    Ok(())
}
