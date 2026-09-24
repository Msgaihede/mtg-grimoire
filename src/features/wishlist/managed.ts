/**
 * The **managed wishlist** as the frontend reads it (user schema v48, issue #512): a folder a
 * `Theory + Actual` deck keeps, holding exactly what that deck's Compare dialog lists, rewritten by
 * Rust after every change to the deck.
 *
 * **It is the deck's and not the reader's**, and every write that would touch one is refused by the
 * backend in {@link MANAGED_REFUSAL}'s words — renaming, moving, deleting, clearing or reordering the
 * folder, making a folder in it, filing a wish into it or out of it, and any edit to a wish inside
 * it. So the rule on this side is the pinned deck groups' rule one cabinet over
 * (`features/collection/PinnedFolders.tsx`): **a managed folder is never offered as a destination,
 * and a wish inside one draws no control that could only end in that sentence.** A greyed control
 * whose only outcome is a refusal teaches nothing its absence does not.
 *
 * Pure and dependency-free on purpose, so every surface that draws a wishlist folder — the page, the
 * card menu, the destination picker, the home widget — asks the one question the one way.
 */
import type { WishlistFolder } from "@/lib/ipc";

/** The backend's refusal for every hand edit of a managed folder, verbatim — the fake answers it
 *  too, so a story cannot stand up a write the app refuses. */
export const MANAGED_REFUSAL = "A managed wishlist follows its deck, so it can't be edited by hand.";

/** Whether this folder is a deck's managed wishlist. `!= null` rather than `!== null`, so a fixture
 *  written before v48 that leaves the field out reads as the reader's own folder. */
export function isManaged(folder: Pick<WishlistFolder, "managedDeckId">): boolean {
  return folder.managedDeckId != null;
}

/** The reader's own drawers out of a list that also carries the decks' — every list of
 *  **destinations** is built from this and never from the raw rows. */
export function userWishFolders<T extends Pick<WishlistFolder, "managedDeckId">>(
  folders: readonly T[],
): T[] {
  return folders.filter((folder) => !isManaged(folder));
}

/**
 * The managed folders, sorted by name — `pinnedFolders`' opinion one cabinet over: the backend's
 * `ORDER BY sort_order, id` is the order the decks happened to be made in, which is not an order a
 * reader can predict or scan, and these rows have no `sort_order` anybody arranged.
 */
export function managedWishFolders<T extends Pick<WishlistFolder, "managedDeckId" | "name">>(
  folders: readonly T[],
): T[] {
  return folders.filter(isManaged).sort((a, b) => a.name.localeCompare(b.name));
}

/** The set of managed folder ids, for the per-row question "is this wish the deck's?". */
export function managedIds(folders: readonly WishlistFolder[]): ReadonlySet<number> {
  return new Set(folders.filter(isManaged).map((folder) => folder.id));
}
