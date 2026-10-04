#!/usr/bin/env node
// The web host's smoke run: the built app, in a real browser, over the real engine — a first run.
//
//     npm run web:wasm && npm run web:build && npm run web:smoke
//
// A green suite proves the host it ran on, and no suite runs the WASM module: vitest drives the
// Worker's logic over a fake, and cargo compiles the engine for a browser without starting one.
// This is the run that instantiates it. It serves `dist-web/` **as the production host will** —
// every response under the headers `dist-web/_headers` gives its address, the
// Content-Security-Policy among them, and a miss as the hosting Worker's own 404 — opens it in
// headless Chromium over the DevTools protocol, and asks seventeen things, in this order — the
// first sixteen of one browser, and the last of a second, because it needs a first run of its
// own:
//
//   1. the app got past its startup gate — the engine loaded, and opened and migrated a database
//      on a rollback journal, which the page says on its console
//   2. that database is in OPFS, in the folder the page names
//   3. the service worker registered and took the page: scope `/`, script `/sw.js`, and one
//      shell cache holding the document, the database Worker's chunk and both engine files
//   4. an empty card database reads as a first run: the page says it is setting one up, with the
//      sync's phase beside it, while the card file is still on its way
//   5. the card sync finishes, and a search typed into the page's own box draws that card's tile
//   6. the tile's picture decoded, and is in the picture cache under the app's own address with
//      the Scryfall address it came from; asked again, it is answered without asking Scryfall
//   7. the launch's three feeds — both Tagger files and the combos — finish with rows stored and
//      nothing in the error log
//   8. Settings offers the price lists this host can reach: Mana Pool greyed, and Card Kingdom
//      downloaded and stored when it is picked
//   9. **offline** — the server refusing every connection, every other host gone and the HTTP
//      cache emptied — a reload draws the app, opens the database, answers a search and draws
//      the cached picture, having asked no host for anything; back online, a check forced past
//      its interval asks for the card listing and for no card file
//  10. Settings' Clear cache empties the picture cache and leaves the shell
//  11. a second tab is told the app is open elsewhere, and offered a reload
//  12. a new build of the worker installs and *waits*: the page draws its bar, a second shell
//      cache stands beside the first, and a reload leaves all of that as it is
//  13. the bar's button, and nothing else, hands over: the page starts again once, on the new
//      build's shell alone, with no bar — and the second tab is neither told nor reloaded
//  14. a deck is made and a note opened in it: the editor — the app's one lazily loaded chunk,
//      over a library that appends a stylesheet of its own unless told not to — draws, takes
//      typing, and leaves no style element on the page
//  15. no request would cost a CORS pre-flight — the worker's picture fetch included — and none
//      went to a host this script has no answer for
//  16. the host's Content-Security-Policy refused nothing, anywhere: not in a page, not in the
//      engine's Worker, not in the service worker (`watchPolicy` has why those are three)
//  17. on a fresh profile whose card file is thirty thousand cards, a reload made the moment
//      the engine stops answering — it is inside a synchronous call, and the Worker the page
//      leaves behind still holds the database — draws the app and no refusal, and the page says
//      it had to ask again (`reloadInsideTheIngest` has why that line is the check, and what
//      happens when the reload misses). Under the same policy, with the same two fences.
//
// **No request leaves the machine.** The engine starts the launch's downloads the moment the
// database opens, and the service worker fetches a picture for every tile, so every
// cross-origin request is paused by the DevTools `Fetch` domain and answered from
// `scripts/web-smoke/` with the headers the real host sends — the seventeenth check's card file
// excepted, which is those six cards grown in memory. Two fences stand behind that: a
// request to a host with no fixture is failed *and fails the run*, and the browser is started
// with a resolver that knows no name but `localhost`, so a request the interception never saw
// cannot be answered by anyone.
//
// **Where a Worker's `fetch` can be caught** (measured, Chrome 154, 2026-10-04): the engine's
// requests are the dedicated Worker's, and that Worker's own DevTools session has no `Fetch`
// domain — `Fetch.enable` there answers "wasn't found"; it only *reports* them, through
// `Network`. They are paused on the page's session and on the browser's, and so are the
// service worker's. This uses the browser's: one enable, before any tab exists, for every tab
// and every worker.
//
// **Four things here go through the engine and not the page's own controls**, by importing the
// chunk the page already loaded (`assets/web-*.js`, whose `webCore` is the page's one `Core`):
// the feeds' status reads, the error log, the card count, and the forced check of step 9. The
// phone face draws no status for a tag or combo feed and has no Refresh for the cards.
//
// No dependencies, like `cdp.mjs`: Node has a global `WebSocket`, and Chromium prints its
// debugging address when it starts. The browser is `CHROME` when that is set (CI sets it),
// else the first of Chrome and Edge found where they install.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
// Plain TypeScript with nothing but erasable types, which Node strips as it loads: the host's own
// reader of `_headers`, and the rule its script and both local servers tell a place by.
import { headersFor, parseHeaders } from "../app-worker/src/headers.ts";
import { isNavigation } from "../src/lib/core/web/assets.ts";

const DIST = resolve("dist-web");
/** What the hosts answer with. Beside this file, so it is found whatever the working directory. */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "web-smoke");
/** The folder `src/lib/core/web/index.ts` asks the engine to keep its databases in. */
const OPFS_DIRECTORY = "mtg-grimoire";
/** How long the whole run may take. CI's step has a longer bound of its own behind this one. */
const DEADLINE_MS = 180_000;
const started = performance.now();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  // Chromium refuses to stream-compile a module served as anything else.
  ".wasm": "application/wasm",
};

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * What to stop, newest first: the server, the browser, its socket, its profile. Each is pushed
 * the moment it exists — a browser that fails to start must not leave the server listening, and
 * a listening server is what keeps this process alive after it has printed its verdict.
 */
const undo = [];
async function stopEverything() {
  while (undo.length > 0) await Promise.resolve(undo.pop()()).catch(() => undefined);
}

