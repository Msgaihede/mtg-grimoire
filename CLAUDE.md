# MTG Grimoire

Portable Windows desktop app for tracking a Magic: The Gathering collection.
Built with Tauri 2.11 (Rust core) + React 19 + TypeScript 6. Single local user, SQLite storage.
Also supports a light app (Android via Tauri, distributed through Google Play, and Web via WebAssembly in a Cloudflare Worker).

## Index

### Agent Instructions (`docs/agent/`)

- [`docs/agent/CODE_STYLE.md`](docs/agent/CODE_STYLE.md) — Formatting rules (Prettier), linters (ESLint, Clippy), naming conventions, UI patterns, and commit guidelines.
- [`docs/agent/ARCHITECTURE.md`](docs/agent/ARCHITECTURE.md) — Core architectural boundaries, crate structure, IPC data flow, and golden corpus tests.
- [`docs/agent/DOMAIN_VOCABULARY.md`](docs/agent/DOMAIN_VOCABULARY.md) — Critical domain taxonomy: tags vs labels vs keywords vs notes, and how to avoid confusing them.
- [`docs/agent/EXTERNAL_SERVICES.md`](docs/agent/EXTERNAL_SERVICES.md) — Scryfall, price feeds, Spellbook combos, sync relay, Workers, secrets policy, and deploy rules.
- [`docs/agent/RUNNING_AND_VERIFYING.md`](docs/agent/RUNNING_AND_VERIFYING.md) — Full command catalog, database paths, single-instance traps, and CDP UI verification.
- [`docs/agent/WORKFLOW.md`](docs/agent/WORKFLOW.md) — Subagent fan-out, git worktrees, project skills, and documentation maintenance.

### Sections in this Document

