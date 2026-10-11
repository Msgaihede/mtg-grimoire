/**
 * Ctrl+A, and which wall it is for — issue #910.
 *
 * The chord is bound **once on `window`** rather than once per wall, because a reader presses it
 * from wherever the caret happens to be: on a tile, on a filter chip, or on nothing at all after a
 * click on the page's felt. A handler on the wall's own box hears only the first of those.
 *
 * One listener then has a question no single wall can answer: **two walls can be on screen at
 * once** — the collection and the search column docked beside it, the wishlist and its own — and
 * the store holds one picked set. So every wall that takes the chord registers here, and the press
 * goes to at most one of them: {@link nearestSurface}.
 *
 * **A page's own wall answers from anywhere on its page; a docked column's answers only from
 * inside the column** ({@link SEARCH_DOCK_ATTR}). The column is a tool beside the thing the reader
 * is working on, so a chord pressed over the deck, or over the collection's table, is not about
 * it — and taking it there would throw away the set the reader had picked on their own list to
 * select a catalogue search they were not looking at.
 *
 * `features/search` rather than `lib`, beside `CardGrid`, which is the one thing that registers.
 */
import { isTextField } from "@/components/menu/useContextMenu";
import { matchesShortcut, shortcut } from "@/lib/shortcuts";

/**
 * The chord, looked up once at module scope — `AppShell`'s arrangement and `useDeckKeyboard`'s,
 * for their reason: `shortcut()` throws on an id the catalogue does not carry, and at import that
 * is a red suite rather than a key that quietly stopped working.
 */
const SELECT_ALL = shortcut("global", "selectAll");

/**
 * What a docked search column's root wears — `CardSearchPanel`'s `<section>` — so a wall inside one
 * can be told from a page's own. Declared here because this file is the one that reads it.
 */
export const SEARCH_DOCK_ATTR = "data-search-dock";

/** A surface Ctrl+A can pick the whole of. */
export interface SelectAllSurface {
  /** The surface's own box, or `null` while it is not drawn. Read at the press, never held. */
  element: () => Element | null;
  /** Pick everything on it. */
  selectAll: () => void;
}

const surfaces = new Set<SelectAllSurface>();

/**
 * The last thing the reader pressed or put the caret on — what says which wall they are working
 * in, and a better witness than the caret itself, which a click on anything unfocusable hands to
 * `<body>` or to the view's own landing pad.
 *
 * **And the wall it was about, decided at the touch**, because the element does not last: these
 * walls are virtualised, so the tile a reader Ctrl-clicked is unmounted by the next scroll, and a
 * filter pill is unmounted by the press that removes it. A detached element shares an ancestor
 * with nothing, so read alone it sent the chord to the page's wall from inside the column.
 */
let touched: { element: Element; surface: SelectAllSurface | null } | null = null;

/** Whether a surface is on screen: in the document, and not inside something `hidden` — a docked
 *  column railed for want of room keeps its wall mounted under that attribute. */
function drawn(box: Element | null): box is Element {
  return box !== null && box.isConnected && box.closest("[hidden]") === null;
}

/** Whether a press at `from` can be about this surface at all — see the module doc. */
function inReach(box: Element, from: Element | null): boolean {
  const dock = box.closest(`[${SEARCH_DOCK_ATTR}]`);
  return dock === null || (from !== null && dock.contains(from));
}

/**
 * Which of several surfaces a press made at `from` is about: **the one that shares the nearest
 * ancestor with it**.
 *
 * That is "the wall the reader is working in" without anything having to say where a wall's
 * territory ends. A press on a docked column's own filter row shares the column with the column's
 * wall and only the page with the page's; a press on the page's toolbar is the other way round;
 * and a press inside a wall shares the wall itself, which nothing else can beat.
 *
 * **A tie goes to the surface that comes first in the document**, and so does a press from
 * nowhere (`null`, or an element that has since left the page).
 *
 * Only among the surfaces the press can reach: one that is not drawn is skipped, and so is a
 * docked column's wall for a press outside the column. `null` when that leaves nothing.
 *
 * Generic over the candidate so the rule can be checked as arithmetic over a DOM tree, with no
 * listener and no selection behind it.
 */
export function nearestSurface<S extends Pick<SelectAllSurface, "element">>(
  from: Element | null,
  candidates: Iterable<S>,
): S | null {
  let best: { surface: S; box: Element; steps: number } | null = null;
  for (const surface of candidates) {
    const box = surface.element();
    if (!drawn(box) || !inReach(box, from)) continue;
    const steps = stepsToShared(from, box);
    if (
      best === null ||
      steps < best.steps ||
      (steps === best.steps && precedes(box, best.box))
    ) {
      best = { surface, box, steps };
    }
  }
  return best?.surface ?? null;
}

