import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admit,
  admitBody,
  admitRestricted,
  admitRestrictedBody,
  admitToLog,
  bindDevice,
  DEVICE_BINDING,
  DEVICE_MISMATCH,
  deviceMismatch,
  isEnvelope,
  isSig,
  MAX_PUSH_BODY_CHARS,
  quotaDay,
  RESTRICTED_PUSH_BYTES,
  RESTRICTED_PUSHES_PER_DAY,
  SIG_CHARS,
  type Refusal,
} from "./admit";
import { fakeEnvOver, fakeTables, type Tables } from "./fakeD1";
import worker, { type Env } from "./index";
import { MAX_CLOCK_AHEAD_MS, MAX_GROUP_LOG_CHARS, MAX_SEALED_CHARS } from "./log";
import { mint, TOKEN_TTL_MS } from "./token";

const NOW = 1_700_000_000_000;

/**
 * A well-formed `sig`: 86 characters of base64url, every one of its 64 letters among them —
 * the shape a 64-byte Ed25519 signature takes unpadded. Not a signature of anything, which the
 * relay cannot tell: it verifies none.
 */
const SIG = (
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" + "Q".repeat(22)
).slice(0, SIG_CHARS);

/** An envelope that passes every check at epoch 3 and `NOW`, for a test to break one field of. */
function envelope(over: Partial<Record<string, unknown>> = {}) {
  return {
    group: "g1",
    device: "desk",
    epoch: 3,
    hlcMs: NOW,
    hlcCtr: 0,
    sealed: "sealed",
    ...over,
  };
}

/** The code a refusal carries, or `null` for an admission — the part a client matches on. */
function code(refusal: Refusal | null): string | null {
  return refusal === null ? null : refusal.code;
}

describe("admitBody", () => {
  it("reads a body exactly at the cap and refuses one character past it", () => {
    expect(admitBody(MAX_PUSH_BODY_CHARS)).toBeNull();
    expect(admitBody(MAX_PUSH_BODY_CHARS + 1)).toEqual(
      expect.objectContaining({ status: 413, code: "too_large" }),
    );
  });

  it("decides nothing from a Content-Length that is absent or not a number", () => {
    // `Number(null)` is 0 and `Number("junk")` is NaN; neither may refuse an honest push.
    expect(admitBody(Number(null))).toBeNull();
    expect(admitBody(Number("junk"))).toBeNull();
  });

  it("leaves room for the largest honest envelope, so the sealed cap is the one it meets", () => {
    // Every field at the most the route or the app allows: a 128-character group, a device id
    // four times the app's 32, and three numbers as long as a float can print an integer.
    // And a signature, which is one length whatever it signs.
    const worst = JSON.stringify({
      group: "g".repeat(128),
      device: "d".repeat(128),
      epoch: Number.MAX_SAFE_INTEGER,
      hlcMs: Number.MAX_SAFE_INTEGER,
      hlcCtr: Number.MAX_SAFE_INTEGER,
      sealed: "s".repeat(MAX_SEALED_CHARS + 1),
      sig: SIG,
    });

    expect(worst.length).toBeLessThanOrEqual(MAX_PUSH_BODY_CHARS);
  });
});

describe("isEnvelope", () => {
  it("takes the six fields with the three numbers finite", () => {
    expect(isEnvelope(envelope())).toBe(true);
  });

  it("refuses a missing field, a string for a number, and a number that is not finite", () => {
    for (const bad of [
      null,
      "envelope",
      envelope({ sealed: undefined }),
      envelope({ device: 7 }),
      envelope({ epoch: "3" }),
      envelope({ hlcMs: Number.POSITIVE_INFINITY }),
      envelope({ hlcCtr: Number.NaN }),
    ]) {
      expect(isEnvelope(bad)).toBe(false);
    }
  });

  it("takes an envelope with no sig exactly as before, and one with a well-formed sig", () => {
    // Every envelope a released build has pushed has no `sig` key at all.
    expect("sig" in envelope()).toBe(false);
    expect(isEnvelope(envelope())).toBe(true);
    expect(SIG).toHaveLength(86);
    expect(isEnvelope(envelope({ sig: SIG }))).toBe(true);
    // Absent and `undefined` are one thing: a parsed body cannot hold an `undefined`.
    expect(isEnvelope(envelope({ sig: undefined }))).toBe(true);
  });

  it("refuses a sig that is present and not 86 characters of unpadded base64url", () => {
    for (const [why, sig] of [
      ["null is present", null],
      ["a number", 7],
      ["an object", { sig: SIG }],
      ["empty", ""],
      ["one short", SIG.slice(1)],
      ["one long", SIG + "A"],
      ["padded, as base64 spells 64 bytes", SIG + "=="],
      ["one padding character in the place of a letter", SIG.slice(1) + "="],
      ["base64's + rather than base64url's -", "+" + SIG.slice(1)],
      ["base64's / rather than base64url's _", "/" + SIG.slice(1)],
      ["a space", " " + SIG.slice(1)],
      ["a trailing newline", SIG.slice(1) + "\n"],
      ["hex is the right alphabet at the wrong length", "ab".repeat(64)],
    ] as const) {
      expect(isEnvelope(envelope({ sig })), why).toBe(false);
      expect(isSig(sig), why).toBe(false);
    }
  });
});

