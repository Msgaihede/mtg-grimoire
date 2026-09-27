/**
 * The two file handles a transfer needs.
 *
 * **This module exists because "pick a file" and "save a file" are the only two things in
 * `transfer/` that are not pure TypeScript over strings.** Everything else here — the parser, the
 * planner, the seven writers, the field registry — reaches the backend only for `import_resolve`
 * and the commits, so `ImportDialog` and `ExportDialog` call this and know nothing about how a
 * file is picked or written.
 *
 * **A picker answers a _name_ and Rust opens it.** `dialog:allow-open` and `dialog:allow-save`
 * are the only two dialog verbs this app grants, and **no `fs:` permission is granted anywhere on
 * purpose** — a page that read the bytes itself would need one. So each handle is two steps:
 * `open()`/`save()` answers a path, and `import_read_file`/`export_write_file` does the I/O.
 *
 * The *picking* and the *reading* stay two steps because the two failures are two different
 * sentences the reader can act on — a picker that would not open, and a file that would not
 * read. Collapsing them would put "that file is too big" behind "could not open the file
 * picker". The 1 MB cap is `import.rs`'s, and so is the decode: `String::from_utf8_lossy`
 * answers `U+FFFD` for a byte it cannot read, so a Windows-1252 apostrophe costs one card line
 * rather than the other hundred.
 */
import { open as pickNative, save as saveNative } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/lib/ipc";

/**
 * The extensions the picker offers.
 *
 * A decklist is text; the other three are what the desktop clients have always written one as
 * (`.dec` MTGO, `.dek` Arena, `.csv` a spreadsheet export).
 */
export const DECKLIST_EXTENSIONS = ["txt", "dec", "dek", "csv"];

/**
 * Ask the reader for a decklist, and answer the path they chose. `null` is a cancelled picker,
 * which is not a failure — it is the most ordinary way to use a file dialog after changing your
 * mind.
 */
export async function pickDecklist(): Promise<string | null> {
  return await pickNative({
    multiple: false,
    directory: false,
    title: "Choose a decklist",
    filters: [{ name: "Decklist", extensions: DECKLIST_EXTENSIONS }],
  });
}

/** The text behind a path {@link pickDecklist} answered. */
export function readDecklist(path: string): Promise<string> {
  return ipc.importReadFile(path);
}

/**
 * Put `text` somewhere the reader chose, under `fileName`.
 *
 * Resolves either way on a cancelled save dialog — a reader who backs out of the picker has not
 * hit a failure, and the export is still on screen and still copyable.
 */
export async function saveExport(fileName: string, text: string): Promise<void> {
  // `save()` answers `null` on Cancel, and writing *that* string to disk is the bug this guard
  // exists to prevent.
  const path = await saveNative({ defaultPath: fileName });
  if (path === null) return;
  await ipc.exportWriteFile(path, text);
}
