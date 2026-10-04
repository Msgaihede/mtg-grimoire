// The post-deploy probe's two pure halves: which policy a `_headers` file sends with the
// document, and what is wrong with an answer. The `fetch` is `main`'s, and was driven by hand
// against a local server (docs/reference/ci-and-releases.md has the run).
import { describe, expect, it } from "vitest";
import { ORIGIN, policyOf, problems } from "./web-deploy-probe.mjs";
import headers from "../app-worker/_headers?raw";
import wrangler from "../app-worker/wrangler.jsonc?raw";

describe("policyOf", () => {
  it("reads the policy the real `_headers` sends with the document", () => {
    const policy = policyOf(headers);
    expect(policy).toMatch(/^default-src 'self'; /);
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    // The whole line and nothing after it: the next header is another line.
    expect(policy).not.toMatch(/nosniff|\n/);
  });

  it("answers null for a file that sends none", () => {
    expect(policyOf("/*\n  Cache-Control: no-cache\n")).toBeNull();
  });
});

describe("problems", () => {
  const built = { policy: "default-src 'self'", document: "<!doctype html><p>this build</p>" };
  const good = { status: 200, policy: built.policy, document: built.document };

  it("finds none when the address serves the build", () => {
    expect(problems(built, good)).toEqual([]);
  });

  it("names an answer that is not 200", () => {
    expect(problems(built, { ...good, status: 301 })).toEqual([
      "the document answered 301, not 200",
    ]);
  });

  it("names a missing policy, and a policy that is another line", () => {
    expect(problems(built, { ...good, policy: null })).toEqual([
      "the document was answered with no Content-Security-Policy",
    ]);
    expect(problems(built, { ...good, policy: "default-src 'self' https:" })).toEqual([
      "the document's Content-Security-Policy is not the built `_headers` line",
    ]);
  });

  // The case the first two questions cannot see: yesterday's deploy, same policy.
  it("names a document that is not the bundle's, even under the right policy", () => {
    const wrong = problems(built, { ...good, document: "<!doctype html><p>the last one</p>" });
    expect(wrong).toHaveLength(1);
    expect(wrong[0]).toMatch(/not the bundle's `index\.html`/);
  });

  it("names a bundle that has no policy to compare with", () => {
    expect(problems({ ...built, policy: null }, good)).toEqual([
      "the bundle's `_headers` sends no Content-Security-Policy with the document",
    ]);
  });

  it("reports every question that failed, not the first", () => {
    expect(problems(built, { status: 500, policy: null, document: "" })).toHaveLength(3);
  });
});

describe("the address it asks", () => {
  it("is the Worker's one custom domain", () => {
    expect(ORIGIN).toBe("https://mtg-grimoire.app");
    expect(wrangler).toContain(
      `{ "pattern": "${ORIGIN.slice("https://".length)}", "custom_domain": true }`,
    );
  });
});
