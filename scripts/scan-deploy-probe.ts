// Is the scan inbox up and routing, the moment `wrangler deploy` returned? — asked by
// `release.yml`'s `scan-deploy`.
//
//   node scripts/scan-deploy-probe.ts [origin]     # origin: the inbox's own address
//
// `infrastructure/scan-worker/README.md`'s probes, "Deploying": seven requests a stranger could
// make, each with the answer this tree's router gives (`scan-deploy-probe.test.ts` asks the
// router, over a bucket that throws if it is touched).
//
// **What it proves, and what it does not.** That the Worker answers at its own name; that it
// takes a `POST` and nothing else; that its door is shut to a request with no token and to one
// with a token that is not the relay's — and so that **it holds a signing key at all**, which
// is the step a first deploy leaves out (a 500 there says so, by name); that a page at the web
// app's origin is let in, on a refusal too, and a page anywhere else is not; and that nothing
// is served back. **Not that the key is the relay's**: a wrong key refuses nonsense exactly as
// the right one does, and no probe holds a real token — the first scan a supporter sends is
// what shows the two Workers agree. **Nor that the bucket takes a write**, which the same scan
// shows: a probe that stored one would put a scan nobody sent in the inbox on every release.
// **Nor which version is live**: that rests on `wrangler deploy` exiting zero.
//
// It deploys nothing and holds no token.
import { pathToFileURL } from "node:url";
import type { Probe } from "./deploy-probe.ts";
import { askAll, askUntil, report } from "./deploy-probe.ts";

/** `scanner_submit::SCAN_BASE` in the engine: the Worker's Custom Domain on the web app's zone. */
export const SCAN = "https://scans.mtg-grimoire.app";
/** The one origin a page may ask from (`APP_ORIGINS`, `infrastructure/scan-worker/wrangler.jsonc`). */
export const APP = "https://mtg-grimoire.app";

/** The inbox limits one address to twelve requests a minute; a probe that met that says so. */
const LIMITED: Record<number, string> = {
  429: "the inbox's own rate limit refused the probe — ask again in a minute",
};
/** No Worker answers this route at this name. */
const ABSENT: Record<number, string> = {
  404: "no route `/scan` — the Worker at this address is not the scan inbox",
};
/** The door's own tell (`infrastructure/scan-worker/src/auth.ts`): deployed, and no secret set. */
const NO_KEY: Record<number, string> = {
  500: "`RELAY_HMAC_KEY` is not set on this Worker — `wrangler secret put RELAY_HMAC_KEY`, with the relay's value",
};

export const PROBES: Probe[] = [
  {
    name: "the route takes a POST and nothing else",
    path: "/scan",
    status: 405,
    says: "method not allowed",
    means: ABSENT,
  },
  {
    name: "the door is shut to a request with no token",
    method: "POST",
    path: "/scan",
    headers: { "content-type": "application/octet-stream" },
    status: 401,
    says: "unauthorized",
    means: { ...ABSENT, ...LIMITED, ...NO_KEY },
  },
  {
    name: "the door holds a signing key, and it is not one that takes nonsense",
    method: "POST",
    path: "/scan",
    headers: { "content-type": "application/octet-stream", authorization: "Bearer nonsense" },
    status: 401,
    says: "unauthorized",
    means: { ...ABSENT, ...LIMITED, ...NO_KEY },
  },
  {
    name: "a page at the web app's origin is let in",
    method: "OPTIONS",
    path: "/scan",
    headers: { origin: APP, "access-control-request-method": "POST" },
    status: 204,
    allowOrigin: APP,
    means: { 405: "`APP_ORIGINS` does not name the web app's origin, so no page may send a scan" },
  },
  {
    name: "a refusal can be read by the page that was refused",
    method: "POST",
    path: "/scan",
    headers: { origin: APP },
    status: 401,
    allowOrigin: APP,
    means: { ...ABSENT, ...LIMITED, ...NO_KEY },
  },
  {
    name: "a page at another origin is not let in",
    method: "OPTIONS",
    path: "/scan",
    headers: { origin: "https://example.com", "access-control-request-method": "POST" },
    status: 405,
    allowOrigin: null,
  },
  {
    name: "nothing is served back",
    path: "/runs/x.bin",
    status: 404,
    says: "not found",
  },
];

async function main() {
  const [origin = SCAN] = process.argv.slice(2);
  const result = await askUntil(() => askAll(origin, PROBES));
  process.exitCode = report(
    {
      passed: `${origin} is the scan inbox`,
      failed: `${origin} is not answering as the scan inbox`,
    },
    "the seven probes of `infrastructure/scan-worker/README.md` were answered as this tree's Worker answers them: the route is there, its door is shut and holds a key. None stores anything and none holds a token, so that the key is the relay's and that the bucket takes a write are shown by the first scan a supporter sends.",
    result,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
