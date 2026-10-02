# The shared core, step 1: the crate, the workspace and the leaves — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `crates/grimoire-core` exists, has no `tauri` dependency, holds the modules that name nothing still in `src-tauri`, and is compiled by CI for `wasm32-unknown-unknown` and `aarch64-linux-android` as well as for the desktop — with the desktop app unchanged.

**Architecture:** The repository becomes a cargo workspace with two members, `src-tauri` and `crates/grimoire-core`. A module moves with `git mv`, tests and all, and `src-tauri` re-exports it at the path it always had (`pub use grimoire_core::legalities;`), so no caller is edited. `platform/` is the only directory in the core that may know its target; a source sweep holds that.

**Spec:** [`docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md`](../specs/2026-10-01-light-app-android-and-web-design.md) §2, especially §2.2, §2.5 and §2.7–§2.9. **Tracking issue:** Msgaihede/mtg-grimoire#761, phase 2, step 1.

Everything measured here was measured on Windows on 2026-10-02, debug builds, on the branch's own tree.

## Decisions taken before any code

### A workspace, at the repository root — Markus, 2026-10-02

The spec's §2.9 left this to the plan with *no workspace* as the default. Three arrangements were put to Markus with what was measured for the first two; he chose the third.

| Arrangement | What was measured |
| --- | --- |
| No workspace — the core a plain path dependency | `cargo test -p grimoire-core` from `src-tauri` works **until the core has a dev-dependency**, then: `package grimoire-core cannot be tested because it requires dev-dependencies and is not a member of the workspace`. `cargo fmt -p` refuses a non-member too. So the core would need its own `Cargo.lock` and its own `target/` |
| A workspace rooted at `src-tauri`, the core a member through `package.workspace` | `cargo metadata` answered root `src-tauri`, target `src-tauri/target`; `test`, `clippy` and `fmt -p` all ran. Nothing moves |
| **A workspace at the repository root** (chosen) | The conventional layout: `Cargo.lock` moves to the root, `[profile.*]` moves to the root manifest |

**The review found what the root costs, and Markus kept it.** Cargo finds a workspace by walking up parent directories, and every agent worktree sits under the main checkout. Reproduced in a scratch copy of the layout: a worktree whose branch predates the root manifest is refused on every cargo command (`current package believes it's in a workspace when it's not`) until it merges `main`; `crates/card-scanner` is refused the same way even in an up-to-date worktree unless its manifest carries an empty `[workspace]` table, which it now does; and excluding `.claude` in the root to spare stale worktrees makes them build into the main checkout's `src-tauri/target`. The same cases under a workspace rooted at `src-tauri` all resolved. Put to Markus with both sets of results, he kept the root: one merge per open branch, against the conventional layout that later hosts join as ordinary members.

**`target/` is pinned where it was.** A root workspace builds into `<root>/target` by default, which would move every checkout's dev database (`src-tauri/target/debug/data`), the portable-zip path `release.yml` reads and 37 references in 22 files outside `docs/superpowers/`. `.cargo/config.toml` sets `build.target-dir = "src-tauri/target"`; `cargo metadata` confirms the root is the repository and the target is unchanged. Moving it later is deleting that file on an announced day.

**`crates/card-scanner` stays outside**, by an explicit `exclude` (a path dependency under the workspace root becomes a member otherwise). Cargo reads config from the working directory rather than from `--manifest-path`, so the pin would have re-homed that package's build too; `crates/card-scanner/.cargo/config.toml` answers a run started inside it, and every scripted run from the root passes `--target-dir crates/card-scanner/target`. Measured: from the root without the flag its target reads `src-tauri/target`; from inside the folder, its own.

### Which of the spec's leaves are leaves

§2.8 lists fifteen. Reading each one's code **and its tests** against what else moves in this step:

| Moves now | Why it can |
| --- | --- |
| `app_meta`, `slug`, `cardtypes`, `legalities` | Name nothing outside themselves and each other |
| `feed/frame`, and `feed`'s `mostly_unusable` | Pure framing over `flate2` |
| `index/bitset` | Pure |
| `sync_pair/{crypto,invite}` | Pure cryptography and encoding |
| `sync_engine/{hlc,merge}` | `merge` names only `hlc` |

| Waits for step 2 (storage) | What it names that has not moved |
| --- | --- |
| `sorting` | `schema::FINISHES` |
| `image_uri` | Its tests open `schema::memory_pair()` |
| `card_row` | `schema::IMAGE_VARIANTS`; its tests open `schema::memory_pair()` |
| `errors` | `scryfall::ScryfallError` in `kind_of`'s signature — step 5's type, so step 2 has to split that function off or bring the error enum forward; its tests open `schema::memory_pair()` |
| `feed/backoff` | `sync::set_meta`; its tests open `schema::memory_pair()` |
| `sync_engine/wire` | `sync_pair::identity::Group` and `schema::USER_SCHEMA_VERSION` |

Hoisting three constants out of `schema` to move two of those early was considered and not done: each would get a temporary home that step 2 undoes.

### What `platform/` holds on day one

The clock, and nothing else. `SystemTime::now()` panics on `wasm32-unknown-unknown` and the first web build hit it five times, so that seam exists before its first caller. HTTP, files, sleep and background work are named in the module doc with the step that brings each; an interface written before the code that calls it is a guess.

## Global Constraints

