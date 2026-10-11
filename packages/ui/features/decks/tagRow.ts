/**
 * Whether a deck tile's tag row has more to say than it can draw (issue #901).
 *
 * The row is one line on the art and clips everything past it (`DeckTile`'s note on the row), so
 * a deck with more tags than the tile is wide — or with one tag wider than the tile — loses some
 * of them silently. This is the measurement that lets the tile say so: an `…` pill at the row's
 * end, and the whole list on hover.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Whether tags this wide, with `gap` between neighbours, overflow a line `width` wide.
 *
 * **Arithmetic over natural widths rather than a look at which tags wrapped**, and that is what
 * keeps the answer stable. Once the row overflows, the tile reserves room for the `…` pill, and
 * that reserve is itself what pushes tags off the line — so "did anything wrap?" asked of the
 * reserved row is always yes, and a tile widened by the zoom until every tag fits would keep its
 * pill forever. The line's width and the tags' natural widths do not move with the reserve, so
 * the question asked here has the same answer on both sides of it.
 *
 * The epsilon absorbs sub-pixel noise in the sum and nothing more: a row that genuinely misses
 * by a pixel has a tag wrapped off it, and should say so.
 */
export function tagsOverflow(widths: readonly number[], gap: number, width: number): boolean {
  if (widths.length === 0) return false;
  const needed = widths.reduce((sum, w) => sum + w, 0) + gap * (widths.length - 1);
  return needed > width + 0.01;
}

/** What {@link useTagOverflow} hands the tile. */
export interface TagOverflow {
  /** The `<ul>` of tags. Its `[data-tag]` children are what is measured. */
  rowRef: RefObject<HTMLUListElement | null>;
  /** The `…` pill, which is always mounted so its width can be read before it is shown. */
  moreRef: RefObject<HTMLLIElement | null>;
  /**
   * The room to keep clear at the row's end for the pill, in CSS pixels — `null` when every tag
   * fits and there is no pill to make room for.
   */
  reserve: number | null;
}

/**
 * Measure the tag row, and keep measuring it while anything that decides the answer can move.
 *
 * `key` is the tag list, joined: a new list is new widths, and the row it is drawn in may only
 * just have mounted. The zoom resizes the row and a late web font resizes the tags, so both are
 * observed rather than re-measured on a guess.
 *
 * **Read off the layout boxes, and corrected for any transform above them.** A tile can be
 * mid-way through an entry animation when this first runs, and `getBoundingClientRect` reports
 * the scaled box; dividing by the row's own painted-to-layout ratio takes the scale back out, so
 * the reserve written to `padding-right` is in the row's own pixels. A clipped tag's
 * `scrollWidth` is the part it is not drawing, which is how a tag truncated to the line still
 * counts at the width it wants.
 *
 * jsdom has no layout: every box is zero wide, nothing overflows, and the tile draws exactly
 * what it drew before this existed.
 */
export function useTagOverflow(key: string): TagOverflow {
  const rowRef = useRef<HTMLUListElement>(null);
  const moreRef = useRef<HTMLLIElement>(null);
  const [reserve, setReserve] = useState<number | null>(null);

  useLayoutEffect(() => {
    // No row is no tags, and the tile draws neither the pill nor its hover without one — so a
    // reserve left over from the last list is never read.
    const row = rowRef.current;
    if (!row) return;
    const tags = () => [...row.querySelectorAll<HTMLElement>("[data-tag]")];

    const measure = () => {
      const width = row.getBoundingClientRect().width;
      const scale = row.offsetWidth > 0 ? width / row.offsetWidth : 1;
      const gap = (Number.parseFloat(getComputedStyle(row).columnGap) || 0) * scale;
      const widths = tags().map(
        (tag) => tag.getBoundingClientRect().width + (tag.scrollWidth - tag.clientWidth) * scale,
      );
      const next = tagsOverflow(widths, gap, width)
        ? ((moreRef.current?.getBoundingClientRect().width ?? 0) + gap) / (scale || 1)
        : null;
      // The same answer to within a hair is the same answer: the reserve resizes the row, the
      // observer below fires for it, and a re-render on rounding noise would be one per frame.
      setReserve((prev) =>
        prev !== null && next !== null && Math.abs(prev - next) < 0.5 ? prev : next,
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    for (const tag of tags()) observer.observe(tag);
    return () => observer.disconnect();
  }, [key]);

  return { rowRef, moreRef, reserve };
}
