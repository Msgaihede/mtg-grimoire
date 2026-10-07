//! Where the log is cut must not decide what a device ends on (issue #841).
//!
//! Every test here hands a receiver the same pushes two ways — **one answer** carrying all of
//! them, and **a pull for each** — and then lets the sender hear everything the receiver has to
//! say. The three must agree. Before the ledger of orphans (`apply::orphans`) they did not, on
//! any of the six shapes the first six tests are: a decision resting on `gone` was taken on the
//! first pull and never taken back when the second brought the parent back.
//!
//! The last section pins what is **not** closed here: with three devices, last-writer-wins and
//! add-wins still turn on arrival order (issue #842).

use super::*;

/// What a device holds, by name — and by uid, after ` as `, so that two devices agreeing on a
/// picture agree on what every row is called as well.
fn picture(conn: &Connection) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for (what, sql) in [
        (
            "copy",
            "SELECT e.card_id || ' x' || e.quantity || ' in ' || coalesce(f.name, '(root)')
                    || ' notes=' || coalesce(e.notes, '-') || ' as ' || coalesce(e.sync_uid, '?')
               FROM collection_entries e LEFT JOIN collection_folders f ON f.id = e.folder_id",
        ),
        (
            "binder",
            "SELECT f.name || ' in ' || coalesce(p.name, '(root)') || ' as ' || coalesce(f.sync_uid, '?')
               FROM collection_folders f LEFT JOIN collection_folders p ON p.id = f.parent_id
              WHERE f.kind = 'user'",
        ),
        (
            "deck folder",
            "SELECT f.name || ' in ' || coalesce(p.name, '(root)') || ' as ' || coalesce(f.sync_uid, '?')
               FROM deck_folders f LEFT JOIN deck_folders p ON p.id = f.parent_id",
        ),
        (
            "deck",
            "SELECT d.name || ' in ' || coalesce(f.name, '(root)') || ' as ' || coalesce(d.sync_uid, '?')
               FROM decks d LEFT JOIN deck_folders f ON f.id = d.folder_id",
        ),
        (
            "pile",
            "SELECT c.name || ' of ' || d.name || ' as ' || coalesce(c.sync_uid, '?')
               FROM deck_categories c JOIN decks d ON d.id = c.deck_id",
        ),
        (
            "card",
            "SELECT dc.name || ' x' || dc.quantity || ' in ' || d.name || '/' || c.name
                    || ' as ' || coalesce(dc.sync_uid, '?')
               FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
               JOIN deck_categories c ON c.id = dc.category_id",
        ),
    ] {
        let mut stmt = conn.prepare(sql).unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        lines.extend(rows.map(|row| format!("{what}: {}", row.unwrap())));
    }
    lines.sort();
    lines
}

/// A picture without its uids: what two *runs* of one scenario can be compared by, since each
/// run mints its own.
fn unnamed(picture: &[String]) -> Vec<String> {
    let mut lines: Vec<String> = picture
        .iter()
        .map(|line| line.split(" as ").next().unwrap().to_owned())
        .collect();
    lines.sort();
    lines
}

fn orphans_on(conn: &Connection) -> Vec<(String, String)> {
    let mut stmt = conn
        .prepare("SELECT tbl, state FROM sync_orphans ORDER BY tbl, uid")
        .unwrap();
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    rows.map(Result::unwrap).collect()
}

/// One scenario, built afresh for each way of cutting it: the sender, the receiver, and the
/// sender's pushes in the order it made them.
type Scenario = (Connection, Connection, Vec<Vec<Op>>);

/// What one way of cutting a scenario left.
struct Ended {
    sender: Vec<String>,
    receiver: Vec<String>,
    /// The receiver's `error_log`.
    skips: usize,
    /// The entries left in the receiver's ledger.
    orphans: usize,
}

