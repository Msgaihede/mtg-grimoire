#!/usr/bin/env node
/**
 * Downloads the Storybook fixture's card images into `.design-sync/card-art/`, and copies that
 * folder beside a design-system build.
 *
 *   node .design-sync/card-art.mjs                   # fetch whatever is missing
 *   node .design-sync/card-art.mjs --force           # fetch every file again
 *   node .design-sync/card-art.mjs --copy ds-bundle  # then copy it to ds-bundle/card-art/
 *
 * **What it is for: the `bundled` art mode in `packages/fake/images.ts`.** claude.ai's pages
 * allow no remote image source, so a design built from the bundle could never draw a card off
 * `cards.scryfall.io` and drew every one as a synthetic placeholder. The fixture's own JPGs,
 * shipped as files next to the bundle, are the real art on a page that cannot fetch it — and
 * `GrimoirePreviewProvider` finds them from the URL the bundle script was loaded from.
 *
 * **No image bytes are ever committed.** `.design-sync/card-art/` is gitignored; this script
 * rebuilds it at sync time from the URLs `cards.ts` already carries, which is the same rule the
 * fixture has always kept — only URLs are in the repository.
 *
 * **The URLs are read from `cards.ts` as text, not imported.** It is TypeScript and this is plain
 * Node with no loader; and the text is the right thing to read anyway, because `bundledArtPath`
 * answers for every URL in it, whichever row or seed ends up drawing it (the `large` seed's 5 200
 * minted printings copy their URLs from these rows, which is why the folder is keyed by Scryfall's
 * path and never by card id).
 *
 * **`--copy` exists because the converter wipes its output folder on every rebuild**, so the art
 * has to be put into `ds-bundle/` after the build rather than once. Each target's `card-art/` is
 * *replaced*, not merged, so a card the fixture has dropped does not linger beside the bundle. A
 * relative `--copy` directory is taken from the repository root, like every other path here, so
 * the script lands in the same place whichever directory it is run from.
 *
 * **Sequential, at least {@link SPACING_MS} between requests, and nothing is retried.** 100 ms is
 * the interval Scryfall's rate-limit page asks of most of `api.scryfall.com`
 * (`docs/reference/scryfall.md`), kept here for its image host as well: the whole folder costs
 * about twelve seconds of spacing, which is not worth arguing over. A 429 is a failure like any
 * other — the same doc records that Scryfall forbids retrying one. (The one second request this
 * makes is to a different URL, after a 404; {@link download} has why.) Exits non-zero, listing every
 * file that failed, and **sets `process.exitCode` rather than calling `process.exit()`** —
 * exiting while `fetch` still holds a socket aborts Node 24 on Windows with a libuv assertion,
 * which buries the sentence that says what went wrong (`scripts/scanner-assets.mjs` found it
 * first).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CARDS_TS = join(ROOT, "packages/fake/cards.ts");
/** `CARD_ART_DIR` in `images.ts` is the folder's name at a design system's root; this is its
 *  home in the repository, under the same name. */
const ART = join(ROOT, ".design-sync/card-art");

const SPACING_MS = 100;
const TIMEOUT_MS = 30_000;
const HEADERS = { "User-Agent": "mtg-grimoire-design-sync/1.0", Accept: "image/jpeg,image/*" };

/**
 * `bundledArtPath` in `packages/fake/images.ts`, restated — **that function and this one are
 * the two halves of one contract**, and the page looks for exactly the path this writes.
 *
 * Restated rather than imported because that module is TypeScript that imports the whole
 * fixture. The two cannot drift silently: `images.test.ts` asserts that every URL in `CARDS` maps
 * to a path of {@link WRITTEN}'s shape, and {@link collectUrls} checks every path here against
 * the same shape before a byte is written. Keep the pattern character for character in step with
 * the one in `images.ts`.
 */
