import { describe, expect, it } from "vitest";
import { fakeEnv } from "./fakeD1";
import { authIsCurrent, currentManifest, recordRotation, seedGroup } from "./groupauth";
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
 * That makes this the one relay suite that drives a fetch handler, against `vite.config.ts`'s
 * note that the I/O here is left to a deploy. The exception is affordable for one reason: these
 * two routes touch D1 and nothing else, so `fakeD1`'s SQL evaluator is the whole of what they
 * need. Every route that reaches the Durable Object still needs workerd, and [`relayEnv`] makes
 * that a loud failure rather than a quiet one.
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
 * `fakeEnv` plus the two bindings the router itself reads.
 *
 * `RELAY_HMAC_KEY` is set even though these routes stand ahead of the gate that uses it,
 * **because the mutation this task is checked with needs it**: moving the two route lines below
 * the gate has to produce the gate's 401 rather than the 500 an unset binding gives, or the
 * mutation would be caught for the wrong reason.
 *
 * `GROUP` throws on so much as being read. Neither route may reach the Durable Object — that is
 * the metered line, and putting a group's key distribution on it would undo the reason the gate
 * stands where it does — so an implementation that routed one through the object fails here by
 * name rather than as an `undefined is not an object` three frames down.
 */
function relayEnv(...groups: string[]): Env {
  return {
    ...fakeEnv(...groups),
    RELAY_HMAC_KEY: "test-signing-key",
    get GROUP(): never {
      throw new Error("/rotate and /keys must never reach the Durable Object");
    },
  };
}

function rotateRequest(group: string, credential: string, body: unknown): Request {
  return new Request(`https://relay.example/g/${group}/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify(body),
  });
}

function keysRequest(group: string, credential: string, device: string): Request {
  return new Request(`https://relay.example/g/${group}/keys?device=${device}`, {
    headers: { authorization: `Bearer ${credential}` },
  });
}

/** A manifest of `devices` devices, each holding a blob of `blobChars` characters. */
function manifestOf(devices: number, blobChars = 8): Record<string, string> {
  const keys: Record<string, string> = {};
  for (let i = 0; i < devices; i += 1) keys[`d${i}`] = "b".repeat(blobChars);
  return keys;
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

  it("accepts a rotation signed with the entitlement's refresh secret", async () => {
    // The device that connected Patreon holds the secret and the group key alike; this is the
    // door it uses. `fakeEnv` seeds a placeholder secret rather than a real one, so the fixture
    // is put into the shape `randomSecret` actually writes instead of the route's credential
    // check being loosened to accept a placeholder.
    const env = relayEnv("g1");
    await seedGroup(env, "g1", 0, hex64(0));
    const secret = hex64(0xbeef);
    await env.DB.prepare(`UPDATE entitlements SET refresh_secret = ? WHERE group_id = ?`)
      .bind(secret, "g1")
      .run();

    const response = await worker.fetch(
      rotateRequest("g1", secret, { epoch: 1, auth: hex64(1), keys: { desk: "blob-desk" } }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 1, keys: { desk: "blob-desk" } });
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

    expect(await status(manifestOf(64))).toBe(200);
    expect(await status(manifestOf(65))).toBe(400);
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
    expect(await response.json()).toEqual({
      epoch: 1,
      blob: "blob-desk",
      devices: ["desk", "phone"],
    });
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
    expect(await behind.json()).toEqual({ epoch: 2, blob: "blob-desk-2", devices: ["desk"] });

    const removed = await worker.fetch(keysRequest("g1", hex64(1), "phone"), env);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ epoch: 2, blob: null, devices: ["desk"] });
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
    expect(await response.json()).toEqual({ epoch: 3, blob: null, devices: [] });
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

    // `EPOCH_HISTORY` is eight rows kept and the prune runs on every write, so at epoch 9
    // everything at `epoch <= 1` has gone and 2 through 9 remain. Epoch 2's auth is therefore
    // the oldest one that still opens this route and epoch 1's is the first that does not.
    // **Both boundaries are asserted and that is what lets this fail**: a window one epoch wider
    // keeps epoch 1's row, and only the refusal below would notice.
    const accepted = await worker.fetch(keysRequest("g1", hex64(2), "desk"), env);
    expect(accepted.status).toBe(200);
    // And it is answered the **newest** key rather than the epoch it presented, which is the
    // whole point of a device that is behind asking.
    expect(await accepted.json()).toEqual({ epoch: 9, blob: "blob-9", devices: ["desk"] });

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
    expect(await response.json()).toEqual({ epoch: 1, blob: null, devices: ["desk"] });
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
