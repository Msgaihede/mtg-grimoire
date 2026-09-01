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

/// The `/keys` answer a healthy group gives every device on every sync: **this epoch, no blob,
/// nobody named**.
///
/// **It is what a group that has claimed and never rotated really answers**, because `/claim`
/// seeds `group_keys` with an empty manifest — so this is the shape that would dissolve every
/// group in existence if [`check_keys`] read the manifest before comparing the epochs. Every
/// round-trip test below registers it, and the one that asserts what it means is
/// [`a_current_epoch_with_an_empty_manifest_leaves_the_group_alone`].
fn keys_mock(server: &MockServer, epoch: i64) -> httpmock::Mock<'_> {
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/keys"));
        then.status(200).json_body(serde_json::json!({
            "epoch": epoch,
            "blob": serde_json::Value::Null,
            "devices": [],
        }));
    })
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

// **The URL arithmetic is asserted in `entitlement.rs`, not here.** This file used to carry
// `a_blank_relay_url_falls_back_to_the_compiled_in_base`, over a `client::relay_url` that had
// become `Some(entitlement::base(conn))` and nothing else — a `pub` wrapper whose only caller was
// that test. Both are deleted: the three `base` tests next to the function say the same three
// things (a blank is not an override, a real one wins, a trailing slash is trimmed) about the code
// that actually decides them. What was this test's *other* half — "no URL" meaning sync is off —
// moved to `no_group_and_no_grant_means_no_request_at_all` below when the entitlement replaced
// it.

/// **A device in no group and with no grant makes no request at all**, and that is not an error
/// — it is the state every existing installation is in, and the successor to "no relay URL".
///
/// **This asserted a *paired* device with no grant until spec §2.2, and the reversal is the
/// design working rather than a regression.** A paired device now mints its own token through
/// `/token`'s group door, holding no Patreon-side secret at all — that is the whole of item 3 —
/// and it asks `/keys` above the token besides. No local signal could gate either: once pairing
/// stops carrying the refresh secret, a pairing-joined device holds no status either, so
/// "entitled" is a thing only the relay can answer. What survives is the narrower claim, which is
/// the one `entitlement::access_token`'s own guard makes: **neither a secret nor a group is
/// nothing to ask about**.
///
/// The server answers *anything*, so a single request of any shape fails this — including the
/// `/g//keys` a `check_keys` that forgot to check for a group would build out of an empty group
/// id and send.
#[tokio::test]
async fn no_group_and_no_grant_means_no_request_at_all() {
    let server = MockServer::start_async().await;
    let never = server.mock(|when, then| {
        when.any_request();
        then.status(500).body("this must never be asked for");
    });
    let a = crate::schema::memory_pair();
    capture::install(&a).unwrap();
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    add_copy(&a, "c1", 1);
    assert!(
        identity::group(&a).unwrap().is_none(),
        "the fixture is wrong"
    );
    assert_eq!(
        entitlement::refresh_secret(&a),
        None,
        "the fixture is wrong"
    );

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
    keys_mock(&server, 0);
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
    keys_mock(&server, 0);
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
    keys_mock(&server, 0);
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
    keys_mock(&server, 0);
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
    keys_mock(&server, 0);
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
    keys_mock(&server, 0);
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
    keys_mock(&server, 0);
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
    keys_mock(&server, 0);
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
    keys_mock(&server, 0);
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

// ---------------------------------------------------------------------------------------
// The group key
//
// **The one request that has to work when a token cannot be minted.** A device rotated away
// from holds a stale group auth, so every other route is closed to it; `/keys` is what tells
// "behind a rotation" from "removed", and the epoch comparison in front of the manifest is what
// stops a healthy group reading itself as dissolved.
// ---------------------------------------------------------------------------------------

/// A group with **real keypairs**, which [`paired`] deliberately does not have: it writes
/// `x'00'`/`x'01'`, and no X25519 agreement can be made to work against a public key that is not
/// the base-point multiple of the secret beside it.
///
/// Answers the database, this device's identity, the keypair of the peer that plays the remover
/// — so a test can seal a blob exactly as `plan_rotation` on the other machine would — and the
/// group id, which is minted rather than fixed here. The `tablet` is the third device, the one a
/// rotation is about to drop.
fn keyed_group() -> (Connection, identity::Identity, crypto::Keypair, String) {
    let conn = crate::schema::memory_pair();
    capture::install(&conn).unwrap();
    let me = identity::ensure(&conn).unwrap();
    identity::create_group(&conn, &me).unwrap();
    let remover = crypto::keypair();
    identity::add_device(&conn, "dev-remover", &remover.public, "Desk").unwrap();
    identity::add_device(&conn, "tablet", &[8u8; 32], "Tablet").unwrap();
    let group = identity::group(&conn).unwrap().unwrap().group_id;
    (conn, me, remover, group)
}

/// Register `GET /g/{group}/keys` with a body written by hand, so a test can leave a field out.
fn keys_answering(server: &MockServer, group: &str, body: serde_json::Value) {
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group}/keys"));
        then.status(200).json_body(body);
    });
}

