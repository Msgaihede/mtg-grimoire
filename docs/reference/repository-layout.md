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

`.cargo/config.toml` still pins `target-dir = "target"`, though cargo's default for a workspace
is the same, because an agent worktree nested under the main checkout would otherwise read the
main checkout's config and build into the main checkout's tree. That file carries the argument
and the measurement.

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

**Three things pnpm does that npm did not.** (a) It installs before it runs: with a manifest
edited, `pnpm exec <anything>` and `pnpm <script>` first rewrite `pnpm-lock.yaml` to match and
relink `node_modules`, so a manifest edit that is not meant to stay is put back before any
`pnpm` command. (b) `pnpm install` is told always to read the lockfile
(`optimisticRepeatInstall: false` in `pnpm-workspace.yaml`): pnpm 11's default answers "Already
up to date" from the manifests' modification times alone, and a lockfile changed by itself was
not installed. (c) It does not replace a tree npm made: `pnpm install` over an npm-installed
`node_modules` exits 0 and leaves npm's hoisted packages in place, so delete `node_modules`
first. The measurements are in
[`docs/agent/RUNNING_AND_VERIFYING.md`](../agent/RUNNING_AND_VERIFYING.md).

**Dated measurements in the reference docs name commands as they are spelled now.** A run dated
before 2026-10-08 was made with `npm run <name>`, `npm ci` and `npx <tool>`, and installed the
deploy tool from `infrastructure/app-worker`; the command beside it is the one that does the
same thing today.

**`infrastructure/wrangler` is not in the workspace.** It is the tool that deploys the web app:
one dependency, a lockfile of its own, installed with `npm ci --ignore-scripts`. The release's
deploy job installs it and nothing else.

**TypeScript** has one program per package (`tsc -p <folder>`), all extending `tsconfig.base.json`
except the three Workers'. **Vitest** has one project per package, rooted at the repository:
`pnpm exec vitest run --project light`.

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
| `index.html`, `public/`, `vite.config.ts`, `tsconfig.node.json` | `apps/desktop/` |
| `vite.mobile.config.ts`, `vite.sw.ts` | `apps/light/vite.config.ts`, `apps/light/vite.sw.ts` |
| `vite.share.config.ts` | `apps/share/vite.config.ts` |
| the `test` block of `vite.config.ts` | `vitest.config.ts` |
| `tsconfig.relay.json`, `tsconfig.share-worker.json`, `tsconfig.app-worker.json` | `infrastructure/<name>/tsconfig.json` |
| `tsconfig.web-worker.json`, `tsconfig.web-sw.json`, `components.json` | `packages/ui/` |
| `dist/`, `dist-mobile/`, `dist-web/`, `dist-share/` | under the app that builds each |
| `tsconfig.json` | `tsconfig.base.json`, and a `tsconfig.json` per package |
| `app-worker/package.json`, `package-lock.json` (the deploy tool) | `infrastructure/wrangler/` |
