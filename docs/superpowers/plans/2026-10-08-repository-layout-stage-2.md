# Repository layout, stage 2 (the pnpm workspace) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each part of the repository a package with its own manifest in a pnpm workspace, and import across packages by package name, with no change in behaviour.

**Architecture:** One script writes the nine manifests and the catalog from a single table of who imports what, with every version range copied from today's root manifest. A second script, which parses each file with the compiler, rewrites 810 import specifiers to package names. The one webview TypeScript program becomes one program per package, and the one Vitest program one project per package, all still rooted at the repository. The deploy tool moves to a folder of its own and stays on npm, and the two jobs that hold a secret never see pnpm. A new test reads every file and holds the import rules and "a package declares what it imports", which nothing that runs the code can check.

**Tech Stack:** Node 24, pnpm 11.5.0 (through Corepack), npm for the deploy tool only, Vite 8, Vitest 5, TypeScript 6, Tailwind 4, Storybook 10, Tauri 2, wrangler 4.146.0, GitHub Actions.

**Spec:** [`docs/superpowers/specs/2026-10-08-repository-layout-and-workspace-design.md`](../specs/2026-10-08-repository-layout-and-workspace-design.md), §6 and §7. Stage 1 landed as `1e66c867`. The owner's two decisions for this stage, 2026-10-08: **one pull request**, and **`pnpm/action-setup` pinned to a commit** in CI.

## What was measured before this plan was written

Every mechanism below was run in a throwaway checkout at `59d735fa` (2026-10-08). The plan's expected outputs are these runs.

| Question | Result |
| --- | --- |
| Does splitting the manifests change what is installed? | No. `pnpm import` and then the nine manifests with a catalog of 23 resolve the same **769 packages and 770 snapshots**, none gone and none new. |
| Do the builds change? | Desktop 2,485,060 B, Android 2,651,814 B and share 507,965 B of JavaScript, **byte for byte** what npm built, with the same CSS rules, after the rewrite and with `resolve.dedupe` on. |
| Does Storybook change? | 541 files both ways, CSS identical, JavaScript **+3,295 B (0.02%)**, all traced: the `wallItem` chunk (Task 2), and `react-docgen` now following three app components' imports into the shared UI (see "Known differences"). |
| Does each package type-check alone? | Yes, all eleven programs, no errors. The one webview program took 32 s; the five that replace it take about 58 s together (23–27, 4–5, 13–14, 14–15 and 2). |
| Does Vitest collect the same files as projects? | **552 files** both ways, none different: ui 473, light 34, relay 15, root 11, fake 8, app-worker 4, share-worker 3, desktop 2, share 2. |
| Does `pnpm run <root script>` work from an app's folder? | No: *"script … is present in the root of the workspace, so you may run `pnpm -w run …`"*. `pnpm --workspace-root run <name> a b -v` does, from `apps/light/src-tauri`, with every argument passed on. |
| Does `pnpm run x -- --flag` behave as npm's does? | **No.** The script receives `["--", "--flag"]`. Every `--` separator has to go. |
| Can a Vite config import another package by name? | It loads, until the file has anything Node cannot strip: an `enum` behind a package name failed the config's load, and the same file by relative path built. Vite bundles what a config reaches by path and leaves a package name to Node. |
| Can the hosting Worker be bundled with nothing installed but wrangler? | Not by package name alone (`Could not resolve "@grimoire/ui/lib/core/web/assets"`). A wrangler `alias` for the exact module bundles it; an alias for the package folder does not. |
| Is the pinned pnpm's hash right? | `pnpm@11.5.0+sha512.dbfcc4f8…a8eb1` installs from a cold Corepack cache; one digit changed is refused. |
| Does the suite pass on the finished shape? | Yes: 14,628 tests in three shards, none failed, with one file not loading — `release-rule.test.mjs`, which imported the lockfile that moved. With Task 7's code the `root` project then passed 373 of 373, and went red each of the three ways Task 7 Step 6 breaks it. |
| Do the fences this plan adds refuse what they should? | `scripts/workspace.test.mjs` failed on an undeclared import, on `@/` outside the UI and on a path into another package, and passed restored. Both import-graph fences failed on a package-name weld. The Worker's test failed with the alias line removed. ESLint flagged the same three imports and nothing in the clean tree. |
| What does `tauri-action` v1.0.0 run with a pnpm lockfile? | `pnpm tauri build …` when the root manifest has `@tauri-apps/cli` and a `pnpm-lock.yaml` is found (read from its `src/runner.ts` at the pinned commit). With no CLI in the root manifest it installs a global one with npm. |

**Known differences, to be found again in Task 9 and not "fixed":**

- **Storybook's prop tables for three app components read differently.** `react-docgen` could not follow `@/lib/edition` and printed the type's name; it can follow `@grimoire/ui/lib/edition` and prints what it finds. `TabBar`'s `view` reads `unknown[number]` (raw `(typeof LIGHT_VIEWS)[number]`) where it read `LightView`. The other two are the light app's `ScannerPage` stories (+2,516 B) and the desktop's `StartupScreen` stories (+702 B). Components inside `packages/ui` keep `@/` and are unchanged.
- **`tsc -p .design-sync/tsconfig.dts.json` fails with 9 errors before and after** (`useDeck.ts` 2, `worker.ts` 1, `scanWorker.ts` 1, `sw/sw.ts` 5). It fails on `main` today; this plan changes only the file it extends.

## What this plan changes in the spec

Task 8 writes these into the spec's §6 as a dated amendment, the way stage 1 did.

1. **`@grimoire/desktop` also depends on `@grimoire/fake`**, for its two test files. pnpm's layout found it.
2. **`@grimoire/light` does not depend on `@grimoire/app-worker`.** Its one reach into that package is from `vite.config.ts`, and rule 4 is wider than written: **a file Node loads itself imports by relative path** — a Vite, Vitest or Storybook config and everything under `scripts/`. The measurement is in the table above; and `scripts/web-deploy-probe.mjs` runs in a job that installs nothing.
3. **The three Workers keep the `tsconfig.json` they have** and do not extend `tsconfig.base.json`: their options differ on purpose.
4. **The hosting Worker's one cross-package import gets a wrangler `alias`**, because `web-deploy` bundles it with no workspace links.
5. **A stylesheet goes on naming another stylesheet by path.** `@import` and `@source` lines are not rewritten: Tailwind resolves a `@source` against the file it found it in, and that file reached through a `node_modules` link was not tried.
6. **`.design-sync/` is left as written** except for two lines of configuration: it is the converter's own program, and its barrel uses relative specifiers on purpose.
7. **`npm run x -- --flag` becomes `pnpm x --flag`**, not `pnpm x -- --flag`.

## Global Constraints

- **Behaviour-preserving.** No schema rung, no user-visible change, no dependency added, removed or bumped. `prosemirror-view` is *declared* where it is imported, at the range `@tiptap/pm` already brings it in by.
- **Nothing is deployed.** No `wrangler deploy` without `--dry-run`. The release pull request is not merged, and auto-merge is not enabled.
- **The two jobs that hold a secret get no pnpm.** `android-sign` is not edited. `web-deploy` changes in two lines, both listed in Task 7. `scripts/release-rule.test.mjs` is changed only as Task 7 lists; an assertion there is never loosened to make something pass.
- **One commit lands.** Tasks end in a `wip(workspace):` checkpoint commit on this branch; Task 10 squashes them into one `chore:` commit before anything is pushed.
- **All work happens in this worktree**, `D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570`, on `claude/pnpm-workspace`. No subagent takes a worktree of its own: an isolated one starts from `main`.
- **A subagent never runs `git add`, `git commit` or `git stash`.** The index is shared; the controller commits.
- **Tasks run in order, one at a time.** Tasks 2 and 8 each rewrite more than a hundred files.
- **One cargo at a time, one `vitest run` at a time.** Check `Get-Process cargo,rustc` before starting either.
- **Never `cargo fmt --all`** and never `cargo fmt` inside `crates/card-scanner`. **Never run Prettier over the tree.**
- **`git reset`, `git switch`, redirects and heredocs go through the PowerShell tool.** Start every PowerShell call with `Set-Location` to the worktree. PowerShell refuses `Remove-Item` on some paths here: delete a folder with `[IO.Directory]::Delete($path, $true)`.
- **Never walk the tree by folder once pnpm has installed.** `packages/ui/node_modules/@grimoire/fake` leads to `packages/fake/node_modules/@grimoire/ui` and back; `Get-ChildItem -Recurse` does not return. List files with `git ls-files`.
- **`git ls-files` and `git grep` do not see a file that is not yet tracked.** A file a task creates is checked by its own path.
- **Bash's `/tmp` is not Node's.** A file a shell writes for Node to read goes in `<scratch>`.
- **Not touched:** `docs/superpowers/**` except the spec's amendment and this plan; `CHANGELOG.md`; `Cargo.lock`; the *contents* of the deploy tool's `package-lock.json` (it moves, byte for byte); `.design-sync/**` except its two tsconfig files; `infrastructure/*/migrations/**` and `schema.sql`; `scripts/core-step-*.mjs`.
- **How a command is spelled from here on:** `pnpm <name>` at the root, with arguments after it and no `--`; `pnpm -w run <name>` where the working folder is an app's (the Tauri configs, Gradle); `pnpm exec <binary>` for a tool's own CLI; `pnpm install --frozen-lockfile` in CI.
- **`<scratch>`** is a folder outside the repository. In the planning session it is `C:\Users\Markus\AppData\Local\Temp\claude\D--Code-mtg-grimoire--claude-worktrees-repo-structure-cleanup-66d570\ba6ad799-535b-4b63-a3d2-9bb84e0e1273\scratchpad`, which holds `workspace-manifests.mjs`, `workspace-imports.mjs`, `workspace-commands.mjs`, `lock-set.mjs`, `layout-builds.mjs` and `workspace.test.mjs`. If it is gone, write the first four and the last from Appendices A to E, and `layout-builds.mjs` from stage 1's plan, Task 0 Step 2.
- **`CLAUDE.md` files stay under 200 lines** (`node scripts/check-claude-md.mjs`).

## Review Focus

1. **A flag after `--` that the script never sees as a flag.** `pnpm test:run -- --shard=1/3` hands Vitest `--shard=1/3` as a file filter: each of CI's three shards would run nothing or everything, and `pnpm scanner:assets -- --web` would fetch the desktop's files. Pinned by a new assertion in `scripts/workflow-scripts.test.mjs` that no workflow, script or Tauri config follows a script's name with ` -- ` (Task 7).
2. **An import-graph fence that stops at the package name.** `apps/light/phone/fence.test.ts` and `apps/share/SharePage.test.tsx` follow `@/` and relative specifiers; after the rewrite the apps say `@grimoire/ui/…`, which both read as a package to skip. Both have floors that turn that red, which is how it is caught; each is taught the name and then broken once by a package-name import to see it refuse (Task 2).
3. **The fake that no longer answers for the images module.** Both of the fake's hosts alias `@/lib/images` to the fake's file. Three files outside the shared UI import that module and will say `@grimoire/ui/lib/images`, which the alias does not match: the light app over the fake, and every story, would load the real module beside the fake one. Pinned by a fifth alias rule and an assertion on it in `packages/fake/images.test.ts` (Task 2), and by the Storybook comparison (Task 9).
4. **A release whose web deploy cannot bundle.** `web-deploy` checks out, installs wrangler and nothing else, and bundles `infrastructure/app-worker`. A package name there resolves only where pnpm has linked it. Every pull request's CI has the links; the release does not. Pinned by `hosting.test.ts` holding the import to the alias (Task 6) and by a dry-run bundle with the links taken away (Task 9).
5. **An import that resolves everywhere and is declared nowhere it should be.** Node looks in every folder above a file, so a name the root declares resolves from any package, in CI too, and a nested worktree reaches the main checkout's tree. pnpm's strictness never fires. Pinned by `scripts/workspace.test.mjs` (Task 4), broken once each way.

## File structure

| Created | Purpose |
| --- | --- |
| `pnpm-workspace.yaml` | The eight packages, the catalog of 23 shared version ranges, and `allowBuilds`. |
| `pnpm-lock.yaml` | From `pnpm import`, so every resolved version is npm's. |
| `packages/ui/package.json`, `packages/fake/package.json`, `apps/desktop/package.json`, `apps/light/package.json`, `apps/share/package.json`, `infrastructure/relay/package.json`, `infrastructure/share-worker/package.json`, `infrastructure/app-worker/package.json` | Each package's name and what its files import. |
| `tsconfig.base.json` | The webview programs' compiler options; the root `tsconfig.json`, renamed and without its `include`. |
| `packages/ui/tsconfig.json`, `packages/fake/tsconfig.json`, `apps/desktop/tsconfig.json`, `apps/light/tsconfig.json`, `apps/share/tsconfig.json` | One program per webview package. |
| `apps/light/phone/wallItem.ts` | The fixture builder that made the fake depend on an app. |
| `scripts/workspace.test.mjs` | The import rules and "a package declares what it imports". |

| Moved | To |
| --- | --- |
| `infrastructure/app-worker/package.json`, `package-lock.json` (the deploy tool) | `infrastructure/wrangler/` |
| `tsconfig.json` | `tsconfig.base.json` |

| Deleted | Why |
| --- | --- |
| `package-lock.json` | `pnpm-lock.yaml` replaces it. One left behind is bumped by release-please and read by `tauri-action` as "this project uses npm". |

**Order.** Tasks 0 to 10 in sequence. Vitest's `root` project is red from Task 1 until Task 7, because the fences in `scripts/` pin npm's spellings; until then each task runs the files it names.

---

### Task 0: The workspace and the baseline

**Files:** none in the repository.

**Interfaces:**
- Produces, in `<scratch>`: `s2-vitest-before-1.json`, `-2.json`, `-3.json`, `s2-counts-before.json`, `s2-builds-before.json`, `s2-wasm-before.txt`, `s2-cargo-before.txt`, `s2-tsc-before.txt`, and the script `vitest-count.mjs`.

- [ ] **Step 1: The branch and the tree**

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
git fetch --prune origin
git status --short --branch
git merge --ff-only origin/main
npm ci
(Get-PSDrive D).Free / 1GB
```

Expected: on `claude/pnpm-workspace`, clean, at `origin/main`; `npm ci` exits 0; at least 25 GB free. If the branch is not at `origin/main` and will not fast-forward, stop and tell the controller.

- [ ] **Step 2: Write `<scratch>/vitest-count.mjs`**

```js
// node vitest-count.mjs out.json run-1.json [run-2.json ...]   per-file test counts of a run
// node vitest-count.mjs --diff before.json after.json           the two, compared
import { readFileSync, writeFileSync } from "node:fs";

/** A test file's path from the repository, whatever checkout ran it. */
const rel = (name) => name.replaceAll("\\", "/").replace(/^.*?\/(?=(?:packages|apps|infrastructure|scripts|\.storybook)\/)/, "");

