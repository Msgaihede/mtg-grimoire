import { describe, expect, it } from "vitest";
import scannerSubmitRs from "../../../crates/grimoire-core/src/scanner_submit.rs?raw";
import wranglerText from "../wrangler.jsonc?raw";
import privacyPage from "../../../apps/light/public/privacy.html?raw";
import { LABEL_HEADER } from "./cors";
import { MAX_FRAME_BYTES } from "./env";
import { LIMIT } from "./index";
import { INBOX_FULL } from "./submit";

/**
 * The fence between this Worker's configuration, its code and the engine that asks it.
 *
 * **Nothing compiles any two of the three together.** `wrangler.jsonc` is read by a deploy, the
 * engine's address and cap are Rust, and a binding whose name drifts from `Env`'s is one this
 * Worker reads as `undefined` and treats as absent on purpose — so each mistake here deploys
 * green and fails somewhere a reader is. Read as text, the way
 * `infrastructure/app-worker/src/hosting.test.ts` reads the engine.
 */

/** `wrangler.jsonc` as a value: comments out, trailing commas out. Strings are stepped over. */
function jsonc(text: string): Record<string, unknown> {
  let out = "";
  for (let at = 0; at < text.length; ) {
    if (text[at] === '"') {
      const from = at++;
      while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
      out += text.slice(from, ++at);
    } else if (text.startsWith("//", at)) {
      while (at < text.length && text[at] !== "\n") at++;
    } else if (text.startsWith("/*", at)) {
      at = text.indexOf("*/", at) + 2;
    } else {
      out += text[at++];
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
}

/** The first capture of `pattern` in the engine's module — or a failure that names what moved. */
function engine(pattern: RegExp, what: string): string {
  const found = pattern.exec(scannerSubmitRs)?.[1];
  if (found === undefined) {
    throw new Error(`${what} is no longer where this test reads it in scanner_submit.rs.`);
  }
  return found;
}

const config = jsonc(wranglerText);

describe("wrangler.jsonc, against the engine", () => {
  it("is deployed where the engine asks", () => {
    // A `workers.dev` address is the Worker's name and the account's subdomain — the relay's
    // and the share Worker's are spelled the same way. A name changed here, or an address
    // changed there, is an app that posts every scan to nothing.
    const base = engine(/pub const SCAN_BASE: &str = "([^"]+)";/, "SCAN_BASE");
    expect(base).toBe(`https://${String(config.name)}.denmark-east.workers.dev`);
    expect(config.name).toBe("mtg-grimoire-scans");
    expect(config.main).toBe("src/index.ts");
  });

  it("caps a picture where the engine caps it", () => {
    const cap = engine(/pub const MAX_FRAME_BYTES: usize = ([0-9* ]+);/, "MAX_FRAME_BYTES");
    const bytes = cap.split("*").reduce((product, factor) => product * Number(factor), 1);
    expect(bytes).toBe(MAX_FRAME_BYTES);
  });

  it("reads the label from the header the engine puts it in", () => {
    expect(engine(/pub const LABEL_HEADER: &str = "([^"]+)";/, "LABEL_HEADER")).toBe(LABEL_HEADER);
  });

  it("answers a full inbox, and a sender to slow down, in the words the engine matches on", () => {
    // The engine words a refusal for a reader by its `code`; `submit.test.ts` holds what this
    // side sends to the same two strings.
    expect(engine(/const INBOX_FULL_CODE: &str = "([^"]+)";/, "INBOX_FULL_CODE")).toBe(INBOX_FULL);
    expect(engine(/const RATE_LIMITED_CODE: &str = "([^"]+)";/, "RATE_LIMITED_CODE")).toBe(
      "rate_limited",
    );
  });
});

describe("wrangler.jsonc, against the code", () => {
  it("binds the bucket under the name the handler writes to", () => {
    expect(config.r2_buckets).toEqual([{ binding: "SCANS", bucket_name: "mtg-grimoire-scans" }]);
  });

  it("binds one limiter, under the name and with the numbers the router repeats", () => {
    expect(config.ratelimits).toEqual([
      { name: "RL_SUBMIT", namespace_id: "2001", simple: LIMIT },
    ]);
    // `period` takes 10 or 60 and nothing else.
    expect([10, 60]).toContain(LIMIT.period);
  });

  it("lets the web app's origin ask, and no development one", () => {
    expect(config.vars).toEqual({ APP_ORIGINS: "https://mtg-grimoire.app" });
  });

  it("keeps no log, which is what the privacy policy says of it", () => {
    // A log line holds a request's headers: the sender's address and the label. The policy
    // says this server keeps no log of requests, and `enabled: true` here is what would.
    expect(config.observability).toEqual({ enabled: false });
    expect(privacyPage).toContain("This server keeps no log of requests.");
    // And the page names this Worker's host, which is where a reader looks it up.
    expect(privacyPage).toContain(`<td>${String(config.name)}.denmark-east.workers.dev</td>`);
  });

  it("has one address: its own, and no preview of any older version", () => {
    // A preview URL is a second address for every version ever uploaded, bound to the same
    // bucket. Written out, not left to a default that has changed between wrangler versions.
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config).not.toHaveProperty("routes");
  });

  it("binds nothing else: no database, no object, no asset, no schedule", () => {
    expect(Object.keys(config).sort()).toEqual(
      [
        "$schema",
        "name",
        "main",
        "compatibility_date",
        "workers_dev",
        "preview_urls",
        "r2_buckets",
        "ratelimits",
        "vars",
        "observability",
      ].sort(),
    );
  });
});

describe("what must not be in this directory", () => {
  const files = import.meta.glob(
    [
      "/infrastructure/scan-worker/**/*",
      "!/infrastructure/scan-worker/.wrangler/**",
      "!/infrastructure/scan-worker/node_modules/**",
    ],
    { query: "?raw", import: "default", eager: true, exhaustive: true },
  );

  it("sweeps every file here", () => {
    const names = Object.keys(files);
    for (const wanted of ["wrangler.jsonc", "README.md", "src/index.ts", "src/submit.ts"]) {
      expect(names).toContain(`/infrastructure/scan-worker/${wanted}`);
    }
  });

  it("holds no account id, no secret's name and nowhere to put one", () => {
    // This Worker verifies no token and signs nothing, so not even the name of a secret has
    // business here — outside this sentence's own file, which has to spell them to say so.
    const SECRETS = ["PATREON_CLIENT_SECRET", "PATREON_WEBHOOK_SECRET", "RELAY_HMAC_KEY"];
    const found = Object.entries(files as Record<string, string>).flatMap(([name, text]) => {
      if (name.endsWith("/src/wrangler.test.ts")) return [];
      const leaks =
        /\baccount_id\b/.test(text) ||
        /\b[0-9a-f]{32}\b/i.test(text) ||
        SECRETS.some((secret) => text.includes(secret));
      return leaks ? [name] : [];
    });
    expect(found).toEqual([]);
    expect(Object.keys(files).filter((name) => /\/\.(dev\.vars|env)[^/]*$/.test(name))).toEqual([]);
  });
});
