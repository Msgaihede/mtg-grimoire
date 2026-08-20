/**
 * Where the app's one tooltip goes, given the control it belongs to and the room it needs.
 *
 * Pure, and that is the point rather than tidiness: **every rectangle in jsdom is zero**, so a
 * component test of a rendered tooltip would pass over any arithmetic at all — the same reason
 * `shouldFlipUp.ts` gives for being a function rather than a hook. What can go wrong here is a
 * flip, a clamp and an origin, and all three are testable only against numbers.
 *
 * Sibling to `components/menu/panel.ts`'s `placeMenu`, which answers the same question for a
 * point rather than for an element, and keeps the same 8px gutter.
 */

/** Which side of its anchor the panel is asked for. Flipped by {@link placeTooltip} if it must. */
export type TooltipSide = "top" | "bottom" | "left" | "right";

/**
 * The anchor's box. A `DOMRect` satisfies this structurally, and a test can write one out —
 * which `DOMRect` itself, with its `x`, `y` and `toJSON`, makes tedious.
 */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface TooltipSize {
  width: number;
  height: number;
}

export interface TooltipPlacement {
  /** Viewport coordinates, which is what a `fixed` box is laid out against. */
  left: number;
  top: number;
  /** One of the four whole `origin-*` literals below. */
  origin: string;
}

/** The standoff between the control and the panel, in px. */
export const TOOLTIP_GAP = 8;

/** How much of the window edge the panel keeps clear. `MENU_EDGE_GUTTER`'s value, on purpose. */
export const TOOLTIP_EDGE_GUTTER = 8;

const OPPOSITE: Record<TooltipSide, TooltipSide> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/**
 * The transform origin per side, written out whole.
 *
 * **Tailwind scans source text for whole class names**, so `` `origin-${side}` `` emits no rule at
 * all and the panel would grow from its own middle — the one thing this app's anchored-popup rule
 * forbids, because a panel pinned by one edge and growing from another reads as unrelated to the
 * control that produced it. The panel is centred on its anchor, so the edge it is pinned by is the
 * edge facing the anchor: a panel *above* grows from its bottom.
 */
const ORIGIN: Record<TooltipSide, string> = {
  top: "origin-bottom",
  bottom: "origin-top",
  left: "origin-right",
  right: "origin-left",
};

function fits(side: TooltipSide, anchor: AnchorRect, size: TooltipSize, view: TooltipSize): boolean {
  switch (side) {
    case "top":
      return anchor.top - TOOLTIP_GAP - size.height >= TOOLTIP_EDGE_GUTTER;
    case "bottom":
      return anchor.bottom + TOOLTIP_GAP + size.height <= view.height - TOOLTIP_EDGE_GUTTER;
    case "left":
      return anchor.left - TOOLTIP_GAP - size.width >= TOOLTIP_EDGE_GUTTER;
    case "right":
      return anchor.right + TOOLTIP_GAP + size.width <= view.width - TOOLTIP_EDGE_GUTTER;
  }
}

const clamp = (value: number, size: number, viewport: number): number =>
  Math.max(TOOLTIP_EDGE_GUTTER, Math.min(value, viewport - size - TOOLTIP_EDGE_GUTTER));

export function placeTooltip(
  anchor: AnchorRect,
  size: TooltipSize,
  side: TooltipSide,
  view: TooltipSize,
): TooltipPlacement {
  // The preferred side wins ties and wins the case where neither fits: flipping a panel that is
  // clipped either way only moves it, and it should be where the caller said.
  const chosen =
    fits(side, anchor, size, view) || !fits(OPPOSITE[side], anchor, size, view)
      ? side
      : OPPOSITE[side];
  const vertical = chosen === "top" || chosen === "bottom";

  const rawLeft = vertical
    ? anchor.left + anchor.width / 2 - size.width / 2
    : chosen === "left"
      ? anchor.left - TOOLTIP_GAP - size.width
      : anchor.right + TOOLTIP_GAP;
  const rawTop = vertical
    ? chosen === "top"
      ? anchor.top - TOOLTIP_GAP - size.height
      : anchor.bottom + TOOLTIP_GAP
    : anchor.top + anchor.height / 2 - size.height / 2;

  // **Both axes are clamped, including the one the side decides.** On the cross axis that is the
  // ordinary "do not hang off the window" clamp; on the main axis it only ever bites in the case
  // above — a panel that fits neither way — where without it the panel would be placed off-screen
  // rather than merely against the edge. Nothing clips a `fixed` panel, so an overflow there is
  // unreachable rather than ugly.
  return {
    left: Math.round(clamp(rawLeft, size.width, view.width)),
    top: Math.round(clamp(rawTop, size.height, view.height)),
    origin: ORIGIN[chosen],
  };
}
