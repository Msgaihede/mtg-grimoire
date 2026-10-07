import { describe, expect, it } from "vitest";
import {
  isScannerFile,
  isScannerModule,
  NOT_A_PLACE,
  SCANNER_ASSETS_PREFIX,
  SCANNER_CACHE,
  SCANNER_GLUE_FILE,
  SCANNER_WASM_FILE,
  scannerUrls,
  wasmFileOf,
  wasmPath,
} from "../assets";
import { FakeCaches } from "../scanTesting";
import { createWorker, type WorkerEnv } from "./serve";
import { PICTURE_CACHE } from "./pictures";
import { precacheList, routeFor, SHELL_PREFIX, shellCacheName, type Routable } from "./shell";

/**
 * **The card scanner's files, as the build and the service worker treat them** (step 7.5):
 * fetched on first use, in no precache, and — for the module — kept from then on in a cache
 * that is no build's.
 */

const ORIGIN = "https://mtg-grimoire.app";
const GLUE = wasmPath("5c4a", SCANNER_GLUE_FILE);
const WASM = wasmPath("5c4a", SCANNER_WASM_FILE);

describe("where the scanner's module and files are", () => {
  it("serves the module from a folder of `/wasm/<its own build>/`", () => {
    expect(scannerUrls(ORIGIN, "5c4a")).toEqual({
      glue: `${ORIGIN}/wasm/5c4a/scanner/grimoire_scan.js`,
      wasm: `${ORIGIN}/wasm/5c4a/scanner/grimoire_scan_bg.wasm`,
    });
    // The dev server reads any build's path off the one folder on disk.
    expect(wasmFileOf(GLUE)).toBe("scanner/grimoire_scan.js");
  });

  it("knows the scanner's files from the engine's and the app's", () => {
    expect(isScannerModule(GLUE)).toBe(true);
    expect(isScannerModule(WASM)).toBe(true);
    expect(isScannerModule("/wasm/5c4a/grimoire_web_bg.wasm")).toBe(false);
    expect(isScannerModule("/scanner")).toBe(false);
    expect(isScannerModule("/assets/scanner-B1x9.js")).toBe(false);
    for (const file of [
      "wasm/5c4a/scanner/grimoire_scan.js",
      "wasm/5c4a/scanner/grimoire_scan_bg.wasm",
      "scanner-assets/card-hashes.bin",
      "scanner-assets/manifest.json",
    ]) {
      expect(isScannerFile(file), file).toBe(true);
    }
    for (const file of ["wasm/9f/grimoire_web.js", "assets/scanWorker-B1x9.js", "index.html"]) {
      expect(isScannerFile(file), file).toBe(false);
    }
  });

  it("is not the Scanner page's own place, and is nowhere a page", () => {
    expect(SCANNER_ASSETS_PREFIX).toBe("/scanner-assets/");
    expect("/scanner".startsWith(SCANNER_ASSETS_PREFIX)).toBe(false);
    expect(NOT_A_PLACE).toContain(SCANNER_ASSETS_PREFIX);
  });

  it("keeps what it fetched in a cache that is neither a shell nor the pictures", () => {
    expect(SCANNER_CACHE.startsWith(SHELL_PREFIX)).toBe(false);
    expect(SCANNER_CACHE).not.toBe(PICTURE_CACHE);
  });
});

describe("what a build precaches, with a scanner in it", () => {
  it("leaves out the scanner's module and its three files, and keeps its Worker's script", () => {
    const list = precacheList([
      "index.html",
      "assets/index-a.js",
      "assets/scanWorker-b.js",
      "wasm/9f/grimoire_web.js",
      "wasm/9f/grimoire_web_bg.wasm",
      "wasm/5c4a/scanner/grimoire_scan.js",
      "wasm/5c4a/scanner/grimoire_scan_bg.wasm",
      "scanner-assets/card-hashes.bin",
      "scanner-assets/text-detection.rten",
      "scanner-assets/text-recognition.rten",
      "scanner-assets/manifest.json",
    ]);
    expect(list).toEqual([
      "/",
      "/assets/index-a.js",
      "/assets/scanWorker-b.js",
      "/wasm/9f/grimoire_web.js",
      "/wasm/9f/grimoire_web_bg.wasm",
    ]);
  });
});

