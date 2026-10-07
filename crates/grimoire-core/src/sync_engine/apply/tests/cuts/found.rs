//! What the independent review of the ledger found, each by experiment (2026-10-07).
//!
//! The six shapes in the parent module held, and their neighbours did not: every one of these
//! was a two-device divergence — or, the last, a crash — with the ledger as first built, and
//! almost all of them are about a fold, which is two rows in one.

use super::*;

/// [`copy_as`], with a note — a field the twin of a fold does not share.
fn noted_copy_as(conn: &Connection, uid: &str, folder: Option<i64>, notes: &str) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,notes,
             created_at,updated_at,sync_uid)
         VALUES ('c1','lea','1','en','nonfoil','NM',1,?1,?2,unixepoch(),unixepoch(),?3)",
        rusqlite::params![folder, notes, uid],
    )
    .unwrap();
}

fn add_one(conn: &Connection, uid: &str) {
    conn.execute(
        "UPDATE collection_entries SET quantity = quantity + 1 WHERE sync_uid = ?1",
        [uid],
    )
    .unwrap();
}

fn move_copy(conn: &Connection, uid: &str, folder: Option<i64>) {
    conn.execute(
        "UPDATE collection_entries SET folder_id = ?2 WHERE sync_uid = ?1",
        rusqlite::params![uid, folder],
    )
    .unwrap();
}

fn copies(picture: &[String]) -> Vec<String> {
    picture
        .iter()
        .filter(|line| line.starts_with("copy: "))
        .cloned()
        .collect()
}

const THREE_UIDS: [[&str; 3]; 6] = [
    ["u-1", "u-2", "u-3"],
    ["u-1", "u-3", "u-2"],
    ["u-2", "u-1", "u-3"],
    ["u-2", "u-3", "u-1"],
    ["u-3", "u-1", "u-2"],
    ["u-3", "u-2", "u-1"],
];

/// **What happens to the twin while a copy is folded into it is the twin's.** `a` files the
/// copy, adds one to the *twin*, adds one to the filed copy, and renames the binder — a push
/// each. The fold is undone by what the copy's own ops added to the twin, measured write by
/// write.
///
/// **What makes it red**: reading the twin whole when the fold is undone — everything that
/// happened to it since counted as the orphan's share, and the root left a copy short.
#[test]
fn what_happens_to_a_twin_while_a_copy_is_folded_into_it_stays_with_the_twin() {
    for (twin, filed) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b, bin) = a_binder_b_deleted(&|b| copy_as(b, twin, None, 1));
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            copy_as(&a, filed, Some(bin), 1);
            let first = since(&a, &mut ma);
            add_one(&a, twin);
            let second = since(&a, &mut ma);
            add_one(&a, filed);
            let third = since(&a, &mut ma);
            rename(&a, "collection_folders", "B", "B2");
            let last = since(&a, &mut ma);
            (a, b, vec![first, second, third, last])
        });
        assert_eq!(
            copies(&pieces.receiver),
            vec![
                format!("copy: c1 x2 in (root) notes=- as {twin}"),
                format!("copy: c1 x2 in B2 notes=- as {filed}"),
            ],
            "the twin is {twin}"
        );
        assert_eq!(pieces.skips, 0, "the twin is {twin}");
    }
}

/// **...and what this device's reader does to it goes with the row whose name it went out
/// under.** `b`'s reader adds three to the merged row, and `a`'s `+1` to the filed copy arrives
/// after. Where the merged row wears the twin's own uid the three go out under it, `a` adds them
/// to its root copy, and they stay at the root here. Where the fold renamed the twin to the filed
/// copy's lower uid they go out under *that*, `a` adds them to the binder's copy — it folded
/// nothing — and so they leave with the copy here, when the binder returns: this device's own
/// log says how much its reader added since the fold.
///
/// **What makes it red**: a fold undone without asking this device's own log — root four and
/// binder two here, root one and binder five on `a` (the review, measured).
#[test]
fn what_this_devices_reader_adds_to_a_folded_row_goes_with_the_name_it_went_out_under() {
    for (twin, filed, want) in [
        (
            "u-1",
            "u-2",
            [
                "copy: c1 x2 in B2 notes=- as u-2",
                "copy: c1 x4 in (root) notes=- as u-1",
            ],
        ),
        (
            "u-2",
            "u-1",
            [
                "copy: c1 x1 in (root) notes=- as u-2",
                "copy: c1 x5 in B2 notes=- as u-1",
            ],
        ),
    ] {
        let (a, b, bin) = a_binder_b_deleted(&|b| copy_as(b, twin, None, 1));
        let (mut ma, mut mb) = (0, 0);
        let _ = since(&a, &mut ma);
        let _ = since(&b, &mut mb);
        copy_as(&a, filed, Some(bin), 1);
        apply(&b, &since(&a, &mut ma)).unwrap();
        b.execute("UPDATE collection_entries SET quantity = quantity + 3", [])
            .unwrap();
        add_one(&a, filed);
        apply(&b, &since(&a, &mut ma)).unwrap();
        rename(&a, "collection_folders", "B", "B2");
        apply(&b, &since(&a, &mut ma)).unwrap();
        apply(&a, &since(&b, &mut mb)).unwrap();

        for (who, conn) in [("a", &a), ("b", &b)] {
            assert_eq!(copies(&picture(conn)), want, "{who}, the twin is {twin}");
        }
    }
}

