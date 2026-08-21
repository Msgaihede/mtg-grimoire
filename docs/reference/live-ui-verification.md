# Verifying UI in the real app

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

Every UI task in Plans 2–3 found something the suite could not: a clipped reason line, a
tile that said nothing until you searched again, a header behind the scroller. Drive the
real window over CDP.

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
```

**Take the `app` lock first.** Only one app runs across every worktree and a second exits
with code 0, no window and no stderr — the `running-the-app` skill owns that protocol.

Then from another shell, `scripts/cdp.mjs` (no dependencies, Node's built-in WebSocket):
`eval` · `click <css>` · `text <visible text>` · `key Escape` · `press Enter [css]` · `type` ·
`drag <source css> <target css>` · `pull <css> <dx> [dy]` ·
`hover <css> [--rest ms] [--probe expr]` ·
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
  with an explicit `size <those two numbers>`. **Read them; do not assume them.** Since
  2026-08-20 the app opens at the largest of 1920×1080 and 1280×720 the monitor's work area
  holds (`src-tauri/src/window.rs`), so the natural size differs between desks — the
  `size 1280 800` this contract used to name is now nobody's window.
  **`innerWidth` is the right width to _restore_ and the wrong width to _position_ from.** It
  includes the classic vertical scrollbar and `document.documentElement.clientWidth` does not —
  **1280 against 1265**, measured in the 2026-08-14 zoom pass. A `fixed` element is laid out
  against the initial containing block, which excludes the scrollbar, so a rect-derived offset
  that reads `innerWidth` lands 15px off. **jsdom cannot referee this**: it has no layout engine,
  `clientWidth` is a hard 0, so a test has to state a viewport width and stating `innerWidth`
  pins the bug. See [frontend-design.md](frontend-design.md).
  **Probe `transitionProperty`, never `transitionDuration`.** Tailwind's `transition-none`
  sets `transition-property: none` and leaves `duration-150` alone, so a reduced-motion check
  that reads the duration reports `0.15s` on a control that is correctly still — a false
  failure that reads exactly like a real one (measured 2026-08-09 on a sort header:
  `matches: true`, duration `0.15s`, property `none`).
  **For a `motion`-driven surface, read `matchMedia` inside the same expression that opens it.**
  The emulation is a fact about the session, but `motion` reads the query when an animation
  *starts* — so an expression that dispatches the gesture and samples immediately can measure a
  surface whose animation began before the emulated query reached it. Measured 2026-08-15 on the
  context menu: a first attempt read `transform: matrix(0.962694, …)` **under emulation** and
  looked exactly like a menu ignoring reduced motion; the same expression, reading
  `matchMedia(...).matches` before dispatching, read `matches: true` and `transform: none`, against
  an unemulated `matches: false` and `matrix(0.961869, …)`. **Report the emulated and unemulated
  numbers as a pair** — either alone is unfalsifiable, and the emulated one alone is how you file
  a defect that does not exist.
- **Do not drive a `tauri dev` window while anything is editing the frontend — Vite HMR is
  rewriting your subject mid-pass.** A subagent (or you, in another tab) saving a file the window
  renders hot-reloads it into the running app, so a measurement taken afterwards belongs to a tree
  state with no name, and **nothing on screen says so**. `git status` does not protect you: an
  uncommitted save has already reached the window. Measured 2026-08-15 — a pass was started with a
  fix agent holding `ContextMenu.tsx`, and the dev log's `[vite] (client) hmr update` lines were
  the only evidence of when the subject changed. **Take the pass against a quiesced tree**, or grep
  the dev log for `hmr update` covering the module under test before trusting a reading, and record
  the commit each figure was taken at. Rust is not exposed the same way: a compiled command only
  changes when cargo rebuilds, so a backend measurement survives what a frontend one does not.
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
- **`pull <css> <dx> [dy] [--steps n] [--probe expr]`** is a pointer **pressed** and moved:
  `mousePressed` → stepped `mouseMoved` with the button held → `mouseReleased`. It is the sibling
  of `drag` for everything that is not an HTML5 drag — `drag` intercepts the browser's drag
  controller, this drives raw pointer events — and the deck editor's search-panel resize handle is
  the first caller. **The reason it has to be real is `setPointerCapture`**: a
  `dispatchEvent(new PointerEvent(…))` out of an `eval` names a pointer id that was never active,
  so the capture throws `NotFoundError` *inside* the handler, and the pass fails on the harness
  while reading exactly like a failure of the page. A `mousePressed` from here makes the id active
  and the capture legal. Its probe is read twice like `hover`'s — `during` is the last held frame,
  `after` is what survived the release, and a handle that follows the pointer and springs back
  reads as working from either one alone. **A run that dies mid-pull leaves the button down**, and
  the next `pull` is what clears it (its own press/release pair), so an unexplained "the page is
  dragging on its own" after a failed command is that and not the app.
  **Its `--probe` is one shell argument and nested double quotes break it silently**: a probe
  written with `\"` inside a PowerShell double-quoted string splits into extra positionals, `dy`
  becomes `NaN`, and CDP rejects the call with `Failed to deserialize params.y` — measured. Single
  quotes only, inside.
