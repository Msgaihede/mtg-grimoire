import { describe, expect, it } from "vitest";
import { tileKeyOf } from "@/lib/tileKey";
import { tokenDeckFinish, tokenTheoryMark, tokenTheoryPlan } from "./tokenTheory";
import type { DeckTokenView } from "./deckTokens";

const ON = { exact: true, name: true, unplanned: true };

/** One entry as the wall draws it — `TokenPile.test.tsx`'s `token()` defaults, so the two files
 *  describe the same Treasure. The `entryKey` follows the printing and the finish unless a case
 *  names one, exactly as `deckTokens.ts` derives it. */
function view(over: Partial<DeckTokenView>): DeckTokenView {
  const base: DeckTokenView = {
    oracleId: "o-treasure",
    name: "Treasure",
    typeLine: "Token Artifact — Treasure",
    layout: "token",
    printingId: "p-treasure",
    finish: "nonfoil",
    implicit: false,
    entryKey: "",
    quantity: 1,
    sources: [{ cardId: "c-smothering-tithe", name: "Smothering Tithe" }],
    derived: true,
    state: "auto",
    overridden: false,
    subtitle: "Colorless · {T}, Sacrifice this token: Add one mana of any color.",
    setCode: "tclb",
    collectorNumber: "5",
    setName: "Commander Legends",
    rarity: "common",
    finishes: '["nonfoil","foil"]',
    unitPrice: 0.25,
    ...over,
  };
  return { ...base, entryKey: over.entryKey ?? tileKeyOf(base.printingId, base.finish) };
}

describe("tokenDeckFinish", () => {
  it("spells an entry's finish the way a deck card's is spelled — the regular copy is null", () => {
    expect(tokenDeckFinish(view({ finish: "nonfoil" }))).toBeNull();
    expect(tokenDeckFinish(view({ finish: "foil" }))).toBe("foil");
    expect(tokenDeckFinish(view({ finish: "etched" }))).toBe("etched");
  });
});

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
   * **Equal counts are `0`, at both grains, and these two are what say so at four copies.**
   * `DIFFERENCE_FLOOR` turns `planned − live` into `0` whenever neither side is above one, so
   * every case above, at one copy, would pass over a live side keyed differently from the plan's.
   * At four copies a live side the plan's slot never finds reads `0` against `4` and prints `+4`
   * on a token that matches — the number a mis-spelt key would draw.
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

/**
 * **Each list has its own entries since PR 2, so every tier answers as it does for cards**
 * (token stacks, spec §4.8): the slot is the printing **and** the finish, and the number is
 * `planned − live` at the tier's grain.
 */
describe("tokenTheoryPlan over entries with real finishes", () => {
  it("ticks the foil entry a plan asks for in foil", () => {
    const t = view({ printingId: "p1", finish: "foil" });
    expect(tokenTheoryMark(tokenTheoryPlan([t], [t], ON), t)).toEqual({ tier: "exact", delta: 0 });
  });

  /** The deck card's rule: a plan asking for a foil Treasure is not satisfied by the nonfoil one
   *  of the same printing — it is the same token in another object, which is the name tier. */
  it("does not let a nonfoil entry satisfy a plan that asks for the foil one", () => {
    const planned = view({ printingId: "p1", finish: "foil" });
    const live = view({ printingId: "p1", finish: "nonfoil" });
    expect(tokenTheoryMark(tokenTheoryPlan([planned], [live], ON), live)).toEqual({
      tier: "name",
      delta: 0,
    });
  });

  it("counts planned − live at the printing-and-finish grain on the exact tier", () => {
    const planned = view({ printingId: "p1", finish: "foil", quantity: 4 });
    const live = view({ printingId: "p1", finish: "foil", quantity: 1 });
    expect(tokenTheoryMark(tokenTheoryPlan([planned], [live], ON), live)).toEqual({
      tier: "exact",
      delta: 3,
    });
  });

  /**
   * **The name tier sums every entry of the token, on both sides** — keyed on the oracle id, so a
   * plan of four foil Treasures against one nonfoil and one other-printing foil copy is two short,
   * and both live entries say so.
   */
  it("sums the name tier across every entry of the token", () => {
    const planned = view({ printingId: "p1", finish: "foil", quantity: 4 });
    const regular = view({ printingId: "p1", finish: "nonfoil", quantity: 1 });
    const other = view({ printingId: "p2", finish: "foil", quantity: 1 });
    const plan = tokenTheoryPlan([planned], [regular, other], ON);
    expect(tokenTheoryMark(plan, regular)).toEqual({ tier: "name", delta: 2 });
    expect(tokenTheoryMark(plan, other)).toEqual({ tier: "name", delta: 2 });
  });

  /**
   * **A plan entry held at 0 is a plan that asks for none** (spec §4.2 rule 3: stepping a token's
   * last entry to 0 keeps the row at 0 rather than deleting it, so the implicit default does not
   * come back). As a slot it would be a plan asking for zero of this printing, and one live copy
   * against it reads the exact tick — `DIFFERENCE_FLOOR` keeps 1-against-0 at no number — where
   * the plan in fact makes none of the token and the honest mark is the X.
   */
  it("reads a live copy as unplanned against a plan that holds the token at zero", () => {
    const planned = view({ printingId: "p1", quantity: 0 });
    const live = view({ printingId: "p1", quantity: 1 });
    expect(tokenTheoryMark(tokenTheoryPlan([planned], [live], ON), live)).toEqual({
      tier: "unplanned",
      delta: 0,
    });
  });
});
