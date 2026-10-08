# Repository layout and pnpm workspace — design

**Date:** 2026-10-08 · **Status:** awaiting the owner's review

## 1. Goal

The root of the repository shows what is in it — the desktop app, the light app (Android and web),
the public share page, what the three share, and the Cloudflare infrastructure — and each of those
is a package with its own manifest in a pnpm workspace.

This is a restructure and nothing else. No behaviour changes, no schema rung, no user-visible
difference, and neither stage deploys anything.

Success is: four code folders at the root (`apps/`, `packages/`, `crates/`, `infrastructure/`); the
same tests run and pass; every build emits what it emitted before; a module in another package is
imported by that package's name.

## 2. Decisions (the owner's, 2026-10-08)

| Question | Decision |
| --- | --- |
| How far | **The full layout**: `apps/`, `packages/`, `crates/`, `infrastructure/`. |
| Mobile and web | **One app named `light`, two hosts.** `mobile/` is renamed; web's pieces stay where they are. |
| JavaScript workspace | **pnpm, with real packages.** Chosen against the recommendation of no workspace. |
| Shared UI source | **At the package root**, not under `src/`. |
| Build outputs | **Inside each app.** |
| Storybook's fake | **Its own package**, `packages/fake`. |
| Deploy tool | **Stays on npm with its own lockfile, outside the workspace.** |
| Cargo build tree | **`<root>/target`.** `.cargo/config.toml` stays and pins it there — amended during execution, §5. |
| Cargo manifests | **`[workspace.package]`** for version, edition and license. No `[workspace.dependencies]`. |
| Landing | **Two pull requests**: the moves, then the workspace. |
| Open branches | **Not carried.** The owner: "everything is stable at the moment and we can make major changes." |

## 3. What was found (read 2026-10-08, at `54605405`)

- **`src/` is the shared frontend already.** Tracing imports from each entry point: of 614
  production modules in `src/`, 595 are reached by both the desktop entry and the light entry,
  because the light app's `DesktopFace` mounts the desktop UI. Desktop-only: `main.tsx`,
  `boot/DesktopBoot.tsx`, `boot/StartupScreen.tsx`.
- **Mobile and web are one frontend.** `mobile/` builds both, the web one with `--mode web`. Web's
  own code is in four places: `crates/grimoire-web`, `crates/grimoire-scan`, `src/lib/core/web/`
  (41 files) and `app-worker/`.
- **`share/` is a fourth frontend**: the public viewer page, built into `dist-share/` and served by
  the share Worker.
- **The three Workers import no npm package at runtime.** Their cross-links: `share-worker` imports
  `relay/src/token.ts` and `relay/src/fakeD1.ts`; `app-worker` imports `isNavigation` from
  `src/lib/core/web/assets`; `vite.mobile.config.ts` imports `app-worker/src/headers.ts`.
- **`.storybook/fake/` is imported by 110 files outside `.storybook/`**: 81 in `src/`, 21 in
  `mobile/`, 5 in `scripts/`, 2 in `.design-sync/` and `vite.mobile.config.ts`. It imports one type
  back from the light app (`WallItem`, for a fixture builder that two `mobile/` files use).
- **`@/` appears 3,775 times in 927 files under `src/`**, 564 times in `mobile/`, 38 in `share/`
  and 68 in `.storybook/`.
- **The root holds 31 tracked files**, among them seven tsconfigs and five Vite files.
- **Tailwind scans only what a stylesheet names.** `src/index.css` opens with
  `@import "tailwindcss" source(none)` and lists its sources; `mobile.css`, `share.css` and
  `.storybook/preview.css` import it and add their own.
- **Cargo builds into `src-tauri/target`**, pinned by `.cargo/config.toml` so that the 2026-10-02
  workspace conversion moved nothing. Each checkout's dev database is at
  `src-tauri/target/debug/data`.
- **The deploy tool is isolated on purpose.** `app-worker/package.json` names `wrangler` and
  nothing else, has its own `package-lock.json`, and `scripts/release-rule.test.mjs` pins the two
  lines the secret-holding `web-deploy` job runs: `npm ci --ignore-scripts` and
  `npx --no-install wrangler deploy`.
- **The committed Android project runs `npm`.** `mobile/src-tauri/gen/android/…/BuildTask.kt` is
  hand-edited to run `npm run -- tauri:light android android-studio-script`, and
  `mobile/host.test.ts` holds it.
