# MTG Grimoire

Portable Windows desktop app for tracking a Magic: The Gathering collection.
Tauri 2.11 (Rust core) + React 19 + TypeScript 6. Single local user, SQLite storage,
Scryfall as the only external dependency.

## Commands
- `npm run tauri dev` — run the app (Vite HMR + Rust rebuild)
- `npm run verify` — build + lint + Vitest + cargo test. **Run before every commit.**
- `npm run test` / `test:run` — frontend tests; `cargo test` in `src-tauri/` — Rust tests

## CI and releases (measured live 2026-08-09)
- Two workflows. **`.github/workflows/ci.yml`** gates PRs and pushes to `main`: a `frontend`
  job (`npm run build`/`lint`/`test:run`) and a `rust` matrix over `windows-latest` +
  `ubuntu-22.04` (`cargo fmt --check` on Linux only, `clippy -D warnings` and `cargo test`
  on both, everything `--locked`). **`ci-ok` is the one protected check** — branch protection
  pins names by string and a matrix job's name embeds its matrix values, so the aggregator is
  what has teeth and the matrix underneath stays free. `enforce_admins` is **false**: a red PR
  cannot merge, a direct push to `main` still can, so "Work on `main`" below stays true.
  Proven 2026-08-09 by a deliberate lint error: `frontend` red, both `rust` legs green,
  **`ci-ok` red**. A green pipeline proves nothing about a gate; that run is the proof.
- The `rust` job writes a stub `dist/index.html` first. `tauri-build` reads
  `frontendDist: "../dist"` and fails outright when it is missing, so a Rust-only job cannot
  compile a fresh checkout; the stub is what keeps it parallel with `frontend` instead of
  serialized behind a full Vite build.
- **`.github/workflows/release.yml` is one workflow on purpose.** A release created with
  `GITHUB_TOKEN` does not trigger `on: release` in another workflow — GitHub's recursion
  guard — so release-please, the build matrix and the publish step are three jobs in one
  file, chained on `release_created`.
- **Versions are never typed by hand.** release-please reads the `feat:`/`fix:`/`!` prefixes
  and keeps a `chore(main): release X.Y.Z` PR open that bumps all five version files —
  `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
  `src-tauri/Cargo.lock` — and writes `CHANGELOG.md`. Merging it tags, builds and publishes.
  `bump-minor-pre-major` is on, so while on `0.x` a `feat!:` bumps the **minor**; reaching
  1.0 is a deliberate `Release-As: 1.0.0` footer, never something a stray `!` does.
- **The `Cargo.lock` selector must read `@.name.value`, never `@.name`.** release-please
  parses TOML into tagged nodes, so every scalar is an object and the obvious form matches
  nothing — and a non-match is a *warning*, not an error. Measured against the real lockfile
  2026-08-09: `.value` changes exactly one line and leaves the `version = 4` lockfile-format
  key alone; the bare form changes nothing at all. **`--locked` on every cargo call in both
  workflows is what converts that silence into a failed check on the release PR itself**,
  before anything is tagged.
- The release is created as a **draft** and published only after every platform's assets
  attach, so a release is never visible without its binaries. `force-tag-creation` pairs with
  that and is not optional: a draft has no git tag until published, and without it
  release-please's next run cannot find the previous release and replays the whole history
  into the changelog. `gh release upload`/`edit` **do** resolve a draft by tag even though no
  tag exists yet (measured 2026-08-09 — the draft's own URL is `untagged-<sha>`).
- **release-please needs "Allow GitHub Actions to create and approve pull requests"**
  (`can_approve_pull_request_reviews: true`). It is one toggle covering both verbs, and with
  it off the run fails at the very last step — after parsing every commit, resolving the
  version and pushing the release branch — with "GitHub Actions is not permitted to create or
  approve pull requests". Everything looks healthy right up until it doesn't.
- **Every release PR opens in `action_required` and must be approved before CI runs.** This
  is the same recursion guard as above wearing its other face: a `pull_request` run from a
  `GITHUB_TOKEN`-authored PR is queued but *not started*. The run shows `action_required`
  with **zero jobs**, which reads like a broken workflow and is not. So a release is: PR
  opens → `gh api -X POST repos/…/actions/runs/<id>/approve` (or the Approve button) →
  `ci-ok` passes → merge. Handing release-please a PAT or App token would remove the click
  at the cost of a stored credential; for one maintainer the click is the better trade.
- **Tags are plain `v0.2.0`, and that needs `include-component-in-tag: false`.** Setting
  `package-name` gives release-please a *component*, and the default is to put it in the
  tag — the first release landed as `mtg-collection-tracker-v0.2.0` (the app's former name)
  before this was set.
  `pull-request-title-pattern` drops it from the PR title for the same reason. Both `gh`
  steps in `release.yml` read the action's `tag_name` **output** rather than a literal, so
  they were unaffected; anything that hardcodes `v${version}` would not be.
- Artifacts per release: NSIS `-setup.exe`, `.msi`, a **portable `.zip`** (the bare
  `mtg-grimoire.exe` — `productName` does **not** rename the binary in Tauri v2, it
  only names the bundles, so the exe is the lowercase **Cargo package name** — which runs
  from any folder and keeps `data/` beside itself, the behaviour no Program Files install
  can reach), plus `.deb` and `.AppImage`. The bundler
  names files from `productName` **with its spaces**, but GitHub rewrites spaces to dots on
  upload — measured on v0.2.0, which published as
  `MTG.Collection.Tracker_0.2.0_x64-setup.exe`. Under `MTG Grimoire` that same rule gives
  `MTG.Grimoire_<version>_x64-setup.exe` (derived, not yet measured — no release has shipped
  under the new name). Match on the dotted form when scripting against a release, never on
  the local bundle name.
- **A portable copy exits silently if any other instance is running** —
  `tauri-plugin-single-instance` gives it exit code 0, no window and no stderr, and a dev
  build from `target/debug` counts. Measured 2026-08-09 while verifying the v0.2.0 zip: the
  first attempt looked like a broken build and was a live dev instance.
- `--bundles` is pinned per platform. Not because RPM needs `rpmbuild` — it does not, Tauri
  builds RPMs in-process with the pure-Rust `rpm` crate — but because shipping one is a
  choice. AppImage is the bundle with external needs: it downloads `linuxdeploy` and wants
  `patchelf`, `xdg-utils`, `libfuse2`.
- **Linux artifacts are built but unverified.** Every measured claim in this file — the sync
  timings, the image cache, the `mtgimg://` origin, the drag-and-drop interception trap — was
  measured on Windows. Nobody has run a Linux build.