/// ⚠ **A group that has claimed and never rotated leaves every device alone.**
///
/// `/claim` seeds `group_keys` with an *empty* manifest at the claim's epoch, so every device in
/// such a group reads `blob: null, devices: []` — which is byte for byte the removal notice.
/// Comparing the epochs first is the whole of what stops all of them concluding they were removed
/// and dissolving the group on their next sync. This is the case where a missing guard does not
/// merely fail: it takes a healthy group apart, on every machine, at once.
///
/// **What makes it red**: reading the manifest before the epochs — the answer becomes `Removed`
/// and every assertion below fails at once.
#[tokio::test]
async fn a_current_epoch_with_an_empty_manifest_leaves_the_group_alone() {
    let server = MockServer::start_async().await;
    let (conn, me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    grant(&conn);
    keys_answering(
        &server,
        &group,
        serde_json::json!({ "epoch": 0, "blob": serde_json::Value::Null, "devices": [] }),
    );
    let before = identity::group(&conn).unwrap().unwrap();

    assert_eq!(check_keys(&conn).await.unwrap(), KeyOutcome::Current);

    assert_eq!(identity::group(&conn).unwrap().unwrap(), before);
    assert_eq!(
        identity::roster(&conn).unwrap().len(),
        3,
        "the empty manifest was read as a roster"
    );
    assert_eq!(
        entitlement::refresh_secret(&conn).as_deref(),
        Some("refresh-1"),
        "the grant was cleared on a group nobody was removed from"
    );
    assert_eq!(identity::ensure(&conn).unwrap().device_id, me.device_id);
    assert!(error_rows(&conn).is_empty(), "nothing failed");
}

/// A higher epoch with a blob for this device: **the key is adopted and the manifest becomes the
/// roster.**
///
/// This is the half that carries a removal to the devices that were not doing the removing, and
/// it is what unsticks `client::pull` — a device behind a rotation holds its cursor for ever
/// (`an_envelope_from_a_newer_epoch_holds_the_cursor`) until the key arrives.
///
/// **What makes it red**: dropping the manifest sweep (the tablet stays and the length is 3),
/// writing the wrong key (`group_key` is not `new_key`), or moving the group id.
#[tokio::test]
async fn a_higher_epoch_with_a_blob_is_adopted_and_sweeps_the_roster() {
    let server = MockServer::start_async().await;
    let (conn, me, remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    let before = identity::group(&conn).unwrap().unwrap();
    let new_key = [42u8; 32];
    let blob = crypto::wrap_group_key(
        &remover.secret,
        &me.keypair.public,
        &group,
        &me.device_id,
        before.epoch + 1,
        &new_key,
    )
    .unwrap();
    keys_answering(
        &server,
        &group,
        serde_json::json!({
            "epoch": before.epoch + 1,
            "blob": URL_SAFE_NO_PAD.encode(&blob),
            "devices": [me.device_id.clone(), "dev-remover"],
        }),
    );

    assert_eq!(check_keys(&conn).await.unwrap(), KeyOutcome::Adopted);

    let after = identity::group(&conn).unwrap().unwrap();
    assert_eq!(after.epoch, before.epoch + 1);
    assert_eq!(after.group_key, new_key, "the new key was not written");
    assert_eq!(after.group_id, before.group_id, "the group id moved");
    let ids: Vec<String> = identity::roster(&conn)
        .unwrap()
        .into_iter()
        .map(|d| d.device_id)
        .collect();
    assert!(!ids.contains(&"tablet".to_owned()), "{ids:?}");
    assert_eq!(ids.len(), 2, "somebody else was swept: {ids:?}");
}

/// A higher epoch and **no blob**: this device is not on the manifest, so it has been removed.
///
/// Both halves go — the pairing state and the grant — and the second is not tidiness. A removed
/// device that kept its refresh secret would keep a *working credential for the group it was
/// removed from*: the refresh door mints a token whose `grp` is that group and `/g/{group}/push`
/// honours it, so the removal would be cosmetic at the relay.
///
/// **`clear` and never `revoke`**, which is what the `membership_ended` assertion pins: nothing
/// ended, the reader's pledge is untouched, and drawing *Membership ended* at them would be a lie
/// about an event that did not happen. And `sync_identity` survives, because the device id is
/// what every op this device ever wrote is stamped with.
///
/// **What makes it red**: leaving the group standing, keeping the grant, `revoke` instead of
/// `clear`, or re-minting the identity.
#[tokio::test]
async fn a_higher_epoch_with_no_blob_leaves_the_group_and_the_grant() {
    let server = MockServer::start_async().await;
    let (conn, me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    grant(&conn);
    entitlement::store_status(&conn, "active", Some(1_740_000_000)).unwrap();
    keys_answering(
        &server,
        &group,
        serde_json::json!({
            "epoch": 1,
            "blob": serde_json::Value::Null,
            "devices": ["dev-remover"],
        }),
    );

    assert_eq!(check_keys(&conn).await.unwrap(), KeyOutcome::Removed);

    assert!(
        identity::group(&conn).unwrap().is_none(),
        "still in a group"
    );
    assert!(
        identity::roster(&conn).unwrap().is_empty(),
        "roster survived"
    );
    assert_eq!(entitlement::refresh_secret(&conn), None, "grant survived");
    assert_eq!(get_state(&conn, entitlement::ACCESS_TOKEN), None);
    assert!(
        !entitlement::membership_ended(&conn),
        "revoked rather than cleared - the panel will say Membership ended"
    );
    assert_eq!(
        identity::ensure(&conn).unwrap().device_id,
        me.device_id,
        "the device id was re-minted, which forks this device's own history"
    );
}

/// ...and the round trip stops there, answering `Ok(None)` rather than an error.
///
/// There is nothing left to sync to, which is not a failure. **No token is fetched either**,
/// which is why `check_keys` sits above that call: a removed device cannot mint one.
#[tokio::test]
async fn a_removed_device_stops_the_round_trip_without_an_error() {
    let server = MockServer::start_async().await;
    let (conn, _me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    grant(&conn);
    add_copy(&conn, "c1", 1);
    keys_answering(
        &server,
        &group,
        serde_json::json!({ "epoch": 1, "blob": serde_json::Value::Null, "devices": [] }),
    );
    let pushed = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group}/push"));
        then.status(500);
    });
    let pulled = server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group}/pull"));
        then.status(500);
    });
    let acked = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group}/ack"));
        then.status(500);
    });

    assert_eq!(run_once(&conn).await.unwrap(), None);

    pushed.assert_calls(0);
    pulled.assert_calls(0);
    acked.assert_calls(0);
    assert!(identity::group(&conn).unwrap().is_none());
    assert!(error_rows(&conn).is_empty(), "leaving is not a failure");
}

