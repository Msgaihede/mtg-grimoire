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
 * Which deck row the open card came from — the whole of what the pane's "Use this printing"
 * needs, and the one piece of app state that is about *two* views at once.
 *
 * The clearing is what these are really about: a context that outlived the card it was set
 * for would offer to rewrite a deck row from a card opened out of the collection.
 */
describe("the deck row a card was opened from", () => {
  it("opens the card and remembers the row in one write", () => {
    useAppStore.getState().openCardFromDeck({ deckId: 4, zone: "main", cardId: "p1" });

    expect(useAppStore.getState().selectedCardId).toBe("p1");
    expect(useAppStore.getState().paneDeckContext).toEqual({
      deckId: 4,
      zone: "main",
      cardId: "p1",
    });
  });

  /**
   * The one that has to be structural rather than remembered: every other surface that opens
   * a card — a search tile, a collection row, a wishlist row, the docked panel's tiles, the
   * validation panel — goes through `setSelectedCardId`, and each of them opens a card that is
   * *not* the deck row the last context named.
   */
  it("forgets the row when a card is opened from anywhere else", () => {
    useAppStore.getState().openCardFromDeck({ deckId: 4, zone: "main", cardId: "p1" });

    useAppStore.getState().setSelectedCardId("p2");

    expect(useAppStore.getState().selectedCardId).toBe("p2");
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /** The pane closes through the same setter, so the context goes with it. */
  it("forgets the row when the pane closes", () => {
    useAppStore.getState().openCardFromDeck({ deckId: 4, zone: "main", cardId: "p1" });

    useAppStore.getState().setSelectedCardId(null);

    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /** Leaving Decks closes the card; a context left behind would be about a pane that is gone. */
  it("forgets the row when the reader leaves the view", () => {
    useAppStore.getState().openCardFromDeck({ deckId: 4, zone: "main", cardId: "p1" });

    useAppStore.getState().setActiveView("collection");

    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /**
   * And when the editor closes under it. The affordance belongs to the editor that is open:
   * pressing it with the gallery on screen would write to a deck the reader cannot see, and
   * the refused-write family that answers for it is the editor's.
   */
  it("forgets the row when the editor closes", () => {
    useAppStore.setState({ openDeckId: 4 });
    useAppStore.getState().openCardFromDeck({ deckId: 4, zone: "main", cardId: "p1" });

    useAppStore.getState().setOpenDeckId(null);

    expect(useAppStore.getState().paneDeckContext).toBeNull();
    // The card itself stays: the pane belongs to the reader, not to the editor behind it.
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
