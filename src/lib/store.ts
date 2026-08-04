import { create } from "zustand";

/** The five top-level destinations in the sidebar. */
export type ViewId = "search" | "collection" | "wishlist" | "decks" | "settings";

interface AppState {
  activeView: ViewId;
  setActiveView: (view: ViewId) => void;
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
  setActiveView: (activeView) => set({ activeView }),
}));
