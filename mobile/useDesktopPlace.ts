import { useEffect, useState } from "react";
import { isLightView, LIGHT_START } from "@/lib/edition";
import { useAppStore } from "@/lib/store";
import { parsePlace, placeHref, type Place } from "./routes";

type DesktopWhere = Pick<
  ReturnType<typeof useAppStore.getState>,
  "activeView" | "openDeckId" | "selectedCardId"
>;

/** Where the desktop store says the reader is, as a {@link Place}: the view, the deck open in
 *  it, and the card open over it. A view the light edition does not draw — a shared binder,
 *  reached from the collection — reads as the start view: the URL has no word for it. */
function placeOf(where: DesktopWhere): Place {
  const view = isLightView(where.activeView) ? where.activeView : LIGHT_START;
  return {
    view,
    deckId: view === "decks" ? where.openDeckId : null,
    cardId: where.selectedCardId,
  };
}

const here = (): Place => parsePlace(window.location.pathname, window.location.search);

/**
 * Put the store where `place` says.
 *
 * **Through `setActiveView`, and always at least once**, which is what makes the URL win over the
 * stored start view: that action bumps `viewPulse`, and the shell's launch hydration drops a seed
 * that lands after the first press. `mobile:tauri` shares the desktop's database, whose stored
 * view may be `home` — a page the light rail has no row for.
 */
function apply(place: Place): void {
  const before = useAppStore.getState();
  if (before.activeView !== place.view || before.viewPulse === 0) before.setActiveView(place.view);
  // Read again: entering Decks hands back a parked deck, and the URL's answer is the one to keep.
  const after = useAppStore.getState();
  if (place.view === "decks" && after.openDeckId !== place.deckId) after.setOpenDeckId(place.deckId);
  // The card last, and read once more: `setActiveView` closes whatever card was open, so the
  // URL's card can only be opened once the view it is over is on screen.
  const last = useAppStore.getState();
  if (last.selectedCardId !== place.cardId) last.setSelectedCardId(place.cardId);
}

/**
 * Keeps the desktop face's store and the URL saying the same thing.
 *
 * The desktop UI has no router: where the reader is, is three fields of its store —
 * `activeView`, `openDeckId` and `selectedCardId`. A browser needs a URL — for Back, for a link,
 * and so that crossing the 1024px floor lands on the same destination, with the same card open,
 * in the other face. This is the one adapter between the two, and it lives in the light entry so
 * that no router enters `src/`.
 *
 * **Three things are kept in step and two of them are history.** A view and a deck are places:
 * arriving at one is an entry, and Back leaves it. The open card is not — here it is a modal
 * over a page, so it is written onto the entry it was opened over and never gets one of its own.
 */
export function useDesktopPlace(): void {
  // Seeded during the first render, before `App` mounts under this hook's caller — so the
  // desktop UI never draws Home for a frame on its way to the URL's view. A lazy initializer
  // rather than a ref read in render, which `react-hooks/refs` refuses; StrictMode runs it twice
  // and the second run changes nothing.
  useState(() => {
    apply(here());
    return null;
  });

  useEffect(() => {
    // True while the store is being moved *to* the URL. `apply` may take several writes to get
    // there — entering Decks hands back a parked deck before the URL's own answer replaces it,
    // and the card is opened after both — and each place between them is one the URL never named:
    // written back, it pushes `/decks/7` and then `/decks` over the entry the reader just went
    // back to. So nothing is written while following.
    let following = false;
    const onPop = () => {
      following = true;
      try {
        apply(here());
      } finally {
        following = false;
      }
    };
    window.addEventListener("popstate", onPop);

    // **One press, one entry.** A press can take two writes to land — the wishlist's "open this
    // deck" calls `setActiveView("decks")` and then `setOpenDeckId(id)` — and the store passes
    // through a place between them that the reader never chose: the gallery, or whichever deck
    // was parked. Pushed, that is an entry Back would stop on. So the first move in a task pushes
    // and any later one in the same task rewrites that entry; a task is one press, and the flag is
    // dropped in a microtask, which runs before the next one can begin. Every write stays
    // synchronous: the URL is right by the time the press returns.
    let pushed = false;

    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (following) return;
      const moved =
        state.activeView !== previous.activeView || state.openDeckId !== previous.openDeckId;
      if (!moved && state.selectedCardId === previous.selectedCardId) return;

      // Whatever card the store holds *after* the change, so a move that closed one — and
      // `setActiveView` always does — is written without it.
      const href = placeHref(placeOf(state));
      // Equal when a change lands on the place the URL already names — writing then would add a
      // second entry for one place.
      if (href === window.location.pathname + window.location.search) return;

      if (moved && !pushed) {
        pushed = true;
        queueMicrotask(() => {
          pushed = false;
        });
        window.history.pushState(null, "", href);
      } else {
        // A later write of the same press — or the card alone, which is never an entry: opening
        // and closing one must not grow history, or Back would reopen a card the reader closed.
        window.history.replaceState(null, "", href);
      }
    });

    return () => {
      window.removeEventListener("popstate", onPop);
      unsubscribe();
    };
  }, []);
}
