# The Web Target — the Rust core in a browser, on OPFS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile this app's Rust core to `wasm32-unknown-unknown`, run it inside a dedicated Worker with its SQLite database in OPFS, and have the React frontend talk to it through the `Core` interface Phase 1 already shipped — with the second browser tab refused by an explanatory page rather than a stack trace.

**Architecture:** `src-tauri`'s crate learns a second target. `Cargo.toml` splits its dependencies at `cfg(target_family = "wasm")`; `lib.rs` splits into a module map, a desktop half (`desktop.rs`, holding all 136 `#[tauri::command]` wrappers and `run()`), and a wasm half (`web/`). A new `web::route` maps a command name plus JSON arguments onto the same pure functions the Tauri commands call, and is compiled on **every** target so `cargo test` covers it. `web::glue` is the thin `#[wasm_bindgen]` shell around it. On the frontend, `src/lib/core/browser.ts` implements `Core` by posting to `src/workers/db.ts`, which owns the wasm module and therefore the whole database.

**Tech Stack:** Rust 2021, `rusqlite 0.40` (its **default** wasm FFI backend, `sqlite-wasm-rs`), `sqlite-wasm-vfs 0.2` (`opfs-sahpool`), `wasm-bindgen 0.2.127`, `reqwest 0.12` with `stream`, `flate2`. React 19 + TypeScript 6, Vite 7, a second Vite config for the web build. clang is a new build requirement.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §4 (Boundary B), §5 (the whole web target), §8 (performance), §9 (verification). This is **PR 4** of the §10 sequence.

**Measurements:** [`docs/superpowers/research/2026-08-27-wasm-core-spike.md`](../research/2026-08-27-wasm-core-spike.md). Every number in this plan is cited from there; **none of it is re-derived**, and the spike's throwaway probes under `spike/` are the reference implementation for four of these tasks.

---

## What the spike settled, and must not be re-litigated

| Fact | Consequence for this PR |
| --- | --- |
| `rusqlite 0.40` targets wasm **natively** — `sqlite-wasm-rs` is its declared FFI backend, in the **default** feature set | The manifest change is four lines. There is no shim to write. |
| **`default-features = false` breaks it**, with `unresolved import libsqlite3_sys` | That error reads exactly like "wasm unsupported" and is the opposite of the truth. Task 2 mutates the manifest to reproduce it deliberately, so nobody loses a build to it twice. |
| Cross-origin isolation is **not required** — measured with and without COOP/COEP, identical | **Do not add COOP/COEP anywhere**, and do not make the PWA's service worker re-attach them. The whole "works on first load, breaks on the second" class of bug is designed out. |
| `navigator.storage.estimate()` reported **647 MB, then 7 MB**, for the same 532.8 MB file | **Never gate an ingest on it.** It may be *reported*; it may not be a pre-flight. |
| clang is required — `sqlite-wasm-rs` compiles SQLite's C amalgamation with `cc`, and MSVC cannot emit wasm | A new CI job with a clang install, and a new local prerequisite. Task 9. |
| `PRAGMA journal_mode = WAL` answers **`delete`** on the sahpool VFS | The web target runs a rollback journal. Durability differs from desktop. Task 3 makes the app *report* which journal it got rather than assume. |
| `opfs-sahpool` permits **one connection**, and a second document fails with `NoModificationAllowedError` | Two consequences, both structural: the whole database lives in one Worker, and `AppState.db_read` — the app's second, read-only connection — cannot exist here. Tasks 3 and 8. |
| `reqwest::Response::bytes_stream()` works on wasm as of 0.12.28, gated on `feature = "stream"`, **which `src-tauri` already enables** | No hand-rolled `web_sys` ReadableStream. Task 6 streams with the same call the desktop uses. |
| `User-Agent` is a forbidden header for `fetch` | The browser sends its own. That is a real UA rather than an absent one — which is what Scryfall's rule is about — but it is **not** the app-identifying string the desktop sends. Written down in Task 10's doc. |
| Measured first runs, Chrome 151, release wasm: `default_cards` **10.4 s** desktop / 36.5 s phone; Spellbook combos **12.6 s** / 23.1 s, **2.01 MB peak framing buffer** | Task 10 re-measures against the *real* 43-column ingest and records both columns. A slower number is a finding, not a failure — the spike's row was a 20-column subset. |

---

## Why this PR is shaped the way it is

### 1. The command surface is a **first slice**, and that is deliberate

There are **136** `#[tauri::command]`s across **30** files. Porting all of them means porting every module they live in, and that is several PRs of work, not one. This PR ports the modules that stand between an empty OPFS file and a working **browse** — and routes **four** commands: `search_cards`, `list_sets`, `facet_cards`, `sync_status`.

That is not a token slice. It is the app's most expensive read path (`search::run_search` rides SQLite; `facets::compute` rides the in-memory index), which is exactly the pair spec §8 says must be measured in wasm rather than guessed. Adding a fifth command once its module is in the map is a two-line edit to `route::COMMANDS` and `route::call`.

### 2. The module map, named exactly

`lib.rs`'s module list splits in two. **Every module in the left column compiles for `wasm32-unknown-unknown` after this PR**; every module in the right column is `#[cfg(not(target_family = "wasm"))]` and stays desktop-and-Android for now.

| Compiled for wasm | Desktop/Android only (this PR) |
| --- | --- |
| `card_row` · `collection_source` · `combos` · `db` · `errors` · `feed` · `filters` · `index` · `ingest` · `legalities` · `maintenance` · `schema` · `search` · `slug` *(new)* · `sorting` · `sync` · `web` *(new)* | `card` · `collection` · `collection_alloc` · `collection_folders` · `deck` · `deck_audit` · `deck_meta` · `deck_theory` · `deck_undo` · `export` · `flatten` · `images` · `import` · `listview` · `marketplace` · `marketplace_feed` · `mirror` · `nav` · `paths` · `reconcile` · `reset` · `scryfall` · `tags` · `transfer` · `update` · `window` · `wishlist` · `wishlist_folders` · `zoom` |

Four of those are permanent, per spec §6.3: `mirror`, `transfer` (the Rust writer), `update` (the portable swap), `window`. The rest are "not yet", and `images` is a special case — on web the image cache is Cache Storage, not a filesystem, so it is a rewrite rather than a port.

**`scryfall` is on the right for a reason worth stating.** `Client::new` calls `.user_agent()`, `.connect_timeout()` and `.read_timeout()` on `reqwest::ClientBuilder` — none of which exist on the wasm backend — and its pacing gate is a `tokio::sync::Mutex<tokio::time::Instant>`. Its `download` writes a resumable partial file with `tokio::fs`. A browser can set none of that: `User-Agent` is forbidden, there are no fetch timeouts to set, and OPFS has no partial-download story. So the browser gets its own small fetcher (`web::net`) rather than a mangled `Client`.

### 3. Four things the shipped Phase 1 code does that the spec does not mention

Each was checked against the real files in `D:\Code\mtg-grimoire\.claude\worktrees\pr1-feed-pipeline` and `…\pr2-boundary-a`, not against the spec's prose.

**a. `ingest_stream` takes a *synchronous* `Iterator`, and a browser cannot produce one.** The shipped signature is:

```rust
pub fn ingest_stream(
    db: &Mutex<Connection>,
    chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>,
    progress: &mut dyn FnMut(u64),
) -> Result<IngestStats, IngestError>
```

`combos::read_stream` has the same shape. Spec §4.3 says only "it becomes *takes a stream of lines*", and on desktop a blocking iterator is exactly that. In wasm it is not: `bytes_stream()` yields a `futures_core::Stream` that must be `.await`ed, and there is no thread to block — the same argument that killed `Deserializer::from_reader` for the combo feed kills a pull iterator here. **Task 4 turns both into push-shaped sinks** and rebuilds the existing `*_stream` functions as thin loops over them, so desktop behaviour and every existing test are unchanged.

**b. `AppState` holds *two* connections, and OPFS permits one.** `db: Mutex<Connection>` and `db_read: Mutex<Connection>` (`src-tauri/src/sync.rs:87-117`). `sync::lock_db_read` exists so a search never queues behind an ingest. On the sahpool VFS a second connection is a hard failure, so on wasm `db_read` is `cfg`'d away and `lock_db_read` returns the write connection. Task 3.

**c. `db::lock_for` calls `Instant::now()` and `std::thread::sleep`, both of which are landmines on `wasm32-unknown-unknown`.** `std::time::Instant::now()` **panics** there. It is reached from `sync::with_write`, which every user-facing write goes through — including the ones this PR does not yet route, which is why it must be fixed now rather than when the first write lands. Its own doc already says a `Duration::ZERO` timeout is "exactly one `try_lock` with no sleeping at all", and the wasm arm is precisely that. Task 3.

**d. `schema.rs` depends on `tags::normalize`, and `tags/mod.rs` cannot compile for wasm.** One call site — `schema.rs:876`, `crate::tags::normalize(slug)` — pulls a 1 500-line module with `use tauri::Emitter`, `tokio`, feed downloads and four command-bearing submodules into the map for one pure ASCII fold. Task 1 moves the function out.

### 4. What this PR does **not** do

- No PWA manifest, no service worker, no update bar, no evicted-corpus recovery. That is **PR 5**, spec §5.2/§5.4.
- No mobile layout. That is Phase 5.
- No sync, no pairing, no relay. That is Phase 3 and shares no files with this.
- **No Mana Pool on web** — spec §5.3 settled it (`manapool.com` sends no `Access-Control-Allow-Origin`; Card Kingdom does). Neither price feed is routed here anyway; the marketplace picker's web behaviour lands with `marketplace_feed`.
- No COOP/COEP. See the table above.

---

## Global Constraints

Copied from the repo's `CLAUDE.md`, `src-tauri/CLAUDE.md` and the spec; every task's requirements implicitly include these.

- **`npm run verify` is `npm run build && npm run lint && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml`.** Run it before every commit. **Redirect it to a file and grep the file** — reading the exit code after a trailing pipe gives you the pipe's status, not npm's.
- `verify` runs **neither `cargo fmt` nor `cargo clippy`**, and those are the only two reds a fully green verify can still produce. Run both in `src-tauri/` before each commit. **clippy caps function arguments at 7.**
- **Never install `@types/node`.** `xlsx` is banned. TypeScript stays on 6.0.x.
- **Adding a dependency with permissions means adding its narrowest permission, never its `:default`.** Nothing in this PR adds a Tauri plugin, so nothing here touches `capabilities/default.json`.
- **Never hand-write rows into `cards` or `sync_meta`.** Rust tests use `Connection::open_in_memory()` plus `crate::schema::migrate`.
- **`data/` is the user's and is never committed.** Neither is `web/public/wasm/`, which is generated.
- Commit messages use `feat:` / `fix:` / `chore:` / `test:` / `refactor:`.
- **A module the crate never declares compiles nothing and runs no tests, and the suite stays green reporting on nothing.** Every task below that creates a module declares it in the *same step* as its first test. `cargo test <filter>` matching zero tests **exits 0** — always read the count, never just the word `ok`.
- Ports: 1420 (`tauri dev`), 6006 (Storybook), 9222 (the Tauri window's CDP) are hardcoded in tracked files and must not be remapped. The web dev server and its browser take **5173** and **9333**, which is what the spike used and what the Storybook-screenshot recipe already established for a second browser.

---

### Task 1: `slug::normalize` — the tag key leaves the tagger

**Files:**
- Create: `src-tauri/src/slug.rs`
- Modify: `src-tauri/src/lib.rs` — declare `pub mod slug;`
- Modify: `src-tauri/src/tags/mod.rs` — delete `normalize` and its test, re-export
- Modify: `src-tauri/src/schema.rs:876` — call the new path

**Interfaces:**
- Consumes: nothing.
- Produces: `crate::slug::normalize(&str) -> String`. `crate::tags::normalize` keeps working, as a re-export, so the five call sites inside `tags/` and `schema.rs`'s test at 8296 are untouched.

> **Why a whole module for six lines.** `schema.rs` is on the wasm side of the map and `tags/` is not — `tags/mod.rs` opens with `use crate::sync::AppState; use flate2::read::GzDecoder; … use tauri::Emitter;` and carries four command-bearing submodules and a feed download. One pure ASCII fold is not a reason to drag any of that across. It is also, on its own terms, the right home: the fold is what makes two spellings of a name the *same key*, which is a fact about a slug rather than about Scryfall's taxonomy.

- [ ] **Step 1: Create the test module, declare it, and delete the old copy — all in one step**

Create `src-tauri/src/slug.rs` with its module doc and its tests, and **no implementation**:

```rust
//! Folding a name to the key two spellings of it share.
//!
//! Here rather than in [`crate::tags`] because the fold is a fact about a *slug*, and
//! because `tags` does not compile for `wasm32-unknown-unknown` — it opens with
//! `use tauri::Emitter` and owns two feed downloads — while [`crate::schema`], its one
//! caller outside that module, must.

#[cfg(test)]
mod tests {
    use super::*;

    /// The four spellings are the ones measured against Scryfall on 2026-08-20:
    /// `otag:"spot removal"`, `otag:spot-removal`, `otag:spotremoval` and
    /// `otag:SPOT-REMOVAL` each returned exactly 4,907 cards, so all four have to fold to
    /// one key here.
    #[test]
    fn every_spelling_of_a_tag_name_normalises_to_one_key() {
        for spelling in [
            "spot removal",
            "spot-removal",
            "spotremoval",
            "SPOT-REMOVAL",
        ] {
            assert_eq!(normalize(spelling), "spotremoval", "{spelling}");
        }

        // Digits are kept — `cycle-2` and `cycle2` are one tag, and dropping the 2 would
        // fold it onto `cycle`.
        assert_eq!(normalize("Cycle-2"), "cycle2");
        // And a name with nothing alphanumeric in it normalises to nothing, which is a
        // needle that matches no row rather than one that matches every row.
        assert_eq!(normalize("---"), "");
    }

    /// The re-export in `tags` is what keeps five call sites inside that module — and
    /// `schema`'s own test — spelled the way they always were. A re-export that quietly
    /// stopped pointing here would be invisible everywhere else.
    #[test]
    fn the_tags_re_export_is_this_function() {
        assert_eq!(crate::tags::normalize("Spot-Removal"), normalize("Spot-Removal"));
    }
}
```

In `src-tauri/src/lib.rs`, add `pub mod slug;` in alphabetical position among the existing `pub mod` declarations — between `pub mod search;` and `pub mod sorting;`.

Then, in the same step, **delete `pub fn normalize` and its doc comment from `src-tauri/src/tags/mod.rs`** and delete the `every_spelling_of_a_tag_name_normalises_to_one_key` test from that file's test module — it has moved above. Put nothing in their place yet.

> ⚠️ **All three edits belong in this step, and the module declaration especially.** Phase 1's plan put a module declaration after its first failing-test step, cargo reported `running 0 tests … ok` and exited 0, and the task had no first failure at all. A red that cannot be produced is not a red. Deleting the old copy now is the other half of the same rule: with `tags::normalize` still present, `slug.rs`'s re-export test would pass against the function it is supposed to be replacing, which is a green that proves nothing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test slug:: 2>&1 | tail -20`

Expected: **compile errors**, from two directions at once —

- ``cannot find function `normalize` in this scope`` in `slug.rs`'s own tests, because the implementation is not there yet;
- ``cannot find function `normalize` in module `crate::tags` `` from `schema.rs:876`, `tags/query.rs` and `tags/muted.rs`, because the old copy is gone and nothing has replaced it.

That is the honest first red: the new home is empty and every caller is broken.

- [ ] **Step 3: Write the minimal implementation**

Add to `src-tauri/src/slug.rs`, above its test module:

```rust
/// A tag name reduced to what Scryfall matches on: lowercase, every non-alphanumeric
/// removed.
///
/// **One copy, deliberately.** The ingest writes it into `slug_norm` and the search
/// compares a typed needle against that column; if the two ever normalised differently the
/// search would match nothing and no test would fail, because each half would still be
/// self-consistent.
///
/// Verified live 2026-08-20 — `otag:"spot removal"`, `otag:spot-removal`, `otag:spotremoval`
/// and `otag:SPOT-REMOVAL` all return exactly 4,907 cards.
pub fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}
```

In `src-tauri/src/tags/mod.rs`, at the point where `normalize` used to be (just after `fn staging`), put:

```rust
/// A tag name reduced to what Scryfall matches on.
///
/// **The function moved to [`crate::slug`] and this is the same one**, re-exported so that
/// every caller inside this module keeps its spelling. It moved because `schema` needs it
/// and `schema` compiles for `wasm32-unknown-unknown`, which this module does not.
pub use crate::slug::normalize;
```

`stronger` and `WEIGHTS` stay in `tags`, and `the_closure_keeps_the_strongest_weight_of_the_taggings_it_descends_from` stays with them: those are Scryfall's weighting vocabulary rather than a key, and nothing outside `tags/` reads them in code.

In `src-tauri/src/schema.rs`, change line 876 from `crate::tags::normalize(slug)` to `crate::slug::normalize(slug)`, and update the doc comment four lines above it that says "through [`crate::tags::normalize`]" to say "through [`crate::slug::normalize`]".

- [ ] **Step 4: Run the tests and confirm the count moved**

Run: `cd src-tauri && cargo test slug:: 2>&1 | tail -12`
Expected: `test result: ok. 2 passed`. **Confirm the number is 2 and not 0** — a filter that selects nothing also exits 0.

Then run the whole suite: `cd src-tauri && cargo test 2>&1 | tail -12`. Every pre-existing tag and schema test must still pass; they are what proves the re-export points at the same function.

- [ ] **Step 5: Mutate to prove the tests bite**

Temporarily change `slug::normalize` to keep non-alphanumerics (drop the `.filter(…)`). Run `cargo test 2>&1 | tail -20`.

Expected: `slug::tests::every_spelling_of_a_tag_name_normalises_to_one_key` FAILS, **and so does at least one test inside `tags::query`** — which is the point: the re-export means one function serves both. Revert.

**If the `tags::query` side survives the mutation, stop and report it** — that would mean the re-export is not actually what those call sites resolve to.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/slug.rs src-tauri/src/lib.rs src-tauri/src/tags/mod.rs src-tauri/src/schema.rs
git commit -m "refactor(tags): the slug fold moves out of the tagger

schema.rs calls normalize once, and that one call was enough to require tags/mod.rs - which
opens with use tauri::Emitter, owns two feed downloads and four command-bearing submodules -
on a target where none of that can compile. The fold is a fact about a slug rather than about
Scryfall's taxonomy, so it gets its own module and tags re-exports it. Five call sites inside
tags/ and one test in schema.rs keep their spelling unchanged."
```

---

### Task 2: The manifest split, the build script, and a wasm build that compiles

**Files:**
- Modify: `src-tauri/Cargo.toml` — the target-conditional dependency tables
- Modify: `src-tauri/build.rs` — skip `tauri_build` for a wasm target
- Create: `src-tauri/src/desktop.rs` — everything `lib.rs` holds today below the module list
- Modify: `src-tauri/src/lib.rs` — the module map, and two lines of glue
- Modify: `src-tauri/src/sync.rs` — gate `AppState`'s desktop fields, the sync driver, `insert_sets`
- Modify: `src-tauri/src/errors.rs` — gate `kind_of`
- Modify: `src-tauri/src/combos.rs` — gate the download, the events and the commands
- Modify: `src-tauri/src/maintenance.rs` — gate `reclaim_freed_pages`
- Modify: `src-tauri/src/index/lifecycle.rs` — gate `spawn_build`
- Modify: `src-tauri/src/search.rs`, `src-tauri/src/index/facets.rs` — gate the three command wrappers

**Interfaces:**
- Consumes: `crate::slug` from Task 1.
- Produces: a crate that builds for `wasm32-unknown-unknown`. `mtg_grimoire_lib::run` is unchanged for every other target, and `main.rs` is untouched.

> **The one trap the spike paid for, quoted so it is not paid for twice.** `default-features = false` on the wasm `rusqlite` line switches off `ffi-sqlite-wasm-rs`, and rusqlite then fails with `unresolved import libsqlite3_sys` — which reads exactly like "rusqlite does not support wasm" and is the opposite of the truth. Step 6 reproduces it on purpose.

> **`build.rs` runs for the host, not the target.** A `#[cfg(target_family = "wasm")]` inside a build script asks about the machine cargo is running on and will always be false. The question has to be asked of the `TARGET` environment variable. This matters because `tauri_build::build()` resolves plugin ACL permissions **through the dependency graph** — `Cargo.toml`'s own comments say so twice — and this task target-gates every plugin off the wasm build, which would leave `capabilities/default.json`'s `snap-layout:` and `mcp-bridge:` entries unresolvable and fail the build.

- [ ] **Step 1: Split the manifest**

In `src-tauri/Cargo.toml`, move `tauri`, the five `tauri-plugin-*` lines, `tokio`, `sha2`, `zip` and `image` out of `[dependencies]` and into a new target table, and add a wasm table. **Keep every existing comment with the line it documents** — they carry the reasons for the plugin choices and the absent reqwest `gzip` feature, and none of that changes here.

What stays in `[dependencies]`, unconditionally — verified as wasm-clean by the spike:

```toml
[dependencies]
# … the existing comments for each of these stay exactly where they are …
rusqlite = { version = "0.40", features = ["bundled", "hooks"] }   # ← moves, see below
unicode-normalization = "0.1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
flate2 = "1"
# rustls, never native-tls, and deliberately NO `gzip` feature. Spike-verified 2026-08-27:
# this exact line, `default-features = false` and all, compiles clean for wasm32 — the wasm
# backend is `fetch` and ignores the TLS feature — and `bytes_stream()` is available there
# because `stream` is on.
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "stream"] }
futures-util = "0.3"
```

Then, replacing the `rusqlite` line above and gathering the desktop-only crates:

