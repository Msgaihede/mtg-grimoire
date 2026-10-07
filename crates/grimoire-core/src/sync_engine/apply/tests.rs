//! Two real databases, and every test drives both.
//!
//! **A fixture with one connection cannot show a convergence bug**, which is the whole class
//! this module is for: the failures are all of the shape "the two devices now hold different
//! rows and neither can tell".

use super::*;
use crate::sync_engine::capture;
use rusqlite::Connection;

/// A device in a group, with capture installed.
///
/// The two devices share a `group_id` and differ in `device_id`, because that is what makes
/// their stamps orderable against each other and their ops distinguishable.
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

/// Everything a device has to say, in the order it said it.
fn outbox(conn: &Connection) -> Vec<Op> {
    let sql = format!("{} ORDER BY seq", capture::OPS_SELECT);
    let mut stmt = conn.prepare(&sql).unwrap();
    let ops: Vec<Op> = stmt
        .query_map([], capture::op_from_row)
        .unwrap()
        .map(|r| r.unwrap().1)
        .collect();
    ops
}

/// Everything said since the last time this was called.
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

/// What an apply left unwritten: `(deferred, dropped)`.
///
/// **Both, and never `deferred` alone.** A row this database cannot build — the insert a
/// missing grain sends into a unique index — is skipped as `dropped` rather than held, so a check
/// on `deferred` passes over exactly the failure it was written to catch.
fn unwritten(report: ApplyReport) -> (usize, usize) {
    (report.deferred, report.dropped)
}

fn qty(conn: &Connection) -> (i64, i64) {
    conn.query_row(
        "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

/// The counter rule, end to end, over two REAL databases. Both add one copy of the same
/// printing while offline; each applies the other's op; both end at 2 with ONE row.
#[test]
fn two_offline_devices_each_adding_one_copy_converge_on_one_row_at_two() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    add_copy(&a);
    add_copy(&b);
    let from_a = outbox(&a);
    let from_b = outbox(&b);
    apply(&b, &from_a).unwrap();
    apply(&a, &from_b).unwrap();

    for (name, c) in [("a", &a), ("b", &b)] {
        let (rows, sum) = qty(c);
        assert_eq!(rows, 1, "{name} kept two rows for one printing");
        assert_eq!(sum, 2, "{name} lost a card");
    }

    // ...and they agree on which uid that row has, which is what stops the next round from
    // splitting it again.
    let ua: String = a
        .query_row("SELECT sync_uid FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    let ub: String = b
        .query_row("SELECT sync_uid FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(ua, ub, "the two devices must adopt one uid");
}

/// **The whole path, with nothing assumed: two devices name a peer independently, meet, and
/// only then is one of them renamed.**
///
/// This is the test that would catch a rename that cannot land. A rename op is *sparse* — the
/// update trigger emits only what changed, so it carries `name` and no `device_id`, and the
/// grain has nothing to bind. It travels by uid, so it works exactly when the two rows have
/// already converged on one. The exchange in the middle is what makes them converge, and
/// driving it here is the difference between testing the feature and testing a fixture that
/// was handed the answer.
#[test]
fn a_rename_travels_once_two_independent_rows_have_met() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);

    // Both file a name for the same peer, knowing nothing of each other. These are INSERTs, so
    // the ops carry every field and the grain can bind on `device_id`.
    a.execute(
        "INSERT INTO device_names (device_id, name, created_at, updated_at)
         VALUES ('dev-c', 'Desktop', 0, 0)",
        [],
    )
    .unwrap();
    b.execute(
        "INSERT INTO device_names (device_id, name, created_at, updated_at)
         VALUES ('dev-c', 'Phone', 0, 0)",
        [],
    )
    .unwrap();
    let (from_a, from_b) = (since(&a, &mut ma), since(&b, &mut mb));
    apply(&b, &from_a).unwrap();
    apply(&a, &from_b).unwrap();

    // Now a reader renames that peer, on one device only.
    a.execute(
        "UPDATE device_names SET name = 'Kitchen tablet' WHERE device_id = 'dev-c'",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();

    for (who, c) in [("a", &a), ("b", &b)] {
        let (rows, name): (i64, String) = c
            .query_row("SELECT count(*), max(name) FROM device_names", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(rows, 1, "{who} kept two rows for one device");
        assert_eq!(name, "Kitchen tablet", "{who} did not see the rename");
    }
}

/// ...and a second round changes nothing, which is what "converged" has to mean. Without the
/// uid adoption the grain match would fire again every round, and the quantity would climb by
/// one on each device every time they spoke.
#[test]
fn a_second_exchange_after_convergence_changes_nothing() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    add_copy(&b);
    let from_a = since(&a, &mut ma);
    let from_b = since(&b, &mut mb);
    apply(&b, &from_a).unwrap();
    apply(&a, &from_b).unwrap();
    assert_eq!(qty(&a), (1, 2));

    apply(&b, &since(&a, &mut ma)).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(qty(&a), (1, 2), "a is drifting");
    assert_eq!(qty(&b), (1, 2), "b is drifting");
}

/// Applying the same batch twice must not add the deltas twice. This is the failure a dropped
/// connection produces, and it looks exactly like a collection growing by itself.
#[test]
fn replaying_a_batch_does_not_add_its_counters_again() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    a.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',4,unixepoch(),unixepoch())",
        [],
    )
    .unwrap();
    let batch = outbox(&a);
    apply(&b, &batch).unwrap();
    let report = apply(&b, &batch).unwrap();

    let q: i64 = b
        .query_row("SELECT quantity FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(q, 4, "a replay must not add the delta twice");
    assert_eq!(report.applied, 0);
    assert_eq!(report.skipped, batch.len());
}

/// **A device's own ops coming back are dropped**, and the relay is not trusted to have done
/// it. A counter is not idempotent, so one of this device's own `+1`s returning would be a card
/// appearing out of nothing.
#[test]
fn a_devices_own_ops_coming_back_are_skipped() {
    let a = paired("dev-a");
    add_copy(&a);
    let mine = outbox(&a);
    let report = apply(&a, &mine).unwrap();
    assert_eq!(qty(&a), (1, 1));
    assert_eq!(report.skipped, mine.len());
    assert_eq!(report.applied, 0);
}

/// **An apply writes no ops of its own.** Without the guard two devices ping-pong forever, each
/// re-sending what the other just sent it.
#[test]
fn applying_records_no_ops_of_its_own() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    add_copy(&a);
    let before = outbox(&b).len();
    apply(&b, &outbox(&a)).unwrap();
    assert_eq!(outbox(&b).len(), before, "an apply must record nothing");
}

/// §7.4's first surfaced outcome, over two databases and with no third device to arrange it.
///
/// A deletes the row; B edits it concurrently. **Both keep the row**, and both say why.
#[test]
fn a_delete_that_lost_a_race_resurrects_the_row_on_both_devices() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    a.execute("DELETE FROM collection_entries", []).unwrap();
    b.execute("UPDATE collection_entries SET notes = 'still mine'", [])
        .unwrap();

    let report_b = apply(&b, &since(&a, &mut ma)).unwrap();
    let report_a = apply(&a, &since(&b, &mut mb)).unwrap();

    for (name, c) in [("a", &a), ("b", &b)] {
        let (rows, _) = qty(c);
        assert_eq!(rows, 1, "{name} threw the row away");
        let (notes, review): (Option<String>, Option<String>) = c
            .query_row(
                "SELECT notes, needs_review FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(notes.as_deref(), Some("still mine"), "{name} lost the edit");
        assert_eq!(review.as_deref(), Some(RESURRECTED), "{name} says nothing");
    }
    assert_eq!(report_a.resurrected, 1);
    assert_eq!(report_b.resurrected, 1);
}

/// **A resurrected row goes back where it was filed.** The row is rebuilt from this device's
/// own history, because the incoming op that saved it is a note edit that mentions no folder --
/// and a card that jumped out of its binder because somebody else edited a note is exactly the
/// kind of quiet loss this whole module is arranged against.
#[test]
fn a_resurrected_row_keeps_the_folder_it_was_filed_in() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO collection_folders (name, kind, sort_order, created_at, updated_at)
         VALUES ('Binder', 'user', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',1,
                 (SELECT id FROM collection_folders WHERE name = 'Binder'),
                 unixepoch(),unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    // `a` throws the card away; `b` edits it at the same moment, and add-wins keeps it.
    a.execute("DELETE FROM collection_entries", []).unwrap();
    b.execute("UPDATE collection_entries SET notes = 'keep it'", [])
        .unwrap();

    apply(&b, &since(&a, &mut ma)).unwrap();
    let report = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(report.resurrected, 1);

    for (who, c) in [("a", &a), ("b", &b)] {
        let folder: Option<String> = c
            .query_row(
                "SELECT f.name FROM collection_entries e
                   LEFT JOIN collection_folders f ON f.id = e.folder_id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            folder.as_deref(),
            Some("Binder"),
            "{who} put the card back at the root"
        );
    }
}

/// ...and an uncontested delete really deletes, quietly.
#[test]
fn a_delete_with_nothing_against_it_deletes() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, _) = (0, 0);
    add_copy(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(qty(&b), (1, 1));

    a.execute("DELETE FROM collection_entries", []).unwrap();
    let report = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(qty(&b), (0, 0));
    assert_eq!(report.resurrected, 0);
}

/// **Two devices typing "Ramp" end with one `deck_labels` row.** `idx_deck_labels_grain` is
/// `UNIQUE (name_key)`, so a second row is not a duplicate, it is a constraint failure at apply
/// time — and the labels are one app-wide list since schema v21, so it genuinely is one label.
#[test]
fn two_devices_typing_ramp_end_with_one_label() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    for (c, name) in [(&a, "Ramp"), (&b, "ramp")] {
        c.execute(
            "INSERT INTO deck_labels (name, name_key, color, created_at, updated_at)
             VALUES (?1, 'ramp', '#0f0', unixepoch(), unixepoch())",
            [name],
        )
        .unwrap();
    }
    apply(&b, &outbox(&a)).unwrap();
    apply(&a, &outbox(&b)).unwrap();

    for (who, c) in [("a", &a), ("b", &b)] {
        let n: i64 = c
            .query_row("SELECT count(*) FROM deck_labels", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "{who} has two rows for one label");
    }
    let (ua, ub): (String, String) = (
        a.query_row("SELECT sync_uid FROM deck_labels", [], |r| r.get(0))
            .unwrap(),
        b.query_row("SELECT sync_uid FROM deck_labels", [], |r| r.get(0))
            .unwrap(),
    );
    assert_eq!(ua, ub);
}

