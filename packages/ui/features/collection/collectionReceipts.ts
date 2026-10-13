/**
 * What the collection page says once a deliberate write to the reader's cards has answered — the
 * toasts (`@/lib/notifications`) for a removal, a filing, a folder moved or deleted, a drop from
 * the search column — spelled once so the page, its drops and its tests agree on the words.
 *
 * **Every deliberate add, remove or move of cards toasts** (the owner's rule, 2026-10-12,
 * `packages/ui/CLAUDE.md`): the menu that started it has closed, the strip that asked has gone, or
 * the row has left the list — and where an `UndoNotice` offers the write back, that bar stays
 * the inline half and the toast is the receipt that is still there in the inbox later. The
 * exemptions are the ones the rule names: the stepper, the quick-add popup (which answers inside
 * itself), and a copy or a folder dragged between shelves of the open wall, whose change is drawn
 * where the reader let go.
 *
 * **One press, one toast**: every bulk path here is one backend write (`collection_remove_many`,
 * `collection_set_folder_many`), so the count comes off its single answer and nothing loops.
 */
import { plural } from "@/lib/counts";
import { ipcError } from "@/lib/ipc";
import { notify } from "@/lib/notifications";

/** `“Sol Ring”` for one entry the reader can name, `3 cards` otherwise — counted in **entries**,
 *  the unit the menu rows and the `UndoNotice` sentences count in. */
function cardsOf(entries: number, name: string | null): string {
  return entries === 1 && name !== null && name !== "" ? `“${name}”` : plural(entries, "card");
}

/** `Removed “Sol Ring” from the collection` / `Removed 3 cards from the collection`. */
export function removedReceipt(entries: number, name: string | null): string {
  return `Removed ${cardsOf(entries, name)} from the collection`;
}

/** `Moved “Sol Ring” to “Trade binder”` / `Moved 3 cards to “Trade binder”`. */
export function movedReceipt(entries: number, name: string | null, destination: string): string {
  return `Moved ${cardsOf(entries, name)} to “${destination}”`;
}

/** `Added “Sol Ring” to “Trade binder”` — a card off the search column, dropped on a shelf. */
export function addedReceipt(name: string, destination: string): string {
  return `Added ${cardsOf(1, name)} to “${destination}”`;
}

/**
 * Say how a write went: `done(answer)` as a success, or `failed` with the backend's sentence as an
 * error — and run `then` first on a success, for whatever else the caller does once it has landed.
 *
 * **A promise, from `mutateAsync`, rather than `mutate`'s per-call `onSuccess`**, and the difference
 * is not style: TanStack runs a `mutate` call's own callbacks only for the *latest* call on that
 * observer, so two rows removed in quick succession would have toasted once. Every call's promise
 * settles, so every press is answered. The refusal is caught here, so a rejected write is never an
 * unhandled rejection; the hook's own `onError` (the page's banner, the settle) still runs.
 */
export function report<T>(
  write: Promise<T>,
  say: { done: (answer: T) => string; failed: string; then?: (answer: T) => void },
): void {
  write.then(
    (answer) => {
      say.then?.(answer);
      notify.success(say.done(answer));
    },
    (error: unknown) => notify.error(say.failed, { body: ipcError(error) }),
  );
}
