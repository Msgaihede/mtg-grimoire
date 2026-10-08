import { describe, expect, it } from "vitest";
import scannerAssetsRs from "../../../../../crates/grimoire-core/src/scanner_assets.rs?raw";
import scannerRs from "../../../../../crates/grimoire-core/src/scanner.rs?raw";
import { SCANNER_ASSETS_PREFIX, SCANNER_CACHE } from "./assets";
import {
  ALREADY_FETCHING,
  createScanStore,
  EMPTY_BUNDLE,
  MODEL_SHA256,
  NO_DIGEST,
  NO_STORAGE,
  NOT_KEPT,
  owedRows,
  PROGRESS_STEP,
  readManifest,
  SCAN_FILES,
  SHA_HEADER,
  STALL_MS,
  UNREACHABLE,
  type ScanFile,
} from "./scanStore";
import { answered, digestOf, fakeBrowser, FILES, MANIFEST } from "./scanTesting";

const BUNDLE = MANIFEST.files[0];
const path = (name: string): string => `${SCANNER_ASSETS_PREFIX}${name}`;
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "it was not refused",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe("the scanner's files, as the core names them", () => {
  it("uses the keys, the labels and the names `scanner_assets::Piece` does", () => {
    const pieces = ["Bundle", "Detection", "Recognition"];
    SCAN_FILES.forEach(({ key, label }, at) => {
      expect(scannerAssetsRs).toContain(`Piece::${pieces[at]} => "${key}",`);
      expect(scannerAssetsRs).toContain(`Piece::${pieces[at]} => "${label}",`);
    });
    expect(scannerRs).toContain(`pub const BUNDLE_FILE: &str = "${SCAN_FILES[0].name}";`);
    expect(scannerRs).toContain(`pub const DETECTION_MODEL: &str = "models/${SCAN_FILES[1].name}";`);
    expect(scannerRs).toContain(
      `pub const RECOGNITION_MODEL: &str = "models/${SCAN_FILES[2].name}";`,
    );
  });

  it("refuses a second fetch in the core's sentence, and steps its progress as the core does", () => {
    expect(scannerAssetsRs).toContain(`pub const ALREADY_FETCHING: &str = "${ALREADY_FETCHING}";`);
    expect(scannerAssetsRs).toContain("const PROGRESS_STEP: u64 = 256 * 1024;");
    expect(PROGRESS_STEP).toBe(256 * 1024);
  });
});

describe("the models' digests, the sizes and the empty bundle, as the core writes them", () => {
  const declared = (name: string): string | undefined =>
    new RegExp(`pub const ${name}: &str =\\s*"([0-9a-f]{64})";`).exec(scannerAssetsRs)?.[1];
  const bytes = (name: string): number =>
    Number(new RegExp(`pub const ${name}: u64 = ([0-9_]+);`).exec(scannerAssetsRs)?.[1].replace(/_/g, ""));

  it("holds the page's two digests to the Rust text", () => {
    expect(declared("DETECTION_SHA256")).toMatch(/^[0-9a-f]{64}$/);
    expect(MODEL_SHA256.detectionModel).toBe(declared("DETECTION_SHA256"));
    expect(MODEL_SHA256.recognitionModel).toBe(declared("RECOGNITION_SHA256"));
    // And pins no bundle: it is rebuilt every week.
    expect(Object.keys(MODEL_SHA256).sort()).toEqual(["detectionModel", "recognitionModel"]);
  });

  it("offers each file, when no manifest can be had, at the size the core says it is", () => {
    expect(SCAN_FILES.map((file) => file.about)).toEqual([
      bytes("BUNDLE_BYTES"),
      bytes("DETECTION_BYTES"),
      bytes("RECOGNITION_BYTES"),
    ]);
    expect(SCAN_FILES.every((file) => file.about > 1_000_000)).toBe(true);
  });

  it("calls a bundle with no card in it what the core calls one", () => {
    expect(scannerAssetsRs).toContain(`"${EMPTY_BUNDLE}"`);
  });
});

describe("the build's manifest", () => {
  it("reads the three files and the bundle's format", () => {
    expect(readManifest(JSON.parse(JSON.stringify(MANIFEST)))).toEqual(MANIFEST);
  });

  it("refuses anything that is not exactly the three, each with a length and a digest", () => {
    const without = (key: string) => MANIFEST.files.filter((file) => file.key !== key);
    const not: unknown[] = [
      null,
      "manifest",
      { files: MANIFEST.files },
      { formatVersion: "3", files: MANIFEST.files },
      { formatVersion: 3, files: without("bundle") },
      { formatVersion: 3, files: [...MANIFEST.files, { ...BUNDLE, key: "fourth" }] },
      { formatVersion: 3, files: [{ ...BUNDLE, name: "other.bin" }, ...without("bundle")] },
      { formatVersion: 3, files: [{ ...BUNDLE, bytes: 0 }, ...without("bundle")] },
      { formatVersion: 3, files: [{ ...BUNDLE, sha256: "abc" }, ...without("bundle")] },
    ];
    for (const value of not) expect(readManifest(value), JSON.stringify(value)).toBeNull();
  });
});

