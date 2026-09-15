#!/usr/bin/env node
/**
 * Downloads the card scanner's three embedded files into `src-tauri/scanner-assets/`.
 *
 *   npm run scanner:assets
 *
 * `card-hashes.bin`, `text-detection.rten` and `text-recognition.rten`, from the GitHub release
 * `scanner-bundle-v<FORMAT_VERSION>` — which `.github/workflows/scanner-bundle.yml` publishes —
 * so a developer, the Android build and `release.yml` all fetch them the same way. `build.rs`
 * embeds them once all three are there.
 *
 * **The version is read from the crate's source, not typed here.** The tag carries the bundle's
 * format version so that a build can only ever download descriptors it knows how to read: an app
 * built at one version reading another version's bundle would see noise that matches nothing.
 *
 * **A download lands as `<name>.part` and is renamed only once it is whole**, because
 * `build.rs` embeds whatever file is present, and a truncated one would ship.
 *
 * Exits non-zero on any failure, and `release.yml` relies on that: a release that cannot scan
 * is a regression nobody would see until a reader tried. **It sets `process.exitCode` rather
 * than calling `process.exit()`**: exiting while `fetch` still holds a socket aborts Node 24 on
 * Windows with a libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, exit 127), which
 * buries the sentence that says what went wrong.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = "Msgaihede/mtg-grimoire";
const NAMES = ["card-hashes.bin", "text-detection.rten", "text-recognition.rten"];
const USER_AGENT = `mtg-grimoire-scanner-assets (+https://github.com/${REPO})`;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_RS = join(ROOT, "crates/card-scanner/src/index.rs");
const DEST = join(ROOT, "src-tauri/scanner-assets");

/** A failure this script can put in one sentence. Anything else is reported as it is. */
class Refusal extends Error {}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

async function download(tag, name) {
  const out = join(DEST, name);
  const part = `${out}.part`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;

  let res;
  try {
    // `fetch` follows GitHub's redirect to its asset host by default. `identity` keeps
    // `content-length` the size of the file itself, which both checks below compare against.
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" } });
  } catch (err) {
    throw new Refusal(`could not reach ${url}: ${err.cause?.message ?? err.message}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 404) {
      throw new Refusal(
        `the release ${tag} has no asset ${name} (HTTP 404 from ${url}). ` +
          `The scanner-bundle workflow publishes it: https://github.com/${REPO}/actions/workflows/scanner-bundle.yml`,
      );
    }
    throw new Refusal(`HTTP ${res.status} downloading ${name} from ${url}`);
  }

  const header = res.headers.get("content-length");
  const size = header === null ? null : Number(header);
  if (size !== null && existsSync(out) && statSync(out).size === size) {
    await res.body?.cancel();
    console.log(`have  ${name} (${mb(size)})`);
    return;
  }

  process.stdout.write(`get   ${name} … `);
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    const got = statSync(part).size;
    if (size !== null && got !== size) {
      throw new Error(`got ${got} bytes, expected ${size}`);
    }
    renameSync(part, out);
    console.log(mb(got));
  } catch (err) {
    rmSync(part, { force: true });
    throw new Refusal(`downloading ${name} failed: ${err.message}`);
  }
}

async function main() {
  const declared = readFileSync(INDEX_RS, "utf8").match(/pub const FORMAT_VERSION: u16 = (\d+);/);
  if (!declared) {
    throw new Refusal(
      `found no \`pub const FORMAT_VERSION: u16 = N;\` in ${INDEX_RS}. ` +
        "The release tag is read from that line, so this pattern has to match it.",
    );
  }
  const tag = `scanner-bundle-v${declared[1]}`;
  mkdirSync(DEST, { recursive: true });
  for (const name of NAMES) {
    await download(tag, name);
  }
  console.log(`\n${tag} in ${DEST}`);
}

try {
  await main();
} catch (err) {
  console.error(`\nscanner:assets: ${err instanceof Refusal ? err.message : (err.stack ?? err)}`);
  process.exitCode = 1;
}
