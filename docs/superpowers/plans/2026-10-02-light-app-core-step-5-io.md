# The shared core, step 5: I/O behind `platform/` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** everything in the engine that reaches a network or a disk does it through `crates/grimoire-core/src/platform/`, and the modules that do the reaching — the Scryfall client, the ingest, the card sync, the facet index's lifecycle, the three feeds and the image cache — are the core's, with the desktop app unchanged.

**Architecture:** three interfaces join `platform::clock` and `platform::pause` — `http` (a request and a streamed body), `timer` (a sleep a future awaits, and a deadline on one) and `files` (a download on disk, the files the schema keeps) — each with one implementation for the native hosts and one for a browser, picked by `cfg` inside the module. A module that moves has its `reqwest`, `tokio` and `std::fs` calls rewritten onto them, and the fence is extended so those four names cannot be written anywhere else in what the crate ships. The step lands as **three pull requests**, because unlike step 4 it changes code rather than only moving it.

**Tech Stack:** Rust (the workspace's pinned toolchain); `reqwest` 0.12 on every target (rustls natively, its own `fetch` backend on wasm); `tokio` natively; `wasm-bindgen-futures` and `js-sys` on wasm; `httpmock` for the client's tests.

**Spec:** [`docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md`](../specs/2026-10-01-light-app-android-and-web-design.md) §2.5, §2.6, §2.8. **Tracking issue:** Msgaihede/mtg-grimoire#761, phase 2, step 5. **The steps before:** [1](2026-10-02-light-app-core-step-1-leaves.md), [2](2026-10-02-light-app-core-step-2-storage.md), [3](2026-10-02-light-app-core-step-3-state.md), [4](2026-10-02-light-app-core-step-4-domain.md) and [light-app.md](../../reference/light-app.md) §6. **The rules for a moved module:** [`crates/grimoire-core/CLAUDE.md`](../../../crates/grimoire-core/CLAUDE.md), *Moving a module here*.

Everything measured here was measured on Windows on 2026-10-02, on this branch's tree over `main` at `52c9513a`.

## What was read before any code

`scripts/lib/rs-items.mjs` cut every file still in `src-tauri/src` into its items, and each item was read for what it names of the machine. Among the modules this step is about:

| Names | Where |
| --- | --- |
| an HTTP client (`reqwest`) | `scryfall`, `combos`, `marketplace_feed` — three clients, on purpose: the feeds are not Scryfall and must not spend its pacing budget |
| a timer on the async runtime (`tokio::time`) | `scryfall` (the pacing gate, the retry backoff, the image deadline), `images` (its pacer and its 429 penalty) |
| async files (`tokio::fs`) | `scryfall::Client::download` |
| blocking files (`std::fs`) | `ingest`, `scryfall::discard_partial`, the feeds' temp files, `images`, and — already in the core — `schema`, at eleven call sites |
| a thread | `index::lifecycle`, `images`, `tags`, `combos` |
| a window (`AppHandle`, `emit`) and the desktop's `AppState` | `sync::run_sync` and what it calls, each feed's `refresh` |

`share::publish`, `update` and `sync_engine::{client, entitlement, live}` name a client too. The first two are the desktop's for good and the last three are step 6's.

## Decisions taken before any code

### `reqwest` on both arms — Markus, 2026-10-02

`platform::http` is newtypes over `reqwest` on every target. Natively that is the client this app has always used; on wasm `reqwest` is `fetch`, so the interface is **one implementation with three lines that differ**: a browser has no socket, so there is no connect timeout and no per-read timeout to set, and `Error::is_connect` is always `false`. The alternatives were arms that refuse until phase 5, and a hand-written `fetch`. CI's `core` job compiles the browser arm; nothing runs it — the clock's standing since step 1.

### Step 5 is three pull requests — Markus, 2026-10-02

| Part | What |
| --- | --- |
| **5a** | `platform::{http, timer, files}` and their first callers: `scryfall`, `ingest`, `reconcile`, `errors::kind_of`, `schema`'s file calls |
| **5b** | the state the sync needs (`syncing`, `client`, `index`), the facet index's lifecycle, and `run_sync` emitting through `EventSink` |
| **5c** | the three feeds (`combos`, `marketplace_feed`, `tags/`) and the image cache |

Each is verified on its own and merges on its own. Auto-merge and auto-fix on each, as #766.

### Nothing is hoisted, still

Steps 2, 3 and 4 each declined to lift a small piece of a later step's code into the core early. This step is the later step, so the pieces arrive with their modules: `reconcile` (it takes `&[scryfall::Migration]`) and `errors::kind_of` (it classifies `scryfall::ScryfallError`) in 5a, `deck::bracket_reads` and `reset::clear_cache` in 5c.

### The engine's version is the app's

`scryfall::USER_AGENT` is `concat!("MTGGrimoire/", env!("CARGO_PKG_VERSION"), …)`, and `env!` reads the package that compiles it. Moved as it stands, every request this app makes — to Scryfall, to both price feeds, to Commander Spellbook, to the relay, to GitHub for an update — would have announced `MTGGrimoire/0.0.0`, which is exactly the inaccurate `User-Agent` Scryfall's API rules forbid.

So `crates/grimoire-core/Cargo.toml` carries the app's version, **0.39.0**, and stays in step with it three ways: `release-please-config.json`'s `extra-files` gains the core's manifest and its `Cargo.lock` entry; `desktop.rs`'s `the_core_wears_the_apps_version` asserts the `User-Agent` names `src-tauri`'s own version and that the config still lists both manifests; and `scripts/ci-route.mjs` routes that config to `rust`, since a Rust test now reads it.

The alternative was a `user_agent` argument to `Client::new`: 62 call sites, most of them tests, and eight clients elsewhere in `src-tauri` that borrow the constant.

### The interfaces, as their first callers need them

- **`http`** — `Client::new(&Config { user_agent, connect_timeout, read_timeout })`, `get(url)`, `Request::header`, `send`; `Response::status() -> u16`, `header(name)`, `content_length`, `bytes`, `into_body`; `Body::chunk()`; `Error::{is_timeout, is_connect, is_request}`. **`GET` only**: the first `POST` is the sync client's, in step 6.
- **`timer`** — `sleep(Duration)` and `timeout(Duration, future) -> Option<Output>`. Natively `tokio::time`; on wasm a `Promise` around the global `setTimeout`, read off the global object rather than `window` because the host is a Worker.
- **`files`** — plain functions (`open`, `write`, `remove`, `create_dir_all`, `entries`, `is_file`, `exists`) for code already off the async runtime, and `files::aio` (`Writer::{create, append, write_all, flush, sync_all, close}`, `len`, `read_to_string`, `write`, `remove`) for the download. **In a browser every one refuses** with `ErrorKind::Unsupported`, and the two questions answer `false`: the database there is OPFS behind SQLite's own VFS, and what a download looks like without a temp file is the web host's to decide (spec §6, phase 5).

Pacing, retry, the 429 lockout and the size checks stay in `scryfall::Client` — they are rules about Scryfall, not about a wire.

### The pacing gate without a runtime's mutex

`Client::next_api_slot` was `tokio::sync::Mutex<tokio::time::Instant>` and `await_slot` slept *until* it. It is `futures_util::lock::Mutex<(Tick, Duration)>` now — when the last request claimed its slot, and the gap its endpoint asks for — and `await_slot` sleeps for whatever of that gap has not yet passed. The same queue: the lock is still held across the sleep. `futures_util`'s mutex is not FIFO-fair where tokio's is; nothing depended on the order concurrent callers leave in, only on the spacing.

### The fence's fifth rule

`reqwest`, `tokio`, `std`'s `fs`, `thread`, `net`, `process` and `env`, and a disk asked through a path are refused outside `src/platform/` in **shipped** code — above a file's first column-0 `#[cfg(test)]` that gates a module, skipping files their parent declares behind a test gate. The existing rules sweep test code too; this one cannot, because a test of a download writes a file and `#[tokio::test]` is how an async test runs.

## Global Constraints

- **The desktop app must be unchanged.** No command is renamed, added or removed; `generate_handler!` is not edited; no SQL statement changes; no request the app sends changes — same URL, same headers, same pacing, same retries, same timeouts.
- **No schema rung, no DDL.**
- **No test is deleted or weakened.** `#[test]` and `#[tokio::test]` attributes are counted before and after, per crate.
- `grimoire-core` gains no `tauri`. `cfg(target_…)`, `SystemTime`, `Instant` — and now `reqwest`, `tokio`, `std::fs`, `std::thread` — appear only under its `src/platform/`. The fence is extended, never weakened.
- The `testing` feature stays off every host's `[dependencies]` line.
- **Never `cargo fmt --all`.**
- No agent deploys anything, and nothing here needs a deploy.
- Tests run once, at the end. Cargo is never run twice at once in this tree.

## Review Focus

- **A request that changed on the way through the wrapper.** The `User-Agent`, `Accept`, `If-None-Match` and `Range` headers; a status read as `u16` where it was a `StatusCode` (`is_server_error()` became `(500..600).contains`); `Retry-After` and `Content-Range` read through `Response::header`. `scryfall`'s 29 tests run against `httpmock` and assert headers and call counts; they moved unedited but for two clock reads.
- **The pacing gate.** `requests_are_paced_to_the_published_rate` is the test; the arithmetic is `gap.saturating_sub(claimed.elapsed())`.
- **The download's resume.** `create` truncates and `append` does not; the origin record is written after the truncate is durable; a `.close()` precedes the length check. Nine download tests, unedited.
- **A file call in `schema` that changed meaning.** `entries` drops a name that is not Unicode, as the old closure did; `remove` is `remove_file`; `exists` and `is_file` are the same questions.
- **The version.** A release pull request that bumps one manifest and not the other must go red.

---

## Part 5a — `platform/` and its first callers

### Task 1 — the three interfaces

**Files:** create `crates/grimoire-core/src/platform/{http,timer,files}.rs`; modify `platform/mod.rs`, `crates/grimoire-core/Cargo.toml`.

- [x] `http.rs`, `timer.rs`, `files.rs` as above, each with a native `imp` and a wasm `imp`.
- [x] The manifest: `reqwest` (one line, every target), `futures-util`, `bytes`; `tokio` natively (`fs`, `io-util`, `rt`, `time`); `wasm-bindgen` and `wasm-bindgen-futures` on wasm; `httpmock` and `tokio` (`macros`, `rt`) as dev-dependencies.
- [x] Tests: a file written, found, listed and removed; a download created, appended to and measured; a sleep that lasts; a deadline that ends a call.
- [x] `cargo check -p grimoire-core`, and the wasm build.

### Task 2 — `scryfall`, `ingest`, `reconcile`

- [x] `git mv` each to `crates/grimoire-core/src/`.
- [x] `scryfall`: every `reqwest`, `tokio` and `std::fs` call onto `platform`; `unix_now` and the retry jitter onto `platform::clock`; the two timed tests onto `Tick`. `unix_now` becomes `pub` — `desktop.rs` calls it.
- [x] `scryfall::BULK_ORACLE_TAGS` and `BULK_ART_TAGS` hold the strings; `tags::{oracle,art}::BULK_NAME` alias them. The alias pointed the other way while `tags` and `scryfall` were in one crate.
- [x] `ingest`: the file opened through `platform::files::open`. **One test stays** — `a_writer_gets_the_connection_between_batches_of_an_ingest` builds its database with `split::convert` — in `src-tauri/src/ingest/mod.rs`, with `gz_fixture` and `card_line` in a `pub mod fixtures` behind `testing` and `BATCH` made `pub`.
- [x] `reconcile`: no edit but one test import (`schema::fixtures::category`).
- [x] Both module maps.

### Task 3 — what earlier steps left behind

- [x] `errors::kind_of` and its test go to the core's `errors.rs`; `src-tauri/src/errors/mod.rs` is deleted and `lib.rs` re-exports the module whole.
- [x] `capture`'s two tests that drive `reconcile` go back into `capture.rs`, where they stood before step 2; `src-tauri/src/sync_engine/capture_tests.rs` is deleted.
- [x] `schema`'s eleven file calls go through `platform::files`.

### Task 4 — the fence, the version, the router

- [x] `fence.rs`: the fifth rule, its detector's own tests, and the derivation of test-only files.
- [x] The core's version to 0.39.0; `release-please-config.json`; `the_core_wears_the_apps_version`; the router's arm and its table row.

### Task 5 — verify

- [x] `cargo fmt -p mtg-grimoire -p grimoire-core`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo check -p mtg-grimoire --locked`.
- [x] The wasm build and its clippy. (It found one thing the desktop cannot: `drop(file)` on a writer that is a unit struct in a browser — `clippy::drop_non_drop`. Hence `Writer::close`.)
- [x] `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` prints no `testing`.
- [x] `cargo test --workspace`, in the foreground, once.
- [x] `npm run build`, `npm run lint`, `npm run test:run`.
- [x] An existing database upgraded by `main`'s binary and by this branch's, compared row for row.
- [x] `tauri dev` (the `app` lock): a real card sync against Scryfall — the check, the download with its progress, the ingest, the migration log — and an image fetch.
- [x] A fresh reviewer over the diff. **No behaviour change found; four things fixed**: the fence's cut (it stopped at a file's first `#[cfg(test)]`, which in four files gates one item far above the tests — about 3 500 shipped lines unread), the same cut in `scripts/coverage-rust.mjs`, an assertion that depended on directory order, and the shapes the rule walked past (`pub(crate) use std::{…}`, a glob, `path.is_file()`, `std::net`, `std::process`, `std::env`). And the browser arms' docs: CORS is unmeasured, a browser's `Tick` is the wall clock, `setTimeout` rounds up now.

### Task 6 — the record, and ship

- [x] `docs/reference/light-app.md` §6.5; `crates/grimoire-core/CLAUDE.md`; `src-tauri/CLAUDE.md`; the spec's §2.5 and §2.8 notes.
- [ ] The pull request, linked to #761, auto-merge and auto-fix armed; the issue updated.

---

## Part 5b — the state, the facet index and the card sync

Measured on this branch's tree over `main` at `4b0bb2d3` (part 5a merged, #768).

### What was read first

`src-tauri/src/sync.rs` is 1 899 lines: 51 items and a test module of 26. Of the 51, **seven name the desktop and nothing else does** — `AppState` and its `Deref`, four lock helpers every desktop module calls, and `status` — but nine more take a `tauri::AppHandle` for one purpose: to emit. `index/lifecycle.rs` takes `&AppState` throughout and names nothing of the desktop's; `index/facets.rs` has one command at its foot; `index/mod.rs` has a fixture that builds a whole `AppState` on a file `split` converted.

So this part is a move with a rewrite inside it, and the rewrite is small and regular: a window becomes the state's event sink, an `Arc<AppState>` becomes an `Arc<State>`, and tauri's blocking pool becomes `platform::spawn`.

### Decisions

- **`run_sync(state: Arc<State>, force)`.** No window. `sync:progress` and `collection:reconciled` leave through `state.events`; the desktop's sink forwards both to every window, as `app.emit` did. Same names, same payloads.
- **`State` gains `syncing`, `client` and `index`**, and `State::new` a sixth argument: the client, which the host builds — where the API lives and what 429 lockout an earlier run earned are the host's to know.
- **`AppState.core` is an `Arc<State>`.** A sync and an index build each outlive the call that starts them, and the engine cannot be handed an `Arc<AppState>`. `AppState` still derefs to `State`, so `state.client`, `state.syncing` and `state.index` read as they did at every site that does not need the `Arc`.
- **`platform::spawn`**: `blocking(f).await` and `background(f)`. Natively the async runtime's blocking pool and a thread. **In a browser both run the work where it stands** — a Worker has one thread, and deferring to a microtask would only move the block while letting a caller think it had been taken off them.
- **The mirror hears a swap as an observer.** `WriteObserver` gains `corpus_replaced` (default: nothing); `State` keeps the list it was built with and `State::corpus_replaced()` tells each once. `do_sync` calls it where it called `note_mirror_after_swap`. The alternative was an event name the desktop's sink intercepts, which would have put a mirror rule in a function called "emit".
- **`status` stays**, alone: it reads `images.store_failures()`, and the image cache is 5c's. Nothing hoisted, no argument added for the next part to delete.
- **The core gets its own index fixture.** `state_with_seeded_cards` over a `State`, on a file pair built at head by a new `schema::build_pair` — `memory_pair`'s second half, on a connection somebody else opened. The desktop's copy, over an `AppState` through `split::convert`, goes: every test that called it moved.
- **The script touches no git state.** It decides everything, checks every replacement, then writes and removes files. An earlier draft ran `git mv` first and reset the index after; a run that stopped between the two left a tree its own guard called finished.

### Tasks

- [x] `platform/spawn.rs`, with its tests: work answered from another thread; a panic that is lost and says so; a background job joined.
- [x] `scripts/core-step-5b.mjs`: `sync.rs` and the three index files split item by item (`scripts/lib/rs-items.mjs`), every rewrite an exact replacement that must match the number of times it says; `with_write_owned` and two tests home; `ipc.test.ts`'s `?raw` import of `facets.rs` as both halves. `--dry` first.
- [x] By hand, in the same commit: `hooks.rs` (`corpus_replaced`), `state.rs` (three fields, the sixth argument, `corpus_replaced()`, a test), `schema.rs` (`build_pair`), both module maps, `desktop.rs` (`init_state`, `sync_run`, the startup sync, `spawn_build`), `mirror/watch.rs` (the observer and its test), and the six other tests that build an `AppState`.
- [x] From a clean tree, the script and the hand edits reproduce the committed tree: the same diff, hashed.
- [x] Item by item, old against new: of `sync.rs`'s 78 items and tests, 56 identical and 21 changed — each on the replacement list — and one gone (`note_mirror_after_swap`).
- [x] `cargo fmt`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo check -p mtg-grimoire`; the wasm build and its clippy; the fence.
- [x] `#[test]` and `#[tokio::test]` attributes: 3 393 before, 3 394 after — 94 moved to the core, one new.
- [x] `cargo test --workspace`.
- [x] `npm run build`, `npm run lint`, `npm run test:run`.
- [x] An existing database upgraded by `main`'s binary and by this branch's, compared row for row.
- [x] `tauri dev`: a real sync with its progress events read in the page; the facet index cold, then ready; an owned facet after a collection write; the mirror's pass after a swap.
- [x] A fresh reviewer over the diff — and what it found, fixed: `blocking` started at its first poll rather than at the call; a desktop fixture nothing called; the script's git phase; nine comments the move made false.
- [x] `sync/run_tests.rs`: `run_sync` end to end against a mock Scryfall, which nothing could do while it took a window — a first sync and the 304 after it, a sync that repoints a copy, a download refused.
- [x] The record, the pull request, the issue.

## Part 5c — the feeds and the image cache

- **Three feeds keep three clients.** `combos` and `marketplace_feed` each build their own `platform::http::Client`; `tags/` shares Scryfall's, pacing gate and lockout included.
- **The feeds' temp files and the image cache's files go through `platform::files`**, which grows what they call — a rename, a modified time — with them.
- **`images::Cache` joins `State`**; the `mtgimg://` protocol handler stays the desktop's.
- **`deck::bracket_reads`, `reset::clear_cache` and the tests that name `images`, `index::fixtures` or `tags::query` go home.**

## What step 6 inherits

`AppState.pairing`; `sync_pair::{identity, pairing}`; `sync_engine::{wire, client, entitlement, live, schedule, commands}`; the first `POST` on `platform::http`; and the two `#[cfg(not(test))]` sites in `entitlement.rs` and `client.rs`.
