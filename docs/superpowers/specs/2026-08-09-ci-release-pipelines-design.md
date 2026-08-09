# CI & Release Pipelines — Design

**Date:** 2026-08-09
**Repo:** `github.com/Msgaihede/mtg-grimoire`
**Status:** approved, ready to plan

## Goal

Continuous integration that gates pull requests, and a release pipeline that turns a
merged version bump into a published GitHub Release carrying compiled Windows and Linux
artifacts. Versions follow semver and are derived from the conventional-commit history
the project already writes.

## Starting state

- No `.github/` directory. No workflows, no tags, no releases.
- Version `0.1.0`, duplicated across four tracked files: `package.json`,
  `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` — and a fifth
  derived one, `src-tauri/Cargo.lock`.
- `npm run verify` = `npm run build && npm run lint && npm run test:run && cargo test`.
- `cargo fmt --check` and `cargo clippy --all-targets` both pass on the current tree
  (measured 2026-08-09, zero diffs and zero warnings), so a strict Rust gate is green on
  day one.

## Decisions

### Artifacts go to GitHub Releases, not GitHub Packages

The original request named GitHub Packages. GitHub Packages hosts npm, NuGet, Maven,
Gradle, RubyGems and container images — there is no generic-artifact registry, and none of
those types is a home for a Windows installer. Publishing to Releases is what
`tauri-action` supports, what users can download without a token, and the only substrate a
future Tauri updater could read. **GitHub Packages is deliberately unused.**

### Versions come from release-please

`feat:` → minor, `fix:` → patch, `!`/`BREAKING CHANGE` → see pre-1.0 rule below. A standing
bot PR (`chore(main): release X.Y.Z`) carries the bump and the changelog; merging it tags
and releases. No version is ever typed by hand.

**Pre-1.0 rule.** The project is at `0.1.0`. release-please's default sends a breaking
change straight to `1.0.0`. Config sets `bump-minor-pre-major: true`, so while on `0.x` a
breaking change bumps the **minor**. Reaching `1.0.0` is then a deliberate act — a
`Release-As: 1.0.0` footer on a commit — rather than something a stray `!` does by accident.

### Platforms: Windows and Linux

`windows-latest` and `ubuntu-22.04`. 22.04 rather than 24.04 for wider glibc compatibility
in the AppImage.

**Recorded risk:** every measured claim in `CLAUDE.md` — sync timings, image cache
behaviour, the `mtgimg://` origin split, the drag-and-drop interception trap — was measured
on Windows. Linux artifacts will compile and bundle, but no one has run one. They ship as
best-effort until someone does.

### The gate has teeth, with admin bypass

Branch protection on `main` requires the CI check; `enforce_admins: false`. Direct pushes
to `main` remain possible, so `CLAUDE.md`'s "Work on `main`" working-style rule stays
literally true, and CI runs on push-to-main as well as on PRs so the signal exists either
way.

## Architecture

```
.github/workflows/ci.yml         the gate
.github/workflows/release.yml    release-please + build + publish, one workflow
release-please-config.json       bump rules and extra-files
.release-please-manifest.json    current version; bot-owned
```

### Why release-please and the build share one workflow

A GitHub Release created with `GITHUB_TOKEN` does **not** fire `release: published` for
other workflows — GitHub's recursion guard. A separate `on: release` build workflow would
never run. So `release.yml` is one workflow whose build job is gated on the release-please
job's `release_created` output.

## `ci.yml` — the gate

**Triggers:** `pull_request` → `main`; `push` → `main`.
**Concurrency:** group per ref, `cancel-in-progress: true`.

| Job | Runner | Steps |
| --- | --- | --- |
| `frontend` | `ubuntu-22.04` | `npm ci` · `npm run build` · `npm run lint` · `npm run test:run` |
| `rust` (matrix) | `windows-latest`, `ubuntu-22.04` | `cargo fmt --check` (Linux only) · `cargo clippy --all-targets -- -D warnings` · `cargo test` |
| `ci-ok` | `ubuntu-22.04` | `needs: [frontend, rust]`, `if: always()`; fails unless every dependency succeeded |

**`ci-ok` is the only protected check.** Branch protection pins required checks by name
string, and a matrix job's name embeds its matrix values — so protecting `rust (windows-latest)`
means the gate silently stops applying the day the matrix changes. One fixed aggregator
name is protected; the matrix underneath stays free.

**`cargo fmt --check` runs once, clippy runs twice.** Formatting has no platform split.
Lints do: the Rust source has `cfg`-gated Windows paths (the `mtgimg.localhost` origin),
which a single-OS clippy pass never compiles.

**The `rust` job writes a stub `dist/index.html` before touching cargo.** `tauri-build`
reads `frontendDist: "../dist"` and fails the build outright when the directory is absent,
so a Rust-only job cannot compile a fresh checkout. The stub keeps `rust` and `frontend`
parallel instead of serializing `rust` behind a full Vite build; nothing under test reads it.

