# CI and releases

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- Three workflows — the third, **`scanner-bundle.yml`** (2026-09-15), builds and publishes the
  card scanner's embedded assets and is recorded in [card-scanner.md](card-scanner.md) §10; this
  page covers the other two. **`.github/workflows/ci.yml`** gates PRs and pushes to `main`: a `changes`
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
  `npm run verify` and by nothing in CI), a `core` matrix (below, 2026-10-02) and a
  `powershell` job (below). The `wasm` and `android` compile gates went with the web and
  Android builds, which were removed on 2026-09-27; `core` is what replaces them, for the
  extracted engine alone.
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
  → every job that installs Node;
  **`src/features/transfer/__golden__/**` and `src/lib/userTables.json` → `frontend` and
  `rust`**;
  `*.ps1`/`*.psm1`/`*.psd1` → `powershell`; `ci.yml` and the router itself → **every job**;
  **`crates/*` → `frontend` and `rust`** (declared 2026-09-08 — it is what
  the fail-safe below was already doing for the `card-scanner` crate, whose `.rs` files
  `ipc.test.ts` reads as text and whose `scripts/*.mjs` `eslint .` lints) **and `core` since
  2026-10-03**, when the engine took `card-scanner` as a dependency, **with
  `crates/grimoire-core/**` above it → `frontend`, `rust` and `core`** (2026-10-02);
  prose and editor/release bookkeeping → neither; and **anything unrecognised → every**
  build job, `storybook` and `core` included.
  That last arm is the fail-safe that makes the lists safe to be wrong in the cheap
  direction — a new root config file or a new top-level directory gets full CI until someone
  narrows it deliberately. Only the "neither" arm can wrongly skip work, so it stays small.
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
    tests the members only.
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
  API-26 clang, the first attempt's `minSdk` carried over — there is no Android project in
  the tree to read a level from, and it is phase 4's to settle.
- **`.github/workflows/release.yml` is one workflow on purpose.** A release created with
  `GITHUB_TOKEN` does not trigger `on: release` in another workflow — GitHub's recursion
  guard — so release-please, the build matrix and the publish step are jobs in one file,
  chained on `release_created`.
- **Versions are never typed by hand.** release-please reads the `feat:`/`fix:`/`!` prefixes
  and keeps a `chore(main): release X.Y.Z` PR open that bumps all five version files —
  `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
  `Cargo.lock` (at the root since 2026-10-02; `src-tauri/Cargo.lock` until then) — and writes
  `CHANGELOG.md`. Merging it tags, builds and publishes.
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
  `mtg-grimoire`, so the `grimoire-core` entry now in the same file is not what it matches.
  Not re-measured since the move — the first release PR after it is the measurement, and
  `--locked` is still what would fail it.
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