- **Twenty-two dependencies are declared in more than one workspace crate**, and every pair agrees.
- **Every test runs under `jsdom`** with one setup file; no file sets its own environment.
- pnpm 11.5.0 and Node 24.16.0 are on the owner's machine. `node_modules` is 384 MB, and 15
  worktrees have one each.

## 4. The layout

```
apps/
  desktop/          @grimoire/desktop
    index.html  vite.config.ts  public/
    src/            main.tsx, DesktopBoot, StartupScreen, desktop.css
    src-tauri/      the desktop host
  light/            @grimoire/light
    index.html  vite.config.ts  vite.sw.ts  public/
    phone/  LightApp.tsx  …
    src-tauri/      the Android host
  share/            @grimoire/share
packages/
  ui/               @grimoire/ui
    components/  features/  lib/  boot/  App.tsx  index.css  components.json
  fake/             @grimoire/fake
crates/             unchanged
infrastructure/
  relay/  share-worker/  app-worker/
  wrangler/         the deploy tool (stage 2)
.storybook/         configuration only
docs/  scripts/  logos/
```

| From | To | Tracked files |
| --- | --- | --- |
| `src-tauri/` | `apps/desktop/src-tauri/` | 124 |
| `index.html`, `public/`, `vite.config.ts`, `tsconfig.node.json` | `apps/desktop/` | 4 |
| `src/main.tsx`, `src/boot/DesktopBoot.*`, `src/boot/StartupScreen.*` | `apps/desktop/src/` | 6 |
| `mobile/` | `apps/light/` | 176 |
| `vite.mobile.config.ts`, `vite.sw.ts` | `apps/light/vite.config.ts`, `apps/light/vite.sw.ts` | 2 |
| `share/` | `apps/share/` | 8 |
| `vite.share.config.ts` | `apps/share/vite.config.ts` | 1 |
| the rest of `src/` | `packages/ui/`, with no `src/` level | 1,342 |
| `components.json`, `tsconfig.web-worker.json`, `tsconfig.web-sw.json` | `packages/ui/` | 3 |
| `.storybook/fake/` | `packages/fake/` | 21 |
| `relay/`, `tsconfig.relay.json` | `infrastructure/relay/`, its `tsconfig.json` | 44 |
| `share-worker/`, `tsconfig.share-worker.json` | `infrastructure/share-worker/`, its `tsconfig.json` | 13 |
| `app-worker/`, `tsconfig.app-worker.json` | `infrastructure/app-worker/`, its `tsconfig.json` | 13 |

**Unchanged:** `crates/`, `docs/`, `scripts/`, `logos/`, `.github/`, `.claude/`, `.design-sync/`,
and what is left of `.storybook/`.

**Build outputs.** `dist/` becomes `apps/desktop/dist/`; `dist-mobile/` and `dist-web/` go under
`apps/light/`; `dist-share/` under `apps/share/`. `dist-wasm/` stays at the root: cargo makes it
and the light app's build reads it, as `target/` is cargo's. `storybook-static/` stays at the root.

**Why the shared UI has no `src/` level.** A cross-package import is resolved through
`node_modules`, and TypeScript adds no file extension when it resolves through a package `exports`
map. Without a map and without `src/`, `@grimoire/ui/features/decks/DeckView` resolves by plain
path lookup in `tsc`, Vite and wrangler's esbuild alike. With `src/`, that segment would be in
every one of about 670 import specifiers.

**The root afterwards** holds 22 tracked files: `.gitattributes`, `.gitignore`, `.mcp.json`,
`.nvmrc`, `.prettierrc`, `.release-please-manifest.json`, `CHANGELOG.md`, `CLAUDE.md`,
`Cargo.lock`, `Cargo.toml`, `LICENSE`, `README.md`, `eslint.config.js`, `package.json`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `release-please-config.json`, `rust-toolchain.toml`,
`tsconfig.base.json`, `vite.base.ts`, `vite.watch.ts`, `vitest.config.ts`.

## 5. Stage 1 — the moves

One commit, `chore:`. Still npm, still one `package.json`, and `@/` is still one alias for every
program — now pointing at `packages/ui`. Imports that cross a folder by relative path keep doing so,
with the new path.

Besides the `git mv`s in §4:

**Cargo.**
- `members` names `apps/desktop/src-tauri` and `apps/light/src-tauri`; the two hosts' path
  dependencies on `crates/` gain a level.
- A `[workspace.package]` table carries `version`, `edition` and `license`; the five members
  inherit them. `crates/card-scanner` stays excluded and keeps its own.
