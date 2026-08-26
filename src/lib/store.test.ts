import { beforeEach, describe, expect, it } from "vitest";
import type { CardWalkStop } from "@/features/decks/deckWalk";
import { useAppStore, type PaneDeckContext } from "@/lib/store";

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
  /**
   * One slot, as the deck editor's category columns write it.
   *
   * Both halves of the category are here because the store keeps both: schema v8 made a
   * category a row the *user* names, so the word is no longer derivable from the id by a lookup
   * table, and the pane that reads this context is a sibling of the editor with no category list
   * of its own. `PaneDeckContext` is where that pairing is argued.
   */
  const MAIN: PaneDeckContext = {
    deckId: 4,
    categoryId: 1,
    categoryName: "Main deck",
    cardId: "p1",
    variant: "live",
    finish: null,
  };

  it("opens the card and remembers the row in one write", () => {
    useAppStore.getState().openCardFromDeck(MAIN);

    expect(useAppStore.getState().selectedCardId).toBe("p1");
    expect(useAppStore.getState().paneDeckContext).toEqual(MAIN);
  });

  /**
   * The one that has to be structural rather than remembered: every other surface that opens
   * a card — a search tile, a collection row, a wishlist row, the docked panel's tiles, the
   * validation panel — goes through `setSelectedCardId`, and each of them opens a card that is
   * *not* the deck row the last context named.
   */
  it("forgets the row when a card is opened from anywhere else", () => {
    useAppStore.getState().openCardFromDeck(MAIN);

    useAppStore.getState().setSelectedCardId("p2");

    expect(useAppStore.getState().selectedCardId).toBe("p2");
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /**
   * The third way a card id lands in the pane, and the narrowest: browsing another printing
   * of whatever is open is navigation *inside* the pane, so the deck row — and with it the
   * pane's "Use this printing" offers — survives the click. `setSelectedCardId` here instead
   * would silently drop the swap affordance the moment a reader compared printings, which is
   * the one moment it is for.
   */
  it("keeps the row while the reader browses printings inside the pane", () => {
    useAppStore.getState().openCardFromDeck(MAIN);

    useAppStore.getState().viewPrinting("p2");

    expect(useAppStore.getState().selectedCardId).toBe("p2");
    expect(useAppStore.getState().paneDeckContext).toEqual(MAIN);
  });

  /** The pane closes through the same setter, so the context goes with it. */
  it("forgets the row when the pane closes", () => {
    useAppStore.getState().openCardFromDeck(MAIN);

    useAppStore.getState().setSelectedCardId(null);

    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /** Leaving Decks closes the card; a context left behind would be about a pane that is gone. */
  it("forgets the row when the reader leaves the view", () => {
    useAppStore.getState().openCardFromDeck(MAIN);

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
    useAppStore.getState().openCardFromDeck(MAIN);

    useAppStore.getState().setOpenDeckId(null);

    expect(useAppStore.getState().paneDeckContext).toBeNull();
    // The card itself stays: the pane belongs to the reader, not to the editor behind it.
    expect(useAppStore.getState().selectedCardId).toBe("p1");
  });
});

/**
 * Which side of the desk the card pane is drawn over — the second thing the store keeps about an
 * open card, and deliberately not the first one read backwards.
 *
 * The deck editor draws the pane as an overlay (issue #183): over the **search column** for a
 * card opened anywhere else, and over the **deck** for a card opened in the search column, so
 * that whichever way round it is the pane covers what the reader was not looking at.
 *
 * `paneDeckContext !== null` is the tempting complement and is the wrong one, which is what the
 * third test here pins: that field means *this card is a row of the open deck*, and the
 * validation panel's card names are deck cards opened through `setSelectedCardId`. Read
 * backwards, they would put the pane over the very piles the sentence beside them is about.
 */
describe("which side of the desk the pane was opened from", () => {
  it("marks a card opened in the search column, in one write", () => {
    useAppStore.getState().openCardFromDeckSearch("p9");

    expect(useAppStore.getState().selectedCardId).toBe("p9");
    expect(useAppStore.getState().paneFromDeckSearch).toBe(true);
    // And it is not a deck row, so nothing offers to swap a printing into one.
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /** The two openers exclude each other, in one `set` apiece — so the pane can never be told it
   *  came from both sides at once, whichever order the reader presses in. */
  it("is cleared by the deck's own opener, and clears it in turn", () => {
    useAppStore.getState().openCardFromDeckSearch("p9");
    useAppStore.getState().openCardFromDeck({
      deckId: 4,
      categoryId: 1,
      categoryName: "Main deck",
      cardId: "p1",
      variant: "live",
      finish: null,
    });

    expect(useAppStore.getState().paneFromDeckSearch).toBe(false);
    expect(useAppStore.getState().paneDeckContext).not.toBeNull();

    useAppStore.getState().openCardFromDeckSearch("p9");

    expect(useAppStore.getState().paneFromDeckSearch).toBe(true);
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /**
   * **The case that makes this a field of its own.** A validation-panel card name goes through
   * `setSelectedCardId` — it is a deck card, but not a deck *row* the pane can swap into — so it
   * leaves no context. Read as "no context means the search column", the pane would open over
   * the deck and cover the cards the panel is complaining about.
   */
  it("says the deck side for an opener that leaves no deck row either", () => {
    useAppStore.getState().openCardFromDeckSearch("p9");

    useAppStore.getState().setSelectedCardId("p1");

    expect(useAppStore.getState().paneDeckContext).toBeNull();
    expect(useAppStore.getState().paneFromDeckSearch).toBe(false);
  });

  /** Browsing printings inside the pane is navigation, not a new opening: the pane must not
   *  jump across the desk because the reader clicked a row in it. */
  it("keeps its side while the reader browses printings inside the pane", () => {
    useAppStore.getState().openCardFromDeckSearch("p9");

    useAppStore.getState().viewPrinting("p10");

    expect(useAppStore.getState().selectedCardId).toBe("p10");
    expect(useAppStore.getState().paneFromDeckSearch).toBe(true);
  });

  /** Both navigations drop it, beside the deck row and for a sharper version of its reason: the
   *  column this names only exists inside an editor. */
  it("forgets it when the editor closes and when the view changes", () => {
    useAppStore.setState({ openDeckId: 4 });
    useAppStore.getState().openCardFromDeckSearch("p9");
    useAppStore.getState().setOpenDeckId(null);
    expect(useAppStore.getState().paneFromDeckSearch).toBe(false);

    useAppStore.setState({ openDeckId: 4 });
    useAppStore.getState().openCardFromDeckSearch("p9");
    useAppStore.getState().setActiveView("collection");
    expect(useAppStore.getState().paneFromDeckSearch).toBe(false);
  });
});

/**
 * The finish the pane was opened **as** — the third fact about an open card, and the same design
 * as the two above it read once more: one opener writes it, and every other opener clears it in
 * its own `set`.
 */
describe("the finish a card was opened as", () => {
  /**
   * The collection's tiles are one per printing **and finish**, so opening one has to say which.
   * The pane draws the sheen from it — there is no foil photograph to fetch, so what a foil tile
   * opens is the same picture under `FoilOverlay`.
   */
  it("carries the finish a collection tile was opened as", () => {
    useAppStore.getState().openCardAsFinish("bolt-lea", "foil");
    expect(useAppStore.getState().selectedCardId).toBe("bolt-lea");
    expect(useAppStore.getState().paneFinish).toBe("foil");
  });

  /**
   * Every other opener clears it in its own `set`, which is this store's whole design: "the pane
   * came from one surface" is a fact about one write rather than an agreement between six call
   * sites that all remembered.
   */
  it("forgets the finish when the card is opened from anywhere else", () => {
    useAppStore.getState().openCardAsFinish("bolt-lea", "foil");
    useAppStore.getState().setSelectedCardId("bolt-2ed");
    expect(useAppStore.getState().paneFinish).toBeNull();

    useAppStore.getState().openCardAsFinish("bolt-lea", "foil");
    useAppStore.getState().openCardFromDeckSearch("bolt-2ed");
    expect(useAppStore.getState().paneFinish).toBeNull();
  });

  /**
   * `viewPrinting` leaves it alone: the reader is browsing printings **inside** the pane and the
   * foil view is theirs to keep. `foilViewFinish` already answers `null` for a printing with no
   * shiny finish, so a seed carried onto a nonfoil-only printing cannot draw a chip.
   */
  it("keeps the finish while browsing printings inside the pane", () => {
    useAppStore.getState().openCardAsFinish("bolt-lea", "foil");
    useAppStore.getState().viewPrinting("bolt-2ed");
    expect(useAppStore.getState().paneFinish).toBe("foil");
  });

  /** A nonfoil tile names its finish too — that is not the same as no surface having named one. */
  it("tells a nonfoil tile apart from no tile at all", () => {
    useAppStore.getState().openCardAsFinish("bolt-lea", "nonfoil");
    expect(useAppStore.getState().paneFinish).toBe("nonfoil");
  });
});

/**
 * The channel between a card's menu and the printings modal.
 *
 * **One field, written by one action that touches nothing else** — which is the whole of what
 * replaced `pendingCardSearch`. That channel's destination was a *view*, so it wrote
 * `activeView`, `selectedCardId`, `paneDeckContext`, `openDeckId` and `returnToDeckId` in one
 * `set`: asking which printings a card had moved the reader to Search and closed the deck the
 * card was being asked about. The modal is drawn over whatever is already on screen, so there
 * is nowhere to navigate to and nothing to clear.
 */
describe("the card a reader asked to see every printing of", () => {
  /**
   * The slot a press inside the modal writes to, as a deck editor row builds it: every one of
   * the five parts of `DECK_CARD_GRAIN`, for the reason `PaneDeckContext`'s own doc gives.
   */
  const SLOT: PaneDeckContext = {
    deckId: 4,
    categoryId: 9,
    categoryName: "Ramp",
    cardId: "card-1",
    variant: "live",
    finish: null,
  };

  it("has nothing waiting until something asks", () => {
    expect(useAppStore.getState().printingsRequest).toBeNull();
  });

  it("records the request, the printing it was asked from and the deck slot", () => {
    useAppStore.getState().openAllPrintings({
      cardId: "card-1",
      oracleId: "o1",
      name: "Sol Ring",
      deck: SLOT,
      wish: null,
    });

    expect(useAppStore.getState().printingsRequest).toEqual({
      cardId: "card-1",
      oracleId: "o1",
      name: "Sol Ring",
      deck: SLOT,
      wish: null,
    });
  });

  /**
   * Every surface that is not a row of an open deck says so by handing over `null`, and the
   * field keeps that rather than filling it in — a press then opens the card pane instead of
   * rewriting a deck row nobody named.
   */
  it("keeps a null slot from a surface that is not a deck row", () => {
    useAppStore.getState().openAllPrintings({
      cardId: "card-1",
      oracleId: "o1",
      name: "Sol Ring",
      deck: null,
      wish: null,
    });

    expect(useAppStore.getState().printingsRequest?.deck).toBeNull();
  });

  /**
   * The other target a press can have, and the whole of what the wishlist adds to this channel:
   * the row a press **repoints** onto the printing pressed, where `deck` names the row a press
   * rewrites. A wish is addressed by its own id — `wishlist_set_printing` takes the row and not
   * the grain — so there is nothing else to carry.
   */
  it("records the wishlist row a press repoints", () => {
    useAppStore.getState().openAllPrintings({
      cardId: "card-1",
      oracleId: "o1",
      name: "Sol Ring",
      deck: null,
      wish: { id: 7 },
    });

    expect(useAppStore.getState().printingsRequest?.wish).toEqual({ id: 7 });
  });

  /**
   * **The field is required, so a surface with no wish has to say so** — and this is the half
   * that keeps the modal honest, because it is what a *walk step* writes.
   *
   * `CardWalkStop` deliberately carries no wish, so stepping re-opens this channel with `null`
   * and the repoint target clears: the reader asked about wish A, and arrowing to card B must not
   * rewrite A onto a printing it was never for. Made optional the field would read identically at
   * every site and mean the opposite by omission.
   */
  it("keeps a null wish from a surface with none to repoint", () => {
    useAppStore.getState().openAllPrintings({
      cardId: "card-1",
      oracleId: "o1",
      name: "Sol Ring",
      deck: SLOT,
      wish: { id: 7 },
    });

    useAppStore.getState().openAllPrintings({
      cardId: "forest-1",
      oracleId: "o-forest",
      name: "Forest",
      deck: null,
      wish: null,
    });

    expect(useAppStore.getState().printingsRequest?.wish).toBeNull();
  });

  /**
   * The printing the reader asked *from*, which every surface can answer where only a deck row
   * can answer the slot beside it. It is the wall's "you are here" ring, and it is how the modal
   * finds its place on a walk whose stops are not deck rows.
   */
  it("keeps the printing the question was asked from, deck or no deck", () => {
    useAppStore.getState().openAllPrintings({
      cardId: "card-9",
      oracleId: "o1",
      name: "Sol Ring",
      deck: null,
      wish: null,
    });

    expect(useAppStore.getState().printingsRequest?.cardId).toBe("card-9");
  });

  /**
   * The whole of the change. `requestAllPrintings` used to write `activeView`,
   * `selectedCardId`, `paneDeckContext`, `openDeckId` and `returnToDeckId` in the same `set` —
   * so asking which printings a card had closed the deck you were building it into.
   */
  it("moves nothing else", () => {
    useAppStore.setState({ activeView: "decks", openDeckId: 4, selectedCardId: "card-1" });

    useAppStore.getState().openAllPrintings({
      cardId: "card-1",
      oracleId: "o1",
      name: "Sol Ring",
      deck: null,
      wish: null,
    });

    const s = useAppStore.getState();
    expect(s.activeView).toBe("decks");
    expect(s.openDeckId).toBe(4);
    expect(s.selectedCardId).toBe("card-1");
  });

  it("closes to null", () => {
    useAppStore.getState().openAllPrintings({
      cardId: "card-1",
      oracleId: "o1",
      name: "Sol Ring",
      deck: null,
      wish: null,
    });

    useAppStore.getState().closeAllPrintings();

    expect(useAppStore.getState().printingsRequest).toBeNull();
  });
});

/**
 * The list the reader is standing in, in the order it is drawn, published by whichever surface
 * is drawing it — the deck editor's desk, the search results, the collection, the wishlist.
 *
 * The channel above carries **which** card is open; this carries **what is either side of it**,
 * and it is a second field for the same reason the first one is a field at all — the modal is a
 * sibling of every one of those surfaces with nothing between them but this store. It is the
 * whole list rather than a cursor because where the reader is in it is *found*, by matching the
 * request against these, so the two cannot come to disagree about which card is showing.
 */
describe("the list the reader is standing in, in its drawn order", () => {
  const stop = (name: string, categoryId: number, categoryName: string): CardWalkStop => ({
    cardId: `c-${name}`,
    oracleId: `o-${name}`,
    name,
    deck: {
      deckId: 4,
      categoryId,
      categoryName,
      cardId: `c-${name}`,
      variant: "live",
      finish: null,
    },
  });

  const WALK = {
    label: "the deck",
    stops: [stop("Sol Ring", 9, "Ramp"), stop("Pyroblast", 2, "Sideboard")],
  };
  const NONE = { label: "", stops: [] };

  /** Nothing with a list of cards on it has been open, so there is nothing to walk — and an
   *  empty array rather than `null`, because "no stops" is a walk of no length and every reader
   *  of this is a `.length` or a `.findIndex`. */
  it("has nothing to walk until a surface publishes one", () => {
    expect(useAppStore.getState().cardWalk.stops).toEqual([]);
  });

  it("takes the order it is handed", () => {
    useAppStore.getState().setCardWalk(WALK);

    expect(useAppStore.getState().cardWalk).toEqual(WALK);
  });

  /** The chevrons read it into their own names — `Next card in your collection` — so a walk that
   *  did not carry the list's noun would have the modal saying somebody else's. */
  it("carries what to call the list", () => {
    useAppStore.getState().setCardWalk({ ...WALK, label: "your collection" });

    expect(useAppStore.getState().cardWalk.label).toBe("your collection");
  });

  /** The publishing surface clears it on unmount: a walk left behind would step a modal opened
   *  from the Collection into the piles of a deck nobody has open. */
  it("clears when the surface that published it goes", () => {
    useAppStore.getState().setCardWalk(WALK);

    useAppStore.getState().setCardWalk(NONE);

    expect(useAppStore.getState().cardWalk.stops).toEqual([]);
  });

  /**
   * **An empty walk is always the same object**, which is not pedantry about identity: this
   * store notifies every subscriber on every write and each one compares its slice with
   * `Object.is`, so a fresh empty walk per teardown re-renders whatever is reading it — the shut
   * printings modal included — to tell it that nothing is still nothing.
   */
  it("clears to the same empty walk every time", () => {
    const first = useAppStore.getState().cardWalk;

    useAppStore.getState().setCardWalk(WALK);
    useAppStore.getState().setCardWalk(NONE);

    expect(useAppStore.getState().cardWalk).toBe(first);
  });

  /** And a label handed in with no stops goes with them: a walk with nothing on it has no list
   *  to name, and keeping the noun would be a second identity for the same emptiness. */
  it("drops a label handed in with no stops", () => {
    useAppStore.getState().setCardWalk({ label: "your wishlist", stops: [] });

    expect(useAppStore.getState().cardWalk.label).toBe("");
  });

  /** One field, like `openAllPrintings` beside it. Publishing the walk says nothing about which
   *  card is open, which deck is open or which view the reader is on. */
  it("moves nothing else", () => {
    useAppStore.setState({ activeView: "decks", openDeckId: 4, selectedCardId: "card-1" });

    useAppStore.getState().setCardWalk(WALK);

    const s = useAppStore.getState();
    expect(s.activeView).toBe("decks");
    expect(s.openDeckId).toBe(4);
    expect(s.selectedCardId).toBe("card-1");
    expect(s.printingsRequest).toBeNull();
  });
});

/**
 * Four layouts, four settings. Every one of them opens on the art — this is a card app — and a
 * reader who switches one to compare prices has said nothing about the other three, which one
 * shared toggle would decide for them in a view they were not looking at.
 */
describe("the four result layouts", () => {
  it("opens every list on art", () => {
    expect(useAppStore.getState().searchView).toBe("grid");
    expect(useAppStore.getState().tagsView).toBe("grid");
    // The one that used to open on the table, and the reversal is `store.ts`' own note: the
    // choice is remembered now, so a default is only what a list looks like before anybody
    // has said.
    expect(useAppStore.getState().collectionView).toBe("grid");
    expect(useAppStore.getState().wishlistView).toBe("grid");
  });

  it("keeps them apart", () => {
    useAppStore.getState().setCollectionView("table");

    expect(useAppStore.getState().collectionView).toBe("table");
    expect(useAppStore.getState().searchView).toBe("grid");

    useAppStore.getState().setSearchView("table");

    expect(useAppStore.getState().collectionView).toBe("table");
    expect(useAppStore.getState().wishlistView).toBe("grid");
  });

  /** The pulse is what `useListViewPersistence` writes off, and it counts *presses* rather than
   *  values — so a press that lands a list on the layout it was already showing still moves it.
   *  A value-watcher would miss exactly that, which is the case this pins. */
  it("counts a press even when the layout does not move", () => {
    const before = useAppStore.getState().listViewPulse;
    useAppStore.getState().setSearchView("grid");

    expect(useAppStore.getState().searchView).toBe("grid");
    expect(useAppStore.getState().listViewPulse).toBe(before + 1);
    expect(useAppStore.getState().listViewSection).toBe("search");
  });
});

/**
 * The `list_view` row arriving at launch. It is the reader's memory rather than an authority, so
 * everything it cannot say is a list left on the default this file built it with.
 */
describe("hydrating the stored layouts", () => {
  it("seeds only the lists the row names", () => {
    useAppStore.getState().hydrateListViews({ collection: "table" });

    expect(useAppStore.getState().collectionView).toBe("table");
    expect(useAppStore.getState().searchView).toBe("grid");
    expect(useAppStore.getState().wishlistView).toBe("grid");
    expect(useAppStore.getState().tagsView).toBe("grid");
  });

  /**
   * A list this build does not draw, and a word that is not a layout. Both are what a newer build
   * or a hand-edit leaves behind, and both have to cost the reader nothing beyond that entry —
   * a thrown narrowing here would be a store that cannot be seeded at all.
   */
  it("ignores a section it does not know and a word that is not a layout", () => {
    useAppStore.getState().hydrateListViews({
      binders: "table",
      collection: "cards",
      wishlist: "table",
    });

    expect(useAppStore.getState().collectionView).toBe("grid");
    expect(useAppStore.getState().wishlistView).toBe("table");
  });

  /**
   * **The race the guard exists for.** The read is a round trip, so a reader who presses the
   * toggle inside it would otherwise watch last session's layout overwrite their own a moment
   * later — a list visibly snapping back under their hand with nothing on screen explaining it.
   */
  it("leaves a layout the reader has already pressed alone", () => {
    useAppStore.getState().setCollectionView("grid");

    useAppStore.getState().hydrateListViews({ collection: "table", search: "table" });

    expect(useAppStore.getState().collectionView).toBe("grid");
    // Whole-store rather than per-section, which is what the pulse can answer: inside a
    // sub-second window the reader has by definition reached only one list.
    expect(useAppStore.getState().searchView).toBe("grid");
  });
});

/**
 * The two Flatten switches — "ignore the filing and show me every folder's cards at once".
 *
 * Two pages, not the layouts' four: the card search and the Tags page have no cabinet for a
 * switch to ignore. And **two different defaults**, which is the thing this block exists to pin,
 * because it is exactly what reads as an oversight later and gets "tidied" into agreement.
 */
describe("the two Flatten switches", () => {
  /**
   * The collection opens flattened and the wishlist does not, and the asymmetry is a measurement:
   * since schema v25 every card in a deck lives in that deck's group folder, so the collection's
   * root — "filed nowhere" — was 0 of 275 entries on the maintainer's real database, and an
   * unflattened first launch drew `Cards 0` over a full binder. The wishlist's root is where
   * readers actually keep wishes, so it opens on something already.
   */
  it("opens the collection flattened and the wishlist on its root", () => {
    expect(useAppStore.getState().collectionFlattened).toBe(true);
    expect(useAppStore.getState().wishlistFlattened).toBe(false);
  });

  /** One switch per cabinet: a reader who flattened their binder has said nothing about what
   *  their shopping list should show. */
  it("keeps the two pages apart", () => {
    useAppStore.getState().toggleCollectionFlattened();

    expect(useAppStore.getState().collectionFlattened).toBe(false);
    expect(useAppStore.getState().wishlistFlattened).toBe(false);

    useAppStore.getState().toggleWishlistFlattened();

    expect(useAppStore.getState().collectionFlattened).toBe(false);
    expect(useAppStore.getState().wishlistFlattened).toBe(true);
  });

  /** The pulse is what `useFlattenPersistence` writes off, and the section is what tells it which
   *  row to touch — so a press has to move both, and name the page it happened on. */
  it("counts each press and says which page it was on", () => {
    useAppStore.getState().toggleWishlistFlattened();

    expect(useAppStore.getState().flattenPulse).toBe(1);
    expect(useAppStore.getState().flattenSection).toBe("wishlist");

    useAppStore.getState().toggleCollectionFlattened();

    expect(useAppStore.getState().flattenPulse).toBe(2);
    expect(useAppStore.getState().flattenSection).toBe("collection");
  });
});

/**
 * The `flatten_state` row arriving at launch. The reader's memory rather than an authority, so
 * everything it cannot say is a page left on the default this file built it with — and here that
 * matters twice over, because the two defaults differ.
 */
describe("hydrating the stored Flatten switches", () => {
  it("seeds only the pages the row names", () => {
    useAppStore.getState().hydrateFlatten({ collection: false });

    expect(useAppStore.getState().collectionFlattened).toBe(false);
    // Unnamed, so still the default — and `false` here is the built-in one rather than an echo of
    // the entry above it, which is the whole reason the two defaults are worth a test.
    expect(useAppStore.getState().wishlistFlattened).toBe(false);

    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.getState().hydrateFlatten({ wishlist: true });

    expect(useAppStore.getState().wishlistFlattened).toBe(true);
    expect(useAppStore.getState().collectionFlattened).toBe(true);
  });

  /**
   * A page this build does not file cards in, and a value that is not a boolean. Both are what a
   * newer build or a hand-edit leaves behind, and the object crossed an IPC boundary — where
   * `boolean` is a claim rather than a fact. Each has to cost the reader that entry and nothing
   * beside it, which is why a valid sibling rides along in the same object.
   */
  it("skips a section it does not know and a value that is not a boolean", () => {
    const fields = Object.keys(useAppStore.getState());

    useAppStore.getState().hydrateFlatten({
      binders: true,
      collection: "1",
      wishlist: true,
    });

    expect(useAppStore.getState().collectionFlattened).toBe(true);
    expect(useAppStore.getState().wishlistFlattened).toBe(true);
    // And the unknown page reaches the store as *nothing at all* rather than as a field of its
    // own: without the key guard, `FLATTEN_FIELD[section]` is `undefined` and zustand merges the
    // write in under that name — a state nobody declared, which no assertion about the two
    // booleans above could see.
    expect(Object.keys(useAppStore.getState())).toEqual(fields);
  });

  /**
   * **The race the guard exists for**, `hydrateListViews`' verbatim. The read is a round trip, so
   * a reader who flips the switch inside it would otherwise watch last session's answer overwrite
   * theirs a moment later — a page visibly re-filing itself under their hand.
   */
  it("leaves a switch the reader has already pressed alone", () => {
    useAppStore.getState().toggleCollectionFlattened();

    useAppStore.getState().hydrateFlatten({ collection: true, wishlist: true });

    expect(useAppStore.getState().collectionFlattened).toBe(false);
    // Whole-store rather than per-section, which is what the pulse can answer: inside a
    // sub-second window the reader has by definition reached only one page.
    expect(useAppStore.getState().wishlistFlattened).toBe(false);
  });
});

/**
 * The export dialog's format and field choice, kept apart by surface — a deck export wants
 * Moxfield's printing line and a collection export wants a CSV with a condition column, and one
 * remembered setting would make each of them wrong half the time.
 */
describe("the export dialog's remembered choice", () => {
  it("remembers an export choice per surface, so a deck export is not dragged into the collection's", () => {
    useAppStore.getState().setExportPrefs("collection", {
      format: "csv",
      fields: ["quantity", "name", "condition"],
      arenaOnly: false,
    });
    expect(useAppStore.getState().exportPrefs.collection.format).toBe("csv");
    expect(useAppStore.getState().exportPrefs.deck.format).toBe("plain");
  });

  /** The Arena filter is remembered the same way and is **off** everywhere on a first run: the
   *  Arena export has written every card handed to it since it shipped, and a filter that
   *  started on would quietly change what an existing reader's next export contains. */
  it("opens with the Arena filter off on every surface", () => {
    const { exportPrefs } = useAppStore.getState();
    expect([
      exportPrefs.deck.arenaOnly,
      exportPrefs.collection.arenaOnly,
      exportPrefs.wishlist.arenaOnly,
    ]).toEqual([false, false, false]);
  });

  /** Per surface, like the pair beside it — a reader who filters their deck exports for Arena
   *  has said nothing about what a collection export should contain. */
  it("keeps the Arena filter apart by surface", () => {
    const prefs = useAppStore.getState().exportPrefs.deck;
    useAppStore.getState().setExportPrefs("deck", { ...prefs, arenaOnly: true });
    expect(useAppStore.getState().exportPrefs.deck.arenaOnly).toBe(true);
    expect(useAppStore.getState().exportPrefs.collection.arenaOnly).toBe(false);
  });
});
