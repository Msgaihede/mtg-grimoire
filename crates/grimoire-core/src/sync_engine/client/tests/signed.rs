//! Signed envelopes (user schema v66, the Discord spec's PR 1): every envelope this device pushes
//! is signed, and a pulled one is verified when — and only when — this device holds the sender's
//! key.
//!
//! `tests.rs`'s fixtures throughout. [`paired`] writes an identity **with no signing key**, which
//! is exactly the row user schema v66's rung leaves on an install paired before it — so every
//! push here is also the first push of an upgraded device, minting its key on absence.

use super::*;

/// What `relay` hands back for a pull: these envelopes and the cursor `7`, once and for good.
fn serving(server: &MockServer, envelopes: &[&Envelope]) {
    let envelopes: Vec<serde_json::Value> = envelopes
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": envelopes,
            "cursor": 7,
        }));
    });
}

/// `dev-b` with one copy in its outbox, and its signing key — minted on absence, as its first
/// push would.
fn a_signing_peer() -> (Connection, crypto::SigningKeypair) {
    let b = paired("dev-b", 0);
    add_copy(&b, "from-b", 2);
    let key = identity::signing_key(&b).unwrap().unwrap();
    (b, key)
}

/// `dev-a`, with `dev-b` on its roster — under `key` when one is given, as the pairing slots of
/// the spec's PR 2 will file it.
fn a_receiver(key: Option<&[u8; 32]>) -> Connection {
    let a = paired("dev-a", 0);
    roster(&a, "dev-b");
    if let Some(key) = key {
        identity::file_signing(&a, "dev-b", key, None, Some(identity::SIG_PROTO)).unwrap();
    }
    a
}

