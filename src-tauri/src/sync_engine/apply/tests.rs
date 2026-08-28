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

/// **Two devices typing "Ramp" end with one `deck_tags` row.** `idx_deck_tags_grain` is
/// `UNIQUE (name_key)`, so a second row is not a duplicate, it is a constraint failure at apply
/// time — and the tag is one app-wide list since schema v21, so it genuinely is one label.
#[test]
fn two_devices_typing_ramp_end_with_one_tag() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    for (c, name) in [(&a, "Ramp"), (&b, "ramp")] {
        c.execute(
            "INSERT INTO deck_tags (name, name_key, color, created_at, updated_at)
             VALUES (?1, 'ramp', '#0f0', unixepoch(), unixepoch())",
            [name],
        )
        .unwrap();
    }
    apply(&b, &outbox(&a)).unwrap();
    apply(&a, &outbox(&b)).unwrap();

    for (who, c) in [("a", &a), ("b", &b)] {
        let n: i64 = c
            .query_row("SELECT count(*) FROM deck_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "{who} has two rows for one label");
    }
    let (ua, ub): (String, String) = (
        a.query_row("SELECT sync_uid FROM deck_tags", [], |r| r.get(0))
            .unwrap(),
        b.query_row("SELECT sync_uid FROM deck_tags", [], |r| r.get(0))
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

/// **A stalled stream does not step over the op that stalled it**, and the ops *after* it in
/// the same batch are applied without moving the watermark past the block.
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
        "INSERT INTO deck_tags (name, name_key, color, created_at, updated_at)
         VALUES ('Ramp', 'ramp', '#0f0', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let rest = since(&a, &mut ma);

    // The deck stalls on a folder `b` has never heard of; the tag after it is fine.
    let report = apply(&b, &rest).unwrap();
    assert!(report.deferred > 0, "the deck should not have applied");
    let tags: i64 = b
        .query_row("SELECT count(*) FROM deck_tags", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tags, 1, "the tag is independent and should land");
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
    let decks: i64 = b
        .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(decks, 1);
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
        "INSERT INTO decks (name, format_key, folder_id, notes, created_at, updated_at)
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
    assert_eq!(report.deferred, 0, "nothing may be left behind");

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

/// Applying nothing is a no-op that still commits cleanly.
#[test]
fn an_empty_batch_does_nothing() {
    let b = paired("dev-b");
    let report = apply(&b, &[]).unwrap();
    assert_eq!(report, ApplyReport::default());
}
