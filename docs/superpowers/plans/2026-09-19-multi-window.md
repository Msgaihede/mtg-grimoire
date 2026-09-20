# Multi-window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reader open more than one window onto the one running app — a relaunch or
Ctrl+Shift+N opens one — with every window's data kept fresh when another writes.

**Architecture:** Windows, not processes: the single-instance guard stays, and its callback opens a
window instead of focusing one. A commit-driven `db:changed` event (Rust reports which user tables a
commit wrote; TypeScript maps tables to query keys) keeps every window's TanStack cache fresh, and is
emitted only while two or more windows are open. The card scanner becomes a two-second lease the
camera's frames renew, so only one window scans at a time.

**Tech Stack:** Tauri 2.11.5 (Rust), rusqlite update/commit hooks, tokio `Notify`, React 19,
TanStack Query 5, Vitest, Storybook fake backend.

**Spec:** `docs/superpowers/specs/2026-09-19-multi-window-design.md` — read it before your task.
Its §1 tables are the measured facts every task below rests on.

## Global Constraints

- **Wave 1 runs in parallel in ONE worktree. Touch only the files your task lists.** Two agents
  editing one file clobber each other. Where a task needs a line in a file it does not own, the
  owning task writes it — the Interfaces blocks say which.
- **Do not commit, do not stash, do not run `git add`.** Parallel agents share one git index
  (`git add` sweeps a sibling's files into your commit). The fan-in (Task 9) commits per task.
- **Do not run `cargo test`, `cargo build`, `cargo clippy` or `npm run verify` during wave 1.** Each
  compiles the whole crate or tree, which siblings are still changing — a failure will not be yours.
  Rust tasks write their tests and stop. TS tasks **may** run `npx vitest run <their own test files>`
  (single files transpile alone), and never `src/stories.test.tsx`, which collects every story.
- **Never run a verify in the background and end your turn.** Report what you changed, with file
  paths, and any deviation from this plan with the reason.
- **Keep each file's line endings.** A write that flips a file to CRLF breaks source-parsing tests.
- **Match the surrounding code**: this repo's comments carry the *why*, in full sentences, at the
  site. Write doc comments at the density of the file you are in.
- **TypeScript stays 6.0.x; never install `@types/node`; no new dependency anywhere.**
- UI rules that bind Tasks 5 and 6 (`src/CLAUDE.md`): dim text is `text-dim`, never `text-muted`;
  a hint is `useTooltip()`, never a `title` attribute; `aria-disabled`, never `disabled`, on
  anything that greys as the reader types.
- Event and command names are cross-language contracts pinned by `src/lib/ipc.test.ts`. Spell them
  exactly as written here: event `db:changed`; commands `window_new`, `window_count`,
  `scanner_elsewhere`; Rust constant `OPEN_ELSEWHERE` = `"The scanner is open in another window."`.

---

## File map

| File | Task | Responsibility |
| --- | --- | --- |
| `src-tauri/src/changes.rs` (new) | 1 | The change mask, the emit decision, the emitter |
| `src/lib/userTables.json` (new) | 1 | The user tables, the one list both suites read |
| `src-tauri/src/lib.rs` | 1 | `pub mod changes;` |
| `src-tauri/src/sync.rs` | 1 | `AppState.changes`; its test fixture |
| `src-tauri/src/mirror/watch.rs` | 1 | `install_hook_with_changes`; `state_at` fixture; hook tests |
| `src-tauri/src/{index/mod.rs,marketplace_feed.rs,search.rs,sync_engine/live.rs,tags/oracle.rs,update.rs}` | 1 | One `changes:` line in each test `AppState` |
| `src-tauri/src/tags/muted.rs` | 1 | Mark `muted_tags` after a mute/unmute |
| `src-tauri/src/sync_pair/pairing.rs` | 1 | Mark `sync_devices`, `device_names` after a rename |
| `src-tauri/src/window.rs` | 2 | `open_new`, `cascade`, `focused`, `open_sized_to_monitor(&window)` |
| `src-tauri/src/desktop.rs` | 2 | Single-instance callback, `window_new`/`window_count`, handler list, `setup`, `init_state`/`start` wiring for Task 1 |
| `src-tauri/capabilities/desktop.json` | 2 | `"windows": ["main", "window-*"]` |
| `src-tauri/src/scanner.rs` | 3 | The lease, `OPEN_ELSEWHERE`, `scanner_elsewhere` |
| `src/lib/ipc.ts`, `src/lib/ipc.test.ts` | 4 | `DbChanged`, `onDbChanged`, `windowNew`, `windowCount`, `scannerElsewhere`; the pins |
| `src/lib/crossWindow.ts` (+ test) (new) | 4 | Table → query keys, the per-window predicate, `refreshForTables` |
| `src/lib/useCrossWindowRefresh.ts` (+ test) (new) | 4 | The one `db:changed` subscriber |
| `src/lib/shortcuts.ts`, `src/lib/shortcuts.test.ts` | 5 | `newWindow` row, `desktopOnly`, `shownOn` |
| `src/lib/platform.ts` | 5 | `isDesktop()` |
| `src/components/KeyMap.tsx` | 5 | Hide desktop-only rows off desktop |
| `src/components/AppShell.tsx` | 5 | Bind Ctrl+Shift+N; mount `useCrossWindowRefresh` |
| `src/lib/window.ts`, `src/lib/window.test.ts` (new) | 5 | `onSnapHover` on its own window; `closeWindow` doc |
| `.storybook/fake/window.ts` | 5 | `label`, `listen` on the fake window |
| `src/lib/useWindowCount.ts` (+ test) (new) | 5 | The polled window count |
| `src/features/settings/UpdatePanel.tsx` (+ test), `SettingsPage.tsx` | 5 | "Restarting closes all N windows." |
| `src/features/scanner/{ScannerPage.tsx,verdictText.ts,useScannerElsewhere.ts}` (+ tests, story) | 6 | The scanner gate |
| `.storybook/fake/db.ts`, `.storybook/fake/event.ts`, `.storybook/CLAUDE.md` | 7 | Fake handlers, the `scannerElsewhere` fault, the event list |
| `scripts/cdp.mjs` | 8 | `pages` command, `CDP_PAGE` |
| docs (see Task 11) | 11 | Reference doc, skill, CLAUDE.md lines |

---

## Wave 1 — dispatch Tasks 1–8 in one message

### Task 1: Rust — the change mask

**Files:**
- Create: `src-tauri/src/changes.rs`, `src/lib/userTables.json`
- Modify: `src-tauri/src/lib.rs` (module map), `src-tauri/src/sync.rs:100-175` (`AppState`) and
  `sync.rs:~1395-1425` (test fixture), `src-tauri/src/mirror/watch.rs:225-293` (`install_hook`) and
  its tests, `src-tauri/src/tags/muted.rs:162-195`, `src-tauri/src/sync_pair/pairing.rs:901-914`,
  and the test `AppState` literals in `index/mod.rs:~459`, `marketplace_feed.rs:~2094`,
  `search.rs:~3112`, `sync_engine/live.rs:~735`, `tags/oracle.rs:~1339`, `update.rs:~2092`
- **Not** `desktop.rs` — Task 2 writes the three lines there that consume this task.

**Interfaces:**
- Produces (Task 2 consumes): `crate::changes::Changes` (`Default`), `AppState.changes:
  Arc<crate::changes::Changes>` (gated `#[cfg(not(target_family = "wasm"))]`),
  `crate::mirror::watch::install_hook_with_changes(conn, mask, fence, writes, changes)`,
  `crate::changes::spawn_emitter(app: tauri::AppHandle, state: Arc<AppState>)` (`#[cfg(desktop)]`).
- Produces (Task 4 pins): `pub const DB_CHANGED: &str = "db:changed";`, the struct
  `pub struct DbChanged { pub tables: Vec<&'static str>, }` with `#[serde(rename_all = "camelCase")]`.

- [ ] **Step 1: Write `src/lib/userTables.json`** — the user side of `schema::TABLES`
  (`schema.rs:490-519`), sorted, one line:

```json
["activity","app_meta","card_migrations","collection_entries","collection_folders","collection_shares","deck_audit","deck_cards","deck_categories","deck_folders","deck_labels","deck_note_cards","deck_notes","deck_tokens","deck_undo","decks","device_names","error_log","muted_tags","price_snapshots","sync_clock","sync_devices","sync_group","sync_identity","sync_ops","sync_peers","sync_state","wishlist_entries","wishlist_folders"]
```

  Re-read `schema::TABLES` before saving: if a user table was added on `main` since this plan, it
  goes in, sorted.

- [ ] **Step 2: Create `src-tauri/src/changes.rs`** with the module, then its tests (Step 3).

```rust
//! Which user tables a commit wrote, told to every open window.
//!
//! A second window is a second webview with its own query cache, and until this module each
//! cache heard only about the writes its own window made (spec
//! `docs/superpowers/specs/2026-09-19-multi-window-design.md` §4). Rust supplies the fact — which
//! **tables** a commit wrote — and TypeScript draws the conclusion, which queries that makes stale
//! (`src/lib/crossWindow.ts`).
//!
//! Three pieces:
//!
//! * [`Changes::mark`] rides the one update hook on the write connection
//!   ([`crate::mirror::watch::install_hook_with_changes`]) and sets one bit per user table. It is
//!   the hook's own discipline: one binary search over a list built in [`Changes::new`], one
//!   `fetch_or`, no allocation and no lock.
//! * The commit hook rings [`Changes::ring`] **only when a bit is set**, so the thousands of corpus
//!   commits a Scryfall ingest makes wake nothing.
//! * [`spawn_emitter`] waits for the ring, lets a burst settle, and — only while two or more
//!   windows are open — emits [`DB_CHANGED`]. With one window nothing is ever emitted, so a
//!   single-window session is exactly what it was before this module.
//!
//! **Six user tables are `WITHOUT ROWID`, and `update_hook` never fires for those.** Their write
//! sites take a bare `&Connection` in modules that have no business with this mask, so the mark is
//! made by the *command* that a reader's press reaches, after its write has committed — see
//! [`MARKED_BY_COMMAND`] and [`WRITTEN_BY_THE_APP`], and the test that holds `sqlite_master` to the
//! two of them.

use crate::schema::{Side, TABLES};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// The event every window listens for. `src/lib/ipc.ts`'s `onDbChanged` subscribes to this exact
/// string and `ipc.test.ts` pins this line — an event name is a contract no type system holds.
pub const DB_CHANGED: &str = "db:changed";

/// How long the emitter waits after a wake before it reads the mask, so that a burst of commits —
/// an import is hundreds — is one event rather than hundreds.
pub const COALESCE: Duration = Duration::from_millis(50);

/// The `WITHOUT ROWID` user tables a command marks by hand after its write commits:
/// `muted_tags` from `tags::muted::tag_mute`/`tag_unmute`, `sync_devices` and `device_names` from
/// `sync_pair::pairing::sync_device_rename`. A reader's press is the only thing that changes them
/// in a way another window could be behind about.
pub const MARKED_BY_COMMAND: &[&str] = &["device_names", "muted_tags", "sync_devices"];

/// The `WITHOUT ROWID` user tables no window's press writes — the app writes them itself: a day's
/// prices (`price_history`), a sync cursor and a peer watermark (`sync_engine`). Every window is
/// equally current about them, so nothing marks them.
pub const WRITTEN_BY_THE_APP: &[&str] = &["price_snapshots", "sync_peers", "sync_state"];

/// One bit per user table, and the bell the commit hook rings.
pub struct Changes {
    /// The user side of [`TABLES`], sorted — built once so the hook only ever reads it.
    tables: Vec<&'static str>,
    bits: AtomicU64,
    wake: tokio::sync::Notify,
}

impl Default for Changes {
    fn default() -> Self {
        Self::new()
    }
}

impl Changes {
    pub fn new() -> Self {
        let mut tables: Vec<&'static str> = TABLES
            .iter()
            .filter(|(_, side)| *side == Side::User)
            .map(|(name, _)| *name)
            .collect();
        tables.sort_unstable();
        assert!(
            tables.len() <= 64,
            "one bit per user table, and the mask is a u64"
        );
        Self {
            tables,
            bits: AtomicU64::new(0),
            wake: tokio::sync::Notify::new(),
        }
    }

    /// From inside SQLite's update hook: note that `table` in `db` was written.
    ///
    /// Only `main` — the user file. The corpus is rewritten wholesale by feeds and every window
    /// already hears about those through their own progress events.
    pub fn mark(&self, db: &str, table: &str) {
        if db != "main" {
            return;
        }
        if let Ok(i) = self.tables.binary_search_by(|probe| (*probe).cmp(table)) {
            self.bits.fetch_or(1u64 << i, Ordering::AcqRel);
        }
    }

    /// Whether any bit is set — what the commit hook asks before it rings.
    pub fn pending(&self) -> bool {
        self.bits.load(Ordering::Acquire) != 0
    }

    /// Wake the emitter. `notify_one` stores at most one permit, so a storm is one wake.
    pub fn ring(&self) {
        self.wake.notify_one();
    }

    /// A command's mark for a `WITHOUT ROWID` table, made after its write has committed — so it
    /// rings itself, because the commit hook saw no bit for it.
    pub fn mark_table(&self, table: &str) {
        self.mark("main", table);
        self.ring();
    }

    /// Every table marked since the last take, sorted, and the mask cleared.
    pub fn take(&self) -> Vec<&'static str> {
        let bits = self.bits.swap(0, Ordering::AcqRel);
        self.tables
            .iter()
            .enumerate()
            .filter(|(i, _)| bits & (1u64 << i) != 0)
            .map(|(_, table)| *table)
            .collect()
    }

    /// Resolves after the next ring (or at once, if one is already stored).
    pub async fn notified(&self) {
        self.wake.notified().await;
    }
}

/// Whether a take is worth an event: something changed, and another window exists to hear it.
pub fn should_emit(tables: &[&str], windows: usize) -> bool {
    !tables.is_empty() && windows >= 2
}

/// The payload of [`DB_CHANGED`]. `src/lib/ipc.ts`'s `DbChanged` mirrors it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbChanged {
    pub tables: Vec<&'static str>,
}

/// Start the task that turns rings into events. Desktop only: a phone has one window.
///
/// **The write lock is taken and dropped before the read, and that is a barrier, not a use.** The
/// commit hook fires while the commit is still being made, under `state.db`'s mutex; a window told
/// before that commit is durable could refetch the old rows and never be told again. Acquiring the
/// mutex proves the commit that rang has finished. On timeout it emits anyway — a refetch of data
/// that did not change costs one read, and silence would cost a stale window.
#[cfg(desktop)]
pub fn spawn_emitter(app: tauri::AppHandle, state: std::sync::Arc<crate::sync::AppState>) {
    use tauri::{Emitter, Manager};
    tauri::async_runtime::spawn(async move {
        loop {
            state.changes.notified().await;
            tokio::time::sleep(COALESCE).await;
            if app.webview_windows().len() < 2 {
                // Taken regardless, so nothing stale is waiting when a second window opens.
                let _ = state.changes.take();
                continue;
            }
            let barrier = state.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                drop(crate::db::lock_for(&barrier.db, crate::db::WRITE_LOCK_WAIT));
            })
            .await;
            let tables = state.changes.take();
            if should_emit(&tables, app.webview_windows().len()) {
                let _ = app.emit(DB_CHANGED, DbChanged { tables });
            }
        }
    });
}
```

- [ ] **Step 3: Append the tests to `changes.rs`.**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(f)
    }

    /// The one list both suites read. `crossWindow.test.ts` holds the TypeScript map to the same
    /// file, so a table added on one side and not the other is red on that side.
    #[test]
    fn the_json_both_suites_read_is_the_user_side_of_the_registry() {
        let json: Vec<String> =
            serde_json::from_str(include_str!("../../src/lib/userTables.json")).unwrap();
        let mut ours: Vec<&str> = TABLES
            .iter()
            .filter(|(_, side)| *side == Side::User)
            .map(|(name, _)| *name)
            .collect();
        ours.sort_unstable();
        assert_eq!(json, ours);
    }

    #[test]
    fn a_main_write_marks_its_table_once_and_a_corpus_write_marks_nothing() {
        let changes = Changes::new();
        changes.mark("corpus", "cards");
        assert!(!changes.pending(), "the corpus is not this mask's");
        changes.mark("main", "decks");
        changes.mark("main", "decks");
        changes.mark("main", "collection_entries");
        assert_eq!(changes.take(), vec!["collection_entries", "decks"]);
        assert!(!changes.pending(), "a take clears the mask");
        assert!(changes.take().is_empty());
    }

    #[test]
    fn a_table_outside_the_registry_marks_nothing() {
        let changes = Changes::new();
        changes.mark("main", "sqlite_sequence");
        changes.mark("temp", "decks");
        assert!(!changes.pending());
    }

    #[test]
    fn it_emits_only_with_something_to_say_and_somebody_to_say_it_to() {
        assert!(!should_emit(&["decks"], 1), "one window refreshes itself");
        assert!(!should_emit(&[], 2), "nothing changed");
        assert!(should_emit(&["decks"], 2));
        assert!(should_emit(&["decks"], 5));
    }

    #[test]
    fn a_commands_mark_rings_the_emitter_itself() {
        let changes = Changes::new();
        changes.mark_table("muted_tags");
        block_on(async {
            tokio::time::timeout(Duration::from_millis(100), changes.notified())
                .await
                .expect("mark_table must ring: the commit hook saw no bit for this table");
        });
        assert_eq!(changes.take(), vec!["muted_tags"]);
    }

    /// `update_hook` cannot see these, so each one is a decision — marked by the command that
    /// writes it, or written only by the app. A seventh goes red here until somebody decides.
    #[test]
    fn every_without_rowid_user_table_has_been_decided_about() {
        let conn = crate::schema::memory_pair();
        let mut stmt = conn
            .prepare(
                "SELECT name FROM main.sqlite_master
                 WHERE type = 'table' AND sql LIKE '%WITHOUT ROWID%' ORDER BY name",
            )
            .unwrap();
        let found: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut decided: Vec<&str> = MARKED_BY_COMMAND
            .iter()
            .chain(WRITTEN_BY_THE_APP)
            .copied()
            .collect();
        decided.sort_unstable();
        assert_eq!(found, decided);
    }
}
```

- [ ] **Step 4: Register the module** in `src-tauri/src/lib.rs`'s "Desktop and Android" block
  (alphabetical, beside `camera`):

```rust
/// **Which user tables a commit wrote, told to every open window.** Non-wasm because it rides the
/// write connection's update hook and lives on `AppState` beside `mirror`; its emitter is
/// `#[cfg(desktop)]` inside, because only the desktop opens a second window. See the module doc.
#[cfg(not(target_family = "wasm"))]
pub mod changes;
```

- [ ] **Step 5: Add the field to `AppState`** in `sync.rs`, after `fence` (gated like `mirror`):

```rust
    /// Which user tables have been written since the other windows were last told — see
    /// [`crate::changes`]. An `Arc` for [`AppState::mirror`]'s reason: the update hook on `db`
    /// holds a clone of it for the life of the process.
    #[cfg(not(target_family = "wasm"))]
    pub changes: Arc<crate::changes::Changes>,