/// **A grain is not a substitute for a uid.** `deck_folders` has no unique index, so two
/// devices' folders both called "Binder" are two folders and must stay two — the exact case a
/// grain-only identity rule would silently fold into one.
#[test]
fn two_folders_with_one_name_stay_two_folders() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    for c in [&a, &b] {
        c.execute(
            "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
             VALUES ('Binder', 0, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
    }
    apply(&b, &outbox(&a)).unwrap();
    apply(&a, &outbox(&b)).unwrap();
    for (who, c) in [("a", &a), ("b", &b)] {
        let n: i64 = c
            .query_row("SELECT count(*) FROM deck_folders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "{who} folded two folders into one");
    }
}

/// A parent that has not arrived is **deferred**, and lands when it does.
#[test]
fn an_op_whose_parent_is_missing_is_deferred_and_lands_later() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Binder', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let folder_ops = since(&a, &mut ma);
    a.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('A', 'commander', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let deck_ops = since(&a, &mut ma);

    // The deck alone: its folder is a uid `b` has never heard of.
    let report = apply(&b, &deck_ops).unwrap();
    assert_eq!(report.deferred, deck_ops.len());
    let decks: i64 = b
        .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(decks, 0);
    // ...and the watermark did not step over it.
    let peers: i64 = b
        .query_row("SELECT count(*) FROM sync_peers", [], |r| r.get(0))
        .unwrap();
    assert_eq!(peers, 0, "a stalled stream must not advance");

    // The folder arrives, and the deck is retried on the next pull.
    apply(&b, &folder_ops).unwrap();
    let report = apply(&b, &deck_ops).unwrap();
    assert_eq!(report.deferred, 0);
    let (decks, folder): (i64, Option<i64>) = b
        .query_row("SELECT count(*), max(folder_id) FROM decks", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(decks, 1);
    assert!(folder.is_some(), "the deck must land in the folder");
}

/// ...and a batch that carries the child *and* the parent needs no second pull, because the
/// applier orders parents first.
#[test]
fn a_child_and_its_parent_in_one_batch_both_land() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Binder', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('A', 'commander', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let report = apply(&b, &outbox(&a)).unwrap();
    assert_eq!(report.deferred, 0);
    let folder: Option<i64> = b
        .query_row("SELECT folder_id FROM decks", [], |r| r.get(0))
        .unwrap();
    assert!(folder.is_some());
}

/// **`decks.default_category_id` is translated and never carried as a foreign row id.**
///
/// The originating device's category is `id = 1` there and something else here, so a field
/// carrying the number would point this deck at whatever pile happened to take that rowid.
#[test]
fn the_default_category_is_translated_rather_than_carried() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    // `b` gets a deck and a category of its own first, so the two databases disagree about
    // which rowid a category has — which is the whole point.
    b.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('Decoy', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    b.execute(
        "INSERT INTO deck_categories
            (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
         VALUES (1, 'Decoy pile', 'main', 1, 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();

    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('A', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_categories
            (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
         VALUES (1, 'Ramp', 'main', 1, 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute("UPDATE decks SET default_category_id = 1", [])
        .unwrap();

    apply(&b, &outbox(&a)).unwrap();

    let (default_id, name): (i64, String) = b
        .query_row(
            "SELECT d.default_category_id, c.name
               FROM decks d JOIN deck_categories c ON c.id = d.default_category_id
              WHERE d.name = 'A'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_ne!(default_id, 1, "the foreign device's rowid must not survive");
    assert_eq!(name, "Ramp", "and it must point at the right pile");
}

/// Auto stays Auto. `0` is a sentinel and a NULL would fail a `NOT NULL` column.
#[test]
fn a_deck_on_auto_arrives_on_auto() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('A', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &outbox(&a)).unwrap();
    let default_id: i64 = b
        .query_row("SELECT default_category_id FROM decks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(default_id, crate::deck::AUTO_CATEGORY);
}

/// The two `CHECK`s differ on purpose and the applier has to know it. A `deck_cards` row taken
/// to zero **goes**; a `collection_entries` row taken below zero **stays, clamped**.
#[test]
fn a_deck_card_at_zero_goes_and_a_collection_row_stays() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, _) = (0, 0);
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('A', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_categories
            (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
         VALUES (1, 'Main', 'main', 1, 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             quantity, created_at, updated_at)
         VALUES (1, 1, 'live', 'c1', 'lea', '1', 'en', 'Bolt', 2, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    add_copy(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(qty(&b), (1, 1));

    a.execute("UPDATE deck_cards SET quantity = 1", []).unwrap();
    a.execute("DELETE FROM deck_cards", []).unwrap();
    a.execute("UPDATE collection_entries SET quantity = 0", [])
        .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();

    let cards: i64 = b
        .query_row("SELECT count(*) FROM deck_cards", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cards, 0, "a deck card at zero is not a row");
    assert_eq!(
        qty(&b),
        (1, 0),
        "a collection row at zero keeps its provenance"
    );
}

/// **A folder cycle is broken and the later move goes to the root**, with a sentence.
///
/// A moves Outer under Inner; B moves Inner under Outer. Neither device sees a loop on its own;
/// both do once they exchange.
#[test]
fn a_folder_cycle_is_broken_and_the_later_move_goes_to_the_root() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Outer', 0, unixepoch(), unixepoch()),
                ('Inner', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    // Two concurrent moves that make a loop. `b`'s clock is pushed a minute ahead first, so
    // which move is the LATER one is a fact rather than a race between two wall clocks inside
    // one millisecond — without it this test passes or fails on scheduling.
    a.execute(
        "UPDATE deck_folders SET parent_id = (SELECT id FROM deck_folders WHERE name = 'Inner')
          WHERE name = 'Outer'",
        [],
    )
    .unwrap();
    b.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
    b.execute(
        "UPDATE deck_folders SET parent_id = (SELECT id FROM deck_folders WHERE name = 'Outer')
          WHERE name = 'Inner'",
        [],
    )
    .unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(rb.cycles_broken, 1);
    assert_eq!(ra.cycles_broken, 1);

    for (who, c) in [("a", &a), ("b", &b)] {
        let rooted: Vec<String> = {
            let mut stmt = c
                .prepare("SELECT name FROM deck_folders WHERE parent_id IS NULL ORDER BY name")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(rooted.len(), 1, "{who} still has a loop or lost the tree");
        let review: Option<String> = c
            .query_row(
                "SELECT needs_review FROM deck_folders WHERE parent_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(review.as_deref(), Some(CYCLE_BROKEN), "{who} says nothing");
    }

    // ...and both devices picked the SAME folder, which is what convergence means here.
    let name = |c: &Connection| -> String {
        c.query_row(
            "SELECT name FROM deck_folders WHERE parent_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(name(&a), name(&b), "the two devices broke different links");
    // ...and it is the LATER move that was undone. `b` moved Inner a minute after `a` moved
    // Outer, so Inner is the one that goes back to the root and `a`'s earlier move stands.
    assert_eq!(
        name(&a),
        "Inner",
        "the earlier move must be the one that survives"
    );
}

/// What `managed_wishlist::settle_deck` leaves for a deck's **Tokens** subfolder: a folder
/// under a folder, both written behind [`capture::suppressed`], so the insert trigger's mint
/// never ran and neither row has a `sync_uid`.
fn managed_tokens_folder(conn: &Connection) {
    capture::suppressed(conn, || {
        conn.execute_batch(
            "INSERT INTO wishlist_folders (name, sort_order, created_at, updated_at)
             VALUES ('Deck', 0, 0, 0);
             INSERT INTO wishlist_folders (parent_id, name, sort_order, created_at, updated_at)
             VALUES ((SELECT id FROM wishlist_folders WHERE name = 'Deck'), 'Tokens', 0, 0, 0);",
        )
    })
    .unwrap();
    let nameless: i64 = conn
        .query_row(
            "SELECT count(*) FROM wishlist_folders WHERE sync_uid IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(nameless, 2, "the fixture is not what a managed folder is");
}

/// **A folder with no `sync_uid` does not stop a pull.**
///
/// The cycle check reads every folder that has a parent, after every apply, and it read the
/// uid as a `String` — so one nameless child failed the whole batch with `Invalid column type
/// Null at index: 2, name: sync_uid`, on every pull, for as long as the row stood. A theory
/// deck's managed wishlist makes exactly that row (user schema v55's Tokens subfolder), and it
/// is nameless on purpose: the folder is derived per device and must never be announced.
#[test]
fn a_folder_with_no_uid_does_not_stop_a_pull() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    managed_tokens_folder(&b);

    add_copy(&a);
    let report = apply(&b, &outbox(&a)).unwrap();

    assert_eq!(unwritten(report), (0, 0));
    assert_eq!(qty(&b), (1, 1), "the peer's copy never landed");
}

/// **A loop that runs through a nameless folder is still found.**
///
/// Reading the uid as optional is the fix; leaving nameless folders out of the walk would stop
/// the error too, and would stop the walk at the first one — so a loop through it stood. The
/// nameless folder has no move on record, so the cut still falls on the later of the two moves
/// the devices made.
#[test]
fn a_loop_through_a_folder_with_no_uid_is_still_broken() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Outer', 0, unixepoch(), unixepoch()),
                ('Inner', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    capture::suppressed(&b, || {
        b.execute(
            "INSERT INTO deck_folders (parent_id, name, sort_order, created_at, updated_at)
             VALUES ((SELECT id FROM deck_folders WHERE name = 'Outer'), 'Mid', 0, 0, 0)",
            [],
        )
    })
    .unwrap();

    // Outer → Inner on `a`; Inner → Mid on `b`, a minute later; and Mid is already under Outer.
    a.execute(
        "UPDATE deck_folders SET parent_id = (SELECT id FROM deck_folders WHERE name = 'Inner')
          WHERE name = 'Outer'",
        [],
    )
    .unwrap();
    b.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
    b.execute(
        "UPDATE deck_folders SET parent_id = (SELECT id FROM deck_folders WHERE name = 'Mid')
          WHERE name = 'Inner'",
        [],
    )
    .unwrap();

    let report = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(report.cycles_broken, 1);
    let rooted: String = b
        .query_row(
            "SELECT name FROM deck_folders WHERE parent_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rooted, "Inner", "the later move is the one undone");
}

/// **A device's clock is pulled past everything it just applied.** Without that, an edit made
/// *after* seeing a peer's op can carry a stamp that sorts *before* it, and last-writer-wins
/// decides by which machine happened to have the faster clock.
#[test]
fn applying_a_batch_pulls_the_clock_past_what_it_saw() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    a.execute("UPDATE sync_clock SET ms = ms + 3600000", [])
        .unwrap();
    add_copy(&a);
    let ops = outbox(&a);
    let top = ops.last().unwrap().at.clone();

    apply(&b, &ops).unwrap();
    let (ms, ctr): (i64, i64) = b
        .query_row("SELECT ms, ctr FROM sync_clock WHERE id = 1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    let now = crate::sync_engine::hlc::Hlc {
        ms,
        ctr,
        device: "dev-b".into(),
    };
    assert!(now > top, "{now:?} must sort after {top:?}");
}

/// **The first message wins**, which is [`crate::reconcile`]'s stated rule for `needs_review`.
/// A resurrection must not overwrite a sentence the reconciler already wrote about a printing
/// that vanished from Scryfall — that one is still true and is the more actionable of the two.
#[test]
fn a_resurrection_does_not_overwrite_an_existing_sentence() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    b.execute(
        "UPDATE collection_entries SET needs_review = 'This printing left Scryfall.'",
        [],
    )
    .unwrap();
    let _ = since(&b, &mut mb);
    a.execute("DELETE FROM collection_entries", []).unwrap();
    b.execute("UPDATE collection_entries SET notes = 'keep'", [])
        .unwrap();

    let report = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(report.resurrected, 1);
    let review: Option<String> = b
        .query_row("SELECT needs_review FROM collection_entries", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        review.as_deref(),
        Some("This printing left Scryfall."),
        "the first message wins"
    );
}

/// **Two devices each taking one copy out of a deck end with the card gone**, not with a
/// constraint failure. `deck_cards.quantity` is `CHECK (quantity > 0)`, so no device can ever
/// *store* the zero this arithmetic produces — the row has to go instead.
#[test]
fn two_devices_each_removing_a_copy_take_a_deck_card_to_nothing() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('A', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_categories
            (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
         VALUES (1, 'Main', 'main', 1, 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             quantity, created_at, updated_at)
         VALUES (1, 1, 'live', 'c1', 'lea', '1', 'en', 'Bolt', 2, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    a.execute("UPDATE deck_cards SET quantity = 1", []).unwrap();
    b.execute("UPDATE deck_cards SET quantity = 1", []).unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();

    for (who, c) in [("a", &a), ("b", &b)] {
        let n: i64 = c
            .query_row("SELECT count(*) FROM deck_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "{who} still lists a card nobody has copies of");
    }
}

/// ...and the same arithmetic on a **collection** row clamps at zero and keeps the row, because
/// `collection_entries.quantity` is `CHECK (quantity >= 0)` and a stepper taken to zero there is
/// a real state: the row keeps its condition, its price and its acquisition story.
#[test]
fn two_devices_each_removing_two_copies_clamp_a_collection_row_at_zero() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,notes,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',2,'bought at a PTQ',
                 unixepoch(),unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    a.execute("UPDATE collection_entries SET quantity = 0", [])
        .unwrap();
    b.execute("UPDATE collection_entries SET quantity = 0", [])
        .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();

    for (who, c) in [("a", &a), ("b", &b)] {
        let (rows, sum) = qty(c);
        assert_eq!((rows, sum), (1, 0), "{who} threw the provenance away");
        let notes: Option<String> = c
            .query_row("SELECT notes FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(notes.as_deref(), Some("bought at a PTQ"));
    }
}

/// **A stalled stream stops at the op that stalled it**, and the ops after it in the same
/// batch are left for the next pull.
///
/// That is the only arrangement that neither loses an op nor doubles a counter: advancing the
/// watermark past the block loses it, and applying what follows while holding the watermark
/// below means the next pull re-delivers those ops and applies them a second time.
#[test]
fn a_deferred_op_holds_the_watermark_below_the_ops_that_follow_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Binder', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let folder_ops = since(&a, &mut ma);
    a.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('A', 'commander', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_labels (name, name_key, color, created_at, updated_at)
         VALUES ('Ramp', 'ramp', '#0f0', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let rest = since(&a, &mut ma);

    // The deck stalls on a folder `b` has never heard of, and the label behind it waits its
    // turn even though nothing about the label is unresolvable.
    let report = apply(&b, &rest).unwrap();
    assert!(report.deferred > 0, "the deck should not have applied");
    let labels: i64 = b
        .query_row("SELECT count(*) FROM deck_labels", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        labels, 0,
        "the stream is stalled, so nothing behind the block may land"
    );
    let peers: i64 = b
        .query_row("SELECT count(*) FROM sync_peers", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        peers, 0,
        "the watermark stepped over the op that stalled the stream"
    );

    // The folder arrives; the next pull re-delivers everything and the deck lands.
    apply(&b, &folder_ops).unwrap();
    let report = apply(&b, &rest).unwrap();
    assert_eq!(report.deferred, 0);
    let (decks, labels): (i64, i64) = b
        .query_row(
            "SELECT (SELECT count(*) FROM decks), (SELECT count(*) FROM deck_labels)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (decks, labels),
        (1, 1),
        "the whole stream lands once it can"
    );
}

/// **`muted_tags` travels at all**, which it could not while its own primary key was on no
/// list: `namespace` and `tag_id` are `NOT NULL` and are not a rowid the far device can invent.
#[test]
fn a_muted_tag_travels_with_its_primary_key() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    a.execute(
        "INSERT INTO muted_tags (namespace, tag_id, slug, muted_at)
         VALUES ('art', 'uuid-1', 'dragon', 5)",
        [],
    )
    .unwrap();
    apply(&b, &outbox(&a)).unwrap();
    let (ns, tag, slug): (String, String, String) = b
        .query_row("SELECT namespace, tag_id, slug FROM muted_tags", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(
        (ns.as_str(), tag.as_str(), slug.as_str()),
        ("art", "uuid-1", "dragon")
    );
}

/// **A rename reaches the other device.** This is the whole feature: two devices converge on
/// one name for a third, with no pairing ceremony in between and no key material on the wire.
#[test]
fn a_renamed_device_is_renamed_on_the_other_device_too() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    // **Seeded with capture SUPPRESSED, because that is how the row really gets here.** A
    // device learns a peer's name from a sync, and `apply` runs inside `capture::suppressed`,
    // so the row arrives writing no op of its own.
    //
    // Seeding it as an ordinary local write instead makes B's insert a competing op, and the
    // combined fold then weighs it against A's rename by stamp. That is a race, and it is one
    // this test lost on Linux while passing on Windows: all three writes can land in one
    // millisecond, leaving `(ms, ctr)` tied and the device id to break it — and `dev-a` sorts
    // before `dev-b`, so B's own "This device" won and the rename was discarded. The feature
    // was never at fault; the fixture was inventing a conflict the app does not have.
    //
    // **One uid on both, and suppressed, because that is the state a rename actually finds.**
    // Suppressing the insert also suppresses the *mint* — it lives in the same trigger — so a
    // suppressed row is anonymous and the first update to it fails `sync_ops.uid NOT NULL`.
    //
    // The shared uid is not a convenience. **A rename op is sparse**: the update trigger emits
    // only the columns that changed, so it carries `name` and not `device_id` — and without
    // `device_id` the grain cannot bind. A rename therefore travels by *uid*, which is why the
    // two sides must already have converged on one. They always have by then, and
    // `a_rename_travels_once_two_independent_rows_have_met` drives that convergence rather than
    // assuming it.
    for c in [&a, &b] {
        capture::suppressed(c, || {
            c.execute(
                "INSERT INTO device_names (device_id, name, created_at, updated_at, sync_uid)
                 VALUES ('dev-c', 'This device', 0, 0, 'uid-dev-c')",
                [],
            )
        })
        .unwrap();
    }
    a.execute(
        "UPDATE device_names SET name = 'Kitchen tablet' WHERE device_id = 'dev-c'",
        [],
    )
    .unwrap();
    apply(&b, &outbox(&a)).unwrap();

    let got: String = b
        .query_row(
            "SELECT name FROM device_names WHERE device_id = 'dev-c'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(got, "Kitchen tablet");
    let rows: i64 = b
        .query_row("SELECT count(*) FROM device_names", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        rows, 1,
        "the grain must match on device_id, not insert a second row"
    );
}

/// Two devices that independently named the same peer end with ONE row, by grain — the same
/// argument `muted_tags` makes, on a table whose primary key is a device id rather than a rowid
/// the far device could ever invent.
#[test]
fn two_devices_naming_one_peer_end_with_one_row() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    a.execute(
        "INSERT INTO device_names (device_id, name, created_at, updated_at)
         VALUES ('dev-c', 'Desktop', 0, 0)",
        [],
    )
    .unwrap();
    b.execute(
        "INSERT INTO device_names (device_id, name, created_at, updated_at)
         VALUES ('dev-c', 'Phone', 0, 0)",
        [],
    )
    .unwrap();
    let (from_a, from_b) = (outbox(&a), outbox(&b));
    apply(&b, &from_a).unwrap();
    apply(&a, &from_b).unwrap();

    for (who, c) in [("a", &a), ("b", &b)] {
        let (rows, name): (i64, String) = c
            .query_row("SELECT count(*), max(name) FROM device_names", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(rows, 1, "{who} kept two rows for one device");
        // `dev-b` wrote second, so its op carries the later stamp on both machines — and where
        // the millisecond is shared the device id breaks the tie the same way everywhere.
        assert_eq!(name, "Phone", "{who} did not converge on the later name");
    }

    // ...and they agree on which uid that row wears, which is what stops the next round from
    // splitting it again.
    let ua: String = a
        .query_row("SELECT sync_uid FROM device_names", [], |r| r.get(0))
        .unwrap();
    let ub: String = b
        .query_row("SELECT sync_uid FROM device_names", [], |r| r.get(0))
        .unwrap();
    assert_eq!(ua, ub, "the two devices must adopt one uid");
}

/// **A stale field from a peer does not overwrite a newer local edit.** The incoming fold says
/// what the peer wants; the combined fold says who won.
#[test]
fn an_older_remote_edit_does_not_beat_a_newer_local_one() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    a.execute("UPDATE collection_entries SET notes = 'from a'", [])
        .unwrap();
    let from_a = since(&a, &mut ma);
    // `b` edits afterwards, so its clock is strictly later.
    b.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
    b.execute("UPDATE collection_entries SET notes = 'from b'", [])
        .unwrap();

    apply(&b, &from_a).unwrap();
    let notes: Option<String> = b
        .query_row("SELECT notes FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        notes.as_deref(),
        Some("from b"),
        "an older remote edit overwrote a newer local one"
    );
}

/// A whole deck round-trips: folder, deck, categories, cards and the audit rows behind them.
#[test]
fn a_whole_deck_crosses_intact() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Shelf', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO decks (name, format_key, folder_id, description, created_at, updated_at)
         VALUES ('Atraxa', 'commander', 1, 'a plan', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_categories
            (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
         VALUES (1, 'Main deck', 'main', 1, 0, unixepoch(), unixepoch()),
                (1, 'Ramp', 'main', 1, 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             quantity, created_at, updated_at)
         VALUES (1, 2, 'live', 'c1', 'cmr', '1', 'en', 'Sol Ring', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_audit (deck_id, at, kind, payload, delta)
         VALUES (1, 100, 'add', '{}', 1)",
        [],
    )
    .unwrap();

    let report = apply(&b, &outbox(&a)).unwrap();
    assert_eq!(unwritten(report), (0, 0), "nothing may be left behind");

    let counts: Vec<i64> = [
        "SELECT count(*) FROM deck_folders",
        "SELECT count(*) FROM decks",
        "SELECT count(*) FROM deck_categories",
        "SELECT count(*) FROM deck_cards",
        "SELECT count(*) FROM deck_audit",
    ]
    .iter()
    .map(|q| b.query_row(q, [], |r| r.get::<_, i64>(0)).unwrap())
    .collect();
    assert_eq!(counts, vec![1, 1, 2, 1, 1]);

    let (card, pile): (String, String) = b
        .query_row(
            "SELECT dc.name, c.name FROM deck_cards dc
               JOIN deck_categories c ON c.id = dc.category_id",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((card.as_str(), pile.as_str()), ("Sol Ring", "Ramp"));
}

/// **A field this build no longer syncs is skipped rather than stalling the peer that sends
/// it** — the property that made dropping a synced column affordable at all.
///
/// A device still on user schema v42 goes on emitting `decks` ops carrying `notes`. This build's
/// `decks` spec has no such field: v43 dropped the column and put `deck_notes` /
/// `deck_note_cards` in its place. The op must **apply**. A deferral here would either hold that
/// device's stream or skip the op — which is what an unknown *table* costs, held from a newer
/// device and skipped from an older one — and a dropped *column* must cost neither.
///
/// The mechanism is `super::updates` and `super::creations`, which walk the **local**
/// spec's field list and look each name up in the incoming op, so a field the op carries and
/// the spec does not is never visited. Both halves are driven, because they fail differently:
/// an **insert** carrying `notes` beside fields the spec does know, and a **sparse update**
/// carrying `notes` and nothing else — which is exactly what a v42 device's update trigger
/// emits for an edit to that one column, and the case where the applier is left with no column
/// to write at all.
#[test]
fn a_field_this_build_no_longer_syncs_is_skipped_rather_than_stalling() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('Atraxa', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let mut insert = since(&a, &mut ma);
    assert_eq!(insert.len(), 1);
    // Splicing the field in is what makes this a test of the *receiving* side. Nothing in this
    // build emits it any more, which the assertion above the splice is there to keep true.
    assert!(
        !insert[0].fields.contains_key("notes"),
        "this build must no longer put `notes` on the wire: {:?}",
        insert[0].fields
    );
    insert[0]
        .fields
        .insert("notes".to_owned(), serde_json::json!("a plan"));
    let uid = insert[0].uid.clone();

    let report = apply(&b, &insert).unwrap();
    assert_eq!(
        unwritten(report),
        (0, 0),
        "a dropped column deferred the op"
    );
    assert_eq!(report.applied, 1);
    let name: String = b
        .query_row("SELECT name FROM decks WHERE sync_uid = ?1", [&uid], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(name, "Atraxa", "the deck did not land");

    // ...and the watermark followed it, which is the other half of what a deferral costs: the
    // sending device would be stalled at this op for ever.
    let mark: (i64, i64) = b
        .query_row(
            "SELECT last_ms, last_ctr FROM sync_peers WHERE device_id = 'dev-a'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let last = insert.last().unwrap();
    assert_eq!(mark, (last.at.ms, last.at.ctr), "dev-a's stream stalled");

    // The sparse case. `description` is captured, so this produces a real one-field update op;
    // renaming its key is a v42 device editing the notes and nothing else.
    a.execute("UPDATE decks SET description = 'a plan'", [])
        .unwrap();
    let mut edit = since(&a, &mut ma);
    assert_eq!(edit.len(), 1);
    let value = edit[0]
        .fields
        .remove("description")
        .expect("an update carries only what moved");
    assert!(edit[0].fields.is_empty(), "the op was not sparse: {edit:?}");
    edit[0].fields.insert("notes".to_owned(), value);

    let report = apply(&b, &edit).unwrap();
    assert_eq!(
        unwritten(report),
        (0, 0),
        "an op naming nothing but a dropped column deferred"
    );
    assert_eq!(report.applied, 1);
    let (name, description): (String, Option<String>) = b
        .query_row(
            "SELECT name, description FROM decks WHERE sync_uid = ?1",
            [&uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(name, "Atraxa");
    assert_eq!(
        description, None,
        "a field this spec does not name must write no column"
    );
}

/// **"Clear collection" crosses, and it is the sharpest ordering case there is.**
///
/// `reset::clear_collection` deletes every folder and immediately rebuilds `Recently removed`
/// and one group per deck — and `idx_collection_folder_removed` is `UNIQUE (kind) WHERE kind =
/// 'removed'`, so the far device must apply the delete **before** the insert or the whole thing
/// is a constraint failure. Groups are ordered by their earliest stamp within a table, which is
/// what makes that true; this is the test that would notice if it stopped being.
#[test]
fn clearing_the_collection_crosses_without_two_holding_areas() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, _) = (0, 0);
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('Atraxa', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    // Both devices already have a seeded `Recently removed` — under two different uids,
    // because each database minted its own. That is the state a pairing group is in from the
    // moment it exists, and it is the whole reason this table needs a grain.
    a.execute(
        "INSERT INTO collection_folders
            (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
         VALUES (NULL, 'Atraxa', 'deck', 1, 0, unixepoch(), unixepoch()),
                (NULL, 'Binder', 'user', NULL, 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    add_copy(&a);
    let report = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(unwritten(report), (0, 0));
    let (ua, ub): (String, String) = (
        a.query_row(
            "SELECT sync_uid FROM collection_folders WHERE kind = 'removed'",
            [],
            |r| r.get(0),
        )
        .unwrap(),
        b.query_row(
            "SELECT sync_uid FROM collection_folders WHERE kind = 'removed'",
            [],
            |r| r.get(0),
        )
        .unwrap(),
    );
    assert_ne!(ua, ub, "two seeds, two uids — that is the premise");

    let cleared = crate::reset::clear_collection(&a).unwrap();
    assert_eq!(cleared.entries, 1);

    let report = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(
        unwritten(report),
        (0, 0),
        "a folder rebuild must neither stall the stream nor be skipped"
    );

    let (removed, groups): (i64, i64) = b
        .query_row(
            "SELECT (SELECT count(*) FROM collection_folders WHERE kind = 'removed'),
                    (SELECT count(*) FROM collection_folders WHERE kind = 'deck')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(removed, 1, "two holding areas is what the index forbids");
    assert_eq!(groups, 1, "one group per deck, and the deck survived");
    let entries: i64 = b
        .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(entries, 0, "the clear must cross");
}

/// **A deck's group folder converges on the second grain**, `idx_collection_folder_deck`.
///
/// It fires when both devices built one for the same deck independently, which is what two
/// readers each pressing "Clear collection" produces: the rebuild makes one group per deck, and
/// the two mint different uids.
#[test]
fn two_devices_rebuilding_a_deck_group_end_with_one() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('Atraxa', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    // Both readers clear their collection, so both rebuild a group for that deck.
    crate::reset::clear_collection(&a).unwrap();
    crate::reset::clear_collection(&b).unwrap();
    let (ga, gb): (String, String) = (
        a.query_row(
            "SELECT sync_uid FROM collection_folders WHERE kind = 'deck'",
            [],
            |r| r.get(0),
        )
        .unwrap(),
        b.query_row(
            "SELECT sync_uid FROM collection_folders WHERE kind = 'deck'",
            [],
            |r| r.get(0),
        )
        .unwrap(),
    );
    assert_ne!(ga, gb, "two rebuilds, two uids — that is the premise");

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    // **A skip is the shape of the failure this grain prevents**, not a crash: without it the
    // insert hits `idx_collection_folder_deck`, the savepoint rolls back, the op is dropped as a
    // row this database cannot build, and each device quietly keeps its own group forever while
    // the counts still read 1.
    assert_eq!((unwritten(ra), unwritten(rb)), ((0, 0), (0, 0)));

    for (who, c) in [("a", &a), ("b", &b)] {
        let groups: i64 = c
            .query_row(
                "SELECT count(*) FROM collection_folders WHERE kind = 'deck'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(groups, 1, "{who} has two groups for one deck");
        let removed: i64 = c
            .query_row(
                "SELECT count(*) FROM collection_folders WHERE kind = 'removed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(removed, 1, "{who} has two holding areas");
    }

    // ...and they agree on WHICH group it is, which is what convergence means and what a
    // count of one cannot say.
    let uid = |c: &Connection| -> String {
        c.query_row(
            "SELECT sync_uid FROM collection_folders WHERE kind = 'deck'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(uid(&a), uid(&b), "the two devices kept separate groups");
}

/// **...and an ordinary folder is NOT folded by that grain.** `idx_collection_folder_removed`
/// is partial — `UNIQUE (kind) WHERE kind = 'removed'` — so a predicate that matched on
/// `kind` alone would decide that every device's "Binder" and every device's "Trades" are one
/// folder, because both are `kind = 'user'`. Two folders the reader made are two folders.
#[test]
fn two_user_folders_are_not_folded_by_the_partial_grain() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    a.execute(
        "INSERT INTO collection_folders
            (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
         VALUES (NULL, 'Binder', 'user', NULL, 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    b.execute(
        "INSERT INTO collection_folders
            (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
         VALUES (NULL, 'Trades', 'user', NULL, 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &outbox(&a)).unwrap();
    apply(&a, &outbox(&b)).unwrap();

    for (who, c) in [("a", &a), ("b", &b)] {
        let mut stmt = c
            .prepare("SELECT name FROM collection_folders WHERE kind = 'user' ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            names,
            vec!["Binder", "Trades"],
            "{who} folded two folders into one"
        );
    }
}

/// The watermark moves to the last op applied, so the next pull asks for less.
#[test]
fn the_watermark_follows_what_was_applied() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    add_copy(&a);
    let ops = outbox(&a);
    apply(&b, &ops).unwrap();
    let (ms, ctr): (i64, i64) = b
        .query_row(
            "SELECT last_ms, last_ctr FROM sync_peers WHERE device_id = 'dev-a'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let last = ops.last().unwrap();
    assert_eq!((ms, ctr), (last.at.ms, last.at.ctr));
}

/// **Every UNIQUE index on a synced table is decided about, and the list is read off a live
/// database rather than off `schema.rs`.**
///
/// This is the fence the last three bugs would have hit. `collection_folders` has two partial
/// unique indexes and the plan called the table uid-only; `deck_categories` has a second one
/// nobody had noticed. A uid-only table with a unique index does not fail loudly: the insert
/// hits the index, the group's savepoint rolls back, and the two devices quietly keep separate
/// rows while every count still reads one.
///
/// `pragma_index_list` and not a grep, for the reason
/// `schema.rs`'s own ladder makes necessary: that file is a migration ladder, so a `CREATE
/// UNIQUE INDEX` in it can name a shape a later rung replaced.
#[test]
fn every_unique_index_on_a_synced_table_has_been_decided_about() {
    let conn = crate::schema::memory_pair();
    let mut found: Vec<String> = Vec::new();
    for table in crate::schema::SYNCED_TABLES {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT name FROM pragma_index_list('{table}') WHERE \"unique\" = 1"
            ))
            .unwrap();
        for name in stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
        {
            // Every synced table has one of these and it is the identity column itself, not a
            // grain: `apply` looks a row up by it after the grains have missed.
            if name == format!("idx_{table}_uid") {
                continue;
            }
            found.push(format!("{table}.{name}"));
        }
    }
    found.sort();

    // Each of these is a grain in `META` above, except where the comment says otherwise.
    assert_eq!(
        found,
        [
            // `COLLECTION_GRAIN`, eleven terms.
            "collection_entries.idx_collection_grain",
            // Partial: one group per deck.
            "collection_folders.idx_collection_folder_deck",
            // Partial: one holding area per database, and every database seeds its own.
            "collection_folders.idx_collection_folder_removed",
            // `DECK_CARD_GRAIN`, five terms since v19.
            "deck_cards.idx_deck_cards_grain",
            // `DECK_CATEGORY_GRAIN` — one name per list of a deck since v53.
            "deck_categories.idx_deck_categories_grain",
            // Partial: one Sideboard, Commander, Companion and Maybeboard per list since v53.
            "deck_categories.idx_deck_categories_kind",
            // `DECK_LABEL_GRAIN` — one app-wide list since v21.
            "deck_labels.idx_deck_labels_grain",
            // `DECK_NOTE_CARD_GRAIN` — one row per card per note since v43. **`deck_notes`
            // itself is absent from this list on purpose**: it carries only its `_uid` index,
            // which the loop above skips by name, because two devices each typing a note about
            // the mana base must stay two notes and no column pair could tell an accidental
            // duplicate from a deliberate one.
            "deck_note_cards.idx_deck_note_cards_grain",
            // `DECK_TOKEN_PRINTING_GRAIN` — one entry per printing, finish and list since v52,
            // and per variant where the row below deliberately is not: theory and live never
            // share an entry.
            "deck_token_printings.idx_deck_token_printings_grain",
            // `DECK_TOKEN_GRAIN` — one row per token per deck since v37, and deliberately not
            // per variant.
            "deck_tokens.idx_deck_tokens_grain",
            // **The second of the two that are not a `CREATE INDEX` at all.** `device_names`
            // is `WITHOUT ROWID` on `device_id` (user schema v31), so its primary key IS the
            // table and SQLite reports it here under a generated name. It is the table's
            // grain, and `META`'s spec for it is `device_id = ?`.
            "device_names.sqlite_autoindex_device_names_1",
            // **Not a `CREATE INDEX` either**: `muted_tags` is `WITHOUT ROWID` on
            // `(namespace, tag_id)`, so its primary key IS the table and SQLite reports it
            // here under a generated name. It is the table's grain, and `apply`'s spec for it
            // spells those two columns out.
            "muted_tags.sqlite_autoindex_muted_tags_1",
            // **`sticky_notes` would sort here and is absent on purpose** (user schema v46).
            // It carries one UNIQUE index, `idx_sticky_notes_uid`, which the loop above skips
            // by name like every other table's — so this list does not grow a row for it, and
            // a task list that says to add one is describing a red test. The reason it has no
            // grain is `deck_notes`': two devices each typing a note about the same thing must
            // stay two notes, and no column pair here could tell an accidental duplicate from
            // a deliberate one. If `sticky_notes` ever gains a second UNIQUE index, this test
            // is what will say so.
            // `WISHLIST_GRAIN`, four terms since v23.
            "wishlist_entries.idx_wishlist_grain",
            // **Not a grain, and not about sync at all** (user schema v48): one managed folder
            // per deck. `managed_deck_id` is on no capture spec and every row it is set on is
            // written inside `capture::suppressed`, so no op ever carries it and every folder
            // that syncs has it NULL — which a UNIQUE index treats as distinct. No two devices
            // can collide on it.
            "wishlist_folders.idx_wishlist_folders_managed",
        ]
        .map(str::to_owned),
        "a UNIQUE index on a synced table with no grain is two devices keeping separate rows, \
         silently and forever"
    );
}

/// **Two devices adding one printing of one token to one list end with one entry** (user schema
/// v52) — the grain `META` restates, driven the way it fails: each device inserts its own row
/// under its own uid, and without the grain the far op is an insert that hits
/// `idx_deck_token_printings_grain`, rolls the savepoint back, and is skipped as a row this
/// database cannot build.
///
/// The deck crosses first, so both entries hang off one deck uid. **The count is a field**, so
/// the two devices' `2` and `3` do not sum: last writer wins, and both devices agree on which.
/// A second list is the control — the other variant is a row of its own on both devices.
#[test]
fn two_devices_adding_one_token_printing_end_with_one_entry() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('Tithe', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    let entry = |conn: &Connection, variant: &str, quantity: i64| {
        conn.execute(
            "INSERT INTO deck_token_printings
                 (deck_id, variant, oracle_id, card_id, finish, quantity, created_at, updated_at)
             SELECT id, ?1, 'o-treasure', 'p-treasure', 'nonfoil', ?2, 0, 0 FROM decks",
            rusqlite::params![variant, quantity],
        )
        .unwrap();
    };
    entry(&a, "live", 2);
    entry(&b, "live", 3);
    entry(&b, "theory", 1);

    let to_b = since(&a, &mut ma);
    let to_a = since(&b, &mut mb);
    let report = apply(&b, &to_b).unwrap();
    assert_eq!(unwritten(report), (0, 0), "the grain must find b's own row");
    let report = apply(&a, &to_a).unwrap();
    assert_eq!(unwritten(report), (0, 0), "and a's, the other way");

    let read = |conn: &Connection| -> Vec<(String, i64, String)> {
        let mut stmt = conn
            .prepare(
                "SELECT variant, quantity, sync_uid FROM deck_token_printings ORDER BY variant",
            )
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let (on_a, on_b) = (read(&a), read(&b));
    assert_eq!(
        on_a.len(),
        2,
        "one live entry and one theory entry: {on_a:?}"
    );
    assert_eq!(
        on_a, on_b,
        "both devices hold the same rows under the same uids"
    );
    assert!(
        on_a[0].1 == 2 || on_a[0].1 == 3,
        "a count is a field, so it is one device's value and never their sum: {on_a:?}"
    );
}

/// Every pile `conn` holds as `(variant, name, kind, sync_uid)`, in one order on every device.
fn piles_of(conn: &Connection) -> Vec<(String, String, String, String)> {
    let mut stmt = conn
        .prepare("SELECT variant, name, kind, sync_uid FROM deck_categories ORDER BY variant, name")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap();
    rows.map(Result::unwrap).collect()
}

/// **A plan's pile never folds into the deck's pile of the same name** (user schema v53,
/// [#561](https://github.com/Msgaihede/mtg-grimoire/issues/561)) — the grain `META` restates,
/// driven both ways it has to hold.
///
/// Across the list boundary: `a` has a live `Ramp` and a live `Sideboard`, then makes the plan's
/// own `Ramp` and `Sideboard` and files a theory card in that `Ramp`. On `deck_id, name` the far
/// device would find its live `Ramp` for the plan's and file the card there; on `deck_id, kind`
/// it would find its live Sideboard for the plan's. Within one list: `b`, not having heard, makes
/// the plan's `Sideboard` itself — and the two theory Sideboards are one pile under one uid once
/// they meet, like any other pile two devices name alike. (The card is filed in the `Ramp` only
/// `a` made: a child of a pile both devices made is filed under whichever uid loses the `min`,
/// which is the grain's ordinary behaviour and not this test's subject.)
#[test]
fn a_plans_pile_never_folds_into_the_decks_pile_of_the_same_name() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO decks (name, format_key, theory_enabled, created_at, updated_at)
         VALUES ('Planned', 'commander', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let pile = |conn: &Connection, variant: &str, name: &str, kind: &str| {
        conn.execute(
            "INSERT INTO deck_categories
                (deck_id, variant, name, kind, is_active, sort_order, created_at, updated_at)
             SELECT id, ?1, ?2, ?3, 1, 0, unixepoch(), unixepoch() FROM decks",
            [variant, name, kind],
        )
        .unwrap();
    };
    pile(&a, "live", "Ramp", "main");
    pile(&a, "live", "Sideboard", "side");
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    pile(&a, "theory", "Ramp", "main");
    pile(&a, "theory", "Sideboard", "side");
    a.execute(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             quantity, created_at, updated_at)
         SELECT deck_id, id, 'theory', 'sol', 'lea', '270', 'en', 'Sol Ring', 1,
                unixepoch(), unixepoch()
           FROM deck_categories WHERE variant = 'theory' AND name = 'Ramp'",
        [],
    )
    .unwrap();
    pile(&b, "theory", "Sideboard", "side");

    let to_b = since(&a, &mut ma);
    let to_a = since(&b, &mut mb);
    assert!(
        to_b.iter()
            .filter(|op| op.table == "deck_categories")
            .all(|op| op.fields.get("variant") == Some(&serde_json::json!("theory"))),
        "a theory pile's insert carries its list: {to_b:?}"
    );
    let report = apply(&b, &to_b).unwrap();
    assert_eq!(
        unwritten(report),
        (0, 0),
        "b left something of a's unwritten"
    );
    let report = apply(&a, &to_a).unwrap();
    assert_eq!(
        unwritten(report),
        (0, 0),
        "a left something of b's unwritten"
    );

    let (on_a, on_b) = (piles_of(&a), piles_of(&b));
    let shape: Vec<(&str, &str, &str)> = on_b
        .iter()
        .map(|(v, n, k, _)| (v.as_str(), n.as_str(), k.as_str()))
        .collect();
    assert_eq!(
        shape,
        [
            ("live", "Ramp", "main"),
            ("live", "Sideboard", "side"),
            ("theory", "Ramp", "main"),
            ("theory", "Sideboard", "side"),
        ],
        "two lists, two piles of each name, and the two theory Sideboards one pile"
    );
    assert_eq!(
        on_a, on_b,
        "both devices hold the same piles under the same uids"
    );

    let (variant, pile): (String, String) = b
        .query_row(
            "SELECT c.variant, c.name FROM deck_cards dc
               JOIN deck_categories c ON c.id = dc.category_id",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (variant.as_str(), pile.as_str()),
        ("theory", "Ramp"),
        "the plan's card landed in the deck's pile"
    );
}

/// **A pile op with no `variant` still applies, and lands in the live list** — which is what
/// every op a device sent before user schema v53 looks like, and what every pile was before the
/// rung. `variant` joined both of the table's grains, so neither can bind on such an op; the
/// insert goes in under its own uid and takes the column's default. The theory op beside it is
/// the control: the same insert *with* its list lands in that list.
#[test]
fn a_pile_op_with_no_variant_applies_to_the_live_list() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO decks (name, format_key, theory_enabled, created_at, updated_at)
         VALUES ('Planned', 'commander', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    a.execute(
        "INSERT INTO deck_categories
            (deck_id, variant, name, kind, is_active, sort_order, created_at, updated_at)
         SELECT id, 'theory', 'Draw', 'main', 1, 0, unixepoch(), unixepoch() FROM decks",
        [],
    )
    .unwrap();
    let theory = since(&a, &mut ma);
    assert_eq!(theory.len(), 1);
    let report = apply(&b, &theory).unwrap();
    assert_eq!(unwritten(report), (0, 0));
    let landed: String = b
        .query_row(
            "SELECT variant FROM deck_categories WHERE sync_uid = ?1",
            [&theory[0].uid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        landed, "theory",
        "a theory pile's insert applies to the theory list"
    );

    a.execute(
        "INSERT INTO deck_categories
            (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
         SELECT id, 'Ramp', 'main', 1, 1, unixepoch(), unixepoch() FROM decks",
        [],
    )
    .unwrap();
    let mut older = since(&a, &mut ma);
    assert_eq!(older.len(), 1);
    // The splice is what makes this an older sender: nothing in this build omits the field.
    assert!(older[0].fields.remove("variant").is_some(), "{older:?}");
    let report = apply(&b, &older).unwrap();
    assert_eq!(
        unwritten(report),
        (0, 0),
        "an op with no list was not applied"
    );
    let (variant, name): (String, String) = b
        .query_row(
            "SELECT variant, name FROM deck_categories WHERE sync_uid = ?1",
            [&older[0].uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((variant.as_str(), name.as_str()), ("live", "Ramp"));
}

/// **"Looks fine" travels**, which is the claim `sync_engine::commands` makes in prose and
/// nothing else proves. Clearing a sentence is an ordinary write, so it is captured like any
/// other — a row one device has looked at stops asking on the others too, which is the whole
/// reason the sentence lives on the row rather than in a notification.
///
/// The sentence itself does NOT travel: `apply` writes it inside `capture::suppressed`, and
/// both devices reach the same conclusion from the same ops. Only the reader's answer moves.
#[test]
fn clearing_a_review_sentence_travels_to_the_other_device() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    a.execute("DELETE FROM collection_entries", []).unwrap();
    b.execute("UPDATE collection_entries SET notes = 'keep'", [])
        .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    for c in [&a, &b] {
        let review: Option<String> = c
            .query_row("SELECT needs_review FROM collection_entries", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(review.as_deref(), Some(RESURRECTED));
    }

    // The reader looks at it on `b` and says it is fine. `a` should stop asking.
    let _ = since(&a, &mut ma);
    let _ = since(&b, &mut mb);
    b.execute("UPDATE collection_entries SET needs_review = NULL", [])
        .unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();

    let review: Option<String> = a
        .query_row("SELECT needs_review FROM collection_entries", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(review, None, "the other device is still asking");
}

/// **A stalled stream must not double-count the ops that follow the block.** The watermark
/// stays below the unappliable op, so the next pull re-delivers everything above it — and a
/// counter re-applied is the collection growing by itself, which is the failure this whole
/// module is arranged against.
#[test]
fn a_stalled_stream_does_not_double_the_ops_after_the_block() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Binder', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let folder_ops = since(&a, &mut ma);
    // A deck whose folder `b` has never heard of, and then a collection add after it.
    a.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('A', 'commander', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    add_copy(&a);
    let rest = since(&a, &mut ma);

    let first = apply(&b, &rest).unwrap();
    assert!(
        first.deferred > 0,
        "the deck should have stalled the stream"
    );
    assert_eq!(qty(&b), (0, 0), "nothing behind the block may land");

    // The same page again, which is exactly what the next pull hands over.
    apply(&b, &rest).unwrap();
    assert_eq!(qty(&b), (0, 0));

    // The folder arrives and the whole stream lands — once.
    apply(&b, &folder_ops).unwrap();
    apply(&b, &rest).unwrap();
    assert_eq!(qty(&b), (1, 1));
    apply(&b, &rest).unwrap();
    assert_eq!(
        qty(&b),
        (1, 1),
        "the ops after the block were counted twice"
    );
}

/// Applying nothing is a no-op that still commits cleanly.
#[test]
fn an_empty_batch_does_nothing() {
    let b = paired("dev-b");
    let report = apply(&b, &[]).unwrap();
    assert_eq!(report, ApplyReport::default());
}

// ---------------------------------------------------------------------------------------
// The baseline: §8's counter rule and §9's horizon, over the same two databases
// ---------------------------------------------------------------------------------------

/// A collection row with a known quantity and a known `updated_at`.
///
/// The stamp matters as much as the count here: a baseline op is stamped from the row's own
/// modification time (§10.2), so a fixture that let `unixepoch()` decide it would be a test
/// whose ordering changes with the second it ran in.
fn stash(conn: &Connection, card_id: &str, quantity: i64, updated_at: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES (?1,'lea','1','en','nonfoil','NM',?2,?3,?3)",
        rusqlite::params![card_id, quantity, updated_at],
    )
    .unwrap();
}

/// `sync_peers`, as rows a test can compare byte for byte.
fn peers(conn: &Connection) -> Vec<(String, i64, i64)> {
    let mut stmt = conn
        .prepare("SELECT device_id, last_ms, last_ctr FROM sync_peers ORDER BY device_id")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    rows.map(Result::unwrap).collect()
}

/// §9's horizon as the emitter builds it: everything it has already applied (`sync_peers`),
/// plus its own highest stamp.
fn emitter_horizon(conn: &Connection, device: &str) -> Horizon {
    let mut out = Horizon::default();
    let mut stmt = conn
        .prepare("SELECT device_id, last_ms, last_ctr FROM sync_peers")
        .unwrap();
    let watermarks: Vec<Hlc> = stmt
        .query_map([], |r| {
            Ok(Hlc {
                ms: r.get(1)?,
                ctr: r.get(2)?,
                device: r.get(0)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for w in watermarks {
        out.seen.insert(w.device.clone(), w);
    }
    let own: Option<(i64, i64)> = conn
        .query_row(
            "SELECT hlc_ms, hlc_ctr FROM sync_ops WHERE device_id = ?1
              ORDER BY hlc_ms DESC, hlc_ctr DESC LIMIT 1",
            [device],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap();
    if let Some((ms, ctr)) = own {
        out.seen.insert(
            device.to_owned(),
            Hlc {
                ms,
                ctr,
                device: device.to_owned(),
            },
        );
    }
    out
}

/// Every `collection_entries` row as a baseline `put`.
///
/// **Task 4's `baseline::build` does not exist yet**, so this is the hand-written stand-in the
/// tests below are driven from, narrowed to the one table every rule in §8 is about. It keeps
/// the three things those rules turn on: `baseline` is set, `counters` hold **values** rather
/// than deltas, and the stamp is the row's own `updated_at` (§10.2) — never "now", which is
/// what puts a claim BELOW the emitter's own top stamp and makes §9.1's first exemption
/// necessary rather than decorative.
///
/// The horizon rides on the first op, which is where the wire puts it (§9), and `ctr` is a
/// running index so two rows sharing a second still get distinct stamps — `merge::fold` treats
/// two ops with one stamp as one op and would silently drop the second.
fn baseline_ops(conn: &Connection, device: &str) -> Vec<Op> {
    const TEXT: [&str; 8] = [
        "card_id",
        "set_code",
        "collector_number",
        "lang",
        "finish",
        "condition",
        "serial_number",
        "grading",
    ];
    const FLAGS: [&str; 4] = ["altered", "signed", "proxy", "misprint"];
    let mut stmt = conn
        .prepare(
            "SELECT e.sync_uid, e.card_id, e.set_code, e.collector_number, e.lang, e.finish,
                    e.condition, e.serial_number, e.grading,
                    e.altered, e.signed, e.proxy, e.misprint,
                    e.quantity, e.tradelist_quantity, e.updated_at,
                    (SELECT f.sync_uid FROM collection_folders f WHERE f.id = e.folder_id)
               FROM collection_entries e
              ORDER BY e.id",
        )
        .unwrap();
    let mut ops: Vec<Op> = stmt
        .query_map([], |r| {
            let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
            for (i, name) in TEXT.iter().enumerate() {
                let v: Option<String> = r.get(i + 1)?;
                fields.insert(
                    (*name).to_owned(),
                    v.map_or(serde_json::Value::Null, serde_json::Value::String),
                );
            }
            for (i, name) in FLAGS.iter().enumerate() {
                let v: i64 = r.get(i + 9)?;
                fields.insert((*name).to_owned(), serde_json::Value::from(v));
            }
            let mut counters: BTreeMap<String, i64> = BTreeMap::new();
            counters.insert("quantity".to_owned(), r.get(13)?);
            counters.insert("tradelist_quantity".to_owned(), r.get(14)?);
            let mut parents: BTreeMap<String, Option<String>> = BTreeMap::new();
            parents.insert("folder".to_owned(), r.get(16)?);
            let stamp_secs: i64 = r.get(15)?;
            Ok(Op {
                table: "collection_entries".to_owned(),
                uid: r.get(0)?,
                kind: Kind::Put,
                fields,
                counters,
                parents,
                at: Hlc {
                    ms: stamp_secs * 1000,
                    ctr: 0,
                    device: device.to_owned(),
                },
                baseline: true,
                horizon: None,
                schema: None,
                emission: None,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for (i, op) in ops.iter_mut().enumerate() {
        op.at.ctr = i as i64;
    }
    if let Some(first) = ops.first_mut() {
        first.horizon = Some(emitter_horizon(conn, device));
    }
    ops
}

/// §1's live scenario, over two real databases. A pours its collection into B while its own
/// `+1` is still in the same page. B must land on 5 and not 6.
#[test]
fn a_claim_and_the_delta_already_inside_it_do_not_both_count() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    add_copy(&a);
    a.execute("UPDATE collection_entries SET quantity = 5", [])
        .unwrap();
    let mut page: Vec<Op> = outbox(&a); // the ordinary ops, including the +1
    assert_eq!(
        page.len(),
        2,
        "the +1 and the step to five are both on the log"
    );
    let mut base = baseline_ops(&a, "dev-a"); // claims quantity = 5, horizon covers them
    assert_eq!(
        base[0].counters.get("quantity"),
        Some(&5),
        "a claim carries the VALUE, not a delta"
    );
    page.append(&mut base);
    let report = apply(&b, &page).unwrap();
    assert_eq!(qty(&b), (1, 5), "the claim already held the delta");
    assert_eq!(
        report.skipped, 2,
        "both ordinary ops are inside the claim and are dropped"
    );
}

/// §8.2 row 2 end to end: overlapping stashes converge on the larger, never the sum.
#[test]
fn two_devices_that_both_baseline_converge_on_the_larger_count() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "c1", 4, 1_700_000_000);
    stash(&b, "c1", 3, 1_700_000_001);
    let from_a = baseline_ops(&a, "dev-a");
    let from_b = baseline_ops(&b, "dev-b");
    apply(&b, &from_a).unwrap();
    apply(&a, &from_b).unwrap();
    for (name, c) in [("a", &a), ("b", &b)] {
        assert_eq!(
            qty(c),
            (1, 4),
            "{name} did not land on the larger of the two claims"
        );
    }
}

/// The founding constraint, through the new arm: no baseline anywhere, +1 each, ends at 2.
#[test]
fn an_ordinary_exchange_still_lands_at_two() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    add_copy(&a);
    add_copy(&b);
    let from_a = outbox(&a);
    let from_b = outbox(&b);
    assert!(
        from_a.iter().all(|o| !o.baseline && o.horizon.is_none()),
        "the outbox never holds a baseline op"
    );
    apply(&b, &from_a).unwrap();
    apply(&a, &from_b).unwrap();
    for (name, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 2), "{name} lost a card to the claim arm");
    }
}

/// §9.1's fourth row, which is the filter's other direction: a put ABOVE the horizon is
/// genuinely newer than the claim and still applies. A filter that suppressed everything would
/// pass every test above this one.
#[test]
fn a_put_above_the_horizon_is_still_applied() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "c1", 4, 1_700_000_000);
    let mut page = baseline_ops(&a, "dev-a"); // the horizon is A's top stamp, right now
    stash(&a, "c2", 1, 1_700_000_002); // ...and this row was written after it
    page.extend(outbox(&a));
    let report = apply(&b, &page).unwrap();
    assert_eq!(
        qty(&b),
        (2, 5),
        "the row written after the horizon was dropped"
    );
    assert_eq!(
        report.skipped, 1,
        "only the op the horizon actually covers is dropped"
    );
}

/// §9.1, exemption one: a baseline op is NEVER suppressed by the horizon it travels with —
/// the horizon covers the emitter's own top stamp, which is above every backdated claim.
#[test]
fn a_horizon_does_not_suppress_the_baseline_it_arrived_with() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "c1", 4, 1_700_000_000);
    let page = baseline_ops(&a, "dev-a");
    let horizon = page[0].horizon.clone().unwrap();
    assert!(
        horizon.covers(&page[0].at),
        "the claim is not below its own horizon, so this fixture proves nothing"
    );
    let report = apply(&b, &page).unwrap();
    assert_eq!(qty(&b), (1, 4), "the baseline suppressed itself");
    assert_eq!(report.skipped, 0);
}

/// §9.1, exemption two, and the one whose failure is permanent: a tombstone below the horizon
/// is still applied, because a claim cannot say "and this row is gone".
#[test]
fn a_tombstone_below_the_horizon_is_still_applied() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    stash(&a, "c1", 1, 1_700_000_000);
    stash(&a, "c2", 1, 1_700_000_001);
    apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(qty(&b), (2, 2), "the fixture did not converge");

    a.execute("DELETE FROM collection_entries WHERE card_id = 'c1'", [])
        .unwrap();
    let mut page = since(&a, &mut ma); // the tombstone
    page.extend(baseline_ops(&a, "dev-a")); // claims c2 alone; c1 is mentioned nowhere
    let horizon = page.iter().find_map(|o| o.horizon.clone()).unwrap();
    assert!(
        horizon.covers(&page[0].at),
        "the tombstone is not below the horizon, so this fixture proves nothing"
    );
    apply(&b, &page).unwrap();

    let mut stmt = b
        .prepare("SELECT card_id FROM collection_entries ORDER BY card_id")
        .unwrap();
    let left: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        left,
        vec!["c2".to_owned()],
        "B is holding a row the group deleted"
    );
}

/// §8.2 at the **insert**, where "what this device already holds" is zero but its own history
/// is not: a baseline that resurrects a row lands on the claim, never on the claim plus the
/// deltas already inside it.
#[test]
fn a_baseline_that_resurrects_a_row_lands_on_the_claim_alone() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    stash(&a, "c1", 3, 1_700_000_000);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("UPDATE collection_entries SET quantity = quantity + 2", [])
        .unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(qty(&a), (1, 5), "the fixture did not converge on five");

    // B loses the row; A, which had already absorbed B's `+2`, claims five with a later stamp,
    // so add-wins brings the row back.
    b.execute("DELETE FROM collection_entries", []).unwrap();
    a.execute("UPDATE collection_entries SET updated_at = 4000000000", [])
        .unwrap();
    apply(&b, &baseline_ops(&a, "dev-a")).unwrap();
    assert_eq!(
        qty(&b),
        (1, 5),
        "the claim was added to the deltas already inside it"
    );
}

/// §9.1: and none of it writes a watermark. `sync_peers` keeps its existing meaning and its
/// existing single writer, so the horizon cannot make this device skip an op on a later pull.
#[test]
fn the_horizon_never_writes_to_sync_peers() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    add_copy(&a);
    let batch = outbox(&a);
    apply(&b, &batch).unwrap();
    let before = peers(&b);
    assert_eq!(before.len(), 1, "the fixture left no watermark to compare");

    // The same ops again — every one of them already seen — carrying a horizon that names a
    // third device B has never heard from, at a stamp far above anything in the page.
    let mut page = batch.clone();
    let mut horizon = Horizon::default();
    horizon.seen.insert(
        "dev-c".to_owned(),
        Hlc {
            ms: 9_000_000_000_000,
            ctr: 0,
            device: "dev-c".to_owned(),
        },
    );
    page[0].horizon = Some(horizon);
    apply(&b, &page).unwrap();

    let after = peers(&b);
    assert_eq!(after, before, "the horizon was written as a watermark");
    assert!(
        after.iter().all(|(d, _, _)| d != "dev-c"),
        "a device with no ops in the page got a watermark"
    );
}

/// Emitting order agrees with the order `apply` sorts by, so a first sync is one pass.
#[test]
fn every_synced_table_has_a_parents_first_rank() {
    for spec in &capture::TABLES {
        assert!(order_of(spec.table).is_some(), "{} has no rank", spec.table);
    }
}

// ---------------------------------------------------------------------------------------
// Why a group deferred, and whether that holds its device — spec 2026-09-27 §3.2
// ---------------------------------------------------------------------------------------

/// A schema one rung above this build's, which is what a newer device's sealed ops carry.
fn newer() -> Option<i64> {
    Some(crate::schema::USER_SCHEMA_VERSION + 1)
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

/// `device`'s watermark on `conn`, as `(ms, ctr)`.
fn mark_of(conn: &Connection, device: &str) -> Option<(i64, i64)> {
    peers(conn)
        .into_iter()
        .find(|(d, _, _)| d == device)
        .map(|(_, ms, ctr)| (ms, ctr))
}

/// A page from `a`: an op on a table this build does not know, then an ordinary `+1`.
///
/// **The first is a real captured op, relabelled**, so its stamp is one `a`'s clock issued and
/// sits between `a`'s others — a hand-written stamp would be a guess about where that is.
fn a_future_op_then_a_copy(a: &Connection, mark: &mut i64, schema: Option<i64>) -> Vec<Op> {
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Soon', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    add_copy(a);
    let mut page = since(a, mark);
    assert_eq!(page.len(), 2, "one folder insert and one +1: {page:?}");
    page[0].table = "future_table".to_owned();
    for op in &mut page {
        op.schema = schema;
    }
    page
}

/// **A newer device's op that defers is held, and its device's later ops wait behind it** — the
/// one deferral that must hold the stream, because upgrading this device is what resolves it.
/// Skipping it would lose that device's change for good: its later ops apply, the watermark
/// passes it, and nothing ever offers it again.
#[test]
fn a_newer_devices_op_that_defers_is_held_and_blocks_its_later_ops() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    // One op `b` applies first, so `a` has a watermark and "below the held op" is a stamp.
    a.execute(
        "INSERT INTO deck_labels (name, name_key, color, created_at, updated_at)
         VALUES ('Ramp', 'ramp', '#0f0', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let first = since(&a, &mut ma);
    apply(&b, &first).unwrap();
    let before = first.last().unwrap().at.clone();

    let page = a_future_op_then_a_copy(&a, &mut ma, newer());
    for delivery in ["first", "second"] {
        let report = apply(&b, &page).unwrap();
        assert_eq!(
            (report.held_newer, report.deferred),
            (2, 2),
            "{delivery}: the unknown table and the +1 behind it are both held: {report:?}"
        );
        assert_eq!(
            (
                report.held_waiting,
                report.moot,
                report.dropped,
                report.applied
            ),
            (0, 0, 0, 0),
            "{delivery}: {report:?}"
        );
        assert_eq!(
            qty(&b),
            (0, 0),
            "{delivery}: the +1 behind the block landed"
        );
        assert_eq!(
            mark_of(&b, "dev-a"),
            Some((before.ms, before.ctr)),
            "{delivery}: the watermark stepped over the held op"
        );
    }
    assert!(
        skips(&b).is_empty(),
        "a hold is the panel's to say: {:?}",
        skips(&b)
    );
}

/// **The same op from a device on this build is skipped at once, recorded, and takes nothing
/// with it.** A same-version sender naming a table this build does not know is an older device's
/// renamed table — `deck_tags` at v33 — and no upgrade of this device will ever resolve it, so
/// holding the stream on it would pin the relay's log for good.
#[test]
fn a_same_version_unknown_table_is_dropped_recorded_and_does_not_block() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    let page = a_future_op_then_a_copy(&a, &mut ma, None);

    let report = apply(&b, &page).unwrap();
    assert_eq!(report.dropped, 1, "{report:?}");
    assert_eq!(report.applied, 1, "the +1 behind it must apply: {report:?}");
    assert_eq!(
        (
            report.deferred,
            report.held_newer,
            report.held_waiting,
            report.moot
        ),
        (0, 0, 0, 0),
        "{report:?}"
    );
    assert_eq!(qty(&b), (1, 1));
    let last = page.last().unwrap();
    assert_eq!(
        mark_of(&b, "dev-a"),
        Some((last.at.ms, last.at.ctr)),
        "a's watermark must pass both"
    );
    let logged = skips(&b);
    assert_eq!(logged.len(), 1, "{logged:?}");
    let (source, operation, message, detail, count) = &logged[0];
    assert_eq!((source.as_str(), operation.as_str()), ("relay", "apply"));
    assert!(message.contains("future_table"), "{message}");
    assert!(
        detail.as_deref().is_some_and(|d| d.contains(&page[0].uid)),
        "{detail:?}"
    );
    assert_eq!(*count, 1);

    // A re-delivery skips both and records nothing new.
    let again = apply(&b, &page).unwrap();
    assert_eq!((again.skipped, again.dropped), (2, 0), "{again:?}");
    assert_eq!(skips(&b)[0].4, 1, "a re-delivered skip was recorded twice");
    assert_eq!(qty(&b), (1, 1));

    // **A skipped op is consumed even when it is its device's last**, which the page above
    // cannot show: there the `+1` after it carries the watermark past it on its own.
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Later', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let mut lone = since(&a, &mut ma);
    lone[0].table = "future_table".to_owned();
    assert_eq!(apply(&b, &lone).unwrap().dropped, 1);
    assert_eq!(
        mark_of(&b, "dev-a"),
        Some((lone[0].at.ms, lone[0].at.ctr)),
        "the watermark stopped below a skipped op, so it will be skipped again"
    );
    assert_eq!(skips(&b)[0].4, 2, "one row for one table, counted twice");
    let again = apply(&b, &lone).unwrap();
    assert_eq!((again.skipped, again.dropped), (1, 0), "{again:?}");
    assert_eq!(
        skips(&b)[0].4,
        2,
        "a re-delivered lone skip was recorded again"
    );
}

/// A deck and its one pile on `a`, applied to every one of `to`.
fn a_deck_everywhere(a: &Connection, mark: &mut i64, to: &[&Connection]) {
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('A', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_categories
            (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
         VALUES (1, 'Main', 'main', 1, 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let ops = since(a, mark);
    for c in to {
        apply(c, &ops).unwrap();
    }
}

/// One card filed in the only deck and pile `conn` holds.
fn file_a_card(conn: &Connection) {
    conn.execute(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             quantity, created_at, updated_at)
         VALUES ((SELECT id FROM decks), (SELECT id FROM deck_categories), 'live', 'c1', 'lea',
                 '1', 'en', 'Bolt', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
}

fn deck_cards(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM deck_cards", [], |r| r.get(0))
        .unwrap()
}

/// The shared half of the two own-tombstone tests: `b` deletes the deck, `a` files a card in it
/// without having heard, then adds a copy to its binder. Answers the page `a` sends.
fn a_card_in_a_deck_b_deleted(a: &Connection, b: &Connection, schema: Option<i64>) -> Vec<Op> {
    let mut ma = 0;
    a_deck_everywhere(a, &mut ma, &[b]);
    b.execute("DELETE FROM decks", []).unwrap();
    file_a_card(a);
    add_copy(a);
    let mut page = since(a, &mut ma);
    for op in &mut page {
        op.schema = schema;
    }
    page
}

/// **A child of a parent this device deleted is moot**: consumed silently, because it is the
/// convergent outcome — the parent is gone here, so the child has nowhere to be — and nothing
/// can ever arrive that would let it apply. Held, it would pin the relay; recorded, it would put
/// a reader's own delete in the error log as a fault.
#[test]
fn a_child_of_a_parent_this_device_deleted_is_moot() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let page = a_card_in_a_deck_b_deleted(&a, &b, None);

    let report = apply(&b, &page).unwrap();
    assert_eq!(report.moot, 1, "{report:?}");
    assert_eq!(
        (report.deferred, report.dropped, report.applied),
        (0, 0, 1),
        "{report:?}"
    );
    assert_eq!(qty(&b), (1, 1), "a's later op must apply");
    assert_eq!(deck_cards(&b), 0);
    assert!(skips(&b).is_empty(), "moot is not a fault: {:?}", skips(&b));
    let last = page.last().unwrap();
    assert_eq!(mark_of(&b, "dev-a"), Some((last.at.ms, last.at.ctr)));
}

/// **...and so is a child whose parent's delete arrives in the same batch**, from a third device.
/// `b` deleted nothing, so its own log cannot say the deck is gone; the page itself does.
#[test]
fn a_child_whose_parent_is_deleted_in_the_same_batch_is_moot() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    a_deck_everywhere(&a, &mut ma, &[&b, &c]);

    // `c` files a card in the deck while `a` deletes it; neither has heard of the other.
    file_a_card(&c);
    add_copy(&c);
    a.execute("DELETE FROM decks", []).unwrap();
    let mut page = since(&a, &mut ma);
    page.extend(since(&c, &mut mc));

    let report = apply(&b, &page).unwrap();
    assert_eq!(report.moot, 1, "{report:?}");
    assert_eq!((report.deferred, report.dropped), (0, 0), "{report:?}");
    let decks: i64 = b
        .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
        .unwrap();
    assert_eq!((decks, deck_cards(&b)), (0, 0));
    assert_eq!(qty(&b), (1, 1), "c's later op must apply");
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
    let own_dels: i64 = b
        .query_row(
            "SELECT count(*) FROM sync_ops WHERE kind = 'del'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(own_dels, 0, "b's own log must not be what decided it");
}

/// **...but only a parent whose delete would have taken the child with it makes it moot.** A
/// binder is `ON DELETE SET NULL` from its entries: deleting it moves every card in it to the
/// root, and that is what `a` does to its own copy when `b`'s delete reaches it. Consumed as
/// moot on `b`, the copy would be a card `a` holds and `b` never will — so `b` writes it as the
/// foreign key would have left it, at the root, and the two devices agree.
#[test]
fn a_child_of_a_folder_this_device_deleted_lands_at_the_root_on_both() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO collection_folders (name, kind, sort_order, created_at, updated_at)
         VALUES ('Trades', 'user', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    // `b` throws the binder away while `a`, which has not heard, files a copy in it.
    b.execute("DELETE FROM collection_folders WHERE name = 'Trades'", [])
        .unwrap();
    a.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',1,
                 (SELECT id FROM collection_folders WHERE name = 'Trades'),
                 unixepoch(),unixepoch())",
        [],
    )
    .unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(
        (rb.applied, rb.moot, rb.dropped, rb.deferred),
        (1, 0, 0, 0),
        "{rb:?}"
    );
    apply(&a, &since(&b, &mut mb)).unwrap();

    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 1), "{who} lost the copy");
        let (folder, binders): (Option<i64>, i64) = c
            .query_row(
                "SELECT (SELECT folder_id FROM collection_entries),
                        (SELECT count(*) FROM collection_folders WHERE name = 'Trades')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (folder, binders),
            (None, 0),
            "{who} disagrees about where it is"
        );
    }
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// A deck with three piles on `a` — `Main`, `Side` and `Maybe` — and one card in `Main`, applied
/// to `b`. Every pile is `kind = 'main'`, so none meets `idx_deck_categories_kind`.
fn a_deck_with_three_piles(a: &Connection, b: &Connection, ma: &mut i64, mb: &mut i64) {
    a_deck_everywhere(a, ma, &[b]);
    // Filed while `Main` is the only pile, which is what `file_a_card`'s subquery assumes.
    file_a_card(a);
    for name in ["Side", "Maybe"] {
        a.execute(
            "INSERT INTO deck_categories
                (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
             VALUES (1, ?1, 'main', 1, 1, unixepoch(), unixepoch())",
            [name],
        )
        .unwrap();
    }
    apply(b, &since(a, ma)).unwrap();
    let _ = since(b, mb);
    for c in [a, b] {
        assert_eq!(
            pile_of_the_card(c).as_deref(),
            Some("Main"),
            "the fixture: the card starts in Main"
        );
    }
}

/// Move the one card on `conn` into the pile called `pile`.
fn move_the_card(conn: &Connection, pile: &str) {
    conn.execute(
        "UPDATE deck_cards SET category_id = (SELECT id FROM deck_categories WHERE name = ?1)",
        [pile],
    )
    .unwrap();
}

/// The pile the one card on `conn` is in, or `None` when there is no card.
fn pile_of_the_card(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT c.name FROM deck_cards dc JOIN deck_categories c ON c.id = dc.category_id",
        [],
        |r| r.get(0),
    )
    .optional()
    .unwrap()
}

/// **A card this device holds, moved by a peer into a pile deleted here, goes on both** (the
/// final review). `a` moves the card into `Side` while `b` deletes `Side`. On `a` the delete's
/// cascade takes the card with the pile; moot used to consume the move on `b` and leave the card
/// in `Main` — one device holding a card the other never will again. So a moot group whose row
/// this device holds deletes that row, which is the outcome the delete reaches on `a`.
///
/// **What makes it red**: consuming the move and touching nothing — `b` ends with the card.
#[test]
fn a_card_moved_into_a_pile_this_device_deleted_goes_on_both() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a_deck_with_three_piles(&a, &b, &mut ma, &mut mb);

    b.execute("DELETE FROM deck_categories WHERE name = 'Side'", [])
        .unwrap();
    move_the_card(&a, "Side");

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(
        (rb.moot, rb.applied, rb.deferred, rb.dropped),
        (1, 0, 0, 0),
        "{rb:?}"
    );
    apply(&a, &since(&b, &mut mb)).unwrap();

    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(
            pile_of_the_card(c),
            None,
            "{who} still holds the card the delete took"
        );
    }
    assert!(skips(&b).is_empty(), "moot is not a fault: {:?}", skips(&b));
}

/// **...but only where the move into the deleted pile is the placement that stands.** `b` moved
/// the card into `Maybe` after `a` moved it into `Side`, then deleted `Side`. `b`'s own later move
/// wins the pile field, so the delete reaches `a` with the card on its way to `Maybe` — `a`
/// rebuilds it there from its own history — and deleting it on `b` would lose a card both devices
/// place in `Maybe`.
///
/// **What makes it red**: deleting the row for every moot group whose row is here, without asking
/// the fold whose placement stands.
#[test]
fn a_stale_move_into_a_deleted_pile_leaves_a_card_this_device_moved_since() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a_deck_with_three_piles(&a, &b, &mut ma, &mut mb);

    move_the_card(&a, "Side");
    // `b`'s move is the later one, which the clock is set to make certain rather than left to
    // whichever device's millisecond came first.
    b.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
    move_the_card(&b, "Maybe");
    b.execute("DELETE FROM deck_categories WHERE name = 'Side'", [])
        .unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!((rb.moot, rb.deferred, rb.dropped), (1, 0, 0), "{rb:?}");
    apply(&a, &since(&b, &mut mb)).unwrap();

    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(
            pile_of_the_card(c).as_deref(),
            Some("Maybe"),
            "{who} disagrees about the card"
        );
    }
}

/// **A moot row's delete that this database refuses leaves the row, and the rest of the page
/// applies.** Nothing on the tables the delete reaches refuses one today, so a TEMP trigger stands
/// in for the first thing that will: `a` moves the card into `Side`, which `b` deleted, then adds
/// a copy. The move is moot on `b` and the card is `b`'s to delete, and the trigger refuses it.
/// Left to escape, that refusal would fail the whole apply, and the same page would fail it on
/// every pull after.
///
/// **What makes it red**: letting the moot delete's error escape the apply.
#[test]
fn a_moot_delete_this_database_refuses_leaves_the_row_and_applies_the_rest() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a_deck_with_three_piles(&a, &b, &mut ma, &mut mb);

    b.execute("DELETE FROM deck_categories WHERE name = 'Side'", [])
        .unwrap();
    move_the_card(&a, "Side");
    add_copy(&a);
    b.execute_batch(
        "CREATE TEMP TRIGGER refuse_a_card_delete BEFORE DELETE ON deck_cards
         BEGIN SELECT RAISE(ABORT, 'refused'); END;",
    )
    .unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).expect("a refused moot delete failed the apply");
    assert_eq!(
        (rb.moot, rb.applied, rb.deferred, rb.dropped),
        (1, 1, 0, 0),
        "{rb:?}"
    );
    assert_eq!(
        pile_of_the_card(&b).as_deref(),
        Some("Main"),
        "the refused delete took the card anyway"
    );
    assert_eq!(qty(&b), (1, 1), "a's later copy did not apply");
}

/// **A folder moved under one this device deleted goes on both devices, and what either filed into
/// it lands at the root on both** (the scoped re-review of the moot delete, and spec 2026-09-27
/// §3.2). `b` deletes `Shelf` and, not having heard of the move, files deck `E` into `Box`; `a`, not
/// having heard of the delete, moves `Box` under `Shelf` and makes deck `D` in it with a card. On
/// `a` the delete cascades `Box` and `SET NULL` puts `D` at the root, and the tombstone that
/// cascade leaves is what lands `E` at the root when `b`'s filing arrives. On `b` the move is moot
/// and `Box` goes as it went on `a` — `E` to the root with it — and the tombstone the moot delete
/// leaves lands `D` at the root in the same pass.
///
/// Until the tombstones, `Box` was left standing on `b`: deleted there as moot, uncaptured and no
/// delete in the page, it would have left `gone` nothing to find, and the release would have
/// dropped `D` and every card in it. So `b` kept both decks filed in a folder `a` no longer had,
/// and `E` waited on `a` for a folder its own cascade had taken.
///
/// **What makes it red**: the moot delete stopping at a folder table — `b` keeps `Box` with both
/// decks in it — or `gone` reading this device's own `sync_ops`, which holds `E` on `a`.
#[test]
fn a_deck_filed_into_a_folder_moved_under_one_this_device_deleted_survives_on_both() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    for name in ["Shelf", "Box"] {
        a.execute(
            "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
             VALUES (?1, 0, unixepoch(), unixepoch())",
            [name],
        )
        .unwrap();
    }
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    b.execute("DELETE FROM deck_folders WHERE name = 'Shelf'", [])
        .unwrap();
    a.execute(
        "UPDATE deck_folders SET parent_id = (SELECT id FROM deck_folders WHERE name = 'Shelf')
          WHERE name = 'Box'",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('D', 'commander', (SELECT id FROM deck_folders WHERE name = 'Box'),
                 unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_categories
            (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
         VALUES ((SELECT id FROM decks), 'Main', 'main', 1, 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    file_a_card(&a);
    b.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('E', 'commander', (SELECT id FROM deck_folders WHERE name = 'Box'),
                 unixepoch(), unixepoch())",
        [],
    )
    .unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(
        (rb.moot, rb.deferred, rb.dropped),
        (1, 0, 0),
        "the deck was held or dropped behind a folder deleted as moot: {rb:?}"
    );
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!((ra.deferred, ra.dropped), (0, 0), "{ra:?}");
    for (who, c) in [("a", &a), ("b", &b)] {
        let decks: i64 = c
            .query_row("SELECT count(*) FROM decks WHERE name = 'D'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            (decks, deck_cards(c)),
            (1, 1),
            "{who} lost the deck filed into the moved folder"
        );
    }
    for (who, c) in [("a", &a), ("b", &b)] {
        let (folders, filed): (i64, i64) = c
            .query_row(
                "SELECT (SELECT count(*) FROM deck_folders),
                        (SELECT count(*) FROM decks WHERE folder_id IS NOT NULL)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (folders, filed),
            (0, 0),
            "{who} kept a folder or a filed deck"
        );
        let decks: i64 = c
            .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(decks, 2, "{who} lost a deck");
    }
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// **...and a binder moved under one this device deleted goes on both, every copy filed into it
/// landing at the root.** The same shape in the collection's cabinet: `b` deletes `Outer` and, not
/// having heard of the move, files a copy into `Inner`; `a` moves `Inner` under `Outer` and files
/// a copy of its own there. On `a` the delete waits for the retry, re-homes all three copies at the
/// root and cascades `Inner`; on `b` the move is moot, so `Inner`'s delete waits the same way —
/// `a`'s copy lands in it first — and the retry re-homes the three and deletes it.
///
/// **What makes it red**: the moot delete stopping at `collection_folders` — `b` keeps `Inner`
/// with every copy filed in it.
#[test]
fn a_copy_filed_into_a_binder_moved_under_one_this_device_deleted_survives_on_both() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    for name in ["Outer", "Inner"] {
        a.execute(
            "INSERT INTO collection_folders (name, kind, sort_order, created_at, updated_at)
             VALUES (?1, 'user', 1, unixepoch(), unixepoch())",
            [name],
        )
        .unwrap();
    }
    let file_into_inner = |c: &Connection, card: &str| {
        c.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
                 created_at,updated_at)
             VALUES (?1,'lea','1','en','nonfoil','NM',1,
                     (SELECT id FROM collection_folders WHERE name = 'Inner'),
                     unixepoch(),unixepoch())",
            [card],
        )
        .unwrap();
    };
    file_into_inner(&a, "c1");
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    b.execute("DELETE FROM collection_folders WHERE name = 'Outer'", [])
        .unwrap();
    a.execute(
        "UPDATE collection_folders
            SET parent_id = (SELECT id FROM collection_folders WHERE name = 'Outer')
          WHERE name = 'Inner'",
        [],
    )
    .unwrap();
    file_into_inner(&a, "c2");
    file_into_inner(&b, "c3");

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(
        (rb.moot, rb.applied, rb.deferred, rb.dropped),
        (1, 1, 0, 0),
        "{rb:?}"
    );
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!((ra.deferred, ra.dropped), (0, 0), "{ra:?}");
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (3, 3), "{who} lost a copy");
        assert_eq!(
            (folders(c), copies_at_root(c)),
            (0, 3),
            "{who} kept a binder or a filed copy"
        );
    }
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// The copies on `conn` filed at the root.
fn copies_at_root(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM collection_entries WHERE folder_id IS NULL",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// **A third device's delete, applied on an earlier pull, is seen by a later child.** `c` deletes
/// a binder and `b` applies that on one pull; `a`'s copy filed into the binder reaches `b` on the
/// next. It lands at the root at once — no hold, no `error_log` row — where it used to wait out the
/// bound and be dropped while `a` kept it at the root once `c`'s delete reached it (spec 2026-09-27
/// §1.2): the delete was applied behind the apply guard and left nothing in `b`'s own `sync_ops`.
///
/// **What makes it red**: `gone` reading this device's own `sync_ops` only.
#[test]
fn a_copy_filed_into_a_binder_a_third_device_deleted_lands_at_the_root() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let mut mc = 0;
    let bin = binder(&c, "Binder", None);
    let page = since(&c, &mut mc);
    apply(&a, &page).unwrap();
    apply(&b, &page).unwrap();

    crate::collection_folders::delete_folder(&c, bin).unwrap();
    apply(&b, &since(&c, &mut mc)).unwrap();

    let mut ma = 0;
    let _ = since(&a, &mut ma);
    let a_bin: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'Binder'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    file_copies(&a, Some(a_bin), 1);
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!((rb.held_waiting, rb.dropped), (0, 0), "{rb:?}");
    assert_eq!(qty(&b), (1, 1));
    assert_eq!(copies_at_root(&b), 1);
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// **`gone` answers from the tombstones alone**: a parent with a `sync_gone` row and no `del` in
/// this device's own history — nor any row, nor any delete in the page — is gone.
#[test]
fn gone_answers_from_the_tombstone_table() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    let bin = binder(&a, "Binder", None);
    let uid: String = a
        .query_row(
            "SELECT sync_uid FROM collection_folders WHERE id = ?1",
            [bin],
            |r| r.get(0),
        )
        .unwrap();
    file_copies(&a, Some(bin), 1);
    // `b` never heard of the binder; only a tombstone says it went.
    b.execute(
        "INSERT INTO sync_gone (tbl, uid) VALUES ('collection_folders', ?1)",
        [&uid],
    )
    .unwrap();
    let page: Vec<Op> = since(&a, &mut ma)
        .into_iter()
        .filter(|op| op.table != "collection_folders")
        .collect();
    let rb = apply(&b, &page).unwrap();

    assert_eq!((rb.held_waiting, rb.dropped), (0, 0), "{rb:?}");
    assert_eq!(qty(&b), (1, 1));
    assert_eq!(copies_at_root(&b), 1);
}

/// **A parent a third device made and deleted between two pulls is tombstoned here, though this
/// device never held it** (spec 2026-09-27 §3.1, as amended). `c` makes a binder and deletes it
/// before `b` pulls, so `b` applies the put and the delete in one page: the group folds to deleted,
/// there is no row to `DELETE`, and no trigger fires. `a`, which saw the binder, files a copy into
/// it, and that reaches `b` on a later pull. It lands at the root at once, as it does on `a` once
/// `c`'s delete gets there.
///
/// **What makes it red**: the delete arm recording nothing for a row it did not find — the copy
/// waits out the bound on `b`, and the release drops it.
#[test]
fn a_child_of_a_parent_a_third_device_made_and_deleted_between_two_pulls_lands_at_once() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let mut mc = 0;
    let bin = binder(&c, "Binder", None);
    let made = since(&c, &mut mc);
    apply(&a, &made).unwrap();
    crate::collection_folders::delete_folder(&c, bin).unwrap();
    let mut page = made;
    page.extend(since(&c, &mut mc));
    let first = apply(&b, &page).unwrap();
    assert_eq!(unwritten(first), (0, 0), "{first:?}");
    assert_eq!(folders(&b), 0, "the premise: b never holds the binder");

    let mut ma = 0;
    let a_bin: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'Binder'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    file_copies(&a, Some(a_bin), 1);
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!((rb.held_waiting, rb.dropped), (0, 0), "{rb:?}");
    assert_eq!(qty(&b), (1, 1));
    assert_eq!(copies_at_root(&b), 1);
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));

    // And `a` agrees once `c`'s delete reaches it.
    let ra = apply(&a, &page).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    assert_eq!((qty(&a), copies_at_root(&a), folders(&a)), ((1, 1), 1, 0));
}

/// **A folder a peer made under one this device deleted is tombstoned here too, though this device
/// never held it.** `b` deletes `Outer`; `a`, not having heard, makes `Inner` under it and files a
/// copy into `Inner`. On `b` the page's `Inner` is moot — its parent is gone and the key cascades —
/// and there is no row to delete, so no trigger fires: the copy behind it named a folder nothing
/// said was gone, waited out the bound and was dropped, while on `a` the delete cascades `Inner`
/// and `SET NULL` puts the copy at the root.
///
/// **What makes it red**: the moot arm recording nothing for a row it did not find.
#[test]
fn a_copy_filed_into_a_binder_made_under_one_this_device_deleted_lands_at_the_root_on_both() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let outer = binder(&a, "Outer", None);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    b.execute("DELETE FROM collection_folders WHERE name = 'Outer'", [])
        .unwrap();
    let inner = binder(&a, "Inner", Some(outer));
    file_copies(&a, Some(inner), 1);

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!((rb.moot, rb.held_waiting, rb.dropped), (1, 0, 0), "{rb:?}");
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 1), "{who} lost the copy");
        assert_eq!(
            (folders(c), copies_at_root(c)),
            (0, 1),
            "{who} kept a binder or a filed copy"
        );
    }
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// **...and that tombstone waits for the retry, so a parent the same page brings back keeps the
/// folder's children.** `b` makes `P` and deletes it; `a`, which saw `P` and has not heard of the
/// delete, makes `X` under it, files a copy into `X`, and then renames `P` — later than `b`'s
/// delete, so add-wins brings `P` back on `b` when the page arrives. The page sorts `X` ahead of
/// the rename. Tombstoned on the first attempt, `X` sent the copy to the root before `P` came
/// back, and the retry then made `X` under the resurrected `P`: `b` held the copy at the root and
/// `a` held it in `X`.
///
/// **What makes it red**: the moot arm tombstoning a row it did not find on the first attempt —
/// or any decision resting on `gone` taken there.
#[test]
fn a_folder_made_under_a_parent_the_same_page_brings_back_keeps_its_copy() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let p_on_b = binder(&b, "P", None);
    apply(&a, &since(&b, &mut mb)).unwrap();

    crate::collection_folders::delete_folder(&b, p_on_b).unwrap();
    // Every write of `a`'s is later than `b`'s delete, which is what add-wins asks of the rename.
    a.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
    let p_on_a: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'P'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let x = binder(&a, "X", Some(p_on_a));
    file_copies(&a, Some(x), 1);
    a.execute(
        "UPDATE collection_folders SET name = 'P2' WHERE id = ?1",
        [p_on_a],
    )
    .unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(unwritten(rb), (0, 0), "{rb:?}");
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");

    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 1), "{who} lost the copy");
        let placed: (Option<String>, Option<String>) = c
            .query_row(
                "SELECT f.name, p.name FROM collection_entries e
                   LEFT JOIN collection_folders f ON f.id = e.folder_id
                   LEFT JOIN collection_folders p ON p.id = f.parent_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            placed,
            (Some("X".to_owned()), Some("P2".to_owned())),
            "{who} does not hold the copy in X under the resurrected P"
        );
    }
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// **A folder this device holds, moved under a parent deleted here, follows that parent back when
/// the same page resurrects it.** `b` makes `P`, `a` makes `X`, and both devices hold both; `b`
/// deletes `P`; `a`, not having heard, moves `X` under `P` and then renames `P` — later than `b`'s
/// delete, so add-wins brings `P` back on `b`. The page sorts `X`'s move ahead of the rename.
/// Decided on the first attempt, the move was moot and deleted `X` before the rename brought `P`
/// back; on the retry `X` found `P` but no row of its own, and a sparse move cannot rebuild one, so
/// it was dropped (`NOT NULL constraint failed: collection_folders.name`) while `a` kept `X` under
/// `P`. Decided on the retry, the move meets the resurrected `P` and lands.
///
/// **What makes it red**: a decision resting on `gone` taken on the first attempt.
#[test]
fn a_folder_moved_under_a_parent_the_same_page_brings_back_follows_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let p_on_b = binder(&b, "P", None);
    apply(&a, &since(&b, &mut mb)).unwrap();
    let x = binder(&a, "X", None);
    apply(&b, &since(&a, &mut ma)).unwrap();

    crate::collection_folders::delete_folder(&b, p_on_b).unwrap();
    // Every write of `a`'s is later than `b`'s delete, which is what add-wins asks of the rename.
    a.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
    let p_on_a: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'P'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    crate::collection_folders::move_folder(&a, x, Some(p_on_a)).unwrap();
    a.execute(
        "UPDATE collection_folders SET name = 'P2' WHERE id = ?1",
        [p_on_a],
    )
    .unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(unwritten(rb), (0, 0), "{rb:?}: {:?}", skips(&b));
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    for (who, c) in [("a", &a), ("b", &b)] {
        let under: Option<String> = c
            .query_row(
                "SELECT p.name FROM collection_folders f
                   JOIN collection_folders p ON p.id = f.parent_id
                  WHERE f.name = 'X'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(
            under.as_deref(),
            Some("P2"),
            "{who} does not hold X under P"
        );
    }
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// **...and a copy filed into a binder deleted here stays in it when the same page brings the
/// binder back** — the `SET NULL` arm's form of the test above. `b` makes `B` and deletes it; `a`,
/// not having heard, files a copy into `B`, renames it — later than `b`'s delete, so add-wins
/// brings it back — and moves it into `Outer`, a folder it makes after the rename. The move names
/// a parent `b` has not got yet, so `B`'s own group fails its first attempt and is written on the
/// retry; decided on the first attempt, the copy had already been written at the root as the
/// `SET NULL` would leave it, while on `a` it is in `B`. (The move is what makes this reachable:
/// with no failing parent, `B`'s group sorts ahead of the copy by table rank and lands first on
/// any code.) Decided on the retry, the copy meets the resurrected `B`.
///
/// **What makes it red**: a decision resting on `gone` taken on the first attempt.
#[test]
fn a_copy_filed_into_a_binder_the_same_page_brings_back_stays_in_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let bin_on_b = binder(&b, "B", None);
    apply(&a, &since(&b, &mut mb)).unwrap();

    crate::collection_folders::delete_folder(&b, bin_on_b).unwrap();
    a.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
    let bin_on_a: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'B'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    file_copies(&a, Some(bin_on_a), 1);
    a.execute(
        "UPDATE collection_folders SET name = 'B2' WHERE id = ?1",
        [bin_on_a],
    )
    .unwrap();
    let outer = binder(&a, "Outer", None);
    crate::collection_folders::move_folder(&a, bin_on_a, Some(outer)).unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(unwritten(rb), (0, 0), "{rb:?}: {:?}", skips(&b));
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 1), "{who} lost the copy");
        let placed: (Option<String>, Option<String>) = c
            .query_row(
                "SELECT f.name, p.name FROM collection_entries e
                   LEFT JOIN collection_folders f ON f.id = e.folder_id
                   LEFT JOIN collection_folders p ON p.id = f.parent_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            placed,
            (Some("B2".to_owned()), Some("Outer".to_owned())),
            "{who} does not hold the copy in the resurrected binder"
        );
    }
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// **A folder moved into a new one made under a parent deleted here goes, though the page meets
/// it before the new one.** `b` holds `X` and deletes `P`; `a`, not having heard, renames `X`,
/// makes `Z` under `P` and moves `X` into `Z`. `X`'s group sorts ahead of `Z`'s (its earliest op,
/// the rename, is older than `Z`'s creation), so on the one retry there was, `X` asked after `Z`
/// before `Z` had been decided: unknown, and not yet gone, so `X` was held — and `Z` behind it —
/// until the release dropped `X`'s ops and `b` kept `X`, where `a`'s cascade had taken it. The
/// retry is a fixed point now. Retry pass 1 withholds `Z`'s decision and lands nothing, so pass 2
/// is the first `Decide` pass: it meets `X` while `Z` is still unknown, then tombstones `Z` as
/// moot. Pass 3 finds `X` under a parent that is gone and withholds that decision too, and pass
/// 4, the second `Decide` pass, deletes `X` as `a`'s cascade did.
///
/// **What makes it red**: a single retry pass.
#[test]
fn a_folder_moved_into_one_made_under_a_parent_deleted_here_goes_on_both() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let p_on_b = binder(&b, "P", None);
    apply(&a, &since(&b, &mut mb)).unwrap();
    let x = binder(&a, "X", None);
    apply(&b, &since(&a, &mut ma)).unwrap();

    crate::collection_folders::delete_folder(&b, p_on_b).unwrap();
    let p_on_a: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'P'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    // The rename gives `X`'s group an op older than `Z`'s creation, which sorts it first.
    a.execute(
        "UPDATE collection_folders SET name = 'X2' WHERE id = ?1",
        [x],
    )
    .unwrap();
    let z = binder(&a, "Z", Some(p_on_a));
    crate::collection_folders::move_folder(&a, x, Some(z)).unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(
        (rb.held_waiting, rb.dropped),
        (0, 0),
        "{rb:?}: {:?}",
        skips(&b)
    );
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    for (who, c) in [("a", &a), ("b", &b)] {
        let left: i64 = c
            .query_row(
                "SELECT count(*) FROM collection_folders WHERE kind = 'user'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "{who} kept a folder the delete takes");
    }
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// **A folder moved under a parent deleted here follows it when the page brings the parent back
/// only on a retry pass.** `b` makes `P`, `a` makes `X`, and both hold both; `b` deletes `P`; `a`,
/// not having heard, moves `X` under `P`, renames `P` — later than the delete, so add-wins brings
/// it back — makes `Outer` and moves `P` into it. The page meets `X`, then `P`, then `Outer`: `P`
/// waits on `Outer` on the first attempt and is resurrected on the first retry pass, after `X`
/// has been met on it. Decided there, `X` was deleted as moot, and a sparse move cannot rebuild it
/// once `P` was back — `b` lost `X` for good while `a` kept it under `P` under `Outer`. A decision
/// resting on `gone` now waits for a pass on which nothing else landed, and by then `P` has.
///
/// **What makes it red**: a gone-based decision taken on a retry pass on which other groups were
/// still landing.
#[test]
fn a_folder_moved_under_a_parent_resurrected_on_a_retry_pass_follows_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let p_on_b = binder(&b, "P", None);
    apply(&a, &since(&b, &mut mb)).unwrap();
    let x = binder(&a, "X", None);
    apply(&b, &since(&a, &mut ma)).unwrap();

    crate::collection_folders::delete_folder(&b, p_on_b).unwrap();
    // Every write of `a`'s is later than `b`'s delete, which is what add-wins asks of the rename.
    a.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
    let p_on_a: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'P'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    crate::collection_folders::move_folder(&a, x, Some(p_on_a)).unwrap();
    a.execute(
        "UPDATE collection_folders SET name = 'P2' WHERE id = ?1",
        [p_on_a],
    )
    .unwrap();
    let outer = binder(&a, "Outer", None);
    crate::collection_folders::move_folder(&a, p_on_a, Some(outer)).unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(unwritten(rb), (0, 0), "{rb:?}: {:?}", skips(&b));
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(
            chain_of(c, "X"),
            ["X", "P2", "Outer"],
            "{who} does not hold X under P under Outer"
        );
    }
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// **...and a copy filed into a binder deleted here stays in it when the binder comes back two
/// retry passes in.** `b` makes `B` and deletes it; `a`, not having heard, files a copy into `B`,
/// renames `B` — which add-wins lets bring it back — makes `Outer` and moves `B` into it, then
/// makes `Outer2` and moves `Outer` into that. The page meets `B`, `Outer`, `Outer2`, then the
/// copy: `Outer` lands on the first retry pass and `B` only on the second. Decided on the first,
/// the copy was written at the root as the `SET NULL` would leave it, while on `a` it is in `B`.
///
/// **What makes it red**: a gone-based decision taken on a retry pass on which other groups were
/// still landing.
#[test]
fn a_copy_filed_into_a_binder_resurrected_on_a_later_retry_pass_stays_in_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let bin_on_b = binder(&b, "B", None);
    apply(&a, &since(&b, &mut mb)).unwrap();

    crate::collection_folders::delete_folder(&b, bin_on_b).unwrap();
    a.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
    let bin_on_a: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'B'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    file_copies(&a, Some(bin_on_a), 1);
    a.execute(
        "UPDATE collection_folders SET name = 'B2' WHERE id = ?1",
        [bin_on_a],
    )
    .unwrap();
    let outer = binder(&a, "Outer", None);
    crate::collection_folders::move_folder(&a, bin_on_a, Some(outer)).unwrap();
    let outer2 = binder(&a, "Outer2", None);
    crate::collection_folders::move_folder(&a, outer, Some(outer2)).unwrap();

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(unwritten(rb), (0, 0), "{rb:?}: {:?}", skips(&b));
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 1), "{who} lost the copy");
        let folder: Option<String> = c
            .query_row(
                "SELECT f.name FROM collection_entries e
                   LEFT JOIN collection_folders f ON f.id = e.folder_id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            folder.as_deref(),
            Some("B2"),
            "{who} holds the copy elsewhere"
        );
        assert_eq!(chain_of(c, "B2"), ["B2", "Outer", "Outer2"], "{who}");
    }
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// The names from the collection folder called `name` up to the root, or empty when there is none.
fn chain_of(conn: &Connection, name: &str) -> Vec<String> {
    conn.query_row(
        "WITH RECURSIVE up(id, name, parent_id, depth) AS (
             SELECT id, name, parent_id, 0 FROM collection_folders WHERE name = ?1
             UNION ALL
             SELECT f.id, f.name, f.parent_id, up.depth + 1
               FROM collection_folders f JOIN up ON f.id = up.parent_id
         )
         SELECT group_concat(name, '/' ORDER BY depth) FROM up",
        [name],
        |r| r.get::<_, Option<String>>(0),
    )
    .unwrap()
    .map(|s| s.split('/').map(str::to_owned).collect())
    .unwrap_or_default()
}

/// **The retry passes stop when nothing moves: a child whose parent is genuinely missing costs
/// one more pass, not a loop to the cap.** `a` files a copy into a binder `b` never receives —
/// its put is left out of the page, so the parent is missing and not gone — and, ahead of it, a
/// copy into a binder `b` deleted. The first retry pass withholds that copy's decision and lands
/// nothing; the `Decide` pass after it writes the copy at the root, which is progress; so one more
/// pass runs, finds the waiting copy unchanged with nothing withheld, and stops — three passes.
/// (Two, until gone-based decisions waited for a pass on which nothing landed; still three since
/// clearing deletes wait for a `Clear` pass, as nothing here clears a folder.) Six more copies put
/// the page's group count at eight and so the cap at twenty-five. The waiting copy ends held
/// exactly as it did when there was one retry.
///
/// **What makes it red**: a loop that goes on while anything waits, rather than while something
/// moved — it runs to the cap.
#[test]
fn the_retry_passes_stop_when_nothing_can_progress() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let gone_on_b = binder(&b, "Gone", None);
    apply(&a, &since(&b, &mut mb)).unwrap();
    crate::collection_folders::delete_folder(&b, gone_on_b).unwrap();

    let never_sent = binder(&a, "Never sent", None);
    let never_uid: String = a
        .query_row(
            "SELECT sync_uid FROM collection_folders WHERE id = ?1",
            [never_sent],
            |r| r.get(0),
        )
        .unwrap();
    let gone_on_a: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'Gone'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let copy_of = |card: &str, folder: Option<i64>| {
        a.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
                 created_at,updated_at)
             VALUES (?1,'lea','1','en','nonfoil','NM',1,?2,unixepoch(),unixepoch())",
            rusqlite::params![card, folder],
        )
        .unwrap();
    };
    for card in ["d1", "d2", "d3", "d4", "d5", "d6"] {
        copy_of(card, None);
    }
    copy_of("g1", Some(gone_on_a));
    copy_of("n1", Some(never_sent));
    let page: Vec<Op> = since(&a, &mut ma)
        .into_iter()
        .filter(|op| op.uid != never_uid)
        .collect();
    assert_eq!(
        page.len(),
        8,
        "the premise: eight groups, so a cap of twenty-five passes: {page:?}"
    );

    super::RETRY_PASSES.with(|c| c.set(0));
    let rb = apply(&b, &page).unwrap();
    let passes = super::RETRY_PASSES.with(|c| c.get());

    assert_eq!(
        passes, 3,
        "the retry passes did not stop when nothing moved"
    );
    assert_eq!((rb.held_waiting, rb.dropped), (1, 0), "{rb:?}");
    assert_eq!(qty(&b), (7, 7), "the six copies and the one the pass wrote");
    assert_eq!(copies_at_root(&b), 7);
}

/// **A moot folder delete waits for the retry when rows are still filed in it, so the page's own
/// re-filing of them lands first** — the delete arm's reason, met one level up: every decision
/// resting on `gone` is made on the retry (`Why::DecidedOnRetry`). Both
/// devices hold a root copy `u0` and a copy `u1` in `Inner`, one printing; `b` deletes `Outer`;
/// `a`, not having heard, moves `Inner` under `Outer` and then drags `u1` to the root, which folds
/// it into `u0` — the page carries `u0`'s `+1` and `u1`'s delete. Deleted on the first attempt,
/// `Inner` re-homed `u1` onto `u0` itself, ahead of both: where `u0`'s uid sorts lower the `+1`
/// then counted the fold a second time (3 against `a`'s 2), and where `u1`'s does the survivor
/// took `u1`'s uid, `u0`'s `+1` found no row, and `u1`'s delete took the survivor (0 copies).
/// Waiting, the `+1` and the delete land first and the retry finds `Inner` empty.
///
/// The two uids are forced so both orders are driven rather than left to a coin toss.
///
/// **What makes it red**: the moot arm deleting a folder on the first attempt with rows in it —
/// its own wait until fix round 2, the parent loop's deferral since.
fn a_copy_dragged_out_of_a_binder_moved_under_a_deleted_one_lands_once(root_lower: bool) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let outer = binder(&a, "Outer", None);
    let inner = binder(&a, "Inner", None);
    file_copies(&a, None, 1);
    file_copies(&a, Some(inner), 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);
    let (u0, u1) = if root_lower {
        (
            "0000000000000000000000000000000a",
            "0000000000000000000000000000000b",
        )
    } else {
        (
            "0000000000000000000000000000000b",
            "0000000000000000000000000000000a",
        )
    };
    for c in [&a, &b] {
        capture::suppressed(c, || {
            c.execute(
                "UPDATE collection_entries SET sync_uid = ?1 WHERE folder_id IS NULL",
                [u0],
            )
            .unwrap();
            c.execute(
                "UPDATE collection_entries SET sync_uid = ?1 WHERE folder_id IS NOT NULL",
                [u1],
            )
            .unwrap();
        });
    }

    let b_outer: i64 = b
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'Outer'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    crate::collection_folders::delete_folder(&b, b_outer).unwrap();
    crate::collection_folders::move_folder(&a, inner, Some(outer)).unwrap();
    let filed: i64 = a
        .query_row(
            "SELECT id FROM collection_entries WHERE sync_uid = ?1",
            [u1],
            |r| r.get(0),
        )
        .unwrap();
    crate::collection_folders::set_entry_folder(&a, filed, None).unwrap();
    let page = since(&a, &mut ma);
    assert!(
        page.iter()
            .any(|op| op.uid == u0 && op.counters.get("quantity") == Some(&1))
            && page.iter().any(|op| op.uid == u1 && op.kind == Kind::Del),
        "the premise: the drag folds u1 into u0: {page:?}"
    );

    let rb = apply(&b, &page).unwrap();
    assert_eq!(
        unwritten(rb),
        (0, 0),
        "{rb:?}, b holds (rows, copies) {:?}",
        qty(&b)
    );
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 2), "{who} does not hold one row of two");
        assert_eq!(uids_of_copies(c), vec![Some(u0.to_owned())], "{who}");
        assert_eq!(
            (folders(c), copies_at_root(c)),
            (0, 1),
            "{who} kept a binder or a filed copy"
        );
    }
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

#[test]
fn a_copy_dragged_onto_a_lower_root_twin_out_of_a_binder_moved_under_a_deleted_one_lands_once() {
    a_copy_dragged_out_of_a_binder_moved_under_a_deleted_one_lands_once(true);
}

#[test]
fn a_copy_dragged_onto_a_higher_root_twin_out_of_a_binder_moved_under_a_deleted_one_lands_once() {
    a_copy_dragged_out_of_a_binder_moved_under_a_deleted_one_lands_once(false);
}

/// **A clearing delete waits for every pass on which something still lands, not only the first**
/// — so a copy the sender dragged out of the binder it then deleted reaches the folder it went
/// to, even when that folder only lands on a retry pass. Both devices hold binder `B` with a copy
/// `c` in it and a root twin `t`, one printing. `a` makes `N`, then `Outer`, moves `N` into
/// `Outer`, drags `c` from `B` into `N` and deletes `B`, which by then holds nothing. On `b` the
/// page sorts `N`, `Outer`, `B`, `c`: `N` and `c`'s move fail the first attempt, each on a parent
/// that lands later, and `B` waits. On the first retry pass `N` lands, and `B` was decided there
/// before `c`'s move: its re-homing folded `c` onto `t` at the root. Where `c`'s uid sorts lower
/// the survivor wore it and `c`'s move carried the merged row into `N` (`b`: `N` holding both,
/// the root empty; `a`: `N` holding `c`, `t` at the root); where `t`'s does, the move found no row
/// and was dropped with an `error_log` row. Waiting through every `Retry` pass, `c`'s move lands
/// first and `B` is deleted empty.
///
/// The two uids are forced so both orders are driven rather than left to a coin toss.
///
/// **What makes it red**: the delete arm deciding on any retry pass — its wait on the first
/// attempt alone.
fn a_copy_dragged_into_a_folder_the_page_makes_late_out_of_a_deleted_binder_lands_there(
    root_lower: bool,
) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let b_on_a = binder(&a, "B", None);
    file_copies(&a, Some(b_on_a), 1);
    file_copies(&a, None, 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);
    let (ut, uc) = if root_lower {
        (
            "0000000000000000000000000000000a",
            "0000000000000000000000000000000b",
        )
    } else {
        (
            "0000000000000000000000000000000b",
            "0000000000000000000000000000000a",
        )
    };
    for d in [&a, &b] {
        capture::suppressed(d, || {
            d.execute(
                "UPDATE collection_entries SET sync_uid = ?1 WHERE folder_id IS NULL",
                [ut],
            )
            .unwrap();
            d.execute(
                "UPDATE collection_entries SET sync_uid = ?1 WHERE folder_id IS NOT NULL",
                [uc],
            )
            .unwrap();
        });
    }
    let b_uid: String = a
        .query_row(
            "SELECT sync_uid FROM collection_folders WHERE id = ?1",
            [b_on_a],
            |r| r.get(0),
        )
        .unwrap();

    let n = binder(&a, "N", None);
    let outer = binder(&a, "Outer", None);
    crate::collection_folders::move_folder(&a, n, Some(outer)).unwrap();
    let c_on_a: i64 = a
        .query_row(
            "SELECT id FROM collection_entries WHERE sync_uid = ?1",
            [uc],
            |r| r.get(0),
        )
        .unwrap();
    crate::collection_folders::set_entry_folder(&a, c_on_a, Some(n)).unwrap();
    crate::collection_folders::delete_folder(&a, b_on_a).unwrap();
    let page = since(&a, &mut ma);
    assert!(
        page.iter()
            .any(|op| op.uid == b_uid && op.kind == Kind::Del)
            && page
                .iter()
                .any(|op| op.uid == uc && op.parents.contains_key("folder"))
            && !page.iter().any(|op| op.uid == ut),
        "the premise: B deleted empty, c moved, t untouched: {page:?}"
    );

    let rb = apply(&b, &page).unwrap();
    assert_eq!(
        unwritten(rb),
        (0, 0),
        "{rb:?}, b holds (rows, copies) {:?}",
        qty(&b)
    );
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    for (who, d) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(d), (2, 2), "{who} does not hold two rows of one copy");
        let filed_in: Option<String> = d
            .query_row(
                "SELECT f.name FROM collection_entries e
                   LEFT JOIN collection_folders f ON f.id = e.folder_id
                  WHERE e.sync_uid = ?1",
                [uc],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(filed_in.as_deref(), Some("N"), "{who}: c is not in N");
        assert_eq!(chain_of(d, "N"), ["N", "Outer"], "{who}");
        let t_at_root: bool = d
            .query_row(
                "SELECT folder_id IS NULL FROM collection_entries WHERE sync_uid = ?1",
                [ut],
                |r| r.get(0),
            )
            .unwrap();
        assert!(t_at_root, "{who}: t left the root");
        assert_eq!(folders(d), 2, "{who} kept B or lost N or Outer");
    }
    assert_eq!(uids_of_copies(&a), uids_of_copies(&b));
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

#[test]
fn a_copy_dragged_into_a_late_folder_out_of_a_deleted_binder_over_a_lower_root_twin_lands_there() {
    a_copy_dragged_into_a_folder_the_page_makes_late_out_of_a_deleted_binder_lands_there(true);
}

#[test]
fn a_copy_dragged_into_a_late_folder_out_of_a_deleted_binder_over_a_higher_root_twin_lands_there() {
    a_copy_dragged_into_a_folder_the_page_makes_late_out_of_a_deleted_binder_lands_there(false);
}

/// **A clearing delete waits for a pass on which nothing else landed — the deciding pass's own
/// decisions included — so a copy the sender moved into a deck's group reaches it, though the
/// group lands only on that pass.** Both devices hold a deck folder `F`, a binder holding a copy
/// `c` and a root twin `t` of `c`'s printing; `b` deletes `F`. `a`, not having heard, makes deck
/// `Q` in `F` — its group `G` with it — adds the card to `Q`'s list, moves `c` into `G` with
/// `collection_to_deck`, and the binder goes:
///
/// - **the delete arm** (`moot` false): `a` then deletes the binder, which holds nothing now;
/// - **the moot arm** (`moot` true): `b` deleted a binder `P` too, and `a` moved the binder under
///   `P` before the move, so it goes with `P` on both devices.
///
/// On `b` nothing lands before the deciding pass: `Q` waits for its `SET NULL` decision, `G` on
/// `Q`, the binder's delete on `c`, and `c`'s move on `G`. The deciding pass writes `Q` without
/// `F` and `G` lands after it — and the binder's delete, met next with `c` still in it, re-homed
/// `c` onto `t` before `c`'s move came round. Where `c`'s uid sorted lower the move carried both
/// copies into `G` (`b`'s deck owned 2, `a`'s 1); where `t`'s did, the move found no row and was
/// dropped with an `error_log` row. Waiting for a pass on which nothing else lands, the move lands
/// on the deciding pass and the binder goes, empty, after it.
///
/// The two uids are forced so both orders are driven rather than left to a coin toss.
///
/// **What makes it red**: a clearing delete taken on the deciding pass — the delete arm's guard
/// read as "not before `Decide`", or the moot arm's re-homing there.
fn a_copy_moved_into_a_decks_group_the_page_makes_late_lands_there(root_lower: bool, moot: bool) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    for d in [&a, &b] {
        crate::schema::fixtures::seed_card(d, "c1", "lea", "1");
    }
    let f_on_a = crate::deck_meta::create_folder(&a, None, "F").unwrap().id;
    let p_on_a = moot.then(|| binder(&a, "P", None));
    let holder = binder(&a, "B", None);
    file_copies(&a, Some(holder), 1);
    file_copies(&a, None, 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);
    let (ut, uc) = if root_lower {
        (
            "0000000000000000000000000000000a",
            "0000000000000000000000000000000b",
        )
    } else {
        (
            "0000000000000000000000000000000b",
            "0000000000000000000000000000000a",
        )
    };
    for d in [&a, &b] {
        capture::suppressed(d, || {
            d.execute(
                "UPDATE collection_entries SET sync_uid = ?1 WHERE folder_id IS NULL",
                [ut],
            )
            .unwrap();
            d.execute(
                "UPDATE collection_entries SET sync_uid = ?1 WHERE folder_id IS NOT NULL",
                [uc],
            )
            .unwrap();
        });
    }
    let uid_on_a = |table: &str, id: i64| -> String {
        a.query_row(
            &format!("SELECT sync_uid FROM {table} WHERE id = ?1"),
            [id],
            |r| r.get(0),
        )
        .unwrap()
    };
    let holder_uid = uid_on_a("collection_folders", holder);
    let id_on_b = |table: &str, name: &str| -> i64 {
        b.query_row(
            &format!("SELECT id FROM {table} WHERE name = ?1"),
            [name],
            |r| r.get(0),
        )
        .unwrap()
    };
    crate::deck_meta::delete_folder(&b, id_on_b("deck_folders", "F")).unwrap();
    if moot {
        crate::collection_folders::delete_folder(&b, id_on_b("collection_folders", "P")).unwrap();
    }

    let q = crate::deck::create_deck(
        &a,
        &crate::deck::DeckInput {
            name: "Q".to_owned(),
            folder_id: Some(f_on_a),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    crate::deck::add_card(&a, q, "c1", None, Some("Burn"), "live", None, 1).unwrap();
    if let Some(p) = p_on_a {
        crate::collection_folders::move_folder(&a, holder, Some(p)).unwrap();
    }
    let c_on_a: i64 = a
        .query_row(
            "SELECT id FROM collection_entries WHERE sync_uid = ?1",
            [uc],
            |r| r.get(0),
        )
        .unwrap();
    crate::collection_alloc::collection_to_deck(
        &a,
        c_on_a,
        q,
        crate::collection_alloc::Pile::Name("Burn"),
        1,
    )
    .unwrap();
    if !moot {
        crate::collection_folders::delete_folder(&a, holder).unwrap();
    }
    let group_uid: String = a
        .query_row(
            "SELECT sync_uid FROM collection_folders WHERE kind = 'deck' AND deck_id = ?1",
            [q],
            |r| r.get(0),
        )
        .unwrap();
    let page = since(&a, &mut ma);
    let goes = if moot {
        page.iter()
            .any(|op| op.uid == holder_uid && op.parents.get("parent").is_some_and(|p| p.is_some()))
    } else {
        page.iter()
            .any(|op| op.uid == holder_uid && op.kind == Kind::Del)
    };
    assert!(
        goes && page
            .iter()
            .any(|op| op.uid == uc && op.parents.get("folder") == Some(&Some(group_uid.clone())))
            && !page.iter().any(|op| op.uid == ut),
        "the premise: the binder goes, c moves into Q's group, t is untouched: {page:?}"
    );

    let rb = apply(&b, &page).unwrap();
    assert_eq!(
        unwritten(rb),
        (0, 0),
        "{rb:?}, b holds (rows, copies) {:?}",
        qty(&b)
    );
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    for (who, d) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(d), (2, 2), "{who} does not hold two rows of one copy");
        let filed_in: (String, Option<String>) = d
            .query_row(
                "SELECT f.kind, k.name FROM collection_entries e
                   JOIN collection_folders f ON f.id = e.folder_id
                   LEFT JOIN decks k ON k.id = f.deck_id
                  WHERE e.sync_uid = ?1",
                [uc],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            filed_in,
            ("deck".to_owned(), Some("Q".to_owned())),
            "{who}: c is not in Q's group"
        );
        let owned_by_q: i64 = d
            .query_row(
                "SELECT coalesce(sum(e.quantity), 0) FROM collection_entries e
                   JOIN collection_folders f ON f.id = e.folder_id
                   JOIN decks k ON k.id = f.deck_id
                  WHERE k.name = 'Q'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owned_by_q, 1, "{who}: Q's group does not hold one copy");
        let t_at_root: bool = d
            .query_row(
                "SELECT folder_id IS NULL FROM collection_entries WHERE sync_uid = ?1",
                [ut],
                |r| r.get(0),
            )
            .unwrap();
        assert!(t_at_root, "{who}: t left the root");
        assert_eq!(folders(d), 0, "{who} kept a binder the delete takes");
        let q_filed: (i64, bool) = d
            .query_row(
                "SELECT (SELECT count(*) FROM deck_folders), folder_id IS NULL
                   FROM decks WHERE name = 'Q'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            q_filed,
            (0, true),
            "{who}: F stands, or Q is still filed in it"
        );
    }
    assert_eq!(uids_of_copies(&a), uids_of_copies(&b));
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

#[test]
fn a_copy_moved_into_a_late_decks_group_out_of_a_deleted_binder_over_a_lower_root_twin_lands_there()
{
    a_copy_moved_into_a_decks_group_the_page_makes_late_lands_there(true, false);
}

#[test]
fn a_copy_moved_into_a_late_decks_group_out_of_a_deleted_binder_over_a_higher_root_twin_lands_there(
) {
    a_copy_moved_into_a_decks_group_the_page_makes_late_lands_there(false, false);
}

#[test]
fn a_copy_moved_into_a_late_decks_group_out_of_a_moot_binder_over_a_lower_root_twin_lands_there() {
    a_copy_moved_into_a_decks_group_the_page_makes_late_lands_there(true, true);
}

#[test]
fn a_copy_moved_into_a_late_decks_group_out_of_a_moot_binder_over_a_higher_root_twin_lands_there() {
    a_copy_moved_into_a_decks_group_the_page_makes_late_lands_there(false, true);
}

/// **A newer device's child of a deleted parent is moot, never a permanent newer hold** (review
/// focus 2). Moot is asked first because it is a fact about *this* device that no upgrade
/// changes: held as newer, the child would wait for an update that cannot help it, and pin the
/// relay's log until then.
#[test]
fn a_newer_devices_child_of_a_deleted_parent_is_moot_not_held() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let page = a_card_in_a_deck_b_deleted(&a, &b, newer());

    let report = apply(&b, &page).unwrap();
    assert_eq!(report.moot, 1, "{report:?}");
    assert_eq!(
        (report.held_newer, report.deferred, report.dropped),
        (0, 0, 0),
        "{report:?}"
    );
    assert_eq!(qty(&b), (1, 1), "a's later op must apply");
    let last = page.last().unwrap();
    assert_eq!(mark_of(&b, "dev-a"), Some((last.at.ms, last.at.ctr)));
}

