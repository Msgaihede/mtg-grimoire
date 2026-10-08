import { isNavigation } from "../../../packages/ui/lib/core/web/assets";

/**
 * The web app's hosting Worker — **and almost none of the hosting**. `wrangler.jsonc`'s `assets`
 * binding serves `apps/light/dist-web/` at the edge without running this file, and `_headers` puts the
 * policy on what it serves. This script is the one thing configuration could not say:
 *
 * **A file that is not there is a 404, never the document.**
 *
 * `not_found_handling: "single-page-application"` answers *every* address that matches no file
 * with `index.html` and a 200 — which is what `/decks/12` needs, and exactly wrong for
 * `/assets/DeckPage-3f9a.js` after a deploy renamed that chunk. A page loaded before the deploy
 * would ask for its old chunk and be handed HTML where it asked for JavaScript: a MIME error in
 * the console instead of the failed import the app is built to report and recover from (step
 * 5.3's update flow), and — from a service worker's side — a 200 it has no reason not to keep.
 *
 * With a script present the split is Cloudflare's own (compatibility date 2025-04-01 and later,
 * `assets_navigation_prefers_asset_serving`): a request carrying `Sec-Fetch-Mode: navigate` is
 * answered with the document **before this file runs**, free; every other request that matches
 * no file arrives here. A script's `import()`, a `Worker`'s constructor, a `fetch` and a service
 * worker's registration are none of them navigations, so each missing file reaches the 404 below.
 *
 * **What is left is the navigation that did not say so** — `curl`, a link preview, any client
 * without Fetch Metadata. It is answered by `isNavigation`, the rule the dev server and the
 * preview serve by (`packages/ui/lib/core/web/assets.ts`): a `GET` that accepts `text/html` for a path
 * whose last segment has no extension is a place in the app, and every place is the one
 * document. Imported rather than restated, so the three servers cannot come to disagree.
 *
 * **And three trees hold no place at all**, whatever the caller accepts (`NOT_A_PLACE`, in `assets.ts`):
 * the two a build writes its files into, and `/mtgimg/`, where step 5.3's service worker answers
 * card pictures. A page that worker does not control yet asks `/mtgimg/display/…` over the
 * network, and the answer has to be a 404 nothing keeps — the document there would be drawn as
 * a broken picture, and is a 200 a cache has no reason to refuse. An `<img>`'s request is never
 * a navigation, so the edge sends it here; this is the half that makes sure *here* cannot hand
 * it the document either, for a path whose last segment happens to have no extension.
 *
 * **No state and no secret**: no D1, no R2, no KV, no Durable Object, no `vars`. A request that
 * reaches this file costs one of the account's 100,000 a day and nothing else; a request for a
 * file that exists costs nothing at all, which is why nothing here is `run_worker_first`.
 */
export interface Env {
  /** `apps/light/dist-web/`, as uploaded. Asked for one thing: the document. */
  ASSETS: Fetcher;
}

/**
 * The headers on an answer this script writes. `_headers` does not reach it — Cloudflare applies
 * that file to static-asset responses only — and a 404 is not worth a policy of its own: it is
 * plain text that nothing may sniff into something else, and that nothing may keep, because the
 * same address is a real file the moment a deploy puts one there.
 */
const REFUSAL = {
  "content-type": "text/plain; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const accept = request.headers.get("accept") ?? undefined;
    // `isNavigation` holds the whole rule since the phase's last step, the reserved trees
    // included (`NOT_A_PLACE`, in `assets.ts`): the bundle's hashed files, the engine's, the
    // card pictures the service worker answers, and `/_headers`, which Cloudflare parses and
    // does not serve. A miss under any of them is a 404 to every caller — here, in the dev
    // server, in the preview and in the smoke's own server, by one list.
    if (isNavigation(request.method, accept, url.pathname)) {
      // **Asked for `/` by name, not handed the request.** The binding applies
      // `not_found_handling` to what it is given, so the request as it came would get the
      // document too — until the day somebody changes that setting, when it would get a 404 this
      // file then passed on. `/` is the document under every setting.
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }
    return new Response("Not found", { status: 404, headers: REFUSAL });
  },
} satisfies ExportedHandler<Env>;
