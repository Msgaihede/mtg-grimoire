import { downloadText } from "./browserFiles";
import { core, isTableHost } from "./index";

/**
 * **Saving text as a file, on whichever host is answering** — the file half of the `Core` seam
 * (the light-app spec §3.5), arrived with the Android host (phase 4, step 4.3).
 *
 * - **On the light app's Android host** the host answers the desktop's own `export_save_file`
 *   (`apps/light/src-tauri/src/files.rs`): the system's save dialog — the Storage Access Framework —
 *   and a write to the document the reader chose, so the page hears back whether a file was
 *   written.
 * - **In a browser** it is a download (`browserFiles.ts`), which cannot say where the file went
 *   or whether the reader kept it: `"handed"`.
 *
 * The desktop's own export dialog calls `export_save_file` through `ipc.ts` and never this; this
 * is the phone face's, which is one program on every host and asks nothing about which one. **In
 * the web app that command is answered on the page by the same download** (`web/files.ts`), so
 * the desktop face saves there too — and hears `true`, which that dialog draws no sentence from.
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
