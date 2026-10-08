import { wallPrinting } from "@/features/wishlist/wish";
import { ElsewhereMark } from "@/features/wishlist/wishMarks";
import type { WishRow } from "@/lib/ipc";

/**
 * A wish's printing line in the chin — the desktop wall's caption, word for word: `wallPrinting`
 * (the set and number, or `Any printing`, with the finish's word dropped where the chin's glyph
 * already says it) and the `elsewhere` mark beside it when the same card is wished for again.
 *
 * The line must stay one line, `CardChin`'s budget: the words truncate and the mark is
 * `shrink-0` beside them.
 */
function WishPrinting({ row }: { row: WishRow }) {
  return (
    <span className="flex min-w-0 items-center gap-[calc(0.375rem*var(--mark-scale,1))]">
      <span className="min-w-0 truncate">{wallPrinting(row)}</span>
      <ElsewhereMark count={row.elsewhere} />
    </span>
  );
}

/** {@link WishPrinting} as the chin's `printing` takes it — for `items.ts`, which writes no JSX. */
export const wishPrinting = (row: WishRow) => <WishPrinting row={row} />;
