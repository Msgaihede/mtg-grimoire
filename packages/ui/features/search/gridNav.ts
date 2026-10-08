/**
 * Where an arrow key moves the selection on a wall of card art — the arithmetic, and nothing
 * else.
 *
 * Its own module rather than a closure inside `CardGrid`, for the reason `columnsFor` and
 * `sideGutterFor` are exported from that file: **jsdom lays nothing out**, so a rendered wall
 * there is one column wide however many tiles it holds, and up/down are indistinguishable from
 * left/right. Every claim worth making about this — that the last tile of a row steps to the
 * first of the next, that Down at the bottom of a part-full last row lands on the last card
 * rather than on nothing — is a claim about a *multi-column* grid, and the only honest place to
 * make it is on a function that takes the column count as an argument. `gridNav.test.ts` is
 * therefore where the real cases live, and `CardGrid.test.tsx` keeps to what a one-column wall
 * can answer.
 *
 * Nothing here touches the DOM, the store or the virtualiser. It is given an index and hands one
 * back; who is selected, which tile takes the caret and how far the wall has to scroll to show it
 * are `CardGrid`'s.
 */

import { rowOfTile, type ShelfLayout } from "@/lib/shelfLayout";

/**
 * The tile an arrow key moves to, or `null` for a press this wall has no answer for.
 *
 * `index` is a tile's **absolute** position in `rows`, never a (row, column) pair, and that is
 * load-bearing rather than a simplification: selecting a card opens the 384px detail pane,
 * which narrows the wall and re-runs `columnsFor` — so the very press being handled changes the
 * column count under the answer. An absolute index survives that reflow; a row and a column do
 * not. See `CardGrid`'s handler for the other half of it.
 *
 * **Left and right are linear across row boundaries.** The last tile of a row steps to the first
 * tile of the next, because the reader asked for "the next card in the grid" and a wall of
 * search results is one list that happens to be wrapped — a right arrow that stopped dead at the
 * right-hand edge would leave the reader pressing Down-then-Home, which is a keystroke sequence
 * for a spreadsheet rather than for a shelf of cards.
 *
 * **Neither end wraps.** Right on the last card and left on the first each answer `null`, and
 * the caller then leaves the event alone. Wrapping would teleport a reader from the bottom of a
 * 117 k-row browse back to the top on one keypress, with the wall scrolling the whole way — the
 * one thing an arrow key must never do is lose somebody's place.
 *
 * **Up and down clamp into the list rather than refusing**, which has two visible consequences
 * and both are wanted. The last row of a wall is nearly always part-full, so Down from the
 * bottom-right of the row above it lands on the *last card* instead of doing nothing; and Up
 * from anywhere in the top row lands on the first card, which reads as Home. A refusal in either
 * case would be a key that works everywhere except at the edge the reader is most likely to be
 * standing at.
 *
 * A move that clamps to where it started answers `null` — that is what makes "Right on the last
 * card does nothing" and "Up on the first card does nothing" the same rule as the two above, and
 * it is what tells the caller not to `preventDefault()` a press it did not use.
 *
 * @param index the tile the caret is on, as an absolute position in the list
 * @param key the `KeyboardEvent.key` of the press
 * @param columns how many tiles the wall is currently drawing across
 * @param count how many tiles there are in total
 */
export function nextGridIndex(
  index: number,
  key: string,
  columns: number,
  count: number,
): number | null {
  // An empty wall, and a wall measured before its `ResizeObserver` has answered. `columnsFor`
  // floors at one column precisely so the virtualiser is never handed `Infinity` rows, but this
  // function is also called with whatever a DOM attribute parsed to, so it does its own
  // checking: `columns` of 0 would make Up and Down no-ops that still swallowed the keypress,
  // and a `NaN` from a missing attribute would return `NaN` and index the row array with it.
  if (count <= 0) return null;
  if (!Number.isFinite(columns) || columns < 1) return null;
  if (!Number.isInteger(index)) return null;

  const step =
    key === "ArrowLeft"
      ? -1
      : key === "ArrowRight"
        ? 1
        : key === "ArrowUp"
          ? -columns
          : key === "ArrowDown"
            ? columns
            : null;
  // Every other key, including the ones a wall of cards might plausibly grow later (Home, End,
  // PageDown): unhandled is not the same as handled-to-no-effect, and the caller reads `null`
  // as "this press was never mine".
  if (step === null) return null;

  const next = Math.min(count - 1, Math.max(0, index + step));
  return next === index ? null : next;
}

/**
 * {@link nextGridIndex} for a wall drawn as shelves — the same promises, over a layout whose rows
 * are no longer one rectangle.
 *
 * `index` is still an **absolute** position, now in the flat tile order the shelves make together
 * (`ShelfLayout.totalTiles` of them), for the same reason: selecting a card can re-run the column
 * count under the very press being answered, and a (row, column) pair would not survive it.
 *
 * - **Left and right walk the flat order**, across a shelf's row boundaries and across shelves
 *   alike, and neither end wraps — the reader asked for the next card, and the next card after a
 *   shelf's last one is the first card of the next shelf that has any.
 * - **Up and down move to the previous or next row of tiles**, which within a shelf is `columns`
 *   away, and past a shelf's first or last row is the neighbouring shelf's nearest row. Headings,
 *   labels, empty boxes and collapsed shelves are rows with no tiles in them and are stepped over.
 *   The column is kept, clamped to the row's length — so Down onto a short row lands on its last
 *   card, as it does on the flat wall.
 * - **Up on the first row and Down on the last answer `null`.** This is where the two walls part:
 *   on the flat wall a clamp there reads as Home or End, but here the row above the first is a
 *   heading, and a caret that jumped sideways to the first card while the reader pressed Up would
 *   be a move nobody asked for.
 *
 * A caret on a tile the layout no longer holds (a refetch shortened a shelf under it) is brought
 * back onto the nearest tile that exists, as the flat wall does. `null` means the press was never
 * this function's, and the caller leaves the event alone.
 */
export function nextShelfTileIndex(
  layout: ShelfLayout,
  index: number,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): number | null {
  const count = layout.totalTiles;
  if (count <= 0) return null;
  if (!Number.isInteger(index)) return null;

  if (key === "ArrowLeft" || key === "ArrowRight") {
    const next = Math.min(count - 1, Math.max(0, index + (key === "ArrowRight" ? 1 : -1)));
    return next === index ? null : next;
  }
  // `CardGrid` reads `KeyboardEvent.key`, which is a `string`; a key that reached here by a cast
  // is still not this function's to answer.
  if (key !== "ArrowUp" && key !== "ArrowDown") return null;
  if (index < 0 || index >= count) return Math.min(count - 1, Math.max(0, index));

  const from = rowOfTile(layout, index);
  if (from < 0) return null;
  const here = layout.rows[from];
  if (here.kind !== "tiles") return null;

  const step = key === "ArrowDown" ? 1 : -1;
  for (let at = from + step; at >= 0 && at < layout.rows.length; at += step) {
    const row = layout.rows[at];
    if (row.kind !== "tiles") continue;
    return row.start + Math.min(index - here.start, row.end - row.start - 1);
  }
  return null;
}