/// **A note the filed copy carries leaves the twin with it.** The fold writes the copy's fields
/// onto the twin wherever the copy's op won them; undone, the twin reads as it did.
///
/// **What makes it red**: a fold undone by its count alone — the twin keeps a note that is the
/// binder copy's on the sender.
#[test]
fn a_note_the_folded_copy_carried_leaves_the_twin_with_it() {
    for (twin, filed) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b, bin) = a_binder_b_deleted(&|b| copy_as(b, twin, None, 1));
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            noted_copy_as(&a, filed, Some(bin), "signed");
            let first = since(&a, &mut ma);
            rename(&a, "collection_folders", "B", "B2");
            let last = since(&a, &mut ma);
            (a, b, vec![first, last])
        });
        assert_eq!(
            copies(&pieces.receiver),
            vec![
                format!("copy: c1 x1 in (root) notes=- as {twin}"),
                format!("copy: c1 x1 in B2 notes=signed as {filed}"),
            ],
            "the twin is {twin}"
        );
    }
}

/// **Two copies folded onto one twin come back each to its own binder, whichever returns
/// first.** `a` files one copy into each of two binders deleted on `b`, where the root holds
/// that printing; each folds into the root's row, and the row is renamed whenever a lower uid
/// arrives. Every order of the three uids, and both orders of return.
///
/// **What makes it red**: an entry that finds its twin by the name it wore when the fold was
/// made — the second fold renames the row, and the first then takes its share out of whatever
/// wears the old name, or out of nothing; a twin handed back a name a restored copy is wearing.
#[test]
fn two_copies_folded_onto_one_twin_each_return_to_their_own_binder() {
    for [twin, first, second] in THREE_UIDS {
        for back in [["B1", "B2"], ["B2", "B1"]] {
            let pieces = the_cut_decides_nothing(&|| {
                let (a, b) = (paired("dev-a"), paired("dev-b"));
                let b1 = binder(&b, "B1", None);
                let b2 = binder(&b, "B2", None);
                copy_as(&b, twin, None, 1);
                apply(&a, &outbox(&b)).unwrap();
                crate::collection_folders::delete_folder(&b, b1).unwrap();
                crate::collection_folders::delete_folder(&b, b2).unwrap();
                later(&a);
                let mut ma = 0;
                let _ = since(&a, &mut ma);
                let mut pushes = Vec::new();
                copy_as(&a, first, Some(id_of(&a, "collection_folders", "B1")), 1);
                pushes.push(since(&a, &mut ma));
                copy_as(&a, second, Some(id_of(&a, "collection_folders", "B2")), 1);
                pushes.push(since(&a, &mut ma));
                for name in back {
                    rename(&a, "collection_folders", name, &format!("{name}x"));
                    pushes.push(since(&a, &mut ma));
                }
                (a, b, pushes)
            });
            let mut want = vec![
                format!("copy: c1 x1 in (root) notes=- as {twin}"),
                format!("copy: c1 x1 in B1x notes=- as {first}"),
                format!("copy: c1 x1 in B2x notes=- as {second}"),
            ];
            want.sort();
            assert_eq!(
                copies(&pieces.receiver),
                want,
                "twin {twin}, {first} into B1, {second} into B2, {back:?} back in that order"
            );
            assert_eq!(pieces.skips, 0);
        }
    }
}

/// **...and so do two copies a moot delete's re-homing folded onto one twin**: `X` holds two
/// sub-folders with a copy of one printing in each, the root holds a third, and `a` moves `X`
/// under a parent deleted on `b`, then renames the parent. Every order of the three uids.
#[test]
fn two_copies_a_moot_delete_refiled_onto_one_twin_each_return_to_their_own_folder() {
    for [twin, first, second] in THREE_UIDS {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b) = (paired("dev-a"), paired("dev-b"));
            let p = binder(&b, "P", None);
            let x = binder(&b, "X", None);
            let s1 = binder(&b, "S1", Some(x));
            let s2 = binder(&b, "S2", Some(x));
            copy_as(&b, first, Some(s1), 1);
            copy_as(&b, second, Some(s2), 1);
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
        let mut want = vec![
            format!("copy: c1 x1 in (root) notes=- as {twin}"),
            format!("copy: c1 x1 in S1 notes=- as {first}"),
            format!("copy: c1 x1 in S2 notes=- as {second}"),
        ];
        want.sort();
        assert_eq!(
            copies(&pieces.receiver),
            want,
            "twin {twin}, {first} in S1, {second} in S2"
        );
    }
}

