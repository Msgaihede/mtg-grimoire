import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * One row of a context menu.
 *
 * A menu is **data**, not markup: every caller builds a `MenuItem[]` and the panel draws it.
 * That is what keeps a right-click's rows the same shape wherever the reader opens one — a card
 * in the collection wall, a row in a table, a tile in the deck editor — and what lets the
 * keyboard model (roving caret, submenu open/close) be written once against the array rather
 * than once per surface.
 *
 * **There is no type-ahead, and that absence is load-bearing rather than a gap to fill.** This
 * comment claimed one until 2026-08-14, which was worse than a stale word: `ContextMenu`'s
 * argument for yielding `ArrowUp`/`ArrowDown` to a field inside a `lazy` body rests on printable
 * keys reaching that field, so an agent who read the model here and "restored" the missing
 * feature would take the arrows back off the caret it was typing in. The panel's `onKeyDown`
 * handles the caret keys and returns for everything else; see the note at that switch.
 *
 * `id` is the row's identity for React keys and for the caret. It is unique **within one menu
 * level** rather than globally; a submenu's items are their own list.
 */
export type MenuItem = MenuAction | MenuRadio | MenuSubmenu | MenuLazy | MenuSeparator;

/** A row that does something and closes the menu. The ordinary kind. */
export interface MenuAction {
  kind: "action";
  id: string;
  label: string;
  Icon?: LucideIcon;
  disabled?: boolean;
  /** Drawn beside a disabled row, in `text-dim`. Why it cannot be pressed. */
  reason?: string;
  onSelect: () => void;
}

/**
 * One of a set of mutually exclusive choices — a finish, a condition, a sort.
 *
 * `checked` is drawn as a mark on the row rather than as a separate column, and the caller owns
 * the exclusivity: this type says what a row *is*, not that its siblings are off.
 */
export interface MenuRadio {
  kind: "radio";
  id: string;
  label: string;
  Icon?: LucideIcon;
  checked: boolean;
  onSelect: () => void;
}

/** A row that opens a nested menu of items **already in hand**. Nothing is fetched to build it. */
export interface MenuSubmenu {
  kind: "submenu";
  id: string;
  label: string;
  Icon?: LucideIcon;
  items: MenuItem[];
}

/**
 * A submenu whose contents are a component, mounted only when the row is expanded.
 *
 * **This is the kind that keeps a right-click free.** `submenu` holds items already in hand;
 * `lazy` is for anything that would reach the backend — the folder/deck tree behind
 * "Add to → Deck", the deck's tag list behind "Tag card". Its `Content` runs its own hooks,
 * so `useDecks()` and `deck_tag_list` fire when the reader expands the row and never when the
 * menu merely opens.
 */
export interface MenuLazy {
  kind: "lazy";
  id: string;
  label: string;
  Icon?: LucideIcon;
  Content: ComponentType<{ onDone: () => void }>;
}

/** A rule between two groups of rows. Drawn, never landed on. */
export interface MenuSeparator {
  kind: "separator";
  id: string;
}

/**
 * Where the menu opens, in **viewport** coordinates — a `contextmenu` event's `clientX`/`clientY`.
 *
 * Viewport rather than page because the panel is `fixed`, and a `fixed` box is laid out against
 * the initial containing block. Anything measuring the room left around this point reads
 * `document.documentElement.clientWidth`, never `window.innerWidth`: the two differ by the
 * classic scrollbar on every surface that has one.
 */
export interface MenuPosition {
  x: number;
  y: number;
}

/** Whether the caret may land on this row. A separator never; a disabled action never — but
 *  a disabled action is still *drawn*, because the greyed commander item exists to be read. */
export function isSelectable(item: MenuItem): boolean {
  if (item.kind === "separator") return false;
  if (item.kind === "action") return item.disabled !== true;
  return true;
}
