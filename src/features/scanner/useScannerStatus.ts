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
 * The cache entry `scanner_status`' answer lives in. **One constant, because two things have to
 * agree on it**: this hook, which reads it, and `useScannerAssets`, which marks it stale when a
 * download of the scanner's files ends — a key spelled twice is a status that is never read
 * again after the files land, with nothing red anywhere.
 */
export const SCANNER_STATUS_KEY = ["scanner", "status"] as const;

/**
 * `scanner_status`, asked once a session — and again when the scanner's files are fetched.
 *
 * `staleTime: Infinity` and no button to invalidate it: `scanner_status` loads the bundle and
 * the models on its first call and answers out of what it loaded thereafter, so asking again
 * in the same session cannot report a file that has since appeared. A `Reload assets` press
 * would redraw the same three sentences and read as a repair that had happened; restarting
 * the app is the honest instruction for a file placed by hand, and it is what the sentences
 * name a path for.
 *
 * **The one thing that does invalidate it is a download of those files** (`useScannerAssets`):
 * the engine lets its loaded session go when they land, so asking again is a new answer.
 */
export function useScannerStatus(): ScannerStatusFacts {
  const status = useQuery({
    queryKey: SCANNER_STATUS_KEY,
    queryFn: ipc.scannerStatus,
    staleTime: Infinity,
  });
  return scannerStatusFacts(status.data ?? null);
}
