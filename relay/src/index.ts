import { admit, admitBody, isEnvelope, type Refusal } from "./admit";
import { Group } from "./group";
import {
  GROUP_SEGMENT,
  handleCallback,
  handleClaim,
  handleToken,
  handleWebhook,
  reconcile,
} from "./claim";
import { allowedOrigin, preflight, withCors, type CorsEnv } from "./cors";
import { groupEpoch } from "./groupauth";
import { handlePair } from "./pair";
import { required } from "./patreon";
import { limited, type LimitedRoute, type Limiters } from "./ratelimit";
import { handleRendezvousGet, handleRendezvousPut, sweepRendezvous } from "./rendezvous";
import { handleKeys, handleRotate } from "./rotate";
import { bearerTicket } from "./ticket";
import { verify } from "./token";

/**
 * The Worker entry: a router, an authentication gate, a push's admission, and the hourly
 * reconciliation's trigger. Every decision about the log itself is in `group.ts`, every decision
 * about *which rows* is in `log.ts`, every refusal a push can meet is in `admit.ts`, and every
 * decision about who is entitled is in `claim.ts` and `entitlement.ts`.
 *
 * **The `/g/…` routes are behind a bearer token now, and this file's own doc used to say the
 * opposite.** It said there was no authentication and that the design did not need any, on the
 * grounds that the relay can decrypt nothing it stores. That argument is still true and is not
 * what changed: the relay is now **one hosted service** rather than a deployment per reader, so
 * what it is protecting is no longer the reader's ciphertext but the account's bill. A stranger
 * who guessed a group id could previously only read bytes they cannot open; against a hosted
 * relay they can also spend somebody else's Durable Object requests, which is the line that
 * meters (spec §8).
 *
 * **Two of the `/g/…` routes stand ahead of that gate, and the same sentence is why.** `/rotate`
 * and `/keys` decide every refusal out of D1, and the one Durable Object request either makes is an
 * *accepted* rotation posting its roster — which only a caller holding the group's current auth
 * can cause, and that auth mints a token at `/token`'s group door anyway — so nothing they can be
 * made to spend is on the metered line. And `/keys` in particular has to answer a device whose
 * group auth is stale, which is a device that by construction cannot mint a token. Behind the gate
 * it would refuse exactly the caller it exists to serve. See `rotate.ts`.
 *
 * **A push is read here before it reaches its object, and the same bill is why.** The token only
 * says the caller is in the group; a batch too large to store, one sealed at an epoch the group
 * has left or not reached, or one stamped a week ahead is refused here for the price of a Worker
 * invocation and one D1 point read, where inside the object it would cost the Durable Object
 * request the gate exists to protect. The object keeps only the check it alone can make — whether
 * the group's log has room. `admitPush` below is the order.
 *
 * **The five routes a caller reaches with no token are rate limited, and the bill is why again.**
 * `/claim`, `/token`, `/rotate`, `/keys` and the rendezvous each read D1 before they can refuse
 * anything, so the argument above — junk costs an invocation and nothing else — does not hold for
 * them. `ratelimit.ts` refuses a caller past its limit ahead of that read, after the method check
 * so a 405 spends none of anybody's budget. The routes behind the gate take no limit: an HMAC over
 * memory already refuses their junk for free.
 *
 * **Since 2026-10-04 a browser is a caller too, and it changes the wrapping and nothing inside
 * it.** The web app at `https://mtg-grimoire.app` asks every route a device asks, cross-origin, so
 * `fetch` below answers a pre-flight ahead of everything — the limiter, D1, the HMAC, any object —
 * and puts `Access-Control-Allow-Origin` on whatever the router then says, refusals included.
 * `cors.ts` is why that weakens nothing. **A request with no `Origin` takes neither step**, and
 * that is every native client: `route` is the router as it stood, and its answer goes back
 * untouched. The socket is the one route that differs in kind — CORS does not cover an upgrade —
 * so `/ws` checks the origin itself and takes its bearer from a sub-protocol when there is no
 * header; `ticket.ts` is why.
 */

export interface Env extends Limiters, CorsEnv {
  GROUP: DurableObjectNamespace;

  /** The entitlement store. `relay/schema.sql` is its shape. */
  DB: D1Database;

