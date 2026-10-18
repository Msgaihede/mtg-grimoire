//! The device's life, natively: a real page store in memory, the core's real pairing on both
//! sides, and a relay that keeps the rendezvous's four slots and answers nothing else.

use super::*;
use grimoire_core::sync_engine::client as core_client;
use httpmock::prelude::*;
use std::collections::HashMap;

/// First write wins per `(rv, slot)`, a 404 on an empty one — the relay's rendezvous. Every other
/// route is a 404, so a trip past the pairing fails as a relay that is not there would.
struct Rendezvous {
    server: MockServer,
    posts: Arc<Mutex<Vec<String>>>,
}

impl Rendezvous {
    async fn start() -> Rendezvous {
        let server = MockServer::start_async().await;
        let store: Arc<Mutex<HashMap<String, String>>> = Arc::default();
        let posts: Arc<Mutex<Vec<String>>> = Arc::default();
        let slots = r"^/p/[0-9a-f]{32}/(offer|join|offersig|joinsig)$";
        let read = store.clone();
        server.mock(|when, then| {
            when.method(GET).path_matches(slots);
            then.respond_with(move |req: &HttpMockRequest| {
                match read.lock().unwrap().get(req.uri().path()) {
                    Some(blob) => HttpMockResponse::builder()
                        .status(200)
                        .header("content-type", "application/json")
                        .body(serde_json::json!({ "blob": blob }).to_string())
                        .build(),
                    None => HttpMockResponse::builder().status(404).build(),
                }
            });
        });
        let write = store.clone();
        let posted = posts.clone();
        server.mock(|when, then| {
            when.method(POST).path_matches(slots);
            then.respond_with(move |req: &HttpMockRequest| {
                let path = req.uri().path().to_owned();
                posted.lock().unwrap().push(path.clone());
                let body: serde_json::Value =
                    serde_json::from_str(&req.body_string()).unwrap_or_default();
                let mut store = write.lock().unwrap();
                if store.contains_key(&path) {
                    return HttpMockResponse::builder().status(409).build();
                }
                store.insert(path, body["blob"].as_str().unwrap_or_default().to_owned());
                HttpMockResponse::builder().status(204).build()
            });
        });
        Rendezvous { server, posts }
    }

    fn joins(&self) -> usize {
        self.posts
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.ends_with("/join"))
            .count()
    }
}

const KEK: [u8; 32] = [42; 32];

fn device(object: &str, store: &Arc<vfs::MemoryStore>, relay: &Rendezvous) -> Device {
    Device::open(
        object,
        store.clone(),
        &KEK,
        Options {
            relay_url: Some(relay.server.base_url()),
            scryfall_url: Some(relay.server.base_url()),
        },
    )
    .unwrap()
}

/// The desktop: a pair in memory pointed at the relay, with an invite out.
fn desktop(relay: &Rendezvous) -> (Connection, Option<pairing::Pending>, String) {
    let conn = grimoire_core::schema::memory_pair();
    core_client::set_state(&conn, core_client::RELAY_URL, &relay.server.base_url()).unwrap();
    let mut pending = None;
    let offer = pairing::begin(&conn, &mut pending).unwrap();
    (conn, pending, offer.code)
}

fn joined(answer: &Enrolled) -> (String, String, String) {
    match answer {
        Enrolled::Joined {
            ok,
            device_id,
            x25519,
            ed25519,
        } => {
            assert!(ok);
            (device_id.clone(), x25519.clone(), ed25519.clone())
        }
        Enrolled::Refused { code, error, .. } => panic!("refused {code}: {error}"),
    }
}

fn code(answer: &Enrolled) -> &'static str {
    match answer {
        Enrolled::Refused { code, .. } => code,
        Enrolled::Joined { .. } => "joined",
    }
}