/// Hand the receiver the sender's pushes — all in one answer, or a pull for each — then let the
/// sender hear the receiver. The sender's own ledger must be empty at the end: nothing in these
/// scenarios is decided there.
fn ended(build: &dyn Fn() -> Scenario, one_answer: bool) -> Ended {
    let (a, b, pushes) = build();
    if one_answer {
        let whole: Vec<Op> = pushes.iter().flatten().cloned().collect();
        apply(&b, &whole).unwrap();
    } else {
        for push in &pushes {
            apply(&b, push).unwrap();
        }
    }
    apply(&a, &outbox(&b)).unwrap();
    assert_eq!(orphans_on(&a), Vec::new(), "the sender holds an orphan");
    Ended {
        sender: picture(&a),
        receiver: picture(&b),
        skips: skips(&b).len(),
        orphans: orphans_on(&b).len(),
    }
}

/// The whole claim: cut either way, the receiver ends as the sender does, and the two cuts end
/// alike. Answers the page-by-page run, for a test that has more to say about it.
///
/// **And the ledger is empty at the end**: these scenarios end with every parent back, so an
/// entry left over is a decision nobody took back.
fn the_cut_decides_nothing(build: &dyn Fn() -> Scenario) -> Ended {
    let pieces = the_cut_decides_nothing_with(build, 0);
    assert_eq!(pieces.orphans, 0);
    pieces
}

/// [`the_cut_decides_nothing`], for a scenario in which a parent stays deleted: the receiver is
/// left holding `orphans` entries, cut either way.
fn the_cut_decides_nothing_with(build: &dyn Fn() -> Scenario, orphans: usize) -> Ended {
    let whole = ended(build, true);
    assert_eq!(whole.orphans, orphans, "one answer: the receiver's ledger");
    assert_eq!(
        whole.receiver, whole.sender,
        "the fixture: one answer does not end as the sender does"
    );
    let pieces = ended(build, false);
    assert_eq!(
        pieces.receiver, pieces.sender,
        "handed a pull for each push, the receiver does not end as the sender does"
    );
    assert_eq!(
        unnamed(&pieces.receiver),
        unnamed(&whole.receiver),
        "where the log was cut decided what the receiver holds"
    );
    assert_eq!(
        pieces.orphans, orphans,
        "a pull for each push: the receiver's ledger"
    );
    pieces
}

fn id_of(conn: &Connection, table: &str, name: &str) -> i64 {
    conn.query_row(
        &format!("SELECT id FROM {table} WHERE name = ?1"),
        [name],
        |r| r.get(0),
    )
    .unwrap()
}

/// Everything `conn` writes from here is stamped after what any other device has written so
/// far — which is what add-wins asks of the edit that brings a deleted parent back.
fn later(conn: &Connection) {
    conn.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
}

fn rename(conn: &Connection, table: &str, from: &str, to: &str) {
    conn.execute(
        &format!("UPDATE {table} SET name = ?2 WHERE name = ?1"),
        [from, to],
    )
    .unwrap();
}

/// `quantity` copies of the test printing in `folder`, under a uid said out loud — so a test
/// can put the two rows of a fold in either order.
fn copy_as(conn: &Connection, uid: &str, folder: Option<i64>, quantity: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
             created_at,updated_at,sync_uid)
         VALUES ('c1','lea','1','en','nonfoil','NM',?1,?2,unixepoch(),unixepoch(),?3)",
        rusqlite::params![quantity, folder, uid],
    )
    .unwrap();
}

/// `b` makes a binder `B`, `a` hears of it, and `b` deletes it; `a`'s clock then runs ahead.
/// `before` is what `b` does first, for a fixture that wants more on both devices.
fn a_binder_b_deleted(before: &dyn Fn(&Connection)) -> (Connection, Connection, i64) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let bin = binder(&b, "B", None);
    before(&b);
    apply(&a, &outbox(&b)).unwrap();
    crate::collection_folders::delete_folder(&b, bin).unwrap();
    later(&a);
    let on_a = id_of(&a, "collection_folders", "B");
    (a, b, on_a)
}

// ---------------------------------------------------------------------------------------
// The `SET NULL` arm: a row written without its parent
// ---------------------------------------------------------------------------------------

