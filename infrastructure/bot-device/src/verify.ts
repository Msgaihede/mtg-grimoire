/**
 * **Discord's signature, checked again inside the Durable Object** (the Discord spec §9, §10).
 *
 * The front checks every interaction before it forwards one; this checks the same signature over
 * the same bytes once more, here, beside the keys — so a front that was compromised, or a bug in
 * its routing, cannot make this object answer an interaction Discord never sent. The front holds
 * no key worth stealing; this does.
 *
 * Ed25519 over `timestamp ‖ body`, the public key and the signature in hex (Discord's own scheme),
 * with WebCrypto's Ed25519 — workerd's and Node's alike, so a test runs the very code a deploy does.
 */

/** How far an interaction's timestamp may be from this clock, in seconds. Discord sends an
 *  interaction within a second of stamping it; ten minutes is a replay window and no more. */
export const MAX_SKEW_SECS = 10 * 60;

/** Hex as bytes, or `null` when it is not an even run of hex digits. */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let at = 0; at < bytes.length; at += 1) {
    bytes[at] = Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Whether `signature` is Discord's over `timestamp + body` under `publicKeyHex`, and the timestamp
 * is within {@link MAX_SKEW_SECS} of `nowMs`. Any malformed input is `false`, never a throw.
 */
export async function discordSigned(
  publicKeyHex: string,
  body: string,
  signature: string,
  timestamp: string,
  nowMs: number,
): Promise<boolean> {
  const key = hexToBytes(publicKeyHex);
  const sig = hexToBytes(signature);
  if (key?.length !== 32 || sig?.length !== 64) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_SECS) return false;
  try {
    const imported = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const message = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify({ name: "Ed25519" }, imported, sig, message);
  } catch {
    return false;
  }
}
