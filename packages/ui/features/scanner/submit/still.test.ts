import { describe, expect, it } from "vitest";
import { STATUS, VERDICTS } from "../fixtures";
import type { ScannerVerdict } from "../types";
import { scanStill, submissionOf, SUBMIT_LONG_EDGE, SUBMIT_QUALITY } from "./still";

/** Three bytes, and the text they are sent as. */
const BYTES = new Uint8Array([1, 2, 3]);
const TEXT = "AQID";

describe("the size a picture is sent at", () => {
  it("is the camera's own ideal, at a quality above the pump's", () => {
    expect(SUBMIT_LONG_EDGE).toBe(1920);
    expect(SUBMIT_QUALITY).toBe(0.9);
  });
});

describe("scanStill", () => {
  it("carries the picture as base64 with no scheme in front of it", () => {
    const still = scanStill(BYTES, null, "fast", null);
    expect(still.frame).toBe(TEXT);
    expect(still.frame.startsWith("data:")).toBe(false);
  });

  it("says nothing for the scanner when the scanner was saying nothing", () => {
    // No verdict and no status: a camera that has just opened, or recognition stopped.
    expect(scanStill(BYTES, null, "exact", null)).toEqual({
      frame: TEXT,
      said: { reported: null, mode: "exact", confidence: null, distance: null, bundle: null },
      leadName: "",
    });
  });

  it("says nothing was named for a frame with no card in it, and still counts the cards it could have named", () => {
    const still = scanStill(BYTES, VERDICTS.noCard, "fast", STATUS.present);
    expect(still.said).toEqual({
      reported: null,
      mode: "fast",
      confidence: null,
      distance: null,
      bundle: STATUS.present.labels,
    });
    expect(still.leadName).toBe("");
  });

  /**
   * **A leader is not a report.** A standing's `id` is what the tracker's evidence pooled on —
   * the *oracle* id (`track.rs`' `Standing`) — so it is an id of another kind than the printing a
   * reader chooses, and beside one it could never read as "the scanner got it right". While the
   * scanner is still weighing, it has reported nothing; how far it had got is in the two figures.
   * (The fixture's standing wears a printing-shaped id, which is how this was once missed.)
   */
  it("reports nothing while the scanner is still weighing, and opens the search on the leader's name", () => {
    expect(VERDICTS.voting.decision).toBeNull();
    expect(VERDICTS.voting.tracked?.standings[0]?.id).toBeTruthy();
    const still = scanStill(BYTES, VERDICTS.voting, "fast", STATUS.present);
    expect(still.said).toEqual({
      reported: null,
      mode: "fast",
      confidence: 0.625,
      distance: 74,
      bundle: 117630,
    });
    // The name is a word for the search box, never a label — and for that a leader will do.
    expect(still.leadName).toBe("Plains");
  });

  it("reports the decided printing once there is one", () => {
    const still = scanStill(BYTES, VERDICTS.decided, "fast", STATUS.present);
    expect(still.said).toEqual({
      reported: "storm-of-saruman-ltr-72",
      mode: "fast",
      confidence: 1,
      distance: 30,
      bundle: 117630,
    });
    expect(still.leadName).toBe("Storm of Saruman");
  });

  /**
   * In Exact the resolve can pin another printing than the one the hash tracker leads with, and a
   * Fast title read can name another card. The decision is what the strip showed the reader and
   * what the tray filed, so it is what was "reported".
   */
  it("takes the decision over the leader when the two differ", () => {
    const decision = VERDICTS.exactResolved.decision;
    if (decision === null) throw new Error("the fixture carries a decision");
    const verdict: ScannerVerdict = { ...VERDICTS.voting, decision };
    const still = scanStill(BYTES, verdict, "exact", STATUS.present);
    expect(still.said.reported).toBe(decision.printing);
    expect(still.leadName).toBe("Black Lotus");
    // The figures stay the tracker's and the match's: they are what was measured on this frame.
    expect(still.said.confidence).toBe(0.625);
    expect(still.said.distance).toBe(74);
  });

  it("reports a decision that has no label by its id, and names nothing for the search", () => {
    const decision = VERDICTS.decided.decision;
    if (decision === null) throw new Error("the fixture carries a decision");
    const verdict: ScannerVerdict = {
      ...VERDICTS.decided,
      decision: { ...decision, label: null },
      tracked: null,
    };
    const still = scanStill(BYTES, verdict, "fast", null);
    expect(still.said.reported).toBe("storm-of-saruman-ltr-72");
    expect(still.said.confidence).toBeNull();
    expect(still.leadName).toBe("");
  });

  it("takes the mode from the page, not from the last verdict", () => {
    // A reader who switched to Exact a frame ago: the verdict in hand was judged in Fast.
    expect(scanStill(BYTES, VERDICTS.voting, "exact", null).said.mode).toBe("exact");
  });
});

describe("submissionOf", () => {
  it("puts the reader's two answers beside what the scanner said, and nothing else", () => {
    const still = scanStill(BYTES, VERDICTS.decided, "fast", STATUS.present);
    expect(submissionOf(still, "b14fae63-2e82-49c1-8e62-d84a65f27479", "etched")).toEqual({
      cardId: "b14fae63-2e82-49c1-8e62-d84a65f27479",
      finish: "etched",
      reported: "storm-of-saruman-ltr-72",
      mode: "fast",
      confidence: 1,
      distance: 30,
      bundle: 117630,
    });
  });
});
