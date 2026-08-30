// **`import type` and never a value import**, for the reason `claim.ts` states at length: this
// module is imported by files `index.ts` imports, so a value import would close a runtime cycle
// through a file that builds a route table out of the other side's functions at
// module-evaluation time. `import type` is erased outright, so there is no edge at all.
import type { Env } from "./index";

/**
 * The group's relay key: what the relay is allowed to know about a sync group's shared key, and
 * the history of the keys it has handed round.
 *
 * **The relay holds a one-way function of the group key and nothing else.** A device derives
 * `relay_auth = HKDF-SHA256(ikm = group_key, salt = group_id, info = "…/relay-auth/v1|<epoch>")`
 * and sends the 32 bytes as hex; the relay stores them, compares them, and can invert none of
 * it. That is what lets an entitlement be a property of the **group** rather than of whichever
 * device happened to open a browser — every device in the group derives the same value with
 * nothing distributed, so a device that has only ever paired can mint its own token.
 *
 * **Two homes for one fact, because they answer different questions.**
 * `entitlements.group_auth` is what the group is *right now*, and is what `/token`'s group door
 * compares against — one row, one lookup, no history. `group_keys` is the history, and it exists
 * because a device that is merely behind a rotation holds an auth that is stale **by
 * definition**: an endpoint that accepted only the current auth would refuse exactly the devices
 * `/keys` exists to serve. The window is [`EPOCH_HISTORY`] rows wide and is pruned by the same
 * call that writes a new row, so it is bounded without a sweep.
 *
 * **Nothing here validates the shape of an `auth`.** The route handlers do, against the same
 * character class `GROUP_SEGMENT` gives the group id, before anything reaches this file — the
 * split is deliberate, because a store that also policed its inputs would be two jobs in one
 * place and the policing would be duplicated at every call site anyway.
 */

/**
 * How many epochs of key history `/keys` will answer from, counted in **rows kept**: the current
 * epoch and the seven before it.
 *
 * The number is a judgement about a device that is dark across several removals, and the failure
 * modes on either side are not symmetric. Too small and a device that missed two rotations over a
 * weekend is refused and has to be re-paired by hand. Too large and a device somebody removed
 * eight rotations ago is still spending reads against this table. Eight is where those meet:
 * nine removals with one device dark is not a case worth carrying state for, and spec §4 says so
 * — the refusal is the answer, and it is a loud one rather than a silence.
 */
export const EPOCH_HISTORY = 8;

/**
 * How many devices one group — which is to say one Patreon account — may hold at once.
 *
 * **Five per account and five per group are the same number because they are the same count.** A
 * subject is bound to exactly one group and a re-claim *moves* that binding rather than adding a
 * second, so there is no arrangement in which a subscription's devices and a group's devices are
 * different sets. One constant, one table, both questions.
 *
 * `/rotate` imports this rather than keeping its own manifest bound: a cap spelled twice is a cap
 * that eventually disagrees with itself, and the two spellings would be a rotation the relay
 * accepts naming more devices than the relay will admit.
 */
export const MAX_GROUP_DEVICES = 5;

/**
 * How long a device may go unseen before its slot is given back: ninety days.
 *
 * **This exists for the reinstall, not for tidiness.** A rotation frees the slots of devices its
 * manifest omits, which covers every removal and every departure — but a device whose data folder
 * is wiped mints a *new* id at `identity::ensure`, so the old row is named by no manifest and
 * freed by nothing. Five reinstalls would exhaust a reader's own account permanently, and the
 * only door out would be a hand edit of D1.
 *
 * Ninety days is chosen against the case it must not break: a laptop put in a drawer for a season
 * and brought back should find its slot where it left it. It is long enough that returning from
 * one is the ordinary case, and short enough that a machine sold a year ago is not still holding
 * a slot against the reader who sold it.
 */
export const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * One epoch's manifest: the epoch it belongs to and the sealed key for every device that was in
 * the group when it was written.
 *
 * **The key set *is* the roster**, which is the whole reason the distribution and the membership
 * live in one column. A device the object does not name is a device that has left, and there is
 * no second table that could arrive late, arrive out of order, or arrive at a device that cannot
 * decrypt it — which is precisely the state a rotation puts every peer in.
 */
