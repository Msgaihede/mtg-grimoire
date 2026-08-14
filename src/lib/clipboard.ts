/**
 * The only place this app names the clipboard.
 *
 * `tauri-plugin-clipboard-manager` rather than `navigator.clipboard`, deliberately. The web
 * API *should* work — `http://tauri.localhost` is a subdomain of localhost and therefore a
 * secure context — but nothing in this app had ever proved it, and the failure mode would be
 * the packaged exe only: green in dev, green in Storybook, green in jsdom, silent in the
 * shipped window. The plugin costs one narrow permission (`clipboard-manager:allow-write-text`,
 * and not the read) and removes the class of surprise entirely.
 *
 * One function because one direction: nothing in this app reads the clipboard, which is why
 * `allow-read-text` is not granted.
 *
 * Nothing is copied until the reader presses the menu item — this module never calls itself.
 */
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export async function copyText(text: string): Promise<void> {
  await writeText(text);
}