/// **`/keys` carries the group auth and never the access token**, which is the whole of why a
/// device that cannot mint a token can still ask it.
///
/// **What makes it red**: sending `Bearer access-1`, or deriving the auth from anything but this
/// device's current group key, id and epoch.
#[tokio::test]
async fn a_key_check_presents_the_group_auth_rather_than_the_token() {
    let server = MockServer::start_async().await;
    let (conn, _me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    grant(&conn);
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{group}/keys"))
            .is_true(tap(&sent));
        then.status(200).json_body(
            serde_json::json!({ "epoch": 0, "blob": serde_json::Value::Null, "devices": [] }),
        );
    });

    assert_eq!(check_keys(&conn).await.unwrap(), KeyOutcome::Current);

    let stored = identity::group(&conn).unwrap().unwrap();
    let expected = format!(
        "Bearer {}",
        crypto::relay_auth(&stored.group_key, &stored.group_id, stored.epoch)
    );
    let seen = sent.lock().unwrap();
    let request = seen.first().expect("nothing reached /keys at all");
    assert_eq!(request.authorization.as_deref(), Some(expected.as_str()));
    assert_ne!(
        request.authorization.as_deref(),
        Some("Bearer access-1"),
        "the access token is exactly what a rotated-away device cannot mint"
    );
}

