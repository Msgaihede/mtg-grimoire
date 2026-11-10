import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  type InfiniteData,
} from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { CollectionRow } from "@/lib/ipc";

const collectionSetQuantity = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionSetQuantity },
}));

import { useCollectionEntryWrites } from "./useCollectionEntryWrites";

/** Only what the cache arithmetic reads: the id and the number. */
const row = (id: number, quantity: number) => ({ id, quantity }) as CollectionRow;
type Page = { items: CollectionRow[]; total: number };
const LIST_KEY = ["collection", "list", "{}"] as const;

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  collectionSetQuantity.mockReset();
});

describe("useCollectionEntryWrites — the stepper (issue #1535)", () => {
  /**
   * **A re-read of the list asked before a press does not paint the old number over it.**
   *
   * Two pages loaded and the list settled whole — a drag onto a folder heading does this — so every
   * page is re-read in turn. Page 1 has answered (with the old 3) when the reader steps its row to
   * 4, and page 2 is still out. When page 2 landed, the re-read wrote the old page 1 back, and the
   * stepper's own settle never re-reads the list, so the row stayed at 3 for good.
   */
  it("keeps a stepped number when a list re-read that started first lands after it", async () => {
    const database = new Map([
      [1, 3],
      [2, 1],
    ]);
    let holdPage2: (() => void) | null = null;
    const listPage = vi.fn(async (page: number): Promise<Page> => {
      const items = [row(page, database.get(page) ?? 0)];
      // Calls 1–2 are the first load, 3–4 the re-read; only the re-read's page 2 is held.
      if (page === 2 && listPage.mock.calls.length === 4) {
        await new Promise<void>((resolve) => {
          holdPage2 = resolve;
        });
      }
      return { items, total: 2 };
    });
    collectionSetQuantity.mockImplementation(async (id: number, quantity: number) => {
      database.set(id, quantity);
      return { id, quantity, removed: false };
    });

    const { result } = renderHook(
      () => ({
        list: useInfiniteQuery({
          queryKey: LIST_KEY,
          queryFn: ({ pageParam }) => listPage(pageParam),
          initialPageParam: 1,
          getNextPageParam: (_last: Page, pages: Page[]) =>
            pages.length < 2 ? pages.length + 1 : undefined,
        }),
        writes: useCollectionEntryWrites(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.list.data?.pages).toHaveLength(1));
    await result.current.list.fetchNextPage();
    const shown = () =>
      client.getQueryData<InfiniteData<Page>>(LIST_KEY)?.pages[0].items[0].quantity;
    expect(shown()).toBe(3);

    // Something else settles the list; page 1 answers 3 and page 2 is held.
    void client.invalidateQueries({ queryKey: ["collection"] });
    await waitFor(() => expect(holdPage2).not.toBeNull());

    await result.current.writes.setQuantity.mutateAsync({ row: { id: 1 }, quantity: 4 });
    expect(shown()).toBe(4);

    holdPage2?.();
    await new Promise((settled) => setTimeout(settled, 0));
    expect(shown()).toBe(4);
    // And the read the press cancelled is asked again once the run settles, so the list is the
    // database's rather than the guess's.
    await waitFor(() => expect(listPage.mock.calls.length).toBeGreaterThan(4));
    await waitFor(() => expect(client.isFetching({ queryKey: LIST_KEY })).toBe(0));
    expect(shown()).toBe(4);
  });

  /** Three quick presses, press 1's answer landing after press 2's guess: 3 becomes 6, not 5. */
  it("keeps a newer press's guess when an older answer lands after it", async () => {
    client.setQueryData<InfiniteData<Page>>(LIST_KEY, {
      pages: [{ items: [row(1, 3)], total: 1 }],
      pageParams: [1],
    });
    const answers: (() => void)[] = [];
    collectionSetQuantity.mockImplementation(
      (id: number, quantity: number) =>
        new Promise((resolve) => {
          answers.push(() => resolve({ id, quantity, removed: false }));
        }),
    );
    const { result } = renderHook(() => useCollectionEntryWrites(), { wrapper });
    const shown = () =>
      client.getQueryData<InfiniteData<Page>>(LIST_KEY)?.pages[0].items[0].quantity ?? 0;
    const press = async () => {
      const sent = collectionSetQuantity.mock.calls.length;
      result.current.setQuantity.mutate({ row: { id: 1 }, quantity: shown() + 1 });
      await waitFor(() => expect(collectionSetQuantity).toHaveBeenCalledTimes(sent + 1));
    };

    await press();
    await press();
    answers[0]();
    await new Promise((settled) => setTimeout(settled, 0));
    expect(shown()).toBe(5);

    await press();
    answers[1]();
    answers[2]();

    expect(collectionSetQuantity.mock.calls.map((call) => call[1])).toEqual([4, 5, 6]);
    await waitFor(() => expect(shown()).toBe(6));
  });
});