/// **A copy filed into a binder deleted here follows the binder back.** `a` files the copy and,
/// in a later push, renames the binder — after `b`'s delete, so add-wins brings it back.
///
/// Handed the copy alone, `b` writes it at the root, as the delete would have left it; handed the
/// rename on a later pull, it used to bring the binder back empty and leave the copy where it
/// was, with `a` holding it in the binder and nothing either would send to say so.
///
/// **What makes it red**: a `SET NULL` decision the ledger is not told of, or a sweep that does
/// not replay it — the copy at the root on `b` alone.
#[test]
fn a_copy_filed_into_a_deleted_binder_follows_it_back() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b, bin) = a_binder_b_deleted(&|_| {});
        let mut ma = 0;
        let _ = since(&a, &mut ma);
        file_copies(&a, Some(bin), 1);
        let filed = since(&a, &mut ma);
        rename(&a, "collection_folders", "B", "B2");
        let last = since(&a, &mut ma);
        (a, b, vec![filed, last])
    });
    assert!(
        unnamed(&pieces.receiver).contains(&"copy: c1 x1 in B2 notes=-".to_owned()),
        "{:#?}",
        pieces.receiver
    );
    assert_eq!(pieces.skips, 0);
}

/// **The ledger holds the decision exactly as long as the parent is gone.** The copy's pull
/// leaves one `Placed` entry; the rename's pull replays it and leaves none.
///
/// **What makes it red**: an entry written for a row whose parent is here, or one left behind
/// after its replay — which would move the copy back into the binder on every later pull,
/// whatever the reader had done with it since.
#[test]
fn the_ledger_holds_a_decision_only_while_the_parent_is_gone() {
    let (a, b, bin) = a_binder_b_deleted(&|_| {});
    let mut ma = 0;
    let _ = since(&a, &mut ma);
    file_copies(&a, Some(bin), 1);
    apply(&b, &since(&a, &mut ma)).unwrap();

    let held = orphans_on(&b);
    assert_eq!(held.len(), 1, "{held:?}");
    assert_eq!(held[0].0, "collection_entries");
    assert!(held[0].1.contains(r#""kind":"placed""#), "{held:?}");
    assert_eq!(copies_at_root(&b), 1);

    rename(&a, "collection_folders", "B", "B2");
    apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(orphans_on(&b), Vec::new());
    assert_eq!(copies_at_root(&b), 0);
}

/// **...and where the root already held that printing, the twin gives the copy back.** Written
/// without its binder, the copy lands on the root's grain and folds into `b`'s own root copy:
/// one row of two. When the binder returns, `a` holds one in the binder and one at the root, each
/// under its own uid — and so must `b`.
///
/// Both orders of the two uids: the fold keeps the lower, so in one the twin is renamed to the
/// incoming copy's uid and has to take its own name back.
///
/// **What makes it red**: replaying the placement alone — two copies carried into the binder, or
/// none; a twin left wearing the other's uid; a retired mark left on a uid that is a row again.
#[test]
fn a_copy_folded_onto_a_root_twin_is_given_back_when_its_binder_returns() {
    for (twin, filed) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b, bin) = a_binder_b_deleted(&|b| copy_as(b, twin, None, 1));
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            copy_as(&a, filed, Some(bin), 1);
            let first = since(&a, &mut ma);
            rename(&a, "collection_folders", "B", "B2");
            let last = since(&a, &mut ma);
            (a, b, vec![first, last])
        });
        assert_eq!(
            pieces
                .receiver
                .iter()
                .filter(|line| line.starts_with("copy: "))
                .collect::<Vec<_>>(),
            vec![
                &format!("copy: c1 x1 in (root) notes=- as {twin}"),
                &format!("copy: c1 x1 in B2 notes=- as {filed}"),
            ],
            "the twin is {twin}"
        );
        assert_eq!(pieces.skips, 0);
    }
}

