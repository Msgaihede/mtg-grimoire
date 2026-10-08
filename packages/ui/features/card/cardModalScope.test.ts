import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
import { useCardModalScope } from "./cardModalScope";

/**
 * The store is module-level state, so a test that writes it leaves it written for whatever runs
 * next — and a suite that only passes in the order it happens to be collected in is not a suite.
 * `store.test.ts`'s line, verbatim.
 */
beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

const deckRow: PaneDeckContext = {
  deckId: 1,
  categoryId: 2,
  categoryName: "Burn spells",
  cardId: "c1",
  variant: "live",
  finish: null,
};

describe("the card modal's scope", () => {
  it("reads the deck row before the view, because a card opened from a deck is a deck card", () => {
    // `activeView` still says "decks", but what decides is the row — a card opened from the
    // editor's docked search panel has no row and must not draw deck controls.
    useAppStore.setState({ activeView: "decks", paneDeckContext: deckRow });
    const { result } = renderHook(() => useCardModalScope());

    expect(result.current.surface).toBe("deck");
    expect(result.current.quantity).toBe("deck");
    expect(result.current.deckControls).toBe(true);
    expect(result.current.deck).toEqual(deckRow);
  });

  /**
   * The half of the rule above that the view alone cannot answer: the deck editor is on screen,
   * so `activeView` is `"decks"`, and the card is one the deck does not hold. Deriving from the
   * view would offer to file it under a category and to set a quantity on a row that is not there.
   */
  it("draws no deck controls for a card opened in the editor's search panel", () => {
    useAppStore.setState({ activeView: "decks", paneDeckContext: null });
    const { result } = renderHook(() => useCardModalScope());

    expect(result.current.surface).not.toBe("deck");
    expect(result.current.deckControls).toBe(false);
    expect(result.current.quantity).toBeNull();
  });

  it("draws no stepper and no deck controls on the search page", () => {
    useAppStore.setState({ activeView: "search", paneDeckContext: null });
    const { result } = renderHook(() => useCardModalScope());

    expect(result.current.surface).toBe("search");
    expect(result.current.quantity).toBeNull();
    expect(result.current.deckControls).toBe(false);
  });

  it.each([
    ["collection", "owned"],
    ["wishlist", "wished"],
  ] as const)("binds the stepper to the %s count", (view, edits) => {
    useAppStore.setState({ activeView: view, paneDeckContext: null });
    const { result } = renderHook(() => useCardModalScope());

    expect(result.current.quantity).toBe(edits);
    expect(result.current.deckControls).toBe(false);
  });

  /**
   * The Tags page is a wall of cards like the search page and holds no quantity of its own — it
   * is browsing, not a list of anything the reader owns. It gets its own surface name because the
   * rail can differ; it does not get a stepper.
   */
  it("names the tags wall without giving it a stepper", () => {
    useAppStore.setState({ activeView: "tags", paneDeckContext: null });
    const { result } = renderHook(() => useCardModalScope());

    expect(result.current.surface).toBe("tags");
    expect(result.current.quantity).toBeNull();
  });
});
