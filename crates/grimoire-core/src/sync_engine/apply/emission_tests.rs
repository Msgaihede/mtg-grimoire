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

fn rows(conn: &Connection, card: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .unwrap()
}

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

/// Where `conn`'s watermark for `device` stands, as `(ms, ctr)`.
fn watermark(conn: &Connection, device: &str) -> (i64, i64) {
    conn.query_row(
        "SELECT last_ms, last_ctr FROM sync_peers WHERE device_id = ?1",
        [device],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

/// Spec §5: a claim never moves `sync_peers`. Row 3's shape, where the binder's copy is claimed
/// at an `updated_at` above a's last ordinary op; then an ordinary op of a's stamped between the
/// two. Had the claim raised the watermark, that op would be skipped as seen and lost: the fast
/// `updated_at` of §1, costing the ops its emitter logged below it.
#[test]
fn a_claim_never_moves_its_emitters_watermark() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    let binder = folder(&a, "Binder", 1_700_000_000);
    file_in(&a, "bolt", 2, binder, SECOND + 10);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    stash(&a, "opt", 1, SECOND);
    let first = since(&a, &mut ma);
    let last = first.last().unwrap().at.clone();
    apply(&b, &first).unwrap();

    let claims = whole(&a, "dev-a");
    let bolt = claims
        .iter()
        .find(|op| op.fields.get("card_id").and_then(|v| v.as_str()) == Some("bolt"))
        .unwrap()
        .at
        .clone();
    assert!(
        bolt > last,
        "the claim is stamped above a's last ordinary op"
    );
    apply(&b, &claims).unwrap();
    assert_eq!(copies(&b, "bolt"), 2);
    assert_eq!(
        watermark(&b, "dev-a"),
        (last.ms, last.ctr),
        "a claim moved its emitter's watermark"
    );

    set_clock(&a, STAMP + 5_000);
    step(&a, "opt", 1, SECOND);
    let between = since(&a, &mut ma);
    assert!(
        !between.is_empty() && between.iter().all(|op| op.at > last && op.at < bolt),
        "{between:?}"
    );
    let report = apply(&b, &between).unwrap();
    assert_eq!(
        (report.applied, report.skipped, copies(&b, "opt")),
        (between.len(), 0, 2),
        "{report:?}"
    );
}

/// Spec §5: a claim is never collateral of its emitter's held op by stamp. a's copy filed in a
/// binder the page does not carry holds dev-a at its stamp; a's claim for an unrelated row,
/// stamped above it, lands all the same, and the copy alone waits.
#[test]
fn a_claim_above_its_emitters_held_op_is_not_held_with_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    stash(&a, "opt", 1, SECOND + 10);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    // Minted before the filed op: an op captured before the emission is inside its horizon, and
    // §6 drops it on a row not here — it would never wait.
    let claim = chunk_of(&emit(&a, "dev-a", 1), "opt");
    set_clock(&a, STAMP);
    let binder = folder(&a, "Binder", SECOND);
    file_in(&a, "bolt", 2, binder, SECOND);
    let filed: Vec<Op> = since(&a, &mut ma)
        .into_iter()
        .filter(|op| op.table == "collection_entries")
        .collect();
    assert_eq!(filed.len(), 1, "{filed:?}");
    assert!(
        claim[0].at > filed[0].at,
        "the claim is stamped above the held op"
    );

    let report = apply(&b, &page(&[&filed, &claim])).unwrap();
    assert_eq!(report.held_waiting, 1, "{report:?}");
    assert_eq!(
        (rows(&b, "bolt"), copies(&b, "opt")),
        (0, 1),
        "the claim was held as collateral of its emitter's waiting op: {report:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// Task 5 — the row table (spec §6, §14 rows 5–9, 11–12, 15, 18, 22, 24–27)
// ---------------------------------------------------------------------------------------------

/// Moves a device's whole op log a minute into the past, so a claim stamped from a row's
/// `updated_at` (written now) reads as later than every op a peer has applied.
fn age_ops(conn: &Connection) {
    conn.execute_batch(
        "UPDATE sync_ops SET hlc_ms = hlc_ms - 60000;
         UPDATE sync_clock SET ms = ms - 60000;
         UPDATE collection_entries SET updated_at = updated_at - 60;",
    )
    .unwrap();
}

fn real_stash(conn: &Connection, card: &str, n: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES (?1,'lea','1','en','nonfoil','NM',?2,unixepoch(),unixepoch())",
        rusqlite::params![card, n],
    )
    .unwrap();
}

/// §14 row 5 — the tombstone face.
#[test]
fn a_claim_does_not_lose_the_add_wins_its_own_edit_would_win() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("DELETE FROM collection_entries", []).unwrap();
    set_clock(&a, STAMP + 3_600_000);
    step(&a, "bolt", 1, SECOND);
    let edit = since(&a, &mut ma);
    apply(&b, &page(&[&edit, &whole(&a, "dev-a")])).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!((copies(&a, "bolt"), copies(&b, "bolt")), (3, 3));
}

