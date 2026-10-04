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
    /// Whether the corpus was thrown away and built again empty to get here
    /// (`grimoire_core::launch::open_single_replacing`). The reader's rows are untouched; the
    /// launch's card sync is what brings the cards back, and the console is told.
    pub corpus_replaced: bool,
}

/// **Everything `open` does once the storage is installed**: the pair on one connection, at
/// head; a [`State`] with no read connection; the facet index built.
///
/// `databases` is where the two files are — **empty in a browser**, where the pool is the
/// filesystem and its names are bare, and a scratch directory in a test, which is what lets
/// this run on a desktop. `directory` is the OPFS directory's name, for [`shown`]. `events` is
/// where the engine's events go.
///
/// **It starts nothing else.** The launch's downloads are [`launch_downloads`], which the
/// caller spawns once this has answered — never inside it, so `open` is not kept waiting on a
/// network. And no image upkeep: that loop evicts files this host does not have
/// (`grimoire_core::images::upkeep_tick`).
///
/// No write observers: the desktop's three are its mirror, its other windows and live sync's
/// wake. This host has neither of the first two, and it does not start the core's live-sync
/// loop — a browser's socket is not written yet (`grimoire_core::platform::socket`) — so it
/// registers no wake for one either, and `sync_live_state` answers `off`.
///
/// **A corpus that will not open stops this**, because nothing here can delete one:
/// [`start_replacing`] is the same start for a caller that can.
pub fn start(
    databases: &Path,
    directory: &str,
    events: Arc<dyn EventSink>,
) -> Result<Started, String> {
    started(databases, directory, events, None)
}

/// [`start`] for a caller that can delete the corpus from its storage — the browser, whose
/// pool has a delete of its own. A corpus that will not open or will not migrate is thrown
/// away through `delete_corpus` and the pair is opened again; `user.db` is never touched.
///
/// **What decides it is the core's** (`grimoire_core::launch::open_single_replacing`: which
/// failures are about the corpus file, that the delete is tried once, and what is said when
/// it fails). The closure is only the delete, and is called with no connection open.
pub fn start_replacing(
    databases: &Path,
    directory: &str,
    events: Arc<dyn EventSink>,
    delete_corpus: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Started, String> {
    started(databases, directory, events, Some(delete_corpus))
}

fn started(
    databases: &Path,
    directory: &str,
    events: Arc<dyn EventSink>,
    delete_corpus: Option<&mut dyn FnMut() -> Result<(), String>>,
) -> Result<Started, String> {
    let data_dir = shown(directory);
    let opened = match delete_corpus {
        Some(delete) => grimoire_core::launch::open_single_replacing(databases, &data_dir, delete)?,
        None => grimoire_core::launch::open_single(databases, &data_dir)?,
    };
    let corpus_replaced = opened.corpus_replaced;
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
        corpus_replaced,
    })
}

/// **Which of a pool's files are the corpus's, in the order to delete them** — whatever
/// SQLite keeps beside the database under its name first (a rollback journal on this host; a
/// `-wal` and `-shm` are matched too, for a storage that ever grants them), and **the
/// database itself last**. What [`delete_corpus`] deletes.
///
/// The order is for a delete that stops partway: with the journal gone first, what is left
/// is at worst the old database with nothing beside it — which the next launch finds still
/// unreadable and throws away again. The other order could leave an old journal beside a
/// corpus the next open has just made.
///
/// A pool names a file by the path SQLite opened it under, and whether that carries a leading
/// slash is the VFS's business, so the match is on the last segment. **Never `user.db` or
/// anything of its**: the list is built from the corpus's own name and nothing else.
pub fn corpus_files(pool: &[String]) -> Vec<String> {
    fn last_segment(name: &str) -> &str {
        name.rsplit('/').next().unwrap_or(name)
    }
    let corpus = grimoire_core::db::CORPUS_DB;
    let beside = pool.iter().filter(|name| {
        last_segment(name.as_str())
            .strip_prefix(corpus)
            .is_some_and(|rest| rest.starts_with('-'))
    });
    let itself = pool
        .iter()
        .filter(|name| last_segment(name.as_str()) == corpus);
    beside.chain(itself).cloned().collect()
}

