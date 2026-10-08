# grimoire-web — the light app's web host

`grimoire-core` compiled to WebAssembly (WASM) and loaded by one dedicated Web Worker, with the page communicating via the `Core` seam (see [grimoire-web.md](../../docs/reference/grimoire-web.md) and [light-app.md](../../docs/reference/light-app.md) §6 & §9). The cargo workspace's fourth member. It holds almost nothing of its own: four exports, the OPFS pool for the two databases, and state management. The engine's core rules in [`crates/grimoire-core/CLAUDE.md`](../grimoire-core/CLAUDE.md) strictly bind here.

For global repo workflow, style, and testing conventions, refer to:
- [Workflow & Commits](../../docs/agent/WORKFLOW.md)
- [Code Style](../../docs/agent/CODE_STYLE.md)
- [Verification Guide](../../docs/agent/RUNNING_AND_VERIFYING.md)

---

## 1. Exported Wire Contract

Four functions are exposed to the Worker:

| Export | Takes | Answers |
| --- | --- | --- |
| `open(directory)` | OPFS directory name (bare name string, not path) | JSON: `{"kind":"ready",...}`, `{"kind":"already-open"}`, or `{"kind":"failed","message":"..."}` |
| `call(name, args, body?)` | Desktop command name, JSON string args (`"null"` for none), optional byte body | JSON: `{"ok": <value>}` or `{"err": "<sentence>"}` |
| `listen(handler)` | Callback `(name, payload)` with payload as JSON string | Nothing; subsequent calls replace previous handler |
| `scanner_labels()` | — | `Promise<Uint8Array>`: every printing's label as `card_scanner::labels` bytes, for the scanner's own Worker; **no bytes** before `open` is ready and while the corpus is empty. **Rejects with one sentence** when the read failed or gave up on a corpus that kept changing (`LABEL_ATTEMPTS`, twelve: a launch moves the corpus's schema cookie eight times) — the page must be able to tell that from empty |

- **Wire synchronization**: The Worker's hand-written definitions live in `packages/ui/lib/core/web/grimoire_web.d.ts` and `protocol.ts`. A change to an export or wire string in `wire.rs` must update both TypeScript files in the same commit.
- **Strict export check**: `scripts/build-wasm.mjs` checks each module's `exports` and fails the build if any is missing (missing `#[wasm_bindgen]` attributes compile without warnings).
- **Core dispatch**: `call` dispatches directly via `grimoire_core::dispatch`. Commands are added in `crates/grimoire-core/src/commands.rs`, never directly in this crate.
- **The scanner is not in this module.** Its session runs in a Worker of its own on `crates/grimoire-scan` (see [its guide](../grimoire-scan/CLAUDE.md)); this host only hands it the labels, because it holds the corpus. `host::scanner_labels` reads `cards` through the state's one connection a page at a time (`LABEL_PAGE`), lets go of the connection between pages, takes a `Breather` turn on `feed::WORK_BUDGET`, and starts over if the corpus's schema cookie moved (a sync's swap). Never open a second connection for it. On the wire it is a message of its own — `{ kind: "labels" }`, answered with the bytes transferred (`protocol.ts`'s `transferOf`) — and no command of the table; the page's scanner (`packages/ui/lib/core/web/scanner.ts`) asks once per session it builds.

---

## 2. Zero Trap and Reject Rule

Workers do not propagate traps as rejected promises with descriptive messages (they fire `onerror`). Every error condition must return a structured response:

- Invalid calls before `open`, invalid JSON arguments, missing commands, or unexpected byte bodies return `{"err": "..."}`.
- Storage initialization errors return `{"kind":"already-open"}` (detected by `NoModificationAllowedError` in DOMException) or `{"kind":"failed"}`. `already-open` indicates another Worker of this origin holds the pool; see [`apps/light/CLAUDE.md`](../../apps/light/CLAUDE.md) and `packages/ui/lib/core/web/holder.ts` for Web Lock handling.
- Panic hook is initialized during instantiation; logs to `console.error`/`console.warn` (`eprintln!` is a no-op on wasm32).

---

## 3. Worker Concurrency and Lock Safety

The Worker executes on a single thread with no parallel background threads:
- **No recursive mutex locks**: `std::sync::Mutex` panics on recursive locking on single-threaded WASM.
- **No locks held across `.await`**: Streaming downloads and asynchronous calls yield control. Holding a mutex or `RefCell` borrow across `.await` results in panics or `BorrowMutError`.
- **Event loop turns**: Long-running ingestion yields to the host event loop every 50 ms via `grimoire_core::platform::timer::yield_to_host`, allowing IPC calls like `sync_status` to process.
- **Singleton initialization**: `open` executes once per Worker via `host::Once`. Subsequent calls await a clone of the initial future. A failed attempt requires a full Worker recreation.
- **Dedicated Worker requirement**: OPFS synchronous access handles are only available in dedicated Workers, not on the main thread or in Service Workers. Cross-origin isolation (`COOP`/`COEP`) is not required.

---

## 4. Module Gating and Test Strategy

| Module | Compilation Target | Responsibility |
| --- | --- | --- |
| `wire` | All targets | JSON serialization formats, protocol parsing, tab guard matching |
| `host` | All targets | Business logic, download sequencing, corpus deletion, call dispatch, `Once` guard |
| `glue` | `wasm32-unknown-unknown` only | `#[wasm_bindgen]` bindings, OPFS pool setup, `thread_local` handles |

- **Keep decisions out of `glue.rs`**: Only `glue.rs` is target-gated. All business decisions reside in `host.rs` or `wire.rs` and are tested natively via `cargo test -p grimoire-web`.
- **Desktop tests vs browser runs**: Native tests mock browser features via scratch directories and mock servers (`httpmock`). Module execution in real browser environments is verified via `npm run web:smoke`, and live sync between two of them via `npm run web:sync-smoke`.

---

## 5. Lifecycle and Storage Behaviors

- **Launch download sequence**: `host::launch_downloads` runs as a single background task (`wasm_bindgen_futures::spawn_local`) in strict sequence: card sync, selected marketplace prices, oracle tags, art tags, and combos. Runs once per launch (no background upkeep loop).
- **Live sync**: `host::start` registers `live::WriteWake` as the state's one write observer and hands back its `Bell` (`Started::writes`); `glue::open` spawns `host::live_sync` — the core's `sync_engine::live::run` — beside the downloads, after `open` has answered, for the Worker's life. The socket is the Worker's own `WebSocket` (`grimoire_core::platform::socket`). In no sync group it opens no socket and asks the relay nothing: one read of `sync_group` every 5 s. `sync:live` and `sync:applied` reach the page through `listen`. No push on exit — a closing tab gives a Worker no moment to await one.
- **No image fetching or upkeep**: Pictures are fetched by the Service Worker and stored in Cache Storage. The engine only resolves image paths via `card_image_source`.
- **Corpus recovery**: Unrecoverable or corrupted databases are deleted and rebuilt automatically (`host::delete_corpus`). `user.db` is never deleted or replaced.
- **Facet index resiliency**: An error building the facet index produces a `console.warn` but never fails `open` (facet searches fail open by design).
- **Pool capacity**: Fixed at 64 file handles (`host::POOL_CAPACITY`) to support SQLite temp files (`temp_store = FILE`).

---

## 6. Workspace and Manifest Rules

- **Feature gating**: Never enable `grimoire-core/testing` under `[dependencies]`; it belongs exclusively under `[dev-dependencies]`.
- **Version alignment**: Workspace version matches the app release; managed by `release-please`.
- **Toolchain pin**: `wasm-bindgen-cli` version must strictly match `Cargo.lock`.
- **SQLite features**: `rusqlite` uses `hooks` and must not disable default features (`default-features = false` breaks WASM SQLite).
- **`card-scanner` is here for `labels` alone** (`corpus` feature): nothing in this crate may reach a session, or fat LTO stops dropping the scanner and its OCR runtime from this module. A new class or a megabyte in `dist-wasm/grimoire_web_bg.wasm` is the symptom.
- **No `simd128` here.** That target feature is the scanner module's alone; `scripts/build-wasm.mjs` refuses an engine module that names it.
- **Dev dependencies**: `httpmock` and `flate2` are used for testing downloads against local mock endpoints without hitting live Scryfall or Commander Spellbook feeds.

---

## 7. Build, Verification, and Commit Guidelines

Run verification only at the end of a feature (not after each change):

| Command | Action |
| --- | --- |
| `cargo test -p grimoire-web` | Run native logic and wire tests |
| `npm run web:wasm` | Build both WASM modules using the `wasm` profile: this host's into `dist-wasm/`, the scanner's (`grimoire-scan`, with `simd128`) into `dist-wasm/scanner/`. `-- --only engine` for this one alone |
| `npm run web:dev` | Start Vite dev server on port 5176 using current WASM build |
| `npm run web:build` | Build production web bundle into `apps/light/dist-web/` |
| `npm run web:smoke` | Run headless Chromium offline smoke tests |
| `npm run web:sync-smoke` | Pair two headless Chromium profiles through the relay under workerd and sync both ways (runs `app-worker`'s pinned wrangler — `npm ci --ignore-scripts --prefix infrastructure/app-worker` first — or `WRANGLER=<wrangler.js>`) |
| `npm run web:preview` | Preview production build on port 4176 with Service Worker |

Formatting and clippy:
- `cargo fmt -p grimoire-web` (never use `cargo fmt --all`).
- Direct WASM clippy check (requires LLVM/clang 18+):
  ```bash
  CC_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/clang.exe" AR_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/llvm-ar.exe" cargo clippy -p grimoire-web --lib --target wasm32-unknown-unknown --locked -- -D warnings
  ```

Commit discipline:
- One commit per feature matching feature size, bundling code, tests, and documentation together for clean `release-please` changelogs.