/// **A loose copy that arrives while another of its printing is at the root only for now does
/// not fold into it.** `a` files a copy into the deleted binder, later adds a loose copy of the
/// same printing, and later renames the binder. On `b` the first is `Placed` at the root when
/// the second lands on its grain.
///
/// **What makes it red**: a grain hit that takes a `Placed` orphan for any other row — both
/// counts carried into the binder when it returns, or both left at the root and the placement
/// lost without a word.
#[test]
fn a_loose_copy_that_meets_a_placed_orphan_is_not_carried_off_with_it() {
    for (filed, loose) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b, bin) = a_binder_b_deleted(&|_| {});
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            copy_as(&a, filed, Some(bin), 1);
            let first = since(&a, &mut ma);
            copy_as(&a, loose, None, 1);
            let second = since(&a, &mut ma);
            rename(&a, "collection_folders", "B", "B2");
            let last = since(&a, &mut ma);
            (a, b, vec![first, second, last])
        });
        assert_eq!(
            copies(&pieces.receiver),
            vec![
                format!("copy: c1 x1 in (root) notes=- as {loose}"),
                format!("copy: c1 x1 in B2 notes=- as {filed}"),
            ],
            "the filed copy is {filed}"
        );
        assert_eq!(pieces.skips, 0);
    }
}

/// **Two copies filed into two deleted binders, with nothing at the root, each return to their
/// own.** The first is `Placed`; the second lands on it, so the first steps aside and is folded
/// into the second — which is an orphan too, and keeps its name. Whichever binder returns first
/// takes its own copy and no more: a `Placed` row going back to its parent leaves at the root
/// whatever was folded into it meanwhile.
///
/// **What makes it red**: a `Placed` row replayed with its lenders still inside it — both
/// counts in the first binder to return, and the other back empty.
#[test]
fn two_copies_filed_into_two_deleted_binders_each_return_to_their_own() {
    for (first, second) in [("u-1", "u-2"), ("u-2", "u-1")] {
        for back in [["B1", "B2"], ["B2", "B1"]] {
            let pieces = the_cut_decides_nothing(&|| {
                let (a, b) = (paired("dev-a"), paired("dev-b"));
                let b1 = binder(&b, "B1", None);
                let b2 = binder(&b, "B2", None);
                apply(&a, &outbox(&b)).unwrap();
                crate::collection_folders::delete_folder(&b, b1).unwrap();
                crate::collection_folders::delete_folder(&b, b2).unwrap();
                later(&a);
                let mut ma = 0;
                let _ = since(&a, &mut ma);
                let mut pushes = Vec::new();
                copy_as(&a, first, Some(id_of(&a, "collection_folders", "B1")), 1);
                pushes.push(since(&a, &mut ma));
                copy_as(&a, second, Some(id_of(&a, "collection_folders", "B2")), 1);
                pushes.push(since(&a, &mut ma));
                for name in back {
                    rename(&a, "collection_folders", name, &format!("{name}x"));
                    pushes.push(since(&a, &mut ma));
                }
                (a, b, pushes)
            });
            assert_eq!(
                copies(&pieces.receiver),
                vec![
                    format!("copy: c1 x1 in B1x notes=- as {first}"),
                    format!("copy: c1 x1 in B2x notes=- as {second}"),
                ],
                "{first} into B1, {second} into B2, {back:?} back in that order"
            );
            assert_eq!(pieces.skips, 0);
        }
    }
}

/// **...and where only one of the two binders returns, the other's copy is left at the root.**
/// `B2` comes back and `B1` stays deleted: the copy filed into `B1` is at the root on `a`, once
/// the delete reaches it, and must be there on `b` — still an orphan, should `B1` ever return.
///
/// **What makes it red**: a `Placed` row replayed with its lenders still inside it — both
/// counts in `B2`, and nothing at the root.
#[test]
fn a_copy_folded_into_a_placed_one_stays_at_the_root_when_only_the_others_binder_returns() {
    for (first, second) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing_with(
            &|| {
                let (a, b) = (paired("dev-a"), paired("dev-b"));
                let b1 = binder(&b, "B1", None);
                let b2 = binder(&b, "B2", None);
                apply(&a, &outbox(&b)).unwrap();
                crate::collection_folders::delete_folder(&b, b1).unwrap();
                crate::collection_folders::delete_folder(&b, b2).unwrap();
                later(&a);
                let mut ma = 0;
                let _ = since(&a, &mut ma);
                copy_as(&a, first, Some(id_of(&a, "collection_folders", "B1")), 1);
                let one = since(&a, &mut ma);
                copy_as(&a, second, Some(id_of(&a, "collection_folders", "B2")), 1);
                let two = since(&a, &mut ma);
                rename(&a, "collection_folders", "B2", "B2x");
                let last = since(&a, &mut ma);
                (a, b, vec![one, two, last])
            },
            1,
        );
        assert_eq!(
            copies(&pieces.receiver),
            vec![
                format!("copy: c1 x1 in (root) notes=- as {first}"),
                format!("copy: c1 x1 in B2x notes=- as {second}"),
            ],
            "{first} into B1, {second} into B2"
        );
    }
}

