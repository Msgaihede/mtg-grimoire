import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnvOver, fakeTables } from "./fakeD1";
import {
  FakeClient,
  fakeLobbies,
  stubLobbyWorkerd,
  type FakeLobbies,
  type FakeSocket,
} from "./fakeLobby";
import worker, { type Env } from "./index";
import {
  CLOSE,
  drawCode,
  LOBBY_ALPHABET,
  LOBBY_TTL_MS,
  lobbyCode,
  MAX_FRAME_BYTES,
  parseJoin,
} from "./lobby";
import { mint, TOKEN_TTL_MS } from "./token";

/**
 * Lobbies for pod drafts (draft & packs spec §6), driven through `worker.fetch` into real `Lobby`
 * objects over `fakeLobby.ts` — so where each refusal stands (ahead of the object or inside it)
 * is asserted along with what it says, and every frame a client would read is read off the
 * socket the object sent it down.
 */

const KEY = "test-signing-key";
const APP = "https://mtg-grimoire.app";
const IP = "203.0.113.9";

interface Recording extends RateLimit {
  keys: string[];
}

function limiter(success = true): Recording {
  const keys: string[] = [];
  return {
    keys,
    limit({ key }) {
      keys.push(key);
      return Promise.resolve({ success });
    },
  };
}

interface Relay {
  env: Env;
  lobbies: FakeLobbies;
  mint: Recording;
  read: Recording;
}

function relay(limits: { mint?: boolean; read?: boolean } = {}): Relay {
  const lobbies = fakeLobbies();
  const mintLimit = limiter(limits.mint ?? true);
  const readLimit = limiter(limits.read ?? true);
  const env = {
    ...fakeEnvOver(fakeTables({ groups: ["g1"] })),
    RELAY_HMAC_KEY: KEY,
    APP_ORIGINS: APP,
    LOBBY: lobbies.namespace,
    RL_MINT: mintLimit,
    RL_READ: readLimit,
  } as Env;
  return { env, lobbies, mint: mintLimit, read: readLimit };
}

function bearer(key = KEY, exp = Date.now() + TOKEN_TTL_MS): Promise<string> {
  return mint({ sub: "sub-0", grp: "g1", exp, dev: "d1" }, key);
}

async function create(r: Relay, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": IP };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request("https://relay.example/lobby", { method: "POST", headers }),
    r.env,
  );
}

interface Created {
  code: string;
  hostKey: string;
  expiresAt: number;
}

async function created(r: Relay): Promise<Created> {
  const response = await create(r, await bearer());
  expect(response.status).toBe(201);
  return response.json();
}

function socketRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://relay.example${path}`, {
    headers: { upgrade: "websocket", connection: "Upgrade", "cf-connecting-ip": IP, ...headers },
  });
}

/** Open a socket and hand back the server end the object holds, or the refusal. */
async function connect(r: Relay, code: string, query: string): Promise<FakeSocket> {
  const response = await worker.fetch(socketRequest(`/lobby/${code}/ws?${query}`), r.env);
  expect(response.status).toBe(101);
  const client = response.webSocket as unknown as FakeClient;
  expect(client).toBeInstanceOf(FakeClient);
  return client.server;
}

const host = (r: Relay, lobby: Created) => connect(r, lobby.code, `role=host&key=${lobby.hostKey}`);
const guest = (r: Relay, lobby: Created, name: string, rejoin?: string) =>
  connect(
    r,
    lobby.code,
    `role=guest&name=${encodeURIComponent(name)}${rejoin ? `&rejoin=${rejoin}` : ""}`,
  );

/** The client sends a frame: what the runtime hands the object. */
async function say(r: Relay, lobby: Created, ws: FakeSocket, frame: unknown): Promise<void> {
  const text = typeof frame === "string" ? frame : JSON.stringify(frame);
  await r.lobbies.at(lobby.code).lobby.webSocketMessage(ws as unknown as WebSocket, text);
}

/** The client's connection goes, and the runtime tells the object. */
async function drop(r: Relay, lobby: Created, ws: FakeSocket): Promise<void> {
  ws.disconnected = true;
  ws.readyState = 3;
  await r.lobbies.at(lobby.code).lobby.webSocketClose(ws as unknown as WebSocket);
}

interface Welcome {
  t: "welcome";
  peer: string;
  secret: string;
  hostOnline: boolean;
}

function welcome(ws: FakeSocket): Welcome {
  const frame = ws.frames[0] as Welcome;
  expect(frame.t).toBe("welcome");
  return frame;
}

