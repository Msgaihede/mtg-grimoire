import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * What a face driven by a finger lends every `Dialog` drawn under it — and what the desktop face,
 * which provides nothing, never sees.
 *
 * **A phone closes the thing on top with Back**, Android's gesture and a mobile browser's button
 * alike, and both of those walk the browser's history and nothing else. A dialog that is not a
 * history entry is therefore invisible to them: the press went past the open sheet and moved the
 * page beneath it, which is what the light app's phone face did with every sheet but the card
 * until 2026-10-11. The cure is an entry per open dialog, and only the face's router can write
 * one without tearing its own history — so the shell asks the host through this, and a host that
 * has no router (the desktop app, the light app's desktop face, every story) provides nothing and
 * the shell behaves exactly as it did.
 *
 * **Swipe-to-close is the face's to grant for the same reason**: a header dragged down is a
 * finger's gesture, and the 24px header of a desktop dialog has no business answering a mouse
 * that drags across it.
 */
export interface DialogHost {
  /**
   * Make an open dialog one Back step. Called as it opens, with what a Back should do — the
   * shell's `onDismiss`, the same close Escape makes. Returns the release, which the shell calls
   * when the dialog closes by any other road; the host then takes the entry back out of history.
   *
   * **A claim the host has called `onBack` on is spent**: its entry is already out of history, and
   * its release does nothing. A dialog that refuses the close is still open, and claims again.
   */
  claimBack: (onBack: () => void) => () => void;
  /** Whether a dialog's header may be dragged down to close it. */
  swipeToClose: boolean;
}

export const DialogHostContext = createContext<DialogHost | null>(null);

/** The host the nearest face lends its dialogs, or `null` — the desktop, and every story. */
export function useDialogHost(): DialogHost | null {
  return useContext(DialogHostContext);
}

/**
 * Claim a Back step for as long as `enabled` holds.
 *
 * **`onBack` is latched in a ref rather than depended on**, `useDismissOnEscape`'s rule and for
 * its reason: a host that re-renders with a fresh callback would otherwise release its entry and
 * claim a new one on every render — a history write per keystroke in a sheet's text box, and a
 * dialog that climbs above whatever was opened over it.
 *
 * **A Back the dialog refuses claims a fresh step** (issue #1158). The host's entry is gone by the
 * time `onBack` runs, and a dialog whose `onDismiss` declines — a trade scan mid-Add, a scan
 * being sent — stays open with `enabled` still true, so nothing would claim again and the next
 * Back would leave the page beneath it. So the call also bumps `spent`, and the effect runs once
 * more: a dismiss that went through lowers `enabled` in the same batch and claims nothing, and
 * one that was refused pushes a new entry.
 */
export function useBackClaim({ enabled, onBack }: { enabled: boolean; onBack: () => void }): void {
  const host = useDialogHost();
  const onBackRef = useRef(onBack);
  useLayoutEffect(() => {
    onBackRef.current = onBack;
  });
  const [spent, setSpent] = useState(0);
  const claimBack = host?.claimBack;
  useEffect(() => {
    if (!enabled || claimBack === undefined) return;
    return claimBack(() => {
      setSpent((count) => count + 1);
      onBackRef.current();
    });
  }, [enabled, claimBack, spent]);
}
