# Grimoire Core Engine

The headless Rust engine shared by every host:
- The desktop app in `src-tauri`
- The light app's Android host in `mobile/src-tauri`
- The web host in `crates/grimoire-web` (compiled to WASM in a dedicated Web Worker)

The design is [the light-app spec](../superpowers/specs/2026-10-01-light-app-android-and-web-design.md) §2;
the step-by-step extraction record is in [light-app.md](light-app.md) §6.

---

## The Five Hard Rules

These invariants preserve portability across desktop, Android, and WASM. They are enforced by `platform::fence` and CI:

| Rule | Enforced by | Rationale |
| :--- | :--- | :--- |
| **No `tauri` dependency** — not the crate, its build script, plugins, `wry`, or `tao`. | `platform::fence` (reads `Cargo.toml`) | The core is headless and must compile for headless targets (WASM, Android services). |
| **Target CFGs only under `src/platform/`** — `cfg(target_…)`, `cfg(windows)`, and `cfg(unix)` appear nowhere else. | `platform::fence` (scans all source files) | Platform branching is strictly quarantined in `src/platform/`. Domain modules must remain platform-agnostic. |
| **No `SystemTime`, `UNIX_EPOCH`, or `std::time::Instant` outside `src/platform/`**. | `platform::fence` (scans all source files) | Reading standard clocks compiles cleanly on `wasm32-unknown-unknown` but panics at runtime. Time must come from `platform::clock` (`Tick::now()`, `elapsed()`) or SQLite. |
| **No `reqwest`, `tokio`, `tokio_tungstenite`/`tungstenite`, or `std`'s `fs`, `thread`, `net`, `process`, or `env` outside `src/platform/` in shipped code**. No direct disk checks (`.exists()`, `.is_file()`, `.metadata()`). | `platform::fence` (scans shipped code) | I/O, threads, and files have host-specific implementations in `src/platform/`. Domain code never touches the OS directly. |
| **Compiles clean for all three targets**: `x86_64-pc-windows-msvc`, `aarch64-linux-android`, and `wasm32-unknown-unknown`. | CI (`core` and `rust` jobs) | Every change must build across desktop, mobile, and browser targets. |

---

## AST & Regex Fence Mechanics (`platform::fence`)

The compile fence is implemented in `crates/grimoire-core/src/platform/fence.rs` and runs during test sweeps:

1. **Comment Parsing**:
   - The fence reads lines of code and skips comments.
   - A line is recognized as a comment **only when it starts with `//`**.
   - Trailing comments (`let x = 1; // comment`) and `/* … */` block comments are read as code. Do not put forbidden symbol names in block comments or trailing comments.

2. **Test Code Sweeps**:
   - The fence checks test code for target gates and standard clocks.
   - Even though tests run only on desktop hosts, `platform::fence` does not exempt test code from clock and target-cfg rules: test timing must use `platform::clock` (`Tick::now()`) or SQLite.

3. **Shipped Code vs Test Module Boundary**:
   - The I/O rule (forbidding `std::fs`, `tokio`, etc.) cuts at the file's **first column-0 `#[cfg(test)]` that gates a module** (`mod tests { ... }`).
   - Everything above that line is audited as shipped code. Everything below is treated as test code and may use `tokio::test`, write scratch files, etc.
   - **Crucial Rule**: Shipped code and domain functions must **never** be placed below test code. A test helper function or test gate over a single item higher up in the file is *not* recognized as the module cut — placing a single `#[cfg(test)]` helper at top or middle will cause everything below it to be audited as shipped code.

---

## Platform Abstractions (`src/platform/`)

All I/O operations go through abstractions defined in `src/platform/`:

- **HTTP Requests (`platform::request`)**:
  - Desktop / Android: Powered by `reqwest` on background threads.
  - WASM: Handled via `web-sys::fetch` through the browser runtime.
- **Clocks & Timers (`platform::clock`, `platform::timer`)**:
  - `platform::clock`: High-resolution monotonic tick (`Tick::now()`, `Tick::elapsed()`).
  - `platform::timer::sleep`: Non-blocking async sleep.
  - `platform::timer::yield_to_host`: Cooperatively yields execution back to the host event loop (vital on single-threaded WASM to avoid starving incoming messages).
- **Filesystem & Storage (`platform::files`)**:
  - Desktop / Android: Traditional filesystem paths (`data/`, app data dir).
  - Web: Origin Private File System (OPFS) pools accessed via Web Worker sync access handles.
- **Background Tasks & Threading (`platform::threads`)**:
  - Desktop: Standard worker threads and Tokio runtime.
  - Web: Single-threaded async cooperative tasks.
- **The relay's live socket (`platform::socket`)**:
  - Desktop / Android: `tokio-tungstenite` over rustls with compiled-in roots; the bearer rides the upgrade's `Authorization` header and the keepalive is a protocol ping, which fails when the one before it got no pong from a peer that has ponged before (a half-open socket is noticed within two ping periods; a peer that never pongs is never failed this way).
  - Web: the engine Worker's own `WebSocket`, reached through `js_sys::Reflect`; the bearer rides a sub-protocol (`grimoire.live.v1` and `bearer.<token>`), its four events feed a queue `next()` drains, and the keepalive is the text frame `ping`, held to the same rule by the text `pong`, which no caller is handed. The arm's decisions are a module native tests reach (`heard`).
  - Its one caller is `sync_engine::live::run`, the connection manager — a future each host spawns itself: the desktop, Android and, since step 6.3, the web host. See [sync.md](sync.md), "The connection manager, too".

---

## State, Hooks, and Events

