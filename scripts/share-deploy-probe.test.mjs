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
import {
  LEGACY,
  LEGACY_PROBES,
  PROBES,
  SHARE,
  VIEWER,
  legacyProblems,
  viewerProblems,
} from "./share-deploy-probe.mjs";

const refused = () => Promise.reject(new Error("no probe reaches the bucket or the assets"));
const env = {
  ...fakeEnvOver({ entitlements: [], shares: [] }),
  RELAY_HMAC_KEY: "test-signing-key",
  SHARE_BASE: SHARE,
  SHARES: { put: refused, get: refused, delete: refused },
  ASSETS: { fetch: refused },
};

/**
 * The config as a value: its comment lines out — a setting named in prose is not a setting —
 * and its trailing commas out. Every comment in it stands on a line of its own.
 */
const config = JSON.parse(
  shareWrangler.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
);
const ask = (request) => worker.fetch(request, env);

describe("the share Worker's probes", () => {
  it.each(PROBES.map((probe) => [probe.name, probe]))("%s", async (_name, probe) => {
    expect(await askAll(SHARE, [probe], (request) => worker.fetch(request, env))).toEqual([]);
  });

  it("ask the address the Worker is deployed at, for the script its pages name", () => {
    expect(shareWrangler).toContain(`"SHARE_BASE": "${SHARE}"`);
    expect(VIEWER).toBe("/assets/share.js");
    expect(pageTs).toContain(VIEWER);
  });

  // The address is a Custom Domain since 2026-10-11, and the config is what gives it: a route
  // for another host would deploy, exit 0, and leave the probe asking an address nothing
  // answers at.
  it("ask the address the config's one route gives the Worker", () => {
    expect(config.routes).toEqual([{ pattern: new URL(SHARE).host, custom_domain: true }]);
    expect(config.vars.SHARE_BASE).toBe(SHARE);
  });

  // A `name` changed in the config deploys a new Worker at another address: `wrangler deploy`
  // exits 0 and the old address goes on answering with the previous Worker.
  it("ask, second, the address the Worker's name gives it on the account's subdomain", () => {
    expect(config.name).toBe("mtg-grimoire-share");
    expect(LEGACY).toBe(`https://${config.name}.denmark-east.workers.dev`);
  });

  // ⚠️ The line every release through 0.44.0, and every link minted before the move, depends
  // on. wrangler infers `workers_dev: false` from a config that has `routes`, so *removing*
  // this line is what turns the old address off — and `false` written out does the same.
  it("keep the `workers.dev` address on, in so many words", () => {
    expect(config.workers_dev).toBe(true);
    // Unstated, wrangler leaves the Worker's Preview URL setting as it is.
    expect(config).not.toHaveProperty("preview_urls");
  });

  it("ask the old address something this Worker answers there", async () => {
    expect(LEGACY_PROBES).toHaveLength(1);
    // A status no switched-off name gives: the probe cannot pass on Cloudflare's own 404.
    expect(LEGACY_PROBES[0].status).not.toBe(404);
    expect(await askAll(LEGACY, LEGACY_PROBES, ask)).toEqual([]);
    expect(await legacyProblems(SHARE, ask)).toEqual([]);
  });

  it("report an old address that has stopped answering, by name", async () => {
    // What a deploy without `workers_dev: true` leaves behind, as a switched-off name on this
    // account answered on 2026-10-11: Cloudflare's own 404, as text.
    const gone = () => Promise.resolve(new Response("error code: 1042", { status: 404 }));

    const wrong = await legacyProblems(SHARE, gone);

    expect(wrong).toHaveLength(1);
    expect(wrong[0]).toContain(LEGACY);
    expect(wrong[0]).toContain("answered 404, not 401");
  });

  it("ask the old address only when asked of the Worker's own", async () => {
    const refuse = () => Promise.reject(new Error("another origin's run asks no legacy address"));
    expect(await legacyProblems("https://staging.example", refuse)).toEqual([]);
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