fn copies(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT coalesce(sum(quantity), 0) FROM collection_entries",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// **Every envelope a round trip pushes carries `sig`, and the sender's key verifies it** — the
/// ordinary push and the baseline alike, the two callers of `post_ops`. The device's identity is
/// v65's, with no signing key, so the key it signs with is the one its first push minted, and
/// that is the key the database now holds.
#[tokio::test]
async fn every_envelope_a_round_trip_pushes_is_signed() {
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
    serving(&server, &[]);
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let a = paired("dev-a", 0);
    let unsigned: i64 = a
        .query_row(
            "SELECT count(*) FROM sync_identity WHERE sign_secret IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unsigned, 1, "the fixture is an identity from before v66");
    add_copy(&a, "c1", 1);
    roster(&a, "dev-b");
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    let outcome = run_once(&a).await.unwrap().unwrap();
    assert!(
        outcome.baseline_ops > 0,
        "the fixture is about a baseline too"
    );

    let key = identity::signing_key(&a).unwrap().unwrap();
    let group = identity::group(&a).unwrap().unwrap();
    let envelopes: Vec<Envelope> = sent
        .lock()
        .unwrap()
        .iter()
        .filter(|seen| seen.path.ends_with("/push"))
        .map(|seen| serde_json::from_str(&seen.body).unwrap())
        .collect();
    let mut baselines = 0;
    let mut ordinary = 0;
    for envelope in &envelopes {
        assert!(envelope.sig.is_some(), "an unsigned push: {envelope:?}");
        assert_eq!(
            wire::signature(envelope, Some(&key.public)),
            wire::Signed::Verified
        );
        let ops = wire::open_batch(&group, envelope).unwrap();
        assert_eq!(
            wire::foreign_ops(envelope, &ops),
            0,
            "own ops, own envelope"
        );
        if ops.iter().any(|op| op.baseline) {
            baselines += 1;
        } else {
            ordinary += 1;
        }
    }
    assert!(ordinary > 0, "the outbox was pushed");
    assert!(baselines > 0, "and the baseline");
}

/// **A signature from a sender whose key is on file is verified, and an honest one applies.**
#[tokio::test]
async fn an_envelope_signed_by_a_known_key_applies() {
    let (b, key) = a_signing_peer();
    let group = identity::group(&b).unwrap().unwrap();
    let envelope = wire::seal_batch(&group, "dev-b", &key.secret, &outbox(&b)).unwrap();
    let server = MockServer::start_async().await;
    serving(&server, &[&envelope]);

    let a = a_receiver(Some(&key.public));
    let pulled = pull(&a, &server.base_url(), "access-1", None)
        .await
        .unwrap();
    assert_eq!(pulled.unreadable, 0);
    assert!(pulled.report.applied > 0);
    assert_eq!(copies(&a), 2);
    assert!(error_rows(&a).is_empty(), "{:?}", error_rows(&a));
}

/// **A forgery is refused before it is opened, and stepped over like an unreadable batch** — the
/// cursor moves past it, so it pins nothing, and one `error_log` row says so. Two forgeries: a
/// valid signature on an envelope a relay restamped (the clock fields the AEAD never covered),
/// and an envelope signed by somebody holding the group key who is not the device it names.
#[tokio::test]
async fn a_forged_signature_is_refused_and_stepped_over() {
    let (b, key) = a_signing_peer();
    let group = identity::group(&b).unwrap().unwrap();
    let mut restamped = wire::seal_batch(&group, "dev-b", &key.secret, &outbox(&b)).unwrap();
    restamped.hlc_ms += 1;
    let impostor = crypto::signing_keypair();
    let by_another = wire::seal_batch(&group, "dev-b", &impostor.secret, &outbox(&b)).unwrap();
    assert!(
        wire::open_batch(&group, &restamped).is_ok(),
        "the AEAD alone would have taken the restamp"
    );

    for (what, envelope) in [("restamped", restamped), ("another key", by_another)] {
        let server = MockServer::start_async().await;
        serving(&server, &[&envelope]);
        let a = a_receiver(Some(&key.public));
        let pulled = pull(&a, &server.base_url(), "access-1", None)
            .await
            .unwrap();
        assert_eq!(pulled.unreadable, 1, "{what}");
        assert_eq!(pulled.report.applied, 0, "{what}");
        assert_eq!(copies(&a), 0, "{what}: a forgery applied");
        assert_eq!(
            get_state(&a, PULL_CURSOR).as_deref(),
            Some("7"),
            "{what}: a forgery pinned the log"
        );
        let rows = error_rows(&a);
        assert_eq!(rows.len(), 1, "{what}: {rows:?}");
        assert_eq!((rows[0].0.as_str(), rows[0].2), ("pull", 1), "{what}");
        let message: String = a
            .query_row("SELECT message FROM error_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(message, WireError::Forged.to_string(), "{what}");
    }
}

/// **Open mode**: an envelope signed by a sender whose key this device was never given, and an
/// unsigned envelope from a sender whose key it holds (a build from before v66 on that device),
/// both apply as they always did. The spec's PR 2 is what refuses the second in a signed group.
#[tokio::test]
async fn an_unknown_key_and_an_unsigned_envelope_are_accepted() {
    let (b, key) = a_signing_peer();
    let group = identity::group(&b).unwrap().unwrap();
    let signed = wire::seal_batch(&group, "dev-b", &key.secret, &outbox(&b)).unwrap();
    let unsigned = wire::seal_unsigned(&group, "dev-b", &outbox(&b)).unwrap();

    for (what, envelope, filed) in [
        ("an unknown key", signed, None),
        ("no signature", unsigned, Some(&key.public)),
    ] {
        let server = MockServer::start_async().await;
        serving(&server, &[&envelope]);
        let a = a_receiver(filed);
        let pulled = pull(&a, &server.base_url(), "access-1", None)
            .await
            .unwrap();
        assert_eq!(pulled.unreadable, 0, "{what}");
        assert_eq!(copies(&a), 2, "{what}");
        assert!(error_rows(&a).is_empty(), "{what}: {:?}", error_rows(&a));
    }
}

/// **An op stamped by another device than the envelope's is recorded once and applied** — the
/// record-only arm of `OP_BINDING`, which the spec's PR 2 flips to refusing. The envelope is
/// labelled `dev-c` and its ops are `dev-b`'s: AEAD and signature are both `dev-c`'s and both
/// hold, so only the binding can see it.
#[tokio::test]
async fn an_op_stamped_by_another_device_is_recorded_and_applied() {
    let (b, _) = a_signing_peer();
    let group = identity::group(&b).unwrap().unwrap();
    let carrier = crypto::signing_keypair();
    let envelope = wire::seal_batch(&group, "dev-c", &carrier.secret, &outbox(&b)).unwrap();
    let server = MockServer::start_async().await;
    serving(&server, &[&envelope]);

    let a = a_receiver(None);
    roster(&a, "dev-c");
    identity::file_signing(&a, "dev-c", &carrier.public, None, None).unwrap();
    let pulled = pull(&a, &server.base_url(), "access-1", None)
        .await
        .unwrap();
    assert_eq!(pulled.unreadable, 0, "recorded, not refused");
    assert_eq!(copies(&a), 2);
    assert_eq!(get_state(&a, PULL_CURSOR).as_deref(), Some("7"));

    let rows: Vec<(String, String, String, i64)> = {
        let mut stmt = a
            .prepare("SELECT operation, kind, message, count FROM error_log")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let foreign = outbox(&b).len();
    assert_eq!(
        rows,
        [(
            "pull".to_owned(),
            "other".to_owned(),
            WireError::Foreign(foreign).to_string(),
            1
        )],
        "one row for the envelope, not one per op"
    );
}
