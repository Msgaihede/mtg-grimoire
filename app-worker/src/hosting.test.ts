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
import webCoreTs from "../../src/lib/core/web/index.ts?raw";
import { headersFor, parseHeaders } from "./headers";

/**
 * **The fence between the hosting policy and the engine it hosts.** Nothing compiles the two
 * together: `_headers` is a text file Cloudflare reads at deploy, and the hosts the engine asks
 * are in Rust. A feed that moved, or a new one, would build green on both sides and fail in a
 * reader's browser as a download that never starts — with the reason in a console nobody has
 * open. So this reads both as text, as `src/lib/ipc.test.ts` reads the Rust it mirrors.
 *
 * **What it holds, exactly, in two halves:**
 *
 * - *A host that moved.* The engine's addresses are read by name — `SCRYFALL_API`, `IMAGE_HOST`,
 *   `FEED_URL` and Card Kingdom's `url()` — and `connect-src` is held set-equal to their hosts
 *   and the bulk files'. Change one in the Rust and this is red.
 * - *A host that is new.* A census of every `https://` literal in the code the three crates
 *   **ship** — above each file's test modules, comments out — each of which has to be a host in
 *   `connect-src` or on a short list of hosts no browser's engine asks, with the reason. A sixth
 *   feed written in a file this test has never heard of is red.
 *
 * **And what it cannot.** An address that is not a literal: one built from parts, read from a
 * setting — or **sent by a server**, which is the case that exists. The card sync and both Tagger
 * feeds download whatever `jsonl_download_uri` Scryfall's descriptor names; no shipped line says
 * `data.scryfall.io`. That host is read here from the descriptors transcribed into two test
 * modules, which pins the policy to what Scryfall sent on the day they were written and to
 * nothing since. If Scryfall moves its bulk files, this stays green and a browser's first run
 * fails.
 *
 * **Addresses are asked of `headersFor`, never matched against the file's text**: what an
 * address is *sent* is the sum of every rule that matches it, and two rules that each look right
 * can join into `no-cache, public, max-age=31536000, immutable`.
 */

const rules = parseHeaders(headersText);

/**
 * The engine's Worker, as Vite names its chunk: the stem of the file the page constructs it
 * from, a hyphen, a hash. Read from the line that constructs it, so a file renamed out from
 * under `_headers`'s rule for it is a failure here rather than a Worker kept for a year.
 */
