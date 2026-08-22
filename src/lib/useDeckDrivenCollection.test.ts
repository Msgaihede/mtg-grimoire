import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const deckDrivenCollection = vi.hoisted(() => vi.fn());
const setDeckDrivenCollection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckDrivenCollection, setDeckDrivenCollection },
}));

import { DECK_DRIVEN_KEY, useDeckDrivenCollection } from "./useDeckDrivenCollection";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  deckDrivenCollection.mockReset().mockResolvedValue(false);
  setDeckDrivenCollection.mockReset().mockResolvedValue(undefined);
});

/**
 * Whether the collection is the sum of the reader's live decks: one `app_meta` row, read once
 * per app run and written optimistically — but, unlike the nav rail's twin, rolled back and
 * reported when the write is refused.
 *
 * The setting is a bare boolean, so there is no unknown-vocabulary case to cover; the far end
 * folds a missing row, a junk row and an unreadable one into `false` before this side sees
 * anything. What is left is the two ends it can fail at, and here they answer differently from
 * each other: a failed **read** is the hand-kept collection and silent, a failed **write** is
 * the switch moving back and a sentence.
 */
describe("useDeckDrivenCollection", () => {
  it("reads the stored setting", async () => {
    deckDrivenCollection.mockResolvedValue(true);

    const { result } = renderHook(() => useDeckDrivenCollection(), { wrapper });

    await waitFor(() => expect(result.current.deckDriven).toBe(true));
  });

  /**
   * The stored `false` is read, not merely indistinguishable from the fallback.
   *
   * Every failure below also answers `false`, so a hook that never read the row would pass the
   * hand-kept case for the wrong reason. Asserting the command was called is what tells them
   * apart.
   */
  it("reads a stored hand-kept collection rather than falling back to one", async () => {
    const { result } = renderHook(() => useDeckDrivenCollection(), { wrapper });

    await waitFor(() => expect(deckDrivenCollection).toHaveBeenCalled());
    expect(result.current.deckDriven).toBe(false);
    expect(result.current.error).toBeNull();
  });

  /**
   * **A read that fails is the hand-kept collection, and says nothing.**
   *
   * That is the right floor rather than an arbitrary one: the degraded state shows the reader
   * their own rows. `error` is reserved for a refused *write*, because that is the one the
   * reader just asked for and is owed an answer about — a page that quietly listed their own
   * cards is not a failure they need to read a sentence about.
   *
   * The query is driven all the way into `error` rather than observed for a beat, so this
   * cannot pass on a read that had not answered yet.
   */
  it("falls back to the hand-kept collection when the setting cannot be read at all", async () => {
    deckDrivenCollection.mockRejectedValue(
      "The database is busy with a sync — try again in a moment.",
    );

    const { result } = renderHook(() => useDeckDrivenCollection(), { wrapper });

    await waitFor(() => expect(client.getQueryState(DECK_DRIVEN_KEY)?.status).toBe("error"));
    expect(result.current.deckDriven).toBe(false);
    expect(result.current.error).toBeNull();
  });

  /**
   * The switch moves on the press, not a round trip later.
   *
   * **The write never settles until after the assertion**, which is what makes the claim a real
   * one rather than a race the test happened to win: a hook that waited on the command would
   * still read `false` here, whatever order the frames arrived in.
   *
   * `waitFor` rather than a bare synchronous read, matching `useNavCollapsed.test.ts`. Query's
   * `notifyManager` batches an observer notification onto a microtask, so a `setQueryData` is
   * not visible to the same tick that made it — a sub-millisecond gap, long before a paint, and
   * the same one the nav rail has shipped with. Asserting synchronously would be asserting the
   * scheduler, not the hook.
   */
  it("shows the switch moving before the command answers", async () => {
    let settle: () => void = () => {};
    setDeckDrivenCollection.mockReturnValue(
      new Promise<void>((r) => {
        settle = r;
      }),
    );
    const { result } = renderHook(() => useDeckDrivenCollection(), { wrapper });
    await waitFor(() => expect(result.current.deckDriven).toBe(false));

    act(() => result.current.setDeckDriven(true));

    await waitFor(() => expect(result.current.deckDriven).toBe(true));
    // Still in flight: the switch above moved on nothing the command has said.
    expect(client.getMutationCache().getAll()[0]?.state.status).toBe("pending");
    // The bare boolean, not the `{ enabled, previous }` the mutation carries internally.
    expect(setDeckDrivenCollection).toHaveBeenCalledWith(true);

    act(() => settle());
  });

  /**
   * **Unlike the nav rail's, this refusal IS surfaced and the optimistic half IS rolled back.**
   *
   * `useNavCollapsed` keeps a refused fold on the argument that it costs the reader one
   * launch's starting state. Every clause of that points the other way here: this switch
   * decides what the Collection page is a *list of*, so a switch left reading "on" over a
   * hand-kept collection is the page and the setting disagreeing until the next restart.
   */
  it("rolls back and says so when the write is refused", async () => {
    setDeckDrivenCollection.mockRejectedValue(new Error("BUSY"));
    const { result } = renderHook(() => useDeckDrivenCollection(), { wrapper });
    await waitFor(() => expect(result.current.deckDriven).toBe(false));

    act(() => result.current.setDeckDriven(true));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.deckDriven).toBe(false);
  });

  /**
   * A refusal is a Rust `Result<_, String>`, so the rejection value is a bare string rather
   * than an `Error` — `ipcError` is what makes both readable, and the panel draws whatever it
   * returns verbatim.
   */
  it("reports a refusal in the words the command used", async () => {
    setDeckDrivenCollection.mockRejectedValue(
      "The database is busy with a sync — try again in a moment.",
    );
    const { result } = renderHook(() => useDeckDrivenCollection(), { wrapper });
    await waitFor(() => expect(deckDrivenCollection).toHaveBeenCalled());

    act(() => result.current.setDeckDriven(true));

    await waitFor(() =>
      expect(result.current.error).toBe(
        "The database is busy with a sync — try again in a moment.",
      ),
    );
  });

  /**
   * The error clears on the write that works, rather than standing over a switch that has since
   * moved — a stale sentence beside a correct control is worse than no sentence.
   */
  it("clears the refusal once a later write is accepted", async () => {
    setDeckDrivenCollection.mockRejectedValueOnce("BUSY");
    const { result } = renderHook(() => useDeckDrivenCollection(), { wrapper });
    await waitFor(() => expect(deckDrivenCollection).toHaveBeenCalled());

    act(() => result.current.setDeckDriven(true));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    act(() => result.current.setDeckDriven(true));

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.deckDriven).toBe(true);
  });

  /**
   * The four surfaces the flag moves are invalidated on success — the collection itself, the
   * card wall's owned counts, the decks, and the wishlist. Nothing is invalidated on a refusal:
   * the far end stored nothing, so there is nothing to re-read.
   */
  it("refreshes the four surfaces the flag moves, and only when the write took", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useDeckDrivenCollection(), { wrapper });
    await waitFor(() => expect(deckDrivenCollection).toHaveBeenCalled());
    invalidate.mockClear();

    act(() => result.current.setDeckDriven(true));

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(4));
    expect(invalidate.mock.calls.map((c) => c[0]?.queryKey)).toEqual([
      ["collection"],
      ["cards", "search"],
      ["decks"],
      ["wishlist"],
    ]);
  });
});
