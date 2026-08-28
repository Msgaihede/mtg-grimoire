//! The client against a mock relay.
//!
//! **`httpmock` and never a deployed Worker.** Nothing in this repository knows a relay URL,
//! and nothing in it ever should: the URL is the reader's own and lives in their
//! `sync_state.relay_url`. These tests stand a server on localhost for the length of one test.

use super::*;
use crate::sync_engine::capture;
use httpmock::prelude::*;
use rusqlite::Connection;

const GROUP: &str = "0123456789abcdef";

fn paired(device: &str, epoch: i64) -> Connection {
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
         VALUES (1, ?1, ?2, ?3, 0)",
        rusqlite::params![GROUP, epoch, vec![7u8; 32]],
    )
    .unwrap();
    conn
}

fn add_copy(conn: &Connection, card: &str, quantity: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES (?1,'lea','1','en','nonfoil','NM',?2,unixepoch(),unixepoch())",
        rusqlite::params![card, quantity],
    )
    .unwrap();
}

fn unpushed_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM sync_ops WHERE pushed_at IS NULL",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

fn error_rows(conn: &Connection) -> Vec<(String, String, i64)> {
    let mut stmt = conn
        .prepare("SELECT operation, kind, count FROM error_log WHERE source = 'relay'")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// **A 500 on push leaves `pushed_at` NULL and writes exactly one `error_log` row.** A network
/// blip must cost a retry and never the reader's changes.
#[tokio::test]
async fn a_failed_push_changes_nothing_locally() {
    let server = MockServer::start_async().await;
    let mock = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(500).body("nope");
    });
    let a = paired("dev-a", 0);
    add_copy(&a, "c1", 1);
    let before = unpushed_count(&a);
    assert!(before > 0);

    let result = push(&a, &server.base_url()).await;
    assert!(result.is_err(), "a 500 is a failure");
    mock.assert();
    assert_eq!(unpushed_count(&a), before, "pushed_at was stamped anyway");

    let rows = error_rows(&a);
    assert_eq!(rows.len(), 1, "one row, not one per op: {rows:?}");
    assert_eq!((rows[0].0.as_str(), rows[0].1.as_str()), ("push", "http"));

    // ...and a bad afternoon folds onto that one row rather than filling the log.
    let _ = push(&a, &server.base_url()).await;
    let rows = error_rows(&a);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].2, 2,
        "the grain is (source, operation, kind, message)"
    );
}

/// A 200 stamps `pushed_at`, and only then.
#[tokio::test]
async fn a_successful_push_stamps_what_it_sent() {
    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 1 }));
    });
    let a = paired("dev-a", 0);
    add_copy(&a, "c1", 1);
    let sent = push(&a, &server.base_url()).await.unwrap();
    assert!(sent > 0);
    assert_eq!(unpushed_count(&a), 0);
    assert!(error_rows(&a).is_empty());

    // A second push has nothing to say and makes no request at all.
    assert_eq!(push(&a, &server.base_url()).await.unwrap(), 0);
}

/// **The whole round trip through a mock relay: two databases converge.**
#[tokio::test]
async fn a_push_and_a_pull_carry_a_row_between_two_databases() {
    let a = paired("dev-a", 0);
    add_copy(&a, "c1", 3);

    // What `a` would have handed the relay.
    let sql = format!("{} ORDER BY seq", capture::OPS_SELECT);
    let ops: Vec<Op> = {
        let mut stmt = a.prepare(&sql).unwrap();
        stmt.query_map([], capture::op_from_row)
            .unwrap()
            .map(|r| r.unwrap().1)
            .collect()
    };
    let group = identity::group(&a).unwrap().unwrap();
    let envelope = wire::seal_batch(&group, "dev-a", &ops).unwrap();

    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": [serde_json::to_value(&envelope).unwrap()],
            "cursor": 7,
        }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let b = paired("dev-b", 0);
    let (unreadable, report) = pull(&b, &server.base_url()).await.unwrap();
    assert_eq!(unreadable, 0);
    assert!(report.applied > 0);
    let (rows, quantity): (i64, i64) = b
        .query_row(
            "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((rows, quantity), (1, 3));
    assert_eq!(get_state(&b, PULL_CURSOR).as_deref(), Some("7"));

    ack(&b, &server.base_url()).await.unwrap();
    assert!(error_rows(&b).is_empty());
}

/// **An envelope from the FUTURE holds the cursor**, because this device is behind a key
/// rotation and those ops become readable once it catches up.
#[tokio::test]
async fn an_envelope_from_a_newer_epoch_holds_the_cursor() {
    let a = paired("dev-a", 1);
    add_copy(&a, "c1", 1);
    let sql = format!("{} ORDER BY seq", capture::OPS_SELECT);
    let ops: Vec<Op> = {
        let mut stmt = a.prepare(&sql).unwrap();
        stmt.query_map([], capture::op_from_row)
            .unwrap()
            .map(|r| r.unwrap().1)
            .collect()
    };
    let newer = identity::group(&a).unwrap().unwrap();
    let envelope = wire::seal_batch(&newer, "dev-a", &ops).unwrap();

    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": [serde_json::to_value(&envelope).unwrap()],
            "cursor": 9,
        }));
    });

    // `b` is still on epoch 0 and has not been handed the new key.
    let b = paired("dev-b", 0);
    let (unreadable, report) = pull(&b, &server.base_url()).await.unwrap();
    assert_eq!(unreadable, 1);
    assert_eq!(report.applied, 0);
    assert_eq!(
        get_state(&b, PULL_CURSOR),
        None,
        "the cursor stepped over ops that will become readable"
    );
    let rows = error_rows(&b);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "pull");
}

