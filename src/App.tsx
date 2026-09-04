import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { AppShell } from "@/components/AppShell";
import { CardZoomIndicator } from "@/components/CardZoomIndicator";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { AllPrintingsDialog } from "@/features/card/AllPrintingsDialog";
import { CardDetailModal } from "@/features/card/CardDetailModal";
import { CardTextDialog } from "@/features/card/CardTextDialog";
import { LegalityDialog } from "@/features/card/LegalityDialog";
import { OracleTagsDialog } from "@/features/card/OracleTagsDialog";
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
import { FeedDownloadProvider } from "@/pwa/FeedDownloadProvider";

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
 * **The card is a centred modal, mounted once, and there is no longer a second mount to stand
 * aside for** (2026-09-03). It was a 384px column docked beside the view, plus a second copy the
 * deck editor drew as an overlay over one of its own two columns (issue #183) — two shapes of one
 * surface, and the `inDeckEditor` selector that chose between them. `CardDetailModal` reads
 * `selectedCardId` itself, so nothing here passes it a card and nothing here has to suppress a
 * rival mount; the argument for docking (the list behind stays live and clickable) is answered
 * instead by a scrim the reader dismisses in one press.
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
  // Owned here rather than in `AppShell`, because two places render it: the ribbon's button
  // and the Settings panel. One hook means one `update:progress` listener — two would be two
  // subscriptions racing to describe the same download.
  const update = useUpdate();
  // The browser's update is NOT here, and that is a fix rather than an oversight: `PwaShell` in
  // `main.tsx` owns it, because on the web target this component is mounted only once a corpus
  // exists and the shell has to be registered long before that. That file has the measurement.

  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        {/* **Inside `QueryClientProvider` and outside `ContextMenuProvider`**, which is
            `CardToDeckProvider`'s placement argument verbatim: that provider draws its panel as
            a *sibling* of `children`, so a context mounted inside it would be around every view
            and around none of the menu's own rows. Inside the query client because the three
            downloads it guards are all mutations against it.

            Inert on desktop: the guard is a synchronous pass-through and the dialog is never
            constructed. */}
        <FeedDownloadProvider>
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
                  {/* No flank column beside the view any more: the card is a centred modal
                      mounted below, so nothing here reserves width for it. */}
                  <ActiveView update={update} />
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

                {/* **The card itself, and the three overlays its rail opens — five siblings of the
              shell, and not one of them may be a child of another.**

              `AllPrintingsDialog` above and these four are all `fixed` scrims, and a `fixed` box
              is laid out against the window only while nothing between it and the root is a
              containing block for it. `CardDetailModal` asks `Dialog` for `container`, which puts
              `@container/card` on its panel — and `container-type` implies **layout
              containment**, which makes that panel the containing block for every `fixed`
              descendant under it. A legality grid rendered *inside* the card modal would
              therefore have its `fixed inset-0` scrim resolve against the panel: it would cover
              the card and nothing else, with no scrim over the app and no way to tell from the
              DOM that anything was wrong. `src/CLAUDE.md` states the same rule from the other
              end — a modal may never be mounted inside a container box — and `FilterBar` had to
              become a fragment for it. Here the rule is met by placement: the modal draws no
              overlay, it writes `cardOverlay` in the store, and each of these three reads that
              field from out here.

              **`CardDetailModal` must be inside `CardToDeckProvider`**, which every mount in this
              block is: its action row's `Add to deck` picker calls `useOptionalAddCardToDeck()`, and
              that hook answers `null` outside the provider — so a mount above it would draw the
              control permanently disabled, with nothing going red.

              Order among the five is not load-bearing: they are ranked by `LAYER.overlay` and
              `LAYER.overlayStacked` rather than by document order, which is the whole reason that
              rung was split. */}
                <CardDetailModal />
                <LegalityDialog />
                <OracleTagsDialog />
                <CardTextDialog />
              </ContextMenuProvider>
            </CardToDeckProvider>
          </TooltipProvider>
        </FeedDownloadProvider>
      </QueryClientProvider>
    </MotionConfig>
  );
}
