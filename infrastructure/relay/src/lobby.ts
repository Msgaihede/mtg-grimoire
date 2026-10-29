import { allowedOrigin } from "./cors";
import { hex } from "./md5";
import { required } from "./patreon";
import { limited } from "./ratelimit";
import { KEEPALIVE } from "./ticket";
import { verify } from "./token";
import type { Env } from "./index";

/**
 * Lobbies for pod drafts (draft & packs spec §6): one Durable Object per lobby code, routing JSON
 * frames between one host socket and up to seven guest sockets.
 *
 * **It is a dumb router and knows nothing of a draft.** The host's app runs the draft and every
 * guest app sends it picks; what crosses here is a frame with an opaque `body` this file never
 * reads. What the object keeps is the roster — the host key's hash, each guest's peer id, name
 * and secret's hash, whether the lobby is locked — for six hours at most, and then nothing: the
 * alarm at expiry, and a host's `close`, empty its storage.
 *
 * **Creating one is a supporter's, and the bearer is what makes it so.** `POST /lobby` verifies
 * the relay's access token exactly as the `/g/…` gate does — `token.ts`'s `verify`, signature and
 * expiry, with no group compared because no group route is involved — and the relay mints that
 * token in one place, `claim.ts`'s `grantFor`, which each of its three doors reaches only after
 * `settle` has read the membership as `active` or `grace` (a `dead` row is refused or revoked
 * first). So a valid token is an entitled membership as of its mint, a day at most ago, which is
 * the same revocation window sync itself runs on. **Joining needs nothing but the code**: the code
 * is the whole capability, which is why it is drawn from a CSPRNG and why the object answers 404
 * the moment a lobby is dead.
 *
 * **Hibernatable sockets, and no in-memory state.** Every socket is accepted with
 * `state.acceptWebSocket` and a tag naming its seat (`host`, `peer:p1`), with the same seat as its
 * attachment, so a socket woken from hibernation still says who it is; whether a seat is online
 * is read off `getWebSockets` at the moment it is asked, never remembered. `group.ts`'s `ws` says
 * why `accept()` must never appear in an object like this.
 *
 * **The frames** (JSON text, at most {@link MAX_FRAME_BYTES} each):
 * - to the host: `{"t":"peers","peers":[{"peer","name","online"}]}` on connect and on every change
 *   (a join, a rejoin, a kick, a guest's socket going), and `{"t":"msg","from":"p1","body":…}`;
 * - from the host: `{"t":"send","to":"p1"|"*","body":…}`, `{"t":"lock"}`, `{"t":"kick","peer"}`,
 *   `{"t":"close"}`;
 * - to a guest: `{"t":"welcome","peer","secret","hostOnline"}` once, on connect;
 *   `{"t":"host","online"}` when the host comes or goes; `{"t":"msg","body":…}`;
 * - from a guest: `{"t":"msg","body":…}`, forwarded to the host with `from` — or dropped, silently,
 *   while the host is offline.
 *
 * A frame that is binary, not JSON, not an object, or has a `t` this side does not know is
 * **ignored**. A frame over the cap **closes its socket with 1009** rather than vanishing: a host
 * whose view outgrew the cap would otherwise wait for ever on a pick that was never asked for, and
 * a close is a fault the app can see and report.
 */

/** The code's alphabet: no `0`/`O`, no `1`/`I`, so a code read aloud or off a screen survives. */
export const LOBBY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Characters in a code. 32⁶ is about a billion, against a few live lobbies at any moment. */
export const CODE_LENGTH = 6;

/** How long a lobby lives from its creation: a long evening's draft and its deckbuilding. */
export const LOBBY_TTL_MS = 6 * 60 * 60 * 1000;

/** Guests in one lobby, online or not: a pod of eight with the host. */
export const MAX_GUESTS = 7;

/** The largest frame either side may send, in UTF-8 bytes. */
export const MAX_FRAME_BYTES = 64 * 1024;

/** A guest's name, after trimming, in characters (code points). */
export const MAX_NAME_CHARS = 24;

/** The close codes a client reads, in the private range so none is a transport's. */
export const CLOSE = {
  /** The host closed the lobby, or it expired. */
  closed: 4000,
  /** The host kicked this guest, who is off the roster. */
  kicked: 4001,
  /** The lobby is locked and this was not a rejoin. */
  started: 4003,
  /** Seven guests already hold seats. */
  full: 4004,
  /** The same seat connected again, and this socket is the older one. */
  replaced: 4005,
  /** RFC 6455's "message too big": a frame over {@link MAX_FRAME_BYTES}. */
  tooBig: 1009,
} as const;

