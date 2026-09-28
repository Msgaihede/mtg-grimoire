import { PRESS } from "@/lib/motion";

/**
 * A header/toolbar press that is not a chip — since 2026-08-26 exactly the undo/redo pair and
 * the header's Categories/Labels/History/Deck settings row.
 *
 * **The toolbar's three pickers — View, Group by, Sort — drew from this same string until
 * then.** They moved onto `components/Dropdown`, whose trigger is a `<button>` rather than a
 * `<select>` and draws its own `md` geometry rather than borrowing this one; a native select and
 * a popup-driven button were never going to share one class list forever. What is left is what
 * this doc's own numbers were always about — a plain press, never a picker.
 *
 * **36px, and the number is `FILTER_CONTROL`'s rather than one of this file's own.** It was 32
 * for the same stated reason it is 36 now — "so the two rows read as rows rather than as a pile
 * of differently sized boxes" — but the rows it was measured against grew a chip since:
 * `Split X` sits in the toolbar, and `ToggleChip` is `FILTER_CONTROL`, which is 36. So a height
 * meant to unify was drawing the plain presses four pixels shorter than the chip beside them,
 * and shorter again than the `h-9` back button at the head of the header row. Every other filter
 * row in the app (search, collection, wishlist) is already 36; this is the deck editor joining
 * them rather than a size invented here. The header carried a `Built` chip of its own when this
 * was measured; that chip is gone, and 36 stands on the app-wide agreement rather than on it.
 *
 * **`text-xs` stays, and that is a width decision with a measurement behind it.** `FILTER_CONTROL`
 * carries `text-sm`, but the six controls drawn with this string are the header's widest block —
 * measured at **692px** at max-content — and 14px glyphs put it near **760**, which is more than
 * the 1017px content box a 1280×800 window leaves once the sidebar, the shell padding and the
 * editor's own scrollbar are taken off. The row is `flex-wrap`, so it does not overflow; it wraps,
 * and a wrapped header costs 44px of deck height at the app's own default window size — the
 * regression `NAME_FLOOR` (see {@link DeckNameField}) exists to keep out. Height is the axis
 * that had room.
 *
 * The press is {@link PRESS}, the app's one recipe.
 *
 * **In a module of its own since 2026-09-27** so the undocked bar ({@link DeckHeaderBar}) draws
 * its presses from the same string as the header it stands in for — `DeckEditor` imports that bar,
 * so the bar importing this back out of `DeckEditor` would be a cycle.
 */
export const PLAIN_PRESS =
  "h-9 rounded-md border border-border bg-surface px-2.5 text-xs text-dim " +
  `${PRESS} ` +
  "disabled:active:scale-100";
