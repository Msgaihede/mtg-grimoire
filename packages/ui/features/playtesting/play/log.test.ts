import { describe, expect, it } from "vitest";
import type { PlaytestHappened } from "@/lib/ipc";
import { listed, playtestKind, playtestLines, playtestSentence } from "./log";

/** Every variant of the wire, each with the sentence and the glyph it makes. */
const CASES: [PlaytestHappened, string | null, string][] = [
  [{ type: "mulliganed", mulligans: 1 }, "Mulligan 1 · drew seven", "deal"],
  [{ type: "kept", size: 6, bottomed: 1 }, "Kept six · put one on the bottom", "deal"],
  [{ type: "turnBegan", turn: 5, seat: "you" }, "Your turn 5 begins", "turn"],
  [{ type: "turnBegan", turn: 6, seat: "opponent" }, "The opponent's turn 6 begins", "turn"],
  [{ type: "played", seat: "you", name: "Forest" }, "Played Forest", "land"],
  [{ type: "played", seat: "opponent", name: "Mountain" }, "The opponent played Mountain", "land"],
  [{ type: "cast", seat: "you", name: "Sol Ring" }, "Cast Sol Ring", "cast"],
  [
    { type: "cast", seat: "opponent", name: "Lightning Bolt" },
    "The opponent cast Lightning Bolt",
    "cast",
  ],
  [{ type: "activated", seat: "you", name: "Sol Ring" }, "Activated Sol Ring", "cast"],
  [
    { type: "activated", seat: "opponent", name: "Smuggler's Copter" },
    "The opponent activated Smuggler's Copter",
    "cast",
  ],
  [
    { type: "moved", seat: "you", name: "Tarmogoyf", from: "battlefield", to: "graveyard" },
    "Tarmogoyf went to your graveyard",
    "move",
  ],
  [
    { type: "moved", seat: "opponent", name: "Ragavan", from: "battlefield", to: "graveyard" },
    "The opponent's Ragavan went to their graveyard",
    "move",
  ],
  [
    { type: "moved", seat: "opponent", name: "Boros Charm", from: "hand", to: "graveyard" },
    "The opponent discarded Boros Charm",
    "move",
  ],
  [
    { type: "moved", seat: "you", name: "Island", from: "libraryTop", to: "graveyard" },
    "Milled Island",
    "move",
  ],
  [
    { type: "moved", seat: "you", name: "Forest", from: "libraryTop", to: "hand" },
    "Drew Forest",
    "draw",
  ],
  [
    { type: "moved", seat: "opponent", name: "Ragavan", from: "battlefield", to: "exile" },
    "The opponent's Ragavan was exiled",
    "move",
  ],
  [
    { type: "moved", seat: "you", name: "Delver", from: "battlefield", to: "hand" },
    "Delver to your hand",
    "move",
  ],
  [{ type: "drew", seat: "you", name: "Forest" }, "Drew Forest", "draw"],
  [{ type: "drew", seat: "you", name: null }, "Drew a card", "draw"],
  [{ type: "drew", seat: "opponent", name: null }, "The opponent drew a card", "draw"],
  [
    { type: "attacked", seat: "you", names: ["Tarmogoyf", "Delver"] },
    "Attacked with Tarmogoyf and Delver",
    "combat",
  ],
  [
    { type: "attacked", seat: "opponent", names: ["Ragavan"] },
    "The opponent attacked with Ragavan",
    "combat",
  ],
  [
    { type: "blocked", seat: "you", blocker: "Tarmogoyf", attacker: "Ragavan" },
    "Blocked Ragavan with Tarmogoyf",
    "combat",
  ],
  [
    { type: "blocked", seat: "opponent", blocker: "Boros Reckoner", attacker: "Delver" },
    "The opponent blocked Delver with Boros Reckoner",
    "combat",
  ],
  [
    { type: "dealt", source: "Lightning Bolt", target: "Tarmogoyf", amount: 3 },
    "Lightning Bolt dealt 3 damage to Tarmogoyf",
    "combat",
  ],
  [{ type: "life", seat: "you", amount: -3 }, "You lost 3 life", "life"],
  [{ type: "life", seat: "opponent", amount: 2 }, "The opponent gained 2 life", "life"],
  [{ type: "life", seat: "you", amount: 0 }, null, "life"],
  [
    { type: "tokensCreated", seat: "you", name: "Treasure", count: 1 },
    "Created a Treasure token",
    "token",
  ],
  [
    { type: "tokensCreated", seat: "opponent", name: "Goblin", count: 2 },
    "The opponent created 2 Goblin tokens",
    "token",
  ],
  [
    { type: "put", name: "Sol Ring", from: "hand", to: "battlefield" },
    "Put Sol Ring onto the battlefield",
    "move",
  ],
  [{ type: "tapped", name: "Forest", count: 2, tapped: true }, "Tapped 2 × Forest", "tap"],
  [{ type: "untappedAll" }, "Untapped everything", "tap"],
  [
    { type: "counters", name: "Tarmogoyf", kind: "+1/+1", count: 2 },
    "Tarmogoyf has 2 +1/+1 counters",
    "counter",
  ],
  [{ type: "shuffled" }, "Shuffled the library", "shuffle"],
  [
    { type: "lifeSet", seat: "opponent", life: 12, was: 19 },
    "The opponent took 7, down to 12",
    "life",
  ],
  [
    { type: "chose", what: "TargetSelection" },
    "The rules engine chose for you: Choose a target",
    "engine",
  ],
  [{ type: "gameOver", winner: "you" }, "You won", "end"],
  [{ type: "gameOver", winner: "opponent" }, "You lost", "end"],
  [{ type: "gameOver", winner: null }, "The game is a draw", "end"],
];

describe("playtestSentence", () => {
  it.each(CASES)("%j reads %j", (happened, text, kind) => {
    expect(playtestSentence(happened)).toBe(text);
    expect(playtestKind(happened)).toBe(kind);
  });

  it("lists names the way a reader does", () => {
    expect(listed(["A"])).toBe("A");
    expect(listed(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("playtestLines", () => {
  it("files each line under the turn it happened in, newest first", () => {
    const lines = playtestLines(
      [
        { type: "cast", seat: "you", name: "Sol Ring" },
        { type: "turnBegan", turn: 6, seat: "opponent" },
        { type: "drew", seat: "opponent", name: null },
        { type: "turnBegan", turn: 7, seat: "you" },
        { type: "drew", seat: "you", name: "Forest" },
      ],
      7,
    );
    expect(lines.map((l) => [l.turn, l.text])).toEqual([
      [7, "Drew Forest"],
      [7, "Your turn 7 begins"],
      [6, "The opponent drew a card"],
      [6, "The opponent's turn 6 begins"],
      [5, "Cast Sol Ring"],
    ]);
  });

  it("takes the view's turn when no turn began", () => {
    expect(playtestLines([{ type: "shuffled" }], 4)).toEqual([
      { turn: 4, text: "Shuffled the library", kind: "shuffle" },
    ]);
  });
});
