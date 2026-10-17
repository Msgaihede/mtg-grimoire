//! The roster document against a mock relay (the Discord spec's PR 2): `/keys` carrying
//! documents, the amendment a device owes, the document a rotation carries, signed mode's rule
//! for a key change, and the capability and signature rules on a pull.
//!
//! `tests.rs`'s fixtures throughout — [`keyed_group`] for a device with real keys and a
//! roster of three (this device, the desk that plays the rotator, a tablet), [`paired`] for the
//! pull's two-database tests.

use super::*;
use crate::sync_pair::roster as rd;
use crate::sync_pair::roster::{Member, Mode, Roster};

/// A member entry, from the keys a test holds.
fn entry(device: &str, x25519: &[u8; 32], ed25519: Option<&[u8; 32]>, cap: &str) -> Member {
    Member {
        device: device.to_owned(),
        x25519: rd::key_text(x25519),
        ed25519: ed25519.map(rd::key_text),
        cap: cap.to_owned(),
        proto: identity::SIG_PROTO,
        since: 0,
    }
}

fn document(
    group: &str,
    epoch: i64,
    step: i64,
    prev: Option<String>,
    mode: Mode,
    signer: &str,
    members: Vec<Member>,
) -> Roster {
    Roster {
        v: rd::VERSION,
        group: group.to_owned(),
        epoch,
        step,
        prev,
        mode,
        signer: signer.to_owned(),
        members,
    }
}

/// A `/keys` answer from a relay that keeps rosters: `sig: 1`, the newest document beside its
/// authenticator, and the walk.
fn page(
    epoch: i64,
    blob: Option<String>,
    devices: &[&str],
    newest: Option<(&str, rd::Auth)>,
) -> serde_json::Value {
    let mut page = serde_json::json!({
        "epoch": epoch,
        "blob": blob,
        "devices": devices,
        "roster": serde_json::Value::Null,
        "rosterMac": serde_json::Value::Null,
        "rosterSig": serde_json::Value::Null,
        "rosters": [],
        "sig": 1,
    });
    if let Some((text, proof)) = newest {
        let (field, value) = proof.field();
        page["roster"] = serde_json::json!(text);
        page[field] = serde_json::json!(value);
        let mut walked = serde_json::json!({ "roster": text });
        walked[field] = serde_json::json!(value);
        page["rosters"] = serde_json::json!([walked]);
    }
    page
}

fn blob_for(
    sealer: &[u8; 32],
    me: &identity::Identity,
    group: &str,
    epoch: i64,
    key: &[u8; 32],
) -> String {
    URL_SAFE_NO_PAD.encode(
        crypto::wrap_group_key(sealer, &me.keypair.public, group, &me.device_id, epoch, key)
            .unwrap(),
    )
}

fn on_roster(conn: &Connection, device: &str) -> Option<identity::Device> {
    identity::roster(conn)
        .unwrap()
        .into_iter()
        .find(|d| d.device_id == device)
}

fn rows_for(conn: &Connection, operation: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT message FROM error_log WHERE operation = ?1")
        .unwrap();
    stmt.query_map([operation], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// A device at `group`'s epoch, keyed `key`, as `device` — a sibling whose envelopes this one
/// pulls.
fn sibling_at(device: &str, group: &Group) -> Connection {
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
        rusqlite::params![group.group_id, group.epoch, group.group_key.to_vec()],
    )
    .unwrap();
    conn
}

fn serve(server: &MockServer, group: &str, envelopes: &[&Envelope]) {
    let envelopes: Vec<serde_json::Value> = envelopes
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": envelopes, "cursor": 7 }));
    });
}

// ---------------------------------------------------------------------------------------
// F1: a member a sibling paired
// ---------------------------------------------------------------------------------------