  /**
   * This Worker's own public address, and it must equal `entitlement::RELAY_BASE` in the Rust
   * byte for byte — the redirect URI is derived from it on both sides and Patreon compares
   * redirect URIs exactly.
   */
  RELAY_BASE: string;

  /** Public, and on the wire of every authorize request. `wrangler.jsonc` carries both. */
  PATREON_CLIENT_ID: string;
  PATREON_CAMPAIGN_ID: string;

  /**
   * The three secrets this Worker holds (spec §9), set with `wrangler secret put` and **never
   * committed**. They are typed as `string` because that is what a deploy is supposed to have
   * set; an unset one is `undefined` at runtime, which is what `required` exists to catch.
   */
  PATREON_CLIENT_SECRET: string;
  PATREON_WEBHOOK_SECRET: string;
  RELAY_HMAC_KEY: string;
}

/**
 * `/g/{group}/{action}`, with the group constrained to the characters a minted uid can
 * contain. The constraint is worth having for a reason beyond tidiness: an unconstrained
 * segment means `%41` and `A` name two different Durable Objects that a reader would read as
 * one group, and there is no later point at which that becomes visible.
 *
 * Built from `claim.ts`'s `GROUP_SEGMENT` rather than spelled out, because that file has to
 * apply the same rule to the group id in a `/claim` body — see its doc for why the shared
 * string lives on that side.
 *
 * **`drop` and `roster` are absent on purpose**, and adding either would hand a device a lever
 * over the whole group's log. They are the object's internal paths: only this Worker builds them
 * — `claim.ts` when a membership ends, `rotate.ts` when a rotation is recorded — and a request
 * for one from outside is a 404 here like any other path that is not a route.
 */
const ROUTE = new RegExp(`^/g/(${GROUP_SEGMENT})/(push|pull|ack|ws|rotate|keys)$`);

/** `/p/{rv}/{slot}` — 32 hex characters, and one of exactly two slots. */
const RENDEZVOUS = /^\/p\/([0-9a-f]{32})\/(offer|join)$/;

const METHOD: Record<string, string> = {
  push: "POST",
  pull: "GET",
  ack: "POST",
  ws: "GET",
  rotate: "POST",
  keys: "GET",
};

/**
 * The entitlement layer's fixed paths, matched ahead of `ROUTE`.
 *
 * **None of them is behind the bearer gate, and each is guarded by something else instead.**
 * `/oauth/patreon/callback` is reached by Patreon's own redirect and is guarded by the
 * authorization code it carries; `/claim` is guarded by a single-use code that expires in ten
 * minutes; `/token` is guarded by the refresh secret it is presenting; the webhook is guarded
 * by its HMAC. A bearer token could not guard any of them — three of the four exist precisely
 * because the caller has no token yet.
 *
 * **`/pair` is guarded by holding no secret at all, rather than by a credential.** It is a static
 * page that reads the pairing code out of `location.hash` in the browser — the Worker serving it
 * never sees the code, so there is nothing here a gate would protect.
 *
 * ⚠️ **`/.well-known/assetlinks.json` stood beside it for part of a day and is deliberately
 * gone.** It existed only so an Android App Link could one day verify — and verifying it would
 * have *broken* the scan flow, because the app reads no launch intent and Android would have
 * taken `https://…/pair#<code>` away from the browser that is currently the only thing able to
 * show the reader that code. `pair.ts` carries the whole argument.
 *
 * A `Map` and not a `Record`, so a path that is not a route reads as `undefined` rather than as
 * a value the type system has promised is there.
 *
 * **`limit` is on the two that read D1 for a caller who has shown nothing yet.** The callback is
 * refused by Patreon's own answer to a code it never issued and the webhook by an HMAC over
 * memory, so neither has anything a limit would spare; `/pair` is a static page.
 *
 * **`cors` is on the same two, and for a different reason: they are the two a device calls.** The
 * web app's engine posts to `/claim` and `/token` with `fetch`, so a browser has to be told its
 * origin may read the answer. The other three are never asked by script — the callback and `/pair`
 * are pages a browser *navigates* to, which no CORS rule governs, and the webhook is Patreon's
 * server — so a header there would be an invitation with nobody to accept it.
 */
