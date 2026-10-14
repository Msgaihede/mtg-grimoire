import { describe, expect, it } from "vitest";
import { NO_PICKS, aimAttacker, toggleAttacker } from "./combat";
import { arrowPath, combatArrows, edgePoint } from "./arrows";
import { attackStep, combatArrowsView, fourPlayerAttack, fourPlayerCombat } from "./fixtures";

const box = (left: number, top: number, width = 100, height = 140) => ({
  left,
  top,
  width,
  height,
});

describe("edgePoint", () => {
  it("leaves a box where the line to the target crosses its edge", () => {
    // Straight up from a 100 × 140 box at the origin: the top edge's middle.
    expect(edgePoint(box(0, 0), { x: 50, y: -500 })).toEqual({ x: 50, y: 0 });
    // Straight right: the right edge's middle.
    expect(edgePoint(box(0, 0), { x: 900, y: 70 })).toEqual({ x: 100, y: 70 });
    // A diagonal crosses whichever edge it reaches first.
    const p = edgePoint(box(0, 0), { x: 150, y: 170 });
    expect(p.x).toBe(100);
    expect(p.y).toBeCloseTo(120);
  });

  it("stays at the centre for a point at the centre", () => {
    expect(edgePoint(box(0, 0), { x: 50, y: 70 })).toEqual({ x: 50, y: 70 });
  });
});

describe("arrowPath", () => {
  it("runs from one box's edge to the other's, short of each by the gap", () => {
    const path = arrowPath(box(0, 400), box(0, 0), { bend: 0, gap: 4 });
    // From the bottom box's top edge up to the top box's bottom edge, 4 px short of each.
    expect(path.start).toEqual({ x: 50, y: 396 });
    expect(path.end).toEqual({ x: 50, y: 144 });
    expect(path.d).toBe("M 50 396 Q 50 270 50 144");
  });

  it("pulls the curve sideways by the bend", () => {
    const path = arrowPath(box(0, 400), box(0, 0), { bend: 0.1, gap: 0 });
    // A 260 px arrow going up, pulled 26 px toward +x.
    expect(path.control.x).toBeCloseTo(76);
    expect(path.control.y).toBeCloseTo(270);
  });
});

describe("combatArrows", () => {
  it("draws each attack at its target and each block at its attacker", () => {
    const { view, goyf, delver, jace, ragavan } = combatArrowsView();
    expect(combatArrows(view, NO_PICKS)).toEqual([
      { key: `attack-${goyf.id}`, from: { card: goyf.id }, to: { plate: "opponent" }, tone: "you" },
      { key: `attack-${delver.id}`, from: { card: delver.id }, to: { card: jace.id }, tone: "you" },
      {
        key: `block-${ragavan.id}-${delver.id}`,
        from: { card: ragavan.id },
        to: { card: delver.id },
        tone: "block",
      },
    ]);
  });

  it("draws the reader's picks while they declare", () => {
    const { view, elves } = attackStep();
    expect(combatArrows(view, toggleAttacker(NO_PICKS, view, elves.id))).toEqual([
      {
        key: `attack-${elves.id}`,
        from: { card: elves.id },
        to: { plate: "opponent" },
        tone: "you",
      },
    ]);
  });

  it("draws an attack at the very player it names, an AI's on another AI's too", () => {
    const { view, lurrus } = fourPlayerCombat();
    expect(combatArrows(view, NO_PICKS)).toEqual([
      {
        key: `attack-${lurrus.id}`,
        from: { card: lurrus.id },
        to: { plate: "opponent" },
        tone: "opponent",
      },
    ]);
    const attack = fourPlayerAttack();
    const picks = aimAttacker(
      toggleAttacker(NO_PICKS, attack.view, attack.elves.id),
      attack.view,
      "opponent2",
    );
    expect(combatArrows(attack.view, picks)[0].to).toEqual({ plate: "opponent2" });
  });
});
