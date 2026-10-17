import { describe, expect, it } from "vitest";
import { gapWords, supportSentence } from "./support";

describe("gapWords", () => {
  it("words phase's coverage labels", () => {
    expect(gapWords("Trigger:Whenever the moon is full")).toBe(
      "Trigger: Whenever the moon is full",
    );
    expect(gapWords("Effect:unrecognized_clause_head")).toBe("Effect: unrecognized clause head");
    expect(gapWords("Static:Prevention")).toBe("Static ability: Prevention");
    expect(gapWords("AdditionalCost:Kicker")).toBe("Additional cost: Kicker");
    expect(gapWords("SilentDrop:2_of_3")).toBe("Reads 2 of 3 lines of rules text");
  });

  it("keeps a kind it does not know, split into words", () => {
    expect(gapWords("FutureThing:some_detail")).toBe("Future Thing: some detail");
    expect(gapWords("Effect:")).toBe("Effect");
    expect(gapWords("Bare")).toBe("Bare");
  });
});

describe("supportSentence", () => {
  const card = {
    cardId: "a",
    name: "A",
    quantity: 1,
    commander: false,
    gaps: ["Effect:x"],
  };

  it("counts the cards played whole and in part", () => {
    expect(supportSentence({ cards: 60, unsupported: [] })).toBe(
      "The rules engine plays all 60 cards.",
    );
    expect(supportSentence({ cards: 1, unsupported: [] })).toBe(
      "The rules engine plays its one card.",
    );
    expect(supportSentence({ cards: 60, unsupported: [card] })).toBe(
      "The rules engine plays 59 of 60 cards in full; 1 card is played only in part.",
    );
    expect(supportSentence({ cards: 60, unsupported: [card, { ...card, name: "B" }] })).toBe(
      "The rules engine plays 58 of 60 cards in full; 2 cards are played only in part.",
    );
  });
});
