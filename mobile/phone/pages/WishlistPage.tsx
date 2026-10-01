import { useMemo } from "react";
import { useWishlist } from "@/features/wishlist/useWishlist";
import { CardWall, type WallItem } from "../CardWall";
import { wishItem } from "../items";
import { DimNote, ReadError, useMore } from "./parts";

/**
 * The wishes on the wishlist's **open shelves**, read-only — `CollectionPage`'s note, one table
 * over: a deck's managed folder starts shut, so the wishes a deck keeps are not on this wall.
 */
export function WishlistPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const wishlist = useWishlist();
  const { query, marketplace, counts } = wishlist;
  const items = useMemo(
    () => wishlist.rows.map((row) => wishItem(row, marketplace.currency)),
    [wishlist.rows, marketplace.currency],
  );
  // `hasMore`, not `query.hasNextPage`: the hook's own answer about the pages on screen.
  const more = useMore(query, wishlist.hasMore);

  if (query.isLoadingError) return <ReadError>Your wishlist could not be read.</ReadError>;

  // `counts` is one row per shelf that holds a wish, folded ones included: no rows there is an
  // empty wishlist, and rows there with nothing on the wall is a wishlist this view cannot open.
  // Until it has answered, neither sentence is known to be true and neither is said.
  if (!query.isPending && items.length === 0 && counts !== undefined) {
    return counts.length === 0 ? (
      <DimNote>Nothing on your wishlist yet.</DimNote>
    ) : (
      <DimNote>
        Your wishes are all on folded shelves, such as a deck's own. This view cannot open a shelf
        yet.
      </DimNote>
    );
  }
  return (
    <CardWall
      label="Your wishlist"
      items={items}
      onOpen={onOpen}
      onNearEnd={more}
      resetKey={wishlist.queryKeyString}
    />
  );
}
