import { describe, expect, it } from "vitest";
import { MAX_PENDING } from "./env";
import { inbox, scan, untouchable } from "./fake";
import worker from "./index";

/**
 * CORS for the web app, driven through the router — `infrastructure/relay/src/cors.test.ts`'s
 * suite for a Worker with one route.
 *
 * **Every absence here is asserted beside its presence.** "No `Access-Control-*` header" is what
 * a response looks like when the feature works for the wrong origin and also when it does not
 * exist, so each such test carries a control in which the same request from the allowed origin
 * does get one.
 */

const APP = "https://mtg-grimoire.app";
const FOREIGN = "https://example.com";

/** A browser's pre-flight for the one request the web app makes. */
function asking(origin: string, path = "/scan"): Request {
  return scan({
    method: "OPTIONS",
    path,
    origin,
    labelText: null,
    type: null,
    headers: {
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-scan-label",
    },
  });
}

const cors = (response: Response): string[] =>
  [...response.headers.keys()].filter((name) => name.startsWith("access-control-"));

describe("a pre-flight", () => {
  it("is answered for the web app, before the limiter and the bucket", async () => {
    const box = inbox();
    const response = await worker.fetch(asking(APP), { ...box.env, SCANS: untouchable });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    // The two headers the engine sets, and no third: a header it started sending and this did
    // not name would fail every submission from a browser and none from anywhere else.
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type, x-scan-label");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(await response.text()).toBe("");
    // A browser sends one unprompted; charging it to the sender's budget would halve the limit
    // for the web app alone.
    expect(box.limited).toEqual([]);
  });

  it("is not answered for another origin, or for none", async () => {
    const box = inbox();
    const env = { ...box.env, SCANS: untouchable };
    for (const request of [asking(FOREIGN), asking("null"), asking("*")]) {
      const response = await worker.fetch(request, env);
      // The router's own answer to an `OPTIONS`: the method is not allowed.
      expect(response.status).toBe(405);
      expect(cors(response)).toEqual([]);
    }
    // The control: the same question from the app's origin is a 204 that names it.
    expect(cors(await worker.fetch(asking(APP), env))).not.toEqual([]);
  });

  it("is not answered off the route, whoever asks", async () => {
    const box = inbox();
    const response = await worker.fetch(asking(APP, "/runs/x.bin"), box.env);
    expect(response.status).toBe(404);
    expect(cors(response)).toEqual([]);
  });

  it("is an OPTIONS only when it says which method it is asking about", async () => {
    const box = inbox();
    const bare = scan({ method: "OPTIONS", origin: APP, labelText: null, type: null });
    const response = await worker.fetch(bare, box.env);
    expect(response.status).toBe(405);
    // Still readable by the page that asked: the header goes on every answer to it.
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
  });
});

describe("an answer to a page", () => {
  it("names the web app's origin on a scan it took", async () => {
    const box = inbox();
    const response = await worker.fetch(scan({ origin: APP }), box.env);
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(((await response.json()) as { id: string }).id).toBeTruthy();
  });

  it("names it on every refusal, which is where a page needs it most", async () => {
    // A browser hides a cross-origin response without the header and reports a network error:
    // a full inbox, a run too large and a wait would all read as "could not be reached".
    const refusals: [number, Response][] = [
      [503, await worker.fetch(scan({ origin: APP }), inbox({ waiting: MAX_PENDING }).env)],
      [429, await worker.fetch(scan({ origin: APP }), inbox({ allow: false }).env)],
      [415, await worker.fetch(scan({ origin: APP, type: "image/png" }), inbox().env)],
      [400, await worker.fetch(scan({ origin: APP, labelText: null }), inbox().env)],
      [405, await worker.fetch(scan({ origin: APP, method: "GET" }), inbox().env)],
    ];
    for (const [status, response] of refusals) {
      expect(response.status).toBe(status);
      expect(response.headers.get("access-control-allow-origin"), String(status)).toBe(APP);
      // The body a page reads the reason out of survived being made readable.
      expect(((await response.json()) as { error: string }).error).toBeTruthy();
    }
  });

  it("takes a scan from another origin's page and tells that page nothing it can read", async () => {
    // Not an access control: `curl` sends whatever `Origin` it likes. The scan is stored; what
    // the list buys is that the foreign page's browser will not show it the answer.
    const box = inbox();
    const response = await worker.fetch(scan({ origin: FOREIGN }), box.env);
    expect(response.status).toBe(201);
    expect(cors(response)).toEqual([]);
    expect(response.headers.get("vary")).toBeNull();
  });

  it("is byte for byte the native answer when there is no Origin", async () => {
    // Every desktop and Android build: no new header, no `Vary`.
    const native = await worker.fetch(scan(), inbox().env);
    expect(native.status).toBe(201);
    expect([...native.headers.keys()].sort()).toEqual(["content-type"]);
    const refused = await worker.fetch(scan({ labelText: null }), inbox().env);
    expect([...refused.headers.keys()].sort()).toEqual(["content-type"]);
  });

  it("lets no browser in when the list is unset, empty or not a string", async () => {
    for (const origins of [null, "", " , "] as const) {
      const box = inbox({ origins });
      const response = await worker.fetch(scan({ origin: APP }), box.env);
      expect(response.status).toBe(201);
      expect(cors(response)).toEqual([]);
    }
    const mangled = inbox();
    (mangled.env as unknown as { APP_ORIGINS: unknown }).APP_ORIGINS = 7;
    expect(cors(await worker.fetch(scan({ origin: APP }), mangled.env))).toEqual([]);
  });

  it("matches an origin exactly, never by its ending, its beginning or its scheme", async () => {
    const box = inbox();
    for (const near of [
      "https://mtg-grimoire.app.evil.example",
      "https://evil-mtg-grimoire.app",
      "http://mtg-grimoire.app",
      "https://mtg-grimoire.app/",
      "https://MTG-Grimoire.app",
    ]) {
      expect(cors(await worker.fetch(scan({ origin: near }), box.env)), near).toEqual([]);
    }
  });
});