```

  Then add `changes: Default::default(),` to every non-wasm `AppState { … }` literal — `sync.rs`
  test fixture, `mirror/watch.rs` `state_at`, `index/mod.rs`, `marketplace_feed.rs`, `search.rs`,
  `sync_engine/live.rs`, `tags/oracle.rs`, `update.rs`. **Not** `web/glue.rs` (the field is gated
  off wasm) and **not** `desktop.rs` (Task 2). Confirm the census with
  `grep -rn "AppState {" src-tauri/src` — every hit except `struct`, `impl`, `glue.rs` and
  `desktop.rs` gets the line.

- [ ] **Step 6: Ride the hook** in `mirror/watch.rs`. Rename the body of `install_hook` into a new
  function and keep `install_hook` as a delegate, so its eighteen test callers are untouched:

```rust
/// [`install_hook_with_changes`] with a mask nobody reads — every caller except the app's own
/// startup, which is a test fixture that has no use for the cross-window refresh.
pub fn install_hook(
    conn: &Connection,
    mask: Arc<Mask>,
    fence: Arc<crate::db::CrossFileFence>,
    writes: Arc<tokio::sync::Notify>,
) {
    install_hook_with_changes(
        conn,
        mask,
        fence,
        writes,
        Arc::new(crate::changes::Changes::default()),
    );
}
```

  In `install_hook_with_changes` (the old body, plus the `changes` parameter): the update-hook
  closure gains `marking.mark(db, table);` beside `marker.note(db);` (with
  `let marking = changes.clone();` before it), and the commit-hook closure gains, after
  `settling_writes.notify_one();`:

```rust
        // **The other windows' bell, riding the same hook for the same reason** — see
        // `crate::changes`. Rung only when a user table was written, so a Scryfall ingest's
        // corpus commits wake nothing.
        if ringing.pending() {
            ringing.ring();
        }