- Not done, deliberately: no code signing (no certificate, so SmartScreen warns on the
  installers) and **not** GitHub Packages — none of its registry types hosts a desktop
  installer, which is why the compiled app goes to Releases instead.

## In-app updates (`src-tauri/src/update.rs`, measured live 2026-08-09)
- **`tauri-plugin-updater` is deliberately NOT used, and cannot be.** It updates a Windows
  app by downloading and running its *installer*, and has no path for replacing a bare
  portable exe — pointing it at one installs a **second** copy into Program Files and leaves
  the portable copy and its `data/` behind. So the updater is hand-written.
- What that gives up is minisign. What replaces it is measured: **every GitHub release asset
  carries a `digest`** (`sha256:…`, all five). An asset with no digest is **refused**, never
  installed-unverified. `/releases/latest` also excludes drafts and prereleases by
  construction, which is exactly what `releaseDraft: true` needs. **`release.yml` did not
  change at all.**
- Asset selection is a **suffix** match (`-windows-x64-portable.zip`, `_x64-setup.exe`), never
  a literal name — v0.2.0's assets still carry the app's former product name. `content_type`
  is `application/zip` on **all five**, the `.exe`, `.msi` and `.deb` included, so it
  discriminates nothing.
- Install kind is decided once at startup: `<exe dir>\uninstall.exe` → **NSIS**; else a
  *probed* writable exe dir → **portable**; else **other**. An MSI install and every Linux
  build land on `other` and get the release page — an MSI major upgrade is unverified and
  nobody has ever run a Linux build.
- **The portable swap: rename the running exe aside, never overwrite it.** Windows permits
  renaming a running image and refuses to replace one. If the second rename fails the first is
  undone, so a failure leaves a working app.
- **The successor waits on the predecessor's process handle** (`--await-predecessor <pid>`,
  `OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject`), *before* `Builder::default()`. Without
  the wait `tauri-plugin-single-instance` gives it **exit code 0, no window, no stderr** and
  the update looks corrupt. **The first version waited by deleting the renamed image and that
  was wrong**: Rust's `fs::remove_file` uses POSIX-semantics deletion on current Windows, so
  it *succeeds* against a running exe — measured as "let go after 0 ms" with 200 ms of
  predecessor still to live. With the process wait: **231 ms**, window back, PID changed.
  `update::tests::deleting_a_file_that_is_still_open_succeeds_on_windows` pins the false
  premise.
- **A command must not build its answer while holding its own busy guard.** `status` reports
  `busy` by reading that flag, so `check`/`download` returning inside the guard tell the UI
  the operation is still running and the panel disables the button it just earned. Measured:
  "Restart to finish" arrived already disabled. Every `Ok` path drops the guard first. Invisible
  to unit tests, which pass `busy` in by hand.
- NSIS handoff is `setup.exe /P /R /UPDATE`, **spawned before we exit**: the installer's
  `CheckIfAppIsRunning` kills the running process without prompting in passive mode, and
  leaving on our own terms is what lets `RunEvent::Exit` checkpoint the WAL.
- Schema **v6** adds `app_meta` for the check throttle and the cached release — not
  `sync_meta`, which belongs to the sync.
- `MTG_GRIMOIRE_UPDATE_API` re-points the check at a local release fixture and is
  `#[cfg(debug_assertions)]` — compiled out of a release build entirely. It is the only way to
  exercise download → verify → swap → relaunch for real.

## Verifying UI in the real app (do this, not just tests)
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

- **`key` and `press` are two commands because Enter is two things.** `key` sends a
  `rawKeyDown`, which carries no `text` — the page *hears* the key and Chromium activates
  nothing, so `key Enter` on a focused button is a keydown and not a click (measured live
  2026-08-06: the nav button stayed unpressed). `press Enter|Space [selector]` carries the
  text, focuses the selector first if given, and is what a keyboard pass wants. **A keypress
  is `keyDown`-with-text plus `keyUp` and nothing else**: Chromium synthesises the keypress
  from the keydown, so adding an explicit `char` sends a *second* one — measured on a deck
  stepper, one `press Enter` moved it 1 → 2 and the three-event form moved it 2 → 4 while
  reporting a single press. **When a live pass checks a key that activates something, count
  the activations, not whether one happened** — Space activates on keyup and hides this
  entirely.
- **`media` and `size` take a trailing expression and it is evaluated *in that session*.** A
  separate `eval` after them measures nothing: `setEmulatedMedia` is reverted the instant its
  socket closes, and every invocation of the script is its own socket. Worse, WebView2 ignores
  a features-only override entirely, so `media` has to send `"screen"` *with* the feature —
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
  worse failure**: `boxOf` reads a layout rectangle, and a zone column wrapped onto the deck
  editor's second (scrolled-away) line reports coordinates *outside* its scroller's clip — so
  a drop dispatched there lands on whatever is painted at that point, which during a
  `deck-card` drag is the remove tray. Measured 2026-08-06: a drop aimed at the Companion
  column took the card out of the deck instead. Scroll the zones row first and hit-test the
  point (`document.elementFromPoint(...)` inside the target) before believing a centre.
- **`hover <css> [--from x,y] [--rest ms] [--probe expr]`** is a real dwell — `mouseMoved`
  events, so React synthesises `onMouseEnter`/`onMouseLeave` from Chromium's own hover
  pipeline and a `dispatchEvent` out of `eval` proves nothing. Two facts it cost a session to
  learn: **it approaches from outside the element** (the browser remembers where the pointer
  was left, so a move onto an element it is already inside crosses no boundary and fires no
  enter — a hover command that silently does nothing on its second run), and **its probe is
  read twice in the one session**, on arrival and again after `--rest`, because that pair is
  what a dwell looks like from outside. A dwell measured from the *last* move undercounts by
  up to **~32 ms**: the approach is three steps 16 ms apart and the enter that arms the timer
  can land on the first of them.
- **A `Log` entry whose `?t=` stamp is frozen at attach time is retained history, not a live
  fault.** Reload with the recorder attached and read the entries that arrive after.

Seed and clean fixtures with `node:sqlite` straight into `src-tauri/target/debug/data/mtg.db`
**while the app holds it** (WAL allows it). Delete every seeded row afterwards — `data/` is
the user's, and it is never committed. Seed **user tables only**: `cards` and `sync_meta`
belong to the sync, and a hand-written row in either makes every later measurement a fiction.

