import type { JSX } from "react";
import { openExternal } from "@/lib/externalLinks";
import { SyncPanelBody } from "./SyncPanelBody";

/**
 * The panel's pure halves — the relay and supporter sentences, the warnings — are read from here
 * by its suite and its stories, as they were before the panel moved into `SyncPanelBody.tsx`.
 */
export * from "./SyncPanelBody";

/**
 * Sync: {@link SyncPanelBody} with the app's way of opening a link, on both faces.
 *
 * **Split while a link was the desktop's alone.** `openExternal` was `@tauri-apps/plugin-opener`
 * itself, which the light app's phone face may not reach, so the one import that welded the panel
 * to the desktop lived here and that face handed the body a `window.open` of its own. Since phase
 * 5 (step 5.4) how a link leaves is the host's, below `@/lib/core`, and the phone face draws this
 * component too. The body keeps the prop, which is how its suite watches the press.
 */
export function SyncPanel(): JSX.Element {
  return <SyncPanelBody openLink={openExternal} />;
}