const CLAIM_ROUTES = new Map<
  string,
  {
    method: string;
    limit?: LimitedRoute;
    cors?: true;
    handle: (request: Request, env: Env) => Promise<Response>;
  }
>([
  ["/oauth/patreon/callback", { method: "GET", handle: handleCallback }],
  ["/claim", { method: "POST", limit: "claim", cors: true, handle: handleClaim }],
  ["/token", { method: "POST", limit: "token", cors: true, handle: handleToken }],
  ["/webhook/patreon", { method: "POST", handle: handleWebhook }],
  ["/pair", { method: "GET", handle: (_request, env) => Promise.resolve(handlePair(env)) }],
]);

/** The rendezvous takes both, on either slot — the `allow` of its 405 and of its pre-flight. */
const RENDEZVOUS_METHODS = "GET, POST";

function methodNotAllowed(expected: string): Response {
  return new Response("method not allowed", { status: 405, headers: { allow: expected } });
}

/**
 * The methods a path takes when it is one a browser may ask cross-origin, and `null` when it is
 * not — the question `fetch` asks before anything else, from the path alone.
 *
 * **Every route a device calls with `fetch`, and no other**: `/claim`, `/token`, the pairing
 * rendezvous, and the `/g/…` actions but one. What is left out is left out on purpose —
 * `CLAIM_ROUTES` says why for its three, a path that is no route has no answer worth reading, and
 * **`ws` is absent because CORS does not apply to a WebSocket upgrade**: a browser enforces
 * nothing about a 101's headers, and `withCors` would have to rebuild a response that carries a
 * socket. `route` checks that upgrade's origin itself.
 *
 * The answer is the pre-flight's `Access-Control-Allow-Methods`, read off the same tables the
 * router's 405 is, so the two cannot name different methods for one path.
 */
function corsMethods(pathname: string): string | null {
  const fixed = CLAIM_ROUTES.get(pathname);
  if (fixed !== undefined) return fixed.cors === true ? fixed.method : null;
  if (RENDEZVOUS.test(pathname)) return RENDEZVOUS_METHODS;

  const match = ROUTE.exec(pathname);
  if (!match) return null;
  const action = match[2];
  return action === "ws" ? null : METHOD[action];
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refuse(refusal: Refusal): Response {
  return json({ error: refusal.error, code: refusal.code }, refusal.status);
}

/**
 * The epoch the group stands on, for `admit`: the newest `group_keys` row (`groupEpoch`, one read
 * on `group_keys_by_group`). `/rotate` writes that row **before** it answers, so the rotating
 * device cannot push at its new epoch ahead of this read seeing it.
 *
 * **The key row and not `entitlements.group_epoch`**, although the mirror is one point read too.
 * `recordRotation`'s insert *is* the rotation's acceptance, and the mirror follows in a second
 * statement; a mirror that failed to follow would otherwise refuse every push at the epoch the
 * group has really moved to (`epoch_ahead`), with nothing left that could move it.
 *
 * `null` for a group with no key rows — one claimed before `group_keys` existed and never seeded
 * since. `admit` skips the epoch check then: there is nothing to compare against.
 */
async function currentEpoch(env: Env, group: string): Promise<number | null> {
  return groupEpoch(env, group);
}

/**
 * A push, admitted or refused, after the bearer gate and before its object: the `Request` to
 * forward, or the `Response` that refuses it. Checked in this order, and a push is answered by the
 * first it fails:
 *
 * 1. a declared `Content-Length` past the cap → 413 `too_large`, **before a byte is read**, so an
 *    honest client that built something enormous is not parsed at all;
 * 2. the body's text past the cap → 413 `too_large`, for a body that declared no length;
 * 3. not JSON → 400, and not an envelope → 400, in the words the object has always used;
 * 4. `admit`'s four: `sealed` too large (413), the epoch behind (409) or ahead (422), the clock
 *    ahead (422).
 *
 * **The forwarded request is built from the text rather than passed through**, because reading
 * the body consumed the original's stream, and it carries only a content type: the object reads no
 * header of a push, and copying the original's `Content-Length` onto a re-encoded body is a length
 * the runtime could find disagreeing with the bytes it is sent.
 */
async function admitPush(request: Request, env: Env, group: string): Promise<Request | Response> {
  const declared = admitBody(Number(request.headers.get("content-length")));
  if (declared) return refuse(declared);

  const text = await request.text();
  const oversized = admitBody(text.length);
  if (oversized) return refuse(oversized);

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return json({ error: "unreadable body" }, 400);
  }
  if (!isEnvelope(envelope)) return json({ error: "malformed envelope" }, 400);

  const refusal = admit(envelope, await currentEpoch(env, group), Date.now());
  if (refusal) return refuse(refusal);

  return new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: text,
  });
}

