//! The client against a mock relay.
//!
//! **`httpmock` and never a deployed Worker**, which still holds now that
//! `entitlement::RELAY_BASE` names a real host: a test that reached it would depend on somebody
//! else's uptime. Every test here stands a server on localhost for its own length and points
//! `sync_state.relay_url` — the override with no UI — at it.
//!
//! **A device with no grant makes no request at all**, so every test that drives [`run_once`]
//! stores one through [`grant`]. Where `push`, `pull` and `ack` are called directly the token is
//! simply an argument, and the fixture does not need a row for it.

use super::*;
use crate::sync_engine::capture;
use crate::sync_engine::entitlement;
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

/// The entitlement a round trip now needs, holding the access token `access-1`.
///
/// **Twelve hours of life, written absolutely and never as `REFRESH_MARGIN_SECS + something`.**
/// Derived that way, shrinking the margin would shrink the fixture with it, and every test here
/// would start making a `/token` round trip none of them has registered a mock for — which would
/// read as a relay that answered the wrong thing rather than as a fixture that moved.
fn grant(conn: &Connection) {
    let expires: i64 = conn
        .query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
        .unwrap()
        + 12 * 60 * 60;
    entitlement::store_grant(conn, "access-1", "refresh-1", expires).unwrap();
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

    let result = push(&a, &server.base_url(), "access-1").await;
    assert!(result.is_err(), "a 500 is a failure");
    mock.assert();
    assert_eq!(unpushed_count(&a), before, "pushed_at was stamped anyway");

    let rows = error_rows(&a);
    assert_eq!(rows.len(), 1, "one row, not one per op: {rows:?}");
    assert_eq!((rows[0].0.as_str(), rows[0].1.as_str()), ("push", "http"));

    // ...and a bad afternoon folds onto that one row rather than filling the log.
    let _ = push(&a, &server.base_url(), "access-1").await;
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
    let sent = push(&a, &server.base_url(), "access-1").await.unwrap();
    assert!(sent > 0);
    assert_eq!(unpushed_count(&a), 0);
    assert!(error_rows(&a).is_empty());

    // A second push has nothing to say and makes no request at all.
    assert_eq!(push(&a, &server.base_url(), "access-1").await.unwrap(), 0);
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
    let (unreadable, report) = pull(&b, &server.base_url(), "access-1").await.unwrap();
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

    ack(&b, &server.base_url(), "access-1").await.unwrap();
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
    let (unreadable, report) = pull(&b, &server.base_url(), "access-1").await.unwrap();
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
    let (unreadable, _) = pull(&b, &server.base_url(), "access-1").await.unwrap();
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
    assert!(pull(&b, &server.base_url(), "access-1").await.is_err());
    assert_eq!(get_state(&b, PULL_CURSOR).as_deref(), Some("4"));
    let rows = error_rows(&b);
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].0.as_str(), rows[0].1.as_str()), ("pull", "http"));
}

/// **An empty relay URL is no longer "sync is off"** — it is the ordinary state of every
/// installation, and it means the compiled-in [`entitlement::RELAY_BASE`].
///
/// This test used to assert `relay_url(&a) == None` for a fresh device and carry the "sync is
/// off" meaning; [`entitlement::base`] never answers `None` now, so that half moved to
/// [`no_grant_means_no_request_at_all`] below and what is left here is the URL arithmetic, which
/// is still this function's and is still worth pinning: a blank is not an override, a real one
/// wins, and a trailing slash would build a double slash into every path.
#[tokio::test]
async fn a_blank_relay_url_falls_back_to_the_compiled_in_base() {
    let a = paired("dev-a", 0);
    add_copy(&a, "c1", 1);
    assert_eq!(relay_url(&a).as_deref(), Some(entitlement::RELAY_BASE));
    set_state(&a, RELAY_URL, "   ").unwrap();
    assert_eq!(
        relay_url(&a).as_deref(),
        Some(entitlement::RELAY_BASE),
        "a blank is the shape every pre-hosted-relay installation holds, not an override"
    );
    set_state(&a, RELAY_URL, "https://example.invalid/relay/").unwrap();
    assert_eq!(
        relay_url(&a).as_deref(),
        Some("https://example.invalid/relay"),
        "a trailing slash would build a double slash into every path"
    );
}

