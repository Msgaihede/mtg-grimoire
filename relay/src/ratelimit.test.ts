import { describe, expect, it } from "vitest";
import wrangler from "../wrangler.jsonc?raw";
import { fakeEnv } from "./fakeD1";
import worker, { type Env } from "./index";
import { LIMITS } from "./ratelimit";

/**
 * The rate limits on the five routes a caller can reach with no token (runbook step 8), driven
 * through the router rather than by calling `limited` directly.
 *
 * **Through `worker.fetch`, for `rotate.test.ts`'s reason**: what is being fenced is *where* the
 * check stands — after the method check, ahead of the handler, on these routes and no others —
 * and a suite that called the helper would pass unchanged with every call site deleted.
 */

const IP = "203.0.113.7";
const RV = "0".repeat(32);

interface Recording extends RateLimit {
  keys: string[];
}

/** A limiter that answers one way and remembers every key it was asked about. */
function limiter(success: boolean): Recording {
  const keys: string[] = [];
  return {
    keys,
    limit({ key }) {
      keys.push(key);
      return Promise.resolve({ success });
    },
  };
}

/** A database no refused request may reach: reading anything off it throws. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error("the handler ran: D1 was reached past a refused limit");
    },
  },
) as unknown as D1Database;

type Limiters = { RL_CLAIM: Recording; RL_MINT: Recording; RL_READ: Recording };

function limiters(success: boolean): Limiters {
  return { RL_CLAIM: limiter(success), RL_MINT: limiter(success), RL_READ: limiter(success) };
}

/** The bindings the handlers behind the router read before they refuse a junk request. */
function relayEnv(extra: Partial<Env>): Env {
  return {
    ...fakeEnv("g1"),
    RELAY_BASE: "https://relay.example",
    RELAY_HMAC_KEY: "test-signing-key",
    PATREON_WEBHOOK_SECRET: "test-webhook-secret",
    PATREON_CLIENT_ID: "client",
    PATREON_CLIENT_SECRET: "secret",
    PATREON_CAMPAIGN_ID: "1",
    ...extra,
  };
}

function request(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://relay.example${path}`, {
    method,
    headers: { "cf-connecting-ip": IP, ...headers },
    body: method === "POST" ? "{}" : undefined,
  });
}

const LIMITED = [
  { method: "POST", path: "/claim", binding: "RL_CLAIM", key: `claim:${IP}` },
  { method: "POST", path: "/token", binding: "RL_MINT", key: `token:${IP}` },
  { method: "POST", path: "/g/g1/rotate", binding: "RL_MINT", key: `rotate:${IP}` },
  { method: "GET", path: "/g/g1/keys?device=deadbeef", binding: "RL_READ", key: `keys:${IP}` },
  { method: "GET", path: `/p/${RV}/offer`, binding: "RL_READ", key: `rendezvous:${IP}` },
  { method: "POST", path: `/p/${RV}/join`, binding: "RL_READ", key: `rendezvous:${IP}` },
] as const;

describe("the unauthenticated routes are rate limited", () => {
  it.each(LIMITED)(
    "$method $path past its limit is a 429 that reads nothing",
    async ({ method, path, binding, key }) => {
      const bindings = limiters(false);
      const env = relayEnv({ ...bindings, DB: untouchable });

      const response = await worker.fetch(request(method, path), env);

      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "too many requests", code: "rate_limited" });
      expect(response.headers.get("retry-after")).toBe(String(LIMITS[binding].period));
      // The bucket is the route and the caller, on the binding sized for that route — and no
      // other binding was spent.
      for (const name of ["RL_CLAIM", "RL_MINT", "RL_READ"] as const) {
        expect(bindings[name].keys, name).toEqual(name === binding ? [key] : []);
      }
    },
  );

  it("a request inside its limit reaches the handler", async () => {
    const bindings = limiters(true);

    const response = await worker.fetch(request("POST", "/token"), relayEnv(bindings));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "malformed token request" });
    expect(bindings.RL_MINT.keys).toEqual([`token:${IP}`]);
  });

  it("a request with no client address still has a bucket", async () => {
    const bindings = limiters(false);
    const bare = new Request("https://relay.example/token", { method: "POST", body: "{}" });

    const response = await worker.fetch(bare, relayEnv(bindings));

    expect(response.status).toBe(429);
    expect(bindings.RL_MINT.keys).toEqual(["token:unknown"]);
  });
});

describe("nothing else is rate limited", () => {
  /**
   * Each of these is guarded by something that costs no storage to check — Patreon's code, the
   * webhook's HMAC, the bearer gate — or is a static page, so a limit would only be a second way
   * to refuse a real caller.
   */
  it.each([
    { method: "GET", path: "/oauth/patreon/callback" },
    { method: "POST", path: "/webhook/patreon" },
    { method: "GET", path: "/pair" },
    { method: "GET", path: "/g/g1/pull" },
    { method: "POST", path: "/g/g1/push" },
    { method: "POST", path: "/g/g1/ack" },
    { method: "GET", path: "/nonsense" },
  ])("$method $path asks no limiter", async ({ method, path }) => {
    const bindings = limiters(false);

    const response = await worker.fetch(request(method, path), relayEnv(bindings));

    expect(response.status).not.toBe(429);
    expect([bindings.RL_CLAIM.keys, bindings.RL_MINT.keys, bindings.RL_READ.keys]).toEqual([
      [],
      [],
      [],
    ]);
  });

  it.each([
    { method: "GET", path: "/claim" },
    { method: "GET", path: "/token" },
    { method: "GET", path: "/g/g1/rotate" },
    { method: "POST", path: "/g/g1/keys" },
    { method: "DELETE", path: `/p/${RV}/offer` },
  ])("$method $path is a 405 that spends none of the caller's budget", async ({ method, path }) => {
    const bindings = limiters(false);

    const response = await worker.fetch(request(method, path), relayEnv(bindings));

    expect(response.status).toBe(405);
    expect([bindings.RL_CLAIM.keys, bindings.RL_MINT.keys, bindings.RL_READ.keys]).toEqual([
      [],
      [],
      [],
    ]);
  });
});

describe("a limiter that is not there never takes sync down", () => {
  it("a deploy with no bindings lets the request through", async () => {
    const response = await worker.fetch(request("POST", "/token"), relayEnv({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "malformed token request" });
  });

  it("a binding that throws lets the request through", async () => {
    const broken: RateLimit = {
      limit() {
        return Promise.reject(new Error("the rate limiter is unavailable"));
      },
    };

    const response = await worker.fetch(
      request("POST", "/token"),
      relayEnv({ RL_CLAIM: broken, RL_MINT: broken, RL_READ: broken }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "malformed token request" });
  });
});

describe("wrangler.jsonc declares the bindings the code asks for", () => {
  /**
   * A binding the config misnames is `undefined` at runtime, which is the fail-open arm above:
   * the deploy would succeed, every probe would answer, and nothing would be limited.
   */
  it.each(Object.entries(LIMITS))("%s, at the limit the code documents", (name, { limit, period }) => {
    const declared = new RegExp(
      `"name":\\s*"${name}",\\s*"namespace_id":\\s*"\\d+",\\s*` +
        `"simple":\\s*\\{\\s*"limit":\\s*${limit},\\s*"period":\\s*${period}\\s*\\}`,
    );
    expect(wrangler).toMatch(declared);
  });

  it("gives each binding a namespace of its own", () => {
    const ids = [...wrangler.matchAll(/"namespace_id":\s*"(\d+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(Object.keys(LIMITS).length);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
