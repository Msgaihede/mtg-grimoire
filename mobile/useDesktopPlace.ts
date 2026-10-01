import { useEffect, useState } from "react";
import { isLightView, LIGHT_START } from "@/lib/edition";
import { useAppStore } from "@/lib/store";
import { parsePlace, placeHref, type Place } from "./routes";

type DesktopWhere = Pick<ReturnType<typeof useAppStore.getState>, "activeView" | "openDeckId">;

/** Where the desktop store says the reader is, as a {@link Place}. A view the light edition does
 *  not draw — a shared binder, reached from the collection — reads as the start view: the URL
 *  has no word for it. */
function placeOf(where: DesktopWhere): Place {
  const view = isLightView(where.activeView) ? where.activeView : LIGHT_START;
  return { view, deckId: view === "decks" ? where.openDeckId : null, cardId: null };
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
}

/**
 * Keeps the desktop face's store and the URL saying the same thing.
 *
 * The desktop UI has no router: where the reader is, is `activeView` and `openDeckId` in its
 * store. A browser needs a URL — for Back, for a link, and so that crossing the 1024px floor
 * lands on the same destination in the other face. This is the one adapter between the two, and
 * it lives in the light entry so that no router enters `src/`.
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
    // True while the store is being moved *to* the URL. `apply` may take two writes to get there
    // — entering Decks hands back a parked deck before the URL's own answer replaces it — and the
    // place between them is one the URL never named: written back, it pushes `/decks/7` and then
    // `/decks` over the entry the reader just went back to. So nothing is written while following.
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

    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (following) return;
      if (state.activeView === previous.activeView && state.openDeckId === previous.openDeckId) {
        return;
      }
      const href = placeHref(placeOf(state));
      // Equal when a press lands on the place the URL already names — pushing then would add a
      // second entry for one place.
      if (href !== window.location.pathname + window.location.search) {
        window.history.pushState(null, "", href);
      }
    });

    return () => {
      window.removeEventListener("popstate", onPop);
      unsubscribe();
    };
  }, []);
}
