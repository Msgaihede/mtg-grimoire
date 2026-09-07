import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const deckSort = vi.hoisted(() => vi.fn());
const setDeckSort = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckSort, setDeckSort },
}));

import { DEFAULT_DECK_SORT } from "./deckSort";
import { useDeckSort } from "./useDeckSort";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  deckSort.mockResolvedValue("name:asc");
  setDeckSort.mockResolvedValue(undefined);
});

describe("useDeckSort", () => {
  it("opens on the stored order", async () => {
    const { result } = renderHook(() => useDeckSort(), { wrapper });

    await waitFor(() => expect(result.current.sort).toEqual({ key: "name", desc: false }));
  });

  /** A read in flight and a read that failed are the same thing to the gallery: today's order,
   *  which is a complete, drawable page. */
  it("draws the default until the read answers", () => {
    const { result } = renderHook(() => useDeckSort(), { wrapper });

    expect(result.current.sort).toEqual(DEFAULT_DECK_SORT);
  });

  it("draws the default when the read fails", async () => {
    deckSort.mockRejectedValue(new Error("BUSY"));
    const { result } = renderHook(() => useDeckSort(), { wrapper });

    await waitFor(() => expect(client.getQueryState(["decks", "sort"])?.status).toBe("error"));

    expect(result.current.sort).toEqual(DEFAULT_DECK_SORT);
  });

  /** A word this build no longer offers has to become an order the reader can leave — the parse
   *  degrades and the gallery still draws. */
  it("falls back to the default for a stored word it cannot draw", async () => {
    deckSort.mockResolvedValue("colours:sideways");
    const { result } = renderHook(() => useDeckSort(), { wrapper });

    await waitFor(() => expect(deckSort).toHaveBeenCalled());

    expect(result.current.sort).toEqual(DEFAULT_DECK_SORT);
  });

  /**
   * **The press is the truth immediately.** A sort control that waited on `set_deck_sort` and a
   * re-read would leave the wall in the old order for a round trip, which reads as a control that
   * did not take.
   */
  it("answers the pressed order before the write settles", async () => {
    let settle = () => {};
    setDeckSort.mockReturnValue(new Promise<void>((resolve) => (settle = () => resolve())));
    const { result } = renderHook(() => useDeckSort(), { wrapper });
    await waitFor(() => expect(result.current.sort).toEqual({ key: "name", desc: false }));

    act(() => result.current.setSort({ key: "cards", desc: true }));

    expect(result.current.sort).toEqual({ key: "cards", desc: true });
    await act(async () => settle());
    expect(result.current.sort).toEqual({ key: "cards", desc: true });
  });

  it("writes the order as the one string app_meta holds", async () => {
    const { result } = renderHook(() => useDeckSort(), { wrapper });
    await waitFor(() => expect(deckSort).toHaveBeenCalled());

    act(() => result.current.setSort({ key: "bracket", desc: false }));

    expect(setDeckSort).toHaveBeenCalledWith("bracket:asc");
  });

  /**
   * **A refused write costs the reader nothing this session.** `set_deck_sort` answers `BUSY`
   * while a sync holds the write connection, and outside a Tauri window there is no command to
   * call at all — `useListViewPersistence`'s contract, and losing a stored order is not worth
   * taking the app down for. The rejection is swallowed at the call, so nothing reaches a
   * boundary and the pressed order stands.
   */
  it("keeps the pressed order when the write is refused", async () => {
    setDeckSort.mockRejectedValue(new Error("BUSY"));
    const { result } = renderHook(() => useDeckSort(), { wrapper });
    await waitFor(() => expect(deckSort).toHaveBeenCalled());

    await act(async () => {
      result.current.setSort({ key: "colors", desc: false });
    });

    expect(result.current.sort).toEqual({ key: "colors", desc: false });
  });

  /**
   * **The rejection is handled at the call, and this is the only way to see that from a test.**
   * The behaviour above — the pressed order stands — is true whether or not a handler is
   * attached, so it cannot tell a swallowed rejection from a loose one; and jsdom never fires
   * `unhandledrejection`, so the direct route is vacuous too. What is left is to watch the write
   * *being* handled: the mock answers a thenable whose `catch` is a spy, and a `void ipc.setDeckSort(…)`
   * with the handler dropped simply never calls it.
   */
  it("attaches a handler to the write rather than leaving the rejection loose", async () => {
    const attach = vi.fn(() => Promise.resolve());
    setDeckSort.mockReturnValue({ catch: attach });
    const { result } = renderHook(() => useDeckSort(), { wrapper });
    await waitFor(() => expect(deckSort).toHaveBeenCalled());

    act(() => result.current.setSort({ key: "cards", desc: true }));

    expect(attach).toHaveBeenCalledTimes(1);
  });

  /**
   * The race the override also settles: a launch read is slow enough that a reader can press
   * before it lands, and a stored order arriving afterwards must not undo their press.
   */
  it("does not let a late read undo a press", async () => {
    let answer: (stored: string) => void = () => {};
    deckSort.mockReturnValue(new Promise<string>((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useDeckSort(), { wrapper });

    act(() => result.current.setSort({ key: "format", desc: false }));
    expect(result.current.sort).toEqual({ key: "format", desc: false });

    await act(async () => {
      answer("name:asc");
    });

    expect(result.current.sort).toEqual({ key: "format", desc: false });
  });

  /** Nothing else on earth writes this row, so there is nothing for the cache to go stale
   *  against — a second mount reads the answer already in hand rather than the database again. */
  it("reads the row once per session", async () => {
    const first = renderHook(() => useDeckSort(), { wrapper });
    await waitFor(() => expect(first.result.current.sort).toEqual({ key: "name", desc: false }));

    const second = renderHook(() => useDeckSort(), { wrapper });
    await waitFor(() => expect(second.result.current.sort).toEqual({ key: "name", desc: false }));

    expect(deckSort).toHaveBeenCalledTimes(1);
  });
});