- **`key` knows `ArrowLeft`/`ArrowRight`/`Home`/`End`** as well as Escape, Enter, Tab and the
  vertical arrows. The four were added for the app's one `separator`, whose whole keyboard contract
  is them; `rawKeyDown` is the right event for all of these, which is `press`'s distinction below.
  **It also knows `F10` and `ContextMenu`, and `--shift` applies to `key` as well**, which is how
  a card menu is opened from the keyboard: `useContextMenu` answers `ContextMenu` or `Shift+F10`,
  and until 2026-08-20 neither could be sent from here at all — so the keyboard half of every
  context menu in the app had never been driven. It has to be a real key rather than a
  `dispatchEvent`, because the handler reads `e.shiftKey`, which comes from Chromium's own
  modifier state and not from a property you can set on a synthetic event. Note the shape of the
  gesture: `key F10 --shift` opens the menu on **whatever is focused**, so focus it the way a
  reader would first — see the programmatic-focus trap.
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
- **Two worktrees cannot both run the app, and the way it fails is that you drive the wrong one.**
  `tauri-plugin-single-instance` is keyed on the Tauri `identifier`, which is the same string in
  every worktree, and every session sets the same `--remote-debugging-port=9222`. Measured
  2026-08-12: a second worktree's app started while this one was mid-pass, this one died with
  **exit code 0xffffffff and no panic, no stderr and nothing in the console recording**, and the
  relaunch then exited **0** (single-instance) while `/json/list` went on answering — from the
  *other* worktree's window. Every `cdp.mjs` command kept working and was driving somebody else's
  branch. **The tell is the page target's URL and it costs one call**: `http://localhost:1420/` is
  a `tauri dev` window and yours; `http://tauri.localhost/` is a built binary serving its embedded
  `dist/`. Check it before the first gesture, and ask which worktree the process came from —
  `Get-Process mtg-grimoire | Select-Object Id, Path` is enough, and `Get-CimInstance Win32_Process
  -Filter "Name='mtg-grimoire.exe'"` adds the command line. **Wait the other session out — never
  kill it**: it belongs to somebody else's task.
- **Do not `import()` anything under `/node_modules/.vite/deps/` from an `eval`.** Vite answers a
  stale dep-bundle hash with **504 Outdated Optimize Dep**, re-optimises, and forces a **full page
  reload** — which silently drops every `window.__*` the pass was holding, resets the app's
  zustand store to its default view, and kills the console recorder. Reach the app's own modules
  by source path instead (`import('/src/lib/ipc.ts')`, `import('/src/features/…/fixtures.ts')`);
  under `tauri dev` Vite serves and transforms those, so bare specifiers inside them resolve and
  the module works — which is also the cheapest way to get `ipc` and a fixture into the page
  without quoting a 2 500-character string through PowerShell.
- **Every `eval` lands in the same execution context, so a top-level `const` outlives the call
  that declared it.** The second `eval` reusing a name throws
  `SyntaxError: Identifier 'row' has already been declared` — which reads as a broken
  expression rather than as the previous command still being in scope, and it arrives on the
  *reuse*, so the pass that introduced the name looked fine. Wrap anything with a binding in an
  IIFE — `(() => { const row = …; return row.innerText; })()` — which also makes each command
  independent of the order the others ran in. Measured 2026-08-17.
- **Backing a change out through `element.style` is undone by a _re-render_, not by clearing the
  property** — and where the element already carries a React `style` prop, clearing it leaves the
  element with **neither** value. React writes an inline `style` and only writes it again when it
  re-renders; a probe that sets `el.style.clipPath = 'the old polygon'` and then restores with
  `el.style.clipPath = ''` has deleted the declaration the component put there. Nothing looks
  wrong — the class-driven half of the mark still measures correctly — so the next reading of the
  cleared property answers `none` and reads as the component having stopped setting it. Force a
  real re-render before believing anything about an inline-styled property (in the deck editor,
  the variant tabs do it), and prefer taking the "after" reading from a state the component
  rendered itself. Measured 2026-08-21 on the theory tick's `clipPath` (issue #182).

Seed and clean fixtures with `node:sqlite` straight into `src-tauri/target/debug/data/mtg.db`
**while the app holds it** (WAL allows it). Delete every seeded row afterwards — `data/` is
the user's, and it is never committed. Seed **user tables only**: `cards` and `sync_meta`
belong to the sync, and a hand-written row in either makes every later measurement a fiction.
