# grimoire-core — the engine with no window

The shared Rust core linked by all three application hosts: the desktop host (`apps/desktop/src-tauri`), the light app's Android host (`apps/light/src-tauri`), and the WebAssembly web host (`crates/grimoire-web`). It contains domain logic, database engines (`user.db` and `corpus.db`), sync infrastructure, and platform abstractions (see [the light-app spec](../../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md) §2, reference [grimoire-core.md](../../docs/reference/grimoire-core.md), and [light-app.md](../../docs/reference/light-app.md)).

For global repo workflow, style, and testing conventions, refer to:
- [Workflow & Commits](../../docs/agent/WORKFLOW.md)
- [Code Style](../../docs/agent/CODE_STYLE.md)
- [Verification Guide](../../docs/agent/RUNNING_AND_VERIFYING.md)

---

## 1. Command Wrapper Separation

- **No `#[tauri::command]` in this crate**: Desktop wrappers remain in `apps/desktop/src-tauri/src/<module>/mod.rs`, which re-exports core items via `pub use grimoire_core::<module>::*;`.
- **Core function contract**: Functions here accept `&Connection` (or `&State`) and return plain DTOs or `Result<T, E>`. They must be `pub` to cross module re-exports.
- **Write functions**: Core write logic takes `&Connection`. Host callers wrap calls in `state::with_write` or `state::with_write_owned` to ensure trigger arming, token reconciliation, and change log settlement.

---

## 2. Five Architectural Fences

Enforced by `platform::fence` across the codebase:

| Rule | Enforcement |
| --- | --- |
| **No `tauri` dependency** (or wry, tao, tauri plugins) | `platform::fence` checks `Cargo.toml` |
| **Platform cfg gates strictly localized** (`cfg(target_*)`, `cfg(windows)`, `cfg(unix)`) | Permitted only under `src/platform/` |
| **No raw time primitives outside `src/platform/`** (`SystemTime`, `UNIX_EPOCH`, `Instant`) | Swept by `platform::fence`; use `platform::clock` or SQLite `unixepoch()` |
| **No raw I/O or threading outside `src/platform/`** (`reqwest`, `tokio`, `tokio_tungstenite`/`tungstenite`, `std::fs`, `thread`, `net`, `process`, `env`, or path queries like `.exists()`) | Swept across all shipped code; tests placed at foot of files |
| **Multi-target compilation** | CI verifies `x86_64-pc-windows-msvc`, `aarch64-linux-android`, and `wasm32-unknown-unknown` |

---

## 3. Platform Abstractions (`src/platform/`)

All OS- and environment-specific behaviors are isolated behind `platform/`:

- **Clock (`platform::clock`)**:
  - `Tick`: Monotonic duration tracking via `Instant` (native) or `performance.now()` (browser microsecond precision).
  - `Wall`: Persistent wall-clock timestamps in milliseconds since epoch.
  - `monotonic_ms()`: a `Tick` as a plain function. `ScannerState::new` installs it as `card-scanner`'s clock (`card_scanner::host::set_clock`), which has none of its own in a browser.
- **Timer (`platform::timer`)**: `sleep`, `timeout`, `interval` (first tick at once, then one per period on a monotonic grid; beats missed outright are dropped, never taken back to back), and `yield_to_host` (posts message across `MessageChannel` in browser). Streaming loops use `Breather` with `feed::WORK_BUDGET` (50 ms) to avoid starving host IPC.
- **Pause (`platform::pause`)**: `thread::sleep` on native; immediately returns `false` on single-threaded browser workers.
- **HTTP (`platform::http`)**: Host-agnostic `Client`, `Request`, and `Response`. Native uses reqwest/rustls; browser uses `fetch`. No `reqwest` types leak outside `platform::http`.
- **Files (`platform::files`)**: Native wraps `std::fs`/`tokio::fs`. Browser immediately returns `ErrorKind::Unsupported` (storage relies on SQLite OPFS VFS).
- **Socket (`platform::socket`)**: The relay's doorbell WebSocket — `connect(url, bearer)`, `Socket::next() -> Event::{Text, Closed(code), Failed}`, `Socket::keepalive()`, and `ws_origin`. Native (desktop and Android) uses `tokio-tungstenite` over rustls with compiled-in roots, the bearer in the upgrade's `Authorization` header and a protocol ping — and `keepalive` fails when the previous ping got no pong from a peer that has ponged before (never from one that has never ponged), which is how a half-open socket is noticed. The browser arm is the Worker's own `WebSocket`, reached through `js_sys::Reflect` off the global (no `web-sys`): the bearer in a sub-protocol (`grimoire.live.v1` and `bearer.<token>`), four event handlers feeding a queue `next()` drains, and the text frame `ping` held to the same rule by the text `pong` — swallowed, never handed to a caller. What that arm decides is the `heard` module, compiled for tests too, so native `cargo test` covers it; a refused upgrade is one generic sentence, because a browser gives a page no reason. No `tungstenite` type leaks outside the module.
- **Sync (`platform::sync`)**: `Semaphore`, `Lock`, and `Shared<T>` providing FIFO fairness across async tasks; `Bell`, a wake that keeps one ring when nobody is waiting (`notify_one`, never `notify_waiters`).
- **Spawning (`platform::spawn`)**: `blocking`, `background`, and `on_a_worker` (an async operation whose stretches block — a sync trip — driven on a pool thread by a runtime of its own). Runs on thread pool natively; runs inline on single-threaded browser workers.
- **Alone (`platform::alone`)**: Native test harness enabling single-threaded browser execution semantics to detect re-entrancy and deadlocks.

