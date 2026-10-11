// Is the address serving the build that was just deployed? — the runbook's two cheapest probes,
// asked by `release.yml`'s `web-deploy` job the moment `wrangler deploy` returns (light app
// phase 6, step 6.6).
//
//   node scripts/web-deploy-probe.mjs <apps/light/dist-web> [origin]     # origin: https://mtg-grimoire.app
//
// Three questions of `GET <origin>/`, each against the bundle that was uploaded:
//
//   1. it answers 200;
//   2. its `Content-Security-Policy` is **the built `_headers` line, byte for byte** — read with
//      the hosting Worker's own reader (`infrastructure/app-worker/src/headers.ts`), so "the line" means here
//      what it means to `pnpm web:preview` and to `hosting.test.ts`. This is probe 1 of
//      `infrastructure/app-worker/README.md`'s step 0;
//   3. the document is `<apps/light/dist-web>/index.html`, byte for byte. The first two pass on yesterday's
//      deploy whenever the policy did not change; this is the one that says *this* build is what
//      the address serves, because the document names its chunks by their hashes. It is also the
//      README's warning made a check: a `<script>` the build did not write is a zone feature
//      rewriting the page, under a policy that says `script-src 'self'`.
//
// And one of `GET <origin>/scanner-assets/manifest.json` (light app step 7.5):
//
//   4. it answers 200 with **the bundle's manifest, byte for byte**, and that manifest is for
//      the bundle format this tree's scanner reads (`FORMAT_VERSION` in
//      `crates/card-scanner/src/index.rs`). A bundle with no manifest is a web app built without
//      its scanner's files — it would open, pass the three questions above, and tell every
//      reader who pressed Download that the build has no scanner. The build is told the files
//      are required (`GRIMOIRE_SCANNER_ASSETS`), and this is the same fact asked of the address.
//
// **It asks more than once**, because the edge may answer with the previous version for a moment
// after the deploy returns: `PROBE_ATTEMPTS` times (6), `PROBE_WAIT_MS` apart (10 s), each
// given `PROBE_TIMEOUT_MS` (15 s) to answer in full. The first attempt that passes all three
// ends it; the worst case is about two and a half minutes, and the step has five.
//
// It exits non-zero with every question that failed on the last attempt, and writes what it saw
// to the step summary. **It deploys nothing and holds no token** — a `GET` any browser makes.
// The reading and the comparing are pure, and `web-deploy-probe.test.mjs` holds them.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { headersFor, parseHeaders } from "../infrastructure/app-worker/src/headers.ts";

/** The app's one origin (`infrastructure/app-worker/wrangler.jsonc`, `routes`). */
export const ORIGIN = "https://mtg-grimoire.app";

/** How long one attempt may take, connection to last byte (`PROBE_TIMEOUT_MS`). */
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 15_000);

/** The policy a `_headers` file sends with the document, or `null` when it sends none. */
export function policyOf(headersText) {
  return headersFor(parseHeaders(headersText), "/")["content-security-policy"] ?? null;
}

/**
 * What is wrong with an answer, as sentences — none when it is the build's.
 *
 * `built` is `{ policy, document, manifest, format }` from the bundle and the tree — `manifest`
 * the text of its `scanner-assets/manifest.json` or `null` when it has none, `format` the
 * scanner's `FORMAT_VERSION`; `answered` is `{ status, policy, document, manifest }` from the
 * address, `policy` being `null` when the response carried no such header and `manifest` being
 * `{ status, text }`.
 */
