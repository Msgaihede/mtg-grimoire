# Repository layout, stage 1 (the moves) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the repository into `apps/`, `packages/`, `crates/` and `infrastructure/` with no change in behaviour, still on npm and still one `package.json`.

**Architecture:** One script moves 1,757 tracked files and rewrites every path that names one — relative paths, root-relative tokens and root-absolute globs — and reports what it could not decide. Fifteen files whose paths change *meaning* with their location are edited by hand. Everything is then held against a baseline taken before the move: test counts, sweep coverage, emitted CSS, bundle sizes and the WASM modules.

**Tech Stack:** Node 24, npm, Vite 8, Vitest 5, TypeScript 6, Tailwind 4, Storybook 10, Tauri 2, a cargo workspace, GitHub Actions.

**Spec:** [`docs/superpowers/specs/2026-10-08-repository-layout-and-workspace-design.md`](../specs/2026-10-08-repository-layout-and-workspace-design.md). Stage 2 (the pnpm workspace) gets its own plan after this lands.

## Global Constraints

- **Behaviour-preserving.** No schema rung, no user-visible change, no dependency added or bumped.
- **Nothing is deployed.** No `wrangler deploy` without `--dry-run`, and the release PR is not merged.
- **One commit lands.** Tasks end in a `wip(layout):` checkpoint commit on this branch; Task 8 squashes them into one `chore:` commit before anything is pushed.
- **All work happens in this worktree**, `D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570`, on `claude/repo-structure-cleanup-66d570`. No subagent takes a worktree of its own: an isolated one starts from `main`.
- **A subagent never runs `git add`, `git commit` or `git stash`.** The index is shared; the controller commits.
- **One cargo at a time, one `vitest run` at a time.** Check `Get-Process cargo,rustc` before starting either.
- **Never `cargo fmt --all`** and never `cargo fmt` inside `crates/card-scanner`.
- **Never run Prettier over the tree.** Format a file you wrote by matching its neighbours.
- **`git reset`, `git switch -c`, redirects and heredocs go through the PowerShell tool**; Bash refuses them here. Start every PowerShell call with `Set-Location` to the worktree.
- **Not touched, ever:** `docs/superpowers/**`, `CHANGELOG.md`, `Cargo.lock` (cargo may rewrite it; a hand never does), `package-lock.json`, `scripts/core-step-*.mjs`.
- **`<scratch>`** below is a folder outside the repository. In the planning session it is `C:\Users\Markus\AppData\Local\Temp\claude\D--Code-mtg-grimoire--claude-worktrees-repo-structure-cleanup-66d570\ba6ad799-535b-4b63-a3d2-9bb84e0e1273\scratchpad`, which already holds `layout-move.mjs` and a `census-before.json` taken at `54605405`. If that folder is gone, write `layout-move.mjs` from Appendix A.
- **`CLAUDE.md` files stay under 200 lines** (`node scripts/check-claude-md.mjs`).

## Review Focus

1. **The dev server refuses the shared UI.** With each app's Vite `root` set to its own folder, `packages/ui` is outside it, and Vite answers 403 for a file outside `server.fs.allow`. A build and Vitest never see it; `tauri dev` shows a blank window. Pinned by `scripts/vite-base.test.mjs` (Task 3) and the live pass (Task 7).
2. **A sweep that matches fewer files and still passes.** Thirteen tests glob `src/**`; six files leave it. Pinned by the census comparison (Task 4), which must print `every sweep matches what it matched`.
3. **A workflow that names a folder that is gone.** `release.yml` cannot run before a release. Pinned by a new assertion in `scripts/workflow-scripts.test.mjs` that every `working-directory:` exists (Task 5).
4. **Tailwind stops scanning a folder**, and a class used only there emits no CSS. The fake's files were scanned because they sat inside `.storybook/`; they no longer do. Pinned by the CSS comparison (Task 7).
5. **A checkout that takes this commit and keeps `src-tauri/target`** opens an empty collection, because the app's data sits beside its executable. No test can hold it; the skill, the docs and the pull request body say so (Task 6, Task 8).

## File structure

| Created | Purpose |
| --- | --- |
| `vite.base.ts` | What the three apps' Vite configs and Vitest share: plugins, the `@` alias, the watch list, `fs.allow`. |
| `vitest.config.ts` | The test settings that lived in `vite.config.ts`. |
| `apps/desktop/src/desktop.css` | The desktop's stylesheet: the shared one plus its own Tailwind sources. |
| `scripts/vite-base.test.mjs` | Fence for Review Focus 1. |
| `docs/reference/repository-layout.md` | The layout and the old-to-new table. |

| Rewritten | Why |
| --- | --- |
| `.cargo/config.toml` | It pinned the build tree to `src-tauri/target`; it now pins `target`. Not deleted, as first planned: a nested worktree with no file of its own reads the main checkout's (the spec's §5 amendment). |

Moves are the table in the spec's §4; `layout-move.mjs`'s `MAP` is that table as data.

**Order.** Tasks 0 to 5 run in sequence: each of 3, 4 and 5 runs Vitest, and Vitest has no config between the move and Task 3 Step 4. **Task 6 (docs) shares no file with Tasks 2 to 5** and can run beside them, from the moment Task 1 is committed. Tasks 7 and 8 follow.

---

### Task 0: The workspace and the baseline

**Files:** none in the repository.

**Interfaces:**
- Produces, in `<scratch>`: `vitest-before.json`, `cargo-before.txt`, `builds-before.json`, `census-before.json`, `wasm-before.txt`, and the script `layout-builds.mjs`.

- [ ] **Step 1: Install and check the disk**

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
if (-not (Test-Path node_modules)) { npm install }
(Get-PSDrive D).Free / 1GB
```

Expected: `node_modules` exists; at least 40 GB free. A fresh Rust build here is about 8 GB. Below 40, stop and tell the controller.

- [ ] **Step 2: Write `<scratch>/layout-builds.mjs`**

```js
// node layout-builds.mjs out.json <name>=<dir>...     what each build emitted
// node layout-builds.mjs --diff a.json b.json          the two, compared
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
/** A content hash in a file name or a `url()` is not a difference. */
const unhash = (s) => s.replace(/-[A-Za-z0-9_-]{8}(?=\.[a-z0-9]+)/g, "-HASH");

if (process.argv[2] === "--diff") {
  const [a, b] = process.argv.slice(3, 5).map((f) => JSON.parse(readFileSync(f, "utf8")));
  let bad = 0;
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[name], y = b[name];
    if (!x || !y) { console.log(`${name}: only in one run`); bad++; continue; }
    const drift = Math.abs(y.jsBytes - x.jsBytes) / x.jsBytes;
    const lost = x.css.filter((r) => !y.css.includes(r)), gained = y.css.filter((r) => !x.css.includes(r));
    console.log(`${name}: js ${x.jsFiles} -> ${y.jsFiles} files, ${x.jsBytes} -> ${y.jsBytes} B (${(drift * 100).toFixed(2)}%); css ${x.css.length} -> ${y.css.length} rules, -${lost.length} +${gained.length}`);
    for (const r of lost.slice(0, 15)) console.log(`   - ${r.slice(0, 150)}`);
    for (const r of gained.slice(0, 15)) console.log(`   + ${r.slice(0, 150)}`);
    if (x.jsFiles !== y.jsFiles || drift > 0.01 || lost.length || gained.length) bad++;
  }
  console.log(bad ? `${bad} builds differ` : "every build emitted what it emitted");
  process.exitCode = bad ? 1 : 0;
} else {
  const out = {};
  for (const arg of process.argv.slice(3)) {
    const [name, dir] = arg.split("=");
    const files = walk(dir);
    const js = files.filter((f) => f.endsWith(".js"));
    const css = files.filter((f) => f.endsWith(".css")).flatMap((f) => unhash(readFileSync(f, "utf8")).split("}").map((r) => r.trim()).filter(Boolean));
    out[name] = { jsFiles: js.length, jsBytes: js.reduce((n, f) => n + statSync(f).size, 0), css: [...new Set(css)].sort() };
  }
  writeFileSync(process.argv[2], JSON.stringify(out));
  for (const [k, v] of Object.entries(out)) console.log(`${k}: ${v.jsFiles} js files, ${v.jsBytes} B, ${v.css.length} css rules`);
}
```

- [ ] **Step 3: Build the WASM modules twice and compare** (the spec's "reproducible byte for byte")

```powershell
$env:CC_wasm32_unknown_unknown = "C:\Program Files\LLVM\bin\clang.exe"
$env:AR_wasm32_unknown_unknown = "C:\Program Files\LLVM\bin\llvm-ar.exe"
npm run web:wasm
Get-FileHash dist-wasm\*.wasm -Algorithm SHA256 | ForEach-Object { "$($_.Hash)  $(Split-Path $_.Path -Leaf)" } | Set-Content "<scratch>\wasm-before.txt"
npm run web:wasm
Get-FileHash dist-wasm\*.wasm -Algorithm SHA256 | ForEach-Object { "$($_.Hash)  $(Split-Path $_.Path -Leaf)" } | Set-Content "<scratch>\wasm-again.txt"
Compare-Object (Get-Content "<scratch>\wasm-before.txt") (Get-Content "<scratch>\wasm-again.txt")
```

Expected: no output from `Compare-Object`. If the two builds differ, the byte-identical check in Task 7 is replaced by "the script's printed sizes are equal"; record which in the report.

- [ ] **Step 4: Build everything and record it**

```powershell
npm run build
npx vite build --config vite.mobile.config.ts
npm run web:build
npm run share:build
npm run build-storybook
node "<scratch>\layout-builds.mjs" "<scratch>\builds-before.json" desktop=dist android=dist-mobile web=dist-web share=dist-share storybook=storybook-static
```

Expected: five lines, each with a non-zero count of js files and css rules.

- [ ] **Step 5: Record the test counts**

```powershell
npx vitest list --json | Set-Content -Encoding utf8 "<scratch>\vitest-before.json"
node -e "const t=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(new Set(t.map(x=>x.file)).size+' files, '+t.length+' tests')" "<scratch>\vitest-before.json"
cargo test --workspace 2>&1 | Select-String "^test result|Running|Doc-tests" | Set-Content "<scratch>\cargo-before.txt"
cargo test --manifest-path crates/card-scanner/Cargo.toml --target-dir crates/card-scanner/target --features cli 2>&1 | Select-String "^test result|Running|Doc-tests" | Add-Content "<scratch>\cargo-before.txt"
Select-String "^test result" "<scratch>\cargo-before.txt" | Measure-Object | Select-Object -ExpandProperty Count
```

Expected: a file count and a test count from Vitest; every `test result` line reads `ok`. Write both numbers into the task report.

- [ ] **Step 6: Take the sweep census**

```powershell
node "<scratch>\layout-move.mjs" . --census "<scratch>\census-before.json" --mapped
```

Expected: `22 files sweep the tree; 8914 matches in all`.

- [ ] **Step 7: Two smaller baselines**

```powershell
Push-Location mobile; npx tauri info 2>&1 | Select-String "frontendDist|devUrl|identifier|✘|error"; Pop-Location
npx tsc -p .design-sync/tsconfig.dts.json; "design-sync tsc exit: $LASTEXITCODE"
```

The first shows the Tauri CLI finding a project from the folder that holds its `src-tauri` while `package.json` is two levels up — the arrangement `apps/desktop` will have. Expected: it reports the light app's `frontendDist`, not the desktop's. The second is the only check `.design-sync/` has; record its exit code, whatever it is, for Task 7 to match.

No commit: nothing in the repository changed.

---

### Task 1: The move

**Files:** 1,757 moved, about 680 rewritten — by the script.

**Run by the controller, not a subagent:** it commits.

**Interfaces:**
- Consumes: `<scratch>/layout-move.mjs` (Appendix A).
- Produces: the layout of the spec's §4. `HAND` files are moved with their old text: `apps/desktop/vite.config.ts`, `apps/desktop/tsconfig.node.json`, `apps/desktop/index.html`, `apps/light/vite.config.ts`, `apps/light/vite.sw.ts`, `apps/share/vite.config.ts`, `packages/ui/components.json`, `packages/ui/tsconfig.web-worker.json`, `packages/ui/tsconfig.web-sw.json`, `infrastructure/{relay,share-worker,app-worker}/tsconfig.json`, and at the root `package.json`, `Cargo.toml`, `.cargo/config.toml`.

- [ ] **Step 1: Dry run, and read the report**

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
git status --short
node "<scratch>\layout-move.mjs" . --dry --verbose --log "<scratch>\rewrites.tsv"
```

