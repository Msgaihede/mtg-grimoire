//! What every host holds for as long as it runs: the connections, where the data lives, the
//! cross-file fence and the way out for an event.
//!
//! [`State`] is the half of the desktop's `AppState` that has no reason to know about a
//! window. A host builds one from the connections it opened, and from then on everything in
//! this crate that needs the database is handed a `&State` or a `&Connection` taken from it.
//!
//! **It is the every-host half as far as the extraction has got.** The Scryfall client, the
//! facet index, the sync-in-flight flag and the image cache are here since the I/O step
//! brought the card sync, the index's lifecycle and the cache, and the pending pairing offer
//! since the sync step brought its type.
//!
//! **[`with_write`] is the one definition of a user-facing write**, and it is here since the
//! extraction's domain step brought the managed wishlist and the token reconcile its body calls.
//!
//! **[`Store`] and [`Lane`] are how a sync operation reaches the database** — a stretch at a
//! time, with nothing held across a request, and one operation at a time. They are here since
//! the sync step, ahead of the modules that use them, because the lane is a field of the state.
//!
//! **A host opens the connections; this does not.** Bringing the pair to head and running the
//! launch's logged passes is [`crate::schema::prepare_database`], which is this crate's too —
//! but the desktop converts a pre-27 single file first, with a module only it has, so what a
//! host-neutral "open the data folder" should be is left to the first host that is not the
//! desktop. [`State::new`] takes connections that are already at head.

use crate::db::{self, CrossFileFence};
use crate::events::EventSink;
use crate::hooks::{self, WriteObserver};
use crate::index::lifecycle::IndexSlot;
use crate::platform::clock::Tick;
use crate::platform::sync::{Held, Lock, Shared};
use crate::platform::timer;
use crate::scryfall;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

/// The connections and what rides them.
///
/// **One connection writes, and every writer shares it** — the ingest included, which is why it
/// takes the lock a batch at a time rather than for its whole run. Take it through
/// [`State::lock_db`] where waiting is right, and through [`db::lock_for`] or
/// [`db::lock_background`] where it is not; `db` is public for those two.
pub struct State {
    /// The write connection, with the hooks [`State::new`] installed on it.
    pub db: Mutex<Connection>,
    /// The read-only connection, on a host that has one — see [`State::reader`].
    db_read: Option<Mutex<Connection>>,
    pub data_dir: PathBuf,
    /// Whether any transaction on `db` has committed across both files.
    ///
    /// An `Arc` because the update hook on `db` holds a clone of it for the life of the
    /// process. See [`CrossFileFence`], which also names what it cannot see.
    pub fence: Arc<CrossFileFence>,
    /// Where an event goes — see [`crate::events`].
    pub events: Arc<dyn EventSink>,
    /// Whether a card sync is in flight. Claimed with an atomic swap and released by a guard
    /// in [`crate::sync::run_sync`], so no way out of a run leaves it set.
    pub syncing: AtomicBool,
    /// The one Scryfall client: one pacing gate and one 429 lockout for everything that asks
    /// `api.scryfall.com` — the card sync here, and the tag feeds, which borrow it.
    pub client: scryfall::Client,
    /// The image cache: what resolves a `(card, face, variant)` to bytes, and the one thing
    /// here that owns a folder of files. How those bytes reach a page — a protocol handler, a
    /// `fetch` — is the host's.
    pub images: crate::images::Cache,
    /// The in-memory facet index and the generation of the corpus it describes — cold, which
    /// is a supported state and not an error, until the first build lands. Read it through
    /// [`crate::index::lifecycle::current`]; everything else about it is that module's.
    ///
    /// `RwLock` and not `Mutex`: every facet request reads it and only a sync or a collection
    /// write replaces it. The `Arc` inside is so a reader clones the handle and lets the lock
    /// go at once — a facet pass must never hold a lock a sync's rebuild is waiting on.
    pub index: RwLock<IndexSlot>,
    /// The host's observers, kept for the one thing the hooks cannot tell them — see
    /// [`State::corpus_replaced`]. The hooks hold their own handles on the same list.
    observers: Vec<Arc<dyn WriteObserver>>,
    /// One sync operation at a time — see [`State::lane`]. Private: what holding it buys is a
    /// [`Lane`], and nothing else may be made of it.
    lane: Lock,
    /// A pairing in flight, if there is one.
    ///
    /// **In memory and never in the database, deliberately**: an offer that survived a restart
    /// would be an invite a reader printed last month still being accepted today. It outlives a
    /// page, which is what a reader who opens Settings twice needs, and dies with the process,
    /// which is what makes the pairing token one-time in fact. It holds the derived pair key,
    /// which is the other reason it is not a table.
    ///
    /// **An async lock, held across the request** an accept, a confirm or a poll makes: a Cancel
    /// waits behind it and wins, and two polls cannot both find the offer unspent and complete
    /// it. **Taken before the lane, never after.** It was a field of the desktop's `AppState`
    /// until the sync step brought its type here.
    pub pairing: Shared<Option<crate::sync_pair::pairing::Pending>>,
}

