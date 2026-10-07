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

fn add_copy(conn: &Connection) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',1,unixepoch(),unixepoch())",
        [],
    )
    .unwrap();
}

/// `error_log` as a skip writes it: `(source, operation, message, detail, count)`.
fn skips(conn: &Connection) -> Vec<(String, String, String, Option<String>, i64)> {
    let mut stmt = conn
        .prepare("SELECT source, operation, message, detail, count FROM error_log ORDER BY id")
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap();
    rows.map(Result::unwrap).collect()
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
/// held-back op was applied with no watermark rising for it, and c's released `+1` applied a second
/// time (5 where 4 is right). Its sender already holds a watermark below it, which must stay where
/// it is.
///
/// **The expectation changed under the final review's I1 ruling** (2026-10-03). The page carries
/// no claim for bolt, so c's held-back op joins no group and holds nothing: a's `+1` applies at
/// once — this test used to pin it held, at (0, 2) — and `apply` answers no block for c, whose
/// cursor the client holds itself. c's op is still not applied and raises no watermark, and the
/// release still applies each `+1` once.
#[test]
fn a_held_back_op_with_a_stray_reference_is_not_applied_and_applies_once_when_released() {
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
        (1, 3),
        "a's +1 alone lands: {report:?}"
    );
    let a_now = (from_a[0].at.ms, from_a[0].at.ctr);
    assert!(a_now > a_mark, "{a_now:?} over {a_mark:?}");
    assert_eq!(
        (watermark(&b, "dev-a"), watermark(&b, "dev-c")),
        (a_now, c_mark),
        "the held-back op moved its sender's watermark"
    );
    assert_eq!(held.get("dev-c"), None, "{held:?}");

    apply(&b, &page(&[&from_a, &put])).unwrap();
    assert_eq!(copies(&b, "bolt"), 4, "each +1 once");
}

/// The test above where the held-back op does join a group (the final review's I1 ruling keeps
/// it to one that carries a claim): c's `+1` with a stray reference meets e's claim for bolt, which
/// a gap here makes the floor of the row b holds. The reference is taken off before the op is
/// grouped; left on, `held_by`, `blocks_of` and `advance_watermarks` each passed over the op, so the
/// claim's group was written with c's `+1` in it, no watermark rose for it, and the release
/// applied it a second time.
#[test]
fn a_held_back_op_with_a_stray_reference_holds_the_claim_for_its_row() {
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
    let from_e = whole(&e, "dev-e");
    emission::open_gap(&b).unwrap();

    let (_, held) = apply_page(&b, &from_e, &put, Waiting::Hold).unwrap();
    assert_eq!(
        copies(&b, "bolt"),
        2,
        "the claim's group was written with the held-back op in it"
    );
    assert!(held.contains_key("dev-c"), "{held:?}");

    apply(&b, &page(&[&from_e, &put])).unwrap();
    assert_eq!(copies(&b, "bolt"), 3, "c's +1 once, under e's floor");
}

/// Design 2026-10-03 §5: a held-back op is never applied, so it neither drags this device's clock
/// — `observe` reads only what this pass met fresh — nor moves its sender's watermark. c's `+1` is
/// stamped years ahead of b's clock, behind an earlier op of c's that b applied.
///
/// **Under the final review's I1 ruling** (2026-10-03) the op joins only a group that carries a
/// claim, so on a page with none `apply` answers no block for c — this test used to expect one —
/// and the client holds c's cursor itself. The second delivery puts e's claim for bolt beside it,
/// which the op joins and holds: the case where it is grouped, and where `observe` must still leave
/// it out.
#[test]
fn a_held_back_op_moves_neither_the_clock_nor_its_senders_watermark() {
    let (b, c, e) = (paired("dev-b"), paired("dev-c"), paired("dev-e"));
    let mut mc = 0;
    real_stash(&c, "bolt", 2);
    let first = since(&c, &mut mc);
    apply(&b, &first).unwrap();
    apply(&e, &first).unwrap();
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
    assert!(!held.contains_key("dev-c"), "{held:?}");

    // A gap makes e's claim the floor of the row b holds, so it goes to the fold and c's op joins it.
    emission::open_gap(&b).unwrap();
    let (_, held) = apply_page(&b, &whole(&e, "dev-e"), &ahead, Waiting::Hold).unwrap();
    assert!(held.contains_key("dev-c"), "the op held no claim: {held:?}");
    assert!(
        clock() < STAMP,
        "a held-back op in a group dragged the clock"
    );
    assert_eq!(
        watermark(&b, "dev-c"),
        mark,
        "a held-back op in a group moved its watermark"
    );
    assert_eq!(copies(&b, "bolt"), 2);
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

// ---------------------------------------------------------------------------------------------
// Task 8 — the narrow fix's fences (spec §14 row 29)
// ---------------------------------------------------------------------------------------------

/// Task 7's deferred minor: an apply that does change a row — a field that wins, or a resumed
/// claim that raises a held row's counter — still stamps it, through the combined `UPDATE`.
#[test]
fn an_apply_that_changes_a_row_still_moves_its_updated_at() {
    // An op whose field wins over the row here.
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    stash(&a, "bolt", 2, 1_700_000_000);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("UPDATE collection_entries SET updated_at = 1600000000", [])
        .unwrap();
    a.execute("UPDATE collection_entries SET notes = 'newer'", [])
        .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(note(&b, "bolt"), "newer");
    let field = updated_at(&b, "bolt");

    // A resumed claim that raises a held row's counter.
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    stash(&a, "bolt", 2, 1_700_000_000);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute(
        "UPDATE collection_entries SET quantity = 1, updated_at = 1600000000",
        [],
    )
    .unwrap();
    emission::start_logging(&a).unwrap();
    emission::start_logging(&a).unwrap(); // resumed: the claim floors this held row
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(copies(&b, "bolt"), 2);
    let counter = updated_at(&b, "bolt");

    assert!(
        field > 1_600_000_000 && counter > 1_600_000_000,
        "an apply that changed the row left its stamp: field {field}, counter {counter}"
    );
}

/// `597d19d6`: a re-baseline carries an edit made in the second the peer last heard from.
#[test]
fn a_rebaseline_carries_an_edit_made_in_the_second_the_peer_last_heard_from() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();

    step(&a, "bolt", 1, SECOND);
    let mut page = since(&a, &mut ma);
    page.extend(whole(&a, "dev-a"));
    let horizon = page.iter().find_map(|o| o.horizon.clone()).unwrap();
    assert!(
        horizon.covers(&page[0].at),
        "the edit is not inside the horizon, so this fixture proves nothing"
    );

    apply(&b, &page).unwrap();
    assert_eq!(copies(&a, "bolt"), 3);
    assert_eq!(
        copies(&b, "bolt"),
        3,
        "the third copy never reached the peer"
    );
    let again = apply(&b, &page).unwrap();
    assert_eq!(
        (again.applied, copies(&b, "bolt")),
        (0, 3),
        "the page handed back let the claim through again: {again:?}"
    );

    // ...and the stream goes on from there: the next op applies once.
    step(&a, "bolt", 1, SECOND);
    let next = since(&a, &mut ma);
    apply(&b, &next).unwrap();
    assert_eq!(copies(&b, "bolt"), 4);
}

