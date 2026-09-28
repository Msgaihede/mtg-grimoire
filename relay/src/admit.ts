import type { Envelope } from "./group";
import { MAX_CLOCK_AHEAD_MS, MAX_GROUP_LOG_CHARS, MAX_SEALED_CHARS } from "./log";

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
 */

export interface Refusal {
  status: number;
  code: string;
  error: string;
}

/**
 * The longest push body the Worker will read to the end, in characters: the sealed cap plus 4 KiB
 * for the envelope's other five fields and its punctuation.
 *
 * **Generous on purpose**, so that it is the sealed cap and not this one that an honest envelope
 * at the limit meets. The other fields are bounded well inside the allowance — the group id is at
 * most 128 characters by the route's own pattern, the app's device id is 32, and the three
 * numbers are at most twenty digits each — and `admit.test.ts` builds that worst case and holds it
 * under this line. This cap exists so that the Worker never parses a body it would refuse anyway.
 */
export const MAX_PUSH_BODY_CHARS = MAX_SEALED_CHARS + 4 * 1024;

/**
 * The envelope as the relay reads it: the six fields `sync_engine::wire` writes, with the three
 * numbers finite. **Shared by the Worker and the object**, so the two cannot disagree about what
 * a well-formed push is — the object re-checks what the Worker already checked, because it is a
 * class that should not store a shape it does not enforce, and one predicate means the two checks
 * are the same check.
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
    Number.isFinite(envelope.hlcCtr)
  );
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
 * device has acked — it is *not now* rather than *never*.
 */
export function admitToLog(storedChars: number, sealedChars: number): Refusal | null {
  if (storedChars + sealedChars <= MAX_GROUP_LOG_CHARS) return null;
  return { status: 507, code: "quota", error: "this group's log is full" };
}
