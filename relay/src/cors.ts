/**
 * Cross-origin resource sharing, for the one page that asks this relay from a browser: the light
 * app's web build at `https://mtg-grimoire.app`, whose sync engine runs as WASM in a Web Worker
 * and reaches the relay with `fetch` (light app phase 6, issue #761).
 *
 * **Until 2026-10-04 there was no CORS code here at all, and nothing was missing.** Every caller
 * was the app's own Rust process — `reqwest` on the desktop and on Android — and a native client
 * sends no `Origin` and reads whatever comes back. A browser is the first caller that asks
 * permission: it sends `Origin`, and for any request carrying `authorization` or a JSON content
 * type it first sends an `OPTIONS` pre-flight and refuses to send the real request unless the
 * answer names its origin.
 *
 * **It weakens nothing, and the reason is that no route here trusts a cookie.** What CORS protects
 * is a server that authenticates by something the browser attaches by itself — a cookie, a client
 * certificate, an address on a private network — against a foreign page spending it. Every route
 * on this relay is gated by something the *caller* must hold and put in the request: a bearer
 * token, a claim code, the refresh secret, the group's auth, a rendezvous id. A page that holds
 * one of those could already spend it from anywhere that is not a browser.
 *
 * **So the allow-list is not an access control, and nothing may be built on it being one.** It
 * bounds which *pages* a browser lets ask; `curl`, a script and every native client never send an
 * `Origin` they did not choose, and are refused exactly what they were refused before. What the
 * list buys is narrower and still worth having: a foreign page cannot use a reader's browser —
 * their address, their rate-limit bucket — to talk to the relay.
 *
 * **No `Access-Control-Allow-Credentials`**, for the first reason again: there is no cookie to
 * send, and the header would be a standing invitation to add one. **And no
 * `Access-Control-Expose-Headers`, deliberately rather than by oversight** — the engine reads the
 * status and the body text of every answer and no response header at all (a 429's `retry-after`
 * included: the app retries on its own schedule), and `content-type` is on the safelist a browser
 * exposes unasked. Adding it "to be safe" publishes headers nobody reads.
 *
 * **A request with no `Origin` gets byte for byte what it got before this file existed** — no new
 * header, no `Vary`, the very `Response` the router built. That is every released desktop and
 * Android build, and `cors.test.ts` holds it.
 *
 * **The WebSocket is not CORS's business.** A browser sends `Origin` on an upgrade and enforces
 * nothing about the answer, so `index.ts` checks the same allow-list itself for `/ws` and refuses a
 * foreign origin with a 403; no `Access-Control-*` header ever goes on that route.
 */

/**
 * The one binding this file reads. **Optional because its absence is handled and not assumed
 * away**, on `ratelimit.ts`'s terms and in the opposite direction: a limiter that is missing lets
 * the request through, and an allow-list that is missing lets nobody's browser in. Either way the
 * native clients, which send no `Origin`, never notice.
 */
export interface CorsEnv {
  /**
   * The origins a browser may ask from, comma-separated — `wrangler.jsonc`'s `vars`, shipped as
   * exactly `https://mtg-grimoire.app`. An origin is a scheme, a host and a port when it is not
   * the scheme's own, with **no trailing slash and no path**; that is how a browser spells the
   * `Origin` header, and the comparison is exact.
   */
  APP_ORIGINS?: string;
}

/**
 * The request headers a pre-flight is told it may send: `authorization` for the bearer and
 * `content-type` because `application/json` is not one of the three types a browser sends
 * unasked. Lower case, which is how a browser spells them in `Access-Control-Request-Headers`.
 *
 * ⚠️ **A header the engine starts sending and this list does not name fails every request from the
 * web app and none from the desktop** — the pre-flight is refused by the browser, the real request
 * is never sent, and what the engine sees is a network error with no status. `User-Agent` is the
 * one to watch: `platform::http` sets none on wasm for exactly this reason.
 */
const ALLOW_HEADERS = "authorization, content-type";

/**
 * How long a browser may remember a pre-flight's answer, in seconds: a day. Firefox honours all
 * of it and Chromium caps it at two hours, so this is a ceiling a browser lowers and never one it
 * raises. Without it a browser re-asks every five seconds, which would put an `OPTIONS` in front
 * of most pushes of a busy session.
 *
 * ⚠️ **What it cannot spare is a pull's.** A browser files a pre-flight under the request's whole
 * URL, query string included, and `/pull?since=…` names a new one each time the cursor moves — so
 * a pull after any push is pre-flighted again whatever this says. That costs a Worker invocation
 * and nothing else: the answer below is built before the limiter, D1 and the object are reached.
 */
