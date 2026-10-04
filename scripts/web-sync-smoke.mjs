#!/usr/bin/env node
// Live sync between two browsers, through the relay's own code: the light app's phase 6, end to
// end.
//
//     npm run web:wasm && npm run web:build && npm run web:sync-smoke
//     npm run web:sync-smoke -- --measure      the same, and what the loop costs an idle page
//
// `web-smoke.mjs` proves the web host on a device that has paired nothing. This is the run in
// which it pairs: two headless Chromiums on two profiles — two devices — each serving the built
// app under the production policy, and between them **the relay itself under workerd**
// (`wrangler dev --local` on `relay/wrangler.jsonc`: its `fetch`, its Durable Object, a local D1).
// It walks, in this order:
//
//   1. both devices get past their startup gate — the first on the six fixture cards, the second
//      with its card file still on its way, held — and each reads `off`
//   2. the first device claims a membership through the page's own claim-code field — the engine,
//      `/claim`, `/token` and the bearer gate all for real — and its socket comes up: `live`
//   3. **a device that leaves lets go of its socket**: the second device claims a membership of
//      its own, founds a group of one and goes `live`; it presses *Leave group*, and reads `off`
//      at once, never `offline`, its socket closed and nothing logged
//   4. the first device offers a pairing; the second types the code; both show the same six
//      digits; the first confirms; both read a group of two, both are `live` — **and the second
//      device's socket is the first one's group's**, where a loop that kept the socket it had
//      would still be listening to the group it left
//   5. **a paired device relaunches into its first ingest**: the second device's card file is
//      let go and its page reloaded, so the launch's card sync — thirty thousand cards — and the
//      loop's launch trip and socket share the engine's one connection; it reaches `live`,
//      finishes the ingest, and draws a wish the first device made meanwhile
//   6. **the doorbell**: the second device adds a card to its wishlist, and the first one's
//      wishlist page draws it with nothing pressed there — the write, the 3 s debounce, the
//      push, the relay's `head` frame, the trip it rings for, `sync:applied`, the refetch — and
//      the same the other way round, so each face has been both the writer and the one told
//   7. no request failed and nothing was logged; each socket's upgrade selected
//      `grimoire.live.v1`, and each `ping` it sent was answered `pong`
//   8. **a removed device is told**: the first device removes the second from the roster, the
//      relay closes the second's socket, and the second reads as in no group with nothing
//      pressed there — `offline`, the trip a reconnect starts with, and then `off`
//   9. the host's Content-Security-Policy refused nothing, on any target of either browser
//
// **What is not waited for**: the keepalive's period. A socket pings the moment it comes up and
// then every 45 s, and the walk is over in less; `--measure` sits idle long enough to see the
// second ping and says how far apart the two were.
//
// **The first device is the desktop face and the second the phone face** (1280 × 800 and
// 412 × 915), so both faces' Sync panels, both walls and both faces' `sync:applied` listeners are
// what is driven.
//
// **The page talks to the relay by its real name.** The engine's `RELAY_BASE` is compiled in and
// the policy's `connect-src` names that host, and both are what ships — so neither is varied
// for the test. Instead each browser is started resolving that one name to the local relay
// (`--host-resolver-rules=MAP <relay> 127.0.0.1:<port>, …`), the relay is served over TLS with
// wrangler's own self-signed certificate (`--local-protocol https`) because the engine dials
// `https://` and `wss://`, and the browser is told to accept it (`--ignore-certificate-errors`).
// Measured 2026-10-04, Chrome 154: `--host-rules` beside the smoke's catch-all resolver rule
// answers `ERR_NAME_NOT_RESOLVED`; one `--host-resolver-rules` with the relay's mapping first
// is what works, and keeps the fence — every other name still resolves to nothing.
//
// **One honest difference from production**: the relay's `APP_ORIGINS` is this run's own page
// origin (`http://localhost:<port>`) where the deployed one says `https://mtg-grimoire.app`.
// Its signing key is thirty-two random bytes drawn by each run and handed over with `--var`:
// `RELAY_HMAC_KEY` has no value in any file of this repository, this one included.
//
// **An entitlement without Patreon**: the local D1 is given the relay's schema and two rows — a
// membership and a claim code for it — before the relay starts. Everything after that is the
// code path a reader's own claim takes.
//
// **wrangler is not one of this repository's root dependencies.** It is looked for at
// `app-worker/node_modules/wrangler/` — where `npm ci --ignore-scripts --prefix app-worker` puts
// the one version that directory's lockfile pins, which is what CI does — and then at the path
// in `WRANGLER`, a `wrangler.js`. The only wrangler commands this runs are `d1 execute --local`
// and `dev --local`: nothing here reaches Cloudflare.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALERT,
  CARDS_FILE,
  atExit,
  browse,
  buttonSaying,
  coreChunk,
  fail,
  fixtures,
  grownCards,
  openPage,
  pause,
  runAs,
  serve,
  undo,
} from "./web-smoke/harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Also profile the engine's Worker for a minute, idle, unpaired and then paired. */
const MEASURE = process.argv.includes("--measure");
/** How long the whole walk may take; the idle minutes are on top when they are asked for. */
const DEADLINE_MS = MEASURE ? 420_000 : 240_000;
/** How long one idle profile runs. */
const IDLE_MS = 60_000;

/** The claim code the local D1 is seeded with, as a reader would type it. */
const CLAIM_CODE = "TEST-CARD-SYNC";
/** A second membership's, for the group the second device founds for itself and then leaves. */
const OWN_CLAIM_CODE = "SECD-CARD-SYNC";
/** How many cards the second device's card file holds: an ingest long enough for its launch's
 *  round trip and its socket to land inside (`web-smoke.mjs` has the same figure's measure). */
const GROWN_CARDS = 30_000;

/** The fixture cards the walk wishes for: one made on the first device while the second is
 *  relaunching, and then one in each direction. */
const RELAUNCH_WISH = "Forest";
const FIRST_WISH = "Rhystic Study";
const SECOND_WISH = "Lightning Bolt";

// ---------------------------------------------------------------------------------------------
// The relay, under workerd
// ---------------------------------------------------------------------------------------------

/** The engine's own relay address, read from the Rust — and where its socket is, by the rule
 *  `platform::socket::ws_origin` applies. */
function relayBase() {
  const source = readFileSync(
    join(ROOT, "crates/grimoire-core/src/sync_engine/entitlement.rs"),
    "utf8",
  );
  const found = /pub const RELAY_BASE: &str = "(https:\/\/[a-z0-9.-]+)"/.exec(source)?.[1];
  if (!found)
    fail("entitlement.rs no longer spells RELAY_BASE, as an https origin, where this reads it");
  return found;
}

