import { describe, expect, it } from "vitest";
import type { ScannerDecision, ScannerFinishPref, ScannerTrayFinish } from "../types";
import { VERDICTS } from "../fixtures";
import {
  FINISH_PREF_LABEL,
  fitFinish,
  isKnownFinish,
  trayFinish,
  trayFinishChoices,
} from "./trayFinish";

const resolved = VERDICTS.decided.decision!;
const ambiguous = VERDICTS.ambiguous.decision!;

/** A resolved decision with only the one fact this module reads changed. */
function decided(finishes: string[]): ScannerDecision {
  return { ...resolved, finishes };
}

const TWO = ["nonfoil", "foil"];
const THREE = ["nonfoil", "foil", "etched"];

describe("trayFinish", () => {
  /**
   * **The whole rule as one table**, so a row that changes is a row a reader can see changed.
   * `[finishes, answer]`, all under Detect.
   */
  const detect: [string, string[], ScannerTrayFinish][] = [
    // One finish is that finish.
    ["nonfoil-only", ["nonfoil"], "nonfoil"],
    ["foil-only", ["foil"], "foil"],
    ["etched-only", ["etched"], "etched"],
    // Several, or the corpus silent, is the reader's to settle.
    ["two finishes", TWO, "unknown"],
    ["three finishes", THREE, "unknown"],
    ["the corpus silent", [], "unknown"],
    ["a finish this app does not know, alone", ["glossy"], "unknown"],
  ];

  it.each(detect)("under Detect: %s", (_, finishes, answer) => {
    expect(trayFinish("detect", decided(finishes))).toBe(answer);
  });

  /** A fixed finish is the reader saying the pile is one finish; the camera does not overrule it. */
  it.each(["nonfoil", "foil", "etched"] as const)(
    "a fixed %s is the answer wherever it was made",
    (pref) => {
      for (const finishes of [[pref], ["nonfoil", "foil", "etched"], []]) {
        expect(trayFinish(pref, decided([...finishes]))).toBe(pref);
      }
    },
  );

  /**
   * **The corpus does overrule it** (issue #982): a preference the printing was never made in is
   * no answer for that card, which is decided as Detect would decide it.
   */
  it("decides a fixed finish the printing was never made in as Detect would", () => {
    expect(trayFinish("nonfoil", decided(["foil"]))).toBe("foil");
    expect(trayFinish("foil", decided(["nonfoil"]))).toBe("nonfoil");
    expect(trayFinish("etched", decided(TWO))).toBe("unknown");
  });

  /**
   * **An ambiguous decision's finishes are the provisional printing's**, which a pick can replace,
   * so Detect does not read them: the row asks.
   */
  it("leaves an ambiguous decision's finish to the reader under Detect", () => {
    expect(ambiguous.choices.length).toBeGreaterThan(0);
    expect(trayFinish("detect", { ...ambiguous, finishes: ["foil"] })).toBe("unknown");
    expect(trayFinish("detect", { ...ambiguous, finishes: TWO })).toBe("unknown");
    // A fixed finish still stands, as for any card.
    expect(trayFinish("foil", { ...ambiguous, finishes: ["nonfoil"] })).toBe("foil");
  });

  it("knows unknown from a finish, and names Detect first", () => {
    expect(isKnownFinish("unknown")).toBe(false);
    expect(["nonfoil", "foil", "etched"].every((f) => isKnownFinish(f as ScannerTrayFinish))).toBe(
      true,
    );
    expect(Object.keys(FINISH_PREF_LABEL)[0]).toBe("detect" satisfies ScannerFinishPref);
  });

  /** What a row's finish control offers, and what a finish becomes on a printing (issue #982). */
  it("offers only the finishes a printing exists in, in the app's order, then Unknown", () => {
    expect(trayFinishChoices(["foil"])).toEqual(["foil", "unknown"]);
    expect(trayFinishChoices(["etched", "nonfoil"])).toEqual(["nonfoil", "etched", "unknown"]);
    // The corpus silent — or a row written before rows carried finishes — offers everything.
    for (const silent of [[], undefined, ["glossy"]]) {
      expect(trayFinishChoices(silent)).toEqual(["nonfoil", "foil", "etched", "unknown"]);
    }
  });

  it("fits a finish to a printing: its sole finish, the same finish, or the question again", () => {
    expect(fitFinish("nonfoil", ["foil"])).toBe("foil");
    expect(fitFinish("unknown", ["etched"])).toBe("etched");
    expect(fitFinish("foil", TWO)).toBe("foil");
    expect(fitFinish("unknown", TWO)).toBe("unknown");
    expect(fitFinish("etched", TWO)).toBe("unknown");
    expect(fitFinish("etched", [])).toBe("etched");
  });
});