/** How many codes `POST /lobby` draws before it gives up on finding a free one. */
const CODE_ATTEMPTS = 4;

/** The object's one internal path: only `handleLobbyCreate` builds it, and no route reaches it. */
const INIT_URL = "https://relay.internal/lobby/init";

const CODE = new RegExp(`^[${LOBBY_ALPHABET}]{${CODE_LENGTH}}$`);
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PEER = /^p[1-9][0-9]{0,5}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The storage key the whole roster lives under: eight seats are one small value. */
const ROOM = "room";

/** A fresh code, uniformly: 256 is a multiple of 32, so masking a random byte has no bias. */
export function drawCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = "";
  for (const byte of bytes) code += LOBBY_ALPHABET[byte & 31];
  return code;
}

/**
 * The code a path segment names, or `null` when it names none. **Upper-cased first**, so a code
 * typed in lower case reaches the same lobby; nothing else is forgiven — no `0` for `O`, since
 * neither is in the alphabet.
 */
export function lobbyCode(segment: string): string | null {
  const code = segment.toUpperCase();
  return CODE.test(code) ? code : null;
}

/** What a socket's query asks to be. */
export type Join =
  | { role: "host"; key: string }
  | { role: "guest"; name: string; rejoin: { peer: string; secret: string } | null };

/** A refusal before any upgrade, with the status it is answered with. */
export interface JoinRefusal {
  status: 400 | 403;
  error: string;
}

/**
 * The socket's query, read: `role=host&key=<32 hex>`, or `role=guest&name=…[&rejoin=<peer>.<32
 * hex>]`. A host key of the wrong shape is a wrong key (403); everything else malformed is a 400.
 * A name is trimmed and must then be 1–{@link MAX_NAME_CHARS} characters with no control
 * character — it is drawn on seven other screens.
 */
export function parseJoin(params: URLSearchParams): Join | JoinRefusal {
  const role = params.get("role");
  if (role === "host") {
    const key = params.get("key") ?? "";
    if (!HEX32.test(key)) return { status: 403, error: "wrong host key" };
    return { role: "host", key };
  }
  if (role !== "guest") return { status: 400, error: "role must be host or guest" };

  const name = (params.get("name") ?? "").trim();
  const chars = [...name].length;
  if (chars < 1 || chars > MAX_NAME_CHARS || CONTROL.test(name)) {
    return { status: 400, error: "a name is 1 to 24 characters" };
  }

  const token = params.get("rejoin");
  if (token === null) return { role: "guest", name, rejoin: null };
  const dot = token.indexOf(".");
  const peer = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (dot < 0 || !PEER.test(peer) || !HEX32.test(secret)) {
    return { status: 400, error: "rejoin is <peer>.<secret>" };
  }
  return { role: "guest", name, rejoin: { peer, secret } };
}

function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

/** Two hashes of one format, compared without leaking where they first differ. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const NOT_LIVE = () => json({ error: "no such lobby" }, 404);

function wantsUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

// ---------------------------------------------------------------------------------------
// The Worker's half: POST /lobby and GET /lobby/{code}/ws, ahead of the object
// ---------------------------------------------------------------------------------------

/**
 * `POST /lobby` (the router has checked the method): the bearer, then the limit, then a code.
 *
 * **The bearer before the limit**, because verifying it is an HMAC over memory — junk costs
 * nothing to refuse, and must not spend a supporter's budget. **The limit before the object**,
 * `RL_MINT`'s thirty a minute per address: a lobby is a Durable Object brought to life and an
 * alarm set, the metered line, and nobody honest makes thirty a minute.
 *
 * **A code already live is drawn again**, up to {@link CODE_ATTEMPTS} times: the object refuses
 * an init while its lobby lives (409). At a billion codes that never happens twice running, and
 * a 503 says so if it ever does. The host key is drawn here and **only its hash goes to the
 * object**, so the key exists in the 201 and on the host and nowhere else.
 */
