import { boundedBytes } from "./env";

/**
 * Discord's signature on an interaction: Ed25519 over `X-Signature-Timestamp` followed by the
 * body, byte for byte, against the application's public key.
 *
 * **Checked before a byte of the body is read as JSON**, and that order is the whole point: the
 * Interactions Endpoint URL is public, and anything that parsed first would be parsing a
 * stranger's text. Discord also probes the endpoint with bad signatures when the URL is saved
 * and now and then after, and will not keep an endpoint that does not answer them 401.
 *
 * **The bot's Durable Object checks it again, over the same bytes** (the design, §13.2): this
 * check is what keeps a stranger's request off the database and the Durable Object, and that one
 * is what keeps a front that has been tampered with from speaking for Discord. So what is
 * forwarded is the body as text exactly as it arrived and the two headers as they were sent.
 *
 * WebCrypto's own `Ed25519` — workerd and Node both have it — so there is no dependency and no
 * hand-rolled curve arithmetic here.
 */

/**
 * The largest body this Worker will verify. An interaction is a few kilobytes — an
 * autocomplete's options, a command's resolved data — and the cap is what keeps an unsigned
 * stranger's body from being buffered whole before the 401. Counted as it streams.
 */
export const MAX_INTERACTION_BYTES = 64 * 1024;

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
 * The public key, imported once per isolate. Keyed by its hex so a test that verifies against
 * two keys, or a redeploy that changes the var, never reads another key's import.
 */
const imported = new Map<string, Promise<CryptoKey>>();

function publicKey(hex: string, bytes: Uint8Array): Promise<CryptoKey> {
  let key = imported.get(hex);
  if (key === undefined) {
    key = crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
    imported.set(hex, key);
    // A key that would not import is not one to remember: the next request tries again.
    key.catch(() => imported.delete(hex));
  }
  return key;
}

/** A request Discord signed: its body as the text it was, and the two headers as they came. */
export interface Signed {
  body: string;
  signature: string;
  timestamp: string;
}

/**
 * The interaction, when Discord signed it — `null` for anything else: a missing or malformed
 * header, a body past {@link MAX_INTERACTION_BYTES}, a body that is not UTF-8, a signature that
 * does not verify, a key that does not import. One answer for all of them, so a probe learns
 * nothing from which.
 *
 * **A body that is not UTF-8 is refused rather than repaired**, because the Durable Object is
 * handed the text and verifies again over its bytes: a decode that replaced a byte would forward
 * an interaction that no longer matches its signature. Discord's bodies are JSON, so UTF-8.
 */
export async function verified(request: Request, publicKeyHex: string): Promise<Signed | null> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (signature === null || timestamp === null || timestamp === "") return null;
  const signatureBytes = hexToBytes(signature);
  const keyBytes = hexToBytes(publicKeyHex);
  if (signatureBytes?.length !== 64 || keyBytes?.length !== 32) return null;

  const body = await boundedBytes(request, MAX_INTERACTION_BYTES);
  if (body === null) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return null;
  }

  const stamp = new TextEncoder().encode(timestamp);
  const message = new Uint8Array(stamp.byteLength + body.byteLength);
  message.set(stamp, 0);
  message.set(body, stamp.byteLength);

  try {
    const key = await publicKey(publicKeyHex.toLowerCase(), keyBytes);
    const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, message);
    return valid ? { body: text, signature, timestamp } : null;
  } catch {
    return null;
  }
}
