# More than one window onto one collection

`docs/superpowers/specs/2026-09-19-multi-window-design.md` is the design, amended through
implementation; this page is the record of what shipped — the reasoning at each site, and the live
pass that settled what neither suite can see. **Every figure below was taken on 2026-09-20, on a
debug build under `npm run tauri dev`**, unless its own line says otherwise; the spec's own
measurements were read off the source at `13dba8c2` against the crates `Cargo.lock` resolves
(tauri 2.11.5, tauri-plugin-single-instance 2.4.3, tauri-plugin-snap-layout 1.0.9, wry 0.55.1,
`@tanstack/query-core` 5.101.4).

The short version, and it is the whole design in four sentences. **Windows, not processes**: the
single-instance guard stays exactly where it was, and its callback opens a window instead of
bringing one forward. **Rust says which user tables a commit wrote and TypeScript decides what that
makes stale**, over a `db:changed` event emitted only while two or more windows are open. **View
preferences stay per window; data and Settings follow live.** **One window scans at a time**, held
by a lease it keeps renewing.

## 1. Why a second *process* stays refused

`tauri-plugin-single-instance` is registered before every other plugin, keys on
`app.config().identifier` and nothing else, and a second process finds the first one's hidden
message window, hands it `cwd|args` over `WM_COPYDATA` and calls `std::process::exit(0)` — no
window, no stderr. That has not changed and must not: **SQLite copes with two processes and nothing
above it does.**

| Hazard | Where |
| --- | --- |
| Fixed temp paths a peer truncates or appends into mid-ingest | `tmp/default-cards.jsonl.gz`, the tag, price and combo temps, `updates/{asset}.part` |
| A launch drops the peer's staging table | `DROP TABLE IF EXISTS corpus.cards_staging` |
| Launch-time file deletion and a migration ladder read outside a transaction | `schema::prepare_data_dir`, `schema::migrate_user` |
| Every "already running" guard is process memory | `syncing`, the three feeds' `REFRESHING`, the updater's `busy`, Scryfall's 429 penalty |
| Caches nothing invalidates across processes | the facet index generation, owned counts, every webview's query cache |
| A second mirror writer, non-atomic writes | `mirror/run.rs` |
| A new instance deletes the running one's staged update | `update::clean_up` |

**A window in the same process shares `AppState`, the one write connection, the one set of
background services, the mirror, live sync and the updater — so every row of that table stops being
a question rather than being answered.** That is the decision everything below rests on, and it is
also why "let two worktrees run their dev apps at once" was weighed and **refused**: the one-app
lock in `.claude/skills/running-the-app/` stays the answer there.

⚠️ **The consequence that bites a developer rather than a reader.** A second launch no longer exits
quietly with nothing to show for it — it opens a window **in the running app**. Launch worktree B's
dev build while worktree A's app is up and B still exits 0, exactly as before, but A now opens a new
window **showing A's frontend**: a window that looks like yours, rendering somebody else's branch.
That is a worse lie than no window at all. The lock still prevents it; the `running-the-app` skill,
`lock.ps1`'s header and the root `CLAUDE.md` all say so.

## 2. Opening, sizing and closing

**One function opens every window after the first** — `window::open_new(app, from)`, behind both
ways in. It clones `app.config().app.windows[0]` and gives the clone a new label, so the new window
is hidden, undecorated, minimum-sized, `dragDropEnabled: false` and shadowed exactly as `main` is,
with no second declaration of any of that. Labels are `window-2`, `window-3`, … from a monotonic
`AtomicU32` that starts at two; **a closed window's label is never reused**, so a label is a name
for a window rather than for a slot.

⚠️ **Never call it synchronously from a command or an event handler.** Tauri's own doc on
`WebviewWindowBuilder` says building a window on Windows "deadlocks when used in a synchronous
command or event handlers". The single-instance callback runs inside the plugin's window procedure,
so it **spawns** onto `tauri::async_runtime`; `window_new` is an `async` command for the same
reason.

**Sizing is `opening_size`'s two rungs, unchanged and now shared.** `open_sized_to_monitor` takes a
`&WebviewWindow` rather than looking up `"main"`, so the first window and every later one climb the
same ladder — the largest of 1920×1080 and 1280×720 the monitor's *work area* holds, `CHROME`
subtracted. What differs is only where the window is put: `open_sized_to_monitor` centres, and
`open_new`'s `place` cascades.

