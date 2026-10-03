//! The baseline claim design's scenarios —
//! `docs/superpowers/specs/2026-10-03-baseline-claim-emissions-design.md` §14.
//!
//! **Its own fixtures, on purpose.** `apply/tests.rs` changes under every sync branch; the
//! handful of helpers here are copied so this file merges without touching that one.

use super::*;
use crate::sync_engine::{baseline, capture, emission};
use rusqlite::{Connection, OptionalExtension};

fn paired(device: &str) -> Connection {
    let conn = crate::schema::memory_pair();
    capture::install(&conn).unwrap();
    conn.execute(
        "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
         VALUES (1, ?1, x'00', x'01', ?1, 0)",
        [device],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
         VALUES (1, 'g', 0, x'02', 0)",
        [],
    )
    .unwrap();
    conn
}

fn outbox(conn: &Connection) -> Vec<Op> {
    let sql = format!("{} ORDER BY seq", capture::OPS_SELECT);
    let mut stmt = conn.prepare(&sql).unwrap();
    let ops = stmt
        .query_map([], capture::op_from_row)
        .unwrap()
        .map(|r| r.unwrap().1)
        .collect();
    ops
}

fn since(conn: &Connection, mark: &mut i64) -> Vec<Op> {
    let sql = format!("{} WHERE seq > ?1 ORDER BY seq", capture::OPS_SELECT);
    let mut stmt = conn.prepare(&sql).unwrap();
    let rows: Vec<(i64, Op)> = stmt
        .query_map([*mark], capture::op_from_row)
        .unwrap()
        .map(Result::unwrap)
        .collect();
    if let Some((seq, _)) = rows.last() {
        *mark = *seq;
    }
    rows.into_iter().map(|(_, op)| op).collect()
}

/// A second that has not happened yet, and a stamp 400 ms into it: a device whose clock is set
/// here stamps its next op at exactly [`STAMP`].
const SECOND: i64 = 4_000_000_000;
const STAMP: i64 = SECOND * 1000 + 400;

fn set_clock(conn: &Connection, ms: i64) {
    conn.execute("UPDATE sync_clock SET ms = ?1, ctr = 0", [ms])
        .unwrap();
}

fn stash(conn: &Connection, card: &str, quantity: i64, updated_at: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES (?1,'lea','1','en','nonfoil','NM',?2,?3,?3)",
        rusqlite::params![card, quantity, updated_at],
    )
    .unwrap();
}

fn step(conn: &Connection, card: &str, by: i64, updated_at: i64) {
    conn.execute(
        "UPDATE collection_entries SET quantity = quantity + ?2, updated_at = ?3
          WHERE card_id = ?1",
        rusqlite::params![card, by, updated_at],
    )
    .unwrap();
}

fn folder(conn: &Connection, name: &str, updated_at: i64) -> i64 {
    conn.execute(
        "INSERT INTO collection_folders (parent_id, name, kind, sort_order, created_at, updated_at)
         VALUES (NULL, ?1, 'user', 1, ?2, ?2)",
        rusqlite::params![name, updated_at],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn file_in(conn: &Connection, card: &str, quantity: i64, folder_id: i64, updated_at: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
             created_at,updated_at)
         VALUES (?1,'lea','1','en','nonfoil','NM',?2,?3,?4,?4)",
        rusqlite::params![card, quantity, folder_id, updated_at],
    )
    .unwrap();
}

fn copies(conn: &Connection, card: &str) -> i64 {
    conn.query_row(
        "SELECT coalesce(sum(quantity), 0) FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .unwrap()
}

#[allow(
    dead_code,
    reason = "read by the row table's scenarios, which arrive next"
)]
fn rows(conn: &Connection, card: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .unwrap()
}