/// **A device with no entitlement makes no request at all**, and that is not an error — it is
/// the state every existing installation is in, and the successor to "no relay URL".
///
/// The server is registered to answer *anything*, so a single request of any shape fails this.
#[tokio::test]
async fn no_grant_means_no_request_at_all() {
    let server = MockServer::start_async().await;
    let never = server.mock(|when, then| {
        when.any_request();
        then.status(500).body("this must never be asked for");
    });
    let a = paired("dev-a", 0);
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    add_copy(&a, "c1", 1);

    assert_eq!(run_once(&a).await.unwrap(), None);

    never.assert_calls(0);
    assert!(error_rows(&a).is_empty(), "sync being off is not a failure");
}

/// An unpaired device makes no request either, however much it has written — **and it holds a
/// grant here**, or the entitlement check above would be what stopped it and this test would
/// pass without ever reaching the question it asks.
#[tokio::test]
async fn an_unpaired_device_never_reaches_the_relay() {
    let server = MockServer::start_async().await;
    let never = server.mock(|when, then| {
        when.any_request();
        then.status(500).body("this must never be asked for");
    });
    let conn = crate::schema::memory_pair();
    capture::install(&conn).unwrap();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    grant(&conn);
    add_copy(&conn, "c1", 1);

    assert_eq!(run_once(&conn).await.unwrap(), None);

    never.assert_calls(0);
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
    grant(&a);
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
    let sent = push(&a, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(sent, wire::BATCH + 5);
    assert_eq!(mock.calls(), 2, "205 ops is two stored rows at 200 each");
    assert_eq!(unpushed_count(&a), 0);
}

// ---------------------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------------------

/// A peer on the roster. `sync_devices` is what [`baseline::peers_needing`] reads, and a group
/// with nobody else on it is the state every test above is in — which is why none of them emits
/// a baseline and none of them had to change.
fn roster(conn: &Connection, device: &str) {
    conn.execute(
        "INSERT INTO sync_devices (device_id, public_key, name, added_at)
         VALUES (?1, x'00', ?1, 0)",
        [device],
    )
    .unwrap();
}

/// When that peer was last handed a baseline, or `None` for never.
fn baselined_at(conn: &Connection, device: &str) -> Option<i64> {
    conn.query_row(
        "SELECT baselined_at FROM sync_devices WHERE device_id = ?1",
        [device],
        |r| r.get::<_, Option<i64>>(0),
    )
    .unwrap()
}

/// The ops this device has written, oldest first — what it would hand the relay.
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

/// One request the relay was handed.
///
/// **`httpmock` 0.8 remembers a call count and nothing else** — `Mock::calls()` is the whole of
/// what it hands back — so a test that has to read what was *sent* taps the wire from inside a
/// matcher. [`tap`] always answers `true`, so it is an observation rather than an expectation;
/// it can be asked about a request meant for another mock, which is why it records the `path`
/// and every reader filters on it.
#[derive(Debug, Clone)]
struct Seen {
    path: String,
    body: String,
    /// The `Authorization` header, or `None` where the request carried none. **Read
    /// case-insensitively**: HTTP header names are, and matching `"authorization"` exactly
    /// would report a header that is really there as missing.
    authorization: Option<String>,
}

type Sent = std::sync::Arc<std::sync::Mutex<Vec<Seen>>>;

fn tap(
    sent: &Sent,
) -> impl Fn(&httpmock::prelude::HttpMockRequest) -> bool + Send + Sync + 'static {
    let sent = sent.clone();
    move |req: &httpmock::prelude::HttpMockRequest| {
        let authorization = req
            .headers_vec()
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .map(|(_, value)| value.clone());
        sent.lock().unwrap().push(Seen {
            path: req.uri().path().to_owned(),
            body: req.body_string(),
            authorization,
        });
        true
    }
}

