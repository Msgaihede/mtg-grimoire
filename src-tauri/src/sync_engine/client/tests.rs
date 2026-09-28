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
///
/// **This device founded the group**, so `create_group` has seeded its view (`last_manifest` =
/// `[itself]`) and its roster names everybody — the state in which a join may keep the key it
/// replaces. A test about a device with no view deletes that row, as
/// `a_device_with_no_view_of_the_group_forgets_across_a_removal_it_cannot_see` does.
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
// The backlog behind a rotation
//
// **`check_keys` runs before `pull` on every trip, so a device that was offline across a
// rotation adopts the new key first and only then sees what the group wrote under the old
// one.** Those envelopes are opened with the key of their own epoch when this device still holds
// it — `identity::group_at` — and stepped over when it does not.
// ---------------------------------------------------------------------------------------

/// The desk's own database in `group` — the device the backlog was really written on, holding
/// the key of `group.epoch`. It plays `keyed_group`'s `dev-remover`, whose keypair is the one
/// that seals the rotation, so one device is both the writer and the rotator.
fn desk_at(group: &Group) -> Connection {
    let conn = crate::schema::memory_pair();
    capture::install(&conn).unwrap();
    conn.execute(
        "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
         VALUES (1, 'dev-remover', x'00', x'01', 'Desk', 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
         VALUES (1, ?1, ?2, ?3, 0)",
        rusqlite::params![group.group_id, group.epoch, group.group_key.to_vec()],
    )
    .unwrap();
    conn
}

/// What the desk writes from here on, sealed under `group` — the ops after the first `skip`.
fn sealed_since(desk: &Connection, skip: usize, group: &Group) -> Envelope {
    wire::seal_batch(group, "dev-remover", &outbox(desk)[skip..]).unwrap()
}

/// `/keys` answering `epoch` with a blob the desk sealed to `me`, naming `devices`.
fn rotated_to(
    server: &MockServer,
    group: &str,
    desk: &crypto::Keypair,
    me: &identity::Identity,
    epoch: i64,
    devices: &[&str],
) {
    let blob = crypto::wrap_group_key(
        &desk.secret,
        &me.keypair.public,
        group,
        &me.device_id,
        epoch,
        &[40u8 + epoch as u8; 32],
    )
    .unwrap();
    keys_answering(
        server,
        group,
        serde_json::json!({
            "epoch": epoch,
            "blob": URL_SAFE_NO_PAD.encode(&blob),
            "devices": devices,
        }),
    );
}

fn copies_of(conn: &Connection, card: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .unwrap()
}

/// ⚠ **The bug this section exists for: a delete sealed before a JOIN rotation reaches a device
/// that was offline across it.** The phone holds a card; the desk deletes it at epoch 0 and then
/// pairs a new tablet, which rotates the group to epoch 1. The phone comes back, adopts epoch 1,
/// and pulls the delete. Until the superseded key was kept, `pull` stepped over every envelope
/// below the current epoch — so the delete was lost for good, and nothing repairs it: a baseline
/// carries values, and a value cannot say "this row is gone".
///
/// Driven through `run_once`, because the order inside the trip — `check_keys` first, `pull`
/// after — is the whole of how the bug happened.
///
/// **What makes it red**: `pull` opening every envelope with the current group only, or
/// `adopt_epoch` not keeping the key it replaces — the delete is then counted unreadable and the
/// card is still there.
#[tokio::test]
async fn a_delete_sealed_before_a_join_rotation_still_applies() {
    let server = MockServer::start_async().await;
    let (phone, me, desk_keys, group_id) = keyed_group();
    let epoch0 = identity::group(&phone).unwrap().unwrap();
    let desk = desk_at(&epoch0);
    add_copy(&desk, "c1", 2);
    apply::apply(&phone, &outbox(&desk)).unwrap();
    assert_eq!(copies_of(&phone, "c1"), 1, "the fixture is wrong");
    let before = outbox(&desk).len();
    desk.execute("DELETE FROM collection_entries WHERE card_id = 'c1'", [])
        .unwrap();
    let delete = sealed_since(&desk, before, &epoch0);

    // The desk paired a new tablet: epoch 1 names everyone the phone knows, and one more.
    rotated_to(
        &server,
        &group_id,
        &desk_keys,
        &me,
        1,
        &[&me.device_id, "dev-remover", "tablet", "new-tablet"],
    );
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group_id}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": [serde_json::to_value(&delete).unwrap()],
            "cursor": 5,
        }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group_id}/push"));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 6 }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group_id}/ack"));
        then.status(204);
    });
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    grant(&phone);

    let outcome = run_once(&phone).await.unwrap().unwrap();

    assert_eq!(identity::group(&phone).unwrap().unwrap().epoch, 1);
    assert_eq!(
        outcome.unreadable, 0,
        "the delete sealed before the join was stepped over"
    );
    assert_eq!(copies_of(&phone, "c1"), 0, "the desk's delete never landed");
    assert_eq!(get_state(&phone, PULL_CURSOR).as_deref(), Some("5"));
}

/// ...and what still cannot be opened is still stepped over: **an envelope from an epoch this
/// device never held a key for, and one that was altered**, while a sound envelope beside them
/// in the same page applies. Neither may stall the stream — refusing to advance would hold it
/// for the thirty days the relay keeps a tail, for nothing.
///
/// The phone paired in at epoch 1, so epoch 0's key was never its to hold; it then adopts
/// epoch 2 cleanly and keeps epoch 1's.
///
/// **What makes it red**: a sound epoch-1 envelope counted unreadable (no key kept), or the
/// epoch-0 or altered one applied or holding the cursor.
#[tokio::test]
async fn an_old_envelope_never_held_or_altered_is_still_stepped_over() {
    let server = MockServer::start_async().await;
    let (phone, me, desk_keys, group_id) = keyed_group();
    let epoch0 = identity::group(&phone).unwrap().unwrap();
    let epoch1 = Group {
        epoch: 1,
        group_key: [11u8; 32],
        ..epoch0.clone()
    };
    phone
        .execute(
            "UPDATE sync_group SET epoch = 1, group_key = ?1",
            [epoch1.group_key.to_vec()],
        )
        .unwrap();

    let desk0 = desk_at(&epoch0);
    add_copy(&desk0, "before-this-phone", 1);
    let never_held = sealed_since(&desk0, 0, &epoch0);
    let desk1 = desk_at(&epoch1);
    add_copy(&desk1, "altered", 1);
    let mut altered = sealed_since(&desk1, 0, &epoch1);
    let middle = altered.sealed.len() / 2;
    let flipped = if &altered.sealed[middle..=middle] == "A" {
        "B"
    } else {
        "A"
    };
    altered.sealed.replace_range(middle..=middle, flipped);
    let desk1b = desk_at(&epoch1);
    add_copy(&desk1b, "sound", 1);
    let sound = sealed_since(&desk1b, 0, &epoch1);

    rotated_to(
        &server,
        &group_id,
        &desk_keys,
        &me,
        2,
        &[&me.device_id, "dev-remover", "tablet"],
    );
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group_id}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": [
                serde_json::to_value(&never_held).unwrap(),
                serde_json::to_value(&altered).unwrap(),
                serde_json::to_value(&sound).unwrap(),
            ],
            "cursor": 8,
        }));
    });
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();

    assert_eq!(check_keys(&phone).await.unwrap(), KeyOutcome::Adopted);
    let (unreadable, report) = pull(&phone, &server.base_url(), "access-1").await.unwrap();

    assert_eq!(unreadable, 2, "{report:?}");
    assert_eq!(
        copies_of(&phone, "sound"),
        1,
        "a sound epoch-1 envelope was lost"
    );
    assert_eq!(copies_of(&phone, "before-this-phone"), 0);
    assert_eq!(copies_of(&phone, "altered"), 0);
    assert_eq!(
        get_state(&phone, PULL_CURSOR).as_deref(),
        Some("8"),
        "an envelope nothing here can open stalled the stream"
    );
}

