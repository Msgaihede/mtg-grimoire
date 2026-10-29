import { describe, expect, it } from "vitest";
import { signToken } from "../src/consumer";
import { MAX_INTENT_BYTES } from "../src/intents";
import { consumerKey, newDataKey } from "../src/seal";
import {
  ALL_OFF,
  ALL_ON,
  collectionAdd,
  consumerRequest,
  consumerToken,
  deviceRequest,
  documentOf,
  harness,
  KEK,
  NEXT_KEK,
  postIntent,
  putSettings,
  putTable,
  request,
  token,
  wishlistAdd,
} from "./fake";

/**
 * **The consumer routes** (the PR 3 plan, §3.3): the door a consumer token opens, the scopes it
 * carries, the projection's rows read back opened, and the overlay — a pending add drawn at once,
 * an applied one kept until a publish reflects it, a refused one never. Every case through the
 * router, so the token's whole path is under test: the router's read of its claims, the object's
 * check of its MAC, its `exp` and its `tid`.
 */

type H = ReturnType<typeof harness>;

const FOLDERS = [
  { uid: "fold-binder", name: "Trade binder", parentUid: null, kind: "user", locked: false },
  { uid: "fold-deck", name: "Mono red", parentUid: null, kind: "deck", locked: false },
  { uid: "fold-vault", name: "Vault", parentUid: null, kind: "user", locked: true },
];

const card = (uid: string, name: string, folderUid: string, quantity = 1) => ({
  uid,
  scryfallId: `${uid}-id`,
  name,
  set: "2x2",
  cn: "1",
  finish: "nonfoil",
  quantity,
  folderUid,
});

const ENTRIES = [
  card("e-1", "Lightning Bolt", "fold-binder", 4),
  card("e-2", "Lightning Helix", "fold-vault"),
  card("e-3", "Counterspell", "fold-binder"),
  card("e-4", "Lim-Dûl's Vault", "fold-vault"),
];

const WISHES = [
  {
    uid: "w-1",
    scryfallId: null,
    oracleId: "o-1",
    name: "Force of Will",
    set: "all",
    cn: "28",
    finish: "nonfoil",
    quantity: 1,
    folderUid: null,
  },
];

const DECKS = [
  { uid: "d-1", name: "Burn", format: "modern", folderUid: "fold-deck" },
  { uid: "d-2", name: "Control", format: "legacy", folderUid: null },
];

const DECK_CARDS = [
  {
    uid: "dc-1",
    deckUid: "d-1",
    pile: "Main",
    kind: "main",
    active: true,
    scryfallId: "e-1-id",
    name: "Lightning Bolt",
    set: "2x2",
    cn: "117",
    finish: "nonfoil",
    quantity: 4,
  },
  {
    uid: "dc-2",
    deckUid: "d-2",
    pile: "Main",
    kind: "main",
    active: true,
    scryfallId: "e-3-id",
    name: "Counterspell",
    set: "2x2",
    cn: "2",
    finish: "nonfoil",
    quantity: 4,
  },
];

/** A store with every table published at watermark 1000, and a Discord token with every scope. */
async function stocked(h: H = harness()) {
  await putSettings(h.fetch, ALL_OFF);
  for (const [table, rows] of [
    ["collection_folders", FOLDERS],
    ["collection_entries", ENTRIES],
    ["wishlist_folders", [{ uid: "wf-1", name: "Want", parentUid: null }]],
    ["wishlist_entries", WISHES],
    ["decks", DECKS],
    ["deck_cards", DECK_CARDS],
  ] as const) {
    const res = await putTable(h.fetch, table, documentOf(table, [...rows]));
    expect(res.status, table).toBe(200);
  }
  return { h, bearer: await consumerToken(h.fetch) };
}

async function get(h: H, path: string, bearer: string | null) {
  return h.fetch(consumerRequest("GET", path, bearer));
}

async function rowsOf(h: H, path: string, bearer: string) {
  const res = await get(h, path, bearer);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { rows: Record<string, unknown>[]; more: boolean } & Record<
    string,
    unknown
  >;
}

