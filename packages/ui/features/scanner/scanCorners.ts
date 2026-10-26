/**
 * The four gold corners the reader sees over a card the scanner has found (the scanner redesign,
 * 2026-10-25) — where the old overlay traced the whole quad in green. Pure geometry, so the shape is
 * tested here and `Overlay` only strokes it.
 *
 * **Each mark is an L at one corner of the card, standing a little outside it**, its two arms laid
 * along the card's two edges from that corner and meeting square — no rounded bend (the owner's
 * call, 2026-10-26): the design canvas's brackets — 30px arms 9px out on a 290px card, 22px 6px out
 * on a 150px one — as fractions of the card's shorter side, so they hold on any camera and any
 * distance. **Along the edges, not the screen's axes**: the quad is the card as
 * the camera sees it, tilted and in perspective, and an L squared to the screen would sit off a
 * card turned a few degrees.
 */

/** A point on the picture, in whatever pixels the quad is in. */
export type Point = readonly [number, number];

/** An arm's length, as a fraction of the card's shorter side. */
export const CORNER_ARM = 0.12;
/** How far outside the card a mark stands, along each edge's outward normal. */
export const CORNER_GAP = 0.035;

/** One L: from the end of one arm, to the square bend at `corner`, to the end of the other. */
export interface CornerMark {
  start: Point;
  corner: Point;
  end: Point;
}

/**
 * The four marks for a quad, in the quad's own order — `[]` for anything that is not four corners
 * with room between them (a degenerate quad has no edges to lay an arm along).
 *
 * The bend stands `CORNER_GAP` out from the card's corner along both edges' outward normals: for a
 * corner whose edges run along unit vectors `a` and `b`, that is the corner less `gap·(a + b)` —
 * exactly the canvas's `left: -9px; top: -9px` on a square card, and the same offset turned with
 * the edges on a tilted one.
 */
export function cornerMarks(quad: readonly Point[]): CornerMark[] {
  if (quad.length !== 4) return [];
  const width = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const height = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  const side = Math.min(width, height);
  if (!(side > 0)) return [];
  const arm = side * CORNER_ARM;
  const gap = side * CORNER_GAP;

  const marks: CornerMark[] = [];
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const a = unit(p, quad[(i + 1) % 4]);
    const b = unit(p, quad[(i + 3) % 4]);
    if (a === null || b === null) return [];
    const corner: Point = [p[0] - gap * (a[0] + b[0]), p[1] - gap * (a[1] + b[1])];
    marks.push({
      start: [corner[0] + arm * b[0], corner[1] + arm * b[1]],
      corner,
      end: [corner[0] + arm * a[0], corner[1] + arm * a[1]],
    });
  }
  return marks;
}

function dist(p: Point, q: Point): number {
  return Math.hypot(q[0] - p[0], q[1] - p[1]);
}

/** The unit vector from `p` towards `q`, or `null` where the two are one point. */
function unit(p: Point, q: Point): Point | null {
  const d = dist(p, q);
  return d > 0 ? [(q[0] - p[0]) / d, (q[1] - p[1]) / d] : null;
}
