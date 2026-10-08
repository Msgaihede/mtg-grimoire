import { afterEach, describe, expect, it, vi } from "vitest";
import { DECISION_GAP_FRAMES } from "@/features/scanner/useScanLoop";
import { matchStrip } from "@/features/scanner/reader/readerText";
import { addDecision } from "@/features/scanner/reader/tray";
import { trayFinish } from "@/features/scanner/reader/trayFinish";
import type { ScanMode, ScannerTrayRow, ScannerVerdict } from "@/lib/ipc";
import { invoke, registerCommands, resetCommands } from "./core";
import { allHandlers, makeDb } from "./db";
import {
  FAKE_FRAME_MS,
  FAKE_PILE,
  FRAMES_PER_CARD,
  newScanScript,
  resetScanScript,
  scanStep,
  sentOptions,
} from "./scannerScript";

/** The last of a list — `Array.prototype.at` is past this program's `lib`. */
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

/** Every frame of the pile and a few after it, in one mode. */
function session(mode: ScanMode, missing = false): ScannerVerdict[] {
  const script = newScanScript();
  return Array.from({ length: FAKE_PILE.length * FRAMES_PER_CARD + 6 }, () =>
    scanStep(script, mode, false, missing),
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
    rows = addDecision(rows, frame.decision, { finish: trayFinish("detect", frame.decision) }, i, `row-${i}`)
      .rows;
  });
  return rows;
}

afterEach(() => {
  vi.useRealTimers();
  resetCommands();
});

describe("the fake scanner's script", () => {
  it("starts on an empty desk, so the first number a camera sees is a baseline", () => {
    const [first] = session("fast");
    expect(first.quad).toBeNull();
    expect(first.decision).toBeNull();
    expect(first.decision_seq).toBe(0);
  });

  it("moves the number once per card, on a frame that carries the decision, and never back", () => {
    const frames = session("fast");
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
    const frames = session("fast");
    const deciding = frames.findIndex((frame) => frame.decision !== null);
    const held = frames.slice(deciding, deciding + 6);
    expect(new Set(held.map((frame) => frame.decision_seq)).size).toBe(1);
    expect(held.every((frame) => frame.decision?.printing === FAKE_PILE[0].id)).toBe(true);
    // The card lifted: no quad, which is what takes the page's latched resolve with it.
    expect(frames[deciding + 6].quad).toBeNull();
    expect(frames[deciding + 6].decision_seq).toBe(1);
  });

  it("fills the bar while it weighs a card and never before the frame that decides", () => {
    const frames = session("fast");
    const deciding = frames.findIndex((frame) => frame.decision !== null);
    const fills = frames
      .slice(0, deciding + 1)
      .map((frame) => matchStrip(frame, "fast", null, true, null))
      .filter((strip) => strip.word !== "Looking");
    expect(fills.slice(0, -1).map((strip) => strip.word)).toEqual(
      fills.slice(0, -1).map(() => "Matching"),
    );
    const weighed = fills.slice(0, -1).map((strip) => strip.fill);
    expect(weighed).toEqual([...weighed].sort((a, b) => a - b));
    expect(Math.max(...weighed)).toBeLessThan(1);
    expect(last(fills)).toMatchObject({ word: "Matched", fill: 1 });
  });

  it("lays down the tray's four shapes in Fast: a bump, a printing sold one way, and a finish to settle", () => {
    const rows = trayAfter(session("fast"));
    // Newest first.
    expect(rows.map((row) => [row.name, row.quantity, row.finish, row.choices.length])).toEqual([
      ["Lightning Bolt", 1, "unknown", 0],
      ["Black Lotus", 1, "nonfoil", 0],
      ["Ancient Tomb", 1, "nonfoil", 0],
      ["Urza's Saga", 2, "nonfoil", 0],
    ]);
  });

  it("cannot pin the last card in Exact, and says which three it could be", () => {
    const frames = session("exact");
    const rows = trayAfter(frames);
    expect(rows[0].name).toBe("Lightning Bolt");
    expect(rows[0].choices.map((choice) => `${choice.setCode} ${choice.collectorNumber}`)).toEqual([
      "2x2 117",
      "sta 105",
      "sld 1638",
    ]);
    // The cards Exact does pin are the ones Fast named.
    expect(rows.slice(1).map((row) => [row.name, row.quantity])).toEqual([
      ["Black Lotus", 1],
      ["Ancient Tomb", 1],
      ["Urza's Saga", 2],
    ]);
    // A resolve is reported on the one frame it ran on, with the outcome its decision carries.
    const resolves = frames.filter((frame) => frame.resolution !== null);
    expect(resolves).toHaveLength(FAKE_PILE.length);
    expect(resolves.map((frame) => frame.resolution?.outcome)).toEqual([
      "resolved",
      "resolved",
      "resolved",
      "resolved",
      "ambiguous",
    ]);
    expect(frames.every((frame) => frame.mode === "exact")).toBe(true);
  });

  it("reads Reading, not Matching, while Exact weighs a locked card", () => {
    const frames = session("exact");
    const weighing = frames.find((frame) => frame.quad !== null && frame.decision === null);
    expect(matchStrip(weighing ?? null, "exact", null, true, null).word).toBe("Reading");
  });

  it("names nothing and decides nothing with no bundle", () => {
    const frames = session("fast", true);
    expect(frames.some((frame) => frame.quad !== null)).toBe(true);
    expect(frames.every((frame) => frame.decision === null && frame.decision_seq === 0)).toBe(true);
    expect(frames.every((frame) => frame.quad === null || frame.matcher === false)).toBe(true);
  });

  it("sends previews only to a frame that asked for them", () => {
    const quiet = newScanScript();
    const asked = newScanScript();
    for (let i = 0; i < FRAMES_PER_CARD; i++) {
      expect(scanStep(quiet, "fast", false, false).rectified).toBeNull();
    }
    const withPreviews = Array.from({ length: FRAMES_PER_CARD }, () => scanStep(asked, "fast", true, false));
    expect(withPreviews.some((frame) => frame.rectified !== null)).toBe(true);
  });

  it("lays the pile down again on a reset, and keeps the number it had reached", () => {
    const script = newScanScript();
    for (let i = 0; i < FRAMES_PER_CARD * 2; i++) scanStep(script, "fast", false, false);
    expect(script.seq).toBe(2);
    resetScanScript(script);
    const again = Array.from({ length: FRAMES_PER_CARD }, () => scanStep(script, "fast", false, false));
    expect(again[0].quad).toBeNull();
    expect(again[0].decision_seq).toBe(2);
    expect(last(again)?.decision?.printing).toBe(FAKE_PILE[0].id);
    expect(last(again)?.decision_seq).toBe(3);
  });

  it("never asks for a detail frame", () => {
    expect(session("exact").every((frame) => frame.wants_detail === false)).toBe(true);
  });
});

