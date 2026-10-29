import { describe, expect, it } from "vitest";
import { mint } from "@grimoire/relay/src/token";
import { APP, harness, KEK, mintedAt, request, token } from "./fake";

/**
 * The router's table (plan §3.2), driven through `worker.fetch` and never through a handler — for
 * the share Worker's reason: where a route stands relative to the door is half of what this
 * Worker is, and a suite that called the handlers would pass with the door deleted.
 *
 * **Every refusal here is asserted over a namespace that records**: a request the door turns away
 * must not have reached a group's object at all, so each case ends by counting the objects made.
 */

const ROUTES = [
  ["GET", "/g/g1/projection/digests"],
  ["PUT", "/g/g1/settings"],
  ["PUT", "/g/g1/projection/collection_entries"],
  ["DELETE", "/g/g1"],
  ["GET", "/g/g1/intents"],
  ["POST", `/g/g1/intents/${"A".repeat(22)}/claim`],
  ["POST", `/g/g1/intents/${"A".repeat(22)}/ack`],
  ["GET", "/g/g1/consumers"],
] as const;

/** The one device route that takes two methods: a mint and a revoke, at one integration's path. */
const TWO_METHODS = [
  ["POST", "/g/g1/consumers/discord"],
  ["DELETE", "/g/g1/consumers/mcp"],
] as const;