/**
 * The router, the gate and the hop — everything `fetch` did before a browser was a caller, and
 * still the whole of what a native client meets. It knows nothing about CORS: `fetch` decides
 * whether its answer needs dressing, and for a request with no `Origin` hands that answer back as
 * it is.
 */
async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const entitlement = CLAIM_ROUTES.get(url.pathname);
  if (entitlement !== undefined) {
    if (request.method !== entitlement.method) return methodNotAllowed(entitlement.method);
    const refused = entitlement.limit ? await limited(request, env, entitlement.limit) : null;
    return refused ?? entitlement.handle(request, env);
  }

  const rv = RENDEZVOUS.exec(url.pathname);
  if (rv) {
    const [, id, slot] = rv;
    if (request.method !== "POST" && request.method !== "GET") {
      return methodNotAllowed(RENDEZVOUS_METHODS);
    }
    // One bucket for both slots and both methods: a pairing is one offer, one answer and the
    // polls between them, and junk aimed at either slot is the same junk.
    const refused = await limited(request, env, "rendezvous");
    if (refused) return refused;
    // D1 only, never a Durable Object — which is what lets it stand ahead of the gate.
    return request.method === "POST"
      ? handleRendezvousPut(request, env, id, slot, Date.now())
      : handleRendezvousGet(env, id, slot, Date.now());
  }

  const match = ROUTE.exec(url.pathname);
  if (!match) return new Response("not found", { status: 404 });

  const [, group, action] = match;
  const expected = METHOD[action];
  if (request.method !== expected) return methodNotAllowed(expected);

  // **Ahead of the bearer gate and never behind it, and that is the whole point of these two
  // routes.** A device that has just been rotated away from cannot mint a token — its auth is
  // stale — so a `/keys` behind the gate would refuse exactly the caller it exists to serve.
  // They carry their own credential and refuse out of D1; the one Durable Object request either
  // makes is an accepted rotation's roster post, which only the group's current auth can cause,
  // so nothing metered is exposed by their standing outside it. What standing outside it does
  // cost is a D1 read per request from anyone, which is what the limit in front of each bounds.
  if (action === "rotate") {
    return (await limited(request, env, "rotate")) ?? handleRotate(request, env, group);
  }
  if (action === "keys") {
    return (await limited(request, env, "keys")) ?? handleKeys(request, url, env, group);
  }

  // **The socket's origin, checked here because nothing else will.** CORS does not cover a
  // WebSocket upgrade: a browser sends `Origin` with one and then opens the socket whatever the
  // answer's headers say, so the allow-list `fetch` applies to every other route has to be
  // enforced by hand for this one. An `Origin` that is present and not on the list is refused
  // before the gate — no HMAC, and above all no Durable Object, which is the request that bills.
  //
  // **Absent is not foreign.** The desktop and Android open this socket from Rust and send no
  // `Origin` at all; they pass through to the gate exactly as they did. Like the list itself this
  // is no access control against a caller that is not a browser — such a caller simply omits the
  // header — and it does not need to be: the token is what guards the socket. What it stops is a
  // foreign page that got hold of a token opening a live socket from a reader's browser.
  if (action === "ws" && request.headers.has("origin") && allowedOrigin(request, env) === null) {
    return new Response("origin not allowed", { status: 403 });
  }

  // **The gate stands here and not inside the Durable Object, and the reason is the bill.**
  // A request that reaches a DO costs a Durable Object request whether it is honoured or
  // refused, and that is the line that actually meters (spec §8). Verifying an HMAC here
  // costs microseconds and touches no storage, so junk is refused for the price of a Worker
  // invocation alone.
  //
  // The header is coalesced to `null` before `verify` is called and never passed through:
  // `verify` splits the token, so `null` throws where a 401 belongs — an error page and an
  // alert for what is simply a request without a ticket.
  //
  // **For the socket alone, a request with no `Authorization: Bearer` may carry the token as a
  // sub-protocol instead** — a browser's `WebSocket` cannot set a header, and `ticket.ts` is the
  // whole argument. The header still wins when it is there, which is every released desktop, and
  // what comes out of either place goes through the same `verify` and the same group comparison
  // to the same 401. `push`, `pull` and `ack` read the header and nothing else: a `fetch` can set
  // one, so a second place to look would be a second way in that no caller needs.
  const auth = request.headers.get("authorization");
  const header = auth?.startsWith("Bearer ") === true ? auth.slice(7) : null;
  const bearer =
    header ??
    (action === "ws" ? bearerTicket(request.headers.get("sec-websocket-protocol")) : null);
  const claims = bearer
    ? await verify(bearer, required(env.RELAY_HMAC_KEY, "RELAY_HMAC_KEY"), Date.now())
    : null;
  // **`claims.grp !== group` is not redundant with the signature check.** A validly signed
  // token for *your own* group is exactly what an attacker has; without this line it would
  // open every group on the relay.
  if (!claims || claims.grp !== group) {
    return new Response("unauthorized", { status: 401 });
  }

  let forward = request;
  if (action === "push") {
    const admitted = await admitPush(request, env, group);
    if (admitted instanceof Response) return admitted;
    forward = admitted;
  }

  // `idFromName` and not `newUniqueId`: the group id *is* the address, so every device in a
  // pairing group reaches the same object from anywhere in the world without the relay
  // holding a directory of any kind.
  const stub = env.GROUP.get(env.GROUP.idFromName(group));
  return stub.fetch(forward);
}