/// **A copy the sender added to again while it was folded comes back with the whole count.** `a`
/// files the copy, adds a second to that row, and renames the binder — a push each. On `b` the
/// `+1` lands while the copy is inside the root twin, by either uid: where the twin kept its own
/// name the op used to find no row at all and was skipped.
///
/// **What makes it red**: an op for a folded row not laid over its entry — the binder's copy
/// comes back as one and the root keeps two; or one skipped as a row this database cannot build.
#[test]
fn a_folded_copy_added_to_before_its_binder_returns_comes_back_whole() {
    for (twin, filed) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b, bin) = a_binder_b_deleted(&|b| copy_as(b, twin, None, 1));
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            copy_as(&a, filed, Some(bin), 1);
            let first = since(&a, &mut ma);
            a.execute(
                "UPDATE collection_entries SET quantity = quantity + 1 WHERE sync_uid = ?1",
                [filed],
            )
            .unwrap();
            let second = since(&a, &mut ma);
            rename(&a, "collection_folders", "B", "B2");
            let last = since(&a, &mut ma);
            (a, b, vec![first, second, last])
        });
        assert!(
            pieces
                .receiver
                .contains(&format!("copy: c1 x2 in B2 notes=- as {filed}")),
            "the twin is {twin}: {:#?}",
            pieces.receiver
        );
        assert_eq!(pieces.skips, 0, "the twin is {twin}");
    }
}

/// **A copy both devices hold, moved into the deleted binder, follows it back too.** The move is
/// a sparse op — a parent and nothing else — so it is found by uid and written as an update.
///
/// **What makes it red**: the ledger told only of rows the decision built.
#[test]
fn a_held_copy_moved_into_a_deleted_binder_follows_it_back() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b, bin) = a_binder_b_deleted(&|b| {
            let other = binder(b, "Other", None);
            file_copies(b, Some(other), 1);
        });
        let mut ma = 0;
        let _ = since(&a, &mut ma);
        a.execute("UPDATE collection_entries SET folder_id = ?1", [bin])
            .unwrap();
        let moved = since(&a, &mut ma);
        rename(&a, "collection_folders", "B", "B2");
        let last = since(&a, &mut ma);
        (a, b, vec![moved, last])
    });
    assert_eq!(pieces.skips, 0);
}

/// **A move this device made since wins over the replay, as it would have over the op.** `b`
/// writes the copy at the root, and its reader then files it in a binder of their own; the
/// rename's pull brings `B` back and leaves the copy where the reader put it — and `a` puts it
/// there too, on hearing of the move.
///
/// **What makes it red**: a replay that writes the column whatever this device did since — the
/// copy pulled out of `Mine` into `B2` on `b`, and into `Mine` on `a`.
#[test]
fn a_copy_this_device_moved_since_stays_where_it_was_put() {
    let (a, b, bin) = a_binder_b_deleted(&|_| {});
    let (mut ma, mut mb) = (0, 0);
    let _ = since(&a, &mut ma);
    let _ = since(&b, &mut mb);
    file_copies(&a, Some(bin), 1);
    apply(&b, &since(&a, &mut ma)).unwrap();

    let mine = binder(&b, "Mine", None);
    b.execute("UPDATE collection_entries SET folder_id = ?1", [mine])
        .unwrap();
    rename(&a, "collection_folders", "B", "B2");
    apply(&b, &since(&a, &mut ma)).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();

    for (who, conn) in [("a", &a), ("b", &b)] {
        let picture = unnamed(&picture(conn));
        assert!(
            picture.contains(&"copy: c1 x1 in Mine notes=-".to_owned())
                && picture.contains(&"binder: B2 in (root)".to_owned()),
            "{who}: {picture:#?}"
        );
    }
    assert_eq!(orphans_on(&b), Vec::new());
}

/// **A copy the sender deleted again is nobody's orphan.** `a` files the copy, deletes it, and
/// renames the binder — a push each. Nothing comes back with the binder, and where the copy had
/// folded into a root twin the twin is itself again when the delete arrives.
///
/// **What makes it red**: a delete that leaves the entry — the binder's return builds a copy
/// its own device deleted; or, folded, a delete that takes the twin with it.
#[test]
fn a_copy_its_own_device_deleted_does_not_come_back_with_the_binder() {
    for twin in [None, Some("u-1"), Some("u-3")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b, bin) = a_binder_b_deleted(&|b| {
                if let Some(twin) = twin {
                    copy_as(b, twin, None, 1);
                }
            });
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            copy_as(&a, "u-2", Some(bin), 1);
            let first = since(&a, &mut ma);
            a.execute("DELETE FROM collection_entries WHERE sync_uid = 'u-2'", [])
                .unwrap();
            let second = since(&a, &mut ma);
            rename(&a, "collection_folders", "B", "B2");
            let last = since(&a, &mut ma);
            (a, b, vec![first, second, last])
        });
        let copies: Vec<String> = unnamed(&pieces.receiver)
            .into_iter()
            .filter(|line| line.starts_with("copy: "))
            .collect();
        let want: Vec<String> = twin
            .map(|_| "copy: c1 x1 in (root) notes=-".to_owned())
            .into_iter()
            .collect();
        assert_eq!(copies, want, "the twin is {twin:?}");
    }
}

