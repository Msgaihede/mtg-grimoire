// The service worker's own build. Runs AFTER the app build, because the list of files to
// precache is read out of the web bundle.
//
// Type-stripped and checked by nothing, like `vite.config.ts`; `npm run build` runs
// `tsc -p tsconfig.sw.json` so the worker's source is type-checked on every verify.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";
import { manifestJson } from "./src/pwa/manifest";

/** PR 4's web bundle goes to `dist-web/`, not `dist/`. `vite.web.config.ts` is the authority. */
const DIST = "dist-web";

/** Every file under the web bundle, as a root-relative URL. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(DIST, dir), { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

// `sw.js` cannot precache itself, and `.vite/` is build metadata a browser never asks for.
const files = walk(".")
  .filter((f) => f !== "/sw.js" && !f.startsWith("/.vite/"))
  .sort();

/**
 * The build id: a hash of what is being precached, contents included.
 *
 * **Content and not a timestamp**, because a browser decides there is an update by comparing the
 * *bytes* of `sw.js`. A timestamp would make every rebuild an update and put "A new version is
 * ready" in front of a reader who has nothing to gain from it; a content hash makes a rebuild of
 * unchanged sources produce a byte-identical worker and no prompt at all.
 */
const digest = createHash("sha256");
for (const f of files) {
  digest.update(f);
  digest.update(createHash("sha256").update(readFileSync(join(DIST, f.slice(1)))).digest());
}
const buildId = digest.digest("hex").slice(0, 16);

// The image origin has one source of truth and it is the app's. `cardImageUrl` does not have a
// web branch yet (it still answers `mtgimg://localhost` only), so this is the origin Scryfall
// serves card art from and it is overridable from the environment rather than edited here.
// Whoever gives `src/lib/images.ts` its web branch should read it from there instead.
const imageOrigin = process.env.GRIMOIRE_IMAGE_ORIGIN ?? "https://cards.scryfall.io";

export default defineConfig({
  build: {
    outDir: DIST,
    emptyOutDir: false,
    target: "es2020",
    lib: {
      entry: "src/pwa/sw.ts",
      formats: ["iife"],
      name: "grimoireSw",
      fileName: () => "sw.js",
    },
  },
  define: {
    __PRECACHE__: JSON.stringify(files),
    __BUILD_ID__: JSON.stringify(buildId),
    __IMAGE_ORIGIN__: JSON.stringify(imageOrigin),
  },
});

// Emitted only so a build log says what went in. `manifestJson()` is imported for the same
// reason `webAssets.ts` exists: nothing about the app's identity is spelled twice.
console.log(`sw: ${manifestJson().name} build ${buildId}, ${files.length} files precached`);
