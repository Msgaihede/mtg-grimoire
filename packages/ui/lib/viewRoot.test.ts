import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { useViewRootRequest } from "@/lib/viewRoot";

beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

describe("useViewRootRequest", () => {
  it("walks the page home once per re-press and spends the request", () => {
    useAppStore.getState().selectView("collection");
    const toRoot = vi.fn();
    renderHook(() => useViewRootRequest("collection", toRoot));
    expect(toRoot).not.toHaveBeenCalled();

    act(() => useAppStore.getState().selectView("collection"));
    expect(toRoot).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().rootRequest).toBeNull();

    act(() => useAppStore.getState().selectView("collection"));
    expect(toRoot).toHaveBeenCalledTimes(2);
  });

  /** The re-press from an editor swaps the editor for the page: the page mounts already asked. */
  it("answers a request waiting when the page mounts", () => {
    useAppStore.getState().selectView("decks");
    useAppStore.getState().selectView("decks");
    const toRoot = vi.fn();

    renderHook(() => useViewRootRequest("decks", toRoot));

    expect(toRoot).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().rootRequest).toBeNull();
  });

  it("leaves another view's request alone", () => {
    useAppStore.getState().selectView("wishlist");
    useAppStore.getState().selectView("wishlist");
    const toRoot = vi.fn();

    renderHook(() => useViewRootRequest("collection", toRoot));

    expect(toRoot).not.toHaveBeenCalled();
    expect(useAppStore.getState().rootRequest).toBe("wishlist");
  });
});
