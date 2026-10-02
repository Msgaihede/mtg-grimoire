# grimoire-core — the engine with no window

What every host links: the desktop app in `src-tauri` today, an Android shell and a WASM build in
a Worker later. The design is
[the light-app spec](../../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md)
§2; what each extraction step built and measured is in
[light-app.md](../../docs/reference/light-app.md).

**It is being filled a step at a time, and since 2026-10-02 most of the engine is here.** What is
here is what `src/lib.rs` declares: the leaves; the storage layer — `db`, `schema` with both
ladders, `sync_meta`, `filters`, `sorting`, `card_row`, `image_uri`, `errors`, `feed::backoff` and
`sync_engine::capture`; the state a host holds over it — `state`, `hooks` and `events`; and the
**domain** — the decks, the collection, the wishlist, the search, the card pane, the view-state
modules, `maintenance`, and the sync engine's `apply` and `baseline`: forty-nine modules, moved in
one pass by `scripts/core-step-4.mjs`. **The I/O step is arriving in three parts and two are
here**: `platform`'s request, timer, files and background work; the three modules that were
their first callers — `scryfall`, `ingest` and `reconcile`; and what drives them — `sync`, the
card sync, and `index/`, the facet index with its lifecycle. **What is not here yet**: the three
feeds (`combos`, `marketplace_feed`, `tags/`), `images`, the sync client and pairing, `share/`
and the scanner.
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
  cross the glob. Forty-six modules have such a file; `managed_wishlist` and the sync engine's
  `apply` and `baseline` have none, because nothing of theirs stayed.
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
| `platform::clock::Tick` — `now()`, `elapsed()`, for how long a wait has run | `Instant` | `Date.now()`, never negative |
| `platform::pause(Duration) -> bool` — stand aside for another thread | `thread::sleep`, `true` | **`false`, at once**: a Worker has no other thread to wait for |
| `platform::timer::sleep`, `timeout` — a wait a future awaits, and a deadline on one | `tokio::time` | a `Promise` around the global `setTimeout` |
| `platform::http` — `Client`, `Request`, `Response`, `Body`, `Error` | `reqwest` over rustls, with a connect bound and a per-read bound | `reqwest` over `fetch`: **no timeouts to set**, and `is_connect()` is always `false` |
| `platform::files` — `open`, `write`, `remove`, `create_dir_all`, `entries`, `is_file`, `exists`; and `files::aio` for an `async fn` | `std::fs`; `tokio::fs` | **refused**, `ErrorKind::Unsupported`; the two questions answer `false` |
| `platform::spawn::blocking(f).await` — synchronous work under an `async fn`; `spawn::background(f)` — work nobody waits for | the async runtime's blocking pool, **started by the call**; a thread | **run where it stands**: a Worker has no second thread, so `blocking` runs at its first poll and `background` before it returns |

`db::lock_for` and `db::lock_background` are why `Tick` and `pause` exist. **A wait that polls is
a wait that cannot succeed in a browser**, so `lock_for` gives up on its first contended attempt
there and its caller answers `db::BUSY`. **No browser arm has ever run** — the crate compiles for
`wasm32` and nothing instantiates it.

- **`http` is the wire and nothing above it.** Pacing, retry, the 429 lockout and the size checks
  are rules about Scryfall or about a feed, and live with the client that owns them
  (`scryfall::Client::api_send`). **`GET` is the only verb**, because it is the only one with a
  caller here; the sync client's `POST` arrives with it.
- **A status is a `u16`, a header is `Option<&str>`, a chunk is `bytes::Bytes`.** No `reqwest`
  type crosses out of the module, which is what lets the fence refuse the name everywhere else.
- **`timer`'s native arm needs a tokio runtime on the current task** — every host's async code
  runs on one — and panics outside it, as `tokio::time::sleep` always has.
- **`files` refuses in a browser rather than pretending.** The database there is OPFS behind
  SQLite's own VFS, and a download with no temp file is a different shape that the web host
  decides (spec §6). Until then a download that cannot be written is a failed sync — it stops
  at the folder it cannot make, after the bulk check and before the download is asked for, with
  its reason in `sync_meta`'s `last_error` — and `schema`'s backup before a climb is logged and skipped.
- **`spawn` takes work off the caller only where there is somewhere to put it.** The card
  sync's ingest, its migration pass, its reclaim and its compaction go through `blocking`; the
  facet index's build through `background`. In a browser both run on the caller, to completion —
  which is why **nothing may call either while holding a lock the work takes**: natively that is
  a wait, there it is a lock taken twice by one thread. `run_sync` holds none across them, by
  the module's own rule that no guard crosses an `.await`. A browser's `background` has
  *finished* when it returns where a native one has only started; rely on neither. **A panic in
  the work is `Err(Lost)` natively and a panic in a browser**, where there is no pool or thread
  to catch it.
- ⚠️ **The facet index's build opens a connection of its own** — `index::lifecycle::build_now`
  calls `db::open_read` on the state's data directory, so a full pass over `cards` never holds
  the read connection every search waits on. A browser's storage permits one connection (spec
  §6), so that open is the first thing the web host has to answer differently, and nothing in
  this crate does yet.