Expected first line: `DRY RUN: 1757 files move, 680 files rewritten`. `shared UI importing a module that left it` must be `0`. If `git status` shows anything but the spec and this plan, stop.

- [ ] **Step 2: Commit the two documents so the tree is clean**

```powershell
git add docs/superpowers/specs/2026-10-08-repository-layout-and-workspace-design.md docs/superpowers/plans/2026-10-08-repository-layout-stage-1.md
git commit -m "wip(layout): the spec and the stage 1 plan"
```

- [ ] **Step 3: Move**

```powershell
node "<scratch>\layout-move.mjs" . --write
Get-ChildItem -Name | Sort-Object
```

Expected: `WROTE: 1757 files move, 680 files rewritten`, and a root with `apps`, `crates`, `docs`, `infrastructure`, `logos`, `packages`, `scripts` and no `src`, `src-tauri`, `mobile`, `share`, `relay`, `share-worker`, `app-worker`, `public`.

- [ ] **Step 4: Carry the build tree and its data across**

**Amended after execution: do not do this; move only `src-tauri\target\debug\data`.** The whole tree was moved, as written below, and Task 7's `cargo test` then failed in it: Tauri's build scripts had recorded absolute paths under the old `src-tauri\target`, and cargo does not rerun them. The tree had to be deleted and rebuilt. The step is left as it ran.

```powershell
if (Test-Path src-tauri\target) { Move-Item src-tauri\target target }
Test-Path src-tauri
```

Expected: `False`. If `src-tauri` still exists it holds only untracked files (`scanner-assets/`, `gen/`); move each to the same place under `apps\desktop\src-tauri\` and remove the empty folder.

Task 0's build outputs are still at the root, where nothing will write again and ESLint no longer ignores them. Remove them; `dist-wasm` stays:

```powershell
foreach ($d in "dist","dist-mobile","dist-web","dist-share") { if (Test-Path $d) { cmd /c rmdir /s /q $d } }
```

- [ ] **Step 5: Checkpoint**

```powershell
git add -A
git status --short | Select-String "^R" | Measure-Object | Select-Object -ExpandProperty Count
git commit -m "wip(layout): the move, by script"
```

Expected: about 1,757 renames. A count far below that means git read moves as delete plus add; check that `git add -A` ran from the root.

---

### Task 2: Cargo

**Files:**
- Modify: `Cargo.toml`, `apps/desktop/src-tauri/Cargo.toml`, `apps/light/src-tauri/Cargo.toml`, `crates/grimoire-core/Cargo.toml`, `crates/grimoire-web/Cargo.toml`, `crates/grimoire-scan/Cargo.toml`, `release-please-config.json`, `.gitignore`, `apps/desktop/src-tauri/src/desktop.rs` (the version test near line 1420), `scripts/release-rule.test.mjs`
- Rewrite: `.cargo/config.toml` (`target-dir = "target"`; see Step 3's amendment)

**Interfaces:**
- Produces: workspace members `apps/desktop/src-tauri` and `apps/light/src-tauri`; `[workspace.package]` with `version`, `edition`, `license`; the build tree at `target/`.

- [ ] **Step 1: The root manifest**

In `Cargo.toml` replace the `members` line and add the table under `exclude`:

```toml
members = ["apps/desktop/src-tauri", "crates/grimoire-core", "apps/light/src-tauri", "crates/grimoire-web", "crates/grimoire-scan"]
exclude = ["crates/card-scanner"]

# One version, edition and license for the five members, which inherit each with
# `<key>.workspace = true` (since 2026-10-08). **The version is release-please's to write**:
# `release-please-config.json` bumps `$.workspace.package.version` here, where it used to bump
# four manifests. `crates/card-scanner` is not a member and keeps its own.
[workspace.package]
version = "0.42.0"
edition = "2021"
license = "AGPL-3.0-or-later"
```

`version` must equal `package.json`'s; read it rather than trusting this page. Then replace the header paragraph that begins `**`target/` did not move.**` with:

```toml
# **The build tree is `<root>/target`**, cargo's default for a workspace, since 2026-10-08. Until
# then `.cargo/config.toml` pinned it to `src-tauri/target` so that the workspace conversion moved
# nothing; the layout change moved the desktop host to `apps/desktop/src-tauri` and the pin went
# with it. A debug build keeps `data/` beside its executable, so a checkout's dev database is
# `target/debug/data`.
```

In the remaining comments, `src-tauri` as the desktop host's folder becomes `apps/desktop/src-tauri`, and `src-tauri/target` becomes `target`. The warning about nested worktrees stays true and stays.

- [ ] **Step 2: The five members inherit**

In each member's `[package]` table replace the three literal lines:

```toml
version.workspace = true
edition.workspace = true
license.workspace = true
```

Keep each line where its literal was, so the diff is three lines per file. Leave `name`, `description`, `authors`, `publish` alone.

- [ ] **Step 3: Re-point the pin, fix the ignore**

**Amended during execution.** This step first deleted `.cargo/config.toml`. With it gone, cargo in this worktree walked up to the main checkout's file and answered `D:\Code\mtg-grimoire\src-tauri/target`. The file stays, with `target-dir = "target"` and a comment that says why it is not redundant. In `.gitignore` the script turned `src-tauri/target/` into `target/`. Anchor it: `/target/`. Rewrite the comment above it to say the build tree is the workspace default. `crates/card-scanner/.cargo/config.toml` is untouched.

- [ ] **Step 4: `release-please-config.json`**

`extra-files` becomes exactly:

```json
      "extra-files": [
        { "type": "json", "path": "apps/desktop/src-tauri/tauri.conf.json", "jsonpath": "$.version" },
        { "type": "toml", "path": "Cargo.toml", "jsonpath": "$.workspace.package.version" },
        { "type": "toml", "path": "Cargo.lock", "jsonpath": "$.package[?(@.name.value=='mtg-grimoire')].version" },
        { "type": "toml", "path": "Cargo.lock", "jsonpath": "$.package[?(@.name.value=='grimoire-core')].version" },
        { "type": "json", "path": "apps/light/src-tauri/tauri.conf.json", "jsonpath": "$.version" },
        { "type": "toml", "path": "Cargo.lock", "jsonpath": "$.package[?(@.name.value=='grimoire-light')].version" },
        { "type": "toml", "path": "Cargo.lock", "jsonpath": "$.package[?(@.name.value=='grimoire-web')].version" },
        { "type": "toml", "path": "Cargo.lock", "jsonpath": "$.package[?(@.name.value=='grimoire-scan')].version" }
      ]