- `.cargo/config.toml` pins the build tree to `<root>/target`. Everything that names
  `src-tauri/target` is rewritten: `.gitignore`, `vite.watch.ts`, `eslint.config.js`, the scripts,
  the workflows (`Swatinem/rust-cache`'s `workspaces` mapping among them), the skills and the
  living docs.
  **Amended during execution (2026-10-08).** The design had the file deleted, `<root>/target`
  being cargo's default. Measured in the first worktree on the new layout: cargo finds its config
  by walking up from the working directory, a worktree sits under the main checkout, and with no
  file of its own it read the main checkout's — `cargo metadata` answered
  `D:\Code\mtg-grimoire\src-tauri/target`. Its builds, and its app's `data/`, would have gone into
  the main checkout's tree: the owner's dev database. That holds whenever the main checkout is on
  a commit that still has the old pin. A file here that says `target` is nearer and wins.
- `release-please-config.json` bumps `$.workspace.package.version` in the root manifest in place of
  the five member manifests. Its `Cargo.lock` rows and the two `tauri.conf.json` rows stay,
  re-pathed.

**Vite, Tailwind and TypeScript.**
- Each app's Vite config sits in the app and sets its own `root`, so no command depends on the
  directory it is run from. What the three configs share today by importing the desktop's —
  plugins, the alias, the watch list — moves to a root `vite.base.ts`.
- The test settings leave `vite.config.ts` for a root `vitest.config.ts`. Its eight globs are
  re-pathed, and `apps/desktop/src` and `packages/fake` are added so the tests that moved there
  stay collected.
- `packages/ui/index.css` names its own folders as sources. The desktop gets
  `apps/desktop/src/desktop.css` on the pattern of `mobile.css` and `share.css`: it imports the
  shared stylesheet and adds `index.html` and its own `src/`.
- The root `tsconfig.json` stays one webview program until stage 2, with its `include` and `paths`
  re-pathed. `.storybook/tsconfig.json` goes on checking the fake at its new place.

**Tauri.** The two `tauri.conf.json`s and `tauri.light.conf.json` are re-pathed. The root `tauri`
script runs the CLI from `apps/desktop`, as `tauri:light` already does from the light app. The
committed Android project's `BuildTask.kt` is corrected for the new depth, and `host.test.ts` with
it.

**Everything that names a path.**
- `package.json` scripts keep their names and take new paths.
- `scripts/ci-route.mjs` gets new arms in the same order of precedence, and
  `scripts/ci-route.test.mjs`'s census is re-derived. The four workflows are re-pathed.
- A script that something still calls — an npm script, a workflow, a test — is updated. The
  one-shot `scripts/core-step-*.mjs` migration scripts that nothing calls are left as written.
- `eslint.config.js`, `.storybook/main.ts`, `.design-sync/`, `.gitignore`, `.vscode/`, `.mcp.json`.

**Docs.** Living docs are updated: every `CLAUDE.md` (each moves with its area, and the root's
index and table are rewritten), `docs/agent/`, `docs/reference/`, `docs/play/`, `docs/scanner/`,
the READMEs and `.claude/skills/`. `docs/superpowers/` (216 dated plans, specs, notes and research)
and `CHANGELOG.md` are left as written. A new `docs/reference/repository-layout.md` holds the
layout, what each top-level folder is for, and the old-to-new table from §4.

## 6. Stage 2 — the workspace

One commit, `chore:`. No file moves except the deploy tool's manifest.

**Packages.** All private, all at `0.0.0` except the root; release-please goes on bumping the root
`package.json` alone.

| Package | Folder | Depends on, in the workspace |
| --- | --- | --- |
| `mtg-grimoire` | the root | — (ESLint, Prettier, Storybook, Vitest, TypeScript, what `scripts/` and `.design-sync/` import) |
| `@grimoire/ui` | `packages/ui` | `@grimoire/fake`, for its tests only |
| `@grimoire/fake` | `packages/fake` | `@grimoire/ui` |
| `@grimoire/desktop` | `apps/desktop` | `@grimoire/ui` |
| `@grimoire/light` | `apps/light` | `@grimoire/ui`, `@grimoire/fake`, `@grimoire/app-worker` |
| `@grimoire/share` | `apps/share` | `@grimoire/ui` |
| `@grimoire/relay` | `infrastructure/relay` | — |
| `@grimoire/share-worker` | `infrastructure/share-worker` | `@grimoire/relay` |
| `@grimoire/app-worker` | `infrastructure/app-worker` | `@grimoire/ui` |

`@grimoire/ui` and `@grimoire/fake` depend on each other: the fake is typed against the UI's IPC
mirror, and the UI's tests run against the fake. pnpm allows it, and it is a development-time cycle
on the UI's side. So that the fake depends on no app, its `wallItem` fixture builder moves into
`apps/light` beside the type it builds.

**The import rules**, which `eslint.config.js` enforces by folder:
1. A module in another package is imported by the package's name.
2. Inside `packages/ui`, `@/` means the package root. Nowhere else may use `@/`.
3. A test that reads a file's text with `?raw` names it by relative path. That reads the
   repository; it imports no module.
4. A configuration file may import `vite.base.ts` and `vite.watch.ts` by relative path.

Rule 2 leaves the 3,775 specifiers under `packages/ui` alone. Rule 1 rewrites 564 in the light app,
38 in share and 68 in the fake, and the roughly 110 files that reach the fake by relative path.

**No build step and no `exports` maps.** A consumer compiles the source of the package it imports.
`@/` is supplied in two places only: `paths` in `tsconfig.base.json`, and one alias in
`vite.base.ts` that every Vite-based program uses (three apps, Vitest, Storybook).

**One React.** Versions shared by more than one package are declared once in the pnpm catalog, and
`vite.base.ts` dedupes `react`, `react-dom` and `@tanstack/react-query`.

**TypeScript.** Each package has a `tsconfig.json` extending `tsconfig.base.json`; the root
`tsconfig.json` and its one webview program go. An app's program re-checks the UI modules it
reaches. That cost is accepted, and the plan records `tsc`'s wall time before and after.

**Vitest.** The root `vitest.config.ts` lists one project per package, plus one for `scripts/` and
`.storybook/`. `pnpm test:run` from the root runs all of them and `--shard` keeps working. Every
project keeps `jsdom` and the one setup file, as now.

**Storybook** stays at the root as configuration, globbing stories from `packages/ui`, `apps/light`
and `apps/desktop`.

**The deploy tool.** `infrastructure/app-worker/package.json` becomes the Worker's workspace
manifest, so the `wrangler`-only manifest and its `package-lock.json` move to
`infrastructure/wrangler/`, which `pnpm-workspace.yaml` does not list. `web-deploy` still runs
`npm ci --ignore-scripts` against that lockfile and then that install's `wrangler` from
`infrastructure/app-worker`, and installs no pnpm. `ci.yml`'s `web` job installs the same way for
the sync smoke. `scripts/release-rule.test.mjs` pins the new lines: still one deploy line, still a
manifest naming `wrangler` alone.

**pnpm everywhere else.** `packageManager` pins the version; `package-lock.json` gives way to
`pnpm-lock.yaml`. The workflows install with `pnpm install --frozen-lockfile` through a SHA-pinned
`pnpm/action-setup`, and `npm run <name>` becomes `pnpm <name>` with every root script name kept.
`beforeDevCommand` and `beforeBuildCommand` in the Tauri configs, the Android project's
`BuildTask.kt`, the `worktree-setup` skill and every command a living doc or an error message tells
someone to run follow. `scripts/workflow-scripts.test.mjs`, `scripts/toolchain.test.mjs` and
`scripts/actions-pinned.test.mjs` are taught the new spellings.

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

Found while the plan ran:

- `pnpm-workspace.yaml` sets `optimisticRepeatInstall: false`. pnpm 11 otherwise answers
  `pnpm install` with "Already up to date" from the manifests' modification times alone, and a
  lockfile changed by itself was not installed.
- The session hook deletes a `node_modules` npm made before it installs. `pnpm install` over one
  exits 0 and leaves npm's hoisted packages in place, with pnpm's strictness silently off.
- `scripts/workflow-scripts.test.mjs` refuses a pnpm call it cannot read (`pnpm --filter x run
  y`), a `--` anywhere on a pnpm line, and any npm, npx, pnpx or corepack line but the deploy
  tool's install; `scripts/toolchain.test.mjs` holds pnpm's setup step directly above Node's.
- The hosting Worker's test reads its `src/` at every depth, so a package-name import in a
  subfolder needs an alias too.

And one rule the design did not state, held by `scripts/workspace.test.mjs`: a package declares
what its files import. pnpm's layout does not enforce it — Node finds a package the root declares
from any folder beneath it.

## 7. Verification

Each stage is checked against a baseline taken on the commit before it. "Each build" below means
five: the desktop's, the light app's for Android and for the web, the share page's, and Storybook's.

| Check | Catches |
| --- | --- |
| Vitest collects the same number of files and of tests | a folder no glob names, which is collected by nothing and reads as a pass |
| `cargo test --workspace` and `card-scanner`'s suite run the same number of tests per crate | a member that fell out of the workspace |
| Each build's CSS holds the same set of rules, or every difference is traced to a named file | Tailwind no longer scanning a folder |
| Each build's JavaScript has the same number of entries and is within 1% in total bytes | a module bundled twice, or a second React |
| The engine's and the scanner's WASM modules are byte-identical, or the difference is explained | a profile or feature that changed with the manifests |
| `verify` is green | everything it already holds |
| The fence tests still fail when their property is broken: `release-rule`'s deploy pin and `ci-route`'s census are each broken once, seen red, and restored | a fence loosened to make it pass |
| CI is green on the pull request, which routes every job | the Android build, the web job, Linux |

Then live, on the owner's machine: `tauri dev` opens the desktop app on the real dev database with
the collection it had; the light app runs in fake mode and in its phone-sized Tauri window;
`web:build` and `web:smoke` pass; Storybook builds.

**Checked first, before anything is moved**, because the layout leans on them: the Tauri CLI finds
the desktop project when run from `apps/desktop`; `tauri build` accepts a manifest whose version is
inherited from the workspace; a WASM build from an untouched tree is reproducible byte for byte.

## 8. What the owner does

- **Once per checkout worth keeping, with the app closed**: after taking stage 1, move the *data*
  folder, `src-tauri/target/debug/data`, to `target/debug/data`, and delete what is left of
  `src-tauri/target`. The next build compiles from nothing.
  **Amended during execution (2026-10-08).** The design had the whole build tree moved, compiled
  dependencies and all. Measured in the first worktree to do it: Tauri's build scripts record
  absolute paths to their generated permission files, cargo sees no reason to rerun them, and the
  next `cargo test` stopped on `failed to read plugin permissions … src-tauri\target\debug\build\…`.
  A cargo build tree does not survive being moved; the dev database does.
- **Then clear what the old layout leaves behind**, none of which git tracks any more: the rest of
  `src-tauri/` (the old build tree and `gen/schemas`), `mobile/` (its host's `gen/schemas`), and
  the root's `dist/`, `dist-web/`, `dist-mobile/` and `dist-share/`. The card scanner's three files
  are among them: move `src-tauri/scanner-assets/` to `apps/desktop/src-tauri/scanner-assets/`, or
  run `npm run scanner:assets` again, or the next debug build embeds no scanner. `.gitignore` and
  ESLint go on ignoring these folders, in a dated block, until they are gone — found by the final
  review, which noticed that a checkout pulling this would otherwise lint built bundles.
- **After stage 2**: delete `node_modules` and run `pnpm install` — and `infrastructure/app-worker/node_modules`, which held the deploy tool; it installs into `infrastructure/wrangler` now.
- **Old worktrees** are deleted or re-created; none is merged forward.
- **Nothing here deploys.** The first release after stage 1 deploys the web app through the
  re-pathed `web-deploy`, as any release does.

## 9. Not in this design

- Moving the web host's glue out of the shared UI into a folder of its own.
- Splitting the shared UI into smaller packages.
- `[workspace.dependencies]`.
- Built internal packages, `exports` maps or TypeScript project references.
- Renaming the npm scripts (`mobile:*`, `web:*`), the build outputs or any crate.
- A `node` test environment for the Workers.
- Rewriting dated plans, specs or the changelog.
- Dependabot for npm or cargo; a task runner or build cache.

## 10. Risks the owner is accepting

- **`release.yml` cannot run before it matters.** It triggers on a release only, so the next
  release is the first real run of the re-pathed desktop artifacts, the Android signing and the web
  deploy. The fence test and a line-by-line read are what stand in for a run.
- **Every branch older than stage 1 is stranded.** Its paths are gone, and cargo in a nested
  worktree walks up to the main checkout's manifest and refuses.
- **`main` is in the new layout on npm between the two pull requests.**
- **pnpm's strict `node_modules` may refuse an import that npm's hoisting allowed.** Each is fixed
  by declaring the dependency where it is used.
- **Type-checking takes longer**, since each app's program checks the shared UI again.
