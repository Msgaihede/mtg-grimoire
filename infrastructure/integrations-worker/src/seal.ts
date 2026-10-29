import { CLEAR_COLUMNS_VERSION } from "./projection";

/**
 * What a group's store keeps sealed, and under what (plan §2): **envelope encryption**.
 *
 * - **A data key per group**: 32 random bytes, made when the group's store is, and stored
 *   **wrapped** — AES-256-GCM under `INTEGRATIONS_KEK`, with the group id as the associated data,
 *   so a wrapped key copied into another group's object does not open there.
 * - **A key per table generation**: HKDF-SHA-256 of the data key, naming the table and the
 *   generation (`store.ts` takes a new generation for every replacement that seals a row). So no
 *   one key ever seals more than one publish's changed rows of one table, and the random 96-bit
 *   nonces under any key number in the tens of thousands, not the billions where they would
 *   start to meet.
 * - **A row**: AES-256-GCM under its table generation's key, a random 12-byte nonce, the
 *   associated data `table \0 uid` — so a sealed body moved to another row, or another table,
 *   does not open — stored as `nonce ‖ ciphertext`, beside the generation it was sealed in.
 * - **A row's MAC**: HMAC-SHA-256 of its canonical JSON under a key of its own, drawn from the
 *   data key ({@link macKey}). It is how a replacement finds the rows that did not change and
 *   leaves them as they are — not opened, not sealed again, not written (`store.ts`).
 *
 * **AES-GCM and not XChaCha20-Poly1305**, which the issue named: WebCrypto has no XChaCha, and
 * the Worker-side sealing the issue said to lift (the Discord branch's
 * `infrastructure/bot-device/src/proposals.ts`) is this, AES-GCM under an HKDF key.
 *
 * **What it protects against is a storage dump alone** (the spec's §6.1, the hardened knob): a
 * copy of the object's SQLite without the Worker's secret is the clear index columns and
 * noise. Cloudflare, running this Worker with its secret, can read every row — the privacy
 * sentence the app shows says so.
 *
 * **The KEK can be rotated**, because only data keys are under it: {@link rewrap} opens a wrapped
 * key under the old KEK and wraps it under the new one, and `store.ts` does that on any request
 * to a store whose key was wrapped under `INTEGRATIONS_KEK_PREVIOUS`. The rows never move. The
 * README's *Rotating the KEK* is the procedure.
 */

