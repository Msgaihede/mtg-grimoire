import { describe, expect, it } from "vitest";
import type { PlaytestHappened } from "@/lib/ipc";
import { GAP, MAX_CUES, SAME_MAX, atPress, cuesFor, soundOf } from "./cues";

const drew: PlaytestHappened = { type: "drew", seat: "you", name: "Island" };
const tapped: PlaytestHappened = {
  type: "tapped",
  seat: "you",
  name: "Forest",
  count: 1,
  tapped: true,
};
const moved = (from: string, to: string): PlaytestHappened =>
  ({ type: "moved", seat: "you", name: "Bear", from, to }) as PlaytestHappened;

describe("soundOf", () => {
  it.each<[PlaytestHappened, string | null]>([
    [drew, "draw"],
    [{ type: "turnBegan", turn: 3, seat: "you" }, "turnYours"],
    [{ type: "turnBegan", turn: 3, seat: "opponent2" }, "turnTheirs"],
    [{ type: "played", seat: "opponent", name: "Mountain" }, "play"],
    [{ type: "cast", seat: "opponent", name: null }, "cast"],
    [tapped, "tap"],
    [{ ...tapped, tapped: false }, "untap"],
    [{ type: "untappedAll" }, "untapAll"],
    [moved("battlefield", "graveyard"), "graveyard"],
    [moved("libraryTop", "graveyard"), "mill"],
    [moved("battlefield", "exile"), "exile"],
    [moved("battlefield", "hand"), "toHand"],
    [moved("hand", "libraryBottom"), "toLibrary"],
    [moved("hand", "battlefield"), "play"],
    [{ type: "life", seat: "you", amount: -3, total: 17 }, "lifeLoss"],
    [{ type: "life", seat: "you", amount: 2, total: 22 }, "lifeGain"],
    [{ type: "life", seat: "you", amount: 0, total: 20 }, null],
    [{ type: "lifeSet", seat: "you", life: 15, was: 20 }, "lifeLoss"],
    [{ type: "lifeSet", seat: "you", life: 25, was: 20 }, "lifeGain"],
    [{ type: "dealt", source: "Bolt", target: "Bear", targetId: 4, seat: "you", amount: 0 }, null],
    [{ type: "gameOver", winner: "you" }, "win"],
    [{ type: "gameOver", winner: null }, "lose"],
    [{ type: "gameOver", winner: "opponent" }, "lose"],
  ])("%o sounds %s", (h, id) => {
    expect(soundOf(h)).toBe(id);
  });
});

describe("cuesFor", () => {
  it("plays a beat's facts in order, a gap apart, with room after a sound that needs it", () => {
    const cues = cuesFor([
      { type: "turnBegan", turn: 2, seat: "you" },
      { type: "untappedAll" },
      drew,
    ]);
    expect(cues.map((c) => c.id)).toEqual(["turnYours", "untapAll", "draw"]);
    expect(cues[0].delay).toBe(0);
    // The turn's mallet is given more than a gap before the untap begins.
    expect(cues[1].delay).toBeGreaterThan(GAP);
    expect(cues[2].delay).toBeCloseTo(cues[1].delay + GAP);
  });

  it("hears a rules mana tap as mana, and only the tap the action made", () => {
    expect(cuesFor([tapped, tapped], { type: "tapForMana", id: 7 }).map((c) => c.id)).toEqual([
      "mana",
      "tap",
    ]);
    expect(cuesFor([tapped]).map((c) => c.id)).toEqual(["tap"]);
  });

  it("hears a counter taken off as a removal, which the fact alone cannot say", () => {
    const counters: PlaytestHappened = {
      type: "counters",
      seat: "you",
      name: "Bear",
      kind: "+1/+1",
      count: 1,
    };
    expect(cuesFor([counters], { type: "counters", id: 1, kind: "+1/+1", delta: -1 })[0].id).toBe(
      "counterRemove",
    );
    expect(cuesFor([counters], { type: "counters", id: 1, kind: "+1/+1", delta: 1 })[0].id).toBe(
      "counterAdd",
    );
  });

  it("caps one sound at SAME_MAX: seven draws are heard as three", () => {
    expect(cuesFor(Array.from({ length: 7 }, () => drew))).toHaveLength(SAME_MAX);
  });

  it("keeps the most telling MAX_CUES of a busy beat, in their order", () => {
    const busy: PlaytestHappened[] = [
      tapped,
      { ...tapped, name: "Island" },
      { type: "played", seat: "opponent", name: "Mountain" },
      { type: "counters", seat: "opponent", name: "Golem", kind: "charge", count: 2 },
      { type: "cast", seat: "opponent", name: "Bolt" },
      { type: "shuffled" },
      { type: "attacked", seat: "opponent", names: ["Goblin"] },
      { type: "gameOver", winner: "opponent" },
    ];
    const ids = cuesFor(busy).map((c) => c.id);
    expect(ids).toHaveLength(MAX_CUES);
    expect(ids).toEqual(["tap", "play", "cast", "attack", "lose"]);
  });

  it("makes no sound for a beat with nothing to hear", () => {
    expect(cuesFor([])).toEqual([]);
    expect(cuesFor([{ type: "life", seat: "you", amount: 0, total: 20 }])).toEqual([]);
  });
});

describe("atPress", () => {
  it("sounds undo, redo, a pass and a choice at the press, and nothing else", () => {
    expect(atPress({ type: "undo" })).toBe("undo");
    expect(atPress({ type: "redo" })).toBe("redo");
    expect(atPress({ type: "pass" })).toBe("pass");
    expect(atPress({ type: "endTurn" })).toBe("pass");
    expect(atPress({ type: "choose", index: 0 })).toBe("choose");
    expect(atPress({ type: "draw", count: 1 })).toBeNull();
    expect(atPress({ type: "play", id: 3 })).toBeNull();
  });
});
