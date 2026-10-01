import { useCallback, useMemo } from "react";
import { useCollection } from "@/features/collection/useCollection";
import { CardWall, type WallItem } from "../CardWall";
import { collectionItem } from "../items";

/** The reader's own cards, read-only. Folders, filters and edits are phase 3's. */
export function CollectionPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const collection = useCollection();
  const { query, marketplace } = collection;
  const items = useMemo(
    () => collection.rows.map((row) => collectionItem(row, marketplace.currency)),
    [collection.rows, marketplace.currency],
  );
  // Read off the result, not depended on whole — `SearchPage`'s note: `query` is a fresh proxy
  // every render, and a callback keyed on it would re-run the wall's near-end effect each time.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const more = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (query.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        Your collection could not be read.
      </p>
    );
  }
  if (!query.isPending && items.length === 0) {
    return <p className="p-4 text-sm text-dim">Nothing in your collection yet.</p>;
  }
  return (
    <CardWall
      label="Your collection"
      items={items}
      onOpen={onOpen}
      onNearEnd={more}
      resetKey={collection.scrollKey}
    />
  );
}
