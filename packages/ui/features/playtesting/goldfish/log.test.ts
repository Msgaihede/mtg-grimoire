import { describe, expect, it } from "vitest";
import { LOG_LIMIT, appendLog, lifeSentence, linesFor, sentence } from "./log";

describe("sentence", () => {
  it("says a draw, a land drop and a cast the way the artboard's log does", () => {
    expect(sentence({ type: "moved", name: "Forest", from: "libraryTop", to: "hand" })).toBe(
      "Drew Forest",
    );
    expect(sentence({ type: "played", name: "Boseiju, Who Endures" })).toBe(
      "Played Boseiju, Who Endures",
    );
    expect(sentence({ type: "cast", name: "Old Gnawbone", from: "hand" })).toBe(
      "Cast Old Gnawbone",
    );
  });

  it("says when a card was put down by hand rather than paid for", () => {
    expect(sentence({ type: "put", name: "Sol Ring", from: "hand", to: "battlefield" })).toBe(
      "Put Sol Ring onto the battlefield",
    );
    expect(
      sentence({ type: "put", name: "Swords to Plowshares", from: "hand", to: "graveyard" }),
    ).toBe("Cast Swords to Plowshares · not paid for");
    expect(
      sentence({ type: "put", name: "Sol Ring", from: "battlefield", to: "libraryBottom" }),
    ).toBe("Sol Ring to the bottom of the library");
  });

  it("says the mulligan and the keep", () => {
    expect(sentence({ type: "mulliganed", mulligans: 2 })).toBe("Mulligan 2 · drew seven");
    expect(sentence({ type: "kept", size: 6, bottomed: 1 })).toBe(
      "Kept six · put one on the bottom",
    );
    expect(sentence({ type: "kept", size: 7, bottomed: 0 })).toBe("Kept seven");
  });
});

describe("lifeSentence", () => {
  it("says damage, gain and a death", () => {
    expect(lifeSentence("opponent", 19, 12)).toBe("The opponent took 7, down to 12");
    expect(lifeSentence("you", 40, 43)).toBe("You gained 3, up to 43");
    expect(lifeSentence("opponent", 4, 0)).toBe("The opponent is dead");
  });
});

describe("linesFor", () => {
  it("puts the newest fact first and stamps the turn the action ended on", () => {
    const lines = linesFor(
      [
        { type: "turnBegan", turn: 2 },
        { type: "moved", name: "Forest", from: "libraryTop", to: "hand" },
      ],
      2,
    );
    expect(lines).toEqual([
      { turn: 2, text: "Drew Forest" },
      { turn: 2, text: "Untapped · turn 2 begins" },
    ]);
  });

  it("keeps the log to its limit", () => {
    const many = Array.from({ length: LOG_LIMIT }, (_, i) => ({ turn: 1, text: String(i) }));
    const log = appendLog(many, [{ turn: 2, text: "new" }]);
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[0].text).toBe("new");
  });
});