fn minus_one(take_first: bool, step_at: i64) -> (i64, i64) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 3, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    if take_first {
        apply(&b, &whole(&a, "dev-a")).unwrap();
    }
    step(&a, "bolt", -1, step_at);
    apply(&b, &page(&[&since(&a, &mut ma), &whole(&a, "dev-a")])).unwrap();
    (copies(&a, "bolt"), copies(&b, "bolt"))
}

/// §14 row 6.
#[test]
fn a_removal_sent_with_a_rebaseline_reaches_a_device_that_holds_the_row() {
    for take_first in [false, true] {
        for step_at in [SECOND, SECOND + 5] {
            assert_eq!(
                minus_one(take_first, step_at),
                (2, 2),
                "taken {take_first}, at {step_at}"
            );
        }
    }
}

fn plus_one_each_side(take_first: bool) -> (i64, i64) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    if take_first {
        apply(&b, &whole(&a, "dev-a")).unwrap();
    }
    step(&b, "bolt", 1, SECOND);
    step(&a, "bolt", 1, SECOND + 5);
    apply(&b, &page(&[&since(&a, &mut ma), &whole(&a, "dev-a")])).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    (copies(&a, "bolt"), copies(&b, "bolt"))
}

/// §14 row 7.
#[test]
fn a_copy_added_on_each_side_is_two_copies() {
    for take_first in [false, true] {
        assert_eq!(plus_one_each_side(take_first), (4, 4), "taken {take_first}");
    }
}

/// §14 row 8.
#[test]
fn a_note_written_there_after_it_heard_this_devices_wins_here_too() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("UPDATE collection_entries SET notes = 'mine'", [])
        .unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    a.execute("UPDATE collection_entries SET notes = 'theirs'", [])
        .unwrap();
    apply(&b, &page(&[&since(&a, &mut ma), &whole(&a, "dev-a")])).unwrap();
    assert_eq!(
        (note(&a, "bolt"), note(&b, "bolt")),
        ("theirs".to_owned(), "theirs".to_owned())
    );
}

/// §14 row 9.
#[test]
fn an_edit_whose_claim_is_in_a_later_chunk_lands_at_once() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    step(&a, "bolt", 1, SECOND);
    let edit = since(&a, &mut ma);
    let chunks = emit(&a, "dev-a", 1);
    let folder_chunk = chunks
        .iter()
        .find(|c| c[0].table == "collection_folders")
        .unwrap()
        .clone();
    apply(&b, &page(&[&edit, &folder_chunk])).unwrap();
    assert_eq!(
        copies(&b, "bolt"),
        3,
        "the edit waited for a chunk it did not need"
    );
    apply(&b, &chunk_of(&chunks, "bolt")).unwrap();
    assert_eq!(copies(&b, "bolt"), 3);
}

fn removal_meanwhile(take_first: bool) -> (i64, i64) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    real_stash(&a, "bolt", 3);
    age_ops(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    if take_first {
        apply(&b, &whole(&a, "dev-a")).unwrap();
    }
    b.execute("UPDATE collection_entries SET quantity = quantity - 1", [])
        .unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    b.execute("UPDATE collection_entries SET quantity = quantity - 1", [])
        .unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    (copies(&a, "bolt"), copies(&b, "bolt"))
}

fn note_meanwhile(take_first: bool) -> (String, String) {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    real_stash(&a, "bolt", 2);
    age_ops(&a);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&c, &seed).unwrap();
    if take_first {
        apply(&b, &whole(&a, "dev-a")).unwrap();
    }
    c.execute("UPDATE collection_entries SET purchase_price = 1.5", [])
        .unwrap();
    let price = since(&c, &mut mc);
    apply(&a, &price).unwrap();
    apply(&b, &price).unwrap();
    let rebroadcast = whole(&a, "dev-a");
    c.execute("UPDATE collection_entries SET notes = 'c'", [])
        .unwrap();
    let note_op = since(&c, &mut mc);
    apply(&b, &note_op).unwrap();
    apply(&b, &rebroadcast).unwrap();
    apply(&a, &note_op).unwrap();
    (note(&a, "bolt"), note(&b, "bolt"))
}

