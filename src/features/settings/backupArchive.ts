/**
 * Turning the backup archive Rust built into a file the reader keeps.
 *
 * **Two lines of code and a file of reasons, because both lines have a trap in them.** The
 * archive crosses the IPC boundary as base64 — JSON has no bytes — and the browser has no
 * `writeFile`, so getting it onto a reader's disk is `atob`, a `Blob`, and an anchor the page
 * clicks on their behalf.
 *
 * **This should fold into `src/features/transfer/export/files.ts` when that lands.** That module
 * owns the same anchor for the export dialog's download, and two copies of a revoke rule is
 * exactly the drift this repo writes fences against. It is here rather than there only because
 * that file did not exist in this branch's base; the fold is a rename and a re-export.
 */

/**
 * Base64 to bytes.
 *
 * **`atob` answers a string of code units, not bytes**, and handing that string to `Blob`
 * directly would encode every one of them as UTF-8 — which turns every byte above 0x7F into
 * two and corrupts a zip beyond recovery while looking, in a test that only checks the name,
 * exactly like a working download. `charCodeAt` per index is the way back: each code unit is
 * one byte by construction, because that is what `atob` produces.
 */
export function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  // **`new ArrayBuffer(n)` rather than `new Uint8Array(n)`, and the type parameter is why.**
  // Since TypeScript 5.7 a typed array is generic over its buffer, `new Uint8Array(n)` widens
  // to `Uint8Array<ArrayBufferLike>`, and `BlobPart` accepts only `ArrayBufferView<ArrayBuffer>`
  // — so the plain spelling is a `tsc` error naming `SharedArrayBuffer`, which is a buffer this
  // code could not produce if it tried. Allocating the buffer says which one it is.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The archive's MIME type, so the browser and the OS both name it correctly. */
export const ZIP_MIME = "application/zip";

/**
 * Hand the reader a file, through the only door a browser has.
 *
 * **The revoke is deferred, and that is the whole reason this is a function rather than four
 * inline lines.** Revoking the object URL in the same task as the click races the download the
 * click started: some browsers have not yet read the blob, and what the reader gets is a
 * zero-byte file or nothing at all. A `setTimeout(…, 0)` puts the revoke in the next task,
 * after the navigation has been queued. Not revoking at all leaks the whole archive — a
 * megabyte or more — for the life of the document.
 *
 * The anchor is created, clicked and dropped rather than rendered: React has nothing to say
 * about an element that exists for one synchronous call, and an anchor left in the tree would
 * be a tab stop pointing at a URL that is about to be revoked.
 */
export function downloadFile(
  bytes: Uint8Array<ArrayBuffer>,
  fileName: string,
  mime: string,
): void {
  // The **view** and not `bytes.buffer`: the view is what carries the offset and the length, so
  // a subarray stays honest here where the buffer behind it would silently widen to the whole
  // allocation.
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * What to seed the Android save dialog with.
 *
 * **A second spelling of a name Rust already computes, and the duplication is forced rather than
 * chosen.** `mirror::snapshot::archive_name` builds the same string from `SELECT strftime(…)` —
 * but on Android the reader names the destination *before* anything is rendered, so the dialog
 * needs a suggestion at a moment when no archive exists to ask. The browser has the opposite
 * ordering and uses Rust's answer, which is why this function has exactly one caller.
 *
 * Nothing parses either spelling and nothing compares them: both are suggestions a reader may
 * overwrite in the dialog. A device clock a day off its database's costs the file a date, not a
 * card.
 *
 * `toISOString` and not a locale format, because `2026-08-31` sorts in a file manager and
 * `31/08/2026` does not — the same reason Rust writes it that way round.
 */
export function suggestedArchiveName(now: Date = new Date()): string {
  return `mtg-grimoire-backup-${now.toISOString().slice(0, 10)}.zip`;
}

/**
 * `1.4 MB` — what the panel says an archive weighs.
 *
 * Decimal rather than binary units, because a reader comparing this against what their file
 * manager reports is comparing against Windows Explorer, which is the one place they will
 * actually look. One decimal place below 10 units and none above: `1.4 MB` and `340 kB` say
 * something, `1.437 MB` says the same thing with three digits of noise.
 *
 * Bytes are written plainly, because an archive small enough to measure in bytes is an archive
 * something went wrong with and the exact number is the interesting part.
 */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${Math.round(bytes)} bytes`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
