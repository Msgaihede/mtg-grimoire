import { useCallback } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { CardDetailPane } from "@/features/card/CardDetailPane";
import { CollectionPage } from "@/features/collection/CollectionPage";
import { DeckEditor } from "@/features/decks/DeckEditor";
import { DecksPage } from "@/features/decks/DecksPage";
import { SearchPage } from "@/features/search/SearchPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { WishlistPage } from "@/features/wishlist/WishlistPage";
import { queryClient } from "@/lib/query";
import { useAppStore } from "@/lib/store";
import { useUpdate, type Update } from "@/lib/useUpdate";

function ActiveView({ update }: { update: Update }) {
  const activeView = useAppStore((s) => s.activeView);
  const openDeckId = useAppStore((s) => s.openDeckId);
  if (activeView === "search") return <SearchPage />;
  if (activeView === "collection") return <CollectionPage />;
  if (activeView === "wishlist") return <WishlistPage />;
  if (activeView === "settings") return <SettingsPage update={update} />;
  // The gallery is the Decks view in its first state and the editor is the same view with a
  // deck open — one destination, two states, which is why the id lives in the store and not in
  // a route. Keyed by the deck: opening a second one from anywhere is a fresh editor rather
  // than one that inherits the last deck's grouping and open menu.
  //
  // Last, and with no placeholder branch after it: every `ViewId` is now a real view, so the
  // `BLURB` map that used to catch Settings has nothing left to catch. What is still missing
  // from Settings is a sentence *inside* Settings, where it belongs.
  return openDeckId === null ? <DecksPage /> : <DeckEditor key={openDeckId} deckId={openDeckId} />;
}

/**
 * The whole app.
 *
 * `QueryClientProvider` is here rather than in `main.tsx` so that any test can render
 * `<App />` and get the real caching behaviour — and it is above `AppShell` rather than
 * inside the view, because the shell writes to the cache too now: the sidebar's Decks and
 * Wishlist entries are drop targets, and the deck one borrows the editor's own write
 * (`useSidebarDrops`).
 *
 * The card pane is docked *beside* the view rather than drawn over it: the list it came
 * from stays live, scrollable and clickable, so opening a second card is one click rather
 * than a dismiss and a hunt.
 */
export default function App() {
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);

  // Stable, because it is the pane's `onDismiss` and therefore a dependency of the
  // `keydown` listener behind it. An inline arrow is a new function on every render of the
  // whole app — every sync tick, every keystroke in the search box — and each one tears
  // the window listener down and adds it back for no change in behaviour.
  const closeCard = useCallback(() => setSelectedCardId(null), [setSelectedCardId]);
  // Owned here rather than in `AppShell`, because two places render it: the ribbon's button
  // and the Settings panel. One hook means one `update:progress` listener — two would be two
  // subscriptions racing to describe the same download.
  const update = useUpdate();

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell update={update}>
        <div className="flex h-full min-h-0 gap-4">
          <div className="min-w-0 flex-1">
            <ActiveView update={update} />
          </div>
          {selectedCardId && (
            <CardDetailPane
              // Remounted per card, which is what makes the pane's opening behaviour —
              // focus, scroll, the front face — belong to the card in it rather than to
              // the first card that was ever opened.
              key={selectedCardId}
              cardId={selectedCardId}
              onClose={closeCard}
            />
          )}
        </div>
      </AppShell>
    </QueryClientProvider>
  );
}
