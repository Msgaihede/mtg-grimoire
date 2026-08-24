/**
 * The design-system entry point — the barrel the claude.ai/design bundle is built from.
 *
 * This repo is an application, not a published component library: there is no `dist/` and
 * `package.json` declares no `main`/`module`/`exports`. So the entry is authored here rather
 * than discovered, and it re-exports the real modules under `src/` — nothing is reimplemented,
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
export * from "../src/components/CardImage";
export * from "../src/components/Figure";
export * from "../src/components/FilterChips";
export * from "../src/components/ManaLine";
export * from "../src/components/ManaText";
export * from "../src/components/OwnedBadge";
export * from "../src/components/QuantityStepper";
export * from "../src/components/RarityGem";
// Added 2026-08-24, when the storybook roster had grown from 34 titles to 71 and these seven
// had no module here to resolve against — they were being dropped as [TITLE_UNMAPPED].
export * from "../src/components/CountTag";
export * from "../src/components/GrimoireMark";
export * from "../src/components/CardArt";
export * from "../src/components/Dialog";

// ── Chrome ───────────────────────────────────────────────────────────────────
export * from "../src/components/AppShell";
export * from "../src/components/Ribbon";
export * from "../src/components/SyncProgress";
export * from "../src/components/TitleBar";
export * from "../src/components/CardZoomIndicator";
export * from "../src/components/menu/ContextMenu";

// ── Table ────────────────────────────────────────────────────────────────────
export * from "../src/components/table/SortableHeader";
export * from "../src/components/table/VirtualTable";

// ── Deck affordances ─────────────────────────────────────────────────────────
export * from "../src/features/decks/DropIndicator";

// ── Shared state and helpers ─────────────────────────────────────────────────
// `store` first and alone on its line: it is the one export here whose *identity* matters.
export * from "../src/lib/store";
export * from "../src/lib/mana";
export * from "../src/lib/rarity";
export * from "../src/lib/sort";
export * from "../src/lib/layers";
export * from "../src/lib/utils";

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
