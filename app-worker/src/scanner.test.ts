import { describe, expect, it } from "vitest";
import headersText from "../_headers?raw";
import scannerTs from "../../src/lib/core/web/scanner.ts?raw";
import {
  SCANNER_ASSETS_PREFIX,
  SCANNER_GLUE_FILE,
  SCANNER_MANIFEST,
  SCANNER_WASM_FILE,
  wasmContentType,
  wasmPath,
} from "../../src/lib/core/web/assets";
import { headersFor, parseHeaders } from "./headers";

/**
 * **What the host sends the card scanner's files** (the light app's step 7.5) — `hosting.test.ts`'s
 * arrangement, for the addresses that step added: a second Worker's script, a second module, and
 * three files under stable names. Asked of `headersFor`, never matched against the file's text.
 */

const rules = parseHeaders(headersText);
const cache = (path: string): string => headersFor(rules, path)["cache-control"];
const policy = (path: string): string => headersFor(rules, path)["content-security-policy"];
const YEAR = "public, max-age=31536000, immutable";

/** The scanner Worker's chunk as Vite names it: the stem of the file it is constructed from. */
const STEM = (() => {
  const found = /new Worker\(new URL\("\.\/([\w.-]+)\.ts", import\.meta\.url\)/.exec(scannerTs)?.[1];
  if (found === undefined) {
    throw new Error("src/lib/core/web/scanner.ts no longer constructs the Worker where this reads it.");
  }
  return found;
})();
const WORKER_CHUNK = `/assets/${STEM}-Gu6zwksK.js`;
const MODULE = [wasmPath("75b93dc9b194607d", SCANNER_GLUE_FILE), wasmPath("75b93dc9b194607d", SCANNER_WASM_FILE)];
const FILES = ["card-hashes.bin", "text-detection.rten", "text-recognition.rten", SCANNER_MANIFEST].map(
  (name) => SCANNER_ASSETS_PREFIX + name,
);

describe("the scanner's Worker", () => {
  it("is revalidated, by a rule of its own: its policy is the host's and can change under it", () => {
    expect(cache(WORKER_CHUNK)).toBe("no-cache");
    const own = rules.find((rule) => rule.path === `/assets/${STEM}-*`);
    expect(own?.unset).toEqual(["cache-control"]);
    expect(own?.set).toEqual([["cache-control", "no-cache"]]);
  });

  it("runs under the one policy, which lets it compile a module and load it from this origin", () => {
    expect(policy(WORKER_CHUNK)).toBe(policy("/"));
    expect(policy(WORKER_CHUNK)).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy(WORKER_CHUNK)).toContain("worker-src 'self'");
    expect(policy(WORKER_CHUNK)).toMatch(/connect-src 'self'/);
  });

  it("gives up the year for that file and for nothing beside it", () => {
    expect(cache(`/assets/${STEM}s-B1x9QkZp.js`)).toBe(YEAR);
    expect(cache("/assets/scanner-agAEWKgf.js")).toBe(YEAR);
  });
});

describe("the scanner's module", () => {
  it.each(MODULE)("is content-addressed and kept for a year: %s", (path) => {
    expect(cache(path)).toBe(YEAR);
  });

  it("is served as what it is, which a streamed compile checks", () => {
    expect(wasmContentType(SCANNER_WASM_FILE)).toBe("application/wasm");
    expect(wasmContentType(SCANNER_GLUE_FILE)).toBe("text/javascript");
  });
});

describe("the scanner's three files", () => {
  it.each(FILES)("is revalidated every time, its name being stable and its bytes not: %s", (path) => {
    // Exactly: a value joined onto the default's would read `no-cache, no-cache`.
    expect(cache(path)).toBe("no-cache");
  });

  it("has a rule of its own, so that loosening the default cannot take it along", () => {
    const own = rules.find((rule) => rule.path === `${SCANNER_ASSETS_PREFIX}*`);
    expect(own?.unset).toEqual(["cache-control"]);
    expect(own?.set).toEqual([["cache-control", "no-cache"]]);
  });

  it("is fetched from this origin, which the policy's `connect-src` already allows", () => {
    expect(policy(FILES[0])).toBe(policy("/"));
  });
});
