# The shared core, step 7: the scanner's session glue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the scanner's session glue — the session and its lazy load, the one-window lease, the asset load order, the reader's prefs and review tray, the tray's commit and the capture writer — is the core's, and the desktop app behaves as it does today.

**Architecture:** `crates/grimoire-core` takes `card-scanner` as a dependency, and `src-tauri/src/scanner.rs` splits by script into `crates/grimoire-core/src/scanner.rs` and a desktop remainder (`src-tauri/src/scanner/mod.rs`, under a glob re-export) that keeps what names the host. The scanner's state becomes a field of the core's `State`, built empty.

**Tech Stack:** Rust (the workspace's pinned toolchain); `card-scanner` (`corpus`, `ocr`); `platform::{clock, files}`.

**Spec:** [`docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md`](../specs/2026-10-01-light-app-android-and-web-design.md) §2.3 (*the scanner's session glue* moves), §2.4 (the raw-bytes command kind), §8 (the scanner on a light install). **Tracking issue:** Msgaihede/mtg-grimoire#761, phase 2, step 7. **The rules for a moved module:** [`crates/grimoire-core/CLAUDE.md`](../../../crates/grimoire-core/CLAUDE.md), *Moving a module here*.

## Measured before the decision — 2026-10-03

`card-scanner` with `corpus` and `ocr` added to the core's `[dependencies]` for an experiment, then reverted:

| | |
| --- | --- |
| `cargo check --lib -p grimoire-core --target wasm32-unknown-unknown` | clean, 27 s |
| `cargo build --lib -p grimoire-core --target wasm32-unknown-unknown` | clean, 68 s |
| `cargo tree … --target wasm32-unknown-unknown -i libsqlite3-sys` | nothing to print: the crate's `rusqlite` `bundled` is inert in a browser build |
| Android | not measurable here (no NDK); CI's `core` job |
| Running it in a browser | would panic: the crate keeps `std::thread::scope` and `Instant` (spec §8) — phase 7's seam |

## Decisions — Markus, 2026-10-03

| Question | Answer |
| --- | --- |
| What moves | **The whole glue** — over moving only what names no engine, and over deferring the step to phase 7 |
| Where its state lives | **A field of `State`** — over a struct each host keeps beside its `State`. Reverses the desktop's documented `app.manage` beside `AppState` |
| Pull requests | One |

## Global Constraints

- **No agent provisions or deploys anything.**
- **Nothing a command answers changes**: the same names, arguments, sentences and refusals; the page is untouched.
- **The module's tests are the proof and move with it**, rewritten only where the clock moved (`Instant` onto `Tick`) and where they read the desktop's request body (those stay).
- **Never `cargo fmt --all`**; never two cargo runs at once in one tree; merge `main`, never rebase.

## Review Focus

1. **The embedded assets reach the load.** A release build carries the bundle and the models in the binary; the core cannot ask `cfg(scanner_assets)`. Pinned by `ScannerState::carry`, called above `app.manage` in `desktop::start`, and by the load-order tests that hand `Embedded` in.
2. **The model pair's sentences.** `TitleReader::load` read its files inside the crate; the core reads them through `platform::files` and keeps the sentence — pinned by `the_models_load_as_a_pair_from_one_place`'s new assertion that the refusal names both files.
3. **The lease's clock.** `Instant` became `Tick`; the lease's tests move unedited but for the type.
4. **A command still asking for the old managed state** would fail at run time with "state not managed" — the script refuses `ScannerState>` in the desktop's half, and every command's managed type was checked against what `desktop::start` manages (the live pass that would have driven them could not run — Task 3).

---

### Task 1: `platform` grows what the move needs

- [x] `clock::Tick`: `PartialEq`/`Eq`, `+ Duration`, `saturating_duration_since` — both arms; `a_tick_moved_forward_measures_that_much_after_its_origin`.
- [x] `files::read` — `std::fs::read` natively, `Unsupported` in a browser.
- [x] Commit: `feat(core): platform grows a tick moved forward and a file read whole`.

### Task 2: the move, by script

**Files:** `scripts/core-step-7.mjs`; `src-tauri/src/scanner.rs` → `crates/grimoire-core/src/scanner.rs` + `src-tauri/src/scanner/mod.rs`; by hand: `crates/grimoire-core/src/{lib,state}.rs`, both manifests, `src-tauri/src/desktop.rs`, `scripts/ci-route{,.test}.mjs`, `src/lib/ipc.test.ts`

- [x] Split by item and by test (`rs-items.mjs`'s `split` and `inner`): 41 items and 34 tests to the core; the headers, the raw-body parsing, the embedded assets, 12 commands and 8 tests stay.
- [x] Rewritten as it moves: `Instant` → `Tick`; `std::fs` and `.is_file()` → `platform::files`; the capture's clock → `platform::clock::now_secs`; `TitleReader::load` → `files::read` + `TitleReader::from_bytes` (`read_models`, its sentences kept); `Embedded::compiled()` → `ScannerState::carry`, said once by the host.
- [x] `State.scanner`, built empty by `State::new`; `desktop::start` calls `state.scanner.carry(scanner::compiled())` above `app.manage` and manages no scanner state; the commands reach `state.scanner`.
- [x] `card-scanner` in the core's `[dependencies]`; the CI router's `crates/*` arm runs `core` too.
- [x] All 42 of the module's tests pass where they now live; both clippies; the wasm32 clippy.
- [x] Commit: `refactor(core): the scanner's session glue moves to the core`.

### Task 3: verify, record, ship

- [x] Every Rust gate, the WASM build, `--locked`, no `testing` in the shipped tree: core 2 989 and desktop 426 — 6b's 3 414 and the `Tick` test, none lost. The frontend's build and lint; its suite **12 918 of 12 919** — `ScannerPage.test.tsx`'s refused-camera test timed out a 1 s `findByText` at 1.46 s under the full run's load, and passed 40/40 three times alone. The branch changes no frontend code but `ipc.test.ts`'s import.
- [x] A live pass in `tauri dev`: the Scanner view's commands answer, and a second window is refused. **Not run before the merge** — Markus's own portable build was open, and a dev build beside it only opens a window in that app; a static check stood in. **Run after it, the same day**, once he had closed it, with the published `scanner-bundle-v3` assets in the dev data folder: the rewritten file load (1.56 s, 118 467 labels), a real card (Counterspell MH2 267) detected, matched and resolved to its exact printing, the second window refused in the exact sentence and admitted 11.9 s later, the tray's refusal, write and one-write commit, and a capture. `docs/reference/light-app.md` §6.10 has the table.
- [x] A fresh reviewer subagent (Opus, read-only) on the branch's diff. **No must-fix.** It checked the embedded assets' path to the load and that no command can run before `carry`, `Tick`'s two arms, the file rewrites, `read_models`' sentences byte for byte against `TitleReader::load`, all twelve commands against the old file, all 42 tests (the only body changes `Instant` → `Tick` and the one new assertion), the fence, the router, `ipc.test.ts` and the lockfile. Its should-fixes were prose the move had made false — `.github/CLAUDE.md` and `ci-and-releases.md` still saying `crates/*` never runs `core`, comments in `desktop.rs`, `ipc.ts`, `verdictText.ts` and `card-scanner`'s `session.rs` naming the old file, and this crate's `CLAUDE.md` claiming every planned module had moved when the spec also named `share/snapshot` and `share/cache` — and seven nits; all fixed.
- [x] Docs: `crates/grimoire-core/CLAUDE.md`, `src-tauri/CLAUDE.md` (*Card scanner*), `docs/reference/card-scanner.md` §9–§10, `docs/reference/light-app.md` §6.10, the spec's §2.8 note, the root `CLAUDE.md` row.
- [ ] PR linked to #761, auto-merge and auto-fix; #761's step 7 line.
