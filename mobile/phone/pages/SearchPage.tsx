import { useMemo } from "react";
import { useCardSearch } from "@/features/search/useCardSearch";
import { CardWall, type WallItem } from "../CardWall";
import { searchItem } from "../items";
import { DimNote, ReadError, useMore } from "./parts";

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
  const more = useMore(query, query.hasNextPage);

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
      {query.isLoadingError ? (
        <ReadError>The search could not be read.</ReadError>
      ) : !query.isPending && items.length === 0 ? (
        <DimNote>No cards match.</DimNote>
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
