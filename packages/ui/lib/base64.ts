/**
 * Bytes as standard base64, in chunks so a camera frame never overflows an argument list.
 *
 * A module of its own because it has two callers that share nothing else: the light host's
 * transport (`core/table.ts`), which crosses every raw body this way, and the scanner's Send
 * (`features/scanner/submit`), which sends its one picture as text and draws it from the same
 * text. It imports nothing, so reaching it pulls no host's code in.
 */
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    text += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(text);
}
