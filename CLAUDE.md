# MTG Grimoire

Portable Windows desktop app for tracking a Magic: The Gathering collection.
Tauri 2.11 (Rust core) + React 19 + TypeScript 6. Single local user, SQLite storage,
Scryfall as the only external dependency.

## Commands
- `npm run tauri dev` — run the app (Vite HMR + Rust rebuild)
- `npm run verify` — build + lint + Vitest + cargo test. **Run before every commit.**
- `npm run test` / `test:run` — frontend tests; `cargo test` in `src-tauri/` — Rust tests

## CI and releases (measured live 2026-08-09)
- Two workflows. **`.github/workflows/ci.yml`** gates PRs and pushes to `main`: a `changes`
  router (below), a `frontend`
  job (`npm run build`/`lint`/`test:run`) and a `rust` matrix over `windows-latest` +
  `ubuntu-22.04` (`cargo fmt --check` on Linux only, `clippy -D warnings` and `cargo test`
  on both, everything `--locked`). **`ci-ok` is the one protected check** — branch protection
  pins names by string and a matrix job's name embeds its matrix values, so the aggregator is
  what has teeth and the matrix underneath stays free. `enforce_admins` is **false**: a red PR
  cannot merge, a direct push to `main` still can, so "Work on `main`" below stays true.
  Proven 2026-08-09 by a deliberate lint error: `frontend` red, both `rust` legs green,
  **`ci-ok` red**. A green pipeline proves nothing about a gate; that run is the proof.
- **A change only builds the half it touched.** The `changes` job diffs against the base
  (`git diff --name-only --no-renames`, so it needs `fetch-depth: 0`) and routes each path:
  `src-tauri/**` → `rust`; `src/**`, `public/**`, `index.html`, the lockfiles and the
  frontend's configs, plus **`scripts/` because `eslint .` lints it** (its ignore list is
  `dist/`, `src-tauri/`, `node_modules/` and nothing else) → `frontend`; `ci.yml` itself →
  both; prose and editor/release bookkeeping → neither; and **anything unrecognised → both**.
  That last arm is the fail-safe that makes the lists safe to be wrong in the cheap
  direction — a new root config file or a new top-level directory gets full CI until someone
  narrows it deliberately. Only the "neither" arm can wrongly skip work, so it stays small.
- **Three traps in that routing, all measured 2026-08-10 against a fixture repo** (24 path
  cases + 11 gate combinations, driven through the shipped script text, not a copy of it):
  (1) a workflow-level `paths:` filter is the obvious implementation and is **wrong** — it
  skips the whole workflow, `ci-ok` included, and a required check that never reports leaves
  every PR merge-blocked forever; the filter has to be a per-job `if:`. (2) `git diff
  --name-only` has rename detection on by default, and it reports a file moved out of `src/`
  as the **destination path only** — so the move would skip the very job whose file just
  vanished. `--no-renames` reports both ends. (3) **`ci-ok` reads a `skipped` build job as a
  pass, so `changes` itself may never be one**: if the router dies both build jobs skip, and
  without the explicit `needs.changes.result == 'success'` line the gate goes green having run
  nothing at all.
- Skipping `frontend` on a Rust-only change gives up nothing CI ever caught: **no test on
  either side reads a file across the boundary.** The frontend's two source sweeps glob
  `/src/**` (`layers.test.ts`, `tokens.test.ts`), vitest only collects `src/**/*.test.{ts,tsx}`,
  and the crate's one `include_str!` is its own `tauri.conf.json`. The TS↔Rust contract in
  `src/lib/ipc.ts` is hand-mirrored and, in its own words, "can drift silently" — that was
  already true when both jobs ran on every commit.
- The `rust` job writes a stub `dist/index.html` first. `tauri-build` reads
  `frontendDist: "../dist"` and fails outright when it is missing, so a Rust-only job cannot
  compile a fresh checkout; the stub is what keeps it parallel with `frontend` instead of
  serialized behind a full Vite build — and it is also why the `rust` job is safe to run with
  `frontend` skipped entirely: the frontend it needs is one file it writes itself.
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
  worse failure**: `boxOf` reads a layout rectangle, and a drop target scrolled out of its own
  scroller's clip still reports coordinates *inside* the window — so a drop dispatched there
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
  what a dwell looks like from outside. A dwell measured from the *last* move undercounts by
  up to **~32 ms**: the approach is three steps 16 ms apart and the enter that arms the timer
  can land on the first of them.
- **A `Log` entry whose `?t=` stamp is frozen at attach time is retained history, not a live
  fault.** Reload with the recorder attached and read the entries that arrive after.

Seed and clean fixtures with `node:sqlite` straight into `src-tauri/target/debug/data/mtg.db`
**while the app holds it** (WAL allows it). Delete every seeded row afterwards — `data/` is
the user's, and it is never committed. Seed **user tables only**: `cards` and `sync_meta`
belong to the sync, and a hand-written row in either makes every later measurement a fiction.

## Storybook (measured 2026-08-09/10, counts re-measured 2026-08-11)
`npm run storybook` · `npm run build-storybook`. **326 stories across 43 story files, 42 docs
pages** — counted off `storybook-static/index.json`, which is the only place the three agree.
**41 of the 43 are `autodocs`**, plus `.storybook/DesignSystem.mdx`: the tag is declared per
file in the meta and `CategoriesPanel`/`TheoryDiffDialog` do not carry it, so those two have
stories and no docs page. A new story file gets neither unless it says `tags: ["autodocs"]`.

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
  `gone`/`deckMeta`/`updateAvailable`/`updateError`. Saying nothing gets `starter` with no
  fault. A fault is set on the world, so a story about `BUSY` shows what the *app* does with a
  refusal rather than what one mocked call returns. **`deckMeta` is the one that refuses
  *reads*** — the six a deck screen makes *beside* the deck (`deck_category_list`,
  `deck_tag_list`, `deck_tag_suggestions`, `deck_folder_list`, `deck_audit_list`,
  `deck_theory_diff`), each in its own Rust sentence, and deliberately not `deck_get`/
  `deck_list`: a screen that could not read the deck would not be showing a panel about it.
