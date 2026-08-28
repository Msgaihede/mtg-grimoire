import { useCallback } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence, MotionConfig } from "motion/react";
import { AppShell } from "@/components/AppShell";
import { CardZoomIndicator } from "@/components/CardZoomIndicator";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { AllPrintingsDialog } from "@/features/card/AllPrintingsDialog";
import { CardDetailPane } from "@/features/card/CardDetailPane";
import { CardToDeckProvider } from "@/features/card/cardMenu";
import { CollectionPage } from "@/features/collection/CollectionPage";
import { DeckEditor } from "@/features/decks/DeckEditor";
import { DecksPage } from "@/features/decks/DecksPage";
import { SearchPage } from "@/features/search/SearchPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { TagsPage } from "@/features/tags/TagsPage";
import { WishlistPage } from "@/features/wishlist/WishlistPage";
import { queryClient } from "@/lib/query";
import { useAppStore } from "@/lib/store";
import { useUpdate, type Update } from "@/lib/useUpdate";
import { UpdateReadyBar } from "@/pwa/UpdateReadyBar";
import { useServiceWorker } from "@/pwa/useServiceWorker";

function ActiveView({ update }: { update: Update }) {
  const activeView = useAppStore((s) => s.activeView);
  const openDeckId = useAppStore((s) => s.openDeckId);
  if (activeView === "search") return <SearchPage />;
  if (activeView === "tags") return <TagsPage />;
  if (activeView === "collection") return <CollectionPage />;
  if (activeView === "wishlist") return <WishlistPage />;
  if (activeView === "settings") return <SettingsPage update={update} />;
  // The gallery is the Decks view in its first state and the editor is the same view with a
  // deck open — one destination, two states, which is why the id lives in the store and not in
  // a route. Keyed by the deck: opening a second one from anywhere is a fresh editor rather
  // than one that inherits the last deck's grouping and open menu.
  //
  // **A reader who came back from the Collection lands on this line's second arm** (issue #162):
  // `setActiveView` parks the open deck on the way out and hands it back on the way in, so the
  // id read above is already the one they left. Nothing here knows that happened, which is the
  // point of parking it in the store rather than teaching this component about a previous view.
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
 * **The deck editor is the exception, and it draws its own** (issue #183, 2026-08-22). Docking
 * costs the view 384px plus a gap for as long as a card is open, which on every other screen is
 * width a wall of tiles simply reflows into — and in the editor is width taken off a deck *and*
 * the search column beside it, so a click on a card re-packed the piles and collapsed the search
 * a reader was adding from. There the pane is an overlay over one of those two columns, drawn by
 * `DeckEditor` and positioned by where the card was opened from; `inDeckEditor` below is this
 * component standing aside for it, and exactly one of the two mounts is ever live.
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
  /**
   * Whether a deck editor is on screen — and therefore whether the card pane is **this**
   * component's to draw at all.
   *
   * The editor hosts its own copy of the pane, as an overlay over one of its two columns rather
   * than as a third one (issue #183); see `DeckEditor`'s pane host. So exactly one of the two
   * mounts is live at any moment, and this is the switch. Suppressing the docked one is not
   * cosmetic — left up it would be a second `CardDetailPane` on the same card, a second
   * `complementary` landmark answering every `getByRole` in the suite, and the 400px of shell
   * width the overlay exists to give back.
   *
   * `openDeckId` alone, with no `activeView` clause: `setActiveView` clears the open deck in the
   * same write, so a non-null id already means the Decks view in its second state. **That still
   * holds now that a deck survives a trip to the Collection** (issue #162) — what survives is
   * `parkedDeckId`, a second field, and this one is emptied on the way out and refilled on the
   * way back exactly as before. Keeping that invariant is the whole reason the park is not just
   * a longer-lived `openDeckId`: this line, the branch in `ActiveView`, and `useSidebarDrops`'
   * "is there a deck to drop into" would each have needed a clause, and the next reader would
   * have had to remember to write the fourth.
   *
   * **The editor draws no pane until its deck has loaded, and nothing is lost by that**, which is
   * worth stating because it is the one hole in the switch. `setOpenDeckId` deliberately keeps
   * `selectedCardId` — the card belongs to the reader, not to the view behind it — so in principle
   * a card could be open across the read. Nothing on the gallery can open one: it draws deck
   * tiles and folders and no card surface at all, and every other view clears the card on the way
   * out through `setActiveView`. So the id is null whenever an editor mounts.
   */
  const inDeckEditor = useAppStore((s) => s.openDeckId !== null);

  // Stable, because it is the pane's `onDismiss` and therefore a dependency of the
  // `keydown` listener behind it. An inline arrow is a new function on every render of the
  // whole app — every sync tick, every keystroke in the search box — and each one tears
  // the window listener down and adds it back for no change in behaviour.
  const closeCard = useCallback(() => setSelectedCardId(null), [setSelectedCardId]);
  // Owned here rather than in `AppShell`, because two places render it: the ribbon's button
  // and the Settings panel. One hook means one `update:progress` listener — two would be two
  // subscriptions racing to describe the same download.
  const update = useUpdate();
  // The browser's update, not the portable swap's. One hook, mounted once, for `useUpdate`'s
  // reason: two registrations would be two objects racing to describe one waiting worker.
  // Inert on desktop — `useServiceWorker` returns without registering when `isWebTarget()` is
  // false, so this costs a `useState` and nothing else in the shipped window.
  const browserUpdate = useServiceWorker();

  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        {/* **The provider wraps the shell; the menu it renders is a sibling of it**, for exactly
            the reason `CardZoomIndicator` below is one. A menu takes `LAYER.popup`, a z-index
            competes only inside its own stacking context, and every card surface in this app draws
            rows that are `position: absolute` and transformed — so a menu mounted where it was
            opened is capped at that row's `LAYER.raised` and painted under the table header above
            it. Mounted here, drawn at the pointer. Nothing between here and the root transforms.

            Inside `QueryClientProvider` rather than outside it, because a menu's rows are built
            from the cache the view beside them reads: a lazy submenu's `Content` runs `useDecks()`
            when the reader expands it, and a chosen action writes through the same client the
            surface it was opened over would have. */}
        {/* **Above `ContextMenuProvider`, and that placement is the whole of what this line is
            about.** The provider below draws its panel as a **sibling** of `children`, so
            "inside `AppShell`" and "inside the menu" are two different places: this mounted
            around the shell would be around every *view* and around none of the menu's *rows*,
            and `useAddCardToDeck` would throw the moment a reader expanded "Add to → Deck" — on
            every card surface at once, not on one of them. It shipped that way for one commit.
            Anything a menu's rows
            need goes here, outside the menu provider, not inside the shell it renders.

            Inside `QueryClientProvider` because it mounts `useDeck`, which is a query. */}
        {/* **Above `ContextMenuProvider` for the reason `CardToDeckProvider` is**: that provider
            draws its panel as a *sibling* of `children`, so a context mounted inside it would be
            around every view and around none of the menu's own rows — and a menu row binding a
            tooltip would silently get the no-op API. Inside `QueryClientProvider`, because a
            caller's tooltip `content` is rendered here and may be a component that reads the
            cache. Nothing between here and the root transforms, which is what lets the panel be
            `fixed` against the window rather than against a virtualised row. */}
        <TooltipProvider>
          <CardToDeckProvider>
            <ContextMenuProvider>
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
                    {selectedCardId && !inDeckEditor && (
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

              One instance for the whole app, because a reader makes one gesture at a time. Each
              card section now keeps its **own** zoom — the search and collection walls, the deck
              editor's docked search column, and its desk — so the figure is never about "the
              zoom"; it is about the one section the last ctrl+wheel landed in, and it is drawn in
              that section's top-right corner (`zoomSection` names it, `anchorFor` measures it).
              That is what makes a single badge right rather than a compromise: four badges would
              be three of them describing a gesture nobody just made, and the one that mattered
              would be no easier to find. It is mounted *here* and drawn *there*, which is the
              whole trick — the corner comes from a measurement, not from where this line sits. */}
              <CardZoomIndicator />
              {/* **Every printing of one card, over whatever the reader is already looking at.**
              A sibling of the shell for the badge's reason one line up: the panel is `fixed` at
              `LAYER.overlay`, a z-index competes only inside its own stacking context, and every
              card surface in this app draws rows that are positioned and transformed — so mounted
              where it was opened it would be capped by that row's layer. Nothing between here and
              the root transforms.

              **One instance, and that is what the whole change is for.** `View all printings` is on
              the card menu of twelve surfaces, and it used to answer by *moving* the reader: to the
              Search view from the collection and the wishlist, into the 384px card pane inside the
              deck editor. Both destinations closed something to show a list. A dialog mounted here
              is drawn over all twelve without any of them knowing it exists, so asking the question
              costs the reader nothing — the deck stays open behind the scrim, and closing the modal
              puts them back exactly where they were.

              Inside `CardToDeckProvider` and `ContextMenuProvider` because its tiles carry the same
              card menu every other wall in the app draws, lazy deck picker included; inside
              `QueryClientProvider` because it reads `card_printings` and writes through
              `deck_swap_printing`. */}
              <AllPrintingsDialog />
              {/* A sibling of the shell for `CardZoomIndicator`'s reason: the bar is `fixed` at
              `LAYER.popup`, a z-index competes only inside its own stacking context, and
              every card surface in this app draws positioned, transformed rows. Nothing
              between here and the root transforms.

              Web-only in effect rather than in placement: `useServiceWorker` never registers
              on desktop, so `ready` is permanently false there and this renders nothing. */}
              <UpdateReadyBar
                ready={browserUpdate.updateReady}
                onApply={browserUpdate.applyUpdate}
              />
            </ContextMenuProvider>
          </CardToDeckProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </MotionConfig>
  );
}