/// **A re-delivered page still makes a child of its own delete moot**, although the delete is
/// below its sender's watermark by then and no longer fresh.
///
/// First contact is the shape: `x` pushes a deck filed in a folder `b` has not received — the
/// baseline carrying it comes a page later — then files a card in `a`'s deck, which `a` deletes.
/// The first delivery applies the delete and holds `x` at the waiting deck, the card behind it.
/// The client's held cursor hands the same page back with the folder added; the delete is now
/// skipped as seen, and the card is attempted for the first time. Asking only the fresh ops
/// which rows were deleted would call its deck merely missing, and hold `x` again for a parent
/// that is never coming.
#[test]
fn a_redelivered_page_still_makes_a_child_of_its_delete_moot() {
    let (a, b, x) = (paired("dev-a"), paired("dev-b"), paired("dev-x"));
    let (mut ma, mut mx) = (0, 0);
    a_deck_everywhere(&a, &mut ma, &[&b, &x]);

    x.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Shelf', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let folder = since(&x, &mut mx);
    x.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('E', 'commander', (SELECT id FROM deck_folders), unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    x.execute(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             quantity, created_at, updated_at)
         SELECT d.id, c.id, 'live', 'c1', 'lea', '1', 'en', 'Bolt', 1, unixepoch(), unixepoch()
           FROM decks d JOIN deck_categories c ON c.deck_id = d.id
          WHERE d.name = 'A'",
        [],
    )
    .unwrap();
    a.execute("DELETE FROM decks", []).unwrap();

    let mut page = since(&a, &mut ma);
    page.extend(since(&x, &mut mx));
    let first = apply(&b, &page).unwrap();
    assert_eq!(
        (first.held_waiting, first.moot),
        (2, 0),
        "the deck waits and the card waits behind it: {first:?}"
    );

    page.extend(folder);
    let second = apply(&b, &page).unwrap();
    assert_eq!(second.moot, 1, "{second:?}");
    assert_eq!((second.deferred, second.dropped), (0, 0), "{second:?}");
    let decks: Vec<String> = {
        let mut stmt = b.prepare("SELECT name FROM decks ORDER BY name").unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(decks, ["E"], "x's deck lands and a's stays deleted");
    assert_eq!(deck_cards(&b), 0);
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// **An unknown parent waits — and, released, is skipped with its collateral applied exactly
/// once.** The parent was never sent, so no later page can bring it; the client's bound is what
/// gives up, and the release is how it does. A counter behind the block is the case that would
/// show a double count: it must end at its one delta across the hold, the release and every
/// re-delivery after it.
#[test]
fn an_unknown_parent_waits_then_release_drops_it_and_applies_its_collateral_once() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Binder', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let _never_sent = since(&a, &mut ma);
    a.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('A', 'commander', 1, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    add_copy(&a);
    let page = since(&a, &mut ma);
    assert_eq!(page.len(), 2, "{page:?}");

    let held = apply(&b, &page).unwrap();
    assert_eq!(
        (held.held_waiting, held.deferred),
        (2, 2),
        "the deck and the +1 behind it wait: {held:?}"
    );
    assert_eq!((held.held_newer, held.dropped, held.applied), (0, 0, 0));
    assert_eq!(qty(&b), (0, 0));
    assert!(
        skips(&b).is_empty(),
        "a wait is recorded only when released"
    );
    assert_eq!(
        mark_of(&b, "dev-a"),
        None,
        "the watermark stepped over a wait"
    );

    let released = apply_with(&b, &page, Waiting::Release).unwrap();
    assert_eq!(released.dropped, 1, "{released:?}");
    assert_eq!(
        (released.applied, released.deferred, released.held_waiting),
        (1, 0, 0),
        "{released:?}"
    );
    assert_eq!(qty(&b), (1, 1), "the collateral applied, once");
    let logged = skips(&b);
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert!(logged[0].2.contains("decks"), "{logged:?}");

    // Every re-delivery after the release is below the watermark.
    let again = apply(&b, &page).unwrap();
    assert_eq!(again.skipped, 2, "{again:?}");
    apply_with(&b, &page, Waiting::Release).unwrap();
    assert_eq!(qty(&b), (1, 1), "the collateral was counted twice");
    assert_eq!(skips(&b)[0].4, 1, "the release was recorded twice");
}

/// **A grain match that would rename a row onto a uid another local row wears skips the group
/// instead of failing the whole apply.** `find_row` adopts `min(theirs, ours)`, and the rename
/// used to run before the group's savepoint with nothing asking whether the lower uid was free
/// — so `idx_deck_labels_uid` failed, the `?` unwound the batch, and the same page failed the
/// same way on every pull, stopping every device's stream.
///
/// The collision is the ordinary one: `a` renames its Draw label to Ramp while `b` holds a Ramp
/// of its own, and a label rename is a sparse op that still carries `name_key`, the grain's
/// only term.
#[test]
fn a_uid_rename_onto_a_taken_uid_drops_the_group_instead_of_failing_the_apply() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    let (low, high) = (
        "00000000000000000000000000000001",
        "ffffffffffffffffffffffffffffffff",
    );
    a.execute(
        "INSERT INTO deck_labels (name, name_key, color, sync_uid, created_at, updated_at)
         VALUES ('Draw', 'draw', '#00f', ?1, unixepoch(), unixepoch())",
        [low],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute(
        "INSERT INTO deck_labels (name, name_key, color, sync_uid, created_at, updated_at)
         VALUES ('Ramp', 'ramp', '#0f0', ?1, unixepoch(), unixepoch())",
        [high],
    )
    .unwrap();

    a.execute(
        "UPDATE deck_labels SET name = 'Ramp', name_key = 'ramp'",
        [],
    )
    .unwrap();
    add_copy(&a);
    let page = since(&a, &mut ma);
    assert_eq!(page[0].uid, low, "{page:?}");

    let report = apply(&b, &page).expect("a taken uid must not fail the whole apply");
    assert_eq!(report.dropped, 1, "{report:?}");
    assert_eq!((report.applied, report.deferred), (1, 0), "{report:?}");
    assert_eq!(qty(&b), (1, 1), "the rest of the batch must apply");

    // Nothing was renamed, not even for the length of the failed group.
    let mut stmt = b
        .prepare("SELECT sync_uid, name_key FROM deck_labels ORDER BY sync_uid")
        .unwrap();
    let labels: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        labels,
        vec![
            (low.to_owned(), "draw".to_owned()),
            (high.to_owned(), "ramp".to_owned())
        ]
    );
    let logged = skips(&b);
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert!(
        logged[0]
            .3
            .as_deref()
            .is_some_and(|d| d.contains("uid taken")),
        "{logged:?}"
    );
}

/// A full insert of one `collection_entries` row, `+1`, by hand — the only way to build a page
/// whose blocks cascade through more devices than the round cap allows.
fn entry_put(uid: &str, card: &str, device: &str, ms: i64) -> Op {
    let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for (k, v) in [
        ("card_id", serde_json::json!(card)),
        ("set_code", serde_json::json!("lea")),
        ("collector_number", serde_json::json!("1")),
        ("lang", serde_json::json!("en")),
        ("finish", serde_json::json!("nonfoil")),
        ("condition", serde_json::json!("NM")),
        ("altered", serde_json::json!(0)),
        ("signed", serde_json::json!(0)),
        ("proxy", serde_json::json!(0)),
        ("misprint", serde_json::json!(0)),
        ("serial_number", serde_json::Value::Null),
        ("grading", serde_json::Value::Null),
    ] {
        fields.insert(k.to_owned(), v);
    }
    let mut parents: BTreeMap<String, Option<String>> = BTreeMap::new();
    parents.insert("folder".to_owned(), None);
    Op {
        table: "collection_entries".to_owned(),
        uid: uid.to_owned(),
        kind: Kind::Put,
        fields,
        counters: BTreeMap::from([("quantity".to_owned(), 1)]),
        parents,
        at: Hlc {
            ms,
            ctr: 0,
            device: device.to_owned(),
        },
        baseline: false,
        horizon: None,
        schema: None,
        emission: None,
    }
}

/// **At the round cap the watermarks come from the blocks the committed pass ran under.**
///
/// The page is a chain: `d0` is held by a newer op, and each row `u{k}` carries one op from
/// `d{k-1}` and a later one from `d{k}`, so each round's held row blocks the next device and
/// finds one more block than the round before. Ten groups cap the loop at eight rounds, and the
/// ninth block — `d8`'s — is found only in the round that commits. `d8` wrote one more row,
/// `h`, which that pass applied. Advancing `d8`'s watermark by the block the pass did *not* run
/// under leaves `h` above it, and the next delivery of the same page adds its `+1` again.
///
/// `d9` is the other half: its one op sits in the last held row and it wrote nothing the pass
/// applied, so its watermark must not move at all — stepped past, that op is lost.
#[test]
fn the_round_cap_advances_watermarks_by_the_committed_passes_blocks() {
    let b = paired("dev-b");
    let dev = |k: i64| format!("d{k}");
    let mut page: Vec<Op> = Vec::new();
    let mut held = entry_put("u0", "card0", "d0", 1_000);
    held.table = "future_table".to_owned();
    held.schema = newer();
    page.push(held);
    for k in 1..=8_i64 {
        let (uid, card) = (format!("u{k}"), format!("card{k}"));
        page.push(entry_put(
            &uid,
            &card,
            &dev(k - 1),
            1_000 + 10 * (k - 1) + 5,
        ));
        page.push(entry_put(&uid, &card, &dev(k), 1_000 + 10 * k));
    }
    page.push(entry_put("u8", "card8", "d9", 1_085));
    page.push(entry_put("h", "cardH", "d8", 5_000));

    let h = |conn: &Connection| -> Option<i64> {
        conn.query_row(
            "SELECT quantity FROM collection_entries WHERE card_id = 'cardH'",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    };
    let first = apply(&b, &page).unwrap();
    assert_eq!(
        first.held_newer, 18,
        "the whole chain must be held behind d0, or the fixture never reached the cap: \
         {first:?}"
    );
    assert_eq!(h(&b), Some(1), "the committed pass applied h once");
    assert_eq!(
        mark_of(&b, "d9"),
        None,
        "d9's only op is held, and was stepped past"
    );

    apply(&b, &page).unwrap();
    assert_eq!(h(&b), Some(1), "a re-delivery added h's +1 a second time");
}

// ---------------------------------------------------------------------------------------
// A delete that would clear rows out of a folder waits, then re-homes them — spec 2026-09-27 §3.3
// ---------------------------------------------------------------------------------------

/// A user binder named `name`, and its id.
fn binder(conn: &Connection, name: &str, parent: Option<i64>) -> i64 {
    conn.execute(
        "INSERT INTO collection_folders (parent_id, name, kind, sort_order, created_at, updated_at)
         VALUES (?1, ?2, 'user', 0, unixepoch(), unixepoch())",
        rusqlite::params![parent, name],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// `quantity` copies of the test printing (`add_copy`'s grain) filed in `folder`.
fn file_copies(conn: &Connection, folder: Option<i64>, quantity: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',?1,?2,unixepoch(),unixepoch())",
        rusqlite::params![quantity, folder],
    )
    .unwrap();
}

fn uids_of_copies(conn: &Connection) -> Vec<Option<String>> {
    let mut stmt = conn
        .prepare("SELECT sync_uid FROM collection_entries ORDER BY sync_uid")
        .unwrap();
    let rows = stmt.query_map([], |r| r.get(0)).unwrap();
    rows.map(Result::unwrap).collect()
}

fn folders(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM collection_folders WHERE kind = 'user'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// Both devices' `Recently removed`, wearing one uid. A re-filing into the holding area names it
/// by uid, so until the two have met it names a folder the far device has never heard of, and
/// waits.
///
/// They meet the way `clearing_the_collection_crosses_without_two_holding_areas` has them meet:
/// a clear rebuilds `Recently removed` as a whole-row insert, and the far side's grain match
/// adopts the lower uid. Both devices clear and both pages cross, so both end wearing that one.
fn holding_areas_meet(a: &Connection, b: &Connection, ma: &mut i64, mb: &mut i64) {
    crate::reset::clear_collection(a).unwrap();
    crate::reset::clear_collection(b).unwrap();
    apply(b, &since(a, ma)).unwrap();
    apply(a, &since(b, mb)).unwrap();
    let removed = |c: &Connection| -> String {
        c.query_row(
            "SELECT sync_uid FROM collection_folders WHERE kind = 'removed'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(removed(a), removed(b), "the holding areas never met");
}

/// **A binder deleted on one device, holding a copy the root holds too, lands on the other.**
/// The peer takes a page parents first, so the binder's `DELETE` ran while its copy was still in
/// it and `SET NULL` dropped the copy onto the root's grain: `UNIQUE constraint failed`, through
/// `?`, the whole apply failed, and the same page failed it on every pull after (spec §1.1).
///
/// **What makes it red**: the delete arm with no wait for the retry.
#[test]
fn a_binder_deleted_with_a_copy_the_root_also_holds_lands_on_the_peer() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    let bin = binder(&a, "Binder", None);
    file_copies(&a, Some(bin), 2);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0));
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 3), "{who} does not hold one root row of three");
        assert_eq!(folders(c), 0, "{who} still holds the binder");
    }
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// **The same for a wishlist folder**: `wishlist_entries.folder_id` is `SET NULL` and the
/// wishlist's grain carries the folder too.
#[test]
fn a_wishlist_folder_deleted_with_a_wish_the_root_also_holds_lands_on_the_peer() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO wishlist_folders (name, sort_order, created_at, updated_at)
         VALUES ('Wants', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let wants = a.last_insert_rowid();
    for (folder, n) in [(None, 1), (Some(wants), 2)] {
        a.execute(
            "INSERT INTO wishlist_entries (oracle_id, name, quantity, folder_id, created_at, updated_at)
             VALUES ('o1', 'Bolt', ?1, ?2, unixepoch(), unixepoch())",
            rusqlite::params![n, folder],
        )
        .unwrap();
    }
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::wishlist_folders::delete_folder(&a, wants).unwrap();
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0));
    for (who, c) in [("a", &a), ("b", &b)] {
        let (rows, sum): (i64, i64) = c
            .query_row(
                "SELECT count(*), coalesce(sum(quantity), 0) FROM wishlist_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, sum), (1, 3), "{who}");
    }
}

