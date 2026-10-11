/**
 * The class recipes the Trade page's controls are drawn from.
 *
 * A folder-level module for the reason `features/settings/controls.ts` is one: a page, its panels
 * and its two dialogs draw the same four buttons, and four spellings of one button is four
 * decisions that only agree today. The design draws every control on this page at **36px** — the
 * app's own chrome height — with a 6px corner, and that is what these say once.
 */
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A worded button: `Archive`, `Duplicate`, `Cancel`.
 *
 * **`aria-disabled`, never the attribute**, which is the app's rule for a control that greys while
 * the reader is working: a button that left the tab order on the press that started a write would
 * drop the caret to `<body>`. Each call site refuses the press itself.
 */
export const TRADE_BUTTON = cn(
  "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border",
  "px-3.5 text-sm font-medium whitespace-nowrap text-text",
  "hover:border-accent hover:text-accent",
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
  "aria-disabled:hover:border-border aria-disabled:hover:text-text aria-disabled:active:scale-100",
  PRESS,
  FOCUS,
);

/** The one gold button a surface has: `New trade`, `Finish trade`, `Create trade`. */
export const TRADE_BUTTON_ACCENT = cn(
  TRADE_BUTTON,
  "border-accent text-accent hover:bg-accent hover:text-accent-foreground",
  "aria-disabled:hover:border-accent aria-disabled:hover:bg-transparent",
  "aria-disabled:hover:text-accent",
);

/** A bordered square holding one glyph: More actions, and a side's camera. */
export const TRADE_ICON_BUTTON = cn(
  "grid size-9 shrink-0 place-items-center rounded-md border border-border text-dim",
  "hover:text-text",
  PRESS,
  FOCUS,
);

/** A glyph with no box of its own, inside a row that already has one: Rename, and a line's bin. */
export const TRADE_BARE_BUTTON = cn(
  "grid size-7 shrink-0 place-items-center rounded-md text-dim hover:text-text",
  PRESS,
  FOCUS,
);

/**
 * Money, and anything else that is a figure rather than a word.
 *
 * `tabular-nums` because two totals sit either side of one balance and a quantity step changes
 * both — proportional digits would make the panel twitch by a pixel on every press.
 */
export const FIGURE = "font-mono tabular-nums";

/** A refusal, drawn where it was earned. Always the backend's own sentence after the dash. */
export const REFUSAL = "text-xs leading-snug text-destructive";
