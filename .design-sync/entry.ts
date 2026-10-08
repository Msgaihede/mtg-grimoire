/**
 * The design-system entry point — the barrel the claude.ai/design bundle is built from.
 *
 * This repo is an application, not a published component library: there is no `dist/` and
 * `package.json` declares no `main`/`module`/`exports`. So the entry is authored here rather
 * than discovered, and it re-exports the real modules under `packages/ui/` — nothing is reimplemented,
 * and `export *` keeps every helper and constant a component's own module publishes.
 *
 * **Relative specifiers, never the repo's `@/` alias**, and that is not a style choice. TypeScript
 * does not rewrite path aliases when it emits declarations, so an aliased barrel emits an
 * aliased `entry.d.ts` — and the converter reads that file through a ts-morph project with no
 * `paths` of its own. Every `export *` then resolves to nothing, the export list comes back
 * empty, and all 14 storybook titles drop as `[TITLE_UNMAPPED]` with the build cheerfully
 * writing zero components. Measured, twice.
 *
 * Two rules govern what belongs here:
 *
 * 1. **Every synced component's module.** `story-imports.mjs` redirects a story's import to
 *    `window.MtgGrimoire` only when the resolved file's basename is a bundle export, so a
 *    component missing from this list gets silently bundled a *second* time from source —
 *    a duplicate that breaks React identity and drops the shipped styling.
 * 2. **Every module that owns mutable state.** `@/lib/store` is the zustand store: a second
 *    copy of it would give the preview and the component two different stores, and a story
 *    that sets `activeView` would leave the shell it is driving unchanged. Pure functions
 *    (`@/lib/mana`, `@/lib/utils`) are safe to duplicate and are exported only because the
 *    design agent has real use for them.
 */

// ── Primitives ───────────────────────────────────────────────────────────────
export * from "../packages/ui/components/CardImage";
export * from "../packages/ui/components/Figure";
export * from "../packages/ui/components/FilterChips";
export * from "../packages/ui/components/ManaLine";
export * from "../packages/ui/components/ManaText";
export * from "../packages/ui/components/OwnedBadge";
export * from "../packages/ui/components/QuantityStepper";
export * from "../packages/ui/components/RarityGem";
// Added 2026-08-24, when the storybook roster had grown from 34 titles to 71 and these seven
// had no module here to resolve against — they were being dropped as [TITLE_UNMAPPED].
export * from "../packages/ui/components/CountTag";
export * from "../packages/ui/components/GrimoireMark";
export * from "../packages/ui/components/CardArt";
export * from "../packages/ui/components/Dialog";
// Added 2026-09-27. All three had stories since before the 2026-09-08 sync and were being dropped
// as [TITLE_UNMAPPED] with no module to resolve against — Dropdown is the app's only select.
export * from "../packages/ui/components/Dropdown/Dropdown";
export * from "../packages/ui/components/WorkInProgress";
// The tooltip is a hook and a provider, not a component: `Primitives/Tooltip` maps to
// `TooltipProvider` in `titleMap`. `useTooltip` has to ride the same global, because its
// `TooltipContext` is identity — a second copy compiled into a preview reads no provider at all.
export * from "../packages/ui/components/tooltip/TooltipProvider";
export * from "../packages/ui/components/tooltip/useTooltip";

// ── Chrome ───────────────────────────────────────────────────────────────────
export * from "../packages/ui/components/AppShell";
export * from "../packages/ui/components/Ribbon";
export * from "../packages/ui/components/SyncProgress";
export * from "../packages/ui/components/TitleBar";
export * from "../packages/ui/components/CardZoomIndicator";
export * from "../packages/ui/components/menu/ContextMenu";

// ── Table ────────────────────────────────────────────────────────────────────
export * from "../packages/ui/components/table/SortableHeader";
export * from "../packages/ui/components/table/VirtualTable";

// ── Deck affordances ─────────────────────────────────────────────────────────
export * from "../packages/ui/features/decks/DropIndicator";

