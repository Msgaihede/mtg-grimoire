# Verifying UI in the real app

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

Every UI task in Plans 2–3 found something the suite could not: a clipped reason line, a
tile that said nothing until you searched again, a header behind the scroller. Drive the
real window over CDP.

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
```

Then from another shell, `scripts/cdp.mjs` (no dependencies, Node's built-in WebSocket):
`eval` · `click <css>` · `text <visible text>` · `key Escape` · `press Enter [css]` · `type` ·
`drag <source css> <target css>` · `hover <css> [--rest ms] [--probe expr]` ·
`size 1024 768 "<expr>"` ·
`media prefers-reduced-motion reduce "<expr>"` · `shot out.png [w h]` · `console out.jsonl`
(stays attached; records `Log.entryAdded` **and** `Runtime.consoleAPICalled` — a run that
watches only one reports a clean console it never looked at).
**`--shift` on `click`, `text` and `press`** holds Shift down for that one gesture
(Chromium's modifier bitmask, `8`) — which is how a multi-key table sort is built, and the
only honest way to check it: a `dispatchEvent({shiftKey:true})` out of `eval` skips the
input pipeline the real modifier state comes from. On `press` it lands on the click Chromium
synthesises, so one `onClick` reading `e.shiftKey` serves the mouse and the keyboard both.
**A recorder dies with the window it is attached to**, and says nothing about it — restart
the app mid-pass and every later interaction goes unwatched while the file still exists and
still holds its `attached` line. Re-attach after any relaunch, and check the line count.

- **A built app embeds `dist/` at compile time, so a frontend-only edit does not reach a
  `tauri build` binary.** `npm run tauri build` re-runs Vite, writes a new `dist/assets/
