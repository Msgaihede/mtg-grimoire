/**
 * Every z-index this app uses, named for what the thing *is*.
 *
 * It exists because of a bug that no amount of reading either file would have shown: the
 * search view's set picker (`absolute z-20`) was painted over by the results table's sticky
 * header (`sticky top-0 z-20`). Neither is inside the other, and nothing between them —
 * not the section, not the filter row, not the combobox's `relative` root, not the
 * scroller — creates a stacking context. So both land in the root one at the same number,
 * and **equal z-indexes are resolved by document order**. Every table header comes after
 * the filter bar. The header won.
 *
 * ## The part that is not the number
 *
 * **A z-index only competes inside its own stacking context.** The quick-add popup opened
 * inside a table row is capped by that row's {@link LAYER.raised} whatever it asks for,
 * because the row is `position: absolute` *and* `transform`ed and is therefore a stacking
 * context of its own. That is why {@link LAYER.raisedWhenPopupOpen} exists at all, and why
 * `raised` must stay **below** `header`: a row scrolling past the header has to go under
 * it. Raising a clipped popup's number is the fix that will not work; moving it out of the
 * transformed ancestor, or lifting that ancestor, is the fix that does.
 *
 * ## Why the values are whole strings
 *
 * Tailwind v4 scans source *text* for whole class names. A variant assembled by
 * interpolation — `` `has-[…]:${LAYER.raised}` `` — matches nothing the scanner knows and
 * emits no rule, which fails silently and only in a build. So every variant spelling is its
 * own entry here, written out.
 */
export const LAYER = {
  /**
   * Lifted above its siblings and still under a sticky header: a virtualised row holding an
   * open popup, and the deck editor's drop indicator.
   */
  raised: "z-10",
  /**
   * The row lift, as the tables spell it — a row comes forward only while something inside
   * it is expanded. Written out whole; see the note above.
   */
  raisedWhenPopupOpen: "has-[[aria-expanded=true]]:z-10",
  /** A table's sticky header row, over the rows scrolling under it. */
  header: "z-20",
  /** Anchored to a control and floating over the page: pickers, quick-adds, menus, previews. */
  popup: "z-30",
  /**
   * The deck editor's remove tray, which appears only during a drag. Above `popup` on
   * purpose: a drag can start while a menu is open, and the tray is the drop target the
   * pointer is being carried to.
   */
  dragTray: "z-40",
  /** `SyncProgress`'s full-window takeover, over everything. */
  gate: "z-50",
} as const;
