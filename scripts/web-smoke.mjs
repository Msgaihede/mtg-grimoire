#!/usr/bin/env node
// The web host's smoke run: the built app, in a real browser, over the real engine — a first run.
//
//     npm run web:wasm && npm run web:build && npm run web:smoke
//
// A green suite proves the host it ran on, and no suite runs the WASM module: vitest drives the
// Worker's logic over a fake, and cargo compiles the engine for a browser without starting one.
// This is the run that instantiates it. It serves `dist-web/`, opens it in headless Chromium over
// the DevTools protocol, and asks nine things, in this order:
//
//   1. the app got past its startup gate — the engine loaded, and opened and migrated a database
//      on a rollback journal, which the page says on its console
//   2. that database is in OPFS, in the folder the page names
//   3. an empty card database reads as a first run: the page says it is setting one up, with the
//      sync's phase beside it, while the card file is still on its way
//   4. the card sync finishes, and a search typed into the page's own box draws that card's tile
//   5. the launch's three feeds — both Tagger files and the combos — finish with rows stored and
//      nothing in the error log
//   6. Settings offers the price lists this host can reach: Mana Pool greyed, and Card Kingdom
//      downloaded and stored when it is picked
//   7. a reload opens the database again, still holding the cards, and asks no host for anything;
//      a check forced past its interval asks for the card listing and for no card file
//   8. a second tab is told the app is open elsewhere, and offered a reload
//   9. no request the engine made would cost a CORS pre-flight, and none went to a host this
//      script has no answer for
//
// **No request leaves the machine.** Since step 5.2 the engine starts the launch's downloads the
// moment the database opens, so every cross-origin request is paused by the DevTools `Fetch`
// domain and answered from `scripts/web-smoke/` with the headers the real host sends. Two fences
// stand behind that: a request to a host with no fixture is failed *and fails the run* (one
// host is excused by name, with the step that owes it — `UNREACHABLE`), and the browser is
// started with a resolver that knows no name but `localhost`, so a request the interception
// never saw cannot be answered by anyone.
//
// **Where a Worker's `fetch` can be caught** (measured, Chrome 154, 2026-10-04): the requests
// are the dedicated Worker's, and the Worker's own DevTools session has no `Fetch` domain —
// `Fetch.enable` there answers "wasn't found"; it only *reports* them, through `Network`. They
// are paused on the page's session and on the browser's. This uses the browser's: one enable,
// before any tab exists, for every tab this script opens.
//
// **Four things here go through the engine and not the page's own controls**, by importing the
// chunk the page already loaded (`assets/web-*.js`, whose `webCore` is the page's one `Core`):
// the feeds' status reads, the error log, the card count, and the forced check of step 7. The
// phone face draws no status for a tag or combo feed and has no Refresh for the cards.
//
// No dependencies, like `cdp.mjs`: Node has a global `WebSocket`, and Chromium prints its
// debugging address when it starts. The browser is `CHROME` when that is set (CI sets it),
// else the first of Chrome and Edge found where they install.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { gzipSync } from "node:zlib";

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

/**
 * A host the page asks that no browser can reach, and why that is not this run's failure. Its
 * requests are refused as a browser's would be — a connection nobody accepts — and counted.
 * **An entry here is a debt with an owner**: when the step it names lands, the entry goes and a
 * request to that host fails the run like any other with no fixture.
 */
const UNREACHABLE = new Map([
  // `src/lib/images.ts` still names the desktop's image protocol. Card pictures in a browser are
  // the service worker's (step 5.3); until then every tile asks this and draws its retry.
  ["mtgimg.localhost", "card pictures, until step 5.3 serves them from Cache Storage"],
]);

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
 */
