import { useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import type { ScanBatch, ScanBatchSummary } from "@/lib/ipc";

/**
 * Reading and writing the scan history (issue #989), for the Scanner view's *History* dialog.
 *
 * **One root, `["scanHistory"]`.** `@/lib/crossWindow`'s `TABLE_KEYS` points `scan_batches` and
 * `scan_batch_lines` at it, so a pile another window put away is drawn here too; and the tray's
 * two presses settle it themselves (`useTray`'s `putAway`), because both write a batch beside the
 * tray. Nothing about the collection is read here — a batch remembers its cards' names and
 * printings — so nothing owned has to move it.
 *
 * **Both reads are stale at once (`staleTime: 0`)**, `useTrades`' rule for the same reason: the
 * dialog mounts only while it is open, and a reader who scanned a pile and opened it again expects
 * the pile there. Two small reads; the price is nothing.
 */
export const SCAN_HISTORY_KEY = ["scanHistory"] as const;
export const SCAN_HISTORY_LIST_KEY = ["scanHistory", "list"] as const;

export function scanBatchKey(id: number): readonly ["scanHistory", "batch", number] {
  return ["scanHistory", "batch", id];
}

/** Every batch, newest first, as the backend lists them. */
export function useScanHistoryList() {
  return useQuery({
    queryKey: SCAN_HISTORY_LIST_KEY,
    queryFn: () => ipc.scanHistoryList(),
    staleTime: 0,
  });
}

/** One batch with its lines. `null` asks for nothing; a batch that is gone answers `null`. */
export function useScanBatch(id: number | null) {
  return useQuery({
    queryKey: scanBatchKey(id ?? 0),
    queryFn: () => (id === null ? Promise.resolve(null) : ipc.scanHistoryGet(id)),
    enabled: id !== null,
    staleTime: 0,
  });
}

/**
 * The history's two writes. Each answers a promise that rejects with the backend's own sentence,
 * so the caller decides where a refusal is said; each settles the root whatever the answer, which
 * on a refusal is also the undo of the patch it drew.
 */
export interface ScanHistoryWrites {
  /** A blank name is `Scan N` back — the backend's rule, so the patch leaves the name alone. */
  rename(id: number, name: string): Promise<void>;
  /** The batch and its lines. **The collection is not touched**, whatever the batch's status. */
  remove(id: number): Promise<void>;
}

function patchSummary(
  client: QueryClient,
  id: number,
  change: (batch: ScanBatchSummary) => ScanBatchSummary,
): void {
  client.setQueryData<ScanBatchSummary[]>(SCAN_HISTORY_LIST_KEY, (list) =>
    list?.map((batch) => (batch.id === id ? change(batch) : batch)),
  );
}

export function scanHistoryWrites(client: QueryClient): ScanHistoryWrites {
  const settle = () => void client.invalidateQueries({ queryKey: SCAN_HISTORY_KEY });
  return {
    rename: async (id, name) => {
      const trimmed = name.trim();
      // **Drawn at once, unless it is a reset**: a typed name is what the list will say, and a
      // rename that showed the old one for the length of a read would look refused. A blank one
      // is the backend's `Scan N`, which only the backend can number — so it waits for the read.
      if (trimmed !== "") {
        await client.cancelQueries({ queryKey: SCAN_HISTORY_KEY });
        patchSummary(client, id, (batch) => ({ ...batch, name: trimmed }));
        client.setQueryData<ScanBatch | null>(scanBatchKey(id), (batch) =>
          batch ? { ...batch, summary: { ...batch.summary, name: trimmed } } : batch,
        );
      }
      try {
        await ipc.scanHistoryRename(id, trimmed);
      } finally {
        settle();
      }
    },
    remove: async (id) => {
      try {
        await ipc.scanHistoryDelete(id);
        // **Out of the list now**, without waiting for the read the write has just asked for —
        // the next list drawn must not offer a batch the backend has said is gone — and its own
        // entry dropped rather than refetched into a `null`. `scan_batches.id` is a plain
        // `INTEGER PRIMARY KEY`, so the highest id is handed out again by the next press, and a
        // `null` left under the key would say a batch made a moment later is gone.
        client.setQueryData<ScanBatchSummary[]>(SCAN_HISTORY_LIST_KEY, (list) =>
          list?.filter((batch) => batch.id !== id),
        );
        client.removeQueries({ queryKey: scanBatchKey(id), exact: true });
      } finally {
        settle();
      }
    },
  };
}

export function useScanHistoryWrites(): ScanHistoryWrites {
  const client = useQueryClient();
  return useMemo(() => scanHistoryWrites(client), [client]);
}
