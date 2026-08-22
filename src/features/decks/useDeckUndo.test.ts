import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckAuditEntry, DeckUndoState } from "@/lib/ipc";

const deckUndoState = vi.hoisted(() => vi.fn());
const deckUndoApply = vi.hoisted(() => vi.fn());
const deckRedoApply = vi.hoisted(() => vi.fn());
const deckDrivenCollection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckUndoState, deckUndoApply, deckRedoApply, deckDrivenCollection },
}));

import { DECK_DRIVEN_KEY } from "@/lib/useDeckDrivenCollection";
import { useDeckUndo } from "./useDeckUndo";

function entry(over: Partial<DeckAuditEntry> = {}): DeckAuditEntry {
  return {
    id: 7,
    deckId: 4,
    at: Math.floor(Date.now() / 1000),
    variant: "live",
    kind: "remove",
    cardId: "p1",
    cardName: "Lightning Bolt",
    payload: '{"category":"Ramp","quantity":2,"reason":null}',
    delta: -2,
    ...over,
  };
}

/** What the backend answers when there is one change to undo and nothing to redo. */
function state(over: Partial<DeckUndoState> = {}): DeckUndoState {
  return { undo: entry(), redo: null, ...over };
}

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  deckUndoState.mockReset().mockResolvedValue(state());
  deckUndoApply.mockReset().mockResolvedValue(undefined);
  deckRedoApply.mockReset().mockResolvedValue(undefined);
  deckDrivenCollection.mockReset().mockResolvedValue(false);
});

/** `useDeck.test.ts`'s helper and its reasoning — a `staleTime: 30_000` cache is *fresh*, so
 *  `isInvalidated` is the whole of what tells the Collection page anything happened. */
const OWNED_CACHES: readonly (readonly string[])[] = [
  ["collection", "list", "{}"],
  ["cards", "search", "{}"],
  ["decks", "list"],
  ["wishlist", "list", "{}"],
];

function seedOwned(c: QueryClient): void {
  for (const key of OWNED_CACHES) c.setQueryData(key, { items: [], total: 0 });
}

const staleRoots = (c: QueryClient): string[] =>
  OWNED_CACHES.filter((key) => c.getQueryState(key)?.isInvalidated === true)
    .map((key) => key[0])
    .sort();

/**
 * An undo is a deck write, so it makes the same roots wrong as the write it reverses.
 *
 * Reversing an add of two copies takes two copies back out of a derived collection, and the
 * page has no other way to find out: `src/lib/query.ts` sets `staleTime: 30_000`, so its cached
 * answer is fresh and navigating to it refetches nothing.
 */
describe("useDeckUndo while the collection is deck driven", () => {
  it("marks the whole of what the reader owns stale when a change is undone", async () => {
    client.setQueryData(DECK_DRIVEN_KEY, true);
    seedOwned(client);
    const { result } = renderHook(() => useDeckUndo(4), { wrapper });
    await waitFor(() => expect(result.current.undo).not.toBeNull());
    expect(staleRoots(client)).toEqual([]);

    await act(async () => {
      result.current.runUndo();
    });

    await waitFor(() =>
      expect(staleRoots(client)).toEqual(["cards", "collection", "decks", "wishlist"]),
    );
  });

  /** Additively — `["decks"]` is the floor in both modes. */
  it("marks only the decks stale while the collection is hand kept", async () => {
    seedOwned(client);
    const { result } = renderHook(() => useDeckUndo(4), { wrapper });
    await waitFor(() => expect(result.current.undo).not.toBeNull());

    await act(async () => {
      result.current.runUndo();
    });

    await waitFor(() => expect(staleRoots(client)).toEqual(["decks"]));
  });
});