function fixtures() {
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
  const cards = gzipSync(read("default-cards.jsonl"));
  const oracle = gzipSync(read("oracle-tags.jsonl"));
  const art = gzipSync(read("art-tags.jsonl"));

  return new Map([
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

/** `dist-web/` on a port of the system's choosing, with the history fallback a host gives it. */
async function serve() {
  if (!existsSync(join(DIST, "index.html"))) {
    fail("dist-web/index.html is missing. Run `npm run web:wasm` and `npm run web:build` first.");
  }
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = normalize(join(DIST, path));
    // A path that climbs out of the folder is nobody's request.
    const inside = file === DIST || file.startsWith(DIST + sep);
    // An address with no extension is a place in the app, and every place is the one document.
    const target = !inside ? null : extname(file) === "" ? join(DIST, "index.html") : file;
    try {
      if (target === null) throw new Error("outside");
      const body = await readFile(target);
      response.writeHead(200, {
        "Content-Type": TYPES[extname(target)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  undo.push(() => {
    server.close();
    // `close` waits for kept-alive sockets, which a killed browser may never hang up.
    server.closeAllConnections();
  });
  return `http://localhost:${server.address().port}`;
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

/** Start the browser and answer its DevTools address, which it prints once it is listening. */
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
  undo.push(() => child.kill());
  let heard = "";
  return new Promise((found, lost) => {
    child.stderr.on("data", (chunk) => {
      heard += chunk;
      const hit = /DevTools listening on (ws:\/\/\S+)/.exec(heard);
      if (hit) found(hit[1]);
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
  /** An event that has to be *answered* — a paused request — as well as kept. */
  const handlers = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) {
      const handler = handlers.get(message.method);
      if (handler) return void handler(message.params);
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
 * Pause every `http(s)` request the browser makes, in any tab and from any Worker, and answer
 * it: the app's own origin goes through to the server, a fixture URL is fulfilled, and the rest
 * is failed. Answers what was asked, so a check can read the log.
 *
 * **A request with no fixture, and one that would cost a pre-flight, are written down rather
 * than thrown**: this runs in the socket's listener, where a throw reaches nobody. `problems`
 * is read by every wait and once more at the end.
 */
async function intercept(browser, origin, userAgent) {
  const routes = fixtures();
  /** Each cross-origin request answered from a fixture, in order: `{ method, url, headers }`. */
  const asked = [];
  /** How many requests went to each {@link UNREACHABLE} host. */
  const refused = new Map();
  const problems = [];
  /** URLs whose answer waits on a caller: `url -> promise`. */
  const held = new Map();

  browser.on("Fetch.requestPaused", async ({ requestId, request }) => {
    const answer = (method, params) =>
      // A tab that closed, or a browser on its way down, has no request left to answer.
      browser.send(method, { requestId, ...params }).catch(() => undefined);
    if (request.url === origin || request.url.startsWith(`${origin}/`)) {
      return answer("Fetch.continueRequest");
    }
    const { hostname } = new URL(request.url);
    if (UNREACHABLE.has(hostname)) {
      refused.set(hostname, (refused.get(hostname) ?? 0) + 1);
      return answer("Fetch.failRequest", { errorReason: "ConnectionRefused" });
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
    refused,
    /** Fail the run on anything written down so far. */
    check() {
      if (problems.length > 0) fail(problems.join("\n"));
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

/** A tab on `url`, with what it threw kept. `problems` is checked on every wait. */
async function openPage(browser, url, problems) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);
  // A tab that is not the browser's front one still takes typed text as a focused page does.
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
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
  return { evaluate, until, thrown, said, reload, press, type };
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
/** Whether the wall draws a card's tile, by the card's name — a tile's button is named for its
 *  printing (`Lightning Bolt, LEA 161`). A boolean: an element does not cross the protocol. */
const tile = (name) =>
  `!!document.querySelector('[aria-label="Search results"] button[aria-label^=${JSON.stringify(`${name},`)}]')`;
/** A row of Settings' marketplace picker, by the name it is drawn under. */
const marketplaceRow = (label) =>
  `[...document.querySelectorAll("button[aria-pressed]")].find(
    (row) => row.querySelector("span[id$='-name']")?.textContent === ${JSON.stringify(label)},
  )`;

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

async function main() {
  const origin = await serve();
  const chunk = coreChunk();
  const profile = await mkdtemp(join(tmpdir(), "grimoire-web-smoke-"));
  undo.push(async () => {
    // The browser lets go of its profile a moment after it is told to stop.
    await pause(500);
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  });
  const browser = await connect(await launch(profile));
  undo.push(() => browser.close());

  // Asked of a blank tab before anything is intercepted: what every request's `User-Agent` must
  // still be when it leaves. The page's own, not `Browser.getVersion`'s, which is unreduced.
  const blank = await openPage(browser, "about:blank", () => undefined);
  const userAgent = await blank.evaluate("navigator.userAgent");
  const hosts = await intercept(browser, origin, userAgent);
  // Held until the page has been seen saying it is a first run: answered at once, a six-card
  // file is ingested inside one poll of this script and the sentence is never on screen.
  const releaseCards = hosts.hold(CARDS_FILE);

  /** How many times the page has said its database opened. */
  const OPENED = "database open in OPFS";
  const opens = (page) => page.said().filter((text) => text.includes(OPENED)).length;

  // A headless window is 800 wide — under the 1024 floor — so the face is the phone's, and its
  // tab bar is the thing to wait for.
  const first = await openPage(browser, `${origin}/search`, hosts.check);
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

  await first.until("the app got past its startup gate", `${SHELL} || ${ALERT}`);
  const refusedOpen = await first.evaluate(ALERT);
  if (refusedOpen) fail(`the first tab did not open its database:\n${refusedOpen}`);
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
  const errors = async (when) => {
    const log = await engine("error_log_list", { limit: 50 });
    if (log.length > 0) fail(`the error log ${when}:\n${JSON.stringify(log, null, 2)}`);
  };
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

  // Waited for by the console line and not by the tab bar: for a moment after `Page.reload` the
  // document still answering is the old one, whose bar is already drawn.
  const before = opens(first);
  const mark = hosts.asked.length;
  await first.reload();
  for (const stop = performance.now() + 60_000; opens(first) <= before; await pause(250)) {
    if (performance.now() > stop) fail("the page never opened its database after a reload");
  }
  await first.until("the app came back after a reload", `${SHELL} || ${ALERT}`);
  const again = await first.evaluate(ALERT);
  if (again) fail(`the database did not open a second time:\n${again}`);
  // The cards, through the page again: a browser that wiped OPFS between the two opens is a
  // first-run screen here, and no tile.
  await first.press(
    "the Search tab",
    `document.querySelector('nav[aria-label="Views"] a[href="/search"]')`,
  );
  await first.press("the search box", SEARCH_BOX);
  await first.type("Lightning");
  await first.until("the cards are still there after a reload", tile("Lightning Bolt"), 30_000);
  // A launch inside every feed's interval asks nobody anything — and by now it has had its
  // turn: `open` spawns the downloads before it answers, ahead of the Worker's first call.
  const quiet = hosts.since(mark);
  if (quiet.length > 0) fail(`a reload asked for:\n${quiet.join("\n")}`);
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
    `ok  a reload kept ${forced.cardCount} cards and asked no host; a forced check asked the ` +
      "listing and no card file",
  );

  const second = await openPage(browser, `${origin}/search`, hosts.check);
  const told = await second.until("a second tab was told", `${ALERT} || ${SHELL}`);
  if (told === true) fail("a second tab opened the database the first one holds");
  if (!/already open in another tab/.test(told)) fail(`a second tab said:\n${told}`);
  const offered = await second.evaluate(
    `[...document.querySelectorAll("a")].some((a) => a.innerText.trim() === "Reload")`,
  );
  if (!offered) fail("the second tab was told, and offered no Reload");
  console.log("ok  a second tab was told, and offered a reload");

  const thrown = [...first.thrown(), ...second.thrown()];
  if (thrown.length > 0) fail(`the page threw:\n${thrown.join("\n")}`);
  hosts.check();
  const unreachable = [...hosts.refused].map(
    ([host, count]) => `${count} to ${host} (${UNREACHABLE.get(host)})`,
  );
  console.log(
    `ok  ${hosts.asked.length} requests answered from fixtures, none needing a pre-flight` +
      (unreachable.length > 0 ? `; refused as a browser would: ${unreachable.join(", ")}` : ""),
  );

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
