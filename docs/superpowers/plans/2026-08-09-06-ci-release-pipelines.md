# CI & Release Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate every pull request with the project's full check suite, and turn a merged
version bump into a published GitHub Release carrying compiled Windows and Linux artifacts.

**Architecture:** Two workflows. `ci.yml` runs the checks on PRs and pushes to `main`,
funnelling a matrix through one fixed-name aggregator job that branch protection can pin.
`release.yml` runs release-please and the Tauri build in a *single* workflow, because a
release created with `GITHUB_TOKEN` cannot trigger a second workflow.

**Tech Stack:** GitHub Actions · `googleapis/release-please-action@v4` ·
`tauri-apps/tauri-action@v1` · `Swatinem/rust-cache@v2` · `dtolnay/rust-toolchain@stable`

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-09-ci-release-pipelines-design.md`. Read it first.
- Repo `Msgaihede/mtg-grimoire`, default branch `main`, currently at version `0.1.0`.
- Runners: `windows-latest` and `ubuntu-22.04`. 22.04 for AppImage glibc compatibility.
- Node `22` (Vite 7 requires `^20.19 || >=22.12`).
- Commit messages use the project's existing `feat:`/`fix:`/`chore:`/`test:` convention —
  release-please derives every version from them, so a wrong prefix is a wrong version.
- `bundle.targets` in `tauri.conf.json` stays `"all"`; the *workflow* pins `--bundles`
  per platform. Do not edit `tauri.conf.json` to change targets.
- Version lives in five tracked files and they must never drift:
  `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`.
- `--locked` is passed to every cargo invocation in both workflows. It is the mechanism
  that turns a missed `Cargo.lock` bump into a loud failure instead of a silent one.
- Never commit anything under `src-tauri/target/`, `dist/`, or `data/`.

## Verified facts this plan depends on

These were checked against upstream sources on 2026-08-09. Do not "correct" them from
memory.

- `tauri-apps/tauri-action` current major is **`@v1`** (`action-v1.0.0`, 2026-06-29).
  `@v0` is stale. In v1 the updater input is **`uploadUpdaterJson`** — `includeUpdaterJson`
  was renamed and no longer exists.
- `release-please-action@v4` emits `release_created`, `tag_name`, `version` and — although
  undocumented in its README — the numeric **`id`** of the created release, which is what
  `tauri-action`'s `releaseId` needs. Task 3 adds a guard that fails the build loudly if
  `id` ever comes back empty, rather than letting tauri-action create a second release.
- **RPM does not need `rpmbuild`.** Tauri builds it in-process with the pure-Rust `rpm`
  crate. The spec's stated reason for pinning `--bundles` was wrong; the real reason is
  that shipping an unwanted RPM is a choice, not an accident. AppImage *is* the bundle with
  external needs — it downloads `linuxdeploy` and wants `patchelf`, `xdg-utils`, `libfuse2`.
- **`productName` does not rename the executable in Tauri v2** (it did in v1). With no
  `mainBinaryName` set, the raw binary is `src-tauri/target/release/mtg-collection-tracker.exe`
  — lowercase, hyphenated, from the Cargo package name.
- Bundle filenames *do* use `productName` verbatim, spaces included, e.g.
  `MTG Collection Tracker_0.2.0_x64-setup.exe`.
- `tauri build` forwards arguments after a `--` to cargo, so
  `args: --bundles nsis,msi -- --locked` reaches `cargo build --locked`.
- `tauri-action` does **not** install frontend dependencies. The workflow must run
  `npm ci` itself. It *does* run `beforeBuildCommand` (`npm run build`), so the workflow
  must not run that separately.
- A draft release has **no git tag** until published, which breaks release-please's next
  changelog. `"force-tag-creation": true` is the documented fix and is required here.
- `extra-files` paths are relative to the package path, and the package is `.`, so paths
  are repo-root-relative as written.

---

## Task 1: The CI gate

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a check named exactly **`ci-ok`**. Task 4 pins that string in branch
  protection. Do not rename it.

- [ ] **Step 1: Confirm the checks pass locally before asking CI to run them**

The gate adds `--locked` to cargo, which nothing local has exercised. Prove it now, so a
red CI run in Step 5 means "the workflow is wrong", not "the tree was already broken".

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
```