describe("a path that is no route", () => {
  it.each([
    "/",
    "/g/g1/projection",
    "/g/g1/projection/digests/x",
    "/g/g1/projection/trades",
    "/g/g1/projection/collection_entries/u-1",
    "/g/g1/shares",
    "/g/%41/settings",
    "/g/a.b/settings",
    `/g/${"a".repeat(129)}/settings`,
    "/g//settings",
    "/g/g1/intents/short/claim",
    `/g/g1/intents/${"A".repeat(22)}`,
    `/g/g1/intents/${"A".repeat(22)}/apply`,
    "/g/g1/consumers/trade",
    "/g/g1/consumers/discord/x",
    "/c",
    "/c/trades",
    "/c/decks/a/b",
    "/c/intents/short",
  ])("%s is a JSON 404 that reaches no object", async (path) => {
    const h = harness();
    const res = await h.fetch(request("PUT", path, { bearer: await token() }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
    expect(h.stores.objects.size).toBe(0);
  });

  it("is every one of the six tables, and only those", async () => {
    const h = harness();
    for (const table of [
      "collection_folders",
      "collection_entries",
      "wishlist_folders",
      "wishlist_entries",
      "decks",
      "deck_cards",
    ]) {
      const res = await h.fetch(request("GET", `/g/g1/projection/${table}`));
      // The route exists — so the wrong method is a 405, not a 404.
      expect(res.status, table).toBe(405);
    }
  });
});

describe("the method", () => {
  it.each([
    ["POST", "/g/g1/projection/digests", "GET"],
    ["GET", "/g/g1/settings", "PUT"],
    ["POST", "/g/g1/settings", "PUT"],
    ["GET", "/g/g1/projection/decks", "PUT"],
    ["DELETE", "/g/g1/projection/decks", "PUT"],
    ["GET", "/g/g1", "DELETE"],
    ["PUT", "/g/g1", "DELETE"],
    ["POST", "/g/g1/intents", "GET"],
    ["GET", `/g/g1/intents/${"A".repeat(22)}/claim`, "POST"],
    ["PUT", `/g/g1/intents/${"A".repeat(22)}/ack`, "POST"],
    ["DELETE", "/g/g1/consumers", "GET"],
    ["GET", "/g/g1/consumers/discord", "POST, DELETE"],
    ["PUT", "/c/wishlist", "GET"],
    ["DELETE", "/c/intents", "POST"],
  ])("%s %s is a 405 naming %s, before the door is asked", async (method, path, allow) => {
    const h = harness();
    // No bearer at all: a 401 here would mean the door was asked first.
    const res = await h.fetch(request(method, path, { bearer: null }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe(allow);
    expect(await res.json()).toEqual({ error: "method not allowed", code: "method_not_allowed" });
    expect(h.stores.objects.size).toBe(0);
  });
});

describe("the door", () => {
  it.each(ROUTES)("%s %s is a 401 with no token", async (method, path) => {
    const h = harness();
    const res = await h.fetch(request(method, path, { bearer: null }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "unauthorized" });
    expect(h.stores.objects.size).toBe(0);
  });

  it.each(ROUTES)("%s %s is a 401 to a token signed with another key", async (method, path) => {
    const h = harness();
    const forged = await mint({ sub: "sub-1", grp: "g1", exp: Date.now() + 60_000 }, "not-the-key");
    expect((await h.fetch(request(method, path, { bearer: forged }))).status).toBe(401);
    expect((await h.fetch(request(method, path, { bearer: "nonsense" }))).status).toBe(401);
    expect(h.stores.objects.size).toBe(0);
  });

  it.each(ROUTES)("%s %s is a 401 to an expired token", async (method, path) => {
    const h = harness();
    const stale = await token("g1", { exp: Date.now() - 1 });
    expect((await h.fetch(request(method, path, { bearer: stale }))).status).toBe(401);
    expect(h.stores.objects.size).toBe(0);
  });

  /**
   * Not redundant with the signature: a validly signed token for the caller's own group is
   * exactly what an attacker holds. Without the comparison it would open every group's store.
   */
  it.each(ROUTES)("%s %s is a 401 to a valid token for another group", async (method, path) => {
    const h = harness();
    expect((await h.fetch(request(method, path, { bearer: await token("g2") }))).status).toBe(401);
    expect(h.stores.objects.size).toBe(0);
  });

  it.each(TWO_METHODS)("%s %s is behind the door too", async (method, path) => {
    const h = harness();
    expect((await h.fetch(request(method, path, { bearer: null }))).status).toBe(401);
    expect((await h.fetch(request(method, path, { bearer: await token("g2") }))).status).toBe(401);
    expect(h.stores.objects.size).toBe(0);
  });

  it("lets a valid token for the group through, to the store", async () => {
    const h = harness();
    const res = await h.fetch(
      request("GET", "/g/g1/projection/digests", { bearer: await token() }),
    );
    // Through the door, to a group with no store: the store's own answer.
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("no_store");
  });

  /**
   * A device the group has removed (issue #548, the share Worker's case): its token is validly
   * signed and unexpired for up to a day, and the store is the group's whole collection. The
   * newest manifest names the devices that stayed; a token minted before it, for a device it
   * does not name, is refused.
   */
  describe("for a device the group has removed", () => {
    const STAYED = "aa".repeat(16);
    const REMOVED = "bb".repeat(16);

    function rotated() {
      const h = harness();
      const rotatedAt = Date.now() - 60_000;
      const insert = h.db.prepare(
        "INSERT INTO group_keys (group_id, epoch, auth, keys, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      insert.run("g1", 1, "a1", JSON.stringify({ [STAYED]: "b", [REMOVED]: "b" }), rotatedAt - 1);
      insert.run("g1", 2, "a2", JSON.stringify({ [STAYED]: "b" }), rotatedAt);
      return { h, rotatedAt };
    }

    it.each(ROUTES)("%s %s refuses the token it held from before", async (method, path) => {
      const { h, rotatedAt } = rotated();
      const stale = await mintedAt(rotatedAt - 1_000, REMOVED);
      expect((await h.fetch(request(method, path, { bearer: stale }))).status).toBe(401);
      expect(h.stores.objects.size).toBe(0);
    });

    it("goes on letting in the device that stayed", async () => {
      const { h, rotatedAt } = rotated();
      const kept = await mintedAt(rotatedAt - 1_000, STAYED);
      const res = await h.fetch(request("GET", "/g/g1/projection/digests", { bearer: kept }));
      expect(res.status).toBe(404);
    });
  });
});

describe("a Worker missing a secret", () => {
  it("throws naming INTEGRATIONS_KEK, before the door, on every route", async () => {
    for (const kek of [undefined, "", "c2hvcnQ"]) {
      const h = harness();
      (h.env as { INTEGRATIONS_KEK?: string }).INTEGRATIONS_KEK = kek;
      for (const [method, path] of ROUTES) {
        // With no token at all: a deploy without its KEK is visible to the README's check.
        await expect(h.fetch(request(method, path, { bearer: null }))).rejects.toThrow(
          /INTEGRATIONS_KEK/,
        );
      }
      expect(h.stores.objects.size).toBe(0);
    }
  });

  it("throws naming RELAY_HMAC_KEY when a bearer arrives and there is no key to check it", async () => {
    const h = harness();
    (h.env as { RELAY_HMAC_KEY?: string }).RELAY_HMAC_KEY = undefined;
    await expect(
      h.fetch(request("GET", "/g/g1/projection/digests", { bearer: "nonsense" })),
    ).rejects.toThrow("the integrations Worker is missing its RELAY_HMAC_KEY binding");
    // And with no bearer there is nothing to verify: the door is simply shut.
    expect((await h.fetch(request("GET", "/g/g1/projection/digests"))).status).toBe(401);
    expect(h.env.INTEGRATIONS_KEK).toBe(KEK);
  });
});

describe("a page at the web app's origin", () => {
  const preflight = (path: string, method: string, origin = APP) =>
    request("OPTIONS", path, {
      headers: { origin, "access-control-request-method": method },
    });

  it.each(ROUTES)("is answered a pre-flight for %s %s, before the door", async (method, path) => {
    const h = harness();
    const res = await h.fetch(preflight(path, method));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("access-control-allow-methods")).toBe(method);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").split(", ");
    expect(allowed.sort()).toEqual(
      [
        "authorization",
        "content-type",
        "x-projection-digest",
        "x-projection-hlc-ctr",
        "x-projection-hlc-ms",
      ].sort(),
    );
    expect(res.headers.get("vary")).toBe("Origin");
    expect(h.stores.objects.size).toBe(0);
  });

  it("is told both methods of the route that takes two", async () => {
    const h = harness();
    const res = await h.fetch(preflight("/g/g1/consumers/discord", "DELETE"));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, DELETE");
  });

  it("can read every refusal, and every answer", async () => {
    const h = harness();
    const asked = (init: { bearer?: string | null }) =>
      request("GET", "/g/g1/projection/digests", { ...init, headers: { origin: APP } });
    const refused = await h.fetch(asked({ bearer: null }));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe(APP);
    const off = await h.fetch(asked({ bearer: await token() }));
    expect(off.status).toBe(404);
    expect(off.headers.get("access-control-allow-origin")).toBe(APP);
    const wrong = await h.fetch(request("POST", "/g/g1/settings", { headers: { origin: APP } }));
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("access-control-allow-origin")).toBe(APP);
  });

  it("is not let in from another origin, and is told nothing it could read", async () => {
    const h = harness();
    const res = await h.fetch(preflight("/g/g1/projection/digests", "GET", "https://example.com"));
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const refused = await h.fetch(
      request("GET", "/g/g1/projection/digests", { headers: { origin: "https://example.com" } }),
    );
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("changes nothing for a request with no Origin, which is every native build", async () => {
    const h = harness();
    const res = await h.fetch(request("GET", "/g/g1/projection/digests"));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    expect([...res.headers.keys()].sort()).toEqual(["content-type"]);
  });

  it("is given no CORS header on a path that is no route", async () => {
    const h = harness();
    const res = await h.fetch(request("GET", "/nothing", { headers: { origin: APP } }));
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