```toml
# ── Desktop and Android ──────────────────────────────────────────────────────────
# Everything here is either impossible in a browser or pointless there. `bundled` is
# libsqlite3-sys compiling sqlite3.c with the host compiler, which is right on Windows and
# impossible in a webview; `tokio`'s `fs` has no browser counterpart; `zip`, `image` and
# `sha2` serve the portable updater and the cover-image encoder, both desktop-only by
# spec §6.3.
[target.'cfg(not(target_family = "wasm"))'.dependencies]
rusqlite = { version = "0.40", features = ["bundled", "hooks"] }
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
tauri-plugin-clipboard-manager = "2"
tauri-plugin-single-instance = "2"
tauri-plugin-snap-layout = "1"
tauri-plugin-mcp-bridge = "0.12"
tokio = { version = "1", features = ["fs", "io-util", "rt", "sync", "time"] }
sha2 = "0.10"
zip = { version = "2", default-features = false, features = ["deflate"] }
image = { version = "0.25", default-features = false, features = [
    "png",
    "jpeg",
    "gif",
    "bmp",
    "webp",
] }

# ── Web ──────────────────────────────────────────────────────────────────────────
# ⚠️ NEVER add `default-features = false` to this rusqlite line. `ffi-sqlite-wasm-rs` — the
# FFI backend that makes wasm work at all — is in rusqlite's DEFAULT feature set, and
# switching it off fails the build with `unresolved import libsqlite3_sys`, which reads
# exactly like "wasm is unsupported" and is the opposite of the truth. It cost the spike a
# build; see the research doc's Assumption 1.
#
# `hooks` and not `bundled`: `hooks` was asserted live in a browser (probe 1 —
# `update_hook` fired three times for three writes), and `bundled` is a host C compile.
# SQLite here is 3.53.0 with FTS5, DBSTAT, COLUMN_METADATA and PREUPDATE_HOOK.
[target.'cfg(target_family = "wasm")'.dependencies]
rusqlite = { version = "0.40", features = ["hooks"] }
# The OPFS VFS. Same author as the FFI crate rusqlite already depends on, and both sit on
# `rsqlite-vfs 0.1`, so the versions align without pinning. Its README marks all three of
# its VFSes "No COOP/COEP requirements", and that was tested rather than quoted.
sqlite-wasm-vfs = "0.2"
# Pinned to the patch, because `wasm-bindgen-cli` must match the crate EXACTLY and a
# mismatch is a runtime failure with an unhelpful message. `scripts/build-wasm.mjs`
# re-checks the pair before every build.
wasm-bindgen = "=0.2.127"
wasm-bindgen-futures = "0.4"
js-sys = "0.3"
console_error_panic_hook = "0.1"

[target.'cfg(target_family = "wasm")'.dependencies.web-sys]
version = "0.3"
features = ["Navigator", "StorageManager", "WorkerGlobalScope", "WorkerNavigator"]
```

`[target.'cfg(windows)'.dependencies]`, `[build-dependencies]` and `[dev-dependencies]` are unchanged.

- [ ] **Step 2: Teach `build.rs` about the target**

Replace `src-tauri/build.rs` entirely:

```rust
fn main() {
    // A build script always compiles for the HOST, so `cfg!(target_family = "wasm")` here
    // would ask about the wrong machine and always be false. `TARGET` is the question.
    //
    // `tauri_build::build()` resolves each plugin's ACL permissions through the dependency
    // graph — which is why `Cargo.toml` keeps `tauri-plugin-snap-layout` and
    // `tauri-plugin-mcp-bridge` as plain dependencies rather than target-gated ones. The
    // wasm build gates every plugin off, so running it here would fail on
    // `capabilities/default.json` entries it can no longer resolve. It also has nothing to
    // do: there is no `frontendDist` to embed and no binary to sign.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.starts_with("wasm32") {
        return;
    }
    tauri_build::build()
}
```

- [ ] **Step 3: Move the desktop half of `lib.rs` out**

Create `src-tauri/src/desktop.rs` and move into it **everything `src/lib.rs` currently holds from line 44 (`use std::path::Path;`) to the end of the file** — the `use` lines, `SCRYFALL_API`, all seventeen `#[tauri::command]`s defined there, `update_api_base`, `focus_existing_window`, `pub fn run()`, and the `#[cfg(test)] mod tests` at the bottom. Nothing is edited: every path in it is already `crate::`-rooted or local, and both spellings still resolve from a submodule.

Give the new file this header:

```rust
//! Everything that only exists when there is a Tauri window: the command registry, the
//! app's startup, and the seventeen commands that have no module of their own.
//!
//! Split out of `lib.rs` so that the crate's *module map* is the only thing at the root.
//! `lib.rs` is then readable as the one place that says what compiles where, and this file
//! is `#[cfg(not(target_family = "wasm"))]` in one line rather than in a hundred.
```

Then reduce `src-tauri/src/lib.rs` to the module map plus two lines of glue. Its full new contents:

```rust
//! The crate's module map, and nothing else.
//!
//! **The left column below compiles for `wasm32-unknown-unknown`; the right does not.**
//! Four of the exclusions are permanent (spec §6.3): the plain-text `mirror`, the Rust
//! `transfer` writer that exists only for it, the portable `update` swap, and `window`'s
//! Win32 snap layouts. The rest are "not yet" — they are ported with the commands that
//! need them. `images` is neither: on web the image cache is Cache Storage rather than a
//! filesystem, so it is a rewrite and not a port.

// ── Every target ─────────────────────────────────────────────────────────────────
pub mod card_row;
pub mod collection_source;
pub mod combos;
pub mod db;
pub mod errors;
pub mod feed;
pub mod filters;
pub mod index;
pub mod ingest;
pub mod legalities;
pub mod maintenance;
pub mod schema;
pub mod search;
pub mod slug;
pub mod sorting;
pub mod sync;
pub mod web;

// ── Desktop and Android ──────────────────────────────────────────────────────────
#[cfg(not(target_family = "wasm"))]
pub mod card;
#[cfg(not(target_family = "wasm"))]
pub mod collection;
#[cfg(not(target_family = "wasm"))]
pub mod collection_alloc;
#[cfg(not(target_family = "wasm"))]
pub mod collection_folders;
#[cfg(not(target_family = "wasm"))]
pub mod deck;
#[cfg(not(target_family = "wasm"))]
pub mod deck_audit;
#[cfg(not(target_family = "wasm"))]
pub mod deck_meta;
#[cfg(not(target_family = "wasm"))]
pub mod deck_theory;
#[cfg(not(target_family = "wasm"))]
pub mod deck_undo;
#[cfg(not(target_family = "wasm"))]
pub mod export;
#[cfg(not(target_family = "wasm"))]
pub mod flatten;
#[cfg(not(target_family = "wasm"))]
pub mod images;
#[cfg(not(target_family = "wasm"))]
pub mod import;
#[cfg(not(target_family = "wasm"))]
pub mod listview;
#[cfg(not(target_family = "wasm"))]
pub mod marketplace;
#[cfg(not(target_family = "wasm"))]
pub mod marketplace_feed;
#[cfg(not(target_family = "wasm"))]
pub mod mirror;
#[cfg(not(target_family = "wasm"))]
pub mod nav;
#[cfg(not(target_family = "wasm"))]
pub mod paths;
#[cfg(not(target_family = "wasm"))]
pub mod reconcile;
#[cfg(not(target_family = "wasm"))]
pub mod reset;
#[cfg(not(target_family = "wasm"))]
pub mod scryfall;
#[cfg(not(target_family = "wasm"))]
pub mod tags;
#[cfg(not(target_family = "wasm"))]
pub mod transfer;
#[cfg(not(target_family = "wasm"))]
pub mod update;
#[cfg(not(target_family = "wasm"))]
pub mod window;
#[cfg(not(target_family = "wasm"))]
pub mod wishlist;
#[cfg(not(target_family = "wasm"))]
pub mod wishlist_folders;
#[cfg(not(target_family = "wasm"))]
pub mod zoom;

#[cfg(not(target_family = "wasm"))]
mod desktop;
#[cfg(not(target_family = "wasm"))]
pub use desktop::run;
```

- [ ] **Step 4: Gate the items the wasm modules cannot carry**

Each of these is a `#[cfg(not(target_family = "wasm"))]` on an existing item — no bodies change.

`src-tauri/src/sync.rs`:

- Line 34: split `use crate::{ingest, scryfall};` into `use crate::ingest;` and a gated `#[cfg(not(target_family = "wasm"))] use crate::scryfall;`.
- Line 41: gate `use tauri::Emitter;`.
- In `pub struct AppState`, gate four fields — `db_read`, `client`, `images`, `mirror`, `mirror_status` — leaving `db`, `data_dir`, `syncing` and `index` on every target. Put this above `db_read`:

```rust
    /// **Desktop and Android only, and the reason is the VFS.** `opfs-sahpool` holds
    /// exclusive access handles and permits exactly one connection to a database — a second
    /// one fails hard with `NoModificationAllowedError` rather than queueing. So on web
    /// there is nothing for this field to hold, and [`lock_db_read`] answers with the write
    /// connection instead. A search there *does* queue behind an ingest; that is a real
    /// difference from desktop, not an oversight, and it is why the whole database lives in
    /// one Worker.
    #[cfg(not(target_family = "wasm"))]
    pub db_read: Mutex<Connection>,
```

- Gate `insert_sets` (it takes `&[scryfall::SetRow]`), `emit`, `emit_done`, `run_sync`, `note_mirror_after_sync`, `note_scryfall`, `persist_penalty`, `finish_unchanged`, `reconcile_ids`, `reclaim_freed_pages`, `compact_once` and `do_sync`. Leave `get_meta`, `set_meta`, `set_meta_opt`, `should_check`, `already_ingested`, `conditional_etag`, `check_download_size`, `unix_now`, `read_stored_state`, `count_cards`, `sets_are_empty`, `mark_checked`, `unchanged`, `done_message`, `group_digits`, `lock_db`, `lock_conn`, `lock_plain`, `with_write`, `note_database` and `status` on every target.
- Rewrite `lock_db_read`'s body so the doc and the code both state the split:

```rust
pub(crate) fn lock_db_read(state: &AppState) -> MutexGuard<'_, Connection> {
    #[cfg(not(target_family = "wasm"))]
    {
        lock_conn(&state.db_read)
    }
    // One connection is all the sahpool VFS permits, so the read path is the write path.
    #[cfg(target_family = "wasm")]
    {
        lock_conn(&state.db)
    }
}
```

- In `status`, gate the one field that reads a desktop-only member:

```rust
        // An atomic in memory, so this one is answered even when the read above was not.
        #[cfg(not(target_family = "wasm"))]
        image_store_failures: state.images.store_failures(),
        // No filesystem image cache on web — the browser's is Cache Storage, and it is not
        // built yet. Zero is the honest answer for "failures writing a store that does not
        // exist", and it is what the field means on a desktop that has had none.
        #[cfg(target_family = "wasm")]
        image_store_failures: 0,
```

`src-tauri/src/errors.rs`: gate `kind_of` — it takes `&crate::scryfall::ScryfallError`.

`src-tauri/src/maintenance.rs`: gate `reclaim_freed_pages` (it calls `std::thread::sleep`, which has no meaning in a Worker).

`src-tauri/src/index/lifecycle.rs`: gate `spawn_build`. Add to its doc:

```rust
/// **Desktop and Android only.** In a browser the Worker *is* the thread: there is nothing
/// to spawn onto, and [`build_now`] is called inline instead. That is not a downgrade — the
/// Worker exists precisely so that a 1.8 ms index build and a 10 s ingest both happen off
/// the page's main thread.
```

`src-tauri/src/search.rs`: gate `search_cards` and `list_sets` (the two `#[tauri::command]` wrappers at 1090 and 1159). `run_search` and `run_list_sets` are untouched.

`src-tauri/src/index/facets.rs`: gate `facet_cards` (the wrapper at 857). `run_facets` is untouched.

`src-tauri/src/combos.rs`: gate `use tauri::Emitter;` (line 69), every `#[tauri::command]` in the file, `refresh_if_due`, `emit`, and the download path (`download_capped` and anything taking a `&Path` or an `AppHandle`). Leave `RawVariant`, `Combo`, `ComboFile`, `reduce`, `store`, `read_file`, `read_stream`, `ingest_stream` and `ingest_gz` on every target — `ingest_gz` takes a `&Path` but `std::fs::File::open` compiles for wasm and simply never succeeds there, which is cheaper than gating it.

> **A landmine to leave alone but know about.** `combos.rs:1096` and `sync.rs`'s `unix_now` both call `SystemTime::now()`, which **panics** on `wasm32-unknown-unknown`. Both sit inside functions this step gates out. Nothing on the wasm side may call them: `combos::store` takes `fetched_at: i64` as a parameter for exactly this reason, and Task 6 passes it in from `Date.now()`.

- [ ] **Step 5: Run the wasm build to verify it fails, then passes**

Prerequisites, once per machine:

```bash
rustup target add wasm32-unknown-unknown
# clang must be on PATH; on Windows that is LLVM's, e.g.
export PATH="$PATH:/c/Program Files/LLVM/bin"
clang --version   # 22.1.8 was what the spike used
```

Run: `cd src-tauri && cargo build --target wasm32-unknown-unknown --lib 2>&1 | tail -30`

Expected **before** Step 4's gates are complete: a wall of `unresolved import tauri` / `cannot find type AppHandle` errors naming exactly the items still to gate. That is the working red — it names the remaining work rather than merely failing.

Expected **after**: `Finished` with no errors. Then confirm the desktop side did not move:

```bash
cd src-tauri && cargo build 2>&1 | tail -5 && cargo test 2>&1 | tail -12
```

Both must be exactly as green as before this task, with the **same Rust test count** as Task 1 left behind — this task adds no tests and removes none, so a changed count means a module stopped being compiled.

- [ ] **Step 6: Mutate the manifest to reproduce the spike's trap**

Temporarily add `default-features = false` to the wasm `rusqlite` line:

```toml
rusqlite = { version = "0.40", default-features = false, features = ["hooks"] }
```

Run: `cd src-tauri && cargo build --target wasm32-unknown-unknown --lib 2>&1 | tail -20`

Expected: **`unresolved import libsqlite3_sys`**, exactly as the research records. Revert.

**If the build succeeds with `default-features = false`, stop and report it** — that would mean rusqlite's feature set has changed since 2026-08-27 and the comment in `Cargo.toml` is now wrong.

Then a second mutation, for `build.rs`: temporarily delete the `if target.starts_with("wasm32") { return; }` guard and re-run the wasm build. Expected: a `tauri-build` failure about an unresolvable permission or a missing `frontendDist`. Revert. **If it succeeds, report it** — the guard would then be load-bearing for a reason nobody has established.

- [ ] **Step 7: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs src-tauri/src/
git commit -m "feat(core): the crate learns wasm32-unknown-unknown

Cargo.toml splits at cfg(target_family = \"wasm\"); lib.rs becomes the module map and nothing
else, with the seventeen root commands and run() moved to desktop.rs so that the exclusion is
one cfg rather than a hundred.

Two things that are easy to get wrong and were verified rather than assumed. rusqlite must
NOT be given default-features = false on wasm - ffi-sqlite-wasm-rs is in its default set and
switching it off fails with 'unresolved import libsqlite3_sys', which reads like 'wasm is
unsupported' and is the opposite of the truth. And build.rs asks TARGET rather than cfg!,
because a build script compiles for the host: tauri_build resolves plugin ACLs through the
dependency graph, and this build has no plugins to resolve them from.

AppState loses db_read on web, because opfs-sahpool permits one connection to a database and
a second fails hard. lock_db_read answers with the write connection there instead."
```

---

### Task 3: `db` in a browser — the OPFS pool, one connection, and a lock that cannot sleep

**Files:**
- Modify: `src-tauri/src/db.rs` — extract `apply_pragmas`, add `Journal`, add the wasm arms of `open` and `lock_for`
- Modify: `src-tauri/src/index/lifecycle.rs` — `build_now` stops opening a connection of its own on wasm
- Test: the existing inline `#[cfg(test)] mod tests` in both files

**Interfaces:**
- Consumes: nothing.
- Produces: `db::Journal` (an enum), `db::apply_pragmas(&Connection) -> rusqlite::Result<Journal>`, `index::lifecycle::build_from(&AppState, &Connection) -> Result<(), String>`, and — on wasm only — `db::install_opfs_pool(directory: &str) -> Result<(), String>` and `db::open_pooled(file: &str) -> rusqlite::Result<(Connection, Journal)>`. `db::open`, `db::open_read_only`, `db::lock_for`, `db::lock_blocking` and `index::lifecycle::build_now` keep their exact signatures.

> **Why the journal becomes a value the app can read.** Spec §5.1: `PRAGMA journal_mode = WAL` answers `delete` on the sahpool VFS, and "anything that assumes WAL behaviour must be `cfg`-gated". The cheapest honest way to hold that line is to stop *assuming*: `open` already issues the pragma and throws the answer away, so make it return what SQLite actually chose. Then a desktop that silently fell off WAL — a database on a network share, a filesystem without shared memory — is visible too, which it is not today.
>
> `pragma_update` runs through `execute_batch`, which discards returned rows, so the current code cannot see the answer even in principle. That is why this is an extraction rather than a one-line read.

> **Why `lock_for` needs a wasm arm at all.** It opens with `let deadline = Instant::now() + timeout;`, and `std::time::Instant::now()` **panics** on `wasm32-unknown-unknown` — before the `try_lock`, so even a `Duration::ZERO` call panics. It is reached from `sync::with_write`, which is the single definition of "take the write connection or answer busy" for every user-facing write in the app. Its own doc already describes the right wasm behaviour: "A `timeout` of `Duration::ZERO` is exactly one `try_lock` with no sleeping at all". In a Worker there is one thread, so contention is impossible and a `WouldBlock` means the same thread already holds the guard — a bug to surface, not a wait to sit out.

- [ ] **Step 1: Write the failing test**

Append inside `src-tauri/src/db.rs`'s existing `mod tests`:

```rust
    /// A real file gets WAL. This is the assertion `open` has always *implied* and never
    /// made — `pragma_update` runs through `execute_batch`, which throws the answer away.
    #[test]
    fn a_file_database_reports_the_journal_it_actually_got() {
        let dir = std::env::temp_dir().join("mtgtest-db-journal");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("journal.db");

        let conn = Connection::open(&path).unwrap();
        assert_eq!(apply_pragmas(&conn).unwrap(), Journal::Wal);

        // And the pragmas that do not depend on the medium are on.
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1, "foreign keys must be enforced");
        let av: i64 = conn.query_row("PRAGMA auto_vacuum", [], |r| r.get(0)).unwrap();
        assert_eq!(av, 2, "auto_vacuum INCREMENTAL is 2");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An in-memory database cannot be on WAL, and saying so is the whole point: the web
    /// target gets `delete` from the sahpool VFS for the same kind of reason, and the app
    /// has to be able to *see* which journal it ended up on rather than assume one.
    #[test]
    fn an_in_memory_database_reports_memory_rather_than_wal() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(apply_pragmas(&conn).unwrap(), Journal::Memory);
    }

    /// The vocabulary is closed, and an unknown answer is `Other` rather than a panic or a
    /// wrong guess. `truncate` is a real SQLite journal mode this app never asks for.
    #[test]
    fn an_unrecognised_journal_name_is_other_and_not_a_guess() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "truncate").unwrap();
        // `open_in_memory` forces `memory` back, so this asserts the parser rather than the
        // pragma: every name outside the three the app knows lands on `Other`.
        assert_eq!(Journal::parse("truncate"), Journal::Other);
        assert_eq!(Journal::parse("DELETE"), Journal::Delete);
        assert_eq!(Journal::parse("wal"), Journal::Wal);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test db:: 2>&1 | tail -20`
Expected: **compile error** — ``cannot find function `apply_pragmas` in this scope`` and ``cannot find type `Journal` in this scope``. `db` is already declared in `lib.rs`, so this is a genuine compile failure and not an empty test run.

- [ ] **Step 3: Write the implementation**

In `src-tauri/src/db.rs`, add above `open`:

```rust
/// Which journal a connection actually ended up on.
///
/// A *value* rather than an assumption, because the answer is not the same on every
/// platform and the difference is about durability rather than speed. `PRAGMA journal_mode
/// = WAL` answers `delete` on the browser's `opfs-sahpool` VFS (measured 2026-08-27), and
/// a database on a filesystem without shared memory can answer `delete` on desktop too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Journal {
    /// Write-ahead logging — what desktop gets, and what `checkpoint_truncate` is for.
    Wal,
    /// A rollback journal. The web target's, and the only durability story available there.
    Delete,
    /// An in-memory database, which has no journal file to speak of.
    Memory,
    /// Something SQLite offers that this app never asks for. Never a panic and never a
    /// guess: a mode this build has not heard of must not be mistaken for one it has.
    Other,
}

impl Journal {
    /// Read SQLite's own answer. Case-insensitive: the pragma answers lowercase, but the
    /// value can also arrive from a stored string.
    pub fn parse(answer: &str) -> Journal {
        match answer.to_ascii_lowercase().as_str() {
            "wal" => Journal::Wal,
            "delete" => Journal::Delete,
            "memory" => Journal::Memory,
            _ => Journal::Other,
        }
    }
}