fn delete_meanwhile(take_first: bool) -> (i64, i64, i64) {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    real_stash(&a, "bolt", 2);
    age_ops(&a);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&c, &seed).unwrap();
    if take_first {
        apply(&b, &whole(&a, "dev-a")).unwrap();
    }
    c.execute("UPDATE collection_entries SET purchase_price = 1.5", [])
        .unwrap();
    let edit = since(&c, &mut mc);
    apply(&a, &edit).unwrap();
    apply(&b, &edit).unwrap();
    c.execute("DELETE FROM collection_entries", []).unwrap();
    let del = since(&c, &mut mc);
    apply(&b, &del).unwrap();
    let rebroadcast = whole(&a, "dev-a");
    apply(&b, &rebroadcast).unwrap();
    apply(&a, &del).unwrap();
    (rows(&a, "bolt"), rows(&b, "bolt"), rows(&c, "bolt"))
}

/// §14 row 11.
#[test]
fn a_rebroadcast_takes_back_nothing_this_device_did_since() {
    for take_first in [false, true] {
        assert_eq!(removal_meanwhile(take_first), (1, 1), "taken {take_first}");
        assert_eq!(
            note_meanwhile(take_first),
            ("c".to_owned(), "c".to_owned()),
            "taken {take_first}"
        );
    }
    assert_eq!(delete_meanwhile(true), (0, 0, 0));
    assert_eq!(
        delete_meanwhile(false),
        (0, 1, 0),
        "owed (design §11): a third device's delete and an active claim resurrect the row here only"
    );
}

fn leave_edit_repair(clock_ahead: bool) -> (i64, String) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    emission::start_logging(&a).unwrap();
    if clock_ahead {
        a.execute_batch(
            "UPDATE sync_clock
                SET ms = cast(unixepoch('subsec') * 1000 AS INTEGER) + 3600000, ctr = 0;",
        )
        .unwrap();
    }
    real_stash(&a, "bolt", 2);
    age_ops(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    a.execute("DELETE FROM sync_group", []).unwrap();
    emission::keep_logging_mark(&a).unwrap();
    a.execute(
        "UPDATE collection_entries
            SET quantity = 4, notes = 'unpaired', updated_at = unixepoch()",
        [],
    )
    .unwrap();
    assert!(
        since(&a, &mut ma).is_empty(),
        "an unpaired edit was captured"
    );
    a.execute(
        "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
         VALUES (1, 'g', 0, x'02', 0)",
        [],
    )
    .unwrap();
    emission::start_logging(&a).unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    (copies(&b, "bolt"), note(&b, "bolt"))
}

/// §14 row 12, the apply half (the identity half is Task 9).
#[test]
fn a_device_back_from_time_out_of_a_group_brings_what_it_did_there() {
    for clock_ahead in [false, true] {
        assert_eq!(
            leave_edit_repair(clock_ahead),
            (4, "unpaired".to_owned()),
            "clock ahead {clock_ahead}"
        );
    }
}

/// §14 row 15.
#[test]
fn a_whole_active_page_handed_back_writes_nothing_the_second_time() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    step(&a, "bolt", 1, SECOND);
    let first = page(&[&outbox(&a), &whole(&a, "dev-a")]);
    apply(&b, &first).unwrap();
    assert_eq!(copies(&b, "bolt"), 3);
    b.execute(
        "UPDATE collection_entries SET quantity = quantity - 1, notes = 'later'",
        [],
    )
    .unwrap();
    let again = apply(&b, &first).unwrap();
    assert_eq!(again.applied, 0, "{again:?}");
    assert_eq!(
        (copies(&b, "bolt"), note(&b, "bolt")),
        (2, "later".to_owned())
    );
}

/// §14 row 18.
#[test]
fn a_grain_twin_and_a_put_carried_through_a_claim_end_at_the_max_everywhere() {
    let (a, b, c, e) = (
        paired("dev-a"),
        paired("dev-b"),
        paired("dev-c"),
        paired("dev-e"),
    );
    let mut mc = 0;
    stash(&a, "bolt", 2, 1_700_000_000);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    stash(&b, "bolt", 3, 1_700_000_000);
    b.execute("DELETE FROM sync_ops", []).unwrap();
    apply(&c, &whole(&a, "dev-a")).unwrap();
    step(&c, "bolt", 1, 1_700_000_100);
    let put = since(&c, &mut mc);
    apply(&a, &put).unwrap();
    apply(&e, &page(&[&put, &whole(&a, "dev-a")])).unwrap();
    assert_eq!(copies(&e, "bolt"), 3);
    apply(&b, &page(&[&put, &whole(&e, "dev-e")])).unwrap();
    assert_eq!(
        copies(&b, "bolt"),
        3,
        "c's +1 was counted on top of b's own row"
    );
}

