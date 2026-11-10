import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatestPress } from "./useLatestPress";

describe("useLatestPress (issue #1535)", () => {
  it("lets only the newest press of a row answer", () => {
    const { result } = renderHook(() => useLatestPress());
    const first = result.current.press("7");
    const second = result.current.press("7");

    expect(result.current.isLatest("7", first)).toBe(false);
    expect(result.current.isLatest("7", second)).toBe(true);
  });

  it("keeps rows apart", () => {
    const { result } = renderHook(() => useLatestPress());
    const seven = result.current.press("7");
    const eight = result.current.press("8");

    expect(result.current.isLatest("7", seven)).toBe(true);
    expect(result.current.isLatest("8", eight)).toBe(true);
  });

  /** An older answer that arrives after the newer press has landed and been forgotten. */
  it("does not let an older answer through once the newer press has finished", () => {
    const { result } = renderHook(() => useLatestPress());
    const first = result.current.press("7");
    const second = result.current.press("7");

    result.current.release("7", second);
    expect(result.current.isLatest("7", first)).toBe(false);

    // An older press finishing does not forget the newer one's row.
    const third = result.current.press("7");
    result.current.release("7", first);
    expect(result.current.isLatest("7", third)).toBe(true);
  });
});
