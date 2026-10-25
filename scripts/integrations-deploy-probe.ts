// Is the integrations store up and routing, the moment `wrangler deploy` returned? — asked by
// `release.yml`'s `integrations-deploy`.
//
//   node scripts/integrations-deploy-probe.ts [origin]     # origin: the store's own address
//
// `infrastructure/integrations-worker/README.md`'s probes, "Deploying": seven requests a stranger
// could make, each with the answer this tree's router gives (`integrations-deploy-probe.test.ts`
// asks the router, over a namespace and a database that throw if they are touched).
//
// **What it proves, and what it does not.** That the Worker answers at its own name; that its
// routes take their own method and no other; that its door is shut to a request with no token
// and to one with a token that is not the relay's — and so that **it holds both its secrets**,
// which is the step a first deploy leaves out: the KEK is checked before the door, so a request
// with no token is a 500 without it, and a nonsense token is a 500 without the signing key; that
// a page at the web app's origin is let in, on a refusal too, and a page anywhere else is not.
// **Not that the signing key is the relay's**, nor that a group's object takes a write: no probe
// holds a token, so the first device to switch integrations on is what shows both. **Nor which
// version is live**: that rests on `wrangler deploy` exiting zero.
//
// It deploys nothing and holds no token.
import { pathToFileURL } from "node:url";
import type { Probe } from "./deploy-probe.ts";
import { askAll, askUntil, report } from "./deploy-probe.ts";

/**
 * The Worker's Custom Domain — **provisional until the owner confirms it** (its `wrangler.jsonc`),
 * and the engine's `integration::store::INTEGRATIONS_BASE` once it is.
 */
export const INTEGRATIONS = "https://integrations.mtg-grimoire.app";
/** The one origin a page may ask from (`APP_ORIGINS`, its `wrangler.jsonc`). */
export const APP = "https://mtg-grimoire.app";

/** The probes' route: a group no device is in, so nothing could be let through to it. */
const DIGESTS = "/g/abc/projection/digests";

/** No Worker answers this route at this name. */
const ABSENT: Record<number, string> = {
  404: "no route — the Worker at this address is not the integrations store",
};
/** The KEK's tell: checked before the door, so a request with no token at all meets it. */
const NO_KEK: Record<number, string> = {
  500: "`INTEGRATIONS_KEK` is not set on this Worker, or is not 32 bytes of base64url — `wrangler secret put INTEGRATIONS_KEK`",
};
/** The door's own tell (`src/gate.ts`): a bearer with no key to check it against. */
const NO_KEY: Record<number, string> = {
  500: "`RELAY_HMAC_KEY` is not set on this Worker (or `INTEGRATIONS_KEK` is not) — `wrangler secret put RELAY_HMAC_KEY`, with the relay's value",
};

export const PROBES: Probe[] = [
  {
    name: "the door is shut to a request with no token, and the Worker holds its KEK",
    path: DIGESTS,
    status: 401,
    says: "unauthorized",
    means: { ...ABSENT, ...NO_KEK },
  },
  {
    name: "the door holds a signing key, and it is not one that takes nonsense",
    path: DIGESTS,
    headers: { authorization: "Bearer nonsense" },
    status: 401,
    says: "unauthorized",
    means: { ...ABSENT, ...NO_KEY },
  },
  {
    name: "a route takes its own method and nothing else",
    method: "POST",
    path: "/g/abc/settings",
    headers: { "content-type": "application/json" },
    body: "{}",
    status: 405,
    says: "method not allowed",
    means: ABSENT,
  },
  {
    name: "a page at the web app's origin is let in",
    method: "OPTIONS",
    path: DIGESTS,
    headers: { origin: APP, "access-control-request-method": "GET" },
    status: 204,
    allowOrigin: APP,
    means: { 405: "`APP_ORIGINS` does not name the web app's origin, so no page may publish" },
  },
  {
    name: "a refusal can be read by the page that was refused",
    path: DIGESTS,
    headers: { origin: APP },
    status: 401,
    allowOrigin: APP,
    means: { ...ABSENT, ...NO_KEK },
  },
  {
    name: "a page at another origin is not let in",
    method: "OPTIONS",
    path: DIGESTS,
    headers: { origin: "https://example.com", "access-control-request-method": "GET" },
    status: 405,
    allowOrigin: null,
  },
  {
    name: "nothing else is routed",
    path: "/",
    status: 404,
    says: "not found",
  },
];

async function main() {
  const [origin = INTEGRATIONS] = process.argv.slice(2);
  const result = await askUntil(() => askAll(origin, PROBES));
  process.exitCode = report(
    {
      passed: `${origin} is the integrations store`,
      failed: `${origin} is not answering as the integrations store`,
    },
    "the seven probes of `infrastructure/integrations-worker/README.md` were answered as this tree's Worker answers them: the routes are there, the door is shut and the Worker holds both its secrets. None reaches a group's store and none holds a token, so that the key is the relay's and that a store takes a write are shown by the first device to switch integrations on.",
    result,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
