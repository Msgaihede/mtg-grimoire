import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_COLLECTION_VALUE, minimumOf } from "@/lib/collectionValue";
import { ipc, ipcError, type CollectionValue } from "@/lib/ipc";
import { notify } from "@/lib/notifications";

/**
 * The cache entry the setting lives in. Its own root rather than under `["collection"]`: every
 * collection write invalidates that root, and a setting that changes only in Settings has no reason
 * to be read again for each of them. `crossWindow.ts` follows it (`FOLLOW_LIVE_APP_META`).
 */
export const COLLECTION_VALUE_KEY = ["collectionValue"] as const;

/** Every field stated: a figure the answer lacks is its default — the crate's `#[serde(default)]`
 *  on this side, for a cached answer older than the bulk price (issue #1477). Memoised by React
 *  Query on the answer, so a reader sees one object per answer. */
function complete(settings: CollectionValue): CollectionValue {
  return { ...DEFAULT_COLLECTION_VALUE, ...settings };
}

const QUERY = {
  queryKey: COLLECTION_VALUE_KEY,
  queryFn: () => ipc.collectionValue(),
  staleTime: Infinity,
  select: complete,
};

/**
 * The reader's sell percentage, minimum card value and bulk price — read by every surface that
 * draws a reduced price, and read and written by Settings.
 *
 * **A read in flight or failed is the defaults**, which is no reduced price: the far end's own
 * answer for a row it cannot read, and a value with no brackets is true.
 *
 * **The write is optimistic and put back on a refusal**, `useScanSoundSettings`' reason: a figure
 * drawn at 70% that the store kept at 100% would be wrong on every page with nothing to say why.
 *
 * **One write at a time, in the order they were made (`scope`), and a real race needs it.** Each
 * write is the whole row, and the two boxes commit moments apart. While a card import holds the
 * database both wait for the write connection, which promises no order, so the older row could land
 * last and silently put the newer figure back while the page went on drawing it (found live on
 * 2026-11-01: a minimum of $0.50 stored as $0).
 */
export function useCollectionValue(): {
  settings: CollectionValue;
  /** The minimum as a read asks it — `undefined` with none set. Goes in the read's key. */
  minimum: number | undefined;
  setSettings: (settings: CollectionValue) => void;
} {
  const queryClient = useQueryClient();
  const query = useQuery(QUERY);

  const write = useMutation({
    mutationFn: (settings: CollectionValue) => ipc.setCollectionValue(settings),
    scope: { id: "collectionValue" },
    onError: (failure, _settings, before) => {
      if (before === undefined) {
        void queryClient.invalidateQueries({ queryKey: COLLECTION_VALUE_KEY });
      } else {
        queryClient.setQueryData(COLLECTION_VALUE_KEY, before);
      }
      notify.error("Couldn't save your collection value", { body: ipcError(failure) });
    },
    onMutate: (settings: CollectionValue) => {
      const before = queryClient.getQueryData<CollectionValue>(COLLECTION_VALUE_KEY);
      queryClient.setQueryData(COLLECTION_VALUE_KEY, settings);
      return before;
    },
  });

  const start = write.mutate;
  const setSettings = useCallback((settings: CollectionValue) => start(settings), [start]);

  const settings = query.data ?? DEFAULT_COLLECTION_VALUE;
  return { settings, minimum: minimumOf(settings), setSettings };
}
