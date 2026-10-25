import { describe, expect, it } from "vitest";
import { fakeEnvOver, type Tables } from "@grimoire/relay/src/fakeD1";
import { mint } from "@grimoire/relay/src/token";
import worker, { type Env } from "./index";

/**
 * The web app's origin, on the gated `/g/…` routes (issue #1396's PR 2: the web host refreshes
 * shares from a browser) — driven through `worker.fetch`, as every suite here is.
 *
 * **Two promises, and each case holds one.** A page at `APP_ORIGINS` is answered a pre-flight
 * before the gate and can read every answer, the refusals above all; and a request with no
 * `Origin` — every desktop and Android build — is answered exactly as before this file's Worker
 * learned the word. The public `/s/…` pair is opened by navigating and is left as it was.
 */

const KEY = "test-signing-key";
const APP = "https://mtg-grimoire.app";

/**
 * The share Worker's bindings, over tables that hold one entitled group. R2 throws if touched:
 * nothing here uploads or serves a snapshot.
 */
function corsEnv(options: { origins?: string; dbDown?: boolean } = {}): Env {
  const tables = {
    entitlements: [
      {
        subject: "sub-0",
        source: "patreon",
        external_id: "e0",
        status: "active",
        grace_until: null,
        group_id: "g1",
        refresh_secret: "s0",
        patreon_refresh: null,
        created_at: 0,
        checked_at: 0,
        group_epoch: null,
        group_auth: null,
      },
    ],
    shares: [],
  } as Tables;
  const untouchable = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("R2 was touched");
      },
    },
  );
  return {
    ...fakeEnvOver(tables, { failOn: () => options.dbDown === true }),
    RELAY_HMAC_KEY: KEY,
    SHARE_BASE: "https://share.example",
    APP_ORIGINS: options.origins ?? APP,
    SHARES: untouchable,
  } as unknown as Env;
}

const token = () => mint({ sub: "sub-0", grp: "g1", exp: Date.now() + 60_000 }, KEY);

function asked(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Request {
  return new Request(`https://share.example${path}`, { method, headers, body });
}

const ID = "AAAAAAAAAAAAAAAA";

describe("a page at the web app's origin", () => {
  it.each([
    ["/g/g1/share", "POST", "POST"],
    [`/g/g1/share/${ID}`, "PUT", "PUT, DELETE"],
    [`/g/g1/share/${ID}`, "DELETE", "PUT, DELETE"],
    ["/g/g1/shares", "GET", "GET"],
  ])(
    "is answered a pre-flight for %s (%s), before the gate and the database",
    async (path, method, methods) => {
      // The database throws on any statement: a pre-flight that reached the gate's manifest read
      // would be a 500 here.
      const res = await worker.fetch(
        asked("OPTIONS", path, { origin: APP, "access-control-request-method": method }),
        corsEnv({ dbDown: true }),
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(APP);
      expect(res.headers.get("access-control-allow-methods")).toBe(methods);
      expect(res.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
      expect(res.headers.get("vary")).toBe("Origin");
    },
  );

  it("can read every refusal, and every answer", async () => {
    const env = corsEnv();
    const fromApp = { origin: APP };
    const cases: [Request, number][] = [
      [asked("POST", "/g/g1/share", fromApp, "{}"), 401],
      [asked("GET", "/g/g1/share", fromApp), 405],
      [asked("GET", "/g/g1/bogus", fromApp), 404],
      [asked("GET", `/g/g1/shares/${ID}`, fromApp), 404],
      [asked("GET", "/g/g1/shares", { ...fromApp, authorization: `Bearer ${await token()}` }), 200],
    ];
    for (const [request, status] of cases) {
      const res = await worker.fetch(request, env);
      expect(res.status, request.url).toBe(status);
      expect(res.headers.get("access-control-allow-origin"), request.url).toBe(APP);
      expect(res.headers.get("vary"), request.url).toBe("Origin");
      expect(res.headers.get("content-type"), request.url).toBe("application/json");
    }
  });

  it("is not let in from another origin, and is told nothing it could read", async () => {
    const env = corsEnv();
    const pre = await worker.fetch(
      asked("OPTIONS", "/g/g1/share", {
        origin: "https://example.com",
        "access-control-request-method": "POST",
      }),
      env,
    );
    expect(pre.status).toBe(405);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    const refused = await worker.fetch(
      asked("POST", "/g/g1/share", { origin: "https://example.com" }, "{}"),
      env,
    );
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("is not let in when the Worker names no origin at all", async () => {
    const res = await worker.fetch(
      asked("OPTIONS", "/g/g1/shares", { origin: APP, "access-control-request-method": "GET" }),
      corsEnv({ origins: "" }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("a request with no Origin, which is every native build", () => {
  it.each([
    ["POST", "/g/g1/share", 401, '{"error":"unauthorized"}'],
    ["GET", "/g/g1/share", 405, '{"error":"method not allowed"}'],
    ["GET", "/g/g1/bogus", 404, '{"error":"not found"}'],
  ])("is answered %s %s exactly as before", async (method, path, status, body) => {
    const res = await worker.fetch(
      asked(method, path, {}, method === "POST" ? "{}" : undefined),
      corsEnv(),
    );
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(body);
    const headers = [...res.headers.keys()].sort();
    expect(headers).toEqual(status === 405 ? ["allow", "content-type"] : ["content-type"]);
  });

  it("is still a 405 for an OPTIONS, since no route takes one", async () => {
    const res = await worker.fetch(asked("OPTIONS", "/g/g1/shares"), corsEnv());
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the public pair", () => {
  it("answers a page at the web app's origin as it answers anyone, with no CORS header", async () => {
    const env = corsEnv();
    for (const request of [
      asked("GET", `/s/${ID}`, { origin: APP }),
      asked("GET", `/s/${ID}/0123456789abcdef.json.gz`, { origin: APP }),
      asked("OPTIONS", `/s/${ID}`, { origin: APP, "access-control-request-method": "GET" }),
      asked("GET", "/nothing", { origin: APP }),
    ]) {
      const res = await worker.fetch(request, env);
      expect(res.headers.get("access-control-allow-origin"), request.url).toBeNull();
    }
  });
});