1. **State Holder (`state::Store`)**:
   - Headless state container holding connections, cache references, and operational flags.
   - Free of window handles or UI references.

2. **Host Hooks (`Hook` trait)**:
   - Hosts register lifecycle hooks (e.g. notifications when database writes finish or cache clears occur).

3. **Event Forwarding (`state.events`)**:
   - The core emits progress and lifecycle events (`sync:progress`, `collection:reconciled`, live sync's `sync:live` and `sync:applied`, and `scanner:assets` while the scanner's files are being fetched) through `state.events`.
   - Host adapters (such as `desktop::WindowEvents`) forward these to active frontend windows.

---

## Command Dispatch Table (`commands!` and `dispatch`)

- The central command router is declared via the `commands!` macro in `crates/grimoire-core/src/commands.rs`.
- `grimoire_core::dispatch(name, args, body)`:
  - Takes the desktop command name, JSON argument string, and optional binary payload.
  - Matches the command against the static dispatch table.
  - Returns `Result<String, String>` (JSON response or error sentence).
- Hosts (such as `grimoire-web`) delegate their command handling directly to `grimoire_core::dispatch`.

### The `bytes` kind — a raw body, and its headers as the arguments

Six kinds decide where a command's body runs (`read`, `write`, `owned`, `blocking`, `task`, `bytes`). `bytes` is the one whose call carries a raw body, and since the light app's step 7.3 (2026-10-07) two entries use it: **`scanner_frame`** and **`scanner_capture`**.

- **The body** is the JPEG — or, for a frame, the frame and its detail image back to back. It reaches `dispatch` as `Some(Vec<u8>)` whichever way the host carried it: Android's `core_call` takes it as base64 text in `body` (Tauri accepts no raw body there) and decodes it; the web host's Worker is handed a transferred buffer.
- **The arguments are the headers.** On the desktop a frame's options, its detail length and a capture's sidecar ride in three request headers. A host of the table has none to send, so the page sends the same object as the call's arguments — `{"x-scanner-options": "<json>", "x-scanner-detail": "<n>"}`, `{"x-scanner-capture": "<json>"}` (`src/lib/core/table.ts`, `src/lib/core/web/protocol.ts`). The `bytes` arm hands that object to the body unparsed, as a `commands::Carried`; `scanner::frame_from` and `capture_from` read it through the same `Header` lookup the desktop fills from Tauri's `HeaderMap`. One reader, so the sentences agree: an options header that does not parse is the defaults, a detail length or a sidecar that is there and wrong is a refusal.
- **Refusals at the door**: a `bytes` command called with no body answers `<name> needs a raw body.` (which is also what a call with its bytes in the JSON hears), and every other kind refuses a body it was sent.
- **The fence**: `commands::tests::the_commands_that_carry_a_raw_body_are_the_scanners_two` pins the list, and `src-tauri`'s `command_table::RAW_BODY` holds each to a desktop wrapper that takes the raw `tauri::ipc::Request` — the one wire the argument-parity test cannot see.

### The scanner's lease on a table call — `scanner::PAGE`

Every scanner command that uses the session or writes the prefs or the tray admits a **label** on the scanner's lease (`scanner::LEASE`, two seconds; [card-scanner.md](card-scanner.md) §9, "One window scans at a time"). The desktop's wrappers pass the calling webview's label. A table call carries no window, and needs none: a host of the table has exactly one page (Android's one window; the web host's Web Lock against a second tab), so every entry admits the constant **`scanner::PAGE`** (`"page"`). There, `scanner_elsewhere` is always `false` and `scanner_hold` always succeeds. The desktop does not dispatch through the table; were it to, it would have to carry a label first.

### Refused on a page — `scanner::not_in_a_browser_yet`

The web host dispatches through the same table, and the `card-scanner` crate's threads and `Instant` trap in a browser. So the commands that load or run the session — `scanner_status`, `scanner_frame`, `scanner_reset`, `scanner_set_filters` — and `scanner_capture`, which writes files, answer `scanner::NOT_IN_A_BROWSER_YET` on a host where `platform::host::keeps_files()` is false, from one helper asked at `ScannerState::ensure` and `ScannerState::capture`. The prefs, the tray, the tray's commit and the lease's two commands answer on a page. The light app's web step deletes the helper.

### The scanner's files — `scanner_assets` and `scanner_assets_fetch`

Two more table entries since the light app's step 7.4 (2026-10-07), from `crates/grimoire-core/src/scanner_assets.rs`. Neither takes an argument, a body or the scanner's lease.

- **`scanner_assets`** (`blocking`) answers `Owed { owed, bytes, fetching }`: the files this install lacks as `downloads::Due` rows (`key` one of `bundle`, `detectionModel`, `recognitionModel`), their total, and whether a fetch is running. It reads the status, so its first ask loads the session. Empty on a host whose binary carries the files.
- **`scanner_assets_fetch`** (`task`) downloads every owed file from the release `scanner-bundle-v<FORMAT_VERSION>` over an HTTPS-only client, checks each before it is renamed into `<data>/scanner/` — the two models against SHA-256 digests compiled into the engine, the bundle for its ceiling, its format and not being empty — calls `ScannerState::forget()` and answers what is owed afterwards. A second call while one runs is refused; a failure is one sentence and a row in `error_log` under the operation `scanner_assets`. It reports through the event **`scanner:assets`** — `Progress { phase, file, done, total, message }`, with `phase` one of `downloading`, `checking`, `done`, `error` and `done`/`total` counted across the whole run.
- **On a page both are refused** in `NOT_IN_A_BROWSER_YET`, the fetch before any request. [card-scanner.md](card-scanner.md) §10, "Where the files come from on each host", has the rules and the measurements.