impl State {
    /// Take the connections a host opened and brought to head, and install the hooks.
    ///
    /// **The hooks go on before the write connection goes behind its mutex**, so there is no
    /// `State` whose fence is not riding and no observer that missed a write made through it.
    /// `observers` are the host's — see [`crate::hooks`]; a host with nothing to tell passes
    /// none and still gets the fence.
    ///
    /// **`read` is `None` on a host that can only have one connection.** A browser's storage
    /// permits exactly one (the light-app spec §6), so there the reads go through the write
    /// connection. Everywhere else it is a connection opened read-only on the same files
    /// ([`db::open_read`]), which is what lets a search answer from the last committed
    /// snapshot without queueing behind any writer.
    ///
    /// **`client` is the host's to build**, because where Scryfall's API lives and what lockout
    /// an earlier run earned are the host's to know: the desktop restores a persisted 429
    /// deadline into it before handing it over. No sync is in flight and the index is cold —
    /// the host starts the first build once the state is in an `Arc`.
    ///
    /// **`images` is the host's to build too**, because where the pictures live is the host's
    /// to know. A cache creates nothing until it is asked for a picture, so a host that never
    /// serves one pays for a path.
    pub fn new(
        write: Connection,
        read: Option<Connection>,
        data_dir: PathBuf,
        events: Arc<dyn EventSink>,
        observers: Vec<Arc<dyn WriteObserver>>,
        client: scryfall::Client,
        images: crate::images::Cache,
    ) -> State {
        let fence = Arc::new(CrossFileFence::new());
        hooks::install(&write, fence.clone(), observers.clone());
        State {
            db: Mutex::new(write),
            db_read: read.map(Mutex::new),
            data_dir,
            fence,
            events,
            syncing: AtomicBool::new(false),
            client,
            images,
            index: RwLock::default(),
            observers,
            lane: Lock::new(),
            pairing: Shared::new(None),
        }
    }