describe("useDeckUndo", () => {
  /** The editor mounts this before a deck is chosen — a query that fired anyway would ask the
   *  backend for the undo state of deck `null`. */
  it("asks for nothing until a deck is open", () => {
    renderHook(() => useDeckUndo(null), { wrapper });

    expect(deckUndoState).not.toHaveBeenCalled();
  });

  /**
   * **The redo stack starts empty on every mount, and that is the whole of "redo does not
   * survive the app".** Rust persists `undone_at` so *undo* carries on where it stopped after a
   * restart; which of those the reader could still put back is their position in a session.
   */
  it("opens with an empty redo stack and asks the backend for no redo id", async () => {
    const { result } = renderHook(() => useDeckUndo(4), { wrapper });

    await waitFor(() => expect(result.current.undo).not.toBeNull());
    expect(deckUndoState).toHaveBeenCalledWith(4, null);
    expect(result.current.redo).toBeNull();
    expect(result.current.redoLabel).toBe("Redo");
  });

  /** The button names what it would do, in the same words the history drawer uses — two
   *  spellings of one sentence is exactly what `auditText` exists to prevent. */
  it("labels the undo button with the change it would reverse", async () => {
    const { result } = renderHook(() => useDeckUndo(4), { wrapper });

    await waitFor(() => expect(result.current.undoLabel).toBe("Undo — Removed 2 × Lightning Bolt"));
  });

  /** An undo pushes the id it undid, and the next state read asks about that id — which is how
   *  the Redo button gets anything to say. */
  it("pushes the undone id and asks about it on the next read", async () => {
    const { result } = renderHook(() => useDeckUndo(4), { wrapper });
    await waitFor(() => expect(result.current.undo).not.toBeNull());

    await act(async () => {
      result.current.runUndo();
    });

    await waitFor(() => expect(deckUndoApply).toHaveBeenCalledWith(4, 7));
    await waitFor(() => expect(deckUndoState).toHaveBeenLastCalledWith(4, 7));
  });

  /** A redo pops it again, so pressing Redo twice cannot re-apply one change twice. */
  it("pops the id after a redo", async () => {
    deckUndoState.mockResolvedValue(state({ redo: entry() }));
    const { result } = renderHook(() => useDeckUndo(4), { wrapper });
    await waitFor(() => expect(result.current.undo).not.toBeNull());
    await act(async () => {
      result.current.runUndo();
    });
    await waitFor(() => expect(deckUndoState).toHaveBeenLastCalledWith(4, 7));

    await act(async () => {
      result.current.runRedo();
    });

    await waitFor(() => expect(deckRedoApply).toHaveBeenCalledWith(4, 7));
    await waitFor(() => expect(deckUndoState).toHaveBeenLastCalledWith(4, null));
  });

  /**
   * **The ordinary undo contract**: once the reader has edited past a branch, the branch is
   * gone. `DeckEditor` calls this after every other deck write.
   */
  it("throws the redo stack away when the deck is written to another way", async () => {
    const { result } = renderHook(() => useDeckUndo(4), { wrapper });
    await waitFor(() => expect(result.current.undo).not.toBeNull());
    await act(async () => {
      result.current.runUndo();
    });
    await waitFor(() => expect(deckUndoState).toHaveBeenLastCalledWith(4, 7));

    act(() => {
      result.current.clearRedo();
    });

    await waitFor(() => expect(deckUndoState).toHaveBeenLastCalledWith(4, null));
  });

  /** A refusal is reported rather than thrown — `DeckEditor` draws it in the banner its other
   *  refused writes already use. */
  it("reports a refusal instead of throwing", async () => {
    deckUndoApply.mockRejectedValue("That is not the most recent change any more.");
    const { result } = renderHook(() => useDeckUndo(4), { wrapper });
    await waitFor(() => expect(result.current.undo).not.toBeNull());

    await act(async () => {
      result.current.runUndo();
    });

    await waitFor(() => expect(result.current.error).toContain("most recent change"));
  });

  /**
   * A redo that is refused can never work — the change is not undone any more, or another
   * window has moved the deck. Dropping it is what stops a button that fails every press.
   */
  it("drops a redo that the backend refuses", async () => {
    deckUndoState.mockResolvedValue(state({ redo: entry() }));
    deckRedoApply.mockRejectedValue("That change has not been undone.");
    const { result } = renderHook(() => useDeckUndo(4), { wrapper });
    await waitFor(() => expect(result.current.undo).not.toBeNull());
    await act(async () => {
      result.current.runUndo();
    });
    await waitFor(() => expect(deckUndoState).toHaveBeenLastCalledWith(4, 7));

    await act(async () => {
      result.current.runRedo();
    });

    await waitFor(() => expect(result.current.error).toContain("not been undone"));
    await waitFor(() => expect(deckUndoState).toHaveBeenLastCalledWith(4, null));
  });

  /** Nothing to undo is not an error and must not reach the backend as a write. */
  it("does nothing when there is nothing to undo", async () => {
    deckUndoState.mockResolvedValue({ undo: null, redo: null });
    const { result } = renderHook(() => useDeckUndo(4), { wrapper });
    await waitFor(() => expect(deckUndoState).toHaveBeenCalled());

    act(() => {
      result.current.runUndo();
      result.current.runRedo();
    });

    expect(deckUndoApply).not.toHaveBeenCalled();
    expect(deckRedoApply).not.toHaveBeenCalled();
    expect(result.current.undoLabel).toBe("Undo");
  });
});
