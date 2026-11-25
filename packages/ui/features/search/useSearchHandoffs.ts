import { useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { onSearchShow } from "@/lib/window";

/**
 * Hand every search an agent asked this window to show (`search:show`) to the store, which opens
 * the Search page on it. Desktop only: the light app has no MCP server, so it never calls this.
 *
 * The subscription is async, so an unmount (or StrictMode's first mount being torn down) can land
 * before it resolves; `cancelled` then unsubscribes the moment it does.
 */
export function useSearchHandoffs(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onSearchShow((handoff) => useAppStore.getState().showSearchHandoff(handoff)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
