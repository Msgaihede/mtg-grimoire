import { describe, expect, it } from "vitest";
import wrangler from "../wrangler.jsonc?raw";
import { MAX_PUSH_BODY_CHARS } from "./admit";
import { allowedOrigin, preflight, withCors } from "./cors";
import { fakeEnvOver, fakeTables, type Tables } from "./fakeD1";
import worker, { type Env } from "./index";
import { mint, TOKEN_TTL_MS } from "./token";

/**
 * CORS for the web app (light app phase 6), driven through the router.
 *
 * **Through `worker.fetch`, for `ratelimit.test.ts`'s reason and one more.** What is fenced is
 * *where* the two steps stand — the pre-flight ahead of the limiter, D1 and the object; the header
 * on whatever the router answers — and a suite that called `withCors` on a response of its own
 * making would pass with `index.ts` never calling it. The one more: the promise to every native
 * client is about the bytes the *Worker* sends, so each answer here is asked for twice, without an
 * `Origin` and with one, and the two are compared.
 *
 * **Every absence in this file is asserted beside its presence.** "No `Access-Control-*` header"
 * is what a response looks like when the feature works for the wrong origin and also when it does
 * not exist, so each such test carries a control in which the same request from the allowed origin
 * does get one.
 */

const APP = "https://mtg-grimoire.app";
const FOREIGN = "https://example.com";
const KEY = "test-signing-key";
const IP = "203.0.113.7";
const RV = "0".repeat(32);

/** A database a pre-flight may not reach: reading anything off it throws. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error("D1 was reached by a request that should have been answered before it");
    },
  },
) as unknown as D1Database;

interface Relay {
  env: Env;
  tables: Tables;
  /** Every key any limiter was asked about, in order. */
  limited: string[];
  /** Every request that reached the Durable Object. */
  reached: Request[];
}

/**
 * The Worker's bindings, with a recorder where each thing a pre-flight must not touch would be.
 *
 * `allow` is what every limiter answers. `object` is what the Durable Object answers — a pull's
 * 200 by default, since that is the body a page most needs to be able to read.
 */
function relay(
  options: {
    allow?: boolean;
    origins?: string | null;
    db?: D1Database;
    object?: () => Response;
  } = {},
): Relay {
  const tables = fakeTables({ groups: ["g1"] });
  const limited: string[] = [];
  const reached: Request[] = [];
  const limiter: RateLimit = {
    limit({ key }) {
      limited.push(key);
      return Promise.resolve({ success: options.allow ?? true });
    },
  };
  const object =
    options.object ??
    (() =>
      new Response(JSON.stringify({ envelopes: [], cursor: 7 }), {
        headers: { "content-type": "application/json" },
      }));
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (forwarded: Request) => {
        reached.push(forwarded);
        return Promise.resolve(object());
      },
    }),
  };
  const origins = options.origins === undefined ? APP : options.origins;
  const env = {
    ...fakeEnvOver(tables),
    ...(options.db ? { DB: options.db } : {}),
    RELAY_BASE: "https://relay.example",
    RELAY_HMAC_KEY: KEY,
    PATREON_WEBHOOK_SECRET: "test-webhook-secret",
    PATREON_CLIENT_ID: "client",
    PATREON_CLIENT_SECRET: "secret",
    PATREON_CAMPAIGN_ID: "1",
    RL_CLAIM: limiter,
    RL_MINT: limiter,
    RL_READ: limiter,
    GROUP: namespace as unknown as DurableObjectNamespace,
    ...(origins === null ? {} : { APP_ORIGINS: origins }),
  } as Env;
  return { env, tables, limited, reached };
}

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Request {
  return new Request(`https://relay.example${path}`, {
    method,
    headers: { "cf-connecting-ip": IP, ...headers },
    body,
  });
}

/** A pre-flight, as a browser sends one: no credential, the method it means to use. */
function preflightFor(path: string, method: string, origin: string | null = APP): Request {
  return request("OPTIONS", path, {
    ...(origin === null ? {} : { origin }),
    "access-control-request-method": method,
    "access-control-request-headers": "authorization, content-type",
  });
}

