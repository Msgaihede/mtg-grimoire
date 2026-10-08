import { describe, expect, it } from "vitest";
import type { CardCombo, CardCombosPage, ComboPiece, ComboStatus } from "@/lib/ipc";
import {
  bracketRange,
  bracketSentence,
  COMBOS_NEVER_FETCHED,
  COMBOS_NONE,
  emptyCombosSentence,
  missingCount,
  nextComboOffset,
  otherPieces,
  ownedNote,
  ownedSummary,
  splitLines,
} from "./combos";

function piece(over: Partial<ComboPiece> = {}): ComboPiece {
  return {
    oracleId: "o1",
    name: "Boros Reckoner",
    quantity: 1,
    mustBeCommander: false,
    cardId: "c1",
    owned: 1,
    ...over,
  };
}

function combo(pieces: ComboPiece[]): CardCombo {
  return {
    id: "1-2",
    bracketTag: "R",
    cardCount: pieces.length,
    templateCount: 0,
    identity: "RW",
    produces: "Infinite damage",
    description: "",
    easyPrerequisites: "",
    notablePrerequisites: "",
    manaNeeded: "",
    popularity: 10,
    pieces,
  };
}

function page(rows: number, matching: number): CardCombosPage {
  return {
    total: matching,
    matching,
    ownedTotal: 0,
    byCardCount: [],
    combos: Array.from({ length: rows }, () => combo([piece()])),
  };
}

const status = (fetchedAt: number | null): ComboStatus => ({
  combos: fetchedAt === null ? 0 : 7,
  cards: fetchedAt === null ? 0 : 12,
  stamp: null,
  fetchedAt,
  checkedAt: fetchedAt,
  stale: fetchedAt === null,
});

describe("nextComboOffset", () => {
  it("asks for the next page while fewer rows are in hand than match", () => {
    expect(nextComboOffset([page(50, 120)])).toBe(50);
    expect(nextComboOffset([page(50, 120), page(50, 120)])).toBe(100);
  });

  it("stops at the count, and at a short or empty page whatever the count says", () => {
    expect(nextComboOffset([page(50, 50)])).toBeUndefined();
    expect(nextComboOffset([page(50, 120), page(0, 120)])).toBeUndefined();
  });
});

describe("the brackets, as a range and as a sentence", () => {
  it("says a contiguous run by its ends, and a banned combo in words", () => {
    expect(bracketRange([2, 3, 4, 5])).toBe("2–5");
    expect(bracketRange([])).toBe("Not legal");
    expect(bracketSentence([4, 5])).toBe("Legal in brackets 4 and 5");
    expect(bracketSentence([5])).toBe("Legal in bracket 5");
    expect(bracketSentence([])).toBe("Not legal in Commander");
  });
});

describe("the pieces", () => {
  it("names the other cards, and the card itself only where it is the whole combo", () => {
    const charm = piece({ oracleId: "o2", name: "Boros Charm" });
    expect(otherPieces(combo([piece(), charm]), "o1")).toEqual([charm]);
    expect(otherPieces(combo([piece()]), "o1")).toEqual([piece()]);
  });

  it("counts a piece as missing when fewer copies are held than asked for", () => {
    const pair = combo([piece({ owned: 1, quantity: 2 }), piece({ oracleId: "o2", owned: 0 })]);
    expect(missingCount(pair)).toBe(2);
    expect(ownedSummary(2)).toBe("Missing 2");
    expect(ownedSummary(0)).toBe("You own every piece");
  });

  it("says what the reader has of one piece, partial copies included", () => {
    expect(ownedNote(0, 1)).toBe("Not owned");
    expect(ownedNote(1, 2)).toBe("1 of 2 owned");
    expect(ownedNote(2, 2)).toBe("Owned");
  });
});

describe("splitLines", () => {
  it("drops blank lines, so an all-blank field draws nothing", () => {
    expect(splitLines("Tap X.\n\n Untap Y. \n")).toEqual(["Tap X.", "Untap Y."]);
    expect(splitLines("\n\n")).toEqual([]);
  });
});

describe("emptyCombosSentence", () => {
  it("says the list was never downloaded rather than that the card is in none", () => {
    expect(emptyCombosSentence(status(null))).toBe(COMBOS_NEVER_FETCHED);
    expect(emptyCombosSentence(undefined)).toBe(COMBOS_NEVER_FETCHED);
  });

  it("says Spellbook has none once the list is here", () => {
    expect(emptyCombosSentence(status(1_800_000_000))).toBe(COMBOS_NONE);
    expect(COMBOS_NONE).not.toBe(COMBOS_NEVER_FETCHED);
  });
});