describe("deviceMismatch and bindDevice", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is no mismatch for a token that names the device, or names none", () => {
    expect(deviceMismatch({ dev: "desk" }, "desk")).toBeNull();
    expect(deviceMismatch({}, "desk")).toBeNull();
    expect(deviceMismatch({}, "")).toBeNull();
  });

  it("is a 403 device_mismatch for a token that names another device", () => {
    expect(deviceMismatch({ dev: "desk" }, "phone")).toEqual({
      status: 403,
      code: "device_mismatch",
      error: expect.any(String) as string,
    });
    expect(DEVICE_MISMATCH).toBe("device_mismatch");
  });

  it("only warns by default — every group not signed: logged as fixed text, nothing refused", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(DEVICE_BINDING).toBe("warn");
    expect(bindDevice("push", { dev: "desk" }, "phone")).toBeNull();
    expect(bindDevice("ack", { dev: "desk" }, "phone")).toBeNull();

    // The code and the route, and not one thing the request carried.
    expect(warned.mock.calls).toEqual([["device_mismatch on push"], ["device_mismatch on ack"]]);
  });

  it("says nothing for a match or a token with no device", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(bindDevice("push", { dev: "desk" }, "desk")).toBeNull();
    expect(bindDevice("ack", {}, "anyone")).toBeNull();

    expect(warned).not.toHaveBeenCalled();
  });

  it("answers the 403 when the mode is refuse — a signed group's (`index.ts`'s `bound`)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(code(bindDevice("push", { dev: "desk" }, "phone", "refuse"))).toBe("device_mismatch");
    expect(bindDevice("ack", { dev: "desk" }, "phone", "refuse")?.status).toBe(403);
    // A token that names no device is still no mismatch, in either mode.
    expect(bindDevice("ack", {}, "phone", "refuse")).toBeNull();
  });
});

describe("admit", () => {
  it("admits a sealed exactly at the cap and refuses one character past it", () => {
    expect(admit(envelope({ sealed: "s".repeat(MAX_SEALED_CHARS) }), 3, NOW)).toBeNull();
    expect(admit(envelope({ sealed: "s".repeat(MAX_SEALED_CHARS + 1) }), 3, NOW)).toEqual(
      expect.objectContaining({ status: 413, code: "too_large" }),
    );
  });

  it("admits the group's own epoch, and refuses one behind as stale and one ahead as ahead", () => {
    expect(admit(envelope({ epoch: 3 }), 3, NOW)).toBeNull();
    expect(admit(envelope({ epoch: 2 }), 3, NOW)).toEqual(
      expect.objectContaining({ status: 409, code: "stale_epoch" }),
    );
    expect(admit(envelope({ epoch: 4 }), 3, NOW)).toEqual(
      expect.objectContaining({ status: 422, code: "epoch_ahead" }),
    );
  });

  it("refuses the envelope that froze every peer's cursor", () => {
    expect(code(admit(envelope({ epoch: 1e12 }), 3, NOW))).toBe("epoch_ahead");
  });

  it("skips the epoch check, and only that one, for a group with no recorded epoch", () => {
    expect(admit(envelope({ epoch: 1e12 }), null, NOW)).toBeNull();
    expect(admit(envelope({ epoch: -5 }), null, NOW)).toBeNull();
    // The other checks still stand without an epoch to compare against.
    expect(code(admit(envelope({ hlcMs: NOW + MAX_CLOCK_AHEAD_MS + 1 }), null, NOW))).toBe(
      "clock_ahead",
    );
  });

  it("admits a stamp exactly a day ahead and refuses one a millisecond further", () => {
    expect(admit(envelope({ hlcMs: NOW + MAX_CLOCK_AHEAD_MS }), 3, NOW)).toBeNull();
    expect(admit(envelope({ hlcMs: NOW + MAX_CLOCK_AHEAD_MS + 1 }), 3, NOW)).toEqual(
      expect.objectContaining({ status: 422, code: "clock_ahead" }),
    );
    // Behind is not policed: a slow clock loses its own edits' comparisons and nobody else's.
    expect(admit(envelope({ hlcMs: 0 }), 3, NOW)).toBeNull();
  });

  it("answers the first refusal in the order size, epoch, clock", () => {
    const huge = "s".repeat(MAX_SEALED_CHARS + 1);
    const future = NOW + 2 * MAX_CLOCK_AHEAD_MS;

    expect(code(admit(envelope({ sealed: huge, epoch: 2, hlcMs: future }), 3, NOW))).toBe(
      "too_large",
    );
    expect(code(admit(envelope({ epoch: 2, hlcMs: future }), 3, NOW))).toBe("stale_epoch");
    expect(code(admit(envelope({ epoch: 4, hlcMs: future }), 3, NOW))).toBe("epoch_ahead");
  });
});