const SCRYFALL_ART =
  /^https:\/\/cards\.scryfall\.io\/(normal|art_crop)\/(?:[^/?#]+\/)*([^/?#]+\.jpg)(?:\?[^#]*)?$/;
const artPath = (url) => {
  const match = SCRYFALL_ART.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
};

/** The only shape a written path may have: a kind, one file, no directories of its own. */
const WRITTEN = /^(normal|art_crop)\/[^/]+\.jpg$/;

/** A JPEG starts with an SOI marker and a segment marker. A 200 carrying an HTML error page
 *  would otherwise be saved as a `.jpg` and fail only in a browser, as a broken image. */
const isJpeg = (bytes) =>
  bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** A failure this script can put in one sentence. Anything else is reported as it is. */
class Refusal extends Error {}

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const args = { force: false, copy: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") args.force = true;
    else if (arg === "--copy") {
      const dir = argv[++i];
      if (!dir || dir.startsWith("--"))
        throw new Refusal("--copy needs a directory: --copy ds-bundle");
      args.copy.push(dir);
    } else if (arg.startsWith("--copy=")) args.copy.push(arg.slice("--copy=".length));
    else
      throw new Refusal(`unknown argument ${arg}. Usage: card-art.mjs [--force] [--copy <dir>]…`);
  }
  return args;
}

/**
 * Every art file the fixture names, as `path → url`.
 *
 * Deduplicated by the path rather than the URL, and that is where the one real hazard is caught:
 * `bundledArtPath` drops the `front/d/5/` directories, so two different images that shared a
 * file name — a card's `back/` beside its `front/` — would be written to one path, and the second
 * download would silently replace the first. The fixture holds fronts only today; this refuses
 * rather than trusting that.
 */
function collectUrls() {
  const text = readFileSync(CARDS_TS, "utf8");
  const wanted = new Map();
  let ignored = 0;
  for (const [url] of text.matchAll(/https:\/\/cards\.scryfall\.io\/[^"'`\s]+/g)) {
    const path = artPath(url);
    if (!path) {
      ignored++;
      continue;
    }
    if (!WRITTEN.test(path))
      throw new Refusal(`${url} maps to ${path}, which is not a kind and a file`);
    const bare = url.split("?")[0];
    const seen = wanted.get(path);
    if (seen && seen.split("?")[0] !== bare) {
      throw new Refusal(`two different images map to ${path}:\n  ${seen}\n  ${url}`);
    }
    if (!seen) wanted.set(path, url);
  }
  if (wanted.size === 0) {
    throw new Refusal(
      `found no card image URLs in ${CARDS_TS}. The pattern here has to match that file.`,
    );
  }
  return { wanted, ignored };
}

/** When the last request went out. Module state, so every request — a fallback included — is
 *  paced by the same clock rather than by a loop that could forget one. */
let lastRequest = 0;

async function get(url) {
  const wait = lastRequest + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  try {
    return await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`could not reach it: ${err.cause?.message ?? err.message}`);
  }
}

/**
 * One image, onto disk at `out`. Returns its size.
 *
 * **A 404 on the stamped URL asks once more without the stamp**, and only a 404. The `?1783…`
 * query is Scryfall's cache-buster — the image's own update time — and never part of which file
 * it is, which is why `bundledArtPath` drops it too. Measured 2026-10-01 on the fixture's
 * `A-Vivi Ornitier` (`fin A-248`, an Alchemy rebalance): `art_crop/…/f5fce9a5-….jpg?1783905124`
 * answered **404 `text/html`** while the same path with no query answered **200 `image/jpeg`,
 * 48,094 bytes** (`Last-Modified` 2026-06-29), and the API's `/cards/f5fce9a5-…` answered
 * `not_found` — the printing has left Scryfall, and its crop survives only as the CDN's copy of
 * the bare path. That copy can go at any time; when it does this fails like any other file, and
 * the fix is regenerating the fixture (`scripts/gen-storybook-cards.mjs`), not this script.
 */
async function download(url, out) {
  let res = await get(url);
  if (res.status === 404 && url.includes("?")) {
    await res.body?.cancel();
    res = await get(url.split("?")[0]);
    if (res.status === 200)
      console.log(`note  ${url} is 404; took the same path without its stamp`);
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("the response was empty");
  if (!isJpeg(bytes))
    throw new Error(`not a JPEG (${res.headers.get("content-type") ?? "no content-type"})`);
  // Through a `.part` and a rename, so an interrupted run never leaves a truncated file that the
  // next run's existence check would take for a finished one.
  const part = `${out}.part`;
  writeFileSync(part, bytes);
  renameSync(part, out);
  return bytes.length;
}

/** Removes what the fixture no longer names — a stale file would otherwise ride along into
 *  every copy — along with any `.part` an interrupted run left. Returns how many went. */
function prune(wanted) {
  let pruned = 0;
  for (const kind of ["normal", "art_crop"]) {
    const dir = join(ART, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (wanted.has(`${kind}/${name}`)) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
      pruned++;
    }
  }
  return pruned;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { wanted, ignored } = collectUrls();

  let fetched = 0;
  const failures = [];
  for (const [path, url] of wanted) {
    const out = join(ART, path);
    if (!args.force && existsSync(out) && statSync(out).size > 0) continue;
    mkdirSync(dirname(out), { recursive: true });
    try {
      const size = await download(url, out);
      fetched++;
      console.log(`get   ${path} (${kb(size)})`);
    } catch (err) {
      failures.push(`${path} ← ${url}: ${err.message}`);
      console.log(`FAIL  ${path}: ${err.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Refusal(
      `${failures.length} of ${wanted.size} card images failed, so nothing was copied:\n  ${failures.join("\n  ")}`,
    );
  }

  const pruned = prune(wanted);
  let total = 0;
  for (const path of wanted.keys()) total += statSync(join(ART, path)).size;
  console.log(
    `\n${wanted.size} card images, ${mb(total)}, in ${relative(ROOT, ART)} — ` +
      `${fetched} downloaded, ${wanted.size - fetched} already there` +
      (pruned ? `, ${pruned} stale removed` : "") +
      (ignored ? `, ${ignored} Scryfall URLs of another shape ignored` : ""),
  );

  for (const dir of args.copy) {
    const target = join(resolve(ROOT, dir), "card-art");
    rmSync(target, { recursive: true, force: true });
    cpSync(ART, target, { recursive: true });
    console.log(`copy  ${relative(ROOT, ART)} → ${relative(ROOT, target) || target}`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`\ncard-art: ${err instanceof Refusal ? err.message : (err.stack ?? err)}`);
  process.exitCode = 1;
}