/// ⚠ **A REMOVAL forgets the keys it supersedes, so the backlog behind one is stepped over as it
/// always was — and that is the security property, not a gap.** The group key is symmetric: any
/// device holding epoch 0's key can seal an envelope at epoch 0 under *any* device id, and the
/// relay does not refuse a push at a stale epoch. A removed device keeps a token for up to a
/// day, and indefinitely if it holds the refresh secret — so a remaining device that went on
/// opening epoch 0 after the tablet's removal would be accepting writes from the tablet after it
/// was removed.
///
/// **What makes it red**: keeping the superseded key across a rotation whose manifest drops a
/// device this one knew — the tablet's backlog then applies.
#[tokio::test]
async fn a_backlog_sealed_before_a_removal_is_still_stepped_over() {
    let server = MockServer::start_async().await;
    let (phone, me, desk_keys, group_id) = keyed_group();
    let epoch0 = identity::group(&phone).unwrap().unwrap();
    let desk = desk_at(&epoch0);
    add_copy(&desk, "after-the-removal", 1);
    let forged = sealed_since(&desk, 0, &epoch0);

    // The tablet is removed: epoch 1's manifest no longer names it.
    rotated_to(
        &server,
        &group_id,
        &desk_keys,
        &me,
        1,
        &[&me.device_id, "dev-remover"],
    );
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group_id}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": [serde_json::to_value(&forged).unwrap()],
            "cursor": 3,
        }));
    });
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();

    assert_eq!(check_keys(&phone).await.unwrap(), KeyOutcome::Adopted);
    let (unreadable, _) = pull(&phone, &server.base_url(), "access-1").await.unwrap();

    assert_eq!(
        unreadable, 1,
        "an epoch the removed tablet holds was opened"
    );
    assert_eq!(copies_of(&phone, "after-the-removal"), 0);
    assert_eq!(get_state(&phone, PULL_CURSOR).as_deref(), Some("3"));
}

/// ⚠ **A device with no view of the whole group forgets across ANY rotation — the removal it
/// cannot see is the case this exists for.** An install upgraded from before the key history,
/// and a device that joined by pairing, hold no last manifest; and `adopt_epoch` never inserts,
/// so a device paired by somebody else is on neither side of the comparison. Here the desk paired
/// the tablet, the phone never heard of it, and the desk removes it: to the phone the manifest
/// drops nobody it knows. Reading "no record" as "knew everybody" kept epoch 0's key — which the
/// removed tablet holds — and opened what the tablet pushed after its removal.
///
/// **What makes it red**: treating an absent last manifest as a view of the whole group.
#[tokio::test]
async fn a_device_with_no_view_of_the_group_forgets_across_a_removal_it_cannot_see() {
    let server = MockServer::start_async().await;
    let (phone, me, desk_keys, group_id) = keyed_group();
    // What an upgraded install holds: no last manifest, and no row for a device it never paired.
    phone
        .execute("DELETE FROM sync_state WHERE key = 'last_manifest'", [])
        .unwrap();
    phone
        .execute("DELETE FROM sync_devices WHERE device_id = 'tablet'", [])
        .unwrap();
    let epoch0 = identity::group(&phone).unwrap().unwrap();
    let desk = desk_at(&epoch0);
    add_copy(&desk, "from-the-removed-tablet", 1);
    let forged = sealed_since(&desk, 0, &epoch0);

    rotated_to(
        &server,
        &group_id,
        &desk_keys,
        &me,
        1,
        &[&me.device_id, "dev-remover"],
    );
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group_id}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": [serde_json::to_value(&forged).unwrap()],
            "cursor": 4,
        }));
    });
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();

    assert_eq!(check_keys(&phone).await.unwrap(), KeyOutcome::Adopted);
    let at_one = identity::group(&phone).unwrap().unwrap();
    assert!(
        identity::group_at(&phone, &at_one, 0).unwrap().is_none(),
        "epoch 0's key was kept on a view that could not see the removal"
    );
    let (unreadable, _) = pull(&phone, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(unreadable, 1);
    assert_eq!(copies_of(&phone, "from-the-removed-tablet"), 0);
    assert_eq!(get_state(&phone, PULL_CURSOR).as_deref(), Some("4"));
}

// ---------------------------------------------------------------------------------------
// Who sealed it
//
// **`/keys` does not say who rotated**, so `check_keys` tries sealers in turn — and the one
// that sealed is not always on the manifest it published. A departure is sealed by the device
// that left it; a rotation this device published and never committed is sealed by this device.
// ---------------------------------------------------------------------------------------

/// A group's `/keys` answer for `rotation`, as seen by `me`: the blob it sealed for `me`, and its
/// manifest.
fn answering_own(
    server: &MockServer,
    group: &str,
    me: &identity::Identity,
    rotation: &identity::Rotation,
) {
    let blob = rotation
        .keys
        .iter()
        .find(|(id, _)| id == &me.device_id)
        .map(|(_, blob)| blob.clone())
        .expect("the planner is on its own manifest");
    let devices: Vec<&str> = rotation.keys.iter().map(|(id, _)| id.as_str()).collect();
    keys_answering(
        server,
        group,
        serde_json::json!({
            "epoch": rotation.group.epoch,
            "blob": URL_SAFE_NO_PAD.encode(&blob),
            "devices": devices,
        }),
    );
}

/// ⚠ **A device that stays adopts the rotation a DEPARTURE published**, although the device that
/// sealed it is not on its manifest: `plan_departure` names everyone *but* the leaver, and the
/// leaver seals every blob. Trying only the manifest's devices, every device that stayed failed
/// the AEAD on every sync after anybody pressed *Leave group* — and, holding a stale auth, could
/// not mint a token either.
///
/// It also pins what the departure costs the key history: the leaver holds every key before it,
/// so the key the desk's earlier join let this device keep is forgotten.
///
/// **What makes it red**: trying only the manifest's devices as sealers — `Err`, epoch 1 stays —
/// or keeping the superseded keys across a manifest that drops the leaver.
#[tokio::test]
async fn a_device_that_stays_adopts_a_departures_rotation() {
    let (phone, me, desk_keys, group_id) = keyed_group();
    let leaver = crypto::keypair();
    identity::add_device(&phone, "leaver", &leaver.public, "Leaver").unwrap();

    // A clean join first, so there is a superseded key for the departure to forget.
    let joined = MockServer::start_async().await;
    set_state(&phone, RELAY_URL, &joined.base_url()).unwrap();
    rotated_to(
        &joined,
        &group_id,
        &desk_keys,
        &me,
        1,
        &[&me.device_id, "dev-remover", "tablet", "leaver"],
    );
    assert_eq!(check_keys(&phone).await.unwrap(), KeyOutcome::Adopted);
    let at_one = identity::group(&phone).unwrap().unwrap();
    assert!(
        identity::group_at(&phone, &at_one, 0).unwrap().is_some(),
        "the join kept nothing, so the forgetting below proves nothing"
    );

    // The leaver seals epoch 2 for everyone but itself.
    let left = MockServer::start_async().await;
    set_state(&phone, RELAY_URL, &left.base_url()).unwrap();
    rotated_to(
        &left,
        &group_id,
        &leaver,
        &me,
        2,
        &[&me.device_id, "dev-remover", "tablet"],
    );

    assert_eq!(check_keys(&phone).await.unwrap(), KeyOutcome::Adopted);

    let at_two = identity::group(&phone).unwrap().unwrap();
    assert_eq!(at_two.epoch, 2);
    assert_eq!(
        at_two.group_key, [42u8; 32],
        "the leaver's key was not taken"
    );
    assert!(
        !identity::roster(&phone)
            .unwrap()
            .iter()
            .any(|d| d.device_id == "leaver"),
        "the group never closed behind the leaver"
    );
    assert!(identity::group_at(&phone, &at_two, 1).unwrap().is_none());
    assert!(identity::group_at(&phone, &at_two, 0).unwrap().is_none());
}

