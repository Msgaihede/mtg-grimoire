// The scan inbox's post-deploy probes, held to the Worker: each is asked of this tree's own
// `fetch`, over the suite's limiter and **a bucket that throws if it is touched at all** —
// because the probe's one promise beyond its answers is that it stores nothing, and a probe
// that reached the bucket would put a scan nobody sent in the inbox on every release.
// (`infrastructure/scan-worker/README.md`, "Deploying", has the same seven as `curl`s.)
import { describe, expect, it } from "vitest";
import worker from "../infrastructure/scan-worker/src/index.ts";
import { inbox, untouchable } from "../infrastructure/scan-worker/src/fake.ts";
import scanWrangler from "../infrastructure/scan-worker/wrangler.jsonc?raw";
import scannerSubmitRs from "../crates/grimoire-core/src/scanner_submit.rs?raw";
import { askAll } from "./deploy-probe.ts";
import { APP, PROBES, SCAN } from "./scan-deploy-probe.ts";

/** The Worker's bindings as deployed: the limiter lets a probe through, and no bucket is reached. */
function env() {
  const box = inbox();
  return { box, env: { ...box.env, SCANS: untouchable } };
}

describe("the scan inbox's probes", () => {
  it.each(PROBES.map((probe) => [probe.name, probe]))("%s", async (_name, probe) => {
    const { env: bindings } = env();
    expect(await askAll(SCAN, [probe], (request) => worker.fetch(request, bindings))).toEqual([]);
  });

  it("store nothing, between them, and list nothing", async () => {
    // Every probe again, against a bucket that records: none of them writes and none of them
    // costs a list — the count is asked only of a request whose whole run has arrived.
    const box = inbox();
    expect(await askAll(SCAN, PROBES, (request) => worker.fetch(request, box.env))).toEqual([]);
    expect(box.objects.size).toBe(0);
    expect(box.lists).toEqual([]);
  });

  it("are seven, and three of them spend the limiter's budget", () => {
    // The inbox lets one address make twelve requests a minute past its method check. A probe
    // is asked up to six times, ten seconds apart, so what it spends per attempt is held small:
    // only a `POST` reaches the limiter.
    expect(PROBES).toHaveLength(7);
    expect(PROBES.filter((probe) => probe.method === "POST")).toHaveLength(3);
    for (const probe of PROBES.filter((probe) => probe.method === "POST")) {
      expect(probe.means?.[429], probe.name).toMatch(/rate limit/);
    }
  });

  it("refuse one picture's type by name, which is the rule the inbox is built on", () => {
    const single = PROBES.find((probe) => probe.headers?.["content-type"] === "image/jpeg");
    expect(single?.status).toBe(415);
  });

  // A `name` changed in the config deploys a new Worker at another address: `wrangler deploy`
  // exits 0 and the probe goes on passing against the old one.
  it("ask the address the Worker's name gives it, which is the one the engine posts to", () => {
    const name = /"name":\s*"([^"]+)"/.exec(scanWrangler)?.[1];
    expect(name).toBe("mtg-grimoire-scans");
    expect(SCAN).toBe(`https://${name}.denmark-east.workers.dev`);
    expect(scannerSubmitRs).toContain(`pub const SCAN_BASE: &str = "${SCAN}";`);
  });

  it("ask as the one origin the Worker lets a page send from", () => {
    expect(scanWrangler).toContain(`"APP_ORIGINS": "${APP}"`);
  });
});
