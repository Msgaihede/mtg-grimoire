/**
 * Cross-origin resource sharing, for the one page that sends a scan from a browser: the light
 * app's web build at `https://mtg-grimoire.app`, whose engine runs as WASM in a Web Worker and
 * reaches this Worker with `fetch`.
 *
 * **`infrastructure/relay/src/cors.ts` is the argument, and this is its three functions copied** —
 * not imported, for the reason `infrastructure/share-worker/src/env.ts` gives about `json`: a
 * shared module would couple two Workers' deploys, and this one exists so that it is coupled to
 * none. What differs is one constant, {@link ALLOW_HEADERS}.
 *
 * **The allow-list is not an access control here either.** This route is open to anybody who can
 * send a request; `curl` sends whatever `Origin` it likes or none. What the list buys is that a
 * foreign page cannot use a reader's browser — their address, their rate-limit bucket — to fill
 * the inbox. A request with no `Origin` is answered byte for byte as if this file did not exist,
 * which is every desktop and Android build.
 */

/** The one binding this file reads; `env.ts` says why it is optional. */
export interface CorsEnv {
  APP_ORIGINS?: string;
}

/** The label's header. Lower case, as a browser spells it in `Access-Control-Request-Headers`. */
export const LABEL_HEADER = "x-scan-label";

/**
 * The request headers a pre-flight is told it may send: `content-type`, because `image/jpeg` is
 * not one of the three types a browser sends unasked, and the label's own.
 *
 * ⚠️ **A header the engine starts sending and this list does not name fails every submission from
 * the web app and none from the desktop** — the browser refuses the pre-flight and never sends the
 * picture, and the engine sees a network error with no status.
 */
const ALLOW_HEADERS = `content-type, ${LABEL_HEADER}`;

/** A day; a browser lowers it and never raises it. The relay's number and the relay's reason. */
const MAX_AGE_SECS = 86_400;

/**
 * The request's `Origin` when it is on the allow-list, and `null` otherwise. Exact string match
 * after trimming the list's entries; `*` and `null` are refused by name on either side, and a var
 * that is missing or not a string reads as the empty list rather than throwing.
 */
export function allowedOrigin(request: Request, env: CorsEnv): string | null {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "" || origin === "*" || origin === "null") return null;

  const list: unknown = env.APP_ORIGINS;
  if (typeof list !== "string") return null;
  return list.split(",").some((entry) => entry.trim() === origin) ? origin : null;
}

/**
 * The answer to a pre-flight, or `null` when this request is not one. 204, no body, built from
 * nothing but the origin — so the router answers it ahead of the limiter and the bucket.
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
 * `response`, readable by a page at `origin`. **On every answer and above all on the refusals**: a
 * browser hides a cross-origin response without the header and reports a network error, and the
 * engine words a full inbox, a picture too large and a wait each differently.
 */
export function withCors(response: Response, origin: string): Response {
  const readable = new Response(response.body, response);
  readable.headers.set("access-control-allow-origin", origin);
  readable.headers.append("vary", "Origin");
  return readable;
}
