/**
 * Where the seats go on the board, and which way each player reads theirs.
 *
 * **The board fills whatever it is given** — a phone, a tablet, a browser window dragged to any
 * size — and three things decide how the seats are laid out in it (the design canvas, 2026-11-19):
 *
 * 1. **Round the table or facing one way** (`Seating`). A phone or tablet lying on the table is
 *    read from every side, so each panel is turned to its player. A window on a monitor, or a
 *    device propped up, is read from one side: every panel upright.
 * 2. **Tall or wide.** The table layouts below are drawn for a tall board. On a wide one the same
 *    table is laid on its side — the whole plan a quarter turn — so the long edges of the table
 *    are still the long edges of the screen.
 * 3. **Facing one way, the panels are a plain grid**, in the number of columns that gives the
 *    roomiest panels for the window's shape, a short last row stretched to the full width.
 *
 * Every seat is a share of the board (0 to 1 on each axis) and a turn: 0 read from the foot, 180
 * from the head, 90 from the left edge, −90 from the right. {@link seatBox} turns a share into
 * pixels.
 */
import type { Seating } from "../types";

/** A seat, or an empty one, as a share of the board, and the way its player reads it. */
export interface SeatRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees: 0, 90, −90 or 180. */
  rot: number;
}

/** A layout: the seats in table order, the menu button's centre as a share of the board, and the
 *  seats the layout leaves empty (drawn as dashed outlines, so the table reads as a table). */
export interface SeatPlan {
  seats: SeatRect[];
  hub: { x: number; y: number };
  blanks: SeatRect[];
}

/** The board's inset from its own edges, and the dark gap between two panels, in px. */
export const PAD = 4;
export const GAP = 6;

function r(x: number, y: number, w: number, h: number, rot: number): SeatRect {
  return { x, y, w, h, rot };
}

/**
 * The table layouts, for a tall board `wide` by `high` pixels.
 *
 * Two players have the one layout; every other count has A and B. **One player is A on its side
 * and B upright**, and their menu button keeps its distance from the edge in pixels whatever the
 * board's size — at the player's own edge on its side, at the top upright, out of the way of the
 * chips along the bottom. 35.1 and 37.98 are the design's measurements of where it sits.
 */
export function tablePlan(n: number, layout: "A" | "B", wide: number, high: number): SeatPlan {
  const A = layout !== "B";
  const t = 1 / 3;
  const mid = { x: 0.5, y: 0.5 };
  const plan = (seats: SeatRect[], hub = mid, blanks: SeatRect[] = []): SeatPlan => ({
    seats,
    hub,
    blanks,
  });
  if (n <= 1) {
    return A
      ? plan([r(0, 0, 1, 1, 90)], { x: 35.1 / wide, y: 0.5 })
      : plan([r(0, 0, 1, 1, 0)], { x: 0.5, y: 37.98 / high });
  }
  if (n === 2) return plan([r(0, 0.5, 1, 0.5, 0), r(0, 0, 1, 0.5, 180)]);
  // Three: A is two sides and the foot. B is the four-player table with one seat left empty —
  // two on one side, one on the other.
  if (n === 3) {
    return A
      ? plan([r(0, 0.62, 1, 0.38, 0), r(0, 0, 0.5, 0.62, 90), r(0.5, 0, 0.5, 0.62, -90)], {
          x: 0.5,
          y: 0.31,
        })
      : plan([r(0, 0.5, 0.5, 0.5, 90), r(0, 0, 0.5, 0.5, 90), r(0.5, 0, 0.5, 0.5, -90)], mid, [
          r(0.5, 0.5, 0.5, 0.5, -90),
        ]);
  }
  if (n === 4) {
    return A
      ? plan([
          r(0, 0.5, 0.5, 0.5, 90),
          r(0, 0, 0.5, 0.5, 90),
          r(0.5, 0, 0.5, 0.5, -90),
          r(0.5, 0.5, 0.5, 0.5, -90),
        ])
      : plan([
          r(0, 0.76, 1, 0.24, 0),
          r(0, 0.24, 0.5, 0.52, 90),
          r(0, 0, 1, 0.24, 180),
          r(0.5, 0.24, 0.5, 0.52, -90),
        ]);
  }
  if (n === 5) {
    return A
      ? plan(
          [
            r(0, 0.7, 1, 0.3, 0),
            r(0, 0.35, 0.5, 0.35, 90),
            r(0, 0, 0.5, 0.35, 90),
            r(0.5, 0, 0.5, 0.35, -90),
            r(0.5, 0.35, 0.5, 0.35, -90),
          ],
          { x: 0.5, y: 0.35 },
        )
      : plan([
          r(0, 0.78, 1, 0.22, 0),
          r(0, 0.5, 0.5, 0.28, 90),
          r(0, 0.22, 0.5, 0.28, 90),
          r(0, 0, 1, 0.22, 180),
          r(0.5, 0.22, 0.5, 0.56, -90),
        ]);
  }
  return A
    ? plan([
        r(0, 2 * t, 0.5, t, 90),
        r(0, t, 0.5, t, 90),
        r(0, 0, 0.5, t, 90),
        r(0.5, 0, 0.5, t, -90),
        r(0.5, t, 0.5, t, -90),
        r(0.5, 2 * t, 0.5, t, -90),
      ])
    : plan([
        r(0, 0.8, 1, 0.2, 0),
        r(0, 0.5, 0.5, 0.3, 90),
        r(0, 0.2, 0.5, 0.3, 90),
        r(0, 0, 1, 0.2, 180),
        r(0.5, 0.2, 0.5, 0.3, -90),
        r(0.5, 0.5, 0.5, 0.3, -90),
      ]);
}