## Storybook (measured 2026-08-09/10)
`npm run storybook` · `npm run build-storybook`. **255 stories across 32 story files, 33 docs
pages** (every story file is `autodocs`, plus `.storybook/DesignSystem.mdx`).

- **What it is for: a design workbench, a living catalogue, and an a11y surface** — build a
  component against every state at once, find the one that already exists before writing a
  second, and let `@storybook/addon-a11y` check contrast and names per story. **Not visual
  regression, deliberately**: no screenshots are stored, so nothing here can fail because a
  font rendered a pixel differently on a different machine.
- **`.storybook/main.ts` aliases three specifiers** — `@tauri-apps/api/core`,
  `@tauri-apps/api/event` and `@/lib/images` — to `.storybook/fake/`. **The fake sits *under*
  `src/lib/ipc.ts`, not in place of it**, and that is the point: `ipc.ts` is a hand-written
  mirror of the Rust structs and is exactly the thing that can drift from them, so a fake
  beneath it means every story exercises the mirror too. Aliasing `ipc.ts` itself would story
  the components against a second, agreeing copy of a contract nobody had checked.
- **The fake stores table rows and derives DTOs** (`fake/db.ts`), because **`ownedQuantity`
  means three different things on three DTOs**: every copy of one printing and finish-blind on
  `CardSummary`; the copies filling one wish and finish-**aware** on `WishRow`; a deck's
  **allocation** on `DeckCard`. A fake that stored DTOs would make all three agree, and teach
  a reader a model the app does not have.
- **Seeds and faults are state, not response stubs**: `parameters: { fake: { seed, fault } }`,
  seeds `empty`/`starter`/`needsReview`/`large`, faults `busy`/`syncError`/`imageFailures`/
  `gone`. Saying nothing gets `starter` with no fault. A fault is set on the world, so a story
  about `BUSY` shows what the *app* does with a refusal rather than what one mocked call
  returns.
- **Art is synthetic by default, with a Live toolbar switch.** Synthetic so a checkout with no
  network renders every story exactly as one with it, and so `build-storybook` produces a
  static site that draws card art without touching Scryfall. **No card image bytes are
  committed.**
- **`.storybook` is type-checked by its own program** — `tsc -p .storybook`, run by
  `npm run build` — so the fake is checked against `ipc.ts` by `verify` like the app is. And
  **`@types/node` must never be installed**: `types: []` blocks only the *automatic* include,
  not a transitive `/// <reference types="node" />`, and `vitest` and `vite` each carry one. Its
  mere presence in the tree leaks Node types into the **app** program, which type-checks
  `process.env` in webview code and retypes `setTimeout` from `number` to `NodeJS.Timeout`.
  Its absence is the only fence; `.storybook/node-url.d.ts` shims the one function `main.ts`
  needs.
- **`src/stories.test.tsx` runs every story's `play` under Vitest** through `composeStories`
  (176 plays today), which is what puts a story's own claim inside `npm run verify` —
  `build-storybook` compiles stories, it never plays them. `composeStories` **snapshots project
  annotations at call time**, so `setProjectAnnotations` must run before it, at module scope;
  after the scan it is a no-op and the failure is a story running with no decorator.
- It `vi.mock`s two of the three aliases, and **the third (`@/lib/images`) must never be
  mocked.** `vi.mock` matches the *resolved id*, so it resolves to the same `src/lib/images.ts`
  that the fake's own `export *` resolves to, and the factory imports the module it stands in
  for. **The symptom is a silent 300-second hang with no output and no failing test** — if the
  suite goes quiet, this is why.
- **jsdom lays nothing out, so a virtualised list renders zero rows** without the
  `offsetHeight`/`offsetWidth`/`scrollTo` stub in that runner. It lives there and not in a
  `play` because `play` also runs in the Storybook browser, where those are native prototype
  accessors a `defineProperty` cannot undo. Its viewport is a number and not this app's window:
  **assert the content presence of a named row, never a count.**
- **Every drag in a story is held in `try { … } finally { await held.cancel(); }`, and every
  assertion about a drag's result goes through `waitFor`.** pdnd schedules its drop-target
  change on a rAF and React's commit is a second hop, so one frame is not enough; and a throw
  mid-drag leaks pdnd's one global drag flag into the *next* story, which is why one broken
  assertion reported two failures. Measured on `AppShell.stories.tsx`: **5 of 10 runs red
  before, 12 of 12 green after.**
- **Storybook CSS is `.storybook/preview.css`, never `src/index.css` directly.** That file
  imports the app entry and declares `@source "../.storybook"` itself, because `@source`
  resolves relative to the declaring file. Declaring it in `src/index.css` shipped Storybook's
  utilities to users: measured, `dist/assets/index-*.css` 119,935 → **119,126** bytes, 11 rules
  dropped and 0 added. Stories cannot be fenced off the same way and should not be — a
  `.stories.tsx` is under `src/`, which `@source "../src"` must scan.
- **`npm run build-storybook` runs in CI's `frontend` job**, and it is the **only** gate the
  `.mdx` page has. Stories are `.tsx` under `src/`, so `tsc` and ESLint already see them;
  `DesignSystem.mdx` is seen by neither — `tsc` reads only `.ts`/`.tsx` however the `include`
  glob is written, and `eslint` answers "File ignored because no matching configuration was
  supplied" (both measured 2026-08-10). Before this step the page could break and nothing would
  say so. It earns itself on more than MDX: a **CSS comment cannot hold a glob containing a
  star-slash** — that closes the comment — and `storybook build` is what caught exactly that in
  `preview.css` while this task was being written. `frontend` feeds `ci-ok`, the one protected
  check, which is why the step lives there rather than in a job of its own.
- **A green Storybook proves nothing about the shipped window.** It runs in a normal browser:
  no WRY OLE drop target, no `mtgimg://` protocol handler. **Drag-and-drop and image loading
  remain the live CDP pass's to prove** — see the section above, and note that the same is true
  of the story runner, whose drags are synthetic events in jsdom.

## Data & sync (measured against the live Scryfall API, 2026-08-04/05)
- Data dir is `<exe dir>/data`, falling back to `%APPDATA%/com.mtggrimoire.app/data`.
  **Under `tauri dev` the exe is `src-tauri/target/debug/`, so the database is
  `src-tauri/target/debug/data/mtg.db`** — not `src-tauri/data/`. Delete that `data/`
  folder to force a clean first-run sync. All three locations are gitignored.
  **The fallback's folder name is the Tauri `identifier`, and the rename changed it** —
  `com.mtgcollection.tracker` → `com.mtggrimoire.app`. A machine that ran the v0.2.0
  *installer* still has the old folder and its database; nothing migrates it, deliberately
  (portable copies keep `data/` beside the exe and are untouched). So "my collection is
  gone" after upgrading an installed 0.2.0 has exactly one cause and one fix: copy the old
  folder across.