describe("what is owed", () => {
  const none = { bundle: null, detectionModel: null, recognitionModel: null };
  const all = Object.fromEntries(
    MANIFEST.files.map((file) => [file.key, { bytes: file.bytes, sha256: file.sha256 }]),
  ) as Parameters<typeof owedRows>[1];

  it("is all three, in the core's shape, when the store holds nothing", () => {
    expect(owedRows(MANIFEST, none)).toEqual([
      { key: "bundle", label: "Card hashes", bytes: 700 },
      { key: "detectionModel", label: "Text detection model", bytes: 300 },
      { key: "recognitionModel", label: "Text recognition model", bytes: 500 },
    ]);
  });

  it("is nothing once each is held as the manifest describes it", () => {
    expect(owedRows(MANIFEST, all)).toEqual([]);
  });

  it("owes the bundle again when a release rebuilt it under the same name", () => {
    const rebuilt = {
      ...MANIFEST,
      files: [{ ...BUNDLE, bytes: 720, sha256: "f".repeat(64) }, ...MANIFEST.files.slice(1)],
    };
    expect(owedRows(rebuilt, all).map((row) => row.key)).toEqual(["bundle"]);
    // The same length is not the same file: the digest is what is compared.
    const sameLength = {
      ...MANIFEST,
      files: [{ ...BUNDLE, sha256: "e".repeat(64) }, ...MANIFEST.files.slice(1)],
    };
    expect(owedRows(sameLength, all).map((row) => row.key)).toEqual(["bundle"]);
  });
});

