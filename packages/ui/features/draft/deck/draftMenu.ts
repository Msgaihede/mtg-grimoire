import type { MenuItem } from "@/components/menu/types";

/** `cardMenu.tsx`'s ids for the two `Add to ▸` destinations that write to the reader's binder. */
const COLLECTION_ADDS: ReadonlySet<string> = new Set(["add-collection", "add-wishlist"]);

/**
 * A deck card's right-click, **less `Add to ▸ Collection` and `Add to ▸ Wishlist`**, for a draft
 * deck (spec §5: a drafted pool is built without the collection, and nothing is added to it).
 *
 * The shared half of the menu is `buildCardMenu`'s, which has no switch for these two rows — they
 * are required on every other surface — so a draft deck's editor filters them out of what it was
 * handed rather than teaching the shared builder about drafts. `Add to ▸ Deck` stays: a drafted
 * card put in another deck is a deck write like any other, and touches no binder. The
 * `Collection ▸` submenu needs nothing here — a draft deck is virtual, so `tracksCollection` has
 * already left it out.
 */
export function withoutCollectionAdds(items: readonly MenuItem[]): MenuItem[] {
  return items.map((item) =>
    item.kind === "submenu" && item.id === "add-to"
      ? { ...item, items: item.items.filter((child) => !COLLECTION_ADDS.has(child.id)) }
      : item,
  );
}
