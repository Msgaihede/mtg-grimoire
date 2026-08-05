import { useCallback } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { CardDetailPane } from "@/features/card/CardDetailPane";
import { CollectionPage } from "@/features/collection/CollectionPage";
import { DeckEditor } from "@/features/decks/DeckEditor";
import { DecksPage } from "@/features/decks/DecksPage";
import { SearchPage } from "@/features/search/SearchPage";
import { WishlistPage } from "@/features/wishlist/WishlistPage";
import { queryClient } from "@/lib/query";
import { useAppStore, type ViewId } from "@/lib/store";

/**
 * What each view says while it is still a placeholder.
 *
 * The blurb only — no title. The ribbon's `h1` already names the active view, and a
 * second copy of the same word in the content was both a repetition and, at 20px against
 * the ribbon's 18px, a subheading louder than the heading above it.
 */
const BLURB: Record<Exclude<ViewId, "search" | "collection" | "wishlist" | "decks">, string> = {
  settings: "Data folder, sync behaviour, import and export. Coming in a later plan.",
};

function ActiveView() {
  const activeView = useAppStore((s) => s.activeView);
  const openDeckId = useAppStore((s) => s.openDeckId);
  if (activeView === "search") return <SearchPage />;
  if (activeView === "collection") return <CollectionPage />;
  if (activeView === "wishlist") return <WishlistPage />;
  // The gallery is the Decks view in its first state and the editor is the same view with a
  // deck open — one destination, two states, which is why the id lives in the store and not in
  // a route. Keyed by the deck: opening a second one from anywhere is a fresh editor rather
  // than one that inherits the last deck's grouping and open menu.
  if (activeView === "decks") {
    return openDeckId === null ? <DecksPage /> : <DeckEditor key={openDeckId} deckId={openDeckId} />;
  }

  return (
    <section className="mx-auto max-w-prose py-16 text-center">
      <p className="text-sm text-dim">{BLURB[activeView]}</p>
    </section>
  );
}

/**
 * The whole app.
 *
 * `QueryClientProvider` is here rather than in `main.tsx` so that any test can render
 * `<App />` and get the real caching behaviour; `AppShell` deliberately needs no
 * provider of its own (see `useSync`).
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

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell>
        <div className="flex h-full min-h-0 gap-4">
          <div className="min-w-0 flex-1">
            <ActiveView />
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
