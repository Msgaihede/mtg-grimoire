import { describe, expect, it } from "vitest";
import { STATUS, VERDICTS } from "../fixtures";
import type { ScanFilters, ScannerVerdict } from "../types";
import {
  pushRunFrame,
  RUN_MAX_BYTES,
  RUN_MAX_FRAMES,
  RUN_MIN_FRAMES,
  runFrameOf,
  scanRun,
  submissionOf,
  type RunFrame,
} from "./run";

const NO_FILTERS: ScanFilters = { sets: [], released_from: null, released_to: null };

/** A ring entry whose one byte is `n` — `AQ==`, `Ag==`, … as text — grabbed at `at`. */
function frame(n: number, at: number, over: Partial<RunFrame> = {}): RunFrame {
  return { ...runFrameOf(new Uint8Array([n]), at, VERDICTS.voting, false), ...over };
}

/** A ring entry of `bytes` zeroes, told apart by when it was grabbed. */
const heavy = (at: number, bytes: number): RunFrame =>
  runFrameOf(new Uint8Array(bytes), at, VERDICTS.voting, false);

describe("the bounds of a run", () => {
  /**
   * The engine refuses a run it would not keep, so these three are its numbers as much as this
   * side's — `lib/ipc.test.ts` holds each to the engine's own. Said here as well, because a
   * moved bound is a dialog whose Send can only be refused.
   */
  it("is five frames at least, and twenty or a mebibyte and a half at most", () => {
    expect(RUN_MIN_FRAMES).toBe(5);
    expect(RUN_MAX_FRAMES).toBe(20);
    expect(RUN_MAX_BYTES).toBe(1.5 * 1024 * 1024);
  });
});

describe("runFrameOf", () => {
  it("reads the scanner's answer for the frame off its verdict", () => {
    const jpeg = new Uint8Array([1, 2, 3]);
    expect(runFrameOf(jpeg, 1234.5, VERDICTS.decided, false)).toEqual({
      jpeg,
      at: 1234.5,
      ok: true,
      lock: "locked",
      confidence: 1,
      distance: 30,
      decided: "storm-of-saruman-ltr-72",
      detail: false,
    });
  });

  it("says nothing was found, locked, weighed or decided for a frame with no card in it", () => {
    expect(runFrameOf(new Uint8Array([9]), 0, VERDICTS.noCard, false)).toMatchObject({
      ok: false,
      lock: "idle",
      confidence: null,
      distance: null,
      decided: null,
    });
    // A verdict with no lock at all — a frame the detector gave up on.
    expect(runFrameOf(new Uint8Array([9]), 0, VERDICTS.panicked, false).lock).toBeNull();
  });

  /** A standing's id is an oracle id: it is never what a frame is said to have decided. */
  it("takes the decision's printing, never the leader's id, for what was decided", () => {
    expect(VERDICTS.voting.tracked?.standings[0]?.id).toBeTruthy();
    const weighing = runFrameOf(new Uint8Array([9]), 0, VERDICTS.voting, false);
    expect(weighing.decided).toBeNull();
    expect(weighing.confidence).toBe(0.625);
    expect(weighing.distance).toBe(74);
  });

  it("carries whether a detail image went with the frame", () => {
    expect(runFrameOf(new Uint8Array([9]), 0, VERDICTS.voting, true).detail).toBe(true);
  });
});

