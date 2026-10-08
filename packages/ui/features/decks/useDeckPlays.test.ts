import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const deckPlayedKeys = vi.hoisted(() => vi.fn());
const deckIdsPlaying = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckPlayedKeys, deckIdsPlaying },
}));

import { playKey, useDeckPlays, useDecksPlaying } from "./useDeckPlays";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    // **`staleTime: Infinity` rather than the app's 30 s**, so that "two orderings are one
    // question" is a claim about the *key* rather than about how long an answer stays fresh: at
    // the default `0` a second observer mounting on cached data refetches in the background, and
    // the call count would then be measuring TanStack's staleness policy instead of the sort.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  deckPlayedKeys.mockReset().mockResolvedValue(["o-sol-ring", "o-lightning-bolt"]);
  deckIdsPlaying.mockReset().mockResolvedValue([7, 9]);
});

/**
 * The key both ends of the rule are matched on, and the one function that spells the Rust
 * `coalesce(cards.oracle_id, deck_cards.card_id)` on this side.
 */
describe("playKey", () => {
  /** The oracle card, because a deck plays *Sol Ring* rather than one printing of it: a copy
   *  from any set has to answer a deck holding any other. */
  it("keys a healthy row by its oracle id, never by the printing", () => {
    expect(playKey({ oracleId: "o-sol-ring", cardId: "p-c19-sol-ring" })).toBe("o-sol-ring");
  });

  /**
   * The fallback arm, and the reason the coalesce exists at all: `cards.oracle_id` is nullable
   * and a `deck_cards` row outlives its printing leaving the corpus, so an orphan has no oracle
   * identity to be matched by. Printing-to-printing is the strictest honest answer for it.
   */
  it("falls back to the printing for a row the card database has never heard of", () => {
    expect(playKey({ oracleId: null, cardId: "p-orphan" })).toBe("p-orphan");
  });
});

describe("useDeckPlays", () => {
  /**
   * The card menu draws on six views and most of them have no deck open, so the census has to
   * be mounted everywhere and asked almost nowhere.
   *
   * **`fetchStatus` is asserted as well as the call count**, and that is the half that catches a
   * dropped `enabled`: `opened(null)` throws inside the `queryFn`, so `deckPlayedKeys` is *still*
   * never called on a query that fired — it would merely land in `status: "error"` instead. An
   * idle fetch and a pending status together are the shape of a query that never ran.
   */
  it("asks for nothing until a deck is open, and reads empty rather than pending", () => {
    const { result } = renderHook(() => useDeckPlays(null), { wrapper });

    expect(deckPlayedKeys).not.toHaveBeenCalled();
    expect(result.current.query.fetchStatus).toBe("idle");
    expect(result.current.query.status).toBe("pending");
    expect(result.current.plays.size).toBe(0);
    // **The distinction the whole `pending` flag exists for.** TanStack leaves a disabled query
    // `status: "pending"` for ever, so a caller failing closed on `query.isPending` would grey
    // its rows permanently on every surface with no deck open. There is no census coming.
    expect(result.current.query.isPending).toBe(true);
    expect(result.current.pending).toBe(false);
  });

  /** One deck, under `["decks", "plays", deckId]` — the `["decks"]` root every deck write
   *  already invalidates, which is why no mutation has to learn this key exists. */
  it("reads one deck's played keys under the decks root", async () => {
    const { result } = renderHook(() => useDeckPlays(4), { wrapper });

    await waitFor(() => expect(result.current.plays.size).toBe(2));
    expect(deckPlayedKeys).toHaveBeenCalledWith(4);
    expect(client.getQueryData(["decks", "plays", 4])).toEqual([
      "o-sol-ring",
      "o-lightning-bolt",
    ]);
    expect(result.current.plays.has("o-sol-ring")).toBe(true);
    expect(result.current.plays.has("o-something-else")).toBe(false);
  });

  /**
   * **A caller must be able to tell "still reading" from "plays nothing"**, because that is what
   * decides whether a menu row greys — `CollectionPage`'s `stepperByTile` fails closed for
   * exactly the length of this window.
   *
   * The answer is held open deliberately: an already-resolved mock never produces the state the
   * rule is about.
   */
  it("says it is pending while the census is in flight, and stops when it lands", async () => {
    let land: (keys: string[]) => void = () => {};
    deckPlayedKeys.mockReturnValue(
      new Promise<string[]>((resolve) => {
        land = resolve;
      }),
    );

    const { result } = renderHook(() => useDeckPlays(4), { wrapper });

    await waitFor(() => expect(result.current.pending).toBe(true));
    // Empty *and* pending — the state a permissive reading would offer every deck group in.
    expect(result.current.plays.size).toBe(0);

    land([]);

    // Empty and **not** pending: this deck really plays nothing, which is a different answer
    // from the one six lines above and reads identically off `plays` alone.
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.plays.size).toBe(0);
  });

  /**
   * **The set identity holds still across a re-render**, because both consumers build a menu or
   * a wall of dozens of rows off it and may put it in a dependency array. TanStack hands back
   * the same array until the answer changes, so the `useMemo` over it is what makes this true —
   * a `new Set(...)` built inline would be a new identity every render.
   */
  it("hands back the same set across a re-render, loaded and disabled alike", async () => {
    const { result, rerender } = renderHook(() => useDeckPlays(4), { wrapper });
    await waitFor(() => expect(result.current.plays.size).toBe(2));

    const loaded = result.current.plays;
    rerender();
    expect(result.current.plays).toBe(loaded);

    // And the empty answer is one shared identity rather than a fresh `Set` per render, which is
    // the state most surfaces spend their whole life in.
    const off = renderHook(() => useDeckPlays(null), { wrapper });
    const first = off.result.current.plays;
    off.rerender();
    expect(off.result.current.plays).toBe(first);
  });
});

