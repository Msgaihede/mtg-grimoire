import { describe, expect, it } from "vitest";
import {
  admit,
  admitBody,
  admitToLog,
  isEnvelope,
  MAX_PUSH_BODY_CHARS,
  type Refusal,
} from "./admit";
import { fakeEnvOver, fakeTables, type Tables } from "./fakeD1";
import worker, { type Env } from "./index";
import { MAX_CLOCK_AHEAD_MS, MAX_GROUP_LOG_CHARS, MAX_SEALED_CHARS } from "./log";
import { mint, TOKEN_TTL_MS } from "./token";

const NOW = 1_700_000_000_000;

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
    const worst = JSON.stringify({
      group: "g".repeat(128),
      device: "d".repeat(128),
      epoch: Number.MAX_SAFE_INTEGER,
      hlcMs: Number.MAX_SAFE_INTEGER,
      hlcCtr: Number.MAX_SAFE_INTEGER,
      sealed: "s".repeat(MAX_SEALED_CHARS + 1),
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

async function push(env: Env, body: string): Promise<Response> {
  const token = await mint({ sub: "sub-0", grp: "g1", exp: Date.now() + TOKEN_TTL_MS }, KEY);
  return worker.fetch(
    new Request("https://relay.example/g/g1/push", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
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
