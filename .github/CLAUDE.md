# .github — CI and releases

Four workflows manage CI and distribution: `ci.yml`, `release.yml`, `scanner-bundle.yml`, and
`android-emulator.yml`. Every rule below is enforced by tests or measured in production.
Full historical records and measurements: [`docs/reference/ci-and-releases.md`](../docs/reference/ci-and-releases.md);
scanner bundle details in [`docs/reference/card-scanner.md`](../docs/reference/card-scanner.md) §10.

## `ci.yml` — Pull Request & Main Branch Gates

- **`ci-ok` is the single protected check**:
  - Branch protection pins `ci-ok` as the required status check.
  - Acts as an aggregator requiring success or deliberate skip across all job dependencies:
    `changes`, `frontend`, `rust`, `core`, `powershell`, `storybook`, `android`, and `web`.
  - `enforce_admins` is `false`: a red PR cannot merge, but direct administrative pushes to `main` remain possible.
- **CLAUDE.md line budget check**: The `changes` job runs `node scripts/check-claude-md.mjs` before classification, failing CI immediately if any `CLAUDE.md` in the repository grows beyond 200 lines.
- **Path routing (`changes` job)**:
  - Uses `git diff --name-only --no-renames` (`fetch-depth: 0`) and pipes changed paths to `scripts/ci-route.mjs`.
  - Evaluated using strict `case` semantics: **first match wins**, and `*` crosses `/`.
  - `src-tauri/**` routes to `frontend` and `rust` (frontend tests inspect Rust files as text).
  - `crates/grimoire-core/**` routes to `frontend`, `rust`, and `core` (must stay above `crates/*`).
  - `crates/*` routes to `frontend`, `rust`, and `core` (covers `crates/card-scanner`).
  - `crates/grimoire-web/**` routes to `frontend`, `rust`, and `web`.
  - `mobile/**` routes to `frontend` and `storybook`; `vite.mobile.config.ts` routes to `frontend`, `rust`, `android`, and `web`.
  - `app-worker/**` routes to `frontend` and `web`.
  - `*.ps1`/`*.psm1`/`*.psd1` routes to `powershell` (must sit above `src-tauri/*` and `scripts/*`).
  - Unrecognised paths fall through to a fail-safe that runs all build jobs (`frontend`, `rust`, `core`, `storybook`, `web`).
  - **Fence test**: `scripts/ci-route.test.mjs` verifies that every file read across jobs is properly routed.
- **Three routing traps to prevent**:
  1. Never use workflow-level `paths:` filters; they skip the entire workflow and leave required status checks pending indefinitely.
  2. Always pass `--no-renames` to git diff; default rename detection only reports destination paths, which would wrongly skip jobs when files move.
  3. `ci-ok` must explicitly assert `needs.changes.result == 'success'`. Because skipped build jobs count as passes, a crashed router would otherwise pass `ci-ok` having run nothing.
- **Adding a new CI job**:
  - A new job gated on changes must be added to five places: `ci-route.mjs`'s `JOBS`, the classify step's output check,
    `changes.outputs`, `ci-ok`'s `needs` array, and `ci-ok`'s success-or-skipped evaluation loop.
- **Concurrency control**:
  - Pull request runs cancel in-progress runs when new commits arrive (`cancel-in-progress: true`).
  - Pushes to `main` use dedicated concurrency groups so history is never cancelled mid-route.
- **Job specifics**:
  - **`frontend`**: Matrix of 5 legs: 1 leg for `npm run build` and `npm run lint`; 4 parallel shards for `npm run test:run -- --shard=N/4`.
  - **`storybook`**: Runs `npm run build-storybook`. Gates `.storybook/DesignSystem.mdx` and `preview.css`.
  - **`rust`**: Windows and Linux matrix. Writes a stub `dist/index.html` so `tauri-build` compiles on fresh checkouts.
    Runs `cargo fmt --check` (Linux only, with `-p` for each workspace member; never `--all`), `clippy --workspace --all-targets -D warnings`,
    and `cargo test --workspace`. Also runs `crates/card-scanner` test suites (`--features cli` and `--features builder --bins`).
    Compiles shipping binaries without dev-dependencies (`cargo check -p mtg-grimoire -p grimoire-light`) and verifies no host enables the core's `testing` feature.
    `Swatinem/rust-cache` is configured with `workspaces: ". -> src-tauri/target"` to align with `.cargo/config.toml`.
  - **`core`**: Target compile gate on `ubuntu-24.04` (requires clang ≥ 18 for `sqlite-wasm-rs`) for `wasm32-unknown-unknown` and `aarch64-linux-android`.
    Sets `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` and the NDK `bin` path explicitly because cargo does not read `NDK_HOME`.
  - **`android`**: Builds the light app APK on `ubuntu-24.04` via `npx tauri android build --apk --target aarch64` with JDK 21.
  - **`web`**: Builds the WebAssembly host:
    - Reads the exact `wasm-bindgen` CLI version from `Cargo.lock` and compiles via `cargo install wasm-bindgen-cli --version "$bindgen" --locked`.
    - Builds the module (`npm run web:wasm`) and web assets (`npm run web:build`).
    - Executes headless Chrome smoke tests (`npm run web:smoke`) against fixture cards, enforcing offline operation and CORS safety.
  - **`powershell`**: Runs `lock.test.ps1` for worktree locks on `windows-latest`. Windows is required because holder PID, process name, and `StartTime` are inspected.

