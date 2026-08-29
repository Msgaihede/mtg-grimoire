/**
 * The relay's access token: a claim set as base64url JSON, a dot, and an HMAC-SHA256 signature
 * over that text. Minted once when a reader's membership is checked, and verified in front of
 * every relay route.
 *
 * **Why it is signed rather than looked up.** This is checked on *every* request, ahead of the
 * Durable Object hop. Looking an entitlement up in storage would put a billable read in the hot
 * path of every push, pull and ack, and would put the entitlement table itself in the way of
 * syncing — one table's bad afternoon becomes every reader's. An HMAC verify is a few
 * microseconds against memory and touches nothing. The price of that choice is that an
 * already-issued token cannot be recalled, which is why the TTL is a day and why the thing that
 * actually gets revoked is the refresh secret, one rung up.
 *
 * **This is deliberately not a JWT.** There is no header, so there is no `alg` field, so there
 * is no algorithm to negotiate and no `alg: "none"` to be talked into. The relay signs one way
 * and verifies the same one way; a token is either that shape or it is refused.
 *
 * **Nothing here reads the token before the signature has been checked.** `verify` recomputes
 * the signature over the payload *as text* and compares strings — the untrusted half of the
 * token is never base64-decoded, never handed to `JSON.parse`, never inspected at all until the
 * HMAC says it is ours. That ordering is the difference between a junk request costing a hash
 * and a junk request reaching a parser.
 */

/** One minted claim set. `sub` is the Patreon member, `grp` the sync group, `exp` a wall-clock ms. */
export interface Claims {
  sub: string;
  grp: string;
  exp: number;
}

/**
 * Twenty-four hours. It is the revocation window, not a session length: a membership cancelled
 * at noon keeps working until the token runs out, and the day is the deliberate ceiling on how
 * long that can be. Shorter would mean refreshing more often against the entitlement check this
 * design exists to keep off the hot path; longer would make a cancellation look ignored.
 *
 * `mint` does not stamp `exp` from this — the caller owns the clock and passes the claim set it
 * wants — so this is exported for the minting side to add to its own `Date.now()`.
 */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * base64url, the unpadded flavour: `+/` become `-_` and the `=` tail is dropped, so a token is
 * safe in a header, a query string and a URL path without a second layer of escaping.
 *
 * The byte-at-a-time loop is not an oversight. `String.fromCharCode(...bytes)` spreads the array
 * into arguments and blows the stack on a large input; a claim set is ~100 bytes and a signature
 * is 32, so the loop costs nothing and cannot be the thing that fails.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The inverse, back to the UTF-8 text that was encoded. The padding is put back before `atob`
 * rather than trusted to be optional: implementations disagree about whether an unpadded string
 * is acceptable, and this one is round-tripping its own output, so there is no reason to find
 * out which side workerd lands on.
 */
function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Compare two signatures without leaking where they first differ. A `===` on strings returns as
 * soon as it finds a mismatched character, and that timing is enough to walk a forged signature
 * into a valid one a character at a time.
 *
 * The length check ahead of the loop is not a leak: both sides are this file's own base64url of
 * a 32-byte HMAC, so the length is a constant of the format. A signature of a different length
 * is malformed, not a near miss.
 */
function equalsConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * HMAC-SHA256 of `payload` under `secret`, base64url-encoded. Imported per call rather than
 * cached in a module-level map: a raw HMAC key import is cheap next to the request it is part
 * of, and a cache keyed on the secret would keep the secret alive in a global for the lifetime
 * of the isolate for no measurable gain.
 *
 * The key is imported with `["sign"]` and never `["verify"]`, because verification here is
 * *recomputation* — see `verify`.
 */
async function sign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

/** `{payload}.{signature}`, where the payload is base64url JSON and the signature covers it. */
export async function mint(claims: Claims, secret: string): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${await sign(payload, secret)}`;
}

/**
 * The claims a token carries, or `null` — and `null` for *every* reason a token can be
 * unacceptable: wrong shape, wrong secret, edited payload, unparseable payload, missing or
 * mistyped claim, expired.
 *
 * **It does not throw, and that is the contract the gate depends on.** This is called on input
 * a stranger chose, so a thrown `DOMException` out of `atob` or a `SyntaxError` out of
 * `JSON.parse` would be a 500 where a 401 belongs — an error page, a log line and an alert for
 * what is simply a request without a ticket. The one thing that can still throw is an unusable
 * `secret`, and that is left to throw on purpose: an unset signing key is a misconfigured relay,
 * and a 500 that says so is far better than every reader in the world quietly getting a 401.
 *
 * **The signature is checked before the payload is read.** Recomputing over the payload text and
 * comparing strings means the attacker-controlled half is never decoded — `subtle.verify` would
 * have needed the supplied signature base64-decoded first, which is a parse of exactly the bytes
 * we are refusing to trust.
 */
export async function verify(token: string, secret: string, nowMs: number): Promise<Claims | null> {
  // Exactly two parts, both non-empty. `"a.b.c"`, `"onlyonepart"`, `"."` and `"a."` all die here,
  // before anything has been hashed.
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (payload === "" || signature === "") return null;

  if (!equalsConstantTime(signature, await sign(payload, secret))) return null;

  // Past this line the payload is known to be ours. It is still parsed defensively, because
  // "ours" only means it was signed by this key — a claim set minted by an older build of the
  // minting side is authentic and can still be the wrong shape.
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(payload));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { sub, grp, exp } = parsed as Partial<Claims>;
  if (typeof sub !== "string" || typeof grp !== "string") return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  // `<=` and not `<`: the instant it names is the first instant it is no longer good for.
  if (exp <= nowMs) return null;

  // Rebuilt from the three fields rather than returned as-is, so a caller can never be handed a
  // property this function did not check.
  return { sub, grp, exp };
}
