import { describe, expect, it } from "vitest";
import { finishChoiceLabel, finishChoiceWord } from "./finishChoice";

/**
 * Issue #1690: a finish choice names **the kind of foil** where the printing has one — the card
 * modal's buttons, its right-click rows and the deck card menu all read their word from here.
 */
describe("finishChoiceWord", () => {
  it("names the kind of foil on the foil copy", () => {
    expect(finishChoiceWord("foil", '["surgefoil"]')).toBe("surge foil");
    expect(finishChoiceWord("foil", '["manafoil"]')).toBe("mana foil");
    expect(finishChoiceWord("foil", '["galaxyfoil","boosterfun"]')).toBe("galaxy foil");
  });

  it("reads a pair Scryfall spells as two members as the one name a player says", () => {
    expect(finishChoiceWord("foil", '["raisedfoil","oilslick"]')).toBe("oil slick raised foil");
  });

  it("is plain foil where the printing names no kind", () => {
    expect(finishChoiceWord("foil", null)).toBe("foil");
    expect(finishChoiceWord("foil", "[]")).toBe("foil");
    // An unrecognised member is dropped, not shown raw — Scryfall adds them without asking.
    expect(finishChoiceWord("foil", '["boosterfun","notyetnamed"]')).toBe("foil");
    expect(finishChoiceWord("foil", "not json")).toBe("foil");
  });

  it("never names a trait, which is true of every finish and so tells none apart", () => {
    // A serialized printing would otherwise offer `View as serialized` on both of its buttons.
    expect(finishChoiceWord("foil", '["serialized"]')).toBe("foil");
    expect(finishChoiceWord("nonfoil", '["serialized"]')).toBe("nonfoil");
    // The foil word still wins where a printing carries both, whatever order Scryfall lists them.
    expect(finishChoiceWord("foil", '["scroll","silverfoil"]')).toBe("silver foil");
  });

  it("leaves etched and the plain copy their own words", () => {
    // Etched is etched whatever else the printing is called — `foilEffect`'s rule: the press
    // puts the etched drawing on the picture. And a foil word is never true of a plain copy.
    expect(finishChoiceWord("etched", '["surgefoil"]')).toBe("etched");
    expect(finishChoiceWord("nonfoil", '["surgefoil"]')).toBe("nonfoil");
  });
});

describe("finishChoiceLabel", () => {
  it("says the kind of foil on both arms", () => {
    expect(finishChoiceLabel("foil", false, '["surgefoil"]')).toBe("View as surge foil");
    expect(finishChoiceLabel("foil", true, '["surgefoil"]')).toBe("Set as surge foil");
  });

  it("keeps regular on the write arm and nonfoil on the view arm", () => {
    expect(finishChoiceLabel("nonfoil", true, '["surgefoil"]')).toBe("Set as regular");
    expect(finishChoiceLabel("nonfoil", false, '["surgefoil"]')).toBe("View as nonfoil");
    expect(finishChoiceLabel("etched", true, '["surgefoil"]')).toBe("Set as etched");
  });

  it("is unchanged for a printing with no kind of foil", () => {
    expect(finishChoiceLabel("foil", false, null)).toBe("View as foil");
    expect(finishChoiceLabel("foil", true, null)).toBe("Set as foil");
  });
});
