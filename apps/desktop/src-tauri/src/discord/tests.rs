//! The desktop's half: the base and its override, the link's state machine against a local mock
//! of the front, the switch-on's order and rollback with fakes, the switch-off when the front is
//! down, and where the secret is kept. The pinned pairing itself is `grimoire_core::integration`'s
//! suite, against a relay.

use super::commands::{status, DiscordStatus};
use super::flow::{self, Ceremony, Front, Remover};
use super::front::{self, Enrolled};
use super::local;
use crate::sync_engine::client;
use crate::sync_pair::identity;
use crate::sync_pair::pairing::{self, Pinned, PinnedJoin};
use grimoire_core::sync_pair::roster;
use httpmock::prelude::*;
use rusqlite::Connection;
use std::cell::RefCell;

fn db() -> Connection {
    crate::schema::memory_pair()
}

fn point(conn: &Connection, server: &MockServer) {
    client::set_state(conn, local::DISCORD_URL, &server.base_url()).unwrap();
}

fn linked(conn: &Connection) {
    local::store_link(conn, "the-secret", "1234", "markus").unwrap();
}

/// A device in a group with the bot listed, its id kept.
fn with_bot(conn: &Connection) {
    let me = identity::ensure(conn).unwrap();
    identity::create_group(conn, &me).unwrap();
    identity::add_device(conn, "bot-1", &[9u8; 32], pairing::INTEGRATION_DEVICE_NAME).unwrap();
    local::set_bot(conn, "bot-1").unwrap();
}

// ---------------------------------------------------------------------------------------
// The base
// ---------------------------------------------------------------------------------------

#[test]
fn the_base_is_the_fronts_unless_overridden() {
    let conn = db();
    assert_eq!(front::base(&conn), front::DISCORD_BASE);
    assert_eq!(front::DISCORD_BASE, "https://discord.mtg-grimoire.app");
    client::set_state(&conn, local::DISCORD_URL, "  http://127.0.0.1:8787//  ").unwrap();
    assert_eq!(front::base(&conn), "http://127.0.0.1:8787");
    client::set_state(&conn, local::DISCORD_URL, "   ").unwrap();
    assert_eq!(front::base(&conn), front::DISCORD_BASE);
}

/// An override with no scheme is refused before any request, and writes no row.
#[tokio::test]
async fn an_override_that_is_not_a_url_is_unavailable() {
    let conn = db();
    client::set_state(&conn, local::DISCORD_URL, "not a host").unwrap();
    assert_eq!(
        flow::link_begin(&conn).await.unwrap_err(),
        front::UNAVAILABLE
    );
    assert!(local::linking(&conn).is_none());
}

#[test]
fn only_discords_own_page_is_an_authorize_url() {
    assert!(front::is_discord_authorize(
        "https://discord.com/oauth2/authorize?client_id=1&scope=identify%20applications.commands&integration_type=1&state=abc"
    ));
    for url in [
        "http://discord.com/oauth2/authorize",
        "https://discord.com.evil.example/oauth2/authorize",
        "https://evil.example/?https://discord.com/",
        "javascript:alert(1)",
    ] {
        assert!(!front::is_discord_authorize(url), "{url}");
    }
}

#[test]
fn the_pkce_challenge_is_the_verifiers_sha256() {
    use sha2::{Digest, Sha256};
    let (verifier, challenge) = flow::pkce();
    assert_eq!(verifier.len(), 43);
    let digest: [u8; 32] = Sha256::digest(verifier.as_bytes()).into();
    assert_eq!(challenge, roster::key_text(&digest));
    assert_ne!(flow::pkce().0, verifier);
}

// ---------------------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------------------

fn begin_answers(server: &MockServer, authorize: &str, expires_at: i64) {
    let authorize = authorize.to_owned();
    server.mock(move |when, then| {
        when.method(POST)
            .path("/link/begin")
            .header("content-type", "application/json")
            .body_includes("\"challenge\"");
        then.status(200).json_body(serde_json::json!({
            "code": "code-1",
            "authorizeUrl": authorize,
            "expiresAt": expires_at,
        }));
    });
}

