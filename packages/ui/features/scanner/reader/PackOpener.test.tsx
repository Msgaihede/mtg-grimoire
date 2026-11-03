import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PACK_IDLE_MS,
  PACK_READY,
  PACK_SCANNING,
  PACK_STOPPED,
  PackIndicator,
  packFades,
  usePackIdle,
} from "./PackOpener";

describe("usePackIdle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes idle once the controls have been left alone, and wakes on the next touch", () => {
    const { result } = renderHook(() => usePackIdle(true));
    expect(result.current.idle).toBe(false);
    act(() => vi.advanceTimersByTime(PACK_IDLE_MS - 1));
    expect(result.current.idle).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.idle).toBe(true);

    act(() => result.current.wake());
    expect(result.current.idle).toBe(false);
    // Each touch restarts the clock rather than adding to it.
    act(() => vi.advanceTimersByTime(PACK_IDLE_MS - 1));
    act(() => result.current.wake());
    act(() => vi.advanceTimersByTime(PACK_IDLE_MS - 1));
    expect(result.current.idle).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.idle).toBe(true);
  });

  it("never hides anything outside the pack opener, and opens again awake", () => {
    const { result, rerender } = renderHook(({ on }) => usePackIdle(on), {
      initialProps: { on: false },
    });
    act(() => vi.advanceTimersByTime(PACK_IDLE_MS * 2));
    expect(result.current.idle).toBe(false);

    rerender({ on: true });
    act(() => vi.advanceTimersByTime(PACK_IDLE_MS));
    expect(result.current.idle).toBe(true);

    rerender({ on: false });
    expect(result.current.idle).toBe(false);
    rerender({ on: true });
    expect(result.current.idle).toBe(false);
  });
});

describe("packFades", () => {
  it("fades only while idle, and stays up under the pointer, keyboard focus or an open panel", () => {
    expect(packFades(false)).not.toContain("opacity-0");
    const idle = packFades(true).split(" ");
    expect(idle).toContain("opacity-0");
    expect(idle).toContain("hover:opacity-100");
    expect(idle).toContain("has-[:focus-visible]:opacity-100");
    expect(idle).toContain("has-[[aria-expanded=true]]:opacity-100");
  });
});

describe("PackIndicator", () => {
  it("says what the scanner is doing, green while it reads and red while it does not", () => {
    const { rerender } = render(<PackIndicator reading pointAndShoot={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(PACK_SCANNING);
    expect(screen.getByRole("status")).toHaveAttribute("data-pack-light", "on");

    rerender(<PackIndicator reading={false} pointAndShoot={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(PACK_STOPPED);
    expect(screen.getByRole("status")).toHaveAttribute("data-pack-light", "off");

    rerender(<PackIndicator reading={false} pointAndShoot />);
    expect(screen.getByRole("status")).toHaveTextContent(PACK_READY);
  });
});
