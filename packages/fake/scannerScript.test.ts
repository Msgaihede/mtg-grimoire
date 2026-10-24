import { afterEach, describe, expect, it, vi } from "vitest";
import { DECISION_GAP_FRAMES } from "@grimoire/ui/features/scanner/useScanLoop";
import { matchStrip } from "@grimoire/ui/features/scanner/reader/readerText";
import { addDecision } from "@grimoire/ui/features/scanner/reader/tray";
import { trayFinish } from "@grimoire/ui/features/scanner/reader/trayFinish";
import type { ScannerTrayRow, ScannerVerdict } from "@grimoire/ui/lib/ipc";
import { invoke, registerCommands, resetCommands } from "./core";
import { allHandlers, makeDb } from "./db";
import {
  FAKE_FRAME_MS,
  FAKE_PILE,
  FRAMES_PER_CARD,
  MODELS_NOT_LOADED,
  newScanScript,
  resetScanScript,
  scanStep,
} from "./scannerScript";

/** The last of a list — `Array.prototype.at` is past this program's `lib`. */
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

/** Every frame of the pile and a few after it. */
function session(missing = false): ScannerVerdict[] {
  const script = newScanScript();
  return Array.from({ length: FAKE_PILE.length * FRAMES_PER_CARD + 6 }, () =>
    scanStep(script, missing),
  );
}

/**
 * What a page that honoured the loop's rule would have in its tray after a session: the first
 * number is a baseline, and a number that moves on a frame carrying a decision is one card — the
 * `useScanLoop` edge, restated, with the tray's own reducer and its own finish rule.
 */
function trayAfter(frames: readonly ScannerVerdict[]): ScannerTrayRow[] {
  let rows: ScannerTrayRow[] = [];
  let seen: number | null = null;
  frames.forEach((frame, i) => {
    const before = seen;
    seen = frame.decision_seq;
    if (before === null || frame.decision === null || frame.decision_seq === before) return;
    rows = addDecision(
      rows,
      frame.decision,
      { finish: trayFinish("detect", frame.decision) },
      i,
      `row-${i}`,
    ).rows;
  });
  return rows;
}

afterEach(() => {
  vi.useRealTimers();
  resetCommands();
});

describe("the fake scanner's script", () => {
  it("starts on an empty desk, so the first number a camera sees is a baseline", () => {
    const [first] = session();
    expect(first.quad).toBeNull();
    expect(first.decision).toBeNull();
    expect(first.decision_seq).toBe(0);
  });

  it("moves the number once per card, on a frame that carries the decision, and never back", () => {
    const frames = session();
    let last = 0;
    const moved: number[] = [];
    frames.forEach((frame, i) => {
      expect(frame.decision_seq).toBeGreaterThanOrEqual(last);
      if (frame.decision_seq !== last) {
        expect(frame.decision_seq).toBe(last + 1);
        expect(frame.decision).not.toBeNull();
        moved.push(i);
      }
      last = frame.decision_seq;
    });
    expect(moved).toHaveLength(FAKE_PILE.length);
    // Further apart than the gap inside which the loop drops a second decision as the same card.
    for (let i = 1; i < moved.length; i++) {
      expect(moved[i] - moved[i - 1]).toBeGreaterThan(DECISION_GAP_FRAMES);
    }
  });

  it("holds each decided card with the same number until it is lifted, then looks at nothing", () => {
    const frames = session();
    const deciding = frames.findIndex((frame) => frame.decision !== null);
    const held = frames.slice(deciding, deciding + 6);
    expect(new Set(held.map((frame) => frame.decision_seq)).size).toBe(1);
    expect(held.every((frame) => frame.decision?.printing === FAKE_PILE[0].id)).toBe(true);
    expect(frames[deciding + 6].quad).toBeNull();
    expect(frames[deciding + 6].decision_seq).toBe(1);
  });

  it("fills the bar while it weighs a card and never before the frame that decides", () => {
    const frames = session();
    const deciding = frames.findIndex((frame) => frame.decision !== null);
    const fills = frames
      .slice(0, deciding + 1)
      .map((frame) => matchStrip(frame, null))
      .filter((strip) => strip.word !== "Looking");
    expect(fills.slice(0, -1).map((strip) => strip.word)).toEqual(
      fills.slice(0, -1).map(() => "Matching"),
    );
    const weighed = fills.slice(0, -1).map((strip) => strip.fill);
    expect(weighed).toEqual([...weighed].sort((a, b) => a - b));
    expect(Math.max(...weighed)).toBeLessThan(1);
    expect(last(fills)).toMatchObject({ word: "Matched", fill: 1 });
  });

  /**
   * **The tray's shapes**: the card whose picture stands for three printings waits on a pick, and
   * the ones that are one printing are decided outright. Under Detect a printing made in two
   * finishes lands `Unknown` — and an `Unknown` row never takes a second copy (`addDecision`), so
   * the two Sagas are two rows.
   */
  it("lays down the tray's shapes: a pick, printings sold one way, and finishes to settle", () => {
    const frames = session();
    const rows = trayAfter(frames);
    expect(rows[0].name).toBe("Lightning Bolt");
    expect(rows[0].choices.map((choice) => `${choice.setCode} ${choice.collectorNumber}`)).toEqual([
      "2x2 117",
      "sta 105",
      "sld 1638",
    ]);
    expect(
      rows.slice(1).map((row) => [row.name, row.quantity, row.finish, row.choices.length]),
    ).toEqual([
      ["Black Lotus", 1, "nonfoil", 0],
      ["Ancient Tomb", 1, "nonfoil", 0],
      ["Urza's Saga", 1, "unknown", 0],
      ["Urza's Saga", 1, "unknown", 0],
    ]);
    const decisions = frames.flatMap((frame) => (frame.decision === null ? [] : [frame.decision]));
    expect(new Set(decisions.map((decision) => decision.outcome))).toEqual(
      new Set(["resolved", "ambiguous"]),
    );
    expect(
      decisions.filter((d) => d.outcome === "resolved").every((d) => d.choices.length === 0),
    ).toBe(true);
  });

  it("asks for a pick on the card it cannot pin", () => {
    const bolt = session().find((frame) => frame.decision?.outcome === "ambiguous");
    expect(matchStrip(bolt ?? null, null)).toMatchObject({
      word: "3 printings",
      name: "Lightning Bolt",
      sentence: "Pick a printing in the tray",
    });
  });

  it("fails every frame in the crate's sentence, and decides nothing, with no models", () => {
    const frames = session(true);
    expect(frames.every((frame) => frame.ok === false && frame.error === MODELS_NOT_LOADED)).toBe(
      true,
    );
    expect(frames.every((frame) => frame.decision === null && frame.decision_seq === 0)).toBe(true);
    expect(frames.every((frame) => frame.matcher === false)).toBe(true);
    expect(matchStrip(frames[0], null).word).toBe("Can't identify");
  });

  it("lays the pile down again on a reset, and keeps the number it had reached", () => {
    const script = newScanScript();
    for (let i = 0; i < FRAMES_PER_CARD * 2; i++) scanStep(script, false);
    expect(script.seq).toBe(2);
    resetScanScript(script);
    const again = Array.from({ length: FRAMES_PER_CARD }, () => scanStep(script, false));
    expect(again[0].quad).toBeNull();
    expect(again[0].decision_seq).toBe(2);
    expect(last(again)?.decision?.printing).toBe(FAKE_PILE[0].id);
    expect(last(again)?.decision_seq).toBe(3);
  });
});

