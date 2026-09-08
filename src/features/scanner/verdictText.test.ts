import { describe, expect, it } from "vitest";
import { VERDICTS, STATUS } from "./fixtures";
import {
  barFill,
  bundleSentence,
  cameraSentence,
  headline,
  leadLine,
  modelsSentence,
  shareLine,
  standingValue,
  verdictWord,
} from "./verdictText";

describe("the headline", () => {
  it("is the decided card's name, and otherwise says what the frame is", () => {
    expect(headline(VERDICTS.decided)).toBe("Storm of Saruman");
    expect(headline(VERDICTS.voting)).toBe("card located");
    expect(headline(VERDICTS.noCard)).toBe("no card");
    expect(headline(null)).toBe("looking…");
  });
});

describe("the vote rule's numbers", () => {
  it("fills the bar with votes over the bar, capped at one", () => {
    expect(barFill(VERDICTS.voting.tracked)).toBeCloseTo(5 / 8);
    expect(barFill(VERDICTS.decided.tracked)).toBe(1);
    expect(barFill(VERDICTS.confidence.tracked)).toBeCloseTo(0.8);
    expect(barFill(null)).toBe(0);
  });

  it("writes the tally, the frames and the lead the way the debug page does", () => {
    expect(shareLine(VERDICTS.voting.tracked)).toBe("5.0/8 · 12f");
    expect(shareLine(VERDICTS.confidence.tracked)).toBe("80% over 12f");
    expect(leadLine(VERDICTS.voting.tracked)).toBe("×4.0");
    expect(leadLine(VERDICTS.decided.tracked)).toBe("unopposed");
    expect(leadLine(VERDICTS.confidence.tracked)).toBe("—");
    expect(verdictWord(VERDICTS.decided.tracked)).toBe("decided");
    expect(verdictWord(VERDICTS.voting.tracked)).toBe("voting");
    expect(verdictWord(VERDICTS.confidence.tracked)).toBe("confirmed");
    expect(standingValue(VERDICTS.voting.tracked!.standings[0], "votes")).toBe("5.0");
    expect(standingValue(VERDICTS.confidence.tracked!.standings[0], "confidence")).toBe("90%");
  });
});

describe("the sentences", () => {
  it("keys the camera's three on the DOMException name", () => {
    expect(cameraSentence(new DOMException("x", "NotAllowedError")).message).toBe(
      "MTG Grimoire needs camera access to scan a card.",
    );
    expect(cameraSentence(new DOMException("x", "NotFoundError")).message).toBe("No camera on this device.");
    expect(cameraSentence(new Error("boom")).message).toBe("Camera error: Error.");
  });

  it("names the missing file and where it looked", () => {
    expect(bundleSentence(STATUS.present)).toBeNull();
    expect(bundleSentence(STATUS.missing)).toBe(
      `No reference bundle. Put \`card-hashes.bin\` at ${STATUS.missing.bundle.path}.`,
    );
    expect(modelsSentence(STATUS.noModels)).toBe(
      `No OCR models. Put \`text-detection.rten\` and \`text-recognition.rten\` at ${STATUS.noModels.detection_model.path}.`,
    );
    expect(modelsSentence(STATUS.present)).toBeNull();
  });
});