export default {
  /**
   * `route`, and around it the two things a browser needs and a native client must never see.
   *
   * **The order is the point.** Whether the path takes CORS and whether the `Origin` is on the
   * list are both read off the request and `wrangler.jsonc`'s `APP_ORIGINS` — no storage, no
   * secret — so a pre-flight is answered here, **before `route` is entered at all**: it spends
   * none of the caller's rate-limit budget, reads no D1 row, verifies no HMAC and reaches no
   * Durable Object. A browser sends a pre-flight unasked and without credentials; billing one as a
   * request to an object, or counting it against `/token`'s thirty a minute, would charge the web
   * app double for being a web app.
   *
   * **Everything else from an allowed origin is `route`'s own answer, made readable** — a 200 and
   * a 401 alike, the limiter's 429, a 405, the push admission's refusals, and whatever a Durable
   * Object said. `cors.ts`'s `withCors` is why the refusals matter most.
   *
   * **And a request that is not both — a path that takes no CORS, no `Origin`, an `Origin` that
   * is not listed — gets the very `Response` `route` built.** Not a copy with nothing added: the
   * same object, so the socket's 101 passes through with its `webSocket` attached and a native
   * client's bytes cannot differ from what they were. An `OPTIONS` from a foreign origin is in
   * that group, and gets the 405 it always got.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const methods = corsMethods(url.pathname);
    const origin = methods === null ? null : allowedOrigin(request, env);
    if (methods === null || origin === null) return route(request, env, url);

    return preflight(request, origin, methods) ?? withCors(await route(request, env, url), origin);
  },

  /**
   * The reconciliation (spec §7.3) — hourly, `wrangler.jsonc`'s `0 * * * *`, each pass reaching at
   * most `claim.ts`'s `RECONCILE_BUDGET` subjects — and then the rendezvous sweep. Awaited rather
   * than handed to `ctx.waitUntil`, so a pass that throws is reported against the scheduled
   * invocation that caused it rather than against nothing — and a `reconcile` that throws skips
   * the sweep, which is why a database missing `reconciled_at` stops both.
   */
  // `ctx` is deliberately not in the signature. `reconcile` is awaited rather than handed to
  // `ctx.waitUntil`, so there is nothing to keep alive past the return — and eslint's
  // `no-unused-vars` runs `args: "after-used"`, which forgives a leading `_controller` sitting
  // in front of a parameter that IS used and refuses a trailing one that is not.
  async scheduled(_controller: ScheduledController, env: Env) {
    await reconcile(env);
    await sweepRendezvous(env, Date.now());
  },
} satisfies ExportedHandler<Env>;

export { Group };
