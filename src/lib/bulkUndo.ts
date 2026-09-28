/**
 * The one bulk write per list that can still be taken back (issue #555).
 *
 * A collection or wishlist import, a bulk `Remove from collection` and a bulk `Move to` each
 * answer an `undoId` — a ticket the backend holds in memory for the session (`ipc.bulkUndo`). The
 * page that owns the list draws the offer (`components/UndoNotice`) from here; whoever made the
 * write puts the offer here. That is the whole of this module: **the ticket and the sentence
 * describing what it undoes**, one per scope, the newest winning.
 *
 * **One per scope rather than a stack**, deliberately. The backend refuses an undo whose rows
 * have changed since, so an older ticket under a newer write is almost always a refusal waiting
 * to happen — and a notice offering to undo the import from three presses ago, over a remove the
 * reader just made, is the offer being wrong about what the button does. A newer write replaces
 * the offer, and so does an undo, a refusal or a dismissal.
 *
 * **Its own store rather than a slice of `useAppStore`**: nothing else reads it, and the app
 * store's slices are each some part of a view's state a reader returns to. Tests reset it with
 * {@link resetBulkUndo}.
 */
import { create } from "zustand";

export type UndoScope = "collection" | "wishlist";

export interface UndoOffer {
  /** `ImportCommitOutcome.undoId` and its siblings — what `ipc.bulkUndo` takes back. */
  id: number;
  scope: UndoScope;
  /** What was done, as a sentence, already pluralised: `Imported 40 cards.`,
   *  `Removed 3 cards from your collection.`, `Moved 5 cards to Binder.` */
  label: string;
}

interface BulkUndoState {
  offers: Record<UndoScope, UndoOffer | null>;
  /** A write landed and can be taken back. Replaces whatever the scope offered before. */
  offer: (offer: UndoOffer) => void;
  /** Take the scope's offer down — after an undo, a refusal or a dismissal. With `id`, only when
   *  the offer on screen is still that ticket, so a late answer cannot take down a newer one. */
  drop: (scope: UndoScope, id?: number) => void;
}

const NONE: Record<UndoScope, UndoOffer | null> = { collection: null, wishlist: null };

export const useBulkUndo = create<BulkUndoState>((set) => ({
  offers: NONE,
  offer: (offer) => set((s) => ({ offers: { ...s.offers, [offer.scope]: offer } })),
  drop: (scope, id) =>
    set((s) => {
      const current = s.offers[scope];
      if (current === null || (id !== undefined && current.id !== id)) return s;
      return { offers: { ...s.offers, [scope]: null } };
    }),
}));

/** The offer a page draws, or `null`. */
export function useUndoOffer(scope: UndoScope): UndoOffer | null {
  return useBulkUndo((s) => s.offers[scope]);
}

/** Publish a ticket — a no-op for `null`, which is what an outcome answers when nothing changed,
 *  so a caller can hand its outcome's `undoId` straight through. */
export function offerUndo(scope: UndoScope, id: number | null, label: string): void {
  if (id === null) return;
  useBulkUndo.getState().offer({ id, scope, label });
}

/** Between tests: nothing offered anywhere. */
export function resetBulkUndo(): void {
  useBulkUndo.setState({ offers: NONE });
}