/// **...and where neither returns, the pair ends as one row under the lower uid on both.** The
/// sender folds the two itself when the deletes reach it, by its own re-homing, and the survivor
/// takes the lower uid; this device, which met them one at a time, must end on that uid too, or
/// whatever either says about the row next finds nothing on the other.
///
/// **What makes it red**: the second copy always stepping the first aside — the pair under the
/// second's uid here, whichever is lower.
#[test]
fn two_copies_filed_into_two_binders_that_stay_deleted_end_as_one_row_under_the_lower_uid() {
    for (first, second) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing_with(
            &|| {
                let (a, b) = (paired("dev-a"), paired("dev-b"));
                let b1 = binder(&b, "B1", None);
                let b2 = binder(&b, "B2", None);
                apply(&a, &outbox(&b)).unwrap();
                crate::collection_folders::delete_folder(&b, b1).unwrap();
                crate::collection_folders::delete_folder(&b, b2).unwrap();
                later(&a);
                let mut ma = 0;
                let _ = since(&a, &mut ma);
                copy_as(&a, first, Some(id_of(&a, "collection_folders", "B1")), 1);
                let one = since(&a, &mut ma);
                copy_as(&a, second, Some(id_of(&a, "collection_folders", "B2")), 1);
                let two = since(&a, &mut ma);
                (a, b, vec![one, two])
            },
            2,
        );
        assert_eq!(
            copies(&pieces.receiver),
            vec!["copy: c1 x2 in (root) notes=- as u-1".to_owned()],
            "{first} into B1, {second} into B2"
        );
    }
}

/// **...and nor is a copy *moved* to the root, which the grain used to refuse outright.** The
/// move is a sparse op found by uid, so no grain is asked before the write and the unique index
/// is the first to say a row is in the way: the move was skipped with an `error_log` row and
/// stayed lost when the binder returned.
///
/// **What makes it red**: a refusal by the root's grain read as a row this database cannot
/// build, when the row in the way is a `Placed` orphan.
#[test]
fn a_copy_moved_to_the_root_where_a_placed_orphan_stands_is_moved() {
    for (filed, moved) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b, bin) = a_binder_b_deleted(&|b| {
                let other = binder(b, "Other", None);
                copy_as(b, moved, Some(other), 1);
            });
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            copy_as(&a, filed, Some(bin), 1);
            let first = since(&a, &mut ma);
            move_copy(&a, moved, None);
            let second = since(&a, &mut ma);
            rename(&a, "collection_folders", "B", "B2");
            let last = since(&a, &mut ma);
            (a, b, vec![first, second, last])
        });
        assert_eq!(
            copies(&pieces.receiver),
            vec![
                format!("copy: c1 x1 in (root) notes=- as {moved}"),
                format!("copy: c1 x1 in B2 notes=- as {filed}"),
            ],
            "the filed copy is {filed}"
        );
        assert_eq!(pieces.skips, 0);
    }
}

/// **A twin made here later by the clock than the copy's filing does not stop the fold being
/// written down.** `b` adds its root copy after `a` files into the binder, by the stamps, and
/// before pulling it. Whether the filing "stands" is asked of the filed copy's own history; the
/// twin's is another row's.
///
/// **What makes it red**: the placement judged against the fold of everything the grain found —
/// no entry, the fold for good, the binder back empty: issue #841 itself.
#[test]
fn a_twin_made_later_by_the_clock_does_not_hide_the_fold_from_the_ledger() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let bin = binder(&b, "B", None);
        apply(&a, &outbox(&b)).unwrap();
        crate::collection_folders::delete_folder(&b, bin).unwrap();
        let mut ma = 0;
        let _ = since(&a, &mut ma);
        copy_as(&a, "u-2", Some(id_of(&a, "collection_folders", "B")), 1);
        let first = since(&a, &mut ma);
        later(&b);
        copy_as(&b, "u-1", None, 1);
        later(&a);
        later(&a);
        rename(&a, "collection_folders", "B", "B2");
        let last = since(&a, &mut ma);
        (a, b, vec![first, last])
    });
    assert_eq!(
        copies(&pieces.receiver),
        vec![
            "copy: c1 x1 in (root) notes=- as u-1".to_owned(),
            "copy: c1 x1 in B2 notes=- as u-2".to_owned(),
        ]
    );
}

/// **A folded copy moved into a binder that is here is built there, and its count added to a
/// copy this device already has in it.** `a` files two copies into the deleted binder and then
/// moves them into `Other` — where `b`, unheard, has one of its own. Two rows meet on a grain,
/// and that is a sum.
///
/// **What makes it red**: the orphan written as a claim — a floor — onto the row it meets: two
/// on `b`, three on `a`; or a move that leaves the copy folded.
#[test]
fn a_folded_copy_moved_into_a_binder_that_is_here_is_built_there() {
    for own in [None, Some("u-0"), Some("u-9")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b) = (paired("dev-a"), paired("dev-b"));
            let bin = binder(&b, "B", None);
            let other = binder(&b, "Other", None);
            copy_as(&b, "u-1", None, 1);
            apply(&a, &outbox(&b)).unwrap();
            crate::collection_folders::delete_folder(&b, bin).unwrap();
            if let Some(own) = own {
                copy_as(&b, own, Some(other), 1);
            }
            later(&a);
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            copy_as(&a, "u-2", Some(id_of(&a, "collection_folders", "B")), 2);
            let first = since(&a, &mut ma);
            move_copy(&a, "u-2", Some(id_of(&a, "collection_folders", "Other")));
            let last = since(&a, &mut ma);
            (a, b, vec![first, last])
        });
        let held = unnamed(&pieces.receiver);
        let there = if own.is_some() { 3 } else { 2 };
        assert!(
            held.contains(&format!("copy: c1 x{there} in Other notes=-"))
                && held.contains(&"copy: c1 x1 in (root) notes=-".to_owned()),
            "b's own copy in Other is {own:?}: {held:#?}"
        );
    }
}