/** Base64url, unpadded. */
export function toBase64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64url (padded or not) as bytes, or `null` when it is not base64url. */
export function fromBase64url(text: string): Uint8Array | null {
  const plain = text.trim().replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*$/.test(plain) || plain.length % 4 === 1) return null;
  try {
    const binary = atob(plain + "=".repeat((4 - (plain.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A nonce's length: GCM's 96 bits, which is the one length it was designed around. */
const IV_BYTES = 12;

/** The HKDF salt every table generation's key is drawn with — a version, so a v2 is apart. */
const ROW_SALT = encoder.encode("mtg-grimoire/integrations/row/v1");

/**
 * A secret that should be 32 bytes of base64url, as an AES-256-GCM key — or a throw that names
 * the binding. **Never a fallback**: a store sealed under a key derived from a missing secret
 * would be readable by anyone with the source, and would not open once the real secret was set.
 */
export async function importKek(secret: string | undefined, name: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret === "") {
    throw new Error(`the integrations Worker is missing its ${name} binding`);
  }
  const bytes = fromBase64url(secret);
  if (bytes?.length !== 32) {
    throw new Error(`the integrations Worker's ${name} binding is not 32 bytes of base64url`);
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * The first sixteen hex characters of SHA-256 over a KEK's bytes: which KEK a data key is
 * wrapped under, written beside it so a store can tell, without trying to open anything, that
 * the secret has moved since. Not a secret and not a check of one — `unwrapDataKey`'s GCM tag
 * is that.
 */
export async function kekFingerprint(secret: string): Promise<string> {
  const bytes = fromBase64url(secret) ?? new Uint8Array();
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seal(key: CryptoKey, plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plain),
  );
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return out;
}

async function open(key: CryptoKey, blob: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(0, IV_BYTES), additionalData: aad },
      key,
      blob.slice(IV_BYTES),
    ),
  );
}

/** A fresh data key for a new store: 32 bytes from the platform's CSPRNG. */
export function newDataKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** `dataKey` wrapped under `kek` for `group`, as stored: base64url of `nonce ‖ ciphertext`. */
export async function wrapDataKey(kek: CryptoKey, dataKey: Uint8Array, group: string) {
  return toBase64url(await seal(kek, dataKey, encoder.encode(group)));
}

/**
 * The data key a wrapped one holds — and a throw when `kek` is not the key it was wrapped under,
 * or the wrapping was made for another group. The throw is the GCM tag's, which is the check.
 */
export async function unwrapDataKey(
  kek: CryptoKey,
  wrapped: string,
  group: string,
): Promise<Uint8Array> {
  const blob = fromBase64url(wrapped);
  if (blob === null || blob.length <= IV_BYTES) throw new Error("a stored data key is unreadable");
  return open(kek, blob, encoder.encode(group));
}

/**
 * **KEK rotation, for one store**: the wrapped data key opened under `oldKek` and wrapped again
 * under `newKek`. The rows are under the data key and do not move. Throws, writing nothing,
 * when `oldKek` does not open it.
 */
export async function rewrap(
  wrapped: string,
  group: string,
  oldKek: CryptoKey,
  newKek: CryptoKey,
): Promise<string> {
  return wrapDataKey(newKek, await unwrapDataKey(oldKek, wrapped, group), group);
}

/**
 * The key one table generation's rows are sealed under: HKDF-SHA-256 over the data key, its info
 * naming the table and the generation. Derived once per replacement, not once per row.
 */
export async function rowKey(
  dataKey: Uint8Array,
  table: string,
  generation: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", dataKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ROW_SALT,
      info: encoder.encode(`${table}\u0000${generation}`),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const rowAad = (table: string, uid: string) => encoder.encode(`${table}\u0000${uid}`);

/** One row, sealed whole: `nonce ‖ AES-GCM(row JSON)`, bound to its table and uid. */
export async function sealRow(key: CryptoKey, table: string, row: { uid: string }) {
  return seal(key, encoder.encode(JSON.stringify(row)), rowAad(table, row.uid));
}

/**
 * A value as JSON with every object's keys in sorted order, at every depth — so two documents
 * that spell one row with its keys in another order give it one MAC. Arrays keep their order:
 * a row's `tags` in another order is another row.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The HKDF salt the store's MAC key is drawn with: apart from every row key's. */
const MAC_SALT = encoder.encode("mtg-grimoire/integrations/mac/v1");

/**
 * **The key a store's row MACs are under**: HMAC-SHA-256, drawn from the data key by HKDF with
 * an info string of its own, so it is no row key and no row key is it. One key for the store and
 * not one per generation: a MAC has to come out the same across replacements, or no row would
 * ever be found unchanged.
 *
 * **Keyed, and that is the point.** The MAC says whether a row changed without opening it; an
 * unkeyed hash would say more — a storage dump holds the clear columns, and a row's sealed fields
 * beyond them (a condition, a language, a value) are few enough to guess and confirm against a
 * plain digest. Under a key from the data key, the dump confirms nothing.
 */
export async function macKey(dataKey: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", dataKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: MAC_SALT, info: encoder.encode("row-mac") },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/**
 * One row's MAC: HMAC-SHA-256 over `table \0 CLEAR_COLUMNS_VERSION \0 canonical(row)`, 32 bytes.
 * **The clear columns' version is in it** (`projection.ts`), so changing how a clear column is
 * derived moves every MAC and the next publish rewrites every row, not only the ones whose
 * content moved. **WebCrypto's, though it is async**: timed under workerd on 2026-10-25 (50,000 rows, the client's clock, workerd's own
 * does not move during CPU work), WebCrypto took ~350 ms and `node:crypto`'s synchronous
 * `createHmac` ~300–440 ms — no win worth a `nodejs_compat` flag. Under Node the synchronous one
 * is three times faster, which is Node's thread pool and not the runtime this deploys to.
 */
export async function rowMac(key: CryptoKey, table: string, row: unknown): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${table}\u0000${CLEAR_COLUMNS_VERSION}\u0000${canonical(row)}`),
    ),
  );
}

/** A sealed row opened — for the queries of PR 3 and 4, and for this Worker's suite today. */
export async function openRow(
  key: CryptoKey,
  table: string,
  uid: string,
  blob: Uint8Array,
): Promise<unknown> {
  return JSON.parse(decoder.decode(await open(key, blob, rowAad(table, uid))));
}

// ---------------------------------------------------------------------------------------
// The inbox and the consumer tokens (the PR 3 plan, §3.3 and §3.4)
// ---------------------------------------------------------------------------------------

/** The HKDF salt the inbox's key is drawn with: apart from every row key's and the MAC key's. */
const INTENT_SALT = encoder.encode("mtg-grimoire/integrations/intent/v1");

/** The HKDF salt the consumer tokens' key is drawn with. */
const CONSUMER_SALT = encoder.encode("mtg-grimoire/integrations/consumer/v1");

/**
 * **The key a store's intents are sealed under**: AES-256-GCM, drawn from the data key by HKDF
 * with a salt and an info string of its own. One key for the inbox and not one per intent: an
 * integration writes at most a few hundred a day (`intents.ts`'s cap), so its random 96-bit nonces
 * stay where they never meet.
 */
export async function intentKey(dataKey: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", dataKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: INTENT_SALT, info: encoder.encode("intents") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const intentAad = (id: string) => encoder.encode(`intent\u0000${id}`);

/**
 * An intent's sealed half — `{ payload, confirmedBy }` — bound to its id, so a body moved to
 * another intent does not open. What stays in the clear beside it is what the overlay and the
 * caps query (`store.ts`'s `intents` table).
 */
export async function sealIntent(key: CryptoKey, id: string, body: unknown): Promise<Uint8Array> {
  return seal(key, encoder.encode(JSON.stringify(body)), intentAad(id));
}

/** An intent's sealed half, opened. Throws when it was sealed for another id or another store. */
export async function openIntent(key: CryptoKey, id: string, blob: Uint8Array): Promise<unknown> {
  return JSON.parse(decoder.decode(await open(key, blob, intentAad(id))));
}

/**
 * **The key a store's consumer tokens are signed under**: HMAC-SHA-256, drawn from the group's
 * data key — never from `INTEGRATIONS_KEK` (plan §2). So a KEK rotation, which rewraps the data
 * key and keeps it, moves no token; and `deleteAll`, which takes the data key with everything
 * else, takes the key every token of the group was signed under — every one of them dies with the
 * store, whatever its `exp` says, with no list to walk.
 */
export async function consumerKey(dataKey: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", dataKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: CONSUMER_SALT, info: encoder.encode("consumer-token") },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}