/// ⚠ **A removal this device published, whose 2xx never arrived, is adopted from its own blob.**
/// `plan_rotation` seals one for every device on the roster, this one included, so the relay holds
/// a blob addressed here at *N+1* while this device still stands at *N* — a lost response or a
/// failed `commit_rotation`. Excluding itself from the sealers, the device failed `check_keys` on
/// every trip after that and never pushed again: spec §4's "self-healing" was false.
///
/// Adopting its own rotation is the commit that was lost, so it does what the commit would have
/// done: the removed device leaves the roster, the superseded keys go, and every peer that stays
/// is re-armed for a baseline (§12.4).
///
/// **What makes it red**: excluding this device from the sealers (`Err`), or not re-arming the
/// baselines when the sealer is this device.
#[tokio::test]
async fn a_removal_whose_answer_was_lost_is_adopted_from_this_devices_own_blob() {
    let server = MockServer::start_async().await;
    let (phone, me, _desk, group_id) = keyed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    phone
        .execute("UPDATE sync_devices SET baselined_at = 1000", [])
        .unwrap();
    let removal = identity::plan_rotation(&phone, "tablet").unwrap();
    answering_own(&server, &group_id, &me, &removal);

    assert_eq!(check_keys(&phone).await.unwrap(), KeyOutcome::Adopted);

    let after = identity::group(&phone).unwrap().unwrap();
    assert_eq!(
        after, removal.group,
        "this device did not reach its own epoch"
    );
    assert!(
        !identity::roster(&phone)
            .unwrap()
            .iter()
            .any(|d| d.device_id == "tablet"),
        "the removal this device published did not reach its own roster"
    );
    assert!(identity::group_at(&phone, &after, 0).unwrap().is_none());
    assert_eq!(
        baselined_at(&phone, "dev-remover"),
        None,
        "the lost commit's baseline re-arm was lost with it"
    );
}

/// ...and the same for the join rotation `publish_join` published after a pairing: adopted from
/// this device's own blob, and — a join drops nobody — the key it replaces is kept.
///
/// **What makes it red**: excluding this device from the sealers.
#[tokio::test]
async fn a_join_whose_answer_was_lost_is_adopted_from_this_devices_own_blob() {
    let server = MockServer::start_async().await;
    let (phone, me, _desk, group_id) = keyed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let before = identity::group(&phone).unwrap().unwrap();
    let join = identity::plan_join(&phone).unwrap();
    answering_own(&server, &group_id, &me, &join);

    assert_eq!(check_keys(&phone).await.unwrap(), KeyOutcome::Adopted);

    let after = identity::group(&phone).unwrap().unwrap();
    assert_eq!(after, join.group);
    assert_eq!(
        identity::group_at(&phone, &after, 0).unwrap(),
        Some(before),
        "a join this device published cost it the backlog before it"
    );
    assert_eq!(
        identity::roster(&phone).unwrap().len(),
        3,
        "a join swept somebody"
    );
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

/// A second group, for the tests that move a device from [`GROUP`] into another.
const OTHER_GROUP: &str = "fedcba9876543210";

/// A device that was deep into [`GROUP`]'s log — pulled through `cursor`, acked through `acked` —
/// and has left it and joined [`OTHER_GROUP`] under `key`, the way a *Leave group* press and a
/// pairing leave it.
fn moved_groups(cursor: &str, acked: &str, key: &[u8; 32]) -> Connection {
    let b = crate::schema::memory_pair();
    capture::install(&b).unwrap();
    let me = identity::ensure(&b).unwrap();
    identity::join_group(&b, GROUP, 0, &[7u8; 32], &me).unwrap();
    set_state(&b, PULL_CURSOR, cursor).unwrap();
    set_state(&b, LAST_ACKED, acked).unwrap();

    identity::leave_group(&b).unwrap();
    identity::join_group(&b, OTHER_GROUP, 0, key, &me).unwrap();
    b
}

/// **A device that leaves a group and joins another reads the new group's log from its first
/// row.** The relay's `seq` is an `AUTOINCREMENT` per Durable Object, which is one per group, so a
/// cursor is a position in *one* group's log and means nothing in the next. Carried across, a
/// cursor of 500 asks the new group `since=500`, and `relay/src/group.ts` seeds the head it answers
/// with the cursor it was asked — so a log seven rows long hands back no envelopes and `500`. The
/// device never receives rows 1..7 (a baseline carries current state and never a delete), and its
/// next ack tells the new group it has consumed through 500, which lets it compact rows this
/// device never read.
///
/// **What makes it red**: `PULL_CURSOR` surviving the move — forgotten by neither
/// `identity::leave_group` nor `identity::join_group`, each of which now forgets it.
#[tokio::test]
async fn a_device_that_changes_group_pulls_the_new_log_from_the_start() {
    let key = [9u8; 32];
    let a = crate::schema::memory_pair();
    capture::install(&a).unwrap();
    let a_me = identity::ensure(&a).unwrap();
    identity::join_group(&a, OTHER_GROUP, 0, &key, &a_me).unwrap();
    add_copy(&a, "c1", 2);
    let ops: Vec<Op> = {
        let sql = format!("{} ORDER BY seq", capture::OPS_SELECT);
        let mut stmt = a.prepare(&sql).unwrap();
        stmt.query_map([], capture::op_from_row)
            .unwrap()
            .map(|r| r.unwrap().1)
            .collect()
    };
    let envelope = wire::seal_batch(
        &identity::group(&a).unwrap().unwrap(),
        &a_me.device_id,
        &ops,
    )
    .unwrap();

    let server = MockServer::start_async().await;
    let from_start = server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{OTHER_GROUP}/pull"))
            .query_param("since", "0");
        then.status(200).json_body(serde_json::json!({
            "envelopes": [serde_json::to_value(&envelope).unwrap()],
            "cursor": 7,
        }));
    });
    // What the relay answers a cursor carried in from another group's log: nothing, and the same
    // number back.
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{OTHER_GROUP}/pull"))
            .query_param("since", "500");
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 500 }));
    });
    let acked = server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{OTHER_GROUP}/ack"))
            .json_body_includes(r#"{ "cursor": 7 }"#);
        then.status(204);
    });

    let b = moved_groups("500", "500", &key);
    pull(&b, &server.base_url(), "access-1").await.unwrap();
    ack(&b, &server.base_url(), "access-1").await.unwrap();

    from_start.assert_calls(1);
    let quantity: i64 = b
        .query_row(
            "SELECT coalesce(sum(quantity), 0) FROM collection_entries",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(quantity, 2, "the new group's first rows never arrived");
    assert_eq!(get_state(&b, PULL_CURSOR).as_deref(), Some("7"));
    acked.assert_calls(1);
    assert_eq!(get_state(&b, LAST_ACKED).as_deref(), Some("7"));
}

/// **...and acks the new log even at the number it last acked the old one at.** `ack` stays quiet
/// when the cursor equals the stored watermark, so a watermark carried across from the old group
/// silences the first ack of any new log whose head happens to land on it — the new group's relay
/// never hears this device at all.
///
/// **What makes it red**: `LAST_ACKED` surviving the move, as `PULL_CURSOR` does above.
#[tokio::test]
async fn a_device_that_changes_group_acks_the_new_log_at_the_old_logs_number() {
    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{OTHER_GROUP}/pull"))
            .query_param("since", "0");
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 7 }));
    });
    let acked = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{OTHER_GROUP}/ack"));
        then.status(204);
    });

    let b = moved_groups("7", "7", &[9u8; 32]);
    pull(&b, &server.base_url(), "access-1").await.unwrap();
    ack(&b, &server.base_url(), "access-1").await.unwrap();

    acked.assert_calls(1);
}