```

Keep the file's existing one-key-per-line formatting; the block above shows content, not layout.

- [ ] **Step 5: The Rust fence** (`apps/desktop/src-tauri/src/desktop.rs`, the test whose message names two `Cargo.toml`s)

The list of strings the config must contain becomes:

```rust
        for path in [
            "\"path\":\"Cargo.toml\"",
            "$.workspace.package.version",
            "$.package[?(@.name.value=='mtg-grimoire')].version",
            "$.package[?(@.name.value=='grimoire-core')].version",
        ] {
```

and the assertion message above it, which says the two manifests "must carry the same version", says instead that both inherit `[workspace.package]`'s version in the root `Cargo.toml`. Update the comment `the release tooling is told about both manifests` to `about the workspace's version`.

- [ ] **Step 6: The JavaScript fence** (`scripts/release-rule.test.mjs`)

In the `CRATES` table, `dir: "src-tauri"` becomes `dir: "apps/desktop/src-tauri"` (the script already re-pathed the light host's). Replace the test `"$name wears it, in its manifest and in the lockfile"` with:

```js
  it("the workspace carries it", () => {
    const table = workspaceToml.slice(workspaceToml.indexOf("[workspace.package]")).split(/^\[/m)[1] ?? "";
    expect(/^version = "([^"]+)"$/m.exec(table)?.[1]).toBe(version);
  });

  it.each(CRATES)("$name inherits it, and the lockfile agrees", ({ name, toml }) => {
    const body = toml.slice(toml.indexOf("[package]")).split(/^\[/m)[1] ?? "";
    expect(/^name = "([^"]+)"$/m.exec(body)?.[1]).toBe(name);
    // A literal here is a second version, and release-please no longer writes this file.
    expect(body).toMatch(/^version\.workspace = true$/m);
    expect(body).not.toMatch(/^version = /m);
    expect(lockedVersions(name)).toEqual([version]);
  });
```

and the test `"release-please bumps $name's manifest and its lockfile entry"` with:

```js
  it("release-please bumps the workspace's version, in one manifest", () => {
    expect(names({ type: "toml", path: "Cargo.toml", jsonpath: "$.workspace.package.version" })).toBe(true);
    expect(extra.filter((entry) => /(^|\/)Cargo\.toml$/.test(entry.path))).toHaveLength(1);
  });

  it.each(CRATES)("release-please bumps $name's lockfile entry", ({ name }) => {
    // `@.name.value`, never `@.name`: release-please parses TOML into tagged nodes, and the bare
    // form matches nothing — as a warning, not an error.
    expect(
      names({ type: "toml", path: "Cargo.lock", jsonpath: `$.package[?(@.name.value=='${name}')].version` }),
    ).toBe(true);
  });
```

Delete `packageOf` if nothing else in the file calls it.

- [ ] **Step 7: Find anything else that reads a member's version**

```powershell
git grep -nE "package\.version|version = \"" -- scripts .github apps/desktop/src-tauri/build.rs apps/light/src-tauri/build.rs ":!scripts/core-step-*"
```

Expected: nothing that parses `version = "…"` out of a member manifest. A script that does reads the root's `[workspace.package]` instead.

- [ ] **Step 8: Check**

```powershell
Get-Process cargo,rustc -ErrorAction SilentlyContinue
cargo metadata --format-version 1 --no-deps | node -e "const m=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(m.target_directory);for(const p of m.packages)console.log(p.name,p.version,p.edition,p.license)"
foreach ($d in "apps\desktop\dist","apps\light\dist-mobile") {
  New-Item -ItemType Directory -Force $d | Out-Null
  if (-not (Test-Path "$d\index.html")) { "<!doctype html><title>stub</title>" | Set-Content "$d\index.html" }
}
cargo check --workspace --locked
```

Expected: the target directory ends in `\target`; five packages, each `0.42.0 2021 AGPL-3.0-or-later`; `cargo check` finishes. It runs both hosts' `tauri-build`, which is the first proof that Tauri accepts a version inherited from the workspace (the CLI's is `tauri dev` in Task 7). **If `tauri-build` refuses the manifest, stop and tell the controller**: the spec has the owner decide. `scripts/release-rule.test.mjs` is run in Task 5, once Vitest has a config again. `--locked` failing means `Cargo.lock` wants a change: run once without it, and confirm `git diff --stat Cargo.lock` is empty or explain it.

- [ ] **Step 9: Checkpoint** (controller)

```powershell
git add -A; git commit -m "wip(layout): cargo"
```

---

### Task 3: Vite, Tailwind, TypeScript and the npm scripts

**Files:**
- Create: `vite.base.ts`, `vitest.config.ts`, `apps/desktop/src/desktop.css`, `scripts/vite-base.test.mjs`
- Modify: `apps/desktop/vite.config.ts`, `apps/light/vite.config.ts`, `apps/light/vite.sw.ts`, `apps/share/vite.config.ts`, `vite.watch.ts`, `apps/desktop/src/main.tsx`, `apps/light/index.html`, `apps/share/index.html`, `packages/ui/index.css`, `.storybook/preview.css`, `tsconfig.json`, `.storybook/tsconfig.json`, `infrastructure/{relay,share-worker,app-worker}/tsconfig.json`, `packages/ui/tsconfig.web-worker.json`, `packages/ui/tsconfig.web-sw.json`, `packages/ui/components.json`, `eslint.config.js`, `.storybook/main.ts`, `package.json`, the two `tauri.conf.json`s if a check below says so

**Interfaces:**
- Produces: `vite.base.ts` default-exports a Vite config and exports `REPO: string` (the repository root, with a trailing separator) and `UI: string` (`<REPO>packages/ui`). Vitest's root is the repository root. Each app's Vite root is its own folder.

- [ ] **Step 1: Write the failing fence**, `scripts/vite-base.test.mjs`

```js
// What every Vite program in the repository shares, held where a build cannot see it break:
// with an app's `root` in `apps/<name>`, the shared UI is outside it, and the dev server
// answers 403 for a file outside `server.fs.allow`. A build and this suite never ask the dev
// server for anything, so `tauri dev` opening on a blank window would be the first report.
import { describe, expect, it } from "vitest";
import base, { REPO, UI } from "../vite.base.ts";

const slashes = (p) => p.replaceAll("\\", "/").replace(/\/$/, "");

describe("vite.base.ts", () => {
  it("lets the dev server read the whole repository", () => {
    expect(base.server.fs.allow.map(slashes)).toContain(slashes(REPO));
  });

  it("points `@` at the shared UI", () => {
    expect(slashes(UI)).toBe(`${slashes(REPO)}/packages/ui`);
    expect(slashes(base.resolve.alias["@"])).toBe(slashes(UI));
  });

  it("reads .env files from the repository root, wherever an app's root is", () => {
    expect(slashes(base.envDir)).toBe(slashes(REPO));
  });
});
```

Run `npx vitest run scripts/vite-base.test.mjs`. Expected: FAIL, `vite.base.ts` does not exist. (Vitest still reads its settings from nowhere at this point, so the run may fail earlier on a missing config; either failure is the red.)

- [ ] **Step 2: `vite.base.ts`** — today's `apps/desktop/vite.config.ts` without its `test` block

```ts
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
// Ships one format of the icon fonts instead of five — worth ~5 MB of the bundle. Both the
// rewrite and its `id` filter live in the shared UI so the test suite covers them; see
// `packages/ui/lib/iconFont.ts` for why, and `iconFont.test.ts` for the guarantee that it
// leaves every glyph class alone.
import { woff2IconFonts } from "./packages/ui/lib/iconFont.ts";
import { WATCH_IGNORED } from "./vite.watch.ts";

/** The repository root: where `node_modules`, the lockfile and any `.env` file are. */
export const REPO = fileURLToPath(new URL("./", import.meta.url));
/** What `@/*` means, as `tsconfig.json`'s `paths` and `components.json`'s aliases say. */
export const UI = fileURLToPath(new URL("./packages/ui", import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// What the three apps' configs and `vitest.config.ts` are merged over. It sets no `root`: each
// app's config names its own folder, and Vitest's is the repository.
export default defineConfig({
  plugins: [woff2IconFonts(), react(), tailwindcss()],

  resolve: {
    alias: { "@": UI },
  },

  // An app's root is `apps/<name>`, and Vite looks for `.env` files in the root unless told.
  envDir: REPO,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching the cargo hosts — and every other build output under the
      //    repository, where a watch on a file cargo is still writing kills the server on
      //    Windows. `vite.watch.ts` holds the list and the measurement.
      ignored: WATCH_IGNORED,
    },
    // 4. The shared UI is outside every app's root. Without this the dev server answers 403 for
    //    each of its files and the window is blank; a build never asks. `scripts/vite-base.test.mjs`.
    fs: { allow: [REPO] },
  },
});
```

The old file held exactly `plugins`, `resolve`, `clearScreen`, `server` and `test`; `envDir` and `server.fs` are the two additions.

- [ ] **Step 3: `apps/desktop/vite.config.ts`**, in full

```ts
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "../../vite.base.ts";

// The desktop app's page: `index.html` and `src/main.tsx` here, everything else from the shared
// UI. `root` is this folder whatever the working directory, so `dist/` lands beside it — where
// `src-tauri/tauri.conf.json`'s `frontendDist: "../dist"` reads it.
export default mergeConfig(
  base,
  defineConfig({ root: fileURLToPath(new URL("./", import.meta.url)) }),
);
```

- [ ] **Step 4: `vitest.config.ts`**, in full — the `test` block that was in `vite.config.ts`, re-pathed

```ts
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vite.base.ts";

// The one test program: every package's tests, from the repository root, over the plugins and
// the alias the apps build with. It lived in `vite.config.ts` until 2026-10-08, when that file
// became the desktop app's and moved into it.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./packages/ui/test-setup.ts"],
      testTimeout: 15_000,
      // ⚠️ A directory this list does not name is collected by **nothing**, and `vitest run
      // <that folder>` answers `No test files found` — which prints on stdout and is easy to
      // read as a pass.
      include: [
        "packages/ui/**/*.test.{ts,tsx}",
        "packages/fake/**/*.test.ts",
        "apps/desktop/src/**/*.test.{ts,tsx}",
        "apps/light/**/*.test.{ts,tsx}",
        "apps/share/**/*.test.{ts,tsx}",
        ".storybook/**/*.test.ts",
        "infrastructure/relay/src/**/*.test.ts",
        "infrastructure/share-worker/src/**/*.test.ts",
        "infrastructure/app-worker/src/**/*.test.ts",
        "scripts/**/*.test.mjs",
      ],
      css: true,
      coverage: {
        provider: "v8",
        reporter: ["text", "json-summary"],
        include: ["packages/ui/**/*.{ts,tsx}", "apps/desktop/src/**/*.{ts,tsx}"],
        exclude: [
          "**/*.test.{ts,tsx}",
          "packages/ui/test-setup.ts",
          "packages/ui/test-drag.ts",
          "**/*.stories.tsx",
          "packages/ui/vite-env.d.ts",
          "apps/desktop/src/main.tsx",
          "packages/ui/lib/core/web/worker.ts",
          "packages/ui/lib/core/web/grimoire_web.d.ts",
          "packages/ui/lib/core/web/sw/sw.ts",
          ".claude/**/*",
        ],
      },
    },
  }),
);
```

Move the long comments that sat on each `include` entry in the old file onto the matching entry here, re-pathed. Then delete the `test` block, and the `vitest/config` import, from what is now `apps/desktop/vite.config.ts` (Step 3 replaces that file whole).

- [ ] **Step 5: `apps/share/vite.config.ts`**

Change the import to `import base from "../../vite.base.ts";`, add `root: fileURLToPath(new URL("./", import.meta.url)),` (with the `node:url` import) as the first key of the `defineConfig`, and change `input: "share/index.html"` to `input: "index.html"`. `outDir: "dist-share"` is unchanged and now lands in `apps/share/`.

`apps/share/index.html`: the script becomes `src="/main.tsx"`. Its dev-only `<link id="snapshot" href="/src-tauri/src/share/__golden__/snapshot.json">` names a file outside the root, which a dev server serves only under `/@fs/`. Make the `href` `"%GOLDEN_SNAPSHOT%"` and add this plugin to the config's `plugins`, beside `dropDevShell()`:

```ts
/** The dev shell's snapshot is the Rust golden, which is outside this root: `/@fs/` reaches it. */
function goldenSnapshot() {
  const golden = fileURLToPath(
    new URL("../desktop/src-tauri/src/share/__golden__/snapshot.json", import.meta.url),
  );
  return {
    name: "share:golden-snapshot",
    transformIndexHtml: (html: string) =>
      html.replace("%GOLDEN_SNAPSHOT%", `/@fs/${golden.replaceAll("\\", "/")}`),
  };
}
```

- [ ] **Step 6: `apps/light/vite.config.ts` and `apps/light/vite.sw.ts`**

Every path in these two files was relative to the repository root and is now relative to `apps/light`. The complete list for the config:

| Was | Becomes |
| --- | --- |
| `import base from "./vite.config.ts"` | `"../../vite.base.ts"` |
| `"./.storybook/fake/aliases.ts"` | `"../../packages/fake/aliases.ts"` |
| `"./app-worker/src/headers.ts"` | `"../../infrastructure/app-worker/src/headers.ts"` |
| `"./src/lib/core/web/assets.ts"`, `"./src/lib/core/web/scanStore.ts"` | `"../../packages/ui/lib/core/web/…"` |
| `"./vite.sw.ts"` | unchanged |
| `const ENTRY = "mobile/index.html"` | `"index.html"` |
| `new URL("./mobile/public/", …)` | `new URL("./public/", …)` |
| `new URL("./dist-wasm/", …)` | `new URL("../../dist-wasm/", …)` |
| `new URL("./crates/card-scanner/src/index.rs", …)` | `new URL("../../crates/card-scanner/src/index.rs", …)` |
| `new URL("./app-worker/_headers", …)` | `new URL("../../infrastructure/app-worker/_headers", …)` |
| `new URL("./dist-web", …)` | unchanged |
| `serviceWorker("dist-web")` | `serviceWorker("apps/light/dist-web")` |

Add `root: fileURLToPath(new URL("./", import.meta.url)),` to the object the config merges over `base`, beside `publicDir`. In `vite.sw.ts`: the import becomes `"../../packages/ui/lib/core/web/sw/shell.ts"`, `ROOT` becomes `fileURLToPath(new URL("../../", import.meta.url))` (still the repository root, as its comment says), and `ENTRY` becomes `"packages/ui/lib/core/web/sw/sw.ts"`. Comments in both files take the new root-relative paths.

`apps/light/index.html`: the script becomes `src="/main.tsx"`.

- [ ] **Step 7: The stylesheets**

`packages/ui/index.css` — the script left `@source ".";` and `@source "../../apps/desktop/index.html";`. Make them:

```css
@import "tailwindcss" source(none);
@source "./";
```

and delete the `index.html` line. Re-path the comment near line 300 that mentions the narrowing.

`apps/desktop/src/desktop.css`, new:

```css
/* The desktop app's stylesheet: the shared one, and this app's own Tailwind sources.

   `packages/ui/index.css` opens with `@import "tailwindcss" source(none)` and names its own
   folder, so nothing outside it is scanned unless a `@source` says so — the pattern
   `apps/light/mobile.css` and `apps/share/share.css` follow. Without the two lines below a class
   written only in `index.html` or in this folder emits no rule, and nothing fails. */
@import "../../../packages/ui/index.css";
@source "../index.html";
@source "./";
```

`apps/desktop/src/main.tsx`: `import "@/index.css";` becomes `import "./desktop.css";`.

`.storybook/preview.css`: after `@source "../apps/light";` add

```css
@source "../apps/desktop/src";
@source "../packages/fake";
```

The fake was inside `.storybook/` and was scanned by `@source "../.storybook"`; it no longer is. Update the comment above the list to name all four.

- [ ] **Step 8: TypeScript**

Root `tsconfig.json` — after the script, set these four keys and re-path the comments around them:

```jsonc
    "paths": {
      "@/*": ["./packages/ui/*"]
    },
