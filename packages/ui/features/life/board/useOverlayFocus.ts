import { useEffect, type RefObject } from "react";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";

/**
 * The board's own overlays — the calculator and the game menu — keep the app's caret rule without
 * being `Dialog`s: the caret moves into the panel as it opens, goes back to whatever held it as it
 * closes, and Escape closes it.
 *
 * **Not `Dialog`, on purpose.** Both are drawn *inside* the board and turned with it — the
 * calculator faces the seat that opened it, a quarter or half turn round the table — and both
 * leave the board around them visible under a scrim of the board's own; `Dialog` is a
 * window-wide, upright, `fixed` shell. Escape is the same `"inner"` rung every dialog takes.
 *
 * Mount the component only while it is open: the hook reads "mounted" as "open".
 */
export function useOverlayFocus(panelRef: RefObject<HTMLElement | null>, onEscape: () => void) {
  useDismissOnEscape({ layer: "inner", onDismiss: onEscape });
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      // Back to the control that opened it, if it is still on the page (a panel redrawn by the
      // change may have replaced it); otherwise the caret is left where the browser puts it.
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [panelRef]);
}