/// **A copy both hold, moved into the deleted binder where the root holds its twin, folds
/// there** — as the sender's own re-homing folds it when the delete arrives — **and follows the
/// binder back.** The move clears the column of a row found by uid, and the root's grain used
/// to refuse it: skipped, with an `error_log` row, the copy left in its old binder on `b` alone.
///
/// The second half is the binder staying deleted: both devices end on one row of two.
///
/// **What makes it red**: the refusal taken as a row this database cannot build.
#[test]
fn a_held_copy_moved_into_a_deleted_binder_onto_a_root_twin_folds_and_follows_it_back() {
    let build = |renamed: bool| {
        move || {
            let (a, b, bin) = a_binder_b_deleted(&|b| {
                let other = binder(b, "Other", None);
                copy_as(b, "u-2", Some(other), 1);
                copy_as(b, "u-1", None, 1);
            });
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            move_copy(&a, "u-2", Some(bin));
            let mut pushes = vec![since(&a, &mut ma)];
            if renamed {
                rename(&a, "collection_folders", "B", "B2");
                pushes.push(since(&a, &mut ma));
            }
            (a, b, pushes)
        }
    };
    let pieces = the_cut_decides_nothing(&build(true));
    assert_eq!(
        copies(&pieces.receiver),
        vec![
            "copy: c1 x1 in (root) notes=- as u-1".to_owned(),
            "copy: c1 x1 in B2 notes=- as u-2".to_owned(),
        ]
    );
    assert_eq!(pieces.skips, 0);

    let (a, b, pushes) = build(false)();
    apply(&b, &pushes[0]).unwrap();
    apply(&a, &outbox(&b)).unwrap();
    for (who, conn) in [("a", &a), ("b", &b)] {
        assert_eq!(
            copies(&picture(conn)),
            vec!["copy: c1 x2 in (root) notes=- as u-1".to_owned()],
            "{who}"
        );
    }
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// **The twin of a fold is still found by the name it gave up.** The fold keeps the lower uid,
/// so where the filed copy's is lower the root's row wears it — and `a`, which folded nothing,
/// goes on addressing its root copy by the old one: here, to move it into another binder.
///
/// **What makes it red**: an op for the twin's old name finding no row — the move skipped, the
/// root copy left behind on `b`.
#[test]
fn a_twin_renamed_by_a_fold_is_still_reached_by_its_own_name() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b, bin) = a_binder_b_deleted(&|b| {
            binder(b, "Other", None);
            copy_as(b, "u-2", None, 1);
        });
        let mut ma = 0;
        let _ = since(&a, &mut ma);
        copy_as(&a, "u-1", Some(bin), 1);
        let first = since(&a, &mut ma);
        move_copy(&a, "u-2", Some(id_of(&a, "collection_folders", "Other")));
        let second = since(&a, &mut ma);
        rename(&a, "collection_folders", "B", "B2");
        let last = since(&a, &mut ma);
        (a, b, vec![first, second, last])
    });
    assert_eq!(
        copies(&pieces.receiver),
        vec![
            "copy: c1 x1 in B2 notes=- as u-1".to_owned(),
            "copy: c1 x1 in Other notes=- as u-2".to_owned(),
        ]
    );
    assert_eq!(pieces.skips, 0);
}

/// **A copy placed at the root that its own device then moves to the root is an orphan no
/// longer.** `a` files the copy, takes it out of the binder again, and renames the binder.
///
/// **What makes it red**: an entry that outlives the row's next placement — the binder's
/// return pulls the copy back into it.
#[test]
fn a_placed_copy_its_own_device_moved_to_the_root_stays_there() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b, bin) = a_binder_b_deleted(&|_| {});
        let mut ma = 0;
        let _ = since(&a, &mut ma);
        copy_as(&a, "u-1", Some(bin), 1);
        let first = since(&a, &mut ma);
        move_copy(&a, "u-1", None);
        let second = since(&a, &mut ma);
        rename(&a, "collection_folders", "B", "B2");
        let last = since(&a, &mut ma);
        (a, b, vec![first, second, last])
    });
    assert_eq!(
        copies(&pieces.receiver),
        vec!["copy: c1 x1 in (root) notes=- as u-1".to_owned()]
    );
}

