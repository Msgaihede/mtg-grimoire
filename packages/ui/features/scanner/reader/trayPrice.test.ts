import { describe, expect, it } from "vitest";
import type { FinishPrices, ScannerTrayRow } from "@/lib/ipc";
import { VERDICTS } from "../fixtures";
import { rowFromDecision } from "./tray";
import { trayPriceIds, trayPriceMap, trayRowPrice } from "./trayPrice";

const resolved = VERDICTS.exactResolved.decision!;
const ambiguous = VERDICTS.exactAmbiguous.decision!;

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
    const rows = [row({ cardId: "b" }), waiting, row({ cardId: "a" }), row({ cardId: "b", key: "again" })];
    expect(waiting.choices.length).toBeGreaterThan(0);
    expect(trayPriceIds(rows)).toEqual(["a", "b"]);
  });
});
