# grimoire-scan — the browser's card scanner

`card-scanner` compiled to WebAssembly as **a module of its own, loaded by a dedicated Worker of its own** — never the engine's Worker and never the engine's module (see [light-app.md](../../docs/reference/light-app.md) §11.2 for the four figures that decided it, [grimoire-web.md](../../docs/reference/grimoire-web.md) for the contract, and [card-scanner.md](../../docs/reference/card-scanner.md) §11 for the crate's one-thread seam). The cargo workspace's fifth member.

For global repo workflow, style, and testing conventions, refer to:
- [Workflow & Commits](../../docs/agent/WORKFLOW.md)
- [Code Style](../../docs/agent/CODE_STYLE.md)
- [Verification Guide](../../docs/agent/RUNNING_AND_VERIFYING.md)

---

## 1. Exported Wire Contract

Six synchronous functions (`src/glue.rs`). Every string answered is `{"ok": …}` or `{"err": "<sentence>"}` — the web host's envelope.

| Export | Takes | Answers |
| --- | --- | --- |
| `start()` | — | Nothing. Installs `performance.now()` as the crate's clock and the panic hook. Run at instantiation; calling it again changes nothing |
| `load(bundle?, labels?, detection?, recognition?)` | Four optional `Uint8Array`s: the bundle, the labels the engine encoded, the two OCR models | `{"ok":{"bundle":{"loaded","entries","error"},"labels","models":{"loaded","error"},"unapplied_filters"}}` |
| `frame(jpeg, detail?, options)` | A JPEG, the same frame at camera resolution or nothing, `FrameOptions` as JSON (`""` = defaults) | `{"ok": <Verdict>}`; options left out, or not JSON of that shape, are the defaults, as on the desktop |
| `reset()` | — | `{"ok":null}` |
| `set_filters(filters)` | `ScanFilters` as JSON | `{"ok":null}`, or `{"err": …}` with the crate's own sentence |
| `memory_bytes()` | — | The module's linear memory in bytes (a high-water mark) |

- **Strict export check**: `scripts/build-wasm.mjs` fails the build if any of the six is missing from the glue.
- **A verdict is serialised from the crate's type, never through a `serde_json::Value`**: a `Value` sorts keys and widens `f32` (`0.3` → `0.30000001192092896`), and the page must read what the desktop's `scanner_frame` hands its own.
- **Rust supplies facts**: `load` says what loaded and what the crate said about what did not. No sentence here names a file, a download or a browser — those are the page's.
- **The page's half** is `packages/ui/lib/core/web/`: `scanWorker.ts` loads this module by URL, `scanSession.ts` answers each message and calls a throwing export a trap, `scanner.ts` owns the Worker's life and composes `scanner_status` from `load`'s facts, `scanStore.ts` keeps the three files. `pnpm web:scanner-smoke` is the run that instantiates this module in a browser.

---

## 2. Nothing May Throw; A Panic Ends The Instance

- Bytes that are not a bundle, labels cut short, a model that is not one, a JPEG that is not one, JSON that is not: each is an answer (`scanner.rs`' tests feed every prefix of a bundle and of a labels file).
- The module is built with `panic = "abort"`. A panic is a trap out of the call; the crate's own guard guards nothing there. **The only containment is a new Worker**, which is why this module is not the one that holds the database.
- After a trap the scanner's `RefCell` stays borrowed, and every later string export answers `{"err": …}` (`scanner::PANICKED`) rather than trapping again. A courtesy, not a recovery.

---

## 3. Manifest Rules

- **`card-scanner` with `ocr`, never `corpus`.** `corpus` is SQLite. Labels arrive as bytes (`card_scanner::labels`), read and encoded by the engine (`grimoire_web`'s `scanner_labels`).
- **No `grimoire-core`, `tokio` or `reqwest`.** Nothing here fetches, stores or waits.
- **Build it alone**: `cargo build -p grimoire-scan`. A build that also names the engine unifies features and compiles the scanner with `corpus`.
- **`simd128` is this module's alone**, set by `scripts/build-wasm.mjs` in the environment of one cargo run with a build tree of its own (`target/scanner-simd128`). Never put the flag in `.cargo/config.toml`: the engine's module must load in a browser without SIMD.
- **Version** is the app's; `release-please` bumps it and `scripts/release-rule.test.mjs` holds it.

---

## 4. Module Gating and Tests

| Module | Compilation Target | Responsibility |
| --- | --- | --- |
| `scanner` | All targets | The session, a load's facts, the filters a reload carries, the JSON every export answers |
| `glue` | `wasm32-unknown-unknown` only | `#[wasm_bindgen]` shell, the `thread_local`, the clock, the console |

- **Keep decisions out of `glue.rs`**; it is invisible to `cargo test`.
- **Filters are owed across a reload**, as `grimoire_core::scanner` owes them: offered to each new session until one accepts, or until an accepted `set_filters` replaces them. Filters set before the first `load` are owed to it.
- Tests hold `card_scanner::host::inline()` where a resolve's frame matters: that is the browser, one thread.

---

## 5. Commands

| Command | Action |
| --- | --- |
| `cargo test -p grimoire-scan` | Native tests of everything but the shell |
| `pnpm web:wasm` | Both web modules; `node scripts/build-wasm.mjs --only scanner` for this one |
| `cargo fmt -p grimoire-scan` | Format (never `cargo fmt --all`) |

WASM clippy, as CI's `web` job runs it (Bash; PowerShell sets `$env:RUSTFLAGS`):
```bash
RUSTFLAGS="-C target-feature=+simd128" cargo clippy --lib -p grimoire-scan --locked --target wasm32-unknown-unknown --target-dir target/scanner-simd128 -- -D warnings
```
