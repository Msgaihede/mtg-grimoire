import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/lib/store";

beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

describe("the open card", () => {
  it("opens and closes on its own", () => {
    useAppStore.getState().setSelectedCardId("p1");
    expect(useAppStore.getState().selectedCardId).toBe("p1");

    useAppStore.getState().setSelectedCardId(null);
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * The detail pane is rendered beside whichever view is active, so a card left open
   * through a view change ends up docked next to the Decks placeholder — a pane about a
   * card, beside a page that has nothing to do with it and no way to dismiss it except
   * going back.
   */
  it("closes when the reader leaves the view that opened it", () => {
    useAppStore.getState().setSelectedCardId("p1");

    useAppStore.getState().setActiveView("decks");

    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /** Switching table/grid is the same list from another angle — not a reason to close. */
  it("survives a change of result layout", () => {
    useAppStore.getState().setSelectedCardId("p1");

    useAppStore.getState().setSearchView("table");

    expect(useAppStore.getState().selectedCardId).toBe("p1");
  });
});

/**
 * The deck editor is the Decks view in its second state rather than a screen of its own —
 * there is no router to give it a URL — so which deck is open is a fact about the app and
 * lives beside the open card.
 */
describe("the open deck", () => {
  it("opens and closes on its own", () => {
    useAppStore.getState().setOpenDeckId(4);
    expect(useAppStore.getState().openDeckId).toBe(4);

    useAppStore.getState().setOpenDeckId(null);
    expect(useAppStore.getState().openDeckId).toBeNull();
  });

  /**
   * Exactly what `selectedCardId` does, for the same reason: an editor is the *Decks* view,
   * and a deck left open through a trip to Settings would be waiting behind the sidebar with
   * the gallery it was opened from nowhere in sight.
   */
  it("closes when the reader leaves Decks", () => {
    useAppStore.getState().setOpenDeckId(4);

    useAppStore.getState().setActiveView("collection");

    expect(useAppStore.getState().openDeckId).toBeNull();
  });

  /** No deck is open until one is opened — the gallery is what Decks lands on. */
  it("starts closed", () => {
    expect(useAppStore.getState().openDeckId).toBeNull();
  });

  /**
   * Closing an editor leaves a note for the gallery about where the caret belongs. It has
   * nowhere else to live: the tile that opened the editor unmounts while the editor is up, so
   * neither side of the swap can hold a reference across it.
   */
  it("remembers which deck was closed, until the gallery has used it", () => {
    useAppStore.getState().setOpenDeckId(4);
    expect(useAppStore.getState().returnToDeckId).toBeNull();

    useAppStore.getState().setOpenDeckId(null);
    expect(useAppStore.getState().returnToDeckId).toBe(4);

    useAppStore.getState().clearReturnToDeck();
    expect(useAppStore.getState().returnToDeckId).toBeNull();
  });

  /** A note about a tile in a view the reader has left is a caret jump nobody asked for. */
  it("drops the note when the reader leaves Decks", () => {
    useAppStore.getState().setOpenDeckId(4);
    useAppStore.getState().setOpenDeckId(null);

    useAppStore.getState().setActiveView("search");

    expect(useAppStore.getState().returnToDeckId).toBeNull();
  });
});

/**
 * Two layouts, two settings. The search is for looking at cards and opens on the art; the
 * collection is usually for counting them and opens on the table. A reader who switches one
 * to compare prices has said nothing about the other, and one shared toggle would make that
 * choice for them in a view they were not looking at.
 */
describe("the two result layouts", () => {
  it("opens the search on art and the collection on the table", () => {
    expect(useAppStore.getState().searchView).toBe("grid");
    expect(useAppStore.getState().collectionView).toBe("table");
  });

  it("keeps them apart", () => {
    useAppStore.getState().setCollectionView("grid");

    expect(useAppStore.getState().collectionView).toBe("grid");
    expect(useAppStore.getState().searchView).toBe("grid");

    useAppStore.getState().setSearchView("table");

    expect(useAppStore.getState().collectionView).toBe("grid");
  });
});
