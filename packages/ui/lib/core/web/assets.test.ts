import { describe, expect, it } from "vitest";
import cardNeuralRs from "../../../../../crates/card-neural/src/lib.rs?raw";
import cardNeuralEvidenceRs from "../../../../../crates/card-neural/src/evidence.rs?raw";
import neuralReadme from "../../../../../crates/card-neural/models/README.md?raw";
import { WEB_IMAGE_PREFIX } from "../../images";
import {
  buildIdOf,
  HOST_FILE_LIMIT,
  isNavigation,
  isNeuralFile,
  isScannerFile,
  NEURAL_EVIDENCE_FILES,
  NEURAL_FILES,
  NEURAL_PREFIX,
  neuralBytesOf,
  neuralContentType,
  neuralEvidenceFault,
  neuralFault,
  neuralFileOf,
  neuralPath,
  neuralTable,
  NOT_A_PLACE,
  SCANNER_ASSETS_PREFIX,
  wasmContentType,
  wasmFileOf,
  wasmPath,
  wasmUrls,
} from "./assets";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe("where a build's engine is served from", () => {
  it("puts the build id in the path of both files", () => {
    expect(wasmUrls("https://grimoire.example", "abc123")).toEqual({
      glue: "https://grimoire.example/wasm/abc123/grimoire_web.js",
      wasm: "https://grimoire.example/wasm/abc123/grimoire_web_bg.wasm",
    });
  });

  it("moves both addresses when the build does", () => {
    // The names are fixed, so the id is the only thing that tells two builds' files apart to
    // anything that keeps a response by its URL.
    const one = wasmUrls("https://grimoire.example", "one");
    const two = wasmUrls("https://grimoire.example", "two");
    expect(two.glue).not.toBe(one.glue);
    expect(two.wasm).not.toBe(one.wasm);
  });

  it("keeps the module beside the glue, where the glue looks for it by its own address", () => {
    const { glue, wasm } = wasmUrls("http://localhost:5176", "dev");
    expect(new URL("grimoire_web_bg.wasm", glue).href).toBe(wasm);
  });

  it("reads a request back to the file it asks for, whatever build it names", () => {
    expect(wasmFileOf(wasmPath("abc123", "grimoire_web.js"))).toBe("grimoire_web.js");
    expect(wasmFileOf("/wasm/dev/grimoire_web_bg.wasm")).toBe("grimoire_web_bg.wasm");
    // What the glue imports beside itself is under the same folder.
    expect(wasmFileOf("/wasm/dev/snippets/sqlite-1a2b/inline0.js")).toBe(
      "snippets/sqlite-1a2b/inline0.js",
    );
  });

  it("answers nothing for a path outside the engine's folder, or one that climbs out of it", () => {
    expect(wasmFileOf("/assets/index-abc.js")).toBeNull();
    expect(wasmFileOf("/wasm/grimoire_web.js")).toBeNull();
    expect(wasmFileOf("/wasm/dev/")).toBeNull();
    expect(wasmFileOf("/wasm/dev/../../package.json")).toBeNull();
    expect(wasmFileOf("/wasm/dev/snippets//x.js")).toBeNull();
    // One segment to a split on `/`, and a climb on a disk whose separator is a backslash too.
    expect(wasmFileOf("/wasm/dev/..\\package.json")).toBeNull();
    expect(wasmFileOf("/wasm/dev/snippets\\..\\..\\package.json")).toBeNull();
    expect(wasmFileOf("/wasm/dev/%2e%2e/package.json")).toBeNull();
    expect(wasmFileOf("/wasm/dev/./grimoire_web.js")).toBeNull();
  });

  it("names the module as wasm, which a streaming instantiate checks", () => {
    expect(wasmContentType("grimoire_web_bg.wasm")).toBe("application/wasm");
    expect(wasmContentType("grimoire_web.js")).toBe("text/javascript");
    expect(wasmContentType("snippets/x/inline0.js")).toBe("text/javascript");
  });
});

