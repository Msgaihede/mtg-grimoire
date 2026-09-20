import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { isWebTarget } from "@/pwa/target";

export const WINDOW_COUNT_KEY = ["windows", "count"];

/**
 * How many windows are open. Polled every two seconds while something reads it, rather than an
 * event: its one reader is the Update panel's hint, open for seconds at a time. The web build does
 * not route `window_count`, so there the answer is one without asking.
 */
export function useWindowCount(): number {
  const query = useQuery({
    queryKey: WINDOW_COUNT_KEY,
    queryFn: ipc.windowCount,
    enabled: !isWebTarget(),
    refetchInterval: 2000,
  });
  return query.data ?? 1;
}
