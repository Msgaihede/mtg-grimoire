# .github — CI and releases

Two workflows, and every rule below was measured live. Full detail, including the proof runs:
[docs/reference/ci-and-releases.md](../docs/reference/ci-and-releases.md).

## `ci.yml`

- **`ci-ok` is the one protected check.** Branch protection pins names by string and a matrix
  job's name embeds its matrix values, so the aggregator is what has teeth and the matrix
  underneath stays free. `enforce_admins` is **false**: a red PR cannot merge, a direct push to
  `main` still can.
- **A change only builds the half it touched.** The `changes` job diffs against the base and
  routes each path: `src-tauri/**` → `rust`; frontend sources, lockfiles, configs and
  **`scripts/` because `eslint .` lints it** → `frontend`; `*.ps1`/`*.psm1`/`*.psd1` →
  `powershell`; `ci.yml` itself → all three; prose and
  editor bookkeeping → neither; and **anything unrecognised → both build jobs**. That last arm
  is the
  fail-safe that makes the lists safe to be wrong in the cheap direction. **Only the "neither"
  arm can wrongly skip work, so it stays small.**
- **The `powershell` job runs `lock.test.ps1` on `windows-latest`**, and its `case` arm must
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
