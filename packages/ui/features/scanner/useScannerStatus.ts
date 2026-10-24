import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import type { ScannerStatus } from "./types";
import { neuralSentence } from "./verdictText";

/**
 * Why the filters cannot be used: the scanner narrows by set and date through its card names,
 * which come from the card database, and a session with none has nothing to build a filter from.
 */
export const FILTERS_NEED_NAMES =
  "Filters need the card database, which the scanner could not read card names from.";

/**
 * The same, **on a host that fetches the scanner's files into a store of its own** (a status
 * whose recogniser is `source: "store"` — a web page): there is no card database a reader could
 * look for there, so the sentence names none. Its likeliest cause is a session built before the
 * card database had cards, whose cure is that they arrive.
 */
export const FILTERS_NEED_NAMES_STORE =
  "Filters need card names, which the scanner does not have yet.";

/** Why a status with no labels cannot filter, in the words its host's kind of storage allows. */
function filtersNeedNames(status: ScannerStatus): string {
  return status.neural.source === "store" ? FILTERS_NEED_NAMES_STORE : FILTERS_NEED_NAMES;
}

/** What a Scanner surface draws from `scanner_status`, each already a conclusion. */
export interface ScannerStatusFacts {
  /** The answer itself, or `null` until it arrives. */
  status: ScannerStatus | null;
  /** Why the filters cannot be opened, or `null` when they can. */
  filtersDisabled: string | null;
  /** The asset sentences a reader is owed — the recogniser's — and none when it loaded. */
  assetNotes: string[];
}

/** {@link ScannerStatusFacts} from one answer. Pure, so a test names each state by its fixture. */
export function scannerStatusFacts(status: ScannerStatus | null): ScannerStatusFacts {
  return {
    status,
    filtersDisabled: status !== null && status.labels === 0 ? filtersNeedNames(status) : null,
    assetNotes: [neuralSentence(status)].filter(
      (sentence): sentence is string => sentence !== null,
    ),
  };
}

/**
 * The cache entry `scanner_status`' answer lives in — one constant, because the sync's
 * invalidation (`lib/useSyncInvalidation.ts`) names it too: a key spelled twice is a status that
 * is never read again, with nothing red anywhere.
 */
export const SCANNER_STATUS_KEY = ["scanner", "status"] as const;

/**
 * `scanner_status`, asked once a session.
 *
 * `staleTime: Infinity` and no button to invalidate it: `scanner_status` loads the recogniser and
 * the card names on its first call and answers out of what it loaded thereafter, so asking again
 * in the same session cannot report anything new — a sync that brings card names excepted, which
 * invalidates it.
 */
export function useScannerStatus(): ScannerStatusFacts {
  const status = useQuery({
    queryKey: SCANNER_STATUS_KEY,
    queryFn: ipc.scannerStatus,
    staleTime: Infinity,
  });
  return scannerStatusFacts(status.data ?? null);
}
