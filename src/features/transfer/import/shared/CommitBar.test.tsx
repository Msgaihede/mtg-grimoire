import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useImportCommit } from "./CommitBar";

function wrap(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useImportCommit", () => {
  /**
   * A bulk import moves ownership at least as much as one row-level write, so it earns the same
   * invalidation set `CollectionPage`'s and `WishlistPage`'s own `settle()` take — never just
   * the destination's own root. Pinned here rather than only through a component test, because
   * the failure mode (one key silently dropped from the array) would not fail a component test
   * that only asserts the commit landed.
   */
  it("invalidates every key it is given, on success", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(
      () =>
        useImportCommit(
          [["collection"], ["wishlist"], ["cards", "search"], ["decks"]],
          () => Promise.resolve({ added: 1, updated: 0, removed: 0 }),
        ),
      { wrapper: wrap(client) },
    );

    await act(async () => {
      await result.current.mutateAsync(undefined);
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["collection"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["decks"] });
  });

  /** A refusal can still have been a database another surface has changed — `useImport`'s own
   *  rule for `["decks"]`, carried here. */
  it("invalidates every key it is given, on failure too", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(
      () =>
        useImportCommit([["wishlist"], ["cards", "search"]], () =>
          Promise.reject(new Error("refused")),
        ),
      { wrapper: wrap(client) },
    );

    await act(async () => {
      await result.current.mutateAsync(undefined).catch(() => {});
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
  });
});
