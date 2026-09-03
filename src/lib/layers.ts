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
   * A mark drawn over the mark beside it, inside one card's own 27px strip: the deck stack's
   * quantity tag over the Game Changer banner tucked under its slanted tail.
   *
   * **The lowest rung, and it competes with nothing outside the card.** Both marks are siblings
   * in one absolutely positioned strip, so all this decides is which of the two paints first —
   * it is below {@link LAYER.raised} and therefore below everything else here, which is the
   * whole of its relationship to the rest of the scale.
   *
   * It is a real z-index rather than a paint-order trick, and the reason is worth keeping
   * because the trick *looks* like it should work. "A positioned element paints above a static
   * sibling" is true of block and inline boxes and **false of flex items**: the flexbox spec
   * has them paint as inline blocks in *order-modified document order*, so a `position:
   * relative` flex item with `z-index: auto` still loses to a later sibling. Measured in the
   * shipped window 2026-08-13 — `document.elementFromPoint` inside the 10px overlap answered
   * the banner, with the tag computing `position: relative` and the banner `position: static`.
   *
   * The same sentence of that spec is what makes this entry work at all: on a flex item, a
   * z-index other than `auto` creates a stacking context **whatever its position**.
   */
  overlappingMark: "z-1",
  /**
   * Lifted above its siblings and still under a sticky header: a virtualised row holding an
   * open popup, the deck editor's drop indicator, and the deck stack's open card together
   * with the stack it is in.
   *
   * **The stack used to have two variant entries of its own** (`hover:` and `focus-within:`),
   * and they were retired with the CSS lift they spelled. A stacked card overlaps its
   * neighbours by design and, while one is open, the cards *after* it slide down out of the
   * group's fixed height — so both the card (over the cards before it) and the whole list
   * (over the groups below it in the column) still have to leave the flow's paint order. What
   * changed is that `CardStack` knows which card that is, so the class is applied from state
   * and no variant is involved. Still at this rung either way: the editor's toolbar and its
   * popups are above.
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
   * The two surfaces the deck editor draws **only during a drag**: the remove tray at the foot
   * of the window and the quick zones across the top of it. Above `popup` on purpose — a drag
   * can start while a menu or a select is open, and these are the drop targets the pointer is
   * being carried to.
   *
   * One rung for both, and they cannot overlap: the tray is `sticky bottom-0` and the zones are
   * `sticky top-0`, at opposite ends of a scroller with the deck between them.
   */
  dragTray: "z-40",
  /**
   * A full-window layer a view opens over everything it owns: the deck editor's import,
   * categories, labels, history, theory-difference, settings and export dialogs.
   *
   * **One rung for all of them, deliberately, where a rung apiece looks more careful.** They are
   * held in one piece of state (`DeckEditor`'s `Layer` union), so **at most one is ever
   * mounted** — there is no pair for a second number to order, and inventing one would be a
   * claim about an overlap that cannot occur. If a layer ever has to open *over* one of these,
   * that is the day the rung splits, and the split will have a real overlap to point at.
   *
   * This used to argue from Escape as well — "because `useDismissOnEscape` orders exactly two
   * rungs and two `"inner"` peers open at once are not ordered at all" — and that clause is
   * gone rather than reworded: it is **no longer true** (the hook keeps a stack of capture-phase
   * registrations and only the token on top acts, so peers *are* ordered, by mount depth) and it
   * was never what this number rested on. Which layer eats a key press and which paints over
   * which are two questions; borrowing one as evidence for the other is how a z-index comes to
   * be justified by a keyboard protocol.
   *
   * **A context menu is not a counter-example**, and it is the one worth naming since the app
   * grew them: `ContextMenu` draws at {@link LAYER.popup}, below this rung, so a menu is a thing
   * that opens over a *view* rather than over one of these. A right-clickable surface placed
   * inside a scrimmed dialog would be the real overlap — the menu would paint behind the scrim —
   * and there is none today.
   *
   * This read "categories drawer, history drawer" until 2026-08-14, when the editor's right-hand
   * drawers became centred modals on one shell (`Dialog`) and the categories one split into
   * two. That changed what is drawn on this rung and not which rung it is: a surface that covers
   * the window covers it whichever edge it arrived from, which is the whole reason a rung is
   * named for its *reach* rather than for its shape.
   *
   * Above `dragTray`, which is the top of what a *view* draws, and below `gate`: a sync taking
   * the window over covers a deck dialog, never the other way round. The four that predate this
   * entry used to borrow `gate` and `dragTray` two apiece — each right in effect and wrong in
   * name, which is exactly the reading a `LAYER` entry exists to make impossible.
   */
  overlay: "z-45",
  /**
   * The app's one tooltip, over anything a view or a dialog draws.
   *
   * **Above {@link LAYER.overlay} because a hint is shown over the deck editor's dialogs** — a
   * control inside a modal has as much to explain as one outside it, and a tooltip painted behind
   * the scrim would be a tooltip that never appears. Below {@link LAYER.gate} because
   * `SyncProgress` takes the window: a hint floating over it would describe a control the reader
   * cannot see or reach.
   *
   * One rung and one panel — the provider holds at most one open tooltip, so there is no second
   * one for a number to order against.
   */
  tooltip: "z-46",
  /**
   * `SyncProgress`'s full-window takeover, over everything the *app* draws.
   *
   * The qualifier is newer than the rung and it is load-bearing — see {@link LAYER.caption},
   * which is the one thing above this.
   */
  gate: "z-50",
  /**
   * The window's own caption bar, above every layer above.
   *
   * **This is the only rung that is not about the app at all.** Everything below it is content
   * the app draws and may legitimately cover with something else it draws; `TitleBar` is the
   * *window frame*, and `decorations: false` in `tauri.conf.json` is what makes it this app's
   * job to render rather than Windows'. A frame the window's own content can paint over is a
   * frame in name only: with the native caption gone, this row is the only way to move,
   * minimize or close the app, so a surface covering it does not obscure a control — it takes
   * the window away from the reader.
   *
   * **It shipped covered, and by two different surfaces.** Measured in the running window on
   * 2026-08-22: on a first launch `SyncProgress`'s overlay is `fixed inset-0` at
   * {@link LAYER.gate}, 1920×1080, and `document.elementFromPoint` over the Close button
   * answered the *overlay* — no caption was drawn at all for the ~90s of the first sync, and
   * Alt+F4 was the only way out. `Dialog`'s scrim is the same shape one rung down
   * ({@link LAYER.overlay}), so every modal in the app did it too. The title bar is a **flex
   * item at `z-auto`**, and a positioned element paints above non-positioned content in the
   * same stacking context whatever the numbers say, so neither surface had to out-rank it —
   * it was never in the running.
   *
   * **A rung rather than a bound on each overlay, and that is the whole argument for doing it
   * here.** The alternative was to stop both surfaces at the caption's height — which
   * duplicates `TitleBar`'s `BAR_H` into two more files, cannot be spelled as a Tailwind class
   * built from a constant (the scanner reads whole class names; see the note at the top of this
   * file), and fixes only the two surfaces that exist today. One rung says the thing that is
   * actually true and keeps being true for the next full-window surface somebody adds.
   *
   * **Above {@link LAYER.tooltip} without taking a hint off the screen**, which is the one
   * overlap worth checking rather than assuming: the caption's own buttons are the app's only
   * anchors pinned to the window's top edge, and `placeTooltip` already has to flip those
   * downward rather than open them off-window — so their panels are drawn *below* this row and
   * never inside it.
   *
   * `TitleBar`'s root is a direct child of the shell's `flex-col`, so the class needs no
   * `position` to work: a z-index other than `auto` on a flex item creates a stacking context
   * whatever its position, which is the same sentence of the flexbox spec
   * {@link LAYER.overlappingMark} rests on.
   */
  caption: "z-60",
} as const;
