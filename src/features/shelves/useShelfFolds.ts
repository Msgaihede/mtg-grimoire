import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type ShelfFoldPage, type ShelfFolds } from "@/lib/ipc";

/**
 * Which shelves the reader has folded — **only the ones they moved off their default**, per page,
 * on this device, per window (spec §3.4, §5.7).
 *
 * `useSearchOpen`'s shape, for its reasons: one query at `staleTime: Infinity` over one `app_meta`
 * row, an optimistic `setQueryData`, then the write — never rolled back, because a BUSY answer
 * during a sync is not a reason to snap a shelf open again under the reader's hand. **Per window**:
 * the key sits under no root `lib/crossWindow.ts` maps to a table, and Task 7 adds it to
 * `PER_WINDOW_KEYS`, so another window's fold never reaches this one.
 *
 * Exported so a test or a story can seed the cache rather than mock the command.
 */
export const SHELF_FOLDS_KEY = ["shelfFolds"];

/** No overrides — one frozen object, so "nothing stored" is one identity across renders. */
const NO_FOLDS: Readonly<Record<string, boolean>> = Object.freeze({});

/**
 * One page's overrides out of whatever the row holds. `app_meta` is text, so the `boolean` in
 * `ipc.ts` is a promise about the far end rather than a fact about the row: a hand-edit, or a build
 * that stored something else, is exactly where it stops being true. Anything that is not a boolean
 * is dropped here, which makes that shelf answer its default.
 */
export function readFolds(raw: unknown): Readonly<Record<string, boolean>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return NO_FOLDS;
  const folds: Record<string, boolean> = {};
  for (const [id, collapsed] of Object.entries(raw)) {
    if (typeof collapsed === "boolean") folds[id] = collapsed;
  }
  return folds;
}

/**
 * One batch of presses applied to one page's map — `set_shelf_folds`' own rule, said again for the
 * optimistic half: a boolean sets an override, `null` takes it away (back to the default). Ids of
 * deleted folders are left where they are rather than pruned; `buildShelves` ignores them.
 */
export function applyFoldChanges(
  stored: Readonly<Record<string, boolean>>,
  changes: Readonly<Record<string, boolean | null>>,
): Record<string, boolean> {
  const next: Record<string, boolean> = { ...stored };
  for (const [id, collapsed] of Object.entries(changes)) {
    if (collapsed === null) delete next[id];
    else next[id] = collapsed;
  }
  return next;
}

const QUERY = {
  queryKey: SHELF_FOLDS_KEY,
  queryFn: () => ipc.shelfFolds(),
  // Read once per window. Every change goes through the write below, which puts the answer
  // straight into the cache, so there is nothing to go stale against.
  staleTime: Infinity,
  gcTime: Infinity,
};

/**
 * Ask for the stored folds **at launch**, so neither page draws its wall at the defaults and then
 * re-folds a frame later — the 700ms flash `usePrefetchSearchOpen` measured, one feature over.
 * Mounted once, in `AppShell`, beside that one. A failure is swallowed: the page's own query tries
 * again, and a preference is not worth a sentence.
 */
export function usePrefetchShelfFolds(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.prefetchQuery(QUERY).catch(() => {});
  }, [queryClient]);
}

export function useShelfFolds(page: ShelfFoldPage): {
  folds: Readonly<Record<string, boolean>>;
  setFold: (folderId: number, collapsed: boolean | null) => void;
  setMany: (changes: Record<string, boolean | null>) => void;
} {
  const queryClient = useQueryClient();
  const query = useQuery(QUERY);

  const write = useMutation({
    mutationFn: (changes: Record<string, boolean | null>) => ipc.setShelfFolds(page, changes),
    // One write at a time, in press order: two presses on one shelf a moment apart must not land
    // out of order and leave the first press stored.
    scope: { id: "shelfFolds" },
  });
  const startWrite = write.mutate;

  const setMany = useCallback(
    (changes: Record<string, boolean | null>) => {
      if (Object.keys(changes).length === 0) return;
      // The optimistic half, and a spread rather than a replacement: only this page's map moves,
      // so a fold on the collection never carries a stale wishlist answer back into the cache.
      queryClient.setQueryData(SHELF_FOLDS_KEY, (stored: Partial<ShelfFolds> | undefined) => ({
        ...stored,
        [page]: applyFoldChanges(readFolds(stored?.[page]), changes),
      }));
      startWrite(changes);
    },
    [queryClient, page, startWrite],
  );

  const setFold = useCallback(
    (folderId: number, collapsed: boolean | null) => setMany({ [String(folderId)]: collapsed }),
    [setMany],
  );

  const raw = query.data?.[page];
  const folds = useMemo(() => readFolds(raw), [raw]);
  return { folds, setFold, setMany };
}
