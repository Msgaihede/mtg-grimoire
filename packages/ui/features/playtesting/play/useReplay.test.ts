import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayStep } from "./fixtures";
import { REPLAY_MS, replayEntries, useReplay, type ReplayEntry } from "./useReplay";

const { reduced } = vi.hoisted(() => ({ reduced: { value: false } }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reduced.value,
}));

describe("replayEntries", () => {
  it("says every fact once and in order: each frame's run, then what is left", () => {
    const { step } = replayStep();
    const entries = replayEntries(step, step.frames);
    expect(entries.map((e) => e.view)).toEqual([...step.frames.map((f) => f.view), step.view]);
    expect(entries.flatMap((e) => e.happened)).toEqual(step.happened);
    expect(entries[entries.length - 1].happened.map((h) => h.type)).toEqual(["turnBegan", "drew"]);
  });

  it("is the step alone without frames", () => {
    const { step } = replayStep();
    expect(replayEntries({ ...step, frames: [] }, [])).toEqual([
      { view: step.view, happened: step.happened },
    ]);
  });

  it("still says each fact once when a frame's facts are not in the list in order", () => {
    const { step } = replayStep();
    const shuffled = [...step.frames].reverse();
    const entries = replayEntries(step, shuffled);
    expect(entries.flatMap((e) => e.happened)).toHaveLength(step.happened.length);
  });
});

describe("useReplay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reduced.value = false;
  });
  afterEach(() => vi.useRealTimers());

  function setup() {
    const shown: ReplayEntry[] = [];
    const hook = renderHook(() => useReplay((e) => shown.push(e)));
    const { step } = replayStep();
    return { hook, shown, step, entries: replayEntries(step, step.frames) };
  }

  it("shows one beat, then each next one a beat apart, read-only until the last", () => {
    const { hook, shown, entries } = setup();
    act(() => hook.result.current.play(entries));
    expect(shown).toHaveLength(1);
    expect(hook.result.current.replaying).toBe(true);
    act(() => vi.advanceTimersByTime(REPLAY_MS - 1));
    expect(shown).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(shown).toHaveLength(2);
    act(() => vi.advanceTimersByTime(REPLAY_MS * entries.length));
    expect(shown.map((e) => e.view)).toEqual(entries.map((e) => e.view));
    expect(hook.result.current.replaying).toBe(false);
  });

  it("skips to the end at once, every fact still said, nothing popped", () => {
    const { hook, shown, entries, step } = setup();
    act(() => hook.result.current.play(entries));
    act(() => hook.result.current.skip());
    expect(hook.result.current.replaying).toBe(false);
    expect(shown).toHaveLength(2);
    expect(shown[1]).toEqual({
      view: step.view,
      happened: entries.slice(1).flatMap((e) => e.happened),
      quiet: true,
    });
    act(() => vi.advanceTimersByTime(REPLAY_MS * 10));
    expect(shown).toHaveLength(2);
  });

  it("shows the end at once under reduced motion", () => {
    reduced.value = true;
    const { hook, shown, entries, step } = setup();
    act(() => hook.result.current.play(entries));
    expect(hook.result.current.replaying).toBe(false);
    expect(shown).toHaveLength(1);
    expect(shown[0].view).toBe(step.view);
    expect(shown[0].happened).toEqual(step.happened);
  });

  it("drops what is left on cancel", () => {
    const { hook, shown, entries } = setup();
    act(() => hook.result.current.play(entries));
    act(() => hook.result.current.cancel());
    act(() => vi.advanceTimersByTime(REPLAY_MS * 10));
    expect(shown).toHaveLength(1);
  });
});