- A sync yields ~116.6 k cards / ~1 050 sets from a 77 MB download. **Timings, measured
  2026-08-05 over three live forced syncs (debug build):** `checking` <1 s · `downloading`
  ~2.5 s · `ingesting` **~81 s** · `reclaiming` ~6 s · `sets` ~5 s — **92–99 s end to end**.
  Re-measured 2026-08-06 on the day's rotated bulk file: **93 s**, corpus **116,590**
  unchanged. Scryfall regenerates "once every 12–24 hours" in a 21:00–21:45 UTC window
  (`default_cards` at ~21:16), so a forced Refresh finds a genuinely new file about once a
  day; after that the ETag answers 304 until the next rotation, and the only way to make it
  ingest again is the `sync_meta` reset below.
  The old **44.8 s** figure predates schema v3: the ingest now gzips `raw` on the way in,
  and that is where the extra minute went. A run that finds nothing new is **1.8 s**.
- `mtg.db` was **2.02 GB** and is **547 MB** after the two things Plan 3 added: the one-time
  `compacting` conversion (which reclaimed a 996 MB freelist) and gzip `raw`
  (**622 MB → 235 MB**, 38 % of the original — not the quarter that was estimated). A
  full re-ingest afterwards leaves the file within 0.03 % of that and the freelist at **0**,
  which is the post-swap `incremental_vacuum` doing its job.
- The app never closes its SQLite connection, so a `mtg.db-wal` the size of the ingest
  (~857 MB) used to outlive the process. `RunEvent::Exit` now runs
  `PRAGMA wal_checkpoint(TRUNCATE)`, and `journal_size_limit` caps the file at 64 MB.
- A second launch inside 24 h makes **no network call at all** — the throttle returns
  before the ETag check and writes nothing, so `last_check_at` does not move.
- A **forced** Refresh skips only the throttle, not the ETag/`updated_at` check: if the
  bulk file has not changed it answers "Already up to date" in well under a second and
  emits nothing but a `checking` phase. To exercise a real ingest out of turn, clear
  `bulk_etag` *and* `bulk_updated_at` from `sync_meta` — clearing the etag alone still
  short-circuits. That reset works, and it is the right tool for developing an ingest; it is
  the wrong tool inside a **smoke**, because a hand-written `sync_meta` makes every timing
  and every "what the app did on its own" claim afterwards a fiction. A smoke takes the
  ingest the day offers it, or does without one and says so.
- **The two halves of the reconciler run on different schedules, and that decides how a
  fixture is staged.** `reconcile::apply` — the `/migrations` poll — runs on *every* finished
  run, the "already up to date" path included (`finish_unchanged` calls it deliberately: 304
  is the answer most runs get). `reconcile::sweep_orphans` runs **only after a real ingest**.
  So a merge can be exercised any time by deleting its `card_migrations` bookkeeping row and
  forcing a Refresh; an orphan flag needs the day's ingest.
- Searches keep answering through every second of a sync — 20 timed searches across one,
  every one correct, none stalled (that is what `db_read` bought).
- **Sorting an unfiltered browse costs 310–345 ms, and the browse it replaces costs 277 ms.**
  Measured 2026-08-09 over the live 107 337-row paper corpus, medians of five after a warm-up:
  `set` 313 · `rarity` 325 · `rarity+price` 339 · `price` 345, against **277 ms for the
  default name order**. So a header press costs 35–70 ms more than doing nothing, not 300.
  **With any text filter every one of them is 12–15 ms**, because FTS narrows the set first.
  No index was added: a multi-term sort cannot use one past its leading column, and
  `schema::swap_staging` drops and replays every index on `cards` on each ~93 s sync.
- **The default browse's 277 ms is a full table scan, and one `DESC` is why.** `ORDER_NAME`
  is `c.name ASC, c.released_at DESC` — `idx_cards_name` can satisfy a leading `c.name` and
  block-sort **one** trailing term within each group of identically-named printings, and with
  two it gives up and sorts all 107 k rows through a temp b-tree. Measured against
  `c.name ASC, c.id ASC`, which is what the Name column's own header sends: **0.1 ms, using
  the index**. The `released_at` term is kept deliberately — dropping it changes which
  printing of a card the browse opens on, which is a product decision and not a performance
  one — and `search::tests::the_default_browse_puts_the_newest_printing_of_a_name_first`
  pins the behaviour it buys.
- The page query keeps its flat shape. The two correlated status subqueries
  (`owned_quantity`, `wishlisted`) do run once per *matching* row under an unindexed sort,
  but that is only ~35 ms of it (313 ms full vs 280 ms lean) — and the two-step form that
  would avoid them **does not preserve the sort's order**: `row_number() OVER ()` numbers
  rows before the `ORDER BY`, measured rather than read.
- The ingest **commits every 2 000 rows and releases the write connection between batches**,
  so a collection edit during a sync waits one batch, not one sync. `ingest_gz` takes
  `&Mutex<Connection>` for exactly that reason. **Measured mid-ingest: 10 `collection_add`
  calls, 4–7 ms each, 0 `BUSY` refusals.** A killed ingest therefore leaves a *committed*
  `cards_staging`; `prepare_database` drops it at the next launch, because the ETag that
  would short-circuit the next check is written only after a *successful* ingest.