Expected: all three succeed. If `--locked` complains that `Cargo.lock` needs updating, run
`cargo check` in `src-tauri`, commit the lockfile as `chore: refresh Cargo.lock`, and
re-run.

- [ ] **Step 2: Create the branch**

```bash
git checkout -b ci/pipelines
```

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  frontend:
    name: frontend
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Build
        run: npm run build

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm run test:run

  rust:
    name: rust (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-22.04]
    steps:
      - uses: actions/checkout@v4

      - name: Install Linux system dependencies
        if: matrix.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            build-essential \
            curl \
            wget \
            file \
            libxdo-dev \
            libssl-dev \
            libayatana-appindicator3-dev \
            librsvg2-dev

      # tauri-build reads `frontendDist: "../dist"` and fails outright when the directory
      # is absent, so a Rust-only job cannot compile a fresh checkout. A stub keeps this
      # job parallel with `frontend` instead of serialized behind a full Vite build;
      # nothing under test reads it.
      - name: Stub the frontend bundle
        shell: bash
        run: |
          mkdir -p dist
          echo '<!doctype html><title>ci stub</title>' > dist/index.html

      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      # Formatting has no platform split, so it runs once. Lints do: the source has
      # cfg-gated Windows paths that a Linux-only clippy pass never compiles.
      - name: cargo fmt
        if: matrix.os == 'ubuntu-22.04'
        working-directory: src-tauri
        run: cargo fmt --check

      - name: cargo clippy
        working-directory: src-tauri
        run: cargo clippy --all-targets --locked -- -D warnings

      - name: cargo test
        working-directory: src-tauri
        run: cargo test --locked

  # Branch protection pins required checks by name string, and a matrix job's name embeds
  # its matrix values — so protecting `rust (windows-latest)` would silently stop applying
  # the day the matrix changes. This fixed name is the protected check; the matrix
  # underneath stays free to change.
  ci-ok:
    name: ci-ok
    if: always()
    needs: [frontend, rust]
    runs-on: ubuntu-22.04
    steps:
      - name: Fail unless every dependency succeeded
        run: |
          echo "frontend=${{ needs.frontend.result }}"
          echo "rust=${{ needs.rust.result }}"
          [ "${{ needs.frontend.result }}" = "success" ] || exit 1
          [ "${{ needs.rust.result }}" = "success" ] || exit 1
```

- [ ] **Step 4: Commit and open the PR**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: gate pull requests on build, lint, tests, fmt and clippy"
git push -u origin ci/pipelines
gh pr create --title "ci: build/test pipelines, semver releases, PR gate" \
  --body "Implements docs/superpowers/specs/2026-08-09-ci-release-pipelines-design.md" \
  --base main
```

- [ ] **Step 5: Watch the run and confirm it is green**

```bash
gh run watch --exit-status
```

Expected: `frontend`, `rust (windows-latest)`, `rust (ubuntu-22.04)` and `ci-ok` all
succeed. If a Rust job fails on a missing system library, the apt list is wrong — fix it
there, not by removing the check.

- [ ] **Step 6: Prove the gate actually rejects — this is the test**

A green pipeline proves nothing about a *gate*. Introduce a real lint failure. Add an
unused variable to a TypeScript file that eslint will reject:

```bash
git checkout -b ci/gate-proof
printf '\nconst __gateProof = 1;\n' >> src/main.tsx
git add src/main.tsx
git commit -m "test: prove the gate rejects a lint failure"
git push -u origin ci/gate-proof
gh pr create --title "test: gate proof (do not merge)" --body "Temporary." --base main
gh run watch --exit-status
```

Expected: **the command exits non-zero.** `frontend` fails on
`@typescript-eslint/no-unused-vars`, and `ci-ok` fails because of it. Record in the PR that
you saw `ci-ok` red.

If `ci-ok` reports **success** while `frontend` is red, the aggregator is broken — that is
the single most important thing in this task and it must be fixed before continuing.