**`cascade` puts a new window `OFFSET` (32 logical px) down and right of `from`, and starts again at
the work area's edge on whichever axis would overflow** — an axis at a time, so a window near the
right edge drops to that edge's x and keeps its cascaded y. With no `from` it centres.

⚠️ **The position is set in *physical* pixels, converted with the scale it was derived with.** A
`LogicalPosition` would be converted by the **new** window's scale factor, and a window Tauri has
just built sits wherever Windows put it — so on a desk whose monitors scale differently, a point
read off a 150% monitor and handed back at 100% lands on the wrong monitor. Monitor coordinates are
physical; the physical point is the one that means the same thing to both windows. Where every
monitor shares one scale the two spellings agree, which is why nothing on this machine could have
found it.

**The two ways in.**

- **Relaunching the exe** — the Start menu, a shortcut, a middle-click on the taskbar icon. The
  single-instance callback opens the window beside `window::focused(app)`: whichever window has
  focus, else any. `focus_existing_window` is **deleted**. It works during startup too: a window
  needs no `AppState` to exist, and its page waits on `startup_status` like the first one.
- **Ctrl+Shift+N** — a `newWindow` row in `src/lib/shortcuts.ts`'s `global` group, which puts it in
  the F1 key map with no further work, and `desktopOnly: true`, so the web and Android builds
  neither bind it nor list it. See [keyboard-shortcuts.md](keyboard-shortcuts.md).

**Permissions are a glob.** `capabilities/desktop.json` is `"windows": ["main", "window-*"]` —
capability labels accept them — so every label `open_new` mints is granted what `main` is. Without
it a second window gets no `core:` at all, which means `listen` rejects and `core/tauri.ts` swallows
the rejection: a window that draws and hears nothing. `mobile.json` is untouched.

**Closing needed one edit and it was a doc comment.** Tauri's default already is the decision:
closing a window destroys it, and `RunEvent::ExitRequested` arrives only when the last one goes — so
the exit push and the WAL checkpoint run exactly once, at the real exit. `closeWindow`'s comment in
`src/lib/window.ts` said it "ends the process"; it says *the app ends when its last window closes*
now.

**Window count is a command and deliberately not an event.** `window_count` answers
`app.webview_windows().len()`; its one reader is the Update panel's hint, a panel a reader has open
for seconds, so `useWindowCount()` polls every two seconds while mounted rather than the app growing
a `windows:changed` event and two emit sites to keep in step with it. The refresh gate asks
`app.webview_windows().len()` directly. The web build does not route the command, so the hook
answers `1` without asking.

## 3. The change mask and the emitter

**Rust supplies the fact — which user tables a commit wrote. TypeScript draws the conclusion — which
queries that makes stale.** The repository's standing boundary, applied to a fifth data path.
`src-tauri/src/changes.rs` is the Rust half.

**The mask.** `Changes` is an `AtomicU64`, one bit per table on the **user** side of
`schema::TABLES`, sorted once in `Changes::new` so the hook itself only reads it (and asserting the
list fits in 64 bits, which is what a 65th user table would go red on). `mark(db, table)` ignores
anything that is not `main`, finds the bit by binary search and does one `fetch_or` — no allocation,
no lock, no call back into SQLite, which are the constraints `mirror/watch.rs`'s module doc already
states for a hook. **The corpus never sets a bit**, so a Scryfall ingest, a feed refresh or a tag
download emits nothing.

**It rides the existing hook rather than adding one.** SQLite allows exactly one update hook per
connection, so a second `install_hook` would **replace** the mirror's rather than join it: the
closure calls `changes.mark(db, table)` beside `marker.note(db)` and the mirror's own `mask.mark`.
`install_hook_with_changes` is the full form and `install_hook` keeps its signature by delegating
with a throwaway `Changes`, because almost every one of its callers is a test fixture with no use
for the mask.

**The two blind spots, and a command marks by hand for each.**

