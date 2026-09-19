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

A `window_count` command, and **no event**. Its one reader is the Update panel's hint (§5), a
panel a reader has open for seconds, so `useWindowCount()` polls it every two seconds while mounted
rather than the app growing a `windows:changed` event and two emit sites for it. The refresh gate
(§4) asks `app.webview_windows().len()` directly. On the web target the command is not routed, so
the hook answers `1` without asking.

---

## 4. Cross-window refresh

**Rust supplies the fact — which user tables a commit wrote. TypeScript draws the conclusion — which
queries that makes stale.** The repository's standing boundary, applied.

### Rust: `changes.rs`

- **The mask.** `Changes`: an `AtomicU64`, one bit per table in the **user** database, indexed by
  the user side of `schema::TABLES` — built and sorted once, in `Changes::new`, so the hook itself
  only reads it. `mark(db, table)` ignores anything not in `main`, finds the bit by binary search and
  does one `fetch_or`. No allocation, no lock, no call back into SQLite — the constraints
  `mirror/watch.rs`'s module doc already states for a hook. It lives on `AppState` beside `mirror`,
  gated the same way.
- **Riding the existing hook.** SQLite allows one update hook per connection, so the hook's closure
  calls `changes.mark(db, table)` beside `marker.note(db)` and the mirror's `mask.mark`. It is a new
  `install_hook_with_changes`, and `install_hook` keeps its signature by delegating with a throwaway
  `Changes` — `install_hook` has nineteen callers and eighteen of them are test fixtures that have no
  use for the mask. The corpus never sets a bit, so a Scryfall ingest, a feed refresh or a tag
  download emits nothing.
- **The six tables the hook cannot see.** `update_hook` does not fire for `WITHOUT ROWID` tables,
  and six user tables are: `muted_tags`, `sync_devices`, `sync_state`, `sync_peers`,
  `device_names`, `price_snapshots`. Their write sites are dozens of functions that take a bare
  `&Connection`, so a mark there would thread `Changes` through modules that have no business with
  it. **The mark is at the command instead**, after its write has committed — which is also the
  only place a *reader's press* reaches these tables at all:
  - `muted_tags` — `tag_mute` and `tag_unmute`;
  - `sync_devices` and `device_names` — `sync_device_rename`;
  - `sync_state` — `sync_patreon_claim` and `sync_group_leave`. **The first draft listed it as
    written only by the app, and that was wrong**: it is also a sync cursor and a token cache the
    app rewrites on every trip, but Connect and Leave are presses that change what the Sync panel
    draws, and a second window's panel would otherwise stay on the old membership;
  - `price_snapshots`, `sync_peers` — **not marked**: the app writes them itself (a day's prices, a
    peer watermark) and no window's press does, so no window is behind another about them.

  A test enumerates every `WITHOUT ROWID` table in `main.sqlite_master` against those two lists, so
  a seventh goes red until somebody decides.
- **The wake.** `Changes` carries its own `tokio::sync::Notify`. The existing commit hook
  (`mirror/watch.rs:254`) rings it **only when a bit is set**, so a Scryfall ingest's thousands of
  corpus commits wake nothing; a command's explicit mark rings it itself. `notify_one` stores at
  most one permit, so a commit storm is one wake.
- **The emitter.** A task spawned in `start()`, desktop only:
  1. await `changes_wake`, then sleep **50 ms** so a burst of commits is one event;
  2. **take the bits while holding the write lock** (`db::lock_for`, `WRITE_LOCK_WAIT`) — the commit
     hook fires *before* the commit is durable, and the commit happens under that mutex, so holding
     it proves the commit that rang has finished. **The take happens under the lock, not after it**,
     and the first draft had it after: a transaction that began in the gap between the drop and the
     take would have its bit taken before its own commit, and that commit would then find nothing
     pending and ring nothing — a write no other window ever hears about. On timeout, take anyway.
     Taken always, even with one window, so nothing stale is waiting when a second one opens;
  4. if the bits are non-zero **and** `app.webview_windows().len() >= 2`, `app.emit("db:changed",
     DbChanged { tables })`.

  Step 4's decision is a pure function and is what the tests pin. **With one window open nothing is
  ever emitted**, so a single-window session is byte-for-byte today's.
- **Over-marking is accepted.** A rolled-back write still set its bits, exactly as the mirror's mask
  does; the cost is one refetch of data that did not change.

### One table list, both sides