- [ ] **Step 7: Tear the proof branch down**

```bash
gh pr close ci/gate-proof --delete-branch
git checkout ci/pipelines
git branch -D ci/gate-proof
```

- [ ] **Step 8: Commit nothing further; the branch stays open for Tasks 2 and 3**

Verify you are back on `ci/pipelines` with a clean tree:

```bash
git status --short && git branch --show-current
```

Expected: no output from `git status --short`, and `ci/pipelines`.

---

## Task 2: Version bumping with release-please

**Files:**
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`

**Interfaces:**
- Produces: on a push to `main`, a standing PR titled `chore(main): release X.Y.Z` that
  bumps all five version files and writes `CHANGELOG.md`. Task 3's workflow consumes the
  action outputs `release_created`, `id`, `tag_name`, `version`.

- [ ] **Step 1: Write the config**

Create `release-please-config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "bump-minor-pre-major": true,
  "draft": true,
  "force-tag-creation": true,
  "packages": {
    ".": {
      "release-type": "node",
      "package-name": "mtg-collection-tracker",
      "changelog-path": "CHANGELOG.md",
      "extra-files": [
        {
          "type": "json",
          "path": "src-tauri/tauri.conf.json",
          "jsonpath": "$.version"
        },
        {
          "type": "toml",
          "path": "src-tauri/Cargo.toml",
          "jsonpath": "$.package.version"
        },
        {
          "type": "toml",
          "path": "src-tauri/Cargo.lock",
          "jsonpath": "$.package[?(@.name.value=='mtg-collection-tracker')].version"
        }
      ]
    }
  }
}
```

Three of these keys are load-bearing and none is obvious:

- **`bump-minor-pre-major: true`** — the project is at `0.x`. Without this, release-please's
  default sends any breaking change straight to `1.0.0`. With it, `feat!:` bumps the minor
  and reaching 1.0 stays a deliberate act (see Task 6's `Release-As:` note).
- **`draft: true`** — the build takes minutes; without a draft there is a public release
  with zero assets for that whole window, and a failed build leaves a broken published
  release rather than a draft you delete.
- **`force-tag-creation: true`** — GitHub does not create a draft release's git tag until
  it is published. Without this, release-please's *next* run cannot find the previous
  release and regenerates the entire commit history into the changelog. This key exists
  precisely to pair with `draft: true`; they are not independent choices.

The `Cargo.lock` selector uses `@.name.value`, not `@.name`. release-please parses TOML
into tagged nodes where every scalar becomes an object, so `@.name == '…'` matches nothing
and — worse — a non-match is a warning, not an error. `--locked` in both workflows is what
converts that silence into a failure. See Step 4 for what to do if it does.

- [ ] **Step 2: Write the manifest**

Create `.release-please-manifest.json`:

```json
{
  ".": "0.1.0"
}
```

This asserts 0.1.0 is *already released*, so the next PR proposes 0.2.0. An empty `{}`
would instead propose 0.1.0 as a first release, which is wrong — the version is already in
every manifest file.

- [ ] **Step 3: Validate the JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('release-please-config.json','utf8')); JSON.parse(require('fs').readFileSync('.release-please-manifest.json','utf8')); console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 4: Record the fallback, in case the Cargo.lock selector misses**

No action now — read this and move on. In Task 6 you will inspect the first release PR's
diff. If `src-tauri/Cargo.lock` is **not** bumped there, CI on that PR fails on `--locked`.
The fix is one command on the release PR's branch, not a config redesign:

```bash
gh pr checkout <release-pr-number>
cd src-tauri && cargo check && cd ..
git add src-tauri/Cargo.lock
git commit -m "chore: sync Cargo.lock with the release version"
git push
```

Then replace that third `extra-files` entry with the index form
`"jsonpath": "$.package[0].version"` only after confirming with
`grep -n 'name = "mtg-collection-tracker"' src-tauri/Cargo.lock` that it really is the
first `[[package]]` entry — Cargo sorts alphabetically, so verify rather than assume.

- [ ] **Step 5: Commit**

```bash
git add release-please-config.json .release-please-manifest.json
git commit -m "ci: derive semver versions from conventional commits"
git push
```

---

## Task 3: The release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `release-please-config.json` and `.release-please-manifest.json` from Task 2.
- Produces: a published GitHub Release per version, carrying `*-setup.exe` (NSIS), `*.msi`,
  `*-windows-x64-portable.zip`, `*.deb` and `*.AppImage`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency:
  group: release
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  release-please:
    name: release-please
    runs-on: ubuntu-22.04
    outputs:
      release_created: ${{ steps.release.outputs.release_created }}
      release_id: ${{ steps.release.outputs.id }}
      tag_name: ${{ steps.release.outputs.tag_name }}
      version: ${{ steps.release.outputs.version }}
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  build:
    name: build (${{ matrix.os }})
    needs: release-please
    if: needs.release-please.outputs.release_created == 'true'
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            bundles: nsis,msi
          - os: ubuntu-22.04
            bundles: deb,appimage
    steps:
      # `id` is real but undocumented in the action's README. If it ever stops being
      # emitted, tauri-action would fall back to tag matching and could create a SECOND
      # release. Fail loudly instead.
      - name: Refuse to build without a release id
        shell: bash
        run: |
          if [ -z "${{ needs.release-please.outputs.release_id }}" ]; then
            echo "release-please emitted no release id; refusing to build."
            exit 1
          fi

      - uses: actions/checkout@v4

      - name: Install Linux system dependencies
        if: matrix.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            build-essential \
            curl \
            wget \
            file \
            libxdo-dev \
            libssl-dev \
            libayatana-appindicator3-dev \
            librsvg2-dev \
            patchelf \
            xdg-utils \
            libfuse2

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      # tauri-action does NOT install frontend dependencies. It DOES run
      # beforeBuildCommand (`npm run build`), so do not run that here as well.
      - run: npm ci

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          releaseId: ${{ needs.release-please.outputs.release_id }}
          releaseDraft: true
          uploadUpdaterJson: false
          args: --bundles ${{ matrix.bundles }} -- --locked

      # productName does not rename the binary in Tauri v2, so this really is the
      # lowercase hyphenated Cargo package name. The exe is self-contained: frontend
      # assets are embedded and SQLite is `bundled`. Run from any folder it writes
      # <exe dir>/data, which is the portable behaviour no Program Files install reaches.
      - name: Package the portable Windows build
        if: matrix.os == 'windows-latest'
        shell: pwsh
        env:
          VERSION: ${{ needs.release-please.outputs.version }}
        run: |
          $zip = "mtg-collection-tracker-$env:VERSION-windows-x64-portable.zip"
          Compress-Archive -Path src-tauri/target/release/mtg-collection-tracker.exe -DestinationPath $zip
          "PORTABLE_ZIP=$zip" | Out-File -FilePath $env:GITHUB_ENV -Append

      - name: Attach the portable zip to the draft release
        if: matrix.os == 'windows-latest'
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release upload "${{ needs.release-please.outputs.tag_name }}" \
            "$PORTABLE_ZIP" --clobber --repo "${{ github.repository }}"

  publish:
    name: publish
    needs: [release-please, build]
    if: needs.release-please.outputs.release_created == 'true'
    runs-on: ubuntu-22.04
    steps:
      # The release goes public only once every platform's assets are attached.
      - name: Publish the draft release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release edit "${{ needs.release-please.outputs.tag_name }}" \
            --draft=false --repo "${{ github.repository }}"
```