/// ⚠ **F1 fixed, end to end.** The desk pairs a device this one never met — `dev-c` — and
/// rotates the group with a document naming it, MAC'd under the new epoch's key. This device
/// adopts the rotation and the document's member arrives on its roster with **both** of its
/// keys, so its next signed envelope verifies here, and a forgery under its name is refused.
///
/// **What makes it red**: adopting without reading the document (no row for `dev-c`), reading it
/// before the new key is held and never again (the MAC cannot be checked), or `adopt_epoch`'s
/// prune running after the document and sweeping the row it just learnt.
#[tokio::test]
async fn a_device_paired_by_a_sibling_arrives_with_its_keys_and_its_envelopes_verify() {
    let server = MockServer::start_async().await;
    let (phone, me, desk, group_id) = keyed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let new_key = [41u8; 32];
    let c_x = crypto::keypair();
    let c_sign = crypto::signing_keypair();
    let joined = document(
        &group_id,
        1,
        0,
        None,
        Mode::Open,
        "dev-remover",
        vec![
            entry(&me.device_id, &me.keypair.public, None, rd::FULL),
            entry("dev-remover", &desk.public, None, rd::FULL),
            entry("tablet", &[8u8; 32], None, rd::FULL),
            entry("dev-c", &c_x.public, Some(&c_sign.public), rd::FULL),
        ],
    );
    let text = rd::to_text(&joined);
    keys_answering(
        &server,
        &group_id,
        page(
            1,
            Some(blob_for(&desk.secret, &me, &group_id, 1, &new_key)),
            &[&me.device_id, "dev-remover", "tablet", "dev-c"],
            Some((&text, rd::Auth::Mac(rd::mac(&new_key, &group_id, &text)))),
        ),
    );

    assert_eq!(
        check_keys(&phone).await.unwrap().outcome,
        KeyOutcome::Adopted
    );

    let c = on_roster(&phone, "dev-c").expect("the sibling's joiner is on this roster");
    assert_eq!(c.public_key, c_x.public);
    assert_eq!(c.sign_public, Some(c_sign.public));
    assert_eq!(c.proto, Some(identity::SIG_PROTO));
    assert_eq!(rd::last(&phone).unwrap().unwrap().0, text);
    assert!(rows_for(&phone, "roster").is_empty());

    // Its envelopes verify here now: an honest one applies, a forgery under its name is refused.
    let group = identity::group(&phone).unwrap().unwrap();
    let c_db = sibling_at("dev-c", &group);
    add_copy(&c_db, "from-c", 2);
    let honest = wire::seal_batch(&group, "dev-c", &c_sign.secret, &outbox(&c_db)).unwrap();
    let forged = wire::seal_batch(
        &group,
        "dev-c",
        &crypto::signing_keypair().secret,
        &outbox(&c_db),
    )
    .unwrap();
    let pulls = MockServer::start_async().await;
    serve(&pulls, &group_id, &[&honest]);
    let pulled = pull(&phone, &pulls.base_url(), "access-1", Some(1))
        .await
        .unwrap();
    assert_eq!(pulled.unreadable, 0);
    assert_eq!(copies_of(&phone, "from-c"), 1);

    let pulls = MockServer::start_async().await;
    serve(&pulls, &group_id, &[&forged]);
    let pulled = pull(&phone, &pulls.base_url(), "access-1", Some(1))
        .await
        .unwrap();
    assert_eq!(
        pulled.unreadable, 1,
        "a forgery under a key learnt from the document"
    );
}

/// ⚠ **An older relay is today's relay exactly**: no `sig`, so whatever roster fields it sent are
/// not read, no amendment is built or sent, and a rotation's body carries no document. The
/// member a sibling paired stays unknown, as it always was.
#[tokio::test]
async fn an_older_relay_is_never_sent_a_document_and_none_is_read_from_it() {
    let server = MockServer::start_async().await;
    let (phone, me, desk, group_id) = keyed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let new_key = [41u8; 32];
    let c_x = crypto::keypair();
    let joined = document(
        &group_id,
        1,
        0,
        None,
        Mode::Open,
        "dev-remover",
        vec![entry("dev-c", &c_x.public, None, rd::FULL)],
    );
    let text = rd::to_text(&joined);
    let mut old = page(
        1,
        Some(blob_for(&desk.secret, &me, &group_id, 1, &new_key)),
        &[&me.device_id, "dev-remover", "tablet", "dev-c"],
        Some((&text, rd::Auth::Mac(rd::mac(&new_key, &group_id, &text)))),
    );
    old.as_object_mut().unwrap().remove("sig");
    keys_answering(&server, &group_id, old);
    let amended = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group_id}/roster"));
        then.status(204);
    });
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{group_id}/rotate"))
            .is_true(tap(&sent));
        then.status(200)
            .json_body(serde_json::json!({ "epoch": 2 }));
    });

    assert_eq!(
        check_keys(&phone).await.unwrap().outcome,
        KeyOutcome::Adopted
    );
    amend_roster(&phone).await;
    amended.assert_calls(0);
    assert!(
        on_roster(&phone, "dev-c").is_none(),
        "an older relay's fields were read"
    );
    assert!(rd::last(&phone).unwrap().is_none());

    let removal = identity::plan_rotation(&phone, "tablet").unwrap();
    post_rotation(&phone, &removal).await.unwrap();
    let body: serde_json::Value = serde_json::from_str(&sent.lock().unwrap()[0].body).unwrap();
    assert!(
        body.get("roster").is_none(),
        "an older relay was sent a document: {body}"
    );
    assert!(error_rows(&phone).is_empty(), "{:?}", error_rows(&phone));
}

