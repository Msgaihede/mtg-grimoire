//! **What the web host does, with no browser in it** — so every decision it makes is compiled
//! and tested on a desktop.
//!
//! `glue.rs` is the browser: three `#[wasm_bindgen]` exports, the OPFS pool, a `thread_local`
//! for the state. Everything those three *decide* is here, and each takes what a browser would
//! have handed it as an argument: where the databases are ([`start`]), whether the state exists
//! yet ([`call`]), and whether somebody already asked ([`Once`]).

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::future::{FutureExt as _, LocalBoxFuture, Shared};
use grimoire_core::events::EventSink;
use grimoire_core::state::State;
use serde_json::Value;

use crate::wire::{self, Opened};

/// The name the OPFS pool's VFS registers under — `sqlite-wasm-vfs`'s own default, spelled so
/// a second VFS cannot be mistaken for this one by a typo.
pub const POOL_VFS: &str = "opfs-sahpool";

/// How many files the pool preallocates. **Files, not bytes.**
///
/// The pool is every file SQLite will ever open through it: two databases, a rollback journal
/// for each (the pool refuses WAL), and — because the one-connection opener keeps its temporary
/// b-trees in the VFS (`grimoire_core::db::open_single`) — one more for each sort behind a
/// `CREATE INDEX` or an FTS rebuild while it runs. A pool with no slot left fails the statement
/// that asked, and mid-ingest that is not survivable.
///
/// **64 is the first web host's figure and is headroom nobody has justified by measurement**:
/// it was raised from 12 against a failure later traced to something else, and whether 12 would
/// do was never re-measured. It ran a whole first ingest at 64, which is what this keeps;
/// measuring a smaller one is an experiment to run on purpose, with an ingest, and is not this
/// step's.
pub const POOL_CAPACITY: u32 = 64;

/// What Settings shows where a desktop shows a folder: the OPFS directory a reader would have
/// to look in. Not a path anything can open — on this host nothing opens it.
pub fn shown(directory: &str) -> PathBuf {
    PathBuf::from(format!("OPFS:/{directory}"))
}

/// What a `call` before `open` is told.
pub const NOT_OPEN: &str = "The app's database is not open yet.";

/// What [`start`] made.
pub struct Started {
    /// The state every later `call` answers from.
    pub state: Arc<State>,
    /// What `open` answers — always [`Opened::Ready`].
    pub opened: Opened,
    /// The facet index's first build. **Never a reason `open` fails**: faceting fails open by
    /// design — a cold index leaves every filter control live — so a build that could not run
    /// is a sentence for the console and an app that works.
    pub index: Result<(), String>,
}

/// **Everything `open` does once the storage is installed**: the pair on one connection, at
/// head; a [`State`] with no read connection; the facet index built.
///
/// `databases` is where the two files are — **empty in a browser**, where the pool is the
/// filesystem and its names are bare, and a scratch directory in a test, which is what lets
/// this run on a desktop. `directory` is the OPFS directory's name, for [`shown`]. `events` is
/// where the engine's events go.
///
/// **It starts nothing else.** No card sync, no feed and no image upkeep: a download in a
/// browser has no temp file to land in and is the next step's (the light-app spec §6), and the
/// upkeep loop evicts files this host does not have (`grimoire_core::images::upkeep_tick`).
///
/// No write observers: the desktop's three are its mirror, its other windows and its live
/// socket, and this host has none of them.
pub fn start(
    databases: &Path,
    directory: &str,
    events: Arc<dyn EventSink>,
) -> Result<Started, String> {
    let data_dir = shown(directory);
    let opened = grimoire_core::launch::open_single(databases, &data_dir)?;
    // Unqualified would be `main` too; spelled, so nobody has to know that to read this.
    let schema_version: i64 = opened
        .write
        .query_row("PRAGMA main.user_version", [], |r| r.get(0))
        .map_err(|e| format!("MTG Grimoire could not read its database's version: {e}"))?;
    let ready = Opened::Ready {
        journal: opened.journal.as_str().to_owned(),
        corpus_journal: opened.corpus_journal.as_str().to_owned(),
        schema_version,
    };
    let state = Arc::new(State::new(
        opened.write,
        // `None`: this host's storage permits one connection, so reads go through the one
        // that writes.
        opened.read,
        data_dir,
        events,
        Vec::new(),
        opened.client,
        opened.images,
    ));
    // A corpus may already be here from an earlier session, so the index is built now rather
    // than only after an ingest. On the caller: a Worker has no other thread to build it on.
    let index = grimoire_core::index::lifecycle::build_now(&state);
    Ok(Started {
        state,
        opened: ready,
        index,
    })
}

