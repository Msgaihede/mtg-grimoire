/**
 * The only place a page names the clipboard.
 *
 * **Whose clipboard is the host's to answer** (`@/lib/core`, the light-app spec §3.5): Tauri's
 * clipboard plugin on the desktop — `core/tauri.ts` has why it is the plugin and not
 * `navigator.clipboard` there — and `navigator.clipboard` in a browser and on the light app's
 * Android host, which has no such plugin. Both faces of the light app copy through here, so a
 * copy is refused in one sentence wherever it is refused.
 *
 * One function because one direction: nothing in this app reads the clipboard, which is why
 * `allow-read-text` is not granted.
 *
 * Nothing is copied until the reader presses the menu item — this module never calls itself.
 */
import { host } from "@/lib/core";

export async function copyText(text: string): Promise<void> {
  await host.copyText(text);
}
