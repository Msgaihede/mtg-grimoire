import { describe, expect, it } from "vitest";
import { INTENTS_PER_DAY, KEEP_ACKED_MS, LEASE_MS, type Ack } from "../src/intents";
import { importKek, intentKey, unwrapDataKey } from "../src/seal";
import {
  ALL_OFF,
  collectionAdd,
  consumerToken,
  deviceRequest,
  harness,
  KEK,
  mintConsumer,
  postIntent,
  putSettings,
  request,
  token,
  wishlistAdd,
} from "./fake";

/**
 * **The inbox, from a device's side** (the PR 3 plan, §3.2): the pending list, the claim that
 * makes one device the one that applies, the ack and its rules, and the consumer tokens a device
 * mints, lists and revokes. Driven through the router, so every case is behind the gate.
 */

type H = ReturnType<typeof harness>;

/** A store on, and a Discord token with every scope. */
async function ready(h: H = harness()) {
  await putSettings(h.fetch, ALL_OFF);
  return { h, bearer: await consumerToken(h.fetch) };
}

async function post(h: H, bearer: string, body: unknown = collectionAdd()): Promise<string> {
  const res = await postIntent(h.fetch, bearer, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { intent: { id: string } }).intent.id;
}

async function pending(h: H, since?: number) {
  const path = since === undefined ? "/g/g1/intents" : `/g/g1/intents?since=${since}`;
  return h.fetch(await deviceRequest("GET", path));
}

async function claim(h: H, id: string) {
  return h.fetch(await deviceRequest("POST", `/g/g1/intents/${id}/claim`));
}

async function ack(h: H, id: string, body: Ack | Record<string, unknown>) {
  return h.fetch(await deviceRequest("POST", `/g/g1/intents/${id}/ack`, body));
}

const applied = (lease: string | null, hlcMs = 2_000): Ack => ({
  state: "applied",
  reason: null,
  lease,
  hlcMs,
  hlcCtr: 0,
});

const refused = (lease: string | null = null): Ack => ({
  state: "refused",
  reason: "That folder no longer exists.",
  lease,
  hlcMs: null,
  hlcCtr: null,
});

describe("GET /g/{group}/intents", () => {
  it("is no_store before the switch", async () => {
    const res = await pending(harness());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "no_store" });
  });

  it("is the pending intents, oldest first, opened, with the group and the source", async () => {
    const { h, bearer } = await ready();
    const first = await post(h, bearer);
    const second = await post(h, bearer, wishlistAdd());
    const res = await pending(h);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intents: Record<string, unknown>[]; more: boolean };
    expect(body.more).toBe(false);
    expect(body.intents.map((i) => i.id)).toEqual([first, second]);
    expect(body.intents[0]).toEqual({
      id: first,
      group: "g1",
      source: "discord",
      kind: "collection.add",
      payload: collectionAdd().payload,
      createdAt: expect.any(Number),
      confirmedBy: "discord:123",
      state: "pending",
      reason: null,
    });
  });

  it("leaves out an acked intent, and takes since as milliseconds", async () => {
    const { h, bearer } = await ready();
    const id = await post(h, bearer);
    const listed = (await (await pending(h)).json()) as { intents: { createdAt: number }[] };
    const createdAt = listed.intents[0].createdAt;
    expect(((await (await pending(h, createdAt)).json()) as { intents: [] }).intents).toEqual([]);
    expect(((await (await pending(h, createdAt - 1)).json()) as { intents: [] }).intents).toHaveLength(1);
    expect((await ack(h, id, refused())).status).toBe(200);
    expect(((await (await pending(h)).json()) as { intents: [] }).intents).toEqual([]);
    expect((await pending(h, -1)).status).toBe(400);
    expect((await h.fetch(await deviceRequest("GET", "/g/g1/intents?since=1e3"))).status).toBe(400);
  });

  it("seals the payload and who confirmed it, and keeps in the clear only what the overlay reads", async () => {
    const { h, bearer } = await ready();
    const id = await post(h, bearer);
    const storage = h.stores.objectOf("g1").storage;
    const row = storage.db.prepare("SELECT * FROM intents WHERE id = ?").get(id)!;
    expect(row).toMatchObject({
      source: "discord",
      kind: "collection.add",
      state: "pending",
      name_norm: "lightning bolt",
      folder_uid: "fold-binder",
    });
    const sealed = new TextDecoder("latin1").decode(row.sealed as Uint8Array);
    expect(sealed).not.toContain("discord:123");
    expect(sealed).not.toContain("0000579f");
    // And it opens under the inbox's key, bound to its id.
    const wrapped = storage.db.prepare("SELECT value FROM meta WHERE key = 'data_key'").get()!
      .value as string;
    const key = await intentKey(await unwrapDataKey(await importKek(KEK, "K"), wrapped, "g1"));
    const { openIntent } = await import("../src/seal");
    expect(await openIntent(key, id, row.sealed as Uint8Array)).toEqual({
      payload: collectionAdd().payload,
      confirmedBy: "discord:123",
    });
    await expect(openIntent(key, "A".repeat(22), row.sealed as Uint8Array)).rejects.toThrow();
  });
});

