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

/**
 * One minted claim set. `sub` is the Patreon member, `grp` the sync group, `exp` a wall-clock ms.
 *
 * **`dev` is the device that presented itself to `/token` or `/claim`**, added 2026-10-01 for the
 * share Worker (issue #548): a token outlives the device's removal by up to `TOKEN_TTL_MS`, so the
 * share Worker's gate and the relay's push check `dev` against the group's newest manifest
 * ([`stillInGroup`]), and the relay holds a push and an ack to the device they name
 * (`admit.ts`'s `bindDevice`). **Optional because a token minted by an older relay has none**, and
 * such a token lives at most a day.
 *
 * **`ep` is the group epoch whose auth the door checked**, read in the same row as that auth
 * (`groupauth.ts`'s `authenticatedEpoch`). [`stillInGroup`] orders a grant against the group's
 * newest rotation by it, without comparing clocks, which a mint time cannot. Optional for `dev`'s
 * reason, and a token without one is ordered by its mint time as before.
 */
export interface Claims {
  sub: string;
  grp: string;
  exp: number;
  dev?: string;
  ep?: number;
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

  const { sub, grp, exp, dev, ep } = parsed as Partial<Claims>;
  if (typeof sub !== "string" || typeof grp !== "string") return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  // Absent is an older relay's token; present and not a string is a shape no minter writes.
  if (dev !== undefined && typeof dev !== "string") return null;
  // The same for `ep`, and an epoch is a non-negative integer or it is not one the relay wrote.
  if (ep !== undefined && !(Number.isSafeInteger(ep) && ep >= 0)) return null;
  // `<=` and not `<`: the instant it names is the first instant it is no longer good for.
  if (exp <= nowMs) return null;

  // Rebuilt from the checked fields rather than returned as-is, so a caller can never be handed a
  // property this function did not check — and `dev` and `ep` only when they were there, so a
  // token without them reads back exactly as it was minted.
  return {
    sub,
    grp,
    exp,
    ...(dev === undefined ? {} : { dev }),
    ...(ep === undefined ? {} : { ep }),
  };
}

/**
 * Was a token minted by a device the group has not since removed? **One rule, read by two
 * Workers**: the relay's push gate (`index.ts`) and the share Worker's gate in front of every
 * `/g/…` route (`infrastructure/share-worker/src/env.ts`, issue #548). It lived in the share
 * Worker alone until the relay's push needed it too, and it moved here rather than being copied,
 * so the two cannot drift into two different ideas of who is in a group. **Here, in the token's
 * module, because this is the one relay module the share Worker bundles** — by an exact-module
 * alias in a job with nothing installed (`scripts/share-worker-alias.test.ts`), which is also why
 * it imports nothing.
 *
 * **A token outlives its device's removal by up to a day** (`TOKEN_TTL_MS`), because it is signed
 * rather than looked up. The signature and `claims.grp` say only that the bearer *was* in the
 * group when it minted; this is what says it still is.
 *
 * **The roster is the newest `group_keys` row**, the manifest a rotation published: its key set is
 * who is in the group at that epoch (`infrastructure/relay/schema.sql`). Every join, removal and
 * departure is a rotation, so a device the newest manifest omits is a device that has left — but
 * only if its token predates that manifest. A device that paired *after* it holds a key the manifest does not
 * name yet (a first claim seeds `{}`), and it could only have minted with the current group auth,
 * which a removed device no longer derives. So the rule is two clauses, and both are needed:
 *
 * * granted **at** the newest epoch → in the group, whatever the manifest says;
 * * granted **before** it → in the group only if that manifest names `dev`.
 *
 * **"At" is the token's `ep`**: the epoch whose auth the relay's door checked, read in the same row
 * as that auth. Epochs order a grant against a rotation by what the door actually saw, so a
 * removal that lands while a removed device's `/token` is in flight — or whose mirror has not
 * moved yet — leaves its token at the older epoch.
 *
 * A token with no `ep` was minted by an older relay and lives at most a day; it falls back to its
 * mint time, `exp − TOKEN_TTL_MS` (`claim.ts`'s `grantFor` stamps `exp` exactly that far past its
 * issue time), against the newest row's `created_at` — the weaker rule, because it compares two
 * clocks. A token with no `dev` was minted by a relay older than the change that added it
 * (2026-10-01), and before the newest rotation it is refused rather than trusted — it cannot say
 * which device it is for.
 *
 * **A group with no `group_keys` row has never rotated**, so nobody has ever been removed from it.
 *
 * An unreadable manifest throws rather than refusing: a 500 that names the group is recoverable,
 * where a quiet refusal would read as every device's membership ending at once.
 */
export function stillInGroup(newest: NewestKeys | null, group: string, claims: Claims): boolean {
  if (newest === null) return true;
  if (claims.ep !== undefined) {
    if (claims.ep >= newest.epoch) return true;
  } else if (claims.exp - TOKEN_TTL_MS >= newest.created_at) {
    return true;
  }
  if (claims.dev === undefined) return false;

  let roster: unknown;
  try {
    roster = JSON.parse(newest.keys);
  } catch {
    throw new Error(`group ${group} has an unreadable manifest`);
  }
  if (typeof roster !== "object" || roster === null || Array.isArray(roster)) {
    throw new Error(`group ${group} has an unreadable manifest`);
  }
  return Object.prototype.hasOwnProperty.call(roster, claims.dev);
}

/** The newest `group_keys` row's three columns the push gate and the share gate read. */
export interface NewestKeys {
  epoch: number;
  /** The manifest as stored — JSON text, parsed only when a pre-rotation token asks. */
  keys: string;
  created_at: number;
}

/**
 * The group's newest key row, or `null` for a group with none — **one point read on
 * `group_keys_by_group`**, which is the whole of what a push's epoch check and its membership
 * check need between them, so the push gate pays one D1 read for both.
 *
 * Takes the binding rather than an `Env`, because two Workers with two `Env`s call it.
 */
export async function newestKeys(db: D1Database, group: string): Promise<NewestKeys | null> {
  return db
    .prepare(
      `SELECT epoch, keys, created_at FROM group_keys WHERE group_id = ? ORDER BY epoch DESC LIMIT 1`,
    )
    .bind(group)
    .first<NewestKeys>();
}