export async function handleLobbyCreate(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") === true ? auth.slice(7) : null;
  const claims = bearer
    ? await verify(bearer, required(env.RELAY_HMAC_KEY, "RELAY_HMAC_KEY"), Date.now())
    : null;
  if (!claims) return new Response("unauthorized", { status: 401 });

  const refused = await limited(request, env, "lobby");
  if (refused) return refused;

  const hostKey = randomHex(16);
  const hostHash = await sha256Hex(hostKey);
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = drawCode();
    const stub = env.LOBBY.get(env.LOBBY.idFromName(code));
    const answer = await stub.fetch(INIT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostHash }),
    });
    if (answer.status === 201) {
      const { expiresAt } = await answer.json<{ expiresAt: number }>();
      return json({ code, hostKey, expiresAt }, 201);
    }
    if (answer.status !== 409) return json({ error: "the lobby could not be made" }, 502);
  }
  return json({ error: "no free lobby code" }, 503);
}

/**
 * `GET /lobby/{code}/ws` (the router has checked the method), refused here for everything the
 * request alone can show, so junk reaches no object: a code of the wrong shape (404, the answer
 * for a lobby that does not exist), a foreign `Origin` (403 — `index.ts`'s `/ws` reasoning: CORS
 * does not cover an upgrade, and absent is not foreign), no upgrade (426), a malformed query
 * (400), and then `RL_READ`'s limit (429). **No bearer**: the code is the capability.
 */
export async function handleLobbySocket(
  request: Request,
  env: Env,
  url: URL,
  segment: string,
): Promise<Response> {
  const code = lobbyCode(segment);
  if (code === null) return NOT_LIVE();

  if (request.headers.has("origin") && allowedOrigin(request, env) === null) {
    return new Response("origin not allowed", { status: 403 });
  }
  if (!wantsUpgrade(request)) return json({ error: "expected Upgrade: websocket" }, 426);

  const join = parseJoin(url.searchParams);
  if ("status" in join) return json({ error: join.error }, join.status);

  const refused = await limited(request, env, "lobbySocket");
  if (refused) return refused;

  return env.LOBBY.get(env.LOBBY.idFromName(code)).fetch(request);
}

// ---------------------------------------------------------------------------------------
// The object
// ---------------------------------------------------------------------------------------

interface Guest {
  peer: string;
  name: string;
  secretHash: string;
}

/** Everything a lobby stores, as one value under {@link ROOM}. */
interface Room {
  hostHash: string;
  createdAt: number;
  expiresAt: number;
  locked: boolean;
  /** The number the next guest's peer id takes. Never reused, so a kicked `p2` names nobody. */
  next: number;
  /** In join order, which is the order `peers` lists them in. */
  guests: Guest[];
}

/** A socket's attachment: the seat it holds, or none for a socket accepted only to be closed. */
type Seat = { role: "host" } | { role: "guest"; peer: string } | { role: "refused" };

const HOST_TAG = "host";
const peerTag = (peer: string) => `peer:${peer}`;

function oversized(text: string): boolean {
  if (text.length > MAX_FRAME_BYTES) return true;
  if (text.length * 3 <= MAX_FRAME_BYTES) return false;
  return new TextEncoder().encode(text).length > MAX_FRAME_BYTES;
}

/** A frame as JSON with a string `t`, or `null` for anything this side ignores. */
function frameOf(text: string): ({ t: string } & Record<string, unknown>) | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const t = (value as { t?: unknown }).t;
  return typeof t === "string" ? (value as { t: string } & Record<string, unknown>) : null;
}

function send(ws: WebSocket, frame: unknown): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch (error) {
    console.error("lobby send", error);
  }
}

function close(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch (error) {
    console.error("lobby close", error);
  }
}

/**
 * The Durable Object. **SQLite-backed** — `wrangler.jsonc`'s `v2` migration names it in
 * `new_sqlite_classes`, as the free plan requires — and it stores through the storage API's
 * key-value half, which on such an object is a table in that same database: one roster of eight
 * seats is one value, and needs no schema of its own to keep in step.
 */
