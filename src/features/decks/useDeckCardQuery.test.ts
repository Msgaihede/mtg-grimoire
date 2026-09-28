import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const deckQueryCards = vi.hoisted(() => vi.fn());
const tagResolve = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckQueryCards, tagResolve },
}));

import { DEBOUNCE_MS } from "@/features/search/useCardSearch";
import { needleMatches, useDeckCardQuery } from "./useDeckCardQuery";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  deckQueryCards.mockReset().mockResolvedValue(["guide"]);
  tagResolve.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("needleMatches", () => {
  /** The box's rule since it shipped: a substring of the name or the type line, case-folded —
   *  so `oblin` still finds Goblin Guide, which an FTS prefix match would not. */
  it("matches a substring of the name or the type line", () => {
    const guide = { name: "Goblin Guide", typeLine: "Creature — Goblin Scout" };
    expect(needleMatches(guide, "oblin")).toBe(true);
    expect(needleMatches(guide, "scout")).toBe(true);
    expect(needleMatches(guide, "bolt")).toBe(false);
    expect(needleMatches({ name: "Ghost", typeLine: null }, "")).toBe(true);
  });
});

describe("useDeckCardQuery", () => {
  /** Plain words never leave the webview — the half of the box that must stay per keystroke. */
  it("answers free text with no round trip and no narrowing set", async () => {
    const { result } = renderHook(() => useDeckCardQuery(7, "  Goblin  Guide "), { wrapper });
    expect(result.current).toEqual({ needle: "goblin guide", matching: null });
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));
    expect(deckQueryCards).not.toHaveBeenCalled();
  });

  /**
   * A typed term is lifted out of the free text and asked of Rust as the wire carries it — the
   * span dropped, so two spellings of one question are one key.
   */
  it("sends the typed terms to deck_query_cards and narrows by the printings it answers", async () => {
    const { result } = renderHook(() => useDeckCardQuery(7, "goblin cmc>=1"), { wrapper });
    expect(result.current.needle).toBe("goblin");
    await waitFor(() => expect(result.current.matching).toEqual(new Set(["guide"])));
    expect(deckQueryCards).toHaveBeenCalledWith(7, {
      predicates: [{ field: "cmc", op: "gte", value: "1", negated: false }],
    });
  });

  /** A term waits out the debounce, and until its first answer the deck is not narrowed by it. */
  it("does not narrow by a term before the debounce and its answer", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDeckCardQuery(7, "t:goblin"), { wrapper });
    expect(result.current).toEqual({ needle: "", matching: null });
    expect(deckQueryCards).not.toHaveBeenCalled();
  });

  /** Taking every term out of the box stops narrowing at once, not a debounce later. */
  it("stops narrowing the moment the box holds no term", async () => {
    const { result, rerender } = renderHook(({ text }) => useDeckCardQuery(7, text), {
      wrapper,
      initialProps: { text: "t:goblin" },
    });
    await waitFor(() => expect(result.current.matching).not.toBeNull());
    rerender({ text: "bolt" });
    expect(result.current).toEqual({ needle: "bolt", matching: null });
  });

  /** A resolved tag rides as a slug; an unknown one empties the deck rather than being dropped. */
  it("resolves tag names, and fails closed on one nobody knows", async () => {
    tagResolve.mockResolvedValue([
      { slug: "removal", label: "Removal", namespace: "oracle" },
    ]);
    const { result } = renderHook(() => useDeckCardQuery(7, "otag:removal"), { wrapper });
    await waitFor(() => expect(result.current.matching).toEqual(new Set(["guide"])));
    expect(deckQueryCards).toHaveBeenCalledWith(7, {
      oracleTags: { include: ["removal"], exclude: [] },
    });

    tagResolve.mockResolvedValue([null]);
    deckQueryCards.mockClear();
    const unknown = renderHook(() => useDeckCardQuery(7, "otag:nonsense"), { wrapper });
    await waitFor(() => expect(unknown.result.current.matching).toEqual(new Set()));
    expect(deckQueryCards).not.toHaveBeenCalled();
  });

  /** The last answer stands while the next term is asked, so the deck does not blink whole. */
  it("keeps the previous answer while a changed term is asked", async () => {
    const { result, rerender } = renderHook(({ text }) => useDeckCardQuery(7, text), {
      wrapper,
      initialProps: { text: "t:goblin" },
    });
    await waitFor(() => expect(result.current.matching).toEqual(new Set(["guide"])));
    let answer: (ids: string[]) => void = () => {};
    deckQueryCards.mockReturnValue(new Promise<string[]>((res) => (answer = res)));
    rerender({ text: "t:creature" });
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));
    expect(result.current.matching).toEqual(new Set(["guide"]));
    act(() => answer(["guide", "serra"]));
    await waitFor(() => expect(result.current.matching).toEqual(new Set(["guide", "serra"])));
  });
});