/// **A document whose MAC does not match is refused, recorded once, and teaches nothing** — and
/// the key change beside it still happens, because in open mode the manifest decides.
#[tokio::test]
async fn a_forged_document_is_refused_and_teaches_nothing() {
    let server = MockServer::start_async().await;
    let (phone, me, desk, group_id) = keyed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let new_key = [41u8; 32];
    let joined = document(
        &group_id,
        1,
        0,
        None,
        Mode::Open,
        "dev-remover",
        vec![entry("dev-c", &crypto::keypair().public, None, rd::FULL)],
    );
    let text = rd::to_text(&joined);
    keys_answering(
        &server,
        &group_id,
        page(
            1,
            Some(blob_for(&desk.secret, &me, &group_id, 1, &new_key)),
            &[&me.device_id, "dev-remover", "tablet", "dev-c"],
            Some((&text, rd::Auth::Mac(rd::mac(&[1u8; 32], &group_id, &text)))),
        ),
    );

    assert_eq!(
        check_keys(&phone).await.unwrap().outcome,
        KeyOutcome::Adopted
    );
    assert!(
        on_roster(&phone, "dev-c").is_none(),
        "a forged document filed a device"
    );
    assert!(rd::last(&phone).unwrap().is_none());
    assert_eq!(rows_for(&phone, "roster"), [rd::FORGED]);

    // Asked again, the same forgery is not a second row.
    check_keys(&phone).await.unwrap();
    let count: i64 = phone
        .query_row(
            "SELECT count FROM error_log WHERE operation = 'roster'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

// ---------------------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------------------

fn amendments(sent: &Sent) -> Vec<Roster> {
    sent.lock()
        .unwrap()
        .iter()
        .filter(|seen| seen.path.ends_with("/roster"))
        .map(|seen| {
            let body: serde_json::Value = serde_json::from_str(&seen.body).unwrap();
            rd::parse(body["roster"].as_str().unwrap()).unwrap()
        })
        .collect()
}

/// ⚠ **A group paired before rosters existed learns every member's keys by each member adding
/// itself.** The relay keeps rosters and holds none for this group; the trip's amendment is the
/// group's first document — this device's own entry with both keys and this build's level,
/// beside every peer it holds, under the MAC of its epoch — and once the relay takes it, it is
/// the document the next must follow. **Driven through `run_once`**, so the amendment is shown
/// to be on the trip.
#[tokio::test]
async fn a_round_trip_amends_this_device_onto_the_groups_first_document() {
    let server = MockServer::start_async().await;
    let (phone, me, _desk, group_id) = keyed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    grant(&phone);
    keys_answering(&server, &group_id, page(0, None, &[], None));
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{group_id}/roster"))
            .is_true(tap(&sent));
        then.status(204);
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group_id}/push"));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group_id}/pull"));
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{group_id}/ack"));
        then.status(204);
    });

    run_once(&phone).await.unwrap();

    let sent_documents = amendments(&sent);
    assert_eq!(sent_documents.len(), 1, "one amendment a trip");
    let first = &sent_documents[0];
    assert_eq!(
        (first.epoch, first.step, first.prev.as_deref()),
        (0, 0, None)
    );
    assert_eq!(first.mode, Mode::Open);
    let mine = first
        .member(&me.device_id)
        .expect("this device names itself");
    assert_eq!(mine.x25519, rd::key_text(&me.keypair.public));
    assert_eq!(
        mine.ed25519.as_deref(),
        Some(rd::key_text(&identity::signing_key(&phone).unwrap().unwrap().public).as_str())
    );
    assert_eq!(mine.proto, identity::SIG_PROTO);
    assert!(first.member("dev-remover").is_some() && first.member("tablet").is_some());
    let body: serde_json::Value = serde_json::from_str(&sent.lock().unwrap()[0].body).unwrap();
    let text = body["roster"].as_str().unwrap();
    let group = identity::group(&phone).unwrap().unwrap();
    assert!(rd::mac_ok(
        &group.group_key,
        &group.group_id,
        text,
        body["rosterMac"].as_str().unwrap()
    ));
    assert!(body.get("rosterSig").is_none(), "exactly one authenticator");
    assert_eq!(rd::last(&phone).unwrap().unwrap().0, text);
}