The user tables live in **one committed file**, `src/lib/userTables.json`. A Rust test asserts it
equals the user side of `schema::TABLES`, which is what `Changes` indexes; a Vitest test asserts the
table→query map's keys equal it. So a migration that adds a table is a red Rust test, and a table
nobody mapped is a red Vitest test. **Not a `tsc` error, and this corrects the first draft**: a
JSON import types as `string[]`, so a `Record` over its entries is a `Record<string, …>` and checks
nothing. This is the same shape as the export golden corpus: one committed file, both suites
asserting against it.

### TypeScript: `useCrossWindowRefresh`

- Mounted **once** in `AppShell`, beside `useDeviceSyncInvalidation` (`AppShell.tsx:248`), and
  built the way that hook is: `ipc.onDbChanged`, the module-level `queryClient`.
- On `db:changed`, collect the query keys every listed table maps to, dedupe, and
  `invalidateQueries({ queryKey }, { cancelRefetch: false })`. The writing window hears its own
  event too; it has already invalidated, and `cancelRefetch: false` makes the second invalidation
  join that fetch rather than cancel and restart it.
- The map lives in `src/lib/crossWindow.ts`, beside `query.ts`, and each table's entry is **the
  union of what that table's own mutations already invalidate** — `collection_entries`, for one,
  maps to exactly `OWNED_WRITE_KEYS`, because that is already the list a collection write owes.
- **Every invalidation carries a predicate that spares the per-window keys**, and the prefix match
  is why it has to. **The predicate is the second fence, and the first is that no per-window key
  sits under a root any table maps to** — a Vitest test fails one that does. This amends the first
  draft, which put deck sort at `["decks", "sort"]` and relied on the predicate alone: the predicate
  guards this refresh, but the *writing* window's own invalidations carry none, so every deck write
  a window made re-read the `deck_sort` row, which with two windows holds whichever window pressed
  last. Deck sort is `DECK_SORT_KEY`, `["deckSort"]`, off that root; nothing had depended on the
  prefix (a data reset leaves the row alone and no invalidation named the key), and a press now
  writes the cache as well as the row, so a gallery coming back after opening a deck draws the
  press rather than the launch read.
