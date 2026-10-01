import { useCallback, useMemo } from "react";
import { useWishlist } from "@/features/wishlist/useWishlist";
import { CardWall, type WallItem } from "../CardWall";
import { wishItem } from "../items";

/** The reader's wishes, read-only. */
export function WishlistPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const wishlist = useWishlist();
  const { query, marketplace } = wishlist;
  const items = useMemo(
    () => wishlist.rows.map((row) => wishItem(row, marketplace.currency)),
    [wishlist.rows, marketplace.currency],
  );
  // `hasMore`, not `query.hasNextPage`: the hook's own answer about the pages on screen. The other
  // two are read off the result rather than depended on whole — `SearchPage`'s note.
  const { hasMore } = wishlist;
  const { isFetchingNextPage, fetchNextPage } = query;
  const more = useCallback(() => {
    if (hasMore && !isFetchingNextPage) void fetchNextPage();
  }, [hasMore, isFetchingNextPage, fetchNextPage]);

  if (query.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        Your wishlist could not be read.
      </p>
    );
  }
  if (!query.isPending && items.length === 0) {
    return <p className="p-4 text-sm text-dim">Nothing on your wishlist yet.</p>;
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
