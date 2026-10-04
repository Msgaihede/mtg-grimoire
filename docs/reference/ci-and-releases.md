# CI and releases

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- Four workflows — the third, **`scanner-bundle.yml`** (2026-09-15), builds and publishes the
  card scanner's embedded assets and is recorded in [card-scanner.md](card-scanner.md) §10; the
  fourth, **`android-emulator.yml`** (2026-10-03), measures the light app's first run and has one
  bullet below, beside the `android` job; this page covers the other two.
  **`.github/workflows/ci.yml`** gates PRs and pushes to `main`: a `changes`
  router (below), a `frontend`
  matrix (below — one leg for `npm run build` and `lint`, four for `test:run --shard`), a
  `storybook` job (`npm run build-storybook`), a `rust` matrix over `windows-latest` +
  `ubuntu-22.04` (`cargo fmt --check` on Linux only, `clippy -D warnings` and `cargo test`
  on both, everything `--locked` — over both members of the cargo workspace since 2026-10-02,
  below — **and since 2026-09-08 the `card-scanner` crate's own suite
  on the Linux leg** — `cargo test --locked --features cli --manifest-path
  crates/card-scanner/Cargo.toml`, and since 2026-09-15 a second command in the same step,
  `cargo test --locked --features builder --bins` against the same manifest, because `cli` does
  not compile the `build-hashes` and `eval` binaries and a break in either surfaced only in
  `scanner-bundle.yml` — tests only, because that crate is not rustfmt-clean and
  carries four pre-existing clippy warnings, both listed in
  [card-scanner.md](card-scanner.md) §8; until that step `session::tests` was fenced by
  `npm run verify` and by nothing in CI), a `core` matrix (below, 2026-10-02), an `android`
  job (below, 2026-10-03), a `web` job (below, 2026-10-04) and a `powershell` job (below). The
  `wasm` and `android` compile gates went with the first web and Android builds, which were
  removed on 2026-09-27; `core` is what replaced them, for the extracted engine alone, and the
  two host jobs are the light app's — each builds one host on top of that engine.
  **`ci-ok` is the one protected check** — branch protection
  pins names by string and a matrix job's name embeds its matrix values, so the aggregator is
  what has teeth and the matrix underneath stays free. `enforce_admins` is **false**: a red PR
  cannot merge, a direct push to `main` still can, so "Work on `main`" below stays true.
  Proven 2026-08-09 by a deliberate lint error: `frontend` red, both `rust` legs green,
  **`ci-ok` red**. A green pipeline proves nothing about a gate; that run is the proof.
- **A change only builds what it can have broken.** The `changes` job diffs against the base
  (`git diff --name-only --no-renames`, so it needs `fetch-depth: 0`) and pipes the paths to
  **`scripts/ci-route.mjs`** (moved out of an inline `case` on 2026-09-26, with `case`'s
  first-match-wins order and `*`-crosses-`/` matching kept), which routes each one:
  `src-tauri/**` → **`frontend` and `rust`**; `src/**`, `public/**`,
  `index.html`, **`.storybook/**`** (its own arm since 2026-09-27 — it used to fall to the
  fail-safe and run the Rust matrix), the npm lockfile and the frontend's configs → `frontend`
  **and `storybook`**, plus **`scripts/` because `eslint .` lints it** (its ignore list does
  not name it) → `frontend` alone;
  **`rust-toolchain.toml` and `.github/actions/rust-toolchain/`** → `frontend`, `rust` and,
  since 2026-10-02, `core`; **the cargo workspace's own files at the root — `Cargo.toml`,
  `Cargo.lock`, `.cargo/**`** → the same three (2026-10-02, below);
  **`release.yml`, `scanner-bundle.yml` and `.github/dependabot.yml` → `frontend`**, because
  `scripts/toolchain.test.mjs` and `scripts/actions-pinned.test.mjs` read them (below); `.nvmrc`
  → the jobs that bundle the page (`frontend`, `storybook` and, since 2026-10-04, `web`;
  `android` installs Node too and is not routed by it, because every arm that sets `android`
  sets `rust`);
  **`src/features/transfer/__golden__/**` and `src/lib/userTables.json` → `frontend` and
  `rust`**;
  `*.ps1`/`*.psm1`/`*.psd1` → `powershell`; `ci.yml` and the router itself → **every job**;
  **`crates/*` → `frontend` and `rust`** (declared 2026-09-08 — it is what
  the fail-safe below was already doing for the `card-scanner` crate, whose `.rs` files
  `ipc.test.ts` reads as text and whose `scripts/*.mjs` `eslint .` lints) **and `core` since
  2026-10-03**, when the engine took `card-scanner` as a dependency, **with
  `crates/grimoire-core/**` above it → `frontend`, `rust` and `core`** (2026-10-02);
  prose and editor/release bookkeeping → neither; and **anything unrecognised → every**
  build job, `storybook`, `core` and — since 2026-10-04 — `web` included.
  That last arm is the fail-safe that makes the lists safe to be wrong in the cheap
  direction — a new root config file or a new top-level directory gets full CI until someone
  narrows it deliberately. Only the "neither" arm can wrongly skip work, so it stays small.