/// **Two wishes filed on the peer into two sub-folders of a wishlist folder the sender deletes end
/// as one root wish on both.** The page re-files neither — they were never the sender's — so the
/// retry re-homes them itself, one at a time: the first reaches the root and the second folds
/// into it under the lower uid, which is the uid the sender's grain match adopts when their puts
/// reach it with their folders gone. It is the one test here where `refile_wish` does the
/// re-homing, and where two doomed rows merge onto each other rather than onto a root twin.
#[test]
fn two_wishes_filed_into_a_deleted_wishlist_folders_sub_folders_end_as_one_root_wish() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let wish_folder = |name: &str, parent: Option<i64>| -> i64 {
        a.execute(
            "INSERT INTO wishlist_folders (parent_id, name, sort_order, created_at, updated_at)
             VALUES (?1, ?2, 0, unixepoch(), unixepoch())",
            rusqlite::params![parent, name],
        )
        .unwrap();
        a.last_insert_rowid()
    };
    let top = wish_folder("Top", None);
    wish_folder("One", Some(top));
    wish_folder("Two", Some(top));
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::wishlist_folders::delete_folder(&a, top).unwrap();
    for name in ["One", "Two"] {
        b.execute(
            "INSERT INTO wishlist_entries (oracle_id, name, quantity, folder_id, created_at, updated_at)
             VALUES ('o1', 'Bolt', 1, (SELECT id FROM wishlist_folders WHERE name = ?1),
                     unixepoch(), unixepoch())",
            [name],
        )
        .unwrap();
    }

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();

    assert_eq!((unwritten(ra), unwritten(rb)), ((0, 0), (0, 0)));
    let wishes = |c: &Connection| -> Vec<(Option<String>, Option<i64>, i64)> {
        let mut stmt = c
            .prepare("SELECT sync_uid, folder_id, quantity FROM wishlist_entries ORDER BY id")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        rows.map(Result::unwrap).collect()
    };
    for (who, c) in [("a", &a), ("b", &b)] {
        let rows = wishes(c);
        assert_eq!(rows.len(), 1, "{who} holds {rows:?}");
        assert_eq!(
            (rows[0].1, rows[0].2),
            (None, 2),
            "{who}: one root wish of two"
        );
        let drawers: i64 = c
            .query_row("SELECT count(*) FROM wishlist_folders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(drawers, 0, "{who} still holds a drawer");
    }
    assert_eq!(
        wishes(&a)[0].0,
        wishes(&b)[0].0,
        "the two devices kept different uids"
    );
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// **A deck deleted on one device, whose group holds a copy the root holds too, lands on the
/// other.** `collection_folders.deck_id` cascades, so the deck's `DELETE` (rank 1) takes its
/// group on the peer before the sender's re-filing into `Recently removed` (rank 7) arrives.
#[test]
fn a_deck_deleted_with_a_copy_its_group_and_the_root_both_hold_lands_on_the_peer() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    holding_areas_meet(&a, &b, &mut ma, &mut mb);
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('D', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let deck = a.last_insert_rowid();
    a.execute(
        "INSERT INTO collection_folders (name, kind, deck_id, sort_order, created_at, updated_at)
         VALUES ('D', 'deck', ?1, 0, unixepoch(), unixepoch())",
        [deck],
    )
    .unwrap();
    let group = a.last_insert_rowid();
    add_copy(&a);
    file_copies(&a, Some(group), 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::deck::delete_deck(&a, deck).unwrap();
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0));
    for (who, c) in [("a", &a), ("b", &b)] {
        let decks: i64 = c
            .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(decks, 0, "{who}");
        assert_eq!(
            qty(c),
            (2, 2),
            "{who}: one copy at the root, one in Recently removed"
        );
    }
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// The `sync_uid`s `conn`'s collection folders of one `kind` wear, in order.
fn folder_uids(conn: &Connection, kind: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT sync_uid FROM collection_folders WHERE kind = ?1 ORDER BY sync_uid")
        .unwrap();
    let rows = stmt.query_map([kind], |r| r.get(0)).unwrap();
    rows.map(Result::unwrap).collect()
}

/// **A collection cleared on one device keeps the holding area and the deck groups it re-made, on
/// the other.** `reset::clear_collection` deletes every folder and re-makes `Recently removed` and
/// one group per deck in the same write. On the peer the old folders still hold copies, so their
/// deletes wait for the retry — and the re-made rows' inserts grain-match the OLD rows, still
/// standing, on the two partial grains (`kind = 'removed'`, `deck_id`). Adopting `min` kept the
/// old uid wherever it sorted lower, and the retried delete then took the row the insert had just
/// landed on: the peer lost its holding area and the deck's group, silently. The old uids are
/// forced low on both devices here so the order is not a coin toss.
///
/// **What makes it red**: `find_row` adopting `min` on a grain hit whose uid this page deletes.
#[test]
fn a_collection_cleared_on_one_device_keeps_the_re_made_folders_on_the_other() {
    a_collection_cleared_crosses_keeping_the_last_re_made_folders(1);
}

/// **...and cleared twice between two pulls, it keeps the folders the second clear made.** The
/// page on each partial grain is `del R`, then `put R'` and `del R'`, then `put R''` — the same
/// shape a deck switched to Virtual and back twice makes of its group. `R'` was made and discarded
/// on the sender, and its group grain-hit whatever stood on its grain: first the old row (renamed
/// to `R'`, then waiting to be deleted and rolled back), and on the retry `R''`, which it adopted
/// by `min` and then deleted — the peer lost its holding area and the deck's group again, in
/// either order of the two new uids.
///
/// **What makes it red**: `find_row` grain-matching a group whose own ops end in a delete.
#[test]
fn a_collection_cleared_twice_on_one_device_keeps_the_last_re_made_folders_on_the_other() {
    a_collection_cleared_crosses_keeping_the_last_re_made_folders(2);
}

/// The two tests above: holding areas that have met, a deck group and `Recently removed` each
/// holding a copy the root holds too, old folder uids forced low, then `clear_collection` on the
/// sender `clears` times before the peer pulls.
fn a_collection_cleared_crosses_keeping_the_last_re_made_folders(clears: usize) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    holding_areas_meet(&a, &b, &mut ma, &mut mb);
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('D', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let deck = a.last_insert_rowid();
    a.execute(
        "INSERT INTO collection_folders (name, kind, deck_id, sort_order, created_at, updated_at)
         VALUES ('D', 'deck', ?1, 0, unixepoch(), unixepoch())",
        [deck],
    )
    .unwrap();
    let group = a.last_insert_rowid();
    let removed: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE kind = 'removed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    add_copy(&a);
    file_copies(&a, Some(group), 1);
    file_copies(&a, Some(removed), 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);
    // Below anything `randomblob` mints, and the same on both, as the met rows already are.
    for c in [&a, &b] {
        capture::suppressed(c, || {
            c.execute_batch(
                "UPDATE collection_folders SET sync_uid = '0000000000000000000000000000000a'
                  WHERE kind = 'removed';
                 UPDATE collection_folders SET sync_uid = '0000000000000000000000000000000b'
                  WHERE kind = 'deck';",
            )
            .unwrap();
        });
    }

    for _ in 0..clears {
        crate::reset::clear_collection(&a).unwrap();
    }
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0), "{rb:?}");
    for kind in ["removed", "deck"] {
        let (on_a, on_b) = (folder_uids(&a, kind), folder_uids(&b, kind));
        assert_eq!(on_b.len(), 1, "b holds {on_b:?} as its {kind} folders");
        assert_eq!(
            on_b, on_a,
            "b's {kind} folder is not the one a re-made last"
        );
    }
    assert_eq!(qty(&b), (0, 0), "the clear must cross");
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// **A copy made at the root, then a binder deleted whose copy folds into it, lands at the
/// sender's count.** The sender's page carries the new copy's insert, the `+2` its fold added,
/// the binder copy's delete and the binder's delete — and the peer takes it parents first, so the
/// binder's delete comes first and collides with nothing yet: the new copy has not landed.
/// Re-homed then, the binder's copy took the root's grain, the new copy's insert grain-matched
/// it and added its `+3` on top, and the two devices' counts parted. Waiting for the retry lets
/// the insert and the delete land first, and the retry finds the binder empty (spec 2026-09-27
/// §3.3, as amended).
///
/// **What makes it red**: a delete that waits only when it would collide.
#[test]
fn a_new_root_copy_and_a_binder_that_folds_into_it_land_at_the_senders_count() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    let bin = binder(&a, "Binder", None);
    file_copies(&a, Some(bin), 2);
    apply(&b, &since(&a, &mut ma)).unwrap();

    add_copy(&a);
    crate::collection_folders::delete_folder(&a, bin).unwrap();
    assert_eq!(
        qty(&a),
        (1, 3),
        "the premise: the binder's copy folded into the new one"
    );
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0), "{rb:?}");
    assert_eq!(qty(&b), (1, 3));
    assert_eq!(folders(&b), 0);
    assert_eq!(uids_of_copies(&a), uids_of_copies(&b));
}

