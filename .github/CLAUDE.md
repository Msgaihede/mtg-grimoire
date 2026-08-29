# .github — CI and releases

Two workflows, and every rule below was measured live. Full detail, including the proof runs:
[docs/reference/ci-and-releases.md](../docs/reference/ci-and-releases.md).

## `ci.yml`

- **`ci-ok` is the one protected check.** Branch protection pins names by string and a matrix
  job's name embeds its matrix values, so the aggregator is what has teeth and the matrix
  underneath stays free. `enforce_admins` is **false**: a red PR cannot merge, a direct push to
  `main` still can.
- **A change only builds the half it touched.** The `changes` job diffs against the base and
  routes each path: `src-tauri/**` → `rust` **and `wasm`**; frontend sources, lockfiles,
  configs and **`scripts/` because `eslint .` lints it** → `frontend`; `src/workers/`,
  `src/web/`, `src/lib/core/`, `scripts/build-wasm.mjs` and `vite.web.config.ts` → `frontend`
  and `wasm`; `*.ps1`/`*.psm1`/`*.psd1` → `powershell`; `ci.yml` itself → all four; prose and
  editor bookkeeping → neither; and **anything unrecognised → every build job**. That last arm
  is the
  fail-safe that makes the lists safe to be wrong in the cheap direction. **Only the "neither"
  arm can wrongly skip work, so it stays small.**
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
  for the worktree locks and `pr-auto.test.ps1` for the auto-PR guard — and its `case` arm must
  stay **above** `src-tauri/*` and `scripts/*` — first-match-wins, and `scripts/` is on the
  frontend list only because `eslint .` lints it, which a `.ps1` is not. It matches `.psm1`
  and `.psd1` too, because **the `*)` fail-safe does not set `powershell`**: a module would
  otherwise fall through it and skip the only job that tests the change. Windows is not a
  preference — `lock.ps1` identifies a holder by pid + name + `StartTime`.
- **A new job gated on a `changes` output belongs in two places, not one:** `ci-ok`'s `needs`
  **and** its success-or-skipped loop. In `needs` alone, its failure is a result the gate never
  reads.
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
- `--locked` on every cargo call in both workflows. `cargo fmt --check` on Linux only;
  `clippy -D warnings` and `cargo test` on both.

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
