// Is the scan inbox up and routing, the moment `wrangler deploy` returned? — asked by
// `release.yml`'s `scan-deploy`.
//
//   node scripts/scan-deploy-probe.ts [origin]     # origin: the inbox's own address
//
// `infrastructure/scan-worker/README.md`'s probes, "Deploying": seven requests a stranger could
// make, each with the answer this tree's router gives (`scan-deploy-probe.test.ts` asks the
// router, over a bucket that throws if it is touched).
//
// **What it proves, and what it does not.** That the Worker answers at its address; that it
// takes a `POST` and nothing else; that one picture's type is refused and a run's is read as
// far as its label; that a page at the web app's origin is let in — on a refusal too, which is
// what lets the app word one — and a page anywhere else is not; and that nothing is served
// back. **Not that the bucket takes a write**: no probe stores anything, because a probe that
// did would put a scan nobody sent in the inbox on every release. The first scan a reader
// sends is what shows that binding. **Nor which version is live**: no request without a
// credential tells one deploy from the next, so that rests on `wrangler deploy` exiting zero.
//
// It deploys nothing and holds no token.
import { pathToFileURL } from "node:url";
import type { Probe } from "./deploy-probe.ts";
import { askAll, askUntil, report } from "./deploy-probe.ts";

/** `scanner_submit::SCAN_BASE` in the engine: the Worker's `name` on the account's subdomain. */
export const SCAN = "https://mtg-grimoire-scans.denmark-east.workers.dev";
/** The one origin a page may ask from (`APP_ORIGINS`, `infrastructure/scan-worker/wrangler.jsonc`). */
export const APP = "https://mtg-grimoire.app";

/** The inbox limits one address to twelve requests a minute; a probe that met that says so. */
const LIMITED: Record<number, string> = {
  429: "the inbox's own rate limit refused the probe — ask again in a minute",
};
/** No Worker of this name answers on the subdomain. */
const ABSENT: Record<number, string> = {
  404: "no route `/scan` — the Worker at this address is not the scan inbox",
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
    name: "one picture's type is refused",
    method: "POST",
    path: "/scan",
    headers: { "content-type": "image/jpeg" },
    status: 415,
    says: "a scan is sent as application/octet-stream",
    means: { ...ABSENT, ...LIMITED },
  },
  {
    name: "a run with no label is refused at the label",
    method: "POST",
    path: "/scan",
    headers: { "content-type": "application/octet-stream" },
    status: 400,
    says: "that request carried no label",
    means: { ...ABSENT, ...LIMITED },
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
    status: 415,
    allowOrigin: APP,
    means: { ...ABSENT, ...LIMITED },
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
    "the seven probes of `infrastructure/scan-worker/README.md` were answered as this tree's Worker answers them. None stores anything: the bucket's binding is shown by the first scan a reader sends.",
    result,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
