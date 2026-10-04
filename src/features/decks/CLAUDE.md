# src/features/decks — the deck builder

TypeScript owns deck validation, category management, view presentation, and editing interactions. Rust supplies facts via `DeckCardRow` (legalities, color identity, P/T, game changers) and executes database transactions.

Detailed storage architectures, live measurements, and visual findings are in reference docs:
- Architecture, validation, notes TDZ, and to-do autosave: [deck-builder.md](../../../docs/reference/deck-builder.md)
- Storage, tables, and undo: [decks-storage.md](../../../docs/reference/decks-storage.md)
- Live WebView verification and interaction findings: [decks-live-findings.md](../../../docs/reference/decks-live-findings.md)
- Commander bracket rules and calculations: [commander-brackets.md](../../../docs/reference/commander-brackets.md)
- Deck builder layout and visual design: [frontend-design.md](../../../docs/reference/frontend-design.md)

For global repo workflow, style, and testing conventions, refer to:
- [Workflow & Commits](../../../docs/agent/WORKFLOW.md)
- [Code Style](../../../docs/agent/CODE_STYLE.md)
- [Verification Guide](../../../docs/agent/RUNNING_AND_VERIFYING.md)

---

## 1. The Validation Layer (`validation/`)

Pure TypeScript engine analyzing deck rules:
- **Core modules**:
  - `engine.ts`: Evaluates deck size, copy limits, format legality, and restricted semantics (`max_one`, `banned_as_commander`).
  - Two validation entry points:
    - `validateDeck`: Evaluates the whole deck (deck size floors/ceilings, copy limits, overall legality).
    - `validateForMarks`: Evaluates individual cards rendered in views to render rule-break marks on card tiles. Inactive piles are evaluated for mark warnings but excluded from deck totals.
  - `singleton.ts`: Evaluates exceptions derived from oracle text rules (e.g. Relentless Rats, Seven Dwarves), never static card name lists.
  - `commanders.ts` & `companions.ts`: Enforces eligibility, partner combinations (Partner, Friends Forever, Choose a Background), color identity rules, and companion deck constraints.
  - `bracket.ts` (`estimateBracket`): Advisory Commander power floor calculation (ranks 2–4). Returns `BASE_FLOOR = 2`; never returns 1 or 5 (which represent player intent). Does not invalidate decks.

---

## 2. Category Model & Pile Architecture

- **Category structure**: Categories (`deck_categories`) own user-defined names, ordering, and active flags. Piles belong to one of five fixed kinds (`main | side | commander | companion | maybe`).
- **List isolation (Theory vs. Actual)**:
  - Piles belong strictly to one list variant (`variant = 'live'` or `'theory'`). Categories and cards never cross lists implicitly.
  - Moving cards across lists (`Add to actual` / `Add to theory`) uses `deck_meta::counterpart_in` to locate or synthesize matching category counterparts in the target list.
- **Active state (`is_active`)**: Inactive piles (`is_active = 0`) are excluded from deck count totals, format validation, shortfall checks, and cardboard allocations. Never branch on `kind === 'maybe'`.
- **Category origin**: Stored as `'user'` (user-created) or `'auto'` (system-filed). Governs whether empty piles render in views (`drawsWhenEmpty`).

---

## 3. The Three Deck Kinds

Normalized via `deckKind.ts` (`regular`, `theory`, `virtual`):
- **Regular decks (`false, false`)**: Single live list tracking owned physical cardboard.
- **Theory decks (`true, false`)**: Dual-list structure pairing an Actual cardboard list with a Theory planning list.
- **Virtual decks (`false, true`)**: Decks tracked without physical cardboard allocation (proxies, MTGO/Arena lists).
- **Collection tracking boundary**:
  - Checked via `tracksCollection(deck)`. Required prop across deck components.
  - Virtual decks hide shortfall indicators, collection shortfall buttons, `Owned` columns in tables, and `Collection ▸` card actions.
  - Changing deck kinds always updates both flags simultaneously via `deckKindPatch`.

---

## 4. Deck Writes & State Lifecycle

- **Architecture separation**:
  - `useDeckCore.ts`: Core TanStack queries and mutations operating independently of UI state or store singletons (reused by mobile/web light app).
  - `useDeck.ts`: Desktop host wrapper managing modal anchors and card selection continuity.
- **Write safety & atomic transactions**:
  - All deck modifications route through transactional backend functions wrapped in `state::with_write`.
  - Deck updates trigger per-deck undo journaling (`deck_undo`), allowing scoped rollback via `Ctrl+Z`.
  - Batch modifications (imports, bulk category operations) execute in single transactions rather than per-line loops.
  - Card mutations support adding, removing, updating counts, moving piles, swapping printings, and tagging labels (`deck_labels`).

---

## 5. Views, Controls, & Interaction

- **Four primary views**:
  - `Stacks`: Visual vertical card stacks with hover expansion and pushdown offsets (cards move down without increasing container height).
  - `Grid`: Card face tiles arranged in responsive category columns.
  - `Table`: Virtualized tabular view with roving tab indices.
  - `Text`: Compact line-oriented decklist view.
- **Zoom & geometry**: Deck views scale geometry independently via Ctrl+wheel; zoom values persist per view in `app_meta` (`useCardZoomPersistence`).
- **Multi-selection & drag**: `Ctrl/Cmd` toggles, `Shift` selects ranges (`useCardSelection`). Multi-card dragging moves all selected cards into the destination pile in one atomic operation.
- **Undocked bar (`UndockedBar.tsx`)**: Floating bottom controls hosting view mode toggles, zoom steppers, card search dock toggle, and bulk selection actions.
- **Quick Add (`QuickAdd.tsx`)**: High-speed keyboard card entry supporting instant search, quantity increments, and category targeting without leaving the keyboard (Enter commits, Escape reverts).
- **Tokens & Emblems (`DeckTokensPanel`)**: Dedicated token management (`deck_token_printings`), supporting three modes (`managed`, `collection`, `hidden`).
- **Notes & To-dos**:
  - Notes band: Titled multi-document rich text notes (`deck_notes`) with Markdown/ProseMirror formatting.
  - `NoteEditor.tsx` (both bands' editor) passes `injectCSS: false`: Tiptap's default appends a runtime stylesheet the shipped CSP refuses. Its header has what that sheet carried and why no rule replaced it.
  - To-do band: Structured deck checklists (`deck_todo_lists`) supporting item completion and ordering.
- **Keyboard focus handling**: Floating toolbars automatically avoid intercepting typing gestures while text inputs or note editors have active focus.

---

## 6. Build and Verification Commands

Execute verification tests only at the end of feature work:

| Command | Action |
| --- | --- |
| `npm run test` / `npx vitest src/features/decks` | Run deck builder unit and validation tests |
| `npx vitest src/features/decks/validation` | Run isolated deck validation rules tests |
| `cargo test -p grimoire-core deck::` | Run Rust core deck storage tests |
| `cargo test -p mtg-grimoire deck::` | Run desktop host wrapper tests |
| `npm run storybook:test` | Run Storybook deck component interaction tests |

Commit discipline:
- One commit per feature matching feature size, bundling domain logic, UI views, tests, and documentation for `release-please`.