```

  with `let ringing = changes;` before the `commit_hook` call. Update the module doc's first bullet
  to say the hook now marks the window mask too.

- [ ] **Step 7: Add two hook tests** to `mirror/watch.rs`'s test module:

```rust
    #[test]
    fn a_user_write_through_the_hooked_connection_marks_the_window_mask_and_rings() {
        let conn = migrated_memory_db();
        let changes = Arc::new(crate::changes::Changes::new());
        install_hook_with_changes(
            &conn,
            Arc::new(Mask::default()),
            Arc::new(crate::db::CrossFileFence::new()),
            Arc::new(tokio::sync::Notify::new()),
            changes.clone(),
        );
        crate::app_meta::set_app_meta(&conn, "anything", "at all").unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                tokio::time::timeout(std::time::Duration::from_millis(100), changes.notified())
                    .await
                    .expect("the commit must ring the other windows' bell");
            });
        assert_eq!(changes.take(), vec!["app_meta"]);
    }

    #[test]
    fn a_corpus_write_through_the_hooked_connection_rings_nothing() {
        let conn = migrated_memory_db();
        let changes = Arc::new(crate::changes::Changes::new());
        install_hook_with_changes(
            &conn,
            Arc::new(Mask::default()),
            Arc::new(crate::db::CrossFileFence::new()),
            Arc::new(tokio::sync::Notify::new()),
            changes.clone(),
        );
        conn.execute("INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz', 'probe')", [])
            .unwrap();
        let rang = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                tokio::time::timeout(std::time::Duration::from_millis(50), changes.notified())
                    .await
                    .is_ok()
            });
        assert!(!rang, "a corpus commit must not wake the emitter");
        assert!(changes.take().is_empty());
    }
```

- [ ] **Step 8: Mark the three `WITHOUT ROWID` tables at their commands.** In
  `tags/muted.rs`, `tag_mute` and `tag_unmute` currently return the `spawn_blocking(…)` result
  directly. Bind it, mark on success, return it:

```rust
    let marks = state.clone();
    let out = tauri::async_runtime::spawn_blocking(move || { /* unchanged */ })
        .await
        .map_err(|e| format!("the tag could not be muted: {e}"))?;
    // `muted_tags` is `WITHOUT ROWID`, which the update hook never sees — so the other windows
    // hear about a mute from here. See `crate::changes::MARKED_BY_COMMAND`.
    if out.is_ok() {
        marks.changes.mark_table("muted_tags");
    }
    out
```

  (`state` is moved into the closure, hence the clone taken before it; keep each function's own
  error wording.) In `sync_pair/pairing.rs`, `sync_device_rename` the same way, marking both
  `sync_devices` and `device_names` — `identity::rename_device` writes both (`identity.rs:355`,
  `:552`/`:572`).

- [ ] **Step 9: Report** — the files changed, and confirm the `AppState` census from Step 5.

### Task 2: Rust — windows, the shell and the wiring

**Files:**
- Modify: `src-tauri/src/window.rs`, `src-tauri/src/desktop.rs`,
  `src-tauri/capabilities/desktop.json`

**Interfaces:**
- Consumes (Task 1): `AppState.changes`, `mirror::watch::install_hook_with_changes`,
  `changes::spawn_emitter`. Consumes (Task 3): `scanner::scanner_elsewhere` (a
  `#[tauri::command]`).
- Produces (Task 4 pins): in `desktop.rs`, `async fn window_new(` and `fn window_count(`.
- Produces: `window::LABEL_PREFIX = "window-"`, `window::open_new`, `window::cascade`,
  `window::focused`.

- [ ] **Step 1: Write the placement tests** in `window.rs`'s test module:

```rust
    /// The case the offset exists for: a new window lands where the reader can see both.
    #[test]
    fn a_new_window_opens_down_and_right_of_the_one_it_came_from() {
        assert_eq!(
            cascade((100.0, 80.0), (1280.0, 720.0), (0.0, 0.0), (2560.0, 1392.0)),
            (132.0, 112.0)
        );
    }

    /// An axis that would push the frame off the work area starts again at that edge, rather than
    /// opening a window the reader has to drag back.
    #[test]
    fn an_axis_that_would_overflow_the_work_area_starts_again_at_its_edge() {
        // 1282 + 1280 + 16 of frame = 2578 > 2560.
        assert_eq!(
            cascade((1250.0, 80.0), (1280.0, 720.0), (0.0, 0.0), (2560.0, 1392.0)),
            (0.0, 112.0)
        );
    }

    /// A second monitor's work area does not start at zero.
    #[test]
    fn a_work_area_that_does_not_start_at_zero_is_respected() {
        // y: 732 + 720 + 9 = 1461 > 1032, so it starts again at that monitor's top.
        assert_eq!(
            cascade((2600.0, 700.0), (1280.0, 720.0), (2560.0, 0.0), (1920.0, 1032.0)),
            (2632.0, 0.0)
        );
    }
```

- [ ] **Step 2: Implement in `window.rs`.** Add below `opening_size`, and change
  `open_sized_to_monitor` to take the window (it no longer looks up `"main"`; update its doc to say
  every window the app opens is sized by it):

```rust
/// Every window after the first is `window-2`, `window-3`, … — the prefix
/// `capabilities/desktop.json` grants as `window-*`, which a test pins against this constant.
pub const LABEL_PREFIX: &str = "window-";

/// How far down and right of the window it came from a new one opens, in logical pixels — enough
/// to see that there are two, the way Windows cascades.
pub const OFFSET: f64 = 32.0;

/// The next label's number. `main` is the first window, so counting starts at two; a closed
/// window's number is never reused.
static NEXT_LABEL: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(2);

/// Where a new window's top-left goes, in logical pixels: [`OFFSET`] down and right of `from`,
/// except on an axis where the frame would leave the work area — there it starts again at that
/// axis's edge.
pub fn cascade(
    from: (f64, f64),
    size: (f64, f64),
    area_origin: (f64, f64),
    area_size: (f64, f64),
) -> (f64, f64) {
    let fit = |start: f64, len: f64, origin: f64, room: f64| {
        let wanted = start + OFFSET;
        if wanted + len > origin + room {
            origin
        } else {
            wanted.max(origin)
        }
    };
    (
        fit(from.0, size.0 + CHROME.0, area_origin.0, area_size.0),
        fit(from.1, size.1 + CHROME.1, area_origin.1, area_size.1),
    )
}

/// The window with focus, else any — what a relaunch opens its new window beside.
pub fn focused(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    let all = app.webview_windows();
    all.values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| all.into_values().next())
}

/// Open another window onto the same app: the config's window under a new label, sized by
/// [`opening_size`], placed by [`cascade`] beside `from`, with the camera grant, shown and focused.
///
/// ⚠️ **Never call this synchronously from a command or an event handler.** Tauri documents that
/// building a window on Windows "deadlocks when used in a synchronous command or event handlers"
/// (`tauri-2.11.5/src/webview/webview_window.rs:115`). The single-instance callback spawns onto
/// the async runtime and `window_new` is an `async` command for exactly this.
pub fn open_new(
    app: &tauri::AppHandle,
    from: Option<&tauri::WebviewWindow>,
) -> Result<tauri::WebviewWindow, String> {
    let Some(mut config) = app.config().app.windows.first().cloned() else {
        return Err("the app has no window configuration to open another from".to_owned());
    };
    config.label = format!(
        "{LABEL_PREFIX}{}",
        NEXT_LABEL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    place(&window, from);
    crate::camera::install(&window);
    let _ = window.show();
    let _ = window.set_focus();
    Ok(window)
}

/// Size `window` for the monitor `from` is on and put it beside `from`, or centre it when there is
/// no `from`. Best-effort, for [`open_sized_to_monitor`]'s reason.
fn place(window: &tauri::WebviewWindow, from: Option<&tauri::WebviewWindow>) {
    let anchor = from.unwrap_or(window);
    let monitor = anchor
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| anchor.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = (
        f64::from(area.position.x) / scale,
        f64::from(area.position.y) / scale,
    );
    let room = (
        f64::from(area.size.width) / scale,
        f64::from(area.size.height) / scale,
    );
    let size = opening_size(room);
    let _ = window.set_size(tauri::LogicalSize::new(size.0, size.1));
    match from.and_then(|f| f.outer_position().ok()) {
        Some(at) => {
            let (x, y) = cascade(
                (f64::from(at.x) / scale, f64::from(at.y) / scale),
                size,
                origin,
                room,
            );
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        }
        None => {
            let _ = window.center();
        }
    }
}
```

  `open_sized_to_monitor(window: &tauri::WebviewWindow)`: the same body, starting from `window`
  instead of the `get_webview_window("main")` lookup. If `rustc` needs `tauri::Manager` in scope for
  `webview_windows`, the file already imports it.