/// `597d19d6`: a re-baseline carries an edit from a device whose clock runs ahead.
#[test]
fn a_rebaseline_carries_an_edit_from_a_device_whose_clock_runs_ahead() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a.execute_batch(
        "UPDATE sync_clock
            SET ms = cast(unixepoch('subsec') * 1000 AS INTEGER) + 3600000, ctr = 0;",
    )
    .unwrap();
    add_copy(&a);
    // The add was ten minutes ago, by the op's stamp, the clock's and the row's.
    a.execute_batch(
        "UPDATE sync_ops SET hlc_ms = hlc_ms - 600000;
         UPDATE sync_clock SET ms = ms - 600000;
         UPDATE collection_entries SET updated_at = updated_at - 600;",
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();

    a.execute(
        "UPDATE collection_entries SET quantity = quantity + 1, updated_at = unixepoch()",
        [],
    )
    .unwrap();
    let mut page = since(&a, &mut ma);
    page.extend(whole(&a, "dev-a"));

    apply(&b, &page).unwrap();
    assert_eq!(qty(&a), (1, 2));
    assert_eq!(qty(&b), (1, 2), "the second copy never reached the peer");
}

/// `597d19d6`: a third device's op inside the horizon lands through the claim.
#[test]
fn a_third_devices_op_inside_the_horizon_lands_through_the_claim() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&c, &seed).unwrap();

    step(&c, "bolt", 1, SECOND);
    let from_c: Vec<Op> = outbox(&c);
    apply(&a, &from_c).unwrap();
    let mut page = from_c.clone();
    page.extend(whole(&a, "dev-a"));
    let horizon = page.iter().find_map(|o| o.horizon.clone()).unwrap();
    assert!(
        horizon.covers(&from_c[0].at),
        "the third device's op is not inside the horizon, so this fixture proves nothing"
    );

    apply(&b, &page).unwrap();
    assert_eq!(
        copies(&b, "bolt"),
        3,
        "the third device's copy never arrived"
    );
}

/// `597d19d6`: a claim let through is applied once, however often its page comes back.
#[test]
fn a_claim_let_through_is_applied_once_however_often_its_page_comes_back() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&c, &seed).unwrap();
    step(&c, "bolt", 1, SECOND);
    let from_c: Vec<Op> = outbox(&c);
    apply(&a, &from_c).unwrap();
    let mut page = from_c.clone();
    page.extend(whole(&a, "dev-a"));

    apply(&b, &page).unwrap();
    assert_eq!(copies(&b, "bolt"), 3);

    step(&b, "bolt", -1, SECOND);
    for delivery in ["second", "third"] {
        let report = apply(&b, &page).unwrap();
        assert_eq!(report.applied, 0, "{delivery}: {report:?}");
        assert_eq!(
            copies(&b, "bolt"),
            2,
            "{delivery}: the claim came back over a copy removed here"
        );
    }
}

/// `597d19d6`: a first contact's page handed back applies nothing again.
#[test]
fn a_first_contact_page_handed_back_applies_nothing_again() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    step(&a, "bolt", 1, SECOND);
    let mut page = outbox(&a);
    page.extend(whole(&a, "dev-a"));
    assert!(
        page[1].at > page.last().unwrap().at,
        "the edit is not above the claim, so this fixture proves nothing"
    );

    apply(&b, &page).unwrap();
    assert_eq!(copies(&b, "bolt"), 3);
    step(&b, "bolt", -1, SECOND);
    for delivery in ["second", "third"] {
        let report = apply(&b, &page).unwrap();
        assert_eq!(report.applied, 0, "{delivery}: {report:?}");
        assert_eq!(
            copies(&b, "bolt"),
            2,
            "{delivery}: the claim came back over a copy removed here"
        );
    }
}

/// `597d19d6`: a claim is not applied again past a put on a row its emitter deleted.
#[test]
fn a_claim_is_not_applied_again_past_a_put_on_a_deleted_row() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    set_clock(&a, STAMP);
    stash(&a, "gone", 1, SECOND);
    stash(&a, "bolt", 2, SECOND);
    a.execute("DELETE FROM collection_entries WHERE card_id = 'gone'", [])
        .unwrap();
    step(&a, "bolt", 1, SECOND);
    let mut page = outbox(&a);
    page.extend(whole(&a, "dev-a"));

    apply(&b, &page).unwrap();
    assert_eq!(copies(&b, "bolt"), 3);
    step(&b, "bolt", -1, SECOND);
    let again = apply(&b, &page).unwrap();
    assert_eq!(
        (again.applied, copies(&b, "bolt")),
        (0, 2),
        "the claim came back over a copy removed here: {again:?}"
    );
}

/// `597d19d6`: a claim that landed on an earlier page than a put it carries is not applied again.
#[test]
fn a_claim_that_landed_before_its_put_is_not_applied_again() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    stash(&c, "opt", 2, 1_700_000_000);
    let from_c = outbox(&c);
    apply(&a, &from_c).unwrap();
    let claims = whole(&a, "dev-a");

    apply(&b, &claims).unwrap();
    assert_eq!(copies(&b, "opt"), 2);
    step(&b, "opt", -1, 1_700_000_000);
    let mut page = from_c.clone();
    page.extend(claims);
    let again = apply(&b, &page).unwrap();
    assert_eq!(
        (again.applied, copies(&b, "opt")),
        (0, 1),
        "the claim came back over a copy removed here: {again:?}"
    );
}

/// `597d19d6`: a horizon riding a chunk none of whose claims landed is not spent.
#[test]
fn a_horizon_whose_claims_did_not_land_is_not_spent() {
    let (b, c) = (paired("dev-b"), paired("dev-c"));
    let mut mc = 0;
    set_clock(&c, STAMP);
    stash(&c, "bolt", 2, SECOND);
    stash(&c, "opt", 1, SECOND);
    apply(&b, &since(&c, &mut mc)).unwrap();
    step(&c, "opt", 1, SECOND);
    let edit = since(&c, &mut mc);
    let chunks = emit(&c, "dev-c", 1);

    let mut first = edit.clone();
    first.extend(chunk_of(&chunks, "bolt"));
    apply(&b, &first).unwrap();

    let mut second = edit.clone();
    second.extend(chunk_of(&chunks, "opt"));
    apply(&b, &second).unwrap();
    assert_eq!(copies(&b, "opt"), 2, "the step's claim was skipped as seen");
}

/// `597d19d6`: a claim is never let through for a row the page itself deletes
/// — owed (design §11).
#[test]
fn a_claim_is_not_let_through_for_a_row_the_page_deletes() {
    let (a, b, d) = (paired("dev-a"), paired("dev-b"), paired("dev-d"));
    let (mut ma, mut md) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&d, &seed).unwrap();
    d.execute("DELETE FROM collection_entries", []).unwrap();
    let deletion = since(&d, &mut md);
    apply(&b, &deletion).unwrap();
    assert_eq!(qty(&b), (0, 0));

    step(&a, "bolt", 1, SECOND);
    let mut page = since(&a, &mut ma);
    page.extend(whole(&a, "dev-a"));
    page.extend(deletion);
    apply(&b, &page).unwrap();
    assert_eq!(
        qty(&b),
        (1, 3),
        "owed (design §11): a third device's delete and an active claim resurrect the row here only"
    );
}

/// `597d19d6`: nor for a row a delete took on an earlier page — owed (design §11).
#[test]
fn a_claim_is_not_let_through_for_a_row_deleted_before_its_page() {
    let (a, b, d) = (paired("dev-a"), paired("dev-b"), paired("dev-d"));
    let (mut ma, mut md) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&d, &seed).unwrap();
    d.execute("DELETE FROM collection_entries", []).unwrap();
    apply(&b, &since(&d, &mut md)).unwrap();
    assert_eq!(qty(&b), (0, 0));

    step(&a, "bolt", 1, SECOND);
    let mut page = since(&a, &mut ma);
    page.extend(whole(&a, "dev-a"));
    apply(&b, &page).unwrap();
    assert_eq!(
        qty(&b),
        (1, 3),
        "owed (design §11): a third device's delete and an active claim resurrect the row here only"
    );
}

