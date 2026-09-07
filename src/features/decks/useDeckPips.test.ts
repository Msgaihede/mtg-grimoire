import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckPipCosts } from "@/lib/ipc";

const deckPipCosts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckPipCosts },
}));

import { useDeckPips } from "./useDeckPips";

const ROWS: DeckPipCosts[] = [
  {
    deckId: 4,
    costs: [
      { cost: "{1}{R}", copies: 4 },
      { cost: "{W/U}", copies: 1 },
    ],
  },
  { deckId: 7, costs: [{ cost: "{G}{G}", copies: 2 }] },
];

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  deckPipCosts.mockResolvedValue(ROWS);
});

describe("useDeckPips", () => {
  it("folds the read into a count per deck", async () => {
    const { result } = renderHook(() => useDeckPips(), { wrapper });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.byDeck.get(4)).toEqual({ W: 1, U: 1, B: 0, R: 4, G: 0, C: 0 });
    expect(result.current.byDeck.get(7)).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 4, C: 0 });
  });

  it("is an empty map until the read answers", () => {
    const { result } = renderHook(() => useDeckPips(), { wrapper });

    expect(result.current.byDeck.size).toBe(0);
  });

  /**
   * **The key is `["decks", "pips"]`, under the root every deck write already invalidates**, and
   * that prefix is the whole of what keeps a colour bar honest after a card is added. Asserted by
   * firing the root rather than by reading the literal, because what matters is the *matching* —
   * `invalidateQueries` works by prefix, and a key spelled `["deckPips"]` would type-check, pass
   * a literal assertion nobody wrote, and quietly stop refetching.
   */
  it("refetches when any deck write invalidates the decks root", async () => {
    const { result } = renderHook(() => useDeckPips(), { wrapper });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(deckPipCosts).toHaveBeenCalledTimes(1);

    await client.invalidateQueries({ queryKey: ["decks"] });

    await waitFor(() => expect(deckPipCosts).toHaveBeenCalledTimes(2));
  });

  it("caches under the pips key, so a second mount asks nothing", async () => {
    const first = renderHook(() => useDeckPips(), { wrapper });
    await waitFor(() => expect(first.result.current.query.isSuccess).toBe(true));

    expect(client.getQueryData(["decks", "pips"])).toEqual(ROWS);
  });

  /**
   * The wall reads this map during layout and the colour sort reads it once per comparison, so it
   * has to hold still — a new `Map` per render would make every `useMemo` keyed on it recompute
   * and every tile re-measure for nothing.
   */
  it("hands back the same map until the answer changes", async () => {
    const { result, rerender } = renderHook(() => useDeckPips(), { wrapper });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    const first = result.current.byDeck;
    rerender();

    expect(result.current.byDeck).toBe(first);
  });

  it("says nothing about a deck when the read fails", async () => {
    deckPipCosts.mockRejectedValue(new Error("BUSY"));
    const { result } = renderHook(() => useDeckPips(), { wrapper });

    await waitFor(() => expect(result.current.query.isError).toBe(true));

    expect(result.current.byDeck.size).toBe(0);
  });
});