export function problems(built, answered) {
  const out = [];
  if (built.policy === null) {
    out.push("the bundle's `_headers` sends no Content-Security-Policy with the document");
  }
  if (answered.status !== 200) out.push(`the document answered ${answered.status}, not 200`);
  if (answered.policy === null) {
    out.push("the document was answered with no Content-Security-Policy");
  } else if (built.policy !== null && answered.policy !== built.policy) {
    out.push("the document's Content-Security-Policy is not the built `_headers` line");
  }
  if (answered.document !== built.document) {
    out.push(
      "the document served is not the bundle's `index.html` — the previous deploy is still being served, or something between the bundle and the reader rewrote the page",
    );
  }
  if (built.manifest === null) {
    out.push(
      "the bundle holds no `scanner-assets/manifest.json` — it was built without the card scanner's files",
    );
  } else {
    if (formatOf(built.manifest) !== built.format) {
      out.push(
        `the bundle's scanner files are format ${formatOf(built.manifest)}, and this tree's scanner reads ${built.format}`,
      );
    }
    if (answered.manifest.status !== 200) {
      out.push(`the scanner's manifest answered ${answered.manifest.status}, not 200`);
    } else if (answered.manifest.text !== built.manifest) {
      out.push("the scanner's manifest served is not the bundle's");
    }
  }
  return out;
}

/** The bundle format a manifest says its files are, or `null` for text that is not one. */
export function formatOf(manifest) {
  try {
    const { formatVersion } = JSON.parse(manifest);
    return Number.isSafeInteger(formatVersion) ? formatVersion : null;
  } catch {
    return null;
  }
}

/** `FORMAT_VERSION` as the scanner's crate declares it, or `null` when the line has moved. */
export function declaredFormat(indexRs) {
  const found = /^pub const FORMAT_VERSION: u16 = (\d+);/m.exec(indexRs);
  return found ? Number(found[1]) : null;
}

async function ask(origin) {
  const response = await fetch(`${origin}/`, {
    headers: { "cache-control": "no-cache" },
    // A redirect is an answer that is not 200, and is reported as one.
    redirect: "manual",
    // An address that accepts the connection and never answers is an attempt that failed, not
    // a job that waits out its six hours. The body is read under the same deadline.
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const manifest = await fetch(`${origin}/scanner-assets/manifest.json`, {
    headers: { "cache-control": "no-cache" },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return {
    status: response.status,
    policy: response.headers.get("content-security-policy"),
    document: await response.text(),
    manifest: { status: manifest.status, text: await manifest.text() },
  };
}

async function main() {
  const [dist, origin = ORIGIN] = process.argv.slice(2);
  if (!dist) {
    console.error("usage: node scripts/web-deploy-probe.mjs <apps/light/dist-web> [origin]");
    process.exitCode = 2;
    return;
  }
  const manifestPath = join(dist, "scanner-assets", "manifest.json");
  const built = {
    policy: policyOf(readFileSync(join(dist, "_headers"), "utf8")),
    document: readFileSync(join(dist, "index.html"), "utf8"),
    manifest: existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null,
    format: declaredFormat(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../crates/card-scanner/src/index.rs"),
        "utf8",
      ),
    ),
  };
  const attempts = Number(process.env.PROBE_ATTEMPTS ?? 6);
  const wait = Number(process.env.PROBE_WAIT_MS ?? 10_000);

  let wrong = [];
  let asked = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    asked = attempt;
    try {
      wrong = problems(built, await ask(origin));
    } catch (error) {
      wrong = [`${origin}/ could not be asked: ${error.cause?.message ?? error.message}`];
    }
    if (wrong.length === 0) break;
    console.error(`attempt ${attempt} of ${attempts}: ${wrong.join("; ")}`);
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  const lines =
    wrong.length === 0
      ? [
          `### ${origin} serves this build`,
          "",
          `Asked ${asked} time${asked === 1 ? "" : "s"}: the document answered 200, its Content-Security-Policy is the built \`_headers\` line byte for byte, and the document is the bundle's \`index.html\` byte for byte; and the card scanner's manifest is the bundle's, for the format this tree reads.`,
        ]
      : [
          `### ${origin} does not serve this build`,
          "",
          `After ${asked} attempts:`,
          "",
          ...wrong.map((sentence) => `- ${sentence}`),
        ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  process.exitCode = wrong.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