/// `597d19d6`: a claim for a row this device lacks — this design converges.
#[test]
fn a_claim_for_a_row_this_device_lacks_is_not_counted_or_spent() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    stash(&a, "opt", 1, SECOND);
    let mut page = since(&a, &mut ma);
    page.extend(chunk_of(&emit(&a, "dev-a", 1), "opt"));
    apply(&b, &page).unwrap();
    assert_eq!(copies(&b, "opt"), 1, "the claim did not build the row");
    assert_eq!(copies(&b, "opt"), copies(&a, "opt"));
}

/// `597d19d6`: a third device's removal applied here, then a re-baseline — this design converges.
#[test]
fn a_claim_is_not_let_through_over_a_removal_this_device_applied() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&c, &seed).unwrap();
    step(&c, "bolt", -1, SECOND);
    let removed = since(&c, &mut mc);
    apply(&b, &removed).unwrap();

    step(&a, "bolt", 1, SECOND);
    let mut page = since(&a, &mut ma);
    page.extend(whole(&a, "dev-a"));
    apply(&b, &page).unwrap();
    apply(&a, &removed).unwrap();
    assert_eq!((copies(&a, "bolt"), copies(&b, "bolt")), (2, 2));
}

/// `597d19d6`: nor over a removal this device took in through another emitter's claim.
#[test]
fn a_claim_is_not_let_through_over_a_removal_this_device_took_in_through_a_claim() {
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

    let mut first = removed.clone();
    first.extend(whole(&e, "dev-e"));
    apply(&b, &first).unwrap();

    step(&a, "bolt", 1, SECOND);
    let mut second = since(&a, &mut ma);
    second.extend(whole(&a, "dev-a"));
    assert!(
        second
            .iter()
            .find_map(|o| o.horizon.as_ref())
            .is_some_and(|h| h.seen.contains_key("dev-e") && !h.seen.contains_key("dev-c")),
        "a has not heard of e, or has heard of c, so this fixture proves nothing"
    );
    apply(&b, &second).unwrap();
    apply(&a, &removed).unwrap();
    assert_eq!(copies(&a, "bolt"), 2);
    assert!(
        copies(&b, "bolt") <= 2,
        "the claim floored the row over a removal it never heard of: {}",
        copies(&b, "bolt")
    );
}

/// `597d19d6`: a removal made here, then the emitter's re-baseline — this design converges.
#[test]
fn a_claim_is_not_let_through_over_a_removal_made_here_since() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    step(&b, "bolt", -1, SECOND);
    step(&a, "bolt", 1, SECOND);
    let mut page = since(&a, &mut ma);
    page.extend(whole(&a, "dev-a"));
    apply(&b, &page).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!((copies(&a, "bolt"), copies(&b, "bolt")), (2, 2));
}

/// `597d19d6`: a claim is let through only for a put its own emitter's horizon covers.
#[test]
fn a_claim_is_not_let_through_for_a_put_its_emitter_never_held() {
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
    apply(&b, &since(&e, &mut me)).unwrap();
    step(&c, "bolt", 1, SECOND);
    let step_c = since(&c, &mut mc);
    apply(&e, &step_c).unwrap();

    let mut page = step_c.clone();
    page.extend(chunk_of(&emit(&a, "dev-a", 1), "bolt"));
    page.extend(chunk_of(&emit(&e, "dev-e", 1), "opt"));
    apply(&b, &page).unwrap();
    step(&b, "bolt", -1, SECOND);
    let held = copies(&b, "bolt");
    let again = apply(&b, &page).unwrap();
    assert_eq!(
        (again.applied, copies(&b, "bolt")),
        (0, held),
        "a claim that never held the step came back over a copy removed here: {again:?}"
    );
}

/// `597d19d6`: a claim let through does not suppress a later chunk of the same baseline.
#[test]
fn a_later_chunk_is_not_suppressed_by_a_claim_let_through_before_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    stash(&a, "opt", 1, SECOND + 2);
    a.execute("DELETE FROM sync_ops WHERE seq > ?1", [ma])
        .unwrap();
    set_clock(&a, STAMP + 5_000);
    step(&a, "bolt", 1, SECOND);
    let mut first = since(&a, &mut ma);
    let chunks = emit(&a, "dev-a", 1);
    first.extend(chunk_of(&chunks, "bolt"));

    apply(&b, &first).unwrap();
    apply(&b, &chunk_of(&chunks, "opt")).unwrap();
    assert_eq!(
        (copies(&b, "bolt"), copies(&b, "opt")),
        (3, 1),
        "the later chunk's row was skipped as seen"
    );
}

/// `597d19d6`: a count and a move into a binder not yet here — this design converges.
#[test]
fn a_claim_let_through_raises_the_count_and_does_nothing_else() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("UPDATE collection_entries SET updated_at = 1600000000", [])
        .unwrap();
    a.execute(
        "INSERT INTO collection_folders (parent_id, name, kind, sort_order,
                                         created_at, updated_at)
         VALUES (NULL, 'Binder', 'user', 1, ?1, ?1)",
        [SECOND],
    )
    .unwrap();
    a.execute(
        "UPDATE collection_entries
            SET folder_id = (SELECT id FROM collection_folders WHERE name = 'Binder'),
                quantity = quantity + 1, updated_at = ?1",
        [SECOND],
    )
    .unwrap();
    let edits = since(&a, &mut ma);
    assert_eq!(edits.len(), 2, "the binder, then the move: {edits:?}");
    let mut page = vec![edits[1].clone()];
    let chunks = emit(&a, "dev-a", 1);
    page.extend(chunk_of(&chunks, "bolt"));

    let report = apply(&b, &page).unwrap();
    assert_eq!(
        report.held_waiting, 1,
        "the count and the move wait for the binder together: {report:?}"
    );
    let (folder, written): (Option<i64>, i64) = b
        .query_row(
            "SELECT folder_id, updated_at FROM collection_entries",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (copies(&b, "bolt"), folder, written),
        (2, None, 1_600_000_000)
    );
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));

    // The rest of the page, the binder with it: the held put lands, count and move together.
    apply(&b, &[edits.clone(), chunks.concat()].concat()).unwrap();
    let held = |conn: &Connection| -> (i64, String, i64, Option<String>) {
        conn.query_row(
            "SELECT (SELECT count(*) FROM collection_entries WHERE card_id = 'bolt'),
                    e.condition, e.quantity, f.name
               FROM collection_entries e
               LEFT JOIN collection_folders f ON f.id = e.folder_id
              WHERE e.card_id = 'bolt'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    };
    let want = (1, "NM".to_owned(), 3, Some("Binder".to_owned()));
    assert_eq!((held(&a), held(&b)), (want.clone(), want));
}

/// `597d19d6`: a claim never makes a row, so a group that renames its row carries it along
/// — owed (main's grain rename; Task 8b keeps it from over-counting).
#[test]
fn a_claim_let_through_does_not_outlive_its_row_renamed_in_the_same_page() {
    let (a, b, e) = (paired("dev-a"), paired("dev-b"), paired("dev-e"));
    let (mut ma, mut me) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    a.execute("UPDATE collection_entries SET condition = 'LP'", [])
        .unwrap();
    step(&a, "bolt", 1, SECOND);
    let regrade = since(&a, &mut ma);
    e.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,sync_uid,
             created_at,updated_at)
         VALUES ('bolt','lea','1','en','nonfoil','NM',1,'00000000000000000000000000000000',
                 1700000000,1700000000)",
        [],
    )
    .unwrap();
    let twin = since(&e, &mut me);
    assert_eq!(twin.len(), 1);

    let mut page = regrade.clone();
    page.extend(whole(&a, "dev-a"));
    page.extend(twin.clone());
    apply(&b, &page).unwrap();
    apply(&a, &twin).unwrap();
    assert_eq!(
        (qty(&b), copies(&a, "bolt")),
        ((1, 3), 4),
        "owed: main's grain rename drops a's regrade; the narrow fix's floor reached 4"
    );
}