/// ⚠ **The link's state machine**: a begin keeps the code and verifier; a claim the front has
/// not finished leaves it linking; the claim that links keeps the account and ends the link in
/// flight.
#[tokio::test]
async fn a_link_begins_waits_and_is_claimed() {
    let server = MockServer::start_async().await;
    let conn = db();
    point(&conn, &server);
    let now = grimoire_core::platform::clock::now_ms();
    begin_answers(
        &server,
        "https://discord.com/oauth2/authorize?state=code-1",
        now + 600_000,
    );

    let begun = flow::link_begin(&conn).await.unwrap();
    assert_eq!(begun.expires_at, now + 600_000);
    let held = local::linking(&conn).expect("the link in flight is kept");
    assert_eq!(held.code, "code-1");
    let s = status(&conn, now);
    assert!(s.linking && !s.linked);
    assert_eq!(s.link_expires_at, Some(now + 600_000));

    let mut pending = server.mock(|when, then| {
        when.method(POST)
            .path("/link/claim")
            .body_includes("\"code\":\"code-1\"")
            .body_includes(format!("\"verifier\":\"{}\"", held.verifier));
        then.status(202)
            .json_body(serde_json::json!({ "status": "pending" }));
    });
    flow::link_poll(&conn, now).await.unwrap();
    pending.assert();
    assert!(status(&conn, now).linking);
    pending.delete();

    server.mock(|when, then| {
        when.method(POST).path("/link/claim");
        then.status(200).json_body(serde_json::json!({
            "status": "linked", "secret": "s3cret", "discordUserId": "42", "username": "markus",
        }));
    });
    flow::link_poll(&conn, now).await.unwrap();
    let s = status(&conn, now);
    assert_eq!(
        (
            s.linked,
            s.linking,
            s.username.as_deref(),
            s.discord_user_id.as_deref()
        ),
        (true, false, Some("markus"), Some("42"))
    );
    assert_eq!(local::link(&conn).unwrap().secret, "s3cret");
    // Nothing more to poll.
    flow::link_poll(&conn, now).await.unwrap();
}

/// A refusal that ends the link — denied, mismatched, expired — is its sentence once, and the
/// link is forgotten; **the front's own text is never passed on**.
#[tokio::test]
async fn a_refused_claim_is_one_of_this_files_sentences_and_ends_the_link() {
    for (status_code, sentence) in [
        (403, front::LINK_MISMATCH),
        (409, front::LINK_DENIED),
        (410, front::LINK_EXPIRED),
    ] {
        let server = MockServer::start_async().await;
        let conn = db();
        point(&conn, &server);
        let now = grimoire_core::platform::clock::now_ms();
        begin_answers(
            &server,
            "https://discord.com/oauth2/authorize",
            now + 60_000,
        );
        flow::link_begin(&conn).await.unwrap();
        server.mock(|when, then| {
            when.method(POST).path("/link/claim");
            then.status(status_code)
                .json_body(serde_json::json!({ "error": "internal words", "code": "whatever" }));
        });
        let refused = flow::link_poll(&conn, now).await.unwrap_err();
        assert_eq!(refused, sentence);
        assert!(!refused.contains("internal words"));
        assert!(local::linking(&conn).is_none(), "{status_code}");
    }
}

/// A claim the front failed on (a 500) keeps the link in flight for the next poll, and says
/// nothing of the Worker's own text; a link past its expiry here is forgotten without a request.
#[tokio::test]
async fn a_failed_claim_keeps_the_link_and_an_expired_one_asks_nothing() {
    let server = MockServer::start_async().await;
    let conn = db();
    point(&conn, &server);
    let now = grimoire_core::platform::clock::now_ms();
    begin_answers(
        &server,
        "https://discord.com/oauth2/authorize",
        now + 60_000,
    );
    flow::link_begin(&conn).await.unwrap();
    let claim = server.mock(|when, then| {
        when.method(POST).path("/link/claim");
        then.status(500).body("{\"error\":\"stack trace here\"}");
    });
    let refused = flow::link_poll(&conn, now).await.unwrap_err();
    assert_eq!(refused, front::UNREACHABLE);
    assert!(local::linking(&conn).is_some());
    let logged: String = conn
        .query_row(
            "SELECT message FROM error_log WHERE operation = 'discord_link'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        logged.contains("500") && !logged.contains("stack trace"),
        "{logged}"
    );

    let refused = flow::link_poll(&conn, now + 60_001).await.unwrap_err();
    assert_eq!(refused, front::LINK_EXPIRED);
    assert!(local::linking(&conn).is_none());
    claim.assert_calls(1);
}