/// **Two devices amending at once: `409 roster_conflict`, the relay read again, and the amendment
/// rebuilt on its newest — once.** The sibling's document landed between this device's `/keys` and
/// its post; the second post follows it at `step + 1`, carrying the sibling's entry untouched.
#[tokio::test]
async fn an_amendment_that_meets_a_siblings_reads_again_and_follows_it() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let server = MockServer::start_async().await;
    let (phone, me, desk, group_id) = keyed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let key = identity::group(&phone).unwrap().unwrap().group_key;
    let sibling = document(
        &group_id,
        0,
        0,
        None,
        Mode::Open,
        "dev-remover",
        vec![entry("dev-remover", &desk.public, None, rd::FULL)],
    );
    let sibling_text = rd::to_text(&sibling);
    let sibling_mac = rd::mac(&key, &group_id, &sibling_text);

    let asked = Arc::new(AtomicUsize::new(0));
    let keys_asked = asked.clone();
    let (before, after) = (
        page(0, None, &[], None),
        page(
            0,
            None,
            &[],
            Some((&sibling_text, rd::Auth::Mac(sibling_mac.clone()))),
        ),
    );
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{group_id}/keys"));
        then.respond_with(move |_: &HttpMockRequest| {
            let body = if keys_asked.fetch_add(1, Ordering::SeqCst) == 0 {
                &before
            } else {
                &after
            };
            HttpMockResponse::builder()
                .status(200)
                .header("content-type", "application/json")
                .body(body.to_string())
                .build()
        });
    });
    let posted = Arc::new(AtomicUsize::new(0));
    let roster_posted = posted.clone();
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{group_id}/roster"))
            .is_true(tap(&sent));
        then.respond_with(move |_: &HttpMockRequest| {
            if roster_posted.fetch_add(1, Ordering::SeqCst) == 0 {
                HttpMockResponse::builder()
                    .status(409)
                    .header("content-type", "application/json")
                    .body(
                        serde_json::json!({ "error": "conflict", "code": "roster_conflict" })
                            .to_string(),
                    )
                    .build()
            } else {
                HttpMockResponse::builder().status(204).build()
            }
        });
    });

    check_keys(&phone).await.unwrap();
    amend_roster(&phone).await;

    let sent_documents = amendments(&sent);
    assert_eq!(sent_documents.len(), 2, "one retry, and only one");
    let retried = &sent_documents[1];
    assert_eq!(retried.step, 1);
    assert_eq!(
        retried.prev.as_deref(),
        Some(rd::hash(&sibling_text).as_str())
    );
    assert_eq!(
        retried.member("dev-remover"),
        sibling.member("dev-remover"),
        "the sibling's own entry was rewritten"
    );
    assert!(retried.member(&me.device_id).is_some());
    assert!(error_rows(&phone).is_empty(), "{:?}", error_rows(&phone));
}

/// **A relay that keeps rosters and does not know the amendment route** — answered `404` — is
/// left alone, and nothing is recorded.
#[tokio::test]
async fn a_relay_without_the_amendment_route_is_skipped_quietly() {
    let server = MockServer::start_async().await;
    let (phone, _me, _desk, group_id) = keyed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    keys_answering(&server, &group_id, page(0, None, &[], None));
    check_keys(&phone).await.unwrap();
    amend_roster(&phone).await;
    assert!(error_rows(&phone).is_empty(), "{:?}", error_rows(&phone));
    assert!(rd::last(&phone).unwrap().is_none());
}

/// **A rotation carries the new epoch's document** — step 0, the manifest's devices as members,
/// MAC'd under the **new** key — and once the relay takes it, it is this device's last accepted
/// one.
#[tokio::test]
async fn a_rotation_carries_its_epochs_document() {
    let server = MockServer::start_async().await;
    let (phone, me, _desk, group_id) = keyed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    keys_answering(&server, &group_id, page(0, None, &[], None));
    check_keys(&phone).await.unwrap();
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{group_id}/rotate"))
            .is_true(tap(&sent));
        then.status(200)
            .json_body(serde_json::json!({ "epoch": 1 }));
    });

    let removal = identity::plan_rotation(&phone, "tablet").unwrap();
    post_rotation(&phone, &removal).await.unwrap();

    let body: serde_json::Value = serde_json::from_str(&sent.lock().unwrap()[0].body).unwrap();
    let text = body["roster"].as_str().expect("a document on the rotation");
    let carried = rd::parse(text).unwrap();
    assert_eq!(
        (carried.epoch, carried.step, carried.prev.as_deref()),
        (1, 0, None)
    );
    assert_eq!(carried.signer, me.device_id);
    let mut named: Vec<&str> = carried.members.iter().map(|m| m.device.as_str()).collect();
    named.sort_unstable();
    let mut manifest: Vec<&str> = removal.keys.iter().map(|(id, _)| id.as_str()).collect();
    manifest.sort_unstable();
    assert_eq!(named, manifest, "the document is the manifest");
    assert!(carried.member("tablet").is_none());
    assert!(rd::mac_ok(
        &removal.group.group_key,
        &group_id,
        text,
        body["rosterMac"].as_str().unwrap()
    ));
    assert_eq!(rd::last(&phone).unwrap().unwrap().0, text);
}

