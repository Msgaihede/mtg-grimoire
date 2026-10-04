import { describe, expect, it } from "vitest";
import {
  DOCUMENT,
  precacheList,
  routeFor,
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

  it("reads a picture by its path, before it reads the mode", () => {
    const ask = { key: `${ORIGIN}/mtgimg/display/abc/0`, path: "/display/abc/0" };
    expect(route(get("/mtgimg/display/abc/0"))).toEqual({ kind: "picture", ask });
    // Opened in a tab of its own: still the picture, never the app.
    expect(route(get("/mtgimg/display/abc/0", "navigate"))).toEqual({ kind: "picture", ask });
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
