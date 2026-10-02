# The shared core, step 3: state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `crates/grimoire-core` owns the state every host holds — the connections, the data directory and the cross-file fence — and the one update hook on the write connection, with the desktop app unchanged.

**Architecture:** Three new modules in the core, none of them a moved file: `state` (the every-host half of `AppState`), `hooks` (the installer, with observers) and `events` (`EventSink`). `src-tauri`'s `AppState` keeps its name and its path, wraps a `grimoire_core::state::State` and derefs to it, so no reader of `state.db`, `state.data_dir` or `state.fence` is edited. The mirror's mask, the other windows' change mask and live sync's wake become three observers the desktop registers. `with_write` does not move: its body calls step 4's modules.

**Tech Stack:** Rust (the workspace's pinned toolchain), rusqlite 0.40 with `hooks`.

**Spec:** [`docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md`](../specs/2026-10-01-light-app-android-and-web-design.md) §2.6, §2.8, §6. **Tracking issue:** Msgaihede/mtg-grimoire#761, phase 2, step 3. **The steps before:** [step 1](2026-10-02-light-app-core-step-1-leaves.md), [step 2](2026-10-02-light-app-core-step-2-storage.md) and [light-app.md](../../reference/light-app.md) §6.

Everything measured here was measured on Windows on 2026-10-02, on this branch's tree over `main` at `2531db8a`.

## Decisions taken before any code

### What "state" is — Markus, 2026-10-02

§2.8 gives this step four things: the `AppState` split, `with_write`, the hook installer and its observers, and `EventSink`. Each was read against the tree for what it names:

| `AppState` field | Its type is | Goes to the core |
| --- | --- | --- |
| `db`, `db_read` | `Mutex<rusqlite::Connection>` | **now** |
| `data_dir` | `PathBuf` | **now** |
| `fence` | `db::CrossFileFence` — the core's since step 2 | **now** |
| `syncing` | `AtomicBool`, and `run_sync`'s flag | step 5, with `run_sync` |
| `client` | `scryfall::Client` | step 5 |
| `images` | `images::Cache` | step 5 |
| `index` | `index::lifecycle::IndexSlot` | step 5 |
| `pairing` | `sync_pair::pairing::Pending` | step 6 |
| `mirror`, `mirror_status` | `mirror::watch::{Mask, LastPass}` | never: the mirror is the desktop's |
| `changes` | `changes::Changes` | never — see the next decision |

| The rest of the step's list | What it names that has not moved | |
| --- | --- | --- |
| `with_write`, `with_write_waiting` | `managed_wishlist::{arm, settle_logged}`, `deck_tokens::reconcile_dirty_logged` — three calls wrapped around the write | **waits for step 4**, whole |
| the hook installer | `db::CrossFileFence` and nothing else, once its three riders are observers | **now** |
| `EventSink` | nothing — and nothing in the core emits yet: of 15 `emit` sites, 8 are in step-5 modules, 3 in step-6 and 4 are the desktop's own | **now**, as the trait and the field |

Three scopes were put to Markus with those tables: state only; state plus `with_write` through riders the desktop registers and step 4 deletes; or state plus rewriting the eleven emit sites in step-5 and step-6 modules onto the sink now. **He chose state only** — step 2's rule, that nothing gets a seam the next step deletes.

`with_write` has no line to be cut at, which is where it differs from `prepare_database`: the three calls sit *around* the caller's closure, between the lock and the fence's assertion. Splitting it would leave the core a "write" with no managed-wishlist settle — a second definition of a user-facing write, which is what `written`'s own doc says it exists to prevent.

### The hook's riders are observers, and the desktop registers all three — Markus, 2026-10-02

Today `mirror::watch::install_hook_with_changes` puts four things on the one update hook: the cross-file fence, the mirror's mask, the other windows' change mask and live sync's wake. Spec §2.1 counted the change mask among core state. Read against the tree:

- `changes::Changes` has one reader, `spawn_emitter`, which emits only while two or more windows are open. The web host is one tab (spec §6) and Android is one window.
- All seven hand marks (`mark_table`) are in `#[tauri::command]` wrappers, which stay in `src-tauri`.
- `Changes` and the wake are both `tokio::sync::Notify`, and the core has no `tokio`.

So the core's hook carries the one thing the core itself reads — the fence — and calls **observers**: `row(db, table)` from the update hook, `committed()` from the commit hook. The desktop registers three, in the order the hook has always called them. The core gains no dependency. Step 6 brings the wake home with the sync client.

### One connection in a Worker — Markus, 2026-10-02

Issue #761 gave this step the question. Spec §6 measured the answer's premise: `opfs-sahpool` permits one connection and no WAL. So `State` holds the write connection and an **optional** read one, and `State::reader()` answers the read connection where the host has one and the write connection where it does not. `lock_db_read` keeps its name and all 111 of its callers. The one-connection shape is tested natively; nothing runs it in a browser until phase 5.

### The hook is installed when the state is built

`State::new` takes the write connection and installs the hooks on it before the connection goes behind its mutex, so no host can hold a `State` whose fence is not riding. On the desktop that moves the install from `start` to the end of `init_state` — after `prepare_database`, as now. One write sat between the two: `mirror::settings::ensure_installation`, which mints the mirror's installation name on the write connection *before* the hook. It moves with it, to just above `State::new`, so it is still unhooked. `writes` — live sync's `Notify` — is created in `start` above `init_state` and passed in.

### `AppState` derefs to the core's `State`

`AppState` appears 480 times in 73 files; `state.db` 79 times in 16. (This said 164 in 38 until the review: that pattern also counted `user.db`, `corpus.db` and `mtg.db`.) `impl Deref<Target = State> for AppState` keeps every one of them compiling unedited, and lets a function that takes `&State` be handed an `Arc<AppState>`. The alternative is a `state.core.db` edit at every site and in every open branch.

**Edited call sites, all of them:** the nine places that build an `AppState` (`desktop::init_state` and eight test fixtures), and the five that pass `&state.db_read` as a mutex (`images.rs` ×4, `sync_engine/live.rs` ×1), which become `state.reader()`.

### `platform`'s "background work" row has no caller here

`platform/mod.rs` gave background work to "the state step". Nothing in `State`, the installer or the sink spawns anything; the 242 `tauri::async_runtime` uses are command wrappers (which stay) and feed code (step 5). The row goes to the I/O step, with its first caller.

## Global Constraints

- **The desktop app must be unchanged.** The hook does what it did, in the order it did it: update hook — fence, change mask, mirror mask; commit hook — fence, sync wake, change bell; rollback hook — fence. `with_write`, `with_write_waiting` and `written` are not edited.
- **No schema rung, no DDL, no statement changes.** This step touches no SQL the app runs.
- **No test is deleted or weakened.** `#[test]` and `#[tokio::test]` attributes before: 2 810 under `src-tauri/src`, 556 in the core. After: the same 2 810, and 556 plus this step's own.
- `grimoire-core` gains no dependency. It has no `tauri`; `cfg(target_…)`, `SystemTime` and `Instant` appear only under its `src/platform/`. The fence is not weakened.
- **Never `cargo fmt --all`.** `cargo fmt -p mtg-grimoire -p grimoire-core`.
- No agent deploys anything, and nothing here needs a deploy.
- Tests run once, at the end. Cargo is never run twice at once in this tree.

## Review Focus

What no moved test exercises and a reader would notice first:

1. **An edit that never reaches the backup folder** — the mirror's mask is an observer now. `mirror::watch`'s fifteen hook tests stay, unedited, and go through the same delegate; Task 1 adds the installer's own. The live pass edits a deck and reads the mirrored file.
2. **A second window that does not refresh** — the change mask is an observer too, and its bell rides `committed()`. `changes.rs`'s tests stay; the live pass opens a second window and writes in the first.
3. **A cross-file commit that goes unreported** — `with_write`'s `debug_assert` reads `state.fence`, which is now the one `State::new` armed. Task 2 pins that a state's own write connection trips its own fence.
4. **A sync that slows down** — the hook fires once per row and an ingest writes 117 000. Task 1 measures three observers against none, in a release build of the core.
5. **A launch that writes before the hook is on** — `ensure_installation` is the one write between `prepare_database` and the install; Task 3 keeps it above `State::new`.

---

## Tasks

### Task 1 — `hooks`: the installer and its observers

**Files:** Create `crates/grimoire-core/src/hooks.rs`. Modify `crates/grimoire-core/src/lib.rs`.

**Produces:**

```rust
pub trait WriteObserver: Send + Sync {
    /// From the update hook: one row of `table`, in the schema SQLite calls `db`, was written.
    fn row(&self, _db: &str, _table: &str) {}
    /// From the commit hook: a transaction committed.
    fn committed(&self) {}
}

pub fn install(
    conn: &rusqlite::Connection,
    fence: Arc<crate::db::CrossFileFence>,
    observers: Vec<Arc<dyn WriteObserver>>,
);
```

- [x] `install`: update hook — `fence.note(db)`, then each observer's `row` in order; commit hook — `fence.settle()` and its sentence, then each observer's `committed` in order, answering `false`; rollback hook — `fence.clear()`. The three hooks' docs move here from `mirror::watch` where they are about the hook rather than about a rider
- [x] Tests, with a recording observer: the fence trips on a transaction that writes both files; a rolled-back one is not charged to the next commit; an observer hears each row with its schema and table; it hears a commit and not a rollback; observers are told in the order given; a `WITHOUT ROWID` write reaches `committed` and never `row`; a second `install` replaces the first. **As built, one more**: a bare `DELETE` on a table nothing points at is heard as a commit only — the hook's second blind spot, pinned beside the first
- [x] `#[ignore]`d measurement, timed through `platform::clock::Tick`: one `UPDATE` over 100 000 rows with no observer and with three that each do one atomic add — run in release, `cargo test -p grimoire-core --release -- --ignored --nocapture what_three_observers`. **+2.9 to +4.4 ns per row**, six runs
- [x] **After review**: the fence has settled by the time an observer hears the commit — moving the observers ahead of it failed no test

### Task 2 — `events` and `state`

**Files:** Create `crates/grimoire-core/src/events.rs`, `crates/grimoire-core/src/state.rs`. Modify `crates/grimoire-core/src/lib.rs`.

**Consumes:** `hooks::{install, WriteObserver}`.

**Produces:**

```rust
// events.rs
pub trait EventSink: Send + Sync {
    fn emit(&self, name: &str, payload: serde_json::Value);
}
/// Serialise and emit. A payload that will not serialise is dropped, as a dropped event is.
pub fn emit<T: serde::Serialize>(sink: &dyn EventSink, name: &str, payload: &T);
/// A sink for a host with nobody listening, and for tests.
pub fn silent() -> Arc<dyn EventSink>;

// state.rs
pub struct State {
    pub db: Mutex<Connection>,
    db_read: Option<Mutex<Connection>>,
    pub data_dir: PathBuf,
    pub fence: Arc<CrossFileFence>,
    pub events: Arc<dyn EventSink>,
}
impl State {
    pub fn new(
        write: Connection,
        read: Option<Connection>,
        data_dir: PathBuf,
        events: Arc<dyn EventSink>,
        observers: Vec<Arc<dyn WriteObserver>>,
    ) -> State;
    pub fn reader(&self) -> &Mutex<Connection>;
    pub fn lock_db(&self) -> MutexGuard<'_, Connection>;
    pub fn lock_db_read(&self) -> MutexGuard<'_, Connection>;
}
```

- [x] `events.rs` and its tests: a `camelCase` struct reaches a recording sink as the JSON the page reads; a payload that will not serialise is dropped. (A third, that the silent sink takes anything, asserted nothing and went after review.)
- [x] **After review**: the two-connection test asserts the observer and the fence too. Both hook tests built their state with one connection, so installing the hooks on the *read* connection passed all of them — on the desktop that is a mirror, a change mask and a sync wake that never hear anything
- [x] `state.rs`: `new` installs the hooks, then wraps the connections
- [x] Tests: a state's own write connection trips its own fence; observers given to `new` hear a write made through `lock_db`; a state with one connection reads through the one it writes with (`reader()` is `&db`, and a row written is read back); a state with two reads through the second, which cannot write
- [x] `lib.rs`: the three modules in the map, and the crate doc's "what is here"

### Task 3 — the desktop wraps it

**Files:** Modify `src-tauri/src/sync.rs`, `mirror/watch.rs`, `changes.rs`, `sync_engine/live.rs`, `desktop.rs`, `images.rs`, and the eight fixtures (`index/mod.rs`, `marketplace_feed.rs`, `mirror/watch.rs`, `search.rs`, `sync.rs`, `tags/oracle.rs`, `update.rs`, `sync_engine/live.rs`).

**Consumes:** everything Tasks 1 and 2 produce.

**Produces:** `sync::AppState { core, syncing, client, images, index, mirror, mirror_status, changes, pairing }` with `Deref<Target = State>`; `mirror::watch::observers(mask, changes, writes) -> Vec<Arc<dyn WriteObserver>>`; `sync_engine::live::WriteWake`.

- [x] `sync.rs`: the struct, the `Deref`, `lock_db` and `lock_db_read` as one-line delegates to the core's. `with_write` and its two siblings untouched
- [x] `impl WriteObserver for Mask` (`row`: `surface_of`, then `mark`), `for Changes` (`row`: `mark`; `committed`: ring when pending), and `WriteWake(Arc<Notify>)` (`committed`: `notify_one`), each carrying the comment that argued it inside the hook
- [x] `mirror::watch::observers` — wake, change mask, mirror mask: the order that keeps both hooks' call order — and `install_hook_with_changes` as `hooks::install(conn, fence, observers(…))`. Of `install_hook`'s 24 call sites, the desktop's and seven fixtures' became `State::new`; the 16 left are tests on a bare connection. **After review, both functions are `#[cfg(test)]`**: called on the app's connection, either would replace the hooks `State::new` installed
- [x] `desktop.rs`: `WindowEvents(AppHandle)` as the sink; `init_state(app, writes)` mints the installation name, then builds the `State`; `start` loses the install block and keeps the two spawns
- [x] The five `&state.db_read` become `state.reader()`
- [x] The eight fixtures build a `State` where they built four fields and called `install_hook`. Seven hand it `observers(…)` with the state's own change mask, where the hook used to get a throwaway; `watch`'s `state_at` never hooked its connection and passes none

### Task 4 — the record

- [x] `crates/grimoire-core/CLAUDE.md`: what is here now, the three modules, how a host builds a `State`, what `AppState` still holds and the step each field leaves in
- [x] `docs/reference/light-app.md` §6.3: what was built, what waits and why, the hook measured, what is open
- [x] The spec's §2.6 and §2.8, dated; `platform/mod.rs`'s table
- [x] Every sentence elsewhere this makes false: `src-tauri/CLAUDE.md` (where the hook is installed and by whom, `ensure_installation`'s place, the fence's hook), `text-mirror.md`, `multi-window.md` — `sync.md` was read and needed nothing — and, after review, the doc comments in both crates that still described the mirror's hook as the installer
- [x] Issue #761: step 3 described, its box left for the merge to tick with what it built; step 4 gains `with_write`; steps 5 and 6 gain the fields; the one-connection item settled; phase 5 gains what that shape leaves open

### Task 5 — verify and ship

- [x] `cargo fmt -p mtg-grimoire -p grimoire-core --check`; `cargo clippy --workspace --all-targets --locked -- -D warnings`; `cargo check -p mtg-grimoire --locked`
- [x] `cargo test --workspace`; the test-attribute count against the baseline above — 2 810 and 572, the sixteen new ones this step's own
- [x] `npm run build`, `npm run lint`, `npm run test:run` — 458 files, 12 875 tests. **The card-scanner suite was not run here**: nothing under `crates/card-scanner` changed, and CI's `rust` job runs it
- [x] The core for `wasm32-unknown-unknown`, build and clippy
- [x] `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core`: no `testing`
- [x] The hook measurement, release
- [x] **The live pass**, `tauri dev` over a copy of the main checkout's data: the app starts and searches; a deck edit reaches the mirrored file; a second window refreshes after a write in the first. [light-app.md](../../reference/light-app.md) §6.3 has every figure. **Not driven: live sync's wake** — the copy is in no group, so nothing waits on it
- [x] A fresh reviewer over the branch — no behavioural defect; one test gap and a list of stale sentences and two wrong counts, all closed above
- [ ] PR linked to #761, auto-merge armed; `ci-ok` green, including `core` on both targets

## What step 4 inherits

- `with_write`, `with_write_waiting` and `written`, whole, with the three calls that keep them in `src-tauri`; and `collection_source::with_write_owned` behind them, which also waits on `index::lifecycle` (step 5).
- `AppState`'s eight remaining fields, each with the step that takes it.
- `EventSink` with no caller in the core: its first is step 5's `run_sync`.
- A one-connection `State` that has never run in a browser.