// ---------------------------------------------------------------------------------------
// Signed mode: the relay's word moves nothing on its own
// ---------------------------------------------------------------------------------------

/// A device in signed mode since epoch 0: its last accepted document names it and the desk as
/// full members, with their signing keys, and a `read` bot. Answers the desk's and the bot's
/// signing seeds and the bot's X25519 pair.
fn signed_group() -> (
    Connection,
    identity::Identity,
    crypto::Keypair,
    String,
    [u8; 32],
    crypto::Keypair,
    [u8; 32],
) {
    let (phone, me, desk, group_id) = keyed_group();
    let desk_seed = [0x31u8; 32];
    let bot_seed = [0x32u8; 32];
    let bot = crypto::keypair();
    let my_sign = identity::signing_key(&phone).unwrap().unwrap();
    let first = document(
        &group_id,
        0,
        0,
        None,
        Mode::Signed,
        "dev-remover",
        vec![
            entry(
                &me.device_id,
                &me.keypair.public,
                Some(&my_sign.public),
                rd::FULL,
            ),
            entry(
                "dev-remover",
                &desk.public,
                Some(&crypto::signing_public(&desk_seed)),
                rd::FULL,
            ),
            entry("tablet", &[8u8; 32], None, rd::FULL),
            entry(
                "bot",
                &bot.public,
                Some(&crypto::signing_public(&bot_seed)),
                rd::READ,
            ),
        ],
    );
    rd::accept(&phone, &rd::to_text(&first), &first, true).unwrap();
    assert_eq!(rd::mode(&phone), Mode::Signed);
    (phone, me, desk, group_id, desk_seed, bot, bot_seed)
}

/// The document after the last accepted one, at `epoch`, signed with `seed` as `signer`.
fn next_signed(
    phone: &Connection,
    group_id: &str,
    epoch: i64,
    signer: &str,
    seed: &[u8; 32],
    keep: impl Fn(&Member) -> bool,
) -> (String, rd::Auth) {
    let (last_text, last) = rd::last(phone).unwrap().unwrap();
    let next = document(
        group_id,
        epoch,
        0,
        Some(rd::hash(&last_text)),
        Mode::Signed,
        signer,
        last.members.into_iter().filter(|m| keep(m)).collect(),
    );
    let text = rd::to_text(&next);
    let sig = rd::sign(seed, &text);
    (text, rd::Auth::Sig(sig))
}

/// ⚠ **F2 closed: a `read` member cannot rotate the group, however it tries.** Its blob, sealed
/// with its own X25519 key, and its document, signed with its own key, dropping the desk: the
/// document is refused, so the epoch is held — not adopted, not obeyed as a removal — and the
/// device stays exactly where it was.
#[tokio::test]
async fn in_signed_mode_a_rotation_signed_by_a_read_member_is_held() {
    let server = MockServer::start_async().await;
    let (phone, me, _desk, group_id, _desk_seed, bot, bot_seed) = signed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let before = identity::group(&phone).unwrap().unwrap();
    let (text, proof) = next_signed(&phone, &group_id, 1, "bot", &bot_seed, |m| {
        m.device != "dev-remover"
    });
    keys_answering(
        &server,
        &group_id,
        page(
            1,
            Some(blob_for(&bot.secret, &me, &group_id, 1, &[66u8; 32])),
            &[&me.device_id, "bot"],
            Some((&text, proof)),
        ),
    );

    assert_eq!(check_keys(&phone).await.unwrap().outcome, KeyOutcome::Held);
    assert_eq!(identity::group(&phone).unwrap().unwrap(), before);
    assert!(
        on_roster(&phone, "dev-remover").is_some(),
        "the bot's manifest was obeyed"
    );
    assert_eq!(
        rows_for(&phone, "roster"),
        [rd::NOT_SIGNED_BY_A_FULL_MEMBER]
    );
    assert_eq!(rows_for(&phone, "keys").len(), 1, "the hold, once");
    check_keys(&phone).await.unwrap();
    assert_eq!(rows_for(&phone, "keys").len(), 1, "and once only");
}