index-<hash>.js` — and then cargo sees no Rust source change, skips the crate, and **leaves
  the old bundle inside the old exe**. It exits 0. Measured 2026-08-11: a fix was verified
  "live" **twice** against a binary that did not contain it, and the tell is cheap —
  `[...document.querySelectorAll('script')].map(s => s.src)` in the window against
  `ls dist/assets/*.js`, or just the exe's own mtime. `touch src-tauri/src/main.rs` first,
  which is the same rule this file already gives for `tauri.conf.json` and for the same reason.
  **`npm run tauri dev` does not have this problem** (Vite serves the frontend), which is
  exactly why it is the command above — a worktree pass that builds instead inherits the trap.
  And stop the app before rebuilding or the link fails with `Access is denied. (os error 5)`.
- **`key` and `press` are two commands because Enter is two things.** `key` sends a
  `rawKeyDown`, which carries no `text` — the page _hears_ the key and Chromium activates
  nothing, so `key Enter` on a focused button is a keydown and not a click (measured live
  2026-08-06: the nav button stayed unpressed). `press Enter|Space [selector]` carries the
  text, focuses the selector first if given, and is what a keyboard pass wants. **A keypress
  is `keyDown`-with-text plus `keyUp` and nothing else**: Chromium synthesises the keypress
  from the keydown, so adding an explicit `char` sends a _second_ one — measured on a deck
  stepper, one `press Enter` moved it 1 → 2 and the three-event form moved it 2 → 4 while
  reporting a single press. **When a live pass checks a key that activates something, count
  the activations, not whether one happened** — Space activates on keyup and hides this
  entirely.
- **`media` and `size` take a trailing expression and it is evaluated _in that session_.** A
  separate `eval` after them measures nothing: `setEmulatedMedia` is reverted the instant its
  socket closes, and every invocation of the script is its own socket. Worse, WebView2 ignores
  a features-only override entirely, so `media` has to send `"screen"` _with_ the feature —
  which is why "reduced motion verified over CDP" was a claim nobody had measured until this
  contract landed (Plan 4, Task 11). `setDeviceMetricsOverride` is the opposite and **survives
  detach**, but `clearDeviceMetricsOverride` restores nothing: `size reset` cannot get the
  window back, so read `innerWidth`/`innerHeight` before the first override and end the run
  with an explicit `size 1280 800`.
  **Probe `transitionProperty`, never `transitionDuration`.** Tailwind's `transition-none`
  sets `transition-property: none` and leaves `duration-150` alone, so a reduced-motion check
  that reads the duration reports `0.15s` on a control that is correctly still — a false
  failure that reads exactly like a real one (measured 2026-08-09 on a sort header:
  `matches: true`, duration `0.15s`, property `none`).
- **`drag <source> <target>`** is a real Chromium drag (`Input.setInterceptDrags` +
  `Input.dragIntercepted` + `Input.dispatchDragEvent`), with `--press <css>`, `--from x,y`,
  `--cancel` and `--probe <expr>` for reading the page mid-flight. **Interception bypasses
  the OS drag loop, so a green `drag` pass proves nothing about a real hand on a real mouse**
  — measured 2026-08-06: every HTML5 drag in the shipped window showed the blocked cursor
  while every intercepted pass stayed green, because Tauri's `dragDropEnabled` default had
  WRY's own OLE drop target swallowing `dragover`/`drop` for its file-drop API.
  `"dragDropEnabled": false` in `tauri.conf.json` is load-bearing; re-enabling it kills all
  in-app drag-and-drop on Windows, invisibly to this harness. The config is embedded at
  **compile time** — editing it needs a Rust rebuild (`touch src-tauri/src/main.rs`), not
  just a dev-server restart. **It cleans up after
  itself, including after a drag that never started** — which is the case worth naming,
  because that is the one that has already pressed the mouse button. A dying run otherwise
  leaves the browser's drag controller holding a press with interception on, and pdnd's
  `[data-pdnd-honey-pot]` covering the pointer so the next `mousePressed` lands on it. Two
  traps live in that cleanup: an `Input.DragData` **must** carry `dragOperationsMask` or the
  call is rejected outright (`Invalid parameters`, measured), and the four cleanup steps each
  need their own `try` — sharing one made the block all-or-nothing, and the step most likely
  to fail was the first. **The press must land somewhere visible** — a row whose centre is
  below the fold starts nothing, which is what `--press`/`--from` are for, and a scroller left
  scrolled hides rows from `click` the same way. **The target has the same problem and a
  worse failure**: `boxOf` reads a layout rectangle, and a drop target scrolled out of its own
  scroller's clip still reports coordinates _inside_ the window — so a drop dispatched there
  lands on whatever is painted at that point, which during a deck-card drag was the remove
  tray. Measured 2026-08-06 **against the zone-column editor Plan 8 replaced**: a column
  wrapped onto the editor's second, scrolled-away line took the drop, and a card aimed at the
  Companion column left the deck instead. The vocabulary is gone (categories are columns now,
  and the editor scrolls differently); the trap is not. Scroll the target into view first and
  hit-test the point (`document.elementFromPoint(...)` inside the target) before believing a
  centre.
- **`hover <css> [--from x,y] [--rest ms] [--probe expr]`** is a real dwell — `mouseMoved`
  events, so React synthesises `onMouseEnter`/`onMouseLeave` from Chromium's own hover
  pipeline and a `dispatchEvent` out of `eval` proves nothing. Two facts it cost a session to
  learn: **it approaches from outside the element** (the browser remembers where the pointer
  was left, so a move onto an element it is already inside crosses no boundary and fires no
  enter — a hover command that silently does nothing on its second run), and **its probe is
  read twice in the one session**, on arrival and again after `--rest`, because that pair is
  what a dwell looks like from outside. A dwell measured from the _last_ move undercounts by
  up to **~32 ms**: the approach is three steps 16 ms apart and the enter that arms the timer
  can land on the first of them.
- **A `Log` entry whose `?t=` stamp is frozen at attach time is retained history, not a live
  fault.** Reload with the recorder attached and read the entries that arrive after.

Seed and clean fixtures with `node:sqlite` straight into `src-tauri/target/debug/data/mtg.db`
**while the app holds it** (WAL allows it). Delete every seeded row afterwards — `data/` is
the user's, and it is never committed. Seed **user tables only**: `cards` and `sync_meta`
belong to the sync, and a hand-written row in either makes every later measurement a fiction.
