import { describe, expect, it } from "vitest";
import { STATUS, VERDICTS } from "../fixtures";
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
    expect(runFrameOf(jpeg, 1234.5, VERDICTS.decided, false)).toEqual({
      jpeg,
      at: 1234.5,
      ok: true,
      lock: "locked",
      confidence: 1,
      distance: 30,
      decided: "storm-of-saruman-ltr-72",
      detail: false,
      mode: "fast",
    });
  });

  /** The session's own word for it, off the verdict — the page's switch moves a frame sooner. */
  it("says which mode the scanner judged the frame in", () => {
    expect(VERDICTS.voting.mode).toBe("fast");
    expect(runFrameOf(new Uint8Array([9]), 0, VERDICTS.voting, false).mode).toBe("fast");
    expect(VERDICTS.exactAmbiguous.mode).toBe("exact");
    expect(runFrameOf(new Uint8Array([9]), 0, VERDICTS.exactAmbiguous, false).mode).toBe("exact");
    expect(runFrameOf(new Uint8Array([9]), 0, VERDICTS.neuralAmbiguous, false).mode).toBe("neural");
  });

  /**
   * Neural keeps no quad lock, so its frames say no lock rather than a phase; the rest is read as
   * for any mode — its distance is the `MatchReport`'s 0–256 bits, as the inbox reads it.
   */
  it("reads a Neural frame with no lock, its distance in bits and its decided printing", () => {
    expect(runFrameOf(new Uint8Array([9]), 0, VERDICTS.neuralDecided, false)).toMatchObject({
      ok: true,
      lock: null,
      confidence: 1,
      distance: 16,
      decided: VERDICTS.neuralDecided.decision?.printing,
      mode: "neural",
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
   * **The session forgets the card on the first frame it is sent in another mode**, so a frame
   * answered in a mode the one before it was not is the first of a new run: what came before was
   * said of evidence this answer does not rest on.
   */
  it("starts over at a frame judged in another mode than the one before it", () => {
    const ring: RunFrame[] = [];
    for (let n = 1; n <= 6; n++) pushRunFrame(ring, frame(n, n * 100));
    expect(ring).toHaveLength(6);

    pushRunFrame(ring, frame(7, 700, { mode: "exact" }));
    expect(ring.map((one) => one.jpeg[0])).toEqual([7]);
    // …and goes on from there, in the new mode.
    pushRunFrame(ring, frame(8, 800, { mode: "exact" }));
    pushRunFrame(ring, frame(9, 900, { mode: "exact" }));
    expect(ring.map((one) => one.jpeg[0])).toEqual([7, 8, 9]);
    // Back again is a break too: it is the change that forgets, whichever way it goes.
    pushRunFrame(ring, frame(10, 1000));
    expect(ring.map((one) => one.jpeg[0])).toEqual([10]);
    // And Neural is a mode like the others: into it, and out of it to Exact, each start over.
    pushRunFrame(ring, frame(11, 1100, { mode: "neural" }));
    pushRunFrame(ring, frame(12, 1200, { mode: "neural" }));
    expect(ring.map((one) => one.jpeg[0])).toEqual([11, 12]);
    pushRunFrame(ring, frame(13, 1300, { mode: "exact" }));
    expect(ring.map((one) => one.jpeg[0])).toEqual([13]);
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
    frame(1, 1000, { ok: false, lock: "idle", confidence: null, distance: null }),
    frame(2, 1110, { lock: "acquiring" }),
    frame(3, 1220),
    frame(4, 1330, { detail: true }),
    frame(5, 1440, { decided: "storm-of-saruman-ltr-72", confidence: 1, distance: 30 }),
  ];

  /** Four frames of the scanner weighing, and then the one `verdict` was the answer to. */
  function endingOn(verdict: ScannerVerdict): RunFrame[] {
    return [
      frame(1, 1000),
      frame(2, 1110),
      frame(3, 1220),
      frame(4, 1330),
      runFrameOf(new Uint8Array([5]), 1440, verdict, false),
    ];
  }

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

  /**
   * The mode is the run's and is said once (`said.mode`); a frame that carried one of its own
   * would be a field the engine's struct does not have.
   */
  it("sends what the scanner answered for each frame, and neither its bytes, its clock nor its mode", () => {
    const run = scanRun(RING, 1450, null, "fast", null, NO_FILTERS);
    for (const one of RING) expect(one).toHaveProperty("mode", "fast");
    for (const one of run.frames) expect(one).not.toHaveProperty("mode");
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

  /**
   * **What the scanner had said is the last frame's, whatever verdict the press was holding.** A
   * press reads the ring as it stands and the verdict as the last render had it, and the ring is
   * a frame ahead whenever an answer has landed since. Here the render still holds the frame
   * before the decision, in another mode even: nothing of it is sent.
   */
  it("takes the reported printing, the two figures and the mode off the run's last frame, not off the verdict", () => {
    expect(RING[4]).toMatchObject({
      decided: "storm-of-saruman-ltr-72",
      confidence: 1,
      distance: 30,
      mode: "fast",
    });
    // The verdict in hand: still weighing, at other figures, and judged in Exact.
    const stale: ScannerVerdict = { ...VERDICTS.voting, mode: "exact" };
    expect(stale.decision).toBeNull();
    expect(stale.tracked?.confidence).toBe(0.625);

    const run = scanRun(RING, 1450, stale, "exact", STATUS.present, NO_FILTERS);
    expect(run.said).toEqual({
      reported: "storm-of-saruman-ltr-72",
      mode: "fast",
      confidence: 1,
      distance: 30,
      bundle: 117630,
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
    const run = scanRun(
      endingOn(VERDICTS.voting),
      1450,
      VERDICTS.decided,
      "fast",
      null,
      NO_FILTERS,
    );
    expect(run.said).toMatchObject({ reported: null, confidence: 0.625, distance: 74 });
  });

  it("says nothing for the scanner when the last frame had nothing in it", () => {
    const run = scanRun(endingOn(VERDICTS.noCard), 1450, null, "fast", null, NO_FILTERS);
    expect(run.said).toEqual({
      reported: null,
      mode: "fast",
      confidence: null,
      distance: null,
      bundle: null,
      filters: NO_FILTERS,
    });
    expect(run.leadName).toBe("");
  });

  it("says nothing was named for a card it had not found, and still counts the cards it could have named", () => {
    const run = scanRun(
      endingOn(VERDICTS.noCard),
      1450,
      VERDICTS.noCard,
      "fast",
      STATUS.present,
      NO_FILTERS,
    );
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
    const run = scanRun(
      endingOn(VERDICTS.voting),
      1450,
      VERDICTS.voting,
      "fast",
      STATUS.present,
      NO_FILTERS,
    );
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
    const run = scanRun(
      endingOn(VERDICTS.decided),
      1450,
      VERDICTS.decided,
      "fast",
      STATUS.present,
      NO_FILTERS,
    );
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
    const run = scanRun(endingOn(verdict), 1450, verdict, "exact", STATUS.present, NO_FILTERS);
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
    const run = scanRun(endingOn(verdict), 1450, verdict, "fast", null, NO_FILTERS);
    expect(run.said.reported).toBe("storm-of-saruman-ltr-72");
    expect(run.said.confidence).toBeNull();
    expect(run.leadName).toBe("");
  });

  /**
   * **The mode a run is sent under is the one its frames were judged in.** A reader who has just
   * switched to Exact holds a page that says Exact and a ring of frames the session judged in
   * Fast — the switch reaches the session with the next frame, and that frame starts the ring
   * over. Until it lands, what there is to send is a Fast run, and it says so.
   */
  it("takes the mode from the run's last frame, not from the page", () => {
    expect(scanRun(RING, 1450, VERDICTS.voting, "exact", null, NO_FILTERS).said.mode).toBe("fast");
    const exact = RING.map((one) => ({ ...one, mode: "exact" as const }));
    expect(scanRun(exact, 1450, VERDICTS.voting, "fast", null, NO_FILTERS).said.mode).toBe("exact");
  });

  /** No press sends one — a run has five frames at least — but the function is total. */
  it("falls back to the page's mode, and says nothing else, for a run with no frame in it", () => {
    const run = scanRun([], 1450, VERDICTS.decided, "exact", STATUS.present, NO_FILTERS);
    expect(run.frames).toEqual([]);
    expect(run.said).toEqual({
      reported: null,
      mode: "exact",
      confidence: null,
      distance: null,
      bundle: 117630,
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
    expect(scanRun(RING, 1450, null, "fast", null, narrowed).said.filters).toEqual(narrowed);
  });
});

describe("submissionOf", () => {
  it("puts the reader's two answers beside what the scanner said and the whole run", () => {
    const narrowed: ScanFilters = { sets: ["ltr"], released_from: null, released_to: null };
    const run = scanRun(
      [frame(1, 1000), runFrameOf(new Uint8Array([2]), 1110, VERDICTS.decided, false)],
      1120,
      VERDICTS.decided,
      "fast",
      STATUS.present,
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

  it("sends no card as a null id and a null finish, and everything else as it is", () => {
    const ring = [1, 2, 3, 4, 5].map((n) => frame(n, 1000 + n * 100));
    const run = scanRun(ring, 1550, null, "fast", null, NO_FILTERS);
    const sent = submissionOf(run, null);
    expect(sent.cardId).toBeNull();
    expect(sent.finish).toBeNull();
    expect(sent).toEqual({
      ...submissionOf(run, { cardId: "x", finish: "foil" }),
      cardId: null,
      finish: null,
    });
    expect(Object.keys(sent)).toHaveLength(9);
  });
});