/// ⚠ **A restricted device is never a sealer — in signed mode** even beside a document a full
/// member signed honestly: the blob opens only under the bot's key, the bot is not tried, and
/// nothing is adopted.
#[tokio::test]
async fn in_signed_mode_a_blob_only_a_restricted_device_sealed_is_never_opened() {
    let server = MockServer::start_async().await;
    let (phone, me, _desk, group_id, desk_seed, bot, _bot_seed) = signed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let before = identity::group(&phone).unwrap().unwrap();
    let (text, proof) = next_signed(&phone, &group_id, 1, "dev-remover", &desk_seed, |_| true);
    keys_answering(
        &server,
        &group_id,
        page(
            1,
            Some(blob_for(&bot.secret, &me, &group_id, 1, &[66u8; 32])),
            &[&me.device_id, "dev-remover", "tablet", "bot"],
            Some((&text, proof)),
        ),
    );
    assert!(
        check_keys(&phone).await.is_err(),
        "the bot's blob was opened"
    );
    assert_eq!(identity::group(&phone).unwrap().unwrap(), before);
}

/// ...**and in open mode**, for a device on file as restricted: the manifest-and-roster list of
/// candidates leaves it out too.
#[tokio::test]
async fn in_open_mode_a_restricted_device_is_never_a_sealer_either() {
    let server = MockServer::start_async().await;
    let (phone, me, _desk, group_id) = keyed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let bot = crypto::keypair();
    identity::add_device(&phone, "bot", &bot.public, "Bot").unwrap();
    identity::file_signing(&phone, "bot", &[3u8; 32], Some(rd::READ), Some(2)).unwrap();
    let before = identity::group(&phone).unwrap().unwrap();
    keys_answering(
        &server,
        &group_id,
        serde_json::json!({
            "epoch": 1,
            "blob": blob_for(&bot.secret, &me, &group_id, 1, &[66u8; 32]),
            "devices": [me.device_id.clone(), "bot"],
        }),
    );
    assert!(check_keys(&phone).await.is_err());
    assert_eq!(identity::group(&phone).unwrap().unwrap(), before);
}

/// ⚠ **"No blob for me" is a removal only on a verified document that omits this device.** On the
/// relay's word alone — a higher epoch, no blob, no document it can verify — a device in signed
/// mode holds and stays; a document the desk signed that omits it is the removal notice, and it
/// leaves. **In open mode the bare answer still removes**, as it always did.
#[tokio::test]
async fn in_signed_mode_no_blob_leaves_only_on_a_verified_document() {
    let server = MockServer::start_async().await;
    let (phone, me, _desk, group_id, desk_seed, _bot, _bot_seed) = signed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    grant(&phone);
    keys_answering(&server, &group_id, page(2, None, &[], None));
    assert_eq!(check_keys(&phone).await.unwrap().outcome, KeyOutcome::Held);
    assert!(
        identity::group(&phone).unwrap().is_some(),
        "left on the relay's word"
    );
    assert_eq!(
        entitlement::refresh_secret(&phone).as_deref(),
        Some("refresh-1")
    );

    let removal = MockServer::start_async().await;
    set_state(&phone, RELAY_URL, &removal.base_url()).unwrap();
    let my_id = me.device_id.clone();
    let (text, proof) = next_signed(&phone, &group_id, 2, "dev-remover", &desk_seed, move |m| {
        m.device != my_id
    });
    keys_answering(
        &removal,
        &group_id,
        page(
            2,
            None,
            &["dev-remover", "tablet", "bot"],
            Some((&text, proof)),
        ),
    );
    assert_eq!(
        check_keys(&phone).await.unwrap().outcome,
        KeyOutcome::Removed
    );
    assert!(
        identity::group(&phone).unwrap().is_none(),
        "a verified removal was not obeyed"
    );

    // Open mode, the same bare answer: today's removal.
    let open = MockServer::start_async().await;
    let (laptop, _, _, open_group) = keyed_group();
    set_state(&laptop, RELAY_URL, &open.base_url()).unwrap();
    keys_answering(&open, &open_group, page(2, None, &[], None));
    assert_eq!(
        check_keys(&laptop).await.unwrap().outcome,
        KeyOutcome::Removed
    );
    assert!(identity::group(&laptop).unwrap().is_none());
}

/// **The latch holds against the relay**: in signed mode an open document — under a perfectly
/// good MAC — is refused, and the mode and the last accepted document do not move.
#[tokio::test]
async fn in_signed_mode_an_open_document_is_refused_however_good_its_mac() {
    let server = MockServer::start_async().await;
    let (phone, _me, _desk, group_id, _desk_seed, _bot, _bot_seed) = signed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let (last_text, last) = rd::last(&phone).unwrap().unwrap();
    let key = identity::group(&phone).unwrap().unwrap().group_key;
    let reopened = document(
        &group_id,
        0,
        1,
        Some(rd::hash(&last_text)),
        Mode::Open,
        "dev-remover",
        last.members.clone(),
    );
    let text = rd::to_text(&reopened);
    keys_answering(
        &server,
        &group_id,
        page(
            0,
            None,
            &[],
            Some((&text, rd::Auth::Mac(rd::mac(&key, &group_id, &text)))),
        ),
    );
    check_keys(&phone).await.unwrap();
    assert_eq!(rd::mode(&phone), Mode::Signed);
    assert_eq!(rd::last(&phone).unwrap().unwrap().0, last_text);
    assert_eq!(rows_for(&phone, "roster"), [rd::BACK_TO_OPEN]);
}

