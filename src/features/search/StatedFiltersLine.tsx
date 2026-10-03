import type { ReactNode } from "react";
import { ActiveFilterChip, FILTER_LABEL } from "@/components/FilterChips";
import { DROP_MARK_ROOM } from "@/lib/dropMarks";
import { cn } from "@/lib/utils";
import type { FilterSurface } from "./FilterBar";
import { activeChips } from "./filterOptions";

/**
 * **The stated filters as one line a page places itself** — the collection's and the wishlist's
 * path row, beside the shelf toolbar, where the row's left side was empty (2026-09-27, the header
 * redesign). The bar it stands in for is told `statesFilters={false}`, so there is one copy.
 *
 * **One scrolling line and never a wrapped one**: the path row is a fixed height, and a row that
 * grew a line each time a filter went on would be the wall moving under a reader who is narrowing
 * it. `-m-1.5` against {@link DROP_MARK_ROOM}, because a scroller clips at its padding box and the
 * room is what keeps a chip's focus ring whole — and the negative margin on *both* axes is what
 * keeps the 38px scroller from making the 28px row taller.
 *
 * **No scrollbar, and a fade at the right edge instead.** A desktop's classic bar is 15px of
 * layout, and the first chip that overflowed put it under the line and grew the path row from
 * 28px to 41px — measured in Storybook on 2026-09-27 at a 700px story width with three kinds on.
 * That is the wall moving under the reader who is narrowing it, the one thing this line exists to
 * avoid, so the bar is hidden and the chips still scroll by trackpad, Shift+wheel, and Tab (a
 * focused chip is scrolled into view). The last 1.5rem fades so a line that runs on says so; it
 * paints over nothing while the chips fit, because the line is `grow`n wider than them.
 *
 * Nothing at all while nothing is filtered, because `Filtering by` over an empty line is a caption
 * with nothing after it.
 *
 * **Its own module since 2026-10-03**, beside `filterOptions.ts` and for that file's reason: it
 * reads nothing of the desktop's store, and inside `FilterBar.tsx` it could not be imported
 * without it. The phone face's search page draws it under its one sticky line, which is the same
 * job — a fixed-height place where a run of chips must scroll rather than wrap.
 */
export function StatedFiltersLine<SortKey extends string>({
  search,
  className,
  caption,
}: {
  search: FilterSurface<SortKey>;
  className?: string;
  /**
   * What leads the line in place of `Filtering by`, for a host with something worth more to say
   * there. The phone face's search page puts the result count in it: on a 360px line the caption
   * is a quarter of the room, and `12 cards` before a run of chips says what they add up to.
   */
  caption?: ReactNode;
}) {
  const chips = activeChips(search, search.marketplace.currency);
  if (chips.length === 0) return null;
  return (
    <div
      className={cn(
        "-m-1.5 flex min-w-0 items-center gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden",
        "[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]",
        DROP_MARK_ROOM,
        className,
      )}
    >
      {caption ?? <span className={cn(FILTER_LABEL, "shrink-0")}>Filtering by</span>}
      {chips.map((chip) => (
        <ActiveFilterChip key={chip.label} label={chip.label} onRemove={chip.remove} />
      ))}
    </div>
  );
}
