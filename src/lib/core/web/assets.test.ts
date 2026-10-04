import { describe, expect, it } from "vitest";
import { WEB_IMAGE_PREFIX } from "../../images";
import {
  buildIdOf,
  isNavigation,
  NOT_A_PLACE,
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
