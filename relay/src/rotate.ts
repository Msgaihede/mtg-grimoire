import { GROUP_SEGMENT } from "./claim";
import {
  MAX_GROUP_DEVICES,
  authIsCurrent,
  authIsRecent,
  currentManifest,
  groupEpoch,
  keepOnly,
  recordRotation,
} from "./groupauth";
// **`import type` and never a value import**, for `groupauth.ts`'s reason: `index.ts` imports
// this file to build its route table at module-evaluation time, so a value import back would
// close a runtime cycle across exactly that construction. `import type` is erased outright.
import type { Env } from "./index";

/**
 * The group's two key-distribution routes. `POST /g/{group}/rotate` publishes a new epoch and
 * the group key rewrapped for every device that stays; `GET /g/{group}/keys` is how a device
 * finds out whether it is one of them.
 *
 * **Both stand ahead of `index.ts`'s bearer gate, and that placement is the point rather than an
 * exemption.** A device that has just been rotated away from cannot mint a token — the auth it
 * would present to `/token`'s group door is stale by definition — so a `/keys` behind the gate
 * would refuse exactly the caller it exists to serve, and a removed device would sit for ever in
 * a group it is no longer in. These two carry their own credential instead.
 *
 * **Neither reaches the Durable Object, and that is what makes standing outside the gate
 * affordable.** The gate is in front of the DO because a request that reaches one costs a
 * Durable Object request whether it is honoured or refused (spec §8). These are D1 reads and
 * writes in the Worker, so the residual cost spec §4 accepts — a removed device spending `/keys`
 * reads until its auth ages out of the eight-epoch window — never touches the metered path.
 *
 * **The manifest `/keys` answers is the roster** (spec §2.3): a blob means catch up, no blob
 * means you are out. That is positive evidence rather than an inference from a refusal, and it
 * is why `/keys` accepts an auth the group has left behind while `/rotate` accepts only the
 * current one. The two routes ask deliberately different questions of the same table.
 *
 * ⚠️ **A device must compare epochs before it reads the manifest.** A group that has claimed
 * and never rotated is answered its own epoch and an empty manifest, and a reader consulting
 * the manifest without checking the epoch first would conclude every device in a healthy group
 * had been removed. Equal epochs mean *nothing to do*.
 */

/**
 * A device id, anchored, from the character class `claim.ts` gives a group id.
 *
 * One class serves both because `sync_pair` mints both with the same uid function — and the
 * class is worth applying to a device id for the router's own reason: `%41` and `A` would name
 * one device in the reader's head and two keys in the manifest, with no later point at which the
 * disagreement becomes visible.
 *
 * `claim.ts`'s `GROUP_ID` is this exact pattern and is deliberately not reached for: a constant
 * named for the group is a constant a later reader will assume is checking a group.
 */
const DEVICE_ID = new RegExp(`^${GROUP_SEGMENT}$`);

/**
 * What a credential looks like on both of these routes: 64 lowercase hex characters.
 *
 * A group auth is `relay_auth`'s 32 bytes as hex (spec §2.1), and it is the only credential either
 * route takes. It is also the shape `/claim` demands of the `auth` it stores, which is what makes a
 * rotation's `auth` comparable to a claim's at all.
 *
 * **On the *presented* credential this check changes no answer**, and it is worth saying so:
 * every value it refuses would be refused by the constant-time comparison a moment later
 * anyway. It is here to turn junk away before it costs a D1 read, and to make
 * `equalsConstantTime`'s "both sides are 64 hex characters by the time they reach here" true
 * rather than merely likely. On the `auth` in a `/rotate` **body** it does change an answer:
 * that value is stored and compared for ever after, so a malformed one is a 400.
 */
const CREDENTIAL = /^[0-9a-f]{64}$/;

/**
 * The largest one blob may be.
 *
 * **This and the device cap are the only places a caller chooses how much the relay stores.**
 * `keys` is written whole into a single D1 column, so an unbounded object here is an unbounded
 * row — and the caller choosing its size has already authenticated, which makes this a bill
 * rather than an attack. 4 KB is far past a sealed 32-byte key with its nonce and tag: a ceiling
 * that says "something is wrong" rather than a budget.
 *
 * **The device half is [`MAX_GROUP_DEVICES`] and is imported rather than spelled again here.** It
 * used to be a local `64`, chosen as an absurdity nobody would reach; it is now the real cap the
 * `/token` door admits devices against, and the two must be one constant. A manifest bound above
 * the admission cap would let a rotation publish a group larger than the relay will ever issue
 * tokens for; one below it would refuse a rotation that names devices the relay itself admitted.
 * Either way the disagreement only becomes visible at somebody's fifth device.
 */
