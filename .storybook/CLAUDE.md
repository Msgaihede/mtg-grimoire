# .storybook — the workbench and its fake

Storybook serves as a component design workbench, living UI catalogue, and accessibility test
surface (`@storybook/addon-a11y`). It does not run visual regression screenshots.
Commands: `npm run storybook` (workbench dev) · `npm run build-storybook` (static build).
Full reference, measurements, and design history: [`docs/reference/storybook.md`](../docs/reference/storybook.md).

## MCP Integration (`mtg-grimoire-sb-mcp`)

- **Inspect before building**: Always use the Storybook MCP tools to check existing components and properties before writing new UI:
  - `list-all-documentation`: Lists all available components.
  - `get-documentation`: Fetches documented props and example stories for a component.
  - `get-storybook-story-instructions`: Fetches current story authoring conventions.
  - `run-story-tests`: Validates stories using test runners.
- **Never hallucinate properties**: Only use props documented in Storybook stories or component definitions. If a prop is unlisted, consult the user.

## Rules for the Backend Fake

- **Command parity is strictly enforced**:
  - `fake/parity.test.ts` verifies that every command registered by `generate_handler!` in `src-tauri/src/desktop.rs` has a matching handler in `allHandlers`.
  - Commands deliberately omitted must be registered in the `ABSENT` map with documented rationale.
  - The parity test compares command names only; argument and payload types are asserted by `ipc.test.ts`.
- **The fake sits under `src/lib/ipc.ts`, not in place of it**:
  - `fake/aliases.ts` aliases four modules (`@tauri-apps/api/core`, `@tauri-apps/api/event`, `@tauri-apps/api/window`, and `@/lib/images`) to `.storybook/fake/`.
  - Because `src/lib/ipc.ts` is the hand-written TypeScript mirror of Rust structs, placing the fake beneath it ensures every story exercises the mirror and catches type drift.
  - The same four aliases are consumed by the light app's dev mode (`npm run mobile:dev` via `vite.mobile.config.ts`), which boots one world before mounting React: `starter` by default, or the `?seed=` / `?fault=` named in the address (`mobile/fakeBoot.ts`).
- **Single window model**:
  - A story simulates a single window. `window_new` answers but opens nothing; `window_count` always returns 1.
  - Multi-window states are simulated using explicit faults (e.g., `scannerElsewhere` for active hardware leases), never second window instances.
  - `resetWindow()` is called on every `installWorld` pass to clear maximized/docked state between stories.
- **Table row storage & derived DTOs (`fake/db.ts`)**:
  - The fake stores underlying table rows and computes DTOs dynamically.
  - For example, `DeckCard.ownedQuantity` calculates custody on `live` rows vs broad availability on `theory` rows.
  - No seed may contain `collection_entries` rows with quantity 0 (`set_quantity(id, 0)` deletes rows in user schema v24+).
- **Seeds (initial world state)**:
  - `starter`: Standard development world with 4 starter decks, tag closures, price feeds, and combo fixtures.
  - `empty`: Blank database with no user entries or decks.
  - `needsReview`: Holds cards requiring review (e.g. uncertain editions or scanner imports).
  - `virtualDeck`: `starter` plus a 5th Virtual deck (tracks cards without physical ownership and has no `collection_folders` group).
  - `paired`: Simulates a multi-device sync pairing with active group key material and device roster.
  - `shared`: A published read-only collection share snapshot and incoming friend share view.
  - `waiting`: Pre-release cards dated past `CLOCK_BASE` for the Home page's Coming Soon widget.
  - `tokenPlan`: Managed token configurations and wishlist settlements (`All` mode with tokens on).
