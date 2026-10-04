# grimoire-core — the engine with no window

What every host links: the desktop app in `src-tauri`, the light app's Android host in
`mobile/src-tauri` (phase 4, 2026-10-03), and the web host in `crates/grimoire-web` — this
crate as a WASM module in a Worker (phase 5, step 5.1, 2026-10-04). The design is
[the light-app spec](../../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md)
§2; what each extraction step built and measured is in
[light-app.md](../../docs/reference/light-app.md).

**It is being filled a step at a time, and since 2026-10-02 most of the engine is here.** What is
here is what `src/lib.rs` declares: the leaves; the storage layer — `db`, `schema` with both
ladders, `sync_meta`, `filters`, `sorting`, `card_row`, `image_uri`, `errors`, `feed::backoff` and
`sync_engine::capture`; the state a host holds over it — `state`, `hooks` and `events`; and the
**domain** — the decks, the collection, the wishlist, the search, the card pane, the view-state
modules, `maintenance`, and the sync engine's `apply` and `baseline`: forty-nine modules, moved in
one pass by `scripts/core-step-4.mjs`. **The I/O step arrived in three parts and all three are
here**: `platform`'s request, timer, files and background work; the three modules that were
their first callers — `scryfall`, `ingest` and `reconcile`; what drives them — `sync`, the
card sync, and `index/`, the facet index with its lifecycle; and the three feeds (`combos`,
`marketplace_feed`, `tags/`) with `images`, the image cache. **The sync step arrived in two
parts and both are here** (2026-10-03): `state::Store` and the lane, then the relay's client,
the entitlement, the wire format, the socket's schedule, the sync panel's reads, and pairing
with the identity under it. **And the scanner's session glue arrived with the seventh step**
(2026-10-03), `scanner`, which takes `card-scanner` as a dependency — so every module on the
seven steps' lists has moved. **One thing the spec's §2.3 named did not**: `share/snapshot` and
`share/cache` were to move and were on no step's list, so they are still `src-tauri`'s, in
`share/` with its publisher — a decision nobody has taken yet, not one taken against them. The
mirror, the updater, live sync's connection manager (`sync_engine::live`, `tokio` tasks and a
socket) and the scanner's raw request body and embedded assets are the desktop's for good.
Every rule in [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) about a
module binds that module wherever it lives — moving a file changes which crate compiles it and
nothing about what it must do. **That file's database and deck rules are this crate's now**: a
schema rung, a grain, a capture spec, a deck write is edited here.

## A command wrapper is not here, and never will be

**Nothing in this crate is a `#[tauri::command]`.** A wrapper names a window, the desktop's
`AppState` and a thread to run on, so each one stayed in `src-tauri`, in a module of the same
name: `src-tauri/src/deck/mod.rs` is `pub use grimoire_core::deck::*;` and, below it, deck's
wrappers. An item a module defines shadows a glob import of the same name, so `crate::deck::…`
over there is this crate's item unless that file defines one.

- **A new command is written in `src-tauri/src/<module>/mod.rs`; the function it calls is
  written here**, `&Connection` in and a DTO out, and is `pub` — a `pub(crate)` item does not
  cross the glob. `managed_wishlist` and the sync engine's `apply` and `baseline` have no such
  file, because nothing of theirs stayed. (This line carried a count of the files that do;
  `ls -d src-tauri/src/*/mod.rs` answers it.)
- **A module's own `//!` doc may still say its wrappers are "in one block at the foot".** They are
  at the foot of `src-tauri`'s file. The docs moved with the code, unedited.
- **`ipc.test.ts` reads such a module as both halves**, joined under the name its assertions
  already used (`deckRs = deckRsCore + deckRsDesktop`). A new `?raw` import of a moved module
  owes both files.
- **It was meant to be a `commands/` folder** (spec §2.3). Markus chose this shape instead on
  2026-10-02: 245 of `generate_handler!`'s 257 entries are a path through a module and none had to change. The folder
  can be a rename later, with the command table.

## Five rules, and what goes red for each

| Rule | Held by |
| --- | --- |
| **No `tauri` dependency** — not the crate, not its build script's, not a plugin, not `wry` or `tao`, not under another name | `platform::fence`, which reads `Cargo.toml` |
| **`cfg(target_…)`, `cfg(windows)` and `cfg(unix)` appear only under `src/platform/`** | `platform::fence`, which reads every source file |
| **Nothing outside `src/platform/` names `SystemTime`, `UNIX_EPOCH` or `std::time::Instant`** — reading any of them panics on `wasm32-unknown-unknown`, at run time, in a build that compiled clean | The same sweep |
| **Nothing the crate ships names `reqwest`, `tokio`, or `std`'s `fs`, `thread`, `net`, `process` or `env` outside `src/platform/`, or asks a disk through a path** (`.exists()`, `.is_file()`, `.metadata()`) — since the I/O step. A request, a timer, a file and a thread each have one implementation per kind of host there | The same file, a second sweep: shipped code only |
| **It compiles for `x86_64-pc-windows-msvc`, `aarch64-linux-android` and `wasm32-unknown-unknown`** | CI: the `core` job for the last two, the `rust` job for the desktop, where the tests run |

- **The fence reads code lines and skips comment lines**, so prose may name what it refuses. A
  line is a comment only when it *starts* with `//`: a trailing comment and a `/* … */` block
  are read as code.
- **It sweeps test code too, for a target and a clock.** A test never compiles for a browser,
  but the sweep does not parse `#[cfg(test)]`, so a clock read in a test is refused like any
  other. Take the time from `platform::clock` — `Tick::now()` and `elapsed()` are what a test
  that times something uses, as `db`'s and `scryfall`'s do — or from SQLite.