const MAX_BLOB_CHARS = 4096;

/**
 * `claim.ts` has these five lines and does not export them. Left as a second copy rather than
 * reached across for, for the reason `groupauth.ts` gives about `equalsConstantTime`: exporting
 * from `claim.ts` is an edit to a file this change does not own, and a shared helper is worth
 * having the day somebody wants a third copy rather than a second.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The credential the caller is presenting, or `null` for a request that has not presented one in
 * a shape this relay issues.
 *
 * **In an `authorization: Bearer` header and never in the body or the query string.** A group auth
 * is the credential that publishes the whole group's roster, and a URL lands in every access log
 * between here and the reader. `/keys` takes the header too, so the two routes are one story.
 */
function presentedCredential(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const presented = header.slice("Bearer ".length);
  return CREDENTIAL.test(presented) ? presented : null;
}

/**
 * Retire the group's refresh secret if the manifest just adopted leaves out the device holding it
 * — the relay's half of a removal, since the removed device keeps whatever its `user.db` holds.
 *
 * **Why this and not only the client's own clear.** `client::check_keys` clears the grant on a
 * device that finds itself off the manifest, but a *lost* phone never runs it, and whoever holds
 * its `user.db` holds the secret. That secret opens `/token`'s refresh door, so left alive it mints
 * tokens for the group that removed it — spending the group's requests and one of its five slots,
 * whose `last_seen` it keeps fresh so the TTL never frees it. The manifest is the roster
 * (spec §2.3); a secret outlives its device's membership by not one rotation.
 *
 * ⚠️ **It no longer opens `/rotate`, and this is why that door was removed rather than guarded.**
 * The refresh secret used to be `/rotate`'s second credential; no shipped client ever presented it
 * (`client::post_rotation` always sends the group auth), and a device removed from the group but
 * still logged into Patreon could press Connect, be handed a fresh secret recorded against itself,
 * and publish a manifest naming itself back in — which this retirement, running after the record,
 * would then have kept.
 *
 * **A row with no recorded holder is retired by any accepted rotation**, whatever the manifest
 * says: it was claimed before `refresh_device` existed, and "cannot prove the holder is still
 * here" is the case to fail closed in. What that costs a holder who *is* still here is one 401
 * on the refresh door, which the app answers by dropping the dead secret and minting through the
 * group door from then on (`entitlement::refused_secret`); pressing Connect again records it.
 *
 * **Read, then a compare-and-swap on the secret that was read**, because D1 has no interactive
 * transaction and a `/claim` can land between the two statements. The `WHERE refresh_secret = ?`
 * binds the value this function just read, never a presented one, so it is not a timing oracle
 * on a credential; and it works as a version check only because every claim mints a new secret — a
 * claim that landed in between has changed it, and this changes nothing.
 */
