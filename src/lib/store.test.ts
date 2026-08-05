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
