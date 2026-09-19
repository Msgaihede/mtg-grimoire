import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc, type DbChanged } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import { useCrossWindowRefresh } from "./useCrossWindowRefresh";

afterEach(() => vi.restoreAllMocks());

describe("useCrossWindowRefresh", () => {
  it("turns another window's write into this window's invalidation, and unsubscribes", () => {
    let hear: ((e: DbChanged) => void) | undefined;
    const off = vi.fn();
    vi.spyOn(ipc, "onDbChanged").mockImplementation((cb) => {
      hear = cb;
      return off;
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { unmount } = renderHook(() => useCrossWindowRefresh());
    hear?.({ tables: ["wishlist_entries"] });

    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["wishlist"] }),
      { cancelRefetch: false },
    );
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