/// **A copy made and deleted on the sender between two pulls never deletes the peer's own copy
/// of that printing.** `b` holds a root copy `a` has never seen; `a` adds one on the same grain
/// and deletes it before `b` pulls. The page's group for it folds to deleted, and its insert
/// carries a whole grain, so a grain match landed it on `b`'s copy — which the delete then took.
/// The sender made and discarded that row, so its delete can only ever mean a row wearing its
/// own uid.
///
/// **What makes it red**: `find_row` grain-matching a group whose own ops end in a delete.
#[test]
fn a_row_made_and_deleted_on_the_sender_never_deletes_a_local_twin() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&b);
    let before = uids_of_copies(&b);

    add_copy(&a);
    a.execute("DELETE FROM collection_entries", []).unwrap();
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0), "{rb:?}");
    assert_eq!(
        qty(&b),
        (1, 1),
        "b's own copy did not survive a's discarded one"
    );
    assert_eq!(uids_of_copies(&b), before, "b's own copy was renamed");

    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0), "{ra:?}");
    assert_eq!(qty(&a), (1, 1));
    assert_eq!(uids_of_copies(&a), before);
}

/// **...but a row deleted and put back in one page still meets its twin.** `a` makes a copy and
/// `c` receives it; `a` deletes it while `c` edits it, so the page `b` pulls — `a`'s insert and
/// delete, `c`'s later edit — names the copy's uid in a delete and still folds to a row that
/// exists: add-wins. `b` holds its own copy of the printing, which neither of the others has seen.
/// Keyed on the page's deletes, the group skipped the grain, found nothing by its uid, and its
/// insert hit `idx_collection_grain` beside `b`'s copy — dropped as a row this database cannot
/// build. Keyed on the group's own fold, it grain-matches `b`'s copy as any put does, and the two
/// copies are one row.
///
/// **What makes it red**: `find_row` skipping the grain because the page deletes the group's uid,
/// where the group's own ops do not end in a delete.
#[test]
fn a_row_deleted_and_put_back_in_one_page_still_meets_its_twin() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    add_copy(&b);
    add_copy(&a);
    let uid: String = a
        .query_row("SELECT sync_uid FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    let made = since(&a, &mut ma);
    apply(&c, &made).unwrap();
    let _ = since(&c, &mut mc);

    a.execute("DELETE FROM collection_entries", []).unwrap();
    c.execute("UPDATE collection_entries SET notes = 'kept on c'", [])
        .unwrap();
    let mut page = made;
    page.extend(since(&a, &mut ma));
    page.extend(since(&c, &mut mc));
    let about: Vec<Op> = page.iter().filter(|op| op.uid == uid).cloned().collect();
    assert!(
        about.iter().any(|op| op.kind == Kind::Del) && !fold(&about).deleted,
        "the premise: the page deletes the copy and puts it back: {about:?}"
    );

    let rb = apply(&b, &page).unwrap();

    assert_eq!(unwritten(rb), (0, 0), "{rb:?}");
    assert_eq!(
        qty(&b),
        (1, 2),
        "b's copy and the put-back one are not one row"
    );
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// **Two copies filed on the peer into two sub-folders of a binder the sender deletes end as one
/// root row on both** — the collection's form of the wishlist test above. The page re-files
/// neither, so the retry re-homes them itself, one at a time: the first reaches the root and the
/// second folds into it under the lower uid, which the sender's grain match adopts too. Since
/// every clearing delete waits, this is the one test where `rehome` folds two collection rows onto
/// each other rather than finding the page's re-filing already done.
#[test]
fn two_copies_filed_into_a_deleted_binders_sub_folders_end_as_one_root_row() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let outer = binder(&a, "Outer", None);
    binder(&a, "One", Some(outer));
    binder(&a, "Two", Some(outer));
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::collection_folders::delete_folder(&a, outer).unwrap();
    for name in ["One", "Two"] {
        let id: i64 = b
            .query_row(
                "SELECT id FROM collection_folders WHERE name = ?1",
                [name],
                |r| r.get(0),
            )
            .unwrap();
        file_copies(&b, Some(id), 1);
    }

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();

    assert_eq!((unwritten(ra), unwritten(rb)), ((0, 0), (0, 0)));
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 2), "{who}: one root row of two");
        assert_eq!(folders(c), 0, "{who} still holds a binder");
    }
    assert_eq!(
        uids_of_copies(&a),
        uids_of_copies(&b),
        "the two devices kept different uids"
    );
    assert!(skips(&a).is_empty() && skips(&b).is_empty());
}

