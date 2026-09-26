# .github — CI and releases

Three workflows — `ci.yml`, `release.yml` and, since 2026-09-15, `scanner-bundle.yml` — and every
rule below was measured live unless it says otherwise. Full detail, including the proof runs:
[docs/reference/ci-and-releases.md](../docs/reference/ci-and-releases.md); the scanner bundle's
record is [card-scanner.md](../docs/reference/card-scanner.md) §10.

## `ci.yml`

- **`ci-ok` is the one protected check.** Branch protection pins names by string and a matrix
  job's name embeds its matrix values, so the aggregator is what has teeth and the matrix
  underneath stays free. `enforce_admins` is **false**: a red PR cannot merge, a direct push to
  `main` still can.
- **A change only builds what it can have broken.** The `changes` job diffs against the base and
  hands the paths to **`scripts/ci-route.mjs`**, whose arms are `case` semantics kept exactly —
  first match wins, `*` crosses `/`. `src-tauri/**` → **all four build jobs**, `frontend`
  included, because frontend tests read its files as text (`ipc.test.ts`'s mirror rows, the
  share golden); `src/features/transfer/__golden__/**` and `src/lib/userTables.json` →
  `frontend` **and `rust`**, because Rust tests read them; **`crates/*` → all four** (the
  `card-scanner` package is compiled by `rust` and `android`, and `frontend` reads eight of its
  `.rs` files as text for `ipc.test.ts` and lints its `scripts/*.mjs`); frontend sources,
  lockfiles, configs and **`scripts/` because `eslint .` lints it** → `frontend`;
  `src/workers/`, `src/web/`, `src/lib/core/`, `scripts/build-wasm.mjs` and
  `vite.web.config.ts` → `frontend` and `wasm`; `*.ps1`/`*.psm1`/`*.psd1` → `powershell`;
  `ci.yml` and the router itself → every job, `powershell` included; prose and editor
  bookkeeping → neither; and **anything unrecognised → every build job**. That last arm is the
  fail-safe that makes the lists safe to be wrong in the cheap direction — and it is
  load-bearing for `share-worker/`, whose `wrangler.jsonc` a Rust test reads. **Only the
  "neither" arm can wrongly skip work, so it stays small.**
  **`scanner-bundle.yml` has no arm of its own (2026-09-15)**, so a PR touching it falls to that
  fail-safe and runs `frontend`, `rust`, `wasm` and `android` — none of which reads the file —
  and not `powershell`. That errs in the cheap direction; the arm it belongs on is
  `release.yml`'s "neither", since no job in `ci.yml` reads either file.
  - **The two halves read each other's files, and `scripts/ci-route.test.mjs` is the fence.**
    Until 2026-09-26 the router said they shared no inputs, so a Rust-only PR that drifted from
    `ipc.ts` merged green and the red landed on the next unrelated PR. The test derives the
    census on every run — every `?raw` a collected test imports, every
    `include_str!`/`include_bytes!`/`CARGO_MANIFEST_DIR` read in either cargo package — and fails
    when a file is read by one job and not routed to it, or crosses and is not routed to both.
    It also holds `ci.yml` to exposing and gating on the names `JOBS` prints, since a name the
    workflow reads and the script never prints skips its job and `ci-ok` counts that as a pass;
    the step itself fails on a missing or non-boolean output line.
  - **A push to `main` gets a concurrency group of its own**; PR runs still cancel each other.
    A `main` run's routing diffs from `github.event.before`, so a cancelled one's changes were
    never routed again — and disabling `cancel-in-progress` alone would not save them, because
    GitHub still replaces a *pending* run in the same group with the next.
- **The `wasm` job exists because a fully green `npm run verify` can ship a broken web
  target.** The crate is one crate with two targets, and a `use tauri::` added to a module on
  the wasm side of `lib.rs`'s module map compiles on desktop and fails on
  `wasm32-unknown-unknown` — the same shape as `cargo fmt` and `clippy` already being outside
  `verify`. It is Linux-only (this compiles SQLite's C amalgamation with clang, which is the
  same compiler everywhere), installs a `wasm-bindgen-cli` **pinned to the crate's exact
  version**, and needs no `dist/` stub because `build.rs` returns before `tauri_build` runs for
  a wasm `TARGET`. Its `npm run build:wasm` step also greps the generated glue for every
  exported entry point, which is the one check no compiler can make: dropping a
  `#[wasm_bindgen]` attribute builds clean with no error and no warning.