describe("which request is the scanner's", () => {
  const ask = (path: string, mode = "cors"): Routable => ({ url: ORIGIN + path, method: "GET", mode });
  const none = new Set<string>();

  it("keeps the module, and leaves the three files and the manifest to the network", () => {
    expect(routeFor(ask(GLUE), ORIGIN, none)).toEqual({ kind: "kept", key: GLUE });
    expect(routeFor(ask(WASM), ORIGIN, none)).toEqual({ kind: "kept", key: WASM });
    for (const name of ["card-hashes.bin", "manifest.json"]) {
      expect(routeFor(ask(SCANNER_ASSETS_PREFIX + name), ORIGIN, none)).toEqual({ kind: "passthrough" });
    }
    // The engine's files are still a shell's.
    expect(routeFor(ask("/wasm/9f/grimoire_web.js"), ORIGIN, none)).toEqual({
      kind: "shell",
      key: "/wasm/9f/grimoire_web.js",
    });
  });
});

function harness(files: Record<string, () => Response>) {
  const caches = new FakeCaches();
  const asked: string[] = [];
  let online = true;
  const env: WorkerEnv = {
    build: "aaaa",
    precache: ["/"],
    origin: ORIGIN,
    caches,
    fetch: async (input) => {
      const path = new URL(typeof input === "string" ? input : input.url, ORIGIN).pathname;
      asked.push(path);
      if (!online) throw new TypeError("Failed to fetch");
      return files[path]?.() ?? new Response("Not found", { status: 404 });
    },
    pages: async () => [],
    now: () => 0,
  };
  const worker = createWorker(env);
  const later: Promise<unknown>[] = [];
  const get = async (path: string): Promise<Response> => {
    const answer = worker.respond({ url: ORIGIN + path, method: "GET", mode: "cors" }, "page", (work) =>
      later.push(work),
    );
    if (answer === null) throw new Error(`${path} is not the worker's`);
    const response = await answer;
    await Promise.all(later.splice(0));
    return response;
  };
  return { caches, asked, get, offline: () => (online = false) };
}

const wasm = (bytes: string) => () =>
  new Response(bytes, { headers: { "Content-Type": "application/wasm", "Content-Encoding": "br" } });

describe("answering the scanner's module", () => {
  it("fetches it the first time, keeps it, and answers it with no network from then on", async () => {
    const { caches, asked, get, offline } = harness({ [WASM]: wasm("the module") });
    const first = await get(WASM);
    expect(await first.text()).toBe("the module");
    expect(first.headers.get("Content-Type")).toBe("application/wasm");
    // The wire's encoding is not the stored body's.
    expect(first.headers.get("Content-Encoding")).toBeNull();
    expect(first.headers.get("Content-Length")).toBe("10");
    expect([...(await caches.open(SCANNER_CACHE)).entries.keys()]).toEqual([WASM]);
    // Not in this build's shell: a deploy must not take it.
    expect((await caches.open(shellCacheName("aaaa"))).entries.size).toBe(0);

    offline();
    expect(await (await get(WASM)).text()).toBe("the module");
    expect(asked).toEqual([WASM]);
  });

  it("lets go of another build's module when this build's is kept", async () => {
    const older = wasmPath("0ld", SCANNER_WASM_FILE);
    const { caches, get } = harness({ [WASM]: wasm("new"), [older]: wasm("old") });
    await get(older);
    const cache = await caches.open(SCANNER_CACHE);
    // The page's own files live in the same cache, and are nobody's to sweep.
    await cache.put(`${SCANNER_ASSETS_PREFIX}card-hashes.bin`, new Response("hashes"));
    await get(WASM);
    expect([...cache.entries.keys()].sort()).toEqual([`${SCANNER_ASSETS_PREFIX}card-hashes.bin`, WASM].sort());
  });

  it("keeps neither a miss nor a page handed over where the module should be", async () => {
    const html = () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
    const { caches, get } = harness({ [WASM]: html });
    expect((await get(GLUE)).status).toBe(404);
    expect(await (await get(WASM)).text()).toBe("<!doctype html>");
    expect((await caches.open(SCANNER_CACHE)).entries.size).toBe(0);
  });

  it("keeps a 200 and no other answer in the 2xx", async () => {
    const partial = () => new Response("part", { status: 206, headers: { "Content-Type": "application/wasm" } });
    const { caches, get } = harness({ [WASM]: partial });
    expect((await get(WASM)).status).toBe(206);
    expect((await caches.open(SCANNER_CACHE)).entries.size).toBe(0);
  });

  it("fails as the network fails when there is no copy and no network", async () => {
    const { get, offline } = harness({});
    offline();
    await expect(get(WASM)).rejects.toThrow("Failed to fetch");
  });
});