/// **A signed document the desk publishes for a new epoch is adopted from the desk's blob alone**
/// — the full member, verified — and its members are the roster after.
#[tokio::test]
async fn in_signed_mode_a_full_members_rotation_is_adopted() {
    let server = MockServer::start_async().await;
    let (phone, me, desk, group_id, desk_seed, _bot, _bot_seed) = signed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let (text, proof) = next_signed(&phone, &group_id, 1, "dev-remover", &desk_seed, |m| {
        m.device != "tablet"
    });
    keys_answering(
        &server,
        &group_id,
        page(
            1,
            Some(blob_for(&desk.secret, &me, &group_id, 1, &[66u8; 32])),
            // The relay pads its manifest with the tablet; the signed document is what decides.
            &[&me.device_id, "dev-remover", "tablet", "bot"],
            Some((&text, proof)),
        ),
    );
    assert_eq!(
        check_keys(&phone).await.unwrap().outcome,
        KeyOutcome::Adopted
    );
    let after = identity::group(&phone).unwrap().unwrap();
    assert_eq!((after.epoch, after.group_key), (1, [66u8; 32]));
    assert!(
        on_roster(&phone, "tablet").is_none(),
        "the relay's padded manifest was believed"
    );
}

// ---------------------------------------------------------------------------------------
// The pull: capabilities and signed mode
// ---------------------------------------------------------------------------------------

fn copies(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT coalesce(sum(quantity), 0) FROM collection_entries",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// `dev-b` with one copy in its outbox, and its signing key.
fn signing_peer() -> (Connection, crypto::SigningKeypair) {
    let b = paired("dev-b", 0);
    add_copy(&b, "from-b", 2);
    let key = identity::signing_key(&b).unwrap().unwrap();
    (b, key)
}

/// ⚠ **A `read` device's ops are refused in full** — consumed, not unreadable: nothing applies,
/// the cursor passes them, nothing is held, no gap opens, and one row names the device however
/// many of its envelopes the page carried.
#[tokio::test]
async fn a_read_devices_ops_are_refused_and_passed() {
    let (b, key) = signing_peer();
    let group = identity::group(&b).unwrap().unwrap();
    let first = wire::seal_batch(&group, "dev-b", &key.secret, &outbox(&b)).unwrap();
    add_copy(&b, "again", 1);
    let second = wire::seal_batch(&group, "dev-b", &key.secret, &outbox(&b)[1..]).unwrap();
    let server = MockServer::start_async().await;
    serve(&server, GROUP, &[&first, &second]);

    let a = paired("dev-a", 0);
    roster(&a, "dev-b");
    identity::file_signing(&a, "dev-b", &key.public, Some(rd::READ), Some(2)).unwrap();
    let gap_before = emission::gap_open(&a).unwrap();
    let pulled = pull(&a, &server.base_url(), "access-1", None)
        .await
        .unwrap();
    assert_eq!(pulled.unreadable, 0, "consumed, not unreadable");
    assert_eq!(pulled.report.applied, 0);
    assert_eq!(copies(&a), 0, "a read device's ops applied");
    assert_eq!(
        get_state(&a, PULL_CURSOR).as_deref(),
        Some("7"),
        "the log was pinned"
    );
    assert!(read_hold(&a).is_none());
    assert_eq!(
        emission::gap_open(&a).unwrap(),
        gap_before,
        "a refusal opened a gap"
    );
    let rows = rows_for(&a, "pull");
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0].contains("may only read"), "{rows:?}");
}