/** A tall plan's seat, laid on its side: the quarter turn that puts a tall table on a wide board. */
export function quarterTurn(s: SeatRect): SeatRect {
  const rot = s.rot - 90;
  return r(s.y, 1 - s.x - s.w, s.h, s.w, rot <= -180 ? rot + 360 : rot);
}

/**
 * Facing one way: an upright grid in the number of columns whose panels are roomiest for this
 * window — the room of a panel being the lesser of its height and two-thirds of its width, since
 * a panel reads best a little wider than tall — with a short last row stretched across.
 */
export function screenGrid(n: number, W: number, H: number): SeatRect[] {
  let best = 1;
  let bestRoom = 0;
  for (let cols = 1; cols <= n; cols++) {
    const room = Math.min(W / cols / 1.5, H / Math.ceil(n / cols));
    if (room > bestRoom) {
      bestRoom = room;
      best = cols;
    }
  }
  const rows = Math.ceil(n / best);
  const seats: SeatRect[] = [];
  for (let k = 0; k < n; k++) {
    const row = Math.floor(k / best);
    const inRow = row === rows - 1 ? n - best * (rows - 1) : best;
    seats.push(r((k % best) / inRow, row / rows, 1 / inRow, 1 / rows, 0));
  }
  return seats;
}

/** The plan for a board of `players` seats, `W` by `H` pixels. */
export function seatPlan(
  players: number,
  layout: "A" | "B",
  seating: Seating,
  W: number,
  H: number,
): SeatPlan {
  const wide = W > H;
  if (seating === "screen") {
    // One player, upright: the menu button at the bottom of a wide window and the top of a tall
    // one — the same two places as the table's "on its side" and "upright".
    if (players <= 1) {
      return {
        seats: [r(0, 0, 1, 1, 0)],
        hub: wide ? { x: 0.5, y: 1 - 35.1 / H } : { x: 0.5, y: 37.98 / H },
        blanks: [],
      };
    }
    // The menu button sits on the top edge, in the middle. Round a table it goes where the panels
    // meet, which is each player's far corner; in a grid of upright panels that same spot is some
    // panels' bottom corners, where their chips are. The top corners are kept clear for it.
    return { seats: screenGrid(players, W, H), hub: { x: 0.5, y: 28 / H }, blanks: [] };
  }
  const plan = tablePlan(players, layout, Math.min(W, H), Math.max(W, H));
  if (!wide) return plan;
  return {
    seats: plan.seats.map(quarterTurn),
    blanks: plan.blanks.map(quarterTurn),
    hub: { x: plan.hub.y, y: 1 - plan.hub.x },
  };
}

/**
 * A seat in pixels: its box on the board (`x`, `y`, `w`, `h`, inset by the board's pad and half
 * the gap on each side), and the size of its content as its player reads it (`lw` across, `lh`
 * up) — swapped for a seat turned to a side edge.
 */
export interface SeatBox {
  x: number;
  y: number;
  w: number;
  h: number;
  lw: number;
  lh: number;
  rot: number;
}

export function seatBox(s: SeatRect, W: number, H: number): SeatBox {
  const x = PAD + s.x * (W - 2 * PAD) + GAP / 2;
  const y = PAD + s.y * (H - 2 * PAD) + GAP / 2;
  const w = s.w * (W - 2 * PAD) - GAP;
  const h = s.h * (H - 2 * PAD) - GAP;
  const sideways = s.rot === 90 || s.rot === -90;
  return { x, y, w, h, lw: sideways ? h : w, lh: sideways ? w : h, rot: s.rot };
}

/** What the menu button takes out of a panel, in its own turned frame (see {@link hubRoom}). */
export interface HubRoom {
  lw: number;
  lh: number;
  /** How much of the panel's top to keep clear, or 0. */
  top: number;
  /** How much of its bottom, or 0. */
  bottom: number;
}

/** The menu button's radius, and the air kept between it and a number. */
export const HUB_RADIUS = 24;
const HUB_AIR = 14;

/**
 * Where the menu button lands on a panel. It sits on the gaps between panels, so it bites 21px
 * into each one it touches. On a corner that is out of the number's way; **over the middle of the
 * edge the player faces** (or, with one player, the edge they sit at) it is right where the number
 * or the line under it would be, and this says how much of the panel to keep clear, with 14px of
 * air.
 */
export function hubRoom(s: SeatRect, hub: { x: number; y: number }, W: number, H: number): HubRoom {
  const { x, y, w, h, lw, lh } = seatBox(s, W, H);
  const dx = hub.x * W - (x + w / 2);
  const dy = hub.y * H - (y + h / 2);
  const turn = (s.rot * Math.PI) / 180;
  const across = dx * Math.cos(turn) + dy * Math.sin(turn) + lw / 2;
  const down = -dx * Math.sin(turn) + dy * Math.cos(turn) + lh / 2;
  const band = Math.max(60, lw * 0.22);
  const R = HUB_RADIUS;
  const central = across + R > lw / 2 - band && across - R < lw / 2 + band;
  return {
    lw,
    lh,
    top: central && down + R > 0 && down - R < 60 ? down + R + HUB_AIR : 0,
    bottom: central && down - R < lh && down + R > lh - 60 ? lh - (down - R) + HUB_AIR : 0,
  };
}

/**
 * A drag in a panel's own turned frame: `up` is away from its player whichever edge of the table
 * they sit at, `across` is to their right.
 */
export function inSeatFrame(rot: number, dx: number, dy: number): { up: number; across: number } {
  const turn = (rot * Math.PI) / 180;
  return {
    up: dx * Math.sin(turn) - dy * Math.cos(turn),
    across: dx * Math.cos(turn) + dy * Math.sin(turn),
  };
}
