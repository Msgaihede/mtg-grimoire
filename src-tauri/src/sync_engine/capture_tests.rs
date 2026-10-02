//! **The three of `capture`'s tests that name a module still in this crate** — the launch
//! (`schema::prepare_database`) and `reconcile`. `capture` itself is `grimoire-core`'s; these
//! are here unedited, and go back to it when `reconcile` and the launch passes move (the
//! extraction's step 4).

use grimoire_core::sync_engine::capture::fixtures::*;
/// ⚠ **...but no `Drop` runs through a kill, and a launch is what clears what one left.** The
/// guard's row is written as its own statement before the work it guards, so power loss or
/// *End task* inside a [`suppressed`] window leaves it on disk, and every capture trigger
/// reads it. A reader with no deck at all had nothing at launch that happened to clear it —
/// `managed_wishlist::settle_all`'s per-deck window was the only thing that ever did — so
/// their edits after the relaunch reached no other device until some later apply lifted it.
///
/// **What makes it red**: `prepare_database` not clearing the row — the first assertion
/// fails, and the edit below it records no op.
#[test]
fn a_launch_clears_an_apply_guard_a_kill_left_behind() {
    let conn = db();
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('applying', '1')",
        [],
    )
    .unwrap();
    let decks: i64 = conn
        .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        decks, 0,
        "a deck would clear it by accident and prove nothing"
    );

    crate::schema::prepare_database(&conn).unwrap();

    let stuck: i64 = conn
        .query_row(
            "SELECT count(*) FROM sync_state WHERE key = 'applying'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stuck, 0, "the applying row outlived the relaunch");
    conn.execute("DELETE FROM sync_ops", []).unwrap();
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',1,unixepoch(),unixepoch())",
        [],
    )
    .unwrap();
    assert!(
        ops(&conn)
            .iter()
            .any(|(tbl, kind, ..)| tbl == "collection_entries" && kind == "put"),
        "an ordinary edit after the relaunch was not captured: {:?}",
        ops(&conn)
    );
}

/// **The reconciler's fold records nothing, and a counter is why.**
///
/// `card_migrations` is on the user side and is deliberately not synced, so every device
/// applies Scryfall's log against its own rows after its own ingest. If the fold were
/// captured, both devices would do it **and** then receive the other's — and
/// `fold_into_existing` sums the source row into the survivor, which is a counter delta.
/// A counter delta applied twice is a quantity that has doubled itself.
#[test]
fn a_reconcile_fold_records_no_ops_and_still_folds() {
    let conn = db();
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES ('old','lea','1','en','nonfoil','NM',3,unixepoch(),unixepoch()),
                ('new','lea','2','en','nonfoil','NM',2,unixepoch(),unixepoch())",
        [],
    )
    .unwrap();
    conn.execute("DELETE FROM sync_ops", []).unwrap();

    let mut conn = conn;
    let stats = crate::reconcile::apply(
        &mut conn,
        &[crate::scryfall::Migration {
            id: "m1".into(),
            performed_at: Some("2026-07-01T00:00:00Z".into()),
            strategy: "merge".into(),
            old_card_id: "old".into(),
            new_card_id: Some("new".into()),
            note: None,
        }],
    )
    .unwrap();

    // The fold really happened — otherwise this test would pass by doing nothing.
    assert_eq!(stats.folded, 1, "{stats:?}");
    let (rows, quantity): (i64, i64) = conn
        .query_row(
            "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((rows, quantity), (1, 5));
    // ...and said nothing about it.
    assert!(
        ops(&conn).is_empty(),
        "a derived fold must not travel: {:?}",
        ops(&conn)
    );
    // The guard lifted, so the reader's next edit does travel.
    conn.execute("UPDATE collection_entries SET notes = 'mine'", [])
        .unwrap();
    assert_eq!(ops(&conn).len(), 1);
}

/// ...and neither does the orphan sweep. Whether a printing is in *this* device's card
/// database is a fact about this device, and two machines that synced on different days
/// can honestly disagree.
#[test]
fn an_orphan_sweep_records_no_ops() {
    let conn = db();
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES ('gone','lea','1','en','nonfoil','NM',1,unixepoch(),unixepoch())",
        [],
    )
    .unwrap();
    conn.execute("DELETE FROM sync_ops", []).unwrap();

    let (flagged, _) = crate::reconcile::sweep_orphans(&conn).unwrap();
    assert_eq!(flagged, 1, "the sweep must have found something to flag");
    assert!(ops(&conn).is_empty());
}
