# Multi-window: more than one window onto one collection

A reader wants two views at once — the canonical case is two decks side by side — and today cannot
have them. This spec gives them **more windows in the one process**, not more processes. The
developer half of the same complaint (two worktrees' dev apps at once) was weighed alongside it and
**deliberately left as it is**: the one-app lock in `.claude/skills/running-the-app/` stays the
answer there.

Everything here was measured on Windows, against the source at `13dba8c2` and the crates
`Cargo.lock` resolves: tauri 2.11.5, tauri-plugin-single-instance 2.4.3, tauri-plugin-snap-layout
1.0.9, wry 0.55.1, `@tanstack/query-core` 5.101.4. Nothing was launched to write it.

---

## 1. What is already true

### Why a second copy is refused

`tauri-plugin-single-instance` is registered first in `desktop.rs:245`. On Windows it keys on
`app.config().identifier` and nothing else (`tauri-plugin-single-instance-2.4.3/src/platform_impl/windows.rs:58`):
a named mutex `com.mtggrimoire.app-sim` and a hidden message window `…-siw`. A second process
finds the window, sends it `cwd|args` over `WM_COPYDATA`, and calls `std::process::exit(0)` — no
window, no stderr. The builder has no Windows key override (`dbus_id` is Linux-only), so the
identifier is the only lever. The callback in the first process currently calls
`focus_existing_window` (`desktop.rs:200`).

### Why that guard stays

Two processes on one data folder is not a guard to remove, it is a subsystem to rebuild. SQLite
copes — WAL (`db.rs:97`), a 5 s busy timeout — but everything above it assumes one owner:

| Hazard | Where |
| --- | --- |
| Fixed temp paths a peer truncates or appends into mid-ingest | `tmp/default-cards.jsonl.gz` (`sync.rs:1119`), the tag, price and combo temps, `updates/{asset}.part` |
| A launch drops the peer's staging table | `DROP TABLE IF EXISTS corpus.cards_staging` (`schema.rs:4753`) |
| Launch-time file deletion and a migration ladder read outside a transaction | `prepare_data_dir` (`schema.rs:6618`), `migrate_user` (`schema.rs:4801`) |
| Every "already running" guard is process memory | `syncing`, the three feeds' `REFRESHING`, the updater's `busy`, Scryfall's 429 penalty |
| Caches nothing invalidates across processes | the facet index generation, owned counts, every webview's query cache |
| A second mirror writer, non-atomic writes | `mirror/run.rs:345` |
| A new instance deletes the running one's staged update | `update::clean_up` (`desktop.rs:859` says so) |

A window in the same process shares `AppState`, the one write connection, the one set of background
services, the mirror, live sync and the updater — so **every row of that table is simply not a
question**. That is the decision this spec rests on.

### What a second window meets today

| Assumption | Where |
| --- | --- |
| Only `main` is granted anything | `capabilities/desktop.json:6` — `"windows": ["main"]`. Another label gets no `core:` (so `listen` rejects, and `core/tauri.ts:34-40` swallows it), no window verbs, no dialog, clipboard or snap-layout |
| Only `main` is sized and shown | `window::open_sized_to_monitor` (`window.rs:77`); the config window is `visible: false` |
| Only `main` gets the camera grant | `camera::install` (`desktop.rs:693`) |
| Invalidation is local to the writing window | e.g. `useDeckUndo.ts:84`, `OWNED_WRITE_KEYS` (`query.ts:31`) |
| Focus refetch cannot help | query-core listens to `visibilitychange` only (`focusManager.js:12`); clicking between two visible windows fires nothing |
| `app_meta` rows are read with `staleTime: Infinity` | "nothing else writes this row" — `useStartView`, `useHomeLayout`, `useScannerPrefs`, `useTray` and the view prefs |
| Whole-value writes | `setHomeLayout`, `setScannerTray`, `setScannerPrefs`, `setDeckFolderPane` — last writer wins |
| The snap-hover listener hears every window's hover | `onSnapHover` (`src/lib/window.ts:99`) uses the global `listen`; the plugin emits to one label (`snap.rs:142`) and a target-Any listener hears it |
| Installing an update ends every window | `update_apply` → `app.exit(0)` (`update.rs:1184`) |
| One scanner session per process | `ScannerState.loaded` (`scanner.rs:179`) |

What needs nothing: the frontend has no router (`store.ts:1111`) and no web storage on desktop;
shortcuts are per document; nothing in `src/` starts a background job on mount (they all start once,
in Rust's `start()`); `startup_status` already answers `Ready` to a late window; deck undo is
already guarded against a cursor another window moved (`MOVED_ON`, `deck_undo.rs:1543`); the
snap-layout plugin keeps its state per HWND and injects into every webview.

---

## 2. The decisions

Settled with the reader of this spec, 2026-09-19:

1. **A second window is the full app, opening on the start view.** Same shell, same nav, every
   view. No "open onto deck X" — the reader navigates.
2. **Two ways in:** launching the exe again opens a window (Start menu, a shortcut, middle-click on
   the taskbar icon); and **Ctrl+Shift+N**. No caption button.
3. **Last window quits.** Every window is equal; closing one closes only it.
4. **View preferences are per window; data and settings follow live.** Zoom, list/grid, the nav
   rail and the rest stay where each window put them. Collection, decks, wishlist and the Settings
   dialog's choices refresh everywhere.
5. **Refresh is a Rust event driven by the commit**, not a frontend re-broadcast and not
   focus-only.
6. **The scanner refuses in a second window**; no takeover.

---

## 3. Opening, sizing and closing

### `window::open_new(app, from)`

One function, in `window.rs`, behind both ways in:

- Build from `app.config().app.windows[0]` **cloned with a new label** — `WebviewWindowBuilder::from_config`
  reads the label off the config — so the new window is hidden, undecorated, the same minimum size,
  `dragDropEnabled: false`, shadow on. Labels are `window-2`, `window-3`, … from a monotonic
  `AtomicU32`; a closed window's label is never reused.
- Size it with the existing `opening_size` rungs, on the monitor of `from` (falling back to the
  primary monitor); place it **32 logical px down and right of `from`**, clamped into the work area.
  With no `from`, centre it. The placement is a pure function beside `opening_size` so it can be
  tested the same way.
- `camera::install` on it, `show()`, `set_focus()`.

`open_sized_to_monitor` changes to take a `&WebviewWindow` instead of looking up `"main"`, so the
first window and every later one share one sizing path.

⚠️ **Never call it synchronously from a handler.** Tauri documents that building a window on
Windows "deadlocks when used in a synchronous command or event handlers"
(`tauri-2.11.5/src/webview/webview_window.rs:115`). The single-instance callback runs inside the
plugin's window procedure, so it **spawns** onto `tauri::async_runtime`; the command is `async`.

### The two ways in

- **Relaunch.** The single-instance callback calls `open_new(app, focused)`, where `focused` is
  whichever window has focus, else any. `focus_existing_window` is deleted. It works during startup
  too: a window needs no `AppState` to exist, and its page waits on `startup_status` like the first.
- **Ctrl+Shift+N.** A `newWindow` row in `src/lib/shortcuts.ts`'s `global` group — Ctrl+N and
  Ctrl+Shift+N are both unbound today — which puts it in the F1 key map with no further work. It
  calls a new `window_new` command; Tauri supplies the calling `WebviewWindow` as `from`. **Desktop
  only**: the web and Android builds neither bind it nor list it.

### Permissions

`capabilities/desktop.json`: `"windows": ["main", "window-*"]` — capability labels accept globs
(`tauri-utils-2.9.3/src/acl/capability.rs:85`). `mobile.json` is untouched.

### Closing

Tauri's default already is the decision: closing a window destroys it, and `RunEvent::ExitRequested`
arrives only when the last one goes — so the exit push and the WAL checkpoint in `desktop.rs:723`
run exactly once, at the real exit. The only edit is `closeWindow`'s doc comment in
`src/lib/window.ts:34`, which says it "ends the process".

### Window count

A `window_count` command and a `windows:changed` event. Tauri's `WindowEvent` has no "created"
arm, so the event is emitted by `open_new` after `show()` and by `on_window_event` on `Destroyed`
— the config's first window predates any listener and needs neither. `useWindowCount()` reads the
command once and listens to the event. Its one reader is the update button (§5); the refresh gate
(§4) asks `app.webview_windows().len()` directly.

---

## 4. Cross-window refresh

**Rust supplies the fact — which user tables a commit wrote. TypeScript draws the conclusion — which
queries that makes stale.** The repository's standing boundary, applied.

### Rust: `changes.rs`

- **The mask.** `Changes`: an `AtomicU64`, one bit per table in the **user** database, indexed by a
  fixed, sorted `&'static [&str]`. `mark(db, table)` ignores anything not in `main`, finds the bit
  by binary search and does one `fetch_or`. No allocation, no lock, no call back into SQLite — the
  constraints `mirror/watch.rs`'s module doc already states for a hook.
- **Riding the existing hook.** SQLite allows one update hook per connection, so `install_hook`
  (`mirror/watch.rs:225`) gains the `Changes` handle and its closure calls `changes.mark(db, table)`
  beside `marker.note(db)` and the mirror's `mask.mark`. The corpus never sets a bit, so a Scryfall
  ingest, a feed refresh or a tag download emits nothing.
- **The six tables the hook cannot see.** `update_hook` does not fire for `WITHOUT ROWID` tables,
  and six user tables are: `muted_tags`, `sync_devices`, `sync_state`, `sync_peers`,
  `device_names`, `price_snapshots`. Each is either **marked explicitly at its write sites**
  (`changes.mark_table(…)`) or **listed as invisible to the UI**; a test enumerates every
  `WITHOUT ROWID` table in `main.sqlite_master` against that decision, so a seventh goes red until
  somebody makes one. Expected: the first, second, fifth and sixth marked; `sync_state` and
  `sync_peers` invisible.
- **The wake.** The existing commit hook (`mirror/watch.rs:254`) already rings live sync's
  `Notify`; it rings a second one, `changes_wake`. `notify_one` stores at most one permit, so a
  commit storm is one wake.
- **The emitter.** A task spawned in `start()`, desktop only:
  1. await `changes_wake`, then sleep **50 ms** so a burst of commits is one event;
  2. **take and drop the write lock** (`db::lock_for`, `WRITE_LOCK_WAIT`) — the commit hook fires
     *before* the commit is durable, and the commit happens under that mutex, so acquiring it is a
     barrier that proves the commit that rang has finished. On timeout, emit anyway;
  3. `take()` the bits — always, so nothing stale is waiting when a second window opens;
  4. if the bits are non-zero **and** `app.webview_windows().len() >= 2`, `app.emit("db:changed",
     DbChanged { tables })`.

  Step 4's decision is a pure function and is what the tests pin. **With one window open nothing is
  ever emitted**, so a single-window session is byte-for-byte today's.
- **Over-marking is accepted.** A rolled-back write still set its bits, exactly as the mirror's mask
  does; the cost is one refetch of data that did not change.

### One table list, both sides

The user tables live in **one committed file**, `src/lib/userTables.json`. A Rust test asserts it
equals `main.sqlite_master`'s tables and `changes.rs`'s index list; TypeScript imports it, and the
table→query map is typed `Record<UserTable, …>` over its entries — so a migration that adds a table
is a red Rust test, and a table nobody mapped is a `tsc` error. This is the same shape as the export
golden corpus: one committed file, both suites asserting against it.

### TypeScript: `useCrossWindowRefresh`

- Mounted **once** in `AppShell`, beside `useDeviceSyncInvalidation` (`AppShell.tsx:248`), and
  built the way that hook is: `ipc.onDbChanged`, the module-level `queryClient`.
- On `db:changed`, collect the query keys every listed table maps to, dedupe, and
  `invalidateQueries({ queryKey }, { cancelRefetch: false })`. The writing window hears its own
  event too; it has already invalidated, and `cancelRefetch: false` makes the second invalidation
  join that fetch rather than cancel and restart it.
- The map lives beside `OWNED_WRITE_KEYS` in `src/lib/query.ts`. `collection_entries`, for one,
  maps to exactly `OWNED_WRITE_KEYS`, because that is already the list a collection write owes.

### `app_meta`: which rows follow

The hook sees the table, not the row, so `app_meta` maps to a **fixed list of keys that follow
live**, and every key not on it stays per window:

| Follows live | Stays per window |
| --- | --- |
| `START_VIEW_KEY`, `HOME_LAYOUT_KEY`, `["scanner","prefs"]`, `["scanner","tray"]`, `MARKETPLACE_KEY`, the mark colours, `["recentCards"]` | card zoom, list/grid, flatten, `NAV_COLLAPSED_KEY`, `SEARCH_OPEN_KEY`, the folder pane, deck sort, the deck search panel, `PRINTING_GROUP_BY_KEY` |

Refetching the follow-live keys is what closes the whole-value race: every window writes the home
layout, the scanner tray and the scanner prefs **from fresh data**. A view-pref write in one window
still triggers the `app_meta` entry; the follow-live keys refetch to the same values and the
per-window keys are untouched, which is the point.

⚠️ **A setting whose local setter runs follow-on work must run it on a refetch too.** Changing the
marketplace in window A calls `invalidatePricedQueries` in A (`useMarketplace.ts:163`); window B
only refetches `MARKETPLACE_KEY`, and its priced queries would go on showing the old marketplace. So
a follow-live hook with follow-on work runs it when its value **changes**, whoever changed it. The
plan's census of the follow-live keys decides which others carry work; the marketplace is the one
known today.

---

## 5. The remaining one-window assumptions

1. **Snap hover.** `onSnapHover` switches from the global `listen` to
   `getCurrentWebviewWindow().listen(…)`, so a hover over one window's maximize button lights only
   that window's. It is the only window-targeted event the page listens to; everything else the app
   emits is meant for every window.
2. **Restart to finish.** When `useWindowCount() >= 2`, the Update panel's "Restart to finish"
   button carries a hint that it closes all *N* windows. No dialog — the button is already the
   second, deliberate press (`UpdatePanel.test.tsx:85`). One window comes back after the restart;
   restoring the rest is out of scope.
3. **The card scanner is owned by one window.** `ScannerState` gains an owner: the label of the
   window whose scanner view claimed it, supplied by Tauri to the commands. A second window's
   scanner view shows **"The scanner is open in another window"** and nothing else — no takeover.
   Ownership is released when the owning view unmounts, when its window is `Destroyed`, and when a
   window's page loads (a reload runs no unmount, so without this a reload could strand the lock).
   The pairing QR scanner is short-lived and unaffected; every window has the camera grant (§3).
4. **Deck undo** needs no change. The cursor is per deck in the database, the redo stack is per
   window, a stale redo is refused, and the undo button refreshes through §4. Ctrl+Z in either
   window undoes that deck's most recent change, which is what one deck with two views should mean.

---

## 6. Dev tooling and documentation

- **`scripts/cdp.mjs` picks the first `page` in `/json/list`** (`cdp.mjs:46`); every window has the
  same URL and title, so with two open it drives an arbitrary one. It gains a `pages` command that
  lists targets, a `CDP_PAGE` override, and a stderr warning when it had to choose among several.
- **The Storybook fake** gains `window_new`, `window_count`, `db:changed` and the scanner's
  "open elsewhere" answer.
- **⚠️ A second launch now opens a window in the *running* app.** A worktree B dev build launched
  while worktree A's app is up exits 0 exactly as before — but A now opens a new window **showing
  A's frontend**, which is a worse lie than no window. The lock still prevents it; the
  `running-the-app` skill, `lock.ps1`'s header and the portable-copy line in the root `CLAUDE.md`
  must all say so.
- **A reference doc**, `docs/reference/multi-window.md`, with a row in the root `CLAUDE.md` table.

---

## 7. Testing

### Rust

- **`changes.rs`**: the index list equals `userTables.json` equals `main.sqlite_master`; every
  `WITHOUT ROWID` user table is on exactly one side of the explicit-mark decision; a write through
  the hooked connection sets its table's bit; a corpus write sets none; `take` clears; muting a tag
  sets `muted_tags`.
- **The emit decision**: bits and a window count in, emit or not out.
- **Placement**: the cascade and its clamp, beside `opening_size`'s tests.
- **Scanner ownership**: claim; refusal from another label; release on unmount, on `Destroyed`, on
  page load.

### TypeScript

- The table map: an `app_meta` change **never** invalidates a per-window key and **does**
  invalidate every follow-live key. `tsc` covers "every table is mapped".
- `useCrossWindowRefresh`: an event invalidates the mapped keys with `cancelRefetch: false`.
- The marketplace follow-on work runs on a refetched change.
- `newWindow` is in the catalogue and the key map on desktop, and absent on web and Android.
- `onSnapHover` listens on its own window.
- The Update panel's hint appears at two windows and not at one.
- The scanner's "open in another window" state, as a story and a test.
- **Mutate, then run** — for the `app_meta` split and the table map, break the code and watch the
  test go red; a green suite is not the evidence.

### In the window, under the app lock

1. Ctrl+Shift+N opens a sized, cascaded window; launching the exe again opens another.
2. The same deck open in both: an edit in window 1 appears in window 2 without clicking into it. A
   collection add moves the Owned badge on window 2's search results.
3. Zoom in window 1 leaves window 2 alone. A marketplace change in window 1 re-prices window 2. A
   home-layout edit shows in both.
4. With one window open, `db:changed` is never emitted — counted by a listener over CDP.
5. Snap hover lights only its own window — verified with Win32, since CDP cannot see the frame.
6. Closing the original window leaves the other running; closing the last exits, and the exit push
   and checkpoint ran (`user.db-wal` truncated).
7. Scanner open in window 1: window 2 says so. Close window 1: window 2 scans.

---

## 8. Out of scope

- **Opening a window onto a given deck or view**, and an "Open in new window" menu item. Decision 1
  leaves navigation to the reader; the shell has no URL to open onto.
- **Restoring windows across a restart**, including the update restart.
- **Per-window titles** — every window is "MTG Grimoire"; the taskbar thumbnail tells them apart.
- **Two processes on one data folder**, and **two worktrees' dev apps at once.** §1 is why the first
  stays refused; the second stays behind the one-app lock by choice.
- **A caption-bar button** for a new window.
- **Android and the web target.** Android runs one task per application; a second browser tab is
  still "first tab wins" (`docs/superpowers/specs/2026-08-27-cross-platform-parity-matrix.md`).
