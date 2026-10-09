import { useCallback, type ReactNode } from "react";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * The four things every list page here says the same way: that a read failed, a sentence where
 * a list would be, "more, please", and that more was refused.
 */

/**
 * A read that failed with nothing to show for it.
 *
 * **Drawn on `isLoadingError`, never on `isError`.** query-core keeps `data` when a fetch fails,
 * so `isError` arrives with every page that did load still in hand — after a failed next page,
 * and after a failed background refetch. Read as "show the error instead" it throws away a wall
 * the reader was part way down. The desktop's `SearchPage` holds the same rule for the same
 * reason.
 */
export function ReadError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="p-4 text-sm text-destructive">
      {children}
    </p>
  );
}

/**
 * **The touch floor for the desktop's New deck dialog**, set from outside it — `ImportSheet`'s
 * `TOUCH_FLOOR` arrangement, narrowed. The dialog is the desktop's own and takes no class for a
 * size, so the host reaches in: its one footer button (`Create deck`, 36px there) is floored at
 * 44, and every text box is 16px so focusing one does not zoom the page. The form's other
 * controls keep their desktop sizes, as `Deck settings` on the deck page does.
 *
 * `display: contents`, so the wrapper is no box at all — the dialog's `fixed` scrim is positioned
 * exactly as if it were mounted bare, and a descendant selector still reaches into it.
 *
 * Here since the Scanner page became the dialog's second host on this face (*Create deck…* from
 * the review tray); it was the Decks page's own until then.
 */
export const CREATE_DECK_FLOOR =
  "contents [&_footer_button]:min-h-11 [&_input]:text-base [&_textarea]:text-base";

/** A sentence where a list would be: nothing here, or nothing this view can draw. */
export function DimNote({ children }: { children: ReactNode }) {
  return <p className="p-4 text-sm text-dim">{children}</p>;
}

/** The part of an infinite query's result a wall's "more" reads. Structural, so the three hooks'
 *  differently-typed results all fit without their generics being restated. */
interface Paged {
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => unknown;
}

/**
 * What a wall calls as the reader nears the end of what is loaded.
 *
 * `hasMore` is the caller's, because the three hooks answer it differently — the wishlist's own
 * `hasMore` is asked of the pages on screen where `query.hasNextPage` is not.
 *
 * **A refused page is a stop.** The wall stays up after one (see {@link ReadError}), and it asks
 * again every time the reader's last row moves while the end is near — so without this a page the
 * backend refused is requested again on every scroll step down there. It is asked for again once
 * something else has put the list right: a refetch that succeeds clears the flag.
 *
 * **The stop is the wall's, not the reader's.** {@link NextPageRefused} is the way past it: it
 * says the page was refused at the end of the wall and asks again only when it is pressed, by
 * calling `fetchNextPage` itself — this guard refuses on purpose, so it is not the way round it.
 *
 * The three fields are read off the result rather than depended on whole: `useInfiniteQuery`
 * hands back a fresh proxy every render, and `fetchNextPage` is bound once per observer.
 */
export function useMore(query: Paged, hasMore: boolean): () => void {
  const { isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  return useCallback(() => {
    if (hasMore && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasMore, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
}

/**
 * What a wall says at its end when the next page was refused — and the one way to ask again.
 *
 * **Drawn at the end of the wall, inside its scroller**, through `CardWall`'s `footer`: the
 * refusal is about the cards after the last one, so it is said where those cards would be, and a
 * reader only meets it by scrolling to where more was expected. Nothing at all otherwise — a wall
 * whose next page is on its way, or that has none, ends at its last row.
 *
 * **Not an alert**, for {@link ReadError}'s rule turned round: every card already on the wall is
 * still good, and a refusal about the page after them is not news worth interrupting a screen
 * reader for. `role="status"` makes it polite.
 *
 * **`Try again` calls `fetchNextPage` itself, never the wall's "more".** {@link useMore} refuses
 * after a refused page — that is what keeps a scroll near the end from turning one refusal into a
 * request per scroll step — so the press has to go round it. While the retry is in flight the
 * query clears its error flag, so the line goes; a second refusal brings it back.
 */
export function NextPageRefused({ query }: { query: Paged }) {
  if (!query.isFetchNextPageError) return null;
  return (
    <div role="status" className="flex items-center gap-3 pt-4 pb-1">
      <p className="min-w-0 flex-1 text-sm text-dim">The next cards could not be read.</p>
      <button
        type="button"
        onClick={() => void query.fetchNextPage()}
        className={cn(
          "h-11 shrink-0 rounded-md border border-border px-4 text-sm text-text",
          PRESS,
          FOCUS,
        )}
      >
        Try again
      </button>
    </div>
  );
}