/// **A deck filed into a deleted deck folder follows the folder back** — the same arm on a table
/// with no grain, so nothing can fold and the entry is always a placement.
///
/// **What makes it red**: a ledger that knows the collection's tables by name.
#[test]
fn a_deck_filed_into_a_deleted_deck_folder_follows_it_back() {
    the_cut_decides_nothing(&|| {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        b.execute(
            "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
             VALUES ('F', 0, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        apply(&a, &outbox(&b)).unwrap();
        b.execute("DELETE FROM deck_folders", []).unwrap();
        later(&a);
        let mut ma = 0;
        let _ = since(&a, &mut ma);
        a.execute(
            "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
             VALUES ('D', 'commander', (SELECT id FROM deck_folders), unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let filed = since(&a, &mut ma);
        rename(&a, "deck_folders", "F", "F2");
        let last = since(&a, &mut ma);
        (a, b, vec![filed, last])
    });
}

// ---------------------------------------------------------------------------------------
// The cascading arm: a row consumed, or deleted
// ---------------------------------------------------------------------------------------

/// **A folder this device holds, moved under a parent deleted here, comes back whole.** `X`
/// holds `Inner`, which holds a copy; `a` moves `X` under `P` and, in a later push, renames `P`.
///
/// Handed the move alone, `b` does to `X` what the delete's cascade would have: `X` and `Inner`
/// go, and the copy is filed at the root. It used to end there — two folders and their
/// arrangement gone from one device for good, with `a` holding all of it under `P`.
///
/// **What makes it red**: a moot delete that is not written down first; a sub-tree not walked;
/// a re-homed copy whose folder is not remembered.
#[test]
fn a_held_folder_moved_under_a_deleted_parent_comes_back_whole() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let p = binder(&b, "P", None);
        let x = binder(&b, "X", None);
        let inner = binder(&b, "Inner", Some(x));
        file_copies(&b, Some(inner), 1);
        apply(&a, &outbox(&b)).unwrap();
        crate::collection_folders::delete_folder(&b, p).unwrap();
        later(&a);
        let mut ma = 0;
        let _ = since(&a, &mut ma);
        let (p, x) = (
            id_of(&a, "collection_folders", "P"),
            id_of(&a, "collection_folders", "X"),
        );
        crate::collection_folders::move_folder(&a, x, Some(p)).unwrap();
        let moved = since(&a, &mut ma);
        rename(&a, "collection_folders", "P", "P2");
        let last = since(&a, &mut ma);
        (a, b, vec![moved, last])
    });
    let held = unnamed(&pieces.receiver);
    for line in [
        "binder: X in P2",
        "binder: Inner in X",
        "copy: c1 x1 in Inner notes=-",
    ] {
        assert!(held.contains(&line.to_owned()), "{held:#?}");
    }
    assert_eq!(pieces.skips, 0);
}

/// **...and a copy its re-homing folded onto a root twin is given back.** As above, with a root
/// copy of the same printing on both devices: filed at the root when `X` goes, the folder's copy
/// folds into it. Both orders of the two uids.
///
/// **What makes it red**: the moot arm's re-homing done by `rehome` whole, which says nothing of
/// which rows it folded.
#[test]
fn a_copy_refiled_onto_a_root_twin_by_a_moot_delete_is_given_back() {
    for (twin, filed) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b) = (paired("dev-a"), paired("dev-b"));
            let p = binder(&b, "P", None);
            let x = binder(&b, "X", None);
            copy_as(&b, filed, Some(x), 2);
            copy_as(&b, twin, None, 1);
            apply(&a, &outbox(&b)).unwrap();
            crate::collection_folders::delete_folder(&b, p).unwrap();
            later(&a);
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            let (p, x) = (
                id_of(&a, "collection_folders", "P"),
                id_of(&a, "collection_folders", "X"),
            );
            crate::collection_folders::move_folder(&a, x, Some(p)).unwrap();
            let moved = since(&a, &mut ma);
            rename(&a, "collection_folders", "P", "P2");
            let last = since(&a, &mut ma);
            (a, b, vec![moved, last])
        });
        assert_eq!(
            pieces
                .receiver
                .iter()
                .filter(|line| line.starts_with("copy: "))
                .collect::<Vec<_>>(),
            vec![
                &format!("copy: c1 x1 in (root) notes=- as {twin}"),
                &format!("copy: c1 x2 in X notes=- as {filed}"),
            ],
            "the twin is {twin}"
        );
    }
}