- **`WITHOUT ROWID` tables — the hook never fires for them.** Their write sites take a bare
  `&Connection` in modules that have no business with this mask, so the mark is made by the *command*
  a reader's press reaches, after its write: `muted_tags` from `tag_mute`/`tag_unmute`,
  `sync_devices` and `device_names` from `sync_device_rename`, `sync_state` and `sync_devices` from
  `sync_patreon_claim` and `sync_group_leave`. `price_snapshots` and `sync_peers` are deliberately
  **not** marked — the app writes them itself (a day's prices, a peer watermark) and no window's
  press does, so no window is behind another about them. `changes::MARKED_BY_COMMAND` and
  `WRITTEN_BY_THE_APP` are the two lists, and a test enumerates `main.sqlite_master` against them, so
  a new `WITHOUT ROWID` table goes red until somebody decides.
  **`sync_state` was on the wrong list in the first draft**, which said the app alone writes it. It
  does write it — the pull cursor, the token cache — but *Connect Patreon* and *Leave group* are
  presses that change what the Sync panel draws, and a second window's panel would otherwise stay on
  the old membership. Both commands mark **whatever their outcome**: each can answer `Err` over a
  write that already committed, and over-marking costs one refetch.
- **A bare `DELETE FROM t` with no `WHERE`** is SQLite's truncate optimisation: it visits no row and
  the hook is documented not to fire. **Nothing enumerates this one** — whether a statement carries a
  `WHERE` is a fact about a call site, not about the schema — so the sweep was done by hand on
  2026-09-19 and two presses reach it: `error_log_clear` marks `error_log`, and `sync_group_leave`
  also marks `sync_group` and `sync_devices`. Triggers and foreign keys both switch the optimisation
  off, which is why the Danger Zone clears in `reset.rs` are seen; a `mirror/watch.rs` test runs them
  to prove it, and another pins the blind spot itself on `error_log`. **A new unconditional `DELETE`
  a press reaches owes the same check.**

**`mark_table` refuses a name the mask does not know, in a debug build.** The hook must ignore
tables that are not the reader's, so `mark` cannot refuse — but a command names its table by hand,
and a misspelt one would set no bit, ring anyway, and tell the emitter there was nothing to say,
with nothing going red anywhere.

**The wake.** `Changes` carries its own `tokio::sync::Notify`. The existing commit hook rings it
**only when a bit is set**, so the thousands of corpus commits a Scryfall ingest makes wake nothing;
a command's explicit mark rings itself, because the commit hook saw no bit for it. `notify_one`
stores at most one permit, so a commit storm is one wake.

**The emitter** is a task spawned in `start()`, desktop only. It awaits the ring, sleeps `COALESCE`
(50 ms) so a burst is one event, takes the bits, and emits `db:changed { tables }` if
`should_emit` — the bits are non-zero **and** two or more windows are open.

⚠️ **The take happens *under* the write lock, not after it, and that is the order of two lines.**
The commit hook fires *before* the commit is durable, and the commit happens under `state.db`'s
mutex, so holding it proves the commit that rang has finished. The second reason is the one the
first draft got wrong: a take made after the lock was dropped could land while the **next**
transaction is mid-write — its hook has set a bit, the take clears it, and that transaction's commit
then finds nothing pending and rings for nobody. In `take_settled` the guard is bound to `_held`
before the `take` and dropped after it; **no test here can see that property**, because
drop-then-take reads the same bits in every single-threaded test and loses them only when a writer
lands in the gap. Do not reorder it, and do not respell the binding `let _ = …`, which drops the
guard on the spot.

⚠️ **On timeout the emitter peeks rather than takes.** Whatever holds the lock past
`WRITE_LOCK_WAIT` may be a transaction whose bits are in the mask right now; clearing them would
leave its commit ringing for nobody. So the timeout arm says what is pending — a window refetching
early costs one read — and leaves the mask set, and the next locked take is the one that clears.
(The first draft took anyway, which cleared exactly that transaction's bit.)

**With one window open nothing is ever emitted**, so a single-window session's pages see exactly
what they saw before this module existed. What it costs is one uncontended mutex acquisition per
burst of user writes, on a blocking thread — and the take runs at one window as well as at two, so
nothing stale is waiting when a second window opens.

**Over-marking is accepted.** A rolled-back write still set its bits, exactly as the mirror's mask
does; the cost is one refetch of data that did not change.

## 4. The table map, and the fence around view preferences

**One committed file, both suites.** `src/lib/userTables.json` is the user table list: a Rust test
asserts it equals the user side of `schema::TABLES`, and a Vitest test asserts the table→query map's
keys equal it. So a migration that adds a table is a red Rust test, and a table nobody mapped is a
red Vitest test. **Not a `tsc` error** — a JSON import types as `string[]`, so a `Record` over its
entries is a `Record<string, …>` and checks nothing. Same shape as the export golden corpus: one
committed file, both suites asserting against it.

`src/lib/crossWindow.ts` is the map, and **each table's entry is the union of what that table's own
mutations already invalidate in the window that made them** — so the second window refreshes exactly
what the first one did, rather than a second opinion about it. `useCrossWindowRefresh` is mounted
**once**, in `AppShell`, beside `useDeviceSyncInvalidation` and built the same way: an `ipc`
subscription over the module-level `queryClient`.

**`cancelRefetch: false`**, because the writing window hears its own event too, after already
invalidating: this joins that fetch rather than cancelling and restarting it. The cost lands in the
*other* window — a read it already had in flight from before the commit is joined as well, and can
settle on pre-commit data that stays on screen until the next trigger.

⚠️ **A read that writes is a refresh loop, and the writing window is inside it.** Every window
refetches on the event, so a query whose command writes the table its own key is refreshed by
writes, emits, refetches and writes again, for ever. `share_list` is one: it reconciles
`collection_shares` against the relay on every read, so **`collection_shares` maps to nothing**, and
a second window's share badges catch up on its own next read. An audit of every query's command on
2026-09-19 found no other; two reads write once and settle (`sync_pairing_status` minting the
identity, the scanner's stale-folder correction). **A new command that writes on read must be
checked against this map before it ships.**

### `app_meta`: which rows follow, and which stay

The hook sees the table and not the row, so `app_meta` maps to a **fixed list of keys**, and
everything not on it stays where its window put it.

| Follows live | Stays per window |
| --- | --- |
| `["startView"]`, `["homeLayout"]`, `["marketplace"]`, `["markColors"]`, `["recentCards"]`, `["decks","lastFormat"]`, `["mirror"]`, `["scanner","trayCount"]` | `["navCollapsed"]`, `["searchOpen"]`, `["deckFolderPane"]`, `["deckSort"]`, `["deckSearchTab"]`, `["printingGroupBy"]` |

Card zoom, list/grid and flatten are on neither list because they are **store state seeded once at
launch, never a query**. Refetching the follow-live keys is what closes the whole-value race: every
window writes the home layout from fresh data rather than over another window's change.

**`["scanner","trayCount"]` follows because a second window is the only place the Scanner and the
home page's To review count are on screen together**, and a scan there is an `app_meta` write here;
it is safe to follow because `scanner_tray` is a plain `SELECT` that answers no write, and its key
sits *beside* `["scanner","tray"]` rather than under it, so the single-writer rule below never spares
it and it never touches the tray ([home-page.md](home-page.md) §15).

⚠️ **Two fences keep a view preference per window, and the first is the one that matters.** The
predicate on this refresh spares the per-window keys — but the *writing* window's own invalidations
carry no predicate, so **no per-window key may sit under a root any table maps to**, and a Vitest
test fails one that does. Deck sort was `["decks", "sort"]`, and every deck write a window made
re-read the `deck_sort` row, which with two windows holds whichever window pressed last. It is
`DECK_SORT_KEY` — `["deckSort"]`, off that root — and a press now writes the cache as well as the
row, so a gallery coming back after opening a deck draws the press rather than the launch read.

⚠️ **The scanner's two keys are single-writer, and refreshing them where they are live loses
cards.** `useTray`'s cache *is* the tray: it holds a card it has just scanned only there, and stores
the whole tray 400 ms after scanning pauses. Every `app_meta` write triggers a refresh — the
scanning window's own included — so a refetch inside that pause replaces the cache with the older
stored rows, and the pending write then stores *those*. Invalidating without refetching is no
escape: an invalidated live query refetches on the next focus. So `refreshForTables` leaves a
**live** `["scanner","prefs"]` / `["scanner","tray"]` alone entirely and **removes** an idle one — a
window that takes the lease later reads the stored row from scratch rather than drawing a stale tray
while a background refetch catches up. The lease (§5) is what makes that safe: only the owning
window has these queries.

⚠️ **An idle one is removed only when its hook reports nothing unsaved.** An idle entry is also
where a card waits out a write the view left behind: leave the Scanner during a sync, the unmount's
flush answers `BUSY`, and dropping the entry then either loses the card or hands the pending retry
nothing to write, so it stores `[]` or the default prefs over the row. `crossWindow.ts` keeps a
registry — `registerUnsavedCheck(key, check)`, which `useTray` and `useScannerPrefs` fill at module
load, because `lib` imports nothing from `features` — and such an entry is left exactly as it is:
not removed, and **not invalidated either**, since an invalidated idle query refetches on its next
mount. *Unsaved* is a write queued, on the wire, or waiting to retry, **or the newest write refused
with nothing landed since**.

**A marketplace change needs no follow-on work, and the first draft said it did.** Every
price-bearing query carries the marketplace **in its key**, so once window B's `["marketplace"]`
refetches, B's priced queries are *new* keys and fetch on their own.
`invalidatePricedQueries` is for the other case — a feed refresh rewriting prices under an unchanged
key — and that already reaches every window, because `marketplace:progress` is an `app.emit`.

## 5. The scanner is held by one window, as a lease

The process has one session and every window can open the Scanner view. So **every command that
*uses* the scanner takes the calling webview and is admitted only if the lease is free, already
theirs, or idle and older than `scanner::LEASE` (two seconds)**; otherwise it refuses with
`OPEN_ELSEWHERE`, *"The scanner is open in another window."* `scanner_elsewhere` asks the same
question and takes nothing; the three reads (`scanner_prefs`, `scanner_tray`, `scanner_status`) are
ungated. A second window's Scanner view draws that sentence and *"It opens here once that window
leaves the Scanner or closes."* — no camera, no tray, no takeover — and asks again every
`SCANNER_ELSEWHERE_POLL_MS` (one second) until the lease lapses.

**A lease the view renews, never a claim and a release — and this reverses the first draft.** Claim
on mount and release on unmount looks simpler and is not: Tauri gives no ordering guarantee between
two IPC calls, and `main.tsx`'s `StrictMode` mounts every effect twice in development, so *claim,
release, claim* can arrive as *claim, claim, release* and leave a mounted scanner owning nothing. A
reload runs no unmount at all, so a claim would also need a page-load hook, and a closed window a
`Destroyed` hook. A lease needs none of the three.

**Three things renew it, and the first is the correction that matters.**

- **A heartbeat while the view is mounted.** `scanner_hold` admits and does nothing else;
  `LiveScanner` calls it on mount and once a second while mounted. **Frames alone were not enough**:
  a view whose camera was starting slowly, refused or failed sent none, so its lease lapsed in two
  seconds and a second window got through the gate with the first one's tray still live — each
  writing the tray whole over the other, and an Add in the stale one filing committed rows twice.
  **Every** refused beat re-asks the gate, not only the first of a run.
- **The four session commands** — `scanner_frame`, `scanner_capture`, `scanner_reset`,
  `scanner_set_filters`.
- **Every tray and prefs write** — `set_scanner_prefs`, `set_scanner_tray`, `scanner_tray_commit`.
  They are not the session and they take the lease anyway, so a window whose writes have not landed
  keeps the scanner until they do.

⚠️ **An admitted command holds the lease until it *settles*, not from the moment it was let in.**
`admit` answers a `LeaseGuard` the command keeps alive across its whole body, the awaited
`spawn_blocking` included: while any guard is alive the lease is held **whatever its age**, and each
drop counts it out and re-stamps the lease, so the two seconds run from completion. What it
corrects: a tray write waits up to five seconds for the write connection before answering `BUSY`, so
a lease stamped at admission lapsed under the write at two, and a second window got through the gate
to read a tray about to change. The drop touches the lease only if it is still that window's — by
then another window can hold it only because this one's went idle and lapsed first, and a late
release must neither count down the new holder's commands nor move its clock — and it recovers a
poisoned lock rather than panicking.

**A refusal a wait can clear is retried until the write lands.** `verdictText.ts`'s `refusalPasses`
is the test: `db::BUSY` (pinned against `db.rs`) and `OPEN_ELSEWHERE` both pass, and the write goes
out again every `TRAY_RETRY_MS` / `PREFS_RETRY_MS` — **1.5 s after the last try answered**, which is
what keeps it under the two-second lease — stopping only when a write lands, a newer change takes
the tries over, or the cache entry is gone. So through a sync of any length the window with unsaved
cards holds the scanner without a gap. **Any other refusal gets one more try and no loop** — a tray
row of nothing, a tray past its limit, neither of which a wait changes — because retrying one for
ever would hold the lease for good; its rows stay unsaved, and the lease lapses two seconds after
that try settles. Retries never write what is not there: every write reads the cache as it goes out,
and a missing entry skips the write and ends the tries.

**What remains, stated precisely.** Process death before a write lands loses the unsaved cards, as
it always did — a command running when its window closes still settles and releases, and the lease
is free two seconds later. A gap longer than the lease between one try settling and the next going
out would let the lease lapse with a write still owed; **item 8 of the live pass is the measurement
that says hiding a window does not produce one on this build.** And a command that never settles
holds the scanner for good: the in-flight count has no age, by design. Every write is bounded
(`with_write` answers `BUSY` after five seconds), but a `spawn_blocking` that hung would keep every
other window on the sentence until the process exits. Nothing today is known to hang.

**Deck undo needed nothing.** The cursor is per deck in the database, the redo stack is per window, a
stale redo is refused (`MOVED_ON`), and the undo button refreshes through §4. Ctrl+Z in either window
undoes that deck's most recent change, which is what one deck with two views should mean.

## 6. The two other one-window assumptions

**Snap hover.** `onSnapHover` switches from the global `listen` to `getCurrentWindow().listen(…)`.
The plugin emits to **one window's label**, and a target-Any listener hears it — so with two windows
open, hovering one maximize button lit both. `getCurrentWindow` rather than
`getCurrentWebviewWindow` because `@tauri-apps/api/window` is the specifier `.storybook/main.ts` and
the tests already alias to a fake; a new specifier would reach the real module from every story. It
is the only window-targeted event the page listens to — everything else the app emits is meant for
every window.

**Restart to finish.** When `useWindowCount() >= 2`, the Update panel's button carries
*Restarting closes all N windows.* as an `aria-describedby` hint on a line of its own
(`order-last basis-full`, this repo's way of breaking a wrapping row). No dialog: the button is
already the second, deliberate press. One window comes back after the restart, and restoring the
rest is out of scope.

## 7. The live pass — debug, `npm run tauri dev`, 2026-09-20

Eight of the nine checks ran and passed; the update hint is **not run**, because no update was
staged — there was no `updates/` directory and Settings listed `0.26.0 · 2026-09-15 · installed`
with no Restart button anywhere. Its input was checked instead: with two windows open, `window_count`
answered **2**. **No bug was found in the feature.** The full report is
`.superpowers/sdd/2026-09-19-multi-window/live-pass-report.md`.

The desk: Windows 11 Pro 26200, one monitor 2560×1440, work area 2560×1392, DPR 1; the reader's real
data folder copied whole (341 collection cards, 5 decks, 102 wishlist, a corpus of
*118,609 cards · data from 2026-09-19*); head `569f7250`, tree clean throughout. **One process, pid
79620, for the whole pass.**

**Opening.** Ctrl+Shift+N put `window-2` at **(352, 184)** against `main`'s (320, 152) — exactly
+32, +32 — at the same 1920×1080. Relaunching the exe answered **exit code 0**, opened a third
window, and `Get-Process mtg-grimoire` still showed the one pid; repeated later with the same
result. **The minimized-anchor risk is closed**: with `main` minimized (Win32 rect −32000, −32000),
a relaunch put the new window at screen **(8, 1)** — the work area's corner. Nothing landed
off-screen.

⚠️ **One placement case worth knowing, and it is spec-conformant.** The third window landed at
**(352, 184)** too — exactly on top of `window-2` rather than cascaded from it — because `from` is
the *focused* window and `main` was still reporting `document.hasFocus()`, the app being in the
background for a CDP-driven pass (`set_focus` on the new window is refused by Windows' foreground
lock; `SetForegroundWindow` returned `False` when tried directly). A reader pressing Ctrl+Shift+N
has the app focused, so their new window takes focus and the next one cascades off it. **The cascade
is one step from the anchor, not from the topmost window.**

**Cross-window refresh.** A test deck (`ZZ Live Pass MW`, created for the pass and deleted
afterwards) open in both windows; window 2 was never clicked into and never focused. The trigger
fires 120 ms after the poll takes its baseline, so **subtract ~120 ms from every figure for the
write-to-event delay**.

| Write in window 1 | `db:changed` | DOM changed in window 2 |
| --- | --- | --- |
| `deck_add_card` (Sol Ring) | **+263 ms** — `deck_audit, deck_cards, deck_categories, deck_undo, decks` | **+716 ms** (Cards 0 → 1) |
| a real Chromium click on the copies stepper | **+322 ms** — `deck_audit, deck_cards, deck_undo, decks` | **+400 ms** (1 → 2) |
| `collection_add` (one copy) | **+202 ms** — `activity, collection_entries` | **+246 ms** (`3 in your collection` → `4`) |

**Per window against follows live**, and none of these passes by nothing happening — in each case
the `app_meta` row on disk really moved and a `db:changed` carrying `app_meta` really reached window
2:

| Changed in window 1 | On disk | Window 2 |
| --- | --- | --- |
| `set_card_zoom('search', 2)` | `card_zoom` `search:1.5` → `search:2.0` | unchanged over 4 s (event at +197 ms) |
| Collapse sidebar | `nav_collapsed` = 1 | button still reads `Collapse sidebar` |
| Sort direction (deck gallery) | `deck_sort` `updated:desc` → `updated:asc` | button still reads *descending* (event at +204 ms) |
| `set_marketplace('cardmarket')` | — | prices `$…` → `€…` at **+277 ms** (event +193 ms) |
| Remove the `Wishlist value` home widget | — | widget left window 2's Home at **+231 ms** (event +212 ms) |

The marketplace row needs one caveat, because the first reading looked like a bug and was not: at
+277 ms the symbol had flipped and the *values* were still the USD ones, with the page still saying
`searching…`. Three seconds later, refetch settled, window 2 read the euro figures and they match
`corpus.db`'s `price_eur`. **The re-keyed queries do fetch; the in-flight frame is what shows the
old numbers** — which is §4's stated cost of `cancelRefetch: false`, seen in the window.

**Silence with one window.** Twelve `deck_set_card_quantity` writes against a row that really went
1 → 12: **0 events, log empty.** The same twelve with two windows open, 55 ms end to end: **1 event**
— the 50 ms debounce coalescing the burst. Then, idle with two windows open, counting for 10 s on
each view (12 s on Home): **0 events on home, collection, decks, the deck editor, wishlist, search,
tags and settings.** No refresh loop anywhere; a climbing count would have shown here.

⚠️ **Delivery is seconds late while another window is still starting up.** A burst ~3 s after
Ctrl+Shift+N, with the new window's webview still on `about:blank`, counted **0** events within
2.5 s of the last write — and that burst's 2 events had arrived by the next command. Nothing is
lost; the refresh simply arrives late for the length of a window's boot.

**Snap hover, driven with Win32 because CDP cannot see the frame.** The plugin parks its own `Static`
overlay on each window (both answering **9**, `HTMAXBUTTON`, to `WM_NCHITTEST`). Both pages carried
two counters — the window-scoped `getCurrentWindow().listen` the app now uses, and the global
`listen` it used to — and one `WM_NCHITTEST` sent to **main's** overlay only:

| Page | window-scoped `enter` | global `enter` |
| --- | --- | --- |
| `main` | **1** | 1 |
| the second window | **0** | **1** |

That is §6 proven in the window: the narrowed subscription hears only its own window, and the form
the app used to carry would have lit both. **The visible wash could not be driven** and the reason is
the harness rather than the app: a synthetic `WM_NCHITTEST` emits `enter` and then arms
`TrackMouseEvent`, so Windows answers `WM_NCMOUSELEAVE` at once and the button flickers rather than
lighting; a real cursor move raised nothing at all, because the app could not be brought to the
foreground from that automation context.

**Closing.** With the app running, `user.db-wal` was **3,201,272 bytes**. Closing the **original**
window left one target listed, the same pid, `window_count` answering **1** — and it still wrote
(`deck_delete` took the test deck out, `collection_remove` answered `removed: true`). Closing the
last window exited the process, and afterwards **`user.db-wal` was 0 bytes** and `corpus.db-wal` 0:
the exit push and the checkpoint ran exactly once, at the real exit.

**Scanner ownership.** This data copy has no `card-hashes.bin` and no OCR models, so the view says
so — it still mounts, and it still holds the lease.

| Step | What was measured |
| --- | --- |
| Scanner open in window 1 | window 1 has one `<video>`; window 2's `scanner_elsewhere` answers **`true`** |
| Scanner opened in window 2 | the two sentences, **zero** `<video>` elements — no camera, no tray, no takeover |
| Window 1 navigates away | window 2 switched to the live scanner at **+2 346 ms** |

2.3 s is where the design puts it: a two-second lease plus up to one second of the gate's poll.
Handing the scanner back the other way behaved the same.

**A hidden window's timers — the lease never lapsed.** Window 2 polled `scanner_elsewhere` once a
second while window 1 held the scanner, and window 1 also ran a `setInterval(…, 1000)`, which is the
same timer mechanism the heartbeat uses (a direct count of `scanner_hold` calls is not available:
Tauri's `invoke` cannot be patched from the page, and the Tauri MCP's ipc monitor does not see app
invokes).

| Window 1 | Duration | `scanner_elsewhere === true` | window 1's 1 s timer |
| --- | --- | --- | --- |
| minimized | 65 s | **65 / 65** | 80 ticks, gaps 992–1009 ms |
| fully covered by window 2 | 65 s | **65 / 65** | 66 ticks, gaps 996–1006 ms |
| minimized, past five minutes | **340 s** | **340 / 340** | 354 ticks, gaps 991–1010 ms, mean 1000, none over 1500 |

**Never `false`, and not one gap approaching the two-second lease**, including well past the ~5
minutes at which Chromium's intensive throttling would normally bite. **Why**: WebView2 reports a
**minimized** window's page as `document.visibilityState === "visible"` and
`document.hidden === false` — measured twice in this pass — so the renderer never sees a hidden page
and background-page throttling never engages. The same held for a fully occluded window.
**Caveat, so the figure is not overclaimed**: this is a debug `tauri dev` build whose WebView2 was
launched with `--remote-debugging-port=9222`. No CDP session was attached to window 1 during any of
the three runs, but the port being open at all is a difference from a shipped build. So §5's
hazard — *a gap longer than the lease between one try settling and the next going out* — is, on this
build and this OS, **not reproducible by hiding the window**; it is not proven impossible.

### Two things the pass cost that are not about windows

- **A direct `useAppStore.setState` on `cardZoom` does not write `app_meta`** — the persist hangs off
  the zoom action, not off the store — so the first version of the zoom check was vacuous. It was
  redone through `set_card_zoom`, and the vacuous version is recorded here so nobody repeats it.
- **The Home widget trash button opens a `Remove <title>?` confirmation**; a click on the trash alone
  leaves the widget in place, and the `Remove` button inside the dialog is the press that counts.

## 8. Driving two windows

`scripts/cdp.mjs` picked the first `page` in `/json/list`, and every window has the same URL and the
same title — so with two open it drove an arbitrary one. It has a `pages` command that lists targets
(index, id, title, url), a `CDP_PAGE` override taking an index **or a target id**, and a stderr
warning naming the page it chose when it had to choose. **Pin a multi-step pass to a target id, not
an index**: `/json/list` may reorder by activity, so an index can name a different window between two
commands. The whole of this pass was driven with `CDP_PAGE` set to a target id.
[live-ui-verification.md](live-ui-verification.md) is the harness contract.

**Storybook is one window and stays one.** The fake answers `window_new`, `window_count` (always
one) and `db:changed`, and the `scannerElsewhere` fault is how a story shows the second window's
Scanner without there being a second window — see [`.storybook/CLAUDE.md`](../../.storybook/CLAUDE.md).

## 9. Out of scope

- **Opening a window onto a given deck or view**, and an "Open in new window" menu item. A second
  window is the full app on the start view, and the shell has no URL to open onto.
- **Restoring windows across a restart**, the update restart included.
- **Per-window titles** — every window is *MTG Grimoire*; the taskbar thumbnail tells them apart.
- **Two processes on one data folder**, and **two worktrees' dev apps at once**. §1 is why the first
  stays refused; the second stays behind the one-app lock by choice.
- **A caption-bar button** for a new window.
- **Android and the web target.** Android runs one task per application, and a second browser tab is
  still "first tab wins".