/// `597d19d6`: a claim is not let through for a row the page deletes, by an earlier stamp
/// — main's add-wins.
#[test]
fn a_claim_let_through_does_not_outlive_a_delete_in_the_same_page() {
    let (a, b, c, d) = (
        paired("dev-a"),
        paired("dev-b"),
        paired("dev-c"),
        paired("dev-d"),
    );
    let (mut ma, mut mc, mut md) = (0, 0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    for peer in [&b, &c, &d] {
        apply(peer, &seed).unwrap();
    }
    step(&c, "bolt", 1, SECOND);
    let step_c = since(&c, &mut mc);
    apply(&a, &step_c).unwrap();
    d.execute("DELETE FROM collection_entries", []).unwrap();
    let deletion = since(&d, &mut md);
    // The delete was made before `a` applied the step, by the stamp that decides the fold.
    let claim_ms = a
        .query_row("SELECT updated_at FROM collection_entries", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap()
        * 1000;
    let mut deletion = deletion;
    deletion[0].at.ms = claim_ms - 1_000;

    let mut page = step_c.clone();
    page.extend(deletion);
    page.extend(whole(&a, "dev-a"));
    let report = apply(&b, &page).unwrap();
    assert_eq!(
        (qty(&b), report.resurrected),
        ((1, 3), 1),
        "c's covered +1 takes the op path at its own stamp, later than the delete the fixture \
         stamped by hand, so add-wins keeps the row — main's answer with no claim at all: \
         {report:?}"
    );
}

/// `597d19d6`: a claim built before a removal it does not carry is not let through.
#[test]
fn a_claim_built_before_a_removal_it_does_not_carry_is_not_let_through() {
    for relay_order in [false, true] {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let mut ma = 0;
        set_clock(&a, STAMP);
        stash(&a, "bolt", 2, SECOND);
        apply(&b, &since(&a, &mut ma)).unwrap();
        step(&a, "bolt", 1, SECOND);
        let added = since(&a, &mut ma);
        let first = whole(&a, "dev-a");
        step(&a, "bolt", -1, SECOND);
        let removed = since(&a, &mut ma);
        let second = whole(&a, "dev-a");

        let parts = if relay_order {
            [second, first, added, removed]
        } else {
            [added, first, removed, second]
        };
        apply(&b, &parts.concat()).unwrap();
        assert_eq!(copies(&a, "bolt"), 2);
        assert_eq!(
            copies(&b, "bolt"),
            2,
            "relay order {relay_order}: a stale claim brought back a removed copy"
        );
    }
}

/// `597d19d6`: nor beside part of the newer emission that carries the removal.
#[test]
fn a_claim_older_than_a_removal_is_not_let_through_beside_part_of_a_newer_emission() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    stash(&a, "opt", 1, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    step(&a, "bolt", 1, SECOND);
    let added = since(&a, &mut ma);
    let first = emit(&a, "dev-a", 1);
    step(&a, "bolt", -1, SECOND);
    let removed = since(&a, &mut ma);
    let second = emit(&a, "dev-a", 1);

    let page = [
        added,
        chunk_of(&first, "bolt"),
        removed,
        chunk_of(&second, "opt"),
    ]
    .concat();
    apply(&b, &page).unwrap();
    assert_eq!(
        copies(&b, "bolt"),
        2,
        "a stale claim brought back a removed copy"
    );
    apply(&b, &chunk_of(&second, "bolt")).unwrap();
    assert_eq!((copies(&a, "bolt"), copies(&b, "bolt")), (2, 2));
}

/// `597d19d6`: nor beside another emitter's claim that has heard of the removal.
#[test]
fn a_claim_that_never_heard_of_a_removal_beside_it_is_not_let_through() {
    let (a, b, e) = (paired("dev-a"), paired("dev-b"), paired("dev-e"));
    let (mut ma, mut me) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&e, &seed).unwrap();
    step(&a, "bolt", 1, SECOND);
    let added = since(&a, &mut ma);
    apply(&e, &added).unwrap();
    step(&e, "bolt", -1, SECOND);
    let removed = since(&e, &mut me);

    let page = [
        added,
        removed.clone(),
        whole(&a, "dev-a"),
        whole(&e, "dev-e"),
    ]
    .concat();
    apply(&b, &page).unwrap();
    apply(&a, &removed).unwrap();
    assert_eq!(copies(&a, "bolt"), 2);
    assert_eq!(
        copies(&b, "bolt"),
        2,
        "a claim that never heard of the removal floored the row over it"
    );
}

/// `597d19d6`: a removal the emitter made after its claim lands on the floor, not under it.
#[test]
fn a_removal_the_emitter_made_after_its_claim_lands_on_the_floor() {
    for relay_order in [false, true] {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let mut ma = 0;
        set_clock(&a, STAMP);
        stash(&a, "bolt", 2, SECOND);
        apply(&b, &since(&a, &mut ma)).unwrap();
        step(&a, "bolt", 1, SECOND);
        let added = since(&a, &mut ma);
        let claims = whole(&a, "dev-a");
        step(&a, "bolt", -1, SECOND);
        let removed = since(&a, &mut ma);

        let parts = if relay_order {
            [claims, added, removed]
        } else {
            [added, claims, removed]
        };
        apply(&b, &parts.concat()).unwrap();
        assert_eq!(copies(&a, "bolt"), 2);
        assert_eq!(
            copies(&b, "bolt"),
            2,
            "relay order {relay_order}: the removed copy came back"
        );
    }
}

/// `597d19d6`: a claim with nothing to raise does not spend its horizon.
#[test]
fn a_claim_with_nothing_to_raise_does_not_spend_its_horizon() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    a.execute(
        "INSERT INTO collection_folders (parent_id, name, kind, sort_order,
                                         created_at, updated_at)
         VALUES (NULL, 'Binder', 'user', 1, ?1, ?1)",
        [SECOND],
    )
    .unwrap();
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    a.execute(
        "UPDATE collection_folders SET name = 'Trade binder', updated_at = ?1
          WHERE name = 'Binder'",
        [SECOND],
    )
    .unwrap();
    step(&a, "bolt", 1, SECOND);
    let edits = since(&a, &mut ma);
    let chunks = emit(&a, "dev-a", 1);
    let mut binder: Vec<Op> = chunks
        .concat()
        .iter()
        .filter(|o| o.fields.get("name").and_then(|v| v.as_str()) == Some("Trade binder"))
        .cloned()
        .collect();
    assert_eq!(binder.len(), 1, "{chunks:?}");
    binder[0].horizon = chunks[0][0].horizon.clone();

    let first = [edits.clone(), binder].concat();
    apply(&b, &first).unwrap();
    apply(&b, &[first, chunk_of(&chunks, "bolt")].concat()).unwrap();
    assert_eq!(
        copies(&b, "bolt"),
        3,
        "the add was marked taken in by nothing"
    );
}

