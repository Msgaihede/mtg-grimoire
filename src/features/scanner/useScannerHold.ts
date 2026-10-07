import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";
import { SCANNER_ELSEWHERE_KEY, SCANNER_ELSEWHERE_POLL_MS } from "./useScannerElsewhere";
import { SCANNER_OPEN_ELSEWHERE } from "./verdictText";

/**
 * **The heartbeat: a mounted Scanner view holds the scanner from its first render, whatever its
 * camera is doing.** `scanner_hold` on mount and once a poll while mounted, cleared on unmount — so
 * the lease is renewed by the view being here rather than by frames, which a camera still starting,
 * refused or failed never sends. Without it a view with no frames let its lease lapse in two
 * seconds, a second window got through the gate, and both had the tray on screen; and the first
 * push of the filters took the lease before the camera was live, so a slow camera could hand the
 * scanner back and forth between two windows on the Scanner view.
 *
 * **Every refusal asks the gate again, not only the first** — which flips it to the sentence and
 * unmounts the view. Keyed on nothing but the refusal itself, so a run of them is a run of asks:
 * the frame loop's re-ask ({@link useRefusedElsewhere}) fires once per run of refused frames, and a
 * run that began while the gate still said "free" could leave a mounted view sending refused frames
 * at full rate. Any other failure says nothing about the lease and is left to the frame loop's own
 * line.
 *
 * **Stopped while `released`** — the view out of sight past its grace (`useParked.ts`): a window
 * sitting on the taskbar held the scanner for good before, and nothing else could take it. Coming
 * back starts it again with an immediate beat, whose refusal is the first thing to say another
 * window has it.
 *
 * Shared by the desktop's Scanner view and the light app's phone page: the lease is the host's, and
 * both faces of one install are windows onto it.
 */
export function useScannerHold(released: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (released) return;
    const hold = () => {
      ipc.scannerHold().catch((e: unknown) => {
        if (ipcError(e) === SCANNER_OPEN_ELSEWHERE) {
          void queryClient.invalidateQueries({ queryKey: SCANNER_ELSEWHERE_KEY });
        }
      });
    };
    hold();
    const beat = setInterval(hold, SCANNER_ELSEWHERE_POLL_MS);
    return () => clearInterval(beat);
  }, [queryClient, released]);
}

/**
 * **A refused frame is the lease saying another window has the scanner** — it took it in the
 * moment between this window's ask and this frame. Asking again flips the gate to the sentence,
 * which unmounts the live view and stops the camera. This is the fast path and not the guarantee:
 * it fires once per run of refused frames, and {@link useScannerHold} is what asks on every
 * refusal. A refused *filter push* asks the same question from inside `useScannerPrefs`, which is
 * where that refusal has to be told apart from a real one — so `filterError` never carries this
 * sentence and is not read here.
 *
 * `error` is the frame loop's last failure (`useScanLoop`'s `error`), or `null`.
 */
export function useRefusedElsewhere(error: string | null): void {
  const queryClient = useQueryClient();
  const refusedElsewhere = error === SCANNER_OPEN_ELSEWHERE;
  useEffect(() => {
    if (refusedElsewhere) void queryClient.invalidateQueries({ queryKey: SCANNER_ELSEWHERE_KEY });
  }, [refusedElsewhere, queryClient]);
}