```

```jsonc
  "include": ["packages/ui", "apps/desktop/src", "apps/share", "apps/light"],
  "exclude": [
    ".claude",
    // Each app's Vite config is a Node program and this one has no Node types. They were at the
    // root, outside `include`, until the configs moved into the apps.
    "apps/*/vite.config.ts",
    "apps/light/vite.sw.ts",
    "apps/light/src-tauri",
    "packages/ui/lib/core/web/worker.ts",
    "packages/ui/lib/core/web/scanWorker.ts",
    "packages/ui/lib/core/web/sw/sw.ts"
  ],
  "references": [{ "path": "./apps/desktop/tsconfig.node.json" }]
```

`.storybook/tsconfig.json`: `"include": ["**/*", "../packages/fake/**/*"]`.

The five moved configs, whose `include` is relative to the file:

| File | `include` |
| --- | --- |
| `infrastructure/relay/tsconfig.json` | `["src"]` |
| `infrastructure/share-worker/tsconfig.json` | `["src", "../relay/src/token.ts", "../relay/src/fakeD1.ts"]` |
| `infrastructure/app-worker/tsconfig.json` | `["src"]` |
| `packages/ui/tsconfig.web-worker.json` | `["lib/core/web/worker.ts", "lib/core/web/scanWorker.ts"]` |
| `packages/ui/tsconfig.web-sw.json` | `["lib/core/web/sw/sw.ts"]` |

`apps/desktop/tsconfig.node.json` keeps `["vite.config.ts"]`. In all six, comments take new root-relative paths, and any other relative path (an `extends`, a `paths` entry, a `tsBuildInfoFile`) is re-pointed from the file's new folder. `packages/ui/components.json`: `"css": "index.css"`.

- [ ] **Step 9: `eslint.config.js`, `.storybook/main.ts`, `vite.watch.ts`**

`eslint.config.js` ignores: `"dist/"` becomes `"apps/desktop/dist/"`; add `"target/"` and `"apps/light/src-tauri/"` if the list does not already cover them; confirm the script re-pathed the rest (`apps/desktop/src-tauri/`, `apps/light/dist-web/`, `apps/light/dist-mobile/`, `apps/share/dist-share/`).

`.storybook/main.ts`: add `"../apps/desktop/src/**/*.stories.tsx"` to `stories`, and confirm the script left `{ find: /^@\//, replacement: fileURLToPath(new URL("../packages/ui/", import.meta.url)) }` and `staticDirs` pointing at `../apps/desktop/public`.

`vite.watch.ts`: add `"**/target/**"` to `WATCH_IGNORED` beside `"**/src-tauri/**"`, and say in the comment that the workspace's build tree is at the root since 2026-10-08.

- [ ] **Step 10: `package.json` scripts** — names unchanged, these values

```json
    "dev": "vite --config apps/desktop/vite.config.ts",
    "build": "tsc && tsc -p .storybook && tsc -p infrastructure/relay && tsc -p infrastructure/share-worker && tsc -p infrastructure/app-worker && tsc -p packages/ui/tsconfig.web-worker.json && tsc -p packages/ui/tsconfig.web-sw.json && vite build --config apps/desktop/vite.config.ts",
    "preview": "vite preview --config apps/desktop/vite.config.ts",
    "tauri": "cd apps/desktop && tauri",
    "share:dev": "vite --config apps/share/vite.config.ts",
    "share:build": "tsc && vite build --config apps/share/vite.config.ts",
    "mobile:dev": "vite --config apps/light/vite.config.ts --mode fake",
    "mobile:serve": "vite --config apps/light/vite.config.ts",
    "mobile:tauri": "cd apps/desktop && tauri dev --config src-tauri/tauri.light.conf.json",
    "mobile:build": "tsc && vite build --config apps/light/vite.config.ts",
    "tauri:light": "cd apps/light && tauri",
    "web:dev": "vite --config apps/light/vite.config.ts --mode web",
    "web:build": "tsc && tsc -p packages/ui/tsconfig.web-worker.json && tsc -p packages/ui/tsconfig.web-sw.json && vite build --config apps/light/vite.config.ts --mode web",
    "web:preview": "vite preview --config apps/light/vite.config.ts --mode web",
    "verify": "npm run build && vite build --config apps/light/vite.config.ts && npm run lint && npm run lint:rust && npm run test:run && cargo test --workspace && cargo test --manifest-path crates/card-scanner/Cargo.toml --target-dir crates/card-scanner/target --features cli"
```

Every other script is unchanged. `test` and `test:run` find `vitest.config.ts` at the root by themselves.

- [ ] **Step 11: Check**

```powershell
npx vitest run scripts/vite-base.test.mjs
npm run build
npx vite build --config apps/light/vite.config.ts
npm run web:build
npm run share:build
npm run build-storybook
Test-Path apps\desktop\dist\index.html, apps\light\dist-mobile\index.html, apps\light\dist-web\index.html, apps\share\dist-share\assets\share.js, dist, dist-web
```

Expected: the fence passes; every build finishes; the last line reads `True True True True False False`. A `tsc` error naming `node:` in an app's `vite.config.ts` means Step 8's `exclude` is not matching.

- [ ] **Step 12: The dev server serves the shared UI**

Port 1420 is the app's, so this takes the `app` lock (the `running-the-app` skill). `node` is started directly, never through `npx`: stopping a wrapper leaves Vite running on the port.

```powershell
$L = ".claude\skills\running-the-app\lock.ps1"
pwsh -NoProfile -File $L acquire app -Wait -What "layout stage 1: dev server check"
$dev = Start-Process node -ArgumentList "node_modules/vite/bin/vite.js","--config","apps/desktop/vite.config.ts" -PassThru -WindowStyle Hidden
pwsh -NoProfile -File $L adopt app -ProcessId $dev.Id
Start-Sleep 6
(Invoke-WebRequest "http://localhost:1420/src/main.tsx" -UseBasicParsing).StatusCode
$ui = (Resolve-Path packages\ui\App.tsx).Path.Replace("\","/")
(Invoke-WebRequest "http://localhost:1420/@fs/$ui" -UseBasicParsing).StatusCode
Stop-Process -Id $dev.Id -Force
pwsh -NoProfile -File $L release app
```

Expected: `200` twice. A 403 on the second is Review Focus 1. Never stop a Vite that is not `$dev`.

Checkpoint (controller): `git add -A; git commit -m "wip(layout): vite, tailwind, typescript, scripts"`.

---

### Task 4: Sweeps, and what the script could not decide

**Files:**
- Modify: twelve of the thirteen test files the census names (the thirteenth, `scripts/ci-route.test.mjs`, is Task 5's); `infrastructure/app-worker/src/hosting.test.ts`; `scripts/web-smoke/sync-harness.mjs`, `scripts/web-sync-smoke.mjs`, `scripts/phone-scanner-smoke.mjs`, `scripts/pairing-scan-smoke.mjs`; `packages/ui/features/share/readOnly.test.ts`

**Interfaces:**
- Consumes: Task 3's Vitest root (the repository) and globs.

- [ ] **Step 1: See what each sweep lost**

```powershell
node "<scratch>\layout-move.mjs" . --census "<scratch>\census-after.json"
node "<scratch>\layout-move.mjs" . --census-diff "<scratch>\census-before.json" "<scratch>\census-after.json"
```

Expected: `13 sweeps differ`. Twelve lost the six files now in `apps/desktop/src/`; `scripts/ci-route.test.mjs` also lost the eight `packages/fake/*.test.ts`.

- [ ] **Step 2: Give each sweep the desktop's folder**

In each of these, wherever a glob names `/packages/ui/**`, add the same glob over `/apps/desktop/src/**` beside it. A single string becomes an array, which `import.meta.glob` accepts:

`apps/light/phone/fence.test.ts`, `apps/share/SharePage.test.tsx`, `packages/ui/components/AppShell.test.tsx`, `packages/ui/features/decks/DeckNotesPanel.test.tsx`, `packages/ui/features/settings/nav.test.ts`, `packages/ui/lib/dndManager.test.ts`, `packages/ui/lib/keyboardModality.test.ts`, `packages/ui/lib/layers.test.ts`, `packages/ui/lib/motion.test.ts`, `packages/ui/lib/tokens.test.ts`, `packages/ui/lib/touchTargets.test.ts`, `packages/ui/stories.test.tsx`.

```ts
// before
const FILES = import.meta.glob("/packages/ui/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
// after
const FILES = import.meta.glob(["/packages/ui/**/*.{ts,tsx}", "/apps/desktop/src/**/*.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});
```

Then read how each test uses the keys. One that strips a `/packages/ui/` prefix, or tests `key.startsWith("/packages/ui/")`, must treat `/apps/desktop/src/` the same way, or the six files are matched and then skipped.

- [ ] **Step 3: Confirm**

```powershell
node "<scratch>\layout-move.mjs" . --census "<scratch>\census-after.json"
node "<scratch>\layout-move.mjs" . --census-diff "<scratch>\census-before.json" "<scratch>\census-after.json"
```

Expected: `1 sweeps differ`, and the one is `scripts/ci-route.test.mjs`, which Task 5 closes.

- [ ] **Step 4: The literals the script left**

| File | What | Becomes |
| --- | --- | --- |
| `infrastructure/app-worker/src/hosting.test.ts` | the expected `assets.directory`, `"../dist-web"` | `"../../apps/light/dist-web"` |
| same | `"!/app-worker/.wrangler/**"`, `"!/app-worker/node_modules/**"` | `"!/infrastructure/app-worker/…"` |
| `scripts/web-smoke/sync-harness.mjs` | `relay/.wrangler/…` (three) | `infrastructure/relay/.wrangler/…` |
| same, and `scripts/web-sync-smoke.mjs` | `app-worker/node_modules/wrangler/…` | `infrastructure/app-worker/node_modules/wrangler/…` |
| `packages/ui/features/share/readOnly.test.ts` | `from.startsWith("share/")` | read the test: if `from` is a root-relative module path it is `"apps/share/"`; if it is a path inside the feature folder it stays |

The two phone smoke scripts open the light app's dev server by URL. With the root at `apps/light`, the page that was `/mobile/index.html` is `/index.html`, and the script rewrote those literals to `/apps/light/index.html`. Set each back to the path under the new root, and re-read any other `/apps/light/…` URL in them the same way.

- [ ] **Step 5: The rest of the script's report**

```powershell
node "<scratch>\layout-move.mjs" . --stale
```

Expected: old paths only in files Tasks 2, 3, 5 and 6 own. Fix any in a test or a script under `apps/`, `packages/`, `infrastructure/` or `scripts/` (other than `ci-route*` and the workflow fences).

- [ ] **Step 6: The same tests are collected, and pass**

```powershell
npx vitest list --json | Set-Content -Encoding utf8 "<scratch>\vitest-after.json"
node -e "const f=p=>{const t=JSON.parse(require('fs').readFileSync(p,'utf8'));return new Set(t.map(x=>x.file)).size+' files, '+t.length+' tests'};console.log('before',f(process.argv[1]));console.log('after ',f(process.argv[2]))" "<scratch>\vitest-before.json" "<scratch>\vitest-after.json"
npx vitest run --shard=1/4
npx vitest run --shard=2/4
npx vitest run --shard=3/4
npx vitest run --shard=4/4
```

Expected: the file counts are equal plus one (`scripts/vite-base.test.mjs`); the test counts are equal plus three. Four shards, because one long run is killed at about ten minutes. Failures in `scripts/ci-route.test.mjs`, `release-rule`, `workflow-scripts`, `toolchain` and `actions-pinned` are Task 5's; report them and fix nothing there. Every other failure is this task's.

Checkpoint (controller): `git add -A; git commit -m "wip(layout): sweeps and leftovers"`.

---

### Task 5: CI and its fences

**Files:**
- Modify: `scripts/ci-route.mjs`, `scripts/ci-route.test.mjs`, `.github/workflows/ci.yml`, `release.yml`, `android-emulator.yml`, `scanner-bundle.yml`, `scripts/release-rule.test.mjs` (the deploy pins), `scripts/workflow-scripts.test.mjs`, `.github/CLAUDE.md`, `apps/light/src-tauri/gen/android/buildSrc/src/main/java/com/mtggrimoire/app/kotlin/BuildTask.kt` (its comment), `apps/light/host.test.ts` if it quotes that comment

- [ ] **Step 1: Write the failing fence** — a new `describe` at the foot of `scripts/workflow-scripts.test.mjs`

```js
// `release.yml` runs on a release and nowhere else, so a step that names a folder a move took
// away is found by the release. Every `working-directory:` and every `--prefix` is held to a
// folder that exists. (A stale folder left on a developer's disk passes here; CI's checkout is
// clean, and CI is where this is read.)
describe("the folders a workflow steps into", () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const texts = import.meta.glob("/.github/workflows/*.yml", { query: "?raw", import: "default", eager: true });

  it("all exist", () => {
    const missing = [];
    for (const [file, text] of Object.entries(texts))
      for (const [, dir] of text.matchAll(/(?:working-directory:|--prefix)\s+["']?([\w./-]+)/g))
        if (!existsSync(repo + dir)) missing.push(`${file}: ${dir}`);
    expect(Object.keys(texts).length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
```

with `import { existsSync } from "node:fs";` and `import { fileURLToPath } from "node:url";` added to the file's imports if it lacks them. Run `npx vitest run scripts/workflow-scripts.test.mjs`. Expected: FAIL, listing `mobile` and `app-worker`.

- [ ] **Step 2: The workflows**

The script re-pathed every path with a slash. What it could not see is a bare folder name. Change each:

| File | Was | Becomes |
| --- | --- | --- |
| `ci.yml`, `release.yml`, `android-emulator.yml` | `working-directory: mobile` | `working-directory: apps/light` |
| `release.yml` (two) | `working-directory: app-worker` | `working-directory: infrastructure/app-worker` |
| `ci.yml` | `npm ci --ignore-scripts --prefix app-worker` | `--prefix infrastructure/app-worker` |
| `ci.yml` | `mkdir -p dist dist-mobile` and the two `echo … >` lines | `mkdir -p apps/desktop/dist apps/light/dist-mobile`, writing `apps/desktop/dist/index.html` and `apps/light/dist-mobile/index.html` |
| all | `workspaces: ". -> src-tauri/target"` | confirm the script left `". -> target"` |

Then read all four files top to bottom once, with these questions for every path: does it exist now; is it relative to the repository root or to a `working-directory`; does a comment beside it still tell the truth. Comments that explain `--target-dir` "since the workspace" stay true for `crates/card-scanner` and stay.

```powershell
git grep -nE "(working-directory:|--prefix|cd|--manifest-path|-C)\s+['\"]?(src-tauri|mobile|share|relay|share-worker|app-worker|src)\b" -- .github scripts package.json
git grep -nE "(^|[^/\w-])(dist|dist-mobile|dist-web|dist-share)/" -- .github
```

Expected: no output from the first. Every line of the second names `apps/…/dist…` or is a comment that is still true.

- [ ] **Step 3: The deploy pins** (`scripts/release-rule.test.mjs`)

The two expectations `toMatch(/^ {8}working-directory: app-worker$/m)` become `…working-directory: infrastructure\/app-worker$/m`, and the test title `"runs wrangler once: `web-deploy`, the lockfile's, from app-worker/"` names `infrastructure/app-worker/`. The pinned step name `Install wrangler from app-worker's lockfile` stays as the workflow spells it. No command in the allowed list changes.

- [ ] **Step 4: The router** (`scripts/ci-route.mjs`)

**First match wins**, so a file that moved under a folder with an arm of its own must have its arm above that folder's. After the script, fix the order and add the arms the new files need, so that the list contains, in this relative order:

```js
  { match: ["apps/desktop/src-tauri/*"], jobs: RUST_SIDE },
  // … the golden and table arms, re-pathed, unchanged in jobs …
  { match: ["apps/light/src-tauri/*"], jobs: ["frontend", "rust", "android"] },
  // The light app's Vite config: above `apps/light/*`, which would route it as a page file and
  // lose `rust` and `android`. It was a root file, `vite.mobile.config.ts`, until 2026-10-08.
  { match: ["apps/light/vite.config.ts"], jobs: ["frontend", "rust", "android", "web"] },
  { match: ["apps/light/vite.sw.ts"], jobs: ["frontend", "web"] },
  { match: ["apps/light/*"], jobs: PAGE_SIDE },
  { match: ["apps/desktop/index.html"], jobs: ["frontend", "storybook"] },
  { match: ["packages/ui/*", "apps/desktop/*"], jobs: PAGE_SIDE },
  { match: ["packages/fake/aliases.ts"], jobs: PAGE_SIDE },
  { match: ["packages/fake/*", ".storybook/*"], jobs: ["frontend", "storybook"] },
  // …
  { match: ["tsconfig*.json", "vite.base.ts", "vite.watch.ts", "vitest.config.ts"], jobs: PAGE_SIDE },
```

`apps/desktop/*` sits below `apps/desktop/src-tauri/*` and `apps/desktop/index.html`, so it catches `src/`, `public/`, `vite.config.ts` and `tsconfig.node.json`. `infrastructure/app-worker/*` and `infrastructure/relay/*` keep the jobs `app-worker/*` and `relay/*` had. `apps/share/*` and `infrastructure/share-worker/*` get no arm, as `share/*` and `share-worker/*` had none: they fall through to the fail-safe. Re-path each arm's comment and keep its reasoning.

- [ ] **Step 5: The router's test, and the Android comment**

```powershell
npx vitest run scripts/ci-route.test.mjs scripts/release-rule.test.mjs scripts/workflow-scripts.test.mjs scripts/toolchain.test.mjs scripts/actions-pinned.test.mjs
```

First, in `scripts/ci-route.test.mjs`: beside the frontend test globs add `/apps/desktop/src/**/*.test.{ts,tsx}` and `/packages/fake/**/*.test.ts`, which the move took out from under `/packages/ui/**` and `/.storybook/**`; and the router input `"public/favicon.svg"` becomes `"apps/desktop/public/favicon.svg"`. Then:

```powershell
node "<scratch>\layout-move.mjs" . --census "<scratch>\census-after.json"
node "<scratch>\layout-move.mjs" . --census-diff "<scratch>\census-before.json" "<scratch>\census-after.json"
```

Expected: `every sweep matches what it matched`, and the five test files PASS. `ci-route.test.mjs` derives what each job reads from the sources; where it fails, it is naming a file a job reads that no arm routes to that job, and the fix is an arm, not an exemption. Its example inputs were re-pathed by the script; where an example asserted the old root-file routing of `vite.mobile.config.ts`, it now asserts `apps/light/vite.config.ts`.

`BuildTask.kt`'s hand-edit comment says the script is `cd mobile && tauri`; it is `cd apps/light && tauri`. `rootDirRel` and the arguments are unchanged: the Gradle project still sits three folders below its host. If `apps/light/host.test.ts` quotes the comment, quote the new one.

- [ ] **Step 6: Break each fence once**

```powershell
$yml = (Resolve-Path .github\workflows\release.yml).Path
$good = [IO.File]::ReadAllText($yml)
[IO.File]::WriteAllText($yml, $good.Replace("working-directory: infrastructure/app-worker", "working-directory: app-worker"))
npx vitest run scripts/release-rule.test.mjs scripts/workflow-scripts.test.mjs
[IO.File]::WriteAllText($yml, $good)
```

Expected: both files FAIL while the line is wrong. **Never restore with `git checkout`**: this task's edits to the file are not committed yet, and a checkout would discard them. Then, the same way — keep the text, break it, run, write it back — delete the `apps/light/vite.config.ts` arm from `ci-route.mjs`, run `npx vitest run scripts/ci-route.test.mjs` and expect FAIL. A fence that stays green when its property is broken is reported, not left.

- [ ] **Step 7: `.github/CLAUDE.md`**

Re-path every arm it lists to match Step 4, the `Swatinem/rust-cache` line (`". -> target"`, cargo's default), the stub line (`apps/desktop/dist/index.html`), and `wrangler … from infrastructure/app-worker/package-lock.json`. `node scripts/check-claude-md.mjs` must pass.

Checkpoint (controller): `git add -A; git commit -m "wip(layout): ci and its fences"`.

---

### Task 6: Docs

**Files:**
- Create: `docs/reference/repository-layout.md`
- Modify: `CLAUDE.md`, `README.md`, every moved `CLAUDE.md` and README (not `.github/CLAUDE.md`, which is Task 5's), `docs/agent/*.md`, `docs/reference/*.md`, `docs/play/*`, `docs/scanner/*`, `.claude/skills/**`, `logos/README.md`

The script rewrote about 930 path tokens in `docs/` and re-pointed its relative links. This task is what a script cannot do: sentences that are now false.

- [ ] **Step 1: `docs/reference/repository-layout.md`**

```markdown
# Repository layout

Since 2026-10-08 the root holds four code folders, one per kind of thing. The design and its
reasons: [the spec](../superpowers/specs/2026-10-08-repository-layout-and-workspace-design.md).

| Folder | Holds |
| --- | --- |
| `apps/desktop/` | The desktop app: `src-tauri/` (the Rust host), `index.html`, and the three modules only it runs (`src/main.tsx`, `DesktopBoot`, `StartupScreen`). |
| `apps/light/` | The light app, one frontend for two hosts: Android (`src-tauri/`) and the web (the WASM modules in `crates/`, hosted by `infrastructure/app-worker/`). |
| `apps/share/` | The public viewer page the share Worker serves. |
| `packages/ui/` | The shared frontend: `components/`, `features/`, `lib/`. `@/` means this folder. All three apps are built from it. |
| `packages/fake/` | The engine faked in TypeScript, for Storybook, the tests and the light app's `--mode fake`. |
| `crates/` | The shared Rust: `grimoire-core` (the engine), `card-scanner`, and the web host's two modules, `grimoire-web` and `grimoire-scan`. |
| `infrastructure/` | The three Cloudflare Workers: `relay/`, `share-worker/`, `app-worker/`. |

**Build outputs** sit in the app that makes them — `apps/desktop/dist/`, `apps/light/dist-web/`,
`apps/light/dist-mobile/`, `apps/share/dist-share/` — except two that cargo makes or feeds:
`target/` and `dist-wasm/`, at the root. A debug build's data is `target/debug/data/`.

## Where things were

Plans and specs under `docs/superpowers/` and the changelog are dated records and were not
rewritten. A path in one of them reads through this table.

| Until 2026-10-08 | Since |
| --- | --- |
| `src/` | `packages/ui/` |
| `src/main.tsx`, `src/boot/DesktopBoot.*`, `src/boot/StartupScreen.*` | `apps/desktop/src/` |
| `src-tauri/` | `apps/desktop/src-tauri/` |
| `src-tauri/target/` | `target/` |
| `mobile/` | `apps/light/` |
| `share/` | `apps/share/` |
| `.storybook/fake/` | `packages/fake/` |
| `relay/`, `share-worker/`, `app-worker/` | `infrastructure/<name>/` |
| `index.html`, `public/`, `vite.config.ts` | `apps/desktop/` |
| `vite.mobile.config.ts`, `vite.sw.ts` | `apps/light/vite.config.ts`, `apps/light/vite.sw.ts` |
| `vite.share.config.ts` | `apps/share/vite.config.ts` |
| the `test` block of `vite.config.ts` | `vitest.config.ts` |
| `tsconfig.relay.json`, `tsconfig.share-worker.json`, `tsconfig.app-worker.json` | `infrastructure/<name>/tsconfig.json` |
| `tsconfig.web-worker.json`, `tsconfig.web-sw.json`, `components.json` | `packages/ui/` |
| `dist/`, `dist-mobile/`, `dist-web/`, `dist-share/` | under the app that builds each |
```

Add a row for it to the table in `docs/reference/README.md`, in that table's style.

- [ ] **Step 2: The root `CLAUDE.md`**

- The opening lines and **Architecture & Responsibilities** name the new folders: `apps/desktop/src-tauri` is the desktop application, `packages/ui/lib/ipc.ts` and `ipc.test.ts` are the mirror and its fence.
- **Primary Commands**: the `cargo test --workspace` line lists the members by their new paths.
- **Area-Specific Guides**: every row's link and label, re-pathed (the script did the links; read the labels). Add `docs/reference/repository-layout.md` under Reference Docs.
- **Global Rules**: "`data/` is strictly local" stays; nothing else names a path.
- It must stay under 200 lines.

- [ ] **Step 3: The sentences the script left for a person**

```powershell
node "<scratch>\layout-move.mjs" . --stale
git grep -nE "(^|[^/\w.-])vite\.config\.ts" -- "*.md" "*.ts" "*.tsx" "*.mjs" ":!docs/superpowers" ":!CHANGELOG.md"
git grep -nE "(^|[^/\w.-])index\.html" -- "*.md" ":!docs/superpowers" ":!CHANGELOG.md"
git grep -nE "(^|[^/\w.@-])dist/" -- "*.md" ":!docs/superpowers" ":!CHANGELOG.md"
git grep -nE "\bsrc-tauri\b(?!/)" -P -- "*.md" ".claude" ":!docs/superpowers" ":!CHANGELOG.md"
```

For each hit decide what it means now:
- `vite.config.ts` — the desktop's build config (`apps/desktop/vite.config.ts`), the shared base (`vite.base.ts`), or the test settings (`vitest.config.ts`).
- `index.html` — `apps/desktop/index.html`, `apps/light/index.html`, or an output's.
- `dist/` — `apps/desktop/dist/`, or a generic word that stays.
- bare `src-tauri` — where the sentence means the desktop host's folder at the root, say `apps/desktop/src-tauri`; where it means "a Tauri host" it stays.

- [ ] **Step 4: What is now false, by topic**

Read and correct each of these, wherever the docs, the skills and the READMEs say it:
- **The build tree and the dev database.** `src-tauri/target/debug/data` is `target/debug/data`. `.claude/skills/worktree-setup/SKILL.md` and `live-data.md`, `.claude/skills/running-the-app/*.md`, `docs/agent/RUNNING_AND_VERIFYING.md`, `docs/reference/data-and-sync.md`. The skill's table "Per worktree" lists `target` and `target/debug/data/`. Its cargo-workspace section stays true; re-path it.
- **Reaching a module in the running app.** A recipe that imports `/src/lib/<x>.ts` over CDP relied on the dev server's root being the repository. The desktop's root is `apps/desktop`, so a shared module's URL is `/@fs/<absolute path>/packages/ui/lib/<x>.ts`, and only `/src/main.tsx` and its two neighbours are under `/src/`. `docs/reference/live-ui-verification.md`, `decks-live-findings.md`, `frontend-design.md`, `decks-storage.md`. Do not rewrite a dated measurement's wording; add the current form beside the first recipe in each file.
- **Running the Tauri CLI.** `npm run tauri dev` is unchanged. Where a doc says the CLI is run from the root and finds `src-tauri`, it is now run from `apps/desktop` by the script, as `tauri:light` runs it from `apps/light`.
- **The three tsc programs for the Workers** are `tsc -p infrastructure/<name>`.
- **`docs/agent/ARCHITECTURE.md`** — the crate boundary and the IPC flow, re-pathed and re-read as a whole.

- [ ] **Step 5: Check**

```powershell
node scripts/check-claude-md.mjs
npx vitest run scripts/claude-md.test.mjs
node "<scratch>\layout-move.mjs" . --stale
```

Expected: both pass. `--stale` prints `no old path left`, or only lines that are deliberate: a dated quotation, or a crate-relative `src/…` the script cannot tell from the old root folder. List each survivor in the report with its reason.

Checkpoint (controller): `git add -A; git commit -m "wip(layout): docs"`.

---

### Task 7: Verification against the baseline

**Files:** none, unless a check fails.

- [ ] **Step 1: Builds**

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
npm run build
npx vite build --config apps/light/vite.config.ts
npm run web:build
npm run share:build
npm run build-storybook
node "<scratch>\layout-builds.mjs" "<scratch>\builds-after.json" desktop=apps/desktop/dist android=apps/light/dist-mobile web=apps/light/dist-web share=apps/share/dist-share storybook=storybook-static
node "<scratch>\layout-builds.mjs" --diff "<scratch>\builds-before.json" "<scratch>\builds-after.json"
```

Expected: `every build emitted what it emitted`. A CSS rule that is lost or gained is traced to the file that uses the class and the `@source` that should name it; a difference with a reason that is not a defect is written into the report. A JavaScript total more than 1% off, or a different file count, is a module bundled twice until shown otherwise.

- [ ] **Step 2: WASM**

```powershell
$env:CC_wasm32_unknown_unknown = "C:\Program Files\LLVM\bin\clang.exe"
$env:AR_wasm32_unknown_unknown = "C:\Program Files\LLVM\bin\llvm-ar.exe"
npm run web:wasm
Get-FileHash dist-wasm\*.wasm -Algorithm SHA256 | ForEach-Object { "$($_.Hash)  $(Split-Path $_.Path -Leaf)" } | Set-Content "<scratch>\wasm-after.txt"
Compare-Object (Get-Content "<scratch>\wasm-before.txt") (Get-Content "<scratch>\wasm-after.txt")
```

Expected: no output, if Task 0 found the build reproducible. A difference is explained before going on: a path embedded by `file!()` from a moved crate is a reason; a changed feature set or profile is a defect.

- [ ] **Step 3: The whole of `verify`, in pieces, in the foreground**

```powershell
npm run lint
Get-Process cargo,rustc -ErrorAction SilentlyContinue
npm run lint:rust
npx vitest run --shard=1/4; npx vitest run --shard=2/4; npx vitest run --shard=3/4; npx vitest run --shard=4/4
cargo test --workspace 2>&1 | Tee-Object "<scratch>\cargo-run.txt" | Select-String "^test result|Running|Doc-tests|FAILED|panicked" | Set-Content "<scratch>\cargo-after.txt"
cargo test --manifest-path crates/card-scanner/Cargo.toml --target-dir crates/card-scanner/target --features cli 2>&1 | Select-String "^test result|Running|Doc-tests|FAILED|panicked" | Add-Content "<scratch>\cargo-after.txt"
Compare-Object (Select-String "^test result" "<scratch>\cargo-before.txt" | ForEach-Object { $_.Line -replace "finished in .*", "" }) (Select-String "^test result" "<scratch>\cargo-after.txt" | ForEach-Object { $_.Line -replace "finished in .*", "" })
```

Expected: lint clean; four green shards; every `test result` line `ok`; `Compare-Object` prints nothing, so each binary ran the count it ran before.

- [ ] **Step 4: The Workers still bundle** — a dry run, which contacts nothing

```powershell
npm ci --ignore-scripts --prefix infrastructure/app-worker
foreach ($w in "relay","share-worker","app-worker") {
  Push-Location "infrastructure\$w"
  node ..\app-worker\node_modules\wrangler\bin\wrangler.js deploy --dry-run --outdir "<scratch>\wrangler-$w"
  Pop-Location
}
```

Expected: three bundles, each ending `--dry-run: exiting now.` Each Worker's folder now has a `tsconfig.json` that wrangler reads; a resolution error here is that file's.

- [ ] **Step 5: The desktop app on real data** — follow the `running-the-app` skill for the lock

Copy the main checkout's data folder, whole, with the app stopped, then launch:

```powershell
$L = ".claude\skills\running-the-app\lock.ps1"
pwsh -NoProfile -File $L acquire app -Wait -What "layout stage 1: live pass"
if (-not (Test-Path target\debug\data)) { Copy-Item D:\Code\mtg-grimoire\src-tauri\target\debug\data target\debug\data -Recurse }
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('target/debug/data/user.db',{readOnly:true});console.log(d.prepare('select count(*) n from sync_group').get(), d.prepare(\"select value from app_meta where key='mirror_root'\").get())"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
```

If the first number is not `0` or a mirror root is set, delete those rows **in the copy** before launching: the copy is the owner's device otherwise. Then, with the window up: the collection shows the cards it had; a card's picture loads; the deck list opens; `node scripts/cdp.mjs eval "document.querySelectorAll('link[rel=stylesheet],style').length"` answers non-zero. Release the lock afterwards. Tell the owner beforehand that a window will open.

- [ ] **Step 6: The light app, and Storybook**

`npm run mobile:dev` and open `http://localhost:5175/` — the fake-mode light app renders its wall. `npm run mobile:tauri` opens it in a phone-sized window (same lock). `npm run share:dev` and open the dev shell — the golden snapshot renders. `npm run web:smoke` passes. Storybook was built in Step 1; opening it is not required.

`npx tsc -p .design-sync/tsconfig.dts.json` exits with the code Task 0 recorded. Nothing else checks `.design-sync/`, and a design sync is not run here; the report says so.

- [ ] **Step 7: Nothing old is left**

```powershell
node "<scratch>\layout-move.mjs" . --stale
git status --short
```

Expected: `no old path left` apart from the survivors Task 6 listed, and a clean tree after the last checkpoint.

---

### Task 8: One commit, and the pull request

- [ ] **Step 1: Squash** (PowerShell)

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
git fetch origin main
git merge origin/main
```

If the merge brings files at old paths (a pull request that landed meanwhile), run `node "<scratch>\layout-move.mjs" . --stale` and move them by hand to where `MAP` puts them, then re-run Task 7 Step 3. Then:

```powershell
git reset --soft origin/main
git commit -F "<scratch>\commit-message.txt"
git log --oneline -1; git show --stat --format= HEAD | Select-Object -Last 1
```

with `<scratch>\commit-message.txt` holding:

```
chore: regroup the repository into apps, packages, crates and infrastructure

The root now shows what is in it. apps/ holds the desktop app, the light
app (Android and web) and the public share page; packages/ holds the
shared frontend and the fake engine; infrastructure/ holds the three
Cloudflare Workers; crates/ is unchanged.

No behaviour changes. Cargo's build tree is the workspace default,
<root>/target, and the five members inherit version, edition and license
from [workspace.package]. Still npm and one package.json: the pnpm
workspace is the next stage.

A checkout that takes this must move src-tauri/target/debug/data to
target/debug/data once, or its app opens an empty collection. Move the
data folder only: a cargo build tree does not survive being moved.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Expected: one commit ahead of `origin/main`, about 1,760 renames.

- [ ] **Step 2: Push and open the pull request** — only when the controller has the owner's word to

The body states: what moved (the table in `docs/reference/repository-layout.md`); the verification results from Task 7, with numbers; the one thing the owner does in each checkout kept, with the app closed (move `src-tauri\target\debug\data` to `target\debug\data`, then delete the rest of `src-tauri\target`); that `release.yml` has not run and the next release is its first run; that nothing was deployed. It ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: CI**

Bind the pull request with the ccd_pr tools and read its checks. A pull request that touches every folder routes every job, including the Android build and the web job, which cannot run on this machine. A red job is fixed in a new `wip(layout):` commit and squashed again before merge.

---

## Appendix A: `layout-move.mjs`

Not committed. Save it outside the repository and run it with the repository's path as its first argument.

**This is the script as it ran on 2026-10-08 (commit `f0e70a15`), and it has five defects that reviews and the first builds found afterwards.** All were repaired by hand in the tasks that followed; none is patched here, so that this stays the record of what made that commit. Fix them before using it again:

- **The Windows-separator pass (`WIN`) is not safe in code.** It matched `src\` and `mobile\` inside two regex literals (`src\/` became `packages\ui\/`, where `\u` is not a separator) and inside a bash line in a workflow (`` \`$src\` ``). Three of its seven rewrites were wrong. Restrict it to Markdown and `.ps1`, or drop it.
- **The "this package's own folder" check probes file extensions.** Inside a file under the old `mobile/`, a bare `mobile/` resolved against `mobile/mobile.css` and was left alone, and `--stale` has the same blind spot. That check should match folders only.

- **A folder wins over a file of the same name.** `../widgets` from inside `widgets/`, beside a `widgets.ts`, resolved to the folder and was rewritten to `"."` — nine imports that stopped every bundler. A specifier should resolve to a file with an extension before a folder, and one whose two ends moved together should be left as written.

- **It loses a file's executable bit.** It moves with `renameSync` and the caller stages with `git add -A`; with `core.fileMode=false`, as on Windows, the new path is recorded as `100644`. The Gradle wrapper (`gradlew`) went from `100755` to `100644`, which would have failed every Android build on Linux with `Permission denied`. Found by the final review; repaired with `git update-index --chmod=+x`. After a run, compare `git ls-tree -r <base>` against `git ls-files -s` for mode `100755`.
- **A path directly after a hyphen is not a token.** The token rule's look-behind refuses `-` so that `dist-web` is not read as `web`, and so `${2:-mobile/src-tauri/…}` in a shell script was skipped. One instance, in `scripts/android-release/check-version.sh`, which two workflows call.

It does not rewrite `@/` imports, so a test that moved out of the shared UI with its subject kept importing it through the alias. It also cannot see a root-absolute path that is not directly after a quote (the second path in `"/a.tsx → /src/b.ts"`), a bare folder name with no slash (`working-directory: mobile`, `join("..", "src")`), or a `share/` that means a Rust module rather than the root folder.

```js
// Stage 1 of docs/superpowers/specs/2026-10-08-repository-layout-and-workspace-design.md.
//
//   node layout-move.mjs <repo> --dry [--verbose] [--log f.tsv]   report, touch nothing
//   node layout-move.mjs <repo> --write                           move and rewrite
//   node layout-move.mjs <repo> --census out.json [--mapped]      what every glob sweep matches
//   node layout-move.mjs <repo> --census-diff a.json b.json       the two, compared
//   node layout-move.mjs <repo> --stale                           old paths left after the move
//
// `--write` rewrites three kinds of text and nothing else:
//   R  a relative path ("./x", "../x"), re-pointed from the file's new place at the target's;
//   T  a root-relative path token (src-tauri/…, mobile/…) in prose, comments and strings;
//   G  a root-absolute literal ("/src/**") — an `import.meta.glob` resolved from Vitest's root.
// A path is rewritten only when it names something in the tree as tracked before the move.
// Files in HAND are moved and not rewritten: their paths change meaning with their location.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const root = path.resolve(argv[0] ?? ".");
const flag = (name) => argv.includes(name);
const value = (name, n = 1) => (argv.indexOf(name) < 0 ? null : argv.slice(argv.indexOf(name) + 1, argv.indexOf(name) + 1 + n));
const P = path.posix;

/** Old path → new path. First match wins; a trailing slash is a folder. */
const MAP = [
  ["src/main.tsx", "apps/desktop/src/main.tsx"],
  ["src/boot/DesktopBoot.tsx", "apps/desktop/src/DesktopBoot.tsx"],
  ["src/boot/DesktopBoot.test.tsx", "apps/desktop/src/DesktopBoot.test.tsx"],
  ["src/boot/StartupScreen.tsx", "apps/desktop/src/StartupScreen.tsx"],
  ["src/boot/StartupScreen.test.tsx", "apps/desktop/src/StartupScreen.test.tsx"],
  ["src/boot/StartupScreen.stories.tsx", "apps/desktop/src/StartupScreen.stories.tsx"],
  ["index.html", "apps/desktop/index.html"],
  ["public/", "apps/desktop/public/"],
  ["vite.config.ts", "apps/desktop/vite.config.ts"],
  ["tsconfig.node.json", "apps/desktop/tsconfig.node.json"],
  ["vite.mobile.config.ts", "apps/light/vite.config.ts"],
  ["vite.sw.ts", "apps/light/vite.sw.ts"],
  ["vite.share.config.ts", "apps/share/vite.config.ts"],
  ["components.json", "packages/ui/components.json"],
  ["tsconfig.web-worker.json", "packages/ui/tsconfig.web-worker.json"],
  ["tsconfig.web-sw.json", "packages/ui/tsconfig.web-sw.json"],
  ["tsconfig.relay.json", "infrastructure/relay/tsconfig.json"],
  ["tsconfig.share-worker.json", "infrastructure/share-worker/tsconfig.json"],
  ["tsconfig.app-worker.json", "infrastructure/app-worker/tsconfig.json"],
  [".storybook/fake/", "packages/fake/"],
  // Untracked build trees, so a path into one is re-pointed too. Above the folders they sit in.
  ["src-tauri/target/", "target/"],
  ["dist-mobile/", "apps/light/dist-mobile/"],
  ["dist-web/", "apps/light/dist-web/"],
  ["dist-share/", "apps/share/dist-share/"],
  ["dist/", "apps/desktop/dist/"],
  ["src-tauri/", "apps/desktop/src-tauri/"],
  ["mobile/", "apps/light/"],
  ["share/", "apps/share/"],
  ["relay/", "infrastructure/relay/"],
  ["share-worker/", "infrastructure/share-worker/"],
  ["app-worker/", "infrastructure/app-worker/"],
  ["src/", "packages/ui/"],
];
/** Folders that exist only as build output: a path into one counts as existing. */
const OUTPUTS = ["src-tauri/target", "dist-mobile", "dist-web", "dist-share", "dist"];
/** Moved, never rewritten: the plan gives each its new text. */
const HAND = new Set([
  "vite.config.ts", "vite.mobile.config.ts", "vite.share.config.ts", "vite.sw.ts",
  "tsconfig.node.json", "tsconfig.relay.json", "tsconfig.share-worker.json",
  "tsconfig.app-worker.json", "tsconfig.web-worker.json", "tsconfig.web-sw.json",
  "components.json", "index.html", "package.json", "Cargo.toml", ".cargo/config.toml",
]);
/** Never rewritten: dated records, lockfiles, data, finished one-shot scripts. */
const FROZEN = [
  /^docs\/superpowers\//, /^CHANGELOG\.md$/, /^LICENSE$/, /(^|\/)Cargo\.lock$/,
  /(^|\/)package-lock\.json$/, /^\.release-please-manifest\.json$/,
  /^scripts\/core-step-[^/]*\.mjs$/, /\/__golden__\//, /^scripts\/web-smoke\/[^/]*\.(jsonl|json)$/,
];
const BINARY = /\.(png|ico|icns|jpe?g|webp|gif|woff2?|ttf|otf|eot|jar|keystore|jks|rten|bin|pdf|zip|wasm|db)$/i;

function mapPath(p) {
  for (const [from, to] of MAP) {
    if (from.endsWith("/")) {
      if (p === from.slice(0, -1)) return to.slice(0, -1);
      if (p.startsWith(from)) return to + p.slice(from.length);
    } else if (p === from) return to;
  }
  return p;
}

const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 << 20 }).toString().split("\n").filter(Boolean);
/** The tree as it is on disk: tracked and new, minus what a move has taken away. */
const onDisk = () => git("ls-files", "-co", "--exclude-standard").filter((f) => existsSync(path.join(root, f)));
const index = (list) => {
  const files = new Set(list);
  const dirs = new Set([""]);
  for (const f of list) for (let d = P.dirname(f); d !== "." && !dirs.has(d); d = P.dirname(d)) dirs.add(d);
  return { list, files, dirs };
};
const up = (d) => (P.dirname(d) === "." ? "" : P.dirname(d));
const text = (f) => {
  if (BINARY.test(f) || FROZEN.some((re) => re.test(f))) return null;
  const bytes = readFileSync(path.join(root, f));
  const s = bytes.toString("utf8");
  return bytes.includes(0) || !Buffer.from(s, "utf8").equals(bytes) ? null : s;
};