if (process.argv[2] === "--diff") {
  const [a, b] = process.argv.slice(3, 5).map((f) => JSON.parse(readFileSync(f, "utf8")));
  const sum = (m) => Object.values(m).reduce((n, v) => n + v, 0);
  console.log(`files ${Object.keys(a).length} -> ${Object.keys(b).length}; tests ${sum(a)} -> ${sum(b)}`);
  for (const file of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
    if (a[file] !== b[file]) console.log(`  ${file}: ${a[file] ?? "absent"} -> ${b[file] ?? "absent"}`);
} else {
  const counts = {};
  let failed = 0;
  for (const run of process.argv.slice(3)) {
    const report = JSON.parse(readFileSync(run, "utf8"));
    failed += report.numFailedTests;
    for (const file of report.testResults) counts[rel(file.name)] = file.assertionResults.length;
  }
  writeFileSync(process.argv[2], JSON.stringify(counts, null, 1));
  console.log(`${Object.keys(counts).length} files, ${Object.values(counts).reduce((n, v) => n + v, 0)} tests, ${failed} failed`);
}
```

- [ ] **Step 3: Run the suite, in three shards**

One command at a time; a long background run is killed here, and a shard is short enough to finish.

```powershell
npx vitest run --shard=1/3 --reporter=json --outputFile="<scratch>\s2-vitest-before-1.json"
npx vitest run --shard=2/3 --reporter=json --outputFile="<scratch>\s2-vitest-before-2.json"
npx vitest run --shard=3/3 --reporter=json --outputFile="<scratch>\s2-vitest-before-3.json"
node "<scratch>\vitest-count.mjs" "<scratch>\s2-counts-before.json" "<scratch>\s2-vitest-before-1.json" "<scratch>\s2-vitest-before-2.json" "<scratch>\s2-vitest-before-3.json"
```

Expected: `552 files, <N> tests, 0 failed`. Write `<N>` in the ledger. A failure here is `main`'s: stop and tell the controller.

- [ ] **Step 4: Time the type-check and build the five**

```powershell
$programs = '.', '.storybook', 'infrastructure/relay', 'infrastructure/share-worker', 'infrastructure/app-worker', 'packages/ui/tsconfig.web-worker.json', 'packages/ui/tsconfig.web-sw.json'
$sw = [Diagnostics.Stopwatch]::new()
$programs | ForEach-Object { $sw.Restart(); npx tsc -p $_; "{0,-44} exit {1} {2,5:N1}s" -f $_, $LASTEXITCODE, $sw.Elapsed.TotalSeconds } | Tee-Object "<scratch>\s2-tsc-before.txt"
$env:CC_wasm32_unknown_unknown = "C:\Program Files\LLVM\bin\clang.exe"
$env:AR_wasm32_unknown_unknown = "C:\Program Files\LLVM\bin\llvm-ar.exe"
npm run web:wasm
Get-FileHash dist-wasm\*.wasm -Algorithm SHA256 | ForEach-Object { "$($_.Hash)  $(Split-Path $_.Path -Leaf)" } | Set-Content "<scratch>\s2-wasm-before.txt"
npx vite build --config apps/desktop/vite.config.ts
npx vite build --config apps/light/vite.config.ts
npx vite build --config apps/light/vite.config.ts --mode web
npx vite build --config apps/share/vite.config.ts
npm run build-storybook
node "<scratch>\layout-builds.mjs" "<scratch>\s2-builds-before.json" desktop=apps/desktop/dist android=apps/light/dist-mobile web=apps/light/dist-web share=apps/share/dist-share storybook=storybook-static
```

Expected: seven `exit 0` lines; five builds listed with their file counts and bytes. Keep `storybook-static/` and the four `dist` folders out of the way of the "after" builds by copying nothing: `layout-builds.mjs` has already recorded them.

- [ ] **Step 5: Count the Rust tests**

```powershell
Get-Process cargo, rustc -ErrorAction SilentlyContinue   # must be empty
cargo test --workspace 2>&1 | Select-String '^test result' | ForEach-Object { $_.Line } | Set-Content "<scratch>\s2-cargo-before.txt"
(Get-Content "<scratch>\s2-cargo-before.txt").Count
```

Expected: a line per test binary, each `ok`. Task 8 changes comments and one panic message in Rust sources, so the counts must not move.

---

### Task 1: The deploy tool moves, and the manifests

**Files:**
- Move: `infrastructure/app-worker/package.json` → `infrastructure/wrangler/package.json`; `infrastructure/app-worker/package-lock.json` → `infrastructure/wrangler/package-lock.json`
- Create: `pnpm-workspace.yaml`, `pnpm-lock.yaml`, the eight package manifests
- Modify: `package.json`
- Delete: `package-lock.json`

**Interfaces:**
- Consumes: `<scratch>/workspace-manifests.mjs` (Appendix A), `<scratch>/lock-set.mjs` (Appendix D).
- Produces: the package names `@grimoire/ui`, `@grimoire/fake`, `@grimoire/desktop`, `@grimoire/light`, `@grimoire/share`, `@grimoire/relay`, `@grimoire/share-worker`, `@grimoire/app-worker`, each linked into the `node_modules` of the packages that declare it. The deploy tool at `infrastructure/wrangler/node_modules/wrangler/bin/wrangler.js`.

- [ ] **Step 1: Move the deploy tool, before its folder gets a second manifest**

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
New-Item -ItemType Directory infrastructure\wrangler | Out-Null
git mv infrastructure/app-worker/package.json infrastructure/wrangler/package.json
git mv infrastructure/app-worker/package-lock.json infrastructure/wrangler/package-lock.json
if (Test-Path infrastructure\app-worker\node_modules) { [IO.Directory]::Delete("$PWD\infrastructure\app-worker\node_modules", $true) }
```

In `infrastructure/wrangler/package.json` replace the `description` value, and nothing else — the `name` stays, because the lockfile repeats it:

```json
  "description": "The one tool that deploys the web app's Worker, and the lockfile that says exactly which bytes it is. npm's, on purpose, and no package of the pnpm workspace: `npm ci --ignore-scripts --prefix infrastructure/wrangler`, then `node ../wrangler/node_modules/wrangler/bin/wrangler.js …` from `infrastructure/app-worker` (that folder's README, \"Deploying\").",
```

- [ ] **Step 2: Check the tool installs and runs from where it is now**

```powershell
npm ci --ignore-scripts --prefix infrastructure/wrangler
node infrastructure/wrangler/node_modules/wrangler/bin/wrangler.js --version
git status --short infrastructure/wrangler
```

Expected: exit 0; `4.146.0`; the lockfile listed as `R` (renamed) with no `M` beside it. If `git status` shows the lockfile modified, restore it with `git checkout HEAD -- infrastructure/app-worker/package-lock.json` and repeat the move: its bytes are the pin.

- [ ] **Step 3: Pin pnpm, and turn npm's lockfile into pnpm's**

In the root `package.json`, after the `engines` block, add:

```json
  "packageManager": "pnpm@11.5.0+sha512.dbfcc4f81cf48597afd4bc391ffdf12c11f1a9fb83a395bfa6b0a2d9cc2fd8ffebafdb1ccbd529632153f793904c2615b7f09fe1a345473fd1c35845172a8eb1",
```

```powershell
pnpm --version
pnpm import
node "<scratch>\lock-set.mjs" pnpm-lock.yaml "<scratch>\s2-lock-single.json"
```

Expected: `11.5.0`; `pnpm-lock.yaml` written; `769 packages, 770 snapshots` (on `59d735fa`; whatever it prints is the number Step 6 must match). If `pnpm` is not found, run `corepack enable` once and repeat.

- [ ] **Step 4: Write the manifests**

```powershell
node "<scratch>\workspace-manifests.mjs" .
```

Expected, exactly:

```text
9 manifests; catalog of 23: @cloudflare/workers-types, @fontsource-variable/geist, @fontsource-variable/geist-mono, @fontsource/cinzel, @storybook/react-vite, @tanstack/react-query, @tanstack/react-virtual, @tauri-apps/api, @testing-library/react, @testing-library/user-event, @types/react, @types/react-dom, jsqr, keyrune, lucide-react, mana-font, motion, react, react-dom, storybook, vite, vitest, zustand
```

The script stops with a sentence instead if a name the root declares today is used by no package, or if it is run on a tree it has already rewritten. `pnpm-workspace.yaml` is then:

```yaml
packages:
  - packages/*
  - apps/*
  - infrastructure/relay
  - infrastructure/share-worker
  - infrastructure/app-worker

catalog:
  "@cloudflare/workers-types": "^5.20260828.1"
  "@fontsource-variable/geist": "^5.3.0"
  "@fontsource-variable/geist-mono": "^5.3.0"
  "@fontsource/cinzel": "^5.3.0"
  "@storybook/react-vite": 10.6.0
  "@tanstack/react-query": "^5.101.4"
  "@tanstack/react-virtual": "^3.14.9"
  "@tauri-apps/api": "^2"
  "@testing-library/react": "^16.3.2"
  "@testing-library/user-event": "^14.6.3"
  "@types/react": "^19.1.8"
  "@types/react-dom": "^19.1.6"
  jsqr: "^1.4.0"
  keyrune: "^3.19.0"
  lucide-react: "^1.28.0"
  mana-font: "^1.18.0"
  motion: "^13.1.0"
  react: "^19.2.0"
  react-dom: "^19.2.0"
  storybook: 10.6.0
  vite: "^8.3.1"
  vitest: "^5.0.2"
  zustand: "^5.0.14"

allowBuilds:
  esbuild: false
```

Add three comment blocks to it by hand, above `packages:`, `catalog:` and `allowBuilds:`:

```yaml
# The workspace: the shared UI and the fake, the three apps, and the three Workers.
# `infrastructure/wrangler` is not here and must never be: it is the deploy tool, npm's, with a
# lockfile of its own, and a glob such as `infrastructure/*` would take it in
# (`scripts/release-rule.test.mjs` holds this list).
```

```yaml
# One range for every name that more than one package declares; a manifest writes `catalog:` for
# it. A name only one package declares keeps its range in that manifest.
```

```yaml
# pnpm runs no dependency's install script unless it is named here, and fails the install on one
# it has not been told about. esbuild's only swaps a JS launcher for the native binary it would
# start anyway; it comes in under Storybook alone, which builds without it (measured 2026-10-08).
```

- [ ] **Step 5: Three root scripts that name npm**

In the root `package.json`:

| Script | Was | Is |
| --- | --- | --- |
| `mobile:android` | `npm run tauri:light -- android dev` | `pnpm tauri:light android dev` |
| `lint` | `eslint . --max-warnings 0 && npm run lint:claude` | `eslint . --max-warnings 0 && pnpm lint:claude` |
| `verify` | `npm run build && vite build --config apps/light/vite.config.ts && npm run lint && npm run lint:rust && npm run test:run && cargo test --workspace && cargo test --manifest-path crates/card-scanner/Cargo.toml --target-dir crates/card-scanner/target --features cli` | `pnpm build && vite build --config apps/light/vite.config.ts && pnpm lint && pnpm lint:rust && pnpm test:run && cargo test --workspace && cargo test --manifest-path crates/card-scanner/Cargo.toml --target-dir crates/card-scanner/target --features cli` |

`tauri` stays `cd apps/desktop && tauri` and `tauri:light` stays `cd apps/light && tauri`: two tests and the release action read those two strings.

- [ ] **Step 6: Install, and hold the lockfile to what npm had resolved**

```powershell
git rm -q package-lock.json
[IO.Directory]::Delete("$PWD\node_modules", $true)
pnpm install
node "<scratch>\lock-set.mjs" pnpm-lock.yaml "<scratch>\s2-lock-split.json"
node "<scratch>\lock-set.mjs" --diff "<scratch>\s2-lock-single.json" "<scratch>\s2-lock-split.json"
pnpm install --frozen-lockfile
```

Expected: `pnpm install` exits 0 and warns once, `There are cyclic workspace dependencies: …\packages\fake, …\packages\ui` — the design's cycle, the UI's tests against the fake. The comparison prints `packages: N -> N, 0 gone, 0 new` and `snapshots: M -> M, 0 gone, 0 new` and exits 0. The frozen install exits 0, which is what CI will ask.

If the comparison lists anything, a range was resolved again: stop, and do not "fix" it by editing the lockfile.

- [ ] **Step 7: The tree still builds as one program**

```powershell
pnpm exec tsc
pnpm exec vite build --config apps/desktop/vite.config.ts
```

Expected: both exit 0. The root `tsconfig.json` and the `@/` alias are untouched so far; this proves the manifests alone.

- [ ] **Step 8: Checkpoint** (controller)

```powershell
git add -A pnpm-workspace.yaml pnpm-lock.yaml package.json packages/ui/package.json packages/fake/package.json apps/desktop/package.json apps/light/package.json apps/share/package.json infrastructure
git commit -m "wip(workspace): the manifests, the lockfile and the deploy tool's folder"
```

---

### Task 2: Imports by package name

**Files:**
- Create: `apps/light/phone/wallItem.ts`
- Modify: `packages/fake/fixtures.ts`, `apps/light/phone/CardWall.stories.tsx`, `apps/light/phone/Shell.stories.tsx`, `packages/fake/aliases.ts`, `packages/fake/images.test.ts`, `vite.base.ts`, `apps/light/phone/fence.test.ts`, `apps/share/SharePage.test.tsx`, `.design-sync/tsconfig.json`, `.storybook/main.ts` (a comment), `apps/light/vite.config.ts` (a comment)
- Modify, by script: 174 files (Step 3)

**Interfaces:**
- Consumes: the package names from Task 1; `<scratch>/workspace-imports.mjs` (Appendix B).
- Produces: `wallItem(card: FakeCard, over?: Partial<WallItem>): WallItem`, exported from `apps/light/phone/wallItem.ts`. A fifth entry in `FAKE_ALIASES`. `resolve.dedupe` in `vite.base.ts`.

- [ ] **Step 1: Move `wallItem` out of the fake**

Create `apps/light/phone/wallItem.ts`:

```ts
import type { FakeCard } from "@grimoire/fake/cards";
import { formatPrice } from "@grimoire/ui/lib/prices";
import type { WallItem } from "./CardWall";

/**
 * A fixture printing as the phone face's wall draws it — the shape `items.ts`' `searchItem` gives
 * a search result, filled from the corpus's own row, so the art, the chin and the price are a
 * real card's. `items.ts` itself takes the IPC DTOs, and `items.test.ts` holds what it picks out
 * of each; a story built on this is about the wall, not about that mapping. Unmarked, held once
 * and named by its printing, as a search result for a card not owned is.
 *
 * **Here and not in the fake's `fixtures.ts`, where it was until 2026-10-08**: it builds this
 * app's type, and a fake that imported that type depended on an app. Not in a story file either
 * — every export of one is indexed as a story (`packages/fake/fixtures.ts`'s header) — and not in
 * `testing.tsx`, which imports Vitest and so cannot be reached from a story. The card is imported
 * as a type, so `fence.test.ts` sees no edge from the phone face to the fake here.
 */
export function wallItem(card: FakeCard, over: Partial<WallItem> = {}): WallItem {
  return {
    key: card.id,
    cardId: card.id,
    name: card.name,
    rarity: card.rarity,
    chin: {
      setCode: card.setCode,
      collectorNumber: card.collectorNumber,
      printingTitle: card.setName,
    },
    finish: null,
    money: formatPrice(card.priceUsd, "usd"),
    count: 1,
    pressLabel: `${card.name}, ${card.setCode.toUpperCase()} ${card.collectorNumber}`,
    ...over,
  };
}
```

In `packages/fake/fixtures.ts` delete three things: the line `import { formatPrice } from "@/lib/prices";`, the line `import type { WallItem } from "../../apps/light/phone/CardWall";`, and the whole `wallItem` function with the doc comment above it (from `/**` + ` * A fixture printing as the phone face's wall draws it` down to the function's closing `}` and the blank line after it). `formatPrice` has no other use in that file.

In `apps/light/phone/CardWall.stories.tsx` and `apps/light/phone/Shell.stories.tsx`, both:

```ts
// was
import { printing, wallItem } from "../../../packages/fake/fixtures";
import { CardWall, type WallItem } from "./CardWall";
// is
import { printing } from "../../../packages/fake/fixtures";
import { CardWall, type WallItem } from "./CardWall";
import { wallItem } from "./wallItem";
```

The relative path to the fake stays for one more step: the script rewrites it with the rest.

- [ ] **Step 2: Read what the script will do**

```powershell
node "<scratch>\workspace-imports.mjs" . --list | Tee-Object "<scratch>\s2-imports-dry.txt" | Select-String -NotMatch "^\s+(a file's text|into the root)"
```

Expected among the tally lines, exactly these twelve that rewrite:

```text
    2  app-worker -> ui: relative path -> package name
    8  desktop -> fake: relative path -> package name
   16  desktop -> ui: @/ alias -> package name
   56  fake -> ui: @/ alias -> package name
    2  fake -> ui: relative path -> package name
   81  light -> fake: relative path -> package name
  529  light -> ui: @/ alias -> package name
    2  root -> fake: relative path -> package name
   11  root -> ui: @/ alias -> package name
   25  share -> ui: @/ alias -> package name
    6  share-worker -> relay: relative path -> package name
   72  ui -> fake: relative path -> package name
would rewrite 810 specifiers in 174 of 1484 files; left 168 as written
```

and, left as written: `2  fake -> ui: left, named exception` (both in `packages/fake/images.ts`), thirteen `Node loads this file (rule 4)` lines (the light app's two Vite configs, `.storybook/main.ts`, `vite.base.ts`, three scripts), and one module import `into the root, from ui` — `packages/ui/stories.test.tsx -> ../../.storybook/preview`, which is the workbench's own file and belongs to no package. **A line `fake -> light` or `-> desktop: relative path -> package name` means Step 1 was missed or a new cross-app import has landed: stop.** The file total moves with `main`; the twelve counts are what matter.

- [ ] **Step 3: Run it**

```powershell
node "<scratch>\workspace-imports.mjs" . --write
node "<scratch>\workspace-imports.mjs" .
```

Expected: `rewrote 810 specifiers in 174 of 1484 files; left 168 as written`, and then, from the second run, `would rewrite 0 specifiers in 0 of 1484 files; left 168 as written` — there is nothing left for it to do.

It edits the string of an import and nothing else. Prose that names a UI module as `@/lib/x` in a comment is left: that is the module's name inside the shared UI. So are the sample sources the two fence tests hold in strings, which Steps 7 and 8 deal with by hand.

- [ ] **Step 4: The fake answers for the images module under both of its names**

In `packages/fake/aliases.ts`, the list becomes:

```ts
export const FAKE_ALIASES: { find: RegExp; replacement: string }[] = [
  { find: /^@tauri-apps\/api\/core$/, replacement: fake("core.ts") },
  { find: /^@tauri-apps\/api\/event$/, replacement: fake("event.ts") },
  { find: /^@tauri-apps\/api\/window$/, replacement: fake("window.ts") },
  { find: /^@\/lib\/images$/, replacement: fake("images.ts") },
  { find: /^@grimoire\/ui\/lib\/images$/, replacement: fake("images.ts") },
];
```

In its doc comment, replace the first sentence's "**The four specifiers the fake answers for**" with "**The four modules the fake answers for, by every name they are imported by**", and add this paragraph after the "**Exact-match rules…**" one:

```ts
 * **The images module has two names since the workspace (2026-10-08)**: `@/lib/images` inside the
 * shared UI, and `@grimoire/ui/lib/images` from every other package — the light app's deck page
 * and scanner tray, and the fake's own `db.ts`. A rule for one name alone would hand those three
 * the real module beside the fake one. `images.test.ts` holds both rules.
```

In `packages/fake/images.test.ts` add the import beside its others and the case inside its first `describe`:

```ts
import aliasesText from "./aliases.ts?raw";
```

```ts
  it("is what both of the real module's names resolve to in a fake host", () => {
    // Read as text: `aliases.ts` is Node code, and a page-side import of it would run
    // `fileURLToPath` over an address Vite has already rewritten.
    expect(aliasesText).toContain('{ find: /^@\\/lib\\/images$/, replacement: fake("images.ts") }');
    expect(aliasesText).toContain(
      '{ find: /^@grimoire\\/ui\\/lib\\/images$/, replacement: fake("images.ts") }',
    );
  });
```

In `.storybook/main.ts` change the comment's "The fake's four are" to "The fake's rules are", and in `apps/light/vite.config.ts` change "**the four aliases `.storybook/main.ts` declares" to "**the aliases `.storybook/main.ts` declares" and "`@/lib/images` has to be tried before that prefix" to "`@/lib/images` has to be tried before that prefix (the package's name for it, `@grimoire/ui/lib/images`, has a rule of its own)".

- [ ] **Step 5: One React**

In `vite.base.ts`:

```ts
  resolve: {
    alias: { "@": UI },
    // One copy of each, whichever package's import reached it first. pnpm already gives every
    // package the same files — the three builds were byte for byte the same with and without
    // this line, 2026-10-08 — so it holds nothing today; it is here for the day two packages
    // declare different ranges and a second React would otherwise be a silent second context.
    // Resolved from each program's root: every app declares the first two, and the root manifest
    // declares all three for the programs rooted there (Vitest, Storybook) and for the two apps
    // that do not import the query library themselves.
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
```

and correct two comments in the same file: `/** What `@/*` means, as `tsconfig.json`'s `paths`…` becomes `tsconfig.base.json`'s; and in the `fs.allow` comment replace the sentence "It stops being so the day an app has a `package.json` of its own and nothing above it says workspace." with "Each app has a `package.json` of its own since 2026-10-08, and `pnpm-workspace.yaml` at the root is what Vite's default now finds."

- [ ] **Step 6: The converter's two aliases, under the package's name too**

In `.design-sync/tsconfig.json`, `paths` gains four lines, each above the wildcard it is an exception to:

```jsonc
      "@/lib/images": ["../packages/fake/images.ts"],
      "@/lib/core": ["./core-shim.ts"],
      "@/*": ["../packages/ui/*"],
      // The same two exceptions under the name every other package uses (2026-10-08): the fake's
      // `db.ts` imports the images module as `@grimoire/ui/lib/images`.
      "@grimoire/ui/lib/images": ["../packages/fake/images.ts"],
      "@grimoire/ui/lib/core": ["./core-shim.ts"],
      "@grimoire/ui/*": ["../packages/ui/*"],
      "@grimoire/fake/*": ["../packages/fake/*"]
```

Nothing in this plan runs the converter; it is run by the owner, outside the repository.

- [ ] **Step 7: The phone fence follows a package name**

In `apps/light/phone/fence.test.ts`, replace `stemOf` and `inRepo` (and the comments above them) with:

```ts
/**
 * How a specifier names a folder of this repository without spelling the path: the shared UI's
 * own alias, and a workspace package's name. A file outside `packages/ui` names a UI module by
 * the package (`@grimoire/ui/lib/store`), a file inside it by the alias (`@/lib/store`), and the
 * walk goes through both kinds.
 */
const PACKAGE_ROOTS: readonly (readonly [prefix: string, root: string])[] = [
  ["@/", "/packages/ui/"],
  ["@grimoire/ui/", "/packages/ui/"],
  ["@grimoire/fake/", "/packages/fake/"],
];

/**
 * `spec` as written in `from`, as a root-absolute path with its `.` and `..` folded away. A
 * root-absolute specifier is the root's already — Vite resolves `/packages/ui/lib/store` against
 * the root, which is the repository here — and an alias or a package name is its folder.
 */
function stemOf(from: string, spec: string): string {
  const named = PACKAGE_ROOTS.find(([prefix]) => spec.startsWith(prefix));
  const raw = named
    ? `${named[1]}${spec.slice(named[0].length)}`
    : spec.startsWith("/")
      ? spec
      : `${from.slice(0, from.lastIndexOf("/"))}/${spec}`;
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * Ours to follow: the alias, a workspace package's name, a relative path, or a root-absolute
 * one. Any other bare name is somebody else's package, and so is a protocol-relative `//host/…`.
 */
const inRepo = (spec: string): boolean =>
  PACKAGE_ROOTS.some(([prefix]) => spec.startsWith(prefix)) ||
  spec.startsWith(".") ||
  (spec.startsWith("/") && !spec.startsWith("//"));
```

In the `CLEAN` tree of "on a tree with a weld in it", the tab bar is written the way a phone file is now:

```ts
      "/apps/light/phone/TabBar.tsx": `import { NAV } from "@grimoire/ui/components/nav";`,
```

and three cases gain a line each:

```ts
    // in "refuses the store, however it is imported", after the first `expect`
      expect(withTabBar(`import { useAppStore } from "@grimoire/ui/lib/store";`).refused).toEqual(refused);
    // in "refuses Tauri everywhere but behind the core's door", the first line becomes
      const throughTheDoor = withTabBar(`import { ipc } from "@grimoire/ui/lib/ipc";`);
    // in "says so when an import leads somewhere it cannot follow", after the `./testing` case
      // The fake is a package of this repository and is not in the tree either: a phone file that
      // reached it at runtime would be a part of the graph nobody checked.
      expect(withTabBar(`import { installWorld } from "@grimoire/fake/world";`).blind).toEqual([
        `${VIA} → @grimoire/fake/world`,
      ]);
```

Update the file's header where it says "relative specifiers are followed as well as `@/…` ones" to "relative specifiers and a package's name are followed as well as `@/…` ones".

- [ ] **Step 8: The share page's fence follows a package name**

In `apps/share/SharePage.test.tsx`, in `resolve`:

```ts
    // was
    if (spec.startsWith("@/")) stem = normalise(`../../packages/ui/${spec.slice(2)}`);
    // is: the page names a UI module by the package, and the UI's own files by the alias
    const named = ["@/", "@grimoire/ui/"].find((prefix) => spec.startsWith(prefix));
    if (named) stem = normalise(`../../packages/ui/${spec.slice(named.length)}`);
```

and the list of what the bundle may not name gains the package's spelling of each:

```ts
  const FORBIDDEN = [
    "@/lib/core",
    "@/lib/ipc",
    "@/features",
    "@grimoire/ui/lib/core",
    "@grimoire/ui/lib/ipc",
    "@grimoire/ui/features",
    "@tauri-apps/",
  ];
```

In the doc comment above the `describe`, "relative specifiers are followed as well as `@/…` ones" becomes "relative specifiers are followed as well as `@/…` and `@grimoire/ui/…` ones".

- [ ] **Step 9: Run what this task touched, and see each fence refuse once**

```powershell
pnpm exec tsc
pnpm exec vitest run apps/light/phone/fence.test.ts apps/share/SharePage.test.tsx packages/fake
```

Expected: `tsc` exits 0; every file passes. Then break each fence with the import it exists to refuse, written the new way:

```powershell
$tab = Get-Content apps/light/phone/TabBar.tsx -Raw; $page = Get-Content apps/share/SharePage.tsx -Raw
$enc = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText("$PWD\apps\light\phone\TabBar.tsx", "import ""@grimoire/ui/lib/store"";`n$tab", $enc)
[IO.File]::WriteAllText("$PWD\apps\share\SharePage.tsx", "import ""@grimoire/ui/lib/ipc"";`n$page", $enc)
pnpm exec vitest run apps/light/phone/fence.test.ts apps/share/SharePage.test.tsx
[IO.File]::WriteAllText("$PWD\apps\light\phone\TabBar.tsx", $tab, $enc); [IO.File]::WriteAllText("$PWD\apps\share\SharePage.tsx", $page, $enc)
git diff --stat -- apps/light/phone/TabBar.tsx apps/share/SharePage.tsx
```

Expected: **two failed tests**, one in each file — the phone's trail ending `→ /packages/ui/lib/store.ts`, the share page's `SharePage.tsx → @grimoire/ui/lib/ipc` — and after the restore, the same diff those two files had before (their rewritten imports, nothing more). Write both failure lines in the ledger.

- [ ] **Step 10: Checkpoint** (controller)

```powershell
git add -A apps packages .storybook infrastructure .design-sync/tsconfig.json vite.base.ts
git commit -m "wip(workspace): imports by package name"
```

---

### Task 3: One TypeScript program and one Vitest project per package

**Files:**
- Move: `tsconfig.json` → `tsconfig.base.json`
- Create: `packages/ui/tsconfig.json`, `packages/fake/tsconfig.json`, `apps/desktop/tsconfig.json`, `apps/light/tsconfig.json`, `apps/share/tsconfig.json`
- Modify: `.storybook/tsconfig.json`, `.design-sync/tsconfig.dts.json`, `apps/desktop/tsconfig.node.json` (comments), `package.json` (four scripts), `vitest.config.ts`

**Interfaces:**
- Consumes: the workspace links from Task 1 and the imports from Task 2 — an app's program reaches the shared UI through `node_modules/@grimoire/ui`.
- Produces: `tsc -p <package folder>` for each of the five webview packages; the Vitest project names `ui`, `fake`, `desktop`, `light`, `share`, `relay`, `share-worker`, `app-worker`, `root`.

- [ ] **Step 1: The base**

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
git mv tsconfig.json tsconfig.base.json
```

In `tsconfig.base.json`:

1. Delete everything after the `compilerOptions` block: the long `//` comment that begins "The shared UI and the three apps' pages", `include`, `exclude` with its comments, and `references`. The file ends with the `}` of `compilerOptions` and the `}` of the file, and the comma after `compilerOptions`' closing brace goes.
2. Add this as the file's first member, above `"compilerOptions"`:

```jsonc
  /* What every webview program in the workspace is compiled with: the shared UI's, the fake's and
     the three apps'. Each has a `tsconfig.json` of its own that extends this file and says only
     what it includes. Until 2026-10-08 this was the root `tsconfig.json`, and included all of
     them as one program.

     The three Workers do not extend it — their options differ on purpose, and
     `infrastructure/relay/tsconfig.json` says how — and neither do the two `WebWorker` programs
     under `packages/ui`. */
```

3. Replace the one-line comment above `paths` with:

```jsonc
    /* `@/` is the shared UI's own alias, and only a file inside `packages/ui` may write it
       (`scripts/workspace.test.mjs`). It is declared here, not in that package's config, because
       every program that reaches a UI module compiles that module's source, `@/` imports and
       all. No `baseUrl`: deprecated in TS 6, and `paths` resolve from the file that declares
       them — this one, whichever config extends it. */
```

4. In the `types` comment, `packages/ui/vite-env.d.ts` is still where `vite/client` arrives for the UI's program; add one sentence at the end of that paragraph: "A program that does not include that file names `vite/client` in `types` itself."

- [ ] **Step 2: The five programs**

`packages/ui/tsconfig.json`:

```jsonc
{
  /* The shared UI's program: everything in this folder, tests and stories included, and through
     them the fake (`@grimoire/fake`, which the tests import by name).

     **Three files here are not in it**: the web host's database Worker and its card scanner's,
     which run in dedicated Workers and are checked by `tsconfig.web-worker.json`, and its service
     worker, checked by `tsconfig.web-sw.json` — each under the `WebWorker` lib. That lib and this
     program's `DOM` declare the same globals differently, so each file is left out here rather
     than given both. Nothing imports them — the page names them by URL — so the exclusion holds;
     a module that did import one would pull it straight back in.

     `node_modules` is named because `exclude` replaces TypeScript's default list, and pnpm puts
     one in every package: its links lead to the fake and from there back here. */
  "extends": "../../tsconfig.base.json",
  "include": ["."],
  "exclude": ["node_modules", "lib/core/web/worker.ts", "lib/core/web/scanWorker.ts", "lib/core/web/sw/sw.ts"]
}
```

`packages/fake/tsconfig.json`:

```jsonc
{
  /* The fake's program. It was part of `.storybook/tsconfig.json`'s until 2026-10-08, and keeps
     two things from that arrangement:

     - `vite/client`, because this program does not hold `packages/ui/vite-env.d.ts` and the UI
       modules the fake imports read `import.meta.env`;
     - `.storybook/node-url.d.ts`, by path, because `aliases.ts` is Node code that imports
       `node:url` and `@types/node` is not installed (that file says why). */
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["vite/client"] },
  "include": [".", "../../.storybook/node-url.d.ts"],
  "exclude": ["node_modules"]
}
```

`apps/desktop/tsconfig.json`:

```jsonc
{
  /* The desktop app's program: its entry and boot components, and every shared-UI module they
     reach — which is nearly all of them, checked a second time here. The workspace's design
     accepts that cost; `packages/ui/tsconfig.json` is the program that owns those files.

     `src` and no more of this folder: the rest is the Rust host and a Vite config, which is
     `tsconfig.node.json`'s.

     Two things an app's program does not get by importing the UI, and has to name:

     - `vite/client` — `packages/ui/vite-env.d.ts` is in no import graph;
     - `packages/ui/test-setup.ts` — the one setup file every Vitest project runs under
       (`vitest.config.ts`). Its import of `@testing-library/jest-dom/vitest` is what declares
       `toBeInTheDocument` and the rest. Measured 2026-10-08 without it: 21 errors here, 406 in
       the light app's program and 39 in the share page's. */
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["vite/client"] },
  "include": ["src", "../../packages/ui/test-setup.ts"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

`apps/light/tsconfig.json`:

```jsonc
{
  /* The light app's program: this folder and every shared-UI module it reaches. `types` and the
     setup file are `apps/desktop/tsconfig.json`'s, for its reasons.

     Not its build: the two Vite configs are Node programs and this one has no Node types, `dist*`
     is what a build wrote, and `src-tauri` is the Android host. `node_modules` is named because
     `exclude` replaces TypeScript's default list. */
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["vite/client"] },
  "include": [".", "../../packages/ui/test-setup.ts"],
  "exclude": ["node_modules", "vite.*.ts", "dist*", "src-tauri"]
}
```

`apps/share/tsconfig.json`:

```jsonc
{
  /* The public share page's program: this folder and the shared-UI modules it reaches, which is
     a small part of them — it has no core and no `ipc` (`SharePage.test.tsx` holds that).
     `types` and the setup file are `apps/desktop/tsconfig.json`'s, for its reasons; the Vite
     config and the build's output are left out for `apps/light/tsconfig.json`'s. */
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["vite/client"] },
  "include": [".", "../../packages/ui/test-setup.ts"],
  "exclude": ["node_modules", "vite.*.ts", "dist*"]
}
```

- [ ] **Step 3: The three configs that named the old one**

`.storybook/tsconfig.json`, whole:

```jsonc
{
  /* The workbench's own program — `main.ts`, `preview.tsx` and the design-system page — split
     from the packages' on purpose: `main.ts` is Node code that imports `node:url`, and a separate
     program is what lets `node-url.d.ts` declare that one module for this folder; see that file
     for why `@types/node` is not installed instead.

     The fake was in this program until 2026-10-08. It has `packages/fake/tsconfig.json` now,
     which names `node-url.d.ts` by path for `aliases.ts`.

     `vite/client` is listed because this program does not contain `packages/ui/vite-env.d.ts`
     and so does not inherit its triple-slash reference; `preview.tsx`'s three CSS side-effect
     imports need the `declare module "*.css"` it carries.

     `extends` inherits `paths` from the base, and a relative path in an extended config resolves
     against the file that *declared* it — so `@/*` still points at `<repo>/packages/ui/*`. */
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "types": ["vite/client"]
  },
  "include": ["**/*"]
}
```

`.design-sync/tsconfig.dts.json`: `"extends": "../tsconfig.json"` becomes `"extends": "../tsconfig.base.json"`. Nothing else in that file.

`apps/desktop/tsconfig.node.json`, comments only — four phrases, so that each sentence is true again:

| Was | Is |
| --- | --- |
| `nothing the root program includes may join it` | `nothing a package's program includes may join it` |
| `and the root `tsconfig.json` includes `packages/ui`` | `and `packages/ui/tsconfig.json` includes that whole folder` |
| ``npm run build` runs `tsc` and a `tsc -p` for each of the other programs` | ``pnpm build` runs a `tsc -p` for each program` |
| `the reference in the root `tsconfig.json`` | `the reference in `tsconfig.json`, beside this file,` |