/// The app's standard PRAGMAs, and the journal SQLite settled on.
///
/// Split out of [`open`] so the browser's connection — which is opened through a VFS rather
/// than a path — gets exactly the same treatment, and so that the journal is a value the
/// caller can act on instead of a pragma nobody reads the answer to.
///
/// `journal_mode` is issued with `query_row` and not `pragma_update`: the latter goes
/// through `execute_batch`, which discards returned rows, so it cannot see the answer even
/// in principle. Everything else stays on `pragma_update`, which is the right shape for a
/// pragma that returns nothing.
pub fn apply_pragmas(conn: &Connection) -> rusqlite::Result<Journal> {
    // FIRST, before any statement writes a page. On a database that does not exist yet
    // this is free and permanent; once `journal_mode=WAL` has materialised the file it is
    // a no-op that only a full `VACUUM` can apply.
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    let journal: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_size_limit", JOURNAL_SIZE_LIMIT)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(Journal::parse(&journal))
}
```

Replace `open`'s body with:

```rust
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    apply_pragmas(&conn)?;
    Ok(conn)
}
```

Add, at the end of the non-test part of the file:

```rust
/// Install the browser's OPFS VFS and make it the default.
///
/// **Web only, and it must run inside a dedicated Worker.** `opfs-sahpool` holds exclusive
/// `FileSystemSyncAccessHandle`s, which are only obtainable off the main thread. That is
/// not a detail of the harness: it is why the whole database lives in one Worker and every
/// read and write in the app queues through it.
///
/// `initial_capacity` preallocates *files*, not bytes — the database, its rollback journal,
/// and headroom. Measured 2026-08-27: install 65 ms cold on a desktop, 40 ms to reattach an
/// existing 532.8 MB pool, 160 ms / 90 ms on a OnePlus 12.
///
/// **Cross-origin isolation is not required.** The same page was served with and without
/// `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
/// and passed both ways; the timing difference was cache noise. Do not add those headers.
///
/// The error is a `String` because the crate hands back a `JsValue`, and the caller needs
/// its *text*: a second tab is refused with `NoModificationAllowedError`, and that word is
/// how [`crate::web::glue`] tells "already open elsewhere" from "genuinely broken".
#[cfg(target_family = "wasm")]
pub async fn install_opfs_pool(directory: &str) -> Result<(), String> {
    let cfg = sqlite_wasm_vfs::sahpool::OpfsSAHPoolCfgBuilder::new()
        .vfs_name(OPFS_VFS_NAME)
        .directory(directory)
        .initial_capacity(8)
        .build();
    sqlite_wasm_vfs::sahpool::install::<rusqlite::ffi::WasmOsCallback>(&cfg, true)
        .await
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

/// The VFS name the pool registers under. Named rather than inline so that a future second
/// VFS cannot be confused with this one by a typo.
#[cfg(target_family = "wasm")]
pub const OPFS_VFS_NAME: &str = "opfs-sahpool";

/// Open the app's database on the pool installed by [`install_opfs_pool`].
///
/// `file` is a bare name, not a path: the pool is the filesystem. The pragmas are the same
/// ones desktop gets, and the journal it comes back with will be [`Journal::Delete`] rather
/// than [`Journal::Wal`] — the sahpool VFS refuses WAL. That is the web target's durability
/// story and the caller is expected to record it, not to retry.
///
/// **There is no `open_read_only` counterpart, and there cannot be.** The pool permits one
/// connection per database; a second fails with `NoModificationAllowedError`. See
/// [`crate::sync::lock_db_read`].
#[cfg(target_family = "wasm")]
pub fn open_pooled(file: &str) -> rusqlite::Result<(Connection, Journal)> {
    let conn = Connection::open(file)?;
    let journal = apply_pragmas(&conn)?;
    Ok((conn, journal))
}
```

Finally, give `lock_for` a wasm arm. Replace its body with:

```rust
pub fn lock_for(
    mutex: &Mutex<Connection>,
    timeout: Duration,
) -> Option<MutexGuard<'_, Connection>> {
    // One thread — the Worker — so there is nobody to wait for, and no clock to wait by:
    // `Instant::now()` panics on wasm32-unknown-unknown, before the `try_lock` and
    // regardless of the timeout. A `WouldBlock` here means this same thread already holds
    // the guard, which is a reentrancy bug to surface rather than a wait to sit out. This
    // is exactly the `Duration::ZERO` behaviour the doc above already describes.
    #[cfg(target_family = "wasm")]
    {
        let _ = timeout;
        return match mutex.try_lock() {
            Ok(guard) => Some(guard),
            Err(TryLockError::Poisoned(e)) => Some(e.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        };
    }

    #[cfg(not(target_family = "wasm"))]
    {
        let deadline = Instant::now() + timeout;
        loop {
            match mutex.try_lock() {
                Ok(guard) => return Some(guard),
                Err(TryLockError::Poisoned(e)) => return Some(e.into_inner()),
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return None;
                    }
                    std::thread::sleep(LOCK_POLL_INTERVAL);
                }
            }
        }
    }
}
```

Add to `lock_for`'s doc comment, above the existing text:

```rust
/// **On web there is no waiting arm at all** — see the body. One Worker means one thread,
/// so `timeout` has nothing to spend.
```

`LOCK_POLL_INTERVAL` is now referenced only from the non-wasm arm, so gate its declaration with `#[cfg(not(target_family = "wasm"))]` or clippy's dead-code lint will fail the wasm build.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test db:: 2>&1 | tail -12`
Expected: the file's pre-existing tests plus the three new ones, all passing. **Read the count** and confirm it went up by exactly three.

Then the wasm build, which is what the new arms are for:

Run: `cd src-tauri && cargo build --target wasm32-unknown-unknown --lib 2>&1 | tail -20`
Expected: `Finished`.

- [ ] **Step 5: Mutate to prove the tests bite**

Two mutations, both required.

1. In `apply_pragmas`, change `"PRAGMA journal_mode = WAL"` to `"PRAGMA journal_mode = DELETE"`. Run `cargo test db::`. Expected: `a_file_database_reports_the_journal_it_actually_got` FAILS with `Delete` where `Wal` was asserted. Revert.
2. In `Journal::parse`, make the fallback arm `Journal::Wal` instead of `Journal::Other`. Run `cargo test db::`. Expected: `an_unrecognised_journal_name_is_other_and_not_a_guess` FAILS. Revert.

**If either survives, stop and report it.** The second is the one that matters most: a parser that guesses `Wal` for an unknown answer would tell the web target it has a write-ahead log.

- [ ] **Step 6: The same rule, one module over — write the failing test**

> **`index::lifecycle::build_now` opens a second connection, and its doc says so proudly.**
> "The connection is its **own**, never `AppState.db_read`. This is a full pass over `cards`
> and holding the read connection for it would queue every search behind it at launch."
> That reasoning is entirely right on desktop and impossible on web: `db::open_read_only` on
> a database the pool already holds is the *third* handle in play and fails with
> `NoModificationAllowedError`. The index build is not optional — a cold index means every
> facet fails open — so this has to be answered rather than deferred.
>
> The answer is to split *which connection* from *what the build does*. `build_from` takes a
> connection; `build_now` picks the desktop one; the browser hands it the only one there is.
> A native test then proves the two produce the same index, which is the claim that matters.

Append inside `src-tauri/src/index/lifecycle.rs`'s existing `mod tests`:

```rust
    /// A build over a caller-supplied connection publishes exactly what `build_now`'s own
    /// connection does. That equality is what makes the browser's single-connection build
    /// legitimate rather than a second, unproven code path.
    #[test]
    fn a_build_over_a_supplied_connection_matches_one_over_its_own() {
        let state = crate::index::fixtures::state_with_seeded_cards("build-from-supplied");

        build_now(&state).unwrap();
        let by_itself = current(&state).expect("build_now must publish an index");

        let conn = crate::db::open_read_only(&state.data_dir.join("mtg.db")).unwrap();
        build_from(&state, &conn).unwrap();
        let by_supply = current(&state).expect("build_from must publish an index");

        // `capacity` is the doc count and `set_codes` the set vocabulary — both public
        // fields of `CardIndex`, which has no `len()`.
        assert_eq!(by_itself.capacity, by_supply.capacity, "same corpus, same doc count");
        assert_eq!(by_itself.set_codes, by_supply.set_codes);
        assert!(
            !std::sync::Arc::ptr_eq(&by_itself, &by_supply),
            "the second build must have published a new index, not left the first in place"
        );
    }
```

> `state_with_seeded_cards` is the real fixture at `src-tauri/src/index/mod.rs:350` and its
> doc warns that the name must be **unique crate-wide** — it is the whole temp directory, and
> two callers agreeing by accident is a flaky test blaming a count. `grep` for
> `state_with_seeded_cards(` before adding another.

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd src-tauri && cargo test index::lifecycle 2>&1 | tail -20`
Expected: compile error — ``cannot find function `build_from` in this scope``.

- [ ] **Step 8: Write the implementation**

In `src-tauri/src/index/lifecycle.rs`, split `build_now`:

```rust
/// Read the corpus through `conn` and publish a new index, **clearing the old one first**.
///
/// Clearing first is the whole contract and not tidiness: the caller is a swap that has just
/// renumbered every rowid, so from the moment it lands the published index answers about
/// other cards. Cold for ~767 ms is an honest "we do not know"; warm and wrong is a set the
/// user cannot click because a facet said it was empty. It is also what makes a *failed*
/// build safe — the app is left with no index rather than the last one.
pub fn build_from(state: &AppState, conn: &rusqlite::Connection) -> Result<(), String> {
    let generation = clear(state);
    let ix = CardIndex::build(conn).map_err(|e| format!("index build: {e}"))?;
    if !publish_build(state, generation, ix) {
        eprintln!("a card index build was superseded while it ran and was dropped");
    }
    Ok(())
}

/// [`build_from`] over whichever connection this platform can spare.
///
/// **Desktop and Android open one of their own**, never `AppState.db_read`: this is a full
/// pass over `cards`, and holding the read connection for it would queue every search behind
/// it at launch — which is the exact failure that second connection exists to prevent.
///
/// **Web cannot.** `opfs-sahpool` holds exclusive access handles and permits one connection
/// per database; a second `open_read_only` there fails with `NoModificationAllowedError`.
/// So the browser builds over the write connection and a search does queue behind it — for
/// the ~767 ms of a build, once per corpus swap. That is the same trade the single Worker
/// makes everywhere else, and [`build_from`]'s own test is what proves the two builds agree.
pub fn build_now(state: &AppState) -> Result<(), String> {
    #[cfg(not(target_family = "wasm"))]
    {
        // Spelled here and in `desktop.rs`'s `init_state`, which is the one that creates it.
        let conn = crate::db::open_read_only(&state.data_dir.join("mtg.db"))
            .map_err(|e| format!("index connection: {e}"))?;
        build_from(state, &conn)
    }
    #[cfg(target_family = "wasm")]
    {
        let conn = crate::db::lock_blocking(&state.db);
        build_from(state, &conn)
    }
}
```

- [ ] **Step 9: Run the tests, then mutate**

Run: `cd src-tauri && cargo test index:: 2>&1 | tail -12`. Expected: every pre-existing lifecycle and facet test passes, plus the new one. Read the count.

Then mutate: make `build_from` skip its `clear(state)` call and pass `0` as the generation. Run `cargo test index::`. Expected: at least one pre-existing lifecycle test FAILS — the ones asserting the index goes cold before a rebuild. Revert. **Report it if none fails**, because `clear`-first is the contract the doc above claims and an untested contract is a comment.

- [ ] **Step 10: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/db.rs src-tauri/src/index/lifecycle.rs
git commit -m "feat(db): open on OPFS, and report the journal instead of assuming it

The browser's opfs-sahpool VFS refuses WAL - PRAGMA journal_mode = WAL answers 'delete' there
- so the web target runs a rollback journal and its durability differs from desktop's. Rather
than cfg-gate an assumption, apply_pragmas now returns the journal SQLite actually chose. That
also makes a desktop that fell off WAL visible, which it was not: pragma_update runs through
execute_batch and discards the answer.

lock_for gets a wasm arm because Instant::now() PANICS on wasm32-unknown-unknown, before the
try_lock and whatever the timeout - and sync::with_write, the single definition of 'take the
write connection or answer busy', goes through it. One Worker is one thread, so a WouldBlock
there is reentrancy rather than contention.

index::lifecycle::build_now opened a connection of its own, which is right on desktop and is
a third handle on a pool that permits one. build_from takes the connection, build_now picks
it, and a test proves the two builds publish the same index."
```

---

### Task 4: Both ingests become push-shaped sinks

**Files:**
- Modify: `src-tauri/src/ingest.rs` — add `StreamIngest`; `ingest_stream` becomes a loop over it
- Modify: `src-tauri/src/combos.rs` — add `StreamRead`; `read_stream` becomes a loop over it
- Test: the existing inline `#[cfg(test)] mod tests` in both files

**Interfaces:**
- Consumes: `feed::frame::{Decoder, Lines, Elements}`, shipped in PR 1 and unchanged.
- Produces: `ingest::StreamIngest` with `begin(&Mutex<Connection>)`, `push(&[u8], &mut dyn FnMut(u64))`, `finish(self, &mut dyn FnMut(u64))`; `combos::StreamRead` with `new()`, `push(&[u8])`, `finish(self)`, `peak_buffer()`. `ingest::ingest_stream`, `ingest::ingest_gz`, `combos::read_stream`, `combos::ingest_stream` and `combos::ingest_gz` keep their exact signatures and behaviour.

> **Why this is not a rewrite of PR 1's work.** PR 1 made both ingests take *a stream of chunks*, which is exactly right and is what makes this small. What it could not have known is that its chunk source is a **synchronous `Iterator`**, and a browser has none to give: `reqwest::Response::bytes_stream()` yields a `futures_core::Stream` whose `next()` must be awaited, and `wasm32-unknown-unknown` has no thread to block while it resolves. That is the same argument that killed `serde_json::Deserializer::from_reader` for the combo feed, one layer up.
>
> The fix is to invert the loop rather than to duplicate it. `StreamIngest` owns the state the loop was holding in locals; `ingest_stream` becomes four lines and keeps every one of its tests; and the browser drives the same object from an `async` loop. **One drain, two drivers.**

> ⚠️ **The tail is owed twice, and this is the bug PR 1 already paid for once.** `flate2::write::GzDecoder` withholds bytes until `try_finish` — measured on the 2001-line fixture, 327 680 bytes emerged inside the chunk loop and **15 163 bytes (~88 lines) only at finish**. So `finish` has to run the *same* full-batch drain the push loop runs, not just the unconditional tail write. `progress_fires_every_batch_and_once_at_the_end` is the test that catches it, and Step 5 breaks it deliberately.

> ⚠️ **`peak_buffer` is not diagnostics.** The spike's first framer found **63 elements in 610 MB** and grew its buffer to 609.82 MB without erroring. A row count cannot see that; a buffer size can. `StreamRead` re-exposes `Elements::peak_buffer` so the *browser* can assert it against the real document, which is the only place the real document exists.

- [ ] **Step 1: Write the failing test**

Append inside `src-tauri/src/ingest.rs`'s existing `mod tests`:

```rust
    /// The sink and the iterator entry point must agree row for row. This is what makes the
    /// browser's async loop legitimate: it drives the same object, and the desktop's own
    /// tests are what prove the object is right.
    #[test]
    fn the_sink_and_ingest_stream_agree_row_for_row() {
        let lines: Vec<String> = (0..50).map(card_line).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let path = gz_fixture(&refs);
        let bytes = std::fs::read(&path).unwrap();

        let db_a = mem_db();
        let a = ingest_gz(&db_a, &path, &mut |_| {}).unwrap();

        let db_b = mem_db();
        let mut sink = StreamIngest::begin(&db_b).unwrap();
        for chunk in bytes.chunks(64) {
            sink.push(chunk, &mut |_| {}).unwrap();
        }
        let b = sink.finish(&mut |_| {}).unwrap();

        assert_eq!(a.inserted, b.inserted);
        assert_eq!(a.skipped, b.skipped);
        assert_eq!(b.inserted, 50);
    }

    /// A file small enough to arrive in ONE chunk still owes bytes after that chunk: the
    /// decompressor holds a tail back until `finish`. So the sink's own `finish` has to run
    /// the full-batch drain, not only the unconditional tail write — otherwise the last
    /// batch is written with no progress callback of its own.
    #[test]
    fn the_sink_reports_a_batch_that_only_emerges_at_finish() {
        let lines: Vec<String> = (0..2001).map(card_line).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let bytes = std::fs::read(gz_fixture(&refs)).unwrap();

        let db = mem_db();
        let mut seen: Vec<u64> = Vec::new();
        let mut sink = StreamIngest::begin(&db).unwrap();
        // One push: the whole file, exactly the shape that exposed this in PR 1.
        sink.push(&bytes, &mut |n| seen.push(n)).unwrap();
        let stats = sink.finish(&mut |n| seen.push(n)).unwrap();

        assert_eq!(stats.inserted, 2001);
        assert_eq!(
            seen,
            vec![2000, 2001],
            "the 2000-row batch must report before the swap, not only after it"
        );
    }
```

And inside `src-tauri/src/combos.rs`'s existing `mod tests`:

```rust
    /// The sink and `read_stream` must reduce a document identically — same counts, same
    /// stamp, same combos in the same order.
    #[test]
    fn the_combo_sink_and_read_stream_agree() {
        let doc = many_variants(120);
        let bytes = doc.clone().into_bytes();

        let from_iter = read_stream(bytes.chunks(97).map(|c| Ok(c.to_vec()))).unwrap();

        let mut sink = StreamRead::new();
        for chunk in bytes.chunks(97) {
            sink.push(chunk).unwrap();
        }
        let from_sink = sink.finish().unwrap();

        assert_eq!(from_iter.seen, from_sink.seen);
        assert_eq!(from_iter.skipped, from_sink.skipped);
        assert_eq!(from_iter.stamp, from_sink.stamp);
        assert_eq!(from_iter.combos.len(), from_sink.combos.len());
        for (a, b) in from_iter.combos.iter().zip(from_sink.combos.iter()) {
            assert_eq!(a.id, b.id);
        }
    }

    /// The regression the spike paid for: a framer that stops draining still returns rows
    /// for a while and then quietly holds the whole document. The row count cannot see it;
    /// `peak_buffer` can, and the browser is where the real 610 MB document lives, so the
    /// sink has to expose it.
    #[test]
    fn the_combo_sink_exposes_a_peak_buffer_that_stays_small() {
        let doc = many_variants(2000);
        let bytes = doc.into_bytes();
        assert!(bytes.len() > 200_000, "the fixture must be big enough to matter");

        let mut sink = StreamRead::new();
        for chunk in bytes.chunks(64) {
            sink.push(chunk).unwrap();
        }
        let peak = sink.peak_buffer();
        let file = sink.finish().unwrap();

        assert_eq!(file.seen, 2000);
        assert!(
            peak < 16 * 1024,
            "peak buffer was {peak} bytes against a {} byte document; the framer is not draining",
            bytes.len()
        );
    }
```

> `many_variants(n)` is the helper PR 1 added to this module's test block, built on its `document(&[String])` and `ok_variant(id, tag, cards)`. If it is not there, add it exactly as PR 1's plan defines it — do **not** invent a second fixture builder.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test ingest:: 2>&1 | tail -20`
Expected: compile error — ``cannot find type `StreamIngest` in this scope``.

Run: `cd src-tauri && cargo test combos:: 2>&1 | tail -20`
Expected: compile error — ``cannot find type `StreamRead` in this scope``.

- [ ] **Step 3: Write the implementation**

In `src-tauri/src/ingest.rs`, add above `ingest_stream`:

```rust
/// The ingest as an object the caller pushes into, rather than a loop that pulls.
///
/// **Why both shapes exist.** [`ingest_stream`] takes an `Iterator`, which is the right
/// thing on a desktop reading a file: `next()` blocks and that is free. A browser has no
/// such iterator to offer — `reqwest::Response::bytes_stream()` yields a `Stream` whose
/// `next()` must be awaited, and `wasm32-unknown-unknown` has no thread to block while it
/// resolves. So the state the loop was keeping in locals moves in here, `ingest_stream`
/// becomes a four-line driver, and the browser writes the other driver.
///
/// One drain, two drivers. Peak memory is unchanged: one chunk plus one batch.
pub struct StreamIngest<'a> {
    db: &'a Mutex<Connection>,
    stats: IngestStats,
    batch: Vec<CardRow>,
    decoder: crate::feed::frame::Decoder,
    lines: crate::feed::frame::Lines,
    decoded: Vec<u8>,
}

impl<'a> StreamIngest<'a> {
    /// Create `cards_staging` and get ready for the first chunk.
    ///
    /// The staging table is made here rather than on the first `push` so that a caller that
    /// never gets a byte still leaves a database in the state the next run expects.
    pub fn begin(db: &'a Mutex<Connection>) -> Result<Self, IngestError> {
        {
            let conn = crate::db::lock_blocking(db);
            schema::create_staging(&conn)?;
        }
        Ok(StreamIngest {
            db,
            stats: IngestStats {
                inserted: 0,
                skipped: 0,
            },
            batch: Vec::with_capacity(BATCH as usize),
            decoder: crate::feed::frame::Decoder::new(),
            lines: crate::feed::frame::Lines::new(),
            decoded: Vec::new(),
        })
    }

    /// Parse one line into the batch, or count it skipped. An associated function rather
    /// than a method so it can be called from inside a closure that already holds two of
    /// `self`'s fields.
    fn take_line(stats: &mut IngestStats, batch: &mut Vec<CardRow>, line: &[u8]) {
        if line.is_empty() {
            return;
        }
        let Ok(text) = std::str::from_utf8(line) else {
            stats.skipped += 1;
            return;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
            stats.skipped += 1;
            return;
        };
        let Some(row) = CardRow::from_json_line(&v, text) else {
            stats.skipped += 1;
            return;
        };
        batch.push(row);
    }

    /// Feed one chunk of the download. Gzipped or not — the decoder decides from the bytes.
    pub fn push(
        &mut self,
        chunk: &[u8],
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), IngestError> {
        self.decoded.clear();
        self.decoder.push(chunk, &mut self.decoded)?;
        {
            let stats = &mut self.stats;
            let batch = &mut self.batch;
            self.lines
                .push(&self.decoded, |line| Self::take_line(stats, batch, line));
        }
        flush_full_batches(self.db, &mut self.stats, &mut self.batch, progress)
    }