const MAX_AGE_SECS = 86_400;

/**
 * The request's `Origin` when it is on the allow-list, and `null` otherwise — for no `Origin`, an
 * unlisted one, and a list that is unset or empty alike.
 *
 * **Exact string match after trimming the list's entries, and nothing cleverer.** No wildcard, no
 * suffix match, no case folding, no URL parsing: `https://mtg-grimoire.app.evil.example` ends
 * with nothing that matters, `https://evil-mtg-grimoire.app` begins with nothing that matters, and
 * `http://` is a different origin from `https://`. A browser serialises an origin one way — lower
 * case, no trailing slash — so a list written that way matches every honest request, and a
 * comparison that tried to be forgiving would be the one place a near miss got in.
 *
 * **A `*` is refused by name**, on either side. As a list entry it would otherwise match an
 * `Origin: *` that no browser sends and a script can, and the answer would then carry
 * `Access-Control-Allow-Origin: *` — the wildcard this list exists not to be. **And `null`
 * likewise**: it is what a browser sends for every sandboxed frame and every `file:` page, so an
 * entry spelled that way would admit all of them at once.
 *
 * **It cannot throw.** A var that is missing reads as the empty list, and so does one a dashboard
 * edit turned into something that is not a string: failing closed costs the web app its sync
 * until the var is put back, and throwing would cost every native client a 500 on every route.
 */
export function allowedOrigin(request: Request, env: CorsEnv): string | null {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "" || origin === "*" || origin === "null") return null;

  const list: unknown = env.APP_ORIGINS;
  if (typeof list !== "string") return null;
  return list.split(",").some((entry) => entry.trim() === origin) ? origin : null;
}

/**
 * The answer to a pre-flight, or `null` when this request is not one.
 *
 * A pre-flight is an `OPTIONS` carrying `Access-Control-Request-Method`; the caller has already
 * established that the path takes CORS and that `origin` is on the list. An `OPTIONS` without that
 * header is somebody asking what a route allows, and it goes on to the router, which answers the
 * 405 it always has.
 *
 * **`methods` is the route's own method list and not whatever was asked for**, so the browser does
 * the comparison: a page asking to `DELETE /token` gets a 204 that says `POST`, and the browser
 * refuses the request without this side having decided anything.
 *
 * **204 with no body, and built from nothing but the origin** — which is what lets `index.ts`
 * answer it before the rate limiter, before D1, before the HMAC and before any Durable Object. A
 * pre-flight carries no credential by specification, so there is nothing to check; and a browser
 * sends one unprompted, so charging it to the caller's rate-limit budget would halve every limit
 * for the web app alone.
 *
 * `Vary: Origin` because the answer names the origin that asked: a cache that kept it must not
 * hand it to a different one.
 */
export function preflight(request: Request, origin: string, methods: string): Response | null {
  if (request.method !== "OPTIONS") return null;
  if (request.headers.get("access-control-request-method") === null) return null;

  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": methods,
      "access-control-allow-headers": ALLOW_HEADERS,
      "access-control-max-age": String(MAX_AGE_SECS),
      vary: "Origin",
    },
  });
}

/**
 * `response`, readable by a page at `origin`: the same status, the same body, the same headers,
 * plus `Access-Control-Allow-Origin` and `Vary: Origin`.
 *
 * **It goes on every answer and above all on the refusals.** A browser hides a cross-origin
 * response that lacks the header — status, body and all — and reports a network error instead.
 * The engine acts on what a refusal says: a 401 is a statement about a membership, a 403 carrying
 * `device_limit` is not one, a 409 `stale_epoch` means catch up, a 429 means wait. Each would
 * collapse into "the relay is unreachable", which the app retries for ever.
 *
 * **Rebuilt, never mutated.** A response that came back from a Durable Object stub — or from any
 * `fetch` — has immutable headers, and `headers.set` on one throws a `TypeError`: a pull that
 * worked for every native client would be a 500 for the web app alone. `new Response(body, init)`
 * copies the status and the headers into a fresh, mutable set and passes the body through
 * unread.
 *
 * `append` and not `set` for `Vary`, so a handler that one day varies on something of its own
 * keeps it.
 *
 * ⚠️ **Never hand this the 101 of a WebSocket upgrade**: the copy would have to carry the socket
 * across, and `/ws` takes no CORS header in the first place. `index.ts` keeps that route out.
 */
export function withCors(response: Response, origin: string): Response {
  const readable = new Response(response.body, response);
  readable.headers.set("access-control-allow-origin", origin);
  readable.headers.append("vary", "Origin");
  return readable;
}
