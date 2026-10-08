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