async function bearer(group = "g1"): Promise<string> {
  const token = await mint({ sub: "sub-0", grp: group, exp: Date.now() + TOKEN_TTL_MS }, KEY);
  return `Bearer ${token}`;
}

/** Every header on a response, sorted — so "exactly these" is one comparison. */
function headersOf(response: Response): [string, string][] {
  return [...response.headers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The names of the CORS headers a response carries, `vary` among them. */
function corsHeaders(response: Response): string[] {
  return headersOf(response)
    .map(([name]) => name)
    .filter((name) => name.startsWith("access-control-") || name === "vary");
}

/** The routes a browser may ask, each with the method list its pre-flight must name. */
const CORS_ROUTES = [
  { path: "/claim", methods: "POST" },
  { path: "/token", methods: "POST" },
  { path: `/p/${RV}/offer`, methods: "GET, POST" },
  { path: `/p/${RV}/join`, methods: "GET, POST" },
  { path: "/g/g1/rotate", methods: "POST" },
  { path: "/g/g1/keys", methods: "GET" },
  { path: "/g/g1/push", methods: "POST" },
  { path: "/g/g1/pull", methods: "GET" },
  { path: "/g/g1/ack", methods: "POST" },
] as const;

describe("a pre-flight from the web app", () => {
  it.each(CORS_ROUTES)(
    "OPTIONS $path is a 204 naming the origin, answered before anything is spent",
    async ({ path, methods }) => {
      // Every limiter refuses and D1 throws: a pre-flight that reached either would be a 429 or
      // an exception, not the 204.
      const { env, limited, reached } = relay({ allow: false, db: untouchable });

      const response = await worker.fetch(preflightFor(path, methods.split(", ")[0]), env);

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(headersOf(response)).toEqual([
        ["access-control-allow-headers", "authorization, content-type"],
        ["access-control-allow-methods", methods],
        ["access-control-allow-origin", APP],
        ["access-control-max-age", "86400"],
        ["vary", "Origin"],
      ]);
      expect(limited).toEqual([]);
      expect(reached).toEqual([]);
    },
  );

  it("names the route's own methods, whatever method was asked about", async () => {
    // The browser makes the comparison: a 204 that says `POST` is what refuses a `DELETE`.
    const { env } = relay();

    const response = await worker.fetch(preflightFor("/token", "DELETE"), env);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
  });

  it("offers no credentials and exposes no header", async () => {
    // No route trusts a cookie, and the engine reads no response header — `cors.ts`.
    const { env } = relay();

    const preflighted = await worker.fetch(preflightFor("/token", "POST"), env);
    const answered = await worker.fetch(request("POST", "/token", { origin: APP }, "{}"), env);

    for (const response of [preflighted, answered]) {
      expect(response.headers.get("access-control-allow-origin")).toBe(APP);
      expect(response.headers.has("access-control-allow-credentials")).toBe(false);
      expect(response.headers.has("access-control-expose-headers")).toBe(false);
    }
  });

  it("an OPTIONS that is not a pre-flight goes to the router, and its 405 is readable", async () => {
    // No `Access-Control-Request-Method`: somebody asking what the route allows. It is an
    // ordinary answer to an allowed origin, so it carries the header a page needs to read it.
    const { env, limited } = relay({ allow: false });

    const response = await worker.fetch(request("OPTIONS", "/token", { origin: APP }), env);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    expect(response.headers.has("access-control-allow-methods")).toBe(false);
    expect(limited).toEqual([]);
  });
});

describe("a pre-flight from anywhere else is answered as it always was", () => {
  it.each([
    { from: "a foreign origin", origin: FOREIGN },
    { from: "a near miss of the app's", origin: `${APP}.evil.example` },
    { from: "no origin at all", origin: null },
  ])("OPTIONS /token from $from is the router's 405", async ({ origin }) => {
    const { env, limited } = relay({ allow: false });

    const refused = await worker.fetch(preflightFor("/token", "POST", origin), env);

    expect(refused.status).toBe(405);
    expect(await refused.text()).toBe("method not allowed");
    expect(headersOf(refused)).toEqual([
      ["allow", "POST"],
      ["content-type", "text/plain;charset=UTF-8"],
    ]);
    expect(limited).toEqual([]);

    // The control: the same request, the app's origin, the same bindings.
    const allowed = await worker.fetch(preflightFor("/token", "POST"), env);
    expect(allowed.status).toBe(204);
    expect(corsHeaders(allowed)).not.toEqual([]);
  });

  it.each([
    { path: "/pair", status: 405 },
    { path: "/oauth/patreon/callback", status: 405 },
    { path: "/webhook/patreon", status: 405 },
    { path: "/g/g1/ws", status: 405 },
    { path: "/g/g1/drop", status: 404 },
    { path: "/nonsense", status: 404 },
  ])("OPTIONS $path from the app is still $status: the path takes no CORS", async (route) => {
    const { env } = relay();

    const response = await worker.fetch(preflightFor(route.path, "GET"), env);

    expect(response.status).toBe(route.status);
    expect(corsHeaders(response)).toEqual([]);

    const control = await worker.fetch(preflightFor("/g/g1/pull", "GET"), env);
    expect(control.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------------------
// The answers themselves
// ---------------------------------------------------------------------------------------

/** Five live devices in `g1`, so a sixth meets the cap — `claim.test.ts`'s `seat`. */
function fill(tables: Tables): void {
  const seen = Date.now() - 1000;
  for (const device of ["d1", "d2", "d3", "d4", "d5"]) {
    tables.group_devices.push({
      group_id: "g1",
      device_id: device,
      first_seen: seen,
      last_seen: seen,
    });
  }
}

/** A `group_keys` row for `g1` at `epoch`, so a push at another epoch is refused by admission. */
function keyRow(tables: Tables, epoch: number): void {
  tables.group_keys.push({
    group_id: "g1",
    epoch,
    auth: "a".repeat(64),
    keys: "{}",
    created_at: 0,
  });
}

function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    group: "g1",
    device: "desk",
    epoch: 3,
    hlcMs: Date.now(),
    hlcCtr: 0,
    sealed: "sealed",
    ...over,
  });
}

interface Answer {
  name: string;
  status: number;
  /** Seeds the fake's tables before the request, when the answer depends on a row. */
  seed?: (tables: Tables) => void;
  /** Every limiter refuses. */
  flood?: boolean;
  /** What the Durable Object says, when it is not a pull's 200. */
  object?: () => Response;
  build: (extra: Record<string, string>) => Promise<Request> | Request;
}

/**
 * One of each kind of answer a page has to be able to read: every refusal the contract names, on
 * every side of the gate, and the two that come back from a Durable Object. `status` is pinned so
 * that a row which stopped reaching the refusal it is named for fails here rather than quietly
 * testing some earlier check.
 */
const ANSWERS: Answer[] = [
  {
    name: "400 from /token",
    status: 400,
    build: (extra) => request("POST", "/token", extra, "{}"),
  },
  {
    name: "400 from /claim",
    status: 400,
    build: (extra) => request("POST", "/claim", extra, "{}"),
  },
  {
    name: "401 from /token's refresh door",
    status: 401,
    build: (extra) => request("POST", "/token", extra, '{"refresh":"nobody","device":"d1"}'),
  },
  {
    name: "403 device_limit from /token",
    status: 403,
    seed: fill,
    build: (extra) => request("POST", "/token", extra, '{"refresh":"secret-0","device":"sixth"}'),
  },
  {
    name: "405 from /token",
    status: 405,
    build: (extra) => request("GET", "/token", extra),
  },
  {
    name: "429 from the limiter",
    status: 429,
    flood: true,
    build: (extra) => request("POST", "/token", extra, "{}"),
  },
  {
    name: "404 from an empty rendezvous slot",
    status: 404,
    build: (extra) => request("GET", `/p/${RV}/offer`, extra),
  },
  {
    name: "401 from /rotate",
    status: 401,
    build: (extra) => request("POST", "/g/g1/rotate", extra, "{}"),
  },
  {
    name: "401 from /keys",
    status: 401,
    build: (extra) =>
      request("GET", "/g/g1/keys?device=deadbeef", {
        authorization: `Bearer ${"ab".repeat(32)}`,
        ...extra,
      }),
  },
  {
    name: "401 from the bearer gate",
    status: 401,
    build: (extra) => request("GET", "/g/g1/pull?since=0&device=desk", extra),
  },
  {
    name: "409 stale_epoch from a push's admission",
    status: 409,
    seed: (tables) => keyRow(tables, 3),
    build: async (extra) =>
      request(
        "POST",
        "/g/g1/push",
        { authorization: await bearer(), ...extra },
        envelope({ epoch: 2 }),
      ),
  },
  {
    name: "413 too_large from a push's admission",
    status: 413,
    build: async (extra) =>
      request(
        "POST",
        "/g/g1/push",
        { authorization: await bearer(), ...extra },
        "x".repeat(MAX_PUSH_BODY_CHARS + 1),
      ),
  },
  {
    name: "422 epoch_ahead from a push's admission",
    status: 422,
    seed: (tables) => keyRow(tables, 3),
    build: async (extra) =>
      request(
        "POST",
        "/g/g1/push",
        { authorization: await bearer(), ...extra },
        envelope({ epoch: 4 }),
      ),
  },
  {
    name: "200 from the Durable Object, a pull",
    status: 200,
    build: async (extra) =>
      request("GET", "/g/g1/pull?since=0&device=desk", { authorization: await bearer(), ...extra }),
  },
  {
    name: "507 quota from the Durable Object",
    status: 507,
    object: () =>
      new Response(JSON.stringify({ error: "the group's log is full", code: "quota" }), {
        status: 507,
        headers: { "content-type": "application/json" },
      }),
    build: async (extra) =>
      request("POST", "/g/g1/push", { authorization: await bearer(), ...extra }, envelope()),
  },
  {
    name: "204 from the Durable Object, an ack",
    status: 204,
    object: () => new Response(null, { status: 204 }),
    build: async (extra) =>
      request(
        "POST",
        "/g/g1/ack",
        { authorization: await bearer(), ...extra },
        '{"device":"desk","cursor":1}',
      ),
  },
];

/** One answer, from a relay of its own so no row or limiter carries over between the two asks. */
async function ask(answer: Answer, extra: Record<string, string>): Promise<Response> {
  const { env, tables } = relay({ allow: answer.flood !== true, object: answer.object });
  answer.seed?.(tables);
  return worker.fetch(await answer.build(extra), env);
}

describe("every answer to the web app is readable, and every answer to a device is unchanged", () => {
  it.each(ANSWERS)("$name", async (answer) => {
    const native = await ask(answer, {});
    const browser = await ask(answer, { origin: APP });

    // What a desktop or a phone gets: the status this row is named for and nothing new.
    expect(native.status).toBe(answer.status);
    expect(corsHeaders(native)).toEqual([]);

    // What the page gets: that same answer — status, body, headers — plus the two that let a
    // browser hand it over.
    expect(browser.status).toBe(native.status);
    expect(headersOf(browser)).toEqual(
      [...headersOf(native), ["access-control-allow-origin", APP], ["vary", "Origin"]].sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
      ),
    );
    // A minted token differs between the two asks by nothing: neither of these bodies holds one.
    expect(await browser.text()).toBe(await native.text());
  });

  it("answers a foreign origin exactly as it answers no origin", async () => {
    for (const answer of ANSWERS) {
      const foreign = await ask(answer, { origin: FOREIGN });

      expect(foreign.status, answer.name).toBe(answer.status);
      expect(corsHeaders(foreign), answer.name).toEqual([]);
    }
    // The control: the first of them, from the app.
    expect(corsHeaders(await ask(ANSWERS[0], { origin: APP }))).not.toEqual([]);
  });

  it("hands the page what the Durable Object said, body and all", async () => {
    const { env, reached } = relay();

    const response = await worker.fetch(
      request("GET", "/g/g1/pull?since=0&device=desk", {
        authorization: await bearer(),
        origin: APP,
      }),
      env,
    );

    expect(reached).toHaveLength(1);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    expect(await response.json()).toEqual({ envelopes: [], cursor: 7 });
  });
});

describe("the routes no script asks never take the header", () => {
  it.each([
    { method: "GET", path: "/pair", status: 200 },
    { method: "GET", path: "/oauth/patreon/callback", status: 400 },
    { method: "POST", path: "/webhook/patreon", status: 401 },
    { method: "GET", path: "/nonsense", status: 404 },
  ])(
    "$method $path from the app is $status with nothing added",
    async ({ method, path, status }) => {
      const { env } = relay();
      const body = method === "POST" ? "{}" : undefined;

      const native = await worker.fetch(request(method, path, {}, body), env);
      const browser = await worker.fetch(request(method, path, { origin: APP }, body), env);

      expect(browser.status).toBe(status);
      expect(headersOf(browser)).toEqual(headersOf(native));
      expect(corsHeaders(browser)).toEqual([]);

      // The control, on the same bindings: a route a script does ask.
      const control = await worker.fetch(request("POST", "/token", { origin: APP }, "{}"), env);
      expect(control.headers.get("access-control-allow-origin")).toBe(APP);
    },
  );
});

// ---------------------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------------------

describe("APP_ORIGINS", () => {
  it.each([
    { state: "unset", origins: null },
    { state: "empty", origins: "" },
    { state: "nothing but separators", origins: " , ," },
  ])("$state allows nobody, and throws at nobody", async ({ origins }) => {
    const { env } = relay({ origins });

    const preflighted = await worker.fetch(preflightFor("/token", "POST"), env);
    const answered = await worker.fetch(request("POST", "/token", { origin: APP }, "{}"), env);
    const native = await worker.fetch(request("POST", "/token", {}, "{}"), env);

    expect(preflighted.status).toBe(405);
    expect(corsHeaders(preflighted)).toEqual([]);
    expect(answered.status).toBe(400);
    expect(corsHeaders(answered)).toEqual([]);
    // And a device, which never sent an `Origin`, is answered as ever.
    expect(native.status).toBe(400);
    expect(await native.json()).toEqual({ error: "malformed token request" });

    // The control: the var as shipped, the same two requests.
    const shipped = relay().env;
    expect((await worker.fetch(preflightFor("/token", "POST"), shipped)).status).toBe(204);
    expect(
      corsHeaders(await worker.fetch(request("POST", "/token", { origin: APP }, "{}"), shipped)),
    ).not.toEqual([]);
  });

  it("a var that is not a string allows nobody rather than throwing", () => {
    const env = { APP_ORIGINS: 7 as unknown as string };

    expect(allowedOrigin(request("GET", "/token", { origin: APP }), env)).toBeNull();
  });

  it("matches an origin exactly: no suffix, no prefix, no scheme, no slash, no case", () => {
    const env = { APP_ORIGINS: APP };
    const from = (origin: string) => allowedOrigin(request("GET", "/token", { origin }), env);

    expect(from(APP)).toBe(APP);
    for (const near of [
      `${APP}.evil.example`,
      "https://evil-mtg-grimoire.app",
      "https://sub.mtg-grimoire.app",
      "http://mtg-grimoire.app",
      `${APP}/`,
      `${APP}:443`,
      "https://MTG-GRIMOIRE.app",
      "mtg-grimoire.app",
      "null",
    ]) {
      expect(from(near), near).toBeNull();
    }
    expect(allowedOrigin(request("GET", "/token"), env)).toBeNull();
  });

  it("reads a list, trims it, and answers with the one origin that asked", () => {
    const env = { APP_ORIGINS: ` ${APP} ,https://staging.example ` };
    const from = (origin: string) => allowedOrigin(request("GET", "/token", { origin }), env);

    expect(from(APP)).toBe(APP);
    expect(from("https://staging.example")).toBe("https://staging.example");
    expect(from(`${APP} ,https://staging.example`)).toBeNull();
    expect(from(FOREIGN)).toBeNull();
  });

  it("never takes a wildcard or `null`, as an entry or as an origin", () => {
    const env = { APP_ORIGINS: `*, null, ${APP}` };
    const from = (origin: string) => allowedOrigin(request("GET", "/token", { origin }), env);

    // `Origin: *` is something a script can send and no browser does. Matching the entry would
    // answer `Access-Control-Allow-Origin: *`.
    expect(from("*")).toBeNull();
    // `Origin: null` is every sandboxed frame and every `file:` page there is.
    expect(from("null")).toBeNull();
    expect(from(FOREIGN)).toBeNull();
    expect(from(APP)).toBe(APP);
  });
});

describe("wrangler.jsonc ships the allow-list the web app needs", () => {
  /**
   * A value that drifts — a trailing slash, a second origin added for a test and left — is a
   * deploy that succeeds and a web app that either fails every request or shares its relay with a
   * page nobody meant. The desktop notices neither.
   */
  it("APP_ORIGINS is exactly the web app's origin", () => {
    const declared = [...wrangler.matchAll(/"APP_ORIGINS":\s*"([^"]*)"/g)].map((m) => m[1]);

    expect(declared).toEqual(["https://mtg-grimoire.app"]);
  });

  it("and the code reads that value as that one origin", async () => {
    const shipped = /"APP_ORIGINS":\s*"([^"]*)"/.exec(wrangler)?.[1];
    const { env } = relay({ origins: shipped });

    const allowed = await worker.fetch(
      preflightFor("/token", "POST", "https://mtg-grimoire.app"),
      env,
    );
    const refused = await worker.fetch(preflightFor("/token", "POST", FOREIGN), env);

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://mtg-grimoire.app");
    expect(refused.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------------------
// The two functions, where the router cannot show the difference
// ---------------------------------------------------------------------------------------

describe("preflight", () => {
  it("is null for anything but an OPTIONS carrying Access-Control-Request-Method", () => {
    expect(preflight(request("GET", "/token", { origin: APP }), APP, "POST")).toBeNull();
    expect(preflight(request("OPTIONS", "/token", { origin: APP }), APP, "POST")).toBeNull();
    expect(
      preflight(
        request("POST", "/token", { origin: APP, "access-control-request-method": "POST" }, "{}"),
        APP,
        "POST",
      ),
    ).toBeNull();
    // The control.
    expect(preflight(preflightFor("/token", "POST"), APP, "POST")?.status).toBe(204);
  });
});

describe("withCors", () => {
  /**
   * `Response.redirect` is the one response this runtime builds with **immutable** headers, which
   * is what a response from a Durable Object stub has in workerd and what the router's recorder —
   * an ordinary `new Response` — does not. Without it, a `withCors` that mutated its argument
   * would pass every test above and throw on the first real pull.
   */
  const fromAStub = () => Response.redirect("https://relay.example/elsewhere", 302);

  it("rebuilds a response whose headers cannot be written", () => {
    // The stand-in really is immutable: this is the line the naive implementation dies on.
    expect(() => fromAStub().headers.set("access-control-allow-origin", APP)).toThrow(TypeError);

    const readable = withCors(fromAStub(), APP);

    expect(readable.status).toBe(302);
    expect(headersOf(readable)).toEqual([
      ["access-control-allow-origin", APP],
      ["location", "https://relay.example/elsewhere"],
      ["vary", "Origin"],
    ]);
  });

  it("keeps the status, the body and the headers it was given, and leaves its argument alone", async () => {
    const original = new Response('{"error":"unauthorized"}', {
      status: 401,
      statusText: "Unauthorized",
      headers: { "content-type": "application/json", "retry-after": "60", vary: "Accept" },
    });

    const readable = withCors(original, APP);

    expect(readable.status).toBe(401);
    expect(readable.statusText).toBe("Unauthorized");
    expect(await readable.text()).toBe('{"error":"unauthorized"}');
    expect(headersOf(readable)).toEqual([
      ["access-control-allow-origin", APP],
      ["content-type", "application/json"],
      ["retry-after", "60"],
      // Appended to, not replaced: a handler that varies on something of its own keeps it.
      ["vary", "Accept, Origin"],
    ]);
    expect(original.headers.has("access-control-allow-origin")).toBe(false);
  });
});
