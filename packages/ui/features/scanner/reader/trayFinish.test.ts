import { describe, expect, it } from "vitest";
import type { ScannerDecision, ScannerFinishMark, ScannerFinishPref, ScannerTrayFinish } from "../types";
import { MARKS, VERDICTS } from "../fixtures";
import { FINISH_PREF_LABEL, isKnownFinish, trayFinish } from "./trayFinish";

const resolved = VERDICTS.decided.decision!;
const ambiguous = VERDICTS.exactAmbiguous.decision!;

/** A resolved decision with only the two facts this module reads changed. */
function decided(finishes: string[], finish_mark: ScannerFinishMark | null): ScannerDecision {
  return { ...resolved, finishes, finish_mark };
}

const { dot, star, unmeasured } = MARKS;
/** Measured, and between the dot's cut and the star's — the crate's own `Unknown` with figures. */
const between: ScannerFinishMark = { reading: "unknown", height: 0.7, area: 0.24, solidity: 1.02 };

const TWO = ["nonfoil", "foil"];
const THREE = ["nonfoil", "foil", "etched"];

describe("trayFinish", () => {
  /**
   * **The whole rule as one table**, so a row that changes is a row a reader can see changed.
   * `[finishes, mark, answer]`, all under Detect.
   */
  const detect: [string, string[], ScannerFinishMark | null, ScannerTrayFinish][] = [
    // Rung 1 — one finish is that finish, and no read can argue.
    ["nonfoil-only, no read", ["nonfoil"], null, "nonfoil"],
    ["foil-only, no read", ["foil"], null, "foil"],
    ["foil-only, read as a dot", ["foil"], dot, "foil"],
    ["nonfoil-only, read as a star", ["nonfoil"], star, "nonfoil"],
    ["etched-only, read as a star", ["etched"], star, "etched"],
    // Rung 2 — the mark, where the printing exists in what it read.
    ["two finishes, a dot", TWO, dot, "nonfoil"],
    ["two finishes, a star", TWO, star, "foil"],
    ["three finishes, a star", THREE, star, "foil"],
    ["three finishes, a dot", THREE, dot, "nonfoil"],
    ["the corpus silent, a star", [], star, "foil"],
    ["the corpus silent, a dot", [], dot, "nonfoil"],
    // A contradiction is a misread, so it asks.
    ["nonfoil and etched, a star", ["nonfoil", "etched"], star, "unknown"],
    ["foil and etched, a dot", ["foil", "etched"], dot, "unknown"],
    // Rung 3 — nothing to go on.
    ["two finishes, no band read", TWO, null, "unknown"],
    ["two finishes, no separator found", TWO, unmeasured, "unknown"],
    ["two finishes, a mark between the cuts", TWO, between, "unknown"],
    ["the corpus silent, no read", [], null, "unknown"],
    ["a finish this app does not know, alone", ["glossy"], null, "unknown"],
  ];

  it.each(detect)("under Detect: %s", (_, finishes, mark, answer) => {
    expect(trayFinish("detect", decided(finishes, mark))).toBe(answer);
  });

  /** **Etched is never read off the mark** — a star says foil, and never which foil. */
  it("never infers etched from a star, even on an etched-and-foil printing", () => {
    expect(trayFinish("detect", decided(["foil", "etched"], star))).toBe("foil");
    expect(trayFinish("detect", decided(["etched", "nonfoil"], star))).toBe("unknown");
  });

  /** A fixed finish is the reader saying the pile is one finish; the camera does not overrule it. */
  it.each(["nonfoil", "foil", "etched"] as const)("a fixed %s is the answer whatever was read", (pref) => {
    for (const [finishes, mark] of [
      [["foil"], star],
      [["nonfoil"], dot],
      [TWO, null],
      [[], unmeasured],
    ] as const) {
      expect(trayFinish(pref, decided([...finishes], mark))).toBe(pref);
    }
  });

  /**
   * **An ambiguous decision's finishes are the provisional printing's**, which a pick can replace,
   * so neither the single-finish rung nor the contradiction check reads them. The mark is a fact
   * about the cardboard and still stands.
   */
  it("reads an ambiguous decision by its mark alone", () => {
    const provisional = (finishes: string[], finish_mark: ScannerFinishMark | null) => ({
      ...ambiguous,
      finishes,
      finish_mark,
    });
    expect(ambiguous.choices.length).toBeGreaterThan(0);
    expect(trayFinish("detect", provisional(["foil"], null))).toBe("unknown");
    expect(trayFinish("detect", provisional(["nonfoil"], star))).toBe("foil");
    expect(trayFinish("detect", provisional(TWO, dot))).toBe("nonfoil");
  });

  it("knows unknown from a finish, and names Detect first", () => {
    expect(isKnownFinish("unknown")).toBe(false);
    expect(["nonfoil", "foil", "etched"].every((f) => isKnownFinish(f as ScannerTrayFinish))).toBe(true);
    expect(Object.keys(FINISH_PREF_LABEL)[0]).toBe("detect" satisfies ScannerFinishPref);
  });
});