- [ ] **Step 4: Four root scripts**

| Script | Is |
| --- | --- |
| `build` | `tsc -p packages/ui && tsc -p packages/fake && tsc -p apps/desktop && tsc -p apps/light && tsc -p apps/share && tsc -p .storybook && tsc -p infrastructure/relay && tsc -p infrastructure/share-worker && tsc -p infrastructure/app-worker && tsc -p packages/ui/tsconfig.web-worker.json && tsc -p packages/ui/tsconfig.web-sw.json && vite build --config apps/desktop/vite.config.ts` |
| `share:build` | `tsc -p apps/share && vite build --config apps/share/vite.config.ts` |
| `mobile:build` | `tsc -p apps/light && vite build --config apps/light/vite.config.ts` |
| `web:build` | `tsc -p apps/light && tsc -p packages/ui/tsconfig.web-worker.json && tsc -p packages/ui/tsconfig.web-sw.json && vite build --config apps/light/vite.config.ts --mode web` |

Each app's build now checks that app's program where it checked the whole webview side. `build` — which `verify` and CI's `frontend` job run — checks every program.

- [ ] **Step 5: `vitest.config.ts`**

Add above `export default`:

```ts
/**
 * One Vitest project. `extends: true` gives it everything this file sets — the plugins, the
 * alias, jsdom, the one setup file, the timeout — and leaves its root where this file is. That
 * root is not negotiable: thirty-eight `import.meta.glob` calls in the suite start their pattern
 * at `/`, which is the repository only while a project's root is.
 */
const project = (name: string, include: string[]) => ({
  extends: true as const,
  test: { name, include },
});
```

Replace the `include: [ … ],` property with `projects: [ … ],`. **Every comment that sits above a glob today moves with its glob, word for word**; the block below shows where each goes by its first words.

```ts
      // ⚠️ A folder no project's glob names is collected by **nothing**, and `vitest run <that
      // folder>` answers `No test files found` — which prints on stdout and is easy to read as a
      // pass.
      //
      // One project per package, named for it since 2026-10-08, so `vitest run --project light`
      // is that package's tests. The suite is still one program: one root, one environment, one
      // setup file. `scripts/ci-route.test.mjs` mirrors these globs.
      projects: [
        // The shared UI. No `*.stories.tsx` is ever collected as a **test file** — …
        project("ui", ["packages/ui/**/*.test.{ts,tsx}"]),
        // The Storybook fake, in scope so the fake backend is covered by the one suite …
        project("fake", ["packages/fake/**/*.test.ts"]),
        // The desktop app's own page — …
        project("desktop", ["apps/desktop/src/**/*.test.{ts,tsx}"]),
        // The **light app** — …
        project("light", ["apps/light/**/*.test.{ts,tsx}"]),
        // The **public web viewer** — …
        project("share", ["apps/share/**/*.test.{ts,tsx}"]),
        // The Cloudflare relay's pure logic, …
        project("relay", ["infrastructure/relay/src/**/*.test.ts"]),
        // The *share* Worker — …
        project("share-worker", ["infrastructure/share-worker/src/**/*.test.ts"]),
        // The third Worker — …
        project("app-worker", ["infrastructure/app-worker/src/**/*.test.ts"]),
        // The root package's own two folders, which belong to no other.
        //
        // The workbench's own folder. Nothing in it is a test since the fake moved out, …
        //
        // CI's own router, `scripts/ci-route.mjs`, and the fences beside it: …
        project("root", [".storybook/**/*.test.ts", "scripts/**/*.test.mjs"]),
      ],
```

The old ⚠️ comment above `include` is replaced by the one above `projects`. In the file's header comment, "The one test program: every package's tests, from the repository root" gains ", as one project per package". Everything else in the file — `environment`, `setupFiles`, `testTimeout`, `css`, `coverage` — stays where it is, above or below the list.

- [ ] **Step 6: Run and time them**

```powershell
$programs = 'packages/ui', 'packages/fake', 'apps/desktop', 'apps/light', 'apps/share', '.storybook', 'infrastructure/relay', 'infrastructure/share-worker', 'infrastructure/app-worker', 'packages/ui/tsconfig.web-worker.json', 'packages/ui/tsconfig.web-sw.json'
$sw = [Diagnostics.Stopwatch]::new()
$programs | ForEach-Object { $sw.Restart(); pnpm exec tsc -p $_; "{0,-44} exit {1} {2,5:N1}s" -f $_, $LASTEXITCODE, $sw.Elapsed.TotalSeconds } | Tee-Object "<scratch>\s2-tsc-after.txt"
pnpm exec tsc -p .design-sync/tsconfig.dts.json 2>&1 | Select-String 'error TS' | Measure-Object | ForEach-Object Count
pnpm exec vitest list --filesOnly 2>&1 | Select-String '\.test\.' | ForEach-Object { if ("$_" -match '^\[([^\]]+)\]') { $Matches[1] } } | Group-Object | ForEach-Object { "{0,5}  {1}" -f $_.Count, $_.Name }
```

Expected: eleven `exit 0` lines, 65 to 75 s in all. The planning session measured 32 s for the one webview program these five replace; `s2-tsc-before.txt` has the whole of "before". Write both totals in the ledger — the spec asks for them, and the pull request states them. The design-sync program prints `9`, the number it prints on `main`. The project counts:

```text
    4  app-worker
    2  desktop
    8  fake
   34  light
   15  relay
   11  root
    2  share
    3  share-worker
  473  ui
```

552 in all, the baseline's number. A file under a different project, or a total that is not the baseline's, is a glob that moved.

- [ ] **Step 7: Checkpoint** (controller)

```powershell
git add -A tsconfig.base.json packages/ui/tsconfig.json packages/fake/tsconfig.json apps/desktop/tsconfig.json apps/desktop/tsconfig.node.json apps/light/tsconfig.json apps/share/tsconfig.json .storybook/tsconfig.json .design-sync/tsconfig.dts.json package.json vitest.config.ts
git commit -m "wip(workspace): a TypeScript program and a Vitest project per package"
```

---

### Task 4: The fences for the rules

**Files:**
- Create: `scripts/workspace.test.mjs`
- Modify: `eslint.config.js`, `scripts/vite-base.test.mjs`, `packages/ui/lib/dndManager.test.ts`

**Interfaces:**
- Consumes: the eight manifests (Task 1), the rewritten imports (Task 2).
- Produces: nothing another task calls. `scripts/workspace.test.mjs` is the test Review Focus 5 names.

- [ ] **Step 1: Write the failing test**

Copy `<scratch>/workspace.test.mjs` to `scripts/workspace.test.mjs` (Appendix E is its source). Then, to see it fail before it passes, take one declaration away:

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
Copy-Item "<scratch>\workspace.test.mjs" scripts\workspace.test.mjs
$ui = Get-Content packages/ui/package.json -Raw
[IO.File]::WriteAllText("$PWD\packages\ui\package.json", ($ui -replace '\s*"prosemirror-view": "[^"]+",', ''), [Text.UTF8Encoding]::new($false))
pnpm exec vitest run scripts/workspace.test.mjs
```

Expected: FAIL, `is declared in that package's own manifest`, with `/packages/ui/features/decks/NoteEditor.tsx → prosemirror-view` — the import npm's hoisting carried for months.

- [ ] **Step 2: Restore, and see it pass**

```powershell
[IO.File]::WriteAllText("$PWD\packages\ui\package.json", $ui, [Text.UTF8Encoding]::new($false))
git diff --stat -- packages/ui/package.json
pnpm exec vitest run scripts/workspace.test.mjs
```

Expected: no diff; `Tests  8 passed (8)`. It takes about 25 s, nearly all of it reading the tree.

- [ ] **Step 3: See the other two rules refuse**

```powershell
$app = Get-Content apps/light/LightApp.tsx -Raw
[IO.File]::WriteAllText("$PWD\apps\light\LightApp.tsx", "import { cn as a } from ""@/lib/utils"";`nimport { cn as b } from ""../../packages/ui/lib/utils"";`nexport const keep = [a, b];`n$app", [Text.UTF8Encoding]::new($false))
pnpm exec vitest run scripts/workspace.test.mjs
```

Expected: two failures, `/apps/light/LightApp.tsx → @/lib/utils` under "uses `@/` only inside the shared UI" and `/apps/light/LightApp.tsx → ../../packages/ui/lib/utils` under "names another package's module by the package, not by a path". Leave the file broken for Step 5.

- [ ] **Step 4: The same two rules where an editor shows them**

In `eslint.config.js`, add three blocks as the last entries of the `tseslint.config(…)` call, after the `react-hooks/incompatible-library` block:

```js
  // The workspace's import rules, where an editor shows them (2026-10-08). The fence is
  // `scripts/workspace.test.mjs`: it also reads `vi.mock`, `import()` and a stylesheet, and it
  // holds the rule this cannot — that a package declares what it imports.
  //
  // The patterns are written without a backslash on purpose: `[.]` is a dot in a regular
  // expression and nothing in a JavaScript string.
  {
    files: ["apps/**/*.{ts,tsx}", "packages/fake/**/*.ts", "infrastructure/**/*.ts", ".storybook/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/**"],
              message:
                "`@/` is the shared UI's own alias. Outside packages/ui, name the module by its package: `@grimoire/ui/…`.",
            },
            {
              regex: "^([.][.]/)+(packages|apps|infrastructure)/[^?]*$",
              message:
                "Name another package's module by the package (`@grimoire/ui/…`, `@grimoire/fake/…`), not by a path.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^([.][.]/)+(fake|packages|apps|infrastructure)/[^?]*$",
              message: "Name another package's module by the package (`@grimoire/fake/…`), not by a path.",
            },
          ],
        },
      ],
    },
  },
  // A file Node loads itself reaches source by path (rule 4): Vite bundles what a config imports
  // by path, and leaves a package name to Node.
  {
    files: ["**/vite.*.ts", ".storybook/main.ts"],
    rules: { "no-restricted-imports": "off" },
  },