const EXT = [".ts", ".tsx", ".mts", ".js", ".mjs", ".json", ".css", "/index.ts", "/index.tsx"];
/** What `p` names in a tree: `{ hit, add }`, where `add` is the suffix resolution supplied. */
function resolveIn(tree, p, outputs = OUTPUTS) {
  if (tree.files.has(p) || tree.dirs.has(p)) return { hit: p, add: "" };
  for (const o of outputs) if (p === o || p.startsWith(o + "/")) return { hit: p, add: "" };
  for (const e of EXT) if (tree.files.has(p + e)) return { hit: p + e, add: e };
  const glob = p.search(/[*{[]/);
  if (glob > 0 && tree.dirs.has(p.slice(0, p.lastIndexOf("/", glob)))) return { hit: p, add: "" };
  return null;
}

const HEADS = [
  "\\.storybook/fake/", "src-tauri/", "mobile/", "share/", "relay/", "share-worker/",
  "app-worker/", "src/", "public/", "dist-mobile(?![\\w-])", "dist-web(?![\\w-])",
  "dist-share(?![\\w-])", "vite\\.mobile\\.config\\.ts", "vite\\.share\\.config\\.ts",
  "vite\\.sw\\.ts", "components\\.json",
  "tsconfig\\.(?:relay|share-worker|app-worker|web-worker|web-sw|node)\\.json",
];
const REL = /(?<![\w./@\\-])\.{1,2}\/[^\s"'`)<>|;,\\}]*/g;
const TOKEN = new RegExp(`(?<![\\w./@\\\\-])(?:${HEADS.join("|")})[\\w.@*{}\\[\\]/-]*`, "g");
const ABS = new RegExp(`(?<=["'\`]!?)/(?:${HEADS.slice(0, 9).join("|")})[\\w.@*{}\\[\\],/-]*`, "g");
/** The folder heads with Windows separators, for PowerShell and the docs that quote it. */
const WIN = /(?<![\w./@\\-])(?:src-tauri|mobile|share-worker|app-worker|relay|src)\\[\w.@*\\-]*/g;
/** A name that is only ever a root folder. `mobile/`, `share/`, `relay/`, `src/` are also words. */
const SURE = /^(src-tauri|app-worker|share-worker|\.storybook)\//;
/** Mentions too ambiguous to rewrite; counted so a person reads each. */
const TRIAGE = {
  "vite.config.ts": /(?<![\w./-])vite\.config\.ts/g,
  "index.html": /(?<![\w./-])index\.html/g,
  "dist/": /(?<![\w./@-])dist\//g,
  '".."': /["'`]\.\.["'`]/g,
};
const SPLIT = /^(.*?)([?#].*)?$/s;
/** Sentence punctuation is not part of a path, and neither is the bracket that closes a link. */
const trim = (s) => {
  const t = s.replace(/[.,:;]+$/, "");
  return t.endsWith("]") && !t.includes("[") ? t.slice(0, -1) : t;
};
const globRe = (g) =>
  new RegExp("^" + g.replace(/[.+^$()|\\]/g, "\\$&").replace(/\{([^}]*)\}/g, (_, a) => `(?:${a.split(",").join("|")})`)
    .replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]") + "$");
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const table = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`).join("\n");
const bump = (o, k, n = 1) => (o[k] = (o[k] ?? 0) + n);
const area = (f) => (f.includes("/") ? f.split("/")[0] : "(root)");

// ---------------------------------------------------------------- census
/** What each file's `import.meta.glob` calls match, as sorted paths. */
function census(mapped) {
  const tree = index(onDisk());
  const out = {};
  for (const f of tree.list) {
    if (!/\.(ts|tsx|mts|mjs)$/.test(f)) continue;
    const s = text(f);
    // With or without a type argument: `import.meta.glob<string>(…)`.
    const calls = s?.split(/import\.meta\.glob(?:<[^>(]*>)?\(/) ?? [];
    if (calls.length < 2) continue;
    const seen = new Set();
    for (const call of calls.slice(1)) {
      let depth = 1, end = 0;
      while (end < call.length && depth > 0) depth += call[end] === "(" ? 1 : call[end] === ")" ? -1 : 0, end++;
      const yes = [], no = [];
      for (const [, lit] of call.slice(0, end).split(/[,{]\s*(?:query|import|eager|as)\s*:/)[0].matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
        const neg = lit.startsWith("!");
        const g = neg ? lit.slice(1) : lit;
        const abs = g.startsWith("/") ? g.slice(1) : /^\.{1,2}\//.test(g) ? P.normalize(P.join(P.dirname(f), g)) : null;
        if (abs !== null) (neg ? no : yes).push(globRe(abs));
      }
      for (const p of tree.list) if (yes.some((re) => re.test(p)) && !no.some((re) => re.test(p))) seen.add(mapped ? mapPath(p) : p);
    }
    out[mapped ? mapPath(f) : f] = [...seen].sort();
  }
  return out;
}

if (flag("--census")) {
  const out = census(flag("--mapped"));
  writeFileSync(value("--census")[0], JSON.stringify(out, null, 1));
  console.log(`${Object.keys(out).length} files sweep the tree; ${sum(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])))} matches in all`);
} else if (flag("--census-diff")) {
  const [a, b] = value("--census-diff", 2).map((f) => JSON.parse(readFileSync(f, "utf8")));
  let bad = 0;
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const was = new Set(a[f] ?? []), now = new Set(b[f] ?? []);
    const lost = [...was].filter((p) => !now.has(p)), gained = [...now].filter((p) => !was.has(p));
    if (!lost.length && !gained.length) continue;
    bad++;
    console.log(`${f}: ${was.size} -> ${now.size}`);
    for (const p of lost.slice(0, 12)) console.log(`   - ${p}`);
    for (const p of gained.slice(0, 12)) console.log(`   + ${p}`);
  }
  console.log(bad ? `${bad} sweeps differ` : "every sweep matches what it matched");
  process.exitCode = bad ? 1 : 0;
} else if (flag("--stale")) {
  // After the move: an old path is one that still starts at an old folder and names something
  // that now lives at its mapped place — and that the file's own package does not have.
  const tree = index(onDisk());
  let n = 0;
  for (const f of tree.list) {
    const s = text(f);
    if (s === null) continue;
    s.split("\n").forEach((line, i) => {
      for (const re of [TOKEN, ABS, WIN]) for (const m of line.matchAll(re)) {
        const bare = trim(m[0]).replaceAll("\\", "/").replace(/^\//, "").replace(/\/$/, "");
        let local = false;
        for (let d = up(f); d && !local; d = up(d)) local = !!resolveIn(tree, `${d}/${bare}`, []);
        if (local || resolveIn(tree, bare, [])) continue;
        const to = mapPath(bare);
        if (to !== bare && (SURE.test(bare) || resolveIn(tree, to, ["target", "apps/desktop/dist", "apps/light/dist-web", "apps/light/dist-mobile", "apps/share/dist-share"]))) {
          n++;
          console.log(`${f}:${i + 1}: ${m[0]}  ->  ${to}`);
        }
      }
    });
  }
  console.log(n ? `${n} old paths` : "no old path left");
  process.exitCode = n ? 1 : 0;
} else {
  // -------------------------------------------------------------- the move
  const tree = index(git("ls-files"));
  for (const o of OUTPUTS) tree.dirs.add(o);
  const resolveOld = (p) => resolveIn(tree, p);
  const crateOf = (f) => {
    for (let d = up(f); d; d = up(d)) if (tree.files.has(`${d}/Cargo.toml`)) return d;
    return "";
  };
  const report = { moved: 0, rel: {}, tok: {}, win: {}, abs: {}, globs: [], violations: [], unresolvedRel: [], unresolvedTok: {}, triage: {}, skipped: [], log: [] };

  function rewrite(oldFile, source) {
    const newFile = mapPath(oldFile);
    const oldDir = up(oldFile), newDir = up(newFile);
    const inUi = (f) => f.startsWith("packages/ui/");
    const code = /\.(ts|tsx|mts)$/.test(oldFile);

    let out = source.replace(REL, (m) => {
      const body = trim(m), tail = m.slice(body.length);
      const [, rel, suffix = ""] = SPLIT.exec(body);
      const target = P.normalize(P.join(oldDir, rel)).replace(/\/$/, "");
      if (target.startsWith("..")) return m;
      let found = resolveOld(target === "." ? "" : target);
      let fromDir = newDir;
      // Rust: a path joined onto CARGO_MANIFEST_DIR is relative to the crate, not to the file.
      if (!found && oldFile.endsWith(".rs")) {
        const crate = crateOf(oldFile);
        const viaCrate = P.normalize(P.join(crate, rel)).replace(/\/$/, "");
        if (!viaCrate.startsWith("..") && (found = resolveOld(viaCrate))) fromDir = mapPath(crate);
      }
      if (!found) {
        if (newFile !== oldFile && rel.startsWith("../")) report.unresolvedRel.push(`${oldFile}: ${m}`);
        return m;
      }
      let to = mapPath(found.hit);
      if (to === found.hit && newFile === oldFile) return m;
      if (found.add && to.endsWith(found.add)) to = to.slice(0, -found.add.length);
      // A desktop-only module that leaves the shared UI keeps importing it by the alias.
      if (code && !suffix && oldFile.startsWith("src/") && found.hit.startsWith("src/") && !inUi(newFile) && inUi(to + "/")) {
        const alias = "@/" + to.slice("packages/ui/".length) + tail;
        report.log.push(`${oldFile}\tA\t${m}\t${alias}`);
        return alias;
      }
      if (inUi(newFile) && oldFile.startsWith("src/") && found.hit.startsWith("src/") && !inUi(to + "/"))
        report.violations.push(`${oldFile} -> ${found.hit}`);
      let next = P.relative(fromDir, to) || ".";
      if (!next.startsWith(".")) next = "./" + next;
      if (rel.endsWith("/") && !next.endsWith("/")) next += "/";
      next += suffix + tail;
      if (next !== m) {
        bump(report.rel, area(oldFile));
        report.log.push(`${oldFile}\tR\t${m}\t${next}`);
      }
      return next;
    });

    if (/\.(ts|tsx|mts|mjs|js)$/.test(oldFile))
      out = out.replace(ABS, (m) => {
        const bare = m.slice(1).replace(/\/$/, "");
        if (!resolveOld(bare)) return m;
        const next = "/" + mapPath(bare) + (m.endsWith("/") ? "/" : "");
        if (next === m) return m;
        bump(report.abs, area(oldFile));
        report.log.push(`${oldFile}\tG\t${m}\t${next}`);
        if (/[*{]/.test(m)) report.globs.push([oldFile, m.slice(1), next.slice(1)]);
        return next;
      });

    const token = (m, sep) => {
      const body = trim(m), tail = m.slice(body.length);
      const p = sep === "\\" ? body.replaceAll("\\", "/") : body;
      const bare = p.replace(/\/$/, "");
      // The file's own package may have a folder of that name: `src/x.rs` in a crate is the crate's.
      for (let d = oldDir; d; d = up(d)) if (resolveOld(`${d}/${bare}`)) return m;
      if (!resolveOld(bare)) {
        // Untracked, or since deleted. A sure name moves with its folder; an ambiguous one only
        // when a folder two levels down is real.
        let deep = bare;
        while (deep.includes("/") && !tree.dirs.has(deep)) deep = deep.slice(0, deep.lastIndexOf("/"));
        if (!SURE.test(bare) && !deep.includes("/")) {
          bump(report.unresolvedTok, `${oldFile}: ${body}`);
          return m;
        }
      }
      let next = mapPath(bare) + (p.endsWith("/") ? "/" : "");
      if (next === p) return m;
      if (sep === "\\") next = next.replaceAll("/", "\\");
      bump(sep === "\\" ? report.win : report.tok, area(oldFile));
      report.log.push(`${oldFile}\tT\t${m}\t${next + tail}`);
      return next + tail;
    };
    out = out.replace(TOKEN, (m) => token(m, "/")).replace(WIN, (m) => token(m, "\\"));
    for (const [name, re] of Object.entries(TRIAGE)) {
      const n = out.match(re)?.length ?? 0;
      if (n) bump(report.triage, `${name} @ ${area(oldFile)}`, n);
    }
    return out;
  }

  const plan = [];
  for (const f of tree.list) {
    const to = mapPath(f);
    let next = null;
    if (!HAND.has(f)) {
      const s = text(f);
      if (s === null) { if (!BINARY.test(f) && !FROZEN.some((re) => re.test(f))) report.skipped.push(f); }
      else if ((next = rewrite(f, s)) === s) next = null;
    }
    if (to !== f) report.moved++;
    if (to !== f || next !== null) plan.push({ from: f, to, text: next });
  }
  const targets = new Map();
  for (const { from, to } of plan) {
    if (to !== from && tree.files.has(to)) throw new Error(`collision: ${from} -> ${to} is already tracked`);
    if (targets.has(to)) throw new Error(`collision: ${from} and ${targets.get(to)} -> ${to}`);
    targets.set(to, from);
  }

  if (flag("--write")) {
    if (git("status", "--porcelain", "--untracked-files=no").length) throw new Error("the tree has changes; commit or restore them first");
    for (const { from, to, text: next } of plan) {
      if (to !== from) {
        mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
        renameSync(path.join(root, from), path.join(root, to));
      }
      if (next !== null) writeFileSync(path.join(root, to), next);
    }
    // A folder the renames emptied is left behind; git does not track folders.
    const prune = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(d, e.name));
      try { rmdirSync(d); } catch { /* not empty */ }
    };
    for (const d of ["src", "src-tauri", "mobile", "share", "relay", "share-worker", "app-worker", "public", ".storybook/fake"])
      if (existsSync(path.join(root, d))) prune(path.join(root, d));
  }

  const V = flag("--verbose");
  console.log(`${flag("--write") ? "WROTE" : "DRY RUN"}: ${report.moved} files move, ${plan.filter((p) => p.text !== null).length} files rewritten`);
  console.log(`\nR relative paths re-pointed: ${sum(report.rel)}\n${table(report.rel)}`);
  console.log(`\nT root-relative tokens rewritten: ${sum(report.tok)}\n${table(report.tok)}`);
  console.log(`\nT with backslashes: ${sum(report.win)}\n${table(report.win)}`);
  console.log(`\nG root-absolute literals rewritten: ${sum(report.abs)}\n${table(report.abs)}`);
  const after = tree.list.map(mapPath);
  console.log("\nglobs that match a different number of files afterwards:");
  for (const [file, was, now] of report.globs) {
    const a = tree.list.filter((f) => globRe(was).test(f)).length, b = after.filter((f) => globRe(now).test(f)).length;
    if (a !== b || V) console.log(`  ${a === b ? "=" : "!"} ${a} -> ${b}  ${file}: ${was} -> ${now}`);
  }
  console.log(`\nshared UI importing a module that left it (fix by hand): ${report.violations.length}\n  ${report.violations.join("\n  ")}`);
  console.log(`\nrelative paths in a moved file that name nothing tracked: ${report.unresolvedRel.length}`);
  if (V) console.log("  " + report.unresolvedRel.join("\n  "));
  console.log(`\nold-folder tokens that name nothing tracked (left alone): ${sum(report.unresolvedTok)} in ${Object.keys(report.unresolvedTok).length} places`);
  if (V) console.log(table(report.unresolvedTok));
  console.log(`\nambiguous mentions left for a person:\n${table(report.triage)}`);
  console.log(`\nnot valid UTF-8, moved untouched: ${report.skipped.length}${V ? "\n  " + report.skipped.join("\n  ") : ""}`);
  if (value("--log")) writeFileSync(value("--log")[0], report.log.join("\n") + "\n");
}
```