/// **A folder made under a parent deleted here is built when the parent returns, and the copy
/// filed in it goes with it.** `b` never held `Z`: its group was consumed, and the copy after it
/// was written at the root, each on the pull that brought it.
///
/// A pull for each of the three pushes, so the copy's decision rests on a folder that is itself
/// only an entry — and comes back second, when the sweep has built `Z`.
///
/// **What makes it red**: a consumed group that leaves nothing; a sweep that takes one step and
/// stops, leaving the copy at the root beside the folder it belongs in.
#[test]
fn a_folder_made_under_a_deleted_parent_is_built_when_the_parent_returns() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let p = binder(&b, "P", None);
        apply(&a, &outbox(&b)).unwrap();
        crate::collection_folders::delete_folder(&b, p).unwrap();
        later(&a);
        let mut ma = 0;
        let _ = since(&a, &mut ma);
        let z = binder(&a, "Z", Some(id_of(&a, "collection_folders", "P")));
        let made = since(&a, &mut ma);
        file_copies(&a, Some(z), 1);
        let filed = since(&a, &mut ma);
        rename(&a, "collection_folders", "P", "P2");
        let last = since(&a, &mut ma);
        (a, b, vec![made, filed, last])
    });
    let held = unnamed(&pieces.receiver);
    for line in ["binder: Z in P2", "copy: c1 x1 in Z notes=-"] {
        assert!(held.contains(&line.to_owned()), "{held:#?}");
    }
    assert_eq!(pieces.skips, 0);
}

/// **A folder renamed while it was only an entry comes back under its new name.** `a` moves `X`
/// under the deleted `P`, renames `X`, and renames `P` — a push each. The rename of `X` reaches
/// `b` when `X` is not a row there: it used to be skipped as a row this database cannot build,
/// with an `error_log` row for a reader who had done nothing wrong.
///
/// **What makes it red**: an op for an absent orphan not laid over its entry — `X` back under
/// its old name, and a skip recorded.
#[test]
fn a_folder_renamed_while_it_was_an_orphan_comes_back_renamed() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let p = binder(&b, "P", None);
        binder(&b, "X", None);
        apply(&a, &outbox(&b)).unwrap();
        crate::collection_folders::delete_folder(&b, p).unwrap();
        later(&a);
        let mut ma = 0;
        let _ = since(&a, &mut ma);
        let (p, x) = (
            id_of(&a, "collection_folders", "P"),
            id_of(&a, "collection_folders", "X"),
        );
        crate::collection_folders::move_folder(&a, x, Some(p)).unwrap();
        let moved = since(&a, &mut ma);
        rename(&a, "collection_folders", "X", "X2");
        let renamed = since(&a, &mut ma);
        rename(&a, "collection_folders", "P", "P2");
        let last = since(&a, &mut ma);
        (a, b, vec![moved, renamed, last])
    });
    assert!(
        unnamed(&pieces.receiver).contains(&"binder: X2 in P2".to_owned()),
        "{:#?}",
        pieces.receiver
    );
    assert_eq!(pieces.skips, 0);
}

