import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckBracketRead, DeckCombo } from "@/lib/ipc";

const deckBracketReads = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckBracketReads },
}));

import { bracketLabel, effectiveBracket, useDeckBrackets } from "./useDeckBrackets";

/** A card as `deck_bracket_reads` sends one: five fields, and `categoryActive` always `true`
 *  because the query already applied that filter. */
function row(over: Partial<DeckBracketRead["cards"][number]> & { name: string }) {
  return {
    categoryActive: true,
    gameChanger: false,
    oracleText: null,
    faces: null,
    ...over,
  };
}

function combo(over: Partial<DeckCombo> = {}): DeckCombo {
  return {
    id: "v-1",
    bracketTag: "R",
    cards: ["Thassa's Oracle", "Demonic Consultation"],
    templateCount: 0,
    produces: "Win the game",
    popularity: 9000,
    ...over,
  };
}

/** Nothing flagged: `BASE_FLOOR`, which is 2. */
const PLAIN: DeckBracketRead = { deckId: 1, cards: [row({ name: "Grizzly Bears" })], combos: [] };

/** One Game Changer, which is the rung at 3. */
const ONE_GAME_CHANGER: DeckBracketRead = {
  deckId: 2,
  cards: [row({ name: "Rhystic Study", gameChanger: true })],
  combos: [],
};

/** Mass land denial, which is the rung at 4. */
const ARMAGEDDON: DeckBracketRead = {
  deckId: 10,
  cards: [row({ name: "Armageddon", oracleText: "Destroy all lands." })],
  combos: [],
};

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  // `staleTime` mirrors the app's own client (`lib/query.ts`), because one of the claims below is
  // about two mounts sharing a cache entry — and under the default `staleTime: 0` every mount
  // refetches, which would make that test pass or fail for a reason that is not the key's.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  deckBracketReads.mockResolvedValue([PLAIN, ONE_GAME_CHANGER, ARMAGEDDON]);
});

describe("useDeckBrackets", () => {
  it("estimates a floor for each deck it was told about", async () => {
    const { result } = renderHook(() => useDeckBrackets([1, 2, 10]), { wrapper });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.floorByDeck.get(1)).toBe(2);
    expect(result.current.floorByDeck.get(2)).toBe(3);
    expect(result.current.floorByDeck.get(10)).toBe(4);
  });

  it("takes the combos into the estimate", async () => {
    deckBracketReads.mockResolvedValue([{ deckId: 1, cards: [row({ name: "Bear" })], combos: [combo()] }]);
    const { result } = renderHook(() => useDeckBrackets([1]), { wrapper });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.floorByDeck.get(1)).toBe(4);
  });

  /**
   * **An empty gallery, or one with no Commander deck in it, costs no IPC call at all.** The
   * caller decides which decks even have a bracket — it is a question about the format — so a
   * wall of Modern decks asks for nothing, and a query that fired anyway would be a round trip
   * whose only possible answer is `[]`.
   */
  it("asks nothing when there is nothing to ask about", () => {
    const { result } = renderHook(() => useDeckBrackets([]), { wrapper });

    expect(deckBracketReads).not.toHaveBeenCalled();
    expect(result.current.floorByDeck.size).toBe(0);
    // A disabled query stays `pending` for ever, which is why `fetchStatus` is the honest tell.
    expect(result.current.query.fetchStatus).toBe("idle");
  });

  /**
   * Two renders that arrived at the same set of decks by different routes share one cache entry
   * and one round trip — the whole point of sorting the ids before they enter the key.
   */
  it("asks one question however the ids were ordered", async () => {
    const first = renderHook(() => useDeckBrackets([10, 2]), { wrapper });
    await waitFor(() => expect(first.result.current.query.isSuccess).toBe(true));

    const second = renderHook(() => useDeckBrackets([2, 10]), { wrapper });
    await waitFor(() => expect(second.result.current.query.isSuccess).toBe(true));

    expect(deckBracketReads).toHaveBeenCalledTimes(1);
    // The cache entry itself, which is the claim underneath the call count: an unsorted key would
    // make two entries here and the second mount would answer from a read of its own.
    expect(client.getQueryCache().getAll()).toHaveLength(1);
  });

  /**
   * Deduped, and sorted **numerically** — `[2, 10]` and not the `[10, 2]` a bare `.sort()`
   * answers. That is not a correctness claim about the cache (a string sort is canonical too, so
   * two orderings of one set still meet on one key); it is about the list that goes on the wire
   * and into a key somebody reads in the devtools meaning what it appears to mean.
   */
  it("dedupes before asking, and sorts the ids as numbers", async () => {
    const { result } = renderHook(() => useDeckBrackets([2, 2, 10]), { wrapper });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(deckBracketReads).toHaveBeenCalledWith([2, 10]);
  });

  /** The `["decks"]` prefix, asserted by firing the root — a key that did not sit under it would
   *  leave every tile's bracket saying what it said before the card was added. */
  it("refetches when any deck write invalidates the decks root", async () => {
    const { result } = renderHook(() => useDeckBrackets([1]), { wrapper });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(deckBracketReads).toHaveBeenCalledTimes(1);

    await client.invalidateQueries({ queryKey: ["decks"] });

    await waitFor(() => expect(deckBracketReads).toHaveBeenCalledTimes(2));
  });

  it("has nothing to say when the read fails", async () => {
    deckBracketReads.mockRejectedValue(new Error("BUSY"));
    const { result } = renderHook(() => useDeckBrackets([1]), { wrapper });

    await waitFor(() => expect(result.current.query.isError).toBe(true));

    expect(result.current.floorByDeck.size).toBe(0);
  });

  it("hands back the same map until the answer changes", async () => {
    const { result, rerender } = renderHook(() => useDeckBrackets([1]), { wrapper });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    const first = result.current.floorByDeck;
    rerender();

    expect(result.current.floorByDeck).toBe(first);
  });
});

