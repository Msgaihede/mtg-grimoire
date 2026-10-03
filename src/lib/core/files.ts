import { core, isTableHost } from "./index";

/**
 * **Saving text as a file, on whichever host is answering** — the file half of the `Core` seam
 * (the light-app spec §3.5), arrived with the Android host (phase 4, step 4.3).
 *
 * - **On the light app's Android host** the host answers the desktop's own `export_save_file`
 *   (`mobile/src-tauri/src/files.rs`): the system's save dialog — the Storage Access Framework —
 *   and a write to the document the reader chose, so the page hears back whether a file was
 *   written.
 * - **In a browser** it is a download, which cannot say where the file went or whether the reader
 *   kept it: `"handed"`.
 *
 * The desktop's own export dialog calls `export_save_file` through `ipc.ts` and never this; this
 * is the phone face's, which is one program on every host and asks nothing about which one.
 */
export type Saved = "saved" | "cancelled" | "handed";

export async function saveText(
  fileName: string,
  text: string,
  scope: object = globalThis,
): Promise<Saved> {
  if (isTableHost(scope)) {
    const wrote = await core.call<boolean>("export_save_file", { fileName, contents: text });
    return wrote ? "saved" : "cancelled";
  }
  downloadText(fileName, text);
  return "handed";
}

/**
 * Hand `text` to the browser as a file called `fileName` — a `Blob`, an object URL and an
 * `<a download>` pressed once, then the URL released.
 *
 * **Where it lands is the browser's**: a download folder, or a save prompt where the reader has
 * asked for one. There is no answer to wait for and no cancel to report — the desktop's
 * `saveExport` answers whether a file was written; a download cannot, so this resolves when the
 * browser has been handed the file.
 *
 * Plain text in UTF-8, which is what every writer in `export/` emits and every reader of a
 * decklist expects.
 */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  // Off-screen rather than unattached: an anchor outside the document is not pressed by every
  // engine.
  link.style.display = "none";
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // After the press has been handed over, not before — revoking in the same task can cancel
    // the download it started.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
