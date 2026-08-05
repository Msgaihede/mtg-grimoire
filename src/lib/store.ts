import { create } from "zustand";

/** The five top-level destinations in the sidebar. */
export type ViewId = "search" | "collection" | "wishlist" | "decks" | "settings";

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
  setActiveView: (activeView) => set({ activeView, selectedCardId: null }),
  // Art by default: this is a card app, and the table is the view you switch to when you
  // are comparing prices rather than looking at cards.
  searchView: "grid",
  setSearchView: (searchView) => set({ searchView }),
  // The table by default, where the search takes the art: a collection is read for what is
  // in it — counts, conditions, what it is worth — and forty tiles answer none of that.
  collectionView: "table",
  setCollectionView: (collectionView) => set({ collectionView }),
  selectedCardId: null,
  setSelectedCardId: (selectedCardId) => set({ selectedCardId }),
}));