- `cards.raw` is a **gzip BLOB** from schema v3 (the column is still *declared* `TEXT` — v1
  is frozen — and SQLite's TEXT affinity leaves a BLOB alone). `json_extract` over it is a
  hard error, not a NULL: read it with `CAST(raw AS BLOB)` and `card_row::raw_json`.
  Nothing reads it at runtime; `artist` has had a column since v3. The v3 migration does
  **not** rewrite existing rows — the corpus converts on the next sync's swap.
- **Schema is v5.** v5 added the four deck tables (`decks`, `deck_cards`, `deck_allocations`
  and the seeded `format_specs`) and two `cards` columns, `power`/`toughness` — CR 903.3
  (2026) makes a commander out of a Vehicle or Spacecraft *with a P/T box*, and that is
  unanswerable without them. Its backfill reads `raw` through `schema::json_raw` exactly as
  v3's `artist` did, so it could only recover the **1 510 of 116 590** rows that keep a
  `card_faces` array; everything else fills on the next sync's swap. Until then **both
  columns NULL means unknown, never "no P/T box"**, and `deck::get_deck` repairs the rows
  that ask (`fill_unknown_power_toughness`, gunzipped in Rust, gated on a type line that
  could have one).

## Image cache (measured 2026-08-04, live)
- Files live at `<data dir>/images/<variant>/<id[0..2]>/<id>-<face>.webp`; `image_cache`
  rows and files stay 1:1, and the row's `source_uri` — Scryfall's `?<epoch>` cache-buster
  — is the only invalidation signal. Deleting `data/images` is always safe.
- A `grid` image averages **59.6 KB**. 600 browsed cards cost ~36 MB, so all 116 k
  printings at `grid` would be ~7 GB — which is why Plan 3's pre-warm is scoped to what
  the user owns rather than to the database.
- Warm serve **2–3 ms**, cold single image **~127 ms**. A cold screenful of 20 tiles is
  **80–270 ms** after the query lands — re-measured 2026-08-09, against **2 348–2 676 ms**
  for the same five searches on the commit before (same machine, same corpus, `data/images`
  cleared before each run, five identical cold terms plus five never-fetched ones).
- **Nothing paces an image fetch, and that is deliberate.** The old 100 ms interval was
  `api.scryfall.com`'s ≤10/s rule charged to `cards.scryfall.io`, which the research doc
  records as having **no rate limit** — and `is_fetchable` guarantees an image can come from
  nowhere else. It capped the whole app at 10 images/s, which was most of the 2.4 s above.
  `MAX_CONCURRENT_FETCHES` (**16**) is now the whole of the pacing and it bounds *this*
  machine — sockets, worker threads, bodies in flight — not Scryfall's patience. The 429
  machinery is untouched: `Cache.gate` still carries a penalty deadline, still answers a
  request inside one at once with the time remaining, and `penalise` still takes the `max`.
  Measured over ~600 live images across two sessions: **zero** 429s, zero 502/503.
- A page of search results warms itself: `images::prefetch_images` takes front faces only,
  caps the batch at 100, and is fire-and-forget — it resolves when the work is *queued*.
  It walks the page **in reading order**. It used to walk backwards so it would not collide
  with the tiles the grid had just mounted, on the premise that "nothing dedups a fetch that
  is already in flight" — which Plan 3's single-flight map made false. Colliding at the head
  is now the *good* case (a wait on a request already going out); walking backwards spent
  the permits on cards fifty rows below the fold.
- A printing with no art anywhere (162 of them) is a **200 with an SVG placeholder** at the
  variant's exact dimensions, never a 404 and never a cache row. Only a real failure is an
  error: 502 for a failed fetch, 503 + `Retry-After` for a rate limit.
- `mtgimg:` is an `img-src` and nothing else — a `fetch()` at it fails CORS by design (no
  `Access-Control-Allow-Origin`, because an `<img>` load is no-cors). Read images with
  `<img>`, never with `fetch`.
- A card image URI with no `?<epoch>` cache-buster is **refused at resolution** — it is
  uncacheable by construction, so it resolves to the no-image placeholder and never to
  bytes. This heals itself: the printings that publish `errors.scryfall.com/soon.jpg` in all
  four slots were **eight** on 2026-08-04 and are **four** (`mic 55`–`58`) on 2026-08-05,
  because a sync rewrites `image_uris` and a URI that gains a cache-buster becomes
  fetchable. No code is involved; do not build a re-fetch path for it.
  `cards.scryfall.io` is the **only** host images are fetched from; an off-host URI is
  refused and warned about once per process. A placeholder is served `no-store` (it is the
  one 200 whose content is meant to change), real bytes `max-age=86400`.
- Images are fetched **once per key** even when a screenful asks at the same moment
  (`Cache`'s per-key mutex + a re-read of the disk). The waiter re-reads rather than being
  handed the bytes, so it degrades to a second fetch when the write connection was busy or
  the store failed — both acceptable, both documented at `images::fetch_and_store`.

## Frontend design (binding)
- **All frontend work follows the `frontend-design` skill** (invoke it before UI tasks) and the
  visual direction doc: `docs/superpowers/specs/2026-08-04-visual-design-direction.md`.
  Implementers execute that direction (palette, type, mana line, filter chips) — they do not
  invent their own. Mana/set symbols come from the bundled `mana-font`/`keyrune` npm packages,
  never a CDN.
- Global actions (Refresh, sync status, future settings) live in the top ribbon, not in views.
- **Card art is drawn with `components/CardImage`, never a bare `<img>`.** It keys the image
  on its own URL, and that key is the whole component. A browser keeps painting an `<img>`'s
  last decoded frame until the new `src` decodes, and every card frame here belongs to a
  *slot* rather than to a card — grid tiles are keyed by position on purpose, a deck cover is
  handed a new id, the pane reuses its art across a flip — so React hands one element a
  different card and the picture lags the caption by the length of the fetch. Measured over
  CDP on the commit before: a search change kept **all 20** tile elements, captions reading
  "Black Lotus" over Shivan Dragon art for ~2.4 s. After: **0** kept.
  **This is invisible to the DOM and therefore to the test suite in the obvious place** —
  setting `src` resets `complete` and `naturalWidth` while the old frame stays painted, so
  `naturalWidth === 0` is true in both the healthy and the broken case. What a test can see
  is *element identity*, which is what `CardImage.test.tsx` and the two integration tests
  assert; what a person can see is a screenshot. `PrintingPreview` reached the same answer
  independently by keying its whole `Preview` on the printing.
- **`loading="lazy"` belongs on a plain scroller, not on a virtualised one.** `CardGrid` had
  it against "117 k results is 117 k requests", which the virtualiser had already made false
  — the wall mounts the rows on screen plus two, about two dozen images — so the browser's
  gate only delayed the pictures about to be looked at. The deck zone columns keep it: they
  are plain scrollers, where a 100-card list really is 100 mounted rows.
- **Escape closes one layer per press, and the protocol is a handshake, not a z-index.** An
  inner dismissible layer (popup, listbox, menu) listens on `window` in the **capture**
  phase and calls `preventDefault()`; an outer one (the card detail pane) listens in the
  bubble phase and returns early on `e.defaultPrevented`. Capture is load-bearing: two
  `window` listeners for one event run in *registration* order, and the outer layer was
  mounted first, so in the bubble phase it would act before the popup and read
  `defaultPrevented` as false. Every new dismissible layer follows this or it will close
  something it did not open. Pinned by `App.test.tsx`'s Escape-stack test.
- A layer that Escape dismissed hands focus back to whatever opened it, *before* React
  flushes the close (the element is still mounted). An outside-click deliberately does not
  — the reader is already somewhere else.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts`, and `src/lib/layers.test.ts` sweeps
  `src/` to keep it the only place they are written.** The bug it closed is worth the
  paragraph: the search view's set picker (`absolute z-20`) was painted over by the results
  table's sticky header (`sticky top-0 z-20`), because nothing between them creates a
  stacking context and **equal z-indexes are resolved by document order** — where every
  table header comes after the filter bar. Measured over CDP 2026-08-09 on the shipped
  window: the popup and the header overlap by exactly 36px, and forcing the popup back to
  the header's layer moves what `elementFromPoint` finds there from `listbox` to `row`.
  The part a number cannot fix: a popup inside a virtualised row is capped by that row's
  layer whatever it asks for, because the row is `absolute` *and* `transform`ed and is
  therefore its own stacking context. That is why the row lift exists and why it sits
  *below* the header — a row has to scroll under one. Variant spellings
  (`has-[[aria-expanded=true]]:z-10`) are their own entries, written out: Tailwind scans
  source text for whole class names, so a class built by interpolation emits no rule at all.
- **An anchored popup near the right of a row is pinned to its trigger's *right* edge.**
  Nothing clips these popups — that is the point of not portalling them — so one that
  overflows the window scrolls the whole app sideways instead of being cut off. The set
  picker did: 288px of listbox opening from a trigger at the end of the filter row put it
  **174px past a 1280px window** (measured), and the page slid left, sidebar and all, the
  moment its own `scrollIntoView` ran. `right-0`, the same decision as
  `AddToCollection`'s `align="end"`.
- **The three tables are one component**, `src/components/table/VirtualTable.tsx`: columns
  are data, and the two things that genuinely differ stay callbacks — `renderRow` (the
  collection and wishlist wrap a row in a drag source; the wishlist also decides per row
  whether it opens a card at all, because an any-printing wish has none) and `extraHeight`
  (the reconciler's flagged band). Its column template is an **inline style**, not a
  Tailwind arbitrary value, for the scanner reason above.
- **Table headers sort, and Shift builds a multi-key sort.** A press cycles one column
  `firstDir → the opposite → gone`; the modifier decides only what happens to the *other*
  columns, so every single-column order is reachable without ever holding Shift. `firstDir`
  is descending on money and count columns. The whole interaction is one pure reducer,
  `applySort` in `src/lib/sort.ts`. `aria-sort` goes on **every** sorted column — the
  alternative is telling assistive tech that a two-key sort has one key — and the rank rides
  in the button's accessible name (`"Price, sort priority 2"`). **Name-from-content does not
  reach into a descendant's `aria-label`**, so a column's own description belongs on the
  `columnheader`, not on the button inside it: on the button the Price column read back as
  bare "Price", losing the sentence spec §5 says a price may never be shown without.
- **A header sorts by what its column shows**, which is why the collection's Value column
  orders by unit × copies and the wishlist's Cost by unit × copies *still missing* — not by
  the unit price. The orders with no column to press ("Recently added", and the unit price
  itself) stay on the filter bar's select, which drives the **same** state: picking there
  replaces the sort with that one term, and the control reads `Custom…` once the sort starts
  somewhere it has no option for. The wishlist's Printing column is deliberately not
  sortable at all — an any-printing wish names no set.

## Architecture (read the spec first)
- Spec: `docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md`
- Research (live-verified facts, incl. Scryfall breaking changes): `docs/superpowers/research/`
- Plans: `docs/superpowers/plans/` — execute in order, check off steps as you go.
- **Rust owns data plumbing** (SQLite/FTS5, Scryfall sync, image cache). **TS owns domain
  logic** (deck validation, import/export parsing). Keep that boundary.

## Hard rules — database
- **`cards` is dropped and recreated on every sync** (`schema::swap_staging`, with
  `foreign_keys=ON`). So: user tables reference `cards.id` **without an enforced foreign
  key** — a soft reference plus denormalized `set_code`/`collector_number`/`lang`
  (spec §6). A declared `REFERENCES cards(id)` aborts every sync; `ON DELETE CASCADE`
  deletes the user's collection on the next refresh. Orphans are *flagged*, never deleted.
- Every index on `cards` goes in `schema::CARDS_INDEXES` — the swap drops the table with
  its indexes and replays only that list.
- `CARDS_COLUMNS` is **frozen**: it is what schema v1 created, not what `cards` is now.
  Add columns in a new `if v < N` step in `migrate` with `ALTER TABLE`. (`create_staging`
  derives its layout from `PRAGMA table_info(cards)`, so staging follows automatically.)
- **`raw` is a gzip BLOB from schema v3 on, and a bare `json_extract(raw, …)` is a hard
  error, not a NULL.** SQLite reads a BLOB argument to `json_extract`/`json_type`/
  `json_each` as JSONB; a gzip member is not valid JSONB, so the call raises
  `malformed JSON` and fails the whole migration for every user who has synced since v3.
  Any migration reading `raw` goes through **`schema::json_raw`** (Rust reads use
  `card_row::raw_json` with `CAST(raw AS BLOB)`). The guard must sit **inside** the
  expression, wrapping the *argument* — never as a `WHERE` term, because the planner
  orders `WHERE` terms as it likes and evaluating the unguarded one *is* the error. This
  is invisible to tests: fixture databases hold text `raw`, so an unguarded `if v < 4`
  passes every test and breaks only in the field. v2 and v3 are both guarded; the ladder
  is walked over a gzip row by
  `schema::tests::the_v3_backfill_steps_over_a_row_whose_raw_is_not_json`.
- `cards_fts` is **external-content with no triggers**. Any write to `cards` outside the
  ingest path needs `INSERT INTO cards_fts(cards_fts) VALUES('rebuild');` **if it touches
  an indexed column (`name`/`type_line`/`search_text`) or renumbers rowids** — and `VACUUM`
  does the latter, so it always needs one. A migration that only adds and fills unindexed
  columns does not (schema v2; `the_v2_backfill_leaves_the_search_index_answering` is the
  proof).
- Two connections: `AppState.db` writes, `AppState.db_read` is `SQLITE_OPEN_READ_ONLY`.
  Reads go through `db_read` so a search is not stuck behind an ~80 s ingest.
- `db::open` sets `PRAGMA auto_vacuum=INCREMENTAL` **before** `journal_mode=WAL` — after WAL
  has materialised the file the pragma is a silent no-op that only a `VACUUM` can apply.
  Databases from Plans 1–2 are converted once, after a sync, by `maintenance` (`compacting`
  phase); a `VACUUM` **always** needs `schema::create_fts` after it.
- Only `schema::migrate` may stop a launch. `prepare_database`'s other two steps (an FTS
  rebuild an interrupted compaction owed; the staging table an interrupted ingest left)
  are logged and left owing — their likeliest cause is a full or read-only disk, and
  `init_state` turns any error into "move `mtg.db` aside", which that disk cannot do.

## Hard rules — user data
- `collection_entries`/`wishlist_entries`/`card_migrations`/`deck_cards` reference `cards.id`
  **softly** and denormalize `set_code`/`collector_number`/`lang` (and `name`, on the wishlist
  and on deck cards) — as does `decks.cover_card_id`. A row whose card vanishes is **flagged**
  (`needs_review`, a sentence) and never deleted — `reconcile::sweep_orphans` runs after every
  ingest over all three user card tables and clears the flag if the card returns.
- Grain: `(card_id, finish, condition, lang, altered, signed, proxy, misprint, serial, grading)`,
  as `schema::COLLECTION_GRAIN` — one constant, because the UNIQUE index and every
  `ON CONFLICT` target must match verbatim. The `coalesce(…, '')`s are load-bearing: NULLs in
  a UNIQUE index are distinct. `grading` enters identity as **raw text**, so it is only ever
  written through the one fixed-field struct that owns its key order.
- **Quantity 0 keeps the collection row** — the condition, purchase price, tags and
  acquisition story survive the day the user owns none of the card. Deleting is
  `remove_entry` and only ever `remove_entry`. The wishlist is the opposite by table CHECK
  (`quantity > 0`): a wish for none of something is not a wish, so zero removes it. Both
  refuse a negative through the one `collection::valid_quantity`.
- Finish is an **enum** (`nonfoil|foil|etched`), condition is one of `NM|LP|MP|HP|DMG`; both
  are CHECK-constrained in SQL *and* validated in Rust, and the imported string is kept in
  `condition_original`.
- **A finish's price is a lookup in the `prices` blob** (`usd`/`usd_foil`/`usd_etched`;
  `eur_etched` does not exist, so etched is unpriced in EUR). `cards.price_usd` is a
  sort/display fallback chain and must never be summed. `tix` is never summed with fiat.
- **Wishlist fulfillment is finish-aware.** A foil wish is not filled by a nonfoil copy; a
  wish naming no finish is filled by any. `wishlist::OWNED_SQL` sums `quantity`, so a
  collection row stepped to zero contributes nothing.
- `needs_review` is a **sentence, not a flag** — the reconciler writes what happened, and
  the first message wins (a later sweep does not overwrite one). Non-NULL means "listed,
  counted, and asking to be looked at", never "hidden".
- Writes take `AppState.db` through `db::lock_for(…, WRITE_LOCK_WAIT)` and answer
  `collection::BUSY` if they cannot — reads go through `db_read` like everything else.
- `cards.oracle_id` is NULLABLE and **no live row is null** — 0 of 116,590, all 81
  reversible printings included, because `card_row` falls back to `card_faces[0]`. Every
  `oracleId === null` branch in the app is a fence around the type, not a card you can find.

## Hard rules — decks
- **There are exactly three enforced foreign keys in the whole schema, and all three are
  user↔user**: `deck_cards.deck_id → decks(id)`, `deck_allocations.deck_id → decks(id)` and
  `deck_allocations.collection_entry_id → collection_entries(id)`, every one
  `ON DELETE CASCADE`. Three, because CASCADE is only ever right at a *user-initiated*
  delete: deleting a deck takes its list and its reservations, and `collection::remove_entry`
  frees the reservations on copies that no longer exist. The app's one **non-user** delete is
  the reconciler's fold, and `reconcile::fold_into_existing` **repoints (and where the
  survivor is already allocated, folds) every allocation onto the surviving entry before the
  DELETE runs**, so that CASCADE fires over nothing. Nothing else declares `REFERENCES`, and
  **nothing ever declares it against `cards`** — a declared FK there aborts every sync.
- Zones are an enum — `main | side | commander | companion | maybe` — CHECK-constrained in
  SQL and narrowed in TS. **Deck cards side with the wishlist: `CHECK (quantity > 0)`, so
  zero removes the row.** A zone slot at zero holds no condition, no price and no story;
  only the collection's zero is worth keeping. The grain is
  `(deck_id, card_id, zone)` (`schema::DECK_CARD_GRAIN`) — the same printing in two zones is
  two rows, added twice in one zone is one row with the sum. `maybe` is a scratchpad and
  **counts toward nothing at all** (`engine.ts`'s own words) — not size, not copies, not
  legality; the allocator does not claim copies for it either. `DeckStats` still *reports*
  `byZone.maybe`, which is a count of the pile and not a contribution to anything.
- **`format_specs` is data, not code.** All 23 Scryfall legality keys plus `casual`/`limited`,
  seeded by `INSERT OR REPLACE` in the migration, with `restricted_semantic`
  (`max_one` | `banned_as_commander` — TRAP A, never inferred from the key), `commander_rule`,
  `sideboard_max`, `allows_companion`, `max_mana_value` and `enabled_in_picker` as columns. A
  rules change is a **new migration step re-running the seed constant**, never an engine
  branch, and a new format is a row. Never derive one format from another.
- **Validation is TypeScript** (spec §3), in `src/features/decks/validation/`: `engine.ts`
  (size, copy limits, restricted semantics, legality), `singleton.ts` (exact-phrase
  exceptions, re-derived from oracle text and never a card list), `commanders.ts`
  (eligibility, partners, colour identity), `companions.ts`, `bracket.ts` (advisory only —
  the engine does not import it). Rust supplies **facts** (`DeckCardRow`: per-printing
  `legalities`, `color_identity`, P/T, `ever_uncommon`, `game_changer`); TS draws every
  conclusion. `oldschool` is the one printing-sensitive key, and it comes out right with no
  special case because each row carries its own printing's answer.
- **A deck card's unit price is the nonfoil `usd` key of that printing's `prices` blob** — a
  deck names a printing, not a finish, so nonfoil is the cheapest way to satisfy it.
  `cards.price_usd` is a fallback chain and is never summed, here least of all.
- **Owned is an allocation, never a decrement.** `deck::allocate_deck` deletes and rebuilds a
  deck's rows inside the caller's transaction, greedily and deterministically: exact printing,
  then real copies, then oldest entry. It runs on **a zone write, the Built toggle, or
  `missing_to_wishlist`** — those three and nothing else, which is worth knowing while
  debugging, because pressing "Send missing to wishlist" rebuilds a deck's allocations as a
  side effect. A **built** deck's claims are subtracted from what other decks can see. The
  read clamps with `min(allocation, entry.quantity)`, so stepping a collection row down is
  honest immediately — but **growing the collection does not re-run the allocator**, so a deck
  reads the new copies only after its next allocator run. Known, named, and Plan 6's to close.
- Deck cards ride **`images::prewarm_keys`' UNION** (one arm, `grid` only, like the collection
  and wishlist arms) and the reconciler's **three-table sweep**
  (`collection_entries`, `wishlist_entries`, `deck_cards`).
- **A write to what is *in* a deck goes through a `useDeck` mutation, and `DeckEditor`'s
  `newest([...])` counts six of them** — update (the rename, the cover and the Built toggle),
  add-card, set-quantity, move, missing-to-wishlist, swap-printing. **There is no remove
  mutation**: the tray's drop and the stepper's zero are both `setQuantity(…, 0)`, because zero
  removes a deck row. The deck *row* is a different hook — the gallery's `useDecks` owns create,
  update, remove and duplicate, and `useDeck.update` is that same `deck_update` narrowed to the
  open deck, which is how the Built toggle is one of the six. A refused write re-reads the deck
  through whichever of the six answered last, so a sibling's GONE is what turns the columns
  into the gone paragraph. Two surfaces outside the editor
  borrow a mutation whole rather than defining one — `useSwapFromPane` (the card pane) and
  `useSidebarDrops` (the sidebar's Decks entry) — and **the refusal rule lives on the single
  definition in `useDeck.ts`**, never on a call site: two definitions would be two places to
  keep one rule. The borrowing site owns only its own *reporting* (per-call `mutate`
  callbacks).
- **`deck_swap_printing` is one transaction that folds on `DECK_CARD_GRAIN`.** Swapping a
  row to a printing the same zone already holds is not an error and not two rows: the
  `ON CONFLICT (deck_id, card_id, zone) DO UPDATE` sums the quantities and the answer carries
  `folded: true` with the landed total, which the pane announces ("Folded into one row of 2 in
  Main deck."). It refuses same-printing, a missing from-row (naming the zone), a raced sync
  (the to-printing has left `cards`), and a **different oracle card** — the guard is inside the
  transaction, because "swap this printing" must never become "swap this card".
- **The deck is rows, one view only** (2026-08-06: the stacked-card visual mode and its
  toggle were removed on the user's direction — full card faces at column width were huge,
  and its `STACK_MAX_WIDTH` cap was why zone columns would not take the editor's width). Each
  row carries the printing's **`art` crop** (626×457) as an `aria-hidden`, `alt=""`,
  `draggable={false}` thumbnail sharing the stepper's grid cell — a fourth grid column's gap
  made the 221px squeezed column scroll sideways, and a hidden flex child charges nothing.
  Below 17rem of *column* (a container query on the zone scroller: the 1280px window with the
  card pane docked) the picture yields and the row is the dense text row; orphans are fed
  `null` and never fetch. **A printings row in the card pane is clickable to view that
  printing** — `store.viewPrinting` sets `selectedCardId` *without* clearing
  `paneDeckContext`, so the swap offers survive browsing; `setSelectedCardId` there instead
  silently kills the affordance at its one moment of use.
- **Four card surfaces outside the editor are drag sources, all through the one
  `cardDraggable`**, and the payload they all carry is `{ kind: "card"; cardId; name }` —
  search tiles, collection *table* rows (the collection's **card** mode is not one: only the
  search wall is handed `CardGrid`'s `dragPayload`), **pinned** wishes only (an any-printing
  wish names no printing to drag), and the card pane's printings rows. A zone treats `"card"` exactly as the panel's `"search-card"`: add
  one copy. The remove tray narrows to `"deck-card"`, so a card from another wall never draws
  it. **The sidebar's Decks and Wishlist entries are drop targets**; Decks is inert with no
  deck open, which — because `setActiveView` clears `openDeckId` — is *every* drag started
  from Search, Collection or Wishlist. So the sidebar's Decks target is reachable only from
  inside the Decks view (the docked panel, a deck card, the card pane).

## Hard rules
- Scryfall bulk data is gzipped **JSONL** (one object/line). Old JSON-array endpoints 404.
- Every `api.scryfall.com` request needs real `User-Agent` + `Accept` headers.
- `cards.oracle_id/cmc/type_line` are NULLABLE. `collector_number` is TEXT. Prices are
  decimal strings. `legalities` is JSON (23 keys, grows). Finishes: enum, never boolean.
- npm `xlsx` is banned (CVEs). TypeScript stays on 6.0.x until TS 7.1.
- shadcn components: always `npx shadcn@latest add <x>` with Radix base (components.json).
  The app palette maps `accent` to a **text** colour (gold), so rewrite a vendored
  component's `bg-accent` surfaces to `bg-surface`. `bg-muted` needs no rewrite any more:
  the app's dim text is `--color-dim` and `--color-muted` is the surface shadcn means by it
  (it used to be the dim text, which gave a stock `TabsList` invisible labels).
  `text-muted-foreground` and `text-accent-foreground` already resolve correctly.
- **Dim text is `text-dim`, never `text-muted`** — the latter still compiles and now paints
  text in the surface colour, i.e. very nearly invisible. `src/lib/tokens.test.ts` guards it.
- Card images are served over `mtgimg://` — `<origin>/<variant>/<card_id>/<face>`, where
  the origin is `http://mtgimg.localhost` on Windows and `mtgimg://localhost` elsewhere.
  Variants are **WEBP only** (`thumb`/`grid`/`display`/`art`); the JPG/PNG family is never
  fetched. The handler reads through `db_read`, never the write connection. `app.security.csp`
  is not `null` any more — a new remote source needs a deliberate edit and the
  `the_shipped_csp_allows_ipc_and_images_and_nothing_wild` test updated with it.
- Work on `main`, commit small after each task/step with `feat:`/`fix:`/`chore:`/`test:`.
- Tests: cover logic that can break (parsers, validation, sync). No ceremony tests.

## Working style (user preferences)
- Ultracode/dynamic workflows for large parallelizable work; subagents use Opus 5.
- Superpowers flow: brainstorm → spec → plan → subagent-driven implementation.
