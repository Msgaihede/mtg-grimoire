import { afterEach, describe, expect, it, vi } from "vitest";
import { RESTRICTED_PUSH_BYTES } from "./admit";
import { GROUP_SEGMENT } from "./claim";
import { fakeEnv } from "./fakeD1";
import { recordRotation, seedGroup } from "./groupauth";
import worker, { type Env } from "./index";
import {
  authenticatorOf,
  capOf,
  isBase64Url,
  MAX_ROSTER_CHARS,
  MEMBER_ID,
  parseRoster,
  ROSTER_DOMAIN,
  ROSTER_PAGE,
  rosterHash,
  signedBytes,
  verifyRosterSig,
} from "./roster";
import { mint, TOKEN_TTL_MS, verify } from "./token";
import goldenText from "../../../crates/grimoire-core/src/__golden__/roster-v1.json?raw";

/**
 * The signed roster document (spec §12) — its shape, its chain, and the two routes that store one
 * — driven through `worker.fetch` for `rotate.test.ts`'s reason: where `/roster` stands relative to
 * the bearer gate, and that it never reaches the Durable Object, is half of what it is.
 *
 * **The signatures are real Ed25519**, made here with WebCrypto's own `generateKey`, so a judge
 * that compared the wrong bytes, the wrong key or no signature at all fails here rather than in a
 * client. **And the engine's own bytes are read too**: `crates/grimoire-core/src/__golden__/
 * roster-v1.json` pins an open RD and the signed one after it, with the hash, the MAC key, the
 * MAC, the signing seed and the signature `sync_pair::roster` produces — the last describe below
 * holds this file's hashing, signing bytes and verification to them, and drives the two documents
 * through both routes, so the two suites go red together when either side changes a byte.
 */

function hex64(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 bytes of `n`, as a key-shaped string: an X25519 key the relay never opens anything with. */
const key32 = (n: number) => b64url(new Uint8Array(32).fill(n));

interface Signer {
  device: string;
  ed25519: string;
  sign: (text: string) => Promise<string>;
}

/** A device with a real Ed25519 key pair, and a function that signs an RD as §12 says. */
async function signer(device: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return {
    device,
    ed25519: b64url(raw),
    sign: async (text) =>
      b64url(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, signedBytes(text))),
  };
}

function member(who: Signer | string, cap = "full", since = 0) {
  const device = typeof who === "string" ? who : who.device;
  const ed25519 = typeof who === "string" ? key32(9) : who.ed25519;
  return { device, x25519: key32(1), ed25519, cap, proto: 1, since };
}

/** An RD string, in the field order §12 writes it, for a test to override one field of. */
function rd(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    group: "g1",
    epoch: 0,
    step: 0,
    prev: null,
    mode: "open",
    signer: "desk",
    members: [member("desk")],
    ...over,
  });
}

/** A well-formed MAC — the relay cannot check one, so any 32 bytes stand in. */
const MAC = key32(7);

function relayEnv(): Env & { reached: string[] } {
  const reached: string[] = [];
  return {
    ...fakeEnv("g1"),
    RELAY_HMAC_KEY: "test-signing-key",
    GROUP: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (url: string | Request) => {
          reached.push(new URL(typeof url === "string" ? url : url.url).pathname);
          return Promise.resolve(new Response(JSON.stringify({ cursor: 1 })));
        },
      }),
    } as unknown as DurableObjectNamespace,
    reached,
  };
}

