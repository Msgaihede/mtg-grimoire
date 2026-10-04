import { useMemo, useSyncExternalStore, type MouseEvent } from "react";
import { isOverlaid, isPushed, parsePlace, placeHref, PUSHED, type Place } from "../routes";

/**
 * The phone face's router: the URL is where the reader is, and the History API is how they move.
 *
 * Small and hand-written rather than a dependency, because it has three verbs and a link. What it
 * buys is the three things a phone needs and the desktop never did: Android's back gesture, a
 * browser's back button, and a link.
 */
const listeners = new Set<() => void>();

/**
 * Where the reader is when the browser would not write it down — a `pathname + search`, or
 * `null` while the address bar is the truth, which is nearly always.
 *
 * **A browser rations the History API.** Past some rate a write is refused: one browser throws a
 * `SecurityError`, another logs a line and drops the call. Either way the address did not move,
 * and a router that reads only the address would leave the reader on the page they pressed away
 * from — a tab that does not change, a card that does not open — with nothing to say why.
 *
 * **So the place is held here rather than written with whatever the browser will still take.**
 * Falling back to a replace is the other answer, and it is wrong twice. The ration is one counter
 * for both verbs, so the replace is refused by whatever refused the push. And where it is taken,
 * it renames the entry the reader is standing on: the page beneath an open card becomes the card,
 * the page is gone from the path Back walks, and an entry carrying this router's mark promises a
 * page beneath it that is no longer there (`routes.ts`'s `PUSHED`). Held, history is exactly what
 * the browser has — one entry short — the screen is what the reader asked for, and the next write
 * the browser accepts, or the next Back, puts the two in step again.
 */
let held: string | null = null;

/** What the address bar says, whatever the router holds. */
const actual = (): string => window.location.pathname + window.location.search;

// **A traversal ends a hold**: the browser has moved, and where it landed is where the reader is.
// Registered once, here, ahead of every subscriber's own listener — a `popstate` reaches listeners
// in the order they were added, so each snapshot read after it finds the hold already gone.
window.addEventListener("popstate", () => {
  held = null;
});

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** A string, so `useSyncExternalStore` compares by value and a re-render costs no new object. */
const href = (): string => held ?? actual();

/** The place a `pathname + search` string names. */
function placeAt(current: string): Place {
  const cut = current.indexOf("?");
  return cut === -1
    ? parsePlace(current, "")
    : parsePlace(current.slice(0, cut), current.slice(cut));
}

/** Whether `place` is where the reader already is — asked of the place, never of the string. */
const isHere = (place: Place): boolean => placeHref(place) === placeHref(placeAt(href()));

/** Whether the entry the browser is on names `next` — by the place again, not the spelling. */
const landed = (next: string): boolean => placeHref(placeAt(actual())) === placeHref(placeAt(next));

/**
 * Write `next` into history, and **hold it if the browser did not**.
 *
 * A refusal is read off the address rather than off the `catch` alone: a dropped call throws
 * nothing, and the only thing that says a write happened is the address having moved.
 */
function write(how: "push" | "replace", next: string): void {
  try {
    if (how === "push") window.history.pushState(PUSHED, "", next);
    else window.history.replaceState(window.history.state, "", next);
  } catch {
    // Refused out loud. What follows is the same as for a refusal that said nothing.
  }
  held = landed(next) ? null : next;
}

/**
 * Go somewhere. A push by default, so Back undoes it — opening a card is one, which is what lets
 * Android's back gesture close the sheet; `replace` for a correction the reader did not make.
 * Closing what a push opened is {@link back}, not a second push.
 *
 * **Nothing happens for the place the reader is already on, and that is asked of the place
 * rather than of the string.** `/` names the start view without spelling it, and it is where a
 * cold start lands: compared as text, a press on the tab that is already lit pushed `/search`
 * over it, and the next Back undid nothing the reader could see.
 *
 * A replace keeps the entry's own state: what is beneath an entry does not change when the entry
 * is renamed, so neither does its mark ({@link PUSHED}, in `routes.ts` because the desktop face
 * reads it too).
 *
 * **A write the browser refuses does not strand the reader** ({@link held}): the place is kept,
 * the listeners are told, and the page draws it. Two moves then write nothing at all. A move to
 * the place the browser's own entry names ends the hold — the address is true again. And a
 * *replace* while holding only moves the hold: the place on screen has no entry of its own, so
 * the entry a replace would rename is the one beneath it.
 */
export function navigate(place: Place, { replace = false }: { replace?: boolean } = {}): void {
  if (isHere(place)) return;
  const next = placeHref(place);
  if (landed(next)) held = null;
  else if (held !== null && replace) held = next;
  else write(replace ? "replace" : "push", next);
  for (const notify of listeners) notify();
}

/**
 * Make a card the desktop face opened into one of this router's own — called once, as the phone
 * face mounts.
 *
 * **The desktop face writes a card onto the entry it was opened over** (a modal over a page is not
 * a place there), and marks it `OVERLAID` (`routes.ts`). Carried across the floor by a resize, that card
 * is a sheet with nothing of this router's beneath it: {@link back} would rename it in place, so
 * ✕ and Escape closed it while Android's back gesture — the one a phone reader uses — left the
 * page beneath instead. So the entry is split into the two a press here would have made: the page,
 * renamed in place, and the card, pushed over it with this router's mark. The address bar does not
 * move, and Back now closes the sheet.
 *
 * **Only a desktop overlay, never an unmarked card.** A reader who arrived on `…?card=x` from a
 * link has nothing of the app's beneath them, and {@link back}'s rule for that entry stands.
 *
 * Idempotent — the split entry carries {@link PUSHED}, which is not an overlay — so StrictMode's
 * second call does nothing. A refused write puts the entry back as it was.
 */