```

A read of a file's text (`…?raw`) is let through by `[^?]*$`. `packages/fake/images.ts` names `../ui/lib/images` and matches neither pattern; the test holds that one by name.

Also in `eslint.config.js`, in the first comment, "each with its own `tsconfig.json`" stays true and is left.

- [ ] **Step 5: Lint sees the broken file, then nothing**

```powershell
pnpm exec eslint apps/light/LightApp.tsx
[IO.File]::WriteAllText("$PWD\apps\light\LightApp.tsx", $app, [Text.UTF8Encoding]::new($false))
git diff --stat -- apps/light/LightApp.tsx
pnpm exec eslint . --max-warnings 0
pnpm exec vitest run scripts/workspace.test.mjs
```

Expected: two `no-restricted-imports` errors on lines 1 and 2; after the restore the file's diff is what it was (its rewritten imports); `eslint .` exits 0; the test passes 8 of 8.

- [ ] **Step 6: Two tests that read the root manifest for what it no longer says**

`scripts/vite-base.test.mjs` — the folder that holds a `package.json` is no longer only the repository:

```js
  it("takes the repository to be the folder that holds the workspace file and the shared UI", () => {
    // Every app has a `package.json` since 2026-10-08; only the root has this file.
    expect(existsSync(`${REPO}/pnpm-workspace.yaml`)).toBe(true);
    expect(existsSync(`${UI}/index.css`)).toBe(true);
  });
```

and a case for Task 2's line:

```js
  it("resolves React and the query library once, from a program's root", () => {
    expect(base.resolve.dedupe).toEqual(["react", "react-dom", "@tanstack/react-query"]);
  });
```

In the file's header comment, replace "and it stops being so the day an app has a `package.json` of its own." with "and Vite's default goes on reaching it: each app has a `package.json` of its own since the workspace, and the root's `pnpm-workspace.yaml` is what the default looks for first."

`packages/ui/lib/dndManager.test.ts` — the dependency it guards against would come back through the shared UI's manifest, which the test does not read. Delete the line `import manifest from "../../../package.json?raw";` and write the case as:

```ts
  /** Every manifest a dependency can come back through: the root's and each package's. */
  const MANIFESTS = import.meta.glob<string>(
    ["/package.json", "/packages/*/package.json", "/apps/*/package.json"],
    { query: "?raw", import: "default", eager: true },
  );

  /**
   * The half a source sweep cannot see: a dependency can be back in a manifest with nothing
   * importing it yet, which is how it comes back — one `pnpm add` that looked harmless.
   */
  it("declares no @atlaskit dependency", () => {
    // The drag library is the shared UI's to declare since 2026-10-08, so that is the manifest
    // this has to be reading; the root's alone would pass over the one file it could return to.
    expect(MANIFESTS["/packages/ui/package.json"]).toContain('"@dnd-kit/dom"');
    for (const [path, manifest] of Object.entries(MANIFESTS))
      expect(manifest, path).not.toMatch(new RegExp(`"${ATLAS}/`));
  });
```

```powershell
pnpm exec vitest run scripts/vite-base.test.mjs packages/ui/lib/dndManager.test.ts
pnpm exec tsc -p packages/ui
```

Expected: both files pass; `tsc` exits 0.

- [ ] **Step 7: Checkpoint** (controller)

```powershell
git add -A scripts/workspace.test.mjs scripts/vite-base.test.mjs eslint.config.js packages/ui/lib/dndManager.test.ts
git commit -m "wip(workspace): the import rules, held"
```

---

### Task 5: What runs a command outside CI

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/tauri.light.conf.json`, `apps/light/src-tauri/tauri.conf.json`, `apps/light/src-tauri/gen/android/buildSrc/src/main/java/com/mtggrimoire/app/kotlin/BuildTask.kt`, `apps/light/host.test.ts`, `scripts/web-smoke/sync-harness.mjs`, `.claude/hooks/worktree-deps.sh`, `.claude/hooks/merge-main.sh`, `.claude/skills/running-the-app/SKILL.md`, `.claude/skills/running-the-app/storybook.md`, `.claude/skills/worktree-setup/SKILL.md`

**Interfaces:**
- Consumes: the root scripts `dev`, `build`, `mobile:serve`, `mobile:build`, `tauri:light` (unchanged names); the deploy tool's folder from Task 1.
- Produces: nothing another task calls.

- [ ] **Step 1: The Tauri CLI's two hooks, from an app's folder**

The CLI runs these with the app's folder as the working directory, where `pnpm run dev` finds `apps/desktop/package.json` and no such script (measured: *"script matched with … is present in the root of the workspace, so you may run `pnpm -w run …`"*).

| File | Key | Is |
| --- | --- | --- |
| `apps/desktop/src-tauri/tauri.conf.json` | `beforeDevCommand` | `pnpm -w run dev` |
| `apps/desktop/src-tauri/tauri.conf.json` | `beforeBuildCommand` | `pnpm -w run build` |
| `apps/desktop/src-tauri/tauri.light.conf.json` | `beforeDevCommand` | `pnpm -w run mobile:serve` |
| `apps/light/src-tauri/tauri.conf.json` | `beforeDevCommand` | `pnpm -w run mobile:serve` |
| `apps/light/src-tauri/tauri.conf.json` | `beforeBuildCommand` | `pnpm -w run mobile:build` |

- [ ] **Step 2: Gradle's task, and the test that holds it**

In `apps/light/host.test.ts`, the case "has Gradle call the Tauri CLI from apps/light/, where it finds this project" becomes — test first:

```ts
  it("has Gradle call the Tauri CLI from apps/light/, where it finds this project", () => {
    // Gradle starts the task in `apps/light/src-tauri`. `pnpm run` there would look in the light
    // app's own manifest, which has no such script, and `pnpm run tauri` at the root would start
    // the CLI where it finds the desktop's project. So: the root's script, by name, from anywhere.
    expect(buildTask).toContain('val executable = """pnpm""";');
    expect(buildTask).toMatch(
      /listOf\("--workspace-root", "run", "tauri:light", "android", "android-studio-script"\)/,
    );
    expect(JSON.parse(packageJson).scripts["tauri:light"]).toBe("cd apps/light && tauri");
  });
```

```powershell
pnpm exec vitest run apps/light/host.test.ts -t "has Gradle call"
```

Expected: FAIL — the task still says `npm`.

In `BuildTask.kt`: `val executable = """npm""";` becomes `val executable = """pnpm""";`, and in `runTauriCli` the comment and the argument list become:

```kotlin
        // HAND-EDITED: the root's `tauri:light` script, never `tauri`, and through
        // `--workspace-root`. This task starts in `apps/light/src-tauri`: a plain `pnpm run` there
        // reads the light app's own manifest, which has no such script, and the root's `tauri`
        // script starts the CLI where it finds the desktop's project and refuses with "Android
        // Studio project directory …/src-tauri/gen/android doesn't exist" — the first `android`
        // CI run, 2026-10-03. The script is `cd apps/light && tauri`, so the CLI starts where it
        // finds this one. pnpm hands every argument after the script's name to it, flags and all
        // (measured 2026-10-08), so no `--` goes in front of them as npm needed.
        // `apps/light/host.test.ts` holds both lines.
        val args = listOf("--workspace-root", "run", "tauri:light", "android", "android-studio-script");
```

The Windows fallbacks below it (`$executable.exe`, `.cmd`, `.bat`) are right as they are: Corepack's shim is `pnpm.cmd`.

```powershell
pnpm exec vitest run apps/light/host.test.ts
```

Expected: PASS. No Gradle build runs on this machine in this plan; CI's `android` job is the first to run the task (Task 10).

- [ ] **Step 3: Where the sync smoke finds wrangler**

In `scripts/web-smoke/sync-harness.mjs`, `wranglerScript`:

```js
/** `wrangler.js`, or a sentence saying how to provide one. */
function wranglerScript() {
  const pinned = join(ROOT, "infrastructure/wrangler/node_modules/wrangler/bin/wrangler.js");
  if (existsSync(pinned)) return pinned;
  const named = process.env.WRANGLER;
  if (named && existsSync(named)) return named;
  return fail(
    "no wrangler to run the relay with. Install the pinned one " +
      "(`npm ci --ignore-scripts --prefix infrastructure/wrangler`), " +
      "or set WRANGLER to a wrangler.js — for example the one `npx wrangler` keeps in npm's cache.",
  );
}
```

- [ ] **Step 4: The session hook that installs a worktree's dependencies**

`.claude/hooks/worktree-deps.sh` — the comment at the top and everything from "Is node_modules missing" to the end of the install block. The JSON helpers and the final `ctx`/`emit` are unchanged.

Lines 7 to 12 of the header become:

```bash
# Why a hook and not prose: `pnpm install` in a worktree is a mechanical precondition, and
# the worktree-setup skill was carrying ~360 tokens of instructions for it in every single
# request of every worktree session (measured 2026-08-21: the skill loaded 1% of the way
# into a session and was re-sent ~271 times after that). A hook does the thing once and
# costs nothing per request. The skill keeps only the judgment - what to do when the branch
# is wrong, and the stash rule.
```

and the block from `# Is node_modules missing` down to the `fi` that closes `if [ "$needs_install" = "1" ]` becomes:

```bash
# Is node_modules missing, or older than the lockfile? The second case is the one that reads
# as a real failure and is not: a merge brings a dependency, node_modules still exists, and
# `tsc` fails TS2307 on the new import. pnpm writes node_modules/.modules.yaml on every
# install, so its mtime is when the tree was last made to match the lock. A tree npm made has
# no such file, and is replaced: pnpm's layout and npm's do not mix.
needs_install=0
reason=""
if [ ! -d node_modules ]; then
  needs_install=1
  reason="node_modules was absent"
elif [ ! -f node_modules/.modules.yaml ]; then
  needs_install=1
  reason="node_modules was not pnpm's"
elif [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  needs_install=1
  reason="pnpm-lock.yaml was newer than the last install"
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf '?')"
commits="$(git log --oneline -3 2>/dev/null || true)"

install_line="node_modules already matched pnpm-lock.yaml; nothing installed."
lock_before=""
if [ "$needs_install" = "1" ]; then
  lock_before="$(git hash-object pnpm-lock.yaml 2>/dev/null || true)"
  started="$(date +%s)"
  if pnpm install >"$root/pnpm-install.local" 2>&1; then
    install_line="Ran pnpm install ($reason) in $(( $(date +%s) - started ))s. It succeeded."
  else
    # A failed install is worth more than a silent one: without it nothing resolves, and
    # `pnpm verify` stops at the first `tsc` so its cargo half never runs.
    install_line="Ran pnpm install ($reason) and IT FAILED after $(( $(date +%s) - started ))s. Read pnpm-install.local at the worktree root. Until it succeeds, imports do not resolve and pnpm verify never reaches cargo test - those failures are not yours."
  fi

if [ -n "$lock_before" ]; then
  lock_after="$(git hash-object pnpm-lock.yaml 2>/dev/null || true)"
  if [ "$lock_before" != "$lock_after" ]; then
    install_line="$install_line NOTE: the install REWROTE pnpm-lock.yaml, which is a tracked file - it is now dirty in git status and will ride into your PR unless you check it. Decide deliberately whether that change belongs in this branch."
  fi
fi
fi
```

`.gitignore` already ignores `*.local`, which covers `pnpm-install.local`.

In `.claude/hooks/merge-main.sh`, the two lines that watch for a dependency change:

```bash
  if git diff --name-only "$before" HEAD 2>/dev/null | grep -q 'pnpm-lock\.yaml\|pnpm-workspace\.yaml\|package\.json'; then
    note=" Dependencies changed - run 'pnpm install' in this worktree."
```

```powershell
bash -n .claude/hooks/worktree-deps.sh; bash -n .claude/hooks/merge-main.sh; $LASTEXITCODE
git ls-files -s .claude/hooks/worktree-deps.sh .claude/hooks/merge-main.sh
```

Expected: `0`; both files keep the mode they have in `HEAD` (`git diff --summary` prints no `mode change`).

- [ ] **Step 5: The two skills that start a process**

`.claude/skills/running-the-app/SKILL.md` and `storybook.md` start the app and Storybook through `npm.cmd`, because `npm` is a `.ps1` wrapper `Start-Process` cannot launch. pnpm's shim has the same three forms.

```powershell
(Get-Command pnpm.cmd).Source
```

Expected: a path. Then:

| File | Was | Is |
| --- | --- | --- |
| `SKILL.md` | `Start-Process npm.cmd -ArgumentList "run","tauri","dev" -WindowStyle Hidden` | `Start-Process pnpm.cmd -ArgumentList "tauri","dev" -WindowStyle Hidden` |
| `storybook.md` | `Start-Process npm.cmd -ArgumentList "run","storybook" -WindowStyle Hidden` | `Start-Process pnpm.cmd -ArgumentList "storybook" -WindowStyle Hidden` |

and in the prose of both, every `npm.cmd` becomes `pnpm.cmd` and "`npm` resolves to a `.ps1` wrapper" becomes "`pnpm` resolves to a `.ps1` wrapper". The chain the skill describes keeps its shape — `pnpm.cmd` → cargo → `mtg-grimoire.exe` — so what it says about which pid to adopt still holds. Task 9's live pass starts the app by these lines.

`.claude/skills/worktree-setup/SKILL.md`:

- In the frontmatter's `description`, `npm run verify` becomes `pnpm verify`.
- The paragraph that begins "**Dependencies and the branch are a hook now**" becomes:

```markdown
**Dependencies and the branch are a hook now** — `.claude/hooks/worktree-deps.sh` at
SessionStart. It reports both and installs when `node_modules` is missing, is not pnpm's, or
is older than `pnpm-lock.yaml`. **If you did not see that report, run `pnpm install` yourself
before any test, build or app command**, or nothing resolves and `pnpm verify` never reaches
`cargo test` — failures that are not yours.

**A worktree resolves more than it declares.** Node looks for a package in every folder above
a file, and a worktree sits under the main checkout: an import no manifest here declares can
resolve from `D:\Code\mtg-grimoire\node_modules` and fail in CI. `scripts/workspace.test.mjs`
is what holds "a package declares what it imports"; nothing that runs the code can.
```

- "Plain `npm` and `git` still work in Bash." becomes "Plain `pnpm` and `git` still work in Bash."
- "`npm run verify` green means the workspace is real" becomes "`pnpm verify` green means the workspace is real".
- In the table "What is and is not shared", the `node_modules` row stays; add under the table: "pnpm's store (`D:\.pnpm-store`) is shared by every checkout on the drive: a worktree's `node_modules` is links into it, and an install is seconds."

```powershell
node scripts/check-claude-md.mjs
```

Expected: exit 0.

- [ ] **Step 6: Checkpoint** (controller)

```powershell
git add -A apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/tauri.light.conf.json apps/light/src-tauri/tauri.conf.json apps/light/src-tauri/gen/android/buildSrc apps/light/host.test.ts scripts/web-smoke/sync-harness.mjs .claude/hooks .claude/skills
git commit -m "wip(workspace): the Tauri hooks, Gradle, the session hook and the skills"
```

---

### Task 6: The hosting Worker bundles with nothing installed but wrangler

**Files:**
- Modify: `infrastructure/app-worker/wrangler.jsonc`, `infrastructure/app-worker/src/hosting.test.ts`, `infrastructure/relay/wrangler.jsonc`, `infrastructure/share-worker/wrangler.jsonc`

**Interfaces:**
- Consumes: `infrastructure/app-worker/src/index.ts`'s import of `@grimoire/ui/lib/core/web/assets` (written by Task 2); the deploy tool at `infrastructure/wrangler` (Task 1).
- Produces: a bundle that needs no workspace link, which Task 7's `web-deploy` and Task 9's dry run rely on.

- [ ] **Step 1: Write the failing test**

In `infrastructure/app-worker/src/hosting.test.ts`:

After the line `import wranglerText from "../wrangler.jsonc?raw";` add:

```ts
import assetsText from "../../../packages/ui/lib/core/web/assets.ts?raw";
```

After the last import (`import { headersFor, parseHeaders } from "./headers";`) add:

```ts

/** This folder's own modules, as text. */
const OWN: Record<string, string> = import.meta.glob("./*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
```

(No type argument on `glob`: this program declares its own, in `vite.d.ts`.)

In "binds nothing but the assets, and configures nothing", the key list gains `"alias"` after `"main"`.

Immediately above `describe("what must not be in this directory, or in any build but the web's", …)` add:

```ts
describe("what the script imports, in a job that installs only wrangler", () => {
  /** Every specifier a source names — `from "x"`, `import "x"`, `import("x")` — comments out. */
  const named = (source: string): string[] =>
    [
      ...source
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
        .matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g),
    ].map(([, spec]) => spec);
  /** The script: this folder's modules, less the tests and the ambient declarations. */
  const script = Object.entries(OWN).filter(([path]) => !/\.(?:test|d)\.ts$/.test(path));
  const alias = jsonc(wranglerText).alias as Record<string, string>;

  it("is a file beside it, or a module `wrangler.jsonc` gives a path for", () => {
    // `release.yml`'s `web-deploy` runs no pnpm, so nothing links `@grimoire/ui` into this
    // folder there: a package name the config does not name fails the bundle at the release,
    // and at no pull request before it.
    expect(script.map(([path]) => path).sort()).toEqual(["./headers.ts", "./index.ts"]);
    const outside = script
      .flatMap(([, source]) => named(source))
      .filter((spec) => !spec.startsWith("./"));
    expect(outside).toEqual(["@grimoire/ui/lib/core/web/assets"]);
    expect(alias).toEqual({
      "@grimoire/ui/lib/core/web/assets": "../../packages/ui/lib/core/web/assets.ts",
    });
  });

  it("reaches a module that imports nothing of its own", () => {
    // What the alias points at is bundled with the script, and anything it named would need the
    // install that job does not run.
    expect(assetsText).toContain("export function isNavigation");
    expect(named(assetsText)).toEqual([]);
  });
});
```

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
pnpm exec vitest run --project app-worker
```

Expected: 2 failed — the key list, and `alias` being `undefined`.

- [ ] **Step 2: Give wrangler the path**

In `infrastructure/app-worker/wrangler.jsonc`, the `$schema` comment and line become:

```jsonc
  // Resolves once `npm ci --ignore-scripts --prefix infrastructure/wrangler` has run: that folder's
  // `package.json` and lockfile pin the `wrangler` that deploys this Worker (README, "Deploying").
  "$schema": "../wrangler/node_modules/wrangler/config-schema.json",
```

and after the `"main": "src/index.ts",` line add:

```jsonc

  // The script's one import of another package's module, as a path wrangler follows with nothing
  // installed. `release.yml`'s `web-deploy` checks the repository out and installs wrangler from
  // `infrastructure/wrangler`'s lockfile — no pnpm, so no `node_modules` link for `@grimoire/ui`
  // — and without this line the bundle stops at "Could not resolve". An exact module, not the
  // package: wrangler matches an alias against the whole specifier (measured 2026-10-08: an
  // alias from `@grimoire/ui` to the folder resolved nothing). `hosting.test.ts` holds the pair,
  // and holds the module it points at to importing nothing.
  "alias": { "@grimoire/ui/lib/core/web/assets": "../../packages/ui/lib/core/web/assets.ts" },
```

In `infrastructure/relay/wrangler.jsonc` and `infrastructure/share-worker/wrangler.jsonc`, `"$schema": "node_modules/wrangler/config-schema.json"` becomes `"$schema": "../wrangler/node_modules/wrangler/config-schema.json"`. An editor's convenience and nothing a deploy reads; those two Workers' own commands (`npx wrangler …`, by hand) are not changed by this plan.

- [ ] **Step 3: See it pass, type-check, and bundle with the link taken away**

```powershell
pnpm exec vitest run --project app-worker
pnpm exec tsc -p infrastructure/app-worker
```

Expected: `Test Files  4 passed (4)`, 134 tests on `59d735fa` (132 and the two new ones); `tsc` exits 0.

Then the bundle as the release job will make it. With the Bash tool, because it moves a folder of links:

```bash
cd "D:/Code/mtg-grimoire/.claude/worktrees/repo-structure-cleanup-66d570/infrastructure/app-worker"
mv node_modules node_modules.off
node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir "<scratch>/s2-bare-bundle" 2>&1 | grep -E 'Total Upload|dry-run|ERROR|Could not'
mv node_modules.off node_modules
```

Expected: `Total Upload: 1.33 KiB / gzip: 0.71 KiB` and `--dry-run: exiting now.` — nothing is uploaded. `Could not resolve` means the alias line is wrong; the folder is put back either way.

> **Corrected 2026-10-09, after the final review.** As written, this step moves only the
> Worker's own `node_modules` aside. The root manifest declares `@grimoire/ui` too, so
> `node_modules/@grimoire/ui` at the repository root is still there, and resolution from the
> Worker's `src/` walks up to it: run this way **with the `alias` line deleted**, wrangler still
> printed `Total Upload`. The step proved nothing about the alias. Measured again with both
> link folders moved aside (`infrastructure/app-worker/node_modules` and the root's
> `node_modules/@grimoire`): without the alias, `Could not resolve
> "@grimoire/ui/lib/core/web/assets"`; with it, `Total Upload: 1.33 KiB / gzip: 0.71 KiB`. The
> reviewer measured the same from a `git archive` of the commit with no `node_modules` on any
> ancestor. That is the run the pull request cites.

- [ ] **Step 4: Checkpoint** (controller)

```powershell
git add -A infrastructure/app-worker infrastructure/relay/wrangler.jsonc infrastructure/share-worker/wrangler.jsonc
git commit -m "wip(workspace): the hosting Worker's import, as a path wrangler can follow"
```

---

### Task 7: The workflows, and the fences that read them

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/android-emulator.yml`
- Modify: `scripts/workflow-scripts.test.mjs`, `scripts/release-rule.test.mjs`, `scripts/toolchain.test.mjs`, `scripts/ci-route.mjs`, `scripts/ci-route.test.mjs`

