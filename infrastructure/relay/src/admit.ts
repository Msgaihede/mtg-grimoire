import type { Envelope } from "./group";
import { MAX_CLOCK_AHEAD_MS, MAX_GROUP_LOG_CHARS, MAX_SEALED_CHARS } from "./log";
import type { Claims } from "./token";

/**
 * Every refusal a push can meet, as pure functions over values already read — the Worker's
 * checks ahead of the Durable Object hop and the object's own quota, in the order they are met.
 *
 * **Why the Worker checks almost all of it rather than the object.** A request that reaches a
 * Durable Object bills a Durable Object request whether it is stored or refused, which is the
 * argument `index.ts` makes for where the bearer gate stands, and it applies unchanged to a push
 * that is too large, sealed at the wrong epoch or stamped a week ahead: none of those needs the
 * object's state to be refused, so none of them should cost what reaching it costs. The quota is
 * the one that does need it — the size of the log is the object's to know — and is the one
 * refusal that happens on the far side of the hop.
 *
 * **A refusal is a `{ status, code, error }`, and clients match on `code`, never on `error`** —
 * the `device_limit` precedent in `claim.ts`. The sentence is for a log line and may change; the
 * code is the wire.
 *
 * The two 400s — a body that is not JSON, an envelope missing a field — are not here. They were
 * the object's refusals before this file existed, they carry no `code` because there is nothing
 * for a client to do about one but fix itself, and `index.ts` still sends them in the same words.
 *
 * **One check here is an ack's as well as a push's**: whether the device a body names is the one
 * its token was minted for ([`deviceMismatch`], [`bindDevice`]) — and it is, for now, a check that
 * refuses nothing. See [`DEVICE_BINDING`].
 */

export interface Refusal {
  status: number;
  code: string;
  error: string;
}

/**
 * The longest push body the Worker will read to the end, in characters: the sealed cap plus 4 KiB
 * for the envelope's other fields and its punctuation.
 *
 * **Generous on purpose**, so that it is the sealed cap and not this one that an honest envelope
 * at the limit meets. The other fields are bounded well inside the allowance — the group id is at
 * most 128 characters by the route's own pattern, the app's device id is 32, the three numbers are
 * at most twenty digits each, and a `sig` is exactly [`SIG_CHARS`] — and `admit.test.ts` builds
 * that worst case, signature included, and holds it under this line. **The signature did not move
 * the cap**: 86 characters and `,"sig":""` fit in what the allowance had left with room to spare,
 * so a signed push at the sealed cap still meets the sealed cap first. This cap exists so that the
 * Worker never parses a body it would refuse anyway.
 */
export const MAX_PUSH_BODY_CHARS = MAX_SEALED_CHARS + 4 * 1024;

/**
 * How long an envelope's `sig` is, in characters: a 64-byte Ed25519 signature as base64url
 * **without padding** — 64 bytes is 512 bits, and 512 / 6 rounds up to 86.
 *
 * Exactly this and no other length, because a signature has one size: a `sig` of 85 or 88 (the
 * padded spelling, `==` and all) is not a near miss of a signature but something no signer
 * writes, and the relay would otherwise store, and every peer pull and try to verify, bytes that
 * cannot be one.
 */
export const SIG_CHARS = 86;

/**
 * A well-formed `sig`: [`SIG_CHARS`] of base64url's alphabet and nothing else — no `=`, no `+` or
 * `/`, no whitespace. **Shape and never truth**: the relay holds no device's key yet (spec §8; it
 * learns them with the signed roster document, PR 2), so a `sig` that has the shape and verifies
 * against nothing is stored like any other. What it buys now is that every row a peer is handed
 * carries either no signature or one a verifier can at least decode.
 */
const SIG = new RegExp(`^[A-Za-z0-9_-]{${SIG_CHARS}}$`);