function fail(message) {
  console.error(`web-smoke: FAILED — ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

// ---------------------------------------------------------------------------------------------
// The hosts, answered from `scripts/web-smoke/`
// ---------------------------------------------------------------------------------------------

/** Scryfall's stamp for all three bulk files. A reload's forced check finds it unchanged. */
const UPDATED_AT = "2026-10-04T09:05:46.742+00:00";
const LAST_MODIFIED = "Sun, 04 Oct 2026 09:05:46 GMT";

const CARDS_LISTING = "https://api.scryfall.com/bulk-data/default_cards";
const CARDS_FILE = "https://data.scryfall.io/default-cards/default-cards-20261004090546.jsonl.gz";
const ORACLE_LISTING = "https://api.scryfall.com/bulk-data/oracle_tags";
const ORACLE_FILE = "https://data.scryfall.io/oracle-tags/oracle-tags-20261004090546.jsonl.gz";
const ART_LISTING = "https://api.scryfall.com/bulk-data/art_tags";
const ART_FILE = "https://data.scryfall.io/art-tags/art-tags-20261004090546.jsonl.gz";
const SETS = "https://api.scryfall.com/sets";
const MIGRATIONS = "https://api.scryfall.com/migrations";
const CARD_KINGDOM = "https://api.cardkingdom.com/api/v2/pricelist";
const SPELLBOOK = "https://json.commanderspellbook.com/variants.json.gz";

/** The four picture sizes the engine names an address for (`schema::IMAGE_VARIANTS`). */
const PICTURE_VARIANTS = ["thumb", "grid", "display", "art"];
/** Where the web app asks for a picture — its own origin (`src/lib/images.ts`). */
const PICTURE_PREFIX = "/mtgimg";
/** The service worker's two caches (`src/lib/core/web/sw/`): one shell per build, one of pictures. */
const SHELL_PREFIX = "grimoire-shell-";
const PICTURE_CACHE = "grimoire-pictures-v1";

/** The fixture cards, as the engine ingests them. */
function fixtureCards() {
  return readFileSync(join(FIXTURES, "default-cards.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/**
 * The Scryfall address the engine answers for one of the app's own picture paths —
 * `/mtgimg/<variant>/<card id>/<face>` — read off the fixture card as the engine reads it: the
 * card's own `image_uris`, or that face's for a card whose pictures are per face.
 */
function pictureAddress(path) {
  const [variant, id, face] = path.slice(PICTURE_PREFIX.length + 1).split("/");
  const card = fixtureCards().find((entry) => entry.id === id);
  const uris = card?.image_uris ?? card?.card_faces?.[Number(face)]?.image_uris;
  return uris?.[variant] ?? null;
}

/**
 * Every fixture URL and what it is answered with: a body, and the response headers the real
 * host sent a browser — read off the Worker's requests on a real first run (Chrome 154,
 * 2026-10-04) and kept to the ones a page's `fetch` or the engine can act on.
 *
 * - **`Access-Control-Allow-Origin: *` on all of them.** It is not decoration here: a fulfilled
 *   response is CORS-checked like any other, and without the header the engine's request fails
 *   with `MissingAllowOriginHeader` (measured).
 * - **An `ETag` on the hosts that send one**, which the engine must not need: nobody exposes
 *   it, so a page reads it as absent.
 * - **A bulk listing's `compressed_size` is the length of the body served for it**, computed
 *   here from the bytes: the engine answers the end of a file only when exactly that many
 *   arrived. The three `.jsonl` files are committed as text and gzipped on the way out, as
 *   Scryfall's are real `.gz` files and not a `Content-Encoding`.
 * - **Everything else is `Content-Encoding: gzip` on the wire, and is served here as a page
 *   reads it** ({@link encoded}): a browser's `fetch` decodes that before any script sees a
 *   byte, so the body is the JSON, and `Content-Length` — where the host declares one — is the
 *   *wire's*, smaller than the body. Commander Spellbook declares 28.8 MB and delivers 677.
 *   `Fetch.fulfillRequest` decodes nothing (measured: a gzipped body under that header reached
 *   the page still gzipped), so serving the gzip would run the arm of the engine no browser
 *   takes for these hosts.
 * - **Card Kingdom's price list is `text/html`**, and is JSON. That is what the host says of
 *   it, to a browser as to `curl`; an engine that came to trust the type would lose the feed.
 * - **Every picture address the six cards name is answered with one small WebP** (`card.webp`,
 *   50 × 70, encoded by Chrome's own canvas): four sizes of each card or face. The service
 *   worker asks with CORS and rebuilds what it stores from the bytes and the `Content-Type`.
 *
 * `cardFile` is the card file's lines when they are not the committed six; the listing's
 * `compressed_size` follows it, being read off the bytes.
 */
function fixtures(cardFile) {
  const read = (name) => readFileSync(join(FIXTURES, name));
  /** `body` as a page reads a response the host gzipped in transit. `declares` is whether the
   *  host sent a `Content-Length` at all: Scryfall's `/sets` and Card Kingdom do not. */
  const encoded = (body, headers, declares) => ({
    body,
    headers: {
      ...headers,
      "Content-Encoding": "gzip",
      "Content-Length": declares ? String(gzipSync(body).length) : null,
    },
  });
  const api = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public",
    ETag: 'W/"a-fixture-nobody-can-read"',
    Vary: "Accept-Encoding",
  };
  const file = {
    "Content-Type": "application/gzip",
    "Content-Disposition": "attachment",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31556952",
    "Last-Modified": LAST_MODIFIED,
    ETag: '"a-fixture-nobody-can-read"',
    Vary: "Origin",
  };
  const listing = (type, uri, body) =>
    encoded(
      Buffer.from(
        JSON.stringify({
          object: "bulk_data",
          type,
          updated_at: UPDATED_AT,
          compressed_size: body.length,
          jsonl_download_uri: uri,
        }),
      ),
      api,
      true,
    );
  // The committed six cards, unless a check brought a card file of its own ({@link grownCards}).
  const cards = gzipSync(cardFile ?? read("default-cards.jsonl"));
  const oracle = gzipSync(read("oracle-tags.jsonl"));
  const art = gzipSync(read("art-tags.jsonl"));
  const picture = {
    body: read("card.webp"),
    headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000" },
  };
  const pictures = fixtureCards()
    .flatMap((card) => [card, ...(card.card_faces ?? [])])
    .flatMap((side) => PICTURE_VARIANTS.map((variant) => side.image_uris?.[variant]))
    .filter((address) => typeof address === "string")
    .map((address) => [address, picture]);

  return new Map([
    ...pictures,
    [CARDS_LISTING, listing("default_cards", CARDS_FILE, cards)],
    [CARDS_FILE, { body: cards, headers: file }],
    [SETS, encoded(read("sets.json"), api, false)],
    // Asked only of a database with a collection, a wishlist or a deck in it, so not by this
    // run. Answered all the same: a run that grows a write must not meet a missing fixture.
    [MIGRATIONS, encoded(read("migrations.json"), api, false)],
    [ORACLE_LISTING, listing("oracle_tags", ORACLE_FILE, oracle)],
    [ORACLE_FILE, { body: oracle, headers: file }],
    [ART_LISTING, listing("art_tags", ART_FILE, art)],
    [ART_FILE, { body: art, headers: file }],
    [
      CARD_KINGDOM,
      encoded(
        read("cardkingdom-pricelist.json"),
        {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          "Last-Modified": LAST_MODIFIED,
          Vary: "Accept-Encoding",
        },
        false,
      ),
    ],
    [
      SPELLBOOK,
      encoded(
        read("spellbook-variants.json"),
        {
          "Content-Type": "application/json",
          "Accept-Ranges": "bytes",
          "Last-Modified": LAST_MODIFIED,
          ETag: '"a-fixture-nobody-can-read"',
        },
        true,
      ),
    ],
  ]);
}

/**
 * Request headers only the browser itself writes — the Fetch standard's forbidden names, less
 * `User-Agent`, which {@link preflightCost} holds to the browser's own value. A script cannot
 * set one of these, so one on a request says nothing about the engine.
 */
const BROWSERS_OWN = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

/** The request headers a script may add to a cross-origin `GET` for free — the CORS safelist,
 *  **less `Range`**: current browsers safelist a simple one, and the engine must still not
 *  send it, because a page cannot read `Content-Range` to verify what a resume got. */
const SAFELISTED = new Set(["accept", "accept-language", "content-language"]);

/**
 * Why this request would be a failed one against the real host, or `null`.
 *
 * Measured 2026-10-04 (light-app.md §9.1): `data.scryfall.io` and Commander Spellbook answer a
 * pre-flight 403, and `api.scryfall.com` answers one without listing `If-None-Match` — so a
 * request that needs a pre-flight is a request that fails, and a fixture answering it anyway
 * would hide exactly that. **The pre-flight itself never shows here** (it is the network
 * stack's, below where a request is paused), so this reads what would cause one: a method
 * that is not a plain `GET`, and any header outside the safelist that the browser did not
 * write itself. `If-None-Match`, `If-Modified-Since` and `Range` are each one of those.
 */
function preflightCost(request, userAgent) {
  if (request.method !== "GET") return `it is a ${request.method}`;
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (lower === "user-agent") {
      // A page may not choose one. Chromium drops a script-set one; an engine that honoured it
      // would pre-flight for it. Either way the browser's own is the only one that may go out.
      if (value !== userAgent) return `it carries a User-Agent of its own (${value})`;
      continue;
    }
    if (SAFELISTED.has(lower) || BROWSERS_OWN.has(lower)) continue;
    if (lower.startsWith("sec-") || lower.startsWith("proxy-")) continue;
    return `it carries ${name}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The server and the browser
// ---------------------------------------------------------------------------------------------

/** What the hosting Worker's script answers a miss with (`app-worker/src/index.ts`'s `REFUSAL`). */
const NOT_FOUND = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

/**
 * `dist-web/` on a port of the system's choosing, **answered as the production host answers
 * it** — and two things a check changes about that host while the run goes on (`site`).
 *
 * - **Every 200 carries what `dist-web/_headers` says that address is sent**, read by the
 *   hosting Worker's own reader (`app-worker/src/headers.ts`) and matched against the path the
 *   browser asked, never the file that answered it. So the Content-Security-Policy, `nosniff`
 *   and each tree's `Cache-Control` meet the app here, and not first on the day of a deploy.
 * - **A file is itself; a place is the document; everything else is the host's bare 404.**
 *   `/` is the document to every caller. A request that says it is a navigation
 *   (`Sec-Fetch-Mode: navigate`) is answered with the document before the Worker's script
 *   runs, as Cloudflare does; one that does not say is a place by `isNavigation`, the script's
 *   own rule, which knows the trees where nothing is one — so `/mtgimg/…` asked for by an
 *   `<img>`, a missing chunk and `/_headers` are each a 404 that nothing may keep.
 * - **No `no-store` on the shell, and it matters less than it did.** The precache used to start
 *   every fetch at once and read no body until all had answered; uncacheable bodies then held
 *   all six of HTTP/1.1's sockets and the install never ended. It takes four at a time now.
 * - **`site.refusing` is the host gone**: every connection is dropped unanswered.
 * - **`site.build` is a second deploy**: `sw.js` is served with its build id — a literal in the
 *   file, and the whole of what names its shell cache — swapped for another, and nothing else
 *   changed. To a browser that is a new worker.
 */
async function serve() {
  if (!existsSync(join(DIST, "index.html"))) {
    fail("dist-web/index.html is missing. Run `npm run web:wasm` and `npm run web:build` first.");
  }
  if (!existsSync(join(DIST, "_headers"))) {
    fail("dist-web/_headers is missing: the build did not emit the host's policy.");
  }
  const rules = parseHeaders(readFileSync(join(DIST, "_headers"), "utf8"));
  const site = { refusing: false, build: null };
  const server = createServer(async (request, response) => {
    if (site.refusing) return void request.socket.destroy();
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const onDisk = normalize(join(DIST, path));
    // A path that climbs out of the folder is nobody's file, and neither is the host's own.
    const file =
      onDisk.startsWith(DIST + sep) &&
      path !== "/_headers" &&
      existsSync(onDisk) &&
      statSync(onDisk).isFile();
    const place =
      path === "/" ||
      request.headers["sec-fetch-mode"] === "navigate" ||
      isNavigation(request.method, request.headers.accept, path);
    const target = file ? onDisk : place ? join(DIST, "index.html") : null;
    if (target === null) {
      response.writeHead(404, NOT_FOUND);
      response.end("Not found");
      return;
    }
    let body = await readFile(target);
    if (path === "/sw.js" && site.build) {
      body = Buffer.from(body.toString("utf8").replace(site.build.from, site.build.to));
    }
    const sent = headersFor(rules, path);
    response.writeHead(200, {
      "Content-Type": TYPES[extname(target)] ?? "application/octet-stream",
      ...sent,
    });
    response.end(body);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  undo.push(() => {
    server.close();
    // `close` waits for kept-alive sockets, which a killed browser may never hang up.
    server.closeAllConnections();
  });
  return { origin: `http://localhost:${server.address().port}`, site };
}

function browserPath() {
  const named = process.env.CHROME;
  if (named) return named;
  const installed = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((path) => existsSync(path));
  if (installed) return installed;
  return fail("no browser found. Set CHROME to a Chromium-based browser's executable.");
}

/** Start the browser and answer its DevTools address, which it prints once it is listening,
 *  and the way to stop it. */
async function launch(profile) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // The second fence: no name but `localhost` resolves, so a request that somehow went round
    // the interception is a failed request and never a download.
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
    // The browser's own errands — component updates and the like — are none of this run's.
    // Asked for rather than measured: whatever it still tries meets the resolver above.
    "--disable-background-networking",
    "--disable-component-update",
  ];
  // A runner's kernel refuses the sandbox's namespaces to an unprivileged process, and the only
  // page this browser ever loads is the one this script serves.
  if (process.env.CI) args.push("--no-sandbox");
  const child = spawn(browserPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
  // Registered before anything can fail, so a browser that never listens is still stopped.
  const kill = () => child.kill();
  undo.push(kill);
  let heard = "";
  return new Promise((found, lost) => {
    child.stderr.on("data", (chunk) => {
      heard += chunk;
      const hit = /DevTools listening on (ws:\/\/\S+)/.exec(heard);
      if (hit) found({ address: hit[1], kill });
    });
    child.on("exit", (code) => lost(new Error(`the browser exited (${code}): ${heard}`)));
    // Unreferenced: a timer still pending must not hold a finished run open for its length.
    setTimeout(() => lost(new Error(`the browser never listened: ${heard}`)), 30_000).unref();
  });
}

/** One socket to the browser; a page is a session on it. */
async function connect(address) {
  const socket = new WebSocket(address);
  await new Promise((opened, refused) => {
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", () => refused(new Error("no DevTools socket")), {
      once: true,
    });
  });
  let next = 0;
  const pending = new Map();
  const heard = [];
  /** An event that is *acted on* — a paused request, a refusal — instead of kept: its
   *  parameters, and the session it came from. */
  const handlers = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) {
      const handler = handlers.get(message.method);
      if (handler) return void handler(message.params, message.sessionId);
      return heard.push(message);
    }
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const on = (method, handler) => handlers.set(method, handler);
  return { send, on, heard, close: () => socket.close() };
}