**Interfaces:**
- Consumes: every root script name (unchanged); `infrastructure/wrangler` (Task 1); the Worker's alias (Task 6); `pnpm -w run …` in the Tauri configs (Task 5).
- Produces: nothing another task calls. From here Vitest's `root` project is green again.

The tests are changed first, each seen red against the workflows as they are, and then the workflows.

- [ ] **Step 1: `scripts/workflow-scripts.test.mjs` — a script is run by pnpm**

Replace the header comment's first sentence, `runsOf`, `CALLERS`, and the first two `describe` blocks with:

```js
// Every script a workflow, a composite action, a Tauri config or another script asks pnpm for is
// a script `package.json` has.
```

(the rest of the header — the 2026-10-04 account — stays; in it `npm run verify` becomes `pnpm verify` and `npm error Missing script` stays as the error that was printed.)

```js
const TAURI_CONFIGS = import.meta.glob("/apps/*/src-tauri/tauri*.conf.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** pnpm's own commands that something here runs. Any other word after `pnpm` is a script's name. */
const PNPM_OWN = new Set(["install", "exec"]);

/**
 * Every script name a text runs, once each: `pnpm <name>` and `pnpm run <name>`, either after
 * `-w`. Not `pnpm/action-setup` and not `cache: pnpm`: a name follows `pnpm` and a space.
 */
const runsOf = (src) => [
  ...new Set(
    [...src.matchAll(/\bpnpm (?:(?:-w|--workspace-root) )?(?:run )?([\w][\w:.-]*)/g)]
      .map((m) => m[1])
      .filter((name) => !PNPM_OWN.has(name)),
  ),
];

/** The two commands the Tauri CLI runs for a config, from the app's folder. */
const hooksOf = (conf) =>
  [...conf.matchAll(/"before(?:Dev|Build)Command":\s*"([^"]+)"/g)].map((m) => m[1]);

const CALLERS = [
  ...Object.entries({ ...WORKFLOWS, ...ACTIONS }).map(([path, src]) => [path, code(src)]),
  ...Object.entries(TAURI_CONFIGS).map(([path, conf]) => [path, hooksOf(conf).join("\n")]),
  ["/package.json", Object.values(pkg.scripts).join("\n")],
];

describe("every script that is run", () => {
  it.each(CALLERS)("%s names only scripts package.json has", (_path, src) => {
    expect(runsOf(src).filter((name) => !(name in pkg.scripts))).toEqual([]);
  });

  // npm strips a `--` before a script's arguments; pnpm hands it to the script. Vitest then reads
  // `--shard=1/3` as a file to look for, and `scanner-assets.mjs` never sees `--web`.
  it.each(CALLERS)("%s puts no `--` between a script and its arguments", (_path, src) => {
    expect(src).not.toMatch(/\bpnpm (?:(?:-w|--workspace-root) )?(?:run )?[\w:.-]+ -- /);
  });

  // The one npm left is the deploy tool's install, which is npm's on purpose.
  it.each(CALLERS)("%s runs npm for the deploy tool's install and nothing else", (_path, src) => {
    const npm = src.split("\n").filter((line) => /\bnpm\b|\bnpx\b/.test(line));
    expect(npm.filter((line) => !/\bnpm ci --ignore-scripts\b/.test(line))).toEqual([]);
  });

  // The Tauri CLI runs these in `apps/<name>`, where a plain `pnpm run` reads that app's manifest
  // and finds no script (measured 2026-10-08).
  it("reaches a root script from an app's folder through the workspace root", () => {
    const hooks = Object.values(TAURI_CONFIGS).flatMap(hooksOf);
    expect(hooks.length).toBe(5);
    for (const hook of hooks) expect(hook).toMatch(/^pnpm -w run [\w:.-]+$/);
  });
});

describe("the rule's own guards", () => {
  // A census that matched nothing would pass the assertions above.
  it("sees the calls it is about", () => {
    const ci = code(WORKFLOWS["/.github/workflows/ci.yml"]);
    expect(runsOf(ci)).toEqual(expect.arrayContaining(["build", "lint", "web:smoke", "test:run"]));
    expect(runsOf(pkg.scripts.verify).length).toBeGreaterThan(0);
    expect(runsOf("run: pnpm web:smoke\n# pnpm gone")).toEqual(["web:smoke", "gone"]);
    expect(runsOf(code("  # pnpm gone\n  run: pnpm -w run build"))).toEqual(["build"]);
    expect(runsOf("pnpm --workspace-root run tauri:light android")).toEqual(["tauri:light"]);
    expect(
      runsOf("run: pnpm install --frozen-lockfile\nrun: pnpm exec tauri android build\nuses: pnpm/action-setup@abc\ncache: pnpm"),
    ).toEqual([]);
  });
});
```

