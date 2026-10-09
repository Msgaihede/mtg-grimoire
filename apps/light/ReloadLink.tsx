import { FOCUS } from "@grimoire/ui/lib/focus";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * The way out of a screen that has nothing else on it: **a link to where the reader already is**,
 * not a button that calls `location.reload()`. A fresh document from the same URL is exactly a
 * reload, and a link is the one control that works even if whatever broke took the scripts with
 * it. Drawn by the face's boundary and by the boot screen, so the two cannot come to differ.
 */
export function ReloadLink() {
  return (
    <a
      href={window.location.pathname + window.location.search + window.location.hash}
      className={cn(
        "flex h-11 items-center rounded-md border border-border px-4 text-sm text-text",
        FOCUS,
      )}
    >
      Reload
    </a>
  );
}
