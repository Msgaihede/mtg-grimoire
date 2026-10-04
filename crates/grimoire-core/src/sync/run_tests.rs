//! **A whole sync, driven**: the check, the download, the ingest, the swap, the set list, the
//! migration log — against a mock Scryfall, with a sink that records every event and an
//! observer that counts what it is told.
//!
//! This is the test the module could not have while a run took a `tauri::AppHandle`: nothing
//! in a test can build one, so `do_sync` was read rather than run, and three things about it
//! were pinned only by a reviewer's eye — which events a run emits and in what order, what
//! their payload looks like to the page, and that whoever renders from the corpus is told the
//! moment the swap lands. They are assertions now.
//!
//! A file of its own rather than more of `sync.rs`'s `mod tests`, because that module was moved
//! here by a script that rewrites it from the desktop's file: what is added by hand goes beside
//! it, not into it.

use super::*;
use crate::events::EventSink;
use crate::hooks::WriteObserver;
use crate::ingest::fixtures::{card_line, gz_fixture};
use httpmock::prelude::*;
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;

/// Every event a run raised, as the name and the JSON a host would forward to its page.
#[derive(Default)]
struct Recording(Mutex<Vec<(String, serde_json::Value)>>);

impl EventSink for Recording {
    fn emit(&self, name: &str, payload: serde_json::Value) {
        self.0.lock().unwrap().push((name.to_owned(), payload));
    }
}