- [ ] **Step 3: Rewire `desktop.rs`.**
  1. **The single-instance callback** (`desktop.rs:~243-247`): replace `focus_existing_window(app)`
     with a spawned open, and delete `focus_existing_window` (`:191-204`) and its doc:

```rust
    #[cfg(desktop)]
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // **A relaunch opens a window, the way Edge and VS Code do** — and Windows' own
            // middle-click on the taskbar icon is a relaunch, so that gesture works with no UI of
            // ours. Spawned, never inline: this runs inside the plugin's window procedure, and
            // building a window from a handler deadlocks on Windows (see `window::open_new`).
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let from = window::focused(&app);
                if let Err(e) = window::open_new(&app, from.as_ref()) {
                    eprintln!("a second launch could not open a window: {e}");
                }
            });
        }));
```

     Update the comment block above it that says the second instance's callback focuses the window.
  2. **Two commands**, beside `sync_run` at the top of the file:

```rust
/// Open another window onto the same app — Ctrl+Shift+N. `caller` is the window that asked, so the
/// new one opens beside it (Tauri injects it by type; the name is ours, and is not `window` because
/// that is the module). `async` because building a window from a synchronous command deadlocks on
/// Windows; see `window::open_new`.
#[tauri::command]
async fn window_new(app: tauri::AppHandle, caller: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    {
        window::open_new(&app, Some(&caller)).map(|_| ())
    }
    #[cfg(mobile)]
    {
        let _ = (app, caller);
        Err("A phone runs the app in one window.".to_owned())
    }
}

/// How many windows are open — what the Update panel's hint says a restart will close.
#[tauri::command]
fn window_count(app: tauri::AppHandle) -> usize {
    app.webview_windows().len()
}
```

  3. **Register** in `generate_handler!`: `window_new,` and `window_count,` beside
     `startup::startup_status`, and `scanner::scanner_elsewhere,` after `scanner::scanner_status,`.
  4. **`setup`**: merge the two `#[cfg(desktop)]` blocks into one:

```rust
            #[cfg(desktop)]
            if let Some(main) = app.get_webview_window("main") {
                window::open_sized_to_monitor(&main);
                camera::install(&main);
            }
```

     keeping both blocks' existing comments above it.
  5. **`init_state`**: after `fence: …,` add

```rust
        // Clean, and hooked up in `start` beside the mirror's mask, for the mask's reason.
        changes: Default::default(),
```

  6. **`start`**: in the `#[cfg(desktop)]` block, replace the `mirror::watch::install_hook(` call
     with `mirror::watch::install_hook_with_changes(` passing `state.changes.clone()` as the fifth
     argument, and after `mirror::watch::spawn(state.clone());` add:

```rust
        // The other windows' refresh — see `crate::changes`. After the hook, so no commit can set
        // a bit before something is waiting to read it.
        crate::changes::spawn_emitter(app.clone(), state.clone());
```

- [ ] **Step 4: Capability.** In `capabilities/desktop.json` set `"windows": ["main", "window-*"]`
  and change `"description"` to open with "Capability for every window on desktop — `main`, and each
  `window-N` a relaunch or Ctrl+Shift+N opens." (keep the rest of the sentence). Add to
  `desktop.rs`'s test module:

```rust
    /// A window the app opens with no capability gets no `core:` — so its `listen` rejects and
    /// `core/tauri.ts` swallows it — no window verbs, no dialog: a window that half works and says
    /// nothing. Every label `window::open_new` mints must be granted what `main` is.
    #[test]
    fn every_window_the_app_opens_is_granted_the_desktop_capability() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
        assert_eq!(
            caps["windows"],
            serde_json::json!(["main", format!("{}*", window::LABEL_PREFIX)])
        );
        let mobile: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/mobile.json")).unwrap();
        assert_eq!(mobile["windows"], serde_json::json!(["main"]), "a phone has one window");
    }
```

  (The test module is `#[cfg(test)]` inside a file that compiles for Android; if `window` is not in
  scope there, gate this one test `#[cfg(desktop)]`.)