/// **A folder moved out from under the deleted parent again is built where it was moved to**,
/// with no parent returning at all: `a` moves `X` under `P`, then back to the root. The second
/// move is a sparse op for a row `b` deleted on the first.
///
/// **What makes it red**: an entry only the sweep can end — `X` gone from `b` for good, and the
/// move skipped.
#[test]
fn a_folder_moved_out_from_under_the_deleted_parent_is_built_there() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let p = binder(&b, "P", None);
    binder(&b, "X", None);
    apply(&a, &outbox(&b)).unwrap();
    crate::collection_folders::delete_folder(&b, p).unwrap();
    later(&a);
    let (mut ma, mut mb) = (0, 0);
    let _ = since(&a, &mut ma);
    let (p, x) = (
        id_of(&a, "collection_folders", "P"),
        id_of(&a, "collection_folders", "X"),
    );
    crate::collection_folders::move_folder(&a, x, Some(p)).unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(folders(&b), 0, "the fixture: X went with the move");

    crate::collection_folders::move_folder(&a, x, None).unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();

    for (who, conn) in [("a", &a), ("b", &b)] {
        assert_eq!(
            unnamed(&picture(conn)),
            vec!["binder: X in (root)".to_owned()],
            "{who}"
        );
    }
    assert_eq!(orphans_on(&b), Vec::new());
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// **A card moved into a pile deleted here comes back with the pile.** The moot arm deletes the
/// card, as the pile's delete would have; the pile's rename, on a later pull, used to bring the
/// pile back without it.
///
/// **What makes it red**: a ledger that buries folders only — the card gone from `b` alone.
#[test]
fn a_card_moved_into_a_deleted_pile_comes_back_with_it() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let (mut ma, mut mb) = (0, 0);
        a_deck_with_three_piles(&b, &a, &mut mb, &mut ma);
        b.execute("DELETE FROM deck_categories WHERE name = 'Side'", [])
            .unwrap();
        later(&a);
        move_the_card(&a, "Side");
        let moved = since(&a, &mut ma);
        rename(&a, "deck_categories", "Side", "Side2");
        let last = since(&a, &mut ma);
        (a, b, vec![moved, last])
    });
    assert!(
        unnamed(&pieces.receiver).contains(&"card: Bolt x1 in A/Side2".to_owned()),
        "{:#?}",
        pieces.receiver
    );
    assert_eq!(pieces.skips, 0);
}

// ---------------------------------------------------------------------------------------
// What is not closed here: three devices (issue #842)
// ---------------------------------------------------------------------------------------

/// Three devices and one copy all three hold, in `F1`. `a` and `c` each write it, `c` with the
/// later stamp; `b` hears the two writes in `order`, and `a` and `c` hear each other's. Answers
/// what `(a, b, c)` hold.
fn three_devices(
    order: &str,
    write_a: &dyn Fn(&Connection),
    write_c: &dyn Fn(&Connection),
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    let f1 = binder(&a, "F1", None);
    binder(&a, "F2", None);
    file_copies(&a, Some(f1), 1);
    let made = since(&a, &mut ma);
    apply(&b, &made).unwrap();
    apply(&c, &made).unwrap();

    write_a(&a);
    let from_a = since(&a, &mut ma);
    later(&c);
    write_c(&c);
    let from_c = since(&c, &mut mc);
    match order {
        "one answer" => {
            let both: Vec<Op> = from_a.iter().chain(from_c.iter()).cloned().collect();
            apply(&b, &both).unwrap();
        }
        "older first" => {
            apply(&b, &from_a).unwrap();
            apply(&b, &from_c).unwrap();
        }
        _ => {
            apply(&b, &from_c).unwrap();
            apply(&b, &from_a).unwrap();
        }
    }
    apply(&a, &from_c).unwrap();
    apply(&c, &from_a).unwrap();
    (picture(&a), picture(&b), picture(&c))
}

fn the_copy(picture: &[String]) -> String {
    unnamed(picture)
        .into_iter()
        .find(|line| line.starts_with("copy: "))
        .unwrap_or_else(|| "no copy".to_owned())
}

