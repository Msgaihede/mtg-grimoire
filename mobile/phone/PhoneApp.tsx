import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { NAV } from "@/components/nav";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { LightView } from "@/lib/edition";
import { queryClient } from "@/lib/query";
import type { Place } from "../routes";
import { CardSheet } from "./CardSheet";
import type { WallItem } from "./CardWall";
import { CollectionPage } from "./pages/CollectionPage";
import { DeckPage } from "./pages/DeckPage";
import { DecksPage } from "./pages/DecksPage";
import { ScannerPage } from "./pages/ScannerPage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WishlistPage } from "./pages/WishlistPage";
import { navigate, usePlace } from "./router";
import { Shell } from "./Shell";

/** The word for a destination — the desktop rail's, so the two apps cannot name one differently. */
const titleOf = (view: LightView): string => NAV.find((n) => n.id === view)?.label ?? "";

/** Open a card over wherever the reader is. A push, so Back closes it. */
const openCard = (place: Place) => (item: WallItem) => {
  // A wish for any printing has no card of its own to open; its picture's is the honest one.
  if (item.cardId !== null) navigate({ ...place, cardId: item.cardId });
};

/**
 * The page for a place.
 *
 * A `switch` over `LightView` with no `default`: a seventh view added to the edition is then a
 * compile error here rather than a blank page.
 */
function Pages({ place }: { place: Place }) {
  const onOpen = openCard(place);
  switch (place.view) {
    case "search":
      return <SearchPage onOpen={onOpen} />;
    case "decks":
      return place.deckId === null ? (
        <DecksPage onOpen={(deckId) => navigate({ view: "decks", deckId, cardId: null })} />
      ) : (
        <DeckPage
          // Keyed by the deck: a second one is a fresh page, not the first one's scroll position.
          key={place.deckId}
          deckId={place.deckId}
          onOpen={onOpen}
          onBack={() => navigate({ view: "decks", deckId: null, cardId: null })}
        />
      );
    case "collection":
      return <CollectionPage onOpen={onOpen} />;
    case "wishlist":
      return <WishlistPage onOpen={onOpen} />;
    case "scanner":
      return <ScannerPage />;
    case "settings":
      return <SettingsPage />;
  }
}

/**
 * The phone face, less its providers — what a test renders inside a fake world's own.
 */
export function PhoneFace() {
  const place = usePlace();
  return (
    <>
      <Shell title={titleOf(place.view)}>
        <Pages place={place} />
      </Shell>
      {/* A sibling of the shell, not a child of a page: `Dialog`'s scrim is `fixed inset-0`, and
          nothing that covers the window may mount inside a box that could become its containing
          block. `App.tsx` mounts the desktop's card modal the same way. */}
      <CardSheet cardId={place.cardId} onClose={() => navigate({ ...place, cardId: null })} />
    </>
  );
}

/**
 * The phone face: the light app below 1024px.
 *
 * Its providers are the desktop's own, in the desktop's order and for `App.tsx`'s reasons —
 * `MotionConfig` outermost because `motion` ships `reducedMotion: "never"`, and the one shared
 * `queryClient`, so data read by one face is still in the cache when a resize draws the other.
 */
export default function PhoneApp() {
  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <PhoneFace />
        </TooltipProvider>
      </QueryClientProvider>
    </MotionConfig>
  );
}