/// **A folder its own device moved under the deleted parent and then deleted does not come
/// back with the parent** — in one push, where the group folds to a delete and the moot arm
/// must write nothing down, and in two, where the delete reaches a folder that is only an entry.
///
/// **What makes it red**: a group that ends in a delete buried like any other, or a delete that
/// leaves an absent orphan's entry — the parent's return builds a folder its sender deleted.
#[test]
fn a_folder_its_own_device_deleted_does_not_come_back_with_the_parent() {
    for together in [true, false] {
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
            let mut pushes = Vec::new();
            if !together {
                pushes.push(since(&a, &mut ma));
            }
            crate::collection_folders::delete_folder(&a, x).unwrap();
            pushes.push(since(&a, &mut ma));
            rename(&a, "collection_folders", "P", "P2");
            pushes.push(since(&a, &mut ma));
            (a, b, pushes)
        });
        assert_eq!(
            unnamed(&pieces.receiver),
            vec!["binder: P2 in (root)".to_owned()],
            "moved and deleted in one push: {together}"
        );
    }
}

/// **A card added to while it was only an entry comes back with the whole count, once.** `a`
/// moves the card into the deleted pile, adds one to it, and renames the pile — a push each.
/// The `+1` is laid over the entry on the deciding pass and on no other.
///
/// **What makes it red**: the entry rewritten on every retry pass — the delta added once a
/// pass, and the card back as three.
#[test]
fn a_card_added_to_while_it_was_an_orphan_comes_back_with_the_whole_count_once() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        let (mut ma, mut mb) = (0, 0);
        a_deck_with_three_piles(&b, &a, &mut mb, &mut ma);
        b.execute("DELETE FROM deck_categories WHERE name = 'Side'", [])
            .unwrap();
        later(&a);
        move_the_card(&a, "Side");
        let moved = since(&a, &mut ma);
        a.execute("UPDATE deck_cards SET quantity = quantity + 1", [])
            .unwrap();
        let added = since(&a, &mut ma);
        rename(&a, "deck_categories", "Side", "Side2");
        let last = since(&a, &mut ma);
        (a, b, vec![moved, added, last])
    });
    assert!(
        unnamed(&pieces.receiver).contains(&"card: Bolt x2 in A/Side2".to_owned()),
        "{:#?}",
        pieces.receiver
    );
    assert_eq!(pieces.skips, 0);
}

