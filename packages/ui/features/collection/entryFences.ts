/**
 * **Whether the copies filed in a folder may have their count changed**, and the sentence for
 * where they may not — the collection's one predicate for it, asked by the desktop page's
 * steppers, its menu's `Remove from collection` and its table's quantity cell, and by the light
 * app's phone face.
 *
 * **Out of `CollectionPage` on 2026-10-03**, where it was two `useCallback`s over the folder census
 * (`countEditable` and `quantityBlocked`); those two now call these, so the phone and the desktop
 * cannot answer the question two ways. The reasons are unchanged and stated here once:
 *
 * - **The root, a drawer the reader made, and `Recently removed`** (issue #506), and nothing else.
 *   The fence exists for **deck custody**: a copy in a deck's group is the deck's arithmetic,
 *   a stepper there would change what a deck says it owns without the deck being touched, and
 *   those copies leave through `deck_to_collection` and nowhere else. Since issue #1537 the backend
 *   refuses those writes too (`collection::refuse_in_a_deck`, `ENTRY_IN_A_DECK`); this is the
 *   sentence a surface says before the press. The holding area's copies belong to no deck.
 * - **Written positively** — a fifth `collection_folders.kind` added later is fenced here until
 *   somebody decides it should not be.
 * - **Fenced until the census answers**: a filed copy whose folder is not in `folders` (the list
 *   starts empty) is refused, which is the fail-closed direction. The root needs no census.
 */
import type { CollectionFolder } from "@/lib/ipc";
import { DECK_KIND, REMOVED_KIND } from "./PinnedFolders";

/** `collection_folders.kind` for a drawer the reader made. */
const USER_KIND = "user";

/** May the copies filed in `folderId` (`null` is the root) be stepped, stepped to zero or removed. */
export function countEditableIn(
  folders: readonly CollectionFolder[],
  folderId: number | null,
): boolean {
  if (folderId === null) return true;
  const folder = folders.find((f) => f.id === folderId);
  return folder !== undefined && (folder.kind === USER_KIND || folder.kind === REMOVED_KIND);
}

/**
 * Why one row's copies cannot be stepped where they sit, or `null` for a row that can.
 *
 * **The first arm names what the folder is, because it names the way out**: copies in a deck's
 * group leave by being cut from the deck. **The other names no mechanism, on purpose** — it is
 * reached by a kind nobody has thought about yet (and, for the length of one query, by a drawer
 * the census has not answered for), and a deck sentence there would tell the reader to cut a card
 * from a deck that does not exist.
 */
export function quantityRefusal(
  folders: readonly CollectionFolder[],
  row: { folderId: number | null; folderName: string | null },
): string | null {
  if (countEditableIn(folders, row.folderId)) return null;
  const inADeck = deckCustodyRefusal(folders, row);
  if (inADeck !== null) return inADeck;
  return `In ${row.folderName ?? "a folder you did not make"}. Move it into one of your folders to change the quantity.`;
}

/**
 * Why one row's copies are a deck's to change and not the reader's, or `null` for a row in any
 * other folder — {@link quantityRefusal}'s deck arm alone, for a surface that asks about a copy
 * rather than about a count: the card modal's stepper and its `Edit` (issue #1537).
 *
 * **Fail-open where {@link countEditableIn} fails closed, and on purpose.** The backend refuses
 * these writes itself (`collection::refuse_in_a_deck`, `ENTRY_IN_A_DECK`), so this is the sentence
 * said before the press rather than the fence — and a modal that refused every filed copy for the
 * length of the census's first query would tell a reader their own binder is not theirs.
 *
 * `what` is the act the reader asked for, so the sentence names it rather than a count.
 */
export function deckCustodyRefusal(
  folders: readonly CollectionFolder[],
  row: { folderId: number | null; folderName: string | null },
  what = "change the quantity",
): string | null {
  if (row.folderId === null) return null;
  const folder = folders.find((f) => f.id === row.folderId);
  if (folder?.kind !== DECK_KIND) return null;
  return `In ${row.folderName ?? "a deck"}. Remove it from the deck to ${what}.`;
}
