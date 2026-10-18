import { describe, expect, it } from "vitest";
import scannerSubmitRs from "../../../crates/grimoire-core/src/scanner_submit.rs?raw";
import wranglerText from "../wrangler.jsonc?raw";
import privacyPage from "../../../apps/light/public/privacy.html?raw";
import { LABEL_HEADER } from "./cors";
import { MAX_LABEL_CHARS, MAX_RUN_BYTES, MAX_RUN_FRAMES, MIN_RUN_FRAMES } from "./env";
import { LIMIT } from "./index";
import { INBOX_FULL, RUN_TYPE } from "./submit";

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
/** The one origin a page may send from — `vars.APP_ORIGINS`, which a test below holds whole. */
const APP_ORIGIN = (config.vars as { APP_ORIGINS: string }).APP_ORIGINS;

describe("wrangler.jsonc, against the engine", () => {
  it("is deployed where the engine asks", () => {
    // A Custom Domain on the web app's zone, as the relay's and the share Worker's are: the
    // route's pattern *is* the host. A pattern changed here, or an address changed there, is an
    // app that posts every scan to nothing.
    const base = engine(/pub const SCAN_BASE: &str = "([^"]+)";/, "SCAN_BASE");
    expect(config.routes).toEqual([{ pattern: "scans.mtg-grimoire.app", custom_domain: true }]);
    expect(base).toBe("https://scans.mtg-grimoire.app");
    // And on the zone a page is let in from: one registrable name, two hosts of it.
    expect(new URL(base).hostname.endsWith(`.${new URL(String(APP_ORIGIN)).hostname}`)).toBe(true);
    expect(config.name).toBe("mtg-grimoire-scans");
    expect(config.main).toBe("src/index.ts");
  });

  it("bounds a run where the engine bounds it: its frames, its bytes and its label", () => {
    // Each is refused by the engine first, in a reader's sentence; a number that moved on one
    // side only is a run this Worker turns away with a developer's, or one the app never sends.
    const figure = (name: string): number =>
      engine(new RegExp(`pub const ${name}: usize = ([0-9* ]+);`), name)
        .split("*")
        .reduce((product, factor) => product * Number(factor), 1);
    expect(figure("MAX_RUN_BYTES")).toBe(MAX_RUN_BYTES);
    expect(figure("MIN_RUN_FRAMES")).toBe(MIN_RUN_FRAMES);
    expect(figure("MAX_RUN_FRAMES")).toBe(MAX_RUN_FRAMES);
    expect(figure("MAX_LABEL_CHARS")).toBe(MAX_LABEL_CHARS);
    // Never one picture, on either side, whatever the floor is moved to.
    expect(MIN_RUN_FRAMES).toBeGreaterThan(1);
  });

  it("is sent the run the way the engine sends it", () => {
    expect(scannerSubmitRs).toContain(`.header("content-type", "${RUN_TYPE}")`);
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
    // The token is the one thing in a request that says who sent it: a log would keep it, and
    // the page says of it what `auth.test.ts` holds this Worker to.
    expect(privacyPage).toContain(
      "It is read while the request is being answered and is not stored, with the scan or anywhere else.",
    );
    // And the page names this Worker's host, which is where a reader looks it up.
    expect(privacyPage).toContain("<td>scans.mtg-grimoire.app</td>");
    expect(privacyPage).not.toContain(`${String(config.name)}.denmark-east.workers.dev`);
  });

  it("has one address: its own name, with no workers.dev one and no preview beside it", () => {
    // No build was ever cut with a `workers.dev` address for this Worker, so there is nobody
    // to keep one answering for — unlike the relay and the share Worker, which keep theirs. A
    // preview URL is one more address for every version ever uploaded, bound to the same
    // bucket. Both written out, not left to defaults: wrangler infers the first from `routes`,
    // and the second has changed between its versions.
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toHaveLength(1);
  });

  it("binds nothing else: no database, no object, no asset, no schedule", () => {
    expect(Object.keys(config).sort()).toEqual(
      [
        "$schema",
        "name",
        "main",
        "alias",
        "compatibility_date",
        "routes",
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

  it("holds no account id, neither of Patreon's secrets, and nowhere to put a value", () => {
    // This Worker checks the relay's token, so it reads one secret by name — `RELAY_HMAC_KEY`,
    // below. The two that speak to Patreon are the relay's alone and have no business here,
    // outside this sentence's own file, which has to spell them to say so.
    const SECRETS = ["PATREON_CLIENT_SECRET", "PATREON_WEBHOOK_SECRET"];
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

  it("reads the signing key by name in one module, and is handed its value by no file", () => {
    // **A secret is Cloudflare's to hold**: set by the owner, never a `var`, never a line here.
    // So the configuration does not have the word in it outside a comment — a `vars` entry
    // would be the key itself, committed — and the only value anywhere is the suite's own.
    expect(JSON.stringify(config)).not.toContain("RELAY_HMAC_KEY");
    expect(config.vars).toEqual({ APP_ORIGINS: "https://mtg-grimoire.app" });
    // The script: one module reads it off the bindings, and that module is the door.
    const script = Object.entries(files as Record<string, string>).filter(
      ([name]) => /\/src\/[\w-]+\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name),
    );
    const readers = script
      .filter(([name, text]) => !name.endsWith("/src/fake.ts") && /\benv\.RELAY_HMAC_KEY\b/.test(text))
      .map(([name]) => name.slice(name.lastIndexOf("/") + 1));
    expect(readers).toEqual(["auth.ts"]);
    // It verifies and never mints: what it may name of the relay's token module is `verify`, and
    // since the integration's second PR the restricted-device test and its refusal's code —
    // reading a claim, never writing one. `mint` is the name this list exists to keep out.
    const imported = script
      .filter(([name]) => !name.endsWith("/src/fake.ts"))
      .flatMap(([, text]) => [
        ...text.matchAll(/import \{([^}]+)\} from "@grimoire\/relay\/src\/token";/g),
      ])
      .flatMap(([, names]) => names.split(",").map((name) => name.trim()));
    expect(imported).toEqual(["isRestricted", "RESTRICTED_DEVICE", "verify"]);
    expect(imported).not.toContain("mint");
  });
});
