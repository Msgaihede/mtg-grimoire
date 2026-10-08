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
  `apps/desktop/src-tauri/**` → **`frontend` and `rust`**; `packages/ui/**`, `apps/desktop/public/**`,
  `apps/desktop/index.html`, **`.storybook/**`** (its own arm since 2026-09-27 — it used to fall to the
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
  **`packages/ui/features/transfer/__golden__/**` and `packages/ui/lib/userTables.json` → `frontend` and
  `rust`**;
  `*.ps1`/`*.psm1`/`*.psd1` → `powershell`; `ci.yml` and the router itself → **every job**;
  **`crates/*` → `frontend` and `rust`** (declared 2026-09-08 — it is what
  the fail-safe below was already doing for the `card-scanner` crate, whose `.rs` files
  `ipc.test.ts` reads as text and whose `scripts/*.mjs` `eslint .` lints) **and `core` since
  2026-10-03**, when the engine took `card-scanner` as a dependency, **with
  `crates/grimoire-core/**` above it → `frontend`, `rust` and `core`** (2026-10-02);
  prose and editor bookkeeping → neither (`.release-please-manifest.json` sat there until
  2026-10-04, when `scripts/release-rule.test.mjs` began reading it: `frontend` now);
  `scripts/android-sign.sh` → `frontend`, `rust` and `android`, which runs it (below; since
  2026-10-07 it is `scripts/android-release/*`, and the script is gone);
  and **anything unrecognised → every**
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
    linted and tested natively; `frontend` for `apps/desktop/src-tauri/**`'s reason (a `.rs` a test reads as
    text is red there alone); and **not `core`**, by that job's own definition — `core` compiles
    what the *engine* is built from, and the engine depends on no host. Below those arms it
    would have run both of `core`'s cross-compiles for a change that cannot have moved the
    engine.
  - **The page's inputs gain `web` beside `frontend` and `storybook`**: `apps/light/**` (not
    `apps/light/src-tauri/**`, the phone's host), `packages/ui/**` and `apps/desktop/public/**`, `package.json` and
    `package-lock.json`, `.nvmrc`, `vite.base.ts`, `vitest.config.ts`, and the arm above `packages/ui/*` for the files Rust
    tests read (`syncedTables.json` is a module the page imports; the other two ride along).
    **Split off without it**:
    `apps/desktop/index.html` — the desktop's document (at the root until 2026-10-08); the web build's is `apps/light/index.html` —
    `packages/ui/components.json`, `.prettierrc` and `eslint.config.js`.
  - **`tsconfig*.json` is a glob now, and it narrows as well as widens.** It is anchored, so it
    is the root's programs only. It names the web Worker's own `tsc` program whatever that file
    is called, and it takes `infrastructure/relay/tsconfig.json` and `infrastructure/share-worker/tsconfig.json` **out of the
    fail-safe**, where each ran the whole Rust matrix and `core` for a file only `npm run
    build`'s `tsc -p` reads. `vite.watch.ts` left the fail-safe on the same arm: `vite.base.ts`
    and `.storybook/main.ts` both import it.
  - **`apps/light/vite.config.ts` → `frontend`, `rust`, `android` and `web`**, where it fell to the
    fail-safe. `frontend` lints it; `web` builds `apps/light/dist-web/` through it and opens the result;
    `android` because the APK's `beforeBuildCommand` is `npm run mobile:build`, **the only CI
    build of that config's default mode** — an edit that adds a mode for the browser and breaks
    the phone's is red there and nowhere else; and `rust` for no reason of its own, only because
    every arm that sets `android` sets it (the fail-safe was already running it for this path).
    Not `storybook`, which loads `apps/desktop/vite.config.ts` and never this file. **This is the one place
    `android` runs for a page-side input**: `apps/light/**`, `packages/ui/**` and `vite.base.ts` feed the
    APK's bundle too and still do not set it, because `web` now builds that same page through
    that same config on every such change.
  - **Four single files and one folder sit above the tree that would otherwise take them**,
    each because that tree's arm does not set `web`: `scripts/build-wasm.mjs`,
    `scripts/web-smoke.mjs`, `scripts/web-sync-smoke.mjs` (step 6.3) and — since step 5.2 —
    `scripts/web-smoke/*`, which holds `harness.mjs`, the module both runs are written in,
    `sync-harness.mjs`, the relay and the pairing the sync runs share (step 6.5; its measurement,
    `scripts/web-sync-pull.mjs`, is run by no job and stays under `scripts/*`), and
    the fixtures the smoke
    answers the engine with, above `scripts/*` (which would lint a broken build script and
    never run it; a fixture changed is a first run changed, and nothing but `web` runs it), and
    `packages/fake/aliases.ts` above `.storybook/*` — `apps/light/vite.config.ts` imports
    `FAKE_ALIASES` from it at load, in every mode, so a version that will not load is a
    `web:build` that never starts. The rest of `.storybook/**` is aliased in under `fake` mode
    alone and does not set `web`.
  - **`infrastructure/app-worker/**` → `frontend` and `web`** (step 5.5, 2026-10-04), where it would have
    fallen to the fail-safe and run the Rust matrix, `core` and `storybook` for a response
    header. It is the web app's hosting: a third Worker's `wrangler.jsonc`, Cloudflare's
    `_headers` file and a small script. `frontend` runs `tsc -p infrastructure/app-worker/tsconfig.json` (in
    `npm run build`), `eslint` and the directory's tests — `hosting.test.ts` reads `_headers`,
    `wrangler.jsonc`, the desktop's shipped CSP, the line of `packages/ui/lib/core/web/index.ts` that
    constructs the engine's Worker, and **every `.rs` file of `grimoire-core`, `grimoire-web`
    and `card-scanner`'s library** as text. It fails when the policy's `connect-src` and the
    addresses the engine names differ in either direction, and when shipped Rust gains an
    `https://` literal that is neither in the policy nor on the test's list of hosts a browser's
    engine never asks. Each of those trees already routes to `frontend`, which is the only
    reason a glob the census cannot see is safe here. `web` because the light config imports `infrastructure/app-worker/src/headers.ts` at
    load, in every mode, and emits `_headers` into `apps/light/dist-web/` in `web` mode — so a file there
    that will not load or parse stops `web:build`. **Not `rust`**: the census finds no Rust
    source reading that tree, which is the difference from `infrastructure/share-worker/` (one does, so that
    tree keeps the fail-safe). The crossing runs the other way, and `crates/grimoire-core/**`
    already sets `frontend`. `infrastructure/app-worker/README.md` is prose. **Nothing in `ci.yml` deploys
    it** — this said *nothing in CI* until 2026-10-04, when `release.yml`'s `web-deploy` began
    deploying it at a release tag (*The release rule*, below), from the lockfile that sits in
    this tree since the same day: `infrastructure/app-worker/package.json` and `package-lock.json` are this
    arm's too, read by `scripts/release-rule.test.mjs` and installed by no job in `ci.yml`.
  - **The fail-safe sets `web` and still does not set `android`**, and the two answers come
    from one question: can a path nobody placed be an input? Never to the APK, whose inputs each
    have an arm. To a build of the page *and* the engine, easily — a new root config Vite or
    `tsc` loads, a new directory the light entry imports, a new crate the engine takes — and
    `web` is the only job that would see any of them in `apps/light/dist-web/`.
