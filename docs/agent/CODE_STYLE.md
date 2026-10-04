# Code style and conventions

The code styles, formatting rules, linters, and architectural conventions enforced across the
mtg-grimoire repository.

## Formatting & Linters

### TypeScript / Frontend
- **Prettier** (`.prettierrc`):
  - Semicolons: `true` (`"semi": true`)
  - Quotes: Double quotes (`"singleQuote": false`)
  - Trailing commas: `all` (`"trailingComma": "all"`)
  - Print width: `100` (`"printWidth": 100`)
- **ESLint** (`eslint.config.js`):
  - `@eslint/js` recommended, `typescript-eslint` recommended
  - `eslint-plugin-react-hooks` (`recommended-latest`) — stale dependency arrays are caught here
  - `eslint-plugin-storybook` (`flat/recommended`)
  - `"react-hooks/incompatible-library": "off"` (no React compiler in the pipeline)
  - Zero warnings allowed in CI (`eslint . --max-warnings 0`)
- **TypeScript** (`tsconfig.json`):
  - `strict: true`
  - `noUnusedLocals: true`, `noUnusedParameters: true`, `noFallthroughCasesInSwitch: true`
  - Path alias: `@/*` maps to `./src/*`
  - **No `@types/node` in webview packages**: `"types": []`. The browser/webview environment has no
    ambient `process` or `Buffer`, and `setTimeout` returns `number` (not `NodeJS.Timeout`).
  - Error chaining: `lib` includes `ES2022.Error` to allow `throw new Error(msg, { cause })`.

### Rust
- **Formatter**: `cargo fmt --check` (default rustfmt rules).
- **Clippy**: `cargo clippy --workspace --all-targets --locked -- -D warnings` (all warnings are
  treated as errors).
- **Toolchain**: Pinned in `rust-toolchain.toml`.

### Verification command
- Run `npm run verify` at the end of a feature before committing (not after each intermediate change, to minimize re-fixing). It executes:
  1. Frontend build (`npm run build`)
  2. Mobile Vite build (`vite build --config vite.mobile.config.ts`)
  3. Frontend lint (`npm run lint`)
  4. Rust lint (`npm run lint:rust`: fmt check + clippy -D warnings + cargo check)
  5. Vitest suite (`npm run test:run`)
  6. Rust workspace tests (`cargo test --workspace`)
  7. Card scanner crate tests

## Naming & File Layout

### TypeScript / React
- **Components**: `PascalCase.tsx` (e.g. `CardImage.tsx`, `NoteEditor.tsx`).
- **Hooks**: `useCamelCase.ts` (e.g. `useCardSelection.ts`, `useImageRetry.ts`).
- **Utilities & Domain modules**: `camelCase.ts` (e.g. `marketplace.ts`, `folderOrder.ts`).
- **Feature folders**: Grouped in `src/features/<feature>/` (e.g. `decks`, `transfer`, `collection`).
- **Tests**: Colocated alongside the source file: `<name>.test.ts` or `<name>.test.tsx`.
- **Imports**: Prefer `@/*` aliases over deep relative paths (`../../..`).

### Rust
- **Crates**:
  - `crates/grimoire-core`: Headless domain logic, SQLite storage, migrations, Scryfall client,
    search. Independent of Tauri/GUI windows. Compiles to native and WASM.
  - `src-tauri`: Desktop application host, Tauri window lifecycle, updater, and `#[tauri::command]`
    IPC handlers.
  - `crates/grimoire-web`: Web WASM target host.
  - `mobile/src-tauri`: Android light app host.
  - `crates/card-scanner`: OCR and optical card detection.
- **Module files**: Standard Rust `snake_case.rs` and `module/mod.rs` conventions.
- **Tests**: Colocated `#[cfg(test)] mod tests { ... }` modules inside the source files.

## Rust <-> TypeScript IPC Boundary

- **Rust supplies facts, TypeScript draws conclusions**: Rust owns data plumbing (SQLite, FTS5,
  ingest, image cache); TS owns domain validation (deck formats, import/export parsing).
- **IPC Types**: Rust structs exposed to the frontend use `#[serde(rename_all = "camelCase")]`.
- **Type Mirroring**: `src/lib/ipc.ts` is the hand-written TypeScript mirror of Rust IPC structs and
  command signatures.
- **IPC Drift Fence**: `src/lib/ipc.test.ts` validates TypeScript interfaces and command names
  against the Rust source text to ensure types stay synchronized.

## React & UI Guidelines

- **Design System & Tailwind**: Built on Tailwind CSS and Radix/shadcn components (`components.json`),
  styled using `cn(...)` (`clsx` + `tailwind-merge`).
- **Storybook**: Stories live in `.storybook/` and feature folders. Use the Storybook MCP tools
  (`mtg-grimoire-sb-mcp`) to inspect existing components and properties before writing new UI.
- **No Hallucinated Props**: Never assume props on design system components; inspect documentation or
  stories first.
- **Card Images**: Always use `components/CardImage`, never raw `<img>` tags (handles decoding,
  drag-and-drop suppression, intersection observation, and stall watchdog).

## Documentation & Comments Style

- **Explain the "Why" and the Traps**: Comments in this codebase are descriptive and contextual.
  Do not merely state what the code does; explain the non-obvious failure modes, race conditions,
  measurements, dates, or browser/SQLite quirks that forced a specific implementation.
- **Preserve Existing Documentation**: Do not remove comments, dates, or measurements when editing
  surrounding code.

## Commit Messages

Follow Conventional Commits: `<type>(<scope>): <description>`:
- Types: `feat:`, `fix:`, `chore:`, `test:`, `docs:`
- Scope is optional but encouraged for features/areas (e.g. `feat(decks):`, `fix(sync):`).
- **One commit per feature (match feature size)**: Commits must match the full size of a feature,
  bundling the implementation, tests, and documentation together. Never split a feature across
  multiple commits (e.g. one for code and another for docs or follow-up fixes). Multiple commits
  per feature mess up our `release-please` changelog by generating duplicate or fragmented entries.
