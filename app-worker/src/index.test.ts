import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";

/**
 * The hosting Worker, driven as `worker.fetch(request, env)` over a fake of the assets binding —
 * `share-worker/src/*.test.ts`'s arrangement, and for its reason: there is no workerd in this
 * tree, so the handler is a plain function over an injected `Env`.
 *
 * **The fake answers the way the real binding does under `single-page-application`**: a path
 * that is a file is that file, and *every other path is the document with a 200*. That is the
 * behaviour the script exists to keep away from a missing file, so a script that deferred a
 * missing chunk to the binding would get HTML back and fail here — where a fake that answered an
 * unknown path with a 404 would pass that mistake unseen.
 */

const DOCUMENT = "<!doctype html><title>MTG Grimoire</title>";

interface Fake {
  env: Env;
  /** Every path the script asked the binding for, in order. */
  asked: string[];
}

function hosting(files: Record<string, string> = {}): Fake {
  const asked: string[] = [];
  const fetcher = {
    fetch(input: Request): Promise<Response> {
      const path = new URL(input.url).pathname;
      asked.push(path);
      const file = files[path];
      if (file !== undefined) return Promise.resolve(new Response(file));
      return Promise.resolve(
        new Response(DOCUMENT, { headers: { "content-type": "text/html; charset=utf-8" } }),
      );
    },
  };
  return { env: { ASSETS: fetcher as unknown as Fetcher }, asked };
}

const ORIGIN = "https://mtg-grimoire.app";

function ask(path: string, init: { method?: string; accept?: string } = {}): Request {
  const headers = new Headers();
  if (init.accept !== undefined) headers.set("accept", init.accept);
  return new Request(ORIGIN + path, { method: init.method ?? "GET", headers });
}

/** What a browser sends for a navigation, a script and a `fetch`, in that order. */
const PAGE = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const ANYTHING = "*/*";

describe("a file that is not there", () => {
  // Each of these reaches the script only because no file matched: a file that exists is served
  // at the edge and never arrives here.
  it.each([
    ["a chunk a deploy renamed", "/assets/DeckPage-3f9a2c.js"],
    ["a stylesheet", "/assets/index-91ab.css"],
    ["the engine's module", "/wasm/0123456789abcdef/grimoire_web_bg.wasm"],
    ["the engine's glue", "/wasm/0123456789abcdef/grimoire_web.js"],
    ["the service worker before step 5.3 ships one", "/sw.js"],
    ["the manifest", "/light.webmanifest"],
  ])("is a 404 and never the document: %s", async (_what, path) => {
    const { env, asked } = hosting();
    const response = await worker.fetch(ask(path, { accept: ANYTHING }), env);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).not.toContain("<");
    // The binding would have answered the document. It was not asked.
    expect(asked).toEqual([]);
  });

  it("is a 404 to a navigation as well, when the address names a file", async () => {
    const { env, asked } = hosting();
    const response = await worker.fetch(ask("/assets/DeckPage-3f9a2c.js", { accept: PAGE }), env);

    expect(response.status).toBe(404);
    expect(asked).toEqual([]);
  });

  // A path with no extension under a tree of files: `isNavigation` alone would call it a place.
  it.each(["/assets/chunk", "/wasm/0123456789abcdef/grimoire_web", "/mtgimg/display/abc/0"])(
    "is a 404 to a caller that accepts a page, under a tree that holds none: %s",
    async (path) => {
      const { env, asked } = hosting();
      const response = await worker.fetch(ask(path, { accept: PAGE }), env);

      expect(response.status).toBe(404);
      expect(asked).toEqual([]);
    },
  );

  it("may not be sniffed and may not be kept", async () => {
    const { env } = hosting();
    const response = await worker.fetch(ask("/assets/gone.js", { accept: ANYTHING }), env);

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // The same address is a real file the moment a deploy puts one there.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("a card picture, asked of the network by a page no service worker controls yet", () => {
  /** What Chrome sends for an `<img>`: never a navigation, and no `text/html` in what it takes. */
  function picture(path: string): Request {
    return new Request(ORIGIN + path, {
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-dest": "image",
      },
    });
  }

  it.each(["/mtgimg/display/abc/0", "/mtgimg/grid/0f3a/1", "/mtgimg/art/abc/0.webp"])(
    "is a 404 that nothing keeps, and never the document: %s",
    async (path) => {
      const { env, asked } = hosting();
      const response = await worker.fetch(picture(path), env);

      expect(response.status).toBe(404);
      // The document here would be a 200 a cache had no reason to refuse.
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).not.toContain("<");
      expect(asked).toEqual([]);
    },
  );
});

describe("a place in the app, asked for without saying it is a navigation", () => {
  it.each(["/decks/12", "/collection", "/decks/12/notes", "/search"])(
    "answers the document for %s",
    async (path) => {
      const { env, asked } = hosting();
      const response = await worker.fetch(ask(path, { accept: PAGE }), env);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(DOCUMENT);
      // By name: `/` is the document whatever `not_found_handling` is set to.
      expect(asked).toEqual(["/"]);
    },
  );

  it("keeps the request's own headers on the way to the binding", async () => {
    const seen: (string | null)[] = [];
    const env: Env = {
      ASSETS: {
        fetch(input: Request): Promise<Response> {
          seen.push(input.headers.get("if-none-match"));
          return Promise.resolve(new Response(null, { status: 304 }));
        },
      } as unknown as Fetcher,
    };
    const request = new Request(`${ORIGIN}/decks/12`, {
      headers: { accept: PAGE, "if-none-match": '"abc"' },
    });
    const response = await worker.fetch(request, env);

    // A revalidation stays one: the validator crosses, and the 304 comes back as it is.
    expect(seen).toEqual(['"abc"']);
    expect(response.status).toBe(304);
  });

  it("is not a place when the caller does not accept a page", async () => {
    // A `fetch("/decks/12")` from a script: nothing in the app makes one, and an answer of the
    // document would be HTML handed to code that asked for data.
    const { env, asked } = hosting();
    const response = await worker.fetch(ask("/decks/12", { accept: ANYTHING }), env);

    expect(response.status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("is not a place when no `Accept` was sent at all", async () => {
    const { env } = hosting();
    expect((await worker.fetch(ask("/decks/12"), env)).status).toBe(404);
  });

  it.each(["POST", "PUT", "DELETE", "HEAD"])("is not a place to a %s", async (method) => {
    const { env, asked } = hosting();
    const response = await worker.fetch(ask("/decks/12", { method, accept: PAGE }), env);

    expect(response.status).toBe(404);
    expect(asked).toEqual([]);
  });
});
