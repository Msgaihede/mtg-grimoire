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
        "INSERT INTO deck_tags (name, name_key, color, created_at, updated_at)
         VALUES ('Ramp', 'ramp', '#0f0', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let rest = since(&a, &mut ma);

    // The deck stalls on a folder `b` has never heard of, and the tag behind it waits its turn
    // even though nothing about the tag is unresolvable.
    let report = apply(&b, &rest).unwrap();
    assert!(report.deferred > 0, "the deck should not have applied");
    let tags: i64 = b
        .query_row("SELECT count(*) FROM deck_tags", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        tags, 0,
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
    let (decks, tags): (i64, i64) = b
        .query_row(
            "SELECT (SELECT count(*) FROM decks), (SELECT count(*) FROM deck_tags)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((decks, tags), (1, 1), "the whole stream lands once it can");
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
    for c in [&a, &b] {
        c.execute(
            "INSERT INTO device_names (device_id, name, created_at, updated_at)
             VALUES ('dev-c', 'This device', 0, 0)",
            [],
        )
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
    assert_eq!(report.deferred, 0);
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
        report.deferred, 0,
        "a folder rebuild must not stall the stream"
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
    // **Deferred is the shape of the failure this grain prevents**, not a crash: without it the
    // insert hits `idx_collection_folder_deck`, the savepoint rolls back, and each device
    // quietly keeps its own group forever while the counts still read 1.
    assert_eq!((ra.deferred, rb.deferred), (0, 0));

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
            // `DECK_CATEGORY_GRAIN`.
            "deck_categories.idx_deck_categories_grain",
            // Partial: one Sideboard, Commander, Companion and Maybeboard per deck.
            "deck_categories.idx_deck_categories_kind",
            // `DECK_TAG_GRAIN` — one app-wide list since v21.
            "deck_tags.idx_deck_tags_grain",
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
            // `WISHLIST_GRAIN`, four terms since v23.
            "wishlist_entries.idx_wishlist_grain",
        ]
        .map(str::to_owned),
        "a UNIQUE index on a synced table with no grain is two devices keeping separate rows, \
         silently and forever"
    );
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