    /// Flush what is still owed, refuse an empty file, and swap staging into place.
    ///
    /// **The full-batch drain runs again here, and that is not belt-and-braces.**
    /// `flate2::write::GzDecoder` holds a tail back until `try_finish` — measured at
    /// 15 163 bytes, about 88 card lines, on the 2001-line fixture — so a file small enough
    /// to arrive in one chunk delivers its last batch's worth of lines *after* the push
    /// loop has ended. Without this call they would be written by the unconditional tail
    /// flush below with no progress callback of their own.
    pub fn finish(
        mut self,
        progress: &mut dyn FnMut(u64),
    ) -> Result<IngestStats, IngestError> {
        self.decoded.clear();
        self.decoder.finish(&mut self.decoded)?;
        {
            let stats = &mut self.stats;
            let batch = &mut self.batch;
            self.lines
                .push(&self.decoded, |line| Self::take_line(stats, batch, line));
            self.lines
                .finish(|line| Self::take_line(stats, batch, line));
        }
        flush_full_batches(self.db, &mut self.stats, &mut self.batch, progress)?;

        if !self.batch.is_empty() {
            self.stats.inserted += self.batch.len() as u64;
            write_batch(self.db, &mut self.batch)?;
        }

        // Nothing parsed as a card: the download is bad, not the collection. Swapping here
        // would trade a working card database for an empty one, so refuse - and drop the
        // empty staging table rather than leave it lying around.
        if self.stats.inserted == 0 {
            let conn = crate::db::lock_blocking(self.db);
            conn.execute_batch("DROP TABLE IF EXISTS cards_staging")?;
            return Err(IngestError::Empty {
                skipped: self.stats.skipped,
            });
        }

        {
            let conn = crate::db::lock_blocking(self.db);
            schema::swap_staging(&conn)?;
        }
        progress(self.stats.inserted);
        Ok(self.stats)
    }
}
```

Then replace `ingest_stream`'s body entirely — its signature and doc comment stay exactly as they are:

```rust
pub fn ingest_stream(
    db: &Mutex<Connection>,
    chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>,
    progress: &mut dyn FnMut(u64),
) -> Result<IngestStats, IngestError> {
    let mut sink = StreamIngest::begin(db)?;
    for chunk in chunks {
        sink.push(&chunk?, progress)?;
    }
    sink.finish(progress)
}
```

In `src-tauri/src/combos.rs`, add above `read_stream`:

```rust
/// Reading the `variants` array as an object the caller pushes into.
///
/// [`read_stream`]'s `Iterator` is the desktop shape; this is the shape a browser can
/// drive, for [`crate::ingest::StreamIngest`]'s reason — an awaited `Stream` has no
/// blocking `next()` to hand an iterator.
///
/// Peak memory is one element plus the reduced list, and [`StreamRead::peak_buffer`] is how
/// a caller checks that claim. That is not diagnostics: the spike's first framer found
/// **63 elements in 610 MB** and grew its buffer to 609.82 MB without erroring, and a row
/// count cannot see that.
pub struct StreamRead {
    file: ComboFile,
    decoder: crate::feed::frame::Decoder,
    elements: crate::feed::frame::Elements,
    decoded: Vec<u8>,
    head: Vec<u8>,
}

impl StreamRead {
    pub fn new() -> Self {
        StreamRead {
            file: ComboFile::default(),
            decoder: crate::feed::frame::Decoder::new(),
            elements: crate::feed::frame::Elements::new(),
            decoded: Vec::new(),
            head: Vec::new(),
        }
    }

    /// The largest the element framer's buffer has ever been, in bytes.
    ///
    /// Measured at **2.01 MB against the real 610.2 MB document**, on both a desktop and a
    /// OnePlus 12. Anything approaching the document's own size means the framer has
    /// desynchronised and is silently accumulating rather than draining.
    pub fn peak_buffer(&self) -> usize {
        self.elements.peak_buffer()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ComboError> {
        self.decoded.clear();
        self.decoder.push(chunk, &mut self.decoded)?;
        take_head(&mut self.head, &self.decoded);
        let file = &mut self.file;
        self.elements
            .push(&self.decoded, |el| take_element(file, el));
        Ok(())
    }

    pub fn finish(mut self) -> Result<ComboFile, ComboError> {
        self.decoded.clear();
        self.decoder.finish(&mut self.decoded)?;
        take_head(&mut self.head, &self.decoded);
        {
            let file = &mut self.file;
            self.elements
                .push(&self.decoded, |el| take_element(file, el));
        }
        self.file.stamp = stamp_from_head(&self.head);
        Ok(self.file)
    }
}

impl Default for StreamRead {
    fn default() -> Self {
        Self::new()
    }
}
```

Then replace `read_stream`'s body — signature and doc unchanged:

```rust
pub fn read_stream(
    chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>,
) -> Result<ComboFile, ComboError> {
    let mut sink = StreamRead::new();
    for chunk in chunks {
        sink.push(&chunk?)?;
    }
    sink.finish()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test ingest:: 2>&1 | tail -12` then `cargo test combos:: 2>&1 | tail -12`.

Expected: every pre-existing test in both modules still passes, plus the four new ones. **The pre-existing tests are the real assertion here** — they are what proves desktop behaviour did not move. Read both counts.

Then `cargo build --target wasm32-unknown-unknown --lib 2>&1 | tail -5`. Expected: `Finished`.

- [ ] **Step 5: Mutate to prove the tests bite**

Three mutations, all required.

1. Delete the `flush_full_batches(…)` call in `StreamIngest::finish` (the one *before* the tail write). Run `cargo test ingest::`. Expected: **`the_sink_reports_a_batch_that_only_emerges_at_finish` FAILS** with `[2001]` where `[2000, 2001]` was asserted, **and `progress_fires_every_batch_and_once_at_the_end` fails too** — this is the exact bug PR 1's execution notes record. Revert.
2. In `StreamRead::finish`, delete the `self.elements.push(…)` call after `decoder.finish`. Run `cargo test combos::`. Expected: `the_combo_sink_and_read_stream_agree` FAILS on `seen`. Revert.
3. In `StreamRead::push`, stop calling `take_head`. Run `cargo test combos::`. Expected: `the_combo_sink_and_read_stream_agree` FAILS on `stamp` (`None` where a timestamp was expected). Revert.

**Stop and report any that survives.** Mutation 1 is the important one: it reproduces a defect that has already shipped once in this repo.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/ingest.rs src-tauri/src/combos.rs
git commit -m "refactor(feed): both ingests become sinks the caller pushes into

PR 1 made them take a stream of chunks, which is right; what it could not have known is that
its chunk source is a synchronous Iterator, and a browser has none to give. bytes_stream()
yields a futures Stream whose next() must be awaited, and wasm32-unknown-unknown has no thread
to block - the same argument that killed Deserializer::from_reader one layer up.

So the loop inverts rather than duplicating: StreamIngest and StreamRead own what the loops
held in locals, ingest_stream and read_stream become four-line drivers keeping every test they
had, and the browser writes the other driver. One drain, two drivers.

finish() runs the full-batch drain again, and that is load-bearing: GzDecoder holds ~15 KB
back until try_finish, so a one-chunk file delivers its last batch after the push loop ends.
StreamRead::peak_buffer is exposed because the browser is where the real 610 MB document is,
and a framer that stops draining is invisible to a row count."
```


---

### Task 5: `web::wire` and `web::route` — the dispatch table, compiled on every target

**Files:**
- Create: `src-tauri/src/web/mod.rs`
- Create: `src-tauri/src/web/wire.rs`
- Create: `src-tauri/src/web/route.rs`
- Test: inline `#[cfg(test)] mod tests` in both new files (house style — every module in this crate tests inline)

**Interfaces:**
- Consumes: `sync::AppState`, `sync::status`, `sync::lock_db_read`, `search::{run_search, run_list_sets, SearchRequest}`, `index::facets::run_facets` — all unchanged.
- Produces: `web::wire::{Request, Response, Opened}` and `web::route::{COMMANDS, RouteError, call}`.

> **`web` is declared for every target, and that is the point.** A `#[cfg(target_family = "wasm")]` module is invisible to `cargo test`, so a dispatch table living inside one would be an untested translation layer between the frontend and every command in the app — the exact place a typo costs a silent `undefined`. So the *routing* and the *wire format* compile everywhere and `cargo test` covers them; only the `#[wasm_bindgen]` shell around them (Task 6) is target-gated.

> **Four commands, named.** `sync_status`, `search_cards`, `list_sets`, `facet_cards`. That is the browse, which is the read path spec §8 says must be measured in wasm rather than guessed. Adding a fifth once its module joins the map is one line in `COMMANDS` and one `match` arm.

- [ ] **Step 1: Create the modules, declare them, and write the tests in one step**

Create `src-tauri/src/web/mod.rs`:

```rust
//! The web target: how a command name and a blob of JSON become a call into this crate.
//!
//! **[`route`] and [`wire`] are compiled for every target on purpose.** A dispatch table is
//! precisely the kind of code where a typo produces a silent `undefined` rather than a
//! compile error, and a module gated to `wasm32-unknown-unknown` is invisible to
//! `cargo test`. So the routing and the wire format are ordinary Rust that the suite
//! covers, and only the `#[wasm_bindgen]` shell around them is target-gated.

pub mod route;
pub mod wire;

/// Fetching, in a browser. `reqwest` over `fetch`, with none of the desktop `Client`'s
/// pacing, penalty or resume — see the module's own docs for why none of it is available.
#[cfg(target_family = "wasm")]
pub mod net;

/// The `#[wasm_bindgen]` surface the Worker imports.
#[cfg(target_family = "wasm")]
pub mod glue;
```

In `src-tauri/src/lib.rs`, `pub mod web;` is already in the "Every target" list from Task 2. Confirm it is there before going on — if it is not, this task's first red will be an empty test run.

Create `src-tauri/src/web/wire.rs` with **only** this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_request_round_trips() {
        let text = r#"{"id":7,"command":"search_cards","args":{"req":{"text":"bolt"}}}"#;
        let req: Request = serde_json::from_str(text).unwrap();
        assert_eq!(req.id, 7);
        assert_eq!(req.command, "search_cards");
        assert_eq!(req.args, json!({ "req": { "text": "bolt" } }));
    }

    /// A command with no arguments is sent without an `args` key at all — the Tauri core
    /// calls `invoke("list_sets")` with one argument rather than two, and the browser core
    /// mirrors that. An absent key must be an empty object, not a deserialize failure.
    #[test]
    fn an_absent_args_key_is_an_empty_object() {
        let req: Request = serde_json::from_str(r#"{"id":1,"command":"list_sets"}"#).unwrap();
        assert_eq!(req.args, json!({}));
    }

    /// The three responses are told apart by `kind`, which is what the TypeScript side
    /// switches on. A rename here without one there is a message nobody handles.
    #[test]
    fn responses_are_tagged_by_kind() {
        let ok = serde_json::to_value(Response::Ok {
            id: 3,
            result: json!({ "total": 2 }),
        })
        .unwrap();
        assert_eq!(ok, json!({ "kind": "ok", "id": 3, "result": { "total": 2 } }));

        let err = serde_json::to_value(Response::Err {
            id: 3,
            message: "nope".into(),
        })
        .unwrap();
        assert_eq!(err, json!({ "kind": "err", "id": 3, "message": "nope" }));

        // An event carries no id: nothing is waiting on it.
        let ev = serde_json::to_value(Response::Event {
            event: "sync-progress".into(),
            payload: json!({ "done": 2000 }),
        })
        .unwrap();
        assert_eq!(
            ev,
            json!({ "kind": "event", "event": "sync-progress", "payload": { "done": 2000 } })
        );
    }

    /// The one-tab guard's whole brain, and the reason it lives here rather than in the
    /// wasm glue: it is a string match on a browser error, and `cargo test` can only reach
    /// it if it is ordinary Rust.
    #[test]
    fn a_held_access_handle_is_already_open_and_nothing_else_is() {
        let real = "JsValue(NoModificationAllowedError: Failed to execute \
                    'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles \
                    cannot be created if there is another open Access Handle or Writable \
                    stream associated with the same file.)";
        assert_eq!(Opened::from_open_error(real), Opened::AlreadyOpen);

        // Everything else is a real failure and must say so rather than telling the reader
        // to close a tab they do not have open.
        assert_eq!(
            Opened::from_open_error("QuotaExceededError: out of space"),
            Opened::Failed {
                message: "QuotaExceededError: out of space".into()
            }
        );
    }

    #[test]
    fn opened_is_tagged_by_kind_too() {
        assert_eq!(
            serde_json::to_value(Opened::AlreadyOpen).unwrap(),
            json!({ "kind": "already-open" })
        );
        assert_eq!(
            serde_json::to_value(Opened::Ready {
                journal: "delete".into(),
                schema_version: 26
            })
            .unwrap(),
            json!({ "kind": "ready", "journal": "delete", "schemaVersion": 26 })
        );
    }
}
```

Create `src-tauri/src/web/route.rs` with **only** this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Four seeded printings in a file database inside a real `AppState` — the same fixture
    /// the index and facet tests count against, so the numbers below are the numbers those
    /// suites already assert.
    fn state() -> std::sync::Arc<crate::sync::AppState> {
        crate::index::fixtures::state_with_seeded_cards("web-route")
    }

    #[test]
    fn sync_status_answers_the_card_count() {
        let s = state();
        let out = call(&s, "sync_status", &json!({})).unwrap();
        assert_eq!(out["cardCount"], json!(4));
        // camelCase, because `SyncStatus` is `rename_all = "camelCase"` and the frontend's
        // hand-written mirror in `src/lib/ipc.ts` reads these exact keys.
        assert!(out.get("dataDir").is_some(), "the DTO's camelCase names must survive");
    }

    #[test]
    fn search_cards_takes_its_request_under_the_key_the_command_uses() {
        let s = state();
        let out = call(&s, "search_cards", &json!({ "req": { "text": "bolt" } })).unwrap();
        assert_eq!(out["rows"].as_array().unwrap().len(), 1);
        assert_eq!(out["rows"][0]["name"], json!("Lightning Bolt"));
    }

    #[test]
    fn list_sets_needs_no_arguments() {
        let s = state();
        let out = call(&s, "list_sets", &json!({})).unwrap();
        // lea, rav, alc — the fixture's three set codes.
        assert_eq!(out.as_array().unwrap().len(), 3);
    }

    #[test]
    fn facet_cards_answers_ready_false_before_an_index_is_built() {
        let s = state();
        let out = call(&s, "facet_cards", &json!({ "req": {} })).unwrap();
        assert_eq!(out["ready"], json!(false), "a cold index is a supported state");

        crate::index::lifecycle::build_now(&s).unwrap();
        let warm = call(&s, "facet_cards", &json!({ "req": {} })).unwrap();
        assert_eq!(warm["ready"], json!(true));
    }

    #[test]
    fn an_unknown_command_is_refused_by_name() {
        let s = state();
        let err = call(&s, "deck_list", &json!({})).unwrap_err();
        assert_eq!(err, RouteError::Unknown("deck_list".into()));
        // The message is what reaches a developer console, so it names the command.
        assert!(err.to_string().contains("deck_list"));
    }

    #[test]
    fn a_malformed_argument_is_an_args_error_and_not_a_panic() {
        let s = state();
        // `req` must be an object; a string is the shape a hand-written caller gets wrong.
        let err = call(&s, "search_cards", &json!({ "req": "bolt" })).unwrap_err();
        assert!(matches!(err, RouteError::Args { .. }), "got {err:?}");
    }

    /// **The list and the table must not drift.** `COMMANDS` is what the frontend and the
    /// docs read; the `match` is what actually answers. A name in one and not the other is
    /// exactly the silent `undefined` this whole module exists in-tree to prevent.
    #[test]
    fn every_advertised_command_is_actually_routed() {
        let s = state();
        for name in COMMANDS {
            let answer = call(&s, name, &json!({}));
            assert!(
                !matches!(&answer, Err(RouteError::Unknown(_))),
                "`{name}` is advertised in COMMANDS and has no match arm"
            );
        }
        assert_eq!(COMMANDS.len(), 4, "update this number when a command is added");
    }
}
```

> ⚠️ **Both modules are declared before their first test runs.** `web/mod.rs` names `route`
> and `wire`, and `lib.rs` names `web`. A module the crate never declares compiles nothing
> and runs no tests, and `cargo test` reports `0 tests … ok` and **exits 0** — which is not a
> red, it is an absence.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test web:: 2>&1 | tail -20`
Expected: **compile errors** — ``cannot find type `Request` in this scope``, ``cannot find function `call` in this scope``, ``cannot find value `COMMANDS` in this scope``. Not "0 tests".

- [ ] **Step 3: Write the implementation**

Put this above the test module in `src-tauri/src/web/wire.rs`:

```rust
//! What crosses the boundary between the page and the Worker, as JSON.
//!
//! Deliberately not Tauri's envelope. Tauri wraps an event payload in `{ event, id,
//! payload }` and `src/lib/core/tauri.ts` unwraps it; the browser has no reason to invent
//! that shape only to take it apart again, so an event here *is* its payload plus its name.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One command call, page → Worker.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Request {
    /// Matched against [`Response::Ok::id`]. **Ids and not order**: the Worker answers a
    /// long search after a short one that was sent later, and a queue that resolved by
    /// arrival would hand the wrong rows to the wrong caller.
    pub id: u32,
    pub command: String,
    /// Named arguments, matched against the routed function's parameters **by name**.
    /// `default` because a no-argument command is sent without the key at all — mirroring
    /// `core/tauri.ts`, which calls `invoke("list_sets")` with one argument rather than two.
    #[serde(default)]
    pub args: Value,
}

impl Default for Request {
    fn default() -> Self {
        Request {
            id: 0,
            command: String::new(),
            args: Value::Object(serde_json::Map::new()),
        }
    }
}

/// Anything the Worker says, Worker → page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Response {
    /// A command answered. `result` is the command's own DTO, already camelCased by its
    /// own `#[serde(rename_all)]` — the frontend's hand-written mirrors read those names.
    Ok { id: u32, result: Value },
    /// A command refused. `message` is what a page shows a reader.
    Err { id: u32, message: String },
    /// A progress notification. **No id**: nothing is waiting on it, and `Core::listen` is
    /// a subscription rather than a call.
    Event { event: String, payload: Value },
}

/// What opening the database answered.
///
/// Its own type rather than a [`Response`] because it happens once, before any command, and
/// its `AlreadyOpen` arm is not an error the app retries — it is a different page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Opened {
    /// `journal` is what SQLite actually chose — `delete` on the OPFS pool, never `wal`.
    #[serde(rename_all = "camelCase")]
    Ready { journal: String, schema_version: i64 },
    /// Another document of this origin holds the pool's access handles.
    AlreadyOpen,
    Failed { message: String },
}

impl Opened {
    /// Classify a VFS or connection failure.
    ///
    /// **A string match, because that is all the browser gives.** `sqlite-wasm-vfs` hands
    /// back a `JsValue`, and the distinction that matters — "another tab has it" versus
    /// "something is broken" — lives in the DOMException's *name*:
    ///
    /// ```text
    /// NoModificationAllowedError: Failed to execute 'createSyncAccessHandle' on
    /// 'FileSystemFileHandle': Access Handles cannot be created if there is another open
    /// Access Handle or Writable stream associated with the same file.
    /// ```
    ///
    /// Matching on the name and not the sentence is deliberate: Chrome's wording has
    /// changed before and the error name is the part the spec fixes. Everything else is a
    /// real failure and must say so, rather than telling a reader to close a tab that is
    /// not open.
    pub fn from_open_error(text: &str) -> Opened {
        if text.contains("NoModificationAllowedError") {
            Opened::AlreadyOpen
        } else {
            Opened::Failed {
                message: text.to_owned(),
            }
        }
    }
}
```

And above the test module in `src-tauri/src/web/route.rs`:

```rust
//! Command name plus JSON in, JSON out — the browser's answer to `#[tauri::command]`.
//!
//! **The commands here call the same functions the Tauri wrappers call.** `search_cards` in
//! `desktop.rs` is `spawn_blocking(move || run_search(&lock_db_read(&state), &req))`; this
//! is `run_search(&lock_db_read(state), &req)` with the `spawn_blocking` gone, because the
//! Worker *is* the blocking thread. Nothing here decides anything a command did not already
//! decide — Rust supplies facts, TypeScript draws conclusions, on every platform.

use crate::sync::AppState;
use serde_json::Value;

/// Every command this build routes, in the order they were added.
///
/// **This is a first slice and not the whole surface.** The app has 136 commands; the four
/// here are the browse, which is the read path spec §8 requires measured in wasm rather than
/// guessed. The rest arrive with their modules — see `lib.rs`'s module map for which are
/// still desktop-only.
///
/// A test asserts every name here has a `match` arm, because a list and a table that drift
/// produce a silent `undefined` on the far side rather than a compile error.
pub const COMMANDS: &[&str] = &["sync_status", "search_cards", "list_sets", "facet_cards"];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RouteError {
    /// Not in [`COMMANDS`]. Names the command, because the reader of this message is
    /// looking at a console and needs to know which call went nowhere.
    #[error("unknown command `{0}`")]
    Unknown(String),
    #[error("`{command}` could not read its arguments: {message}")]
    Args { command: String, message: String },
    /// The command ran and refused. Its own words, unchanged.
    #[error("{0}")]
    Failed(String),
}

/// Pull one named argument out of the payload and deserialize it.
///
/// Named and not positional, exactly as `invoke` matches a Rust command's parameters — so a
/// misspelled key is a runtime error here in the same way it is one there, and
/// `src/lib/ipc.test.ts`'s argument-name pins stay the contract for both.
fn field<T: serde::de::DeserializeOwned>(
    command: &str,
    args: &Value,
    name: &str,
) -> Result<T, RouteError> {
    let raw = args.get(name).ok_or_else(|| RouteError::Args {
        command: command.to_owned(),
        message: format!("missing `{name}`"),
    })?;
    serde_json::from_value(raw.clone()).map_err(|e| RouteError::Args {
        command: command.to_owned(),
        message: e.to_string(),
    })
}