The `web-deploy` job's `run: node ../wrangler/…/wrangler.js deploy` holds neither `npm` nor `npx` as a word. Leave "the folders a workflow steps into" as it is; its sample keeps `npm --prefix`, which is the flag the deploy tool's install still uses.

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
pnpm exec vitest run scripts/workflow-scripts.test.mjs
```

Expected: FAIL — "sees the calls it is about" finds no `pnpm` call in `ci.yml`, and the npm rule lists every `npm ci` and `npm run` line.

- [ ] **Step 2: `scripts/toolchain.test.mjs` — pnpm from the pinned action, before Node**

Add inside the workflows' `describe`, after "takes Node from .nvmrc":

```js
  // pnpm comes from the action, at the version `package.json` pins, and before Node:
  // `setup-node` asks pnpm where its store is in order to cache it.
  const installsOf = (src) => src.match(/^\s+- run: pnpm install --frozen-lockfile$/gm)?.length ?? 0;

  it.each(entries)("%s sets pnpm up, pinned, before Node, wherever it installs", (_path, src) => {
    const text = src.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    const installs = installsOf(text);
    expect(text.match(/uses: pnpm\/action-setup@[0-9a-f]{40} # v\d/g)?.length ?? 0).toBe(installs);
    expect(text.match(/^\s+cache: pnpm$/gm)?.length ?? 0).toBe(installs);
    // No `with:` under it: the version is `packageManager`'s, and one typed here is a second pin.
    expect(text).not.toMatch(/pnpm\/action-setup@[^\n]*\n\s+with:/);
    expect(text).not.toMatch(/\bcache: npm\b|\bnpm ci(?! --ignore-scripts)/);
    const order = [...text.matchAll(/uses: (pnpm\/action-setup|actions\/setup-node)@/g)].map((m) => m[1]);
    order.forEach((name, at) => {
      if (name === "pnpm/action-setup") expect(order[at + 1]).toBe("actions/setup-node");
    });
  });

  // Guards the count above: a workflow that stopped installing would pass a comparison of zeros.
  it("finds the eight installs", () => {
    expect(installsOf(WORKFLOWS["/.github/workflows/ci.yml"])).toBe(4);
    expect(installsOf(WORKFLOWS["/.github/workflows/release.yml"])).toBe(3);
    expect(installsOf(WORKFLOWS["/.github/workflows/android-emulator.yml"])).toBe(1);
  });
```

and a `describe` at the end of the file:

```js
describe("pnpm", () => {
  it("is pinned in package.json, to a version and the hash of its tarball", () => {
    // Corepack and the setup action both read this field; the hash is what makes the pin a pin.
    expect(JSON.parse(packageJson).packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  });
});
```

If the file's names for the workflow map and its entries differ from `WORKFLOWS` and `entries`, use the file's.

- [ ] **Step 3: `scripts/release-rule.test.mjs` — every change, and no other**

**(a) Imports.** Delete `import packageLock from "../package-lock.json?raw";`. Replace the two `appWorker…` imports with:

```js
import deployToolPackage from "../infrastructure/wrangler/package.json?raw";
import deployToolLock from "../infrastructure/wrangler/package-lock.json?raw";
import appWorkerPackage from "../infrastructure/app-worker/package.json?raw";
import workspaceYaml from "../pnpm-workspace.yaml?raw";
```

and add below `WORKFLOWS`:

```js
/** Which lockfiles the root holds, by name. Not read: pnpm's is a quarter of a megabyte. */
const ROOT_LOCKS = import.meta.glob(["/package-lock.json", "/npm-shrinkwrap.json", "/yarn.lock", "/pnpm-lock.yaml"]);
```

**(b) "is a plain semantic version, and the one release-please last released".** The three lines about `packageLock` become:

```js
    // pnpm's lockfile records no version for the root package, so a release moves nothing in
    // it. npm's did — and one left behind would be bumped by release-please and read by
    // `tauri-action` as "this project uses npm".
    expect(Object.keys(ROOT_LOCKS)).toEqual(["/pnpm-lock.yaml"]);
```

**(c) "builds the desktop through the root's `tauri` script".** The comment and one new line:

```js
    // `tauri-action` runs `pnpm tauri build` from the repository root: it finds `pnpm-lock.yaml`
    // and, in this manifest, `@tauri-apps/cli` (read at v1.0.0, `src/runner.ts`). So a release
    // depends on this script's text — it is what takes the build into the desktop host's folder —
    // and on the CLI being declared here: without it the action installs a global one with npm.
    // The light host's script is pinned in `apps/light/host.test.ts`.
    expect(JSON.parse(packageJson).scripts.tauri).toBe("cd apps/desktop && tauri");
    expect(JSON.parse(packageJson).devDependencies["@tauri-apps/cli"]).toBeDefined();
```

**(d) The list of what `web-deploy` may run.** Two lines of the four:

```js
        // The lockfile's packages, no lifecycle script; then the file that installed, by path.
        "run: npm ci --ignore-scripts",
        "run: node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy",
```

and after that `it.each`, a case of its own:

```js
  // The workspace is pnpm's; the two jobs that hold a secret are not part of it. Neither sets
  // pnpm up, installs with it or runs it: what they run is the list above, to the letter.
  it.each(["android-sign", "web-deploy"])("%s never sees pnpm", (name) => {
    expect(code(jobs[name])).not.toMatch(/pnpm/);
  });
```

**(e) "builds the Android app and the web app as `ci.yml` does".** Five strings:

| Was | Is |
| --- | --- |
| `npx tauri android build --apk --aab --target aarch64 --ci` | `pnpm exec tauri android build --apk --aab --target aarch64 --ci` |
| `run: npm run web:wasm` | `run: pnpm web:wasm` |
| `run: npm run scanner:assets -- --web` | `run: pnpm scanner:assets --web` |
| `run: npm run web:build` | `run: pnpm web:build` |
| `run: npm run web:smoke` | `run: pnpm web:smoke` |

The same five respellings in the three `at(…)` ordering lines below them and in `expect(ciYml).toContain("run: npm run web:scanner-smoke")`.

**(f) "deploys the bundle `web` built and opened in a browser, then asks the host".** `at("npm run web:smoke")` and `at("npm run web:build")` become `at("pnpm web:smoke")` and `at("pnpm web:build")`; in `order`, `"run: npx --no-install wrangler deploy"` becomes `"run: node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy"`.

**(g) "runs wrangler once…".** The whole case:

```js
  it("runs wrangler once: `web-deploy`, the lockfile's install, from infrastructure/app-worker/", () => {
    const wrangler = lines.filter(({ line }) => /\bwrangler\b/.test(line));
    expect(wrangler).toEqual([
      {
        // Not a run of it: the `web` job's step that *installs* the same lockfile, for the sync
        // smoke (phase 6, step 6.3). No workflow line there starts wrangler; the script does,
        // and the test below holds what it may ask of it.
        path: "/.github/workflows/ci.yml",
        line: "      - name: Install wrangler from its lockfile",
      },
      {
        path: "/.github/workflows/ci.yml",
        line: "        run: npm ci --ignore-scripts --prefix infrastructure/wrangler",
      },
      {
        // The deploy job's install, in the tool's own folder.
        path: "/.github/workflows/release.yml",
        line: "        working-directory: infrastructure/wrangler",
      },
      {
        path: "/.github/workflows/release.yml",
        // By path: the file the install put there, or a failure. No runner resolves a name, so
        // there is nothing to fetch — a version typed here could not even be asked for.
        line: "        run: node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy",
      },
    ]);
    const steps = stepsOf(jobsOf(releaseYml)["web-deploy"]);
    const at = steps.findIndex((s) => /wrangler\.js deploy$/m.test(s));
    expect(at).toBeGreaterThan(0);
    // From the Worker's folder, where `wrangler.jsonc` is…
    expect(steps[at]).toMatch(/^ {8}working-directory: infrastructure\/app-worker$/m);
    expect(secretsOf(steps[at])).toEqual(CLOUDFLARE_SECRETS);
    // …and the install is the step before it, in the tool's folder, with **nothing in its
    // environment**: what it installs is not run until the token's step, and it runs no script.
    expect(steps[at - 1]).toMatch(/^ {8}run: npm ci --ignore-scripts$/m);
    expect(steps[at - 1]).toMatch(/^ {8}working-directory: infrastructure\/wrangler$/m);
    expect(steps[at - 1]).not.toMatch(/^ {8}env:/m);
    expect(secretRefs(steps[at - 1])).toEqual([]);
  });
```

**(h) "pins wrangler and everything under it…".** Rename it "pins wrangler and everything under it in a lockfile of its own, outside the workspace"; `JSON.parse(appWorkerPackage)` and `JSON.parse(appWorkerLock)` become `JSON.parse(deployToolPackage)` and `JSON.parse(deployToolLock)`; every other assertion in it stays as written. Add at its end:

```js
    // The tool's folder is npm's. pnpm's workspace is these five entries and no glob that could
    // take `infrastructure/wrangler` in — a member's dependencies are resolved by pnpm-lock.yaml,
    // and this lockfile would stop being what installs.
    const members = [...workspaceYaml.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]);
    expect(members).toEqual([
      "packages/*",
      "apps/*",
      "infrastructure/relay",
      "infrastructure/share-worker",
      "infrastructure/app-worker",
    ]);
    // And the Worker's own manifest, in the folder the tool left, is not a second home for it.
    const worker = JSON.parse(appWorkerPackage);
    expect(worker.name).toBe("@grimoire/app-worker");
    expect({ ...worker.dependencies, ...worker.devDependencies }).not.toHaveProperty("wrangler");
```

**(i) "installs wrangler in CI for a run that is local, start to finish".** Two patterns:

```js
    expect(steps[install]).toMatch(
      /^ {8}run: npm ci --ignore-scripts --prefix infrastructure\/wrangler$/m,
    );
    expect(steps[install]).not.toMatch(/^ {8}env:/m);
    expect(steps[install + 1]).toMatch(/^ {8}run: pnpm web:sync-smoke$/m);
```

**(j) "commits no account id: the deploy reads it from a secret".** Its step is found by the word `wrangler`, which the install step's folder now holds too and would be found first:

```js
    const step = stepsOf(jobsOf(releaseYml)["web-deploy"]).find((s) => /wrangler\.js deploy$/m.test(s));
```

**(k) Prose.** In the comment above `RUNS_SOMETHING`, "its CLI is only ever reached through `npx`, `npm` or `cargo`" becomes "through `pnpm`, `npx` or `cargo`". In the comment above the secret-holding list, "a second `npx`, a `node -e`, an `npm run`" stays: those are still lines that are not on it. The parser's self-test near the end of the file (`run: npm ci --ignore-scripts`, `x=$(npx --yes left-pad)`) is a sample and stays.

- [ ] **Step 4: `scripts/ci-route.mjs` and its rows**

The arm for the root manifest and lockfile, with its comment:

```js
  // What `pnpm install --frozen-lockfile` installs and what `pnpm <name>` means, for every job
  // that runs either. A package's own manifest is under its folder's arm.
  { match: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], jobs: PAGE_SIDE },
```

and, immediately above the `infrastructure/app-worker/*` arm:

```js
  // The deploy tool: `release-rule.test.mjs` reads its manifest and lockfile (`frontend`), and
  // the `web` job installs from them for the sync smoke. No job in this gate deploys with it.
  { match: ["infrastructure/wrangler/*"], jobs: ["frontend", "web"] },
```

In `scripts/ci-route.test.mjs`, the rows (`T`/`F` in the file's column order: frontend, rust, core, powershell, storybook, android, web):

| Was | Is |
| --- | --- |
| `["package-lock.json", T, F, F, F, T, F, T],` | `["pnpm-lock.yaml", T, F, F, F, T, F, T],` and `["pnpm-workspace.yaml", T, F, F, F, T, F, T],` |
| `["tsconfig.json", T, F, F, F, T, F, T],` | `["tsconfig.base.json", T, F, F, F, T, F, T],`, `["packages/ui/tsconfig.json", T, F, F, F, T, F, T],` and `["apps/light/package.json", T, F, F, F, T, F, T],` |
| `["infrastructure/app-worker/package-lock.json", T, F, F, F, F, F, T],` | `["infrastructure/wrangler/package.json", T, F, F, F, F, F, T],` and `["infrastructure/wrangler/package-lock.json", T, F, F, F, F, F, T],` |

The row `["infrastructure/app-worker/package.json", T, F, F, F, F, F, T],` stays; the comment above the pair becomes:

```js
    // The Worker's workspace manifest, and — in a folder of its own since 2026-10-08 — the deploy
    // tool's manifest and lockfile (step 6.6): `release-rule.test.mjs` reads all three, and no
    // job in this gate installs the tool to deploy — `release.yml`'s `web-deploy` does.
```

and the comment above `TS_TESTS`, "Mirrors `test.include` in `vitest.config.ts`", becomes "Mirrors the projects' globs in `vitest.config.ts`".

- [ ] **Step 5: The workflows**

In each of the eight jobs that install — `android-emulator.yml` `first-run`; `ci.yml` `frontend`, `storybook`, `android`, `web`; `release.yml` `build`, `android`, `web` — the Node step gains the pnpm step above it, and the install changes:

```yaml
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - run: pnpm install --frozen-lockfile
```

`ea17c68d…` is the commit the annotated tag `v6.1.0` (2026-09-05) points at; check it before writing it eight times:

```powershell
gh api repos/pnpm/action-setup/git/ref/tags/v6.1.0 --jq .object.sha
gh api repos/pnpm/action-setup/git/tags/d9184bf108216479bc5a137cc391f4d7b14c870b --jq .object.sha
```

Expected: `d9184bf108216479bc5a137cc391f4d7b14c870b`, then `ea17c68df8912ef543352723c149a84f56e3d413`.

Every other line that runs something (line numbers at `59d735fa`):

| File | Line | Was | Is |
| --- | --- | --- | --- |
| `android-emulator.yml` | 105 | `run: npx tauri android build --apk --target x86_64 --ci` | `run: pnpm exec tauri android build --apk --target x86_64 --ci` |
| `ci.yml` | 159 | `run: npm run build` | `run: pnpm build` |
| `ci.yml` | 163 | `run: npm run lint` | `run: pnpm lint` |
| `ci.yml` | 169 | `run: npm run test:run -- --shard=${{ matrix.shard }}` | `run: pnpm test:run --shard=${{ matrix.shard }}` |
| `ci.yml` | 201 | `run: npm run build-storybook` | `run: pnpm build-storybook` |
| `ci.yml` | 562 | `run: npx tauri android build --apk --aab --target aarch64 --ci` | `run: pnpm exec tauri android build --apk --aab --target aarch64 --ci` |
| `ci.yml` | 749 | `run: npm run web:wasm` | `run: pnpm web:wasm` |
| `ci.yml` | 761 | `run: npm run scanner:assets -- --web` | `run: pnpm scanner:assets --web` |
| `ci.yml` | 771 | `run: npm run web:build` | `run: pnpm web:build` |
| `ci.yml` | 835 | `run: npm run web:smoke` | `run: pnpm web:smoke` |
| `ci.yml` | 859 | `run: npm run web:scanner-smoke` | `run: pnpm web:scanner-smoke` |
| `ci.yml` | 880 | `- name: Install wrangler from app-worker's lockfile` | `- name: Install wrangler from its lockfile` |
| `ci.yml` | 881 | `run: npm ci --ignore-scripts --prefix infrastructure/app-worker` | `run: npm ci --ignore-scripts --prefix infrastructure/wrangler` |
| `ci.yml` | 885 | `run: npm run web:sync-smoke` | `run: pnpm web:sync-smoke` |
| `release.yml` | 134 | `run: npm run scanner:assets` | `run: pnpm scanner:assets` |
| `release.yml` | 238 | `run: npx tauri android build --apk --aab --target aarch64 --ci` | `run: pnpm exec tauri android build --apk --aab --target aarch64 --ci` |
| `release.yml` | 493 | `run: npm run web:wasm` | `run: pnpm web:wasm` |
| `release.yml` | 501 | `run: npm run scanner:assets -- --web` | `run: pnpm scanner:assets --web` |
| `release.yml` | 506 | `run: npm run web:build` | `run: pnpm web:build` |
| `release.yml` | 538 | `run: npm run web:smoke` | `run: pnpm web:smoke` |

**`release.yml`'s `web-deploy`, two lines and their comments** — and no pnpm step, no `cache:`, no new action:

```yaml
      # For `npm ci` and for the two files Node runs here: the tool it installs, and the probe,
      # which is a plain `.mjs`. No `cache:` — a cache is one more thing that could hand this job
      # bytes the lockfile did not name. No pnpm: this job is not part of the workspace.
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
```

```yaml
      # `wrangler` and everything under it, from `infrastructure/wrangler/package-lock.json` and
      # nowhere else: each tarball checked against the hash the lockfile holds, and **no lifecycle
      # script run** — `esbuild`'s and `workerd`'s `postinstall` only swap a JS launcher for the
      # native binary it would start anyway, and each finds its platform package without it. This
      # step's environment holds no token; what it installs is not run until the next one.
      - name: Install the lockfile's packages, running no script
        if: steps.token.outputs.present == 'true'
        working-directory: infrastructure/wrangler
        run: npm ci --ignore-scripts

      # The only step the token reaches, and the only `wrangler` any workflow starts. **By path**:
      # what runs is the file the step above installed, or nothing — no runner resolves a name,
      # so nothing can be fetched in its place. From the Worker's folder, where `wrangler.jsonc`
      # is; that file's `alias` is what lets the script's one import of the shared UI bundle in a
      # job that has no workspace links (`infrastructure/app-worker/src/hosting.test.ts`).
      - name: Deploy the Worker
        if: steps.token.outputs.present == 'true'
        working-directory: infrastructure/app-worker
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          WRANGLER_SEND_METRICS: "false"
        run: node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy
```

**Comments in the three workflows that name npm** (23 in all): make each true, and change no sentence about the deploy tool's `npm ci`. Three that matter:

| Where | Is |
| --- | --- |
| `release.yml`, above `- run: pnpm install --frozen-lockfile` in `build` | `# tauri-action does NOT install frontend dependencies. It DOES run` / `# beforeBuildCommand (`pnpm -w run build`), so do not run that here as well.` |
| `release.yml`, above `tauri-apps/tauri-action` | The first sentence becomes: "The action runs `pnpm tauri build` from the repository root — it finds `pnpm-lock.yaml`, and `@tauri-apps/cli` in the root manifest — which `package.json` sends to `apps/desktop` (`scripts/release-rule.test.mjs` holds that script's text and that dependency)." |
| every build leg's install | One line above it, once per workflow: `# pnpm runs no dependency's install script unless `pnpm-workspace.yaml` names it (`allowBuilds`).` |

- [ ] **Step 6: See the fences pass, and break two once**

```powershell
pnpm exec vitest run --project root
```

Expected: `Test Files  12 passed (12)` and, on `59d735fa`, `Tests  373 passed (373)` — `workspace`, `workflow-scripts`, `release-rule`, `toolchain`, `ci-route`, `actions-pinned`, `vite-base` and the rest. `actions-pinned.test.mjs` needs no change: the new action is written the way it requires. If "is a plain semantic version…" fails naming `/package-lock.json`, Task 1 Step 6 left npm's lockfile behind.

Then the two the spec names, and Review Focus 1, each broken once:

```powershell
$release = Get-Content .github/workflows/release.yml -Raw; $route = Get-Content scripts/ci-route.mjs -Raw; $ci = Get-Content .github/workflows/ci.yml -Raw
$enc = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText("$PWD\.github\workflows\release.yml", $release.Replace("run: node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy", "run: npx wrangler deploy"), $enc)
pnpm exec vitest run scripts/release-rule.test.mjs scripts/workflow-scripts.test.mjs
[IO.File]::WriteAllText("$PWD\.github\workflows\release.yml", $release, $enc)
[IO.File]::WriteAllText("$PWD\scripts\ci-route.mjs", $route.Replace('{ match: ["infrastructure/wrangler/*"], jobs: ["frontend", "web"] }', '{ match: ["infrastructure/wrangler/*"], jobs: ["web"] }'), $enc)
pnpm exec vitest run scripts/ci-route.test.mjs
[IO.File]::WriteAllText("$PWD\scripts\ci-route.mjs", $route, $enc)
[IO.File]::WriteAllText("$PWD\.github\workflows\ci.yml", $ci.Replace("run: pnpm test:run --shard=", "run: pnpm test:run -- --shard="), $enc)
pnpm exec vitest run scripts/workflow-scripts.test.mjs
[IO.File]::WriteAllText("$PWD\.github\workflows\ci.yml", $ci, $enc)
git diff --stat -- .github/workflows scripts/ci-route.mjs
pnpm exec vitest run --project root
```

Expected, as each did in the planning session's checkout:

1. **Five failures.** In `release-rule`: "web-deploy builds nothing, and runs only what is listed here", "deploys the bundle `web` built and opened in a browser, then asks the host", "runs wrangler once…" and "commits no account id…". In `workflow-scripts`: "/.github/workflows/release.yml runs npm for the deploy tool's install and nothing else".
2. **Three failures** in `ci-route`: "routes every file a frontend test reads to `frontend`", and the two `infrastructure/wrangler/…` rows.
3. **One failure**: "/.github/workflows/ci.yml puts no `--` between a script and its arguments".

After the restores the diffs are the task's own and the project is green, 373 of 373. Write the failing case names in the ledger.

- [ ] **Step 7: Checkpoint** (controller)

```powershell
git add -A .github/workflows scripts
git commit -m "wip(workspace): the workflows install with pnpm, and the fences read them"
```

---

### Task 8: Every command a file tells someone to run, and the docs

**Files:**
- Modify, by script: about 130 files — every living doc, comment and message that spells an npm command (Step 1)
- Modify, by hand: `docs/reference/repository-layout.md`, `CLAUDE.md`, `docs/agent/CODE_STYLE.md`, `docs/agent/RUNNING_AND_VERIFYING.md`, `.github/CLAUDE.md`, `docs/reference/ci-and-releases.md`, `infrastructure/app-worker/README.md`, `apps/light/CLAUDE.md`, `packages/ui/CLAUDE.md`, `.storybook/CLAUDE.md`, `.github/dependabot.yml` (a comment), `docs/superpowers/specs/2026-10-08-repository-layout-and-workspace-design.md` (the amendment)

**Interfaces:**
- Consumes: `<scratch>/workspace-commands.mjs` (Appendix C).
- Produces: nothing another task calls.

- [ ] **Step 1: Respell the commands**

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
node "<scratch>\workspace-commands.mjs" . --left | Tee-Object "<scratch>\s2-commands-dry.txt" | Select-String -NotMatch '^  '
node "<scratch>\workspace-commands.mjs" . --write
```

Expected, as measured on the untouched tree of `59d735fa`: `would respell 525 commands in 133 of 1998 files; 133 lines still say npm, npx or package-lock`, with a count above it for each of the seven spellings it knows. Here it is a few fewer, by what Tasks 3 to 7 already respelled. The script never touches the workflows, the fence tests, the manifests, the Tauri configs, the Android project, the hooks, `.design-sync/`, a migration, `docs/superpowers/` or `CHANGELOG.md`.

It changes comments in Rust sources and one panic message (`apps/desktop/src-tauri/src/transfer/fields.rs`, "run `pnpm golden`"). No formatter is run over them.

- [ ] **Step 2: Read what is left**

`<scratch>\s2-commands-dry.txt` lists every line that still says `npm`, `npx` or `package-lock`. Each is one of these, and is handled as its row says:

| The line is about | Do |
| --- | --- |
| The deploy tool: `npm ci --ignore-scripts`, its `package-lock.json`, its ninety-one packages | Keep npm. Change the folder to `infrastructure/wrangler`, and `npx --no-install wrangler <x>` run for the hosting Worker to `node ../wrangler/node_modules/wrangler/bin/wrangler.js <x>` (from `infrastructure/app-worker`). A sentence that tells what a past run did stays as it was written. |
| The relay's or the share Worker's own runbook: `npx wrangler …` in `infrastructure/relay/README.md`, `infrastructure/share-worker/README.md`, `docs/reference/hosted-relay-deploy.md` | Leave. Those deploys are by hand, with whatever `npx` resolves, and this plan does not change how. |
| The root's lockfile, by name | `pnpm-lock.yaml`. |
| A command wrapped across two lines (a line ending `npm run`) | Respell by hand: `pnpm <name>`. |
| `npm.cmd` in the `running-the-app` skill | Already done in Task 5. |
| npm as a registry or a word ("the `mana-font` npm package", "every npm lifecycle script", `npm update`, `.mcp.json`'s `npx`) | Leave, unless the sentence is an instruction: `npm update` → `pnpm update`. |
| History ("`npm error Missing script`", "until 2026-10-04 this runbook said `npx wrangler`") | Leave. |

`.github/dependabot.yml`'s comment "npm and cargo are not here" becomes "pnpm and cargo are not here".

- [ ] **Step 3: `infrastructure/app-worker/README.md`, "Deploying" and the file table**

The table row for `package.json`, `package-lock.json` is replaced by two:

```markdown
| `package.json` | This Worker's manifest in the pnpm workspace: `@grimoire/app-worker`, and the one package it imports from, `@grimoire/ui`. It names no `wrangler`. |
| `../wrangler/package.json`, `package-lock.json` | The one tool that deploys this Worker — `wrangler`, at an exact version — and every package under it with its integrity hash. npm's, in a folder of its own that the workspace does not list, so `pnpm install` installs none of it. |
```

The install block under "Deploying" becomes:

````markdown
```bash
npm ci --ignore-scripts --prefix infrastructure/wrangler     # from the repository root; no lifecycle script runs
cd infrastructure/app-worker && node ../wrangler/node_modules/wrangler/bin/wrangler.js --version     # 4.146.0, or it fails
```

**Every `wrangler` below is `node ../wrangler/node_modules/wrangler/bin/wrangler.js`, run from this
folder**: the file that lockfile installed, or nothing. It is a path, so nothing is resolved and
nothing can be fetched in its place.
````

and every `npx --no-install wrangler <x>` in the numbered steps and under "Rolling back" follows it. Add one paragraph where the README explains the script (`src/index.ts`):

```markdown
**The script's one import from the shared UI is also in `wrangler.jsonc`, as `alias`.** The
release's deploy job installs wrangler and nothing else — no pnpm, so nothing links
`@grimoire/ui` into this folder — and the alias is the path wrangler follows instead. A second
import from another package needs a second alias; `src/hosting.test.ts` fails without it, which
is the only place that would be noticed before a release.
```

Moving the tool's version is `npm install --package-lock-only wrangler@<version>` **in `infrastructure/wrangler`**; say so where the README says it.

- [ ] **Step 4: `docs/reference/repository-layout.md` gains the workspace**

A new section after the layout's tree, "The workspace":

```markdown
## The workspace

Since 2026-10-08 each part is a package with a manifest of its own, in a pnpm workspace.

| Package | Folder | Depends on, in the workspace |
| --- | --- | --- |
| `mtg-grimoire` | the root | `@grimoire/ui`, `@grimoire/fake` — for the workbench (`.storybook/`) |
| `@grimoire/ui` | `packages/ui` | `@grimoire/fake`, for its tests and stories only |
| `@grimoire/fake` | `packages/fake` | `@grimoire/ui` |
| `@grimoire/desktop` | `apps/desktop` | `@grimoire/ui`; `@grimoire/fake` for its tests |
| `@grimoire/light` | `apps/light` | `@grimoire/ui`, `@grimoire/fake` |
| `@grimoire/share` | `apps/share` | `@grimoire/ui` |
| `@grimoire/relay` | `infrastructure/relay` | — |
| `@grimoire/share-worker` | `infrastructure/share-worker` | `@grimoire/relay` |
| `@grimoire/app-worker` | `infrastructure/app-worker` | `@grimoire/ui` |

Every package is private and at `0.0.0`; release-please bumps the root's version and no other.
There is no build step between packages and no `exports` map: a consumer compiles the source of
the package it imports.

**The import rules** (`scripts/workspace.test.mjs` holds them; `eslint.config.js` shows the first
two in an editor):

1. A module in another package is imported by the package's name: `@grimoire/ui/lib/ipc`.
2. Inside `packages/ui`, `@/` is the package's own root. Nowhere else may use it.
3. A test that reads a file's text (`?raw`) names it by relative path.
4. A file Node loads itself imports by relative path: a Vite, Vitest or Storybook config, and
   everything under `scripts/`.

**A package declares what its files import**, tests included. A range that more than one package
declares is written once, in `pnpm-workspace.yaml`'s `catalog`, and `catalog:` in each manifest.
The same test holds this, because nothing that runs can: Node finds a package the root declares
from any folder under it.

**Commands** are the root's scripts, as before: `pnpm <name>`, with arguments after the name and
no `--`. From an app's folder — which is where the Tauri CLI and Gradle start — a root script is
`pnpm -w run <name>`.

**`infrastructure/wrangler` is not in the workspace.** It is the tool that deploys the web app:
one dependency, a lockfile of its own, installed with `npm ci --ignore-scripts`. The release's
deploy job installs it and nothing else.

**TypeScript** has one program per package (`tsc -p <folder>`), all extending `tsconfig.base.json`
except the three Workers'. **Vitest** has one project per package, rooted at the repository:
`pnpm exec vitest run --project light`.
```

and in the old-to-new table, two rows: `tsconfig.json` → `tsconfig.base.json` and a `tsconfig.json` per package; `app-worker/package.json`, `package-lock.json` (the deploy tool) → `infrastructure/wrangler/`.

- [ ] **Step 5: The files an agent reads first**

- **`CLAUDE.md`** (the root's). The commands are respelled by Step 1. In "Primary Commands", `cargo test --workspace`'s line is untouched. In "Global Rules" add one bullet, and check the file is still under 200 lines:

```markdown
- **Imports cross a package by its name**: `@grimoire/ui/…`, `@grimoire/fake/…`. `@/` is the shared UI's own alias and is written only inside `packages/ui`. A package declares what its files import, in its own `package.json`. `scripts/workspace.test.mjs` holds all three; see [`docs/reference/repository-layout.md`](docs/reference/repository-layout.md).
```

  In "Area-Specific Guides" nothing moves. In "IPC Type Mirroring" nothing moves.
- **`docs/agent/CODE_STYLE.md`**: where it describes the `@/` alias, add the four import rules in two sentences and the pointer to `repository-layout.md`.
- **`docs/agent/RUNNING_AND_VERIFYING.md`**: beside the command catalog, three lines — arguments follow a script's name with no `--`; `pnpm exec vitest run --project <name>` runs one package's tests; `pnpm install` after a merge that changes a manifest or `pnpm-lock.yaml`.
- **`.github/CLAUDE.md`**: the install is `pnpm/action-setup` (pinned) and `pnpm install --frozen-lockfile`; the two secret-holding jobs have no pnpm; the deploy tool is `infrastructure/wrangler`; `scripts/workflow-scripts.test.mjs` now reads `pnpm <name>` and refuses a `--`.
- **`docs/reference/ci-and-releases.md`**: the same four facts where it describes the jobs, the deploy job's two lines as Task 7 wrote them, and the release build's runner (`pnpm tauri build`, and why the root keeps `@tauri-apps/cli`).
- **`apps/light/CLAUDE.md`**, §3 "The Phone Import Fence": the list of what `apps/light/phone/` never imports is spelled as a phone file would write it — `@grimoire/ui/lib/store`, `@grimoire/ui/App`, `@grimoire/ui/components/{AppShell,TitleBar,Ribbon}`, `@grimoire/ui/boot/*`, `@grimoire/ui/lib/window`, or `@tauri-apps/*` (except via `@grimoire/ui/lib/core`). Elsewhere in that file a `@/lib/x` that names a module of the shared UI as the UI knows it is left.
- **`packages/ui/CLAUDE.md`**: one line — `@/` is this package's alias and only this package's; other packages reach these modules as `@grimoire/ui/…`.
- **`.storybook/CLAUDE.md`**: "`aliases.ts` aliases four modules" keeps the four and adds "the images module under both of its names (`@/lib/images` and `@grimoire/ui/lib/images`)".

```powershell
node scripts/check-claude-md.mjs
```

Expected: exit 0.

- [ ] **Step 6: Sentences about a root `tsconfig.json` that is gone**

```powershell
git grep -n -E "root .tsconfig\.json|tsconfig\.json.s .paths|root program|the app's program" -- ":!docs/superpowers" ":!CHANGELOG.md"
```

For each line, make the sentence true: the options and `paths` are `tsconfig.base.json`'s; a program is its package's `tsconfig.json`. `infrastructure/relay/tsconfig.json`'s "rather than a wider `include` in the root `tsconfig.json`" becomes "rather than a place in a webview package's program". `scripts/golden.mjs`'s "`tsconfig.json`'s `"@/*": ["./packages/ui/*"]`" becomes `tsconfig.base.json`'s. Options are not changed, only comments.

- [ ] **Step 7: The spec's amendment**

In the spec, at the end of §6, add:

```markdown
**Amended during planning and execution (2026-10-08).** Seven things were measured and came out
differently from the paragraphs above; the plan
(`docs/superpowers/plans/2026-10-08-repository-layout-stage-2.md`) has each measurement.

- `@grimoire/desktop` also depends on `@grimoire/fake`, for its tests.
- `@grimoire/light` does not depend on `@grimoire/app-worker`. Rule 4 is wider than written: a
  file Node loads itself — a Vite, Vitest or Storybook config, and everything under `scripts/` —
  imports by relative path. Vite bundles what a config reaches by path and leaves a package name
  to Node, which could not run an `enum`; and `scripts/web-deploy-probe.mjs` runs in a job that
  installs nothing.
- The three Workers keep the `tsconfig.json` they had and do not extend `tsconfig.base.json`.
- The hosting Worker's one import from the shared UI is also a wrangler `alias`: `web-deploy`
  bundles it with no workspace links.
- A stylesheet goes on naming another by path; `@import` and `@source` lines were not rewritten.
- `.design-sync/` was left as written except for two lines of configuration.
- `npm run x -- --flag` became `pnpm x --flag`: pnpm hands a `--` to the script.

And one rule the design did not state, held by `scripts/workspace.test.mjs`: a package declares
what its files import. pnpm's layout does not enforce it — Node finds a package the root declares
from any folder beneath it.
```

and in §8, "After stage 2: delete `node_modules` and run `pnpm install`" gains: "— and `infrastructure/app-worker/node_modules`, which held the deploy tool; it installs into `infrastructure/wrangler` now."

- [ ] **Step 8: Checkpoint** (controller)

```powershell
node "<scratch>\workspace-commands.mjs" . | Select-String 'would respell'
git add -A
git status --short | Select-String -NotMatch '^(M|A|R|D) ' | Select-Object -First 5
git commit -m "wip(workspace): the commands, as pnpm spells them, and the docs"
```

Expected: `would respell 0 commands`; nothing unexpected staged (no `dist`, no `.local` file, no `node_modules`).

---

### Task 9: Hold it against the baseline

**Files:** none, unless a check fails.

**Interfaces:**
- Consumes: everything in `<scratch>` from Task 0, and `s2-lock-single.json` from Task 1.

- [ ] **Step 1: The whole of `verify`**

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
Get-Process cargo, rustc -ErrorAction SilentlyContinue   # must be empty
pnpm verify
```

Expected: exit 0. It builds every program, lints, runs `cargo fmt --check` and Clippy, the whole Vitest suite, `cargo test --workspace` and the card scanner's suite. If Vitest is killed partway on this machine, run it as three shards (`pnpm test:run --shard=1/3` …) and then the two cargo commands from the script by hand.

- [ ] **Step 2: The same tests**

```powershell
pnpm test:run --shard=1/3 --reporter=json --outputFile="<scratch>\s2-vitest-after-1.json"
pnpm test:run --shard=2/3 --reporter=json --outputFile="<scratch>\s2-vitest-after-2.json"
pnpm test:run --shard=3/3 --reporter=json --outputFile="<scratch>\s2-vitest-after-3.json"
node "<scratch>\vitest-count.mjs" "<scratch>\s2-counts-after.json" "<scratch>\s2-vitest-after-1.json" "<scratch>\s2-vitest-after-2.json" "<scratch>\s2-vitest-after-3.json"
node "<scratch>\vitest-count.mjs" --diff "<scratch>\s2-counts-before.json" "<scratch>\s2-counts-after.json"
cargo test --workspace 2>&1 | Select-String '^test result' | ForEach-Object { $_.Line } | Set-Content "<scratch>\s2-cargo-after.txt"
Compare-Object (Get-Content "<scratch>\s2-cargo-before.txt") (Get-Content "<scratch>\s2-cargo-after.txt")
```

Expected: `553 files, <more than N> tests, 0 failed`, and the comparison lists **only these files, each with more tests than it had**:

| File | Why it differs |
| --- | --- |
| `scripts/workspace.test.mjs` | new: 8 |
| `infrastructure/app-worker/src/hosting.test.ts` | +2 (Task 6) |
| `packages/fake/images.test.ts` | +1 (Task 2) |
| `scripts/vite-base.test.mjs` | +1 (Task 4) |
| `scripts/workflow-scripts.test.mjs` | three rules for each caller where there was one, three Tauri configs as callers, and the hooks' case |
| `scripts/toolchain.test.mjs` | +1 for each workflow, +2 |
| `scripts/release-rule.test.mjs` | +2 (`never sees pnpm`, for two jobs) |
| `scripts/ci-route.test.mjs` | +4 rows |

Any other file in the list, a file with fewer tests, or a file gone is a glob that moved or a test that stopped being collected: stop. `Compare-Object` prints nothing — the Rust counts did not move.

- [ ] **Step 3: The same builds**

```powershell
$env:CC_wasm32_unknown_unknown = "C:\Program Files\LLVM\bin\clang.exe"
$env:AR_wasm32_unknown_unknown = "C:\Program Files\LLVM\bin\llvm-ar.exe"
pnpm web:wasm
Get-FileHash dist-wasm\*.wasm -Algorithm SHA256 | ForEach-Object { "$($_.Hash)  $(Split-Path $_.Path -Leaf)" } | Set-Content "<scratch>\s2-wasm-after.txt"
Compare-Object (Get-Content "<scratch>\s2-wasm-before.txt") (Get-Content "<scratch>\s2-wasm-after.txt")
pnpm exec vite build --config apps/desktop/vite.config.ts
pnpm exec vite build --config apps/light/vite.config.ts
pnpm exec vite build --config apps/light/vite.config.ts --mode web
pnpm exec vite build --config apps/share/vite.config.ts
pnpm build-storybook
node "<scratch>\layout-builds.mjs" "<scratch>\s2-builds-after.json" desktop=apps/desktop/dist android=apps/light/dist-mobile web=apps/light/dist-web share=apps/share/dist-share storybook=storybook-static
node "<scratch>\layout-builds.mjs" --diff "<scratch>\s2-builds-before.json" "<scratch>\s2-builds-after.json"
node "<scratch>\lock-set.mjs" pnpm-lock.yaml "<scratch>\s2-lock-final.json"
node "<scratch>\lock-set.mjs" --diff "<scratch>\s2-lock-single.json" "<scratch>\s2-lock-final.json"
```

Expected:

- The WASM hashes are the same (nothing here touches a crate's code or manifest; a comment does not reach a release build's output). A difference is explained before going on, as stage 1 did.
- `desktop`, `android`, `web` and `share`: the same number of JavaScript files, **the same bytes** (0.00%), the same CSS rules.
- `storybook`: the same 541 files and CSS rules, and about **+3.3 KB** of JavaScript (0.02%). `layout-builds.mjs` calls a build different only past 1%, so it prints `every build emitted what it emitted`; the 3.3 KB is the two differences under "Known differences" at the top of this plan. If Storybook grew by more than about 5 KB, or any app's bytes moved at all, find the file before going on — a module bundled twice looks like this.
- The lockfile still resolves the set npm had: `0 gone, 0 new`, twice.

- [ ] **Step 4: The deploy job's bundle, once more, on the finished tree**

Task 6 Step 3's dry run again (Bash, with `node_modules` in `infrastructure/app-worker` moved aside and put back). Expected: `Total Upload` and `--dry-run: exiting now.`

> **Corrected 2026-10-09, after the final review.** As written, this step moves only the
> Worker's own `node_modules` aside. The root manifest declares `@grimoire/ui` too, so
> `node_modules/@grimoire/ui` at the repository root is still there, and resolution from the
> Worker's `src/` walks up to it: run this way **with the `alias` line deleted**, wrangler still
> printed `Total Upload`. The step proved nothing about the alias. Measured again with both
> link folders moved aside (`infrastructure/app-worker/node_modules` and the root's
> `node_modules/@grimoire`): without the alias, `Could not resolve
> "@grimoire/ui/lib/core/web/assets"`; with it, `Total Upload: 1.33 KiB / gzip: 0.71 KiB`. The
> reviewer measured the same from a `git archive` of the commit with no `node_modules` on any
> ancestor. That is the run the pull request cites.

- [ ] **Step 5: Live, on this machine**

The `running-the-app` skill first: the app lock, and port 1420. Then, each seen and written in the ledger:

1. **`pnpm tauri dev`** (by the skill's `Start-Process pnpm.cmd` line) opens the desktop app on this worktree's dev database. This proves `beforeDevCommand`'s `pnpm -w run dev` from `apps/desktop`. Over CDP: the collection page lists cards, and `document.querySelectorAll('img')` are `mtgimg` pictures.
2. **`pnpm mobile:dev`**, the light app over the fake, and the one check Review Focus 3 asks for:

```powershell
(Invoke-WebRequest "http://localhost:5175/phone/scanner/Tray.tsx" -UseBasicParsing).Content -split "`n" | Select-String 'images'
(Invoke-WebRequest "http://localhost:5175/phone/pages/DecksPage.tsx" -UseBasicParsing).Content -split "`n" | Select-String 'images'
```

   Expected: each import of the images module is served as `…/packages/fake/images.ts`, not `…/packages/ui/lib/images.ts`. Then open `http://localhost:5175/decks` at 360 px: the decks draw synthetic art.
3. **`pnpm mobile:tauri`**: the phone-sized window opens over the real engine (`beforeDevCommand` in the overlay config).
4. **`pnpm web:build`** then **`pnpm web:smoke`**: passes.
5. **`pnpm storybook`** (the Storybook lock): one story of the shared UI and one of the light app render; `TabBar`'s docs page shows the `view` prop with the type recorded under "Known differences".

- [ ] **Step 6: Checkpoint** (controller): commit anything a check made necessary as `wip(workspace): …`, with the reason in the ledger.

---

### Task 10: One commit, and the pull request

**Files:** none new.

- [ ] **Step 1: Squash**

```powershell
Set-Location "D:\Code\mtg-grimoire\.claude\worktrees\repo-structure-cleanup-66d570"
git fetch --prune origin
git log --oneline origin/main..HEAD
git merge-base --is-ancestor origin/main HEAD; $LASTEXITCODE
```

If `origin/main` has moved, merge it in (never rebase), run `pnpm install` and Task 9 Steps 1 and 3's lockfile comparison again. Then:

```powershell
git reset --soft origin/main
git status --short | Measure-Object | ForEach-Object Count
```

and commit once, with the message in a file under `<scratch>` (`git commit -F`):

```text
chore: make the repository a pnpm workspace of packages

The shared UI, the fake, the three apps and the three Workers each have a
manifest that declares what their files import, and a module in another
package is imported by the package's name. `@/` is the shared UI's own alias
and is written only inside it. One TypeScript program and one Vitest project
per package; the deploy tool moves to infrastructure/wrangler and stays on
npm, outside the workspace, and the two jobs that hold a secret run no pnpm.

Nothing a user sees changes. The lockfile resolves the same packages npm's
did, and the desktop, Android, web and share bundles are byte for byte what
they were.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

- [ ] **Step 2: Push and open the pull request**

```powershell
git push -u origin claude/pnpm-workspace
```

Open it against `main` with `gh pr create`, the body from a file. The body states, in this order: what changed (the paragraph above); **what was measured** (the lock set, the five builds, the test counts, `tsc`'s time before and after); the **two known differences** (Storybook's prop tables for three app components; nothing else); **what no run here could prove** — the Android build through Gradle's `pnpm --workspace-root run tauri:light`, which this pull request's `android` job is the first to run, and `release.yml`, whose `build` leg (`tauri-action` choosing pnpm) and `web-deploy` (the tool's new folder, the bundle with no links) first run at the next release; and **what the owner does after merging**:

```markdown
## After merging — once per checkout

1. Close the app.
2. Delete `node_modules`, and `infrastructure/app-worker/node_modules` if it is there.
3. `pnpm install`. If `pnpm` is not found, `corepack enable` first; the version is pinned in `package.json`.
4. Every command is `pnpm <name>` now: `pnpm tauri dev`, `pnpm verify`. Arguments follow the name with no `--`.
5. Android Studio and Gradle start `pnpm`, so it has to be on their `PATH` too.
6. Old worktrees are deleted or re-created; a session's first hook installs a new one's dependencies.

Nothing here deploys. The next release is the first run of the re-pathed deploy job.
```

It ends with the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: CI**

Bind the pull request with the `ccd_pr` tools and read its checks; do not poll, and do not enable auto-merge. This pull request changes `ci.yml`, so every job is routed. What to read in particular:

- **`android`** — the first Gradle run of `BuildTask.kt` under pnpm. A failure naming `pnpm` or `tauri:light` is Task 5 Step 2's.
- **`frontend`**, three shards — each must report a different, non-empty set of files; a shard that ran everything or nothing is a `--` that survived.
- **`web`** — `pnpm scanner:assets --web` fetched the web's files, and the sync smoke found wrangler in `infrastructure/wrangler`.
- **`release-please`**, on `main` after the merge — it runs on every push and must not fail for want of a `package-lock.json`.

The merge is the owner's.

---

## Appendix A: `workspace-manifests.mjs`

As it ran in the planning session. It is not committed.

```js
// node workspace-manifests.mjs <checkout>
// Writes the nine manifests and pnpm-workspace.yaml from one table: which package imports what.
// Every range is copied from the root manifest as it stands, so nothing is retyped. A name that
// more than one package declares goes in the catalog and is written `catalog:` where it is used.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const at = (...p) => path.join(root, ...p);
const rootManifest = JSON.parse(readFileSync(at("package.json"), "utf8"));
const ranges = { ...rootManifest.dependencies, ...rootManifest.devDependencies, "prosemirror-view": "^1.42.3" };
for (const name of Object.keys(ranges)) if (ranges[name] === "catalog:") throw new Error("run this on the single-manifest tree");

const W = "workspace:*";
/** folder -> [name, dependencies, devDependencies]. `@grimoire/*` names are workspace links. */
const PACKAGES = {
  "packages/ui": ["@grimoire/ui",
    ["@dnd-kit/abstract", "@dnd-kit/collision", "@dnd-kit/dom", "@fontsource-variable/geist", "@fontsource-variable/geist-mono", "@fontsource/cinzel", "@tanstack/react-query", "@tanstack/react-virtual", "@tauri-apps/api", "@tauri-apps/plugin-clipboard-manager", "@tauri-apps/plugin-opener", "@tiptap/extension-heading", "@tiptap/extension-list", "@tiptap/extensions", "@tiptap/markdown", "@tiptap/pm", "@tiptap/react", "@tiptap/starter-kit", "clsx", "jsqr", "lucide-react", "motion", "prosemirror-view", "react", "react-dom", "tailwind-merge", "tw-animate-css", "zustand"],
    ["@grimoire/fake", "@storybook/react-vite", "@testing-library/jest-dom", "@testing-library/react", "@testing-library/user-event", "@types/react", "@types/react-dom", "keyrune", "mana-font", "shadcn", "storybook", "tailwindcss", "vite", "vitest"]],
  "packages/fake": ["@grimoire/fake",
    ["@grimoire/ui", "@tanstack/react-query"],
    ["jsqr", "vitest"]],
  "apps/desktop": ["@grimoire/desktop",
    ["@grimoire/ui", "keyrune", "mana-font", "react", "react-dom"],
    ["@grimoire/fake", "@storybook/react-vite", "@tauri-apps/api", "@testing-library/react", "@types/react", "@types/react-dom", "storybook", "vite", "vitest"]],
  "apps/light": ["@grimoire/light",
    ["@grimoire/fake", "@grimoire/ui", "@tanstack/react-query", "@tanstack/react-virtual", "keyrune", "lucide-react", "mana-font", "motion", "react", "react-dom", "zustand"],
    ["@storybook/react-vite", "@tauri-apps/api", "@testing-library/react", "@testing-library/user-event", "@types/react", "@types/react-dom", "storybook", "vite", "vitest"]],
  "apps/share": ["@grimoire/share",
    ["@grimoire/ui", "react", "react-dom"],
    ["@testing-library/react", "@testing-library/user-event", "@types/react", "@types/react-dom", "vite", "vitest"]],
  "infrastructure/relay": ["@grimoire/relay", [], ["@cloudflare/workers-types", "vitest"]],
  "infrastructure/share-worker": ["@grimoire/share-worker", ["@grimoire/relay"], ["@cloudflare/workers-types", "vitest"]],
  "infrastructure/app-worker": ["@grimoire/app-worker", ["@grimoire/ui"], ["@cloudflare/workers-types", "vitest"]],
};
/** The root: the tools, and what `.storybook/`, `scripts/` and `.design-sync/` import or name by path. */
const ROOT_DEV = ["@eslint/js", "@fontsource-variable/geist", "@fontsource-variable/geist-mono", "@fontsource/cinzel", "@grimoire/fake", "@grimoire/ui", "@storybook/addon-a11y", "@storybook/addon-docs", "@storybook/addon-mcp", "@storybook/react-vite", "@tailwindcss/vite", "@tanstack/react-query", "@tauri-apps/cli", "@types/react", "@vitejs/plugin-react", "@vitest/coverage-v8", "eslint", "eslint-plugin-react-hooks", "eslint-plugin-storybook", "jsdom", "jsqr", "keyrune", "mana-font", "motion", "prettier", "react", "react-dom", "storybook", "typescript", "typescript-eslint", "vite", "vitest"];

const uses = {};
for (const list of [ROOT_DEV, ...Object.values(PACKAGES).flatMap(([, d, v]) => [d, v])])
  for (const name of list) if (!name.startsWith("@grimoire/")) uses[name] = (uses[name] ?? 0) + 1;
const declared = new Set(Object.keys(uses));
const dropped = Object.keys(ranges).filter((n) => !declared.has(n));
if (dropped.length) throw new Error(`declared at the root today and by no package: ${dropped.join(", ")}`);
const catalog = Object.keys(uses).filter((n) => uses[n] > 1).sort();
const spec = (name) => {
  if (name.startsWith("@grimoire/")) return W;
  if (!ranges[name]) throw new Error(`no range for ${name}`);
  return catalog.includes(name) ? "catalog:" : ranges[name];
};
const section = (names) => Object.fromEntries([...names].sort().map((n) => [n, spec(n)]));
const write = (file, manifest) => writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");

for (const [folder, [name, deps, dev]] of Object.entries(PACKAGES)) {
  const manifest = { name, version: "0.0.0", private: true, license: rootManifest.license, type: "module" };
  if (deps.length) manifest.dependencies = section(deps);
  if (dev.length) manifest.devDependencies = section(dev);
  write(at(folder, "package.json"), manifest);
}
const { dependencies: _gone, devDependencies: _too, ...rest } = rootManifest;
write(at("package.json"), { ...rest, devDependencies: section(ROOT_DEV) });

const quote = (n) => (n.startsWith("@") ? `"${n}"` : n);
writeFileSync(at("pnpm-workspace.yaml"), [
  "packages:",
  "  - packages/*",
  "  - apps/*",
  "  - infrastructure/relay",
  "  - infrastructure/share-worker",
  "  - infrastructure/app-worker",
  "",
  "catalog:",
  ...catalog.map((n) => `  ${quote(n)}: ${/^[\^~]/.test(ranges[n]) ? `"${ranges[n]}"` : ranges[n]}`),
  "",
  "allowBuilds:",
  "  esbuild: false",
  "",
].join("\n"));
console.log(`${Object.keys(PACKAGES).length + 1} manifests; catalog of ${catalog.length}: ${catalog.join(", ")}`);
```

## Appendix B: `workspace-imports.mjs`

As it ran. It is not committed.

```js
// node workspace-imports.mjs <checkout> [--write] [--list]
//
// Rewrites module specifiers to the workspace's import rules, and nothing else in a file:
//   1. a module in another package is named by the package (`@grimoire/ui/lib/x`);
//   2. `@/` is the shared UI's own alias, so outside `packages/ui` it becomes `@grimoire/ui/`.
// Left as written, and counted: a specifier with a query (`?raw`, `?url` — a read of a file's
// text, rule 3), every import in a file Node loads itself (rule 4), and the files in KEEP.
//
// It parses each file with the checkout's own TypeScript and edits only the string of an import,
// an export-from, an `import()`, an `import("…")` type, a `require` or a `vi.mock`-family call. A
// string that merely looks like a specifier — a fence test's sample source, a comment — is not one.
// Files come from `git ls-files`: a workspace's `node_modules` links form a cycle a walk never leaves.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const WRITE = process.argv.includes("--write");
const LIST = process.argv.includes("--list");
const ts = createRequire(path.join(root, "package.json"))("typescript");
const { posix } = path;

const PACKAGES = [
  ["packages/ui/", "@grimoire/ui"],
  ["packages/fake/", "@grimoire/fake"],
  ["apps/desktop/", "@grimoire/desktop"],
  ["apps/light/", "@grimoire/light"],
  ["apps/share/", "@grimoire/share"],
  ["infrastructure/relay/", "@grimoire/relay"],
  ["infrastructure/share-worker/", "@grimoire/share-worker"],
  ["infrastructure/app-worker/", "@grimoire/app-worker"],
];
const ownerOf = (p) => PACKAGES.find(([dir]) => `${p}/`.startsWith(dir)) ?? null;
const nameOf = (owner) => (owner ? owner[1].slice("@grimoire/".length) : "root");

/** Rule 4: Node loads these itself, before any alias or workspace link means anything to a bundler. */
const NODE_LOADED = (f) =>
  /\.(mjs|cjs|js)$/.test(f) || /(^|\/)vite(\.[\w-]+)*\.ts$/.test(f) || f === "vitest.config.ts" || f === ".storybook/main.ts";
/** Whole trees that are not this workspace's TypeScript. */
const SKIPPED = (f) => f.startsWith("crates/") || f.includes("/src-tauri/") || f.startsWith(".design-sync/") || f.startsWith("docs/");
/**
 * The fake's `images.ts` re-exports the real module, and both hosts alias the real module's
 * names to that file: named any way an alias matches, the import is the file importing itself.
 */
const KEEP = new Set(["packages/fake/images.ts"]);
const MOCKS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);