describe("bracketLabel", () => {
  /**
   * **The editor's vocabulary, and it may not diverge.** `DeckBracket.tsx:223-224` draws
   * `Bracket ~3` for a reading and `Bracket 3` for an answer; the `~` is the whole of the visible
   * difference and it means the same thing on a tile as on the button.
   */
  it("prints the reader's own answer without a tilde", () => {
    expect(bracketLabel(3, undefined)).toBe("Bracket 3");
    expect(bracketLabel(1, 4)).toBe("Bracket 1");
    expect(bracketLabel(5, 2)).toBe("Bracket 5");
  });

  it("prints an estimate with one", () => {
    expect(bracketLabel(0, 3)).toBe("Bracket ~3");
    expect(bracketLabel(0, 2)).toBe("Bracket ~2");
  });

  /**
   * **Never a placeholder.** A deck on Auto whose estimate has not arrived, and one whose read
   * failed, both get a caption with no bracket in it — which is exactly what every tile says
   * today. A `Bracket ?` that flickered into a real number on every gallery load would be drawing
   * the reader's attention to a query rather than to a deck.
   */
  it("says nothing at all when there is neither", () => {
    expect(bracketLabel(0, undefined)).toBeNull();
  });

  /**
   * The editor's third form — `Bracket 2 · ~4` for a mismatch — is deliberately not copied. That
   * button opens the advisory naming the card responsible; a tile has nowhere to send the reader,
   * and a number they cannot interrogate is worse than the one they chose.
   */
  it("never draws the editor's mismatch form on a tile", () => {
    expect(bracketLabel(2, 4)).toBe("Bracket 2");
    expect(bracketLabel(2, 4)).not.toContain("~");
  });
});

describe("effectiveBracket", () => {
  it("prefers the reader's answer to the estimate", () => {
    expect(effectiveBracket(2, 4)).toBe(2);
    expect(effectiveBracket(5, undefined)).toBe(5);
  });

  it("falls back to the estimate on Auto", () => {
    expect(effectiveBracket(0, 3)).toBe(3);
  });

  /** `null` and never `0`: a deck nobody has read is not a bracket-nothing deck, and
   *  `deckSort.ts` is what keeps it out of the head of the list. */
  it("answers null when there is neither, rather than a number", () => {
    expect(effectiveBracket(0, undefined)).toBeNull();
  });
});
