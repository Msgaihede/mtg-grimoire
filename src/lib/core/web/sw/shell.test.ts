import { describe, expect, it } from "vitest";
import {
  DOCUMENT,
  precacheList,
  routeFor,
  shellBuildId,
  shellCacheName,
  staleShells,
  type Routable,
} from "./shell";

const ORIGIN = "https://mtg-grimoire.app";
const PRECACHED = new Set(["/", "/light.webmanifest", "/assets/index-abc.js"]);

const get = (path: string, mode = "no-cors"): Routable => ({
  url: path.startsWith("http") ? path : `${ORIGIN}${path}`,
  method: "GET",
  mode,
});
const route = (request: Routable) => routeFor(request, ORIGIN, PRECACHED);

describe("the shell cache's name", () => {
  it("carries the build, so two versions never share a cache", () => {
    expect(shellCacheName("aaaa")).toBe("grimoire-shell-aaaa");
    expect(shellCacheName("aaaa")).not.toBe(shellCacheName("bbbb"));
  });

  it("calls every other build's shell stale, and nothing that is not a shell", () => {
    const names = ["grimoire-shell-aaaa", "grimoire-shell-bbbb", "grimoire-pictures-v1", "other"];
    // The pictures belong to no build: an activation that deleted them would re-download every
    // card on every deploy.
    expect(staleShells(names, "bbbb")).toEqual(["grimoire-shell-aaaa"]);
    expect(staleShells(names, "cccc")).toEqual(["grimoire-shell-aaaa", "grimoire-shell-bbbb"]);
  });
});

describe("what a build precaches", () => {
  it("is the document as the root, then every served file by its own path, sorted", () => {
    expect(
      precacheList([
        "wasm/099d/grimoire_web_bg.wasm",
        "index.html",
        "assets/worker-x.js",
        "assets/index-a.js",
        "light.webmanifest",
        "wasm/099d/grimoire_web.js",
      ]),
    ).toEqual([
      DOCUMENT,
      "/assets/index-a.js",
      "/assets/worker-x.js",
      "/light.webmanifest",
      "/wasm/099d/grimoire_web.js",
      "/wasm/099d/grimoire_web_bg.wasm",
    ]);
  });

  it("leaves out the worker itself and the files a host reads rather than serves", () => {
    // One 404 fails the whole install, so a file listed must be one the host answers.
    expect(precacheList(["index.html", "sw.js", "_headers", "_redirects", ".vite/manifest.json"]))
      .toEqual([DOCUMENT]);
  });

  it("keeps a chunk whose name starts with an underscore: only a top-level entry is the host's", () => {
    expect(precacheList(["index.html", "assets/_helpers-a.js"])).toEqual([
      DOCUMENT,
      "/assets/_helpers-a.js",
    ]);
  });

  it("does not move with the order the files were listed in", () => {
    const files = ["b.svg", "index.html", "assets/a.js"];
    expect(precacheList(files)).toEqual(precacheList([...files].reverse()));
  });
});

describe("a build's id", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const build = (headers: string) => [
    { name: "index.html", bytes: bytes("<html></html>") },
    { name: "assets/index-a.js", bytes: bytes("console.log('a')") },
    { name: "_headers", bytes: bytes(headers) },
  ];
  const POLICY = "/*\n  Content-Security-Policy: default-src 'self'\n";

  /**
   * What the hosting step rests on: the policy is a file the host reads and never serves, so
   * nothing precaches it — and a deploy that changed only the policy must still be a new worker,
   * or a returning reader keeps the old headers on every file their shell cache holds.
   */
  it("moves when only the host's `_headers` changed, though the precache list does not", () => {
    const before = build(POLICY);
    const after = build(POLICY.replace("'self'", "'self' https://cards.scryfall.io"));

    expect(shellBuildId(after)).not.toBe(shellBuildId(before));
    const names = (files: { name: string }[]) => files.map(({ name }) => name);
    expect(precacheList(names(after))).toEqual(precacheList(names(before)));
    expect(precacheList(names(after))).not.toContain("/_headers");
  });

  it("moves when any served file changed by a byte, and not when nothing did", () => {
    const one = build(POLICY);
    const same = build(POLICY);
    expect(shellBuildId(same)).toBe(shellBuildId(one));
    same[1] = { name: "assets/index-a.js", bytes: bytes("console.log('b')") };
    expect(shellBuildId(same)).not.toBe(shellBuildId(one));
  });

  it("does not hash the worker itself — its bytes hold the id", () => {
    // On a second build over the same folder the last build's `sw.js` is on disk. Hashed, the
    // id would never settle: every build's worker would be new.
    const files = build(POLICY);
    const again = [...files, { name: "sw.js", bytes: bytes("the last build's worker") }];
    expect(shellBuildId(again)).toBe(shellBuildId(files));
  });

  it("does not move with the order the files were listed in", () => {
    const files = build(POLICY);
    expect(shellBuildId([...files].reverse())).toBe(shellBuildId(files));
  });
});