#[tokio::test(flavor = "current_thread")]
async fn an_invite_pairs_the_bot_and_the_desktop_files_it_by_its_keys() {
    let relay = Rendezvous::start().await;
    let store = Arc::new(vfs::MemoryStore::new());
    let bot = device("obj-pair", &store, &relay);
    let (desk, mut desk_pending, invite) = desktop(&relay);

    assert_eq!(
        bot.status(),
        Status {
            enrolled: false,
            device_id: None,
            paired: false,
            last_pull_at: None,
            error: None
        }
    );
    let answer = bot.enroll(&invite, "read").await;
    let (device_id, x25519, ed25519) = joined(&answer);
    assert_eq!(x25519.len(), 43, "32 bytes, base64url without padding");
    assert_eq!(ed25519.len(), 43);
    let status = bot.status();
    assert!(status.enrolled && !status.paired);
    assert_eq!(status.device_id.as_deref(), Some(device_id.as_str()));

    // The answer's JSON is the front's `Enrolled`.
    let json = serde_json::to_value(&answer).unwrap();
    assert_eq!(json["ok"], true);
    assert_eq!(json["deviceId"], device_id.as_str());

    // Nothing to read yet: the desktop has not confirmed.
    let waited = bot.advance(grimoire_core::platform::clock::now_ms()).await;
    assert_eq!(waited.did, "waiting");
    assert_eq!(waited.next_in_ms, Some(POLL_MS));

    // The desktop reads the join and confirms (in PR 3 the pinned confirm; here the plain one).
    let progress = pairing::poll(
        &desk,
        &mut desk_pending,
        grimoire_core::platform::clock::now_ms(),
    )
    .await
    .unwrap();
    assert_eq!(progress.stage, "compare");
    pairing::confirm(&desk, &mut desk_pending).await.unwrap();
    let roster = identity::roster(&desk).unwrap();
    let filed = roster
        .iter()
        .find(|d| d.device_id == device_id)
        .expect("the bot is on the roster");
    assert_eq!(filed.name, NAME);
    assert_eq!(roster::key_text(&filed.public_key), x25519);

    let done = bot.advance(grimoire_core::platform::clock::now_ms()).await;
    assert_eq!(done.did, "paired");
    assert_eq!(done.next_in_ms, Some(0), "the first pull at once");
    let status = bot.status();
    assert!(status.paired && status.enrolled && status.error.is_none());

    // Paired, a second enroll is refused.
    let (_, _, again) = desktop(&relay);
    assert_eq!(code(&bot.enroll(&again, "read").await), "already_enrolled");

    // A pull trip against a relay that has no `/keys`: an error, a retry, no purge yet.
    let now = grimoire_core::platform::clock::now_ms();
    let tripped = bot.advance(now).await;
    assert_eq!(tripped.did, "failed");
    assert!(!tripped.purge);
    assert_eq!(tripped.next_in_ms, Some(RETRY_MS));
    assert!(bot.status().error.is_some());
    // …and thirty days of that is the end of the device.
    let lapsed = bot.advance(now + TOKENLESS_PURGE_MS).await;
    assert!(lapsed.purge, "{lapsed:?}");
    assert_eq!(lapsed.did, "lapsed");
}

#[tokio::test(flavor = "current_thread")]
async fn the_same_invite_twice_is_one_join_and_the_same_keys() {
    let relay = Rendezvous::start().await;
    let store = Arc::new(vfs::MemoryStore::new());
    let bot = device("obj-twice", &store, &relay);
    let (_desk, _pending, invite) = desktop(&relay);
    let first = joined(&bot.enroll(&invite, "read").await);
    let second = joined(&bot.enroll(&invite, "read").await);
    assert_eq!(first, second);
    assert_eq!(relay.joins(), 1, "the join is posted once");
}

#[tokio::test(flavor = "current_thread")]
async fn a_bad_invite_or_capability_is_refused_before_anything_is_posted() {
    let relay = Rendezvous::start().await;
    let store = Arc::new(vfs::MemoryStore::new());
    let bot = device("obj-bad", &store, &relay);
    assert_eq!(
        code(&bot.enroll("not an invite", "read").await),
        "bad_invite"
    );
    let (_desk, _pending, invite) = desktop(&relay);
    assert_eq!(code(&bot.enroll(&invite, "full").await), "bad_invite");
    assert_eq!(relay.joins(), 0);
    assert!(!bot.status().enrolled);
}

#[tokio::test(flavor = "current_thread")]
async fn a_used_invite_fails_the_pairing() {
    let relay = Rendezvous::start().await;
    let (_desk, _pending, invite) = desktop(&relay);
    let one = device("obj-used-1", &Arc::new(vfs::MemoryStore::new()), &relay);
    joined(&one.enroll(&invite, "read").await);
    let two = device("obj-used-2", &Arc::new(vfs::MemoryStore::new()), &relay);
    assert_eq!(code(&two.enroll(&invite, "read").await), "pairing_failed");
}

