import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavLabels } from "@/lib/useNavLabels";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** The rail's own tween, which is what the delay is waiting out. */
const TWEEN = 180;

const labels = (collapsed: boolean, delayMs = TWEEN) =>
  renderHook(({ collapsed }) => useNavLabels(collapsed, delayMs), {
    initialProps: { collapsed },
  });

describe("useNavLabels", () => {
  /**
   * The bug this was written for: six labels re-entering the flow at full width inside a 68px
   * rail, painted over the view beside it for the whole 180ms the rail takes to widen.
   */
  it("holds the words back until the rail has finished widening", () => {
    const { result, rerender } = labels(true);
    expect(result.current).toBe(false);

    rerender({ collapsed: false });

    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(TWEEN - 1));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  /**
   * The other direction, and the asymmetry is the whole of this hook: the words go in the same
   * commit as the press, so nothing is ever painted wider than the rail holding it. A delay here
   * would be the same overflow with the sign flipped.
   */
  it("drops them in the commit that starts the rail closing", () => {
    const { result, rerender } = labels(false);
    expect(result.current).toBe(true);

    rerender({ collapsed: true });

    expect(result.current).toBe(false);
  });

  /**
   * A reader who changes their mind mid-tween. The pending reveal has to be cancelled, or the
   * words land 180ms later on a rail that is by then 68px wide — which is the original bug,
   * reached from a state nobody would think to check.
   */
  it("cancels a pending reveal when the rail is closed again", () => {
    const { result, rerender } = labels(true);
    rerender({ collapsed: false });
    act(() => void vi.advanceTimersByTime(TWEEN - 20));

    rerender({ collapsed: true });
    act(() => void vi.advanceTimersByTime(5_000));

    expect(result.current).toBe(false);
  });

  it("re-arms for the next opening", () => {
    const { result, rerender } = labels(true);
    rerender({ collapsed: false });
    act(() => void vi.advanceTimersByTime(TWEEN));
    rerender({ collapsed: true });

    rerender({ collapsed: false });

    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(TWEEN));
    expect(result.current).toBe(true);
  });

  /**
   * **The initial value is the state, not `false`.** A shell that opens expanded opens with its
   * words: the delay's whole justification is a tween, and nothing tweened at launch. A hook
   * that started every mount narrow would fade all six labels in 180ms after the window appears.
   */
  it("opens with the words already there when the rail opens wide", () => {
    expect(labels(false).result.current).toBe(true);
  });

  /**
   * `prefers-reduced-motion` snaps the rail to its new width — `motion-reduce:transition-none` —
   * so there is no tween to wait out, and the caller passes 0. One task rather than one frame,
   * against a rail that has not moved in between.
   */
  it("waits for nothing when the rail does not travel", () => {
    const { result, rerender } = labels(true, 0);
    rerender({ collapsed: false });

    act(() => void vi.advanceTimersByTime(0));

    expect(result.current).toBe(true);
  });
});