- [ ] **Step 2: Check the YAML parses before pushing it**

A YAML error means GitHub silently ignores the workflow, which reads exactly like "the
release didn't fire".

```bash
node -e "const s=require('fs').readFileSync('.github/workflows/release.yml','utf8'); if(s.includes('\t')) throw new Error('tab character in YAML'); console.log('lines', s.split('\n').length)"
gh workflow list 2>/dev/null | head -5 || true
```

Expected: no error thrown. (`gh workflow list` will not show the new workflow until it is
on `main`; that is expected here.)

- [ ] **Step 3: Commit and confirm the PR is still green**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build and publish releases to GitHub Releases"
git push
gh run watch --exit-status
```

Expected: `ci-ok` succeeds. The release workflow does **not** run on this PR — it is
`on: push` to `main` only.

---

## Task 4: Merge, then give the gate teeth

**Files:**
- No files. Repository settings only.

**Interfaces:**
- Consumes: the check name `ci-ok` produced by Task 1.

- [ ] **Step 1: Allow Actions to open pull requests**

release-please cannot open its release PR without this, and the failure mode is an opaque
403 in the workflow log.

```bash
gh api -X PUT repos/Msgaihede/mtg-grimoire/actions/permissions/workflow \
  -f default_workflow_permissions=write \
  -F can_approve_pull_request_reviews=false
