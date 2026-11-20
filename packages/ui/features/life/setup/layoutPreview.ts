/**
 * The setup's Layout pictures: where each seat goes for a player count and a layout, in a window
 * of a given shape — the approved setup design's `seatSpec` and `seatsFor` (the *Life Tracker —
 * Light App* canvas, 2026-11-20), drawn small.
 *
 * **A copy of the board's plan, on purpose.** The board works out its seats in
 * `../game/seating.ts`, with its menu button and its empty seats besides; the setup needs only the
 * rectangles and their turns, and keeping its own few lines means the picture and the board were
 * built from the same drawing rather than from each other's code. The design is the source both
 * follow — a layout that changes there changes in both.
 */
import type { LifeSetup, Seating } from "../types";

/** A seat as a share of the board (0 to 1 on each axis), and the way its player reads it. */
export interface PreviewSeat {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees: 0 read from the foot, 180 from the head, 90 from the left edge, −90 from the right. */
  rot: number;
}

function r(x: number, y: number, w: number, h: number, rot: number): PreviewSeat {
  return { x, y, w, h, rot };
}

/** The table layouts, drawn for a tall board. Two players have the one layout, face to face. */
export function seatSpec(n: number, layout: "A" | "B"): PreviewSeat[] {
  const A = layout !== "B";
  const t = 1 / 3;
  // One player: on its side (A) or upright (B).
  if (n <= 1) return [r(0, 0, 1, 1, A ? 90 : 0)];
  if (n === 2) return [r(0, 0.5, 1, 0.5, 0), r(0, 0, 1, 0.5, 180)];
  // Three, B: the four-player table along two sides with one seat left empty.
  if (n === 3) {
    return A
      ? [r(0, 0.62, 1, 0.38, 0), r(0, 0, 0.5, 0.62, 90), r(0.5, 0, 0.5, 0.62, -90)]
      : [r(0, 0.5, 0.5, 0.5, 90), r(0, 0, 0.5, 0.5, 90), r(0.5, 0, 0.5, 0.5, -90)];
  }
  if (n === 4) {
    return A
      ? [
          r(0, 0.5, 0.5, 0.5, 90),
          r(0, 0, 0.5, 0.5, 90),
          r(0.5, 0, 0.5, 0.5, -90),
          r(0.5, 0.5, 0.5, 0.5, -90),
        ]
      : [
          r(0, 0.76, 1, 0.24, 0),
          r(0, 0.24, 0.5, 0.52, 90),
          r(0, 0, 1, 0.24, 180),
          r(0.5, 0.24, 0.5, 0.52, -90),
        ];
  }
  if (n === 5) {
    return A
      ? [
          r(0, 0.7, 1, 0.3, 0),
          r(0, 0.35, 0.5, 0.35, 90),
          r(0, 0, 0.5, 0.35, 90),
          r(0.5, 0, 0.5, 0.35, -90),
          r(0.5, 0.35, 0.5, 0.35, -90),
        ]
      : [
          r(0, 0.78, 1, 0.22, 0),
          r(0, 0.5, 0.5, 0.28, 90),
          r(0, 0.22, 0.5, 0.28, 90),
          r(0, 0, 1, 0.22, 180),
          r(0.5, 0.22, 0.5, 0.56, -90),
        ];
  }
  return A
    ? [
        r(0, 2 * t, 0.5, t, 90),
        r(0, t, 0.5, t, 90),
        r(0, 0, 0.5, t, 90),
        r(0.5, 0, 0.5, t, -90),
        r(0.5, t, 0.5, t, -90),
        r(0.5, 2 * t, 0.5, t, -90),
      ]
    : [
        r(0, 0.8, 1, 0.2, 0),
        r(0, 0.5, 0.5, 0.3, 90),
        r(0, 0.2, 0.5, 0.3, 90),
        r(0, 0, 1, 0.2, 180),
        r(0.5, 0.2, 0.5, 0.3, -90),
        r(0.5, 0.5, 0.5, 0.3, -90),
      ];
}

/**
 * The seats the board would draw in a window `wide` by `high`: facing one way, a grid of upright
 * panels in the number of columns that gives the roomiest panels (each wants half as wide again as
 * it is tall), a short last row stretched to the full width; round the table, the layout as drawn
 * for a tall board, turned a quarter turn when the window is wider than it is tall.
 */
export function seatsFor(
  players: number,
  layout: "A" | "B",
  seating: Seating,
  wide: number,
  high: number,
): PreviewSeat[] {
  const n = Math.max(1, players);
  if (seating === "screen") {
    if (n === 1) return [r(0, 0, 1, 1, 0)];
    let best = 1;
    let bestRoom = 0;
    for (let cols = 1; cols <= n; cols++) {
      const room = Math.min(wide / cols / 1.5, high / Math.ceil(n / cols));
      if (room > bestRoom) {
        bestRoom = room;
        best = cols;
      }
    }
    const rows = Math.ceil(n / best);
    const grid: PreviewSeat[] = [];
    for (let k = 0; k < n; k++) {
      const row = Math.floor(k / best);
      const inRow = row === rows - 1 ? n - best * (rows - 1) : best;
      grid.push(r((k % best) / inRow, row / rows, 1 / inRow, 1 / rows, 0));
    }
    return grid;
  }
  const plan = seatSpec(n, layout);
  if (wide <= high) return plan;
  return plan.map((seat) => {
    const rot = seat.rot - 90;
    return r(seat.y, 1 - seat.x - seat.w, seat.h, seat.w, rot <= -180 ? rot + 360 : rot);
  });
}

/** What a layout's picture is called — the design's captions. */
export function layoutCaption(
  setup: Pick<LifeSetup, "players">,
  layout: "A" | "B",
  seating: Seating,
  wide: number,
  high: number,
): string {
  const n = setup.players;
  const A = layout !== "B";
  if (seating === "screen") return n === 1 ? "Upright" : "Grid";
  // One player's two layouts are named for how the number reads in this window.
  if (n === 1) return wide > high ? (A ? "Upright" : "On its side") : A ? "On its side" : "Upright";
  if (n === 2) return "Face to face";
  if (n === 3) return A ? "Two sides and the foot" : "Two and one";
  if (n === 5) return A ? "Two sides and the foot" : "Around the table";
  return A ? "Along two sides" : "Around the table";
}

/**
 * A life total as the board draws it, never more than three digits — 999, then 1.00k, 12.5k,
 * 125k, 1.25m (the owner's rule on the canvas). The board's own is `../game/lifeNumber.ts`, over
 * a 64-bit total; the setup's starting life is at most seven digits, so a `number` holds it.
 */
export function shortLife(n: number): string {
  if (n < 1000) return String(n);
  for (const [unit, suffix] of [
    [1e6, "m"],
    [1e3, "k"],
  ] as const) {
    if (n >= unit) {
      const places = n < unit * 10 ? 2 : n < unit * 100 ? 1 : 0;
      const scale = 10 ** places;
      return (Math.floor(n / (unit / scale)) / scale).toFixed(places) + suffix;
    }
  }
  return String(n);
}

/**
 * The seats' colours, in seat order — the board's own (`../game/gameState.ts`' `SEAT_COLORS`):
 * five mana colours and a pastel purple at their lightness, which the design system has no token
 * for yet. Spelled here for this file's reason above.
 */
export const PREVIEW_COLORS = [
  "var(--color-mana-w)",
  "var(--color-mana-u)",
  "var(--color-mana-b)",
  "var(--color-mana-r)",
  "var(--color-mana-g)",
  "oklch(80% 0.09 300)",
] as const;
