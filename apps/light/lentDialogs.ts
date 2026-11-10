import { createContext, useContext, useEffect } from "react";
import type { DialogHost } from "@grimoire/ui/lib/dialogHost";

/**
 * **How a face lends its dialog host to a dialog drawn above it** (issue #1599).
 *
 * `LightApp` mounts the mobile-data prompt *around* both faces, so its `Dialog` is outside the
 * phone face's `DialogHostContext` — and a dialog with no host is no Back step and has no drag
 * down. Lifting the phone's provider up to `LightApp` is not open to us: the host is the phone
 * router's (`sheetHistory.ts`), and the phone face is a lazy chunk `LightApp` never imports. So
 * the prompt hands the faces under it this setter, and the phone face lends its host up for as
 * long as it is mounted. The prompt's dialog stays where it is in the tree — no remount when the
 * face's chunk arrives, and none when a crossing takes the face away: the host is simply there or
 * not, as it is for the desktop face, which lends nothing.
 *
 * The default does nothing: a face rendered with no prompt above it (a test, a story) has nothing
 * to lend to.
 */
export const LendDialogsContext = createContext<(host: DialogHost | null) => void>(() => {});

/** Lend `host` to the dialogs drawn above this face for as long as the caller is mounted. Pass
 *  one object for the face's life, so the loan is made once. */
export function useLendDialogs(host: DialogHost): void {
  const lend = useContext(LendDialogsContext);
  useEffect(() => {
    lend(host);
    return () => lend(null);
  }, [lend, host]);
}
