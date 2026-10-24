import { describe, expect, it } from "vitest";
import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "../fixtures";
import { NO_FILTERS } from "./readerText";
import {
  addLabel,
  addRefusal,
  commitPlan,
  DECK_NEEDS_FINISHES,
  deckRefusal,
  EMPTY_REASON,
  NO_FINISHED_ROWS,
  UNPICKED_REASON,
} from "./tray";

/**
 * The words both Scanner surfaces say — the desktop in a tooltip, the phone on the page. They were `TrayPanel`'s, `ScanBar`'s and the desktop page's
 * own until the phone page needed the same ones (light app step 7.6).
 */

const RESOLVED = TRAY_ROWS.filter((row) => row.choices.length === 0);

describe("why Add is out of reach", () => {
  it("is nothing for a tray it can file", () => {
    expect(addRefusal(RESOLVED)).toBeNull();
    // A row waiting on a finish does not stop an Add: it is left behind, out loud.
    expect(addRefusal([NEEDS_A_FINISH_ROW, ...RESOLVED])).toBeNull();
  });

  it("says an empty tray is empty", () => {
    expect(addRefusal([])).toBe(EMPTY_REASON);
  });

  it("says a printing has to be picked, before it says anything about finishes", () => {
    expect(addRefusal(TRAY_ROWS)).toBe(UNPICKED_REASON);
    expect(addRefusal([TRAY_ROWS[0], NEEDS_A_FINISH_ROW])).toBe(UNPICKED_REASON);
  });

  it("says a tray of nothing but unknown finishes needs one", () => {
    expect(addRefusal([NEEDS_A_FINISH_ROW])).toBe(NO_FINISHED_ROWS);
  });

  it("refuses exactly where the commit's plan throws", () => {
    for (const rows of [
      RESOLVED,
      [NEEDS_A_FINISH_ROW, ...RESOLVED],
      TRAY_ROWS,
      [NEEDS_A_FINISH_ROW],
    ]) {
      const refusal = addRefusal(rows);
      if (refusal === null) expect(() => commitPlan(rows, "NONE")).not.toThrow();
      else expect(() => commitPlan(rows, "NONE")).toThrow();
    }
    // An empty tray is the one the plan does not throw on — it files nothing — and the surfaces
    // refuse the press before it gets there.
    expect(commitPlan([], "NONE").items).toEqual([]);
  });
});

describe("why Create deck is out of reach", () => {
  it("is everything that stops an Add", () => {
    expect(deckRefusal([])).toBe(EMPTY_REASON);
    expect(deckRefusal(TRAY_ROWS)).toBe(UNPICKED_REASON);
    expect(deckRefusal([NEEDS_A_FINISH_ROW])).toBe(NO_FINISHED_ROWS);
  });

  it("is also any row still waiting on a finish, which an Add would only leave behind", () => {
    expect(deckRefusal([NEEDS_A_FINISH_ROW, ...RESOLVED])).toBe(DECK_NEEDS_FINISHES);
    expect(deckRefusal(RESOLVED)).toBeNull();
  });
});

describe("the Add button's words", () => {
  it("says the copies it files, and the ones it leaves", () => {
    expect(addLabel(8, 0)).toBe("Add 8 to collection");
    expect(addLabel(8, 2)).toBe("Add 8 to collection · 2 need a finish");
    expect(addLabel(1, 1)).toBe("Add 1 to collection · 1 needs a finish");
  });
});

describe("the filters", () => {
  it("clear to the unrestricted filter", () => {
    expect(NO_FILTERS).toEqual({
      sets: [],
      released_from: null,
      released_to: null,
      exclude_promos: false,
    });
  });
});