/// §14 row 22, with emissions: §8.1 and §8.2 keep their answers.
#[test]
fn the_first_pairing_twice_and_the_never_held_undercount_keep_their_answers() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 1, 1_700_000_000);
    a.execute("UPDATE collection_entries SET quantity = 5", [])
        .unwrap();
    let first = page(&[&outbox(&a), &whole(&a, "dev-a")]);
    apply(&b, &first).unwrap();
    apply(&b, &first).unwrap();
    assert_eq!(copies(&b, "bolt"), 5, "§8.1");

    let (a, b) = (paired("dev-a"), paired("dev-b"));
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let claims = whole(&a, "dev-a");
    step(&a, "bolt", 1, SECOND);
    let ops = outbox(&a);
    apply(&b, &page(&[&ops[..1], &claims, &ops[1..]])).unwrap();
    assert_eq!(copies(&b, "bolt"), 2, "§8.2's accepted under-count");
}

/// Review Focus 3.
#[test]
fn an_emission_from_before_a_rejoin_is_inert_beside_one_from_after_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    emission::start_logging(&a).unwrap();
    real_stash(&a, "bolt", 2);
    age_ops(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let old = whole(&a, "dev-a");
    apply(&b, &old).unwrap();
    let first = emission::taken(&b, "dev-a").unwrap();
    a.execute("DELETE FROM sync_group", []).unwrap();
    emission::keep_logging_mark(&a).unwrap();
    a.execute(
        "UPDATE collection_entries SET quantity = 4, updated_at = unixepoch()",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
         VALUES (1, 'g', 0, x'02', 0)",
        [],
    )
    .unwrap();
    emission::start_logging(&a).unwrap();
    apply(&b, &page(&[&old, &whole(&a, "dev-a")])).unwrap();
    assert_eq!(copies(&b, "bolt"), 4);
    assert!(emission::taken(&b, "dev-a").unwrap() > first);
}

/// §14 row 24 — the narrow fix's review-7 double count: `a` hears `c`'s `+1` only through `e`'s
/// claim, adds a copy and re-baselines; `b` meets `c`'s `+1`, `a`'s and `a`'s emission without
/// `e`'s. Then every device reads the rest of the log.
#[test]
fn a_put_one_emitter_took_in_through_anothers_claim_counts_once_everywhere() {
    let (a, b, c, e) = (
        paired("dev-a"),
        paired("dev-b"),
        paired("dev-c"),
        paired("dev-e"),
    );
    let (mut ma, mut mc) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    for peer in [&b, &c, &e] {
        apply(peer, &seed).unwrap();
    }
    step(&c, "bolt", 1, SECOND);
    let y = since(&c, &mut mc);
    apply(&e, &y).unwrap();
    apply(&a, &whole(&e, "dev-e")).unwrap();
    step(&a, "bolt", 1, SECOND);
    let p = since(&a, &mut ma);
    apply(&b, &page(&[&y, &p, &whole(&a, "dev-a")])).unwrap();
    for peer in [&a, &c, &e] {
        apply(peer, &page(&[&y, &p])).unwrap();
    }
    assert_eq!(
        [
            copies(&a, "bolt"),
            copies(&b, "bolt"),
            copies(&c, "bolt"),
            copies(&e, "bolt")
        ],
        [4, 4, 4, 4]
    );
}