describe("reading a frame's options out of its header", () => {
  it("takes the mode and the previews switch the page sent", () => {
    const headers = { "x-scanner-options": JSON.stringify({ mode: "exact", previews: true, decide_at: 8 }) };
    expect(sentOptions({ headers })).toEqual({ mode: "exact", previews: true });
    expect(
      sentOptions({ headers: { "x-scanner-options": JSON.stringify({ mode: "fast", previews: false }) } }),
    ).toEqual({ mode: "fast", previews: false });
  });

  it("answers nothing for a caller that sent no header", () => {
    expect(sentOptions(undefined)).toBeNull();
    expect(sentOptions({})).toBeNull();
    expect(sentOptions({ headers: {} })).toBeNull();
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
    await invoke("echo", new Uint8Array([1]), { headers: { "x-scanner-options": "{}" } });
    expect(seen[0]).toEqual([{ n: 1 }]);
    expect(seen[1]).toEqual([new Uint8Array([1]), { headers: { "x-scanner-options": "{}" } }]);
  });

  it("answers the script's next frame after a frame's wait, in the mode the header names", async () => {
    vi.useFakeTimers();
    const handlers = allHandlers(makeDb());
    const header = (mode: ScanMode) => ({
      headers: { "x-scanner-options": JSON.stringify({ mode, previews: false }) },
    });

    let answered: ScannerVerdict | null = null;
    void handlers.scanner_frame(new Uint8Array([1]), header("exact")).then((verdict) => {
      answered = verdict;
    });
    await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS - 1);
    expect(answered).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toMatchObject({ mode: "exact", decision_seq: 0, decision: null });

    // The pile, to its first decision: one number, and one card.
    let last: ScannerVerdict | null = answered;
    for (let i = 1; i < FRAMES_PER_CARD; i++) {
      const next = handlers.scanner_frame(new Uint8Array([1]), header("fast"));
      await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS);
      last = await next;
    }
    expect(last).toMatchObject({ mode: "fast", decision_seq: 1 });
    expect(last?.decision?.printing).toBe(FAKE_PILE[0].id);
  });

  it("reads the stored mode for a caller with no header, and finds nothing to name under scannerMissing", async () => {
    vi.useFakeTimers();
    const stored = makeDb();
    stored.scannerPrefs = { ...stored.scannerPrefs, mode: "exact" };
    const bare = allHandlers(stored).scanner_frame(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS);
    expect((await bare).mode).toBe("exact");

    const handlers = allHandlers(makeDb({ fault: "scannerMissing" }));
    let last: ScannerVerdict | null = null;
    for (let i = 0; i < FRAMES_PER_CARD; i++) {
      const next = handlers.scanner_frame(new Uint8Array([1]));
      await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS);
      last = await next;
    }
    expect(last).toMatchObject({ decision: null, decision_seq: 0, matcher: false });
  });

  it("starts the pile again on scanner_reset", async () => {
    vi.useFakeTimers();
    const handlers = allHandlers(makeDb());
    for (let i = 0; i < FRAMES_PER_CARD + 1; i++) {
      const next = handlers.scanner_frame(new Uint8Array([1]));
      await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS);
      await next;
    }
    handlers.scanner_reset();
    const first = handlers.scanner_frame(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(FAKE_FRAME_MS);
    expect(await first).toMatchObject({ quad: null, decision_seq: 1 });
  });
});
