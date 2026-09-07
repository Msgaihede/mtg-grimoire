import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const searchOpen = vi.hoisted(() => vi.fn());
const setSearchOpen = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { searchOpen, setSearchOpen },
}));

import { SEARCH_OPEN_KEY, useSearchOpen } from "./useSearchOpen";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A reader who has shut the collection's column and left the deck's alone. Both halves matter:
  // `false` is the value every failure below also answers with, so a section that really was read
  // has to be told apart from one that fell back — and `deck: true` beside it is what proves a
  // write to one section does not take the other with it.
  searchOpen.mockReset().mockResolvedValue({ deck: true, collection: false });
  setSearchOpen.mockReset().mockResolvedValue(undefined);
});

/**
 * The three docked search columns' disclosure: one `app_meta` row holding a map of section name →
 * open, read once per app run and written optimistically.
 *
 * **The map is what this hook is for**, and it is where the cases below differ from the bare
 * boolean this replaced. A section can be stored, missing, or hold something that is not a boolean
 * at all — three ways into one answer — and a press has to reach exactly one of them.
 */
describe("useSearchOpen", () => {
  it("answers the stored value for its own section", async () => {
    const { result } = renderHook(() => useSearchOpen("collection"), { wrapper });

    await waitFor(() => expect(result.current.open).toBe(false));
    // The command really was asked, which is what tells a read apart from the default: `false` is
    // not this section's default, but a hook that never read the row would still be *drawing*
    // something and this is the assertion that says which.
    expect(searchOpen).toHaveBeenCalled();
  });

  /**
   * **A section the row says nothing about is this side's to answer**, which is the whole of the
   * split with `searchopen.rs`: the crate stores what it was given and never invents an entry, so
   * a reader who has pressed the collection's disclosure and never the wishlist's has a row with
   * one key in it.
   */
  it("answers the default for a section the map does not carry", async () => {
    const { result } = renderHook(() => useSearchOpen("wishlist"), { wrapper });

    await waitFor(() => expect(searchOpen).toHaveBeenCalled());
    expect(result.current.open).toBe(true);
  });

  /**
   * The `boolean` in `ipc.ts` is a promise about the far end rather than a fact about the row —
   * `app_meta` is text, and a hand-edit or a build that stored something else is exactly where the
   * promise stops being true. So the value is checked here and not merely typed.
   */
  it("answers the default for an entry that is not a boolean", async () => {
    searchOpen.mockResolvedValue({ deck: "yes" });

    const { result } = renderHook(() => useSearchOpen("deck"), { wrapper });

    await waitFor(() => expect(searchOpen).toHaveBeenCalled());
    expect(result.current.open).toBe(true);
  });

  /**
   * **The first frame, which is the frame the prefetch at `AppShell` exists to get right.** The
   * read is driven all the way into `error` rather than merely observed for a beat, so this cannot
   * pass on a read that had simply not answered yet — and a preference that cannot be read is not
   * worth a page that will not draw.
   */
  it("answers the default while the read is in flight", async () => {
    searchOpen.mockRejectedValue("The database is busy with a sync — try again in a moment.");

    const { result } = renderHook(() => useSearchOpen("collection"), { wrapper });

    await waitFor(() => expect(client.getQueryState(SEARCH_OPEN_KEY)?.status).toBe("error"));
    expect(result.current.open).toBe(true);
  });

  /**
   * **The section travels with the value**, and that is the one thing a map costs over a bare
   * boolean. A hook that dropped the argument would still open and shut the column the reader
   * pressed — the optimistic half is local — and would quietly write every press into one section
   * of the row.
   */
  it("writes the section it was given", async () => {
    const { result } = renderHook(() => useSearchOpen("collection"), { wrapper });
    await waitFor(() => expect(result.current.open).toBe(false));

    act(() => result.current.setOpen(true));

    // `mutate` schedules rather than calling through, so the command lands a tick later — the
    // press itself is already on screen by then, which is {@link setOpen}'s optimistic half.
    await waitFor(() => expect(setSearchOpen).toHaveBeenCalledWith("collection", true));
  });

  /**
   * The column moves on the press, not a round trip later.
   *
   * A disclosure is a direct manipulation, and a control that answers late reads as a control that
   * did not take. The write here never settles, which is what makes the claim a real one: a panel
   * that waited on it would still be shut at the end of this test.
   */
  it("shows the new state before the write answers", async () => {
    setSearchOpen.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useSearchOpen("collection"), { wrapper });
    await waitFor(() => expect(result.current.open).toBe(false));

    act(() => result.current.setOpen(true));

    await waitFor(() => expect(result.current.open).toBe(true));
  });

  /**
   * **A refused write keeps the reader's choice**, and says nothing.
   *
   * `set_search_open` answers BUSY while a sync holds the write connection — whole minutes of a
   * first run. Snapping the column shut under the reader's hand in that window, with nothing on
   * screen saying why, is worse than losing one launch's memory of the press.
   *
   * The mutation is driven into `error` before the assertion, so this is a settled rejection
   * rather than one still in flight — and a rejection that escaped the mutation would be an
   * unhandled rejection in this run rather than a silent pass.
   */
  it("keeps the new state when the write is refused", async () => {
    setSearchOpen.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    const { result } = renderHook(() => useSearchOpen("collection"), { wrapper });
    await waitFor(() => expect(result.current.open).toBe(false));

    act(() => result.current.setOpen(true));

    await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe("error"));
    expect(result.current.open).toBe(true);
  });

  /**
   * **One row, three columns — so a press has to be a spread and not a replacement.** This is the
   * failure the map shape buys and the bare boolean could not have: a `setQueryData` that wrote
   * `{ [section]: open }` would pass every case above and take the other two columns' answers out
   * of the cache with it, which the reader would not see until the next page they opened.
   */
  it("does not disturb another section", async () => {
    // Both shut, and the deck's `false` is the load-bearing half: it is the opposite of that
    // section's default, so a press that dropped the entry would put the column back *open* here
    // rather than leaving a value that happens to match.
    searchOpen.mockResolvedValue({ deck: false, collection: false });
    const { result } = renderHook(() => useSearchOpen("collection"), { wrapper });
    const deck = renderHook(() => useSearchOpen("deck"), { wrapper });
    await waitFor(() => expect(result.current.open).toBe(false));
    await waitFor(() => expect(deck.result.current.open).toBe(false));

    act(() => result.current.setOpen(true));

    expect(deck.result.current.open).toBe(false);
    expect(client.getQueryData(SEARCH_OPEN_KEY)).toEqual({ deck: false, collection: true });
  });
});
