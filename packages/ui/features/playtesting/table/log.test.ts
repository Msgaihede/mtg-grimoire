import { describe, expect, it } from "vitest";
import { LOG_LIMIT, appendLog, byTurn, lifeSentence } from "./log";

// The sentences for every fact are `../play/log.ts`'s, and tested there; this is the log's
// shared plumbing.

describe("lifeSentence", () => {
  it("says damage, gain and a death", () => {
    expect(lifeSentence("opponent", 19, 12)).toBe("The opponent took 7, down to 12");
    expect(lifeSentence("you", 40, 43)).toBe("You gained 3, up to 43");
    expect(lifeSentence("opponent", 4, 0)).toBe("The opponent is dead");
    expect(lifeSentence("opponent", 40, 30, "Opponent 3")).toBe("Opponent 3 took 10, down to 30");
  });
});

describe("appendLog", () => {
  it("puts the new lines on top and keeps the log to its limit", () => {
    const many = Array.from({ length: LOG_LIMIT }, (_, i) => ({ turn: 1, text: String(i) }));
    const log = appendLog(many, [{ turn: 2, text: "new" }]);
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[0].text).toBe("new");
  });
});

describe("byTurn", () => {
  it("groups each turn's lines, newest turn first, and keeps their order", () => {
    const turns = byTurn([
      { turn: 3, text: "Drew Three Tree City" },
      { turn: 3, text: "Your turn 3 begins" },
      { turn: 2, text: "The opponent's turn 2 begins" },
      { turn: 1, text: "Cast Ponder" },
      { turn: 0, text: "Kept seven" },
      { turn: 0, text: "Shuffled and drew seven" },
    ]);
    expect(turns.map((t) => [t.turn, t.lines.map((l) => l.text)])).toEqual([
      [3, ["Drew Three Tree City", "Your turn 3 begins"]],
      [2, ["The opponent's turn 2 begins"]],
      [1, ["Cast Ponder"]],
      [0, ["Kept seven", "Shuffled and drew seven"]],
    ]);
    expect(turns.map((t) => t.from)).toEqual([0, 2, 3, 4]);
  });
});
