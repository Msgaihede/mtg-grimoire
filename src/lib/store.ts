import { create } from "zustand";

/** The five top-level destinations in the sidebar. */
export type ViewId = "search" | "collection" | "wishlist" | "decks" | "settings";

/**
 * The deck row the open card was opened *from* — which is the whole of what the card pane
 * needs to offer "Use this printing", and nothing more.
 *
 * A slot, addressed the way every deck write addresses one: the deck, the category, and the
 * printing that is in it. Not a `deck_cards.id`, for `useDeck`'s reason — a stale row id is
 * the difference between rewriting the slot the reader is looking at and rewriting one
 * somebody else already refilled.
 */
export interface PaneDeckContext {
  /** `decks.id` is an INTEGER primary key, so this is a number all the way to the command. */
  deckId: number;
  /**
   * The `deck_categories.id` the row is filed under — what the swap is addressed by.
   *
   * **Paired with {@link categoryName} on purpose, and the pair is not redundant.** Schema v8
   * made a category a row the user names, so the word is no longer derivable from the id by a
   * lookup table the way `ZONE_LABEL` was: it lives in the deck's own `categories` list, and
   * the pane is a *sibling* of the deck editor with nothing between them but this store. The
   * pane spells the name out twice — the fold announcement and the accessible name of every
   * "Use this printing" — so the alternative is the pane holding a copy of the deck's category
   * list to translate one id with. The writer already has both in hand (the editor draws the
   * column), so it hands both over.
   */
  categoryId: number;
  /** The category's name as the deck's own column heading reads it — see {@link categoryId}. */
  categoryName: string;
  /** The printing the deck holds in that slot — the swap's `from`, and normally the card the
   *  pane is showing. */
  cardId: string;
}

/** How the search results are laid out. */
export type SearchView = "table" | "grid";

interface AppState {
  activeView: ViewId;
  setActiveView: (view: ViewId) => void;
  searchView: SearchView;
  setSearchView: (view: SearchView) => void;
  /** How the collection is laid out. Separate from `searchView` on purpose — the search is
   *  for looking at cards, the collection is usually for counting them. */
  collectionView: SearchView;
  setCollectionView: (view: SearchView) => void;
  /** The printing the detail pane is showing, or `null` when it is closed. */
  selectedCardId: string | null;
  setSelectedCardId: (id: string | null) => void;
  /**
   * The deck row the open card came from, or `null` — which is every card opened from
   * anywhere else, and every card at all when no pane is open.
   *
   * It is here rather than in the pane because it is written by one view (the deck editor's
   * category columns) and read by another (the card pane docked beside them), and the two are
   * siblings under `App` with nothing between them but this store.
   */
  paneDeckContext: PaneDeckContext | null;
  /**
   * Open a card **as a deck row** — the one write that sets a context, and the only way to
   * set one.
   *
   * One action rather than a pair of setters, and that is the whole design: `setSelectedCardId`
   * clears the context (see there), so "every other way of opening a card leaves no context"
   * is structural rather than a rule six call sites have to remember. Two writers use this —
   * a click on a card in a category column, and a swap that succeeded, which re-anchors the
   * pane onto the printing the deck now holds in the same slot.
   */
  openCardFromDeck: (context: PaneDeckContext) => void;
  /**
   * Show another printing of the card the pane is already on — navigation *inside* the pane,
   * from a click on a printings row.
   *
   * The third way a card id lands in the pane, and the narrowest: `setSelectedCardId` means
   * "opened from somewhere that is not a deck row" and clears the context;
   * `openCardFromDeck` means "opened as a deck row" and sets it. This means neither — the
   * reader is browsing printings of whatever is open, so the context (and with it the pane's
   * "Use this printing" offers) must survive the click.
   */
  viewPrinting: (cardId: string) => void;
  /**
   * The deck the editor is open on, or `null` when Decks is showing its gallery.
   *
   * The one navigation fact decks need, and it is here for the same reason the whole store
   * is: the editor is the Decks view in its second state rather than a screen of its own,
   * and with no router there is nowhere else for "which one" to live. Everything *about*
   * that deck is TanStack Query's — this is an id and nothing more.
   */
  openDeckId: number | null;
  setOpenDeckId: (id: number | null) => void;
  /**
   * The deck an editor has just closed, waiting for the gallery to hand the caret back to its
   * tile — written by `setOpenDeckId(null)`, read and cleared once by `DecksPage`.
   *
   * Focus is not usually state, let alone global state, and this is the one case where it has
   * nowhere else to live: the tile that opened the editor **unmounts** while the editor is up,
   * so nothing on either side of the swap can hold a reference across it. Leaving it out drops
   * the caret onto `<body>` every time a reader comes back from a deck, and the next Tab
   * restarts from the top of the app.
   */
  returnToDeckId: number | null;
  clearReturnToDeck: () => void;
}