/**
 * Pause every `http(s)` request the browser makes — in any tab, from the database Worker and
 * from the service worker — and answer it: the app's own origin goes through to the server, a
 * fixture URL is fulfilled, and the rest is failed. Answers what was asked, so a check can read
 * the log.
 *
 * **A request with no fixture, and one that would cost a pre-flight, are written down rather
 * than thrown**: this runs in the socket's listener, where a throw reaches nobody. `problems`
 * is the run's one list of them — `watchPolicy` writes to it too — read by every wait and once
 * more at the end.
 */
async function intercept(browser, origin, userAgent, problems, routes) {
  /** Each cross-origin request that has a fixture, in order: `{ method, url, headers }`. */
  const asked = [];
  /** URLs whose answer waits on a caller: `url -> promise`. */
  const held = new Map();
  /** No network: a request that has a fixture is still written down, and then fails. */
  let offline = false;

  browser.on("Fetch.requestPaused", async ({ requestId, request }) => {
    const answer = (method, params) =>
      // A tab that closed, or a browser on its way down, has no request left to answer.
      browser.send(method, { requestId, ...params }).catch(() => undefined);
    if (request.url === origin || request.url.startsWith(`${origin}/`)) {
      return answer("Fetch.continueRequest");
    }
    // The fragment-free URL as asked, query included: a fixture answers one address.
    const route = routes.get(request.url);
    if (!route) {
      problems.push(`a request to a host with no fixture: ${request.method} ${request.url}`);
      return answer("Fetch.failRequest", { errorReason: "Failed" });
    }
    asked.push({ method: request.method, url: request.url, headers: request.headers });
    const cost = preflightCost(request, userAgent);
    if (cost) {
      problems.push(
        `${request.method} ${request.url} would cost a CORS pre-flight, which this host ` +
          `refuses: ${cost}. Its headers: ${JSON.stringify(request.headers)}`,
      );
    }
    if (offline) return answer("Fetch.failRequest", { errorReason: "InternetDisconnected" });
    await held.get(request.url);
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Content-Length": String(route.body.length),
      // A route's own word on any of them wins; `null` is a header the host does not send.
      ...route.headers,
    };
    return answer("Fetch.fulfillRequest", {
      responseCode: 200,
      responseHeaders: Object.entries(headers)
        .filter(([, value]) => value !== null)
        .map(([name, value]) => ({ name, value })),
      body: route.body.toString("base64"),
    });
  });
  await browser.send("Fetch.enable", {
    patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }],
  });

  return {
    asked,
    /** Take every other host away, or give them back. */
    offline(gone) {
      offline = gone;
    },
    /** Fail the run on anything written down so far. */
    check() {
      // Each once: an issue is reported again to a session that starts listening after it.
      if (problems.length > 0) fail([...new Set(problems)].join("\n"));
    },
    /** Keep `url` unanswered until the returned function is called. */
    hold(url) {
      let release;
      held.set(url, new Promise((done) => (release = done)));
      return release;
    },
    /** The URLs asked since `mark` — a length of `asked` noted earlier. */
    since: (mark) => asked.slice(mark).map((entry) => entry.url),
  };
}