describe("admitRestricted", () => {
  it("stores a restricted device's 64th push of the day and refuses its 65th", () => {
    expect(RESTRICTED_PUSHES_PER_DAY).toBe(64);
    expect(admitRestricted(0)).toBeNull();
    expect(admitRestricted(RESTRICTED_PUSHES_PER_DAY - 1)).toBeNull();
    expect(admitRestricted(RESTRICTED_PUSHES_PER_DAY)).toEqual({
      status: 429,
      code: "restricted_quota",
      error: expect.any(String) as string,
    });
  });

  it("counts by UTC day", () => {
    expect(quotaDay(Date.UTC(2026, 9, 17, 23, 59, 59, 999))).toBe(
      quotaDay(Date.UTC(2026, 9, 17, 0, 0)),
    );
    expect(quotaDay(Date.UTC(2026, 9, 18))).toBe(quotaDay(Date.UTC(2026, 9, 17)) + 1);
  });
});

describe("admitRestrictedBody", () => {
  it("admits a restricted device's push of exactly 64 KiB and refuses one byte more", () => {
    expect(RESTRICTED_PUSH_BYTES).toBe(65_536);
    expect(admitRestrictedBody(0)).toBeNull();
    expect(admitRestrictedBody(RESTRICTED_PUSH_BYTES)).toBeNull();
    expect(admitRestrictedBody(RESTRICTED_PUSH_BYTES + 1)).toEqual({
      status: 413,
      code: "restricted_too_large",
      error: expect.any(String) as string,
    });
  });

  it("decides nothing on a Content-Length that is not a number", () => {
    expect(admitRestrictedBody(Number("not a length"))).toBeNull();
  });

  it("is far inside the general cap, and far above what 25 allow-listed adds seal to", () => {
    expect(RESTRICTED_PUSH_BYTES).toBeLessThan(MAX_PUSH_BODY_CHARS);
    // `MAX_SEALED_CHARS`' measured batch: 200 fully populated `collection_entries` ops sealed to
    // 186 188 characters. 25 of them (`ADD_OPS_PER_ENVELOPE`), plus the envelope's other fields
    // and a signature, is the worst an honest bot sends — and an allow-listed add is smaller.
    const honestWorst = Math.ceil((186_188 / 200) * 25) + 400;
    expect(honestWorst * 2).toBeLessThan(RESTRICTED_PUSH_BYTES);
  });
});

