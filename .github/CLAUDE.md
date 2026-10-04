# .github — CI and releases

Four workflows — `ci.yml`, `release.yml`, since 2026-09-15 `scanner-bundle.yml`, and since
2026-10-03 `android-emulator.yml`, which has never run — and every rule below was measured live
unless it says otherwise. Full detail, including the proof runs:
[docs/reference/ci-and-releases.md](../docs/reference/ci-and-releases.md); the scanner bundle's
record is [card-scanner.md](../docs/reference/card-scanner.md) §10.

## `ci.yml`

- **`ci-ok` is the one protected check.** Branch protection pins names by string and a matrix
  job's name embeds its matrix values, so the aggregator is what has teeth and the matrix
  underneath stays free. `enforce_admins` is **false**: a red PR cannot merge, a direct push to
  `main` still can.
- **A change only builds what it can have broken.** The `changes` job diffs against the base and
  hands the paths to **`scripts/ci-route.mjs`**, whose arms are `case` semantics kept exactly —
  first match wins, `*` crosses `/`. `src-tauri/**` → **`frontend` and `rust`**, `frontend`
  included because frontend tests read its files as text (`ipc.test.ts`'s mirror rows, the
  share golden, `desktop.rs`'s `generate_handler!` for the fake's parity test) — and **not
  `storybook`**, which builds nothing from there; `src/features/transfer/__golden__/**` and
  `src/lib/userTables.json` and `src/lib/syncedTables.json` → `frontend`, `rust` and `storybook`,
  because Rust tests read them;
  **`crates/grimoire-core/**` → `frontend`, `rust` and `core`** (2026-10-02), on an arm that
  must stay **above** `crates/*` — first match wins, and that arm would take the engine's tree
  and skip the one job that exists for it;
  **`crates/*` → `frontend`, `rust` and `core`** (the `card-scanner` package is compiled by
  `rust`, `frontend` reads eight of its `.rs` files as text for `ipc.test.ts` and lints its
  `scripts/*.mjs`, and **`core` since 2026-10-03**, when the engine took the crate for the
  scanner's session glue) — while **`src-tauri/**` never runs `core`**, because the engine does
  not depend on the desktop;
  frontend sources, `.storybook/**`, the npm lockfile, configs and `.nvmrc` →
  `frontend` and `storybook`; **`scripts/` because `eslint .` lints it** → `frontend` alone;
  `rust-toolchain.toml` and `.github/actions/rust-toolchain/` → `frontend`, `rust` and `core`,
  and so do **the cargo workspace's own files at the root — `Cargo.toml`, `Cargo.lock` and
  `.cargo/**`** — because the lockfile is shared: a dependency bumped for the desktop moves
  what the engine's other two targets compile, and `rust` builds neither of them;
  `release.yml`, `scanner-bundle.yml`, `android-emulator.yml` and `dependabot.yml` → `frontend`,
  because `scripts/toolchain.test.mjs` and `scripts/actions-pinned.test.mjs` read them;
  `*.ps1`/`*.psm1`/`*.psd1` → `powershell`; `ci.yml` and the router
  itself → every job, `powershell` included; prose and editor bookkeeping → neither; and **anything
  unrecognised → every build job**, `storybook`, `core` and `web` included. That last arm is the
  fail-safe that makes the lists safe to be wrong in the cheap direction — and it is
  load-bearing for `share-worker/`, whose `wrangler.jsonc` a Rust test reads. **Only the
  "neither" arm can wrongly skip work, so it stays small.** And **nothing routes to `core`
  without `rust`**: `core` compiles and runs nothing, so the engine's tests are `rust`'s.
  - **`web` reads both halves, and the router gives it both** (phase 5, 2026-10-04). It builds
    the engine into a module and the light page around it, so it runs for **everything `core`
    runs for** — `CORE_SIDE` carries it, and the test holds that no arm sets `core` without
    `web` — for the web host, **`crates/grimoire-web/**` → `frontend`, `rust` and `web`** on an
    arm above the engine's (not `core`: the engine does not depend on a host), and for what the
    page is bundled from: `mobile/**`, `src/**`, `public/**`, `package.json` and its lockfile,
    `.nvmrc`, every root `tsconfig*.json`, `vite.config.ts` and `vite.watch.ts`, each beside
    `frontend` and `storybook`. **Three single files and one folder sit above the tree that
    would take them**, because that tree's arm does not set `web`: `scripts/build-wasm.mjs`,
    `scripts/web-smoke.mjs` and `scripts/web-smoke/*` (the smoke's fixtures, since step 5.2)
    above `scripts/*`, and `.storybook/fake/aliases.ts` above
    `.storybook/*` — the light config imports it in every mode. **`vite.mobile.config.ts` →
    `frontend`, `rust`, `android` and `web`**: `android` because its `beforeBuildCommand` is the
    only CI build of that config's default mode, and `rust` only because every arm that sets
    `android` sets it. Not `web`: `src-tauri/**`, `mobile/src-tauri/**` (the other two hosts),
    the root `index.html` (the desktop's document) and the rest of `.storybook/**`. **The
    fail-safe sets `web` where it does not set `android`**, and the difference is whether an
    unplaced path can be an input: never to the APK, and to a build of the page and the engine
    both, easily — a new root config, a new directory the entry imports.
  - **The two halves read each other's files, and `scripts/ci-route.test.mjs` is the fence.**
    Until 2026-09-26 the router said they shared no inputs, so a Rust-only PR that drifted from
    `ipc.ts` merged green and the red landed on the next unrelated PR. The test derives the
    census on every run — every `?raw` a collected test imports, every
    `include_str!`/`include_bytes!`/`CARGO_MANIFEST_DIR` read in either cargo package — and fails
    when a file is read by one job and not routed to it, or crosses and is not routed to both.
    It also holds `ci.yml` to exposing and gating on the names `JOBS` prints, since a name the
    workflow reads and the script never prints skips its job and `ci-ok` counts that as a pass,
    and — since 2026-09-27 — to listing every one in the classify step's check and in `ci-ok`'s
    `needs` and loop; the step itself fails on a missing or non-boolean output line.
  - **A push to `main` gets a concurrency group of its own**; PR runs still cancel each other.
    A `main` run's routing diffs from `github.event.before`, so a cancelled one's changes were
    never routed again — and disabling `cancel-in-progress` alone would not save them, because
    GitHub still replaces a *pending* run in the same group with the next.
- **`frontend` is a matrix of five legs and `storybook` is its own job** (issue #559,
  2026-09-27). One leg runs `npm run build` and `lint`; four run `npm run test:run --
  --shard=N/4`, which needs no build first — nothing a test reads comes out of `dist/`. It was
  one serial 8–12 minute job with `build-storybook` last, and branch protection's `strict: true`
  re-queues every open PR on every merge, so that path was everybody's. `ci-ok` reads
  `needs.frontend.result`, `failure` if any leg fails, so no protected name changed. A new test
  that genuinely needs the built bundle would have to move into the build leg — sharding does
  not order anything.
- **`build-storybook` is the only gate `.storybook/DesignSystem.mdx` has** — `tsc` reads only
  `.ts`/`.tsx` and ESLint ignores the file — and the only compile of `preview.css`.
- **Rust is pinned by `rust-toolchain.toml`, and no workflow installs its own** (2026-09-27).
  Every job, `release.yml` and `scanner-bundle.yml` use **`./.github/actions/rust-toolchain`**,
  which reads the channel with `sed` and hands it to `dtolnay/rust-toolchain` (SHA-pinned since
  2026-09-28, below) — that action does not read the file, and `@stable` beside it would install
  one toolchain and have rustup fetch the pinned one, without the job's components, on the first
  `cargo`. **Moving the pin is a deliberate commit**: a new stable's lints can no longer turn
  every PR red by themselves.
  **Node is pinned the same way** — every `setup-node` reads `node-version-file: .nvmrc`.
  **`scripts/toolchain.test.mjs` fences both**: it globs every workflow and fails on a direct
  `dtolnay/rust-toolchain`, a `rustup` install, or a `node-version:`.
- **Every third-party `uses:` is a full commit SHA with its tag in a trailing comment —
  `@<40 hex> # v7.0.1` — in every workflow and the composite action, and never a tag or a
  branch** (2026-09-28, issue #545). A tag is whatever its owner last pushed, and `release.yml`
  ran `@v1`-style references beside a write token and a release in progress. The SHA is the one
  the tag named that day (the peeled commit for an annotated tag), so behaviour did not move.
  **`.github/dependabot.yml`** moves SHA and comment together, weekly, one grouped `ci:` PR, over
  `/` **and `/.github/actions/*`** — Dependabot reads only the directories it is given. **Every
  `actions/checkout` sets `persist-credentials: false`** (nothing after one runs `git` against
  the remote; uploads are `gh`/tauri-action with the token handed in), and **no workflow grants a
  write permission above `jobs:`** — `release.yml` and `scanner-bundle.yml` are `permissions: {}`
  with a grant per job. **`scripts/actions-pinned.test.mjs` fences all of it**; a new workflow or
  composite action is globbed in the day it lands.
- **The `powershell` job runs the repo's `.ps1` tests on `windows-latest`** — `lock.test.ps1`
  for the worktree locks and `pr-auto.test.ps1` for the auto-PR guard — and its arm in
  `ci-route.mjs` must stay **above** `src-tauri/*` and `scripts/*` — first-match-wins, and
  `scripts/` is on the frontend list because `eslint .` lints it, which a `.ps1` is not. It
  matches `.psm1` and `.psd1` too, because **the fail-safe does not set `powershell`**: a module
  would otherwise fall through it and skip the only job that tests the change. Windows is not a
  preference — `lock.ps1` identifies a holder by pid + name + `StartTime`.
- **A new job gated on a `changes` output belongs in every list of jobs, not one:**
  `ci-route.mjs`'s `JOBS`, the classify step's output-name check, `changes.outputs`, `ci-ok`'s
  `needs` **and** its success-or-skipped loop — with the `env:` line that hands the loop its
  result, and the `echo` above it. In `needs` alone, its failure is a result the gate never
  reads. `core` went into all of them on 2026-10-02, and into `ci-route.test.mjs`'s table,
  where a job is a column every row has to answer for; `web` followed on 2026-10-04.
- **Three traps in that routing, all measured against a fixture repo:**
  1. A workflow-level `paths:` filter is the obvious implementation and is **wrong** — it skips
     the whole workflow, `ci-ok` included, and a required check that never reports leaves every
     PR merge-blocked forever. The filter has to be a per-job `if:`.
  2. `git diff --name-only` has rename detection on by default and reports a file moved out of
     `src/` as the **destination path only** — so the move would skip the very job whose file
     just vanished. **`--no-renames`** reports both ends. (It also needs `fetch-depth: 0`.)
  3. **`ci-ok` reads a `skipped` build job as a pass, so `changes` itself may never be one.** If
     the router dies both build jobs skip, and without the explicit
     `needs.changes.result == 'success'` line the gate goes green having run nothing at all.
- **The `rust` job writes a stub `dist/index.html` first.** `tauri-build` reads
  `frontendDist: "../dist"` and fails outright when it is missing, so a Rust-only job cannot
  compile a fresh checkout. It is also why `rust` is safe to run with `frontend` skipped: the
  frontend it needs is one file it writes itself.
- **The cargo workspace is rooted at the repository, and its build tree is still
  `src-tauri/target`** (2026-10-02). The root `Cargo.toml` makes members of the app in
  `src-tauri`, the engine in `crates/grimoire-core` and the light app's two hosts —
  `mobile/src-tauri` and, since phase 5, `crates/grimoire-web` — with one `Cargo.lock` beside
  it, and `.cargo/config.toml` pins `target-dir` back to where every script, skill and dev
  database already is. So the `rust` job's three commands run from the root, with no
  `working-directory`: `cargo fmt … --check` with **a `-p` for every member** (`-p mtg-grimoire
  -p grimoire-core -p grimoire-light -p grimoire-web`), `cargo clippy --workspace --all-targets`
  and `cargo test --workspace`. **Never `cargo fmt --all`** — it follows path dependencies into
  `card-scanner`, which is not rustfmt-clean; `--workspace` on the other two sees the members
  and nothing else. **So a new member is a `-p` to add in two places**, that line and
  `lint:rust` in `package.json`, and nothing goes red while it is missing: the crate is simply
  never formatted.
  `Swatinem/rust-cache` is told both halves — `workspaces: ". -> src-tauri/target"` — in
  `ci.yml` and `release.yml` alike. **This is the only job that tests the engine, and the only
  one that compiles it for Windows.** The layout was read off `cargo metadata` on the day
  (root at the repository, target under `src-tauri`), and `tauri dev` was launched under it
  that day and built to `src-tauri/target/debug`. **`tauri-action`'s bundle lookup was read
  first and has run since**: at the pinned SHA its `getTargetDir` walks up from the Tauri
  directory for a `.cargo/config.toml` and takes `build.target-dir` relative to the directory
  that holds it, ahead of its `<workspace>/target` default — so it looks in `src-tauri/target`,
  as before. **v0.40.0 (2026-10-03) was the first release under the workspace and attached all
  five files**; [light-app.md](../docs/reference/light-app.md) §6.12 has the run.
- **The `android` job builds the light app's APK** (phase 4, 2026-10-03): `npx tauri android
  build --apk --target aarch64` from `mobile/` on `ubuntu-24.04`, with JDK 21 from the image
  (`JAVA_HOME_21_X64` — JDK 25 breaks the Android Gradle and Kotlin plugins), `NDK_HOME` set to
  the image's `ANDROID_NDK_LATEST_HOME`, and the light bundle built by the host's
  `beforeBuildCommand`. It writes the APK's size and the `.so`'s to the step summary and uploads
  the APK (`actions/upload-artifact`, 14 days). **A release build signed with the runner's debug
  key** — installable, but one run's APK does not upgrade over another's. Its routing is the
  host's tree (`mobile/src-tauri/*`), the workspace's root files, the toolchain pin and — since
  phase 5 — `vite.mobile.config.ts`, whose default mode no other CI job builds — **not
  the fail-safe and not `crates/grimoire-core/*`**: an unrecognised path cannot be an input to
  the APK, the engine's Android compile is `core`'s, and its API against the host is compiled by
  `rust`, where `mobile/src-tauri` is a workspace member. Every arm that sets `android` sets
  `rust`. **Nothing in it runs the APK** — `android-emulator.yml` does, below. Its first run is
  the PR that adds it, and its numbers are that run's summary —
  [light-app.md](../docs/reference/light-app.md) §8.1.
- **The `web` job builds the light app's web host and opens it in a browser** (phase 5, step
  5.1, 2026-10-04), on `ubuntu-24.04` for `core`'s clang reason — the module is the engine
  linked, so it compiles the same `sqlite-wasm-rs` shim, and the step and its ≥ 18 guard are
  that job's. `npm ci`, the toolchain action with `targets: wasm32-unknown-unknown`,
  `rust-cache` keyed `web-wasm32`, then: `npm run web:wasm` (`cargo build -p grimoire-web
  --lib` for the target under the `wasm` profile, `wasm-bindgen --target web` into
  `dist-wasm/`), `npm run web:build`
  (`tsc` for the page and for the Worker's own program, then the light entry in `web` mode
  into `dist-web/`, the engine under `wasm/<build id>/`), a size report — every `.wasm`
  in the bundle, raw and `gzip -9`, and `dist-web/` whole — `npm run web:smoke`, and
  `dist-web/` uploaded (14 days, whenever the bundle was built, a failed smoke included).
  - **The `wasm-bindgen` CLI's version is read from `Cargo.lock` in the step, never typed into
    the workflow.** The CLI rewrites what the crate emitted and refuses a module whose schema is
    not its own, so the two are one version or the build stops — and the crate's version is
    whatever the lockfile resolves. A number in `ci.yml` would be right until a bump moved the
    crate, and then the job is red for a reason its diff does not show. The step requires
    **exactly one** `wasm-bindgen` entry in the lock, installs with `cargo install
    wasm-bindgen-cli --version "$bindgen" --locked` — compiled from crates.io and checksummed
    like every other dependency, not a downloaded binary; `rust-cache` keeps `~/.cargo/bin`, so
    the compile is a cold cache's alone — and checks what `wasm-bindgen --version` then says.
    It takes no `--target-dir`: `cargo install` from a registry starts its configuration at
    `$CARGO_HOME` and never reads this repository's `.cargo/config.toml`. `scripts/build-wasm.mjs` reads the lock for itself and refuses a CLI
    that differs; **`scripts/toolchain.test.mjs` fails any workflow whose install line carries
    anything but a shell variable after `--version`**.
  - **The smoke test's browser is the image's own Google Chrome, by path, in `CHROME`**:
    `google-chrome` on `PATH`, else `CHROME_BIN`, else the step fails saying so. Nothing is
    downloaded. Its version goes in the summary. The smoke step is bounded at ten minutes,
    because the failure it guards is a page that waits for ever.
  - **What it proves is `scripts/web-smoke.mjs`'s to say**, and since step 5.2 that is **an
    offline first run** — the module instantiates, the engine opens its database, and the
    launch's downloads run to their end, in one Chrome on Linux, with every cross-origin
    request answered from `scripts/web-smoke/`. A request with no fixture fails the run, as
    does one that would cost a CORS pre-flight, and no real host resolves. Nine checks, in the
    script's header. It runs no suite in the browser and the corpus it ingests is six fixture
    cards; the engine's tests are `rust`'s. **A fixture is an input to this job**: a
    changed one is a changed first run, which is why `scripts/web-smoke/*` sets `web`. **Nothing in this bullet was
    measured on the job when it was first written** — its first run was the pull request that
    added it (#805, 2026-10-04): 4 min 59 s cold, green, and
    [ci-and-releases.md](../docs/reference/ci-and-releases.md) has what it built.
- **The `core` job is a compile gate for `grimoire-core` on the two targets a desktop build
  never touches** (2026-10-02): a matrix over `wasm32-unknown-unknown` and
  `aarch64-linux-android` on `ubuntu-24.04`, each leg `cargo build --lib -p grimoire-core
  --locked --target …` and then `cargo clippy` the same way with `-D warnings`. **It proves
  the crate compiles and lints clean for each triple, and nothing more** — no test runs, no
  APK or bundle is assembled, and nothing in it has been on a phone or in a browser. No
  `dist/` stub and no Node: the core has no `tauri-build`. `ci-ok` reads `needs.core.result`,
  so the matrix changes no protected name.
  **Nothing in this bullet was measured on this job when it was written** — its first run is
  the pull request that adds it. What it carries is the first attempt's `wasm` and `android`
  jobs, removed on 2026-09-27, where each of these was measured: **24.04 because
  `sqlite-wasm-rs`'s shim needs clang ≥ 18** (C23 `[[noreturn]]`; 22.04's
  `apt-get install clang` gives 14 and the failure reads `cc-rs: command did not execute
  successfully`), with the version printed and checked in the step; **the NDK's `bin` on
  `PATH` and `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` set by hand**, because cargo and
  `cc-rs` have never read `NDK_HOME`; and **a `rust-cache` `key` per target**, or one cache
  thrashes between the legs. The linker is the API-26 one, and since phase 4 the light host's
  `tauri.conf.json` names the same `minSdkVersion` (`mobile/host.test.ts` pins it).
- **The `rust` job runs a second, separate package's tests and only its tests.**
  `crates/card-scanner` is excluded from the workspace on purpose, so `cargo test --workspace`
  compiles it and runs none of it — `session::tests` (the `live.html` key census, the panic
  guard, the reader cadence) was fenced by `npm run verify` and by nothing in CI until
  2026-09-08. One step, Linux leg, `--features cli` to match `verify` — **and a second command
  in it since 2026-09-15, `--features builder --bins`**, because `cli` does not compile
  `build-hashes` or `eval` and a break in either was otherwise first seen by
  `scanner-bundle.yml`, the job that publishes what every release embeds. **A third since
  2026-09-30, `--features builder --lib synth`**, because `synth` is the one library module
  behind `builder` and neither earlier line compiled its tests. **No `fmt --check` and
  no `clippy -D warnings` for that package**: it is not rustfmt-clean and carries four
  pre-existing clippy warnings, both measured and listed in
  [card-scanner.md](../docs/reference/card-scanner.md) §8, so either gate would go red on day
  one for something the step is not about. **Every line names
  `--target-dir crates/card-scanner/target`** (2026-10-02): cargo reads its config from the
  working directory and never from `--manifest-path`, so run from the root these would follow
  `.cargo/config.toml` into `src-tauri/target`. `npm run verify` and `scanner-bundle.yml`
  pass the same flag; `crates/card-scanner/.cargo/config.toml` covers a run started inside it.
- `--locked` on every cargo call in every workflow. `cargo fmt --check` on Linux only;
  `clippy -D warnings` and `cargo test` on both — over the workspace's members and never
  `card-scanner`, per the bullet above.
  **`npm run verify` runs the same two as `lint:rust`** since 2026-09-27, after at least seven
  `style: cargo fmt` catch-up commits in eight weeks — CI ran both and `verify` ran neither.
- **The `rust` job also compiles the host as it ships, in two steps after clippy**
  (2026-10-02). `clippy --all-targets` and `cargo test` both build test targets, and
  `src-tauri` asks for `grimoire-core`'s `testing` feature under `[dev-dependencies]` — so in
  both, the core's test scaffolding is on for the app's ordinary library as well, and a
  non-test use of it would pass them and first fail in `tauri build` on a release tag.
  `cargo check -p mtg-grimoire -p grimoire-light --locked` is the build with no
  dev-dependencies in it, for the two hosts Tauri builds, and `npm run verify` runs the same
  line at the end of `lint:rust`. **The web host is not on it**: it ships as a WASM module, and
  the `web` job's `cargo build --lib` for `wasm32-unknown-unknown` is that build. The step
  after it fails when `cargo tree -p <host> -e features,normal,build -i grimoire-core` prints
  `feature "testing"` for **any host — `mtg-grimoire`, `grimoire-light` or `grimoire-web`**:
  one thing behind that feature is not scaffolding — the image fetcher accepts a loopback host
  under it — and the resolver sees every spelling a text sweep of the manifests cannot. It is
  asked for the runner's own target, which answers for the web host only while its dependency
  on the core is not under a `[target.…]` table; **a tree that does not name the core fails
  the step** rather than passing it, because that is the question not having been asked.
  **`release.yml` has neither step**; it builds what `main` holds, and `ci-ok` gates `main`.

## `release.yml`

- **It is one workflow on purpose.** A release created with `GITHUB_TOKEN` does not trigger
  `on: release` in another workflow — GitHub's recursion guard — so release-please, the build
  matrix and the publish step are jobs in one file, chained on `release_created`.
- **There is no update-signing job.** A `sign` job existed from 2026-09-28 to 2026-09-29; it
  needed an `UPDATE_SIGNING_KEY` secret nobody had set, stopped v0.34.0 as a draft, and was
  removed with the updater's minisign check. **The v0.34.0 draft must never be published** — its
  binaries still carry the check. [in-app-updates.md](../docs/reference/in-app-updates.md) has
  the record. If signing returns, the secret goes in a job of its own and never a build leg.
- **Versions are never typed by hand.** release-please reads the `feat:`/`fix:`/`!` prefixes and
  keeps a release PR open that bumps every version file: `package.json` and its lockfile, which
  the `node` release type owns, and each entry of `release-please-config.json`'s `extra-files`
  — a manifest and a `Cargo.lock` selector for every workspace member, and each Tauri host's
  `tauri.conf.json`. **That list is the count; this page does not keep one** (it said *five*
  long after the config had outgrown it). **A new workspace member owes two entries there** —
  `grimoire-web` got its pair on 2026-10-04 — or its first release ships that crate a version
  behind the app, and `--locked` does not notice: it sees a manifest that moved without its
  lockfile entry, never one that did not move at all. **What goes red is a test per host that
  has one**: `src-tauri`'s `the_core_wears_the_apps_version` holds the core to the app, and
  `grimoire-web`'s `the_host_wears_the_cores_version` holds the web host to the core. The
  Android host's manifest has no such test. `bump-minor-pre-major` is on,
  so while on `0.x` a `feat!:` bumps the **minor**; reaching 1.0 is a deliberate
  `Release-As: 1.0.0` footer.
- **The `Cargo.lock` selector must read `@.name.value`, never `@.name`** — release-please parses
  TOML into tagged nodes, so the obvious form matches nothing, and a non-match is a _warning_,
  not an error. `--locked` is what converts that silence into a failed check. **The file is
  the root `Cargo.lock` since 2026-10-02**, and `release-please-config.json`'s `path` moved
  with it. **With the right path it bumps both members' entries**: v0.40.0's release PR moved
  `grimoire-core` and `mtg-grimoire` together in the root lockfile, beside both manifests, and
  the release built `--locked`. What release-please does with a wrong path has not been
  measured; `--locked` on the release PR catches a lockfile it failed to bump either way.
- **Every build leg runs `npm run scanner:assets` straight after `npm ci`, and a missing asset
  fails the leg on purpose** (2026-09-15). It downloads the card scanner's hash bundle and both
  OCR models from the prerelease **`scanner-bundle-v<FORMAT_VERSION>`** — `scanner-bundle-v3`
  today — into `src-tauri/scanner-assets/`, where `build.rs` embeds them; a release that silently
  cannot scan is a regression nobody would see until a reader tried. **So `release.yml` depends
  on `scanner-bundle.yml` having published, and the first release after that workflow landed
  fails on every leg unless it has been dispatched once on `main`** — on 2026-09-15 the script
  exits 1 with a 404 sentence naming the missing asset and the workflow. The `GH_TOKEN` on the
  step is unused: the download is unauthenticated, because the repository is public.
- **The release is created as a draft** and published only after every platform's assets attach.
  **`force-tag-creation` pairs with that and is not optional**: a draft has no git tag until
  published, and without it release-please's next run replays the whole history into the
  changelog.
- **Tags are plain `v0.2.0`, and that needs `include-component-in-tag: false`.** Both `gh` steps
  read the action's `tag_name` **output** rather than a literal; anything hardcoding `v${version}`
  would not be safe.
- **release-please needs "Allow GitHub Actions to create and approve pull requests"** — with it
  off the run fails at the very last step, after doing all the work.
- **Every release PR opens in `action_required` and must be approved before CI runs.** The run
  shows **zero jobs**, which reads like a broken workflow and is not. A release is: PR opens →
  approve the run → `ci-ok` passes → merge.
- `--bundles` is pinned per platform. Artifacts: NSIS `-setup.exe`, `.msi`, a **portable `.zip`**,
  plus `.deb` and `.AppImage`. **GitHub rewrites spaces to dots on upload**, so match a release
  asset on the dotted form, never on the local bundle name.
- **Linux artifacts are built but unverified** — nobody has run a Linux build.
- Not done, deliberately: no code signing (SmartScreen warns on the installers), and **not**
  GitHub Packages — none of its registry types hosts a desktop installer. **That is Authenticode,
  and it is still not done.**

## `scanner-bundle.yml`

Added 2026-09-15 and **green on GitHub** — dispatched on `main` that day (38 min, which published
`scanner-bundle-v3`) and on its weekly schedule 2026-09-21 (28 min). The whole record:
[card-scanner.md](../docs/reference/card-scanner.md) §10.

- **It builds the card scanner's hash bundle from Scryfall's `default_cards`, weekly and on
  dispatch, and publishes it with both OCR models to the release `scanner-bundle-v<FORMAT_VERSION>`.**
  Weekly because `actions/cache` evicts an entry unused for seven days, and that cache is what
  makes a run a new set's few hundred image fetches rather than half an hour and ~1.28 GB.
- **The version in the tag is `grep -oP`'d out of `crates/card-scanner/src/index.rs`'s
  `pub const FORMAT_VERSION: u16 = N;`** and a non-match fails the step rather than publishing to
  `scanner-bundle-v`. `scripts/scanner-assets.mjs` reads the same line; change its shape and both
  must follow.
- **Both `cargo run` lines name `--target-dir crates/card-scanner/target`** (2026-10-02). They
  run from the root, where `.cargo/config.toml` would otherwise send the build to
  `src-tauri/target` — and the job's `rust-cache` saves `crates/card-scanner`, so without the
  flag a run would build somewhere the cache never looks and save nothing of it (derived from
  the two config lines, not measured on a run).
- **Scryfall's descriptor has no `download_uri`** — only `jsonl_download_uri`, a gzipped JSON Lines
  file (checked live 2026-09-15). `jq -er` refuses a missing field instead of handing `curl` the
  word `null`, and the job's default shell is `bash` so `pipefail` makes a failed `curl` in a pipe
  a failed step.
- **Only `main` publishes.** `workflow_dispatch` runs from any ref and the tag names the format
  version, not the code, so a branch that changed the hashing without bumping the version would
  `--clobber` the bundle every release embeds. Elsewhere the job builds, caches and writes a dry-run
  line to the summary; the ref reaches the script through `env:`, never as an expression.
- **"Unchanged" is `cmp -s -i 32`, never a whole-file compare** — `built_at` sits in the 32-byte
  header and differs on every run. A release missing any of the three assets is republished
  regardless.
- **Two fences keep a shrunken bundle off the release** (2026-09-15), because every release embeds
  what this uploads. `build-hashes` exits 1 and writes no bundle when more than **0.5%** of the
  fetches it attempted failed transiently (`too_many_transient`, unit-tested); and the publish step
  counts entries as `(size − 32) / 48` for the built and the published bundle and **fails the step
  without uploading** when the new count is below **99%** of the old, saying both counts in the
  summary. The second catches what the first cannot see — a short `default_cards`, a bad cache.
  A deliberate shrink (a format change moves the tag, so it never meets this) has no override.
- **The synthetic evaluation is `continue-on-error` and must stay so**: it reports and does not
  gate, and a failure writes its own line to the summary. The condition on that line reads
  `steps.eval.outcome`, because under `continue-on-error` a failed step's `conclusion` is `success`.
- **Prerelease and `--latest=false`**, so nothing asking GitHub for the latest release — the in-app
  updater among them — is handed a bundle.
- **`release.yml` depends on it having published** (see that section) — which it has since the
  2026-09-15 dispatch. A new `FORMAT_VERSION` moves the tag, so the same holds again for the first
  release after a bump: dispatch it once on `main` first.

## `android-emulator.yml`

Added 2026-10-03 (phase 4, step 4.5) and **never run when this was written** — its first run is
the pull request that adds it. The record is
[light-app.md](../docs/reference/light-app.md) §8.5.

- **It runs the light app's APK on an emulator and times the first run, and it gates nothing**:
  not in `ci.yml`, not read by `ci-ok`, not protected. `workflow_dispatch`, and a pull request to
  or a push to `main` touching `mobile/src-tauri/**`, `crates/grimoire-core/**`, `Cargo.lock`, itself or
  `scripts/android-first-run.sh`. The build is the `android` job's with **`--target x86_64`**
  (an x86_64 emulator under KVM cannot run arm64 code) — JDK 21 from `JAVA_HOME_21_X64`,
  `NDK_HOME` from the image, the composite toolchain action, `rust-cache` keyed
  `android-x86_64` — then KVM's udev rule and `reactivecircus/android-emulator-runner` (API 34,
  `google_apis`, x86_64, 4096M RAM, `disk-size: 6000M`). **The action runs each `script:` line
  as its own shell**, so the measuring is one line calling `scripts/android-first-run.sh`, never a
  block in the YAML. It writes the APK and `.so` sizes, the first launch's `TotalTime`, the first
  corpus ingest (the host's `launch: card sync finished in N ms`, read from logcat's
  `RustStdoutStderr` tag), both databases' size through `adb root` — a release build is not
  debuggable, so `run-as` refuses it — a screenshot, and three cold starts to the summary and to
  an artifact uploaded `if: always()`, and then leaves the app twice — back from the start page,
  and the activity destroyed on purpose. **It fails when there is no ingest figure, or when leaving
  logs a `FORTIFY`, `destroyed mutex` or `Fatal signal` line for the app's process**, and a launch
  whose sync never started within 60 s is reported as *held — the emulator reported a metered
  network* rather than passed. Routed to `frontend` beside `release.yml`, for the two tests that
  read every workflow — **not `android`**: it builds its own APK and is proved by its own run.
