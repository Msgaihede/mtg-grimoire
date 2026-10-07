// What the web host's two browser runs are written in: the server that answers as the production
// host does, the browser and its DevTools socket, the interception that answers every other host
// from the fixtures beside this file, and the ears on the Content-Security-Policy.
//
//     scripts/web-smoke.mjs        a first run of the built app, on a device that pairs nothing
//     scripts/web-sync-smoke.mjs   two such devices, paired and syncing through a local relay
//
// **A module, and never a script.** It was the top half of `web-smoke.mjs` until 2026-10-04,
// behind a guard that asked "am I the script Node was started with?" by comparing two spellings
// of a path — which a symlink, a junction or a drive letter's case answers *no* to, and then the
// smoke ran nothing, printed nothing and exited 0. So nothing here runs on import and neither
// run asks that question: each ends in `await runAs(…)`, with no condition in front of it.
// (`web-smoke.mjs`'s header has what each fence is for, and what was measured to build them.)
//
// No dependencies, like `cdp.mjs`: Node has a global `WebSocket`, and Chromium prints its
// debugging address when it starts.

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
import { headersFor, parseHeaders } from "../../app-worker/src/headers.ts";
import { isNavigation } from "../../src/lib/core/web/assets.ts";

export const DIST = resolve("dist-web");
/** What the hosts answer with: this file's own folder, found whatever the working directory. */
export const FIXTURES = dirname(fileURLToPath(import.meta.url));
/**
 * Which run this is — the name a failure is said under — and how long the whole of it may take.
 * {@link runAs} sets both. CI's step has a longer bound of its own behind the second.
 */
const run = { name: "smoke", deadlineMs: 180_000 };
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

export const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * What to stop, newest first: the server, the browser, its socket, its profile. Each is pushed
 * the moment it exists — a browser that fails to start must not leave the server listening, and
 * a listening server is what keeps this process alive after it has printed its verdict.
 */
export const undo = [];
async function stopEverything() {
  while (undo.length > 0) await Promise.resolve(undo.pop()()).catch(() => undefined);
}

/**
 * The same, for the one moment nothing can be awaited in: the process's own `exit`. Every
 * *process* a run starts — a browser, the sync smoke's relay — puts a synchronous stop here as
 * well as its orderly one on {@link undo}, so that a run which ends by any road a handler can
 * see leaves none of them running. Each must be safe to call twice, and after the orderly one.
 *
 * What it cannot cover is a run that is itself killed outright (`taskkill /F`, `SIGKILL`): no
 * handler runs then, and what it started is left to whoever killed it.
 */
export const atExit = [];
function stopProcessesNow() {
  while (atExit.length > 0) {
    try {
      atExit.pop()();
    } catch {
      // A process that has already gone is one that has been stopped.
    }
  }
}

