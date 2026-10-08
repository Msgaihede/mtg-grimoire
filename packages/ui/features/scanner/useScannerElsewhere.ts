import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

export const SCANNER_ELSEWHERE_KEY = ["scanner", "elsewhere"] as const;

/**
 * How often a window the lease is refusing asks again — the gate's poll, and the pace at which
 * `useScannerPrefs` re-sends a filter push the lease turned away — **and the heartbeat's pace**, at
 * which a mounted view renews its own lease (`ScannerPage`'s `scanner_hold`). Half the lease's two
 * seconds, so a window that let go is noticed within one lapse, and a window that is still there
 * renews twice inside one.
 */
export const SCANNER_ELSEWHERE_POLL_MS = 1000;

/**
 * Whether another window holds the scanner's lease — asked before this window opens a camera it
 * would only be refused, and again each second while the answer is yes, so the view opens on its
 * own once the other window lets go. Never cached as fresh: the lease lapses on a clock.
 *
 * **Never kept once the view is gone, either — `gcTime: 0`, and `staleTime: 0` is not enough.** A
 * stale answer still in the cache is an answer: the view would come back on the `false` it read
 * the last time it was open, mount the camera at once and only then hear, from the refetch, that
 * another window took the scanner in between. Dropped with its last observer, every visit to the
 * Scanner starts from no answer, which is the one state the gate holds the camera back for.
 */
export function useScannerElsewhere() {
  return useQuery({
    queryKey: SCANNER_ELSEWHERE_KEY,
    queryFn: ipc.scannerElsewhere,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) => (query.state.data === true ? SCANNER_ELSEWHERE_POLL_MS : false),
  });
}
