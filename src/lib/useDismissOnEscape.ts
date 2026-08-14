import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Which rung of the dismissible stack a layer sits on.
 *
 * `"inner"` is anything opened *over* something else that Escape could also close — a
 * popup, a listbox, a menu. `"outer"` is what it was opened over: the card detail pane
 * today, and whatever else ends up docked beside a view.
 */
export type DismissLayer = "inner" | "outer";

/**
 * The capture-phase layers currently listening, innermost last.
 *
 * **The depth this hook's doc has always owed.** Two `window` capture listeners for one event
 * run in *registration* order, which was survivable while at most one `"inner"` layer was ever
 * open and stopped being survivable when a context menu became a thing that opens *over* an
 * already-open dialog.
 *
 * What that did instead of ordering them is worth stating exactly, because this hook's doc got
 * it wrong until now and the wrong version is the reassuring one. It did **not** close both:
 * the capture rung checks `defaultPrevented` as well, so the *first-registered* peer consumed
 * the press and the newer one — the thing the reader had just opened, the thing on top — was
 * starved. Measured on the pre-fix hook, 2026-08-14, dispatched both at `window` and at an
 * element so the listeners run in a true capture phase: `{ first: 1, second: 0 }` either way.
 * So a menu over a dialog would have closed the *dialog*, out from under the menu still on
 * screen.
 *
 * A token per registration rather than the callback itself: two layers may legitimately share
 * one `onDismiss` identity (a memoised close handed to a pair of popups), and a stack keyed on
 * the function would then pop the wrong one.
 *
 * Module-level and therefore shared across a test file's renders — `captureStack.length = 0` is
 * not needed in a teardown, because every entry is removed by its own effect cleanup.
 */
const captureStack: symbol[] = [];

/**
 * Escape closes one layer per press — and the protocol is a handshake, not a z-index.
 *
 * Both layers listen on `window`, so neither can see the other and neither can be ordered
 * by CSS. What separates them is the **phase**:
 *
 * * an `"inner"` layer listens in the **capture** phase and `preventDefault()`s the press;
 * * an `"outer"` layer listens in the **bubble** phase and returns early on
 *   `e.defaultPrevented`.
 *
 * Capture is the load-bearing half. Two `window` listeners for one event run in
 * *registration* order, and the outer layer is always the one mounted first — the pane has
 * been open since before the popup inside it existed. In the bubble phase it would
 * therefore act first and read `defaultPrevented` as false, closing the card *and* the
 * popup on one press, with two focus hand-backs racing for the caret. Capture puts the
 * innermost open thing first no matter who mounted when, because every capture listener on
 * `window` runs before the event has descended to its target, let alone bubbled back.
 *
 * `defaultPrevented` is checked by both rungs rather than only by the outer one: the rule
 * this encodes is "never act on a press something else has already consumed", and it is
 * true of a second popup as much as of a pane.
 *
 * **Two `"inner"` peers are ordered now, by a stack rather than by registration order.**
 * Every capture-phase layer pushes a token on mount and pops it on unmount, and only the
 * token on top acts. A lone `"inner"` layer is a stack of one and behaves exactly as it did.
 * This is what lets a context menu open over a dialog opened over the card pane and give one
 * press to each: menu, dialog, pane.
 *
 * The bubble rung is untouched. An `"outer"` layer still consults nothing but
 * `defaultPrevented`, which is all it needs — every capture listener runs before it.
 *
 * A layer that Escape dismissed hands focus back to whatever opened it — do that from
 * `onDismiss`, *before* React flushes the close, while the element is still mounted. An
 * outside-click deliberately does not, so that belongs to the caller and not here: the
 * reader who clicked elsewhere is already somewhere else.
 *
 * `onDismiss` is a dependency, so pass a stable function (`useCallback`) or the listener
 * re-registers on every render of the layer — and re-registering now also puts that layer
 * back on **top** of the capture stack, so an unstable callback on a layer something else
 * was opened over steals the next press from the thing above it.
 *
 * Pinned by `App.test.tsx`'s Escape-stack test and by this hook's own phase test. Every
 * new dismissible layer uses this, or it will close something it did not open.
 */
export function useDismissOnEscape({
  layer,
  onDismiss,
  enabled = true,
}: {
  layer: DismissLayer;
  onDismiss: () => void;
  /** Usually the layer's own "am I open" flag. An outer layer is open for as long as it exists. */
  enabled?: boolean;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const capture = layer === "inner";
    // Identity for this registration, minted per mount so two layers sharing one `onDismiss`
    // are still two entries.
    const token = Symbol("dismissLayer");
    if (capture) captureStack.push(token);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Only the innermost capture layer acts. An outer (bubble-phase) layer has no stack to
      // consult: `defaultPrevented` above is still what holds it off, exactly as before.
      if (capture && captureStack[captureStack.length - 1] !== token) return;
      e.preventDefault();
      onDismiss();
    };

    // The third argument is the whole contract — passed to both calls, because a listener
    // removed with the wrong phase is not removed at all.
    window.addEventListener("keydown", onKey, capture);
    return () => {
      window.removeEventListener("keydown", onKey, capture);
      const at = captureStack.lastIndexOf(token);
      if (at !== -1) captureStack.splice(at, 1);
    };
  }, [enabled, layer, onDismiss]);
}

/**
 * Stop the keys a *row* activates on, and nothing else — the other half of the protocol
 * above, for the controls that live inside a clickable row.
 *
 * Every row list in the app — the collection table, the search table, the wishlist — opens
 * the card on click and on Enter or Space. A control inside a row — a stepper, a quick-add
 * button, a remove button — must not open the card as well when it is used, so its cell
 * stops the press. Stopping the *whole* `keydown` does that and takes every other key with
 * it: React attaches one listener at the root, so a synthetic press that never reaches the
 * root never reaches `window` either, and [`useDismissOnEscape`] listens on `window`. The
 * card pane's Escape therefore stopped working for as long as the caret sat in one of those
 * controls — **measured live in the running app on 2026-08-06** — and it was invisible to
 * every suite here, because a test that fires Escape at the row rather than at the control
 * inside it never travels the path that is broken. All three lists had it; the count is not
 * in this sentence on purpose, because the next list will have it too unless it uses this.
 *
 * So: exactly the two keys the row acts on. Anything else is somebody else's press.
 */
export function stopRowActivationKeys(e: ReactKeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
}
