# packages/ui — the shared React frontend

React 19 + TypeScript frontend for mtg-grimoire, shared by the desktop app, the light app and the share page, which are all built from it. TypeScript owns presentation and domain logic (deck validation, import/export parsing, query syntax); Rust supplies facts and database operations.

`@/` is this package's alias and only this package's; other packages reach these modules as `@grimoire/ui/…`.

Detailed measurements, rationale, and design history are preserved in reference docs:
- [Frontend Architecture Reference](../../docs/reference/frontend-architecture.md)
- [Frontend Design Reference](../../docs/reference/frontend-design.md)
- [Motion Reference](../../docs/reference/motion.md)
- [Keyboard Shortcuts Reference](../../docs/reference/keyboard-shortcuts.md)
- [Image Cache Reference](../../docs/reference/image-cache.md)
- [Search Syntax Reference](../../docs/reference/search-syntax.md)
- [Live UI Verification](../../docs/reference/live-ui-verification.md)

For global repo workflow, style, and testing conventions, refer to:
- [Workflow & Commits](../../docs/agent/WORKFLOW.md)
- [Code Style](../../docs/agent/CODE_STYLE.md)
- [Verification Guide](../../docs/agent/RUNNING_AND_VERIFYING.md)

---

## 1. IPC & Backend Boundary

- **Hand-written wire mirror**: `packages/ui/lib/ipc.ts` mirrors Rust structs — a barrel over `lib/ipc/<domain>.ts`, whose commands objects it spreads into one `ipc`. Import it only as `@/lib/ipc`, never a domain file (ESLint; it is the seam every suite mocks). Checked by `ipc.test.ts`, which parses Rust source files to ensure struct and parameter parity. Its walk covers **every** `export interface`: a new one needs a Rust struct of its name, a `renamed` entry, or an `unmirrored` entry with a reason — otherwise the suite fails naming it.
- **IPC dispatch (`Core.call`)**: Abstraction layer below `@/lib/core` routing calls to desktop Tauri invoke, Android `core_call`, or WebAssembly Worker dispatch.
- **ASCII JSON headers**: Serializing JSON for IPC headers (e.g. scanner frames) must use `asciiJson` (escapes non-ASCII) to satisfy header byte constraints.
- **One rejection shape**: every `ipc.*` wrapper rejects with the backend's sentence as a plain `string` on every host (`invoke` runs the rejection through `ipcError`). Never branch on `instanceof Error` for an IPC failure; render it with `ipcError(e)`.

---

## 2. Design System & Component Rules

- **Storybook MCP tooling**: Always query `mtg-grimoire-sb-mcp` tools (`list-all-documentation`, `get-documentation`) before using or modifying UI components.
- **Never hallucinate component props**: Use only documented props verified via Storybook MCP tools or story files.
- **Card art rendering (`components/CardImage`)**:
  - Never use raw `<img>` tags for cards. Always use `CardImage`.
  - Keys on image URL to prevent stale frame caching during async loads.
  - Hardcodes `draggable={false}` to prevent native drag conflicts with dnd-kit.
  - Implements 5-second stall watchdog (`useImageRetry`).
  - Sets `decoding="sync"` to prevent blank tiles from delayed compositor passes.
- **Card framing (`components/CardArt`)**: Standard 5:7 card aspect container. Loads via `mtgimg://` (or `/mtgimg` in web). Never fetch images via `fetch()`.
- **Foil & card badges**:
  - Foil glyphs from `FinishMark`: `Sparkles` (foil), `Gem` (etched), `Aperture` (special non-foil).
  - Top-right corner chip: `FoilOverlay` combines finish glyphs and `GameChangerMark`.
  - Count badges: `CountTag` for counts overlaid on card art (no `×`, grey by default). Counts beside cards keep `×`.