/// A front that answers somebody else's page is refused, and nothing is kept.
#[tokio::test]
async fn a_begin_that_answers_another_sites_page_is_refused() {
    let server = MockServer::start_async().await;
    let conn = db();
    point(&conn, &server);
    begin_answers(&server, "https://evil.example/oauth2/authorize", 1);
    assert_eq!(
        flow::link_begin(&conn).await.unwrap_err(),
        front::NOT_DISCORD
    );
    assert!(local::linking(&conn).is_none());
}

/// Enroll's refusals, by status, against the front's mock.
#[tokio::test]
async fn enroll_refusals_are_read_by_status() {
    for (code, sentence) in [
        (401, front::NOT_LINKED),
        (409, front::ALREADY_ENROLLED),
        (422, front::ENROLL_FAILED),
        (502, front::ENROLL_FAILED),
    ] {
        let server = MockServer::start_async().await;
        let conn = db();
        point(&conn, &server);
        server.mock(|when, then| {
            when.method(POST)
                .path("/link/enroll")
                .header("authorization", "Bearer the-secret")
                .body_includes("\"capability\":\"add\"")
                .body_includes("\"invite\":\"INVITE\"");
            then.status(code)
                .json_body(serde_json::json!({ "error": "raw", "code": "x" }));
        });
        assert_eq!(
            front::enroll(&conn, "the-secret", "INVITE")
                .await
                .unwrap_err(),
            sentence,
            "{code}"
        );
    }
    let server = MockServer::start_async().await;
    let conn = db();
    point(&conn, &server);
    server.mock(|when, then| {
        when.method(POST).path("/link/enroll");
        then.status(200).json_body(
            serde_json::json!({ "deviceId": "bot-1", "x25519": "AAA", "ed25519": "BBB" }),
        );
    });
    let enrolled = front::enroll(&conn, "the-secret", "INVITE").await.unwrap();
    assert_eq!(enrolled.device_id, "bot-1");
}

// ---------------------------------------------------------------------------------------
// The switch-on, with fakes
// ---------------------------------------------------------------------------------------

#[derive(Default)]
struct Log(RefCell<Vec<String>>);

impl Log {
    fn push(&self, what: impl Into<String>) {
        self.0.borrow_mut().push(what.into());
    }
    fn calls(&self) -> Vec<String> {
        self.0.borrow().clone()
    }
}

struct FakeCeremony<'a> {
    log: &'a Log,
    gate: Result<(), String>,
    joined: Result<(), String>,
    confirm: Result<(), String>,
}

impl Ceremony for FakeCeremony<'_> {
    fn gate(&mut self) -> Result<(), String> {
        self.log.push("gate");
        self.gate.clone()
    }
    fn begin(&mut self) -> Result<String, String> {
        self.log.push("begin");
        Ok("INVITE".into())
    }
    async fn joined(&mut self) -> Result<(), String> {
        self.log.push("joined");
        self.joined.clone()
    }
    async fn confirm(&mut self, pinned: Pinned) -> Result<PinnedJoin, String> {
        self.log.push(format!(
            "confirm {} {}",
            pinned.device_id, pinned.capability
        ));
        self.confirm.clone().map(|()| PinnedJoin {
            device_id: pinned.device_id,
            signed_since: 2,
            published: true,
        })
    }
}

struct FakeFront<'a> {
    log: &'a Log,
    enroll: Result<Enrolled, String>,
    unlink: Result<(), String>,
    /// The database the switch-on writes, when a test asks whether the *Added from Discord*
    /// folder was already there at the enroll — `enroll +folder` in the log if it was.
    seen: Option<&'a Connection>,
}

impl Front for FakeFront<'_> {
    async fn enroll(&self, invite: &str) -> Result<Enrolled, String> {
        let folder = match self.seen {
            Some(conn) if added_folders(conn) == 1 => " +folder",
            _ => "",
        };
        self.log.push(format!("enroll {invite}{folder}"));
        self.enroll.clone()
    }
    async fn unlink(&self) -> Result<(), String> {
        self.log.push("unlink");
        self.unlink.clone()
    }
}

struct FakeRemover<'a> {
    log: &'a Log,
    answer: Result<(), String>,
}

impl Remover for FakeRemover<'_> {
    async fn remove(&self, device: &str) -> Result<(), String> {
        self.log.push(format!("remove {device}"));
        self.answer.clone()
    }
}