- **A world belongs to a story, not to the module — because a docs page mounts every story on
  it at once.** The canvas hides this (Storybook unmounts one story before mounting the next),
  so a fake built on module globals looks right and answers all ten stories of a docs page as
  whichever one installed itself last. The global stays — `src/lib/ipc.ts` imports `invoke` as
  a bare function and no React context travels down an import — but it is a **pointer** at a
  world now, and `.storybook/fake/scope.ts` owns the four ways it is kept right: a per-world
  `QueryClient` binding every `queryFn`/`mutationFn`, an `<Activate>` sibling rendered
  **before** the story so its effect lands first (React fires effects in fiber-completion
  order), `invoke` re-pointing on the way out so an awaited continuation stays put, and one
  `setTimeout` patch for `useSync`'s poll chain. Adding an entry point to the fake means asking
  which of the four covers it. `src/stories.test.tsx` mounts two seeds **simultaneously** and
  is the test that fails if any of this regresses; `.storybook/fake/world.test.ts` covers the
  three unit-testable layers, each proven by breaking it.
- **`useAppStore` is the one global that cannot be made per-story from `.storybook/`** —
  zustand's `create` does not expose its initializer, and the actions close over that one
  store's `set`. So the four story files that write it during render (`AppShell`,
  `CardDetailPane`, `SearchPage`, `CollectionPage`) carry
  `docs: { story: { inline: false, height } }`, which gives each of their docs stories its own
  **frame** and with it its own module graph. `DeckSettingsDialog` carries the same parameter
  for an unrelated reason — its scrim is `fixed inset-0`, so inline it would cover the docs page
  rather than its own block — and the other **36 docs pages render inline**. A new story file
  that writes the store needs the same parameter or its docs page shows one story's view under
  every heading.
- **`images.ts` is handed the installed world's corpus** (`installWorld` → `installCorpus`),
  because the `large` seed mints ~5,200 synthetic printings that a module-load snapshot of
  `CARDS` cannot see — they all drew the "Unknown card" placeholder, which is the affordance
  for *no such printing*. Lookup is the union of the live worlds' cards over `CARDS`.
- **A fixture more than one story file needs lives in `.storybook/fake/fixtures.ts`.** A CSF
  file cannot own one — every non-default export is indexed as a story — but a non-CSF module
  can, and `printing()` had been written out eleven times before it had a home. Not in
  `cards.ts`: that file is generated wholesale and says so.
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
  (236 plays today, in a file of 239 tests — the other three are its own), which is what puts a
  story's own claim inside `npm run verify` —
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

## Talking to Scryfall — the rules, and where they are enforced (read live 2026-08-11)
The two pages that bind this app are `/docs/api/rate-limits` and the "I'm blocked" FAQ. Both
**403 a default HTTP client**, which is itself the first rule: read them with an explicit
`User-Agent`. What they require, and what already satisfies it:

- **`api.scryfall.com` is paced, and there is exactly one place it can be.**
  `scryfall::Client::api_send` is the only way this module issues an API request: it refuses
  inside a lockout, waits out the endpoint's interval, adds `Accept`, and retries. The
  interval table is transcribed from the doc — **500 ms** for `/cards/search|named|random|
  collection`, **10 s** for `/cards/manifest`, **100 ms** for everything else — and is keyed on
  the **path**, because Scryfall hands back absolute `next_page` URLs and a page 2 must take
  the same budget as the page 1 we built. Only the last arm is used today; the other two are
  written down and tested so a future call site cannot quietly take five times its budget.
- **Pacing sleeps, a 429 refuses.** A sub-second wait is invisible and worth taking; parking a
  worker thread for up to five minutes is not, and a second caller could not report its own
  rate limit until the first sleeper woke. Same split `images::Cache::fetch` already made.
- **A 429 is remembered across a restart.** `rate_limit_penalty` clamps to 30–300 s (one
  definition, shared with the image cache's gate), `max` never assignment, persisted to
  `app_meta.scryfall_penalty_until` and restored in `init_state`. Scryfall limits the
  *application*, not the process — "It is not acceptable to ignore HTTP 429 responses", and
  repeat offenders are banned — so restarting must not be a way back in.
- **Retry is for what is nobody's answer**: 5xx, timeouts, connect failures, 3 attempts,
  exponential backoff with jitter. **Never a 429** (the docs forbid exactly that) and never a
  404.
- **Bulk data is already the only card source, and that is the compliance story.**
  `default_cards` JSONL.gz feeds the 116 k corpus; there is no per-card API lookup anywhere.
  `/sets` and `/migrations` stay API calls because neither has a bulk equivalent, and both are
  polled at most once per 24 h. **`/cards/manifest` is deliberately not adopted**: it would add
  traffic rather than remove it, and the research doc measured `created_at`/`data_updated_at`
  as null on every sampled row, so it cannot answer "what data changed" today.
- **The error log is `error_log`, schema v9, and repeats fold.** The grain is
  `(source, operation, kind, message)`; `detail` sits **outside** it because it carries the
  per-occurrence URL that would defeat the folding, and the newest one wins. That is what turns
  the path-MTU incident's ~600 failed fetches into one row reading `×600`. Capped at 200 rows,
  evicting least-recently-seen. `errors::record` returns `()` — it can never fail the thing it
  describes — and is called inside the caller's transaction, so a rolled-back write leaves no
  history, exactly as `deck_audit` does. It carries the five failures that previously reached
  only `eprintln!` (reconcile, orphan sweep, page reclaim, compaction, image store), which in a
  release build has no console to print to.
- **An image's bookkeeping row is owed, not optional.** It used to be written under a
  zero-wait `try_lock` and *dropped* when the write connection was busy — which during an
  ingest it is, for all but the gaps between its 2 000-row batches. Nothing retried it, so the
  bytes sat on disk that `is_current` would never vouch for and **every later request refetched
  them for the life of the installation**. The row is now queued in `Cache::pending` and paid
  off by whichever later call finds the connection free, with a flush at exit beside the WAL
  checkpoint. The module's old doc comment called this "one extra request"; it was not.
- **Freshness is the URI, and that is the whole rule.** `is_current` compares the stored
  `source_uri` character for character, and Scryfall's `?<epoch>` cache-buster **equals**
  `image_updated_at` — so "has the art been updated more recently than ours" needs no clock and
  no mtime. A re-scanned card refetches; nothing else does.
- **Every deck surface draws `art`, and both warming paths used to produce `grid`.** Measured
  against the live database 2026-08-11: all 17 deck cards had a `grid` row, **12** had an
  `art` one, and with an empty collection and wishlist the `deck_cards` arm was the *only* work
  pre-warming had to do — so it warmed a variant no deck surface asks for, while
  `prewarm_keys`' own comment said the arm existed for the deck builder. `art` is a different
  URL on the CDN, so a 100 %-warm `grid` cache contributed nothing: the builder fetched every
  tile cold, from plain scrollers that mount every row at once against 16 permits, and on a
  slow link that reads as timeouts. `prewarm_keys` now pairs each arm with the variant its
  screen draws (`COLLECTION_PREWARM`/`DECK_PREWARM`), and `DeckEditor`/`DecksPage` call
  `prefetchImages(ids, "art")` the way `SearchPage` calls it with `"grid"`. **A card that is
  both owned and in a deck is two keys now, not one** — two screens, two pictures.

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
- **The search collapses printings into one row per card, and `idx_cards_collapse` is what
  pays for it.** Measured 2026-08-11 through `run_search` itself (release build, read-only
  copy of the live corpus, medians of five): **today's un-indexed browse 397 ms** (`SCAN c`,
  a full table scan) → **25 ms uncollapsed** and **145 ms collapsed** with the index. The
  index is worth more than the feature it was added for — every uncollapsed search gets that
  16× for nothing — while grouping 107 337 rows into 37 553 costs ~120 ms on top. 14 MB,
  0.7 s per sync, and it lives in `schema::CARDS_INDEXES` like every other index on `cards`.