**Linux system dependencies** (`ubuntu-22.04`, both workflows): `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `build-essential`, `curl`,
`wget`, `file`, `libxdo-dev`, `libssl-dev`.

**Caching:** `actions/setup-node` with `cache: npm`; `Swatinem/rust-cache@v2` keyed per OS.
`rusqlite` is `bundled`, so it compiles SQLite from C — that is the cold cost.

CI deliberately does not run `npm run verify` as one step. It splits the same four checks
for parallelism; `verify` remains the local one-shot, and the two must stay equivalent in
coverage.

## `release.yml` — release and publish

**Trigger:** `push` → `main`.
**Permissions:** `contents: write`, `pull-requests: write`.
**Concurrency:** group `release`, `cancel-in-progress: false` — cancelling a half-uploaded
release is worse than queuing behind one.

### Job A — `release-please`

`googleapis/release-please-action@v4`, manifest mode. Outputs `release_created`,
`tag_name`, `id`.

Configured with **`draft: true`**. The build takes minutes; without a draft there is a
public release with zero assets for that entire window. A failed build then leaves a draft
to delete rather than a broken published release users have already found.

**`force-tag-creation: true` is a required companion, not an option** (added 2026-08-09).
GitHub does not create a draft release's git tag until it is published, so without it
release-please's *next* run cannot find the previous release and replays the entire commit
history into the changelog. `draft` and `force-tag-creation` are one decision.

Permissions on the job: `contents: write`, `issues: write`, `pull-requests: write`.

`release-please-config.json` bumps, from a `node` release type at the repo root:

- `package.json`, `package-lock.json` — by the node strategy
- `src-tauri/tauri.conf.json` — extra-file, `json`, `$.version`
- `src-tauri/Cargo.toml` — extra-file, `toml`, `$.package.version`
- `src-tauri/Cargo.lock` — extra-file; selector to be settled at implementation time (see
  Open item below)

### Job B — `build`

`if: needs.release-please.outputs.release_created == 'true'`. Matrix: `windows-latest`,
`ubuntu-22.04`. Runs `tauri-apps/tauri-action@v1` with `releaseId` from job A, so assets
attach to the draft. (Corrected 2026-08-09: the current major is **v1**, not v0, and its
updater input is `uploadUpdaterJson` — `includeUpdaterJson` was renamed and no longer
exists.)

Checkout takes the default ref: the push that triggered the workflow *is* the merge of the
release PR, so `main`'s HEAD already carries the bumped version.

Before `tauri-action`, the job sets up Node and runs `npm ci` — `tauri-action` invokes
`tauri build`, which runs the configured `beforeBuildCommand` (`npm run build`), and that
needs installed dependencies. Rust toolchain, `Swatinem/rust-cache` and the Linux system
dependencies are the same as in `ci.yml`.

Two things are pinned rather than inherited from `tauri.conf.json`'s `targets: "all"`:

- **`--bundles nsis,msi`** on Windows, **`--bundles deb,appimage`** on Linux. `"all"` on
  Linux also builds an RPM. (Corrected 2026-08-09: that costs nothing — Tauri builds RPMs
  in-process with the pure-Rust `rpm` crate and does **not** shell out to `rpmbuild`. So
  pinning is a deliberate choice about what to ship, not a workaround. AppImage is the
  bundle with external needs: it downloads `linuxdeploy` and wants `patchelf`,
  `xdg-utils` and `libfuse2`.)
- **`-- --locked`** passed through to cargo. This is the check that catches a `Cargo.lock`
  release-please failed to bump, and it keeps a release reproducible from its lockfile.

**Windows only, after the bundles:** `Compress-Archive` on
`src-tauri/target/release/mtg-collection-tracker.exe` →
`mtg-collection-tracker-<version>-windows-x64-portable.zip`, uploaded with
`gh release upload --clobber`.

One file in the zip, because the exe already carries the frontend assets and SQLite is
`bundled`; WebView2 is an OS component on Windows 11 and evergreen on 10. Run from any
folder it writes `<exe dir>/data` — the portable behaviour `CLAUDE.md` documents and no
Program Files install can reach.

### Job C — `publish`

`needs: [release-please, build]`, `gh release edit <tag> --draft=false`. The release
becomes public only once every platform's assets are attached.

### Published per release

`*-setup.exe` (NSIS) · `*.msi` · `*-windows-x64-portable.zip` · `*.deb` · `*.AppImage`,
with release-please's generated changelog as the release body.

## Non-goals

- **GitHub Packages.** See above. Recorded as a decision, not an omission.
- **Code signing.** No certificate exists, so Windows SmartScreen warns on first run of the
  installers. A cert is a purchase, not a workflow change.
- **Auto-updater.** `tauri-plugin-updater` is not a dependency; there is no signing keypair
  and no `latest.json`. Releases-with-assets is precisely the substrate it would need, so
  adding it later is additive and nothing here forecloses it.
- **Dependabot / renovate.** Not requested.

## Open item to settle during implementation

**Settled 2026-08-09 by measurement.** release-please parses TOML into *tagged nodes*, so
every scalar becomes an object and the obvious selector
`$.package[?(@.name=='mtg-collection-tracker')].version` matches nothing. Reaching through
the wrapper — `@.name.value` — works, but it is an undocumented internal with no upstream
test coverage, and a non-match is a **warning, not an error**.

So the selector does the work and `--locked` proves it: `--locked` is passed to every cargo
invocation in *both* workflows, which means a missed lock bump fails CI **on the release PR
itself**, before anything is tagged or published. The fallback, if it ever misses, is one
`cargo check` and a commit on that PR's branch — not a config redesign.

## Manual steps (one-time, outside the workflows)

1. Apply branch protection on `main` via `gh api`: require the `ci-ok` check, require
   branches be up to date, `enforce_admins: false`.
2. Allow GitHub Actions to create and approve pull requests (repo Settings → Actions →
   General), which release-please needs to open its release PR.

## Documentation

`CLAUDE.md` gains a short CI/release section: what the two workflows are, how to cut a
release, the `Release-As:` escape hatch for reaching 1.0, and the fact that Linux artifacts
are unverified.

## Verification

- A branch with a deliberate lint error is refused by `ci-ok`.
- A `feat:` commit merged to `main` produces a release PR proposing `0.2.0`.
- Merging that PR yields a published, non-draft release carrying all five artifacts, with
  the version string identical across `package.json`, `Cargo.toml`, `tauri.conf.json` and
  the artifact filenames.
- The portable zip's exe launches from a scratch folder and creates `data/` beside itself.
