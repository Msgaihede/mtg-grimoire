import { useEffect, useState } from "react";
import { isLightView, LIGHT_START } from "@/lib/edition";
import { useAppStore } from "@/lib/store";
import { isOverlaid, isPushed, OVERLAID, parsePlace, placeHref, type Place } from "./routes";

type DesktopWhere = Pick<
  ReturnType<typeof useAppStore.getState>,
  "activeView" | "openDeckId" | "selectedCardId"
>;

/** Where the desktop store says the reader is, as a {@link Place}: the view, the deck open in
 *  it, and the card open over it. A view the light edition does not draw reads as the start view
 *  — the URL has no word for one — though the adapter never lets the store rest on one: see
 *  `refuse` below. */
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
 * Write the URL — as a new entry, or over the one the reader is on — and survive a refusal.
 *
 * **A history write can throw, and this one is called from inside the store's own `set`.**
 * Browsers ration the History API: past some rate a call is dropped or throws a `SecurityError`,
 * and the card modal steps through cards on a held arrow key with one write per step. A throw
 * here comes out of the store's bare loop over its listeners, so every subscriber registered
 * after this adapter would miss that change — a stale address bar turned into a stale app. So a
 * refused write is swallowed: the URL is one step behind, and the next write the browser accepts
 * puts it right.
 *
 * **It answers whether the browser took the write, read off the address rather than off the
 * `catch`**: one browser throws on a rationed call and another drops it without a word, and the
 * only thing both leave behind is an address that did not move. A refused *replace* costs a
 * stale URL and nothing else; a refused *push* costs an entry, which is what the answer is for —
 * see `owed` below.
 */
function write(how: "push" | "replace", href: string, state: unknown = null): boolean {
  try {
    if (how === "push") window.history.pushState(state, "", href);
    else window.history.replaceState(state, "", href);
  } catch {
    // Refused. Nothing to report — the caller is told below, like a call that was dropped.
  }
  return placeHref(here()) === href;
}

/**
 * The state a replace leaves on the entry, by the vocabulary `routes.ts` defines.
 *
 * **A card opened onto an entry marks it `OVERLAID`**: the card is over the page this entry
 * already was, so the phone face — if a resize hands it this entry — knows nothing of its own is
 * beneath and splits it before drawing the sheet (`phone/router.ts`'s `adoptOverlay`). Without the
 * mark it could not tell this card from one a reader arrived on by a link.
 *
 * **A step from one card to another keeps whatever the entry carried**, the phone router's mark
 * included: what is beneath an entry does not change when its card does. **A card closed off an
 * overlaid entry drops the mark**, which was about the card. Anything else is kept as it was.
 */
function stateFor(current: unknown, hadCard: boolean, hasCard: boolean): unknown {
  if (hasCard) return hadCard ? current : OVERLAID;
  return isOverlaid(current) ? null : current;
}

/**
 * Keeps the desktop face's store and the URL saying the same thing.
 *
 * The desktop UI has no router: where the reader is, is three fields of its store —
 * `activeView`, `openDeckId` and `selectedCardId`. A browser needs a URL — for Back, for a link,
 * and so that crossing the 1024px floor lands on the same destination, with the same card open,
 * in the other face. This is the one adapter between the two, and it lives in the light entry so
 * that no router enters `packages/ui/`.
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

    // **A push the browser refused is still owed.** Swallowed like a refused replace, it cost
    // more than a stale URL: the entry was never made, so the browser is still standing on the
    // place the reader left — and the next write, a card opened over the new page, was a replace
    // that renamed *that* entry. The page they had left was gone from the path Back walks. So
    // while a push is owed, the next write is made as the push, whatever kind it would have
    // been: the entry the store's place deserves is made late rather than never. The debt ends
    // when the browser takes one, when the store comes back to the place the URL still names,
    // or when the reader traverses — the browser has moved, and the store follows it.
    let owed = false;

    const onPop = () => {
      owed = false;
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
    //
    // **A task here is a run of synchronous code, whoever started it.** Two writes back to back
    // are one task whether they came from one press or from a script, so a test body — or a CDP
    // script evaluated in one go — that makes two "presses" in a row is one task, and the second
    // is replaced rather than pushed. A real second press always arrives after a microtask
    // checkpoint, and gets its own entry.
    let pushed = false;

    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (following) return;

      // **The light app never stands on a view its edition does not draw.** The desktop's pages
      // can still ask for one — the collection's way into a shared binder is the one such press
      // today, and the shell hides it (`useReaches`) — and the URL has no word for it: written,
      // the address bar said `/search` over a binder no rail row lit, and a reload, a resize or
      // Forward landed on Search. So the press is refused rather than spelled: the store goes
      // back to the place the URL still names, and history is not touched.
      if (!isLightView(state.activeView)) {
        // The store is going back to the URL's place, so nothing is owed for where it was.
        owed = false;
        following = true;
        try {
          apply(here());
        } finally {
          following = false;
        }
        return;
      }

      const moved =
        state.activeView !== previous.activeView || state.openDeckId !== previous.openDeckId;
      if (!moved && state.selectedCardId === previous.selectedCardId) return;

      // Whatever card the store holds *after* the change, so a move that closed one — and
      // `setActiveView` always does — is written without it.
      const next = placeOf(state);
      const href = placeHref(next);
      // Equal when a change lands on the place the URL already names — writing then would add a
      // second entry for one place.
      if (href === window.location.pathname + window.location.search) {
        owed = false;
        return;
      }

      if (moved && !pushed) {
        pushed = true;
        queueMicrotask(() => {
          pushed = false;
        });
        owed = !write("push", href);
        return;
      }

      // The entry the browser is on is the one the reader left, so nothing below — which reads
      // that entry's card and its mark — is about the place being written. A card carried on the
      // late push is over a page with no entry of its own, which is what `OVERLAID` says.
      if (owed) {
        owed = !write("push", href, next.cardId !== null ? OVERLAID : null);
        return;
      }

      const current = here();
      const entry: unknown = window.history.state;
      // **A card the phone face pushed is closed by going back to the entry beneath it.** That
      // entry is this same page — `routes.ts`'s `PUSHED` promises it — so a replace here would
      // leave two entries for one place, and the reader's next Back would show nothing at all.
      // The `popstate` that lands is followed like any other, and finds the store already there.
      if (
        next.cardId === null &&
        current.cardId !== null &&
        isPushed(entry) &&
        placeHref({ ...current, cardId: null }) === href
      ) {
        try {
          window.history.back();
        } catch {
          write("replace", href, entry);
        }
        return;
      }

      // A later write of the same press — or the card alone, which is never an entry: opening
      // and closing one must not grow history, or Back would reopen a card the reader closed.
      write("replace", href, stateFor(entry, current.cardId !== null, next.cardId !== null));
    });

    return () => {
      window.removeEventListener("popstate", onPop);
      unsubscribe();
    };
  }, []);
}
