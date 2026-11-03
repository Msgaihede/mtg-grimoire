import { useEffect, useEffectEvent } from "react";
import { useAppStore, type ViewId } from "@/lib/store";

/**
 * **Walk a page back to its root when the reader re-presses its rail entry** (issue #1507) — the
 * store's `rootRequest`, answered and spent.
 *
 * `toRoot` is the page's own way home (the top-level drawer, the hub); it runs on the commit the
 * request is seen, including the commit a page mounts on, because a re-press from an editor swaps
 * the editor for the page and the page is the one that has to hear it. The request is spent
 * either way, so it fires once per press.
 *
 * Only a page with somewhere nested to stand calls this. The places the store already holds — an
 * open deck, the goldfish board, a draft deck's editor — are closed by the press itself
 * (`setActiveView`, `selectView`); this is for the ones a page keeps in its own `useState`.
 */
export function useViewRootRequest(view: ViewId, toRoot: () => void): void {
  const asked = useAppStore((s) => s.rootRequest === view);
  const clearRootRequest = useAppStore((s) => s.clearRootRequest);
  const onRoot = useEffectEvent(toRoot);
  useEffect(() => {
    if (!asked) return;
    onRoot();
    clearRootRequest();
  }, [asked, clearRootRequest]);
}
