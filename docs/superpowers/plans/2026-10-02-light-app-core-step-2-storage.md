# The shared core, step 2: storage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `crates/grimoire-core` holds the database, both schema ladders and every module that reads only them, with the desktop app unchanged and every existing database opening exactly as it did.

**Architecture:** A module moves with `git mv`, tests and all, and `src-tauri` re-exports it at the path it had, so no caller is edited. Two modules cannot move whole, because a function in each names code that moves in a later step: `schema` leaves `prepare_database` and `prepare_data_dir` behind in a `src-tauri` module that re-exports everything else, and `errors` leaves `kind_of` behind the same way. A test that names a module still in `src-tauri` stays in `src-tauri`, beside the re-export, unedited.

**Tech Stack:** Rust (the workspace's pinned toolchain), rusqlite 0.40, cargo features.

**Spec:** [`docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md`](../specs/2026-10-01-light-app-android-and-web-design.md) §2.3, §2.5, §2.8. **Tracking issue:** Msgaihede/mtg-grimoire#761, phase 2, step 2. **The step before:** [step 1's plan](2026-10-02-light-app-core-step-1-leaves.md) and [light-app.md](../../reference/light-app.md) §6.1.

Everything measured here was measured on Windows on 2026-10-02, on this branch's tree, at `fb290538`.

## Decisions taken before any code

### What "storage" is — Markus, 2026-10-02

§2.8 lists ten modules for this step and step 1 handed over six more. Each one's code **and its tests** were read against what moves here (`crate::` and `super::` paths, split at the foot `#[cfg(test)]`):

| Moves now | What it names outside itself |
| --- | --- |
| `db` | Nothing. `Instant::now()` and `thread::sleep` in `lock_for` and `lock_background` |
| `schema` | `db`; and — in three functions — `split`, `maintenance`, `managed_wishlist`, `deck_tokens`, `deck_meta`, `sync::set_meta_opt` |
| `filters`, `sorting`, `card_row` | `schema` |
| `image_uri` | `schema::memory_pair()`, in its tests |
| `errors` | `scryfall::ScryfallError`, in `kind_of` alone |
| `feed::backoff` | `sync::{get_meta, set_meta, set_meta_opt}` |
| `sync_engine::capture` | Nothing in its code. Three of its 42 tests name `reconcile`, `scryfall` and `prepare_database` |
| `scratch` | Nothing. Test builds only |

| Waits | For | What it names that has not moved |
| --- | --- | --- |
| `reconcile` | step 4 | `collection::fold_entry`; `scryfall::Migration` |
| `managed_wishlist` | step 4 | `deck_theory::wanted`, `wishlist::add_wish_silent` |
| `sync_engine::apply` | step 4 | `apply/rehome.rs` calls `collection_folders::refile_entry` and `wishlist_folders::refile_wish`; its 5 156 lines of tests drive decks, folders and the reset |
| `sync_engine::baseline` | step 4 | `apply` |
| `collection_source` | step 4 | `AppState`, `sync::with_write`, `index::lifecycle`, `collection_folders` |
| `sync_pair::identity` | step 6 | `sync_engine::client`'s three cursor keys; 14 test lines on `apply` and `client`; `cfg!(windows)` in `mint_name` |
| `sync_engine::wire` | step 6 | `identity::Group` |

Three arrangements were put to Markus with that table: storage only; storage plus `identity` and `wire` (hoisting the cursor keys); or the spec's whole list through callbacks the desktop supplies and step 4 deletes. **He chose storage only** — step 1's rule for its six non-leaves, that nothing gets a temporary home the next step undoes.

### `schema` moves in two parts

`schema.rs` is 23 932 lines and three of its functions are why it cannot move whole:

| Function | Names | What happens |
| --- | --- | --- |
| `prepare_database` | After the two ladders and `capture::install`: `maintenance` ×3, `managed_wishlist` ×2, `deck_tokens` ×4, `deck_meta` ×1 | **Split at the line the function already draws** — what may stop a launch, and what is logged and left owing. The first half moves as `schema::bring_to_head`; `prepare_database` stays in `src-tauri` and is that call followed by every later statement, verbatim and in the same order |
| `prepare_data_dir` | `split::convert`, then the corpus probe | The probe moves as `schema::replace_unreadable_corpus(data_dir) -> bool`; `prepare_data_dir` stays and is `split::convert` followed by it |
| `swap_staging` | `sync::set_meta_opt`, `maintenance::K_FTS_REBUILD_PENDING` | Both move: the three `sync_meta` functions are carved out of `sync.rs` into a core `sync_meta` module (what `app_meta` was to `update`), with the key beside them. `sync` and `maintenance` re-export them |

`src-tauri/src/schema/mod.rs` — **not `schema.rs`: with the old path gone, git records the moved file as a rename** — is `pub use grimoire_core::schema::*;` plus those two functions. An item defined in a module shadows a glob import of the same name, so `crate::schema::prepare_database` is the desktop's and every other `crate::schema::…` is the core's. **Step 4 brings the launch passes' modules and `prepare_database` goes home; `prepare_data_dir` stays the desktop's as long as `split` does** (spec §2.3).

A hook — the launch passes handed to the core as a parameter — was the other shape. It was not taken: 23 call sites would change, and the parameter would be deleted in step 4.

### Tests that stay behind

A module's tests move with it. A test that names a module still in `src-tauri` cannot compile in the core, so it stays, **unedited**, in `src-tauri` beside the re-export — step 1's answer for `slug`'s one such test. Counted by a scan of each foot test module:

| Module | Tests | Stay in `src-tauri` | Because they name |
| --- | --- | --- | --- |
| `schema` | 280 | 17, and two helpers | `split::convert`, `prepare_database`, `prepare_data_dir`, `deck_tokens`, `deck_todos`, `deck`, `tags::query`, `maintenance` — fifteen directly, and two through a helper that calls the launch |
| `sync_engine::capture` | 42 | 3 | `prepare_database`, `reconcile`, `scryfall::Migration` |
| `errors` | 10 | 1 | `scryfall::ScryfallError` |
| `db`, `filters`, `sorting`, `card_row`, `image_uri`, `feed::backoff` | 109 | 0 | — |

Every one of them comes home in the step that moves what it names.

### Test scaffolding crosses the crate through a `testing` feature

`schema::memory_pair()` is `#[cfg(test)]` and 77 files in `src-tauri` open it; `schema::tests::{seed_card, deck, category}` are used by 20; `crate::scratch::path` by 19. A dependency's `cfg(test)` is off when another crate's tests are built, so the core gates all of it on `#[cfg(any(test, feature = "testing"))]`, and `src-tauri` asks for the feature **under `[dev-dependencies]` only** — a `tauri dev` or `tauri build` binary links the core without it. Compiling the helpers unconditionally was the other choice and puts test fixtures in a release build.

### `platform/` gains a tick and a pause

`db::lock_for` and `db::lock_background` are the first code in the core that measure a wait and sleep through one. `Instant::now()` panics on `wasm32-unknown-unknown` and so does `thread::sleep`.

- `platform::clock::Tick` — `Tick::now()`, `elapsed() -> Duration`. `Instant` natively; `Date.now()` in a browser, saturating at zero.
- `platform::pause(Duration) -> bool` — `thread::sleep` and `true` natively. **`false` in a browser, without waiting**: a Worker is one thread, so nothing else can let go of a lock while this one waits, and the caller gives up at once. `lock_for` then answers `None`, which every caller already reads as `db::BUSY`.

On the desktop both functions keep their arithmetic: `started.elapsed() >= timeout` is `Instant::now() >= started + timeout`.

**Files are not behind `platform/` yet.** `schema` reaches the filesystem in seven functions (the corpus replace, the backup and its prune, the damage mark, the two probes). It compiles for a browser and fails there at run time. The spec's table gives files to the I/O step, which is where an OPFS arm has something to be written against; this step lists the sites in the record and leaves them.

## Global Constraints

- **The desktop app must be unchanged, and no existing database may lose a row.** No rung, DDL constant, grain or statement in either ladder is edited: `schema.rs` is `git mv`'d and its diff is the two cuts above, visibility, and the test gate. `prepare_database` keeps its order statement for statement.
- **No caller of a moved module is edited** — `src-tauri` re-exports. Two exceptions, both a path: the fixture `ingest`'s test reads moves with `card_row`, and a `?raw` or `include_str!` of a moved file names its new place.
- **No test is deleted or weakened.** `#[test]` and `#[tokio::test]` attributes before: 3 231 under `src-tauri/src`, 131 in the core. After: the same 3 362, plus what this step adds for `platform` and `sync_meta`. **As built: 3 366** — 2 810 and 556.
- `grimoire-core` has no `tauri` dependency; `cfg(target_…)`, `SystemTime` and `Instant::now` appear only under its `src/platform/`. The fence is not weakened.
- A dependency both members name is declared alike in both manifests.
- **Never `cargo fmt --all`.** `cargo fmt -p mtg-grimoire -p grimoire-core`.
- No agent deploys anything, and nothing here needs a deploy.
- Tests run once, at the end. Cargo is never run twice at once in this tree.

## Review Focus

What no moved test exercises and a reader would notice first:

1. **An existing `user.db` opened by this build** — same `user_version`, same row count in every user table, no backup written (no rung is owed), `foreign_key_check` clean. Task 7's live pass, on a copy of the main checkout's data.
2. **A launch pass skipped or reordered by the cut** — `prepare_database`'s tests stay in `src-tauri` and call the desktop's function, so they cover the composition and not only the core's half. Task 4 diffs the two halves against the original body.
3. **A user-facing write that should answer `BUSY` after five seconds waiting forever, or at once** — `db`'s twelve tests move with it and time both; they run through `Tick`.
4. **A `pub(crate)` item the desktop still calls** — a compile error, not a behaviour. Task 4.
5. **A capability the release build gains or loses** — the `testing` feature must be off outside tests. Task 7 asks `cargo tree -e features` for the binary.

---

## Tasks

### Task 1 — `platform`: a tick and a pause

**Files:** `crates/grimoire-core/src/platform/clock.rs`, `crates/grimoire-core/src/platform/pause.rs` (new), `crates/grimoire-core/src/platform/mod.rs`.

**Produces:** `platform::clock::Tick { now() -> Tick, elapsed(&self) -> Duration }`; `platform::pause(Duration) -> bool`.

- [x] `Tick` in `clock.rs`, one `imp` per kind of host, beside `now_ms`
- [x] `pause.rs`, the same shape
- [x] `mod.rs`: the table's "a sleep" row lands with this step
- [x] A test for each: a tick's elapsed time does not go backwards and covers a pause; a native pause answers `true`

### Task 2 — the manifests

**Files:** `crates/grimoire-core/Cargo.toml`, `src-tauri/Cargo.toml`.

- [x] Core: `unicode-normalization = "0.1"` with the comment that argues it (`schema::label_name_key` is its one caller); `[features] testing = []`; `[dev-dependencies] tempfile = "3"`
- [x] `src-tauri`: drop `unicode-normalization`; `[dev-dependencies] grimoire-core = { path = "../crates/grimoire-core", features = ["testing"] }`

### Task 3 — the moves that need no cut

**Files:** `git mv` from `src-tauri/src/` to `crates/grimoire-core/src/`: `db.rs`, `filters.rs`, `sorting.rs`, `card_row.rs`, `image_uri.rs`, `feed/backoff.rs`, `scratch.rs`; `src-tauri/tests/fixtures/cards_sample.jsonl` to `crates/grimoire-core/tests/fixtures/`. New: `crates/grimoire-core/src/sync_meta.rs`.

- [x] `db.rs`: `lock_for` and `lock_background` through `Tick` and `pause`; its tests' `Instant::now()` through `Tick`
- [x] `sync_meta.rs`: `get_meta`, `set_meta`, `set_meta_opt` cut from `sync.rs` with their docs, and `K_FTS_REBUILD_PENDING` cut from `maintenance.rs` with its doc. `sync.rs` and `maintenance.rs` re-export them by name
- [x] `scratch.rs`: `path` becomes `pub`; the module is gated `any(test, feature = "testing")` in the core's `lib.rs`
- [x] `src-tauri/src/lib.rs`: each `pub mod x;` becomes `pub use grimoire_core::x;`, doc comments kept; `mod scratch;` becomes a `use`
- [x] `feed/mod.rs` on both sides: `backoff` is the core's now
- [x] `ingest.rs`'s fixture path, and `legalities.rs`'s mention of it

### Task 4 — `schema`, `capture` and `errors`

**Files:** `git mv` `schema.rs`, `sync_engine/capture.rs`, `errors.rs`. New in `src-tauri/src/`: `schema/mod.rs`, `errors/mod.rs` (the two remainders), `sync_engine/capture_tests.rs`.

- [x] Core `schema.rs`: `prepare_database`'s body up to and including `capture::install` becomes `pub fn bring_to_head`, with the half of the doc comment that is about it
- [x] Core `schema.rs`: `prepare_data_dir`'s body after the `split::convert` line becomes `pub fn replace_unreadable_corpus`
- [x] `swap_staging` names `crate::sync_meta`
- [x] `memory_pair` and the cross-crate helpers (`seed_card`, `deck`, `category`, and whatever the stay-behind tests turn out to need) gated `any(test, feature = "testing")` in a `schema::fixtures` module the core's own tests import
- [x] `pub(crate)` becomes `pub` for each of the eleven items `src-tauri` still names; the rest stay
- [x] `src-tauri/src/schema/mod.rs`: the glob re-export, `prepare_database`, `prepare_data_dir`, and a `tests` module holding the seventeen stay-behind tests and the re-exported fixtures
- [x] **Diff the cut**: `bring_to_head`'s body followed by the remainder's is the original `prepare_database` body, statement for statement — checked by concatenating the two and comparing against `git show fb290538:src-tauri/src/schema.rs`: byte for byte, 131 lines
- [x] `errors.rs`: `kind_of` and `every_scryfall_failure_classifies` stay in a `src-tauri` remainder that re-exports the rest
- [x] `capture.rs`: the three stay-behind tests go to `src-tauri/src/sync_engine/capture_tests.rs`, with the helpers they use exposed through the feature
- [x] The core's `lib.rs` module map and crate doc; `sync_engine/mod.rs` on both sides
- [x] The fence's "the sweep reached" list names two files from this step. `schema`'s one test-side `Instant::now()` stayed in `src-tauri` with its test; **the fence found a second the plan had not** — `capture`'s `#[ignore]`d benchmark — which goes through `Tick`
- [x] **Found by the suite, not planned**: `image_uri::is_allowed_host` widened to loopback under `cfg!(test)`, which is off in a dependency — ten `images` tests were served the placeholder. It follows the `testing` feature, and `platform::fence` gains `no_member_asks_for_the_test_scaffolding_outside_its_tests`, which reads every workspace manifest

### Task 5 — the fences that read Rust by path (a second agent, in parallel)

**Files:** whatever in `src/`, `.storybook/`, `mobile/` and `scripts/` imports or reads one of the ten moved files.

- [x] Every `?raw` import, `readFileSync` and glob that names a moved file points at `crates/grimoire-core/src/…`; a path in prose is corrected too
- [x] `scripts/ci-route.test.mjs`, `scripts/coverage-rust.mjs`, `.storybook/fake/parity.test.ts`: read, and changed only if a moved file is named
- [x] `npm run test:run` for the touched suites; nothing that runs cargo

### Task 6 — the record

- [x] `crates/grimoire-core/CLAUDE.md`: what is here now, the `testing` feature, the two remainders and when each goes home, `platform`'s two new answers
- [x] `docs/reference/light-app.md` §6.2: what moved, what waits and why, what was measured, what is open
- [x] The spec's §2.8, dated; `platform/mod.rs`'s table
- [x] Every sentence elsewhere this makes false: `src-tauri/CLAUDE.md` (the scratch rule, the six-connections census's grep, `schema::` paths that name a file), the root `CLAUDE.md` if any
- [x] Issue #761: step 2 ticked with what it moved; steps 4 and 6 gain what was deferred; the fence item settled

### Task 7 — verify and ship

- [x] `cargo fmt -p mtg-grimoire -p grimoire-core --check`; `cargo clippy --workspace --all-targets --locked -- -D warnings`
- [x] `cargo test --workspace`; the test-attribute count against the baseline above
- [x] `npm run build`, `npm run lint`, `npm run test:run`. **The card-scanner suite was not run here**: nothing under `crates/card-scanner` changed, and CI's `rust` job runs it
- [x] The core for `wasm32-unknown-unknown`, build and clippy, with `CC_wasm32_unknown_unknown` pointed at `C:\Program Files\LLVM\bin\clang.exe`
- [x] `cargo tree -p mtg-grimoire -e features -i grimoire-core` without dev-dependencies: no `testing`
- [x] **The live pass — which became an A/B, because the main checkout's data was at user schema v46.** A reopen that changes nothing was not on offer: this build owes that file thirteen rungs. So two byte copies, one launched under a binary built from `main` at `fb290538` and one under this branch's, each stopped 20 s after reaching v59, compared table by table and row by row; then `tauri dev` on a third copy, driven over CDP, with the launch's card sync left to finish. [light-app.md](../../reference/light-app.md) §6.2 has every figure
- [ ] PR linked to #761, auto-merge armed; `ci-ok` green, including `core` on both targets — the Android compile runs only there

## What step 3 inherits

- `AppState`, `with_write` and the update hook: `sync.rs` still holds all three, and `collection_source::with_write_owned` waits on them.
- The two remainders in `src-tauri` — `schema.rs` and `errors.rs` — and the stay-behind tests, each with the step that takes it home.
- `platform::pause`'s browser arm has never run. Step 3 is where one write connection in a Worker gets its real answer.
- `std::fs` in `schema`, for the I/O step.
