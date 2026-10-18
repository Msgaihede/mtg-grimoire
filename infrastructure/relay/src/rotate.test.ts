import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./fakeD1";
import {
  admitDevice,
  authIsCurrent,
  authIsRecent,
  currentManifest,
  recordRotation,
  seedGroup,
} from "./groupauth";
import worker, { type Env } from "./index";

/**
 * `/rotate` and `/keys`, driven through the router rather than by calling their handlers.
 *
 * **Through `worker.fetch` and not through `handleRotate`/`handleKeys` directly, deliberately.**
 * Where these two routes sit *relative to the bearer gate* is half of what this task is: a
 * `/keys` behind the gate refuses exactly the caller it exists to serve, because a device that
 * has been rotated away from cannot mint a token. A suite that called the handlers would pass
 * unchanged with the routes moved behind the gate, so the placement — the thing most likely to
 * be undone by a later edit to `index.ts` — would be untested.
 *
 * That makes this one of the two relay suites that drive a fetch handler — `admit.test.ts` is the
 * other, for the push admission's placement and the same reason — against `vitest.config.ts`'s note
 * that the I/O here is left to a deploy. The exception is affordable for one reason: these
 * two routes decide everything in D1, so `fakeD1`'s SQL evaluator is the whole of what they
 * need. The one thing either sends the Durable Object — an accepted rotation's roster — is a
 * request whose *path and body* are the question, not anything the object does with them, so
 * [`relayEnv`] records it rather than needing workerd to run it.
 */

/**
 * A group auth or a refresh secret: 64 lowercase hex characters, distinct per number.
 *
 * Both credentials really are this shape — `relay_auth` is 32 bytes as hex and `randomSecret`
 * is 32 bytes through the same `hex` — and the routes check it, so a fixture that used
 * `"auth-1"` the way `groupauth.test.ts` does would be refused before it reached anything.
 */
function hex64(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/**
 * The clock every `admitDevice` in this file is given.
 *
 * A fixed stamp rather than `Date.now()`, and one stamp for every call, because nothing here is
 * about the TTL: `DEVICE_TTL_MS` is `groupauth.test.ts`'s subject and these tests would be
 * asserting about the prune by accident if the rows they seed could age between two lines.
 */
const NOW = 1_700_000_000_000;

/** One request the Worker sent a group's Durable Object: where it was aimed, and what it said. */
interface Reached {
  path: string;
  method: string | undefined;
  body: unknown;
}

/**
 * A `GROUP` namespace that records every request aimed at it and answers each with `status`.
 *
 * **The path and the body and not merely a count**, for `claim.test.ts`'s `fakeGroups` reason: the
 * path carries the group id and the body carries the roster, and a spy that only counted would
 * pass an implementation that told the wrong group, or told the right one the wrong devices.
 */
function recordingGroups(reached: Reached[], status = 204): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (url: string, init?: RequestInit) => {
        reached.push({
          path: new URL(url).pathname,
          method: init?.method,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return Promise.resolve(new Response(null, { status }));
      },
    }),
  } as unknown as DurableObjectNamespace;
}

/**
 * `fakeEnv` plus the two bindings the router itself reads, and `reached`: what the Durable Object
 * was sent.
 *
 * `RELAY_HMAC_KEY` is set even though these routes stand ahead of the gate that uses it,
 * **because the mutation this task is checked with needs it**: moving the two route lines below
 * the gate has to produce the gate's 401 rather than the 500 an unset binding gives, or the
 * mutation would be caught for the wrong reason.
 *
 * ⚠️ **`GROUP` used to throw on so much as being read**, because neither route reached the Durable
 * Object at all. An accepted rotation now sends it one roster, so the binding records instead —
 * and the question the throw used to answer is asked of `reached` directly: `/keys` and every
 * refused rotation must leave it empty. A throw would not have kept asking it for `/rotate`
 * anyway, since the roster is best effort and a thrown binding is exactly the failure it
 * swallows.
 */
function relayEnv(...groups: string[]): Env & { reached: Reached[] } {
  const reached: Reached[] = [];
  return {
    ...fakeEnv(...groups),
    RELAY_HMAC_KEY: "test-signing-key",
    GROUP: recordingGroups(reached),
    reached,
  };
}

function rotateRequest(group: string, credential: string, body: unknown): Request {
  return new Request(`https://relay.example/g/${group}/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify(body),
  });
}

/** `epoch` is spliced as given, so a test can ask with text no epoch should be read out of. */
function keysRequest(
  group: string,
  credential: string,
  device: string,
  epoch?: number | string,
): Request {
  const query = epoch === undefined ? `device=${device}` : `device=${device}&epoch=${epoch}`;
  return new Request(`https://relay.example/g/${group}/keys?${query}`, {
    headers: { authorization: `Bearer ${credential}` },
  });
}

/** A manifest of `devices` devices, each holding a blob of `blobChars` characters. */
function manifestOf(devices: number, blobChars = 8): Record<string, string> {
  const keys: Record<string, string> = {};
  for (let i = 0; i < devices; i += 1) keys[`d${i}`] = "b".repeat(blobChars);
  return keys;
}

/**
 * The device ids `group_devices` is holding for one group, sorted so the assertion is about the
 * set rather than about the order rows happened to be written in.
 *
 * **Read with SQL rather than through `liveDeviceCount`, because the number is not the question.**
 * Which rows survived a rotation is: a count of two cannot tell the row that should have been
 * freed from the row that should have been kept, and every mutation worth catching here swaps one
 * for the other rather than changing how many there are.
 */
async function devicesOf(env: Env, group: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT device_id FROM group_devices WHERE group_id = ?`)
    .bind(group)
    .all<{ device_id: string }>();
  return results.map((row) => row.device_id).sort();
}

/**
 * Put a refresh secret on the group's entitlement, held by `device` — or by nobody the relay
 * knows of, which is every row claimed before `refresh_device` existed.
 */
async function holdSecret(
  env: Env,
  group: string,
  secret: string,
  device: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE entitlements SET refresh_secret = ?, refresh_device = ? WHERE group_id = ?`,
  )
    .bind(secret, device, group)
    .run();
}