---

## 4. State, Connections, and Hook Lifecycle

- **Opening databases**:
  - Native/Android: `launch::open(data_dir)` opens write and read connections on disk.
  - Browser/WASM: `launch::open_single(databases, data_dir)` or `open_single_replacing` opens a single connection (`temp_store = FILE`) over OPFS.
- **Single-connection safety**: On single-connection hosts, `read` is `None` and read requests take the write connection mutex. Any attempt to read while holding a write lock deadlocks/panics. Verified by `commands::tests::every_command_answers_on_one_connection_and_one_thread`.
- **Hook installation**: Installed exclusively via `State::new` (`hooks::install`). Observers (`WriteObserver`) are notified in strict order inside SQLite commit/update hooks.
- **Live sync (`sync_engine::live`)**: The connection manager is the core's: `live::run(state, writes)` is a future a **host spawns** after its launch settles, with the `Bell` it registered on the write connection as a `live::WriteWake` observer. All three hosts run it — the web host on its Worker's one thread, where every read and trip runs where it stands on the one connection. It speaks through `state.events` (`sync:live`, `sync:applied`), and `sync_live_state` is a table command. A socket is its group's: the loop re-reads `sync_group` on the write wake (on the write connection, behind the commit) and on each keepalive, and lets go (`Disconnect::Left`: no backoff, no row) when the device has left, been removed or changed group. The relay's two closes are two codes (`schedule::gone`): 4002, off a rotation's manifest — a removal, one row, unless the device itself just left; 4001, a dropped group — a backoff and **never a row**. A dial is bounded by `CONNECT_SECS`, with one last turn of the host before it gives up (`timer::timeout_after_a_last_turn`). Failures are recorded unless the membership lapsed — `!commands::entitled && membership_ended`, never the second alone. **A group nobody has connected is a wait, not a failure** (issue #1120): a trip whose key check the relay refuses (`client::UNRECOGNISED_GROUP`, compared, never matched) on a device `entitlement::never_entitled` (no refresh secret, no status) writes no row — neither the loop's nor the key check's — says `off`, dials nothing, and asks again after `UNCLAIMED_POLL` (10 min), or sooner when a local look every `IDLE_POLL` finds the device entitled or out of that group.
- **Corpus recovery**: Damaged or unmigratable corpus databases are dropped and recreated via `launch::open_single_replacing`; `user.db` is never touched.

---

## 5. Command Table & Dispatch (`src/commands.rs`)

For hosts without Tauri macro dispatch (Android `core_call` and WASM `call`):
- Macro `commands! { ... }` generates the dispatch table `TABLE` and `grimoire_core::dispatch`.
- Matches desktop command names and accepts camelCase JSON parameters (`rename_all = "camelCase"`).
- Six execution categories: `read`, `write`, `owned`, `blocking`, `task`, `bytes`.
- **`bytes` is the raw-body kind, and the scanner's frame and capture are its two entries** (`scanner_frame`, `scanner_capture`; pinned by `commands::tests::the_commands_that_carry_a_raw_body_are_the_scanners_two`). The call's **arguments object is the headers** a desktop request would have carried — `{}` for a frame, which is the JPEG alone, and `{"x-scanner-capture": "<json>"}` for a capture — handed to the body whole as a `commands::Carried`; the body itself arrives as `Some(Vec<u8>)` however the host carried it (base64 on Android, a transferred buffer in a browser). A new `bytes` entry also needs a row on the desktop host's `command_table::RAW_BODY` (`apps/desktop/src-tauri`).
- **A table call holds the scanner's lease as `scanner::PAGE`**: a host of the table has exactly one page, so `scanner_elsewhere` answers `false` there and `scanner_hold` always succeeds. An entry that admits is `blocking` or `bytes`, never `write`/`owned` — the lease is taken before the write connection is waited for. The desktop never dispatches scanner commands through the table (its wrappers admit the webview's own label).
- Non-desktop command exception: `card_image_source` is registered exclusively in the table for web service worker image resolution (`TABLE_ONLY`).