/// ⚠ **In signed mode a signature is required**: unsigned from a sender whose key is on file, and
/// signed by a sender whose key this device was never given, are both refused like a forgery; a
/// signature by the key on file applies. Outside signed mode the first two apply
/// (`signed.rs`'s `an_unknown_key_and_an_unsigned_envelope_are_accepted`).
#[tokio::test]
async fn in_signed_mode_an_envelope_must_be_signed_by_a_key_on_file() {
    let (b, key) = signing_peer();
    let group = identity::group(&b).unwrap().unwrap();
    let signed = wire::seal_batch(&group, "dev-b", &key.secret, &outbox(&b)).unwrap();
    let unsigned = wire::seal_unsigned(&group, "dev-b", &outbox(&b)).unwrap();

    for (what, envelope, filed, applies) in [
        ("signed, key on file", &signed, true, true),
        ("unsigned, key on file", &unsigned, true, false),
        ("signed, no key on file", &signed, false, false),
    ] {
        let server = MockServer::start_async().await;
        serve(&server, GROUP, &[envelope]);
        let a = paired("dev-a", 0);
        roster(&a, "dev-b");
        if filed {
            identity::file_signing(&a, "dev-b", &key.public, None, Some(2)).unwrap();
        }
        rd::enter_signed_mode(&a, 0).unwrap();
        let pulled = pull(&a, &server.base_url(), "access-1", None)
            .await
            .unwrap();
        assert_eq!(copies(&a) > 0, applies, "{what}");
        assert_eq!(pulled.unreadable, usize::from(!applies), "{what}");
        assert_eq!(get_state(&a, PULL_CURSOR).as_deref(), Some("7"), "{what}");
        if !applies {
            assert_eq!(
                rows_for(&a, "pull"),
                [WireError::Unverified.to_string()],
                "{what}"
            );
        }
    }
}

/// ⚠ **In signed mode a foreign op refuses its envelope** — F3: an envelope `dev-c` signed,
/// carrying ops stamped as `dev-b`. Outside signed mode it is recorded and applied (`signed.rs`).
#[tokio::test]
async fn in_signed_mode_an_op_stamped_by_another_device_is_refused() {
    let (b, _) = signing_peer();
    let group = identity::group(&b).unwrap().unwrap();
    let carrier = crypto::signing_keypair();
    let envelope = wire::seal_batch(&group, "dev-c", &carrier.secret, &outbox(&b)).unwrap();
    let server = MockServer::start_async().await;
    serve(&server, GROUP, &[&envelope]);

    let a = paired("dev-a", 0);
    roster(&a, "dev-c");
    identity::file_signing(&a, "dev-c", &carrier.public, None, Some(2)).unwrap();
    rd::enter_signed_mode(&a, 0).unwrap();
    let pulled = pull(&a, &server.base_url(), "access-1", None)
        .await
        .unwrap();
    assert_eq!(pulled.unreadable, 1);
    assert_eq!(copies(&a), 0, "a foreign op applied in a signed group");
    assert_eq!(
        rows_for(&a, "pull"),
        [WireError::Foreign(outbox(&b).len()).to_string()]
    );
}

/// ⚠ **A document ahead of the manifest is not yet** (the relay writes a rotation's document
/// before the rotation, and takes it back if the rotation is refused): the desk's signed document
/// for epoch 1 beside a manifest still at 0 is neither taken nor refused nor obeyed — and once the
/// manifest reaches 1, the same document is what the rotation is adopted on.
#[tokio::test]
async fn a_document_ahead_of_the_manifest_waits_for_it() {
    let server = MockServer::start_async().await;
    let (phone, me, desk, group_id, desk_seed, _bot, _bot_seed) = signed_group();
    set_state(&phone, RELAY_URL, &server.base_url()).unwrap();
    let (last_text, _) = rd::last(&phone).unwrap().unwrap();
    let my_id = me.device_id.clone();
    let (text, proof) = next_signed(&phone, &group_id, 1, "dev-remover", &desk_seed, move |m| {
        m.device != my_id
    });
    keys_answering(
        &server,
        &group_id,
        page(0, None, &[], Some((&text, proof.clone()))),
    );
    assert_eq!(
        check_keys(&phone).await.unwrap().outcome,
        KeyOutcome::Current
    );
    assert_eq!(
        rd::last(&phone).unwrap().unwrap().0,
        last_text,
        "taken ahead of its rotation"
    );
    assert!(identity::group(&phone).unwrap().is_some());
    assert!(
        rows_for(&phone, "roster").is_empty(),
        "refused rather than waited for"
    );

    // The rotation lands, keeping this device: now the document at 1 decides.
    let landed = MockServer::start_async().await;
    set_state(&phone, RELAY_URL, &landed.base_url()).unwrap();
    let (text, proof) = next_signed(&phone, &group_id, 1, "dev-remover", &desk_seed, |_| true);
    keys_answering(
        &landed,
        &group_id,
        page(
            1,
            Some(blob_for(&desk.secret, &me, &group_id, 1, &[66u8; 32])),
            &[],
            Some((&text, proof)),
        ),
    );
    assert_eq!(
        check_keys(&phone).await.unwrap().outcome,
        KeyOutcome::Adopted
    );
    assert_eq!(rd::last(&phone).unwrap().unwrap().0, text);
}