// ---------------------------------------------------------------------------------------------
// Task 8b — a row merged away here is never built again (ledger ruling)
// ---------------------------------------------------------------------------------------------

/// A uid below every minted one, and one above: which side of a grain hit keeps its own.
const LOW: &str = "00000000000000000000000000000000";
const HIGH: &str = "ffffffffffffffffffffffffffffffff";

/// #19's setup (`a_claim_let_through_does_not_outlive_its_row_renamed_in_the_same_page`), up to
/// its page, with e's twin under `twin_uid`: a's regrade of `U_a` (LP, `+1`), a's emission, and
/// e's NM twin, stamped below the regrade. Answers `(a, b, e, page)`, with a having taken e's twin
/// in as #19 has it do; b has not been handed the page. #19 itself is `twin_uid` = [`LOW`].
fn twin_in_one_page(twin_uid: &str) -> (Connection, Connection, Connection, Vec<Op>) {
    let (a, b, e) = (paired("dev-a"), paired("dev-b"), paired("dev-e"));
    let (mut ma, mut me) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    a.execute("UPDATE collection_entries SET condition = 'LP'", [])
        .unwrap();
    step(&a, "bolt", 1, SECOND);
    let regrade = since(&a, &mut ma);
    e.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,sync_uid,
             created_at,updated_at)
         VALUES ('bolt','lea','1','en','nonfoil','NM',1,?1,1700000000,1700000000)",
        [twin_uid],
    )
    .unwrap();
    let twin = since(&e, &mut me);
    assert_eq!(twin.len(), 1);

    let mut page = regrade.clone();
    page.extend(whole(&a, "dev-a"));
    page.extend(twin.clone());
    apply(&a, &twin).unwrap();
    (a, b, e, page)
}

/// #19's page exactly. On b, e's insert folds first, meets `U_a` by grain while it is still NM
/// and renames it to e's lower uid at 3; a's regrade then finds its uid gone and is dropped and
/// recorded — `main`'s answer, b at 3 against a's 4 — and the drop opens the gap.
fn renamed_in_one_page() -> (Connection, Connection, Vec<Op>) {
    let (a, b, _e, page) = twin_in_one_page(LOW);
    (a, b, page)
}

/// Ledger ruling (Task 8b): after #19, a's `U_a` lives on b inside e's row. A later emission from
/// a names `U_a` at LP 3, and b holds no row of that uid and never wrote one — so §6 read it as a
/// row never held and built it, counting a's two original copies a second time: 6 on b against
/// a's 4. A uid this device merged into another row is never built again.
#[test]
fn a_later_emission_never_builds_a_row_a_grain_rename_merged_away() {
    let (a, b, page) = renamed_in_one_page();
    apply(&b, &page).unwrap();
    assert_eq!((qty(&b), copies(&a, "bolt")), ((1, 3), 4), "#19's answer");

    let later = whole(&a, "dev-a");
    apply(&b, &later).unwrap();
    assert_eq!(
        qty(&b),
        (1, 3),
        "a later emission built the row b merged into e's, beside the survivor"
    );
    // Not vacuous: the later emission was active on b, and its claim for `U_a` was decided there
    // and passed — an inert emission keeps no record of its own and decides no claim.
    let u_a = merged_away_uid(&a);
    let em = later
        .iter()
        .find(|o| o.uid == u_a)
        .and_then(|o| o.emission.clone())
        .unwrap();
    let record = emission::records(&b, "dev-a")
        .unwrap()
        .into_iter()
        .find(|r| r.id == em.id)
        .expect("the later emission was not active on b");
    assert!(
        record.passed.contains(em.i) && !record.wrote.contains(em.i),
        "the claim for the merged-away row was not decided as passed: {record:?}"
    );
}

