import { describe, expect, it } from "vitest";
import { listName } from "./listNames";

/**
 * The three answers, and the sentences they are answers *for*.
 *
 * This module is one line of code and four call sites, so what is worth pinning is not the
 * branch — it is that each answer reads as English in the sentence its caller wraps it in. Every
 * case below quotes the caller's own template, because a wording that is right in isolation and
 * wrong in `Clear the …?` is exactly the failure a bare equality test passes over.
 */
describe("listName", () => {
  it("names each of a two-list deck's lists", () => {
    expect(listName("live")).toBe("actual list");
    expect(listName("theory")).toBe("theory list");
  });

  /**
   * **`Actual`, never `Live`** — issue #357, which is the whole reason this function exists. The
   * stored variant is still `live` in the column, in the IPC and in `DeckVariant`; this is the
   * join between that value and the word on screen, so the assertion is on the *word*.
   */
  it("says actual rather than live, which is the value and not the word", () => {
    expect(listName("live")).not.toMatch(/live/i);
  });

  /**
   * **A virtual deck has one list, so it is not told apart from anything** (issue #401). The
   * Theory/Actual vocabulary exists to say *which* of two lists a sentence is about, and a deck
   * that draws no variant tabs has no second list for the reader to have confused it with.
   */
  it("calls a virtual deck's one list the deck", () => {
    expect(listName("live", { virtual: true })).toBe("deck");
  });

  /**
   * **The variant is ignored under `{ virtual: true }` rather than asserted about.** A virtual
   * deck's rows are `live` by construction — `deckKind.ts`'s table has no row with both flags set,
   * so the kind keeps no plan — and this pins that a caller holding the deck's kind may pass
   * whichever variant it happens to have without getting a plan's vocabulary back.
   */
  it("answers the same for either variant once the deck is virtual", () => {
    expect(listName("theory", { virtual: true })).toBe("deck");
  });

  /**
   * **Absent and `false` are the same statement**, which is what kept every existing call site
   * saying what it said: `decks.virtual_only DEFAULT 0` is the state every deck predating schema
   * v40 is in, and `ClearCategory`, `ClearDeck` and `auditText` all called this with one argument
   * before the kind existed.
   */
  it("treats an absent option and an explicit false alike", () => {
    expect(listName("live", {})).toBe(listName("live"));
    expect(listName("live", { virtual: false })).toBe(listName("live"));
    expect(listName("theory", { virtual: false })).toBe(listName("theory"));
  });

  /**
   * **No article and no capital**, which is the contract every caller depends on: each writes its
   * own `the`, and each drops the answer mid-sentence. `ClearDeck` writes `Clear the {…}?`,
   * `ClearCategory` writes `The N cards in it leave the {…}`, `auditText`'s `clearedFrom` writes
   * `the {…}`, and Deck settings' button writes `Clear {…}…`. An answer that carried either would
   * print *Clear the the actual list?* in three places at once.
   */
  it("carries no article and no capital, in all three answers", () => {
    for (const answer of [
      listName("live"),
      listName("theory"),
      listName("live", { virtual: true }),
    ]) {
      expect(answer).not.toMatch(/^(the|a) /i);
      expect(answer[0]).toBe(answer[0]?.toLowerCase());
    }
  });

  /**
   * The four sentences as their callers actually build them, virtual and not — the check that the
   * chosen wording reads at every site rather than only at the one it was picked for.
   *
   * `Clear deck…` is Deck settings' button (`Clear {…}…`, which is where the reader meets this
   * answer first), and the other three are the two confirmations and the history line.
   */
  it("reads as English in every sentence that wraps it", () => {
    const virtual = { virtual: true } as const;
    expect(`Clear the ${listName("live", virtual)}?`).toBe("Clear the deck?");
    expect(`Clear ${listName("live", virtual)}…`).toBe("Clear deck…");
    expect(`The 3 cards in it leave the ${listName("live", virtual)}`).toBe(
      "The 3 cards in it leave the deck",
    );
    expect(`the ${listName("live", virtual)}`).toBe("the deck");

    // And the two-list deck's, unchanged — the regression half, since these are the sentences
    // every existing deck still reads.
    expect(`Clear the ${listName("theory")}?`).toBe("Clear the theory list?");
    expect(`Clear ${listName("live")}…`).toBe("Clear actual list…");
  });
});