/// §14 row 25 — review 7's removal: `b` meets `c`'s `-1` inside `e`'s horizon beside a chunk
/// carrying only another card's claim, then `a`'s `+1` and re-baseline from before `a` heard of
/// the removal.
#[test]
fn a_removal_beside_a_chunk_of_another_cards_claim_is_never_floored_over() {
    let (a, b, c, e) = (
        paired("dev-a"),
        paired("dev-b"),
        paired("dev-c"),
        paired("dev-e"),
    );
    let (mut ma, mut mc, mut me) = (0, 0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    for peer in [&b, &c, &e] {
        apply(peer, &seed).unwrap();
    }
    stash(&e, "opt", 1, SECOND);
    let from_e = since(&e, &mut me);
    apply(&a, &from_e).unwrap();
    apply(&b, &from_e).unwrap();
    step(&c, "bolt", -1, SECOND);
    let removed = since(&c, &mut mc);
    apply(&e, &removed).unwrap();
    let e_chunks = emit(&e, "dev-e", 1);
    apply(&b, &page(&[&removed, &chunk_of(&e_chunks, "opt")])).unwrap();
    step(&a, "bolt", 1, SECOND);
    apply(&b, &page(&[&since(&a, &mut ma), &whole(&a, "dev-a")])).unwrap();
    apply(&a, &removed).unwrap();
    assert_eq!((copies(&a, "bolt"), copies(&b, "bolt")), (2, 2));
}

/// §14 row 26 — a `+1` re-baseline, then a `-1` one.
#[test]
fn a_rebaseline_with_a_copy_added_then_one_with_it_removed_end_where_they_began() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    step(&a, "bolt", 1, SECOND);
    apply(&b, &page(&[&since(&a, &mut ma), &whole(&a, "dev-a")])).unwrap();
    assert_eq!(copies(&b, "bolt"), 3);
    step(&a, "bolt", -1, SECOND);
    apply(&b, &page(&[&since(&a, &mut ma), &whole(&a, "dev-a")])).unwrap();
    assert_eq!((copies(&a, "bolt"), copies(&b, "bolt")), (2, 2));
}

/// §14 row 27, first half — a third device's new row, inside the emitter's horizon.
#[test]
fn a_third_devices_new_row_inside_the_horizon_lands() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    stash(&c, "opt", 1, 1_700_000_000);
    let from_c = outbox(&c);
    apply(&a, &from_c).unwrap();
    apply(&b, &page(&[&from_c, &whole(&a, "dev-a")])).unwrap();
    assert_eq!(copies(&b, "opt"), 1);
}

/// §14 row 27, second half — an emitter behind this device, on another row, still brings its edit.
#[test]
fn an_emitter_behind_this_device_on_another_row_still_brings_its_edit() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    stash(&c, "opt", 1, 1_700_000_000);
    apply(&b, &since(&c, &mut mc)).unwrap();
    step(&a, "bolt", 1, SECOND);
    apply(&b, &page(&[&since(&a, &mut ma), &whole(&a, "dev-a")])).unwrap();
    assert_eq!(copies(&b, "bolt"), 3);
}

/// Spec §8 against §6's held-row arm: a whole emission applied to a device that holds its rows
/// under their uids is taken with its claims passed — written nowhere — so no `carried@` mark
/// rises from it. A mark there would cover puts the rows here hold only through this device's log.
#[test]
fn an_emission_whose_claims_passed_on_held_rows_carries_nothing() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    apply(&b, &outbox(&a)).unwrap();
    let rebaseline = whole(&a, "dev-a");
    apply(&b, &rebaseline).unwrap();
    assert!(emission::taken(&b, "dev-a").unwrap().is_some());
    assert_eq!(
        emission::carried(&b).unwrap(),
        std::collections::BTreeMap::new(),
        "a claim that wrote nothing carried its horizon"
    );
    let bolt = rebaseline
        .iter()
        .find(|op| op.fields.get("card_id").and_then(|v| v.as_str()) == Some("bolt"))
        .and_then(|op| op.emission.as_ref())
        .unwrap()
        .i;
    assert!(
        emission::records(&b, "dev-a").unwrap()[0]
            .passed
            .contains(bolt),
        "the held row's claim is recorded as passed"
    );
}

// ---------------------------------------------------------------------------------------------
// Task 6 — held-back ops and the gap (spec §5, §7, §14 rows 10, 13)
// ---------------------------------------------------------------------------------------------

/// §14 row 10 — the third review's 6-for-3. c's +1 reaches b only later (its client holds c
/// back); e took it in through a's claim, never as an op, and e's claim for the row comes first.
#[test]
fn a_held_back_put_and_a_claim_that_contains_it_count_it_once() {
    for resumed in [false, true] {
        let (a, b, c, e) = (
            paired("dev-a"),
            paired("dev-b"),
            paired("dev-c"),
            paired("dev-e"),
        );
        let (mut ma, mut mc) = (0, 0);
        set_clock(&a, STAMP);
        stash(&a, "bolt", 2, SECOND);
        let seed = since(&a, &mut ma);
        apply(&b, &seed).unwrap();
        apply(&c, &seed).unwrap();
        step(&c, "bolt", 1, SECOND + 1);
        let put = since(&c, &mut mc);
        apply(&a, &put).unwrap();
        apply(&e, &page(&[&seed, &put, &whole(&a, "dev-a")])).unwrap();
        assert_eq!(copies(&e, "bolt"), 3);
        if resumed {
            emission::start_logging(&e).unwrap();
            emission::start_logging(&e).unwrap();
        }
        let from_e = whole(&e, "dev-e");
        apply_page(&b, &from_e, &put, Waiting::Hold).unwrap();
        apply_page(&b, &page(&[&put, &from_e]), &[], Waiting::Hold).unwrap();
        assert_eq!(copies(&b, "bolt"), 3, "resumed {resumed}");
    }
}

