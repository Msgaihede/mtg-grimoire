import type { ProbeAnswer } from "./deploy-probe.ts";
import type { Probe } from "./deploy-probe.ts";
// Is the share Worker serving the build that was just deployed? — asked by `release.yml`'s
// `share-deploy` the moment `wrangler deploy` returns.
//
//   node scripts/share-deploy-probe.ts <apps/share/dist-share> [origin]
//
// `infrastructure/share-worker/README.md`'s five, "Deploying": four requests of the Worker —
// a page for a share nobody published, the gate with no bearer, the gate with a malformed one
// (the signing key's tell: 500 means it is unset), an unknown gated route — and the viewer's
// script, **byte for byte against the bundle**. That last one is the probe that says *this*
// build is what the address serves; the other four pass on any deploy since the first.
//
// **Two addresses since 2026-10-11.** The Worker answers at `share.mtg-grimoire.app` and still
// at its `workers.dev` address, which every release through 0.44.0 publishes to and every link
// minted before that day names. After the five, one request is made of the old address
// (`LEGACY_PROBES`): a deploy that turned it off — a config that lost `workers_dev: true` does,
// and `wrangler deploy` exits 0 — is what this leaves a draft. Given an origin of its own, the
// script asks that origin and nothing else.
//
// It deploys nothing and holds no token.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TIMEOUT_MS, answerOf, askAll, askUntil, report, requestOf } from "./deploy-probe.ts";

/** `SHARE_BASE` in `infrastructure/share-worker/wrangler.jsonc`, and in every build since 2026-10-11. */
export const SHARE = "https://share.mtg-grimoire.app";
/** The address in every release through 0.44.0, and in every link minted before the move. */
export const LEGACY = "https://mtg-grimoire-share.denmark-east.workers.dev";
/** The one file every shared page names (`src/page.ts`), pinned and not hashed by the build. */
export const VIEWER = "/assets/share.js";

export const PROBES: Probe[] = [
  {
    name: "a share nobody published is a page that says so",
    path: "/s/AAAAAAAAAAAAAAAA",
    status: 404,
    type: "text/html",
    means: { 500: "the `shares` table is missing from the database" },
  },
  {
    name: "the gate refuses a request with no bearer",
    path: "/g/abc/shares",
    status: 401,
    says: "unauthorized",
  },
  {
    name: "the gate holds the relay's signing key",
    path: "/g/abc/shares",
    headers: { authorization: "Bearer nonsense" },
    status: 401,
    means: { 500: "`RELAY_HMAC_KEY` is not set on this Worker" },
  },
  {
    name: "an unknown gated route is not found",
    path: "/g/abc/bogus",
    status: 404,
    says: "not found",
  },
];

/**
 * What the old address is asked: the gate, with no bearer — the door every release through
 * 0.44.0 publishes at. One request is enough, the address being the same Worker, and this is
 * the one whose answer is furthest from a switched-off name's: **`401` and `unauthorized`
 * against Cloudflare's `404`, `text/plain`, `error code: 1042`** (asked 2026-10-11 of
 * `mtg-grimoire-app.denmark-east.workers.dev`, which has been off since its first deploy). The
 * page for an unpublished share is a `404` too, and would differ only by its content type.
 */
export const LEGACY_PROBES: Probe[] = PROBES.filter(
  (probe) => probe.name === "the gate refuses a request with no bearer",
);

/**
 * What is wrong at the old address, each sentence naming it — the report's heading names only
 * the origin that was asked. Nothing is asked when `origin` is not the Worker's own.
 */
export async function legacyProblems(
  origin: string,
  send?: (request: Request) => Promise<Response>,
): Promise<string[]> {
  if (origin !== SHARE) return [];
  const wrong = await askAll(LEGACY, LEGACY_PROBES, send);
  return wrong.map((sentence) => `at ${LEGACY}, where earlier links point — ${sentence}`);
}

/** What is wrong with the viewer's script as served — none when it is the bundle's. */
export function viewerProblems(built: string, answered: Pick<ProbeAnswer, "status" | "body">) {
  if (built === "") return ["the bundle's assets/share.js is empty"];
  if (answered.status !== 200) return [`${VIEWER} answered ${answered.status}, not 200`];
  if (answered.body !== built) {
    return [`${VIEWER} is not the bundle's — the previous deploy is still being served`];
  }
  return [];
}

async function main() {
  const [dist, origin = SHARE] = process.argv.slice(2);
  if (!dist) {
    console.error("usage: node scripts/share-deploy-probe.ts <apps/share/dist-share> [origin]");
    process.exitCode = 2;
    return;
  }
  const built = readFileSync(join(dist, "assets", "share.js"), "utf8");
  const result = await askUntil(async () => {
    const wrong = await askAll(origin, PROBES);
    const viewer = await answerOf(
      await fetch(requestOf(origin, { name: "the viewer", path: VIEWER, status: 200 }), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
    return [...wrong, ...viewerProblems(built, viewer), ...(await legacyProblems(origin))];
  });
  process.exitCode = report(
    { passed: `${origin} serves this build`, failed: `${origin} does not serve this build` },
    `the four probes of \`infrastructure/share-worker/README.md\` were answered as this tree's Worker answers them, and \`${VIEWER}\` is the bundle's byte for byte${origin === SHARE ? `. \`${LEGACY}\` still answers` : ""}.`,
    result,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
