import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { NAV } from "@grimoire/ui/components/nav";
import { NotificationsDialog } from "@grimoire/ui/components/NotificationsDialog";
import { Toaster } from "@grimoire/ui/components/Toaster";
import { TooltipProvider } from "@grimoire/ui/components/tooltip/TooltipProvider";
import { usePrefetchShelfFolds } from "@grimoire/ui/features/shelves/useShelfFolds";
import { DialogHostContext, type DialogHost } from "@grimoire/ui/lib/dialogHost";
import type { LightView } from "@grimoire/ui/lib/edition";
import type { DeckVariant } from "@grimoire/ui/lib/ipc";
import { queryClient } from "@grimoire/ui/lib/query";
import { cn } from "@grimoire/ui/lib/utils";
import type { Place } from "../routes";
import { CardDataContext, useCardDataWatch } from "./cardData";
import { CardSheet } from "./CardSheet";
import type { WallItem } from "./CardWall";
import { CollectionPage } from "./pages/CollectionPage";
import { DeckPage } from "./pages/DeckPage";
import { DecksPage } from "./pages/DecksPage";
import { ScannerPage } from "./pages/ScannerPage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TradePage } from "./pages/TradePage";
import { WishlistPage } from "./pages/WishlistPage";
import { adoptOverlay, navigate, usePlace } from "./router";
import { adoptStaleSheet, claimBack } from "./sheetHistory";
import { Shell } from "./Shell";
import { useTouchShell } from "./touchShell";

/**
 * What this face lends every `Dialog` it draws — its own sheets and the shared panels Settings
 * draws alike (`@grimoire/ui/lib/dialogHost`): an entry in history per open dialog, so Back
 * closes it, and a header a finger can drag down. One object for the face's life, so no dialog
 * re-claims its step on a render.
 */
const PHONE_DIALOGS: DialogHost = { claimBack, swipeToClose: true };

/**
 * **Where the phone's toasts stand** — `Toaster`'s `className`, measured at 360 and 412px wide.
 *
 * Across the width, 8px in from each side plus the side's safe-area inset: a 320px card in the
 * desktop's corner is most of a phone, and a column that starts at an odd offset reads as a
 * mistake. **Lifted over the tab bar (52px and its rule) and over one receipt line (48px and its
 * rule)**, plus the bottom inset: every card write on this face also draws its receipt line at the
 * foot of the page or the sheet it came from, with that write's `Undo` in it, and a toast standing
 * on that line would cover the `Undo` for the whole of its stay. A receipt line that is not up
 * leaves a gap of its height, which is the cheaper mistake.
 *
 * From 600px the tab bar is a rail down the left (`TabBar`), so nothing is under the page but the
 * bottom inset: the stack goes back to the desktop's corner, 320px wide, still lifted over a
 * receipt line.
 *
 * Whole class strings rather than a sum in code, so Tailwind finds every one in the source.
 */
const PHONE_TOASTS = cn(
  "right-[calc(0.5rem+env(safe-area-inset-right))] left-[calc(0.5rem+env(safe-area-inset-left))] w-auto max-w-none",
  "bottom-[calc(6.25rem+2px+0.5rem+env(safe-area-inset-bottom))]",
  "min-[600px]:left-auto min-[600px]:right-[calc(1rem+env(safe-area-inset-right))] min-[600px]:w-80",
  "min-[600px]:bottom-[calc(3rem+1px+0.5rem+env(safe-area-inset-bottom))]",
);

/**
 * {@link PHONE_TOASTS} over a deck: **its action bar is one strip more** (`DeckPage`'s `ActionBar`,
 * 44px and 16px of padding and its rule) between the receipt line and the tab bar, so the stack
 * stands that much higher there.
 */
const PHONE_TOASTS_OVER_DECK = cn(
  PHONE_TOASTS,
  "bottom-[calc(10rem+3px+0.5rem+env(safe-area-inset-bottom))]",
  "min-[600px]:bottom-[calc(6.75rem+2px+0.5rem+env(safe-area-inset-bottom))]",
);

