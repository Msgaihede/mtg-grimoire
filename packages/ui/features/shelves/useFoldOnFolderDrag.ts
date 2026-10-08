import { useDragRecord } from "@/lib/dndTarget";
import { readFolderDrag, type FolderScope } from "@/lib/folderDrag";

/** The two cabinets that draw shelves. A deck folder lives in the sidebar's tree and has none. */
const SHELF_SCOPES: readonly FolderScope[] = ["collection", "wishlist"];

/**
 * Whether a shelf's heading is being carried right now — spec §3.9's fold.
 *
 * **A render-time override that writes nothing**: the page draws every shelf collapsed while this is
 * `true` and its stored folds come back untouched when it is `false`. Keeping the page anchored on
 * the dragged heading as the wall folds and unfolds is the page's job; this only answers the
 * question.
 *
 * `useDragRecord` rather than a `dragstart` listener, so the answer is right on the frame a page
 * mounts even if a drag is already under way.
 *
 * No `scope` argument, because the two shelf pages are never mounted together: a collection folder
 * can only be in the air on the collection page and a wishlist one on the wishlist page, while the
 * sidebar's deck tree — which *is* on screen beside both — is the one folder drag that must fold
 * nothing.
 */
export function useFoldOnFolderDrag(): boolean {
  const record = useDragRecord();
  return record !== null && SHELF_SCOPES.some((scope) => readFolderDrag(record, scope) !== null);
}