/// **A deck folder moved under a deleted one comes back with its decks in it.** The folder's
/// delete clears the folder off the decks filed in it — `SET NULL`, with no grain to fold on and
/// so no re-homing — and each is written down as it goes.
///
/// **What makes it red**: a walk of what a delete takes that follows only what cascades — the
/// folder back, and its deck at the root on `b` alone.
#[test]
fn a_deck_folder_moved_under_a_deleted_one_comes_back_with_its_decks() {
    let pieces = the_cut_decides_nothing(&|| {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        for name in ["P", "X"] {
            b.execute(
                "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
                 VALUES (?1, 0, unixepoch(), unixepoch())",
                [name],
            )
            .unwrap();
        }
        b.execute(
            "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
             VALUES ('D', 'commander', (SELECT id FROM deck_folders WHERE name = 'X'),
                     unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        apply(&a, &outbox(&b)).unwrap();
        b.execute("DELETE FROM deck_folders WHERE name = 'P'", [])
            .unwrap();
        later(&a);
        let mut ma = 0;
        let _ = since(&a, &mut ma);
        a.execute(
            "UPDATE deck_folders SET parent_id = (SELECT id FROM deck_folders WHERE name = 'P')
              WHERE name = 'X'",
            [],
        )
        .unwrap();
        let moved = since(&a, &mut ma);
        rename(&a, "deck_folders", "P", "P2");
        let last = since(&a, &mut ma);
        (a, b, vec![moved, last])
    });
    let held = unnamed(&pieces.receiver);
    for line in ["deck folder: X in P2", "deck: D in X"] {
        assert!(held.contains(&line.to_owned()), "{held:#?}");
    }
}

/// **A ring of folders made earlier in the same page does not send the moot arm round it for
/// ever.** `b` holds `P`, `Q`, `X`, and `D` inside `X`; unheard by `a`, it moves `X` under `Q`
/// and deletes `P`. `a` moves `Q` under `D` and `X` under `P`. `b` applies that as one page:
/// `Q` lands under `D`, closing `X → Q → D → X`, and the move of `X` under the deleted `P` is
/// then moot — its delete takes everything under `X`, which the page has just made endless.
///
/// **What makes it red**: a walk that trusts the tree to be one — a stack overflow, the process
/// gone, and the same page waiting on the next pull.
#[test]
fn a_ring_of_folders_made_in_the_same_page_does_not_overflow_the_moot_arm() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let p = binder(&b, "P", None);
    let q = binder(&b, "Q", None);
    let x = binder(&b, "X", None);
    binder(&b, "D", Some(x));
    apply(&a, &outbox(&b)).unwrap();
    crate::collection_folders::move_folder(&b, x, Some(q)).unwrap();
    crate::collection_folders::delete_folder(&b, p).unwrap();
    later(&a);
    let mut ma = 0;
    let _ = since(&a, &mut ma);
    for (child, parent) in [("Q", "D"), ("X", "P")] {
        a.execute(
            "UPDATE collection_folders
                SET parent_id = (SELECT id FROM collection_folders WHERE name = ?2)
              WHERE name = ?1",
            [child, parent],
        )
        .unwrap();
    }
    let report = apply(&b, &since(&a, &mut ma)).unwrap();
    assert_eq!(report.moot, 1, "{report:?}");
}

// ---------------------------------------------------------------------------------------
// ...and what its second pass found in the rework
// ---------------------------------------------------------------------------------------

/// **A copy left at the root by a row that went back to its binder folds with the next one, and
/// the ledger knows.** `X` holds `S1` and `S2` with a copy of one printing in each; `a` files a
/// third into a deleted binder `B`, moves `X` under a deleted `P`, renames `B`, then renames `P`.
/// On `b` all three end in one row at the root; when `B` returns its copy leaves, and the two
/// it leaves behind are put back at the root one at a time — the second onto the first.
///
/// **What makes it red**: the ledger's own put judged like a sender's — it carries no stamp, so
/// against a row this device made itself it "loses", nothing is written down, and when `P`
/// returns one sub-folder's copy comes back with both counts and the other not at all.
#[test]
fn copies_left_at_the_root_by_a_row_that_returned_still_come_back_to_their_folders() {
    for [filed, first, second] in THREE_UIDS {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b) = (paired("dev-a"), paired("dev-b"));
            let p = binder(&b, "P", None);
            let bin = binder(&b, "B", None);
            let x = binder(&b, "X", None);
            let s1 = binder(&b, "S1", Some(x));
            let s2 = binder(&b, "S2", Some(x));
            copy_as(&b, first, Some(s1), 1);
            copy_as(&b, second, Some(s2), 2);
            apply(&a, &outbox(&b)).unwrap();
            crate::collection_folders::delete_folder(&b, p).unwrap();
            crate::collection_folders::delete_folder(&b, bin).unwrap();
            later(&a);
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            let mut pushes = Vec::new();
            copy_as(&a, filed, Some(id_of(&a, "collection_folders", "B")), 1);
            pushes.push(since(&a, &mut ma));
            let (p, x) = (
                id_of(&a, "collection_folders", "P"),
                id_of(&a, "collection_folders", "X"),
            );
            crate::collection_folders::move_folder(&a, x, Some(p)).unwrap();
            pushes.push(since(&a, &mut ma));
            rename(&a, "collection_folders", "B", "B2");
            pushes.push(since(&a, &mut ma));
            rename(&a, "collection_folders", "P", "P2");
            pushes.push(since(&a, &mut ma));
            (a, b, pushes)
        });
        let mut want = vec![
            format!("copy: c1 x1 in B2 notes=- as {filed}"),
            format!("copy: c1 x1 in S1 notes=- as {first}"),
            format!("copy: c1 x2 in S2 notes=- as {second}"),
        ];
        want.sort();
        assert_eq!(
            copies(&pieces.receiver),
            want,
            "{filed} into B, {first} in S1, {second} in S2"
        );
        assert_eq!(pieces.skips, 0);
    }
}

/// **A twin some of whose orphans have returned is called by the lowest uid still in it.** The
/// root holds a copy; `a` files three more into three deleted binders, and only the first
/// binder returns. On `a`, once the deletes reach it, the other two fold into the root's copy
/// under the lowest uid of the three — and that is the name the row must wear on `b`, or what
/// either says about it next finds no row on the other.
///
/// **What makes it red**: a twin that takes its own name back whenever the orphan whose uid it
/// wears leaves — `u-3` here, `u-2` there.
#[test]
fn a_twin_some_of_whose_orphans_returned_wears_the_lowest_uid_still_in_it() {
    let pieces = the_cut_decides_nothing_with(
        &|| {
            let (a, b) = (paired("dev-a"), paired("dev-b"));
            let ids: Vec<i64> = ["B1", "B2", "B3"]
                .iter()
                .map(|name| binder(&b, name, None))
                .collect();
            copy_as(&b, "u-3", None, 1);
            apply(&a, &outbox(&b)).unwrap();
            for id in ids {
                crate::collection_folders::delete_folder(&b, id).unwrap();
            }
            later(&a);
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            let mut pushes = Vec::new();
            for (uid, name) in [("u-1", "B1"), ("u-2", "B2"), ("u-4", "B3")] {
                copy_as(&a, uid, Some(id_of(&a, "collection_folders", name)), 1);
                pushes.push(since(&a, &mut ma));
            }
            rename(&a, "collection_folders", "B1", "B1x");
            pushes.push(since(&a, &mut ma));
            (a, b, pushes)
        },
        2,
    );
    assert_eq!(
        copies(&pieces.receiver),
        vec![
            "copy: c1 x1 in B1x notes=- as u-1".to_owned(),
            "copy: c1 x3 in (root) notes=- as u-2".to_owned(),
        ]
    );
}