/// Answer one command, as the JSON text the Worker parses — `{"ok": …}` or `{"err": "…"}`
/// ([`wire::answer`]).
///
/// `args` is JSON text: `null`, or the object `src/lib/ipc.ts` would have handed Tauri.
/// **Every way this can go wrong is an `err`**: no state yet ([`NOT_OPEN`]), arguments that
/// are not JSON, and whatever `grimoire_core::dispatch` refuses — a name the table does not
/// have, arguments that do not fit, a raw body where none belongs.
pub async fn call(
    state: Option<Arc<State>>,
    name: &str,
    args: &str,
    body: Option<Vec<u8>>,
) -> String {
    wire::answer(answered(state, name, args, body).await)
}

async fn answered(
    state: Option<Arc<State>>,
    name: &str,
    args: &str,
    body: Option<Vec<u8>>,
) -> Result<Value, String> {
    let Some(state) = state else {
        return Err(format!("{name}: {NOT_OPEN}"));
    };
    let args: Value = serde_json::from_str(args)
        .map_err(|e| format!("{name}: its arguments are not JSON: {e}"))?;
    grimoire_core::dispatch(&state, name, args, body).await
}

/// An event's payload as the text `listen`'s handler is called with.
pub fn payload_text(payload: &Value) -> String {
    payload.to_string()
}

/// **The first `open`, shared by every caller of it.**
///
/// `open` installs a pool of exclusive file handles and builds the state. Done twice it would
/// install a second pool and replace the state under every call in flight — and a page under
/// React's StrictMode, or a Worker script that is simply asked twice, does ask twice, the
/// second time before the first has finished. So the first call's *future* is kept, and every
/// later call awaits a clone of it: one install, one state, and the same answer for all of
/// them — a failure included. A page that wants another attempt reloads, which is a new Worker.
///
/// Not `Sync`, and it need not be: it lives in a `thread_local` of a Worker's one thread.
pub struct Once<T: Clone + 'static>(RefCell<Option<Shared<LocalBoxFuture<'static, T>>>>);

impl<T: Clone + 'static> Once<T> {
    pub const fn new() -> Self {
        Once(RefCell::new(None))
    }

    /// The first call's future — started by `start` if this is the first call, and `start` is
    /// not run otherwise. `start` only *makes* the future; nothing is polled here.
    pub fn get(
        &self,
        start: impl FnOnce() -> LocalBoxFuture<'static, T>,
    ) -> Shared<LocalBoxFuture<'static, T>> {
        self.0
            .borrow_mut()
            .get_or_insert_with(|| start().shared())
            .clone()
    }
}

