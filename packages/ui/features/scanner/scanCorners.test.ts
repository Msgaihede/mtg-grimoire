import { describe, expect, it } from "vitest";
import { CORNER_ARM, CORNER_GAP, cornerMarks, type Point } from "./scanCorners";

/** A 290 × 405 card, square to the picture — the design canvas's, at the origin. */
const CARD: Point[] = [
  [100, 100],
  [390, 100],
  [390, 505],
  [100, 505],
];

const close = (p: Point, q: Point) => {
  expect(p[0]).toBeCloseTo(q[0], 6);
  expect(p[1]).toBeCloseTo(q[1], 6);
};

describe("cornerMarks", () => {
  it("lays an L at each corner, outside the card, its arms along the two edges", () => {
    const marks = cornerMarks(CARD);
    expect(marks).toHaveLength(4);
    const gap = 290 * CORNER_GAP;
    const arm = 290 * CORNER_ARM;

    // Top-left: the bend up and left of the corner, one arm down the left edge, one along the top.
    const [topLeft, topRight, bottomRight, bottomLeft] = marks;
    close(topLeft.corner, [100 - gap, 100 - gap]);
    close(topLeft.end, [100 - gap + arm, 100 - gap]);
    close(topLeft.start, [100 - gap, 100 - gap + arm]);
    // The others mirror it, each outside its own corner.
    close(topRight.corner, [390 + gap, 100 - gap]);
    close(bottomRight.corner, [390 + gap, 505 + gap]);
    close(bottomLeft.corner, [100 - gap, 505 + gap]);
    // The canvas's proportions: a 30px arm 9px out on a 290px card, give or take a pixel.
    expect(arm).toBeGreaterThan(30);
    expect(arm).toBeLessThan(36);
    expect(gap).toBeCloseTo(10.15, 1);
  });

  it("scales with the card's shorter side, so a card further off gets smaller marks", () => {
    const half = CARD.map(([x, y]) => [x / 2, y / 2] as Point);
    const [near] = cornerMarks(CARD);
    const [far] = cornerMarks(half);
    expect(Math.hypot(near.end[0] - near.corner[0], near.end[1] - near.corner[1])).toBeCloseTo(
      290 * CORNER_ARM,
      6,
    );
    expect(Math.hypot(far.end[0] - far.corner[0], far.end[1] - far.corner[1])).toBeCloseTo(
      290 * CORNER_ARM * 0.5,
      6,
    );
  });

  it("turns with a tilted card: each arm stays on its edge's line", () => {
    const turn = (Math.PI / 180) * -4;
    const tilted = CARD.map(
      ([x, y]) =>
        [x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn)] as Point,
    );
    const [topLeft] = cornerMarks(tilted);
    const along = [tilted[1][0] - tilted[0][0], tilted[1][1] - tilted[0][1]];
    const arm = [topLeft.end[0] - topLeft.corner[0], topLeft.end[1] - topLeft.corner[1]];
    // Parallel to the top edge: the cross product is zero.
    expect(along[0] * arm[1] - along[1] * arm[0]).toBeCloseTo(0, 6);
  });

  it("draws nothing for a quad that is not four corners with room between them", () => {
    expect(cornerMarks([])).toEqual([]);
    expect(cornerMarks(CARD.slice(0, 3))).toEqual([]);
    expect(cornerMarks([CARD[0], CARD[0], CARD[2], CARD[3]])).toEqual([]);
    expect(
      cornerMarks([
        [5, 5],
        [5, 5],
        [5, 5],
        [5, 5],
      ]),
    ).toEqual([]);
  });
});