/// **A twin its own device moves into a binder leaves at the root the copy folded into it.**
/// `a` files a copy into the deleted binder, where it folds into the root's copy on `b`; then
/// `a` moves its root copy into `Other`. The binder stays deleted, so on `a` the filed copy
/// ends at the root, alone — and it must on `b`, where it is still an orphan.
///
/// **What makes it red**: a share that travels with the twin — two in `Other` here, one there
/// and one at the root.
#[test]
fn a_twin_moved_off_the_root_leaves_behind_the_copy_folded_into_it() {
    for (twin, filed) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing_with(
            &|| {
                let (a, b, bin) = a_binder_b_deleted(&|b| {
                    binder(b, "Other", None);
                    copy_as(b, twin, None, 1);
                });
                let mut ma = 0;
                let _ = since(&a, &mut ma);
                copy_as(&a, filed, Some(bin), 1);
                let first = since(&a, &mut ma);
                move_copy(&a, twin, Some(id_of(&a, "collection_folders", "Other")));
                let last = since(&a, &mut ma);
                (a, b, vec![first, last])
            },
            1,
        );
        assert_eq!(
            copies(&pieces.receiver),
            vec![
                format!("copy: c1 x1 in (root) notes=- as {filed}"),
                format!("copy: c1 x1 in Other notes=- as {twin}"),
            ],
            "the twin is {twin}"
        );
        assert_eq!(pieces.skips, 0);
    }
}

/// **A twin its own device deletes while a copy is folded into it takes only itself.** `a`
/// files the copy, deletes its root copy, and renames the binder. Where the fold renamed the
/// twin to the filed copy's lower uid, the delete is addressed to a name no row wears here —
/// and it is not ambiguous: `a` can only delete that name while it is still a row there, which
/// is while it has folded nothing.
///
/// **What makes it red**: a delete for the twin's old name finding nothing — the root copy kept
/// on `b` beside the returned binder copy.
#[test]
fn a_twin_its_own_device_deleted_while_a_copy_was_folded_into_it_goes_alone() {
    for (twin, filed) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b, bin) = a_binder_b_deleted(&|b| copy_as(b, twin, None, 1));
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            copy_as(&a, filed, Some(bin), 1);
            let first = since(&a, &mut ma);
            a.execute("DELETE FROM collection_entries WHERE sync_uid = ?1", [twin])
                .unwrap();
            let second = since(&a, &mut ma);
            rename(&a, "collection_folders", "B", "B2");
            let last = since(&a, &mut ma);
            (a, b, vec![first, second, last])
        });
        assert_eq!(
            copies(&pieces.receiver),
            vec![format!("copy: c1 x1 in B2 notes=- as {filed}")],
            "the twin is {twin}"
        );
    }
}

// ---------------------------------------------------------------------------------------
// ...and where the ledger meets the merge that answers a refused write (#854, #856)
// ---------------------------------------------------------------------------------------

/// [`copy_as`], in a condition said out loud.
fn graded_copy_as(conn: &Connection, uid: &str, folder: Option<i64>, condition: &str) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
             created_at,updated_at,sync_uid)
         VALUES ('c1','lea','1','en','nonfoil',?1,1,?2,unixepoch(),unixepoch(),?3)",
        rusqlite::params![condition, folder, uid],
    )
    .unwrap();
}

/// **A placed copy regraded onto a root copy folds as an orphan, and follows its binder back.**
/// The root holds a lightly played copy; `a` files a near-mint one into the deleted binder, then
/// regrades it to lightly played, then renames the binder. On `b` the filed copy is `Placed` at
/// the root when the edit lands it on the root copy's grain.
///
/// That refusal is one `apply`'s own merge answers for two rows that are both here to stay
/// (`fold_onto_the_holder`). An orphan cannot go through it: folded away by that merge, its
/// entry would name a row that is no longer its own — and the binder's return would move the
/// merged row, root copy and all, or find nothing to move.
///
/// **What makes it red**: the merge taking an orphan — both copies in the binder, or both at
/// the root, when it returns.
#[test]
fn a_placed_copy_regraded_onto_a_root_copy_folds_as_an_orphan_and_follows_its_binder_back() {
    for (root, filed) in [("u-1", "u-2"), ("u-2", "u-1")] {
        let pieces = the_cut_decides_nothing(&|| {
            let (a, b, bin) = a_binder_b_deleted(&|b| graded_copy_as(b, root, None, "LP"));
            let mut ma = 0;
            let _ = since(&a, &mut ma);
            graded_copy_as(&a, filed, Some(bin), "NM");
            let first = since(&a, &mut ma);
            a.execute(
                "UPDATE collection_entries SET condition = 'LP' WHERE sync_uid = ?1",
                [filed],
            )
            .unwrap();
            let second = since(&a, &mut ma);
            rename(&a, "collection_folders", "B", "B2");
            let last = since(&a, &mut ma);
            (a, b, vec![first, second, last])
        });
        assert_eq!(
            copies(&pieces.receiver),
            vec![
                format!("copy: c1 x1 in (root) notes=- as {root}"),
                format!("copy: c1 x1 in B2 notes=- as {filed}"),
            ],
            "the root copy is {root}"
        );
        assert_eq!(pieces.skips, 0);
    }
}