/// The pushed envelopes that carry baseline ops, opened, one `Vec` per stored relay row.
///
/// Bodies are de-duplicated because a matcher is an observation and nothing promises it is run
/// exactly once per request; nothing here retries, so two identical push bodies can only be one
/// request seen twice.
fn pushed_baselines(sent: &Sent, group: &Group) -> Vec<Vec<Op>> {
    let seen = sent.lock().unwrap();
    let mut bodies: Vec<&str> = Vec::new();
    for request in seen.iter() {
        if request.path.ends_with("/push") && !bodies.contains(&request.body.as_str()) {
            bodies.push(&request.body);
        }
    }
    bodies
        .into_iter()
        .filter_map(|body| serde_json::from_str::<Envelope>(body).ok())
        .filter_map(|envelope| wire::open_batch(group, &envelope).ok())
        .filter(|ops| ops.iter().any(|op| op.baseline))
        .collect()
}

/// **Spec §10.2: the pull completes before anything is emitted**, so a device that is behind
/// never speaks for the group in a voice that is out of date.
///
/// Asserted by *content* rather than by arrival order, which `httpmock` cannot report: the relay
/// hands `dev-a` a row that only `dev-b` has ever held, and the baseline `dev-a` emits has to
/// contain it. Emitted before the pull, `dev-a` has never heard of that card and the baseline
/// cannot mention it.
#[tokio::test]
async fn a_baseline_is_emitted_after_the_pull_and_not_before() {
    let b = paired("dev-b", 0);
    add_copy(&b, "from-b", 2);
    let group = identity::group(&b).unwrap().unwrap();
    let envelope = wire::seal_batch(&group, "dev-b", &outbox(&b)).unwrap();

    let server = MockServer::start_async().await;
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{GROUP}/push"))
            .is_true(tap(&sent));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": [serde_json::to_value(&envelope).unwrap()],
            "cursor": 3,
        }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let a = paired("dev-a", 0);
    roster(&a, "dev-b");
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    let outcome = run_once(&a).await.unwrap().unwrap();
    assert!(outcome.baseline_ops > 0, "nothing was emitted at all");

    let batches = pushed_baselines(&sent, &group);
    assert_eq!(batches.len(), 1, "one batch of baseline ops was expected");
    let cards: Vec<String> = batches[0]
        .iter()
        .filter(|op| op.table == "collection_entries")
        .filter_map(|op| op.fields.get("card_id").and_then(|v| v.as_str()))
        .map(str::to_owned)
        .collect();
    assert!(
        cards.iter().any(|c| c == "from-b"),
        "the baseline was built before the pull landed: {cards:?}"
    );
}

/// **The marker is stamped only once the whole baseline has landed**, so a failed push is
/// simply done again on the next run rather than leaving that peer empty for ever.
///
/// The outbox is empty here on purpose: the only thing that can POST is the baseline, so the
/// 500 cannot be the ordinary push's.
#[tokio::test]
async fn a_failed_baseline_push_leaves_the_marker_unset() {
    let server = MockServer::start_async().await;
    let pushed = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(500).body("nope");
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
    });

    let a = paired("dev-a", 0);
    roster(&a, "dev-b");
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    assert_eq!(unpushed_count(&a), 0, "the outbox must be empty here");

    let error = run_once(&a).await.unwrap_err();
    assert!(error.contains("500"), "{error}");
    pushed.assert();
    assert_eq!(
        baselined_at(&a, "dev-b"),
        None,
        "a half-sent baseline must leave the marker NULL"
    );
    assert_eq!(
        error_rows(&a).first().map(|r| r.0.clone()),
        Some("push".to_owned())
    );
}

/// ...and a successful one is not sent again on the next run.
#[tokio::test]
async fn a_baseline_is_sent_once_per_peer() {
    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let a = paired("dev-a", 0);
    roster(&a, "dev-b");
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);

    let first = run_once(&a).await.unwrap().unwrap();
    assert!(first.baseline_ops > 0);
    assert!(
        baselined_at(&a, "dev-b").is_some(),
        "the marker was not set"
    );

    let second = run_once(&a).await.unwrap().unwrap();
    assert_eq!(second.baseline_ops, 0, "the baseline was sent twice");
}