/// **Delete the corpus from a pool**: every one of [`corpus_files`], in its order, through
/// `delete` — the pool's own, which `glue` hands in. **Every file is attempted whatever an
/// earlier one answered**, and the first failure is what is reported, with the file it was
/// about: stopping at the first would leave the rest of a corpus beside whatever the next
/// open makes.
pub fn delete_corpus(
    pool: &[String],
    delete: &mut dyn FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut first: Result<(), String> = Ok(());
    for name in corpus_files(pool) {
        if let Err(why) = delete(&name) {
            if first.is_ok() {
                first = Err(format!("{name}: {why}"));
            }
        }
    }
    first
}

/// What a launch tells the console when it had to replace the corpus — the sentence a desktop
/// writes to its log for the same thing.
pub const CORPUS_REPLACED: &str = "the card database could not be opened and has been \
     replaced; the next sync will rebuild it. Nothing in your collection, decks or wishlist \
     was touched.";

/// **The launch's downloads, one after another**: the card sync when it is due, and then the
/// optional feeds — the selected marketplace's price list, both Tagger files and the combos —
/// each when it is due. The caller spawns this after `open` has answered and never awaits it.
///
/// **Always the cards first** (issue #551's rule for a first run — the reader is waiting for
/// the cards, and tens of megabytes of feeds on the same link would make that longer for
/// data no screen can use yet). **And, on this host, on every later launch too**, where a
/// host with threads runs the feeds *beside* the card sync and starts all four at once. A
/// Worker is one thread, which changes three things:
///
/// * **nothing is gained but overlap on the network.** Every ingest is this one thread's
///   work, so two at once are each slower and leave a page's own calls less room between
///   them;
/// * **memory is the module's linear memory, which grows and is never given back.** Run
///   together, the session's high-water mark is the *sum* of a card batch, a tag graph, a
///   combo list and a price map rather than the largest of them;
/// * **a download waiting on its next chunk is waiting on a timer** (`scryfall::STALL`), and
///   a timer here counts through whatever else the thread does. Beside a card sync's swap,
///   reclaim and index build — seconds on a desktop, untimed in a browser — a feed's wait
///   would be measuring that tail rather than its own connection. The stall bound takes a
///   second look before it believes a deadline, which is the cure for a stretch it cannot
///   avoid (a command a page sends); not starting two downloads at once is what keeps the
///   longest stretches out of it altogether.
///
/// Each is still its own run with its own claim, its own failure and its own stall bound, so
/// none can stop the next: a download that fails, or stalls for its minute, is logged and the
/// next one starts. ⚠️ What it costs is that a slow card sync delays the feeds behind it —
/// minutes, on a day Scryfall has rotated the bulk file. Chosen by reasoning; no browser has
/// run either arrangement.
///
/// **Not an upkeep loop.** It runs once per launch and ends; a feed that was not due is not
/// looked at again until the next one.
///
/// Every failure is already where a reader can find it — `sync_meta.last_error` and the
/// `error` phase for the card sync, `error_log` for a feed — so nothing is returned.
pub async fn launch_downloads(state: Arc<State>) {
    // The error is in `last_error` and in the `error` event by the time this returns.
    let _ = grimoire_core::sync::run_sync(Arc::clone(&state), false).await;
    grimoire_core::marketplace_feed::refresh_selected_if_due(&state).await;
    grimoire_core::tags::oracle::refresh_if_due(&state).await;
    grimoire_core::tags::art::refresh_if_due(&state).await;
    grimoire_core::combos::refresh_if_due(&state).await;
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

    // ---- a corpus that will not open, and the pool's delete -----------------------------

    /// The pool's files that are the corpus's, however the VFS spells a name — and never the
    /// reader's own, nor a file that merely starts the same way. What SQLite keeps beside the
    /// database comes first and the database last, which is the order to delete them in.
    #[test]
    fn the_corpus_files_of_a_pool_are_the_database_and_what_sqlite_keeps_beside_it() {
        let pool: Vec<String> = [
            "/user.db",
            "/user.db-journal",
            "/corpus.db",
            "/corpus.db-journal",
            "corpus.db-wal",
            "/corpus.dbx",
            "/not-corpus.db",
            "/etilqs_1234",
        ]
        .map(str::to_owned)
        .to_vec();
        assert_eq!(
            corpus_files(&pool),
            ["/corpus.db-journal", "corpus.db-wal", "/corpus.db"]
        );
        assert!(corpus_files(&["user.db".to_owned()]).is_empty());
    }

    /// **Every file of the corpus is attempted whatever an earlier one answered**, the journal
    /// before the database, and what is reported is the first failure with the file it was
    /// about. A delete that stopped at the first refusal would leave the rest of an old
    /// corpus beside whatever the next open makes.
    #[test]
    fn deleting_the_corpus_tries_every_file_and_reports_the_first_that_would_not_go() {
        let pool: Vec<String> = ["/corpus.db", "/user.db", "/corpus.db-journal"]
            .map(str::to_owned)
            .to_vec();

        let mut asked: Vec<String> = Vec::new();
        let all = delete_corpus(&pool, &mut |name| {
            asked.push(name.to_owned());
            Ok(())
        });
        assert_eq!(all, Ok(()));
        assert_eq!(asked, ["/corpus.db-journal", "/corpus.db"]);

        let mut asked: Vec<String> = Vec::new();
        let journal_held = delete_corpus(&pool, &mut |name| {
            asked.push(name.to_owned());
            if name.ends_with("-journal") {
                Err("held".to_owned())
            } else {
                Ok(())
            }
        });
        assert_eq!(journal_held, Err("/corpus.db-journal: held".to_owned()));
        assert_eq!(
            asked,
            ["/corpus.db-journal", "/corpus.db"],
            "the database is still attempted after the journal would not go"
        );

        let mut asked = 0;
        let both = delete_corpus(&pool, &mut |name| {
            asked += 1;
            Err(format!("no ({name})"))
        });
        assert_eq!(
            both,
            Err("/corpus.db-journal: no (/corpus.db-journal)".to_owned()),
            "the first failure, not the last"
        );
        assert_eq!(asked, 2);
        assert_eq!(
            delete_corpus(&[], &mut |_| Err("never asked".to_owned())),
            Ok(())
        );
    }

    /// **A start over a corpus that will not migrate, on a host that can delete it**: the
    /// corpus goes, the start answers `ready` and says it replaced something, and the deck
    /// the reader made is still there. The closure stands in for the pool's `delete_db`.
    #[tokio::test]
    async fn a_start_replaces_a_corpus_that_will_not_migrate_and_keeps_the_readers_rows() {
        let dir = scratch("web-start-replacing");
        {
            let state = start(&dir, "x", Arc::new(Recording::default()))
                .unwrap()
                .state;
            let made = call(
                Some(state),
                "deck_create",
                r#"{"deck":{"name":"Kept"}}"#,
                None,
            )
            .await;
            assert!(parsed(&made)["ok"]["id"].is_i64(), "{made}");
        }
        // A corpus at version 0 that already holds a table the climb builds.
        let corpus = dir.join(grimoire_core::db::CORPUS_DB);
        let delete = |dir: &Path| {
            for name in corpus_files(
                &std::fs::read_dir(dir)
                    .unwrap()
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
            ) {
                std::fs::remove_file(dir.join(name)).unwrap();
            }
        };
        delete(&dir);
        rusqlite_free_spoil(&corpus);

        let _page = grimoire_core::platform::host::emulate_page();
        let stopped = start(&dir, "x", Arc::new(Recording::default()))
            .err()
            .expect("a start that cannot delete its corpus stops");
        assert!(stopped.contains("table cards already exists"), "{stopped}");

        let mut deletes = 0;
        let started = start_replacing(&dir, "x", Arc::new(Recording::default()), &mut || {
            deletes += 1;
            delete(&dir);
            Ok(())
        })
        .expect("and one that can goes on");
        assert_eq!(deletes, 1);
        assert!(started.corpus_replaced);
        assert!(matches!(started.opened, Opened::Ready { .. }));
        let decks = parsed(&call(Some(started.state), "deck_list", "null", None).await);
        assert_eq!(decks["ok"][0]["name"], "Kept");
    }

    /// A corpus that will not migrate, without naming SQLite's crate in this one's manifest:
    /// the engine's own opener makes the file, at version 0 with a `cards` of the wrong shape.
    fn rusqlite_free_spoil(corpus: &Path) {
        let conn = grimoire_core::db::open(corpus).unwrap();
        conn.execute_batch("CREATE TABLE cards (id TEXT)").unwrap();
        grimoire_core::db::checkpoint_truncate(&conn).unwrap();
    }

    // ---- what a launch downloads, and in what order -------------------------------------

    use flate2::{write::GzEncoder, Compression};
    use httpmock::prelude::*;
    use std::io::Write as _;

    fn gz(lines: &[String]) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
        for line in lines {
            enc.write_all(line.as_bytes()).unwrap();
            enc.write_all(b"\n").unwrap();
        }
        enc.finish().unwrap()
    }

    /// One bulk dataset on the mock: its descriptor and its file. Answers the descriptor's
    /// mock, whose hit count is how many times the launch asked.
    fn publish<'a>(
        server: &'a MockServer,
        dataset: &str,
        updated_at: &str,
        body: Vec<u8>,
    ) -> httpmock::Mock<'a> {
        let file = format!("/{dataset}.jsonl.gz");
        let size = body.len();
        server.mock(|when, then| {
            when.method(GET).path(file.clone());
            then.status(200).body(body);
        });
        server.mock(|when, then| {
            when.method(GET).path(format!("/bulk-data/{dataset}"));
            then.status(200).json_body(json!({
                "updated_at": updated_at,
                "jsonl_download_uri": server.url(file.clone()),
                "compressed_size": size,
            }));
        })
    }

    fn count(state: &State, sql: &str) -> i64 {
        state.lock_db().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// Where each event sits among everything the launch said.
    fn positions(events: &[(String, Value)], name: &str) -> Vec<usize> {
        events
            .iter()
            .enumerate()
            .filter(|(_, (n, _))| n == name)
            .map(|(i, _)| i)
            .collect()
    }

    /// **A launch downloads the cards and only then the feeds, one after another — on a first
    /// run and on every later one; and a launch with nothing due asks nobody.** On a thread
    /// standing in for a browser's Worker, against a mock Scryfall: one connection, no files.
    #[tokio::test]
    async fn a_launch_downloads_the_cards_and_then_each_feed_in_turn_on_every_launch() {
        let cards: Vec<String> = (0..3)
            .map(|i| {
                format!(
                    r#"{{"object":"card","id":"c{i}","oracle_id":"o{i}","name":"Card {i}","lang":"en","layout":"normal","set":"x","collector_number":"{i}","games":["paper"],"finishes":["nonfoil"],"digital":false}}"#
                )
            })
            .collect();
        let oracle = vec![
            r#"{"object":"tag","id":"t1","label":"ramp","slug":"ramp","type":"oracle","description":"","parent_ids":[],"child_ids":[],"aliases":[],"taggings":[{"oracle_id":"o1","weight":"median"}]}"#.to_owned(),
        ];
        let art = vec![
            r#"{"object":"tag","id":"a1","label":"Dog","slug":"dog","type":"illustration","description":null,"parent_ids":[],"child_ids":[],"aliases":[],"taggings":[{"object":"tagging","illustration_id":"i1","weight":"strong"}]}"#.to_owned(),
        ];
        let server = MockServer::start();
        let stamp = "2026-10-04T09:00:00.000+00:00";
        let cards_asked = publish(&server, "default_cards", stamp, gz(&cards));
        let oracle_asked = publish(&server, "oracle_tags", stamp, gz(&oracle));
        let art_asked = publish(&server, "art_tags", stamp, gz(&art));
        server.mock(|when, then| {
            when.method(GET).path("/sets");
            then.status(200)
                .json_body(json!({"has_more": false, "data": [{"code": "x", "name": "Set X"}]}));
        });

        let _page = grimoire_core::platform::host::emulate_page();
        let (state, heard, _dir) = grimoire_core::state::fixtures::single_with(
            "web-launch-downloads",
            grimoire_core::scryfall::Client::new(server.base_url()),
        );
        // Just checked, so the launch asks Commander Spellbook — a real host — nothing.
        state
            .lock_db()
            .execute(
                "INSERT INTO combo_meta (id, checked_at) VALUES (1, unixepoch())",
                [],
            )
            .unwrap();
        let oracle_event = grimoire_core::tags::oracle::ORACLE.progress_event;
        let art_event = grimoire_core::tags::art::ART.progress_event;

        // A first run: no card in the corpus.
        launch_downloads(Arc::clone(&state)).await;
        assert_eq!(count(&state, "SELECT count(*) FROM cards"), 3);
        assert_eq!(count(&state, "SELECT count(*) FROM oracle_tag_cards"), 1);
        assert_eq!(
            count(&state, "SELECT count(*) FROM art_tag_illustrations"),
            1
        );
        let events = heard.taken();
        let sync = positions(&events, "sync:progress");
        let oracle_at = positions(&events, oracle_event);
        let art_at = positions(&events, art_event);
        assert_eq!(
            events[*sync.last().unwrap()].1["phase"],
            "done",
            "the card sync finished"
        );
        assert!(
            sync.last() < oracle_at.first(),
            "on a first run no feed says anything until the cards are in: {events:?}"
        );
        assert!(
            oracle_at.last() < art_at.first(),
            "and the feeds run one after another"
        );
        assert_eq!(
            (cards_asked.calls(), oracle_asked.calls(), art_asked.calls()),
            (1, 1, 1)
        );
        assert!(!state.syncing.load(std::sync::atomic::Ordering::SeqCst));

        // A launch with nothing due: the card check is a day off, the tags a week.
        launch_downloads(Arc::clone(&state)).await;
        assert!(heard.taken().is_empty(), "nothing due, nothing said");
        assert_eq!(
            (cards_asked.calls(), oracle_asked.calls(), art_asked.calls()),
            (1, 1, 1),
            "and nobody asked"
        );

        // A later launch with both due: still one after the other. A host with threads runs
        // them side by side here; a Worker's one thread would have a feed's wait for its next
        // chunk timed through the card sync's long tail.
        {
            let conn = state.lock_db();
            conn.execute(
                "UPDATE sync_meta SET value = '1' WHERE key = 'last_check_at'",
                [],
            )
            .unwrap();
            conn.execute("UPDATE oracle_tag_meta SET checked_at = 1", [])
                .unwrap();
        }
        launch_downloads(Arc::clone(&state)).await;
        let events = heard.taken();
        let sync = positions(&events, "sync:progress");
        let oracle_at = positions(&events, oracle_event);
        assert!(
            !sync.is_empty() && !oracle_at.is_empty(),
            "both were due: {events:?}"
        );
        assert_eq!(
            events[*sync.last().unwrap()].1["phase"],
            "done",
            "the card sync finished"
        );
        assert!(
            sync.last() < oracle_at.first(),
            "the tag check goes out after the card sync has finished, not beside it: {events:?}"
        );
        assert_eq!((cards_asked.calls(), oracle_asked.calls()), (2, 2));
        assert_eq!(art_asked.calls(), 1, "the art tags were not due");
        assert_eq!(count(&state, "SELECT count(*) FROM cards"), 3);
    }
}