/** `wrangler.js`, or a sentence saying how to provide one. */
function wranglerScript() {
  const beside = join(ROOT, "app-worker/node_modules/wrangler/bin/wrangler.js");
  if (existsSync(beside)) return beside;
  const named = process.env.WRANGLER;
  if (named && existsSync(named)) return named;
  return fail(
    "no wrangler to run the relay with. Install app-worker's own " +
      "(`npm ci --ignore-scripts --prefix app-worker`), " +
      "or set WRANGLER to a wrangler.js — for example the one `npx wrangler` keeps in npm's cache.",
  );
}

/** A port nobody is listening on, as of now. */
function freePort() {
  return new Promise((found, lost) => {
    const probe = createServer();
    probe.once("error", lost);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => found(port));
    });
  });
}

/**
 * Stop a process and everything it started, **synchronously** — it is called from the process's
 * own `exit` as well as from the orderly stop, and nothing can be awaited there.
 *
 * wrangler's child is workerd, which holds the port and the database files, and a plain kill of
 * the parent leaves it running on either kind of host. On Windows `taskkill /T` walks the tree.
 * On POSIX the relay is started as the leader of a process group of its own (`detached`), and
 * the signal goes to the group — `kill(-pid)` — so workerd gets it whether or not wrangler passes
 * it on. Safe to call twice: a tree that has gone is a `taskkill` that finds nothing, or an
 * `ESRCH`.
 */
function stopTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null) return;
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // No such group: it has already gone.
  }
}

/**
 * Start the relay for `pageOrigin`, with one membership and one claim code in its D1. Answers
 * the port it listens on and its request log.
 *
 * **The state directory is under `relay/.wrangler/` and is named relatively.** wrangler 4.146 on
 * Windows turns an absolute `--persist-to` into `./C:\…` and its D1 then answers "internal
 * error" (measured 2026-10-04); a relative path works on every host. `.wrangler/` is ignored by
 * git everywhere, and the directory is removed when the run ends.
 */
async function startRelay(pageOrigin) {
  const script = wranglerScript();
  const config = "relay/wrangler.jsonc";
  const persist = `relay/.wrangler/sync-smoke-${process.pid}`;
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" };
  // What wrangler keeps beside the Worker while it runs: the bundle it built, in `tmp/`. A
  // wrangler told to stop removes its own; one stopped as Windows stops a process tree does
  // not, so whatever is there afterwards that was not there before is this run's, and goes.
  const scratch = join(ROOT, "relay/.wrangler/tmp");
  const before = new Set(existsSync(scratch) ? readdirSync(scratch) : []);
  const mine = () => [
    join(ROOT, persist),
    ...(existsSync(scratch) ? readdirSync(scratch) : [])
      .filter((entry) => !before.has(entry))
      .map((entry) => join(scratch, entry)),
  ];
  undo.push(async () => {
    for (const path of mine()) await rm(path, { recursive: true, force: true, maxRetries: 10 });
  });
  // And on the way out by any other road ({@link atExit}): the same, without waiting. Best
  // effort — workerd may still be letting go of a file, and a directory left behind is ignored
  // by git and by the lint, where a process left behind holds a port.
  atExit.push(() => {
    for (const path of mine()) {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  const d1 = (...args) => {
    const ran = spawnSync(
      process.execPath,
      [
        script,
        "d1",
        "execute",
        "mtg-grimoire-relay",
        "--local",
        "--persist-to",
        persist,
        "--config",
        config,
        ...args,
      ],
      { cwd: ROOT, env, encoding: "utf8" },
    );
    if (ran.status !== 0) fail(`seeding the local D1 failed:\n${ran.stdout}\n${ran.stderr}`);
  };
  // `schema.sql` is for a database that has never been migrated, which this one is.
  d1("--file", "relay/schema.sql");
  const now = Date.now();
  // Two memberships, a claim code each: the group the walk syncs through, and the one the
  // second device founds for itself and leaves.
  const member = (subject, code) =>
    "INSERT INTO entitlements (subject, source, external_id, status, created_at, checked_at) " +
    `VALUES ('${subject}', 'patreon', '${subject}-patron', 'active', ${now}, ${now}); ` +
    "INSERT INTO claim_codes (code, subject, expires_at) " +
    `VALUES ('${code.replaceAll("-", "")}', '${subject}', ${now + 10 * 60 * 1000});`;
  d1(
    "--command",
    member("smoke-subject", CLAIM_CODE) + " " + member("smoke-other", OWN_CLAIM_CODE),
  );

  const port = await freePort();
  const inspector = await freePort();
  // **The relay's signing key, made here and kept nowhere.** `RELAY_HMAC_KEY` never has a value
  // in a file of this repository — a throwaway one included, and this script is such a file —
  // so each run draws its own, hands it to this one relay on its command line, and forgets it
  // when the process ends. Nothing else needs to know it: the tokens it signs are minted and
  // verified by that same relay.
  const signingKey = randomBytes(32).toString("hex");
  const child = spawn(
    process.execPath,
    [
      script,
      "dev",
      "--local",
      "--config",
      config,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspector),
      "--local-protocol",
      "https",
      "--persist-to",
      persist,
      "--var",
      `RELAY_HMAC_KEY:${signingKey}`,
      "--var",
      `APP_ORIGINS:${pageOrigin}`,
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // A process group of its own where there is such a thing, so the whole tree can be
      // signalled at once (`stopTree`). Not on Windows, where it would open a console window.
      detached: process.platform !== "win32",
    },
  );
  // Ahead of the state directory's removal on both lists, so it is stopped first.
  undo.push(async () => {
    stopTree(child);
    // workerd lets go of its files a moment after it is told to stop.
    await pause(800);
  });
  atExit.push(() => stopTree(child));

  /** Every request the relay answered, in order: `{ method, path, status, at }`. */
  const log = [];
  /** Whatever it said that was not a request line or its banner — an exception, a warning. */
  const said = [];
  let ready;
  let failed;
  const listening = new Promise((found, lost) => ((ready = found), (failed = lost)));
  let pending = "";
  const hear = (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const request = /\[wrangler:info\] ([A-Z]+) (\S+) (\d{3}) /.exec(line);
      if (request) {
        log.push({
          method: request[1],
          path: request[2],
          status: Number(request[3]),
          at: Date.now(),
        });
      } else if (/\[wrangler:info\] Ready on https:\/\/127\.0\.0\.1:/.test(line)) {
        ready();
      } else if (/\[ERROR\]|Uncaught|exception/i.test(line)) {
        said.push(line.trim());
      }
    }
  };
  child.stdout.on("data", hear);
  child.stderr.on("data", hear);
  child.on("exit", (code) =>
    failed(new Error(`the local relay exited (${code}): ${said.join(" | ")}`)),
  );
  setTimeout(() => failed(new Error("the local relay never said it was ready")), 90_000).unref();
  await listening;
  return { port, log, said };
}

// ---------------------------------------------------------------------------------------------
// A device: one browser on one profile, one page of the app
// ---------------------------------------------------------------------------------------------

/** A viewport exactly this size, whatever the headless window's own minimum is. */
const viewport = (browser, width, height) => (sessionId) =>
  browser.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );

