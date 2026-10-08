import type { Box, Placement, Size } from "./types";

/**
 * The air between the trigger and its panel, in px.
 *
 * 4px — `SetCombobox`'s `mt-1`, which is what this component's panel replaced. Written as a number
 * rather than a class because the panel's offset is computed and set inline; a Tailwind margin
 * would be added *on top of* a measured `top` and put the panel 4px lower than the arithmetic said.
 */
export const PANEL_GAP = 4;

/**
 * How close to the window's edge a panel may come, in px.
 *
 * Nothing in this app clips a popup, so a panel that overflows does not get a scrollbar — it
 * scrolls the whole app sideways the moment anything calls `scrollIntoView` on it. The gutter is
 * what keeps the flip from landing exactly on the edge it was avoiding.
 */
export const VIEWPORT_GUTTER = 8;

export type PlaceInput = {
  /** The trigger, in viewport coordinates. */
  trigger: Box;
  /**
   * The panel's **layout** size — `offsetWidth`/`offsetHeight`, never a rect.
   *
   * `popup` holds the panel at `scale: 0.96` for the length of its entry tween, so a
   * `getBoundingClientRect()` taken on the mount frame is 4% short in both axes. The same
   * confusion cost `AnchoredPopup` a session: measured in the shipped window on 2026-08-22,
   * that scale dropped its scroller's `scrollTop` maximum from 257 to 246 and no scroll margin
   * could recover it. `offsetHeight` is the layout box and no transform touches it.
   */
  panel: Size;
  /**
   * `document.documentElement.clientWidth` / `clientHeight`, **never** `innerWidth`/`innerHeight`.
   *
   * The window's inner size includes the scrollbar, so a panel flipped against it is flipped to
   * a position underneath one. `menu/panel.ts` states the rule; this is its third instance.
   */
  viewport: Size;
  /**
   * The caller's first guess at which edge the panel is pinned by, which the arithmetic below may
   * still overrule.
   *
   * It is a guess worth having because the caller often knows the layout better than one
   * measurement does: the two search-shaped set pickers sit at the **right end** of a wrapping
   * filter row and pass `"end"`, and `AllPrintingsDialog` puts one second in its row and passes
   * `"start"` because there is nothing to the left to open back across.
   */
  align: "start" | "end";
};

/**
 * Where a dropdown panel goes.
 *
 * Pure, and separated from the hook for the reason `menu/panel.ts` is: jsdom measures every
 * rectangle as zero, so the *arithmetic* is the only part of the placement a test can ever reach.
 * Whether the numbers this returns put the panel where a reader can see it is a question only the
 * shipped window answers.
 *
 * **The corner it is pinned by is the corner it grows from** — that is this app's standing rule for
 * an anchored popup, and it is why the two flags come back rather than being folded into the
 * numbers. A panel that grew from its own middle reads as unrelated to the control that opened it.
 */
export function placeDropdown({ trigger, panel, viewport, align }: PlaceInput): Placement {
  // Horizontal. `start` pins the panel's left edge to the trigger's left; `end` pins its right
  // edge to the trigger's right. Whichever the caller asked for, a panel that would then run past
  // the far gutter takes the other — a flip is cheaper to read than a panel half off the window.
  const startLeft = trigger.left;
  const endLeft = trigger.right - panel.width;
  const startFits = startLeft + panel.width <= viewport.width - VIEWPORT_GUTTER;
  const endFits = endLeft >= VIEWPORT_GUTTER;
  const flipX = align === "end" ? endFits || !startFits : !startFits && endFits;
  // Clamped last and in both directions: a panel wider than the window has no correct edge, and
  // the left one is the one a reader's eye starts at.
  const left = Math.max(
    VIEWPORT_GUTTER,
    Math.min(flipX ? endLeft : startLeft, viewport.width - VIEWPORT_GUTTER - panel.width),
  );

  // Vertical. Below by default. Above only when below genuinely does not fit *and* above has more
  // room — a panel taller than either side is drawn below, where a reader is already looking, and
  // its own scroller takes the strain.
  const below = trigger.bottom + PANEL_GAP;
  const above = trigger.top - PANEL_GAP - panel.height;
  const belowFits = below + panel.height <= viewport.height - VIEWPORT_GUTTER;
  const roomAbove = trigger.top;
  const roomBelow = viewport.height - trigger.bottom;
  const flipY = !belowFits && roomAbove > roomBelow;
  const top = Math.max(VIEWPORT_GUTTER, flipY ? above : below);

  return { left, top, flipX, flipY };
}