/**
 * Hear every Content-Security-Policy refusal, in every place one can happen, and write each
 * down as a problem — which fails the run at the next wait.
 *
 * **Three targets, each under a policy of its own.** A page is held to the policy on its
 * document; a dedicated Worker and a service worker are each held to the policy on *their own
 * script's* response. So the engine's downloads are allowed or refused by what came with
 * `assets/worker-*.js`, and a card picture's fetch by what came with `sw.js` — and a
 * `securitypolicyviolation` listener on the page hears neither. Each target is therefore a
 * DevTools session of its own here, asked for its `Audits` issues: a
 * `ContentSecurityPolicyIssue` names the directive and what it refused — a connection, a
 * picture, a script, a WebAssembly compile — and one raised before the session was listening is
 * sent again when it starts. (A request the policy stopped also fails on `Network` with
 * `blockedReason: "csp"`, but only for a page's own resources: a Worker's refused `fetch`
 * never appears there. Measured, Chrome 154; so that domain is not asked.)
 *
 * **Attached once each, and that is load-bearing** (measured, Chrome 154): a service worker
 * that two auto-attaching sessions both took — the browser's and the page's — never finished
 * installing. So the browser's session takes service workers and nothing else, and a page's
 * takes its dedicated Workers and nothing else.
 */
async function watchPolicy(browser, problems) {
  /** Session → what it is, for the sentence. */
  const targets = new Map();
  const watch = async (sessionId, name) => {
    targets.set(sessionId, name);
    await browser.send("Audits.enable", {}, sessionId);
  };

  browser.on("Audits.issueAdded", ({ issue }, sessionId) => {
    const refused = issue.details?.contentSecurityPolicyIssueDetails;
    if (issue.code !== "ContentSecurityPolicyIssue" || !refused) return;
    problems.push(
      `the Content-Security-Policy on ${targets.get(sessionId)} was violated: ` +
        `${refused.violatedDirective} (${refused.contentSecurityPolicyViolationType})` +
        (refused.blockedURL ? ` refused ${refused.blockedURL}` : ""),
    );
  });
  browser.on("Target.attachedToTarget", async ({ sessionId, targetInfo }) => {
    // Held at its first instruction until it is being listened to, so nothing it does first
    // goes unheard. A target that has already gone has nothing left to say.
    await watch(sessionId, `${targetInfo.type} ${targetInfo.url}`).catch(() => undefined);
    await browser.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
  });
  const attach = (only, sessionId) =>
    browser.send(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        // The first entry that matches a target decides: this kind, and no other.
        filter: [{ type: only }, { exclude: true }],
      },
      sessionId,
    );
  await attach("service_worker");

  return {
    /** Watch a page, and every dedicated Worker it starts. */
    async page(sessionId, name) {
      await watch(sessionId, name);
      await attach("worker", sessionId);
    },
    /** Every target that was listened to, by what it is. */
    watched: () => [...targets.values()],
  };
}

/** A tab on `url`, with what it threw kept. `problems` is checked on every wait, and `policy`
 *  is told of the tab before it loads anything. */
async function openPage(browser, url, problems, policy) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);
  // A tab that is not the browser's front one still takes typed text as a focused page does.
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  await policy?.page(sessionId, `the page at ${url}`);
  await browser.send("Page.navigate", { url }, sessionId);
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await browser.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "threw");
    return result.value;
  };
  /** Poll until `expression` is truthy; answer its value, or say what the page showed instead. */
  const until = async (what, expression, withinMs = 90_000) => {
    const stop = performance.now() + withinMs;
    for (;;) {
      problems();
      // A navigation in flight has no document to ask; the next poll does.
      const value = await evaluate(expression).catch(() => undefined);
      if (value) return value;
      if (performance.now() > stop || performance.now() - started > DEADLINE_MS) {
        const shown = await evaluate("document.body.innerText").catch(() => "(no document)");
        return fail(`${what} — never happened. The page shows:\n${shown}`);
      }
      await pause(250);
    }
  };
  const thrown = () =>
    browser.heard
      .filter((m) => m.sessionId === sessionId && m.method === "Runtime.exceptionThrown")
      .map((m) => m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  /** Every line the page wrote to its console, as text. */
  const said = () =>
    browser.heard
      .filter((m) => m.sessionId === sessionId && m.method === "Runtime.consoleAPICalled")
      .map((m) => m.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  const reload = () => browser.send("Page.reload", {}, sessionId);
  /** Empty the browser's HTTP cache — every tab's. Cache Storage is another thing, and stays. */
  const forget = () => browser.send("Network.clearBrowserCache", {}, sessionId);
  /**
   * A real press — the pointer down and up at the middle of the element `find` answers — once
   * that element is on the page with a box. Not `element.click()`: the phone router takes only
   * a primary click nothing else handled, and a press is what a reader makes.
   */
  const press = async (what, find) => {
    const at = await until(
      `${what} is there to press`,
      `(() => {
        const el = ${find};
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0
          ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          : null;
      })()`,
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await browser.send(
        "Input.dispatchMouseEvent",
        { type, x: at.x, y: at.y, button: "left", clickCount: 1 },
        sessionId,
      );
    }
  };
  /** Type into whatever the last press focused, as the keyboard's own input event. */
  const type = (text) => browser.send("Input.insertText", { text }, sessionId);
  return { evaluate, until, thrown, said, reload, forget, press, type };
}

// ---------------------------------------------------------------------------------------------
// What the page is asked
// ---------------------------------------------------------------------------------------------

/** The phone face's tab bar: drawn only once the startup gate has let the app through. */
const SHELL = `!!document.querySelector('nav[aria-label="Views"]')`;
/** What the gate draws instead when it failed. */
const ALERT = `document.querySelector('[role="alert"]')?.innerText`;
/** Every name in the app's OPFS folder, or `null` when the folder is not there. */
const OPFS = `(async () => {
  const root = await navigator.storage.getDirectory();
  let folder;
  try { folder = await root.getDirectoryHandle(${JSON.stringify(OPFS_DIRECTORY)}); }
  catch { return null; }
  const names = [];
  const walk = async (dir, prefix) => {
    for await (const [name, handle] of dir.entries()) {
      names.push(prefix + name);
      if (handle.kind === "directory") await walk(handle, prefix + name + "/");
    }
  };
  await walk(folder, "");
  return names;
})()`;
/** The phone Search page's box. */
const SEARCH_BOX = `document.querySelector('input[type="search"][aria-label="Search cards"]')`;
/** A card's tile on the wall, by the card's name — a tile's button is named for its printing
 *  (`Lightning Bolt, LEA 161`). An element: for a press, or to ask something of. */
const tileOf = (name) =>
  `document.querySelector('[aria-label="Search results"] button[aria-label^=${JSON.stringify(`${name},`)}]')`;
/** Whether the wall draws that tile. A boolean: an element does not cross the protocol. */
const tile = (name) => `!!${tileOf(name)}`;
/** The path of the picture a tile drew — once it has decoded — or `null` while it has not. */
const pictureIn = (name) =>
  `(() => {
    const img = ${tileOf(name)}?.querySelector("img");
    return img && img.complete && img.naturalWidth > 0 ? new URL(img.currentSrc).pathname : null;
  })()`;
/** A row of Settings' marketplace picker, by the name it is drawn under. */
const marketplaceRow = (label) =>
  `[...document.querySelectorAll("button[aria-pressed]")].find(
    (row) => row.querySelector("span[id$='-name']")?.textContent === ${JSON.stringify(label)},
  )`;
/** A button by the words on it, inside `within` (a selector) when one is given. */
const buttonSaying = (words, within = "") =>
  `[...document.querySelectorAll(${JSON.stringify(`${within} button`.trim())})].find(
    (button) => button.innerText.trim() === ${JSON.stringify(words)},
  )`;
/** The note editor's writing surface, in the dialog a deck's New note opens. */
const NOTE_SURFACE = `document.querySelector('[role="dialog"] [role="textbox"][aria-multiline="true"]')`;
/** The update bar's two halves: the sentence, which a live region always holds, and the button. */
const BAR_SAYS = "A new version of MTG Grimoire is ready.";
const BAR_BUTTON = "Reload to update";
const BAR = `!!${buttonSaying(BAR_BUTTON)} && document.body.innerText.includes(${JSON.stringify(BAR_SAYS)})`;
/**
 * The service worker as a page sees it: who controls the page, the registration's scope and
 * its workers' states, and every shell cache with the paths it holds.
 */
const WORKER = `(async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  const shells = {};
  for (const name of await caches.keys()) {
    if (!name.startsWith(${JSON.stringify(SHELL_PREFIX)})) continue;
    const held = await (await caches.open(name)).keys();
    shells[name] = held.map((request) => new URL(request.url).pathname);
  }
  return {
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    scope: registration?.scope ?? null,
    active: registration?.active?.state ?? null,
    waiting: registration?.waiting?.state ?? null,
    shells,
  };
})()`;
/** The picture cache: every path it holds, and what it kept beside the one at `path`. */
const pictures = (path) => `(async () => {
  if (!(await caches.keys()).includes(${JSON.stringify(PICTURE_CACHE)})) return { keys: [] };
  const cache = await caches.open(${JSON.stringify(PICTURE_CACHE)});
  const hit = await cache.match(${JSON.stringify(path)});
  return {
    keys: (await cache.keys()).map((request) => new URL(request.url).pathname),
    source: hit?.headers.get("X-Grimoire-Source") ?? null,
    type: hit?.headers.get("Content-Type") ?? null,
  };
})()`;

/**
 * The page's own `Core`, reached through the chunk the page already loaded: a module is
 * evaluated once per URL, so this import answers the instance whose Worker holds the database.
 * The chunk's name carries a hash, so it is read off the build this script is serving.
 */
function coreChunk() {
  const name = readdirSync(join(DIST, "assets")).find((file) => /^web-[\w-]+\.js$/.test(file));
  if (!name) fail("dist-web/assets has no web-*.js chunk — the built app's `Core` moved.");
  return `/assets/${name}`;
}

/** The three files a shell cache must hold beside the document for the engine to start offline. */
function engineFiles() {
  const chunk = readdirSync(join(DIST, "assets")).find((file) => /^worker-[\w-]+\.js$/.test(file));
  const build = readdirSync(join(DIST, "wasm"))[0];
  if (!chunk || !build) fail("dist-web has no database Worker chunk, or no engine folder.");
  return [
    `/assets/${chunk}`,
    `/wasm/${build}/grimoire_web.js`,
    `/wasm/${build}/grimoire_web_bg.wasm`,
  ];
}

/**
 * A browser on a profile of its own — so a first run — with every request it makes answered
 * from `routes` and the host's policy listened to on every target. `close` stops it and removes
 * the profile; it is on the undo list too, so a run that fails anywhere leaves neither behind.
 */
async function browse(origin, routes) {
  const profile = await mkdtemp(join(tmpdir(), "grimoire-web-smoke-"));
  let socket = null;
  let stop = () => undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    socket?.close();
    stop();
    // The browser lets go of its profile a moment after it is told to stop.
    await pause(500);
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  };
  undo.push(close);
  const { address, kill } = await launch(profile);
  stop = kill;
  const browser = (socket = await connect(address));

  // Asked of a blank tab before anything is intercepted: what every request's `User-Agent` must
  // still be when it leaves. The page's own, not `Browser.getVersion`'s, which is unreduced.
  const blank = await openPage(browser, "about:blank", () => undefined);
  const userAgent = await blank.evaluate("navigator.userAgent");
  /** Everything that fails the run without throwing where it happened. */
  const problems = [];
  const hosts = await intercept(browser, origin, userAgent, problems, routes);
  const policy = await watchPolicy(browser, problems);
  return { browser, hosts, policy, close };
}