/**
 * One device of the walk. `face` is which of the app's two it mounts, by the viewport alone, and
 * so which controls the walk presses on it.
 */
async function device(name, face, origin, relay, chunk, own = {}) {
  const [width, height] = face === "desktop" ? [1280, 800] : [412, 915];
  const { browser, hosts, policy, close, problems } = await browse(
    origin,
    own.routes ?? fixtures(),
    {
      args: [
        // The relay's name is the local relay; every other name still resolves to nothing.
        `--host-resolver-rules=MAP ${relay.host} 127.0.0.1:${relay.port}, MAP * ~NOTFOUND, EXCLUDE localhost`,
        // wrangler's certificate is self-signed, and for another name.
        "--ignore-certificate-errors",
      ],
      through: (url) => url.startsWith(`${relay.base}/`),
      socket: (url) => url.startsWith(`${relay.socket}/`),
    },
  );
  // Before the page exists: a card file that is to be kept on its way is held from the first
  // ask. `releaseCards` lets it — and every later ask for it — through.
  const releaseCards = own.holdCards ? hosts.hold(CARDS_FILE) : () => undefined;
  const page = await openPage(
    browser,
    `${origin}/settings`,
    hosts.check,
    policy,
    viewport(browser, width, height),
  );
  // The page's own requests and their failures; the engine's are its Worker's, switched on by
  // the harness as the Worker starts.
  await browser.send("Network.enable", {}, page.sessionId);

  /** One command through the page's `Core`; a refusal is the engine's sentence, and fails. */
  const engine = async (command, args) => {
    const answer = await page.evaluate(
      `import(${JSON.stringify(chunk)})
        .then((module) => module.webCore.call(${JSON.stringify(command)}, ${JSON.stringify(args)}))
        .then((value) => ({ value }), (refused) => ({ refused: String(refused) }))`,
    );
    if (answer.refused !== undefined) fail(`${name}: ${command} was refused: ${answer.refused}`);
    return answer.value;
  };
  /** Poll the engine until `done(answer)`; answers the answer. */
  const engineUntil = async (what, command, done, withinMs = 60_000) => {
    for (const stop = performance.now() + withinMs; ; await pause(100)) {
      hosts.check();
      const answer = await engine(command);
      if (done(answer)) return answer;
      if (performance.now() > stop) {
        fail(`${name}: ${what} — never happened. ${command} answers ${JSON.stringify(answer)}`);
      }
    }
  };
  /** Every event of this kind the browser reported for this device's targets, in order. */
  const events = (method) => browser.heard.filter((message) => message.method === method);
  /** What the page was told about live sync since it started listening (`listenToSync`). */
  const told = () => page.evaluate("window.__sync");

  /** A main destination of the app, by the control this face draws for it. */
  const go = (view) => {
    const word = view[0].toUpperCase() + view.slice(1);
    return face === "desktop"
      ? page.press(`${name}: the rail's ${word}`, buttonSaying(word))
      : page.press(
          `${name}: the ${word} tab`,
          view === "settings"
            ? `document.querySelector('a[aria-label="Settings"]')`
            : `document.querySelector('nav[aria-label="Views"] a[href="/${view}"]')`,
        );
  };
  /** Settings' Sync group, open. Both faces draw it behind the same row. */
  const openSync = async () => {
    if (await page.evaluate(`!!${buttonSaying("Pair a device")}`)) return;
    await page.press(
      `${name}: Settings' Sync group`,
      `document.querySelector('button[aria-label="Sync"]')`,
    );
    await page.until(`${name}: the Sync panel drew`, `!!${buttonSaying("Pair a device")}`, 30_000);
  };
  /**
   * Connect a membership: the claim code typed into the Sync panel's own field. Answers when
   * *Connect* was pressed, and the group the claim founded.
   */
  const claim = async (code) => {
    await openSync();
    await page.press(`${name}: the claim-code field`, `document.querySelector("#patreon-claim")`);
    await page.type(code);
    const pressed = Date.now();
    await page.press(`${name}: the claim's Connect`, buttonSaying("Connect"));
    await page.until(
      `${name}: the panel said the membership is connected`,
      `/Supporting/.test(document.body.innerText)`,
      30_000,
    );
    const founded = await engineUntil(
      "the claim founded a group",
      "sync_pairing_status",
      (s) => s.groupId !== null,
    );
    await engineUntil("its socket came up", "sync_live_state", (s) => s === "live");
    return { pressed, founded };
  };
  /**
   * Start this device again: the page reloaded, which is a new document, a new engine Worker
   * and a launch — over the profile's own database, so a device that was paired still is.
   * Answers once the new document's database is open; what the launch then does is the
   * caller's to wait for.
   */
  const relaunch = async () => {
    await page.evaluate("window.__smokeDocument = true");
    await page.reload();
    await page.until(
      `${name}: the document after the relaunch opened its database`,
      `window.__smokeDocument === undefined &&
        import(${JSON.stringify(chunk)})
          .then((m) => m.webCore.call("startup_status"))
          .then((s) => s.state !== "loading")`,
    );
    const refused = await page.evaluate(ALERT);
    if (refused) fail(`${name}: the relaunch did not open its database:\n${refused}`);
    await page.evaluate(listenToSync(chunk));
  };
  /** Whether the socket this device made last has been closed, as its Worker reports it. */
  const lastSocketClosed = () => {
    const last = policy.sockets.at(-1);
    return (
      last !== undefined &&
      events("Network.webSocketClosed").some(
        (event) => event.sessionId === last.sessionId && event.params.requestId === last.requestId,
      )
    );
  };
  /**
   * Search for `card`, open it, and press its *Add to wishlist* — or, with `any`, the phone
   * face's *Any printing* beside it, which wishes for the card and not for one printing of it.
   * Answers when the press landed.
   */
  const wish = async (card, any = false) => {
    await go("search");
    const box =
      face === "desktop"
        ? `document.querySelector("#card-search-text")`
        : `document.querySelector('input[type="search"][aria-label="Search cards"]')`;
    await page.press(`${name}: the search box`, box);
    // The box may hold the last search: replaced, not appended to.
    await page.evaluate(`${box}.select()`);
    await page.type(card);
    const tile =
      face === "desktop"
        ? `document.querySelector('img[alt^=${JSON.stringify(card)}]')?.closest("button")`
        : `document.querySelector('button[aria-label^=${JSON.stringify(`${card},`)}]')`;
    await page.press(`${name}: ${card}'s tile`, tile);
    // The desktop's is greyed until the card's own read has answered, and a press on a greyed
    // button is no press: `:enabled` is the control a reader could use.
    const add =
      face === "desktop"
        ? `document.querySelector('[role="dialog"] button[aria-label="Add to wishlist"]:enabled')`
        : any
          ? `document.querySelector('button[aria-label="Add to wishlist, any printing"]')`
          : buttonSaying("Add to wishlist");
    const wishes = async () =>
      (await engine("wishlist_summary", { marketplace: "tcgplayer" })).wishes;
    const before = await wishes();
    // Found and then pressed, so the moment of the press is the moment answered.
    await page.until(`${name}: ${card}'s Add to wishlist is drawn`, `!!${add}`, 30_000);
    const pressed = Date.now();
    await page.press(`${name}: Add to wishlist`, add);
    // The press wrote, or the run stops here saying so — not a minute later on the other
    // device, as a doorbell that never rang.
    for (const stop = performance.now() + 10_000; (await wishes()) === before; await pause(50)) {
      if (performance.now() > stop)
        fail(`${name}: pressing Add to wishlist for ${card} wrote nothing`);
    }
    return pressed;
  };
  /** Close whatever card is open over the page. */
  const closeCard = () =>
    page.press(
      `${name}: the card's close`,
      face === "desktop"
        ? `document.querySelector('button[aria-label="Close card details"]')`
        : `document.querySelector('button[aria-label="Close card"]')`,
    );
  /** Whether the page — its wishlist, when that is the page — draws `card`. */
  const draws = (card) =>
    `[...document.querySelectorAll("main [aria-label], main img[alt]")].some((el) =>
      (el.getAttribute("aria-label") ?? el.getAttribute("alt") ?? "").startsWith(${JSON.stringify(card)}))`;

  return {
    name,
    face,
    browser,
    hosts,
    policy,
    page,
    close,
    problems,
    engine,
    engineUntil,
    events,
    told,
    go,
    openSync,
    wish,
    closeCard,
    draws,
    claim,
    relaunch,
    releaseCards,
    lastSocketClosed,
  };
}