/// Row 10's first delivery, which the test above cannot tell apart: the page comes back with e's
/// claim in it, and the record e's emission kept when it was taken already contains the released
/// put, so the count ends at 3 whether or not the put held the claim. What this pins is the hold
/// itself — the put the client held back holds its row's group: the floor waits, the row is
/// untouched, the emission is not taken, and what `apply` answers names the held sender and the
/// claim.
#[test]
fn a_held_back_put_holds_the_claim_for_its_row() {
    let (a, b, c, e) = (
        paired("dev-a"),
        paired("dev-b"),
        paired("dev-c"),
        paired("dev-e"),
    );
    let (mut ma, mut mc) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&c, &seed).unwrap();
    step(&c, "bolt", 1, SECOND + 1);
    let put = since(&c, &mut mc);
    apply(&a, &put).unwrap();
    apply(&e, &page(&[&seed, &put, &whole(&a, "dev-a")])).unwrap();
    emission::start_logging(&e).unwrap();
    emission::start_logging(&e).unwrap();
    let from_e = whole(&e, "dev-e");

    let (_, held) = apply_page(&b, &from_e, &put, Waiting::Hold).unwrap();
    assert_eq!(
        copies(&b, "bolt"),
        2,
        "the claim landed ahead of the put it contains"
    );
    assert_eq!(emission::taken(&b, "dev-e").unwrap(), None);
    assert_eq!(held.get("dev-c"), Some(&(put[0].at.ms, put[0].at.ctr)));
    assert!(
        held.keys().any(|k| k.starts_with("dev-e#")),
        "the held claim answered no block of its own: {held:?}"
    );
}

/// Spec §3: a reference on an op that is no claim is malformed, and is judged absent on every path
/// — a held-back op's included. c's `+1` carries a stray reference while the client holds c back,
/// beside a's `+1` on the same row in the page. Read by its field rather than as a claim, the
/// held-back op held nothing: both deltas landed, no watermark rose for c's, and c's released
/// `+1` applied a second time (5 where 4 is right). Its sender already holds a watermark below
/// it, which the hold must leave where it is.
#[test]
fn a_held_back_op_with_a_stray_reference_holds_its_row_and_applies_once_when_released() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&c, &seed).unwrap();
    stash(&c, "opt", 1, SECOND);
    apply(&b, &since(&c, &mut mc)).unwrap();
    let (a_mark, c_mark) = (watermark(&b, "dev-a"), watermark(&b, "dev-c"));
    step(&c, "bolt", 1, SECOND + 1);
    let mut put = since(&c, &mut mc);
    assert_eq!(put.len(), 1, "{put:?}");
    put[0].emission = Some(crate::sync_engine::merge::Emission {
        id: (put[0].at.ms + 1, 0),
        i: 0,
        n: Some(1),
        since: Some((0, 0)),
        resumed: false,
    });
    step(&a, "bolt", 1, SECOND + 2);
    let from_a = since(&a, &mut ma);

    let (report, held) = apply_page(&b, &from_a, &put, Waiting::Hold).unwrap();
    assert_eq!(
        (report.applied, copies(&b, "bolt")),
        (0, 2),
        "the held-back op did not hold its row: {report:?}"
    );
    assert_eq!(
        (watermark(&b, "dev-a"), watermark(&b, "dev-c")),
        (a_mark, c_mark),
        "a hold moved a watermark"
    );
    assert_eq!(held.get("dev-c"), Some(&(put[0].at.ms, put[0].at.ctr)));

    apply(&b, &page(&[&from_a, &put])).unwrap();
    assert_eq!(copies(&b, "bolt"), 4, "each +1 once");
}

