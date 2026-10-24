import { describe, expect, it } from "vitest";
import type { FinishPrices, ScannerTrayRow } from "@/lib/ipc";
import { VERDICTS } from "../fixtures";
import { landedFrom } from "./AddedToast";
import { rowFromDecision } from "./tray";
import {
  formatPriceSpan,
  landedPrice,
  landedPriceIds,
  trayPriceIds,
  trayPriceMap,
  trayRowPrice,
} from "./trayPrice";

const resolved = VERDICTS.resolved.decision!;
const ambiguous = VERDICTS.ambiguous.decision!;

const base = rowFromDecision(resolved, { finish: "nonfoil" }, 1, "base");
const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 2, "waiting");

function row(over: Partial<ScannerTrayRow>): ScannerTrayRow {
  return { ...base, ...over };
}

function priced(cardId: string, finishPrices: FinishPrices) {
  return trayPriceMap([{ cardId, finishPrices }]);
}

describe("trayRowPrice", () => {
  const all = priced("c1", { nonfoil: 1.5, foil: 4, etched: 9 });

  it("quotes the row's own finish and no other", () => {
    expect(trayRowPrice(row({ cardId: "c1", finish: "nonfoil" }), all)).toBe(1.5);
    expect(trayRowPrice(row({ cardId: "c1", finish: "foil" }), all)).toBe(4);
    expect(trayRowPrice(row({ cardId: "c1", finish: "etched" }), all)).toBe(9);
  });

  it("never reaches for another finish when the named one is unquoted", () => {
    const nonfoilOnly = priced("c1", { nonfoil: 1.5, foil: null, etched: null });
    expect(trayRowPrice(row({ cardId: "c1", finish: "foil" }), nonfoilOnly)).toBeNull();
  });

  it("prices an unknown finish along nonfoil → foil → etched", () => {
    expect(trayRowPrice(row({ cardId: "c1", finish: "unknown" }), all)).toBe(1.5);
    const foilOnly = priced("c1", { nonfoil: null, foil: 4, etched: null });
    expect(trayRowPrice(row({ cardId: "c1", finish: "unknown" }), foilOnly)).toBe(4);
    const none = priced("c1", { nonfoil: null, foil: null, etched: null });
    expect(trayRowPrice(row({ cardId: "c1", finish: "unknown" }), none)).toBeNull();
  });

  it("reads a printing the answer does not hold as unpriced", () => {
    expect(trayRowPrice(row({ cardId: "elsewhere", finish: "nonfoil" }), all)).toBeNull();
  });
});

describe("trayPriceIds", () => {
  it("asks for each resolved printing once, sorted, and nothing for a waiting row", () => {
    const rows = [
      row({ cardId: "b" }),
      waiting,
      row({ cardId: "a" }),
      row({ cardId: "b", key: "again" }),
    ];
    expect(waiting.choices.length).toBeGreaterThan(0);
    expect(trayPriceIds(rows)).toEqual(["a", "b"]);
  });
});

describe("the scan popup's price (issue #1321)", () => {
  const choices = [
    { cardId: "c3", oracleId: null, name: "X", setCode: "a", collectorNumber: "3" },
    { cardId: "c1", oracleId: null, name: "X", setCode: "b", collectorNumber: "1" },
    { cardId: "c2", oracleId: null, name: "X", setCode: "c", collectorNumber: "2" },
  ];
  const settled = landedFrom(row({ cardId: "c1", finish: "foil" }), false, false);
  const pick = landedFrom(row({ cardId: "c3", finish: "nonfoil", choices }), false, false);
  const prices = trayPriceMap([
    { cardId: "c1", finishPrices: { nonfoil: 1.5, foil: 4, etched: null } },
    { cardId: "c2", finishPrices: { nonfoil: 0.25, foil: 9, etched: null } },
    { cardId: "c3", finishPrices: { nonfoil: null, foil: 30, etched: null } },
  ]);

  it("asks about the filed card alone, or every candidate of a pick, sorted", () => {
    expect(landedPriceIds(settled)).toEqual(["c1"]);
    expect(landedPriceIds(pick)).toEqual(["c1", "c2", "c3"]);
  });

  it("quotes a settled card at its own finish, as one figure", () => {
    expect(landedPrice(settled, prices)).toEqual({ low: 4, high: 4 });
  });

  it("spans a pick's candidates in the landing's finish, leaving the unquoted out", () => {
    // c3 has no nonfoil figure: it is left out of the span, never read as free or as its foil.
    expect(landedPrice(pick, prices)).toEqual({ low: 0.25, high: 1.5 });
  });

  it("is unpriced when nothing is quoted", () => {
    expect(landedPrice(pick, trayPriceMap([]))).toBeNull();
  });

  it("writes one figure for a span whose ends meet, and both ends otherwise", () => {
    expect(formatPriceSpan({ low: 4, high: 4 }, "usd")).toBe("$4.00");
    expect(formatPriceSpan({ low: 0.25, high: 1.5 }, "usd")).toBe("$0.25 – $1.50");
  });
});
