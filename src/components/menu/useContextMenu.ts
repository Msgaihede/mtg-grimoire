import {
  createContext,
  useContext,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { MenuItem, MenuPosition } from "./types";

/**
 * Where WebView2's own menu survives.
 *
 * Cut, copy, paste, undo and spellcheck suggestions are things we cannot rebuild, so a text field
 * keeps the browser's. Everywhere else the native menu is suppressed — an app that offers
 * "Reload" and "View source" on a right-click is leaking browser chrome into a desktop window.
 *
 * `closest` rather than a tag test, because the press lands on whatever is under the pointer and
 * a `contenteditable` region is a tree: a right-click on a `<strong>` inside one is a right-click
 * in a text field.
 *
 * **It lives here rather than with the document suppressor that was its first caller**, because
 * both ends of the rule need it and only one of them can own it: `ContextMenuProvider` already
 * imports the context from this module, so the reverse import would be a cycle. It is also the
 * honest home — this file owns what a right-click handler does to an event, and this is the one
 * case where the answer is "nothing at all".
 */
export function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  return el.closest("input, textarea, [contenteditable=''], [contenteditable='true']") !== null;
}

/** What the provider hands every surface: open a menu, close the one that is open. */
export interface ContextMenuApi {
  openMenu: (items: MenuItem[], at: MenuPosition, opener: HTMLElement | null) => void;
  closeMenu: () => void;
}

/**
 * What a surface gets when nothing has mounted a `ContextMenuProvider` above it: no menu.
 *
 * **A no-op rather than a thrown "missing provider", and that is a decision with a cost.** Every
 * surface that offers a right-click calls this hook, and every one of them is also a Storybook
 * story and a test that renders it on its own — so a throw here is not a helpful error at the
 * one call site that forgot, it is `src/stories.test.tsx` red for everybody, because that file
 * composes the whole tree. The cost is that a forgotten provider is a right-click that does
 * nothing rather than a message saying why; `App.tsx` mounts the one that matters and
 * `App.test.tsx` renders it.
 */
const NO_MENU: ContextMenuApi = { openMenu: () => {}, closeMenu: () => {} };

export const ContextMenuContext = createContext<ContextMenuApi>(NO_MENU);

/** What {@link useContextMenu} hands back. */
export interface ContextMenuHandles extends ContextMenuApi {
  /** Attach to any element: `onContextMenu={menu(() => buildItems(target))}` */
  menu: (build: () => MenuItem[]) => (e: ReactMouseEvent) => void;
  /** For Shift+F10 / the ContextMenu key. Anchors at the element's bottom-left. */
  menuKey: (build: () => MenuItem[]) => (e: ReactKeyboardEvent) => void;
  /** For a button whose whole job is to open this menu: `onClick={menuClick(build)}`. Anchors at
   *  the pointer for a press that had one, and at the button's bottom-left for one that did not. */
  menuClick: (build: () => MenuItem[]) => (e: ReactMouseEvent) => void;
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
 *
 * ## Why the text-field test is here and not only on the suppressor
 *
 * A surface's `menu()` handler sits on a **row**, and rows contain fields: `QuantityStepper` is an
 * `<input>` inside the collection and deck tables' rows, and `FolderTree` puts one inside a deck
 * node. A right-click in one of those bubbles to the row's handler — and that handler's own
 * `preventDefault()` plus `stopPropagation()` means the provider's document-level test never runs
 * and never gets to save it. So the field would lose cut, copy, paste, undo and its spellcheck
 * suggestions and get a card menu instead. The test belongs in the primitive rather than in
 * every caller, because a caller that forgets it produces a bug nobody can see from the call
 * site.
 *
 * ## Three handles, one body
 *
 * `menu`, `menuKey` and `menuClick` differ in exactly two things: which presses they answer, and
 * **where the panel goes**. Everything else — the field carve-out, the empty-list rule, the
 * `preventDefault()` and the `stopPropagation()` — is the same four lines, and it was written
 * twice before there were three of them. {@link opened} is that body, and each handle supplies
 * only an anchor; adding a fourth door must not be a third copy of the rules above.
 */
export function useContextMenu(): ContextMenuHandles {
  const api = useContext(ContextMenuContext);

  return useMemo(() => {
    /** Either press a menu can be opened by — enough of one to apply the shared rules to. */
    type Press = ReactMouseEvent | ReactKeyboardEvent;

    /**
     * Everything a handle does that is not choosing where the panel goes.
     *
     * The order is load-bearing at one point: `isTextField` is tested **before** `build()`, so a
     * press in a field does not even pay for the item list.
     */
    const opened =
      <E extends Press>(
        build: () => MenuItem[],
        at: (e: E, opener: HTMLElement) => MenuPosition,
      ) =>
      (e: E): void => {
        if (isTextField(e.target)) return;
        const items = build();
        if (items.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const opener = e.currentTarget as HTMLElement;
        api.openMenu(items, at(e, opener), opener);
      };

    /** Under the pointer — where the reader's hand is. */
    const atPointer = (e: ReactMouseEvent): MenuPosition => ({ x: e.clientX, y: e.clientY });

    /**
     * At the opener's own bottom-left, for a press that came with no coordinates.
     *
     * `0, 0` is what the alternative gets you: every one of these menus in the top-left corner of
     * the window rather than under the thing it is about.
     */
    const atOpener = (_e: Press, opener: HTMLElement): MenuPosition => {
      const rect = opener.getBoundingClientRect();
      return { x: rect.left, y: rect.bottom };
    };

    const menu = (build: () => MenuItem[]) => opened<ReactMouseEvent>(build, atPointer);

    const menuKey = (build: () => MenuItem[]) => {
      const open = opened<ReactKeyboardEvent>(build, atOpener);
      return (e: ReactKeyboardEvent): void => {
        // The two presses Windows spells "open the context menu" with: the dedicated key, and
        // Shift+F10 for the keyboards that do not have one. Tested before the shared body, so a
        // caret in a field still keeps every other key — including cut, copy and paste.
        if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
        open(e);
      };
    };

    /**
     * For a control whose **whole job** is to open this menu — a `⋯` trigger, rather than a row
     * that happens to offer one on a right-click.
     *
     * **A button-activation click is not a pointer press, and that is the entire reason this
     * exists.** `menu()` anchors at `clientX/clientY`, which is correct for a right-click and is
     * hard **zero** for a keyboard: Enter or Space on a focused button fires a `click` carrying no
     * coordinates and `detail === 0`, so a `⋯` reached by Tab would open its menu in the top-left
     * corner of the window — the failure `menuKey`'s anchor was written to prevent, arriving
     * through the one door it does not watch. `detail` is what tells the two presses apart (it
     * counts the clicks in the sequence, and a synthesised activation has none), so a press with a
     * pointer behind it opens under that pointer and one without opens at the button, exactly
     * where `menuKey` would have put it.
     *
     * This is the app's first menu opened by a plain click — `WishFolderCard`'s trigger — and the
     * anchoring lives here rather than at that call site because the arithmetic already existed
     * here and nothing about it is that card's business.
     */
    const menuClick = (build: () => MenuItem[]) =>
      opened<ReactMouseEvent>(build, (e, opener) =>
        e.detail > 0 ? atPointer(e) : atOpener(e, opener),
      );

    return { menu, menuKey, menuClick, openMenu: api.openMenu, closeMenu: api.closeMenu };
  }, [api]);
}
