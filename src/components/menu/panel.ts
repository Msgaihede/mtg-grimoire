import type { MenuPosition } from "./types";

/**
 * What a menu panel *is* — in DOM attributes, in pixels, and in Tailwind literals.
 *
 * A fifth file in a four-file task, and it earns itself by being the thing neither component can
 * own. `ContextMenu.tsx` renders the root panel and the rows; `Submenu.tsx` renders a child panel
 * and is rendered *by* `ContextMenu.tsx`. Putting the shared vocabulary in either one makes the
 * pair a circular import — survivable with hoisted function declarations and a smell in a module
 * graph Vite, Vitest and Storybook each resolve their own way. Nothing here renders anything, so
 * there is nothing to go round.
 *
 * ## The DOM is the caret's data structure, deliberately
 *
 * The keyboard model does not walk the `MenuItem[]`; it walks the rows the browser actually drew,
 * found by these attributes. Two things fall out of that and both matter. A **lazy** submenu's
 * `Content` is somebody else's component rendering rows this module never saw, and the caret
 * reaches them anyway. And moving the caret changes **no React state**, so a keystroke costs no
 * re-render — which is what keeps `MenuLazy.Content` mounted exactly once, the one promise that
 * type exists to make.
 */

/** Marks one menu surface — the root panel, or any open submenu's panel. */
export const PANEL_ATTR = "data-menu-panel";
/** How deep that panel is: `0` is the root, `1` its submenu, and so on. */
export const DEPTH_ATTR = "data-menu-depth";
/** Marks a row's outer box, which for a submenu row also contains that submenu's panel. */
export const ROW_ATTR = "data-menu-row";
/** Marks the focusable control inside a row box, as against anything nested below it. */
export const ROW_BUTTON_ATTR = "data-menu-row-button";

/**
 * The four attribute spellings above, as selectors.
 *
 * Written out rather than built from the constants so that a `querySelector` string is a string
 * the browser and a reader can both parse at a glance. The pair is two lines apart on purpose.
 */
export const PANEL_SELECTOR = "[data-menu-panel]";
export const ROW_SELECTOR = "[data-menu-row]";
export const ROW_BUTTON_SELECTOR = "[data-menu-row-button]";
/** A row's own control, and never one nested inside its submenu — hence the `:scope >`. */
export const OWN_ROW_BUTTON_SELECTOR = ":scope > [data-menu-row-button]";
/** Everything the caret may land on. `menuitemradio` is a row too; a separator never is. */
const CARET_SELECTOR = '[role="menuitem"],[role="menuitemradio"]';

/** The panel at `depth`, as a selector — used to find a submenu that has just been opened. */
export const panelAtDepth = (depth: number): string => `[data-menu-depth="${depth}"]`;

/**
 * The panel's declared minimum width in px, which is `min-w-56` below written as a number.
 *
 * **The placement arithmetic never trusts a measurement smaller than this**, and that is a
 * correctness rule rather than a convenience. A panel is measured *after* it mounts, so its first
 * painted frame is placed from a size nothing has read yet; and under jsdom every box measures a
 * hard `0`, so a test would otherwise prove that a menu at the right-hand edge does not flip.
 * The smallest room a menu can ever need is the room it promises to take, and that is this.
 */
export const MENU_MIN_WIDTH = 224;

/**
 * The same floor for height, and the arithmetic behind it: the panel's `border` (1px either side)
 * plus its `p-1` (4px either side) plus one row — `py-1.5` around `text-sm`'s 20px line — is
 * `2 + 8 + 32`. A menu with no rows at all is not a thing any caller can build.
 */
export const MENU_MIN_HEIGHT = 42;

/** How much of the viewport edge a panel keeps clear, in px. Below this it reads as clipped. */
export const MENU_EDGE_GUTTER = 8;

/**
 * The four transform origins, written out whole.
 *
 * **Tailwind scans source text for whole class names**, so `` `origin-${v}-${h}` `` emits no rule
 * at all — the panel would then grow from its own middle, which is the one thing the app's
 * anchored-popup rule forbids: a popup pinned by one corner and growing from another reads as
 * unrelated to the thing that produced it.
 */
const ORIGIN = {
  top: { left: "origin-top-left", right: "origin-top-right" },
  bottom: { left: "origin-bottom-left", right: "origin-bottom-right" },
} as const;

/** The panel's own look, shared by the root and every submenu so the cascade is one surface. */
export const PANEL_CLASS =
  "min-w-56 rounded-lg border border-border bg-surface p-1 shadow-lg outline-none";

/** A row's shared geometry. The colours differ by state and are the row's own to add. */
export const ROW_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none " +
  "transition-colors duration-[var(--duration-fast)] motion-reduce:transition-none";

/** Where the root panel lands, in the viewport coordinates a `fixed` box is laid out against. */
export interface Placement {
  left: number;
  top: number;
  /** One of the four whole `origin-*` literals above. */
  origin: string;
}

const clamp = (value: number, size: number, viewport: number): number =>
  Math.max(MENU_EDGE_GUTTER, Math.min(value, viewport - size - MENU_EDGE_GUTTER));