    /// Wait for the lane: this operation's turn to sync, however long the one in flight takes.
    ///
    /// For an operation that owns its own wait — a background trip, the token the live socket
    /// connects with, and **a departure**, which is the reader's instruction that this device be
    /// out of its group and is promised always to work. First come, first served
    /// ([`crate::platform::sync`]).
    ///
    /// **What makes the wait end is that every operation on the lane does**: each request one
    /// makes is bounded, so the holder lets go in bounded time with the network gone.
    pub async fn lane(&self) -> Lane<'_> {
        Lane {
            state: self,
            _held: self.lane.lock().await,
        }
    }

    /// The lane for a **press**: its turn within [`db::WRITE_LOCK_WAIT`], or [`db::BUSY`].
    ///
    /// What a press during a sync has always been told. A reader can press again, and five
    /// seconds of "busy" is kinder than a button that freezes for the length of somebody else's
    /// round trip — [`with_write`]'s own argument, one lock over.
    pub async fn lane_for_press(&self) -> Result<Lane<'_>, String> {
        self.lane_within(db::WRITE_LOCK_WAIT).await
    }

    /// [`State::lane_for_press`] with the bound as an argument, which a test passes short.
    ///
    /// **The connection is asked for inside what is left of the same bound, once, before the
    /// operation starts** — the other half of what [`db::BUSY`] has always meant, and one bound
    /// for both, so a press is answered within it whichever of the two kept it waiting. The
    /// operation's own stretches wait ([`Lane`]'s `with`), so this is the one place a press
    /// hears that the connection is busy with something that is not a sync.
    pub async fn lane_within(&self, bound: Duration) -> Result<Lane<'_>, String> {
        let asked = Tick::now();
        let Some(lane) = timer::timeout(bound, self.lane()).await else {
            return Err(db::BUSY.to_owned());
        };
        if db::lock_for(&self.db, bound.saturating_sub(asked.elapsed())).is_none() {
            return Err(db::BUSY.to_owned());
        }
        Ok(lane)
    }

    /// Tell every observer the corpus was just replaced — [`WriteObserver::corpus_replaced`].
    ///
    /// The card sync calls it the moment its swap has landed, and a price refresh when it has
    /// rewritten `marketplace_prices`. In list order, like the hooks.
    pub fn corpus_replaced(&self) {
        for observer in &self.observers {
            observer.corpus_replaced();
        }
    }

    /// The connection reads go through: the read-only one where the host has it, and the write
    /// connection where it does not.
    ///
    /// For a caller that has to hand a mutex on — the image cache takes one — or wants a
    /// bounded ask ([`db::lock_for`]). Everything else takes [`State::lock_db_read`].
    ///
    /// ⚠️ **On a host with one connection this is the write connection's own mutex.** A read
    /// asked for while the same thread holds the write connection is then a lock taken twice,
    /// which a host with two never notices. Nothing has run that way yet.
    pub fn reader(&self) -> &Mutex<Connection> {
        self.db_read.as_ref().unwrap_or(&self.db)
    }

    /// Lock the write connection, waiting as long as it takes and recovering from a poisoned
    /// mutex — [`db::lock_blocking`], which has the reason.
    ///
    /// For work that owns its own wait: a sync's bookkeeping, a launch pass. A user-facing
    /// write does not come through here — it asks with a bound and answers [`db::BUSY`].
    pub fn lock_db(&self) -> MutexGuard<'_, Connection> {
        db::lock_blocking(&self.db)
    }

    /// Lock the connection reads go through, recovering from poisoning as [`State::lock_db`]
    /// does.
    ///
    /// Only ever held for a short run of queries and never across an `.await`, so on a host
    /// with a read connection of its own, waiting for it is bounded whatever the writer is
    /// doing.
    pub fn lock_db_read(&self) -> MutexGuard<'_, Connection> {
        db::lock_blocking(self.reader())
    }
}

/// Run `f` with the write connection, or answer [`crate::db::BUSY`].
///
/// Bounded rather than blocking: every caller is a button press on a worker thread, and the
/// one thing that can hold [`State::db`] for any length of time is a sync — which, since the
/// ingest was chunked, holds it for one batch at a time.
///
/// **This is the one definition of that rule**, the way [`crate::db::lock_plain`] is the one
/// definition of poison recovery. It was five identical private copies (`collection`, `deck`,
/// `deck_meta`, `deck_theory`, `wishlist`) plus six sites that inlined the same four lines,
/// each documented as "kept per-module the way every other one in this crate is" — which was
/// true, and was the problem.
///
/// Here rather than in [`crate::db`] because the parameter is [`State`]: `db` is the layer
/// below and must not learn about the app's state. **`&State`, and it was `&AppState` until the
/// extraction's domain step** — the desktop's `AppState` derefs to this struct, so a command
/// there holding an `Arc<AppState>` still passes `&state`, and `index::lifecycle`, which holds a
/// bare reference, needs no clone. A free function rather than a method so that every one of
/// those callers reads as it did; `src-tauri`'s `sync` re-exports it under its old name.
///
/// **It could not move before the modules its body names did**: [`written`] arms and settles
/// [`crate::managed_wishlist`] and runs [`crate::deck_tokens`]' reconcile around the caller's
/// closure, with no line to be cut at.
///
/// **Never call this while holding a guard on `state.db`** — it does not deadlock, because
/// [`crate::db::lock_for`] is a `try_lock`-plus-sleep loop rather than a blocking one, but a
/// same-thread reentrant call spends the whole [`crate::db::WRITE_LOCK_WAIT`] failing to
/// take a lock its own thread already holds, then answers [`crate::db::BUSY`] against itself.
/// `do_sync`'s orphan-sweep arm is the site that has to remember: it passes its already-open
/// connection down instead.
pub fn with_write<T>(
    state: &State,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    written(
        state,
        crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT),
        f,
    )
}