function specifiersOf(sf) {
  const out = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      out.push(node.argument.literal);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isMock = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "vi" && MOCKS.has(callee.name.text);
      if (isImport || isRequire || isMock) out.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mts", "*.mjs", "*.js"], { cwd: root, maxBuffer: 1 << 26 })
  .toString().split("\n").filter(Boolean).filter((f) => !SKIPPED(f));

const tally = {}; // "from -> to: what" -> count
const left = []; // [reason, file, spec]
const bump = (k) => (tally[k] = (tally[k] ?? 0) + 1);
let changedFiles = 0, rewritten = 0;

for (const file of files) {
  const text = readFileSync(path.join(root, file), "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(mjs|js)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const from = ownerOf(file);
  const edits = [];
  for (const lit of specifiersOf(sf)) {
    const spec = lit.text;
    const [bare, ...query] = spec.split("?");
    let to, next;
    if (spec.startsWith("@/")) {
      if (from?.[1] === "@grimoire/ui") continue; // rule 2
      to = PACKAGES[0];
      next = query.length
        ? `${posix.relative(posix.dirname(file), `packages/ui/${bare.slice(2)}`)}?${query.join("?")}`
        : `@grimoire/ui/${spec.slice(2)}`;
    } else if (spec.startsWith(".")) {
      const target = posix.normalize(posix.join(posix.dirname(file), bare));
      to = ownerOf(target);
      if (to === from) continue;
      if (!to) { left.push([`into the root, from ${nameOf(from)}`, file, spec]); continue; }
      const within = target.slice(to[0].length);
      next = within ? `${to[1]}/${within}` : to[1];
    } else continue;

    const edge = `${nameOf(from)} -> ${nameOf(to)}`;
    if (!spec.startsWith("@/") && query.length) { left.push(["a file's text (rule 3)", file, spec]); bump(`${edge}: left, text read`); continue; }
    if (NODE_LOADED(file)) { left.push(["Node loads this file (rule 4)", file, spec]); bump(`${edge}: left, Node-loaded file`); continue; }
    if (KEEP.has(file)) { left.push(["named exception", file, spec]); bump(`${edge}: left, named exception`); continue; }
    bump(`${edge}: ${spec.startsWith("@/") ? "@/ alias" : "relative path"} -> package name`);
    edits.push([lit.getStart(sf) + 1, lit.getEnd() - 1, next]);
  }
  if (!edits.length) continue;
  changedFiles++; rewritten += edits.length;
  if (WRITE) {
    let out = text;
    for (const [a, b, next] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + next + out.slice(b);
    writeFileSync(path.join(root, file), out);
  }
}

for (const k of Object.keys(tally).sort()) console.log(`${String(tally[k]).padStart(5)}  ${k}`);
console.log(`${WRITE ? "rewrote" : "would rewrite"} ${rewritten} specifiers in ${changedFiles} of ${files.length} files; left ${left.length} as written`);
if (LIST) for (const [why, file, spec] of left.sort()) console.log(`  ${why}: ${file} -> ${spec}`);
```

## Appendix C: `workspace-commands.mjs`

As it ran, dry. It is not committed.

```js
// node workspace-commands.mjs <checkout> [--write] [--left]
//
// Respells the commands a living file tells someone to run, from npm to pnpm — in prose, in a
// comment, in an error message. It does not decide anything: each rule below is one spelling of
// one command. What it leaves that still says npm, npx or package-lock is printed with `--left`,
// for a person to read; most of it is about the deploy tool, which stays on npm.
//
// **`npm run x -- --flag` loses its `--`.** npm strips the separator; pnpm hands it to the script,
// where Vitest reads everything after it as a file filter (measured 2026-10-08: `pnpm run x -- --web`
// gave the script `["--", "--web"]`).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const WRITE = process.argv.includes("--write");
const LEFT = process.argv.includes("--left");

/** Written by hand in their own tasks, or not this change's to touch. */
const SKIP = [
  /^docs\/superpowers\//, // dated plans, specs and notes: left as written
  /^CHANGELOG\.md$/,
  /(^|\/)package-lock\.json$/, /^pnpm-lock\.yaml$/, /(^|\/)package\.json$/,
  /^infrastructure\/wrangler\//, // the deploy tool: npm's, on purpose
  /^\.github\/workflows\//, /^\.github\/actions\//, // each line is a decision
  /^scripts\/.*\.test\.mjs$/, /^apps\/light\/host\.test\.ts$/, // fences that pin a spelling
  /^apps\/light\/src-tauri\/gen\//, /tauri(\.[\w-]+)?\.conf\.json$/,
  /^\.claude\/hooks\//,
  /^infrastructure\/[^/]+\/(migrations\/|schema\.sql$)/, // applied to a database as written
  /^\.design-sync\//, /^\.mcp\.json$/, // the converter's own folder; a server fetched by npx
  /^Cargo\.lock$/, /\.(png|jpe?g|webp|ico|icns|woff2?|ttf|bin|rten|aab|apk|jar|keystore|svg|gz|wasm|pdf)$/i,
];

const RULES = [
  [/\bnpm run ([\w][\w:.-]*) -- /g, "pnpm $1 "],
  [/\bnpm run ([\w][\w:.-]*)/g, "pnpm $1"],
  [/\bnpm ci\b(?! --ignore-scripts)/g, "pnpm install --frozen-lockfile"],
  [/\bnpm install\b(?! --package-lock-only| -g)/g, "pnpm install"],
  [/\bnpm test\b/g, "pnpm test"],
  [/\bnpx (tauri|vitest|tsc|eslint|storybook|prettier)\b(?!@)/g, "pnpm exec $1"],
  [/\bnpm-install\.local\b/g, "pnpm-install.local"],
];
const STILL = /\bnpm\b|\bnpx\b|package-lock/;

const files = execFileSync("git", ["ls-files"], { cwd: root, maxBuffer: 1 << 26 })
  .toString().split("\n").filter(Boolean).filter((f) => !SKIP.some((re) => re.test(f)));

let changedFiles = 0, total = 0;
const perRule = RULES.map(() => 0);
const left = [];
for (const file of files) {
  let text;
  try { text = readFileSync(path.join(root, file), "utf8"); } catch { continue; }
  if (text.includes("\u0000")) continue;
  let next = text;
  RULES.forEach(([from, to], i) => {
    next = next.replace(from, (...m) => { perRule[i]++; total++; return to.replace("$1", m[1] ?? ""); });
  });
  if (next !== text) { changedFiles++; if (WRITE) writeFileSync(path.join(root, file), next); }
  next.split("\n").forEach((line, n) => { if (STILL.test(line)) left.push(`${file}:${n + 1}: ${line.trim().slice(0, 160)}`); });
}
RULES.forEach(([from], i) => console.log(`${String(perRule[i]).padStart(5)}  ${from.source}`));
console.log(`${WRITE ? "respelled" : "would respell"} ${total} commands in ${changedFiles} of ${files.length} files; ${left.length} lines still say npm, npx or package-lock`);
if (LEFT) for (const line of left) console.log(`  ${line}`);
```

## Appendix D: `lock-set.mjs`

```js
// node lock-set.mjs <pnpm-lock.yaml> [out.json]            — record the lockfile's resolved set
// node lock-set.mjs --diff <before.json> <after.json>      — what the second has that the first has not, and the reverse
// `packages:` holds one key per name@version; `snapshots:` one per name@version(peers…).
import { readFileSync, writeFileSync } from "node:fs";

function read(file) {
  const out = { packages: [], snapshots: [] };
  let section = null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const top = /^([A-Za-z]+):\s*$/.exec(line);
    if (top) { section = top[1] in out ? top[1] : null; continue; }
    if (!section) continue;
    const key = /^ {2}(\S.*?):(?:\s*\{\})?\s*$/.exec(line);
    if (key) out[section].push(key[1].replace(/^'|'$/g, ""));
  }
  out.packages.sort(); out.snapshots.sort();
  return out;
}

if (process.argv[2] === "--diff") {
  const a = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const b = JSON.parse(readFileSync(process.argv[4], "utf8"));
  let differences = 0;
  for (const section of ["packages", "snapshots"]) {
    const gone = a[section].filter((k) => !b[section].includes(k));
    const added = b[section].filter((k) => !a[section].includes(k));
    differences += gone.length + added.length;
    console.log(`${section}: ${a[section].length} -> ${b[section].length}, ${gone.length} gone, ${added.length} new`);
    for (const k of gone) console.log(`  - ${k}`);
    for (const k of added) console.log(`  + ${k}`);
  }
  process.exit(differences ? 1 : 0);
} else {
  const set = read(process.argv[2]);
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(set, null, 1));
  console.log(`${set.packages.length} packages, ${set.snapshots.length} snapshots`);
}
```

## Appendix E: `scripts/workspace.test.mjs`

The one of the five that is committed. It passed 8 of 8 in the planning session's checkout, and failed as Task 4 describes when broken each of the three ways.

```js
// The workspace's import rules, held over every file a package is written in.
//
//   1. A module in another package is imported by the package's name (`@grimoire/ui/lib/x`).
//   2. Inside `packages/ui`, `@/` is the package's own root. Nowhere else may use it.
//   3. A read of a file's text (`?raw`, `?url`) names the file by relative path: it reads the
//      repository and imports no module.
//   4. A file Node loads itself imports by relative path: a Vite, Vitest or Storybook config, and
//      everything under `scripts/`. Vite bundles what its config reaches by path and leaves a
//      package name to Node, which runs another package's TypeScript only as far as it can strip
//      the types (measured 2026-10-08: an `enum` behind a package name failed the config's load,
//      and the same file by path built). And `scripts/web-deploy-probe.mjs` runs in a job that
//      installs nothing, where no workspace link exists.
//
// And the rule pnpm's layout cannot hold by itself: **a package declares what its files import.**
// pnpm links into a package's `node_modules` only what its manifest names — but Node goes on
// looking in every folder above, so a name the root declares resolves from any package, in every
// checkout and in CI, and a worktree under `.claude/worktrees/` reaches the main checkout's tree
// as well. `prosemirror-view` was imported for months on the strength of npm's hoisting. Nothing
// that runs the code can see this, so it is read here.
//
// Specifiers are found with the compiler, not a pattern: several tests in this tree hold sample
// source in strings (`apps/light/phone/fence.test.ts` spells an import of `@tauri-apps/plugin-os`
// in order to refuse it), and a pattern reads those as imports.
import { builtinModules } from "node:module";
import { posix } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const MANIFESTS = import.meta.glob(
  ["/package.json", "/packages/*/package.json", "/apps/*/package.json", "/infrastructure/*/package.json"],
  { query: "?raw", import: "default", eager: true },
);

// Vite needs both glob arguments as literals. `node_modules` is left out by Vite itself; a
// Tauri host's folder and a build's output hold no source of a package.
const CODE = import.meta.glob(
  [
    "/packages/**/*.{ts,tsx}",
    "/apps/**/*.{ts,tsx}",
    "/infrastructure/**/*.ts",
    "/.storybook/**/*.{ts,tsx}",
    "/scripts/**/*.mjs",
    "/*.{ts,js}",
    "!/apps/*/src-tauri/**",
    "!/apps/*/dist*/**",
    "!**/.wrangler/**",
  ],
  { query: "?raw", import: "default", eager: true },
);
const STYLES = import.meta.glob(
  ["/packages/**/*.css", "/apps/**/*.css", "/.storybook/**/*.{css,mdx}", "!/apps/*/src-tauri/**", "!/apps/*/dist*/**"],
  { query: "?raw", import: "default", eager: true },
);

/** The eight packages below the root, by folder. A file in none of them is the root's. */
const PACKAGES = Object.keys(MANIFESTS)
  .filter((path) => path !== "/package.json")
  .map((path) => ({ dir: path.slice(0, -"package.json".length), manifest: JSON.parse(MANIFESTS[path]) }))
  // The deploy tool's folder is npm's, with a lockfile of its own, and is no package of this workspace.
  .filter(({ manifest }) => manifest.name?.startsWith("@grimoire/"));
const ROOT = { dir: "/", manifest: JSON.parse(MANIFESTS["/package.json"]) };
const ownerOf = (path) => PACKAGES.find(({ dir }) => `${path}/`.startsWith(dir)) ?? ROOT;
const declares = ({ manifest }, name) =>
  manifest.name === name ||
  name in (manifest.dependencies ?? {}) ||
  name in (manifest.devDependencies ?? {}) ||
  name in (manifest.peerDependencies ?? {});

/** Rule 4. */
const NODE_LOADED = (path) =>
  /\.(mjs|cjs|js)$/.test(path) ||
  /\/vite(\.[\w-]+)*\.ts$/.test(path) ||
  path === "/vitest.config.ts" ||
  path === "/.storybook/main.ts";

/**
 * The one module that names another package's by path on purpose. Both of the fake's hosts alias
 * the real images module's names to this file, so named either way an alias matches, its
 * re-export would be the file importing itself (the file's own header).
 */
const BY_PATH_ON_PURPOSE = ["/packages/fake/images.ts"];

const MOCKS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);