describe("a build's id", () => {
  const glue = { name: "grimoire_web.js", bytes: bytes(1, 2, 3) };
  const wasm = { name: "grimoire_web_bg.wasm", bytes: bytes(0, 97, 115, 109) };

  it("is the same for the same engine, in whatever order the folder was listed", () => {
    expect(buildIdOf([glue, wasm])).toBe(buildIdOf([wasm, glue]));
    expect(buildIdOf([glue, wasm])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("moves when one byte of either file does", () => {
    const id = buildIdOf([glue, wasm]);
    expect(buildIdOf([glue, { ...wasm, bytes: bytes(0, 97, 115, 110) }])).not.toBe(id);
    expect(buildIdOf([{ ...glue, bytes: bytes(1, 2, 4) }, wasm])).not.toBe(id);
  });

  it("moves when a file is renamed, added, or a byte crosses from one file to the next", () => {
    const id = buildIdOf([glue, wasm]);
    expect(buildIdOf([{ ...glue, name: "grimoire_web2.js" }, wasm])).not.toBe(id);
    expect(buildIdOf([glue, wasm, { name: "snippets/a.js", bytes: bytes() }])).not.toBe(id);
    expect(
      buildIdOf([
        { name: "a", bytes: bytes(1, 2) },
        { name: "b", bytes: bytes(3) },
      ]),
    ).not.toBe(
      buildIdOf([
        { name: "a", bytes: bytes(1) },
        { name: "b", bytes: bytes(2, 3) },
      ]),
    );
  });
});

describe("a page navigation", () => {
  const HTML = "text/html,application/xhtml+xml";

  it("is a GET for a document at a path with no file on the end", () => {
    expect(isNavigation("GET", HTML, "/")).toBe(true);
    expect(isNavigation("GET", HTML, "/decks/12")).toBe(true);
    // A dot further up the path is part of a route, not an extension.
    expect(isNavigation("GET", HTML, "/decks/v1.2/cards")).toBe(true);
  });

  it("is not a file, a Vite internal, a script's request or a write", () => {
    expect(isNavigation("GET", HTML, "/assets/index-abc.js")).toBe(false);
    expect(isNavigation("GET", HTML, "/wasm/dev/grimoire_web.js")).toBe(false);
    expect(isNavigation("GET", HTML, "/@vite/client")).toBe(false);
    // What a script, a stylesheet or a Worker's import asks with: handing it the document would
    // answer a missing file with a page and a 200.
    expect(isNavigation("GET", "*/*", "/decks/12")).toBe(false);
    expect(isNavigation("GET", undefined, "/decks/12")).toBe(false);
    expect(isNavigation("POST", HTML, "/decks/12")).toBe(false);
  });

  /**
   * **Nothing under a reserved tree is a place, whatever it is asked with or called.** A chunk a
   * deploy renamed and a picture asked for before the service worker controls the page are both
   * paths whose last segment can lack an extension — and the document there is a 200 of HTML to
   * a caller that asked for a file. The dev server, the preview, the smoke run and the hosting
   * Worker all answer by this one function.
   */
  it("is nothing under the trees that hold files, pictures or the host's own configuration", () => {
    for (const path of [
      "/assets/chunk",
      "/assets/",
      "/wasm/0123456789abcdef/grimoire_web",
      "/mtgimg/display/abc/0",
      "/mtgimg/",
      "/_headers",
    ]) {
      expect(isNavigation("GET", HTML, path), path).toBe(false);
    }
    // A route that merely starts with the same letters is still a place.
    expect(isNavigation("GET", HTML, "/assetsmith")).toBe(true);
    expect(isNavigation("GET", HTML, "/decks/assets/1")).toBe(true);
  });

  /** The picture tree is spelled here, in a module a Vite config and a bare Node script can
   *  import without the app behind it — and held to the constant every picture address is built
   *  from, so the two cannot come to name different trees. */
  it("reserves the tree card pictures are asked under", () => {
    expect(NOT_A_PLACE).toContain(WEB_IMAGE_PREFIX + "/");
  });
});

describe("where the Neural scanner's four files are served from", () => {
  it("names them as `card-neural` does, in the order `load_neural` takes them", () => {
    const declared = (constant: string): string | undefined =>
      new RegExp(`pub const ${constant}: &str = "([^"]+)";`).exec(cardNeuralRs)?.[1];
    expect(NEURAL_FILES).toEqual(
      ["DETECTOR_FILE", "EMBEDDER_FILE", "GALLERY_FILE", "META_FILE"].map(declared),
    );
  });

  it("names the four evidence files as `card_neural::evidence` does, in `load_neural_evidence`'s order", () => {
    const declared = (constant: string): string | undefined =>
      new RegExp(`pub const ${constant}: &str = "([^"]+)";`).exec(cardNeuralEvidenceRs)?.[1];
    expect(NEURAL_EVIDENCE_FILES).toEqual(
      ["SYMBOL_NET_FILE", "BAND_NET_FILE", "SYMBOLS_FILE", "BANDS_FILE"].map(declared),
    );
    // Apart from the recogniser's four: the evidence is a set beside it, never in place of it.
    for (const name of NEURAL_EVIDENCE_FILES) expect(NEURAL_FILES).not.toContain(name);
  });

  it("puts the set in the path, so a new gallery is a new address", () => {
    expect(neuralPath("0123abcd", "gallery.bin")).toBe("/scanner-neural/0123abcd/gallery.bin");
    expect(neuralPath("one", "gallery.bin")).not.toBe(neuralPath("two", "gallery.bin"));
    expect(neuralPath("dev", "neural.json").startsWith(NEURAL_PREFIX)).toBe(true);
  });

  it("knows a Neural file at any set's address, and reads back only the four by name", () => {
    expect(isNeuralFile("/scanner-neural/0123abcd/detector.onnx")).toBe(true);
    expect(isNeuralFile("/scanner-neural/detector.onnx")).toBe(false);
    expect(isNeuralFile("/scanner-neural/a/b/detector.onnx")).toBe(false);
    expect(isNeuralFile("/scanner-assets/card-hashes.bin")).toBe(false);
    for (const name of [...NEURAL_FILES, ...NEURAL_EVIDENCE_FILES])
      expect(neuralFileOf(neuralPath("dev", name))).toBe(name);
    for (const path of [
      "/scanner-neural/dev/README.md",
      "/scanner-neural/dev/../detector.onnx",
      "/scanner-neural/dev/",
      "/scanner-neural/detector.onnx",
      "/wasm/dev/detector.onnx",
    ]) {
      expect(neuralFileOf(path), path).toBeNull();
    }
  });

  it("is in no precache, and nowhere a page", () => {
    for (const name of [...NEURAL_FILES, ...NEURAL_EVIDENCE_FILES])
      expect(isScannerFile(neuralPath("ab12", name).slice(1)), name).toBe(true);
    expect(NOT_A_PLACE).toContain(NEURAL_PREFIX);
    expect(isNavigation("GET", "text/html", "/scanner-neural/ab12/gallery")).toBe(false);
    // Its own tree, not the three files' — those are revalidated, these are kept a year.
    expect(NEURAL_PREFIX.startsWith(SCANNER_ASSETS_PREFIX)).toBe(false);
  });

  it("serves the constants as JSON and the rest as bytes", () => {
    expect(neuralContentType("neural.json")).toBe("application/json");
    for (const name of [
      "detector.onnx",
      "embedder.onnx",
      "gallery.bin",
      ...NEURAL_EVIDENCE_FILES,
    ]) {
      expect(neuralContentType(name)).toBe("application/octet-stream");
    }
  });
});

describe("what a web build holds the Neural files to", () => {
  const table = neuralTable(neuralReadme);
  const sha = (head: string, tail: string): string => head + "0".repeat(48) + tail;
  const asTabled = NEURAL_FILES.map((name) => {
    const row = table.get(name)!;
    return { name, bytes: row.bytes, sha256: sha(row.head, row.tail) };
  });

  it("reads models/README.md's table: a length and the two ends of a digest for each of the eight", () => {
    expect([...table.keys()].sort()).toEqual([...NEURAL_FILES, ...NEURAL_EVIDENCE_FILES].sort());
    for (const [name, row] of table) {
      expect(row.bytes, name).toBeGreaterThan(0);
      expect(row.head, name).toMatch(/^[0-9a-f]{8}$/);
      expect(row.tail, name).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("ships what the table describes, each under the host's 25 MiB", () => {
    expect(neuralFault(asTabled, table)).toBeNull();
    for (const row of table.values()) expect(row.bytes).toBeLessThan(HOST_FILE_LIMIT);
  });

  it("refuses a set that is not the one the table describes, saying which file and why", () => {
    const changed = (name: string, edit: Partial<{ bytes: number; sha256: string }>) =>
      asTabled.map((file) => (file.name === name ? { ...file, ...edit } : file));
    expect(neuralFault(changed("gallery.bin", { bytes: 1 }), table)).toMatch(
      /^gallery\.bin is 1 bytes/,
    );
    const embedder = table.get("embedder.onnx")!;
    expect(neuralFault(changed("embedder.onnx", { sha256: "f".repeat(64) }), table)).toBe(
      `embedder.onnx is ${embedder.bytes} bytes with SHA-256 ${"f".repeat(64)}, and ` +
        `crates/card-neural/models/README.md says ${embedder.bytes} bytes and ${embedder.head}…${embedder.tail}.`,
    );
    expect(neuralFault(asTabled.slice(1), table)).toBe(
      "crates/card-neural/models/ has no detector.onnx.",
    );
    expect(neuralFault(changed("detector.onnx", { bytes: HOST_FILE_LIMIT + 1 }), table)).toMatch(
      /over the host's 26214400 a file/,
    );
    expect(neuralFault(asTabled, new Map())).toBe(
      "crates/card-neural/models/README.md has no row for detector.onnx.",
    );
  });

  /** Evidence rows of this suite's own, built alike, so the faults read apart from the files in git. */
  const evidenceTable = new Map(
    NEURAL_EVIDENCE_FILES.map((name, at) => [
      name,
      { bytes: 1_000 + at, head: `0000000${at}`, tail: `ffffff0${at}` },
    ]),
  );
  const evidenceAsTabled = NEURAL_EVIDENCE_FILES.map((name) => {
    const row = evidenceTable.get(name)!;
    return { name, bytes: row.bytes, sha256: sha(row.head, row.tail) };
  });

  it("holds the four evidence files to the table apart, so the recogniser ships without them", () => {
    // `neuralFault` asks after the recogniser's four alone: a build with no evidence ships.
    expect(neuralFault(asTabled, table)).toBeNull();
    expect(neuralEvidenceFault([...asTabled, ...evidenceAsTabled], evidenceTable)).toBeNull();
    expect(neuralEvidenceFault(evidenceAsTabled, evidenceTable)).toBeNull();
    expect(neuralEvidenceFault(evidenceAsTabled.slice(0, 3), evidenceTable)).toBe(
      "crates/card-neural/models/ has no bands.bin.",
    );
    expect(neuralEvidenceFault(asTabled, table)).toBe(
      "crates/card-neural/models/ has no symbol.onnx.",
    );
    expect(neuralEvidenceFault(evidenceAsTabled, new Map())).toBe(
      "crates/card-neural/models/README.md has no row for symbol.onnx.",
    );
    const longer = evidenceAsTabled.map((file) =>
      file.name === "symbols.bin" ? { ...file, bytes: file.bytes + 1 } : file,
    );
    expect(neuralEvidenceFault(longer, evidenceTable)).toMatch(/^symbols\.bin is 1003 bytes/);
    const huge = evidenceAsTabled.map((file) =>
      file.name === "band.onnx" ? { ...file, bytes: HOST_FILE_LIMIT + 1 } : file,
    );
    expect(neuralEvidenceFault(huge, evidenceTable)).toMatch(/over the host's 26214400 a file/);
  });

  it("hands the page the eight lengths, and nothing it cannot read", () => {
    expect(
      neuralBytesOf('{"detector.onnx":3,"gallery.bin":7,"bands.bin":11,"README.md":9}'),
    ).toEqual({
      "detector.onnx": 3,
      "gallery.bin": 7,
      "bands.bin": 11,
    });
    for (const text of [
      undefined,
      "",
      "{not json",
      "null",
      "[3]",
      '{"detector.onnx":"3"}',
      '{"detector.onnx":-1}',
    ]) {
      expect(neuralBytesOf(text), String(text)).toEqual({});
    }
  });
});