describe("POST /g/{group}/intents/{id}/claim", () => {
  it("gives one device a lease and the next one claimed", async () => {
    const { h, bearer } = await ready();
    const id = await post(h, bearer);
    const first = await claim(h, id);
    expect(first.status).toBe(200);
    const lease = (await first.json()) as { id: string; lease: string; leaseUntil: number };
    expect(lease.id).toBe(id);
    expect(lease.lease).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(lease.leaseUntil - Date.now()).toBeGreaterThan(LEASE_MS - 5_000);
    const second = await claim(h, id);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "claimed" });
  });

  it("lets anyone take an intent whose lease has run out", async () => {
    const { h, bearer } = await ready();
    const id = await post(h, bearer);
    const store = h.stores.objectOf("g1").store;
    const now = Date.now();
    expect((await store.claimIntent("g1", id, now)).status).toBe(200);
    expect((await store.claimIntent("g1", id, now + LEASE_MS - 1)).status).toBe(409);
    expect((await store.claimIntent("g1", id, now + LEASE_MS + 1)).status).toBe(200);
  });

  it("is already_acked, with the state, once acked; no_intent for an id it never had", async () => {
    const { h, bearer } = await ready();
    const id = await post(h, bearer);
    await ack(h, id, refused());
    const res = await claim(h, id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "already_acked", state: "refused" });
    const none = await claim(h, "Z".repeat(22));
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ code: "no_intent" });
  });
});

describe("POST /g/{group}/intents/{id}/ack", () => {
  it("takes applied from the lease holder, and from nobody else", async () => {
    const { h, bearer } = await ready();
    const id = await post(h, bearer);
    // No claim: there is no lease to hold.
    expect((await ack(h, id, applied("A".repeat(22)))).status).toBe(409);
    const { lease } = (await (await claim(h, id)).json()) as { lease: string };
    const other = await ack(h, id, applied("B".repeat(22)));
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: "claimed" });
    const mine = await ack(h, id, applied(lease));
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ id, state: "applied" });
    const row = h.stores.objectOf("g1").storage.db
      .prepare("SELECT state, ack_hlc_ms, ack_hlc_ctr, acked_at FROM intents WHERE id = ?")
      .get(id)!;
    expect(row).toMatchObject({ state: "applied", ack_hlc_ms: 2_000, ack_hlc_ctr: 0 });
  });

  it("takes refused with no lease, unless another device's lease is live", async () => {
    const { h, bearer } = await ready();
    const free = await post(h, bearer);
    expect((await ack(h, free, refused())).status).toBe(200);
    const held = await post(h, bearer);
    const { lease } = (await (await claim(h, held)).json()) as { lease: string };
    expect((await ack(h, held, refused())).status).toBe(409);
    expect((await ack(h, held, refused(lease))).status).toBe(200);
    const row = h.stores.objectOf("g1").storage.db
      .prepare("SELECT reason FROM intents WHERE id = ?")
      .get(held)!;
    expect(row.reason).toBe("That folder no longer exists.");
  });

  it("answers an ack repeating the held state with 200, and another state with already_acked", async () => {
    const { h, bearer } = await ready();
    const id = await post(h, bearer);
    const { lease } = (await (await claim(h, id)).json()) as { lease: string };
    expect((await ack(h, id, applied(lease))).status).toBe(200);
    // An owed ack, sent again after a crash.
    expect((await ack(h, id, applied(lease))).status).toBe(200);
    const late = await ack(h, id, refused());
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "already_acked", state: "applied" });
  });

  it.each([
    ["no body", undefined],
    ["applied with a reason", { state: "applied", reason: "x", lease: "A".repeat(22), hlcMs: 1, hlcCtr: 0 }],
    ["refused with no reason", { state: "refused", reason: null, lease: null, hlcMs: null, hlcCtr: null }],
    ["a state of its own", { state: "pending", reason: null, lease: null, hlcMs: null, hlcCtr: null }],
  ])("refuses %s as bad_ack", async (_label, body) => {
    const { h, bearer } = await ready();
    const id = await post(h, bearer);
    const res = await ack(h, id, body as Record<string, unknown>);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_ack" });
  });

  it("forgets an acked intent thirty days on, at the next write to the inbox", async () => {
    const { h } = await ready();
    const bearer = await consumerToken(h.fetch, "discord", undefined, { days: 365 });
    const store = h.stores.objectOf("g1").store;
    const old = await post(h, bearer);
    const t0 = Date.now();
    expect((await store.ackIntent("g1", old, refused(), t0)).status).toBe(200);
    const later = t0 + KEEP_ACKED_MS + 1;
    const posted = await store.consumer("g1", bearer, { op: "post", body: collectionAdd() }, later);
    expect(posted.status).toBe(200);
    const ids = h.stores.objectOf("g1").storage.db
      .prepare("SELECT id FROM intents")
      .all()
      .map((row) => row.id);
    expect(ids).not.toContain(old);
    expect(ids).toHaveLength(1);
  });
});

