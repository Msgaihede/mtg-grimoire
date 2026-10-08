/**
 * The two file handles a transfer needs.
 *
 * **This module exists because "pick a file" and "save a file" are the only two things in
 * `transfer/` that are not pure TypeScript over strings.** Everything else here — the parser, the
 * planner, the seven writers, the field registry — reaches the backend only for `import_resolve`
 * and the commits, so `ImportDialog` and `ExportDialog` call this and know nothing about how a
 * file is picked or written.
 *
 * **Rust opens the dialog and does the I/O, and no path ever reaches this side** (issue #545).
 * Each handle is one command: `import_pick_file` shows the OS open dialog and answers the text of
 * the file chosen there, and `export_save_file` shows the save dialog and writes at the path it
 * answered. The page grants itself nothing to make that work — **no `dialog:` and no `fs:`
 * permission is granted anywhere**, on purpose. Until 2026-09-28 each handle was two steps, the
 * plugin's `open()`/`save()` answering a path here and `import_read_file`/`export_write_file`
 * reading or writing it, and that shape was the hole: a command that takes a path from the page
 * takes whatever path a script in the page sends, so it was a read of any text file on the disk
 * and a write anywhere the reader could write. The dialog grants fenced which windows the page
 * could summon and nothing about the paths.
 *
 * **The picker failing and the file failing are still two sentences**, which is what the two
 * steps used to buy: "that file is over 1 MB" must never arrive worded as a broken picker, nor
 * the other way round. Rust says which in the rejection itself — "The file picker could not be
 * opened — …" against `import.rs`'s "That file could not be opened — …" or its 1 MB refusal — so
 * a caller frames either with words that are true of both. The 1 MB cap is `import.rs`'s, and so
 * is the decode (issue #555): a byte-order mark is honoured, valid UTF-8 is UTF-8, and anything
 * else is read as Windows-1252 rather than lossily — so an `é` in Excel's Western European "CSV"
 * is an `é` and not `U+FFFD`. The read answers **which** of those it took, because the last one is
 * a guess only the reader can check. The dialog's title, its "Decklist" filter and the four
 * extensions under it are `import.rs`'s too now (`DECKLIST_EXTENSIONS`), because the dialog is.
 */
import { ipc, type ImportFile } from "@/lib/ipc";

/**
 * Ask the reader for a decklist, and answer its text and the encoding it was read in. `null` is
 * a cancelled picker, which is not a failure — it is the most ordinary way to use a file dialog
 * after changing your mind.
 *
 * The encoding rides along rather than being dropped here because `windows-1252` is the one
 * reading `import.rs` *chose* rather than was told — a file in some other legacy code page reads
 * as the wrong letters under it — and the dialog says so beside the text it put in the box.
 */
export function chooseDecklist(): Promise<ImportFile | null> {
  return ipc.importPickFile();
}

/**
 * Put `text` somewhere the reader chooses, suggesting `fileName`. Resolves `true` when a file was
 * written and `false` for a cancelled save dialog — a reader who backs out of the picker has not
 * hit a failure, and the export is still on screen and still copyable.
 *
 * `fileName` is a name and never a place: Rust keeps its last component and nothing else.
 */
export function saveExport(fileName: string, text: string): Promise<boolean> {
  return ipc.exportSaveFile(fileName, text);
}