/// An answer with **no `blob` field at all** is a parse failure, not a removal notice.
///
/// **serde reads a missing `Option` field as `None` without being asked to**, and here that
/// default is the one answer this type must never invent: at a higher epoch an absent `blob`
/// would take the group apart. `KeyPage::blob` carries a `deserialize_with`, which is exempt from
/// the missing-field default, so a truncated answer stalls this device exactly where it is.
///
/// **What makes it red**: dropping that attribute — the answer becomes `Ok(Removed)` and the
/// group is gone.
#[tokio::test]
async fn a_key_answer_with_no_blob_field_is_refused_rather_than_read_as_a_removal() {
    let server = MockServer::start_async().await;
    let (conn, _me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    keys_answering(
        &server,
        &group,
        serde_json::json!({ "epoch": 1, "devices": ["dev-remover"] }),
    );
    let before = identity::group(&conn).unwrap().unwrap();

    assert!(check_keys(&conn).await.is_err(), "read as a removal");

    assert_eq!(identity::group(&conn).unwrap().unwrap(), before);
    assert_eq!(identity::roster(&conn).unwrap().len(), 3);
    assert_eq!(
        error_rows(&conn)
            .first()
            .map(|r| (r.0.clone(), r.1.clone())),
        Some(("keys".to_owned(), "parse".to_owned()))
    );
}

/// **A 401 on `/keys` is never a lapse, and it must not cost the grant.**
///
/// The credential is the group auth, not the access token, so a refusal says the group key is
/// unrecognised: a group with no membership connected to it yet, or a device dark across more
/// rotations than the relay keeps (spec §4). `client::lapsed` handles push, pull and ack that way
/// and copying it here would tell a reader their Patreon membership ended because of something
/// else entirely.
///
/// **What makes it red**: calling `lapsed` on this status, which clears the grant and leaves the
/// `membership_ended` mark.
#[tokio::test]
async fn a_401_on_a_key_check_costs_the_grant_nothing() {
    let server = MockServer::start_async().await;
    let (conn, _me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    grant(&conn);
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group}/keys"));
        then.status(401).body("");
    });

    assert!(check_keys(&conn).await.is_err());

    assert_eq!(
        entitlement::refresh_secret(&conn).as_deref(),
        Some("refresh-1"),
        "a stale group auth cost the reader their membership"
    );
    assert!(!entitlement::membership_ended(&conn));
    assert!(identity::group(&conn).unwrap().is_some(), "the group went");
    let rows = error_rows(&conn);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!((rows[0].0.as_str(), rows[0].1.as_str()), ("keys", "http"));
}

// ---------------------------------------------------------------------------------------
// The rendezvous, and the join retry
//
// **`post_rendezvous`/`get_rendezvous` need no group at all** — the rendezvous is how the two
// halves of a QR pairing find each other *before* either device knows it is in one — so these
// run against `crate::schema::memory_pair()` directly, the way
// `no_group_and_no_grant_means_no_request_at_all` does above. `publish_join` is the opposite: it
// calls `identity::plan_join`, which needs a real device keypair to seal a blob with, so those
// three run against [`keyed_group`] rather than [`paired`] — that helper's `x'00'`/`x'01'` fixture
// keys are not points X25519 will agree on.
// ---------------------------------------------------------------------------------------

const RV: &str = "0123456789abcdef0123456789abcdef";