/// **A pull that lands converts user schema v52's legacy art picks behind it, captured — and a
/// pull held at an epoch converts nothing.** A paired device's launch leaves its picks alone until
/// it has heard its group (`deck_tokens::convert_legacy_picks_at_launch` has the reversion that
/// taught it), so this is where they convert: after `apply`, outside `capture::suppressed`, so the
/// entries are ops the next push announces. A page with an envelope from a newer epoch holds the
/// cursor, and may be holding exactly the peer's entries and clears the gate waits for, so it
/// neither sets the key nor converts.
#[tokio::test]
async fn a_pull_that_lands_converts_the_legacy_picks_and_one_held_at_an_epoch_does_not() {
    let b = paired("dev-b", 0);
    let deck = crate::schema::tests::deck(&b, "Tokens");
    b.execute(
        "INSERT INTO deck_tokens
             (deck_id, oracle_id, card_id, quantity, state, created_at, updated_at, sync_uid)
         VALUES (?1, 'o-treasure', 'p-treasure', 2, 'auto', 0, 0, 'u-pick')",
        [deck],
    )
    .unwrap();
    let entries = |c: &Connection| -> i64 {
        c.query_row("SELECT count(*) FROM deck_token_printings", [], |r| {
            r.get(0)
        })
        .unwrap()
    };

    // A page carrying an envelope sealed at an epoch this device has not reached.
    let a = paired("dev-a", 1);
    add_copy(&a, "c1", 1);
    let newer = identity::group(&a).unwrap().unwrap();
    let envelope = wire::seal_batch(&newer, "dev-a", &outbox(&a)).unwrap();
    let held = MockServer::start_async().await;
    held.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": [serde_json::to_value(&envelope).unwrap()],
            "cursor": 9,
        }));
    });
    pull(&b, &held.base_url(), "access-1").await.unwrap();
    assert_eq!(entries(&b), 0, "a pull held at an epoch converts nothing");
    assert_eq!(get_state(&b, crate::deck_tokens::PICKS_READY), None);

    // A page that lands.
    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 3 }));
    });
    pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(entries(&b), 2, "one entry per list");
    assert_eq!(
        get_state(&b, crate::deck_tokens::PICKS_READY).as_deref(),
        Some("1"),
        "and every launch after this one converts too"
    );
    let announced: i64 = b
        .query_row(
            "SELECT count(*) FROM sync_ops
              WHERE tbl = 'deck_token_printings' AND pushed_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        announced, 2,
        "captured: the next push announces both entries"
    );
}

// ---------------------------------------------------------------------------------------
// The cursor held for a reason, and for no longer than the reason lasts — spec 2026-09-27 §3.3
// ---------------------------------------------------------------------------------------

/// `ops` sealed exactly as given, schema stamps and all. [`wire::seal_batch`] stamps this build's
/// schema on everything it seals, so a newer device's envelope has to be made this way.
fn sealed_as_is(group: &Group, device: &str, ops: &[Op]) -> Envelope {
    let last = ops.iter().map(|o| &o.at).max().unwrap();
    wire::seal_plaintext(
        group,
        device,
        &serde_json::to_vec(ops).unwrap(),
        (last.ms, last.ctr),
    )
}

/// `op` as a newer build's batch this one cannot parse — its `kind` is one this build has never
/// heard of, and it carries the schema a newer build stamps — sealed under the group key and
/// `op`'s own stamp.
fn unparseable(group: &Group, device: &str, op: &Op) -> Envelope {
    unparseable_as(
        group,
        device,
        op,
        Some(crate::schema::USER_SCHEMA_VERSION + 1),
    )
}

/// [`unparseable`], stamped with `schema` — or with none at all, as a build before the field
/// sealed — which is what decides whether it holds.
fn unparseable_as(group: &Group, device: &str, op: &Op, schema: Option<i64>) -> Envelope {
    let mut json = serde_json::to_value(op).unwrap();
    json["kind"] = "merge".into();
    match schema {
        Some(s) => json["schema"] = s.into(),
        None => {
            json.as_object_mut().unwrap().remove("schema");
        }
    }
    let envelope = wire::seal_plaintext(
        group,
        device,
        &serde_json::to_vec(&[json]).unwrap(),
        (op.at.ms, op.at.ctr),
    );
    let opened = wire::open_batch(group, &envelope);
    if schema > Some(crate::schema::USER_SCHEMA_VERSION) {
        assert!(
            matches!(opened, Err(WireError::Newer(_))),
            "the fixture has to open, fail to parse, and say a newer build sealed it: {opened:?}"
        );
    } else {
        assert!(
            matches!(opened, Err(WireError::Malformed(_))),
            "the fixture has to open and then fail to parse: {opened:?}"
        );
    }
    envelope
}

/// A page from `dev-a` on a build one schema ahead of this one: an op on a table this build has
/// never heard of, and a `+1` of `card` behind it.
///
/// **The first is a real captured op, relabelled**, so its stamp is one `dev-a`'s clock issued
/// and sits ahead of the `+1`'s — which is what makes the `+1` collateral rather than a group of
/// its own that happens to apply.
fn a_newer_devices_page(card: &str) -> Envelope {
    let a = paired("dev-a", 0);
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Soon', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    add_copy(&a, card, 1);
    let mut ops = outbox(&a);
    assert_eq!(ops.len(), 2, "one folder insert and one +1: {ops:?}");
    ops[0].table = "future_table".to_owned();
    for op in &mut ops {
        op.schema = Some(crate::schema::USER_SCHEMA_VERSION + 1);
    }
    sealed_as_is(&identity::group(&a).unwrap().unwrap(), "dev-a", &ops)
}

/// An ordinary page from `dev-c`, on this build: one `+1` of `card`.
fn an_ordinary_page(card: &str) -> Envelope {
    let c = paired("dev-c", 0);
    add_copy(&c, card, 1);
    wire::seal_batch(&identity::group(&c).unwrap().unwrap(), "dev-c", &outbox(&c)).unwrap()
}

/// `dev-a` files a deck in a folder and adds a copy behind it. Answers `(child, parent)`: the deck
/// and the `+1`, and the folder insert the deck names — sealed apart, so a page can carry the
/// child and leave the parent to a later one.
fn a_child_and_the_parent_it_names(card: &str) -> (Envelope, Envelope) {
    a_child_and_its_parent_from("dev-a", card)
}

/// [`a_child_and_the_parent_it_names`], from `device`.
fn a_child_and_its_parent_from(device: &str, card: &str) -> (Envelope, Envelope) {
    let a = paired(device, 0);
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Binder', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('A', 'commander', (SELECT id FROM deck_folders WHERE name = 'Binder'),
                 unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    add_copy(&a, card, 1);
    let ops = outbox(&a);
    assert_eq!(ops.len(), 3, "a folder, a deck and a +1: {ops:?}");
    let group = identity::group(&a).unwrap().unwrap();
    (
        wire::seal_batch(&group, device, &ops[1..]).unwrap(),
        wire::seal_batch(&group, device, &ops[..1]).unwrap(),
    )
}

/// The relay answering every pull with `envelopes` and `cursor`, whatever `since` it is asked
/// from — which is what a relay does for a device whose cursor is held below them.
fn serving<'a>(server: &'a MockServer, envelopes: &[&Envelope], cursor: i64) -> httpmock::Mock<'a> {
    let envelopes: Vec<serde_json::Value> = envelopes
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": envelopes, "cursor": cursor }));
    })
}

/// `pull_hold` as the JSON it is stored as, or `None` when nothing is held.
fn hold_of(conn: &Connection) -> Option<serde_json::Value> {
    get_state(conn, PULL_HOLD).map(|s| serde_json::from_str(&s).unwrap())
}

