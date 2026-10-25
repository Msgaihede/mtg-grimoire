import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { STEP_SETTLE_QUIET_MS, useStepSettle } from "./useStepSettle";

const KEY = ["things", "setQuantity"] as const;

function mounted() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(() => useStepSettle(KEY), { wrapper });
  return { client, ...hook };
}

describe("useStepSettle (issue #1402)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The point of it: three presses, one re-read, once the presses have gone quiet. */
  it("settles a run of presses once, after the last one", () => {
    const { result } = mounted();
    const settle = vi.fn();

    for (let press = 0; press < 3; press += 1) {
      result.current.hold();
      result.current.schedule(settle);
      act(() => vi.advanceTimersByTime(STEP_SETTLE_QUIET_MS - 50));
    }
    expect(settle).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(50));
    expect(settle).toHaveBeenCalledTimes(1);
  });

  /** A press that has started holds the re-read its predecessor scheduled. */
  it("holds a scheduled settle when the next press starts", () => {
    const { result } = mounted();
    const settle = vi.fn();

    result.current.schedule(settle);
    result.current.hold();
    act(() => vi.advanceTimersByTime(STEP_SETTLE_QUIET_MS * 2));

    expect(settle).not.toHaveBeenCalled();
  });

  /**
   * A re-read landing between two writes paints the first one's number over the second's guess, so
   * a quiet period that ends with a press still out does nothing — that press's own answer arms it.
   */
  it("does not settle while a press of the same key is still in flight", () => {
    const { client, result } = mounted();
    const settle = vi.fn();
    const inFlight = vi.spyOn(client, "isMutating").mockReturnValue(1);

    result.current.schedule(settle);
    act(() => vi.advanceTimersByTime(STEP_SETTLE_QUIET_MS));
    expect(inFlight).toHaveBeenCalledWith({ mutationKey: KEY });
    expect(settle).not.toHaveBeenCalled();

    // That press lands, and its own answer arms the settle again.
    inFlight.mockReturnValue(0);
    result.current.schedule(settle);
    act(() => vi.advanceTimersByTime(STEP_SETTLE_QUIET_MS));
    expect(settle).toHaveBeenCalledTimes(1);
  });

  /** A refusal settles now, and takes the scheduled one with it rather than running it again. */
  it("settles at once on a refusal, in place of the one owed", () => {
    const { result } = mounted();
    const owed = vi.fn();
    const failure = vi.fn();

    result.current.schedule(owed);
    result.current.now(failure);
    act(() => vi.advanceTimersByTime(STEP_SETTLE_QUIET_MS * 2));

    expect(failure).toHaveBeenCalledTimes(1);
    expect(owed).not.toHaveBeenCalled();
  });

  /** Leaving the page mid-run still re-reads what the run moved. */
  it("runs a settle still owed when it unmounts", () => {
    const { result, unmount } = mounted();
    const settle = vi.fn();

    result.current.schedule(settle);
    unmount();
    expect(settle).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(STEP_SETTLE_QUIET_MS * 2));
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