describe("the consumer door", () => {
  it("is a 401 with no token, and with a relay token, and reaches no object", async () => {
    const h = harness();
    for (const bearer of [null, await token(), "gct1.e30.AA", "Bearer nonsense"]) {
      const res = await get(h, "/c/collection", bearer);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", code: "unauthorized" });
    }
    expect(h.stores.objects.size).toBe(0);
  });

  it("is a 401 for a token signed under another key — a forged one — or for another group", async () => {
    const { h, bearer } = await stocked();
    const claims = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    const forged = await signToken(await consumerKey(newDataKey()), claims);
    expect((await get(h, "/c/collection", forged)).status).toBe(401);
    await putSettings(h.fetch, ALL_OFF, "g2");
    const elsewhere = await signToken(await consumerKey(newDataKey()), { ...claims, grp: "g2" });
    expect((await get(h, "/c/collection", elsewhere)).status).toBe(401);
    expect((await get(h, "/c/collection", bearer)).status).toBe(200);
  });

  it("is a 401 after a re-mint for the old token, and 200 for the new", async () => {
    const { h, bearer } = await stocked();
    const next = await consumerToken(h.fetch);
    expect((await get(h, "/c/collection", bearer)).status).toBe(401);
    expect((await get(h, "/c/collection", next)).status).toBe(200);
  });

  it("is a 401 past exp", async () => {
    const { h } = await stocked();
    const bearer = await consumerToken(h.fetch, "discord", undefined, { days: 1 });
    const store = h.stores.objectOf("g1").store;
    const call = { op: "folders" } as const;
    expect((await store.consumer("g1", bearer, call, Date.now())).status).toBe(200);
    expect((await store.consumer("g1", bearer, call, Date.now() + 2 * 86_400_000)).status).toBe(
      401,
    );
  });

  it("is a 401 for every token once the store is switched off — and still after it is switched on again", async () => {
    const { h, bearer } = await stocked();
    const mcp = await consumerToken(h.fetch, "mcp");
    expect((await h.fetch(await deviceRequest("DELETE", "/g/g1"))).status).toBe(204);
    expect((await get(h, "/c/collection", bearer)).status).toBe(401);
    expect((await get(h, "/c/decks", mcp)).status).toBe(401);
    // A new store, a new data key: no token of the old one opens it.
    await putSettings(h.fetch, ALL_OFF);
    expect((await get(h, "/c/collection", bearer)).status).toBe(401);
    const listed = await h.fetch(await deviceRequest("GET", "/g/g1/consumers"));
    expect(await listed.json()).toEqual({ consumers: [] });
  });

  it("keeps a token through a KEK rotation: its key is drawn from the data key, which moves with it", async () => {
    const { h, bearer } = await stocked();
    h.env.INTEGRATIONS_KEK_PREVIOUS = KEK;
    h.env.INTEGRATIONS_KEK = NEXT_KEK;
    expect((await get(h, "/c/collection", bearer)).status).toBe(200);
    // And the store did rewrap on that request.
    expect(
      h.stores.objectOf("g1").storage.db.prepare("SELECT value FROM meta WHERE key = 'kek'").get()
        ?.value,
    ).not.toBeUndefined();
    delete h.env.INTEGRATIONS_KEK_PREVIOUS;
    expect((await get(h, "/c/collection", bearer)).status).toBe(200);
  });

  it("opens no /g/ route: a consumer token is not a relay token", async () => {
    const { h, bearer } = await stocked();
    const res = await h.fetch(request("GET", "/g/g1/projection/digests", { bearer }));
    expect(res.status).toBe(401);
  });

  it("answers the method first, before the token", async () => {
    const h = harness();
    const res = await h.fetch(consumerRequest("POST", "/c/collection", null));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    const intents = await h.fetch(consumerRequest("GET", "/c/intents", null));
    expect(intents.status).toBe(405);
    expect(intents.headers.get("allow")).toBe("POST");
  });
});

