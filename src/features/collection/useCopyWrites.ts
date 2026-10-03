/**
 * The three writes that correct **one copy the reader already owns** without changing how many
 * there are — its grade (and what was paid), its finish, and its printing — each with the settle
 * its first caller argued for.
 *
 * **Out of their callers on 2026-10-03** so the light app's phone face makes the same writes with
 * the same invalidations rather than a second copy of them (`docs/reference/light-app.md` §7.5b):
 *
 * - {@link useCopyUpdate} is `EditCopy`'s Save — `collection_update` with a patch of the grade
 *   and the price, settled by `["collection"]` alone. `EditCopy`'s own doc is the argument: either
 *   field can fold the row onto a neighbour, so the list is re-read, and nothing outside the
 *   collection draws either one.
 * - {@link useCopyFinish} and {@link useCopyPrinting} are the card modal's **Edit** mode (issue
 *   #564) — `collection_update` with a finish, and `collection_set_printing` — settled by
 *   `OWNED_WRITE_KEYS` (`invalidateOwnedWrite`): a wish's owned figure and a deck's owned/missing
 *   are finish- and printing-aware, so both move with the copy.
 *
 * Each takes the caller's handlers rather than owning a refusal, `useSetCollectionFolder`'s shape
 * and for its reason: the modal draws one sentence for the panel, the phone a receipt line. **The
 * settle runs first and whatever the caller passed after it**, so a caller cannot forget it. None
 * of the three is optimistic — every one can fold the row it was sent into another, and answer an
 * id the caller never named (`EntryChange.id`).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Finish } from "@/lib/finish";
import { ipc, type EntryChange, type EntryPatch } from "@/lib/ipc";
import { invalidateOwnedWrite } from "@/lib/searchMarks";

/** What a caller may hang on one of these writes. */
export interface CopyWriteHandlers<V> {
  onMutate?: (variables: V) => void;
  onSuccess?: (change: EntryChange, variables: V) => void;
  onError?: (error: unknown, variables: V) => void;
}

/** `EditCopy`'s Save: a patch of the grade and the price — see the module doc. */
export function useCopyUpdate(handlers: CopyWriteHandlers<{ id: number; patch: EntryPatch }> = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: EntryPatch }) =>
      ipc.collectionUpdate(id, patch),
    onMutate: (variables) => handlers.onMutate?.(variables),
    onSuccess: (change, variables) => {
      // `["collection"]` whole and nothing else — `EditCopy`'s save carries the argument.
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      handlers.onSuccess?.(change, variables);
    },
    onError: (error, variables) => handlers.onError?.(error, variables),
  });
}

/** The card modal's `Edit` → finish: one copy re-marked as another finish of its printing. */
export function useCopyFinish(
  handlers: CopyWriteHandlers<{ id: number; cardId: string; finish: Finish }> = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, finish }: { id: number; cardId: string; finish: Finish }) =>
      ipc.collectionUpdate(id, { finish }),
    onMutate: (variables) => handlers.onMutate?.(variables),
    onSuccess: (change, variables) => {
      invalidateOwnedWrite(queryClient);
      handlers.onSuccess?.(change, variables);
    },
    onError: (error, variables) => handlers.onError?.(error, variables),
  });
}

/** The card modal's `Edit` → printing: one copy moved onto another printing of its card. */
export function useCopyPrinting(
  handlers: CopyWriteHandlers<{ id: number; cardId: string; finish: Finish | null }> = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cardId }: { id: number; cardId: string; finish: Finish | null }) =>
      ipc.collectionSetPrinting(id, cardId),
    onMutate: (variables) => handlers.onMutate?.(variables),
    onSuccess: (change, variables) => {
      invalidateOwnedWrite(queryClient);
      handlers.onSuccess?.(change, variables);
    },
    onError: (error, variables) => handlers.onError?.(error, variables),
  });
}