- **The `powershell` job runs `.claude/skills/running-the-app/lock.test.ps1` on
  `windows-latest`, and its routing arm has two constraints that are not stylistic.**
  It must sit **above** `apps/desktop/src-tauri/*` and `scripts/*` in the `case`, which is first-match-wins:
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
--name-only` has rename detection on by default, and it reports a file moved out of `packages/ui/`
  as the **destination path only** — so the move would skip the very job whose file just
  vanished. `--no-renames` reports both ends. (3) **`ci-ok` reads a `skipped` build job as a
  pass, so `changes` itself may never be one**: if the router dies both build jobs skip, and
  without the explicit `needs.changes.result == 'success'` line the gate goes green having run
  nothing at all.
- **A Rust-only change runs `frontend` too, because tests on each side read the other's
  files.** This bullet used to say no test did, and the router skipped `frontend` on it; both
  were wrong for as long as `ipc.test.ts` had existed, so a Rust PR that drifted from
  `packages/ui/lib/ipc.ts` merged green and the red landed on the next unrelated PR. Censused
  2026-09-26: **ten frontend test files read 50 files under `apps/desktop/src-tauri/` and `crates/` as
  `?raw` text** — `ipc.test.ts` alone reads 37 app modules and eight `card-scanner` ones for
  its mirror rows, and six tests read the share golden
  `apps/desktop/src-tauri/src/share/__golden__/snapshot.json` — while **Rust tests read `packages/ui/lib/userTables.json` (`changes`), the whole
  `packages/ui/features/transfer/__golden__/` directory (`transfer::{card,fields,write}`) and
  `infrastructure/share-worker/wrangler.jsonc` (`share::publish`)**, every one inside `#[cfg(test)]`. Those
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
  under `apps/desktop/src-tauri/`, `crates/` or `scripts/` — and it was added to all five lists a gated job
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
    `contents: write` alone — and from 2026-10-04 to 2026-10-07 so did `android-sign`, which
    uploaded the APK; since 2026-10-07 it uploads nothing to the release and gets
    `contents: read`, with `android`, `web` and `web-deploy`: a deploy to Cloudflare needs
    nothing of GitHub's.
  - **`scripts/actions-pinned.test.mjs` is the fence**: it globs every workflow and composite
    action and fails on a `uses:` that is neither local nor a SHA with a version comment, a
    checkout without `persist-credentials: false`, a write grant above `jobs:`, a Dependabot
    config that stops watching either directory. (It also fenced the update-signing secret to one
    step of a `sign` job until that job was removed on 2026-09-29, below; **since 2026-10-04
    `scripts/release-rule.test.mjs` fences the two jobs that hold a secret now** — *The release
    rule*, below.) Comments are stripped
    before any of it is read, since these files explain themselves in prose that names both.
- **Every `npm run <name>` a workflow asks for is a script `package.json` has**
  (`scripts/workflow-scripts.test.mjs`). On 2026-10-04 the edit that added `lint:claude`
  (`daa70e12`) took `web:smoke`'s line instead of sitting beside it; nothing `npm run verify`
  runs calls `web:smoke`, so the first thing to notice was the `web` job — `npm error Missing
  script` on `main`, and again on the release PR (#786) once it merged `main`. The fence globs
  every workflow and composite action, reads `package.json`'s own scripts too (`lint` calls
  `lint:claude`, `verify` calls four), strips comment lines first, and carries a guard that it
  still sees `web:smoke` in `ci.yml` — a census that matched nothing would pass.
- **A push to `main` gets a concurrency group of its own; PR runs still cancel each other.**
  Routing on a push diffs from `github.event.before`, so a cancelled `main` run's commits were
  never routed by the next one — and turning `cancel-in-progress` off alone would not have
  saved them, because GitHub replaces a *pending* run in a group with the next arrival
  regardless.
- The `rust` job writes a stub `apps/desktop/dist/index.html` first. `tauri-build` reads
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
  the day: workspace root the repository, target directory `src-tauri/target`. (On 2026-10-08
  the build tree did move, to `target/` at the root, and the pin now reads `target`; see
  [the repository layout](repository-layout.md).) What followed
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
    follow the root's config into `src-tauri/target` (now `target`, since 2026-10-08); in
    `scanner-bundle.yml` that is also a tree its `rust-cache` (`workspaces: crates/card-scanner`)
    never saves.
  - **`Swatinem/rust-cache` takes `workspaces: ". -> target"`** in `ci.yml` and
    `release.yml` — where the lockfile is, then where the artifacts are. (It read `". ->
    src-tauri/target"` until 2026-10-08, when the build tree moved to the root.)
  - **Proven by a run on 2026-10-03: `tauri-action` still finds its bundles.** v0.40.0 was the
    first release under the workspace; it is invoked exactly as before, the portable step read
    `src-tauri/target/release/mtg-grimoire.exe` as before (now `target/release/mtg-grimoire.exe`,
    since 2026-10-08), and all five files were attached —
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
    joins a relative value onto the directory holding the `.cargo` folder: `<root>/src-tauri/target`
    (now `<root>/target`, since 2026-10-08).
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
  `core` as it said it would — and never `apps/desktop/src-tauri/**`, which the engine does not depend on.
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
  `tauri.conf.json` says `minSdkVersion: 26` too, which `apps/light/host.test.ts` pins.