- **The I/O rule reads shipped code only**: above a file's first column-0 `#[cfg(test)]` **that
  gates a module**, and not at all in a file its parent declares behind a test gate (`scratch.rs`,
  `sync_engine/apply/tests.rs` — derived, sorted, and pinned by name). A test of a download
  writes a file, a test of a lock starts a thread, and `#[tokio::test]` is how an async test
  runs. So **tests and fixtures go at the foot of the file and nothing that ships goes below
  them** — code under that line is not read. A gate over a single item higher up (a test-only
  `use`, a helper function) is *not* the cut: it and everything below it are read as shipped,
  which is why a `#[cfg(test)]` helper may not name `std::fs` either. (It cut at the first gate
  of any kind for one afternoon, and four files' worth of shipped code went unread.)
  `scripts/coverage-rust.mjs` makes the same cut.
- **It is a text sweep, and three things pass it**: a clock reached through a re-export or
  another crate's `now()`, a gate inside a macro this crate does not define, and a host that
  arrives as somebody else's dependency. The first two fail the `core` job or a browser; the
  third is what `cargo tree -p grimoire-core -i tauri` answers.
- **A target key is refused anywhere on a code line**, so an identifier that contains one
  (`target_os_name`) is refused too. Rename it.
- **Do not weaken the fence to make it pass.** A module that needs to know its machine gets an
  interface under `platform/` with one implementation per kind of host.

## `platform/`

| | Native | Browser |
| --- | --- | --- |
| `platform::clock::now_ms`, `now_secs` | `SystemTime` | `Date.now()` |
| `platform::clock::Tick` — `now()`, `elapsed()`, for how long a wait has run; `==`, `+ Duration` and `saturating_duration_since`, so a test can say "two seconds later" without waiting | `Instant` | **`performance.now()`**, read off the global scope (a Worker has no `window`), in whole microseconds — monotonic since step 5.2, because Scryfall's pacing gate counts with it. A host with no `performance` falls back to `Date.now()` rather than trapping |
| `platform::clock::Wall` — a moment that can be **stored and compared**: `now()`, `+` and `-` a `Duration`, `as_secs()` | whole milliseconds since the epoch | the same |
| `platform::pause(Duration) -> bool` — stand aside for another thread | `thread::sleep`, `true` | **`false`, at once**: a Worker has no other thread to wait for |
| `platform::timer::sleep`, `timeout` — a wait a future awaits, and a deadline on one | `tokio::time` | a `Promise` around the global `setTimeout`, cleared when the wait is dropped |
| `platform::timer::yield_to_host`, and `Breather` — a turn of the host's event loop, and one taken every so much work | `tokio::task::yield_now` | **a message posted to itself over a `MessageChannel`**, awaited: a task on the source a page's own messages arrive on, queued behind them. Falls back to a zero `setTimeout` |
| `platform::timer::Turn`, `NoTurn` and `unbroken` — where a batch loop written once for every host lets the host have a turn; the turn that is none; and a future that never waits, run where it stands | a loop handed `NoTurn` and run through `unbroken` is a function call: one poll, no runtime | the same code handed a `Breather`: one `yield_to_host` each time its budget is spent |
| `platform::http` — `Client` (`get`, `post`, `deadline`), `Request` (`header`, `body`, `send`, `send_within`), `Response` (`bytes`, `text`), `Body` (`chunk`, `chunk_within`), `Error` | `reqwest` over rustls, with a connect bound and a per-read bound; `deadline` is **not applied** | `reqwest` over `fetch`: **no connect or read bound to set**, so a request is bounded by `deadline` — the whole of it — or, for a body too long for one, by `send_within` and `chunk_within`, which give up on a wait rather than on the request; **no `User-Agent` is set** (a page may not choose one); `is_connect()` is always `false` |
| `platform::host` — `keeps_files()`, `asks_as_a_page()`: the two facts a download picks its shape by | `true`, `false` | `false`, `true`: a download is streamed into its sink, no request carries a conditional header, and a feed whose server permits no page is not asked |
| `platform::device::name()` — what this machine is called, for a device's default name | `COMPUTERNAME` on Windows, `HOSTNAME` elsewhere | `None`: a page has no such thing to ask, and `identity::mint_name` falls back to a word |
| `platform::files` — `open`, `read`, `write`, `remove`, `remove_dir`, `create_dir_all`, `entries`, `listing`, `set_modified`, `is_file`, `exists`; and `files::aio` for an `async fn`, with `read` and `rename` | `std::fs`; `tokio::fs` | **refused**, `ErrorKind::Unsupported`; the two questions answer `false` |
| `platform::sync::Semaphore`, `Lock` — a permit and a lock an `async fn` holds across an `.await`, **first come, first served**; `Shared<T>` — a value one holder at a time changes, the same lock with something behind it | `tokio::sync` | `tokio::sync`: it needs no runtime |
| `platform::Sendable` — what a fence over a future's `Send`-ness bounds by | `Send` | anything: no request is `Send` there, and there is no other thread |
| `platform::spawn::blocking(f).await` — synchronous work under an `async fn`; `spawn::background(f)` — work nobody waits for | the async runtime's blocking pool, **started by the call**; a thread | **run where it stands**: a Worker has no second thread, so `blocking` runs at its first poll and `background` before it returns |
| `platform::alone` — **not an interface with two arms: a way for a native test to feel the browser's.** `alone::emulate()` makes the calling thread a host with one: `spawn` runs on the caller, `pause` answers `false`, and a connection or the facet index asked for while held is a panic naming the line. **`host::emulate_page()` is the whole page**: that, plus `files` refusing as the browser arm does and `http` hiding the response headers CORS hides | a `thread_local` flag each, `cfg(test)` and `testing` only; `emulated()` is a constant `false` in a build that ships. **`timer::turn_at_every_pass()` is the third such switch**: every `Breather` made on that thread takes a turn at every pass, so a test of a loop's gaps does not turn on how fast the machine is | nothing: it is what the browser arms already are |

`db::lock_for` and `db::lock_background` are why `Tick` and `pause` exist. **A wait that polls is
a wait that cannot succeed in a browser**, so `lock_for` gives up on its first contended attempt
there and its caller answers `db::BUSY`. **The browser arms first ran on 2026-10-04, under
Node before a browser**: step 5.1 instantiated the module under Node's V8 over SQLite's
in-memory VFS and drove commands of every kind through it (launch to head in 76 ms, no trap) —
the clock, `pause`, `spawn`'s `blocking` and the refusing `files`. **The same day the web host
opened its database in headless Chrome**, over the OPFS pool, and answered commands there
([light-app.md](../../docs/reference/light-app.md) §9.1). **Since step 5.2 the web host starts
the launch's downloads**, which is what first calls `http`, `timer`, the monotonic `Tick` and
`spawn`'s `background` there. **The figures of the first run are light-app.md §9.2's**: one
run against the real hosts, headless Chrome 154, 2026-10-04, on a module from before the
yield described below.

- **`http` is the wire and nothing above it.** Pacing, retry, the 429 lockout and the size checks
  are rules about Scryfall or about a feed, and live with the client that owns them
  (`scryfall::Client::api_send`). **`GET` and `POST` are the verbs**, because they are the ones
  with a caller here; `POST`, a text body and `Response::text` arrived with the relay's client.
- **A status is a `u16`, a header is `Option<&str>`, a chunk is `bytes::Bytes`.** No `reqwest`
  type crosses out of the module, which is what lets the fence refuse the name everywhere else.
- **`timer`'s native arm needs a tokio runtime on the current task** — every host's async code
  runs on one — and panics outside it, as `tokio::time::sleep` always has.
- **`files` refuses in a browser rather than pretending**, and `schema`'s backup before a
  climb is logged and skipped there. The database is OPFS behind SQLite's own VFS, and nothing
  else is stored by this crate.
- **A download has two shapes, and `platform::host` is what picks one** (step 5.2,
  2026-10-04). Where the host keeps files it is what it always was — to `<data>/tmp/`, then
  read back — **request for request and statement for statement**: each download's mock-server
  tests pass unedited, and they are the proof. Where it keeps none (`!host::keeps_files()`),
  the same function branches **before it asks for anything** and feeds the body to its sink a
  chunk at a time: `sync`'s `ingest_streamed` into `ingest::StreamIngest`, `tags`'
  `refresh_streamed` into `StreamTags`, `combos`' into `combos::StreamRead` and then `store`,
  `marketplace_feed`'s into `marketplace_feed::StreamRead` and then `store`. The rules of that
  arm, each held by a test that runs it natively under `host::emulate_page()`:
  - **No lock crosses an `.await`.** A sink takes the write connection a batch at a time
    inside `push` and has let go before it returns, so between two chunks the connection is
    free.
  - ⚠️ **An `.await` is not a turn of the event loop, so the loop takes one on a budget.**
    In a browser a chunk the network had already buffered resumes its reader on the
    *microtask* queue, and a command a page sends is a *task*: a loop of `chunk().await` and
    a synchronous push never lets one in while chunks are buffered. Measured on the first
    browser run (headless Chrome 154, 2026-10-04): `sync_status` once a second was taken
    eight times in a 16.4 s card download, 3.5–8.4 s late. Every streamed loop therefore
    keeps a `timer::Breather` on `feed::WORK_BUDGET` (50 ms) and calls `breathe().await`
    once per chunk — one `timer::yield_to_host` each time the budget is spent, never per
    chunk. **A new streamed loop owes the same line**, and holds nothing across it: a turn
    is exactly when a command runs. **Measured on the module that ships** (the same probe,
    the same day): all fifteen calls sent during the card download answered, in 24–440 ms,
    median 185 ms. **What follows the last chunk has a bullet of its own below** (*A finish
    that writes staging…*): the tag finish and the combo store take the same turns, between
    their batches; the card finish and the price list's store do not.
  - **No conditional header, and no `ETag`.** `scryfall::Client::check_bulk_dataset` drops an
    `If-None-Match` it is handed, at the one place the header is built, and "unchanged" is the
    descriptor's `updated_at` against the stored one — the test every caller already made for
    a 200. The combo feed has no descriptor, so it reads the answer's `Last-Modified` (the
    one validator a page can read), keeps it where a desktop keeps the ETag, and drops the
    response unread when it matches — which aborts the request.
  - **No resume**: one request, from byte zero. A page cannot read `Content-Range`.
  - **The size check is the stream's** (`scryfall::Stream::chunk`): the end of the body is
    answered only when exactly `compressed_size` bytes arrived, so a sink's `finish` — the
    swap — is unreachable over a short body. The combo feed and the price list have no
    listed size, natively or here; they are held to a bound, and a body the browser has
    already gunzipped (`Content-Encoding: gzip`) is held to the decoded one.
  - **Every wait is bounded by `scryfall::STALL`** — 60 s, the native read timeout's own
    figure — for the answer to begin and for each chunk, through `http`'s `send_within` and
    `chunk_within`. It is what gives a feed's refresh claim back when a host goes quiet.
    ⚠️ **A timer on one thread counts whatever that thread was doing**, not only a quiet
    network: a long synchronous stretch elsewhere on the Worker leaves the timer due beside
    the chunk that arrived meanwhile, and which the engine runs first is its own business.
    So a deadline that fires is given **a second look** (`http::SECOND_LOOK`, 1 s, the same
    wait polled again and never dropped between) before it is called a stall, and the web
    host runs its launch downloads one after another so that no download waits through
    another's tail.
  - **A body that ends before its list does is refused by the push reader**
    (`feed::frame::Elements::cut_short`, asked by both `StreamRead::finish`es): every element
    the framer hands over is whole, so a body cut off after its second row would otherwise
    store as a two-row feed and stamp the day. A real `.gz` fails at its trailer; a body the
    browser decoded has none.
  - **Progress on a streamed body has a denominator only when the body arrived still
    gzipped** (`feed::StreamedProgress`): the declared length is the wire's, and a decoded
    body is not that long — Spellbook declares 28.8 MB and delivers 639. Otherwise the total
    is `0`, which the page draws as a bar with no fraction, and reports go out on the byte
    step, never per chunk.
  - **A run that fails drops what it staged** (`StreamIngest::abandon`, `StreamTags::abandon`):
    here a connection that dies mid-body is an ordinary failure, not a kill.
  - **A feed this host cannot reach is refused before any request**:
    `marketplace_feed::reachable` is `FeedProvider::permits_a_page()` or
    `!host::asks_as_a_page()`. Mana Pool sends no `Access-Control-Allow-Origin`, so on a page
    its refresh is a sentence, `selected_due` never calls it due, and `FeedStatus.reachable`
    is `false`. Natively every feed is reachable.
  - **A finish that writes staging a batch at a time takes a turn in every gap** (step 5.3,
    2026-10-04): `tags::StreamTags::finish_in_turns` and `combos::store_in_turns`. Each is
    the one body of its feed's tail, an `async fn` that awaits a `platform::timer::Turn`
    where the synchronous loop stood aside — after every batch, with the connection let go
    and no transaction open. The streamed arm hands it the breather its download kept; the
    file-backed door (`StreamTags::finish`, `combos::store`) hands it `NoTurn` and runs it
    through `timer::unbroken`, so **natively it is the function it was, statement for
    statement** — each module pins its transaction count
    (`the_file_driver_commits_exactly_the_batches_it_always_did`,
    `the_store_commits_exactly_the_batches_it_always_did`). A command taken in a gap sees
    the previous taxonomy or the previous combos, whole: staging is invisible to every
    reader and the live tables do not move until the swap. **A new loop of this kind owes
    three things**: the batch written by a function that takes the connection and has let go
    before it returns, so the `.await` sits between calls; a `Sendable` fence over the
    `async fn` (`nothing_is_held_across_a_turn`, one in each module); and the turn taken
    only where nothing is half-written.
    - **What a command in a gap may do is what another thread could always do between two
      batches**, and three cases are written down and tested. A second refresh of the same
      feed is **refused** — the claim is held until after the swap. A cache clear is
      **refused** for the same claim. A `combos_clear` is **taken**, and the swap that
      follows it stands: the clear empties the live tables and the watermark, the staging
      twins are not its to touch, and the swap installs the new file *with* its watermark in
      one transaction — rows and their record together, which is the only thing that must
      hold. That is the right end and not a clear undone: the one press that reaches the
      clear is *discard and download again*.
      `combos::tests::a_clear_taken_between_two_batches_is_followed_by_the_swap`.
    - **Measured natively before it was built** (release, WAL, the real art file rebuilt
      from a dev corpus — 11 603 tags, 488 864 taggings, 979 249 closure rows; 2026-10-04):
      of a 12–15 s finish the closure's ~490 batches are 11–13 s, the swap 1.3–2.0 s, the
      edges 70 ms, the tags 50 ms, and **`ancestor_closures` 4.5 ms** — so the graph walk
      takes no turn and needs none.
    - ⚠️ **On a host that keeps no files the closure is written in key order, 8 000 rows to
      a transaction** (`tags::ClosurePlan`), where every other host writes it in the file's
      order, 2 000 at a time, as it always has — the rows that land are the same
      (`a_page_writes_the_closure_a_desktop_writes`). A browser's database is on a rollback
      journal, which writes every touched page twice, and the file's order puts nearly
      every row on a page of its own. Natively on a rollback journal (the same file,
      release, NTFS) the closure took 16.6–17.8 s as it was, 10.5 s at 8 000 rows, 5.4–6.1 s
      in key order, and **2.6–2.8 s with both**. **A browser has timed the finish it is
      part of, once, and not the closure apart from it** (headless Chrome 154.0.8037.95,
      Windows 11, 2026-10-04, the built app against the real hosts —
      [light-app.md](../../docs/reference/light-app.md) §9.3): the oracle tags' finish took
      **1.74 s** where the module before the turns took 10.76 s and 11.34 s, and the art
      tags' **4.11 s** against 23.56 s and 23.38 s. One run of one plan cannot say how much
      is the order and how much the batch. `CLOSURE_BATCH_WITHOUT_FILES`' doc has the native table
      and what to put back if another browser says otherwise. A batch is also the longest
      a command waits, which is why it is not larger: on that run a `sync_status` sent once
      a second waited at most 53 ms inside the oracle finish and 1.10 s inside the art
      one. **The desktop would gain as much and was left alone on purpose** — its
      statements were not to move in this step.
  - ⚠️ **What is still synchronous, to its end, on the caller**: `StreamIngest::finish` (the
    card swap, every index replayed, the FTS rebuild — one transaction by need),
    `marketplace_feed::store` (it writes the live table, so it cannot commit in pieces),
    **each tag file's swap** (four renames *and the two indexes a rename does not carry*,
    built over the whole closure inside that one transaction), the combos' swap,
    `maintenance::reclaim_freed_pages` and the facet index's build. On a host with one
    thread no command is answered while one runs. Timed in a browser (headless Chrome 154,
    2026-10-04): the card finish 4.28 s and 4.70 s on the module before the turns and
    **5.26 s** on the one with them — which makes it the longest single wait of a first
    run, 4.79 s, where the art tags' finish used to be at 23.57 s; Card Kingdom's store
    0.8 s. **The tag swaps have still not been timed apart in a browser**: on the run with
    the turns, the longest stretch in which nothing was answered was the last one before
    `done` in each feed — 0.96 s for the oracle tags, 2.06 s for the art tags, 1.65 s for
    the combos — which is where a swap would be, and is its position rather than its
    cause. Natively each tag swap is 1.1–2.0 s.
