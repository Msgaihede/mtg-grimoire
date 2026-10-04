# grimoire-core — the engine with no window

The shared Rust core linked by all three application hosts: the desktop host (`src-tauri`), the light app's Android host (`mobile/src-tauri`), and the WebAssembly web host (`crates/grimoire-web`). It contains domain logic, database engines (`user.db` and `corpus.db`), sync infrastructure, and platform abstractions (see [the light-app spec](../../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md) §2 and reference [light-app.md](../../docs/reference/light-app.md)).

For global repo workflow, style, and testing conventions, refer to:
- [Workflow & Commits](../../docs/agent/WORKFLOW.md)
- [Code Style](../../docs/agent/CODE_STYLE.md)
- [Verification Guide](../../docs/agent/RUNNING_AND_VERIFYING.md)

---

## 1. Command Wrapper Separation

- **No `#[tauri::command]` in this crate**: Desktop wrappers remain in `src-tauri/src/<module>/mod.rs`, which re-exports core items via `pub use grimoire_core::<module>::*;`.
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
| **No raw I/O or threading outside `src/platform/`** (`reqwest`, `tokio`, `std::fs`, `thread`, `net`, `process`, `env`, or path queries like `.exists()`) | Swept across all shipped code; tests placed at foot of files |
| **Multi-target compilation** | CI verifies `x86_64-pc-windows-msvc`, `aarch64-linux-android`, and `wasm32-unknown-unknown` |

---

## 3. Platform Abstractions (`src/platform/`)

All OS- and environment-specific behaviors are isolated behind `platform/`:

- **Clock (`platform::clock`)**:
  - `Tick`: Monotonic duration tracking via `Instant` (native) or `performance.now()` (browser microsecond precision).
  - `Wall`: Persistent wall-clock timestamps in milliseconds since epoch.
- **Timer (`platform::timer`)**: `sleep`, `timeout`, and `yield_to_host` (posts message across `MessageChannel` in browser). Streaming loops use `Breather` with `feed::WORK_BUDGET` (50 ms) to avoid starving host IPC.
- **Pause (`platform::pause`)**: `thread::sleep` on native; immediately returns `false` on single-threaded browser workers.
- **HTTP (`platform::http`)**: Host-agnostic `Client`, `Request`, and `Response`. Native uses reqwest/rustls; browser uses `fetch`. No `reqwest` types leak outside `platform::http`.
- **Files (`platform::files`)**: Native wraps `std::fs`/`tokio::fs`. Browser immediately returns `ErrorKind::Unsupported` (storage relies on SQLite OPFS VFS).
- **Sync (`platform::sync`)**: `Semaphore`, `Lock`, and `Shared<T>` providing FIFO fairness across async tasks.
- **Spawning (`platform::spawn`)**: `blocking` and `background`. Runs on thread pool natively; runs inline on single-threaded browser workers.
- **Alone (`platform::alone`)**: Native test harness enabling single-threaded browser execution semantics to detect re-entrancy and deadlocks.

---

## 4. State, Connections, and Hook Lifecycle

- **Opening databases**:
  - Native/Android: `launch::open(data_dir)` opens write and read connections on disk.
  - Browser/WASM: `launch::open_single(databases, data_dir)` or `open_single_replacing` opens a single connection (`temp_store = FILE`) over OPFS.
- **Single-connection safety**: On single-connection hosts, `read` is `None` and read requests take the write connection mutex. Any attempt to read while holding a write lock deadlocks/panics. Verified by `commands::tests::every_command_answers_on_one_connection_and_one_thread`.
- **Hook installation**: Installed exclusively via `State::new` (`hooks::install`). Observers (`WriteObserver`) are notified in strict order inside SQLite commit/update hooks.
- **Corpus recovery**: Damaged or unmigratable corpus databases are dropped and recreated via `launch::open_single_replacing`; `user.db` is never touched.

---

## 5. Command Table & Dispatch (`src/commands.rs`)

For hosts without Tauri macro dispatch (Android `core_call` and WASM `call`):
- Macro `commands! { ... }` generates the dispatch table `TABLE` and `grimoire_core::dispatch`.
- Matches desktop command names and accepts camelCase JSON parameters (`rename_all = "camelCase"`).
- Six execution categories: `read`, `write`, `owned`, `blocking`, `task`, `bytes`.
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
- **Scanner integration**: `crates/card-scanner` is linked across all targets; link-time optimization (LTO) strips OCR runtime code from WASM builds.

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

Commit discipline:
- One commit per feature matching feature size, combining changes, tests, and docs for `release-please`.