/// ⚠ **Two other devices edit one field, and the device that wrote neither keeps whichever it
/// heard last** — issue #842, pinned so that whoever closes it meets this test.
///
/// `apply` folds what it is handed with this device's *own* log, and keeps no stamp for anything
/// another device wrote. So `a`'s older edit, arriving on a pull after `c`'s newer one, has
/// nothing to lose to on `b` — while `a` and `c`, each holding its own edit in its own log, both
/// settle on `c`'s. The relay hands rows over in the order they were pushed, not in clock order:
/// `a` only has to have been offline when it wrote.
///
/// **What makes it red**: the day `apply` remembers the stamp that won a field — the last
/// assertion says the difference is still there, and goes with it.
#[test]
fn an_older_edit_from_a_third_device_still_beats_a_newer_one_applied_before_it() {
    let edit = |who: &'static str| {
        move |conn: &Connection| {
            conn.execute("UPDATE collection_entries SET notes = ?1", [who])
                .unwrap();
        }
    };
    for order in ["one answer", "older first"] {
        let (a, b, c) = three_devices(order, &edit("older"), &edit("newer"));
        assert_eq!((&b, &c), (&a, &a), "{order}");
        assert_eq!(the_copy(&b), "copy: c1 x1 in F1 notes=newer", "{order}");
    }
    let (a, b, c) = three_devices("newer first", &edit("older"), &edit("newer"));
    assert_eq!(a, c);
    assert_eq!(the_copy(&a), "copy: c1 x1 in F1 notes=newer");
    assert_eq!(
        the_copy(&b),
        "copy: c1 x1 in F1 notes=older",
        "the device that wrote neither edit ended on the newer one: issue #842 is closed, and \
         this assertion with it"
    );
}

/// ⚠ **...and the same of a placement**: `a` moves the copy to the root, `c` later into `F2`,
/// and `b`, hearing `c` first, leaves it at the root. Issue #842.
#[test]
fn an_older_move_from_a_third_device_still_beats_a_newer_one_applied_before_it() {
    let to_the_root = |conn: &Connection| {
        conn.execute("UPDATE collection_entries SET folder_id = NULL", [])
            .unwrap();
    };
    let into_f2 = |conn: &Connection| {
        conn.execute(
            "UPDATE collection_entries
                SET folder_id = (SELECT id FROM collection_folders WHERE name = 'F2')",
            [],
        )
        .unwrap();
    };
    for order in ["one answer", "older first"] {
        let (a, b, c) = three_devices(order, &to_the_root, &into_f2);
        assert_eq!((&b, &c), (&a, &a), "{order}");
        assert_eq!(the_copy(&b), "copy: c1 x1 in F2 notes=-", "{order}");
    }
    let (a, b, c) = three_devices("newer first", &to_the_root, &into_f2);
    assert_eq!(a, c);
    assert_eq!(the_copy(&a), "copy: c1 x1 in F2 notes=-");
    assert_eq!(
        the_copy(&b),
        "copy: c1 x1 in (root) notes=-",
        "the device that made neither move ended on the newer one: issue #842 is closed, and \
         this assertion with it"
    );
}

/// ⚠ **...and of add-wins**: `a` deletes the copy and `c` edits it later, so the row survives —
/// on `a` and `c`, and on `b` only where both arrive in one answer. Heard apart, in either
/// order, `b` loses it: the delete first, and the sparse edit cannot rebuild the row (skipped,
/// with an `error_log` row); the edit first, and the older delete finds nothing on `b` to lose
/// to. sync.md's *Add-wins needs this device's own history* records the first of the two.
/// Issue #842.
#[test]
fn a_row_one_device_deleted_and_another_edited_later_is_still_lost_on_a_third() {
    let delete = |conn: &Connection| {
        conn.execute("DELETE FROM collection_entries", []).unwrap();
    };
    let edit = |conn: &Connection| {
        conn.execute("UPDATE collection_entries SET notes = 'kept'", [])
            .unwrap();
    };
    let (a, b, c) = three_devices("one answer", &delete, &edit);
    assert_eq!((&b, &c), (&a, &a));
    assert_eq!(the_copy(&b), "copy: c1 x1 in F1 notes=kept");

    for order in ["older first", "newer first"] {
        let (a, b, c) = three_devices(order, &delete, &edit);
        assert_eq!(a, c, "{order}");
        assert_eq!(the_copy(&a), "copy: c1 x1 in F1 notes=kept", "{order}");
        assert_eq!(
            the_copy(&b),
            "no copy",
            "{order}: the device that wrote neither kept the row: issue #842 is closed, and \
             this assertion with it"
        );
    }
}

mod found;
