import { describe, expect, it } from "vitest";
import headersText from "../_headers?raw";
import wranglerText from "../wrangler.jsonc?raw";
import desktopConf from "../../src-tauri/tauri.conf.json?raw";
import launchRs from "../../crates/grimoire-core/src/launch.rs?raw";
import imageUriRs from "../../crates/grimoire-core/src/image_uri.rs?raw";
import combosRs from "../../crates/grimoire-core/src/combos.rs?raw";
import feedRs from "../../crates/grimoire-core/src/marketplace_feed.rs?raw";
import scryfallRs from "../../crates/grimoire-core/src/scryfall.rs?raw";
import oracleTagsRs from "../../crates/grimoire-core/src/tags/oracle.rs?raw";
import entitlementRs from "../../crates/grimoire-core/src/sync_engine/entitlement.rs?raw";
import { headersFor, parseHeaders } from "./headers";

/**
 * **The fence between the hosting policy and the engine it hosts.** Nothing compiles the two
 * together: `_headers` is a text file Cloudflare reads at deploy, and the hosts the engine asks
 * are constants in Rust. A feed that moved, or a new one, would build green on both sides and
 * fail in a reader's browser as a download that never starts — with the reason in a console
 * nobody has open. So this reads both as text, as `src/lib/ipc.test.ts` reads the Rust it
 * mirrors, and goes red on the day they part.
 *
 * **Addresses are asked of `headersFor`, never matched against the file's text**: what an
 * address is *sent* is the sum of every rule that matches it, and two rules that each look right
 * can join into `no-cache, public, max-age=31536000, immutable`.
 */

const rules = parseHeaders(headersText);

/** The addresses a deploy serves, one of each kind. The hashes are made up; the shapes are not. */
const DOCUMENT = ["/", "/index.html", "/decks/12", "/collection"];
const WORKER_CHUNK = "/assets/worker-D3adB33f.js";
const HASHED = ["/assets/index-B1x9QkZp.js", "/assets/index-C7hVtR2a.css", WORKER_CHUNK];
const ENGINE = [
  "/wasm/0123456789abcdef/grimoire_web.js",
  "/wasm/0123456789abcdef/grimoire_web_bg.wasm",
];
const UNHASHED = ["/light.webmanifest", "/mtg-grimoire-mark.svg"];
const SERVICE_WORKER = "/sw.js";
const EVERY = [...DOCUMENT, ...HASHED, ...ENGINE, ...UNHASHED, SERVICE_WORKER];

/** A policy as its directives: `script-src 'self' x` → `{ "script-src": ["'self'", "x"] }`. */
function directives(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

const policyAt = (path: string): string => headersFor(rules, path)["content-security-policy"];
const csp = directives(policyAt("/"));

/** The first capture of `pattern` in a Rust source — or a failure that names what moved. */
function constant(source: string, pattern: RegExp, what: string): string {
  const found = pattern.exec(source)?.[1];
  if (found === undefined) {
    throw new Error(`${what} is no longer where this test reads it. Find it, and fix the pattern.`);
  }
  return found;
}

/** The address a `FeedProvider` says it downloads, read from its own `impl`. */
function feedUrl(provider: string): string {
  return constant(
    feedRs,
    new RegExp(
      `impl FeedProvider for ${provider} \\{[\\s\\S]*?fn url\\(&self\\) -> &'static str \\{\\s*"([^"]+)"`,
    ),
    `${provider}'s feed address`,
  );
}

const SCRYFALL_API = constant(
  launchRs,
  /pub const SCRYFALL_API: &str = "([^"]+)"/,
  "launch.rs's SCRYFALL_API",
);
const IMAGE_HOST = constant(
  imageUriRs,
  /pub const IMAGE_HOST: &str = "([^"]+)"/,
  "image_uri.rs's IMAGE_HOST",
);
const COMBO_FEED = constant(combosRs, /pub const FEED_URL: &str = "([^"]+)"/, "combos.rs's FEED_URL");
const RELAY_BASE = constant(
  entitlementRs,
  /pub const RELAY_BASE: &str = "([^"]+)"/,
  "entitlement.rs's RELAY_BASE",
);
const CARD_KINGDOM = feedUrl("CardKingdom");
const MANA_POOL = feedUrl("ManaPool");

/**
 * Where the bulk files are. **Not a constant of the engine's**: the card sync and both tagger
 * feeds download whatever `jsonl_download_uri` Scryfall's descriptor names. What the tree has is
 * the descriptor as it was transcribed into the Scryfall client's and the tagger's tests, so
 * that is what is read — every one of them, from both files.
 */
const BULK_FILES = [scryfallRs, oracleTagsRs].flatMap((source) =>
  [...source.matchAll(/"jsonl_download_uri":\s*"(https:\/\/[^"]+)"/g)].map((m) => m[1]),
);

const origin = (url: string): string => new URL(url).origin;

