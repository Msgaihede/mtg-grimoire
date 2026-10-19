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
 * How many pushes a restricted device — one whose token carries a `cap` other than `full`
 * (`token.ts`'s `isRestricted`) — may have stored in one UTC day: **64**. Spec §6 and §12.
 *
 * **Why a restricted device is capped at all, when every peer refuses what it sends.** A `read`
 * device (the Discord bot's first release) has nothing to push that a peer will apply, and an
 * `add` device (its second) may push adds and nothing else — so what a compromised one can still
 * do is fill the group's log, which every device then pulls. The relay stores what it pushes
 * (refusing it would need the relay to read ops it cannot decrypt) and bounds how much.
 *
 * **Why 64.** One push is one debounced batch, and a batch holds many ops, so 64 is far past what
 * a reader confirming cards one `/collection add` at a time produces in a day — a cap that says
 * "something is wrong" — while 64 batches at the sealed cap is 96 MB of a group's 128 MiB, so even
 * a bot pushing at the cap all day cannot fill a log by itself before the next day's count, and
 * a reader who notices removes it. A full device has no daily cap: the log's own quota is its
 * fence, as it always was.
 */
export const RESTRICTED_PUSHES_PER_DAY = 64;

/** The code a restricted device's push past [`RESTRICTED_PUSHES_PER_DAY`] is refused with. */
export const RESTRICTED_QUOTA = "restricted_quota";

/**
 * The largest push body a restricted device may send, in bytes: **64 KiB**. Spec §14.5.
 *
 * **Why a restricted device's push has a size of its own.** [`RESTRICTED_PUSHES_PER_DAY`] counts
 * pushes, and with only [`MAX_PUSH_BODY_CHARS`] to hold each one, a compromised bot could still
 * fill 64 × 1.5 MB = 96 MB of a group's log in a day — every byte of it pulled by every device.
 * Bounding the push too brings that day down to 64 × 64 KiB = 4 MiB.
 *
 * **Why 64 KiB.** An `add` device sends what the engine's allow-list accepts and nothing else:
 * `Put`s on `collection_entries` or `wishlist_entries` carrying identity fields, a quantity and a
 * folder, **at most `ADD_OPS_PER_ENVELOPE = 25` to an envelope** (`grimoire_core::integration::add`).
 * The fattest batch ever measured — two hundred *fully populated* `collection_entries` ops, notes,
 * tags and prices included — sealed to 186 188 characters (`MAX_SEALED_CHARS`' doc), about 931 an
 * op, so 25 of those would seal to ≈ 23 300, and an envelope's other fields and its signature add
 * under 400. An allow-listed add carries less than a fully populated op does. 64 KiB is nearly
 * three times the worst case an honest bot can build, so it is this bound and not the allow-list's
 * own count that a bot meets only when it is not honest. A `read` device has nothing to push at
 * all, and meets it the same way.
 */
export const RESTRICTED_PUSH_BYTES = 64 * 1024;

/** The code a restricted device's push over [`RESTRICTED_PUSH_BYTES`] is refused with. */
export const RESTRICTED_TOO_LARGE = "restricted_too_large";

/**
 * A restricted device's push body by its size: **413 `restricted_too_large`** over
 * [`RESTRICTED_PUSH_BYTES`]. Exactly 64 KiB is admitted.
 *
 * `index.ts` asks this twice, as it asks [`admitBody`]: once of the declared `Content-Length`,
 * before a byte is read, and once of the body's UTF-8 length once it is read. Only a push whose
 * token carries a restricted `cap` is asked at all, so a full device's push never meets it.
 * A 413 and not the quota's 429: it does not clear at midnight, it is this push that is wrong.
 */
export function admitRestrictedBody(bytes: number): Refusal | null {
  // `> cap` refuses, rather than `<= cap` admitting, for `admitBody`'s reason: a Content-Length
  // that is not a number is NaN, which decides nothing, and the text is measured next anyway.
  if (!(bytes > RESTRICTED_PUSH_BYTES)) return null;
  return {
    status: 413,
    code: RESTRICTED_TOO_LARGE,
    error: "that push is larger than a restricted device may send",
  };
}

/**
 * The header the Worker puts on a restricted device's push before it forwards it to the object,
 * naming the device the quota is counted against (the token's `dev`). **Trusted because no client
 * can set it**: `index.ts` rebuilds every push it forwards from the body text with one header of
 * its own (`forwarded`), so a header a client sent never reaches the object on a push — and the
 * object reads this one on a push and nowhere else.
 */
export const RESTRICTED_HEADER = "x-grimoire-restricted";

/** A UTC day number: what the restricted quota is counted per. */
export function quotaDay(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000);
}

/**
 * The object's check of a restricted device's push: `pushedToday` already stored this UTC day →
 * **429 `restricted_quota`** at [`RESTRICTED_PUSHES_PER_DAY`]. The 64th is stored; the 65th is not.
 * A 429 and not the log's 507, because it clears on its own at midnight UTC and says nothing about
 * the group's log.
 */
export function admitRestricted(pushedToday: number): Refusal | null {
  if (pushedToday < RESTRICTED_PUSHES_PER_DAY) return null;
  return {
    status: 429,
    code: RESTRICTED_QUOTA,
    error: "this device has pushed as much today as a restricted device may",
  };
}

/**
 * The code a push or an ack is refused with when the device its body names is not the device its
 * token was minted for — refused once the group is signed, and only recorded before
 * ([`DEVICE_BINDING`]).
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
 * mismatch, and Workers Logs (`observability`, `wrangler.jsonc`) keeps it.
 *
 * **And `"warn"` still, for every group that is not signed** (the integration's second PR, spec
 * §12). A group whose newest roster document is `signed` is refused instead — `index.ts`'s
 * `bound` passes `"refuse"` for it — because a signed group is one that holds a restricted
 * device, which is the case the binding exists for, and every member of one is a build new
 * enough to have been gated in (spec §7). Every other group keeps this constant's answer, so the
 * flip for them is still this one line, waiting on the count.
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