- **An interface grows with a caller, not ahead of one.** A rename and a modified time are the
  image cache's, and arrive with it.

**Most of the engine never asks for the time.** The domain modules use SQLite's `unixepoch()`
and `date('now')` inside the statement that needs them, which is the same on every host.

## State, the hook and events

**A host builds one `state::State` and everything else is handed it.**
`State::new(write, read, data_dir, events, observers, client)` takes connections the host opened
and brought to head, installs the hooks on the write connection, and only then puts it behind
its mutex. So there is no `State` whose cross-file fence is not riding. It starts with no sync
in flight and a cold facet index; **the Scryfall client is the host's to build**, because where
the API lives and what 429 lockout an earlier run earned are the host's to know.

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
  `lock_db_read` takes it. ⚠️ **Nothing has run that way**: a read asked for while the same
  thread holds the write connection is a lock taken twice, which the desktop's two connections
  never notice. `reader()` is also what a caller passes on where it used to pass
  `&state.db_read`; the field is private.
- **`events::EventSink` is how an event leaves the crate, and the card sync is its first
  caller.** A host gives the state one sink; code with something to say calls `events::emit`
  with `&*state.events` — `sync:progress`, and `collection:reconciled` when the migration log
  moved something. Never an `AppHandle`, a window or a channel as a parameter. The feeds and
  live sync still emit through the desktop's window from `src-tauri`, and move onto the sink as
  each arrives.
- **`WriteObserver::corpus_replaced` is the one thing an observer hears that no hook carries.**
  A sync that swapped `cards` calls `State::corpus_replaced()` the moment the swap lands, and
  every observer the host gave the state is told once, in list order. It is how the desktop's
  mirror learns that every price it has written is a corpus old — `cards` maps to no surface in
  its row map on purpose, because a swap is 116 700 rows. An observer that does not care
  implements nothing: the method defaults to nothing.

**`State` is the every-host half of the desktop's `AppState` as far as the extraction has got.**
`AppState` wraps it and derefs to it, so `state.db` over there is this struct's field. What
`AppState` still declares, and when each leaves:

| Field | Its type | Comes here with |
| --- | --- | --- |
| `images` | `images::Cache` | step 5, with the image cache |
| `pairing` | `sync_pair::pairing::Pending` | step 6 |
| `mirror`, `mirror_status`, `changes` | the mirror's and the other windows' | never: the desktop's |

**`state::with_write` is the one definition of a user-facing write, and it is here since the
domain step.** `with_write`, `with_write_waiting` and the private `written` they share: the
managed wishlists armed, the caller's closure, the token reconcile, the settle, and the fence's
`debug_assert` — in that order, on both the bounded path and the waiting one. They are free
functions over `&State` rather than methods, so every caller in `src-tauri` reads as it did:
`sync` re-exports the two, and an `Arc<AppState>` passes as `&state` through the deref. The body
is byte for byte what it was but for the parameter's type. **It waited a step** because it has no
line to be cut at — the three calls sit between the lock and the assertion — and a write with no
settle would have been a second definition of a user-facing write.

- **A function here that writes takes `&Connection`, and its host wraps it in `with_write`.** Not
  the other way round: a core function that took the write lock itself could not be composed
  into a caller's transaction, and none does.
- `collection_source::with_write_owned` — `with_write` plus the facet index's `owned` rebuild,
  on success only — is here since the index's lifecycle is. It takes `&State` like `with_write`.

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
    domain step. Two `#[cfg(not(test))]` sites wait in modules that have not moved:
    `sync_engine/entitlement.rs` and `sync_engine/client.rs`.
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
| `schema` | 8 of its tests | `split`, through that function or a converted fixture; one, `tags::query` | never, and step 5 |
| `ingest` (`src/ingest/mod.rs`) | 1 of its tests | `split::convert`, which builds that test's database | never: `split` stays |
| `deck` | `bracket_reads`, `DeckBracketRead`, their two SQL constants and 5 tests | `combos::match_combos` — `combos` is a feed | step 5 |
| `reset` | `clear_cache`, what only it calls, and 8 tests | `images::Cache`, the three feeds' `any_refresh_running` | step 5 |
| `sync` (`src/sync/mod.rs`) | `AppState` and its `Deref`; `lock_db`, `lock_db_read`, `lock_conn`, `lock_plain`; `status`; 5 tests and the `file_state` they share | the mirror's fields and the change mask; `images::Cache`, whose failure count `status` reads; an `AppState` on a file `split` converted | `status` with the image cache, in step 5; `AppState` never |
| `index` (`src/index/mod.rs`, `src/index/facets/mod.rs`) | the `facet_cards` command, and no test: every one moved, onto a fixture this crate builds at head | a window | never |
| `deck_tokens`, `card`, `search` | 1 test each | `sync_engine::client`, `images`, an `AppState` built whole | steps 5 and 6 |
| `maintenance` | 9 tests — nothing of its code | a database `split` converted | never |
| `import` | `read_import_file`, two helpers and 5 tests | a path the desktop's file dialog answered | never: a host reads its own file |
| `marketplace` | `set_marketplace_now` | `AppState.mirror` | never: the mirror is the desktop's |