- **The desktop app must be unchanged.** No caller of a moved module is edited: `src-tauri` re-exports. No test is deleted; one moves (below).
- **`grimoire-core` has no `tauri` dependency**, and `cfg(target_…)`, `SystemTime::now` and `Instant::now` appear only under its `src/platform/`.
- **Never `cargo fmt --all`** — it follows path dependencies and `card-scanner` is not rustfmt-clean. `cargo fmt -p mtg-grimoire -p grimoire-core`.
- **A dependency both members name is declared alike in both manifests**, or `cargo test -p grimoire-core` compiles a second SQLite.
- **No agent deploys anything**, and nothing here needs a deploy.
- Tests run once, at the end: `npm run verify`.

## Tasks

### Task 1 — the workspace

- [x] `git mv src-tauri/Cargo.lock Cargo.lock`
- [x] Root `Cargo.toml`: `[workspace]` with `resolver = "2"` (a virtual manifest has no edition to imply it), both members, the `exclude`, and the seventeen `[profile.dev.package.*]` blocks moved from `src-tauri/Cargo.toml` with their comment
- [x] `.cargo/config.toml` pinning `target-dir`; `crates/card-scanner/.cargo/config.toml` keeping that package's own
- [x] `cargo metadata` from the root, with `--manifest-path crates/card-scanner/Cargo.toml`, and from inside `crates/card-scanner` — three answers, recorded above

### Task 2 — the crate

- [x] `crates/grimoire-core/Cargo.toml`: the shared dependencies spelled as `src-tauri` spells them; the pairing cryptography's four crates moved here with their version arguments; `rusqlite` with `bundled` off WASM and without it on; `getrandom`'s `wasm_js` and `js-sys` on WASM only
- [x] `src/lib.rs`: the module map and the four rules
- [x] `src/platform/{mod,clock}.rs`
- [x] `src/platform/fence.rs`: the sweep — target keys, platform gates (followed across the lines rustfmt breaks one into), the wall-clock types, and a manifest with no host in it, renamed or not; each with a case that proves the detector fires
- [x] After review: an empty `[workspace]` table in `crates/card-scanner/Cargo.toml`; `#[inline]` on `index::bitset`'s per-printing and per-word methods, which are now called across a crate boundary

### Task 3 — the moves

- [x] `git mv` the ten modules; `feed/mod.rs` goes too and `src-tauri` gets a new one holding `backoff` and the re-export
- [x] `src-tauri/src/lib.rs`, `index/mod.rs`, `sync_pair/mod.rs`, `sync_engine/mod.rs`: `pub mod x;` becomes `pub use grimoire_core::…::x;`
- [x] `sync_engine/hlc.rs`: `include_str!` of `relay/src/log.ts` is one directory further away
- [x] `slug.rs`'s `the_tags_re_export_is_this_function` names `crate::tags`, which the core cannot: it moves to `src-tauri/src/tags/mod.rs` beside the re-export it guards
- [x] `src-tauri/Cargo.toml`: drop `x25519-dalek`, `chacha20poly1305`, `hkdf`, `qrcode`; add `grimoire-core`

### Task 4 — CI, the router and the scripts (a second agent, in parallel)

- [x] `package.json`: `lint:rust` and `verify` over the workspace; the card-scanner run keeps its target
- [x] `ci.yml`: the `rust` job from the root over `--workspace`; a `core` job compiling the crate for the two other targets; `core` in every list a gated job belongs in
- [x] `scripts/ci-route.mjs` and its test: `core` in `JOBS`; arms for the workspace's own files and for `crates/grimoire-core/`
- [x] `release.yml`, `scanner-bundle.yml`: the cache's `workspaces`, the scanner's `--target-dir`
- [x] `release-please-config.json`: the lockfile's path
- [x] `scripts/coverage-rust.mjs`: both members

### Task 5 — the record

- [x] `crates/grimoire-core/CLAUDE.md`, and its row in the root file's table
- [x] `docs/reference/light-app.md`: what this step built and measured, and what it left for step 2
- [x] The spec's §2.8 and §2.9, dated
- [x] Every sentence elsewhere this makes false: `src-tauri/CLAUDE.md`, `docs/reference/card-scanner.md`, `.claude/rules/rust-lsp.md`, `docs/reference/test-coverage.md`

### Task 6 — verify and ship

- [x] `npm run verify`
- [x] The core for `wasm32-unknown-unknown`, locally: `cargo build --lib -p grimoire-core --target wasm32-unknown-unknown` and the same `clippy -- -D warnings`, with `CC_wasm32_unknown_unknown` pointed at `C:\Program Files\LLVM\bin\clang.exe` (clang 22; cc-rs does not find it off `PATH`)
- [x] The desktop measurements this step could have moved (spec §11): none of the moved code is on a measured path that changed — a module compiled in another crate of the same build, at the same opt-level — so what is re-run is the app launching and searching, in the real window
- [ ] PR, linked to #761; `ci-ok` green including the new `core` job, which is the first time the Android compile runs anywhere

## What step 2 inherits

- The six modules above, with their reasons.
- `schema::memory_pair()` is what most of them wait for, so `schema` and `db` moving is what unblocks them — and `crate::scratch::path` has to come along for any test that opens a real file.
- `errors::kind_of` is the one place a step-2 module names a step-5 type.
- The fence sweeps test code too. `index/mod.rs`'s tests time themselves with `Instant::now()`; when they arrive they either go through `platform` or the fence learns to read `#[cfg(test)]`.
- Doc links in the core that name a module still in `src-tauri` (`crate::filters`, `crate::schema`, `super::apply`) do not resolve until that module arrives. Nothing builds docs in CI, so nothing is red.