/** The group's entitlement's refresh secret and its holder, as the row has them. */
async function secretOf(
  env: Env,
  group: string,
): Promise<{ refresh_secret: string | null; refresh_device: string | null } | null> {
  return env.DB.prepare(
    `SELECT refresh_secret, refresh_device FROM entitlements WHERE group_id = ?`,
  )
    .bind(group)
    .first();
}

// ---------------------------------------------------------------------------------------
// POST /g/{group}/rotate
// ---------------------------------------------------------------------------------------

describe("POST /rotate", () => {
  it("accepts a rotation signed with the group's current auth", async () => {
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));

    const response = await worker.fetch(
      rotateRequest("g1", hex64(0), {
        epoch: 1,
        auth: hex64(1),
        keys: { desk: "blob-desk", phone: "blob-phone" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ epoch: 1 });
    expect(await currentManifest(env, "g1")).toEqual({
      epoch: 1,
      keys: { desk: "blob-desk", phone: "blob-phone" },
    });
    // The mirror onto the entitlement is what `/token`'s group door reads, so a rotation that
    // wrote only the history would leave every device unable to mint a token an epoch later.
    expect(await authIsCurrent(env, "g1", hex64(1))).toBe(true);
  });

  it("refuses the refresh secret, even one whose recorded holder the manifest names", async () => {
    // **The group auth is the only credential this route takes.** The refresh secret used to be a
    // second one, and no shipped client ever presented it — `client::post_rotation` always sends
    // the auth of the epoch it is replacing — while a lost phone still logged into Patreon could
    // press Connect, be handed a fresh secret recorded against itself, and publish a manifest of
    // its choosing, naming itself. A real-shaped secret with a recorded holder, so what refuses it
    // is the door being gone rather than its shape or a missing holder.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    const secret = hex64(0xbeef);
    await holdSecret(env, "g1", secret, "phone");

    const response = await worker.fetch(
      rotateRequest("g1", secret, { epoch: 1, auth: hex64(1), keys: { phone: "blob-phone" } }),
      env,
    );

    expect(response.status).toBe(401);
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 0, keys: {} });
  });

  it("refuses an auth the group has left behind", async () => {
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    expect(await recordRotation(env, "g1", 1, hex64(1), { desk: "blob-desk" })).toBe(true);

    // Epoch 0's auth is what a device removed at epoch 1 still holds. `/keys` accepts it and
    // must; `/rotate` must not, because accepting it is that device publishing its own
    // membership back into the group that evicted it.
    const response = await worker.fetch(
      rotateRequest("g1", hex64(0), { epoch: 2, auth: hex64(2), keys: { ghost: "blob-ghost" } }),
      env,
    );

    expect(response.status).toBe(401);
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 1, keys: { desk: "blob-desk" } });
  });

  it("refuses an epoch that does not advance the group", async () => {
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));

    const equalToTheClaim = await worker.fetch(
      rotateRequest("g1", hex64(0), { epoch: 0, auth: hex64(0x0b), keys: {} }),
      env,
    );
    expect(equalToTheClaim.status).toBe(409);
    expect(await equalToTheClaim.json()).toEqual({
      error: "that rotation does not advance the group's key",
    });

    const advancing = await worker.fetch(
      rotateRequest("g1", hex64(0), { epoch: 1, auth: hex64(1), keys: { desk: "blob-desk" } }),
      env,
    );
    expect(advancing.status).toBe(200);

    // The same epoch again, and the one below it, now presented with the credential that **is**
    // current — so what refuses them is the monotonic guard and nothing else.
    const repeated = await worker.fetch(
      rotateRequest("g1", hex64(1), { epoch: 1, auth: hex64(0x1b), keys: { ghost: "blob" } }),
      env,
    );
    expect(repeated.status).toBe(409);
    const lower = await worker.fetch(
      rotateRequest("g1", hex64(1), { epoch: 0, auth: hex64(0x2b), keys: {} }),
      env,
    );
    expect(lower.status).toBe(409);

    // A refused rotation leaves no trace, and the auth is the half that matters: writing it
    // without the epoch row would hand the group's current credential to the caller that was
    // just refused.
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 1, keys: { desk: "blob-desk" } });
    expect(await authIsCurrent(env, "g1", hex64(1))).toBe(true);
    expect(await authIsCurrent(env, "g1", hex64(0x1b))).toBe(false);
  });

  it("accepts a removal's step of two as well as a join's step of one", async () => {
    // **The join/removal marker is the step, and the relay's whole part in it is accepting both.**
    // A removal or a departure advances the epoch by two and a join by one; the rotator bound the
    // epoch into every blob, so what the relay stores is what each device reads when it adopts.
    // Two literal steps from two different starting epochs, so the bound is relative to where the
    // group stands and not to where it was claimed.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));

    const removal = await worker.fetch(
      rotateRequest("g1", hex64(0), { epoch: 2, auth: hex64(2), keys: { desk: "blob-desk-2" } }),
      env,
    );
    expect(removal.status).toBe(200);
    expect(await removal.json()).toEqual({ epoch: 2 });

    const join = await worker.fetch(
      rotateRequest("g1", hex64(2), {
        epoch: 3,
        auth: hex64(3),
        keys: { desk: "blob-desk-3", tablet: "blob-tablet-3" },
      }),
      env,
    );
    expect(join.status).toBe(200);

    const another = await worker.fetch(
      rotateRequest("g1", hex64(3), { epoch: 5, auth: hex64(5), keys: { desk: "blob-desk-5" } }),
      env,
    );
    expect(another.status).toBe(200);
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 5, keys: { desk: "blob-desk-5" } });
    expect(await authIsCurrent(env, "g1", hex64(5))).toBe(true);
  });

  it("refuses an epoch that steps past a removal's two, and records nothing", async () => {
    // **Advancing is not enough; the epoch has to be one or two ahead.** Every device plans
    // `epoch + 1` for a join or `epoch + 2` for a removal from the epoch it is standing on, and
    // the group auth it presents is only current if that epoch is the relay's — so no shipped
    // client can send anything further. A caller that can send `1e9` can instead put the group on
    // an epoch no device will ever plan from again, with a manifest of its choosing: `{}` reads as
    // a removal notice to every one. **`3` is the literal that pins the bound**: a `+ 3` in
    // `recordRotation`'s `WHERE` accepts it and nothing else here would notice.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));

    for (const epoch of [3, 1_000_000_000, Number.MAX_SAFE_INTEGER]) {
      const skipping = await worker.fetch(
        rotateRequest("g1", hex64(0), { epoch, auth: hex64(0xa), keys: {} }),
        env,
      );
      // 422 and not the 409 above: that one is a device that is behind, which is a race a
      // shipped client can lose and recover from; this one no shipped client can produce.
      expect(skipping.status).toBe(422);
    }

    expect(await currentManifest(env, "g1")).toEqual({ epoch: 0, keys: {} });
    expect(await authIsCurrent(env, "g1", hex64(0))).toBe(true);
    // And the refusal closed nothing: the next epoch is still the one the group will take.
    const next = await worker.fetch(
      rotateRequest("g1", hex64(0), { epoch: 1, auth: hex64(1), keys: { desk: "blob-desk" } }),
      env,
    );
    expect(next.status).toBe(200);
  });

  it("refuses a body it cannot read as a rotation", async () => {
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));

    const status = async (body: unknown): Promise<number> =>
      (await worker.fetch(rotateRequest("g1", hex64(0), body), env)).status;

    expect(await status({ auth: hex64(1), keys: {} })).toBe(400);
    expect(await status({ epoch: "1", auth: hex64(1), keys: {} })).toBe(400);
    // `1.5` compares as greater than `0` and would be **stored**, leaving the group standing on
    // an epoch no device can derive an auth for — the epoch is in the derivation's `info`.
    expect(await status({ epoch: 1.5, auth: hex64(1), keys: {} })).toBe(400);
    expect(await status({ epoch: -1, auth: hex64(1), keys: {} })).toBe(400);
    expect(await status({ epoch: 1, auth: "not-hex", keys: {} })).toBe(400);
    // `hex64(0xabc)` and not `hex64(1)`: the latter is all digits, so uppercasing it changes
    // nothing and the case rule would be asserted against a string that never had a case.
    expect(await status({ epoch: 1, auth: hex64(0xabc).toUpperCase(), keys: {} })).toBe(400);
    expect(await status({ epoch: 1, auth: hex64(1) })).toBe(400);
    expect(await status({ epoch: 1, auth: hex64(1), keys: null })).toBe(400);
    expect(await status({ epoch: 1, auth: hex64(1), keys: [] })).toBe(400);

    const unreadable = new Request("https://relay.example/g/g1/rotate", {
      method: "POST",
      headers: { authorization: `Bearer ${hex64(0)}` },
      body: "{not json",
    });
    expect((await worker.fetch(unreadable, env)).status).toBe(400);

    // Every one of those is a 400 **and** a no-op: the group is still standing where it claimed.
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 0, keys: {} });
  });

  it("refuses a manifest larger than the relay will store", async () => {
    // **This is the one place a caller chooses how much the relay stores**, so both ceilings are
    // pinned from both sides. An assertion on the refusal alone would stay green with the limit
    // set anywhere higher than the value it happened to try.
    const status = async (keys: unknown): Promise<number> => {
      const env = relayEnv("g1");
      await seedGroup(env, "g1", 0, hex64(0));
      const request = rotateRequest("g1", hex64(0), { epoch: 1, auth: hex64(1), keys });
      return (await worker.fetch(request, env)).status;
    };

    // **Five and six as literals, never `MAX_GROUP_DEVICES` and `MAX_GROUP_DEVICES + 1`.** The
    // cap is the thing under test, and an assertion written in terms of the constant it is
    // checking moves with it — it would stay green at four devices and at forty. Five accepted
    // is what fails if the cap is lowered; six refused is what fails if it is raised. This used
    // to read 64 and 65, which was the manifest keeping a bound of its own; the manifest cap and
    // the admission cap are now one constant, so the numbers here are the account's five.
    expect(await status(manifestOf(5))).toBe(200);
    expect(await status(manifestOf(6))).toBe(400);
    expect(await status({ desk: "b".repeat(4096) })).toBe(200);
    expect(await status({ desk: "b".repeat(4097) })).toBe(400);

    // A blob is never decoded here — it is sealed to a key the relay does not hold — but empty
    // is not a blob, and neither is a number.
    expect(await status({ desk: "" })).toBe(400);
    expect(await status({ desk: 7 })).toBe(400);
    // A device id the router could never carry in a path, for the character class's own reason.
    expect(await status({ "desk.two": "blob" })).toBe(400);
  });

  it("refuses a group no membership has ever claimed", async () => {
    // Spec §2.4's "no membership, no removal", arriving as a 401. `/claim` is the only place a
    // group's first auth can come from, so a group nobody has connected has no credential to
    // present and no way to publish a rotation at all — which is what stops today's bug, where
    // the removing device moves to epoch N+1 alone and stalls everyone else the moment somebody
    // finally connects.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));

    const response = await worker.fetch(
      rotateRequest("nope", hex64(0), { epoch: 1, auth: hex64(1), keys: {} }),
      env,
    );

    expect(response.status).toBe(401);
    expect(await currentManifest(env, "nope")).toBeNull();
  });

  // -------------------------------------------------------------------------------------
  // The device roll (spec §4.4)
  // -------------------------------------------------------------------------------------

  it("frees the slots of the devices the new manifest omits", async () => {
    // **The manifest is the roster, so publishing one is how a slot is given back** — a removal
    // and a departure both come through here, and neither needs a mechanism of its own.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    for (const device of ["desk", "phone", "tablet", "laptop", "watch"]) {
      expect(await admitDevice(env, "g1", device, NOW)).toBe(true);
    }
    // The group is full before the rotation, which is what makes the last assertion below mean
    // something: without it, "a sixth device is admitted" would be true of an untouched roll.
    expect(await admitDevice(env, "g1", "newcomer", NOW)).toBe(false);

    const response = await worker.fetch(
      rotateRequest("g1", hex64(0), {
        epoch: 1,
        auth: hex64(1),
        keys: { desk: "blob-desk", phone: "blob-phone" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    // Red two ways, and they are the two mistakes worth telling apart: no `keepOnly` at all
    // leaves all five here, and a `keepOnly` that inverted its set would leave none.
    expect(await devicesOf(env, "g1")).toEqual(["desk", "phone"]);
    // And the freed slots are slots rather than bookkeeping: the device that was refused a
    // moment ago is admitted now, against the same cap and the same clock.
    expect(await admitDevice(env, "g1", "newcomer", NOW)).toBe(true);
  });

  it("frees nothing when it refuses the rotation", async () => {
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    for (const device of ["desk", "phone"]) {
      expect(await admitDevice(env, "g1", device, NOW)).toBe(true);
    }

    // A 409: the epoch does not advance, so the manifest is never adopted. It names only `desk`,
    // so a `keepOnly` placed **above** `recordRotation` would take `phone`'s row on the way to
    // refusing the very rotation that named it — a device holding a live but non-advancing auth
    // could then hand back every other slot in the group at will.
    const stale = await worker.fetch(
      rotateRequest("g1", hex64(0), { epoch: 0, auth: hex64(0x0b), keys: { desk: "blob-desk" } }),
      env,
    );
    expect(stale.status).toBe(409);
    expect(await devicesOf(env, "g1")).toEqual(["desk", "phone"]);

    // A 401: an advancing epoch, but a credential this group has never held. A `keepOnly` above
    // the authorisation check would let any caller empty the roll of any group id it can name.
    const unauthorised = await worker.fetch(
      rotateRequest("g1", hex64(0xdead), {
        epoch: 1,
        auth: hex64(1),
        keys: { desk: "blob-desk" },
      }),
      env,
    );
    expect(unauthorised.status).toBe(401);
    expect(await devicesOf(env, "g1")).toEqual(["desk", "phone"]);
  });

  it("frees no slot belonging to another group", async () => {
    const env = relayEnv("g1", "g2");
    await seedGroup(env, "g1", 0, hex64(0));
    await seedGroup(env, "g2", 0, hex64(0x2a));
    expect(await admitDevice(env, "g1", "desk", NOW)).toBe(true);
    expect(await admitDevice(env, "g1", "phone", NOW)).toBe(true);

    // ⚠️ **`phone` is a name g1's rotation *drops*, and that is the whole of this fixture.** The
    // same test written with a foreign row named after a device g1 **keeps** passes against a
    // group-blind `DELETE FROM group_devices WHERE device_id = ?`, because the only id such a
    // delete is handed is one nothing was going to remove — there is nothing to observe. The
    // foreign row has to carry a name from the doomed set. `tablet` is the second half: it is in
    // neither g1's roll nor its manifest, so it is what a `keepOnly` called with the wrong group
    // takes.
    expect(await admitDevice(env, "g2", "phone", NOW)).toBe(true);
    expect(await admitDevice(env, "g2", "tablet", NOW)).toBe(true);

    const response = await worker.fetch(
      rotateRequest("g1", hex64(0), { epoch: 1, auth: hex64(1), keys: { desk: "blob-desk" } }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await devicesOf(env, "g1")).toEqual(["desk"]);
    expect(await devicesOf(env, "g2")).toEqual(["phone", "tablet"]);
  });
});

// ---------------------------------------------------------------------------------------
// The roster the Durable Object is told
// ---------------------------------------------------------------------------------------

describe("POST /rotate — the group's log hears who is left", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the adopted manifest's device list to that group's object, once", async () => {
    // A departed device's last ack holds the log's compaction floor for as long as the object
    // thinks it is a member, and the object has no roster but this one. `laptop` is on the roll
    // and off the manifest, so a roster built from `group_devices` instead of the manifest would
    // name it — and the path is asserted with the group in it, because a roster sent to the
    // wrong object is one the right object never hears.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    expect(await admitDevice(env, "g1", "laptop", NOW)).toBe(true);

    const response = await worker.fetch(
      rotateRequest("g1", hex64(0), {
        epoch: 2,
        auth: hex64(2),
        keys: { desk: "blob-desk", phone: "blob-phone" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(env.reached).toEqual([
      { path: "/g/g1/roster", method: "POST", body: { epoch: 2, devices: ["desk", "phone"] } },
    ]);
  });

  it("sends the object nothing for a rotation it refuses", async () => {
    // **The reason these routes can stand outside the bearer gate is that no refusal reaches the
    // metered line**, and a roster sent ahead of `recordRotation` would also tell the log to
    // forget devices for a manifest the group never adopted. One of each refusal, every one of
    // which names only `desk` — so a post from any of them would be visible below.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    const keys = { desk: "blob-desk" };

    const statuses: number[] = [];
    for (const request of [
      rotateRequest("g1", hex64(0xdead), { epoch: 1, auth: hex64(1), keys }),
      rotateRequest("g1", hex64(0), { epoch: 1, auth: "not-hex", keys }),
      rotateRequest("g1", hex64(0), { epoch: 0, auth: hex64(0x0b), keys }),
      rotateRequest("g1", hex64(0), { epoch: 3, auth: hex64(3), keys }),
    ]) {
      statuses.push((await worker.fetch(request, env)).status);
    }

    expect(statuses).toEqual([401, 400, 409, 422]);
    expect(env.reached).toEqual([]);
  });

  it("answers 200 when the object cannot be told: the rotation already stands", async () => {
    // **Best effort, and the direction matters.** The rotation is recorded in D1 before the
    // roster is sent, so a 500 here would tell the rotator it was refused — and a rotator that
    // believes that does not commit the epoch every other device is about to adopt. Two ways
    // the object can fail — an error status, and a fetch that rejects — and both have to leave
    // the rotation, the retirement and the freed slot exactly as a success would.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const failing of [
      recordingGroups([], 500),
      {
        idFromName: (name: string) => name,
        get: () => ({ fetch: () => Promise.reject(new Error("object unreachable")) }),
      } as unknown as DurableObjectNamespace,
    ]) {
      const env = relayEnv("g1");
      env.GROUP = failing;
      await seedGroup(env, "g1", 0, hex64(0));
      await holdSecret(env, "g1", hex64(0xbeef), "phone");
      expect(await admitDevice(env, "g1", "phone", NOW)).toBe(true);

      const response = await worker.fetch(
        rotateRequest("g1", hex64(0), { epoch: 2, auth: hex64(2), keys: { desk: "blob-desk" } }),
        env,
      );

      expect(response.status).toBe(200);
      expect(await currentManifest(env, "g1")).toEqual({ epoch: 2, keys: { desk: "blob-desk" } });
      expect(await secretOf(env, "g1")).toEqual({ refresh_secret: null, refresh_device: null });
      expect(await devicesOf(env, "g1")).toEqual([]);
    }
    // Swallowed, not silenced: each failure is a line in the Worker's log.
    expect(errors).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------------------
// The refresh secret, which a rotation retires with its device
// ---------------------------------------------------------------------------------------

describe("POST /rotate — the refresh secret dies with its device's membership", () => {
  it("leaves a removed phone's secret unable to publish anything", async () => {
    // **The whole bug, end to end.** The phone presses Connect, so it holds the refresh secret;
    // it is lost, and the desk removes it. Whoever has the phone's `user.db` still has that
    // secret, and `/rotate` takes it — so `{epoch: 1e9, keys: {}}` would put every remaining
    // device on an epoch with no blob for it, which each reads as its own removal and leaves.
    const env = relayEnv("g1");
    // A real-shaped secret on the row before the claim, so a claim that handed the stored secret
    // back would hand back one this route accepts — rather than `fakeEnv`'s placeholder, which
    // `/rotate` refuses for its shape and would make this test pass for the wrong reason.
    await holdSecret(env, "g1", hex64(0xbeef), null);
    await env.DB.prepare(`INSERT INTO claim_codes (code, subject, expires_at) VALUES (?, ?, ?)`)
      .bind("0123456789AB", "sub-0", Date.now() + 60_000)
      .run();

    const claimed = await worker.fetch(
      new Request("https://relay.example/claim", {
        method: "POST",
        body: JSON.stringify({
          code: "0123-4567-89AB",
          group: "g1",
          epoch: 0,
          auth: hex64(0),
          device: "phone",
        }),
      }),
      env,
    );
    expect(claimed.status).toBe(200);
    const { refresh } = (await claimed.json()) as { refresh: string };

    const removal = await worker.fetch(
      rotateRequest("g1", hex64(0), { epoch: 1, auth: hex64(1), keys: { desk: "blob-desk" } }),
      env,
    );
    expect(removal.status).toBe(200);

    for (const epoch of [2, 1_000_000_000]) {
      const attack = await worker.fetch(
        rotateRequest("g1", refresh, { epoch, auth: hex64(0xbad), keys: {} }),
        env,
      );
      expect(attack.status).toBe(401);
    }
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 1, keys: { desk: "blob-desk" } });
    // And it is gone rather than merely refused here: `/token`'s refresh door looks the same
    // column up, so the phone cannot mint a token for the group either.
    expect(await secretOf(env, "g1")).toEqual({ refresh_secret: null, refresh_device: null });

    // **Then the phone, still logged into Patreon, presses Connect again.** Entitlement is not
    // group membership (#752): stale auth must receive neither a new secret nor a token that
    // would open the plaintext share routes after removal.
    await env.DB.prepare(`INSERT INTO claim_codes (code, subject, expires_at) VALUES (?, ?, ?)`)
      .bind("ABCDEFGHJKMN", "sub-0", Date.now() + 60_000)
      .run();
    const reclaimed = await worker.fetch(
      new Request("https://relay.example/claim", {
        method: "POST",
        body: JSON.stringify({
          code: "ABCD-EFGH-JKMN",
          group: "g1",
          epoch: 0,
          auth: hex64(0),
          device: "phone",
        }),
      }),
      env,
    );
    expect(reclaimed.status).toBe(401);
    expect(await reclaimed.json()).toEqual({ error: "unauthorized" });
    expect(await secretOf(env, "g1")).toEqual({ refresh_secret: null, refresh_device: null });
    const rejoin = await worker.fetch(
      rotateRequest("g1", refresh, { epoch: 2, auth: hex64(0xbad), keys: { phone: "blob-phone" } }),
      env,
    );
    expect(rejoin.status).toBe(401);
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 1, keys: { desk: "blob-desk" } });
  });

  it("keeps the secret while the manifest still names the device holding it", async () => {
    // The other half, and the one an over-eager retirement breaks: the desk removes a laptop,
    // the phone that connected Patreon stays, and its secret has to keep working.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    const secret = hex64(0xbeef);
    await holdSecret(env, "g1", secret, "phone");

    const removal = await worker.fetch(
      rotateRequest("g1", hex64(0), {
        epoch: 1,
        auth: hex64(1),
        keys: { desk: "blob-desk", phone: "blob-phone" },
      }),
      env,
    );
    expect(removal.status).toBe(200);
    expect(await secretOf(env, "g1")).toEqual({ refresh_secret: secret, refresh_device: "phone" });

    // Where the secret still matters: the phone refreshes its token through it.
    const refreshed = await worker.fetch(
      new Request("https://relay.example/token", {
        method: "POST",
        body: JSON.stringify({ refresh: secret, device: "phone" }),
      }),
      env,
    );
    expect(refreshed.status).toBe(200);
  });

  it("keeps a secret a claim minted between the retirement's read and its write", async () => {
    // D1 has no interactive transaction, so `/claim` can land between the two statements. The
    // retirement read the phone's secret; by the time it writes, the desk has pressed Connect and
    // holds a fresh one — which the manifest names, and which must survive. The write is a
    // compare-and-swap on the secret it read, and a claim always changes the secret.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    await holdSecret(env, "g1", hex64(0xbeef), "phone");
    const db = env.DB;
    env.DB = {
      ...db,
      prepare: (sql: string) => {
        if (sql.includes("SET refresh_secret = NULL")) {
          // The fake executes on `run()`, synchronously, so this lands before the retirement.
          void db
            .prepare(
              `UPDATE entitlements SET refresh_secret = ?, refresh_device = ? WHERE group_id = ?`,
            )
            .bind(hex64(0xfeed), "desk", "g1")
            .run();
        }
        return db.prepare(sql);
      },
    } as D1Database;

    const removal = await worker.fetch(
      rotateRequest("g1", hex64(0), { epoch: 1, auth: hex64(1), keys: { desk: "blob-desk" } }),
      env,
    );

    expect(removal.status).toBe(200);
    expect(await secretOf(env, "g1")).toEqual({
      refresh_secret: hex64(0xfeed),
      refresh_device: "desk",
    });
  });

  it("retires the secret when its own holder publishes a manifest without itself", async () => {
    // A departure by the device that connected Patreon. It clears its own grant locally
    // (`pairing::leave_group_now`), and the relay's copy goes with it.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    const secret = hex64(0xbeef);
    await holdSecret(env, "g1", secret, "phone");

    const departure = await worker.fetch(
      rotateRequest("g1", hex64(0), { epoch: 1, auth: hex64(1), keys: { desk: "blob-desk" } }),
      env,
    );

    expect(departure.status).toBe(200);
    expect(await secretOf(env, "g1")).toEqual({ refresh_secret: null, refresh_device: null });
  });

  it("retires a secret with no recorded holder at the next rotation, whatever it names", async () => {
    // **Every row claimed before `refresh_device` existed is this row**, and the relay cannot
    // tell whether its holder is still in the group — so the first rotation the group publishes
    // retires it. A holder that is still here drops to the group door
    // (`entitlement::refused_secret`); pressing Connect again records it.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    const secret = hex64(0xbeef);
    await holdSecret(env, "g1", secret, null);

    const viaAuth = await worker.fetch(
      rotateRequest("g1", hex64(0), {
        epoch: 1,
        auth: hex64(1),
        keys: { desk: "blob-desk", phone: "blob-phone" },
      }),
      env,
    );
    expect(viaAuth.status).toBe(200);
    expect(await secretOf(env, "g1")).toEqual({ refresh_secret: null, refresh_device: null });
  });
});

// ---------------------------------------------------------------------------------------
// GET /g/{group}/keys
// ---------------------------------------------------------------------------------------

describe("GET /keys", () => {
  it("answers the current epoch, this device's key and the roster", async () => {
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    await recordRotation(env, "g1", 1, hex64(1), { desk: "blob-desk", phone: "blob-phone" });

    const response = await worker.fetch(keysRequest("g1", hex64(1), "desk"), env);

    expect(response.status).toBe(200);
    // `removalStep` is on every 200, and literally `2`: it is what a device latches to learn it
    // may publish a removal as `+2`, so a relay answering anything else — or nothing — leaves
    // every device stepping removals by one.
    expect(await response.json()).toEqual({
      epoch: 1,
      blob: "blob-desk",
      devices: ["desk", "phone"],
      removalStep: 2,
    });
    // And `/keys` never reaches the Durable Object: it is D1 reads and nothing else, which is
    // half of why it can stand ahead of the bearer gate.
    expect(env.reached).toEqual([]);
  });

  it("tells a device that is behind apart from one that has been removed", async () => {
    // **The whole of spec §2.3, in one setup.** Both devices present epoch 1's auth, because
    // neither of them saw epoch 2 — a device that is merely behind and a device that was
    // removed are indistinguishable from their credential alone. The manifest is what separates
    // them: a blob means catch up, no blob means you are out. Neither could mint a token on
    // that stale auth, which is why this route stands ahead of the bearer gate.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    await recordRotation(env, "g1", 1, hex64(1), { desk: "blob-desk", phone: "blob-phone" });
    await recordRotation(env, "g1", 2, hex64(2), { desk: "blob-desk-2" });

    const behind = await worker.fetch(keysRequest("g1", hex64(1), "desk"), env);
    expect(behind.status).toBe(200);
    expect(await behind.json()).toEqual({
      epoch: 2,
      blob: "blob-desk-2",
      devices: ["desk"],
      removalStep: 2,
    });

    const removed = await worker.fetch(keysRequest("g1", hex64(1), "phone"), env);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      epoch: 2,
      blob: null,
      devices: ["desk"],
      removalStep: 2,
    });
  });

  it("answers a claimed-but-never-rotated group its own epoch and an empty manifest", async () => {
    // ⚠️ **This body is a removal notice apart from its epoch**, which is why the reader has to
    // compare epochs before it consults the manifest at all. Equal epochs mean nothing to do;
    // without that guard this is the answer that makes every device in a healthy group conclude
    // it has been removed and dissolve the group on its next sync.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 3, hex64(3));

    const response = await worker.fetch(keysRequest("g1", hex64(3), "desk"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ epoch: 3, blob: null, devices: [], removalStep: 2 });
  });

  it("accepts an auth seven rotations behind and refuses one eight behind", async () => {
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    for (let epoch = 1; epoch <= 9; epoch += 1) {
      const written = await recordRotation(env, "g1", epoch, hex64(epoch), {
        desk: `blob-${epoch}`,
      });
      expect(written).toBe(true);
    }

    // `EPOCH_HISTORY` is eight epochs kept — eight rows here, where every step is a join's one —
    // and the prune runs on every write, so at epoch 9 everything at `epoch <= 1` has gone and 2
    // through 9 remain. Epoch 2's auth is therefore
    // the oldest one that still opens this route and epoch 1's is the first that does not.
    // **Both boundaries are asserted and that is what lets this fail**: a window one epoch wider
    // keeps epoch 1's row, and only the refusal below would notice.
    const accepted = await worker.fetch(keysRequest("g1", hex64(2), "desk"), env);
    expect(accepted.status).toBe(200);
    // And it is answered the **newest** key rather than the epoch it presented, which is the
    // whole point of a device that is behind asking.
    expect(await accepted.json()).toEqual({
      epoch: 9,
      blob: "blob-9",
      devices: ["desk"],
      removalStep: 2,
    });

    expect((await worker.fetch(keysRequest("g1", hex64(1), "desk"), env)).status).toBe(401);
    expect((await worker.fetch(keysRequest("g1", hex64(0), "desk"), env)).status).toBe(401);
  });

  it("refuses a request that names no device, or one the router could not carry", async () => {
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    await recordRotation(env, "g1", 1, hex64(1), { desk: "blob-desk" });

    const status = async (query: string): Promise<number> => {
      const request = new Request(`https://relay.example/g/g1/keys${query}`, {
        headers: { authorization: `Bearer ${hex64(1)}` },
      });
      return (await worker.fetch(request, env)).status;
    };

    expect(await status("")).toBe(400);
    expect(await status("?device=")).toBe(400);
    expect(await status("?device=desk.two")).toBe(400);
    expect(await status("?device=desk")).toBe(200);
  });

  it("answers null for a device id that names a property of every object", async () => {
    // `constructor` is a device id as far as the character class is concerned, and the manifest
    // is an ordinary object. `keys[device] ?? null` finds `Object` there, `??` does not fire on
    // a function, and `JSON.stringify` then drops the field outright — so a device that is not
    // on the roster would be answered a body with **no `blob` at all**, which is a shape the
    // app's deserialiser refuses rather than the removal notice it is owed.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    await recordRotation(env, "g1", 1, hex64(1), { desk: "blob-desk" });

    const response = await worker.fetch(keysRequest("g1", hex64(1), "constructor"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      epoch: 1,
      blob: null,
      devices: ["desk"],
      removalStep: 2,
    });
  });

  it("refuses a group it holds no rows for rather than saying whether one exists", async () => {
    // **The plan predicted a 404 here and the answer is a 401**, because authentication comes
    // first and the credential is checked against the very rows a 404 would report the absence
    // of. The 404 branch in `handleKeys` is still the right answer to a group whose rows have
    // gone; it is simply not reachable from outside, which is the good direction for a route
    // not to be a directory of which group ids exist.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));

    expect((await worker.fetch(keysRequest("nope", hex64(0), "desk"), env)).status).toBe(401);
  });

  it("throws rather than telling a healthy group it was dissolved", async () => {
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    await recordRotation(env, "g1", 1, hex64(1), { desk: "blob-desk" });
    await env.DB.prepare(`UPDATE group_keys SET keys = ? WHERE group_id = ?`)
      .bind("{not json", "g1")
      .run();

    // An uncaught throw out of a fetch handler is a 500 in workerd and every device stalls where
    // it is, which is recoverable by fixing the row. Catching it into `{}` would be an empty
    // manifest at an epoch above every device's — positive evidence of removal that the whole
    // group would act on at once.
    await expect(worker.fetch(keysRequest("g1", hex64(1), "desk"), env)).rejects.toThrow(
      /manifest/,
    );
  });

  it("spans as few as four removals, because a removal spends two of its epochs", async () => {
    // ⚠️ **The cost of the join/removal marker, pinned where a device pays it.** The prune is
    // `epoch <= newest - 8`, so eight epochs are eight joins but four removals: a device dark
    // across three removals still reaches its catch-up key or its removal notice, and one dark
    // across four is refused with the auth it holds. Both sides of the edge are asked: a prune
    // that counted rows rather than epochs, or a window one epoch wider, keeps epoch 0's row at
    // epoch 8 and only the refusal notices; one two epochs narrower loses it at 6.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    for (const epoch of [2, 4, 6]) {
      expect(await recordRotation(env, "g1", epoch, hex64(epoch), { desk: `blob-${epoch}` })).toBe(
        true,
      );
    }
    const threeBehind = await worker.fetch(keysRequest("g1", hex64(0), "desk"), env);
    expect(threeBehind.status).toBe(200);
    expect(await threeBehind.json()).toEqual({
      epoch: 6,
      blob: "blob-6",
      devices: ["desk"],
      removalStep: 2,
    });

    expect(await recordRotation(env, "g1", 8, hex64(8), { desk: "blob-8" })).toBe(true);
    expect((await worker.fetch(keysRequest("g1", hex64(0), "desk"), env)).status).toBe(401);
    expect((await worker.fetch(keysRequest("g1", hex64(2), "desk"), env)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------
// GET /g/{group}/keys?epoch=
// ---------------------------------------------------------------------------------------

describe("GET /keys?epoch=", () => {
  /**
   * A group that went 0 → 1 → 2 by joins and then 2 → 4 by a removal: `phone` was added at 1 and
   * removed at 4, so every question worth asking has an epoch to ask it at — one with a row that
   * names the device, one with a row that does not, one a removal stepped over, and one ahead.
   */
  async function history(): Promise<Env & { reached: Reached[] }> {
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    await recordRotation(env, "g1", 1, hex64(1), { desk: "blob-desk-1", phone: "blob-phone-1" });
    await recordRotation(env, "g1", 2, hex64(2), { desk: "blob-desk-2", phone: "blob-phone-2" });
    await recordRotation(env, "g1", 4, hex64(4), { desk: "blob-desk-4" });
    return env;
  }

  it("answers the manifest stored at exactly the epoch it is asked for", async () => {
    // **The device that skipped an epoch**, which is the whole reason for the parameter: `desk`
    // stood on 1 and hears of 4 — and 2's key is the one it never held. Asked for 2 it is
    // answered 2, not the newest; the auth it presents is 1's, as a device that is behind holds.
    const env = await history();

    const skipped = await worker.fetch(keysRequest("g1", hex64(1), "desk", 2), env);
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toEqual({
      epoch: 2,
      blob: "blob-desk-2",
      devices: ["desk", "phone"],
      removalStep: 2,
    });

    // The claim row is a row like any other: epoch 0, and the empty manifest it was seeded with.
    const claimed = await worker.fetch(keysRequest("g1", hex64(4), "desk", 0), env);
    expect(await claimed.json()).toEqual({ epoch: 0, blob: null, devices: [], removalStep: 2 });
    expect(env.reached).toEqual([]);
  });

  it("answers null for a device the manifest at that epoch does not name", async () => {
    // The blob rule is the newest manifest's, epoch by epoch: `phone` held a key at 2 and holds
    // none at 4, and `constructor` — a device id the character class allows and every object
    // inherits — is answered `blob: null` rather than a body with no `blob` in it at all.
    const env = await history();

    const before = await worker.fetch(keysRequest("g1", hex64(2), "phone", 2), env);
    expect(await before.json()).toMatchObject({ blob: "blob-phone-2" });

    const after = await worker.fetch(keysRequest("g1", hex64(2), "phone", 4), env);
    expect(await after.json()).toEqual({
      epoch: 4,
      blob: null,
      devices: ["desk"],
      removalStep: 2,
    });

    const inherited = await worker.fetch(keysRequest("g1", hex64(2), "constructor", 1), env);
    expect(await inherited.json()).toEqual({
      epoch: 1,
      blob: null,
      devices: ["desk", "phone"],
      removalStep: 2,
    });
  });

  it("answers no_such_epoch for an epoch the group holds no row at", async () => {
    // **Three reasons, one answer.** 3 is the epoch the removal stepped over, which is the case a
    // device most often asks about and the one that tells it there is nothing to open; 9 has not
    // happened; and the answer is matched on `code`, so the code is what is pinned.
    const env = await history();

    for (const epoch of [3, 9]) {
      const missing = await worker.fetch(keysRequest("g1", hex64(4), "desk", epoch), env);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "no_such_epoch" });
    }

    // And one the prune has taken: eight epochs past 1 leaves nothing at 1, and the auth
    // presented is the newest so that what refuses is the missing row rather than the window.
    for (const epoch of [5, 7, 9]) {
      await recordRotation(env, "g1", epoch, hex64(epoch), { desk: `blob-desk-${epoch}` });
    }
    const pruned = await worker.fetch(keysRequest("g1", hex64(9), "desk", 1), env);
    expect(pruned.status).toBe(404);
    expect(await pruned.json()).toMatchObject({ code: "no_such_epoch" });
  });

  it("refuses text that is not an epoch rather than reading one out of it", async () => {
    // Every one of these is something `Number` would turn into an epoch — `""` into 0, `1e0` into
    // 1, a digit run past 2^53 into its neighbour — or a sign and a fraction the relay never
    // stores. Most of them land on a row this group holds, so a looser parse would answer 200.
    const env = await history();

    for (const epoch of ["", "-1", "1.0", "1e0", "0x1", "+1", " 1", "one", "9007199254740993"]) {
      const request = keysRequest("g1", hex64(4), "desk", encodeURIComponent(epoch));
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "that is not an epoch" });
    }
  });

  it("asks for the same recent auth the newest manifest does", async () => {
    // An old epoch's manifest is served on the same question as the newest one, not a weaker one:
    // a credential the group never held is refused, one aged out of the window is refused, and
    // a group with no rows is a 401 rather than a 404 either kind — so this is still not a
    // directory of which group ids exist.
    const env = await history();
    for (const epoch of [5, 7, 9]) {
      await recordRotation(env, "g1", epoch, hex64(epoch), { desk: `blob-desk-${epoch}` });
    }
    expect(await authIsRecent(env, "g1", hex64(1))).toBe(false);

    const status = async (request: Request): Promise<number> =>
      (await worker.fetch(request, env)).status;
    expect(await status(keysRequest("g1", hex64(0xdead), "desk", 2))).toBe(401);
    expect(await status(keysRequest("g1", hex64(1), "desk", 2))).toBe(401);
    expect(await status(keysRequest("nope", hex64(9), "desk", 2))).toBe(401);
    expect(await status(keysRequest("g1", hex64(2), "desk", 2))).toBe(200);
  });

  it("throws on an unreadable manifest at an old epoch, as at the newest", async () => {
    // `{}` at epoch 1 would be `blob: null` to every device that asked, and a device with no key
    // for an epoch steps over what was sealed under it for good. A 500 is a call made again.
    const env = await history();
    await env.DB.prepare(`UPDATE group_keys SET keys = ? WHERE group_id = ? AND epoch = ?`)
      .bind("{not json", "g1", 1)
      .run();

    await expect(worker.fetch(keysRequest("g1", hex64(4), "desk", 1), env)).rejects.toThrow(
      /manifest/,
    );
    // The newest manifest was not the corrupt one and still answers.
    expect((await worker.fetch(keysRequest("g1", hex64(4), "desk"), env)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------
// Where the two routes sit in the router
// ---------------------------------------------------------------------------------------

describe("the router", () => {
  it("leaves the log routes behind the bearer gate", async () => {
    // The two new routes stand ahead of the gate; `push`, `pull`, `ack` and `ws` did not come
    // with them. A group auth is not a minted token and must open none of them — those are the
    // ones that reach the Durable Object, which is the line that meters.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));

    const push = new Request("https://relay.example/g/g1/push", {
      method: "POST",
      headers: { authorization: `Bearer ${hex64(0)}` },
      body: "[]",
    });

    expect((await worker.fetch(push, env)).status).toBe(401);
  });

  it("answers 405 to the wrong method on either new route", async () => {
    const env = relayEnv("g1");

    const getOnRotate = await worker.fetch(new Request("https://relay.example/g/g1/rotate"), env);
    expect(getOnRotate.status).toBe(405);
    expect(getOnRotate.headers.get("allow")).toBe("POST");

    const postOnKeys = await worker.fetch(
      new Request("https://relay.example/g/g1/keys?device=desk", { method: "POST" }),
      env,
    );
    expect(postOnKeys.status).toBe(405);
    expect(postOnKeys.headers.get("allow")).toBe("GET");
  });
});