describe("the scopes", () => {
  it.each([
    ["/c/collection", "wishlist:read"],
    ["/c/wishlist", "collection:read"],
    ["/c/decks", "collection:read"],
    ["/c/decks/d-1", "collection:read"],
    ["/c/folders", "decks:read"],
    ["/c/autocomplete?kind=decks", "collection:read"],
    ["/c/autocomplete?kind=folders", "wishlist:read"],
  ])("%s is a 403 to a token with only %s", async (path, scope) => {
    const { h } = await stocked();
    const narrow = await consumerToken(h.fetch, "mcp", [scope]);
    const res = await get(h, path, narrow);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "scope" });
  });

  it("refuses an add the token may not write, before looking at its payload", async () => {
    const { h } = await stocked();
    const reader = await consumerToken(h.fetch, "mcp", ["collection:read", "wishlist:add"]);
    const res = await postIntent(h.fetch, reader, collectionAdd({ quantity: 1000 }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "scope" });
    expect((await postIntent(h.fetch, reader, wishlistAdd())).status).toBe(200);
  });

  it("gives /c/folders only the lists the token may read", async () => {
    const { h } = await stocked();
    const wishes = await consumerToken(h.fetch, "mcp", ["wishlist:read"]);
    const res = await get(h, "/c/folders", wishes);
    expect(Object.keys((await res.json()) as object)).toEqual(["wishlist"]);
  });
});

describe("the reads", () => {
  it("answers the collection opened, searched by normalised name, by name, with the store's settings", async () => {
    const { h, bearer } = await stocked();
    const all = await rowsOf(h, "/c/collection", bearer);
    expect(all.rows.map((r) => r.uid)).toEqual(["e-3", "e-1", "e-2", "e-4"]);
    expect(all.rows[1]).toEqual(ENTRIES[0]);
    expect(all.more).toBe(false);
    expect(all.fields).toEqual(ALL_OFF);
    expect(all.marketplace).toBe("tcgplayer");
    expect(typeof all.publishedAt).toBe("number");
    const bolt = await rowsOf(h, "/c/collection?q=LIGHTNING", bearer);
    expect(bolt.rows.map((r) => r.uid)).toEqual(["e-1", "e-2"]);
    const vault = await rowsOf(h, "/c/collection?q=lim-dul", bearer);
    expect(vault.rows.map((r) => r.uid)).toEqual(["e-4"]);
    const inFolder = await rowsOf(h, "/c/collection?q=lightning&folder=fold-vault", bearer);
    expect(inFolder.rows.map((r) => r.uid)).toEqual(["e-2"]);
  });

  it("takes a search's % and _ as text, not as wildcards", async () => {
    const { h, bearer } = await stocked();
    expect((await rowsOf(h, "/c/collection?q=%25", bearer)).rows).toEqual([]);
    expect((await rowsOf(h, "/c/collection?q=_", bearer)).rows).toEqual([]);
  });

  it("refuses a search past 100 characters, and a folder that is no uid", async () => {
    const { h, bearer } = await stocked();
    expect((await get(h, `/c/collection?q=${"x".repeat(101)}`, bearer)).status).toBe(400);
    expect((await get(h, "/c/collection?folder=a/b", bearer)).status).toBe(400);
    expect((await get(h, "/c/autocomplete?kind=trades", bearer)).status).toBe(400);
  });

  it("says more when there are more than fifty", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const many = Array.from({ length: 51 }, (_, i) =>
      card(`m-${String(i).padStart(3, "0")}`, `Card ${i}`, "f"),
    );
    await putTable(h.fetch, "collection_entries", documentOf("collection_entries", many));
    const bearer = await consumerToken(h.fetch);
    const body = await rowsOf(h, "/c/collection", bearer);
    expect(body.rows).toHaveLength(50);
    expect(body.more).toBe(true);
  });

  it("answers a table never published with no rows and no publishedAt", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_ON);
    const bearer = await consumerToken(h.fetch);
    const body = await rowsOf(h, "/c/wishlist", bearer);
    expect(body).toMatchObject({ rows: [], more: false, publishedAt: null, fields: ALL_ON });
  });

  it("answers the wishlist, the decks, one deck with its cards, and no_deck", async () => {
    const { h, bearer } = await stocked();
    expect((await rowsOf(h, "/c/wishlist?q=force", bearer)).rows).toEqual(WISHES);
    const decks = (await (await get(h, "/c/decks", bearer)).json()) as {
      decks: unknown[];
      more: boolean;
    };
    expect(decks).toEqual({ decks: DECKS, more: false });
    const burn = await get(h, "/c/decks/d-1", bearer);
    expect(await burn.json()).toEqual({ deck: DECKS[0], cards: [DECK_CARDS[0]] });
    const none = await get(h, "/c/decks/d-9", bearer);
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ code: "no_deck" });
  });

  it("answers both folder lists, locked folders included", async () => {
    const { h, bearer } = await stocked();
    const body = (await (await get(h, "/c/folders", bearer)).json()) as Record<string, unknown[]>;
    expect(body.collection).toHaveLength(3);
    expect(body.wishlist).toEqual([{ uid: "wf-1", name: "Want", parentUid: null }]);
  });

  it("autocompletes distinct card names, decks by uid, and user folders only", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    await putTable(h.fetch, "collection_folders", documentOf("collection_folders", FOLDERS));
    await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [...ENTRIES, card("e-5", "Lightning Bolt", "fold-vault")]),
    );
    await putTable(h.fetch, "decks", documentOf("decks", DECKS));
    const bearer = await consumerToken(h.fetch);
    const choices = async (query: string) =>
      ((await (await get(h, `/c/autocomplete?${query}`, bearer)).json()) as { choices: unknown[] })
        .choices;
    expect(await choices("kind=collection&q=light")).toEqual([
      { name: "Lightning Bolt", value: "Lightning Bolt" },
      { name: "Lightning Helix", value: "Lightning Helix" },
    ]);
    expect(await choices("kind=decks&q=bur")).toEqual([{ name: "Burn", value: "d-1" }]);
    expect(await choices("kind=folders")).toEqual([
      { name: "Trade binder", value: "fold-binder" },
      { name: "Vault", value: "fold-vault" },
    ]);
  });
});