- **Touch floor (the light app's phone face draws these components too)**:
  - A control grows for a finger through the `coarse:` variant and `--target-min` (44px), never a raw pointer query (`touchTargets.test.ts`). Under a mouse nothing changes size.
  - Settings panels: `controls.ts`' `PANEL_BUTTON` is `BUTTON` plus the floor (`TOUCH_FLOOR`); a text box adds `TOUCH_FIELD` (16px type, below which a phone zooms the page on focus) and its own height. `BUTTON` itself is imported outside Settings and carries no floor — a surface gets one when it has been measured under a finger. `controls.test.ts` pins the classes and compiles them.
  - A fold that depends on a box's width asks that box (`@container`), and a fix for a phone's width must leave every desktop box where it was: measure both, do not reason from the classes.
- **Design tokens**:
  - Dim text uses `text-dim` (never `text-muted`).
  - Magic colors strictly use `--color-mana-w|u|b|r|g|c`. Gold accent uses `--color-accent`.

---

## 3. Layers, Modality, & Dismissal

- **Strict z-index ladder**: All z-indexes originate from `LAYER` in `packages/ui/lib/layers.ts`:
  `raised (10) < header (20) < popup (30) < quickBar (35) < dragTray (40) < overlay (45) < overlayStacked (46) < tooltip (47) < gate (50) < caption (60)`. Enforced by `layers.test.ts`.
- **Modal dialogs (`components/Dialog.tsx`)**:
  - Centered over scrim at `LAYER.overlay`.
  - Modals must be bounded to window (`grid-rows-[minmax(0,1fr)]`) with internal scrolling (`min-h-0 flex-1 overflow-y-auto`).
  - Never mount modals inside `@container` elements (containment breaks `position: fixed`).
  - **A face can lend its dialogs a finger's gestures** (`lib/dialogHost.ts`): under a `DialogHostContext` every open `Dialog` claims a Back step (`claimBack`, closed through `onDismiss`) and, with `swipeToClose`, a header that drags down to close through `onClose`. Only the light app's phone face provides one; with none (the desktop, every story) nothing changes. A dialog whose `open` is already a history entry passes `placeBacked`.
- **Escape dismissal protocol (`useDismissOnEscape`)**:
  - Inner dismissibles (dialogs, popups) register in the window capture phase (`preventDefault()`). Outer layers listen in bubble phase.
  - Search inputs clear on Escape when non-empty (`clearFieldOnEscape`) before dismissing parent views.
- **Context menus (`packages/ui/components/menu/`)**:
  - Single instance mounted at root (`ContextMenuProvider`) at `LAYER.popup`.
  - Text fields retain native context menus (`isTextField`).

---

## 4. Search, Filtering, & Pricing

- **Container-driven layout**: `FilterBar.tsx` uses container queries (`@container/fb`), not viewport media queries. Draggable from 206px.
- **Query syntax (`features/search/queryLanguage.ts`)**:
  - Parses Scryfall's whole language (issue #909): keyword terms (`kw:`, `cmc>=3`, `is:fetchland`, `otag:`), `or`, parentheses, `!exact` names and `not:`. Top-level plain terms keep their own paths (free text, tag tokens, predicates); an `or` or a negated group travels as one `anyOf`/`allOf` predicate that Rust answers as a single SQL clause, and the facet index counts it wide.
  - Tag resolution is exact; queries fail closed on unresolved tags to prevent showing stale results.
- **Filters outlive the page (issue #908)**: the Search and Tags pages open on the filters the reader left. `useCardSearch({ rememberAs })` and the Tags page's chips keep their state in `lib/viewMemory.ts` — window-lifetime module memory, never storage, so a restart opens fresh. The deck builder's docked panels pass no `rememberAs`. `test-setup.ts` and the fake's `installWorld` reset it.
- **Pricing & marketplaces**:
  - Currency and pricing formatting strictly use `formatPrice(value, currency)` driven by `useMarketplace()`.
  - `null` prices render as an em dash; never fall back to another marketplace's price.

---

## 5. Motion & Accessibility

- **Animation presets (`packages/ui/lib/motion.ts`)**:
  - Standard timings and curves (`scrim`, `dialog`, `popup`, `press`).
  - Forbidden APIs: `AnimatePresence mode="popLayout"` and `animateView()` (append runtime styles blocked by CSP `style-src 'self'`).
  - Same policy, any library: a Tiptap editor is built with `injectCSS: false` and imports `prosemirror-view/style/prosemirror.css` for the bundler (`tokens.test.ts` enforces both). Before a new dependency draws anything, grep its `dist/` for `createElement("style")`.
  - `<MotionConfig reducedMotion="user">` mounted once per face (in `App.tsx` and `PhoneApp.tsx`). Non-positional animations require explicit `useReducedMotion()`.
- **Press feedback**: Use `PRESS` recipe from `packages/ui/lib/motion.ts`. Never apply press scaling to text input fields.
- **Keyboard navigation**:
  - Global chords catalogued in `packages/ui/lib/shortcuts.ts`.
  - Focus outlines are gated on `data-kbd` (`keyboardModality.ts`).
  - `tabIndex={-1}` landing pad containers carry no focus ring.
  - Multi-selection: `Ctrl/Cmd` toggles, `Shift` selects range (`packages/ui/lib/multiSelect.ts`). `Ctrl+A` picks every card a wall's filters match, unloaded pages included, and `Escape` puts a picked set down — a wall with a `selectionScope` registers itself (`features/search/selectAllSurface.ts`); a docked search column takes the chord only from inside it. See [keyboard-shortcuts.md](../../docs/reference/keyboard-shortcuts.md#selectall).

---

## 6. Directory Layout & Verification

| Directory | Scope |
| --- | --- |
| `packages/ui/components/` | Reusable design system primitives (`CardImage`, `Dialog`, `VirtualTable`, `menu/`) |
| `packages/ui/features/` | Feature surfaces (`decks/`, `search/`, `collection/`, `wishlist/`, `transfer/`, `settings/`) |
| `packages/ui/lib/` | Infrastructure (`ipc.ts`, `layers.ts`, `motion.ts`, `shortcuts.ts`, `tokens.ts`) |

- **Occasional views are lazy**: `App.tsx` loads Scanner, Settings, Tags, Trade, Playtesting and Shared with `React.lazy` under one `Suspense`; a static import of any of them puts its chunk back in the first load (`App.test.tsx` fences it).

Run verification tests only at the end of feature work:

| Command | Action |
| --- | --- |
| `pnpm test` / `pnpm exec vitest packages/ui/` | Run frontend unit and component tests |
| `pnpm lint` | Run ESLint and token verification |

Commit discipline:
- Commits match feature size (one commit per feature), bundling components, stories, and tests together for `release-please`.