export interface Manifest {
  epoch: number;
  keys: Record<string, string>;
}

/**
 * Compare two auths without leaking where they first differ.
 *
 * A `===` returns as soon as it finds a mismatched character, and that timing is enough to walk a
 * guessed auth into a valid one a character at a time — this is a credential, and the whole of
 * what stands between a removed device and re-entry.
 *
 * **The length check ahead of the loop is not a leak.** Both sides are 64 lowercase hex
 * characters by the time they reach here — the stored value is this design's own HKDF output and
 * the presented one has been through the route handler's character check — so the length is a
 * constant of the format rather than a near miss.
 *
 * `token.ts` has these same six lines for its signatures and does not export them. That is the
 * one duplication in this file, and it is left rather than reached across for: exporting from
 * `token.ts` is an edit to a file this change does not own, and a shared helper is worth having
 * the day somebody wants a third copy rather than a second.
 */
export function equalsConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The manifest as an object, or a throw.
 *
 * **An unreadable manifest must not be read as an empty one, and that is not a preference.** The
 * key set is the roster (spec §2.3), so an empty object at an epoch higher than a device's own is
 * positive evidence that the device was removed — and every device in the group would act on it
 * at once, on their next sync, and leave a group nobody removed them from. A throw here is a 500
 * on `/keys`: every device stalls exactly where it is, which is recoverable by fixing the row.
 * The two failures are not the same size, so the fallback goes to the recoverable one.
 *
 * This column is written by `JSON.stringify` in this same file, so the only ways to reach the
 * throw are corruption and a hand edit. Both are worth a 500 that names the group.
 */
function parseManifest(text: string, group: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`unreadable key manifest for group ${group}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`unreadable key manifest for group ${group}`);
  }
  const entries = Object.entries(parsed);
  if (!entries.every(([, blob]) => typeof blob === "string")) {
    throw new Error(`unreadable key manifest for group ${group}`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Register a group's first relay auth, at the epoch the claiming device is standing on.
 *
 * **`/claim` is the only place a group's first auth can come from**, and that is what spec §2.4's
 * "no membership, no removal" rests on: `/rotate` authenticates against an auth only this
 * function can seed, so a group nobody has connected a membership to has no way to publish a
 * rotation at all.
 *
 * **The manifest is empty and that is the correct value, not a placeholder.** A group that has
 * claimed and never rotated has never distributed a key, so there is nothing to list. Its
 * emptiness is safe only because `/keys` readers compare epochs first — equal epochs mean
 * *nothing to do* and the manifest is not consulted. Without that guard this row is the one that
 * dissolves a healthy group; with it, it is a row that says "the group is at epoch N" and no more.
 *
 * **`INSERT OR IGNORE`, because a claim is not always a first claim.** A reader who sells the
 * laptop holding the refresh secret connects Patreon again on another device and re-claims the
 * same group (spec §4), at whatever epoch that group has reached by then. Writing over the row
 * would replace a manifest the relay is holding with an empty one, which is every remaining
 * device reading itself as removed. Ignoring leaves the distribution alone and still re-points
 * the entitlement's mirror, which is the half a re-claim actually needs to change.
 *
 * ⚠️ **And `OR IGNORE` alone is not enough, because the key is `(group_id, epoch)` rather than
 * `group_id`.** A device re-claiming its own group while it is *behind* conflicts with nothing:
 * it inserts a **second** row at its own older epoch and then re-points `entitlements.group_auth`
 * at the auth it derived from a key the group has already rotated past. Every device that is
 * caught up then fails `authIsCurrent` — a 401 on the group door — until somebody rotates again,
 * and the stale row is meanwhile accepted by `authIsRecent`, so the behind device keeps working
 * where it is the one that should not.
 *
 * That is reachable through the ordinary repair: "reconnect Patreon once" is what a group claimed
 * before `group_keys` existed has to do, and nothing says which device to do it on. Pressed on
 * the one that happens to be behind, the repair breaks the devices that were fine.
 *
 * **So both statements carry the same guard: this epoch must be at least the highest the group
 * has.** Behind, the claim still succeeds and still mints a grant — it is a legitimate press by a
 * paying reader — and simply leaves the group's key registration alone, which is the state that
 * was already correct.
 */
export async function seedGroup(
  env: Env,
  group: string,
  epoch: number,
  auth: string,
): Promise<void> {
  // `>=` and not `>`: a re-claim at the epoch the group is already on is the ordinary case, and
  // it has to reach the `UPDATE` below — the insert is swallowed by `OR IGNORE`, and the mirror
  // it re-points is the half a re-claim exists to change.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO group_keys (group_id, epoch, auth, keys, created_at)
     SELECT ?, ?, ?, ?, ?
      WHERE ? >= coalesce((SELECT max(epoch) FROM group_keys WHERE group_id = ?), -1)`,
  )
    .bind(group, epoch, auth, "{}", Date.now(), epoch, group)
    .run();

  // **Read after the insert, so `max(epoch)` includes the row just written.** Seeding at 5 leaves
  // `5 >= 5`; arriving behind at 1 against a group at 5 leaves `1 >= 5`, and the mirror is left
  // pointing where it already correctly pointed.
  await env.DB.prepare(
    `UPDATE entitlements
        SET group_epoch = ?, group_auth = ?
      WHERE group_id = ?
        AND ? >= coalesce((SELECT max(epoch) FROM group_keys WHERE group_id = ?), -1)`,
  )
    .bind(epoch, auth, group, epoch, group)
    .run();
}