describe("POST /c/intents", () => {
  it("writes a pending intent from the token's integration, and answers it", async () => {
    const { h, bearer } = await stocked();
    const res = await postIntent(h.fetch, bearer, collectionAdd());
    expect(res.status).toBe(200);
    const { intent } = (await res.json()) as { intent: Record<string, unknown> };
    expect(intent).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      group: "g1",
      source: "discord",
      kind: "collection.add",
      payload: collectionAdd().payload,
      createdAt: expect.any(Number),
      confirmedBy: "discord:123",
      state: "pending",
      reason: null,
    });
    const read = await get(h, `/c/intents/${String(intent.id)}`, bearer);
    expect(await read.json()).toEqual({ intent });
  });

  it.each([
    ["one key too many", collectionAdd({ acquiredAt: "2026-01-01" })],
    ["a quantity of 0", collectionAdd({ quantity: 0 })],
    ["a quantity of 100", collectionAdd({ quantity: 100 })],
    ["an unknown kind", { ...collectionAdd(), kind: "collection.remove" }],
    ["a wish naming no card", wishlistAdd({ oracleId: null })],
    ["a body that is not JSON", "not json"],
  ])("refuses %s as bad_intent", async (_label, body) => {
    const { h, bearer } = await stocked();
    const res =
      typeof body === "string"
        ? await h.fetch(request("POST", "/c/intents", { bearer, body }))
        : await postIntent(h.fetch, bearer, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_intent" });
    expect(
      h.stores.objectOf("g1").storage.db.prepare("SELECT count(*) AS n FROM intents").get()?.n,
    ).toBe(0);
  });

  it(`refuses a body past ${MAX_INTENT_BYTES} bytes as intent_too_large, counted and declared`, async () => {
    const { h, bearer } = await stocked();
    const big = collectionAdd({ name: "x".repeat(MAX_INTENT_BYTES) });
    const res = await postIntent(h.fetch, bearer, big);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "intent_too_large" });
    const declared = await h.fetch(
      request("POST", "/c/intents", {
        bearer,
        headers: { "content-length": String(MAX_INTENT_BYTES + 1) },
        body: "{}",
      }),
    );
    expect(declared.status).toBe(413);
  });

  it("answers another integration's intent as no_intent", async () => {
    const { h, bearer } = await stocked();
    const { intent } = (await (await postIntent(h.fetch, bearer, collectionAdd())).json()) as {
      intent: { id: string };
    };
    const mcp = await consumerToken(h.fetch, "mcp");
    const res = await get(h, `/c/intents/${intent.id}`, mcp);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "no_intent" });
  });
});

