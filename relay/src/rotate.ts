import { GROUP_SEGMENT } from "./claim";
import {
  authIsCurrent,
  authIsRecent,
  currentManifest,
  equalsConstantTime,
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
 * A group auth is `relay_auth`'s 32 bytes as hex (spec §2.1) and a refresh secret is
 * `randomSecret`'s 32 bytes through the same `hex`, so the three credentials this file compares
 * are one shape. It is also the shape `/claim` demands of the `auth` it stores, which is what
 * makes a rotation's `auth` comparable to a claim's at all.
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
 * The largest group a rotation may publish, and the largest one blob may be.
 *
 * **This is the one place a caller chooses how much the relay stores.** `keys` is written whole
 * into a single D1 column, so an unbounded object here is an unbounded row — and the caller
 * choosing its size has already authenticated, which makes this a bill rather than an attack.
 * 64 devices is far past any real pairing group and 4 KB is far past a sealed 32-byte key with
 * its nonce and tag; both are ceilings that say "something is wrong" rather than budgets.
 */
const MAX_DEVICES = 64;
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
 * **In an `authorization: Bearer` header and never in the body or the query string.** `/rotate`
 * may be authenticated with the Patreon refresh secret, which is the credential that can rebind
 * and re-register the whole group — putting it in the body beside the rotation it authorises, or
 * in a URL that lands in every access log between here and the reader, is not a thing to do with
 * it. `/keys` takes the header too, so the two routes are one story.
 */
function presentedCredential(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const presented = header.slice("Bearer ".length);
  return CREDENTIAL.test(presented) ? presented : null;
}

/**
 * Is this the refresh secret of the entitlement bound to this group? `/rotate`'s second door.
 *
 * **The second door exists for the device that has connected but not yet rotated.** It holds the
 * Patreon secret and the group key alike, so either credential would do; what it must not have
 * to do is derive an auth for an epoch it is about to replace. A group with no entitlement, or
 * one whose secret has been revoked, matches nothing — which is spec §2.4's "no membership, no
 * removal" arriving through the same 401 as a wrong credential.
 *
 * Looked up by `group_id` and compared in constant time, never `WHERE refresh_secret = ?`: that
 * is a timing oracle on a credential and an index probe on a secret, exactly as `authIsCurrent`
 * says of its own column.
 */
async function refreshSecretMatches(env: Env, group: string, presented: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT refresh_secret FROM entitlements WHERE group_id = ?`)
    .bind(group)
    .first<{ refresh_secret: string | null }>();
  if (row === null || row.refresh_secret === null) return false;
  return equalsConstantTime(row.refresh_secret, presented);
}

/**
 * What is wrong with this manifest, as the sentence to answer with, or `null` for one the relay
 * will store.
 *
 * Every key is a device id and every value a non-empty blob under [`MAX_BLOB_CHARS`]. The blob
 * itself is never decoded — it is sealed to a key the relay does not hold, and a relay that
 * checked its shape would be claiming to know something about it that it must not.
 */
function manifestProblem(keys: unknown): string | null {
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    return "malformed rotation";
  }
  const entries = Object.entries(keys as Record<string, unknown>);
  if (entries.length > MAX_DEVICES) return "that rotation names too many devices";
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
 * does not strictly advance the group, in one statement, so a removed device that still knows
 * the auth for the epoch it remembers cannot re-register it and walk back into the group that
 * evicted it — and cannot compute the next epoch's auth either, because it no longer has the
 * key. Everything else here is shape.
 *
 * **The order is: every check that costs nothing, then the ones that cost a D1 read.** The
 * credential's shape and the body's are decided in the Worker's own memory; the credential's
 * *value* and the epoch's are two round trips to D1. A caller who gets the body wrong pays for
 * neither.
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

  // Either credential opens this door and neither is weaker than the other: the group auth is
  // held by every device in the group, and the refresh secret is held by the one that connected
  // Patreon. The `||` short-circuits, so the common case — a device rotating with the auth it
  // derived from the key it is replacing — costs one read rather than two.
  const authorised =
    (await authIsCurrent(env, group, presented)) ||
    (await refreshSecretMatches(env, group, presented));
  if (!authorised) return json({ error: "unauthorized" }, 401);

  if (!(await recordRotation(env, group, epoch, auth, keys))) {
    return json({ error: "that rotation does not advance the group's key" }, 409);
  }

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