- **Time the query the app runs, not a transcription of it — and when a change adds an index,
  measure the before-state with the index too.** The first draft of that table was wrong in
  exactly that way: the uncollapsed baseline was taken before the index existed and the
  collapsed figures after, which credited the grouping with a 2.3× win the index had paid
  for. A `#[test]` calling `run_search` found it in one run.
- **The collapsed shape is a `GROUP BY` step that also computes the representative's id, then
  a primary-key join back.** `substr(max(coalesce(released_at,'0000-00-00') || id), 11)` is
  the newest printing's id — the date is fixed-width, so the concatenation orders as
  `released_at DESC, id DESC` and the id starts at character 11. That is 108 ms against
  767 ms for joining on the group key, and against **2 486 ms** for the obvious
  `row_number() OVER (PARTITION BY …)`, which stays slow even with the index.
- **The group key is `coalesce(c.oracle_id, c.id)`, and the status subqueries must *not* be.**
  `oracle_id` is nullable, so a bare `GROUP BY c.oracle_id` merges every null-oracle printing
  into one card — silently, with a printing count and price range spanning unrelated cards.
  Null-safety costs 69 ms and no live row needs it (0 of 116 590); it is spent because the
  failure is invisible. But `owned`/`wishlisted` probe **`c.oracle_id` on the joined
  representative row**: written against the group key instead they cost **1 514 ms** on the
  browse and **12 729 ms** on the rarity sort, because `coalesce(…)` is not indexable and all
  37 553 groups then re-scan `cards`. An *expression* index does not rescue it either —
  SQLite scans one but will not treat it as covering (700 ms).
- **`bm25()` cannot be aggregated.** `min(bm25(…))`, the same expression in a subquery, and an
  ordinary CTE all fail with *"unable to use function bm25 in the requested context"*; only
  `WITH … AS MATERIALIZED` works, so that keyword is load-bearing syntax. FTS5's `rank` column
  *does* aggregate and carries the table's default weights, which would silently discard this
  app's 10× name weighting. The CTE is built **only for ranked searches** — wrapping an
  unranked browse in a `MATERIALIZED` CTE would materialise all 107 k paper rows.
- Collapsed, `set`/`rarity`/`type` are the **representative's** columns, so the group step
  gives up its `LIMIT` and the sort runs after the join: 670 ms on a completely unfiltered
  browse, 88 ms with any text. Name and price are answered by the grouping itself (145/150 ms).
- **Art series outrank the card they depict, and collapse does not fix it.**
  `Lightning Bolt // Lightning Bolt` (`astx 76s`, `layout='art_series'`) held the phrase twice
  in its name field and bm25 rewarded it; art series carry their own `oracle_id`, so grouping
  leaves them as their own rows. One `CASE` term at the front of the **relevance fallback
  only** fixes it at 0.2 ms — a ranking nudge, never a filter, and an explicit sort is left
  exactly as the reader asked for it. `min()` over that term is exact because no oracle group
  mixes the two kinds: 3 610 groups are represented by an art or token row and **0** of them
  also contains a real printing.
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
- **Schema is v9.** v9 adds `error_log` — see "Talking to Scryfall" below. v8 replaced
  `deck_cards.zone` with a user-owned category and added the
  deck's four new tables — the paragraph under "Hard rules — decks" describes it. v7 re-runs
  `cards_indexes_sql()` to add `idx_cards_collapse` to databases that migrated before it
  existed — every statement in `CARDS_INDEXES` is `IF NOT EXISTS`, so the step is "bring the
  index list up to date" and is idempotent. (v6 added `app_meta`; the paragraph below
  describes v5.)