describe("the overlay", () => {
  async function postAndClaim(h: H, bearer: string, body = collectionAdd()) {
    const { intent } = (await (await postIntent(h.fetch, bearer, body)).json()) as {
      intent: { id: string };
    };
    const claimed = await h.fetch(await deviceRequest("POST", `/g/g1/intents/${intent.id}/claim`));
    const { lease } = (await claimed.json()) as { lease: string };
    return { id: intent.id, lease };
  }

  const ackApplied = async (h: H, id: string, lease: string, hlcMs: number) =>
    h.fetch(
      await deviceRequest("POST", `/g/g1/intents/${id}/ack`, {
        state: "applied",
        reason: null,
        lease,
        hlcMs,
        hlcCtr: 0,
      }),
    );

  it("draws a pending add at once, after the projection's rows, matched by its name hint and folder", async () => {
    const { h, bearer } = await stocked();
    const { id } = await postAndClaim(h, bearer);
    const body = await rowsOf(h, "/c/collection?q=bolt", bearer);
    expect(body.rows.map((r) => r.uid)).toEqual(["e-1", null]);
    expect(body.rows[1]).toEqual({
      uid: null,
      intentId: id,
      state: "pending",
      scryfallId: collectionAdd().payload.scryfallId,
      name: "Lightning Bolt",
      set: "2x2",
      cn: "117",
      finish: "nonfoil",
      quantity: 2,
      folderUid: "fold-binder",
    });
    expect((await rowsOf(h, "/c/collection?q=helix", bearer)).rows.map((r) => r.uid)).toEqual([
      "e-2",
    ]);
    expect(
      (await rowsOf(h, "/c/collection?folder=fold-vault", bearer)).rows.some((r) => r.uid === null),
    ).toBe(false);
    // Never on the other table.
    expect((await rowsOf(h, "/c/wishlist", bearer)).rows.some((r) => r.uid === null)).toBe(false);
  });

  it("draws a wish with its oracle id, on the wishlist", async () => {
    const { h, bearer } = await stocked();
    await postIntent(h.fetch, bearer, wishlistAdd());
    const body = await rowsOf(h, "/c/wishlist?q=counter", bearer);
    expect(body.rows).toEqual([
      expect.objectContaining({
        uid: null,
        oracleId: wishlistAdd().payload.oracleId,
        folderUid: null,
      }),
    ]);
  });

  it("keeps an applied add until a publish of its table at or past the ack's watermark", async () => {
    const { h, bearer } = await stocked();
    const { id, lease } = await postAndClaim(h, bearer);
    expect((await ackApplied(h, id, lease, 2_000)).status).toBe(200);
    const shown = await rowsOf(h, "/c/collection?q=bolt", bearer);
    expect(shown.rows.at(-1)).toMatchObject({ uid: null, intentId: id, state: "applied" });
    // A publish of another table moves nothing.
    await putTable(h.fetch, "decks", documentOf("decks", DECKS), { ms: 3_000 });
    expect((await rowsOf(h, "/c/collection?q=bolt", bearer)).rows.at(-1)).toMatchObject({
      intentId: id,
    });
    // A publish of the collection at the ack's watermark, carrying the add, takes it off.
    const landed = [...ENTRIES, card("e-9", "Lightning Bolt", "fold-binder", 2)];
    await putTable(h.fetch, "collection_entries", documentOf("collection_entries", landed), {
      ms: 2_000,
    });
    const after = await rowsOf(h, "/c/collection?q=bolt", bearer);
    expect(after.rows.map((r) => r.uid)).toEqual(["e-1", "e-9"]);
  });

  it("keeps an applied add on a table never published", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const bearer = await consumerToken(h.fetch);
    const { id, lease } = await postAndClaim(h, bearer);
    await ackApplied(h, id, lease, 1);
    expect((await rowsOf(h, "/c/collection", bearer)).rows).toEqual([
      expect.objectContaining({ intentId: id, state: "applied" }),
    ]);
  });

  it("never draws a refused add", async () => {
    const { h, bearer } = await stocked();
    const { id, lease } = await postAndClaim(h, bearer);
    const res = await h.fetch(
      await deviceRequest("POST", `/g/g1/intents/${id}/ack`, {
        state: "refused",
        reason: "That folder no longer exists.",
        lease,
        hlcMs: null,
        hlcCtr: null,
      }),
    );
    expect(res.status).toBe(200);
    expect((await rowsOf(h, "/c/collection?q=bolt", bearer)).rows.map((r) => r.uid)).toEqual([
      "e-1",
    ]);
    // Its integration reads why.
    const read = (await (await get(h, `/c/intents/${id}`, bearer)).json()) as {
      intent: { state: string; reason: string };
    };
    expect(read.intent).toMatchObject({
      state: "refused",
      reason: "That folder no longer exists.",
    });
  });
});