/// a's `U_a`, the one row a holds at LP — the uid #19 merges away on b.
fn merged_away_uid(a: &Connection) -> String {
    a.query_row(
        "SELECT sync_uid FROM collection_entries WHERE condition = 'LP'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// Ledger ruling (Task 8b): the same page handed back. The drop of a's regrade opened the gap,
/// which cleared what a's claim for `U_a` had *passed* on the first delivery (the row was still
/// here when it was decided), so the second delivery decides it again — and found no `U_a` and no
/// local op naming it, and built it at LP 3 beside the survivor, 6 copies.
#[test]
fn a_row_merged_away_is_not_built_when_its_page_comes_back_across_the_gap() {
    let (_a, b, page) = renamed_in_one_page();
    apply(&b, &page).unwrap();
    assert!(
        emission::gap_open(&b).unwrap(),
        "the dropped regrade opened no gap"
    );

    apply(&b, &page).unwrap();
    assert_eq!(
        qty(&b),
        (1, 3),
        "the page handed back built the row b merged into e's, beside the survivor"
    );
}

/// Ledger ruling (Task 8b), the fold site: a's binder delete reaches b, where b has filed copies
/// of its own into the binder, and the re-homing (`rehome`) folds them onto the root copy a made,
/// the survivor wearing the lower of the two uids. a then regrades its root copy and re-baselines
/// before it hears of b's copies.
///
/// Where the root copy's uid sorts higher, b retired it into its own copy's: a's claim then names a
/// row b merged away, its grain (LP) meets no twin, and building it counted a's one copy a second
/// time — 4 on b against 3 on a. Where the root copy's uid sorts lower, b's own copy's uid is the
/// one retired and no claim names it, so that direction pins the mark alone.
fn a_later_emission_never_builds_a_row_a_folder_delete_folded_away(root_lower: bool) {
    let (root, filed) = if root_lower { (LOW, HIGH) } else { (HIGH, LOW) };
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    set_clock(&a, STAMP);
    let bin = folder(&a, "Binder", SECOND);
    a.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,sync_uid,
             created_at,updated_at)
         VALUES ('bolt','lea','1','en','nonfoil','NM',1,?1,?2,?2)",
        rusqlite::params![root, SECOND],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    let b_bin: i64 = b
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'Binder'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    b.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
             sync_uid,created_at,updated_at)
         VALUES ('bolt','lea','1','en','nonfoil','NM',2,?1,?2,?3,?3)",
        rusqlite::params![b_bin, filed, SECOND],
    )
    .unwrap();

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    let survivor = |conn: &Connection| -> String {
        conn.query_row("SELECT sync_uid FROM collection_entries", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(
        (qty(&b), survivor(&b)),
        ((1, 3), LOW.to_owned()),
        "the re-homing did not fold b's copies onto the root's under the lower uid"
    );

    a.execute("UPDATE collection_entries SET condition = 'LP'", [])
        .unwrap();
    let page = [since(&a, &mut ma), whole(&a, "dev-a")].concat();
    let report = apply(&b, &page).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(
        (copies(&a, "bolt"), copies(&b, "bolt")),
        (3, 3),
        "root lower {root_lower}: a's claim built the row b folded away, beside the survivor"
    );
    assert!(
        emission::retired(&b, "collection_entries", HIGH).unwrap(),
        "root lower {root_lower}: the fold recorded no mark for the uid it dropped"
    );
    assert_eq!(
        report.dropped,
        usize::from(!root_lower),
        "root lower {root_lower}: a's regrade of a row b merged away takes the op path, finds no \
         row and is dropped and recorded — main's answer — and does not vanish as carried by a \
         claim that built nothing: {report:?}"
    );
}

#[test]
fn a_later_emission_never_builds_a_root_copy_a_folder_delete_folded_away() {
    a_later_emission_never_builds_a_row_a_folder_delete_folded_away(false);
}

#[test]
fn a_folder_delete_that_folds_a_filed_copy_away_records_its_uid() {
    a_later_emission_never_builds_a_row_a_folder_delete_folded_away(true);
}

/// Ledger ruling on Task 8b's concern 1: a grain hit's other direction. #19 with e's twin under
/// [`HIGH`]: on b, e's insert meets `U_a` by grain while it is still NM, and `U_a` sorts lower, so
/// the row keeps its uid and e's is absorbed into it at 3; a's regrade then lands on it, LP 4 —
/// and a holds `U_a` LP 3 beside e's NM 1, also 4. e's next emission names its own uid at NM 1:
/// no row here wears it, b's log never named it, and the row it was absorbed into is LP now, so
/// no grain twin meets it either — it was built beside the survivor, 5 on b against a's 4. A uid
/// this device absorbed is retired as a renamed one is, and is never built again.
#[test]
fn a_later_claim_never_builds_a_uid_this_device_absorbed() {
    let (a, b, e, page) = twin_in_one_page(HIGH);
    apply(&b, &page).unwrap();
    assert_eq!(
        (qty(&b), copies(&a, "bolt")),
        ((1, 4), 4),
        "#19 with the twin's uid sorting higher"
    );

    apply(&b, &whole(&e, "dev-e")).unwrap();
    assert_eq!(
        (copies(&b, "bolt"), copies(&a, "bolt")),
        (4, 4),
        "e's claim built the uid b absorbed into a's row, beside it"
    );
}

/// Task 8b fix round 1 (I1): the merge and the claim in ONE page. `decide` reads `retired@` before
/// the page, when `U_a` is still here, and with a gap open the claim goes to the fold as the floor.
/// e's twin's group sorts first and renames `U_a` away, writing the mark too late for `decide`;
/// `U_a`'s own group — the claim and a's regrade — then meets no LP twin and no row by its uid,
/// and built `U_a` at LP 3 beside the survivor: 6 on b against a's 4. The write path asks the mark
/// itself, at the moment it would build, and builds nothing: dropped and recorded, `main`'s answer.
#[test]
fn a_claim_floored_on_a_row_merged_away_in_the_same_page_builds_nothing() {
    let (a, b, page) = renamed_in_one_page();
    let u_a = merged_away_uid(&a);
    emission::open_gap(&b).unwrap();
    let report = apply(&b, &page).unwrap();
    assert_eq!(
        (qty(&b), copies(&a, "bolt")),
        ((1, 3), 4),
        "the claim built the row a rename merged away earlier in its own page: {report:?}"
    );
    let skipped: Vec<String> = skips(&b)
        .into_iter()
        .filter_map(|(_, _, _, detail, _)| detail)
        .filter(|d| d.contains(&u_a))
        .collect();
    assert_eq!(
        skipped,
        vec![format!("uid {u_a} · {}", super::MERGED_AWAY)],
        "the group was not recorded as merged away"
    );
    // The refused claim wrote nothing. `settle` recorded it passed, and the drop then opened the
    // gap, which clears every record's passed set (§7) — so the page handed back decides it again,
    // and `decide` now finds the mark and passes it.
    let em = page
        .iter()
        .find(|o| o.uid == u_a && o.baseline)
        .and_then(|o| o.emission.clone())
        .unwrap();
    let record = |conn: &Connection| {
        emission::records(conn, "dev-a")
            .unwrap()
            .into_iter()
            .find(|r| r.id == em.id)
            .expect("a's emission left no record on b")
    };
    assert!(
        !record(&b).wrote.contains(em.i),
        "the refused claim was recorded as written: {:?}",
        record(&b)
    );
    apply(&b, &page).unwrap();
    assert_eq!(
        (qty(&b), record(&b).passed.contains(em.i)),
        ((1, 3), true),
        "the page handed back built the row, or did not pass its claim: {:?}",
        record(&b)
    );
}

/// Task 8b fix round 1 (m2): §6's merged-away row is asked ahead of the held-row arm, so it holds
/// whether or not a row wears the uid again. After #19, an older build's re-baseline from a — no
/// emission reference, so `main`'s rules — rebuilds `U_a` on b: its grain, LP, meets no twin, and
/// a note a second later stamps it above b's watermark for a. b then holds `U_a` at 1, and with a
/// gap open a's next emission arrives: its claim for `U_a` is passed, where the held-row arm alone
/// would floor the row back to 3.
#[test]
fn a_retired_uid_a_row_wears_again_is_still_passed_under_a_gap() {
    let (a, b, page) = renamed_in_one_page();
    apply(&b, &page).unwrap();
    let u_a = merged_away_uid(&a);
    a.execute(
        "UPDATE collection_entries SET notes = 'sleeved', updated_at = ?1 WHERE sync_uid = ?2",
        rusqlite::params![SECOND + 10, u_a],
    )
    .unwrap();
    let mut older_build = whole(&a, "dev-a");
    for op in &mut older_build {
        op.emission = None;
    }
    apply(&b, &older_build).unwrap();
    let worn: i64 = b
        .query_row(
            "SELECT count(*) FROM collection_entries WHERE sync_uid = ?1",
            [&u_a],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(worn, 1, "no row wears the merged-away uid again");

    b.execute(
        "UPDATE collection_entries SET quantity = 1 WHERE sync_uid = ?1",
        [&u_a],
    )
    .unwrap();
    emission::open_gap(&b).unwrap();
    let later = whole(&a, "dev-a");
    apply(&b, &later).unwrap();
    let held: i64 = b
        .query_row(
            "SELECT quantity FROM collection_entries WHERE sync_uid = ?1",
            [&u_a],
            |r| r.get(0),
        )
        .unwrap();
    let em = later
        .iter()
        .find(|o| o.uid == u_a)
        .and_then(|o| o.emission.clone())
        .unwrap();
    let record = emission::records(&b, "dev-a")
        .unwrap()
        .into_iter()
        .find(|r| r.id == em.id)
        .expect("a's later emission was not active on b");
    assert_eq!(
        (held, record.passed.contains(em.i)),
        (1, true),
        "the claim for a retired uid a row wears again was floored under the gap: {record:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// The final review — two over-counts and the held-back stall (2026-10-03)
// ---------------------------------------------------------------------------------------------

/// Final review C1. a's first emission is pulled a chunk at a time, and b's first page carries a's
/// outbox beside the chunk for bolt: the claim builds bolt, and a's insert is dropped as carried by
/// it. a's whole second emission then comes in the same page, handed back twice. It completes on
/// the first and is taken — and `take` used to drop every other record of the generation, the
/// half-sent first emission's with it, whose `wrote` set was the only evidence that a's insert is
/// inside bolt here. The second emission's claim for bolt passed, the row being held here, so on
/// the second hand-back nothing proved the insert inside the row, and the older rules applied it
/// on top: 4 where 2 is right.
#[test]
fn a_half_sent_emission_superseded_while_its_page_is_held_counts_its_carried_put_once() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    stash(&a, "opt", 1, 1_700_000_100);
    let half = emit(&a, "dev-a", 1);
    let first = page(&[&outbox(&a), &chunk_of(&half, "bolt")]);
    apply(&b, &first).unwrap();
    assert_eq!(copies(&b, "bolt"), 2, "the half-sent emission's claim");

    let again = page(&[&first, &whole(&a, "dev-a")]);
    apply(&b, &again).unwrap();
    assert_eq!((copies(&b, "bolt"), copies(&b, "opt")), (2, 1));
    assert!(
        emission::taken(&b, "dev-a").unwrap().is_some(),
        "the whole second emission was not taken"
    );
    apply(&b, &again).unwrap();
    assert_eq!(copies(&b, "bolt"), 2);
}

/// Final review C2, a regression against `main`. An older build's baseline of a's — no references,
/// as an older emitter sends one, or as one stripped at the cut — comes beside the insert its
/// horizon covers, and `main`'s `inside` drops the insert: its claim builds bolt at 2. The page
/// comes back with e's emission, which covers the insert too, and whose claim for bolt passes on
/// the row held here. `decide` sent the insert down the op path, which bypasses `inside`, and it
/// was counted on top of the claim that already carried it: 4 where `main` answers 2.
#[test]
fn a_put_an_older_emitters_claim_carried_is_not_counted_again_beside_a_newer_emission() {
    let (a, b, e) = (paired("dev-a"), paired("dev-b"), paired("dev-e"));
    stash(&a, "bolt", 2, 1_700_000_000);
    let put = outbox(&a);
    apply(&e, &put).unwrap();
    let mut old = whole(&a, "dev-a");
    for op in &mut old {
        op.emission = None;
    }
    let first = page(&[&put, &old]);
    apply(&b, &first).unwrap();
    assert_eq!(copies(&b, "bolt"), 2);

    apply(&b, &page(&[&first, &whole(&e, "dev-e")])).unwrap();
    assert_eq!(copies(&b, "bolt"), 2, "main's answer");
}

/// Final review I1: a held-back op joins only a group that carries a claim. c's `+1` on bolt is
/// held back by b's client, and a's `+1` on the same row comes fresh beside it with no claim in the
/// page; a's lands, and so does a's later op on another row, and c's applies once when its sender
/// is released. A held-back op used to join every group of its row, so a's `+1` waited with it —
/// and every later op of a's, as collateral — for as long as the client held c: up to a day on a
/// clock hold, and until an upgrade behind a newer build's batch. Ops with no reference keep
/// `main`'s rules, and `main` never held anything back.
#[test]
fn a_held_back_op_on_a_row_with_no_claim_holds_no_other_senders_op() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&c, &seed).unwrap();
    step(&c, "bolt", 1, SECOND + 1);
    let put = since(&c, &mut mc);
    step(&a, "bolt", 1, SECOND + 2);
    stash(&a, "opt", 1, SECOND + 3);
    let from_a = since(&a, &mut ma);
    assert_eq!(from_a.len(), 2, "{from_a:?}");

    let (report, held) = apply_page(&b, &from_a, &put, Waiting::Hold).unwrap();
    assert_eq!(
        (report.applied, copies(&b, "bolt"), copies(&b, "opt")),
        (2, 3, 1),
        "a held-back op on a row with no claim held another sender's ops: {report:?}"
    );
    let last = from_a.last().unwrap();
    assert_eq!(watermark(&b, "dev-a"), (last.at.ms, last.at.ctr));
    assert!(
        held.is_empty(),
        "the client holds c itself; apply holds nothing here: {held:?}"
    );

    apply(&b, &page(&[&from_a, &put])).unwrap();
    assert_eq!(copies(&b, "bolt"), 4, "each +1 once");
}

/// Final review m2: a held-back op is counted in no class of `apply`'s report, whatever its group
/// becomes — the client counts it itself (`held_behind`, `held_clock`), so a count here is the
/// same op twice. c's held-back `+1` joins the group of e's claim for bolt, beside y's `+1`; y is a
/// newer build's device, held at an earlier op on a table this build does not know, so the group is
/// held as newer. It holds three ops, and two of them are `apply`'s: the report said 3 newer for
/// that group, 4 in all, where 2 and 3 are right.
#[test]
fn a_held_back_op_in_a_group_held_as_newer_is_counted_in_no_class() {
    let (b, c, e, y) = (
        paired("dev-b"),
        paired("dev-c"),
        paired("dev-e"),
        paired("dev-y"),
    );
    let (mut mc, mut me, mut my) = (0, 0, 0);
    real_stash(&e, "bolt", 2);
    let seed = since(&e, &mut me);
    apply(&c, &seed).unwrap();
    apply(&y, &seed).unwrap();
    step(&c, "bolt", 1, 1_700_000_000);
    let put = since(&c, &mut mc);
    stash(&y, "opt", 1, 1_700_000_000);
    step(&y, "bolt", 1, 1_700_000_001);
    let mut from_y = since(&y, &mut my);
    assert_eq!(from_y.len(), 2, "{from_y:?}");
    from_y[0].table = "future_table".to_owned();
    for op in &mut from_y {
        op.schema = Some(crate::schema::USER_SCHEMA_VERSION + 1);
    }
    let claims = whole(&e, "dev-e");

    let (report, _) = apply_page(&b, &page(&[&claims, &from_y]), &put, Waiting::Hold).unwrap();
    assert_eq!(
        rows(&b, "bolt"),
        0,
        "the claim landed ahead of the put it waits on"
    );
    assert_eq!(
        (report.held_newer, report.deferred),
        (3, 3),
        "y's two ops and e's claim, and not c's held-back op: {report:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// Issue #843 — an older build's claim below its sender's watermark, on a live device
// ---------------------------------------------------------------------------------------------

/// Every reference taken off, as a build from v0.18.0 to v0.39 sends a baseline: the horizon on
/// the first op of each chunk, and nothing else.
fn as_an_older_build_sends(chunks: Vec<Vec<Op>>) -> Vec<Vec<Op>> {
    chunks
        .into_iter()
        .map(|chunk| {
            chunk
                .into_iter()
                .map(|mut op| {
                    op.emission = None;
                    op
                })
                .collect()
        })
        .collect()
}

/// §14 row 1 from an older build: its first chunk lifts a's watermark on b to `c1`'s stamp, and
/// the second chunk's claims are stamped below it. Judged by that watermark they were skipped as
/// seen, and b held one card of three for good. b has never known `c2` or `c3`, so their claims
/// are let through — and handed over again, they add nothing. **In a group of three as well**,
/// where both have heard c's op before a reads its tables: a's horizon reaches b's watermark for
/// c, so nothing b heard from c can be newer than the claims.
#[test]
fn an_older_builds_baseline_pulled_in_two_halves_reaches_a_device_that_held_nothing() {
    for third in [false, true] {
        older_baseline_in_two_halves(third);
    }
}

fn older_baseline_in_two_halves(third: bool) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    if third {
        let c = paired("dev-c");
        stash(&c, "opt", 1, 1_700_000_000);
        apply(&a, &outbox(&c)).unwrap();
        apply(&b, &outbox(&c)).unwrap();
        assert!(watermark(&b, "dev-c") > (0, 0), "the fixture: b heard c");
        a.execute("UPDATE sync_ops SET pushed_at = unixepoch()", [])
            .unwrap();
    }
    stash(&a, "c1", 1, 1_700_000_300);
    stash(&a, "c2", 1, 1_700_000_200);
    stash(&a, "c3", 1, 1_700_000_100);
    // The seeded folder, c's row where a holds it, and `c1` — then `c2` and `c3`.
    let chunks = as_an_older_build_sends(emit(&a, "dev-a", if third { 3 } else { 2 }));
    assert_eq!(chunks.len(), 2, "the fixture: two chunks");
    apply(&b, &page(&[&outbox(&a), &chunks[0]])).unwrap();
    let held = watermark(&b, "dev-a");
    assert!(
        chunks[1].iter().all(|op| (op.at.ms, op.at.ctr) <= held),
        "the fixture: the second chunk is below the watermark the first left"
    );
    let second = apply(&b, &chunks[1]).unwrap();
    let (c1, c2, c3) = (copies(&b, "c1"), copies(&b, "c2"), copies(&b, "c3"));
    assert_eq!(
        ((c1, c2, c3), second.applied),
        ((1, 1, 1), 2),
        "third {third}: {second:?}"
    );

    let again = apply(&b, &chunks[1]).unwrap();
    assert_eq!(
        ((copies(&b, "c2"), copies(&b, "c3")), again.applied),
        ((1, 1), 0),
        "third {third}: {again:?}"
    );
}

/// §14 row 2 from an older build: a's sparse `+1` on a row it held before pairing is pulled ahead
/// of the baseline, lifts a's watermark on b past the claim for that row, and finds no row to
/// edit. The claim is let through, and the row is built whole.
#[test]
fn an_older_builds_sparse_op_pulled_ahead_of_its_baseline_does_not_cost_the_row() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    set_clock(&a, STAMP);
    stash(&a, "bolt", 4, SECOND - 100);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    step(&a, "bolt", 1, SECOND);
    apply(&b, &outbox(&a)).unwrap();
    let baseline = as_an_older_build_sends(vec![whole(&a, "dev-a")]).concat();
    apply(&b, &baseline).unwrap();
    assert_eq!(copies(&b, "bolt"), 5);
}

/// The watermark's rule stands on a row held here: an older build's claim stamped below a's
/// watermark on b takes back nothing removed since — by b itself, before a re-broadcast; or by a,
/// in the page that carries a's baseline. Let through, the claim is the floor `max(2, 3)`.
#[test]
fn an_older_builds_rebroadcast_below_the_watermark_takes_back_nothing_on_a_row_held_here() {
    for by_b in [true, false] {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let mut ma = 0;
        stash(&a, "bolt", 3, 1_700_000_000);
        apply(&b, &since(&a, &mut ma)).unwrap();
        let baseline = as_an_older_build_sends(vec![whole(&a, "dev-a")]).concat();
        let claim = baseline
            .iter()
            .find(|op| op.table == "collection_entries")
            .unwrap();
        assert!(
            (claim.at.ms, claim.at.ctr) <= watermark(&b, "dev-a"),
            "the fixture: the claim is below the watermark"
        );
        if by_b {
            b.execute("UPDATE collection_entries SET quantity = quantity - 1", [])
                .unwrap();
            apply(&b, &baseline).unwrap();
        } else {
            step(&a, "bolt", -1, 1_700_000_050);
            apply(&b, &page(&[&baseline, &since(&a, &mut ma)])).unwrap();
        }
        assert_eq!(copies(&b, "bolt"), 2, "removed by b: {by_b}");
    }
}

/// …and on a row deleted here, by this device or by another one it heard: a has not heard the
/// delete, and its re-broadcast, stamped below its watermark on b, never builds the row again.
/// Neither delete leaves a row to find, nor a `sync_gone` row — only a parent's delete writes one.
/// b's own is in b's log, stamped above everything b had heard and so above the claim: the fold's
/// add-wins keeps the row gone. c's is in no log here, and beyond a's horizon, which never reached
/// b's watermark for c.
#[test]
fn an_older_builds_rebroadcast_below_the_watermark_never_rebuilds_a_row_deleted_here() {
    for own in [false, true] {
        let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
        let (mut ma, mut mc) = (0, 0);
        stash(&a, "bolt", 2, 1_700_000_000);
        let seed = since(&a, &mut ma);
        apply(&b, &seed).unwrap();
        if own {
            b.execute("DELETE FROM collection_entries", []).unwrap();
        } else {
            apply(&c, &seed).unwrap();
            c.execute("DELETE FROM collection_entries", []).unwrap();
            apply(&b, &since(&c, &mut mc)).unwrap();
        }
        assert_eq!(rows(&b, "bolt"), 0, "the fixture");
        let rebroadcast = as_an_older_build_sends(vec![whole(&a, "dev-a")]).concat();
        apply(&b, &rebroadcast).unwrap();
        assert_eq!(rows(&b, "bolt"), 0, "deleted by b itself: {own}");
    }
}

/// …and on a row whose delete the page carries: a deletes `bolt` after its baseline, and the page
/// holding both comes back to b once both are below a's watermark — the cursor held, or the log
/// position forgotten. A copy's delete leaves no `sync_gone` row, so it is the page's own delete
/// that says the row is gone.
#[test]
fn an_older_builds_claim_beside_the_delete_of_its_row_never_builds_it_when_handed_back() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    stash(&a, "bolt", 2, 1_700_000_000);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let baseline = as_an_older_build_sends(vec![whole(&a, "dev-a")]).concat();
    a.execute("DELETE FROM collection_entries", []).unwrap();
    let handed = page(&[&baseline, &since(&a, &mut ma)]);
    apply(&b, &handed).unwrap();
    assert_eq!(rows(&b, "bolt"), 0, "the fixture");
    apply(&b, &handed).unwrap();
    assert_eq!(rows(&b, "bolt"), 0);
}

