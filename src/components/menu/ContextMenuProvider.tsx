import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { ContextMenu } from "./ContextMenu";
import { ContextMenuContext, isTextField, type ContextMenuApi } from "./useContextMenu";
import type { MenuItem, MenuPosition } from "./types";

/** The one menu that is open, if any. */
interface OpenMenu {
  /** Bumped per open, so the panel can tell a fresh right-click from a re-render. */
  openId: number;
  items: MenuItem[];
  at: MenuPosition;
  opener: HTMLElement | null;
}

/**
 * The app's one context menu, and the door every surface opens it through.
 *
 * Three responsibilities and deliberately nothing else:
 *
 * 1. **It holds the open menu**, all of it — items, point, and what was right-clicked — as one
 *    piece of state. A second right-click therefore *replaces* rather than stacks, which is what
 *    a reader expects and what saves the panel from having to reconcile two cascades.
 * 2. **It suppresses the native menu**, once, on `document`, except in a text field. One listener
 *    rather than one per surface: the background between two cards is nobody's `onContextMenu`,
 *    and it is exactly where a WebView2 menu offering "Reload" would otherwise appear. This is
 *    only *half* of the text-field carve-out and cannot be the whole of it — a surface handler
 *    stops the event before it gets here, so `useContextMenu`'s `menu()` applies the same
 *    `isTextField` test at its own end. Both ends, one rule, one function.
 * 3. **It renders at most one `<ContextMenu>`**, as a sibling of whatever it wraps.
 *
 * ## The ordering it rests on, which is pinned rather than assumed
 *
 * React attaches one listener per event type to the root container it was created against, and
 * that container is inside `document.body` — so a surface's own `onContextMenu` is dispatched
 * while the native event is still climbing, and the suppressor here is the last thing to see it.
 * `useContextMenu`'s handler therefore `stopPropagation()`s after opening (so the innermost
 * surface wins) and calls `preventDefault()` **itself** rather than leaning on this listener,
 * which is what makes the suppression true whichever way the ordering goes.
 * `ContextMenu.test.tsx` has the ordering as an assertion, so a React release that moved its
 * listener to `document` would be a failure with a name rather than a native menu appearing over
 * a custom one in the shipped exe.
 */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const opens = useRef(0);

  const openMenu = useCallback(
    (items: MenuItem[], at: MenuPosition, opener: HTMLElement | null) => {
      opens.current += 1;
      setOpen({ openId: opens.current, items, at, opener });
    },
    [],
  );
  // Stable, and load-bearing: it is the panel's `onClose` and therefore a dependency of the
  // three window listeners behind it. An inline arrow would tear them down and add them back on
  // every render of the whole app.
  const closeMenu = useCallback(() => setOpen(null), []);

  const api = useMemo<ContextMenuApi>(() => ({ openMenu, closeMenu }), [openMenu, closeMenu]);

  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      if (isTextField(e.target)) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);

  return (
    <ContextMenuContext.Provider value={api}>
      {children}
      {/* A constant key, so a second right-click moves this panel rather than cross-fading one
          menu into another — and so there is structurally never a moment with two of them in the
          document. What has to reset per open resets inside, keyed on `openId`. */}
      <AnimatePresence>
        {open !== null && (
          <ContextMenu
            key="context-menu"
            openId={open.openId}
            items={open.items}
            at={open.at}
            opener={open.opener}
            onClose={closeMenu}
          />
        )}
      </AnimatePresence>
    </ContextMenuContext.Provider>
  );
}
