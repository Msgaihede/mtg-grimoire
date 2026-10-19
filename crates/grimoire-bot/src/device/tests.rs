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
    let answer = bot.enroll(&invite, "add").await;
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
    assert_eq!(code(&bot.enroll(&again, "add").await), "already_enrolled");

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
    let first = joined(&bot.enroll(&invite, "add").await);
    let second = joined(&bot.enroll(&invite, "add").await);
    assert_eq!(first, second);
    assert_eq!(relay.joins(), 1, "the join is posted once");
}

#[tokio::test(flavor = "current_thread")]
async fn a_bad_invite_or_capability_is_refused_before_anything_is_posted() {
    let relay = Rendezvous::start().await;
    let store = Arc::new(vfs::MemoryStore::new());
    let bot = device("obj-bad", &store, &relay);
    assert_eq!(
        code(&bot.enroll("not an invite", "add").await),
        "bad_invite"
    );
    let (_desk, _pending, invite) = desktop(&relay);
    assert_eq!(code(&bot.enroll(&invite, "full").await), "bad_invite");
    assert_eq!(
        code(&bot.enroll(&invite, "read").await),
        "bad_invite",
        "nothing pairs as read any more (§14.1)"
    );
    assert_eq!(relay.joins(), 0);
    assert!(!bot.status().enrolled);
}

#[tokio::test(flavor = "current_thread")]
async fn a_used_invite_fails_the_pairing() {
    let relay = Rendezvous::start().await;
    let (_desk, _pending, invite) = desktop(&relay);
    let one = device("obj-used-1", &Arc::new(vfs::MemoryStore::new()), &relay);
    joined(&one.enroll(&invite, "add").await);
    let two = device("obj-used-2", &Arc::new(vfs::MemoryStore::new()), &relay);
    assert_eq!(code(&two.enroll(&invite, "add").await), "pairing_failed");
}

