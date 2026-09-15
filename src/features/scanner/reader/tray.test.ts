import { describe, expect, it } from "vitest";
import {
  addDecision,
  importItems,
  pickChoice,
  removeRow,
  rowFromDecision,
  setFinish,
  setPrinting,
  setQuantity,
  totalCopies,
  unresolvedCount,
} from "./tray";
import { VERDICTS } from "../fixtures";

const resolved = VERDICTS.exactResolved.decision!;
const ambiguous = VERDICTS.exactAmbiguous.decision!;

describe("tray", () => {
  it("adds a resolved decision as a new newest row with the default finish", () => {
    const { rows, bumped } = addDecision([], resolved, { finish: "foil" }, 1, "a");
    expect(bumped).toBe(false);
    expect(rows[0]).toMatchObject({ key: "a", cardId: resolved.printing, quantity: 1, finish: "foil", choices: [] });
  });

  it("bumps the newest row when the same printing is decided again", () => {
    const first = addDecision([], resolved, { finish: "nonfoil" }, 1, "a").rows;
    const { rows, bumped } = addDecision(first, resolved, { finish: "nonfoil" }, 2, "b");
    expect(bumped).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(2);
  });

  it("keeps the bumped row's key and refreshes its stamp, so a flash can replay", () => {
    const first = addDecision([], resolved, { finish: "nonfoil" }, 1, "a").rows;
    const { rows } = addDecision(first, resolved, { finish: "nonfoil" }, 7, "b");
    expect(rows[0]).toMatchObject({ key: "a", addedAt: 7 });
  });

  it("adds a new row rather than bumping one in a different finish", () => {
    const foil = setFinish(addDecision([], resolved, { finish: "nonfoil" }, 1, "a").rows, "a", "foil");
    const { rows, bumped } = addDecision(foil, resolved, { finish: "nonfoil" }, 2, "b");
    expect(bumped).toBe(false);
    expect(rows.map((r) => [r.key, r.finish, r.quantity])).toEqual([
      ["b", "nonfoil", 1],
      ["a", "foil", 1],
    ]);
  });

  it("bumps only the newest row, never one further down", () => {
    const one = addDecision([], resolved, { finish: "nonfoil" }, 1, "a").rows;
    const two = addDecision(one, ambiguous, { finish: "nonfoil" }, 2, "b").rows;
    const { rows, bumped } = addDecision(two, resolved, { finish: "nonfoil" }, 3, "c");
    expect(bumped).toBe(false);
    expect(rows.map((r) => r.key)).toEqual(["c", "b", "a"]);
    expect(rows[2].quantity).toBe(1);
  });

  it("never bumps a row that is still waiting for a pick", () => {
    const first = addDecision([], ambiguous, { finish: "nonfoil" }, 1, "a").rows;
    expect(addDecision(first, ambiguous, { finish: "nonfoil" }, 2, "b").rows).toHaveLength(2);
  });

  it("an ambiguous decision carries its choices and counts as unresolved until picked", () => {
    const rows = addDecision([], ambiguous, { finish: "nonfoil" }, 1, "a").rows;
    expect(rows[0].choices).toHaveLength(3);
    expect(unresolvedCount(rows)).toBe(1);
    const picked = pickChoice(rows, "a", ambiguous.choices[2].id);
    expect(picked[0].cardId).toBe(ambiguous.choices[2].id);
    expect(unresolvedCount(picked)).toBe(0);
  });

  it("wears the first candidate provisionally while it waits", () => {
    const row = rowFromDecision(ambiguous, { finish: "nonfoil" }, 1, "a");
    expect(row.cardId).toBe(ambiguous.choices[0].id);
    expect(row.choices.map((c) => c.cardId)).toEqual(ambiguous.choices.map((c) => c.id));
  });

  it("leaves a row alone when a pick names no candidate it offers", () => {
    const rows = addDecision([], ambiguous, { finish: "nonfoil" }, 1, "a").rows;
    expect(pickChoice(rows, "a", "not-a-candidate")[0]).toEqual(rows[0]);
  });

  it("names a decision with no label as an unknown card", () => {
    const row = rowFromDecision({ ...resolved, label: null }, { finish: "nonfoil" }, 1, "a");
    expect(row).toMatchObject({ name: "Unknown card", setCode: "", collectorNumber: "" });
  });

  it("adopts a printing chosen from outside the row's candidates and closes the question", () => {
    const rows = addDecision([], ambiguous, { finish: "nonfoil" }, 1, "a").rows;
    const chosen = {
      cardId: "elsewhere",
      oracleId: "o-elsewhere",
      name: "Somewhere Else",
      setCode: "lea",
      collectorNumber: "1",
    };
    expect(setPrinting(rows, "a", chosen)[0]).toMatchObject({ ...chosen, choices: [] });
  });

  it("changes one row's finish and no other's", () => {
    const rows = addDecision(
      addDecision([], resolved, { finish: "nonfoil" }, 1, "a").rows,
      ambiguous,
      { finish: "nonfoil" },
      2,
      "b",
    ).rows;
    const next = setFinish(rows, "a", "etched");
    expect(next.find((r) => r.key === "a")?.finish).toBe("etched");
    expect(next.find((r) => r.key === "b")?.finish).toBe("nonfoil");
  });

  it("clamps quantity to at least one", () => {
    const rows = addDecision([], resolved, { finish: "nonfoil" }, 1, "a").rows;
    expect(setQuantity(rows, "a", 0)[0].quantity).toBe(1);
    expect(setQuantity(rows, "a", Number.NaN)[0].quantity).toBe(1);
    expect(setQuantity(rows, "a", 4)[0].quantity).toBe(4);
  });

  it("builds import items and refuses while a row is unresolved", () => {
    const rows = addDecision([], resolved, { finish: "etched" }, 1, "a").rows;
    expect(importItems(rows, "NM")).toEqual([{ cardId: resolved.printing, quantity: 1, finish: "etched", condition: "NM" }]);
    const mixed = addDecision(rows, ambiguous, { finish: "nonfoil" }, 2, "b").rows;
    expect(() => importItems(mixed, "NM")).toThrow();
  });

  it("counts copies and removes rows", () => {
    const rows = addDecision(addDecision([], resolved, { finish: "nonfoil" }, 1, "a").rows, resolved, { finish: "nonfoil" }, 2, "b").rows;
    expect(totalCopies(rows)).toBe(2);
    expect(removeRow(rows, "a")).toHaveLength(0);
  });
});