- **The `android` job builds the light app's APK** (phase 4, 2026-10-03): `npx tauri android
  build --apk --target aarch64` from `apps/light/` on `ubuntu-24.04`, with JDK 21 from the image
  (`JAVA_HOME_21_X64` — JDK 25 breaks the Android Gradle and Kotlin plugins), `NDK_HOME` set to
  the image's `ANDROID_NDK_LATEST_HOME`, and the light bundle built by the host's
  `beforeBuildCommand`. It writes the APK's size and the `.so`'s to the step summary and uploads
  the APK (`actions/upload-artifact`, 14 days). **A release build signed with the runner's debug
  key** — installable, but one run's APK does not upgrade over another's. **Since 2026-10-04 it
  then proves the release's signing on a key nobody keeps**: a keystore minted by `keytool` with
  a random password in the runner's temp folder, `scripts/android-sign.sh` run over the APK with
  it — the script `release.yml`'s `android-sign` job runs with the release key (*The release
  rule*, below) — and both files deleted. What is uploaded is still the debug-signed build, and
  the job still holds no secret. **It runs the script's two refusals as well**, and fails
  unless each exits non-zero and leaves no APK: the same key against a fingerprint file naming
  another, and a keystore minted as `CN=Android Debug`. *(Until 2026-10-07: the bundle and
  `scripts/android-release/proof.sh` replaced the APK and this script — see the first bullet
  under the table in *The release rule*.)* **`scripts/android-sign.sh` routed here** until 2026-10-07 (`frontend`, `rust`,
  `android`, above `scripts/*`), because this step was the only run of it a pull request got;
  `scripts/android-release/*` has that place now.
  Its routing is the
  host's tree (`apps/light/src-tauri/*`), the workspace's root files, the toolchain pin and — since
  2026-10-04 — `apps/light/vite.config.ts` (above) — **not
  the fail-safe and not `crates/grimoire-core/*`**: an unrecognised path cannot be an input to
  the APK, the engine's Android compile is `core`'s, and its API against the host is compiled by
  `rust`, where `apps/light/src-tauri` is a workspace member. Every arm that sets `android` sets
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
    src-tauri/target"` (now `". -> target"`, since 2026-10-08) and `key: web-wasm32`. **No `dist/` stub**: `cargo build -p grimoire-web`
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
    `src-tauri/target` (now `target`, since 2026-10-08).
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
    `tsc`, `tsc -p packages/ui/tsconfig.web-worker.json`, then the light entry in `web` mode into
    `apps/light/dist-web/`, with the engine from `dist-wasm/` emitted under `apps/light/dist-web/wasm/<build id>/`.
    The config fails a build whose engine is not there, which is why the module is built first.
  - **A size report to the step summary**: every `.wasm` under `apps/light/dist-web/` — found rather than
    named, because the module sits under a directory named for the engine's build, and a
    bundle with none fails the step — in bytes and MiB, raw and `gzip -9`, and `apps/light/dist-web/`
    whole with its file count.
  - **`npm run web:smoke`, with `CHROME` set to the image's own Google Chrome**: `google-chrome`
    on `PATH`, else the `CHROME_BIN` the image sets, else the step fails saying the runner has
    no browser. Nothing is downloaded — a Chrome fetched at run time is a binary nobody pinned.
    Its version goes in the summary, because a figure taken in a browser is a figure about that
    browser. The smoke step has `timeout-minutes: 10`: the failure it guards is a page that
    waits for ever, and a job otherwise has six hours to do that in.
  - **`npm run web:sync-smoke`** (phase 6, step 6.3): live sync end to end — the relay's own
    code under workerd (`wrangler dev --local`, a local D1, a throwaway signing key by
    `--var`), two Chrome profiles that resolve the relay's real name to it, a claim, a
    pairing, and a write on each device arriving on the other with nothing pressed, under the
    shipped policy. wrangler is installed by `npm ci --ignore-scripts --prefix infrastructure/app-worker`,
    from that directory's own lockfile (step 6.6's) and from nowhere else — never
    `npx wrangler@…`, a version nobody pinned — and the job holds no secret. ⚠️ **It was
    written and run on one Windows machine, and its first run on a runner is the pull request
    that added it**: whether wrangler's self-signed TLS, workerd and two Chromes fit a runner's
    ten minutes is that run's to say.
  - **`infrastructure/relay/**` routes to `frontend`, `rust` and `web`** since the same step — out of the
    fail-safe, which ran `core` and `storybook` for it: `frontend` tests it, Rust tests read
    three of its files as text, and `web` is the one job that runs it.
  - `apps/light/dist-web/` uploaded as `mtg-grimoire-web` (`actions/upload-artifact`, 14 days,
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
  touches `apps/light/src-tauri/**`, `crates/grimoire-core/**`, `Cargo.lock`, itself or its script.
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
  which it reports as *held — the emulator reported a metered network* (step 4.4's hold). Since
  2026-10-08 it first waits, up to 90 s, for the emulator's default network to be an unmetered
  one, and reports the wait: a fast boot had launched the app while the cellular link was still
  the default, and a healthy tree read *held* (light-app.md §8.5). The
  router sends a change to the workflow to `frontend`, beside `release.yml`, for the two tests
  that read every workflow; the script is `scripts/*`. **No run had happened when this was written** —
  the first is the pull request that adds it; [light-app.md](../reference/light-app.md)
  §8.5 has what each figure means and what an emulator cannot stand in for.
- **`.github/workflows/release.yml` is one workflow on purpose.** A release created with
  `GITHUB_TOKEN` does not trigger `on: release` in another workflow — GitHub's recursion
  guard — so release-please, the three hosts' builds and the publish step are jobs in one file,
  chained on `release_created`.
- **The release rule: the three hosts ship from one tag** (light app phase 6, step 6.6,
  decided by the owner on 2026-10-04). One core means one user schema per commit. Sync stamps
  every op with the sender's `USER_SCHEMA_VERSION` (`sync_engine/wire.rs`, `stamp`), and a
  device on an older build **holds** an op stamped newer — *"A device in your group runs a
  newer version of MTG Grimoire. Update this device to receive its changes."* — with no bound
  ([sync.md](sync.md)). A desktop and a phone update from a release; the web app updates from a
  deploy. So a host that ships ahead of the others strands them: a web app deployed from a
  `main` one schema rung past the last release leaves every paired desktop holding ops with no
  update to install. Until this step release-please bumped all four crates and both
  `tauri.conf.json`s from one tag and **the tag built only the desktop**: the APK was a 14-day
  CI artifact under a runner's debug key, and the web app was deployed by hand from whatever
  `main` was. Now `release.yml` is seven jobs, every one after the first gated on
  `release_created` and on nothing looser — no `always()`, no `continue-on-error`, so a job
  runs only when every job it needs succeeded:

  ```
  release-please ─┬─ build (windows, linux) ─────────────┬─ web-deploy ── publish
                  ├─ android ── android-sign ────────────┤
                  └─ web ────────────────────────────────┘
  ```

  | Job | Needs | Holds a secret | What it does |
  | --- | --- | --- | --- |
  | `build` | `release-please` | no | The desktop matrix, unchanged |
  | `android` | `release-please` | no | `ci.yml`'s `android` job, step for step: the arm64 APK and bundle at the tag, **debug-signed**, held to the tag's version (`scripts/android-release/check-version.sh`); the bundle handed on as the artifact `android-aab-debug-signed` (14 days) |
  | `android-sign` | `release-please`, `android` | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD` | Re-signs that bundle with the owner's upload key (`scripts/android-release/sign-bundle.sh`), held to the committed fingerprint, and leaves `mtg-grimoire-<version>-android.aab` as the artifact `play-upload-bundle` (30 days). Attaches nothing to the draft; `contents: read` |
  | `web` | `release-please` | no | `ci.yml`'s `web` job less its lint and size report: clang, the wasm target, the lockfile's `wasm-bindgen` CLI, `web:wasm`, `web:build`, `web:smoke`; `apps/light/dist-web/` handed on as the artifact `web-bundle` (14 days) |
  | `web-deploy` | `release-please`, `build`, `android-sign`, `web` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Refuses a tag older than the newest published release; `npm ci --ignore-scripts` then `npx --no-install wrangler deploy` from `infrastructure/app-worker/`; then `scripts/web-deploy-probe.mjs` against `https://mtg-grimoire.app` |
  | `publish` | `release-please`, `build`, `android-sign`, `web-deploy` | no | Flips the draft to published |

  - **Since 2026-10-07 the Android host goes to Google Play, and only there** (the owner's
    decision; `docs/superpowers/specs/2026-10-07-google-play-release-design.md`). What follows
    in this section was written for an APK attached to the release and signed with
    `apksigner`; four things changed and the rest stands. **A bundle, not an APK**: Play takes
    an Android App Bundle, so the build runs `tauri android build --apk --aab` and the bundle
    is what is signed. **`jarsigner`, not `apksigner`**: a bundle is signed as a JAR, and
    `jarsigner` *adds* a signer beside the build's debug one — so
    `scripts/android-release/StripSignature.java` takes the old signature off a copy first, and
    `sign-bundle.sh` refuses a result that does not verify, that names more or fewer than one
    signer, whose signer is not the keystore's, or whose entries are not the input's. It also
    refuses an archive with no `BundleConfig.pb` (an APK handed over by mistake), a debug
    certificate, and a keystore the pin does not name. **An upload key, not the signing key**:
    Google holds the key Play signs installs with and can reset an upload key, so the pin is a
    guard against the wrong keystore in the settings and no longer the last line before every
    phone uninstalls. **And the release rule's sentence changed with it**: the tag still
    *produces* all three hosts and `publish` still waits for `android-sign`, but the Android
    one reaches phones when the owner has uploaded the bundle and Play has reviewed it — hours
    to days behind the desktop and the web app, during which a phone holds a newer op exactly
    as any older build does. The version is held in the build leg now
    (`check-version.sh` reads the generated `tauri.properties`), because a bundle's manifest is
    a protocol buffer only `bundletool` reads. **Measured while this was written** (JDK 25,
    Git Bash, a fake bundle): the proof's one signing and five refusals; and that, with the
    strip skipped, the proof fails — `jarsigner -verify` exits 1 on the doubly signed bundle
    and `sign-bundle.sh` refuses it there. **A re-run of `android-sign` more than 14 days after
    its release** finds no `android-aab-debug-signed` artifact and fails at the download;
    within 14 days a re-run signs, provided the fingerprint was in that release's commit.
    **Not until a pull request**: the same on JDK 21 against a real bundle. **Not until
    a release**: the environment handing its values over, and Play Console accepting the
    result.
  - **A secret sits in a job that builds nothing.** This is the rule the removed `sign` job
    left behind (below), kept: a build leg runs every npm lifecycle script, every cargo build
    script and every Gradle plugin, and any of them can read a file or an environment. So
    `android-sign` and `web-deploy` run no root `npm ci`, no cargo and no Gradle — a checkout,
    an artifact download, and one tool each. **That is why the APK is re-signed rather than
    signed by Gradle**, which is what Tauri's signing guide describes (a `keystore.properties`
    Gradle reads): Gradle signs inside the build, so the keystore and its passwords would be on
    disk beside all of that. The Gradle project is unchanged and knows no key —
    `apps/light/host.test.ts` fails a signing config, a `keystore.properties` or a keystore anywhere
    under `apps/light/`. **For the deploy token the blast radius is wider than its job**: unless it
    was scoped down (*What only the owner can do*), a token that can deploy this Worker can
    deploy over the relay on the same account.
  - **The two jobs take what they hold from the `release` environment, never from the
    repository's own secrets.** A repository secret is handed to any workflow on any branch of
    this repository that asks for it — a branch's edited copy of a workflow, run by a push,
    reads it. An environment's is handed only to a job that names the environment, and only
    from a branch the environment allows: `main`, once the owner has restricted it (below).
    Both jobs say `environment: release`, no other job does, and **`on:` is a push to `main`
    and nothing else** — no `workflow_dispatch`, no `pull_request`. ⚠️ **GitHub creates an
    environment a job names the first time it runs, with no rule on it.** So the first release
    after this merged made `release` empty and open; the owner's first command restricts it,
    and it has to be run **before** a value is put in.
  - **No value is in a step that does not use it.** Each job's first step after the checkout
    asks whether its values are set — a job's `if:` cannot — and it is handed `true` or
    `false` (`${{ secrets.X != '' }}`), never the value. Nothing sits in a job-level `env:`.
    The key reaches one step and the token one step. **The alias is a plain word in the
    workflow** (`mtg-grimoire`): it is no secret, and as one GitHub would mask every
    `mtg-grimoire` in that job's log, the bundle's own name among them.
  - *(Until 2026-10-07, for the APK.)* **`scripts/android-sign.sh` refuses to hand back an APK it cannot vouch for.** It signs with
    the SDK's `apksigner` (the newest `build-tools` on the runner), then asks `apksigner` who
    signed the output and compares that certificate's SHA-256 with the keystore's own, taken
    another way (`keytool -exportcert` through `sha256sum`): one signer, and that one. **It
    prints every tool's own answer beside what it read from it** — the build-tools it chose,
    `apksigner`'s and `aapt2`'s versions, the raw `verify --print-certs` of the input and the
    output, `zipalign`'s last lines for a check that said no — because a refusal that hides
    what the tool said cannot be diagnosed from a run (below). It
    refuses an output that lost the alignment Gradle gave the input (`zipalign -c -p 4`, and
    `-P 16` where the tool knows it), and — with `ANDROID_EXPECT_VERSION` set, as both callers
    set it — an APK whose `versionName` is not the version or whose `versionCode` is not Tauri's
    arithmetic on it (`aapt2 dump badging`); a version that is not a plain `x.y.z` is refused
    rather than computed with. On any refusal it deletes the output. The passwords reach
    `apksigner` and `keytool` as `env:NAME`, never on a command line, and the keystore is
    written under `umask 077` and removed when the step ends.
  - *(Until 2026-10-07, for the APK.)* **And it holds the key to the one every release has had.** "Signed by the keystore in the
    settings" is not "signed by the key the last release was": a keystore made a second time, or
    the wrong one pasted in, signs happily, and its APK installs over nothing — every phone
    uninstalls. The certificate's SHA-256 is public (it is in every APK), so it is committed:
    **`apps/light/src-tauri/release-signer.sha256`**, one line of 64 lower-case hex, absent until
    the owner makes the key. The script refuses a keystore whose certificate is not that one
    (`ANDROID_SIGNER_PIN`), before anything is signed, and refuses an Android debug
    certificate (`CN=Android Debug`) whatever else is true. **The rule is the strict one: no
    fingerprint in the tree, no APK on the release** — with the key set and the file missing
    the job attaches nothing, says so with a ⚠️ in the summary, and ends green (a failure there
    could not be repaired by a re-run, which runs the same commit). `apps/light/host.test.ts` holds
    the file's shape for the day it appears.
  - **Without its values a job attaches or deploys nothing, says so in the run's summary, and
    ends green** — so a release is not blocked on a key the owner has not made yet. Every step
    after the asking one is gated on its answer. **It never attaches the debug-signed build.**
    **Some of a job's values and not all is a failure**, naming the ones missing: that is a
    mistake in the settings, and a skip would hide it. With no token the summary also says
    what is left: the address serves the previous deploy until somebody deploys the tag by
    hand.
  - **`android` and `web` run whether or not the secrets exist.** A tag the APK cannot be built
    from, or whose web build fails its first run in a browser, is a release that would ship two
    hosts and not the third — a red run, not a skip.
  - **`publish` waits for all three, and `web-deploy` goes last.** A failure anywhere leaves
    the release a draft. The deploy is live the moment `wrangler` returns and the release is a
    draft until `publish`, so the deploy waits for the desktop builds and the bundle: nothing but
    its own probe and the flip of the draft can fail after it.
    ⚠️ **That window is not empty.** If the probe fails, or `publish` does, the web app is
    deployed and the release is a draft — the state the rule exists to prevent, for as long as
    nobody looks. The summary names the question that failed, and there are three things it
    can mean:
    1. **The edge was slow, and the page is fine now.** *Re-run failed jobs* deploys the same
       bundle again and asks again, and `publish` follows.
    2. **The page is wrong.** `npx --no-install wrangler rollback` from `infrastructure/app-worker/` puts the
       previous version back ([`infrastructure/app-worker/README.md`](../../infrastructure/app-worker/README.md), *Rolling
       back*), and the release stays a draft until the cause is found.
    3. **The page is fine and the probe is wrong — every re-run fails the same way.** The
       likely cause is the zone rewriting HTML (the README's *Before the first deploy* lists
       the features): the document served is the bundle's plus a `<script>` the build did not
       write, so the third question fails for ever. **How to tell**: download the run's
       `web-bundle` artifact and compare — `curl -s https://mtg-grimoire.app/ | diff -
       index.html`. An empty diff with a failing probe is a probe to fix; a diff that is an
       injected tag is a zone feature to turn off, and then outcome 1. If the address is
       serving this build and only the probe stands in the way, the release is published by
       hand, once every asset is on the draft: `gh release edit vX.Y.Z --draft=false --repo
       Msgaihede/mtg-grimoire`. Do not leave it: a deployed web app and a draft release is the
       strand this rule is about.
  - **The probe asks three things of `GET /`**, up to six times ten seconds apart, each
    attempt given fifteen seconds to answer in full (the step has five minutes): it answers
    200; its `Content-Security-Policy` is the built `_headers` line byte for byte (the runbook's
    probe 1, read with `infrastructure/app-worker/src/headers.ts`); and the document is the bundle's
    `index.html` byte for byte — the one that says *this* build is being served, since the
    first two pass on yesterday's deploy whenever the policy did not move.
  - **This is the only job that deploys anything, and it deploys one Worker.** The relay holds
    secrets and a D1 with real entitlements, the share Worker a D1 and R2 of its own, and their
    deploys stay by hand. The account id is kept out of the tree: it is in no file here.
  - **`wrangler` is pinned by a lockfile, and nothing it brings runs before the token's step.**
    The first version of this job ran `npx --yes wrangler@4.146.0 deploy`, which pinned one
    package of ninety-one: the other ninety came through floating ranges, resolved on the day
    of the release, and two of them — `esbuild` and `workerd` — run a `postinstall`, in the
    step that held the token. Now **`infrastructure/app-worker/package.json` names `wrangler` at an exact
    version and nothing else, and `infrastructure/app-worker/package-lock.json` names all ninety-one with the
    registry's integrity hash**. The job runs `npm ci --ignore-scripts` there in a step with
    nothing in its environment, and then `npx --no-install wrangler deploy` in the step with
    the token: what runs is what the lockfile installed, or the step fails. The by-hand
    runbook uses the same two lines, so a deploy by hand and a deploy by the job run the same
    bytes. **It is not a dependency of the app**: `infrastructure/app-worker/` is not a workspace of the root
    package, so the root's `npm ci` — every other job's — installs none of it. **Moving the
    version is `npm install --package-lock-only --ignore-scripts wrangler@<version> --prefix
    infrastructure/app-worker`**, and a pull request with both files.
    **What is proved** (2026-10-04, Windows 11, Node 24.16): in a copy holding exactly what the
    job's checkout holds — `infrastructure/app-worker/`, the one `packages/ui/` file the script imports, the root
    `tsconfig.json`, a `apps/light/dist-web/` — `npm ci --ignore-scripts` exited 0 with no lifecycle line
    in npm's verbose log, `npx --no-install wrangler --version` answered `4.146.0`, and
    `npx --no-install wrangler deploy --dry-run` read the assets, bundled the script (1,120 B)
    and exited 0. So neither `postinstall` is needed for a deploy on Windows: each only swaps a
    JavaScript launcher for the native binary it would start anyway, and `esbuild`'s own API
    finds its platform package with `require.resolve` (`lib/main.js`). **What is not proved:
    the same on Linux, which is what the runner is.** What was checked from here is that the
    lockfile gives a Linux runner its two platform packages — `npm ci --ignore-scripts
    --os=linux --cpu=x64` installed `@esbuild/linux-x64/bin/esbuild` and
    `@cloudflare/workerd-linux-64/bin/workerd` — and that `esbuild`'s lookup is one code path
    for both systems. Nobody has run them there without the scripts; the first release is that
    run, and a failure in it is before anything is uploaded.
  - **A deploy is not a release's to make twice.** `web-deploy` can be run again long after
    its run, and would upload its tag's bundle over a later release's — an older user schema
    in front of desktops that have moved on. So before it installs anything it reads
    `repos/…/releases/latest` with the run's own token and **refuses a tag older than the
    newest published release** (`sort -V`). On a first run that release is the previous one,
    which is older; on a re-run after its own publish it is itself.
  - **The order with the relay is the owner's to keep.** The web app asks the relay from a
    page, and the relay answers only an origin and a protocol it knows. **A release whose web
    build needs new relay behaviour needs the relay deployed first, by hand, before the release
    PR is merged** — merging is what deploys the web app, and the job asks the relay nothing.
  - **`scripts/release-rule.test.mjs` is the fence**, and every line of this list was checked
    by breaking `release.yml` that way and seeing a test go red (23 mutations, 2026-10-04):
    the seven jobs and what each needs; that no job's `if:` is looser than `release_created`;
    that **`on:` is a push to `main` and nothing else**; that **every appearance of the word
    `secrets`, in any case and any form, is exactly `secrets.NAME` with a name that job may
    read** — so `secrets.lower_case`, `secrets['X']` and `toJSON(secrets)` are red anywhere,
    and so is an honest spelling in a build leg — and that each job reads all of its list and
    no more; that no job names a secret or an `env:` above its steps; that `environment:
    release` is on those two jobs and no other; that **everything a secret-holding job can run
    is on a list, to the letter** — `android-sign`: the signing script and nothing else (it
    uploads its artifact with an action, not a command); `web-deploy`: the `gh api` read, `npm ci --ignore-scripts`, `npx --no-install
    wrangler deploy`, the probe — so a second `npx`, a `node -e` or an `npm run` is a line not
    on it *(until 2026-10-08 the list held only lines naming a program the test knew, so a
    `./tools/sign`, a `perl -e` or a `sudo` was no line at all; since then it is every line of
    every `run:` in the two jobs, and every `shell:` is `bash` — a `- run: ./tools/x`, gated
    or not, in either job is red)*; that the asking step is handed flags and never values,
    and every step after it is gated on its answer; that the signing step is held to the
    fingerprint and `present=true` is
    said only with the file there; that **`wrangler` appears once in all the workflows**, as
    that line, after an install step with nothing in its environment; that
    `infrastructure/app-worker/package.json` holds one exact dependency and the lockfile an integrity hash
    for every package; that no workflow names the relay or the share Worker; that no 32-hex
    account id is in the file; that each new job has a deadline; and that the two build legs
    run the commands `ci.yml` runs.
  - **The Android `versionCode` rises with every release.** Nothing types it: with no
    `bundle.android.versionCode` in `apps/light/src-tauri/tauri.conf.json`, the Tauri CLI computes
    `major × 1,000,000 + minor × 1,000 + patch` from that file's `version` and writes it to the
    generated, uncommitted `gen/android/app/tauri.properties`, which `build.gradle.kts` reads —
    so `0.40.0` is `40000` and `0.41.0` is `41000`. release-please bumps that `version`, so
    every release is a higher code, and Android installs an update only over a lower one. The
    arithmetic keeps its order while the minor and the patch stay under 1000; the test holds
    that, and that nobody adds an explicit code or `autoIncrementVersionCode` (which counts in
    a file that is not committed, so every runner would start from one).
  - **Between releases, `npm run web:deploy-guard`** (`scripts/web-deploy-guard.mjs`) is the
    same rule for a deploy by hand: it reads `USER_SCHEMA_VERSION` in the working tree and at
    the last release's tag (`v` + `.release-please-manifest.json`'s version, through `git show`)
    and exits 1 when they differ — *"This tree's user schema is 60, the last release (v0.40.0)
    is 59: a web app deployed from here would send paired desktops ops they must hold until a
    release exists."* — 0 when they are equal, and **2 when it could not read either side**,
    which is never a pass. The runbook runs it before `wrangler deploy`.
    **It also asks whether that release is published** (`gh release view <tag> --json
    isDraft`): release-please makes the tag with the *draft* (`force-tag-creation`), so after a
    release run that failed the tag exists, the tree equals it, and no desktop can install it.
    A draft is exit 1; `gh` missing or the question failing is exit 2; **`--offline`** skips
    the question and says in its answer that it did. **Run on 2026-10-04** against this branch
    and against `origin/main` at `ea0aa88e`: both 59, as v0.40.0 is, and v0.40.0 is published,
    so a web deploy from `main` that day strands nobody; against a tag that does not exist and
    one that predates the file's path it exited 2 with git's own words, and with `gh` taken
    off `PATH` it exited 2 saying so. No draft existed to ask about; that path is the unit
    tests'.
    ⚠️ **What the guard cannot see: equal schemas are necessary, not sufficient.** The stamp is
    the only thing on the wire that tells an older build *update to read this*. A change to
    the wire that is not a schema rung — a new op `kind`, a field an older parser refuses —
    arrives on an older build as a batch that does not parse and says nothing newer of itself,
    which is `WireError::Malformed` (`wire.rs`), and **the client steps over a `Malformed`
    batch** where it holds a `Newer` one. Not held until an update: dropped. The guard reads
    one constant and passes such a tree, and nothing in this repository tells the two apart —
    a wire change with no rung is a reason to wait for a release that only a reader of the
    diff will find.
  - **What is proven, and what the first release will be the first run of.** Driven locally
    (Git Bash and Node 24 on Windows, 2026-10-04): the guard, against the real tag and the
    real release; the probe, against a local server answering as the host should, once a
    request late, and in eight ways it should not (another policy, none, yesterday's document,
    a rewritten one, a redirect, a request never answered, a body never finished, no
    listener); the two asking steps and the newest-release refusal, extracted from the
    workflow's own YAML and run under each case (`gh` stubbed for the refusal); the lockfile
    install and a `wrangler deploy --dry-run` (above); `android-sign.sh`, with the real
    `keytool` on a throwaway key and **`apksigner`, `zipalign` and `aapt2` stubbed** — this
    machine has no Android SDK — through every refusal, the fingerprint's and the debug
    certificate's among them. **On the pull request**: `ci.yml`'s `android` job runs the
    signing script with the real SDK tools — once to sign, once against another key's
    fingerprint and once with a debug certificate, each of the last two required to refuse.
    **Its first run failed, and its second is the measurement** (#821, 2026-10-04,
    build-tools 37.0.0, the newest of six on the image; `apksigner` 0.9 on the `PATH`'s Java
    17, not `JAVA_HOME`'s 21). The stubs had been written from the wording in AOSP's source
    and build-tools 37 uses another: **`V2 Signer: certificate SHA-256 digest: …`** for the
    build's own APK and **`V3.0 Signer: certificate SHA-256 digest: …`** for the re-signed
    one, where the script looked for `Signer #1 certificate SHA-256 digest:`. It read no
    signer from the runner's own build, refused it before signing anything, and **printed
    nothing of what the tool had said** — so the run could not say why. Since then the script
    prints the build-tools it chose, each tool's version and every tool's raw answer beside
    what it read from it; matches the digest line on the part all three wordings share;
    counts a certificate once however many schemes name it; and treats who signed the *input*
    as a note, since nothing depended on it. The second run, on real tools: signed and
    verified against the fingerprint; **aligned 4 KB / 16 KB — in yes / yes, out yes / yes**,
    so re-signing keeps what Gradle gave; `aapt2 dump badging` answered `package:
    name='com.mtggrimoire.app' versionCode='40000' versionName='0.40.0' …`, which is Tauri's
    arithmetic measured and no longer derived; another key's fingerprint refused; a `CN=Android
    Debug` keystore refused.
    **Not until a release**: the `release` environment handing its values to a job on `main`;
    the artifact hand-off between jobs; `gh release upload` of the APK; `npm ci
    --ignore-scripts` and `wrangler deploy` on Linux and under an API token; the probe against
    the real address; and a signed APK installing over the last one on a phone. **As of 2026-10-07, not until a
    release**: the environment handing its values to a job on `main`; the artifact hand-off
    between jobs; `jarsigner` on the runner's JDK 21 against a real bundle under the release
    key; and Play Console accepting the result.
- **What only the owner can do.** No agent makes a key, sets a secret, creates a token or
  changes a setting of the repository. Until these are done every release ends green with a
  summary saying what it did not ship. PowerShell, **in a folder outside the repository** that
  is backed up — **in this order**: the environment is restricted before anything is put in it.
  None of these commands has been run by anybody; the two `gh api` calls are GitHub's
  documented REST shapes (*Create or update an environment*, *Create a deployment branch
  policy*).

  **Step 0 comes before any value is set: on 2026-10-07 the `release` environment existed with no branch rule and no values (asked of the host), so anything put in it before step 0 is readable by a workflow on any branch.**

  ```powershell
  # 0. Once, BEFORE any value exists: the `release` environment, usable from `main` alone.
  #    (If a release has run since this merged, GitHub has already made the environment —
  #    empty, with no rule. The same call restricts it.)
  gh api -X PUT repos/Msgaihede/mtg-grimoire/environments/release -F "deployment_branch_policy[protected_branches]=false" -F "deployment_branch_policy[custom_branch_policies]=true"
  gh api -X POST repos/Msgaihede/mtg-grimoire/environments/release/deployment-branch-policies -f name=main -f type=branch
  #    Check it: this prints `main` and nothing else.
  gh api repos/Msgaihede/mtg-grimoire/environments/release/deployment-branch-policies --jq ".branch_policies[].name"

  # 1. The UPLOAD key — the key Play Console knows this account's uploads by. Google makes and
  #    keeps the key Play signs installs with (Play App Signing); this one only proves a bundle
  #    came from here. keytool asks for a password twice and for a name; a PKCS12 keystore (the
  #    default) has one password for the store and the key. The alias must be this one: the
  #    workflow names it.
  keytool -genkeypair -v -keystore mtg-grimoire-release.keystore -storetype PKCS12 -keyalg RSA -keysize 2048 -validity 10000 -alias mtg-grimoire

  # 2. Its certificate's fingerprint, into the repository. No release signs a bundle until this
  #    file is on `main`, and every release after is held to it. It is the SHA-256 Play Console
  #    shows under Test and release → App integrity → Upload key certificate, without the colons
  #    and in lower case — compare them after the first upload.
  keytool -exportcert -keystore mtg-grimoire-release.keystore -alias mtg-grimoire -file mtg-grimoire-release.der
  $sha = (Get-FileHash mtg-grimoire-release.der -Algorithm SHA256).Hash.ToLower()
  [IO.File]::WriteAllText("D:\Code\mtg-grimoire\apps\light\src-tauri\release-signer.sha256", "$sha`n")
  #    Then in the repository: a branch, `git add apps/light/src-tauri/release-signer.sha256`,
  #    a `chore:` commit, a pull request, merged.

  # 3. The keystore as base64 and its password, into the ENVIRONMENT (`--env release`), never
  #    the repository. The two prompts take the same password; `gh` reads each from a hidden
  #    prompt, so neither is in the shell's history.
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\mtg-grimoire-release.keystore")) | gh secret set ANDROID_KEYSTORE_BASE64 --env release --repo Msgaihede/mtg-grimoire
  gh secret set ANDROID_KEYSTORE_PASSWORD --env release --repo Msgaihede/mtg-grimoire
  gh secret set ANDROID_KEY_PASSWORD --env release --repo Msgaihede/mtg-grimoire

  # 4. The Cloudflare token and the account id (below), each pasted at a hidden prompt.
  gh secret set CLOUDFLARE_API_TOKEN --env release --repo Msgaihede/mtg-grimoire
  gh secret set CLOUDFLARE_ACCOUNT_ID --env release --repo Msgaihede/mtg-grimoire
  ```

  - ⚠️ **`--env release` on every one, and step 0 first.** A value set without it is a
    repository secret, which any branch's workflow can read — the hole the environment is
    there to close; and the jobs read the environment's, so it would also do nothing. An
    environment's value set before step 0 is, for that while, in an environment any branch may
    use. **An approval rule is optional** (*Required reviewers* on the environment): it would
    hold each of the two jobs for a click on every release, which for one maintainer buys a
    pause and not a second pair of eyes.
  - ⚠️ **Back the keystore and its password up, somewhere that is not this repository and not
    only this machine.** GitHub never gives a secret back. **A lost upload key is an
    inconvenience, not a catastrophe**: Play Console → *Test and release* → *App integrity* →
    *App signing* → *Request upload key reset*, with a new key's certificate; Google takes
    about two days, and no phone notices, because Play signs what phones install. Then the new
    fingerprint goes into `release-signer.sha256` by pull request and the three values are set
    again. The root `.gitignore` ignores `*.jks`, `*.keystore`, `*.p12`, `keystore.properties`
    and `*.aab` for the day one is made in here anyway. **The fingerprint file is the opposite:
    public, and meant to be committed.**
  - **A Play install does not go over a CI artifact's debug-signed APK.** The owner's phone,
    and anything else running one, needs one uninstall — which wipes `user.db` and its paired
    identity — before the first install from Play. It is the last.
  - **The artifact downloads from the run page as `play-upload-bundle.zip`**; Play wants the
    `.aab` inside it.
  - **What is typed at `keytool`'s name prompts is public.** The signing script prints the
    certificate's `Owner:` line to a public run log, and it is in every bundle the key signs.
  - **The Console side** — creating the app, Play App Signing with a Google-generated key, the
    first upload registering the upload key — is in
    `docs/superpowers/specs/2026-10-07-google-play-release-design.md` §7.
  - **After every release, the bundle is uploaded by hand**: the run's summary names the
    artifact (`play-upload-bundle`) and its versionCode. Play Console → *Test and release* →
    the track → *Create new release* → upload → roll out. Until then phones stay a version
    behind. (Uploading from this workflow is a later change, with its own design.)
  - **The Cloudflare API token.** Dashboard → *Manage Account* → *Account API Tokens* →
    *Create Token* → a custom token, limited to this one account. `wrangler deploy` here
    uploads one existing Worker's script and static assets and re-states its Custom Domain, so
    by Cloudflare's own table (`developers.cloudflare.com/workers/authorization/workers/`, read
    2026-10-04) it needs: **the Workers *Editor* role on the Worker `mtg-grimoire-app`** — where
    the form offers a single Worker as the scope, choose that and not the account — and
    **Zone → Workers Routes → Write (Edit) on the zone `mtg-grimoire.app`**, which the same
    page asks for whenever a deploy touches a Route or a Custom Domain (Custom Domains have no
    per-Worker role yet). If the form has no per-Worker scope, the older equivalent is
    **Account → Workers Scripts → Edit**, and that token **can deploy over the relay and the
    share Worker**. Nothing else: no KV, R2, D1, Pages, DNS, account settings or user details.
    ⚠️ **Do not use the *Edit Cloudflare Workers* template as it stands** — it grants all of
    those on every zone. **Not verified**: no deploy has been made with such a token; wrangler
    may warn that it cannot read the user's email, which is the *User Details* permission this
    leaves out and is not an error. If the first run fails on a permission, its log names it.
  - **`CLOUDFLARE_ACCOUNT_ID`** is the 32-hex id on the dashboard's Workers overview, and what
    `npx --no-install wrangler whoami` prints from `infrastructure/app-worker/`.
  - **A release cut before a value existed is not repaired by adding it.** Its web app is
    deployed by hand from the tag (the runbook). Its bundle is the next release's: a re-run of
    `android-sign` runs the commit it ran before, which holds no fingerprint.
- **Versions are never typed by hand.** release-please reads the `feat:`/`fix:`/`!` prefixes
  and keeps a `chore(main): release X.Y.Z` PR open that bumps every version file and writes
  `CHANGELOG.md`. Merging it tags, builds and publishes. **Which files is
  `release-please-config.json`'s to say, and this page keeps no count of them** — it said
  *all five* and listed `package.json`, `package-lock.json`, `apps/desktop/src-tauri/tauri.conf.json`,
  `apps/desktop/src-tauri/Cargo.toml` and `Cargo.lock` long after the workspace had added more. The shape:
  `package.json` and its lockfile belong to the `node` release type, and `extra-files` holds
  the rest — for **every cargo workspace member** its `Cargo.toml` (`$.package.version`) and
  its own entry in the root `Cargo.lock` (at the root since 2026-10-02; `apps/desktop/src-tauri/Cargo.lock`
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
  manifests and not the config; the Android host's `tauri.conf.json` and manifest are held to the
  desktop's by `apps/light/host.test.ts` (*ships from the desktop's tag, at the desktop's version* —
  this sentence said *nothing holds the Android host's* until 2026-10-04, though that test
  already did).
  **Since 2026-10-08 the members inherit the version** (`version.workspace = true`), so the
  shape above is no longer what the config holds: it names the root `Cargo.toml`
  (`$.workspace.package.version`) once, one `Cargo.lock` selector per member (five) and one
  `tauri.conf.json` per Tauri host (two), and no member's own manifest. **A new member now owes
  a lockfile selector in the config and `version.workspace = true` in its own manifest** — a
  manifest with a literal version of its own is a second version nothing bumps.
  **And since 2026-10-04 one test holds all of it at once** — `scripts/release-rule.test.mjs`:
  every member the root `Cargo.toml` lists has its manifest and its own `Cargo.lock` selector in
  the config, both Tauri hosts have their `tauri.conf.json` there, the config names nothing
  else, and every one of those versions — with `package.json`'s, `package-lock.json`'s and
  `.release-please-manifest.json`'s — is the same string in the tree. A fifth member fails it
  until it has its pair. (`.release-please-manifest.json` left the router's prose arm for an arm
  of its own, `frontend`, the day that test read it.)
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
  in the same job. **Update signing has not come back; the rule has been used twice since**
  (2026-10-04): `android-sign` and `web-deploy` are each a job of their own for it — *The
  release rule*, above. And what happened to v0.34.0 is why those two **skip and say so**
  when their values are not set, where `sign` failed: a release held up by a key nobody had
  made was one day's lesson already.
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
  can reach), plus `.deb` and `.AppImage`. **Nothing Android is a release asset**: the light app's signed bundle is the workflow artifact `play-upload-bundle`, on its way to Google Play (*The release rule*, above). The bundler
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
