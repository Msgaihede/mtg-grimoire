import { useEffect } from "react";

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