/// **A copy filed on the peer into the binder being deleted survives on both, as one row.**
/// The page carries no re-filing for it, so no ordering saves it: the retry merges it onto the
/// root's copy, and the sender meets its put with the binder gone and grain-matches the same
/// row. Both adopt the lower uid.
#[test]
fn a_copy_filed_into_a_binder_the_peer_deletes_meets_the_roots_copy_as_one_row() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    let bin = binder(&a, "Binder", None);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    let b_bin: i64 = b
        .query_row(
            "SELECT id FROM collection_folders WHERE name = 'Binder'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    file_copies(&b, Some(b_bin), 2);

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();

    assert_eq!((unwritten(ra), unwritten(rb)), ((0, 0), (0, 0)));
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 3), "{who}");
        assert_eq!(folders(c), 0, "{who}");
    }
    assert_eq!(
        uids_of_copies(&a),
        uids_of_copies(&b),
        "the two devices kept different uids"
    );
}

/// **Two copies in two sub-folders, and a root copy, on one grain end as one root row.**
/// The sender's `delete_folder` re-files one at a time; the peer meets the sub-folders' deletes
/// first and must not drop either copy onto the other (Review Focus 2).
#[test]
fn three_copies_on_one_grain_under_a_deleted_folder_end_as_one_root_row_on_both() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    let outer = binder(&a, "Outer", None);
    let one = binder(&a, "One", Some(outer));
    let two = binder(&a, "Two", Some(outer));
    file_copies(&a, Some(one), 1);
    file_copies(&a, Some(two), 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::collection_folders::delete_folder(&a, outer).unwrap();
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0));
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 3), "{who}");
        assert_eq!(folders(c), 0, "{who}");
    }
}

