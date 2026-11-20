import { describe, expect, it } from "vitest";
import {
  facingSeat,
  hubRoom,
  inSeatFrame,
  quarterApart,
  quarterTurn,
  screenGrid,
  seatBox,
  seatPlan,
  tablePlan,
  type SeatRect,
} from "./seating";

/** Every seat's share of the board, summed: a layout covers its board exactly once. */
const area = (seats: SeatRect[]) => seats.reduce((sum, s) => sum + s.w * s.h, 0);

describe("the table layouts", () => {
  it("cover the board for every count and layout", () => {
    for (let n = 1; n <= 6; n++) {
      for (const layout of ["A", "B"] as const) {
        const plan = tablePlan(n, layout, 390, 844);
        expect(plan.seats).toHaveLength(n);
        expect(area(plan.seats) + area(plan.blanks)).toBeCloseTo(1, 6);
      }
    }
  });

  it("seats two face to face", () => {
    expect(tablePlan(2, "A", 390, 844).seats.map((s) => s.rot)).toEqual([0, 180]);
    // Two players have the one layout.
    expect(tablePlan(2, "B", 390, 844)).toEqual(tablePlan(2, "A", 390, 844));
  });

  it("leaves the fourth seat of three players' B table empty, drawn as a blank", () => {
    const plan = tablePlan(3, "B", 390, 844);
    expect(plan.seats).toHaveLength(3);
    expect(plan.blanks).toEqual([{ x: 0.5, y: 0.5, w: 0.5, h: 0.5, rot: -90 }]);
    expect(tablePlan(3, "A", 390, 844).blanks).toEqual([]);
  });

  it("lays one player on their side in A and upright in B, the menu button a set distance in", () => {
    const side = tablePlan(1, "A", 390, 844);
    expect(side.seats[0].rot).toBe(90);
    expect(side.hub.x * 390).toBeCloseTo(35.1);
    const upright = tablePlan(1, "B", 390, 844);
    expect(upright.seats[0].rot).toBe(0);
    expect(upright.hub.y * 844).toBeCloseTo(37.98);
  });
});

describe("a wide board", () => {
  it("takes the tall table a quarter turn", () => {
    // The foot of a tall table is the right edge of a wide one, read from the right.
    expect(quarterTurn({ x: 0, y: 0.5, w: 1, h: 0.5, rot: 0 })).toEqual({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 1,
      rot: -90,
    });
    // A seat read from the head turns to be read from the right, not past −180.
    expect(quarterTurn({ x: 0, y: 0, w: 1, h: 0.5, rot: 180 }).rot).toBe(90);
    expect(quarterTurn({ x: 0, y: 0, w: 0.5, h: 0.5, rot: -90 }).rot).toBe(180);
  });

  it("turns the whole plan, and its menu button with it", () => {
    const tall = tablePlan(4, "A", 390, 844);
    const wide = seatPlan(4, "A", "table", 844, 390);
    expect(wide.seats).toEqual(tall.seats.map(quarterTurn));
    expect(wide.hub).toEqual({ x: tall.hub.y, y: 1 - tall.hub.x });
    // The same table, measured by its own short and long sides.
    expect(seatPlan(4, "A", "table", 390, 844)).toEqual(tall);
  });

  it("turns three players' blank seat too", () => {
    const wide = seatPlan(3, "B", "table", 844, 390);
    expect(wide.blanks).toEqual([quarterTurn({ x: 0.5, y: 0.5, w: 0.5, h: 0.5, rot: -90 })]);
  });
});