/** A relay path with its group and its rendezvous taken out, so one route reads as one. */
const shape = (path) =>
  path
    .replace(/\/g\/[^/]+/, "/g/{group}")
    .replace(/\/p\/[0-9a-f]+/, "/p/{rv}")
    .replace(/\?.*/, "");

/** Keep, on the page, every `sync:live` and `sync:applied` it is told from now on. */
const listenToSync = (chunk) => `import(${JSON.stringify(chunk)}).then(({ webCore }) => {
  if (window.__sync) return true;
  window.__sync = { live: [], applied: [] };
  webCore.listen("sync:live", (event) => window.__sync.live.push({ state: event.state, at: Date.now() }));
  webCore.listen("sync:applied", (outcome) => window.__sync.applied.push({ ...outcome, at: Date.now() }));
  return true;
})`;

/**
 * Wait, finely, for `expression` on `page`; answers when it was first seen, in unix ms. `more`
 * is what else to say when it never is — where along the way the thing stopped.
 */
async function seen(dev, what, expression, more = async () => "", withinMs = 60_000) {
  for (const stop = performance.now() + withinMs; ; await pause(40)) {
    dev.hosts.check();
    if (await dev.page.evaluate(expression).catch(() => false)) return Date.now();
    if (performance.now() > stop) {
      const shown = await dev.page.evaluate("document.body.innerText").catch(() => "(no document)");
      const also = await more().catch((error) => `(and asking why failed: ${error.message})`);
      fail(`${dev.name}: ${what} — never happened. ${also}\nThe page shows:\n${shown}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// What the loop costs, when it is asked (`--measure`)
// ---------------------------------------------------------------------------------------------

/**
 * Profile the engine's Worker for `ms` and answer how long it was not idle.
 *
 * V8's sampling profiler, on the Worker's own DevTools session: every sample that is not the
 * `(idle)` node is the Worker's thread doing something — script, the engine's wasm, the
 * garbage collector, or `(program)`, which is native code under no script frame.
 */
async function busy(dev, ms) {
  const session = dev.policy.workers().at(-1);
  if (!session) fail(`${dev.name}: there is no engine Worker to profile`);
  await dev.browser.send("Profiler.enable", {}, session);
  await dev.browser.send("Profiler.setSamplingInterval", { interval: 200 }, session);
  await dev.browser.send("Profiler.start", {}, session);
  await pause(ms);
  const { profile } = await dev.browser.send("Profiler.stop", {}, session);
  const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  const spent = new Map();
  profile.samples.forEach((id, at) => {
    const name = names.get(id) ?? "?";
    const kind =
      name === "(idle)" || name === "(program)" || name === "(garbage collector)" ? name : "script";
    spent.set(kind, (spent.get(kind) ?? 0) + (profile.timeDeltas[at] ?? 0));
  });
  const of = (kind) => (spent.get(kind) ?? 0) / 1000;
  const total = (profile.endTime - profile.startTime) / 1000;
  return {
    total,
    busy: total - of("(idle)"),
    script: of("script"),
    program: of("(program)"),
    collector: of("(garbage collector)"),
  };
}
const costLine = (cost) =>
  `${cost.busy.toFixed(1)} ms busy of ${(cost.total / 1000).toFixed(1)} s ` +
  `(${cost.script.toFixed(1)} ms in script and wasm, ${cost.program.toFixed(1)} ms native, ` +
  `${cost.collector.toFixed(1)} ms collecting)`;

/**
 * A page command issued over and over while a round trip runs: how long each waited.
 *
 * `sync_now` is the trip — the same `run_once` the loop's own trips are, under the same lane —
 * and `search_cards` is the command a reader's typing sends. On one thread the search can only
 * be answered between two of the trip's stretches, so what is measured is the longest stretch.
 */
const STARVATION = (chunk) => `(async () => {
  const { webCore } = await import(${JSON.stringify(chunk)});
  const search = async () => {
    const from = performance.now();
    await webCore.call("search_cards", { req: { text: "bolt" } });
    return performance.now() - from;
  };
  const alone = [];
  for (let n = 0; n < 30; n += 1) alone.push(await search());
  let over = false;
  const from = performance.now();
  const trip = webCore.call("sync_now").then((outcome) => ((over = true), outcome));
  const beside = [];
  while (!over) beside.push(await search());
  const outcome = await trip;
  return { alone, beside, tripMs: performance.now() - from, outcome };
})()`;
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

async function main() {
  const base = relayBase();
  // `RELAY_BASE` is an origin — a scheme and a host, no path — which `relayBase` holds it to.
  const relayAt = {
    base,
    host: base.slice("https://".length),
    socket: base.replace(/^https:\/\//, "wss://"),
  };
  const { origin } = await serve();
  const chunk = coreChunk();

  const began = performance.now();
  const relay = await startRelay(origin);
  relayAt.port = relay.port;
  console.log(
    `ok  the relay is up under workerd on 127.0.0.1:${relay.port} (TLS), answering as ` +
      `${relayAt.host} to pages of ${origin} — ${Math.round(performance.now() - began)} ms`,
  );

  // Two devices. The first holds the membership, offers the pairing and removes the second.
  // **The second's card file is thirty thousand cards and is held on its way**, so it pairs
  // with no card in its database, and its first ingest is the one its relaunch makes — with
  // the loop already in a group (step 5 of the header).
  const first = await device("the desktop face", "desktop", origin, relayAt, chunk);
  const second = await device("the phone face", "phone", origin, relayAt, chunk, {
    routes: fixtures(grownCards(GROWN_CARDS)),
    holdCards: true,
  });
  const both = [first, second];

  for (const dev of both) {
    await dev.page.until(
      `${dev.name} got past its startup gate`,
      `import(${JSON.stringify(chunk)}).then((m) => m.webCore.call("startup_status")).then((s) => s.state !== "loading")`,
    );
    const refused = await dev.page.evaluate(ALERT);
    if (refused) fail(`${dev.name} did not open its database:\n${refused}`);
    await dev.page.evaluate(listenToSync(chunk));
    const size = await dev.page.evaluate("`${innerWidth} × ${innerHeight}`");
    await dev.engineUntil(
      dev === first ? "the first run's card sync finished" : "the held first run is waiting",
      "sync_status",
      (s) => (dev === first ? s.cardCount === 6 && !s.syncing : s.cardCount === 0 && s.syncing),
    );
    const live = await dev.engine("sync_live_state");
    if (live !== "off") fail(`${dev.name} is in no group and reads ${live}`);
    dev.label = `${dev.name} (${size})`;
  }
  if (relay.log.length > 0 || both.some((dev) => dev.policy.sockets.length > 0)) {
    fail(`before anything was paired the relay was asked: ${JSON.stringify(relay.log)}`);
  }
  console.log(
    `ok  two devices on two profiles — ${first.label} with 6 cards and ${second.label} with ` +
      "its card file still on its way — each reading off, and the relay asked nothing",
  );

  if (MEASURE) {
    const cost = await busy(first, IDLE_MS);
    console.log(
      `ok  idle and in no group, the engine's Worker was ${costLine(cost)} — the loop's five-second read of sync_group among it`,
    );
  }

  // ---- the claim -------------------------------------------------------------------------
  const { pressed: claimed, founded } = await first.claim(CLAIM_CODE);
  const firstLive = (await first.told()).live;
  const dialled = firstLive.find((event) => event.state === "connecting");
  const up = firstLive.find((event) => event.state === "live");
  if (!dialled || !up)
    fail(`the first device never said connecting and live: ${JSON.stringify(firstLive)}`);
  console.log(
    `ok  ${first.name} claimed with the code a reader types, founded a group of one ` +
      `(${founded.deviceName}), and its socket is live — ${dialled.at - claimed} ms from the ` +
      `press to connecting (the loop's five-second read), ${up.at - dialled.at} ms from ` +
      "connecting to live (a round trip, then the upgrade)",
  );

  // ---- a group of its own, and leaving it ---------------------------------------------------
  // The regression's first half. The second device founds a group and holds its socket; then
  // it leaves. A loop that asked which group it was in only between sockets kept this one —
  // reading `live`, on the group it had left — for as long as the socket lived.
  const own = await second.claim(OWN_CLAIM_CODE);
  if (own.founded.groupId === founded.groupId) fail("the two claims founded one group");
  const ownSocket = second.policy.sockets.at(-1);
  if (!ownSocket?.url.includes(`/g/${own.founded.groupId}/ws`)) {
    fail(`${second.name}'s socket is not its own group's: ${ownSocket?.url}`);
  }
  const leaving = Date.now();
  await second.page.press("Leave group", buttonSaying("Leave group"));
  await second.page.press(
    "the dialog's Leave the group",
    buttonSaying("Leave the group", '[role="dialog"]'),
  );
  await second.engineUntil("it left its group", "sync_pairing_status", (s) => s.groupId === null);
  await second.engineUntil("its loop said off", "sync_live_state", (s) => s === "off", 10_000);
  const wentOff = (await second.told()).live.at(-1);
  for (const stop = performance.now() + 10_000; !second.lastSocketClosed(); await pause(50)) {
    if (performance.now() > stop) fail(`${second.name} left its group and kept its socket`);
  }
  const leftSaid = (await second.told()).live.map((event) => event.state);
  if (leftSaid.join() !== "connecting,live,off") {
    fail(`${second.name} left its group and said ${leftSaid.join(", ")}`);
  }
  const leftLog = await second.engine("error_log_list", { limit: 50 });
  if (leftLog.length > 0)
    fail(`${second.name} left its group and logged: ${JSON.stringify(leftLog)}`);
  console.log(
    `ok  ${second.name} claimed a membership of its own, founded a group of one and went live; ` +
      `it pressed Leave group and let go of its socket — off ${wentOff.at - leaving} ms after ` +
      "the press, never offline, the socket closed, nothing logged",
  );

  // ---- the pairing -----------------------------------------------------------------------
  await first.page.press("Pair a device", buttonSaying("Pair a device"));
  const code = await first.page.until(
    "the offer drew its code",
    `document.querySelector('[aria-label="Pairing code as a QR code"]')?.parentElement?.querySelector("p")?.innerText.trim()`,
    30_000,
  );
  await second.openSync();
  await second.page.press("Enter a code", buttonSaying("Enter a code from another device"));
  await second.page.press("the code box", `document.querySelector("textarea")`);
  await second.page.type(code);
  await second.page.press("Read the code", buttonSaying("Read the code"));
  const DIGITS = `document.querySelector('[data-testid="pairing-sas"]')?.innerText.trim()`;
  const joining = await second.page.until("the joining device drew six digits", DIGITS, 30_000);
  const offering = await first.page.until("the offering device drew six digits", DIGITS, 30_000);
  if (!/^\d{6}$/.test(joining) || joining !== offering) {
    fail(`the two devices show different digits: ${offering} and ${joining}`);
  }
  await first.page.press("Codes match", buttonSaying("Codes match"));
  for (const dev of both) {
    await dev.engineUntil(
      "the roster holds two devices",
      "sync_pairing_status",
      (s) => s.devices.length === 2,
    );
    await dev.page.until(
      `${dev.name}'s panel reads a group of two`,
      `/in a group of 2 devices/.test(document.body.innerText)`,
      30_000,
    );
    await dev.engineUntil("the socket is live", "sync_live_state", (s) => s === "live");
  }
  // The regression's second half: the socket the second device holds now is the group's it
  // joined. Kept from before, it would be the address of the group it left.
  const joinedSocket = second.policy.sockets.at(-1);
  if (joinedSocket === ownSocket || !joinedSocket.url.includes(`/g/${founded.groupId}/ws`)) {
    fail(
      `${second.name} joined ${founded.groupId} and its socket is ${joinedSocket.url} ` +
        `(the group it left was ${own.founded.groupId})`,
    );
  }
  const secondLive = (await second.told()).live.slice(leftSaid.length);
  const joined = secondLive.find((event) => event.state === "connecting");
  const joinedUp = secondLive.find((event) => event.state === "live");
  console.log(
    `ok  paired — a ${code.length}-character code typed into ${second.name}, ${offering} on both, ` +
      `Codes match on ${first.name}; both read a group of 2 devices and both are live ` +
      `(${second.name}: ${joinedUp.at - joined.at} ms from connecting to live), and ` +
      `${second.name}'s socket is the group's it joined, not the one it left`,
  );
  // The trips a completed pairing owes — each side's first exchange — settle before the walk
  // measures a write of its own: nothing pending on either device.
  for (const dev of both) {
    await dev.engineUntil(
      "the pairing's own trips settled",
      "sync_relay_status",
      (s) => s.pending === 0 && s.lastSyncAt !== null,
    );
  }

  if (MEASURE) {
    const cost = await busy(first, IDLE_MS);
    console.log(
      `ok  idle, paired and live, the engine's Worker was ${costLine(cost)} — the loop's quarter-second tick and its keepalive among it`,
    );
    const starved = await first.page.evaluate(STARVATION(chunk));
    console.log(
      `ok  a search beside a round trip — alone ${median(starved.alone).toFixed(1)} ms (median of ` +
        `${starved.alone.length}); during a ${starved.tripMs.toFixed(0)} ms trip, ${starved.beside.length} ` +
        `searches answered, median ${median(starved.beside).toFixed(1)} ms, slowest ` +
        `${Math.max(...starved.beside).toFixed(1)} ms`,
    );
  }

  // ---- the paired device relaunches, into its first ingest ----------------------------------
  // A paired device's launch is two things on the engine's one connection and one thread: the
  // launch's downloads — here a whole card file, thirty thousand cards, since this device has
  // none — and the loop's first act, a round trip, and then its socket. Nothing before this
  // step runs the two together: a first run is in no group, and a relaunch inside a day
  // downloads nothing. The first device writes meanwhile, so there is something to take.
  second.releaseCards();
  const beforeRelaunch = relay.log.length;
  const relaunched = Date.now();
  await second.relaunch();
  const wished = first.wish(RELAUNCH_WISH).then(() => first.closeCard());
  // Asked over and over from the moment the new document is up, and each answer timed: the
  // engine has one thread, so how long a read waits is how long the ingest — or a trip — kept
  // it. `live` and the end of the ingest are each when a read first said so.
  let liveAgain = null;
  let ingested = null;
  let slowest = 0;
  for (const stop = performance.now() + 120_000; ingested === null || liveAgain === null;) {
    second.hosts.check();
    const asked = performance.now();
    const live = await second.engine("sync_live_state");
    slowest = Math.max(slowest, performance.now() - asked);
    if (live === "live") liveAgain ??= Date.now();
    const status = await second.engine("sync_status");
    if (status.cardCount >= GROWN_CARDS && !status.syncing) ingested = status;
    if (performance.now() > stop) {
      fail(
        `${second.name} relaunched paired and never settled: it reads ${live}, and its card ` +
          `sync ${JSON.stringify(status)}`,
      );
    }
    await pause(50);
  }
  const ingestedAt = Date.now();
  await wished;
  if (ingested.lastError !== null)
    fail(`${second.name}'s card sync left ${JSON.stringify(ingested)}`);
  // A round trip opens with `/keys`, and this device's first one after the reload is its launch
  // trip — read off its own engine's requests, not the relay's log, where the other device's
  // trips are the same line (one run in eleven had one of those 14 ms after the reload).
  const tripAsked = second
    .events("Network.requestWillBeSent")
    .map((event) => ({ url: event.params.request.url, at: event.params.wallTime * 1000 }))
    .find((sent) => /\/keys(\?|$)/.test(sent.url) && sent.at >= relaunched);
  if (!tripAsked) fail(`${second.name} relaunched paired and its loop made no round trip`);
  // The relay's side of the same seconds: this device's socket is the one upgrade in them.
  const upgraded = relay.log.slice(beforeRelaunch).find((entry) => entry.status === 101);
  if (!upgraded) fail(`${second.name} reads live after its relaunch and the relay upgraded nobody`);
  await second.go("wishlist");
  await seen(
    second,
    `its wishlist drew ${RELAUNCH_WISH}, wished for on ${first.name} while it was relaunching`,
    second.draws(RELAUNCH_WISH),
  );
  const tookAt = Date.now();
  const relaunchLog = await second.engine("error_log_list", { limit: 50 });
  if (relaunchLog.length > 0)
    fail(`${second.name}'s relaunch logged: ${JSON.stringify(relaunchLog)}`);
  console.log(
    `ok  ${second.name} relaunched paired, into a first ingest of ${ingested.cardCount} cards — ` +
      `its launch trip asked the relay ${Math.round(tripAsked.at - relaunched)} ms after the reload, the ` +
      `relay upgraded its socket at ${upgraded.at - relaunched} ms, it read ` +
      `live at ${liveAgain - relaunched} ms and the ingest was done at ` +
      `${ingestedAt - relaunched} ms; the longest a read of the engine waited was ` +
      `${Math.round(slowest)} ms; and ${RELAUNCH_WISH}, wished for on ${first.name} ` +
      `meanwhile, was on its wishlist at ${tookAt - relaunched} ms. Nothing logged`,
  );

  // ---- the doorbell, phone to desktop ----------------------------------------------------
  const doorbell = async (writer, reader, card, any = false) => {
    await reader.go("wishlist");
    await seen(
      reader,
      "its wishlist page drew",
      `location.pathname === "/wishlist" && !${reader.draws(card)}`,
    );
    const mark = (await reader.told()).applied.length;
    const from = relay.log.length;
    const pressed = await writer.wish(card, any);
    // Where the write stopped, when it never arrives: on the writer, at the relay, in the
    // reader's engine, or between that engine and its page.
    const stoppedAt = async () =>
      `${writer.name} holds ${JSON.stringify(await writer.engine("sync_relay_status"))} and reads ` +
      `${await writer.engine("sync_live_state")}; the relay answered ` +
      `${
        relay.log
          .slice(from)
          .map((entry) => `${entry.method} ${shape(entry.path)} ${entry.status}`)
          .join(", ") || "nothing"
      }; ` +
      `${reader.name} reads ${await reader.engine("sync_live_state")}, was told ` +
      `${JSON.stringify((await reader.told()).applied.slice(mark))}, and its engine's wishlist holds ` +
      `${JSON.stringify(await reader.engine("wishlist_summary", { marketplace: "tcgplayer" }))}.`;
    const drawn = await seen(
      reader,
      `its wishlist drew ${card}, written on ${writer.name}`,
      reader.draws(card),
      stoppedAt,
    );
    const applied = (await reader.told()).applied.slice(mark);
    const told = applied.find((outcome) => outcome.changed);
    if (!told)
      fail(
        `${reader.name} drew ${card} and was never told sync:applied: ${JSON.stringify(applied)}`,
      );
    await writer.closeCard();
    console.log(
      `ok  ${writer.name} wished for ${card} and ${reader.name}'s wishlist drew it with nothing ` +
        `pressed there — ${drawn - pressed} ms from the press to the tile ` +
        `(sync:applied after ${told.at - pressed} ms: ${told.pulled} pulled, ${told.pushed} pushed)`,
    );
    return drawn - pressed;
  };
  // The second device wishes for the card and not for a printing: its corpus is the grown one,
  // and most of its printings of any card are ones the first device has never heard of.
  await doorbell(second, first, SECOND_WISH, true);
  await doorbell(first, second, FIRST_WISH);

  // ---- what the walk so far asked, and how it went ----------------------------------------
  // Read before the removal: a removed device's requests are refused on purpose, after it.
  const asked = [...relay.log];
  const preflights = asked.filter((entry) => entry.method === "OPTIONS");
  const requests = asked.filter((entry) => entry.method !== "OPTIONS");
  // **One refusal is the protocol at work, and it is told from every other.** The device that
  // confirms a pairing seals the key at the group's epoch and publishes the join's rotation a
  // moment later; the joiner's first trip is running in that moment, and now and then — three
  // runs in twenty-one here — the rotation lands between that trip's key check and its group
  // door. The relay then refuses, correctly, the auth of the epoch it has just left, and the
  // engine asks `/keys` and the door again (`token_across_a_rotation`, step 6.3b; before it the
  // trip failed there). Allowed only in that shape — the joiner's, at the group door, behind a
  // `/rotate`, and answered by a `/keys` and a `/token` that is given — and only once.
  //
  // Whose request one was is read off that device's own engine, as it saw it answered — and for
  // `/token`, which has two doors at one path, which door: a refusal is read differently on each.
  const asker = (entry) =>
    both
      .flatMap((dev) =>
        dev
          .events("Network.responseReceived")
          .filter(
            (event) =>
              event.params.response.status === entry.status &&
              event.params.response.url.split("?")[0].endsWith(entry.path.split("?")[0]),
          )
          .map((event) => {
            const body =
              dev
                .events("Network.requestWillBeSent")
                .find(
                  (sent) =>
                    sent.sessionId === event.sessionId &&
                    sent.params.requestId === event.params.requestId,
                )?.params.request.postData ?? "";
            const door = /"refresh"/.test(body) ? ", the refresh door" : "";
            return `${dev.name}${/"auth"/.test(body) ? ", the group door" : door}`;
          }),
      )
      .join(" and ") || "a device the walk did not hear";
  const acrossARotation = (entry) => {
    if (entry.method !== "POST" || entry.path !== "/token" || entry.status !== 401) return false;
    if (asker(entry) !== `${second.name}, the group door`) return false;
    const at = requests.indexOf(entry);
    const rotated = requests
      .slice(Math.max(0, at - 3), at)
      .some((earlier) => /\/rotate$/.test(earlier.path) && earlier.status === 200);
    const later = requests.slice(at + 1);
    const again = later.findIndex((next) => next.method === "POST" && next.path === "/token");
    return (
      rotated &&
      again > 0 &&
      later[again].status === 200 &&
      later.slice(0, again).some((next) => next.method === "GET" && /\/keys$/.test(next.path))
    );
  };
  const refused = requests.filter(
    // The rendezvous poll's 404 is the relay's "not yet", which the engine waits through.
    (entry) => entry.status >= 400 && !(entry.status === 404 && /^\/p\//.test(entry.path)),
  );
  const reasked = refused.filter(acrossARotation);
  const refusals =
    reasked.length > 1 ? refused : refused.filter((entry) => !reasked.includes(entry));
  if (refusals.length > 0) {
    const before = (entry) =>
      asked
        .slice(0, asked.indexOf(entry))
        .filter((earlier) => earlier.method !== "OPTIONS")
        .slice(-4)
        .map((earlier) => `${earlier.method} ${shape(earlier.path)} ${earlier.status}`)
        .join(", ");
    fail(
      `the relay refused: ${refusals
        .map(
          (entry) =>
            `${entry.method} ${shape(entry.path)} ${entry.status} (${asker(entry)}; ` +
            `${entry.at - asked[0].at} ms after the relay's first request, after ${before(entry)})`,
        )
        .join(", ")}`,
    );
  }
  const upgrades = requests.filter((entry) => entry.status === 101).length;
  const waited = requests.filter((entry) => entry.status === 404).length;
  const byRoute = new Map();
  for (const entry of requests) {
    const key = `${entry.method} ${shape(entry.path)}`;
    byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
  }
  for (const dev of both) {
    const failures = dev.events("Network.loadingFailed").filter((event) => !event.params.canceled);
    if (failures.length > 0) {
      fail(
        `${dev.name} had requests fail: ${failures.map((event) => `${event.params.errorText} (${event.params.type})`).join(", ")}`,
      );
    }
    const errors = dev
      .events("Runtime.consoleAPICalled")
      .filter((event) => event.params.type === "error");
    if (errors.length > 0) {
      fail(
        `${dev.name} wrote errors to its console: ${errors.map((event) => event.params.args.map((arg) => arg.value ?? arg.description).join(" ")).join(" | ")}`,
      );
    }
    const log = await dev.engine("error_log_list", { limit: 50 });
    if (log.length > 0) fail(`${dev.name} logged: ${JSON.stringify(log)}`);
  }
  if (relay.said.length > 0) fail(`the relay said: ${relay.said.join(" | ")}`);
  console.log(
    `ok  no request failed and nothing was logged — the relay answered ${requests.length} requests ` +
      `and ${preflights.length} pre-flights (${upgrades} upgrades, ${waited} rendezvous polls answered not-yet): ` +
      [...byRoute].map(([route, count]) => `${route} × ${count}`).join(", ") +
      (reasked.length === 1
        ? ". One token was asked across the join's rotation: refused, and given at the next ask, under the new key"
        : ""),
  );

  // ---- the socket itself ------------------------------------------------------------------
  for (const dev of both) {
    const mine = dev.policy.sockets;
    const frames = (method) =>
      dev.events(method).map((event) => ({
        id: event.params.requestId,
        data: event.params.response.payloadData,
        at: event.params.timestamp,
      }));
    const sent = frames("Network.webSocketFrameSent");
    const received = frames("Network.webSocketFrameReceived");
    const answer = dev
      .events("Network.webSocketHandshakeResponseReceived")
      .map((event) => event.params.response);
    const selected = answer.map(
      (response) =>
        Object.entries(response.headers).find(
          ([header]) => header.toLowerCase() === "sec-websocket-protocol",
        )?.[1],
    );
    const pings = sent.filter((frame) => frame.data === "ping");
    const pongs = received.filter((frame) => frame.data === "pong");
    const heads = received.filter((frame) => frame.data.startsWith("{"));
    if (sent.some((frame) => frame.data !== "ping"))
      fail(`${dev.name} sent something that is not a keepalive: ${JSON.stringify(sent)}`);
    if (pings.length === 0 || pongs.length !== pings.length) {
      fail(`${dev.name} sent ${pings.length} pings and heard ${pongs.length} pongs`);
    }
    if (selected.some((protocol) => protocol !== "grimoire.live.v1")) {
      fail(`${dev.name}'s upgrade was answered with the sub-protocol ${JSON.stringify(selected)}`);
    }
    const gaps = pings.slice(1).map((ping, at) => Math.round(ping.at - pings[at].at));
    dev.socketLine =
      `${mine.length} socket${mine.length === 1 ? "" : "s"}, ${answer.map((response) => response.status).join("/")} ` +
      `selecting ${[...new Set(selected)].join()}, ${pings.length} ping${pings.length === 1 ? "" : "s"} each answered pong` +
      (gaps.length > 0 ? ` (${gaps.join(" s, ")} s apart)` : "") +
      `, ${heads.length} head frame${heads.length === 1 ? "" : "s"}`;
  }
  console.log(
    `ok  the sockets — ${first.name}: ${first.socketLine}; ${second.name}: ${second.socketLine}`,
  );

  // ---- the removal ------------------------------------------------------------------------
  await first.go("settings");
  await first.openSync();
  const saidBefore = (await second.told()).live.length;
  const removed = Date.now();
  await first.page.press(
    "the second device's Remove",
    `document.querySelector('button[aria-label^="Remove "]')`,
  );
  await first.page.press(
    "the dialog's Remove device",
    buttonSaying("Remove device", '[role="dialog"]'),
  );
  await first.engineUntil(
    "the roster holds one device again",
    "sync_pairing_status",
    (s) => s.devices.length === 1,
  );
  const rotated = Date.now();
  // **The relay tells the removed device, and nothing is pressed on it.** The rotation's roster
  // closes its socket with 4002; its loop backs off — `offline`, a second or a few — and then
  // does what a reconnect always starts with, a round trip, on which `/keys` answers a manifest
  // without it and it clears its own group; with no group there is nothing to dial for, and it
  // says `off`. (Until step 6.3b the relay closed nothing, and this step pressed Sync now.)
  const gone = await second.engineUntil(
    "the removed device read as in no group, with nothing pressed on it",
    "sync_pairing_status",
    (s) => s.groupId === null,
    30_000,
  );
  const learned = Date.now();
  await second.engineUntil("its loop said off", "sync_live_state", (s) => s === "off", 15_000);
  if (!second.lastSocketClosed()) fail(`${second.name} was removed and kept its socket`);
  const removedSaid = (await second.told()).live.slice(saidBefore).map((event) => event.state);
  if (removedSaid.join() !== "offline,connecting,off") {
    fail(`${second.name} was removed and said ${removedSaid.join(", ")}`);
  }
  // What it recorded of it: the removal, in one sentence, once — and nothing else is a failure
  // here. The sentence is also the walk's look at the code the relay closed with: a dropped
  // group's 4001 writes no row, and any other close writes "the relay closed the socket". This device joined by pairing, so the row is also the walk's look at what the loop
  // records on one: until step 6.3b it asked `entitlement::membership_ended` alone, which
  // answers yes for every device that holds no refresh secret, and this log stayed empty.
  const removedLog = (await second.engine("error_log_list", { limit: 50 })).map(
    (row) => row.message,
  );
  if (removedLog.length !== 1 || !/no longer in its sync group/.test(removedLog[0])) {
    fail(
      `${second.name} was removed and its log holds ${JSON.stringify(removedLog)} — ` +
        "one row saying so was expected",
    );
  }
  // Its panel, opened now — a look, not a sync: this document has not drawn the Sync panel
  // since it relaunched, so what it reads is what the engine answers.
  await second.go("settings");
  await second.openSync();
  await second.page.until(
    "the removed device's panel reads not paired",
    `/not paired yet/.test(document.body.innerText)`,
    30_000,
  );
  const after = relay.log.slice(asked.length).filter((entry) => entry.method !== "OPTIONS");
  console.log(
    `ok  ${first.name} removed ${gone.deviceName} from the roster (${rotated - removed} ms), ` +
      `and ${second.name} read as in no group ${learned - removed} ms after the press, with ` +
      `nothing pressed on it — it said ${removedSaid.join(", ")}, its socket closed, and its ` +
      `log holds one row, "${removedLog[0]}". ` +
      "The relay's answers: " +
      [
        ...new Set(after.map((entry) => `${entry.method} ${shape(entry.path)} ${entry.status}`)),
      ].join(", "),
  );

  // ---- the policy, and what was listened to -----------------------------------------------
  // An issue is reported a moment after the act that raised it.
  await pause(500);
  for (const dev of both) {
    dev.hosts.check();
    const thrown = dev.page.thrown();
    if (thrown.length > 0) fail(`${dev.name} threw:\n${thrown.join("\n")}`);
    const watched = dev.policy.watched();
    const count = (kind) => watched.filter((target) => target.startsWith(`${kind} `)).length;
    if (count("worker") === 0 || count("service_worker") === 0) {
      fail(
        `${dev.name}'s policy was watched on ${watched.join(", ")} — no Worker, or no service worker`,
      );
    }
  }
  console.log(
    "ok  the host's Content-Security-Policy refused nothing on either device — its page, its " +
      "engine's Worker and its service worker — and neither page threw",
  );
  for (const dev of both) await dev.close();
}

await runAs("web-sync-smoke", DEADLINE_MS, main);