/// A rendezvous post carries the blob and nothing else, and a 204 is success.
///
/// **`Mock::calls()` is a count, not a request list** (httpmock 0.8 — see [`tap`]'s own doc), so
/// the body is read back the way `every_pushed_batch_carries_a_horizon` reads one: through the
/// wire-tapping matcher already in this file, not through the mock itself.
#[tokio::test]
async fn a_rendezvous_post_carries_the_blob_and_answers_nothing() {
    let server = MockServer::start_async().await;
    let sent = Sent::default();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path(format!("/p/{RV}/join"))
            .is_true(tap(&sent));
        then.status(204);
    });
    let conn = crate::schema::memory_pair();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();

    post_rendezvous(&conn, RV, "join", "ABCDE")
        .await
        .expect("a 204 is success");

    mock.assert();
    let seen = sent.lock().unwrap();
    let body: serde_json::Value =
        serde_json::from_str(&seen.first().expect("one call").body).expect("json");
    assert_eq!(
        body["blob"], "ABCDE",
        "the blob is the only field the relay is sent"
    );
}

/// **Not "the pairing failed"**: somebody else answered this code, which is a different fix —
/// start a new offer on the device showing it, rather than retry here.
#[tokio::test]
async fn a_409_from_the_rendezvous_is_its_own_sentence() {
    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(POST).path(format!("/p/{RV}/offer"));
        then.status(409);
    });
    let conn = crate::schema::memory_pair();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();

    let error = post_rendezvous(&conn, RV, "offer", "XYZ")
        .await
        .expect_err("a 409 must not read as success");
    assert_eq!(error, RENDEZVOUS_TAKEN);
}

/// **A 404 is `Ok(None)`, and never an error.** The panel polls this every 1.5 seconds while the
/// other device is still being read to; a poll that treated "not yet" as a failure would put an
/// error in front of the reader on every tick before the pairing ever had a chance to finish.
#[tokio::test]
async fn an_empty_rendezvous_is_none_and_never_an_error() {
    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(GET).path(format!("/p/{RV}/offer"));
        then.status(404);
    });
    let conn = crate::schema::memory_pair();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();

    let result = get_rendezvous(&conn, RV, "offer").await;
    assert_eq!(result, Ok(None), "a 404 is not yet, not a failure");
    assert!(
        error_rows(&conn).is_empty(),
        "a poll finding nothing must not log a failure"
    );
}

/// A filled slot is read back as the blob it was posted with.
#[tokio::test]
async fn a_filled_rendezvous_answers_the_blob() {
    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(GET).path(format!("/p/{RV}/join"));
        then.status(200)
            .json_body(serde_json::json!({ "blob": "SEALED-BYTES" }));
    });
    let conn = crate::schema::memory_pair();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();

    let result = get_rendezvous(&conn, RV, "join").await.unwrap();
    assert_eq!(result.as_deref(), Some("SEALED-BYTES"));
}

/// `GET /g/{group}/keys` answering a manifest and an epoch this device is already on — what
/// [`publish_join`]'s superset guard reads before it is allowed to publish anything.
///
/// **The epoch is deliberately the device's own**, so nothing that registers this becomes an
/// epoch test by accident: the guard reads `devices` and nothing else off the page.
fn manifest_answering<'a>(
    server: &'a MockServer,
    group: &str,
    devices: &[&str],
) -> httpmock::Mock<'a> {
    let devices: Vec<String> = devices.iter().map(|d| (*d).to_owned()).collect();
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group}/keys"));
        then.status(200).json_body(serde_json::json!({
            "epoch": 0,
            "blob": serde_json::Value::Null,
            "devices": devices,
        }));
    })
}

/// **A first pairing has no membership and cannot publish, and that must not fail the pairing.**
/// `/rotate` refuses with a 401 exactly as a group with no entitlement row does; `publish_join`
/// answers `Ok(())` anyway, marks the debt, and — the sharper assertion — leaves the group
/// exactly as it was, so the reader can press again.
///
/// The manifest is registered so the superset guard is *passed* rather than tripped: this test
/// is about what a refused `/rotate` costs, and a guard that stopped the call before it happened
/// would make it a test of the wrong thing.
#[tokio::test]
async fn publish_join_marks_the_roster_dirty_when_the_relay_refuses() {
    let server = MockServer::start_async().await;
    let (conn, me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    manifest_answering(&server, &group, &[&me.device_id, "dev-remover", "tablet"]);
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group}/rotate"));
        then.status(401)
            .json_body(serde_json::json!({ "error": "unauthorized" }));
    });
    let before = identity::group(&conn).unwrap().unwrap();

    publish_join(&conn)
        .await
        .expect("a refused publish must not fail the join");

    assert!(
        identity::roster_is_dirty(&conn).unwrap(),
        "the owed publish was never marked"
    );
    assert_eq!(
        identity::group(&conn).unwrap().unwrap(),
        before,
        "a refused /rotate must leave the group exactly as it was"
    );
}