/// [`with_write`] that **waits for the write connection as long as it takes** instead of
/// answering [`crate::db::BUSY`]. ⚠️ **The one sanctioned unbounded wait on [`State::db`], and
/// what earns it is a stretch of a sync operation** — [`Lane`]'s `with` is its one caller.
///
/// Every press is optional at its *start*: the reader can press again, and a five-second "busy"
/// is kinder than a button that freezes for as long as whatever holds the connection —
/// [`State::lane_for_press`] is where a sync operation asks that way. **A stretch in the middle
/// of one is not optional.** It may be recording an answer the relay will not give twice — the
/// grant behind a claim code that is now spent, the group a joining device has just been handed
/// the key to, a rotation the relay has accepted — and turned away with "busy" it would leave
/// the relay holding something this device never wrote down.
///
/// **It was a departure's alone until the sync step** (issue #546, item 7): a trip held this
/// connection across its whole network round trip, and a Leave pressed during a slow one failed
/// with "the database is busy" under [`with_write`]. A trip holds the *lane* across its requests
/// now, and the connection only for a stretch; a departure waits for the lane
/// ([`State::lane`]) and its stretches wait here like any other.
///
/// **What makes the wait safe to have is that nothing holds the connection across a request any
/// more**: what a stretch waits behind is local work — another stretch, a reader's write, one
/// batch of an ingest. **What makes it safe to *call*** is [`with_write`]'s reentrancy rule,
/// which is sharper here: that one spends five seconds and answers BUSY against its own thread,
/// where a same-thread call to this one **deadlocks** (std's `Mutex` may also panic on it).
/// Nothing may call it holding a guard on `state.db` — a caller that already holds the
/// connection hands it to [`Lane::in_hand`] instead.
///
/// **Everything else is [`with_write`]'s, because it is [`with_write`]'s body** — the managed
/// wishlists armed and settled, the token reconcile, and the cross-file fence — and the lock is
/// [`crate::db::lock_waiting`], which recovers a poisoned mutex exactly as
/// [`crate::db::lock_for`] does, and **counts as an ask while it waits**: the batch loops of
/// an ingest stand aside for a stretch as they do for a press, where a thread parked on the
/// mutex would get the connection only when it happened to catch it free.
pub fn with_write_waiting<T>(
    state: &State,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    written(state, Some(crate::db::lock_waiting(&state.db)), f)
}

/// [`with_write`] and [`with_write_waiting`]'s shared body: `guard` is the write connection, or
/// `None` when the bounded wait gave up. **One body so the two cannot drift** — a waiting write
/// that skipped the managed-wishlist settle or the fence would be a second definition of "a
/// user-facing write", which is the thing [`with_write`] exists to have exactly one of.
fn written<T>(
    state: &State,
    guard: Option<MutexGuard<'_, Connection>>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let out = match guard {
        Some(conn) => {
            // **The managed wishlists ride every write, before and after** (issue #512). Armed
            // first so the write's own changes to a deck are marked, and settled after — outside
            // the write's transaction, which has committed or rolled back by then — so a folder
            // is rewritten once per press rather than once per row. Neither can fail the write:
            // an arm that did not take is a folder that catches up at the next launch.
            if let Err(e) = crate::managed_wishlist::arm(&conn) {
                eprintln!("the managed wishlists could not be armed on this connection: {e}");
            }
            let out = f(&conn);
            // **The token reconcile's backstop rides the same marks** (spec §4.2 rule 7): a
            // token no card in a list makes any more loses its entries, for the writes that
            // file no undo step and so could not do it inside their own transaction — the
            // Collection tab's filing and cut, a sync pull, undo and redo. Scryfall's
            // `reconcile::apply` takes this connection through `lock_db`, not through here, so
            // the marks it leaves are reconciled at the NEXT write that comes through here.
            // **Before the settle and not after it**, because the settle empties the dirty table
            // this reads — and because the reconcile's deletions are token entries, which a
            // managed wishlist's Tokens subfolder counts and whose triggers mark the settle's own
            // token table, so settling second files the reconciled count in the same write.
            // Logged, never failing the write, for the settle's reason.
            crate::deck_tokens::reconcile_dirty_logged(&conn);
            crate::managed_wishlist::settle_logged(&conn);
            out
        }
        None => Err(crate::db::BUSY.to_owned()),
    };
    // **Every user-facing write in the crate passes through here**, so a debug build runs the
    // whole suite with the fence armed and this is where a path that crossed the files stops
    // being a line in a log. Release keeps the `eprintln!` in the commit hook and nothing
    // else: the write has already happened by then, and a panic on a reader's machine would
    // be a worse answer than a sentence.
    debug_assert!(
        !state.fence.tripped(),
        "a transaction wrote to both user.db and corpus.db; SQLite does not guarantee those \
         commit together in WAL mode"
    );
    out
}