describe("scanner_frame over the fake", () => {
  it("hands a handler the caller's options second, and nothing second to a call without any", async () => {
    const seen: unknown[][] = [];
    registerCommands({
      echo: (...args: unknown[]) => {
        seen.push(args);
        return null;
      },
    });
    await invoke("echo", { n: 1 });
    await invoke("echo", new Uint8Array([1]), { headers: { "x-scanner-capture": "{}" } });
    expect(seen[0]).toEqual([{ n: 1 }]);
    expect(seen[1]).toEqual([new Uint8Array([1]), { headers: { "x-scanner-capture": "{}" } }]);
  });

  it("answers the script's next frame after a frame's wait", async () => {
    vi.useFakeTimers();
    const handlers = allHandlers(makeDb());

    let answered: ScannerVerdict | null = null;
    void handlers.scanner_frame().then((verdict) => {
      answered = verdict;
    });
    await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS - 1);
    expect(answered).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toMatchObject({ decision_seq: 0, decision: null });

    // The pile, to its first decision: one number, and one card.
    let last: ScannerVerdict | null = answered;
    for (let i = 1; i < FRAMES_PER_CARD; i++) {
      const next = handlers.scanner_frame();
      await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS);
      last = await next;
    }
    expect(last).toMatchObject({ decision_seq: 1 });
    expect(last?.decision?.printing).toBe(FAKE_PILE[0].id);
  });

  it("finds nothing to name under scannerMissing", async () => {
    vi.useFakeTimers();
    const handlers = allHandlers(makeDb({ fault: "scannerMissing" }));
    let last: ScannerVerdict | null = null;
    for (let i = 0; i < FRAMES_PER_CARD; i++) {
      const next = handlers.scanner_frame();
      await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS);
      last = await next;
    }
    expect(last).toMatchObject({ decision: null, decision_seq: 0, matcher: false });
  });

  it("starts the pile again on scanner_reset", async () => {
    vi.useFakeTimers();
    const handlers = allHandlers(makeDb());
    for (let i = 0; i < FRAMES_PER_CARD + 1; i++) {
      const next = handlers.scanner_frame();
      await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS);
      await next;
    }
    handlers.scanner_reset();
    const first = handlers.scanner_frame();
    await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS);
    expect(await first).toMatchObject({ quad: null, decision_seq: 1 });
  });
});
