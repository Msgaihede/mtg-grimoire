import { Group } from "./group";
import {
  GROUP_SEGMENT,
  handleCallback,
  handleClaim,
  handleToken,
  handleWebhook,
  reconcile,
} from "./claim";
import { handlePair } from "./pair";
import { required } from "./patreon";
import { handleRendezvousGet, handleRendezvousPut, sweepRendezvous } from "./rendezvous";
import { handleKeys, handleRotate } from "./rotate";
import { verify } from "./token";

/**
 * The Worker entry: a router, an authentication gate, and the daily reconciliation's trigger.
 * Every decision about the log itself is in `group.ts`, every decision about *which rows* is in
 * `log.ts`, and every decision about who is entitled is in `claim.ts` and `entitlement.ts`.
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
 * and `/keys` are D1 only and never reach the Durable Object, so nothing they can be made to
 * spend is on the metered line — and `/keys` in particular has to answer a device whose group
 * auth is one epoch stale, which is a device that by construction cannot mint a token. Behind
 * the gate it would refuse exactly the caller it exists to serve. See `rotate.ts`.
 */

export interface Env {
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
 */
const CLAIM_ROUTES = new Map<
  string,
  { method: string; handle: (request: Request, env: Env) => Promise<Response> }
>([
  ["/oauth/patreon/callback", { method: "GET", handle: handleCallback }],
  ["/claim", { method: "POST", handle: handleClaim }],
  ["/token", { method: "POST", handle: handleToken }],
  ["/webhook/patreon", { method: "POST", handle: handleWebhook }],
  ["/pair", { method: "GET", handle: (_request, env) => Promise.resolve(handlePair(env)) }],
]);

function methodNotAllowed(expected: string): Response {
  return new Response("method not allowed", { status: 405, headers: { allow: expected } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const entitlement = CLAIM_ROUTES.get(url.pathname);
    if (entitlement !== undefined) {
      if (request.method !== entitlement.method) return methodNotAllowed(entitlement.method);
      return entitlement.handle(request, env);
    }

    const rv = RENDEZVOUS.exec(url.pathname);
    if (rv) {
      const [, id, slot] = rv;
      // D1 only, never a Durable Object — which is what lets it stand ahead of the gate.
      if (request.method === "POST") return handleRendezvousPut(request, env, id, slot, Date.now());
      if (request.method === "GET") return handleRendezvousGet(env, id, slot, Date.now());
      return methodNotAllowed("GET, POST");
    }

    const match = ROUTE.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });

    const [, group, action] = match;
    const expected = METHOD[action];
    if (request.method !== expected) return methodNotAllowed(expected);

    // **Ahead of the bearer gate and never behind it, and that is the whole point of these two
    // routes.** A device that has just been rotated away from cannot mint a token — its auth is
    // stale — so a `/keys` behind the gate would refuse exactly the caller it exists to serve.
    // They carry their own credential, they are D1 only, and they never reach the Durable
    // Object, so nothing metered is exposed by their standing outside it.
    if (action === "rotate") return handleRotate(request, env, group);
    if (action === "keys") return handleKeys(request, url, env, group);

    // **The gate stands here and not inside the Durable Object, and the reason is the bill.**
    // A request that reaches a DO costs a Durable Object request whether it is honoured or
    // refused, and that is the line that actually meters (spec §8). Verifying an HMAC here
    // costs microseconds and touches no storage, so junk is refused for the price of a Worker
    // invocation alone.
    //
    // The header is coalesced to `null` before `verify` is called and never passed through:
    // `verify` splits the token, so `null` throws where a 401 belongs — an error page and an
    // alert for what is simply a request without a ticket.
    const auth = request.headers.get("authorization");
    const bearer = auth?.startsWith("Bearer ") === true ? auth.slice(7) : null;
    const claims = bearer
      ? await verify(bearer, required(env.RELAY_HMAC_KEY, "RELAY_HMAC_KEY"), Date.now())
      : null;
    // **`claims.grp !== group` is not redundant with the signature check.** A validly signed
    // token for *your own* group is exactly what an attacker has; without this line it would
    // open every group on the relay.
    if (!claims || claims.grp !== group) {
      return new Response("unauthorized", { status: 401 });
    }

    // `idFromName` and not `newUniqueId`: the group id *is* the address, so every device in a
    // pairing group reaches the same object from anywhere in the world without the relay
    // holding a directory of any kind.
    const stub = env.GROUP.get(env.GROUP.idFromName(group));
    return stub.fetch(request);
  },

  /**
   * The daily reconciliation (spec §7.3). Awaited rather than handed to `ctx.waitUntil`, so a
   * pass that throws is reported against the scheduled invocation that caused it rather than
   * against nothing.
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
