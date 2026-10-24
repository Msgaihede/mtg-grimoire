import { describe, expect, it } from "vitest";
import { VERDICTS } from "../fixtures";
import type { ScanFilters, ScannerVerdict } from "../types";
import {
  pushRunFrame,
  RUN_MAX_AGE_MS,
  RUN_MAX_BYTES,
  RUN_MAX_FRAMES,
  RUN_MIN_FRAMES,
  runAtPress,
  runFrameOf,
  scanRun,
  submissionOf,
  type RunFrame,
} from "./run";

const NO_FILTERS: ScanFilters = { sets: [], released_from: null, released_to: null };

/** A ring entry whose one byte is `n` — `AQ==`, `Ag==`, … as text — grabbed at `at`. */
function frame(n: number, at: number, over: Partial<RunFrame> = {}): RunFrame {
  return { ...runFrameOf(new Uint8Array([n]), at, VERDICTS.voting), ...over };
}

/** A ring entry of `bytes` zeroes, told apart by when it was grabbed. */
const heavy = (at: number, bytes: number): RunFrame =>
  runFrameOf(new Uint8Array(bytes), at, VERDICTS.voting);

describe("the bounds of a run", () => {
  /**
   * The engine refuses a run it would not keep, so these three are its numbers as much as this
   * side's — `lib/ipc.test.ts` holds each to the engine's own. Said here as well, because a
   * moved bound is a dialog whose Send can only be refused.
   */
  it("is five frames at least, and twenty or eight mebibytes at most", () => {
    expect(RUN_MIN_FRAMES).toBe(5);
    expect(RUN_MAX_FRAMES).toBe(20);
    expect(RUN_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  /** *The last couple of seconds*, with room for a slow host — and never minutes. */
  it("reaches four seconds back at most", () => {
    expect(RUN_MAX_AGE_MS).toBe(4000);
  });
});

describe("runFrameOf", () => {
  it("reads the scanner's answer for the frame off its verdict", () => {
    const jpeg = new Uint8Array([1, 2, 3]);
    expect(runFrameOf(jpeg, 1234.5, VERDICTS.decided)).toEqual({
      jpeg,
      at: 1234.5,
      ok: true,
      confidence: 1,
      distance: 11,
      decided: "storm-of-saruman-ltr-72",
    });
  });

  it("reads a frame on a real printing: its distance and its decided printing", () => {
    expect(runFrameOf(new Uint8Array([9]), 0, VERDICTS.resolved)).toMatchObject({
      ok: true,
      confidence: 1,
      distance: 16,
      decided: VERDICTS.resolved.decision?.printing,
    });
  });

  it("says nothing was found, weighed or decided for a frame with no card in it", () => {
    expect(runFrameOf(new Uint8Array([9]), 0, VERDICTS.noCard)).toMatchObject({
      ok: false,
      confidence: 0,
      distance: null,
      decided: null,
    });
    // A verdict with no agreement at all — a frame the scanner gave up on.
    expect(runFrameOf(new Uint8Array([9]), 0, VERDICTS.panicked).confidence).toBeNull();
  });

  /** A standing's id is an oracle id: it is never what a frame is said to have decided. */
  it("takes the decision's printing, never the leader's id, for what was decided", () => {
    expect(VERDICTS.voting.tracked?.standings[0]?.id).toBeTruthy();
    const weighing = runFrameOf(new Uint8Array([9]), 0, VERDICTS.voting);
    expect(weighing.decided).toBeNull();
    expect(weighing.confidence).toBe(0.625);
    expect(weighing.distance).toBe(23);
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
    // Four fit (8 MB); the fifth takes it to 10 MB, over the 8 MiB budget.
    for (let n = 1; n <= 5; n++) pushRunFrame(ring, heavy(n, 2_000_000));
    expect(ring.map((one) => one.at)).toEqual([2, 3, 4, 5]);
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

  /**
   * Frames and bytes are not a clock. A pump that took a second and a half a frame would hold
   * half a minute of them inside both of the other bounds.
   */
  it("drops frames grabbed more than four seconds before the newest", () => {
    const ring: RunFrame[] = [];
    for (let n = 1; n <= 5; n++) pushRunFrame(ring, frame(n, n * 1500));
    // The fifth is at 7500: the second (3000) is 4500 before it, the third (4500) is 3000.
    expect(ring.map((one) => one.at)).toEqual([4500, 6000, 7500]);

    // Exactly four seconds back is still inside.
    const edge: RunFrame[] = [];
    pushRunFrame(edge, frame(1, 1000));
    pushRunFrame(edge, frame(2, 1000 + RUN_MAX_AGE_MS));
    expect(edge).toHaveLength(2);
    pushRunFrame(edge, frame(3, 1001 + RUN_MAX_AGE_MS));
    expect(edge.map((one) => one.jpeg[0])).toEqual([2, 3]);
  });

  /** A pump that comes back after a long silence starts from the frame it came back with. */
  it("keeps only the newest frame when everything before it is old", () => {
    const ring: RunFrame[] = [];
    for (let n = 1; n <= 6; n++) pushRunFrame(ring, frame(n, n * 100));
    pushRunFrame(ring, frame(7, 60_000));
    expect(ring.map((one) => one.jpeg[0])).toEqual([7]);
  });
});

describe("runAtPress", () => {
  /** Six frames a hundred milliseconds apart, the last grabbed at 1500. */
  const RING: RunFrame[] = [1, 2, 3, 4, 5, 6].map((n) => frame(n, 900 + n * 100));

  it("is the whole ring when every frame is from the last few seconds", () => {
    expect(runAtPress(RING, 1510)).toEqual(RING);
  });

  /**
   * The ring ages against its own newest frame, which says nothing of how long ago that was: a
   * pump still waiting on an answer is holding what was the last couple of seconds once.
   */
  it("leaves out every frame grabbed more than four seconds before the press", () => {
    // 1000 … 1500, pressed at 5250: the first three are more than four seconds back.
    expect(runAtPress(RING, 5250).map((one) => one.jpeg[0])).toEqual([4, 5, 6]);
    // Exactly four seconds back is still the last few seconds.
    expect(runAtPress(RING, 1000 + RUN_MAX_AGE_MS).map((one) => one.jpeg[0])).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(runAtPress(RING, 1001 + RUN_MAX_AGE_MS).map((one) => one.jpeg[0])).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });

  it("is nothing at all once the newest frame is that old, or the ring was empty", () => {
    expect(runAtPress(RING, 60_000)).toEqual([]);
    expect(runAtPress([], 1000)).toEqual([]);
  });

  it("hands back an array of its own and leaves the ring as it was", () => {
    const before = [...RING];
    const taken = runAtPress(RING, 1510);
    expect(taken).not.toBe(RING);
    expect(RING).toEqual(before);
  });

  /** One unbroken stretch of what the pump sent, whatever a clock did in the middle of it. */
  it("stops at the first frame too old, walking back from the newest", () => {
    const stepped = [frame(1, 5000), frame(2, 100), frame(3, 5100), frame(4, 5200)];
    expect(runAtPress(stepped, 5300).map((one) => one.jpeg[0])).toEqual([3, 4]);
  });
});

describe("scanRun", () => {
  /** The ring as a press finds it: five frames a hundred and ten milliseconds apart. */
  const RING: RunFrame[] = [
    frame(1, 1000, { ok: false, confidence: null, distance: null }),
    frame(2, 1110),
    frame(3, 1220),
    frame(4, 1330),
    frame(5, 1440, { decided: "storm-of-saruman-ltr-72", confidence: 1, distance: 11 }),
  ];

  /** Four frames of the scanner weighing, and then the one `verdict` was the answer to. */
  function endingOn(verdict: ScannerVerdict): RunFrame[] {
    return [
      frame(1, 1000),
      frame(2, 1110),
      frame(3, 1220),
      frame(4, 1330),
      runFrameOf(new Uint8Array([5]), 1440, verdict),
    ];
  }

  it("carries every frame as base64 with no scheme in front of it, oldest first", () => {
    const run = scanRun(RING, 1450, null, NO_FILTERS);
    expect(run.frames.map((one) => one.jpeg)).toEqual(["AQ==", "Ag==", "Aw==", "BA==", "BQ=="]);
    for (const one of run.frames) expect(one.jpeg.startsWith("data:")).toBe(false);
  });

  it("counts each frame back from the press, in whole milliseconds", () => {
    const run = scanRun(RING, 1450.4, null, NO_FILTERS);
    expect(run.frames.map((one) => one.ms)).toEqual([-450, -340, -230, -120, -10]);
    for (const one of run.frames) expect(Number.isInteger(one.ms)).toBe(true);
  });

  /**
   * A frame cannot have been taken after the press it was sent for. A clock that stepped, or a
   * press in the very millisecond of a grab, is said as the press itself — and as a plain zero,
   * not the negative one a rounding leaves, which a strict reader of the wire tells apart.
   */
  it("never puts a frame after the press, and says the press itself as a plain zero", () => {
    const late = scanRun([frame(1, 1000), frame(2, 1100.2)], 1100, null, NO_FILTERS);
    expect(late.frames.map((one) => one.ms)).toEqual([-100, 0]);
    expect(Object.is(late.frames[1].ms, 0)).toBe(true);
    const ahead = scanRun([frame(1, 2000)], 1100, null, NO_FILTERS);
    expect(Object.is(ahead.frames[0].ms, 0)).toBe(true);
  });

  it("sends what the scanner answered for each frame, and neither its bytes nor its clock", () => {
    const run = scanRun(RING, 1450, null, NO_FILTERS);
    expect(run.frames[0]).toEqual({
      jpeg: "AQ==",
      ms: -450,
      ok: false,
      confidence: null,
      distance: null,
      decided: null,
    });
    expect(run.frames[4]).toMatchObject({
      decided: "storm-of-saruman-ltr-72",
      confidence: 1,
      distance: 11,
    });
    for (const one of run.frames) {
      expect(Object.keys(one).sort()).toEqual(
        ["confidence", "decided", "distance", "jpeg", "ms", "ok"].sort(),
      );
    }
  });

  it("leaves the ring it was handed as it was", () => {
    const before = RING.map((one) => ({ ...one }));
    scanRun(RING, 1450, VERDICTS.decided, NO_FILTERS);
    expect(RING).toEqual(before);
  });

  /**
   * **What the scanner had said is the last frame's, whatever verdict the press was holding.** A
   * press reads the ring as it stands and the verdict as the last render had it, and the ring is
   * a frame ahead whenever an answer has landed since. Here the render still holds the frame
   * before the decision: nothing of it is sent.
   */
  it("takes the reported printing and the two figures off the run's last frame, not off the verdict", () => {
    expect(RING[4]).toMatchObject({
      decided: "storm-of-saruman-ltr-72",
      confidence: 1,
      distance: 11,
    });
    // The verdict in hand: still weighing, at other figures.
    const stale: ScannerVerdict = VERDICTS.voting;
    expect(stale.decision).toBeNull();
    expect(stale.tracked?.confidence).toBe(0.625);

    const run = scanRun(RING, 1450, stale, NO_FILTERS);
    expect(run.said).toEqual({
      reported: "storm-of-saruman-ltr-72",
      confidence: 1,
      distance: 11,
      filters: NO_FILTERS,
    });
    // …and so the press-level figures are the last frame's own, to the field.
    const newest = run.frames[run.frames.length - 1];
    expect(run.said.reported).toBe(newest.decided);
    expect(run.said.confidence).toBe(newest.confidence);
    expect(run.said.distance).toBe(newest.distance);
    // The verdict is still what the search opens on: it is what the reader was looking at.
    expect(run.leadName).toBe("Plains");
  });

  /** The other way about: the render is ahead of nothing, and has simply decided since. */
  it("reports nothing for a run whose last frame had decided nothing, though the verdict has", () => {
    const run = scanRun(endingOn(VERDICTS.voting), 1450, VERDICTS.decided, NO_FILTERS);
    expect(run.said).toMatchObject({ reported: null, confidence: 0.625, distance: 23 });
  });

  it("says nothing for the scanner when the last frame had nothing in it", () => {
    const run = scanRun(endingOn(VERDICTS.noCard), 1450, null, NO_FILTERS);
    expect(run.said).toEqual({
      reported: null,
      confidence: 0,
      distance: null,
      filters: NO_FILTERS,
    });
    expect(run.leadName).toBe("");
  });

  it("says nothing for the scanner when the last frame carried no agreement at all", () => {
    const run = scanRun(endingOn(VERDICTS.panicked), 1450, VERDICTS.panicked, NO_FILTERS);
    expect(run.said).toEqual({
      reported: null,
      confidence: null,
      distance: null,
      filters: NO_FILTERS,
    });
    expect(run.leadName).toBe("");
  });

  /**
   * **A leader is not a report.** A standing's `id` is what the agreement's evidence pooled on —
   * so it is an id of another kind than the printing a
   * reader chooses, and beside one it could never read as "the scanner got it right". While the
   * scanner is still weighing, it has reported nothing; how far it had got is in the two figures.
   * (The fixture's standing wears a printing-shaped id, which is how this was once missed.)
   */
  it("reports nothing while the scanner is still weighing, and opens the search on the leader's name", () => {
    expect(VERDICTS.voting.decision).toBeNull();
    expect(VERDICTS.voting.tracked?.standings[0]?.id).toBeTruthy();
    const run = scanRun(endingOn(VERDICTS.voting), 1450, VERDICTS.voting, NO_FILTERS);
    expect(run.said).toEqual({
      reported: null,
      confidence: 0.625,
      distance: 23,
      filters: NO_FILTERS,
    });
    // The name is a word for the search box, never a label — and for that a leader will do.
    expect(run.leadName).toBe("Plains");
  });

  it("reports the decided printing once there is one", () => {
    const run = scanRun(endingOn(VERDICTS.decided), 1450, VERDICTS.decided, NO_FILTERS);
    expect(run.said).toEqual({
      reported: "storm-of-saruman-ltr-72",
      confidence: 1,
      distance: 11,
      filters: NO_FILTERS,
    });
    expect(run.leadName).toBe("Storm of Saruman");
  });

  /**
   * The decision can name another printing than the one the agreement leads with. The decision is
   * what the strip showed the reader and what the tray filed, so it is what was "reported".
   */
  it("takes the decision over the leader when the two differ", () => {
    const decision = VERDICTS.resolved.decision;
    if (decision === null) throw new Error("the fixture carries a decision");
    const verdict: ScannerVerdict = { ...VERDICTS.voting, decision };
    const run = scanRun(endingOn(verdict), 1450, verdict, NO_FILTERS);
    expect(run.said.reported).toBe(decision.printing);
    expect(run.leadName).toBe("Black Lotus");
    // The figures stay the agreement's and the match's: they are what was measured.
    expect(run.said.confidence).toBe(0.625);
    expect(run.said.distance).toBe(23);
  });

  it("reports a decision that has no label by its id, and names nothing for the search", () => {
    const decision = VERDICTS.decided.decision;
    if (decision === null) throw new Error("the fixture carries a decision");
    const verdict: ScannerVerdict = {
      ...VERDICTS.decided,
      decision: { ...decision, label: null },
      tracked: null,
    };
    const run = scanRun(endingOn(verdict), 1450, verdict, NO_FILTERS);
    expect(run.said.reported).toBe("storm-of-saruman-ltr-72");
    expect(run.said.confidence).toBeNull();
    expect(run.leadName).toBe("");
  });

  /** No press sends one — a run has five frames at least — but the function is total. */
  it("says nothing for the scanner for a run with no frame in it", () => {
    const run = scanRun([], 1450, VERDICTS.decided, NO_FILTERS);
    expect(run.frames).toEqual([]);
    expect(run.said).toEqual({
      reported: null,
      confidence: null,
      distance: null,
      filters: NO_FILTERS,
    });
  });

  /** What the scanner was narrowed to decides what it could have answered at all. */
  it("carries the filters the scanner was narrowed to", () => {
    const narrowed: ScanFilters = {
      sets: ["ltr", "hob"],
      released_from: "2023-01-01",
      released_to: null,
    };
    expect(scanRun(RING, 1450, null, narrowed).said.filters).toEqual(narrowed);
  });
});

describe("submissionOf", () => {
  it("puts the reader's two answers beside what the scanner said and the whole run", () => {
    const narrowed: ScanFilters = { sets: ["ltr"], released_from: null, released_to: null };
    const run = scanRun(
      [frame(1, 1000), runFrameOf(new Uint8Array([2]), 1110, VERDICTS.decided)],
      1120,
      VERDICTS.decided,
      narrowed,
    );
    const sent = submissionOf(run, {
      cardId: "b14fae63-2e82-49c1-8e62-d84a65f27479",
      finish: "etched",
    });
    expect(sent).toEqual({
      cardId: "b14fae63-2e82-49c1-8e62-d84a65f27479",
      finish: "etched",
      reported: "storm-of-saruman-ltr-72",
      confidence: 1,
      distance: 11,
      filters: narrowed,
      run: run.frames,
    });
    // Exactly the wire's seven fields, and the frames are the run's own, in its order.
    expect(Object.keys(sent)).toHaveLength(7);
    expect(sent.run.map((one) => one.ms)).toEqual([-120, -10]);
  });

  it("sends no card as a null id and a null finish, and everything else as it is", () => {
    const ring = [1, 2, 3, 4, 5].map((n) => frame(n, 1000 + n * 100));
    const run = scanRun(ring, 1550, null, NO_FILTERS);
    const sent = submissionOf(run, null);
    expect(sent.cardId).toBeNull();
    expect(sent.finish).toBeNull();
    expect(sent).toEqual({
      ...submissionOf(run, { cardId: "x", finish: "foil" }),
      cardId: null,
      finish: null,
    });
    expect(Object.keys(sent)).toHaveLength(7);
  });
});
