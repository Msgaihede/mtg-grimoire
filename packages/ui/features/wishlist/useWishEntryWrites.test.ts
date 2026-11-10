import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { WishRow } from "@/lib/ipc";

const wishlistSetQuantity = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { wishlistSetQuantity },
}));

import { useWishEntryWrites } from "./useWishEntryWrites";

type Page = { items: WishRow[]; total: number };
const LIST_KEY = ["wishlist", "list", "{}"] as const;

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wishlistSetQuantity.mockReset();
});

describe("useWishEntryWrites — the stepper (issue #1535)", () => {
  /** The collection's twin: three quick presses with press 1's answer late, and 3 becomes 6. */
  it("keeps a newer press's guess when an older answer lands after it", async () => {
    client.setQueryData<InfiniteData<Page>>(LIST_KEY, {
      pages: [{ items: [{ id: 7, quantity: 3 } as WishRow], total: 1 }],
      pageParams: [1],
    });
    const answers: (() => void)[] = [];
    wishlistSetQuantity.mockImplementation(
      (id: number, quantity: number) =>
        new Promise((resolve) => {
          answers.push(() => resolve({ id, quantity, removed: false }));
        }),
    );
    const { result } = renderHook(() => useWishEntryWrites(), { wrapper });
    const shown = () =>
      client.getQueryData<InfiniteData<Page>>(LIST_KEY)?.pages[0].items[0].quantity ?? 0;
    const press = async () => {
      const sent = wishlistSetQuantity.mock.calls.length;
      result.current.setQuantity.mutate({ row: { id: 7 }, quantity: shown() + 1 });
      await waitFor(() => expect(wishlistSetQuantity).toHaveBeenCalledTimes(sent + 1));
    };

    await press();
    await press();
    answers[0]();
    await new Promise((settled) => setTimeout(settled, 0));
    expect(shown()).toBe(5);

    await press();
    answers[1]();
    answers[2]();

    expect(wishlistSetQuantity.mock.calls.map((call) => call[1])).toEqual([4, 5, 6]);
    await waitFor(() => expect(shown()).toBe(6));
  });

  /** And the whole-root re-read waits for the run to end, rather than going out behind each answer. */
  it("re-reads the wishlist once a run of presses goes quiet", async () => {
    wishlistSetQuantity.mockImplementation(async (id: number, quantity: number) => ({
      id,
      quantity,
      removed: false,
    }));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useWishEntryWrites(), { wrapper });
    const wishlistReads = () =>
      invalidate.mock.calls.filter(([filters]) => filters?.queryKey?.[0] === "wishlist").length;

    for (const quantity of [2, 3, 4]) {
      await result.current.setQuantity.mutateAsync({ row: { id: 7 }, quantity });
    }
    expect(wishlistReads()).toBe(0);
    await waitFor(() => expect(wishlistReads()).toBe(1));
  });
});