/// **The severe one.** A publish that reached an accepting relay must commit the same epoch
/// locally — without it this device sits at the epoch behind its own rotation, and its very next
/// `check_keys` reads a higher epoch with no blob for itself, which is the removal notice: the
/// device that pressed *Codes match* would dissolve its own group on its next sync.
#[tokio::test]
async fn publish_join_commits_the_epoch_it_published() {
    let server = MockServer::start_async().await;
    let (conn, me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    manifest_answering(&server, &group, &[&me.device_id, "dev-remover", "tablet"]);
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group}/rotate"));
        then.status(200)
            .json_body(serde_json::json!({ "epoch": 1 }));
    });
    let before = identity::group(&conn).unwrap().unwrap();

    publish_join(&conn)
        .await
        .expect("an accepted rotate must not fail the join");

    let after = identity::group(&conn).unwrap().unwrap();
    assert_eq!(
        after.epoch,
        before.epoch + 1,
        "a publish with no local commit leaves this device behind its own rotation"
    );
}

/// A join the relay accepted clears the debt a previous failed attempt had recorded.
#[tokio::test]
async fn publish_join_clears_the_mark_when_the_relay_accepts() {
    let server = MockServer::start_async().await;
    let (conn, me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    identity::set_roster_dirty(&conn, true).unwrap();
    manifest_answering(&server, &group, &[&me.device_id, "dev-remover", "tablet"]);
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group}/rotate"));
        then.status(200)
            .json_body(serde_json::json!({ "epoch": 1 }));
    });

    publish_join(&conn)
        .await
        .expect("an accepted rotate must not fail the join");

    assert!(
        !identity::roster_is_dirty(&conn).unwrap(),
        "the mark was not cleared on an accepted publish"
    );
}

/// **A group that has claimed and never rotated answers `devices: []`, and that must still
/// publish.** The empty manifest is a subset of everything, so the superset guard passes — which
/// is the whole of what keeps the common case (a first pairing, on a group whose membership has
/// just been connected) working at all. A guard written as an *equality* rather than a superset
/// test would stop every first join dead, with nothing on screen saying so.
#[tokio::test]
async fn publish_join_publishes_against_a_never_rotated_manifest() {
    let server = MockServer::start_async().await;
    let (conn, _me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    manifest_answering(&server, &group, &[]);
    let rotate = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group}/rotate"));
        then.status(200)
            .json_body(serde_json::json!({ "epoch": 1 }));
    });

    publish_join(&conn).await.expect("the join must publish");

    assert_eq!(rotate.calls(), 1, "an empty manifest blocked a first join");
    assert!(!identity::roster_is_dirty(&conn).unwrap());
}

/// **A device whose roster is missing somebody the relay knows about publishes nothing.**
///
/// The manifest's key set *is* the roster on every device that adopts it, so publishing one built
/// from a partial view is not a failure to add — it is an eviction. `identity::adopt_epoch` prunes
/// and never inserts (there is no public key in a manifest to insert with), so a device told about
/// a join only by adopting an epoch has exactly this partial view, and pairing from it would take
/// the peer it never heard of out of the group.
///
/// **What makes it red**: deleting the superset check. `/rotate` is then called with a manifest
/// two names short.
#[tokio::test]
async fn publish_join_refuses_to_speak_for_a_group_it_cannot_see_all_of() {
    let server = MockServer::start_async().await;
    let (conn, me, _remover, group) = keyed_group();
    set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
    // The relay knows a fourth device this one has never had a row for.
    manifest_answering(
        &server,
        &group,
        &[&me.device_id, "dev-remover", "tablet", "laptop"],
    );
    let rotate = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group}/rotate"));
        then.status(200)
            .json_body(serde_json::json!({ "epoch": 1 }));
    });
    let before = identity::group(&conn).unwrap().unwrap();

    publish_join(&conn)
        .await
        .expect("declining to publish must not fail the join");

    assert_eq!(
        rotate.calls(),
        0,
        "a device with a partial roster published a manifest for the whole group"
    );
    assert!(
        identity::roster_is_dirty(&conn).unwrap(),
        "the publish that was declined was never marked as still owed"
    );
    assert_eq!(
        identity::group(&conn).unwrap().unwrap(),
        before,
        "nothing local may move when nothing was published"
    );
}

