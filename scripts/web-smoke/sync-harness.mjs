// What the two sync runs are written in, over `harness.mjs`: the relay itself under workerd, a
// device — one browser on one profile, one page of the app — and the claim and the pairing as a
// reader makes them.
//
//     scripts/web-sync-smoke.mjs   the walk a pull request is held to
//     scripts/web-sync-pull.mjs    what one large `pull` costs a browser, measured
//
// **A module, and never a script**, for `harness.mjs`'s reason: nothing here runs on import, and
// neither run asks whether it is the script Node started. It was the top half of
// `web-sync-smoke.mjs` until the measurement needed the same relay and the same pairing; that
// file's header has what each choice here is for — the relay's real name, the self-signed
// certificate, the entitlement without Patreon, where wrangler is looked for.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALERT,
  CARDS_FILE,
  atExit,
  browse,
  buttonSaying,
  discard,
  fail,
  fixtures,
  openPage,
  pause,
  undo,
} from "./harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The claim code the local D1 is seeded with, as a reader would type it. */
const CLAIM_CODE = "TEST-CARD-SYNC";
/** A second membership's, for a group a device founds for itself — the walk's second device
 *  founds one and leaves it. Seeded beside the first; a run that never types it never meets it. */
export const OWN_CLAIM_CODE = "SECD-CARD-SYNC";

// ---------------------------------------------------------------------------------------------
// The relay, under workerd
// ---------------------------------------------------------------------------------------------

/** The engine's own relay address, read from the Rust. */
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

/** The relay as a page reaches it: the engine's own address, its host, and where its socket is
 *  by the rule `platform::socket::ws_origin` applies. `port` is the local relay's, once it is up. */
