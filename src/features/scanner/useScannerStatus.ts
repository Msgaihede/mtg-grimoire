import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import type { ScannerStatus } from "./types";
import { bundleSentence, modelsSentence } from "./verdictText";

/**
 * Why the filters cannot be used: the scanner narrows by set and date through its labels, and a
 * bundle with no `corpus.db` beside it has none.
 */
export const FILTERS_NEED_NAMES =
  "Filters need the card database. corpus.db wasn't found next to the scanner bundle.";

/** What a Scanner surface draws from `scanner_status`, each already a conclusion. */
export interface ScannerStatusFacts {
  /** The answer itself, or `null` until it arrives. */
  status: ScannerStatus | null;
  /**
   * `false` only once the status has answered that no bundle loaded. **Unknown is not "absent"**:
   * `scanner_status` loads the bundle on its first call, which is most of a second, and a line
   * saying the scanner has no hashes for that second is a false alarm on every first open.
   */
  hasBundle: boolean;
  /** Why the filters cannot be opened, or `null` when they can. */
  filtersDisabled: string | null;
  /** The asset sentences a reader is owed — the bundle's, then the models' — and none when all
   *  three loaded. */
  assetNotes: string[];
}

/** {@link ScannerStatusFacts} from one answer. Pure, so a test names each state by its fixture. */
export function scannerStatusFacts(status: ScannerStatus | null): ScannerStatusFacts {
  return {
    status,
    hasBundle: status === null || status.bundle.loaded,
    filtersDisabled: status !== null && status.labels === 0 ? FILTERS_NEED_NAMES : null,
    assetNotes: [bundleSentence(status), modelsSentence(status)].filter(
      (sentence): sentence is string => sentence !== null,
    ),
  };
}

/**
 * `scanner_status`, asked once a session.
 *
 * `staleTime: Infinity` and no button to invalidate it: `scanner_status` loads the bundle and
 * the models on its first call and answers out of what it loaded thereafter, so asking again
 * in the same session cannot report a file that has since appeared. A `Reload assets` press
 * would redraw the same three sentences and read as a repair that had happened; restarting
 * the app is the honest instruction, and it is what the sentences already name a path for.
 */
export function useScannerStatus(): ScannerStatusFacts {
  const status = useQuery({
    queryKey: ["scanner", "status"],
    queryFn: ipc.scannerStatus,
    staleTime: Infinity,
  });
  return scannerStatusFacts(status.data ?? null);
}