describe("the consumer tokens a device mints", () => {
  it("is no_store before the switch, and bad_consumer for a grant outside the list", async () => {
    const h = harness();
    expect((await mintConsumer(h.fetch)).status).toBe(404);
    await putSettings(h.fetch, ALL_OFF);
    const res = await mintConsumer(h.fetch, "discord", ["collection:remove"]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_consumer" });
    expect((await mintConsumer(h.fetch, "discord", ["decks:read"], { days: 366 })).status).toBe(400);
  });

  it("answers the token, its scopes in canonical order, and exp in seconds", async () => {
    const { h } = await ready();
    const res = await mintConsumer(h.fetch, "mcp", ["wishlist:add", "collection:read"], { days: 2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integration: string; token: string; scopes: string[]; exp: number };
    expect(body.integration).toBe("mcp");
    expect(body.token.startsWith("gct1.")).toBe(true);
    expect(body.scopes).toEqual(["collection:read", "wishlist:add"]);
    expect(body.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(2 * 86_400 - 60);
  });

  it("lists the tokens live, one an integration, and never the token itself", async () => {
    const { h } = await ready();
    await mintConsumer(h.fetch, "mcp", ["decks:read"]);
    const res = await h.fetch(await deviceRequest("GET", "/g/g1/consumers"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consumers: Record<string, unknown>[] };
    expect(body.consumers.map((c) => c.integration)).toEqual(["discord", "mcp"]);
    expect(body.consumers[1]).toEqual({
      integration: "mcp",
      scopes: ["decks:read"],
      issuedAt: expect.any(Number),
      exp: expect.any(Number),
    });
    expect(JSON.stringify(body)).not.toContain("gct1");
  });

  it("revokes one integration's token and leaves the other's", async () => {
    const { h, bearer } = await ready();
    const mcp = await consumerToken(h.fetch, "mcp");
    const res = await h.fetch(await deviceRequest("DELETE", "/g/g1/consumers/discord"));
    expect(res.status).toBe(204);
    // Twice is the same answer.
    expect((await h.fetch(await deviceRequest("DELETE", "/g/g1/consumers/discord"))).status).toBe(204);
    expect((await postIntent(h.fetch, bearer, collectionAdd())).status).toBe(401);
    expect((await postIntent(h.fetch, mcp, collectionAdd())).status).toBe(200);
  });

  it("is a route for discord and mcp only, POST and DELETE, behind the gate", async () => {
    const { h } = await ready();
    expect((await h.fetch(await deviceRequest("POST", "/g/g1/consumers/trade", {}))).status).toBe(404);
    const get = await h.fetch(await deviceRequest("GET", "/g/g1/consumers/discord"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST, DELETE");
    const other = await h.fetch(
      request("POST", "/g/g1/consumers/discord", {
        bearer: await token("g2"),
        body: JSON.stringify({ scopes: ["decks:read"], days: 1 }),
      }),
    );
    expect(other.status).toBe(401);
  });
});

describe("the daily cap and the size cap", () => {
  it(`takes ${INTENTS_PER_DAY} intents a UTC day from one integration, and refuses the next`, async () => {
    const { h, bearer } = await ready();
    const mcp = await consumerToken(h.fetch, "mcp");
    for (let n = 0; n < INTENTS_PER_DAY; n += 1) await post(h, bearer);
    const over = await postIntent(h.fetch, bearer, collectionAdd());
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ code: "intent_quota" });
    // Another integration's day is its own.
    expect((await postIntent(h.fetch, mcp, collectionAdd())).status).toBe(200);
    // And tomorrow is another day.
    const store = h.stores.objectOf("g1").store;
    const tomorrow = Date.now() + 86_400_000;
    expect(
      (await store.consumer("g1", bearer, { op: "post", body: collectionAdd() }, tomorrow)).status,
    ).toBe(200);
  });
});
