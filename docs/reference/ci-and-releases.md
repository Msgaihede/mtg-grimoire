# CI and releases

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- Two workflows. **`.github/workflows/ci.yml`** gates PRs and pushes to `main`: a `changes`
  router (below), a `frontend`
  job (`npm run build`/`lint`/`test:run`), a `rust` matrix over `windows-latest` +
  `ubuntu-22.04` (`cargo fmt --check` on Linux only, `clippy -D warnings` and `cargo test`
  on both, everything `--locked`), and a `powershell` job (below).
  **`ci-ok` is the one protected check** — branch protection
  pins names by string and a matrix job's name embeds its matrix values, so the aggregator is
  what has teeth and the matrix underneath stays free. `enforce_admins` is **false**: a red PR
  cannot merge, a direct push to `main` still can, so "Work on `main`" below stays true.
  Proven 2026-08-09 by a deliberate lint error: `frontend` red, both `rust` legs green,
  **`ci-ok` red**. A green pipeline proves nothing about a gate; that run is the proof.
- **A change only builds the half it touched.** The `changes` job diffs against the base
  (`git diff --name-only --no-renames`, so it needs `fetch-depth: 0`) and routes each path:
  `src-tauri/**` → `rust`; `src/**`, `public/**`, `index.html`, the lockfiles and the
  frontend's configs, plus **`scripts/` because `eslint .` lints it** (its ignore list is
  `dist/`, `src-tauri/`, `node_modules/` and nothing else) → `frontend`;
  `*.ps1`/`*.psm1`/`*.psd1` → `powershell`; `ci.yml` itself → **all three**;
  prose and editor/release bookkeeping → neither; and **anything unrecognised → both**
  build jobs.
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
- Skipping `frontend` on a Rust-only change gives up nothing CI ever caught: **no test on
  either side reads a file across the boundary.** The frontend's two source sweeps glob
  `/src/**` (`layers.test.ts`, `tokens.test.ts`), vitest only collects `src/**/*.test.{ts,tsx}`,
  and the crate's one `include_str!` is its own `tauri.conf.json`. The TS↔Rust contract in
  `src/lib/ipc.ts` is hand-mirrored and, in its own words, "can drift silently" — that was
  already true when both jobs ran on every commit.
- The `rust` job writes a stub `dist/index.html` first. `tauri-build` reads
  `frontendDist: "../dist"` and fails outright when it is missing, so a Rust-only job cannot
  compile a fresh checkout; the stub is what keeps it parallel with `frontend` instead of
  serialized behind a full Vite build — and it is also why the `rust` job is safe to run with
  `frontend` skipped entirely: the frontend it needs is one file it writes itself.
- **`.github/workflows/release.yml` is one workflow on purpose.** A release created with
  `GITHUB_TOKEN` does not trigger `on: release` in another workflow — GitHub's recursion
  guard — so release-please, the build matrix and the publish step are three jobs in one
  file, chained on `release_created`.
- **Versions are never typed by hand.** release-please reads the `feat:`/`fix:`/`!` prefixes
  and keeps a `chore(main): release X.Y.Z` PR open that bumps all five version files —
  `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
  `src-tauri/Cargo.lock` — and writes `CHANGELOG.md`. Merging it tags, builds and publishes.
  `bump-minor-pre-major` is on, so while on `0.x` a `feat!:` bumps the **minor**; reaching
  1.0 is a deliberate `Release-As: 1.0.0` footer, never something a stray `!` does.
- **The `Cargo.lock` selector must read `@.name.value`, never `@.name`.** release-please
  parses TOML into tagged nodes, so every scalar is an object and the obvious form matches
  nothing — and a non-match is a _warning_, not an error. Measured against the real lockfile
  2026-08-09: `.value` changes exactly one line and leaves the `version = 4` lockfile-format
  key alone; the bare form changes nothing at all. **`--locked` on every cargo call in both
  workflows is what converts that silence into a failed check on the release PR itself**,
  before anything is tagged.
- The release is created as a **draft** and published only after every platform's assets
  attach, so a release is never visible without its binaries. `force-tag-creation` pairs with
  that and is not optional: a draft has no git tag until published, and without it
  release-please's next run cannot find the previous release and replays the whole history
  into the changelog. `gh release upload`/`edit` **do** resolve a draft by tag even though no
  tag exists yet (measured 2026-08-09 — the draft's own URL is `untagged-<sha>`).
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
- `--bundles` is pinned per platform. Not because RPM needs `rpmbuild` — it does not, Tauri
  builds RPMs in-process with the pure-Rust `rpm` crate — but because shipping one is a
  choice. AppImage is the bundle with external needs: it downloads `linuxdeploy` and wants
  `patchelf`, `xdg-utils`, `libfuse2`.
- **Linux artifacts are built but unverified.** Every measured claim in this repo — the sync
  timings, the image cache, the `mtgimg://` origin, the drag-and-drop interception trap — was
  measured on Windows. Nobody has run a Linux build.
- Not done, deliberately: no code signing (no certificate, so SmartScreen warns on the
  installers) and **not** GitHub Packages — none of its registry types hosts a desktop
  installer, which is why the compiled app goes to Releases instead.
