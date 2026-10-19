//! The Discord spec's §14.2 over real databases: what every device does with an `add` member's
//! ops once the allow-list has let them through — the folder guard, the increment, the grain
//! match, and the rank — each in every order the relay can hand them over.
//!
//! The bot is `bot`, filed `add` on every device here; `dev-a` and `dev-b` are full devices.
//! Every bot op is built by hand, as the allow-list takes it, with whatever stamp the case needs:
//! a bot's clock is its own, and a rule that held only for honest stamps would hold for nothing.

use super::*;
use crate::sync_engine::capture;
use crate::sync_pair::{identity, roster};
use rusqlite::Connection;
use serde_json::json;

/// A full device in a group, with capture installed and the bot on its roster as `add`.
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
    identity::add_device(&conn, "bot", &[9u8; 32], "Discord").unwrap();
    roster::restrict(&conn, "bot", roster::ADD).unwrap();
    conn
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

/// A top-level `user` folder named `name`, made on `conn` (captured), and its uid.
fn folder(conn: &Connection, name: &str) -> String {
    let made = crate::collection_folders::create_folder(conn, None, name).unwrap();
    conn.query_row(
        "SELECT sync_uid FROM collection_folders WHERE id = ?1",
        [made.id],
        |r| r.get(0),
    )
    .unwrap()
}

