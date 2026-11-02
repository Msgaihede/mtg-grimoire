import { describe, expect, it, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DeckRow } from "@/lib/ipc";

const draftDeckList = vi.hoisted(() => vi.fn());
const draftDeckKeep = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ ipc: { draftDeckList, draftDeckKeep } }));

import { DRAFT_DECKS_KEY, useDraftDecks, useKeepDraftDeck } from "./useDraftDecks";

const row = (id: number, name: string) => ({ id, name, cardCount: 45, draft: true }) as DeckRow;

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  draftDeckList.mockReset().mockResolvedValue([]);
  draftDeckKeep.mockReset().mockResolvedValue(undefined);
});

/**
 * Since user schema v69 a draft deck is its own row's `draft` flag: the list is
 * `draft_deck_list`'s whole rows, with no id or uid to match against the gallery's (issue #1467's
 * reused-id trap has nowhere left to happen).
 */
describe("useDraftDecks", () => {
  it("answers draft_deck_list's rows as they are", async () => {
    draftDeckList.mockResolvedValue([row(4, "Quick Draft"), row(7, "Cube Draft")]);
    const client = new QueryClient();
    const { result } = renderHook(() => useDraftDecks(), { wrapper: wrapper(client) });
    expect(result.current).toEqual([]);
    await waitFor(() => expect(result.current.map((d) => d.id)).toEqual([4, 7]));
    expect(result.current[0]).toMatchObject({ name: "Quick Draft", cardCount: 45, draft: true });
  });

  it("is under the decks root, so every deck write's invalidation asks it again", () => {
    expect(DRAFT_DECKS_KEY[0]).toBe("decks");
  });

  it("asks again once a deck is kept", async () => {
    draftDeckList.mockResolvedValue([row(4, "Quick Draft")]);
    const client = new QueryClient();
    const { result } = renderHook(() => ({ list: useDraftDecks(), keep: useKeepDraftDeck() }), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.list).toHaveLength(1));
    draftDeckList.mockResolvedValue([]);
    await act(() => result.current.keep.mutateAsync(4));
    expect(draftDeckKeep).toHaveBeenCalledWith(4);
    await waitFor(() => expect(result.current.list).toEqual([]));
  });
});