- [Primary Commands](#primary-commands) — Key commands needed across everyday tasks.
- [Architecture & Responsibilities](#architecture--responsibilities) — The fundamental Rust vs TypeScript separation.
- [Area-Specific Guides](#area-specific-guides) — Directory-level `CLAUDE.md` files governing specific parts of the codebase.
- [Project Skills & Workflows](#project-skills--workflows) — Worktree workflows and app locks.
- [Global Rules](#global-rules) — Invariants binding every agent and every commit.
- [Working Style](#working-style) — Subagents, testing, and user interaction standards.

### Reference Docs

- [`docs/reference/README.md`](docs/reference/README.md) — Index of all 36 reference deep-dives, live measurements, and design rationale documents.
- [`docs/reference/repository-layout.md`](docs/reference/repository-layout.md) — The four code folders (`apps/`, `packages/`, `crates/`, `infrastructure/`), build outputs, and where every path was before 2026-10-08.

---

## Primary Commands

- `pnpm verify` — Build + lint + `cargo fmt --check` + Clippy + Vitest + cargo test. **Run at the end of a feature before committing (not after every change).**
- `pnpm tauri dev` — Run the desktop app (Vite HMR + Rust rebuild). Takes the `app` lock (see `running-the-app` skill).
- `pnpm test` / `test:run` — Run frontend tests via Vitest.
- `cargo test --workspace` — Run Rust tests across all crates (`apps/desktop/src-tauri`, `crates/grimoire-core`, `apps/light/src-tauri`, `crates/grimoire-web`, `crates/grimoire-scan`).
- `pnpm storybook` / `build-storybook` — Component development workbench (`.storybook/`).
- `pnpm mobile:dev` / `mobile:tauri` — Run the light app in a browser fake or in a phone-sized Tauri window.
- `pnpm web:wasm` / `web:build` / `web:preview` — Build and preview the WASM web target.

_For complete command options, coverage caveats, and environment flags, see [`docs/agent/RUNNING_AND_VERIFYING.md`](docs/agent/RUNNING_AND_VERIFYING.md)._

---

## Architecture & Responsibilities

- **Rust supplies facts, TypeScript draws conclusions**:
  - Rust owns data plumbing (SQLite/FTS5, Scryfall bulk ingestion, image caching).
  - TypeScript owns domain logic (deck validation, import/export parsing).
  - Keep this boundary clean: do not leak UI assumptions into Rust or storage plumbing into TypeScript.
- **Crate Boundary (window awareness)**:
  - `crates/grimoire-core` is the engine with no window dependency. It contains schemas, database migrations, decks, collection, wishlist, search, and Scryfall clients. Compiles to native and WASM.
  - `apps/desktop/src-tauri` is the desktop application: windows, menus, native updater, IPC commands (`#[tauri::command]`), and filesystem mirror.
- **IPC Type Mirroring**:
  - `packages/ui/lib/ipc.ts` is the hand-written TypeScript mirror of Rust structs.
  - `packages/ui/lib/ipc.test.ts` asserts byte/field parity against the Rust source text to prevent schema drift.

_For full architecture details and golden export fences, see [`docs/agent/ARCHITECTURE.md`](docs/agent/ARCHITECTURE.md)._

---

## Area-Specific Guides

This file contains only global instructions. **The binding rules for any specific area live in that area's own `CLAUDE.md`**, which should be read before modifying code there:

| Area / File                                                                          | Governs                                                                                                     |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| [`apps/desktop/src-tauri/CLAUDE.md`](apps/desktop/src-tauri/CLAUDE.md)               | Desktop Rust host, window management, updater, desktop migrations, and `#[tauri::command]` IPC handlers     |
| [`crates/grimoire-core/CLAUDE.md`](crates/grimoire-core/CLAUDE.md)                   | Shared headless engine (schema, decks, collection, wishlist, search, Scryfall client, platform abstraction) |
| [`crates/grimoire-web/CLAUDE.md`](crates/grimoire-web/CLAUDE.md)                     | Web host — engine compiled to WASM module for browser execution                                             |
| [`crates/grimoire-scan/CLAUDE.md`](crates/grimoire-scan/CLAUDE.md)                   | Web host's scanner — `card-scanner` as a WASM module of its own, for a Worker of its own                    |
| [`apps/light/CLAUDE.md`](apps/light/CLAUDE.md)                                       | Light app — Android and web UI faces and responsive boundary                                                |
| [`packages/ui/CLAUDE.md`](packages/ui/CLAUDE.md)                                     | React frontend, design tokens, `CardImage` rules, Storybook MCP usage                                       |
| [`packages/ui/features/decks/CLAUDE.md`](packages/ui/features/decks/CLAUDE.md)       | Deck validation, categories, deck editor views, and drag-and-drop interactions                              |
| [`packages/ui/features/transfer/CLAUDE.md`](packages/ui/features/transfer/CLAUDE.md) | Decklist import and export parsing, planning, and dialogs                                                   |
| [`.storybook/CLAUDE.md`](.storybook/CLAUDE.md)                                       | Storybook workbench, mock database (`packages/fake/db.ts`), seed fixtures, and fault simulation             |
| [`.github/CLAUDE.md`](.github/CLAUDE.md)                                             | CI workflows, path routers, and release-please configuration                                                |
| [`infrastructure/app-worker/README.md`](infrastructure/app-worker/README.md)         | Web app Cloudflare Worker hosting, headers, and deploy runbook                                              |

---

## Project Skills & Workflows

Worktree and deployment workflows are managed by skills in `.claude/skills/`:

- **`worktree-setup`** — Rules for secondary checkouts, base branches, and shared stashes.
- **`running-the-app`** — Lock management (`.git/locks/app` and `storybook`). Only one app and one Storybook instance may run across all worktrees.

---

## Global Rules

- **Pre-commit verification**: Run `pnpm verify` only at the end of a feature before committing, not after each individual change. Avoid running test suites on intermediate edits to minimize churn and repetitive re-fixing.
- **Commit style (one commit per feature)**: Commits must match the full size of a feature (code, tests, and docs together). Do not split a single feature across multiple commits; multi-commit features fragment and mess up the release-please changelog. Use Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- **No `@types/node` in webview code**: The frontend is a webview environment; `@types/node` is forbidden to prevent leaking Node types into browser code.
- **Narrowest permissions**: When declaring Tauri plugin permissions, always request the narrowest required capability, never `:default`.
- **`data/` is strictly local**: Never commit SQLite databases or test artifacts in `data/`. When seeding fixtures in tests, seed only user tables, never `cards` or `sync_meta`.
- **Worker secrets are never committed**: Secrets (`PATREON_CLIENT_SECRET`, `PATREON_WEBHOOK_SECRET`, `RELAY_HMAC_KEY`) belong solely in Cloudflare Secret storage, never in repository files or `.dev.vars`.
- **Deployments require explicit instruction**: No agent may deploy a Worker without explicit instruction from the user, and exactly one CI job deploys one: `release.yml`'s `web-deploy` puts the web app (`infrastructure/app-worker/`) on its origin at a release tag (the owner's decision, 2026-10-04 — the three hosts ship from one tag). So **merging the release PR is a deploy of the web app**, and an agent merges it only when asked to. The relay and the share Worker are deployed by no job; nothing else deploys without his ask.
- **Domain vocabulary precision**: Strictly distinguish between Scryfall tags, user deck labels, card keyword abilities, and note types. Refer to [`docs/agent/DOMAIN_VOCABULARY.md`](docs/agent/DOMAIN_VOCABULARY.md).
- **Imports cross a package by its name**: `@grimoire/ui/…`, `@grimoire/fake/…`. `@/` is the shared UI's own alias and is written only inside `packages/ui`. A package declares what its files import, in its own `package.json`. `scripts/workspace.test.mjs` holds all three; see [`docs/reference/repository-layout.md`](docs/reference/repository-layout.md).
- **Live UI verification**: Drive real WebView2 windows over CDP (`scripts/cdp.mjs`) when verifying UI changes; tests alone cannot detect webview-specific rendering glitches.

---

## Working Style

- **Fan out parallel subagents**: Split large features along architectural seams (Rust commands, TS domain logic, UI, stories, docs) and dispatch independent pieces in parallel.
- **Prevent file collisions**: Give each subagent distinct files, or assign separate git worktrees (`.claude/skills/worktree-setup`).
- **Test only at the end of a feature (fan-in)**: Do NOT run tests after each intermediate change or edit. Subagents report what they changed; run `pnpm verify` once centrally at the end of the entire feature to verify it works as a whole, minimizing unnecessary re-fixing.
- **User questions**: Use the `AskUserQuestion` tool for clarification or design choices, presenting structured options with evidence and recommended defaults.
