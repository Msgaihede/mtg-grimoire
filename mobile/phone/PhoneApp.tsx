import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { NAV } from "@/components/nav";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { LightView } from "@/lib/edition";
import type { DeckVariant } from "@/lib/ipc";
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
import { adoptOverlay, navigate, usePlace } from "./router";
import { Shell } from "./Shell";

/** The word for a destination — the desktop rail's, so the two apps cannot name one differently. */
const titleOf = (view: LightView): string => NAV.find((n) => n.id === view)?.label ?? "";

/**
 * Open a card over wherever the reader is. A push, so Back closes it.
 *
 * **A tile with no card id opens nothing.** The one row that makes such a tile is a wish whose
 * card the corpus no longer has a printing of: it has neither a printing of its own nor one to be
 * drawn as, so there is no id for a sheet to ask about. (A wish for *any* printing is not that
 * row — it carries the printing it is drawn as, and opens it.) The tile is still a button,
 * because the wall makes every tile one; what this guard buys is a press that does nothing
 * rather than a sheet that can only say the card could not be read.
 */
const openCard = (place: Place) => (item: WallItem) => {
  if (item.cardId !== null) navigate({ ...place, cardId: item.cardId });
};

/**
 * The page for a place.
 *
 * A `switch` over `LightView` with no `default`: a seventh view added to the edition is then a
 * compile error here rather than a blank page.
 */
function Pages({
  place,
  picks,
  onPick,
}: {
  place: Place;
  picks: ReadonlyMap<number, DeckVariant>;
  onPick: (deckId: number, list: DeckVariant) => void;
}) {
  const onOpen = openCard(place);
  switch (place.view) {
    case "search":
      return <SearchPage onOpen={onOpen} />;
    case "decks":
      return place.deckId === null ? (
        <DecksPage folderId={place.folderId ?? null} />
      ) : (
        <DeckPage
          // Keyed by the deck: a second one is a fresh page, not the first one's scroll position.
          key={place.deckId}
          deckId={place.deckId}
          picked={picks.get(place.deckId) ?? null}
          onPick={(list) => onPick(place.deckId as number, list)}
          // A deck's rows, its findings and its notes name a card by id rather than by a wall
          // tile, so the deck page is handed the push itself.
          onOpenCard={(cardId) => navigate({ ...place, cardId })}
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
  // Before the first read of the place, so a card the desktop face had open over this entry is
  // one this router can close with a Back by the time its sheet draws — see `adoptOverlay`. A lazy
  // initializer for `useDesktopPlace`'s reason; StrictMode's second run finds nothing to adopt.
  useState(() => {
    adoptOverlay();
    return null;
  });
  const place = usePlace();
  /**
   * Which list each deck has been switched to this session — **held here rather than by the deck
   * page**, because the card sheet over that page reads it too: its `Add to <deck>` adds to the
   * list on screen, and the two must agree (`deck/list.ts`). Page state, not a place: a list is a
   * way of looking at a deck, which the desktop face would drop from the URL anyway.
   */
  const [picks, setPicks] = useState<ReadonlyMap<number, DeckVariant>>(() => new Map());
  const pick = (deckId: number, list: DeckVariant) =>
    setPicks((now) => new Map(now).set(deckId, list));
  return (
    <>
      <Shell title={titleOf(place.view)}>
        <Pages place={place} picks={picks} onPick={pick} />
      </Shell>
      {/* A sibling of the shell, not a child of a page: `Dialog`'s scrim is `fixed inset-0`, and
          nothing that covers the window may mount inside a box that could become its containing
          block. `App.tsx` mounts the desktop's card modal the same way. */}
      <CardSheet
        cardId={place.cardId}
        deckPicked={place.deckId === null ? null : (picks.get(place.deckId) ?? null)}
      />
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
