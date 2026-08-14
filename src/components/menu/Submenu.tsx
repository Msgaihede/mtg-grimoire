import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import {
  MENU_MIN_HEIGHT,
  PANEL_CLASS,
  ROW_CLASS,
  placeSubmenu,
  type SubmenuPlacement,
} from "./panel";

/**
 * Where a submenu is drawn before anything has been measured — down and to the right, which is
 * where all but the last column of them end up. The layout effect below corrects it before the
 * browser paints, so this is a first guess and never a flash.
 */
const UNMEASURED: SubmenuPlacement = { position: "left-full top-0", origin: "origin-top-left" };

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
 * positioned against the very panel it is opening out of. It is `absolute` inside its own row's
 * box instead, which needs no pixel arithmetic and no popper (the shipped CSP is `style-src
 * 'self'`, which every one of those silently fails under).
 *
 * **It takes `LAYER.raisedWhenPopupOpen` rather than a layer of its own.** Inside the root panel's
 * stacking context a later sibling row paints over an earlier one's submenu, and that variant —
 * `has-[[aria-expanded=true]]` — is exactly the rule the tables already use for the same reason.
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
  const [placement, setPlacement] = useState<SubmenuPlacement>(UNMEASURED);

  // Measured after the commit and applied before the paint. The guard is not tidiness: an
  // unconditional `setPlacement` would re-render this component on every open, and a re-render
  // that reaches `children` is a `MenuLazy.Content` mounted twice. (It cannot, in fact — the
  // element object is identical between renders, so React bails on the subtree — but the promise
  // is worth holding at both ends.)
  useLayoutEffect(() => {
    const row = rowRef.current;
    const panel = panelRef.current;
    if (!open || !row || !panel) return;
    const next = placeSubmenu(
      row.getBoundingClientRect(),
      Math.max(panel.offsetHeight, MENU_MIN_HEIGHT),
    );
    setPlacement((prev) =>
      prev.position === next.position && prev.origin === next.origin ? prev : next,
    );
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
    // layout reason rather than a semantic one: the panel is positioned in the cascade against
    // this box, so the box cannot be dissolved, only made transparent. Presentational-role
    // conflict does not apply — the box is not focusable and carries no ARIA of its own.
    <div role="none" data-menu-row={id} className={cn("relative", LAYER.raisedWhenPopupOpen)}>
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-menu-row-button=""
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? onClose() : onOpen(true))}
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
          className={cn("absolute", placement.position, placement.origin, PANEL_CLASS)}
        >
          {children}
        </motion.div>
      )}
    </div>
  );
}