/// Serialize a command's answer. A DTO that will not encode is a bug in this crate, not in
/// the caller, so it is [`RouteError::Failed`] with the command named.
fn encode<T: serde::Serialize>(command: &str, value: T) -> Result<Value, RouteError> {
    serde_json::to_value(value).map_err(|e| {
        RouteError::Failed(format!("`{command}` produced an answer that would not encode: {e}"))
    })
}

/// Route one call.
///
/// Synchronous, and that is the whole shape of the web target: the Worker is a thread with
/// nothing else to do, so there is no `spawn_blocking` to be had and none needed. The page
/// stays responsive because the work is in the Worker, not because the work is deferred.
pub fn call(state: &AppState, command: &str, args: &Value) -> Result<Value, RouteError> {
    match command {
        "sync_status" => encode(command, crate::sync::status(state)),

        "search_cards" => {
            let req: crate::search::SearchRequest = field(command, args, "req")?;
            let conn = crate::sync::lock_db_read(state);
            let out = crate::search::run_search(&conn, &req).map_err(RouteError::Failed)?;
            encode(command, out)
        }

        "list_sets" => {
            let conn = crate::sync::lock_db_read(state);
            let out = crate::search::run_list_sets(&conn).map_err(RouteError::Failed)?;
            encode(command, out)
        }

        "facet_cards" => {
            let req: crate::search::SearchRequest = field(command, args, "req")?;
            let out = crate::index::facets::run_facets(state, &req).map_err(RouteError::Failed)?;
            encode(command, out)
        }

        other => Err(RouteError::Unknown(other.to_owned())),
    }
}
```

> **`lock_db_read` is `pub(crate)`** and `web::route` is inside the crate, so it resolves.
> On wasm it hands back the write connection — Task 2 — so a search there does queue behind
> an ingest. That is the single-connection trade, written down in the doc rather than left
> to be discovered.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test web:: 2>&1 | tail -12`
Expected: `test result: ok. 11 passed` (5 in `wire`, 6 in `route`). **Read the number** — a filter that selects nothing exits 0 too.

Then `cargo build --target wasm32-unknown-unknown --lib 2>&1 | tail -5`. Expected: `Finished`.

- [ ] **Step 5: Mutate to prove the tests bite**

Three mutations.

1. Add `"deck_list"` to `COMMANDS` without a `match` arm. Run `cargo test web::`. Expected: `every_advertised_command_is_actually_routed` FAILS naming `deck_list`, **and** `assert_eq!(COMMANDS.len(), 4, …)` fails. Revert.
2. Change `field`'s lookup from `args.get(name)` to `args.get("request")`. Expected: `search_cards_takes_its_request_under_the_key_the_command_uses` and `facet_cards_answers_ready_false_before_an_index_is_built` both FAIL with an `Args` error. Revert.
3. In `Opened::from_open_error`, match on `"NotAllowedError"` instead of `"NoModificationAllowedError"`. Expected: `a_held_access_handle_is_already_open_and_nothing_else_is` FAILS — the real Chrome message is classified `Failed`. Revert.

**Stop and report any that survives.** Mutation 3 is the one-tab guard: if it survives, the guard is matching something other than what the browser sends.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/web/ src-tauri/src/lib.rs
git commit -m "feat(web): a command dispatch table cargo test can reach

route and wire are compiled for EVERY target on purpose. A dispatch table is exactly where a
typo produces a silent undefined rather than a compile error, and a module gated to wasm is
invisible to cargo test - so the routing and the wire format are ordinary Rust the suite
covers, and only the wasm_bindgen shell around them will be gated.

Four commands: sync_status, search_cards, list_sets, facet_cards. That is the browse, which
is the read path the spec requires measured in wasm rather than guessed. A test asserts every
name in COMMANDS has a match arm, because a list and a table that drift are undetectable from
the far side.

Opened::from_open_error is the one-tab guard's whole brain, and it lives here rather than in
the glue so that the string it matches - NoModificationAllowedError, the name rather than the
sentence - is asserted against the message Chrome actually sends."
```

---

### Task 6: The wasm entry points — OPFS, `fetch`, and the ingest that streams

**Files:**
- Create: `src-tauri/src/web/net.rs`
- Create: `src-tauri/src/web/glue.rs`
- Modify: `src-tauri/src/web/mod.rs` — already declares both, from Task 5

**Interfaces:**
- Consumes: `db::{install_opfs_pool, open_pooled}` (Task 3), `ingest::StreamIngest` and `combos::StreamRead` (Task 4), `web::{route, wire}` (Task 5), `schema::prepare_database`, `index::lifecycle::build_now`, `combos::store`.
- Produces: the `#[wasm_bindgen]` functions `open`, `call`, `ingest_cards`, `ingest_combos` and `close`. All five return a **JSON string**; none of them returns a `JsValue` shape the TypeScript side would have to mirror twice.

> **This task reuses probe 2 and probe 3 almost verbatim**, and the shapes are theirs:
> `spike/probe2/src/lib.rs` for the sahpool install and the reopen, `spike/probe2/worker.js`
> for why a wasm trap has to be forwarded by hand, `spike/probe3/src/lib.rs` for the
> `bytes_stream()` → decoder → batch loop and for reading the bulk descriptor with `.text()`
> plus serde rather than `.json()` (which would need reqwest's `json` feature this crate does
> not enable). `spike/probe4/src/lib.rs` is where the gzip sniff came from, and that already
> shipped as `feed::frame::Decoder` in PR 1.

> **No `#[wasm_bindgen]` function may panic.** A wasm trap does not surface as a rejected
> promise with a useful message; it surfaces in the Worker's `onerror` with no stack the page
> can read, and probe 2's `worker.js` had to forward it by hand or the page sat at "running…"
> forever. Every entry point here catches its own failure and returns it as JSON.

- [ ] **Step 1: Write `web::net`**

Create `src-tauri/src/web/net.rs`:

```rust
//! Fetching, in a browser.
//!
//! **Not `crate::scryfall::Client`, and not a port of it.** That client sets a `user_agent`,
//! a `connect_timeout` and a `read_timeout` on `reqwest::ClientBuilder` — none of which the
//! wasm backend has — paces itself against a `tokio::time::Instant`, and resumes a partial
//! download with `tokio::fs`. A browser can do none of it: `User-Agent` is a **forbidden
//! header** for `fetch`, there are no timeouts to set on it, and OPFS has no partial-file
//! resume story. So this is four functions rather than a mangled `Client`.
//!
//! **What that costs, said out loud.** The browser sends its own `User-Agent` rather than
//! the app-identifying string the desktop sends. That is a real UA rather than an absent
//! one — which is what Scryfall's rule is actually about — but it is not ours, and the
//! desktop's rate-limit pacing and 429 penalty do not exist here. Both are owed work; both
//! belong with the sync port rather than with the first build that reaches the network.
//!
//! Both Scryfall hosts answer `Access-Control-Allow-Origin: *` (verified 2026-08-27), which
//! is the only reason "every platform builds its own corpus" is possible at all.

/// GET, refusing anything that is not a success status.
///
/// A non-2xx is an error here rather than a body the caller has to check, because every
/// caller in this module wants bytes and an error page is not bytes.
pub async fn get(url: &str) -> Result<reqwest::Response, String> {
    let resp = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{url} answered {}", resp.status()));
    }
    Ok(resp)
}

/// GET and parse a JSON document.
///
/// `.text()` then serde rather than `.json()`: the latter needs reqwest's `json` feature,
/// and this crate's reqwest line is `default-features = false, features = ["rustls-tls",
/// "stream"]` on every target — which is the line the spike proved compiles for wasm.
pub async fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let text = get(url)
        .await?
        .text()
        .await
        .map_err(|e| format!("could not read {url}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{url} did not answer JSON: {e}"))
}
```

- [ ] **Step 2: Write `web::glue`**

Create `src-tauri/src/web/glue.rs`:

```rust
//! The `#[wasm_bindgen]` surface `src/workers/db.ts` imports.
//!
//! Five functions, and every one of them returns a **JSON string**. Not a `JsValue`, and not
//! a `Result<JsValue, JsValue>`: the TypeScript side already has to know the shape of
//! [`crate::web::wire`], and a second, structural representation of the same thing is a
//! second place for it to drift. A caller does `JSON.parse` once and switches on `kind`.
//!
//! **Nothing here may panic.** A wasm trap does not arrive as a rejected promise with a
//! readable message — it arrives in the Worker's `onerror` with nothing the page can show,
//! which is how probe 2 spent a run sitting at "running…". Every entry point catches.

use crate::sync::AppState;
use crate::web::{net, route, wire};
use std::cell::RefCell;
use std::sync::{atomic::AtomicBool, Arc, Mutex, RwLock};
use wasm_bindgen::prelude::*;

thread_local! {
    /// The whole app's state, for the life of this Worker.
    ///
    /// A `thread_local` and not a `static`: a `Connection` is not `Sync`, and there is
    /// exactly one thread here anyway — that is the premise the entire web target rests on.
    static STATE: RefCell<Option<Arc<AppState>>> = const { RefCell::new(None) };
}

/// The `Arc`, cloned out so no `RefCell` borrow is ever held across an `.await`.
///
/// Holding one would be a `BorrowMutError` at runtime the first time an ingest ran while a
/// command arrived — a panic, which is the one thing this module must not produce.
fn state() -> Result<Arc<AppState>, String> {
    STATE
        .with(|s| s.borrow().clone())
        .ok_or_else(|| "the database is not open yet".to_owned())
}

fn json<T: serde::Serialize>(value: &T) -> String {
    // A DTO of ours that will not serialize is a bug here, and the caller still needs a
    // parseable answer rather than a trap.
    serde_json::to_string(value).unwrap_or_else(|e| {
        format!("{{\"kind\":\"failed\",\"message\":\"answer would not encode: {e}\"}}")
    })
}

/// Install the OPFS pool, open the database, migrate it, and remember it.
///
/// `directory` is the OPFS folder the pool lives in; `file` is the bare database name — the
/// pool *is* the filesystem, so there is no path. Answers a [`wire::Opened`].
///
/// **The `AlreadyOpen` arm is the one-tab guard.** A second document of this origin cannot
/// have the pool's access handles, and the browser refuses with
/// `NoModificationAllowedError`. That is not retried and not queued: spec §5.2 settled that
/// the first tab wins and the second says so.
#[wasm_bindgen]
pub async fn open(directory: String, file: String) -> String {
    console_error_panic_hook::set_once();

    if let Err(e) = crate::db::install_opfs_pool(&directory).await {
        return json(&wire::Opened::from_open_error(&e));
    }
    let (conn, journal) = match crate::db::open_pooled(&file) {
        Ok(pair) => pair,
        Err(e) => return json(&wire::Opened::from_open_error(&format!("{e:?}"))),
    };
    if let Err(e) = crate::schema::prepare_database(&conn) {
        return json(&wire::Opened::Failed {
            message: format!("the database could not be migrated: {e}"),
        });
    }
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);

    let app = Arc::new(AppState {
        db: Mutex::new(conn),
        // There is no filesystem path here. The OPFS directory is what a reader would have
        // to look in, and it is what Settings shows in place of a folder.
        data_dir: std::path::PathBuf::from(format!("OPFS:/{directory}")),
        syncing: AtomicBool::new(false),
        index: RwLock::default(),
    });
    // A corpus may already be here from a previous session, so the index is built now
    // rather than only after an ingest — a cold index means every facet fails open.
    if let Err(e) = crate::index::lifecycle::build_now(&app) {
        // Not fatal, and deliberately so: faceting fails open by design, and refusing to
        // start over a facet index would trade a working app for a tidy one.
        web_log(&format!("card index unavailable, facets will stay open: {e}"));
    }
    STATE.with(|s| *s.borrow_mut() = Some(app));

    json(&wire::Opened::Ready {
        journal: format!("{journal:?}").to_lowercase(),
        schema_version: version,
    })
}

/// Answer one [`wire::Request`], as a serialized [`wire::Response`].
///
/// Synchronous: the Worker is a thread with nothing else to do, so there is no
/// `spawn_blocking` to be had and none needed.
#[wasm_bindgen]
pub fn call(request_json: &str) -> String {
    let req: wire::Request = match serde_json::from_str(request_json) {
        Ok(r) => r,
        Err(e) => {
            // No id to answer against, so this cannot be a `Response::Err`. It is a bug in
            // the caller and it has to be visible somewhere.
            return json(&wire::Response::Event {
                event: "core://malformed-request".to_owned(),
                payload: serde_json::json!({ "message": e.to_string() }),
            });
        }
    };
    let app = match state() {
        Ok(a) => a,
        Err(message) => return json(&wire::Response::Err { id: req.id, message }),
    };
    match route::call(&app, &req.command, &req.args) {
        Ok(result) => json(&wire::Response::Ok {
            id: req.id,
            result,
        }),
        Err(e) => json(&wire::Response::Err {
            id: req.id,
            message: e.to_string(),
        }),
    }
}

/// Download Scryfall's `default_cards` bulk file and ingest it, streaming throughout.
///
/// `on_progress` is called with the running insert count, every 2 000 rows — the same
/// [`crate::ingest`] batch that bounds how long the connection is held.
///
/// **Nothing is ever fully materialised**, and that is measured rather than intended:
/// `bytes_stream()` yields compressed chunks, each goes into the decoder, complete lines are
/// drained out and the partial tail carried to the next chunk. Peak memory is one chunk plus
/// one batch. 74.4 MB gzipped in, 598.8 MB of JSON out, 117 464 lines, **10.4 s** on a
/// desktop and 36.5 s on a OnePlus 12 (2026-08-27, against a 20-column subset of the row
/// this now writes in full).
///
/// **`navigator.storage.estimate()` is deliberately not consulted.** It reported 647 MB
/// during a fill and 7 MB immediately after a restart, against a file that was 532.8 MB both
/// times. Nothing may gate an ingest on it.
#[wasm_bindgen]
pub async fn ingest_cards(descriptor_url: String, on_progress: js_sys::Function) -> String {
    use futures_util::StreamExt as _;

    let app = match state() {
        Ok(a) => a,
        Err(message) => return json(&serde_json::json!({ "kind": "err", "message": message })),
    };

    let descriptor = match net::get_json(&descriptor_url).await {
        Ok(v) => v,
        Err(message) => return json(&serde_json::json!({ "kind": "err", "message": message })),
    };
    let uri = descriptor["jsonl_download_uri"].as_str().unwrap_or("").to_owned();
    if uri.is_empty() {
        return json(&serde_json::json!({
            "kind": "err",
            "message": "the bulk descriptor named no jsonl_download_uri"
        }));
    }

    let response = match net::get(&uri).await {
        Ok(r) => r,
        Err(message) => return json(&serde_json::json!({ "kind": "err", "message": message })),
    };
    let mut stream = response.bytes_stream();

    let mut sink = match crate::ingest::StreamIngest::begin(&app.db) {
        Ok(s) => s,
        Err(e) => return json(&serde_json::json!({ "kind": "err", "message": e.to_string() })),
    };
    let mut report = |n: u64| {
        let _ = on_progress.call1(&JsValue::NULL, &JsValue::from_f64(n as f64));
    };

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                return json(&serde_json::json!({
                    "kind": "err",
                    "message": format!("the download stopped partway: {e}")
                }))
            }
        };
        if let Err(e) = sink.push(&chunk, &mut report) {
            return json(&serde_json::json!({ "kind": "err", "message": e.to_string() }));
        }
    }
    let stats = match sink.finish(&mut report) {
        Ok(s) => s,
        Err(e) => return json(&serde_json::json!({ "kind": "err", "message": e.to_string() })),
    };

    // The swap renumbered every rowid, so the published index now answers about other cards.
    if let Err(e) = crate::index::lifecycle::build_now(&app) {
        web_log(&format!("card index unavailable, facets will stay open: {e}"));
    }

    json(&serde_json::json!({
        "kind": "ok",
        "inserted": stats.inserted,
        "skipped": stats.skipped,
    }))
}

/// Download Commander Spellbook's `variants.json.gz` and store what it holds.
///
/// `fetched_at` comes from `Date.now()` in the Worker, in **unix seconds**. It is a
/// parameter and not a call to `SystemTime::now()`, which **panics** on
/// `wasm32-unknown-unknown`.
///
/// **The browser has already gunzipped this one and the desktop has not.** Spellbook sends
/// `Content-Encoding: gzip` even when the client asks for `identity`, and `fetch`
/// transparently decodes any such response with no way to opt out — so these chunks arrive
/// as plain JSON, while the same URL on desktop arrives still compressed. Nothing here has
/// to know: `feed::frame::Decoder` sniffs the two-byte magic and decides from the bytes.
///
/// `peakBuffer` is reported because a row count cannot see the failure this parser has.
/// Measured 2026-08-27: **2.01 MB against a 610.2 MB document**, 111 148 variants seen and
/// 105 516 kept, identical on a desktop and a OnePlus 12. A peak anywhere near the
/// document's own size means the framer desynchronised and is accumulating silently.
#[wasm_bindgen]
pub async fn ingest_combos(url: String, fetched_at: f64) -> String {
    use futures_util::StreamExt as _;

    let app = match state() {
        Ok(a) => a,
        Err(message) => return json(&serde_json::json!({ "kind": "err", "message": message })),
    };
    let response = match net::get(&url).await {
        Ok(r) => r,
        Err(message) => return json(&serde_json::json!({ "kind": "err", "message": message })),
    };
    let mut stream = response.bytes_stream();
    let mut sink = crate::combos::StreamRead::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                return json(&serde_json::json!({
                    "kind": "err",
                    "message": format!("the combo download stopped partway: {e}")
                }))
            }
        };
        if let Err(e) = sink.push(&chunk) {
            return json(&serde_json::json!({ "kind": "err", "message": e.to_string() }));
        }
    }
    let peak = sink.peak_buffer();
    let file = match sink.finish() {
        Ok(f) => f,
        Err(e) => return json(&serde_json::json!({ "kind": "err", "message": e.to_string() })),
    };
    match crate::combos::store(&app.db, &file, None, fetched_at as i64, &mut |_, _| {}) {
        Ok(done) => json(&serde_json::json!({
            "kind": "ok",
            "combos": done.combos,
            "cards": done.cards,
            "skipped": done.skipped,
            "seen": done.seen,
            "peakBuffer": peak,
        })),
        Err(e) => json(&serde_json::json!({ "kind": "err", "message": e.to_string() })),
    }
}

/// Drop the connection so the pool's access handles are released.
///
/// Called from the Worker's `close` path. Without it a reload can race its own predecessor
/// and be told the database is already open — by itself.
#[wasm_bindgen]
pub fn close() {
    STATE.with(|s| *s.borrow_mut() = None);
}

/// `console.warn`, for the things that are not failures and still must not be silent.
fn web_log(message: &str) {
    web_sys::console::warn_1(&JsValue::from_str(message));
}
```

`web_sys::console` needs the `console` feature. Add it to the wasm `web-sys` feature list in `Cargo.toml`:

```toml
features = ["Navigator", "StorageManager", "WorkerGlobalScope", "WorkerNavigator", "console"]
```

- [ ] **Step 3: Build and confirm it compiles**

Run: `cd src-tauri && cargo build --target wasm32-unknown-unknown --lib 2>&1 | tail -30`

The first run **will** fail, and the failures are the point. Expected classes, each with its fix:

| Error | Fix |
| --- | --- |
| `no method named bytes_stream` | reqwest's `stream` feature is not reaching the wasm build — check the shared `[dependencies]` line was not moved into the desktop table |
| `cannot find crate js_sys` / `web_sys` | missing from the `cfg(target_family = "wasm")` table |
| `the trait Sync is not implemented for Connection` | something took a `static` instead of the `thread_local!` |
| `Ingested has no field combos` | check `combos::Ingested`'s real fields — they are `combos`, `cards`, `skipped`, `seen` |

Green when it says `Finished`. Then `cd src-tauri && cargo build 2>&1 | tail -5` and `cargo test 2>&1 | tail -12`: the desktop side must be untouched, **with the same test count Task 5 left behind** — this task adds no tests, and a changed count means a module stopped compiling.

- [ ] **Step 4: Prove the glue can go red, without a browser**

`glue` is `#[cfg(target_family = "wasm")]` and `cargo test` cannot reach it. Its *decisions*, though, all live in `wire` and `route`, which Task 5 tests — and that is the design rather than an accident. What is left to prove here is that **the build is a real gate**, so mutate the build:

Temporarily change `sink.push(&chunk, &mut report)` in `ingest_cards` to `sink.push(&chunk)`.

Run: `cd src-tauri && cargo build --target wasm32-unknown-unknown --lib 2>&1 | tail -10`
Expected: `this method takes 2 arguments but 1 argument was supplied`. Revert.

Then a second, sharper one — temporarily delete the `#[wasm_bindgen]` attribute from `open`. Run the build. Expected: it **succeeds**, with a dead-code warning at most.

**That second result is the finding, and it is why Task 10 exists.** A compiler cannot tell you an entry point stopped being exported; only loading the module in a browser can. Record it and move on — do not try to test it here.

- [ ] **Step 5: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings
cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/web/ src-tauri/Cargo.toml
git commit -m "feat(web): the wasm entry points - OPFS, fetch, and a streaming ingest

Five wasm_bindgen functions, each returning a JSON string rather than a JsValue: the
TypeScript side already knows web::wire's shape, and a second structural representation of it
is a second place to drift.

The shapes are the spike's. probe2 for the sahpool install and the reopen, probe3 for the
bytes_stream -> decoder -> batch loop and for reading the bulk descriptor with .text() plus
serde (.json() needs a reqwest feature this crate does not enable), probe4 for the gzip sniff
that shipped as feed::frame::Decoder in PR 1.