- **The `android` job exists for the `wasm` job's reason, one target over: `main` can stop
  cross-compiling for Android and nothing goes red.** It already did — #270 fixed exactly that,
  and an APK somebody built by hand was how anybody found out. It is
  `cargo build --lib --locked --target aarch64-linux-android` and **not an APK build**: assembling
  one needs Gradle, a full SDK and a signing story, while the cross-compile needs only the NDK and
  catches the whole class of failure this is for. It proves nothing about the app *running* on a
  phone; that is still a hardware pass. Linux, for the `wasm` job's reason — the NDK is the
  compiler on every host and the runner image ships one.
  - **`cargo` and `cc-rs` have never heard of `NDK_HOME`.** That variable is the Tauri CLI's, and
    this job does not go through the CLI, so it sets two things by hand and **each failure names
    something other than its cause**: clang on `PATH` (or `cc-rs` reports `failed to find tool
    "clang"` while compiling `libsqlite3-sys` and `ring`) and an explicit linker (or `rustc`
    reports ``linker `cc` not found``). The job checks both paths exist and says so plainly.
  - **API 26 is `minSdk` in `gen/android/app/build.gradle.kts`, not a choice made in CI**, so the
    linker binary is the `26` one. A Rust test already pins that number.
  - **It needs the `dist/` stub and the `wasm` job does not.** `build.rs` returns early for a wasm
    `TARGET`, so `tauri_build` never runs there; for the Android triple it does, and
    `frontendDist: "../dist"` has to exist.
  - **`src-tauri/gen/android/*` still routes nowhere**, which is correct: the cross-compile reads
    no Gradle file. `build.gradle.kts` and `AndroidManifest.xml` keep routing to `rust` alone,
    because they are `include_str!` test inputs rather than build inputs.
- **The `powershell` job runs the repo's `.ps1` tests on `windows-latest`** — `lock.test.ps1`
  for the worktree locks and `pr-auto.test.ps1` for the auto-PR guard — and its arm in
  `ci-route.mjs` must stay **above** `src-tauri/*` and `scripts/*` — first-match-wins, and
  `scripts/` is on the frontend list because `eslint .` lints it, which a `.ps1` is not. It
  matches `.psm1` and `.psd1` too, because **the fail-safe does not set `powershell`**: a module
  would otherwise fall through it and skip the only job that tests the change. Windows is not a
  preference — `lock.ps1` identifies a holder by pid + name + `StartTime`.
- **A new job gated on a `changes` output belongs in every list of jobs, not one:**
  `ci-route.mjs`'s `JOBS`, the classify step's output-name check, `changes.outputs`, `ci-ok`'s
  `needs` **and** its success-or-skipped loop. In `needs` alone, its failure is a result the gate
  never reads.
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
- **The `rust` job runs a second, separate package's tests and only its tests.**
  `crates/card-scanner` is deliberately not a workspace member, so `cargo test` in `src-tauri`
  compiles it and runs none of it — `session::tests` (the `live.html` key census, the panic
  guard, the reader cadence) was fenced by `npm run verify` and by nothing in CI until
  2026-09-08. One step, Linux leg, `--features cli` to match `verify` — **and a second command
  in it since 2026-09-15, `--features builder --bins`**, because `cli` does not compile
  `build-hashes` or `eval` and a break in either was otherwise first seen by
  `scanner-bundle.yml`, the job that publishes what every release embeds. **No `fmt --check` and
  no `clippy -D warnings` for that package**: it is not rustfmt-clean and carries four
  pre-existing clippy warnings, both measured and listed in
  [card-scanner.md](../docs/reference/card-scanner.md) §8, so either gate would go red on day
  one for something the step is not about.
- `--locked` on every cargo call in every workflow. `cargo fmt --check` on Linux only;
  `clippy -D warnings` and `cargo test` on both — for `src-tauri` only, per the bullet above.

## `release.yml`

- **It is one workflow on purpose.** A release created with `GITHUB_TOKEN` does not trigger
  `on: release` in another workflow — GitHub's recursion guard — so release-please, the build
  matrix and the publish step are three jobs in one file, chained on `release_created`.
- **Versions are never typed by hand.** release-please reads the `feat:`/`fix:`/`!` prefixes and
  keeps a release PR open that bumps all five version files. `bump-minor-pre-major` is on, so
  while on `0.x` a `feat!:` bumps the **minor**; reaching 1.0 is a deliberate `Release-As: 1.0.0`
  footer.
- **The `Cargo.lock` selector must read `@.name.value`, never `@.name`** — release-please parses
  TOML into tagged nodes, so the obvious form matches nothing, and a non-match is a _warning_,
  not an error. `--locked` is what converts that silence into a failed check.
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
  GitHub Packages — none of its registry types hosts a desktop installer.

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
