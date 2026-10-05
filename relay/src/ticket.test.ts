import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEnvOver, fakeTables } from "./fakeD1";
import { CLIENT, fakeState, SERVER, stubWorkerd } from "./fakeState";
import { Group } from "./group";
import worker, { type Env } from "./index";
import { deviceTag } from "./log";
import { bearerTicket, KEEPALIVE, LIVE_PROTOCOL, selectedProtocol } from "./ticket";
import { mint, TOKEN_TTL_MS } from "./token";

/**
 * The socket a browser can open (light app phase 6): the bearer as a sub-protocol, the origin
 * check CORS does not make, the sub-protocol the 101 selects, and the keepalive the runtime
 * answers.
 *
 * **Three layers, because no one of them can see the whole.** The gate is driven through
 * `worker.fetch` with a recorder for the Durable Object — where the ticket is read, and that it is
 * read for `ws` alone, is half of what it is. The pure functions are tested as functions. And
 * `Group` itself is constructed over a stand-in state, because Node's `Response` refuses a status
 * of 101 and `WebSocketPair` is workerd's: the last `describe` stubs those globals so the real
 * `ws()` and the real constructor run, rather than trusting that two tested helpers are called.
 */

const APP = "https://mtg-grimoire.app";
const KEY = "test-signing-key";

interface Relay {
  env: Env;
  reached: Request[];
}

function relay(): Relay {
  const reached: Request[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (forwarded: Request) => {
        reached.push(forwarded);
        // Not a 101 — Node cannot build one. What the object answers is `Group`'s business,
        // below; here it only has to be recognisably the object's answer and not the gate's.
        return Promise.resolve(new Response("the object answered", { status: 200 }));
      },
    }),
  };
  const env = {
    ...fakeEnvOver(fakeTables({ groups: ["g1"] })),
    RELAY_HMAC_KEY: KEY,
    APP_ORIGINS: APP,
    GROUP: namespace as unknown as DurableObjectNamespace,
  } as Env;
  return { env, reached };
}

function token(group = "g1", key = KEY): Promise<string> {
  return mint({ sub: "sub-0", grp: group, exp: Date.now() + TOKEN_TTL_MS }, key);
}

/** An upgrade request for `g1`'s socket, as a client sends one. */
function upgrade(headers: Record<string, string>): Request {
  return new Request("https://relay.example/g/g1/ws?device=d1", {
    headers: { upgrade: "websocket", connection: "Upgrade", ...headers },
  });
}

/** What a page's `new WebSocket(url, [LIVE_PROTOCOL, "bearer." + access])` puts on the wire. */
function ticket(access: string): Record<string, string> {
  return { "sec-websocket-protocol": `${LIVE_PROTOCOL}, bearer.${access}`, origin: APP };
}