/// Design 2026-10-03 §5: a held-back op is never applied, so it neither drags this device's clock
/// — `observe` reads only what this pass met fresh — nor moves its sender's watermark. c's `+1` is
/// stamped years ahead of b's clock, behind an earlier op of c's that b applied.
#[test]
fn a_held_back_op_moves_neither_the_clock_nor_its_senders_watermark() {
    let (b, c) = (paired("dev-b"), paired("dev-c"));
    let mut mc = 0;
    real_stash(&c, "bolt", 2);
    apply(&b, &since(&c, &mut mc)).unwrap();
    let mark = watermark(&b, "dev-c");
    set_clock(&c, STAMP);
    step(&c, "bolt", 1, SECOND);
    let ahead = since(&c, &mut mc);
    assert!(ahead.iter().all(|op| op.at.ms >= STAMP), "{ahead:?}");
    let clock = || -> i64 {
        b.query_row("SELECT ms FROM sync_clock WHERE id = 1", [], |r| r.get(0))
            .unwrap()
    };
    assert!(clock() < STAMP);

    let (_, held) = apply_page(&b, &[], &ahead, Waiting::Hold).unwrap();
    assert!(clock() < STAMP, "a held-back op dragged the clock");
    assert_eq!(
        watermark(&b, "dev-c"),
        mark,
        "a held-back op moved its watermark"
    );
    assert_eq!(copies(&b, "bolt"), 2);
    assert!(held.contains_key("dev-c"), "{held:?}");
}

/// §14 row 13, the apply half: a group dropped and recorded opens the gap; the next emission
/// floors a row held here; the gap closes when the roster is taken again.
#[test]
fn a_dropped_group_opens_the_gap_and_the_next_emission_floors() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute(
        "INSERT INTO sync_devices (device_id, public_key, name, added_at)
         VALUES ('dev-a', x'00', 'dev-a', 0)",
        [],
    )
    .unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert!(emission::taken(&b, "dev-a").unwrap().is_some());

    stash(&a, "x", 1, SECOND);
    let mut future = since(&a, &mut ma);
    future[0].table = "future_table".to_owned();
    let report = apply(&b, &future).unwrap();
    assert_eq!(report.dropped, 1, "{report:?}");
    assert!(emission::gap_open(&b).unwrap());
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), None);

    b.execute(
        "UPDATE collection_entries SET quantity = 1 WHERE card_id = 'bolt'",
        [],
    )
    .unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(
        copies(&b, "bolt"),
        2,
        "a gap opens the floor (design §6, §11)"
    );
    assert!(
        !emission::gap_open(&b).unwrap(),
        "the roster was taken again"
    );
}

/// Put `device` on `conn`'s roster, so a gap waits for it to be taken again (spec §7).
fn on_roster(conn: &Connection, device: &str) {
    conn.execute(
        "INSERT INTO sync_devices (device_id, public_key, name, added_at)
         VALUES (?1, x'00', ?1, 0)",
        [device],
    )
    .unwrap();
}

/// A claim held alone is a block of its own in what `apply` answers — keyed by its emission and
/// its index, never by its emitter, so it holds nothing of the emitter's stream and no device
/// block absorbs it; a new held claim is a new block, which is what restarts the client's
/// waiting bound (design 2026-10-03 §5).
#[test]
fn a_claim_held_alone_is_a_block_of_its_own_in_what_apply_answers() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    set_clock(&a, STAMP);
    let binder = folder(&a, "Binder", SECOND);
    file_in(&a, "bolt", 2, binder, SECOND);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    let claim = chunk_of(&emit(&a, "dev-a", 1), "bolt");

    let (report, held) = apply_held(&b, &claim, Waiting::Hold).unwrap();
    assert_eq!(report.held_waiting, 1, "{report:?}");
    let em = claim[0].emission.as_ref().unwrap();
    assert_eq!(
        held,
        Held::from([(
            format!("dev-a#{}.{}#{}", em.id.0, em.id.1, em.i),
            (claim[0].at.ms, claim[0].at.ctr),
        )]),
        "a held claim answered no block, or one that names its emitter"
    );
}