- [ ] **Step 5: Report** — and grep `focus_existing_window` across `src-tauri/` to confirm no
  caller is left (docs are Task 11's).

### Task 3: Rust — the scanner lease

**Files:** Modify: `src-tauri/src/scanner.rs`

**Interfaces:**
- Produces (Task 2 registers, Task 4 pins, Task 6 matches): `pub const OPEN_ELSEWHERE: &str =
  "The scanner is open in another window.";` and `#[tauri::command] pub fn scanner_elsewhere(`.

- [ ] **Step 1: Write the lease tests** in `scanner.rs`'s test module:

```rust
    #[test]
    fn a_free_lease_is_taken_and_its_holder_readmitted() {
        let t0 = Instant::now();
        let mut owner = None;
        assert!(take_lease(&mut owner, "main", t0));
        assert!(take_lease(&mut owner, "main", t0 + Duration::from_millis(1)));
    }

    #[test]
    fn another_window_is_refused_inside_the_lease_and_admitted_after_it() {
        let t0 = Instant::now();
        let mut owner = None;
        assert!(take_lease(&mut owner, "main", t0));
        assert!(!take_lease(&mut owner, "window-2", t0 + Duration::from_millis(1999)));
        assert!(take_lease(&mut owner, "window-2", t0 + LEASE));
        assert_eq!(owner.map(|lease| lease.label).as_deref(), Some("window-2"));
    }

    /// A refused frame must not keep the lease alive, or a second window asking every frame would
    /// hold the first one's lease open forever on its behalf.
    #[test]
    fn a_refusal_does_not_renew_the_holders_lease() {
        let t0 = Instant::now();
        let mut owner = None;
        assert!(take_lease(&mut owner, "main", t0));
        assert!(!take_lease(&mut owner, "window-2", t0 + Duration::from_secs(1)));
        assert!(take_lease(&mut owner, "window-2", t0 + LEASE));
    }

    #[test]
    fn asking_never_takes_the_lease() {
        let t0 = Instant::now();
        let mut owner = None;
        assert!(!held_by_another(&owner, "window-2", t0), "a free scanner is nobody's");
        assert!(take_lease(&mut owner, "main", t0));
        assert!(held_by_another(&owner, "window-2", t0 + Duration::from_secs(1)));
        assert!(!held_by_another(&owner, "main", t0), "a window is not elsewhere to itself");
        assert!(!held_by_another(&owner, "window-2", t0 + LEASE), "a lapsed lease is free");
        assert_eq!(owner.map(|lease| lease.label).as_deref(), Some("main"));
    }
```

- [ ] **Step 2: Implement.** Near `ScannerState`:

```rust
/// What a second window's scanner hears, and what its page draws. `verdictText.ts`'s
/// `SCANNER_OPEN_ELSEWHERE` is the same string and `ipc.test.ts` pins this line.
pub const OPEN_ELSEWHERE: &str = "The scanner is open in another window.";

/// How long a window holds the scanner after its last session command.
///
/// **A lease the frames renew, never a claim and a release.** A claim on mount and a release on
/// unmount would race: Tauri does not order two IPC calls, and `main.tsx`'s `StrictMode` mounts
/// every effect twice, so *claim, release, claim* can land as *claim, claim, release* and leave a
/// scanner on screen owning nothing. A reload runs no unmount at all, and a closed window none
/// either. The camera sends frames many times a second while the view is open and none once it is
/// not, so two seconds after the owner leaves, reloads or closes, the scanner is free — with no
/// hook for any of the three.
pub const LEASE: Duration = Duration::from_secs(2);

/// Which window last used the session, and when.
#[derive(Debug)]
struct Lease {
    label: String,
    at: Instant,
}

/// Admit `label` if the lease is free, already its own, or lapsed — and renew it. A refusal
/// renews nothing.
fn take_lease(owner: &mut Option<Lease>, label: &str, now: Instant) -> bool {
    if held_by_another(owner, label, now) {
        return false;
    }
    *owner = Some(Lease {
        label: label.to_owned(),
        at: now,
    });
    true
}

/// Whether a window other than `label` holds a live lease. Takes nothing.
fn held_by_another(owner: &Option<Lease>, label: &str, now: Instant) -> bool {
    matches!(owner, Some(held)
        if held.label != label && now.saturating_duration_since(held.at) < LEASE)
}
```

  Add `owner: Mutex<Option<Lease>>` to `ScannerState` (initialised `Mutex::new(None)` in `new`) and
  two methods:

```rust
    /// Admit the calling window to the session, or refuse with [`OPEN_ELSEWHERE`].
    pub fn admit(&self, label: &str) -> Result<(), String> {
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| "the scanner state is poisoned".to_string())?;
        if take_lease(&mut owner, label, Instant::now()) {
            Ok(())
        } else {
            Err(OPEN_ELSEWHERE.to_owned())
        }
    }

    /// Whether another window holds the scanner — what a second window's page asks before it opens
    /// a camera it would only be refused.
    pub fn elsewhere(&self, label: &str) -> bool {
        self.owner
            .lock()
            .map(|owner| held_by_another(&owner, label, Instant::now()))
            .unwrap_or(false)
    }
```

  Import `std::time::{Duration, Instant}` if not already.

- [ ] **Step 3: Gate the four session commands and add the fifth.** `scanner_frame`,
  `scanner_capture`, `scanner_reset` and `scanner_set_filters` each gain a `webview: tauri::Webview`
  parameter (Tauri injects the caller; the page's calls do not change) and open with
  `state.admit(webview.label())?;` — before any payload is parsed, so a refused frame costs no
  decode. Then:

```rust
/// Whether another window holds the scanner. Asked by a second window's Scanner view, once a
/// second while the answer is yes. Takes nothing — only the four session commands take the lease.
#[tauri::command]
pub fn scanner_elsewhere(
    state: tauri::State<'_, Arc<ScannerState>>,
    webview: tauri::Webview,
) -> bool {
    state.elsewhere(webview.label())
}
```

  `scanner_status`, the prefs and the tray commands stay ungated: the first loads assets and moves
  nothing; the other two are written only by the owning window's page, because a refused window
  mounts no tray (Task 6).

- [ ] **Step 4: Report.**

### Task 4: TypeScript — the IPC mirror and the cross-window refresh

**Files:**
- Modify: `src/lib/ipc.ts`, `src/lib/ipc.test.ts`
- Create: `src/lib/crossWindow.ts`, `src/lib/crossWindow.test.ts`,
  `src/lib/useCrossWindowRefresh.ts`, `src/lib/useCrossWindowRefresh.test.ts`

**Interfaces:**
- Consumes: `src/lib/userTables.json` (Task 1 writes it; if absent when you start, write the same
  contents Task 1 Step 1 gives — identical bytes, so whichever lands is the same file).
- Produces (Tasks 5, 6): `ipc.windowNew(): Promise<void>`, `ipc.windowCount(): Promise<number>`,
  `ipc.scannerElsewhere(): Promise<boolean>`, `ipc.onDbChanged(cb): Unlisten`, `type DbChanged`,
  `useCrossWindowRefresh()` (Task 5 mounts it).

- [ ] **Step 1: `ipc.ts`.** Beside `RelayOutcome`'s neighbours, add the type; beside
  `onSyncApplied`, the four members:

```ts
/**
 * `changes::DbChanged` — which user tables a commit wrote. Sent to every window, and only while
 * two or more are open; `useCrossWindowRefresh` turns it into invalidations.
 */
export interface DbChanged {
  tables: string[];
}
```

```ts
  /** `changes::DB_CHANGED`. Call this once — `useCrossWindowRefresh` does. */
  onDbChanged: (cb: (e: DbChanged) => void): Unlisten => core.listen<DbChanged>("db:changed", cb),
  /** `desktop::window_new` — open another window beside this one (Ctrl+Shift+N). Desktop only. */
  windowNew: () => invoke<void>("window_new"),
  /** `desktop::window_count` — how many windows are open. */
  windowCount: () => invoke<number>("window_count"),
  /**
   * `scanner::scanner_elsewhere` — whether another window holds the scanner's lease. Takes
   * nothing; only the session commands take it.
   */
  scannerElsewhere: () => invoke<boolean>("scanner_elsewhere"),
```

- [ ] **Step 2: Pin the contracts in `ipc.test.ts`.** Add the imports
  `import changesRs from "../../src-tauri/src/changes.rs?raw";` and
  `import desktopRs from "../../src-tauri/src/desktop.rs?raw";` (skip either if already imported;
  `scannerRs` already is), `type DbChanged` to the type import, then:

```ts
/**
 * Multi-window's four names. Each is a string on both sides with nothing in either type system
 * holding them together — a subscriber spelling the event differently hears nothing, forever.
 */
describe("multi-window's cross-boundary names", () => {
  it("subscribes to db:changed and hands the payload through unwrapped", async () => {
    const unlisten = vi.fn();
    let emit: ((evt: { payload: DbChanged }) => void) | undefined;
    listen.mockImplementation((_name: string, handler: (evt: { payload: DbChanged }) => void) => {
      emit = handler;
      return Promise.resolve(unlisten);
    });
    const seen: DbChanged[] = [];
    const stop = await ipc.onDbChanged((e) => seen.push(e));
    emit?.({ payload: { tables: ["decks"] } });

    expect(listen).toHaveBeenCalledWith("db:changed", expect.any(Function));
    expect(seen).toEqual([{ tables: ["decks"] }]);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(changesRs).toContain('pub const DB_CHANGED: &str = "db:changed";');
    expect(changesRs).toContain("pub tables: Vec<&'static str>,");
  });

  it("opens and counts windows by the Rust commands' names, with no arguments", async () => {
    invoke.mockResolvedValue(undefined);
    await ipc.windowNew();
    expect(invoke).toHaveBeenCalledWith("window_new");
    invoke.mockResolvedValue(2);
    expect(await ipc.windowCount()).toBe(2);
    expect(invoke).toHaveBeenCalledWith("window_count");
    expect(desktopRs).toContain("async fn window_new(");
    expect(desktopRs).toContain("fn window_count(");
  });

  it("asks the scanner lease by its Rust name, and quotes its refusal", async () => {
    invoke.mockResolvedValue(true);
    expect(await ipc.scannerElsewhere()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("scanner_elsewhere");
    expect(scannerRs).toContain("pub fn scanner_elsewhere(");
    expect(scannerRs).toContain(
      'pub const OPEN_ELSEWHERE: &str = "The scanner is open in another window.";',
    );
  });
});
```

  If `invoke` is called with a second `undefined` argument by the helper, match the existing
  no-argument test's form (`sync_status`) instead.

- [ ] **Step 3: Write `crossWindow.test.ts` first.**

```ts
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import USER_TABLES from "./userTables.json";
import {
  FOLLOW_LIVE_APP_META,
  PER_WINDOW_KEYS,
  TABLE_KEYS,
  isPerWindowKey,
  keysForTables,
  refreshForTables,
} from "./crossWindow";
import { MARK_COLORS_KEY } from "./useMarkColors";
import { MARKETPLACE_KEY } from "./useMarketplace";
import { NAV_COLLAPSED_KEY } from "./useNavCollapsed";
import { START_VIEW_KEY } from "./useStartView";
import { HOME_LAYOUT_KEY } from "@/features/home/useHomeLayout";
import { RECENT_CARDS_ROOT } from "@/features/home/keys";
import { PRINTING_GROUP_BY_KEY } from "@/features/card/usePrintingGroupBy";
import { SEARCH_OPEN_KEY } from "@/features/search/useSearchOpen";
import { FOLDER_PANE_KEY } from "@/features/decks/useFolderPane";
import { DECK_SEARCH_TAB_KEY } from "@/features/decks/DeckSearchPanel";
import { MIRROR_KEY } from "@/features/settings/BackupPanel";

/** Every key seeded, so an invalidation's reach is readable off `isInvalidated`. */
function seeded(keys: readonly (readonly unknown[])[]): QueryClient {
  const client = new QueryClient();
  for (const key of keys) client.setQueryData([...key], "seed");
  return client;
}
const invalidated = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryState([...key])?.isInvalidated ?? false;

describe("the cross-window table map", () => {
  it("maps every user table — the list Rust holds to its own registry", () => {
    expect(Object.keys(TABLE_KEYS).sort()).toEqual([...USER_TABLES].sort());
  });

  it("spells each key the way its own hook does", () => {
    const follow = FOLLOW_LIVE_APP_META.map((k) => JSON.stringify(k));
    for (const key of [START_VIEW_KEY, HOME_LAYOUT_KEY, MARKETPLACE_KEY, MARK_COLORS_KEY, RECENT_CARDS_ROOT, MIRROR_KEY]) {
      expect(follow).toContain(JSON.stringify(key));
    }
    const perWindow = PER_WINDOW_KEYS.map((k) => JSON.stringify(k));
    for (const key of [NAV_COLLAPSED_KEY, SEARCH_OPEN_KEY, FOLDER_PANE_KEY, DECK_SEARCH_TAB_KEY, PRINTING_GROUP_BY_KEY]) {
      expect(perWindow).toContain(JSON.stringify(key));
    }
  });

  it("refreshes every follow-live app_meta key and no per-window one", () => {
    const client = seeded([...FOLLOW_LIVE_APP_META, ...PER_WINDOW_KEYS]);
    refreshForTables(client, ["app_meta"]);
    for (const key of FOLLOW_LIVE_APP_META) expect(invalidated(client, key)).toBe(true);
    for (const key of PER_WINDOW_KEYS) expect(invalidated(client, key)).toBe(false);
  });

  it("does not pull another window's deck sort in with a deck write", () => {
    const client = seeded([["decks", "list"], ["decks", "sort"]]);
    refreshForTables(client, ["deck_cards"]);
    expect(invalidated(client, ["decks", "list"])).toBe(true);
    expect(invalidated(client, ["decks", "sort"])).toBe(false);
  });

  it("joins a fetch already running rather than cancelling it", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    refreshForTables(client, ["collection_entries"]);
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) expect(call[1]).toEqual({ cancelRefetch: false });
  });

  it("dedupes keys and ignores a table it has never heard of", () => {
    expect(keysForTables(["deck_cards", "deck_notes", "no_such_table"])).toEqual([["decks"]]);
  });

  it("treats a key under a per-window root as per-window", () => {
    expect(isPerWindowKey(["decks", "sort", 3])).toBe(true);
    expect(isPerWindowKey(["decks", "list"])).toBe(false);
  });
});
```

  Check each import path before relying on it (`grep -rn "export const <NAME>" src`); the constants
  exist at the time of writing (`useMarkColors.ts:53`, `useMarketplace.ts:20`,
  `useNavCollapsed.ts:12`, `useStartView.ts:13`, `useHomeLayout.ts:15`, `home/keys.ts:178`,
  `usePrintingGroupBy.ts:13`, `useSearchOpen.ts:16`, `useFolderPane.ts:13`, `DeckSearchPanel.tsx:106`,
  `BackupPanel.tsx:24`). The scanner's two keys and deck sort's are file-private literals, so they
  are spelled, not imported.

- [ ] **Step 4: Write `crossWindow.ts`.**

```ts
/**
 * Which queries a write in *another* window makes stale — the TypeScript half of the cross-window
 * refresh (spec `docs/superpowers/specs/2026-09-19-multi-window-design.md` §4).
 *
 * Rust supplies the fact — `db:changed { tables }`, the user tables a commit wrote — and this module
 * draws the conclusion. **Each table's entry is the union of what that table's own mutations
 * already invalidate in the window that made them**, so the second window refreshes exactly what
 * the first one did. `userTables.json` is the one list both suites read: a table added in Rust
 * without an entry here is a red test in `crossWindow.test.ts`.
 *
 * **View preferences stay per window, and a predicate is what keeps them there.** Deck sort is
 * `["decks", "sort"]`, under the `["decks"]` root every deck write refreshes; without the predicate
 * an edit in window A would pull A's sort into window B.
 */
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import { OWNED_WRITE_KEYS, SYNC_KEY } from "./query";

/**
 * The `app_meta`-backed queries every window follows: Settings choices, and the three whole-value
 * saves (home layout, scanner tray, scanner prefs) — refreshed so every window writes them from
 * fresh data rather than overwriting another window's change.
 */
export const FOLLOW_LIVE_APP_META: readonly QueryKey[] = [
  ["startView"],
  ["homeLayout"],
  ["scanner", "prefs"],
  ["scanner", "tray"],
  ["marketplace"],
  ["markColors"],
  ["recentCards"],
  ["decks", "lastFormat"],
  ["mirror"],
];

/**
 * View preferences each window keeps for itself (spec §2, decision 4) — never refreshed by another
 * window's write, even one under the same root. Card zoom, list/grid and flatten are not here
 * because they are store state seeded once at launch, never a query.
 */
export const PER_WINDOW_KEYS: readonly QueryKey[] = [
  ["navCollapsed"],
  ["searchOpen"],
  ["deckFolderPane"],
  ["decks", "sort"],
  ["deckSearchTab"],
  ["printingGroupBy"],
];

const DECKS: readonly QueryKey[] = [["decks"]];

/** User table → the query roots a write to it makes stale. */
export const TABLE_KEYS: Readonly<Record<string, readonly QueryKey[]>> = {
  activity: [["activity"]],
  app_meta: FOLLOW_LIVE_APP_META,
  card_migrations: [],
  collection_entries: OWNED_WRITE_KEYS,
  collection_folders: [["collection"], ["decks"]],
  collection_shares: [["share"]],
  deck_audit: DECKS,
  deck_cards: DECKS,
  deck_categories: DECKS,
  deck_folders: DECKS,
  deck_labels: DECKS,
  deck_note_cards: DECKS,
  deck_notes: DECKS,
  deck_tokens: DECKS,
  deck_undo: DECKS,
  // A deck's name titles its group in the collection's cabinet — `mirror/watch.rs` maps it to both
  // surfaces for the same reason.
  decks: [["decks"], ["collection"]],
  device_names: [SYNC_KEY],
  error_log: [["errorLog"]],
  muted_tags: [["tags-muted"], ["tag-search"], ["tag-children"], ["tags"]],
  price_snapshots: [],
  sync_clock: [],
  sync_devices: [SYNC_KEY],
  sync_group: [SYNC_KEY],
  sync_identity: [SYNC_KEY],
  sync_ops: [],
  sync_peers: [],
  sync_state: [],
  wishlist_entries: [["wishlist"]],
  wishlist_folders: [["wishlist"]],
};

const BY_TABLE = new Map(Object.entries(TABLE_KEYS));

/** Whether `key` is, or sits under, a per-window root. */
export function isPerWindowKey(key: QueryKey): boolean {
  return PER_WINDOW_KEYS.some((root) => root.every((part, i) => key[i] === part));
}

/** Every query root the `tables` make stale, once each. An unknown table maps to nothing. */
export function keysForTables(tables: readonly string[]): QueryKey[] {
  const seen = new Map<string, QueryKey>();
  for (const table of tables) {
    for (const key of BY_TABLE.get(table) ?? []) seen.set(JSON.stringify(key), key);
  }
  return [...seen.values()];
}

/**
 * Invalidate what another window's write made stale, sparing the per-window keys.
 *
 * `cancelRefetch: false` because the writing window hears the event too, after already refreshing
 * itself: this joins that fetch rather than cancelling and restarting it.
 */
export function refreshForTables(client: QueryClient, tables: readonly string[]): void {
  for (const queryKey of keysForTables(tables)) {
    void client.invalidateQueries(
      { queryKey, predicate: (query: Query) => !isPerWindowKey(query.queryKey) },
      { cancelRefetch: false },
    );
  }
}
```

- [ ] **Step 5: Verify each table's entry against its mutations.** For every table with a non-empty
  entry, grep the mutations that write it (`invalidateQueries` near the matching `ipc.` calls) and
  confirm its entry covers what they invalidate — e.g. `useHiddenTags.ts` for `muted_tags`, the
  wishlist hooks for `wishlist_entries`, `useShares.ts` for `collection_shares`. Widen an entry
  where a mutation invalidates more; never narrow one below its mutations. Report every change.

- [ ] **Step 6: `useCrossWindowRefresh.ts` and its test.**

```ts
import { useEffect } from "react";
import { refreshForTables } from "@/lib/crossWindow";
import { ipc } from "@/lib/ipc";
import { queryClient } from "@/lib/query";

/**
 * Refresh this window when another one writes.
 *
 * `useDeviceSyncInvalidation`'s shape, for its reason: an event listener rather than a render, so
 * the module-level `queryClient`. Rust sends `db:changed` only while two or more windows are open,
 * so in a one-window session this subscribes and never hears anything.
 *
 * **Call this once.** `AppShell` does.
 */
export function useCrossWindowRefresh(): void {
  useEffect(() => ipc.onDbChanged((e) => refreshForTables(queryClient, e.tables)), []);
}
```

```ts
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc, type DbChanged } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import { useCrossWindowRefresh } from "./useCrossWindowRefresh";

afterEach(() => vi.restoreAllMocks());

describe("useCrossWindowRefresh", () => {
  it("turns another window's write into this window's invalidation, and unsubscribes", () => {
    let hear: ((e: DbChanged) => void) | undefined;
    const off = vi.fn();
    vi.spyOn(ipc, "onDbChanged").mockImplementation((cb) => {
      hear = cb;
      return off;
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { unmount } = renderHook(() => useCrossWindowRefresh());
    hear?.({ tables: ["wishlist_entries"] });

    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["wishlist"] }),
      { cancelRefetch: false },
    );
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 7: Run your own files only:** `npx vitest run src/lib/crossWindow.test.ts
  src/lib/useCrossWindowRefresh.test.ts`. `ipc.test.ts` reads Rust sources other tasks are still
  writing — do not run it. Report.

### Task 5: TypeScript — the window UX

**Files:**
- Modify: `src/lib/shortcuts.ts`, `src/lib/shortcuts.test.ts`, `src/lib/platform.ts`,
  `src/components/KeyMap.tsx`, `src/components/AppShell.tsx`, `src/lib/window.ts`,
  `.storybook/fake/window.ts`, `src/features/settings/UpdatePanel.tsx`,
  `src/features/settings/UpdatePanel.test.tsx`, `src/features/settings/SettingsPage.tsx`, and any
  existing KeyMap/AppShell test the new row breaks
- Create: `src/lib/window.test.ts`, `src/lib/useWindowCount.ts`, `src/lib/useWindowCount.test.ts`

**Interfaces:**
- Consumes (Task 4): `ipc.windowNew`, `ipc.windowCount`, `useCrossWindowRefresh`.

- [ ] **Step 1: `platform.ts`** — add, beside `isAndroid`:

```ts
/**
 * The desktop shell — neither the browser build nor a phone. What a desktop-only chord asks: a
 * second window exists only here (a phone runs one task per app; a browser tab is its own app).
 */
export function isDesktop(): boolean {
  return !isWebTarget() && !isAndroid();
}
```

  importing `isWebTarget` from `@/pwa/target`. If that import creates a cycle (check
  `src/pwa/target.ts`'s imports), put `isDesktop` in a new `src/lib/desktop.ts` instead and import
  from there below.

- [ ] **Step 2: Failing tests in `shortcuts.test.ts`:**

```ts
describe("newWindow", () => {
  it("is Ctrl+Shift+N, and only that", () => {
    const row = shortcut("global", "newWindow");
    expect(matchesShortcut(row, press("n", { ctrl: true, shift: true }))).toBe(true);
    expect(matchesShortcut(row, press("N", { ctrl: true, shift: true }))).toBe(true);
    expect(matchesShortcut(row, press("n", { ctrl: true }))).toBe(false);
  });

  it("is listed on the desktop and nowhere else", () => {
    const row = shortcut("global", "newWindow");
    expect(shownOn(row, true)).toBe(true);
    expect(shownOn(row, false)).toBe(false);
    expect(shownOn(shortcut("global", "keyMap"), false)).toBe(true);
  });
});
```

- [ ] **Step 3: `shortcuts.ts`.** Add to `Shortcut`:

```ts
  /**
   * Bound and listed only in the desktop build. A chord for something the platform cannot do is a
   * row that promises a key nothing binds — which is the drift this module exists to end.
   */
  desktopOnly?: boolean;
```

  After the `keyMap` row in `global`:

```ts
    {
      id: "newWindow",
      label: "Open a new window",
      /**
       * VS Code's New Window chord, and Ctrl+N is left alone for a "new thing" a view may want.
       * Relaunching the app does the same, which is what Windows' middle-click on the taskbar icon
       * is — see `window::open_new`.
       */
      chords: [{ key: "n", ctrl: true, shift: true }],
      desktopOnly: true,
    },
```

  And the helper:

```ts
/** Whether a row is drawn and bound in this build. `desktop` is `isDesktop()` at the call site. */
export function shownOn(row: Shortcut, desktop: boolean): boolean {
  return row.desktopOnly !== true || desktop;
}
```

- [ ] **Step 4: `KeyMap.tsx`** — where it reads `SHORTCUTS[scope]` (`KeyMap.tsx:256`), filter with
  `.filter((row) => shownOn(row, isDesktop()))`. Run the existing KeyMap test; if it counts the
  global rows, update the count and say why in the test.

- [ ] **Step 5: `AppShell.tsx`.**
  - Beside `useDeviceSyncInvalidation();` (`AppShell.tsx:248`) add `useCrossWindowRefresh();` with a
    one-line comment naming what it hears.
  - Beside the module-level `KEY_MAP` constant add `const NEW_WINDOW = shortcut("global",
    "newWindow");`.
  - In the `keydown` handler, after the `KEY_MAP` branch and **before** the `aria-modal` return
    (opening another window disturbs nothing in this one, so a modal need not block it):

```ts
      if (isDesktop() && matchesShortcut(NEW_WINDOW, e)) {
        e.preventDefault();
        // Held keys repeat at the OS rate, and every repeat would be another window.
        if (!e.repeat) void ipc.windowNew().catch(() => undefined);
        return;
      }
```

- [ ] **Step 6: `window.ts` — the hover belongs to its window.** Write `src/lib/window.test.ts`
  first:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const windowListen = vi.hoisted(() => vi.fn(async () => () => undefined));
const globalListen = vi.hoisted(() => vi.fn(async () => () => undefined));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "window-2", listen: windowListen }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: globalListen }));

import { SNAP_HOVER_EVENTS, onSnapHover } from "./window";

beforeEach(() => {
  windowListen.mockClear();
  globalListen.mockClear();
});

describe("onSnapHover", () => {
  /**
   * The snap-layout plugin emits to one window's label. A global `listen` hears every label, so
   * with two windows open, hovering one maximize button lit both.
   */
  it("listens on its own window, never app-wide", async () => {
    await onSnapHover(() => undefined);
    expect(windowListen).toHaveBeenCalledWith(SNAP_HOVER_EVENTS.enter, expect.any(Function));
    expect(windowListen).toHaveBeenCalledWith(SNAP_HOVER_EVENTS.leave, expect.any(Function));
    expect(globalListen).not.toHaveBeenCalled();
  });
});
```

  Then in `window.ts`: `onSnapHover` takes `const win = getCurrentWindow();` and calls
  `win.listen(…)` for both events; drop the `@tauri-apps/api/event` import if nothing else uses it.
  Add to its doc: why its own window (the sentence from the test above). Change `closeWindow`'s
  first line to "Close this window. The app ends when its last window closes." and leave the rest.

- [ ] **Step 7: The fake window.** In `.storybook/fake/window.ts`'s `getCurrentWindow()` object add
  `label: "main",` and

```ts
    /**
     * `Window.listen` — an event aimed at this window. There is one window here, so it is the
     * fake bus's `listen`, which is also what keeps `TitleBar`'s `emitFake(SNAP_HOVER_EVENTS…)`
     * stories and tests reaching the button.
     */
    async listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> {
      return listen(event, cb);
    },
```

  with `import { listen } from "./event";`. Then run `npx vitest run src/lib/window.test.ts
  src/components/TitleBar.test.tsx` — the TitleBar hover tests must still pass.

- [ ] **Step 8: `useWindowCount.ts` and its test.**

```ts
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { isWebTarget } from "@/pwa/target";

export const WINDOW_COUNT_KEY = ["windows", "count"];

/**
 * How many windows are open. Polled every two seconds while something reads it, rather than an
 * event: its one reader is the Update panel's hint, open for seconds at a time. The web build does
 * not route `window_count`, so there the answer is one without asking.
 */
export function useWindowCount(): number {
  const query = useQuery({
    queryKey: WINDOW_COUNT_KEY,
    queryFn: ipc.windowCount,
    enabled: !isWebTarget(),
    refetchInterval: 2000,
  });
  return query.data ?? 1;
}
```

  `src/lib/useWindowCount.test.tsx` (`.tsx` for the wrapper's JSX):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { isWebTarget } from "@/pwa/target";
import { useWindowCount } from "./useWindowCount";

vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(isWebTarget).mockReturnValue(false);
});

function withClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useWindowCount", () => {
  it("answers one until the backend says otherwise", async () => {
    vi.spyOn(ipc, "windowCount").mockResolvedValue(3);
    const { result } = renderHook(() => useWindowCount(), { wrapper: withClient() });
    expect(result.current).toBe(1);
    await waitFor(() => expect(result.current).toBe(3));
  });

  it("never asks the web build, which does not route the command", () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    const ask = vi.spyOn(ipc, "windowCount");
    const { result } = renderHook(() => useWindowCount(), { wrapper: withClient() });
    expect(result.current).toBe(1);
    expect(ask).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 9: The Update panel's hint.** Test first, in `UpdatePanel.test.tsx`:

```ts
describe("with more than one window open", () => {
  it("says a restart closes all of them, on the button's own description", () => {
    render(<UpdatePanel update={update({ action: "install" })} history={history()} windows={3} />);
    const button = screen.getByRole("button", { name: /Restart to finish/ });
    expect(button).toHaveAccessibleDescription("Restarting closes all 3 windows.");
  });

  it("says nothing at one window", () => {
    render(<UpdatePanel update={update({ action: "install" })} history={history()} />);
    expect(screen.queryByText(/closes all/)).not.toBeInTheDocument();
  });
});
```

  Then `UpdatePanel` takes `windows = 1` (a `number` prop with that default, documented as "how
  many windows the restart will close") and passes it to `PrimaryAction`, whose `install` branch
  renders, after the button, when `windows > 1`,
  `<p id={hintId} className="text-sm text-dim">Restarting closes all {windows} windows.</p>` and
  gives the button `aria-describedby={windows > 1 ? hintId : undefined}` (`hintId` from
  `useId()`). Keep the panel's layout: if `PrimaryAction` sits in a flex row, wrap the button and
  hint so the hint lands under the button rather than beside it, and check the Update stories still
  read well in that arrangement. In `SettingsPage.tsx`, add `const windows = useWindowCount();`
  among the page's hooks and render `<UpdatePanel update={update} history={history}
  windows={windows} />`.

- [ ] **Step 10: Run your files:** `npx vitest run src/lib/shortcuts.test.ts src/lib/window.test.ts
  src/lib/useWindowCount.test.tsx src/components/TitleBar.test.tsx src/components/KeyMap.test.tsx
  src/features/settings/UpdatePanel.test.tsx` (skip any that does not exist). Report.

### Task 6: TypeScript — the scanner gate

**Files:**
- Modify: `src/features/scanner/ScannerPage.tsx`, `src/features/scanner/verdictText.ts`,
  `src/features/scanner/ScannerPage.test.tsx`, `src/features/scanner/ScannerPage.stories.tsx`
- Create: `src/features/scanner/useScannerElsewhere.ts`

**Interfaces:**
- Consumes (Task 4): `ipc.scannerElsewhere`. (Task 7): the fake fault `"scannerElsewhere"`.
- Must equal (Task 3): `SCANNER_OPEN_ELSEWHERE` === Rust `OPEN_ELSEWHERE`.

- [ ] **Step 1: The sentence**, in `verdictText.ts`:

```ts
/**
 * What a second window's Scanner view says while another window holds the camera. The same string
 * as `scanner::OPEN_ELSEWHERE`, which is also how a refused frame reads — `ipc.test.ts` pins the
 * Rust half.
 */
export const SCANNER_OPEN_ELSEWHERE = "The scanner is open in another window.";
```

- [ ] **Step 2: `useScannerElsewhere.ts`.**

```ts
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

export const SCANNER_ELSEWHERE_KEY = ["scanner", "elsewhere"];

/**
 * Whether another window holds the scanner's lease — asked before this window opens a camera it
 * would only be refused, and again each second while the answer is yes, so the view opens on its
 * own once the other window lets go. Never cached as fresh: the lease lapses on a clock.
 */
export function useScannerElsewhere() {
  return useQuery({
    queryKey: SCANNER_ELSEWHERE_KEY,
    queryFn: ipc.scannerElsewhere,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data === true ? 1000 : false),
  });
}
```

- [ ] **Step 3: Tests first**, in `ScannerPage.test.tsx`. The file mocks `@/lib/ipc` by spreading
  the real one; add `scannerElsewhere: vi.fn(async () => false),` to that mock's `ipc` object. Then:

```tsx
describe("ScannerPage with another window holding the scanner", () => {
  it("says so, and asks for no camera and no prefs", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("x", "NotAllowedError")));
    mediaDevices(getUserMedia);
    vi.mocked(ipc.scannerElsewhere).mockResolvedValueOnce(true);
    mount();
    expect(await screen.findByText(SCANNER_OPEN_ELSEWHERE)).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(ipc.scannerPrefs).not.toHaveBeenCalled();
  });

  /** The lease can change hands between the ask and the first session command. */
  it("asks again when a session command is refused as elsewhere", async () => {
    refused();
    vi.mocked(ipc.scannerSetFilters).mockRejectedValueOnce(SCANNER_OPEN_ELSEWHERE);
    mount();
    await waitFor(() => expect(ipc.scannerElsewhere).toHaveBeenCalledTimes(2));
  });
});
```

  (import `SCANNER_OPEN_ELSEWHERE` from `./verdictText`). **The gate makes the live view one render
  late**, so any existing test that queries the live view synchronously after `mount()` — the
  `it(…, () => {` ones without `async`, such as the phone-layout test at `:308` — must first
  `await screen.findBy…` the element it wants. Change those tests' waits and nothing else about
  them, and say which in your report.

- [ ] **Step 4: The gate**, in `ScannerPage.tsx`:

```tsx
export function ScannerPage(): JSX.Element {
  return isWebTarget() ? <WebSentence /> : <ScannerGate />;
}

/**
 * One window scans at a time (spec §5.3): the scanner is a lease another window's frames renew.
 * Asked before `LiveScanner` mounts, so a second window never opens a camera only to be refused.
 * A failed ask is treated as "free" — the frames are the real gate and will refuse if it is not.
 */
function ScannerGate() {
  const elsewhere = useScannerElsewhere();
  if (elsewhere.data === true) return <ElsewhereSentence />;
  if (elsewhere.isPending) {
    return (
      <section className="flex h-full flex-col gap-3">
        <h2 className="sr-only">Scanner</h2>
      </section>
    );
  }
  return <LiveScanner />;
}

function ElsewhereSentence() {
  return (
    <section className="flex h-full flex-col gap-3">
      <h2 className="sr-only">Scanner</h2>
      <p>{SCANNER_OPEN_ELSEWHERE}</p>
      <p className="text-dim">It opens here once that window leaves the Scanner or closes.</p>
    </section>
  );
}
```

  In `LiveScanner`, after `loop` and the prefs are in scope:

```tsx
  // **A refusal is the lease saying another window has the scanner** — it took it in the moment
  // between this window's ask and its first frame. Asking again flips the gate to the sentence,
  // which unmounts this view and stops the camera.
  const refusedElsewhere =
    loop.error === SCANNER_OPEN_ELSEWHERE || filterError === SCANNER_OPEN_ELSEWHERE;
  useEffect(() => {
    if (refusedElsewhere) void queryClient.invalidateQueries({ queryKey: SCANNER_ELSEWHERE_KEY });
  }, [refusedElsewhere, queryClient]);
```

  Update `ScannerPage`'s doc comment (the "Dispatched above the hooks" paragraph) to say the gate
  sits between the web dispatch and the live view, and why.

- [ ] **Step 5: A story**, in `ScannerPage.stories.tsx`, following the file's own conventions:

```tsx
/** Another window holds the scanner: one sentence, no camera, no tray. */
export const OpenInAnotherWindow: Story = {
  parameters: { fake: { fault: "scannerElsewhere" } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(SCANNER_OPEN_ELSEWHERE)).toBeVisible();
  },
};
```

  (Match the file's existing `Story` type, `play` signature and `expect` import.)

- [ ] **Step 6: Run** `npx vitest run src/features/scanner/ScannerPage.test.tsx`. Report.

### Task 7: The Storybook fake

**Files:** Modify: `.storybook/fake/db.ts`, `.storybook/fake/event.ts`, `.storybook/CLAUDE.md`

**Interfaces:**
- Produces (Task 6): fault `"scannerElsewhere"`; handlers `scanner_elsewhere`, `window_new`,
  `window_count`.

- [ ] **Step 1: The fault.** Find the fault union (`grep -n "scannerMissing" .storybook/fake/db.ts`)
  and add `"scannerElsewhere"` beside `"scannerMissing"`, with a doc paragraph in the same list the
  file keeps (near `db.ts:1306`): *another window holds the scanner's lease, so
  `scanner_elsewhere` answers `true` and the Scanner view draws one sentence and opens no camera.*
- [ ] **Step 2: Handlers.** In `scannerHandlers` (`db.ts:~20114`):

```ts
    /** `scanner::scanner_elsewhere` — whether another window holds the scanner's lease. */
    scanner_elsewhere: (): boolean => db.fault === "scannerElsewhere",
```

  And a new group, added to `allHandlers`:

```ts
/**
 * The window commands. A story is one window and cannot open another, so `window_new` only
 * answers and `window_count` is always one.
 */
export function windowHandlers() {
  return {
    /** `desktop::window_new`. */
    window_new: (): void => undefined,
    /** `desktop::window_count`. */
    window_count: (): number => 1,
  };
}
```

- [ ] **Step 3: `event.ts`'s list** — add `db:changed` (`DbChanged`, subscribed once by
  `useCrossWindowRefresh`, emitted only while two or more windows are open, so a story — one window
  — never hears it unless it calls `emitFake`) in the file's own prose style.
- [ ] **Step 4: `.storybook/CLAUDE.md`** — the faults paragraph: **re-count** (`twenty-seven` →
  the new number) and add `scannerElsewhere` to the list, in the same commit, per the root
  `CLAUDE.md` rule about counts.
- [ ] **Step 5: Run** `npx vitest run .storybook/fake/db.test.ts -t scanner` and report.

### Task 8: `cdp.mjs` with two windows

**Files:** Modify: `scripts/cdp.mjs`

- [ ] **Step 1:** Replace `pageTarget()` (`cdp.mjs:35-49`) with:

```js
/** Every page target — one per window. WebView2 also lists workers and about:blank helpers. */
async function pageTargets() {
  let list;
  try {
    list = await (await fetch(`${BASE}/json/list`)).json();
  } catch {
    throw new Error(
      `nothing is listening on ${BASE}. Launch the app with ` +
        `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=${PORT}" first.`,
    );
  }
  return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

/**
 * The page to drive. Every window has the same URL and title, so with two open the choice is
 * arbitrary unless `CDP_PAGE` names one — an index into `pages`' list, or a target id.
 */
async function pageTarget() {
  const pages = await pageTargets();
  if (pages.length === 0) throw new Error("no page target is open");
  const want = process.env.CDP_PAGE;
  if (want !== undefined) {
    const hit = /^\d+$/.test(want) ? pages[Number(want)] : pages.find((p) => p.id === want);
    if (!hit) {
      throw new Error(
        `CDP_PAGE=${want} names none of the ${pages.length} pages — "node scripts/cdp.mjs pages" lists them`,
      );
    }
    return hit;
  }
  if (pages.length > 1) {
    console.error(
      `cdp.mjs: ${pages.length} windows are open; driving page 0 (${pages[0].id}). ` +
        `Set CDP_PAGE to choose — "node scripts/cdp.mjs pages" lists them.`,
    );
  }
  return pages[0];
}
```

- [ ] **Step 2:** In `main()`, before `const cdp = await connect();`:

```js
  // Lists the windows rather than driving one, so it needs no connection.
  if (cmd === "pages") {
    const pages = await pageTargets();
    pages.forEach((p, i) => console.log(`${i}\t${p.id}\t${p.title}\t${p.url}`));
    return;
  }
```

  Add `pages` to the usage string, and a header example:
  `//     node scripts/cdp.mjs pages                     # one line per window; CDP_PAGE=<n> picks`.
- [ ] **Step 3:** `node --check scripts/cdp.mjs`. Report.

---

## Wave 2 — fan-in (the orchestrator, not a subagent)

### Task 9: Integrate, verify, commit

- [ ] **Step 1:** Read every wave-1 report. Grep for the seams: `install_hook_with_changes`,
  `spawn_emitter`, `scanner_elsewhere`, `window_new`, `useCrossWindowRefresh(`,
  `SCANNER_OPEN_ELSEWHERE`, `userTables.json` — each must have its producer and its consumer.
- [ ] **Step 2:** `cargo fmt --manifest-path src-tauri/Cargo.toml` then
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` (CI runs both;
  `verify` runs neither). Fix what they report.
- [ ] **Step 3:** `npm run verify` in the foreground, **not piped** — a pipe reports the pipe's exit
  code. Only one verify at a time on this machine. Fix every failure; a failure in a file no task
  touched is still ours if a task's change caused it.
- [ ] **Step 4: Mutate, then run** (`tests-that-pass-over-the-defect`): (a) delete `app_meta`'s
  entry from `TABLE_KEYS` — the "maps every user table" test must go red; (b) drop the predicate from
  `refreshForTables` — the deck-sort test must go red; (c) make `take_lease` renew on refusal — the
  "does not renew" test must go red; (d) remove the `ringing.pending()` guard's ring — the hook ring
  test must go red. Restore each.
- [ ] **Step 5:** Commit once per task, staging each task's files by path (never `git add -A`), with
  `feat(windows):`/`feat(changes):`/`feat(scanner):`/`chore(cdp):` prefixes and the attribution line.

### Task 10: The live pass (under the app lock)

Follow the `running-the-app` skill: `lock.ps1 acquire app -Wait`, launch `npm run tauri dev` with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, adopt the `mtg-grimoire` pid.
Use `node scripts/cdp.mjs pages` and `CDP_PAGE` to drive each window. Record every figure with the
build (debug) and the date.

- [ ] 1. Ctrl+Shift+N opens a sized, cascaded window; a second `mtg-grimoire.exe` launch (the debug
  exe from `src-tauri/target/debug`) opens another. `pages` lists three.
- [ ] 2. The same deck open in two windows: an edit in one appears in the other without focusing it.
  A collection add moves the Owned badge on the other window's search results.
- [ ] 3. Zoom and nav collapse in window 1 leave window 2 alone; deck sort likewise. A marketplace
  change in window 1 re-prices window 2; a home-layout edit shows in both.
- [ ] 4. With one window, no `db:changed` arrives — a listener installed over CDP counts zero across
  a dozen writes; with two, it counts one per burst.
- [ ] 5. Snap hover lights only its own window (Win32 check — CDP cannot see the frame; see the
  `verify-native-window-behaviour-with-win32` memory).
- [ ] 6. Close the original window: the other lives. Close the last: the process exits, and
  `user.db-wal` is truncated (the checkpoint ran).
- [ ] 7. Scanner open in window 1 → window 2 shows the sentence and no camera; leave the Scanner in
  window 1 → window 2 opens it within about a second. (No camera needed for the gate: drive frames
  per the `drive-the-scanner-tracker-without-a-camera` memory if a frame must be sent.)
- [ ] Release the lock (`lock.ps1 release app`) and end the report with `lock.ps1 status`.

### Task 11: Documentation

After Task 10, so a doc edit under `src-tauri/` cannot restart the `tauri dev` a live pass is using.

- [ ] Create `docs/reference/multi-window.md`: why windows and not processes (the §1 hazard table),
  the change mask and the emitter, the table map and the per-window predicate, the scanner lease,
  and Task 10's findings with dates and build.
- [ ] Root `CLAUDE.md`: a row in the reference-docs table; the "A portable copy exits silently…"
  line now says a second launch opens a window **in the running app** — including a dev build from
  another worktree, which then shows the running worktree's frontend.
- [ ] `.claude/skills/running-the-app/SKILL.md` and `lock.ps1`'s header: the same consequence, and
  fix the stale line references (`lib.rs:203` → `desktop.rs`'s single-instance block; `cdp.mjs:31`
  → the `CDP_PORT` line) and mention `pages`/`CDP_PAGE`.
- [ ] `src-tauri/CLAUDE.md`: the Android gating paragraph names `focus_existing_window`, which is
  gone; the window-size bullet says `open_sized_to_monitor` sizes "the main window"; the capabilities
  section says `desktop.json` covers `main` — update all three.
- [ ] `docs/reference/keyboard-shortcuts.md`: the `newWindow` row and `desktopOnly`.
- [ ] `docs/reference/live-ui-verification.md`: driving two windows (`pages`, `CDP_PAGE`, the
  warning).
- [ ] Commit `docs(windows): …`.