/// How a sync operation reaches the database: **inside [`Store::with`], and never across an
/// `.await`**.
///
/// A trip used to be handed the write connection for its whole length, network requests
/// included, by a caller that blocked a thread on it. A browser has no thread to block, and a
/// lock held across an `.await` there is a lock nobody else can ever take. So what an operation
/// reads or writes is a **stretch** — one closure, run to its end with the connection — and a
/// request is made between two stretches with nothing held.
///
/// **What can land between two stretches is a reader's own write**, and nothing else: every
/// sync operation holds the [`Lane`], so no second one interleaves. A function that reads two
/// things that must agree — a baseline's rows and its horizon — reads them in one stretch.
///
/// **The fence is the compiler's.** A `MutexGuard` is not `Send`, so a future that keeps one
/// across an `.await` is not either, and each entry point is checked by a function that is
/// never called: `fn sendable<T: platform::Sendable>(_: T) {}` over its future — `Send` on a
/// native build, and no question in a browser, where no request's future is `Send` at all.
pub trait Store {
    /// Run `f` with the connection, to its end.
    fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R, String>) -> Result<R, String>;
}

/// A bare connection is a store whose stretches run back to back — what a test hands over, and
/// why a test written against a connection did not change when its function stopped taking one.
///
/// ⚠️ **Tests only, and that is the fence's other half**: shipped code that handed a function
/// the connection it holds would be the whole-operation lock again, with no lane.
#[cfg(any(test, feature = "testing"))]
impl Store for Connection {
    fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R, String>) -> Result<R, String> {
        f(self)
    }
}

/// The lane, held: this operation's turn to sync, and **the app's [`Store`]**.
///
/// Built only by [`State::lane`] and [`State::lane_for_press`], so a stretch on the app's
/// database is a stretch under the lane — [`Store`] is deliberately not implemented for
/// [`State`]. Let go when it is dropped, which is also what a cancelled operation does.
///
/// **A stretch waits for the connection** ([`with_write_waiting`], which has the reason) and is
/// a user-facing write like any other: the managed wishlists armed and settled, the token
/// reconcile, the cross-file fence.
pub struct Lane<'a> {
    state: &'a State,
    _held: Held<'a>,
}

impl<'a> Lane<'a> {
    /// The state this lane is on.
    pub fn state(&self) -> &'a State {
        self.state
    }

    /// A connection the caller **already holds**, as a store.
    ///
    /// For an operation that still takes the connection for its whole length and asks a sync
    /// function something on the way — the desktop's share publisher, which is not a sync
    /// operation and mints its token through one. `with` there must not come back for the
    /// connection: its caller has it. Built from the lane, so the lane is held.
    pub fn in_hand<'c>(&self, conn: &'c Connection) -> InHand<'c> {
        InHand(conn)
    }
}

impl Store for Lane<'_> {
    fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R, String>) -> Result<R, String> {
        with_write_waiting(self.state, f)
    }
}

/// [`Lane::in_hand`]'s store: the connection its caller holds, used where it stands.
pub struct InHand<'c>(&'c Connection);