- **⚠️ A read that writes is a refresh loop, and the writing window is inside it.** Every window —
  the writer included — refetches on the event, so a query whose command writes the table its own
  key is refreshed by writes, emits, refetches and writes again, forever. `share_list` is one: it
  reconciles `collection_shares` against the relay on every read, so **`collection_shares` maps to
  nothing**, and a second window's share badges catch up on its own next read. An audit of every
  query's command on 2026-09-19 found no other; two reads write once and settle
  (`sync_pairing_status` minting the identity, the scanner's stale-folder correction). A new
  command that writes on read must be checked against this map before it ships.

### `app_meta`: which rows follow

The hook sees the table, not the row, so `app_meta` maps to a **fixed list of keys that follow
live**, and every key not on it stays per window:

| Follows live | Stays per window |
| --- | --- |
| `START_VIEW_KEY`, `HOME_LAYOUT_KEY`, `MARKETPLACE_KEY`, `MARK_COLORS_KEY`, `RECENT_CARDS_ROOT`, `["decks","lastFormat"]`, `MIRROR_KEY` — and `["scanner","prefs"]`, `["scanner","tray"]` as `SINGLE_WRITER_KEYS`, below | card zoom, list/grid and flatten (store state seeded once at launch, never a query), `NAV_COLLAPSED_KEY`, `SEARCH_OPEN_KEY`, `FOLDER_PANE_KEY`, `DECK_SORT_KEY` (`["deckSort"]`, off the `["decks"]` root — below), `DECK_SEARCH_TAB_KEY`, `PRINTING_GROUP_BY_KEY` |

Refetching the follow-live keys is what closes the whole-value race: every window writes the home
layout, the scanner tray and the scanner prefs **from fresh data**. A view-pref write in one window
still triggers the `app_meta` entry; the follow-live keys refetch to the same values and the
per-window keys are untouched, which is the point.

**⚠️ The scanner's two keys are single-writer, and refetching them where they are live loses
cards.** `useTray` holds scanned cards in its cache and writes them 400 ms after scanning pauses; a
refetch inside that gap — and *any* `app_meta` write triggers one, the scanning window's own
included — replaces the cache with the older stored rows, and the pending write then stores those.
The lease (§5) guarantees only the owning window has these queries active, so on an `app_meta`
change an **active** `["scanner","tray"]` / `["scanner","prefs"]` query is left alone entirely, and
an **inactive** one is *removed* — a window that later takes the lease reads fresh from scratch
rather than drawing stale rows while a background refetch runs.

**An inactive one is removed only when its hook reports nothing unsaved** (ruled 2026-09-19,
amending the paragraph above). An idle entry is also where a card waits out a write the view left
behind: leave the Scanner during a sync, the unmount's flush answers `BUSY`, and dropping the entry
then either loses the card or hands the pending retry nothing, so it stores `[]` or the default
prefs over the row. So `crossWindow.ts` keeps a small registry, `registerUnsavedCheck(key, check)`,
which `useTray` and `useScannerPrefs` fill at module load — `lib` imports nothing from `features` —
and the removal skips a key whose check says unsaved. Such an entry is left exactly as it is: not
removed, and not invalidated either, since an invalidated idle query refetches on its next mount.
**"Unsaved" is a write queued, on the wire, or waiting to retry — or the newest write refused with
nothing landed since** (the last term ruled in on review, 2026-09-19). **And a write refused by a
sync or by another window's lease is retried until it lands** (§5 item 3): every
`TRAY_RETRY_MS` / `PREFS_RETRY_MS` (1.5 s, under the two-second lease), stopping only when a write
lands, a newer change takes the tries over, or the cache entry is gone. So through a first sync
that runs for minutes the first two terms stay true on their own, and every try renews the lease —
the window with unsaved cards keeps the scanner until they are stored, and no second window can
open a tray read from a row about to change under it. The first draft of this paragraph recorded
the opposite as an accepted cost — retries exhausted after one more try, the lease lapsing, another
window storing a tray, and this window's kept entry writing over it — and the retry loop is what
closes it. **What remains, stated precisely**:
- **Process death** before a write lands loses the unsaved cards, as it always did.
- **A refusal that no wait changes** — a tray row of nothing, a tray past its limit — gets one more
  try and no loop, because retrying it forever would hold the lease for good. Its rows stay unsaved
  (the third term keeps the entry), the lease lapses, and if another window then stores a tray this
  window's next change writes over it. The page cannot produce either refusal today.
- **A gap longer than the lease between two tries** — a hidden window whose timers the webview
  throttles past two seconds — lets the lease lapse while a write is still owed. Unmeasured.

**Retries never write what is not there**: every write reads the cache as it goes out, and a
missing entry skips the write and ends the tries.

**A marketplace change needs no follow-on work, and the first draft said it did.** Every
price-bearing query carries the marketplace **in its key** (`src/CLAUDE.md`), so once window B's
`MARKETPLACE_KEY` refetches, B's priced queries are *new* keys and fetch on their own.
`invalidatePricedQueries` exists for the other case — a feed refresh that rewrites prices under an
unchanged key — and that already reaches every window, because `marketplace:progress` is an
`app.emit`.

---

## 5. The remaining one-window assumptions

1. **Snap hover.** `onSnapHover` switches from the global `listen` to
   `getCurrentWindow().listen(…)`, so a hover over one window's maximize button lights only that
   window's. `getCurrentWindow` rather than `getCurrentWebviewWindow` because
   `@tauri-apps/api/window` is the specifier `.storybook/main.ts` and the tests already alias to a
   fake; a new specifier would reach the real module from every story. It is the only
   window-targeted event the page listens to; everything else the app emits is meant for every
   window.
2. **Restart to finish.** When `useWindowCount() >= 2`, the Update panel's "Restart to finish"
   button carries a hint that it closes all *N* windows. No dialog — the button is already the
   second, deliberate press (`UpdatePanel.test.tsx:85`). One window comes back after the restart;
   restoring the rest is out of scope.
3. **The card scanner is held by one window, as a lease the window using it keeps renewing.**
   `ScannerState` gains an owner: a window label and the moment it last admitted a command. Every
   command that *uses* the scanner takes the calling webview from Tauri and is admitted only if the
   lease is free, already theirs, or **older than two seconds**; otherwise it refuses with
   `OPEN_ELSEWHERE`, *"The scanner is open in another window."* A new `scanner_elsewhere` answers
   the same question without taking the lease. A second window's scanner view asks it, shows that
   sentence and nothing else — no camera, no tray, no takeover — and asks again each second until
   the lease lapses.
   **The lease means "this window is using the scanner", and three things renew it** (ruled
   2026-09-19, amending the first draft's "a lease the frames renew"):
   - **A heartbeat while the view is mounted.** `scanner_hold(webview)` admits and does nothing
     else; `LiveScanner` calls it on mount and every `SCANNER_ELSEWHERE_POLL_MS` (one second) while
     mounted, and clears the interval on unmount. Frames alone were not enough: a view whose camera
     was starting slowly, refused or failed sent none, so its lease lapsed in two seconds and a
     second window got through the gate with the first one's tray still live — each writing the
     tray whole over the other, and an Add in the stale one filing committed rows twice. The first
     filter push also took the lease before the camera was live, so a camera start over two
     seconds could hand the scanner back and forth between two windows on the Scanner view. **Every**
     refused beat re-asks the gate (invalidates `SCANNER_ELSEWHERE_KEY`), not only the first of a
     run.
   - **The four session commands** — `scanner_frame`, `scanner_capture`, `scanner_reset`,
     `scanner_set_filters` — as before.
   - **Every tray and prefs write.** `set_scanner_prefs`, `set_scanner_tray` and
     `scanner_tray_commit` take the webview and admit before they touch the database, so a window
     whose pending or retrying writes have not landed keeps the scanner until they do, and another
     window meanwhile sees the sentence. The reads — `scanner_prefs`, `scanner_tray`,
     `scanner_status` — stay ungated. A write refused with `OPEN_ELSEWHERE` is treated like `BUSY`:
     the hook keeps its rows, never reverts, never writes defaults, never drops rows — and **both
     refusals are retried until the write lands**, once every `TRAY_RETRY_MS` / `PREFS_RETRY_MS`
     (1.5 s, which is what keeps it under the two-second lease), never faster, stopping only when
     a write lands, a newer change takes the tries over, or the cache entry is gone. Every try goes
     through the lease-gated command, so it renews the lease: a window with unsaved cards holds the
     scanner through a sync of any length. `verdictText.ts`' `refusalPasses` is the test, and its
     `DB_BUSY` is pinned against `db.rs`. Any other refusal — the tray's two, which no wait changes —
     gets one more try and no loop, since a loop there would hold the lease for good.
   **A lease rather than a claim/release pair, and this reverses the first draft.** Claim on mount
   and release on unmount looks simpler and is not: Tauri gives no ordering guarantee between two
   IPC calls, and `main.tsx`'s `StrictMode` mounts every effect twice in development, so
   *claim, release, claim* can arrive as *claim, claim, release* and leave a mounted scanner owning
   nothing. A reload runs no unmount at all, so a claim also needed a page-load hook, and a closed
   window a `Destroyed` hook. A lease the view renews needs none of the three: the heartbeat, the
   frames and the writes all stop when the view leaves, reloads or closes, and two seconds later
   the lease is free. The pairing QR scanner is short-lived and unaffected; every window has the
   camera grant (§3).
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

- **`changes.rs`**: `userTables.json` equals the user side of `schema::TABLES`; every
  `WITHOUT ROWID` user table is on exactly one of the two lists; a write through the hooked
  connection sets its table's bit and rings; a corpus write sets none and rings nothing; `take`
  clears; `mark_table` sets and rings.
- **The emit decision**: tables and a window count in, emit or not out.
- **Placement**: the cascade and its clamp, beside `opening_size`'s tests.
- **Scanner lease**: a free lease is taken; the holder is re-admitted; the holder's own admissions
  renew it (taken at t0, renewed at t0 + 1.5 s, still refusing another label at t0 + 2.5 s);
  another label is refused inside two seconds and admitted after; `elsewhere` never takes the
  lease; the refusal is exactly `OPEN_ELSEWHERE`.

### TypeScript

- The table map: every user table is mapped (Vitest, against the JSON); an `app_meta` change
  **never** invalidates a per-window key and **does** invalidate every follow-live key; no
  per-window key sits under a root any table maps to, so a deck write — this window's or another's
  — does not refresh `DECK_SORT_KEY`; an idle tray or prefs whose hook reports something unsaved is
  kept, and dropped once it reports nothing.
- `useCrossWindowRefresh`: an event invalidates the mapped keys with `cancelRefetch: false`.
- `newWindow` is in the catalogue and the key map on desktop, and absent on web and Android.
- `onSnapHover` listens on its own window.
- The Update panel's hint appears at two windows and not at one.
- The scanner's "open in another window" state, as a story and a test; the mounted view's
  heartbeat (on mount, once a poll, stopped on unmount, every refused beat re-asking the gate); the
  gate's recovery poll opening the live view once the lease lapses; a tray or prefs retry that finds
  its entry gone writing nothing; a tray or prefs write refused by a sync (or the lease) through
  seven tries, once an interval and never sooner, kept through another window's refresh after each,
  landing once the refusal clears and sending nothing after; any other refusal getting one more try
  only; and a newer change taking the tries over without a second loop.
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