/** How far up from `from` the first element that also holds `box` is — `Infinity` for none. */
function stepsToShared(from: Element | null, box: Element): number {
  let steps = 0;
  for (let at = from; at !== null; at = at.parentElement) {
    if (at.contains(box)) return steps;
    steps += 1;
  }
  return Infinity;
}

function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * A press or a caret move, noted.
 *
 * **A caret that lands on something *around* the last press is not news.** Pressing a heading, a
 * gap or a card's chin focuses nothing itself, so the browser hands the caret to the nearest
 * focusable ancestor — `<body>`, or a view's `tabIndex={-1}` landing pad, which the deck editor's
 * root is. That `focusin` arrives after the press and says less than it did: read as the latest
 * touch, a press inside the docked column became "the caret is on the editor", which is outside
 * the column. Seen in Storybook on 2026-10-11: with the caret on the editor's root, nothing pressed
 * in the column could reach the column's wall.
 */
function onTouch(event: Event) {
  const element = event.target instanceof Element ? event.target : null;
  if (element === null) return;
  if (event.type === "focusin" && touched !== null && element.contains(touched.element)) return;
  touched = { element, surface: nearestSurface(element, surfaces) };
}

/**
 * The surface a press is about: what the last touch says now; or, when the element touched has
 * left the page, what it said then, if that wall is still up; or, with no touch on record — the
 * wall was drawn after the reader last moved — where the caret is.
 */
function target(caret: Element | null): SelectAllSurface | null {
  if (touched !== null) {
    if (touched.element.isConnected) return nearestSurface(touched.element, surfaces);
    const { surface } = touched;
    if (surface !== null && surfaces.has(surface) && drawn(surface.element())) return surface;
  }
  return nearestSurface(caret, surfaces);
}

/**
 * The press itself.
 *
 * **The match runs first and everything else second** — `useDeckKeyboard`'s order, for its reason:
 * this hears every key typed anywhere in the app, and matching a chord is arithmetic over an event.
 *
 * Three things keep the press, each for a failure:
 *
 * - **Something nearer that already took it** (`defaultPrevented`), which is this app's handshake
 *   for "that press was mine".
 * - **A text field.** Ctrl+A there selects the text, which is what the reader's hands mean by it
 *   in a search box — and every one of these pages has a search box. `isTextField` is
 *   `useContextMenu`'s, the predicate the deck editor's undo already yields on.
 * - **A modal.** The walls are behind its scrim, and a chord that reached past it would act on a
 *   surface the reader cannot see — `useDeckKeyboard`'s Delete carries the same fence (issue #553).
 *
 * `preventDefault` is not only tidiness: the browser's own Ctrl+A selects every piece of text on
 * the page, which paints the whole window blue.
 *
 * **A held key picks once.** Auto-repeat re-sends the chord at the keyboard's repeat rate, and
 * every one would be a store write over a set as long as the list; the repeat is still swallowed
 * so the browser's select-all does not get through on the second one.
 */
function onKeyDown(event: KeyboardEvent) {
  if (!matchesShortcut(SELECT_ALL, event) || event.defaultPrevented) return;
  if (isTextField(event.target)) return;
  if (document.querySelector('[aria-modal="true"]') !== null) return;
  // A caret on `<body>` is a caret nowhere.
  const caret =
    event.target instanceof Element && event.target !== document.body ? event.target : null;
  const surface = target(caret);
  // No wall this press is about — the deck's own cards, a table — and the chord stays the
  // browser's, as it is on a view with no wall at all.
  if (surface === null) return;
  event.preventDefault();
  if (!event.repeat) surface.selectAll();
}

/**
 * Put a surface up for Ctrl+A; the returned function takes it down again.
 *
 * The listeners are on `window` for exactly as long as something is registered, so a view with no
 * wall on it keeps the browser's own Ctrl+A and pays for none of this.
 */
export function registerSelectAll(surface: SelectAllSurface): () => void {
  if (surfaces.size === 0) {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onTouch, true);
    window.addEventListener("focusin", onTouch, true);
  }
  surfaces.add(surface);
  return () => {
    surfaces.delete(surface);
    if (surfaces.size > 0) return;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("pointerdown", onTouch, true);
    window.removeEventListener("focusin", onTouch, true);
    // Nothing left to choose between, and holding the element would hold its whole detached tree.
    touched = null;
  };
}