// ── Deck editor ──────────────────────────────────────────────────────────────
// Added 2026-10-01, by Markus's choice: the deck editor's own parts, so a design agent asked to
// draw the editor mounts the real desk rather than redrawing it. (This reverses the 2026-09-27
// decision in NOTES.md that declined `CardChin` — it is wanted now as part of this set.)
// `StackView` is the whole Stacks desk; `CardStack` one pile of it; `DeckCardFace` the stacked
// card's face (no stories — exported for designs to mount); `CardMarks` the family of marks laid
// on a card (`QuantityTag` is what `titleMap` sends its title to, `FilterChips → ToggleChip`'s
// move); `CountPill` the pile heading's count; `GroupHeader` the pile heading itself.
// **`CardMarks` needs a shim line as well as this re-export**, for `FilterChips`' reason: no
// export is named after the file, so rule 2 cannot recognise `./CardMarks` as a component module
// and a story importing it would compile a second copy. `cfg.storyImports.shim` carries
// `/features/decks/CardMarks`; the two are one mechanism in two files.
export * from "../packages/ui/features/decks/views/StackView";
export * from "../packages/ui/features/decks/CardStack";
export * from "../packages/ui/features/decks/DeckCardFace";
export * from "../packages/ui/features/decks/CardMarks";
export * from "../packages/ui/features/decks/CountPill";
export * from "../packages/ui/features/decks/views/GroupHeader";
export * from "../packages/ui/components/CardChin";

// ── Shared state and helpers ─────────────────────────────────────────────────
// `store` first and alone on its line: it is the one export here whose *identity* matters.
export * from "../packages/ui/lib/store";
// The app's one `@dnd-kit/dom` manager — rule 2, and the second export here whose identity
// matters. It is a module singleton that owns mutable state: the `DragDropManager` registry, the
// drag-start payload `WeakMap`, an id counter, and monitor listeners it adds at module scope.
// Added 2026-10-01 with the deck editor: `StackView.stories.tsx` imports `../dnd`, and
// `CardStack.stories.tsx` imports `./dnd` and `./cardControl`; none of those is a component
// module, so they compile from source into the preview and reach this file through
// `@/lib/dndTarget` — constructing a second `DragDropManager` beside the bundle's. The matching
// `cfg.storyImports.shim` entry (`/lib/dndManager`) points those imports at this one. One
// mechanism in two files, exactly as with react-query below.
export * from "../packages/ui/lib/dndManager";
export * from "../packages/ui/lib/mana";
export * from "../packages/ui/lib/rarity";
export * from "../packages/ui/lib/sort";
export * from "../packages/ui/lib/layers";
export * from "../packages/ui/lib/utils";
// `StackView` takes a required `marketplace` — one currency for the whole desk — and its stories
// pass `MARKETPLACES.tcgplayer`. Pure data, exported so a design mounting the Stacks desk has the
// same object to hand rather than a hand-written look-alike of its fields.
export * from "../packages/ui/lib/marketplace";

// ── react-query, as a singleton ──────────────────────────────────────────────
// **Identity, not convenience** — the same reason `store` is called out above.
//
// A story file is the one module `lib/story-imports.mjs` never redirects (its rule 2 exempts
// story files by construction), so `AppShell.stories.tsx`'s own `useQueryClient` import compiled
// a *second* copy of `@tanstack/react-query` into `_preview/AppShell.js`. `QueryClientProvider`
// then set its context on the bundle's copy while the story's `Shell` read the preview's, and a
// plain React context lookup across two module instances finds nothing: every one of AppShell's
// eleven cells died with "No QueryClient set" and the card rendered an empty root.
//
// Exporting it here puts the one instance on `window.MtgGrimoire`, and the matching
// `cfg.storyImports.shim` entry points preview-side imports at it. **The two are one mechanism
// in two files** — a shim without this re-export resolves to `undefined` and calls it, which is
// the silent failure NOTES.md already records for the fake.
export * from "@tanstack/react-query";