describe("GET /ws, at the gate", () => {
  it("admits a bearer carried as a sub-protocol, and forwards the request as it came", async () => {
    const { env, reached } = relay();
    const access = await token();

    const response = await worker.fetch(upgrade(ticket(access)), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("the object answered");
    expect(reached).toHaveLength(1);
    expect(new URL(reached[0].url).pathname).toBe("/g/g1/ws");
    // The object reads this header to choose what the 101 selects, so it has to arrive.
    expect(reached[0].headers.get("sec-websocket-protocol")).toBe(
      `${LIVE_PROTOCOL}, bearer.${access}`,
    );
    expect(reached[0].headers.get("upgrade")).toBe("websocket");
  });

  it("reads the ticket wherever it stands in the list", async () => {
    const { env, reached } = relay();
    const access = await token();

    const first = await worker.fetch(
      upgrade({ "sec-websocket-protocol": `bearer.${access},${LIVE_PROTOCOL}` }),
      env,
    );
    const alone = await worker.fetch(
      upgrade({ "sec-websocket-protocol": `bearer.${access}` }),
      env,
    );

    expect([first.status, alone.status]).toEqual([200, 200]);
    expect(reached).toHaveLength(2);
  });

  it.each([
    { what: "a token signed with another key", make: () => token("g1", "somebody-else's-key") },
    { what: "a token for another group", make: () => token("g2") },
    { what: "something that is not a token", make: () => Promise.resolve("x") },
    { what: "the prefix with nothing after it", make: () => Promise.resolve("") },
  ])("refuses $what in the sub-protocol with the gate's 401", async ({ make }) => {
    const { env, reached } = relay();

    const response = await worker.fetch(upgrade(ticket(await make())), env);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("unauthorized");
    expect(reached).toEqual([]);

    // The control: the same request with a token that is good.
    expect((await worker.fetch(upgrade(ticket(await token())), env)).status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  it("refuses a socket that offers the protocol and no ticket", async () => {
    const { env, reached } = relay();

    const response = await worker.fetch(upgrade({ "sec-websocket-protocol": LIVE_PROTOCOL }), env);

    expect(response.status).toBe(401);
    expect(reached).toEqual([]);
  });

  it("still takes the header, as every released desktop sends it", async () => {
    const { env, reached } = relay();

    const response = await worker.fetch(upgrade({ authorization: `Bearer ${await token()}` }), env);

    expect(response.status).toBe(200);
    expect(reached).toHaveLength(1);
    // No `Origin`, no sub-protocol: nothing was added to what the desktop sent.
    expect(reached[0].headers.has("sec-websocket-protocol")).toBe(false);
    expect(reached[0].headers.has("origin")).toBe(false);
  });

  it("prefers the header when a request carries both", async () => {
    const { env, reached } = relay();

    const response = await worker.fetch(
      upgrade({
        authorization: `Bearer ${await token()}`,
        "sec-websocket-protocol": `${LIVE_PROTOCOL}, bearer.junk`,
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  it("never dresses the socket's answers for CORS", async () => {
    // A browser enforces nothing about an upgrade's headers, and the 101 could not be rebuilt.
    const { env } = relay();

    const admitted = await worker.fetch(upgrade(ticket(await token())), env);
    const refused = await worker.fetch(upgrade(ticket("x")), env);

    for (const response of [admitted, refused]) {
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      expect(response.headers.has("vary")).toBe(false);
    }
  });
});

describe("GET /ws, and the origin a browser sends with it", () => {
  it.each([
    { from: "a foreign origin", origin: "https://example.com" },
    { from: "a near miss of the app's", origin: `${APP}.evil.example` },
    { from: "an opaque origin", origin: "null" },
  ])("refuses $from with a 403 before the gate and before the object", async ({ origin }) => {
    const { env, reached } = relay();
    const access = await token();

    // A good token, so the 403 can only be the origin's.
    const response = await worker.fetch(upgrade({ ...ticket(access), origin }), env);

    expect(response.status).toBe(403);
    expect(reached).toEqual([]);

    // The control: one header's difference.
    expect((await worker.fetch(upgrade(ticket(access)), env)).status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  it("refuses a foreign origin even when no token came with it", async () => {
    // Before the gate: a 401 here would say the HMAC ran first.
    const { env } = relay();

    const response = await worker.fetch(upgrade({ origin: "https://example.com" }), env);

    expect(response.status).toBe(403);
  });

  it("refuses every origin when the allow-list is unset, and still no device", async () => {
    const { env, reached } = relay();
    delete env.APP_ORIGINS;
    const access = await token();

    const browser = await worker.fetch(upgrade(ticket(access)), env);
    const desktop = await worker.fetch(upgrade({ authorization: `Bearer ${access}` }), env);

    expect(browser.status).toBe(403);
    expect(desktop.status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  it("lets a request with no Origin through to the gate, as it always did", async () => {
    const { env, reached } = relay();
    const access = await token();

    const header = await worker.fetch(upgrade({ authorization: `Bearer ${access}` }), env);
    const subprotocol = await worker.fetch(
      upgrade({ "sec-websocket-protocol": `${LIVE_PROTOCOL}, bearer.${access}` }),
      env,
    );
    const neither = await worker.fetch(upgrade({}), env);

    expect([header.status, subprotocol.status, neither.status]).toEqual([200, 200, 401]);
    expect(reached).toHaveLength(2);
  });
});

describe("the ticket opens the socket and nothing else", () => {
  it.each([
    { method: "GET", path: "/g/g1/pull?since=0&device=d1", body: undefined },
    { method: "POST", path: "/g/g1/push", body: "{}" },
    { method: "POST", path: "/g/g1/ack", body: '{"device":"d1","cursor":1}' },
  ])("$method $path ignores a bearer in the sub-protocol", async ({ method, path, body }) => {
    const { env, reached } = relay();
    const access = await token();
    const ask = (headers: Record<string, string>) =>
      worker.fetch(new Request(`https://relay.example${path}`, { method, headers, body }), env);

    const refused = await ask({ "sec-websocket-protocol": `${LIVE_PROTOCOL}, bearer.${access}` });

    expect(refused.status).toBe(401);
    expect(reached).toEqual([]);

    // The control: the very same token, where these routes do look. A push's `{}` is refused by
    // its admission as a 400, which is past the gate — and not a 401 — all the same.
    const admitted = await ask({ authorization: `Bearer ${access}` });
    expect(admitted.status).not.toBe(401);
  });
});

describe("bearerTicket", () => {
  it("takes the bearer. entry out of a list, in any position and any spacing", () => {
    expect(bearerTicket("grimoire.live.v1, bearer.aaa.bbb")).toBe("aaa.bbb");
    expect(bearerTicket("bearer.aaa.bbb,grimoire.live.v1")).toBe("aaa.bbb");
    expect(bearerTicket("  bearer.aaa.bbb  ")).toBe("aaa.bbb");
  });

  it("is null for no header, no bearer entry, and a bearer entry that is empty", () => {
    expect(bearerTicket(null)).toBeNull();
    expect(bearerTicket("")).toBeNull();
    expect(bearerTicket("grimoire.live.v1")).toBeNull();
    expect(bearerTicket("grimoire.live.v1, bearer.")).toBeNull();
    // A different word, a different case, a token with no prefix: none is a ticket.
    expect(bearerTicket("Bearer.aaa.bbb")).toBeNull();
    expect(bearerTicket("xbearer.aaa.bbb")).toBeNull();
    expect(bearerTicket("aaa.bbb")).toBeNull();
  });

  it("takes the first of two, and never joins them", () => {
    expect(bearerTicket("bearer.first, bearer.second")).toBe("first");
  });

  it("carries every character a minted token can contain, unescaped", async () => {
    // RFC 7230's `token`: what a sub-protocol may be made of, and what a browser's constructor
    // throws a `SyntaxError` outside of.
    const TCHAR = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

    // Subjects of every length from one to six, made of the two characters whose bytes encode to
    // `/` and `+`, so that whatever the payload's alignment some run of them lands on each — and
    // some length leaves the `=` padding base64url drops.
    const unsafe = new Set<string>();
    for (let n = 1; n <= 6; n += 1) {
      const claims = { sub: "?".repeat(n) + ">".repeat(n), grp: "g1", exp: 1, dev: "d1" };
      const access = await mint({ ...claims, exp: Date.now() + TOKEN_TTL_MS }, KEY);

      expect(`bearer.${access}`, claims.sub).toMatch(TCHAR);
      expect(bearerTicket(`${LIVE_PROTOCOL}, bearer.${access}`)).toBe(access);
      for (const char of btoa(JSON.stringify(claims)).match(/[+/=]/g) ?? []) unsafe.add(char);
    }
    // The control, twice over: plain base64 of those same claims does hold all three characters
    // a sub-protocol may not, and the class does refuse them.
    expect([...unsafe].sort()).toEqual(["+", "/", "="]);
    for (const bad of ["a/b", "a=b", "a b", "a,b", 'a"b']) expect(bad).not.toMatch(TCHAR);
  });
});

describe("selectedProtocol", () => {
  it("selects the live protocol when it was offered, wherever it stood", () => {
    expect(selectedProtocol("grimoire.live.v1")).toBe(LIVE_PROTOCOL);
    expect(selectedProtocol("grimoire.live.v1, bearer.aaa.bbb")).toBe(LIVE_PROTOCOL);
    expect(selectedProtocol("bearer.aaa.bbb,grimoire.live.v1")).toBe(LIVE_PROTOCOL);
  });

  it("selects nothing when it was not — and never the bearer", () => {
    expect(selectedProtocol(null)).toBeNull();
    expect(selectedProtocol("")).toBeNull();
    expect(selectedProtocol("bearer.aaa.bbb")).toBeNull();
    expect(selectedProtocol("grimoire.live.v2, bearer.aaa.bbb")).toBeNull();
    expect(selectedProtocol("GRIMOIRE.LIVE.V1")).toBeNull();
    expect(selectedProtocol("xgrimoire.live.v1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// The Durable Object's half, with workerd's globals stood in for
// ---------------------------------------------------------------------------------------

// The stand-in state and the three globals are `fakeState.ts`'s, shared with `group.test.ts`.

describe("Group, over a stand-in for workerd", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers ping → pong with the runtime when it is constructed", () => {
    stubWorkerd();
    const { state, autoResponses } = fakeState();

    new Group(state);

    expect(autoResponses).toEqual([{ request: "ping", response: "pong" }]);
    // The two strings the browser client is written against.
    expect(KEEPALIVE).toEqual({ request: "ping", response: "pong" });
  });

  it("selects grimoire.live.v1 in the 101 for a socket that offered it", async () => {
    stubWorkerd();
    const { state, accepted } = fakeState();

    const response = await new Group(state).fetch(
      upgrade({ "sec-websocket-protocol": `${LIVE_PROTOCOL}, bearer.aaa.bbb` }),
    );

    expect(response.status).toBe(101);
    // The live protocol and nothing else: the bearer is never echoed.
    expect([...response.headers]).toEqual([["sec-websocket-protocol", LIVE_PROTOCOL]]);
    expect(response.webSocket).toBe(CLIENT);
    expect(accepted).toEqual([{ socket: SERVER, tags: [deviceTag("d1")] }]);
  });

  it("answers a socket that offered nothing with the bare 101 it always got", async () => {
    stubWorkerd();
    const { state, accepted } = fakeState();

    const response = await new Group(state).fetch(upgrade({}));

    expect(response.status).toBe(101);
    expect([...response.headers]).toEqual([]);
    expect(response.webSocket).toBe(CLIENT);
    expect(accepted).toEqual([{ socket: SERVER, tags: [deviceTag("d1")] }]);
  });

  it("selects nothing for a socket that offered only a bearer", async () => {
    stubWorkerd();
    const { state } = fakeState();

    const response = await new Group(state).fetch(
      upgrade({ "sec-websocket-protocol": "bearer.aaa.bbb" }),
    );

    expect(response.status).toBe(101);
    expect([...response.headers]).toEqual([]);
  });
});