/// Move the hold's `since` back by `secs` — time passing, injected through `sync_state`, which is
/// the only clock `sync_engine` reads.
fn rewind_hold(conn: &Connection, secs: i64) {
    let mut hold = hold_of(conn).expect("a hold to rewind");
    let since = hold["since"].as_i64().unwrap();
    hold["since"] = (since - secs).into();
    set_state(conn, PULL_HOLD, &hold.to_string()).unwrap();
}

/// `(rows, copies)` of `card`.
fn quantity_of(conn: &Connection, card: &str) -> (i64, i64) {
    conn.query_row(
        "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

/// **A newer device's held op keeps the cursor, and so the ack, where they were — on every pull,
/// not only the first.** The relay compacts nothing above this device's ack, so the page comes
/// back until this device updates and can apply it; stepping past it loses that device's change
/// for good.
///
/// **What makes it red**: advancing `PULL_CURSOR` whatever `apply` held.
#[tokio::test]
async fn a_newer_hold_keeps_the_cursor_and_the_ack_on_every_pull() {
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    serving(&server, &[&a_newer_devices_page("n1")], 9);
    let acked = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });
    let b = paired("dev-b", 0);
    set_state(&b, RELAY_URL, &server.base_url()).unwrap();
    grant(&b);
    // Caught up to 3, and the relay told so, before the newer device spoke.
    set_state(&b, PULL_CURSOR, "3").unwrap();
    set_state(&b, LAST_ACKED, "3").unwrap();

    for trip in ["first", "second"] {
        let outcome = run_once(&b).await.unwrap().unwrap();
        assert_eq!(
            (outcome.held_newer, outcome.applied, outcome.pulled),
            (2, 0, 0),
            "{trip}: the future table and the +1 behind it are held: {outcome:?}"
        );
        assert_eq!(
            get_state(&b, PULL_CURSOR).as_deref(),
            Some("3"),
            "{trip}: the cursor stepped past a newer device's changes"
        );
        assert_eq!(get_state(&b, LAST_ACKED).as_deref(), Some("3"), "{trip}");
        let hold = hold_of(&b).expect("no hold was written");
        assert_eq!(hold["kind"], "newer", "{trip}: {hold}");
    }
    acked.assert_calls(0);
    assert_eq!(copies_of(&b, "n1"), 0);

    // The shape is the spec's, and the blocks it holds on: the same kind on the same blocks twice
    // keeps `since` and counts the pull. `noted` is absent while nothing unreadable was met.
    let hold = hold_of(&b).unwrap();
    let mut keys: Vec<&String> = hold.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["blocks", "kind", "pulls", "since"], "{hold}");
    assert_eq!(hold["pulls"], 2, "{hold}");
    assert!(hold["since"].as_i64().unwrap() > 0, "{hold}");
    let blocked: Vec<&String> = hold["blocks"].as_object().unwrap().keys().collect();
    assert_eq!(
        blocked,
        ["dev-a"],
        "the newer device is what it holds on: {hold}"
    );
    assert!(
        error_rows(&b).is_empty(),
        "a hold is the panel's to say: {:?}",
        error_rows(&b)
    );
}

/// ⚠ **Review focus 1: a held page that also carries an ordinary peer's op applies that op once,
/// skips it on every re-delivery, and counts it once.** `pulled` is what fires `sync:applied`, and
/// every screen refreshes on it; a held cursor re-delivers the same page on every trip, so a
/// `pulled` that counted the re-delivered op again would refresh the whole app on every trip for
/// as long as the hold lasts.
///
/// **What makes it red**: `pulled` counting `skipped` (or `deferred`) again, or `apply` not
/// skipping the re-delivered `+1` (a quantity of 2).
#[tokio::test]
async fn a_held_page_applies_the_other_devices_once_and_counts_them_once() {
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    serving(
        &server,
        &[&a_newer_devices_page("n1"), &an_ordinary_page("c1")],
        9,
    );
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });
    let b = paired("dev-b", 0);
    set_state(&b, RELAY_URL, &server.base_url()).unwrap();
    grant(&b);

    let first = run_once(&b).await.unwrap().unwrap();
    assert_eq!(first.held_newer, 2, "{first:?}");
    assert_eq!(
        (first.applied, first.pulled),
        (1, 1),
        "c's +1 applied and counted: {first:?}"
    );
    assert_eq!(quantity_of(&b, "c1"), (1, 1));

    let second = run_once(&b).await.unwrap().unwrap();
    assert_eq!(second.held_newer, 2, "{second:?}");
    assert_eq!(
        second.skipped, 1,
        "c's +1 came back and was skipped: {second:?}"
    );
    assert_eq!(
        (second.applied, second.pulled),
        (0, 0),
        "a re-delivered op was counted as news: {second:?}"
    );
    assert_eq!(
        quantity_of(&b, "c1"),
        (1, 1),
        "c's +1 landed twice or never"
    );
    assert_eq!(get_state(&b, PULL_CURSOR), None);
}

/// ⚠ **Review focus 3: an envelope that opens under the group key and does not parse holds as
/// newer.** The AEAD passed, so a member of this group wrote it, and a batch this build cannot
/// read — an op `kind` it has never heard of — can only come from a build ahead of it. It is
/// still counted unreadable and noted. **An envelope whose seal fails, at the same epoch, is
/// stepped past as it always was**: nothing says a member wrote it, and holding on it would pin
/// the relay's log for bytes nobody can ever read.
///
/// **What makes it red**: dropping `WireError::Malformed`'s arm, or advancing whatever was held.
#[tokio::test]
async fn an_authentic_batch_this_build_cannot_parse_holds_as_newer() {
    let a = paired("dev-a", 0);
    add_copy(&a, "m1", 1);
    let group = identity::group(&a).unwrap().unwrap();
    let malformed = unparseable(&group, "dev-a", &outbox(&a)[0]);

    let server = MockServer::start_async().await;
    serving(&server, &[&malformed], 9);
    let b = paired("dev-b", 0);
    set_state(&b, PULL_CURSOR, "3").unwrap();
    let (unreadable, _) = pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(unreadable, 1, "still counted unreadable");
    assert_eq!(
        get_state(&b, PULL_CURSOR).as_deref(),
        Some("3"),
        "a batch only a newer build can read was stepped past"
    );
    assert_eq!(hold_of(&b).expect("no hold")["kind"], "newer");
    let rows = error_rows(&b);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].0, "pull", "still noted: {rows:?}");

    // The contrast: the same epoch, a seal that fails.
    let mut altered = wire::seal_batch(&group, "dev-a", &outbox(&a)).unwrap();
    let middle = altered.sealed.len() / 2;
    let flipped = if &altered.sealed[middle..=middle] == "A" {
        "B"
    } else {
        "A"
    };
    altered.sealed.replace_range(middle..=middle, flipped);
    assert_eq!(
        wire::open_batch(&group, &altered),
        Err(WireError::Unreadable)
    );
    let other = MockServer::start_async().await;
    serving(&other, &[&altered], 9);
    let c = paired("dev-c", 0);
    set_state(&c, PULL_CURSOR, "3").unwrap();
    let (unreadable, _) = pull(&c, &other.base_url(), "access-1").await.unwrap();
    assert_eq!(unreadable, 1);
    assert_eq!(
        get_state(&c, PULL_CURSOR).as_deref(),
        Some("9"),
        "an altered envelope held the stream"
    );
    assert_eq!(hold_of(&c), None);
}

