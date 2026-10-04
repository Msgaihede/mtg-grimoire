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
//   1. both devices get past their first run on the fixture corpus, and each reads `off`
//   2. the first device claims a membership through the page's own claim-code field — the engine,
//      `/claim`, `/token` and the bearer gate all for real — and its socket comes up: `live`
//   3. it offers a pairing; the second device types the code; both show the same six digits;
//      the first confirms; both read a group of two, and both are `live`
//   4. **the doorbell**: the second device adds a card to its wishlist, and the first one's
//      wishlist page draws it with nothing pressed there — the write, the 3 s debounce, the
//      push, the relay's `head` frame, the trip it rings for, `sync:applied`, the refetch
//   5. the same the other way round, so each face has been both the writer and the one told
//   6. no request failed and nothing was logged; each socket's upgrade selected
//      `grimoire.live.v1`, and each `ping` it sent was answered `pong`
//   7. the first device removes the second from the roster, and the second — which the relay
//      tells nothing — reads as in no group after its next round trip
//   8. the host's Content-Security-Policy refused nothing, on any target of either browser
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
  atExit,
  browse,
  buttonSaying,
  coreChunk,
  fail,
  fixtures,
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

/** The two fixture cards the walk wishes for, one in each direction. */
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
  d1(
    "--command",
    "INSERT INTO entitlements (subject, source, external_id, status, created_at, checked_at) " +
      `VALUES ('smoke-subject', 'patreon', 'smoke-patron', 'active', ${now}, ${now}); ` +
      "INSERT INTO claim_codes (code, subject, expires_at) " +
      `VALUES ('${CLAIM_CODE.replaceAll("-", "")}', 'smoke-subject', ${now + 10 * 60 * 1000});`,
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
async function device(name, face, origin, relay, chunk) {
  const [width, height] = face === "desktop" ? [1280, 800] : [412, 915];
  const { browser, hosts, policy, close, problems } = await browse(origin, fixtures(), {
    args: [
      // The relay's name is the local relay; every other name still resolves to nothing.
      `--host-resolver-rules=MAP ${relay.host} 127.0.0.1:${relay.port}, MAP * ~NOTFOUND, EXCLUDE localhost`,
      // wrangler's certificate is self-signed, and for another name.
      "--ignore-certificate-errors",
    ],
    through: (url) => url.startsWith(`${relay.base}/`),
    socket: (url) => url.startsWith(`${relay.socket}/`),
  });
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
  /** Search for `card`, open it, and press its *Add to wishlist*. Answers when the press landed. */
  const wish = async (card) => {
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
  const first = await device("the desktop face", "desktop", origin, relayAt, chunk);
  const second = await device("the phone face", "phone", origin, relayAt, chunk);
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
      "the first run's card sync finished",
      "sync_status",
      (s) => s.cardCount === 6 && !s.syncing,
    );
    const live = await dev.engine("sync_live_state");
    if (live !== "off") fail(`${dev.name} is in no group and reads ${live}`);
    dev.label = `${dev.name} (${size})`;
  }
  if (relay.log.length > 0 || both.some((dev) => dev.policy.sockets.length > 0)) {
    fail(`before anything was paired the relay was asked: ${JSON.stringify(relay.log)}`);
  }
  console.log(
    `ok  two devices on two profiles — ${first.label} and ${second.label} — each with 6 cards, ` +
      "each reading off, and the relay asked nothing",
  );

  if (MEASURE) {
    const cost = await busy(first, IDLE_MS);
    console.log(
      `ok  idle and in no group, the engine's Worker was ${costLine(cost)} — the loop's five-second read of sync_group among it`,
    );
  }

  // ---- the claim -------------------------------------------------------------------------
  await first.openSync();
  await first.page.press("the claim-code field", `document.querySelector("#patreon-claim")`);
  await first.page.type(CLAIM_CODE);
  const claimed = Date.now();
  await first.page.press("the claim's Connect", buttonSaying("Connect"));
  await first.page.until(
    "the panel said the membership is connected",
    `/Supporting/.test(document.body.innerText)`,
    30_000,
  );
  const founded = await first.engineUntil(
    "the claim founded a group",
    "sync_pairing_status",
    (s) => s.groupId !== null,
  );
  await first.engineUntil(
    "the first device's socket came up",
    "sync_live_state",
    (s) => s === "live",
  );
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
  const secondLive = (await second.told()).live;
  const joined = secondLive.find((event) => event.state === "connecting");
  const joinedUp = secondLive.find((event) => event.state === "live");
  console.log(
    `ok  paired — a ${code.length}-character code typed into ${second.name}, ${offering} on both, ` +
      `Codes match on ${first.name}; both read a group of 2 devices and both are live ` +
      `(${second.name}: ${joinedUp.at - joined.at} ms from connecting to live)`,
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

  // ---- the doorbell, phone to desktop ----------------------------------------------------
  const doorbell = async (writer, reader, card) => {
    await reader.go("wishlist");
    await seen(
      reader,
      "its wishlist page drew",
      `location.pathname === "/wishlist" && !${reader.draws(card)}`,
    );
    const mark = (await reader.told()).applied.length;
    const from = relay.log.length;
    const pressed = await writer.wish(card);
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
  await doorbell(second, first, FIRST_WISH);
  await doorbell(first, second, SECOND_WISH);

  // ---- what the walk so far asked, and how it went ----------------------------------------
  // Read before the removal: a removed device's requests are refused on purpose, after it.
  const asked = [...relay.log];
  const preflights = asked.filter((entry) => entry.method === "OPTIONS");
  const requests = asked.filter((entry) => entry.method !== "OPTIONS");
  const refusals = requests.filter(
    // The rendezvous poll's 404 is the relay's "not yet", which the engine waits through.
    (entry) => entry.status >= 400 && !(entry.status === 404 && /^\/p\//.test(entry.path)),
  );
  if (refusals.length > 0) {
    fail(
      `the relay refused: ${refusals.map((entry) => `${entry.method} ${shape(entry.path)} ${entry.status}`).join(", ")}`,
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
      [...byRoute].map(([route, count]) => `${route} × ${count}`).join(", "),
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
  // **The relay tells a removed device nothing.** A rotation's roster marks it departed in the
  // group's object and closes no socket — 4001 is for a group that is gone, not a device — so
  // the device learns at its next round trip, when `/keys` answers a manifest that no longer
  // names it. Left alone, with nobody writing, it goes on reading a group of two; what a reader
  // there presses is Sync now, so that is what is pressed.
  await pause(2_000);
  const still = await second.engine("sync_pairing_status");
  if (still.groupId === null)
    fail("the removed device read as in no group before it asked the relay anything");
  await second.go("settings");
  await second.openSync();
  await second.page.press("the removed device's Sync now", buttonSaying("Sync now"));
  const gone = await second.engineUntil(
    "the removed device read as in no group",
    "sync_pairing_status",
    (s) => s.groupId === null,
  );
  await second.page.until(
    "the removed device's panel reads not paired",
    `/not paired yet/.test(document.body.innerText)`,
    30_000,
  );
  // Reported, not asserted: the loop asks whether this device is in a group between sockets
  // and never while it holds one, so a device removed under a live socket keeps it.
  await pause(6_000);
  const stillLive = await second.engine("sync_live_state");
  const after = relay.log.slice(asked.length).filter((entry) => entry.method !== "OPTIONS");
  console.log(
    `ok  ${first.name} removed ${gone.deviceName} from the roster (${rotated - removed} ms); ` +
      `${second.name} was told nothing, pressed Sync now, and read as in no group — its panel ` +
      `says not paired yet, and its loop reads ${stillLive} six seconds on. The relay's answers: ` +
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
