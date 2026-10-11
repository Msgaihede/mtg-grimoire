import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useOptimisticEntries, type EntryPage } from "./useOptimisticEntries";

/** The least a row has to be: an id, and one number a press moves. */
interface Row {
  id: number;
  quantity: number;
}

const LIST = ["things", "list"] as const;

/** Two pages, each carrying the whole list's count — the shape both lists answer. */
const pages = (...rows: Row[][]): InfiniteData<EntryPage<Row>> => ({
  pages: rows.map((items) => ({ items, total: rows.flat().length })),
  pageParams: rows.map((_, i) => i * 100),
});

/** A client holding the "everything" list, a narrowed one, and a list under another key. */
function seeded() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData([...LIST, "all"], pages([{ id: 1, quantity: 2 }], [{ id: 2, quantity: 1 }]));
  client.setQueryData([...LIST, "foils"], pages([{ id: 1, quantity: 2 }]));
  client.setQueryData(["other", "list"], pages([{ id: 1, quantity: 9 }]));
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const { result, rerender } = renderHook(() => useOptimisticEntries<Row>(LIST), { wrapper });
  return { client, result, rerender };
}

const read = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryData<InfiniteData<EntryPage<Row>>>(key);

describe("useOptimisticEntries", () => {
  /** The reason the patch walks every cached copy: one card, two filters, one number. */
  it("rewrites the row in every cached copy of its list, and in no other list", () => {
    const { client, result } = seeded();

    act(() => result.current.patchEntry(1, (row) => ({ ...row, quantity: 3 })));

    expect(read(client, [...LIST, "all"])?.pages[0].items).toEqual([{ id: 1, quantity: 3 }]);
    expect(read(client, [...LIST, "foils"])?.pages[0].items).toEqual([{ id: 1, quantity: 3 }]);
    expect(read(client, ["other", "list"])?.pages[0].items).toEqual([{ id: 1, quantity: 9 }]);
  });

  /** A removal takes the row out and moves **every** page's copy of the total, not the first's. */
  it("takes a removed row out and counts it off every page's total", () => {
    const { client, result } = seeded();

    act(() => result.current.patchEntry(2, null));

    const all = read(client, [...LIST, "all"]);
    expect(all?.pages.map((page) => page.items)).toEqual([[{ id: 1, quantity: 2 }], []]);
    expect(all?.pages.map((page) => page.total)).toEqual([1, 1]);
  });

  /** A list that never held the row is handed back as itself, not as an equal copy. */
  it("leaves a cached copy that does not hold the row untouched", () => {
    const { client, result } = seeded();
    const foils = read(client, [...LIST, "foils"]);

    act(() => result.current.patchEntry(2, null));

    expect(read(client, [...LIST, "foils"])).toBe(foils);
  });

  /**
   * The undo: what the snapshot held is what the cache holds again after a refusal. Equal rather
   * than the same object — `setQueryData` shares structure with what it replaces.
   */
  it("puts every cached copy back from a snapshot", () => {
    const { client, result } = seeded();
    const before = read(client, [...LIST, "all"]);
    const saved = result.current.snapshot();

    act(() => result.current.patchEntry(1, (row) => ({ ...row, quantity: 0 })));
    expect(read(client, [...LIST, "all"])?.pages[0].items).toEqual([{ id: 1, quantity: 0 }]);
    act(() => result.current.restore(saved));

    expect(read(client, [...LIST, "all"])).toEqual(before);
    expect(read(client, [...LIST, "foils"])?.pages[0].items).toEqual([{ id: 1, quantity: 2 }]);
  });

  /** Held still across renders, which is what lets a caller's own callbacks hold still. */
  it("hands back the same three functions on every render", () => {
    const { result, rerender } = seeded();
    const first = result.current;

    rerender();

    expect(result.current.patchEntry).toBe(first.patchEntry);
    expect(result.current.snapshot).toBe(first.snapshot);
    expect(result.current.restore).toBe(first.restore);
  });
});
