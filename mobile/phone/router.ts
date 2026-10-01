import { useMemo, useSyncExternalStore } from "react";
import { parsePlace, placeHref, type Place } from "../routes";

/**
 * The phone face's router: the URL is where the reader is, and the History API is how they move.
 *
 * Small and hand-written rather than a dependency, because it has two verbs. What it buys is the
 * three things a phone needs and the desktop never did: Android's back gesture, a browser's back
 * button, and a link.
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

/**
 * Go somewhere. A push by default, so Back undoes it — including closing a card, which is a
 * place like any other; `replace` for a correction the reader did not make.
 *
 * **Nothing happens for the place the reader is already on, and that is asked of the place
 * rather than of the string.** `/` names the start view without spelling it, and it is where a
 * cold start lands: compared as text, a press on the tab that is already lit pushed `/search`
 * over it, and the next Back undid nothing the reader could see.
 */
export function navigate(place: Place, { replace = false }: { replace?: boolean } = {}): void {
  const next = placeHref(place);
  if (next === placeHref(placeAt(href()))) return;
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
  for (const notify of listeners) notify();
}

export function usePlace(): Place {
  const current = useSyncExternalStore(subscribe, href, () => "/");
  return useMemo(() => placeAt(current), [current]);
}