#[allow(
    dead_code,
    reason = "read by the row table's scenarios, which arrive next"
)]
fn note(conn: &Connection, card: &str) -> String {
    conn.query_row(
        "SELECT coalesce(notes, '-') FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .optional()
    .unwrap()
    .unwrap_or_else(|| "no row".to_owned())
}

fn folder_of(conn: &Connection, card: &str) -> Option<String> {
    conn.query_row(
        "SELECT f.name FROM collection_entries e
           LEFT JOIN collection_folders f ON f.id = e.folder_id
          WHERE e.card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .unwrap()
}

fn qty(conn: &Connection) -> (i64, i64) {
    conn.query_row(
        "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

/// An emission as `client::emit_baselines` sends it, in chunks of `per`: every op numbered, and
/// each chunk's first op carrying the horizon and the head.
fn emit(conn: &Connection, device: &str, per: usize) -> Vec<Vec<Op>> {
    let begun = emission::begin(conn).unwrap();
    let mut ops = baseline::build(conn, device).unwrap();
    baseline::number(&mut ops, &begun);
    let horizon = baseline::horizon(conn, device).unwrap();
    let n = ops.len();
    ops.chunks(per.max(1))
        .map(|chunk| {
            let mut chunk = chunk.to_vec();
            chunk[0].horizon = Some(horizon.clone());
            baseline::head(&mut chunk[0], n, &begun);
            chunk
        })
        .collect()
}

fn whole(conn: &Connection, device: &str) -> Vec<Op> {
    emit(conn, device, usize::MAX).concat()
}

/// The chunk of a one-op-per-chunk emission that carries `card`'s claim.
fn chunk_of(chunks: &[Vec<Op>], card: &str) -> Vec<Op> {
    chunks
        .iter()
        .find(|c| c[0].fields.get("card_id").and_then(|v| v.as_str()) == Some(card))
        .unwrap()
        .clone()
}

fn page(parts: &[&[Op]]) -> Vec<Op> {
    parts.concat()
}

// ---------------------------------------------------------------------------------------------
// Task 4 — claims leave the watermark (spec §5, §6's inert row, §14 rows 1–4, 14)
// ---------------------------------------------------------------------------------------------

/// §14 row 1. The doorbell rings on the first chunk, so a peer can pull an emission in halves.
#[test]
fn a_baseline_pulled_in_two_halves_reaches_a_device_that_held_nothing() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "c1", 1, 1_700_000_300);
    stash(&a, "c2", 1, 1_700_000_200);
    stash(&a, "c3", 1, 1_700_000_100);
    let chunks = emit(&a, "dev-a", 2);
    assert_eq!(
        chunks.len(),
        2,
        "the seeded folder and three rows, two to a chunk"
    );
    apply(&b, &page(&[&outbox(&a), &chunks[0]])).unwrap();
    apply(&b, &chunks[1]).unwrap();
    assert_eq!(qty(&b), (3, 3));
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), Some((0, 0)));
}

/// §14 row 2. A row held before pairing has no insert on the log; its first edit is sparse.
#[test]
fn a_sparse_op_pulled_ahead_of_its_baseline_does_not_cost_the_row() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    set_clock(&a, STAMP);
    stash(&a, "bolt", 4, SECOND - 100);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    step(&a, "bolt", 1, SECOND);
    apply(&b, &outbox(&a)).unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(copies(&b, "bolt"), 5);
}

/// §14 row 3. An op of a's lands first, so b's watermark sits above the binder's claim.
#[test]
fn a_first_contact_parent_below_the_watermark_lands_with_its_child() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    let binder = folder(&a, "Binder", 1_700_000_000);
    file_in(&a, "bolt", 2, binder, SECOND + 10);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    stash(&a, "opt", 1, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let report = apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(report.deferred, 0, "{report:?}");
    assert_eq!(folder_of(&b, "bolt").as_deref(), Some("Binder"));
    assert_eq!(copies(&b, "bolt"), 2);
}

/// §14 row 4. The sender's clock runs ahead; an applied edit lifts the watermark above a later
/// chunk's claim for a row with no op.
#[test]
fn a_later_chunk_lands_after_an_edit_from_a_fast_clock() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    stash(&a, "opt", 1, SECOND - 5);
    a.execute("DELETE FROM sync_ops WHERE seq > ?1", [ma])
        .unwrap();
    set_clock(&a, STAMP + 3_600_000);
    step(&a, "bolt", 1, SECOND);
    let edit = since(&a, &mut ma);
    let chunks = emit(&a, "dev-a", 1);
    apply(&b, &page(&[&edit, &chunk_of(&chunks, "bolt")])).unwrap();
    apply(&b, &chunk_of(&chunks, "opt")).unwrap();
    assert_eq!((copies(&b, "bolt"), copies(&b, "opt")), (3, 1));
}

/// §14 row 14. A claim waiting on its parent is held alone: its emitter's ordinary op lands.
#[test]
fn a_claim_held_mid_emission_lands_once_and_holds_nothing_else() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    let binder = folder(&a, "Binder", SECOND);
    file_in(&a, "bolt", 2, binder, SECOND);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    let chunks = emit(&a, "dev-a", 1);
    stash(&a, "opt", 1, SECOND + 1);
    let later = since(&a, &mut ma);

    let first = apply(&b, &page(&[&chunk_of(&chunks, "bolt"), &later])).unwrap();
    assert_eq!(first.held_waiting, 1, "{first:?}");
    assert_eq!(
        copies(&b, "opt"),
        1,
        "a held claim held its emitter's ordinary op"
    );
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), None);

    let all = chunks.concat();
    apply(&b, &page(&[&all, &later])).unwrap();
    assert_eq!(
        (copies(&b, "bolt"), folder_of(&b, "bolt").as_deref()),
        (2, Some("Binder"))
    );
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), Some((0, 0)));

    let third = apply(&b, &page(&[&all, &later])).unwrap();
    assert_eq!(third.applied, 0, "{third:?}");
}

/// Spec §6's inert row: a taken generation's re-broadcast is skipped with no database work.
#[test]
fn a_taken_generations_rebroadcast_writes_nothing() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), Some((0, 0)));
    b.execute("UPDATE collection_entries SET quantity = 1", [])
        .unwrap();
    let again = apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!((again.applied, copies(&b, "bolt")), (0, 1), "{again:?}");
}

