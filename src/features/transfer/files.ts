/**
 * The two file handles a transfer needs, and the two mechanisms that answer them.
 *
 * **This module exists because "pick a file" and "save a file" are the only two things in
 * `transfer/` that are not the same on every target.** Everything else here — the parser, the
 * planner, the seven writers, the field registry — is pure TypeScript over strings, and reaches
 * the backend only for `import_resolve` and the commits, which are ordinary SQLite and are
 * already routed on the web target. So the whole of the web port of import and export is this
 * file, and `ImportDialog` and `ExportDialog` change by one call each.
 *
 * ## Why the two branches are not the same shape
 *
 * **On desktop and Android a picker answers a _name_ and Rust opens it.** `dialog:allow-open`
 * and `dialog:allow-save` are the only two dialog verbs this app grants, and **no `fs:`
 * permission is granted anywhere on purpose** — a page that read the bytes itself would need
 * one. So the native branch is two steps: `open()`/`save()` answers a path, and
 * `import_read_file`/`export_write_file` does the I/O. `src-tauri/src/picked.rs` is the one
 * place that knows an Android picker answers a `content://` URI rather than a path, which is
 * why neither branch here has to.
 *
 * **In a browser it is the other way round: the page is the only thing that _can_ read the
 * file, and there is no path at all.** An `<input type=file>` hands over a `File` the user
 * agent has already granted this page, and a `Blob` behind an `<a download>` hands one back —
 * both of them the browser's own consent mechanism rather than an ACL, and neither of them
 * reachable from Rust. `import_read_file` and `export_write_file` are therefore **not routed on
 * the web target and must not be**: there is no path to give them. (Spec §6.2.)
 *
 * ## What is deliberately shared, and what is deliberately doubled
 *
 * The *picking* and the *reading* stay two steps on both branches, because the two failures are
 * two different sentences the reader can act on — a picker that would not open, and a file that
 * would not read. Collapsing them would put "that file is too big" behind "could not open the
 * file picker".
 *
 * {@link MAX_IMPORT_BYTES} and its refusal are a **second copy** of `import.rs`'s
 * `read_bounded`, and that is the honest shape rather than drift: on this branch no Rust
 * command is in the path at all, so the cap has to be applied by whoever is holding the bytes.
 * The Rust half reads `MAX + 1` and measures what it got, because a `content://` URI has no
 * size to stat; a `File` carries its size, so this half asks before it reads anything. The
 * sentence is the same one on purpose — the reader must not be able to tell which build refused
 * them.
 *
 * The decode is lossy on both branches for the same reason: `String::from_utf8_lossy` and
 * `Blob.text()`'s UTF-8 decoder both answer `U+FFFD` for a byte they cannot read, so a
 * Windows-1252 apostrophe costs one card line rather than the other hundred.
 */
import { open as pickNative, save as saveNative } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/lib/ipc";
import { isWebTarget } from "@/pwa/target";

/**
 * The extensions the picker offers.
 *
 * A decklist is text; the other three are what the desktop clients have always written one as
 * (`.dec` MTGO, `.dek` Arena, `.csv` a spreadsheet export). One list, spelled two ways below
 * because the two mechanisms want two spellings — `filters` takes bare extensions and `accept`
 * takes a comma-joined list of suffixes — and never two lists.
 */
export const DECKLIST_EXTENSIONS = ["txt", "dec", "dek", "csv"];

/** {@link DECKLIST_EXTENSIONS} as an `<input type=file>` `accept` list. */
export const DECKLIST_ACCEPT = DECKLIST_EXTENSIONS.map((e) => `.${e}`).join(",");

/**
 * The import ceiling, in bytes — `import.rs`'s `MAX_IMPORT_BYTES`, to the byte.
 *
 * A decklist is text. The number is a mebibyte and the sentence below says "1 MB", exactly as
 * the Rust half's does: that message is built with an integer division by 1 000 000, so the two
 * agree on the words as well as on the limit.
 */
export const MAX_IMPORT_BYTES = 1024 * 1024;

