import { describe, expect, it } from "vitest";
import type { PlaytestHappened } from "@/lib/ipc";
import { listed, playtestKind, playtestLines, playtestSentence } from "./log";

/** Every variant of the wire, each with the sentence and the glyph it makes. */
const CASES: [PlaytestHappened, string | null, string][] = [
  [{ type: "mulliganed", mulligans: 1 }, "Mulligan 1 · drew seven", "deal"],
  [{ type: "kept", size: 6, bottomed: 1 }, "Kept six · put one on the bottom", "deal"],
  [{ type: "kept", size: 7, bottomed: 0 }, "Kept seven", "deal"],
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
  [{ type: "cast", seat: "opponent", name: null }, "The opponent cast a face-down spell", "cast"],
  [{ type: "activated", seat: "you", name: "Sol Ring" }, "Activated Sol Ring", "cast"],
  [
    { type: "activated", seat: "opponent", name: "Smuggler's Copter" },
    "The opponent activated Smuggler's Copter",
    "cast",
  ],
  [
    { type: "foretold", seat: "you", name: "Behold the Multiverse" },
    "Foretold Behold the Multiverse",
    "cast",
  ],
  [{ type: "foretold", seat: "opponent", name: null }, "The opponent foretold a card", "cast"],
  [
    { type: "companionRevealed", seat: "you", name: "Lurrus of the Dream-Den" },
    "Revealed Lurrus of the Dream-Den as your companion",
    "reveal",
  ],
  [
    { type: "companionToHand", seat: "opponent", name: "Jegantha, the Wellspring" },
    "The opponent put Jegantha, the Wellspring, their companion, into their hand",
    "move",
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
  // A card from the library to the hand that is not a draw is a search's find (a tutor).
  [
    { type: "moved", seat: "you", name: "Forest", from: "libraryTop", to: "hand" },
    "Put Forest from your library into your hand",
    "draw",
  ],
  [
    { type: "moved", seat: "opponent", name: null, from: "libraryTop", to: "hand" },
    "The opponent put a card from their library into their hand",
    "draw",
  ],
  [
    { type: "moved", seat: "opponent", name: "Lightning Bolt", from: "libraryTop", to: "hand" },
    "The opponent put Lightning Bolt from their library into their hand",
    "draw",
  ],
  [
    { type: "moved", seat: "opponent", name: "Ragavan", from: "battlefield", to: "exile" },
    "The opponent's Ragavan was exiled",
    "move",
  ],
  [
    { type: "moved", seat: "opponent", name: null, from: "libraryTop", to: "exile" },
    "The opponent's face-down card was exiled",
    "move",
  ],
  [
    { type: "moved", seat: "opponent", name: null, from: "libraryTop", to: "battlefield" },
    "The opponent's face-down card entered the battlefield",
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
    {
      type: "dealt",
      source: "Lightning Bolt",
      target: "Tarmogoyf",
      targetId: 4,
      seat: "you",
      amount: 3,
    },
    "Lightning Bolt dealt 3 damage to Tarmogoyf",
    "combat",
  ],
  [{ type: "life", seat: "you", amount: -3, total: 17 }, "You lost 3, down to 17", "life"],
  [
    { type: "life", seat: "opponent", amount: 2, total: 22 },
    "The opponent gained 2, up to 22",
    "life",
  ],
  [{ type: "life", seat: "you", amount: 0, total: 20 }, null, "life"],
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
    { type: "emblem", seat: "you", source: "Sorin, Lord of Innistrad" },
    "Got an emblem from Sorin, Lord of Innistrad",
    "token",
  ],
  [{ type: "emblem", seat: "opponent", source: null }, "The opponent got an emblem", "token"],
  // The sandbox's, the reader's own cards read as the goldfish board read them.
  [
    { type: "put", seat: "you", name: "Sol Ring", from: "hand", to: "battlefield" },
    "Put Sol Ring onto the battlefield",
    "move",
  ],
  [
    { type: "put", seat: "you", name: "Arcane Signet", from: "command", to: "battlefield" },
    "Put Arcane Signet onto the battlefield",
    "move",
  ],
  [
    { type: "put", seat: "you", name: "Swords to Plowshares", from: "hand", to: "graveyard" },
    "Cast Swords to Plowshares · unpaid",
    "cast",
  ],
  [
    { type: "put", seat: "you", name: "Sol Ring", from: "battlefield", to: "libraryBottom" },
    "Sol Ring to the bottom of the library",
    "move",
  ],
  [
    { type: "put", seat: "you", name: "Delver", from: "battlefield", to: "graveyard" },
    "Delver to the graveyard",
    "move",
  ],
  // And an opponent's, put into their owner's zones.
  [
    { type: "put", seat: "opponent", name: "Grizzly Bears", from: "battlefield", to: "graveyard" },
    "Put the opponent's Grizzly Bears into their graveyard",
    "move",
  ],
  [
    { type: "put", seat: "opponent", name: "Ragavan", from: "battlefield", to: "libraryTop" },
    "Put the opponent's Ragavan on top of their library",
    "move",
  ],
  [
    { type: "put", seat: "opponent", name: "Ragavan", from: "exile", to: "hand" },
    "Put the opponent's Ragavan into their hand",
    "move",
  ],
  // A change of control by hand (issue #1713), on the battlefield or onto it from a zone.
  [
    {
      type: "controlled",
      seat: "opponent",
      name: "Hill Giant",
      from: "battlefield",
      controller: "you",
      byHand: true,
    },
    "Gained control of the opponent's Hill Giant",
    "move",
  ],
  [
    {
      type: "controlled",
      seat: "opponent",
      name: "Hill Giant",
      from: "battlefield",
      controller: "opponent",
      byHand: true,
    },
    "Gave the opponent's Hill Giant back",
    "move",
  ],
  [
    {
      type: "controlled",
      seat: "you",
      name: "Grizzly Bears",
      from: "battlefield",
      controller: "opponent",
      byHand: true,
    },
    "Gave Grizzly Bears to the opponent",
    "move",
  ],
  [
    {
      type: "controlled",
      seat: "you",
      name: "Grizzly Bears",
      from: "battlefield",
      controller: "you",
      byHand: true,
    },
    "Regained control of Grizzly Bears",
    "move",
  ],
  [
    {
      type: "controlled",
      seat: "opponent",
      name: "Hill Giant",
      from: "graveyard",
      controller: "you",
      byHand: true,
    },
    "Put the opponent's Hill Giant onto the battlefield under your control",
    "move",
  ],
  [
    {
      type: "controlled",
      seat: "you",
      name: "Grizzly Bears",
      from: "exile",
      controller: "opponent",
      byHand: true,
    },
    "Put Grizzly Bears onto the battlefield under the opponent's control",
    "move",
  ],
  [
    { type: "tapped", seat: "you", name: "Forest", count: 2, tapped: true },
    "Tapped 2 × Forest",
    "tap",
  ],
  [
    { type: "tapped", seat: "you", name: "Sol Ring", count: 1, tapped: false },
    "Untapped Sol Ring",
    "tap",
  ],
  [
    { type: "tapped", seat: "opponent", name: "Llanowar Elves", count: 1, tapped: true },
    "Tapped the opponent's Llanowar Elves",
    "tap",
  ],
  [
    { type: "tapped", seat: "opponent", name: "Mountain", count: 3, tapped: false },
    "Untapped the opponent's 3 × Mountain",
    "tap",
  ],
  [{ type: "untappedAll" }, "Untapped everything", "tap"],
  [
    { type: "counters", seat: "you", name: "Tarmogoyf", kind: "+1/+1", count: 2 },
    "Tarmogoyf has 2 +1/+1 counters",
    "counter",
  ],
  [
    { type: "counters", seat: "you", name: "Tarmogoyf", kind: "-1/-1", count: 1 },
    "Tarmogoyf has 1 -1/-1 counter",
    "counter",
  ],
  [
    { type: "counters", seat: "opponent", name: "Ragavan", kind: "+1/+1", count: 0 },
    "The opponent's Ragavan has no +1/+1 counters",
    "counter",
  ],
  [{ type: "shuffled" }, "Shuffled the library", "shuffle"],
  [
    { type: "lifeSet", seat: "opponent", life: 12, was: 19 },
    "The opponent took 7, down to 12",
    "life",
  ],
  [{ type: "lifeSet", seat: "you", life: 43, was: 40 }, "You gained 3, up to 43", "life"],
  [{ type: "lifeSet", seat: "opponent", life: 0, was: 4 }, "The opponent is dead", "life"],
  [
    { type: "manaChanged", kind: "green", delta: 2, floating: 3 },
    "Added two green mana to your pool",
    "tap",
  ],
  [
    { type: "manaChanged", kind: "colorless", delta: -1, floating: 0 },
    "Took one colorless mana from your pool",
    "tap",
  ],
  [
    { type: "revealed", seat: "opponent", names: ["Lightning Bolt", "Forest"] },
    "The opponent revealed Lightning Bolt and Forest",
    "reveal",
  ],
  [{ type: "revealed", seat: "you", names: ["Island"] }, "Revealed Island", "reveal"],
  [
    { type: "countered", seat: "you", name: "Counterspell", by: "Mana Leak" },
    "Your Counterspell was countered by Mana Leak",
    "cast",
  ],
  [
    { type: "countered", seat: "opponent", name: "Lightning Bolt", by: null },
    "The opponent's Lightning Bolt was countered",
    "cast",
  ],
  [
    { type: "countered", seat: "opponent", name: null, by: "Counterspell" },
    "The opponent's face-down spell was countered by Counterspell",
    "cast",
  ],
  [{ type: "flipped", seat: "you", won: true }, "You won the flip", "chance"],
  [{ type: "flipped", seat: "opponent", won: false }, "The opponent lost the flip", "chance"],
  [
    { type: "rolled", seat: "opponent", sides: 6, result: 4 },
    "The opponent rolled 4 on a d6",
    "chance",
  ],
  [{ type: "rolled", seat: "you", sides: 20, result: 17 }, "You rolled 17 on a d20", "chance"],
  [{ type: "rolled", seat: "you", sides: 6, result: null }, "You rolled the planar die", "chance"],
  [{ type: "named", seat: "you", name: "Lightning Bolt" }, "You named Lightning Bolt", "reveal"],
  [{ type: "named", seat: "opponent", name: "Ragavan" }, "The opponent named Ragavan", "reveal"],
  [{ type: "became", seat: "you", what: "monarch" }, "You became the monarch", "status"],
  [
    { type: "became", seat: "opponent", what: "initiative" },
    "The opponent took the initiative",
    "status",
  ],
  [{ type: "became", seat: "you", what: "cityBlessing" }, "You got the city's blessing", "status"],
  [{ type: "became", seat: "you", what: "ringTempted" }, "The Ring tempted you", "status"],
  [
    { type: "became", seat: "opponent", what: "ringTempted" },
    "The Ring tempted the opponent",
    "status",
  ],
  [
    {
      type: "controlled",
      seat: "you",
      name: "Grizzly Bears",
      from: "battlefield",
      controller: "opponent",
      byHand: false,
    },
    "The opponent gained control of your Grizzly Bears",
    "move",
  ],
  [
    {
      type: "controlled",
      seat: "opponent",
      name: "Hill Giant",
      from: "battlefield",
      controller: "you",
      byHand: false,
    },
    "You gained control of the opponent's Hill Giant",
    "move",
  ],
  [
    {
      type: "controlled",
      seat: "you",
      name: "Grizzly Bears",
      from: "battlefield",
      controller: "you",
      byHand: false,
    },
    "You regained control of Grizzly Bears",
    "move",
  ],
  [
    { type: "countersChanged", seat: "you", name: "Tarmogoyf", kind: "+1/+1", delta: 2 },
    "Tarmogoyf got two +1/+1 counters",
    "counter",
  ],
  [
    { type: "countersChanged", seat: "opponent", name: "Jace", kind: "loyalty", delta: -1 },
    "The opponent's Jace lost one loyalty counter",
    "counter",
  ],
  [
    { type: "countersChanged", seat: "opponent", name: null, kind: "+1/+1", delta: 1 },
    "The opponent's face-down permanent got one +1/+1 counter",
    "counter",
  ],
  [
    { type: "becameTapped", seat: "you", names: ["Llanowar Elves"], tapped: true },
    "Llanowar Elves became tapped",
    "tap",
  ],
  [
    { type: "becameTapped", seat: "opponent", names: ["Grizzly Bears", null], tapped: false },
    "The opponent's Grizzly Bears and a face-down permanent became untapped",
    "tap",
  ],
  [
    { type: "triggered", seat: "you", name: "Soul Warden" },
    "Soul Warden's ability triggered",
    "cast",
  ],
  [
    { type: "triggered", seat: "opponent", name: null },
    "The opponent's face-down permanent's ability triggered",
    "cast",
  ],
  [
    { type: "transformed", seat: "you", name: "Insectile Aberration" },
    "Insectile Aberration transformed",
    "move",
  ],
  [
    { type: "turnedFaceUp", seat: "opponent", name: "Willbender" },
    "The opponent's Willbender was turned face up",
    "move",
  ],
  [
    { type: "turnedFaceDown", seat: "opponent", name: null },
    "The opponent's face-down permanent was turned face down",
    "move",
  ],
  [
    {
      type: "attached",
      seat: "you",
      name: "Rancor",
      to: "Grizzly Bears",
      toSeat: "you",
      attached: true,
    },
    "Rancor was attached to Grizzly Bears",
    "move",
  ],
  [
    {
      type: "attached",
      seat: "you",
      name: "Bonesplitter",
      to: "Hill Giant",
      toSeat: "opponent",
      attached: false,
    },
    "Bonesplitter was unattached from the opponent's Hill Giant",
    "move",
  ],
  [
    {
      type: "attached",
      seat: "opponent",
      name: "Curse of Opulence",
      to: null,
      toSeat: "you",
      attached: true,
    },
    "The opponent's Curse of Opulence was attached to you",
    "move",
  ],
  [
    { type: "removed", seat: "opponent", name: "Grizzly Bears", how: "destroyed", to: "graveyard" },
    "The opponent's Grizzly Bears was destroyed",
    "move",
  ],
  [
    { type: "removed", seat: "you", name: "Kenrith", how: "destroyed", to: "command" },
    "Kenrith was destroyed · to the command zone",
    "move",
  ],
  [
    { type: "removed", seat: "you", name: "Food", how: "sacrificed", to: "graveyard" },
    "Sacrificed Food",
    "move",
  ],
  [
    { type: "removed", seat: "opponent", name: "Lórien Revealed", how: "cycled", to: "graveyard" },
    "The opponent cycled Lórien Revealed",
    "move",
  ],
  [
    { type: "removed", seat: "you", name: "Fiery Temper", how: "discarded", to: "exile" },
    "Discarded Fiery Temper · to exile",
    "move",
  ],
  [
    { type: "playerCounters", seat: "you", kind: "energy", delta: 2, total: 5 },
    "You got two energy, up to 5",
    "counter",
  ],
  [
    { type: "playerCounters", seat: "opponent", kind: "poison", delta: 1, total: 3 },
    "The opponent got one poison counter, up to 3",
    "counter",
  ],
  [
    { type: "playerCounters", seat: "you", kind: "speed", delta: 1, total: 2 },
    "Your speed is now 2",
    "counter",
  ],
  [
    { type: "roomEntered", seat: "you", dungeon: "Lost Mine of Phandelver", room: "Cave Entrance" },
    "You entered Cave Entrance (Lost Mine of Phandelver)",
    "status",
  ],
  [
    { type: "dungeonCompleted", seat: "opponent", dungeon: "Tomb of Annihilation" },
    "The opponent completed Tomb of Annihilation",
    "status",
  ],
  [{ type: "voted", seat: "opponent", choice: "Grace" }, "The opponent voted for Grace", "status"],
  [
    {
      type: "voteResolved",
      tallies: [
        { choice: "Grace", votes: 2 },
        { choice: "Condemnation", votes: 1 },
      ],
    },
    "The vote is in: Grace 2 · Condemnation 1",
    "status",
  ],
  [
    {
      type: "clashed",
      seat: "you",
      with: "opponent",
      manaValue: 3,
      theirManaValue: 1,
      result: "won",
    },
    "You won a clash with the opponent (3 to 1)",
    "reveal",
  ],
  [
    {
      type: "clashed",
      seat: "opponent",
      with: "you",
      manaValue: 2,
      theirManaValue: null,
      result: "tied",
    },
    "The opponent tied a clash with you",
    "reveal",
  ],
  [{ type: "extraTurn", seat: "you" }, "You will take an extra turn", "turn"],
  [{ type: "dayNight", now: "night" }, "It became night", "turn"],
  [{ type: "dayNight", now: "day" }, "It became day", "turn"],
  [
    { type: "chose", what: "TargetSelection" },
    "The engine chose for you: Choose a target",
    "engine",
  ],
  [{ type: "eliminated", seat: "you" }, "You are out", "end"],
  [{ type: "gameOver", winner: "you" }, "You won", "end"],
  [{ type: "gameOver", winner: "opponent" }, "You lost", "end"],
  [{ type: "gameOver", winner: null }, "The game is a draw", "end"],
];

