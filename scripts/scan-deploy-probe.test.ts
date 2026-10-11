// The scan inbox's post-deploy probes, held to the Worker: each is asked of this tree's own
// `fetch`, over the suite's limiter and **a bucket that throws if it is touched at all** —
// because the probe's one promise beyond its answers is that it stores nothing, and a probe
// that reached the bucket would put a scan nobody sent in the inbox on every release.
// (`infrastructure/scan-worker/README.md`, "Deploying", has the same seven.)
import { describe, expect, it } from "vitest";
import worker from "../infrastructure/scan-worker/src/index.ts";
import { inbox, untouchable } from "../infrastructure/scan-worker/src/fake.ts";
import scanWrangler from "../infrastructure/scan-worker/wrangler.jsonc?raw";
import scannerSubmitRs from "../crates/grimoire-core/src/scanner_submit.rs?raw";
import { askAll } from "./deploy-probe.ts";
import { APP, PROBES, SCAN } from "./scan-deploy-probe.ts";

/** The Worker's bindings as deployed, key set: the limiter lets a probe through, no bucket is reached. */
const deployed = () => ({ ...inbox().env, SCANS: untouchable });

describe("the scan inbox's probes", () => {
  it.each(PROBES.map((probe) => [probe.name, probe] as const))("%s", async (_name, probe) => {
    const env = deployed();
    expect(await askAll(SCAN, [probe], (request) => worker.fetch(request, env))).toEqual([]);
  });

  it("store nothing, between them, and list nothing", async () => {
    // Every probe again, against a bucket that records: none of them writes and none of them
    // costs a list.
    const box = inbox();
    expect(await askAll(SCAN, PROBES, (request) => worker.fetch(request, box.env))).toEqual([]);
    expect(box.objects.size).toBe(0);
    expect(box.lists).toEqual([]);
  });

  it("hold no token: none of them could be let through the door", () => {
    // A probe that carried a real token would be a credential in a workflow's script. The one
    // `authorization` any of them sends is a word that is no token of anybody's.
    const sent = PROBES.flatMap((probe) => Object.entries(probe.headers ?? {})).filter(
      ([name]) => name.toLowerCase() === "authorization",
    );
    expect(sent).toEqual([["authorization", "Bearer nonsense"]]);
    expect(PROBES.filter((probe) => probe.status === 201)).toEqual([]);
  });

  it("say which step was left out when the Worker holds no signing key", async () => {
    // The state a first deploy is in until the owner sets the secret: `wrangler secret put`
    // does not stick on a Worker that does not exist yet, so the deploy comes first.
    const env = { ...inbox({ key: null }).env, SCANS: untouchable };
    const wrong = await askAll(SCAN, PROBES, (request) => worker.fetch(request, env));
    expect(wrong).toHaveLength(3);
    for (const sentence of wrong) {
      expect(sentence).toMatch(
        /answered 500, not 401 — `RELAY_HMAC_KEY` is not set on this Worker/,
      );
    }
  });

  it("are seven, and three of them spend the limiter's budget", () => {
    // The inbox lets one address make twelve requests a minute past its method check. A probe
    // is asked up to six times, ten seconds apart, so what it spends per attempt is held small:
    // only a `POST` reaches the limiter.
    expect(PROBES).toHaveLength(7);
    const posts = PROBES.filter((probe) => probe.method === "POST");
    expect(posts).toHaveLength(3);
    for (const probe of posts) {
      expect(probe.means?.[429], probe.name).toMatch(/rate limit/);
    }
  });

  // A pattern changed in the config deploys the Worker at another name: `wrangler deploy` exits
  // 0 and the probe goes on passing against the old one.
  it("ask the name the Worker's route gives it, which is the one the engine posts to", () => {
    const pattern =
      /"routes":\s*\[\{\s*"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true\s*\}\]/.exec(
        scanWrangler,
      )?.[1];
    expect(pattern).toBe("scans.mtg-grimoire.app");
    expect(SCAN).toBe(`https://${pattern}`);
    expect(scannerSubmitRs).toContain(`pub const SCAN_BASE: &str = "${SCAN}";`);
  });

  it("ask as the one origin the Worker lets a page send from", () => {
    expect(scanWrangler).toContain(`"APP_ORIGINS": "${APP}"`);
  });
});
