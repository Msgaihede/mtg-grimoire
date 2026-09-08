/**
 * A `Uint8Array` as standard base64 — the alphabet and padding Rust's
 * `base64::engine::general_purpose::STANDARD` decodes.
 *
 * **Chunked, because `String.fromCharCode(...bytes)` spreads the whole array onto the call
 * stack and throws `RangeError` somewhere past 100 KB — and a scanner frame is 140 KB.** Only
 * the Android leg of `ipc.scannerFrame` needs this; the desktop leg hands the bytes to Tauri
 * as they are.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