/// …and on a row merged here into another: b's own `bolt`, under a lower uid, absorbed a's claim
/// for its `bolt` the first time a's baseline came, and b has since taken two copies out. A's
/// re-broadcast names the absorbed uid, below a's watermark; let through, it would meet b's row by
/// grain and floor it back to 3.
#[test]
fn an_older_builds_rebroadcast_below_the_watermark_never_floors_a_row_it_was_merged_into() {
    const LOW: &str = "00000000000000000000000000000001";
    const HIGH: &str = "ffffffffffffffffffffffffffffffff";
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let insert = |conn: &Connection, uid: &str, quantity: i64| {
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at,sync_uid)
             VALUES ('bolt','lea','1','en','nonfoil','NM',?2,1700000000,1700000000,?1)",
            rusqlite::params![uid, quantity],
        )
        .unwrap();
    };
    insert(&a, HIGH, 3);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    insert(&b, LOW, 1);
    let baseline = as_an_older_build_sends(vec![whole(&a, "dev-a")]).concat();
    apply(&b, &baseline).unwrap();
    assert_eq!(
        (rows(&b, "bolt"), copies(&b, "bolt")),
        (1, 3),
        "the fixture"
    );
    assert!(emission::retired(&b, "collection_entries", HIGH).unwrap());
    b.execute("UPDATE collection_entries SET quantity = quantity - 2", [])
        .unwrap();
    apply(&b, &baseline).unwrap();
    assert_eq!((rows(&b, "bolt"), copies(&b, "bolt")), (1, 1));
}

/// A row b holds under a uid of its own, at the claim's grain: the claim let past the watermark
/// meets it and merges, `max`, as one answer carrying a's `+1` and baseline does — and as a claim
/// that names its emission does on a row not held here under its uid (design 2026-10-03 §6).
#[test]
fn an_older_builds_claim_let_past_the_watermark_merges_with_a_grain_twin_as_one_answer_does() {
    let ends = |live: bool| {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        stash(&a, "bolt", 3, 1_700_000_000);
        a.execute("DELETE FROM sync_ops", []).unwrap();
        stash(&a, "opt", 1, 1_700_000_100);
        stash(&b, "bolt", 1, 1_700_000_000);
        let edit = outbox(&a);
        let baseline = as_an_older_build_sends(vec![whole(&a, "dev-a")]).concat();
        if live {
            apply(&b, &edit).unwrap();
            apply(&b, &baseline).unwrap();
        } else {
            apply(&b, &page(&[&edit, &baseline])).unwrap();
        }
        (rows(&b, "bolt"), copies(&b, "bolt"), copies(&b, "opt"))
    };
    assert_eq!(ends(false), (1, 3, 1), "one answer");
    assert_eq!(
        ends(true),
        ends(false),
        "the +1's pull, then the baseline's"
    );
}
