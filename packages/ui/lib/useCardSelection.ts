/**
 * One surface's view of the picked set — the seam between `multiSelect.ts`'s arithmetic and the
 * store slice that holds the answer.
 *
 * Every wall and every deck view takes this and nothing else: the algebra is not imported at a
 * call site and neither is the store field, so "what a Ctrl-click does" has exactly one spelling
 * in the app.
 *
 * ## What it prunes, and why on render
 *
 * A set outlives the list it was made in — a refetch lands, a filter narrows, a sibling surface
 * deletes a row — and what is left addresses cards that are not there. Pruning happens here, on
 * every render, against the order the caller is currently drawing. That is a `useMemo` over an
 * array the caller already has, and `pruneSelection` returns its argument unchanged when nothing
 * went missing, so a wall with nothing picked pays one `Set` construction and no re-render.
 *
 * **The pruned value is what the caller reads; the store is corrected in an effect.** Writing
 * during render is what React's lint refuses and what would loop here, since the write is a
 * re-render. Reading the pruned value directly is what makes that safe to defer: the drag, the
 * mark and the menu never see the stale keys even for the one commit before the effect runs.
 */
import { useCallback, useEffect, useMemo } from "react";
import {
  dragsWholeSelection,
  EMPTY_SELECTION,
  pruneSelection,
  readModifiers,
  type Selection,
} from "./multiSelect";
import { useAppStore } from "./store";

/**
 * The scope a surface that has **opted out** of multi-select passes.
 *
 * A hook cannot be called conditionally, so a wall with no `selectionScope` still calls
 * {@link useCardSelection} — with this. Nothing ever writes under it (the wall asks for its own
 * scope before it picks anything), so the set it reads is empty for the life of the app and every
 * such surface behaves exactly as it did before multi-select existed.
 *
 * The leading space is what makes that structural rather than a convention: every real scope is a
 * word or a `word:id`, and no surface can spell this one by accident.
 */
export const NO_SELECTION = " none";

/**
 * A `mousedown` handler that stops a Shift-click from dragging a text selection across everything
 * between the two presses.
 *
 * That is what Shift means in a browser, and on a wall of cards — or a column of 22px decklist
 * rows — it paints the surface blue from the anchor to the pointer for the whole gesture. Refusing
 * the default **only when Shift is held** leaves every other press untouched, so an ordinary drag
 * still begins exactly the way it does today.
 *
 * A free function rather than something the hook returns, because it reads no state at all and a
 * new identity per render would land in drag-registration dependency lists.
 */
export function suppressRangeSelection(event: { shiftKey: boolean; preventDefault: () => void }) {
  if (event.shiftKey) event.preventDefault();
}

/** What a surface gets back. Everything is stable across renders except {@link CardSelectionApi.keys}
 *  and the counts derived from it, which change exactly when the set does. */
export interface CardSelectionApi {
  /** Whether this key wears the mark. */
  selected: (key: string) => boolean;
  /** The picked keys, in the order the reader picked them, pruned to what is on the surface. */
  keys: string[];
  /** `keys.length`, for the count chip and the plural labels. */
  count: number;
  /**
   * A press on a card. Returns **whether the press was a selection gesture** — `true` when a
   * chord was held and the caller should do nothing else, `false` for a plain click, which has
   * already collapsed the set to this one card and leaves the caller to do what it always did
   * (open the detail pane).
   *
   * That return is the whole contract with the four deck views and the wall: none of them
   * branches on modifiers itself, so none of them can disagree about which chords mean what.
   */
  pick: (key: string, event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => boolean;
  /**
   * Whether a drag started on this key carries the whole set — and, when it does not, the
   * collapse that makes the drag honest.
   *
   * Call it at `dragstart`. `false` means the reader picked up a card that was not in the set, so
   * the set has been thrown away and the drag carries one card; `true` means the group travels.
   * A set of one answers `false` and is not a group — see `dragsWholeSelection`.
   */
  dragsAll: (key: string) => boolean;
  /** Throw the set away — Escape, and a surface that has finished with it. */
  clear: () => void;
}

/**
 * The picked set for one surface.
 *
 * `scope` names the surface (`deck:12`, `search`, `collection`, …) and is what makes a set made
 * on one wall invisible to every other. `order` is the keys the surface is drawing, in reading
 * order; it is read for Shift ranges and for pruning, so a caller must hold it still (a `useMemo`
 * over the rows it already has) rather than rebuilding it per render.
 */
export function useCardSelection(scope: string, order: readonly string[]): CardSelectionApi {
  const held = useAppStore((s) => s.cardSelection);
  const pickCard = useAppStore((s) => s.pickCard);
  const setCardSelection = useAppStore((s) => s.setCardSelection);

  /** The set as this surface may act on it: empty unless the store's is ours, then pruned. */
  const mine: Selection = useMemo(() => {
    if (held === null || held.scope !== scope) return EMPTY_SELECTION;
    return pruneSelection(held, order);
  }, [held, scope, order]);

  // The correction, one commit behind what the caller already sees. `held === mine` is the
  // identity `pruneSelection` promises when nothing went missing, so the ordinary render writes
  // nothing at all and this effect is a no-op with no dependency on what it would write.
  useEffect(() => {
    if (held === null || held.scope !== scope) return;
    if (held === mine) return;
    setCardSelection({ scope, ...mine });
  }, [held, mine, scope, setCardSelection]);

  const keys = mine.keys;
  const selected = useCallback((key: string) => keys.includes(key), [keys]);

  const pick = useCallback(
    (key: string, event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => {
      const mods = readModifiers(event);
      pickCard(scope, key, order, mods);
      return mods.toggle || mods.range;
    },
    [pickCard, scope, order],
  );

  const dragsAll = useCallback(
    (key: string) => {
      if (dragsWholeSelection(mine, key)) return true;
      // A card picked up from outside the set takes the set with it — thrown away rather than
      // extended, so a stray drag can never rearrange four cards the reader had forgotten were
      // picked. Only written when there is something to throw away, or every single-card drag in
      // the app would be a store write and a re-render mid-gesture.
      if (keys.length > 0) setCardSelection(null);
      return false;
    },
    [mine, keys.length, setCardSelection],
  );

  const clear = useCallback(() => {
    if (keys.length > 0) setCardSelection(null);
  }, [keys.length, setCardSelection]);

  return { selected, keys, count: keys.length, pick, dragsAll, clear };
}
