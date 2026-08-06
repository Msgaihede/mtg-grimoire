/**
 * Which way a layer anchored to a row opens — down from the row, or up from it.
 *
 * Pure, because the thing it decides cannot be seen in jsdom: every rectangle there is zero,
 * so a component test of the flip would pass over any arithmetic at all. What clips is a
 * scroller with nothing below it to scroll to — a deck's zone column, the card pane — so a
 * layer opened near the foot of one is simply cut in half.
 *
 * `rowTop` is where a downward layer **starts** and `rowBottom` where an upward one **ends**.
 * For a menu drawn *over* its row those are the row's own two edges; for a preview standing
 * *beside* it they are the other way round — the bottom edge is where it starts going down and
 * the top edge is where it stops coming up. `menuHeight` is the whole of what has to fit, any
 * standoff gap included.
 *
 * Down wins ties: it is where the reader is looking, and flipping a layer that fits would move
 * it for nothing.
 *
 * Lives in `lib` rather than in the deck editor it was written for because the card pane's
 * printing preview asks the same question of a different scroller — and two copies of six
 * lines of arithmetic is how two surfaces start disagreeing about what "fits" means.
 * `ZoneColumn` re-exports it, so its callers and its tests read unchanged.
 */
export function shouldFlipUp({
  rowTop,
  rowBottom,
  menuHeight,
  viewTop,
  viewBottom,
}: {
  rowTop: number;
  rowBottom: number;
  menuHeight: number;
  viewTop: number;
  viewBottom: number;
}): boolean {
  const fitsBelow = rowTop + menuHeight <= viewBottom;
  const fitsAbove = rowBottom - menuHeight >= viewTop;
  // Neither fits — a menu taller than the column it is in — so it opens the way it reads.
  return !fitsBelow && fitsAbove;
}
