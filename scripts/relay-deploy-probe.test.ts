// The relay's post-deploy probes, held to the relay: every one is asked of this tree's own
// `fetch`, over the fake D1, and has to be answered as the probe expects. So a route whose
// answer changes fails here, in the pull request that changes it — not at a release, with the
// new relay already live. The answers are also the ones `docs/reference/hosted-relay-deploy.md`
// step 0 recorded from the host on 2026-10-01 and 2026-10-04.
import { describe, expect, it } from "vitest";
import worker from "../infrastructure/relay/src/index.ts";
import { fakeEnvOver, fakeTables } from "../infrastructure/relay/src/fakeD1.ts";
import relayWrangler from "../infrastructure/relay/wrangler.jsonc?raw";
import entitlementRs from "../crates/grimoire-core/src/sync_engine/entitlement.rs?raw";
import { askAll } from "./deploy-probe.ts";
import { APP, LEGACY, LEGACY_PROBES, PROBES, RELAY, askBoth } from "./relay-deploy-probe.ts";

const limiter = { limit: () => Promise.resolve({ success: true }) };
const env = {
  ...fakeEnvOver({
    ...fakeTables({ groups: [] }),
    group_keys: [],
    group_devices: [],
    pairing_rendezvous: [],
  }),
  RELAY_BASE: RELAY,
  RELAY_BASE_LEGACY: LEGACY,
  RELAY_HMAC_KEY: "test-signing-key",
  PATREON_WEBHOOK_SECRET: "test-webhook-secret",
  PATREON_CLIENT_ID: "client",
  PATREON_CLIENT_SECRET: "secret",
  PATREON_CAMPAIGN_ID: "1",
  RL_CLAIM: limiter,
  RL_MINT: limiter,
  RL_READ: limiter,
  APP_ORIGINS: APP,
};

/**
 * The config as a value: its comment lines out — a setting named in prose is not a setting —
 * and its trailing commas out. Every comment in it stands on a line of its own.
 */
const config = JSON.parse(
  relayWrangler.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
) as { name: string; routes: unknown; workers_dev: unknown; vars: Record<string, string> };
/** This tree's relay, as the probes' `send`. */
const ask = (request: Request) => Promise.resolve(worker.fetch(request, env));

describe("the relay's probes", () => {
  it.each(PROBES.map((probe) => [probe.name, probe]))("%s", async (_name, probe) => {
    expect(await askAll(RELAY, [probe], (request) => worker.fetch(request, env))).toEqual([]);
  });

  it("ask the address the Worker is deployed at, from the origin it allows", () => {
    expect(relayWrangler).toContain(`"RELAY_BASE": "${RELAY}"`);
    expect(relayWrangler).toContain(`"APP_ORIGINS": "${APP}"`);
  });

  // The address is a Custom Domain since 2026-10-11, and the config is what gives it: a route
  // for another host would deploy, exit 0, and leave the probe asking an address nothing
  // answers at — or, worse, one an earlier deploy still does.
  it("ask the address the config's one route gives the Worker", () => {
    expect(config.routes).toEqual([{ pattern: new URL(RELAY).host, custom_domain: true }]);
    expect(config.vars.RELAY_BASE).toBe(RELAY);
  });

  // ⚠️ **The pair the config's own comment calls byte for byte, and nothing held until
  // 2026-10-11.** A build names `{RELAY_BASE}/oauth/patreon/callback` from the Rust constant
  // and the relay repeats it from its var: one character apart and every new build's Connect
  // Patreon fails as `invalid_grant`, with every suite green. `share::publish` has held its own
  // pair this way since the share Worker's first deploy.
  it("ask the address every build is compiled with", () => {
    const rust = /pub const RELAY_BASE: &str = "([^"]+)";/.exec(entitlementRs)?.[1];
    expect(rust, "no `pub const RELAY_BASE` found in entitlement.rs").toBeDefined();
    expect(config.vars.RELAY_BASE).toBe(rust);
  });

  // A `name` changed in the config deploys a new Worker at another address: `wrangler deploy`
  // exits 0 and the old address goes on answering with the previous Worker.
  it("ask, second, the address the Worker's name gives it on the account's subdomain", () => {
    expect(config.name).toBe("mtg-grimoire-relay");
    expect(LEGACY).toBe(`https://${config.name}.denmark-east.workers.dev`);
    expect(config.vars.RELAY_BASE_LEGACY).toBe(LEGACY);
  });

  // ⚠️ The line every installed build depends on. wrangler infers `workers_dev: false` from a
  // config that has `routes`, so *removing* this line is what turns the old address off — and
  // `false` written out does the same. Either way the deploy succeeds.
  it("keep the `workers.dev` address on, in so many words", () => {
    expect(config.workers_dev).toBe(true);
    // Unstated, wrangler leaves the Worker's Preview URL setting as it is.
    expect(config).not.toHaveProperty("preview_urls");
  });

  it("ask the old address something this Worker answers there, at no limiter's cost", async () => {
    expect(LEGACY_PROBES).toHaveLength(1);
    expect(LEGACY_PROBES[0].method).toBe("OPTIONS");
    expect(await askAll(LEGACY, LEGACY_PROBES, ask)).toEqual([]);
  });

  it("report an old address that has stopped answering, by name", async () => {
    // What a deploy without `workers_dev: true` leaves behind: Cloudflare's own 404 at the
    // `workers.dev` name, and the Worker answering as ever at its Custom Domain.
    const send = (request: Request) =>
      new URL(request.url).origin === LEGACY
        ? Promise.resolve(new Response("error code: 1042", { status: 404 }))
        : ask(request);

    const wrong = await askBoth(RELAY, send);

    expect(wrong).toHaveLength(1);
    expect(wrong[0]).toContain(LEGACY);
    expect(wrong[0]).toContain("answered 404, not 204");
  });

  it("ask the old address only when asked of the relay's own", async () => {
    const asked: string[] = [];
    const send = (request: Request) => {
      asked.push(new URL(request.url).origin);
      return ask(request);
    };

    expect(await askBoth("https://staging.example", send)).toEqual([]);
    expect(new Set(asked)).toEqual(new Set(["https://staging.example"]));

    asked.length = 0;
    expect(await askBoth(RELAY, send)).toEqual([]);
    expect(asked.filter((origin) => origin === LEGACY)).toHaveLength(LEGACY_PROBES.length);
  });

  it("are named apart, and pair each origin probe with a control", () => {
    expect(new Set(PROBES.map((probe) => probe.name)).size).toBe(PROBES.length);
    const origins = PROBES.filter((probe) => "allowOrigin" in probe);
    expect(origins.filter((probe) => probe.allowOrigin === APP)).toHaveLength(2);
    expect(origins.filter((probe) => probe.allowOrigin === null)).toHaveLength(2);
  });

  // Six attempts must fit under the limiter the unauthenticated doors share (`RL_MINT`, 30 a
  // minute for one address): a probe that trips it reads its own 429s as a failed deploy. An
  // `OPTIONS` spends none of it (`index.ts`: a pre-flight is answered before `route`, and a 405
  // spends nobody's budget), so only the requests that reach the door count.
  it("spend fewer than five requests an attempt on the token door", () => {
    const spent = PROBES.filter((probe) => probe.path === "/token" && probe.method !== "OPTIONS");
    expect(spent.length).toBeLessThan(5);
  });
});