export function fail(message) {
  console.error(`${run.name}: FAILED — ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

/**
 * Remove a directory the run made for itself — a browser's profile, a relay's state — and
 * **never fail the run over it**. Nothing a run asserts is in there: by the time it is removed
 * the walk has passed or failed already.
 *
 * Windows lets go of a profile's files some time after the browser that held them has gone, and
 * `rm` then answers `EBUSY`, `EPERM` or `ENOTEMPTY`. Five tries were not always enough: a sync
 * smoke's run reported FAILED on `EBUSY … unlink …\first_party_sets.db-journal` in its teardown
 * (2026-10-05). So it is tried for longer — ten times, 200 ms apart and backing off — and a
 * directory that still will not go is named in one line and left: the operating system's temp
 * directory is where it is, and a run that is told about it has not failed.
 */
export async function discard(dir) {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    const why = error instanceof Error ? (error.code ?? error.message) : String(error);
    console.error(`${run.name}: left behind ${dir} — it could not be removed (${why})`);
  }
}

/**
 * The exit code for a run a signal ended: 128 + the signal's number, as a shell reports it.
 * Never 0 — a run that was interrupted has not passed.
 */
const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 };

/**
 * Stop what the run started on every road out that a handler can see, and leave by none of them
 * with a 0.
 *
 * - **A signal** — Ctrl-C above all, which is how a person ends a run that has stalled: the
 *   orderly stop, then the signal's own code. Without a handler Node dies at once, and the
 *   browsers and the relay it started go on running with their ports and their files held.
 * - **A throw nobody caught**, or a rejection nobody handled — a bug in a run, in a listener
 *   where `main`'s own `catch` cannot reach it: said, stopped, 1.
 * - **`exit` itself**, whatever led to it: the synchronous stops ({@link atExit}), which is what
 *   is left when the orderly ones were cut short or never started.
 */
function stopOnEveryWayOut() {
  let leaving = false;
  const leave = async (code, said) => {
    if (leaving) return;
    leaving = true;
    if (said) console.error(`${run.name}: FAILED — ${said}`);
    // Bounded: an orderly stop that hangs must not be what keeps an interrupted run alive.
    await Promise.race([stopEverything(), pause(10_000)]);
    process.exit(code);
  };
  for (const [signal, code] of Object.entries(SIGNALS)) {
    process.on(signal, () => void leave(code, `stopped by ${signal}`));
  }
  const said = (error) => (error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.on(
    "uncaughtException",
    (error) => void leave(1, `an uncaught exception: ${said(error)}`),
  );
  process.on(
    "unhandledRejection",
    (error) => void leave(1, `an unhandled rejection: ${said(error)}`),
  );
  process.on("exit", stopProcessesNow);
}

/**
 * Run `main` as the run called `name`, bounded by `deadlineMs`, and stop everything it started
 * however it ends ({@link stopOnEveryWayOut}).
 *
 * **The timer is the one bound on the whole run.** `until` polls against the deadline too, but a
 * protocol call that never answers — a navigation, an OPFS walk that never settles — polls
 * nothing, so this is a timer and not a check. Unreferenced, so it never keeps a finished run
 * alive.
 */
export function runAs(name, deadlineMs, main) {
  run.name = name;
  run.deadlineMs = deadlineMs;
  stopOnEveryWayOut();
  setTimeout(async () => {
    console.error(`${run.name}: FAILED — still running after ${run.deadlineMs / 1000} s`);
    await stopEverything();
    process.exit(1);
  }, run.deadlineMs).unref();
  return main()
    .then(() => {
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      console.log(`${run.name}: passed in ${seconds} s`);
    })
    .catch((error) => {
      if (process.exitCode !== 1) {
        console.error(`${run.name}: FAILED — ${error.message}`);
        process.exitCode = 1;
      }
    })
    .finally(stopEverything);
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
 * - **`site.asked` is every path this server was asked for**, in order, answered or refused
 *   (`site.refusing` drops the connection *after* the path is written down) — what
 *   the scanner's run reads to say that none of the scanner's files left the host before a
 *   reader pressed Download. A request a service worker answered from its cache never arrives.
 */
async function serve() {
  if (!existsSync(join(DIST, "index.html"))) {
    fail("dist-web/index.html is missing. Run `npm run web:wasm` and `npm run web:build` first.");
  }
  if (!existsSync(join(DIST, "_headers"))) {
    fail("dist-web/_headers is missing: the build did not emit the host's policy.");
  }
  const rules = parseHeaders(readFileSync(join(DIST, "_headers"), "utf8"));
  const site = { refusing: false, build: null, asked: [] };
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    // Written down before it is refused: what a page asked of a host that is gone is still
    // what it asked, and a run that says "nothing was asked offline" has to be able to be wrong.
    site.asked.push(path);
    if (site.refusing) return void request.socket.destroy();
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
 *  the way to stop it, and its process id — for a run that reads what its tab cost the machine.
 *  `extra` is a run's own switches, after this file's. */
async function launch(profile, extra = []) {
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
    ...extra,
  ];
  // A runner's kernel refuses the sandbox's namespaces to an unprivileged process, and the only
  // page this browser ever loads is the one this script serves.
  if (process.env.CI) args.push("--no-sandbox");
  const child = spawn(browserPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
  // Registered before anything can fail, so a browser that never listens is still stopped.
  const kill = () => child.kill();
  undo.push(kill);
  atExit.push(kill);
  let heard = "";
  return new Promise((found, lost) => {
    child.stderr.on("data", (chunk) => {
      heard += chunk;
      const hit = /DevTools listening on (ws:\/\/\S+)/.exec(heard);
      if (hit) found({ address: hit[1], kill, pid: child.pid });
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
 *
 * `through` is a run's own host that really answers — the sync smoke's local relay: a request
 * it says yes to is let through to wherever the browser's own rules send it, and is none of
 * this function's to write down or to hold to the no-pre-flight rule. This run has none.
 *
 * `gate` is awaited before such a request is let through — how a measurement keeps a device from
 * hearing the relay for a while and then lets it (`scripts/web-sync-pull.mjs`): the request
 * stays paused in the browser, unanswered, as one on a stalled link would. No other run hands
 * one in.
 */
async function intercept(
  browser,
  origin,
  userAgent,
  problems,
  routes,
  through = () => false,
  gate = () => undefined,
) {
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
    if (through(request.url)) {
      await gate(request);
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
 *
 * **And every socket, which no request interception sees.** A WebSocket's upgrade is not a
 * request the `Fetch` domain pauses, so a socket to a host with no fixture would otherwise fail
 * in silence against the resolver. `Network` reports one being *made*, from the target that made
 * it — the engine's Worker, where live sync's loop runs — so that domain is switched on for
 * every dedicated Worker, and a socket `socket(url)` does not say yes to is a problem. This run
 * allows none: its device is in no sync group, and a loop that dialled anyway is the bug.
 */
async function watchPolicy(browser, problems, socket = () => false) {
  /** Session → what it is, for the sentence. */
  const targets = new Map();
  /** Every socket any watched Worker made, allowed or not: `{ url, sessionId, requestId }`. */
  const sockets = [];
  const watch = async (sessionId, name, type) => {
    targets.set(sessionId, name);
    await browser.send("Audits.enable", {}, sessionId);
    if (type === "worker") await browser.send("Network.enable", {}, sessionId);
  };

  browser.on("Network.webSocketCreated", ({ url, requestId }, sessionId) => {
    sockets.push({ url, sessionId, requestId });
    if (!socket(url)) {
      problems.push(`${targets.get(sessionId) ?? "a target"} opened a socket to ${url}`);
    }
  });
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
    await watch(sessionId, `${targetInfo.type} ${targetInfo.url}`, targetInfo.type).catch(
      () => undefined,
    );
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
    /** Every socket a watched Worker made. */
    sockets,
    /** The sessions of the dedicated Workers listened to, oldest first. */
    workers: () => [...targets].filter(([, name]) => name.startsWith("worker ")).map(([id]) => id),
    /** The same, each with the address of its script: `[sessionId, url]`. */
    workerScripts: () =>
      [...targets]
        .filter(([, name]) => name.startsWith("worker "))
        .map(([id, name]) => [id, name.slice("worker ".length)]),
  };
}

/** A tab on `url`, with what it threw kept. `problems` is checked on every wait, and `policy`
 *  is told of the tab before it loads anything. `prepare` is a run's own word to the tab before
 *  it loads — the sync smoke's viewport, which decides the face the app mounts. */
async function openPage(browser, url, problems, policy, prepare) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);
  // A tab that is not the browser's front one still takes typed text as a focused page does.
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  await prepare?.(sessionId);
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
      if (performance.now() > stop || performance.now() - started > run.deadlineMs) {
        const shown = await evaluate("document.body.innerText").catch(() => "(no document)");
        return fail(`${what} — never happened. The page shows:\n${shown}`);
      }
      await pause(250);
    }
  };
  const thrown = () =>
    browser.heard
      .filter((m) => m.sessionId === sessionId && m.method === "Runtime.exceptionThrown")
      .map(
        (m) => m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text,
      );
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
  return { evaluate, until, thrown, said, reload, forget, press, type, sessionId };
}

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

/**
 * A browser on a profile of its own — so a first run — with every request it makes answered
 * from `routes` and the host's policy listened to on every target. `close` stops it and removes
 * the profile; it is on the undo list too, so a run that fails anywhere leaves neither behind.
 *
 * `own` is what a run adds for itself: `args`, more switches for the browser; `through`, a host
 * that really answers, and `gate`, what a request to it waits on ({@link intercept}); `socket`,
 * the sockets it expects ({@link watchPolicy}). `pid` is the browser's own process.
 */
async function browse(origin, routes, own = {}) {
  const profile = await mkdtemp(join(tmpdir(), "grimoire-web-smoke-"));
  let socket = null;
  let stop = () => undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    socket?.close();
    stop();
    // The browser lets go of its profile a moment after it is told to stop — and sometimes a
    // good deal later, which must not turn a walk that passed into one that failed.
    await pause(500);
    await discard(profile);
  };
  undo.push(close);
  const { address, kill, pid } = await launch(profile, own.args);
  stop = kill;
  const browser = (socket = await connect(address));

  // Asked of a blank tab before anything is intercepted: what every request's `User-Agent` must
  // still be when it leaves. The page's own, not `Browser.getVersion`'s, which is unreduced.
  const blank = await openPage(browser, "about:blank", () => undefined);
  const userAgent = await blank.evaluate("navigator.userAgent");
  /** Everything that fails the run without throwing where it happened. */
  const problems = [];
  const hosts = await intercept(
    browser,
    origin,
    userAgent,
    problems,
    routes,
    own.through,
    own.gate,
  );
  const policy = await watchPolicy(browser, problems, own.socket);
  return { browser, hosts, policy, close, problems, pid };
}

// ---------------------------------------------------------------------------------------------
// Two things both runs ask a page, in the same words
// ---------------------------------------------------------------------------------------------

/** What the startup gate draws when it failed. */
const ALERT = `document.querySelector('[role="alert"]')?.innerText`;
/** A button by the words on it, inside `within` (a selector) when one is given. */
const buttonSaying = (words, within = "") =>
  `[...document.querySelectorAll(${JSON.stringify(`${within} button`.trim())})].find(
    (button) => button.innerText.trim() === ${JSON.stringify(words)},
  )`;

// ---------------------------------------------------------------------------------------------
// A card file of many printings
// ---------------------------------------------------------------------------------------------

/** The id of the grown card file's line `index`, past the committed six — the one rule
 *  {@link grownCards} writes ids by, so a run that names those cards cannot spell another. */
const grownCardId = (index) => `aaaaaaaa-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

/**
 * The card file, grown: the six fixture lines over and over, each copy under an `id` and a
 * collector number of its own, so every line is another printing to the engine. Made when it is
 * asked for and never committed — it is tens of megabytes of text, and a megabyte or so gzipped.
 *
 * Two runs ask: `web-smoke.mjs`'s reload check, which needs an ingest long enough to land a
 * reload inside, and `web-sync-pull.mjs`, which needs a collection of that many rows to import.
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
      .replace(/"id":"[0-9a-f-]{36}"/, `"id":"${grownCardId(index)}"`)
      .replace(/"collector_number":"[^"]*"/, `"collector_number":"G${index}"`);
    if (renamed === line) fail("a fixture card has no id or collector number to rename");
    grown.push(renamed);
  }
  return Buffer.from(`${grown.join("\n")}\n`);
}

export { serve, browse, openPage, fixtures, fixtureCards, pictureAddress, coreChunk };
// The browser alone, for a run that serves a page of its own and intercepts nothing — the card
// scanner's frame bench (`scripts/scanner-bench.mjs`).
export { launch, connect };
export { grownCards, grownCardId };
export { ALERT, buttonSaying };
// The fixture hosts' addresses, for a run that holds one, waits for one or counts the asks.
export { CARDS_LISTING, CARDS_FILE, ORACLE_LISTING, ORACLE_FILE, ART_LISTING, ART_FILE };
export { SETS, CARD_KINGDOM, SPELLBOOK, SHELL_PREFIX, PICTURE_CACHE };