/** The word for a destination — the desktop rail's, so the two apps cannot name one differently. */
const titleOf = (view: LightView): string => NAV.find((n) => n.id === view)?.label ?? "";

/**
 * Open a card over wherever the reader is. A push, so Back closes it.
 *
 * Only a tile with a card to open is a control at all (`WallTile`): a wish whose card the corpus
 * has lost has no printing to show, and is drawn as no button rather than as one that does
 * nothing — so every press that reaches here names a card.
 */
const openCard = (place: Place) => (item: WallItem) => {
  if (item.cardId !== null) navigate({ ...place, cardId: item.cardId });
};

/**
 * The page for a place.
 *
 * A `switch` over `LightView` with no `default`: an eighth view added to the edition is then a
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
    case "trade":
      // The list, or the trade the URL names: `/trade/5` is a place, so a reload and Back both
      // know where the reader was (`routes.ts`).
      return <TradePage tradeId={place.tradeId ?? null} />;
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
    // A sheet's entry a reload kept, with no sheet left to close, goes first: the overlay check
    // below reads the entry's state, and a sheet's would hide the page's from it.
    adoptStaleSheet();
    adoptOverlay();
    return null;
  });
  // The page stops zooming as a whole while this face is up — see `touchShell.ts`.
  useTouchShell();
  const place = usePlace();
  // The stored folds, asked for at launch as `AppShell` asks for them — so neither cabinet draws
  // its shelves at the defaults and then re-folds a frame later.
  usePrefetchShelfFolds();
  // The card sync and the three feeds, heard once for the whole face: what a finished download
  // makes stale is refreshed, and what is running rides the mana line — `useCardDataWatch` says
  // why the phone needs its own mount of the desktop shell's listeners.
  const { data: cardData, activity } = useCardDataWatch();

  /**
   * Which list each deck has been switched to this session — **held here rather than by the deck
   * page**, because the card sheet over that page reads it too: its `Add to <deck>` adds to the
   * list on screen, and the two must agree (`deck/list.ts`). Page state, not a place: a list is a
   * way of looking at a deck, which the desktop face would drop from the URL anyway.
   */
  const [picks, setPicks] = useState<ReadonlyMap<number, DeckVariant>>(() => new Map());
  const pick = (deckId: number, list: DeckVariant) =>
    setPicks((now) => new Map(now).set(deckId, list));
  /** The inbox is up. Page state, not a place: a dialog over wherever the reader is, whose Back
   *  step is the dialog host's — the desktop shell's own flag, read across. */
  const [inbox, setInbox] = useState(false);
  return (
    <DialogHostContext.Provider value={PHONE_DIALOGS}>
      <CardDataContext.Provider value={cardData}>
        <Shell
          title={titleOf(place.view)}
          activity={activity}
          inboxOpen={inbox}
          onInbox={() => setInbox(true)}
        >
          <Pages place={place} picks={picks} onPick={pick} />
        </Shell>
        {/* A sibling of the shell, not a child of a page: `Dialog`'s scrim is `fixed inset-0`, and
          nothing that covers the window may mount inside a box that could become its containing
          block. `App.tsx` mounts the desktop's card modal the same way. */}
        <CardSheet
          cardId={place.cardId}
          deckPicked={place.deckId === null ? null : (picks.get(place.deckId) ?? null)}
        />
        <NotificationsDialog open={inbox} onClose={() => setInbox(false)} />
        {/* **Once for the face**, as `AppShell` mounts it for the desktop's: the store is module
            state, so a second stack would draw every toast twice. A sibling of the shell for the
            sheet's reason above — it is `fixed`, at `LAYER.toast`, over every sheet. */}
        <Toaster
          className={
            place.view === "decks" && place.deckId !== null
              ? PHONE_TOASTS_OVER_DECK
              : PHONE_TOASTS
          }
        />
      </CardDataContext.Provider>
    </DialogHostContext.Provider>
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