## Toolchain & Action Security

- **Pinned toolchains**:
  - Rust is pinned via `rust-toolchain.toml` and installed via `./.github/actions/rust-toolchain`. Moving the pin requires a deliberate commit.
  - Node is pinned via `.nvmrc` across all `actions/setup-node` invocations (`node-version-file: .nvmrc`).
  - **Fence**: `scripts/toolchain.test.mjs` fails if any workflow uses an unpinned toolchain or direct action.
- **SHA-pinned actions**:
  - All third-party GitHub actions must use full 40-character commit SHAs with trailing version tags (`@<sha> # vX.Y.Z`).
  - Dependabot updates action SHAs weekly via grouped pull requests over `/` and `/.github/actions/*`.
  - `persist-credentials: false` is required on all checkouts to prevent leaking tokens.
  - Workflows must declare `permissions: {}` top-level and grant minimal required permissions per job.
  - **Fence**: `scripts/actions-pinned.test.mjs` enforces action SHA pinning and permissions.
- **Scripts a workflow runs must exist**: `scripts/workflow-scripts.test.mjs` fails if a workflow, composite action, or npm script calls an `npm run <name>` that `package.json` lacks.

## `release.yml` — Automated Releases

- **Single chained workflow**: Release creation, cross-platform builds, and publishing run in one file conditioned on `release_created`.
- **Release-please automation**:
  - Versions are automated via Conventional Commits; never bump versions manually.
  - `release-please-config.json` tracks `package.json`, `Cargo.lock` (`@.name.value`), workspace member manifests, and `tauri.conf.json` files.
  - The `Cargo.lock` selector must read `@.name.value`, never `@.name`, to prevent silent non-matches in release-please.
  - Host tests (`the_core_wears_the_apps_version`, `the_host_wears_the_cores_version`) verify version alignment.
  - With `bump-minor-pre-major` enabled, breaking changes on `0.x` bump the minor version; releasing 1.0.0 requires a `Release-As: 1.0.0` commit footer.
- **Assets & artifacts**:
  - Each build leg downloads the scanner hash bundle via `npm run scanner:assets` (published by `scanner-bundle.yml`).
  - Artifacts built: NSIS installer (`-setup.exe`), MSI (`.msi`), portable archive (`.zip`), `.deb`, and `.AppImage`.
  - GitHub rewrites spaces to dots on release asset upload; match assets using the dotted filename convention.
  - Draft releases are created first, with tags applied only upon successful publish (`force-tag-creation: true`).
  - Release pull requests open with `action_required` and must be manually approved before CI jobs run.

## `scanner-bundle.yml` & `android-emulator.yml`

- **`scanner-bundle.yml`**:
  - Weekly and manual dispatch workflow building the scanner hash bundle from Scryfall's bulk cards (`default_cards`).
  - Publishes OCR models and hashes to prerelease `scanner-bundle-v<FORMAT_VERSION>`.
  - Fenced by strict fetch failure thresholds (< 0.5% transient errors) and size checks (≥ 99% of previous bundle size).
  - Evaluates models with `continue-on-error: true` so performance summaries are posted without blocking publishing.
- **`android-emulator.yml`**:
  - Non-gating performance diagnostic workflow. Builds and boots the Android APK on an x86_64 emulator under KVM.
  - Times cold launch, measures first-run corpus sync, checks for process crashes (`destroyed mutex`, `Fatal signal`), and captures screenshots.
  - Triggered via `workflow_dispatch` or changes to Android host files, `crates/grimoire-core/**`, or `scripts/android-first-run.sh`.

## Reference & Troubleshooting

For exhaustive live measurements, proof runs, and the historical evolution of every CI gate and release artifact:
- [`docs/reference/ci-and-releases.md`](../docs/reference/ci-and-releases.md) — Comprehensive record of pipeline measurements, routing test design, and release validations.
- [`docs/reference/card-scanner.md`](../docs/reference/card-scanner.md) §10 — The scanner bundle workflow, asset publishing, and regression evaluation harness.
- [`docs/reference/light-app.md`](../docs/reference/light-app.md) §8–§9 — Android build specifics, emulator first-run findings, and WebAssembly web host smoke test runs.
- [`app-worker/README.md`](../app-worker/README.md) — Web application hosting Worker runbook, CSP headers verification, and deployment records.