/** Every module specifier `source` names, wherever TypeScript lets one be written. */
function specifiersOf(path, source) {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(mjs|js)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, kind);
  const out = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      out.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isMock =
        ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "vi" && MOCKS.has(callee.name.text);
      if (isImport || isRequire || isMock) out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  // `/// <reference types="vite/client" />` is a dependency the compiler resolves like an import.
  for (const [, name] of source.matchAll(/^\/\/\/\s*<reference\s+types="([^"]+)"/gm)) out.push(name);
  return out;
}

/**
 * What a stylesheet or an MDX page names: `@import "x"`, `@plugin "x"`, and `import … from "x"`.
 * Comments go first: every app's stylesheet quotes the shared one's `@import "tailwindcss"` in
 * the prose above its own imports.
 */
function styleSpecifiersOf(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  return [
    ...[...code.matchAll(/@(?:import|plugin|config)\s+["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...code.matchAll(/^import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]),
  ];
}

const isRelative = (spec) => spec.startsWith(".");
const isBare = (spec) => !isRelative(spec) && !spec.startsWith("/") && !spec.startsWith("@/") && !/^[a-z]+:/.test(spec);
const BUILTINS = new Set(builtinModules);
/** `@scope/name/deep/path?raw` → `@scope/name`. */
const packageOf = (spec) => spec.split("?")[0].split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

/** Every breach in a tree of sources, one line each. */
function breachesIn(code, styles = {}) {
  const undeclared = [];
  const alias = [];
  const byPath = [];
  for (const [path, source] of Object.entries(code)) {
    const owner = ownerOf(path);
    for (const spec of specifiersOf(path, source)) {
      if (spec.startsWith("@/")) {
        if (owner.manifest.name !== "@grimoire/ui") alias.push(`${path} → ${spec}`);
      } else if (isRelative(spec)) {
        if (spec.includes("?") || NODE_LOADED(path) || BY_PATH_ON_PURPOSE.includes(path)) continue;
        const target = posix.join(posix.dirname(path), spec);
        const other = ownerOf(target);
        if (other !== owner && other !== ROOT) byPath.push(`${path} → ${spec}`);
      } else if (isBare(spec) && !BUILTINS.has(packageOf(spec)) && !declares(owner, packageOf(spec))) {
        undeclared.push(`${path} → ${packageOf(spec)}`);
      }
    }
  }
  for (const [path, source] of Object.entries(styles)) {
    const owner = ownerOf(path);
    for (const spec of styleSpecifiersOf(source)) {
      if (isBare(spec) && !declares(owner, packageOf(spec))) undeclared.push(`${path} → ${packageOf(spec)}`);
    }
  }
  return { undeclared: [...new Set(undeclared)], alias, byPath };
}

describe("the workspace's packages", () => {
  it("are the eight, each private and at 0.0.0, and the root", () => {
    expect(PACKAGES.map(({ dir, manifest }) => `${dir} ${manifest.name}`).sort()).toEqual([
      "/apps/desktop/ @grimoire/desktop",
      "/apps/light/ @grimoire/light",
      "/apps/share/ @grimoire/share",
      "/infrastructure/app-worker/ @grimoire/app-worker",
      "/infrastructure/relay/ @grimoire/relay",
      "/infrastructure/share-worker/ @grimoire/share-worker",
      "/packages/fake/ @grimoire/fake",
      "/packages/ui/ @grimoire/ui",
    ]);
    // release-please bumps the root's version and no other: a package with a version of its own
    // is one more file a release would have to move.
    for (const { dir, manifest } of PACKAGES) {
      expect(manifest.version, dir).toBe("0.0.0");
      expect(manifest.private, dir).toBe(true);
    }
    expect(ROOT.manifest.name).toBe("mtg-grimoire");
  });

  it("depend on each other as the design says, and on no app", () => {
    const links = Object.fromEntries(
      [ROOT, ...PACKAGES].map(({ manifest }) => [
        manifest.name,
        Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
          .filter((name) => name.startsWith("@grimoire/"))
          .sort(),
      ]),
    );
    expect(links).toEqual({
      "mtg-grimoire": ["@grimoire/fake", "@grimoire/ui"],
      "@grimoire/ui": ["@grimoire/fake"],
      "@grimoire/fake": ["@grimoire/ui"],
      "@grimoire/desktop": ["@grimoire/fake", "@grimoire/ui"],
      "@grimoire/light": ["@grimoire/fake", "@grimoire/ui"],
      "@grimoire/share": ["@grimoire/ui"],
      "@grimoire/relay": [],
      "@grimoire/share-worker": ["@grimoire/relay"],
      "@grimoire/app-worker": ["@grimoire/ui"],
    });
    // The shared UI reaches the fake from its tests and stories only.
    const ui = PACKAGES.find(({ manifest }) => manifest.name === "@grimoire/ui").manifest;
    expect(Object.keys(ui.dependencies).filter((name) => name.startsWith("@grimoire/"))).toEqual([]);
  });
});

describe("what each package imports", () => {
  const { undeclared, alias, byPath } = breachesIn(CODE, STYLES);

  it("is declared in that package's own manifest", () => {
    expect(undeclared).toEqual([]);
  });

  it("uses `@/` only inside the shared UI", () => {
    expect(alias).toEqual([]);
  });

  it("names another package's module by the package, not by a path", () => {
    expect(byPath).toEqual([]);
  });
});

describe("the rule's own guards", () => {
  // A sweep over nothing passes everything above.
  it("reads the tree", () => {
    expect(Object.keys(CODE).length).toBeGreaterThan(1200);
    expect(Object.keys(STYLES)).toContain("/packages/ui/index.css");
    expect(Object.keys(CODE).filter((path) => path.includes("/node_modules/"))).toEqual([]);
    expect(specifiersOf("/apps/light/main.tsx", CODE["/apps/light/main.tsx"])).toContain("react-dom/client");
    expect(styleSpecifiersOf(STYLES["/packages/ui/index.css"])).toContain("tailwindcss");
  });

  it("finds each breach in a tree that has one", () => {
    const tree = {
      "/apps/light/phone/A.tsx": [
        `import { x } from "@/lib/x";`,
        `import { y } from "../../../packages/ui/lib/y";`,
        `import text from "../../../packages/ui/lib/y.ts?raw";`,
        `import { z } from "left-pad";`,
        `import { useState } from "react";`,
        `import { w } from "@grimoire/ui/lib/w";`,
        `vi.mock("@grimoire/relay/src/token", () => ({}));`,
        `const lazy = await import("some-lazy-package/deep");`,
        `type T = typeof import("a-types-package");`,
        `const sample = 'import { no } from "not-an-import";';`,
        `// import { no } from "nor-this";`,
      ].join("\n"),
      "/packages/ui/lib/x.ts": `import { y } from "@/lib/y";`,
      "/packages/fake/images.ts": `export * from "../ui/lib/images";`,
      "/packages/fake/db.ts": `import { v } from "../ui/lib/v";`,
      "/apps/light/vite.config.ts": `import { a } from "../../packages/fake/aliases.ts";`,
      "/scripts/probe.mjs": `import { h } from "../infrastructure/app-worker/src/headers.ts";`,
    };
    expect(breachesIn(tree, { "/apps/light/mobile.css": `@import "../../packages/ui/index.css";\n@import "a-css-package";` })).toEqual({
      undeclared: [
        "/apps/light/phone/A.tsx → left-pad",
        "/apps/light/phone/A.tsx → @grimoire/relay",
        "/apps/light/phone/A.tsx → some-lazy-package",
        "/apps/light/phone/A.tsx → a-types-package",
        "/apps/light/mobile.css → a-css-package",
      ],
      alias: ["/apps/light/phone/A.tsx → @/lib/x"],
      byPath: ["/apps/light/phone/A.tsx → ../../../packages/ui/lib/y", "/packages/fake/db.ts → ../ui/lib/v"],
    });
  });

  it("names files that exist as its exceptions", () => {
    for (const path of BY_PATH_ON_PURPOSE) expect(Object.keys(CODE)).toContain(path);
  });
});
```