```

Expected: JSON echoing `"default_workflow_permissions": "write"`.

- [ ] **Step 2: Merge the pipelines PR**

```bash
gh pr merge ci/pipelines --squash --delete-branch
git checkout main && git pull
```

- [ ] **Step 3: Confirm both workflows now exist on main**

```bash
gh workflow list
```

Expected: `CI` and `Release` both listed as `active`.

- [ ] **Step 4: Apply branch protection**

`enforce_admins: false` is the admin bypass agreed in the spec — you keep the ability to
push directly to `main`, so CLAUDE.md's "Work on `main`" rule stays literally true, while a
PR cannot be merged red.

```bash
gh api -X PUT repos/Msgaihede/mtg-grimoire/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["ci-ok"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

- [ ] **Step 5: Verify the protection reads back exactly as intended**

```bash
gh api repos/Msgaihede/mtg-grimoire/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts, strict: .required_status_checks.strict, admins: .enforce_admins.enabled}'
```

Expected exactly: `{"checks":["ci-ok"],"strict":true,"admins":false}`.

If `checks` is empty or names anything other than `ci-ok`, the gate is not applied —
protection silently accepts check names that do not exist, so this read-back is the only
proof.

---

## Task 5: Document the pipelines

**Files:**
- Modify: `CLAUDE.md` — new section after the `## Commands` section
- Modify: `README.md`

**Interfaces:**
- Consumes: the workflow names and the release flow from Tasks 1–4.

- [ ] **Step 1: Branch**

```bash
git checkout -b docs/ci-release
```

- [ ] **Step 2: Add the CI section to CLAUDE.md**

Insert immediately after the `## Commands` section's last bullet:

```markdown
## CI and releases
- Two workflows. **`.github/workflows/ci.yml`** gates PRs and pushes to `main`: a
  `frontend` job (`npm run build`/`lint`/`test:run`) and a `rust` matrix over
  `windows-latest` + `ubuntu-22.04` (`cargo fmt --check` on Linux only, `clippy -D warnings`
  and `cargo test` on both, everything `--locked`). **`ci-ok` is the one protected check** —
  branch protection pins names by string and a matrix job's name embeds its matrix values,
  so the aggregator is what has teeth and the matrix underneath stays free.
  `enforce_admins` is **false**: a red PR cannot merge, a direct push to `main` still can.
- The `rust` job writes a stub `dist/index.html` first. `tauri-build` reads
  `frontendDist: "../dist"` and fails outright when it is missing, so a Rust-only job
  cannot compile a fresh checkout; the stub is what keeps it parallel with `frontend`.
- **`.github/workflows/release.yml` is one workflow on purpose.** A release created with
  `GITHUB_TOKEN` does not trigger `on: release` in another workflow — GitHub's recursion
  guard — so release-please, the build matrix and the publish step are three jobs in one
  file, chained on `release_created`.
- **Versions are never typed by hand.** release-please reads the `feat:`/`fix:`/`!`
  prefixes and keeps a `chore(main): release X.Y.Z` PR open that bumps all five version
  files — `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` — and writes `CHANGELOG.md`. Merging it
  tags, builds and publishes. `bump-minor-pre-major` is on, so while on `0.x` a `feat!:`
  bumps the **minor**; reaching 1.0 is a deliberate `Release-As: 1.0.0` footer on an empty
  commit.
- **`--locked` everywhere is load-bearing.** `Cargo.lock`'s version is bumped by a
  release-please `toml` extra-file whose selector reaches through TOML tagged nodes
  (`@.name.value`, never `@.name`), and a miss there is a *warning*, not an error.
  `--locked` is what turns that silence into a failed check on the release PR itself,
  before anything publishes.
- The release is created as a **draft** and published only after every platform's assets
  attach, so a release is never visible without its binaries. `force-tag-creation` pairs
  with that: a draft has no git tag, and without it release-please's next run cannot find
  the previous release and replays the whole history into the changelog.
- Artifacts per release: NSIS `-setup.exe`, `.msi`, a **portable `.zip`** (the bare
  `mtg-collection-tracker.exe` — `productName` does not rename the binary in Tauri v2 —
  which runs from any folder and keeps `data/` beside itself, the behaviour no Program
  Files install can reach), plus `.deb` and `.AppImage`.
- **Linux artifacts are built but unverified.** Every measured claim in this file — sync
  timings, the image cache, the `mtgimg://` origin, the drag-and-drop interception trap —
  was measured on Windows. Nobody has run a Linux build.
- Not done, deliberately: no code signing (no certificate, so SmartScreen warns on the
  installers), no auto-updater (`tauri-plugin-updater` is not a dependency), and **not**
  GitHub Packages — none of its registry types hosts a desktop installer.
```

- [ ] **Step 3: Replace README.md**

```markdown
# MTG Collection Tracker

Portable desktop app for tracking a Magic: The Gathering collection — Tauri 2 + React 19.

## Install

Grab the latest [release](https://github.com/Msgaihede/mtg-grimoire/releases):

- **`…-setup.exe`** — Windows installer (NSIS). Installs to Program Files.
- **`…-windows-x64-portable.zip`** — a single self-contained executable. Unzip anywhere
  and run it; the collection database lives in a `data/` folder beside the exe, so the
  whole thing moves on a USB stick.
- **`….msi`** — Windows installer for managed deployment.
- **`….deb` / `….AppImage`** — Linux builds. These compile and bundle in CI but have not
  been run by anyone; treat them as best-effort.

The installers are unsigned, so Windows SmartScreen warns on first run.

## Development

See `CLAUDE.md` for architecture and `docs/` for specs and plans.

- `npm run tauri dev` — run the app
- `npm run verify` — build + lint + Vitest + cargo test; run before every commit
```

- [ ] **Step 4: Commit, open the PR, and confirm the gate passes**

This PR is also the first live test of branch protection.

```bash
git add CLAUDE.md README.md
git commit -m "chore: document the CI and release pipelines"
git push -u origin docs/ci-release
gh pr create --title "chore: document the CI and release pipelines" --body "Follows Tasks 1-4." --base main
gh run watch --exit-status
```

Expected: green, and the PR page shows `ci-ok` as a **required** check.

- [ ] **Step 5: Merge**

```bash
gh pr merge docs/ci-release --squash --delete-branch
git checkout main && git pull
```

---

## Task 6: Cut the first release, end to end

**Files:**
- Modify (by the bot): `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.

- [ ] **Step 1: Find the release PR release-please opened**

Merging Task 5 pushed to `main`, which ran `release.yml`. The repo has 158 commits and no
prior tag, so release-please scans the whole history, finds the `feat:` commits from
Plans 1–5, and proposes **0.2.0**.

```bash
gh pr list --search "chore(main): release" --state open
```

Expected: one open PR. If there is none, read the run log — the likeliest cause is Task 4
Step 1 not having been applied:

```bash
gh run list --workflow=Release --limit 1
gh run view --log-failed
```

- [ ] **Step 2: Decide how much history the first changelog should carry**

Open the PR and look at `CHANGELOG.md`. It will cover all 158 commits, because there is no
prior tag to bound it. That is a genuine one-time choice and this is the only moment to
make it:

- **Keep it** — `CHANGELOG.md` becomes a true record of how the app was built. Recommended.
- **Trim it** — close the PR, add `"bootstrap-sha": "<sha of the Task 5 merge>"` at the top
  level of `release-please-config.json`, push to `main`, and a fresh PR opens with a
  changelog covering only what follows. Get the sha with `git rev-parse HEAD`.

- [ ] **Step 3: Verify all five version files moved together — the point of the whole task**

```bash
gh pr checkout "$(gh pr list --search 'chore(main): release' --state open --json number --jq '.[0].number')"
grep -m1 '"version"' package.json
grep -m1 '"version"' src-tauri/tauri.conf.json
grep -m1 '^version' src-tauri/Cargo.toml
grep -A2 'name = "mtg-collection-tracker"' src-tauri/Cargo.lock | grep version
```

Expected: **all four print `0.2.0`.**

If `Cargo.lock` still reads `0.1.0`, the `@.name.value` selector missed. Apply the fallback
recorded in Task 2 Step 4 — it is a `cargo check` and a commit on this branch, not a
redesign.

- [ ] **Step 4: Confirm CI is green on the release PR**

```bash
gh run watch --exit-status
```

Expected: green. A failure here reading
`the lock file … needs to be updated but --locked was passed` is exactly the Cargo.lock
miss from Step 3, caught before anything published — that is `--locked` doing its job.

- [ ] **Step 5: Merge and watch the release build**

```bash
git checkout main
gh pr merge "$(gh pr list --search 'chore(main): release' --state open --json number --jq '.[0].number')" --squash --delete-branch
gh run watch --exit-status
```

Expected: `release-please`, `build (windows-latest)`, `build (ubuntu-22.04)` and `publish`
all succeed. Budget ~15 minutes — the Rust cache is cold and `rusqlite` compiles SQLite
from C.

- [ ] **Step 6: Verify the published release carries all five artifacts**

```bash
gh release view v0.2.0 --json isDraft,tagName,assets --jq '{draft: .isDraft, tag: .tagName, assets: [.assets[].name]}'
```

Expected: `draft: false`, `tag: "v0.2.0"`, and five assets — an NSIS `-setup.exe`, an
`.msi`, a `-windows-x64-portable.zip`, a `.deb` and an `.AppImage`. The Windows bundle
names contain spaces (`MTG Collection Tracker_0.2.0_x64-setup.exe`) because `productName`
is used verbatim; that is expected, not a bug.

If `draft` is `true`, the `publish` job did not run — check whether a `build` matrix leg
failed.

- [ ] **Step 7: Prove the portable zip is actually portable**

The one claim no CI job can make for you.

```bash
gh release download v0.2.0 --pattern "*portable.zip" --dir "$TMPDIR/portable-check"
```

Unzip it to an empty folder, run the exe, let it finish its first sync, then confirm a
`data/` directory was created **beside the exe** and not in `%APPDATA%`. Close the app.

Expected: `data/mtg.db` sits next to `mtg-collection-tracker.exe`.

- [ ] **Step 8: Verify the tag exists as a real git tag**

`force-tag-creation` exists to guarantee this; a missing tag corrupts the next release's
changelog.

```bash
git fetch --tags && git tag -l 'v0.2.0'
```

Expected: `v0.2.0`.

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task: Releases-not-Packages → Task 3 +
Task 5 docs; release-please and pre-1.0 semantics → Task 2; Windows+Linux matrix → Tasks 1
and 3; the gate and `ci-ok` → Task 1; branch protection with admin bypass → Task 4; draft
then publish → Task 3; portable zip → Task 3 build + Task 6 Step 7; the Cargo.lock open
item → Task 2 Steps 1/4 and Task 6 Step 3; manual repo settings → Task 4; documentation →
Task 5; non-goals → Task 5's CLAUDE.md text.

**Corrections to the spec made here**, from the 2026-08-09 upstream verification:
`tauri-action@v1` not `@v0`; `uploadUpdaterJson` not `includeUpdaterJson`;
`--bundles` is pinned as a shipping choice, *not* because RPM needs `rpmbuild` (it does
not); `force-tag-creation` added as a required companion to `draft`; `issues: write` added
to permissions; the `Cargo.lock` selector settled on `@.name.value` with `--locked` as its
proof and a one-command fallback.