impl<T: Clone + 'static> Default for Once<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimoire_core::events::fixtures::Recording;
    use serde_json::json;
    use std::cell::Cell;

    fn scratch(name: &str) -> PathBuf {
        let dir = grimoire_core::scratch::path(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).expect("the Worker must be able to parse it")
    }

    /// The whole of `open` behind the pool, on a desktop: both files at head on one
    /// connection, a state that reads through the connection it writes with, an index, and the
    /// answer a page is given.
    #[test]
    fn a_start_opens_one_connection_and_answers_ready() {
        let dir = scratch("web-start");
        let started = start(&dir, "mtg-grimoire", Arc::new(Recording::default())).unwrap();

        let Opened::Ready {
            journal,
            corpus_journal,
            schema_version,
        } = &started.opened
        else {
            panic!("a start that worked answers ready: {:?}", started.opened);
        };
        // A file on this machine gets the WAL it was asked for; a browser's pool answers
        // `delete`. Either way it is SQLite's answer that is reported.
        assert_eq!((journal.as_str(), corpus_journal.as_str()), ("wal", "wal"));
        assert_eq!(*schema_version, grimoire_core::schema::USER_SCHEMA_VERSION);

        let state = &started.state;
        assert!(state.one_connection());
        assert!(std::ptr::eq(state.reader(), &state.db));
        assert_eq!(state.data_dir, Path::new("OPFS:/mtg-grimoire"));
        assert_eq!(started.index, Ok(()));
        assert!(
            grimoire_core::index::lifecycle::current(state).is_some(),
            "the index is built before `open` answers"
        );
        assert!(
            !state.syncing.load(std::sync::atomic::Ordering::SeqCst),
            "and nothing was started"
        );
    }

    /// A start that cannot open says so in a sentence that names what a reader can see, and
    /// there is no state for a later call to find.
    #[test]
    fn a_start_that_cannot_open_is_a_sentence() {
        let missing = scratch("web-start-missing").join("not-here");
        let refused = start(&missing, "mtg-grimoire", Arc::new(Recording::default()))
            .err()
            .expect("there is nowhere to open");
        assert!(
            refused.contains("could not open its databases in OPFS:/mtg-grimoire"),
            "{refused}"
        );
    }

    /// **Never a rejection, never a trap**: a call before `open`, arguments that are not JSON,
    /// a name the table does not have and a body where none belongs are each `{"err": …}`.
    #[tokio::test]
    async fn every_wrong_call_is_an_err_and_names_the_command() {
        let before = parsed(&call(None, "deck_list", "null", None).await);
        assert_eq!(before, json!({ "err": format!("deck_list: {NOT_OPEN}") }));

        let dir = scratch("web-call-wrong");
        let state = start(&dir, "x", Arc::new(Recording::default()))
            .unwrap()
            .state;
        let _alone = grimoire_core::platform::alone::emulate();
        let ask = |name: &'static str, args: &'static str, body: Option<Vec<u8>>| {
            let state = Some(state.clone());
            async move { parsed(&call(state, name, args, body).await) }
        };

        for not_json in ["", "{not json", "undefined"] {
            let answer = ask("deck_list", not_json, None).await;
            let sentence = answer["err"].as_str().expect("an err");
            assert!(
                sentence.starts_with("deck_list: its arguments are not JSON"),
                "{sentence}"
            );
        }
        assert_eq!(
            ask("nothing_here", "null", None).await,
            json!({ "err": "There is no command named nothing_here on this host." })
        );
        let wrong_shape = ask("deck_get", r#"{"id":"one"}"#, None).await;
        assert!(wrong_shape["err"]
            .as_str()
            .is_some_and(|e| e.contains("its arguments did not parse")));
        let body = ask("deck_list", "null", Some(vec![1, 2, 3])).await;
        assert_eq!(body, json!({ "err": "deck_list takes no raw body." }));
    }

    /// A call is the table's: a write lands, the read after it sees it, and `null` and `{}`
    /// are both "no arguments" — all on one connection, on a thread standing in for a Worker.
    #[tokio::test]
    async fn a_call_answers_through_the_table_on_one_connection() {
        let dir = scratch("web-call");
        let heard = Arc::new(Recording::default());
        let state = start(&dir, "x", heard).unwrap().state;
        let _alone = grimoire_core::platform::alone::emulate();
        let ask = |name: &'static str, args: &'static str| {
            let state = Some(state.clone());
            async move { parsed(&call(state, name, args, None).await) }
        };

        let made = ask("deck_create", r#"{"deck":{"name":"From a page"}}"#).await;
        let id = made["ok"]["id"].as_i64().expect("the new deck's id");
        for no_args in ["null", "{}"] {
            let listed = ask("deck_list", no_args).await;
            let decks = listed["ok"].as_array().expect("a list");
            assert_eq!(decks.len(), 1);
            assert_eq!(decks[0]["id"], id);
            assert_eq!(decks[0]["name"], "From a page");
        }
        // An answer of nothing is `{"ok":null}`, and still an answer.
        assert_eq!(
            ask("set_nav_collapsed", r#"{"collapsed":true}"#).await,
            json!({ "ok": null })
        );
        assert_eq!(ask("nav_collapsed", "null").await, json!({ "ok": true }));
    }

    /// **Asked twice, `open` runs once** — the second caller, asking before the first has
    /// finished, is given the first's answer, and so is one that asks after.
    #[tokio::test]
    async fn the_first_open_is_the_only_one_and_everyone_gets_its_answer() {
        let once: Once<String> = Once::new();
        let started = Cell::new(0);
        let begin = |answer: &'static str| {
            started.set(started.get() + 1);
            async move {
                // Not finished by the time the second caller asks.
                tokio::task::yield_now().await;
                answer.to_owned()
            }
            .boxed_local()
        };

        let first = once.get(|| begin("first"));
        let second = once.get(|| begin("second"));
        assert_eq!(started.get(), 1, "the second call must not start another");
        assert_eq!(
            futures_util::future::join(first, second).await,
            ("first".to_owned(), "first".to_owned())
        );
        assert_eq!(once.get(|| begin("third")).await, "first");
        assert_eq!(started.get(), 1);
    }

    #[test]
    fn an_events_payload_is_json_text_and_the_folder_shown_is_not_a_path() {
        let payload = json!({ "phase": "ingesting", "done": 2000 });
        // Read back rather than compared as text: a page reads keys, and their order is
        // whatever the workspace's `serde_json` features make it.
        assert_eq!(parsed(&payload_text(&payload)), payload);
        assert_eq!(payload_text(&Value::Null), "null");
        assert_eq!(shown("mtg-grimoire"), Path::new("OPFS:/mtg-grimoire"));
    }

    /// The three hosts ship from one tag, so this manifest's version is the core's — which is
    /// the version every request this host makes is signed with (`scryfall::USER_AGENT`).
    #[test]
    fn the_host_wears_the_cores_version() {
        let expected = concat!("MTGGrimoire/", env!("CARGO_PKG_VERSION"), " (");
        assert!(
            grimoire_core::scryfall::USER_AGENT.starts_with(expected),
            "`{}` does not name this build, {}: crates/grimoire-core/Cargo.toml and \
             crates/grimoire-web/Cargo.toml must carry the same version",
            grimoire_core::scryfall::USER_AGENT,
            env!("CARGO_PKG_VERSION")
        );
    }
}