/// **A batch that does not parse holds its sender's later batches in the page too, and only
/// those.** `apply` never sees the unparsed ops, so a later batch of the same device that did
/// parse would apply and carry that device's `sync_peers` watermark past them — and once this
/// device updates, the re-delivered batch parses, sits below the watermark, and is skipped as
/// seen: lost behind a held cursor. So the sender's batches stamped at or after the unparsed one
/// are left for the re-delivery, **by stamp and not by where the page puts them** (the later one
/// comes first here); its earlier ones are below the block and apply, and another device's
/// batches are untouched.
///
/// The update is played by the second page, where the same batch arrives parseable: it applies,
/// and the `+1` behind it lands exactly once.
///
/// **What makes it red**: applying every batch that parsed (`x2` lands on the first pull and
/// `x1` is skipped as seen on the second), or holding back by position in the page.
#[tokio::test]
async fn a_malformed_batch_holds_its_senders_later_batches_too() {
    let a = paired("dev-a", 0);
    for card in ["x0", "x1", "x2"] {
        add_copy(&a, card, 1);
    }
    let ops = outbox(&a);
    assert_eq!(ops.len(), 3, "{ops:?}");
    let group = identity::group(&a).unwrap().unwrap();
    let earlier = wire::seal_batch(&group, "dev-a", &ops[0..1]).unwrap();
    let malformed = unparseable(&group, "dev-a", &ops[1]);
    let later = wire::seal_batch(&group, "dev-a", &ops[2..3]).unwrap();
    let other = an_ordinary_page("c1");

    let server = MockServer::start_async().await;
    let first = serving(&server, &[&later, &other, &malformed, &earlier], 9);
    let b = paired("dev-b", 0);
    set_state(&b, PULL_CURSOR, "3").unwrap();
    let (unreadable, report) = pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(unreadable, 1, "{report:?}");
    assert_eq!(
        (report.held_newer, report.deferred),
        (1, 1),
        "x2 is held behind the unparsed batch, and counted there: {report:?}"
    );
    assert_eq!(
        quantity_of(&b, "x2"),
        (0, 0),
        "a later batch of the sender applied past its unparsed one"
    );
    assert_eq!(
        quantity_of(&b, "x0"),
        (1, 1),
        "an earlier batch was held back"
    );
    assert_eq!(
        quantity_of(&b, "c1"),
        (1, 1),
        "another device's batch was held back"
    );
    assert_eq!(get_state(&b, PULL_CURSOR).as_deref(), Some("3"));
    assert_eq!(hold_of(&b).expect("no hold")["kind"], "newer");
    let (mark_ms, mark_ctr): (i64, i64) = b
        .query_row(
            "SELECT last_ms, last_ctr FROM sync_peers WHERE device_id = 'dev-a'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(
        (mark_ms, mark_ctr) < (ops[1].at.ms, ops[1].at.ctr),
        "dev-a's watermark passed the unparsed batch"
    );

    // This device updates, and the same batch now parses.
    first.delete_async().await;
    let parsed = wire::seal_batch(&group, "dev-a", &ops[1..2]).unwrap();
    serving(&server, &[&later, &other, &parsed, &earlier], 9);
    let (_, landed) = pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!((landed.applied, landed.deferred), (2, 0), "{landed:?}");
    for card in ["x0", "x1", "x2", "c1"] {
        assert_eq!(quantity_of(&b, card), (1, 1), "{card}");
    }
    assert_eq!(get_state(&b, PULL_CURSOR).as_deref(), Some("9"));
    assert_eq!(hold_of(&b), None);
}

/// **A batch that opens and does not parse holds only when it says a newer build sealed it** (the
/// final review). One whose ops carry this build's schema — or none, as a build before the field
/// sealed — is a batch no update of this device will ever read: a bug, a hand-rolled client.
/// Held, it would pin the relay's floor for good and ask the reader to update a build they already
/// run. So it goes the way of an altered envelope: counted unreadable, recorded once, stepped
/// over — and its sender's later batches are not held behind it.
///
/// **What makes it red**: holding on every `WireError::Malformed`, whatever its ops say.
#[tokio::test]
async fn a_same_version_batch_that_does_not_parse_is_stepped_over_and_recorded_once() {
    for schema in [Some(crate::schema::USER_SCHEMA_VERSION), None] {
        let a = paired("dev-a", 0);
        for card in ["s1", "s2"] {
            add_copy(&a, card, 1);
        }
        let ops = outbox(&a);
        let group = identity::group(&a).unwrap().unwrap();
        let broken = unparseable_as(&group, "dev-a", &ops[0], schema);
        let later = wire::seal_batch(&group, "dev-a", &ops[1..2]).unwrap();

        let server = MockServer::start_async().await;
        serving(&server, &[&broken, &later], 9);
        let b = paired("dev-b", 0);
        set_state(&b, PULL_CURSOR, "3").unwrap();
        let (unreadable, report) = pull(&b, &server.base_url(), "access-1").await.unwrap();
        assert_eq!(unreadable, 1, "{schema:?}: still counted unreadable");
        assert_eq!(
            (report.held_newer, report.deferred, report.applied),
            (0, 0, 1),
            "{schema:?}: {report:?}"
        );
        assert_eq!(
            quantity_of(&b, "s2"),
            (1, 1),
            "{schema:?}: its sender's later batch waited behind it"
        );
        assert_eq!(
            get_state(&b, PULL_CURSOR).as_deref(),
            Some("9"),
            "{schema:?}: a batch no update can read held the stream"
        );
        assert_eq!(hold_of(&b), None, "{schema:?}");
        assert_eq!(
            error_rows(&b),
            [("pull".to_owned(), "parse".to_owned(), 1)],
            "{schema:?}: recorded once"
        );
    }
}

/// **A held pull records the batches it cannot read once, not once a pull** (the final review).
/// The page comes back on every trip for as long as the hold lasts — until the reader updates, for
/// a newer one — and a note per trip turns one unreadable batch into an `error_log` row counting
/// trips. Both kinds are here: the newer batch that holds the cursor, and a same-version one
/// stepped over in the same page and handed back with it.
///
/// **What makes it red**: noting every unreadable envelope on every pull.
#[tokio::test]
async fn a_held_pull_records_its_unreadable_batches_once() {
    let a = paired("dev-a", 0);
    add_copy(&a, "m1", 1);
    let newer = unparseable(
        &identity::group(&a).unwrap().unwrap(),
        "dev-a",
        &outbox(&a)[0],
    );
    let c = paired("dev-c", 0);
    add_copy(&c, "m2", 1);
    let broken = unparseable_as(
        &identity::group(&c).unwrap().unwrap(),
        "dev-c",
        &outbox(&c)[0],
        Some(crate::schema::USER_SCHEMA_VERSION),
    );

    let server = MockServer::start_async().await;
    serving(&server, &[&newer, &broken], 9);
    let b = paired("dev-b", 0);
    let noted = |conn: &Connection| -> i64 {
        error_rows(conn)
            .iter()
            .filter(|(operation, _, _)| operation == "pull")
            .map(|(_, _, count)| count)
            .sum()
    };
    for trip in ["first", "second", "third"] {
        let (unreadable, _) = pull(&b, &server.base_url(), "access-1").await.unwrap();
        assert_eq!(unreadable, 2, "{trip}");
        assert_eq!(
            get_state(&b, PULL_CURSOR),
            None,
            "{trip}: the fixture holds"
        );
        assert_eq!(
            noted(&b),
            2,
            "{trip}: a held pull noted the same batches again: {:?}",
            error_rows(&b)
        );
    }
}