impl Store for InHand<'_> {
    fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R, String>) -> Result<R, String> {
        f(self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn over_memory(observers: Vec<Arc<dyn WriteObserver>>) -> State {
        State::new(
            crate::schema::memory_pair(),
            None,
            PathBuf::from("nowhere"),
            crate::events::silent(),
            observers,
            scryfall::Client::new("http://127.0.0.1:1".into()),
            crate::images::Cache::new(PathBuf::from("nowhere").join("images")),
        )
    }

    /// The fence a host reads off its state is the one riding that state's write connection —
    /// not a second one nobody installed. A debug build's user-facing write asserts on it.
    #[test]
    fn a_states_own_write_connection_trips_its_own_fence() {
        let state = over_memory(Vec::new());
        {
            let conn = state.lock_db();
            conn.execute_batch(
                "BEGIN;
                 INSERT INTO decks (name, format_key, created_at, updated_at)
                   VALUES ('one file', 'casual', 0, 0);
                 COMMIT;",
            )
            .unwrap();
        }
        assert!(!state.fence.tripped(), "a user-only transaction is fine");
        {
            let conn = state.lock_db();
            conn.execute_batch(
                "BEGIN;
                 INSERT INTO decks (name, format_key, created_at, updated_at)
                   VALUES ('two files', 'casual', 0, 0);
                 INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz', 'probe');
                 COMMIT;",
            )
            .unwrap();
        }
        assert!(state.fence.tripped());
    }

    #[derive(Default)]
    struct Counter {
        rows: AtomicUsize,
        commits: AtomicUsize,
        swaps: AtomicUsize,
    }

    impl WriteObserver for Counter {
        fn row(&self, _db: &str, _table: &str) {
            self.rows.fetch_add(1, Ordering::Relaxed);
        }

        fn committed(&self) {
            self.commits.fetch_add(1, Ordering::Relaxed);
        }

        fn corpus_replaced(&self) {
            self.swaps.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// The one thing an observer hears that no hook carries: a sync that swapped `cards` says
    /// so once, to every observer the host gave the state — and to nobody when no row moved.
    #[test]
    fn a_replaced_corpus_is_told_to_every_observer_once_and_is_not_a_write() {
        let first = Arc::new(Counter::default());
        let second = Arc::new(Counter::default());
        let state = over_memory(vec![first.clone(), second.clone()]);

        state.corpus_replaced();

        for counter in [&first, &second] {
            assert_eq!(counter.swaps.load(Ordering::Relaxed), 1);
            assert_eq!(counter.rows.load(Ordering::Relaxed), 0);
            assert_eq!(counter.commits.load(Ordering::Relaxed), 0);
        }
        // And a state with nobody listening has nobody to tell.
        over_memory(Vec::new()).corpus_replaced();
    }

    #[test]
    fn an_observer_given_at_construction_hears_a_write_made_through_the_state() {
        let counter = Arc::new(Counter::default());
        let state = over_memory(vec![counter.clone()]);

        state
            .lock_db()
            .execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES ('heard', 'casual', 0, 0)",
                [],
            )
            .unwrap();

        assert_eq!(counter.rows.load(Ordering::Relaxed), 1);
        assert_eq!(counter.commits.load(Ordering::Relaxed), 1);
    }

    /// The browser's shape: one connection, so a read goes through the one that writes.
    #[test]
    fn a_host_with_one_connection_reads_through_the_one_it_writes_with() {
        let state = over_memory(Vec::new());
        assert!(std::ptr::eq(state.reader(), &state.db));

        state
            .lock_db()
            .execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES ('written', 'casual', 0, 0)",
                [],
            )
            .unwrap();
        let name: String = state
            .lock_db_read()
            .query_row("SELECT name FROM decks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "written");
    }

    /// The desktop's shape, on real files — two in-memory connections are two databases. The
    /// reads go through the second connection, which sees what the first committed and cannot
    /// write.
    ///
    /// **And the hooks are on the first.** With two connections in hand there is a wrong one to
    /// install them on, and a state hooked on its read connection would look healthy for ever:
    /// the fence never trips, no observer hears a write, and nothing errors. So the observer and
    /// the fence are asserted here as well as on the one-connection shape.
    #[test]
    fn a_host_with_two_reads_through_the_second_which_cannot_write() {
        let dir = crate::scratch::path("state-two-connections");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let write = db::open_write(&dir).unwrap();
        write
            .execute_batch(&format!(
                "CREATE TABLE main.notes (body TEXT NOT NULL);
                 CREATE TABLE {}.prices (amount INTEGER NOT NULL);",
                db::CORPUS
            ))
            .unwrap();
        let read = db::open_read(&dir).unwrap();
        let counter = Arc::new(Counter::default());
        let images = crate::images::Cache::new(dir.join("images"));
        let state = State::new(
            write,
            Some(read),
            dir,
            crate::events::silent(),
            vec![counter.clone()],
            scryfall::Client::new("http://127.0.0.1:1".into()),
            images,
        );
        assert!(!std::ptr::eq(state.reader(), &state.db));

        state
            .lock_db()
            .execute("INSERT INTO notes (body) VALUES ('committed')", [])
            .unwrap();
        assert_eq!(counter.rows.load(Ordering::Relaxed), 1);
        assert_eq!(counter.commits.load(Ordering::Relaxed), 1);
        assert!(!state.fence.tripped(), "one file, so far");
        state
            .lock_db()
            .execute_batch(
                "BEGIN;
                 INSERT INTO notes (body) VALUES ('and a second file');
                 INSERT INTO prices (amount) VALUES (1);
                 COMMIT;
                 DELETE FROM notes WHERE body = 'and a second file';",
            )
            .unwrap();
        assert!(
            state.fence.tripped(),
            "the fence rides the connection that writes"
        );

        let reader = state.lock_db_read();
        let body: String = reader
            .query_row("SELECT body FROM notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "committed");
        assert!(
            reader
                .execute("INSERT INTO notes (body) VALUES ('refused')", [])
                .is_err(),
            "the read connection is opened read-only"
        );
    }

    fn deck_names(conn: &Connection) -> Result<Vec<String>, String> {
        let mut stmt = conn
            .prepare("SELECT name FROM decks ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())
    }

    fn add_deck(conn: &Connection, name: &str) -> Result<(), String> {
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES (?1, 'casual', 0, 0)",
            [name],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// What a sync operation is shaped like: a stretch, something awaited, a stretch.
    async fn two_stretches(db: &impl Store) -> Result<Vec<String>, String> {
        db.with(|conn| add_deck(conn, "before the request"))?;
        tokio::task::yield_now().await;
        db.with(|conn| {
            add_deck(conn, "behind it")?;
            deck_names(conn)
        })
    }

    /// One sync operation at a time: a second waits for the lane until the first lets go.
    #[tokio::test]
    async fn a_second_operation_waits_for_the_first() {
        let state = Arc::new(over_memory(Vec::new()));
        let first = state.lane().await;
        let second = {
            let state = state.clone();
            tokio::spawn(async move {
                let lane = state.lane().await;
                lane.with(|conn| add_deck(conn, "second"))
            })
        };
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(
            !second.is_finished(),
            "it ran beside the operation in flight"
        );
        first.with(|conn| add_deck(conn, "first")).unwrap();
        drop(first);
        second.await.unwrap().unwrap();
        assert_eq!(
            deck_names(&state.lock_db()).unwrap(),
            ["first", "second"],
            "in the order they asked"
        );
    }

    /// A press does not queue behind a sync in flight for longer than its bound, and it is told
    /// what a press during a sync has always been told. Nor does it start against a connection
    /// that will not answer.
    #[tokio::test]
    async fn a_press_behind_a_sync_or_a_busy_connection_is_told_busy() {
        let state = Arc::new(over_memory(Vec::new()));
        let bound = Duration::from_millis(40);
        let in_flight = state.lane().await;
        assert_eq!(
            state.lane_within(bound).await.err().as_deref(),
            Some(db::BUSY)
        );
        drop(in_flight);

        // Something else has the connection: another thread, as a reader's write would be.
        let (holding, held) = std::sync::mpsc::channel::<()>();
        let (let_go, wait) = std::sync::mpsc::channel::<()>();
        let holder = {
            let state = state.clone();
            std::thread::spawn(move || {
                let _conn = state.lock_db();
                holding.send(()).unwrap();
                let _ = wait.recv();
            })
        };
        held.recv().unwrap();
        assert_eq!(
            state.lane_within(bound).await.err().as_deref(),
            Some(db::BUSY),
            "the lane was free and the connection was not"
        );
        drop(let_go);
        holder.join().unwrap();

        assert!(state.lane_within(bound).await.is_ok());
        // And the refused presses left the lane free.
        assert!(state.lane_within(bound).await.is_ok());
    }

    /// The lane is the app's store, a stretch at a time, and a trip over it can be sent to
    /// another thread — which it could not be while it held the connection's guard.
    #[tokio::test]
    async fn an_operation_over_the_lane_holds_nothing_across_an_await() {
        fn sendable<T: Send>(_: &T) {}
        let state = over_memory(Vec::new());
        let lane = state.lane().await;
        let trip = two_stretches(&lane);
        sendable(&trip);
        assert_eq!(trip.await.unwrap(), ["before the request", "behind it"]);
        assert!(std::ptr::eq(lane.state(), &state));
    }

    /// A stretch is a user-facing write: it goes through the one body every such write does,
    /// which is what arms the managed wishlists on the connection.
    #[tokio::test]
    async fn a_stretch_is_a_user_facing_write() {
        let armed = |conn: &Connection| -> Result<bool, String> {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM temp.sqlite_master WHERE name LIKE 'mw%')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
        };
        let state = over_memory(Vec::new());
        assert!(!armed(&state.lock_db()).unwrap(), "nothing has written yet");
        let lane = state.lane().await;
        assert!(lane.with(armed).unwrap());
        // A refusal is the closure's own, handed back as it was said.
        assert_eq!(
            lane.with(|_| Err::<(), _>("no".to_owned())).unwrap_err(),
            "no"
        );
    }

    /// A caller that already holds the connection runs its stretches on it where it stands —
    /// coming back for the connection through the lane would be this thread waiting for itself.
    ///
    /// Driven the way that caller drives it: a thread that holds the connection and blocks on
    /// the future. An `async fn` holding the guard across an `.await` is the thing the lane
    /// exists to end, and clippy's `await_holding_lock` refuses it in a test too.
    #[test]
    fn a_connection_in_hand_is_used_where_it_stands() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let state = over_memory(Vec::new());
        let lane = runtime.block_on(state.lane());
        let conn = state.lock_db();
        let names = runtime
            .block_on(two_stretches(&lane.in_hand(&conn)))
            .unwrap();
        assert_eq!(names, ["before the request", "behind it"]);
    }

    /// A bare connection is a store too, in a test.
    #[tokio::test]
    async fn a_bare_connection_is_a_store_whose_stretches_run_back_to_back() {
        let conn = crate::schema::memory_pair();
        assert_eq!(
            two_stretches(&conn).await.unwrap(),
            ["before the request", "behind it"]
        );
    }
}

/// A host's state for a test.
///
/// **At the foot of the file, and behind `testing`**: everything below a file's `mod tests` is
/// test code to the fence and to the coverage script alike, and another crate's tests can reach
/// this through the feature.
#[cfg(any(test, feature = "testing"))]
pub mod fixtures {
    use super::State;
    use crate::events::fixtures::Recording;
    use crate::events::EventSink;
    use std::path::PathBuf;
    use std::sync::Arc;

    /// A [`State`] over a pair of **files** at head in a scratch directory of its own, with
    /// nobody listening, nothing observing, its Scryfall client pointed at `scryfall` and its
    /// image cache under `images/` there. Answers the directory too, for a test that looks at
    /// what was left in it.
    ///
    /// Files and not `:memory:`, because a state's read connection is a second connection and
    /// two in-memory connections are two databases. Built at head with
    /// [`crate::schema::build_pair`], as a fresh install's are: no capture triggers and no
    /// launch passes, which a test that wants them asks for itself.
    ///
    /// `name` labels the directory under [`crate::scratch::path`], so two tests that run at
    /// once need two names.
    pub fn on_files(name: &str, scryfall: &str) -> (Arc<State>, PathBuf) {
        build(name, scryfall, crate::events::silent())
    }

    /// [`on_files`] with a sink that keeps what it is told, for a test that asks what a page
    /// would have heard. Its Scryfall client points nowhere.
    pub fn listening(name: &str) -> (Arc<State>, Arc<Recording>, PathBuf) {
        let heard = Arc::new(Recording::default());
        let (state, dir) = build(name, "http://127.0.0.1:1", heard.clone());
        (state, heard, dir)
    }

    fn build(name: &str, scryfall: &str, events: Arc<dyn EventSink>) -> (Arc<State>, PathBuf) {
        let dir = crate::scratch::path(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        crate::schema::build_pair(&conn);
        let read = crate::db::open_read(&dir).unwrap();
        let state = State::new(
            conn,
            Some(read),
            dir.clone(),
            events,
            Vec::new(),
            crate::scryfall::Client::new(scryfall.to_owned()),
            crate::images::Cache::new(dir.join("images")),
        );
        (Arc::new(state), dir)
    }
}
