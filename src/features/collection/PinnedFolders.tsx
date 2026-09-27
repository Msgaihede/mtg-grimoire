/**
 * The app's own collection folders — one `kind: "deck"` group per deck and the one
 * `kind: "removed"` holding area — told apart from the reader's by their `kind`.
 *
 * **This file drew them as a pinned strip under the folder band until folder shelves**
 * (2026-09-26); they are shelves under the **Decks** label now, drawn by the page like every other
 * shelf and shut by default. What survives is the vocabulary: the two `kind` words, which the page's
 * shelf mapping and the home page's Folders widget both read, and `pinnedFolders`, which the page
 * still uses to find `Recently removed` and the deck groups by kind.
 */
import type { CollectionFolder } from "@/lib/ipc";

/** `CollectionFolder.kind` for the one folder that stands for a deck — `schema::
 *  COLLECTION_FOLDER_KINDS[1]`, spelled here because `kind` crosses the wire as a plain string. */
export const DECK_KIND = "deck";
/** `COLLECTION_FOLDER_KINDS[2]` — the single holding area, of which a partial unique index makes
 *  a second impossible. */
export const REMOVED_KIND = "removed";

/**
 * The app's own folders out of a list that also carries the reader's, in the order this section
 * draws them.
 *
 * **Sorted by name, which is this page's opinion rather than a second one.** Schema v25 writes
 * `sort_order = 0` on every group it creates, so the backend's `ORDER BY sort_order, id` is
 * deck-**id** order — the order the decks happened to be made in, which is not an order a reader
 * can predict or scan. The reader's own tree is left in the backend's order because there
 * `sort_order` is a field they will one day arrange.
 */
export function pinnedFolders(folders: readonly CollectionFolder[]): {
  decks: readonly CollectionFolder[];
  removed: CollectionFolder | null;
} {
  return {
    decks: folders
      .filter((folder) => folder.kind === DECK_KIND)
      .sort((a, b) => a.name.localeCompare(b.name)),
    removed: folders.find((folder) => folder.kind === REMOVED_KIND) ?? null,
  };
}