/**
 * The envelope as the relay reads it: the six fields `sync_engine::wire` writes, with the three
 * numbers finite — and, since the Discord integration's first PR (issue #1096, spec §4), an
 * optional seventh. **Shared by the Worker and the object**, so the two cannot disagree about what
 * a well-formed push is — the object re-checks what the Worker already checked, because it is a
 * class that should not store a shape it does not enforce, and one predicate means the two checks
 * are the same check.
 *
 * **`sig` is optional, and absent is not a weaker form of present.** An envelope with no `sig` is
 * every envelope a released build has ever pushed, and is read exactly as it was. One with a
 * `sig` must carry a well-formed one: present and anything else — a number, `null`, a padded or
 * truncated string — is the same `400 malformed envelope` as a missing `sealed`, because it is
 * the same kind of wrong. ⚠️ **`null` is "present"**: a client that serialises an unsigned batch
 * as `"sig": null` rather than leaving the key out is refused, so the Rust side skips the field
 * when it has none.
 */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Partial<Record<keyof Envelope, unknown>>;
  return (
    typeof envelope.group === "string" &&
    typeof envelope.device === "string" &&
    typeof envelope.sealed === "string" &&
    Number.isFinite(envelope.epoch) &&
    Number.isFinite(envelope.hlcMs) &&
    Number.isFinite(envelope.hlcCtr) &&
    // `undefined` and not `"sig" in`: a parsed body cannot hold an `undefined`, so over the wire
    // the two are one test, and this one also reads a caller's `{ ...e, sig: undefined }` as absent.
    (envelope.sig === undefined || isSig(envelope.sig))
  );
}

/** Whether `value` is a `sig` of the one shape [`isEnvelope`] admits. */
export function isSig(value: unknown): value is string {
  return typeof value === "string" && SIG.test(value);
}

/**
 * The body, before it is parsed: refused **413 `too_large`** past [`MAX_PUSH_BODY_CHARS`].
 *
 * `index.ts` asks this twice — once of the declared `Content-Length`, before a byte is read, and
 * once of the text it read. The first is in bytes and the cap is in characters, and it is still
 * the right question: UTF-8 never spends fewer bytes than characters, so a declared length over
 * the cap is a body over it unless the body is not ASCII — and every field of an honest envelope
 * is hex, base64url, digits or the route's own character class.
 */
export function admitBody(chars: number): Refusal | null {
  // `> cap` refuses, rather than `<= cap` admitting, because the two part company at NaN — which
  // is what `Number()` makes of a Content-Length that is not a number. That header decides
  // nothing, and the text it came with is measured next anyway.
  if (!(chars > MAX_PUSH_BODY_CHARS)) return null;
  return { status: 413, code: "too_large", error: "that push is larger than the relay accepts" };
}

/**
 * A parsed envelope against the group's current epoch and the relay's clock: `null` to forward
 * it, or the refusal, checked in this order.
 *
 * 1. **`sealed` past [`MAX_SEALED_CHARS`] → 413 `too_large`.** It would not fit in the object's
 *    row; see that constant.
 * 2. **An epoch below the group's → 409 `stale_epoch`.** Two devices send one, and it is the
 *    right answer to both. A device *removed* from the group still holds the key it was removed
 *    from and a token that lives up to a day, and this is what stops it writing under that key in
 *    the meantime; a device merely *behind* a rotation is told to catch up, and the app re-reads
 *    `/keys`, adopts the new key and seals again. 409 because the push is fine and the group has
 *    moved.
 * 3. **An epoch above the group's → 422 `epoch_ahead`.** No shipped client seals ahead of the
 *    relay — `/rotate` records the new epoch in D1 *before* the rotating device commits it and
 *    pushes at it — so this is a push nothing honest sends. It is also the one that did the most
 *    damage: anyone holding a token could push `{ epoch: 1e12 }`, and every peer that pulled it
 *    held its cursor waiting for keys to an epoch that will never exist. The whole group froze on
 *    one envelope.
 * 4. **`hlcMs` more than [`MAX_CLOCK_AHEAD_MS`] past `nowMs` → 422 `clock_ahead`.** See that
 *    constant for the day and what it costs the pusher. Exactly a day ahead is still admitted.
 *
 * **`currentEpoch` of `null` skips 2 and 3 and nothing else.** It is a group whose entitlement
 * row predates the epoch column and has never been seeded or rotated since — there is nothing to
 * compare against, and refusing every push to it would end its sync over a column it never had.
 */
export function admit(
  envelope: Pick<Envelope, "sealed" | "epoch" | "hlcMs">,
  currentEpoch: number | null,
  nowMs: number,
): Refusal | null {
  if (envelope.sealed.length > MAX_SEALED_CHARS) {
    return { status: 413, code: "too_large", error: "that batch is larger than the relay stores" };
  }
  if (currentEpoch !== null && envelope.epoch < currentEpoch) {
    return {
      status: 409,
      code: "stale_epoch",
      error: "that push is sealed at an epoch the group has rotated past",
    };
  }
  if (currentEpoch !== null && envelope.epoch > currentEpoch) {
    return {
      status: 422,
      code: "epoch_ahead",
      error: "that push is sealed at an epoch the group has not reached",
    };
  }
  if (envelope.hlcMs > nowMs + MAX_CLOCK_AHEAD_MS) {
    return {
      status: 422,
      code: "clock_ahead",
      error: "that push is stamped more than a day ahead of the relay's clock",
    };
  }
  return null;
}

