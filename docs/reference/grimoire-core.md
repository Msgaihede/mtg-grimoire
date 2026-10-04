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
| **No `reqwest`, `tokio`, or `std`'s `fs`, `thread`, `net`, `process`, or `env` outside `src/platform/` in shipped code**. No direct disk checks (`.exists()`, `.is_file()`, `.metadata()`). | `platform::fence` (scans shipped code) | I/O, threads, and files have host-specific implementations in `src/platform/`. Domain code never touches the OS directly. |
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

---

## State, Hooks, and Events

1. **State Holder (`state::Store`)**:
   - Headless state container holding connections, cache references, and operational flags.
   - Free of window handles or UI references.

2. **Host Hooks (`Hook` trait)**:
   - Hosts register lifecycle hooks (e.g. notifications when database writes finish or cache clears occur).

3. **Event Forwarding (`state.events`)**:
   - The core emits progress and lifecycle events (`sync:progress`, `collection:reconciled`) through `state.events`.
   - Host adapters (such as `desktop::WindowEvents`) forward these to active frontend windows.

---

## Command Dispatch Table (`commands!` and `dispatch`)

- The central command router is declared via the `commands!` macro in `crates/grimoire-core/src/commands.rs`.
- `grimoire_core::dispatch(name, args, body)`:
  - Takes the desktop command name, JSON argument string, and optional binary payload.
  - Matches the command against the static dispatch table.
  - Returns `Result<String, String>` (JSON response or error sentence).
- Hosts (such as `grimoire-web`) delegate their command handling directly to `grimoire_core::dispatch`.
