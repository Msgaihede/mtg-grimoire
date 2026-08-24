import { createLucideIcon, type IconNode } from "lucide-react";

/**
 * The icons this app draws that lucide itself does not, built with lucide's own factory.
 *
 * **Copied here rather than installed, and the copy is licensed.** Each glyph comes from a
 * package the app does not otherwise use — `@tabler/icons-react` and `@lucide/lab` — and one
 * picture is a poor reason to take on a whole icon set, a second icon runtime and another
 * version to keep moving. Both sources permit the copy provided their notice travels with it,
 * which is what the per-icon comments below are:
 *
 * - Tabler Icons — MIT, © 2020-2026 Paweł Kuna — https://github.com/tabler/tabler-icons
 * - Lucide Lab — ISC, © Lucide Contributors — https://github.com/lucide-icons/lucide-lab
 *
 * **`createLucideIcon` rather than a hand-written `<svg>`, because the callers must not be able
 * to tell.** The factory returns exactly the `LucideIcon` that `import { Heart }` returns, so
 * `AppShell`'s `NAV` keeps its type, `className="size-5"` still sizes it, `aria-hidden` still
 * lands on the `<svg>`, and a `strokeWidth` set anywhere up the tree still reaches it. The two
 * source files are already drawn on lucide's terms — a 24 grid, 2px strokes, round caps and
 * joins — so nothing here is redrawn or rescaled; only the wrapper changed.
 *
 * The `key` on each node is React's, not the artwork's: `Icon` maps the array into children, and
 * lucide's own generated icons carry one for the same reason.
 *
 * This is not the place for the app's own artwork. A mark that *is* MTG Grimoire — the
 * grimoire, the foil sheen, the game-changer crown — is drawn by its own component, because
 * those take a size and pick a variant rather than being one glyph at any size.
 */

/**
 * Three overlapping playing cards — Tabler's `cards`.
 *
 * The Decks entry. `Layers`, which it replaced, is the generic stack lucide gives every app;
 * this one is a hand of cards, which is what a deck of Magic cards actually is. `Layers` is
 * still the right picture for a deck *inside* a menu row beside other lucide glyphs, so this
 * does not chase it there.
 */
export const Cards = createLucideIcon("cards", [
  [
    "path",
    {
      d: "M3.604 7.197l7.138 -3.109a.96 .96 0 0 1 1.27 .527l4.924 11.902a1 1 0 0 1 -.514 1.304l-7.137 3.109a.96 .96 0 0 1 -1.271 -.527l-4.924 -11.903a1 1 0 0 1 .514 -1.304l0 .001",
      key: "grimoire-cards-front",
    },
  ],
  ["path", { d: "M15 4h1a1 1 0 0 1 1 1v3.5", key: "grimoire-cards-middle" }],
  [
    "path",
    {
      d: "M20 6c.264 .112 .52 .217 .768 .315a1 1 0 0 1 .53 1.311l-2.298 5.374",
      key: "grimoire-cards-back",
    },
  ],
] satisfies IconNode);

/**
 * A two-drawer filing cabinet — Lucide Lab's `cabinet-filing`.
 *
 * The Collection entry, where `LibraryBig` was. The collection is a cabinet in this app's own
 * words — `collection-folders.md` calls it "the collection's cabinet", and its folders are
 * drawers holding cards rather than a shelf of books.
 */
export const CabinetFiling = createLucideIcon("cabinet-filing", [
  ["path", { d: "M4 12h16", key: "grimoire-cabinet-rail" }],
  ["rect", { width: "16", height: "20", x: "4", y: "2", rx: "2", key: "grimoire-cabinet-body" }],
  ["path", { d: "M10 6h4", key: "grimoire-cabinet-upper-handle" }],
  ["path", { d: "M10 16h4", key: "grimoire-cabinet-lower-handle" }],
] satisfies IconNode);