/// Review Focus 1.
#[test]
fn a_claim_whose_head_is_missing_is_judged_as_one_with_no_reference() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    let mut ops = whole(&a, "dev-a");
    for op in &mut ops {
        if let Some(e) = op.emission.as_mut() {
            e.n = None;
            e.since = None;
        }
    }
    apply(&b, &ops).unwrap();
    assert_eq!(copies(&b, "bolt"), 2);
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), None);
}

/// Review Focus 2.
#[test]
fn an_emission_with_no_count_is_never_taken_and_still_applies_once() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    let mut ops = whole(&a, "dev-a");
    ops[0].emission.as_mut().unwrap().n = Some(0);
    apply(&b, &ops).unwrap();
    b.execute("UPDATE collection_entries SET quantity = 1", [])
        .unwrap();
    let again = apply(&b, &ops).unwrap();
    assert_eq!((again.applied, copies(&b, "bolt")), (0, 1), "{again:?}");
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), None);
}

/// Review Focus 4.
#[test]
fn a_taken_mark_that_does_not_parse_leaves_the_emission_active() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    b.execute(
        "INSERT INTO sync_state (key, value) VALUES ('taken@dev-a', 'garbage')",
        [],
    )
    .unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(copies(&b, "bolt"), 2);
}

/// §14 row 28 — the upgrade boundary (spec §10). An older build applied a page holding a newer
/// emitter's emission, ignoring its references, and recorded nothing; the page comes back after
/// the upgrade, behind a first apply that brought nothing of that emitter's. Read as active, its
/// covered puts would go down the op path into a row the old build built from the claim: 5.
#[test]
fn a_page_an_older_build_applied_writes_nothing_again_after_the_upgrade() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    stash(&a, "c1", 1, 1_700_000_000);
    a.execute("UPDATE collection_entries SET quantity = 3", [])
        .unwrap();
    let page_ = page(&[&outbox(&a), &whole(&a, "dev-a")]);

    // The older build's apply: the same page with its references ignored, and nothing recorded.
    let mut unreferenced = page_.clone();
    for op in &mut unreferenced {
        op.emission = None;
    }
    apply(&b, &unreferenced).unwrap();
    assert_eq!(copies(&b, "c1"), 3);
    b.execute(
        "DELETE FROM sync_state
          WHERE key = 'emissions_since' OR key GLOB 'emission@*' OR key GLOB 'taken@*'",
        [],
    )
    .unwrap();
    b.execute("UPDATE collection_entries SET quantity = 2", [])
        .unwrap();

    // The first apply under this build holds nothing of a's, and mints the cut.
    stash(&c, "opt", 1, 1_700_000_000);
    apply(&b, &outbox(&c)).unwrap();

    let again = apply(&b, &page_).unwrap();
    assert_eq!((again.applied, copies(&b, "c1")), (0, 2), "{again:?}");
}

/// Spec §3: only a claim carries a reference. A malformed peer's ORDINARY op that names an
/// emission — head, horizon and all — is judged exactly as `main` judges it: below its sender's
/// watermark, it is skipped as seen, writes nothing, and leaves no mark in the ledger.
#[test]
fn an_ordinary_op_that_names_an_emission_is_judged_as_one_with_no_reference() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    let captured = outbox(&a);
    apply(&b, &captured).unwrap();
    assert_eq!(copies(&b, "bolt"), 2);

    let mut forged = captured.clone();
    let op = forged
        .iter_mut()
        .find(|op| op.table == "collection_entries")
        .unwrap();
    assert!(!op.baseline);
    let mut horizon = Horizon::default();
    horizon.seen.insert("dev-a".to_owned(), op.at.clone());
    op.horizon = Some(horizon);
    op.emission = Some(crate::sync_engine::merge::Emission {
        id: (op.at.ms + 1, 0),
        i: 0,
        n: Some(1),
        since: Some((0, 0)),
        resumed: false,
    });

    let again = apply(&b, &forged).unwrap();
    assert_eq!(
        (again.applied, again.skipped, copies(&b, "bolt")),
        (0, forged.len(), 2),
        "{again:?}"
    );
    assert_eq!(ledger(&b), 0, "an ordinary op is never a claim");
}

/// How many `emission@` and `taken@` marks a device holds.
fn ledger(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM sync_state WHERE key GLOB 'emission@*' OR key GLOB 'taken@*'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// This device's own emission, handed back by the relay with the rest of the group's log, is
/// judged as `main` judges it — dropped as its own — and the ledger records nothing about it: a
/// device never consumes, and never takes, an emission of its own.
#[test]
fn this_devices_own_emission_handed_back_writes_nothing_and_leaves_no_mark() {
    let b = paired("dev-b");
    stash(&b, "bolt", 2, 1_700_000_000);
    let own = page(&[&outbox(&b), &whole(&b, "dev-b")]);
    let report = apply(&b, &own).unwrap();
    assert_eq!(
        (report.applied, report.skipped, copies(&b, "bolt")),
        (0, own.len(), 2),
        "{report:?}"
    );
    assert_eq!(
        ledger(&b),
        0,
        "a device keeps no record of its own emission"
    );
}
