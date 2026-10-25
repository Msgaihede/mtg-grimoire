// The integrations store's post-deploy probes, held to the Worker: each is asked of this tree's
// own router, over **a namespace and a database that throw if they are touched at all** — the
// probe's one promise beyond its answers is that it reaches no group's store, and needs no row.
// (`infrastructure/integrations-worker/README.md`, "Deploying", has the same seven.)
import { describe, expect, it } from "vitest";
import worker from "../infrastructure/integrations-worker/src/worker.ts";
import integrationsWrangler from "../infrastructure/integrations-worker/wrangler.jsonc?raw";
import { askAll } from "./deploy-probe.ts";
import { APP, INTEGRATIONS, PROBES } from "./integrations-deploy-probe.ts";

/** Anything this throws on: a probe that reached it would be a probe that touched storage. */
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error("a probe reached storage");
    },
  },
);

/** The Worker's bindings as deployed, both secrets set: a KEK of 32 bytes, a signing key. */
const deployed = (secrets: { kek?: string; key?: string } = {}) => ({
  DB: untouchable,
  STORE: untouchable,
  RELAY_HMAC_KEY: "key" in secrets ? secrets.key : "test-signing-key",
  INTEGRATIONS_KEK: "kek" in secrets ? secrets.kek : "B".repeat(43),
  APP_ORIGINS: APP,
});

/** workerd answers a handler that throws with a 500, and so does this. */
const send = (env: ReturnType<typeof deployed>) => (request: Request) =>
  worker
    .fetch(request, env as never)
    .catch(() => new Response("Worker threw exception", { status: 500 }));

describe("the integrations store's probes", () => {
  it.each(PROBES.map((probe) => [probe.name, probe] as const))("%s", async (_name, probe) => {
    expect(await askAll(INTEGRATIONS, [probe], send(deployed()))).toEqual([]);
  });

  it("hold no token: none of them could be let through the door", () => {
    const sent = PROBES.flatMap((probe) => Object.entries(probe.headers ?? {})).filter(
      ([name]) => name.toLowerCase() === "authorization",
    );
    expect(sent).toEqual([["authorization", "Bearer nonsense"]]);
    expect(PROBES.filter((probe) => probe.status === 200)).toEqual([]);
  });

  it("say which step was left out when the Worker holds no KEK", async () => {
    // A first deploy is in this state until the owner sets the secrets: a `secret put` does not
    // stick on a Worker that does not exist yet, so the deploy comes first.
    for (const kek of [undefined, "short"]) {
      const wrong = await askAll(INTEGRATIONS, PROBES, send(deployed({ kek })));
      expect(wrong).toHaveLength(3);
      expect(
        wrong.filter((sentence) => /`INTEGRATIONS_KEK` is not set/.test(sentence)),
      ).toHaveLength(2);
    }
  });

  it("say which step was left out when the Worker holds no signing key", async () => {
    const wrong = await askAll(INTEGRATIONS, PROBES, send(deployed({ key: undefined })));
    expect(wrong).toEqual([
      "the door holds a signing key, and it is not one that takes nonsense: answered 500, not 401 — `RELAY_HMAC_KEY` is not set on this Worker (or `INTEGRATIONS_KEK` is not) — `wrangler secret put RELAY_HMAC_KEY`, with the relay's value",
    ]);
  });

  // A pattern changed in the config deploys the Worker at another name: `wrangler deploy` exits
  // 0 and the probe goes on passing against the old one.
  it("ask the name the Worker's route gives it", () => {
    const pattern =
      /"routes":\s*\[\{\s*"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true\s*\}\]/.exec(
        integrationsWrangler,
      )?.[1];
    expect(INTEGRATIONS).toBe(`https://${pattern}`);
  });

  it("ask as the one origin the Worker lets a page publish from", () => {
    expect(integrationsWrangler).toContain(`"APP_ORIGINS": "${APP}"`);
  });
});
