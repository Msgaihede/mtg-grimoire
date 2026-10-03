/**
 * How a file gets **into** the phone face, and how text reaches the clipboard — a `File` from an
 * `<input type="file">` read as text, and `navigator.clipboard`. **Saving moved below the `Core`
 * seam in phase 4** (`@/lib/core/files`): a browser downloads, the Android host opens the system's
 * save dialog. Picking needed no seam — Android's WebView answers an `<input type="file">` with the
 * system picker and hands the page a `File` for the `content://` document, as a browser does.
 *
 * **A stand-in, and a deliberate one.** The light-app spec puts file open and save below the
 * `Core` seam (§3.5): the desktop answers with Rust opening the native dialog
 * (`src/features/transfer/files.ts`, `import_pick_file` / `export_save_file`), an Android host
 * will answer with the system picker, and the web host with exactly what is written here. Phase 3
 * has no host seam for it yet — no new command and no Rust this phase — so the phone face uses the
 * web answer directly, and every install draws the same two controls. When phases 4 and 5 give
 * `@/lib/core` a file seam, this module is what moves behind it; nothing that calls it decides
 * anything about where it is running, and nothing here may start.
 *
 * **Not in `src/lib/`**, because no desktop surface can share it: the desktop's whole point
 * (issue #545) is that no path and no file handle reaches the page, and its clipboard is the
 * Tauri plugin `@/lib/clipboard` names, for that module's own reason.
 */
import type { ImportFile } from "@/lib/ipc";

/**
 * The most a decklist file may be — `import.rs`'s `MAX_IMPORT_BYTES`, the same megabyte the
 * desktop's read and the paste path are held to, so the two faces cannot disagree about how long
 * a decklist may be. Checked against `File.size` before a byte is read: a 200 MB file picked by
 * mistake costs nothing.
 */
export const MAX_DECKLIST_BYTES = 1024 * 1024;

/**
 * What the picker offers. The desktop dialog's four (`import.rs`'s `DECKLIST_EXTENSIONS`) and the
 * two MIME types a phone's picker files them under — **a hint and not a fence**, like the desktop
 * filter: a browser may still hand over anything the reader chooses, and the parser reads it.
 *
 * **`application/octet-stream` is for Android** (phase 4): its WebView maps each extension through
 * `MimeTypeMap` and drops the ones it does not know, so `.dec` and `.dek` were greyed out — and the
 * system picker types a file of an unknown extension as `application/octet-stream`. A browser
 * reads the same hint and still offers the rest.
 */
export const DECKLIST_ACCEPT = ".txt,.dec,.dek,.csv,text/plain,text/csv,application/octet-stream";

/**
 * Windows-1252's `0x80`–`0x9F`, the only 32 bytes where it is not Latin-1 — `import.rs`'s
 * `CP1252_HIGH`, entry for entry, with the five bytes the code page leaves undefined mapped to the
 * C1 control of the same number (WHATWG's rule), so no byte is ever lost.
 *
 * **Written out rather than left to `TextDecoder("windows-1252")`**, which is what a browser would
 * do and is not something every engine gets right: Node's decoder reads that label as Latin-1 and
 * turns `0x92` into a C1 control rather than `’` — measured in this file's own test, which went
 * red on it. A table cannot disagree with itself between engines, and it is the backend's.
 */
// prettier-ignore
const CP1252_HIGH: readonly string[] = [
  "\u20AC", "\u0081", "\u201A", "\u0192", "\u201E", "\u2026", "\u2020", "\u2021",
  "\u02C6", "\u2030", "\u0160", "\u2039", "\u0152", "\u008D", "\u017D", "\u008F",
  "\u0090", "\u2018", "\u2019", "\u201C", "\u201D", "\u2022", "\u2013", "\u2014",
  "\u02DC", "\u2122", "\u0161", "\u203A", "\u0153", "\u009D", "\u017E", "\u0178",
];

/** The sentence `import.rs` refuses an oversized file with, word for word. */
const TOO_BIG = "That file is over 1 MB. A decklist is text; this reads at most 1 MB.";

/**
 * A decklist file's bytes as text, in `import.rs`'s order — and answering which reading it took,
 * because the last one is a guess only the reader can check (issue #555):
 *
 * 1. a UTF-8 byte-order mark is UTF-8, mark stripped, a malformed byte after it damage (`U+FFFD`);
 * 2. a UTF-16 mark, `FF FE` or `FE FF`, is UTF-16 in that order;
 * 3. valid UTF-8 is UTF-8;
 * 4. anything else is **Windows-1252**, never decoded lossily — {@link CP1252_HIGH}.
 *
 * `TextDecoder` reads the first three, and `fatal` is what tells step 3 from step 4.
 */
export function decodeDecklist(bytes: Uint8Array): ImportFile {
  const [a, b, c] = bytes;
  if (a === 0xef && b === 0xbb && c === 0xbf) {
    // The decoder strips the mark itself (`ignoreBOM` is false by default).
    return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8" };
  }
  if (a === 0xff && b === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le" };
  }
  if (a === 0xfe && b === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "utf-16be" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    let text = "";
    for (const byte of bytes) {
      text += byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : String.fromCharCode(byte);
    }
    return { text, encoding: "windows-1252" };
  }
}

/**
 * A file the reader picked, as a decklist. Rejects with `import.rs`'s own sentence for a file over
 * the cap, and with the browser's for one it could not read — the phone sheet frames either as
 * "Couldn't read a decklist from a file — …", the desktop dialog's frame, true of both.
 */
export async function readDecklistFile(file: File): Promise<ImportFile> {
  if (file.size > MAX_DECKLIST_BYTES) throw new Error(TOO_BIG);
  return decodeDecklist(new Uint8Array(await file.arrayBuffer()));
}

/**
 * Put `text` on the clipboard. **Rejects rather than pretending**: the API is absent outside a
 * secure context and a browser may refuse the write, and the export sheet says either in the
 * same line a refused copy takes on the desktop.
 */
export async function copyToClipboard(text: string): Promise<void> {
  // A browser that has no clipboard API (an insecure origin) leaves the property undefined.
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard === undefined) throw new Error("this browser offers no clipboard here.");
  await clipboard.writeText(text);
}
