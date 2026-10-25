import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const entryTagsInUse = vi.hoisted(() => vi.fn());
const collectionSetTags = vi.hoisted(() => vi.fn());
const wishlistSetTags = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { entryTagsInUse, collectionSetTags, wishlistSetTags },
}));

import { ENTRY_TAGS_KEY, useEntryTagsInUse, useSetEntryTags } from "./useEntryTags";

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  entryTagsInUse.mockReset();
  collectionSetTags.mockReset();
  wishlistSetTags.mockReset();
});

describe("useEntryTagsInUse", () => {
  it("folds the per-spelling answer into suggestions", async () => {
    entryTagsInUse.mockResolvedValue([
      { tag: "Cube", count: 2 },
      { tag: "cube", count: 1 },
      { tag: "Binder", count: 1 },
    ]);
    const { result } = renderHook(() => useEntryTagsInUse(), { wrapper });
    expect(result.current).toEqual([]);
    await waitFor(() =>
      expect(result.current).toEqual([
        { tag: "Binder", count: 1 },
        { tag: "Cube", count: 3 },
      ]),
    );
  });

  it("offers nothing when the read is refused", async () => {
    entryTagsInUse.mockRejectedValue("The card database is busy.");
    const { result } = renderHook(() => useEntryTagsInUse(), { wrapper });
    await waitFor(() => expect(entryTagsInUse).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it("reads nothing while disabled", () => {
    renderHook(() => useEntryTagsInUse(false), { wrapper });
    expect(entryTagsInUse).not.toHaveBeenCalled();
  });
});

describe("useSetEntryTags", () => {
  it("writes a collection row's tags and settles the collection and the suggestions", async () => {
    collectionSetTags.mockResolvedValue(["Cube"]);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useSetEntryTags(), { wrapper });

    act(() => result.current.setTags({ kind: "collection", id: 7 }, ["Cube"]));

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(collectionSetTags).toHaveBeenCalledWith(7, ["Cube"]);
    expect(wishlistSetTags).not.toHaveBeenCalled();
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["collection"]);
    expect(keys).toContainEqual(ENTRY_TAGS_KEY);
    expect(keys).not.toContainEqual(["wishlist"]);
    expect(result.current.error).toBeNull();
  });

  it("writes a wish's tags and settles the wishlist", async () => {
    wishlistSetTags.mockResolvedValue([]);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useSetEntryTags(), { wrapper });

    act(() => result.current.setTags({ kind: "wishlist", id: 3 }, []));

    await waitFor(() => expect(wishlistSetTags).toHaveBeenCalledWith(3, []));
    await waitFor(() =>
      expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(["wishlist"]),
    );
  });

  it("says the backend's sentence when the write is refused, and still re-reads", async () => {
    wishlistSetTags.mockRejectedValue("That wish is no longer on your wishlist.");
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useSetEntryTags(), { wrapper });

    act(() => result.current.setTags({ kind: "wishlist", id: 3 }, ["Cube"]));

    await waitFor(() =>
      expect(result.current.error).toBe("That wish is no longer on your wishlist."),
    );
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(["wishlist"]);
  });

  it("lands two quick writes in the order they were made", async () => {
    const landed: string[][] = [];
    let release = () => {};
    collectionSetTags
      .mockImplementationOnce(
        (_id: number, tags: string[]) =>
          new Promise((resolve) => {
            release = () => {
              landed.push(tags);
              resolve(tags);
            };
          }),
      )
      .mockImplementationOnce(async (_id: number, tags: string[]) => {
        landed.push(tags);
        return tags;
      });
    const { result } = renderHook(() => useSetEntryTags(), { wrapper });

    act(() => result.current.setTags({ kind: "collection", id: 7 }, ["a"]));
    act(() => result.current.setTags({ kind: "collection", id: 7 }, ["a", "b"]));
    await waitFor(() => expect(collectionSetTags).toHaveBeenCalledTimes(1));
    act(() => release());

    await waitFor(() => expect(landed).toEqual([["a"], ["a", "b"]]));
  });
});