describe("pushRunFrame", () => {
  it("keeps frames oldest first", () => {
    const ring: RunFrame[] = [];
    for (let n = 1; n <= 3; n++) pushRunFrame(ring, frame(n, n * 100));
    expect(ring.map((one) => one.jpeg[0])).toEqual([1, 2, 3]);
  });

  it("drops the oldest once there are more than twenty", () => {
    const ring: RunFrame[] = [];
    for (let n = 1; n <= RUN_MAX_FRAMES + 3; n++) pushRunFrame(ring, frame(n, n * 100));
    expect(ring).toHaveLength(RUN_MAX_FRAMES);
    expect(ring[0].jpeg[0]).toBe(4);
    expect(ring[ring.length - 1].jpeg[0]).toBe(RUN_MAX_FRAMES + 3);
  });

  /** A camera whose frames are heavy keeps a shorter run, not a heavier one. */
  it("drops the oldest once the bytes pass the budget, however few frames that leaves", () => {
    const ring: RunFrame[] = [];
    // Three fit (1.2 MB); the fourth takes it to 1.6 MB, over the 1.5 MiB budget.
    for (let n = 1; n <= 4; n++) pushRunFrame(ring, heavy(n, 400_000));
    expect(ring.map((one) => one.at)).toEqual([2, 3, 4]);
    expect(ring.reduce((sum, one) => sum + one.jpeg.length, 0)).toBeLessThanOrEqual(RUN_MAX_BYTES);

    // Exactly at the budget is inside it.
    const exact: RunFrame[] = [];
    pushRunFrame(exact, heavy(1, RUN_MAX_BYTES / 2));
    pushRunFrame(exact, heavy(2, RUN_MAX_BYTES / 2));
    expect(exact).toHaveLength(2);
  });

  it("keeps nothing of a frame that is over the budget by itself", () => {
    const ring: RunFrame[] = [frame(1, 100)];
    pushRunFrame(ring, heavy(2, RUN_MAX_BYTES + 1));
    expect(ring).toEqual([]);
  });
});