- **`web` is routed by both halves of what it builds** (phase 5, step 5.1, 2026-10-04) — the
  engine as a module, and the light page around it — and the arms that changed for it are these:
  - **Everything that routes to `core` routes to `web`.** The module a browser loads is the
    engine linked, so `web` sits in the router's `CORE_SIDE` constant itself:
    `crates/grimoire-core/**`, `crates/*` (`card-scanner`, which the engine links), the root
    `Cargo.toml`/`Cargo.lock`/`.cargo/**`, the toolchain pin and its action. The lockfile has a
    second reason — it is where the job reads which `wasm-bindgen` CLI to install.
    `ci-route.test.mjs` holds that no arm sets `core` without `web`.
  - **`crates/grimoire-web/**` → `frontend`, `rust` and `web`**, on an arm above
    `crates/grimoire-core/*` and `crates/*`. `rust` because it is a workspace member, formatted,
    linted and tested natively; `frontend` for `src-tauri/**`'s reason (a `.rs` a test reads as
    text is red there alone); and **not `core`**, by that job's own definition — `core` compiles
    what the *engine* is built from, and the engine depends on no host. Below those arms it
    would have run both of `core`'s cross-compiles for a change that cannot have moved the
    engine.
  - **The page's inputs gain `web` beside `frontend` and `storybook`**: `mobile/**` (not
    `mobile/src-tauri/**`, the phone's host), `src/**` and `public/**`, `package.json` and
    `package-lock.json`, `.nvmrc`, `vite.config.ts`, and the arm above `src/*` for the files Rust
    tests read (`syncedTables.json` is a module the page imports; the other two ride along).
    **Split off without it**:
    the root `index.html` — the desktop's document; the web build's is `mobile/index.html` —
    `components.json`, `.prettierrc` and `eslint.config.js`.
  - **`tsconfig*.json` is a glob now, and it narrows as well as widens.** It is anchored, so it
    is the root's programs only. It names the web Worker's own `tsc` program whatever that file
    is called, and it takes `tsconfig.relay.json` and `tsconfig.share-worker.json` **out of the
    fail-safe**, where each ran the whole Rust matrix and `core` for a file only `npm run
    build`'s `tsc -p` reads. `vite.watch.ts` left the fail-safe on the same arm: `vite.config.ts`
    and `.storybook/main.ts` both import it.
  - **`vite.mobile.config.ts` → `frontend`, `rust`, `android` and `web`**, where it fell to the
    fail-safe. `frontend` lints it; `web` builds `dist-web/` through it and opens the result;
    `android` because the APK's `beforeBuildCommand` is `npm run mobile:build`, **the only CI
    build of that config's default mode** — an edit that adds a mode for the browser and breaks
    the phone's is red there and nowhere else; and `rust` for no reason of its own, only because
    every arm that sets `android` sets it (the fail-safe was already running it for this path).
    Not `storybook`, which loads `vite.config.ts` and never this file. **This is the one place
    `android` runs for a page-side input**: `mobile/**`, `src/**` and `vite.config.ts` feed the
    APK's bundle too and still do not set it, because `web` now builds that same page through
    that same config on every such change.
  - **Three single files and one folder sit above the tree that would otherwise take them**,
    each because that tree's arm does not set `web`: `scripts/build-wasm.mjs`,
    `scripts/web-smoke.mjs` and — since step 5.2 — `scripts/web-smoke/*`, the fixtures the smoke
    answers the engine with, above `scripts/*` (which would lint a broken build script and
    never run it; a fixture changed is a first run changed, and nothing but `web` runs it), and
    `.storybook/fake/aliases.ts` above `.storybook/*` — `vite.mobile.config.ts` imports
    `FAKE_ALIASES` from it at load, in every mode, so a version that will not load is a
    `web:build` that never starts. The rest of `.storybook/**` is aliased in under `fake` mode
    alone and does not set `web`.
  - **The fail-safe sets `web` and still does not set `android`**, and the two answers come
    from one question: can a path nobody placed be an input? Never to the APK, whose inputs each
    have an arm. To a build of the page *and* the engine, easily — a new root config Vite or
    `tsc` loads, a new directory the light entry imports, a new crate the engine takes — and
    `web` is the only job that would see any of them in `dist-web/`.
- **The `powershell` job runs `.claude/skills/running-the-app/lock.test.ps1` on
  `windows-latest`, and its routing arm has two constraints that are not stylistic.**
  It must sit **above** `src-tauri/*` and `scripts/*` in the `case`, which is first-match-wins:
  `scripts/` is on the frontend list solely because `eslint .` lints it, which is untrue of a
  `.ps1`, so a `scripts/*.ps1` would otherwise run the wrong job and skip this one. And it
  matches `.psm1`/`.psd1` as well as `.ps1`, because **the `*)` fail-safe does not set
  `powershell`** — a module `lock.ps1` imported would otherwise fall through to it, running
  the two build jobs and skipping the only job that would have tested the change. Windows is
  not a preference: `lock.ps1` identifies a lock's holder by pid + process name +
  `StartTime`, which `Get-Process` does not expose portably, and it exists for
  `tauri-plugin-single-instance` on WebView2. The job needs no `npm ci` and no toolchain —
  the test sets its own `MTG_LOCK_DIR` and spawns short-lived `pwsh` sleepers as fixtures.
  **19 routing cases were driven through the shipped `ci.yml` text** (not a copy) before this
  landed; two of them failed on first run against the author's own wrong expectations, and the
  workflow was right both times.
  Before this job existed those 17 checks ran nowhere in CI — measured on PR #28, where
  `lock.ps1` hit the fail-safe and ran `frontend` plus the full `rust` matrix, proving nothing
  about either.
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
- **A Rust-only change runs `frontend` too, because tests on each side read the other's
  files.** This bullet used to say no test did, and the router skipped `frontend` on it; both
  were wrong for as long as `ipc.test.ts` had existed, so a Rust PR that drifted from
  `src/lib/ipc.ts` merged green and the red landed on the next unrelated PR. Censused
  2026-09-26: **ten frontend test files read 50 files under `src-tauri/` and `crates/` as
  `?raw` text** — `ipc.test.ts` alone reads 37 app modules and eight `card-scanner` ones for
  its mirror rows, and six tests read the share golden
  `src-tauri/src/share/__golden__/snapshot.json` — while **Rust tests read `src/lib/userTables.json` (`changes`), the whole
  `src/features/transfer/__golden__/` directory (`transfer::{card,fields,write}`) and
  `share-worker/wrangler.jsonc` (`share::publish`)**, every one inside `#[cfg(test)]`. Those
  figures are the day's, and nothing relies on
  them: **`scripts/ci-route.test.mjs` derives the census from the sources on every run** and
  fails when a file is read by a job the router does not send it to, or crosses the boundary and
  is not routed to both `frontend` and `rust`. Reverting either half of the fix was run as a
  mutation and the derived census went red both times, not only the hand-written table. Cost
  measured on the runs before the change: `frontend` takes 8–12 min and `rust` 4–9, so a
  Rust-only PR now waits on `frontend`'s clock instead of `rust`'s — which is half of why
  `frontend` was split into parallel legs the next day (below).