net is four functions and not a port of scryfall::Client, which sets a user_agent, a
connect_timeout and a read_timeout that the wasm backend does not have, paces against a
tokio Instant, and resumes a partial file. A browser can do none of it - User-Agent is a
forbidden header for fetch - and the rate-limit pacing owed here belongs with the sync port.

Nothing panics: a wasm trap arrives in the Worker's onerror with nothing a page can read."
```

---

### Task 7: The browser `Core` and the Worker that owns the database

**Files:**
- Create: `src/workers/protocol.ts` — the message types both ends share
- Create: `src/workers/db.ts` — the Worker
- Create: `src/lib/core/browser.ts` — the second `Core` implementation
- Create: `src/lib/core/browser.test.ts`
- Modify: `src/lib/core/index.ts` — select the implementation by build
- Modify: `src/vite-env.d.ts` — declare `__CORE__`
- Modify: `vite.config.ts` — define `__CORE__`

**Interfaces:**
- Consumes: `Core` from `src/lib/core/types.ts`, shipped by PR 2 and **unchanged** — two methods, `call` and `listen`.
- Produces: `createBrowserCore(spawn: () => Worker)`, `browserCore`, `openBrowserDatabase()`, `buildCorpus(onProgress)`.

> **Boundary A does not move.** `Core` stays exactly `call` + `listen`; `src/lib/ipc.ts` keeps
> its 136 method bodies and its argument-name pins; `ipc.test.ts` is untouched. What this task
> adds is a second thing that satisfies the interface. Opening the database and building the
> corpus are **not** on `Core` — they happen once, before any command, and putting them there
> would make every implementation carry a method two of the three cannot answer.

> **Which core a build talks to is a fact about the *build*.** `core/index.ts` already says so
> in its own doc comment. So the switch is a Vite `define` and not a runtime probe: sniffing
> for `__TAURI_INTERNALS__` would select the browser core inside vitest, where that global is
> absent and every `ipc.test.ts` assertion expects the Tauri one.

> **Ids, not order.** The Worker answers a slow search after a fast one that was sent later.
> A queue that resolved by arrival would hand the wrong rows to the wrong caller, and the
> symptom would be a page that is subtly, intermittently wrong rather than broken.

- [ ] **Step 1: Write the failing test**

Create `src/lib/core/browser.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserCore } from "@/lib/core/browser";

/**
 * A Worker that never runs anything. `posted` is what the core sent; `reply` is how a test
 * plays the Worker's part, which is the only way to control the ordering this suite is
 * about.
 */
class FakeWorker {
  posted: unknown[] = [];
  terminated = false;
  private listeners = new Set<(e: MessageEvent) => void>();

  postMessage(data: unknown) {
    this.posted.push(data);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (type === "message") this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: (e: MessageEvent) => void) {
    this.listeners.delete(fn);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    for (const fn of this.listeners) fn({ data } as MessageEvent);
  }
}

let worker: FakeWorker;
let spawned: number;
const core = () => {
  spawned = 0;
  worker = new FakeWorker();
  return createBrowserCore(() => {
    spawned += 1;
    return worker as unknown as Worker;
  });
};

beforeEach(() => {
  spawned = 0;
});

describe("the browser core", () => {
  it("does not spawn a Worker until something asks it to", () => {
    core();
    expect(spawned).toBe(0);
  });

  it("posts a command with its named arguments and resolves on the matching id", async () => {
    const c = core();
    const answer = c.call("search_cards", { req: { text: "bolt" } });
    expect(worker.posted).toEqual([
      { kind: "call", id: 1, command: "search_cards", args: { req: { text: "bolt" } } },
    ]);
    worker.reply({ kind: "ok", id: 1, result: { total: 1 } });
    await expect(answer).resolves.toEqual({ total: 1 });
  });

  it("sends no args key at all for a no-argument command", async () => {
    const c = core();
    const answer = c.call("list_sets");
    expect(worker.posted[0]).toEqual({ kind: "call", id: 1, command: "list_sets" });
    worker.reply({ kind: "ok", id: 1, result: [] });
    await expect(answer).resolves.toEqual([]);
  });

  /**
   * The reason ids exist. Two calls out, answered in the opposite order: each promise must
   * get its OWN result, not whichever arrived first.
   */
  it("resolves each call with its own answer whatever order they come back in", async () => {
    const c = core();
    const first = c.call<string>("search_cards", { req: { text: "slow" } });
    const second = c.call<string>("search_cards", { req: { text: "fast" } });

    worker.reply({ kind: "ok", id: 2, result: "fast" });
    worker.reply({ kind: "ok", id: 1, result: "slow" });

    await expect(first).resolves.toBe("slow");
    await expect(second).resolves.toBe("fast");
  });

  it("rejects with the Worker's own message", async () => {
    const c = core();
    const answer = c.call("search_cards", { req: {} });
    worker.reply({ kind: "err", id: 1, message: "unknown command `search_cards`" });
    await expect(answer).rejects.toThrow("unknown command `search_cards`");
  });

  it("hands an event's payload to every subscriber, and stops on unsubscribe", () => {
    const c = core();
    const a = vi.fn();
    const b = vi.fn();
    const offA = c.listen("sync-progress", a);
    c.listen("sync-progress", b);

    worker.reply({ kind: "event", event: "sync-progress", payload: { done: 2000 } });
    expect(a).toHaveBeenCalledWith({ done: 2000 });
    expect(b).toHaveBeenCalledWith({ done: 2000 });

    offA();
    worker.reply({ kind: "event", event: "sync-progress", payload: { done: 4000 } });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("ignores an event nobody is listening for", () => {
    const c = core();
    const seen = vi.fn();
    c.listen("sync-progress", seen);
    worker.reply({ kind: "event", event: "combo-progress", payload: {} });
    expect(seen).not.toHaveBeenCalled();
  });

  /**
   * A React cleanup cannot await, and a component can unmount before anything has
   * subscribed. `listen` is synchronous on the Tauri side for exactly this reason and must
   * be here too.
   */
  it("returns an unsubscribe that is callable immediately", () => {
    const c = core();
    const off = c.listen("sync-progress", vi.fn());
    expect(() => off()).not.toThrow();
    expect(() => off()).not.toThrow();
  });

  it("reuses one Worker across every call and subscription", async () => {
    const c = core();
    const one = c.call("list_sets");
    c.listen("sync-progress", vi.fn());
    const two = c.call("sync_status");
    expect(spawned).toBe(1);
    worker.reply({ kind: "ok", id: 1, result: [] });
    worker.reply({ kind: "ok", id: 2, result: {} });
    await Promise.all([one, two]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:run -- src/lib/core/browser.test.ts 2>&1 | tail -20`
Expected: the file fails to resolve `@/lib/core/browser` — `Failed to load url`. Not "0 tests".

- [ ] **Step 3: Write the implementation**

Create `src/workers/protocol.ts`:

```ts
/**
 * What crosses `postMessage` between the page and the database Worker.
 *
 * The mirror of `src-tauri/src/web/wire.rs`, hand-written for the same reason every DTO in
 * `src/lib/ipc.ts` is: there is no generator, and a `serde` rename here is a `undefined`
 * there rather than a type error. `wire.rs`'s own tests pin the `kind` strings on the Rust
 * side; this file is what pins them on ours.
 */

/** Page → Worker. */
export type ToWorker =
  | { kind: "open"; directory: string; file: string }
  | { kind: "call"; id: number; command: string; args?: Record<string, unknown> }
  | { kind: "ingest-cards"; descriptorUrl: string };

/** Worker → page. */
export type FromWorker =
  | { kind: "opened"; opened: Opened }
  | { kind: "ok"; id: number; result: unknown }
  | { kind: "err"; id: number; message: string }
  | { kind: "event"; event: string; payload: unknown }
  | { kind: "corpus-done"; inserted: number; skipped: number }
  | { kind: "corpus-failed"; message: string };

/** The answer to `open`. Mirrors `wire::Opened`. */
export type Opened =
  | { kind: "ready"; journal: string; schemaVersion: number }
  | { kind: "already-open" }
  | { kind: "failed"; message: string };

/** The event the Worker emits while the corpus is being built. */
export const CORPUS_PROGRESS = "corpus-progress";
```

Create `src/workers/db.ts`:

```ts
/// <reference lib="webworker" />
import type { FromWorker, Opened, ToWorker } from "./protocol";
import { CORPUS_PROGRESS } from "./protocol";

/**
 * The database, and everything that touches it.
 *
 * **Not an optimisation — it is where the app is.** OPFS `SyncAccessHandle`s are only
 * obtainable off the main thread, so `opfs-sahpool` can only be installed here; and the pool
 * permits one connection, so there is nowhere else for the database to be. Every read and
 * every write in the web build queues through this file.
 */

interface Glue {
  default(init: { module_or_path: string }): Promise<unknown>;
  open(directory: string, file: string): Promise<string>;
  call(requestJson: string): string;
  ingest_cards(descriptorUrl: string, onProgress: (n: number) => void): Promise<string>;
  close(): void;
}

let glue: Glue | undefined;

/**
 * Loaded by URL rather than imported, and `@vite-ignore` is what keeps it that way.
 *
 * `web/public/wasm/` is written by `scripts/build-wasm.mjs` and is **gitignored**. A static
 * import would put it in the module graph, and then `vite build` for the *desktop* bundle
 * would fail on a machine that has never run the wasm build — for a branch the desktop build
 * folds away as dead code anyway.
 *
 * `{ module_or_path }` and not a bare argument: wasm-bindgen 0.2.127 deprecated the
 * positional form.
 */
async function load(): Promise<Glue> {
  if (!glue) {
    const mod = (await import(/* @vite-ignore */ "/wasm/mtg_grimoire_lib.js")) as Glue;
    await mod.default({ module_or_path: "/wasm/mtg_grimoire_lib_bg.wasm" });
    glue = mod;
  }
  return glue;
}

const send = (message: FromWorker) => self.postMessage(message);

self.addEventListener("message", (e: MessageEvent<ToWorker>) => {
  void handle(e.data);
});

async function handle(message: ToWorker): Promise<void> {
  try {
    const wasm = await load();
    switch (message.kind) {
      case "open": {
        const opened = JSON.parse(await wasm.open(message.directory, message.file)) as Opened;
        send({ kind: "opened", opened });
        return;
      }
      case "call": {
        // `args` is omitted for a no-argument command, matching `core/tauri.ts`'s arity
        // rule; `wire::Request.args` is `#[serde(default)]` and reads that as `{}`.
        const answer = JSON.parse(
          wasm.call(
            JSON.stringify({ id: message.id, command: message.command, args: message.args }),
          ),
        ) as FromWorker;
        send(answer);
        return;
      }
      case "ingest-cards": {
        const done = JSON.parse(
          await wasm.ingest_cards(message.descriptorUrl, (n: number) =>
            send({ kind: "event", event: CORPUS_PROGRESS, payload: { inserted: n } }),
          ),
        ) as { kind: string; inserted?: number; skipped?: number; message?: string };
        send(
          done.kind === "ok"
            ? { kind: "corpus-done", inserted: done.inserted ?? 0, skipped: done.skipped ?? 0 }
            : { kind: "corpus-failed", message: done.message ?? "the ingest failed" },
        );
        return;
      }
    }
  } catch (err) {
    // A wasm trap surfaces here and NOWHERE the page can read — probe 2 spent a run sitting
    // at "running…" for exactly this reason. Forwarding it by hand is the only way a failure
    // in the Worker becomes something a reader can be shown.
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (message.kind === "call") send({ kind: "err", id: message.id, message: text });
    else if (message.kind === "open")
      send({ kind: "opened", opened: { kind: "failed", message: text } });
    else send({ kind: "corpus-failed", message: text });
  }
}

self.addEventListener("beforeunload", () => glue?.close());
```

Create `src/lib/core/browser.ts`:

```ts
import type { FromWorker, Opened, ToWorker } from "@/workers/protocol";
import type { Core } from "./types";

/**
 * The web implementation of {@link Core}: everything goes to the database Worker.
 *
 * **Ids and not order.** The Worker answers a slow search after a fast one that was sent
 * later, so each pending call is keyed by an id and resolved by that id alone. A queue
 * resolved by arrival would hand the wrong rows to the wrong caller, and the symptom would
 * be a page that is intermittently wrong rather than one that is broken.
 */
export interface BrowserCore extends Core {
  /**
   * Install the OPFS pool and open the database. Once, before anything else.
   *
   * **Not a method on {@link Core}**, because two of the three implementations have no
   * answer for it: a Tauri build's database is already open by the time the page exists.
   */
  open(directory: string, file: string): Promise<Opened>;
  /** Download and ingest Scryfall's bulk file. `onProgress` gets the running insert count. */
  buildCorpus(descriptorUrl: string, onProgress: (inserted: number) => void): Promise<void>;
  /** Testing seam: how many Workers this core has spawned. Always 0 or 1. */
  readonly spawned: () => number;
}

type Pending = { resolve: (value: never) => void; reject: (reason: Error) => void };

/**
 * `spawn` is a factory rather than a Worker so that nothing is created until something is
 * asked for — the Tauri build imports this module and folds the branch away, and a Worker
 * spawned at import time would be spawned there too.
 */
export function createBrowserCore(spawn: () => Worker): BrowserCore {
  let worker: Worker | undefined;
  let nextId = 1;
  let spawnCount = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(payload: never) => void>>();
  let opening: ((opened: Opened) => void) | undefined;
  let corpus: { done: () => void; failed: (e: Error) => void } | undefined;
  let corpusProgress: ((inserted: number) => void) | undefined;

  function ensure(): Worker {
    if (!worker) {
      spawnCount += 1;
      worker = spawn();
      worker.addEventListener("message", (e: MessageEvent<FromWorker>) => receive(e.data));
    }
    return worker;
  }

  function receive(message: FromWorker) {
    switch (message.kind) {
      case "ok": {
        pending.get(message.id)?.resolve(message.result as never);
        pending.delete(message.id);
        return;
      }
      case "err": {
        pending.get(message.id)?.reject(new Error(message.message));
        pending.delete(message.id);
        return;
      }
      case "event": {
        if (message.event === "corpus-progress") {
          corpusProgress?.((message.payload as { inserted: number }).inserted);
        }
        for (const fn of listeners.get(message.event) ?? []) fn(message.payload as never);
        return;
      }
      case "opened": {
        opening?.(message.opened);
        opening = undefined;
        return;
      }
      case "corpus-done": {
        corpus?.done();
        corpus = undefined;
        return;
      }
      case "corpus-failed": {
        corpus?.failed(new Error(message.message));
        corpus = undefined;
        return;
      }
    }
  }

  const post = (message: ToWorker) => ensure().postMessage(message);

  return {
    call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const id = nextId++;
      const answer = new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: never) => void, reject });
      });
      // `args` omitted rather than sent as `undefined`, mirroring `core/tauri.ts`: the
      // key's absence is what `wire::Request`'s `#[serde(default)]` reads as `{}`.
      post(args === undefined ? { kind: "call", id, command } : { kind: "call", id, command, args });
      return answer;
    },

    listen<T>(event: string, handler: (payload: T) => void): () => void {
      // Synchronous, because a React cleanup cannot await and a component can unmount
      // before anything has finished subscribing. There is nothing async to wait for here
      // anyway — the Worker does not acknowledge a subscription.
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const fn = handler as (payload: never) => void;
      set.add(fn);
      ensure();
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(event);
      };
    },

    open(directory: string, file: string): Promise<Opened> {
      return new Promise<Opened>((resolve) => {
        opening = resolve;
        post({ kind: "open", directory, file });
      });
    },

    buildCorpus(descriptorUrl: string, onProgress: (inserted: number) => void): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        corpusProgress = onProgress;
        corpus = { done: resolve, failed: reject };
        post({ kind: "ingest-cards", descriptorUrl });
      });
    },

    spawned: () => spawnCount,
  };
}

/**
 * The one this build uses. The `new Worker(new URL(…))` form is what Vite recognises, and it
 * only runs when something first calls or listens.
 */
export const browserCore: BrowserCore = createBrowserCore(
  () => new Worker(new URL("../../workers/db.ts", import.meta.url), { type: "module" }),
);
```

Change `src/lib/core/index.ts` to:

```ts
import { browserCore } from "./browser";
import { tauriCore } from "./tauri";
import type { Core } from "./types";

export type { Core };
export { browserCore };

/**
 * The implementation this build talks to.
 *
 * **A `define`, not a runtime probe.** Which core is answering is a fact about the *build*,
 * and a module-level constant is what stops anything re-rendering its way into a different
 * one. Sniffing for `__TAURI_INTERNALS__` would look equivalent and is not: that global is
 * absent under vitest, where every assertion in `ipc.test.ts` expects the Tauri core.
 *
 * The unused branch folds away — `__CORE__` is replaced at build time, so the desktop bundle
 * carries no Worker and the web bundle carries no `@tauri-apps/api`.
 */
export const core: Core = __CORE__ === "web" ? browserCore : tauriCore;
```

Add to `src/vite-env.d.ts`:

```ts
/**
 * Which {@link Core} implementation this build talks to. Replaced at build time by the
 * `define` in `vite.config.ts` (`"tauri"`) or `vite.web.config.ts` (`"web"`).
 */
declare const __CORE__: "tauri" | "web";
```

Add to `vite.config.ts`'s `defineConfig({ … })`, beside `resolve`:

```ts
  // Which core the bundle talks to. `"tauri"` here and in vitest; `vite.web.config.ts`
  // overrides it. A `define` rather than an env read so the unused branch is folded away
  // rather than merely unreachable.
  define: { __CORE__: JSON.stringify("tauri") },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run -- src/lib/core 2>&1 | tail -20`
Expected: `browser.test.ts` (9 tests) and `core.test.ts` (PR 2's) both green. **Read the counts.**

Then the whole suite, because `core/index.ts` changed and every `ipc.test.ts` assertion runs through it: `npm run test:run 2>&1 | tail -12`. Every one must still pass — that is what proves the `define` selected the Tauri core under vitest.

- [ ] **Step 5: Mutate to prove the tests bite**

Three mutations.

1. In `receive`'s `"ok"` arm, resolve the **oldest** pending entry instead of `message.id`'s:
   `const [first] = pending.keys(); pending.get(first)?.resolve(…)`.
   Expected: `resolves each call with its own answer whatever order they come back in` FAILS with `"fast"` where `"slow"` was expected. Revert.
2. In `call`, always send `args` (`{ kind: "call", id, command, args }`).
   Expected: `sends no args key at all for a no-argument command` FAILS — `toEqual` compares the whole object and an explicit `args: undefined` is a different one. Revert.
3. In `index.ts`, change the ternary to `browserCore` unconditionally.
   Expected: **a large number of `ipc.test.ts` failures**, because those assert against a mocked `invoke`. Revert.

**Stop and report any that survives.** Mutation 1 is the one that matters: without ids the bug is invisible until two requests overlap, which is every real session and no synchronous test.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src/workers/ src/lib/core/ src/vite-env.d.ts vite.config.ts
git commit -m "feat(core): a browser Core backed by the database Worker

Boundary A does not move - Core is still call + listen, ipc.ts keeps its 136 bodies and its
argument-name pins, and ipc.test.ts is untouched. This adds a second thing that satisfies the
interface. Opening the database and building the corpus are deliberately NOT on Core: they
happen once, before any command, and two of the three implementations have no answer for
them.

Which core a build talks to is a define rather than a runtime probe. Sniffing for
__TAURI_INTERNALS__ looks equivalent and is not - that global is absent under vitest, where
every ipc.test.ts assertion expects the Tauri core.

Calls are resolved by id and never by arrival: the Worker answers a slow search after a fast
one sent later, and a queue resolved by order would hand the wrong rows to the wrong caller -
a page that is intermittently wrong rather than broken.

The Worker forwards its own exceptions by hand, because a wasm trap surfaces in onerror with
nothing a page can read. probe2 spent a run sitting at 'running…' for exactly that."
```

---

### Task 8: The one-tab guard, and the page a first run needs

**Files:**
- Create: `src/web/WebBoot.tsx`
- Create: `src/web/AlreadyOpen.tsx`
- Create: `src/web/BuildCorpus.tsx`
- Create: `src/web/WebBoot.test.tsx`
- Create: `src/web/AlreadyOpen.test.tsx`
- Modify: `src/main.tsx` — render `WebBoot` on the web build

**Interfaces:**
- Consumes: `browserCore` (Task 7) — `open`, `buildCorpus`, `call`.
- Produces: `WebBoot`, `AlreadyOpen`, `BuildCorpus`, and the constants `OPFS_DIRECTORY`, `OPFS_FILE`, `BULK_DESCRIPTOR_URL`.

> **Spec §5.2 settled this and it is not a design question any more.** `opfs-sahpool` holds
> exclusive access handles; a second document opening the same database fails hard with
> `NoModificationAllowedError`. **The first tab wins and the second says so** — a plain page
> with a sentence and a Reload button. No pause/unpause handoff, no fight over the database.
> `pause_vfs()`/`unpause_vfs()` exist and building a handoff on them is deliberately declined.

> **Why a first-run page is in this PR and not deferred.** PR 4 routes four commands and none
> of them is `sync_run`, so the web build has no way to fill its corpus from the existing UI.
> A browse over an empty database proves nothing, and Task 10 has to measure a real one. The
> page is small: a sentence, the measured download size, a button, and a running count.

> **The download size shown is `compressed_size` from the bulk descriptor** — the feed's own
> number, read at the moment of asking. Spec §5.3 requires it for any feed over 5 MB on web.
> The metered-connection default that section also describes belongs with the rest of the
> feed prompts and is **not** built here; this page says the size and nothing about the link.

- [ ] **Step 1: Write the failing tests**

