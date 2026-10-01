import { useCallback, useMemo } from "react";
import { useCardSearch } from "@/features/search/useCardSearch";
import { CardWall, type WallItem } from "../CardWall";
import { searchItem } from "../items";

/**
 * Card search: one line, and the wall.
 *
 * **The search is the desktop's** — `useCardSearch`, the hook behind `SearchPage` and the docked
 * columns — so the box reads the same query language and the same request reaches the same
 * command. What this page leaves for phase 3 is every control but the box: the filters live
 * behind a sheet that has not been designed yet.
 */
export function SearchPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const search = useCardSearch();
  const { query, marketplace } = search;
  const items = useMemo(
    () => search.rows.map((row) => searchItem(row, marketplace.currency)),
    [search.rows, marketplace.currency],
  );
  // Read off the result rather than depended on whole: `useInfiniteQuery` hands back a fresh proxy
  // every render, so a callback keyed on `query` is a new one each time and the wall's near-end
  // effect would run on every render. `fetchNextPage` is bound once per observer.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const more = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <>
      <div className="shrink-0 border-b border-border bg-surface px-3 py-2">
        <input
          type="search"
          aria-label="Search cards"
          placeholder="Search cards"
          value={search.text}
          onChange={(e) => search.setText(e.target.value)}
          // 16px: below it, iOS and some Android browsers zoom the page on focus.
          className="h-11 w-full rounded-md border border-border bg-bg px-3 text-base text-text select-text"
        />
      </div>
      {query.isError ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          The search could not be read.
        </p>
      ) : !query.isPending && items.length === 0 ? (
        <p className="p-4 text-sm text-dim">No cards match.</p>
      ) : (
        <CardWall
          label="Search results"
          items={items}
          onOpen={onOpen}
          onNearEnd={more}
          resetKey={search.searchKey}
        />
      )}
    </>
  );
}
