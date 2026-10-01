import { useMemo, useSyncExternalStore, type MouseEvent } from "react";
import { parsePlace, placeHref, type Place } from "../routes";

/**
 * The phone face's router: the URL is where the reader is, and the History API is how they move.
 *
 * Small and hand-written rather than a dependency, because it has three verbs and a link. What it
 * buys is the three things a phone needs and the desktop never did: Android's back gesture, a
 * browser's back button, and a link.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** A string, so `useSyncExternalStore` compares by value and a re-render costs no new object. */
const href = (): string => window.location.pathname + window.location.search;

/** The place a `pathname + search` string names. */
function placeAt(current: string): Place {
  const cut = current.indexOf("?");
  return cut === -1
    ? parsePlace(current, "")
    : parsePlace(current.slice(0, cut), current.slice(cut));
}

/** Whether `place` is where the reader already is — asked of the place, never of the string. */
const isHere = (place: Place): boolean => placeHref(place) === placeHref(placeAt(href()));

/**
 * What a history entry carries when **this router pushed it** — and so what says the entry
 * beneath it is one of the app's own.
 *
 * {@link back} reads it. An entry the reader arrived on — a link somebody sent, a bookmark, the
 * desktop face's own push before a resize — carries none, and a Back from there may leave the app.
 */
const PUSHED = { pushed: true } as const;

function pushedHere(state: unknown): boolean {
  return typeof state === "object" && state !== null && "pushed" in state && state.pushed === true;
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
 * is renamed, so neither does its mark.
 */
export function navigate(place: Place, { replace = false }: { replace?: boolean } = {}): void {
  if (isHere(place)) return;
  const next = placeHref(place);
  if (replace) window.history.replaceState(window.history.state, "", next);
  else window.history.pushState(PUSHED, "", next);
  for (const notify of listeners) notify();
}

/** A Back this router asked for and the browser has not made yet. */
let leaving = false;

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
 */
export function back(fallback: Place): void {
  if (leaving || isHere(fallback)) return;
  if (!pushedHere(window.history.state)) {
    navigate(fallback, { replace: true });
    return;
  }
  leaving = true;
  window.addEventListener(
    "popstate",
    () => {
      leaving = false;
    },
    { once: true },
  );
  window.history.back();
}

/**
 * What makes an `<a>` a link to `place` — spread onto one: `<a {...linkTo(place)}>`.
 *
 * **A real `href`, so the browser's own gestures work**: a middle click, "open in new tab",
 * "copy link", and a screen reader that says *link* for a control that changes the URL. The
 * router takes **only an unmodified primary click** — and only one nothing else has already
 * handled — and turns it into a {@link navigate}, which is the same destination without a document
 * load. Every other press is the browser's.
 */
export function linkTo(place: Place): {
  href: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
} {
  return {
    href: placeHref(place),
    onClick: (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(place);
    },
  };
}

export function usePlace(): Place {
  const current = useSyncExternalStore(subscribe, href, () => "/");
  return useMemo(() => placeAt(current), [current]);
}