- **Faults (refusals and edge conditions)**:
  - Configured per story via `parameters: { fake: { fault: "<fault-name>" } }`.
  - Network & Sync: `busy`, `syncing`, `syncError`, `feedFetchError`, `combosFetchError`.
  - Taxonomies: `oracleTagsMissing`, `oracleTagsFetchError`, `artTagsMissing`, `artTagsFetchError`.
  - Hardware & Locks: `scannerElsewhere` (scanner lease held by another window), `scannerMissing`.
  - Supporter States: `patreonDeclined` (grace window), `patreonLapsed` (revoked entitlement), `patreonGroupEntitled` (secondary device entitled via group).
  - Host: `lentStorage` (the story is a browser: the host answers `storage_group_warning` with the web host's sentence). The one fault that adds a command — put over the world's table in `world.ts`, never in `allHandlers`, which parity holds to `desktop.rs`.
- **Data fixtures**:
  - **Cards & Tokens**: Corpus includes Agadeem's Awakening as the sole `{X}` mana card for mana-curve stories, plus token printings mapped by `TOKEN_ORACLE` and `TOKEN_PRINTING`.
  - **Combos & Taxonomies**: Oracle tags answer one entry per requested ID in request order with deduplication. Combo fixtures in `db.ts` support pagination tests via "Show more".
  - **Binary safety**: Never use `\0` in template strings in `db.ts` or fixtures; NUL bytes cause tools like ripgrep to falsely classify files as binary.
- **Undo / Redo Simulation**:
  - `journalled()` wraps deck mutation handlers, snapshotting the deck before and after each write and associating changes with audit log rows.
  - Bulk-undo tickets are stored in a `WeakMap` keyed by the world instance, isolating history per story.
  - State is cleanly reset per story via `installWorld` (`fake/scope.ts`).
- **Plugin handlers**:
  - `plugin:clipboard-manager|write_text` and `plugin:opener|open_url` are mocked in `pluginHandlers()` without backing stores.
  - Native file dialogs are handled by Rust commands: `export_save_file` writes to `D:\Storybook\`, while `import_pick_file` and `mirror_pick_root` simulate picker refusals.

## Rules for Stories

- **Autodocs**: Every story file must include `tags: ["autodocs"]` in its default export metadata to generate a documentation page.
- **Docs page store isolation**:
  - Docs pages mount every story simultaneously. Any story that writes to `useAppStore` during render must set `docs: { story: { inline: false, height: ... } }`.
- **Shared fixtures**:
  - Fixtures needed across multiple story files live in `.storybook/fake/fixtures.ts`. Never put shared fixtures in generated files like `cards.ts`.
- **No hardcoded counts in documentation**: Never document exact story, play, or test counts in markdown files; counts drift across branches and cause merge conflicts.
- **Safe gesture simulation**:
  - Wrap drag interactions in `try { ... } finally { await held.cancel(); }` to prevent leaking global drag state across stories.
  - Always verify drag outcomes using `waitFor` assertions.
- **CSS styling**:
  - Stories must import `.storybook/preview.css`, never `src/index.css` directly.
  - `@source "../.storybook"` ensures Storybook utility classes are not bundled into production application stylesheets.
- **CI verification**:
  - `npm run build-storybook` is executed in CI by the `storybook` job. It serves as the compilation gate for `.storybook/DesignSystem.mdx` and `preview.css`.

## Environment Traps & Integration Caveats

- **Isolated TypeScript Program**:
  - `.storybook` is type-checked separately via `tsc -p .storybook` (invoked during `npm run build`).
  - **`@types/node` is strictly banned**: Ambient Node types must never enter the frontend program. Webview code expects standard DOM types (`setTimeout` returning `number`, not `NodeJS.Timeout`).
- **Story Execution under Vitest**:
  - `src/stories.test.tsx` runs each story's `play` function under Vitest during `npm run test:run`.
  - `setProjectAnnotations` must execute at module scope before calling `composeStories`.
- **Mocking Restrictions**:
  - While three Tauri aliases are mocked, **`@/lib/images` must NEVER be mocked in Vitest**. Mocking it triggers a silent 300-second hang without test output or error traces.
- **jsdom Virtualization**:
  - jsdom does not perform layout or compute element geometries (`offsetHeight`/`offsetWidth` return 0).
  - Virtualized lists require container dimension stubs to render rows; tests should assert the presence of specific elements rather than counting rendered items.
- **Verification Boundary**:
  - Passing Storybook story tests does not guarantee identical behavior in the production Tauri WebView2 container.
  - True drag-and-drop mechanics (OLE drop targets) and custom protocol handling (`mtgimg://`) must be verified in the running app via CDP (`scripts/cdp.mjs`).

## Further Reference

- [`docs/reference/storybook.md`](../docs/reference/storybook.md) — Comprehensive technical reference for the Storybook workbench, fake architecture, and fault catalog.
- [`docs/reference/frontend-design.md`](../docs/reference/frontend-design.md) — Design system specifications, typography, layer hierarchy, and visual direction.
- [`docs/reference/live-ui-verification.md`](../docs/reference/live-ui-verification.md) — CDP verification harness protocol for real WebView2 window testing.
- [`docs/reference/search-faceting.md`](../docs/reference/search-faceting.md) — Facet index behaviors, cold index response shape, and query interaction mechanics.