function post(path: string, credential: string, body: unknown): Request {
  return new Request(`https://relay.example/g/g1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify(body),
  });
}

const amend = (credential: string, body: unknown) => post("roster", credential, body);
const rotate = (credential: string, body: unknown) => post("rotate", credential, body);

async function keys(env: Env, credential: string, query = "") {
  const response = await worker.fetch(
    new Request(`https://relay.example/g/g1/keys?device=desk${query}`, {
      headers: { authorization: `Bearer ${credential}` },
    }),
    env,
  );
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function stored(env: Env): Promise<{ epoch: number; step: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT epoch, step FROM rosters WHERE group_id = ? ORDER BY epoch, step`,
  )
    .bind("g1")
    .all<{ epoch: number; step: number }>();
  return results;
}

async function code(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

// ---------------------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------------------

describe("parseRoster", () => {
  it("reads §12's document, and ignores a field it does not know", () => {
    const parsed = parseRoster(rd({ later: { anything: true } }), "g1");
    expect(parsed).toEqual({
      ok: true,
      roster: {
        v: 1,
        group: "g1",
        epoch: 0,
        step: 0,
        prev: null,
        mode: "open",
        signer: "desk",
        members: [member("desk")],
      },
    });
  });

  it("ignores a member's unknown field too, and hands back only the fields it checked", () => {
    const parsed = parseRoster(rd({ members: [{ ...member("desk"), nickname: "x" }] }), "g1");
    expect(parsed.ok && parsed.roster.members[0]).toEqual(member("desk"));
  });

  it("refuses every field it knows in a shape §12 does not write", () => {
    const cases: [string, string][] = [
      ["v 2", rd({ v: 2 })],
      ["another group", rd({ group: "g2" })],
      ["a negative epoch", rd({ epoch: -1 })],
      ["a fractional step", rd({ step: 0.5 })],
      ["a string epoch", rd({ epoch: "0" })],
      ["a prev that is not 64 hex", rd({ prev: "ab" })],
      ["an upper-case prev", rd({ prev: "A".repeat(64) })],
      ["an unknown mode", rd({ mode: "closed" })],
      ["a signer the router could not carry", rd({ signer: "a/b" })],
      ["members not a list", rd({ members: {} })],
      ["six members", rd({ members: ["a", "b", "c", "d", "e", "f"].map((d) => member(d)) })],
      ["a member twice", rd({ members: [member("desk"), member("desk")] })],
      ["a short key", rd({ members: [{ ...member("desk"), ed25519: key32(1).slice(1) }] })],
      ["a padded key", rd({ members: [{ ...member("desk"), x25519: `${key32(1)}=` }] })],
      ["an upper-case cap", rd({ members: [member("desk", "FULL")] })],
      ["no proto", rd({ members: [{ ...member("desk"), proto: undefined }] })],
      ["a negative since", rd({ members: [member("desk", "full", -1)] })],
    ];
    for (const [why, text] of cases) expect(parseRoster(text, "g1").ok, why).toBe(false);
    for (const odd of [7, null, "", "not json", "[]", "null"]) {
      expect(parseRoster(odd, "g1").ok, String(odd)).toBe(false);
    }
  });

  it("refuses an open document that names a restricted member", () => {
    // The relay's own rule: open mode is accepted under a MAC any key holder can compute, so a
    // restricted member of an open group could promote itself. A cap is signed or it is not there.
    expect(parseRoster(rd({ members: [member("desk"), member("bot", "read")] }), "g1").ok).toBe(
      false,
    );
    expect(
      parseRoster(rd({ mode: "signed", members: [member("desk"), member("bot", "read")] }), "g1")
        .ok,
    ).toBe(true);
  });

  it("takes a document of no members — the last device out's", () => {
    expect(parseRoster(rd({ members: [] }), "g1").ok).toBe(true);
  });

  it("refuses a document past its cap, whatever it carries", () => {
    const padded = rd({ pad: "x".repeat(MAX_ROSTER_CHARS) });
    expect(parseRoster(padded, "g1").ok).toBe(false);
  });

  it("spells a member's id as claim.ts spells a group's", () => {
    // Spelled out in `roster.ts` because `claim.ts` imports it; held to one pattern here.
    expect(MEMBER_ID.source).toBe(`^${GROUP_SEGMENT}$`);
  });
});

describe("isBase64Url", () => {
  it("takes the one canonical spelling of n bytes, and no other", () => {
    const k = key32(255);
    expect(isBase64Url(k, 32)).toBe(true);
    // 43 characters carry 258 bits: the last character's spare bits must be zero.
    expect(k.endsWith("8")).toBe(true);
    expect(isBase64Url(`${k.slice(0, -1)}9`, 32)).toBe(false);
    expect(isBase64Url(k, 64)).toBe(false);
    expect(isBase64Url(`${k}=`, 32)).toBe(false);
    expect(isBase64Url(k.replace(/_/g, "/"), 32)).toBe(k.includes("_") ? false : true);
    expect(isBase64Url(7, 32)).toBe(false);
  });
});

describe("authenticatorOf", () => {
  it("takes exactly one of a 43-character MAC and an 86-character signature", async () => {
    const desk = await signer("desk");
    const sig = await desk.sign("x");
    expect(sig).toHaveLength(86);
    expect(authenticatorOf({ rosterMac: MAC })).toEqual({ mac: MAC, sig: null });
    expect(authenticatorOf({ rosterSig: sig })).toEqual({ mac: null, sig });
    // `null` is absent here: these fields are read once and never stored as sent.
    expect(authenticatorOf({ rosterMac: MAC, rosterSig: null })).toEqual({ mac: MAC, sig: null });
  });

  it("refuses both, neither, and either in the wrong shape", async () => {
    const sig = await (await signer("desk")).sign("x");
    for (const body of [
      {},
      { rosterMac: null, rosterSig: null },
      { rosterMac: MAC, rosterSig: sig },
      { rosterMac: sig },
      { rosterSig: MAC },
      { rosterMac: 7 },
      { rosterSig: `${sig}==` },
    ]) {
      expect(typeof authenticatorOf(body), JSON.stringify(body)).toBe("string");
    }
  });
});

describe("the bytes an authenticator covers", () => {
  it("are the domain tag, one zero byte, and the document's UTF-8, as §12 spells them", () => {
    expect(ROSTER_DOMAIN).toBe("mtg-grimoire/roster/v1");
    const bytes = signedBytes("{é}");
    expect([...bytes]).toEqual([
      ...new TextEncoder().encode("mtg-grimoire/roster/v1"),
      0,
      ...new TextEncoder().encode("{é}"),
    ]);
  });

  it("verify under the signer's key, and under no other, over the exact text", async () => {
    const desk = await signer("desk");
    const phone = await signer("phone");
    const text = rd();
    const sig = await desk.sign(text);
    expect(await verifyRosterSig(text, sig, desk.ed25519)).toBe(true);
    expect(await verifyRosterSig(text, sig, phone.ed25519)).toBe(false);
    // One space is another document: a relay that re-serialised would break every signature.
    expect(await verifyRosterSig(text.replace(":", ": "), sig, desk.ed25519)).toBe(false);
    // And it never throws on what a caller chose.
    expect(await verifyRosterSig(text, "junk", desk.ed25519)).toBe(false);
    expect(await verifyRosterSig(text, sig, "junk")).toBe(false);
  });

  it("hash as hex SHA-256 of the string", async () => {
    expect(await rosterHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

// ---------------------------------------------------------------------------------------
// POST /g/{group}/roster
// ---------------------------------------------------------------------------------------

describe("POST /roster", () => {
  it("stores a group's first document at its epoch, step 0, under a MAC it cannot check", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 3, hex64(3));
    const text = rd({ epoch: 3 });

    const response = await worker.fetch(amend(hex64(3), { roster: text, rosterMac: MAC }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ epoch: 3, step: 0 });
    expect(await stored(env)).toEqual([{ epoch: 3, step: 0 }]);
    // Stored as the exact string it was sent, and never reaches the Durable Object.
    const { body } = await keys(env, hex64(3));
    expect(body.roster).toBe(text);
    expect(body.rosterMac).toBe(MAC);
    expect(env.reached).toEqual([]);
  });

  it("chains an amendment onto the newest by its hash, one step on", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 3, hex64(3));
    const first = rd({ epoch: 3 });
    await worker.fetch(amend(hex64(3), { roster: first, rosterMac: MAC }), env);

    const second = rd({ epoch: 3, step: 1, prev: await rosterHash(first) });
    const response = await worker.fetch(amend(hex64(3), { roster: second, rosterMac: MAC }), env);

    expect(response.status).toBe(200);
    expect(await stored(env)).toEqual([
      { epoch: 3, step: 0 },
      { epoch: 3, step: 1 },
    ]);
  });

  it("refuses a document that does not follow the newest: 409 roster_conflict", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 3, hex64(3));
    const first = rd({ epoch: 3 });
    await worker.fetch(amend(hex64(3), { roster: first, rosterMac: MAC }), env);
    const prev = await rosterHash(first);

    for (const [why, text] of [
      ["no prev after a first", rd({ epoch: 3, step: 1 })],
      ["the wrong prev", rd({ epoch: 3, step: 1, prev: hex64(1) })],
      ["the same step again", rd({ epoch: 3, step: 0, prev })],
      ["a step skipped", rd({ epoch: 3, step: 2, prev })],
      ["an epoch the group is not on", rd({ epoch: 4, step: 0, prev })],
      ["an epoch it has left", rd({ epoch: 2, step: 1, prev })],
    ] as const) {
      const response = await worker.fetch(amend(hex64(3), { roster: text, rosterMac: MAC }), env);
      expect(response.status, why).toBe(409);
      expect(await code(response), why).toBe("roster_conflict");
    }
    expect(await stored(env)).toEqual([{ epoch: 3, step: 0 }]);
  });

  it("starts an epoch's amendments at step 0 when the newest document is an epoch behind", async () => {
    // An older build rotated without a document: the chain goes on from the last one there is.
    const env = relayEnv();
    await seedGroup(env, "g1", 3, hex64(3));
    const first = rd({ epoch: 3 });
    await worker.fetch(amend(hex64(3), { roster: first, rosterMac: MAC }), env);
    await worker.fetch(rotate(hex64(3), { epoch: 4, auth: hex64(4), keys: { desk: "b" } }), env);

    const next = rd({ epoch: 4, step: 0, prev: await rosterHash(first) });
    const response = await worker.fetch(amend(hex64(4), { roster: next, rosterMac: MAC }), env);

    expect(response.status).toBe(200);
    expect(await stored(env)).toEqual([
      { epoch: 3, step: 0 },
      { epoch: 4, step: 0 },
    ]);
  });

  it("refuses a body it cannot read as a roster, before it asks D1 anything", async () => {
    const env = relayEnv();
    // No group is seeded: a 400 here is decided from the body alone, never a 401.
    for (const body of [
      {},
      { roster: rd() },
      { roster: rd(), rosterMac: MAC, rosterSig: "x" },
      { roster: rd({ group: "g2" }), rosterMac: MAC },
      { roster: 7, rosterMac: MAC },
      null,
    ]) {
      const response = await worker.fetch(amend(hex64(0), body), env);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await code(response)).toBe("malformed_roster");
    }
  });

  it("asks for the group's current auth, as /rotate does", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 3, hex64(3));
    const body = { roster: rd({ epoch: 3 }), rosterMac: MAC };

    expect((await worker.fetch(amend(hex64(2), body), env)).status).toBe(401);
    const bare = new Request("https://relay.example/g/g1/roster", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect((await worker.fetch(bare, env)).status).toBe(401);
    expect(await stored(env)).toEqual([]);
  });

  it("is never forwarded to the object, whose own roster path it shares a name with", async () => {
    // A minted bearer token is not this route's credential: it is refused, and nothing reaches
    // the object — whose internal `/g/{group}/roster` only `rotate.ts` ever builds.
    const env = relayEnv();
    await seedGroup(env, "g1", 3, hex64(3));
    const response = await worker.fetch(amend("not-a-group-auth", { epoch: 3, devices: [] }), env);
    expect(response.status).toBe(401);
    expect(env.reached).toEqual([]);
  });

  it("answers 405 to a GET", async () => {
    const response = await worker.fetch(
      new Request("https://relay.example/g/g1/roster"),
      relayEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

// ---------------------------------------------------------------------------------------
// Signed mode
// ---------------------------------------------------------------------------------------

/**
 * A group at epoch 3 whose newest document is an open one naming `desk` and `phone` as full
 * members with real keys — the state a group is in before it enables a restricted device.
 */
async function openGroup() {
  const env = relayEnv();
  const desk = await signer("desk");
  const phone = await signer("phone");
  await seedGroup(env, "g1", 3, hex64(3));
  const open = rd({ epoch: 3, members: [member(desk), member(phone)] });
  expect((await worker.fetch(amend(hex64(3), { roster: open, rosterMac: MAC }), env)).status).toBe(
    200,
  );
  return { env, desk, phone, open, prev: await rosterHash(open) };
}

/** `openGroup`, then the desk rotating to epoch 4 with a signed document naming `bot` as `read`. */
async function signedGroup() {
  const group = await openGroup();
  const { env, desk, phone, prev } = group;
  const signed = rd({
    epoch: 4,
    prev,
    mode: "signed",
    members: [member(desk), member(phone), member("bot", "read")],
  });
  const response = await worker.fetch(
    rotate(hex64(3), {
      epoch: 4,
      auth: hex64(4),
      keys: { desk: "b", phone: "b", bot: "b" },
      roster: signed,
      rosterSig: await desk.sign(signed),
    }),
    env,
  );
  expect(response.status).toBe(200);
  return { ...group, signed, prev: await rosterHash(signed) };
}

describe("entering signed mode", () => {
  it("takes a first signed document signed by a full member of the open one before it", async () => {
    const { env, signed } = await signedGroup();
    expect(await stored(env)).toEqual([
      { epoch: 3, step: 0 },
      { epoch: 4, step: 0 },
    ]);
    const { body } = await keys(env, hex64(4));
    expect(body.roster).toBe(signed);
    expect(body.rosterMac).toBeNull();
    expect(typeof body.rosterSig).toBe("string");
  });

  it("refuses one signed by a key the previous document does not give its signer", async () => {
    const { env, desk, phone, prev } = await openGroup();
    const intruder = await signer("desk");
    const text = rd({
      epoch: 3,
      step: 1,
      prev,
      mode: "signed",
      members: [member(desk), member(phone)],
    });

    const response = await worker.fetch(
      amend(hex64(3), { roster: text, rosterSig: await intruder.sign(text) }),
      env,
    );

    expect(response.status).toBe(403);
    expect(await code(response)).toBe("unsigned_roster");
    expect(await stored(env)).toEqual([{ epoch: 3, step: 0 }]);
  });

  it("refuses one whose signer the previous document does not name, or names restricted", async () => {
    const { env, desk, phone, prev } = await openGroup();
    const stranger = await signer("stranger");
    const text = rd({
      epoch: 3,
      step: 1,
      prev,
      mode: "signed",
      signer: "stranger",
      members: [member(desk), member(phone), member(stranger)],
    });
    const response = await worker.fetch(
      amend(hex64(3), { roster: text, rosterSig: await stranger.sign(text) }),
      env,
    );
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("unsigned_roster");
  });

  it("refuses a signed document under a MAC, and a group's very first document signed", async () => {
    const { env, desk, phone, prev } = await openGroup();
    const text = rd({
      epoch: 3,
      step: 1,
      prev,
      mode: "signed",
      members: [member(desk), member(phone)],
    });
    const underMac = await worker.fetch(amend(hex64(3), { roster: text, rosterMac: MAC }), env);
    expect(underMac.status).toBe(403);
    expect(await code(underMac)).toBe("unsigned_roster");

    // No previous document is no signer to check against: trust on first use is refused.
    const fresh = relayEnv();
    await seedGroup(fresh, "g1", 3, hex64(3));
    const first = rd({ epoch: 3, mode: "signed", members: [member(desk)] });
    const response = await worker.fetch(
      amend(hex64(3), { roster: first, rosterSig: await desk.sign(first) }),
      fresh,
    );
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("unsigned_roster");
  });
});

describe("a signed group", () => {
  it("latches: an open document after a signed one is refused, under a MAC or a signature", async () => {
    const { env, desk, phone, prev } = await signedGroup();
    const open = rd({ epoch: 4, step: 1, prev, members: [member(desk), member(phone)] });
    for (const auth of [{ rosterMac: MAC }, { rosterSig: await desk.sign(open) }]) {
      const response = await worker.fetch(amend(hex64(4), { roster: open, ...auth }), env);
      expect(response.status).toBe(403);
      expect(await code(response)).toBe("unsigned_roster");
    }
  });

  it("takes an amendment signed by a full member, and refuses the restricted member's own", async () => {
    const { env, desk, phone, prev } = await signedGroup();
    const bot = await signer("bot");
    const promoted = rd({
      epoch: 4,
      step: 1,
      prev,
      mode: "signed",
      signer: "bot",
      members: [member(desk), member(phone), member(bot, "full")],
    });
    // The bot holds the group auth — it must, to read — and still cannot promote itself.
    const refused = await worker.fetch(
      amend(hex64(4), { roster: promoted, rosterSig: await bot.sign(promoted) }),
      env,
    );
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("unsigned_roster");

    const amended = rd({
      epoch: 4,
      step: 1,
      prev,
      mode: "signed",
      signer: "phone",
      members: [member(desk), member(phone), member("bot", "read")],
    });
    const taken = await worker.fetch(
      amend(hex64(4), { roster: amended, rosterSig: await phone.sign(amended) }),
      env,
    );
    expect(taken.status).toBe(200);
  });

  it("refuses a rotation that carries no document: 403 unsigned_rotation, and records nothing", async () => {
    const { env } = await signedGroup();
    const response = await worker.fetch(
      rotate(hex64(4), { epoch: 6, auth: hex64(6), keys: { bot: "b" } }),
      env,
    );
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("unsigned_rotation");
    const { body } = await keys(env, hex64(4));
    expect(body.epoch).toBe(4);
  });

  it("refuses a rotation whose document a restricted member signed — the bot cannot evict", async () => {
    const { env, prev } = await signedGroup();
    const bot = await signer("bot");
    const coup = rd({ epoch: 6, prev, mode: "signed", signer: "bot", members: [member(bot)] });
    const response = await worker.fetch(
      rotate(hex64(4), {
        epoch: 6,
        auth: hex64(6),
        keys: { bot: "b" },
        roster: coup,
        rosterSig: await bot.sign(coup),
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("unsigned_rotation");
    expect(await stored(env)).toEqual([
      { epoch: 3, step: 0 },
      { epoch: 4, step: 0 },
    ]);
    expect((await keys(env, hex64(4))).body.epoch).toBe(4);
  });

  it("takes a full member's signed rotation, and the removal it publishes", async () => {
    const { env, desk, prev } = await signedGroup();
    const removal = rd({ epoch: 6, prev, mode: "signed", members: [member(desk)] });
    const response = await worker.fetch(
      rotate(hex64(4), {
        epoch: 6,
        auth: hex64(6),
        keys: { desk: "b" },
        roster: removal,
        rosterSig: await desk.sign(removal),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect((await keys(env, hex64(6))).body.roster).toBe(removal);
  });
});

// ---------------------------------------------------------------------------------------
// POST /g/{group}/rotate, with a document
// ---------------------------------------------------------------------------------------

describe("POST /rotate with a roster document", () => {
  it("takes one at its own epoch, step 0, in an open group — and a rotation with none still", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 0, hex64(0));
    // Every released build rotates with no document, and must go on doing so.
    expect(
      (await worker.fetch(rotate(hex64(0), { epoch: 1, auth: hex64(1), keys: { desk: "b" } }), env))
        .status,
    ).toBe(200);

    const text = rd({ epoch: 2 });
    const response = await worker.fetch(
      rotate(hex64(1), {
        epoch: 2,
        auth: hex64(2),
        keys: { desk: "b" },
        roster: text,
        rosterMac: MAC,
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await stored(env)).toEqual([{ epoch: 2, step: 0 }]);
  });

  it("refuses a document at another epoch or step, or an authenticator alone, from the body", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 0, hex64(0));
    for (const extra of [
      { roster: rd({ epoch: 2 }), rosterMac: MAC },
      { roster: rd({ epoch: 1, step: 1 }), rosterMac: MAC },
      { rosterMac: MAC },
      { roster: rd({ epoch: 1 }) },
    ]) {
      const response = await worker.fetch(
        rotate(hex64(0), { epoch: 1, auth: hex64(1), keys: { desk: "b" }, ...extra }),
        env,
      );
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(await code(response)).toBe("malformed_roster");
    }
    expect((await keys(env, hex64(0))).body.epoch).toBe(0);
  });

  it("writes no document for a rotation refused for its epoch, and words it as before", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 0, hex64(0));
    const ahead = await worker.fetch(
      rotate(hex64(0), {
        epoch: 3,
        auth: hex64(3),
        keys: {},
        roster: rd({ epoch: 3 }),
        rosterMac: MAC,
      }),
      env,
    );
    expect(ahead.status).toBe(422);
    const behind = await worker.fetch(
      rotate(hex64(0), {
        epoch: 0,
        auth: hex64(9),
        keys: {},
        roster: rd({ epoch: 0 }),
        rosterMac: MAC,
      }),
      env,
    );
    expect(behind.status).toBe(409);
    expect(await stored(env)).toEqual([]);
  });

  it("takes back its document when the rotation loses a race the document did not", async () => {
    // Another rotation lands between this one's document and its record: the record is refused,
    // and the document it stored must go with it.
    const env = relayEnv();
    await seedGroup(env, "g1", 0, hex64(0));
    const original = env.DB.prepare.bind(env.DB);
    let raced = false;
    env.DB.prepare = ((sql: string) => {
      if (!raced && sql.includes("INSERT INTO group_keys")) {
        raced = true;
        void recordRotation(env, "g1", 1, hex64(5), { phone: "b" });
      }
      return original(sql);
    }) as typeof env.DB.prepare;

    const response = await worker.fetch(
      rotate(hex64(0), {
        epoch: 1,
        auth: hex64(1),
        keys: { desk: "b" },
        roster: rd({ epoch: 1 }),
        rosterMac: MAC,
      }),
      env,
    );
    expect(response.status).toBe(409);
    expect(await stored(env)).toEqual([]);
  });

  it("refuses a document that lost the chain to an amendment, and records no rotation", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 0, hex64(0));
    const first = rd();
    await worker.fetch(amend(hex64(0), { roster: first, rosterMac: MAC }), env);
    const prev = await rosterHash(first);
    // An amendment the rotator had not seen.
    await worker.fetch(amend(hex64(0), { roster: rd({ step: 1, prev }), rosterMac: MAC }), env);

    const response = await worker.fetch(
      rotate(hex64(0), {
        epoch: 1,
        auth: hex64(1),
        keys: { desk: "b" },
        roster: rd({ epoch: 1, prev }),
        rosterMac: MAC,
      }),
      env,
    );
    expect(response.status).toBe(409);
    expect(await code(response)).toBe("roster_conflict");
    expect((await keys(env, hex64(0))).body.epoch).toBe(0);
  });

  it("prunes documents older than the key window, and never the newest", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 0, hex64(0));
    let prev: string | null = null;
    for (let epoch = 1; epoch <= 10; epoch += 1) {
      const text = rd({ epoch, prev });
      const response = await worker.fetch(
        rotate(hex64(epoch - 1), {
          epoch,
          auth: hex64(epoch),
          keys: { desk: "b" },
          roster: text,
          rosterMac: MAC,
        }),
        env,
      );
      expect(response.status).toBe(200);
      prev = await rosterHash(text);
    }
    expect((await stored(env)).map((row) => row.epoch)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

// ---------------------------------------------------------------------------------------
// GET /g/{group}/keys
// ---------------------------------------------------------------------------------------

describe("GET /keys's roster documents", () => {
  it("answers the four fields it always did, first and in their order, then the five new ones", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 0, hex64(0));
    await recordRotation(env, "g1", 1, hex64(1), { desk: "blob-desk" });

    const response = await worker.fetch(
      new Request("https://relay.example/g/g1/keys?device=desk", {
        headers: { authorization: `Bearer ${hex64(1)}` },
      }),
      env,
    );
    const text = await response.text();

    // Byte for byte, the answer a released build reads, then what it ignores.
    const before = JSON.stringify({
      epoch: 1,
      blob: "blob-desk",
      devices: ["desk"],
      removalStep: 2,
    });
    expect(text.startsWith(before.slice(0, -1))).toBe(true);
    expect(text).toBe(
      `${before.slice(0, -1)},"roster":null,"rosterMac":null,"rosterSig":null,"rosters":[],"sig":1}`,
    );
  });

  it("answers the newest, and every document from since on, oldest first", async () => {
    const { env, open, signed } = await signedGroup();

    const fromThree = (await keys(env, hex64(4), "&since=3")).body;
    expect(fromThree.roster).toBe(signed);
    expect((fromThree.rosters as { roster: string }[]).map((r) => r.roster)).toEqual([
      open,
      signed,
    ]);
    expect(fromThree.rosters).toEqual([
      { roster: open, rosterMac: MAC, rosterSig: null },
      { roster: signed, rosterMac: null, rosterSig: fromThree.rosterSig },
    ]);
    expect(fromThree.sig).toBe(1);

    // No `since` is the answered epoch's: the newest, here.
    const plain = (await keys(env, hex64(4))).body;
    expect((plain.rosters as unknown[]).length).toBe(1);
    // With `epoch`, the page starts at the epoch asked for.
    const old = (await keys(env, hex64(4), "&epoch=3")).body;
    expect(old.epoch).toBe(3);
    expect((old.rosters as unknown[]).length).toBe(2);
    expect(old.roster).toBe(signed);
  });

  it("caps the page at sixteen", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 0, hex64(0));
    let prev: string | null = null;
    for (let step = 0; step < ROSTER_PAGE + 4; step += 1) {
      const text = rd({ step, prev });
      expect(
        (await worker.fetch(amend(hex64(0), { roster: text, rosterMac: MAC }), env)).status,
      ).toBe(200);
      prev = await rosterHash(text);
    }
    const { body } = await keys(env, hex64(0), "&since=0");
    expect((body.rosters as unknown[]).length).toBe(16);
    expect(JSON.parse((body.rosters as { roster: string }[])[0].roster)).toMatchObject({ step: 0 });
    expect(JSON.parse(body.roster as string)).toMatchObject({ step: ROSTER_PAGE + 3 });
  });

  it("refuses a since that is not an epoch, as it refuses such an epoch", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 0, hex64(0));
    for (const since of ["", "-1", "1e0", "x"]) {
      const { response, body } = await keys(env, hex64(0), `&since=${since}`);
      expect(response.status, since).toBe(400);
      expect(body).toEqual({ error: "that is not an epoch" });
    }
  });
});

// ---------------------------------------------------------------------------------------
// The token's cap, and what refuses on it
// ---------------------------------------------------------------------------------------

describe("the token door's cap claim", () => {
  it("mints a restricted device's token with its cap, and a full device's with none", async () => {
    const { env } = await signedGroup();
    expect(await capOf(env, "g1", "bot")).toBe("read");
    expect(await capOf(env, "g1", "desk")).toBeUndefined();
    expect(await capOf(env, "g1", "stranger")).toBeUndefined();

    const mintFor = async (device: string) => {
      const response = await worker.fetch(
        new Request("https://relay.example/token", {
          method: "POST",
          body: JSON.stringify({ group: "g1", auth: hex64(4), device }),
        }),
        env,
      );
      expect(response.status).toBe(200);
      const { access } = (await response.json()) as { access: string };
      return verify(access, "test-signing-key", Date.now());
    };
    expect(await mintFor("bot")).toEqual(expect.objectContaining({ dev: "bot", cap: "read" }));
    expect(await mintFor("desk")).not.toHaveProperty("cap");
  });

  it("mints no cap in a group that has published no document", async () => {
    const env = relayEnv();
    await seedGroup(env, "g1", 0, hex64(0));
    expect(await capOf(env, "g1", "desk")).toBeUndefined();
  });
});

describe("a signed group's push and ack", () => {
  afterEach(() => vi.restoreAllMocks());

  const bearer = async (dev: string, cap?: string) => {
    const claims = { sub: "sub-0", grp: "g1", exp: Date.now() + TOKEN_TTL_MS, dev };
    return mint(cap === undefined ? claims : { ...claims, cap }, "test-signing-key");
  };
  const send = async (env: Env, action: string, body: unknown, dev: string, cap?: string) =>
    worker.fetch(
      new Request(`https://relay.example/g/g1/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await bearer(dev, cap)}` },
        body: JSON.stringify(body),
      }),
      env,
    );
  const envelope = (device: string) => ({
    group: "g1",
    device,
    epoch: 4,
    hlcMs: Date.now(),
    hlcCtr: 0,
    sealed: "s",
  });

  it("refuses a body that names another device than the token's: 403 device_mismatch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env } = await signedGroup();
    env.reached.length = 0;

    const pushed = await send(env, "push", envelope("desk"), "phone");
    expect(pushed.status).toBe(403);
    expect(await code(pushed)).toBe("device_mismatch");
    const acked = await send(env, "ack", { device: "desk", cursor: 9 }, "bot", "read");
    expect(acked.status).toBe(403);
    expect(env.reached).toEqual([]);

    // A match is forwarded as ever.
    expect((await send(env, "push", envelope("desk"), "desk")).status).toBe(200);
    expect(env.reached).toEqual(["/g/g1/push"]);
  });

  it("still only warns in an open group", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env } = await openGroup();
    const pushed = await send(env, "push", { ...envelope("desk"), epoch: 3 }, "phone");
    expect(pushed.status).toBe(200);
    expect(warned.mock.calls).toEqual([["device_mismatch on push"]]);
  });

  it("names a restricted device's push to its object for the daily count, and no other", async () => {
    const { env } = await signedGroup();
    const forwarded: Request[] = [];
    env.GROUP = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (request: Request) => {
          forwarded.push(request);
          return Promise.resolve(new Response("{}"));
        },
      }),
    } as unknown as DurableObjectNamespace;

    await send(env, "push", envelope("bot"), "bot", "read");
    await send(env, "push", envelope("desk"), "desk");
    // A client's own copy of the header never reaches the object: the push is rebuilt.
    await worker.fetch(
      new Request("https://relay.example/g/g1/push", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await bearer("desk")}`,
          "x-grimoire-restricted": "desk",
        },
        body: JSON.stringify(envelope("desk")),
      }),
      env,
    );

    expect(forwarded.map((r) => r.headers.get("x-grimoire-restricted"))).toEqual([
      "bot",
      null,
      null,
    ]);
  });

  /**
   * Spec §14.5: a restricted device's push over 64 KiB is refused before its object is reached —
   * by its text, and by a declared length before a byte is read — while a full device's push of
   * the same size goes on, and a restricted one at exactly 64 KiB is forwarded.
   */
  it("refuses a restricted device's push over 64 KiB: 413 restricted_too_large", async () => {
    const { env } = await signedGroup();
    env.reached.length = 0;
    /** An envelope whose JSON body is exactly `bytes` long. */
    const sized = (device: string, bytes: number) => {
      const bare = JSON.stringify(envelope(device)).length - 1;
      return { ...envelope(device), sealed: "s".repeat(bytes - bare) };
    };
    expect(JSON.stringify(sized("bot", RESTRICTED_PUSH_BYTES)).length).toBe(RESTRICTED_PUSH_BYTES);

    for (const cap of ["add", "read"]) {
      const over = await send(env, "push", sized("bot", RESTRICTED_PUSH_BYTES + 1), "bot", cap);
      expect(over.status).toBe(413);
      expect(await code(over)).toBe("restricted_too_large");
    }
    const declared = await worker.fetch(
      new Request("https://relay.example/g/g1/push", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await bearer("bot", "add")}`,
          "content-length": String(RESTRICTED_PUSH_BYTES + 1),
        },
        body: JSON.stringify(envelope("bot")),
      }),
      env,
    );
    expect(declared.status).toBe(413);
    expect(await code(declared)).toBe("restricted_too_large");
    expect(env.reached).toEqual([]);

    expect(
      (await send(env, "push", sized("bot", RESTRICTED_PUSH_BYTES), "bot", "add")).status,
    ).toBe(200);
    expect((await send(env, "push", sized("desk", RESTRICTED_PUSH_BYTES + 1), "desk")).status).toBe(
      200,
    );
    expect(env.reached).toEqual(["/g/g1/push", "/g/g1/push"]);
  });
});

