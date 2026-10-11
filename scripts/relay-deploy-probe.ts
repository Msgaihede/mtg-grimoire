import type { Probe } from "./deploy-probe.ts";
// Is the relay up and routing, the moment `wrangler deploy` returned? — asked by
// `release.yml`'s `relay-deploy`.
//
//   node scripts/relay-deploy-probe.ts [origin]     # origin: the relay's own address
//
// The probes are `docs/reference/hosted-relay-deploy.md`'s step 0, less the two that open a
// socket: ten requests a stranger could make, each answered before any Durable Object, and each
// with the answer this tree's router gives (`relay-deploy-probe.test.ts` asks the router).
//
// **What it proves, and what it does not.** That the Worker answers, that the tables its doors
// read are there (a missing one is a 500, and the probe says which), and that a page at the web
// app's origin is allowed in. **Not which version is live**: the runbook records that no request
// without a credential tells one deploy from the next, so that rests on `wrangler deploy`
// exiting zero, and the version id it prints is in the job's log.
//
// **Two addresses since 2026-10-11.** The relay answers at `relay.mtg-grimoire.app` and, for
// every build compiled before that day, still at its `workers.dev` address. After the ten, one
// request is made of the old address (`LEGACY_PROBES`): a deploy that turned it off — a config
// that lost `workers_dev: true` does, and `wrangler deploy` exits 0 — stops every installed app
// syncing, and this is what leaves that release a draft. Given an origin of its own, the script
// asks that origin and nothing else.
//
// It deploys nothing and holds no token.
import { pathToFileURL } from "node:url";
import { askAll, askUntil, report } from "./deploy-probe.ts";

/** `RELAY_BASE` in `infrastructure/relay/wrangler.jsonc`, and in every build since 2026-10-11. */
export const RELAY = "https://relay.mtg-grimoire.app";
/** `RELAY_BASE_LEGACY`, same file: the address in every build through 0.44.0. */
export const LEGACY = "https://mtg-grimoire-relay.denmark-east.workers.dev";
/** The one origin a page may ask from (`APP_ORIGINS`, same file). */
export const APP = "https://mtg-grimoire.app";

/** Well-formed and unknown: 64 hex, which is what gets a request as far as the D1 read. */
const UNKNOWN = { authorization: `Bearer ${"ab".repeat(32)}` };
const PREFLIGHT = { "access-control-request-method": "POST" };

export const PROBES: Probe[] = [
  {
    name: "the token door refuses an empty request",
    method: "POST",
    path: "/token",
    body: "{}",
    status: 400,
    says: "malformed token request",
    means: { 404: "the baseline Worker is deployed, with no entitlement routes" },
  },
  {
    name: "the key store reads D1 for a credential it does not know",
    path: "/g/abc/keys?device=deadbeef",
    headers: UNKNOWN,
    status: 401,
    means: { 500: "the router is live and the `group_keys` table is missing" },
  },
  {
    name: "the refresh door reads the device",
    method: "POST",
    path: "/token",
    body: '{"refresh":"x"}',
    status: 400,
    says: "that is not a device id",
  },
  {
    name: "the refresh door, with a device, refuses the secret",
    method: "POST",
    path: "/token",
    body: '{"refresh":"x","device":"deadbeef"}',
    status: 401,
  },
  {
    name: "the pairing rendezvous has its table",
    path: `/p/${"0".repeat(32)}/offer`,
    status: 404,
    says: "nothing there",
    means: { 500: "the route is live and the `pairing_rendezvous` table is missing" },
  },
  {
    name: "the key store reads the epoch",
    path: "/g/abc/keys?device=deadbeef&epoch=x",
    headers: UNKNOWN,
    status: 400,
    says: "that is not an epoch",
  },
  {
    name: "a page's pre-flight is answered",
    method: "OPTIONS",
    path: "/token",
    headers: { origin: APP, ...PREFLIGHT },
    status: 204,
    allowOrigin: APP,
  },
  {
    name: "a foreign origin's pre-flight is not",
    method: "OPTIONS",
    path: "/token",
    headers: { origin: "https://example.com", ...PREFLIGHT },
    status: 405,
    allowOrigin: null,
  },
  {
    name: "a page can read a refusal",
    path: "/g/abc/pull",
    headers: { origin: APP },
    status: 401,
    allowOrigin: APP,
  },
  {
    name: "a foreign origin cannot",
    path: "/g/abc/pull",
    headers: { origin: "https://example.com" },
    status: 401,
    allowOrigin: null,
  },
];

/**
 * What the old address is asked: the pre-flight, which is answered ahead of every limiter and
 * every read, so six attempts of it spend nobody's budget. One request is enough — the address
 * is the same Worker, and the ten above have already said how that Worker answers.
 */
export const LEGACY_PROBES: Probe[] = PROBES.filter(
  (probe) => probe.name === "a page's pre-flight is answered",
);

/**
 * Every sentence about what is wrong: the ten at `origin`, then the one at the old address when
 * `origin` is the relay's own. Each sentence from the old address names it, because the report's
 * heading names only `origin`.
 */
export async function askBoth(
  origin: string,
  send?: (request: Request) => Promise<Response>,
): Promise<string[]> {
  const wrong = await askAll(origin, PROBES, send);
  if (origin !== RELAY) return wrong;
  const legacy = await askAll(LEGACY, LEGACY_PROBES, send);
  return [
    ...wrong,
    ...legacy.map(
      (sentence) => `at ${LEGACY}, which every build through 0.44.0 asks — ${sentence}`,
    ),
  ];
}

async function main() {
  const [origin = RELAY] = process.argv.slice(2);
  const result = await askUntil(() => askBoth(origin));
  process.exitCode = report(
    {
      passed: `${origin} answers as this relay`,
      failed: `${origin} does not answer as this relay`,
    },
    `all ${PROBES.length} probes of \`docs/reference/hosted-relay-deploy.md\` step 0 were answered as this tree's router answers them${origin === RELAY ? `, and \`${LEGACY}\` still answers` : ""}. Which version is live is \`wrangler deploy\`'s to say, in this job's log.`,
    result,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