- v5 added the four deck tables (`decks`, `deck_cards`, `deck_allocations`
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
- **`mtgimg://` has a second route, and it touches Scryfall not at all: `/cover/<deckId>`.**
  `images::serve` tries `parse_cover_path` **first**; it cannot collide with the card route
  because `Variant::parse("cover")` is `None`. The bytes are a file the user picked, re-encoded
  by `images::encode_cover` (magic-number sniff, `resize_to_fill` to the `art` crop's **626×457**,
  lossless WEBP, source capped at `MAX_COVER_SOURCE_PIXELS`) and written to
  `<data dir>/covers/<deckId>.webp`. **The route resolves that directory itself** — `decks
  .cover_image_path` is a record of what was written, not what is read, which is what keeps a
  portable install working after its folder moves. Served `no-store`, because it is the one image
  URL whose content is *meant* to change under a fixed name; **404 when absent, never a
  placeholder**. The `i64` parse is the whole path-traversal fence, since the id becomes a
  filename (`a_cover_path_is_parsed_or_refused_and_never_repaired` pins `/cover/../../mtg.db`,
  `/cover/..%2fmtg.db`, `/cover/7/8`, `/cover/7.webp`).
- **The CSP did not change for it, and that is the point.** `img-src 'self' data: mtgimg:
  http://mtgimg.localhost` already covered a fifth *path*; a route is not a source.
  `images::tests::the_shipped_csp_is_untouched` asserts both the exact `img-src` and that the
  policy does not mention `cover` at all. Measured 2026-08-11 in the shipped window: with no file
  on disk the URL errors, and after one `deck_set_cover_image` the same URL loads **626×457 in
  2 ms**.

## Frontend design (binding)
- **All frontend work follows the `frontend-design` skill** (invoke it before UI tasks) and the
  visual direction doc: `docs/superpowers/specs/2026-08-04-visual-design-direction.md`.
  Implementers execute that direction (palette, type, mana line, filter chips) — they do not
  invent their own. Mana/set symbols come from the bundled `mana-font`/`keyrune` npm packages,
  never a CDN.
- Global actions (Refresh, sync status, future settings) live in the top ribbon, not in views.
- **The ribbon says what the app is doing, and it is a registry rather than a sync.** A long
  job registers an `Activity` (`src/lib/activity.ts`) — key, rank, label, `detail`, value —
  through `useRegisterActivity`, and the lowest rank wins the row (`RANK.sync` 0 beats
  `RANK.update` 10; ties break by insertion order, because two hooks' effects run in an order
  nobody chose). The store is created per `ActivityProvider`, at the top of `AppShell` and
  above `children`, so a job started inside a view needs no wiring — and so it never becomes a
  second `useAppStore`, the one global Storybook cannot make per-story. Registration is
  **declarative**: pass the job or `null` every render, and a job cannot outlive the component
  describing it. `put` is identity-in-identity-out when nothing moved, which is what lets the
  register-every-render form cost nothing.
- **The mana line reacts instantly and the sentence waits `ACTIVITY_DELAY_MS` (400 ms).**
  Measured in the shipped window 2026-08-11, sampling the row every 40 ms across a forced
  Refresh: **bar at 121 ms, sentence at 523 ms** — the gate, to 2 ms. The gate is on the
  *slot*, not the job, so a sync handing over to an update download swaps the sentence
  without the row blinking. `useDelayedFlag` turns **off** by adjusting state during render
  rather than in an effect: an effect would clear it one commit late, and
  `react-hooks/set-state-in-effect` rejects the synchronous call outright — the lint rule and
  the correct behaviour agree here.
  **It does not suppress a no-op Refresh, and the design note claiming it would was wrong.**
  That whole run measured **1.4 s**, so "Checking for card data updates" was up for ~1.0 s
  before "Already up to date" replaced it. 400 ms filters a *flash*, not a short run — and a
  second of the app naming what it is checking is the good case, not the one to design out.
- **The live phase sequence, measured 2026-08-11 over a real ingest** (116,695 cards, bulk
  file of 2026-08-10): `Importing cards · 94,000 cards` → `Reclaiming disk space · 66%` (the
  one true percentage, climbing) → `Updating set list` → **`Syncing card data`** →
  `116,695 cards · data from 2026-08-10`. That fourth step is the generic fallback and is
  correct rather than a bug: `done` is a terminal phase, and `busy` stays true until the
  status poll catches up, so for up to a second the row honestly says a sync is still
  finishing. The mana line has always done exactly this; nobody had seen it in words before.
  At 1024 px, with the longest realistic sentence
  (`Downloading update 0.3.0 · 12 / 40 MB`), the ribbon row measures 816 px and the body does
  not scroll sideways.
- **The status line is one permanently mounted `role="status"`, and the number inside it is
  `aria-hidden`.** Mounted because a live region that first appears with its sentence already
  inside announces nothing (the sidebar drop report's lesson). The number is hidden because a
  live region announces its accessible text and skips `aria-hidden` subtrees: the label
  changes ~4 times a sync, the ingest's count ~58 times, and the mana line's `aria-valuenow`
  is where a fraction belongs. **`getByText` matches an element's own text nodes**, so a test
  asserting the whole sentence reads `toHaveTextContent` off the line, never a combined
  string matcher.
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
- **An `art` crop has no printed frame, so wherever one is shown the illustrator must be
  credited.** Scryfall's image policy, quoted in full at
  `docs/superpowers/plans/2026-08-04-02-images-card-browsing.md:55`: use the art crop and the
  artist's name must appear elsewhere in the same interface. A `grid`/`thumb`/`display` image
  carries the printed credit itself and needs nothing; the 626×457 `art` variant does not.
  This has been ruled on twice and is written here because four surfaces cite it as living
  here. Two consequences hold everywhere a **cover** is drawn — the gallery's deck tiles, its
  folder strips and `DeckSettingsDialog`'s `CoverPreview`, all three of which print the
  artist: **a card cover whose artist is unknown is not drawn at all** (`DeckRow.coverArtist`
  is `null` when `cards` has no row for that printing; the orphan heals on the next sync rather
  than being shown uncredited), and **a custom cover carries no artist and needs none**,
  because the rule is Scryfall's and a user's own file is not Scryfall's — which is also why a
  folder strip drops custom covers rather than crediting some of its tiles and not others.
  **The standing gap, recorded rather than quietly inherited** (`DeckSettingsDialog.tsx`'s
  `ChoiceTile` doc): four surfaces draw the crop with no credit — the deck's stack rows
  (`CardStack`), its grid tiles (`views/GridView`), the theory diff's rows and the cover
  picker's own tiles — because `DeckCardRow` carries no per-row `artist`, and a picker stricter
  than the views it picks *from* would be an inconsistency a reader can see where this one is
  not. Every one of those crops sits inside a control that names the card, and the card pane
  credits the illustrator ("Illustrated by …"). Closing it for all four at once is one column
  on `DeckCardRow`. Never distort, blur, recolour or watermark a card image, and never crop off
  a printed credit.
- **A card frame is `components/CardArt`** — the 5:7 box, `CardImage`, `useImageRetry`, the
  no-art fallback and the foil marking, in one place. Five surfaces draw a card and each had
  rebuilt part of it. The card pane's main art is the deliberate exception: it keeps a flip
  fade, a bespoke "no image yet" panel and no retry hook, so it borrows only `FoilOverlay`.
- **The foil marking states what the object *is*, never what it could have been.**
  `soleFinish` marks a printing that leaves no choice — 12 366 foil-only and 892 etched-only
  paper printings — and never the 53 224 that merely *have* a foil version, which would put a
  sheen on 61 % of every wall. A collection row passes its entry's own stored finish instead;
  a deck row gets the glyph rather than the sheen, because its picture is a 48×36 art crop
  where a gradient is a smudge.
- **`mix-blend-mode: overlay` is invisible over card art, and only a screenshot says so.**
  The first foil sheen was a rainbow gradient at 12 % in `overlay`; magnifying one foil tile
  over CDP and shooting it with the sheen shown and hidden produced **indistinguishable
  images** — `overlay` preserves luminance and only nudges hue, which on saturated art is no
  signal at all. 30 % changed nothing worth seeing and `color-dodge` blew the highlights out.
  What works is **`screen` with a specular band**: low-alpha rainbow stops (0.10–0.13) either
  side of one white stop at 0.34, 41 % along a 115° sweep — the streak is what the eye reads
  as "shiny", and being narrow it obscures almost nothing.
- **A mark drawn *inside* the tile's button joins that button's accessible name.** The foil
  chip did, and a wall of foils became buttons called "Consecrated Sphinx Foil" — measured in
  the shipped window, where a tile button's name came back as bare "Foil". The whole
  `FoilOverlay` is `aria-hidden` now and the finish is stated in text where each surface has
  room (the wall's caption `sr-only`, the search table's Name cell, the pane's per-finish
  prices). This is the same rule the owned badge follows by being a *sibling* of the button.
- **`loading="lazy"` belongs on a plain scroller, not on a virtualised one.** `CardGrid` had
  it against "117 k results is 117 k requests", which the virtualiser had already made false
  — the wall mounts the rows on screen plus two, about two dozen images — so the browser's
  gate only delayed the pictures about to be looked at. **The deck feature's plain scrollers
  keep it**: the stack and grid views (`CardStack.tsx`, `views/GridView.tsx`), the gallery's
  deck tiles and folder strips (`DecksPage.tsx`), the theory diff (`TheoryDiffDialog.tsx`) and
  the cover art picker (`DeckSettingsDialog.tsx`) — where a 100-card list really is 100 mounted
  rows. (It used to say "the deck zone columns", a component the rebuild deleted.)
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
- **The ladder is `raised 10 < header 20 < popup 30 < dragTray 40 < overlay 45 < gate 50`**, and
  `layers.test.ts` asserts every link of it. **`overlay` is one rung for a drawer *and* a modal,
  deliberately, where two looks more careful**: the deck editor's four full-window surfaces —
  Categories & tags, History, Theory diff, Deck settings — are held in **one** piece of state
  (`DeckEditor`'s `Layer` union) because `useDismissOnEscape` orders exactly two rungs, and two
  `"inner"` peers open at once are not ordered at all. At most one of the four is ever mounted,
  so there is no pair for a second number to order and inventing one would be a claim about a
  stack that cannot occur. They used to borrow `gate` and `dragTray` two apiece — each right in
  effect and wrong in name. Measured 2026-08-11 in the shipped window: the scrim computes to
  `z-45`, one Escape closes the overlay and leaves the card pane open, a second closes the pane,
  and each hands focus back to the control that opened it.
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
- **Enforced foreign keys exist only *between user tables*, never against `cards.id`** — a
  declared `REFERENCES cards(id)` aborts every sync, because `swap_staging` drops the table.
  The `ON DELETE` action is chosen per delete-site, not fixed once. **CASCADE** on
  `deck_cards.deck_id`, `deck_cards.category_id`, `deck_allocations.deck_id`,
  `deck_allocations.collection_entry_id`, `deck_categories.deck_id`, `deck_tags.deck_id`,
  `deck_audit.deck_id` and `deck_folders.parent_id`: a deleted deck's cards and reservations,
  a deleted category's cards and a deleted folder's sub-folders have nowhere else to be.
  **SET NULL** on exactly two — `decks.folder_id` (a folder is a filing decision; the decks in
  it are the user's work, not the folder's to take down) and `deck_cards.tag_id` (deleting a
  tag must never delete a card). `schema.rs`'s module doc carries this list; check it against
  the DDL rather than trusting either copy. CASCADE is also right at the app's one **non-user**
  delete: `reconcile::fold_into_existing` repoints every allocation onto the surviving entry
  *before* the DELETE, so that cascade fires over nothing.
- **Schema v8 replaced the zone with a category the user owns.** `deck_cards.category_id`
  points at a `deck_categories` row they name, reorder, switch off and delete; the fixed word
  survives only as that row's **`kind`** — `main | side | commander | companion | maybe`,
  `schema::CATEGORY_KINDS`, CHECK-constrained in SQL and narrowed in TS as `CategoryKind`.
  **The name is the user's; the kind is what the rules read.** Four kinds get one predefined
  category per deck (`schema::PREDEFINED_CATEGORIES` — Commander, Sideboard, Companion,
  Maybeboard, seeded by `deck_meta::ensure_predefined_categories` and by the v8 backfill);
  there is deliberately **no predefined `main`**, because a deck may own any number and the
  pile a plain add lands in is found-or-created by name (`deck_meta::category_for_name`).
  **Deck cards side with the wishlist: `CHECK (quantity > 0)`, so zero removes the row.**
- **The grain is `deck_id, variant, category_id, card_id`** (`schema::DECK_CARD_GRAIN`) — the
  same printing in two categories is two rows, added twice in one is one row with the sum, and
  `variant` widens it again: `live` is what is sleeved up, `theory` is what the deck is being
  built toward (`schema::DECK_VARIANTS`), so a change tried out in Theory can never silently
  overwrite the deck as it stands. Every card command takes both.
- **`is_active = 0` is the whole of what `maybe` used to mean.** An inactive category counts
  toward nothing — not size, not copies, not legality — and `allocate_deck` claims no copy for
  it. The Maybeboard is not a special case in five files any more; it is one seeded row with
  the flag off, and a category of the user's own that they switch off behaves identically.
  **Nothing anywhere may branch on the kind being `maybe`** — that was measured: the old shape
  looked correct and was wrong the first time a user deactivated a pile of their own.
- **Which totals a pile lands in: the switch decides whether it counts at all; the kind
  decides only whether it is played *beside* the deck or *in* it, and only `side` and
  `companion` are beside it** (CR 100.4a; EDH's companion is "effectively a 101st card"). So
  `SIZE_KINDS` is `main`, `commander` **and `maybe`** — written in three places that must stay
  one rule: `engine.ts`'s constant, `deck.rs`'s `DECK_SELECT` subquery behind
  `DeckRow.card_count`, and the Storybook fake's copy. Leaving `maybe` out is the incoherent
  version, not the smaller one: an *active* Maybeboard was then inside the format's card pool
  and inside the binder's reservations but outside the size, so a second Sol Ring in it raised
  a singleton error under a figure that still read 100.
- **`allocate_deck` claims for the `live` variant only** — a plan reserves nothing. And
  **`deck_allocations` carries no variant column**, which is the trap: a `theory` read walks
  the *live* deck's stored claims, so `attribute_owned` filters `variant == LIVE` explicitly.
  Without that filter a plan is handed the copies the sleeved deck reserved, and it type-checks
  perfectly (`the_allocator_claims_nothing_for_the_theory_variant`).
- **`deck_get(id, variant)` scopes the cards, and every number counted over them, and nothing
  else.** All categories and all tags come back whatever the variant — an empty category still
  draws its column, an inactive one always draws — but a category's *and a tag's* `card_count`
  read the variant asked for. Threading it into `list_categories` and not `list_tags` is
  exactly how they came to disagree once.
- Category and tag writes live in **`deck_meta.rs`**, and **two of them reallocate**:
  `set_category_active` (the flag is the whole of what the allocator allocates *for*) and
  `delete_category` (the cards leave, or land under a category with a different flag). A
  rename, a reorder and every tag write change what a pile is *called* and claim exactly what
  they claimed before.
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
  deck's rows inside the caller's transaction, greedily and deterministically: `KIND_PRIORITY`
  (`commander, main, side, companion, maybe` — a tie-break preference only, since `is_active`
  decides what is allocated for) then row id, and within a card, exact printing, then real
  copies, then oldest entry. It runs on **a card write, the Built toggle, `missing_to_wishlist`,
  `set_category_active` or `delete_category`** — those five and nothing else, which is worth
  knowing while debugging, because pressing "Send missing to wishlist" or switching a pile off
  rebuilds a deck's allocations as a side effect. A **built** deck's claims are subtracted from
  what other decks can see. The
  read clamps with `min(allocation, entry.quantity)`, so stepping a collection row down is
  honest immediately — but **growing the collection does not re-run the allocator**, so a deck
  reads the new copies only after its next allocator run. Known, named, and Plan 6's to close.
- Deck cards ride **`images::prewarm_keys`' UNION** (one arm, `grid` only, like the collection
  and wishlist arms) and the reconciler's **three-table sweep**
  (`collection_entries`, `wishlist_entries`, `deck_cards`).
- **The audit log records facts; TypeScript writes the sentence.** `deck_audit` has no `summary`
  column and never will — it holds `kind` (one of `add|remove|quantity|move|swap|tag|category|
  folder|deck`, `schema::AUDIT_KINDS`), `variant`, a soft `card_id`/`card_name`, a **JSON
  `payload`** (`CHECK (json_valid(payload))`) and a signed `delta` for the day header's roll-up.
  `src/features/decks/auditText.ts` is the only thing that reads that payload, and it is the only
  thing that words it — because a sentence is domain logic and this table has to survive the day
  the wording changes. Verified live 2026-08-11: a category move stored
  `{"from":"Main deck","to":"Ramp"}` with `card_name` `"Vampiric Tutor"` and `delta` 0, and the
  drawer read back "Moved Vampiric Tutor / Main deck → Ramp".
- **Writing history is not a command.** There is no IPC write — `deck_audit::record(tx, …)` is
  called *inside the caller's already-open transaction*, which is what makes
  `a_recorded_change_that_rolls_back_leaves_no_history` and `a_refused_write_leaves_no_history_
  behind` true rather than hoped for; `every_deck_write_leaves_exactly_one_audit_row` drives
  **23** cases and asserts exactly one row each (count the list in `deck_audit.rs`, never a
  remembered number — it has been written down wrong twice). "Exactly one" is per
  *command*, not per field: **`deck_update` records one row per changed field**
  (`record_deck_edit`, pinned by `a_patch_that_changes_two_fields_records_both`), and it
  satisfies that test only because every one of its cases changes exactly one field. The only
  command is the read, `deck_audit_list(deckId, limit)`, and its limit is `clamp(1, 500)` —
  **the low end is load-bearing, because SQLite reads a negative `LIMIT` as no limit at all.**
  It is append-only, never pruned and **not undoable**; `AuditDrawer.tsx` has no mutation in it.
  **Six writes record nothing on purpose**: `delete_deck` (CASCADE takes the history with the
  deck, so a row would be orphaned by its own event); **both** `missing_to_wishlist` commands,
  `deck`'s and `deck_theory`'s (they write the wishlist, not the deck); and **three of the four
  folder writes** — create, rename and move — because a folder belongs to no deck and
  `deck_audit.deck_id` is `NOT NULL`. `deck_folder_delete` is the fourth and is **not** exempt:
  `decks.folder_id` is `ON DELETE SET NULL`, so it re-files N decks and writes one `folder` row
  per deck it un-filed.
- **The six card commands, and what each takes.** `deck_get(id, variant)`;
  `deck_add_card(deckId, cardId, categoryId, categoryName, variant, quantity)` — **either an id
  or a name**, id wins when both arrive, neither is refused in words, and the name is
  found-or-created (the word being TypeScript's `autoCategoryFor` to compute, because which
  pile a card belongs in is domain logic); `deck_set_card_quantity(deckId, cardId, categoryId,
  variant, quantity)`; `deck_move_card(deckId, cardId, fromCategoryId, toCategoryId, variant)`,
  which stays inside one variant; `deck_swap_printing(deckId, fromCardId, toCardId, categoryId,
  variant)`; `deck_missing_to_wishlist(deckId)`, which reads `live` and skips inactive
  categories. Two fences every write opens with, **neither of them enforced by the DDL**: the
  variant must be one the schema knows, and the category must belong to *this* deck —
  `deck_cards.category_id`'s FK only asks that the category exist, not whose it is.
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
  row to a printing the same category already holds is not an error and not two rows: the
  `ON CONFLICT (deck_id, variant, category_id, card_id) DO UPDATE` sums the quantities and the
  answer carries `folded: true` with the landed total, which the pane announces ("Folded into
  one row of 2 in Main deck." — the category's own name, out of `paneDeckContext`, which
  carries a category id **and** its name because the pane is a sibling of the editor and has no
  category list to translate an id through). It refuses same-printing, a missing from-row
  (naming the category), a raced sync (the to-printing has left `cards`), and a **different
  oracle card** — the guard is inside the transaction, because "swap this printing" must never
  become "swap this card".
- **The deck has four views** — `Stacks | Table | Text | Grid`, `DeckEditor`'s `VIEWS`, crossed
  with three `Group by` modes (`category | manaValue | type`) and four sorts (`alphabetical |
  manaCost | price | type`). All twelve combinations were driven live 2026-08-11; grouping and
  sorting were correct in every one, and an **inactive category stays its own group in all three
  grouping modes** rather than being folded in by mana value or type. Only `Stacks` and `Grid`
  fetch art (`cardImageUrl(…, "art")`); `Table` and `Text` are text and draw no picture at all —
  which is why the old single-row view's thumbnail, its `17rem` container query and
  `STACK_MAX_WIDTH` are gone rather than moved.
- **`CardStack` is the signature interaction, and it is arithmetic, not taste.** A card is
  **312px** (30px title bar + 256px art + 24px data line + 2 hairlines); collapsed it carries
  `mb-[-278px]`, so each card advances the stack by exactly **34px** — its title bar. The list is
  given a **fixed** `stackHeight(n) = 34(n−1) + 312 + 8`, and the lifted card's `hover:mb-2`
  turns −278 into +8: **a 286px push-down of every card after it, out of the box and over what is
  below, without the box changing size.** Measured in the shipped window 2026-08-11 (see the live
  pass below) — heights matched the formula exactly for stacks of 1, 2, 5, 6, 8 and 10, and the
  push-down measured 286px with the list's height unchanged. **The lift is pure CSS**
  (`hover:` + `focus-within:`, `LAYER.raisedOnHover`/`raisedOnFocus`), so nothing in JavaScript
  knows which card is up and the caret gets the interaction for free. The 2026-08-06 removal of
  the *old* stacked mode is not contradicted: that one drew full card faces at column width, and
  this one draws a column of 34px title bars.
- **A printings row in the card pane is clickable to view that printing** —
  `store.viewPrinting` sets `selectedCardId` *without* clearing `paneDeckContext`, so the swap
  offers survive browsing; `setSelectedCardId` there instead silently kills the affordance at its
  one moment of use.
- **Four card surfaces outside the editor are drag sources, all through the one
  `cardDraggable`**, and the payload they all carry is `{ kind: "card"; cardId; name }` —
  search tiles, collection *table* rows (the collection's **card** mode is not one: only the
  search wall is handed `CardGrid`'s `dragPayload`), **pinned** wishes only (an any-printing
  wish names no printing to drag), and the card pane's printings rows. A category column treats `"card"` exactly as the panel's `"search-card"`: add
  one copy. The remove tray narrows to `"deck-card"`, so a card from another wall never draws
  it. **The sidebar's Decks and Wishlist entries are drop targets**; Decks is inert with no
  deck open, which — because `setActiveView` clears `openDeckId` — is *every* drag started
  from Search, Collection or Wishlist. So the sidebar's Decks target is reachable only from
  inside the Decks view (the docked panel, a deck card, the card pane).

## Deck builder, driven in the shipped window (measured 2026-08-11)
The whole rebuild had been proven by tests and by Storybook, and **neither runs in the window
that ships**. This is what a CDP pass over the real WebView2 added, and the three bugs it found
are all things no suite could have seen.

- **The stack's push-down is real**: hovering a card moved its `margin-bottom` −278px → **8px**
  and pushed every later card down by exactly **286px**, while the list's height stayed **490px**
  across the whole gesture. `stackHeight` matched the formula for every stack on screen.
  **Hovering a *middle* card means pointing at its title bar** — the cards overlap, so at any y
  the topmost card is the last one whose top is above it, and `hover`'s default approach (from
  directly above the element) lands on the *first* card of the stack and lifts that instead. Aim
  at `li > button > span:first-child`, and approach sideways with `--from`.
- **Reduced motion holds**: `transitionProperty` is `none` on the stack card and on the view
  buttons under `prefers-reduced-motion: reduce`, while `transitionDuration` still reads `0.15s`
  — the exact false failure the harness section warns about, reproduced here on purpose.
- **Both drags work with a real Chromium drag**, carrying pdnd's `application/vnd.pdnd`: a card
  from one category to another (the target lit `border-accent` mid-flight; "Vampiric Tutor" moved
  Main deck 10→9, Ramp 6→7 and survived the re-read) and a **deck tile onto a sidebar folder**
  (folder 0→1, tile left "All decks"). **What that does not prove**: `Input.setInterceptDrags`
  bypasses the OS drag loop entirely, so this is evidence about the app's own handlers and *not*
  about WRY's OLE drop target. `"dragDropEnabled": false` remains the load-bearing fact, it is
  embedded at **compile time**, and this exe was built from it.
- **A category move is delete + insert, not an update** — the `deck_cards` row id changes. Worth
  knowing before writing anything that holds one across a move (and it is why restoring a moved
  row by id after a live pass silently does nothing).
- **The allocator's triggers behave exactly as documented.** Seeding `collection_entries`
  directly left the deck reading "66 of 66 missing" with `deck_allocations` empty; the first
  category write rebuilt it (11 rows) and the shortage marks vanished from precisely the owned
  cards. A card in an **inactive** category shows no shortage mark at all, because nothing was
  claimed for it.
- **Console over the whole pass: clean.** 377 recorded lines, no JavaScript error, no React
  warning, no unhandled rejection. Everything else was `502` from `mtgimg://` — see the
  unverified note below.

**Three bugs found, all open** (none fixed in this pass):
1. **The editor's title row collapses the deck name to 18px and overflows into the format
   select, at the app's own default window.** The row is `flex min-w-0 flex-1` holding the name
   input (`shrink: 1`) beside two `shrink-0` children — the Live/Theory group (102px) and the
   "N cards differ" button (107px) — which together already exceed the container, so the input
   absorbs the entire deficit. Measured: name width **18px at 1100, 1200 and 1280**, and the
   container overflowing by **202px / 102px / 22px** respectively; `overflow` is `visible`, so at
   1280 the button's last **9.9px** is painted over by, and hit-tests to, `select[aria-label=
   "Deck format"]`. Fine at 1360 (76px) and above, and fine at 1024 (459px) where the toolbar
   wraps — so the broken band is roughly **1060–1350px and the shipped 1280×800 sits inside it**.
   Only bites when `theory_enabled` is on, which is why nothing caught it.
2. **A custom deck cover never appears in the gallery.** `DecksPage`'s `Cover` takes only
   `cardId` and builds `cardImageUrl(cardId, 0, "art")`; it has no `custom` arm, never reads
   `deck.coverKind` and never forms the `/cover/<deckId>` URL that `DeckSettingsDialog` uses. So
   a deck with `cover_kind = 'custom'` and a real file on disk renders **"No cover"** on the tile
   — the one place the picture exists to be seen — while the settings dialog you chose it in
   shows it correctly. Confirmed after a full reload, with the route itself proven working.
3. **Table view starves the card name.** Seven fixed columns take **696px of 963px**, leaving the
   two `fr` columns 147px between them: **Card name gets 84px** (`minmax(0,2fr)`) and Type 63px,
   truncating names to ~10 characters, while the empty Tags column holds 112px and Owned 64px.

**Unverified, and not by choice:**
- **Card art could not be rendered at all.** `cards.scryfall.io` was unreachable from this
  machine (a bare HTTPS HEAD times out; `api.scryfall.com` answers), so every fetch failed and
  `data/images` was never created. What this *does* prove is that the `mtgimg://` handler is
  registered and routing — the failures were the app's own **502**, its documented "failed
  fetch", not a browser-level protocol error — and the `/cover/` route needs no network and was
  verified end to end. But **no card image has been seen decoding in this build.**
  **Diagnosed 2026-08-11, and it is not the app: a path-MTU black hole.** The host is *not*
  unreachable — DNS answers (OVH, `57.130.33.1`/`15.204.104.240`, not Cloudflare like the API
  host) and the TCP connect completes in **51 ms**. The TLS handshake is what never finishes:
  `ping -f -l 1472` to it gets no reply where `-l 1440` does, so the path carries ~1 468 bytes
  and swallows the ICMP that would say so, and the server's certificate flight — a full-size
  segment — vanishes. curl, Node and reqwest all stall identically at the same point, after
  ALPN and before ServerHello. **The tell is which half of the app breaks**: card *data* syncs
  fine because `api.scryfall.com` rides a different path, while every picture hangs. Before
  suspecting the image cache, probe the MTU. Nothing in this repo can fix it; lowering the
  interface MTU (or clamping MSS) can.
- **The system file picker was not driven.** `dialog:allow-open` opens a native window that CDP
  cannot reach, so `deck_set_cover_image` was exercised by invoking the command directly with a
  path. The encode → write → serve → render half is measured; **the picker → path half is not.**
- **Linux remains entirely unrun**, as everywhere else in this file.
- Scryfall bulk data is gzipped **JSONL** (one object/line). Old JSON-array endpoints 404.
- Every `api.scryfall.com` request needs real `User-Agent` + `Accept` headers.
- `cards.oracle_id/cmc/type_line` are NULLABLE. `collector_number` is TEXT. Prices are
  decimal strings. `legalities` is JSON (23 keys, grows). Finishes: enum, never boolean.
- npm `xlsx` is banned (CVEs). TypeScript stays on 6.0.x until TS 7.1.
- **`@tauri-apps/plugin-dialog` is here for exactly one thing — choosing a deck cover — and the
  capability says so.** `capabilities/default.json` grants **`dialog:allow-open`**, one command,
  not `dialog:default`'s five: save, message, ask and confirm are unreachable from the webview
  however the plugin is initialised. The contract that makes this enough is that
  `deck_set_cover_image` takes a **path**, not bytes — the page asks for a name and Rust opens
  the file, so no filesystem permission of any kind is needed. **`tauri-plugin-fs` and `rfd`
  entered `Cargo.lock` transitively** as that plugin's own dependencies and are **unreachable**:
  `tauri_plugin_fs::init()` is never called (the three registrations are single-instance, opener
  and dialog) and **no `fs:` permission is granted anywhere**, so the ACL would deny them even if
  it were. Adding a plugin means adding its narrowest permission, never its `:default`.
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
