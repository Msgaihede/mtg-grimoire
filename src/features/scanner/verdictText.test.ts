import { describe, expect, it } from "vitest";
import { VERDICTS, STATUS } from "./fixtures";
import type { ScannerStatus } from "./types";
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

/**
 * The clause every asset sentence ends with, **written out here rather than imported**.
 *
 * A test that reads the module's own constant cannot tell a changed sentence from a correct
 * one — it would agree with whatever the module says, including the empty string. This is the
 * wording, spelled twice on purpose, and the two agree by hand.
 */
const RESTART = "Restart the app after placing or replacing a file — assets load once, at launch.";

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
      `No reference bundle. Put \`card-hashes.bin\` at ${STATUS.missing.bundle.path}. ${RESTART}`,
    );
    expect(modelsSentence(STATUS.noModels)).toBe(
      `No OCR models. Put \`text-detection.rten\` and \`text-recognition.rten\` at ${STATUS.noModels.detection_model.path}. ${RESTART}`,
    );
    expect(modelsSentence(STATUS.present)).toBeNull();
  });

  /**
   * The state `loaded` alone cannot see. A file that is *there* and did not parse used to draw
   * the sentence above — an instruction to put a file where that file already is — and
   * `Asset.error`, the only thing that says what went wrong, was rendered nowhere at all.
   */
  it("prints a present-but-unreadable file's own reason instead of an instruction", () => {
    const bundle = bundleSentence(STATUS.corrupt);
    expect(bundle).toBe(
      `\`card-hashes.bin\` at ${STATUS.corrupt.bundle.path} did not load: ${STATUS.corrupt.bundle.error}. ${RESTART}`,
    );
    expect(bundle).not.toContain("Put `card-hashes.bin`");

    const models = modelsSentence(STATUS.corrupt);
    expect(models).toBe(
      `\`text-detection.rten\` at ${STATUS.corrupt.detection_model.path} did not load: ${STATUS.corrupt.detection_model.error}. ${RESTART}`,
    );
    expect(models).not.toContain("No OCR models");
  });

  /** The pair fails as one, so the sentence names whichever asset is carrying the reason. */
  it("names the recognition model when it is the one that failed", () => {
    const recognitionOnly: ScannerStatus = {
      ...STATUS.corrupt,
      detection_model: { ...STATUS.corrupt.detection_model, loaded: true, error: null },
    };
    expect(modelsSentence(recognitionOnly)).toBe(
      `\`text-recognition.rten\` at ${recognitionOnly.recognition_model.path} did not load: ${recognitionOnly.recognition_model.error}. ${RESTART}`,
    );
  });

  /**
   * A bundle that loaded and labels that did not. **Not a broken scanner** — every match still
   * lands and every match reads as an id — so the sentence says that rather than reporting a
   * missing file, and `MatchPanel` draws it under the verdict rather than in place of one.
   */
  it("says the names failed where the bundle itself did not", () => {
    expect(bundleSentence(STATUS.unlabelled)).toBe(
      `Bundle loaded, but its names did not: ${STATUS.unlabelled.bundle.error}. Matches will show ids. ${RESTART}`,
    );
  });

  /**
   * Every asset sentence carries it, and it is the only part that makes the rest actionable:
   * assets load once, on the first command, so a file placed while the app is running changes
   * nothing until a restart.
   */
  it("ends every asset sentence with the restart clause", () => {
    const sentences = [
      bundleSentence(STATUS.missing),
      bundleSentence(STATUS.corrupt),
      bundleSentence(STATUS.unlabelled),
      modelsSentence(STATUS.noModels),
      modelsSentence(STATUS.corrupt),
    ];
    expect(sentences.every((s) => s !== null)).toBe(true);
    for (const sentence of sentences) expect(sentence).toContain(RESTART);
  });

  it("says nothing at all when there is no status yet", () => {
    expect(bundleSentence(null)).toBeNull();
    expect(modelsSentence(null)).toBeNull();
  });
});