Create `src/web/AlreadyOpen.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AlreadyOpen } from "@/web/AlreadyOpen";

describe("the second-tab page", () => {
  it("says which app is open and where, in a sentence rather than an error", () => {
    render(<AlreadyOpen />);
    // A regex, because the sentence is one string across two elements and a CSS gap can
    // break an accessible name into "MTG Grimoireis already open".
    expect(screen.getByRole("heading", { name: /already open/i })).toBeInTheDocument();
    expect(screen.getByText(/another tab/i)).toBeInTheDocument();
    // No stack trace, no error code: the reader did nothing wrong.
    expect(screen.queryByText(/NoModificationAllowedError/)).not.toBeInTheDocument();
  });

  it("reloads when the button is pressed", async () => {
    const reload = vi.fn();
    render(<AlreadyOpen onReload={reload} />);
    await userEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
```

Create `src/web/WebBoot.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const open = vi.hoisted(() => vi.fn());
const call = vi.hoisted(() => vi.fn());
const buildCorpus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/core/browser", () => ({ browserCore: { open, call, buildCorpus } }));
// The real App mounts the whole product. What this suite is about is which of four things
// gets rendered, so the heaviest one stands in for itself.
vi.mock("@/App", () => ({ default: () => <div>the app</div> }));

import { WebBoot } from "@/web/WebBoot";

beforeEach(() => {
  open.mockReset();
  call.mockReset();
  buildCorpus.mockReset();
});

describe("the web boot", () => {
  it("renders the app once the database is open and a corpus is there", async () => {
    open.mockResolvedValue({ kind: "ready", journal: "delete", schemaVersion: 26 });
    call.mockResolvedValue({ cardCount: 117464 });
    render(<WebBoot />);
    expect(await screen.findByText("the app")).toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(1);
  });

  /** The whole point of the guard: a second tab gets a sentence, never the app. */
  it("renders the second-tab page instead of the app when the database is held elsewhere", async () => {
    open.mockResolvedValue({ kind: "already-open" });
    render(<WebBoot />);
    expect(await screen.findByRole("heading", { name: /already open/i })).toBeInTheDocument();
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
    // And no command is attempted against a database this tab does not have.
    expect(call).not.toHaveBeenCalled();
  });

  it("offers to build the corpus when the database is open and empty", async () => {
    open.mockResolvedValue({ kind: "ready", journal: "delete", schemaVersion: 26 });
    call.mockResolvedValue({ cardCount: 0 });
    render(<WebBoot />);
    expect(await screen.findByRole("button", { name: /build/i })).toBeInTheDocument();
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
  });

  it("shows the running count while the corpus is being built, then the app", async () => {
    open.mockResolvedValue({ kind: "ready", journal: "delete", schemaVersion: 26 });
    call.mockResolvedValueOnce({ cardCount: 0 }).mockResolvedValue({ cardCount: 117464 });
    let report: ((n: number) => void) | undefined;
    buildCorpus.mockImplementation((_url: string, onProgress: (n: number) => void) => {
      report = onProgress;
      return new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 0);
      });
    });

    render(<WebBoot />);
    await userEvent.click(await screen.findByRole("button", { name: /build/i }));
    report?.(24000);
    // Grouped, because 117 464 rows read as a phone number otherwise.
    expect(await screen.findByText(/24,000/)).toBeInTheDocument();
    expect(await screen.findByText("the app")).toBeInTheDocument();
  });

  it("says what went wrong rather than showing a blank page", async () => {
    open.mockResolvedValue({ kind: "failed", message: "QuotaExceededError: out of space" });
    render(<WebBoot />);
    expect(await screen.findByText(/QuotaExceededError/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:run -- src/web 2>&1 | tail -20`
Expected: both files fail to resolve their imports — `Failed to load url @/web/AlreadyOpen`. Not "0 tests".

- [ ] **Step 3: Write the implementation**

Create `src/web/AlreadyOpen.tsx`:

```tsx
/**
 * What the second tab gets.
 *
 * `opfs-sahpool` holds exclusive access handles and permits one connection to a database; a
 * second document asking for it is refused with `NoModificationAllowedError`. Spec §5.2
 * settled what to do about that: **the first tab wins and the second says so.** No
 * pause/unpause handoff — `pause_vfs()`/`unpause_vfs()` exist and a handoff is buildable, and
 * two tabs fighting over one database is a worse failure than one tab being told to use the
 * other.
 *
 * The reader did nothing wrong, so this is a sentence rather than an error: no code, no
 * stack, no retry loop. Reload is offered because the *other* tab may since have closed, and
 * pressing it is the only way to find out.
 */
export function AlreadyOpen({ onReload }: { onReload?: () => void }) {
  const reload = onReload ?? (() => window.location.reload());
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">MTG Grimoire is already open</h1>
        <p className="text-muted-foreground">
          Your collection is open in another tab of this browser. Only one tab can use the card
          database at a time, so this one is standing aside.
        </p>
        <p className="text-muted-foreground">
          Switch to that tab, or close it and reload this one.
        </p>
        <button
          type="button"
          onClick={reload}
          className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
        >
          Reload
        </button>
      </div>
    </main>
  );
}
```

Create `src/web/BuildCorpus.tsx`:

```tsx
import { useState } from "react";
import { browserCore } from "@/lib/core/browser";

/** Scryfall's bulk descriptor for the everything-printing file. `Access-Control-Allow-Origin: *`
 *  — verified 2026-08-27, and it is the only reason a browser can build its own corpus. */
export const BULK_DESCRIPTOR_URL = "https://api.scryfall.com/bulk-data/default_cards";

/**
 * The first run: there is a database and it has no cards in it.
 *
 * **Measured, so the reader is told what they are agreeing to.** 74.4 MB gzipped in, 598.8 MB
 * of JSON out, 117 464 rows, ~10.4 s on a desktop and ~36.5 s on a flagship phone
 * (2026-08-27, Chrome 151, release wasm). The count below is the honest progress signal: it
 * is the same 2 000-row batch that bounds how long the database connection is held.
 *
 * **Nothing here asks `navigator.storage.estimate()`.** It reported 647 MB during a fill and
 * 7 MB immediately after a restart, against a file that was 532.8 MB both times, and the same
 * quota on a desktop and a phone. It is not a pre-flight and must never gate an ingest.
 */
export function BuildCorpus({ onDone }: { onDone: () => void }) {
  const [inserted, setInserted] = useState<number | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const running = inserted !== undefined && failed === undefined;

  const start = () => {
    setFailed(undefined);
    setInserted(0);
    void browserCore.buildCorpus(BULK_DESCRIPTOR_URL, setInserted).then(onDone, (e: Error) => {
      setFailed(e.message);
      setInserted(undefined);
    });
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">Build the card database</h1>
        <p className="text-muted-foreground">
          MTG Grimoire builds its own copy of Scryfall&rsquo;s card data on this device. It is
          about 75 MB to download and takes under a minute on a desktop.
        </p>
        {failed !== undefined && <p role="alert">{failed}</p>}
        {running ? (
          <p aria-live="polite">{inserted.toLocaleString("en-US")} cards</p>
        ) : (
          <button
            type="button"
            onClick={start}
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
          >
            Build it now
          </button>
        )}
      </div>
    </main>
  );
}
```

Create `src/web/WebBoot.tsx`:

```tsx
import { useEffect, useState } from "react";
import App from "@/App";
import { browserCore } from "@/lib/core/browser";
import type { Opened } from "@/workers/protocol";
import { AlreadyOpen } from "./AlreadyOpen";
import { BuildCorpus } from "./BuildCorpus";

/** The OPFS folder the sahpool lives in, and the database inside it. A bare name and not a
 *  path: the pool *is* the filesystem. */
export const OPFS_DIRECTORY = "mtg-grimoire";
export const OPFS_FILE = "mtg.db";

type Phase =
  | { at: "opening" }
  | { at: "already-open" }
  | { at: "failed"; message: string }
  | { at: "empty" }
  | { at: "ready" };

/**
 * The web build's root, and the only thing `main.tsx` renders differently.
 *
 * Four outcomes and one of them is not an error: a database that opened and holds no cards is
 * a first run, not a fault. The one that *is* refused — another tab holding the pool's access
 * handles — gets a sentence rather than a stack trace, per spec §5.2.
 *
 * `<App />` is mounted only once a corpus exists, so nothing inside it ever has to know that
 * an empty database was a state it could have been born into.
 */
export function WebBoot() {
  const [phase, setPhase] = useState<Phase>({ at: "opening" });

  useEffect(() => {
    let live = true;
    void browserCore.open(OPFS_DIRECTORY, OPFS_FILE).then(async (opened: Opened) => {
      if (!live) return;
      if (opened.kind === "already-open") return setPhase({ at: "already-open" });
      if (opened.kind === "failed") return setPhase({ at: "failed", message: opened.message });
      const status = await browserCore.call<{ cardCount: number | null }>("sync_status");
      if (!live) return;
      setPhase({ at: (status.cardCount ?? 0) > 0 ? "ready" : "empty" });
    });
    return () => {
      live = false;
    };
  }, []);

  if (phase.at === "already-open") return <AlreadyOpen />;
  if (phase.at === "failed")
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-xl font-semibold">The card database would not open</h1>
          <p role="alert" className="text-muted-foreground">
            {phase.message}
          </p>
        </div>
      </main>
    );
  if (phase.at === "empty") return <BuildCorpus onDone={() => setPhase({ at: "ready" })} />;
  if (phase.at === "ready") return <App />;
  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      Opening the card database&hellip;
    </main>
  );
}
```

Change `src/main.tsx`'s render call — everything above it is untouched:

```tsx
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {/* Which root a build gets is the same `define` that picks the core, and it folds away:
        a Tauri bundle carries no `WebBoot` and no Worker. The web build cannot render `App`
        directly because its database has to be opened first, and opening it can answer
        "another tab already has it". */}
    {__CORE__ === "web" ? <WebBoot /> : <App />}
  </React.StrictMode>,
);
```

and add `import { WebBoot } from "./web/WebBoot";` beside the existing `import App from "./App";`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run -- src/web 2>&1 | tail -20`
Expected: 7 tests green (2 in `AlreadyOpen.test.tsx`, 5 in `WebBoot.test.tsx`). **Read the count.**

Then the whole suite and the build: `npm run build 2>&1 | tail -5` and `npm run test:run 2>&1 | tail -12`. `App.test.tsx` must be untouched — `main.tsx` is not in the coverage include and nothing else imports `WebBoot`.

- [ ] **Step 5: Mutate to prove the tests bite**

Three mutations.

1. In `WebBoot`, change the `already-open` arm to fall through to `<App />`.
   Expected: `renders the second-tab page instead of the app when the database is held elsewhere` FAILS. Revert.
2. In `WebBoot`, change `(status.cardCount ?? 0) > 0` to `>= 0`.
   Expected: `offers to build the corpus when the database is open and empty` FAILS — an empty database would render the app. Revert.
3. In `BuildCorpus`, drop `.toLocaleString("en-US")`.
   Expected: `shows the running count while the corpus is being built, then the app` FAILS on `/24,000/`. Revert.

**Stop and report any that survives.** Mutation 1 is the guard itself: if the app renders in a second tab it will fail on its first query, in a way that looks like a broken database rather than a tab that should not be open.

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src/web/ src/main.tsx
git commit -m "feat(web): the first tab wins, and the second one says so

opfs-sahpool holds exclusive access handles and permits one connection; a second document is
refused with NoModificationAllowedError. Spec 5.2 settled what to do: the first tab wins and
the second gets a sentence and a Reload button. No pause/unpause handoff - two tabs fighting
over one database is a worse failure than one tab standing aside.

WebBoot has four outcomes and one of them is not an error: a database that opened with no
cards in it is a first run. It gets a page with the measured download size and a running
count, because PR 4 routes four commands and sync_run is not one of them - without this there
is no way to fill a corpus, and a browse over an empty database measures nothing.

Nothing asks navigator.storage.estimate(). It reported 647 MB during a fill and 7 MB after a
restart against the same 532.8 MB file, and it must never gate an ingest."
```

---

### Task 9: The wasm build, the web bundle, and the CI job that gates them

**Files:**
- Create: `scripts/build-wasm.mjs`
- Create: `vite.web.config.ts`
- Modify: `package.json` — three scripts
- Modify: `.gitignore` — two generated directories
- Modify: `.github/workflows/ci.yml` — a `wasm` output, a `wasm` job, and `ci-ok`
- Modify: `.github/CLAUDE.md` — the router table gains a column

**Interfaces:**
- Consumes: the crate from Tasks 1–6, the frontend from Tasks 7–8.
- Produces: `npm run build:wasm`, `npm run web:dev`, `npm run web:build`.

> **clang is now a build requirement, permanently.** `sqlite-wasm-rs` compiles SQLite's C
> amalgamation with `cc` targeting wasm32, and MSVC cannot emit wasm. Spec §9 names this as
> the toolchain cost of shipping the web target; this is the task that pays it.

> **`wasm-bindgen-cli` must match the `wasm-bindgen` crate exactly.** A mismatch is not a
> build error — it is a runtime failure inside the generated glue, with a message about an
> import that does not exist. So the version is pinned in `Cargo.toml` with `=`, pinned again
> in the build script, and the script refuses to run when the two disagree or when the
> installed CLI is a third number.

- [ ] **Step 1: Write the build script**

Create `scripts/build-wasm.mjs`:

```js
#!/usr/bin/env node
// Build the Rust core for the browser: cargo, then wasm-bindgen, then the assets the web
// bundle serves them from.
//
// Two prerequisites this script checks rather than assumes, because both fail in ways that
// do not name themselves:
//
//   * `wasm-bindgen-cli` must match the `wasm-bindgen` crate EXACTLY. A mismatch compiles
//     and links fine and then fails at run time inside the generated glue, complaining about
//     an import nobody wrote. So the version is pinned in three places and checked here.
//   * clang must be on PATH. `sqlite-wasm-rs` compiles SQLite's C amalgamation with `cc` for
//     wasm32 and MSVC cannot emit wasm; without clang the failure is a `cc` error a hundred
//     lines into a build log.
//
// Output lands in `web/public/`, which is gitignored in full: everything there is generated,
// including the favicon copy, so that the DESKTOP bundle never carries a 2 MB wasm module it
// has no use for.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Kept in step with `wasm-bindgen = "=0.2.127"` in `src-tauri/Cargo.toml`. */
const PINNED = "0.2.127";
const OUT = join("web", "public", "wasm");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.error) {
    console.error(`could not run \`${command}\`: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

// --- the two prerequisites -------------------------------------------------------------
const manifest = readFileSync(join("src-tauri", "Cargo.toml"), "utf8");
if (!manifest.includes(`wasm-bindgen = "=${PINNED}"`)) {
  console.error(
    `src-tauri/Cargo.toml does not pin wasm-bindgen to =${PINNED}.\n` +
      "The crate and this script must name the same version, and the pin must keep its `=`:\n" +
      "a caret would let cargo resolve a newer crate than the installed CLI can generate for.",
  );
  process.exit(1);
}

const cli = capture("wasm-bindgen", ["--version"]);
if (cli === undefined) {
  console.error(
    "wasm-bindgen is not on PATH. Install the matching CLI:\n" +
      `  cargo install wasm-bindgen-cli --version ${PINNED} --locked`,
  );
  process.exit(1);
}
if (!cli.endsWith(PINNED)) {
  console.error(
    `wasm-bindgen-cli is \`${cli}\` and the crate is pinned to ${PINNED}.\n` +
      "These must match exactly. A mismatch is not a build error - it fails at run time\n" +
      "inside the generated glue, complaining about an import nobody wrote.\n" +
      `  cargo install wasm-bindgen-cli --version ${PINNED} --locked --force`,
  );
  process.exit(1);
}

if (capture("clang", ["--version"]) === undefined) {
  console.error(
    "clang is not on PATH, and sqlite-wasm-rs compiles SQLite's C amalgamation with `cc`\n" +
      "targeting wasm32 - which MSVC cannot do. Install LLVM and put its bin directory on\n" +
      "PATH (on Windows that is usually C:\\Program Files\\LLVM\\bin).",
  );
  process.exit(1);
}