---

## 6. Image Cache Contract (`src/images.rs`)

- Manages caching policies, allowlists, and key queues independently of host GUI libraries.
- `images::answer(&State, path)` resolves requests into host-agnostic `Reply` values.
- `images::image_source(conn, path)` resolves Scryfall URIs or placeholders for web service workers without executing fetches.
- Upkeep loop (`images::upkeep_tick`) is driven by native host threads; browser environments execute no upkeep loop.

---

## 7. Cargo Manifest & Dependency Rules

- **Version alignment**: Package version must mirror app release; used by native Scryfall `User-Agent`.
- **Testing feature**: Scaffolding gated under `#[cfg(any(test, feature = "testing"))]`. Never include `testing` in `[dependencies]`; it belongs solely in `[dev-dependencies]`.
- **SQLite bindings**: `rusqlite` uses `bundled` + `hooks` on native; WASM uses `hooks` alone (never set `default-features = false`).
- **Tokio scoping**: Tokio runtime dependencies are restricted to native targets (only `tokio::sync` is permitted on WASM).
- **Scanner integration**: `crates/card-scanner` (feature `corpus`) and `crates/card-neural` (feature `bundled`, the model files compiled in for the native hosts) are linked across all targets; link-time optimization (LTO) strips the session and the recogniser from WASM builds, where they are reached only through doors shut on a page (§7a). The crate's clock and panic guard sit behind its own `host` module, which has nothing to spawn and reads no clock on a one-thread host ([card-scanner.md](../../docs/reference/card-scanner.md) §11).

---

## 7a. Scanner Commands (`src/scanner.rs`)