describe("which request is whose", () => {
  it("answers a navigation to any place with the document's route", () => {
    for (const path of ["/", "/search", "/decks/12", "/collection?card=abc", "/v1.2/notes"]) {
      expect(route(get(path, "navigate"))).toEqual({ kind: "navigation" });
    }
  });

  it("answers the build's own files from the shell, by path", () => {
    expect(route(get("/assets/PhoneApp-zTz.js", "cors"))).toEqual({
      kind: "shell",
      key: "/assets/PhoneApp-zTz.js",
    });
    expect(route(get("/wasm/099d/grimoire_web_bg.wasm", "cors"))).toEqual({
      kind: "shell",
      key: "/wasm/099d/grimoire_web_bg.wasm",
    });
    // Not under either folder, and precached all the same.
    expect(route(get("/light.webmanifest"))).toEqual({ kind: "shell", key: "/light.webmanifest" });
  });

  it("never gives a file the document's route, however it was asked for", () => {
    // A script, a Worker's import and a missing chunk: each is the shell's or the network's.
    expect(route(get("/assets/gone-123.js", "cors")).kind).toBe("shell");
    expect(route(get("/missing.js", "cors"))).toEqual({ kind: "passthrough" });
    expect(route(get("/sw.js", "same-origin"))).toEqual({ kind: "passthrough" });
    // And a file opened in a tab of its own is the file, not the app.
    expect(route(get("/assets/index-abc.js", "navigate")).kind).toBe("shell");
    expect(route(get("/missing.png", "navigate"))).toEqual({ kind: "passthrough" });
  });

  it("leaves every other origin alone — the engine's downloads stream past untouched", () => {
    for (const url of [
      "https://data.scryfall.io/default-cards/default-cards-20261004090546.jsonl.gz",
      "https://api.scryfall.com/bulk-data/default_cards",
      "https://cards.scryfall.io/normal/front/a/b/abc.jpg?1",
      "https://json.commanderspellbook.com/variants.json.gz",
    ]) {
      expect(route(get(url, "cors"))).toEqual({ kind: "passthrough" });
    }
  });

  it("leaves anything that is not a GET alone, a picture's address included", () => {
    expect(route({ url: `${ORIGIN}/mtgimg/display/abc/0`, method: "POST", mode: "cors" })).toEqual({
      kind: "passthrough",
    });
    expect(route({ url: "not a url", method: "GET", mode: "cors" })).toEqual({
      kind: "passthrough",
    });
  });

  it("reads a picture by its path, however an `<img>` or a script asks for it", () => {
    const ask = { key: `${ORIGIN}/mtgimg/display/abc/0`, path: "/display/abc/0" };
    for (const mode of ["no-cors", "cors", "same-origin"]) {
      expect(route(get("/mtgimg/display/abc/0", mode))).toEqual({ kind: "picture", ask });
    }
  });

  it("answers a navigation to a picture's address with neither the picture nor the app", () => {
    // A tab, a frame, a link. The app's document there would be a place that does not exist;
    // the stored response there would be the one way a stored body could be run as a document
    // on the app's own origin. A refusal is both answers.
    expect(route(get("/mtgimg/display/abc/0", "navigate"))).toEqual({ kind: "not-a-picture" });
    expect(route(get("/mtgimg/display/abc/0?retry=1", "navigate"))).toEqual({ kind: "not-a-picture" });
    expect(route(get("/mtgimg", "navigate"))).toEqual({ kind: "not-a-picture" });
  });

  it("refuses what is under the picture prefix and is not a picture", () => {
    for (const path of ["/mtgimg", "/mtgimg/", "/mtgimg/png/abc/0", "/mtgimg/display/abc"]) {
      expect(route(get(path))).toEqual({ kind: "not-a-picture" });
    }
  });

  it("does not take a place that merely starts with the prefix's letters", () => {
    expect(route(get("/mtgimgs", "navigate"))).toEqual({ kind: "navigation" });
  });
});