// --- build -----------------------------------------------------------------------------
run("cargo", [
  "build",
  "--manifest-path",
  join("src-tauri", "Cargo.toml"),
  "--target",
  "wasm32-unknown-unknown",
  "--release",
  "--lib",
  "--locked",
]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
run("wasm-bindgen", [
  "--target",
  "web",
  "--out-dir",
  OUT,
  // No `.d.ts`: `src/workers/db.ts` declares the four functions it calls by hand, and
  // tsconfig's `include` is `src` alone - a generated declaration outside it would be typed
  // by nothing and would break the desktop build on a checkout that never ran this script.
  "--no-typescript",
  join("src-tauri", "target", "wasm32-unknown-unknown", "release", "mtg_grimoire_lib.wasm"),
]);

// The web bundle's `publicDir` is `web/public`, so it does not get the repo's `public/`.
// `index.html` links the favicon by absolute path, and copying it here keeps that one
// `index.html` serving both builds.
copyFileSync(join("public", "mtg-grimoire-mark.svg"), join("web", "public", "mtg-grimoire-mark.svg"));

console.log(`wasm core built into ${OUT}`);
```

- [ ] **Step 2: Write the web build config and the scripts**

Create `vite.web.config.ts`:

```ts
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

/**
 * The web target's build. Everything the desktop build does, plus three differences.
 *
 * **One `index.html` and one `main.tsx` serve both**, which is why this is a merge rather
 * than a second project: the only thing that differs at the entry point is `__CORE__`, and
 * the branch it selects folds away in each bundle.
 *
 * `publicDir` points at a directory that is **generated in full** — `scripts/build-wasm.mjs`
 * writes the wasm module there and copies the favicon in beside it. That is what keeps a
 * 2 MB wasm module out of the desktop bundle, and therefore out of the portable exe, on a
 * machine where someone has run the wasm build.
 *
 * Port 5173 is Vite's own default and the one the spike served its probes on. It is not
 * 1420: that is `tauri dev`'s, it is hardcoded in tracked files, and the two must be able to
 * run at once.
 */
export default mergeConfig(
  base,
  defineConfig({
    publicDir: "web/public",
    define: { __CORE__: JSON.stringify("web") },
    build: { outDir: "dist-web", emptyOutDir: true },
    server: { port: 5173, strictPort: true },
  }),
);
```

> **Do not add `vite.web.config.ts` to `tsconfig.node.json`.** That file's own comment
> explains why its `include` is `vite.config.ts` alone: `composite: true` makes every listed
> file an output of a referenced project, and the root `tsconfig.json` includes `src` — a
> file in both produces `TS6305` and fails `npm run build` on a clean checkout. It took
> `main`'s CI red twice already.

Add to `package.json`'s `scripts`:

```json
    "build:wasm": "node scripts/build-wasm.mjs",
    "web:dev": "vite --config vite.web.config.ts",
    "web:build": "tsc && vite build --config vite.web.config.ts",
```

Add to `.gitignore`, after the `dist/` line:

```
# The web target's bundle, and the directory it is served from. `web/public/` is generated in
# FULL by `scripts/build-wasm.mjs` - the wasm module, its glue, and a copy of the favicon -
# which is what keeps a 2 MB wasm module out of the desktop bundle and therefore out of the
# portable exe.
dist-web/
web/public/
```

- [ ] **Step 3: Run it, and confirm the whole chain works**

```bash
npm run build:wasm
ls -la web/public/wasm
npm run web:build
ls -la dist-web
```

Expected: `web/public/wasm/mtg_grimoire_lib.js` and `mtg_grimoire_lib_bg.wasm` (the spike measured 2.2 MB before `wasm-opt`, with reqwest, flate2 and serde in it), and a `dist-web/index.html`.

Then confirm the desktop bundle is unaffected: `npm run build && ls dist` — no `wasm/` directory in `dist/`.

- [ ] **Step 4: Add the CI job**

In `.github/workflows/ci.yml`:

**a.** Add `wasm` to the `changes` job's `outputs`:

```yaml
      wasm: ${{ steps.classify.outputs.wasm }}
```

**b.** In the classify script, initialise it beside the others (`wasm=false`, and `wasm=true` in the "no usable base commit" arm), and add these `case` arms. **Order matters — `case` is first-match-wins**, so each of these must sit *above* the broader arm it narrows:

```bash
              # This file. A change to the gate re-runs the whole gate.
              .github/workflows/ci.yml)
                frontend=true
                rust=true
                powershell=true
                wasm=true
                ;;

              # The wasm build's own inputs, and nothing else's. Above `scripts/*` and
              # `src/*` because both of those match more broadly and would run the wrong
              # jobs first.
              scripts/build-wasm.mjs|vite.web.config.ts)
                frontend=true
                wasm=true
                ;;
              src/workers/*|src/web/*|src/lib/core/*)
                frontend=true
                wasm=true
                ;;
```

and extend the existing `src-tauri/*` and `package.json` arms:

```bash
              # Rust. Every change here can break the wasm build too - the crate is one
              # crate with two targets, and a `use tauri::` added to a module on the wasm
              # side of `lib.rs`'s map compiles on desktop and fails there.
              src-tauri/*)
                rust=true
                wasm=true
                ;;
```

```bash
              package.json|package-lock.json|components.json|.prettierrc)
                frontend=true
                wasm=true
                ;;
```

and the fail-safe:

```bash
              *)
                frontend=true
                rust=true
                wasm=true
                ;;
```

Add `| wasm | \`$wasm\` |` to the step summary table, and `echo "wasm=$wasm" >> "$GITHUB_OUTPUT"`.

**c.** Add the job, after `rust`:

```yaml
  wasm:
    name: wasm
    needs: changes
    if: needs.changes.outputs.wasm == 'true'
    # Linux only, and not as a preference: this compiles SQLite's C amalgamation to wasm32
    # with clang, which is the same compiler on every host. A Windows leg would prove the
    # same thing more slowly. **Note that no measured figure in this repo has ever come off
    # a Linux build** — this job is a compile gate, not a source of numbers.
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      # sqlite-wasm-rs compiles SQLite's C with `cc` targeting wasm32. There is no way
      # around this and no way to cache past it.
      - name: Install clang
        run: sudo apt-get update && sudo apt-get install -y clang

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown
          components: clippy

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
          # Its own key: this target's artifacts share nothing with the host build's, and a
          # shared cache would thrash between the two jobs.
          key: wasm

      # Pinned, and `--locked`. The CLI must match the `wasm-bindgen` crate EXACTLY;
      # `scripts/build-wasm.mjs` re-checks that pair and refuses if they have drifted.
      - name: Install wasm-bindgen-cli
        run: cargo install wasm-bindgen-cli --version 0.2.127 --locked

      # No `dist/` stub here, unlike the `rust` job: `build.rs` returns early for a wasm
      # TARGET, so `tauri_build` — which is what demands `frontendDist` — never runs.
      - name: Build the wasm core
        run: npm run build:wasm

      - name: cargo clippy (wasm)
        working-directory: src-tauri
        run: cargo clippy --lib --locked --target wasm32-unknown-unknown -- -D warnings

      - name: Build the web bundle
        run: npm run web:build
```

**d.** Add it to `ci-ok`:

```yaml
    needs: [changes, frontend, rust, powershell, wasm]
```

```yaml
          WASM: ${{ needs.wasm.result }}
```

```yaml
          for result in "$FRONTEND" "$RUST" "$POWERSHELL" "$WASM"; do
```

and add `$WASM` to the `echo` line at the top of the step.

> **`ci-ok` is the one protected check.** A job that is not in that loop is a job whose
> failure the gate ignores — which is exactly what "a required check that never reports"
> looks like from a PR. The loop and the `needs:` list must both name it.

**e.** In `.github/CLAUDE.md`, add `wasm` to the router's job table and to any list of jobs
`ci-ok` aggregates. **Re-count anything the file states as a number** — a prose-only edit
routes to neither build job, so nothing goes red when that list rots.

- [ ] **Step 5: Mutate to prove the gates bite**

Three mutations, all local — no push needed.

1. In `scripts/build-wasm.mjs`, change `PINNED` to `"0.2.126"`. Run `npm run build:wasm`.
   Expected: it refuses **before** running cargo, naming both versions and the
   `cargo install … --force` line. Revert.
2. Temporarily rename `clang` out of PATH (`PATH=/usr/bin npm run build:wasm` on Linux, or
   drop the LLVM entry on Windows). Expected: the clang message, again before cargo runs.
   Revert.
3. In `src-tauri/src/search.rs`, temporarily add `use tauri::Manager;` at the top of the
   file. Run `npm run verify` — **green**, because the desktop build has `tauri`. Then run
   `cd src-tauri && cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings` —
   **red**, `unresolved import tauri`. Revert.

**Mutation 3 is the whole reason this job exists**, and it should be reported in the task's
notes either way: it is the demonstration that a fully green `npm run verify` can ship a
broken web target, which is the same shape as `cargo fmt` and `clippy` already being outside
`verify`.

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add scripts/build-wasm.mjs vite.web.config.ts package.json package-lock.json .gitignore .github/
git commit -m "chore(ci): build the wasm core, and gate it

clang is now a permanent build requirement - sqlite-wasm-rs compiles SQLite's C amalgamation
with cc targeting wasm32, and MSVC cannot emit wasm. wasm-bindgen-cli must match the crate
exactly, and a mismatch is NOT a build error: it fails at run time inside the generated glue
complaining about an import nobody wrote. So the version is pinned with = in Cargo.toml,
pinned again in the build script, and the script refuses when the two disagree.

The web bundle is a merge of the desktop config with three differences, so one index.html and
one main.tsx serve both. Its publicDir is generated in full - the wasm module, its glue, and
a copy of the favicon - which is what keeps 2 MB of wasm out of the portable exe on a machine
where someone has run the wasm build.

A fully green npm run verify can ship a broken web target: a `use tauri::` added to a module
on the wasm side of lib.rs's map compiles on desktop and fails there. That is what this job
catches, and it is in ci-ok's loop because a job outside it is a job whose failure the gate
ignores."
```

---

### Task 10: Drive it in a real browser, measure it, and write down what it cost

**Files:**
- Create: `docs/reference/web-target.md`
- Modify: `docs/reference/data-and-sync.md` — the desktop baseline, re-measured
- Modify: `CLAUDE.md` — the reference-doc table
- Modify: `src-tauri/CLAUDE.md` — the module map's rule
- Modify: `docs/superpowers/research/2026-08-27-wasm-core-spike.md` — one sentence, to past tense
- Delete: `spike/` — 28 tracked files

**Interfaces:**
- Consumes: everything above.
- Produces: numbers, and a document that holds them.

> **Spec §9 fixes the method**: headless Chrome over CDP against the dev server. The spike's
> `serve.mjs` + `drive.mjs` proved the shape, and this repo already owns the better tool —
> `scripts/cdp.mjs` reads `CDP_PORT` from the environment, so it drives a browser on 9333
> exactly as it drives the app's WebView2 on 9222.

> **Traps that have each cost a session, and all of them apply here.** DevTools steals the
> page target — `cdp.mjs` takes the first `type: page`, so put `location.href` in every
> payload or drive by URL. Clicking and reading in one `eval` answers about the frame before
> React re-rendered; split it in two. A cold pointer makes `click` a no-op that still prints
> "clicked"; `hover --rest 200` first. Every binding inside an `eval` needs an IIFE — the
> scope is shared across invocations and a top-level `const` outlives its command.

> **Nothing in this task may be reported from a build that is not the one under test.** Put
> `location.href` and the wasm module's byte size in the first payload and keep them in the
> notes.

- [ ] **Step 1: Start the pieces**

Two shells. In the first:

```powershell
npm run build:wasm
npm run web:dev
```

In the second, a headless browser on **9333** — not 9223, and not 9222, which is the app's:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --headless=new --remote-debugging-port=9333 --disable-sync `
  --user-data-dir="$env:TEMP\mtg-web-cdp" "http://localhost:5173"
```

`--disable-sync` is not optional: without it Edge opens a sync-promo tab that becomes the
first `type: page` target and every probe answers about it.

Then, in a third:

```powershell
$env:CDP_PORT = "9333"
node scripts/cdp.mjs eval "(() => ({ href: location.href, root: document.getElementById('root')?.childElementCount }))()"
```

Expected: `href` is `http://localhost:5173/` and `root` is at least 1. If `root` is 0 the
page rendered nothing — read the console (`node scripts/cdp.mjs console out.jsonl`) before
anything else, because a wasm trap surfaces there and nowhere in the DOM.

- [ ] **Step 2: Measure the first run**

Press the first-run button and time the ingest from inside the page:

```powershell
node scripts/cdp.mjs hover "button" --rest 200
node scripts/cdp.mjs text "Build it now"
node scripts/cdp.mjs eval "(() => { globalThis.__t0 = performance.now(); return 'armed'; })()"
```

Poll until the app renders, then take the wall clock:

```powershell
node scripts/cdp.mjs eval "(() => ({ href: location.href, elapsed: Math.round(performance.now() - globalThis.__t0), body: document.body.innerText.slice(0, 120) }))()"
```

Record, in `docs/reference/web-target.md`:

| Figure | Where it comes from |
| --- | --- |
| wall clock for the first run | the `elapsed` above |
| rows inserted / skipped | the `corpus-done` message, read from `cdp.mjs console` |
| resulting database size | `PRAGMA page_count * page_size`, through a routed `sync_status` follow-up or a temporary console log |
| the wasm module's byte size | `ls -la web/public/wasm` |
| the journal SQLite chose | the `opened` message's `journal` — **expected `delete`** |

**Compare against the spike's 10.4 s desktop**, and say plainly that the spike wrote a
**20-column subset** of the 43-column row this now writes, with `raw` absent there and present
here. A slower number is the expected finding, not a regression — but it must be *named* as
one rather than presented beside the spike's as though they measured the same thing.

- [ ] **Step 3: Measure the two query shapes the spec asked for**

Spec §8 sets the web budget at **no interaction over 250 ms at p95**, and names the collapsed
browse as "the one number not yet taken in wasm" — 131.8 ms end-to-end on desktop today.

```powershell
node scripts/cdp.mjs eval "(async () => { const { core } = await import('/src/lib/core/index.ts'); const t = performance.now(); const r = await core.call('search_cards', { req: {} }); return { href: location.href, ms: Math.round(performance.now() - t), total: r.total }; })()"
```

and the facet pass, which rides the in-memory index rather than SQLite:

```powershell
node scripts/cdp.mjs eval "(async () => { const { core } = await import('/src/lib/core/index.ts'); const t = performance.now(); const f = await core.call('facet_cards', { req: {} }); return { href: location.href, ms: Math.round(performance.now() - t), ready: f.ready }; })()"
```

Take **five** of each and record the median and the worst, not one sample. Then re-run both
with `{ req: { text: "dragon" } }`.

> **`facets::compute` is 1.8 ms unfiltered on desktop and reads an in-memory Rust structure
> of bitsets and ordinal arrays** — it never touches SQLite, so spec §8 predicts it ports as
> ordinary Rust. If the browser figure is not in the same order of magnitude, that prediction
> was wrong and it is the most interesting thing in this PR. Say so.

- [ ] **Step 4: Drive the two-tab case, and find out which call fails**

Open a second tab at the same URL and read both:

```powershell
node scripts/cdp.mjs eval "(() => { globalThis.open('http://localhost:5173/', '_blank'); return 'opened'; })()"
```

Then list the targets (`curl http://127.0.0.1:9333/json/list`) and drive the *second* one.

Record two things:

1. **What the reader sees.** The second document must show "MTG Grimoire is already open",
   and the first must still work — run a `search_cards` in tab one afterwards and say so.
2. **Which call actually failed.** The spike quoted the `NoModificationAllowedError` message
   but did not isolate whether it comes from `install_opfs_pool` or from `open_pooled`.
   `Opened::from_open_error` handles both by matching the error *name*, so the guard is
   correct either way — but the answer belongs in the doc, because the next person to touch
   that path will want it. Read it from `cdp.mjs console`.

Then close the second tab, reload the first, and confirm it still opens: a guard that leaves
the pool wedged after a refused second tab is worse than no guard.

- [ ] **Step 5: Drive the combo feed, and assert the peak buffer**

The one feed whose browser behaviour genuinely differs — `fetch` has already gunzipped it,
and `feed::frame::Decoder` has to notice from the bytes.

```powershell
node scripts/cdp.mjs eval "(async () => { const w = new Worker('/src/workers/db.ts', { type: 'module' }); return 'not this way'; })()"
```

That is **not** how to do it — the Worker is already running and owns the connection. Instead,
call `ingest_combos` through the existing Worker by adding a temporary `ToWorker` case, or
drive it from a throwaway page. Whichever route is taken, record:

- wall clock, against the spike's **12.6 s** desktop
- variants seen / kept / skipped, against **111 148 / 105 516 / 5 632**
- **`peakBuffer`**, against **2.01 MB**

⚠️ **The peak buffer is the assertion that matters and a row count cannot replace it.** The
spike's first framer found 63 elements in 610 MB and grew to 609.82 MB without erroring. If
`peakBuffer` is anywhere near the document's own size, stop: the framer has desynchronised
and the row counts are fiction whatever they say.

If reaching `ingest_combos` needs more scaffolding than a temporary case, **say so in the doc
and leave it unmeasured rather than half-measured** — an honest "not measured, here is why" is
worth more than a number taken through a path the app does not have.

- [ ] **Step 6: Re-measure the desktop baseline**

Spec §8: *"Desktop must not regress. Every PR touching search, faceting or sync re-measures
the table in `data-and-sync.md` and shows both columns, with the build named."* This PR
touched the ingest (Task 4) and the index build (Task 3), so that is owed.

Run the app the way `running-the-app` says, take the same measurements
`docs/reference/data-and-sync.md` already records, and put the new column beside the old one
with the date and **debug or release named** — the same measurement can differ by ~8×.

- [ ] **Step 7: Write the reference doc, and prune the spike**

Create `docs/reference/web-target.md` holding, in this order:

1. **What the web target is** — one Worker, one connection, a rollback journal, no COOP/COEP.
2. **The module map** — the two columns from this plan's preamble, and the sentence that four
   of the exclusions are permanent and the rest are "not yet".
3. **Every measurement from Steps 2–5**, with the machine, the browser version and the build
   named, and the spike's figures beside them where they are comparable — with the 20-column
   caveat stated each time.
4. **The four differences from desktop a reader could notice**: no WAL; a search queues behind
   an ingest and behind an index build because there is one connection; a second tab is
   refused; and the `User-Agent` is the browser's rather than the app's, so this build is not
   identified to Scryfall the way the desktop is.
5. **What is not built yet** — the other 132 commands, the image cache, the price feeds
   (and that **Mana Pool is unavailable on web at all**, per spec §5.3, because it sends no
   `Access-Control-Allow-Origin`), the PWA shell, sync.
6. **The toolchain** — `rustup target add wasm32-unknown-unknown`, clang, the pinned
   `wasm-bindgen-cli`, and the three npm scripts.

Add a row to the reference-doc table in the root `CLAUDE.md`:

```markdown
| [web-target.md](docs/reference/web-target.md) | The browser build — the module map, the single connection and what it costs, the measured first run, and the four ways web differs from desktop |
```

Add to `src-tauri/CLAUDE.md`, in whatever section governs modules:

```markdown
- **`src-tauri/src/lib.rs` is the module map, and the split in it is binding.** A module in
  the "Every target" column must compile for `wasm32-unknown-unknown`, which means no
  `tauri::`, no `tokio::fs`, no `std::thread`, and **no `SystemTime::now()` or
  `Instant::now()` — both panic there**. `npm run verify` cannot see any of this; the `wasm`
  CI job is what does. See [web-target.md](../docs/reference/web-target.md).
```

Finally, delete the spike:

```bash
git rm -r spike/
```

Its four probes are now shipped code — probe 1 as the manifest, probe 2 as `db::install_opfs_pool`,
probe 3 as `web::glue::ingest_cards`, probe 4 as `feed::frame::Elements` (PR 1) and
`combos::StreamRead`. In
`docs/superpowers/research/2026-08-27-wasm-core-spike.md`, change *"Throwaway code lives on
the `spike-wasm-core` branch under `spike/`"* to say that it **lived** there and was removed
when this PR landed, naming where each probe went. The research doc's measurements stay
exactly as they are — they are dated evidence, not a status.

- [ ] **Step 8: Mutate the harness to prove the pass can fail**

A measurement pass that cannot report a failure is a pass that will report success on a broken
build. Two mutations.

1. Point `BULK_DESCRIPTOR_URL` at `https://api.scryfall.com/bulk-data/does-not-exist`, reload,
   and press the build button. Expected: the page shows the failure text under `role="alert"`
   within seconds — **not** a spinner that never ends. Revert.
2. Delete `web/public/wasm/mtg_grimoire_lib_bg.wasm` and reload. Expected: "The card database
   would not open" with a message, not a blank page. Restore with `npm run build:wasm`.

**Stop and report either one that hangs or blanks instead**, and fix it before the commit: a
web build whose failure mode is a blank page is worse than one that does not build.

- [ ] **Step 9: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
npm run build:wasm && npm run web:build
git add docs/ CLAUDE.md src-tauri/CLAUDE.md
git rm -r spike/
git commit -m "docs(web): what the browser build costs, measured

Every figure taken on the build named in the doc, driven over CDP against the real page. The
spike's numbers sit beside them where they are comparable, each time with the caveat that the
spike wrote a 20-column subset of the row this writes in full.

Four differences a reader could notice, written down rather than discovered: no WAL, so
durability differs; one connection, so a search queues behind an ingest and behind an index
build; a second tab is refused with a sentence; and the User-Agent is the browser's, because
it is a forbidden header for fetch - this build is not identified to Scryfall the way the
desktop is.

spike/ is deleted. Its four probes are shipped code now: probe1 the manifest, probe2
db::install_opfs_pool, probe3 web::glue::ingest_cards, probe4 feed::frame::Elements and
combos::StreamRead. The research doc keeps every measurement - those are dated evidence
rather than a status - and says where each probe went."
```

---

## Self-Review

**Spec coverage.** §5.1 the manifest split and SQLite in the browser (Task 2), §5.1's "no WAL,
and anything assuming it must be gated" (Task 3), §5.2 one connection and the one-tab guard
(Tasks 2, 3, 5, 8), §5.3's on-device corpus and the measured `compressed_size` prompt
(Tasks 6, 8), §5.4's "never gate on `storage.estimate()`" (Task 8), §4's Boundary B for the
one piece the browser actually needs (Task 4), §3's second `Core` implementation (Task 7), §8's
two unmeasured query shapes and the desktop-baseline obligation (Task 10), §9's verification
method and the clang requirement (Tasks 9, 10).

**Deliberately not covered**, each with its reason in the preamble: the other 132 commands and
their modules; the image cache (Cache Storage is a rewrite, not a port); `scryfall::Client`'s
pacing, penalty and resumable download; the PWA shell (**PR 5**); sync (**Phase 3**); mobile
layout (**Phase 5**); COOP/COEP (measured unnecessary and must not be added).

**Placeholders.** None. Every step carries the code it needs; no step says "similar to Task N".
The one place a range is given rather than a value is Task 10's expected timings, where the
value is the thing being measured.

**Every symbol was checked against the real file.** The ones that were wrong before checking,
and would have cost an execution session:

- **`ingest_stream` takes a synchronous `Iterator`.** The spec's §4.3 reads as though a stream
  is a stream; it is not, and a browser cannot produce a blocking one. Task 4 exists entirely
  because of this check.
- **`index::lifecycle::build_now` opens a connection of its own**, at
  `data_dir.join("mtg.db")`, and its doc explains at length why that is right. On the OPFS
  pool it is a third handle and fails. Found by reading the function, not the spec. Task 3.
- **`db::lock_for` calls `Instant::now()` before the `try_lock`**, so it panics on wasm even
  with `Duration::ZERO` — which its own doc describes as the no-sleep path. Task 3.
- **`CardIndex` has no `len()`.** `capacity` is the doc count and `set_codes` the set
  vocabulary; both are public fields. Task 3's test asserts on those.
- **`IngestError::Empty` is a struct variant**, `Empty { skipped: u64 }`, not a unit one.
- **`combos::Ingested`'s fields are `combos`, `cards`, `skipped`, `seen`** — checked because
  Task 6 serialises all four.
- **`combos::store` takes `fetched_at: i64` as a parameter**, which is what lets the wasm
  caller avoid `SystemTime::now()` — a call that **panics** on `wasm32-unknown-unknown`.
- **`crate::index::fixtures::state_with_seeded_cards(name)` is real**, is `pub(crate)`, returns
  `Arc<AppState>`, seeds four printings into a **file** database, and its own doc requires the
  name to be unique **crate-wide**. Tasks 3 and 5 use it and both name their directory.
- **`tags::normalize` has exactly one code caller outside `tags/`** — `schema.rs:876` — which
  is what makes Task 1 six lines rather than a module port.
- **`facet_cards`, not `facets`**, is the command name (`index/facets.rs:857`).
- **`build.rs` cannot ask `cfg!(target_family)`** — it compiles for the host. `TARGET` is the
  question, and `tauri_build` resolving plugin ACLs through the dependency graph is why it
  matters. Task 2.
- **`#[tauri::command(async)]` exists** in five files beside the plain form, so any sweep must
  match the prefix rather than the exact string.

**Every task can go red, and every red was checked for reachability.** The order trap Phase 1
walked into — a module declaration after the first failing-test step, producing
`running 0 tests … ok` and exit 0 — is avoided in Tasks 1 and 5 by declaring the module in the
same step as the test, and each of those steps says so. Tasks 2, 6 and 9 have build-shaped reds
rather than test-shaped ones, and each names the exact error text expected. Task 6 Step 4
records the *opposite* result honestly: deleting a `#[wasm_bindgen]` attribute compiles clean,
which no compiler can catch and which is precisely why Task 10 exists.

**Every task has a mutation step that breaks its subject and asserts red**, with STOP-and-report
if it survives. Twenty-two mutations across ten tasks. The three that matter most:

- Task 2's `default-features = false`, which reproduces the spike's misleading
  `unresolved import libsqlite3_sys` on purpose.
- Task 4's deleted second `flush_full_batches`, which reproduces a defect that has **already
  shipped once** in this repo.
- Task 9's `use tauri::Manager;` added to `search.rs`, which is green under a full
  `npm run verify` and red only in the new CI job — the demonstration that this job is
  load-bearing rather than ceremonial.

**Type consistency across tasks.** `StreamIngest::begin/push/finish` is defined in Task 4 and
called with those exact signatures in Task 6. `StreamRead::new/push/finish/peak_buffer` the
same. `wire::{Request, Response, Opened}` is defined in Task 5, serialised in Task 6, and
mirrored by hand in `src/workers/protocol.ts` in Task 7 — with the `kind` strings asserted on
the Rust side by Task 5's tests and on the TypeScript side by Task 7's. `route::call(&AppState,
&str, &Value)` is defined and tested in Task 5 and called once, in Task 6. `Core` is not
changed at all; `BrowserCore` extends it with the two methods that are not command calls, and
Task 8 is the only consumer of those.

**What the spec says that the shipped code contradicts** — all four are in the preamble and
each is handled by a task rather than a note: the synchronous chunk iterator, the second
connection in `AppState`, `Instant::now()` in the lock helper, and `schema`'s dependency on
`tags`. A fifth, found while writing Task 3: `build_now`'s own read-only connection. None of
these is a fault in PR 1 or PR 2 — every one of them is correct on the target those PRs were
written for.
