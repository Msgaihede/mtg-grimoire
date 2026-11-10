import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { popup } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import {
  MENU_MIN_HEIGHT,
  MENU_MIN_WIDTH,
  PANEL_CLASS,
  PANEL_SCROLL_CLASS,
  ROW_CLASS,
  menuMaxHeight,
  panelOf,
  placeSubmenu,
} from "./panel";

/** A placement as this component draws it: `top` in the parent panel's own px, not the window's. */
interface Placed {
  side: "left-full" | "right-full";
  top: number;
  origin: string;
}

/**
 * Where a submenu is drawn before anything has been measured — to the right, level with the top
 * of its parent panel. The layout effect below corrects it before the browser paints, so this is a
 * first guess and never a flash.
 */
const UNMEASURED: Placed = { side: "left-full", top: 0, origin: "origin-top-left" };

/**
 * One row that opens a panel beside itself, and that panel.
 *
 * Both nested kinds are drawn by this: `submenu`, whose items are already in hand, and `lazy`,
 * whose body is somebody else's component. The difference is entirely in what the caller passes
 * as `children` — and it is a difference this file must not collapse, because the whole promise
 * of `MenuLazy` is that its `Content` is *mounted* by the expansion rather than merely hidden
 * until it. `children` is a React element the caller built and did not render; nothing here calls
 * it until the branch below is taken.
 *
 * ## Three things it does not do, each on purpose
 *
 * **It handles no arrow keys.** Every key in the cascade is handled once, on the root panel, which
 * routes by asking the DOM which panel the caret is in — see `ContextMenu.tsx`. A submenu is a
 * DOM descendant of the root panel, so a press inside one arrives there by bubbling.
 *
 * **It is not portalled and not `fixed`.** The root panel animates a `scale`, and a transformed
 * ancestor is the containing block for every `fixed` descendant — so a `fixed` submenu would be
 * positioned against the very panel it is opening out of. It is `absolute` against its **parent
 * panel** instead — the row box between them is static on purpose, so that the parent's scroller
 * (`PANEL_SCROLL_CLASS`) does not clip it — with no popper (the shipped CSP is `style-src 'self'`,
 * which every one of those silently fails under; React's `style` prop writes through the CSSOM,
 * which it allows, and the root panel has always been placed that way).
 *
 * **It takes no layer.** It used to take `LAYER.raisedWhenPopupOpen`, because a submenu inside a
 * `relative` row box was out-painted by later sibling rows. Now that the row box is static, the
 * panel is the one positioned box among non-positioned rows, and a positioned descendant paints
 * after every in-flow one in the parent panel's stacking context — so it is above them by the
 * paint order alone, and a z-index on a static box would be ignored anyway.
 */
