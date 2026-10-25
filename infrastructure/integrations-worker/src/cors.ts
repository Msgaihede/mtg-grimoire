/**
 * Cross-origin resource sharing, for the one page that publishes from a browser: the light app's
 * web build at `https://mtg-grimoire.app`, whose engine runs as WASM in a Web Worker and reaches
 * this Worker with `fetch` (plan §4: the publisher runs on all three hosts).
 *
 * **`infrastructure/scan-worker/src/cors.ts`'s three functions, copied** — not imported, for the
 * reason every Worker here copies rather than shares: a shared module would couple two deploys.
 * What differs is one constant, {@link ALLOW_HEADERS}.
 *
 * **The allow-list is not an access control** — `gate.ts` is, and `curl` sends whatever `Origin`
 * it likes or none. What it buys is that a foreign page cannot have a reader's browser ask this
 * Worker on its behalf and read what it answers. A request with no `Origin` is answered byte for
 * byte as if this file did not exist, which is every desktop and Android build.
 */

/** The one binding this file reads; unset, no page may ask and every native client still can. */
export interface CorsEnv {
  APP_ORIGINS?: string;
}

/** The publisher's watermark, as two headers: its `sync_clock` milliseconds and counter. */
export const HLC_MS_HEADER = "x-projection-hlc-ms";
export const HLC_CTR_HEADER = "x-projection-hlc-ctr";
/** The document's digest, lowercase hex SHA-256 — stored and handed back, never recomputed. */
export const DIGEST_HEADER = "x-projection-digest";

/**
 * The request headers a pre-flight is told it may send: `authorization` (the relay's token),
 * `content-type` (`application/gzip` and `application/json` are not among the three a browser
 * sends unasked), and the projection's three.
 *
 * ⚠️ **A header the engine starts sending and this list does not name fails every publish from
 * the web app and none from the desktop** — the browser refuses the pre-flight and never sends
 * the request, and the engine sees a network error with no status.
 */
const ALLOW_HEADERS = `authorization, content-type, ${HLC_MS_HEADER}, ${HLC_CTR_HEADER}, ${DIGEST_HEADER}`;

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
 * nothing but the origin — so the router answers it ahead of the gate and the store.
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
 * engine words `no_store`, `stale_projection` and `settings_mismatch` each differently.
 */
export function withCors(response: Response, origin: string): Response {
  const readable = new Response(response.body, response);
  readable.headers.set("access-control-allow-origin", origin);
  readable.headers.append("vary", "Origin");
  return readable;
}
