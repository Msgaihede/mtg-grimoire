import { describe, expect, it } from "vitest";
import { CHAR, INK_HIGH, INK_TOP, UNDER, commonSize, placeNumber, underHigh } from "./fit";
import { HUB_SIDE_KEEP, facingSeat, hubRoom, seatBox, seatPlan } from "./seating";

describe("a number with its − and + under it", () => {
  // Four players' B table on a phone, its foot's commander damage open: each long side's panel
  // turns a quarter to face the foot, and is narrow for them.
  const table = seatPlan(4, "B", "table", 390, 844);
  const plan = facingSeat(table, 0);
  const rect = plan.seats[1];
  const { lw, lh } = seatBox(rect, 390, 844);
  const question = {
    lw,
    lh,
    chars: 2,
    common: commonSize(table, 390, 844),
    keep: hubRoom(rect, plan.hub, 390, 844),
    solo: false,
    commanderBand: true,
  };
  const beside = placeNumber(question);
  const under = placeNumber({ ...question, under: true });

  it("has the panel's width, short of the menu button at either side", () => {
    expect(lw).toBeLessThan(lh);
    // Between a − and a + it would be a fraction of the size.
    expect(under.size).toBeGreaterThan(2 * beside.size);
    expect(under.size).toBeLessThanOrEqual(question.common);
    expect(CHAR * 2 * under.size).toBeLessThanOrEqual(lw - 2 * HUB_SIDE_KEEP);
    expect(under.lineWidth).toBe(Math.round(lw - 2 * HUB_SIDE_KEEP));
  });

  it("sits above the − and +, with the line under it", () => {
    const inkTop = under.top + INK_TOP * under.size;
    const lineFoot = inkTop + INK_HIGH * under.size + UNDER + underHigh(lw, lh);
    expect(inkTop).toBeGreaterThanOrEqual(8);
    expect(lineFoot).toBeLessThanOrEqual(lh - under.glyphLift - 52);
    expect(under.glyphLift).toBeGreaterThanOrEqual(6);
  });

  it("leaves every other panel's number as it was", () => {
    expect(beside.glyphLift).toBe(0);
    expect(beside.lineWidth).toBe(Math.round(lw - 150));
  });
});