export function adoptOverlay(): void {
  const state: unknown = window.history.state;
  if (!isOverlaid(state)) return;
  // The browser's own entry, not a place this router is holding: it is the entry that is split.
  const place = placeAt(actual());
  if (place.cardId === null) return;
  const card = placeHref(place);
  try {
    window.history.replaceState(null, "", placeHref({ ...place, cardId: null }));
    window.history.pushState(PUSHED, "", card);
  } catch {
    try {
      window.history.replaceState(state, "", card);
    } catch {
      // Refused again: the entry may now name the page, and the sheet closes. A card the reader
      // can open again is the whole of the cost.
    }
  }
}

/** A Back this router asked for and the browser has not made yet. */
let leaving = false;

/**
 * How long a Back may take to land before the router stops waiting for it.
 *
 * A traversal the page asks for arrives as a `popstate` a task or two later, so half a second is
 * not a deadline a working Back comes near. It bounds the one that never lands: a browser may
 * drop `history.back()` under the ration it applies to every history call, and says nothing when
 * it does.
 */
export const BACK_WAIT_MS = 500;

/**
 * Leave what a push opened, for `fallback` — the place the reader should be left on.
 *
 * **A Back where the entry beneath is the app's own, and a replace where it is not.** Closing a
 * card by pushing again left the card one Back beneath the page it was closed over, so the
 * gesture a reader uses to leave the page reopened it instead. A Back takes the entry off the
 * path the reader walks. But a reader who arrived *on* `…?card=x` has nothing of this router's
 * beneath them, and a Back there leaves the app — so that entry is renamed in place.
 *
 * **One press, one Back.** A traversal is a task of its own: until it lands the current entry is
 * still the marked one, and a second press on the same ✕ would go back twice. And a sheet that is
 * fading out is still pressable after it has closed, which is why a call for the place the reader
 * is already on does nothing at all.
 *
 * **The wait for that Back is bounded** ({@link BACK_WAIT_MS}). Its only release used to be the
 * `popstate`, so a `history.back()` the browser dropped left every later ✕ and Escape inert — a
 * sheet nothing could close. When the time is up and the reader is still where they pressed, the
 * entry is renamed instead: the close a linked card gets, at the cost a rename has here — the
 * page is then two entries, and one Back shows nothing new — rather than no close at all. A Back
 * that lands late after that lands on the page beneath, which is the same page.
 *
 * **A place this router is holding has no entry to go back from** ({@link held}), so leaving it
 * is forgetting it — unless the browser's own entry is a pushed card over that same fallback (a
 * step to another printing was the write refused), where the real Back is still the right close.
 */
export function back(fallback: Place): void {
  if (leaving || isHere(fallback)) return;
  const entry = placeAt(actual());
  const beneath =
    isPushed(window.history.state) &&
    (held === null ||
      (entry.cardId !== null && placeHref({ ...entry, cardId: null }) === placeHref(fallback)));
  if (!beneath) {
    navigate(fallback, { replace: true });
    return;
  }

  const from = href();
  leaving = true;
  const release = (): void => {
    leaving = false;
    clearTimeout(timer);
    window.removeEventListener("popstate", release);
  };
  window.addEventListener("popstate", release);
  const timer = setTimeout(() => {
    release();
    // Only for a reader still where they pressed: anything else has moved them since.
    if (href() === from) navigate(fallback, { replace: true });
  }, BACK_WAIT_MS);
  try {
    window.history.back();
  } catch {
    release();
    navigate(fallback, { replace: true });
  }
}

/**
 * What makes an `<a>` a link to `place` — spread onto one: `<a {...linkTo(place)}>`.
 *
 * **A real `href`, so the browser's own gestures work**: a middle click, "open in new tab",
 * "copy link", and a screen reader that says *link* for a control that changes the URL. The
 * router takes **only an unmodified primary click** — and only one nothing else has already
 * handled — and turns it into a {@link navigate}, which is the same destination without a document
 * load. Every other press is the browser's.
 *
 * **`replace` is for a link that moves the reader within one place rather than to another** — the
 * card sheet's printings, where a press swaps the open card for another printing of it. Pushed,
 * each would be a Back step, and the gesture a reader uses to close the sheet would walk them back
 * through every printing they had looked at first. Replaced, the sheet is still one entry, and
 * that entry keeps the mark {@link back} reads, so the ✕ still leaves by a real Back. A modified
 * press is still the browser's either way: a new tab has no history to replace.
 */
export function linkTo(
  place: Place,
  { replace = false }: { replace?: boolean } = {},
): {
  href: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
} {
  return {
    href: placeHref(place),
    onClick: (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(place, { replace });
    },
  };
}

export function usePlace(): Place {
  const current = useSyncExternalStore(subscribe, href, () => "/");
  return useMemo(() => placeAt(current), [current]);
}
