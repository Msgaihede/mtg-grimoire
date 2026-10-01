import { useCallback, type ReactNode } from "react";

/**
 * The three things every list page here says the same way: that a read failed, a sentence where
 * a list would be, and "more, please".
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
 * The three fields are read off the result rather than depended on whole: `useInfiniteQuery`
 * hands back a fresh proxy every render, and `fetchNextPage` is bound once per observer.
 */
export function useMore(query: Paged, hasMore: boolean): () => void {
  const { isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  return useCallback(() => {
    if (hasMore && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasMore, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
}