/**
 * Record a rotation: a new epoch, the auth derived from the new group key, and the key sealed for
 * every device that stays. `false` when `epoch` does not strictly advance the group, and nothing
 * is written in that case.
 *
 * **The monotonic check is one statement, and that is the whole guard.** D1 has no interactive
 * transaction — `handleClaim`'s `DELETE … RETURNING` says so for the claim code and the reasoning
 * is identical here — so reading the stored epoch and then inserting is two round trips with a
 * window between them, and two requests racing it both see the old epoch and both write.
 * What is on the other side of that window is not a tidiness problem: a device that was removed
 * still knows its old auth, and re-registering it at the epoch it remembers is exactly how it
 * would get back into a group that evicted it. `INSERT … SELECT … WHERE` is atomic by
 * construction, and the `WHERE` is the sentence "strictly higher than anything this group has".
 *
 * `coalesce(…, -1)` is what makes a rotation to epoch 0 possible on a group with no rows at
 * all. Reaching this function on an unknown group is not itself a hole: `/rotate` authenticates
 * first, and an unknown group has no auth to match.
 */
export async function recordRotation(
  env: Env,
  group: string,
  epoch: number,
  auth: string,
  keys: Record<string, string>,
): Promise<boolean> {
  const written = await env.DB.prepare(
    `INSERT INTO group_keys (group_id, epoch, auth, keys, created_at)
     SELECT ?, ?, ?, ?, ?
      WHERE ? > coalesce((SELECT max(epoch) FROM group_keys WHERE group_id = ?), -1)`,
  )
    .bind(group, epoch, auth, JSON.stringify(keys), Date.now(), epoch, group)
    .run();
  if (written.meta.changes === 0) return false;

  // Prune and mirror, and the order inside the batch does not matter because it is one
  // transaction. **The prune runs on every write rather than on a schedule** — a sweep would be
  // a cron that has to know which groups exist, where this is a `DELETE` against the one group
  // the caller has already named. **The mirror is what makes `/token`'s group door a single
  // lookup**: without it that door would have to find the group's newest epoch before it could
  // compare anything, on the hottest route this table has.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM group_keys WHERE group_id = ? AND epoch <= ? - ?`).bind(
      group,
      epoch,
      EPOCH_HISTORY,
    ),
    env.DB.prepare(`UPDATE entitlements SET group_epoch = ?, group_auth = ? WHERE group_id = ?`)
      .bind(epoch, auth, group),
  ]);
  return true;
}

/**
 * The newest manifest this group has, or `null` for a group the relay has never been told about.
 *
 * `null` is a 404 on `/keys` and it is a different answer from an empty manifest: the first says
 * "no such group", the second says "this group is at epoch N and has never rotated". Collapsing
 * them would make a typo in a group id look exactly like a healthy group at epoch 0.
 */
