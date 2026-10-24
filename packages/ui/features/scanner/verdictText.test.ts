import { describe, expect, it } from "vitest";
import { VERDICTS, STATUS } from "./fixtures";
import type { ScannerVerdict } from "./types";
import {
  barFill,
  cameraSentence,
  headline,
  neuralSentence,
  shareLine,
  standingValue,
} from "./verdictText";

describe("the headline", () => {
  it("is the decided card's name, and otherwise says what the frame is", () => {
    expect(headline(VERDICTS.decided)).toBe("Storm of Saruman");
    expect(headline(VERDICTS.voting)).toBe("card located");
    expect(headline(VERDICTS.noCard)).toBe("no card");
    expect(headline(null)).toBe("looking…");
  });

  it("names the decision, not the agreement's leader, when the two differ", () => {
    const decision = VERDICTS.decided.decision;
    if (decision === null || decision.label === null) throw new Error("the premise: a decision");
    const another: ScannerVerdict = {
      ...VERDICTS.decided,
      decision: { ...decision, label: { ...decision.label, name: "Strider, Ranger of the North" } },
    };
    expect(headline(another)).toBe("Strider, Ranger of the North");
  });
});

describe("the agreement's numbers", () => {
  it("fills the bar with the confidence, capped at one", () => {
    expect(barFill(VERDICTS.voting.tracked)).toBeCloseTo(0.625);
    expect(barFill(VERDICTS.decided.tracked)).toBe(1);
    expect(barFill({ ...VERDICTS.decided.tracked!, confidence: 1.2 })).toBe(1);
    expect(barFill(null)).toBe(0);
  });

  it("writes the leader's votes over the bar and the frames read", () => {
    expect(shareLine(VERDICTS.voting.tracked)).toBe("1.3/2 · 3f");
    expect(shareLine(VERDICTS.decided.tracked)).toBe("2.0/2 · 2f");
    expect(shareLine(VERDICTS.noMatch.tracked)).toBe("0.0/2 · 3f");
    expect(shareLine(null)).toBe("—");
    expect(standingValue(VERDICTS.voting.tracked!.standings[0])).toBe("1.3");
  });
});

describe("the sentences", () => {
  it("keys the camera's three on the DOMException name", () => {
    expect(cameraSentence(new DOMException("x", "NotAllowedError")).message).toBe(
      "MTG Grimoire needs camera access to scan a card.",
    );
    expect(cameraSentence(new DOMException("x", "NotFoundError")).message).toBe(
      "No camera on this device.",
    );
    expect(cameraSentence(new Error("boom")).message).toBe("Camera error: Error.");
  });

  /**
   * **One sentence, for files that were there and did not load** — and none for files that are
   * not there, which are never a reader's to place: built into the binary, or fetched by a page.
   */
  it("says the recogniser did not load in the load's words, and nothing else", () => {
    expect(neuralSentence(STATUS.corrupt)).toBe(
      "The card recognizer did not load: gallery: bad magic.",
    );
    for (const status of [STATUS.present, STATUS.missing, STATUS.unlabelled, STATUS.store, null]) {
      expect(neuralSentence(status)).toBeNull();
    }
  });

  it("never tells a reader to place a file or to restart", () => {
    expect(neuralSentence(STATUS.corrupt)).not.toMatch(/Put |restart|data[\\/]scanner/i);
  });
});