/**
 * The object's one check: would storing `sealedChars` more take the log past
 * [`MAX_GROUP_LOG_CHARS`]? **507 `quota`** if so. Exactly at the cap is still stored.
 *
 * `storedChars` is the object's running total rather than a `sum()` over the log, and `group.ts`
 * says why at the table. A group that meets this has a log the thirty-day tail or a slow device is
 * holding, and the refusal clears on its own as the tail passes and compaction deletes what every
 * device has acked — it is *not now* rather than *never* **because `group.ts`'s `push` compacts
 * before it refuses**: a full group refuses every push, so no head moves and no ack would ever run
 * a compaction otherwise.
 */
export function admitToLog(storedChars: number, sealedChars: number): Refusal | null {
  if (storedChars + sealedChars <= MAX_GROUP_LOG_CHARS) return null;
  return { status: 507, code: "quota", error: "this group's log is full" };
}

/**
 * The code a push or an ack is refused with when the device its body names is not the device its
 * token was minted for — **when that is refused, which it is not yet** ([`DEVICE_BINDING`]). Named
 * now so the code a client will match on is decided once, beside the check, and not respelled by
 * the change that starts sending it.
 */
export const DEVICE_MISMATCH = "device_mismatch";

/**
 * What the Worker does with a [`DEVICE_MISMATCH`]: `"warn"` records it and passes the request on,
 * `"refuse"` answers it 403.
 *
 * **Why the relay binds the token's device at all** (spec §2, F4). Push and ack used to check the
 * token's `grp` and nothing else, so any device of a group could push an envelope stamped as
 * another device, or ack as one — and an ack stores whatever `device` it names, so one device
 * could move another's compaction floor. That was harmless while every device was a full peer
 * holding the same key. It stops being harmless when one of them is a restricted device (the
 * Discord bot, issue #1096): a bot that could ack as the desktop could have the log compacted out
 * from under it.
 *
 * **Why `"warn"` first.** The `dev` claim is issue #548's, minted since 2026-10-01 — every token
 * alive today carries one — but no client has ever been held to it, and a client that sends a
 * device id its token does not name for a reason nobody has found yet would stop syncing on the
 * day this refuses. So the first release only counts them: `bindDevice` logs a fixed line per
 * mismatch, Workers Logs (`observability`, `wrangler.jsonc`) keeps it, and the release that
 * flips this to `"refuse"` (the integration's second PR) is the one that has read those lines and
 * found none from an honest client. **This constant is the one place that changes**; the code,
 * the status and the check are already here and tested in both modes.
 *
 * **A token with no `dev` is never a mismatch, in either mode.** It is an older relay's, lives at
 * most `TOKEN_TTL_MS`, and names no device to hold a body to.
 */
export const DEVICE_BINDING: "warn" | "refuse" = "warn";

/**
 * Whether `device` — an envelope's `device` on a push, a body's `device` on an ack — is the device
 * the token names: `null` when it is, or when the token names none, else the 403 it would be
 * refused with. Pure; [`bindDevice`] is what acts on it.
 */
export function deviceMismatch(claims: Pick<Claims, "dev">, device: string): Refusal | null {
  if (claims.dev === undefined || claims.dev === device) return null;
  return {
    status: 403,
    code: DEVICE_MISMATCH,
    error: "that body names a device this token was not minted for",
  };
}

/**
 * [`deviceMismatch`] under [`DEVICE_BINDING`] — **the one place a mismatch is acted on**, for a
 * push and an ack alike: `null` to pass the request on, or the refusal to answer it with.
 *
 * **The line it logs is fixed text**: the code and which of the two routes, and nothing a request
 * carried — no group, no device id, no token, no byte of the body. The invocation log beside it
 * already records the request's URL, which is the group; what this adds is only that the binding
 * failed, which is the count the flip waits on. A device id is not a secret, but nothing the count
 * needs would be learnt from one, so none is written. `warn` and not `error`: in this mode it is
 * a measurement, not a fault.
 *
 * `mode` is a parameter so a test can hold the `"refuse"` path to its 403 today; every caller
 * leaves it to the constant.
 */
export function bindDevice(
  route: "push" | "ack",
  claims: Pick<Claims, "dev">,
  device: string,
  mode: "warn" | "refuse" = DEVICE_BINDING,
): Refusal | null {
  const mismatch = deviceMismatch(claims, device);
  if (mismatch === null) return null;
  console.warn(`${DEVICE_MISMATCH} on ${route}`);
  return mode === "refuse" ? mismatch : null;
}
