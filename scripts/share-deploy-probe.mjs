// Is the share Worker serving the build that was just deployed? — asked by `release.yml`'s
// `share-deploy` the moment `wrangler deploy` returns.
//
//   node scripts/share-deploy-probe.mjs <apps/share/dist-share> [origin]
//
// `infrastructure/share-worker/README.md`'s five, "Deploying": four requests of the Worker —
// a page for a share nobody published, the gate with no bearer, the gate with a malformed one
// (the signing key's tell: 500 means it is unset), an unknown gated route — and the viewer's
// script, **byte for byte against the bundle**. That last one is the probe that says *this*
// build is what the address serves; the other four pass on any deploy since the first.
//
// It deploys nothing and holds no token.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TIMEOUT_MS, answerOf, askAll, askUntil, report, requestOf } from "./deploy-probe.mjs";

/** `SHARE_BASE` in `infrastructure/share-worker/wrangler.jsonc`, and in every binary. */
export const SHARE = "https://mtg-grimoire-share.denmark-east.workers.dev";
/** The one file every shared page names (`src/page.ts`), pinned and not hashed by the build. */
export const VIEWER = "/assets/share.js";

export const PROBES = [
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

/** What is wrong with the viewer's script as served — none when it is the bundle's. */
export function viewerProblems(built, answered) {
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
    console.error("usage: node scripts/share-deploy-probe.mjs <apps/share/dist-share> [origin]");
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
    return [...wrong, ...viewerProblems(built, viewer)];
  });
  process.exitCode = report(
    { passed: `${origin} serves this build`, failed: `${origin} does not serve this build` },
    `the four probes of \`infrastructure/share-worker/README.md\` were answered as this tree's Worker answers them, and \`${VIEWER}\` is the bundle's byte for byte.`,
    result,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