const WORKER_STEM = (() => {
  const found = /new Worker\(new URL\("\.\/([\w.-]+)\.ts", import\.meta\.url\)/.exec(webCoreTs)?.[1];
  if (found === undefined) {
    throw new Error("src/lib/core/web/index.ts no longer constructs the Worker where this reads it.");
  }
  return found;
})();

/** The addresses a deploy serves, one of each kind. The hashes are made up; the shapes are not. */
const DOCUMENT = ["/", "/index.html", "/decks/12", "/collection"];
const WORKER_CHUNK = `/assets/${WORKER_STEM}-BjbUO-kj.js`;
const HASHED = ["/assets/index-B1x9QkZp.js", "/assets/index-C7hVtR2a.css", "/assets/web-di51RyQX.js"];
const ENGINE = [
  "/wasm/0123456789abcdef/grimoire_web.js",
  "/wasm/0123456789abcdef/grimoire_web_bg.wasm",
];
/** What `mobile/public/` puts at the root: fixed names, so nothing here may be kept for long. */
const UNHASHED = [
  "/light.webmanifest",
  "/mtg-grimoire-mark.svg",
  "/icons/icon-192.png",
  "/icons/maskable-512.png",
];
const SERVICE_WORKER = "/sw.js";
const EVERY = [...DOCUMENT, ...HASHED, WORKER_CHUNK, ...ENGINE, ...UNHASHED, SERVICE_WORKER];

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
 * Where the bulk files are. **Not a constant of the engine's, and not in its shipped code at
 * all**: the card sync and both Tagger feeds download whatever `jsonl_download_uri` Scryfall's
 * descriptor names. What the tree has is the descriptor as it was transcribed into two test
 * modules — the Scryfall client's and the oracle tags'; `tags/art.rs` transcribes none — so
 * that is what is read. A fixture, not a fact about today: see the header.
 */
const descriptors = (source: string): string[] =>
  [...source.matchAll(/"jsonl_download_uri":\s*"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
const BULK_FILES = [...descriptors(scryfallRs), ...descriptors(oracleTagsRs)];

const origin = (url: string): string => new URL(url).origin;

/** A crate's sources by repository path, as text. `src/bin/` is a tool's, not the library's. */
const RUST: Record<string, string> = import.meta.glob(
  [
    "/crates/grimoire-core/src/**/*.rs",
    "/crates/grimoire-web/src/**/*.rs",
    "/crates/card-scanner/src/**/*.rs",
    "!/crates/card-scanner/src/bin/**",
  ],
  { query: "?raw", import: "default", eager: true },
);

/**
 * The files a parent declares behind a test gate — `#[cfg(test)] mod tests;` and the `testing`
 * feature's `scratch` — and everything under them. Derived, as `platform::fence` derives them.
 */
const TEST_ONLY_FILES = (() => {
  const gate = /^\s*#\[cfg\((?:test|any\(test, feature = "testing"\))\)\]\s*$/;
  const declared = /^\s*(?:pub(?:\([a-z]+\))? )?mod (\w+);/;
  const out: string[] = [];
  for (const [path, text] of Object.entries(RUST)) {
    const lines = text.split(/\r?\n/);
    const dir = path.slice(0, path.lastIndexOf("/"));
    const stem = path.slice(path.lastIndexOf("/") + 1, -".rs".length);
    const base = ["mod", "lib", "main"].includes(stem) ? dir : `${dir}/${stem}`;
    lines.forEach((line, at) => {
      const name = gate.test(line) ? declared.exec(lines[at + 1] ?? "")?.[1] : undefined;
      if (name !== undefined) out.push(`${base}/${name}.rs`, `${base}/${name}/`);
    });
  }
  return out;
})();

/**
 * What one file ships, by the crate's own rule (`crates/grimoire-core/CLAUDE.md`, and the cut
 * `scripts/coverage-rust.mjs` makes): everything above its first column-0 `#[cfg(test)]` **that
 * gates a module**. A gate over one item higher up is not the cut. Comment lines are dropped —
 * a `///` naming a documentation page is prose, not an address anything asks.
 */
function shipped(path: string, text: string): string[] {
  if (TEST_ONLY_FILES.some((t) => (t.endsWith("/") ? path.startsWith(t) : path === t))) return [];
  const lines = text.split(/\r?\n/);
  const opensModule = (line: string | undefined): boolean =>
    /^(pub(\([a-z]+\))? )?mod \w/.test(line ?? "");
  const cut = lines.findIndex((l, at) => l.startsWith("#[cfg(test)]") && opensModule(lines[at + 1]));
  return (cut === -1 ? lines : lines.slice(0, cut)).filter((l) => !l.trimStart().startsWith("//"));
}

/** Every `https://` host written in shipped code, and the files that write it. */
const SHIPPED_HOSTS = (() => {
  const hosts = new Map<string, string[]>();
  for (const [path, text] of Object.entries(RUST)) {
    for (const line of shipped(path, text)) {
      for (const [, host] of line.matchAll(/https:\/\/([A-Za-z0-9.-]*[A-Za-z0-9])/g)) {
        hosts.set(host, [...(hosts.get(host) ?? []), path]);
      }
    }
  }
  return hosts;
})();

/**
 * Hosts the shipped code names that a browser's engine never *asks*, and why each is not owed a
 * place in `connect-src`. **Short on purpose, and every entry has to still be in the code**: a
 * host with no line here and no place in the policy fails the census below.
 */
const NOT_ASKED_FROM_A_BROWSER: Record<string, string> = {
  "manapool.com":
    "it sends no Access-Control-Allow-Origin, and the engine refuses the feed on a host that cannot reach it before any request (step 5.2)",
  "mtg-grimoire-relay.denmark-east.workers.dev":
    "sync in a browser is phase 6, which moves this entry into the policy with the relay's CORS allow-list",
  "www.patreon.com":
    "the authorize address the engine builds for the page to open in a new tab — a navigation, which connect-src does not govern",
  "github.com": "the repository's address inside the User-Agent's text, not an address anything asks",
  "fonts.googleapis.com": "card-scanner's debug page, HTML a native debug server serves",
  "fonts.gstatic.com": "card-scanner's debug page, as above",
};

describe("the census: every https:// host in the engine's shipped code", () => {
  it("reads the three crates, and cuts each file where its tests begin", () => {
    // Guards the census itself: one that read nothing, or read the test modules too, would
    // pass or fail the test below for the wrong reason.
    expect(Object.keys(RUST)).toContain("/crates/grimoire-core/src/launch.rs");
    expect(Object.keys(RUST)).toContain("/crates/grimoire-web/src/host.rs");
    expect(Object.keys(RUST).filter((path) => path.includes("/src/bin/"))).toEqual([]);
    expect([...SHIPPED_HOSTS.keys()]).toContain(new URL(SCRYFALL_API).host);
    // In `image_uri.rs`'s tests and nowhere above them: the cut is being made.
    expect(imageUriRs).toContain("https://errors.scryfall.com/");
    expect([...SHIPPED_HOSTS.keys()]).not.toContain("errors.scryfall.com");
    // A whole file behind a test gate, with an address in it.
    expect(TEST_ONLY_FILES).toContain("/crates/grimoire-core/src/sync/run_tests.rs");
  });

  it("finds each one in connect-src, or on the list of hosts a browser's engine never asks", () => {
    const unplaced = [...SHIPPED_HOSTS]
      .filter(([host]) => !csp["connect-src"].includes(`https://${host}`))
      .filter(([host]) => !(host in NOT_ASKED_FROM_A_BROWSER))
      .map(([host, files]) => `${host} — ${[...new Set(files)].join(", ")}`);
    // A host here is one the engine may ask from a browser that the policy will refuse. Add it
    // to `_headers`, or to the list above with the reason no browser's engine reaches it.
    expect(unplaced).toEqual([]);
  });

  it("keeps that list to hosts the code still names, and out of the policy", () => {
    const listed = Object.keys(NOT_ASKED_FROM_A_BROWSER);
    expect(listed.filter((host) => !SHIPPED_HOSTS.has(host))).toEqual([]);
    expect(listed.filter((host) => csp["connect-src"].includes(`https://${host}`))).toEqual([]);
  });

  it("does not find the bulk files' host, which no shipped line names", () => {
    // The half of `connect-src` this census cannot hold: the address arrives in Scryfall's
    // descriptor. Written as a test so the limit is stated where it would otherwise be assumed
    // away — if this ever fails, the host has become a literal and the header above is out of
    // date in the good direction.
    for (const url of BULK_FILES) expect(SHIPPED_HOSTS.has(new URL(url).host)).toBe(false);
  });
});

describe("connect-src, against the hosts the engine asks", () => {
  it("reads a bulk-file address out of each descriptor that transcribes one", () => {
    // Guards the pattern, file by file: a file that matched nothing would otherwise be carried
    // by the other.
    expect(descriptors(scryfallRs).length).toBeGreaterThanOrEqual(1);
    expect(descriptors(oracleTagsRs).length).toBeGreaterThanOrEqual(1);
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

  it("allows nothing but those", () => {
    // Set equality against the addresses read by name above, so a host added to the policy with
    // nothing behind it is red: an entry nobody asks is one nobody will remember to take out.
    // **This is the half that sees a host leave or move, not one arrive** — a new feed is the
    // census's to catch, and its host then has to be named here too before this passes.
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
    //
    // Since step 5.5b the engine refuses a relay call on a page before anything is sent
    // (`sync_engine::entitlement::NOT_FROM_A_BROWSER_YET`), so this absence is no longer what
    // a reader hits first: it is the fence behind that refusal, and goes in the same change.
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
    // Its image sources that are not a Tauri protocol, and nothing added.
    expect(csp["img-src"]).toEqual(desktop["img-src"].filter((s) => !s.includes("mtgimg")));
  });

  it("draws pictures from this origin alone, though every one comes from Scryfall", () => {
    // A card picture is asked of `/mtgimg/…` and answered by the service worker with a response
    // **rebuilt from the bytes** (step 5.3). Chrome holds `img-src` to the address of the
    // response a service worker returns as well as to the address asked — measured, Chrome 154:
    // Scryfall's response handed back as it came, opaque, or out of Cache Storage is refused
    // under this line, and only a rebuilt one is drawn. So the host is *not* named here, which
    // is the tighter policy and the one that goes red, in a browser, if the service worker ever
    // stops rebuilding. What it needs is to *fetch* the picture, and that is `connect-src`.
    expect(csp["img-src"]).toEqual(["'self'", "data:"]);
    expect(csp["connect-src"]).toContain(origin(IMAGE_HOST));
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

  it("revalidates the engine's Worker, the one hashed file whose policy can change under it", () => {
    // A dedicated Worker runs under the policy on its own script's response. That policy is
    // `_headers`', and a deploy that changes only `_headers` renames no chunk — so kept for a
    // year, the script is never asked for again and a returning reader's engine keeps the
    // `connect-src` of the day they first came (measured, Chrome 154: not requested at all).
    // Revalidated, it is a 304 carrying the new policy, which takes effect (measured likewise).
    expect(cache(WORKER_CHUNK)).toBe("no-cache");
    const own = rules.find((rule) => rule.path === `/assets/${WORKER_STEM}-*`);
    expect(own?.unset).toEqual(["cache-control"]);
    expect(own?.set).toEqual([["cache-control", "no-cache"]]);
    // And it still carries the policy it is revalidated for.
    expect(policyAt(WORKER_CHUNK)).toBe(policyAt("/"));
  });

  it("gives up the year for that one file and for nothing beside it", () => {
    expect(cache(`/assets/${WORKER_STEM}s-B1x9QkZp.js`)).toBe(YEAR);
    expect(cache(`/assets/web${WORKER_STEM}-B1x9QkZp.js`)).toBe(YEAR);
    // The engine's glue and module are loaded *by* the Worker and carry no policy of their own
    // that anything runs under.
    for (const path of ENGINE) expect(cache(path)).toBe(YEAR);
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
  /**
   * Every file in the directory, **dotfiles among them**: without `exhaustive` a glob import
   * skips any name that starts with a dot, and a sweep for `.dev.vars` that cannot see a dotfile
   * is an assertion that cannot fail — which is what this was for one commit.
   *
   * `.wrangler/` is left out by name: it is wrangler's local state, megabytes of it once the
   * owner has run `wrangler dev`, and none of it can be committed. **That, not this test, is the
   * fence for both**: the root `.gitignore` ignores `.dev.vars`, `.dev.vars.*` and `.wrangler/`
   * everywhere, and CI's checkout never has either. What this adds is on the machine that has
   * them — a `.dev.vars` here is red before anybody reaches for `git add -f`.
   */
  const files = import.meta.glob(
    [
      "/app-worker/**/*",
      "/tsconfig.app-worker.json",
      "!/app-worker/.wrangler/**",
      "!/app-worker/node_modules/**",
    ],
    { query: "?raw", import: "default", eager: true, exhaustive: true },
  );

  it("sweeps every file here", () => {
    const names = Object.keys(files);
    for (const wanted of ["wrangler.jsonc", "_headers", "README.md", "src/index.ts"]) {
      expect(names).toContain(`/app-worker/${wanted}`);
    }
  });

  it("can see a dotfile at all", () => {
    // The option the sweep leans on, shown on a dotfile that is always there. If a Vite upgrade
    // changes what `exhaustive` means, this is what says so.
    const dotfile = import.meta.glob("/.nvmr*", {
      query: "?raw",
      import: "default",
      eager: true,
      exhaustive: true,
    });
    expect(Object.keys(dotfile)).toEqual(["/.nvmrc"]);
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
    // Wrangler's two homes for a local secret. This Worker has none to keep in either.
    expect(Object.keys(files).filter((name) => /\/\.(dev\.vars|env)[^/]*$/.test(name))).toEqual([]);
  });

  it("keeps `_headers` out of both public directories, which builds copy whole", () => {
    // The root's goes into the desktop's `dist/` and the share viewer's `dist-share/`;
    // `mobile/public/` into the APK's `dist-mobile/` as well as `dist-web/`. The web build emits
    // this one file itself, in `web` mode alone.
    // (`**`, because a pattern with nothing to expand is one the glob import refuses.)
    const copied = import.meta.glob(["/public/**/_headers", "/mobile/public/**/_headers"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    expect(Object.keys(copied)).toEqual([]);
  });

  it("is the only file at the build's root a host does not serve", () => {
    // Cloudflare parses `_headers` and answers its address with a 404, so a service worker's
    // precache list that named it would fail its install. The list leaves out what starts with
    // `_` at the root; nothing the light builds copy there may start with one and want serving.
    const atRoot = import.meta.glob("/mobile/public/*", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const names = Object.keys(atRoot).map((path) => path.slice(path.lastIndexOf("/") + 1));
    expect(names).toContain("light.webmanifest");
    expect(names.filter((name) => name.startsWith("_"))).toEqual([]);
  });
});