describe("playtestSentence", () => {
  it.each(CASES)("%j reads %j", (happened, text, kind) => {
    expect(playtestSentence(happened)).toBe(text);
    expect(playtestKind(happened)).toBe(kind);
  });

  it("names each opponent at a four-player table, and keeps the duel's words in a duel", () => {
    const at4 = (h: PlaytestHappened) => playtestSentence(h, 3);
    expect(at4({ type: "cast", seat: "opponent2", name: "Lightning Bolt" })).toBe(
      "Opponent 2 cast Lightning Bolt",
    );
    expect(at4({ type: "turnBegan", turn: 7, seat: "opponent" })).toBe(
      "Opponent 1's turn 7 begins",
    );
    expect(
      at4({ type: "moved", seat: "opponent3", name: "Ragavan", from: "battlefield", to: "exile" }),
    ).toBe("Opponent 3's Ragavan was exiled");
    expect(at4({ type: "life", seat: "opponent2", amount: -4, total: 36 })).toBe(
      "Opponent 2 lost 4, down to 36",
    );
    expect(at4({ type: "became", seat: "opponent3", what: "ringTempted" })).toBe(
      "The Ring tempted Opponent 3",
    );
    expect(at4({ type: "countered", seat: "opponent2", name: "Opt", by: "Counterspell" })).toBe(
      "Opponent 2's Opt was countered by Counterspell",
    );
    expect(
      at4({
        type: "commanderDamage",
        source: "Kenrith, the Returned King",
        sourceId: 4,
        seat: "opponent2",
        amount: 7,
        total: 21,
      }),
    ).toBe("Kenrith, the Returned King has dealt Opponent 2 21 commander damage");
    expect(at4({ type: "lifeSet", seat: "opponent3", life: 30, was: 40 })).toBe(
      "Opponent 3 took 10, down to 30",
    );
    expect(
      at4({
        type: "put",
        seat: "opponent2",
        name: "Grizzly Bears",
        from: "battlefield",
        to: "exile",
      }),
    ).toBe("Put Opponent 2's Grizzly Bears into exile");
    expect(
      at4({ type: "tapped", seat: "opponent3", name: "Llanowar Elves", count: 1, tapped: true }),
    ).toBe("Tapped Opponent 3's Llanowar Elves");
    expect(at4({ type: "counters", seat: "opponent2", name: "X", kind: "+1/+1", count: 2 })).toBe(
      "Opponent 2's X has 2 +1/+1 counters",
    );
    expect(
      at4({
        type: "controlled",
        seat: "opponent2",
        name: "Hill Giant",
        from: "battlefield",
        controller: "opponent3",
        byHand: true,
      }),
    ).toBe("Gave Opponent 2's Hill Giant to Opponent 3");
    expect(
      at4({
        type: "controlled",
        seat: "opponent3",
        name: "Hill Giant",
        from: "graveyard",
        controller: "opponent2",
        byHand: true,
      }),
    ).toBe("Put Opponent 3's Hill Giant onto the battlefield under Opponent 2's control");
    expect(at4({ type: "eliminated", seat: "opponent3" })).toBe("Opponent 3 is out");
    expect(at4({ type: "gameOver", winner: "opponent2" })).toBe("Opponent 2 won");
    expect(at4({ type: "gameOver", winner: "you" })).toBe("You won");
    expect(playtestSentence({ type: "cast", seat: "opponent", name: "Lightning Bolt" })).toBe(
      "The opponent cast Lightning Bolt",
    );
  });

  // The goldfish cannot lose, so no `eliminated` follows the blow: the line itself says it.
  it("says the goldfish's fatal blow as the goldfish board did, and only the goldfish's", () => {
    const blow: PlaytestHappened = { type: "life", seat: "opponent", amount: -7, total: -2 };
    expect(playtestSentence(blow, 1, true)).toBe("The opponent is dead");
    expect(playtestSentence(blow)).toBe("The opponent lost 7, down to -2");
    // Already dead, it only loses more; and the reader's own life is never "dead".
    expect(
      playtestSentence({ type: "life", seat: "opponent", amount: -3, total: -5 }, 1, true),
    ).toBe("The opponent lost 3, down to -5");
    expect(playtestSentence({ type: "life", seat: "you", amount: -3, total: 0 }, 1, true)).toBe(
      "You lost 3, down to 0",
    );
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

  it("files the goldfish's turn under its own turn number, between the reader's", () => {
    const lines = playtestLines(
      [
        { type: "turnBegan", turn: 2, seat: "opponent" },
        { type: "drew", seat: "opponent", name: null },
        { type: "turnBegan", turn: 3, seat: "you" },
        { type: "drew", seat: "you", name: "Forest" },
      ],
      3,
      1,
      true,
    );
    expect(lines).toEqual([
      { turn: 3, text: "Drew Forest", kind: "draw" },
      { turn: 3, text: "Your turn 3 begins", kind: "turn" },
      { turn: 2, text: "The opponent drew a card", kind: "draw" },
      { turn: 2, text: "The opponent's turn 2 begins", kind: "turn" },
    ]);
  });

  it("takes the view's turn when no turn began", () => {
    expect(playtestLines([{ type: "shuffled" }], 4)).toEqual([
      { turn: 4, text: "Shuffled the library", kind: "shuffle" },
    ]);
  });
});