/// **Spec §5.1: the outbox never holds a baseline op.** They are built in memory, sealed,
/// pushed and forgotten — `sync_ops.counters` means deltas and a baseline holds values.
#[tokio::test]
async fn baseline_ops_are_never_written_to_sync_ops() {
    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let a = paired("dev-a", 0);
    add_copy(&a, "c1", 1);
    roster(&a, "dev-b");
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    let before: i64 = a
        .query_row("SELECT count(*) FROM sync_ops", [], |r| r.get(0))
        .unwrap();

    let outcome = run_once(&a).await.unwrap().unwrap();
    assert!(outcome.baseline_ops > 1, "{outcome:?}");
    let after: i64 = a
        .query_row("SELECT count(*) FROM sync_ops", [], |r| r.get(0))
        .unwrap();
    assert_eq!(after, before, "a baseline op reached the outbox");
}

/// **Spec §9: every stored relay row carries a horizon**, because the receiver unions whatever
/// it finds and chunks arrive independently — so it goes on the first op of *each* batch and
/// not merely on the first batch of the emission.
#[tokio::test]
async fn every_pushed_batch_carries_a_horizon() {
    let server = MockServer::start_async().await;
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{GROUP}/push"))
            .is_true(tap(&sent));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let a = paired("dev-a", 0);
    // A full batch of entries plus the seeded folder, so the emission is cut in two.
    for i in 0..wire::BATCH {
        add_copy(&a, &format!("c{i}"), 1);
    }
    roster(&a, "dev-b");
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    let outcome = run_once(&a).await.unwrap().unwrap();
    assert_eq!(outcome.baseline_ops, wire::BATCH + 1);

    let group = identity::group(&a).unwrap().unwrap();
    let batches = pushed_baselines(&sent, &group);
    assert_eq!(
        batches.len(),
        2,
        "{} ops is two stored rows",
        wire::BATCH + 1
    );
    for (i, ops) in batches.iter().enumerate() {
        let horizon = ops[0]
            .horizon
            .as_ref()
            .unwrap_or_else(|| panic!("batch {i} carries no horizon"));
        assert!(
            horizon.seen.contains_key("dev-a"),
            "the horizon must name the emitter's own top stamp: {horizon:?}"
        );
    }
}

/// **The trip a revocation makes, which emits nothing.** Spec §12.4: `sync_device_revoke` runs
/// a round trip before it rotates the group key, to absorb the departing device's last push —
/// but a full baseline handed to a peer one statement before it is marked gone is thousands of
/// ops pushed at a device that will never read them. Push, pull and ack still happen, because
/// this device's own pending ops have to reach the relay before the epoch moves.
#[tokio::test]
async fn the_revoke_trip_pushes_and_pulls_and_emits_no_baseline() {
    let server = MockServer::start_async().await;
    let sent = Sent::default();
    let pushed = server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{GROUP}/push"))
            .is_true(tap(&sent));
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
    add_copy(&a, "c1", 1);
    roster(&a, "dev-b");
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);

    let outcome = run_once_without_baselines(&a).await.unwrap().unwrap();

    // What must NOT have happened, asserted first. `Mock::assert` fails on a *second* call as
    // well as on none, so leaving it above would report an emitted baseline as an arithmetic
    // complaint about a request count.
    let group = identity::group(&a).unwrap().unwrap();
    assert!(
        pushed_baselines(&sent, &group).is_empty(),
        "a baseline was pushed at a device about to be revoked"
    );
    assert_eq!((outcome.baseline_ops, outcome.baseline_history), (0, 0));
    assert_eq!(
        baselined_at(&a, "dev-b"),
        None,
        "the marker must not move on a trip that emitted nothing"
    );

    // ...and what must: the outbox reaches the relay before the epoch moves, and this device
    // takes the departing one's last words with it on the way past.
    pushed.assert();
    pulled.assert();
    acked.assert();
    assert!(
        outcome.pushed > 0,
        "the outbox still has to reach the relay"
    );
    assert_eq!(unpushed_count(&a), 0);
}

