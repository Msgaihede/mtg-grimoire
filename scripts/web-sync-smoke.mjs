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
//
// **The relay, the devices, the claim and the pairing are `web-smoke/sync-harness.mjs`'s**, so
// that `web-sync-pull.mjs` — the measurement of one large `pull` — means the same things by them.

import { ALERT, buttonSaying, coreChunk, fail, pause, runAs, serve } from "./web-smoke/harness.mjs";
import {
  claim,
  device,
  listenToSync,
  median,
  pair,
  relayAddress,
  seen,
  shape,
  startRelay,
} from "./web-smoke/sync-harness.mjs";

/** Also profile the engine's Worker for a minute, idle, unpaired and then paired. */
const MEASURE = process.argv.includes("--measure");
/** How long the whole walk may take; the idle minutes are on top when they are asked for. */
const DEADLINE_MS = MEASURE ? 420_000 : 240_000;
/** How long one idle profile runs. */
const IDLE_MS = 60_000;

/** The two fixture cards the walk wishes for, one in each direction. */
const FIRST_WISH = "Rhystic Study";
const SECOND_WISH = "Lightning Bolt";

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
// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

async function main() {
  const relayAt = relayAddress();
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
  const { founded, claimed, dialled, up } = await claim(first);
  console.log(
    `ok  ${first.name} claimed with the code a reader types, founded a group of one ` +
      `(${founded.deviceName}), and its socket is live — ${dialled.at - claimed} ms from the ` +
      `press to connecting (the loop's five-second read), ${up.at - dialled.at} ms from ` +
      "connecting to live (a round trip, then the upgrade)",
  );

  // ---- the pairing -----------------------------------------------------------------------
  const { code, offering, joined, joinedUp } = await pair(first, second);
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