describe("scanRun", () => {
  /** The ring as a press finds it: five frames a hundred and ten milliseconds apart. */
  const RING: RunFrame[] = [
    frame(1, 1000, { ok: false, lock: "idle", confidence: null, distance: null }),
    frame(2, 1110, { lock: "acquiring" }),
    frame(3, 1220),
    frame(4, 1330, { detail: true }),
    frame(5, 1440, { decided: "storm-of-saruman-ltr-72", confidence: 1, distance: 30 }),
  ];

  it("carries every frame as base64 with no scheme in front of it, oldest first", () => {
    const run = scanRun(RING, 1450, null, "fast", null, NO_FILTERS);
    expect(run.frames.map((one) => one.jpeg)).toEqual(["AQ==", "Ag==", "Aw==", "BA==", "BQ=="]);
    for (const one of run.frames) expect(one.jpeg.startsWith("data:")).toBe(false);
  });

  it("counts each frame back from the press, in whole milliseconds", () => {
    const run = scanRun(RING, 1450.4, null, "fast", null, NO_FILTERS);
    expect(run.frames.map((one) => one.ms)).toEqual([-450, -340, -230, -120, -10]);
    for (const one of run.frames) expect(Number.isInteger(one.ms)).toBe(true);
  });

  /**
   * A frame cannot have been taken after the press it was sent for. A clock that stepped, or a
   * press in the very millisecond of a grab, is said as the press itself — and as a plain zero,
   * not the negative one a rounding leaves, which a strict reader of the wire tells apart.
   */
  it("never puts a frame after the press, and says the press itself as a plain zero", () => {
    const late = scanRun([frame(1, 1000), frame(2, 1100.2)], 1100, null, "fast", null, NO_FILTERS);
    expect(late.frames.map((one) => one.ms)).toEqual([-100, 0]);
    expect(Object.is(late.frames[1].ms, 0)).toBe(true);
    const ahead = scanRun([frame(1, 2000)], 1100, null, "fast", null, NO_FILTERS);
    expect(Object.is(ahead.frames[0].ms, 0)).toBe(true);
  });

  it("sends what the scanner answered for each frame, and neither its bytes nor its clock", () => {
    const run = scanRun(RING, 1450, null, "fast", null, NO_FILTERS);
    expect(run.frames[0]).toEqual({
      jpeg: "AQ==",
      ms: -450,
      ok: false,
      lock: "idle",
      confidence: null,
      distance: null,
      decided: null,
      detail: false,
    });
    expect(run.frames[3].detail).toBe(true);
    expect(run.frames[4]).toMatchObject({
      decided: "storm-of-saruman-ltr-72",
      confidence: 1,
      distance: 30,
    });
    for (const one of run.frames) {
      expect(Object.keys(one).sort()).toEqual(
        ["confidence", "decided", "detail", "distance", "jpeg", "lock", "ms", "ok"].sort(),
      );
    }
  });

  it("leaves the ring it was handed as it was", () => {
    const before = RING.map((one) => ({ ...one }));
    scanRun(RING, 1450, VERDICTS.decided, "fast", STATUS.present, NO_FILTERS);
    expect(RING).toEqual(before);
  });

  it("says nothing for the scanner when the scanner was saying nothing", () => {
    const run = scanRun(RING, 1450, null, "exact", null, NO_FILTERS);
    expect(run.said).toEqual({
      reported: null,
      mode: "exact",
      confidence: null,
      distance: null,
      bundle: null,
      filters: NO_FILTERS,
    });
    expect(run.leadName).toBe("");
  });

  it("says nothing was named for a card it had not found, and still counts the cards it could have named", () => {
    const run = scanRun(RING, 1450, VERDICTS.noCard, "fast", STATUS.present, NO_FILTERS);
    expect(run.said).toMatchObject({
      reported: null,
      confidence: null,
      distance: null,
      bundle: STATUS.present.labels,
    });
    expect(run.leadName).toBe("");
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
    const run = scanRun(RING, 1450, VERDICTS.voting, "fast", STATUS.present, NO_FILTERS);
    expect(run.said).toEqual({
      reported: null,
      mode: "fast",
      confidence: 0.625,
      distance: 74,
      bundle: 117630,
      filters: NO_FILTERS,
    });
    // The name is a word for the search box, never a label — and for that a leader will do.
    expect(run.leadName).toBe("Plains");
  });

  it("reports the decided printing once there is one", () => {
    const run = scanRun(RING, 1450, VERDICTS.decided, "fast", STATUS.present, NO_FILTERS);
    expect(run.said).toEqual({
      reported: "storm-of-saruman-ltr-72",
      mode: "fast",
      confidence: 1,
      distance: 30,
      bundle: 117630,
      filters: NO_FILTERS,
    });
    expect(run.leadName).toBe("Storm of Saruman");
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
    const run = scanRun(RING, 1450, verdict, "exact", STATUS.present, NO_FILTERS);
    expect(run.said.reported).toBe(decision.printing);
    expect(run.leadName).toBe("Black Lotus");
    // The figures stay the tracker's and the match's: they are what was measured.
    expect(run.said.confidence).toBe(0.625);
    expect(run.said.distance).toBe(74);
  });

  it("reports a decision that has no label by its id, and names nothing for the search", () => {
    const decision = VERDICTS.decided.decision;
    if (decision === null) throw new Error("the fixture carries a decision");
    const verdict: ScannerVerdict = {
      ...VERDICTS.decided,
      decision: { ...decision, label: null },
      tracked: null,
    };
    const run = scanRun(RING, 1450, verdict, "fast", null, NO_FILTERS);
    expect(run.said.reported).toBe("storm-of-saruman-ltr-72");
    expect(run.said.confidence).toBeNull();
    expect(run.leadName).toBe("");
  });

  it("takes the mode from the page, not from the last verdict", () => {
    // A reader who switched to Exact a frame ago: the verdict in hand was judged in Fast.
    expect(scanRun(RING, 1450, VERDICTS.voting, "exact", null, NO_FILTERS).said.mode).toBe("exact");
  });

  /** What the scanner was narrowed to decides what it could have answered at all. */
  it("carries the filters the scanner was narrowed to", () => {
    const narrowed: ScanFilters = { sets: ["ltr", "hob"], released_from: "2023-01-01", released_to: null };
    expect(scanRun(RING, 1450, null, "fast", null, narrowed).said.filters).toEqual(narrowed);
  });
});

describe("submissionOf", () => {
  it("puts the reader's two answers beside what the scanner said and the whole run", () => {
    const narrowed: ScanFilters = { sets: ["ltr"], released_from: null, released_to: null };
    const run = scanRun(
      [frame(1, 1000), frame(2, 1110)],
      1120,
      VERDICTS.decided,
      "fast",
      STATUS.present,
      narrowed,
    );
    const sent = submissionOf(run, "b14fae63-2e82-49c1-8e62-d84a65f27479", "etched");
    expect(sent).toEqual({
      cardId: "b14fae63-2e82-49c1-8e62-d84a65f27479",
      finish: "etched",
      reported: "storm-of-saruman-ltr-72",
      mode: "fast",
      confidence: 1,
      distance: 30,
      bundle: 117630,
      filters: narrowed,
      run: run.frames,
    });
    // Exactly the wire's nine fields, and the frames are the run's own, in its order.
    expect(Object.keys(sent)).toHaveLength(9);
    expect(sent.run.map((one) => one.ms)).toEqual([-120, -10]);
  });
});