- **`spawn` takes work off the caller only where there is somewhere to put it.** The card
  sync's ingest, its migration pass, its reclaim and its compaction go through `blocking`; the
  facet index's build through `background`. In a browser both run on the caller, to completion —
  which is why **nothing may call either while holding a lock the work takes**: natively that is
  a wait, there it is a lock taken twice by one thread. `run_sync` holds none across them, by
  the module's own rule that no guard crosses an `.await`. A browser's `background` has
  *finished* when it returns where a native one has only started; rely on neither. **A panic in
  the work is `Err(Lost)` natively and a panic in a browser**, where there is no pool or thread
  to catch it.
- **The facet index's build opens a connection of its own, where the host can have one** —
  `index::lifecycle::build_now` and `invalidate_owned` call `db::open_read` on the state's data
  directory, so a full pass over `cards` never holds the read connection every search waits on.
  **On a host built with one connection (`State::one_connection`) they read through the
  state's** — `lifecycle::over_the_corpus` is the one place that is decided (step 5.1). ⚠️ What
  runs inside that pass holds the connection every write goes through, so it may not ask for
  it: `amend_owned` hands a failure back and `invalidate_owned` writes it to `error_log` once
  the pass has let go. Noted from inside, the row was asked for by the thread holding the lock
  and was never written — found by reading, and held by
  `a_failed_owned_refresh_on_one_connection_is_still_written_down`.