/**
 * Where a menu opened at `at` goes, given the room it needs.
 *
 * **`document.documentElement.clientWidth`, never `window.innerWidth`.** `innerWidth` counts the
 * classic vertical scrollbar and the initial containing block a `fixed` box lays out against does
 * not — measured in this app at **1280 against 1265**, which is how the zoom badge came to sit
 * 15px left of the corner it was anchored to. The two axes flip independently: a menu opened in
 * the bottom-right corner grows up *and* left, and the corner it is pinned by is the corner it
 * grows from.
 */
export function placeMenu(at: MenuPosition, width: number, height: number): Placement {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const flipX = at.x + width + MENU_EDGE_GUTTER > viewportWidth;
  const flipY = at.y + height + MENU_EDGE_GUTTER > viewportHeight;
  return {
    left: clamp(flipX ? at.x - width : at.x, width, viewportWidth),
    top: clamp(flipY ? at.y - height : at.y, height, viewportHeight),
    origin: ORIGIN[flipY ? "bottom" : "top"][flipX ? "right" : "left"],
  };
}

/**
 * Where a submenu goes relative to its parent row — as classes rather than as pixels.
 *
 * A submenu is **`absolute` inside its parent row's box** and the root panel is `fixed`, and that
 * difference is not stylistic. The root panel animates a `scale`, and a transformed ancestor
 * becomes the containing block for every `fixed` descendant — so a `fixed` submenu inside it would
 * be positioned against the panel it is trying to escape. Positioning it in the cascade sidesteps
 * that entirely and needs no pixel arithmetic; the measurement below decides only *which* way.
 */
export interface SubmenuPlacement {
  /** `left-full` or `right-full`, and `top-0` or `bottom-0`. */
  position: string;
  origin: string;
}

export function placeSubmenu(row: DOMRect, height: number): SubmenuPlacement {
  const toLeft =
    row.right + MENU_MIN_WIDTH + MENU_EDGE_GUTTER > document.documentElement.clientWidth;
  const upward = row.top + height + MENU_EDGE_GUTTER > document.documentElement.clientHeight;
  return {
    // Whole literals, all four of them, for the reason `ORIGIN` is written out.
    position: toLeft
      ? upward
        ? "right-full bottom-0"
        : "right-full top-0"
      : upward
        ? "left-full bottom-0"
        : "left-full top-0",
    origin: ORIGIN[upward ? "bottom" : "top"][toLeft ? "right" : "left"],
  };
}

/**
 * A row's focusable control.
 *
 * The two shapes of row are not symmetric and cannot be. A plain row **is** its button; a submenu
 * row is a box holding a button *and* the panel it opens, because that panel is positioned in the
 * cascade against it. Both carry `ROW_ATTR` — that is what lets the pointer and the caret treat
 * them alike — so this is the one place that has to know which of the two it is looking at.
 */
export function rowButtonOf(row: HTMLElement): HTMLElement | null {
  if (row.matches(ROW_BUTTON_SELECTOR)) return row;
  return row.querySelector<HTMLElement>(OWN_ROW_BUTTON_SELECTOR);
}

/** The panel a node is drawn in, or `null` for a node outside every menu. */
export function panelOf(node: Element | null): HTMLElement | null {
  return node?.closest<HTMLElement>(PANEL_SELECTOR) ?? null;
}

/** `0` for the root panel, `1` for a submenu of it, and so on. */
export function depthOf(panel: HTMLElement): number {
  return Number(panel.getAttribute(DEPTH_ATTR) ?? "0");
}

/**
 * The rows of **this** panel that the caret may land on, in document order.
 *
 * `querySelectorAll` reaches into any open submenu, so the `panelOf` test is what keeps a
 * cascade's levels apart. A disabled row is drawn and read and never landed on — `isSelectable`'s
 * rule, applied here to the DOM rather than to the array, so that a lazy panel's own rows obey it
 * too.
 */
export function menuRowsIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(CARET_SELECTOR)).filter(
    (row) => panelOf(row) === panel && row.getAttribute("aria-disabled") !== "true",
  );
}

/** Which way the caret is going. `next`/`prev` wrap; `first`/`last` do not. */
export type CaretMove = "next" | "prev" | "first" | "last";

/**
 * Move the caret inside one panel, wrapping.
 *
 * With the caret on the panel itself — where it starts, so that Escape has something to hand back
 * and the first arrow is not swallowed — `next` lands on the first row and `prev` on the last,
 * which is what an index of `-1` gives for free in both directions.
 */
export function moveCaret(panel: HTMLElement, move: CaretMove): void {
  const rows = menuRowsIn(panel);
  if (rows.length === 0) return;
  const from = rows.indexOf(document.activeElement as HTMLElement);
  const to =
    move === "first"
      ? 0
      : move === "last"
        ? rows.length - 1
        : move === "next"
          ? (from + 1) % rows.length
          : from <= 0
            ? rows.length - 1
            : from - 1;
  rows[to]?.focus();
}

/** The caret into a panel that has just opened: its first row, or the panel itself if it has none. */
export function focusInto(panel: HTMLElement): void {
  const rows = menuRowsIn(panel);
  if (rows.length > 0) rows[0].focus();
  else panel.focus();
}
