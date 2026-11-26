import { describe, expect, it } from "vitest";
import type { PlaytestResults } from "@/lib/ipc";
import { canKeepResults, resultsConfirm, resultsTitle, resultWord, toggleResult } from "./results";

const coins: PlaytestResults = { dice: false, results: [1, 0], eligible: [0, 1], count: 1 };
const dice: PlaytestResults = { dice: true, results: [2, 5, 2], eligible: [0, 2], count: 1 };

describe("flips kept and rolls ignored", () => {
  it("says each result and what to do", () => {
    expect(coins.results.map((r) => resultWord(coins, r))).toEqual(["Heads", "Tails"]);
    expect(resultWord(dice, 5)).toBe("5");
    expect(resultsTitle(coins)).toBe("Keep 1 of 2 flips");
    expect(resultsTitle(dice)).toBe("Ignore 1 of 3 rolls");
    expect(resultsConfirm(coins)).toBe("Keep it");
    expect(resultsConfirm({ dice: true, count: 2 })).toBe("Ignore 2");
  });

  it("picks only eligible results, exactly the count", () => {
    expect(toggleResult(dice, [], 1)).toEqual([]);
    expect(toggleResult(dice, [], 0)).toEqual([0]);
    // One to name: a click moves it.
    expect(toggleResult(dice, [0], 2)).toEqual([2]);
    expect(toggleResult(dice, [2], 2)).toEqual([]);
    const two = { ...coins, results: [1, 0, 1], eligible: [0, 1, 2], count: 2 };
    expect(toggleResult(two, [0, 1], 2)).toEqual([0, 1]);
    expect(canKeepResults(two, [0])).toBe(false);
    expect(canKeepResults(two, [0, 2])).toBe(true);
  });
});