/// **The §5.1 three-device sequence, which is the regression test spec §7 named and nobody
/// wrote.** Every other test above asserts what one device's *own* manifest contains; this one
/// drives a second device reading it back, because the eviction only exists at that seam.
///
/// The sequence, all four devices in one group at epoch 2:
///
/// 1. A PC founded the group, paired a Phone, then paired a Tablet and published a manifest
///    naming all three. The relay holds `{PC, Phone, Tablet}`.
/// 2. The Phone adopted that epoch — and `identity::adopt_epoch` **prunes and never inserts**, so
///    the Phone's own roster is still `{Phone, PC}`. It has never heard of the Tablet.
/// 3. The Phone now pairs a Laptop. `plan_join` builds its manifest from the Phone's roster.
///
/// Without the superset guard the Phone publishes `{Phone, PC, Laptop}` at epoch 3, and the
/// **Tablet**'s next `check_keys` reads a higher epoch with no blob for itself — which is the
/// removal notice — and it leaves a group nobody removed it from, silently.
///
/// **The `/keys` answer the Tablet reads is built from whatever the Phone actually posted**, so
/// this is a relay in miniature rather than a second hand-written assumption: with the guard,
/// nothing was posted and the manifest is unchanged; without it, the Tablet is served exactly the
/// epoch and key set the Phone published.
///
/// **What makes it red**: deleting the superset check in `publish_join`.
#[tokio::test]
async fn a_pairing_never_evicts_a_device_this_one_has_not_met() {
    let server = MockServer::start_async().await;
    let key = [3u8; 32];

    // The PC and the Laptop exist only as roster rows here — nothing in this test drives them.
    let pc = crypto::keypair();
    let laptop = crypto::keypair();

    let phone = crate::schema::memory_pair();
    capture::install(&phone).unwrap();
    let phone_me = identity::ensure(&phone).unwrap();
    identity::join_group(&phone, GROUP, 2, &key, &phone_me).unwrap();
    identity::add_device(&phone, "pc", &pc.public, "PC").unwrap();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();

    let tablet = crate::schema::memory_pair();
    capture::install(&tablet).unwrap();
    let tablet_me = identity::ensure(&tablet).unwrap();
    identity::join_group(&tablet, GROUP, 2, &key, &tablet_me).unwrap();
    identity::add_device(&tablet, "pc", &pc.public, "PC").unwrap();
    identity::add_device(
        &tablet,
        &phone_me.device_id,
        &phone_me.keypair.public,
        "Phone",
    )
    .unwrap();
    set_state(&tablet, RELAY_URL, &server.base_url()).unwrap();

    // What the relay holds before the Phone pairs anything: all three, and no Laptop.
    let before: Vec<String> = vec![
        "pc".to_owned(),
        phone_me.device_id.clone(),
        tablet_me.device_id.clone(),
    ];
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{GROUP}/keys"))
            .query_param("device", phone_me.device_id.clone());
        then.status(200).json_body(serde_json::json!({
            "epoch": 2,
            "blob": serde_json::Value::Null,
            "devices": before,
        }));
    });
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{GROUP}/rotate"))
            .is_true(tap(&sent));
        then.status(200)
            .json_body(serde_json::json!({ "epoch": 3 }));
    });

    // The Phone pairs a Laptop: `pairing::confirm` adds the row, then publishes.
    identity::add_device(&phone, "laptop", &laptop.public, "Laptop").unwrap();
    publish_join(&phone)
        .await
        .expect("a declined publish must not fail the join");

    // The relay, as it now stands — whatever the Phone posted, or unchanged if it posted nothing.
    let posted = sent
        .lock()
        .unwrap()
        .iter()
        .find(|seen| seen.path.ends_with("/rotate"))
        .map(|seen| serde_json::from_str::<serde_json::Value>(&seen.body).expect("json"));
    let (epoch, devices, blob) = match posted {
        Some(body) => {
            let keys = body["keys"]
                .as_object()
                .expect("a rotation carries its rewrapped keys")
                .clone();
            (
                body["epoch"].as_i64().expect("a rotation carries an epoch"),
                keys.keys().cloned().collect::<Vec<String>>(),
                keys.get(&tablet_me.device_id)
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
        }
        None => (2, before.clone(), serde_json::Value::Null),
    };
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{GROUP}/keys"))
            .query_param("device", tablet_me.device_id.clone());
        then.status(200).json_body(serde_json::json!({
            "epoch": epoch,
            "blob": blob,
            "devices": devices,
        }));
    });

    let outcome = check_keys(&tablet).await.expect("the tablet's own sync");

    assert_ne!(
        outcome,
        KeyOutcome::Removed,
        "a pairing on another device evicted this one"
    );
    assert!(
        identity::group(&tablet).unwrap().is_some(),
        "the tablet left a group nobody removed it from"
    );
    assert!(
        identity::roster_is_dirty(&phone).unwrap(),
        "the publish the phone could not safely make was not recorded as still owed"
    );
}

