/**
 * Which way a layer anchored to a row opens — down from the row, or up from it.
 *
 * Pure, because the thing it decides cannot be seen in jsdom: every rectangle there is zero,
 * so a component test of the flip would pass over any arithmetic at all. What clips is a
 * scroller with nothing below it to scroll to — a deck's category column, the card pane — so a
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
 * **It has no caller at all since 2026-09-03**, and it stays in `lib` all the same. It was
 * extracted from the deck editor's row menus, which the deck rebuild retired, and its second and
 * last caller was `features/card/PrintingPreview.tsx`, deleted with the docked card pane whose
 * printings list was the only thing that ever mounted it. The arithmetic has outlived both
 * because the question is neither surface's: any layer anchored to a row inside a scroller asks
 * it, and the two that have asked so far were in different features, which is what the folder is
 * for. Its tests came with it (`shouldFlipUp.test.ts`) and still hold, and they are the reason it
 * is pure: every rectangle in jsdom is zero, so a component test of a flip would pass over any
 * arithmetic at all.
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