export async function currentManifest(env: Env, group: string): Promise<Manifest | null> {
  const row = await env.DB.prepare(
    `SELECT epoch, keys FROM group_keys WHERE group_id = ? ORDER BY epoch DESC LIMIT 1`,
  )
    .bind(group)
    .first<{ epoch: number; keys: string }>();
  if (row === null) return null;
  return { epoch: row.epoch, keys: parseManifest(row.keys, group) };
}

/**
 * Is this the auth the group is standing on *right now*? The question `/token`'s group door and
 * `/rotate` ask, and the one a stale auth must fail.
 *
 * Looked up by `group_id`, which is a path segment rather than a secret, and then compared in
 * constant time. **`WHERE group_auth = ?` would be the same answer and the wrong query**: it is a
 * timing oracle on a credential, and an index probe on a secret besides.
 */
export async function authIsCurrent(env: Env, group: string, auth: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT group_auth FROM entitlements WHERE group_id = ?`)
    .bind(group)
    .first<{ group_auth: string | null }>();
  if (row === null || row.group_auth === null) return false;
  return equalsConstantTime(row.group_auth, auth);
}

/**
 * Is this an auth the group has used within the last [`EPOCH_HISTORY`] epochs? The weaker question
 * `/keys` asks, and it is weaker on purpose.
 *
 * **A device that is behind a rotation and a device that was removed are indistinguishable from
 * their auth alone** — both present a stale one — so an endpoint that demanded the current auth
 * would refuse them with one 401 and each would have to guess which it was. A device that guessed
 * wrong would either leave a group it is still in or sit for ever in one it is not. `/keys`
 * accepts the stale auth and answers with the manifest, and the *manifest* is what tells them
 * apart: a blob means catch up, no blob means you are out. That is positive evidence rather than
 * an inference from a refusal.
 *
 * The residual cost, accepted in spec §4: a removed device can spend `/keys` reads until its auth
 * ages out of the window. Those are D1 reads on a route that never reaches the Durable Object, so
 * nothing on the metered path is exposed by it.
 *
 * **No `WHERE auth = ?`, for `authIsCurrent`'s reason**, and the loop deliberately does not stop
 * at the first match: `equalsConstantTime(row.auth, auth) || seen` evaluates the comparison before
 * the `||` can short-circuit, so every stored auth is compared and the time this takes says
 * nothing about which row matched, or whether one did early.
 */
export async function authIsRecent(env: Env, group: string, auth: string): Promise<boolean> {
  const { results } = await env.DB.prepare(`SELECT auth FROM group_keys WHERE group_id = ?`)
    .bind(group)
    .all<{ auth: string }>();
  let seen = false;
  for (const row of results) seen = equalsConstantTime(row.auth, auth) || seen;
  return seen;
}

/**
 * The devices this group holds *right now*: every row the TTL has not aged out, with the aged-out
 * ones deleted on the way past.
 *
 * **The prune is here rather than on a schedule**, and it is `recordRotation`'s argument again: a
 * sweep would be a cron that has to discover which groups exist, where this is a `DELETE` against
 * the one group the caller has already named. Every path that cares about the count comes through
 * this function, so a stale row cannot be counted anywhere without also being deleted here.
 *
 * **Prune first, then read, and not the other way round.** Reading and filtering in JavaScript
 * would answer the same number and leave the rows on disk for ever, which is precisely the
 * failure the TTL exists to prevent — a wiped reinstall's abandoned id would go on occupying
 * storage after it had stopped occupying a slot, and nothing would ever remove it.
 *
 * The set comes back rather than the size because `admitDevice` needs both facts — how many, and
 * whether *this* one is among them — and asking twice would be two reads for one question.
 * `last_seen < cutoff` and not `<=`: a row seen exactly ninety days ago is still inside the
 * window, which is the reading that makes the constant a duration rather than an off-by-one.
 */
async function liveDevices(env: Env, group: string, nowMs: number): Promise<string[]> {
  await env.DB.prepare(`DELETE FROM group_devices WHERE group_id = ? AND last_seen < ?`)
    .bind(group, nowMs - DEVICE_TTL_MS)
    .run();
  const { results } = await env.DB.prepare(
    `SELECT device_id FROM group_devices WHERE group_id = ?`,
  )
    .bind(group)
    .all<{ device_id: string }>();
  return results.map((row) => row.device_id);
}

/**
 * How many devices this group is holding, the aged-out ones pruned and not counted.
 *
 * Exported for the callers that want the number to put in a sentence rather than a decision to
 * act on — the refusal itself is `admitDevice`'s, which asks the same question and then writes.
 */
export async function liveDeviceCount(env: Env, group: string, nowMs: number): Promise<number> {
  return (await liveDevices(env, group, nowMs)).length;
}

/**
 * Register a device against its group, and answer whether it is allowed in.
 *
 * **`false` means *new device, full group*, and nothing else.** A device already on the roll is
 * always re-admitted, however full the group is — it is not asking for a slot, it is using the
 * one it has — and getting that wrong would lock a settled five-device household out of syncing
 * on the day the fifth device was admitted. That is what the `ON CONFLICT DO UPDATE` is for as
 * much as the membership test above it: the test is the decision, the clause is what makes the
 * write idempotent even if the two disagreed.
 *
 * **Nothing is written when the answer is `false`.** A refused device must not move a `last_seen`
 * it does not own, and must not leave a row that the next call would then re-admit.
 *
 * **Call it on a token that would otherwise be issued, never before the entitlement has settled.**
 * A dead membership that consumed a slot on its way to a 401 would spend a reader's fifth device
 * on a request that was refused anyway.
 */
export async function admitDevice(
  env: Env,
  group: string,
  device: string,
  nowMs: number,
): Promise<boolean> {
  const live = await liveDevices(env, group, nowMs);
  if (!live.includes(device) && live.length >= MAX_GROUP_DEVICES) return false;
  await env.DB.prepare(
    `INSERT INTO group_devices (group_id, device_id, first_seen, last_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (group_id, device_id) DO UPDATE SET last_seen = ?`,
  )
    .bind(group, device, nowMs, nowMs, nowMs)
    .run();
  return true;
}

/**
 * Drop the rows for devices this manifest does not name — the way a slot is freed.
 *
 * **The manifest is the roster, so `/rotate` is the only place a slot needs to be given back.** A
 * removal and a departure both publish one, so neither needs a mechanism of its own: the set of
 * devices holding slots is reconciled against the set of devices holding keys, and #307 already
 * made the second of those the authority.
 *
 * **Read, then delete what was read, rather than one `DELETE … NOT IN (…)`.** The difference only
 * shows up against a device admitted between the two statements, and it decides which way that
 * race falls: `NOT IN` would delete a row written after the manifest was composed, freeing a slot
 * for a device that is legitimately present, where this leaves it alone until the next rotation
 * sees it. Under-deleting a slot counter costs one slot for one rotation; over-deleting it evicts
 * a device that just presented a valid token. Note that neither is a membership decision —
 * membership is the manifest, and this table only counts.
 */
export async function keepOnly(env: Env, group: string, devices: string[]): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT device_id FROM group_devices WHERE group_id = ?`,
  )
    .bind(group)
    .all<{ device_id: string }>();
  const keep = new Set(devices);
  const doomed = results.map((row) => row.device_id).filter((id) => !keep.has(id));
  if (doomed.length === 0) return;
  await env.DB.batch(
    doomed.map((id) =>
      env.DB.prepare(`DELETE FROM group_devices WHERE group_id = ? AND device_id = ?`).bind(
        group,
        id,
      ),
    ),
  );
}

/**
 * Forget a group's devices entirely: what a binding moving off a group leaves behind.
 *
 * A re-claim points a subject at a different group and drops the old one's log and keys with it
 * (spec §3). Leaving these rows would hold slots in a group whose manifest no longer exists —
 * against a count that nothing would ever take again, since the count is only taken per group.
 * They are not orphaned so much as unreachable, which is the worse of the two.
 */
export async function forgetGroup(env: Env, group: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM group_devices WHERE group_id = ?`).bind(group).run();
}