/// A caught-up device stops acking, which is what keeps a frequent pull cheap: an ack costs a
/// Durable Object request and, on the relay side, a compaction scan.
#[tokio::test]
async fn a_second_trip_that_moves_nothing_sends_no_ack() {
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 0 }));
    });
    let acked = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let a = paired("dev-a", 0);
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    run_once(&a).await.unwrap();
    let after_first = acked.calls();
    run_once(&a).await.unwrap();
    assert_eq!(
        acked.calls(),
        after_first,
        "nothing moved, so there is nothing to tell the relay"
    );
}

/// **The mutation this whole task exists to kill.**
///
/// The relay hands back the head of the *whole* log — this device's own rows included — while
/// `since` filters those rows out of `envelopes`. So a device that pushes and then pulls sees
/// **zero envelopes and a strictly higher cursor**, which is the normal case for whichever
/// device is doing the writing. A skip keyed on "no envelopes came back" makes that device
/// never ack: its stored ack stays at its founding value, `compact`'s floor pins there, and
/// nothing is ever compacted for the life of the group.
#[tokio::test]
async fn a_device_that_pushed_acks_even_though_no_envelopes_came_back() {
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 7 }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 7 }));
    });
    let acked = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let a = paired("dev-a", 0);
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    add_copy(&a, "c1", 1);
    run_once(&a).await.unwrap();
    acked.assert_calls(1);
    assert_eq!(get_state(&a, LAST_ACKED).as_deref(), Some("7"));
}

/// The watermark is written only when the relay took it, so a refused ack is retried.
#[tokio::test]
async fn a_failed_ack_leaves_the_watermark_unset_so_the_next_trip_retries() {
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 4 }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(500);
    });

    let a = paired("dev-a", 0);
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    assert!(run_once(&a).await.is_err());
    assert_eq!(
        get_state(&a, LAST_ACKED),
        None,
        "an ack the relay refused is not a watermark"
    );
}

/// **The test that kills `acked.is_some()`.**
///
/// The three tests above all turn on a *first* ack, where `LAST_ACKED` is `None` under both the
/// correct guard and the mutant — so none of them can tell the two apart. The divergence only
/// appears on a second trip whose cursor has moved past a watermark this device already stored:
/// the correct guard acks again, `acked.is_some()` goes quiet for ever and pins the relay's
/// compaction floor at the first value this device ever sent.
#[tokio::test]
async fn a_later_trip_acks_again_once_the_cursor_moves_past_the_stored_watermark() {
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    // Two pulls, told apart by the cursor the device asks from.
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{GROUP}/pull"))
            .query_param("since", "0");
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 4 }));
    });
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{GROUP}/pull"))
            .query_param("since", "4");
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 9 }));
    });
    let acked = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let a = paired("dev-a", 0);
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);

    run_once(&a).await.unwrap();
    assert_eq!(get_state(&a, LAST_ACKED).as_deref(), Some("4"));

    run_once(&a).await.unwrap();
    acked.assert_calls(2);
    assert_eq!(get_state(&a, LAST_ACKED).as_deref(), Some("9"));
}