- **`files::listing` is whole or it is an error.** A directory that is not there answers
  `None`, which is an ordinary state; a directory or an entry that cannot be read is the error,
  so a partial listing is never mistaken for a whole one — the image cache's eviction reaps the
  row of every file it did not find, and must not find fewer than there are. An entry carries
  what it is (a link is a link, never what it points at), and anything but a directory carries
  its length and its modified time.
- **`Wall` is for a stamp and `Tick` is for a wait**, and they are not interchangeable: a
  `Wall` can be written to a file and read back next month, and a reader can move it; a `Tick`
  only ever says how long ago it was taken. The image cache's used-stamp is a `Wall` and its
  429 deadline is a `Tick` and how long the penalty runs.
- **A permit or a lock an `async fn` holds across an `.await` is `platform::sync`'s** — the
  image cache's permits and its lock per key — and it is `tokio::sync` on every host, the
  primitive the cache always had. **First come, first served, and that is why it is not
  another crate's**: a pre-warm asks for its next picture the instant it lets go of the last,
  so a semaphore that hands a freed permit to whoever asks first lets it keep one for its whole
  run, ahead of every tile on screen. The move went through `async-lock` for an afternoon and
  a reviewer found exactly that in its source; `platform::sync`'s own test holds the order.
  (Scryfall's pacing gate is `futures_util::lock::Mutex`, which promises spacing and not
  order.)
- **An interface grows with a caller, not ahead of one.** `POST`, a text body, a request's
  `deadline`, `device::name` and `sync::Shared` all arrived with the sync step's second part,
  because that is when something here first called them.

**Most of the engine never asks for the time.** The domain modules use SQLite's `unixepoch()`
and `date('now')` inside the statement that needs them, which is the same on every host.

## State, the hook and events

**A host that is not the desktop opens its data folder with `launch::open(data_dir)`** (phase 4,
2026-10-03): the corpus replaced if it will not open, the write connection brought to head, the
read connection after it, the image cache and the Scryfall client with any stored 429 lockout
re-entered — `desktop::init_state`'s steps less the pre-27 conversion and the mirror's name, with
its sentences. It answers the pieces and builds no `State`: the sink and the observers are the
host's. The Android host (`mobile/src-tauri`) is its first caller; the desktop does not call it.