- **One implementation, two callers.** The session's doors are methods of `ScannerState` (`status`, `frame`, `reset`, `set_filters`, `capture`), the four writes are `save_prefs`, `save_tray`, `commit_tray` and `archive_tray` (the last two also record a scan-history batch, `src/scan_history.rs`), and a frame or a capture is read out of a body by `frame_from` / `capture_from` over a header lookup (`Header`: absent, text, or there and unreadable). The command table calls them admitting `PAGE`; the desktop host's wrappers (`apps/desktop/src-tauri`) call them admitting the webview's label. Change a scanner command here, never in a host.
- **Refused on a page, in one sentence, from one helper**: `not_in_a_browser_yet()` (`NOT_IN_A_BROWSER_YET`) is asked by `ScannerState::ensure` — the one door to the session — and by `capture`. **A backstop since step 7.5**: a browser's session is a Worker and a module of its own (`crates/grimoire-scan`) and the web host answers these commands on the page, in front of this table — a session here would put a panic in the instance that holds the databases. Prefs, tray, the commit and the lease answer on a page. **The refusal is also what keeps the session and the recogniser out of the web module** (a constant on `wasm32`) — **in an ordinary function only**: an `async fn`'s later states stay linked whatever its first line returns (measured, +2.93 MB), so no async door may reach the session.
- **The recogniser's files are built in or absent** (`Embedded::neural` and `Embedded::neural_evidence`, from `card_neural::bundled()` / `bundled_evidence()` on the desktop and Android): no file in `data/scanner/` overrides them and nothing downloads them. `ScannerStatus` is `{ neural, labels, scans_dir, unapplied_filters }` (mirrored in `packages/ui/lib/ipc.ts`); the labels still load from `corpus.db`. There is no hash bundle, no OCR model and no asset download since 2026-10-24 (the Fast and Exact modes were removed; the Neural scanner is the only one).
- **A frame is the JPEG body alone**: no options header and no detail frame. `x-scanner-capture` (`CAPTURE_HEADER`, the capture's sidecar) is the one scanner header. `ScannerPrefs` has no `mode`; a stored row that still carries one parses, the key ignored.

## 7c. Sending a Scan (`src/scanner_submit.rs`)

- **One command, `scanner_submit` (`submit`), and the only code here that sends a picture off the device**: one scan — the last couple of seconds of frames the scanner was given, kept at full resolution up to 1920 px wide — and the printing and finish a reader chose for them, or `None` for both where the reader said there is no card (`HALF_AN_ANSWER` refuses one without the other), posted to the scan inbox (`infrastructure/scan-worker/`, `SCAN_BASE`). Its one caller is a reader's press on Send; nothing runs it on a launch, a schedule or a frame, and it takes no lease.
- **Sending a scan is a supporter's** (the owner's decision, 2026-10-11). `submit` asks `sync_engine::commands::entitled` first and refuses any other device with `NOT_ON` before it reads a picture; then, with the run and its label built, it takes the relay's token through the sync lane (`entitlement::access_token` over `lane_for_press`) and sends it as `authorization: Bearer …`, which the inbox verifies with the relay's key. A token that cannot be had is `UNCONFIRMED`; one the inbox will not take (401 or 403) is `NOT_ACCEPTED`. ⚠️ **None of the three may name a membership, a supporter or a way to become one**, and the relay's own error text is never passed on: the light app's Play build shows these sentences, and its host rewords only `sync_` commands' errors. `no_sentence_a_reader_is_shown_names_a_membership` holds every sentence in the file to it.
- **A scan is a run of frames, never one picture** — the owner's rule, *all the frames or nothing at all*. `pictures` takes `MIN_RUN_FRAMES..=MAX_RUN_FRAMES` frames inside `MAX_RUN_BYTES`, or refuses the whole submission in one sentence: too short to be a run (`TOO_SHORT`), too long or too heavy (`TOO_LARGE`), or holding one frame that is not a JPEG (`NOT_A_PICTURE`). It never trims a run to fit and never sends around a hole — what the reader was shown is what is sent. **Do not add a path that sends a single still**; the inbox refuses one too.
- **A `task`, with the pictures base64 inside its one argument** — not a third `bytes` entry: a `bytes` body runs on the blocking pool, where a request cannot be awaited. It answers on a page as on any host (the inbox answers the web app's origin; the hosting policy's `connect-src` names it).
- **The page sends an id, a finish, the frames and the scanner's figures; the engine supplies the facts.** `label_for` reads the printing's name, set, number and language from `cards` and refuses a printing these cards lack and a finish it is not made in; each frame's length and size are read from its own JPEG header. The figures — the press's and each frame's, and the filters — are tidied (`tidy_*`) and are never a reason to refuse. Every refusal is one sentence and is made before any request.
- **`Label` is a wire to another deploy**, sent as ASCII JSON in the `x-scan-label` header and bounded by `MAX_LABEL_CHARS`; the body is the frames end to end as `application/octet-stream`, and `Label.run` — one entry a frame, oldest first — is its only index. `scan-worker`'s `label.test.ts` and `wrangler.test.ts` read this file for its six label structs, `LABEL_VERSION`, `SCAN_BASE`, the three run bounds, `MAX_LABEL_CHARS`, `MAX_FILTER_SETS`, `LABEL_HEADER`, the content type and the two refusal codes; `packages/ui/lib/ipc.test.ts` holds the page's `RUN_*` bounds to the same three; and `src/__golden__/scan-label.txt` (with `scan-label-no-card.txt`, the same header with no card) is one header both suites hold the text of — change either side in one commit. `reported` and a frame's `decided` are a *decided printing* or absent, never a standing's oracle id. **Nothing in a label may say who sent it** (the privacy policy promises it); a new field owes that page a sentence.
- The inbox's refusals are reworded for a reader by status or `code`, never by its sentence. `SCAN_URL` is a `sync_state` override with no UI, for tests and `wrangler dev --local`.

---

## 8. Build, Test, and Verification Commands

Execute tests only at the end of feature implementation:

| Command | Action |
| --- | --- |
| `cargo test -p grimoire-core` | Run native core unit and integration tests |
| `cargo test -p grimoire-core <module>::` | Run focused module tests (e.g. `schema::`, `deck::`, `sync::`) |
| `cargo check -p grimoire-core --locked` | Validate release build compilation |
| `cargo fmt -p grimoire-core` | Format crate (never run `cargo fmt --all`) |

WASM compilation check (requires LLVM/clang 18+):
```bash
CC_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/clang.exe" AR_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/llvm-ar.exe" cargo build --lib -p grimoire-core --target wasm32-unknown-unknown
```
