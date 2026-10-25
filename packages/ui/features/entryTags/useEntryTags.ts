/**
 * The cache half of entry tags (issue #1398): the suggestion list read once for every field, and
 * the one write a stack's tags go through. `./entryTags` holds the pure rules both lean on.
 */
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TagInUse } from "@/features/decks/deckTags";
import { ipc, ipcError } from "@/lib/ipc";
import { entryTagsInUse } from "./entryTags";

/**
 * The suggestion list's key — **a root of its own**, not under `["collection"]` or
 * `["wishlist"]`: it is read across both tables, so neither list's settle may be the only thing
 * that refreshes it, and every entry-tag write names it outright.
 */
export const ENTRY_TAGS_KEY = ["entryTags"] as const;

/** Which stack a write names: one collection row or one wish, by id. */
export type EntryTagsRef = { kind: "collection" | "wishlist"; id: number };

/**
 * Every entry tag in use across the collection and the wishlist, folded by capitals and sorted —
 * {@link entryTagsInUse} over `entry_tags_in_use`.
 *
 * **`[]` while the read is pending or failed**: the suggestions are a convenience under a field
 * that works without them, so a refusal here draws a field with nothing offered rather than an
 * error the reader can do nothing about. `enabled` lets a field that takes no edit skip the read.
 */
export function useEntryTagsInUse(enabled = true): TagInUse[] {
  const { data } = useQuery({ queryKey: ENTRY_TAGS_KEY, queryFn: ipc.entryTagsInUse, enabled });
  return useMemo(() => (data === undefined ? [] : entryTagsInUse(data)), [data]);
}

/**
 * Write one stack's tags, whole.
 *
 * **Queued** (`scope`), because every press sends the whole list: two chips added a beat apart
 * are two writes of `[a]` and `[a, b]`, and the second must land second or the first chip comes
 * back alone. **Not optimistic**: the field draws its own local list while the write is out, and
 * the settle re-reads the row (Rust may tidy a spelling) rather than patching a cache this hook
 * would have to know the shape of.
 *
 * **The settle is the stack's own root and the suggestions, on success and on refusal alike**:
 * `["collection"]` or `["wishlist"]` whole — the list, the shelves and the card modal's stepper
 * rows (`[list, "card", oracleId]`) are all under it — and {@link ENTRY_TAGS_KEY}, because a tag
 * just added is one the next field should offer and a tag just dropped from its last stack is one
 * it should not. A refusal is almost always a row something else deleted, so re-reading is the
 * answer then too. Nothing further out draws a stack's tags, so neither the decks nor the card
 * search are touched.
 */
export function useSetEntryTags(): {
  setTags: (ref: EntryTagsRef, tags: string[]) => void;
  error: string | null;
  pending: boolean;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ ref, tags }: { ref: EntryTagsRef; tags: string[] }) =>
      ref.kind === "collection"
        ? ipc.collectionSetTags(ref.id, tags)
        : ipc.wishlistSetTags(ref.id, tags),
    scope: { id: "entryTags" },
    onSettled: (_stored, _error, { ref }) => {
      void queryClient.invalidateQueries({ queryKey: [ref.kind] });
      void queryClient.invalidateQueries({ queryKey: ENTRY_TAGS_KEY });
    },
  });
  const { mutate } = mutation;
  const setTags = useCallback(
    (ref: EntryTagsRef, tags: string[]) => mutate({ ref, tags }),
    [mutate],
  );
  return {
    setTags,
    error: mutation.error === null ? null : ipcError(mutation.error),
    pending: mutation.isPending,
  };
}