describe("facing a screen", () => {
  const columns = (seats: SeatRect[]) =>
    new Set(seats.filter((s) => s.y === 0).map((s) => s.x)).size;

  it("fits the grid to the window's shape", () => {
    // A desktop window: two by two; a letterbox: four across in one row.
    expect(columns(screenGrid(4, 1600, 900))).toBe(2);
    expect(columns(screenGrid(4, 2400, 500))).toBe(4);
    // A tall window: one column.
    expect(columns(screenGrid(4, 600, 1600))).toBe(1);
    // Six in a wide window: three columns of two.
    expect(columns(screenGrid(6, 1800, 900))).toBe(3);
  });

  it("stretches a short last row to the full width", () => {
    const seats = screenGrid(5, 1300, 900);
    const last = seats.filter((s) => s.y === Math.max(...seats.map((t) => t.y)));
    expect(last.reduce((sum, s) => sum + s.w, 0)).toBeCloseTo(1);
    expect(seats.every((s) => s.rot === 0)).toBe(true);
    expect(area(seats)).toBeCloseTo(1);
  });

  it("puts the menu button at the top, and one player's at the far edge", () => {
    expect(seatPlan(4, "A", "screen", 1600, 900).hub).toEqual({ x: 0.5, y: 28 / 900 });
    expect(seatPlan(1, "A", "screen", 1600, 900).hub.y).toBeCloseTo(1 - 35.1 / 900);
    expect(seatPlan(1, "A", "screen", 600, 900).hub.y).toBeCloseTo(37.98 / 900);
  });
});

describe("a seat in pixels", () => {
  it("insets the board and halves the gap, and swaps a side seat's frame", () => {
    const box = seatBox({ x: 0, y: 0, w: 0.5, h: 0.5, rot: 90 }, 400, 800);
    expect(box).toMatchObject({ x: 7, y: 7, w: 190, h: 390, lw: 390, lh: 190 });
  });

  it("keeps the number clear of a menu button over the middle of the edge a player faces", () => {
    // Two players: the button sits on the line between them, over each one's top edge.
    const plan = tablePlan(2, "A", 390, 844);
    const near = hubRoom(plan.seats[0], plan.hub, 390, 844);
    expect(near.top).toBeGreaterThan(0);
    expect(near.bottom).toBe(0);
    // Four players: the button is on every seat's corner, out of every number's way.
    const four = tablePlan(4, "A", 390, 844);
    for (const s of four.seats) {
      expect(hubRoom(s, four.hub, 390, 844)).toMatchObject({ top: 0, bottom: 0 });
    }
  });

  it("reads a drag in the seat's own frame", () => {
    // Up the screen is up for the foot of the table, and down for its head.
    expect(inSeatFrame(0, 0, -50).up).toBeCloseTo(50);
    expect(inSeatFrame(180, 0, -50).up).toBeCloseTo(-50);
    // A seat at the left edge reads rightward as up.
    expect(inSeatFrame(90, 50, 0).up).toBeCloseTo(50);
  });
});

describe("while a seat's commander damage is open", () => {
  const place = ({ x, y, w, h }: SeatRect) => ({ x, y, w, h });

  it("turns every other seat to face that seat's player", () => {
    // Four round the table, two to a side: the far side turns a half to face the counted player,
    // and the seat beside them already does.
    const plan = tablePlan(4, "A", 390, 844);
    expect(plan.seats.map((s) => s.rot)).toEqual([90, 90, -90, -90]);
    expect(facingSeat(plan, 0).seats.map((s) => s.rot)).toEqual([90, 90, 90, 90]);
    expect(facingSeat(plan, 3).seats.map((s) => s.rot)).toEqual([-90, -90, -90, -90]);
    // A wide board's B table, its head, foot and sides alike.
    const wide = seatPlan(4, "B", "table", 844, 390);
    expect(new Set(facingSeat(wide, 1).seats.map((s) => s.rot))).toEqual(
      new Set([wide.seats[1].rot]),
    );
  });

  it("moves nothing but the turn", () => {
    const plan = seatPlan(5, "B", "table", 390, 844);
    const facing = facingSeat(plan, 2);
    expect(facing.seats.map(place)).toEqual(plan.seats.map(place));
    expect(facing.hub).toEqual(plan.hub);
    expect(facing.blanks).toEqual(plan.blanks);
    // No such seat (one player's opponents have none): the plan as it is.
    expect(facingSeat(plan, 7)).toBe(plan);
  });

  it("tells a seat turned a quarter from one turned a half", () => {
    expect(quarterApart(0, 90)).toBe(true);
    expect(quarterApart(180, -90)).toBe(true);
    expect(quarterApart(-90, 0)).toBe(true);
    expect(quarterApart(90, -90)).toBe(false);
    expect(quarterApart(0, 180)).toBe(false);
    expect(quarterApart(90, 90)).toBe(false);
  });
});
