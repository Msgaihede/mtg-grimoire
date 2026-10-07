#!/usr/bin/env node
/**
 * Downloads the card scanner's three files: into `src-tauri/scanner-assets/`, where the
 * desktop's release build embeds them — or, with `--web`, into `dist-wasm/scanner-assets/`,
 * where the web app's build picks them up to serve from its own origin.
 *
 *   npm run scanner:assets              the desktop's: `build.rs` embeds what lands
 *   npm run scanner:assets -- --web     the web app's: `npm run web:build` ships what lands
 *
 * **`--web` writes a manifest beside the three** (`manifest.json`): each file's key, name,
 * exact length and SHA-256, and the bundle's format version. A browser cannot ask the release
 * itself — a release download sends no CORS header — so the web build copies the files into
 * its static files (`vite.mobile.config.ts`'s `web:scanner`), and the manifest is how the page
 * knows what an offer to download them costs, checks what arrived, and learns that a later
 * release replaced the bundle (`src/lib/core/web/scanStore.ts`, which reads this shape).
 *
 * **The two models are held to the digests the app pins** — `DETECTION_SHA256` and
 * `RECOGNITION_SHA256`, read out of `crates/grimoire-core/src/scanner_assets.rs` as the format
 * version is read out of the crate — in both modes, before either is given its name and
 * before a manifest is written: a manifest names whatever digest the file on disk has, so one
 * written over a wrong model would have every reader's browser download it and the page
 * refuse it. **And a file already on disk is reused by its digest, never by its length**: a
 * model whose SHA-256 is the pinned one is kept (or, for `--web`, copied from the desktop's
 * folder) with no request made; the bundle has no digest to be held to — it is rebuilt every
 * week — so it is fetched every time.
 *
 * `card-hashes.bin`, `text-detection.rten` and `text-recognition.rten`, from the GitHub release
 * `scanner-bundle-v<FORMAT_VERSION>` — which `.github/workflows/scanner-bundle.yml` publishes —
 * so a developer and `release.yml` fetch them the same way. `build.rs`
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
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = "Msgaihede/mtg-grimoire";
/** The three, by the key the app calls each (`scanner_assets::Piece::key`) and its release name. */
const FILES = [
  { key: "bundle", name: "card-hashes.bin" },
  { key: "detectionModel", name: "text-detection.rten" },
  { key: "recognitionModel", name: "text-recognition.rten" },
];
const NAMES = FILES.map((file) => file.name);
const USER_AGENT = `mtg-grimoire-scanner-assets (+https://github.com/${REPO})`;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_RS = join(ROOT, "crates/card-scanner/src/index.rs");
const ASSETS_RS = join(ROOT, "crates/grimoire-core/src/scanner_assets.rs");
const DESKTOP = join(ROOT, "src-tauri/scanner-assets");
/** The web app's copy, beside its two modules — ignored, like everything under `dist-wasm/`. */
const WEB = join(ROOT, "dist-wasm/scanner-assets");
const FOR_WEB = process.argv.includes("--web");
const DEST = FOR_WEB ? WEB : DESKTOP;

/** A failure this script can put in one sentence. Anything else is reported as it is. */
class Refusal extends Error {}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The two models' digests as the app pins them, by file name. */
function pinnedDigests() {
  const source = readFileSync(ASSETS_RS, "utf8");
  const pin = (constant) => {
    const found = new RegExp(`pub const ${constant}: &str =\\s*"([0-9a-f]{64})";`).exec(source);
    if (!found) {
      throw new Refusal(
        `found no \`pub const ${constant}: &str = "<sha-256>";\` in ${ASSETS_RS}. ` +
          "The models are checked against that line, so this pattern has to match it.",
      );
    }
    return found[1];
  };
  return {
    "text-detection.rten": pin("DETECTION_SHA256"),
    "text-recognition.rten": pin("RECOGNITION_SHA256"),
  };
}

/**
 * `name` into `DEST`. `pinned` is the SHA-256 it must have, for the two files that have one.
 */
async function download(tag, name, pinned) {
  const out = join(DEST, name);
  const part = `${out}.part`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;

  // A file whose digest is the pinned one is the file, wherever it is: no request.
  if (pinned !== undefined) {
    if (existsSync(out) && sha256(out) === pinned) {
      console.log(`have  ${name} (${mb(statSync(out).size)}, its digest is the pinned one)`);
      return;
    }
    const beside = join(DESKTOP, name);
    if (FOR_WEB && existsSync(beside) && sha256(beside) === pinned) {
      copyFileSync(beside, part);
      renameSync(part, out);
      console.log(`copy  ${name} (${mb(statSync(out).size)}) from src-tauri/scanner-assets/`);
      return;
    }
  }

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

  // No reuse by length: two bundles of one length are two different weeks' cards, and a
  // model of the right length and the wrong bytes is the case the digest is for.
  const header = res.headers.get("content-length");
  const size = header === null ? null : Number(header);

  process.stdout.write(`get   ${name} … `);
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    const got = statSync(part).size;
    if (size !== null && got !== size) {
      throw new Error(`got ${got} bytes, expected ${size}`);
    }
    if (pinned !== undefined) {
      const digest = sha256(part);
      if (digest !== pinned) {
        throw new Error(
          `its SHA-256 is ${digest}, and the app pins ${pinned} — it is not the model every installed app expects`,
        );
      }
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
  const pinned = pinnedDigests();
  for (const name of NAMES) {
    await download(tag, name, pinned[name]);
  }
  if (FOR_WEB) {
    // Written last and whole, from the bytes that are on disk: the web build holds the folder
    // to this file before it ships a byte of it, and the page holds each download to it.
    const manifest = {
      formatVersion: Number(declared[1]),
      files: FILES.map(({ key, name }) => {
        const bytes = readFileSync(join(DEST, name));
        return { key, name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      }),
    };
    writeFileSync(join(DEST, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`\n${tag} in ${DEST}`);
}

try {
  await main();
} catch (err) {
  console.error(`\nscanner:assets: ${err instanceof Refusal ? err.message : (err.stack ?? err)}`);
  process.exitCode = 1;
}