/**
 * UI state that outlives a single component tree.
 *
 * Deliberately not a router: this is a single-window desktop app with no URLs, no
 * history and no deep links, so a store is the whole of what a router would provide.
 * Server-ish state (cards, sync status) does not belong here — that is TanStack Query's
 * job and `useSync`'s.
 */
export const useAppStore = create<AppState>((set) => ({
  activeView: "search",
  // Leaving the view closes the card: the detail pane belongs to the list that opened it,
  // and a card sitting beside the Decks placeholder is a pane with nothing to be next to.
  // The open deck goes with it, for the same reason read the other way round: an editor is
  // the Decks view, so a deck left open through a trip to Settings would be waiting behind
  // the sidebar with the gallery it was opened from nowhere in sight.
  setActiveView: (activeView) =>
    set({
      activeView,
      selectedCardId: null,
      paneDeckContext: null,
      openDeckId: null,
      returnToDeckId: null,
    }),
  // Art by default: this is a card app, and the table is the view you switch to when you
  // are comparing prices rather than looking at cards.
  searchView: "grid",
  setSearchView: (searchView) => set({ searchView }),
  // The table by default, where the search takes the art: a collection is read for what is
  // in it — counts, conditions, what it is worth — and forty tiles answer none of that.
  collectionView: "table",
  setCollectionView: (collectionView) => set({ collectionView }),
  selectedCardId: null,
  // **And forgets which deck row the last card came from.** Every surface in the app that
  // opens a card goes through here — search tiles, collection rows, wishlist rows, the docked
  // panel's tiles, the validation panel's card names, and the pane's own close — and every one
  // of them opens something that is *not* the deck row the context named. Clearing it here is
  // what makes that true by construction instead of by six call sites remembering to say so;
  // the one surface that does mean it says so through `openCardFromDeck`.
  setSelectedCardId: (selectedCardId) => set({ selectedCardId, paneDeckContext: null }),
  paneDeckContext: null,
  openCardFromDeck: (paneDeckContext) =>
    set({ selectedCardId: paneDeckContext.cardId, paneDeckContext }),
  // Deliberately not touching `paneDeckContext` — see the interface doc.
  viewPrinting: (selectedCardId) => set({ selectedCardId }),
  // Decks opens on the gallery: a deck is something the reader picks, and reopening the last
  // one would be a decision made for them by the previous session.
  openDeckId: null,
  // Closing an editor remembers which deck it was, so the gallery it returns to can put the
  // caret back on that tile. Opening one leaves the note alone: it is consumed on arrival.
  // Closing or opening an editor also drops the deck row the card pane was anchored to: the
  // affordance it carries writes to a deck the reader can see, and with the gallery on screen
  // there is no editor to answer for the write or to re-read after a refusal. The card itself
  // stays open — the pane belongs to the reader, not to the view behind it.
  setOpenDeckId: (openDeckId) =>
    set((s) => ({
      openDeckId,
      paneDeckContext: null,
      returnToDeckId: openDeckId === null ? s.openDeckId : s.returnToDeckId,
    })),
  returnToDeckId: null,
  clearReturnToDeck: () => set({ returnToDeckId: null }),
}));