fn answered() -> Enrolled {
    Enrolled {
        device_id: "bot-1".into(),
        x25519: roster::key_text(&[1u8; 32]),
        ed25519: roster::key_text(&[2u8; 32]),
    }
}

fn ceremony(log: &Log) -> FakeCeremony<'_> {
    FakeCeremony {
        log,
        gate: Ok(()),
        joined: Ok(()),
        confirm: Ok(()),
    }
}

fn front_of(log: &Log) -> FakeFront<'_> {
    FakeFront {
        log,
        enroll: Ok(answered()),
        unlink: Ok(()),
        seen: None,
    }
}

/// How many top-level user folders are named *Added from Discord*, in any case.
fn added_folders(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM collection_folders
          WHERE kind = 'user' AND parent_id IS NULL AND name = ?1 COLLATE NOCASE",
        [grimoire_core::integration::add::ADDED_FROM_DISCORD],
        |r| r.get(0),
    )
    .unwrap()
}

/// ⚠ **The order**: the gate, the *Added from Discord* folder — there before the enroll — the
/// offer, the enroll with its invite, the wait, the confirm on the pins the enroll answered **as
/// `add`** (spec §14.1) — and the bot's id kept.
#[tokio::test]
async fn a_switch_on_runs_in_order_and_keeps_the_bot() {
    let conn = db();
    // Capture armed, as a launch arms it: it names the folder (`sync_uid`), which is how the
    // engine — and the bot, once it syncs — finds it.
    grimoire_core::sync_engine::capture::install(&conn).unwrap();
    linked(&conn);
    assert_eq!(added_folders(&conn), 0);
    let log = Log::default();
    let front = FakeFront {
        seen: Some(&conn),
        ..front_of(&log)
    };
    let joined = flow::enable(&conn, &mut ceremony(&log), &front)
        .await
        .unwrap();
    assert_eq!(joined.device_id, "bot-1");
    assert_eq!(
        log.calls(),
        [
            "gate",
            "begin",
            "enroll INVITE +folder",
            "joined",
            "confirm bot-1 add"
        ]
    );
    assert_eq!(roster::ADD, "add");
    assert_eq!(local::bot(&conn).as_deref(), Some("bot-1"));
    assert!(local::link(&conn).is_some());
    // The engine's own answer agrees: the folder a collection add lands in when none is named.
    assert!(grimoire_core::integration::add::default_folder(&conn)
        .unwrap()
        .is_some());
}

/// The folder is made once: a switch-on into a collection that already has one — the reader's
/// own, in another case, or the one an earlier switch-on made — makes no second.
#[tokio::test]
async fn a_switch_on_keeps_the_added_folder_it_finds() {
    let conn = db();
    grimoire_core::sync_engine::capture::install(&conn).unwrap();
    linked(&conn);
    conn.execute(
        "INSERT INTO collection_folders (parent_id, name, kind, sort_order, created_at, updated_at)
         VALUES (NULL, 'added from discord', 'user', 0, 0, 0)",
        [],
    )
    .unwrap();
    let log = Log::default();
    flow::enable(&conn, &mut ceremony(&log), &front_of(&log))
        .await
        .unwrap();
    assert_eq!(added_folders(&conn), 1);
}

#[tokio::test]
async fn a_switch_on_with_no_link_or_a_closed_gate_asks_nobody() {
    let conn = db();
    let log = Log::default();
    assert_eq!(
        flow::enable(&conn, &mut ceremony(&log), &front_of(&log))
            .await
            .unwrap_err(),
        flow::LINK_FIRST
    );
    linked(&conn);
    let mut closed = ceremony(&log);
    closed.gate = Err(grimoire_core::integration::GROUP_FULL.into());
    assert_eq!(
        flow::enable(&conn, &mut closed, &front_of(&log))
            .await
            .unwrap_err(),
        grimoire_core::integration::GROUP_FULL
    );
    assert_eq!(log.calls(), ["gate"]);
    assert!(local::link(&conn).is_some());
    // A closed gate writes nothing, the folder included.
    assert_eq!(added_folders(&conn), 0);
}