describe("admitToLog", () => {
  it("stores a push that brings the log exactly to the cap and refuses one character past it", () => {
    expect(admitToLog(MAX_GROUP_LOG_CHARS - 10, 10)).toBeNull();
    expect(admitToLog(MAX_GROUP_LOG_CHARS - 10, 11)).toEqual(
      expect.objectContaining({ status: 507, code: "quota" }),
    );
  });

  it("stores the largest push there is into an empty log", () => {
    expect(admitToLog(0, MAX_SEALED_CHARS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// The gate's placement, through the router
// ---------------------------------------------------------------------------------------

/**
 * **Driven through `worker.fetch`, because where these refusals stand is half of what they are.**
 * Every one of them could be made inside the Durable Object and every pure test above would still
 * pass — and each would then cost the object request the gate exists to save. So the object here
 * is a recorder: a refusal must leave it empty, and an admission must hand it the push's own text.
 *
 * The bearer gate is real, and so is the epoch's D1 read: `fakeD1` evaluates the `SELECT`, so a
 * group with a key row is refused against its newest epoch and one with none is not.
 */
const KEY = "test-signing-key";

interface Relay {
  env: Env;
  tables: Tables;
  reached: Request[];
}

function relay(): Relay {
  const tables = fakeTables({ groups: ["g1"] });
  const reached: Request[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (forwarded: Request) => {
        reached.push(forwarded);
        return Promise.resolve(new Response(JSON.stringify({ cursor: 1 })));
      },
    }),
  };
  const env = {
    ...fakeEnvOver(tables),
    RELAY_HMAC_KEY: KEY,
    GROUP: namespace as unknown as DurableObjectNamespace,
  } as Env;
  return { env, tables, reached };
}

/** A token for `g1`, naming `dev` when one is given — as every token since issue #548 does. */
function bearer(dev?: string): Promise<string> {
  const claims = { sub: "sub-0", grp: "g1", exp: Date.now() + TOKEN_TTL_MS };
  return mint(dev === undefined ? claims : { ...claims, dev }, KEY);
}

async function push(env: Env, body: string, dev?: string): Promise<Response> {
  return worker.fetch(
    new Request("https://relay.example/g/g1/push", {
      method: "POST",
      headers: { authorization: `Bearer ${await bearer(dev)}` },
      body,
    }),
    env,
  );
}

async function ack(env: Env, body: string, dev?: string): Promise<Response> {
  return worker.fetch(
    new Request("https://relay.example/g/g1/ack", {
      method: "POST",
      headers: { authorization: `Bearer ${await bearer(dev)}` },
      body,
    }),
    env,
  );
}

/** A `group_keys` row for `g1` at `epoch` — what `/rotate` and a claim's seed write. */
function keyRow(tables: Tables, epoch: number): void {
  tables.group_keys.push({
    group_id: "g1",
    epoch,
    auth: "a".repeat(64),
    keys: "{}",
    created_at: 0,
  });
}

/** A push stamped by the real clock, since the router reads `Date.now()` itself. */
function live(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify(envelope({ hlcMs: Date.now(), ...over }));
}

describe("POST /push, at the Worker", () => {
  it("forwards an admitted push to its object with the same text it was sent", async () => {
    const { env, reached } = relay();
    const body = live();

    const response = await push(env, body);

    expect(response.status).toBe(200);
    expect(reached).toHaveLength(1);
    expect(new URL(reached[0].url).pathname).toBe("/g/g1/push");
    expect(reached[0].method).toBe("POST");
    expect(await reached[0].text()).toBe(body);
  });

  it("refuses an epoch behind or ahead of the group's without reaching the object", async () => {
    const { env, tables, reached } = relay();
    keyRow(tables, 3);

    const behind = await push(env, live({ epoch: 2 }));
    const ahead = await push(env, live({ epoch: 4 }));

    expect(behind.status).toBe(409);
    expect(await behind.json()).toEqual(expect.objectContaining({ code: "stale_epoch" }));
    expect(ahead.status).toBe(422);
    expect(await ahead.json()).toEqual(expect.objectContaining({ code: "epoch_ahead" }));
    expect(reached).toHaveLength(0);

    expect((await push(env, live({ epoch: 3 }))).status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  it("reads the group's key rows, not the entitlement's mirror of them", async () => {
    // The mirror follows `recordRotation`'s insert in a second statement. One that failed to
    // follow must not refuse every push at the epoch the group has really moved to.
    const { env, tables, reached } = relay();
    keyRow(tables, 2);
    keyRow(tables, 3);
    tables.entitlements[0].group_epoch = 2;

    expect((await push(env, live({ epoch: 3 }))).status).toBe(200);
    expect((await push(env, live({ epoch: 2 }))).status).toBe(409);
    expect(reached).toHaveLength(1);
  });

  it("forwards any epoch for a group with no key rows at all", async () => {
    const { env, reached } = relay();

    expect((await push(env, live({ epoch: 1e12 }))).status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  it("refuses a body past the cap before trying to parse it", async () => {
    // Not JSON at all: a gate that parsed first would answer 400 here, not 413.
    const { env, reached } = relay();

    const response = await push(env, "x".repeat(MAX_PUSH_BODY_CHARS + 1));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(expect.objectContaining({ code: "too_large" }));
    expect(reached).toHaveLength(0);
  });

  it("refuses a sealed past its cap, a clock a day ahead, and a malformed envelope", async () => {
    const { env, reached } = relay();

    const huge = await push(env, live({ sealed: "s".repeat(MAX_SEALED_CHARS + 1) }));
    const future = await push(env, live({ hlcMs: Date.now() + 2 * MAX_CLOCK_AHEAD_MS }));
    const malformed = await push(env, live({ sealed: 7 }));

    expect([huge.status, future.status, malformed.status]).toEqual([413, 422, 400]);
    expect(await future.json()).toEqual(expect.objectContaining({ code: "clock_ahead" }));
    // The 400 carries no code, in the words the object has always used.
    expect(await malformed.json()).toEqual({ error: "malformed envelope" });
    expect(reached).toHaveLength(0);
  });
});

describe("POST /push, signed", () => {
  it("forwards a push with a well-formed sig, its text untouched", async () => {
    const { env, reached } = relay();
    const body = live({ sig: SIG });

    expect((await push(env, body)).status).toBe(200);
    expect(reached).toHaveLength(1);
    expect(await reached[0].text()).toBe(body);
  });

  it("refuses a malformed sig as a malformed envelope, without reaching the object", async () => {
    const { env, reached } = relay();

    for (const sig of [null, 7, SIG + "==", SIG.slice(1)]) {
      const response = await push(env, live({ sig }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "malformed envelope" });
    }
    expect(reached).toHaveLength(0);
  });
});

/**
 * **The token's device against the body's, recorded and never refused in a group that is not
 * signed** (`DEVICE_BINDING`) — every group here, which has no roster document; a signed group's
 * refusal is `roster.test.ts`'s. What is held here is the placement and the pass-through: a mismatch is one
 * fixed line in the log and the request reaches its object as it would have; a match and a token
 * with no `dev` say nothing at all.
 */
describe("the token's device, on a push and an ack", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records a push stamped as another device, and still forwards it", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, reached } = relay();
    const body = live({ device: "phone" });

    const response = await push(env, body, "desk");

    expect(response.status).toBe(200);
    expect(reached).toHaveLength(1);
    expect(await reached[0].text()).toBe(body);
    expect(warned.mock.calls).toEqual([["device_mismatch on push"]]);
  });

  it("says nothing of a push whose device is the token's, or a token that names none", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, reached } = relay();

    expect((await push(env, live({ device: "desk" }), "desk")).status).toBe(200);
    expect((await push(env, live({ device: "phone" }))).status).toBe(200);

    expect(reached).toHaveLength(2);
    expect(warned).not.toHaveBeenCalled();
  });

  it("does not let a mismatch stand in front of a refusal: a stale push is still a 409", async () => {
    // Recorded, then admitted or refused exactly as an unbound push would be.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, tables, reached } = relay();
    keyRow(tables, 3);

    const response = await push(env, live({ device: "phone", epoch: 2 }), "desk");

    expect(response.status).toBe(409);
    expect(reached).toHaveLength(0);
    expect(warned).toHaveBeenCalledTimes(1);
  });

  it("records an ack as another device, and still forwards it with its body", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, reached } = relay();
    const body = '{"device":"phone","cursor":7}';

    await ack(env, body, "desk");

    expect(reached).toHaveLength(1);
    expect(new URL(reached[0].url).pathname).toBe("/g/g1/ack");
    expect(reached[0].method).toBe("POST");
    expect(await reached[0].text()).toBe(body);
    expect(warned.mock.calls).toEqual([["device_mismatch on ack"]]);
  });

  it("says nothing of an ack as the token's own device", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, reached } = relay();
    const body = '{"device":"desk","cursor":7}';

    await ack(env, body, "desk");

    expect(await reached[0].text()).toBe(body);
    expect(warned).not.toHaveBeenCalled();
  });

  it("forwards an ack under a token with no device as the very request, unread", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, reached } = relay();
    const request = new Request("https://relay.example/g/g1/ack", {
      method: "POST",
      headers: { authorization: `Bearer ${await bearer()}` },
      body: '{"device":"phone","cursor":7}',
    });

    await worker.fetch(request, env);

    expect(reached).toEqual([request]);
    expect(request.bodyUsed).toBe(false);
    expect(warned).not.toHaveBeenCalled();
  });

  it("forwards an ack it cannot read for the object to refuse, in its own words", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, reached } = relay();

    for (const body of ["not json", "null", '{"cursor":1}', '{"device":7,"cursor":1}']) {
      await ack(env, body, "desk");
    }

    expect(await Promise.all(reached.map((each) => each.text()))).toEqual([
      "not json",
      "null",
      '{"cursor":1}',
      '{"device":7,"cursor":1}',
    ]);
    expect(warned).not.toHaveBeenCalled();
  });
});