- **`frontend` is five legs in parallel, and `build-storybook` is a job of its own** (issue
  #559, 2026-09-27). It was one serial job — `npm run build`, `eslint .`, `vitest run`, then
  `build-storybook` — at 8–12 minutes, with vitest alone 345–415 s for ~390 files; branch
  protection is `strict: true`, so every merge into `main` re-queued every open PR behind that
  whole path. Now one leg builds and lints, and four run `npm run test:run -- --shard=N/4`:
  vitest divides the collected files deterministically, so a shard runs the same files on every
  run. Nothing a test reads comes out of `npm run build` (the `dist/` mentions in test files are
  comments), which is what lets the shards start with the build leg rather than behind it.
  `ci-ok` reads `needs.frontend.result`, `failure` if any leg fails, so the matrix changes no
  protected name; `fail-fast: false` keeps one red shard from cancelling the rest.
  **`storybook` has its own `changes` output** because it reads less than `frontend` — nothing
  under `src-tauri/`, `crates/` or `scripts/` — and it was added to all five lists a gated job
  must be in. `ci-route.test.mjs` now checks the last two of those (`ci-ok`'s `needs` and its
  loop) for every name in `JOBS`, where it used to check only the output and the `if:`.
- **Rust is pinned by `rust-toolchain.toml`, and no workflow may install its own** (issue #559,
  2026-09-27). Every workflow used `dtolnay/rust-toolchain@stable` with `clippy -D warnings`, so a
  new stable's lints could turn every PR red with no code change, and a release binary was built
  by whatever stable was current. The file pins **1.98.1** (the current stable on the day) with
  `rustfmt` and `clippy`; `.github/actions/rust-toolchain` reads the channel with `sed` and hands
  it to `dtolnay/rust-toolchain` — `@master` until 2026-09-28 and pinned by SHA since (next
  bullet) — which does not read the file itself.
  **`scripts/toolchain.test.mjs` is the fence**:
  it globs every workflow and fails on a direct `dtolnay/rust-toolchain` use, a `rustup`
  install, or a `node-version:` that is not `node-version-file: .nvmrc`, and on a channel that is
  not an exact `x.y.z`. **Node is pinned the same way**: `.nvmrc` (24, the version the app is
  developed on — CI ran 22 until this change) feeds every `setup-node`, and `package.json`'s
  `engines` floor is `>=22.18`, the newest any script here needs (`scripts/golden.mjs`).
- **Every third-party action is pinned by commit SHA, every checkout drops its token, and no
  workflow grants a write permission to all its jobs** (2026-09-28, issue #545). All three
  workflows and the composite action used mutable references — `actions/checkout@v7`,
  `tauri-apps/tauri-action@v1`, `Swatinem/rust-cache@v2`,
  `googleapis/release-please-action@v5`, `dtolnay/rust-toolchain@master` — and `release.yml`
  granted `contents`, `issues` and `pull-requests: write` at the workflow level, so whoever could
  repoint one of those tags ran code beside a write token and a release in progress. Now:
  - **`uses: owner/repo@<40-hex SHA> # vX.Y.Z`**, the SHA the tag named on the day (the peeled
    commit for an annotated tag), so behaviour did not change. `dtolnay/rust-toolchain` has no
    release tags, only `v1`, which named `master`'s head that day — hence `# v1`.
  - **`.github/dependabot.yml`**, `github-actions` weekly over `directories: ["/",
    "/.github/actions/*"]` — the second entry because Dependabot reads only the directories it is
    given, and the composite action is where the one action every build job runs lives. Updates
    come as one grouped PR a week, `ci:`-prefixed so release-please cuts nothing for them.
  - **`persist-credentials: false` on every `actions/checkout`**. Checked job by job
    first: nothing after a checkout runs `git` against the remote — `changes` diffs history the
    checkout already fetched, and every upload is `gh` or tauri-action, each handed its token.
  - **Workflow-level `permissions: {}`** in `release.yml` and `scanner-bundle.yml`, with each job
    naming its own (`ci.yml` stays `contents: read`, which grants nothing to write).
    `release-please` keeps `contents`/`issues`/`pull-requests: write`; `build` and `publish` get
    `contents: write` alone.
  - **`scripts/actions-pinned.test.mjs` is the fence**: it globs every workflow and composite
    action and fails on a `uses:` that is neither local nor a SHA with a version comment, a
    checkout without `persist-credentials: false`, a write grant above `jobs:`, a Dependabot
    config that stops watching either directory. (It also fenced the update-signing secret to one
    step of a `sign` job until that job was removed on 2026-09-29, below.) Comments are stripped
    before any of it is read, since these files explain themselves in prose that names both.
- **A push to `main` gets a concurrency group of its own; PR runs still cancel each other.**
  Routing on a push diffs from `github.event.before`, so a cancelled `main` run's commits were
  never routed by the next one — and turning `cancel-in-progress` off alone would not have
  saved them, because GitHub replaces a *pending* run in a group with the next arrival
  regardless.
- The `rust` job writes a stub `dist/index.html` first. `tauri-build` reads
  `frontendDist: "../dist"` and fails outright when it is missing, so a Rust-only job cannot
  compile a fresh checkout; the stub is what keeps it parallel with `frontend` instead of
  serialized behind a full Vite build — and it is also why the `rust` job is safe to run with
  `frontend` skipped entirely: the frontend it needs is one file it writes itself.
- **The repository is a cargo workspace rooted at the top, and nothing a workflow reads moved
  except the lockfile** (2026-10-02). The light app's engine is being extracted into
  `crates/grimoire-core` so three hosts can link it, and a path dependency with
  dev-dependencies cannot be tested from the package that depends on it unless both are
  members of one workspace — so the root gained a virtual `Cargo.toml` whose members are
  `src-tauri` and that crate, and `src-tauri/Cargo.lock` became the root `Cargo.lock`.
  **`target/` did not move**: a workspace builds into `<root>/target` by default, and
  `.cargo/config.toml` pins `build.target-dir = "src-tauri/target"`, which is where the dev
  database, the portable-zip step and the coverage report already look. `cargo metadata` on
  the day: workspace root the repository, target directory `src-tauri/target`. What followed
  in the workflows:
  - **The `rust` job's commands run from the root**, with no `working-directory`:
    `cargo fmt -p mtg-grimoire -p grimoire-core --check`, `cargo clippy --workspace
    --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`. `lint:rust` is
    the first two as written, and `npm run verify` runs it and then `cargo test --workspace`.
    **`cargo fmt --all` is the one spelling that must not be used** — it follows path
    dependencies, and `card-scanner` is one and is not rustfmt-clean. `--workspace` lints and
    tests the members only. **That `fmt` line is the day's, and it names its packages one by
    one, so every member since has had to be added to it**: `-p grimoire-light` with the
    Android host (2026-10-03) and `-p grimoire-web` with the web host (2026-10-04), in `ci.yml`
    and in `lint:rust` alike. A member missing from it is a crate nothing formats, and nothing
    goes red to say so.
  - **Two more steps name the hosts one by one**, both after clippy: `cargo check -p
    mtg-grimoire -p grimoire-light --locked`, the build with no dev-dependencies in it, for the
    two hosts Tauri builds — the web host is not on it, because it ships as a WASM module and
    the `web` job's `cargo build --lib` for `wasm32-unknown-unknown` is that build — and the
    `cargo tree … -i grimoire-core` loop that fails when the core's `testing` feature is on in a
    host's ordinary build, over `mtg-grimoire`, `grimoire-light` and `grimoire-web`. The tree is
    asked for the runner's own target, which answers for the web host only while its dependency
    on the core is not under a `[target.…]` table; since 2026-10-04 **an answer that does not
    name the core fails the step** rather than passing it. (That cargo words an empty inverted
    tree as a warning and exits 0 is the understanding the guard was written on, **not something
    a run here has shown** — if cargo errors instead, the step is red by that route.)
  - **`card-scanner` stays outside**, `exclude`d by name because a path dependency under the
    workspace root would otherwise become a member by itself. It keeps its own `Cargo.lock`
    and its own `target/`, and **every scripted run of it from the root passes
    `--target-dir crates/card-scanner/target`** — the test lines in `ci.yml`, the one in
    `verify`, both `cargo run` lines in `scanner-bundle.yml`. Cargo reads its config from the
    working directory, never from `--manifest-path`, so without the flag those runs would
    follow the root's config into `src-tauri/target`; in `scanner-bundle.yml` that is also a
    tree its `rust-cache` (`workspaces: crates/card-scanner`) never saves.
  - **`Swatinem/rust-cache` takes `workspaces: ". -> src-tauri/target"`** in `ci.yml` and
    `release.yml` — where the lockfile is, then where the artifacts are.
  - **Proven by a run on 2026-10-03: `tauri-action` still finds its bundles.** v0.40.0 was the
    first release under the workspace; it is invoked exactly as before, the portable step read
    `src-tauri/target/release/mtg-grimoire.exe` as before, and all five files were attached —
    the NSIS installer, the MSI, the portable zip, the `.deb` and the AppImage, each within 1% of
    v0.39.0's size. [light-app.md](light-app.md) §6.12 has the run and what it did not check.
    **`rust-cache` restores under the new line in `ci.yml`** — read off the `rust
    (windows-latest)` job of the CI run on that same merge (`Cache restored successfully`).
    **In `release.yml` both legs reported `No cache found`**, which is a first release under a
    new key and proves nothing either way: the release built cold, and the next one says
    whether its own cache comes back.
  - **What stood in for that run until then was the action's own source, read at the pinned SHA**
    (`1deb371b`, `src/utils.ts`). `getWorkspaceDir` walks up from the Tauri directory to the
    first `Cargo.toml` whose `[workspace]` lists it — the repository root now — and its default
    target is `<that>/target`, which would be wrong here. But `getTargetDir` looks first, on the
    same walk up, for a `.cargo/config` or `.cargo/config.toml` with `build.target-dir`, and
    joins a relative value onto the directory holding the `.cargo` folder: `<root>/src-tauri/target`.
    `CARGO_TARGET_DIR` would outrank both and no job sets it. `tauri dev`, which asks
    `cargo metadata`, was launched under the same layout on 2026-10-02 and built into
    `src-tauri/target/debug`.
- **The `core` job compiles `grimoire-core` for the two targets a desktop build never
  touches** (2026-10-02): a matrix over `wasm32-unknown-unknown` and `aarch64-linux-android`
  on `ubuntu-24.04`, `fail-fast: false`, each leg `cargo build --lib -p grimoire-core --locked
  --target <triple>` followed by `cargo clippy` with the same selection and `-D warnings`. A
  green `rust` job proves the host triple and nothing else — a desktop-only `use`, a
  dependency that will not build for a triple, a `cfg` that leaves a module unreachable are
  invisible to it — and the gate starts the day the crate exists because one added after the
  extraction would prove nothing during it.
  **It is a compile gate.** No test runs (a cross-compiled harness needs a device, an
  emulator or a browser — hence `--lib`, never `--all-targets`), no APK is assembled and no
  bundle is served, so nothing here says the core *works* on a phone or in a browser. The
  Windows compile and the native tests are the `rust` job's, through `--workspace`. There is
  no `dist/` stub and no Node, because the core has no `tauri-build`.
  **Its routing is narrower than `rust`'s**: the crate itself, the workspace's root files and
  the pinned toolchain, the gate and the fail-safe, and `crates/*` — `card-scanner`, which the
  engine depends on since the scanner's session glue moved on 2026-10-03, the day that arm gained
  `core` as it said it would — and never `src-tauri/**`, which the engine does not depend on.
  Both legs therefore compile `card-scanner`, `ocrs`, `rten` and `image` too. Every arm that sets
  `core` sets `rust` too, and `ci-route.test.mjs` holds the router to that.
  **None of the job's own details were measured on it when this was written; its first run is
  the PR that adds it.** They are the removed `wasm` and `android` jobs' (the first attempt,
  still readable at `cd54f1a6`), where each was measured: Ubuntu **24.04 for clang ≥ 18**, because
  `sqlite-wasm-rs`'s `shim/wasm-shim.h` uses C23 `[[noreturn]]` and 22.04's `apt-get install
  clang` gives 14, failing four errors deep in a build script's warning stream as `cc-rs:
  command did not execute successfully` (the step prints the version and refuses one below
  18, or one it cannot read); **the NDK's `bin` on `PATH` and
  `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER`**, because `cargo` and `cc-rs` know nothing of
  `NDK_HOME` and each omission fails naming something else (`failed to find tool "clang"`,
  ``linker `cc` not found``); and **a `rust-cache` `key` per target**. The linker is the
  API-26 clang, the first attempt's `minSdk` carried over — and since phase 4 the light host's
  `tauri.conf.json` says `minSdkVersion: 26` too, which `mobile/host.test.ts` pins.
- **The `android` job builds the light app's APK** (phase 4, 2026-10-03): `npx tauri android
  build --apk --target aarch64` from `mobile/` on `ubuntu-24.04`, with JDK 21 from the image
  (`JAVA_HOME_21_X64` — JDK 25 breaks the Android Gradle and Kotlin plugins), `NDK_HOME` set to
  the image's `ANDROID_NDK_LATEST_HOME`, and the light bundle built by the host's
  `beforeBuildCommand`. It writes the APK's size and the `.so`'s to the step summary and uploads
  the APK (`actions/upload-artifact`, 14 days). **A release build signed with the runner's debug
  key** — installable, but one run's APK does not upgrade over another's. Its routing is the
  host's tree (`mobile/src-tauri/*`), the workspace's root files, the toolchain pin and — since
  2026-10-04 — `vite.mobile.config.ts` (above) — **not
  the fail-safe and not `crates/grimoire-core/*`**: an unrecognised path cannot be an input to
  the APK, the engine's Android compile is `core`'s, and its API against the host is compiled by
  `rust`, where `mobile/src-tauri` is a workspace member. Every arm that sets `android` sets
  `rust`. **Nothing in it runs the APK.** Its first run is the PR that adds it, and its numbers
  are that run's summary — [light-app.md](../reference/light-app.md) §8.1.
- **The `web` job builds the light app's web host and opens it in a browser** (phase 5, step
  5.1, 2026-10-04) — the first job in this workflow in which the engine runs anywhere but on
  the runner's own triple. `core` proves `grimoire-core` *compiles* for
  `wasm32-unknown-unknown`; this links the host in `crates/grimoire-web` for it, runs
  `wasm-bindgen` over the result, bundles the light page around the module and has a headless
  Chrome load it from `localhost`. Step by step, on `ubuntu-24.04`:
  - **clang, with `core`'s ≥ 18 guard**, copied from that job's wasm leg: the module is the
    engine linked, so it compiles the same `sqlite-wasm-rs` shim. `scripts/build-wasm.mjs`
    finds the compiler as `clang` on `PATH`.
  - Node from `.nvmrc` with the npm cache, `npm ci`, the composite toolchain action with
    `targets: wasm32-unknown-unknown`, and `Swatinem/rust-cache` with `workspaces: ". ->
    src-tauri/target"` and `key: web-wasm32`. **No `dist/` stub**: `cargo build -p grimoire-web`
    compiles that package and what it depends on, neither Tauri host is among them, and so
    nothing asks for `frontendDist`.
  - **The `wasm-bindgen` CLI, at the version `Cargo.lock` resolves for the `wasm-bindgen`
    crate, read in the step.** The CLI rewrites what the crate emitted and refuses a module
    whose schema is not its own, so the two are one version or the build stops — and the
    crate's version is whatever the lockfile says. A number typed into the workflow would be
    right until the day a dependency bump moved the crate, and then every run is red for a
    reason the diff that caused it does not show. So: `awk` takes the `version` line under
    `name = "wasm-bindgen"`, the step **stops unless there is exactly one** (a lockfile
    resolving the crate twice has no single CLI that fits), then `cargo install
    wasm-bindgen-cli --version "$bindgen" --locked`, then a check
    of what `wasm-bindgen --version` says. **Compiled from crates.io rather than downloaded** —
    checksummed by the registry like every other dependency, where a prebuilt binary would be
    a release asset to verify by hand; `rust-cache` restores `~/.cargo/bin`, which is why it
    runs *before* this step, so the compile is paid on a cold cache alone. **No
    `--target-dir`**: `cargo install` from a registry starts its configuration at `$CARGO_HOME`
    and never reads this repository's `.cargo/config.toml`, so the CLI is not built into
    `src-tauri/target`.
  - **`cargo clippy --lib -p grimoire-web --locked --target wasm32-unknown-unknown -- -D
    warnings`**, ahead of the build: the one place the host's `#[wasm_bindgen]` shell is linted.
    `glue.rs` is gated to this target, so the `rust` job's native `clippy --workspace` never
    compiles it, and `core`'s wasm leg lints the engine alone.
    `scripts/build-wasm.mjs` reads the same lockfile for itself and refuses a CLI that differs,
    so the two parses disagreeing is a red step rather than a quiet skew, and
    **`scripts/toolchain.test.mjs` fails any workflow whose install line has anything but a
    shell variable after `--version`**. Driven locally against the real lockfile with `cargo`
    and the CLI stubbed (Git Bash, 2026-10-04): one entry reads `0.2.127`; two entries and no
    entry each stop the step with the count; a CLI answering another version stops it.
  - `npm run web:wasm` — `cargo build -p grimoire-web --lib --target wasm32-unknown-unknown
    --profile wasm --locked` (the root `Cargo.toml`'s profile for this module: `release` with
    fat LTO, one codegen unit and `panic = "abort"`), then `wasm-bindgen --target web` into
    `dist-wasm/` — and `npm run web:build`:
    `tsc`, `tsc -p tsconfig.web-worker.json`, then the light entry in `web` mode into
    `dist-web/`, with the engine from `dist-wasm/` emitted under `dist-web/wasm/<build id>/`.
    The config fails a build whose engine is not there, which is why the module is built first.
  - **A size report to the step summary**: every `.wasm` under `dist-web/` — found rather than
    named, because the module sits under a directory named for the engine's build, and a
    bundle with none fails the step — in bytes and MiB, raw and `gzip -9`, and `dist-web/`
    whole with its file count.
  - **`npm run web:smoke`, with `CHROME` set to the image's own Google Chrome**: `google-chrome`
    on `PATH`, else the `CHROME_BIN` the image sets, else the step fails saying the runner has
    no browser. Nothing is downloaded — a Chrome fetched at run time is a binary nobody pinned.
    Its version goes in the summary, because a figure taken in a browser is a figure about that
    browser. The smoke step has `timeout-minutes: 10`: the failure it guards is a page that
    waits for ever, and a job otherwise has six hours to do that in.
  - `dist-web/` uploaded as `mtg-grimoire-web` (`actions/upload-artifact`, 14 days,
    `if-no-files-found: error`) **whenever the bundle was built, a failed smoke included** — a
    page that would not open on the runner is the one somebody needs to serve and look at.

  **What it proves is the smoke script's to say** (`scripts/web-smoke.mjs`), and since step 5.2
  (2026-10-04) that is **an offline first run**: the module instantiates, the engine opens its
  database, and the launch's downloads — the card sync, both Tagger files, the combos, and
  Card Kingdom's list when Settings picks it — run to their end in one Chrome on Linux, with
  **every cross-origin request answered from `scripts/web-smoke/`** through the DevTools
  `Fetch` domain. A request to a host with no fixture fails the run, so does one carrying a
  header that would cost a CORS pre-flight, and the browser is started with a resolver that
  knows no name but `localhost` — so nothing leaves the runner. Nine checks, listed in the
  script's header; [light-app.md](light-app.md) §9.2 has them. It runs no test suite in the
  browser, and **the corpus it ingests is six fixture cards, not Scryfall's**; the engine's
  tests are still `rust`'s, natively. (Until step 5.2 it asked five things over an empty
  database and nothing was downloaded at all.)
  **No run had happened when this was first written** — the first was the pull request that
  added the job (#805, merged 2026-10-04): on a cold cache the whole job took **4 min 59 s** —
  clang 18.1.3 from apt, the `wasm-bindgen` CLI compiled from crates.io at the lockfile's
  0.2.127, the host linted for wasm32, the module built (8 571 014 B; Vite reported it
  3 040.62 kB gzipped), the page built, and the smoke passed in the runner's own Chrome — and
  `ci-ok` was green on that first run. So the image's clang and Chrome were what this assumed,
  and Chrome started. Still not on record: whether it started under its sandbox, whether
  `rust-cache` brings the CLI back, and what a warm run costs.
- **`.github/workflows/android-emulator.yml` runs the APK, on an emulator** (phase 4, step 4.5,
  2026-10-03) — a fourth workflow, **outside `ci.yml` and never a gate**: `ci-ok` does not read
  it and nothing is protected on it. It runs on `workflow_dispatch`, and on a pull request to or a push to `main` that
  touches `mobile/src-tauri/**`, `crates/grimoire-core/**`, `Cargo.lock`, itself or its script.
  The build is the `android` job's with **`--target x86_64`** — an x86_64 emulator under KVM
  cannot run arm64 code — and the same JDK 21, `NDK_HOME`, composite toolchain action and
  `rust-cache` (keyed `android-x86_64`). It then enables KVM with the udev rule from
  `reactivecircus/android-emulator-runner`'s README and boots that action's emulator (API 34,
  `google_apis`, x86_64, 4 cores, 4096M RAM, `disk-size: 6000M` for the ~900 MB corpus), whose
  `script:` is one line — the action runs each line as its own shell — calling
  **`scripts/android-first-run.sh`**. That script installs the APK and writes to the step summary
  and to an artifact (`android-first-run`, 30 days, uploaded `if: always()`): the APK's and the
  `.so`'s size, the first launch's `am start -W` `TotalTime`, **the first corpus ingest** — the
  host's own `launch: card sync finished in N ms` line from logcat's `RustStdoutStderr` tag,
  beside the wall clock from the launch — both databases' size on the device (read through
  `adb root`, which a `google_apis` image allows and a release build's `run-as` does not), a
  screenshot, and three cold starts after `force-stop` with their median. **It fails when there
  is no ingest figure** — a sync that failed, ran past 45 minutes, or never started within 60 s,
  which it reports as *held — the emulator reported a metered network* (step 4.4's hold). The
  router sends a change to the workflow to `frontend`, beside `release.yml`, for the two tests
  that read every workflow; the script is `scripts/*`. **No run had happened when this was written** —
  the first is the pull request that adds it; [light-app.md](../reference/light-app.md)
  §8.5 has what each figure means and what an emulator cannot stand in for.
- **`.github/workflows/release.yml` is one workflow on purpose.** A release created with
  `GITHUB_TOKEN` does not trigger `on: release` in another workflow — GitHub's recursion
  guard — so release-please, the build matrix and the publish step are jobs in one file,
  chained on `release_created`.
- **Versions are never typed by hand.** release-please reads the `feat:`/`fix:`/`!` prefixes
  and keeps a `chore(main): release X.Y.Z` PR open that bumps every version file and writes
  `CHANGELOG.md`. Merging it tags, builds and publishes. **Which files is
  `release-please-config.json`'s to say, and this page keeps no count of them** — it said
  *all five* and listed `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml` and `Cargo.lock` long after the workspace had added more. The shape:
  `package.json` and its lockfile belong to the `node` release type, and `extra-files` holds
  the rest — for **every cargo workspace member** its `Cargo.toml` (`$.package.version`) and
  its own entry in the root `Cargo.lock` (at the root since 2026-10-02; `src-tauri/Cargo.lock`
  until then), and for each Tauri host its `tauri.conf.json`. `grimoire-core` joined on
  2026-10-02, `grimoire-light` with its `tauri.conf.json` on 2026-10-03, and `grimoire-web`
  on 2026-10-04 — a manifest and a lockfile selector, and no `tauri.conf.json`, because it is
  not a Tauri host. **A new member owes its pair in the same change that adds it**: a manifest
  the config does not name is not bumped, its lockfile entry is therefore not stale either, and
  so `--locked` has nothing to object to — the crate just ships a version behind the app.
  `desktop.rs`'s `the_core_wears_the_apps_version` reads the config and fences that for the
  desktop and the engine alone, because the `User-Agent` is built from the engine's version.
  The web host's manifest is held to the core's by a test of its own —
  `the_host_wears_the_cores_version`, in `crates/grimoire-web/src/host.rs` — which reads the two
  manifests and not the config; nothing holds the Android host's.
  `bump-minor-pre-major` is on, so while on `0.x` a `feat!:` bumps the **minor**; reaching
  1.0 is a deliberate `Release-As: 1.0.0` footer, never something a stray `!` does.
- **The `Cargo.lock` selector must read `@.name.value`, never `@.name`.** release-please
  parses TOML into tagged nodes, so every scalar is an object and the obvious form matches
  nothing — and a non-match is a _warning_, not an error. Measured against the real lockfile
  2026-08-09: `.value` changes exactly one line and leaves the `version = 4` lockfile-format
  key alone; the bare form changes nothing at all. **`--locked` on every cargo call in both
  workflows is what converts that silence into a failed check on the release PR itself**,
  before anything is tagged. **The lockfile moved to the repository root on 2026-10-02** and
  `release-please-config.json`'s `path` with it; the selector did not change, and it names
  `mtg-grimoire`, so the `grimoire-core` entry now in the same file is not what it matches —
  **each member has a selector of its own**, the same expression with its package name in it.
  **Measured by v0.40.0** (2026-10-03), the first release under the workspace: its release PR
  moved `grimoire-core`'s and `mtg-grimoire`'s entries together in the root lockfile, beside
  both manifests, and the release built `--locked`. `grimoire-light`'s and `grimoire-web`'s
  selectors have been through no release yet; the next release PR is their measurement, and
  `--locked` is what fails it if either misses.
- The release is created as a **draft** and published only after every platform's assets
  attach, so a release is never visible without its binaries. `force-tag-creation` pairs with
  that and is not optional: a draft has no git tag until published, and without it
  release-please's next run cannot find the previous release and replays the whole history
  into the changelog. `gh release upload`/`edit` **do** resolve a draft by tag even though no
  tag exists yet (measured 2026-08-09 — the draft's own URL is `untagged-<sha>`).
- **There is no `sign` job, and there was one for a day.** `release.yml` gained a job on
  2026-09-28 (`8a5568d6`) that minisign-signed the portable zip and the NSIS setup with the
  `UPDATE_SIGNING_KEY` repository secret, and `publish` needed it. The secret was never set, so
  v0.34.0's run failed at `sign` on 2026-09-29 and the release stayed a draft — fail-safe, as
  designed. Signing was removed the same day on the maintainer's decision, the updater's check
  with it; [in-app-updates.md](in-app-updates.md) has what the updater trusts now and why the
  v0.34.0 draft must never be published. **If it comes back, the job's one structural rule still
  holds**: the secret goes in a job of its own, never a build leg, because a build leg runs
  tauri-action, rust-cache and every npm and cargo build script, any of which can read a secret
  in the same job.
- **release-please needs "Allow GitHub Actions to create and approve pull requests"**
  (`can_approve_pull_request_reviews: true`). It is one toggle covering both verbs, and with
  it off the run fails at the very last step — after parsing every commit, resolving the
  version and pushing the release branch — with "GitHub Actions is not permitted to create or
  approve pull requests". Everything looks healthy right up until it doesn't.
- **Every release PR opens in `action_required` and must be approved before CI runs.** This
  is the same recursion guard as above wearing its other face: a `pull_request` run from a
  `GITHUB_TOKEN`-authored PR is queued but _not started_. The run shows `action_required`
  with **zero jobs**, which reads like a broken workflow and is not. So a release is: PR
  opens → `gh api -X POST repos/…/actions/runs/<id>/approve` (or the Approve button) →
  `ci-ok` passes → merge. Handing release-please a PAT or App token would remove the click
  at the cost of a stored credential; for one maintainer the click is the better trade.
- **Tags are plain `v0.2.0`, and that needs `include-component-in-tag: false`.** Setting
  `package-name` gives release-please a _component_, and the default is to put it in the
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
- **Both Windows installers show a licence page; neither Linux bundle does.**
  `bundle.licenseFile` is the only knob Tauri v2 has for it — `nsis.license` and
  `wix.licenseFile` are **v1** names and are absent from the v2 schema, so a config written
  from a v1 answer is accepted as an unknown key and changes nothing. One field, two very
  different consumers: NSIS rewrites the file with a UTF-8 BOM and feeds it to
  `MUI_PAGE_LICENSE`, while WiX generates an RTF from it and sets `WixUILicenseRtf`. Both
  templates *skip the page entirely* when the field is unset, which is what every release
  through v0.13.0 did. The `deb` and `appimage` bundlers never read it.
- **Nothing in `ci-ok` bundles, so a wrong `licenseFile` path is green in CI and broken at
  tag time.** The only proof is a local bundle. Measured 2026-08-22,
  `npm run tauri build -- --bundles nsis,msi`, release, 3m28s: `nsis/x64/license_file` came
  out at 34,526 bytes (the 34,523-byte `LICENSE` plus the BOM) and `wix/LICENSE.rtf` at
  37,355. **The RTF generator escapes nothing** — it replaces `\n` with `\par ` and leaves
  `\`, `{` and `}` alone, so a licence text containing any of those would emit malformed RTF.
  AGPLv3 contains none of them; a different licence might.
- **A portable copy exits silently if any other instance is running** —
  `tauri-plugin-single-instance` gives it exit code 0, no window and no stderr, and a dev
  build from `target/debug` counts. Measured 2026-08-09 while verifying the v0.2.0 zip: the
  first attempt looked like a broken build and was a live dev instance.
  ⚠️ **Since 2026-09-20 the running app answers that launch by opening a window of its own**
  ([multi-window.md](multi-window.md)), so the zip you are verifying can appear to start while
  what came up is the *other* build — a dev window, at whatever revision that checkout is on.
  Check that `Get-Process mtg-grimoire` is empty before you launch the copy, not afterwards.
- `--bundles` is pinned per platform. Not because RPM needs `rpmbuild` — it does not, Tauri
  builds RPMs in-process with the pure-Rust `rpm` crate — but because shipping one is a
  choice. AppImage is the bundle with external needs: it downloads `linuxdeploy` and wants
  `patchelf`, `xdg-utils`, `libfuse2`.
- **Linux artifacts are built but unverified.** Every measured claim in this repo — the sync
  timings, the image cache, the `mtgimg://` origin, the drag-and-drop interception trap — was
  measured on Windows. Nobody has run a Linux build.
- Not done, deliberately: no code signing (no certificate, so SmartScreen warns on the
  installers) and **not** GitHub Packages — none of its registry types hosts a desktop
  installer, which is why the compiled app goes to Releases instead. **"Code signing" there means
  Authenticode, and it is still not done** — and neither, since 2026-09-29, is update signing,
  which was a different thing with a different reader (the app's own updater, never Windows).
