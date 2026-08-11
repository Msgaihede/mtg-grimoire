import { describe, expect, it } from "vitest";
import type { ValidationIssue } from "./validation/types";
import { ruleBreak, violationsByCard } from "./violations";

const issue = (over: Partial<ValidationIssue> = {}): ValidationIssue => ({
  severity: "error",
  code: "banned",
  message: "Mana Crypt is banned in Commander.",
  ...over,
});

describe("violationsByCard", () => {
  /**
   * The engine collapses rows that produce the same sentence into one finding whose
   * `cardIds` names all of them, which is right for a panel that lists sentences and exactly
   * wrong for a list that marks cards. This turns it back round.
   */
  it("lists one collapsed finding under every card it names", () => {
    const banned = issue({ cardIds: ["a", "b"] });
    const byCard = violationsByCard([banned]);

    expect([...byCard.keys()]).toEqual(["a", "b"]);
    expect(byCard.get("a")).toEqual([banned]);
    expect(byCard.get("b")).toEqual([banned]);
  });

  it("keeps every finding about one card, in the order the engine reported them", () => {
    const first = issue({ code: "singleton", message: "max 1 copy", cardIds: ["a"] });
    const second = issue({ code: "color-identity", message: "outside GW", cardIds: ["a"] });

    expect(violationsByCard([first, second]).get("a")).toEqual([first, second]);
  });

  /**
   * An issue about the deck itself carries no ids on purpose — highlighting sixty rows says
   * nothing the sentence did not — so it belongs to no card here either.
   */
  it("drops the findings that are about the deck rather than about a card", () => {
    const size = issue({ code: "deck-size", message: "Commander decks are exactly 100 cards." });

    expect(violationsByCard([size, issue({ cardIds: ["a"] })]).size).toBe(1);
  });

  it("answers an empty map for an empty deck", () => {
    expect(violationsByCard([]).size).toBe(0);
  });
});

describe("ruleBreak", () => {
  /**
   * The mark this feeds is the one the spec insists must not be confusable with a game
   * changer: one is a problem, the other is a fact about a powerful card. So only an
   * **error** draws it — a warning is a fact worth a look, and an orphaned row is not a rule
   * the reader broke.
   */
  it("reports the errors and ignores the warnings", () => {
    const warning = issue({ severity: "warning", code: "orphan", message: "Not in the database." });
    const error = issue({ message: "Mana Crypt is banned in Commander." });

    expect(ruleBreak([warning])).toBeNull();
    expect(ruleBreak([warning, error])).toBe("Mana Crypt is banned in Commander.");
  });

  /** Several sentences, one line: the mark is a tooltip, and a card can break two rules. */
  it("joins several sentences into one line", () => {
    expect(
      ruleBreak([
        issue({ message: "Mana Crypt is banned in Commander." }),
        issue({ code: "singleton", message: "Commander decks are singleton." }),
      ]),
    ).toBe("Mana Crypt is banned in Commander. Commander decks are singleton.");
  });

  /** A card with nothing wrong with it is the common case, and `undefined` is what a `Map`
   *  lookup answers for one — so the caller can hand the lookup straight in. */
  it("answers null for a card with nothing wrong with it", () => {
    expect(ruleBreak(undefined)).toBeNull();
    expect(ruleBreak([])).toBeNull();
  });
});
