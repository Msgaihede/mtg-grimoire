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
// headless Chromium over the DevTools protocol, and asks eighteen things, in this order — the
// first seventeen of one browser, and the last of a second, because it needs a first run of its
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
//  12. the privacy policy opens as itself — `/privacy`, in a tab the service worker controls,
//      is the document with its one heading and not the app, and loaded under the host's
//      policy with nothing refused;
//  13. a new build of the worker installs and *waits*: the page draws its bar, a second shell
//      cache stands beside the first, and a reload leaves all of that as it is
//  14. the bar's button, and nothing else, hands over: the page starts again once, on the new
//      build's shell alone, with no bar — and the second tab is neither told nor reloaded
//  15. a deck is made and a note opened in it: the editor — the app's one lazily loaded chunk,
//      over a library that appends a stylesheet of its own unless told not to — draws, takes
//      typing, and leaves no style element on the page
//  16. no request would cost a CORS pre-flight — the worker's picture fetch included — and none
//      went to a host this script has no answer for; **and the sync relay heard nothing**: live
//      sync's loop runs in this engine since step 6.3, this device is in no sync group, and it
//      made no request to the relay and opened no socket to anybody (`watchPolicy` has how a
//      socket, which no interception sees, is heard)
//  17. the host's Content-Security-Policy refused nothing, anywhere: not in a page, not in the
//      engine's Worker, not in the service worker (`watchPolicy` has why those are three)
//  18. on a fresh profile whose card file is thirty thousand cards, a reload made the moment
//      the engine stops answering — it is inside a synchronous call, and the Worker the page
//      leaves behind still holds the database — draws the app and no refusal, and the page says
//      it had to ask again (`reloadInsideTheIngest` has why that line is the check, and what
//      happens when the reload misses). Under the same policy, with the same two fences.
//
// **No request leaves the machine.** The engine starts the launch's downloads the moment the
// database opens, and the service worker fetches a picture for every tile, so every
// cross-origin request is paused by the DevTools `Fetch` domain and answered from
// `scripts/web-smoke/` with the headers the real host sends — the eighteenth check's card file
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
//
// **The server, the browser and the two fences are `scripts/web-smoke/harness.mjs`**, which
// `scripts/web-sync-smoke.mjs` is written in too. This file is the run alone, and it ends by
// running — unconditionally: a smoke that could decide it was not the script and exit 0 in
// silence is one that passes having checked nothing.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALERT,
  ART_FILE,
  ART_LISTING,
  CARD_KINGDOM,
  CARDS_FILE,
  CARDS_LISTING,
  DIST,
  ORACLE_FILE,
  ORACLE_LISTING,
  PICTURE_CACHE,
  SETS,
  SHELL_PREFIX,
  SPELLBOOK,
  browse,
  buttonSaying,
  coreChunk,
  fail,
  fixtures,
  grownCards,
  openPage,
  pause,
  pictureAddress,
  runAs,
  serve,
} from "./web-smoke/harness.mjs";

/** The folder `src/lib/core/web/index.ts` asks the engine to keep its databases in. */
const OPFS_DIRECTORY = "mtg-grimoire";
/** How long the whole run may take. CI's step has a longer bound of its own behind this one. */
const DEADLINE_MS = 180_000;

// ---------------------------------------------------------------------------------------------
// What the page is asked
// ---------------------------------------------------------------------------------------------

/** The phone face's tab bar: drawn only once the startup gate has let the app through. */
const SHELL = `!!document.querySelector('nav[aria-label="Views"]')`;
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

/** The three files a shell cache must hold beside the document for the engine to start offline. */
function engineFiles() {
  const chunk = readdirSync(join(DIST, "assets")).find((file) => /^worker-[\w-]+\.js$/.test(file));
  // The engine's folder and not the first: the card scanner's module has a folder of its own
  // beside it (`/wasm/<its own build>/scanner/`), which no shell cache holds.
  const build = readdirSync(join(DIST, "wasm")).find((id) =>
    existsSync(join(DIST, "wasm", id, "grimoire_web.js")),
  );
  if (!chunk || !build) fail("dist-web has no database Worker chunk, or no engine folder.");
  return [
    `/assets/${chunk}`,
    `/wasm/${build}/grimoire_web.js`,
    `/wasm/${build}/grimoire_web_bg.wasm`,
  ];
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
  const missing = ["/", ...engineFiles()].filter(
    (path) => !worker.shells[shells[0]].includes(path),
  );
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
      feeds.oracle.tagCount === 4 &&
      !feeds.oracle.refreshing &&
      feeds.art.tagCount === 4 &&
      !feeds.art.refreshing &&
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
  const offline = await first.until(
    "offline, the cached picture drew",
    pictureIn("Rhystic Study"),
    30_000,
  );
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
  await first.press(
    "the confirmation's Clear cache",
    buttonSaying("Clear cache", '[role="dialog"]'),
  );
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

  // The privacy policy, at the address the store listing and Settings link to. This tab is one
  // the worker controls, which is the reader it has to work for: the worker answers every
  // other extensionless navigation with the app.
  const privacy = await openPage(browser, `${origin}/privacy`, hosts.check, policy);
  const heading = await privacy.until(
    "the privacy policy drew",
    `document.querySelector("h1")?.innerText ?? null`,
  );
  if (heading !== "MTG Grimoire privacy policy") fail(`/privacy drew the heading:\n${heading}`);
  const shape = await privacy.evaluate(
    `({
      app: !!document.querySelector("#root"),
      scripts: document.scripts.length,
      sheet: [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/privacy.css")),
      ground: getComputedStyle(document.documentElement).backgroundColor,
    })`,
  );
  if (shape.app || shape.scripts !== 0) fail(`/privacy is not a plain document: ${JSON.stringify(shape)}`);
  if (!shape.sheet || shape.ground !== "rgb(12, 13, 18)") {
    fail(`/privacy drew without its stylesheet: ${JSON.stringify(shape)}`);
  }
  console.log("ok  /privacy is the policy — one heading, its own sheet, no script, not the app");

  // A second deploy: the same files under a worker whose build id differs. The browser finds
  // it byte-different, installs it — a second shell cache — and keeps it waiting, because three
  // pages of the old build are open (the privacy tab above is the third). Nothing but the reader's press may end that wait.
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
  console.log(
    `ok  a new build waits — the bar is drawn, two shell caches, and a reload changes nothing`,
  );

  // The press. The new worker takes over, deletes the old shell and claims all three; the tab
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
  // Live sync's loop has been running in this engine's Worker since the database opened, and
  // this device is in no sync group, so it must have dialled nobody. A request to the relay has
  // no fixture and would have failed the run by name above; a socket is no request, so it is
  // asked of the Worker's own `Network` domain (`watchPolicy`); and the loop's own word for
  // where it stands is `off`. Four documents have each run the loop by here, the last for
  // seconds, so its five-second read of `sync_group` has come round more than once.
  const live = await engine("sync_live_state");
  if (live !== "off" || policy.sockets.length > 0) {
    fail(
      `in no sync group, live sync reads ${JSON.stringify(live)} and opened ` +
        `${policy.sockets.length} sockets: ${policy.sockets.map((made) => made.url).join(", ")}`,
    );
  }
  console.log("ok  in no sync group, live sync reads off — no request to the relay, and no socket");
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
}

await runAs("web-smoke", DEADLINE_MS, main);
