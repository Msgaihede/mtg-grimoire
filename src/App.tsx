import { useCallback } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence, MotionConfig } from "motion/react";
import { AppShell } from "@/components/AppShell";
import { CardZoomIndicator } from "@/components/CardZoomIndicator";
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
 *
 * ## `MotionConfig` is here for the same reason `QueryClientProvider` is
 *
 * Outermost, and in `App.tsx` rather than `main.tsx`, so that **every** `motion` component in
 * the app is under it and so that a test rendering `<App />` gets the real behaviour. Nothing
 * in the suite and nothing in Storybook ever loads `main.tsx`; a provider put there is a
 * provider only the shipped window has.
 *
 * **It is load-bearing, not decorative.** `motion` does not honour `prefers-reduced-motion` on
 * its own — `MotionConfigContext` ships `reducedMotion: "never"` — so without this line every
 * animation in the app runs at full travel for a reader who asked their OS for less.
 *
 * **What it does is deliberately weaker than the app's CSS rule, and both now coexist.**
 * `reducedMotion: "user"` makes transforms and `width`/`height`/`top`/`left` **instant** while
 * **opacity, colour and filter still animate** — that is WCAG 2.3.3's actual intent, where the
 * hazard is movement rather than a cross-fade. `motion-reduce:transition-none`, which
 * `lib/tokens.test.ts` requires beside every CSS transition class in the app, stops the lot.
 * Neither is wrong; they are two rules, and this file is where to find out that there are two.
 *
 * **Not `useReducedMotion()`.** That hook reads the media query once through `useState` and
 * never updates when it changes under a running app, so as an app-wide switch it is a bug that
 * only shows up for the reader who changes the setting. It is fine inside one component that
 * wants to swap a slide for a fade; it is wrong here.
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
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <AppShell update={update}>
          <div className="flex h-full min-h-0 gap-4">
            <div className="min-w-0 flex-1">
              <ActiveView update={update} />
            </div>
            {/* **The pane's *presence*, and nothing finer.** The key here is a constant on
                purpose: it used to be `selectedCardId`, which was right when a close was
                instant and is wrong the moment there is an exit, because every card-to-card
                move would then be one pane leaving and another arriving — a 440ms cross-fade
                where the reader pressed a printings row and expected the picture to change.
                The per-card remount that keying bought is *kept*, one level down and inside
                the animated element, where React can throw the body away without the box it
                is in going anywhere. See `CardDetailPane`. */}
            <AnimatePresence>
              {selectedCardId && (
                <CardDetailPane key="card-pane" cardId={selectedCardId} onClose={closeCard} />
              )}
            </AnimatePresence>
          </div>
        </AppShell>
        {/* **A sibling of the shell, not a child of any view.** The badge is `fixed` and takes
            `LAYER.popup`, and a z-index only competes inside its own stacking context — so
            mounting it inside a view would cap it at whatever that view's transformed or
            positioned ancestors allow, which is exactly the bug `layers.ts` was written about.
            Nothing between here and the root transforms.

            One instance for the whole app, because there is one zoom: the wheel gesture is
            attached per card section (the search and collection walls, the deck editor's stack
            and grid), but they all step the same `cardZoom`, so a reader who zooms the search
            wall and switches to Decks finds the cards there already at the size they asked for.
            A badge per section would be four clocks racing to describe one number. */}
        <CardZoomIndicator />
      </QueryClientProvider>
    </MotionConfig>
  );
}
