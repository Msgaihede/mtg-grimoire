import { describe, expect, it } from "vitest";
import { tokenTheoryMark, tokenTheoryPlan } from "./tokenTheory";
import type { DeckTokenView } from "./deckTokens";

const ON = { exact: true, name: true, unplanned: true };

/** One token as the wall draws it — `TokenPile.test.tsx`'s `token()` defaults, so the two files
 *  describe the same Treasure. */
function view(over: Partial<DeckTokenView>): DeckTokenView {
  return {
    oracleId: "o-treasure",
    name: "Treasure",
    typeLine: "Token Artifact — Treasure",
    layout: "token",
    printingId: "p-treasure",
    quantity: 1,
    sources: [{ cardId: "c-smothering-tithe", name: "Smothering Tithe" }],
    derived: true,
    state: "auto",
    overridden: false,
    subtitle: "Colorless · {T}, Sacrifice this token: Add one mana of any color.",
    imageUrl: null,
    imageUris: null,
    setCode: "tclb",
    collectorNumber: "5",
    setName: "Commander Legends",
    rarity: "common",
    finishes: '["nonfoil"]',
    unitPrice: 0.25,
    ...over,
  };
}

describe("tokenTheoryPlan", () => {
  it("marks nothing while the plan has not loaded", () => {
    const plan = tokenTheoryPlan(undefined, [view({})], ON);
    expect(tokenTheoryMark(plan, view({}))).toBeNull();
  });

  it("ticks a token the plan makes in the same printing", () => {
    const t = view({ printingId: "p1", quantity: 1 });
    expect(tokenTheoryMark(tokenTheoryPlan([t], [t], ON), t)).toEqual({ tier: "exact", delta: 0 });
  });

  it("crosses a token only a substitute makes", () => {
    const live = view({ oracleId: "o-goblin", name: "Goblin", printingId: "p-g" });
    expect(tokenTheoryMark(tokenTheoryPlan([], [live], ON), live)).toEqual({
      tier: "unplanned",
      delta: 0,
    });
  });

  it("names the mismatch when the plan makes the same token in another printing", () => {
    const live = view({ printingId: "p-a" });
    const planned = view({ printingId: "p-b" });
    expect(tokenTheoryMark(tokenTheoryPlan([planned], [live], ON), live)?.tier).toBe("name");
  });

  /**
   * **A token's name does not identify it** — `Wurmcoil Engine` makes two different `Wurm`s. A
   * plan making the Lifelink one against a live list making the Deathtouch one is a different
   * token, not another printing of the same one, so the mark is the X and never `Art Mismatch`.
   */
  it("crosses a different token that only shares the planned token's name", () => {
    const planned = view({ oracleId: "o-wurm-lifelink", name: "Wurm", printingId: "p-wl" });
    const live = view({ oracleId: "o-wurm-deathtouch", name: "Wurm", printingId: "p-wd" });
    expect(tokenTheoryMark(tokenTheoryPlan([planned], [live], ON), live)).toEqual({
      tier: "unplanned",
      delta: 0,
    });
  });

  /**
   * **The number is 0 at both grains until PR 2, and these two are what say so.** The override is
   * shared by both lists, so a token's quantity is one number on each side — but `DIFFERENCE_FLOOR`
   * turns `planned − live` into `0` whenever neither side is above one, so every case above, at one
   * copy, would pass over a live side keyed differently from the plan's. At four copies a live
   * side the plan's slot never finds reads `0` against `4` and prints `+4` on a token that
   * matches, which is exactly the number the ruling rules out.
   */
  it("ticks a four-copy token the plan makes in the same printing, with no number", () => {
    const t = view({ printingId: "p1", quantity: 4 });
    expect(tokenTheoryMark(tokenTheoryPlan([t], [t], ON), t)).toEqual({ tier: "exact", delta: 0 });
  });

  it("names a four-copy token the plan makes in another printing, with no number", () => {
    const live = view({ printingId: "p-a", quantity: 4 });
    const planned = view({ printingId: "p-b", quantity: 4 });
    expect(tokenTheoryMark(tokenTheoryPlan([planned], [live], ON), live)).toEqual({
      tier: "name",
      delta: 0,
    });
  });

  it("honours a switched-off tier", () => {
    const live = view({ oracleId: "o-goblin", name: "Goblin", printingId: "p-g" });
    expect(
      tokenTheoryMark(tokenTheoryPlan([], [live], { ...ON, unplanned: false }), live),
    ).toBeNull();
  });
});
