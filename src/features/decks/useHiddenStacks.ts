import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

/**
 * Which of a deck's stacks the reader has hidden in the Stacks view (issue #618) — a hidden stack
 * draws its heading and none of its cards, with an eye on the heading that shows it again.
 *
 * `useShelfFolds`' shape, for its reasons: one query at `staleTime: Infinity` over one `app_meta`
 * row, an optimistic `setQueryData`, then the write — never rolled back, because a BUSY answer
 * during a sync is not a reason to spill a pile of cards back onto the desk under the reader's
 * hand. **Per device** (the reader's call: `app_meta` is not synced) **and per window**: the key
 * sits under no root `lib/crossWindow.ts` maps to a table and is on its `PER_WINDOW_KEYS`.
 *
 * **Deliberately not under `["decks"]`**, which every deck write invalidates: a refetch landing
 * between a press and its write would draw the stack's cards again for a frame.
 *
 * Keyed by **category id**, which is already one list's pile since user schema v53 — a stack
 * hidden on the Theory tab is not the Actual tab's pile of the same name.
 */
export const HIDDEN_STACKS_KEY = ["hiddenStacks"];

const hiddenStacksKey = (deckId: number) => [...HIDDEN_STACKS_KEY, deckId];

/** Nothing hidden — one frozen set, so "nothing stored" is one identity across renders. */
const NONE: ReadonlySet<number> = new Set();

/**
 * The ids out of whatever the command answered. The `number[]` in `ipc.ts` is a promise about the
 * far end rather than a fact about the row, so anything that is not a positive integer is dropped
 * here and that stack is simply drawn.
 */
export function readHidden(raw: unknown): ReadonlySet<number> {
  if (!Array.isArray(raw)) return NONE;
  const ids = raw.filter((id): id is number => Number.isInteger(id) && id > 0);
  return ids.length === 0 ? NONE : new Set(ids);
}

export function useHiddenStacks(deckId: number): {
  /** The category ids hidden in this deck. A stale id — a pile deleted since — is harmless: no
   *  drawn stack carries it. */
  hidden: ReadonlySet<number>;
  setHidden: (categoryId: number, hidden: boolean) => void;
} {
  const queryClient = useQueryClient();
  const key = hiddenStacksKey(deckId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => ipc.hiddenStacks(deckId),
    // Read once per deck per window. Every change goes through the write below, which puts the
    // answer straight into the cache, so there is nothing to go stale against.
    staleTime: Infinity,
  });

  const write = useMutation({
    mutationFn: (press: { categoryId: number; hidden: boolean }) =>
      ipc.setStackHidden(deckId, press.categoryId, press.hidden),
    // One write at a time, in press order: a hide and a show a moment apart must not land out of
    // order and leave the first press stored.
    scope: { id: "hiddenStacks" },
  });
  const startWrite = write.mutate;

  const setHidden = useCallback(
    (categoryId: number, hidden: boolean) => {
      queryClient.setQueryData(hiddenStacksKey(deckId), (stored: unknown) => {
        const next = new Set(readHidden(stored));
        if (hidden) next.add(categoryId);
        else next.delete(categoryId);
        return [...next].sort((a, b) => a - b);
      });
      startWrite({ categoryId, hidden });
    },
    [queryClient, deckId, startWrite],
  );

  const raw = query.data;
  const hidden = useMemo(() => readHidden(raw), [raw]);
  return { hidden, setHidden };
}
