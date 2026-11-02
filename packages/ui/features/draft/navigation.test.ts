import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/lib/store";
import { openDraftDeck, openSavedDeck, returnToDraftPage } from "./navigation";

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

/**
 * An unsaved draft deck is apart from the reader's decks, so its editor is the Draft view's
 * (`draftDeckId`), never the Decks view's (`openDeckId`) — until Save hands it over.
 */
describe("draft deck navigation", () => {
  it("opens a draft deck in the Draft view, leaving the Decks view's editor alone", () => {
    useAppStore.setState({ activeView: "search" });
    openDraftDeck(9);
    expect(useAppStore.getState()).toMatchObject({
      activeView: "draft",
      draftDeckId: 9,
      openDeckId: null,
      parkedDeckId: null,
    });
  });

  it("keeps the draft deck open across a trip to another view, as a parked deck is", () => {
    openDraftDeck(9);
    useAppStore.getState().setActiveView("collection");
    expect(useAppStore.getState().draftDeckId).toBe(9);
    useAppStore.getState().setActiveView("draft");
    expect(useAppStore.getState()).toMatchObject({ activeView: "draft", draftDeckId: 9 });
  });

  it("goes back to the Draft page with the editor closed", () => {
    openDraftDeck(9);
    returnToDraftPage();
    expect(useAppStore.getState()).toMatchObject({ activeView: "draft", draftDeckId: null });
  });

  it("opens a saved deck in the Decks view's editor, and closes the Draft view's", () => {
    // A deck the reader left open in Decks earlier is parked; the saved deck is what lands.
    useAppStore.setState({ activeView: "decks", openDeckId: 3 });
    openDraftDeck(9);
    expect(useAppStore.getState().parkedDeckId).toBe(3);
    openSavedDeck(9);
    expect(useAppStore.getState()).toMatchObject({
      activeView: "decks",
      openDeckId: 9,
      draftDeckId: null,
    });
    // And Draft & Packs opens on its page next time.
    useAppStore.getState().setActiveView("draft");
    expect(useAppStore.getState().draftDeckId).toBeNull();
  });
});
