import type { JSX } from "react";
import { openExternal } from "@/lib/externalLinks";
import { SyncPanelBody } from "./SyncPanelBody";

/**
 * The panel's pure halves — the relay and supporter sentences, the warnings — are read from here
 * by its suite and its stories, as they were before the panel moved into `SyncPanelBody.tsx`.
 */
export * from "./SyncPanelBody";

/**
 * Sync, on the desktop: {@link SyncPanelBody} with the desktop's way of opening a link.
 *
 * **Split so the light app's phone face can draw the same panel.** That face may not reach
 * `@tauri-apps/*` except through `@/lib/core`, and `openExternal` is the plugin-opener — so the
 * one import that welded the panel to the desktop lives here, and everything the panel draws lives
 * in the file the phone face imports. Every desktop caller still writes `<SyncPanel />`.
 */
export function SyncPanel(): JSX.Element {
  return <SyncPanelBody openLink={openExternal} />;
}