describe("the store", () => {
  it("asks the origin for the manifest afresh each time, past the HTTP cache", async () => {
    const browser = fakeBrowser();
    const store = createScanStore(browser.env);
    expect(await store.manifest()).toEqual({ kind: "ok", manifest: MANIFEST });
    await store.manifest();
    expect(browser.asked).toEqual([path("manifest.json"), path("manifest.json")]);
  });

  it("reads a 404 as a build made without the files, and anything else as unreachable", async () => {
    const missing = fakeBrowser({ [path("manifest.json")]: () => answered("Not found", { status: 404 }) });
    expect(await createScanStore(missing.env).manifest()).toEqual({ kind: "missing" });

    const down = fakeBrowser({ [path("manifest.json")]: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(await createScanStore(down.env).manifest()).toEqual({ kind: "unreachable", message: UNREACHABLE });

    const garbled = fakeBrowser({ [path("manifest.json")]: () => answered("<!doctype html>") });
    expect((await createScanStore(garbled.env).manifest()).kind).toBe("unreachable");

    const broken = fakeBrowser({ [path("manifest.json")]: () => answered("no", { status: 503 }) });
    expect(await createScanStore(broken.env).manifest()).toMatchObject({
      kind: "unreachable",
      message: expect.stringContaining("503"),
    });
  });

  it("holds nothing at first, and does not create its cache by being asked", async () => {
    const browser = fakeBrowser();
    const store = createScanStore(browser.env);
    expect(await store.kept()).toEqual({ bundle: null, detectionModel: null, recognitionModel: null });
    expect(await store.read("bundle")).toBeNull();
    expect(await browser.caches.keys()).toEqual([]);
  });

  it("fetches a file to its end, hears every chunk, checks it, and only then keeps it", async () => {
    const browser = fakeBrowser();
    const store = createScanStore(browser.env);
    const heard: number[] = [];
    let checking = 0;
    await store.fetch(BUNDLE, (bytes) => heard.push(bytes), () => (checking += 1));
    expect(heard).toEqual([256, 256, 188]);
    expect(checking).toBe(1);
    expect(browser.asked).toEqual([path("card-hashes.bin")]);

    const kept = await store.kept();
    expect(kept.bundle).toEqual({ bytes: 700, sha256: BUNDLE.sha256 });
    expect(kept.detectionModel).toBeNull();
    expect(await store.read("bundle")).toEqual(FILES["card-hashes.bin"]);
    const entry = await (await browser.caches.open(SCANNER_CACHE)).match(path("card-hashes.bin"));
    expect(entry?.headers.get(SHA_HEADER)).toBe(BUNDLE.sha256);
    expect(entry?.headers.get("Content-Length")).toBe("700");
  });

  const refused: [string, () => ReturnType<typeof answered> | Promise<never>, RegExp][] = [
    ["a file cut short", () => answered(FILES["card-hashes.bin"].slice(0, 699)), /arrived as 699 bytes where 700 were expected/],
    ["a file that runs long", () => answered(new Uint8Array(701)), /more than the 700 bytes/],
    ["bytes that are not the file", () => answered(new Uint8Array(700)), /did not arrive as the file this version expects/],
    ["a server that says no", () => answered("no", { status: 503 }), /the server answered 503/],
    ["a page where the file should be", () => answered("<html>", { type: "text/html; charset=utf-8" }), /answered a page, not the file/],
    ["no network", () => Promise.reject(new TypeError("Failed to fetch")), /Check your connection/],
  ];
  it.each(refused)("keeps nothing of %s, and says why in one sentence", async (_what, answer, sentence) => {
    const browser = fakeBrowser({ [path("card-hashes.bin")]: answer });
    const store = createScanStore(browser.env);
    expect(await refusal(store.fetch(BUNDLE, () => undefined))).toMatch(sentence);
    expect((await store.kept()).bundle).toBeNull();
    expect(await store.read("bundle")).toBeNull();
  });

  it("gives up a download that hears nothing, rather than holding the claim for good", async () => {
    const browser = fakeBrowser({ [path("card-hashes.bin")]: () => new Promise<never>(() => undefined) });
    const store = createScanStore(browser.env);
    const ended = refusal(store.fetch(BUNDLE, () => undefined));
    browser.advance(STALL_MS);
    expect(await ended).toBe(UNREACHABLE);
  });

  it("deletes an entry whose body is not the length it was kept at, and owes it again", async () => {
    const browser = fakeBrowser();
    const store = createScanStore(browser.env);
    await store.fetch(BUNDLE, () => undefined);
    const cache = await browser.caches.open(SCANNER_CACHE);
    await cache.put(
      path("card-hashes.bin"),
      new Response(new Uint8Array(10), { headers: { "Content-Length": "700", [SHA_HEADER]: BUNDLE.sha256 } }),
    );
    expect(await store.read("bundle")).toBeNull();
    expect((await store.kept()).bundle).toBeNull();
  });

  it("replaces a file a later release rebuilt, under the same address", async () => {
    const browser = fakeBrowser();
    const store = createScanStore(browser.env);
    await store.fetch(BUNDLE, () => undefined);
    const newer = Uint8Array.from({ length: 720 }, (_, i) => (i * 3) % 256);
    const rebuilt: ScanFile = { ...BUNDLE, bytes: 720, sha256: digestOf(newer) };
    const later = fakeBrowser({ [path("card-hashes.bin")]: () => answered(newer) });
    // The same Cache Storage, a later deploy's origin.
    const again = createScanStore({ ...later.env, caches: browser.caches });
    await again.fetch(rebuilt, () => undefined);
    expect((await again.kept()).bundle).toEqual({ bytes: 720, sha256: rebuilt.sha256 });
    expect(await again.read("bundle")).toEqual(newer);
  });

  it("says a browser with no Cache Storage has nowhere to keep them, before asking for a byte", async () => {
    const browser = fakeBrowser();
    const store = createScanStore({ ...browser.env, caches: undefined });
    expect(await refusal(store.fetch(BUNDLE, () => undefined))).toBe(NO_STORAGE);
    expect(browser.asked).toEqual([]);
    expect(await store.kept()).toEqual({ bundle: null, detectionModel: null, recognitionModel: null });
  });

  it("keeps nothing it cannot hash, and asks for no byte of it", async () => {
    // Kept unchecked, a file sat under the manifest's digest — and a model is handed to the
    // module because the digest it is kept under is the pinned one.
    const browser = fakeBrowser({ [path("card-hashes.bin")]: () => answered(new Uint8Array(700)) });
    const store = createScanStore({ ...browser.env, digest: undefined });
    expect(await refusal(store.fetch(BUNDLE, () => undefined))).toBe(NO_DIGEST);
    expect(browser.asked).toEqual([]);
    expect((await store.kept()).bundle).toBeNull();
  });

  it("says a store that would not take the file in a sentence with no browser's reason in it", async () => {
    const browser = fakeBrowser();
    const full = {
      ...browser.caches,
      keys: () => browser.caches.keys(),
      delete: (name: string) => browser.caches.delete(name),
      open: () => Promise.reject(new DOMException("Quota exceeded.", "QuotaExceededError")),
    };
    const store = createScanStore({ ...browser.env, caches: full });
    expect(await refusal(store.fetch(BUNDLE, () => undefined))).toBe(NOT_KEPT);
  });
});