impl Recording {
    fn taken(&self) -> Vec<(String, serde_json::Value)> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

/// The `sync:progress` phases among `events`, with a run of one phase collapsed to one entry.
fn phases(events: &[(String, serde_json::Value)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (name, payload) in events {
        if name != "sync:progress" {
            continue;
        }
        let phase = payload["phase"].as_str().unwrap_or_default().to_owned();
        if out.last() != Some(&phase) {
            out.push(phase);
        }
    }
    out
}

/// What the desktop's mirror is, to this module: something told once per swapped corpus.
#[derive(Default)]
struct Swaps(AtomicUsize);

impl WriteObserver for Swaps {
    fn corpus_replaced(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

struct Run {
    state: Arc<State>,
    events: Arc<Recording>,
    swaps: Arc<Swaps>,
    dir: std::path::PathBuf,
}

/// A host's state on a pair of files, at head, with the client pointed at `base_url`.
fn host(name: &str, base_url: String) -> Run {
    let dir = crate::scratch::path(&format!("sync-run-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = crate::db::open_write(&dir).unwrap();
    crate::schema::build_pair(&conn);
    let read = crate::db::open_read(&dir).unwrap();
    let events = Arc::new(Recording::default());
    let swaps = Arc::new(Swaps::default());
    let state = Arc::new(State::new(
        conn,
        Some(read),
        dir.clone(),
        events.clone(),
        vec![swaps.clone()],
        scryfall::Client::new(base_url),
        crate::images::Cache::new(dir.join("images")),
    ));
    Run {
        state,
        events,
        swaps,
        dir,
    }
}

const ETAG: &str = "W/\"v1\"";
const UPDATED_AT: &str = "2026-10-02T09:05:46.742+00:00";

/// A Scryfall that publishes `cards` as its bulk file, answers 304 to the ETag it handed out,
/// and has one set. Returns the bytes' length, which is what the listing promises.
fn publish(server: &MockServer, cards: u64) -> usize {
    let lines: Vec<String> = (0..cards).map(card_line).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let bytes = std::fs::read(gz_fixture(&refs)).unwrap();
    let size = bytes.len();
    // First, so it wins when the request carries the ETag: the common answer is a 304.
    server.mock(|when, then| {
        when.method(GET)
            .path("/bulk-data/default_cards")
            .header("if-none-match", ETAG);
        then.status(304);
    });
    server.mock(|when, then| {
        when.method(GET).path("/bulk-data/default_cards");
        then.status(200)
            .header("etag", ETAG)
            .json_body(serde_json::json!({
                "jsonl_download_uri": format!("{}/default-cards.jsonl.gz", server.base_url()),
                "updated_at": UPDATED_AT,
                "compressed_size": size,
            }));
    });
    server.mock(|when, then| {
        when.method(GET).path("/default-cards.jsonl.gz");
        then.status(200).body(bytes.clone());
    });
    server.mock(|when, then| {
        when.method(GET).path("/sets");
        then.status(200).json_body(serde_json::json!({
            "has_more": false,
            "data": [{"code": "x", "name": "Set X", "printed_size": 5}]
        }));
    });
    size
}

fn count(state: &State, sql: &str) -> i64 {
    state.lock_db().query_row(sql, [], |r| r.get(0)).unwrap()
}

/// The index is built off the caller's thread once a run is over, so a test waits for it.
fn index_built(state: &State) -> bool {
    for _ in 0..200 {
        if crate::index::lifecycle::current(state).is_some() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    false
}

/// **A first sync, end to end, and then the run after it.**
///
/// The first run ingests: every phase the page draws, in the order it draws them, each as the
/// four keys `useSyncProgress` reads; the observer told once, at the swap; the metadata that
/// makes the next check cheap stored; the download gone; the index built. The second is the
/// answer most runs get — a 304 — and it emits two events, swaps nothing and tells nobody.
#[tokio::test]
async fn a_first_sync_ingests_and_says_so_and_the_next_one_finds_nothing_new() {
    let server = MockServer::start();
    let size = publish(&server, 5);
    let migrations = server.mock(|when, then| {
        when.method(GET).path("/migrations");
        then.status(200)
            .json_body(serde_json::json!({"has_more": false, "data": []}));
    });
    let run = host("first", server.base_url());

    let outcome = run_sync(run.state.clone(), false).await.unwrap();
    assert!(outcome.updated);
    assert_eq!(outcome.card_count, 5);
    assert_eq!(outcome.updated_at.as_deref(), Some(UPDATED_AT));

    let events = run.events.taken();
    let seen = phases(&events);
    // `reclaiming` and `compacting` depend on what the file had free; the other five do not.
    let fixed: Vec<&str> = seen
        .iter()
        .map(String::as_str)
        .filter(|p| !matches!(*p, "reclaiming" | "compacting"))
        .collect();
    assert_eq!(
        fixed,
        ["checking", "downloading", "ingesting", "sets", "done"],
        "all of them: {seen:?}"
    );
    for phase in &seen {
        assert!(
            PHASES.contains(&phase.as_str()),
            "{phase} is not a phase the page knows"
        );
    }
    // The payload, as the page receives it: four keys, camelCase, a null rather than a hole.
    let (_, checking) = &events[0];
    assert_eq!(
        *checking,
        serde_json::json!({"phase": "checking", "done": 0, "total": 0, "message": null})
    );
    let (_, last_download) = events
        .iter()
        .rev()
        .find(|(_, p)| p["phase"] == "downloading")
        .unwrap();
    assert_eq!(
        *last_download,
        serde_json::json!({"phase": "downloading", "done": size, "total": size, "message": null})
    );
    let (name, done) = events.last().unwrap();
    assert_eq!(name, "sync:progress");
    assert_eq!(
        *done,
        serde_json::json!({"phase": "done", "done": 5, "total": 5, "message": "5 cards"})
    );
    assert!(
        events.iter().all(|(name, _)| name == "sync:progress"),
        "nothing was reconciled, so nothing says it was"
    );

    assert_eq!(
        run.swaps.0.load(Ordering::SeqCst),
        1,
        "whoever renders from the corpus is told once, at the swap"
    );
    assert_eq!(count(&run.state, "SELECT count(*) FROM cards"), 5);
    assert_eq!(count(&run.state, "SELECT count(*) FROM cards_fts"), 5);
    assert_eq!(count(&run.state, "SELECT count(*) FROM sets"), 1);
    {
        let conn = run.state.lock_db();
        assert_eq!(get_meta(&conn, K_BULK_ETAG).as_deref(), Some(ETAG));
        assert_eq!(
            get_meta(&conn, K_BULK_UPDATED_AT).as_deref(),
            Some(UPDATED_AT)
        );
        assert_eq!(get_meta(&conn, K_CARD_COUNT).as_deref(), Some("5"));
        assert_eq!(get_meta(&conn, K_LAST_INGEST_SKIPPED).as_deref(), Some("0"));
        assert!(get_meta(&conn, K_LAST_CHECK_AT).is_some());
        assert!(get_meta(&conn, K_LAST_ERROR).is_none());
    }
    assert!(
        !run.dir.join("tmp").join("default-cards.jsonl.gz").exists(),
        "an ingested download is not kept"
    );
    assert!(
        !run.state.syncing.load(Ordering::SeqCst),
        "the flag is given back"
    );
    assert!(
        index_built(&run.state),
        "the run ends by building the index"
    );
    assert_eq!(
        migrations.calls(),
        0,
        "a database with no collection, wishlist or deck has no id to migrate, so none is asked for"
    );

    // And again, past the throttle: the stored ETag earns a 304.
    let again = run_sync(run.state.clone(), true).await.unwrap();
    assert!(!again.updated);
    assert_eq!(again.card_count, 5);
    assert_eq!(again.updated_at, None);
    let events = run.events.taken();
    assert_eq!(phases(&events), ["checking", "done"]);
    assert_eq!(
        events.last().unwrap().1,
        serde_json::json!({"phase": "done", "done": 5, "total": 5, "message": "5 cards"})
    );
    assert_eq!(
        run.swaps.0.load(Ordering::SeqCst),
        1,
        "nothing swapped, nobody told"
    );

    // Unforced, a day has not passed: nothing is asked and nothing is said.
    let throttled = run_sync(run.state.clone(), false).await.unwrap();
    assert!(!throttled.updated);
    assert!(run.events.taken().is_empty());
}

/// **The migration log moves a row, and the page is told what moved.** A copy filed under an
/// id Scryfall has since merged into another is repointed by the run that ingests the card it
/// became — and `collection:reconciled` carries the three counts `useSyncInvalidation` reads.
#[tokio::test]
async fn a_sync_that_repoints_a_copy_says_what_moved() {
    let server = MockServer::start();
    publish(&server, 3);
    server.mock(|when, then| {
        when.method(GET).path("/migrations");
        then.status(200).json_body(serde_json::json!({
            "has_more": false,
            "data": [{
                "id": "mig-1",
                "performed_at": "2026-07-01",
                "migration_strategy": "merge",
                "old_scryfall_id": "retired",
                "new_scryfall_id": "c1"
            }]
        }));
    });
    let run = host("repoint", server.base_url());
    run.state
        .lock_db()
        .execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES ('retired','x','9','en','nonfoil','NM',2,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

    run_sync(run.state.clone(), false).await.unwrap();

    let events = run.events.taken();
    let reconciled: Vec<&serde_json::Value> = events
        .iter()
        .filter(|(name, _)| name == "collection:reconciled")
        .map(|(_, payload)| payload)
        .collect();
    assert_eq!(
        reconciled,
        [&serde_json::json!({"repointed": 1, "folded": 0, "flagged": 0})]
    );
    let at = |name: &str, phase: Option<&str>| {
        events
            .iter()
            .position(|(n, p)| n == name && phase.is_none_or(|ph| p["phase"] == ph))
            .unwrap()
    };
    assert!(
        at("sync:progress", Some("sets")) < at("collection:reconciled", None)
            && at("collection:reconciled", None) < at("sync:progress", Some("done")),
        "after the set list and before the run says it is done"
    );
    let card: String = run
        .state
        .lock_db()
        .query_row("SELECT card_id FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(card, "c1");
    assert_eq!(count(&run.state, "SELECT count(*) FROM card_migrations"), 1);
}

/// **A run that fails says so three ways and leaves the flag clear**: the error to its caller,
/// an `error` event carrying the sentence, and `last_error` for a page that was not listening
/// yet. And the observer hears nothing, because nothing was swapped.
#[tokio::test]
async fn a_sync_whose_download_is_refused_says_so_and_swaps_nothing() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET).path("/bulk-data/default_cards");
        then.status(200).json_body(serde_json::json!({
            "jsonl_download_uri": format!("{}/gone.jsonl.gz", server.base_url()),
            "updated_at": UPDATED_AT,
            "compressed_size": 100,
        }));
    });
    server.mock(|when, then| {
        when.method(GET).path("/gone.jsonl.gz");
        then.status(404);
    });
    let run = host("refused", server.base_url());

    let err = run_sync(run.state.clone(), false).await.unwrap_err();
    assert!(err.contains("404"), "{err}");

    let events = run.events.taken();
    assert_eq!(phases(&events), ["checking", "downloading", "error"]);
    assert_eq!(
        events.last().unwrap().1,
        serde_json::json!({"phase": "error", "done": 0, "total": 0, "message": err})
    );
    assert_eq!(run.swaps.0.load(Ordering::SeqCst), 0);
    assert!(!run.state.syncing.load(Ordering::SeqCst));
    let conn = run.state.lock_db();
    assert_eq!(get_meta(&conn, K_LAST_ERROR).as_deref(), Some(err.as_str()));
    assert!(
        get_meta(&conn, K_LAST_CHECK_AT).is_none(),
        "a run that failed has checked nothing it may throttle the next one on"
    );
    let logged: (String, String, String) = conn
        .query_row("SELECT source, operation, kind FROM error_log", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(
        logged,
        ("scryfall_api".into(), "bulk_download".into(), "http".into())
    );
}

// ---------------------------------------------------------------------------------------
// The same run on a host that keeps no files — a browser's Worker, stood in for
// ---------------------------------------------------------------------------------------
//
// `platform::host::emulate_page` makes the test's own thread a page: one thread, a file
// interface that refuses, and the response headers a cross-origin `fetch` hides hidden. The
// state is the browser's shape too — one connection, no read connection — so a lock held
// across the work that takes it is a panic naming the line, not a wait.

/// A page's state, with a stall bound short enough to wait out in a test.
fn page(
    name: &str,
    base_url: String,
) -> (
    Arc<State>,
    Arc<crate::events::fixtures::Recording>,
    std::path::PathBuf,
) {
    crate::state::fixtures::single_with(
        &format!("sync-page-{name}"),
        scryfall::Client::new(base_url).with_stall(std::time::Duration::from_millis(400)),
    )
}

/// The two headers the streamed run never sends, each for its own reason, with a mock that
/// fails the run if one goes out. Mounted first, so either wins over the mocks that serve.
///
/// * **`If-None-Match` a page may not send**: it is outside the CORS safelist, so it costs a
///   pre-flight, and Scryfall's bulk hosts refuse one — the request itself would fail.
/// * **`Range` a page *may* send** — a simple `Range: bytes=N-` is safelisted and needs no
///   pre-flight (measured, `docs/reference/light-app.md` §9.1). What a page cannot do is
///   read the `Content-Range` that says where the answer starts, so it could not verify a
///   resume; the streamed run therefore asks for the whole file, every time.
fn refuse_what_a_page_may_not_send<'a>(
    server: &'a MockServer,
    path: &'static str,
) -> [httpmock::Mock<'a>; 2] {
    [
        server.mock(|when, then| {
            when.method(GET).path(path).header_exists("if-none-match");
            then.status(500)
                .body("a pre-flight this host does not grant");
        }),
        server.mock(|when, then| {
            when.method(GET).path(path).header_exists("range");
            then.status(500)
                .body("a resume this run could not have verified");
        }),
    ]
}

fn staging_tables(state: &State) -> i64 {
    count(
        state,
        "SELECT count(*) FROM corpus.sqlite_master WHERE name = 'cards_staging'",
    )
}

/// **A first sync with nowhere to put a file**: the body goes from the request into the
/// ingest a chunk at a time, the page hears the phases it draws in the order it draws them,
/// and nothing is written but the database. Then the run after it, which a desktop would be
/// told `304` for — and which here is decided from the descriptor's own `updated_at`, because
/// a page may send no `If-None-Match` and can read no `ETag`.
#[tokio::test]
async fn a_first_sync_with_no_files_streams_into_the_ingest_and_the_next_finds_the_same_file() {
    let server = MockServer::start();
    // Mounted before `publish`'s own conditional mock, so these answer first.
    let conditional = refuse_what_a_page_may_not_send(&server, "/bulk-data/default_cards");
    let ranged = refuse_what_a_page_may_not_send(&server, "/default-cards.jsonl.gz");
    let size = publish(&server, 5);
    let _page = crate::platform::host::emulate_page();
    let (state, heard, dir) = page("first", server.base_url());

    let outcome = run_sync(state.clone(), false).await.unwrap();
    assert!(outcome.updated);
    assert_eq!(outcome.card_count, 5);
    assert_eq!(outcome.updated_at.as_deref(), Some(UPDATED_AT));

    let events = heard.taken();
    let seen = phases(&events);
    let fixed: Vec<&str> = seen
        .iter()
        .map(String::as_str)
        .filter(|p| !matches!(*p, "reclaiming" | "compacting"))
        .collect();
    assert_eq!(
        fixed,
        ["checking", "downloading", "ingesting", "sets", "done"],
        "the phases a file-backed run says, in its order: {seen:?}"
    );
    // Bytes while the body arrives, against the listing's size…
    let downloads: Vec<&serde_json::Value> = events
        .iter()
        .map(|(_, p)| p)
        .filter(|p| p["phase"] == "downloading")
        .collect();
    assert_eq!(
        *downloads[0],
        serde_json::json!({"phase": "downloading", "done": 0, "total": size, "message": null})
    );
    assert_eq!(
        **downloads.last().unwrap(),
        serde_json::json!({"phase": "downloading", "done": size, "total": size, "message": null})
    );
    // …and cards once it is in: what was staged before the swap, then the count that landed.
    let ingests: Vec<&serde_json::Value> = events
        .iter()
        .map(|(_, p)| p)
        .filter(|p| p["phase"] == "ingesting")
        .collect();
    assert_eq!(
        **ingests.last().unwrap(),
        serde_json::json!({"phase": "ingesting", "done": 5, "total": 117_000, "message": null})
    );
    assert!(
        ingests.iter().all(|p| p["total"] == 117_000),
        "every `ingesting` counts cards against the estimate: {ingests:?}"
    );
    assert_eq!(
        events.last().unwrap().1,
        serde_json::json!({"phase": "done", "done": 5, "total": 5, "message": "5 cards"})
    );

    assert_eq!(count(&state, "SELECT count(*) FROM cards"), 5);
    assert_eq!(count(&state, "SELECT count(*) FROM cards_fts"), 5);
    assert_eq!(count(&state, "SELECT count(*) FROM sets"), 1);
    assert_eq!(staging_tables(&state), 0, "the swap took staging with it");
    {
        let conn = state.lock_db();
        assert_eq!(
            get_meta(&conn, K_BULK_ETAG),
            None,
            "a page cannot read an ETag, so none is stored — the mock sent one"
        );
        assert_eq!(
            get_meta(&conn, K_BULK_UPDATED_AT).as_deref(),
            Some(UPDATED_AT)
        );
        assert_eq!(get_meta(&conn, K_CARD_COUNT).as_deref(), Some("5"));
        assert!(get_meta(&conn, K_LAST_CHECK_AT).is_some());
        assert!(get_meta(&conn, K_LAST_ERROR).is_none());
    }
    assert!(
        !dir.join("tmp").exists(),
        "no folder was made, because no file was written"
    );
    assert!(!state.syncing.load(Ordering::SeqCst));
    assert!(
        crate::index::lifecycle::current(&state).is_some(),
        "the index is built by the time the run returns: a Worker builds it where it stands"
    );
    for mock in conditional.iter().chain(&ranged) {
        assert_eq!(
            mock.calls(),
            0,
            "a header the streamed run never sends went out"
        );
    }

    // The run after it. An ETag left in the database — by nothing a page can do, but it must
    // not be replayed if one is ever there — and the same file on offer.
    set_meta(&state.lock_db(), K_BULK_ETAG, ETAG).unwrap();
    let again = run_sync(state.clone(), true).await.unwrap();
    assert!(!again.updated, "the descriptor names the file already held");
    assert_eq!(again.card_count, 5);
    assert_eq!(phases(&heard.taken()), ["checking", "done"]);
    for mock in conditional.iter().chain(&ranged) {
        assert_eq!(
            mock.calls(),
            0,
            "the stored ETag was replayed, or a resume was asked for"
        );
    }
    assert_eq!(count(&state, "SELECT count(*) FROM cards"), 5);
    assert!(!dir.join("tmp").exists());
}

/// **A body shorter than the listing promised is refused before the swap**, and leaves nothing
/// staged. A truncated bulk file is still valid gzip up to where it stops, so the byte count
/// is the only thing standing between a dropped connection and a partial card database.
#[tokio::test]
async fn a_short_body_with_no_files_is_refused_before_the_swap_and_leaves_no_staging() {
    let server = MockServer::start();
    let lines: Vec<String> = (0..5).map(card_line).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let bytes = std::fs::read(gz_fixture(&refs)).unwrap();
    server.mock(|when, then| {
        when.method(GET).path("/bulk-data/default_cards");
        then.status(200).json_body(serde_json::json!({
            "jsonl_download_uri": format!("{}/default-cards.jsonl.gz", server.base_url()),
            "updated_at": UPDATED_AT,
            // One byte more than the host will send.
            "compressed_size": bytes.len() + 1,
        }));
    });
    server.mock(|when, then| {
        when.method(GET).path("/default-cards.jsonl.gz");
        then.status(200).body(bytes.clone());
    });
    let _page = crate::platform::host::emulate_page();
    let (state, heard, dir) = page("short", server.base_url());
    // A corpus already here, which a refused download must leave exactly as it was.
    state
        .lock_db()
        .execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES ('kept', 'Kept', 'x', '1', 'en', 'normal', '{}')",
            [],
        )
        .unwrap();

    let err = run_sync(state.clone(), true).await.unwrap_err();
    assert_eq!(
        err,
        format!(
            "downloaded {} bytes, expected {}",
            bytes.len(),
            bytes.len() + 1
        )
    );
    let events = heard.taken();
    assert_eq!(phases(&events), ["checking", "downloading", "error"]);
    assert_eq!(
        count(&state, "SELECT count(*) FROM cards WHERE id = 'kept'"),
        1,
        "nothing was swapped"
    );
    assert_eq!(count(&state, "SELECT count(*) FROM cards"), 1);
    assert_eq!(staging_tables(&state), 0, "and what was staged is gone");
    assert!(!state.syncing.load(Ordering::SeqCst));
    assert!(!dir.join("tmp").exists());
    let conn = state.lock_db();
    assert_eq!(get_meta(&conn, K_LAST_ERROR).as_deref(), Some(err.as_str()));
    assert!(get_meta(&conn, K_LAST_CHECK_AT).is_none());
    assert!(get_meta(&conn, K_BULK_UPDATED_AT).is_none());
    let logged: (String, String, String) = conn
        .query_row("SELECT source, operation, kind FROM error_log", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(
        logged,
        (
            "scryfall_api".into(),
            "bulk_download".into(),
            "parse".into()
        )
    );
}

/// **A body that stops arriving ends the run in a sentence, after the stall bound** — which
/// in a browser is the only thing that ever would. The host answers, sends the first half of
/// a real file and then says nothing more with the connection open; the run gives up, says
/// so three ways, gives the flag back and leaves nothing staged.
#[tokio::test]
async fn a_body_that_stops_arriving_with_no_files_fails_the_run_after_the_stall_bound() {
    let lines: Vec<String> = (0..5).map(card_line).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let bytes = std::fs::read(gz_fixture(&refs)).unwrap();
    let quiet = crate::feed::quiet_host::start(bytes[..bytes.len() / 2].to_vec(), bytes.len());
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET).path("/bulk-data/default_cards");
        then.status(200).json_body(serde_json::json!({
            "jsonl_download_uri": format!("{quiet}/default-cards.jsonl.gz"),
            "updated_at": UPDATED_AT,
            "compressed_size": bytes.len(),
        }));
    });
    let _page = crate::platform::host::emulate_page();
    let (state, heard, _dir) = page("stalled", server.base_url());

    let began = crate::platform::clock::Tick::now();
    let err = run_sync(state.clone(), false).await.unwrap_err();
    let took = began.elapsed();
    assert!(err.contains("stalled"), "{err}");
    assert!(
        took >= std::time::Duration::from_millis(400),
        "it gave up before the bound: {took:?}"
    );
    assert!(
        took < std::time::Duration::from_secs(20),
        "the stall bound is what ended it, not the host: {took:?}"
    );

    assert_eq!(phases(&heard.taken()), ["checking", "downloading", "error"]);
    assert!(
        !state.syncing.load(Ordering::SeqCst),
        "a stalled run gives the flag back, so Retry is not refused"
    );
    assert_eq!(staging_tables(&state), 0);
    assert_eq!(count(&state, "SELECT count(*) FROM cards"), 0);
    let conn = state.lock_db();
    assert_eq!(get_meta(&conn, K_LAST_ERROR).as_deref(), Some(err.as_str()));
    let kind: String = conn
        .query_row(
            "SELECT kind FROM error_log WHERE operation = 'bulk_download'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kind, "timeout");
}

/// **And a host that never begins to answer**: the wait for the response is bounded too.
#[tokio::test]
async fn a_download_that_never_answers_with_no_files_gives_up_after_the_stall_bound() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET).path("/bulk-data/default_cards");
        then.status(200).json_body(serde_json::json!({
            "jsonl_download_uri": format!("{}/silent.jsonl.gz", server.base_url()),
            "updated_at": UPDATED_AT,
            "compressed_size": 100,
        }));
    });
    server.mock(|when, then| {
        when.method(GET).path("/silent.jsonl.gz");
        then.status(200)
            .delay(std::time::Duration::from_secs(10))
            .body("late");
    });
    let _page = crate::platform::host::emulate_page();
    let (state, heard, _dir) = page("silent", server.base_url());

    let began = crate::platform::clock::Tick::now();
    let err = run_sync(state.clone(), false).await.unwrap_err();
    assert!(err.contains("stalled"), "{err}");
    assert!(
        began.elapsed() < std::time::Duration::from_secs(8),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(phases(&heard.taken()), ["checking", "downloading", "error"]);
    assert_eq!(
        staging_tables(&state),
        0,
        "nothing was staged for a body that never came"
    );
}