**A host with no folder and one connection opens with `launch::open_single(databases,
data_dir)`** (phase 5, step 5.1, 2026-10-04) — a browser. No folder is made and no file is asked
after; the pair is opened on **one** connection by `db::open_single`, which is `open_write`
statement for statement plus `temp_store = FILE`, and **answers the journal each file actually
got** (`db::Journal`: `wal` on a folder, `delete` on a browser's OPFS pool, never assumed).
`Opened.read` is `None`, and it is handed to `State::new` as it is. `databases` is empty where the
VFS is the filesystem (a pool's names are bare); `data_dir` is what the host shows and what the
image cache is told, and need not be a path (`OPFS:/<directory>`). **A host that can delete
its corpus by name calls `launch::open_single_replacing(databases, data_dir, delete)`** (step
5.2): a corpus that will not attach or will not migrate is thrown away through the host's
closure — the pool's `delete_db`, called once, with no connection open — and the pair is
opened again; `user.db` is never touched, and `Opened.corpus_replaced` says it happened. What
decides it is here (`db::Unopened`, `schema::Stopped`, and `says_nothing_about_the_file` for
the failures that must *not* delete a corpus); only the delete is the host's. ⚠️ **A corpus
damaged inside a sound first page is still never looked for on such a host**:
`schema::check_corpus` opens a connection of its own and leaves a mark file, and a browser
has neither. One that is simply gone reads as a first run.

**A host builds one `state::State` and everything else is handed it.**
`State::new(write, read, data_dir, events, observers, client, images)` takes connections the
host opened and brought to head, installs the hooks on the write connection, and only then puts
it behind its mutex. So there is no `State` whose cross-file fence is not riding. It starts
with no sync in flight and a cold facet index; **the Scryfall client and the image cache are
the host's to build**, because where the API lives, what 429 lockout an earlier run earned and
where the pictures are kept are the host's to know. ⚠️ **Seven arguments is clippy's ceiling**
(`too_many_arguments` fires at eight): the next thing a host hands the state wants a struct.

- **A host keeps its state in an `Arc`**, because two things outlive the call that starts them
  and each takes one: `sync::run_sync(state: Arc<State>, force)` and
  `index::lifecycle::spawn_build(&Arc<State>)`. The desktop's `AppState.core` is that `Arc`.

- **No shipped code installs a hook but `hooks::install`, and a host never calls it for its
  app's connection** — `State::new` has. SQLite keeps one update hook, one commit hook and one
  rollback hook per connection, and a second install **replaces** the first without a word:
  `hooks::tests::a_second_install_replaces_the_first`. Whatever needs to hear about a write is a
  `WriteObserver` in the list `State::new` is given. (Two tests put a raw hook on a bare
  connection of their own — `reconcile`'s here and `tags`' in `src-tauri` — and the desktop's
  `watch::install_hook` pair is `#[cfg(test)]`, so none of it can reach the app's.)
- **The fence is ahead of every observer, on both hooks.** On the commit hook that is pinned —
  `the_fence_has_settled_by_the_time_an_observer_hears_the_commit` — and on the update hook it
  is not, because the bits a row leaves are private and no observer can ask for them.
- **An observer runs inside SQLite's callback**, on the writer's thread with the write
  connection's mutex held: an atomic, a lookup in a list built beforehand, a notify that cannot
  block. Never a lock another thread holds for long, never a call back into the database.
- **Observers are told in list order, on both hooks, and the order is a contract.** The
  desktop's list is `mirror::watch::observers` — sync wake, change mask, mirror mask — which
  gives the update hook and the commit hook the call order each has always had.
- **The update hook has two blind spots, both pinned in `hooks`' tests**: a `WITHOUT ROWID`
  table never reaches `row`, and neither does a bare `DELETE` on a table with no triggers and no
  foreign key naming it. Both still reach `committed`. An observer that must not miss a write
  listens for the commit.
- **`read` is `None` on a host that can have only one connection** — a browser's storage
  permits exactly one (spec §6). `State::reader()` is then the write connection's own mutex, and
  `lock_db_read` takes it. ⚠️ **A read asked for while the same thread holds the write
  connection is then a lock taken twice**, which the desktop's two connections never notice:
  a wait that never ends natively, and in a Worker a trap (std's `Mutex` panics on a recursive
  lock where there are no threads). **`commands`' test
  `every_command_answers_on_one_connection_and_one_thread` runs every entry of `TABLE` that
  way** — the real one-connection launch, a thread standing in for a Worker
  (`platform::alone`) — and fails with the command's name on a panic, on a `BUSY` answered
  against itself, and on a call that never answers.
  `a_lock_taken_twice_fails_by_name_instead_of_hanging` is the mutation that shows each is
  caught. **A new `blocking` or `task` command
  owes that test a row of arguments** (`chosen_args`): those are the kinds handed the state,
  and it refuses a table that grew one without. `reader()` is also what a caller passes on
  where it used to pass `&state.db_read`; the field is private.
  - ⚠️ **"By name instead of hanging" is true of four locks and no others**: a connection and
    the facet index (routed through `platform::alone`, which panics), and the sync lane and the
    pairing offer (awaited, so the test's deadline ends them). `db::lock_plain` and every bare
    `.lock()` — the image cache's maps, Scryfall's pacing gate, the event sinks, the scanner,
    the undo tickets — are taken as they are natively, and a recursive one **blocks the test's
    thread for good**: no deadline fires on a current-thread runtime whose thread is blocked.
    They are deliberately not routed: some are process-wide (`db`'s `WAITING`), and a test
    binary's other threads hold them honestly. In a Worker each would still be a trap.
  - **A bounded ask is watched too, and more strictly than a browser treats it.** There
    `db::lock_for` answers `None` at its first contended attempt, and ~20 callers — every
    `note_*`, `mark_checked`, `persist_penalty`, the backoff stamps — drop their work on `None`.
    So a self-contended one is a write that silently never happens: no trap, no `BUSY`. On an
    emulated thread `lock_for` panics instead (`alone::refuse_held`), which is how the
    `amend_owned` bug above fails by name at `sync.rs`'s ask rather than as a missing row.
    The table test itself reaches none of those helpers on a failing download — its mock
    answers 404 — so each download's own tests run the far side the same way, one connection
    and one thread under `host::emulate_page()`: a whole streamed run, a short body, a body
    that stalls (`sync::run_tests`, `tags::oracle`, `tags::art`, `combos`,
    `marketplace_feed`). A `note_*` or a stamp asked for with the connection held fails
    there by name. **The table test stands under `emulate_page()` too** since step 5.2, so
    the five download commands take the streamed arm and a command that asks for a file is
    refused as a browser refuses it.
  - **Asked is not run.** A made-up argument that does not parse is refused before the body;
    the test counts those and pins them by name (`STOPPED_AT_THE_DOOR`, empty since the four
    it found were given rows), so a new command it never reaches is a red test, not a
    silence.
- **`events::EventSink` is how an event leaves the crate.** A host gives the state one sink;
  code with something to say calls `events::emit` with `&*state.events` — `sync:progress`, and
  `collection:reconciled` when the migration log moved something; `combos:progress`,
  `marketplace:progress` and each tag binding's own, through that module's `emit`. Never an
  `AppHandle`, a window or a channel as a parameter. Live sync still emits `sync:live` and
  `sync:applied` through the desktop's window, because what emits them is its connection manager
  (`src-tauri`'s `sync_engine::live`), which did not move.
- **A feed's `refresh` takes its progress as a callback and its `emit` is what a host hands
  it.** `refresh(&state, force, &mut |phase, done, total| emit(&state, phase, done, total))` is
  the whole of a command's body. The callback is what lets a test drive the path and read what
  it said; the launch's `refresh_if_due` hands the same `emit`.
- **`WriteObserver::corpus_replaced` is the one thing an observer hears that no hook carries.**
  A sync that swapped `cards` calls `State::corpus_replaced()` the moment the swap lands, and
  so does a price refresh that rewrote `marketplace_prices`; every observer the host gave the
  state is told once, in list order. It is how the desktop's
  mirror learns that every price it has written is a corpus old — `cards` maps to no surface in
  its row map on purpose, because a swap is 116 700 rows. An observer that does not care
  implements nothing: the method defaults to nothing.

**`State` is the every-host half of the desktop's `AppState` as far as the extraction has got.**
`AppState` wraps it and derefs to it, so `state.db` over there is this struct's field. What
`AppState` still declares — `mirror`, `mirror_status` and `changes`, the mirror's and the other
windows' — is the desktop's for good. **The last field that was waiting, the pending pairing
offer, came here with the sync step's second part**: `State.pairing`, a
`platform::sync::Shared<Option<sync_pair::pairing::Pending>>`, because an offer outlives the
page that made it on every host, and dies with the process on every host. **Take it before the
lane, never after** — a press holding the lane and waiting on the offer is behind a poll holding
the offer and waiting on the lane.

**`State.scanner` came with the seventh step, and it was never an `AppState` field** — the desktop
`app.manage`d it beside `AppState`, deliberately, because it is optional and shares nothing but
the data directory. Markus chose the field over a second handle a host would keep beside its
`State` (2026-10-03), because the command table reaches everything through one. `State::new`
builds it **empty** from the data directory it already has — no new argument, and nothing is read
until a command first asks for the session. **What the host's binary carries is said once,
through `ScannerState::carry`, before any command can reach the state** — the desktop does it
above its `app.manage`; a host that never says carries nothing, and a second word is ignored.

**`state::with_write` is the one definition of a user-facing write, and it is here since the
domain step.** `with_write`, `with_write_waiting` and the private `written` they share: the
managed wishlists armed, the caller's closure, the token reconcile, the settle, and the fence's
`debug_assert` — in that order, on both the bounded path and the waiting one. They are free
functions over `&State` rather than methods, so every caller in `src-tauri` reads as it did:
`sync` re-exports `with_write`, and an `Arc<AppState>` passes as `&state` through the deref. The body
is byte for byte what it was but for the parameter's type. **It waited a step** because it has no
line to be cut at — the three calls sit between the lock and the assertion — and a write with no
settle would have been a second definition of a user-facing write.

- **A function here that writes takes `&Connection`, and its host wraps it in `with_write`.** Not
  the other way round: a core function that took the write lock itself could not be composed
  into a caller's transaction, and none does.
- `collection_source::with_write_owned` — `with_write` plus the facet index's `owned` rebuild,
  on success only — is here since the index's lifecycle is. It takes `&State` like `with_write`.

## A sync operation: a stretch at a time, on a lane

**The one kind of function here that does not take `&Connection` is an `async fn` that talks to
the relay.** It takes `db: &impl state::Store` and reaches the database inside
`db.with(|conn| …)` — a *stretch*, one closure run to its end — with each request made between
two stretches and nothing held. A browser has one thread: a lock held across an `.await` there is
a lock nobody else can ever take. [The spike](../../docs/superpowers/research/2026-10-02-light-app-step-6-sync-trip-spike.md)
is the record. They were restated in `src-tauri` in the sync step's first part and moved here in
its second: `sync_engine::{client, entitlement}` and `sync_pair::pairing`, with `wire`,
`schedule`, `identity` and the sync panel's reads (`sync_engine::commands`) beside them.

- **`State::lane()` is one sync operation at a time, and its guard is the app's store.**
  `state::Lane` is the only `Store` a shipped build has for a host's database — the trait is
  deliberately not implemented for `State`, and for a bare `Connection` only under `testing` —
  so a stretch outside the lane does not compile. `lane()` waits its turn (a background trip, a
  departure); `lane_for_press()` gives up after `db::WRITE_LOCK_WAIT` and answers `db::BUSY`, on
  the lane and on the connection alike.
- **A stretch is `with_write_waiting`**: it waits for the connection rather than answering
  `BUSY`, because it may be recording an answer the relay will not give twice, and it is a
  user-facing write like any other — armed, reconciled, settled, fenced. That function has no
  other caller. **Never call `with` while holding the connection**: a same-thread second lock is
  a deadlock. A caller that already holds it hands it to `Lane::in_hand`.
- **What can land between two stretches is a reader's write**, so two reads that must agree —
  a baseline's rows and its horizon, a commit's rows — go in one stretch.
- **Two fences, one of them the compiler.** A future that keeps a `MutexGuard` across an
  `.await` is not `Send`, and each entry point is checked by a function that is never called
  (`fn sendable<T: platform::Sendable>(_: T) {}`); `clippy::await_holding_lock` refuses the same
  in every function, tests included, which is why a test that needs the connection held holds it
  from another thread. ⚠️ **Bound it by `platform::Sendable` and never by `Send`**: in a browser a
  request's future is a JavaScript promise and is never `Send`, so a `Send` bound fails the WASM
  compile on every entry point — which is what the move did, and the only gate that saw it was
  the `core` job's. `Sendable` is `Send` natively, so the fence asks exactly what it asked.
- **The lane's wait ends because every operation on it does**: each relay request is bounded —
  natively by its connect and read bounds, and in a browser by `Client::deadline`, the whole
  request: **120 s** for the sync client — pairing's rendezvous included, which goes through it
  — whose unpaged pull can be large, and **30 s** for the entitlement. ⚠️ **No browser has run
  either number**; the web phase measures them.
- **What a press runs on is the host's.** The desktop's wrappers are
  `sync::on_a_worker(|| async { … state.lane_for_press().await? … })` in `src-tauri`, and a
  departure is `sync_pair::pairing::leave(&State)` here, which takes `State::lane()` — so a
  host's Leave button is one call, and waits as the desktop's does.

## The command table: `commands!` and `dispatch`

**`src/commands.rs` is how a host with no window calls the engine** — `grimoire_core::dispatch(&state,
name, args, body)`, a command by its desktop name with the JSON a page sent. The WASM host
exports `call(name, args, body?)` over it (`crates/grimoire-web`) and the Android host one
`core_call`; **the desktop does not use it** and keeps its typed wrappers, so there are two lists and `src-tauri`'s `command_table` test is
the fence between them (light-app spec §2.4; [light-app.md](../../docs/reference/light-app.md)
§6.11). Markus chose (2026-10-03) the machinery and the reads first, and a `macro_rules!` table.

**One entry has no desktop wrapper: `card_image_source`** (step 5.3, 2026-10-04) — where a
card's picture is, for a host whose page fetches pictures itself. It is on `src-tauri`'s
`command_table::TABLE_ONLY` with its reason, which is `DESKTOP_ONLY` read from the other
side: the fence refuses a table command the desktop does not register unless that list names
it, and refuses one on the list that has a wrapper after all. **A wrapper nobody calls is
not the way to satisfy it** — a registered command is one a page can invoke.

- **One line per command, in the `commands! { … }` block at the file's foot**:
  `read card_detail in card(id: String, marketplace: Option<String>) = |conn| { … };` — kind,
  name, the module whose items the body names (glob-imported for that entry), the arguments, and
  a body that answers `Result<_, String>` for something that serializes. The macro expands it into
  an argument struct, an arm of `dispatch` and a row of `TABLE`.
- **The name and the arguments are the desktop wrapper's, exactly** — they are the wire (a
  table-only command's entry *is* its wire: nothing else spells it). The
  arguments arrive camelCase (`rename_all`, as Tauri renames a wrapper's own), and an absent
  `Option` is `None`, which is what `ipc.ts` relies on when it leaves one out.
  `every_command_in_the_table_takes_its_wrappers_arguments` compares the two by name, in order
  **and by type** (each normalised to what it names, so `crate::sorting::Marketplace` is
  `Marketplace` — an `Option<String>` where the wrapper takes `Option<Marketplace>` would refuse
  a value the desktop reads as TCGplayer); **it found `price_movers`' `window` argument the day it
  was written**, which a filter by parameter *name* had dropped as a window — Tauri's own
  parameters are told apart by their `tauri::` type, never their name.
- **The body is the wrapper's own body**, its connection named `conn` — so a command answers the
  same on every host. A name the body's module imported **privately** does not cross the entry's
  glob, so it is imported at the top of `commands.rs` (`Marketplace`, `CardFilters`,
  `WishlistQuery` today); a wrapper that renamed what it imported (`plan as read_plan`) is written
  with the core's own name.
- **Six kinds**: `read` (blocking pool, the read connection), `write` (`state::with_write`),
  `owned` (`collection_source::with_write_owned`), `blocking` (blocking pool, the `Arc<State>`
  and no connection — a body that takes the `State` itself, like `combos_status`, or decides
  something before it takes a connection, like `bulk_undo`), `task` (awaited where it stands,
  bound to the `Arc<State>`), `bytes` (blocking pool, with the call's raw body). **Every kind but
  `bytes` is in the table since phase 4's step 4.2** (2026-10-03), which moved every write, feed
  and sync command a light install can answer; all six are proven by `commands::tests::kinds`, a
  table of its own — an arm of the macro nothing expands is an arm nothing has compiled. **The two
  that look alike are told apart there**: over a warm facet index an `owned` write publishes the
  index again and a `write` leaves it, and a `read` answers while another thread holds the write
  connection.
- **What a wrapper does beside the core is left out of its entry, and the entry says so**:
  marking `AppState.changes` for the desktop's other windows, and telling the mirror. An event the
  wrapper emits through its window (`sync_now`'s `sync:applied`) goes through `state.events`.
  `src-tauri`'s `NOT_YET` holds what is left, each group with what it waits on.
- **Every refusal is a sentence**: a name the table does not have, arguments that do not parse
  (the field serde misses is named, camelCase), a raw body sent to a command that takes none, and
  none sent to a `bytes` one.
- **`dispatch` holds nothing across an `.await`** — `nothing_is_held_across_a_call`, the sync
  modules' `Sendable` fence.
- **A command joins the table by hand**: one line here, and its name taken off `src-tauri`'s
  `NOT_YET` — or, for one the desktop will never register, put on its `TABLE_ONLY` with why.
  `scripts/core-command-table.mjs` drafted the 88 reads from the wrappers once and is a
  record, not a tool to re-run over a table people have edited — it rewrites the whole block.

## The image cache: the pass is here, the schedule is the host's

`images::Cache` is a field of `State`, and everything about a picture but how it reaches a
page is in `images.rs`: the resolution rule, one fetch per key, the owed-row queue, the keys a
pre-warm fetches, and the eviction pass that spares exactly those.

- **`images::upkeep_tick(&State, &mut last)` is one wake of a host's upkeep loop**, and the
  loop is the host's: the desktop sleeps `UPKEEP_TICK` on a thread of its own between calls
  (`spawn_upkeep`, in `src-tauri`), and the Android host has the same ten lines in
  `mobile/src-tauri`. **A browser must
  not call it in a loop** — it has no thread to sleep on, and no files to evict.
- **What a request is answered with is here; the response type is the host's.**
  `images::answer(&State, path)` resolves a protocol path to an `images::Reply` — status,
  content type, cache control, `Retry-After` and body, with no HTTP crate in it — and `Reply::of`,
  `failure`, `not_ready` and `not_an_image` are the whole contract (what may be cached, for how
  long, what a retry waits). It came here from `src-tauri` with the light app's Android host
  (phase 4), so both hosts' `mtgimg` handlers are a conversion and nothing more; the desktop's
  seven tests of the answer run through its `to_response`. A web host answers a `fetch`.
- **In a browser the cache stores nothing, and that is a counted failure rather than a crash**:
  `platform::files` refuses, so every fetch serves its bytes, counts a `store_failure` and
  folds one `error_log` row. **A web host's pictures are its service worker's, in Cache
  Storage** (phase 5's decision, step 5.3), so nothing there should be calling the cache at
  all; it stays a fetcher that keeps nothing.
- **`images::image_source(conn, path)` says where a picture is and fetches nothing** — the
  table's `card_image_source`, for that service worker. `path` is the path `answer` is asked
  (`/<variant>/<card_id>/<face>`; a leading slash is optional and anything from a `?` or a
  `#` on is ignored), and the answer is `ImageSource`, tagged by `kind`: `uri` with
  Scryfall's address, `missing` with the placeholder `answer` would have served as SVG text,
  or `unknown`. **It is `resolve`'s rule whole** — face first, the host allowlist, the
  version rule — so a host that fetches for itself is told exactly what this cache would
  have fetched, and never an address `image_uri::is_fetchable` refuses. A path that is not a
  picture's is `unknown` and never an error.
- **`reset::clear_cache` is here with it**, over `platform::files`. Its sweep takes a listing
  that is whole or an error, so one unreadable entry now skips its directory where the old walk
  skipped the entry — and **a directory that would not list is counted once in `failed`**,
  where the old walk skipped one in silence. A sweep that left a folder behind says so.

## Moving a module here

1. **Check its tests as well as its code.** A module whose own code is pure can still open
   `schema::memory_pair()` in its tests, and a module's tests move with it. That is what kept six
   of the spec's fifteen "leaves" out of the first step.
2. `git mv` the file, so its history follows.
3. In `src-tauri`, **`pub mod x;` becomes `pub use grimoire_core::x;`** at the same place in the
   module map. `crate::x::…` goes on resolving there, so no caller is edited and no open branch
   has to re-learn a path.
4. **`pub(crate)` stops reaching `src-tauri`.** An item the desktop still calls becomes `pub`.
5. **A file read by relative path is one directory further away** — `include_str!` of
   `relay/src/log.ts` from `src/sync_engine/` is four `..` here where it was three.
   `scripts/ci-route.test.mjs` derives which CI job each such read routes to.
6. **A dependency the module brings is declared here as `src-tauri` declares it** — same
   version, same features — and leaves that manifest if nothing there names it any more, with
   the comment that argued its version.
7. A doc link to a module still in `src-tauri` is left as it is. It resolves again when that
   module arrives.
8. **A function that names a later step's code stays behind, alone.** `src-tauri` keeps a module
   of the same name — **as `x/mod.rs`, never `x.rs`**, so the old path is gone and git records
   the moved file as a rename — that is `pub use grimoire_core::x::*;` plus that function — an item a module
   defines shadows a glob import of the same name, so every other `crate::x::…` there is this
   crate's. Cut where the function already draws a line, and prove the halves rejoin to the
   original body byte for byte. Never a callback the host passes in: the next step would delete
   it.
9. **A test that names a module still in `src-tauri` stays there, unedited**, beside the
   re-export. Everything else in the test module moves.
10. **Test scaffolding another crate's tests reach is gated
    `#[cfg(any(test, feature = "testing"))]`**, never plain `#[cfg(test)]` — a dependency's
    `cfg(test)` is off while another crate's tests build. Helpers both sides need go in a
    `pub mod fixtures` at the **foot** of the file, below `mod tests`: `scripts/coverage-rust.mjs`
    counts everything from the first column-0 `#[cfg(test)]` down as test code.
11. ⚠️ **Grep the module for `cfg!(test)` and `#[cfg(not(test))]` as well — a behaviour that
    switches on `test` goes dark without a compile error.** `image_uri` allowed a loopback host
    under `cfg!(test)`; moved, it refused, and ten of `src-tauri`'s `images` tests were served
    the placeholder. Rule 10's gate is the fix, and anything it widens is then something the
    `testing` feature ships if it leaks — say so beside it. `bulk_undo::with_store` was the
    second: its process-wide ticket store and its per-thread twin follow the feature since the
    domain step. The sync step's second part moved the last two, `sync_engine/client.rs` and
    `entitlement.rs`: each `http()` keeps one client for the process in a shipped build and makes
    a fresh one per call under `any(test, feature = "testing")`, so the desktop's sync tests,
    which link this crate with the feature on, still get a client per runtime.
12. **A `#[tauri::command]` wrapper stays, with everything that names the desktop** — `tauri::`,
    `AppState`, an `AppHandle` — and with any private helper only those items call. `src-tauri`
    keeps `x/mod.rs` as in rule 8, and its `lib.rs` line stays `pub mod x;`.
13. **A test that names something that stays, stays**, in the remainder's own `mod tests`. A
    helper both sides call is a fixture (rule 10); a helper only the staying tests call goes with
    them.
14. **Do it with the splitter, not by hand.** `scripts/lib/rs-items.mjs` cuts a file into its
    top-level items and rejoins it byte for byte, and `scripts/core-step-4.mjs` is rules 2 to 13
    applied to a list of modules: what stays, what moves, the imports each half still needs, the
    visibilities `src-tauri` still reaches, the fixtures. `--dry` prints the decisions without
    writing. The next step's script is that one with another list.
15. **A module that reaches a network, a disk or a thread is rewritten onto `platform` as it
    moves** — `reqwest` onto `platform::http`, `tokio::time` onto `platform::timer`, `std::fs`
    and `tokio::fs` onto `platform::files`, a clock onto `platform::clock`. The fence refuses
    all of them in shipped code, so the move does not compile into a green suite until it is
    done. **Its tests move as they are**: a test may write a file with `std::fs` and run under
    `#[tokio::test]`. What a test may not do is read `Instant` or `SystemTime` — `Tick`.
    **Nothing the request sends may change**: the URL, each header, the pacing, the retries and
    the timeouts are checked against the module's own mock-server tests, which move unedited.

## What a moved module left in `src-tauri`

Each row goes home in the step that moves what it names.

**Beside every module's command wrappers**, which are not listed — `grep -c '#\[tauri::command'
src-tauri/src/<module>/mod.rs` counts them:

| Module | Still in `src-tauri` | Because it names | Home with |
| --- | --- | --- | --- |
| `schema` (`src/schema/mod.rs`) | `prepare_data_dir` — `split::convert`, then `schema::replace_unreadable_corpus` here | `split`, which only the desktop has | never: `split` stays |
| `schema` | 7 of its tests | `split`, through that function or a converted fixture | never: `split` stays |
| `ingest` (`src/ingest/mod.rs`) | 1 of its tests | `split::convert`, which builds that test's database | never: `split` stays |
| `reset` | 1 test, `the_cache_sweep_unlinks_rather_than_follows` | a platform: it makes a symlink with a Windows call behind `#[cfg(windows)]`, which the fence keeps out of this crate's tests too | never |
| `sync` (`src/sync/mod.rs`) | `AppState` and its `Deref`; `lock_db`, `lock_db_read`, `lock_plain` | the mirror's fields and the change mask (the pending pairing offer was the third, until it moved to `State` with the sync step) | never |
| `index` (`src/index/mod.rs`, `src/index/facets/mod.rs`) | the `facet_cards` command, and no test: every one moved, onto a fixture this crate builds at head | a window | never |
| `images` (`src/images/mod.rs`) | `serve` and `to_response`; `spawn_upkeep`; 7 tests | `tauri::http`, an `AppHandle`; a thread that sleeps | never: the response type, and when to wake for a pass, are a host's — the reply itself came here in phase 4 |
| `scanner` (`src/scanner/mod.rs`) | `compiled()` and the three `include_bytes!` it reads; the three request headers, `FramePayload`, `frame_payload`, `split_detail`, `capture_payload`; 8 tests | `cfg(scanner_assets)`, which `build.rs` sets and this crate's fence refuses; `tauri::ipc::InvokeBody` and `HeaderMap` | never: what a binary embeds and how bytes cross a host's IPC are the host's — the Android host carries a frame base64 (spec §2.4) |
| `sync_engine` (`src/sync_engine/mod.rs`) | `live`, the connection manager — its socket, its backoff timers, the exit push — and its tests | `tokio` tasks, a WebSocket and an `AppHandle` it emits `sync:live` and `sync:applied` through | never: how a host keeps a socket open is the host's; `schedule` is the half that decides, and it is here |
| `maintenance` | 9 tests — nothing of its code | a database `split` converted | never |
| `import` | `read_import_file`, two helpers and 5 tests | a path the desktop's file dialog answered | never: a host reads its own file |
| `marketplace` | `set_marketplace_now` | `AppState.mirror` | never: the mirror is the desktop's |

**Three modules on the domain step's list did not move, and one function**: `reconcile` (its
`apply` takes `&[scryfall::Migration]`), `tags/` (`query` and `muted` take `tags::Dataset`, which
sits in the fetch engine) and `deck::bracket_reads`. The alternative was to hoist those three
small pieces into this crate ahead of their modules; Markus declined, as he had for the sync
client's cursor keys in step 2. **`reconcile` arrived with `scryfall`**, in the I/O step's first
part, and with it what the same rule had kept back: `errors::kind_of`, and `capture`'s two
tests that drive the reconciler. **`tags/` and `bracket_reads` arrived with the feeds**, in its
third, and so did everything else that had waited on them or on the image cache:
`reset::clear_cache`, `sync::status`, and the tests of `card`, `search` and `schema` that
named one.

**`schema::prepare_database` is the launch**: `bring_to_head`, then the logged passes — the FTS
rebuild an interrupted compaction owes, the staging table a killed ingest left, the trims, the
managed wishlists, the token conversion and repair, and last the drain of the dirty marks those
left. **`bring_to_head` is every step of it that may stop a launch**: `migrate_user`,
`migrate_corpus` (or the corpus replaced), then `capture::clear_stale_guard` and
`capture::install`. A host that opens a database calls `prepare_database`; `State::new` then
takes the connections.

⚠️ **A new user rung still owes its `UNDO_V<N>` in two files**: the constant goes in
`schema::fixtures` here, at the head of every chain in this file's tests — and at the head of
the one chain left in `src-tauri/src/schema/mod.rs`, `migrate_the_real_database_to_v29`'s, which
is `#[ignore]`d and so never goes red for it. (The v59 conversion test's chain came home.)

## The manifest

- **The package version is the app's, and it is not decoration.** `scryfall::USER_AGENT` is
  `concat!("MTGGrimoire/", env!("CARGO_PKG_VERSION"), …)`, `env!` reads the package that compiles
  it, and every client in the app — Scryfall's, the feeds', the relay's, the updater's — sends
  that string **on a native host**; in a browser `platform::http` sets no `User-Agent`, and
  the browser's own goes out. release-please bumps this manifest and its `Cargo.lock` entry with `src-tauri`'s
  (`release-please-config.json`'s `extra-files`), and `src-tauri`'s
  `the_core_wears_the_apps_version` goes red if the two part. **Never set it back to `0.0.0`.**
- **`reqwest` is one line for every target**, the same line as `src-tauri`'s: `rustls-tls` names
  nothing on wasm, where `reqwest` is `fetch`. **No `gzip` feature, ever** — Scryfall's bulk data
  is a real `.gz` file, and transparent decompression corrupts the download.
- **`tokio` is in the native table only**, with the features this crate's own source names.
  `tokio::fs` does not compile for a browser, and a Worker has no tokio runtime. **The one
  exception is `sync`**, which the web table asks for and nothing else: a semaphore and a
  mutex need no runtime, and they are `platform::sync`. Never widen that line.
- **`rusqlite` is two lines**: `bundled` plus `hooks` everywhere but WASM, and `hooks` alone
  there. ⚠️ **Never `default-features = false` on the WASM line** — the backend that makes
  SQLite build for a browser is in rusqlite's default set, and switching it off fails with
  `unresolved import libsqlite3_sys`, which reads as "unsupported" and is the opposite.
- **`getrandom` gains `wasm_js` on WASM** and needs no build flag at 0.4.
- **`card-scanner` is a path dependency on every target, declared as `src-tauri` declares it**
  (`corpus` and `ocr`), since the seventh step. Measured before it came: the core with it checks
  clean for wasm32 in 27 s and builds in 68 s, and **its `rusqlite` line's `bundled` asks nothing
  of a browser build** — libsqlite3-sys is not in the wasm tree at all, so the rule above holds
  without a target table for it. ⚠️ **Compiling is not running**: in a browser the crate's own
  `std::thread::scope` and `Instant` panic, so nothing may call the session there before the light
  app's phase 7 seams them; the Android compile is CI's. **A change under `crates/card-scanner`
  runs the `core` job** — `scripts/ci-route.mjs`'s `crates/*` arm took `core` the same day.
  ⚠️ **It costs the web module 1.84 MB that nothing calls** (measured 2026-10-04, step 5.1):
  the scanner's `ocrs` is taken with its default features, one of which is `export-wasm` —
  `#[wasm_bindgen]` classes of its own (`OcrEngine` and nine more) that become exports of
  `grimoire_web.js` and root the whole OCR runtime past LTO. With that feature off in a scratch
  copy the module was 6 703 909 B against 8 547 708 B. The cure is `default-features = false`
  on `ocrs` in `crates/card-scanner/Cargo.toml`, keeping its `rten`; it was found by the web
  host's step and left for whoever owns that manifest.
- A target-specific dependency goes in a `[target.'cfg(…)'.dependencies]` table. That is the one
  place outside `src/platform/` a target is named, and the fence does not read it for that.
- **The `testing` feature is test scaffolding and nothing a build ships**: `schema::memory_pair`,
  `scratch`, `CardRow::from_json`, and every `pub mod fixtures` — `schema`'s,
  `sync_engine::capture`'s, and since the domain step `card`'s, `collection`'s, `deck`'s,
  `deck_tokens`', `maintenance`'s and `reset`'s; since the I/O step `index`'s, `ingest`'s,
  `events`' (a sink that keeps what it is told) and `state`'s — `state::fixtures::on_files` is
  a `State` over a pair of files at head, and what a test that needs one should reach for
  before it builds its own. `src-tauri` asks for it under
  `[dev-dependencies]` only, and resolver 2 leaves that out of every build that is not a test.
  ⚠️ **Never name it on a host's `[dependencies]` line, never make it a default, never have
  another feature imply it — because two things behind it are not scaffolding**:
  `image_uri::is_allowed_host` lets a loopback host through under it, for the image fetcher's
  mock server, and `bulk_undo::with_store` keeps its tickets per thread under it, where a shipped
  build keeps one store for the process. (A third costs only sockets: the relay clients'
  `http()` builds a client per request under it, where a shipped build keeps one.) Two things
  hold that, and only the second is complete:
  `platform::fence` sweeps every workspace member's manifest as text (a
  `[workspace.dependencies]` entry, a renamed dependency and a command-line `--features` all
  pass it), and CI's `rust` job fails when
  `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` prints
  `feature "testing"`. **A new host owes that step its own package name** — the light app's
  Android host, `grimoire-light`, has it since phase 4.
- **`clippy --all-targets` and `cargo test` both turn `testing` on for the host's ordinary
  library too**, so neither notices a non-test use of the scaffolding. `cargo check -p
  mtg-grimoire --locked` is the build that ships; `npm run verify` and the `rust` job both run it.

## Commands

The crate is a member of the workspace at the repository root, so it shares `Cargo.lock`, the
`[profile.*]` blocks in the root `Cargo.toml`, and the build tree — which is still
`src-tauri/target` (`.cargo/config.toml` pins it).

| | |
| --- | --- |
| `cargo test -p grimoire-core` | This crate's tests alone, natively |
| `cargo test -p grimoire-core schema::` | The schema's — `cargo test -p mtg-grimoire schema::` runs only the 7 that stayed |
| `cargo test -p grimoire-core scryfall::` | The client's, against a local mock server — never Scryfall |
| `cargo test -p grimoire-core index::` | The facet index's — `-p mtg-grimoire index::` runs none: only a command stayed |
| `cargo test -p grimoire-core sync::` | The card sync's, `sync::run_tests` among them: a whole run against a local mock Scryfall — `-p mtg-grimoire sync::` runs none of them, only `sync_engine`'s and `sync_pair`'s |
| `cargo test -p grimoire-core combos::` (`marketplace_feed::`, `tags::`, `images::`) | A feed's, or the image cache's, each against a local mock server — never the real host. `combos::tests::live_ingest` is the one that asks Commander Spellbook, and it is `#[ignore]`d |
| `cargo test -p grimoire-core deck::` | A domain module's — the same, for any of the forty-nine; `-p mtg-grimoire deck::` runs none: only wrappers stayed |
| `npm run verify` | Both members: `fmt --check`, `clippy -D warnings`, `cargo test --workspace` |
| `cargo build --lib -p grimoire-core --target wasm32-unknown-unknown` | The WASM compile. Needs clang 18 or newer for SQLite's C |
| `node scripts/build-wasm.mjs` | The web host's module, `crates/grimoire-web`, into `dist-wasm/` — finds clang itself on this machine, refuses a `wasm-bindgen` CLI that is not the lockfile's version, and prints the module's size |
| `cargo test -p grimoire-web` | The web host's decisions, natively — only its `#[wasm_bindgen]` shell is gated to the browser |

**On this machine clang is not on `PATH`** and `cc-rs` does not look for it:

```bash
CC_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/clang.exe" AR_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/llvm-ar.exe" cargo build --lib -p grimoire-core --target wasm32-unknown-unknown
```

The Android compile runs only in CI: there is no NDK here.

- **Never `cargo fmt --all`.** It follows path dependencies into `crates/card-scanner`, which is
  hand-formatted. `cargo fmt -p grimoire-core`.
- **A green suite here proves the desktop**, and — since step 5.1's table test — that no
  command takes its connection twice on a host with one. The `core` job proves the other two
  targets *compile*. What runs the module is the web host, in a browser; the suite here never
  does.
