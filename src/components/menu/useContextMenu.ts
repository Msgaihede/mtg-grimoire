import {
  createContext,
  useContext,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { MenuItem, MenuPosition } from "./types";

/** What the provider hands every surface: open a menu, close the one that is open. */
export interface ContextMenuApi {
  openMenu: (items: MenuItem[], at: MenuPosition, opener: HTMLElement | null) => void;
  closeMenu: () => void;
}

/**
 * What a surface gets when nothing has mounted a `ContextMenuProvider` above it: no menu.
 *
 * **A no-op rather than a thrown "missing provider", and that is a decision with a cost.** The
 * hook is called by thirteen surfaces, every one of which is also a Storybook story and a test
 * that renders it on its own — so a throw here is not a helpful error at the one call site that
 * forgot, it is `src/stories.test.tsx` red for everybody, because that file composes the whole
 * tree. The cost is that a forgotten provider is a right-click that does nothing rather than a
 * message saying why; `App.tsx` mounts the one that matters and `App.test.tsx` renders it.
 */
const NO_MENU: ContextMenuApi = { openMenu: () => {}, closeMenu: () => {} };

export const ContextMenuContext = createContext<ContextMenuApi>(NO_MENU);

/** What {@link useContextMenu} hands back. */
export interface ContextMenuHandles extends ContextMenuApi {
  /** Attach to any element: `onContextMenu={menu(() => buildItems(target))}` */
  menu: (build: () => MenuItem[]) => (e: ReactMouseEvent) => void;
  /** For Shift+F10 / the ContextMenu key. Anchors at the element's bottom-left. */
  menuKey: (build: () => MenuItem[]) => (e: ReactKeyboardEvent) => void;
}

/**
 * The one door a surface uses.
 *
 * `menu(build)` returns an `onContextMenu` handler. **`build` is a thunk on purpose**: a surface
 * draws hundreds of rows, and building every row's item list on every render would cost more than
 * the menu ever does. It runs once, when the reader actually right-clicks.
 *
 * ## What the handler does to the event, and why it does it itself
 *
 * It calls `preventDefault()` **and** `stopPropagation()`, and neither is redundant.
 *
 * `stopPropagation` is what makes the innermost surface win. Card tiles sit inside rows which sit
 * inside walls, and any two of them may offer a menu; without it the outer handler would run
 * second and replace the inner one's items with its own — a right-click on a card answering about
 * the list it is in.
 *
 * `preventDefault` is then this handler's own job rather than the provider's, precisely *because*
 * of that stop. The provider's suppressor listens on `document`, and React dispatches from the
 * root container inside `document.body` — so the surface always sees the press first and the
 * document listener never sees a press that opened a menu at all. Pinned by
 * `ContextMenu.test.tsx`'s ordering test.
 *
 * **An empty item list is not a menu**: the handler leaves the event alone and the reader gets the
 * provider's plain suppression instead of an empty box. A builder that has nothing to offer for a
 * particular target says so by returning `[]`.
 */
export function useContextMenu(): ContextMenuHandles {
  const api = useContext(ContextMenuContext);

  return useMemo(() => {
    const menu =
      (build: () => MenuItem[]) =>
      (e: ReactMouseEvent): void => {
        const items = build();
        if (items.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        api.openMenu(items, { x: e.clientX, y: e.clientY }, e.currentTarget as HTMLElement);
      };

    const menuKey =
      (build: () => MenuItem[]) =>
      (e: ReactKeyboardEvent): void => {
        // The two presses Windows spells "open the context menu" with: the dedicated key, and
        // Shift+F10 for the keyboards that do not have one.
        if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
        const items = build();
        if (items.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        // Anchored at the element's own bottom-left rather than at a pointer that was never
        // there: a keyboard press has no coordinates, and `0, 0` would open every one of these
        // in the top-left corner of the window.
        const opener = e.currentTarget as HTMLElement;
        const rect = opener.getBoundingClientRect();
        api.openMenu(items, { x: rect.left, y: rect.bottom }, opener);
      };

    return { menu, menuKey, openMenu: api.openMenu, closeMenu: api.closeMenu };
  }, [api]);
}