export function Submenu({
  id,
  label,
  Icon,
  panelDepth,
  open,
  onOpen,
  onClose,
  children,
}: {
  id: string;
  label: string;
  Icon?: LucideIcon;
  /** The depth of the panel this row opens: one below the panel the row itself is drawn in. */
  panelDepth: number;
  open: boolean;
  /** `focus` is true for a deliberate act — a press or ArrowRight — and false for a hover. */
  onOpen: (focus: boolean) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placed>(UNMEASURED);

  /**
   * Measured after the commit, applied before the paint — **and measured again whenever the panel
   * changes size**, which is the case a single reading structurally cannot cover.
   *
   * `MenuLazy` exists for bodies that fetch: "Add to ▸ Deck" draws `Loading decks…` while its
   * queries are pending and then swaps in a whole folder tree. So the one reading taken at the
   * commit that opened the panel is a reading of the *loading note*, and it decides a flip for a
   * panel five times that size. `Submenu` does not re-render when the query resolves — React
   * re-renders the body, which is this component's child — and `[open]` would not re-run the
   * effect if it did. A panel opened at `top: 560` in an 800px window on 42px of note then spans
   * 560–860 on 300px of decks, and the 60px past the edge held real rows: until issue #1572 there
   * was no `max-h`, no `overflow-y` and no scroller anywhere in this module, and the ancestor is
   * `fixed`, so nothing clipped it and nothing could be scrolled to it. (A panel scrolls now, but
   * one placed from the note would still hang its lower rows off the window rather than scroll.)
   *
   * **A `ResizeObserver`, which the deck's stack view refuses on the grounds that "this view has
   * no business observing its own box" — and that argument does not reach here.** It is about a
   * *layout* view measuring the desk it lives in so as to lay itself out, where CSS already
   * answers and a second reading lands a frame behind the layout it is reacting to. This is a
   * floating popup measuring **itself**, to decide which side of a row it hangs off; nothing in
   * CSS can express "flip if you would leave the window", and being a frame late is exactly the
   * failure mode being fixed rather than one being introduced. It also cannot feed back: a
   * placement writes `top` and `left-full`/`right-full`, which move the panel and change no
   * dimension of it, so the observer has nothing to fire about.
   *
   * **Viewport px in, parent px out.** `placeSubmenu` answers in the window's coordinates, where
   * the caption and the gutters are; `top` is written in the parent panel's, whose padding box is
   * the containing block. The two differ by the parent's position and its border — and, while the
   * root panel is still scaling in, by its `scale`, which every rect measured inside it carries.
   * Dividing by the ratio of the parent's drawn height to its layout height takes that out, so a
   * submenu opened inside the root's first 180ms lands where it would have at rest, give or take
   * the few px the clamp's viewport reading is out by until the scale reaches 1.
   *
   * The first reading stays synchronous and stays here, ahead of the observer: `ResizeObserver`
   * delivers its initial notification after the layout rather than during this effect, so leaning
   * on it would trade the correction for a painted frame in the wrong place.
   *
   * The `setPlacement` guard is not tidiness: an unconditional write would re-render this
   * component on every measurement, and a re-render that reaches `children` is a
   * `MenuLazy.Content` mounted twice. (It cannot, in fact — the element object is identical
   * between renders, so React bails on the subtree — but the promise is worth holding at both
   * ends, and this effect takes far more readings than it used to.)
   */
  useLayoutEffect(() => {
    const row = rowRef.current;
    const panel = panelRef.current;
    const parent = panelOf(row);
    if (!open || !row || !panel || !parent) return;
    const place = () => {
      const parentBox = parent.getBoundingClientRect();
      // Both axes measured, and both clamped to the floor rather than *replaced* by it: a panel is
      // measured after it mounts, and under jsdom every box reads a hard `0`.
      const next = placeSubmenu(
        row.getBoundingClientRect(),
        parentBox,
        Math.max(panel.offsetWidth, MENU_MIN_WIDTH),
        Math.max(panel.offsetHeight, MENU_MIN_HEIGHT),
      );
      const scale = parent.offsetHeight > 0 ? parentBox.height / parent.offsetHeight : 1;
      const top = Math.round((next.top - parentBox.top) / (scale || 1) - parent.clientTop);
      setPlacement((prev) =>
        prev.side === next.side && prev.top === top && prev.origin === next.origin
          ? prev
          : { side: next.side, top, origin: next.origin },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open]);

  // One rung of the Escape ladder per open panel, and the stack in `useDismissOnEscape` is what
  // orders them: this one is pushed after the root panel's, so the first press closes this and
  // the second closes the menu. Registered on the **flag**, not on the mount — the row outlives
  // its panel. The inline `onDismiss` is safe now; the callback is latched in a ref there, and
  // only mount order moves the stack.
  useDismissOnEscape({
    layer: "inner",
    enabled: open,
    onDismiss: () => {
      // Before the close, while the row is still under the caret it is being handed back to.
      rowRef.current?.focus();
      onClose();
    },
  });

  return (
    // `role="none"`, because a `menu` may only own `menuitem`, `menuitemradio`, `group` and
    // `separator` — and this box is none of those. It is the APG's own shape for a submenu (the
    // `li role="none"` holding a `menuitem` and the `menu` it opens), and it exists here for a
    // structural reason rather than a semantic one: it is what puts the panel *inside* its row in
    // the DOM, which is how ArrowLeft, `handBack` and the in-menu scroll find the row a panel
    // hangs off (`closest(ROW_SELECTOR)`), so the box cannot be dissolved, only made transparent.
    // Presentational-role conflict does not apply — it is not focusable and carries no ARIA.
    //
    // **Static, and that is the point of it since issue #1572** — see the note on layers above and
    // `PANEL_CLASS`: positioned, this box would be the panel's containing block, inside the parent
    // panel's scroller, and the scroller would clip it.
    <div role="none" data-menu-row={id}>
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-menu-row-button=""
        aria-haspopup="menu"
        aria-expanded={open}
        // **A press opens, and never closes** (issue #1572). It used to toggle, and hover is what
        // made that bite: the pointer rests on the row, the panel opens after 120ms, and the click
        // the reader was already making shut it again — on touch, a tap held past 120ms could do
        // the same in one gesture. A press on an open row now does what a press on a closed one
        // does, the deliberate half: the caret goes into the panel. ArrowLeft, Escape and a hover
        // onto another row are the ways out, and none of them is a second press on the same row.
        onClick={() => onOpen(true)}
        className={cn(ROW_CLASS, "text-text hover:bg-bg focus:bg-bg")}
      >
        {Icon && <Icon className="size-4 flex-none" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className="size-3.5 flex-none text-dim" aria-hidden="true" />
      </button>
      {open && (
        <motion.div
          ref={panelRef}
          {...popup}
          role="menu"
          aria-orientation="vertical"
          // The caret's resting place for a panel whose body drew no rows of its own — a lazy
          // one still loading, say. Escape then has something to hand back from.
          tabIndex={-1}
          data-menu-panel=""
          data-menu-depth={panelDepth}
          // Pixels, for `placeMenu`'s reason: a measurement, which no class can carry. `maxHeight`
          // is read at render — a resize closes the whole menu, so it cannot go stale.
          style={{ top: placement.top, maxHeight: menuMaxHeight() }}
          className={cn("absolute", placement.side, placement.origin, PANEL_CLASS)}
        >
          <div className={PANEL_SCROLL_CLASS}>{children}</div>
        </motion.div>
      )}
    </div>
  );
}