/// ⚠ **A failure after the enroll undoes the link** — the wait timing out, keys that are not keys,
/// a pin that does not match: `DELETE /link`, the link forgotten here, nothing about the bot kept.
#[tokio::test]
async fn a_failure_after_the_enroll_undoes_the_link() {
    for case in ["timeout", "keys", "pin"] {
        let conn = db();
        linked(&conn);
        let log = Log::default();
        let mut c = ceremony(&log);
        let mut f = front_of(&log);
        let expected = match case {
            "timeout" => {
                c.joined = Err(flow::JOIN_TIMED_OUT.into());
                flow::JOIN_TIMED_OUT
            }
            "keys" => {
                f.enroll = Ok(Enrolled {
                    x25519: "short".into(),
                    ..answered()
                });
                flow::BAD_KEYS
            }
            _ => {
                c.confirm = Err(pairing::PIN_MISMATCH.into());
                pairing::PIN_MISMATCH
            }
        };
        let refused = flow::enable(&conn, &mut c, &f).await.unwrap_err();
        assert_eq!(refused, format!("{expected} {}", flow::UNDONE), "{case}");
        assert_eq!(
            log.calls().last().map(String::as_str),
            Some("unlink"),
            "{case}"
        );
        assert!(local::link(&conn).is_none(), "{case}");
        assert!(local::bot(&conn).is_none(), "{case}");
        // The folder is the reader's, made before the enroll, and stays.
        assert_eq!(added_folders(&conn), 1, "{case}");
    }
}

/// An enroll the front refuses is its sentence, with no unlink — nothing enrolled — and a `401`
/// forgets the link the front no longer knows.
#[tokio::test]
async fn a_refused_enroll_is_not_undone_and_a_dead_link_is_forgotten() {
    let conn = db();
    linked(&conn);
    let log = Log::default();
    let mut f = front_of(&log);
    f.enroll = Err(front::ALREADY_ENROLLED.into());
    assert_eq!(
        flow::enable(&conn, &mut ceremony(&log), &f)
            .await
            .unwrap_err(),
        front::ALREADY_ENROLLED
    );
    assert!(!log.calls().contains(&"unlink".to_owned()));
    assert!(local::link(&conn).is_some());

    f.enroll = Err(front::NOT_LINKED.into());
    assert_eq!(
        flow::enable(&conn, &mut ceremony(&log), &f)
            .await
            .unwrap_err(),
        front::NOT_LINKED
    );
    assert!(local::link(&conn).is_none());
}

// ---------------------------------------------------------------------------------------
// The switch-off
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_switch_off_removes_unlinks_and_forgets() {
    let conn = db();
    linked(&conn);
    with_bot(&conn);
    let log = Log::default();
    let remover = FakeRemover {
        log: &log,
        answer: Ok(()),
    };
    flow::disable(&conn, &remover, Some(&front_of(&log)))
        .await
        .unwrap();
    assert_eq!(log.calls(), ["remove bot-1", "unlink"]);
    assert!(local::link(&conn).is_none());
    assert!(local::bot(&conn).is_none());
}

/// Linked and never enrolled: only `DELETE /link`, and the link forgotten.
#[tokio::test]
async fn a_switch_off_with_no_bot_only_unlinks() {
    let conn = db();
    linked(&conn);
    let log = Log::default();
    let remover = FakeRemover {
        log: &log,
        answer: Ok(()),
    };
    flow::disable(&conn, &remover, Some(&front_of(&log)))
        .await
        .unwrap();
    assert_eq!(log.calls(), ["unlink"]);
    assert!(local::link(&conn).is_none());
}