/// **Two doomed copies that are each other's twin, with no root copy at all, wait like any
/// other.** A deck's group holding a sub-folder — a tree no command builds and the DDL allows,
/// which is why `delete_deck` walks the sub-tree — is the one place a single `DELETE` dooms two
/// copies of one printing at once, where the test above meets them one sub-folder at a time. The
/// sender merges them into `Recently removed` one at a time; a peer that merged them itself before
/// that re-filing landed would then add the sender's `+1` for the survivor on top. (It was written
/// against the half of the old collision check that matched two doomed rows against each other;
/// every delete that clears a row waits now, and this pins that the wait still covers it.)
///
/// **What makes it red**: a delete that re-homes before the page's own re-filing has landed.
#[test]
fn a_deck_whose_group_and_its_sub_folder_hold_one_printing_lands_at_its_own_count() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    holding_areas_meet(&a, &b, &mut ma, &mut mb);
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('D', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let deck = a.last_insert_rowid();
    a.execute(
        "INSERT INTO collection_folders (name, kind, deck_id, sort_order, created_at, updated_at)
         VALUES ('D', 'deck', ?1, 0, unixepoch(), unixepoch())",
        [deck],
    )
    .unwrap();
    let group = a.last_insert_rowid();
    let sub = binder(&a, "Sub", Some(group));
    file_copies(&a, Some(group), 1);
    file_copies(&a, Some(sub), 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::deck::delete_deck(&a, deck).unwrap();
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0), "{rb:?}");
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 2), "{who} does not hold one row of two");
        let removed: i64 = c
            .query_row(
                "SELECT coalesce(sum(e.quantity), 0) FROM collection_entries e
                   JOIN collection_folders f ON f.id = e.folder_id
                  WHERE f.kind = 'removed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(removed, 2, "{who}: both copies belong in Recently removed");
        assert_eq!(folders(c), 0, "{who} still holds the sub-folder");
    }
}

/// **A page handed back after a held cursor re-homes and sums nothing a second time**
/// (Review Focus 3): the delete is below its sender's watermark on the second delivery.
#[test]
fn a_redelivered_binder_delete_changes_nothing_the_second_time() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    add_copy(&a);
    let bin = binder(&a, "Binder", None);
    file_copies(&a, Some(bin), 2);
    apply(&b, &since(&a, &mut ma)).unwrap();

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    let page = since(&a, &mut ma);
    apply(&b, &page).unwrap();
    let again = apply(&b, &page).unwrap();
    assert_eq!(unwritten(again), (0, 0));
    assert_eq!(qty(&b), (1, 3));
}

/// **A survivor with no uid takes the one the re-homed copy had** (Review Focus 1). A row
/// written behind the apply's guard can be nameless; the fold must still happen, and the name
/// a peer knows the copy by must not be thrown away.
#[test]
fn a_copy_folded_onto_a_nameless_twin_gives_the_twin_its_uid() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let bin = binder(&a, "Binder", None);
    file_copies(&a, Some(bin), 2);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);
    let filed: String = b
        .query_row("SELECT sync_uid FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    // A nameless root twin on `b` alone.
    crate::sync_engine::capture::suppressed(&b, || {
        file_copies(&b, None, 1);
        b.execute(
            "UPDATE collection_entries SET sync_uid = NULL WHERE folder_id IS NULL",
            [],
        )
        .unwrap();
    });

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(qty(&b), (1, 3));
    assert_eq!(uids_of_copies(&b), vec![Some(filed)]);
}

// ---------------------------------------------------------------------------------------
// A move onto a grain a row of this device's own already holds folds the two
// ---------------------------------------------------------------------------------------

/// Two uids in a known order, so both ways a fold can keep one are driven rather than left to a
/// coin toss.
const LOWER: &str = "0000000000000000000000000000000a";
const HIGHER: &str = "0000000000000000000000000000000b";

/// `quantity` copies of the test printing (`add_copy`'s grain) wearing `uid`, filed in `folder`.
fn a_copy_wearing(conn: &Connection, uid: &str, folder: Option<i64>, quantity: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,sync_uid,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',?1,?2,?3,unixepoch(),unixepoch())",
        rusqlite::params![quantity, folder, uid],
    )
    .unwrap();
}

/// The local id of the binder both devices call `name`.
fn binder_named(conn: &Connection, name: &str) -> i64 {
    conn.query_row(
        "SELECT id FROM collection_folders WHERE name = ?1",
        [name],
        |r| r.get(0),
    )
    .unwrap()
}

/// Drag the copy wearing `uid` into `folder` on `conn`, as the reader does.
fn drag_copy(conn: &Connection, uid: &str, folder: Option<i64>) {
    let id: i64 = conn
        .query_row(
            "SELECT id FROM collection_entries WHERE sync_uid = ?1",
            [uid],
            |r| r.get(0),
        )
        .unwrap();
    crate::collection_folders::set_entry_folder(conn, id, folder).unwrap();
}

/// **A copy the sender moved to where this device holds a copy of its own it has not sent yet
/// meets it as one row, as it does on the sender.** Both hold `c`; `b` adds `u`, the same
/// printing, where `a` — not having heard — drags `c`. The drag is a sparse put naming only the
/// folder, so `b` finds `c` by its uid, asks no grain, and `idx_collection_grain` is the first to
/// say `u` is there: the group was rolled back and dropped with an `error_log` row, while on `a`
/// `u`'s insert grain-matched `c` and the two became one. One row of three there, two rows here,
/// in different folders, and nothing either would send said so.
///
/// Both ways round — into a binder, and out of one onto the root — and both uid orders, since the
/// survivor is `u`'s row here and `c`'s row there and they must end wearing one name.
///
/// **What makes it red**: `write_group` answering the grain's refusal of a move with
/// `Why::Unbuildable`.
fn a_copy_moved_onto_one_the_peer_has_not_sent(moved_lower: bool, into_the_binder: bool) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let (c, u) = if moved_lower {
        (LOWER, HIGHER)
    } else {
        (HIGHER, LOWER)
    };
    let other = binder(&a, "Other", None);
    let (from, to) = if into_the_binder {
        (None, Some(other))
    } else {
        (Some(other), None)
    };
    a_copy_wearing(&a, c, from, 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);
    a_copy_wearing(&b, u, to.map(|_| binder_named(&b, "Other")), 2);

    drag_copy(&a, c, to);
    let page = since(&a, &mut ma);
    assert!(
        page.len() == 1
            && page[0].uid == c
            && page[0].fields.is_empty()
            && page[0].parents.contains_key("folder"),
        "the premise: one sparse move of c: {page:?}"
    );

    let rb = apply(&b, &page).unwrap();
    assert_eq!(unwritten(rb), (0, 0), "b holds {:?}", qty(&b));
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0));
    for (who, conn) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(conn), (1, 3), "{who} does not hold one row of three");
        assert_eq!(uids_of_copies(conn), vec![Some(LOWER.to_owned())], "{who}");
        assert_eq!(
            copies_at_root(conn),
            i64::from(!into_the_binder),
            "{who} holds the row in the wrong place"
        );
    }
    assert!(
        skips(&a).is_empty() && skips(&b).is_empty(),
        "{:?} {:?}",
        skips(&a),
        skips(&b)
    );
}

#[test]
fn a_lower_copy_moved_into_a_binder_onto_one_the_peer_has_not_sent_ends_as_one_row() {
    a_copy_moved_onto_one_the_peer_has_not_sent(true, true);
}

#[test]
fn a_higher_copy_moved_into_a_binder_onto_one_the_peer_has_not_sent_ends_as_one_row() {
    a_copy_moved_onto_one_the_peer_has_not_sent(false, true);
}

#[test]
fn a_lower_copy_moved_to_the_root_onto_one_the_peer_has_not_sent_ends_as_one_row() {
    a_copy_moved_onto_one_the_peer_has_not_sent(true, false);
}

#[test]
fn a_higher_copy_moved_to_the_root_onto_one_the_peer_has_not_sent_ends_as_one_row() {
    a_copy_moved_onto_one_the_peer_has_not_sent(false, false);
}

