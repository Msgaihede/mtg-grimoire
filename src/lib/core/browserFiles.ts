/**
 * **What a browser does with a file**: a `File` from an `<input type="file">` read as a decklist,
 * and text handed back as a download. The file half of the `Core` seam's browser arm (the
 * light-app spec §3.5), and a leaf — it imports nothing of the seam, so both of its readers can
 * import it without a cycle.
 *
 * **Two readers, one decode.** The phone face picks through an `<input>` of its own on every
 * host — Android's WebView answers one with the system picker and hands the page a `File` for the
 * `content://` document, as a browser does — and reads what it was handed with
 * {@link readDecklistFile}. The desktop face asks `import_pick_file` and `export_save_file`, which
 * a native host answers with a dialog it opens itself; in the web app `web/files.ts` answers both
 * on the page, with the read and the download written here.
 *
 * It was `mobile/phone/transfer/browserFiles.ts` until the web host needed the same megabyte and
 * the same four readings (phase 5, step 5.4). The clipboard it also carried is `@/lib/clipboard`'s
 * now, on both faces.
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
 * How long a download's object URL is kept before it is released.
 *
 * **A browser reads the `Blob` through the URL after the press, on its own schedule** — at once
 * in the Chrome this was driven in, and after a save prompt or a "keep this file?" bar in
 * others — and a URL revoked before that read is a download that fails or lands empty. Nothing
 * says when the read is done, so the release is a wait: forty seconds, FileSaver.js's figure for
 * the same reason, and since step 5.4 the wait behind the desktop face's Save in every browser.
 * It was a single task, which only headless Chrome had been asked to survive. The cost of
 * waiting is one decklist's text kept in memory that much longer.
 */
export const DOWNLOAD_URL_LIFE_MS = 40_000;

/**
 * Hand `text` to the browser as a file called `fileName` — a `Blob`, an object URL and an
 * `<a download>` pressed once, then the URL released ({@link DOWNLOAD_URL_LIFE_MS} later).
 *
 * **Where it lands is the browser's**: a download folder, or a save prompt where the reader has
 * asked for one. There is no answer to wait for and no cancel to report — a native save dialog
 * answers whether a file was written; a download cannot, so this returns when the browser has
 * been handed the file.
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
    // Long after the press, not beside it: see `DOWNLOAD_URL_LIFE_MS`.
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFE_MS);
  }
}
