import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError, type ScanSounds } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { DEFAULT_SCAN_SOUNDS } from "./scanSounds";

/**
 * The cache entry the scan sounds live in. Its own root, beside `["scanner", …]` rather than
 * under it: the Settings panel writes it with no scanner open, and `crossWindow.ts` follows it
 * (`FOLLOW_LIVE_APP_META`), so a change made in one window reaches a Scanner in another.
 */
export const SCAN_SOUNDS_KEY = ["scanSounds"] as const;

const QUERY = {
  queryKey: SCAN_SOUNDS_KEY,
  queryFn: () => ipc.scanSounds(),
  staleTime: Infinity,
};

/**
 * The scanner's sounds — read by the Scanner as cards land, and read and written by Settings.
 *
 * **A read in flight or failed is the defaults**, the far end's own answer for a row it cannot
 * read: a scanner that waited on a setting to beep would miss the first card.
 *
 * **The write is optimistic and is put back on a refusal**, unlike the start view's: the
 * figures are what every later scan is judged by, and a ladder drawn as `$5` that the store kept
 * at `$1` would play the wrong jingle on every card with nothing to say why. The refusal is a
 * toast — a deliberate press in Settings.
 */
export function useScanSoundSettings(): {
  sounds: ScanSounds;
  setSounds: (sounds: ScanSounds) => void;
} {
  const queryClient = useQueryClient();
  const query = useQuery(QUERY);

  const write = useMutation({
    mutationFn: (sounds: ScanSounds) => ipc.setScanSounds(sounds),
    onError: (failure, _sounds, before) => {
      if (before === undefined) void queryClient.invalidateQueries({ queryKey: SCAN_SOUNDS_KEY });
      else queryClient.setQueryData(SCAN_SOUNDS_KEY, before);
      notify.error("Couldn't save the scan sounds", { body: ipcError(failure) });
    },
    onMutate: (sounds: ScanSounds) => {
      const before = queryClient.getQueryData<ScanSounds>(SCAN_SOUNDS_KEY);
      queryClient.setQueryData(SCAN_SOUNDS_KEY, sounds);
      return before;
    },
  });

  const start = write.mutate;
  const setSounds = useCallback((sounds: ScanSounds) => start(sounds), [start]);

  return { sounds: query.data ?? DEFAULT_SCAN_SOUNDS, setSounds };
}
