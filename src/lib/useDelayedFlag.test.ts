import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "@/lib/useDelayedFlag";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flag = (active: boolean) =>
  renderHook(({ active }) => useDelayedFlag(active, 400), { initialProps: { active } });

describe("useDelayedFlag", () => {
  it("waits out the delay before turning on", () => {
    const { result } = flag(true);

    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(399));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  /** The case the delay exists for: a Refresh that finds nothing new is over in ~1.8s, of
   *  which `checking` is under one — and a sentence nobody can finish reading is worse than
   *  no sentence. */
  it("never turns on for something shorter than the delay", () => {
    const { result, rerender } = flag(true);

    act(() => void vi.advanceTimersByTime(200));
    rerender({ active: false });
    act(() => void vi.advanceTimersByTime(5_000));

    expect(result.current).toBe(false);
  });

  /** Asymmetric on purpose: appearing is what needs a threshold, and a line that lingered
   *  after the work stopped would be the interface lying. */
  it("turns off the instant the work stops", () => {
    const { result, rerender } = flag(true);
    act(() => void vi.advanceTimersByTime(400));
    expect(result.current).toBe(true);

    rerender({ active: false });

    expect(result.current).toBe(false);
  });

  it("re-arms after a gap", () => {
    const { result, rerender } = flag(true);
    act(() => void vi.advanceTimersByTime(400));
    rerender({ active: false });

    rerender({ active: true });
    act(() => void vi.advanceTimersByTime(399));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });
});
