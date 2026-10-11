// The share Worker's post-deploy probes, held to the Worker: each is asked of this tree's own
// `fetch` over the fake D1 (`infrastructure/share-worker/README.md`, "Deploying", has the same
// five as `curl`s, and the answers the host gave on 2026-10-01). The fifth — the viewer's
// script — is served by the assets layer and never reaches the Worker, so its comparison is
// held as a pure function.
import { describe, expect, it } from "vitest";
import worker from "../infrastructure/share-worker/src/index.ts";
import { fakeEnvOver } from "../infrastructure/relay/src/fakeD1.ts";
import shareWrangler from "../infrastructure/share-worker/wrangler.jsonc?raw";
import pageTs from "../infrastructure/share-worker/src/page.ts?raw";
import { askAll } from "./deploy-probe.mjs";
import { PROBES, SHARE, VIEWER, viewerProblems } from "./share-deploy-probe.mjs";

const refused = () => Promise.reject(new Error("no probe reaches the bucket or the assets"));
const env = {
  ...fakeEnvOver({ entitlements: [], shares: [] }),
  RELAY_HMAC_KEY: "test-signing-key",
  SHARE_BASE: SHARE,
  SHARES: { put: refused, get: refused, delete: refused },
  ASSETS: { fetch: refused },
};

describe("the share Worker's probes", () => {
  it.each(PROBES.map((probe) => [probe.name, probe]))("%s", async (_name, probe) => {
    expect(await askAll(SHARE, [probe], (request) => worker.fetch(request, env))).toEqual([]);
  });

  it("ask the address the Worker is deployed at, for the script its pages name", () => {
    expect(shareWrangler).toContain(`"SHARE_BASE": "${SHARE}"`);
    expect(VIEWER).toBe("/assets/share.js");
    expect(pageTs).toContain(VIEWER);
  });

  // A `name` changed in the config deploys a new Worker at another address: `wrangler deploy`
  // exits 0 and the probe goes on passing against the old one.
  it("ask the address the Worker's name gives it, on the account's subdomain", () => {
    const name = /"name":\s*"([^"]+)"/.exec(shareWrangler)?.[1];
    expect(name).toBe("mtg-grimoire-share");
    expect(SHARE).toBe(`https://${name}.denmark-east.workers.dev`);
  });

  it("says a missing signing key is what a 500 at the gate means", () => {
    const gate = PROBES.find((probe) => probe.headers?.authorization === "Bearer nonsense");
    expect(gate.means[500]).toMatch(/RELAY_HMAC_KEY/);
  });
});

describe("viewerProblems", () => {
  it("finds none when the address serves the bundle's script", () => {
    expect(viewerProblems("built();", { status: 200, body: "built();" })).toEqual([]);
  });

  it("names a script that is not served", () => {
    expect(viewerProblems("built();", { status: 404, body: "" })).toEqual([
      "/assets/share.js answered 404, not 200",
    ]);
  });

  it("names a script that is the previous deploy's", () => {
    expect(viewerProblems("built();", { status: 200, body: "older();" })).toEqual([
      "/assets/share.js is not the bundle's — the previous deploy is still being served",
    ]);
  });

  it("refuses an empty bundle before it asks whether the address serves it", () => {
    expect(viewerProblems("", { status: 200, body: "" })).toEqual([
      "the bundle's assets/share.js is empty",
    ]);
  });
});
