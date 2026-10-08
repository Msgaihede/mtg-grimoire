import type { ImportFile } from "@/lib/ipc";
import { DECKLIST_ACCEPT, downloadText, readDecklistFile } from "../browserFiles";
import type { CallArgs, CallOptions, Core } from "../types";

/** The desktop's save command — `apps/desktop/src-tauri/src/export.rs`, and the Android host's `files.rs`. */
export const SAVE_COMMAND = "export_save_file";

/** The desktop's pick command — `apps/desktop/src-tauri/src/import/mod.rs`, and the Android host's. */
export const PICK_COMMAND = "import_pick_file";

/** What a download is called when the page suggested nothing usable. */
const UNNAMED = "export.txt";

/**
 * The name a download is given: the last component of what the page suggested, or `null` for
 * nothing usable — `grimoire_core::import::suggested_name`, rule for rule, both separators on
 * every platform. A browser strips a path from `download` itself; this keeps the one string the
 * page sends meaning the same thing on every host.
 */
export function suggestedName(raw: string): string | null {
  const name = (raw.split(/[/\\]/).pop() ?? "").trim();
  return name === "" || name === "." || name === ".." ? null : name;
}

/**
 * A refusal as the bare string a Tauri command rejects with, which is what the pages read. By
 * its `message` rather than by `instanceof Error`: a file read fails with a `DOMException`, and
 * not every engine's is an `Error`.
 */
function sentence(error: unknown): string {
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}

/**
 * `export_save_file`, in a browser: **a download, answered `true`.**
 *
 * The desktop's command answers whether a file was written — `false` is a cancelled save
 * dialog. A browser has no dialog to cancel and cannot say whether the download was kept, so
 * `true` here means *handed over*, and that is honest only because of what its one caller draws:
 * `ExportDialog` says nothing after a save on any host — the OS dialog is the desktop's
 * confirmation and the browser's own download shelf is this one's — and reports a rejection. A
 * surface that drew `Saved.` from this boolean would be claiming more than a browser can know;
 * the phone face, which does say what happened, asks `saveText` instead and is told `"handed"`.
 */
function save(args: CallArgs | undefined): Promise<boolean> {
  try {
    const { fileName, contents } = (args ?? {}) as { fileName?: unknown; contents?: unknown };
    if (typeof contents !== "string") throw new Error("there was no text to save.");
    downloadText(suggestedName(typeof fileName === "string" ? fileName : "") ?? UNNAMED, contents);
    return Promise.resolve(true);
  } catch (error) {
    return Promise.reject(sentence(error));
  }
}

/** The picker that is open, if one is: its input, and the way to answer its caller. */
let picking: { input: HTMLInputElement; settle: (file: File | null) => void } | undefined;

/**
 * How long the window may have had focus back, with no word from the picker's input, before the
 * pick is taken as cancelled. A browser that reports a cancel never waits this long, and a
 * `change` arrives with the focus or just after it; the second is for a browser that reports
 * neither. Chosen, not measured in any browser.
 */
export const PICK_FOCUS_GRACE_MS = 1000;

/**
 * `import_pick_file`, in a browser: **a hidden `<input type="file">`, pressed for the reader.**
 *
 * - **A cancelled picker is `null`, not a failure** — the desktop's answer. The input's own
 *   `cancel` event says so, and it is younger than `change` (2023 in Chrome and Safari). On a
 *   browser without it a closed picker says nothing at all, and the Import dialog's button —
 *   which is greyed while this is pending — would stay greyed. So **the window's focus coming
 *   back is the fallback**: a picker takes the focus while it is open, and
 *   {@link PICK_FOCUS_GRACE_MS} after it returns with neither event the input itself is asked —
 *   a file on it is the pick, and none is a cancel. A `change` or a `cancel` inside that moment
 *   wins and ends the wait, so the fallback decides only where both were silent. What it cannot
 *   rule out is a browser that hands the file over later than that after giving the focus back:
 *   that pick would be read as cancelled, and the reader would choose again.
 * - **One picker at a time**: a second ask answers the first with `null`. The dialog cannot make
 *   one while its button is greyed, so this is for a caller that can — a second mount, a script.
 * - **The megabyte and the four readings are `readDecklistFile`'s**, which are `import.rs`'s —
 *   the cap is checked against the file's size before a byte is read, and the bytes are UTF-8,
 *   UTF-16 by its mark, or Windows-1252, with the reading answered beside the text.
 * - **Two failures, two sentences**, as on the desktop: the cap's own, and *That file could not
 *   be read — …* with the browser's reason. `useImport` frames either one.
 * - **The press has to be the reader's.** A browser opens a file picker only inside a user
 *   activation, which outlives the promise hops between the Import dialog's button and here —
 *   it is a window of time, not a call stack — and not a wait on the network.
 *
 * In the document and hidden rather than unattached: an input outside the document does not
 * report `change` in every engine.
 */
function pick(): Promise<ImportFile | null> {
  picking?.settle(null);

  return new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = DECKLIST_ACCEPT;
    input.hidden = true;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const chosen = (): File | null => input.files?.[0] ?? null;
    // The picker has closed, or the reader came back to the window some other way: either way
    // the input is asked once the moment is up, and a file on it is never read as a cancel.
    const onFocus = (): void => {
      clearTimeout(grace);
      grace = setTimeout(() => settle(chosen()), PICK_FOCUS_GRACE_MS);
    };
    const settle = (file: File | null): void => {
      if (picking?.input !== input) return;
      picking = undefined;
      clearTimeout(grace);
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(file);
    };
    picking = { input, settle };
    input.addEventListener("change", () => settle(chosen()));
    input.addEventListener("cancel", () => settle(null));
    document.body.append(input);
    input.click();
    // After the press, so the focus heard is one that came back from the picker.
    window.addEventListener("focus", onFocus);
  }).then((file) =>
    file === null
      ? null
      : readDecklistFile(file).catch((error: unknown) => {
          const said = sentence(error);
          // The cap's sentence is whole; anything else is the browser's reason for a read that
          // failed — a file moved or locked since it was chosen — and needs saying what failed.
          return Promise.reject<ImportFile>(
            said.startsWith("That file") ? said : `That file could not be read — ${said}`,
          );
        }),
  );
}

/**
 * `inner`, with the two file commands answered on the page.
 *
 * **The web host's half of the file seam** (the light-app spec §3.5): the desktop face's Import
 * and Export dialogs ask `import_pick_file` and `export_save_file` through `ipc.ts` on every
 * host, a native host opens a dialog of its own, and the engine's table has neither — a Worker
 * has no document. So they are answered here, in front of the Worker, in the desktop's own
 * result shapes: `ImportFile | null` and `boolean`, a refusal a bare string. Nothing above
 * `@/lib/core` changes, and nothing above it learns which host answered.
 *
 * Neither waits for the database: a file is the page's business, and the dialogs that ask are
 * drawn only past the startup gate anyway.
 */
export function answeringFiles(inner: Core): Core {
  return {
    call<T>(command: string, args?: CallArgs, options?: CallOptions): Promise<T> {
      if (command === SAVE_COMMAND) return save(args) as Promise<T>;
      if (command === PICK_COMMAND) return pick() as Promise<T>;
      return inner.call<T>(command, args, options);
    },
    listen: (event, handler) => inner.listen(event, handler),
  };
}
