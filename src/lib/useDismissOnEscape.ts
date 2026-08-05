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
 * **This does not generalise to two `"inner"` peers.** The protocol orders exactly two
 * rungs — one capture-phase layer and one bubble-phase layer — so two popups open at once
 * are not ordered by it at all: both would consume the same press and both would close. If
 * a third layer is ever needed, nest it deliberately (the inner one owns the press, the
 * middle one checks `defaultPrevented` before acting) or extend this hook with a depth,
 * rather than adding a second `"inner"` and hoping registration order holds.
 *
 * A layer that Escape dismissed hands focus back to whatever opened it — do that from
 * `onDismiss`, *before* React flushes the close, while the element is still mounted. An
 * outside-click deliberately does not, so that belongs to the caller and not here: the
 * reader who clicked elsewhere is already somewhere else.
 *
 * `onDismiss` is a dependency, so pass a stable function (`useCallback`) or the listener
 * re-registers on every render of the layer.
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onDismiss();
    };
    // The third argument is the whole contract — passed to both calls, because a listener
    // removed with the wrong phase is not removed at all.
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
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
