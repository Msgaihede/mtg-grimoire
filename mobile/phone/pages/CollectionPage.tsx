import { useMemo } from "react";
import { useCollection } from "@/features/collection/useCollection";
import { CardWall, type WallItem } from "../CardWall";
import { collectionItem } from "../items";
import { DimNote, ReadError, useMore } from "./parts";

/**
 * The cards on the collection's **open shelves**, read-only — not every card the reader owns.
 *
 * `useCollection` is the desktop's hook and fetches what the desktop wall draws: the shelves left
 * open. A deck's own group and `Recently removed` start shut, so the copies a deck holds are not
 * on this wall, and neither is a shelf the reader folded. Headings, folds, filters and edits are
 * phase 3's.
 */
export function CollectionPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const collection = useCollection();
  const { query, marketplace, figures } = collection;
  const items = useMemo(
    () => collection.rows.map((row) => collectionItem(row, marketplace.currency)),
    [collection.rows, marketplace.currency],
  );
  const more = useMore(query, query.hasNextPage);

  if (query.isLoadingError) return <ReadError>Your collection could not be read.</ReadError>;

  // No rows is not no cards. `rows` is the open shelves; `figures` counts every shelf the wall
  // covers, folded ones included — so it is the only thing here that can say "empty" truthfully.
  // Until it has answered, neither sentence is known to be true and neither is said.
  if (!query.isPending && items.length === 0 && figures !== undefined) {
    return figures.entries === 0 ? (
      <DimNote>Nothing in your collection yet.</DimNote>
    ) : (
      <DimNote>
        Your cards are all on folded shelves, such as a deck's own. This view cannot open a shelf
        yet.
      </DimNote>
    );
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
