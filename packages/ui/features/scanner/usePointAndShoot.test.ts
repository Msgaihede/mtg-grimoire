import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePointAndShoot } from "./usePointAndShoot";

function shoot(initial: { on: boolean; interrupted: boolean }) {
  return renderHook((props) => usePointAndShoot(props), { initialProps: initial });
}

describe("usePointAndShoot", () => {
  it("forgets the standing card as a shot starts, and a click's shot ends on its card", () => {
    const { result } = shoot({ on: true, interrupted: false });
    const forget = vi.fn();
    act(() => result.current.start(forget, "card"));
    expect(forget).toHaveBeenCalledTimes(1);
    expect(result.current.shooting).toBe(true);
    act(() => result.current.landed());
    expect(result.current.shooting).toBe(false);
  });

  it("keeps a hold's shot through its cards, and ends it when let go", () => {
    const { result } = shoot({ on: true, interrupted: false });
    act(() => result.current.start(() => {}, "release"));
    act(() => result.current.landed());
    expect(result.current.shooting).toBe(true);
    act(() => result.current.stop());
    expect(result.current.shooting).toBe(false);
  });

  it("ends a shot when the pump is paused from outside, or the switch goes off", () => {
    const { result, rerender } = shoot({ on: true, interrupted: false });
    act(() => result.current.start(() => {}, "release"));
    rerender({ on: true, interrupted: true });
    expect(result.current.shooting).toBe(false);
    // Coming back does not resume it: a hold whose release went elsewhere is over.
    rerender({ on: true, interrupted: false });
    expect(result.current.shooting).toBe(false);

    act(() => result.current.start(() => {}, "card"));
    rerender({ on: false, interrupted: false });
    expect(result.current.shooting).toBe(false);
  });

  it("starts nothing while off or interrupted", () => {
    const forget = vi.fn();
    const off = shoot({ on: false, interrupted: false });
    act(() => off.result.current.start(forget, "card"));
    expect(off.result.current.shooting).toBe(false);
    const paused = shoot({ on: true, interrupted: true });
    act(() => paused.result.current.start(forget, "release"));
    expect(paused.result.current.shooting).toBe(false);
    expect(forget).not.toHaveBeenCalled();
  });
});