beforeEach(() => {
  stubLobbyWorkerd();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("codes", () => {
  it("are six characters of the alphabet, drawn at random", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const code = drawCode();
      expect(code).toMatch(new RegExp(`^[${LOBBY_ALPHABET}]{6}$`));
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(495);
    expect(LOBBY_ALPHABET).toBe("ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  });

  it("are read upper-cased, and nothing else is forgiven", () => {
    expect(lobbyCode("k7qx2m")).toBe("K7QX2M");
    expect(lobbyCode("K7QX2M")).toBe("K7QX2M");
    for (const junk of ["K7QX2", "K7QX2MM", "K7QX0M", "K7QXIM", "K7QX2%", "", "K7QX2M/x"]) {
      expect(lobbyCode(junk), junk).toBeNull();
    }
  });
});

describe("POST /lobby", () => {
  it("is refused without a bearer, with a bad one and with an expired one, reaching no object", async () => {
    const r = relay();
    expect((await create(r)).status).toBe(401);
    expect((await create(r, await bearer("another-key"))).status).toBe(401);
    expect((await create(r, await bearer(KEY, Date.now() - 1))).status).toBe(401);
    expect((await create(r, "not.a-token")).status).toBe(401);
    expect(r.lobbies.asked).toEqual([]);
    // Refused before the limiter, so junk spends nobody's budget.
    expect(r.mint.keys).toEqual([]);
  });

  it("is a 405 to any other method", async () => {
    const r = relay();
    const response = await worker.fetch(new Request("https://relay.example/lobby"), r.env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("answers 201 with a code, a host key and the expiry six hours on", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const r = relay();

    const lobby = await created(r);

    expect(lobby.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(lobby.hostKey).toMatch(/^[0-9a-f]{32}$/);
    expect(lobby.expiresAt).toBe(1_800_000_000_000 + LOBBY_TTL_MS);
    expect(r.mint.keys).toEqual([`lobby:${IP}`]);

    const { fake } = r.lobbies.at(lobby.code);
    expect(fake.alarm()).toBe(lobby.expiresAt);
    // The key itself is never stored — only its hash.
    expect(JSON.stringify([...fake.store.values()])).not.toContain(lobby.hostKey);
  });

  it("is a 429 past its limit, and makes no lobby", async () => {
    const r = relay({ mint: false });
    const response = await create(r, await bearer());
    expect(response.status).toBe(429);
    expect(r.lobbies.asked).toEqual([]);
  });

  it("draws another code when the first is live", async () => {
    const r = relay();
    const first = await created(r);
    const draws = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementationOnce((bytes) => bytes) // the host key
      .mockImplementationOnce((bytes) => {
        // The first draw names the live lobby's code again.
        const array = bytes as Uint8Array;
        [...first.code].forEach((char, i) => (array[i] = LOBBY_ALPHABET.indexOf(char)));
        return bytes;
      });

    const second = await created(r);

    draws.mockRestore();
    expect(second.code).not.toBe(first.code);
    expect(r.lobbies.asked.slice(-2)).toEqual([first.code, second.code]);
  });
});

describe("GET /lobby/{code}/ws, ahead of the object", () => {
  it.each([
    ["a code of the wrong shape", "/lobby/K7QX0M/ws?role=guest&name=Ada", {}, 404],
    ["a code too short", "/lobby/K7Q/ws?role=guest&name=Ada", {}, 404],
    [
      "a foreign origin",
      "/lobby/K7QX2M/ws?role=guest&name=Ada",
      { origin: "https://evil.example" },
      403,
    ],
    ["no role", "/lobby/K7QX2M/ws?name=Ada", {}, 400],
    ["an empty name", "/lobby/K7QX2M/ws?role=guest&name=%20%20", {}, 400],
    ["a name too long", `/lobby/K7QX2M/ws?role=guest&name=${"a".repeat(25)}`, {}, 400],
    ["a malformed rejoin", "/lobby/K7QX2M/ws?role=guest&name=Ada&rejoin=p1", {}, 400],
    ["a host key of the wrong shape", "/lobby/K7QX2M/ws?role=host&key=abc", {}, 403],
  ])("%s is refused without touching the object", async (_what, path, headers, status) => {
    const r = relay();
    const response = await worker.fetch(socketRequest(path, headers), r.env);
    expect(response.status).toBe(status);
    expect(r.lobbies.asked).toEqual([]);
    expect(r.read.keys).toEqual([]);
  });

  it("is a 426 without an upgrade, and a 405 to a POST", async () => {
    const r = relay();
    const plain = new Request("https://relay.example/lobby/K7QX2M/ws?role=guest&name=Ada");
    expect((await worker.fetch(plain, r.env)).status).toBe(426);
    const post = new Request("https://relay.example/lobby/K7QX2M/ws", { method: "POST" });
    expect((await worker.fetch(post, r.env)).status).toBe(405);
    expect(r.lobbies.asked).toEqual([]);
  });

  it("is a 429 past its limit", async () => {
    const r = relay({ read: false });
    const response = await worker.fetch(
      socketRequest("/lobby/K7QX2M/ws?role=guest&name=Ada"),
      r.env,
    );
    expect(response.status).toBe(429);
    expect(r.read.keys).toEqual([`lobbySocket:${IP}`]);
    expect(r.lobbies.asked).toEqual([]);
  });

  it("is a 404 from the object for a code that is not live", async () => {
    const r = relay();
    const response = await worker.fetch(
      socketRequest("/lobby/K7QX2M/ws?role=guest&name=Ada"),
      r.env,
    );
    expect(response.status).toBe(404);
    expect(r.lobbies.asked).toEqual(["K7QX2M"]);
  });

  it("lets the web app's origin and a native client's absent one through", async () => {
    const r = relay();
    const lobby = await created(r);
    const path = `/lobby/${lobby.code}/ws?role=guest&name=Ada`;
    expect((await worker.fetch(socketRequest(path, { origin: APP }), r.env)).status).toBe(101);
    expect((await worker.fetch(socketRequest(path), r.env)).status).toBe(101);
  });

  it("reaches the same lobby by a code typed in lower case", async () => {
    const r = relay();
    const lobby = await created(r);
    const ws = await connect(r, lobby.code.toLowerCase(), "role=guest&name=Ada");
    expect(welcome(ws).peer).toBe("p1");
  });
});

describe("the host", () => {
  it("is refused with a wrong key before any upgrade", async () => {
    const r = relay();
    const lobby = await created(r);
    const response = await worker.fetch(
      socketRequest(`/lobby/${lobby.code}/ws?role=host&key=${"0".repeat(32)}`),
      r.env,
    );
    expect(response.status).toBe(403);
    expect(r.lobbies.at(lobby.code).fake.accepted).toEqual([]);
  });

  it("is told the roster on connect, and guests are told it came", async () => {
    const r = relay();
    const lobby = await created(r);
    const ada = await guest(r, lobby, "Ada");
    expect(welcome(ada).hostOnline).toBe(false);
    ada.take();

    const h = await host(r, lobby);

    expect(h.tags).toEqual(["host"]);
    expect(h.take()).toEqual([{ t: "peers", peers: [{ peer: "p1", name: "Ada", online: true }] }]);
    expect(ada.take()).toEqual([{ t: "host", online: true }]);
  });

  it("a second host socket replaces the first with 4005, and nobody hears it go", async () => {
    const r = relay();
    const lobby = await created(r);
    const first = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    ada.take();

    const second = await host(r, lobby);
    expect(first.closed).toEqual({ code: CLOSE.replaced, reason: "replaced" });
    await drop(r, lobby, first);

    expect(second.readyState).toBe(1);
    expect(ada.take()).toEqual([]);
  });

  it("going is told to every guest, and a guest's message then goes nowhere", async () => {
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    ada.take();

    await drop(r, lobby, h);
    expect(ada.take()).toEqual([{ t: "host", online: false }]);

    await say(r, lobby, ada, { t: "msg", body: { v: 1, kind: "sync" } });
    const back = await host(r, lobby);
    expect(back.take()).toEqual([
      { t: "peers", peers: [{ peer: "p1", name: "Ada", online: true }] },
    ]);
  });
});

describe("guests", () => {
  it("are welcomed with a peer id and a secret, and the host sees each join", async () => {
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    h.take();

    const ada = await guest(r, lobby, "  Ada  ");
    const bo = await guest(r, lobby, "Bo");

    expect(welcome(ada)).toEqual({
      t: "welcome",
      peer: "p1",
      secret: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
      hostOnline: true,
    });
    expect(welcome(bo).peer).toBe("p2");
    expect(welcome(bo).secret).not.toBe(welcome(ada).secret);
    expect(h.take()).toEqual([
      { t: "peers", peers: [{ peer: "p1", name: "Ada", online: true }] },
      {
        t: "peers",
        peers: [
          { peer: "p1", name: "Ada", online: true },
          { peer: "p2", name: "Bo", online: true },
        ],
      },
    ]);
  });

  it("stay on the roster offline when they go, and rejoin with their secret", async () => {
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    const { peer, secret } = welcome(ada);
    h.take();

    await drop(r, lobby, ada);
    expect(h.take()).toEqual([{ t: "peers", peers: [{ peer: "p1", name: "Ada", online: false }] }]);

    const back = await guest(r, lobby, "Ada", `${peer}.${secret}`);
    expect(welcome(back)).toEqual({ t: "welcome", peer: "p1", secret, hostOnline: true });
    expect(h.take()).toEqual([{ t: "peers", peers: [{ peer: "p1", name: "Ada", online: true }] }]);
  });

  it("a rejoin while still connected replaces the older socket with 4005", async () => {
    const r = relay();
    const lobby = await created(r);
    const ada = await guest(r, lobby, "Ada");
    const { peer, secret } = welcome(ada);

    const again = await guest(r, lobby, "Ada", `${peer}.${secret}`);

    expect(ada.closed).toEqual({ code: CLOSE.replaced, reason: "replaced" });
    expect(welcome(again).peer).toBe("p1");
  });

  it("a rejoin with the wrong secret is a fresh seat, never the one it names", async () => {
    const r = relay();
    const lobby = await created(r);
    await guest(r, lobby, "Ada");

    const thief = await guest(r, lobby, "Eve", `p1.${"0".repeat(32)}`);

    expect(welcome(thief).peer).toBe("p2");
  });

  it("are refused with 4004 past seven, offline guests counting", async () => {
    const r = relay();
    const lobby = await created(r);
    const seven: FakeSocket[] = [];
    for (let i = 1; i <= 7; i += 1) seven.push(await guest(r, lobby, `G${i}`));
    await drop(r, lobby, seven[0]);

    const eighth = await guest(r, lobby, "Late");

    expect(eighth.closed).toEqual({ code: CLOSE.full, reason: "full" });
    expect(eighth.frames).toEqual([]);
  });
});

describe("frames", () => {
  it("a guest's msg reaches the host with its from", async () => {
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    h.take();

    await say(r, lobby, ada, { t: "msg", body: { v: 1, kind: "pick", ids: ["a"] } });

    expect(h.take()).toEqual([{ t: "msg", from: "p1", body: { v: 1, kind: "pick", ids: ["a"] } }]);
  });

  it("the host sends to one guest, or to every guest with *", async () => {
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    const bo = await guest(r, lobby, "Bo");
    ada.take();
    bo.take();

    await say(r, lobby, h, { t: "send", to: "p2", body: { v: 1, kind: "view" } });
    expect(ada.take()).toEqual([]);
    expect(bo.take()).toEqual([{ t: "msg", body: { v: 1, kind: "view" } }]);

    await say(r, lobby, h, { t: "send", to: "*", body: { v: 1, kind: "room" } });
    expect(ada.take()).toEqual([{ t: "msg", body: { v: 1, kind: "room" } }]);
    expect(bo.take()).toEqual([{ t: "msg", body: { v: 1, kind: "room" } }]);
  });

  it("ignores junk: not JSON, not an object, an unknown t, binary, a guest's send", async () => {
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    h.take();
    ada.take();

    for (const junk of ["not json", "[1]", "42", '{"t":"dance"}', '{"body":1}', '{"t":"msg"}']) {
      await say(r, lobby, ada, junk);
      await say(r, lobby, h, junk);
    }
    await say(r, lobby, ada, { t: "send", to: "*", body: 1 });
    await say(r, lobby, ada, { t: "close" });
    await r.lobbies
      .at(lobby.code)
      .lobby.webSocketMessage(ada as unknown as WebSocket, new ArrayBuffer(8));

    expect(h.take()).toEqual([]);
    expect(ada.take()).toEqual([]);
    expect([h.closed, ada.closed]).toEqual([null, null]);
  });

  it("closes the socket that sends a frame over 64 KiB with 1009, and the host hears it go", async () => {
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    h.take();

    // Exactly the cap is forwarded; one byte past it — a two-byte character — is not.
    const pad = (n: number) => JSON.stringify({ t: "msg", body: "x".repeat(n) });
    const exact = pad(MAX_FRAME_BYTES - pad(0).length);
    await say(r, lobby, ada, exact);
    expect(h.take()).toHaveLength(1);

    await say(r, lobby, ada, exact.replace("x", "é"));
    expect(ada.closed).toEqual({ code: CLOSE.tooBig, reason: "frame too large" });
    expect(h.take()).toEqual([{ t: "peers", peers: [{ peer: "p1", name: "Ada", online: false }] }]);
  });
});

describe("lock, kick and close", () => {
  it("a lock refuses a new guest with 4003, and a rejoin still works", async () => {
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    const { peer, secret } = welcome(ada);
    await drop(r, lobby, ada);

    await say(r, lobby, h, { t: "lock" });

    const late = await guest(r, lobby, "Late");
    expect(late.closed).toEqual({ code: CLOSE.started, reason: "started" });
    const back = await guest(r, lobby, "Ada", `${peer}.${secret}`);
    expect(back.closed).toBeNull();
    expect(welcome(back).peer).toBe("p1");
  });

  it("a kick closes the guest with 4001 and takes it off the roster", async () => {
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    const { peer, secret } = welcome(ada);
    await guest(r, lobby, "Bo");
    h.take();

    await say(r, lobby, h, { t: "kick", peer: "p1" });

    expect(ada.closed).toEqual({ code: CLOSE.kicked, reason: "kicked" });
    expect(h.take()).toEqual([{ t: "peers", peers: [{ peer: "p2", name: "Bo", online: true }] }]);
    await drop(r, lobby, ada);
    expect(h.take()).toEqual([]);

    // Its secret names no seat now: a rejoin is a fresh join, under a new id.
    const back = await guest(r, lobby, "Ada", `${peer}.${secret}`);
    expect(welcome(back).peer).toBe("p3");
  });

  it("a close ends every socket with 4000, and the code is a 404 from then on", async () => {
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    const bo = await guest(r, lobby, "Bo");

    await say(r, lobby, h, { t: "close" });

    for (const ws of [h, ada, bo]) {
      expect(ws.closed).toEqual({ code: CLOSE.closed, reason: "lobby closed" });
    }
    const { fake } = r.lobbies.at(lobby.code);
    expect(fake.store.size).toBe(0);
    expect(fake.alarm()).toBeNull();
    const after = await worker.fetch(
      socketRequest(`/lobby/${lobby.code}/ws?role=guest&name=Cy`),
      r.env,
    );
    expect(after.status).toBe(404);
    const hostAfter = await worker.fetch(
      socketRequest(`/lobby/${lobby.code}/ws?role=host&key=${lobby.hostKey}`),
      r.env,
    );
    expect(hostAfter.status).toBe(404);
  });
});

describe("expiry", () => {
  it("the alarm at six hours closes every socket with 4000 and empties the storage", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const r = relay();
    const lobby = await created(r);
    const h = await host(r, lobby);
    const ada = await guest(r, lobby, "Ada");
    const { lobby: object, fake } = r.lobbies.at(lobby.code);

    // Early, it re-arms and ends nothing.
    vi.setSystemTime(lobby.expiresAt - 1);
    await object.alarm();
    expect(h.closed).toBeNull();
    expect(fake.alarm()).toBe(lobby.expiresAt);

    vi.setSystemTime(lobby.expiresAt);
    await object.alarm();

    expect(h.closed).toEqual({ code: CLOSE.closed, reason: "lobby expired" });
    expect(ada.closed).toEqual({ code: CLOSE.closed, reason: "lobby expired" });
    expect(fake.store.size).toBe(0);
    expect(fake.alarm()).toBeNull();
    const after = await worker.fetch(
      socketRequest(`/lobby/${lobby.code}/ws?role=guest&name=Cy`),
      r.env,
    );
    expect(after.status).toBe(404);
  });

  it("a lobby past its expiry is dead even before its alarm runs", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const r = relay();
    const lobby = await created(r);

    vi.setSystemTime(lobby.expiresAt + 1);

    const after = await worker.fetch(
      socketRequest(`/lobby/${lobby.code}/ws?role=host&key=${lobby.hostKey}`),
      r.env,
    );
    expect(after.status).toBe(404);
    expect(r.lobbies.at(lobby.code).fake.store.size).toBe(0);
  });
});

describe("parseJoin", () => {
  it("reads a host, a guest and a rejoin", () => {
    const key = "a".repeat(32);
    expect(parseJoin(new URLSearchParams(`role=host&key=${key}`))).toEqual({ role: "host", key });
    expect(parseJoin(new URLSearchParams("role=guest&name=%20Ada%20"))).toEqual({
      role: "guest",
      name: "Ada",
      rejoin: null,
    });
    expect(parseJoin(new URLSearchParams(`role=guest&name=Ada&rejoin=p12.${key}`))).toEqual({
      role: "guest",
      name: "Ada",
      rejoin: { peer: "p12", secret: key },
    });
  });

  it("counts a name in characters, not UTF-16 units, and refuses a control character", () => {
    const name = "🐉".repeat(24);
    expect(parseJoin(new URLSearchParams({ role: "guest", name }))).toMatchObject({ name });
    expect(parseJoin(new URLSearchParams({ role: "guest", name: name + "🐉" }))).toMatchObject({
      status: 400,
    });
    expect(parseJoin(new URLSearchParams({ role: "guest", name: "A\u0007da" }))).toMatchObject({
      status: 400,
    });
  });
});