async function retireOrphanedSecret(
  env: Env,
  group: string,
  keys: Record<string, string>,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT refresh_secret, refresh_device FROM entitlements WHERE group_id = ?`,
  )
    .bind(group)
    .first<{ refresh_secret: string | null; refresh_device: string | null }>();
  if (row === null || row.refresh_secret === null) return;
  // `Object.hasOwn` for `handleKeys`' reason: a holder named `constructor` must not be found on
  // the prototype of a manifest that does not name it.
  if (row.refresh_device !== null && Object.hasOwn(keys, row.refresh_device)) return;
  await env.DB.prepare(
    `UPDATE entitlements SET refresh_secret = NULL, refresh_device = NULL
      WHERE group_id = ? AND refresh_secret = ?`,
  )
    .bind(group, row.refresh_secret)
    .run();
}

/**
 * What is wrong with this manifest, as the sentence to answer with, or `null` for one the relay
 * will store.
 *
 * Every key is a device id and every value a non-empty blob under [`MAX_BLOB_CHARS`], and there
 * are at most [`MAX_GROUP_DEVICES`] of them. The blob itself is never decoded — it is sealed to a
 * key the relay does not hold, and a relay that checked its shape would be claiming to know
 * something about it that it must not.
 */
function manifestProblem(keys: unknown): string | null {
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    return "malformed rotation";
  }
  const entries = Object.entries(keys as Record<string, unknown>);
  if (entries.length > MAX_GROUP_DEVICES) return "that rotation names too many devices";
  for (const [device, blob] of entries) {
    if (!DEVICE_ID.test(device)) return "that is not a device id";
    if (typeof blob !== "string" || blob === "") return "malformed rotation";
    if (blob.length > MAX_BLOB_CHARS) return "that rotation carries too large a key";
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// POST /g/{group}/rotate
// ---------------------------------------------------------------------------------------

/**
 * Publish a new epoch: the auth derived from the new group key, and that key rewrapped for every
 * device that stays.
 *
 * **A 409 is the answer that carries the whole guard.** `recordRotation` refuses an epoch that
 * is not the group's next, in one statement, so a removed device that still knows the auth for
 * the epoch it remembers cannot re-register it and walk back into the group that evicted it — and
 * cannot compute the next epoch's auth either, because it no longer has the key. Everything else
 * here is shape.
 *
 * **An epoch past the next one is a 422, not the 409, and the split is diagnostic.** A 409 is a
 * device that is *behind* — it lost a race to another rotation, and its next `/keys` check adopts
 * what won. An epoch that skips ahead is one no shipped client can produce: every plan is the
 * device's own epoch plus one, and the auth it presents is current only if that epoch is the
 * relay's. So it is a bug or a forgery, and a status of its own keeps it separable in the Worker's
 * logs from the race that is ordinary. Not a 400: every 400 here is decided from the body alone,
 * before D1 is read, and this one depends on what the group is standing on. The app treats every
 * non-2xx from this route alike, so the choice changes no client behaviour.
 *
 * **The order is: every check that costs nothing, then the ones that cost a D1 read.** The
 * credential's shape and the body's are decided in the Worker's own memory; the credential's
 * *value* and the epoch's are two round trips to D1. A caller who gets the body wrong pays for
 * neither.
 *
 * **And the manifest is the roster, so publishing one settles who holds a device slot** — the
 * `keepOnly` below the 409, which is spec §4.4's whole implementation.
 */
export async function handleRotate(request: Request, env: Env, group: string): Promise<Response> {
  const presented = presentedCredential(request);
  if (presented === null) return json({ error: "unauthorized" }, 401);

  let body: { epoch?: unknown; auth?: unknown; keys?: unknown };
  try {
    body = (await request.json()) as { epoch?: unknown; auth?: unknown; keys?: unknown };
  } catch {
    return json({ error: "unreadable body" }, 400);
  }

  // A non-integer epoch is refused rather than floored. `1.5` compares as greater than `1` and
  // would be stored as itself, so the group would stand on an epoch no device can ever derive
  // an auth for — the group key's `info` is the epoch, and the app counts in integers.
  const { epoch, auth } = body;
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
    return json({ error: "malformed rotation" }, 400);
  }
  if (typeof auth !== "string" || !CREDENTIAL.test(auth)) {
    return json({ error: "malformed rotation" }, 400);
  }
  const problem = manifestProblem(body.keys);
  if (problem !== null) return json({ error: problem }, 400);
  const keys = body.keys as Record<string, string>;

  // **The group auth of the epoch being replaced, and nothing else.** Every device in the group
  // holds it, and a device removed from the group cannot derive the next one. The Patreon refresh
  // secret used to open this door too; see `retireOrphanedSecret` for why it no longer does.
  if (!(await authIsCurrent(env, group, presented))) return json({ error: "unauthorized" }, 401);

  if (!(await recordRotation(env, group, epoch, auth, keys))) {
    // Read after the refusal and only to word it — the decision was the statement above.
    const current = (await groupEpoch(env, group)) ?? -1;
    if (epoch > current + 1) {
      return json({ error: "that rotation skips an epoch the group has not reached" }, 422);
    }
    return json({ error: "that rotation does not advance the group's key" }, 409);
  }

  // **After the record and never before it: a refused rotation must free nothing.** The two
  // statements are not a transaction, so the order is the whole of the guarantee — `keepOnly`
  // ahead of the 409 above would let a device presenting a stale-but-live auth hand back four
  // slots by publishing an epoch the group then declines to move to. Behind it, the only caller
  // who can free a slot is one whose manifest the group has already adopted.
  //
  // **This is where a removal and a departure each give their slot back**, with no mechanism of
  // their own: both publish a manifest, #307 made the manifest the roster, and `keepOnly`
  // reconciles the device roll against it. `Object.keys` and not the object, because the roll
  // counts devices and holds no key material.
  //
  // **And where the refresh secret goes with its device**, first, because it is a credential: a
  // removed device's secret must not outlive the rotation that removed it.
  await retireOrphanedSecret(env, group, keys);
  await keepOnly(env, group, Object.keys(keys));

  // The caller reads the status and nothing else, but naming the epoch the relay is now standing
  // on is what makes a log line from a failed removal say something.
  return json({ epoch });
}

// ---------------------------------------------------------------------------------------
// GET /g/{group}/keys?device={id}
// ---------------------------------------------------------------------------------------

/**
 * The newest manifest: this device's rewrapped key if it has one, and the roster either way.
 *
 * **`blob: null` at an epoch higher than the caller's is the removal notice**, and it is the
 * only one there is. There is no second table that could arrive late, arrive out of order, or
 * arrive at a device that cannot decrypt it — which is precisely the state a rotation puts every
 * peer in (spec §2.3).
 *
 * **An unreadable manifest is left to throw, deliberately.** `currentManifest` raises rather than
 * answering `{}`, and catching that into a default here would turn one corrupt row into every
 * device in the group reading itself as removed on its next sync, all at once. The throw is a
 * 500: every device stalls exactly where it is, which is recoverable by fixing the row.
 *
 * **Authentication comes before the lookup, so an unknown group is a 401 and not a 404.** The
 * 404 below is real and is the right answer to a group with no rows, but it is not reachable
 * from outside: the credential is checked against those same rows, so a group with none refuses
 * everyone first. That ordering is not an accident — answering 404 to an unauthenticated caller
 * would make this route a directory of which group ids exist.
 */
export async function handleKeys(
  request: Request,
  url: URL,
  env: Env,
  group: string,
): Promise<Response> {
  const presented = presentedCredential(request);
  if (presented === null) return json({ error: "unauthorized" }, 401);

  const device = url.searchParams.get("device");
  if (device === null || !DEVICE_ID.test(device)) {
    return json({ error: "that is not a device id" }, 400);
  }

  // `authIsRecent` and not `authIsCurrent`, and the difference is the route's reason for
  // existing: a device that is behind a rotation and a device that was removed present the same
  // stale auth, and only the manifest can tell them apart.
  if (!(await authIsRecent(env, group, presented))) {
    return json({ error: "unauthorized" }, 401);
  }

  const manifest = await currentManifest(env, group);
  if (manifest === null) return json({ error: "no such sync group" }, 404);

  // **`Object.hasOwn` and never `keys[device] ?? null`.** The manifest is JSON a caller chose the
  // key set of, and `constructor`, `toString` and `valueOf` are all device ids as far as
  // [`DEVICE_ID`] is concerned. `??` does not fire on the inherited function it would find, and
  // `JSON.stringify` then drops the field outright — so a device asking under one of those names
  // would be answered a body with **no `blob` key at all** rather than the `blob: null` it is
  // owed.
  //
  // ⚠️ **What that costs has changed, and the version of this comment that claimed the app's
  // deserialiser "refuses" such a body was false when it was written.** serde reads a missing
  // `Option` field as `None` without being asked to, so a dropped `blob` deserialised to exactly
  // the removal notice — a group could have been dissolved by a device id that collides with an
  // `Object.prototype` key. It became true only when `client::KeyPage` gained
  // `#[serde(deserialize_with = "null_but_present")]`, which is exempt from the missing-field
  // default and turns a body with no `blob` into a parse failure: the device stalls where it is,
  // recoverably, instead of leaving its group. **Both halves are load-bearing** — this line keeps
  // the field present, and that attribute is what makes its absence loud. Neither is a backstop
  // for the other, because only one of them existed for the window in which this was wrong.
  const blob = Object.hasOwn(manifest.keys, device) ? manifest.keys[device] : null;
  return json({ epoch: manifest.epoch, blob, devices: Object.keys(manifest.keys) });
}