// ---------------------------------------------------------------------------------------------
// A reload that lands inside a synchronous engine call
// ---------------------------------------------------------------------------------------------

/** How many cards the grown card file holds. The six fixture cards are ingested inside one
 *  poll of this script; this many keep the engine inside one synchronous call for well over
 *  {@link BUSY_MS} — about a second of it on the machine this was written on. */
const GROWN_CARDS = 30_000;
/** A read the engine has not answered in this long is a read queued behind a synchronous call:
 *  an idle engine answers `sync_status` in a millisecond or two. */
const BUSY_MS = 250;
/** How many first runs the check may stage before it gives up on landing a reload in time. */
const RELOAD_ATTEMPTS = 3;
/** What the page says when an open it had to retry got through (`src/lib/core/web/index.ts`). */
const RETRIED = "still held by a page that had gone";

/**
 * The card file, grown: the six fixture lines over and over, each copy under an `id` and a
 * collector number of its own, so every line is another printing to the engine. Made here and
 * never committed — it is tens of megabytes of text, and a megabyte or so gzipped.
 */
function grownCards(count) {
  const lines = readFileSync(join(FIXTURES, "default-cards.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const grown = [];
  for (let index = 0; grown.length < count; index += 1) {
    const line = lines[index % lines.length];
    // The first round is the fixture as committed, so the cards a wall draws are still there.
    if (index < lines.length) {
      grown.push(line);
      continue;
    }
    const renamed = line
      .replace(
        /"id":"[0-9a-f-]{36}"/,
        `"id":"aaaaaaaa-0000-4000-8000-${index.toString(16).padStart(12, "0")}"`,
      )
      .replace(/"collector_number":"[^"]*"/, `"collector_number":"G${index}"`);
    if (renamed === line) fail("a fixture card has no id or collector number to rename");
    grown.push(renamed);
  }
  return Buffer.from(`${grown.join("\n")}\n`);
}

/**
 * Check 16: a reload while the engine is inside a synchronous call opens the app.
 *
 * **What it stages.** A page that goes while its database Worker is inside a synchronous call
 * leaves that Worker holding the OPFS pool until the call returns, so the document that
 * replaces it asks for the database and is told it is open elsewhere. The page's answer is to
 * hold the database's Web Lock — which says whether another *page* is alive — and, holding it,
 * to stop the Worker and ask again on a short backoff. Before that, the reader was told the app
 * was open in another tab, and stayed told.
 *
 * **Why the card file is grown, and why the reload is timed off the engine.** A reload with the
 * download merely in flight passes on a build without the retry (measured by the fix's author):
 * a Worker awaiting bytes dies at once. The ingest's finish is the long synchronous call, and a
 * six-card file finishes inside one poll. So the file is {@link GROWN_CARDS} cards, and the
 * moment to reload is the first time a read of the engine goes unanswered for {@link BUSY_MS}.
 *
 * **It never passes on luck.** A reload that lands as the call returns opens at the first ask,
 * and a document that opened at the first ask proves nothing. The page's own console line is
 * the witness that the retry ran; without it the scenario is staged again on a new profile, up
 * to {@link RELOAD_ATTEMPTS} times, and a run that could not stage it at all fails saying so.
 */
async function reloadInsideTheIngest(origin, chunk) {
  const routes = fixtures(grownCards(GROWN_CARDS));
  const READ = `Promise.race([
    import(${JSON.stringify(chunk)})
      .then((module) => module.webCore.call("sync_status"))
      .then(() => true, () => true),
    new Promise((answered) => setTimeout(() => answered(false), ${BUSY_MS})),
  ])`;

  for (let attempt = 1; attempt <= RELOAD_ATTEMPTS; attempt += 1) {
    const { browser, hosts, policy, close } = await browse(origin, routes);
    const page = await openPage(browser, `${origin}/search`, hosts.check, policy);
    await page.until("the grown first run got past its startup gate", `${SHELL} || ${ALERT}`);
    const refusedOpen = await page.evaluate(ALERT);
    if (refusedOpen) fail(`the grown first run did not open its database:\n${refusedOpen}`);
    // A mark on the document: gone is the reload having replaced it.
    await page.evaluate("window.__smokeDocument = true");

    const from = performance.now();
    for (const stop = from + 60_000; await page.evaluate(READ); await pause(20)) {
      hosts.check();
      if (performance.now() > stop) {
        fail(
          `the engine answered every read within ${BUSY_MS} ms for a minute of a ` +
            `${GROWN_CARDS}-card first run — it was never inside a synchronous call`,
        );
      }
    }
    const busyAfter = Math.round(performance.now() - from);
    await page.reload();
    await page.until(
      "the document after a reload inside the ingest drew the app or said why not",
      `window.__smokeDocument === undefined && (${SHELL} || ${ALERT})`,
      30_000,
    );
    const told = await page.evaluate(ALERT);
    if (told) {
      fail(
        `a reload while the engine was inside a synchronous call (${busyAfter} ms into the ` +
          `first run) was told:\n${told}\nConsole: ${page.said().join(" | ") || "nothing"}`,
      );
    }
    // The line is written as the retried open succeeds, which is before the shell is drawn;
    // the console's events are a moment behind the page.
    let retried = null;
    for (const stop = performance.now() + 2_000; performance.now() < stop; await pause(50)) {
      retried = page.said().find((text) => text.includes(RETRIED)) ?? null;
      if (retried !== null) break;
    }
    const thrown = page.thrown();
    if (thrown.length > 0) fail(`the reloaded page threw:\n${thrown.join("\n")}`);
    hosts.check();
    const watched = policy.watched().filter((name) => name.startsWith("worker ")).length;
    if (watched === 0) fail("the grown first run's engine Worker was never listened to");
    await close();

    if (retried !== null) {
      console.log(
        `ok  a reload inside a synchronous engine call opened the app — the engine went quiet ` +
          `${busyAfter} ms into a ${GROWN_CARDS}-card first run, the next document drew its ` +
          `tab bar and no refusal, and said: ${/opened on attempt.*$/.exec(retried)?.[0] ?? retried}` +
          (attempt > 1 ? ` (staged ${attempt} times: the earlier reloads missed the call)` : ""),
      );
      return;
    }
    console.log(
      `--  staging ${attempt} of ${RELOAD_ATTEMPTS}: the reload ${busyAfter} ms into the first ` +
        "run missed the synchronous call — the next document opened its database at the first " +
        "ask, which proves nothing" +
        (attempt < RELOAD_ATTEMPTS ? "; staging it again on a new profile" : ""),
    );
  }
  fail(
    `a reload could not be landed inside a synchronous engine call in ${RELOAD_ATTEMPTS} first ` +
      "runs: every one opened at the first ask. That is this check failing to stage its " +
      "scenario, not the app refusing a reload — the card file may need to be larger for this " +
      "machine (GROWN_CARDS).",
  );
}

async function main() {
  const { origin, site } = await serve();
  const chunk = coreChunk();
  const { browser, hosts, policy, close } = await browse(origin, fixtures());
  // Held until the page has been seen saying it is a first run: answered at once, a six-card
  // file is ingested inside one poll of this script and the sentence is never on screen.
  const releaseCards = hosts.hold(CARDS_FILE);

  /** How many times the page has said its database opened — once per document that got one. */
  const OPENED = "database open in OPFS";
  const opens = (page) => page.said().filter((text) => text.includes(OPENED)).length;
  /** Wait for the document after this one to open its database and draw its shell. */
  const reopened = async (page, before, what) => {
    // By the console line and not by the tab bar: for a moment after a reload the document
    // still answering is the old one, whose bar is already drawn.
    for (const stop = performance.now() + 60_000; opens(page) <= before; await pause(100)) {
      hosts.check();
      if (performance.now() > stop) fail(`${what}: the page never opened its database again`);
    }
    await page.until(`${what}: the app came back`, `${SHELL} || ${ALERT}`);
    const refused = await page.evaluate(ALERT);
    if (refused) fail(`${what}: the database did not open again:\n${refused}`);
  };

  // A headless window is 800 wide — under the 1024 floor — so the face is the phone's, and its
  // tab bar is the thing to wait for.
  const first = await openPage(browser, `${origin}/search`, hosts.check, policy);
  /** One command through the page's `Core`; a refusal is the engine's sentence, and fails. */
  const engine = async (command, args) => {
    const answer = await first.evaluate(
      `import(${JSON.stringify(chunk)})
        .then((module) => module.webCore.call(${JSON.stringify(command)}, ${JSON.stringify(args)}))
        .then((value) => ({ value }), (refused) => ({ refused: String(refused) }))`,
    );
    if (answer.refused !== undefined) fail(`${command} was refused: ${answer.refused}`);
    return answer.value;
  };
  const errors = async (when) => {
    const log = await engine("error_log_list", { limit: 50 });
    if (log.length > 0) fail(`the error log ${when}:\n${JSON.stringify(log, null, 2)}`);
  };
  /** Type `text` into the Search page's box, from whichever page of the app is showing. */
  const search = async (text) => {
    await first.press(
      "the Search tab",
      `document.querySelector('nav[aria-label="Views"] a[href="/search"]')`,
    );
    await first.press("the search box", SEARCH_BOX);
    await first.type(text);
  };

  await first.until("the app got past its startup gate", `${SHELL} || ${ALERT}`);
  const refusedOpen = await first.evaluate(ALERT);
  if (refusedOpen) {
    fail(
      `the first tab did not open its database:\n${refusedOpen}\n` +
        `Console: ${first.said().join(" | ") || "nothing"}\n` +
        `Thrown: ${first.thrown().join(" | ") || "nothing"}`,
    );
  }
  // The page says which journal each file got (`src/lib/core/web/index.ts`). The OPFS pool
  // refuses WAL, so anything but `delete` on either is a browser doing something new.
  const line = first.said().find((text) => text.includes(OPENED));
  const opened = /journal (\w+), corpus journal (\w+), schema (\d+)/.exec(line ?? "");
  if (!opened) {
    fail(`the page never said how its database opened. Console:\n${first.said().join("\n")}`);
  }
  if (opened[1] !== "delete" || opened[2] !== "delete") fail(`an unexpected journal: ${line}`);
  console.log(`ok  the engine loaded and opened its database — ${opened[0]}`);

  const files = await first.until("the database is in OPFS", OPFS);
  if (files.length === 0) fail(`OPFS has a ${OPFS_DIRECTORY} folder with nothing in it`);
  console.log(`ok  OPFS holds ${OPFS_DIRECTORY}/ with ${files.length} entries`);

  // A first visit starts with no worker: it installs — the whole shell fetched before any of it
  // is kept — activates, and claims the page already open. Waited for here, before the first
  // card exists, so that the first picture the wall asks for is asked of the worker.
  await first.until(
    "the service worker took the page",
    `navigator.serviceWorker.controller?.state === "activated"`,
    60_000,
  );
  const worker = await first.evaluate(WORKER);
  if (worker.controller !== `${origin}/sw.js` || worker.scope !== `${origin}/`) {
    fail(`the service worker is not the app's own: ${JSON.stringify(worker)}`);
  }
  const shells = Object.keys(worker.shells);
  if (shells.length !== 1) fail(`one build, and ${shells.length} shell caches: ${shells}`);
  const build = shells[0].slice(SHELL_PREFIX.length);
  const missing = ["/", ...engineFiles()].filter((path) => !worker.shells[shells[0]].includes(path));
  if (missing.length > 0) fail(`${shells[0]} holds no ${missing.join(", ")}`);
  console.log(
    `ok  the service worker controls the page — ${shells[0]}, ` +
      `${worker.shells[shells[0]].length} files`,
  );

  // An empty corpus with a sync running over it: the Search page says so where its wall would
  // be, with the sync's phase in a live region beside it (`mobile/phone/search/NoCards.tsx`).
  // The card file is still held, so the phase is the download's.
  const phase = await first.until(
    "the page said it is a first run",
    `document.body.innerText.includes("Setting up your card database") &&
      [...document.querySelectorAll('[role="status"]')]
        .map((region) => region.innerText.trim())
        .find((text) => text !== "")`,
    30_000,
  );
  if (!hosts.asked.some((entry) => entry.url === CARDS_FILE)) {
    fail(
      "the page said it is setting up its card database, and the card file was never asked " +
        `for. Asked: ${hosts.since(0).join(", ") || "nothing"}`,
    );
  }
  console.log(`ok  an empty database reads as a first run — "${phase}"`);
  releaseCards();

  // Typed into the page's own box, and waited for on its own wall: the ingest, the swap, the
  // search index and a read back through the Worker, with nothing of this script's in between.
  // One card and not the wall of six, so the tile is the search's answer and not the page's
  // first paint; a second name the search must *not* draw says the box narrowed anything.
  await first.press("the search box", SEARCH_BOX);
  await first.type("Rhystic");
  await first.until(
    "a search for a fixture card drew its tile",
    `${tile("Rhystic Study")} && !${tile("Lightning Bolt")}`,
    30_000,
  );
  const cards = await engine("sync_status");
  if (cards.cardCount !== 6 || cards.lastError !== null) {
    fail(`the card sync left ${JSON.stringify(cards)}`);
  }
  console.log(`ok  the card sync ingested ${cards.cardCount} cards and a typed search drew one`);

  // The tile's picture, all the way round: the page asks its own origin, the worker asks the
  // page where the picture is, the page asks the engine, the worker fetches that address from
  // Scryfall and answers with a response built from the bytes — which is also what it keeps.
  const path = await first.until("the tile's picture decoded", pictureIn("Rhystic Study"), 30_000);
  const address = pictureAddress(path);
  if (address === null) fail(`the tile drew ${path}, which names no fixture picture`);
  const fetches = () => hosts.asked.filter((entry) => entry.url === address);
  const kept = await first.evaluate(pictures(path));
  if (kept.source !== address || kept.type !== "image/webp") {
    fail(`the picture cache holds ${path} as ${JSON.stringify(kept)}, not from ${address}`);
  }
  // Asked again, by address: the cache answers, and Scryfall is not asked a second time.
  const again = await first.evaluate(
    `fetch(${JSON.stringify(path)}).then(async (response) => ({
      status: response.status,
      source: response.headers.get("X-Grimoire-Source"),
      bytes: (await response.arrayBuffer()).byteLength,
    }))`,
  );
  if (again.status !== 200 || again.source !== address || fetches().length !== 1) {
    fail(
      `asked a second time, ${path} answered ${JSON.stringify(again)} after ` +
        `${fetches().length} requests to ${address}`,
    );
  }
  console.log(
    `ok  the picture decoded and is kept as ${path}; a second ask did not reach Scryfall — ` +
      `the worker's request carried ${Object.keys(fetches()[0].headers).join(", ")}`,
  );

  // The feeds a first run holds back until the cards are in, one after another. Nothing on the
  // phone face draws a tag or combo feed's state, so each is read from the engine: rows stored,
  // no refresh still in flight, and — the half a count cannot say — nothing in the error log.
  let feeds;
  for (const stop = performance.now() + 60_000; ; await pause(250)) {
    hosts.check();
    feeds = {
      oracle: await engine("oracle_tags_status"),
      art: await engine("art_tags_status"),
      combos: await engine("combos_status"),
    };
    const settled =
      feeds.oracle.tagCount === 4 && !feeds.oracle.refreshing &&
      feeds.art.tagCount === 4 && !feeds.art.refreshing &&
      feeds.combos.combos === 2;
    if (settled) break;
    if (performance.now() > stop) fail(`the feeds never finished: ${JSON.stringify(feeds)}`);
  }
  for (const url of [ORACLE_LISTING, ORACLE_FILE, ART_LISTING, ART_FILE, SPELLBOOK, SETS]) {
    if (!hosts.asked.some((entry) => entry.url === url)) fail(`${url} was never asked for`);
  }
  await errors("after the launch's feeds");
  console.log(
    `ok  the feeds finished — ${feeds.oracle.tagCount} oracle tags, ${feeds.art.tagCount} art ` +
      `tags, ${feeds.combos.combos} combos naming ${feeds.combos.cards} cards, no error logged`,
  );

  // The price lists, through Settings: a feed whose host permits no page is greyed with its
  // reason (`FeedStatus.reachable`), and one that does is downloaded when it is picked — which
  // is the only way a price list is ever asked for.
  await first.press("the Settings link", `document.querySelector('a[aria-label="Settings"]')`);
  await first.press(
    "Settings' Card data group",
    `document.querySelector('button[aria-label="Card data"]')`,
  );
  const manaPool = await first.until(
    "the marketplace picker drew Mana Pool",
    `(() => {
      const row = ${marketplaceRow("Mana Pool")};
      return row && { greyed: row.getAttribute("aria-disabled"), said: row.innerText };
    })()`,
  );
  if (manaPool.greyed !== "true") fail(`Mana Pool is offered in a browser: ${manaPool.said}`);
  await first.press("Card Kingdom's row", marketplaceRow("Card Kingdom"));
  let prices;
  for (const stop = performance.now() + 30_000; ; await pause(250)) {
    hosts.check();
    const status = await engine("marketplace_feed_status");
    prices = status.find((feed) => feed.marketplace === "cardkingdom");
    // Five priced rows of the fixture's six: the sealed box has no Scryfall id.
    if (prices?.rowCount === 5 && !prices.refreshing) break;
    if (performance.now() > stop) fail(`Card Kingdom never landed: ${JSON.stringify(status)}`);
  }
  if (!hosts.asked.some((entry) => entry.url === CARD_KINGDOM)) {
    fail("Card Kingdom's prices are stored, and its price list was never asked for");
  }
  // Mana Pool has no fixture, so a request to it has already failed this run by name
  // (`intercept`): a page it does not permit must never ask it.
  await first.until(
    "Card Kingdom is the chosen marketplace",
    `${marketplaceRow("Card Kingdom")}?.getAttribute("aria-pressed") === "true"`,
  );
  await errors("after Card Kingdom's price list");
  console.log(`ok  Settings greys Mana Pool and stored ${prices.rowCount} Card Kingdom prices`);

  // Offline, for real: the server drops every connection, every other host is gone, and the
  // HTTP cache — which the host's policy lets keep `assets/` and `wasm/` for a year — is
  // emptied first. What draws now is drawn from Cache Storage and OPFS, so a browser that wiped
  // either between the two documents is a blank page, a first-run screen or an empty frame.
  const mark = hosts.asked.length;
  await first.forget();
  site.refusing = true;
  hosts.offline(true);
  let documents = opens(first);
  await first.reload();
  await reopened(first, documents, "offline");
  await search("Rhystic");
  await first.until(
    "offline, a search answered",
    `${tile("Rhystic Study")} && !${tile("Lightning Bolt")}`,
    30_000,
  );
  const offline = await first.until("offline, the cached picture drew", pictureIn("Rhystic Study"), 30_000);
  if (offline !== path) fail(`offline the tile drew ${offline}, and the cache holds ${path}`);
  // A launch inside every feed's interval asks nobody anything — and by now it has had its
  // turn: `open` spawns the downloads before it answers, ahead of the Worker's first call.
  const quiet = hosts.since(mark);
  if (quiet.length > 0) fail(`offline, the reload asked for:\n${quiet.join("\n")}`);
  site.refusing = false;
  hosts.offline(false);
  // Past the interval, which is what tomorrow's launch is: the listing is asked, its
  // `updated_at` is the one stored, and the file it names is not downloaded again. No ETag
  // decides that in a browser — nobody exposes one — so this is the only test of the stamp.
  const forced = await engine("sync_run", { force: true });
  const checked = hosts.since(mark);
  if (forced.updated || checked.length !== 1 || checked[0] !== CARDS_LISTING) {
    fail(
      `a check that found nothing new answered ${JSON.stringify(forced)} and asked for:\n` +
        checked.join("\n"),
    );
  }
  console.log(
    `ok  offline, a reload drew the app, its ${forced.cardCount} cards and the cached picture, ` +
      "asking no host; online, a forced check asked the listing and no card file",
  );

  // Settings' Clear cache, which on this host is the picture cache and nothing of the app's own.
  await first.press("the Settings link", `document.querySelector('a[aria-label="Settings"]')`);
  await first.press(
    "Settings' Storage and data group",
    `document.querySelector('button[aria-label="Storage and data"]')`,
  );
  await first.press("Clear cache", buttonSaying("Clear cache"));
  await first.press("the confirmation's Clear cache", buttonSaying("Clear cache", '[role="dialog"]'));
  await first.until(
    "the picture cache was emptied",
    `(async () => (await ${pictures(path)}).keys.length === 0)()`,
    30_000,
  );
  const afterClear = await first.evaluate(WORKER);
  if (Object.keys(afterClear.shells).join() !== shells[0]) {
    fail(`Clear cache left these shell caches: ${Object.keys(afterClear.shells)}`);
  }
  console.log(`ok  Clear cache emptied ${PICTURE_CACHE} and left ${shells[0]}`);

  const second = await openPage(browser, `${origin}/search`, hosts.check, policy);
  const told = await second.until("a second tab was told", `${ALERT} || ${SHELL}`);
  if (told === true) fail("a second tab opened the database the first one holds");
  if (!/already open in another tab/.test(told)) fail(`a second tab said:\n${told}`);
  const offered = await second.evaluate(
    `[...document.querySelectorAll("a")].some((a) => a.innerText.trim() === "Reload")`,
  );
  if (!offered) fail("the second tab was told, and offered no Reload");
  console.log("ok  a second tab was told, and offered a reload");

  // A second deploy: the same files under a worker whose build id differs. The browser finds
  // it byte-different, installs it — a second shell cache — and keeps it waiting, because two
  // pages of the old build are open. Nothing but the reader's press may end that wait.
  const next = `${build}-next`;
  const source = readFileSync(join(DIST, "sw.js"), "utf8");
  if (source.split(build).length !== 2) {
    fail(`sw.js names its build id ${source.split(build).length - 1} times, not once`);
  }
  site.build = { from: build, to: next };
  // A mark on each document: gone from one is that tab having started again.
  await first.evaluate("window.__smokeDocument = true");
  await second.evaluate("window.__smokeDocument = true");
  await first.evaluate(
    "navigator.serviceWorker.getRegistration().then((registration) => registration.update()).then(() => true)",
  );
  await first.until("the new build is waiting and the bar is drawn", `${BAR}`, 60_000);
  const waiting = await first.evaluate(WORKER);
  const both = Object.keys(waiting.shells).sort().join();
  if (waiting.waiting !== "installed" || both !== [shells[0], `${SHELL_PREFIX}${next}`].join()) {
    fail(`a waiting build left ${JSON.stringify({ ...waiting, shells: both })}`);
  }
  if (await second.evaluate(BAR)) fail("the second tab draws the update bar");
  // A reload is not an update: the old worker answers it from the old shell, the new one goes
  // on waiting, and the bar is drawn again by the document that arrives.
  documents = opens(first);
  await first.reload();
  await reopened(first, documents, "under a waiting build");
  await first.until("the bar is drawn again after a reload", BAR, 30_000);
  const still = await first.evaluate(WORKER);
  if (still.waiting !== "installed" || Object.keys(still.shells).length !== 2) {
    fail(`a reload moved the waiting build: ${JSON.stringify(still)}`);
  }
  console.log(`ok  a new build waits — the bar is drawn, two shell caches, and a reload changes nothing`);

  // The press. The new worker takes over, deletes the old shell and claims both tabs; the tab
  // that pressed starts again, once, and the tab with no database stays as it was.
  documents = opens(first);
  await first.evaluate("window.__smokeDocument = true");
  await first.press("the bar's button", buttonSaying(BAR_BUTTON));
  await reopened(first, documents, "after the press");
  await first.until(
    "the new build's shell is the only one",
    `(async () => {
      const worker = await ${WORKER};
      return window.__smokeDocument === undefined && worker.waiting === null &&
        worker.active === "activated" &&
        Object.keys(worker.shells).join() === ${JSON.stringify(`${SHELL_PREFIX}${next}`)};
    })()`,
    30_000,
  );
  if (await first.evaluate(BAR)) fail("the update bar is still drawn after the update");
  if (opens(first) !== documents + 1) {
    fail(`the press started ${opens(first) - documents} documents, not one`);
  }
  const bystander = await second.evaluate(
    `({ stayed: window.__smokeDocument === true, bar: ${BAR}, says: ${ALERT} ?? "" })`,
  );
  if (!bystander.stayed || bystander.bar || !/already open in another tab/.test(bystander.says)) {
    fail(`the second tab did not sit the update out: ${JSON.stringify(bystander)}`);
  }
  console.log(
    `ok  the press handed over — one new document on ${SHELL_PREFIX}${next}, no bar, ` +
      "and the second tab was neither told nor reloaded",
  );

  // A deck note, opened and typed into. The editor is a chunk nothing above loads, and the
  // library under it (Tiptap) appends a style element to the page as it builds a view unless it
  // is told not to. This host's `style-src` refuses one — which is how the live site found it on
  // 2026-10-04, with every check above green: the policy can only refuse what a run asks for.
  // Last of this tab's checks because it writes, and a database with a deck in it is asked
  // different things at its next launch than the first run the checks above are about.
  await first.press(
    "the Decks tab",
    `document.querySelector('nav[aria-label="Views"] a[href="/decks"]')`,
  );
  await first.press("New deck", buttonSaying("New deck"));
  await first.press(
    "the new deck's name field",
    `document.querySelector('[role="dialog"] input[id$="-name"]')`,
  );
  await first.type("Smoke");
  await first.press("Create deck", buttonSaying("Create deck", '[role="dialog"]'));
  await first.press("the deck's New note", buttonSaying("New note"));
  await first.press("the note's writing surface", NOTE_SURFACE);
  await first.type("Cut a land.");
  const note = await first.until(
    "the note editor took typing",
    `(() => {
      const surface = ${NOTE_SURFACE};
      if (!surface?.innerText.includes("Cut a land.")) return null;
      return {
        whiteSpace: getComputedStyle(surface).whiteSpace,
        injected: [...document.querySelectorAll("style")].map(
          (sheet) => sheet.getAttributeNames().join(" ") || "(no attributes)",
        ),
      };
    })()`,
    30_000,
  );
  // Asked of the page as well as of the policy: a refused sheet is still an element, so this
  // names the library that put it there where the policy's issue names only a directive.
  if (note.injected.length > 0) {
    fail(`opening a note left style elements on the page: ${note.injected.join(", ")}`);
  }
  // The one rule ProseMirror cannot work without, which only a bundled sheet can supply here.
  if (!/^(pre-wrap|break-spaces)$/.test(note.whiteSpace)) {
    fail(`the note's writing surface computes white-space: ${note.whiteSpace}`);
  }
  // An issue is reported a moment after the act that raised it.
  await pause(500);
  hosts.check();
  console.log(
    `ok  a deck note opened and took typing — white-space ${note.whiteSpace}, ` +
      "and no style element was put on the page",
  );

  const thrown = [...first.thrown(), ...second.thrown()];
  if (thrown.length > 0) fail(`the page threw:\n${thrown.join("\n")}`);
  hosts.check();
  // One document per reload this script made and one for the press, and no other: a page that
  // reloaded itself — on being claimed, or twice on the handover — would have opened again.
  if (opens(first) !== 4) fail(`the first tab opened its database ${opens(first)} times, not 4`);
  console.log(
    `ok  ${hosts.asked.length} requests answered from fixtures, none needing a pre-flight, ` +
      "and none to a host without one",
  );
  // No refusal is only worth saying of targets that were listened to: a run that never
  // attached to the engine's Worker, or to a service worker, heard nothing because it asked
  // nobody.
  const watched = policy.watched();
  const count = (kind) => watched.filter((name) => name.startsWith(`${kind} `)).length;
  if (count("worker") === 0 || count("service_worker") === 0) {
    fail(`the policy was watched on ${watched.join(", ")} — no Worker, or no service worker`);
  }
  console.log(
    `ok  the host's Content-Security-Policy refused nothing — heard on ${count("the page")} ` +
      `pages, ${count("worker")} engine Workers and ${count("service_worker")} service workers`,
  );

  // The second phase is a first run of its own, on a profile of its own.
  await close();
  await reloadInsideTheIngest(origin, chunk);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`web-smoke: passed in ${seconds} s`);
}

// The one bound on the whole run. `until` polls against it too, but a protocol call that never
// answers — a navigation, an OPFS walk that never settles — polls nothing, so this is a timer
// and not a check. Unreferenced, so it never keeps a finished run alive.
setTimeout(async () => {
  console.error(`web-smoke: FAILED — still running after ${DEADLINE_MS / 1000} s`);
  await stopEverything();
  process.exit(1);
}, DEADLINE_MS).unref();

main()
  .catch((error) => {
    if (process.exitCode !== 1) {
      console.error(`web-smoke: FAILED — ${error.message}`);
      process.exitCode = 1;
    }
  })
  .finally(stopEverything);