**Three modules on the domain step's list did not move, and one function**: `reconcile` (its
`apply` takes `&[scryfall::Migration]`), `tags/` (`query` and `muted` take `tags::Dataset`, which
sits in the fetch engine) and `deck::bracket_reads`. The alternative was to hoist those three
small pieces into this crate ahead of their modules; Markus declined, as he had for the sync
client's cursor keys in step 2. **`reconcile` arrived with `scryfall`**, in the I/O step's first
part, and with it what the same rule had kept back: `errors::kind_of`, and `capture`'s two
tests that drive the reconciler. `tags/` and `bracket_reads` arrive with the feeds.

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
  that string. release-please bumps this manifest and its `Cargo.lock` entry with `src-tauri`'s
  (`release-please-config.json`'s `extra-files`), and `src-tauri`'s
  `the_core_wears_the_apps_version` goes red if the two part. **Never set it back to `0.0.0`.**
- **`reqwest` is one line for every target**, the same line as `src-tauri`'s: `rustls-tls` names
  nothing on wasm, where `reqwest` is `fetch`. **No `gzip` feature, ever** — Scryfall's bulk data
  is a real `.gz` file, and transparent decompression corrupts the download.
- **`tokio` is in the native table only**, with the features this crate's own source names.
  `tokio::fs` does not compile for a browser, and a Worker has no tokio runtime.
- **`rusqlite` is two lines**: `bundled` plus `hooks` everywhere but WASM, and `hooks` alone
  there. ⚠️ **Never `default-features = false` on the WASM line** — the backend that makes
  SQLite build for a browser is in rusqlite's default set, and switching it off fails with
  `unresolved import libsqlite3_sys`, which reads as "unsupported" and is the opposite.
- **`getrandom` gains `wasm_js` on WASM** and needs no build flag at 0.4.
- A target-specific dependency goes in a `[target.'cfg(…)'.dependencies]` table. That is the one
  place outside `src/platform/` a target is named, and the fence does not read it for that.
- **The `testing` feature is test scaffolding and nothing a build ships**: `schema::memory_pair`,
  `scratch`, `CardRow::from_json`, and every `pub mod fixtures` — `schema`'s,
  `sync_engine::capture`'s, and since the domain step `card`'s, `collection`'s, `deck`'s,
  `deck_tokens`', `maintenance`'s and `reset`'s. `src-tauri` asks for it under
  `[dev-dependencies]` only, and resolver 2 leaves that out of every build that is not a test.
  ⚠️ **Never name it on a host's `[dependencies]` line, never make it a default, never have
  another feature imply it — because two things behind it are not scaffolding**:
  `image_uri::is_allowed_host` lets a loopback host through under it, for the image fetcher's
  mock server, and `bulk_undo::with_store` keeps its tickets per thread under it, where a shipped
  build keeps one store for the process. Two things hold that, and only the second is complete:
  `platform::fence` sweeps every workspace member's manifest as text (a
  `[workspace.dependencies]` entry, a renamed dependency and a command-line `--features` all
  pass it), and CI's `rust` job fails when
  `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` prints
  `feature "testing"`. **A new host owes that step its own package name.**
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
| `cargo test -p grimoire-core schema::` | The schema's — `cargo test -p mtg-grimoire schema::` runs only the 8 that stayed |
| `cargo test -p grimoire-core scryfall::` | The client's, against a local mock server — never Scryfall |
| `cargo test -p grimoire-core index::` | The facet index's — `-p mtg-grimoire index::` runs none: only a command stayed |
| `cargo test -p grimoire-core sync::` | The card sync's, `sync::run_tests` among them: a whole run against a local mock Scryfall — `-p mtg-grimoire sync::` runs the 5 that stayed, and `sync_engine`'s and `sync_pair`'s with them |
| `cargo test -p grimoire-core deck::` | A domain module's — the same, for any of the forty-nine; `-p mtg-grimoire deck::` runs only the 5 that stayed |
| `npm run verify` | Both members: `fmt --check`, `clippy -D warnings`, `cargo test --workspace` |
| `cargo build --lib -p grimoire-core --target wasm32-unknown-unknown` | The WASM compile. Needs clang 18 or newer for SQLite's C |

**On this machine clang is not on `PATH`** and `cc-rs` does not look for it:

```bash
CC_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/clang.exe" AR_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/llvm-ar.exe" cargo build --lib -p grimoire-core --target wasm32-unknown-unknown
```

The Android compile runs only in CI: there is no NDK here.

- **Never `cargo fmt --all`.** It follows path dependencies into `crates/card-scanner`, which is
  hand-formatted. `cargo fmt -p grimoire-core`.
- **A green suite here proves the desktop.** The `core` job proves the other two targets
  *compile*; nothing yet runs this crate in a browser or on a phone.