// ---------------------------------------------------------------------------------------
// The bearer token
//
// **`entitlement.rs`'s own tests already cover `/claim`, `/token`, the refresh margin, a token
// inside it, and `/claim`'s 401 clearing nothing.** What only this file can reach is the header
// on the three *sync* routes and what a 401 on one of them costs, so that is all there is here.
// ---------------------------------------------------------------------------------------

/// **Push, pull and ack are three separate call sites in `client.rs`**, and a header added to
/// one of them is a bug that shows up only as a 401 on whichever endpoint was missed - by which
/// point the reader has been told their membership ended.
#[tokio::test]
async fn every_relay_request_carries_the_bearer_token() {
    let server = MockServer::start_async().await;
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{GROUP}/push"))
            .is_true(tap(&sent));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{GROUP}/pull"))
            .is_true(tap(&sent));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{GROUP}/ack"))
            .is_true(tap(&sent));
        then.status(204);
    });

    let a = paired("dev-a", 0);
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    add_copy(&a, "c1", 1);

    run_once(&a).await.unwrap().unwrap();

    let seen = sent.lock().unwrap();
    for request in seen.iter() {
        assert_eq!(
            request.authorization.as_deref(),
            Some("Bearer access-1"),
            "{} carried no bearer token",
            request.path
        );
    }
    // **The loop above passes over an empty list**, so the three endpoints are then named one by
    // one: a trip that reached none of them would otherwise read as a pass, which is exactly the
    // shape this test would take if the entitlement check above it started answering `None`.
    for endpoint in ["push", "pull", "ack"] {
        assert!(
            seen.iter().any(|r| r.path.ends_with(endpoint)),
            "nothing reached /{endpoint} at all: {seen:?}"
        );
    }
}

/// Drive a whole round trip against a relay where **exactly one** of the three sync routes
/// answers 401 and the other two answer normally, and hand back the device's database.
///
/// One route at a time, because each of the three has its own status check and a `revoke` that
/// went into only one of them would leave the other two syncing on against a relay that has
/// stopped honouring the token.
async fn a_round_trip_with_a_401_on(route: &str) -> Connection {
    let server = MockServer::start_async().await;
    let status = |name: &str| if name == route { 401 } else { 200 };
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(status("push"))
            .json_body(serde_json::json!({ "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(status("pull"))
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(status("ack")).body("");
    });

    let a = paired("dev-a", 0);
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    add_copy(&a, "c1", 1);

    let error = run_once(&a)
        .await
        .expect_err("a 401 is still a failed sync");
    assert!(error.contains("401"), "on {route}: {error}");
    a
}

/// **A 401 on a sync route is the membership ending: it costs the grant and nothing else.**
///
/// Two rules, both the opposite of what every other status does, and both worth their own
/// assertion:
///
/// * **No `error_log` row** (spec 10). That table is how this window says "your sync is broken",
///   and a reader whose pledge lapsed sent to look at their network is being pointed at the
///   wrong fix.
/// * **`entitlement::revoke` and never `clear`.** The two are different by design and both leave
///   the device holding no refresh secret, so `refresh_secret == None` cannot tell them apart -
///   `membership_ended` is the one that can, and it is what the panel asks before it says *Not
///   connected*. With `clear` here a lapsed reader is shown that sentence instead of *Membership
///   ended*, and never sees 7.1's reassurance that their local data is untouched.
#[tokio::test]
async fn a_401_on_any_sync_route_ends_the_membership_and_logs_nothing() {
    for route in ["push", "pull", "ack"] {
        let a = a_round_trip_with_a_401_on(route).await;

        assert_eq!(
            entitlement::refresh_secret(&a),
            None,
            "{route}: the grant survived a 401"
        );
        // The access token has to go too, or this device syncs on for up to a day against a
        // relay that has already stopped honouring it.
        assert_eq!(
            get_state(&a, entitlement::ACCESS_TOKEN),
            None,
            "{route}: the access token survived a 401"
        );
        assert!(
            entitlement::membership_ended(&a),
            "{route}: cleared rather than revoked - the panel will say Not connected"
        );
        assert_eq!(
            error_rows(&a),
            Vec::new(),
            "{route}: a lapse is a sentence, not an error_log row"
        );
    }
}