// ---------------------------------------------------------------------------------------
// The engine's golden vectors
// ---------------------------------------------------------------------------------------

interface Golden {
  groupId: string;
  groupKeyHex: string;
  signingDomain: string;
  macInfo: string;
  open: { roster: string; hash: string; macKeyHex: string; rosterMac: string };
  signed: {
    roster: string;
    hash: string;
    signer: string;
    signerSeedHex: string;
    signerPublic: string;
    rosterSig: string;
  };
}

const GOLDEN = JSON.parse(goldenText) as Golden;

function fromHex(text: string): Uint8Array {
  return new Uint8Array(text.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? []);
}

const toHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("the engine's golden vectors (crates/grimoire-core/src/__golden__/roster-v1.json)", () => {
  it("parse, both of them — a member with no signing key yet among them", () => {
    const open = parseRoster(GOLDEN.open.roster, GOLDEN.groupId);
    const signed = parseRoster(GOLDEN.signed.roster, GOLDEN.groupId);
    expect(open.ok && open.roster.mode).toBe("open");
    expect(signed.ok && signed.roster.mode).toBe("signed");
    // `ed25519: null` is how the engine writes a device paired before signing keys existed.
    expect(open.ok && open.roster.members.map((m) => m.ed25519 === null)).toEqual([false, true]);
    expect(signed.ok && signed.roster.members.map((m) => m.cap)).toEqual(["full", "full", "read"]);
  });

  it("hash as this file hashes, and chain", async () => {
    expect(await rosterHash(GOLDEN.open.roster)).toBe(GOLDEN.open.hash);
    expect(await rosterHash(GOLDEN.signed.roster)).toBe(GOLDEN.signed.hash);
    const signed = parseRoster(GOLDEN.signed.roster, GOLDEN.groupId);
    expect(signed.ok && signed.roster.prev).toBe(GOLDEN.open.hash);
  });

  it("sign the bytes this file signs: the engine's signature verifies here, and is the one WebCrypto makes", async () => {
    expect(GOLDEN.signingDomain).toBe(ROSTER_DOMAIN);
    expect(
      await verifyRosterSig(
        GOLDEN.signed.roster,
        GOLDEN.signed.rosterSig,
        GOLDEN.signed.signerPublic,
      ),
    ).toBe(true);
    // Ed25519 is deterministic, so the seed signs to the very signature the engine pinned.
    const pkcs8 = fromHex(`302e020100300506032b657004220420${GOLDEN.signed.signerSeedHex}`);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
    const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
    expect(jwk.x).toBe(GOLDEN.signed.signerPublic);
    const sig = await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      signedBytes(GOLDEN.signed.roster),
    );
    expect(b64url(sig)).toBe(GOLDEN.signed.rosterSig);
  });

  it("MAC as §12 spells it — the key a client derives, which the relay never holds", async () => {
    // The relay stores a MAC unverified; this holds §12's derivation across the two languages,
    // so a client that checks one is checking what the engine wrote.
    const ikm = await crypto.subtle.importKey("raw", fromHex(GOLDEN.groupKeyHex), "HKDF", false, [
      "deriveBits",
    ]);
    const macKey = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode(GOLDEN.groupId),
        info: new TextEncoder().encode(GOLDEN.macInfo),
      },
      ikm,
      256,
    );
    expect(toHex(macKey)).toBe(GOLDEN.open.macKeyHex);
    const hmac = await crypto.subtle.importKey(
      "raw",
      macKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", hmac, signedBytes(GOLDEN.open.roster));
    expect(b64url(mac)).toBe(GOLDEN.open.rosterMac);
  });

  it("are stored by the relay as the engine sent them: the open one amended, the signed one rotated in", async () => {
    const G = GOLDEN.groupId;
    const env = { ...fakeEnv(G), RELAY_HMAC_KEY: "test-signing-key" } as unknown as Env;
    env.GROUP = relayEnv().GROUP;
    await seedGroup(env, G, 3, hex64(3));
    const at = (action: string, credential: string, body: unknown) =>
      worker.fetch(
        new Request(`https://relay.example/g/${G}/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}` },
          body: JSON.stringify(body),
        }),
        env,
      );

    const amended = await at("roster", hex64(3), {
      roster: GOLDEN.open.roster,
      rosterMac: GOLDEN.open.rosterMac,
    });
    expect(amended.status).toBe(200);

    const members = JSON.parse(GOLDEN.signed.roster) as { members: { device: string }[] };
    const rotated = await at("rotate", hex64(3), {
      epoch: 4,
      auth: hex64(4),
      keys: Object.fromEntries(members.members.map((m) => [m.device, "blob"])),
      roster: GOLDEN.signed.roster,
      rosterSig: GOLDEN.signed.rosterSig,
    });
    expect(rotated.status).toBe(200);

    const answer = await worker.fetch(
      new Request(`https://relay.example/g/${G}/keys?device=${GOLDEN.signed.signer}&since=3`, {
        headers: { authorization: `Bearer ${hex64(4)}` },
      }),
      env,
    );
    const body = (await answer.json()) as { roster: string; rosterSig: string; rosters: unknown[] };
    expect(body.roster).toBe(GOLDEN.signed.roster);
    expect(body.rosterSig).toBe(GOLDEN.signed.rosterSig);
    expect(body.rosters).toHaveLength(2);
    expect(await capOf(env, G, "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3")).toBe("read");
    expect(await capOf(env, G, GOLDEN.signed.signer)).toBeUndefined();
  });

  it("refuse the signed one signed by the member with no key, or with a byte changed", async () => {
    const G = GOLDEN.groupId;
    const env = { ...fakeEnv(G), RELAY_HMAC_KEY: "test-signing-key" } as unknown as Env;
    env.GROUP = relayEnv().GROUP;
    await seedGroup(env, G, 3, hex64(3));
    await worker.fetch(
      new Request(`https://relay.example/g/${G}/roster`, {
        method: "POST",
        headers: { authorization: `Bearer ${hex64(3)}` },
        body: JSON.stringify({ roster: GOLDEN.open.roster, rosterMac: GOLDEN.open.rosterMac }),
      }),
      env,
    );
    for (const roster of [
      // Signed by the member whose key is `null`: there is no key to verify it under.
      GOLDEN.signed.roster.replace(
        `"signer":"${GOLDEN.signed.signer}"`,
        '"signer":"b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"',
      ),
      // One byte of the document changed, under the engine's own signature.
      GOLDEN.signed.roster.replace('"proto":2,"since":4', '"proto":2,"since":5'),
    ]) {
      const response = await worker.fetch(
        new Request(`https://relay.example/g/${G}/rotate`, {
          method: "POST",
          headers: { authorization: `Bearer ${hex64(3)}` },
          body: JSON.stringify({
            epoch: 4,
            auth: hex64(4),
            keys: {},
            roster,
            rosterSig: GOLDEN.signed.rosterSig,
          }),
        }),
        env,
      );
      expect(response.status).toBe(403);
      expect(await code(response)).toBe("unsigned_rotation");
    }
  });
});
