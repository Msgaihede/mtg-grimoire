import { describe, expect, it } from "vitest";
import { LOG_LIMIT, appendLog, byTurn, kindOf, lifeSentence, linesFor, sentence } from "./log";

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

describe("the opponent's side", () => {
  it("says the goldfish's turn", () => {
    expect(sentence({ type: "opponentTurn", drew: 1, discarded: 0 })).toBe(
      "The opponent drew a card and passed",
    );
    expect(sentence({ type: "opponentTurn", drew: 2, discarded: 1 })).toBe(
      "The opponent drew two cards, discarded one and passed",
    );
    expect(sentence({ type: "opponentTurn", drew: 0, discarded: 0 })).toBe(
      "The opponent passed the turn",
    );
  });

  it("says a life total the rules changed, either seat's", () => {
    expect(sentence({ type: "life", seat: "opponent", amount: -3, total: 37 })).toBe(
      "The opponent took 3, down to 37",
    );
    expect(sentence({ type: "life", seat: "you", amount: 2, total: 42 })).toBe(
      "You gained 2, up to 42",
    );
    expect(sentence({ type: "life", seat: "opponent", amount: 0, total: 40 })).toBeNull();
    expect(kindOf({ type: "life", seat: "you", amount: 2, total: 42 })).toBe("life");
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
      { turn: 2, text: "Drew Forest", kind: "draw" },
      { turn: 2, text: "Untapped · turn 2 begins", kind: "turn" },
    ]);
  });

  it("files the goldfish's turn under the reader's turn it followed", () => {
    const lines = linesFor(
      [
        { type: "opponentTurn", drew: 1, discarded: 1 },
        { type: "turnBegan", turn: 3 },
        { type: "moved", name: "Forest", from: "libraryTop", to: "hand" },
      ],
      3,
    );
    expect(lines).toEqual([
      { turn: 3, text: "Drew Forest", kind: "draw" },
      { turn: 3, text: "Untapped · turn 3 begins", kind: "turn" },
      { turn: 2, text: "The opponent drew a card, discarded one and passed", kind: "turn" },
    ]);
  });

  it("keeps the log to its limit", () => {
    const many = Array.from({ length: LOG_LIMIT }, (_, i) => ({ turn: 1, text: String(i) }));
    const log = appendLog(many, [{ turn: 2, text: "new" }]);
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[0].text).toBe("new");
  });
});

describe("kindOf", () => {
  it("tells a draw from any other move, and a placed spell from a placed permanent", () => {
    expect(kindOf({ type: "moved", name: "Forest", from: "libraryTop", to: "hand" })).toBe("draw");
    expect(kindOf({ type: "moved", name: "Forest", from: "hand", to: "graveyard" })).toBe("move");
    expect(kindOf({ type: "put", name: "Ponder", from: "hand", to: "graveyard" })).toBe("cast");
    expect(kindOf({ type: "put", name: "Sol Ring", from: "hand", to: "battlefield" })).toBe("move");
  });
});

describe("byTurn", () => {
  it("groups each turn's lines, newest turn first, and keeps their order", () => {
    const turns = byTurn([
      { turn: 3, text: "Drew Three Tree City" },
      { turn: 3, text: "Untapped · turn 3 begins" },
      { turn: 2, text: "Cast Ponder" },
      { turn: 0, text: "Kept seven" },
      { turn: 0, text: "Shuffled and drew seven" },
    ]);
    expect(turns.map((t) => [t.turn, t.lines.map((l) => l.text)])).toEqual([
      [3, ["Drew Three Tree City", "Untapped · turn 3 begins"]],
      [2, ["Cast Ponder"]],
      [0, ["Kept seven", "Shuffled and drew seven"]],
    ]);
  });
});