#[tokio::test(flavor = "current_thread")]
async fn a_pairing_lost_to_an_eviction_fails_and_a_new_invite_starts_over() {
    let relay = Rendezvous::start().await;
    let store = Arc::new(vfs::MemoryStore::new());
    let (_desk, _pending, invite) = desktop(&relay);
    let first_id = {
        let bot = device("obj-evict", &store, &relay);
        joined(&bot.enroll(&invite, "read").await).0
    };
    // A new isolate over the same storage: the identity is there, the pairing in flight is not.
    let bot = device("obj-evict", &store, &relay);
    assert!(bot.status().enrolled);
    let failed = bot.advance(grimoire_core::platform::clock::now_ms()).await;
    assert_eq!(failed.did, "failed");
    assert_eq!(failed.next_in_ms, None);
    let status = bot.status();
    assert!(!status.enrolled);
    assert_eq!(status.error.as_deref(), Some(INTERRUPTED));
    // The desktop enables again: a fresh invite, the same device.
    let (_desk2, _pending2, fresh) = desktop(&relay);
    let again = joined(&bot.enroll(&fresh, "read").await);
    assert_eq!(again.0, first_id, "the identity outlives the isolate");
    assert!(bot.status().error.is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn a_new_device_advances_nowhere() {
    let relay = Rendezvous::start().await;
    let bot = device("obj-idle", &Arc::new(vfs::MemoryStore::new()), &relay);
    let idle = bot.advance(0).await;
    assert_eq!(
        idle,
        Advanced {
            next_in_ms: None,
            purge: false,
            did: "idle"
        }
    );
}

#[tokio::test(flavor = "current_thread")]
async fn capture_is_off_so_nothing_the_bot_writes_is_an_op() {
    let relay = Rendezvous::start().await;
    let bot = device("obj-capture", &Arc::new(vfs::MemoryStore::new()), &relay);
    bot.with_conn(|conn| {
        conn.execute(
            "INSERT INTO collection_entries (card_id, set_code, collector_number, finish, quantity,
                                             created_at, updated_at)
             VALUES ('x', 'c21', '1', 'nonfoil', 1, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE collection_entries SET quantity = 3 WHERE card_id = 'x'",
            [],
        )
        .unwrap();
        let ops: i64 = conn
            .query_row("SELECT count(*) FROM sync_ops", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            ops, 0,
            "the bot's own name, its rows: no op for any of them"
        );
        // …and the trigger that refused the op still minted the row's uid.
        let unnamed: i64 = conn
            .query_row(
                "SELECT (SELECT count(*) FROM collection_entries WHERE sync_uid IS NULL)
                      + (SELECT count(*) FROM device_names WHERE sync_uid IS NULL)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unnamed, 0);
    });
}

#[tokio::test(flavor = "current_thread")]
async fn the_reads_answer_from_the_page_store() {
    let relay = Rendezvous::start().await;
    let store = Arc::new(vfs::MemoryStore::new());
    {
        let bot = device("obj-reads", &store, &relay);
        bot.with_conn(|conn| {
            crate::corpus::store_card(
                conn,
                &crate::corpus::tests::scryfall_card("sol", "Sol Ring", "c21", "263"),
            )
            .unwrap();
            conn.execute(
                "INSERT INTO collection_entries (card_id, set_code, collector_number, finish,
                                                 quantity, created_at, updated_at)
                 VALUES ('sol', 'c21', '263', 'foil', 2, 0, 0)",
                [],
            )
            .unwrap();
        });
    }
    // Another isolate: everything above came back out of sealed pages.
    let bot = device("obj-reads", &store, &relay);
    let held = bot.collection_by_name("sol ring").unwrap().unwrap();
    assert_eq!(held.total, 2);
    assert_eq!(held.lines[0].price_usd, Some(4.0));
    assert_eq!(
        bot.names("collection", "so", 25).unwrap()[0].name,
        "Sol Ring"
    );
    assert!(bot.names("folders", "", 25).is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn another_key_is_refused_in_words() {
    let relay = Rendezvous::start().await;
    let store = Arc::new(vfs::MemoryStore::new());
    drop(device("obj-kek", &store, &relay));
    let refused = Device::open("obj-kek", store.clone(), &[7; 32], Options::default());
    assert_eq!(refused.err().as_deref(), Some(WRONG_KEK));
    // The right key still opens it.
    drop(device("obj-kek", &store, &relay));
}

#[test]
fn the_kek_is_32_bytes_of_base64url() {
    use base64::Engine as _;
    let text = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]);
    assert_eq!(kek(&text).unwrap(), [7u8; 32]);
    assert_eq!(kek(&format!("{text}=")).unwrap(), [7u8; 32]);
    assert!(kek("c2hvcnQ").is_err());
    assert!(kek("***").is_err());
}