export class Lobby implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    // The web app's keepalive, answered by the runtime without waking the object — `group.ts`'s
    // constructor has the whole reasoning. A desktop sends protocol pings and never meets it.
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(KEEPALIVE.request, KEEPALIVE.response),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.href === INIT_URL && request.method === "POST") return this.init(request);
    if (/^\/lobby\/[^/]+\/ws$/.test(url.pathname)) return this.join(request, url);
    return new Response("not found", { status: 404 });
  }

  /** The lobby, or `null` when there is none — and an expired one is ended here, on sight. */
  private async room(now: number): Promise<Room | null> {
    const room = await this.state.storage.get<Room>(ROOM);
    if (room === undefined) return null;
    if (now >= room.expiresAt) {
      await this.end("lobby expired");
      return null;
    }
    return room;
  }

  /** Open sockets with this tag. A socket being closed, or this side closed, is not one. */
  private open(tag: string, except?: WebSocket): WebSocket[] {
    return this.state
      .getWebSockets(tag)
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  private hostOnline(except?: WebSocket): boolean {
    return this.open(HOST_TAG, except).length > 0;
  }

  /** Tell the host who is in the room, as it stands. */
  private sendPeers(room: Room, except?: WebSocket): void {
    const frame = {
      t: "peers",
      peers: room.guests.map((guest) => ({
        peer: guest.peer,
        name: guest.name,
        online: this.open(peerTag(guest.peer), except).length > 0,
      })),
    };
    for (const ws of this.open(HOST_TAG, except)) send(ws, frame);
  }

  private sendGuests(frame: unknown, room: Room, except?: WebSocket): void {
    for (const guest of room.guests) {
      for (const ws of this.open(peerTag(guest.peer), except)) send(ws, frame);
    }
  }

  /**
   * Start a lobby. **409 while one lives**, which is how `handleLobbyCreate` learns a code is
   * taken; a lobby that has expired but whose alarm has not yet run is ended and replaced.
   */
  private async init(request: Request): Promise<Response> {
    const { hostHash } = await request.json<{ hostHash?: unknown }>();
    if (typeof hostHash !== "string" || !HEX64.test(hostHash)) {
      return json({ error: "malformed init" }, 400);
    }
    const now = Date.now();
    if ((await this.room(now)) !== null) return json({ error: "lobby is live" }, 409);

    const room: Room = {
      hostHash,
      createdAt: now,
      expiresAt: now + LOBBY_TTL_MS,
      locked: false,
      next: 1,
      guests: [],
    };
    await this.state.storage.put(ROOM, room);
    await this.state.storage.setAlarm(room.expiresAt);
    return json({ expiresAt: room.expiresAt }, 201);
  }

  /**
   * A socket for a seat. **Every hash is taken before the room is read**, so nothing but storage
   * stands between reading the roster and writing it back — the object's input gate then lets no
   * other request in between, and two guests racing for the seventh seat cannot both get it.
   *
   * **A refusal that has a close code is a socket accepted and closed at once** (4003, 4004),
   * not an HTTP status, so a client reads it where it reads every other reason a lobby ends.
   * Refusals before that point — 404, 403 for a wrong host key — are HTTP, before any upgrade.
   *
   * **A rejoin whose peer and secret match no roster entry is a fresh join**, and meets the lock
   * and the cap like one; a kicked guest is off the roster, so this is what its rejoin becomes.
   */
  private async join(request: Request, url: URL): Promise<Response> {
    if (!wantsUpgrade(request)) return json({ error: "expected Upgrade: websocket" }, 426);
    const join = parseJoin(url.searchParams);
    if ("status" in join) return json({ error: join.error }, join.status);

    if (join.role === "host") {
      const keyHash = await sha256Hex(join.key);
      const room = await this.room(Date.now());
      if (room === null) return NOT_LIVE();
      if (!sameHash(keyHash, room.hostHash)) return json({ error: "wrong host key" }, 403);

      const wasOnline = this.hostOnline();
      for (const old of this.open(HOST_TAG)) close(old, CLOSE.replaced, "replaced");
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server, [HOST_TAG]);
      server.serializeAttachment({ role: "host" } satisfies Seat);
      this.sendPeers(room);
      if (!wasOnline) this.sendGuests({ t: "host", online: true }, room);
      return new Response(null, { status: 101, webSocket: client });
    }

    const rejoinHash = join.rejoin === null ? null : await sha256Hex(join.rejoin.secret);
    const freshSecret = randomHex(16);
    const freshHash = await sha256Hex(freshSecret);
    const room = await this.room(Date.now());
    if (room === null) return NOT_LIVE();

    const [client, server] = Object.values(new WebSocketPair());
    let guest = room.guests.find(
      (seat) =>
        join.rejoin !== null &&
        rejoinHash !== null &&
        seat.peer === join.rejoin.peer &&
        sameHash(seat.secretHash, rejoinHash),
    );
    let secret = join.rejoin?.secret ?? freshSecret;
    if (guest === undefined) {
      const refusal = room.locked
        ? ([CLOSE.started, "started"] as const)
        : room.guests.length >= MAX_GUESTS
          ? ([CLOSE.full, "full"] as const)
          : null;
      if (refusal !== null) {
        this.state.acceptWebSocket(server, ["refused"]);
        server.serializeAttachment({ role: "refused" } satisfies Seat);
        close(server, refusal[0], refusal[1]);
        return new Response(null, { status: 101, webSocket: client });
      }
      guest = { peer: `p${room.next}`, name: join.name, secretHash: freshHash };
      secret = freshSecret;
      room.next += 1;
      room.guests.push(guest);
      await this.state.storage.put(ROOM, room);
    }

    const tag = peerTag(guest.peer);
    for (const old of this.open(tag)) close(old, CLOSE.replaced, "replaced");
    this.state.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ role: "guest", peer: guest.peer } satisfies Seat);
    send(server, { t: "welcome", peer: guest.peer, secret, hostOnline: this.hostOnline() });
    this.sendPeers(room);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    const seat = ws.deserializeAttachment() as Seat | null;
    if (seat === null || seat.role === "refused") return;
    if (typeof message !== "string") return;
    if (oversized(message)) {
      close(ws, CLOSE.tooBig, "frame too large");
      await this.gone(ws, seat);
      return;
    }
    const frame = frameOf(message);
    if (frame === null) return;

    const room = await this.room(Date.now());
    if (room === null) {
      close(ws, CLOSE.closed, "lobby closed");
      return;
    }

    if (seat.role === "guest") {
      if (!room.guests.some((guest) => guest.peer === seat.peer)) {
        close(ws, CLOSE.kicked, "kicked");
        return;
      }
      if (frame.t !== "msg" || !("body" in frame)) return;
      for (const host of this.open(HOST_TAG)) {
        send(host, { t: "msg", from: seat.peer, body: frame.body });
      }
      return;
    }

    switch (frame.t) {
      case "send": {
        if (!("body" in frame)) return;
        const out = { t: "msg", body: frame.body };
        if (frame.to === "*") {
          this.sendGuests(out, room);
        } else if (typeof frame.to === "string" && room.guests.some((g) => g.peer === frame.to)) {
          for (const guest of this.open(peerTag(frame.to))) send(guest, out);
        }
        return;
      }
      case "lock":
        if (!room.locked) {
          room.locked = true;
          await this.state.storage.put(ROOM, room);
        }
        return;
      case "kick": {
        const index = room.guests.findIndex((guest) => guest.peer === frame.peer);
        if (index < 0) return;
        const [kicked] = room.guests.splice(index, 1);
        await this.state.storage.put(ROOM, room);
        for (const guest of this.open(peerTag(kicked.peer))) close(guest, CLOSE.kicked, "kicked");
        this.sendPeers(room);
        return;
      }
      case "close":
        await this.end("lobby closed");
        return;
      default:
        return;
    }
  }

  /**
   * A socket that has gone: its seat goes offline, and whoever should hear it does. **A guest
   * stays on the roster**, offline, so its app can rejoin with its secret; only a kick removes
   * one. A replaced or kicked socket's leaving changes nothing anybody is told, because the seat's
   * state is read off the sockets still open.
   */
  private async gone(ws: WebSocket, seat: Seat): Promise<void> {
    if (seat.role === "refused") return;
    const room = await this.room(Date.now());
    if (room === null) return;
    if (seat.role === "host") {
      if (!this.hostOnline(ws)) this.sendGuests({ t: "host", online: false }, room, ws);
      return;
    }
    if (room.guests.some((guest) => guest.peer === seat.peer)) this.sendPeers(room, ws);
  }

  /**
   * No `ws.close()` here: `compatibility_date` is past `2026-04-07`, so the runtime completes the
   * close handshake itself (`group.ts`'s `webSocketClose`).
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    const seat = ws.deserializeAttachment() as Seat | null;
    if (seat !== null) await this.gone(ws, seat);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** The lobby's six hours are up. A stale alarm (one set for a lobby since replaced) re-arms. */
  async alarm(): Promise<void> {
    const room = await this.state.storage.get<Room>(ROOM);
    if (room === undefined) return;
    if (Date.now() < room.expiresAt) {
      await this.state.storage.setAlarm(room.expiresAt);
      return;
    }
    await this.end("lobby expired");
  }

  /**
   * The lobby is dead: every socket closed with 4000, the alarm cancelled, the storage emptied —
   * so the code answers 404 from here on, and the object holds nothing at all.
   */
  private async end(reason: string): Promise<void> {
    for (const ws of this.state.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) close(ws, CLOSE.closed, reason);
    }
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }
}
