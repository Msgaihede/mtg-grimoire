import { DOCKED_BAR_CLEARANCE_PX, DOCKED_BAR_HEIGHT_PX } from "./dockedBar";
import { useScrollPaddingTop } from "./useScrollPaddingTop";
import { useUndocked } from "./useUndocked";

export interface FilterQuickBarState {
  /** The page's filter row has scrolled above `main`'s top, and the page is in grid view. */
  shown: boolean;
  /** `top` for a `sticky` column beside the wall (a docked search column, the Tags rail). */
  dockTop: number;
  /** Added to a wall's sticky shelf bar so it pins flush under the quick bar. */
  stickyTop: number;
}

/**
 * Whether a card wall's filter quick bar is down, and how far the page's other sticky things have
 * to stand below it (spec 2026-09-29, §2 and §3).
 *
 * **`row` is the whole `FilterBar` block, its root `div`**, not its first line: the row, the open
 * tray, the "Filtering by" line and `TagQueryRow`. The bar comes down only once the *bottom* of
 * that block is at or above the scroller's top, and goes the moment any of it is back — so an open
 * tray on the page row keeps the quick bar away rather than drawing two sets of the same controls
 * one above the other. `useUndocked` answers that crossing with an `IntersectionObserver` and
 * re-renders only when it flips, never per scroll event. It is held in state by the caller through
 * a callback ref, which is what lets the observer be rebuilt when the block remounts.
 *
 * **Grid only, which is `enabled`.** A table view scrolls in its own box rather than in `main`
 * (the three virtualised tables are each their own scrollport), so its filter row never leaves
 * `main` and the question has no answer there; asked anyway, it would draw a bar over a page whose
 * row is still on screen. Disabled, the hook hands `useUndocked` no element, builds no observer,
 * and answers hidden with no clearance — the same answer as jsdom, whose stub observer never fires.
 *
 * **While the bar is down `main` carries `scroll-padding-top`** (§8, WCAG 2.4.11), through
 * `useScrollPaddingTop` — the deck editor's effect, shared. The numbers are the deck bar's, from
 * `lib/dockedBar`, so the two bars cannot come to disagree: `dockTop` is
 * {@link DOCKED_BAR_CLEARANCE_PX} (41, a neighbour standing the bar's gap below its foot) and
 * `stickyTop` is {@link DOCKED_BAR_HEIGHT_PX} (53, a shelf bar pinned flush under it). Both are 0
 * while the bar is up — a clearance held open under a bar that is not drawn is a strip of page
 * nobody can use.
 *
 * **A changed search starts the wall at its top** — `CardGrid`'s `listKey` reset — so a chip
 * pressed in the quick bar scrolls the page row back into view and this answers hidden on the next
 * crossing: the reader lands on the page row showing the same state, over the new first results.
 * That is the intended outcome and not a flicker to suppress. Typing is what the caret hold is
 * for (`holdsBar`, `components/DockedBar`), which is the bar's own concern and not this hook's.
 */
export function useFilterQuickBar(row: HTMLElement | null, enabled: boolean): FilterQuickBarState {
  const undocked = useUndocked(enabled ? row : null);
  const shown = enabled && undocked;
  useScrollPaddingTop(row, shown ? DOCKED_BAR_CLEARANCE_PX : 0);
  return {
    shown,
    dockTop: shown ? DOCKED_BAR_CLEARANCE_PX : 0,
    stickyTop: shown ? DOCKED_BAR_HEIGHT_PX : 0,
  };
}