/// **A waiting hold is released once it has been seen on three pulls spanning ten minutes — and
/// not before either.** A parent its sender owed arrives on that sender's next trip, seconds
/// later; one deleted on a third device never arrives, and holding on it for ever would pin the
/// relay's log. Released, the deck is dropped and recorded, and the `+1` behind it applies once.
///
/// **What makes it red**: releasing on the pull count alone (`early`'s third pull), on the span
/// alone (`late`'s second), never releasing, or applying the collateral twice across the release
/// and the re-delivery after it.
#[tokio::test]
async fn a_waiting_hold_releases_on_the_third_pull_after_ten_minutes() {
    let (child, _never_sent) = a_child_and_the_parent_it_names("w1");
    let server = MockServer::start_async().await;
    serving(&server, &[&child], 9);
    let base = server.base_url();

    // Three pulls inside a minute: the count is met and the span is not.
    let early = paired("dev-b", 0);
    for n in 1..=3 {
        let (_, report) = pull(&early, &base, "access-1").await.unwrap();
        assert_eq!(report.held_waiting, 2, "pull {n}: {report:?}");
        assert_eq!(
            get_state(&early, PULL_CURSOR),
            None,
            "pull {n} released a wait inside ten minutes"
        );
        let hold = hold_of(&early).unwrap();
        assert_eq!(
            (hold["kind"].as_str(), hold["pulls"].as_i64()),
            (Some("waiting"), Some(n)),
            "{hold}"
        );
    }

    // Ten minutes on the second pull: the span is met and the count is not.
    let late = paired("dev-b", 0);
    pull(&late, &base, "access-1").await.unwrap();
    rewind_hold(&late, 601);
    let (_, second) = pull(&late, &base, "access-1").await.unwrap();
    assert_eq!(
        second.held_waiting, 2,
        "the second pull released a wait: {second:?}"
    );
    assert_eq!(get_state(&late, PULL_CURSOR), None);

    // The third, past ten minutes: the deck is given up on and the +1 behind it applies.
    let (_, third) = pull(&late, &base, "access-1").await.unwrap();
    assert_eq!(
        (
            third.dropped,
            third.applied,
            third.held_waiting,
            third.deferred
        ),
        (1, 1, 0, 0),
        "{third:?}"
    );
    assert_eq!(get_state(&late, PULL_CURSOR).as_deref(), Some("9"));
    assert_eq!(hold_of(&late), None, "a released hold was left behind");
    assert_eq!(
        error_rows(&late),
        [("apply".to_owned(), "other".to_owned(), 1)],
        "the release is recorded once"
    );
    assert_eq!(quantity_of(&late, "w1"), (1, 1));

    // The page again, from a relay that has not heard the ack: nothing moves.
    let (_, again) = pull(&late, &base, "access-1").await.unwrap();
    assert_eq!((again.applied, again.dropped), (0, 0), "{again:?}");
    assert_eq!(
        quantity_of(&late, "w1"),
        (1, 1),
        "the collateral applied twice"
    );
    assert_eq!(error_rows(&late)[0].2, 1, "the release was recorded twice");
    assert_eq!(hold_of(&late), None);
}

/// ⚠ **The waiting bound belongs to the blocks it has watched, and a block it has never seen
/// starts it over** (the final review's I1). A wait nothing will end — a child whose parent a
/// third device deleted — has run its three pulls and ten minutes. Then a device that has just
/// paired pushes a child ahead of the baseline carrying its parent, which lands a trip later.
/// Counted on the old hold, the pull that meets the new child would release both, drop the new
/// device's deck and apply its `+1` — and the parent arriving seconds later would find its child
/// gone below the watermark.
///
/// A block that resolves and leaves the set is not new, so the pull after it keeps the restarted
/// `since` and counts on.
///
/// **What makes it red**: a hold that keeps `since` and counts the pull by kind alone.
#[tokio::test]
async fn a_new_waiting_block_starts_the_bound_over() {
    let (stale, _never_sent) = a_child_and_its_parent_from("dev-a", "w1");
    let (fresh, its_parent) = a_child_and_its_parent_from("dev-x", "x1");
    let server = MockServer::start_async().await;
    let base = server.base_url();
    let b = paired("dev-b", 0);

    let first = serving(&server, &[&stale], 9);
    for _ in 0..3 {
        pull(&b, &base, "access-1").await.unwrap();
    }
    rewind_hold(&b, 601);
    assert_eq!(
        hold_of(&b).unwrap()["pulls"],
        3,
        "the fixture: the next pull would release"
    );

    // dev-x pairs, and its first trip pushes a child ahead of its parent.
    first.delete_async().await;
    let second = serving(&server, &[&stale, &fresh], 10);
    let (_, met) = pull(&b, &base, "access-1").await.unwrap();
    assert_eq!(
        (met.held_waiting, met.dropped, met.applied),
        (4, 0, 0),
        "a block the hold had never seen was released on the old one's bound: {met:?}"
    );
    assert_eq!(get_state(&b, PULL_CURSOR), None);
    let restarted = hold_of(&b).unwrap();
    assert_eq!(restarted["pulls"], 1, "{restarted}");

    // The parent lands on the next trip, and the child with it; dev-a's block still waits.
    second.delete_async().await;
    serving(&server, &[&stale, &fresh, &its_parent], 11);
    let (_, landed) = pull(&b, &base, "access-1").await.unwrap();
    assert_eq!(
        (landed.applied, landed.held_waiting, landed.dropped),
        (3, 2, 0),
        "{landed:?}"
    );
    assert_eq!(
        quantity_of(&b, "x1"),
        (1, 1),
        "the new device's child was lost"
    );
    assert_eq!(quantity_of(&b, "w1"), (0, 0));
    let kept = hold_of(&b).unwrap();
    assert_eq!(
        (&kept["since"], &kept["pulls"]),
        (&restarted["since"], &serde_json::json!(2)),
        "a block that resolved and left the set started the bound over: {kept}"
    );
}

/// **A release that uncovers a newer op holds it as newer rather than advancing past it.**
/// Collateral takes the class of the block it sits behind, so a device that pushed a waiting child
/// from this build and then, updated, an op this build cannot apply reports both as *waiting* —
/// the newer op is only classified once the release attempts it. The release drops the child as
/// it should; a cursor that then moved would lose the newer op for good.
///
/// **What makes it red**: advancing after every release, whatever the release pass held.
#[tokio::test]
async fn a_release_that_uncovers_a_newer_op_holds_it_as_newer() {
    let a = paired("dev-a", 0);
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Binder', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('A', 'commander', (SELECT id FROM deck_folders WHERE name = 'Binder'),
                 unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Soon', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let ops = outbox(&a);
    assert_eq!(ops.len(), 3, "{ops:?}");
    let group = identity::group(&a).unwrap().unwrap();
    // The deck, from this build; the folder never sent.
    let child = wire::seal_batch(&group, "dev-a", &ops[1..2]).unwrap();
    // Then dev-a updates, and its next op is on a table this build does not have.
    let mut future = ops[2].clone();
    future.table = "future_table".to_owned();
    future.schema = Some(crate::schema::USER_SCHEMA_VERSION + 1);
    let newer = sealed_as_is(&group, "dev-a", &[future]);

    let server = MockServer::start_async().await;
    serving(&server, &[&child, &newer], 9);
    let b = paired("dev-b", 0);
    for _ in 0..2 {
        let (_, report) = pull(&b, &server.base_url(), "access-1").await.unwrap();
        assert_eq!(
            (report.held_waiting, report.held_newer),
            (2, 0),
            "the fixture: the newer op waits behind the child: {report:?}"
        );
    }
    rewind_hold(&b, 601);

    let (_, released) = pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(
        (released.dropped, released.held_newer, released.deferred),
        (1, 1, 1),
        "{released:?}"
    );
    assert_eq!(
        get_state(&b, PULL_CURSOR),
        None,
        "the release stepped past the newer op it uncovered"
    );
    let hold = hold_of(&b).expect("no hold");
    assert_eq!(
        (hold["kind"].as_str(), hold["pulls"].as_i64()),
        (Some("newer"), Some(1)),
        "a newer hold starts over rather than inheriting the wait's span: {hold}"
    );
    assert_eq!(
        error_rows(&b),
        [("apply".to_owned(), "other".to_owned(), 1)]
    );

    // The next pull: the child is below its watermark now, and the newer op still holds.
    let (_, again) = pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(
        (again.skipped, again.held_newer, again.dropped),
        (1, 1, 0),
        "{again:?}"
    );
    assert_eq!(get_state(&b, PULL_CURSOR), None);
    assert_eq!(hold_of(&b).unwrap()["pulls"], 2);
    assert_eq!(
        error_rows(&b)[0].2,
        1,
        "the dropped child was recorded twice"
    );
}