describe("useDecksPlaying", () => {
  /**
   * **Nothing asked, nothing answered — and emphatically not every deck.** The conjunction over
   * no cards is vacuously true, so a backend answering "all of them" would be mathematically
   * right and exactly wrong for a menu; disabling the query reaches the same answer with no
   * round trip. A dropped `enabled` sends `[]` on the wire, which this call count catches.
   */
  it("asks nothing for an empty selection", () => {
    const { result } = renderHook(() => useDecksPlaying([]), { wrapper });

    expect(deckIdsPlaying).not.toHaveBeenCalled();
    expect(result.current.deckIds.size).toBe(0);
    expect(result.current.pending).toBe(false);
  });

  it("reads the decks that play every asked-for card", async () => {
    const { result } = renderHook(() => useDecksPlaying(["o-sol-ring"]), { wrapper });

    await waitFor(() => expect(result.current.deckIds.size).toBe(2));
    expect(deckIdsPlaying).toHaveBeenCalledWith(["o-sol-ring"]);
    expect(result.current.deckIds.has(7)).toBe(true);
    expect(result.current.deckIds.has(8)).toBe(false);
  });

  /**
   * **One set of cards is one question however the caller ordered it**, and the sort has to
   * happen on *both* sides of the hook or it buys nothing: sorted only into the query key, two
   * orderings share a cache entry but send two different arrays on a cold cache; sorted only
   * onto the wire, they send one array and make two cache entries.
   *
   * So both halves are asserted — the wire array is sorted for the caller that handed it over
   * backwards, and the whole cache holds exactly one `playing` entry for the two of them. A
   * reader picks cards bottom-up as readily as top-down, and a menu that re-asked for that is
   * two round trips and two chances to disagree with itself.
   */
  it("sorts and dedupes, so two orderings of one set are one cache entry", async () => {
    const backwards = renderHook(() => useDecksPlaying(["o-b", "o-a"]), { wrapper });
    await waitFor(() => expect(backwards.result.current.deckIds.size).toBe(2));

    expect(deckIdsPlaying).toHaveBeenCalledWith(["o-a", "o-b"]);

    const forwards = renderHook(() => useDecksPlaying(["o-a", "o-b"]), { wrapper });
    await waitFor(() => expect(forwards.result.current.deckIds.size).toBe(2));

    // A repeat is the same set too — a deck holding one card in two piles hands the same key
    // over twice, and asking about it again is a third cache entry for one question.
    const repeated = renderHook(() => useDecksPlaying(["o-b", "o-a", "o-a"]), { wrapper });
    await waitFor(() => expect(repeated.result.current.deckIds.size).toBe(2));

    const playing = client
      .getQueryCache()
      .getAll()
      .filter((q) => q.queryKey[0] === "decks" && q.queryKey[1] === "playing");
    expect(playing).toHaveLength(1);
    expect(deckIdsPlaying).toHaveBeenCalledTimes(1);
    expect(deckIdsPlaying).toHaveBeenLastCalledWith(["o-a", "o-b"]);
  });

  /** The set identity holds across a re-render for `useDeckPlays`' reason: a menu of dozens of
   *  deck rows tests membership against it. */
  it("hands back the same set across a re-render", async () => {
    const { result, rerender } = renderHook(() => useDecksPlaying(["o-sol-ring"]), { wrapper });
    await waitFor(() => expect(result.current.deckIds.size).toBe(2));

    const loaded = result.current.deckIds;
    rerender();
    expect(result.current.deckIds).toBe(loaded);
  });

  /** In flight is not "no deck plays these" here either — the same fail-closed window, one type
   *  over. */
  it("says it is pending while the read is in flight", async () => {
    let land: (ids: number[]) => void = () => {};
    deckIdsPlaying.mockReturnValue(
      new Promise<number[]>((resolve) => {
        land = resolve;
      }),
    );

    const { result } = renderHook(() => useDecksPlaying(["o-sol-ring"]), { wrapper });

    await waitFor(() => expect(result.current.pending).toBe(true));
    expect(result.current.deckIds.size).toBe(0);

    land([]);

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.deckIds.size).toBe(0);
  });
});
