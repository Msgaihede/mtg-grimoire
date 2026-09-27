import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The shelves' three button shapes, written once so the heading, the sticky bar and the path row's
 * toolbar cannot drift apart. All three are **ghost** buttons — no surface of their own until
 * hovered — because a heading is chrome over cards, and a filled button on every shelf would
 * out-shout the cards it names. `PRESS` carries the press dip and its reduced-motion opt-out.
 */
export const SHELF_ICON_BUTTON = cn(
  "grid size-7 flex-none place-items-center rounded-md text-dim hover:bg-surface hover:text-text",
  PRESS,
  FOCUS,
);

/** The collapse chevron: the icon button a size down, the canvas's 24px. */
export const SHELF_CHEVRON = cn(
  "grid size-6 flex-none place-items-center rounded-md text-dim hover:bg-surface hover:text-text",
  PRESS,
  FOCUS,
);

/** A glyph and a word — the toolbar's three and the sticky bar's Top. */
export const SHELF_TEXT_BUTTON = cn(
  "inline-flex h-7 flex-none items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs text-dim hover:bg-surface hover:text-text",
  PRESS,
  FOCUS,
);