export function relayAddress() {
  const base = relayBase();
  // `RELAY_BASE` is an origin — a scheme and a host, no path — which `relayBase` holds it to.
  return {
    base,
    host: base.slice("https://".length),
    socket: base.replace(/^https:\/\//, "wss://"),
    port: null,
  };
}

/** `wrangler.js`, or a sentence saying how to provide one. */
function wranglerScript() {
  const beside = join(ROOT, "infrastructure/app-worker/node_modules/wrangler/bin/wrangler.js");
  if (existsSync(beside)) return beside;
  const named = process.env.WRANGLER;
  if (named && existsSync(named)) return named;
  return fail(
    "no wrangler to run the relay with. Install app-worker's own " +
      "(`npm ci --ignore-scripts --prefix infrastructure/app-worker`), " +
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
 * the port it listens on, its request log — each answer with the time wrangler says it took —
 * wrangler's own process id, which workerd is a child of, and the port its DevTools inspector
 * listens on.
 *
 * **The state directory is under `infrastructure/relay/.wrangler/` and is named relatively.** wrangler 4.146 on
 * Windows turns an absolute `--persist-to` into `./C:\…` and its D1 then answers "internal
 * error" (measured 2026-10-04); a relative path works on every host. `.wrangler/` is ignored by
 * git everywhere, and the directory is removed when the run ends.
 */
export async function startRelay(pageOrigin) {
  const script = wranglerScript();
  const config = "infrastructure/relay/wrangler.jsonc";
  const persist = `infrastructure/relay/.wrangler/sync-smoke-${process.pid}`;
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" };
  // What wrangler keeps beside the Worker while it runs: the bundle it built, in `tmp/`. A
  // wrangler told to stop removes its own; one stopped as Windows stops a process tree does
  // not, so whatever is there afterwards that was not there before is this run's, and goes.
  const scratch = join(ROOT, "infrastructure/relay/.wrangler/tmp");
  const before = new Set(existsSync(scratch) ? readdirSync(scratch) : []);
  const mine = () => [
    join(ROOT, persist),
    ...(existsSync(scratch) ? readdirSync(scratch) : [])
      .filter((entry) => !before.has(entry))
      .map((entry) => join(scratch, entry)),
  ];
  undo.push(async () => {
    // Each on its own, and none of them the run's verdict: one that will not go is named.
    for (const path of mine()) await discard(path);
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
  d1("--file", "infrastructure/relay/schema.sql");
  const now = Date.now();
  // Two memberships, a claim code each: the group a run syncs through, and one a device can
  // found for itself.
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

  /** Every request the relay answered, in order: `{ method, path, status, at, ms }`. */
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
      const request = /\[wrangler:info\] ([A-Z]+) (\S+) (\d{3}) (?:.*\((\d+)ms\))?/.exec(line);
      if (request) {
        log.push({
          method: request[1],
          path: request[2],
          status: Number(request[3]),
          at: Date.now(),
          // What wrangler prints after the status, when it prints it: the answer's own time.
          ms: request[4] === undefined ? null : Number(request[4]),
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
  return { port, log, said, pid: child.pid, inspector };
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
 *
 * `own` is what one run wants of one device: `cards`, a card file that is not the committed six;
 * `gate`, what this device's requests to the relay wait on (`harness.mjs`'s `intercept`) — the
 * measurement's; and `holdCards`, the card file kept on its way from the first ask until
 * `releaseCards` — the walk's, for the device it relaunches into a first ingest.
 */
export async function device(name, face, origin, relay, chunk, own = {}) {
  const [width, height] = face === "desktop" ? [1280, 800] : [412, 915];
  const { browser, hosts, policy, close, problems, pid } = await browse(
    origin,
    fixtures(own.cards),
    {
      args: [
        // The relay's name is the local relay; every other name still resolves to nothing.
        `--host-resolver-rules=MAP ${relay.host} 127.0.0.1:${relay.port}, MAP * ~NOTFOUND, EXCLUDE localhost`,
        // wrangler's certificate is self-signed, and for another name.
        "--ignore-certificate-errors",
      ],
      through: (url) => url.startsWith(`${relay.base}/`),
      gate: own.gate,
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
    relaunch,
    releaseCards,
    lastSocketClosed,
    pid,
  };
}

/** A relay path with its group and its rendezvous taken out, so one route reads as one. */
export const shape = (path) =>
  path
    .replace(/\/g\/[^/]+/, "/g/{group}")
    .replace(/\/p\/[0-9a-f]+/, "/p/{rv}")
    .replace(/\?.*/, "");

/** Keep, on the page, every `sync:live` and `sync:applied` it is told from now on. */
export const listenToSync = (chunk) => `import(${JSON.stringify(chunk)}).then(({ webCore }) => {
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
export async function seen(dev, what, expression, more = async () => "", withinMs = 60_000) {
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
// The claim and the pairing, as a reader makes them
// ---------------------------------------------------------------------------------------------

/**
 * Claim a seeded membership on `first`, through the page's own claim-code field, and wait for
 * its socket. Answers the group it founded and when it said `connecting` and `live`.
 *
 * `code` is the membership every run syncs through unless it says otherwise — the walk's second
 * device claims {@link OWN_CLAIM_CODE}, for a group of its own to leave.
 */
export async function claim(first, code = CLAIM_CODE) {
  await first.openSync();
  await first.page.press(
    `${first.name}: the claim-code field`,
    `document.querySelector("#patreon-claim")`,
  );
  await first.page.type(code);
  const said = (await first.told()).live.length;
  const claimed = Date.now();
  await first.page.press(`${first.name}: the claim's Connect`, buttonSaying("Connect"));
  await first.page.until(
    `${first.name}: the panel said the membership is connected`,
    `/Supporting/.test(document.body.innerText)`,
    30_000,
  );
  const founded = await first.engineUntil(
    "the claim founded a group",
    "sync_pairing_status",
    (s) => s.groupId !== null,
  );
  await first.engineUntil("its socket came up", "sync_live_state", (s) => s === "live");
  // What it has said since the press: a device that claims twice in one run has said more.
  const live = (await first.told()).live.slice(said);
  const dialled = live.find((event) => event.state === "connecting");
  const up = live.find((event) => event.state === "live");
  if (!dialled || !up)
    fail(`${first.name} never said connecting and live: ${JSON.stringify(live)}`);
  return { founded, claimed, dialled, up };
}

/**
 * Pair `second` into `first`'s group: the offer, the typed code, the same six digits on both,
 * *Codes match* — and both reading a group of two, both live. Answers the code, the digits, when
 * *Codes match* was pressed, and when the joining device said `connecting` and `live`.
 */
export async function pair(first, second) {
  // What the joining device has said before this: one that founded a group and left it has
  // already said `connecting` and `live` once, and those are not this pairing's.
  const saidBefore = (await second.told()).live.length;
  await first.openSync();
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
  const matched = Date.now();
  await first.page.press("Codes match", buttonSaying("Codes match"));
  for (const dev of [first, second]) {
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
  const secondLive = (await second.told()).live.slice(saidBefore);
  const joined = secondLive.find((event) => event.state === "connecting");
  const joinedUp = secondLive.find((event) => event.state === "live");
  return { code, offering, matched, joined, joinedUp };
}

/** The middle of a list of numbers. */
export const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;
