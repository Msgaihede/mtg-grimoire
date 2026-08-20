import { describe, expect, it } from "vitest";
import { deckDestination } from "./destinations/deckInto";
import { newDeckDestination } from "./destinations/newDeck";

/**
 * Every destination the dialog can be handed.
 *
 * `collection` and `wishlist` arrive in Task 14; until then this array holds the two that exist
 * and the test is still the contract. The deck's entry is **built**, because that destination
 * closes over the deck it writes into — a bare `deckDestination` value would be one that
 * type-checks and crashes wherever anybody mounted it, which is the whole reason it is a
 * function.
 */
const ALL = [deckDestination({ deckId: 1, variant: "live" }), newDeckDestination];

describe("every destination", () => {
  it("has a unique key and a label the radio group can show", () => {
    expect(new Set(ALL.map((d) => d.key)).size).toBe(ALL.length);
    for (const d of ALL) expect(d.label).not.toBe("");
  });

  it("is a component, so the shell needs no knowledge of which one it holds", () => {
    for (const d of ALL) expect(typeof d.Preview).toBe("function");
  });

  /** Optional, because a destination whose line names nothing the shell cannot say leaves the
   *  host's fallback in place — the new deck, which has no deck to name yet. */
  it("says its own header line, or leaves it to the host", () => {
    for (const d of ALL) {
      expect(d.Subtitle === undefined || typeof d.Subtitle === "function").toBe(true);
    }
  });
});