/// ⚠ **Review focus 4: a waiting hold whose parent arrives on the next pull applies, clears
/// `pull_hold`, advances, and records nothing.** This is the ordinary case the hold exists for —
/// a first contact where the child is pushed ahead of the baseline that carries its parent.
///
/// **What makes it red**: advancing past the held child (the second page is asked for from the
/// same `since`, so a moved cursor finds no mock), or a hold that outlives what it waited for.
#[tokio::test]
async fn a_waiting_hold_clears_when_the_parent_arrives() {
    let (child, parent) = a_child_and_the_parent_it_names("w1");
    let page = |envelopes: &[&Envelope], cursor: i64| {
        let envelopes: Vec<serde_json::Value> = envelopes
            .iter()
            .map(|e| serde_json::to_value(e).unwrap())
            .collect();
        serde_json::json!({ "envelopes": envelopes, "cursor": cursor })
    };
    let server = MockServer::start_async().await;
    let first = server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{GROUP}/pull"))
            .query_param("since", "0");
        then.status(200).json_body(page(&[&child], 5));
    });
    let b = paired("dev-b", 0);
    let (_, held) = pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(held.held_waiting, 2, "{held:?}");
    assert_eq!(hold_of(&b).expect("no hold")["kind"], "waiting");

    // The sender's next trip: the log has grown by the parent, asked for from where b stood.
    first.delete_async().await;
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{GROUP}/pull"))
            .query_param("since", "0");
        then.status(200).json_body(page(&[&child, &parent], 6));
    });
    let (_, landed) = pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(
        (landed.applied, landed.dropped, landed.deferred),
        (3, 0, 0),
        "the folder, the deck and the +1: {landed:?}"
    );
    assert_eq!(get_state(&b, PULL_CURSOR).as_deref(), Some("6"));
    assert_eq!(hold_of(&b), None);
    assert!(error_rows(&b).is_empty(), "{:?}", error_rows(&b));
    assert_eq!(quantity_of(&b, "w1"), (1, 1));
    let filed: i64 = b
        .query_row(
            "SELECT count(*) FROM decks d JOIN deck_folders f ON f.id = d.folder_id
              WHERE d.name = 'A' AND f.name = 'Binder'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(filed, 1, "the deck landed outside the folder it names");
}

/// ⚠ **Review focus 5: a newer hold has no bound.** Held across restarts — `pull_hold` is a
/// `sync_state` row, so a restart is this row surviving — for nearly three hours and fifty pulls,
/// far past the waiting bound, it still holds: only updating this device resolves it.
///
/// **What makes it red**: the waiting bound applied to either kind of hold, or a newer hold's
/// `since` restarted by the pull that keeps it.
#[tokio::test]
async fn a_newer_hold_is_never_released_by_the_waiting_bound() {
    let server = MockServer::start_async().await;
    serving(&server, &[&a_newer_devices_page("n1")], 9);
    let b = paired("dev-b", 0);
    pull(&b, &server.base_url(), "access-1").await.unwrap();
    let mut hold = hold_of(&b).unwrap();
    let since = hold["since"].as_i64().unwrap() - 10_000;
    hold["since"] = since.into();
    hold["pulls"] = 50.into();
    set_state(&b, PULL_HOLD, &hold.to_string()).unwrap();

    let (_, report) = pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(
        (report.held_newer, report.dropped, report.applied),
        (2, 0, 0),
        "{report:?}"
    );
    assert_eq!(
        get_state(&b, PULL_CURSOR),
        None,
        "a newer hold was released"
    );
    hold["pulls"] = 51.into();
    assert_eq!(hold_of(&b).unwrap(), hold);
    assert!(error_rows(&b).is_empty(), "{:?}", error_rows(&b));
}

/// **A hold a build before the blocks were stored wrote still reads, as a hold on blocks nobody
/// knows** — `{"kind","since","pulls"}` and nothing else. The panel reads its kind as it always
/// did, and the next pull starts the count over on the blocks it finds, rather than letting a
/// count about some earlier page release this one.
///
/// **What makes it red**: a row without `blocks` failing to parse (the panel stops saying
/// *update*), or read as a hold on no blocks — which every block set is a subset of — keeping its
/// old count.
#[tokio::test]
async fn a_hold_written_before_its_blocks_were_stored_reads_and_starts_over() {
    let (child, _never_sent) = a_child_and_the_parent_it_names("w1");
    let server = MockServer::start_async().await;
    serving(&server, &[&child], 9);
    let b = paired("dev-b", 0);
    set_state(&b, PULL_HOLD, r#"{"kind":"waiting","since":1,"pulls":7}"#).unwrap();
    assert_eq!(
        read_hold(&b).map(|h| h.kind).as_deref(),
        Some("waiting"),
        "an old row stopped reading"
    );

    let (_, report) = pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(
        (report.held_waiting, report.dropped),
        (2, 0),
        "an old count released a page it never saw: {report:?}"
    );
    let hold = hold_of(&b).unwrap();
    assert_eq!(hold["pulls"], 1, "{hold}");
    assert!(hold["since"].as_i64().unwrap() > 1, "{hold}");
    assert!(hold["blocks"]["dev-a"].is_array(), "{hold}");
}

/// **An ordinary page advances and clears whatever hold was left** — a newer one this device's
/// update has since resolved, or a waiting one whose parent came some other way. Either left
/// behind would go on saying so: the panel draws `"newer"` as a sentence asking for an update.
#[tokio::test]
async fn an_ordinary_page_advances_and_clears_a_stale_hold() {
    for kind in ["newer", "waiting"] {
        let server = MockServer::start_async().await;
        serving(&server, &[&an_ordinary_page("c1")], 4);
        let b = paired("dev-b", 0);
        set_state(
            &b,
            PULL_HOLD,
            &serde_json::json!({ "kind": kind, "since": 1, "pulls": 2 }).to_string(),
        )
        .unwrap();

        let (_, report) = pull(&b, &server.base_url(), "access-1").await.unwrap();
        assert_eq!(report.applied, 1, "{kind}: {report:?}");
        assert_eq!(get_state(&b, PULL_CURSOR).as_deref(), Some("4"), "{kind}");
        assert_eq!(hold_of(&b), None, "{kind}: a stale hold outlived the page");
    }
}

/// **No legacy pick converts behind a held pull, even on a device whose gate is already open.** A
/// held pull has not heard everything — the held page may be exactly the peer's entries and the
/// clears the conversion must not outrank — which is the gate's own reason for waiting on a pull
/// at all. The first pull that advances converts.
#[tokio::test]
async fn no_legacy_pick_conversion_runs_behind_a_held_pull() {
    let b = paired("dev-b", 0);
    let deck = crate::schema::tests::deck(&b, "Tokens");
    b.execute(
        "INSERT INTO deck_tokens
             (deck_id, oracle_id, card_id, quantity, state, created_at, updated_at, sync_uid)
         VALUES (?1, 'o-treasure', 'p-treasure', 2, 'auto', 0, 0, 'u-pick')",
        [deck],
    )
    .unwrap();
    set_state(&b, crate::deck_tokens::PICKS_READY, "1").unwrap();
    let entries = |c: &Connection| -> i64 {
        c.query_row("SELECT count(*) FROM deck_token_printings", [], |r| {
            r.get(0)
        })
        .unwrap()
    };

    let held = MockServer::start_async().await;
    serving(&held, &[&a_newer_devices_page("n1")], 9);
    pull(&b, &held.base_url(), "access-1").await.unwrap();
    assert_eq!(entries(&b), 0, "a pull held for a newer device converted");
    assert_eq!(get_state(&b, PULL_CURSOR), None, "the pull did not hold");

    let server = MockServer::start_async().await;
    serving(&server, &[], 3);
    pull(&b, &server.base_url(), "access-1").await.unwrap();
    assert_eq!(entries(&b), 2, "the pull that advanced did not convert");
}