/// Spec §7 as amended (a gap keeps what claims wrote): §8.1's page — a's outbox and the emission
/// whose claim carries it — handed back across a gap. The claim that built the row is still
/// consumed and the puts it carried are still inside the row. With the records cleared, the
/// claim floored the row the first delivery built and the carried puts took the op path beside
/// it: `max(5 + 1 + 4, 5)`, 10. The emission was recorded before the gap, so it is never taken
/// and the gap stays open.
#[test]
fn a_page_handed_back_across_a_gap_counts_what_its_claim_carried_once() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    // A watermark for dev-a, and dev-a on the roster, so the gap has an emitter to wait for.
    stash(&a, "opt", 1, 1_700_000_000);
    apply(&b, &since(&a, &mut ma)).unwrap();
    on_roster(&b, "dev-a");
    stash(&a, "bolt", 1, 1_700_000_000);
    a.execute(
        "UPDATE collection_entries SET quantity = 5 WHERE card_id = 'bolt'",
        [],
    )
    .unwrap();
    let first = page(&[&since(&a, &mut ma), &whole(&a, "dev-a")]);
    apply(&b, &first).unwrap();
    assert_eq!(copies(&b, "bolt"), 5);

    emission::open_gap(&b).unwrap();
    apply(&b, &first).unwrap();
    assert_eq!(copies(&b, "bolt"), 5, "§8.1 across a gap");
    assert_eq!(
        emission::taken(&b, "dev-a").unwrap(),
        None,
        "an emission recorded before the gap was taken"
    );
    assert!(
        emission::gap_open(&b).unwrap(),
        "an emission recorded before the gap closed it"
    );
}

/// Spec §7 as amended: a claim that PASSED on a held row before a gap is decided again after it
/// — the gap is the one time a held row may lack what the log should have brought — and floors.
/// Its emission was recorded before the gap, so it is never taken and cannot close the gap.
#[test]
fn a_claim_passed_before_a_gap_floors_after_it_and_takes_nothing() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    on_roster(&b, "dev-a");
    let rebaseline = whole(&a, "dev-a");
    apply(&b, &rebaseline).unwrap();
    assert!(emission::taken(&b, "dev-a").unwrap().is_some());

    emission::open_gap(&b).unwrap();
    b.execute(
        "UPDATE collection_entries SET quantity = 1 WHERE card_id = 'bolt'",
        [],
    )
    .unwrap();
    apply(&b, &rebaseline).unwrap();
    assert_eq!(
        copies(&b, "bolt"),
        2,
        "a claim passed before the gap did not floor after it"
    );
    assert_eq!(
        emission::taken(&b, "dev-a").unwrap(),
        None,
        "an emission recorded before the gap was taken"
    );
    assert!(
        emission::gap_open(&b).unwrap(),
        "an emission recorded before the gap closed it"
    );
}

// ---------------------------------------------------------------------------------------------
// Task 7 — a row nothing changed keeps its modification time (spec §9, §14 row 21)
// ---------------------------------------------------------------------------------------------

fn updated_at(conn: &Connection, card: &str) -> i64 {
    conn.query_row(
        "SELECT updated_at FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .unwrap()
}

/// An op whose only field loses to a later edit made here changes nothing.
#[test]
fn an_op_whose_every_field_lost_leaves_updated_at_alone() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    stash(&a, "bolt", 2, 1_700_000_000);
    apply(&b, &since(&a, &mut ma)).unwrap();
    a.execute("UPDATE collection_entries SET notes = 'old'", [])
        .unwrap();
    let older = since(&a, &mut ma);
    set_clock(&b, STAMP);
    b.execute("UPDATE collection_entries SET notes = 'newer'", [])
        .unwrap();
    b.execute("UPDATE collection_entries SET updated_at = 1600000000", [])
        .unwrap();
    apply(&b, &older).unwrap();
    assert_eq!(
        (note(&b, "bolt"), updated_at(&b, "bolt")),
        ("newer".to_owned(), 1_600_000_000)
    );
}

/// A floor equal to what is here changes nothing either.
#[test]
fn a_claim_that_changes_nothing_leaves_updated_at_alone() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    stash(&a, "bolt", 2, 1_700_000_000);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("UPDATE collection_entries SET updated_at = 1600000000", [])
        .unwrap();
    emission::start_logging(&a).unwrap();
    emission::start_logging(&a).unwrap(); // resumed: the claim floors this held row
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(
        (copies(&b, "bolt"), updated_at(&b, "bolt")),
        (2, 1_600_000_000)
    );
}

/// ...and a deck keeps its place in the gallery, which sorts by `decks.updated_at`.
#[test]
fn a_deck_a_claim_changed_nothing_on_keeps_its_place_in_the_gallery() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a.execute(
        "INSERT INTO decks (name, created_at, updated_at) VALUES ('Krenko', 1700000000, 1700000000)",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("UPDATE decks SET updated_at = 1600000000", [])
        .unwrap();
    emission::start_logging(&a).unwrap();
    emission::start_logging(&a).unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    let at: i64 = b
        .query_row(
            "SELECT updated_at FROM decks WHERE name = 'Krenko'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(at, 1_600_000_000);
}
