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
  - `scripts/android-sign.sh` routes to `frontend`, `rust`, and `android` (must sit above `scripts/*`); `.release-please-manifest.json` routes to `frontend`.
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
    and `cargo test --workspace`. Also runs `crates/card-scanner` test suites (`--features cli`, `--features builder --bins`, and its frame bench's, `crates/card-scanner/bench`).
    Compiles shipping binaries without dev-dependencies (`cargo check -p mtg-grimoire -p grimoire-light`) and verifies no host enables the core's `testing` feature.
    `Swatinem/rust-cache` is configured with `workspaces: ". -> src-tauri/target"` to align with `.cargo/config.toml`.
  - **`core`**: Target compile gate on `ubuntu-24.04` (requires clang ≥ 18 for `sqlite-wasm-rs`) for `wasm32-unknown-unknown` and `aarch64-linux-android`.
    Sets `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` and the NDK `bin` path explicitly because cargo does not read `NDK_HOME`.
    Each leg also `cargo check`s `crates/card-scanner/bench` — the scanner with its readers — for its target; nothing in this job runs.
  - **`android`**: Builds the light app APK on `ubuntu-24.04` via `npx tauri android build --apk --target aarch64` with JDK 21 (debug-signed, no secret),
    then proves the release's signing by running `scripts/android-sign.sh` over it with a throwaway key minted and deleted in the step.
  - **`web`**: Builds the WebAssembly host:
    - Reads the exact `wasm-bindgen` CLI version from `Cargo.lock` and compiles via `cargo install wasm-bindgen-cli --version "$bindgen" --locked`.
    - Builds the module (`npm run web:wasm`) and web assets (`npm run web:build`).
    - Executes headless Chrome smoke tests (`npm run web:smoke`) against fixture cards, enforcing offline operation and CORS safety.
    - Runs the live-sync walk (`npm run web:sync-smoke`: two Chrome profiles, `relay/` under `wrangler dev --local`), with wrangler installed from `app-worker/package-lock.json` (`npm ci --ignore-scripts --prefix app-worker`) — never `npx wrangler@…`, and no secret in the job. `relay/**` routes to `frontend`, `rust` and `web`.
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

- **Single chained workflow**: Release creation, the three hosts' builds, and publishing run in one file conditioned on `release_created`.
- **The release rule — the three hosts ship from one tag**: one core means one user schema per commit, sync stamps every op with the sender's,
  and an older build holds a newer op until it updates. A host that ships ahead strands the others, so:
  - `build` (desktop matrix), `android` (the APK, as `ci.yml` builds it) and `web` (`web:wasm`, `web:build`, `web:smoke`) all build at the tag and hold no secret.
  - `android-sign` re-signs the APK with the release key (`scripts/android-sign.sh`) and attaches `mtg-grimoire-<version>-android-arm64.apk`.
    The key is held to the committed fingerprint `mobile/src-tauri/release-signer.sha256`: no file, no APK; another key or a debug certificate is refused.
  - `web-deploy` installs `wrangler` from `app-worker/package-lock.json` (`npm ci --ignore-scripts`, no secret in that step), runs `npx --no-install wrangler deploy`,
    then `scripts/web-deploy-probe.mjs` against the origin. It needs `build`, `android-sign` and `web` — a deploy is live at once, so it goes last — and refuses a tag older than the newest published release.
  - `publish` needs `build`, `android-sign` and `web-deploy`; any failure leaves the release a draft.
- **Secrets live in jobs that build nothing, and in the `release` environment**: `android-sign` and `web-deploy` run no root `npm ci`, cargo or Gradle, and are the only jobs with `environment: release`
  (a repository secret is readable from any branch's workflow; an environment's only from `main`, once the owner restricts it). `on:` is a push to `main` only.
  Each first asks whether its values are set, handed `true`/`false` and never the value: none → attach/deploy nothing, say so in the summary, end green; some but not all → fail. A debug-signed APK is never attached.
- **One job deploys one Worker**: `web-deploy` is the only `wrangler` in any workflow. The relay and the share Worker are deployed by no job. Merging the release PR is therefore a deploy.
- **Fence**: `scripts/release-rule.test.mjs` holds the job graph, the trigger, every spelling of `secrets` and which job may read which, the exact list of commands a secret-holding job may run,
  the environment, the single `wrangler` line and its lockfile, one version across every manifest and `release-please-config.json`, and an Android `versionCode` that rises with the version.
  A new step in `android-sign` or `web-deploy` that runs anything must be added to that list.
- **Between releases**: `npm run web:deploy-guard` refuses a by-hand web deploy from a tree whose `USER_SCHEMA_VERSION` differs from the last tag's, or whose last release is still a draft.
  Equal schemas are necessary, not sufficient: a wire change with no schema rung is dropped by an older build, and the guard cannot see it.
- **Release-please automation**:
  - Versions are automated via Conventional Commits; never bump versions manually.
  - `release-please-config.json` tracks `package.json`, `Cargo.lock` (`@.name.value`), workspace member manifests, and `tauri.conf.json` files.
  - The `Cargo.lock` selector must read `@.name.value`, never `@.name`, to prevent silent non-matches in release-please.
  - Host tests (`the_core_wears_the_apps_version`, `the_host_wears_the_cores_version`) and `scripts/release-rule.test.mjs` (all four crates, both `tauri.conf.json`s) verify version alignment.
  - With `bump-minor-pre-major` enabled, breaking changes on `0.x` bump the minor version; releasing 1.0.0 requires a `Release-As: 1.0.0` commit footer.
- **Assets & artifacts**:
  - Each build leg downloads the scanner hash bundle via `npm run scanner:assets` (published by `scanner-bundle.yml`).
  - Artifacts built: NSIS installer (`-setup.exe`), MSI (`.msi`), portable archive (`.zip`), `.deb`, `.AppImage`, and — once the signing secrets exist — the Android `.apk`.
  - GitHub rewrites spaces to dots on release asset upload; match assets using the dotted filename convention.
  - Draft releases are created first, with tags applied only upon successful publish (`force-tag-creation: true`).
  - Release pull requests open with `action_required` and must be manually approved before CI jobs run.

## `scanner-bundle.yml` & `android-emulator.yml`

- **`scanner-bundle.yml`**:
  - Weekly and manual dispatch workflow building the scanner hash bundle from Scryfall's bulk cards (`default_cards`).
  - Publishes OCR models and hashes to prerelease `scanner-bundle-v<FORMAT_VERSION>`.
  - Fenced by strict fetch failure thresholds (< 0.5% transient errors) and size checks (≥ 99% of previous bundle size).
  - Evaluates models with `continue-on-error: true` so performance summaries are posted without blocking publishing.
  - **Refuses to go on unless both OCR models' SHA-256 are the ones the app pins** (`DETECTION_SHA256`, `RECOGNITION_SHA256` in `crates/grimoire-core/src/scanner_assets.rs`, read out of that source by the step): an installed app that fetches its scanner files refuses any other model, so one must never be published. Changing a model means changing those two constants and the two lengths in the same commit.
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
