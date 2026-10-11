// The relay's post-deploy probes, held to the relay: every one is asked of this tree's own
// `fetch`, over the fake D1, and has to be answered as the probe expects. So a route whose
// answer changes fails here, in the pull request that changes it — not at a release, with the
// new relay already live. The answers are also the ones `docs/reference/hosted-relay-deploy.md`
// step 0 recorded from the host on 2026-10-01 and 2026-10-04.
import { describe, expect, it } from "vitest";
import worker from "../infrastructure/relay/src/index.ts";
import { fakeEnvOver, fakeTables } from "../infrastructure/relay/src/fakeD1.ts";
import relayWrangler from "../infrastructure/relay/wrangler.jsonc?raw";
import { askAll } from "./deploy-probe.mjs";
import { APP, PROBES, RELAY } from "./relay-deploy-probe.mjs";

const limiter = { limit: () => Promise.resolve({ success: true }) };
const env = {
  ...fakeEnvOver({
    ...fakeTables({ groups: [] }),
    group_keys: [],
    group_devices: [],
    pairing_rendezvous: [],
  }),
  RELAY_BASE: RELAY,
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

describe("the relay's probes", () => {
  it.each(PROBES.map((probe) => [probe.name, probe]))("%s", async (_name, probe) => {
    expect(await askAll(RELAY, [probe], (request) => worker.fetch(request, env))).toEqual([]);
  });

  it("ask the address the Worker is deployed at, from the origin it allows", () => {
    expect(relayWrangler).toContain(`"RELAY_BASE": "${RELAY}"`);
    expect(relayWrangler).toContain(`"APP_ORIGINS": "${APP}"`);
  });

  // A `name` changed in the config deploys a new Worker at another address: `wrangler deploy`
  // exits 0 and the probe goes on passing against the old one.
  it("ask the address the Worker's name gives it, on the account's subdomain", () => {
    const name = /"name":\s*"([^"]+)"/.exec(relayWrangler)?.[1];
    expect(name).toBe("mtg-grimoire-relay");
    expect(RELAY).toBe(`https://${name}.denmark-east.workers.dev`);
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