/** The refusal, in the words `import.rs` refuses with. */
export const TOO_LARGE =
  `That file is over ${Math.floor(MAX_IMPORT_BYTES / 1_000_000)} MB. ` +
  `A decklist is text; this reads at most 1 MB.`;

/**
 * What a picker answered: a **name** the backend will open, or a **file** this page already
 * holds. Nothing downstream branches on it except {@link readDecklist}.
 */
export type PickedDecklist =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "file"; readonly file: File };

/**
 * Ask the reader for a decklist. `null` is a cancelled picker, which is not a failure — it is
 * the most ordinary way to use a file dialog after changing your mind.
 *
 * **Nothing is awaited before the picker is opened**, on either branch, and on the web one that
 * is load-bearing: `input.click()` has to run inside the task the reader's own click started,
 * or the browser refuses to open a picker at all.
 */
export async function pickDecklist(): Promise<PickedDecklist | null> {
  if (isWebTarget()) {
    const file = await chooseInBrowser();
    return file === null ? null : { kind: "file", file };
  }
  const path = await pickNative({
    multiple: false,
    directory: false,
    title: "Choose a decklist",
    filters: [{ name: "Decklist", extensions: DECKLIST_EXTENSIONS }],
  });
  return path === null ? null : { kind: "path", path };
}

/** The text behind whatever {@link pickDecklist} answered. */
export async function readDecklist(picked: PickedDecklist): Promise<string> {
  if (picked.kind === "path") return ipc.importReadFile(picked.path);
  // Asked before a byte is read, which is the one thing this branch can do that the Rust half
  // cannot: a `File` knows its size, so a 200 MB mistake costs nothing at all rather than the
  // megabyte `read_bounded` spends proving it is over the line.
  if (picked.file.size > MAX_IMPORT_BYTES) throw new Error(TOO_LARGE);
  return picked.file.text();
}

/**
 * Put `text` somewhere the reader chose, under `fileName`.
 *
 * Resolves either way on a cancelled save dialog — a reader who backs out of the picker has not
 * hit a failure, and the export is still on screen and still copyable.
 *
 * **The web branch cannot be cancelled and cannot report success.** A download is handed to the
 * user agent and the page is told nothing afterwards, which is why this answers `void` on both
 * branches rather than a boolean nothing could honestly fill in.
 */
export async function saveExport(fileName: string, text: string): Promise<void> {
  if (isWebTarget()) {
    downloadInBrowser(fileName, text);
    return;
  }
  // `save()` answers `null` on Cancel, and writing *that* string to disk is the bug this guard
  // exists to prevent.
  const path = await saveNative({ defaultPath: fileName });
  if (path === null) return;
  await ipc.exportWriteFile(path, text);
}

/**
 * The browser's own file picker, as a promise.
 *
 * **`cancel` is what closes the promise when the reader backs out**, and it is a real event on
 * every engine this target already requires — the same generation that brought the OPFS
 * synchronous access handles the database runs on. Without it the promise would simply never
 * settle: a file input reports nothing at all when its dialog is dismissed, which is why
 * "detect the cancel with a `window` focus timer" is folklore rather than an API. If an engine
 * ever did withhold it, the cost is one disabled `Choose file…` button until the dialog is
 * closed and reopened — the paste box beside it is untouched.
 *
 * The input is **attached** rather than clicked while detached: engines have differed about
 * whether a detached input opens a picker at all, and `hidden` (a content attribute) keeps it
 * off screen without an inline `style`.
 */
function chooseInBrowser(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = DECKLIST_ACCEPT;
    input.hidden = true;
    const settle = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => settle(input.files?.item(0) ?? null), { once: true });
    input.addEventListener("cancel", () => settle(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

/**
 * A `Blob` and an `<a download>` — the browser's answer to a save dialog.
 *
 * **The object URL is revoked on a later task, not on the next line.** Revoking it
 * synchronously after `click()` races the user agent's own fetch of the blob, and the download
 * that loses that race fails with nothing on screen to say why.
 *
 * `text/plain` with an explicit charset, because the seven writers emit UTF-8 and a `Blob` with
 * no type is served as `application/octet-stream` — which some engines then decline to name
 * with the `download` attribute's own filename.
 */
function downloadInBrowser(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