/// ...and an envelope from **before** a rotation is stepped over, because no key this device
/// will ever hold opens it and refusing to advance would stall the stream for the thirty days
/// the relay keeps a tail.
#[tokio::test]
async fn an_envelope_from_an_older_epoch_is_stepped_over() {
    let a = paired("dev-a", 0);
    add_copy(&a, "c1", 1);
    let sql = format!("{} ORDER BY seq", capture::OPS_SELECT);
    let ops: Vec<Op> = {
        let mut stmt = a.prepare(&sql).unwrap();
        stmt.query_map([], capture::op_from_row)
            .unwrap()
            .map(|r| r.unwrap().1)
            .collect()
    };
    let old = identity::group(&a).unwrap().unwrap();
    let envelope = wire::seal_batch(&old, "dev-a", &ops).unwrap();

    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": [serde_json::to_value(&envelope).unwrap()],
            "cursor": 11,
        }));
    });

    // `b` has rotated past it.
    let b = paired("dev-b", 1);
    let (unreadable, _) = pull(&b, &server.base_url()).await.unwrap();
    assert_eq!(unreadable, 1);
    assert_eq!(
        get_state(&b, PULL_CURSOR).as_deref(),
        Some("11"),
        "a blob nothing can ever open must not stall the stream"
    );
}

/// A pull that fails leaves the cursor where it was and writes one row.
#[tokio::test]
async fn a_failed_pull_leaves_the_cursor_alone() {
    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(503);
    });
    let b = paired("dev-b", 0);
    set_state(&b, PULL_CURSOR, "4").unwrap();
    assert!(pull(&b, &server.base_url()).await.is_err());
    assert_eq!(get_state(&b, PULL_CURSOR).as_deref(), Some("4"));
    let rows = error_rows(&b);
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].0.as_str(), rows[0].1.as_str()), ("pull", "http"));
}

/// **An empty relay URL means sync is off**, which is the state every existing installation is
/// in. `run_once` answers `None` and makes no request.
#[tokio::test]
async fn no_relay_url_means_no_request() {
    let a = paired("dev-a", 0);
    add_copy(&a, "c1", 1);
    assert_eq!(run_once(&a).await.unwrap(), None);
    set_state(&a, RELAY_URL, "   ").unwrap();
    assert_eq!(run_once(&a).await.unwrap(), None);
    assert_eq!(relay_url(&a), None);
    set_state(&a, RELAY_URL, "https://example.invalid/relay/").unwrap();
    assert_eq!(
        relay_url(&a).as_deref(),
        Some("https://example.invalid/relay"),
        "a trailing slash would build a double slash into every path"
    );
}

/// An unpaired device makes no request either, however much it has written.
#[tokio::test]
async fn an_unpaired_device_never_reaches_the_relay() {
    let conn = crate::schema::memory_pair();
    capture::install(&conn).unwrap();
    set_state(&conn, RELAY_URL, "http://127.0.0.1:1/nope").unwrap();
    add_copy(&conn, "c1", 1);
    assert_eq!(run_once(&conn).await.unwrap(), None);
}

/// The whole loop, end to end, against a relay that remembers one envelope.
#[tokio::test]
async fn run_once_pushes_pulls_and_acks() {
    let server = MockServer::start_async().await;
    let pushed = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 1 }));
    });
    let pulled = server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
    });
    let acked = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let a = paired("dev-a", 0);
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    add_copy(&a, "c1", 1);
    let outcome = run_once(&a).await.unwrap().unwrap();
    pushed.assert();
    pulled.assert();
    acked.assert();
    assert!(outcome.pushed > 0);
    assert_eq!(outcome.pulled, 0);
    assert_eq!(unpushed_count(&a), 0);
    assert!(get_state(&a, LAST_SYNC_AT).is_some());
}

/// **A push larger than one batch is several requests**, and each is stamped on its own.
#[tokio::test]
async fn an_outbox_larger_than_one_batch_is_several_stored_rows() {
    let server = MockServer::start_async().await;
    let mock = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 1 }));
    });
    let a = paired("dev-a", 0);
    for i in 0..(wire::BATCH + 5) {
        add_copy(&a, &format!("c{i}"), 1);
    }
    let sent = push(&a, &server.base_url()).await.unwrap();
    assert_eq!(sent, wire::BATCH + 5);
    assert_eq!(mock.calls(), 2, "205 ops is two stored rows at 200 each");
    assert_eq!(unpushed_count(&a), 0);
}