#[tokio::test(flavor = "current_thread")]
async fn a_pairing_lost_to_an_eviction_fails_and_a_new_invite_starts_over() {
    let relay = Rendezvous::start().await;
    let store = Arc::new(vfs::MemoryStore::new());
    let (_desk, _pending, invite) = desktop(&relay);
    let first_id = {
        let bot = device("obj-evict", &store, &relay);
        joined(&bot.enroll(&invite, "add").await).0
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
    let again = joined(&bot.enroll(&fresh, "add").await);
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

/// A device as a completed pairing leaves an `add` bot: in a group, paired, pulled once, and filed
/// on its own roster with the `add` capability — with the collection's default folder, a binder and a
/// deck's folder, as the desktop's rows would have arrived.
fn an_add_bot(object: &str, relay: &Rendezvous) -> Device {
    let bot = device(object, &Arc::new(vfs::MemoryStore::new()), relay);
    bot.with_conn(|conn| {
        let me = identity::ensure(conn).unwrap();
        conn.execute(
            "INSERT INTO sync_devices (device_id, public_key, name, added_at, capability, proto)
             VALUES (?1, ?2, ?3, 0, 'add', ?4)
             ON CONFLICT (device_id) DO UPDATE SET capability = 'add'",
            rusqlite::params![
                me.device_id,
                me.keypair.public.to_vec(),
                NAME,
                identity::PROTO
            ],
        )
        .unwrap();
        set(conn, PHASE, PAIRED).unwrap();
        set(conn, LAST_PULL, "1").unwrap();
        conn.execute_batch(
            "INSERT OR IGNORE INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g', 0, zeroblob(32), 0);
             INSERT OR IGNORE INTO sync_clock (id, ms, ctr) VALUES (1, 0, 0);
             INSERT INTO decks (id, name, format_key, created_at, updated_at, sync_uid)
             VALUES (1, 'Burn', 'modern', 0, 0, 'deck-uid');
             INSERT INTO collection_folders (id, parent_id, name, kind, deck_id, sort_order,
                                             created_at, updated_at)
             VALUES (601, NULL, 'Added from Discord', 'user', NULL, 0, 0, 0),
                    (602, NULL, 'Binder', 'user', NULL, 1, 0, 0),
                    (603, NULL, 'Burn', 'deck', 1, 2, 0, 0);
             UPDATE collection_folders SET sync_uid = 'folder-' || id WHERE id IN (601, 602, 603);",
        )
        .unwrap();
    });
    bot
}

fn bolt(folder: &str, quantity: i64) -> String {
    serde_json::json!({
        "table": "collection",
        "cardId": "bolt-2x2",
        "setCode": "2x2",
        "collectorNumber": "117",
        "lang": "en",
        "finish": "foil",
        "quantity": quantity,
        "folderUid": folder,
    })
    .to_string()
}

fn outboxed(bot: &Device) -> i64 {
    bot.with_conn(|conn| outbox(conn).unwrap())
}

fn said(text: &str) -> Refusal {
    Refusal::Said(text.to_owned())
}

#[tokio::test(flavor = "current_thread")]
async fn an_add_goes_to_the_default_folder_and_is_the_one_op_in_the_outbox() {
    let relay = Rendezvous::start().await;
    let bot = an_add_bot("obj-add", &relay);
    let now = 1_760_000_000_000;
    assert_eq!(
        bot.target("collection", "", now),
        Ok(Target {
            uid: Some("folder-601".to_owned()),
            path: Some("Added from Discord".to_owned())
        })
    );
    assert_eq!(outboxed(&bot), 0);
    let uid = bot.add(&bolt("folder-601", 2), now).unwrap();
    assert_eq!(outboxed(&bot), 1, "emit writes its op past capture_off");
    let (held, folder): (i64, String) = bot.with_conn(|conn| {
        conn.query_row(
            "SELECT e.quantity, f.sync_uid FROM collection_entries e
               JOIN collection_folders f ON f.id = e.folder_id WHERE e.sync_uid = ?1",
            [&uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    });
    assert_eq!(
        (held, folder.as_str()),
        (2, "folder-601"),
        "applied here too"
    );
    // …and capture is still off for everything else the bot writes.
    bot.with_conn(|conn| {
        conn.execute(
            "INSERT INTO collection_entries (card_id, set_code, collector_number, finish, quantity,
                                             created_at, updated_at)
             VALUES ('x', 'c21', '1', 'nonfoil', 1, 0, 0)",
            [],
        )
        .unwrap();
    });
    assert_eq!(outboxed(&bot), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a_wish_goes_to_the_wishlists_root() {
    let relay = Rendezvous::start().await;
    let bot = an_add_bot("obj-wish", &relay);
    assert_eq!(
        bot.target("wishlist", "ignored", 0),
        Ok(Target {
            uid: None,
            path: None
        })
    );
    let wish = serde_json::json!({
        "table": "wishlist",
        "oracleId": "o-bolt",
        "name": "Lightning Bolt",
        "printing": null,
        "preferredFinish": null,
        "quantity": 1,
        "folderUid": null,
    });
    bot.add(&wish.to_string(), 0).unwrap();
    assert_eq!(outboxed(&bot), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a_folder_is_named_by_its_uid_or_path_and_refused_when_it_is_not_a_users() {
    let relay = Rendezvous::start().await;
    let bot = an_add_bot("obj-folders", &relay);
    assert_eq!(
        bot.target("collection", "folder-602", 0)
            .unwrap()
            .path
            .as_deref(),
        Some("Binder")
    );
    assert_eq!(
        bot.target("collection", "binder", 0)
            .unwrap()
            .uid
            .as_deref(),
        Some("folder-602")
    );
    assert_eq!(
        bot.target("collection", "folder-603", 0),
        Err(said(NOT_A_USER_FOLDER))
    );
    assert_eq!(
        bot.target("collection", "Nowhere", 0),
        Err(said(NO_SUCH_FOLDER))
    );
    let completed: Vec<String> = bot
        .folders("", 25)
        .unwrap()
        .into_iter()
        .map(|c| c.value)
        .collect();
    assert_eq!(completed, ["folder-601", "folder-602"]);
    // The default folder gone (the reader deleted it on the desktop): name one, or bring it back.
    bot.with_conn(|conn| {
        conn.execute("DELETE FROM collection_folders WHERE id = 601", [])
            .unwrap();
    });
    assert_eq!(
        bot.target("collection", " ", 0),
        Err(said(NO_DEFAULT_FOLDER))
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_confirm_asks_again_for_the_folder_and_the_quota() {
    let relay = Rendezvous::start().await;
    let bot = an_add_bot("obj-confirm", &relay);
    let now = 1_760_000_000_000;
    bot.with_conn(|conn| {
        conn.execute("DELETE FROM collection_folders WHERE id = 602", [])
            .unwrap();
    });
    assert_eq!(bot.add(&bolt("folder-602", 1), now), Err(said(FOLDER_GONE)));
    assert_eq!(
        bot.add(&bolt("folder-603", 1), now),
        Err(said(NOT_A_USER_FOLDER))
    );
    assert!(matches!(bot.add("{}", now), Err(Refusal::Failed(_))));
    // The relay refused a push for its quota today: no command and no confirm until tomorrow.
    bot.with_conn(|conn| {
        set(conn, client::RESTRICTED_QUOTA_AT, &(now / 1000).to_string()).unwrap()
    });
    assert_eq!(bot.target("collection", "", now), Err(said(QUOTA)));
    assert_eq!(bot.add(&bolt("folder-601", 1), now), Err(said(QUOTA)));
    assert_eq!(outboxed(&bot), 0);
    let tomorrow = now + 86_400_000;
    assert!(bot.target("collection", "", tomorrow).is_ok());
    assert!(bot.add(&bolt("folder-601", 1), tomorrow).is_ok());
    assert_eq!(outboxed(&bot), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a_read_bot_and_an_empty_outbox_push_nothing() {
    let relay = Rendezvous::start().await;
    let bot = an_add_bot("obj-nopush", &relay);
    let lane = bot.state().lane().await;
    // `add`, but nothing confirmed: no request.
    assert_eq!(bot.push(&lane, 0).await, Ok(false));
    drop(lane);
    bot.add(&bolt("folder-601", 1), 0).unwrap();
    bot.with_conn(|conn| {
        conn.execute(
            "UPDATE sync_devices SET capability = 'read' WHERE capability = 'add'",
            [],
        )
        .unwrap();
    });
    let lane = bot.state().lane().await;
    assert_eq!(
        bot.push(&lane, 0).await,
        Ok(false),
        "a read device never pushes"
    );
    assert_eq!(outboxed(&bot), 1);
}

#[test]
fn a_quota_day_is_the_relays_utc_day() {
    assert_eq!(quota_day(0), 0);
    assert_eq!(quota_day(86_399_999), 0);
    assert_eq!(quota_day(86_400_000), 1);
}

/// An `add` bot holding a relay token with a day left, so a push asks the relay for nothing but
/// the push itself.
fn with_token(bot: &Device) {
    bot.with_conn(|conn| {
        set(conn, entitlement::ACCESS_TOKEN, "a-relay-token").unwrap();
        let expires: i64 = conn
            .query_row("SELECT unixepoch() + 86400", [], |r| r.get(0))
            .unwrap();
        set(conn, entitlement::ACCESS_EXPIRES, &expires.to_string()).unwrap();
    });
}

#[tokio::test(flavor = "current_thread")]
async fn a_push_takes_the_outbox_to_the_relay_and_a_quota_refusal_is_said_until_tomorrow() {
    // The relay takes the envelope.
    let relay = Rendezvous::start().await;
    let took = relay.server.mock(|when, then| {
        when.method(POST)
            .path("/g/g/push")
            .header("authorization", "Bearer a-relay-token");
        then.status(200)
            .header("content-type", "application/json")
            .body(r#"{"cursor":1}"#);
    });
    let bot = an_add_bot("obj-push", &relay);
    with_token(&bot);
    bot.add(&bolt("folder-601", 2), 0).unwrap();
    let lane = bot.state().lane().await;
    assert_eq!(
        bot.push(&lane, 0).await,
        Ok(false),
        "one envelope, nothing left"
    );
    drop(lane);
    took.assert();
    assert_eq!(outboxed(&bot), 0);

    // The relay has had the day's pushes: the outbox is kept, and the day is said in words.
    let relay = Rendezvous::start().await;
    relay.server.mock(|when, then| {
        when.method(POST).path("/g/g/push");
        then.status(429)
            .header("content-type", "application/json")
            .body(r#"{"error":"the day's pushes are spent","code":"restricted_quota"}"#);
    });
    let bot = an_add_bot("obj-quota", &relay);
    with_token(&bot);
    bot.add(&bolt("folder-601", 1), 0).unwrap();
    let now = grimoire_core::platform::clock::now_ms();
    let lane = bot.state().lane().await;
    assert_eq!(bot.push(&lane, now).await, Ok(false));
    drop(lane);
    assert_eq!(outboxed(&bot), 1, "kept for tomorrow");
    assert_eq!(bot.target("collection", "", now), Err(said(QUOTA)));
    assert!(bot.target("collection", "", now + 86_400_000).is_ok());
}