describe("connect-src, against the hosts the engine asks", () => {
  it("reads a bulk-file address out of both descriptors", () => {
    // Guards the pattern: a census that matched nothing would pass the test below.
    expect(BULK_FILES.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["Scryfall's API", SCRYFALL_API],
    ["the card pictures", IMAGE_HOST],
    ["Commander Spellbook's combos", COMBO_FEED],
    ["Card Kingdom's pricelist", CARD_KINGDOM],
    ...BULK_FILES.map((url): [string, string] => ["a bulk file", url]),
  ])("allows %s — %s", (_what, url) => {
    expect(csp["connect-src"]).toContain(origin(url));
  });

  it("allows nothing else", () => {
    // Set equality, so a host added to the policy with no constant behind it is red too: an
    // entry nobody asks is an entry nobody will remember to take out.
    const asked = [SCRYFALL_API, IMAGE_HOST, COMBO_FEED, CARD_KINGDOM, ...BULK_FILES].map(origin);
    expect([...csp["connect-src"]].sort()).toEqual(["'self'", ...new Set(asked)].sort());
  });

  it("does not allow Mana Pool, which a page cannot read whatever the policy says", () => {
    // It sends no `Access-Control-Allow-Origin` (light-app.md §9.1's table). Listing it would
    // turn a refusal the app can explain into a CORS failure it cannot.
    expect(csp["connect-src"]).not.toContain(origin(MANA_POOL));
  });

  it("does not allow the relay until phase 6 adds it", () => {
    // Sync in a browser is not built, and the relay's CORS allow-list does not name this origin,
    // so the request fails either way. **Phase 6 deletes this test** in the change that adds
    // the host here and the origin there — and replaces it with the row above.
    expect(csp["connect-src"]).not.toContain(origin(RELAY_BASE));
  });

  it("names each host by scheme and name, and never by a wildcard", () => {
    for (const source of csp["connect-src"].filter((s) => s !== "'self'")) {
      expect(source).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    }
  });
});

describe("the policy", () => {
  it("is one policy, on the document and on every script", () => {
    // A dedicated Worker and a service worker take the policy on their own response. One list,
    // sent with everything, is the only arrangement with nothing to keep equal.
    for (const path of EVERY) expect(policyAt(path), path).toBe(policyAt("/"));
  });

  it("falls back to this origin for everything it does not name", () => {
    expect(csp["default-src"]).toEqual(["'self'"]);
  });

  it("lets the engine compile, and lets nothing be evaluated", () => {
    expect(csp["script-src"]).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp["worker-src"]).toEqual(["'self'"]);
  });

  it("keeps `style-src` at this origin alone", () => {
    expect(csp["style-src"]).toEqual(["'self'"]);
  });

  it("has no `unsafe` source outside the two it means", () => {
    const loose = Object.entries(csp).flatMap(([name, sources]) =>
      sources.filter((s) => s.includes("unsafe")).map((s) => `${name} ${s}`),
    );
    expect(loose.sort()).toEqual(["script-src 'wasm-unsafe-eval'", "style-src-attr 'unsafe-inline'"]);
  });

  it("has no wildcard and no plain-http source anywhere", () => {
    const sources = Object.values(csp).flat();
    expect(sources.filter((s) => s.includes("*") || s.startsWith("http:"))).toEqual([]);
  });

  it("is never looser than the desktop's, directive for directive", () => {
    // The same components run in both, so what the shipped window forbids, this forbids.
    // `script-src` is the one that differs, by exactly what compiling a module needs.
    const desktop = directives(
      (JSON.parse(desktopConf) as { app: { security: { csp: string } } }).app.security.csp,
    );
    const SAME = ["style-src", "style-src-attr", "font-src", "object-src", "frame-src", "base-uri"];
    for (const name of [...SAME, "form-action"]) {
      expect(csp[name], name).toEqual(desktop[name]);
    }
    expect(csp["script-src"].filter((s) => s !== "'wasm-unsafe-eval'")).toEqual(
      desktop["script-src"],
    );
    // Its two image sources that are not a Tauri protocol.
    expect(csp["img-src"]).toEqual(["'self'", "data:", origin(IMAGE_HOST)]);
  });

  it("may be framed by nobody and names its manifest's origin", () => {
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["manifest-src"]).toEqual(["'self'"]);
  });

  it.each(EVERY)("sends the two fixed headers with %s", (path) => {
    const sent = headersFor(rules, path);
    expect(sent["x-content-type-options"]).toBe("nosniff");
    expect(sent["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("needs no isolation headers, and sends none", () => {
    // `Cross-Origin-Embedder-Policy: require-corp` would refuse every card picture.
    const sent = EVERY.flatMap((path) => Object.keys(headersFor(rules, path)));
    expect(sent.filter((name) => name.startsWith("cross-origin-"))).toEqual([]);
  });
});

describe("caching", () => {
  const YEAR = "public, max-age=31536000, immutable";
  const cache = (path: string): string => headersFor(rules, path)["cache-control"];

  it.each([...HASHED, ...ENGINE])("keeps a content-addressed file for a year: %s", (path) => {
    // Exactly: a value joined onto the default's would read `no-cache, public, …`.
    expect(cache(path)).toBe(YEAR);
  });

  it.each([...DOCUMENT, ...UNHASHED])("revalidates %s every time", (path) => {
    expect(cache(path)).toBe("no-cache");
  });

  it("revalidates the service worker's script, by a rule of its own", () => {
    expect(cache(SERVICE_WORKER)).toBe("no-cache");
    // Its own rule, so that loosening `/*` cannot take it along.
    const own = rules.find((rule) => rule.path === SERVICE_WORKER);
    expect(own?.unset).toEqual(["cache-control"]);
    expect(own?.set).toEqual([["cache-control", "no-cache"]]);
  });

  it("has a rule for each tree a build hashes, and each detaches before it sets", () => {
    for (const path of ["/assets/*", "/wasm/*"]) {
      const rule = rules.find((r) => r.path === path);
      expect(rule?.unset, path).toEqual(["cache-control"]);
    }
  });
});

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

describe("wrangler.jsonc", () => {
  const config = jsonc(wranglerText);
  const assets = config.assets as Record<string, unknown>;

  it("serves the web build, at the one origin", () => {
    expect(config.name).toBe("mtg-grimoire-app");
    expect(assets.directory).toBe("../dist-web");
    expect(config.routes).toEqual([{ pattern: "mtg-grimoire.app", custom_domain: true }]);
  });

  it("hands out no second origin", () => {
    // Each would be a second OPFS and a second install. Written out, not left to a default.
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });

  it("answers a deep link with the document, and a navigation without running the script", () => {
    expect(assets.not_found_handling).toBe("single-page-application");
    // The script is what keeps that fallback away from a missing file…
    expect(config.main).toBe("src/index.ts");
    expect(assets.binding).toBe("ASSETS");
    // …and it must run for nothing else: `run_worker_first` bills every asset.
    expect(assets).not.toHaveProperty("run_worker_first");
    // `assets_navigation_prefers_asset_serving` is the default from this date on.
    expect(String(config.compatibility_date) >= "2025-04-01").toBe(true);
    expect(wranglerText).not.toContain("assets_navigation_has_no_effect");
  });

  it("binds nothing but the assets, and configures nothing", () => {
    expect(Object.keys(config).sort()).toEqual(
      [
        "$schema",
        "name",
        "main",
        "compatibility_date",
        "routes",
        "workers_dev",
        "preview_urls",
        "assets",
        "observability",
      ].sort(),
    );
  });
});

describe("what must not be in this directory, or in any build but the web's", () => {
  const files = import.meta.glob(["/app-worker/**/*", "/tsconfig.app-worker.json"], {
    query: "?raw",
    import: "default",
    eager: true,
  });

  it("sweeps every file here", () => {
    const names = Object.keys(files);
    for (const wanted of ["wrangler.jsonc", "_headers", "README.md", "src/index.ts"]) {
      expect(names).toContain(`/app-worker/${wanted}`);
    }
  });

  it("holds no account id, and nothing shaped like one", () => {
    // A Cloudflare account id is 32 hex characters, and wrangler takes it from the login. It is
    // in no file of this repository; a D1 id is a uuid, with dashes, and is not what this finds.
    const found = Object.entries(files).flatMap(([name, text]) =>
      /\baccount_id\b/.test(text) || /\b[0-9a-f]{32}\b/i.test(text) ? [name] : [],
    );
    expect(found).toEqual([]);
  });

  it("holds no secret and nowhere to put one", () => {
    // The three the relay holds, and the two files wrangler reads local secrets from. This
    // Worker verifies no token, so even the name of the signing key has no business here —
    // outside this sentence and the README's, which say so.
    const SECRETS = ["PATREON_CLIENT_SECRET", "PATREON_WEBHOOK_SECRET", "RELAY_HMAC_KEY"];
    const PROSE = ["/app-worker/README.md", "/app-worker/src/hosting.test.ts"];
    const found = Object.entries(files).flatMap(([name, text]) =>
      !PROSE.includes(name) && SECRETS.some((secret) => text.includes(secret)) ? [name] : [],
    );
    expect(found).toEqual([]);
    expect(Object.keys(files).filter((name) => /\.dev\.vars|\.env/.test(name))).toEqual([]);
  });

  it("keeps `_headers` out of `public/`, which every build copies", () => {
    // The desktop's `dist/`, the APK's `dist-mobile/` and the share viewer's `dist-share/` each
    // take `public/` whole. The web build emits this one file itself, in `web` mode alone.
    // (`**`, because a pattern with nothing to expand is one the glob import refuses.)
    const copied = import.meta.glob("/public/**/_headers", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    expect(Object.keys(copied)).toEqual([]);
  });
});