/// ⚠ **The front down** — the real request, at an address nothing answers: the bot is still
/// removed from the group and forgotten here, and the reader is told; the link is kept, because
/// the front keeps its row too and the secret is the only way to ask again.
#[tokio::test]
async fn a_switch_off_clears_the_bot_even_when_the_front_is_down() {
    let conn = db();
    linked(&conn);
    with_bot(&conn);
    // A port nothing listens on.
    let gone = {
        let server = MockServer::start_async().await;
        server.base_url()
    };
    client::set_state(&conn, local::DISCORD_URL, &gone).unwrap();
    let log = Log::default();
    let remover = FakeRemover {
        log: &log,
        answer: Ok(()),
    };
    let front = flow::Linked {
        store: &conn,
        secret: "the-secret".to_owned(),
    };
    let refused = flow::disable(&conn, &remover, Some(&front))
        .await
        .unwrap_err();
    assert_eq!(refused, flow::NOT_TOLD);
    assert_eq!(log.calls(), ["remove bot-1"]);
    assert!(local::bot(&conn).is_none());
    assert!(local::link(&conn).is_some(), "a retry would have no secret");
    let s: DiscordStatus = status(&conn, 0);
    assert!(s.linked && !s.enrolled);

    // `502 bot_unavailable` is the same answer.
    let server = MockServer::start_async().await;
    point(&conn, &server);
    server.mock(|when, then| {
        when.method(DELETE).path("/link");
        then.status(502)
            .json_body(serde_json::json!({ "code": "bot_unavailable" }));
    });
    let front = flow::Linked {
        store: &conn,
        secret: "the-secret".to_owned(),
    };
    assert_eq!(
        flow::disable(&conn, &remover, Some(&front))
            .await
            .unwrap_err(),
        flow::NOT_TOLD
    );
    // And the retry that reaches it forgets the link.
    let server = MockServer::start_async().await;
    point(&conn, &server);
    server.mock(|when, then| {
        when.method(DELETE)
            .path("/link")
            .header("authorization", "Bearer the-secret");
        then.status(204);
    });
    flow::disable(&conn, &remover, Some(&front)).await.unwrap();
    assert!(local::link(&conn).is_none());
}

/// A removal that fails is the sentence the reader acts on — the bot named — and the rest still
/// happens.
#[tokio::test]
async fn a_failed_removal_names_the_bot_and_still_unlinks() {
    let conn = db();
    linked(&conn);
    with_bot(&conn);
    let log = Log::default();
    let remover = FakeRemover {
        log: &log,
        answer: Err("the relay answered 500 to a key change".into()),
    };
    let refused = flow::disable(&conn, &remover, Some(&front_of(&log)))
        .await
        .unwrap_err();
    assert_eq!(
        refused,
        flow::still_listed(pairing::INTEGRATION_DEVICE_NAME)
    );
    assert!(!refused.contains("500"));
    assert_eq!(log.calls(), ["remove bot-1", "unlink"]);
    assert!(local::link(&conn).is_none() && local::bot(&conn).is_none());
}

// ---------------------------------------------------------------------------------------
// Where it is kept
// ---------------------------------------------------------------------------------------

/// ⚠ **The secret is kept as the sync identity is**: `sync_state` is not a synced table, and an
/// archive carries no `sync_*` table — so the link travels to no other device and into no backup.
#[test]
fn the_link_never_syncs_and_is_never_archived() {
    assert!(!grimoire_core::schema::SYNCED_TABLES.contains(&"sync_state"));
    let conn = db();
    local::store_link(&conn, "never-in-an-archive", "1234", "markus").unwrap();
    local::set_bot(&conn, "bot-never-archived").unwrap();
    let dump = grimoire_core::archive::dump(&conn).unwrap().to_string();
    assert!(!dump.contains("never-in-an-archive"));
    assert!(!dump.contains("bot-never-archived"));
}

/// The status: a bot remembered but no longer listed is not enrolled, and the gate is answered.
#[test]
fn the_status_reads_the_roster_and_the_gate() {
    let conn = db();
    let s = status(&conn, 0);
    assert!(!s.linked && !s.enrolled && !s.linking);
    assert_eq!(
        s.gate.as_deref(),
        Some(grimoire_core::integration::NO_GROUP)
    );
    with_bot(&conn);
    assert!(status(&conn, 0).enrolled);
    conn.execute("DELETE FROM sync_devices WHERE device_id = 'bot-1'", [])
        .unwrap();
    let s = status(&conn, 0);
    assert!(!s.enrolled);
    assert_eq!(s.bot_device_id.as_deref(), Some("bot-1"));
}

/// The page sends no argument to any of the six: each wrapper takes the state alone.
#[test]
fn no_command_takes_an_argument_from_the_page() {
    let source = include_str!("commands.rs");
    let mut seen = 0;
    for chunk in source.split("#[tauri::command]").skip(1) {
        let signature = &chunk[..chunk.find(") ->").unwrap()];
        assert!(signature.contains("pub async fn discord_"), "{signature}");
        // One parameter a line, as rustfmt writes a signature too long for one.
        let params: Vec<&str> = signature[signature.find('(').unwrap() + 1..]
            .lines()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .collect();
        assert_eq!(params.len(), 1, "{signature}");
        assert!(params[0].starts_with("state: tauri::State<"), "{signature}");
        seen += 1;
    }
    assert_eq!(seen, 6);
}
