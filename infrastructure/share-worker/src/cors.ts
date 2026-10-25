/**
 * Cross-origin resource sharing, for the one page that publishes a share from a browser: the light
 * app's web build at `https://mtg-grimoire.app`, whose engine runs as WASM in a Web Worker and —
 * since the publish round moved into the engine (issue #1396's PR 2) — refreshes the group's
 * shares with `fetch`. **The gated `/g/…` routes only**: the public `/s/…` pair is a page and a
 * file a browser opens by navigating, and asks nothing of CORS.
 *
 * **`infrastructure/scan-worker/src/cors.ts`'s three functions, copied** — not imported, for the
 * reason `env.ts` gives about `json`: a shared module would couple two Workers' deploys. What
 * differs is one constant, {@link ALLOW_HEADERS}.
 *
 * **The allow-list is not an access control** — `env.ts`'s `authorised` is, and `curl` sends
 * whatever `Origin` it likes or none. What it buys is that a foreign page cannot have a reader's
 * browser ask this Worker on its behalf and read what it answers. A request with no `Origin` is
 * answered byte for byte as if this file did not exist, which is every desktop and Android build.
 */

/** The one binding this file reads; unset, no page may ask and every native client still can. */
export interface CorsEnv {
  APP_ORIGINS?: string;
}

/**
 * The request headers a pre-flight is told it may send: `authorization`, which carries the
 * relay's token, and `content-type` — a create's `application/json` and an upload's
 * `application/gzip` are not among the three types a browser sends unasked.
 *
 * ⚠️ **A header the engine starts sending and this list does not name fails every publish from
 * the web app and none from the desktop** — the browser refuses the pre-flight and never sends
 * the request, and the engine sees a network error with no status.
 */
const ALLOW_HEADERS = "authorization, content-type";

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
 * nothing but the origin — so the router answers it ahead of the gate, D1 and R2.
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
 * engine words a full group of shares, a snapshot too large and a withdrawn share each
 * differently.
 */
export function withCors(response: Response, origin: string): Response {
  const readable = new Response(response.body, response);
  readable.headers.set("access-control-allow-origin", origin);
  readable.headers.append("vary", "Origin");
  return readable;
}