/// `Recently removed`'s uid on `conn`, given one if the seed left it nameless.
fn removed_folder(conn: &Connection) -> String {
    capture::suppressed(conn, || {
        conn.execute(
            "UPDATE collection_folders SET sync_uid = 'removed-here'
              WHERE kind = 'removed' AND sync_uid IS NULL",
            [],
        )
    })
    .unwrap();
    conn.query_row(
        "SELECT sync_uid FROM collection_folders WHERE kind = 'removed'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

fn at(ms: i64, device: &str) -> Hlc {
    Hlc {
        ms,
        ctr: 0,
        device: device.to_owned(),
    }
}

/// A bot add as the allow-list takes it: a create when `fields` names the card, an increment
/// when it is empty.
fn bot_add(uid: &str, fields: serde_json::Value, quantity: i64, folder: &str, ms: i64) -> Op {
    Op {
        table: "collection_entries".into(),
        uid: uid.into(),
        kind: Kind::Put,
        fields: fields
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        counters: BTreeMap::from([("quantity".to_owned(), quantity)]),
        parents: BTreeMap::from([("folder".to_owned(), Some(folder.to_owned()))]),
        at: at(ms, "bot"),
        baseline: false,
        horizon: None,
        schema: None,
        emission: None,
    }
}

fn card(card_id: &str, set_code: &str) -> serde_json::Value {
    json!({"card_id": card_id, "set_code": set_code, "collector_number": "1", "lang": "en",
           "finish": "nonfoil"})
}

/// A full device's op on `uid`, by hand.
fn full_op(uid: &str, kind: Kind, fields: serde_json::Value, ms: i64, device: &str) -> Op {
    Op {
        kind,
        counters: BTreeMap::new(),
        parents: BTreeMap::new(),
        at: at(ms, device),
        ..bot_add(uid, fields, 1, "", ms)
    }
}

/// A full device's new collection folder of `kind`, by hand.
fn folder_op(uid: &str, kind: &str, ms: i64) -> Op {
    Op {
        table: "collection_folders".into(),
        ..full_op(
            uid,
            Kind::Put,
            json!({"name": uid, "kind": kind, "sort_order": 0}),
            ms,
            "dev-b",
        )
    }
}

/// A stamp `ms` after this machine's clock now — after every op a test database's own writes
/// stamped, which is what a peer's later op is.
fn later(ms: i64) -> i64 {
    crate::platform::clock::now_ms() + 60_000 + ms
}

/// `(rows, Σ quantity)` in `collection_entries`.
fn qty(conn: &Connection) -> (i64, i64) {
    conn.query_row(
        "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

fn column(conn: &Connection, uid: &str, col: &str) -> Option<String> {
    conn.query_row(
        &format!("SELECT {col} FROM collection_entries WHERE sync_uid = ?1"),
        [uid],
        |r| r.get(0),
    )
    .optional()
    .unwrap()
    .flatten()
}

/// A copy of `c1` in `folder_uid`, made on `conn` by its reader (captured), with a note. Its uid.
fn readers_copy(conn: &Connection, folder_uid: &str) -> String {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,quantity,notes,folder_id,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil',1,'the reader''s',
                 (SELECT id FROM collection_folders WHERE sync_uid = ?1),
                 unixepoch(),unixepoch())",
        [folder_uid],
    )
    .unwrap();
    conn.query_row(
        "SELECT sync_uid FROM collection_entries WHERE card_id = 'c1'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// ⚠ **A bot add into one of the reader's folders builds the row** — the one place a restricted
/// op's fields are written — with every column it does not carry at its default.
#[test]
fn a_bot_add_into_a_user_folder_builds_the_row() {
    let a = paired("dev-a");
    let binder = folder(&a, "Binder");
    let report = apply(&a, &[bot_add("b1", card("c1", "lea"), 2, &binder, 5_000)]).unwrap();
    assert_eq!(report.applied, 1);
    assert_eq!(qty(&a), (1, 2));
    assert_eq!(column(&a, "b1", "condition").as_deref(), Some("NONE"));
    assert_eq!(column(&a, "b1", "set_code").as_deref(), Some("lea"));
    let filed: String = a
        .query_row(
            "SELECT f.sync_uid FROM collection_entries e
               JOIN collection_folders f ON f.id = e.folder_id",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(filed, binder);
}

/// ⚠ **A bot add into `Recently removed`, or a folder the same page makes as a deck's, is refused
/// — consumed, recorded, and its watermark passed** — while a full device's op about the same
/// row, in the same page, is written as if it were not there.
#[test]
fn a_bot_add_into_a_folder_the_reader_does_not_own_is_refused() {
    let a = paired("dev-a");
    let binder = folder(&a, "Binder");
    let mine = readers_copy(&a, &binder);
    let removed = removed_folder(&a);
    let t = later(0);
    let page = vec![
        folder_op("deck-folder", "deck", t + 4_000),
        bot_add(&mine, json!({}), 3, &removed, t + 5_000),
        bot_add("b2", card("c2", "lea"), 1, "deck-folder", t + 5_001),
        full_op(
            &mine,
            Kind::Put,
            json!({"notes": "edited"}),
            t + 4_500,
            "dev-b",
        ),
    ];
    let report = apply(&a, &page).unwrap();
    // The two adds, and the deck's folder itself — it names no deck this fixture holds, which its
    // own `CHECK` refuses. Its kind is still the page's word about it.
    assert_eq!(report.dropped, 3, "{report:?}");
    assert_eq!(qty(&a), (1, 1), "a refused add moved a count");
    assert_eq!(column(&a, &mine, "notes").as_deref(), Some("edited"));
    let rows: i64 = a
        .query_row(
            "SELECT count(*) FROM error_log WHERE message = ?1",
            [NOT_A_USER_FOLDER],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1);
    let passed: (i64, i64) = a
        .query_row(
            "SELECT last_ms, last_ctr FROM sync_peers WHERE device_id = 'bot'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(passed, (t + 5_001, 0), "a consumed add pins its sender");
}

/// **A folder this device does not hold yet waits, as any missing parent does — and the guard is
/// asked again when it arrives**: a user folder lets the add through, an app-owned one refuses
/// it.
#[test]
fn a_bot_add_waits_for_its_folder_and_is_checked_when_it_arrives() {
    for (kind, lands) in [("user", true), ("removed", false)] {
        let a = paired("dev-a");
        let add = bot_add("b1", card("c1", "lea"), 2, "later", 5_000);
        let first = apply(&a, std::slice::from_ref(&add)).unwrap();
        assert_eq!(first.held_waiting, 1, "{kind}: {first:?}");
        assert_eq!(qty(&a), (0, 0));

        // The folder arrives, and the held page comes back with it.
        if kind == "removed" {
            a.execute("DELETE FROM collection_folders WHERE kind = 'removed'", [])
                .unwrap();
        }
        let made = folder_op("later", kind, later(4_000));
        let second = apply(&a, &[made, add]).unwrap();
        if lands {
            assert_eq!(qty(&a), (1, 2), "{kind}: {second:?}");
        } else {
            assert_eq!(qty(&a), (0, 0), "{kind}: {second:?}");
            assert_eq!(second.dropped, 1, "{kind}");
        }
    }
}

/// ⚠ **A create on a known uid is applied as an increment**: the counter, and not one field or
/// placement — whatever its stamp.
#[test]
fn a_create_on_a_known_uid_is_only_an_increment() {
    let a = paired("dev-a");
    let binder = folder(&a, "Binder");
    let other = folder(&a, "Other");
    let mine = readers_copy(&a, &binder);
    let mut hijack = bot_add(
        &mine,
        json!({"card_id": "c9", "set_code": "zzz", "collector_number": "9", "lang": "ja",
               "finish": "foil"}),
        2,
        &other,
        i64::MAX / 4,
    );
    hijack.at.ctr = 0;
    apply(&a, &[hijack]).unwrap();
    assert_eq!(qty(&a), (1, 3));
    for (col, held) in [
        ("card_id", "c1"),
        ("set_code", "lea"),
        ("lang", "en"),
        ("finish", "nonfoil"),
        ("notes", "the reader's"),
    ] {
        assert_eq!(column(&a, &mine, col).as_deref(), Some(held), "{col}");
    }
    let filed: String = a
        .query_row(
            "SELECT f.sync_uid FROM collection_entries e
               JOIN collection_folders f ON f.id = e.folder_id",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(filed, binder, "the bot moved the reader's copy");
}

/// ⚠ **A grain match takes only the counter**: a fresh uid that meets a row this device holds at
/// its grain — every term it does not carry at its default — adds its quantity and changes none
/// of the row's fields. A copy at another grain (here, graded `NM`) is not met.
#[test]
fn a_grain_match_takes_only_the_counter() {
    let a = paired("dev-a");
    let binder = folder(&a, "Binder");
    let mine = readers_copy(&a, &binder);
    let mut fields = card("c1", "zzz");
    fields["collector_number"] = json!("999");
    apply(&a, &[bot_add("b-fresh", fields, 4, &binder, 5_000)]).unwrap();
    assert_eq!(qty(&a), (1, 5));
    let uid: String = a
        .query_row("SELECT sync_uid FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(uid, mine.clone().min("b-fresh".to_owned()));
    for (col, held) in [
        ("set_code", "lea"),
        ("collector_number", "1"),
        ("notes", "the reader's"),
    ] {
        assert_eq!(column(&a, &uid, col).as_deref(), Some(held), "{col}");
    }

    a.execute("UPDATE collection_entries SET condition = 'NM'", [])
        .unwrap();
    apply(
        &a,
        &[bot_add("b-other", card("c1", "lea"), 1, &binder, 5_100)],
    )
    .unwrap();
    assert_eq!(qty(&a), (2, 6), "an NM copy is another grain");
}

/// The three orders a third device can meet a reader's delete and a bot's add in: the delete's
/// page first, the add's first, and both in one page.
fn every_order(ops: [Op; 2]) -> Vec<Vec<Vec<Op>>> {
    let [x, y] = ops;
    vec![
        vec![vec![x.clone()], vec![y.clone()]],
        vec![vec![y.clone()], vec![x.clone()]],
        vec![vec![x, y]],
    ]
}

/// ⚠ **A full device's delete beats a bot's add, in every order and whatever the stamps** — no
/// resurrection. On a device that held the row, and on the deleter itself.
#[test]
fn a_readers_delete_beats_a_bot_add_in_every_order() {
    for (i, order) in every_order([
        full_op("r1", Kind::Del, json!({}), later(1_000), "dev-a"),
        bot_add("r1", json!({}), 2, "binder", later(9_000_000)),
    ])
    .into_iter()
    .enumerate()
    {
        let b = paired("dev-b");
        let binder = folder(&b, "Binder");
        let row = readers_copy(&b, &binder);
        let order: Vec<Vec<Op>> = order
            .into_iter()
            .map(|page| {
                page.into_iter()
                    .map(|mut op| {
                        op.uid = row.clone();
                        if op.at.device == "bot" {
                            op.parents.insert("folder".into(), Some(binder.clone()));
                        }
                        op
                    })
                    .collect()
            })
            .collect();
        for page in &order {
            apply(&b, page).unwrap();
        }
        assert_eq!(qty(&b), (0, 0), "order {i}: the bot brought the row back");
    }

    // The deleter: its own delete is in its history, and the add lands on nothing.
    let a = paired("dev-a");
    let binder = folder(&a, "Binder");
    let row = readers_copy(&a, &binder);
    a.execute("DELETE FROM collection_entries", []).unwrap();
    let report = apply(&a, &[bot_add(&row, json!({}), 2, &binder, 9_000_000)]).unwrap();
    assert_eq!(qty(&a), (0, 0), "{report:?}");
    assert_eq!(report.resurrected, 0);
}

/// ⚠ **A full device's field beats a bot's, in every order and whatever the stamps** — the bot
/// made the row, a reader corrected it with an older clock, and the correction stands.
#[test]
fn a_readers_edit_beats_the_bots_field_in_every_order() {
    let pages = |binder: &str| {
        [
            bot_add("b1", card("c1", "zzz"), 1, binder, 9_000_000),
            full_op("b1", Kind::Put, json!({"set_code": "lea"}), 1_000, "dev-a"),
        ]
    };
    for i in 0..3 {
        let b = paired("dev-b");
        let binder = folder(&b, "Binder");
        let [create, edit] = pages(&binder);
        let order = match i {
            0 => vec![vec![create], vec![edit]],
            1 => vec![vec![edit, create]],
            _ => vec![vec![create, edit]],
        };
        for page in &order {
            apply(&b, page).unwrap();
        }
        assert_eq!(qty(&b), (1, 1), "order {i}");
        assert_eq!(
            column(&b, "b1", "set_code").as_deref(),
            Some("lea"),
            "order {i}"
        );
    }
}

/// Two adds about one row — the same bot's, or two restricted devices' — merge as usual: the
/// counters sum.
#[test]
fn two_bot_adds_sum() {
    let a = paired("dev-a");
    identity::add_device(&a, "bot2", &[8u8; 32], "Other").unwrap();
    roster::restrict(&a, "bot2", roster::ADD).unwrap();
    let binder = folder(&a, "Binder");
    let mut second = bot_add("b1", json!({}), 3, &binder, 6_000);
    second.at.device = "bot2".into();
    apply(
        &a,
        &[bot_add("b1", card("c1", "lea"), 2, &binder, 5_000), second],
    )
    .unwrap();
    assert_eq!(qty(&a), (1, 5));
}

/// A wishlist add: any printing, at the root, and a second one meeting it on the grain.
#[test]
fn a_bot_wish_lands_and_a_second_meets_it() {
    let a = paired("dev-a");
    let wish = |uid: &str, n: i64, ms: i64| Op {
        table: "wishlist_entries".into(),
        parents: BTreeMap::from([("folder".to_owned(), None)]),
        ..bot_add(
            uid,
            json!({"oracle_id": "o1", "name": "Lightning Bolt"}),
            n,
            "",
            ms,
        )
    };
    apply(&a, &[wish("w1", 1, 5_000)]).unwrap();
    apply(&a, &[wish("w2", 2, 5_100)]).unwrap();
    let (rows, sum): (i64, i64) = a
        .query_row(
            "SELECT count(*), sum(quantity) FROM wishlist_entries",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((rows, sum), (1, 3));
}

/// **Every grain default is the column's own** — what an add's insert writes is what the grain
/// it is matched on says.
#[test]
fn defaults_are_the_columns_own() {
    let conn = crate::schema::memory_pair();
    for (table, field) in [
        ("collection_entries", "condition"),
        ("collection_entries", "lang"),
        ("collection_entries", "altered"),
        ("collection_entries", "signed"),
        ("collection_entries", "proxy"),
        ("collection_entries", "misprint"),
        ("collection_entries", "serial_number"),
        ("collection_entries", "grading"),
        ("wishlist_entries", "card_id"),
        ("wishlist_entries", "preferred_finish"),
    ] {
        let default: Option<String> = conn
            .query_row(
                &format!("SELECT dflt_value FROM pragma_table_info('{table}') WHERE name = ?1"),
                [field],
                |r| r.get(0),
            )
            .unwrap();
        let ours = match restricted_grain(table, field).expect(field) {
            Sql::Null => None,
            Sql::Integer(n) => Some(n.to_string()),
            Sql::Text(t) => Some(format!("'{t}'")),
            other => panic!("{other:?}"),
        };
        assert_eq!(ours, default, "{table}.{field}");
    }
    assert_eq!(restricted_grain("collection_entries", "card_id"), None);
    assert_eq!(restricted_grain("wishlist_entries", "oracle_id"), None);
}

/// A device with no restricted device on its roster ranks nobody — every group without an
/// integration folds exactly as it did.
#[test]
fn no_restricted_device_ranks_nobody() {
    let conn = crate::schema::memory_pair();
    assert!(ranks_of(&conn).unwrap().is_empty());
}

/// The own-apply path, which `integration::add::emit` takes: the op is not dropped as this
/// device's, is not remembered as heard, and moves no watermark.
#[test]
fn an_own_op_applies_without_a_memory_or_a_watermark() {
    let bot = paired("bot");
    let binder = folder(&bot, "Binder");
    let mut mark = 0;
    since(&bot, &mut mark);
    let report = apply_own(&bot, &bot_add("b1", card("c1", "lea"), 2, &binder, 5_000)).unwrap();
    assert_eq!(report.applied, 1);
    assert_eq!(qty(&bot), (1, 2));
    let heard: i64 = bot
        .query_row("SELECT count(*) FROM sync_heard", [], |r| r.get(0))
        .unwrap();
    let peers: i64 = bot
        .query_row("SELECT count(*) FROM sync_peers", [], |r| r.get(0))
        .unwrap();
    assert_eq!((heard, peers), (0, 0));
    assert!(since(&bot, &mut mark).is_empty(), "the apply was captured");
}

/// ⚠ **A bot op that names no card, about a row nobody holds, wedges nothing**: an increment on
/// an unknown uid and a create missing `card_id` each apply without an error and without a row,
/// so a compromised bot cannot stall a receiver's pull with ops the allow-list lets through.
#[test]
fn a_bot_op_that_names_no_card_wedges_nothing() {
    let a = paired("dev-a");
    let binder = folder(&a, "Binder");
    let bare = bot_add("nobody", json!({}), 3, &binder, 5_000);
    let mut partial = card("c1", "lea");
    partial.as_object_mut().unwrap().remove("card_id");
    let nameless = bot_add("nameless", partial, 2, &binder, 6_000);
    apply(&a, &[bare, nameless]).unwrap();
    assert_eq!(qty(&a), (0, 0));
    // And the next page still applies: nothing was left holding the table.
    let report = apply(&a, &[bot_add("b1", card("c1", "lea"), 1, &binder, 7_000)]).unwrap();
    assert_eq!(report.applied, 1);
    assert_eq!(qty(&a), (1, 1));
}