/// **The same for a wish**: the wishlist's grain carries the folder too, and
/// `wishlist::fold_wish` is its merge.
fn a_wish_moved_onto_one_the_peer_has_not_sent(moved_lower: bool) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let (c, u) = if moved_lower {
        (LOWER, HIGHER)
    } else {
        (HIGHER, LOWER)
    };
    let wish = |conn: &Connection, uid: &str, filed: bool, quantity: i64| {
        conn.execute(
            "INSERT INTO wishlist_entries
                (oracle_id, name, quantity, folder_id, sync_uid, created_at, updated_at)
             VALUES ('o1', 'Bolt', ?1,
                     CASE WHEN ?2 THEN (SELECT id FROM wishlist_folders WHERE name = 'Wants') END,
                     ?3, unixepoch(), unixepoch())",
            rusqlite::params![quantity, filed, uid],
        )
        .unwrap();
    };
    a.execute(
        "INSERT INTO wishlist_folders (name, sort_order, created_at, updated_at)
         VALUES ('Wants', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let wants = a.last_insert_rowid();
    wish(&a, c, false, 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);
    wish(&b, u, true, 2);

    let moved: i64 = a
        .query_row("SELECT id FROM wishlist_entries", [], |r| r.get(0))
        .unwrap();
    crate::wishlist_folders::set_wish_folder(&a, moved, Some(wants)).unwrap();
    let page = since(&a, &mut ma);
    assert!(
        page.len() == 1 && page[0].uid == c && page[0].fields.is_empty(),
        "the premise: one sparse move of c: {page:?}"
    );

    let rb = apply(&b, &page).unwrap();
    assert_eq!(unwritten(rb), (0, 0));
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0));
    for (who, conn) in [("a", &a), ("b", &b)] {
        let wishes: Vec<(Option<String>, bool, i64)> = conn
            .prepare("SELECT sync_uid, folder_id IS NOT NULL, quantity FROM wishlist_entries")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            wishes,
            vec![(Some(LOWER.to_owned()), true, 3)],
            "{who} does not hold one filed wish of three"
        );
    }
    assert!(
        skips(&a).is_empty() && skips(&b).is_empty(),
        "{:?} {:?}",
        skips(&a),
        skips(&b)
    );
}

#[test]
fn a_lower_wish_moved_onto_one_the_peer_has_not_sent_ends_as_one_wish() {
    a_wish_moved_onto_one_the_peer_has_not_sent(true);
}

#[test]
fn a_higher_wish_moved_onto_one_the_peer_has_not_sent_ends_as_one_wish() {
    a_wish_moved_onto_one_the_peer_has_not_sent(false);
}

/// **What rides with the move is applied, and once.** `a` adds two copies to `c` and drags it in
/// one page, so the group carries a `+2` beside the folder: it lands on the one row the fold
/// leaves, whichever uid that row kept, and is not counted again by the fold.
#[test]
fn a_count_riding_with_a_move_onto_the_peers_copy_is_counted_once() {
    for (c, u) in [(LOWER, HIGHER), (HIGHER, LOWER)] {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let (mut ma, mut mb) = (0, 0);
        let other = binder(&a, "Other", None);
        a_copy_wearing(&a, c, None, 1);
        apply(&b, &since(&a, &mut ma)).unwrap();
        let _ = since(&b, &mut mb);
        a_copy_wearing(&b, u, Some(binder_named(&b, "Other")), 2);

        a.execute(
            "UPDATE collection_entries SET quantity = quantity + 2 WHERE sync_uid = ?1",
            [c],
        )
        .unwrap();
        drag_copy(&a, c, Some(other));

        let rb = apply(&b, &since(&a, &mut ma)).unwrap();
        assert_eq!(unwritten(rb), (0, 0), "c is {c}");
        apply(&a, &since(&b, &mut mb)).unwrap();
        for (who, conn) in [("a", &a), ("b", &b)] {
            assert_eq!(qty(conn), (1, 5), "{who}, where c is {c}");
            assert_eq!(uids_of_copies(conn), vec![Some(LOWER.to_owned())], "{who}");
        }
    }
}

/// **A row the page itself moves is never folded into.** Both hold `h` in `Other` and `c` at the
/// root, one printing; `a` swaps them, by way of a third binder. Each move lands on the grain the
/// other row is leaving, and neither can go first — but the sender holds two rows, so folding
/// either into the other would be one row here for two there. They stay two.
///
/// **What makes it red**: folding onto whatever holds the grain, without asking whether the page
/// has its own say about that row.
#[test]
fn two_copies_the_sender_swapped_between_the_root_and_a_binder_stay_two() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    let other = binder(&a, "Other", None);
    let aside = binder(&a, "Aside", None);
    a_copy_wearing(&a, LOWER, None, 1);
    a_copy_wearing(&a, HIGHER, Some(other), 2);
    apply(&b, &since(&a, &mut ma)).unwrap();

    drag_copy(&a, HIGHER, Some(aside));
    drag_copy(&a, LOWER, Some(other));
    drag_copy(&a, HIGHER, None);

    apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(
        qty(&b),
        (2, 3),
        "b folded two copies its sender keeps apart"
    );
    assert_eq!(copies_at_root(&b), 1);
}

/// **A row the page deletes is not folded into either, however the page's groups sort.** Both
/// hold `u` in `Other` and `c` at the root. `a` edits `c`, deletes `u`, then drags `c` into
/// `Other`: `c`'s group sorts first, by its oldest op, so its move meets `u` still there. It
/// waits, `u`'s delete lands, and the retry moves `c` onto a free grain — where folding at once
/// would have put `c`'s copies in the row the delete then took.
///
/// **What makes it red**: folding on the first attempt.
#[test]
fn a_copy_moved_to_where_the_page_deletes_a_copy_is_not_folded_into_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    let other = binder(&a, "Other", None);
    a_copy_wearing(&a, HIGHER, None, 1);
    a_copy_wearing(&a, LOWER, Some(other), 2);
    apply(&b, &since(&a, &mut ma)).unwrap();

    a.execute(
        "UPDATE collection_entries SET notes = 'played' WHERE sync_uid = ?1",
        [HIGHER],
    )
    .unwrap();
    a.execute(
        "DELETE FROM collection_entries WHERE sync_uid = ?1",
        [LOWER],
    )
    .unwrap();
    drag_copy(&a, HIGHER, Some(other));

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(unwritten(rb), (0, 0));
    for (who, conn) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(conn), (1, 1), "{who}");
        assert_eq!(uids_of_copies(conn), vec![Some(HIGHER.to_owned())], "{who}");
        assert_eq!(copies_at_root(conn), 0, "{who}");
    }
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

// ---------------------------------------------------------------------------------------
// An edit onto a grain a row of this device's own already holds folds the two as well
// ---------------------------------------------------------------------------------------

/// [`a_copy_wearing`], in `condition` — the third term of the collection's grain.
fn a_copy_graded(
    conn: &Connection,
    uid: &str,
    condition: &str,
    folder: Option<i64>,
    quantity: i64,
) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,sync_uid,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil',?1,?2,?3,?4,unixepoch(),unixepoch())",
        rusqlite::params![condition, quantity, folder, uid],
    )
    .unwrap();
}

/// Grade the copy wearing `uid` on `conn`: one sparse put naming `condition` and nothing else.
fn grade_copy(conn: &Connection, uid: &str, condition: &str) {
    conn.execute(
        "UPDATE collection_entries SET condition = ?1 WHERE sync_uid = ?2",
        [condition, uid],
    )
    .unwrap();
}

fn conditions(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT condition FROM collection_entries ORDER BY condition")
        .unwrap();
    let rows = stmt.query_map([], |r| r.get(0)).unwrap();
    rows.map(Result::unwrap).collect()
}

/// **A copy the sender edited onto the grain of a copy this device has not sent yet meets it as
/// one row, as it does on the sender** — [`a_copy_moved_onto_one_the_peer_has_not_sent`] with no
/// move in it. Both hold `c`, near mint; `b` adds `u`, the same printing lightly played, where
/// `a` — not having heard — regrades `c` to lightly played. The edit is a sparse put naming only
/// `condition`, so `b` finds `c` by its uid, asks no grain, and `idx_collection_grain` is the
/// first to say `u` is there: the group was dropped with an `error_log` row, while on `a` `u`'s
/// insert grain-matched `c`. One row of three there, two rows here.
///
/// `and_moved` has `a` drag `c` into the binder `u` is filed in as well, in the same page: one
/// group naming a field of the grain **and** its folder, which lands on a grain neither names
/// alone.
///
/// **What makes it red**: `write_group` answering the grain's refusal of such an edit with
/// `Why::Unbuildable` — which is also what filing the row as it stands does, since the row in the
/// way holds the *new* condition and a merge that asks about the old one finds nothing.
fn a_copy_edited_onto_one_the_peer_has_not_sent(edited_lower: bool, and_moved: bool) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let (c, u) = if edited_lower {
        (LOWER, HIGHER)
    } else {
        (HIGHER, LOWER)
    };
    let other = binder(&a, "Other", None);
    a_copy_graded(&a, c, "NM", None, 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);
    let filed = and_moved.then(|| binder_named(&b, "Other"));
    a_copy_graded(&b, u, "LP", filed, 2);

    grade_copy(&a, c, "LP");
    if and_moved {
        drag_copy(&a, c, Some(other));
    }
    let page = since(&a, &mut ma);
    let fields: Vec<&String> = page.iter().flat_map(|op| op.fields.keys()).collect();
    let parents: Vec<&String> = page.iter().flat_map(|op| op.parents.keys()).collect();
    assert!(
        page.iter().all(|op| op.uid == c)
            && fields == ["condition"]
            && parents.len() == usize::from(and_moved),
        "the premise: a sparse edit of c's condition, and its move where asked: {page:?}"
    );

    let rb = apply(&b, &page).unwrap();
    assert_eq!(unwritten(rb), (0, 0), "b holds {:?}", qty(&b));
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!(unwritten(ra), (0, 0));
    for (who, conn) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(conn), (1, 3), "{who} does not hold one row of three");
        assert_eq!(uids_of_copies(conn), vec![Some(LOWER.to_owned())], "{who}");
        assert_eq!(conditions(conn), ["LP"], "{who}");
        assert_eq!(
            copies_at_root(conn),
            i64::from(!and_moved),
            "{who} holds the row in the wrong place"
        );
    }
    assert!(
        skips(&a).is_empty() && skips(&b).is_empty(),
        "{:?} {:?}",
        skips(&a),
        skips(&b)
    );
}

#[test]
fn a_lower_copy_edited_onto_one_the_peer_has_not_sent_ends_as_one_row() {
    a_copy_edited_onto_one_the_peer_has_not_sent(true, false);
}

#[test]
fn a_higher_copy_edited_onto_one_the_peer_has_not_sent_ends_as_one_row() {
    a_copy_edited_onto_one_the_peer_has_not_sent(false, false);
}

#[test]
fn a_lower_copy_edited_and_moved_onto_one_the_peer_has_not_sent_ends_as_one_row() {
    a_copy_edited_onto_one_the_peer_has_not_sent(true, true);
}

#[test]
fn a_higher_copy_edited_and_moved_onto_one_the_peer_has_not_sent_ends_as_one_row() {
    a_copy_edited_onto_one_the_peer_has_not_sent(false, true);
}

/// `(sync_uid, filed, quantity, oracle_id, card_id, preferred_finish)` of every wish on `conn`.
type Wish = (
    Option<String>,
    bool,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn wishes(conn: &Connection) -> Vec<Wish> {
    conn.prepare(
        "SELECT sync_uid, folder_id IS NOT NULL, quantity, oracle_id, card_id, preferred_finish
           FROM wishlist_entries ORDER BY sync_uid",
    )
    .unwrap()
    .query_map([], |r| {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
        ))
    })
    .unwrap()
    .map(Result::unwrap)
    .collect()
}

/// **The same for a wish, over each of the three fields its grain is made of** — the printing it
/// is pinned to, the finish it prefers, and the card it names. `b`'s unsent wish `u` already says
/// what `a`'s edit makes `c` say; `and_moved` files `u` in a wishlist folder and has `a` move `c`
/// there in the same page.
fn a_wish_edited_onto_one_the_peer_has_not_sent(edited_lower: bool, and_moved: bool) {
    for (column, new) in [
        ("preferred_finish", "foil"),
        ("card_id", "c9"),
        ("oracle_id", "o9"),
    ] {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let (mut ma, mut mb) = (0, 0);
        let (c, u) = if edited_lower {
            (LOWER, HIGHER)
        } else {
            (HIGHER, LOWER)
        };
        let wish = |conn: &Connection, uid: &str, edited: bool, filed: bool, quantity: i64| {
            let said = |term: &str| (edited && term == column).then_some(new);
            conn.execute(
                "INSERT INTO wishlist_entries
                    (oracle_id, card_id, preferred_finish, name, quantity, folder_id, sync_uid,
                     created_at, updated_at)
                 VALUES (coalesce(?1, 'o1'), ?2, ?3, 'Bolt', ?4,
                         CASE WHEN ?5 THEN (SELECT id FROM wishlist_folders WHERE name = 'Wants')
                         END,
                         ?6, unixepoch(), unixepoch())",
                rusqlite::params![
                    said("oracle_id"),
                    said("card_id"),
                    said("preferred_finish"),
                    quantity,
                    filed,
                    uid
                ],
            )
            .unwrap();
        };
        a.execute(
            "INSERT INTO wishlist_folders (name, sort_order, created_at, updated_at)
             VALUES ('Wants', 0, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let wants = a.last_insert_rowid();
        wish(&a, c, false, false, 1);
        apply(&b, &since(&a, &mut ma)).unwrap();
        let _ = since(&b, &mut mb);
        wish(&b, u, true, and_moved, 2);

        a.execute(
            &format!("UPDATE wishlist_entries SET {column} = ?1 WHERE sync_uid = ?2"),
            [new, c],
        )
        .unwrap();
        if and_moved {
            let moved: i64 = a
                .query_row("SELECT id FROM wishlist_entries", [], |r| r.get(0))
                .unwrap();
            crate::wishlist_folders::set_wish_folder(&a, moved, Some(wants)).unwrap();
        }
        let page = since(&a, &mut ma);
        let fields: Vec<&String> = page.iter().flat_map(|op| op.fields.keys()).collect();
        assert!(
            page.iter().all(|op| op.uid == c) && fields == [column],
            "the premise: a sparse edit of c's {column}: {page:?}"
        );

        let rb = apply(&b, &page).unwrap();
        assert_eq!(unwritten(rb), (0, 0), "{column}: b holds {:?}", wishes(&b));
        let ra = apply(&a, &since(&b, &mut mb)).unwrap();
        assert_eq!(unwritten(ra), (0, 0), "{column}");
        let said = |term: &str| (term == column).then(|| new.to_owned());
        let one = (
            Some(LOWER.to_owned()),
            and_moved,
            3,
            said("oracle_id").or(Some("o1".to_owned())),
            said("card_id"),
            said("preferred_finish"),
        );
        for (who, conn) in [("a", &a), ("b", &b)] {
            assert_eq!(wishes(conn), vec![one.clone()], "{column}: {who}");
        }
        assert!(
            skips(&a).is_empty() && skips(&b).is_empty(),
            "{column}: {:?} {:?}",
            skips(&a),
            skips(&b)
        );
    }
}

#[test]
fn a_lower_wish_edited_onto_one_the_peer_has_not_sent_ends_as_one_wish() {
    a_wish_edited_onto_one_the_peer_has_not_sent(true, false);
}

#[test]
fn a_higher_wish_edited_onto_one_the_peer_has_not_sent_ends_as_one_wish() {
    a_wish_edited_onto_one_the_peer_has_not_sent(false, false);
}

#[test]
fn a_lower_wish_edited_and_moved_onto_one_the_peer_has_not_sent_ends_as_one_wish() {
    a_wish_edited_onto_one_the_peer_has_not_sent(true, true);
}

#[test]
fn a_higher_wish_edited_and_moved_onto_one_the_peer_has_not_sent_ends_as_one_wish() {
    a_wish_edited_onto_one_the_peer_has_not_sent(false, true);
}

/// **What rides with the edit is applied, and once**:
/// [`a_count_riding_with_a_move_onto_the_peers_copy_is_counted_once`], for an edit. `a` adds two
/// copies to `c`, writes a note on it and regrades it in one page; the `+2` and the note land on
/// the one row the fold leaves.
#[test]
fn a_count_riding_with_an_edit_onto_the_peers_copy_is_counted_once() {
    for (c, u) in [(LOWER, HIGHER), (HIGHER, LOWER)] {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let (mut ma, mut mb) = (0, 0);
        a_copy_graded(&a, c, "NM", None, 1);
        apply(&b, &since(&a, &mut ma)).unwrap();
        let _ = since(&b, &mut mb);
        a_copy_graded(&b, u, "LP", None, 2);

        a.execute(
            "UPDATE collection_entries SET quantity = quantity + 2, notes = 'played'
              WHERE sync_uid = ?1",
            [c],
        )
        .unwrap();
        grade_copy(&a, c, "LP");

        let rb = apply(&b, &since(&a, &mut ma)).unwrap();
        assert_eq!(unwritten(rb), (0, 0), "c is {c}");
        apply(&a, &since(&b, &mut mb)).unwrap();
        for (who, conn) in [("a", &a), ("b", &b)] {
            assert_eq!(qty(conn), (1, 5), "{who}, where c is {c}");
            assert_eq!(uids_of_copies(conn), vec![Some(LOWER.to_owned())], "{who}");
            assert_eq!(conditions(conn), ["LP"], "{who}");
        }
        let note: Option<String> = b
            .query_row("SELECT notes FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note.as_deref(), Some("played"), "b, where c is {c}");
    }
}

/// **A row the page itself places is never folded into, by an edit either.** Both hold two copies
/// of one printing, one near mint and one lightly played; `a` swaps the two conditions, by way of
/// a third. Each edit lands on the grain the other row is leaving, and the sender holds two rows.
///
/// **What makes it red**: folding onto whatever holds the grain the edit lands on, without asking
/// whether the page has its own say about that row.
#[test]
fn two_copies_the_sender_swapped_between_two_conditions_stay_two() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a_copy_graded(&a, LOWER, "NM", None, 1);
    a_copy_graded(&a, HIGHER, "LP", None, 2);
    apply(&b, &since(&a, &mut ma)).unwrap();

    grade_copy(&a, HIGHER, "MP");
    grade_copy(&a, LOWER, "LP");
    grade_copy(&a, HIGHER, "NM");

    apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(
        qty(&b),
        (2, 3),
        "b folded two copies its sender keeps apart"
    );
}

/// **A row the page deletes is not folded into by an edit, however the page's groups sort**:
/// [`a_copy_moved_to_where_the_page_deletes_a_copy_is_not_folded_into_it`], for an edit. Both hold
/// `c` near mint and `u` lightly played. `a` writes a note on `c`, deletes `u`, then regrades `c`
/// to lightly played: `c`'s group sorts first, by its oldest op, so its edit meets `u` still
/// there. It waits, `u`'s delete lands, and the retry writes `c` onto a free grain.
///
/// **What makes it red**: folding on any pass but a `Clear` one.
#[test]
fn a_copy_edited_to_where_the_page_deletes_a_copy_is_not_folded_into_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a_copy_graded(&a, HIGHER, "NM", None, 1);
    a_copy_graded(&a, LOWER, "LP", None, 2);
    apply(&b, &since(&a, &mut ma)).unwrap();

    a.execute(
        "UPDATE collection_entries SET notes = 'played' WHERE sync_uid = ?1",
        [HIGHER],
    )
    .unwrap();
    a.execute(
        "DELETE FROM collection_entries WHERE sync_uid = ?1",
        [LOWER],
    )
    .unwrap();
    grade_copy(&a, HIGHER, "LP");

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(unwritten(rb), (0, 0));
    for (who, conn) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(conn), (1, 1), "{who}");
        assert_eq!(uids_of_copies(conn), vec![Some(HIGHER.to_owned())], "{who}");
        assert_eq!(conditions(conn), ["LP"], "{who}");
    }
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// **A folder that is gone is not this fold's to answer** (issue #841). `b` has deleted the
/// binder `a`, not having heard, moves `c` into — and holds a root copy `u` on the grain `c`
/// lands on once it is written without that binder. Whether `c` belongs at the root at all is
/// the decision resting on `gone`, which a later page can still take back by bringing the binder
/// back; folded into `u` now, there would be no `c` left to put in it. So the refusal stands,
/// recorded, as it did before — with and without an edit of `c`'s condition riding in the group.
///
/// **What makes it red**: folding wherever the row lands, without asking whether the folder its
/// group names is a row here.
fn a_copy_sent_into_a_binder_deleted_here_is_not_folded_into_the_roots_copy(and_edited: bool) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    let from = binder(&a, "From", None);
    let thrown = binder(&a, "Thrown", None);
    a_copy_graded(&a, HIGHER, "NM", Some(from), 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("DELETE FROM collection_folders WHERE name = 'Thrown'", [])
        .unwrap();
    a_copy_graded(&b, LOWER, if and_edited { "LP" } else { "NM" }, None, 2);

    if and_edited {
        grade_copy(&a, HIGHER, "LP");
    }
    drag_copy(&a, HIGHER, Some(thrown));

    let page = since(&a, &mut ma);
    let rb = apply(&b, &page).unwrap();
    assert_eq!(unwritten(rb), (0, page.len()));
    assert_eq!(
        qty(&b),
        (2, 3),
        "b folded a copy whose binder may yet come back"
    );
    assert_eq!(skips(&b).len(), 1, "{:?}", skips(&b));
}

#[test]
fn a_copy_moved_into_a_binder_deleted_here_is_not_folded_into_the_roots_copy() {
    a_copy_sent_into_a_binder_deleted_here_is_not_folded_into_the_roots_copy(false);
}

#[test]
fn a_copy_edited_and_moved_into_a_binder_deleted_here_is_not_folded_into_the_roots_copy() {
    a_copy_sent_into_a_binder_deleted_here_is_not_folded_into_the_roots_copy(true);
}

/// **A delete this database refuses is skipped and recorded, never a stall.** A TEMP trigger
/// stands in for the first refusal nothing reaches today.
#[test]
fn a_folder_delete_this_database_refuses_is_dropped_and_the_page_applies() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    let bin = binder(&a, "Binder", None);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute_batch(
        "CREATE TEMP TRIGGER refuse BEFORE DELETE ON collection_folders
         BEGIN SELECT RAISE(ABORT, 'refused'); END;",
    )
    .unwrap();

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    add_copy(&a);
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 1), "{rb:?}");
    assert_eq!(folders(&b), 1, "the refused delete took the binder anyway");
    assert_eq!(qty(&b), (1, 1), "the rest of the page did not apply");
    assert_eq!(skips(&b).len(), 1, "{:?}", skips(&b));
}

/// **A copy removed and added again before the next pull ends at the re-added count** — the
/// case a page applied "deletes last" would get wrong (spec §3.4), pinned so nobody makes it.
#[test]
fn a_copy_removed_and_added_again_in_one_page_ends_at_the_new_count() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    add_copy(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();

    a.execute("DELETE FROM collection_entries", []).unwrap();
    add_copy(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(qty(&b), (1, 1));
    assert_eq!(uids_of_copies(&a), uids_of_copies(&b));
}

/// **Every cascade into a folder table is one [`super::rehome::doomed`] follows.** Walks the live
/// schema's `ON DELETE CASCADE` keys backwards from the two folder tables, so a new one — a
/// token folder's own key, say — fails here until `doomed` is taught it.
#[test]
fn every_cascade_into_a_folder_table_is_one_doomed_follows() {
    let conn = paired("dev-a");
    let mut reached: Vec<String> = vec!["collection_folders".into(), "wishlist_folders".into()];
    let mut edges: Vec<(String, String, String)> = Vec::new();
    let mut i = 0;
    while i < reached.len() {
        let child = reached[i].clone();
        let mut stmt = conn
            .prepare(
                "SELECT \"from\", \"table\" FROM pragma_foreign_key_list(?1)
                  WHERE on_delete = 'CASCADE'",
            )
            .unwrap();
        let keys: Vec<(String, String)> = stmt
            .query_map([&child], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for (col, parent) in keys {
            edges.push((child.clone(), col, parent.clone()));
            if !reached.contains(&parent) {
                reached.push(parent);
            }
        }
        i += 1;
    }
    edges.sort();
    let mut want: Vec<(String, String, String)> = super::rehome::CASCADES_INTO_FOLDERS
        .iter()
        .map(|(c, k, p)| ((*c).to_owned(), (*k).to_owned(), (*p).to_owned()))
        .collect();
    want.sort();
    assert_eq!(edges, want);
}
