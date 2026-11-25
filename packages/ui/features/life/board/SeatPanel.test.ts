import { describe, expect, it } from "vitest";
import { nearestTurn } from "./SeatPanel";

describe("a panel turning to face another player", () => {
  it("takes the short way round, whatever the seating calls the new angle", () => {
    expect(nearestTurn(180, -90)).toBe(270);
    expect(nearestTurn(-90, 180)).toBe(-180);
    expect(nearestTurn(0, 90)).toBe(90);
    expect(nearestTurn(270, 0)).toBe(360);
  });

  it("stays put for the angle it is already at, however many turns it has made", () => {
    expect(nearestTurn(450, 90)).toBe(450);
    expect(nearestTurn(-270, 90)).toBe(-270);
  });
});
